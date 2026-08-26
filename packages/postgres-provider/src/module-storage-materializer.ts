import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  UNICODE_CASE_FOLD_EXPANSIONS,
  UNICODE_CASE_FOLD_SIMPLE_SOURCES,
  UNICODE_CASE_FOLD_SIMPLE_TARGETS,
  canonicalize,
} from '@north-star/canonical-model';
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
import {
  assertTrustedRequestContext,
  type TrustedRequestContext,
} from '@north-star/runtime';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { aggregateGenerationLockKey } from './module-runtime-interpreter.js';

const sha256Pattern = /^[0-9a-f]{64}$/;
const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/;
const storageTargetPayloadV2Version: Exclude<
  StorageTargetPayloadV1['schemaVersion'],
  typeof STORAGE_TARGET_PAYLOAD_VERSION
> = 'northstar.storage-target-payload/v2';
const storageTargetPayloadV3Version: Exclude<
  StorageTargetPayloadV1['schemaVersion'],
  typeof STORAGE_TARGET_PAYLOAD_VERSION
> = 'northstar.storage-target-payload/v3';
const unicodeCaseFoldFunctionName = 'nsm_unicode_case_fold_v1';
const postedStockBalanceFunctionName = 'nsm_posted_stock_balance_v1';
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
const catalogVerifiedObjectKinds = new Set([
  'column',
  'composite_relation',
  'constraint:check',
  'constraint:exclusion',
  'constraint:foreign_key',
  'constraint:not_null',
  'constraint:primary_key',
  'constraint:trigger',
  'constraint:unique',
  'default',
  'foreign_table',
  'function',
  'index',
  'materialized_view',
  'partitioned_index',
  'partitioned_table',
  'policy',
  'procedure',
  'rule',
  'sequence',
  'standalone_type',
  'table',
  'trigger',
  'view',
]);

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
  readonly deferredOnlineFamilyElementsProcessed: number | null;
  readonly disposition: 'READY_TO_SWAP' | 'RECONCILING';
  readonly receipt: ModuleStorageCatalogReceipt | null;
}

export interface PostedStockBalanceRebuildResult {
  readonly movementCount: number;
  readonly rowCount: number;
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

interface AllowedMissingCatalogObjects {
  readonly columns: ReadonlySet<string>;
  readonly indexes: ReadonlySet<string>;
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
      if (
        source.target.entities.length > 0 ||
        target.target.entities.length > 0
      ) {
        await ensureUnicodeCaseFoldFunction(client);
      }

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
      await ensurePostedStockBalanceProjection(
        client,
        target.target,
        command.context,
      );
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
        new Map(
          remaining
            .filter(
              (element) =>
                element.classification.preparationValidity === 'inAttemptOnly',
            )
            .map((element) => [element.physicalObjectName, element.elementId]),
        ),
        allowedMissingDeferredOnlineObjects(target.target, remaining),
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
        dataState: remaining.some((element) =>
          executesInApprovedAttempt(element),
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
    let deferredOnlineFamilyElementsProcessed: number | null = null;
    try {
      await assertMaterializerSession(client);
      await acquireGenerationSessionLock(client, command.generationId);
      generationLockHeld = true;
      await beginLocked(client);
      await setMaterializerScope(client, command.context);
      const generation = await loadGeneration(client, command);
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
      deferredOnlineFamilyElementsProcessed = transition.elements.filter(
        (element) =>
          element.classification.preparationValidity === 'deferredOnlineFamily',
      ).length;
      const completed = await loadCompletedAttemptReceipt(
        client,
        command,
        generation,
      );
      if (completed) {
        await client.query('COMMIT');
        return {
          deferredOnlineFamilyElementsProcessed,
          disposition: 'READY_TO_SWAP',
          receipt: completed,
        };
      }
      if (generation.state === 'READY_TO_SWAP') {
        throw failure(
          'ATTEMPT_READY_EVIDENCE_MISSING',
          'ready generation is missing its completed claim and receipt',
        );
      }
      await assertApprovedAttempt(client, command, generation.preparation_id);
      if (
        source.target.entities.length > 0 ||
        target.target.entities.length > 0
      ) {
        await ensureUnicodeCaseFoldFunction(client);
      }
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
      await client.query(
        `UPDATE north_star_internal.module_storage_generations
            SET state = 'IN_ATTEMPT'
          WHERE generation_id = $1
            AND state IN ('PREPARED', 'IN_ATTEMPT', 'RECONCILING')`,
        [command.generationId],
      );
      await client.query('COMMIT');
      await this.faultHooks.afterClaimCommitted?.();

      for (const element of transition.elements.filter((candidate) =>
        executesInApprovedAttempt(candidate),
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
            await appendApplication(
              client,
              command,
              element,
              'STARTED',
              command.activationAttemptId,
            );
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
      return {
        deferredOnlineFamilyElementsProcessed,
        disposition: 'READY_TO_SWAP',
        receipt,
      };
    } catch (error) {
      await rollbackQuietly(client);
      if (isAmbiguousModuleStorageDatabaseError(error)) {
        try {
          await recordReconciling(this.materializerPool, command);
        } catch {
          /* unavailable databases retain the durable claim/checkpoint for retry */
        }
        return {
          deferredOnlineFamilyElementsProcessed: null,
          disposition: 'RECONCILING',
          receipt: null,
        };
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

  /**
   * Rebuilds only the derived posted-stock rows for the trusted tenant and
   * environment. The movement ledger remains untouched. The same advisory
   * generation lock used by posting and aggregate reads pins the ledger while
   * the projection is replaced.
   */
  async rebuildPostedStockBalances(
    context: TrustedRequestContext,
  ): Promise<PostedStockBalanceRebuildResult> {
    const client = await this.materializerPool.connect();
    try {
      assertTrustedRequestContext(context);
      await assertMaterializerSession(client);
      await beginLocked(client);
      await setMaterializerScope(client, context);
      const pointer = await requiredOne<{ release_id: string | null }>(
        client,
        `SELECT release_id
           FROM north_star_internal.module_storage_read_active_release_pointer($1, $2)`,
        [context.tenantId, context.environmentId],
        'active release pointer',
      );
      if (!pointer.release_id) {
        throw failure(
          'POSTED_STOCK_BALANCE_RELEASE_MISSING',
          'posted-stock rebuild requires an active release',
        );
      }
      const release = await loadVerifiedReleaseStorage(
        client,
        context.tenantId,
        context.environmentId,
        pointer.release_id,
      );
      const result = await rebuildPostedStockBalanceOnClient(
        client,
        release.target,
        context,
      );
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
  const hasInventoryFactTarget =
    Array.isArray(target.entities) &&
    target.entities.some((entity) => entity.factStorage !== undefined);
  const hasEntityOwnedTarget =
    Array.isArray(target.entities) &&
    target.entities.some((entity) => entity.legalEntity !== undefined);
  const expectedStorageTargetPayloadVersion = hasInventoryFactTarget
    ? storageTargetPayloadV3Version
    : hasEntityOwnedTarget
      ? storageTargetPayloadV2Version
      : STORAGE_TARGET_PAYLOAD_VERSION;
  if (
    target.kind !== 'storageTargetPayload' ||
    !Array.isArray(target.entities) ||
    target.schemaVersion !== expectedStorageTargetPayloadVersion ||
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
    case 'createPartition': {
      const located = locateFactPartition(target, element);
      await client.query(
        `CREATE TABLE IF NOT EXISTS north_star_module.${quoted(located.partition.physicalTableName)}
           PARTITION OF north_star_module.${quoted(located.entity.physicalTableName)}
           FOR VALUES WITH (
             MODULUS ${String(located.partition.modulus)},
             REMAINDER ${String(located.partition.remainder)}
           )`,
      );
      return;
    }
    case 'createCompanionTable': {
      const entity = target.entities.find(
        (candidate) =>
          candidate.factStorage?.companion.physicalTableName ===
          element.physicalObjectName,
      );
      if (!entity?.factStorage) {
        throw failure('ELEMENT_TARGET_MISSING', element.elementId);
      }
      await createFactCompanionTable(client, entity);
      return;
    }
    case 'createRejectMutationTrigger': {
      const located = locateRejectMutationTrigger(target, element);
      await ensureRejectMutationTrigger(
        client,
        located.tableName,
        element.physicalObjectName,
      );
      return;
    }
    case 'addAbiFunctionCheck': {
      await ensureAbiFunctionCheck(client, target, element);
      return;
    }
    case 'addColumn': {
      const folded = locateFoldedColumn(target, element);
      if (folded) {
        await client.query(
          `ALTER TABLE north_star_module.${quoted(folded.entity.physicalTableName)}
             ADD COLUMN IF NOT EXISTS ${quoted(folded.column.physicalName)} text COLLATE "C"
             GENERATED ALWAYS AS (${unicodeCaseFoldSql(quoted(folded.column.sourceColumn))}) STORED`,
        );
        return;
      }
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
      const columns = indexColumnExpressions(located.entity, located.index);
      const predicate = indexPredicateSql(located.entity, located.index);
      await client.query(
        `CREATE ${isUniqueStorageIndex(located.index) ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quoted(located.index.physicalName)}
           ON north_star_module.${quoted(located.entity.physicalTableName)}
           (${columns.join(', ')})${predicate ? ` WHERE ${predicate}` : ''}`,
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
    case 'relaxNotNull': {
      const matches = target.relations.filter(
        (item) =>
          item.relationColumn.physicalName === element.physicalObjectName &&
          item.relationColumn.origin !== 'field',
      );
      const relation = matches.length === 1 ? matches[0] : undefined;
      if (!relation) throw failure('ELEMENT_TARGET_MISSING', element.elementId);
      // The mirror of `addColumn`'s NON_INERT_ADD_COLUMN guard. The target this
      // element is executed against must itself say the column is optional; if
      // it does not, the plan and the payload disagree and the safe move is to
      // refuse rather than to drop a constraint the target still asserts.
      if (!relation.relationColumn.nullable) {
        throw failure('NON_WIDENING_RELAX_NOT_NULL', element.elementId);
      }
      const source = requiredEntity(target, relation.sourceEntityId);
      // `DROP NOT NULL` on an already-nullable column succeeds and changes
      // nothing, so preparation may be replayed without a guard query.
      await client.query(
        `ALTER TABLE north_star_module.${quoted(source.physicalTableName)}
           ALTER COLUMN ${quoted(relation.relationColumn.physicalName)} DROP NOT NULL`,
      );
      return;
    }
    case 'backfill':
      throw failure('BACKFILL_REQUIRES_DML_ROLE', element.elementId);
    case 'addNotValidConstraint':
      {
        const located = locateCheckConstraint(target, element);
        await ensureEnumCheckConstraint(client, located.entity, located.check);
      }
      return;
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
  const postedStockProjection = isPostedStockBalanceEntity(entity);
  const relationColumns = target.relations
    .filter(
      (relation) =>
        relation.sourceEntityId === entity.entityId &&
        relation.relationColumn.origin !== 'field',
    )
    .map((relation) => relation.relationColumn);
  const columns = [
    'tenant_id uuid NOT NULL',
    'environment_id uuid NOT NULL',
    ...(entity.legalEntity
      ? [`${quoted(entity.legalEntity.column)} uuid NOT NULL`]
      : []),
    ...(entity.factStorage
      ? [
          `${quoted(entity.factStorage.businessPeriod.column)} ${safeType(entity.factStorage.businessPeriod.postgresqlType)} NOT NULL`,
        ]
      : []),
    `${quoted(entity.recordIdentity.column)} uuid NOT NULL`,
    `${quoted(entity.optimisticRevision.column)} bigint NOT NULL DEFAULT 1`,
    `${quoted(entity.archive.archivedAtColumn)} timestamp with time zone`,
    ...entity.columns.map(
      (column) =>
        `${quoted(column.physicalName)} ${safeType(column.postgresqlType)}${column.nullable ? '' : ' NOT NULL'}${defaultSql(column.defaultSemantics, column.defaultValue, column.postgresqlType)}`,
    ),
    ...(entity.foldedColumns ?? []).map(
      (column) =>
        `${quoted(column.physicalName)} text COLLATE "C" GENERATED ALWAYS AS (${unicodeCaseFoldSql(quoted(column.sourceColumn))}) STORED`,
    ),
    ...relationColumns.map(
      (column) =>
        `${quoted(column.physicalName)} ${safeType(column.postgresqlType)}${column.nullable ? '' : ' NOT NULL'}`,
    ),
    ...entity.derivedStateFields.map(
      (column) => `${quoted(column.physicalName)} text`,
    ),
    ...(entity.legalEntity
      ? [
          `CONSTRAINT ${quoted(legalEntityForeignKeyName(entity))}
             FOREIGN KEY (tenant_id, environment_id, ${quoted(entity.legalEntity.column)})
             REFERENCES north_star_module.${quoted(requiredLegalEntityMaster(target).physicalTableName)}
               (tenant_id, environment_id, record_id)
             ON DELETE RESTRICT ON UPDATE RESTRICT`,
        ]
      : []),
    ...(entity.factStorage
      ? [
          `CONSTRAINT ${quoted(entity.factStorage.effectIdentityUnique.physicalName)}
             UNIQUE (${entity.factStorage.effectIdentityUnique.columns.map(quoted).join(', ')})`,
          ...entity.factStorage.stockIdentityV1MemberChecks.map(
            (check) =>
              `CONSTRAINT ${quoted(check.physicalName)}
                 CHECK (btrim(${quoted(check.column)}::text) <> ''
                   AND ${quoted(check.column)}::text <> ${sqlTextLiteral(check.rejectedSentinel)})`,
          ),
        ]
      : []),
  ];
  const legalEntityMaster = entity.legalEntity
    ? requiredLegalEntityMaster(target)
    : null;
  if (legalEntityMaster) {
    await client.query(
      `GRANT REFERENCES ON north_star_module.${quoted(legalEntityMaster.physicalTableName)}
         TO north_star_module_materializer`,
    );
  }
  await client.query(
    `CREATE TABLE IF NOT EXISTS north_star_module.${quoted(entity.physicalTableName)} (
       ${columns.join(',\n')},
       CONSTRAINT ${quoted(entity.primaryKey.physicalName)} PRIMARY KEY
         (${entity.primaryKey.columns.map(quoted).join(', ')})
    )${entity.factStorage ? ` PARTITION BY HASH (${entity.factStorage.partitioning.keyColumns.map(quoted).join(', ')})` : ''}`,
  );
  if (legalEntityMaster) {
    await client.query(
      `REVOKE REFERENCES ON north_star_module.${quoted(legalEntityMaster.physicalTableName)}
         FROM north_star_module_materializer`,
    );
  }
  for (const check of entity.checkConstraints ?? []) {
    await ensureEnumCheckConstraint(client, entity, check);
  }
  for (const unique of entity.uniqueKeys) {
    const columns = uniqueKeyColumnExpressions(entity, unique);
    const predicate = uniqueKeyPredicateSql(entity, unique);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoted(unique.physicalName)}
         ON north_star_module.${quoted(entity.physicalTableName)}
         (${columns.join(', ')}) WHERE ${predicate}`,
    );
  }
  // Row-level security is a property of the table, not of the tenant that
  // created it. The first tenant to materialize this table seeds it before
  // ENABLE ROW LEVEL SECURITY below, so its seeds slip through unguarded; every
  // later tenant seeds a table on which RLS is already enabled and forced. The
  // seed INSERT policy therefore has to exist before the seeds run, and it is
  // granted only to the two table classes that are seeded at all.
  if (entity.legalEntityMaster || entity.periodLock) {
    await ensureMaterializerSeedInsertPolicy(client, entity.physicalTableName);
  }
  if (entity.legalEntityMaster) {
    await provisionDefaultLegalEntity(client, entity);
  }
  if (entity.periodLock) {
    await provisionPeriodLockRows(client, target, entity);
    await ensurePeriodLockProvisioningTrigger(client, target, entity);
  }
  await client.query(
    `ALTER TABLE north_star_module.${quoted(entity.physicalTableName)} ENABLE ROW LEVEL SECURITY`,
  );
  await client.query(
    `ALTER TABLE north_star_module.${quoted(entity.physicalTableName)} FORCE ROW LEVEL SECURITY`,
  );
  const predicate = `tenant_id = north_star_internal.trusted_tenant_id()
    AND environment_id = north_star_internal.trusted_environment_id()`;
  const policyCommands = entity.factStorage
    ? (['SELECT', 'INSERT'] as const)
    : entity.periodLock
      ? (['SELECT', 'UPDATE'] as const)
      : (['SELECT', 'INSERT', 'UPDATE'] as const);
  for (const command of policyCommands) {
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
            ? `WITH CHECK (${predicate}${postedStockProjection ? ' AND pg_trigger_depth() > 0' : ''})`
            : `USING (${predicate}${postedStockProjection ? ' AND pg_trigger_depth() > 0' : ''}) WITH CHECK (${predicate}${postedStockProjection ? ' AND pg_trigger_depth() > 0' : ''})`;
      await client.query(
        `CREATE POLICY ${quoted(policy)} ON north_star_module.${quoted(entity.physicalTableName)}
           FOR ${command} TO north_star_module_runtime ${clause}`,
      );
    }
  }
  if (entity.factStorage || entity.legalEntity || entity.legalEntityMaster) {
    await ensureMaterializerSelectPolicy(client, entity.physicalTableName);
  }
  if (postedStockProjection) {
    await ensureMaterializerProjectionMutationPolicies(
      client,
      entity.physicalTableName,
    );
  }
  await client.query(
    `REVOKE ALL ON north_star_module.${quoted(entity.physicalTableName)} FROM PUBLIC`,
  );
  if (entity.factStorage) {
    await client.query(
      `GRANT SELECT, INSERT ON north_star_module.${quoted(entity.physicalTableName)} TO north_star_module_runtime`,
    );
    await client.query(
      `REVOKE UPDATE ON north_star_module.${quoted(entity.physicalTableName)} FROM north_star_module_runtime`,
    );
  } else if (entity.periodLock) {
    await client.query(
      `GRANT SELECT ON north_star_module.${quoted(entity.physicalTableName)} TO north_star_module_runtime`,
    );
    await client.query(
      `REVOKE INSERT, UPDATE ON north_star_module.${quoted(entity.physicalTableName)} FROM north_star_module_runtime`,
    );
    await client.query(
      `GRANT UPDATE (${[
        entity.periodLock.closedThroughColumn,
        entity.optimisticRevision.column,
      ]
        .map(quoted)
        .join(', ')})
         ON north_star_module.${quoted(entity.physicalTableName)}
         TO north_star_module_runtime`,
    );
  } else if (entity.legalEntity) {
    await client.query(
      `GRANT SELECT, INSERT ON north_star_module.${quoted(entity.physicalTableName)} TO north_star_module_runtime`,
    );
    await client.query(
      `REVOKE UPDATE ON north_star_module.${quoted(entity.physicalTableName)} FROM north_star_module_runtime`,
    );
    const mutableColumns = entityOwnedMutableColumnNames(target, entity);
    if (mutableColumns.length > 0) {
      await client.query(
        `GRANT UPDATE (${mutableColumns.map(quoted).join(', ')})
           ON north_star_module.${quoted(entity.physicalTableName)}
           TO north_star_module_runtime`,
      );
    }
  } else {
    await client.query(
      `GRANT SELECT, INSERT, UPDATE ON north_star_module.${quoted(entity.physicalTableName)} TO north_star_module_runtime`,
    );
  }
  await client.query(
    `REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON north_star_module.${quoted(entity.physicalTableName)} FROM north_star_module_runtime`,
  );
  await client.query(
    `REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON north_star_module.${quoted(entity.physicalTableName)} FROM north_star_module_materializer`,
  );
}

async function provisionPeriodLockRows(
  client: PoolClient,
  target: StorageTargetPayloadV1,
  entity: StorageEntityTarget,
): Promise<void> {
  const periodLock = entity.periodLock;
  if (!periodLock) return;
  const master = requiredLegalEntityMaster(target);
  await client.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)} (
       tenant_id,
       environment_id,
       legal_entity_id,
       record_id,
       ${quoted(periodLock.closedThroughColumn)}
     )
     SELECT tenant_id, environment_id, record_id, record_id, NULL
       FROM north_star_module.${quoted(master.physicalTableName)}
      WHERE tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
        AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
     ON CONFLICT DO NOTHING`,
  );
}

async function ensurePeriodLockProvisioningTrigger(
  client: PoolClient,
  target: StorageTargetPayloadV1,
  entity: StorageEntityTarget,
): Promise<void> {
  const periodLock = entity.periodLock;
  if (!periodLock) return;
  const master = requiredLegalEntityMaster(target);
  const exists = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger AS trigger_record
       JOIN pg_class AS relation ON relation.oid = trigger_record.tgrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relname = $1
        AND trigger_record.tgname = $2
        AND NOT trigger_record.tgisinternal
     ) AS present`,
    [master.physicalTableName, periodLock.provisioningTriggerName],
  );
  if (exists.rows[0]?.present) return;
  await client.query(
    `GRANT TRIGGER ON north_star_module.${quoted(master.physicalTableName)}
       TO north_star_module_materializer`,
  );
  await client.query(
    `CREATE TRIGGER ${quoted(periodLock.provisioningTriggerName)}
       AFTER INSERT ON north_star_module.${quoted(master.physicalTableName)}
       FOR EACH ROW EXECUTE FUNCTION north_star_internal.provision_inventory_period_lock(
         'north_star_module.${entity.physicalTableName}'
       )`,
  );
  await client.query(
    `REVOKE TRIGGER ON north_star_module.${quoted(master.physicalTableName)}
       FROM north_star_module_materializer`,
  );
}

function locateFactPartition(
  target: StorageTargetPayloadV1,
  element: StorageTransitionElement,
) {
  for (const entity of target.entities) {
    const partition = entity.factStorage?.partitioning.partitions.find(
      (candidate) => candidate.physicalTableName === element.physicalObjectName,
    );
    if (partition) return { entity, partition };
  }
  throw failure('ELEMENT_TARGET_MISSING', element.elementId);
}

function locateRejectMutationTrigger(
  target: StorageTargetPayloadV1,
  element: StorageTransitionElement,
): { tableName: string } {
  for (const entity of target.entities) {
    if (
      entity.factStorage?.rejectMutationTriggerName ===
      element.physicalObjectName
    ) {
      return { tableName: entity.physicalTableName };
    }
    if (
      entity.factStorage?.companion.rejectMutationTriggerName ===
      element.physicalObjectName
    ) {
      return { tableName: entity.factStorage.companion.physicalTableName };
    }
  }
  throw failure('ELEMENT_TARGET_MISSING', element.elementId);
}

async function createFactCompanionTable(
  client: PoolClient,
  entity: StorageEntityTarget,
): Promise<void> {
  const fact = entity.factStorage;
  if (!fact) throw failure('FACT_STORAGE_TARGET_MISSING', entity.entityId);
  const companion = fact.companion;
  await client.query(
    `GRANT REFERENCES ON north_star_module.${quoted(entity.physicalTableName)}
       TO north_star_module_materializer`,
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS north_star_module.${quoted(companion.physicalTableName)} (
       ${companion.columns
         .map(
           (column) =>
             `${quoted(column.name)} ${safeType(column.postgresqlType)} NOT NULL`,
         )
         .join(',\n')},
       CONSTRAINT ${quoted(companion.primaryKey.physicalName)}
         PRIMARY KEY (${companion.primaryKey.columns.map(quoted).join(', ')}),
       CONSTRAINT ${quoted(companion.movementUnique.physicalName)}
         UNIQUE (${companion.movementUnique.columns.map(quoted).join(', ')}),
       CONSTRAINT ${quoted(companion.movementForeignKey.physicalName)}
         FOREIGN KEY (${companion.movementForeignKey.sourceColumns.map(quoted).join(', ')})
         REFERENCES north_star_module.${quoted(entity.physicalTableName)}
           (${companion.movementForeignKey.targetColumns.map(quoted).join(', ')})
         ON DELETE RESTRICT ON UPDATE RESTRICT
     )`,
  );
  await ensureFactReservationTrigger(
    client,
    entity.physicalTableName,
    companion.physicalTableName,
    companion.reservationTriggerName,
  );
  await client.query(
    `REVOKE REFERENCES ON north_star_module.${quoted(entity.physicalTableName)}
       FROM north_star_module_materializer`,
  );
  await client.query(
    `ALTER TABLE north_star_module.${quoted(companion.physicalTableName)} ENABLE ROW LEVEL SECURITY`,
  );
  await client.query(
    `ALTER TABLE north_star_module.${quoted(companion.physicalTableName)} FORCE ROW LEVEL SECURITY`,
  );
  const predicate = `tenant_id = north_star_internal.trusted_tenant_id()
    AND environment_id = north_star_internal.trusted_environment_id()`;
  for (const command of ['SELECT', 'INSERT'] as const) {
    const policy = managedPolicyName(companion.physicalTableName, command);
    const exists = await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname = 'north_star_module' AND tablename = $1 AND policyname = $2) AS present`,
      [companion.physicalTableName, policy],
    );
    if (!exists.rows[0]?.present) {
      const clause =
        command === 'SELECT'
          ? `USING (${predicate})`
          : `WITH CHECK (${predicate})`;
      await client.query(
        `CREATE POLICY ${quoted(policy)} ON north_star_module.${quoted(companion.physicalTableName)}
           FOR ${command} TO north_star_module_runtime ${clause}`,
      );
    }
  }
  await ensureMaterializerSelectPolicy(client, companion.physicalTableName);
  await client.query(
    `REVOKE ALL ON north_star_module.${quoted(companion.physicalTableName)} FROM PUBLIC`,
  );
  await client.query(
    `GRANT SELECT, INSERT ON north_star_module.${quoted(companion.physicalTableName)} TO north_star_module_runtime`,
  );
  await client.query(
    `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
       ON north_star_module.${quoted(companion.physicalTableName)}
       FROM north_star_module_runtime`,
  );
  await client.query(
    `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
       ON north_star_module.${quoted(companion.physicalTableName)}
       FROM north_star_module_materializer`,
  );
}

async function ensureFactReservationTrigger(
  client: PoolClient,
  movementTableName: string,
  companionTableName: string,
  triggerName: string,
): Promise<void> {
  const exists = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger AS trigger_record
       JOIN pg_class AS relation ON relation.oid = trigger_record.tgrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relname = $1
        AND trigger_record.tgname = $2
        AND NOT trigger_record.tgisinternal
     ) AS present`,
    [movementTableName, triggerName],
  );
  if (exists.rows[0]?.present) return;
  await client.query(
    `GRANT TRIGGER ON north_star_module.${quoted(movementTableName)}
       TO north_star_module_materializer`,
  );
  await client.query(
    `CREATE TRIGGER ${quoted(triggerName)}
       AFTER INSERT ON north_star_module.${quoted(movementTableName)}
       FOR EACH ROW EXECUTE FUNCTION north_star_internal.reserve_inventory_movement_effect(
         'north_star_module.${companionTableName}'
       )`,
  );
  await client.query(
    `REVOKE TRIGGER ON north_star_module.${quoted(movementTableName)}
       FROM north_star_module_materializer`,
  );
}

async function ensureMaterializerSelectPolicy(
  client: PoolClient,
  tableName: string,
): Promise<void> {
  const policyName = managedMaterializerPolicyName(tableName);
  const exists = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_policies
      WHERE schemaname = 'north_star_module'
        AND tablename = $1
        AND policyname = $2) AS present`,
    [tableName, policyName],
  );
  if (exists.rows[0]?.present) return;
  await client.query(
    `CREATE POLICY ${quoted(policyName)} ON north_star_module.${quoted(tableName)}
       FOR SELECT TO north_star_module_materializer
       USING (
         tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
         AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
       )`,
  );
}

/**
 * Seeding companion to {@link ensureMaterializerSelectPolicy}, and just as
 * narrow. Only the legal-entity master and the period-lock table are seeded by
 * the materializer, so only those two receive it; the materializer never gains
 * blanket INSERT on module tables. The predicate is the same trusted
 * tenant/environment pair the runtime policies bind to, inlined for the same
 * reason the SELECT policy inlines it: `north_star_internal.trusted_tenant_id`
 * is executable by `north_star_module_runtime` only.
 */
async function ensureMaterializerSeedInsertPolicy(
  client: PoolClient,
  tableName: string,
): Promise<void> {
  const policyName = managedMaterializerSeedInsertPolicyName(tableName);
  const exists = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_policies
      WHERE schemaname = 'north_star_module'
        AND tablename = $1
        AND policyname = $2) AS present`,
    [tableName, policyName],
  );
  if (exists.rows[0]?.present) return;
  await client.query(
    `CREATE POLICY ${quoted(policyName)} ON north_star_module.${quoted(tableName)}
       FOR INSERT TO north_star_module_materializer
       WITH CHECK (
         tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
         AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid
       )`,
  );
}

async function ensureMaterializerProjectionMutationPolicies(
  client: PoolClient,
  tableName: string,
): Promise<void> {
  const predicate = `tenant_id = nullif(current_setting('north_star.tenant_id', true), '')::uuid
    AND environment_id = nullif(current_setting('north_star.environment_id', true), '')::uuid`;
  for (const command of ['INSERT', 'UPDATE'] as const) {
    const policyName = managedMaterializerProjectionPolicyName(
      tableName,
      command,
    );
    const exists = await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname = 'north_star_module'
          AND tablename = $1
          AND policyname = $2) AS present`,
      [tableName, policyName],
    );
    if (exists.rows[0]?.present) continue;
    const clause =
      command === 'INSERT'
        ? `WITH CHECK (${predicate})`
        : `USING (${predicate}) WITH CHECK (${predicate})`;
    await client.query(
      `CREATE POLICY ${quoted(policyName)} ON north_star_module.${quoted(tableName)}
         FOR ${command} TO north_star_module_materializer ${clause}`,
    );
  }
}

interface PostedStockBalanceProjectionBinding {
  readonly balance: StorageEntityTarget;
  readonly balanceArchiveColumn: string;
  readonly balanceItemColumn: string;
  readonly balanceLegalEntityColumn: string;
  readonly balanceLocationColumn: string;
  readonly balanceQuantityColumn: string;
  readonly balanceRecordIdColumn: string;
  readonly balanceRevisionColumn: string;
  readonly balanceUnitColumn: string;
  readonly movement: StorageEntityTarget;
  readonly movementArchiveColumn: string;
  readonly movementItemColumn: string;
  readonly movementLegalEntityColumn: string;
  readonly movementLocationColumn: string;
  readonly movementQuantityColumn: string;
  readonly movementUnitColumn: string;
  readonly triggerName: string;
}

interface MaterializerScope {
  readonly environmentId: string;
  readonly tenantId: string;
}

function isPostedStockBalanceEntity(entity: StorageEntityTarget): boolean {
  return entity.entityId.endsWith(':entity.posted_stock_balance');
}

function postedStockBalanceProjection(
  target: StorageTargetPayloadV1,
): PostedStockBalanceProjectionBinding | null {
  return postedStockBalanceProjectionFromEntities(target.entities);
}

function postedStockBalanceProjectionFromEntities(
  entities: readonly StorageEntityTarget[],
): PostedStockBalanceProjectionBinding | null {
  const balances = entities.filter(isPostedStockBalanceEntity);
  if (balances.length === 0) return null;
  const movements = entities.filter((entity) =>
    entity.entityId.endsWith(':entity.inventory_movement'),
  );
  if (balances.length !== 1 || movements.length !== 1) {
    throw failure(
      'POSTED_STOCK_BALANCE_STORAGE_INVALID',
      `posted-stock projection requires one balance and one movement entity; received ${String(balances.length)} and ${String(movements.length)}`,
    );
  }
  const balance = balances[0]!;
  const movement = movements[0]!;
  if (!balance.legalEntity || !movement.legalEntity || !movement.factStorage) {
    throw failure(
      'POSTED_STOCK_BALANCE_STORAGE_INVALID',
      'posted-stock projection requires legal-entity-owned balance and append-only movement storage',
    );
  }
  return Object.freeze({
    balance,
    balanceArchiveColumn: balance.archive.archivedAtColumn,
    balanceItemColumn: requiredLocalStorageColumn(
      balance,
      'posted_stock_balance_item_id',
    ),
    balanceLegalEntityColumn: balance.legalEntity.column,
    balanceLocationColumn: requiredLocalStorageColumn(
      balance,
      'posted_stock_balance_location_id',
    ),
    balanceQuantityColumn: requiredLocalStorageColumn(
      balance,
      'posted_stock_balance_posted_quantity',
    ),
    balanceRecordIdColumn: balance.recordIdentity.column,
    balanceRevisionColumn: balance.optimisticRevision.column,
    balanceUnitColumn: requiredLocalStorageColumn(
      balance,
      'posted_stock_balance_unit_id',
    ),
    movement,
    movementArchiveColumn: movement.archive.archivedAtColumn,
    movementItemColumn: requiredLocalStorageColumn(
      movement,
      'inventory_movement_item_id',
    ),
    movementLegalEntityColumn: movement.legalEntity.column,
    movementLocationColumn: requiredLocalStorageColumn(
      movement,
      'inventory_movement_location_id',
    ),
    movementQuantityColumn: requiredLocalStorageColumn(
      movement,
      'inventory_movement_quantity_delta',
    ),
    movementUnitColumn: requiredLocalStorageColumn(
      movement,
      'inventory_movement_unit_id',
    ),
    triggerName: postedStockBalanceTriggerName(balance),
  });
}

function requiredPostedStockBalanceProjection(
  target: StorageTargetPayloadV1,
): PostedStockBalanceProjectionBinding {
  const projection = postedStockBalanceProjection(target);
  if (!projection) {
    throw failure(
      'POSTED_STOCK_BALANCE_STORAGE_INVALID',
      'active release does not contain the posted-stock projection',
    );
  }
  return projection;
}

function requiredLocalStorageColumn(
  entity: StorageEntityTarget,
  localId: string,
): string {
  const matches = entity.columns.filter(
    (column) => column.canonicalFieldId.split(':field.').at(-1) === localId,
  );
  if (matches.length !== 1) {
    throw failure(
      'POSTED_STOCK_BALANCE_STORAGE_INVALID',
      `${entity.entityId} requires exactly one ${localId} field`,
    );
  }
  return matches[0]!.physicalName;
}

function postedStockBalanceTriggerName(entity: StorageEntityTarget): string {
  const match = /^nsm_t_([a-z2-7]{52})$/u.exec(entity.physicalTableName);
  if (!match?.[1]) {
    throw failure(
      'PHYSICAL_TABLE_NAME_INVALID',
      `posted-stock balance table has invalid name ${entity.physicalTableName}`,
    );
  }
  // PostgreSQL fires same-event triggers in name order. `nsm_z_` sorts after
  // the existing `nsm_g_` reservation/generation trigger, so the balance never
  // advances before the posting-linked generation has advanced.
  return `nsm_z_${match[1]}`;
}

async function ensurePostedStockBalanceProjection(
  client: PoolClient,
  target: StorageTargetPayloadV1,
  scope: MaterializerScope,
): Promise<void> {
  if (!postedStockBalanceProjection(target)) return;
  // DDL elements are content-address sorted, not entity-order sorted. Wire the
  // cross-table projection only after every prepared table exists.
  await ensurePostedStockBalanceFunction(client);
  await rebuildPostedStockBalanceOnClient(client, target, scope);
  await ensurePostedStockBalanceTrigger(client, target);
}

async function ensurePostedStockBalanceFunction(
  client: PoolClient,
): Promise<void> {
  const expectedSource = postedStockBalanceFunctionSource();
  const existing = await client.query<{ source: string }>(
    `SELECT routine.prosrc AS source
       FROM pg_proc AS routine
       JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'north_star_module'
        AND routine.proname = $1
        AND pg_get_function_identity_arguments(routine.oid) = ''`,
    [postedStockBalanceFunctionName],
  );
  if (existing.rows.length > 1) {
    throw failure(
      'POSTED_STOCK_BALANCE_FUNCTION_AMBIGUOUS',
      `${postedStockBalanceFunctionName}() resolved to ${String(existing.rows.length)} catalog entries`,
    );
  }
  if (existing.rows[0]?.source !== undefined) {
    if (existing.rows[0].source !== expectedSource) {
      throw failure(
        'POSTED_STOCK_BALANCE_FUNCTION_MISMATCH',
        `${postedStockBalanceFunctionName}() exists with a different body`,
      );
    }
    return;
  }
  await client.query(
    `CREATE FUNCTION north_star_module.${postedStockBalanceFunctionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path = pg_catalog, north_star_internal
       AS $posted_stock_balance$${expectedSource}$posted_stock_balance$;
     REVOKE ALL ON FUNCTION north_star_module.${postedStockBalanceFunctionName}() FROM PUBLIC`,
  );
}

function postedStockBalanceFunctionSource(): string {
  return `
DECLARE
  affected_rows bigint;
  balance_relation regclass;
BEGIN
  IF TG_NARGS <> 14 THEN
    RAISE EXCEPTION 'POSTED_STOCK_BALANCE_TRIGGER_ARGUMENTS_INVALID'
      USING ERRCODE = 'P0001';
  END IF;
  balance_relation := TG_ARGV[0]::regclass;
  PERFORM 1
    FROM north_star_internal.semantic_aggregate_generations
   WHERE tenant_id = NEW.tenant_id
     AND environment_id = NEW.environment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTED_STOCK_BALANCE_GENERATION_MISSING'
      USING ERRCODE = 'P0001';
  END IF;
  EXECUTE format(
    'INSERT INTO %s AS balance (
       tenant_id, environment_id, %I, %I, %I, %I, %I, %I, %I, %I
     ) VALUES (
       $1.tenant_id, $1.environment_id, $1.%I,
       overlay(
         overlay(
           md5(jsonb_build_array(
             ''northstar.posted-stock-balance-row/v1'',
             $1.tenant_id::text, $1.environment_id::text,
             $1.%I::text, $1.%I::text, $1.%I::text
           )::text)
           placing ''4'' from 13 for 1
         )
         placing ''8'' from 17 for 1
       )::uuid,
       1, NULL, $1.%I, $1.%I, $1.%I, $1.%I
     )
     ON CONFLICT (tenant_id, environment_id, %I, %I) DO UPDATE
       SET %I = balance.%I + EXCLUDED.%I,
           %I = balance.%I + 1
     WHERE balance.%I = EXCLUDED.%I
       AND balance.%I = EXCLUDED.%I
       AND balance.%I = EXCLUDED.%I
       AND balance.%I = EXCLUDED.%I
       AND balance.%I IS NULL',
    balance_relation,
    TG_ARGV[6], TG_ARGV[11], TG_ARGV[12], TG_ARGV[13],
    TG_ARGV[7], TG_ARGV[8], TG_ARGV[9], TG_ARGV[10],
    TG_ARGV[1], TG_ARGV[1], TG_ARGV[2], TG_ARGV[3],
    TG_ARGV[2], TG_ARGV[3], TG_ARGV[4], TG_ARGV[5],
    TG_ARGV[6], TG_ARGV[11],
    TG_ARGV[9], TG_ARGV[9], TG_ARGV[9],
    TG_ARGV[12], TG_ARGV[12],
    TG_ARGV[6], TG_ARGV[6],
    TG_ARGV[7], TG_ARGV[7],
    TG_ARGV[8], TG_ARGV[8],
    TG_ARGV[10], TG_ARGV[10],
    TG_ARGV[13]
  ) USING NEW;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'POSTED_STOCK_BALANCE_IDENTITY_COLLISION'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
`;
}

function postedStockBalanceTriggerArguments(
  projection: PostedStockBalanceProjectionBinding,
): readonly string[] {
  return Object.freeze([
    `north_star_module.${projection.balance.physicalTableName}`,
    projection.movementLegalEntityColumn,
    projection.movementItemColumn,
    projection.movementLocationColumn,
    projection.movementQuantityColumn,
    projection.movementUnitColumn,
    projection.balanceLegalEntityColumn,
    projection.balanceItemColumn,
    projection.balanceLocationColumn,
    projection.balanceQuantityColumn,
    projection.balanceUnitColumn,
    projection.balanceRecordIdColumn,
    projection.balanceRevisionColumn,
    projection.balanceArchiveColumn,
  ]);
}

async function ensurePostedStockBalanceTrigger(
  client: PoolClient,
  target: StorageTargetPayloadV1,
): Promise<void> {
  const projection = requiredPostedStockBalanceProjection(target);
  const exists = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger AS trigger_record
       JOIN pg_class AS relation ON relation.oid = trigger_record.tgrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relname = $1
        AND trigger_record.tgname = $2
        AND NOT trigger_record.tgisinternal
     ) AS present`,
    [projection.movement.physicalTableName, projection.triggerName],
  );
  if (exists.rows[0]?.present) return;
  await client.query(
    `GRANT TRIGGER ON north_star_module.${quoted(projection.movement.physicalTableName)}
       TO north_star_module_materializer`,
  );
  await client.query(
    `CREATE TRIGGER ${quoted(projection.triggerName)}
       AFTER INSERT ON north_star_module.${quoted(projection.movement.physicalTableName)}
       FOR EACH ROW EXECUTE FUNCTION north_star_module.${postedStockBalanceFunctionName}(
         ${postedStockBalanceTriggerArguments(projection).map(triggerArgumentLiteral).join(', ')}
       )`,
  );
  await client.query(
    `REVOKE TRIGGER ON north_star_module.${quoted(projection.movement.physicalTableName)}
       FROM north_star_module_materializer`,
  );
}

async function rebuildPostedStockBalanceOnClient(
  client: PoolClient,
  target: StorageTargetPayloadV1,
  scope: MaterializerScope,
): Promise<PostedStockBalanceRebuildResult> {
  const projection = requiredPostedStockBalanceProjection(target);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    aggregateGenerationLockKey(scope.tenantId, scope.environmentId),
  ]);
  const mixedUnit = await client.query<{
    itemId: string;
    legalEntityId: string;
    locationId: string;
  }>(
    `SELECT ${quoted(projection.movementLegalEntityColumn)}::text AS "legalEntityId",
            ${quoted(projection.movementItemColumn)}::text AS "itemId",
            ${quoted(projection.movementLocationColumn)}::text AS "locationId"
       FROM north_star_module.${quoted(projection.movement.physicalTableName)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(projection.movementArchiveColumn)} IS NULL
      GROUP BY ${quoted(projection.movementLegalEntityColumn)},
               ${quoted(projection.movementItemColumn)},
               ${quoted(projection.movementLocationColumn)}
     HAVING count(DISTINCT ${quoted(projection.movementUnitColumn)}) <> 1
      LIMIT 1`,
    [scope.tenantId, scope.environmentId],
  );
  if (mixedUnit.rows[0]) {
    const row = mixedUnit.rows[0];
    throw failure(
      'POSTED_STOCK_BALANCE_UNIT_DIVERGED',
      `stock identity ${row.legalEntityId}/${row.itemId}/${row.locationId} carries multiple units`,
    );
  }
  const movementCountResult = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM north_star_module.${quoted(projection.movement.physicalTableName)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(projection.movementArchiveColumn)} IS NULL`,
    [scope.tenantId, scope.environmentId],
  );
  const movementCount = Number(movementCountResult.rows[0]?.count ?? '0');
  if (!Number.isSafeInteger(movementCount) || movementCount < 0) {
    throw failure(
      'POSTED_STOCK_BALANCE_MOVEMENT_COUNT_INVALID',
      'movement count exceeds the provider rebuild contract',
    );
  }
  const identityCountResult = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM (
         SELECT 1
           FROM north_star_module.${quoted(projection.movement.physicalTableName)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${quoted(projection.movementArchiveColumn)} IS NULL
          GROUP BY ${quoted(projection.movementLegalEntityColumn)},
                   ${quoted(projection.movementItemColumn)},
                   ${quoted(projection.movementLocationColumn)}
       ) AS stock_identity`,
    [scope.tenantId, scope.environmentId],
  );
  const identityCount = Number(identityCountResult.rows[0]?.count ?? '0');
  if (!Number.isSafeInteger(identityCount) || identityCount < 0) {
    throw failure(
      'POSTED_STOCK_BALANCE_IDENTITY_COUNT_INVALID',
      'stock identity count exceeds the provider rebuild contract',
    );
  }
  await client.query(
    `UPDATE north_star_module.${quoted(projection.balance.physicalTableName)}
        SET ${quoted(projection.balanceArchiveColumn)} = statement_timestamp(),
            ${quoted(projection.balanceRevisionColumn)} = ${quoted(projection.balanceRevisionColumn)} + 1
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(projection.balanceArchiveColumn)} IS NULL`,
    [scope.tenantId, scope.environmentId],
  );
  const inserted = await client.query(
    `INSERT INTO north_star_module.${quoted(projection.balance.physicalTableName)} AS balance (
       tenant_id,
       environment_id,
       ${quoted(projection.balanceLegalEntityColumn)},
       ${quoted(projection.balanceRecordIdColumn)},
       ${quoted(projection.balanceRevisionColumn)},
       ${quoted(projection.balanceArchiveColumn)},
       ${quoted(projection.balanceItemColumn)},
       ${quoted(projection.balanceLocationColumn)},
       ${quoted(projection.balanceQuantityColumn)},
       ${quoted(projection.balanceUnitColumn)}
     )
     SELECT $1::uuid,
            $2::uuid,
            movement.${quoted(projection.movementLegalEntityColumn)},
            overlay(
              overlay(
                md5(jsonb_build_array(
                  'northstar.posted-stock-balance-row/v1',
                  $1::text,
                  $2::text,
                  movement.${quoted(projection.movementLegalEntityColumn)}::text,
                  movement.${quoted(projection.movementItemColumn)}::text,
                  movement.${quoted(projection.movementLocationColumn)}::text
                )::text)
                placing '4' from 13 for 1
              )
              placing '8' from 17 for 1
            )::uuid,
            1,
            NULL,
            movement.${quoted(projection.movementItemColumn)},
            movement.${quoted(projection.movementLocationColumn)},
            SUM(movement.${quoted(projection.movementQuantityColumn)})::numeric(38,18),
            MIN(movement.${quoted(projection.movementUnitColumn)})
       FROM north_star_module.${quoted(projection.movement.physicalTableName)} AS movement
      WHERE movement.tenant_id = $1 AND movement.environment_id = $2
        AND movement.${quoted(projection.movementArchiveColumn)} IS NULL
      GROUP BY movement.${quoted(projection.movementLegalEntityColumn)},
               movement.${quoted(projection.movementItemColumn)},
               movement.${quoted(projection.movementLocationColumn)}
      ORDER BY movement.${quoted(projection.movementLegalEntityColumn)},
               movement.${quoted(projection.movementItemColumn)},
               movement.${quoted(projection.movementLocationColumn)}
     ON CONFLICT (tenant_id, environment_id,
                  ${quoted(projection.balanceLegalEntityColumn)},
                  ${quoted(projection.balanceRecordIdColumn)}) DO UPDATE
       SET ${quoted(projection.balanceRevisionColumn)} = balance.${quoted(projection.balanceRevisionColumn)} + 1,
           ${quoted(projection.balanceArchiveColumn)} = NULL,
           ${quoted(projection.balanceItemColumn)} = EXCLUDED.${quoted(projection.balanceItemColumn)},
           ${quoted(projection.balanceLocationColumn)} = EXCLUDED.${quoted(projection.balanceLocationColumn)},
           ${quoted(projection.balanceQuantityColumn)} = EXCLUDED.${quoted(projection.balanceQuantityColumn)},
           ${quoted(projection.balanceUnitColumn)} = EXCLUDED.${quoted(projection.balanceUnitColumn)}
     WHERE balance.${quoted(projection.balanceLegalEntityColumn)} = EXCLUDED.${quoted(projection.balanceLegalEntityColumn)}
       AND balance.${quoted(projection.balanceItemColumn)} = EXCLUDED.${quoted(projection.balanceItemColumn)}
       AND balance.${quoted(projection.balanceLocationColumn)} = EXCLUDED.${quoted(projection.balanceLocationColumn)}
       AND balance.${quoted(projection.balanceUnitColumn)} = EXCLUDED.${quoted(projection.balanceUnitColumn)}`,
    [scope.tenantId, scope.environmentId],
  );
  if (inserted.rowCount !== identityCount) {
    throw failure(
      'POSTED_STOCK_BALANCE_IDENTITY_COLLISION',
      `rebuild applied ${String(inserted.rowCount ?? 0)} of ${String(identityCount)} stock identities`,
    );
  }
  return Object.freeze({
    movementCount,
    rowCount: identityCount,
  });
}

function triggerArgumentLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensureRejectMutationTrigger(
  client: PoolClient,
  tableName: string,
  triggerName: string,
): Promise<void> {
  const exists = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger AS trigger_record
       JOIN pg_class AS relation ON relation.oid = trigger_record.tgrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relname = $1
        AND trigger_record.tgname = $2
        AND NOT trigger_record.tgisinternal
     ) AS present`,
    [tableName, triggerName],
  );
  if (exists.rows[0]?.present) return;
  await client.query(
    `GRANT TRIGGER ON north_star_module.${quoted(tableName)}
       TO north_star_module_materializer`,
  );
  await client.query(
    `CREATE TRIGGER ${quoted(triggerName)}
       BEFORE UPDATE OR DELETE ON north_star_module.${quoted(tableName)}
       FOR EACH ROW EXECUTE FUNCTION north_star_internal.reject_inventory_fact_mutation()`,
  );
  await client.query(
    `REVOKE TRIGGER ON north_star_module.${quoted(tableName)}
       FROM north_star_module_materializer`,
  );
}

async function ensureAbiFunctionCheck(
  client: PoolClient,
  target: StorageTargetPayloadV1,
  element: StorageTransitionElement,
): Promise<void> {
  for (const entity of target.entities) {
    if (
      entity.factStorage?.businessPeriod.checkConstraintName ===
      element.physicalObjectName
    ) {
      const check = entity.factStorage.businessPeriod;
      await ensureNamedCheckConstraint(
        client,
        entity.physicalTableName,
        check.checkConstraintName,
        `${quoted(check.column)} = north_star_internal.inventory_business_period(tenant_id, ${quoted(check.effectiveAtColumn)})`,
      );
      return;
    }
    const check = entity.abiFunctionChecks?.find(
      (candidate) => candidate.physicalName === element.physicalObjectName,
    );
    if (!check) continue;
    await ensureNamedCheckConstraint(
      client,
      entity.physicalTableName,
      check.physicalName,
      `north_star_internal.inventory_base_unit_change_allowed(
         tenant_id,
         environment_id,
         ${quoted(check.itemIdColumn)},
         ${quoted(check.unitIdColumn)}::text,
         ${sqlTextLiteral(`north_star_module.${check.movementTableName}`)}::regclass,
         ${sqlTextLiteral(check.movementItemIdColumn)}::name,
         ${sqlTextLiteral(check.movementUnitIdColumn)}::name,
         ${sqlTextLiteral(check.movementRecordedAtColumn)}::name,
         ${sqlTextLiteral(check.movementRecordIdColumn)}::name
       )`,
    );
    return;
  }
  throw failure('ELEMENT_TARGET_MISSING', element.elementId);
}

async function ensureNamedCheckConstraint(
  client: PoolClient,
  tableName: string,
  constraintName: string,
  expression: string,
): Promise<void> {
  const exists = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint AS constraint_record
       JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relname = $1
        AND constraint_record.conname = $2
     ) AS present`,
    [tableName, constraintName],
  );
  if (exists.rows[0]?.present) return;
  await client.query(
    `ALTER TABLE north_star_module.${quoted(tableName)}
       ADD CONSTRAINT ${quoted(constraintName)} CHECK (${expression})`,
  );
}

async function ensureEnumCheckConstraint(
  client: PoolClient,
  entity: StorageEntityTarget,
  check: StorageEntityTarget['checkConstraints'][number],
): Promise<void> {
  const exists = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_constraint AS constraint_record
         JOIN pg_class AS relation_record
           ON relation_record.oid = constraint_record.conrelid
         JOIN pg_namespace AS namespace_record
           ON namespace_record.oid = relation_record.relnamespace
        WHERE namespace_record.nspname = 'north_star_module'
          AND relation_record.relname = $1
          AND constraint_record.conname = $2
     ) AS present`,
    [entity.physicalTableName, check.physicalName],
  );
  if (exists.rows[0]?.present) return;
  await client.query(
    `ALTER TABLE north_star_module.${quoted(entity.physicalTableName)}
       ADD CONSTRAINT ${quoted(check.physicalName)}
       CHECK (${enumCheckExpression(entity, check)}) NOT VALID`,
  );
}

async function provisionDefaultLegalEntity(
  client: PoolClient,
  entity: StorageEntityTarget,
): Promise<void> {
  const master = entity.legalEntityMaster;
  if (!master) return;
  await client.query(
    `INSERT INTO north_star_module.${quoted(entity.physicalTableName)} (
       tenant_id,
       environment_id,
       ${quoted(entity.recordIdentity.column)},
       ${quoted(entity.optimisticRevision.column)},
       ${quoted(master.fieldColumns.code)},
       ${quoted(master.fieldColumns.name)},
       ${quoted(master.fieldColumns.status)},
       ${quoted(master.fieldColumns.isDefault)}
     ) SELECT
       nullif(current_setting('north_star.tenant_id', true), '')::uuid,
       nullif(current_setting('north_star.environment_id', true), '')::uuid,
       north_star_internal.inventory_provisioned_legal_entity_id(
         nullif(current_setting('north_star.tenant_id', true), '')::uuid,
         nullif(current_setting('north_star.environment_id', true), '')::uuid
       ),
       1,
       'DEFAULT',
       'Default legal entity',
       ${sqlTextLiteral(master.activeStatusValue)},
       true
     ON CONFLICT (tenant_id, environment_id, ${quoted(entity.recordIdentity.column)})
       DO NOTHING`,
  );
}

function enumCheckExpression(
  entity: StorageEntityTarget,
  check: StorageEntityTarget['checkConstraints'][number],
): string {
  const column = requiredStorageColumn(entity, check.canonicalFieldId);
  return `${quoted(column.physicalName)} = ANY (ARRAY[${check.enumOptionIds
    .map(sqlTextLiteral)
    .join(', ')}])`;
}

function requiredStorageColumn(
  entity: StorageEntityTarget,
  canonicalFieldId: string,
): StorageEntityTarget['columns'][number] {
  const column = entity.columns.find(
    (candidate) => candidate.canonicalFieldId === canonicalFieldId,
  );
  if (!column) throw failure('FIELD_TARGET_MISSING', canonicalFieldId);
  return column;
}

async function verifyCatalogOnClient(
  client: PoolClient,
  targets: readonly StorageTargetPayloadV1[],
  pendingConstraintElements: ReadonlyMap<string, string> = new Map(),
  allowedMissing: AllowedMissingCatalogObjects = {
    columns: new Set(),
    indexes: new Set(),
  },
): Promise<CatalogVerification> {
  const expectedTables = mergeExpectedTables(targets);
  const expectedRelations = mergeExpectedRelations(targets);
  const drift: string[] = [];

  const registry = await loadObjectOwnershipRegistry(client);
  for (const object of registry) {
    const recognized = catalogVerifiedObjectKinds.has(object.object_kind);
    const verifierCount =
      Number(
        recognized &&
          (object.schema_name === 'platform' ||
            object.schema_name === 'north_star_internal'),
      ) + Number(recognized && object.schema_name === 'north_star_module');
    if (verifierCount !== 1) {
      drift.push(
        `object ${object.schema_name}.${object.object_name} (${object.object_kind}) has ${verifierCount} verifiers`,
      );
    }
    if (!recognized) {
      drift.push(
        `unknown or uninspected object kind ${object.object_kind} for ${object.schema_name}.${object.object_name}`,
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
    buildExpectedManagedRelations(expectedTables),
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

  const partitionBounds = await client.query<{
    bound: string;
    parent_name: string;
    partition_name: string;
  }>(
    `SELECT partition.relname AS partition_name,
            parent.relname AS parent_name,
            pg_get_expr(partition.relpartbound, partition.oid, true) AS bound
       FROM pg_inherits AS inheritance
       JOIN pg_class AS partition ON partition.oid = inheritance.inhrelid
       JOIN pg_class AS parent ON parent.oid = inheritance.inhparent
       JOIN pg_namespace AS namespace ON namespace.oid = partition.relnamespace
      WHERE namespace.nspname = 'north_star_module'
        AND partition.relispartition
        AND partition.relkind = 'r'
        AND parent.relkind = 'p'
      ORDER BY parent.relname, partition.relname`,
  );
  compareCatalogCollection(
    drift,
    'managed partition bound',
    buildExpectedPartitionBounds(expectedTables),
    partitionBounds.rows.map((partition) => ({
      bound: normalizeSqlExpressionRequired(partition.bound),
      parentName: partition.parent_name,
      partitionName: partition.partition_name,
    })),
    (value) => value.partitionName,
  );

  const columns = await client.query<{
    collation_name: string | null;
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
            attribute.attgenerated AS generated_kind,
            CASE WHEN attribute.attgenerated = 's'
              THEN collation_record.collname ELSE NULL
            END AS collation_name
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
       LEFT JOIN pg_attrdef AS default_value
         ON default_value.adrelid = relation.oid
        AND default_value.adnum = attribute.attnum
      LEFT JOIN pg_collation AS collation_record
        ON collation_record.oid = attribute.attcollation
      WHERE namespace.nspname = 'north_star_module'
        AND relation.relkind IN ('r','p','v','m','c','f')
        AND NOT relation.relispartition
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
      collation: column.collation_name,
      defaultExpression: normalizeSqlExpression(column.column_default),
      generatedKind: column.generated_kind,
      identityKind: column.identity_kind,
      name: column.name,
      nullable: column.is_nullable,
      postgresqlType: column.postgresql_type,
      tableName: column.table_name,
    })),
    (value) => `${value.tableName}.${value.name}`,
    allowedMissing.columns,
  );

  const constraints = await client.query<{
    columns: string[];
    deferred: boolean;
    deferrable: boolean;
    definition: string;
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
            pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid,
              true
            ) AS definition,
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
        AND NOT source.relispartition
        AND constraint_record.conparentid = 0
      ORDER BY source.relname, constraint_record.conname`,
  );
  const effectivePendingConstraintNames = new Set(
    pendingConstraintElements.keys(),
  );
  if (effectivePendingConstraintNames.size > 0) {
    const appliedConstraints = await client.query<{
      physical_object_name: string;
    }>(
      `SELECT DISTINCT element.physical_object_name
         FROM north_star_internal.module_storage_elements AS element
         JOIN north_star_internal.module_storage_element_applications AS application
           ON application.element_id = element.element_id
        WHERE element.element_id = ANY($1::text[])
          AND application.application_state = 'APPLIED'`,
      [[...pendingConstraintElements.values()]],
    );
    for (const applied of appliedConstraints.rows) {
      effectivePendingConstraintNames.delete(applied.physical_object_name);
    }
  }
  const expectedConstraints = buildExpectedConstraints(
    expectedTables,
    expectedRelations,
    effectivePendingConstraintNames,
  );
  const actualConstraints = constraints.rows.map((constraint) => ({
    columns: constraint.columns,
    deferred: constraint.deferred,
    deferrable: constraint.deferrable,
    definition:
      constraint.type === 'c'
        ? normalizeSqlExpressionRequired(constraint.definition)
        : null,
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
        AND NOT source.relispartition
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
    allowedMissing.indexes,
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
        AND NOT relation.relispartition
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
  const expectedPolicies = buildExpectedPolicies(expectedTables);
  compareCatalogCollection(
    drift,
    'managed policy',
    expectedPolicies,
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
        AND NOT relation.relispartition
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
        AND NOT relation.relispartition
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
    buildExpectedColumnGrants(expectedTables, expectedRelations),
    actualColumnGrants,
    (value) =>
      `${value.tableName}.${value.columnName}.${value.grantee}.${value.privilegeType}`,
  );

  const functions = await client.query<{
    arguments: string;
    configuration: string[] | null;
    kind: string;
    language: string;
    name: string;
    owner: string;
    parallel_safety: string;
    result_type: string;
    security_definer: boolean;
    strict: boolean;
    volatility: string;
  }>(
    `SELECT routine.proname AS name,
            pg_get_function_identity_arguments(routine.oid) AS arguments,
            routine.prokind AS kind,
            pg_get_userbyid(routine.proowner) AS owner,
            language.lanname AS language,
            pg_get_function_result(routine.oid) AS result_type,
            routine.provolatile AS volatility,
            routine.proisstrict AS strict,
            routine.prosecdef AS security_definer,
            routine.proparallel AS parallel_safety,
            routine.proconfig AS configuration
       FROM pg_proc AS routine
       JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
       JOIN pg_language AS language ON language.oid = routine.prolang
      WHERE namespace.nspname = 'north_star_module'
      ORDER BY routine.proname, arguments`,
  );
  compareCatalogCollection(
    drift,
    'managed function',
    buildExpectedFunctions(expectedTables),
    functions.rows,
    (value) => `${value.name}(${value.arguments})`,
  );

  const functionGrants = await client.query<{
    arguments: string;
    grantee: string;
    is_grantable: boolean;
    name: string;
    privilege_type: string;
  }>(
    `SELECT routine.proname AS name,
            pg_get_function_identity_arguments(routine.oid) AS arguments,
            COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
            privilege.privilege_type,
            privilege.is_grantable
       FROM pg_proc AS routine
       JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
       CROSS JOIN LATERAL aclexplode(
         COALESCE(routine.proacl, acldefault('f', routine.proowner))
       ) AS privilege
       LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
      WHERE namespace.nspname = 'north_star_module'
      ORDER BY routine.proname, arguments, grantee, privilege.privilege_type`,
  );
  compareCatalogCollection(
    drift,
    'managed function grant',
    buildExpectedFunctionGrants(expectedTables),
    functionGrants.rows,
    (value) =>
      `${value.name}(${value.arguments}).${value.grantee}.${value.privilege_type}`,
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
        AND NOT relation.relispartition
        AND NOT trigger_record.tgisinternal
      ORDER BY relation.relname, trigger_record.tgname`,
  );
  const actualTriggers = triggers.rows.map((trigger) => ({
    definition: normalizeSqlExpressionRequired(trigger.definition),
    name: trigger.name,
    tableName: trigger.table_name,
  }));
  compareCatalogCollection(
    drift,
    'managed trigger',
    buildExpectedTriggers(expectedTables),
    actualTriggers,
    (value) => `${value.tableName}.${value.name}`,
  );

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
          partitionBounds: partitionBounds.rows,
          relations: relations.rows,
          registry,
          drift,
          policies: actualPolicies,
          rules: rules.rows,
          schema,
          schemaGrants: schemaGrants.rows,
          tableGrants: actualTableGrants,
          triggers: actualTriggers,
          types: types.rows,
        }),
      )
      .digest(),
  );
  return Object.freeze({ digest, drift: Object.freeze(drift.toSorted()) });
}

type StorageRelationTarget = StorageTargetPayloadV1['relations'][number];

interface ExpectedColumnShape {
  collation: string | null;
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
  definition: string | null;
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
  allowedMissingKeys: ReadonlySet<string> = new Set(),
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
      if (!allowedMissingKeys.has(key)) {
        drift.push(`missing ${label} ${key}`);
      }
    } else if (canonicalize(expectedValue) !== canonicalize(actualValue)) {
      drift.push(
        `altered ${label} ${key}: expected ${canonicalize(expectedValue)}, actual ${canonicalize(actualValue)}`,
      );
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
  const physicalShape = (value: StorageRelationTarget) => {
    const { archiveBehavior: _archiveBehavior, ...shape } = value;
    void _archiveBehavior;
    return shape;
  };
  // Requiredness relaxation is the one shape difference two live roots may
  // legitimately hold at once. During PREPARE both the source and the target
  // root are accounted live against ONE physical column, and the widening DDL
  // has already run, so the column is nullable and the old root's `NOT NULL`
  // is no longer a claim it can enforce. Merging to the relaxed value is
  // therefore reading the physical truth rather than forgiving a conflict --
  // and it forgives exactly this: `widened` differs from the required shape in
  // `nullable` alone, so any other divergence still conflicts.
  const relaxes = (
    required: StorageRelationTarget,
    optional: StorageRelationTarget,
  ): boolean =>
    !required.relationColumn.nullable &&
    optional.relationColumn.nullable &&
    required.relationColumn.origin !== 'field' &&
    optional.relationColumn.origin !== 'field' &&
    // `archiveBehavior` is stripped by `physicalShape`, so it has to be
    // checked here or a widening would carry a differing one past the
    // conflict branch below, which the widening skips.
    !(
      Object.hasOwn(required, 'archiveBehavior') &&
      Object.hasOwn(optional, 'archiveBehavior') &&
      required.archiveBehavior !== optional.archiveBehavior
    ) &&
    canonicalize(
      physicalShape({
        ...required,
        relationColumn: { ...required.relationColumn, nullable: true },
      }),
    ) === canonicalize(physicalShape(optional));
  for (const relation of targets.flatMap((target) => target.relations)) {
    const key = relation.foreignKey.physicalName;
    const existing = result.get(key);
    const widening =
      existing !== undefined &&
      (relaxes(existing, relation) || relaxes(relation, existing));
    if (
      existing &&
      !widening &&
      (canonicalize(physicalShape(existing)) !==
        canonicalize(physicalShape(relation)) ||
        (Object.hasOwn(existing, 'archiveBehavior') &&
          Object.hasOwn(relation, 'archiveBehavior') &&
          existing.archiveBehavior !== relation.archiveBehavior))
    ) {
      throw failure(
        'LIVE_SET_SHAPE_CONFLICT',
        `conflicting live roots claim managed relation ${key}`,
      );
    }
    if (widening) {
      // Keep the relaxed member, and keep the `archiveBehavior` rule above:
      // a root that declares one outranks a legacy root that omits it.
      const optional = existing.relationColumn.nullable ? existing : relation;
      const declared = Object.hasOwn(relation, 'archiveBehavior')
        ? relation
        : existing;
      result.set(key, {
        ...optional,
        ...(Object.hasOwn(declared, 'archiveBehavior')
          ? { archiveBehavior: declared.archiveBehavior }
          : {}),
      });
      continue;
    }
    result.set(
      key,
      Object.hasOwn(relation, 'archiveBehavior') || !existing
        ? relation
        : existing,
    );
  }
  return result;
}

function buildExpectedManagedRelations(
  tables: ReadonlyMap<string, StorageEntityTarget>,
) {
  return [...tables.values()]
    .flatMap((entity) => [
      {
        forceRowLevelSecurity: true,
        isPartition: false,
        kind: entity.factStorage ? 'p' : 'r',
        name: entity.physicalTableName,
        owner: 'north_star_module_materializer',
        rowLevelSecurity: true,
      },
      ...(entity.factStorage
        ? [
            ...entity.factStorage.partitioning.partitions.map((partition) => ({
              forceRowLevelSecurity: false,
              isPartition: true,
              kind: 'r',
              name: partition.physicalTableName,
              owner: 'north_star_module_materializer',
              rowLevelSecurity: false,
            })),
            {
              forceRowLevelSecurity: true,
              isPartition: false,
              kind: 'r',
              name: entity.factStorage.companion.physicalTableName,
              owner: 'north_star_module_materializer',
              rowLevelSecurity: true,
            },
          ]
        : []),
    ])
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function buildExpectedPartitionBounds(
  tables: ReadonlyMap<string, StorageEntityTarget>,
) {
  return [...tables.values()]
    .flatMap((entity) =>
      (entity.factStorage?.partitioning.partitions ?? []).map((partition) => ({
        bound: normalizeSqlExpressionRequired(
          `FOR VALUES WITH (modulus ${String(partition.modulus)}, remainder ${String(partition.remainder)})`,
        ),
        parentName: entity.physicalTableName,
        partitionName: partition.physicalTableName,
      })),
    )
    .toSorted((left, right) =>
      left.partitionName.localeCompare(right.partitionName),
    );
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
        collation: null,
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
    if (entity.legalEntity) {
      base(
        entity.legalEntity.column,
        entity.legalEntity.postgresqlType,
        entity.legalEntity.nullable,
      );
    }
    if (entity.factStorage) {
      base(
        entity.factStorage.businessPeriod.column,
        entity.factStorage.businessPeriod.postgresqlType,
        false,
      );
    }
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
    for (const column of entity.foldedColumns ?? []) {
      const sourceColumn = entity.columns.find(
        (candidate) => candidate.physicalName === column.sourceColumn,
      );
      if (!sourceColumn) {
        throw failure(
          'CASE_FOLD_CONTRACT_MISSING',
          `stored folded column ${column.physicalName} lacks source ${column.sourceColumn}`,
        );
      }
      add({
        collation: column.collation,
        defaultExpression: normalizeSqlExpressionRequired(
          `north_star_module.${unicodeCaseFoldFunctionName}(${quoted(column.sourceColumn)}${sourceColumn.postgresqlType === 'text' ? '' : '::text'})`,
        ),
        generatedKind: 's',
        identityKind: '',
        name: column.physicalName,
        nullable: true,
        postgresqlType: column.postgresqlType,
        tableName: entity.physicalTableName,
      });
    }
    for (const column of entity.derivedStateFields) {
      base(column.physicalName, column.postgresqlType, true);
    }
    if (entity.factStorage) {
      for (const column of entity.factStorage.companion.columns) {
        add({
          collation: null,
          defaultExpression: null,
          generatedKind: '',
          identityKind: '',
          name: column.name,
          nullable: false,
          postgresqlType: catalogType(column.postgresqlType),
          tableName: entity.factStorage.companion.physicalTableName,
        });
      }
    }
  }
  for (const relation of relations.values()) {
    if (relation.relationColumn.origin === 'field') continue;
    const entity = entityById.get(relation.sourceEntityId);
    if (!entity) {
      throw failure('ENTITY_TARGET_MISSING', relation.sourceEntityId);
    }
    add({
      collation: null,
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
  pendingConstraintNames: ReadonlySet<string>,
): ExpectedConstraintShape[] {
  const entityById = new Map(
    [...tables.values()].map((entity) => [entity.entityId, entity]),
  );
  const legalEntityMaster = [...tables.values()].find(
    (entity) => entity.legalEntityMaster !== undefined,
  );
  const result: ExpectedConstraintShape[] = [...tables.values()].map(
    (entity) => ({
      columns: [...entity.primaryKey.columns],
      deferred: false,
      deferrable: false,
      definition: null,
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
  for (const entity of tables.values()) {
    if (entity.legalEntity) {
      if (!legalEntityMaster) {
        throw failure('LEGAL_ENTITY_MASTER_TARGET_INVALID', entity.entityId);
      }
      result.push({
        columns: ['tenant_id', 'environment_id', entity.legalEntity.column],
        deferred: false,
        deferrable: false,
        definition: null,
        deleteAction: 'r',
        name: legalEntityForeignKeyName(entity),
        referencedColumns: ['tenant_id', 'environment_id', 'record_id'],
        referencedSchema: 'north_star_module',
        referencedTable: legalEntityMaster.physicalTableName,
        tableName: entity.physicalTableName,
        type: 'f',
        updateAction: 'r',
        validated: true,
      });
    }
    if (entity.factStorage) {
      result.push({
        columns: [...entity.factStorage.effectIdentityUnique.columns],
        deferred: false,
        deferrable: false,
        definition: null,
        deleteAction: ' ',
        name: entity.factStorage.effectIdentityUnique.physicalName,
        referencedColumns: null,
        referencedSchema: null,
        referencedTable: null,
        tableName: entity.physicalTableName,
        type: 'u',
        updateAction: ' ',
        validated: true,
      });
      result.push({
        columns: [
          entity.factStorage.businessPeriod.column,
          'tenant_id',
          entity.factStorage.businessPeriod.effectiveAtColumn,
        ],
        deferred: false,
        deferrable: false,
        definition: normalizeSqlExpressionRequired(
          `${entity.factStorage.businessPeriod.column} = north_star_internal.inventory_business_period(tenant_id, ${entity.factStorage.businessPeriod.effectiveAtColumn})`,
        ),
        deleteAction: ' ',
        name: entity.factStorage.businessPeriod.checkConstraintName,
        referencedColumns: null,
        referencedSchema: null,
        referencedTable: null,
        tableName: entity.physicalTableName,
        type: 'c',
        updateAction: ' ',
        validated: true,
      });
      const companion = entity.factStorage.companion;
      result.push(
        {
          columns: [...companion.primaryKey.columns],
          deferred: false,
          deferrable: false,
          definition: null,
          deleteAction: ' ',
          name: companion.primaryKey.physicalName,
          referencedColumns: null,
          referencedSchema: null,
          referencedTable: null,
          tableName: companion.physicalTableName,
          type: 'p',
          updateAction: ' ',
          validated: true,
        },
        {
          columns: [...companion.movementUnique.columns],
          deferred: false,
          deferrable: false,
          definition: null,
          deleteAction: ' ',
          name: companion.movementUnique.physicalName,
          referencedColumns: null,
          referencedSchema: null,
          referencedTable: null,
          tableName: companion.physicalTableName,
          type: 'u',
          updateAction: ' ',
          validated: true,
        },
        {
          columns: [...companion.movementForeignKey.sourceColumns],
          deferred: false,
          deferrable: false,
          definition: null,
          deleteAction: 'r',
          name: companion.movementForeignKey.physicalName,
          referencedColumns: [...companion.movementForeignKey.targetColumns],
          referencedSchema: 'north_star_module',
          referencedTable: entity.physicalTableName,
          tableName: companion.physicalTableName,
          type: 'f',
          updateAction: 'r',
          validated: true,
        },
      );
      for (const check of entity.factStorage.stockIdentityV1MemberChecks) {
        result.push({
          columns: [check.column],
          deferred: false,
          deferrable: false,
          definition: normalizeSqlExpressionRequired(
            `btrim(${check.column}::text) <> ${sqlTextLiteral('')} AND ${check.column}::text <> ${sqlTextLiteral(check.rejectedSentinel)}`,
          ),
          deleteAction: ' ',
          name: check.physicalName,
          referencedColumns: null,
          referencedSchema: null,
          referencedTable: null,
          tableName: entity.physicalTableName,
          type: 'c',
          updateAction: ' ',
          validated: true,
        });
      }
    }
    for (const check of entity.abiFunctionChecks ?? []) {
      result.push({
        columns: [
          'tenant_id',
          'environment_id',
          check.itemIdColumn,
          check.unitIdColumn,
        ],
        deferred: false,
        deferrable: false,
        definition: normalizeSqlExpressionRequired(
          `north_star_internal.inventory_base_unit_change_allowed(tenant_id, environment_id, ${check.itemIdColumn}, ${check.unitIdColumn}::text, ${sqlTextLiteral(`north_star_module.${check.movementTableName}`)}::regclass, ${sqlTextLiteral(check.movementItemIdColumn)}::name, ${sqlTextLiteral(check.movementUnitIdColumn)}::name, ${sqlTextLiteral(check.movementRecordedAtColumn)}::name, ${sqlTextLiteral(check.movementRecordIdColumn)}::name)`,
        ),
        deleteAction: ' ',
        name: check.physicalName,
        referencedColumns: null,
        referencedSchema: null,
        referencedTable: null,
        tableName: entity.physicalTableName,
        type: 'c',
        updateAction: ' ',
        validated: true,
      });
    }
  }
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
      definition: null,
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
  for (const entity of tables.values()) {
    for (const check of entity.checkConstraints ?? []) {
      result.push({
        columns: [
          requiredStorageColumn(entity, check.canonicalFieldId).physicalName,
        ],
        deferred: false,
        deferrable: false,
        definition: normalizeSqlExpressionRequired(
          enumCheckExpression(entity, check),
        ),
        deleteAction: ' ',
        name: check.physicalName,
        referencedColumns: null,
        referencedSchema: null,
        referencedTable: null,
        tableName: entity.physicalTableName,
        type: 'c',
        updateAction: ' ',
        validated: false,
      });
    }
  }
  return result
    .filter((constraint) => !pendingConstraintNames.has(constraint.name))
    .toSorted((left, right) =>
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
        null,
        entity.factStorage !== undefined,
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
    if (entity.factStorage) {
      const effectUnique = entity.factStorage.effectIdentityUnique;
      result.push({
        columns: [...effectUnique.columns],
        constraintName: effectUnique.physicalName,
        definition: expectedIndexDefinition(
          entity.physicalTableName,
          effectUnique.physicalName,
          effectUnique.columns,
          true,
          null,
          true,
        ),
        name: effectUnique.physicalName,
        owner: 'north_star_module_materializer',
        predicate: null,
        primary: false,
        ready: true,
        tableName: entity.physicalTableName,
        unique: true,
        valid: true,
      });
      for (const constraint of [
        entity.factStorage.companion.primaryKey,
        entity.factStorage.companion.movementUnique,
      ]) {
        result.push({
          columns: [...constraint.columns],
          constraintName: constraint.physicalName,
          definition: expectedIndexDefinition(
            entity.factStorage.companion.physicalTableName,
            constraint.physicalName,
            constraint.columns,
            true,
          ),
          name: constraint.physicalName,
          owner: 'north_star_module_materializer',
          predicate: null,
          primary:
            constraint.physicalName ===
            entity.factStorage.companion.primaryKey.physicalName,
          ready: true,
          tableName: entity.factStorage.companion.physicalTableName,
          unique: true,
          valid: true,
        });
      }
    }
    for (const unique of entity.uniqueKeys) {
      const columns = uniqueKeyColumnExpressions(entity, unique);
      const predicate = uniqueKeyPredicateSql(entity, unique);
      result.push({
        columns: columns.map(normalizeSqlExpressionRequired),
        constraintName: null,
        definition: expectedIndexDefinition(
          entity.physicalTableName,
          unique.physicalName,
          columns,
          true,
          predicate,
          entity.factStorage !== undefined,
        ),
        name: unique.physicalName,
        owner: 'north_star_module_materializer',
        predicate: normalizeSqlExpressionRequired(predicate),
        primary: false,
        ready: true,
        tableName: entity.physicalTableName,
        unique: true,
        valid: true,
      });
    }
    for (const index of entity.indexes) {
      const columns = indexColumnExpressions(entity, index);
      const predicate = indexPredicateSql(entity, index);
      result.push({
        columns: columns.map(normalizeSqlExpressionRequired),
        constraintName: null,
        definition: expectedIndexDefinition(
          entity.physicalTableName,
          index.physicalName,
          columns,
          isUniqueStorageIndex(index),
          predicate,
          entity.factStorage !== undefined,
        ),
        name: index.physicalName,
        owner: 'north_star_module_materializer',
        predicate: normalizeSqlExpression(predicate),
        primary: false,
        ready: true,
        tableName: entity.physicalTableName,
        unique: isUniqueStorageIndex(index),
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
  predicate: string | null = null,
  only = false,
): string {
  return normalizeSqlExpressionRequired(
    `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${indexName}
       ON ${only ? 'ONLY ' : ''}north_star_module.${tableName} USING btree (${columns.join(', ')})${predicate ? ` WHERE ${predicate}` : ''}`,
  );
}

function indexColumnExpressions(
  entity: StorageEntityTarget,
  index: StorageEntityTarget['indexes'][number],
): string[] {
  if (index.indexKind !== 'caseInsensitiveUnique') {
    return index.columnNames.map(quoted);
  }
  const unique = entity.uniqueKeys.find(
    (candidate) =>
      candidate.columns.length === index.columnNames.length &&
      candidate.columns.every(
        (column, position) => column === index.columnNames[position],
      ),
  );
  if (!unique) {
    throw failure(
      'CASE_FOLD_CONTRACT_MISSING',
      `case-insensitive index ${index.physicalName} lacks its unicodeCaseFold unique contract`,
    );
  }
  return uniqueKeyColumnExpressions(entity, unique);
}

function uniqueKeyColumnExpressions(
  entity: StorageEntityTarget,
  unique: StorageEntityTarget['uniqueKeys'][number],
): string[] {
  if (
    unique.collation !== 'unicodeCaseInsensitive' ||
    unique.normalization !== 'unicodeCaseFold'
  ) {
    throw failure(
      'CASE_FOLD_CONTRACT_UNSUPPORTED',
      `unique key ${unique.physicalName} has an unsupported normalization contract`,
    );
  }
  const scopeColumns = new Set(
    entity.businessKeyScopeColumns ?? entity.scopeKeyColumns,
  );
  return unique.columns.map((column) =>
    scopeColumns.has(column as (typeof entity.scopeKeyColumns)[number])
      ? quoted(column)
      : foldedColumnExpression(entity, column),
  );
}

function uniqueKeyPredicateSql(
  entity: StorageEntityTarget,
  unique: StorageEntityTarget['uniqueKeys'][number],
): string {
  return archiveExcludingPredicateSql(entity, unique.predicate);
}

function indexPredicateSql(
  entity: StorageEntityTarget,
  index: StorageEntityTarget['indexes'][number],
): string | null {
  if (index.indexKind === 'caseInsensitiveUnique') {
    return archiveExcludingPredicateSql(entity, index.predicate);
  }
  if (index.indexKind === 'legalEntityDefaultUnique') {
    const master = entity.legalEntityMaster;
    const expected = master?.defaultUniqueIndex;
    if (
      !master ||
      !expected ||
      index.physicalName !== expected.physicalName ||
      index.predicate !== expected.predicate
    ) {
      throw failure(
        'LEGAL_ENTITY_DEFAULT_INDEX_INVALID',
        `legal-entity default index ${index.physicalName} does not match its pinned target`,
      );
    }
    return `${quoted(master.fieldColumns.isDefault)} IS TRUE AND ${quoted(entity.archive.archivedAtColumn)} IS NULL`;
  }
  if (index.predicate !== null && index.predicate !== undefined) {
    throw failure(
      'INDEX_PREDICATE_UNSUPPORTED',
      `non-unique index ${index.physicalName} declares an unsupported predicate`,
    );
  }
  return null;
}

function isUniqueStorageIndex(
  index: StorageEntityTarget['indexes'][number],
): boolean {
  return (
    index.indexKind === 'caseInsensitiveUnique' ||
    index.indexKind === 'legalEntityDefaultUnique' ||
    index.indexKind === 'periodLockScopeUnique'
  );
}

function archiveExcludingPredicateSql(
  entity: StorageEntityTarget,
  declaredPredicate: string | null | undefined,
): string {
  const expected = `${entity.archive.archivedAtColumn} IS NULL`;
  if (declaredPredicate !== undefined && declaredPredicate !== expected) {
    throw failure(
      'INDEX_PREDICATE_UNSUPPORTED',
      `unique index predicate must be ${expected}`,
    );
  }
  return `${quoted(entity.archive.archivedAtColumn)} IS NULL`;
}

function foldedColumnExpression(
  entity: StorageEntityTarget,
  sourceColumn: string,
): string {
  const foldedColumn = (entity.foldedColumns ?? []).find(
    (candidate) => candidate.sourceColumn === sourceColumn,
  );
  if (foldedColumn) return quoted(foldedColumn.physicalName);
  if (!Object.hasOwn(entity, 'foldedColumns')) {
    return unicodeCaseFoldSql(quoted(sourceColumn));
  }
  throw failure(
    'CASE_FOLD_CONTRACT_MISSING',
    `source column ${sourceColumn} lacks its stored folded companion`,
  );
}

function unicodeCaseFoldSql(valueExpression: string): string {
  return `north_star_module.${unicodeCaseFoldFunctionName}(${valueExpression}::text)`;
}

async function ensureUnicodeCaseFoldFunction(
  client: PoolClient,
): Promise<void> {
  const expectedSource = unicodeCaseFoldFunctionSource();
  const existing = await client.query<{ source: string }>(
    `SELECT routine.prosrc AS source
       FROM pg_proc AS routine
       JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'north_star_module'
        AND routine.proname = $1
        AND pg_get_function_identity_arguments(routine.oid) = 'value text'`,
    [unicodeCaseFoldFunctionName],
  );
  if (existing.rows.length > 1) {
    throw failure(
      'CASE_FOLD_FUNCTION_IDENTITY_AMBIGUOUS',
      `${unicodeCaseFoldFunctionName}(value text) resolved to ${String(existing.rows.length)} catalog entries`,
    );
  }
  const source = existing.rows[0]?.source;
  if (source !== undefined) {
    if (source !== expectedSource) {
      throw failure(
        'CASE_FOLD_FUNCTION_DEFINITION_MISMATCH',
        `${unicodeCaseFoldFunctionName}(value text) exists with a different body; versioned fold functions are immutable`,
      );
    }
    return;
  }
  await client.query(
    `CREATE FUNCTION north_star_module.${unicodeCaseFoldFunctionName}(value text)
       RETURNS text
       LANGUAGE sql
       IMMUTABLE STRICT PARALLEL SAFE
       SET search_path = pg_catalog
       AS $case_fold$${expectedSource}$case_fold$;
     REVOKE ALL ON FUNCTION north_star_module.${unicodeCaseFoldFunctionName}(text) FROM PUBLIC;
     GRANT EXECUTE ON FUNCTION north_star_module.${unicodeCaseFoldFunctionName}(text)
       TO north_star_module_runtime`,
  );
}

function unicodeCaseFoldFunctionSource(): string {
  return `
         SELECT ${unicodeCaseFoldImplementationSql('value')}
       `;
}

function unicodeCaseFoldImplementationSql(valueExpression: string): string {
  let folded = `translate(${valueExpression}, ${sqlTextLiteral(UNICODE_CASE_FOLD_SIMPLE_SOURCES)}, ${sqlTextLiteral(UNICODE_CASE_FOLD_SIMPLE_TARGETS)})`;
  for (const [source, target] of UNICODE_CASE_FOLD_EXPANSIONS) {
    folded = `replace(${folded}, ${sqlTextLiteral(source)}, ${sqlTextLiteral(target)})`;
  }
  return folded;
}

function sqlTextLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'::text`;
}

function buildExpectedFunctions(
  tables: ReadonlyMap<string, StorageEntityTarget>,
) {
  if (tables.size === 0) return [];
  return [
    {
      arguments: 'value text',
      configuration: ['search_path=pg_catalog'],
      kind: 'f',
      language: 'sql',
      name: unicodeCaseFoldFunctionName,
      owner: 'north_star_module_materializer',
      parallel_safety: 's',
      result_type: 'text',
      security_definer: false,
      strict: true,
      volatility: 'i',
    },
    ...(postedStockBalanceProjectionFromEntities([...tables.values()])
      ? [
          {
            arguments: '',
            configuration: ['search_path=pg_catalog, north_star_internal'],
            kind: 'f',
            language: 'plpgsql',
            name: postedStockBalanceFunctionName,
            owner: 'north_star_module_materializer',
            parallel_safety: 'u',
            result_type: 'trigger',
            security_definer: false,
            strict: false,
            volatility: 'v',
          },
        ]
      : []),
  ];
}

function buildExpectedFunctionGrants(
  tables: ReadonlyMap<string, StorageEntityTarget>,
) {
  if (tables.size === 0) return [];
  return [
    {
      arguments: 'value text',
      grantee: 'north_star_module_materializer',
      is_grantable: false,
      name: unicodeCaseFoldFunctionName,
      privilege_type: 'EXECUTE',
    },
    {
      arguments: 'value text',
      grantee: 'north_star_module_runtime',
      is_grantable: false,
      name: unicodeCaseFoldFunctionName,
      privilege_type: 'EXECUTE',
    },
    ...(postedStockBalanceProjectionFromEntities([...tables.values()])
      ? [
          {
            arguments: '',
            grantee: 'north_star_module_materializer',
            is_grantable: false,
            name: postedStockBalanceFunctionName,
            privilege_type: 'EXECUTE',
          },
        ]
      : []),
  ];
}

function buildExpectedTriggers(
  tables: ReadonlyMap<string, StorageEntityTarget>,
) {
  const legalEntityMaster = [...tables.values()].find(
    (entity) => entity.legalEntityMaster !== undefined,
  );
  const postedStockProjection = postedStockBalanceProjectionFromEntities([
    ...tables.values(),
  ]);
  const triggers = [...tables.values()].flatMap((entity) => {
    const triggers: Array<{
      definition?: string;
      name: string;
      tableName: string;
    }> = [];
    if (entity.factStorage) {
      triggers.push(
        {
          definition: `CREATE TRIGGER ${entity.factStorage.companion.reservationTriggerName} AFTER INSERT ON north_star_module.${entity.physicalTableName} FOR EACH ROW EXECUTE FUNCTION north_star_internal.reserve_inventory_movement_effect('north_star_module.${entity.factStorage.companion.physicalTableName}')`,
          name: entity.factStorage.companion.reservationTriggerName,
          tableName: entity.physicalTableName,
        },
        {
          name: entity.factStorage.rejectMutationTriggerName,
          tableName: entity.physicalTableName,
        },
        {
          name: entity.factStorage.companion.rejectMutationTriggerName,
          tableName: entity.factStorage.companion.physicalTableName,
        },
      );
    }
    if (entity.periodLock) {
      if (!legalEntityMaster) {
        throw failure(
          'LEGAL_ENTITY_MASTER_TARGET_INVALID',
          'period-lock provisioning requires a legal-entity master',
        );
      }
      triggers.push({
        definition: `CREATE TRIGGER ${entity.periodLock.provisioningTriggerName} AFTER INSERT ON north_star_module.${legalEntityMaster.physicalTableName} FOR EACH ROW EXECUTE FUNCTION north_star_internal.provision_inventory_period_lock('north_star_module.${entity.physicalTableName}')`,
        name: entity.periodLock.provisioningTriggerName,
        tableName: legalEntityMaster.physicalTableName,
      });
    }
    return triggers.map((trigger) => ({
      definition: normalizeSqlExpressionRequired(
        trigger.definition !== undefined
          ? trigger.definition
          : `CREATE TRIGGER ${trigger.name} BEFORE DELETE OR UPDATE ON north_star_module.${trigger.tableName} FOR EACH ROW EXECUTE FUNCTION north_star_internal.reject_inventory_fact_mutation()`,
      ),
      name: trigger.name,
      tableName: trigger.tableName,
    }));
  });
  if (postedStockProjection) {
    triggers.push({
      definition: normalizeSqlExpressionRequired(
        `CREATE TRIGGER ${postedStockProjection.triggerName} AFTER INSERT ON north_star_module.${postedStockProjection.movement.physicalTableName} FOR EACH ROW EXECUTE FUNCTION north_star_module.${postedStockBalanceFunctionName}(${postedStockBalanceTriggerArguments(postedStockProjection).map(triggerArgumentLiteral).join(', ')})`,
      ),
      name: postedStockProjection.triggerName,
      tableName: postedStockProjection.movement.physicalTableName,
    });
  }
  return triggers.toSorted((left, right) =>
    `${left.tableName}.${left.name}`.localeCompare(
      `${right.tableName}.${right.name}`,
    ),
  );
}

function buildExpectedPolicies(
  tables: ReadonlyMap<string, StorageEntityTarget>,
) {
  const predicate = normalizePolicyExpression(
    `tenant_id = north_star_internal.trusted_tenant_id()
     AND environment_id = north_star_internal.trusted_environment_id()`,
  );
  const materializerPredicate = normalizePolicyExpression(
    `tenant_id = NULLIF(current_setting('north_star.tenant_id'::text, true), ''::text)::uuid
     AND environment_id = NULLIF(current_setting('north_star.environment_id'::text, true), ''::text)::uuid`,
  );
  return [...tables.values()].flatMap((entity) => {
    const postedStockProjection = isPostedStockBalanceEntity(entity);
    const triggerMutationPredicate = normalizePolicyExpression(
      `tenant_id = north_star_internal.trusted_tenant_id()
       AND environment_id = north_star_internal.trusted_environment_id()
       AND pg_trigger_depth() > 0`,
    );
    const tablePolicies = [
      {
        commands: entity.factStorage
          ? (['SELECT', 'INSERT'] as const)
          : entity.periodLock
            ? (['SELECT', 'UPDATE'] as const)
            : (['SELECT', 'INSERT', 'UPDATE'] as const),
        tableName: entity.physicalTableName,
      },
      ...(entity.factStorage
        ? [
            {
              commands: ['SELECT', 'INSERT'] as const,
              tableName: entity.factStorage.companion.physicalTableName,
            },
          ]
        : []),
    ];
    return [
      ...tablePolicies.flatMap(({ commands, tableName }) =>
        commands.map((command) => {
          const effectivePredicate =
            postedStockProjection &&
            tableName === entity.physicalTableName &&
            command !== 'SELECT'
              ? triggerMutationPredicate
              : predicate;
          return {
            command,
            name: managedPolicyName(tableName, command),
            permissive: true,
            qual: command === 'INSERT' ? null : effectivePredicate,
            roles: ['north_star_module_runtime'],
            tableName,
            withCheck: command === 'SELECT' ? null : effectivePredicate,
          };
        }),
      ),
      ...(entity.factStorage || entity.legalEntity || entity.legalEntityMaster
        ? tablePolicies
        : []
      ).map(({ tableName }) => ({
        command: 'SELECT' as const,
        name: managedMaterializerPolicyName(tableName),
        permissive: true,
        qual: materializerPredicate,
        roles: ['north_star_module_materializer'],
        tableName,
        withCheck: null,
      })),
      // Seeding is confined to the legal-entity master and the period-lock
      // table, so only those two carry a materializer INSERT policy.
      ...(entity.legalEntityMaster || entity.periodLock
        ? [
            {
              command: 'INSERT' as const,
              name: managedMaterializerSeedInsertPolicyName(
                entity.physicalTableName,
              ),
              permissive: true,
              qual: null,
              roles: ['north_star_module_materializer'],
              tableName: entity.physicalTableName,
              withCheck: materializerPredicate,
            },
          ]
        : []),
      ...(postedStockProjection
        ? (['INSERT', 'UPDATE'] as const).map((command) => ({
            command,
            name: managedMaterializerProjectionPolicyName(
              entity.physicalTableName,
              command,
            ),
            permissive: true,
            qual: command === 'INSERT' ? null : materializerPredicate,
            roles: ['north_star_module_materializer'],
            tableName: entity.physicalTableName,
            withCheck: materializerPredicate,
          }))
        : []),
    ];
  });
}

function buildExpectedTableGrants(
  tables: ReadonlyMap<string, StorageEntityTarget>,
) {
  return [...tables.values()].flatMap((entity) =>
    [
      entity.physicalTableName,
      ...(entity.factStorage
        ? [entity.factStorage.companion.physicalTableName]
        : []),
    ].flatMap((tableName) =>
      ['north_star_module_materializer', 'north_star_module_runtime'].flatMap(
        (grantee) => {
          const companion =
            entity.factStorage?.companion.physicalTableName === tableName;
          const createOnly = companion
            ? true
            : grantee === 'north_star_module_runtime' &&
              (entity.factStorage !== undefined ||
                entity.legalEntity !== undefined);
          const privilegeTypes =
            grantee === 'north_star_module_runtime' && entity.periodLock
              ? ['SELECT']
              : createOnly
                ? ['INSERT', 'SELECT']
                : ['INSERT', 'SELECT', 'UPDATE'];
          return privilegeTypes.map((privilegeType) => ({
            grantee,
            isGrantable: false,
            privilegeType,
            tableName,
          }));
        },
      ),
    ),
  );
}

function buildExpectedColumnGrants(
  tables: ReadonlyMap<string, StorageEntityTarget>,
  relations: ReadonlyMap<string, StorageRelationTarget>,
) {
  return [...tables.values()].flatMap((entity) =>
    entity.periodLock
      ? [
          entity.periodLock.closedThroughColumn,
          entity.optimisticRevision.column,
        ].map((columnName) => ({
          columnName,
          grantee: 'north_star_module_runtime',
          isGrantable: false,
          privilegeType: 'UPDATE',
          tableName: entity.physicalTableName,
        }))
      : entity.legalEntity && !entity.factStorage
        ? entityOwnedMutableColumnNamesFromRelations(entity, relations).map(
            (columnName) => ({
              columnName,
              grantee: 'north_star_module_runtime',
              isGrantable: false,
              privilegeType: 'UPDATE',
              tableName: entity.physicalTableName,
            }),
          )
        : [],
  );
}

function legalEntityForeignKeyName(entity: StorageEntityTarget): string {
  return managedEntityConstraintName(entity, 'e');
}

function managedEntityConstraintName(
  entity: StorageEntityTarget,
  prefix: 'e',
): string {
  const match = /^nsm_t_([a-z2-7]{52})$/u.exec(entity.physicalTableName);
  if (!match?.[1]) {
    throw failure(
      'PHYSICAL_TABLE_NAME_INVALID',
      `managed entity table has invalid name ${entity.physicalTableName}`,
    );
  }
  return `nsm_${prefix}_${match[1]}`;
}

function requiredLegalEntityMaster(
  target: StorageTargetPayloadV1,
): StorageEntityTarget {
  const masters = target.entities.filter(
    (entity) => entity.legalEntityMaster !== undefined,
  );
  if (masters.length !== 1) {
    throw failure(
      'LEGAL_ENTITY_MASTER_TARGET_INVALID',
      `expected one compiled legal-entity master, received ${String(masters.length)}`,
    );
  }
  return masters[0]!;
}

function entityOwnedMutableColumnNames(
  target: StorageTargetPayloadV1,
  entity: StorageEntityTarget,
): string[] {
  return entityOwnedMutableColumnNamesFromRelations(
    entity,
    new Map(
      target.relations.map((relation) => [
        relation.foreignKey.physicalName,
        relation,
      ]),
    ),
  );
}

function entityOwnedMutableColumnNamesFromRelations(
  entity: StorageEntityTarget,
  relations: ReadonlyMap<string, StorageRelationTarget>,
): string[] {
  return [
    ...new Set([
      entity.optimisticRevision.column,
      entity.archive.archivedAtColumn,
      ...entity.columns.map((column) => column.physicalName),
      ...[...relations.values()]
        .filter((relation) => relation.sourceEntityId === entity.entityId)
        .map((relation) => relation.relationColumn.physicalName),
      ...entity.derivedStateFields.map((column) => column.physicalName),
    ]),
  ].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
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

function managedMaterializerPolicyName(tableName: string): string {
  return `nsm_p_${createHash('sha256')
    .update(tableName)
    .update('\0')
    .update('MATERIALIZER_SELECT')
    .digest('hex')
    .slice(0, 32)}`;
}

function managedMaterializerSeedInsertPolicyName(tableName: string): string {
  return `nsm_p_${createHash('sha256')
    .update(tableName)
    .update('\0')
    .update('MATERIALIZER_SEED_INSERT')
    .digest('hex')
    .slice(0, 32)}`;
}

function managedMaterializerProjectionPolicyName(
  tableName: string,
  command: 'INSERT' | 'UPDATE',
): string {
  return `nsm_p_${createHash('sha256')
    .update(tableName)
    .update('\0')
    .update(`MATERIALIZER_POSTED_STOCK_${command}`)
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
  const scopes = await client.query<{
    environment_id: string;
    tenant_id: string;
  }>(
    `SELECT DISTINCT tenant_id, environment_id
       FROM north_star_internal.module_storage_generations`,
  );
  const targets = [...initial];
  try {
    for (const scope of scopes.rows) {
      await client.query(
        `SELECT set_config('north_star.tenant_id', $1, true),
                set_config('north_star.environment_id', $2, true)`,
        [scope.tenant_id, scope.environment_id],
      );
      const roots = await client.query<{ release_id: string }>(
        `SELECT release_id
           FROM north_star_internal.module_storage_read_kernel_live_roots($1, $2)`,
        [scope.tenant_id, scope.environment_id],
      );
      for (const root of roots.rows) {
        targets.push(
          (
            await loadVerifiedReleaseStorage(
              client,
              scope.tenant_id,
              scope.environment_id,
              root.release_id,
            )
          ).target,
        );
      }
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
      abiFunctionChecks: _abiFunctionChecks,
      columns: _columns,
      checkConstraints: _checkConstraints,
      consumerWriterRoots: _consumerWriterRoots,
      derivedStateFields: _derivedStateFields,
      foldedColumns: _foldedColumns,
      indexes: _indexes,
      uniqueKeys: _uniqueKeys,
      ...base
    } = entity;
    void _abiFunctionChecks;
    void _columns;
    void _checkConstraints;
    void _consumerWriterRoots;
    void _derivedStateFields;
    void _foldedColumns;
    void _indexes;
    void _uniqueKeys;
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
  const mergeColumns = (): StorageEntityTarget['columns'] => {
    const values = new Map(
      prior.columns.map((column) => [column.physicalName, column]),
    );
    for (const column of next.columns) {
      const existing = values.get(column.physicalName);
      if (!existing) {
        values.set(column.physicalName, column);
        continue;
      }
      const withoutContract = (
        value: StorageEntityTarget['columns'][number],
      ) => {
        const { fieldContract: _fieldContract, ...shape } = value;
        void _fieldContract;
        return shape;
      };
      const withoutSearchMetadata = (
        value: StorageEntityTarget['columns'][number],
      ) => {
        const {
          fieldContract: _fieldContract,
          searchMapping: _searchMapping,
          shapeFingerprint: _shapeFingerprint,
          ...shape
        } = value;
        void _fieldContract;
        void _searchMapping;
        void _shapeFingerprint;
        return shape;
      };
      const searchMappingPairIsAdditive =
        new Set([existing.searchMapping, column.searchMapping]).size === 2 &&
        new Set([existing.searchMapping, column.searchMapping]).has('none') &&
        new Set([existing.searchMapping, column.searchMapping]).has(
          'normalizedTextIndex',
        );
      const contractsMatch =
        !Object.hasOwn(existing, 'fieldContract') ||
        !Object.hasOwn(column, 'fieldContract') ||
        canonicalize(existing.fieldContract) ===
          canonicalize(column.fieldContract);
      const additiveSearchMappingIsCompatible =
        searchMappingPairIsAdditive &&
        contractsMatch &&
        canonicalize(withoutSearchMetadata(existing)) ===
          canonicalize(withoutSearchMetadata(column));
      if (
        !additiveSearchMappingIsCompatible &&
        (canonicalize(withoutContract(existing)) !==
          canonicalize(withoutContract(column)) ||
          !contractsMatch)
      ) {
        throw failure(
          'LIVE_SET_SHAPE_CONFLICT',
          `conflicting live roots claim ${next.physicalTableName}.${column.physicalName}`,
        );
      }
      if (
        Object.hasOwn(column, 'fieldContract') &&
        (column.searchMapping === 'normalizedTextIndex' ||
          existing.searchMapping !== 'normalizedTextIndex')
      ) {
        values.set(column.physicalName, column);
      }
    }
    return [...values.values()].toSorted((left, right) =>
      left.physicalName < right.physicalName
        ? -1
        : left.physicalName > right.physicalName
          ? 1
          : 0,
    );
  };
  const mergeIndexes = (): StorageEntityTarget['indexes'] => {
    const values = new Map(
      prior.indexes.map((index) => [index.physicalName, index]),
    );
    for (const index of next.indexes) {
      const existing = values.get(index.physicalName);
      if (!existing) {
        values.set(index.physicalName, index);
        continue;
      }
      const effective = (value: typeof index) => ({
        ...value,
        predicate:
          value.indexKind === 'caseInsensitiveUnique'
            ? (value.predicate ?? `${next.archive.archivedAtColumn} IS NULL`)
            : (value.predicate ?? null),
      });
      if (
        canonicalize(effective(existing)) !== canonicalize(effective(index))
      ) {
        throw failure(
          'LIVE_SET_SHAPE_CONFLICT',
          `conflicting live roots claim ${next.physicalTableName}.${index.physicalName}`,
        );
      }
      if (Object.hasOwn(index, 'predicate'))
        values.set(index.physicalName, index);
    }
    return [...values.values()].toSorted((left, right) =>
      left.physicalName.localeCompare(right.physicalName),
    );
  };
  const mergeUniqueKeys = (): StorageEntityTarget['uniqueKeys'] => {
    const values = new Map(
      prior.uniqueKeys.map((unique) => [unique.physicalName, unique]),
    );
    for (const unique of next.uniqueKeys) {
      const existing = values.get(unique.physicalName);
      if (!existing) {
        values.set(unique.physicalName, unique);
        continue;
      }
      const effective = (value: typeof unique) => ({
        ...value,
        predicate:
          value.predicate ?? `${next.archive.archivedAtColumn} IS NULL`,
      });
      if (
        canonicalize(effective(existing)) !== canonicalize(effective(unique))
      ) {
        throw failure(
          'LIVE_SET_SHAPE_CONFLICT',
          `conflicting live roots claim ${next.physicalTableName}.${unique.physicalName}`,
        );
      }
      if (Object.hasOwn(unique, 'predicate')) {
        values.set(unique.physicalName, unique);
      }
    }
    return [...values.values()].toSorted((left, right) =>
      left.physicalName.localeCompare(right.physicalName),
    );
  };
  return {
    ...next,
    abiFunctionChecks: mergeNamed(
      prior.abiFunctionChecks ?? [],
      next.abiFunctionChecks ?? [],
      (value) => value.physicalName,
    ),
    checkConstraints: mergeNamed(
      prior.checkConstraints ?? [],
      next.checkConstraints ?? [],
      (value) => value.physicalName,
    ),
    columns: mergeColumns(),
    derivedStateFields: mergeNamed(
      prior.derivedStateFields,
      next.derivedStateFields,
      (value) => value.physicalName,
    ),
    foldedColumns: mergeNamed(
      prior.foldedColumns ?? [],
      next.foldedColumns ?? [],
      (value) => value.physicalName,
    ),
    indexes: mergeIndexes(),
    uniqueKeys: mergeUniqueKeys(),
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
  const roots = await loadLiveRoots(client, command.context);
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
      `UPDATE north_star_internal.module_storage_reference_counts
          SET live_root_count = 0,
              last_full_reconciliation_at = transaction_timestamp(),
              updated_at = transaction_timestamp()
        WHERE tenant_id = $1 AND environment_id = $2 AND generation_id = $3`,
      [context.tenantId, context.environmentId, generation],
    );
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
): Promise<string[]> {
  const result = await client.query<{ release_id: string }>(
    `SELECT release_id
       FROM north_star_internal.module_storage_read_kernel_live_roots($1, $2)`,
    [context.tenantId, context.environmentId],
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

function locateFoldedColumn(
  target: StorageTargetPayloadV1,
  element: StorageTransitionElement,
): {
  column: NonNullable<StorageEntityTarget['foldedColumns']>[number];
  entity: StorageEntityTarget;
} | null {
  for (const entity of target.entities) {
    const column = (entity.foldedColumns ?? []).find(
      (candidate) => candidate.physicalName === element.physicalObjectName,
    );
    if (column) return { column, entity };
  }
  return null;
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

function locateCheckConstraint(
  target: StorageTargetPayloadV1,
  element: StorageTransitionElement,
) {
  for (const entity of target.entities) {
    const check = (entity.checkConstraints ?? []).find(
      (candidate) => candidate.physicalName === element.physicalObjectName,
    );
    if (check) return { check, entity };
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
            (phase === 'attempt' && executesInApprovedAttempt(element))
              ? ('APPLIED' as const)
              : executesInApprovedAttempt(element)
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

function executesInApprovedAttempt(element: StorageTransitionElement): boolean {
  return (
    element.classification.preparationValidity === 'inAttemptOnly' ||
    element.classification.preparationValidity === 'deferredOnlineFamily'
  );
}

function allowedMissingDeferredOnlineObjects(
  target: StorageTargetPayloadV1,
  elements: readonly StorageTransitionElement[],
): AllowedMissingCatalogObjects {
  const columns = new Set<string>();
  const indexes = new Set<string>();
  for (const element of elements) {
    if (element.classification.preparationValidity !== 'deferredOnlineFamily') {
      continue;
    }
    if (element.kind === 'addColumn') {
      const folded = locateFoldedColumn(target, element);
      if (!folded) {
        throw failure(
          'DEFERRED_ONLINE_KIND_UNSUPPORTED',
          `deferred addColumn ${element.elementId} is not a generated fold`,
        );
      }
      columns.add(
        `${folded.entity.physicalTableName}.${folded.column.physicalName}`,
      );
      continue;
    }
    if (element.kind === 'createIndex') {
      const located = locateIndex(target, element);
      indexes.add(
        `${located.entity.physicalTableName}.${located.index.physicalName}`,
      );
      continue;
    }
    throw failure(
      'DEFERRED_ONLINE_KIND_UNSUPPORTED',
      `${element.kind} cannot execute in the locking DDL family`,
    );
  }
  return { columns, indexes };
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
