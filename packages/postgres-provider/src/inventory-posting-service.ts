import { createHash, randomUUID } from 'node:crypto';

import { canonicalize } from '@north-star/canonical-model';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import {
  assertTrustedRequestContext,
  type TrustedRequestContext,
} from '@north-star/runtime';
import type { Pool, PoolClient } from 'pg';

import {
  ACTION_INVOCATION_VERSION,
  BUSINESS_CHANGE_DOCUMENT_VERSION,
  POLICY_DECISION_EVIDENCE_VERSION,
  TRUST_DOMAIN_EVENT_VERSION,
  TRUST_OUTBOX_VERSION,
  redactBusinessChanges,
  redactEvidenceMetadata,
  type BusinessFieldChangeInput,
  type InvocationChannel,
  type ResolvedActorAttribution,
  type TrustedActorEnvelope,
} from '../../platform-runtime/src/trust/contracts.js';
import {
  loadInventoryPostingConfiguration,
  type InventoryPostingConfiguration,
} from './migrations.js';
import {
  acquireStockIdentityLocks,
  STOCK_IDENTITY_LOCK_NAMESPACE,
  type ScopedStockIdentityV1,
} from './stock-serializer.js';
import { assertTrustedActorEnvelope } from './trust/trusted-actor-envelope.js';

export const INVENTORY_POSTING_CAPABILITY_VERSION = 1 as const;
export const INVENTORY_POSTING_CAPABILITY_ID =
  `${'northstar'}.${'inventory'}:capability.posting` as const;
export const INVENTORY_POSTING_DEPENDENCY_SET_ROOT =
  'ffd4e9f6103b5c6053c39b62fe64e69dd255cb0c86cfd349ae465ab25179b3d3' as const;
// Finite hang-prevention bound, not a posting-latency budget or SLA. Fifteen
// seconds leaves room for lock-holder coordination while still terminating an
// acyclic lock convoy that PostgreSQL's deadlock detector cannot break.
const inventoryPostingLockTimeoutMilliseconds = 15_000;
const requestKeyLockDerivationVersion =
  'northstar.inventory-posting-request-lock/v1';
const legacyInventoryPostingInputDigestVersion = 1 as const;
const transferInventoryPostingInputDigestVersion = 2 as const;
const currentInventoryPostingInputDigestVersion = 3 as const;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const canonicalDecimalPattern =
  /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;
const instantPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;
const baseUnitImmutableDetailPattern =
  /^itemId=(\S+) bindingMovementId=(\S+) bindingUnitId=(\S+) requestedUnitId=(\S+)$/u;

export interface InventoryRecordedAtAuthority {
  currentInstant(): string;
}

export interface InventoryPostingRegistrationV1 {
  readonly capabilityId: typeof INVENTORY_POSTING_CAPABILITY_ID;
  readonly capabilityVersion: typeof INVENTORY_POSTING_CAPABILITY_VERSION;
  readonly dependencySetRoot: typeof INVENTORY_POSTING_DEPENDENCY_SET_ROOT;
  readonly releaseContentHash: string;
  readonly releaseId: string;
  readonly storageTarget: StorageTargetPayloadV1;
  readonly storageTargetContentHash: string;
}

export interface InventoryPostingAuthorizationV1 {
  readonly decision: 'ALLOW';
  readonly evaluatorVersion: string;
  readonly policyVersion: string;
}

export interface InventoryAdjustmentLineV1 {
  readonly itemId: string;
  readonly locationId: string;
  readonly quantityDelta: string;
  readonly sourceLine: string;
  readonly transactionLineId: string;
  readonly unitId: string;
}

export interface InventoryTransferLineV1 {
  readonly fromLocationId: string;
  readonly itemId: string;
  readonly quantity: string;
  readonly sourceLine: string;
  readonly toLocationId: string;
  readonly transactionLineId: string;
  readonly unitId: string;
}

export type InventoryStockCountKindV1 =
  | 'initial'
  | 'correction'
  | 'reversal';

export interface InventoryStockCountLineV1 {
  readonly countedQuantity: string;
  readonly expectedQuantity: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly reversalOfMovementId: string | null;
  readonly sourceLine: string;
  readonly stockCountLineId: string;
  readonly transactionLineId: string;
  readonly unitId: string;
  readonly varianceQuantity: string;
}

export interface InventoryAdjustmentPostingCommandV1 {
  readonly authorization: InventoryPostingAuthorizationV1;
  readonly channel: InvocationChannel;
  readonly effectiveAt: string;
  readonly idempotencyKey: string;
  readonly legalEntityId: string;
  readonly lines: readonly InventoryAdjustmentLineV1[];
  readonly reason: {
    readonly code: string;
    readonly narrative: string | null;
  };
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly sourceType: string;
  readonly stockDimensionSetVersion: 'v1';
  readonly transactionId: string;
}

export interface InventoryTransferPostingCommandV1 {
  readonly authorization: InventoryPostingAuthorizationV1;
  readonly channel: InvocationChannel;
  readonly effectiveAt: string;
  readonly idempotencyKey: string;
  readonly legalEntityId: string;
  readonly lines: readonly InventoryTransferLineV1[];
  readonly reason: {
    readonly code: string;
    readonly narrative: string | null;
  };
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly sourceType: string;
  readonly stockDimensionSetVersion: 'v1';
  readonly transactionId: string;
}

export interface InventoryStockCountPostingCommandV1 {
  readonly authorization: InventoryPostingAuthorizationV1;
  readonly channel: InvocationChannel;
  readonly countKind: InventoryStockCountKindV1;
  readonly effectiveAt: string;
  readonly idempotencyKey: string;
  readonly legalEntityId: string;
  readonly lines: readonly InventoryStockCountLineV1[];
  readonly reason: {
    readonly code: string;
    readonly narrative: string | null;
  };
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly sourceType: 'stockCount';
  readonly stockCountId: string;
  readonly stockDimensionSetVersion: 'v1';
  readonly supersedesStockCountId: string | null;
  readonly transactionId: string;
}

export type InventoryPostingCommandV1 =
  | InventoryAdjustmentPostingCommandV1
  | InventoryTransferPostingCommandV1
  | InventoryStockCountPostingCommandV1;

export type InventoryPostingRoleV1 =
  | 'adjustment'
  | 'transfer'
  | 'count'
  | 'correction';

export interface InventoryMovementOrderEntryV1 {
  readonly effectiveAt: string;
  readonly movementId: string;
  readonly postingRole: string;
  readonly recordedAt: string;
  readonly sourceId: string;
  readonly sourceLine: string;
  readonly sourceType: string;
}

export interface PostedInventoryMovementV1 {
  readonly businessPeriod: string;
  readonly effectiveAt: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly movementId: string;
  readonly postingRole: InventoryPostingRoleV1;
  readonly quantityDelta: string;
  readonly recordedAt: string;
  readonly reversalOfMovementId: string | null;
  readonly sourceId: string;
  readonly sourceLine: string;
  readonly sourceRevision: number;
  readonly sourceType: string;
  readonly stockDimensionSetVersion: 'v1';
  readonly transactionLineId: string;
  readonly unitId: string;
}

export interface InventoryPostingTrustLinksV1 {
  readonly changeDocumentId: string;
  readonly correlationId: string;
  readonly domainEventId: string;
  readonly invocationId: string;
  readonly outboxId: string;
}

export interface InventoryPostingRequestLockTargetV1 {
  readonly namespace: typeof STOCK_IDENTITY_LOCK_NAMESPACE;
  readonly requestKey: number;
}

export interface InventoryPostingResultV1 {
  readonly capabilityId: string;
  readonly capabilityVersion: typeof INVENTORY_POSTING_CAPABILITY_VERSION;
  readonly movements: readonly PostedInventoryMovementV1[];
  readonly negativeStockFlag: boolean;
  readonly recordedAt: string;
  readonly replayed: boolean;
  readonly stockCount: {
    readonly kind: InventoryStockCountKindV1;
    readonly lineIds: readonly string[];
    readonly stockCountId: string;
    readonly supersedesStockCountId: string | null;
  } | null;
  readonly transactionId: string;
  readonly trust: InventoryPostingTrustLinksV1;
}

export type InventoryAdjustmentPostingResultV1 = InventoryPostingResultV1;
export type InventoryTransferPostingResultV1 = InventoryPostingResultV1;
export type InventoryStockCountPostingResultV1 = InventoryPostingResultV1;

type RecordedInventoryPostingResult = Omit<
  InventoryPostingResultV1,
  'movements' | 'stockCount'
> & {
  readonly movements: readonly (Omit<
    PostedInventoryMovementV1,
    'postingRole' | 'reversalOfMovementId'
  > & {
    readonly postingRole?: InventoryPostingRoleV1;
    readonly reversalOfMovementId?: string | null;
  })[];
  readonly stockCount?: InventoryPostingResultV1['stockCount'];
};

export type InventoryPostingErrorCode =
  | 'INVENTORY_ADJUSTMENT_APPROVAL_REQUIRED'
  | 'INVENTORY_ADJUSTMENT_REASON_REQUIRED'
  | 'INVENTORY_BACKDATE_LIMIT_EXCEEDED'
  | 'INVENTORY_BASE_UNIT_IMMUTABLE'
  | 'INVENTORY_CORRECTION_APPROVAL_REQUIRED'
  | 'INVENTORY_CORRECTION_REASON_REQUIRED'
  | 'INVENTORY_COUNT_APPROVAL_REQUIRED'
  | 'INVENTORY_COUNT_EVIDENCE_CONFLICT'
  | 'INVENTORY_COUNT_REASON_REQUIRED'
  | 'INVENTORY_ITEM_INACTIVE'
  | 'INVENTORY_ITEM_UNIT_MISMATCH'
  | 'INVENTORY_LEGAL_ENTITY_INACTIVE'
  | 'INVENTORY_LOCATION_INACTIVE'
  | 'INVENTORY_PERIOD_CLOSED'
  | 'INVENTORY_POSTING_CAPABILITY_MISMATCH'
  | 'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT'
  | 'INVENTORY_POSTING_INPUT_INVALID'
  | 'INVENTORY_POSTING_LOCK_TIMEOUT'
  | 'INVENTORY_POSTING_RELEASE_MISMATCH'
  | 'INVENTORY_POSTING_STORAGE_INVALID'
  | 'INVENTORY_POSTING_STORAGE_REJECTED'
  | 'INVENTORY_STOCK_NEGATIVE'
  | 'INVENTORY_TRANSFER_APPROVAL_REQUIRED'
  | 'INVENTORY_TRANSFER_REASON_REQUIRED'
  | 'INVENTORY_TRANSACTION_STATE_CONFLICT';

export class InventoryPostingError extends Error {
  override readonly name = 'InventoryPostingError';

  constructor(
    readonly code: InventoryPostingErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string>> = Object.freeze({}),
  ) {
    super(`${code}: ${message}`);
  }
}

interface EntityBinding {
  archiveColumn: string;
  entityId: string;
  fields: ReadonlyMap<string, FieldBinding>;
  legalEntityColumn: string | null;
  recordIdColumn: string;
  revisionColumn: string;
  tableName: string;
}

interface FieldBinding {
  enumOptionIds: readonly string[];
  name: string;
}

interface PostingStorageBinding {
  item: EntityBinding;
  itemBaseUnitColumn: string;
  legalEntity: EntityBinding;
  legalEntityActiveStatus: string;
  legalEntityStatusColumn: string;
  location: EntityBinding;
  movement: EntityBinding;
  movementBusinessPeriodColumn: string;
  movementPostingRoleAdjustment: string;
  movementPostingRoleCorrection: string;
  movementPostingRoleCount: string;
  movementPostingRoleTransfer: string;
  movementRelationToLineColumn: string;
  movementRelationToTransactionColumn: string;
  movementStockVersionV1: string;
  periodLock: EntityBinding;
  periodLockClosedThroughColumn: string;
  schemaName: string;
  stockCount: EntityBinding;
  stockCountDraftState: string;
  stockCountKindCorrection: string;
  stockCountKindInitial: string;
  stockCountKindReversal: string;
  stockCountLine: EntityBinding;
  stockCountLineRelationToCountColumn: string;
  stockCountLineRelationToTransactionLineColumn: string;
  stockCountPostedState: string;
  stockCountRelationToSupersededColumn: string;
  stockCountRelationToTransactionColumn: string;
  stockCountStateColumn: string;
  transaction: EntityBinding;
  transactionAdjustmentType: string;
  transactionCountCorrectionType: string;
  transactionTransferType: string;
  transactionDraftState: string;
  transactionPostedState: string;
  transactionStateColumn: string;
  transactionTypeColumn: string;
  transactionLine: EntityBinding;
  transactionLineFromLocationColumn: string;
  transactionLineItemColumn: string;
  transactionLineLineNumberColumn: string;
  transactionLineQuantityColumn: string;
  transactionLineRelationToTransactionColumn: string;
  transactionLineToLocationColumn: string;
  transactionLineUnitColumn: string;
}

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

interface PlannedMovement {
  readonly businessPeriod: string;
  readonly effectiveAt: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly movementId: string;
  readonly postingRole: InventoryPostingRoleV1;
  readonly quantityDelta: string;
  readonly quantityScaled: bigint;
  readonly recordedAt: string;
  readonly reversalOfMovementId: string | null;
  readonly sourceId: string;
  readonly sourceLine: string;
  readonly sourceRevision: number;
  readonly sourceType: string;
  readonly stockDimensionSetVersion: 'v1';
  readonly transactionLineId: string;
  readonly unitId: string;
}

interface RecordedReceiptRow {
  change_document_id: string;
  correlation_id: string;
  domain_event_id: string;
  input_digest: string;
  input_digest_version: number;
  invocation_id: string;
  mutation_result: RecordedInventoryPostingResult;
  outbox_id: string;
  principal_id: string;
  recorded_at: Date;
}

interface VersionedInputDigest {
  readonly value: string;
  readonly version: typeof currentInventoryPostingInputDigestVersion;
}

interface EvidenceIds {
  changeDocumentId: string;
  correlationId: string;
  domainEventId: string;
  invocationId: string;
  outboxId: string;
}

type ParsedPosting =
  | {
      readonly command: InventoryAdjustmentPostingCommandV1;
      readonly postingRole: 'adjustment';
    }
  | {
      readonly command: InventoryTransferPostingCommandV1;
      readonly postingRole: 'transfer';
    }
  | {
      readonly command: InventoryStockCountPostingCommandV1;
      readonly postingRole: 'count' | 'correction';
    };

/**
 * Capability-local posting adapter admitted by ADR-0026. It owns the complete
 * top-level transaction so the stock serializer runs immediately after BEGIN,
 * before a caller can establish a savepoint. The generic O0 interpreter stays
 * movement-read-only.
 */
export class PostgresInventoryPostingService {
  readonly #binding: PostingStorageBinding;

  constructor(
    private readonly pool: Pool,
    private readonly registration: InventoryPostingRegistrationV1,
    private readonly recordedAtAuthority: InventoryRecordedAtAuthority,
    private readonly mintUuid: () => string = randomUUID,
  ) {
    this.#binding = resolvePostingStorage(registration.storageTarget);
    validateRegistration(registration);
  }

  async postAdjustment(
    context: TrustedRequestContext,
    actorEnvelope: TrustedActorEnvelope,
    command: InventoryAdjustmentPostingCommandV1,
  ): Promise<InventoryAdjustmentPostingResultV1> {
    return this.#post(context, actorEnvelope, {
      command: validateAdjustmentCommand(command),
      postingRole: 'adjustment',
    });
  }

  async postTransfer(
    context: TrustedRequestContext,
    actorEnvelope: TrustedActorEnvelope,
    command: InventoryTransferPostingCommandV1,
  ): Promise<InventoryTransferPostingResultV1> {
    return this.#post(context, actorEnvelope, {
      command: validateTransferCommand(command),
      postingRole: 'transfer',
    });
  }

  async postStockCount(
    context: TrustedRequestContext,
    actorEnvelope: TrustedActorEnvelope,
    command: InventoryStockCountPostingCommandV1,
  ): Promise<InventoryStockCountPostingResultV1> {
    const parsed = validateStockCountCommand(command);
    return this.#post(context, actorEnvelope, {
      command: parsed,
      postingRole: parsed.countKind === 'initial' ? 'count' : 'correction',
    });
  }

  async #post(
    context: TrustedRequestContext,
    actorEnvelope: TrustedActorEnvelope,
    posting: ParsedPosting,
  ): Promise<InventoryPostingResultV1> {
    assertTrustedRequestContext(context);
    assertTrustedActorEnvelope(actorEnvelope);
    assertActorContext(context, actorEnvelope);
    const parsed = posting.command;
    const inputDigest = currentCommandDigest(posting);
    const movements = plannedMovements(posting, this.mintUuid);
    const identities = movements.map((movement) =>
      stockIdentity(context, parsed.legalEntityId, movement),
    );
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      // Transaction-local so the bounded wait cannot leak through the pool.
      // This precedes every lock acquisition and caller savepoint, preserving
      // the serializer's top-level transaction placement contract.
      await client.query("SELECT set_config('lock_timeout', $1::text, true)", [
        `${String(inventoryPostingLockTimeoutMilliseconds)}ms`,
      ]);
      // Load-bearing placement: no posting work, lock acquisition, or caller
      // savepoint occurs before this acquisition.
      await acquireStockIdentityLocks(client, identities);
      await assertRuntimeLogin(client);
      await setTrustedContext(client, context);
      await acquirePostingRequestKeyLock(
        client,
        context,
        this.registration.capabilityId,
        parsed.idempotencyKey,
      );

      const receipt = await findReceipt(
        client,
        context,
        this.registration.capabilityId,
        parsed.idempotencyKey,
      );
      if (receipt) {
        const replay = validateReceiptReplay(
          receipt,
          context,
          posting,
          parsed.idempotencyKey,
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return replay;
      }

      await assertActiveRelease(client, context, this.registration);
      const recordedAt = canonicalInstant(
        this.recordedAtAuthority.currentInstant(),
        'recordedAt authority',
      );
      const businessPeriod = await businessPeriodFor(
        client,
        context.tenantId,
        parsed.effectiveAt,
      );
      const recordedPeriod = await businessPeriodFor(
        client,
        context.tenantId,
        recordedAt,
      );
      const configuration = await loadInventoryPostingConfiguration(client, {
        environmentId: context.environmentId,
        legalEntityId: parsed.legalEntityId,
        tenantId: context.tenantId,
      });
      if (
        configuration.contractReleaseRoot !==
        this.registration.releaseContentHash
      ) {
        throw postingError(
          'INVENTORY_POSTING_RELEASE_MISMATCH',
          'posting configuration is not recorded for the active release',
          {
            activeReleaseRoot: this.registration.releaseContentHash,
            configurationReleaseRoot: configuration.contractReleaseRoot,
          },
        );
      }
      const ordered = movements
        .map((movement) => ({ ...movement, businessPeriod, recordedAt }))
        .toSorted(compareInventoryMovementOrderEntries);

      await assumeModuleRole(client);
      await lockInventoryTransactionHeader(
        client,
        this.#binding,
        context,
        parsed,
      );
      const lineSetDigest = await captureInventoryLineSetDigest(
        client,
        this.#binding,
        context,
        parsed,
      );
      await assertInventoryLineSet(client, this.#binding, context, posting);
      const countLineSetDigest =
        posting.postingRole === 'count' ||
        posting.postingRole === 'correction'
          ? await lockAndValidateStockCountEvidence(
              client,
              this.#binding,
              context,
              posting.command,
            )
          : null;
      if (
        posting.postingRole === 'count' ||
        posting.postingRole === 'correction'
      ) {
        await validateStockCountCompensation(
          client,
          this.#binding,
          context,
          posting.command,
        );
      }
      const naturalReplay = await findNaturalReplay(
        client,
        this.#binding,
        context,
        posting,
        ordered,
      );
      if (naturalReplay) {
        await resetModuleRole(client);
        const replay = await persistAdditionalReceipt(
          client,
          context,
          this.registration,
          parsed.idempotencyKey,
          posting,
          inputDigest,
          naturalReplay,
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return replay;
      }

      await assertInventoryDraftHeader(client, this.#binding, context, posting);
      if (
        posting.postingRole === 'count' ||
        posting.postingRole === 'correction'
      ) {
        await assertStockCountDraftHeader(
          client,
          this.#binding,
          context,
          posting.command,
        );
      }
      await assertPostingMasters(
        client,
        this.#binding,
        context,
        parsed.legalEntityId,
        ordered,
      );
      const negativeStockFlag = await enforceNegativeStock(
        client,
        this.#binding,
        context,
        parsed.legalEntityId,
        configuration,
        ordered,
      );
      enforceReasonAndApproval(configuration, actorEnvelope.actor, posting);
      enforceBackdate(configuration, businessPeriod, recordedPeriod);
      await enforcePeriodLock(
        client,
        this.#binding,
        context,
        parsed.legalEntityId,
        parsed.effectiveAt,
      );

      await client.query('SAVEPOINT inventory_posting_write');
      let transactionRevision = -1;
      let evidenceRevision = -1;
      try {
        for (const movement of ordered) {
          await insertMovement(
            client,
            this.#binding,
            context,
            actorEnvelope,
            posting,
            movement,
          );
        }
        transactionRevision = await transitionTransactionToPosted(
          client,
          this.#binding,
          context,
          posting,
          lineSetDigest,
        );
        evidenceRevision = transactionRevision;
        if (
          posting.postingRole === 'count' ||
          posting.postingRole === 'correction'
        ) {
          evidenceRevision = await transitionStockCountToPosted(
            client,
            this.#binding,
            context,
            actorEnvelope,
            posting.command,
            recordedAt,
            countLineSetDigest!,
          );
        }
        await client.query('RELEASE SAVEPOINT inventory_posting_write');
      } catch (error) {
        if (postgresCode(error) !== '23505') throw error;
        await client.query('ROLLBACK TO SAVEPOINT inventory_posting_write');
        const racedReplay = await findNaturalReplay(
          client,
          this.#binding,
          context,
          posting,
          ordered,
        );
        if (!racedReplay) {
          throw postingError(
            'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
            'a natural effect identity was claimed by a different posting',
          );
        }
        await resetModuleRole(client);
        const replay = await persistAdditionalReceipt(
          client,
          context,
          this.registration,
          parsed.idempotencyKey,
          posting,
          inputDigest,
          racedReplay,
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return replay;
      }

      const persistedMovements = await readBackMovements(
        client,
        this.#binding,
        context,
        parsed.legalEntityId,
        ordered,
      );
      await resetModuleRole(client);
      const ids = mintEvidenceIds(this.mintUuid);
      const resultWithoutTrust = {
        capabilityId: this.registration.capabilityId,
        capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
        movements: persistedMovements,
        negativeStockFlag,
        recordedAt,
        replayed: false,
        stockCount: stockCountResult(posting),
        transactionId: parsed.transactionId,
      } as const;
      const trust = await persistAcceptedEvidence(
        client,
        context,
        actorEnvelope.actor,
        posting,
        this.registration,
        configuration,
        resultWithoutTrust,
        ids,
        evidenceRevision,
      );
      const result = Object.freeze({ ...resultWithoutTrust, trust });
      await insertReceipt(
        client,
        context,
        this.registration,
        parsed.idempotencyKey,
        inputDigest,
        result,
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [translateInventoryPostingError(error), rollbackError],
            'inventory posting and rollback both failed',
          );
        }
      }
      throw translateInventoryPostingError(error);
    } finally {
      try {
        await client.query('RESET ROLE');
        await client.query('RESET ALL');
      } finally {
        client.release();
      }
    }
  }
}

async function acquirePostingRequestKeyLock(
  client: PoolClient,
  context: TrustedRequestContext,
  capabilityId: string,
  idempotencyKey: string,
): Promise<void> {
  const target = planInventoryPostingRequestLock(
    context,
    capabilityId,
    idempotencyKey,
  );
  // All stock locks are already held. Sharing NSST makes a hash collision
  // conservatively serialize unrelated work; it cannot bypass idempotency.
  await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [
    target.namespace,
    target.requestKey,
  ]);
}

/**
 * Derives the request-key serializer in the reserved NSST two-int namespace.
 * The versioned, NUL-delimited SHA-256 preimage keeps request keys distributed
 * independently of stock identities; PostgreSQL consumes the first signed
 * int32 because that is the width of the namespace's second key.
 */
export function planInventoryPostingRequestLock(
  context: Pick<TrustedRequestContext, 'environmentId' | 'tenantId'>,
  capabilityId: string,
  idempotencyKey: string,
): InventoryPostingRequestLockTargetV1 {
  const requestKey = createHash('sha256')
    .update(requestKeyLockDerivationVersion)
    .update('\0')
    .update(context.tenantId)
    .update('\0')
    .update(context.environmentId)
    .update('\0')
    .update(capabilityId)
    .update('\0')
    .update(idempotencyKey)
    .digest()
    .readInt32BE(0);
  return Object.freeze({
    namespace: STOCK_IDENTITY_LOCK_NAMESPACE,
    requestKey,
  });
}

function validateRegistration(
  registration: InventoryPostingRegistrationV1,
): void {
  if (
    registration.capabilityId !== INVENTORY_POSTING_CAPABILITY_ID ||
    registration.capabilityVersion !== INVENTORY_POSTING_CAPABILITY_VERSION ||
    registration.dependencySetRoot !== INVENTORY_POSTING_DEPENDENCY_SET_ROOT
  ) {
    throw postingError(
      'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      'posting registration does not match the frozen capability contract',
    );
  }
  requiredUuid(registration.releaseId, 'releaseId');
  if (!sha256Pattern.test(registration.releaseContentHash)) {
    throw postingError(
      'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      'releaseContentHash must be a lowercase SHA-256 digest',
    );
  }
  if (!sha256Pattern.test(registration.storageTargetContentHash)) {
    throw postingError(
      'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      'storageTargetContentHash must be a lowercase SHA-256 digest',
    );
  }
  if (
    registration.storageTarget.schemaVersion !==
      'northstar.storage-target-payload/v3' ||
    registration.storageTarget.providerAbi.managedSchema !==
      'north_star_module' ||
    registration.storageTarget.providerAbi.runtimeRole !==
      'north_star_module_runtime'
  ) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'posting requires the admitted v3 managed storage ABI',
    );
  }
}

function resolvePostingStorage(
  target: StorageTargetPayloadV1,
): PostingStorageBinding {
  const entity = (suffix: string): StorageEntityTarget => {
    const matches = target.entities.filter((candidate) =>
      candidate.entityId.endsWith(`:entity.${suffix}`),
    );
    if (matches.length !== 1) {
      throw postingError(
        'INVENTORY_POSTING_STORAGE_INVALID',
        `storage target must contain exactly one ${suffix} entity`,
      );
    }
    return matches[0]!;
  };
  const itemEntity = entity('item');
  const legalEntity = entity('legal_entity');
  const locationEntity = entity('location');
  const movementEntity = entity('inventory_movement');
  const periodLockEntity = entity('inventory_period_lock');
  const stockCountEntity = entity('stock_count');
  const stockCountLineEntity = entity('stock_count_line');
  const transactionEntity = entity('inventory_transaction');
  const transactionLineEntity = entity('inventory_transaction_line');
  if (
    !movementEntity.factStorage ||
    movementEntity.factStorage.mutability !== 'appendOnly' ||
    !movementEntity.legalEntity ||
    !periodLockEntity.periodLock ||
    !legalEntity.legalEntityMaster
  ) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'storage target lacks the frozen movement, period-lock, or legal-master contract',
    );
  }
  const item = bindEntity(itemEntity);
  const legal = bindEntity(legalEntity);
  const location = bindEntity(locationEntity);
  const movement = bindEntity(movementEntity);
  const periodLock = bindEntity(periodLockEntity);
  const stockCount = bindEntity(stockCountEntity);
  const stockCountLine = bindEntity(stockCountLineEntity);
  const transaction = bindEntity(transactionEntity);
  const transactionLine = bindEntity(transactionLineEntity);
  const transactionState = requiredField(
    transaction,
    'inventory_transaction_state',
  );
  const transactionType = requiredField(
    transaction,
    'inventory_transaction_type',
  );
  const legalStatus = requiredField(legal, 'legal_entity_status');
  const movementPostingRole = requiredField(
    movement,
    'inventory_movement_posting_role',
  );
  const movementStockVersion = requiredField(
    movement,
    'inventory_movement_stock_dimension_set_version',
  );
  const stockCountKind = requiredField(stockCount, 'stock_count_kind');
  const stockCountState = requiredField(stockCount, 'stock_count_state');
  return Object.freeze({
    item,
    itemBaseUnitColumn: requiredField(item, 'item_base_unit').name,
    legalEntity: legal,
    legalEntityActiveStatus: requiredEnumOption(legalStatus, 'active'),
    legalEntityStatusColumn: legalStatus.name,
    location,
    movement,
    movementBusinessPeriodColumn:
      movementEntity.factStorage.businessPeriod.column,
    movementPostingRoleAdjustment: requiredEnumOption(
      movementPostingRole,
      'adjustment',
    ),
    movementPostingRoleCorrection: requiredEnumOption(
      movementPostingRole,
      'correction',
    ),
    movementPostingRoleCount: requiredEnumOption(movementPostingRole, 'count'),
    movementPostingRoleTransfer: requiredEnumOption(
      movementPostingRole,
      'transfer',
    ),
    movementRelationToLineColumn: requiredRelationColumn(
      target,
      movementEntity,
      'inventory_transaction_line',
    ),
    movementRelationToTransactionColumn: requiredRelationColumn(
      target,
      movementEntity,
      'inventory_transaction',
    ),
    movementStockVersionV1: requiredEnumOption(movementStockVersion, 'v1'),
    periodLock,
    periodLockClosedThroughColumn:
      periodLockEntity.periodLock.closedThroughColumn,
    schemaName: target.providerAbi.managedSchema,
    stockCount,
    stockCountDraftState: requiredEnumOption(stockCountState, 'draft'),
    stockCountKindCorrection: requiredEnumOption(stockCountKind, 'correction'),
    stockCountKindInitial: requiredEnumOption(stockCountKind, 'initial'),
    stockCountKindReversal: requiredEnumOption(stockCountKind, 'reversal'),
    stockCountLine,
    stockCountLineRelationToCountColumn: requiredRelationColumn(
      target,
      stockCountLineEntity,
      'stock_count',
    ),
    stockCountLineRelationToTransactionLineColumn: requiredRelationColumn(
      target,
      stockCountLineEntity,
      'inventory_transaction_line',
    ),
    stockCountPostedState: requiredEnumOption(stockCountState, 'posted'),
    stockCountRelationToSupersededColumn: requiredRelationColumn(
      target,
      stockCountEntity,
      'stock_count',
    ),
    stockCountRelationToTransactionColumn: requiredRelationColumn(
      target,
      stockCountEntity,
      'inventory_transaction',
    ),
    stockCountStateColumn: stockCountState.name,
    transaction,
    transactionAdjustmentType: requiredEnumOption(
      transactionType,
      'adjustment',
    ),
    transactionCountCorrectionType: requiredEnumOption(
      transactionType,
      'count_correction',
    ),
    transactionTransferType: requiredEnumOption(transactionType, 'transfer'),
    transactionDraftState: requiredEnumOption(transactionState, 'draft'),
    transactionPostedState: requiredEnumOption(transactionState, 'posted'),
    transactionStateColumn: transactionState.name,
    transactionTypeColumn: transactionType.name,
    transactionLine,
    transactionLineFromLocationColumn: requiredField(
      transactionLine,
      'inventory_transaction_line_from_location_id',
    ).name,
    transactionLineItemColumn: requiredField(
      transactionLine,
      'inventory_transaction_line_item_id',
    ).name,
    transactionLineLineNumberColumn: requiredField(
      transactionLine,
      'inventory_transaction_line_line_number',
    ).name,
    transactionLineQuantityColumn: requiredField(
      transactionLine,
      'inventory_transaction_line_quantity',
    ).name,
    transactionLineRelationToTransactionColumn: requiredRelationColumn(
      target,
      transactionLineEntity,
      'inventory_transaction',
    ),
    transactionLineToLocationColumn: requiredField(
      transactionLine,
      'inventory_transaction_line_to_location_id',
    ).name,
    transactionLineUnitColumn: requiredField(
      transactionLine,
      'inventory_transaction_line_unit_id',
    ).name,
  });
}

function bindEntity(entity: StorageEntityTarget): EntityBinding {
  const fields = new Map<string, FieldBinding>();
  for (const column of entity.columns) {
    const local = column.canonicalFieldId.split(':field.').at(-1);
    if (!local || fields.has(local)) {
      throw postingError(
        'INVENTORY_POSTING_STORAGE_INVALID',
        `entity ${entity.entityId} contains ambiguous field metadata`,
      );
    }
    fields.set(local, {
      enumOptionIds: [...column.fieldContract.enumOptionIds],
      name: safeIdentifier(column.physicalName),
    });
  }
  return Object.freeze({
    archiveColumn: safeIdentifier(entity.archive.archivedAtColumn),
    entityId: entity.entityId,
    fields,
    legalEntityColumn: entity.legalEntity
      ? safeIdentifier(entity.legalEntity.column)
      : null,
    recordIdColumn: safeIdentifier(entity.recordIdentity.column),
    revisionColumn: safeIdentifier(entity.optimisticRevision.column),
    tableName: safeIdentifier(entity.physicalTableName),
  });
}

function requiredField(entity: EntityBinding, localId: string): FieldBinding {
  const field = entity.fields.get(localId);
  if (!field) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `entity ${entity.entityId} lacks field ${localId}`,
    );
  }
  return field;
}

function requiredEnumOption(field: FieldBinding, suffix: string): string {
  const matches = field.enumOptionIds.filter((option) =>
    option.endsWith(`_${suffix}`),
  );
  if (matches.length !== 1) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `field ${field.name} lacks unique enum option ${suffix}`,
    );
  }
  return matches[0]!;
}

function movementPostingRole(
  binding: PostingStorageBinding,
  postingRole: InventoryPostingRoleV1,
): string {
  switch (postingRole) {
    case 'adjustment':
      return binding.movementPostingRoleAdjustment;
    case 'correction':
      return binding.movementPostingRoleCorrection;
    case 'count':
      return binding.movementPostingRoleCount;
    case 'transfer':
      return binding.movementPostingRoleTransfer;
  }
}

function postingRoleFromStorage(
  binding: PostingStorageBinding,
  value: string,
): InventoryPostingRoleV1 {
  if (value === binding.movementPostingRoleAdjustment) return 'adjustment';
  if (value === binding.movementPostingRoleCorrection) return 'correction';
  if (value === binding.movementPostingRoleCount) return 'count';
  if (value === binding.movementPostingRoleTransfer) return 'transfer';
  throw postingError(
    'INVENTORY_POSTING_STORAGE_REJECTED',
    `movement read-back returned unsupported posting role ${value}`,
  );
}

function transactionType(
  binding: PostingStorageBinding,
  postingRole: InventoryPostingRoleV1,
): string {
  if (postingRole === 'adjustment') return binding.transactionAdjustmentType;
  if (postingRole === 'transfer') return binding.transactionTransferType;
  return binding.transactionCountCorrectionType;
}

function stockCountKind(
  binding: PostingStorageBinding,
  countKind: InventoryStockCountKindV1,
): string {
  switch (countKind) {
    case 'initial':
      return binding.stockCountKindInitial;
    case 'correction':
      return binding.stockCountKindCorrection;
    case 'reversal':
      return binding.stockCountKindReversal;
  }
}

function requiredRelationColumn(
  target: StorageTargetPayloadV1,
  source: StorageEntityTarget,
  targetSuffix: string,
): string {
  const relations = target.relations.filter(
    (relation) =>
      relation.sourceEntityId === source.entityId &&
      relation.targetEntityId.endsWith(`:entity.${targetSuffix}`) &&
      relation.relationColumn.origin !== 'field',
  );
  if (relations.length !== 1) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `${source.entityId} lacks unique relation to ${targetSuffix}`,
    );
  }
  return safeIdentifier(relations[0]!.relationColumn.physicalName);
}

function validateAdjustmentCommand(
  command: InventoryAdjustmentPostingCommandV1,
): InventoryAdjustmentPostingCommandV1 {
  validateCommandEnvelope(command);
  if (!Array.isArray(command.lines) || command.lines.length === 0) {
    throw inputError('an adjustment requires at least one line');
  }
  const naturalKeys = new Set<string>();
  for (const line of command.lines) {
    exactKeys(line, [
      'itemId',
      'locationId',
      'quantityDelta',
      'sourceLine',
      'transactionLineId',
      'unitId',
    ]);
    validateLineIdentity(line);
    requiredUuid(line.locationId, 'line.locationId');
    const quantity = decimalToScaled(line.quantityDelta, 'line.quantityDelta');
    if (quantity === 0n) throw inputError('quantityDelta must not be zero');
    assertUniqueSourceLine(naturalKeys, line.sourceLine, 'adjustment');
  }
  const parsed = structuredClone(command);
  return {
    ...normalizeCommandEnvelope(parsed),
    lines: parsed.lines.map((line) => ({
      ...line,
      itemId: line.itemId.toLowerCase(),
      locationId: line.locationId.toLowerCase(),
      quantityDelta: normalizeDecimal(line.quantityDelta),
      transactionLineId: line.transactionLineId.toLowerCase(),
    })),
  };
}

function validateTransferCommand(
  command: InventoryTransferPostingCommandV1,
): InventoryTransferPostingCommandV1 {
  validateCommandEnvelope(command);
  if (!Array.isArray(command.lines) || command.lines.length === 0) {
    throw inputError('a transfer requires at least one line');
  }
  const naturalKeys = new Set<string>();
  for (const line of command.lines) {
    exactKeys(line, [
      'fromLocationId',
      'itemId',
      'quantity',
      'sourceLine',
      'toLocationId',
      'transactionLineId',
      'unitId',
    ]);
    validateLineIdentity(line, 76);
    requiredUuid(line.fromLocationId, 'line.fromLocationId');
    requiredUuid(line.toLocationId, 'line.toLocationId');
    if (line.fromLocationId.toLowerCase() === line.toLocationId.toLowerCase()) {
      throw inputError(
        'transfer fromLocationId and toLocationId must be distinct',
      );
    }
    const quantity = decimalToScaled(line.quantity, 'line.quantity');
    if (quantity <= 0n) {
      throw inputError('transfer quantity must be greater than zero');
    }
    assertUniqueSourceLine(naturalKeys, line.sourceLine, 'transfer');
  }
  const parsed = structuredClone(command);
  return {
    ...normalizeCommandEnvelope(parsed),
    lines: parsed.lines.map((line) => ({
      ...line,
      fromLocationId: line.fromLocationId.toLowerCase(),
      itemId: line.itemId.toLowerCase(),
      quantity: normalizeDecimal(line.quantity),
      toLocationId: line.toLocationId.toLowerCase(),
      transactionLineId: line.transactionLineId.toLowerCase(),
    })),
  };
}

function validateStockCountCommand(
  command: InventoryStockCountPostingCommandV1,
): InventoryStockCountPostingCommandV1 {
  validateCommandEnvelope(command);
  requiredUuid(command.stockCountId, 'stockCountId');
  if (command.sourceType !== 'stockCount') {
    throw inputError('stock-count sourceType must be stockCount');
  }
  if (command.sourceId.toLowerCase() !== command.stockCountId.toLowerCase()) {
    throw inputError('stock-count sourceId must equal stockCountId');
  }
  if (!['initial', 'correction', 'reversal'].includes(command.countKind)) {
    throw inputError('countKind is not supported');
  }
  if (command.countKind === 'initial') {
    if (command.supersedesStockCountId !== null) {
      throw inputError('an initial count cannot supersede another count');
    }
  } else {
    if (command.supersedesStockCountId === null) {
      throw inputError(
        `${command.countKind} requires supersedesStockCountId`,
      );
    }
    requiredUuid(
      command.supersedesStockCountId,
      'supersedesStockCountId',
    );
  }
  if (!Array.isArray(command.lines) || command.lines.length === 0) {
    throw inputError('a stock count requires at least one line');
  }
  const naturalKeys = new Set<string>();
  for (const line of command.lines) {
    exactKeys(line, [
      'countedQuantity',
      'expectedQuantity',
      'itemId',
      'locationId',
      'reversalOfMovementId',
      'sourceLine',
      'stockCountLineId',
      'transactionLineId',
      'unitId',
      'varianceQuantity',
    ]);
    validateLineIdentity(line);
    requiredUuid(line.locationId, 'line.locationId');
    requiredUuid(line.stockCountLineId, 'line.stockCountLineId');
    const expected = decimalToScaled(
      line.expectedQuantity,
      'line.expectedQuantity',
    );
    const counted = decimalToScaled(
      line.countedQuantity,
      'line.countedQuantity',
    );
    const variance = decimalToScaled(
      line.varianceQuantity,
      'line.varianceQuantity',
    );
    if (counted - expected !== variance) {
      throw inputError(
        'line.varianceQuantity must equal countedQuantity minus expectedQuantity',
      );
    }
    if (command.countKind === 'reversal') {
      if (line.reversalOfMovementId === null) {
        throw inputError('a reversal line requires reversalOfMovementId');
      }
      requiredUuid(line.reversalOfMovementId, 'line.reversalOfMovementId');
    } else if (line.reversalOfMovementId !== null) {
      throw inputError(
        'only a reversal line may name reversalOfMovementId',
      );
    }
    assertUniqueSourceLine(
      naturalKeys,
      line.sourceLine,
      command.countKind === 'initial' ? 'count' : 'correction',
    );
  }
  const parsed = structuredClone(command);
  return {
    ...normalizeCommandEnvelope(parsed),
    lines: parsed.lines.map((line) => ({
      ...line,
      countedQuantity: normalizeDecimal(line.countedQuantity),
      expectedQuantity: normalizeDecimal(line.expectedQuantity),
      itemId: line.itemId.toLowerCase(),
      locationId: line.locationId.toLowerCase(),
      reversalOfMovementId: line.reversalOfMovementId?.toLowerCase() ?? null,
      stockCountLineId: line.stockCountLineId.toLowerCase(),
      transactionLineId: line.transactionLineId.toLowerCase(),
      varianceQuantity: normalizeDecimal(line.varianceQuantity),
    })),
    stockCountId: parsed.stockCountId.toLowerCase(),
    supersedesStockCountId:
      parsed.supersedesStockCountId?.toLowerCase() ?? null,
  };
}

function validateCommandEnvelope(command: InventoryPostingCommandV1): void {
  exactKeys(command, [
    'authorization',
    'channel',
    ...('stockCountId' in command
      ? ['countKind', 'stockCountId', 'supersedesStockCountId']
      : []),
    'effectiveAt',
    'idempotencyKey',
    'legalEntityId',
    'lines',
    'reason',
    'sourceId',
    'sourceRevision',
    'sourceType',
    'stockDimensionSetVersion',
    'transactionId',
  ]);
  exactKeys(command.authorization, [
    'decision',
    'evaluatorVersion',
    'policyVersion',
  ]);
  exactKeys(command.reason, ['code', 'narrative']);
  if (command.authorization.decision !== 'ALLOW') {
    throw inputError('posting authorization must be ALLOW');
  }
  requiredText(command.authorization.evaluatorVersion, 'evaluatorVersion', 180);
  requiredText(command.authorization.policyVersion, 'policyVersion', 180);
  if (!isChannel(command.channel)) throw inputError('channel is not supported');
  canonicalInstant(command.effectiveAt, 'effectiveAt');
  requiredUuid(command.idempotencyKey, 'idempotencyKey');
  requiredUuid(command.legalEntityId, 'legalEntityId');
  requiredUuid(command.transactionId, 'transactionId');
  requiredText(command.sourceId, 'sourceId', 80);
  requiredText(command.sourceType, 'sourceType', 80);
  if (
    !Number.isSafeInteger(command.sourceRevision) ||
    command.sourceRevision <= 0
  ) {
    throw inputError('sourceRevision must be a positive safe integer');
  }
  if (command.stockDimensionSetVersion !== 'v1') {
    throw inputError('stockDimensionSetVersion must be v1');
  }
  boundedText(command.reason.code, 'reason.code', 80);
  if (command.reason.narrative !== null) {
    boundedText(command.reason.narrative, 'reason.narrative', 1000);
  }
}

function normalizeCommandEnvelope<T extends InventoryPostingCommandV1>(
  parsed: T,
): T {
  return {
    ...parsed,
    idempotencyKey: parsed.idempotencyKey.toLowerCase(),
    legalEntityId: parsed.legalEntityId.toLowerCase(),
    transactionId: parsed.transactionId.toLowerCase(),
  };
}

function validateLineIdentity(
  line: {
    readonly itemId: string;
    readonly sourceLine: string;
    readonly transactionLineId: string;
    readonly unitId: string;
  },
  maximumSourceLineLength = 80,
): void {
  requiredUuid(line.itemId, 'line.itemId');
  requiredUuid(line.transactionLineId, 'line.transactionLineId');
  requiredText(line.sourceLine, 'line.sourceLine', maximumSourceLineLength);
  requiredText(line.unitId, 'line.unitId', 32);
}

function assertUniqueSourceLine(
  sourceLines: Set<string>,
  sourceLine: string,
  postingRole: InventoryPostingRoleV1,
): void {
  if (sourceLines.has(sourceLine)) {
    throw inputError(`${postingRole} lines repeat the natural effect identity`);
  }
  sourceLines.add(sourceLine);
}

function plannedMovements(
  posting: ParsedPosting,
  mintUuid: () => string,
): PlannedMovement[] {
  if (posting.postingRole === 'adjustment') {
    return posting.command.lines.map((line) =>
      plannedMovement(
        posting.command,
        line,
        line.locationId,
        line.quantityDelta,
        line.sourceLine,
        posting.postingRole,
        mintUuid,
      ),
    );
  }
  if (posting.postingRole === 'transfer') {
    return posting.command.lines.flatMap((line) => [
      plannedMovement(
        posting.command,
        line,
        line.fromLocationId,
        `-${line.quantity}`,
        transferEffectSourceLine(line.sourceLine, 'out'),
        posting.postingRole,
        mintUuid,
      ),
      plannedMovement(
        posting.command,
        line,
        line.toLocationId,
        line.quantity,
        transferEffectSourceLine(line.sourceLine, 'in'),
        posting.postingRole,
        mintUuid,
      ),
    ]);
  }
  return posting.command.lines.map((line) =>
    plannedMovement(
      posting.command,
      line,
      line.locationId,
      line.varianceQuantity,
      line.sourceLine,
      posting.postingRole,
      mintUuid,
      line.reversalOfMovementId,
    ),
  );
}

function plannedMovement(
  command: InventoryPostingCommandV1,
  line:
    | InventoryAdjustmentLineV1
    | InventoryTransferLineV1
    | InventoryStockCountLineV1,
  locationId: string,
  quantityDelta: string,
  sourceLine: string,
  postingRole: InventoryPostingRoleV1,
  mintUuid: () => string,
  reversalOfMovementId: string | null = null,
): PlannedMovement {
  const movementId = mintUuid();
  requiredUuid(movementId, 'minted movementId');
  return {
    businessPeriod: '',
    effectiveAt: command.effectiveAt,
    itemId: line.itemId,
    locationId,
    movementId,
    postingRole,
    quantityDelta: normalizeDecimal(quantityDelta),
    quantityScaled: decimalToScaled(quantityDelta, 'movement.quantityDelta'),
    recordedAt: '',
    reversalOfMovementId,
    sourceId: command.sourceId,
    sourceLine,
    sourceRevision: command.sourceRevision,
    sourceType: command.sourceType,
    stockDimensionSetVersion: command.stockDimensionSetVersion,
    transactionLineId: line.transactionLineId,
    unitId: line.unitId,
  };
}

function transferEffectSourceLine(
  sourceLine: string,
  side: 'in' | 'out',
): string {
  return `${sourceLine}:${side}`;
}

function stockIdentity(
  context: TrustedRequestContext,
  legalEntityId: string,
  movement: PlannedMovement,
): ScopedStockIdentityV1 {
  return {
    environmentId: context.environmentId.toLowerCase(),
    itemId: movement.itemId.toLowerCase(),
    legalEntityId: legalEntityId.toLowerCase(),
    locationId: movement.locationId.toLowerCase(),
    tenantId: context.tenantId.toLowerCase(),
  };
}

export function compareInventoryMovementOrderEntries(
  left: InventoryMovementOrderEntryV1,
  right: InventoryMovementOrderEntryV1,
): number {
  for (const [a, b] of [
    [left.effectiveAt, right.effectiveAt],
    [left.recordedAt, right.recordedAt],
    [left.sourceType, right.sourceType],
    [left.sourceId, right.sourceId],
    [left.sourceLine, right.sourceLine],
    [left.postingRole, right.postingRole],
    [left.movementId, right.movementId],
  ] as const) {
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

async function assertRuntimeLogin(client: PoolClient): Promise<void> {
  const result = await client.query<{
    bypassRls: boolean;
    currentRole: string;
    sessionRole: string;
    superuser: boolean;
  }>(`SELECT current_user AS "currentRole",
             session_user AS "sessionRole",
             role.rolsuper AS superuser,
             role.rolbypassrls AS "bypassRls"
        FROM pg_roles AS role
       WHERE role.rolname = current_user`);
  const role = result.rows[0];
  if (
    role?.currentRole !== 'north_star_runtime' ||
    role.sessionRole !== 'north_star_runtime' ||
    role.superuser ||
    role.bypassRls
  ) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'posting requires the unprivileged trusted runtime login',
    );
  }
}

async function setTrustedContext(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<void> {
  await client.query(
    `SELECT set_config('north_star.tenant_id', $1, true),
            set_config('north_star.environment_id', $2, true),
            set_config('north_star.principal_id', $3, true),
            set_config('north_star.request_id', $4, true)`,
    [
      context.tenantId,
      context.environmentId,
      context.principalId,
      context.requestId,
    ],
  );
}

async function assumeModuleRole(client: PoolClient): Promise<void> {
  await client.query('SET LOCAL ROLE north_star_module_runtime');
  const role = await client.query<{
    bypassRls: boolean;
    currentRole: string;
    sessionRole: string;
    superuser: boolean;
  }>(`SELECT current_user AS "currentRole",
             session_user AS "sessionRole",
             role.rolsuper AS superuser,
             role.rolbypassrls AS "bypassRls"
        FROM pg_roles AS role
       WHERE role.rolname = current_user`);
  const assumed = role.rows[0];
  if (
    assumed?.currentRole !== 'north_star_module_runtime' ||
    assumed.sessionRole !== 'north_star_runtime' ||
    assumed.superuser ||
    assumed.bypassRls
  ) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'module runtime role assumption violated least privilege',
    );
  }
}

async function resetModuleRole(client: PoolClient): Promise<void> {
  await client.query('RESET ROLE');
  const role = await client.query<{ currentRole: string; sessionRole: string }>(
    `SELECT current_user AS "currentRole", session_user AS "sessionRole"`,
  );
  if (
    role.rows[0]?.currentRole !== 'north_star_runtime' ||
    role.rows[0]?.sessionRole !== 'north_star_runtime'
  ) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'trusted runtime role was not restored before evidence writes',
    );
  }
}

async function assertActiveRelease(
  client: PoolClient,
  context: TrustedRequestContext,
  registration: InventoryPostingRegistrationV1,
): Promise<void> {
  const result = await client.query<{ content_hash: string }>(
    `SELECT release.content_hash
       FROM platform.active_release_pointers AS pointer
       JOIN platform.tenant_releases AS release
         ON release.tenant_id = pointer.tenant_id
        AND release.environment_id = pointer.environment_id
        AND release.release_id = pointer.release_id
      WHERE pointer.tenant_id = $1
        AND pointer.environment_id = $2
        AND pointer.release_id = $3`,
    [context.tenantId, context.environmentId, registration.releaseId],
  );
  if (result.rows[0]?.content_hash !== registration.releaseContentHash) {
    throw postingError(
      'INVENTORY_POSTING_RELEASE_MISMATCH',
      'posting registration is not the active tenant release',
    );
  }
  const storageTargetBytes = Buffer.from(
    canonicalize(registration.storageTarget),
  );
  const artifact = await client.query<{ content_hash: string }>(
    `SELECT content_hash
       FROM platform.read_tenant_release_artifacts($1)
      WHERE artifact_kind = 'projectionChunk'
        AND content_hash = $2
        AND canonical_bytes = $3::bytea`,
    [
      registration.releaseId,
      registration.storageTargetContentHash,
      storageTargetBytes,
    ],
  );
  if (
    artifact.rows[0]?.content_hash !== registration.storageTargetContentHash
  ) {
    throw postingError(
      'INVENTORY_POSTING_RELEASE_MISMATCH',
      'posting storage target is not the exact artifact persisted by the active release',
      { storageTargetContentHash: registration.storageTargetContentHash },
    );
  }
}

async function businessPeriodFor(
  client: PoolClient,
  tenantId: string,
  instant: string,
): Promise<string> {
  const result = await client.query<{ businessPeriod: string }>(
    `SELECT north_star_internal.inventory_business_period($1, $2)::text
       AS "businessPeriod"`,
    [tenantId, instant],
  );
  const period = result.rows[0]?.businessPeriod;
  if (!period) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'tenant business period could not be resolved',
    );
  }
  return period;
}

async function assertPostingMasters(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  legalEntityId: string,
  movements: readonly PlannedMovement[],
): Promise<void> {
  const itemIds = [
    ...new Set(movements.map((movement) => movement.itemId)),
  ].toSorted();
  const items = await client.query<{ baseUnit: string; itemId: string }>(
    `SELECT ${quoted(binding.item.recordIdColumn)}::text AS "itemId",
            ${quoted(binding.itemBaseUnitColumn)}::text AS "baseUnit"
       FROM ${table(binding, binding.item)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.item.recordIdColumn)} = ANY($3::uuid[])
        AND ${quoted(binding.item.archiveColumn)} IS NULL
      ORDER BY ${quoted(binding.item.recordIdColumn)}
      FOR NO KEY UPDATE`,
    [context.tenantId, context.environmentId, itemIds],
  );
  const checkedItems = new Map(
    items.rows.map((item) => [item.itemId.toLowerCase(), item.baseUnit]),
  );
  const legal = await client.query<{ status: string }>(
    `SELECT ${quoted(binding.legalEntityStatusColumn)} AS status
       FROM ${table(binding, binding.legalEntity)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.legalEntity.recordIdColumn)} = $3
        AND ${quoted(binding.legalEntity.archiveColumn)} IS NULL`,
    [context.tenantId, context.environmentId, legalEntityId],
  );
  if (legal.rows[0]?.status !== binding.legalEntityActiveStatus) {
    throw postingError(
      'INVENTORY_LEGAL_ENTITY_INACTIVE',
      `legal entity ${legalEntityId} is not active`,
      { legalEntityId },
    );
  }
  const checkedLocations = new Set<string>();
  for (const movement of movements) {
    const baseUnit = checkedItems.get(movement.itemId);
    if (baseUnit === undefined) {
      throw postingError(
        'INVENTORY_ITEM_INACTIVE',
        `item ${movement.itemId} is missing or archived`,
        { itemId: movement.itemId },
      );
    }
    const expectedUnit = checkedItems.get(movement.itemId)!;
    if (expectedUnit !== movement.unitId) {
      throw postingError(
        'INVENTORY_ITEM_UNIT_MISMATCH',
        `item ${movement.itemId} posts in ${expectedUnit}, not ${movement.unitId}`,
        {
          expectedUnit,
          itemId: movement.itemId,
          requestedUnit: movement.unitId,
        },
      );
    }
    if (!checkedLocations.has(movement.locationId)) {
      const location = await client.query<{ present: boolean }>(
        `SELECT true AS present
           FROM ${table(binding, binding.location)}
          WHERE tenant_id = $1 AND environment_id = $2
            AND ${quoted(binding.location.recordIdColumn)} = $3
            AND ${quoted(binding.location.archiveColumn)} IS NULL`,
        [context.tenantId, context.environmentId, movement.locationId],
      );
      if (!location.rows[0]?.present) {
        throw postingError(
          'INVENTORY_LOCATION_INACTIVE',
          `location ${movement.locationId} is missing or archived`,
          { locationId: movement.locationId },
        );
      }
      checkedLocations.add(movement.locationId);
    }
  }
}

function enforceReasonAndApproval(
  configuration: InventoryPostingConfiguration,
  actor: ResolvedActorAttribution,
  posting: ParsedPosting,
): void {
  const { command, postingRole } = posting;
  const reason = configuration.reasonRequirements[postingRole];
  if (
    command.reason.code.trim().length === 0 ||
    (reason === 'codeAndNarrative' &&
      (command.reason.narrative === null ||
        command.reason.narrative.trim().length === 0))
  ) {
    const code = reasonRequiredCode(postingRole);
    throw postingError(code, `${postingRole} requires ${reason}`);
  }
  const threshold = configuration.approvalThresholds[postingRole];
  if (threshold === null) return;
  const scaledThreshold = decimalToScaled(threshold, 'approval threshold');
  const exceeds = posting.command.lines.some((line) => {
    const quantity =
      posting.postingRole === 'adjustment'
        ? line.quantityDelta
        : posting.postingRole === 'transfer'
          ? line.quantity
          : line.varianceQuantity;
    return absolute(decimalToScaled(quantity, 'quantity')) > scaledThreshold;
  });
  if (exceeds && actor.approvingHumanId === null) {
    const code = approvalRequiredCode(postingRole);
    throw postingError(
      code,
      `${postingRole} exceeds approval threshold ${threshold}`,
      { threshold },
    );
  }
}

function reasonRequiredCode(
  postingRole: InventoryPostingRoleV1,
): InventoryPostingErrorCode {
  switch (postingRole) {
    case 'adjustment':
      return 'INVENTORY_ADJUSTMENT_REASON_REQUIRED';
    case 'transfer':
      return 'INVENTORY_TRANSFER_REASON_REQUIRED';
    case 'count':
      return 'INVENTORY_COUNT_REASON_REQUIRED';
    case 'correction':
      return 'INVENTORY_CORRECTION_REASON_REQUIRED';
  }
}

function approvalRequiredCode(
  postingRole: InventoryPostingRoleV1,
): InventoryPostingErrorCode {
  switch (postingRole) {
    case 'adjustment':
      return 'INVENTORY_ADJUSTMENT_APPROVAL_REQUIRED';
    case 'transfer':
      return 'INVENTORY_TRANSFER_APPROVAL_REQUIRED';
    case 'count':
      return 'INVENTORY_COUNT_APPROVAL_REQUIRED';
    case 'correction':
      return 'INVENTORY_CORRECTION_APPROVAL_REQUIRED';
  }
}

function enforceBackdate(
  configuration: InventoryPostingConfiguration,
  effectivePeriod: string,
  recordedPeriod: string,
): void {
  const effective = dateOrdinal(effectivePeriod);
  const recorded = dateOrdinal(recordedPeriod);
  if (recorded - effective > configuration.maximumBackdateDays) {
    throw postingError(
      'INVENTORY_BACKDATE_LIMIT_EXCEEDED',
      `effective period ${effectivePeriod} exceeds the ${String(configuration.maximumBackdateDays)} day backdate window`,
      { effectivePeriod, recordedPeriod },
    );
  }
}

async function enforcePeriodLock(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  legalEntityId: string,
  effectiveAt: string,
): Promise<void> {
  const result = await client.query<{ closedThrough: Date | null }>(
    `SELECT ${quoted(binding.periodLockClosedThroughColumn)} AS "closedThrough"
       FROM ${table(binding, binding.periodLock)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.periodLock.legalEntityColumn!)} = $3
        AND ${quoted(binding.periodLock.archiveColumn)} IS NULL
      FOR NO KEY UPDATE`,
    [context.tenantId, context.environmentId, legalEntityId],
  );
  if (result.rows.length !== 1) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'period-lock scope did not resolve exactly one row',
    );
  }
  const closedThrough = result.rows[0]!.closedThrough;
  if (closedThrough && Date.parse(effectiveAt) <= closedThrough.getTime()) {
    const lock = closedThrough.toISOString();
    throw postingError(
      'INVENTORY_PERIOD_CLOSED',
      `effectiveAt ${effectiveAt} is at or before closedThrough ${lock}`,
      { closedThrough: lock, effectiveAt, legalEntityId },
    );
  }
}

async function enforceNegativeStock(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  legalEntityId: string,
  configuration: InventoryPostingConfiguration,
  movements: readonly PlannedMovement[],
): Promise<boolean> {
  let flagged = false;
  const grouped = Map.groupBy(
    movements,
    (movement) => `${movement.itemId}\u001f${movement.locationId}`,
  );
  for (const identityMovements of grouped.values()) {
    const identity = identityMovements[0]!;
    const persisted = await client.query<{
      effectiveAt: string;
      movementId: string;
      postingRole: string;
      quantityDelta: string;
      recordedAt: string;
      sourceId: string;
      sourceLine: string;
      sourceType: string;
    }>(
      `SELECT to_char(${quoted(requiredField(binding.movement, 'inventory_movement_effective_at').name)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveAt",
              to_char(${quoted(requiredField(binding.movement, 'inventory_movement_recorded_at').name)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",
              ${quoted(requiredField(binding.movement, 'inventory_movement_source_type').name)} AS "sourceType",
              ${quoted(requiredField(binding.movement, 'inventory_movement_source_id').name)} AS "sourceId",
              ${quoted(requiredField(binding.movement, 'inventory_movement_source_line').name)} AS "sourceLine",
              ${quoted(requiredField(binding.movement, 'inventory_movement_posting_role').name)} AS "postingRole",
              ${quoted(binding.movement.recordIdColumn)}::text AS "movementId",
              ${quoted(requiredField(binding.movement, 'inventory_movement_quantity_delta').name)}::text AS "quantityDelta"
         FROM ${table(binding, binding.movement)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND ${quoted(binding.movement.legalEntityColumn!)} = $3
          AND ${quoted(requiredField(binding.movement, 'inventory_movement_item_id').name)} = $4
          AND ${quoted(requiredField(binding.movement, 'inventory_movement_location_id').name)} = $5
          AND ${quoted(binding.movement.archiveColumn)} IS NULL`,
      [
        context.tenantId,
        context.environmentId,
        legalEntityId,
        identity.itemId,
        identity.locationId,
      ],
    );
    const ordered = [
      ...persisted.rows.map((row) => ({
        ...row,
        quantityScaled: databaseDecimalToScaled(row.quantityDelta),
      })),
      ...identityMovements.map((movement) => ({
        effectiveAt: movement.effectiveAt,
        movementId: movement.movementId,
        postingRole: movementPostingRole(binding, movement.postingRole),
        quantityDelta: movement.quantityDelta,
        quantityScaled: movement.quantityScaled,
        recordedAt: movement.recordedAt,
        sourceId: movement.sourceId,
        sourceLine: movement.sourceLine,
        sourceType: movement.sourceType,
      })),
    ].toSorted(compareInventoryMovementOrderEntries);
    let projected = 0n;
    for (const movement of ordered) {
      projected += movement.quantityScaled;
      if (projected >= 0n) continue;
      if (configuration.negativeStock === 'reject') {
        throw postingError(
          'INVENTORY_STOCK_NEGATIVE',
          `movement ${movement.movementId} projects stock below zero`,
          {
            itemId: identity.itemId,
            locationId: identity.locationId,
            movementId: movement.movementId,
            projectedBalance: scaledToDecimal(projected),
          },
        );
      }
      if (configuration.negativeStock === 'allowWithFlag') flagged = true;
    }
  }
  return flagged;
}

async function insertMovement(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  actorEnvelope: TrustedActorEnvelope,
  posting: ParsedPosting,
  movement: PlannedMovement,
): Promise<void> {
  const { command } = posting;
  const fields = [
    [
      'inventory_movement_stock_dimension_set_version',
      binding.movementStockVersionV1,
    ],
    ['inventory_movement_item_id', movement.itemId],
    ['inventory_movement_location_id', movement.locationId],
    ['inventory_movement_quantity_delta', movement.quantityDelta],
    ['inventory_movement_unit_id', movement.unitId],
    ['inventory_movement_effective_at', movement.effectiveAt],
    ['inventory_movement_recorded_at', movement.recordedAt],
    ['inventory_movement_source_type', movement.sourceType],
    ['inventory_movement_source_id', movement.sourceId],
    ['inventory_movement_source_line', movement.sourceLine],
    ['inventory_movement_source_revision', movement.sourceRevision],
    [
      'inventory_movement_posting_role',
      movementPostingRole(binding, movement.postingRole),
    ],
    ['inventory_movement_reason_code', command.reason.code],
    ['inventory_movement_reason_narrative', command.reason.narrative],
    [
      'inventory_movement_actor_id',
      actorEnvelope.actor.executionPrincipal.principalId,
    ],
    [
      'inventory_movement_reversal_of_movement_id',
      movement.reversalOfMovementId,
    ],
  ] as const;
  const columns = [
    'tenant_id',
    'environment_id',
    binding.movement.legalEntityColumn!,
    binding.movementBusinessPeriodColumn,
    binding.movement.recordIdColumn,
    ...fields.map(([local]) => requiredField(binding.movement, local).name),
    binding.movementRelationToTransactionColumn,
    binding.movementRelationToLineColumn,
  ];
  const values = [
    context.tenantId,
    context.environmentId,
    command.legalEntityId,
    movement.businessPeriod,
    movement.movementId,
    ...fields.map(([, value]) => value),
    command.transactionId,
    movement.transactionLineId,
  ];
  await client.query(
    `INSERT INTO ${table(binding, binding.movement)}
       (${columns.map(quoted).join(', ')})
     VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    values,
  );
}

async function lockInventoryTransactionHeader(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  command: InventoryPostingCommandV1,
): Promise<void> {
  const header = await client.query<{ present: boolean }>(
    `SELECT true AS present
       FROM ${table(binding, binding.transaction)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.transaction.legalEntityColumn!)} = $3
        AND ${quoted(binding.transaction.recordIdColumn)} = $4
        AND ${quoted(binding.transaction.archiveColumn)} IS NULL
      FOR NO KEY UPDATE`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.transactionId,
    ],
  );
  if (!header.rows[0]?.present) {
    throw postingError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      `transaction ${command.transactionId} is missing or archived`,
      { transactionId: command.transactionId },
    );
  }
}

async function assertInventoryDraftHeader(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  posting: ParsedPosting,
): Promise<void> {
  const { command } = posting;
  const effectiveAtColumn = requiredField(
    binding.transaction,
    'inventory_transaction_effective_at',
  ).name;
  const reasonCodeColumn = requiredField(
    binding.transaction,
    'inventory_transaction_reason_code',
  ).name;
  const reasonNarrativeColumn = requiredField(
    binding.transaction,
    'inventory_transaction_reason_narrative',
  ).name;
  const sourceTypeColumn = requiredField(
    binding.transaction,
    'inventory_transaction_source_type',
  ).name;
  const sourceIdColumn = requiredField(
    binding.transaction,
    'inventory_transaction_source_id',
  ).name;
  const header = await client.query<{ present: boolean }>(
    `SELECT true AS present
       FROM ${table(binding, binding.transaction)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.transaction.legalEntityColumn!)} = $3
        AND ${quoted(binding.transaction.recordIdColumn)} = $4
        AND ${quoted(binding.transactionStateColumn)} = $5
        AND ${quoted(binding.transactionTypeColumn)} = $6
        AND ${quoted(binding.transaction.revisionColumn)} = $7
        AND ${quoted(effectiveAtColumn)} = $8::timestamptz
        AND ${quoted(reasonCodeColumn)} IS NOT DISTINCT FROM $9
        AND ${quoted(reasonNarrativeColumn)} IS NOT DISTINCT FROM $10
        AND ${quoted(sourceTypeColumn)} = $11
        AND ${quoted(sourceIdColumn)} = $12
        AND ${quoted(binding.transaction.archiveColumn)} IS NULL`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.transactionId,
      binding.transactionDraftState,
      transactionType(binding, posting.postingRole),
      command.sourceRevision,
      command.effectiveAt,
      command.reason.code || null,
      command.reason.narrative,
      command.sourceType,
      command.sourceId,
    ],
  );
  if (!header.rows[0]?.present) {
    throw postingError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      `transaction ${command.transactionId} does not exactly match the active draft`,
      { transactionId: command.transactionId },
    );
  }
}

async function captureInventoryLineSetDigest(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  command: InventoryPostingCommandV1,
): Promise<string> {
  const result = await client.query<{ lineSetDigest: string }>(
    `SELECT ${inventoryLineSetDigestSql(binding, '$1', '$2', '$3', '$4')}
              AS "lineSetDigest"`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.transactionId,
    ],
  );
  const digest = result.rows[0]?.lineSetDigest;
  if (!digest || !/^[0-9a-f]{32}$/u.test(digest)) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'transaction line-set digest could not be captured',
      { transactionId: command.transactionId },
    );
  }
  return digest;
}

async function assertInventoryLineSet(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  posting: ParsedPosting,
): Promise<void> {
  const { command } = posting;
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${quoted(binding.transactionLine.recordIdColumn)}::text AS "transactionLineId",
            ${quoted(binding.transactionLineItemColumn)}::text AS "itemId",
            ${quoted(binding.transactionLineFromLocationColumn)}::text AS "fromLocationId",
            ${quoted(binding.transactionLineToLocationColumn)}::text AS "toLocationId",
            ${quoted(binding.transactionLineQuantityColumn)}::text AS "quantity",
            ${quoted(binding.transactionLineLineNumberColumn)}::text AS "lineNumber",
            ${quoted(binding.transactionLineUnitColumn)} AS "unitId"
       FROM ${table(binding, binding.transactionLine)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.transactionLine.legalEntityColumn!)} = $3
        AND ${quoted(binding.transactionLineRelationToTransactionColumn)} = $4
        AND ${quoted(binding.transactionLine.archiveColumn)} IS NULL`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.transactionId,
    ],
  );
  if (result.rows.length !== command.lines.length) {
    throw postingError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      `transaction ${command.transactionId} line set differs from the posting command`,
      { transactionId: command.transactionId },
    );
  }
  const byId = new Map(
    result.rows.map((row) => [
      String(row.transactionLineId).toLowerCase(),
      row,
    ]),
  );
  if (posting.postingRole === 'adjustment') {
    for (const line of posting.command.lines) {
      assertInventoryLineMatches(
        adjustmentLineMatches(byId.get(line.transactionLineId), line),
        command.transactionId,
        line.transactionLineId,
      );
    }
  } else if (posting.postingRole === 'transfer') {
    for (const line of posting.command.lines) {
      assertInventoryLineMatches(
        transferLineMatches(byId.get(line.transactionLineId), line),
        command.transactionId,
        line.transactionLineId,
      );
    }
  } else {
    for (const line of posting.command.lines) {
      assertInventoryLineMatches(
        stockCountTransactionLineMatches(
          byId.get(line.transactionLineId),
          line,
        ),
        command.transactionId,
        line.transactionLineId,
      );
    }
  }
}

function assertInventoryLineMatches(
  matches: boolean,
  transactionId: string,
  transactionLineId: string,
): void {
  if (matches) return;
  throw postingError(
    'INVENTORY_TRANSACTION_STATE_CONFLICT',
    `transaction line ${transactionLineId} differs from the posting command`,
    { transactionId, transactionLineId },
  );
}

function adjustmentLineMatches(
  row: Record<string, unknown> | undefined,
  line: InventoryAdjustmentLineV1,
): boolean {
  const negative = line.quantityDelta.startsWith('-');
  return (
    row !== undefined &&
    String(row.itemId).toLowerCase() === line.itemId &&
    normalizeDatabaseDecimal(String(row.quantity)) === line.quantityDelta &&
    String(row.unitId) === line.unitId &&
    String(row.lineNumber) === line.sourceLine &&
    nullableUuid(row.fromLocationId) === (negative ? line.locationId : null) &&
    nullableUuid(row.toLocationId) === (negative ? null : line.locationId)
  );
}

function transferLineMatches(
  row: Record<string, unknown> | undefined,
  line: InventoryTransferLineV1,
): boolean {
  return (
    row !== undefined &&
    String(row.itemId).toLowerCase() === line.itemId &&
    normalizeDatabaseDecimal(String(row.quantity)) === line.quantity &&
    String(row.unitId) === line.unitId &&
    String(row.lineNumber) === line.sourceLine &&
    nullableUuid(row.fromLocationId) === line.fromLocationId &&
    nullableUuid(row.toLocationId) === line.toLocationId
  );
}

function stockCountTransactionLineMatches(
  row: Record<string, unknown> | undefined,
  line: InventoryStockCountLineV1,
): boolean {
  const negative = line.varianceQuantity.startsWith('-');
  return (
    row !== undefined &&
    String(row.itemId).toLowerCase() === line.itemId &&
    normalizeDatabaseDecimal(String(row.quantity)) ===
      line.varianceQuantity &&
    String(row.unitId) === line.unitId &&
    String(row.lineNumber) === line.sourceLine &&
    nullableUuid(row.fromLocationId) === (negative ? line.locationId : null) &&
    nullableUuid(row.toLocationId) === (negative ? null : line.locationId)
  );
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : String(value).toLowerCase();
}

async function lockAndValidateStockCountEvidence(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  command: InventoryStockCountPostingCommandV1,
): Promise<string> {
  const header = await client.query<{ present: boolean }>(
    `SELECT true AS present
       FROM ${table(binding, binding.stockCount)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.stockCount.legalEntityColumn!)} = $3
        AND ${quoted(binding.stockCount.recordIdColumn)} = $4
        AND ${quoted(binding.stockCount.archiveColumn)} IS NULL
      FOR NO KEY UPDATE`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.stockCountId,
    ],
  );
  if (!header.rows[0]?.present) {
    throw postingError(
      'INVENTORY_COUNT_EVIDENCE_CONFLICT',
      `stock count ${command.stockCountId} is missing or archived`,
      { stockCountId: command.stockCountId },
    );
  }
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${quoted(binding.stockCountLine.recordIdColumn)}::text AS "stockCountLineId",
            ${quoted(requiredField(binding.stockCountLine, 'stock_count_line_line_number').name)}::text AS "lineNumber",
            ${quoted(requiredField(binding.stockCountLine, 'stock_count_line_item_id').name)}::text AS "itemId",
            ${quoted(requiredField(binding.stockCountLine, 'stock_count_line_location_id').name)}::text AS "locationId",
            ${quoted(requiredField(binding.stockCountLine, 'stock_count_line_expected_quantity').name)}::text AS "expectedQuantity",
            ${quoted(requiredField(binding.stockCountLine, 'stock_count_line_counted_quantity').name)}::text AS "countedQuantity",
            ${quoted(requiredField(binding.stockCountLine, 'stock_count_line_variance_quantity').name)}::text AS "varianceQuantity",
            ${quoted(requiredField(binding.stockCountLine, 'stock_count_line_unit_id').name)} AS "unitId",
            ${quoted(requiredField(binding.stockCountLine, 'stock_count_line_reversal_of_movement_id').name)}::text AS "reversalOfMovementId",
            ${quoted(binding.stockCountLineRelationToTransactionLineColumn)}::text AS "transactionLineId"
       FROM ${table(binding, binding.stockCountLine)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.stockCountLine.legalEntityColumn!)} = $3
        AND ${quoted(binding.stockCountLineRelationToCountColumn)} = $4
        AND ${quoted(binding.stockCountLine.archiveColumn)} IS NULL`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.stockCountId,
    ],
  );
  if (result.rows.length !== command.lines.length) {
    throw postingError(
      'INVENTORY_COUNT_EVIDENCE_CONFLICT',
      `stock count ${command.stockCountId} line set differs from the posting command`,
      { stockCountId: command.stockCountId },
    );
  }
  const byId = new Map(
    result.rows.map((row) => [
      String(row.stockCountLineId).toLowerCase(),
      row,
    ]),
  );
  for (const line of command.lines) {
    const row = byId.get(line.stockCountLineId);
    if (
      row === undefined ||
      String(row.lineNumber) !== line.sourceLine ||
      String(row.itemId).toLowerCase() !== line.itemId ||
      String(row.locationId).toLowerCase() !== line.locationId ||
      normalizeDatabaseDecimal(String(row.expectedQuantity)) !==
        line.expectedQuantity ||
      normalizeDatabaseDecimal(String(row.countedQuantity)) !==
        line.countedQuantity ||
      normalizeDatabaseDecimal(String(row.varianceQuantity)) !==
        line.varianceQuantity ||
      String(row.unitId) !== line.unitId ||
      nullableUuid(row.reversalOfMovementId) !== line.reversalOfMovementId ||
      nullableUuid(row.transactionLineId) !== line.transactionLineId
    ) {
      throw postingError(
        'INVENTORY_COUNT_EVIDENCE_CONFLICT',
        `stock count line ${line.stockCountLineId} differs from the posting command`,
        {
          stockCountId: command.stockCountId,
          stockCountLineId: line.stockCountLineId,
        },
      );
    }
  }
  const digest = await client.query<{ lineSetDigest: string }>(
    `SELECT ${stockCountLineSetDigestSql(binding, '$1', '$2', '$3', '$4')}
              AS "lineSetDigest"`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.stockCountId,
    ],
  );
  const value = digest.rows[0]?.lineSetDigest;
  if (!value || !/^[0-9a-f]{32}$/u.test(value)) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'stock-count line-set digest could not be captured',
      { stockCountId: command.stockCountId },
    );
  }
  return value;
}

async function validateStockCountCompensation(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  command: InventoryStockCountPostingCommandV1,
): Promise<void> {
  if (command.countKind === 'initial') return;
  const superseded = await client.query<{ present: boolean }>(
    `SELECT true AS present
       FROM ${table(binding, binding.stockCount)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.stockCount.legalEntityColumn!)} = $3
        AND ${quoted(binding.stockCount.recordIdColumn)} = $4
        AND ${quoted(binding.stockCountStateColumn)} = $5
        AND ${quoted(binding.stockCount.archiveColumn)} IS NULL
      FOR NO KEY UPDATE`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.supersedesStockCountId,
      binding.stockCountPostedState,
    ],
  );
  if (!superseded.rows[0]?.present) {
    throw postingError(
      'INVENTORY_COUNT_EVIDENCE_CONFLICT',
      `${command.countKind} must supersede an active posted stock count`,
      { supersedesStockCountId: command.supersedesStockCountId! },
    );
  }
  if (command.countKind !== 'reversal') return;
  for (const line of command.lines) {
    const original = await client.query<{
      itemId: string;
      locationId: string;
      quantityDelta: string;
      unitId: string;
    }>(
      `SELECT ${quoted(requiredField(binding.movement, 'inventory_movement_item_id').name)}::text AS "itemId",
              ${quoted(requiredField(binding.movement, 'inventory_movement_location_id').name)}::text AS "locationId",
              ${quoted(requiredField(binding.movement, 'inventory_movement_quantity_delta').name)}::text AS "quantityDelta",
              ${quoted(requiredField(binding.movement, 'inventory_movement_unit_id').name)} AS "unitId"
         FROM ${table(binding, binding.movement)} AS movement
         JOIN ${table(binding, binding.stockCountLine)} AS count_line
           ON count_line.tenant_id = movement.tenant_id
          AND count_line.environment_id = movement.environment_id
          AND count_line.${quoted(binding.stockCountLine.legalEntityColumn!)}
              = movement.${quoted(binding.movement.legalEntityColumn!)}
          AND count_line.${quoted(binding.stockCountLineRelationToTransactionLineColumn)}
              = movement.${quoted(binding.movementRelationToLineColumn)}
        WHERE movement.tenant_id = $1 AND movement.environment_id = $2
          AND movement.${quoted(binding.movement.legalEntityColumn!)} = $3
          AND movement.${quoted(binding.movement.recordIdColumn)} = $4
          AND movement.${quoted(binding.movement.archiveColumn)} IS NULL
          AND count_line.${quoted(binding.stockCountLineRelationToCountColumn)} = $5
          AND count_line.${quoted(binding.stockCountLine.archiveColumn)} IS NULL`,
      [
        context.tenantId,
        context.environmentId,
        command.legalEntityId,
        line.reversalOfMovementId,
        command.supersedesStockCountId,
      ],
    );
    const row = original.rows[0];
    if (
      row === undefined ||
      row.itemId.toLowerCase() !== line.itemId ||
      row.locationId.toLowerCase() !== line.locationId ||
      row.unitId !== line.unitId ||
      databaseDecimalToScaled(row.quantityDelta) +
        decimalToScaled(line.varianceQuantity, 'line.varianceQuantity') !==
        0n
    ) {
      throw postingError(
        'INVENTORY_COUNT_EVIDENCE_CONFLICT',
        `reversal line ${line.stockCountLineId} is not the exact inverse of a movement justified by the superseded count`,
        {
          reversalOfMovementId: line.reversalOfMovementId!,
          stockCountLineId: line.stockCountLineId,
        },
      );
    }
  }
}

async function assertStockCountDraftHeader(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  command: InventoryStockCountPostingCommandV1,
): Promise<void> {
  const result = await client.query<{ present: boolean }>(
    `SELECT true AS present
       FROM ${table(binding, binding.stockCount)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.stockCount.legalEntityColumn!)} = $3
        AND ${quoted(binding.stockCount.recordIdColumn)} = $4
        AND ${quoted(binding.stockCountStateColumn)} = $5
        AND ${quoted(requiredField(binding.stockCount, 'stock_count_kind').name)} = $6
        AND ${quoted(requiredField(binding.stockCount, 'stock_count_effective_at').name)} = $7::timestamptz
        AND ${quoted(requiredField(binding.stockCount, 'stock_count_reason_code').name)} IS NOT DISTINCT FROM $8
        AND ${quoted(requiredField(binding.stockCount, 'stock_count_reason_narrative').name)} IS NOT DISTINCT FROM $9
        AND ${quoted(binding.stockCountRelationToTransactionColumn)} = $10
        AND ${quoted(binding.stockCountRelationToSupersededColumn)} IS NOT DISTINCT FROM $11::uuid
        AND ${quoted(binding.stockCount.revisionColumn)} = $12
        AND ${quoted(binding.stockCount.archiveColumn)} IS NULL`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.stockCountId,
      binding.stockCountDraftState,
      stockCountKind(binding, command.countKind),
      command.effectiveAt,
      command.reason.code || null,
      command.reason.narrative,
      command.transactionId,
      command.supersedesStockCountId,
      command.sourceRevision,
    ],
  );
  if (!result.rows[0]?.present) {
    throw postingError(
      'INVENTORY_COUNT_EVIDENCE_CONFLICT',
      `stock count ${command.stockCountId} does not exactly match the active draft`,
      { stockCountId: command.stockCountId },
    );
  }
}

async function transitionStockCountToPosted(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  actorEnvelope: TrustedActorEnvelope,
  command: InventoryStockCountPostingCommandV1,
  recordedAt: string,
  lineSetDigest: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE ${table(binding, binding.stockCount)}
        SET ${quoted(binding.stockCountStateColumn)} = $5,
            ${quoted(requiredField(binding.stockCount, 'stock_count_recorded_at').name)} = $6::timestamptz,
            ${quoted(requiredField(binding.stockCount, 'stock_count_actor_id').name)} = $7,
            ${quoted(binding.stockCount.revisionColumn)} = ${quoted(binding.stockCount.revisionColumn)} + 1
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.stockCount.legalEntityColumn!)} = $3
        AND ${quoted(binding.stockCount.recordIdColumn)} = $4
        AND ${quoted(binding.stockCountStateColumn)} = $8
        AND ${quoted(requiredField(binding.stockCount, 'stock_count_kind').name)} = $9
        AND ${quoted(requiredField(binding.stockCount, 'stock_count_effective_at').name)} = $10::timestamptz
        AND ${quoted(requiredField(binding.stockCount, 'stock_count_reason_code').name)} IS NOT DISTINCT FROM $11
        AND ${quoted(requiredField(binding.stockCount, 'stock_count_reason_narrative').name)} IS NOT DISTINCT FROM $12
        AND ${quoted(binding.stockCountRelationToTransactionColumn)} = $13
        AND ${quoted(binding.stockCountRelationToSupersededColumn)} IS NOT DISTINCT FROM $14::uuid
        AND ${quoted(binding.stockCount.revisionColumn)} = $15
        AND ${quoted(binding.stockCount.archiveColumn)} IS NULL
        AND ${stockCountLineSetDigestSql(binding, '$1', '$2', '$3', '$4')} = $16
      RETURNING ${quoted(binding.stockCount.revisionColumn)}::integer AS revision`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.stockCountId,
      binding.stockCountPostedState,
      recordedAt,
      actorEnvelope.actor.executionPrincipal.principalId,
      binding.stockCountDraftState,
      stockCountKind(binding, command.countKind),
      command.effectiveAt,
      command.reason.code || null,
      command.reason.narrative,
      command.transactionId,
      command.supersedesStockCountId,
      command.sourceRevision,
      lineSetDigest,
    ],
  );
  const revision = Number((result.rows[0] as { revision?: unknown } | undefined)?.revision);
  if (
    result.rowCount !== 1 ||
    !Number.isSafeInteger(revision) ||
    revision !== command.sourceRevision + 1
  ) {
    throw postingError(
      'INVENTORY_COUNT_EVIDENCE_CONFLICT',
      `stock count ${command.stockCountId} changed during posting`,
      { stockCountId: command.stockCountId },
    );
  }
  return revision;
}

function stockCountLineSetDigestSql(
  binding: PostingStorageBinding,
  tenantParameter: string,
  environmentParameter: string,
  legalEntityParameter: string,
  stockCountParameter: string,
): string {
  const alias = 'active_stock_count_line';
  return `(SELECT md5(COALESCE(
              jsonb_agg(
                to_jsonb(${alias})
                ORDER BY ${alias}.${quoted(binding.stockCountLine.recordIdColumn)}::text
              )::text,
              '[]'
            ))
       FROM ${table(binding, binding.stockCountLine)} AS ${alias}
      WHERE ${alias}.tenant_id = ${tenantParameter}
        AND ${alias}.environment_id = ${environmentParameter}
        AND ${alias}.${quoted(binding.stockCountLine.legalEntityColumn!)} = ${legalEntityParameter}
        AND ${alias}.${quoted(binding.stockCountLineRelationToCountColumn)} = ${stockCountParameter}
        AND ${alias}.${quoted(binding.stockCountLine.archiveColumn)} IS NULL)`;
}

async function transitionTransactionToPosted(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  posting: ParsedPosting,
  lineSetDigest: string,
): Promise<number> {
  const { command } = posting;
  const effectiveAtColumn = requiredField(
    binding.transaction,
    'inventory_transaction_effective_at',
  ).name;
  const reasonCodeColumn = requiredField(
    binding.transaction,
    'inventory_transaction_reason_code',
  ).name;
  const reasonNarrativeColumn = requiredField(
    binding.transaction,
    'inventory_transaction_reason_narrative',
  ).name;
  const sourceTypeColumn = requiredField(
    binding.transaction,
    'inventory_transaction_source_type',
  ).name;
  const sourceIdColumn = requiredField(
    binding.transaction,
    'inventory_transaction_source_id',
  ).name;
  const result = await client.query(
    `UPDATE ${table(binding, binding.transaction)}
        SET ${quoted(binding.transactionStateColumn)} = $4,
            ${quoted(binding.transaction.revisionColumn)} = ${quoted(binding.transaction.revisionColumn)} + 1
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.transaction.legalEntityColumn!)} = $3
        AND ${quoted(binding.transaction.recordIdColumn)} = $5
        AND ${quoted(binding.transactionStateColumn)} = $6
        AND ${quoted(binding.transactionTypeColumn)} = $7
        AND ${quoted(effectiveAtColumn)} = $8::timestamptz
        AND ${quoted(reasonCodeColumn)} IS NOT DISTINCT FROM $9
        AND ${quoted(reasonNarrativeColumn)} IS NOT DISTINCT FROM $10
        AND ${quoted(sourceTypeColumn)} = $11
        AND ${quoted(sourceIdColumn)} = $12
        AND ${quoted(binding.transaction.revisionColumn)} = $13
        AND ${quoted(binding.transaction.archiveColumn)} IS NULL
        AND ${inventoryLineSetDigestSql(binding, '$1', '$2', '$3', '$5')} = $14
      RETURNING ${quoted(binding.transaction.revisionColumn)}::integer AS revision`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      binding.transactionPostedState,
      command.transactionId,
      binding.transactionDraftState,
      transactionType(binding, posting.postingRole),
      command.effectiveAt,
      command.reason.code || null,
      command.reason.narrative,
      command.sourceType,
      command.sourceId,
      command.sourceRevision,
      lineSetDigest,
    ],
  );
  if (result.rowCount !== 1) {
    throw postingError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      `transaction ${command.transactionId} is not an active draft`,
      { transactionId: command.transactionId },
    );
  }
  const revision = Number((result.rows[0] as { revision?: unknown }).revision);
  if (
    !Number.isSafeInteger(revision) ||
    revision !== command.sourceRevision + 1
  ) {
    throw postingError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      `transaction ${command.transactionId} returned an invalid posted revision`,
      { transactionId: command.transactionId },
    );
  }
  return revision;
}

function inventoryLineSetDigestSql(
  binding: PostingStorageBinding,
  tenantParameter: string,
  environmentParameter: string,
  legalEntityParameter: string,
  transactionParameter: string,
): string {
  const alias = 'active_transaction_line';
  return `(SELECT md5(COALESCE(
              jsonb_agg(
                to_jsonb(${alias})
                ORDER BY ${alias}.${quoted(binding.transactionLine.recordIdColumn)}::text
              )::text,
              '[]'
            ))
       FROM ${table(binding, binding.transactionLine)} AS ${alias}
      WHERE ${alias}.tenant_id = ${tenantParameter}
        AND ${alias}.environment_id = ${environmentParameter}
        AND ${alias}.${quoted(binding.transactionLine.legalEntityColumn!)} = ${legalEntityParameter}
        AND ${alias}.${quoted(binding.transactionLineRelationToTransactionColumn)} = ${transactionParameter}
        AND ${alias}.${quoted(binding.transactionLine.archiveColumn)} IS NULL)`;
}

async function readBackMovements(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  legalEntityId: string,
  movements: readonly PlannedMovement[],
): Promise<readonly PostedInventoryMovementV1[]> {
  const ids = movements.map((movement) => movement.movementId);
  const result = await client.query<Record<string, unknown>>(
    `SELECT ${quoted(binding.movement.recordIdColumn)} AS "movementId",
            ${quoted(binding.movementBusinessPeriodColumn)}::text AS "businessPeriod",
            ${quoted(requiredField(binding.movement, 'inventory_movement_item_id').name)}::text AS "itemId",
            ${quoted(requiredField(binding.movement, 'inventory_movement_location_id').name)}::text AS "locationId",
            ${quoted(requiredField(binding.movement, 'inventory_movement_quantity_delta').name)}::text AS "quantityDelta",
            ${quoted(requiredField(binding.movement, 'inventory_movement_unit_id').name)} AS "unitId",
            to_char(${quoted(requiredField(binding.movement, 'inventory_movement_effective_at').name)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveAt",
            to_char(${quoted(requiredField(binding.movement, 'inventory_movement_recorded_at').name)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",
            ${quoted(requiredField(binding.movement, 'inventory_movement_source_type').name)} AS "sourceType",
            ${quoted(requiredField(binding.movement, 'inventory_movement_source_id').name)} AS "sourceId",
            ${quoted(requiredField(binding.movement, 'inventory_movement_source_line').name)} AS "sourceLine",
            ${quoted(requiredField(binding.movement, 'inventory_movement_source_revision').name)}::integer AS "sourceRevision",
            ${quoted(requiredField(binding.movement, 'inventory_movement_posting_role').name)} AS "postingRole",
            ${quoted(requiredField(binding.movement, 'inventory_movement_reversal_of_movement_id').name)}::text AS "reversalOfMovementId",
            ${quoted(binding.movementRelationToLineColumn)}::text AS "transactionLineId"
       FROM ${table(binding, binding.movement)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.movement.legalEntityColumn!)} = $3
        AND ${quoted(binding.movement.recordIdColumn)} = ANY($4::uuid[])`,
    [context.tenantId, context.environmentId, legalEntityId, ids],
  );
  if (result.rows.length !== movements.length) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_REJECTED',
      'movement read-back did not return the complete committed set',
    );
  }
  const byId = new Map(result.rows.map((row) => [String(row.movementId), row]));
  return Object.freeze(
    movements.map((movement) => {
      const row = byId.get(movement.movementId);
      if (!row) {
        throw postingError(
          'INVENTORY_POSTING_STORAGE_REJECTED',
          `movement ${movement.movementId} is absent from read-back`,
        );
      }
      return Object.freeze({
        businessPeriod: String(row.businessPeriod),
        effectiveAt: String(row.effectiveAt),
        itemId: String(row.itemId),
        locationId: String(row.locationId),
        movementId: String(row.movementId),
        postingRole: postingRoleFromStorage(binding, String(row.postingRole)),
        quantityDelta: normalizeDatabaseDecimal(String(row.quantityDelta)),
        recordedAt: String(row.recordedAt),
        reversalOfMovementId: nullableUuid(row.reversalOfMovementId),
        sourceId: String(row.sourceId),
        sourceLine: String(row.sourceLine),
        sourceRevision: Number(row.sourceRevision),
        sourceType: String(row.sourceType),
        stockDimensionSetVersion: 'v1' as const,
        transactionLineId: String(row.transactionLineId),
        unitId: String(row.unitId),
      });
    }),
  );
}

async function findNaturalReplay(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  posting: ParsedPosting,
  movements: readonly PlannedMovement[],
): Promise<InventoryPostingResultV1 | null> {
  const { command } = posting;
  const found: Array<{ expected: PlannedMovement; movementId: string }> = [];
  for (const movement of movements) {
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(binding.movement.recordIdColumn)}::text AS "movementId",
              ${quoted(requiredField(binding.movement, 'inventory_movement_item_id').name)}::text AS "itemId",
              ${quoted(requiredField(binding.movement, 'inventory_movement_location_id').name)}::text AS "locationId",
              ${quoted(requiredField(binding.movement, 'inventory_movement_quantity_delta').name)}::text AS "quantityDelta",
              ${quoted(requiredField(binding.movement, 'inventory_movement_unit_id').name)} AS "unitId",
              to_char(${quoted(requiredField(binding.movement, 'inventory_movement_effective_at').name)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveAt",
              ${quoted(requiredField(binding.movement, 'inventory_movement_reason_code').name)} AS "reasonCode",
              ${quoted(requiredField(binding.movement, 'inventory_movement_reason_narrative').name)} AS "reasonNarrative",
              ${quoted(requiredField(binding.movement, 'inventory_movement_reversal_of_movement_id').name)}::text AS "reversalOfMovementId",
              ${quoted(binding.movementRelationToTransactionColumn)}::text AS "transactionId",
              ${quoted(binding.movementRelationToLineColumn)}::text AS "transactionLineId"
         FROM ${table(binding, binding.movement)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND ${quoted(binding.movement.legalEntityColumn!)} = $3
          AND ${quoted(requiredField(binding.movement, 'inventory_movement_source_type').name)} = $4
          AND ${quoted(requiredField(binding.movement, 'inventory_movement_source_id').name)} = $5
          AND ${quoted(requiredField(binding.movement, 'inventory_movement_source_line').name)} = $6
          AND ${quoted(requiredField(binding.movement, 'inventory_movement_source_revision').name)} = $7
          AND ${quoted(requiredField(binding.movement, 'inventory_movement_posting_role').name)} = $8`,
      [
        context.tenantId,
        context.environmentId,
        command.legalEntityId,
        movement.sourceType,
        movement.sourceId,
        movement.sourceLine,
        movement.sourceRevision,
        movementPostingRole(binding, movement.postingRole),
      ],
    );
    const row = result.rows[0];
    if (!row) continue;
    if (
      String(row.itemId) !== movement.itemId ||
      String(row.locationId) !== movement.locationId ||
      normalizeDatabaseDecimal(String(row.quantityDelta)) !==
        movement.quantityDelta ||
      String(row.unitId) !== movement.unitId ||
      String(row.effectiveAt) !== movement.effectiveAt ||
      String(row.reasonCode) !== command.reason.code ||
      (row.reasonNarrative === null ? null : String(row.reasonNarrative)) !==
        command.reason.narrative ||
      nullableUuid(row.reversalOfMovementId) !==
        movement.reversalOfMovementId ||
      String(row.transactionId) !== command.transactionId ||
      String(row.transactionLineId) !== movement.transactionLineId
    ) {
      throw postingError(
        'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
        `natural effect ${movement.sourceLine} already names different business input`,
        { sourceLine: movement.sourceLine },
      );
    }
    found.push({ expected: movement, movementId: String(row.movementId) });
  }
  if (found.length === 0) return null;
  if (found.length !== movements.length) {
    throw postingError(
      'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
      'only part of the natural effect set already exists',
    );
  }
  const deduplicationKey = effectDeduplicationKey(posting);
  // Managed movement reads run under the module role. Trust evidence is in the
  // platform plane and is read only after restoring the trusted runtime role.
  await resetModuleRole(client);
  const receipt = await client.query<RecordedReceiptRow>(
    `SELECT receipt.principal_id, receipt.input_digest, receipt.mutation_result,
            receipt.input_digest_version, receipt.invocation_id,
            receipt.correlation_id,
            receipt.change_document_id, receipt.domain_event_id,
            receipt.outbox_id, receipt.recorded_at
       FROM platform.trust_outbox AS outbox
       JOIN platform.semantic_operation_receipts AS receipt
         ON receipt.tenant_id = outbox.tenant_id
        AND receipt.environment_id = outbox.environment_id
        AND receipt.outbox_id = outbox.outbox_id
      WHERE outbox.tenant_id = $1 AND outbox.environment_id = $2
        AND outbox.deduplication_key = $3
      ORDER BY receipt.recorded_at
      LIMIT 1`,
    [context.tenantId, context.environmentId, deduplicationKey],
  );
  const row = receipt.rows[0];
  if (!row) {
    throw postingError(
      'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
      'existing natural effects have no accepted posting receipt',
    );
  }
  if (row.principal_id.toLowerCase() !== context.principalId.toLowerCase()) {
    throw postingError(
      'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
      'existing natural effects belong to another principal',
    );
  }
  return recordedResultForReplay(row);
}

async function findReceipt(
  client: PoolClient,
  context: TrustedRequestContext,
  capabilityId: string,
  idempotencyKey: string,
): Promise<RecordedReceiptRow | null> {
  const result = await client.query<RecordedReceiptRow>(
    `SELECT principal_id, input_digest, input_digest_version, mutation_result,
            invocation_id, correlation_id, change_document_id,
            domain_event_id, outbox_id, recorded_at
       FROM platform.semantic_operation_receipts
      WHERE tenant_id = $1 AND environment_id = $2
        AND action_id = $3 AND idempotency_key = $4`,
    [context.tenantId, context.environmentId, capabilityId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

function validateReceiptReplay(
  receipt: RecordedReceiptRow,
  context: TrustedRequestContext,
  posting: ParsedPosting,
  idempotencyKey: string,
): InventoryPostingResultV1 {
  const inputDigest = digestCommand(posting, receipt.input_digest_version);
  if (
    receipt.principal_id.toLowerCase() !== context.principalId.toLowerCase() ||
    receipt.input_digest !== inputDigest
  ) {
    throw postingError(
      'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
      `idempotency key ${idempotencyKey} already names another posting`,
      { idempotencyKey },
    );
  }
  return recordedResultForReplay(receipt);
}

async function persistAdditionalReceipt(
  client: PoolClient,
  context: TrustedRequestContext,
  registration: InventoryPostingRegistrationV1,
  idempotencyKey: string,
  posting: ParsedPosting,
  inputDigest: VersionedInputDigest,
  replay: InventoryPostingResultV1,
): Promise<InventoryPostingResultV1> {
  const existing = await findReceipt(
    client,
    context,
    registration.capabilityId,
    idempotencyKey,
  );
  if (existing)
    return validateReceiptReplay(existing, context, posting, idempotencyKey);
  const result = Object.freeze({ ...replay, replayed: true });
  await insertReceipt(
    client,
    context,
    registration,
    idempotencyKey,
    inputDigest,
    result,
  );
  return result;
}

async function insertReceipt(
  client: PoolClient,
  context: TrustedRequestContext,
  registration: InventoryPostingRegistrationV1,
  idempotencyKey: string,
  inputDigest: VersionedInputDigest,
  result: InventoryPostingResultV1,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.semantic_operation_receipts (
       tenant_id, environment_id, principal_id, release_id,
       release_content_hash, action_id, idempotency_key, input_digest,
       input_digest_version, mutation_result, invocation_id, correlation_id,
       change_document_id, domain_event_id, outbox_id, recorded_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16)`,
    [
      context.tenantId,
      context.environmentId,
      context.principalId,
      registration.releaseId,
      registration.releaseContentHash,
      registration.capabilityId,
      idempotencyKey,
      inputDigest.value,
      inputDigest.version,
      JSON.stringify(result),
      result.trust.invocationId,
      result.trust.correlationId,
      result.trust.changeDocumentId,
      result.trust.domainEventId,
      result.trust.outboxId,
      result.recordedAt,
    ],
  );
}

async function persistAcceptedEvidence(
  client: PoolClient,
  context: TrustedRequestContext,
  actor: ResolvedActorAttribution,
  posting: ParsedPosting,
  registration: InventoryPostingRegistrationV1,
  configuration: InventoryPostingConfiguration,
  result: Omit<InventoryPostingResultV1, 'trust'>,
  ids: EvidenceIds,
  transactionRevision: number,
): Promise<InventoryPostingTrustLinksV1> {
  const { command, postingRole } = posting;
  const namespace = capabilityNamespace(registration.capabilityId);
  const eventType = `${namespace}:event.${postingRole}_posted`;
  const eventVersion = `${namespace}-${postingRole}-posted/v1`;
  const stockCount =
    posting.postingRole === 'count' || posting.postingRole === 'correction'
      ? posting.command
      : null;
  const recordType = stockCount
    ? `${namespace}:record.stock_count`
    : `${namespace}:record.${postingRole}`;
  const metadata = redactEvidenceMetadata({
    capabilityVersion: classified(
      'INTERNAL',
      INVENTORY_POSTING_CAPABILITY_VERSION,
    ),
    configurationReleaseRoot: classified(
      'INTERNAL',
      configuration.contractReleaseRoot,
    ),
    configurationRevision: classified('INTERNAL', configuration.revision),
    lineCount: classified('INTERNAL', command.lines.length),
    negativeStockFlag: classified('INTERNAL', result.negativeStockFlag),
    requestKind: classified('INTERNAL', `inventory-${postingRole}-posting`),
  });
  const policyInputs = redactEvidenceMetadata({
    legalEntityId: classified('INTERNAL', command.legalEntityId),
    postingRole: classified('INTERNAL', postingRole),
  });
  const changesInput: BusinessFieldChangeInput[] = stockCount
    ? [
        businessChange('state', 'draft', 'posted'),
        businessChange('recordedAt', null, result.recordedAt),
        businessChange(
          'expectedQuantity',
          null,
          stockCount.lines.map((line) => ({
            stockCountLineId: line.stockCountLineId,
            value: line.expectedQuantity,
          })),
        ),
        businessChange(
          'countedQuantity',
          null,
          stockCount.lines.map((line) => ({
            stockCountLineId: line.stockCountLineId,
            value: line.countedQuantity,
          })),
        ),
        businessChange(
          'varianceQuantity',
          null,
          stockCount.lines.map((line) => ({
            stockCountLineId: line.stockCountLineId,
            value: line.varianceQuantity,
          })),
        ),
        businessChange(
          'movementId',
          null,
          result.movements.map((movement) => movement.movementId),
        ),
      ]
    : [
        businessChange('state', 'draft', 'posted'),
        businessChange('recordedAt', null, result.recordedAt),
        businessChange(
          'quantityDelta',
          null,
          result.movements.map((movement) => movement.quantityDelta),
        ),
      ];
  const changes = redactBusinessChanges(changesInput);
  const eventPayload = redactEvidenceMetadata({
    effectiveAt: classified('INTERNAL', command.effectiveAt),
    legalEntityId: classified('INTERNAL', command.legalEntityId),
    movementIds: classified(
      'INTERNAL',
      result.movements.map((movement) => movement.movementId),
    ),
    negativeStockFlag: classified('INTERNAL', result.negativeStockFlag),
    recordedAt: classified('INTERNAL', result.recordedAt),
    stockCountEvidence: classified(
      'INTERNAL',
      stockCount
        ? {
            countKind: stockCount.countKind,
            lines: stockCount.lines.map((line) => ({
              countedQuantity: line.countedQuantity,
              expectedQuantity: line.expectedQuantity,
              stockCountLineId: line.stockCountLineId,
              transactionLineId: line.transactionLineId,
              varianceQuantity: line.varianceQuantity,
            })),
            stockCountId: stockCount.stockCountId,
            supersedesStockCountId: stockCount.supersedesStockCountId,
          }
        : null,
    ),
    transactionId: classified('INTERNAL', command.transactionId),
  });
  const actorColumns = resolvedActorColumns(actor);
  await client.query(
    `INSERT INTO platform.trust_action_invocations (
       tenant_id, environment_id, invocation_id, invocation_version,
       request_id, action_id, channel, outcome, correlation_id, causation_id,
       release_id, release_content_hash, execution_principal_kind,
       execution_principal_id, subject_principal_kind, subject_principal_id,
       initiating_human_id, approving_human_id, delegation_id,
       delegating_principal_kind, delegating_principal_id,
       delegated_to_principal_kind, delegated_to_principal_id,
       policy_evidence_version, policy_decision, policy_version,
       policy_evaluator_version, policy_inputs, metadata, failure_code,
       change_document_id, domain_event_id, outbox_id, recorded_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,'SUCCEEDED',$8,NULL,$9,$10,$11,$12,$13,$14,
       $15,$16,$17,$18,$19,$20,$21,$22,'ALLOW',$23,$24,$25::jsonb,$26::jsonb,
       NULL,$27,$28,$29,$30
     )`,
    [
      context.tenantId,
      context.environmentId,
      ids.invocationId,
      ACTION_INVOCATION_VERSION,
      context.requestId,
      registration.capabilityId,
      command.channel,
      ids.correlationId,
      registration.releaseId,
      registration.releaseContentHash,
      actorColumns.executionPrincipalKind,
      actorColumns.executionPrincipalId,
      actorColumns.subjectPrincipalKind,
      actorColumns.subjectPrincipalId,
      actorColumns.initiatingHumanId,
      actorColumns.approvingHumanId,
      actorColumns.delegationId,
      actorColumns.delegatingPrincipalKind,
      actorColumns.delegatingPrincipalId,
      actorColumns.delegatedToPrincipalKind,
      actorColumns.delegatedToPrincipalId,
      POLICY_DECISION_EVIDENCE_VERSION,
      command.authorization.policyVersion,
      command.authorization.evaluatorVersion,
      JSON.stringify(policyInputs),
      JSON.stringify(metadata),
      ids.changeDocumentId,
      ids.domainEventId,
      ids.outboxId,
      result.recordedAt,
    ],
  );
  await client.query(
    `INSERT INTO platform.trust_business_change_documents (
       tenant_id, environment_id, change_document_id, document_version,
       invocation_id, invocation_outcome, request_id, action_id,
       correlation_id, release_id, release_content_hash, record_type,
       record_id, revision, changes, execution_principal_kind,
       execution_principal_id, subject_principal_kind, subject_principal_id,
       initiating_human_id, approving_human_id, delegation_id,
       delegating_principal_kind, delegating_principal_id,
       delegated_to_principal_kind, delegated_to_principal_id,
       domain_event_id, outbox_id, recorded_at
     ) VALUES (
       $1,$2,$3,$4,$5,'SUCCEEDED',$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
       $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
     )`,
    [
      context.tenantId,
      context.environmentId,
      ids.changeDocumentId,
      BUSINESS_CHANGE_DOCUMENT_VERSION,
      ids.invocationId,
      context.requestId,
      registration.capabilityId,
      ids.correlationId,
      registration.releaseId,
      registration.releaseContentHash,
      recordType,
      stockCount?.stockCountId ?? command.transactionId,
      transactionRevision,
      JSON.stringify(changes),
      actorColumns.executionPrincipalKind,
      actorColumns.executionPrincipalId,
      actorColumns.subjectPrincipalKind,
      actorColumns.subjectPrincipalId,
      actorColumns.initiatingHumanId,
      actorColumns.approvingHumanId,
      actorColumns.delegationId,
      actorColumns.delegatingPrincipalKind,
      actorColumns.delegatingPrincipalId,
      actorColumns.delegatedToPrincipalKind,
      actorColumns.delegatedToPrincipalId,
      ids.domainEventId,
      ids.outboxId,
      result.recordedAt,
    ],
  );
  await client.query(
    `INSERT INTO platform.trust_domain_events (
       tenant_id, environment_id, domain_event_id, domain_event_version,
       invocation_id, invocation_outcome, change_document_id, request_id,
       action_id, correlation_id, release_id, release_content_hash,
       event_type, event_schema_version, payload, outbox_id, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16)`,
    [
      context.tenantId,
      context.environmentId,
      ids.domainEventId,
      TRUST_DOMAIN_EVENT_VERSION,
      ids.invocationId,
      ids.changeDocumentId,
      context.requestId,
      registration.capabilityId,
      ids.correlationId,
      registration.releaseId,
      registration.releaseContentHash,
      eventType,
      eventVersion,
      JSON.stringify(eventPayload),
      ids.outboxId,
      result.recordedAt,
    ],
  );
  await client.query(
    `INSERT INTO platform.trust_outbox (
       tenant_id, environment_id, outbox_id, outbox_version, invocation_id,
       invocation_outcome, change_document_id, domain_event_id, request_id,
       action_id, correlation_id, release_id, release_content_hash, event_type,
       event_schema_version, deduplication_key, recorded_at
     ) VALUES ($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      context.tenantId,
      context.environmentId,
      ids.outboxId,
      TRUST_OUTBOX_VERSION,
      ids.invocationId,
      ids.changeDocumentId,
      ids.domainEventId,
      context.requestId,
      registration.capabilityId,
      ids.correlationId,
      registration.releaseId,
      registration.releaseContentHash,
      eventType,
      eventVersion,
      effectDeduplicationKey(posting),
      result.recordedAt,
    ],
  );
  return Object.freeze({
    changeDocumentId: ids.changeDocumentId,
    correlationId: ids.correlationId,
    domainEventId: ids.domainEventId,
    invocationId: ids.invocationId,
    outboxId: ids.outboxId,
  });
}

function resolvedActorColumns(actor: ResolvedActorAttribution) {
  return {
    approvingHumanId: actor.approvingHumanId,
    delegatedToPrincipalId: actor.delegation?.delegatedTo.principalId ?? null,
    delegatedToPrincipalKind: actor.delegation?.delegatedTo.kind ?? null,
    delegatingPrincipalId:
      actor.delegation?.delegatingPrincipal.principalId ?? null,
    delegatingPrincipalKind: actor.delegation?.delegatingPrincipal.kind ?? null,
    delegationId: actor.delegation?.delegationId ?? null,
    executionPrincipalId: actor.executionPrincipal.principalId,
    executionPrincipalKind: actor.executionPrincipal.kind,
    initiatingHumanId: actor.initiatingHumanId,
    subjectPrincipalId: actor.subject?.principalId ?? null,
    subjectPrincipalKind: actor.subject?.kind ?? null,
  };
}

function mintEvidenceIds(mintUuid: () => string): EvidenceIds {
  const ids = {
    changeDocumentId: mintUuid(),
    correlationId: mintUuid(),
    domainEventId: mintUuid(),
    invocationId: mintUuid(),
    outboxId: mintUuid(),
  };
  for (const [name, value] of Object.entries(ids)) requiredUuid(value, name);
  if (new Set(Object.values(ids)).size !== Object.keys(ids).length) {
    throw inputError('minted trust fact IDs must be distinct');
  }
  return ids;
}

function businessChange(
  fieldId: string,
  oldValue: unknown,
  newValue: unknown,
): BusinessFieldChangeInput {
  return {
    classification: 'INTERNAL',
    fieldId,
    newState: { state: 'VALUE', value: newValue },
    oldState:
      oldValue === null
        ? { state: 'ABSENT' }
        : { state: 'VALUE', value: oldValue },
  };
}

function classified(classification: 'INTERNAL' | 'PUBLIC', value: unknown) {
  return { classification, value } as const;
}

function capabilityNamespace(capabilityId: string): string {
  return capabilityId.slice(0, capabilityId.indexOf(':'));
}

function stockCountResult(
  posting: ParsedPosting,
): InventoryPostingResultV1['stockCount'] {
  if (
    posting.postingRole !== 'count' &&
    posting.postingRole !== 'correction'
  ) {
    return null;
  }
  return Object.freeze({
    kind: posting.command.countKind,
    lineIds: Object.freeze(
      posting.command.lines
        .map((line) => line.stockCountLineId)
        .toSorted(),
    ),
    stockCountId: posting.command.stockCountId,
    supersedesStockCountId: posting.command.supersedesStockCountId,
  });
}

function effectDeduplicationKey(posting: ParsedPosting): string {
  const { command } = posting;
  const natural = naturalEffects(posting)
    .map((effect) => [
      command.legalEntityId,
      command.sourceType,
      command.sourceId,
      effect.sourceLine,
      command.sourceRevision,
      posting.postingRole,
    ])
    .toSorted((left, right) => {
      const a = left.join('\u001f');
      const b = right.join('\u001f');
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return `inventory-posting-v1:${createHash('sha256')
    .update(canonicalize(natural))
    .digest('hex')}`;
}

function naturalEffects(
  posting: ParsedPosting,
): readonly { readonly sourceLine: string }[] {
  if (
    posting.postingRole === 'adjustment' ||
    posting.postingRole === 'count' ||
    posting.postingRole === 'correction'
  ) {
    return posting.command.lines.map((line) => ({
      sourceLine: line.sourceLine,
    }));
  }
  return posting.command.lines.flatMap((line) => [
    { sourceLine: transferEffectSourceLine(line.sourceLine, 'out') },
    { sourceLine: transferEffectSourceLine(line.sourceLine, 'in') },
  ]);
}

function currentCommandDigest(posting: ParsedPosting): VersionedInputDigest {
  return Object.freeze({
    value: digestCommand(posting, currentInventoryPostingInputDigestVersion),
    version: currentInventoryPostingInputDigestVersion,
  });
}

function digestCommand(posting: ParsedPosting, version: number): string {
  const { command } = posting;
  const { idempotencyKey, ...semanticInput } = command;
  void idempotencyKey;
  const digestInput =
    version === legacyInventoryPostingInputDigestVersion
      ? semanticInput
      : version === transferInventoryPostingInputDigestVersion ||
          version === currentInventoryPostingInputDigestVersion
        ? { postingRole: posting.postingRole, ...semanticInput }
        : unsupportedReceiptVersion(version);
  return createHash('sha256').update(canonicalize(digestInput)).digest('hex');
}

function recordedResultForReplay(
  receipt: RecordedReceiptRow,
): InventoryPostingResultV1 {
  const version = receipt.input_digest_version;
  if (
    version !== legacyInventoryPostingInputDigestVersion &&
    version !== transferInventoryPostingInputDigestVersion &&
    version !== currentInventoryPostingInputDigestVersion
  ) {
    return unsupportedReceiptVersion(version);
  }
  const movements = receipt.mutation_result.movements.map((movement) =>
    Object.freeze({
      ...movement,
      postingRole:
        version === legacyInventoryPostingInputDigestVersion
          ? 'adjustment'
          : requiredRecordedPostingRole(movement.postingRole, version),
      reversalOfMovementId: movement.reversalOfMovementId ?? null,
    }),
  );
  return Object.freeze({
    ...receipt.mutation_result,
    movements,
    replayed: true,
    stockCount: receipt.mutation_result.stockCount ?? null,
  });
}

function requiredRecordedPostingRole(
  postingRole: InventoryPostingRoleV1 | undefined,
  version: number,
): InventoryPostingRoleV1 {
  if (
    postingRole === 'adjustment' ||
    postingRole === 'transfer' ||
    (version === currentInventoryPostingInputDigestVersion &&
      (postingRole === 'count' || postingRole === 'correction'))
  ) {
    return postingRole;
  }
  throw postingError(
    'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
    'persisted posting receipt has no valid posting role',
  );
}

function unsupportedReceiptVersion(version: number): never {
  throw postingError(
    'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
    `persisted posting receipt uses unsupported input digest version ${String(version)}`,
    { inputDigestVersion: String(version) },
  );
}

function assertActorContext(
  context: TrustedRequestContext,
  actorEnvelope: TrustedActorEnvelope,
): void {
  if (
    actorEnvelope.tenantId !== context.tenantId ||
    actorEnvelope.environmentId !== context.environmentId ||
    actorEnvelope.principalId !== context.principalId ||
    actorEnvelope.requestId !== context.requestId ||
    actorEnvelope.actor.executionPrincipal.principalId !== context.principalId
  ) {
    throw inputError('trusted actor envelope does not match request context');
  }
}

function dateOrdinal(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed))
    throw inputError(`invalid business period ${value}`);
  return Math.trunc(parsed / 86_400_000);
}

function decimalToScaled(value: string, name: string): bigint {
  if (!canonicalDecimalPattern.test(value)) {
    throw inputError(`${name} must be a canonical signed decimal`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  if (whole!.length + fraction.length > 38 || fraction.length > 18) {
    throw inputError(`${name} exceeds numeric(38,18)`);
  }
  const scaled = BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  return negative ? -scaled : scaled;
}

function scaledToDecimal(value: bigint): string {
  const negative = value < 0n;
  const absoluteValue = negative ? -value : value;
  const whole = absoluteValue / 10n ** 18n;
  const fraction = String(absoluteValue % 10n ** 18n)
    .padStart(18, '0')
    .replace(/0+$/u, '');
  const normalized =
    fraction.length === 0 ? String(whole) : `${String(whole)}.${fraction}`;
  return negative ? `-${normalized}` : normalized;
}

function normalizeDecimal(value: string): string {
  return scaledToDecimal(decimalToScaled(value, 'decimal'));
}

function normalizeDatabaseDecimal(value: string): string {
  return scaledToDecimal(databaseDecimalToScaled(value));
}

function databaseDecimalToScaled(value: string): bigint {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/u.test(value)) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_REJECTED',
      'stored quantity is not numeric(38,18)',
    );
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const scaled = BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  return negative ? -scaled : scaled;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function canonicalInstant(value: string, name: string): string {
  if (!instantPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw inputError(`${name} must be a millisecond UTC instant`);
  }
  return value;
}

function requiredUuid(value: string, name: string): void {
  if (!uuidPattern.test(value)) throw inputError(`${name} must be a UUID`);
}

function requiredText(value: string, name: string, maximum: number): void {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw inputError(
      `${name} must be non-blank and at most ${String(maximum)} characters`,
    );
  }
}

function boundedText(value: string, name: string, maximum: number): void {
  if (typeof value !== 'string' || value.length > maximum) {
    throw inputError(`${name} must be at most ${String(maximum)} characters`);
  }
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw inputError('posting input objects must use the closed shape');
  }
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw inputError(
      `posting input shape mismatch: expected ${wanted.join(',')}; received ${actual.join(',')}`,
    );
  }
}

function isChannel(value: unknown): value is InvocationChannel {
  return (
    value === 'AGENT' ||
    value === 'API' ||
    value === 'IMPORT' ||
    value === 'SYSTEM' ||
    value === 'UI' ||
    value === 'WORKFLOW'
  );
}

function safeIdentifier(value: string): string {
  if (!identifierPattern.test(value)) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `unsafe emitted PostgreSQL identifier ${value}`,
    );
  }
  return value;
}

function quoted(value: string): string {
  return `"${safeIdentifier(value)}"`;
}

function table(binding: PostingStorageBinding, entity: EntityBinding): string {
  return `${quoted(binding.schemaName)}.${quoted(entity.tableName)}`;
}

function postingError(
  code: InventoryPostingErrorCode,
  message: string,
  details: Readonly<Record<string, string>> = Object.freeze({}),
): InventoryPostingError {
  return new InventoryPostingError(
    code,
    message,
    Object.freeze({ ...details }),
  );
}

function inputError(message: string): InventoryPostingError {
  return postingError('INVENTORY_POSTING_INPUT_INVALID', message);
}

function postgresCode(error: unknown): string | undefined {
  return postgresErrorProperty(error, 'code');
}

function postgresErrorProperty(
  error: unknown,
  property: 'code' | 'detail' | 'message',
): string | undefined {
  if (typeof error !== 'object' || error === null || !(property in error))
    return undefined;
  const value = (error as Readonly<Record<string, unknown>>)[property];
  return typeof value === 'string' ? value : undefined;
}

function baseUnitImmutableDetails(
  error: unknown,
): Readonly<Record<string, string>> | null {
  const detail = postgresErrorProperty(error, 'detail');
  if (!detail) return null;
  const match = baseUnitImmutableDetailPattern.exec(detail);
  if (!match) return null;
  return Object.freeze({
    bindingMovementId: match[2]!,
    bindingUnitId: match[3]!,
    itemId: match[1]!,
    requestedUnitId: match[4]!,
  });
}

export function translateInventoryPostingError(error: unknown): unknown {
  if (error instanceof InventoryPostingError) return error;
  const code = postgresCode(error);
  if (
    code === 'P0001' &&
    postgresErrorProperty(error, 'message') === 'INVENTORY_BASE_UNIT_IMMUTABLE'
  ) {
    const details = baseUnitImmutableDetails(error);
    if (details) {
      return postingError(
        'INVENTORY_BASE_UNIT_IMMUTABLE',
        'item base unit cannot change after its first referenced movement',
        details,
      );
    }
  }
  if (code === '55P03') {
    return postingError(
      'INVENTORY_POSTING_LOCK_TIMEOUT',
      `a required posting lock was not acquired within ${String(inventoryPostingLockTimeoutMilliseconds)} ms`,
      {
        lockTimeoutMilliseconds: String(
          inventoryPostingLockTimeoutMilliseconds,
        ),
        sqlstate: code,
      },
    );
  }
  if (code) {
    return postingError(
      'INVENTORY_POSTING_STORAGE_REJECTED',
      `PostgreSQL rejected inventory posting (${code})`,
      { sqlstate: code },
    );
  }
  return error;
}
