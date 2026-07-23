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

export interface ModuleStorageMaterializerFaultHooks {
  readonly afterBackfillCheckpointCommitted?: (facts: {
    readonly elementId: string;
    readonly rowsApplied: number;
  }) => Promise<void> | void;
  readonly afterClaimCommitted?: () => Promise<void> | void;
}

interface ArtifactRow {
  artifact_kind: string;
  canonical_bytes: Uint8Array;
  content_hash: string;
  domain_tag: string;
  release_content_hash: string;
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
  preparation_id: string;
  prepared_subset_digest: Uint8Array;
  remaining_plan_digest: Uint8Array;
  source_manifest_root: Uint8Array;
  source_release_id: string;
  state: string;
  target_manifest_root: Uint8Array;
  target_release_id: string;
  tenant_id: string;
}

interface CatalogReceiptRow {
  catalog_digest: Uint8Array;
  catalog_verified: boolean;
  environment_id: string;
  generation_id: string;
  prepared_subset_digest: Uint8Array;
  receipt_id: string;
  receipt_state: 'READY_TO_SWAP';
  receipt_version: string;
  recorded_at: Date | string;
  remaining_plan_digest: Uint8Array;
  source_manifest_root: Uint8Array;
  source_release_id: string;
  target_manifest_root: Uint8Array;
  target_release_id: string;
  tenant_id: string;
}

interface ActualIndexShape {
  columns: string[];
  constraintName: string | null;
  definition: string;
  name: string;
  owner: string;
  predicate: string | null;
  primary: boolean;
  ready: boolean;
  tableName: string;
  unique: boolean;
  valid: boolean;
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
    private readonly faultHooks: ModuleStorageMaterializerFaultHooks = {},
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
           FROM north_star_internal.module_storage_read_active_release_pointer($1, $2)`,
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
    assertUuid(command.context.tenantId, 'tenantId');
    assertUuid(command.context.environmentId, 'environmentId');
    assertUuid(command.context.principalId, 'principalId');
    assertUuid(command.activationAttemptId, 'activationAttemptId');
    assertUuid(command.coordinatorId, 'coordinatorId');
    assertUuid(command.generationId, 'generationId');
    const client = await this.materializerPool.connect();
    let generationLockHeld = false;
    try {
      await assertMaterializerSession(client);
      await acquireGenerationSessionLock(client, command.generationId);
      generationLockHeld = true;
      await beginLocked(client);
      await setMaterializerScope(client, command.context);
      const generation = await loadGeneration(client, command);
      const completed = await loadCompletedAttemptReceipt(
        client,
        command,
        generation,
      );
      if (completed) {
        await client.query('COMMIT');
        return { disposition: 'READY_TO_SWAP', receipt: completed };
      }
      if (generation.state === 'READY_TO_SWAP') {
        throw failure(
          'ATTEMPT_READY_EVIDENCE_MISSING',
          'ready generation is missing its completed claim and receipt',
        );
      }
      await assertApprovedAttempt(client, command, generation.preparation_id);
      const claim = await client.query<{
        coordinator_id: string;
        generation_id: string;
      }>(
        `INSERT INTO north_star_internal.module_storage_attempt_claims (
           tenant_id, environment_id, generation_id, activation_attempt_id,
           coordinator_id, claim_state
         ) VALUES ($1,$2,$3,$4,$5,'CLAIMED')
         ON CONFLICT (tenant_id, environment_id, activation_attempt_id)
         DO UPDATE SET coordinator_id = EXCLUDED.coordinator_id,
                       claim_state = 'CLAIMED',
                       updated_at = transaction_timestamp()
          WHERE module_storage_attempt_claims.generation_id = EXCLUDED.generation_id
            AND module_storage_attempt_claims.claim_state IN ('CLAIMED', 'RECONCILING')
         RETURNING coordinator_id, generation_id`,
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
          'ATTEMPT_CLAIM_MISMATCH',
          'attempt claim is terminal or belongs to a different generation',
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
            SET state = 'IN_ATTEMPT'
          WHERE generation_id = $1
            AND state IN ('PREPARED', 'IN_ATTEMPT', 'RECONCILING')`,
        [command.generationId],
      );
      await client.query('COMMIT');
      await this.faultHooks.afterClaimCommitted?.();

      for (const element of transition.elements.filter(
        (candidate) =>
          candidate.classification.preparationValidity === 'inAttemptOnly',
      )) {
        if (element.kind === 'backfill') {
          await this.applyBackfill(
            command,
            generation.preparation_id,
            target.target,
            element,
            client,
          );
          await beginLocked(client);
          await setMaterializerScope(client, command.context);
        } else {
          await beginLocked(client);
          await setMaterializerScope(client, command.context);
        }
        await assertApprovedAttempt(client, command, generation.preparation_id);
        if (!(await hasAppliedAttemptElement(client, command, element))) {
          if (element.kind !== 'backfill') {
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
        await client.query('COMMIT');
      }

      await beginLocked(client);
      await setMaterializerScope(client, command.context);
      await assertApprovedAttempt(client, command, generation.preparation_id);
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
      await assertApprovedAttempt(client, command, generation.preparation_id);
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
      const completedClaim = await client.query(
        `UPDATE north_star_internal.module_storage_attempt_claims
            SET claim_state = 'COMPLETED', updated_at = transaction_timestamp()
          WHERE tenant_id = $1 AND environment_id = $2
            AND generation_id = $3 AND activation_attempt_id = $4
            AND coordinator_id = $5 AND claim_state = 'CLAIMED'`,
        [
          command.context.tenantId,
          command.context.environmentId,
          command.generationId,
          command.activationAttemptId,
          command.coordinatorId,
        ],
      );
      if (completedClaim.rowCount !== 1) {
        throw failure(
          'ATTEMPT_CLAIM_COMPLETION_MISMATCH',
          'READY evidence requires the currently claimed generation and coordinator',
        );
      }
      const readyGeneration = await client.query(
        `UPDATE north_star_internal.module_storage_generations
            SET state = 'READY_TO_SWAP'
          WHERE generation_id = $1 AND state IN ('IN_ATTEMPT', 'RECONCILING')`,
        [command.generationId],
      );
      if (readyGeneration.rowCount !== 1) {
        throw failure(
          'GENERATION_READY_STATE_MISMATCH',
          'READY evidence requires an executable durable generation state',
        );
      }
      await client.query('COMMIT');
      return { disposition: 'READY_TO_SWAP', receipt };
    } catch (error) {
      await rollbackQuietly(client);
      if (isAmbiguousModuleStorageDatabaseError(error)) {
        try {
          await recordReconciling(this.materializerPool, command);
        } catch {
          /* unavailable databases retain the durable claim/checkpoint for retry */
        }
        return { disposition: 'RECONCILING', receipt: null };
      }
      throw error;
    } finally {
      if (generationLockHeld) {
        await releaseGenerationSessionLockQuietly(client, command.generationId);
      }
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
    preparationId: string,
    target: StorageTargetPayloadV1,
    element: StorageTransitionElement,
    controlClient: PoolClient,
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
        await beginLocked(controlClient);
        await setMaterializerScope(controlClient, command.context);
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('north_star.tenant_id', $1, true),
                  set_config('north_star.environment_id', $2, true)`,
          [command.context.tenantId, command.context.environmentId],
        );
        const authorized = await client.query<{ authorized: boolean }>(
          `SELECT authorized
             FROM north_star_internal.module_storage_lock_backfill_attempt(
               $1, $2, $3, $4
             )`,
          [
            command.context.tenantId,
            command.context.environmentId,
            command.activationAttemptId,
            preparationId,
          ],
        );
        if (authorized.rowCount !== 1 || !authorized.rows[0]?.authorized) {
          throw failure(
            'ATTEMPT_NOT_AUTHORIZED',
            'backfill mutation requires a current unconsumed approved attempt',
          );
        }
        const checkpoint = await client.query<{
          activation_attempt_id: string;
          complete: boolean;
          last_record_id: string | null;
        }>(
          `SELECT activation_attempt_id, complete, last_record_id
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
        const prior = checkpoint.rows[0];
        if (
          prior &&
          prior.activation_attempt_id !== command.activationAttemptId
        ) {
          throw failure(
            'BACKFILL_ATTEMPT_MISMATCH',
            'durable checkpoint belongs to a different activation attempt',
          );
        }
        if (prior?.complete) {
          await client.query('COMMIT');
          await controlClient.query('COMMIT');
          return;
        }
        const last = prior?.last_record_id ?? null;
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
        const next =
          updated.rows
            .map((row) => row.record_id)
            .toSorted()
            .at(-1) ?? last;
        await client.query(
          `INSERT INTO north_star_internal.module_storage_backfill_checkpoints (
             tenant_id, environment_id, generation_id, element_id,
             activation_attempt_id, last_record_id, rows_applied, complete
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (tenant_id, environment_id, generation_id, element_id)
           DO UPDATE SET last_record_id = EXCLUDED.last_record_id,
             rows_applied = module_storage_backfill_checkpoints.rows_applied + EXCLUDED.rows_applied,
             complete = EXCLUDED.complete, updated_at = transaction_timestamp()
           WHERE module_storage_backfill_checkpoints.activation_attempt_id =
                 EXCLUDED.activation_attempt_id`,
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
        const stillAuthorized = await client.query<{ authorized: boolean }>(
          `SELECT authorized
             FROM north_star_internal.module_storage_lock_backfill_attempt(
               $1, $2, $3, $4
             )`,
          [
            command.context.tenantId,
            command.context.environmentId,
            command.activationAttemptId,
            preparationId,
          ],
        );
        if (
          stillAuthorized.rowCount !== 1 ||
          !stillAuthorized.rows[0]?.authorized
        ) {
          throw failure(
            'ATTEMPT_NOT_AUTHORIZED',
            'backfill mutation lost approval before its durable checkpoint',
          );
        }
        await client.query('COMMIT');
        await controlClient.query('COMMIT');
        await this.faultHooks.afterBackfillCheckpointCommitted?.({
          elementId: element.elementId,
          rowsApplied: updatedCount,
        });
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
  const artifacts = await client.query<ArtifactRow>(
    `SELECT release_content_hash, artifact_kind, canonical_bytes, content_hash, domain_tag
       FROM north_star_internal.module_storage_read_release_artifacts($1, $2, $3)`,
    [tenantId, environmentId, releaseId],
  );
  const releaseContentHash = artifacts.rows[0]?.release_content_hash;
  if (!releaseContentHash) {
    throw failure('RECORD_NOT_FOUND', 'persisted release root is unavailable');
  }
  if (
    artifacts.rows.some(
      (row) => row.release_content_hash !== releaseContentHash,
    )
  ) {
    throw failure(
      'RELEASE_SCOPE_MISMATCH',
      'release artifact reader returned more than one scoped release root',
    );
  }
  const byHash = new Map(artifacts.rows.map((row) => [row.content_hash, row]));
  for (const row of artifacts.rows) verifyArtifact(row);
  const manifestRow = byHash.get(releaseContentHash);
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
    manifestRoot: releaseContentHash,
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
           ADD COLUMN IF NOT EXISTS ${quoted(column.physicalName)} ${safeType(column.postgresqlType)}${defaultSql(column.defaultSemantics, column.defaultValue, column.postgresqlType)}`,
      );
      return;
    }
    case 'createIndex': {
      const located = locateIndex(target, element);
      await client.query(
        `CREATE ${located.index.indexKind === 'caseInsensitiveUnique' ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoted(located.index.physicalName)}
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
        `GRANT REFERENCES ON north_star_module.${quoted(targetEntity.physicalTableName)} TO north_star_module_materializer`,
      );
      await client.query(
        `ALTER TABLE north_star_module.${quoted(source.physicalTableName)}
           ADD CONSTRAINT ${quoted(relation.foreignKey.physicalName)}
           FOREIGN KEY (${relation.foreignKey.sourceColumns.map(quoted).join(', ')})
           REFERENCES north_star_module.${quoted(targetEntity.physicalTableName)}
           (${relation.foreignKey.targetColumns.map(quoted).join(', ')})
           ON DELETE RESTRICT ON UPDATE RESTRICT`,
      );
      await client.query(
        `REVOKE REFERENCES ON north_star_module.${quoted(targetEntity.physicalTableName)} FROM north_star_module_materializer`,
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
        `${quoted(column.physicalName)} ${safeType(column.postgresqlType)}${column.nullable ? '' : ' NOT NULL'}${defaultSql(column.defaultSemantics, column.defaultValue, column.postgresqlType)}`,
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
    const policy = managedPolicyName(entity.physicalTableName, command);
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
  await client.query(
    `REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON north_star_module.${quoted(entity.physicalTableName)} FROM north_star_module_materializer`,
  );
}

async function verifyCatalogOnClient(
  client: PoolClient,
  targets: readonly StorageTargetPayloadV1[],
): Promise<CatalogVerification> {
  const expectedTables = mergeExpectedTables(targets);
  const expectedRelations = mergeExpectedRelations(targets);
  const drift: string[] = [];

  const registry = await loadObjectOwnershipRegistry(client);
  for (const object of registry) {
    const verifierCount =
      Number(
        object.schema_name === 'platform' ||
          object.schema_name === 'north_star_internal',
      ) + Number(object.schema_name === 'north_star_module');
    if (verifierCount !== 1) {
      drift.push(
        `object ${object.schema_name}.${object.object_name} (${object.object_kind}) has ${verifierCount} verifiers`,
      );
    }
    if (object.object_kind.startsWith('unknown:')) {
      drift.push(
        `unknown object kind ${object.object_kind} for ${object.schema_name}.${object.object_name}`,
      );
    }
  }

  const schema = await requiredOne<{
    owner: string;
    schema_name: string;
  }>(
    client,
    `SELECT namespace.nspname AS schema_name,
            pg_get_userbyid(namespace.nspowner) AS owner
       FROM pg_namespace AS namespace
      WHERE namespace.nspname = 'north_star_module'`,
    [],
    'managed module schema',
  );
  compareCatalogCollection(
    drift,
    'schema',
    [
      {
        owner: 'north_star_module_materializer',
        schemaName: 'north_star_module',
      },
    ],
    [{ owner: schema.owner, schemaName: schema.schema_name }],
    (value) => value.schemaName,
  );

  const schemaGrants = await client.query<{
    grantee: string;
    is_grantable: boolean;
    privilege_type: string;
  }>(
    `SELECT COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_namespace AS namespace
       CROSS JOIN LATERAL aclexplode(
         COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
       ) AS privilege
       LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
      WHERE namespace.nspname = 'north_star_module'
      ORDER BY grantee, privilege.privilege_type`,
  );
  compareCatalogCollection(
    drift,
    'schema grant',
    [
      {
        grantee: 'north_star_module_materializer',
        isGrantable: false,
        privilegeType: 'CREATE',
      },
      {
        grantee: 'north_star_module_materializer',
        isGrantable: false,
        privilegeType: 'USAGE',
      },
      {
        grantee: 'north_star_module_runtime',
        isGrantable: false,
        privilegeType: 'USAGE',
      },
    ],
    schemaGrants.rows.map((grant) => ({
      grantee: grant.grantee,
      isGrantable: grant.is_grantable,
      privilegeType: grant.privilege_type,
    })),
    (value) => `${value.grantee}:${value.privilegeType}`,
  );

  const relations = await client.query<{
    force_row_level_security: boolean;
    is_partition: boolean;
    owner: string;
    relkind: string;
    relname: string;
    row_level_security: boolean;
  }>(
    `SELECT relation.relname, relation.relkind,
            pg_get_userbyid(relation.relowner) AS owner,
            relation.relrowsecurity AS row_level_security,
            relation.relforcerowsecurity AS force_row_level_security,
            relation.relispartition AS is_partition
      FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relkind NOT IN ('i','I','c')
      ORDER BY relation.relkind, relation.relname`,
  );
  compareCatalogCollection(
    drift,
    'managed relation',
    [...expectedTables.keys()].map((tableName) => ({
      forceRowLevelSecurity: true,
      isPartition: false,
      kind: 'r',
      name: tableName,
      owner: 'north_star_module_materializer',
      rowLevelSecurity: true,
    })),
    relations.rows.map((relation) => ({
      forceRowLevelSecurity: relation.force_row_level_security,
      isPartition: relation.is_partition,
      kind: relation.relkind,
      name: relation.relname,
      owner: relation.owner,
      rowLevelSecurity: relation.row_level_security,
    })),
    (value) => value.name,
  );

  const columns = await client.query<{
    column_default: string | null;
    generated_kind: string;
    identity_kind: string;
    is_nullable: boolean;
    name: string;
    postgresql_type: string;
    table_name: string;
  }>(
    `SELECT relation.relname AS table_name,
            attribute.attname AS name,
            format_type(attribute.atttypid, attribute.atttypmod) AS postgresql_type,
            NOT attribute.attnotnull AS is_nullable,
            pg_get_expr(default_value.adbin, default_value.adrelid, true) AS column_default,
            attribute.attidentity AS identity_kind,
            attribute.attgenerated AS generated_kind
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
       LEFT JOIN pg_attrdef AS default_value
         ON default_value.adrelid = relation.oid
        AND default_value.adnum = attribute.attnum
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relkind IN ('r','p')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY relation.relname, attribute.attname`,
  );
  const expectedColumns = buildExpectedColumns(
    expectedTables,
    expectedRelations,
  );
  compareCatalogCollection(
    drift,
    'managed column',
    expectedColumns,
    columns.rows.map((column) => ({
      defaultExpression: normalizeSqlExpression(column.column_default),
      generatedKind: column.generated_kind,
      identityKind: column.identity_kind,
      name: column.name,
      nullable: column.is_nullable,
      postgresqlType: column.postgresql_type,
      tableName: column.table_name,
    })),
    (value) => `${value.tableName}.${value.name}`,
  );

  const constraints = await client.query<{
    columns: string[];
    deferred: boolean;
    deferrable: boolean;
    delete_action: string;
    name: string;
    referenced_columns: string[] | null;
    referenced_schema: string | null;
    referenced_table: string | null;
    table_name: string;
    type: string;
    update_action: string;
    validated: boolean;
  }>(
    `SELECT source.relname AS table_name,
            constraint_record.conname AS name,
            constraint_record.contype AS type,
            ARRAY(
              SELECT attribute.attname
                FROM unnest(constraint_record.conkey) WITH ORDINALITY AS key(attnum, ordinal)
                JOIN pg_attribute AS attribute
                  ON attribute.attrelid = source.oid
                 AND attribute.attnum = key.attnum
               ORDER BY key.ordinal
            )::text[] AS columns,
            target_namespace.nspname AS referenced_schema,
            target.relname AS referenced_table,
            CASE WHEN constraint_record.confkey IS NULL THEN NULL ELSE ARRAY(
              SELECT attribute.attname
                FROM unnest(constraint_record.confkey) WITH ORDINALITY AS key(attnum, ordinal)
                JOIN pg_attribute AS attribute
                  ON attribute.attrelid = target.oid
                 AND attribute.attnum = key.attnum
               ORDER BY key.ordinal
            )::text[] END AS referenced_columns,
            constraint_record.confupdtype AS update_action,
            constraint_record.confdeltype AS delete_action,
            constraint_record.convalidated AS validated,
            constraint_record.condeferrable AS deferrable,
            constraint_record.condeferred AS deferred
       FROM pg_constraint AS constraint_record
       JOIN pg_class AS source ON source.oid = constraint_record.conrelid
       JOIN pg_namespace AS source_namespace
         ON source_namespace.oid = source.relnamespace
       LEFT JOIN pg_class AS target ON target.oid = constraint_record.confrelid
       LEFT JOIN pg_namespace AS target_namespace
         ON target_namespace.oid = target.relnamespace
      WHERE source_namespace.nspname = 'north_star_module'
      ORDER BY source.relname, constraint_record.conname`,
  );
  const expectedConstraints = buildExpectedConstraints(
    expectedTables,
    expectedRelations,
  );
  const actualConstraints = constraints.rows.map((constraint) => ({
    columns: constraint.columns,
    deferred: constraint.deferred,
    deferrable: constraint.deferrable,
    deleteAction: constraint.delete_action,
    name: constraint.name,
    referencedColumns: constraint.referenced_columns,
    referencedSchema: constraint.referenced_schema,
    referencedTable: constraint.referenced_table,
    tableName: constraint.table_name,
    type: constraint.type,
    updateAction: constraint.update_action,
    validated: constraint.validated,
  }));
  compareCatalogCollection(
    drift,
    'managed constraint',
    expectedConstraints,
    actualConstraints,
    (value) => `${value.tableName}.${value.name}`,
  );
  for (const constraint of actualConstraints) {
    if (
      constraint.type === 'f' &&
      (constraint.deleteAction !== 'r' || constraint.updateAction !== 'r')
    ) {
      drift.push(
        `destructive foreign key ${constraint.tableName}.${constraint.name}`,
      );
    }
  }

  const indexes = await client.query<{
    columns: string[];
    constraint_name: string | null;
    definition: string;
    is_primary: boolean;
    is_ready: boolean;
    is_unique: boolean;
    is_valid: boolean;
    name: string;
    owner: string;
    predicate: string | null;
    table_name: string;
  }>(
    `SELECT source.relname AS table_name,
            index_relation.relname AS name,
            pg_get_userbyid(index_relation.relowner) AS owner,
            index_record.indisunique AS is_unique,
            index_record.indisprimary AS is_primary,
            index_record.indisvalid AS is_valid,
            index_record.indisready AS is_ready,
            pg_get_indexdef(index_record.indexrelid, 0, true) AS definition,
            ARRAY(
              SELECT pg_get_indexdef(index_record.indexrelid, ordinal, true)
                FROM generate_series(1, index_record.indnkeyatts) AS ordinal
               ORDER BY ordinal
            ) AS columns,
            pg_get_expr(index_record.indpred, index_record.indrelid, true) AS predicate,
            constraint_record.conname AS constraint_name
       FROM pg_index AS index_record
       JOIN pg_class AS source ON source.oid = index_record.indrelid
       JOIN pg_namespace AS namespace ON namespace.oid = source.relnamespace
       JOIN pg_class AS index_relation
         ON index_relation.oid = index_record.indexrelid
       LEFT JOIN pg_constraint AS constraint_record
         ON constraint_record.conindid = index_record.indexrelid
        AND constraint_record.contype IN ('p','u','x')
      WHERE namespace.nspname = 'north_star_module'
      ORDER BY source.relname, index_relation.relname`,
  );
  const actualIndexes: ActualIndexShape[] = indexes.rows.map((index) => ({
    columns: index.columns.map(normalizeSqlExpressionRequired),
    constraintName: index.constraint_name,
    definition: normalizeSqlExpressionRequired(index.definition),
    name: index.name,
    owner: index.owner,
    predicate: normalizeSqlExpression(index.predicate),
    primary: index.is_primary,
    ready: index.is_ready,
    tableName: index.table_name,
    unique: index.is_unique,
    valid: index.is_valid,
  }));
  compareCatalogCollection(
    drift,
    'managed index',
    buildExpectedIndexes(expectedTables),
    actualIndexes,
    (value) => `${value.tableName}.${value.name}`,
  );

  const policies = await client.query<{
    cmd: string;
    permissive: boolean;
    policyname: string;
    qual: string | null;
    roles: string[];
    tablename: string;
    with_check: string | null;
  }>(
    `SELECT relation.relname AS tablename,
            policy.polname AS policyname,
            policy.polpermissive AS permissive,
            ARRAY(
              SELECT role.rolname
                FROM unnest(policy.polroles) AS role_oid
                JOIN pg_roles AS role ON role.oid = role_oid
               ORDER BY role.rolname
            )::text[] AS roles,
            CASE policy.polcmd
              WHEN 'r' THEN 'SELECT'
              WHEN 'a' THEN 'INSERT'
              WHEN 'w' THEN 'UPDATE'
              WHEN 'd' THEN 'DELETE'
              ELSE 'ALL'
            END AS cmd,
            pg_get_expr(policy.polqual, policy.polrelid, true) AS qual,
            pg_get_expr(policy.polwithcheck, policy.polrelid, true) AS with_check
       FROM pg_policy AS policy
       JOIN pg_class AS relation ON relation.oid = policy.polrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_module'
      ORDER BY relation.relname, policy.polname`,
  );
  const actualPolicies = policies.rows.map((policy) => ({
    command: policy.cmd,
    name: policy.policyname,
    permissive: policy.permissive,
    qual: normalizePolicyExpression(policy.qual),
    roles: policy.roles,
    tableName: policy.tablename,
    withCheck: normalizePolicyExpression(policy.with_check),
  }));
  compareCatalogCollection(
    drift,
    'managed policy',
    buildExpectedPolicies(expectedTables),
    actualPolicies,
    (value) => `${value.tableName}.${value.name}`,
  );
  for (const policy of actualPolicies) {
    if (!['SELECT', 'INSERT', 'UPDATE'].includes(policy.command)) {
      drift.push(`delete-capable policy ${policy.tableName}.${policy.name}`);
    }
  }

  const tableGrants = await client.query<{
    grantee: string;
    is_grantable: boolean;
    privilege_type: string;
    table_name: string;
  }>(
    `SELECT relation.relname AS table_name,
            COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(
         COALESCE(relation.relacl, acldefault('r', relation.relowner))
       ) AS privilege
       LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relkind IN ('r','p')
      ORDER BY relation.relname, grantee, privilege.privilege_type`,
  );
  const actualTableGrants = tableGrants.rows.map((grant) => ({
    grantee: grant.grantee,
    isGrantable: grant.is_grantable,
    privilegeType: grant.privilege_type,
    tableName: grant.table_name,
  }));
  compareCatalogCollection(
    drift,
    'managed table grant',
    buildExpectedTableGrants(expectedTables),
    actualTableGrants,
    (value) => `${value.tableName}.${value.grantee}.${value.privilegeType}`,
  );
  for (const grant of actualTableGrants) {
    if (
      ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].includes(
        grant.privilegeType,
      )
    ) {
      drift.push(
        `destructive table privilege ${grant.privilegeType} on ${grant.tableName} to ${grant.grantee}`,
      );
    }
  }

  const columnGrants = await client.query<{
    column_name: string;
    grantee: string;
    is_grantable: boolean;
    privilege_type: string;
    table_name: string;
  }>(
    `SELECT relation.relname AS table_name,
            attribute.attname AS column_name,
            COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_attribute AS attribute
       JOIN pg_class AS relation ON relation.oid = attribute.attrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN LATERAL aclexplode(attribute.attacl) AS privilege
       LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relkind IN ('r','p')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY relation.relname, attribute.attname, grantee,
               privilege.privilege_type`,
  );
  const actualColumnGrants = columnGrants.rows.map((grant) => ({
    columnName: grant.column_name,
    grantee: grant.grantee,
    isGrantable: grant.is_grantable,
    privilegeType: grant.privilege_type,
    tableName: grant.table_name,
  }));
  compareCatalogCollection(
    drift,
    'managed column grant',
    [],
    actualColumnGrants,
    (value) =>
      `${value.tableName}.${value.columnName}.${value.grantee}.${value.privilegeType}`,
  );

  const functions = await client.query<{
    arguments: string;
    kind: string;
    name: string;
    owner: string;
  }>(
    `SELECT routine.proname AS name,
            pg_get_function_identity_arguments(routine.oid) AS arguments,
            routine.prokind AS kind,
            pg_get_userbyid(routine.proowner) AS owner
       FROM pg_proc AS routine
       JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'north_star_module'
      ORDER BY routine.proname, arguments`,
  );
  compareCatalogCollection(
    drift,
    'managed function',
    [],
    functions.rows,
    (value) => `${value.name}(${value.arguments})`,
  );

  const triggers = await client.query<{
    definition: string;
    name: string;
    table_name: string;
  }>(
    `SELECT relation.relname AS table_name,
            trigger_record.tgname AS name,
            pg_get_triggerdef(trigger_record.oid, true) AS definition
       FROM pg_trigger AS trigger_record
       JOIN pg_class AS relation ON relation.oid = trigger_record.tgrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_module'
        AND NOT trigger_record.tgisinternal
      ORDER BY relation.relname, trigger_record.tgname`,
  );
  compareCatalogCollection(
    drift,
    'managed trigger',
    [],
    triggers.rows,
    (value) => `${value.table_name}.${value.name}`,
  );
  for (const trigger of triggers.rows) {
    drift.push(
      `delete-capable trigger seam ${trigger.table_name}.${trigger.name}`,
    );
  }

  const rules = await client.query<{
    definition: string;
    name: string;
    table_name: string;
  }>(
    `SELECT relation.relname AS table_name,
            rule.rulename AS name,
            pg_get_ruledef(rule.oid, true) AS definition
       FROM pg_rewrite AS rule
       JOIN pg_class AS relation ON relation.oid = rule.ev_class
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_module'
      ORDER BY relation.relname, rule.rulename`,
  );
  compareCatalogCollection(
    drift,
    'managed rule',
    [],
    rules.rows,
    (value) => `${value.table_name}.${value.name}`,
  );
  for (const rule of rules.rows) {
    drift.push(`delete-capable rule seam ${rule.table_name}.${rule.name}`);
  }

  const types = await client.query<{
    kind: string;
    name: string;
    owner: string;
  }>(
    `SELECT type_record.typname AS name,
            type_record.typtype AS kind,
            pg_get_userbyid(type_record.typowner) AS owner
       FROM pg_type AS type_record
       JOIN pg_namespace AS namespace ON namespace.oid = type_record.typnamespace
       LEFT JOIN pg_class AS relation ON relation.oid = type_record.typrelid
      WHERE namespace.nspname = 'north_star_module'
        AND type_record.typelem = 0
        AND (type_record.typrelid = 0 OR relation.relkind = 'c')
      ORDER BY type_record.typname`,
  );
  compareCatalogCollection(
    drift,
    'managed standalone type',
    [],
    types.rows,
    (value) => value.name,
  );

  const digest = new Uint8Array(
    createHash('sha256')
      .update('northstar.module-storage-live-catalog/v1')
      .update('\0')
      .update(
        canonicalize({
          columns: columns.rows,
          columnGrants: actualColumnGrants,
          constraints: actualConstraints,
          functions: functions.rows,
          indexes: actualIndexes,
          relations: relations.rows,
          registry,
          drift,
          policies: actualPolicies,
          rules: rules.rows,
          schema,
          schemaGrants: schemaGrants.rows,
          tableGrants: actualTableGrants,
          triggers: triggers.rows,
          types: types.rows,
        }),
      )
      .digest(),
  );
  return Object.freeze({ digest, drift: Object.freeze(drift.toSorted()) });
}

type StorageRelationTarget = StorageTargetPayloadV1['relations'][number];

interface ExpectedColumnShape {
  defaultExpression: string | null;
  generatedKind: string;
  identityKind: string;
  name: string;
  nullable: boolean;
  postgresqlType: string;
  tableName: string;
}

interface ExpectedConstraintShape {
  columns: string[];
  deferred: boolean;
  deferrable: boolean;
  deleteAction: string;
  name: string;
  referencedColumns: string[] | null;
  referencedSchema: string | null;
  referencedTable: string | null;
  tableName: string;
  type: string;
  updateAction: string;
  validated: boolean;
}

interface ExpectedIndexShape {
  columns: string[];
  constraintName: string | null;
  definition: string;
  name: string;
  owner: string;
  predicate: string | null;
  primary: boolean;
  ready: boolean;
  tableName: string;
  unique: boolean;
  valid: boolean;
}

async function loadObjectOwnershipRegistry(
  client: PoolClient,
): Promise<
  Array<{ object_kind: string; object_name: string; schema_name: string }>
> {
  const result = await client.query<{
    object_kind: string;
    object_name: string;
    schema_name: string;
  }>(
    `WITH registry AS (
       SELECT namespace.nspname AS schema_name,
              relation.relname AS object_name,
              CASE relation.relkind
                WHEN 'r' THEN 'table'
                WHEN 'p' THEN 'partitioned_table'
                WHEN 'i' THEN 'index'
                WHEN 'I' THEN 'partitioned_index'
                WHEN 'S' THEN 'sequence'
                WHEN 'v' THEN 'view'
                WHEN 'm' THEN 'materialized_view'
                WHEN 'c' THEN 'composite_relation'
                WHEN 'f' THEN 'foreign_table'
                ELSE 'unknown:relation:' || relation.relkind::text
              END AS object_kind
         FROM pg_class AS relation
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname,
              relation.relname || '.' || attribute.attname,
              'column'
         FROM pg_attribute AS attribute
         JOIN pg_class AS relation ON relation.oid = attribute.attrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND relation.relkind IN ('r','p','v','m','f')
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
       UNION ALL
       SELECT namespace.nspname,
              relation.relname || '.' || attribute.attname,
              'default'
         FROM pg_attrdef AS default_value
         JOIN pg_class AS relation ON relation.oid = default_value.adrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         JOIN pg_attribute AS attribute
           ON attribute.attrelid = relation.oid
          AND attribute.attnum = default_value.adnum
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname,
              relation.relname || '.' || constraint_record.conname,
              CASE constraint_record.contype
                WHEN 'c' THEN 'constraint:check'
                WHEN 'f' THEN 'constraint:foreign_key'
                WHEN 'n' THEN 'constraint:not_null'
                WHEN 'p' THEN 'constraint:primary_key'
                WHEN 'u' THEN 'constraint:unique'
                WHEN 'x' THEN 'constraint:exclusion'
                WHEN 't' THEN 'constraint:trigger'
                ELSE 'unknown:constraint:' || constraint_record.contype::text
              END
         FROM pg_constraint AS constraint_record
         JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname,
              relation.relname || '.' || policy.polname,
              'policy'
         FROM pg_policy AS policy
         JOIN pg_class AS relation ON relation.oid = policy.polrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname,
              routine.proname || '(' || pg_get_function_identity_arguments(routine.oid) || ')',
              CASE routine.prokind
                WHEN 'f' THEN 'function'
                WHEN 'p' THEN 'procedure'
                WHEN 'a' THEN 'aggregate'
                WHEN 'w' THEN 'window_function'
                ELSE 'unknown:routine:' || routine.prokind::text
              END
         FROM pg_proc AS routine
         JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname,
              relation.relname || '.' || trigger_record.tgname,
              'trigger'
         FROM pg_trigger AS trigger_record
         JOIN pg_class AS relation ON relation.oid = trigger_record.tgrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND NOT trigger_record.tgisinternal
       UNION ALL
       SELECT namespace.nspname,
              relation.relname || '.' || rule.rulename,
              'rule'
         FROM pg_rewrite AS rule
         JOIN pg_class AS relation ON relation.oid = rule.ev_class
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname,
              type_record.typname,
              'standalone_type'
         FROM pg_type AS type_record
         JOIN pg_namespace AS namespace ON namespace.oid = type_record.typnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND type_record.typrelid = 0
          AND type_record.typelem = 0
          AND type_record.typtype IN ('c','d','e','m','r')
       UNION ALL
       SELECT namespace.nspname, collation_record.collname, 'unknown:collation'
         FROM pg_collation AS collation_record
         JOIN pg_namespace AS namespace ON namespace.oid = collation_record.collnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname, conversion_record.conname, 'unknown:conversion'
         FROM pg_conversion AS conversion_record
         JOIN pg_namespace AS namespace ON namespace.oid = conversion_record.connamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname,
              operator_record.oprname || '(' ||
                pg_get_userbyid(operator_record.oprowner) || ')',
              'unknown:operator'
         FROM pg_operator AS operator_record
         JOIN pg_namespace AS namespace ON namespace.oid = operator_record.oprnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname, operator_class.opcname, 'unknown:operator_class'
         FROM pg_opclass AS operator_class
         JOIN pg_namespace AS namespace ON namespace.oid = operator_class.opcnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname, operator_family.opfname, 'unknown:operator_family'
         FROM pg_opfamily AS operator_family
         JOIN pg_namespace AS namespace ON namespace.oid = operator_family.opfnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname, statistics_record.stxname, 'unknown:statistics'
         FROM pg_statistic_ext AS statistics_record
         JOIN pg_namespace AS namespace ON namespace.oid = statistics_record.stxnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname, configuration.cfgname,
              'unknown:text_search_configuration'
         FROM pg_ts_config AS configuration
         JOIN pg_namespace AS namespace ON namespace.oid = configuration.cfgnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname, dictionary.dictname,
              'unknown:text_search_dictionary'
         FROM pg_ts_dict AS dictionary
         JOIN pg_namespace AS namespace ON namespace.oid = dictionary.dictnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname, parser.prsname, 'unknown:text_search_parser'
         FROM pg_ts_parser AS parser
         JOIN pg_namespace AS namespace ON namespace.oid = parser.prsnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
       UNION ALL
       SELECT namespace.nspname, template.tmplname,
              'unknown:text_search_template'
         FROM pg_ts_template AS template
         JOIN pg_namespace AS namespace ON namespace.oid = template.tmplnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
     )
     SELECT schema_name, object_name, object_kind
       FROM registry
      ORDER BY schema_name, object_kind, object_name`,
  );
  return result.rows;
}

function compareCatalogCollection<T>(
  drift: string[],
  label: string,
  expected: readonly T[],
  actual: readonly T[],
  keyOf: (value: T) => string,
): void {
  const expectedByKey = uniqueCatalogMap(
    drift,
    `expected ${label}`,
    expected,
    keyOf,
  );
  const actualByKey = uniqueCatalogMap(drift, `actual ${label}`, actual, keyOf);
  for (const [key, expectedValue] of expectedByKey) {
    const actualValue = actualByKey.get(key);
    if (!actualValue) {
      drift.push(`missing ${label} ${key}`);
    } else if (canonicalize(expectedValue) !== canonicalize(actualValue)) {
      drift.push(`altered ${label} ${key}`);
    }
  }
  for (const key of actualByKey.keys()) {
    if (!expectedByKey.has(key)) drift.push(`surplus ${label} ${key}`);
  }
}

function uniqueCatalogMap<T>(
  drift: string[],
  label: string,
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) drift.push(`multiply owned ${label} ${key}`);
    else result.set(key, value);
  }
  return result;
}

function mergeExpectedRelations(
  targets: readonly StorageTargetPayloadV1[],
): Map<string, StorageRelationTarget> {
  const result = new Map<string, StorageRelationTarget>();
  for (const relation of targets.flatMap((target) => target.relations)) {
    const key = relation.foreignKey.physicalName;
    const existing = result.get(key);
    if (existing && canonicalize(existing) !== canonicalize(relation)) {
      throw failure(
        'LIVE_SET_SHAPE_CONFLICT',
        `conflicting live roots claim managed relation ${key}`,
      );
    }
    result.set(key, relation);
  }
  return result;
}

function buildExpectedColumns(
  tables: ReadonlyMap<string, StorageEntityTarget>,
  relations: ReadonlyMap<string, StorageRelationTarget>,
): ExpectedColumnShape[] {
  const result = new Map<string, ExpectedColumnShape>();
  const entityById = new Map(
    [...tables.values()].map((entity) => [entity.entityId, entity]),
  );
  const add = (shape: ExpectedColumnShape) => {
    const key = `${shape.tableName}.${shape.name}`;
    const prior = result.get(key);
    if (prior && canonicalize(prior) !== canonicalize(shape)) {
      throw failure('LIVE_SET_SHAPE_CONFLICT', `conflicting column ${key}`);
    }
    result.set(key, shape);
  };
  for (const entity of tables.values()) {
    const base = (
      name: string,
      postgresqlType: string,
      nullable: boolean,
      defaultExpression: string | null = null,
    ) =>
      add({
        defaultExpression,
        generatedKind: '',
        identityKind: '',
        name,
        nullable,
        postgresqlType: catalogType(postgresqlType),
        tableName: entity.physicalTableName,
      });
    base('tenant_id', 'uuid', false);
    base('environment_id', 'uuid', false);
    base(
      entity.recordIdentity.column,
      entity.recordIdentity.postgresqlType,
      false,
    );
    base(
      entity.optimisticRevision.column,
      entity.optimisticRevision.postgresqlType,
      false,
      normalizeSqlExpressionRequired(entity.optimisticRevision.initialValue),
    );
    base(entity.archive.archivedAtColumn, 'timestamp with time zone', true);
    for (const column of entity.columns) {
      base(
        column.physicalName,
        column.postgresqlType,
        column.nullable,
        expectedDefaultExpression(
          column.defaultSemantics,
          column.defaultValue,
          column.postgresqlType,
        ),
      );
    }
    for (const column of entity.derivedStateFields) {
      base(column.physicalName, column.postgresqlType, true);
    }
  }
  for (const relation of relations.values()) {
    const entity = entityById.get(relation.sourceEntityId);
    if (!entity) {
      throw failure('ENTITY_TARGET_MISSING', relation.sourceEntityId);
    }
    add({
      defaultExpression: null,
      generatedKind: '',
      identityKind: '',
      name: relation.relationColumn.physicalName,
      nullable: relation.relationColumn.nullable,
      postgresqlType: catalogType(relation.relationColumn.postgresqlType),
      tableName: entity.physicalTableName,
    });
  }
  return [...result.values()].toSorted((left, right) =>
    `${left.tableName}.${left.name}`.localeCompare(
      `${right.tableName}.${right.name}`,
    ),
  );
}

function buildExpectedConstraints(
  tables: ReadonlyMap<string, StorageEntityTarget>,
  relations: ReadonlyMap<string, StorageRelationTarget>,
): ExpectedConstraintShape[] {
  const entityById = new Map(
    [...tables.values()].map((entity) => [entity.entityId, entity]),
  );
  const result: ExpectedConstraintShape[] = [...tables.values()].map(
    (entity) => ({
      columns: [...entity.primaryKey.columns],
      deferred: false,
      deferrable: false,
      deleteAction: ' ',
      name: entity.primaryKey.physicalName,
      referencedColumns: null,
      referencedSchema: null,
      referencedTable: null,
      tableName: entity.physicalTableName,
      type: 'p',
      updateAction: ' ',
      validated: true,
    }),
  );
  for (const relation of relations.values()) {
    const source = entityById.get(relation.sourceEntityId);
    const target = entityById.get(relation.targetEntityId);
    if (!source || !target) {
      throw failure('ENTITY_TARGET_MISSING', relation.relationId);
    }
    result.push({
      columns: [...relation.foreignKey.sourceColumns],
      deferred: false,
      deferrable: false,
      deleteAction: 'r',
      name: relation.foreignKey.physicalName,
      referencedColumns: [...relation.foreignKey.targetColumns],
      referencedSchema: 'north_star_module',
      referencedTable: target.physicalTableName,
      tableName: source.physicalTableName,
      type: 'f',
      updateAction: 'r',
      validated: true,
    });
  }
  return result.toSorted((left, right) =>
    `${left.tableName}.${left.name}`.localeCompare(
      `${right.tableName}.${right.name}`,
    ),
  );
}

function buildExpectedIndexes(
  tables: ReadonlyMap<string, StorageEntityTarget>,
): ExpectedIndexShape[] {
  const result: ExpectedIndexShape[] = [];
  for (const entity of tables.values()) {
    result.push({
      columns: [...entity.primaryKey.columns],
      constraintName: entity.primaryKey.physicalName,
      definition: expectedIndexDefinition(
        entity.physicalTableName,
        entity.primaryKey.physicalName,
        entity.primaryKey.columns,
        true,
      ),
      name: entity.primaryKey.physicalName,
      owner: 'north_star_module_materializer',
      predicate: null,
      primary: true,
      ready: true,
      tableName: entity.physicalTableName,
      unique: true,
      valid: true,
    });
    for (const unique of entity.uniqueKeys) {
      result.push({
        columns: [...unique.columns],
        constraintName: null,
        definition: expectedIndexDefinition(
          entity.physicalTableName,
          unique.physicalName,
          unique.columns,
          true,
        ),
        name: unique.physicalName,
        owner: 'north_star_module_materializer',
        predicate: null,
        primary: false,
        ready: true,
        tableName: entity.physicalTableName,
        unique: true,
        valid: true,
      });
    }
    for (const index of entity.indexes) {
      result.push({
        columns: [...index.columnNames],
        constraintName: null,
        definition: expectedIndexDefinition(
          entity.physicalTableName,
          index.physicalName,
          index.columnNames,
          index.indexKind === 'caseInsensitiveUnique',
        ),
        name: index.physicalName,
        owner: 'north_star_module_materializer',
        predicate: null,
        primary: false,
        ready: true,
        tableName: entity.physicalTableName,
        unique: index.indexKind === 'caseInsensitiveUnique',
        valid: true,
      });
    }
  }
  return result.toSorted((left, right) =>
    `${left.tableName}.${left.name}`.localeCompare(
      `${right.tableName}.${right.name}`,
    ),
  );
}

function expectedIndexDefinition(
  tableName: string,
  indexName: string,
  columns: readonly string[],
  unique: boolean,
): string {
  return normalizeSqlExpressionRequired(
    `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${indexName}
       ON north_star_module.${tableName} USING btree (${columns.join(', ')})`,
  );
}

function buildExpectedPolicies(
  tables: ReadonlyMap<string, StorageEntityTarget>,
) {
  const predicate = normalizePolicyExpression(
    `tenant_id = north_star_internal.trusted_tenant_id()
     AND environment_id = north_star_internal.trusted_environment_id()`,
  );
  return [...tables.keys()].flatMap((tableName) =>
    (['SELECT', 'INSERT', 'UPDATE'] as const).map((command) => ({
      command,
      name: managedPolicyName(tableName, command),
      permissive: true,
      qual: command === 'INSERT' ? null : predicate,
      roles: ['north_star_module_runtime'],
      tableName,
      withCheck: command === 'SELECT' ? null : predicate,
    })),
  );
}

function buildExpectedTableGrants(
  tables: ReadonlyMap<string, StorageEntityTarget>,
) {
  return [...tables.keys()].flatMap((tableName) =>
    ['north_star_module_materializer', 'north_star_module_runtime'].flatMap(
      (grantee) =>
        ['INSERT', 'SELECT', 'UPDATE'].map((privilegeType) => ({
          grantee,
          isGrantable: false,
          privilegeType,
          tableName,
        })),
    ),
  );
}

function managedPolicyName(
  tableName: string,
  command: 'INSERT' | 'SELECT' | 'UPDATE',
): string {
  return `nsm_p_${createHash('sha256')
    .update(tableName)
    .update('\0')
    .update(command)
    .digest('hex')
    .slice(0, 32)}`;
}

function catalogType(postgresqlType: string): string {
  return postgresqlType.replace(/^varchar\(/, 'character varying(');
}

function expectedDefaultExpression(
  semantics: string,
  value: unknown,
  postgresqlType: string,
): string | null {
  if (semantics !== 'declaredDefault') return null;
  const scalar = databaseDefaultValue(value);
  if (typeof scalar === 'string') {
    const castType = catalogType(postgresqlType).replace(/\([0-9,]+\)$/, '');
    return normalizeSqlExpressionRequired(
      `'${scalar.replaceAll("'", "''")}'::${castType}`,
    );
  }
  if (typeof scalar === 'boolean') {
    return scalar ? 'true' : 'false';
  }
  if (typeof scalar === 'number' && Number.isFinite(scalar)) {
    return String(scalar);
  }
  throw failure('DECLARED_DEFAULT_REJECTED', 'default is not a closed scalar');
}

function normalizeSqlExpression(value: string | null): string | null {
  return value === null ? null : normalizeSqlExpressionRequired(value);
}

function normalizeSqlExpressionRequired(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replaceAll('"', '');
}

function normalizePolicyExpression(value: string | null): string | null {
  return value === null
    ? null
    : normalizeSqlExpressionRequired(value).replace(/[()\s]/g, '');
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
    `SELECT release_id
       FROM north_star_internal.module_storage_read_kernel_live_roots($1, $2)
     UNION
     SELECT generation.target_release_id
       FROM north_star_internal.module_storage_generations AS generation
      WHERE generation.tenant_id = $1 AND generation.environment_id = $2
        AND generation.state IN (
          'PREPARING', 'PREPARED', 'IN_ATTEMPT', 'READY_TO_SWAP', 'RECONCILING'
        )
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
    authorized: boolean;
    denied: boolean;
    paused: boolean;
  }>(
    `SELECT authorized, denied, paused
       FROM north_star_internal.module_storage_read_preparation_authority($1, $2, $3)`,
    [
      command.context.tenantId,
      command.context.environmentId,
      command.initiatedBy,
    ],
  );
  return {
    authorized: result.rows[0]?.authorized ?? false,
    denied: result.rows[0]?.denied ?? false,
    paused: result.rows[0]?.paused ?? false,
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

async function acquireGenerationSessionLock(
  client: PoolClient,
  generationId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_lock(
       hashtext('north-star:module-storage-generation:v1'), hashtext($1)
     )`,
    [generationId],
  );
}

async function releaseGenerationSessionLockQuietly(
  client: PoolClient,
  generationId: string,
): Promise<void> {
  try {
    await client.query(
      `SELECT pg_advisory_unlock(
         hashtext('north-star:module-storage-generation:v1'), hashtext($1)
       )`,
      [generationId],
    );
  } catch {
    /* connection loss releases session locks on the server */
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
        AND state IN ('PREPARED', 'IN_ATTEMPT', 'RECONCILING', 'READY_TO_SWAP')
      FOR UPDATE`,
    [
      command.context.tenantId,
      command.context.environmentId,
      command.generationId,
    ],
    'prepared module storage generation',
  );
}

async function assertApprovedAttempt(
  client: PoolClient,
  command: ExecuteModuleStorageAttemptCommand,
  preparationId: string,
): Promise<void> {
  const approved = await client.query<{ approved: boolean }>(
    `SELECT approved
       FROM north_star_internal.module_storage_read_approved_attempt(
         $1, $2, $3, $4
       )`,
    [
      command.context.tenantId,
      command.context.environmentId,
      command.activationAttemptId,
      preparationId,
    ],
  );
  if (approved.rowCount !== 1 || !approved.rows[0]?.approved) {
    throw failure(
      'ATTEMPT_NOT_AUTHORIZED',
      'claim and execution require one current unconsumed v2 approved attempt',
    );
  }
}

async function hasAppliedAttemptElement(
  client: PoolClient,
  command: ExecuteModuleStorageAttemptCommand,
  element: StorageTransitionElement,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM north_star_internal.module_storage_element_applications
        WHERE tenant_id = $1 AND environment_id = $2
          AND generation_id = $3 AND element_id = $4
          AND attempt_id = $5 AND application_state = 'APPLIED'
     ) AS present`,
    [
      command.context.tenantId,
      command.context.environmentId,
      command.generationId,
      element.elementId,
      command.activationAttemptId,
    ],
  );
  return result.rows[0]?.present === true;
}

async function loadCompletedAttemptReceipt(
  client: PoolClient,
  command: ExecuteModuleStorageAttemptCommand,
  generation: GenerationRow,
): Promise<ModuleStorageCatalogReceipt | null> {
  const result = await client.query<CatalogReceiptRow>(
    `SELECT receipt.*
       FROM north_star_internal.module_storage_attempt_claims AS claim
       JOIN LATERAL (
         SELECT candidate.*
           FROM north_star_internal.module_storage_catalog_receipts AS candidate
          WHERE candidate.tenant_id = claim.tenant_id
            AND candidate.environment_id = claim.environment_id
            AND candidate.generation_id = claim.generation_id
            AND candidate.receipt_state = 'READY_TO_SWAP'
            AND candidate.catalog_verified
          ORDER BY candidate.recorded_at DESC, candidate.receipt_id DESC
          LIMIT 1
       ) AS receipt ON true
      WHERE claim.tenant_id = $1 AND claim.environment_id = $2
        AND claim.generation_id = $3 AND claim.activation_attempt_id = $4
        AND claim.claim_state = 'COMPLETED'`,
    [
      command.context.tenantId,
      command.context.environmentId,
      command.generationId,
      command.activationAttemptId,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (
    row.receipt_version !== MODULE_STORAGE_CATALOG_RECEIPT_VERSION ||
    row.tenant_id !== generation.tenant_id ||
    row.environment_id !== generation.environment_id ||
    row.generation_id !== generation.generation_id ||
    row.source_release_id !== generation.source_release_id ||
    row.target_release_id !== generation.target_release_id ||
    !equalBytes(row.source_manifest_root, generation.source_manifest_root) ||
    !equalBytes(row.target_manifest_root, generation.target_manifest_root) ||
    !equalBytes(
      row.prepared_subset_digest,
      generation.prepared_subset_digest,
    ) ||
    !equalBytes(row.remaining_plan_digest, generation.remaining_plan_digest)
  ) {
    throw failure(
      'READY_RECEIPT_BINDING_MISMATCH',
      'completed claim receipt does not bind the durable generation',
    );
  }
  return Object.freeze({
    catalogDigest: new Uint8Array(row.catalog_digest),
    catalogVerified: row.catalog_verified,
    createdAt: new Date(row.recorded_at).toISOString(),
    environmentId: row.environment_id,
    generationId: row.generation_id as never,
    preparedSubsetDigest: new Uint8Array(row.prepared_subset_digest),
    receiptId: row.receipt_id as never,
    receiptVersion: MODULE_STORAGE_CATALOG_RECEIPT_VERSION,
    remainingPlanDigest: new Uint8Array(row.remaining_plan_digest),
    sourceManifestRoot: new Uint8Array(row.source_manifest_root),
    sourceReleaseId: row.source_release_id as never,
    state: row.receipt_state,
    targetManifestRoot: new Uint8Array(row.target_manifest_root),
    targetReleaseId: row.target_release_id as never,
    tenantId: row.tenant_id,
  });
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
        WHERE tenant_id = $1 AND environment_id = $2 AND generation_id = $3
          AND state IN ('PREPARED', 'IN_ATTEMPT', 'RECONCILING')`,
      [
        command.context.tenantId,
        command.context.environmentId,
        command.generationId,
      ],
    );
    await client.query(
      `UPDATE north_star_internal.module_storage_attempt_claims
          SET claim_state = 'RECONCILING', updated_at = transaction_timestamp()
        WHERE tenant_id = $1 AND environment_id = $2
          AND generation_id = $3 AND activation_attempt_id = $4
          AND claim_state IN ('CLAIMED', 'RECONCILING')`,
      [
        command.context.tenantId,
        command.context.environmentId,
        command.generationId,
        command.activationAttemptId,
      ],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
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

function defaultSql(
  semantics: string,
  value: unknown,
  postgresqlType: string,
): string {
  if (semantics !== 'declaredDefault') return '';
  const scalar = databaseDefaultValue(value);
  if (typeof scalar === 'string') {
    return ` DEFAULT '${scalar.replaceAll("'", "''")}'::${safeType(postgresqlType)}`;
  }
  if (typeof scalar === 'boolean')
    return ` DEFAULT ${scalar ? 'true' : 'false'}`;
  if (typeof scalar === 'number' && Number.isFinite(scalar))
    return ` DEFAULT ${String(scalar)}`;
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

const resumableDatabaseErrorCodes = new Set([
  '40001',
  '40P01',
  '55P03',
  '57014',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '53400',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

export function isAmbiguousModuleStorageDatabaseError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((nested) =>
      isAmbiguousModuleStorageDatabaseError(nested),
    );
  }
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string') {
    if (code.startsWith('08') || resumableDatabaseErrorCodes.has(code)) {
      return true;
    }
  }
  return /(?:connection terminated due to connection timeout|timeout exceeded when trying to connect|(?:connection|socket) (?:ended|closed|lost|terminated|was terminated) unexpectedly)/i.test(
    error.message,
  );
}

function failure(
  code: string,
  message: string,
): ModuleStorageMaterializationError {
  return new ModuleStorageMaterializationError(code, message);
}
