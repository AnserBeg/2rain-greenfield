import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { canonicalize } from '@north-star/canonical-model';
import {
  HASH_DOMAINS,
  PROJECTION_FAMILY_IDS,
  STORAGE_RENDERER_POLICY_VERSION,
  STORAGE_TARGET_PAYLOAD_VERSION,
  STORAGE_TRANSITION_ENVELOPE_VERSION,
  type StorageRendererStatement,
  type StorageTargetPayloadV1,
  type StorageTransitionElement,
  type StorageTransitionEnvelope,
  validateStorageRendererStatements,
} from '@north-star/compiler';
import {
  MODULE_STORAGE_CATALOG_RECEIPT_VERSION,
  MODULE_STORAGE_MIGRATION_LOCK,
  MODULE_STORAGE_RENDERED_DIFF_VERSION,
  type ModuleDataState,
  type ModuleStorageCatalogReceipt,
  type RenderedModuleTransitionDiff,
  digestModuleTransitionElements,
} from '@north-star/platform-runtime';
import type { TrustedRequestContext } from '@north-star/runtime';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

const sha256Pattern = /^[0-9a-f]{64}$/;
const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/;
const allowedTypes = [
  /^boolean$/,
  /^date$/,
  /^numeric$/,
  /^numeric\([1-9][0-9]*,[0-9]+\)$/,
  /^text$/,
  /^time\([03]\) without time zone$/,
  /^timestamp\([03]\) with time zone$/,
  /^uuid$/,
  /^varchar\([1-9][0-9]*\)$/,
];

export class ModuleStorageMaterializationError extends Error {
  override readonly name = 'ModuleStorageMaterializationError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PrepareModuleStorageTransitionCommand {
  readonly context: TrustedRequestContext;
  readonly expiresAt: string;
  readonly generationId: string;
  readonly initiatedBy: string;
  readonly preparationId: string;
  readonly targetReleaseId: string;
}

export interface PreparedModuleStorageTransition {
  readonly dataState: ModuleDataState;
  readonly diff: RenderedModuleTransitionDiff;
  readonly generationId: string;
  readonly generationNumber: number;
  readonly preparedSubsetDigest: Uint8Array;
  readonly receipt: ModuleStorageCatalogReceipt;
  readonly remainingPlanDigest: Uint8Array;
  readonly schemaState: 'APPLIED';
  readonly sourceManifestRoot: Uint8Array;
  readonly sourceReleaseId: string;
  readonly targetManifestRoot: Uint8Array;
  readonly targetReleaseId: string;
  readonly transitionPlanDigest: Uint8Array;
}

export interface ExecuteModuleStorageAttemptCommand {
  readonly activationAttemptId: string;
  readonly context: TrustedRequestContext;
  readonly coordinatorId: string;
  readonly generationId: string;
}

export interface ModuleStorageAttemptResult {
  readonly disposition: 'READY_TO_SWAP' | 'RECONCILING';
  readonly receipt: ModuleStorageCatalogReceipt | null;
}

interface ArtifactRow {
  artifact_kind: string;
  canonical_bytes: Uint8Array;
  content_hash: string;
  domain_tag: string;
}

interface VerifiedReleaseStorage {
  manifestRoot: string;
  storageTargetArtifactRoot: string;
  storageTargetSemanticDigest: string;
  target: StorageTargetPayloadV1;
  transition: StorageTransitionEnvelope | null;
  transitionArtifactRoot: string | null;
  transitionSemanticDigest: string | null;
}

interface GenerationRow {
  environment_id: string;
  generation_id: string;
  generation_number: string | number;
  prepared_subset_digest: Uint8Array;
  remaining_plan_digest: Uint8Array;
  source_manifest_root: Uint8Array;
  source_release_id: string;
  target_manifest_root: Uint8Array;
  target_release_id: string;
  tenant_id: string;
}

interface CatalogVerification {
  digest: Uint8Array;
  drift: readonly string[];
}

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

/**
 * The sole compiled-DDL authority. The first pool must authenticate directly
 * as north_star_module_materializer; it is intentionally unrelated to every
 * runtime/query/operation pool. The optional second pool authenticates as the
 * DML-only north_star_module_runtime for in-attempt backfills.
 */
export class PostgresModuleStorageMaterializer {
  constructor(
    private readonly materializerPool: Pool,
    private readonly moduleRuntimePool?: Pool,
  ) {}

  async prepare(
    command: PrepareModuleStorageTransitionCommand,
  ): Promise<PreparedModuleStorageTransition> {
    validateCommandIdentity(command.context, command.initiatedBy);
    assertUuid(command.generationId, 'generationId');
    assertUuid(command.preparationId, 'preparationId');
    assertUuid(command.targetReleaseId, 'targetReleaseId');
    const expiresAt = new Date(command.expiresAt);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now()
    ) {
      throw failure(
        'RETENTION_INVALID',
        'prepared candidate expiry must be in the future',
      );
    }

    const client = await this.materializerPool.connect();
    try {
      await assertMaterializerSession(client);
      await beginLocked(client);
      await setMaterializerScope(client, command.context);
      const authority = await loadPreparationAuthority(client, command);
      if (!authority.authorized || authority.denied || authority.paused) {
        throw failure(
          'PREPARATION_AUTHORITY_DENIED',
          'preparation requires current 0005 executor authority and non-denied control',
        );
      }
      const pointer = await requiredOne<{
        fence: string | number;
        release_id: string | null;
      }>(
        client,
        `SELECT fence, release_id
           FROM platform.active_release_pointers
         WHERE tenant_id = $1 AND environment_id = $2
        `,
        [command.context.tenantId, command.context.environmentId],
        'active release pointer',
      );
      if (!pointer.release_id) {
        throw failure(
          'INITIAL_ACTIVATION_UNSUPPORTED',
          'P2b materializes compiled transitions between two persisted roots only',
        );
      }

      const [source, target] = await Promise.all([
        loadVerifiedReleaseStorage(
          client,
          command.context.tenantId,
          command.context.environmentId,
          pointer.release_id,
        ),
        loadVerifiedReleaseStorage(
          client,
          command.context.tenantId,
          command.context.environmentId,
          command.targetReleaseId,
        ),
      ]);
      const transition = requiredTransition(source, target);
      assertTransitionPair(transition, source, target);
      assertBackfillAdmissibility(target.target, transition);
      assertNonDestructiveStorageStatements(
        transition.elements.map((element) => rendererStatement(element)),
      );

      const prepared = transition.elements.filter(
        (element) =>
          element.classification.preparationValidity === 'preApprovalInert',
      );
      const remaining = transition.elements.filter(
        (element) =>
          element.classification.preparationValidity !== 'preApprovalInert',
      );
      const rendered = renderDiff(transition.elements, 'preparation');
      const preparedSubsetDigest = digestModuleTransitionElements(
        rendered.elements.filter(
          (element) => element.disposition === 'APPLIED',
        ),
      );
      const remainingPlanDigest = digestModuleTransitionElements(
        rendered.elements.filter(
          (element) => element.disposition !== 'APPLIED',
        ),
      );
      const transitionPlanDigest = hexDigest(target.transitionSemanticDigest);
      const generationNumber = await nextGenerationNumber(
        client,
        command.context,
      );

      await client.query(
        `INSERT INTO north_star_internal.module_storage_generations (
           tenant_id, environment_id, generation_id, generation_number,
           source_release_id, source_manifest_root, target_release_id,
           target_manifest_root, preparation_id, prepared_subset_digest,
           remaining_plan_digest, transition_plan_digest, transition_artifact_root,
           target_artifact_root, state, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PREPARING',$15)`,
        [
          command.context.tenantId,
          command.context.environmentId,
          command.generationId,
          generationNumber,
          pointer.release_id,
          Buffer.from(source.manifestRoot, 'hex'),
          command.targetReleaseId,
          Buffer.from(target.manifestRoot, 'hex'),
          command.preparationId,
          Buffer.from(preparedSubsetDigest),
          Buffer.from(remainingPlanDigest),
          Buffer.from(transitionPlanDigest),
          target.transitionArtifactRoot,
          target.storageTargetArtifactRoot,
          command.expiresAt,
        ],
      );

      for (const element of transition.elements) {
        await registerElement(client, command, element);
      }
      for (const element of prepared) {
        await applyDdlElement(client, target.target, element);
        await appendApplication(client, command, element, 'APPLIED', null);
      }
      await persistRootMembership(
        client,
        command,
        pointer.release_id,
        target,
        transition,
      );
      const verification = await verifyCatalogOnClient(
        client,
        await loadAccountedLiveTargets(client, command.context, [
          source.target,
          target.target,
        ]),
      );
      if (verification.drift.length > 0) {
        throw failure(
          'CATALOG_DRIFT',
          `managed catalog is not attributable: ${verification.drift.join('; ')}`,
        );
      }
      const receipt = await appendCatalogReceipt(
        client,
        command.context,
        command.generationId,
        pointer.release_id,
        source.manifestRoot,
        command.targetReleaseId,
        target.manifestRoot,
        preparedSubsetDigest,
        remainingPlanDigest,
        verification.digest,
        'PREPARED',
      );
      await client.query(
        `UPDATE north_star_internal.module_storage_generations
            SET state = 'PREPARED'
          WHERE generation_id = $1 AND state = 'PREPARING'`,
        [command.generationId],
      );
      await client.query('COMMIT');
      return Object.freeze({
        dataState: remaining.some(
          (element) =>
            element.classification.preparationValidity === 'inAttemptOnly',
        )
          ? 'PENDING_IN_ATTEMPT'
          : 'NOT_REQUIRED',
        diff: rendered,
        generationId: command.generationId,
        generationNumber,
        preparedSubsetDigest,
        receipt,
        remainingPlanDigest,
        schemaState: 'APPLIED',
        sourceManifestRoot: Buffer.from(source.manifestRoot, 'hex'),
        sourceReleaseId: pointer.release_id,
        targetManifestRoot: Buffer.from(target.manifestRoot, 'hex'),
        targetReleaseId: command.targetReleaseId,
        transitionPlanDigest,
      });
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async executeApprovedAttempt(
    command: ExecuteModuleStorageAttemptCommand,
  ): Promise<ModuleStorageAttemptResult> {
    assertUuid(command.activationAttemptId, 'activationAttemptId');
    assertUuid(command.coordinatorId, 'coordinatorId');
    assertUuid(command.generationId, 'generationId');
    const client = await this.materializerPool.connect();
    try {
      await assertMaterializerSession(client);
      await beginLocked(client);
      await setMaterializerScope(client, command.context);
      const generation = await loadGeneration(client, command);
      const claim = await client.query<{ coordinator_id: string }>(
        `INSERT INTO north_star_internal.module_storage_attempt_claims (
           tenant_id, environment_id, generation_id, activation_attempt_id,
           coordinator_id, claim_state
         )
         SELECT $1,$2,$3,$4,$5,'CLAIMED'
          WHERE EXISTS (
            SELECT 1
              FROM platform.release_activation_attempts AS attempt
              JOIN platform.release_approvals AS approval
                ON approval.tenant_id = attempt.tenant_id
               AND approval.environment_id = attempt.environment_id
               AND approval.approval_id = attempt.approval_id
             WHERE attempt.tenant_id = $1 AND attempt.environment_id = $2
               AND attempt.activation_attempt_id = $4
               AND approval.compatibility_policy_version =
                 'northstar.transition-compatibility-policy/v2'
               AND approval.preparation_id = (
                 SELECT preparation_id
                   FROM north_star_internal.module_storage_generations
                  WHERE generation_id = $3
               )
          )
         ON CONFLICT (tenant_id, environment_id, activation_attempt_id)
         DO NOTHING
         RETURNING coordinator_id`,
        [
          command.context.tenantId,
          command.context.environmentId,
          command.generationId,
          command.activationAttemptId,
          command.coordinatorId,
        ],
      );
      if (claim.rowCount !== 1) {
        throw failure(
          'ATTEMPT_NOT_UNIQUELY_CLAIMED',
          'backfill/validation may run only in the uniquely claimed approved attempt',
        );
      }
      const [source, target] = await Promise.all([
        loadVerifiedReleaseStorage(
          client,
          command.context.tenantId,
          command.context.environmentId,
          generation.source_release_id,
        ),
        loadVerifiedReleaseStorage(
          client,
          command.context.tenantId,
          command.context.environmentId,
          generation.target_release_id,
        ),
      ]);
      const transition = requiredTransition(source, target);
      assertTransitionPair(transition, source, target);
      await client.query(
        `UPDATE north_star_internal.module_storage_generations
            SET state = 'IN_ATTEMPT' WHERE generation_id = $1`,
        [command.generationId],
      );
      for (const element of transition.elements.filter(
        (candidate) =>
          candidate.classification.preparationValidity === 'inAttemptOnly',
      )) {
        if (element.kind === 'backfill') {
          await client.query('COMMIT');
          await this.applyBackfill(command, target.target, element);
          await client.query('BEGIN');
          await acquireSharedMigrationLock(client);
        } else {
          await applyDdlElement(client, target.target, element);
        }
        await appendApplication(
          client,
          command,
          element,
          'APPLIED',
          command.activationAttemptId,
        );
      }
      const verification = await verifyCatalogOnClient(
        client,
        await loadAccountedLiveTargets(client, command.context, [
          source.target,
          target.target,
        ]),
      );
      if (verification.drift.length > 0) {
        throw failure('CATALOG_DRIFT', verification.drift.join('; '));
      }
      const receipt = await appendCatalogReceipt(
        client,
        command.context,
        command.generationId,
        generation.source_release_id,
        Buffer.from(generation.source_manifest_root).toString('hex'),
        generation.target_release_id,
        Buffer.from(generation.target_manifest_root).toString('hex'),
        new Uint8Array(generation.prepared_subset_digest),
        new Uint8Array(generation.remaining_plan_digest),
        verification.digest,
        'READY_TO_SWAP',
      );
      await client.query(
        `UPDATE north_star_internal.module_storage_attempt_claims
            SET claim_state = 'COMPLETED', updated_at = transaction_timestamp()
          WHERE activation_attempt_id = $1 AND coordinator_id = $2`,
        [command.activationAttemptId, command.coordinatorId],
      );
      await client.query(
        `UPDATE north_star_internal.module_storage_generations
            SET state = 'READY_TO_SWAP' WHERE generation_id = $1`,
        [command.generationId],
      );
      await client.query('COMMIT');
      return { disposition: 'READY_TO_SWAP', receipt };
    } catch (error) {
      await rollbackQuietly(client);
      if (isAmbiguousDatabaseError(error)) {
        await recordReconciling(this.materializerPool, command);
        return { disposition: 'RECONCILING', receipt: null };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyLiveCatalog(
    context: TrustedRequestContext,
  ): Promise<CatalogVerification> {
    const client = await this.materializerPool.connect();
    try {
      await assertMaterializerSession(client);
      await client.query('BEGIN');
      await setMaterializerScope(client, context);
      const roots = await loadLiveRoots(client, context);
      const targets = await Promise.all(
        roots.map(
          async (releaseId) =>
            (
              await loadVerifiedReleaseStorage(
                client,
                context.tenantId,
                context.environmentId,
                releaseId,
              )
            ).target,
        ),
      );
      const result = await verifyCatalogOnClient(
        client,
        await loadAccountedLiveTargets(client, context, targets),
      );
      if (result.drift.length > 0) {
        throw failure('CATALOG_DRIFT', result.drift.join('; '));
      }
      await reconcileReferenceCounts(client, context, roots);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async applyBackfill(
    command: ExecuteModuleStorageAttemptCommand,
    target: StorageTargetPayloadV1,
    element: StorageTransitionElement,
  ): Promise<void> {
    if (!this.moduleRuntimePool) {
      throw failure(
        'MODULE_RUNTIME_POOL_REQUIRED',
        'backfill requires the DML-only module runtime pool',
      );
    }
    const located = locateColumn(target, element);
    if (
      located.column.defaultSemantics !== 'declaredDefault' &&
      located.column.defaultSemantics !== 'coalesceAtRead'
    ) {
      throw failure(
        'BACKFILL_NOT_ADMISSIBLE',
        'v1 accepts only residual-row-correct declared-default/coalesce transitions',
      );
    }
    const client = await this.moduleRuntimePool.connect();
    try {
      const role = await client.query<{ current_user: string }>(
        'SELECT current_user',
      );
      if (role.rows[0]?.current_user !== 'north_star_module_runtime') {
        throw failure(
          'MODULE_RUNTIME_ROLE_INVALID',
          'backfill pool must authenticate as north_star_module_runtime',
        );
      }
      let complete = false;
      while (!complete) {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('north_star.tenant_id', $1, true),
                                   set_config('north_star.environment_id', $2, true)`,
          [command.context.tenantId, command.context.environmentId],
        );
        const checkpoint = await client.query<{
          last_record_id: string | null;
        }>(
          `SELECT last_record_id
             FROM north_star_internal.module_storage_backfill_checkpoints
            WHERE tenant_id = $1 AND environment_id = $2
              AND generation_id = $3 AND element_id = $4
            FOR UPDATE`,
          [
            command.context.tenantId,
            command.context.environmentId,
            command.generationId,
            element.elementId,
          ],
        );
        const last = checkpoint.rows[0]?.last_record_id ?? null;
        const updated = await client.query<{ record_id: string }>(
          `WITH batch AS (
             SELECT record_id
               FROM north_star_module.${quoted(located.entity.physicalTableName)}
              WHERE tenant_id = $1 AND environment_id = $2
                AND ${quoted(located.column.physicalName)} IS NULL
                AND ($3::uuid IS NULL OR record_id > $3)
              ORDER BY record_id LIMIT 100 FOR UPDATE
           )
           UPDATE north_star_module.${quoted(located.entity.physicalTableName)} AS target
              SET ${quoted(located.column.physicalName)} = $4
             FROM batch WHERE target.tenant_id = $1 AND target.environment_id = $2
               AND target.record_id = batch.record_id
           RETURNING target.record_id`,
          [
            command.context.tenantId,
            command.context.environmentId,
            last,
            databaseDefaultValue(located.column.defaultValue),
          ],
        );
        const updatedCount = updated.rowCount ?? 0;
        complete = updatedCount < 100;
        const next = updated.rows.at(-1)?.record_id ?? last;
        await client.query(
          `INSERT INTO north_star_internal.module_storage_backfill_checkpoints (
             tenant_id, environment_id, generation_id, element_id,
             activation_attempt_id, last_record_id, rows_applied, complete
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (tenant_id, environment_id, generation_id, element_id)
           DO UPDATE SET last_record_id = EXCLUDED.last_record_id,
             rows_applied = module_storage_backfill_checkpoints.rows_applied + EXCLUDED.rows_applied,
             complete = EXCLUDED.complete, updated_at = transaction_timestamp()`,
          [
            command.context.tenantId,
            command.context.environmentId,
            command.generationId,
            element.elementId,
            command.activationAttemptId,
            next,
            updatedCount,
            complete,
          ],
        );
        await client.query('COMMIT');
      }
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function assertNonDestructiveStorageStatements(
  statements: readonly StorageRendererStatement[],
): void {
  const diagnostics = validateStorageRendererStatements(statements);
  if (diagnostics.length > 0) {
    throw failure(
      'DESTRUCTIVE_STORAGE_DDL_REJECTED',
      `destructive storage operation rejected: ${diagnostics.map((item) => item.subjectId).join(', ')}`,
    );
  }
}

async function loadVerifiedReleaseStorage(
  client: PoolClient,
  tenantId: string,
  environmentId: string,
  releaseId: string,
): Promise<VerifiedReleaseStorage> {
  const release = await requiredOne<{ content_hash: string }>(
    client,
    `SELECT content_hash FROM platform.tenant_releases
      WHERE tenant_id = $1 AND environment_id = $2 AND release_id = $3`,
    [tenantId, environmentId, releaseId],
    'persisted release root',
  );
  const artifacts = await client.query<ArtifactRow>(
    `SELECT blob.artifact_kind, blob.canonical_bytes, blob.content_hash, blob.domain_tag
       FROM platform.tenant_release_artifact_links AS link
       JOIN platform.release_artifact_blobs AS blob
         ON blob.content_hash = link.content_hash
      WHERE link.tenant_id = $1 AND link.environment_id = $2 AND link.release_id = $3
      UNION ALL
     SELECT blob.artifact_kind, blob.canonical_bytes, blob.content_hash, blob.domain_tag
       FROM platform.tenant_releases AS release
       JOIN platform.release_artifact_blobs AS blob
         ON blob.content_hash = release.content_hash
      WHERE release.tenant_id = $1 AND release.environment_id = $2 AND release.release_id = $3`,
    [tenantId, environmentId, releaseId],
  );
  const byHash = new Map(artifacts.rows.map((row) => [row.content_hash, row]));
  for (const row of artifacts.rows) verifyArtifact(row);
  const manifestRow = byHash.get(release.content_hash);
  if (!manifestRow || manifestRow.artifact_kind !== 'releaseManifest') {
    throw failure(
      'RELEASE_MANIFEST_MISSING',
      'persisted release root is unavailable',
    );
  }
  const manifest = decodeCanonical(manifestRow.canonical_bytes) as {
    projections: Array<{
      artifactRoot: string;
      familyId: string;
      semanticDigest: string;
    }>;
  };
  const projection = (familyId: string) => {
    const reference = manifest.projections.find(
      (item) => item.familyId === familyId,
    );
    if (!reference) return null;
    const manifestArtifact = byHash.get(reference.artifactRoot);
    if (!manifestArtifact)
      throw failure('PROJECTION_MANIFEST_MISSING', familyId);
    const projectionManifest = decodeCanonical(
      manifestArtifact.canonical_bytes,
    ) as {
      chunks: Array<{ contentHash: string }>;
      semanticDigest: string;
    };
    if (
      projectionManifest.chunks.length !== 1 ||
      projectionManifest.semanticDigest !== reference.semanticDigest
    ) {
      throw failure('PROJECTION_LINK_MISMATCH', familyId);
    }
    const chunk = byHash.get(projectionManifest.chunks[0]!.contentHash);
    if (!chunk) throw failure('PROJECTION_CHUNK_MISSING', familyId);
    return {
      artifactRoot: reference.artifactRoot,
      payload: decodeCanonical(chunk.canonical_bytes),
      semanticDigest: reference.semanticDigest,
    };
  };
  const targetProjection = projection(PROJECTION_FAMILY_IDS.storageTarget);
  if (!targetProjection)
    throw failure('STORAGE_TARGET_MISSING', 'release lacks storage target');
  const target = targetProjection.payload as unknown as StorageTargetPayloadV1;
  if (
    target.kind !== 'storageTargetPayload' ||
    target.schemaVersion !== STORAGE_TARGET_PAYLOAD_VERSION ||
    target.rendererPolicyVersion !== STORAGE_RENDERER_POLICY_VERSION ||
    target.providerAbi.managedSchema !== 'north_star_module' ||
    target.providerAbi.materializerRole !== 'north_star_module_materializer' ||
    target.providerAbi.runtimeRole !== 'north_star_module_runtime' ||
    target.backfillInvariant.completenessLoadBearing !== false
  ) {
    throw failure(
      'STORAGE_TARGET_ABI_MISMATCH',
      'storage target does not bind the P2a provider ABI',
    );
  }
  const transitionProjection = projection(
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  const transition = transitionProjection?.payload as
    StorageTransitionEnvelope | undefined;
  if (
    transition &&
    (transition.kind !== 'storageTransitionEnvelope' ||
      transition.schemaVersion !== STORAGE_TRANSITION_ENVELOPE_VERSION)
  ) {
    throw failure(
      'STORAGE_TRANSITION_VERSION_MISMATCH',
      'unsupported transition envelope',
    );
  }
  return {
    manifestRoot: release.content_hash,
    storageTargetArtifactRoot: targetProjection.artifactRoot,
    storageTargetSemanticDigest: targetProjection.semanticDigest,
    target,
    transition: transition ?? null,
    transitionArtifactRoot: transitionProjection?.artifactRoot ?? null,
    transitionSemanticDigest: transitionProjection?.semanticDigest ?? null,
  };
}

function verifyArtifact(row: ArtifactRow): void {
  if (
    !sha256Pattern.test(row.content_hash) ||
    hash(row.domain_tag, row.canonical_bytes) !== row.content_hash
  ) {
    throw failure(
      'ARTIFACT_CONTENT_HASH_MISMATCH',
      'persisted artifact bytes failed content-hash verification',
    );
  }
  decodeCanonical(row.canonical_bytes);
}

function decodeCanonical(bytes: Uint8Array): Record<string, unknown> {
  try {
    const text = new TextDecoder().decode(bytes);
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      canonicalize(value) !== text
    ) {
      throw new Error('non-canonical');
    }
    return value as Record<string, unknown>;
  } catch {
    throw failure('ARTIFACT_NOT_CANONICAL', 'artifact is not canonical JSON');
  }
}

function requiredTransition(
  source: VerifiedReleaseStorage,
  target: VerifiedReleaseStorage,
): StorageTransitionEnvelope {
  if (
    !target.transition ||
    !target.transitionArtifactRoot ||
    !target.transitionSemanticDigest
  ) {
    throw failure(
      'TRANSITION_REQUIRED',
      'P2b requires the exact compiled storage transition projection',
    );
  }
  if (target.transition.elements.length === 0) {
    throw failure(
      'NO_STORAGE_TRANSITION',
      'v1 no-transition activation remains on the unchanged kernel path',
    );
  }
  return target.transition;
}

function assertTransitionPair(
  transition: StorageTransitionEnvelope,
  source: VerifiedReleaseStorage,
  target: VerifiedReleaseStorage,
): void {
  if (
    transition.fromReleaseRoot !== source.manifestRoot ||
    transition.fromStorageTargetArtifactRoot !==
      source.storageTargetArtifactRoot ||
    transition.fromStorageTargetSemanticDigest !==
      source.storageTargetSemanticDigest ||
    transition.toStorageTargetArtifactRoot !==
      target.storageTargetArtifactRoot ||
    transition.toStorageTargetSemanticDigest !==
      target.storageTargetSemanticDigest ||
    transition.totalOrdering !== 'declaredDependenciesThenElementIdCodeUnits'
  ) {
    throw failure(
      'TRANSITION_EXACT_PAIR_MISMATCH',
      'transition does not bind the exact persisted source/target pair',
    );
  }
}

function assertBackfillAdmissibility(
  target: StorageTargetPayloadV1,
  transition: StorageTransitionEnvelope,
): void {
  if (
    target.backfillInvariant.completenessLoadBearing !== false ||
    target.backfillInvariant.residualRowsRequire !==
      'declaredDefaultOrCoalesceAtRead'
  ) {
    throw failure(
      'BACKFILL_INVARIANT_MISMATCH',
      'backfill completeness may not be load-bearing',
    );
  }
  for (const element of transition.elements.filter(
    (item) => item.kind === 'backfill',
  )) {
    const { column } = locateColumn(target, element);
    if (
      column.defaultSemantics !== 'declaredDefault' &&
      column.defaultSemantics !== 'coalesceAtRead'
    ) {
      throw failure('BACKFILL_NOT_ADMISSIBLE', element.elementId);
    }
  }
}

async function applyDdlElement(
  client: PoolClient,
  target: StorageTargetPayloadV1,
  element: StorageTransitionElement,
): Promise<void> {
  switch (element.kind) {
    case 'createTable': {
      const entity = target.entities.find(
        (item) => item.physicalTableName === element.physicalObjectName,
      );
      if (!entity) throw failure('ELEMENT_TARGET_MISSING', element.elementId);
      await createManagedTable(client, target, entity);
      return;
    }
    case 'addColumn': {
      const { column, entity } = locateColumn(target, element);
      if (!column.nullable)
        throw failure('NON_INERT_ADD_COLUMN', element.elementId);
      await client.query(
        `ALTER TABLE north_star_module.${quoted(entity.physicalTableName)}
           ADD COLUMN IF NOT EXISTS ${quoted(column.physicalName)} ${safeType(column.postgresqlType)}`,
      );
      return;
    }
    case 'createIndex': {
      const located = locateIndex(target, element);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${quoted(located.index.physicalName)}
           ON north_star_module.${quoted(located.entity.physicalTableName)}
           (${located.index.columnNames.map(quoted).join(', ')})`,
      );
      return;
    }
    case 'addForeignKey': {
      const relation = target.relations.find(
        (item) => item.foreignKey.physicalName === element.physicalObjectName,
      );
      if (
        !relation ||
        relation.foreignKey.onDelete !== 'restrict' ||
        relation.foreignKey.onUpdate !== 'restrict'
      ) {
        throw failure('DESTRUCTIVE_FOREIGN_KEY_REJECTED', element.elementId);
      }
      const source = requiredEntity(target, relation.sourceEntityId);
      const targetEntity = requiredEntity(target, relation.targetEntityId);
      const exists = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_constraint AS constraint_record
           JOIN pg_class AS relation_record
             ON relation_record.oid = constraint_record.conrelid
           JOIN pg_namespace AS namespace_record
             ON namespace_record.oid = relation_record.relnamespace
          WHERE namespace_record.nspname = 'north_star_module'
            AND relation_record.relname = $1
            AND constraint_record.conname = $2
         ) AS present`,
        [source.physicalTableName, relation.foreignKey.physicalName],
      );
      if (exists.rows[0]?.present) return;
      await client.query(
        `ALTER TABLE north_star_module.${quoted(source.physicalTableName)}
           ADD CONSTRAINT ${quoted(relation.foreignKey.physicalName)}
           FOREIGN KEY (${relation.foreignKey.sourceColumns.map(quoted).join(', ')})
           REFERENCES north_star_module.${quoted(targetEntity.physicalTableName)}
           (${relation.foreignKey.targetColumns.map(quoted).join(', ')})
           ON DELETE RESTRICT ON UPDATE RESTRICT`,
      );
      return;
    }
    case 'backfill':
      throw failure('BACKFILL_REQUIRES_DML_ROLE', element.elementId);
    case 'addNotValidConstraint':
    case 'duplicateScan':
    case 'tightenNotNull':
    case 'validateConstraint':
      return;
  }
}

async function createManagedTable(
  client: PoolClient,
  target: StorageTargetPayloadV1,
  entity: StorageEntityTarget,
): Promise<void> {
  const relationColumns = target.relations
    .filter((relation) => relation.sourceEntityId === entity.entityId)
    .map((relation) => relation.relationColumn);
  const columns = [
    'tenant_id uuid NOT NULL',
    'environment_id uuid NOT NULL',
    `${quoted(entity.recordIdentity.column)} uuid NOT NULL`,
    `${quoted(entity.optimisticRevision.column)} bigint NOT NULL DEFAULT 1`,
    `${quoted(entity.archive.archivedAtColumn)} timestamp with time zone`,
    ...entity.columns.map(
      (column) =>
        `${quoted(column.physicalName)} ${safeType(column.postgresqlType)}${column.nullable ? '' : ' NOT NULL'}${defaultSql(column.defaultSemantics, column.defaultValue)}`,
    ),
    ...relationColumns.map(
      (column) =>
        `${quoted(column.physicalName)} ${safeType(column.postgresqlType)}${column.nullable ? '' : ' NOT NULL'}`,
    ),
    ...entity.derivedStateFields.map(
      (column) => `${quoted(column.physicalName)} text`,
    ),
  ];
  await client.query(
    `CREATE TABLE IF NOT EXISTS north_star_module.${quoted(entity.physicalTableName)} (
       ${columns.join(',\n')},
       CONSTRAINT ${quoted(entity.primaryKey.physicalName)} PRIMARY KEY
         (${entity.primaryKey.columns.map(quoted).join(', ')})
     )`,
  );
  for (const unique of entity.uniqueKeys) {
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoted(unique.physicalName)}
         ON north_star_module.${quoted(entity.physicalTableName)}
         (${unique.columns.map(quoted).join(', ')})`,
    );
  }
  await client.query(
    `ALTER TABLE north_star_module.${quoted(entity.physicalTableName)} ENABLE ROW LEVEL SECURITY`,
  );
  await client.query(
    `ALTER TABLE north_star_module.${quoted(entity.physicalTableName)} FORCE ROW LEVEL SECURITY`,
  );
  const predicate = `tenant_id = north_star_internal.trusted_tenant_id()
    AND environment_id = north_star_internal.trusted_environment_id()`;
  for (const command of ['SELECT', 'INSERT', 'UPDATE'] as const) {
    const policy = `nsm_p_${createHash('sha256')
      .update(entity.physicalTableName)
      .update('\0')
      .update(command)
      .digest('hex')
      .slice(0, 32)}`;
    const exists = await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname = 'north_star_module' AND tablename = $1 AND policyname = $2) AS present`,
      [entity.physicalTableName, policy],
    );
    if (!exists.rows[0]?.present) {
      const clause =
        command === 'SELECT'
          ? `USING (${predicate})`
          : command === 'INSERT'
            ? `WITH CHECK (${predicate})`
            : `USING (${predicate}) WITH CHECK (${predicate})`;
      await client.query(
        `CREATE POLICY ${quoted(policy)} ON north_star_module.${quoted(entity.physicalTableName)}
           FOR ${command} TO north_star_module_runtime ${clause}`,
      );
    }
  }
  await client.query(
    `REVOKE ALL ON north_star_module.${quoted(entity.physicalTableName)} FROM PUBLIC`,
  );
  await client.query(
    `GRANT SELECT, INSERT, UPDATE ON north_star_module.${quoted(entity.physicalTableName)} TO north_star_module_runtime`,
  );
  await client.query(
    `REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON north_star_module.${quoted(entity.physicalTableName)} FROM north_star_module_runtime`,
  );
}

async function verifyCatalogOnClient(
  client: PoolClient,
  targets: readonly StorageTargetPayloadV1[],
): Promise<CatalogVerification> {
  const expectedTables = mergeExpectedTables(targets);
  const drift: string[] = [];
  const relations = await client.query<{
    owner: string;
    relkind: string;
    relname: string;
    schema_name: string;
  }>(
    `SELECT namespace.nspname AS schema_name, relation.relname, relation.relkind,
            pg_get_userbyid(relation.relowner) AS owner
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
        AND relation.relkind IN ('r','p','v','m','S','f')
      ORDER BY namespace.nspname, relation.relkind, relation.relname`,
  );
  for (const relation of relations.rows) {
    const verifierCount =
      Number(
        relation.schema_name === 'platform' ||
          relation.schema_name === 'north_star_internal',
      ) + Number(relation.schema_name === 'north_star_module');
    if (verifierCount !== 1) {
      drift.push(
        `object ${relation.schema_name}.${relation.relname} has ${verifierCount} verifiers`,
      );
      continue;
    }
    if (relation.schema_name === 'north_star_module') {
      if (relation.relkind !== 'r')
        drift.push(`unknown managed object kind ${relation.relkind}`);
      if (!expectedTables.has(relation.relname))
        drift.push(`rogue managed relation ${relation.relname}`);
      if (relation.owner !== 'north_star_module_materializer')
        drift.push(`wrong owner for ${relation.relname}`);
    }
  }
  for (const [tableName, entity] of expectedTables) {
    const present = relations.rows.find(
      (row) =>
        row.schema_name === 'north_star_module' && row.relname === tableName,
    );
    if (!present) continue;
    const columns = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'north_star_module' AND table_name = $1`,
      [tableName],
    );
    const relationColumns = targets.flatMap((target) =>
      target.relations
        .filter((relation) => relation.sourceEntityId === entity.entityId)
        .map((relation) => relation.relationColumn.physicalName),
    );
    const expectedNames = new Set([
      'tenant_id',
      'environment_id',
      entity.recordIdentity.column,
      entity.optimisticRevision.column,
      entity.archive.archivedAtColumn,
      ...entity.columns.map((column) => column.physicalName),
      ...entity.derivedStateFields.map((column) => column.physicalName),
      ...relationColumns,
    ]);
    for (const actual of columns.rows) {
      if (!expectedNames.has(actual.column_name)) {
        drift.push(`unattributed column ${tableName}.${actual.column_name}`);
      }
    }
    for (const expected of entity.columns) {
      const actual = columns.rows.find(
        (column) => column.column_name === expected.physicalName,
      );
      if (!actual)
        drift.push(`missing column ${tableName}.${expected.physicalName}`);
      else if (!expected.nullable && actual.is_nullable !== 'NO')
        drift.push(`nullable drift ${tableName}.${expected.physicalName}`);
    }
  }
  const dangerous = await client.query<{ description: string }>(
    `SELECT 'DELETE grant ' || table_schema || '.' || table_name AS description
      FROM information_schema.role_table_grants
      WHERE table_schema = 'north_star_module' AND privilege_type IN ('DELETE', 'TRUNCATE')
        AND grantee IN ('PUBLIC', 'north_star_runtime', 'north_star_module_runtime')
     UNION ALL
     SELECT 'trigger ' || event_object_schema || '.' || event_object_table || '.' || trigger_name
       FROM information_schema.triggers WHERE event_object_schema = 'north_star_module'
     UNION ALL
     SELECT 'rule ' || schemaname || '.' || tablename || '.' || rulename
       FROM pg_rules WHERE schemaname = 'north_star_module'`,
  );
  drift.push(...dangerous.rows.map((row) => row.description));
  const policies = await client.query<{
    cmd: string;
    policyname: string;
    tablename: string;
  }>(
    `SELECT tablename, policyname, cmd FROM pg_policies
      WHERE schemaname = 'north_star_module'`,
  );
  for (const policy of policies.rows) {
    if (!['SELECT', 'INSERT', 'UPDATE'].includes(policy.cmd)) {
      drift.push(
        `delete-capable policy ${policy.tablename}.${policy.policyname}`,
      );
    }
  }
  const digest = new Uint8Array(
    createHash('sha256')
      .update('northstar.module-storage-live-catalog/v1')
      .update('\0')
      .update(
        canonicalize({
          relations: relations.rows,
          drift,
          policies: policies.rows,
        }),
      )
      .digest(),
  );
  return Object.freeze({ digest, drift: Object.freeze(drift.toSorted()) });
}

async function loadAccountedLiveTargets(
  client: PoolClient,
  restoreContext: TrustedRequestContext,
  initial: readonly StorageTargetPayloadV1[],
): Promise<StorageTargetPayloadV1[]> {
  const generations = await client.query<{
    environment_id: string;
    target_release_id: string;
    tenant_id: string;
  }>(
    `SELECT DISTINCT tenant_id, environment_id, target_release_id
       FROM north_star_internal.module_storage_generations
      WHERE state IN (
        'PREPARING', 'PREPARED', 'IN_ATTEMPT', 'READY_TO_SWAP', 'SWAPPED',
        'RECONCILING'
      )`,
  );
  const targets = [...initial];
  try {
    for (const generation of generations.rows) {
      await client.query(
        `SELECT set_config('north_star.tenant_id', $1, true),
                set_config('north_star.environment_id', $2, true)`,
        [generation.tenant_id, generation.environment_id],
      );
      targets.push(
        (
          await loadVerifiedReleaseStorage(
            client,
            generation.tenant_id,
            generation.environment_id,
            generation.target_release_id,
          )
        ).target,
      );
    }
  } finally {
    await setMaterializerScope(client, restoreContext);
  }
  return targets;
}

function mergeExpectedTables(
  targets: readonly StorageTargetPayloadV1[],
): Map<string, StorageEntityTarget> {
  const result = new Map<string, StorageEntityTarget>();
  for (const target of targets) {
    for (const entity of target.entities) {
      const prior = result.get(entity.physicalTableName);
      result.set(
        entity.physicalTableName,
        prior ? mergeCompatibleEntity(prior, entity) : entity,
      );
    }
  }
  return result;
}

function mergeCompatibleEntity(
  prior: StorageEntityTarget,
  next: StorageEntityTarget,
): StorageEntityTarget {
  const withoutAdditive = (entity: StorageEntityTarget) => {
    const {
      columns: _columns,
      consumerWriterRoots: _consumerWriterRoots,
      derivedStateFields: _derivedStateFields,
      indexes: _indexes,
      uniqueKeys: _uniqueKeys,
      ...base
    } = entity;
    return base;
  };
  if (
    canonicalize(withoutAdditive(prior)) !== canonicalize(withoutAdditive(next))
  ) {
    throw failure(
      'LIVE_SET_SHAPE_CONFLICT',
      `conflicting live roots claim ${next.physicalTableName}`,
    );
  }
  const mergeNamed = <T>(
    left: readonly T[],
    right: readonly T[],
    name: (value: T) => string,
  ): T[] => {
    const values = new Map(left.map((value) => [name(value), value]));
    for (const value of right) {
      const key = name(value);
      const existing = values.get(key);
      if (existing && canonicalize(existing) !== canonicalize(value)) {
        throw failure(
          'LIVE_SET_SHAPE_CONFLICT',
          `conflicting live roots claim ${next.physicalTableName}.${key}`,
        );
      }
      values.set(key, value);
    }
    return [...values.values()].toSorted((leftValue, rightValue) =>
      name(leftValue).localeCompare(name(rightValue)),
    );
  };
  return {
    ...next,
    columns: mergeNamed(
      prior.columns,
      next.columns,
      (value) => value.physicalName,
    ),
    derivedStateFields: mergeNamed(
      prior.derivedStateFields,
      next.derivedStateFields,
      (value) => value.physicalName,
    ),
    indexes: mergeNamed(
      prior.indexes,
      next.indexes,
      (value) => value.physicalName,
    ),
    uniqueKeys: mergeNamed(
      prior.uniqueKeys,
      next.uniqueKeys,
      (value) => value.physicalName,
    ),
  };
}

async function registerElement(
  client: PoolClient,
  command: PrepareModuleStorageTransitionCommand,
  element: StorageTransitionElement,
): Promise<void> {
  const shape = hash(
    HASH_DOMAINS.storageTransitionElement,
    new TextEncoder().encode(canonicalize(element)),
  );
  await client.query(
    `INSERT INTO north_star_internal.module_storage_elements (
       element_id, element_kind, physical_object_name, shape_fingerprint, first_generation_id
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (element_id) DO NOTHING`,
    [
      element.elementId,
      element.kind,
      element.physicalObjectName,
      shape,
      command.generationId,
    ],
  );
  const result = await client.query<{ shape_fingerprint: string }>(
    `SELECT shape_fingerprint
       FROM north_star_internal.module_storage_elements
      WHERE element_id = $1`,
    [element.elementId],
  );
  if (result.rows[0]?.shape_fingerprint !== shape) {
    throw failure(
      'ELEMENT_SHAPE_CONFLICT',
      `element identity ${element.elementId} has conflicting bytes`,
    );
  }
}

async function appendApplication(
  client: PoolClient,
  command: { context: TrustedRequestContext; generationId: string },
  element: StorageTransitionElement,
  state: 'APPLIED' | 'FAILED' | 'RECONCILING' | 'STARTED' | 'VERIFIED',
  attemptId: string | null,
): Promise<void> {
  const digest = digestModuleTransitionElements([
    {
      disposition: 'APPLIED',
      elementId: element.elementId,
      kind: element.kind,
      physicalObjectName: element.physicalObjectName,
    },
  ]);
  await client.query(
    `INSERT INTO north_star_internal.module_storage_element_applications (
       application_id, tenant_id, environment_id, generation_id, element_id,
       attempt_id, application_state, application_digest, detail_code
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'COMPILED_ELEMENT')`,
    [
      randomUUID(),
      command.context.tenantId,
      command.context.environmentId,
      command.generationId,
      element.elementId,
      attemptId,
      state,
      Buffer.from(digest),
    ],
  );
}

async function persistRootMembership(
  client: PoolClient,
  command: PrepareModuleStorageTransitionCommand,
  sourceReleaseId: string,
  target: VerifiedReleaseStorage,
  transition: StorageTransitionEnvelope,
): Promise<void> {
  await client.query(
    `INSERT INTO north_star_internal.module_storage_root_membership (
       tenant_id, environment_id, release_id, release_root, generation_id,
       element_id, provenance_artifact_root
     )
     SELECT tenant_id, environment_id, $3, $4, $5, element_id, provenance_artifact_root
       FROM north_star_internal.module_storage_root_membership
      WHERE tenant_id = $1 AND environment_id = $2 AND release_id = $6
     ON CONFLICT DO NOTHING`,
    [
      command.context.tenantId,
      command.context.environmentId,
      command.targetReleaseId,
      target.manifestRoot,
      command.generationId,
      sourceReleaseId,
    ],
  );
  for (const element of transition.elements) {
    await client.query(
      `INSERT INTO north_star_internal.module_storage_root_membership (
         tenant_id, environment_id, release_id, release_root, generation_id,
         element_id, provenance_artifact_root
       ) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        command.context.tenantId,
        command.context.environmentId,
        command.targetReleaseId,
        target.manifestRoot,
        command.generationId,
        element.elementId,
        target.transitionArtifactRoot,
      ],
    );
  }
  const roots = await loadLiveRoots(
    client,
    command.context,
    command.targetReleaseId,
  );
  await reconcileReferenceCounts(
    client,
    command.context,
    roots,
    command.generationId,
  );
}

async function reconcileReferenceCounts(
  client: PoolClient,
  context: TrustedRequestContext,
  liveRoots: readonly string[],
  generationId?: string,
): Promise<void> {
  const generations = generationId
    ? [generationId]
    : (
        await client.query<{ generation_id: string }>(
          `SELECT generation_id FROM north_star_internal.module_storage_generations
          WHERE tenant_id = $1 AND environment_id = $2`,
          [context.tenantId, context.environmentId],
        )
      ).rows.map((row) => row.generation_id);
  for (const generation of generations) {
    await client.query(
      `INSERT INTO north_star_internal.module_storage_reference_counts (
         tenant_id, environment_id, generation_id, element_id, live_root_count,
         last_full_reconciliation_at
       )
       SELECT $1,$2,$3,membership.element_id,
              count(DISTINCT membership.release_id), transaction_timestamp()
         FROM north_star_internal.module_storage_root_membership AS membership
        WHERE membership.tenant_id = $1 AND membership.environment_id = $2
          AND membership.release_id = ANY($4::uuid[])
        GROUP BY membership.element_id
       ON CONFLICT (tenant_id, environment_id, generation_id, element_id)
       DO UPDATE SET live_root_count = EXCLUDED.live_root_count,
         last_full_reconciliation_at = transaction_timestamp(),
         updated_at = transaction_timestamp()`,
      [context.tenantId, context.environmentId, generation, liveRoots],
    );
  }
}

async function loadLiveRoots(
  client: PoolClient,
  context: TrustedRequestContext,
  includeReleaseId?: string,
): Promise<string[]> {
  const result = await client.query<{ release_id: string }>(
    `SELECT release_id FROM platform.active_release_pointers
      WHERE tenant_id = $1 AND environment_id = $2 AND release_id IS NOT NULL
     UNION
     SELECT generation.target_release_id
       FROM north_star_internal.module_storage_generations AS generation
      WHERE generation.tenant_id = $1 AND generation.environment_id = $2
        AND generation.state IN (
          'PREPARING', 'PREPARED', 'IN_ATTEMPT', 'READY_TO_SWAP', 'RECONCILING'
        )
     UNION
     SELECT preparation.target_release_id
       FROM platform.release_activation_preparations AS preparation
       LEFT JOIN platform.release_approvals AS approval
         ON approval.tenant_id = preparation.tenant_id
        AND approval.environment_id = preparation.environment_id
        AND approval.preparation_id = preparation.preparation_id
       LEFT JOIN platform.release_activation_history AS history
         ON history.tenant_id = approval.tenant_id
        AND history.environment_id = approval.environment_id
        AND history.approval_id = approval.approval_id
        AND history.terminal
      WHERE preparation.tenant_id = $1 AND preparation.environment_id = $2
        AND history.approval_id IS NULL
     UNION SELECT $3::uuid WHERE $3::uuid IS NOT NULL`,
    [context.tenantId, context.environmentId, includeReleaseId ?? null],
  );
  return result.rows.map((row) => row.release_id);
}

async function appendCatalogReceipt(
  client: PoolClient,
  context: TrustedRequestContext,
  generationId: string,
  sourceReleaseId: string,
  sourceRoot: string,
  targetReleaseId: string,
  targetRoot: string,
  preparedSubsetDigest: Uint8Array,
  remainingPlanDigest: Uint8Array,
  catalogDigest: Uint8Array,
  state: 'PREPARED' | 'READY_TO_SWAP',
): Promise<ModuleStorageCatalogReceipt> {
  const receiptId = randomUUID();
  const result = await client.query<{ recorded_at: Date | string }>(
    `INSERT INTO north_star_internal.module_storage_catalog_receipts (
       tenant_id, environment_id, receipt_id, receipt_version, generation_id,
       source_release_id, source_manifest_root, target_release_id, target_manifest_root,
       prepared_subset_digest, remaining_plan_digest, catalog_digest,
       receipt_state, catalog_verified
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
     RETURNING recorded_at`,
    [
      context.tenantId,
      context.environmentId,
      receiptId,
      MODULE_STORAGE_CATALOG_RECEIPT_VERSION,
      generationId,
      sourceReleaseId,
      Buffer.from(sourceRoot, 'hex'),
      targetReleaseId,
      Buffer.from(targetRoot, 'hex'),
      Buffer.from(preparedSubsetDigest),
      Buffer.from(remainingPlanDigest),
      Buffer.from(catalogDigest),
      state,
    ],
  );
  return Object.freeze({
    catalogDigest,
    catalogVerified: true,
    createdAt: new Date(result.rows[0]!.recorded_at).toISOString(),
    environmentId: context.environmentId,
    generationId: generationId as never,
    preparedSubsetDigest,
    receiptId: receiptId as never,
    receiptVersion: MODULE_STORAGE_CATALOG_RECEIPT_VERSION,
    remainingPlanDigest,
    sourceManifestRoot: Buffer.from(sourceRoot, 'hex'),
    sourceReleaseId: sourceReleaseId as never,
    state,
    targetManifestRoot: Buffer.from(targetRoot, 'hex'),
    targetReleaseId: targetReleaseId as never,
    tenantId: context.tenantId,
  });
}

async function loadPreparationAuthority(
  client: PoolClient,
  command: PrepareModuleStorageTransitionCommand,
): Promise<{ authorized: boolean; denied: boolean; paused: boolean }> {
  const result = await client.query<{
    authorized: boolean | null;
    denied: boolean | null;
    paused: boolean | null;
  }>(
    `SELECT (
       SELECT event.authorized FROM platform.release_executor_authority_events AS event
        WHERE event.tenant_id = $1 AND event.principal_id = $3
        ORDER BY event.policy_version DESC LIMIT 1
     ) AS authorized,
     (SELECT event.live_policy_denied FROM platform.release_activation_control_events AS event
       WHERE event.tenant_id = $1 AND event.environment_id = $2
       ORDER BY event.policy_version DESC LIMIT 1) AS denied,
     (SELECT event.rollout_paused FROM platform.release_activation_control_events AS event
       WHERE event.tenant_id = $1 AND event.environment_id = $2
       ORDER BY event.policy_version DESC LIMIT 1) AS paused`,
    [
      command.context.tenantId,
      command.context.environmentId,
      command.initiatedBy,
    ],
  );
  return {
    authorized: result.rows[0]?.authorized === true,
    denied: result.rows[0]?.denied === true,
    paused: result.rows[0]?.paused === true,
  };
}

async function beginLocked(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await acquireSharedMigrationLock(client);
}

async function setMaterializerScope(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<void> {
  await client.query(
    `SELECT set_config('north_star.tenant_id', $1, true),
            set_config('north_star.environment_id', $2, true)`,
    [context.tenantId, context.environmentId],
  );
}

async function acquireSharedMigrationLock(client: PoolClient): Promise<void> {
  const started = performance.now();
  for (
    let attempt = 0;
    attempt <= MODULE_STORAGE_MIGRATION_LOCK.maximumRetries;
    attempt += 1
  ) {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
      [MODULE_STORAGE_MIGRATION_LOCK.key],
    );
    if (result.rows[0]?.locked) return;
    await client.query('ROLLBACK');
    if (
      attempt === MODULE_STORAGE_MIGRATION_LOCK.maximumRetries ||
      performance.now() - started >=
        MODULE_STORAGE_MIGRATION_LOCK.timeoutMilliseconds
    ) {
      throw failure(
        'MIGRATION_LOCK_TIMEOUT',
        MODULE_STORAGE_MIGRATION_LOCK.starvationRule,
      );
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, MODULE_STORAGE_MIGRATION_LOCK.retryDelayMilliseconds),
    );
    await client.query('BEGIN');
  }
}

async function assertMaterializerSession(client: PoolClient): Promise<void> {
  const result = await client.query<{
    bypassrls: boolean;
    createrole: boolean;
    current_user: string;
    superuser: boolean;
  }>(
    `SELECT current_user, role.rolsuper AS superuser, role.rolbypassrls AS bypassrls,
            role.rolcreaterole AS createrole
       FROM pg_roles AS role WHERE role.rolname = current_user`,
  );
  const row = result.rows[0];
  if (
    !row ||
    row.current_user !== 'north_star_module_materializer' ||
    row.superuser ||
    row.bypassrls ||
    row.createrole
  ) {
    throw failure(
      'MATERIALIZER_ROLE_INVALID',
      'DDL pool must be the isolated non-escalated materializer role',
    );
  }
}

async function nextGenerationNumber(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<number> {
  const result = await client.query<{ generation: string | number }>(
    `SELECT coalesce(max(generation_number), 0) + 1 AS generation
       FROM north_star_internal.module_storage_generations
      WHERE tenant_id = $1 AND environment_id = $2`,
    [context.tenantId, context.environmentId],
  );
  return Number(result.rows[0]!.generation);
}

async function loadGeneration(
  client: PoolClient,
  command: ExecuteModuleStorageAttemptCommand,
): Promise<GenerationRow> {
  return requiredOne<GenerationRow>(
    client,
    `SELECT * FROM north_star_internal.module_storage_generations
      WHERE tenant_id = $1 AND environment_id = $2 AND generation_id = $3
        AND state IN ('PREPARED', 'IN_ATTEMPT', 'RECONCILING') FOR UPDATE`,
    [
      command.context.tenantId,
      command.context.environmentId,
      command.generationId,
    ],
    'prepared module storage generation',
  );
}

async function recordReconciling(
  pool: Pool,
  command: ExecuteModuleStorageAttemptCommand,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE north_star_internal.module_storage_generations SET state = 'RECONCILING'
        WHERE generation_id = $1`,
      [command.generationId],
    );
    await client.query(
      `UPDATE north_star_internal.module_storage_attempt_claims
          SET claim_state = 'RECONCILING', updated_at = transaction_timestamp()
        WHERE activation_attempt_id = $1`,
      [command.activationAttemptId],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

function locateColumn(
  target: StorageTargetPayloadV1,
  element: StorageTransitionElement,
) {
  for (const entity of target.entities) {
    const column = entity.columns.find(
      (candidate) => candidate.physicalName === element.physicalObjectName,
    );
    if (column) return { column, entity };
  }
  throw failure('ELEMENT_TARGET_MISSING', element.elementId);
}

function locateIndex(
  target: StorageTargetPayloadV1,
  element: StorageTransitionElement,
) {
  for (const entity of target.entities) {
    const index = entity.indexes.find(
      (candidate) => candidate.physicalName === element.physicalObjectName,
    );
    if (index) return { entity, index };
  }
  throw failure('ELEMENT_TARGET_MISSING', element.elementId);
}

function requiredEntity(
  target: StorageTargetPayloadV1,
  entityId: string,
): StorageEntityTarget {
  const entity = target.entities.find(
    (candidate) => candidate.entityId === entityId,
  );
  if (!entity) throw failure('ENTITY_TARGET_MISSING', entityId);
  return entity;
}

function renderDiff(
  elements: readonly StorageTransitionElement[],
  phase: 'attempt' | 'preparation',
): RenderedModuleTransitionDiff {
  return Object.freeze({
    elements: Object.freeze(
      elements.map((element) =>
        Object.freeze({
          disposition:
            element.classification.preparationValidity === 'preApprovalInert' ||
            (phase === 'attempt' &&
              element.classification.preparationValidity === 'inAttemptOnly')
              ? ('APPLIED' as const)
              : element.classification.preparationValidity === 'inAttemptOnly'
                ? ('PENDING_IN_ATTEMPT' as const)
                : ('PENDING_DEFERRED' as const),
          elementId: element.elementId,
          kind: element.kind,
          physicalObjectName: element.physicalObjectName,
        }),
      ),
    ),
    version: MODULE_STORAGE_RENDERED_DIFF_VERSION,
  });
}

function rendererStatement(
  element: StorageTransitionElement,
): StorageRendererStatement {
  if (element.kind === 'addForeignKey')
    return {
      kind: 'addForeignKey',
      onDelete: 'restrict',
      onUpdate: 'restrict',
    };
  return { kind: element.kind } as StorageRendererStatement;
}

function safeType(type: string): string {
  if (!allowedTypes.some((pattern) => pattern.test(type))) {
    throw failure('POSTGRESQL_TYPE_REJECTED', type);
  }
  return type;
}

function defaultSql(semantics: string, value: unknown): string {
  if (semantics !== 'declaredDefault') return '';
  if (typeof value === 'string')
    return ` DEFAULT '${value.replaceAll("'", "''")}'`;
  if (typeof value === 'boolean') return ` DEFAULT ${value ? 'true' : 'false'}`;
  if (typeof value === 'number' && Number.isFinite(value))
    return ` DEFAULT ${String(value)}`;
  throw failure(
    'DECLARED_DEFAULT_REJECTED',
    'only closed scalar defaults may enter DDL',
  );
}

function databaseDefaultValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (
      [
        'booleanValue',
        'dateValue',
        'dateTimeValue',
        'decimalValue',
        'enumValue',
        'integerValue',
        'moneyValue',
        'quantityValue',
        'textValue',
        'timeValue',
      ].includes(String(record.kind)) &&
      ['string', 'boolean', 'number'].includes(typeof record.value)
    ) {
      return record.value;
    }
  }
  throw failure(
    'BACKFILL_DEFAULT_REJECTED',
    'backfill default is outside the closed scalar value set',
  );
}

function quoted(identifier: string): string {
  if (!identifierPattern.test(identifier))
    throw failure('IDENTIFIER_REJECTED', identifier);
  return `"${identifier}"`;
}

function hash(domain: string, bytes: Uint8Array): string {
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(bytes)
    .digest('hex');
}

function hexDigest(value: string | null | undefined): Uint8Array {
  if (!value || !sha256Pattern.test(value))
    throw failure('DIGEST_INVALID', 'expected SHA-256 digest');
  return new Uint8Array(Buffer.from(value, 'hex'));
}

function validateCommandIdentity(
  context: TrustedRequestContext,
  initiatedBy: string,
): void {
  assertUuid(context.tenantId, 'tenantId');
  assertUuid(context.environmentId, 'environmentId');
  assertUuid(initiatedBy, 'initiatedBy');
  if (context.principalId !== initiatedBy) {
    throw failure(
      'INITIATOR_IDENTITY_MISMATCH',
      'initiator must be the trusted principal',
    );
  }
}

function assertUuid(value: string, name: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw failure('IDENTITY_INVALID', `${name} must be a UUID`);
  }
}

async function requiredOne<T extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
  label: string,
): Promise<T> {
  const result = await client.query<T>(sql, [...values]);
  if (result.rowCount !== 1 || !result.rows[0])
    throw failure('RECORD_NOT_FOUND', `${label} is unavailable`);
  return result.rows[0];
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    /* retain the original failure */
  }
}

function isAmbiguousDatabaseError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    ['08000', '08003', '08006', '57P01'].includes(
      String((error as { code?: unknown }).code ?? ''),
    ),
  );
}

function failure(
  code: string,
  message: string,
): ModuleStorageMaterializationError {
  return new ModuleStorageMaterializationError(code, message);
}
