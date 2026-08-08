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
const standardInventoryPostingInputDigestVersion = 2 as const;
const stockCountInventoryPostingInputDigestVersion = 3 as const;
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

/**
 * PS-1 PROBE ONLY. The second invocation capability, over the same kernel.
 * Purchasing's authority is its own; the kernel's contract is not.
 */
export const PURCHASING_RECEIPT_POSTING_CAPABILITY_ID =
  `${'northstar'}.${'purchasing'}:capability.receipt_posting` as const;

/**
 * PS-1 PROBE ONLY. Invocation-capability identity: a **closed union**, not
 * `string`. Widening this to `string` is the naive move ADR-0049's reviewer
 * named — it would give every ID its own request-key lock, receipt, result and
 * trust identity while handing all of them the same union authority. A closed
 * union keeps an unadmitted ID a type error at assembly *and* a refusal at
 * registration.
 */
export type InventoryPostingCapabilityIdV1 =
  | typeof INVENTORY_POSTING_CAPABILITY_ID
  | typeof PURCHASING_RECEIPT_POSTING_CAPABILITY_ID;

/**
 * PS-1 PROBE ONLY. What a capability may *execute*, as distinct from what it
 * may *invoke*. Separate names without separate admission is not a boundary.
 */
export type InventoryPostingCommandFamilyV1 =
  | 'adjustment'
  | 'goodsReceipt'
  | 'stockCount'
  | 'transfer';

/**
 * PS-2 PROBE ONLY. The compiled posting-family profile, as the provider
 * consumes it.
 *
 * This is a **payload**, reaching the kernel exactly the way `storageTarget`
 * does: authored in `@north-star/domain`
 * (`inventory/posting-families.ts`), compiled into the release, handed to the
 * registration by the caller, and content-hashed. The provider does not depend
 * on domain and must not — it is a generic storage adapter — so the values
 * arrive as data and the provider validates their shape.
 *
 * It replaces three separate `PS-1` mechanisms that could drift from each other:
 * an `admittedFamilies` list, a `dependencyExtensionRoot` literal, and a
 * `familyId: string` compared against `'goods_receipt'` to select authorization.
 * All three are now views of one declaration.
 */
export interface InventoryPostingFamilyProfilePayloadV1 {
  readonly capabilityId: string;
  readonly commandSchema: string;
  readonly companion: {
    readonly createdByKernel: boolean;
    readonly identity: {
      readonly companionHeader: 'derivedFromSourceDocument';
      readonly companionLine: 'derivedFromSourceLine';
      readonly sourceLine: 'derivedFromSourceDocument' | 'notApplicable';
    };
    readonly origin: 'authored' | 'companion';
    readonly sourceTypeLiteral: string;
    readonly transactionTypeLocalId: string;
  };
  readonly dependencyExtension: readonly {
    readonly access: string;
    readonly authority: string;
    readonly dependencyId: string;
  }[];
  readonly familyId: InventoryPostingCommandFamilyV1;
  readonly postingRole: string;
  readonly reachability: {
    readonly genericAuthoring: 'admitted' | 'closed';
    readonly genericRead: 'admitted' | 'closed';
  };
  readonly revisions: {
    readonly companionRevisionAuthority: 'callerSupplied' | 'kernelMinted';
    readonly foreignSourceExpectedRevision: 'absent' | 'required';
  };
  readonly sourceStep: 'foreignPort' | 'inventoryInternal';
}

export interface InventoryPostingFamilyCatalogPayloadV1 {
  readonly profiles: readonly InventoryPostingFamilyProfilePayloadV1[];
  readonly schemaVersion: 'northstar.inventory-posting-family-profile/v1';
}

/**
 * PS-2. Derived from the catalog, never declared beside it. `PS-1` kept an
 * admission list next to an extension root and asserted they could not drift;
 * deriving both from one declaration is what makes that true instead of stated.
 */
export function dependencyExtensionRootFor(
  catalog: InventoryPostingFamilyCatalogPayloadV1,
  capabilityId: string,
): string {
  const seen = new Set<string>();
  for (const profile of catalog.profiles) {
    if (profile.capabilityId !== capabilityId) continue;
    for (const entry of profile.dependencyExtension) {
      seen.add(`${entry.access}\0${entry.authority}\0${entry.dependencyId}`);
    }
  }
  return createHash('sha256')
    .update('northstar.inventory-posting-dependency-extension/v1')
    .update('\0')
    .update([...seen].toSorted().join('\n'))
    .digest('hex');
}

/**
 * PS-2 PROBE ONLY. The provider's copy of the posting-family catalog.
 *
 * The values are authored in `@north-star/domain`
 * (`inventory/posting-families.ts`). They belong in a compiled projection, read
 * through `context.projection(...)` exactly as `storageTarget` is — and `PUR-2`
 * owes that projection, which is a compiler event under ADR-0047 rather than
 * something a probe may invent.
 *
 * Until then the values exist in two places, which is the drift class this
 * repository has already recorded twice (the authority literal at
 * `contracts.ts:200-207` duplicated at `conformance.ts:3215-3222`, and
 * `reBaseline` present in `INVENTORY_POSTING_ROLES` and absent from
 * `InventoryPostingRoleV1` with nothing failing). **So it is not left to hold:**
 * `test/unit/posting-family-catalog-parity.test.ts` asserts this constant and
 * the domain declaration are identical and hash equal. A duplicate behind a
 * gate is debt; a duplicate behind an assurance is the defect.
 */
export const INVENTORY_POSTING_FAMILY_CATALOG_V1: InventoryPostingFamilyCatalogPayloadV1 =
  Object.freeze({
    profiles: Object.freeze([
      Object.freeze({
        capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
        commandSchema: 'northstar.inventory-adjustment-posting-command/v1',
        companion: Object.freeze({
          createdByKernel: false,
          identity: Object.freeze({
            companionHeader: 'derivedFromSourceDocument',
            companionLine: 'derivedFromSourceLine',
            sourceLine: 'notApplicable',
          }),
          origin: 'authored',
          sourceTypeLiteral: 'adjustment',
          transactionTypeLocalId: 'inventory_transaction_type_adjustment',
        }),
        dependencyExtension: Object.freeze([]),
        familyId: 'adjustment',
        postingRole: 'adjustment',
        reachability: Object.freeze({
          genericAuthoring: 'admitted',
          genericRead: 'admitted',
        }),
        revisions: Object.freeze({
          companionRevisionAuthority: 'callerSupplied',
          foreignSourceExpectedRevision: 'absent',
        }),
        sourceStep: 'inventoryInternal',
      }),
      Object.freeze({
        capabilityId: PURCHASING_RECEIPT_POSTING_CAPABILITY_ID,
        commandSchema: 'northstar.inventory-goods-receipt-posting-command/v1',
        companion: Object.freeze({
          createdByKernel: true,
          identity: Object.freeze({
            companionHeader: 'derivedFromSourceDocument',
            companionLine: 'derivedFromSourceLine',
            sourceLine: 'derivedFromSourceDocument',
          }),
          origin: 'companion',
          sourceTypeLiteral: 'goodsReceipt',
          transactionTypeLocalId: 'inventory_transaction_type_goods_receipt',
        }),
        dependencyExtension: Object.freeze([
          { access: 'read', authority: 'inventory', dependencyId: 'northstar.purchasing:goods_receipt' },
          { access: 'read', authority: 'inventory', dependencyId: 'northstar.purchasing:goods_receipt_line' },
          { access: 'read', authority: 'inventory', dependencyId: 'northstar.purchasing:purchase_order' },
          { access: 'read', authority: 'inventory', dependencyId: 'northstar.purchasing:purchase_order_line' },
          { access: 'transition', authority: 'inventory', dependencyId: 'northstar.purchasing:goods_receipt.state' },
          { access: 'append', authority: 'inventory', dependencyId: 'northstar.inventory:transaction' },
          { access: 'append', authority: 'inventory', dependencyId: 'northstar.inventory:transaction_line' },
        ]),
        familyId: 'goodsReceipt',
        postingRole: 'receipt',
        reachability: Object.freeze({
          genericAuthoring: 'closed',
          genericRead: 'closed',
        }),
        revisions: Object.freeze({
          companionRevisionAuthority: 'kernelMinted',
          foreignSourceExpectedRevision: 'required',
        }),
        sourceStep: 'foreignPort',
      }),
      Object.freeze({
        capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
        commandSchema: 'northstar.inventory-stock-count-posting-command/v1',
        companion: Object.freeze({
          createdByKernel: true,
          identity: Object.freeze({
            companionHeader: 'derivedFromSourceDocument',
            companionLine: 'derivedFromSourceLine',
            sourceLine: 'derivedFromSourceDocument',
          }),
          origin: 'companion',
          sourceTypeLiteral: 'stockCount',
          transactionTypeLocalId:
            'inventory_transaction_type_count_correction',
        }),
        dependencyExtension: Object.freeze([
          { access: 'append', authority: 'inventory', dependencyId: 'northstar.inventory:transaction' },
          { access: 'append', authority: 'inventory', dependencyId: 'northstar.inventory:transaction_line' },
        ]),
        familyId: 'stockCount',
        postingRole: 'count',
        reachability: Object.freeze({
          genericAuthoring: 'closed',
          genericRead: 'closed',
        }),
        revisions: Object.freeze({
          companionRevisionAuthority: 'kernelMinted',
          foreignSourceExpectedRevision: 'required',
        }),
        sourceStep: 'inventoryInternal',
      }),
      Object.freeze({
        capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
        commandSchema: 'northstar.inventory-transfer-posting-command/v1',
        companion: Object.freeze({
          createdByKernel: false,
          identity: Object.freeze({
            companionHeader: 'derivedFromSourceDocument',
            companionLine: 'derivedFromSourceLine',
            sourceLine: 'notApplicable',
          }),
          origin: 'authored',
          sourceTypeLiteral: 'transfer',
          transactionTypeLocalId: 'inventory_transaction_type_transfer',
        }),
        dependencyExtension: Object.freeze([]),
        familyId: 'transfer',
        postingRole: 'transfer',
        reachability: Object.freeze({
          genericAuthoring: 'admitted',
          genericRead: 'admitted',
        }),
        revisions: Object.freeze({
          companionRevisionAuthority: 'callerSupplied',
          foreignSourceExpectedRevision: 'absent',
        }),
        sourceStep: 'inventoryInternal',
      }),
    ]),
    schemaVersion: 'northstar.inventory-posting-family-profile/v1',
  });

export interface InventoryPostingRegistrationV1 {
  readonly capabilityId: InventoryPostingCapabilityIdV1;
  readonly capabilityVersion: typeof INVENTORY_POSTING_CAPABILITY_VERSION;
  /** The frozen kernel baseline. One value, shared by every registration. */
  readonly dependencySetRoot: typeof INVENTORY_POSTING_DEPENDENCY_SET_ROOT;
  /**
   * PS-2: the compiled posting-family catalog. Optional only until `PUR-2`
   * lands the projection that carries it; the invariants below always run.
   */
  readonly postingFamilyCatalog?: InventoryPostingFamilyCatalogPayloadV1;
  readonly postingFamilyCatalogContentHash?: string;
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

export type InventoryStockCountKindV1 = 'initial' | 'correction' | 'reversal';

export interface InventoryStockCountLineV1 {
  readonly countedQuantity: string;
  readonly expectedQuantity: string;
  readonly itemId: string;
  readonly reversalOfMovementId: string | null;
  readonly sourceLine: string;
  readonly stockCountLineId: string;
  readonly transactionLineId: string;
  readonly unitId: string;
  readonly varianceQuantity: string;
}

export interface InventoryStockCountPostingCommandV1 {
  readonly authorization: InventoryPostingAuthorizationV1;
  readonly channel: InvocationChannel;
  readonly effectiveAt: string;
  readonly idempotencyKey: string;
  readonly kind: InventoryStockCountKindV1;
  readonly legalEntityId: string;
  readonly lines: readonly InventoryStockCountLineV1[];
  readonly locationId: string;
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

/**
 * PS-2 PROBE ONLY. A receipt line as the *source* document describes it. It
 * carries no `transactionLineId`: companion line identity is derived from the
 * source line, exactly as the companion header's is derived from the source
 * document. `PS-1` derived the header's and left the line's caller-supplied,
 * which meant a caller could still choose half the companion's identity.
 */
export interface InventoryGoodsReceiptLineV1 {
  readonly goodsReceiptLineId: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: string;
  readonly sourceLine: string;
  readonly unitId: string;
}

/**
 * PS-2 PROBE ONLY. The receipt command.
 *
 * The revision split is the point. `PS-1` had one `sourceRevision` doing three
 * jobs — the foreign receipt's expected revision, the companion transaction's
 * expected revision, and the revision stamped onto every movement. A
 * kernel-minted companion's revision is internal: the kernel creates the row, so
 * nothing outside it can have observed a revision to assert. Only the receipt's
 * is a caller fact, and only it is carried.
 */
export interface InventoryGoodsReceiptPostingCommandV1 {
  readonly authorization: InventoryPostingAuthorizationV1;
  readonly channel: InvocationChannel;
  readonly effectiveAt: string;
  readonly goodsReceiptId: string;
  readonly idempotencyKey: string;
  readonly legalEntityId: string;
  readonly lines: readonly InventoryGoodsReceiptLineV1[];
  readonly purchaseOrderId: string;
  readonly reason: {
    readonly code: string;
    readonly narrative: string | null;
  };
  /** The foreign source document's expected revision. Not the companion's. */
  readonly sourceExpectedRevision: number;
  readonly stockDimensionSetVersion: 'v1';
  readonly supersedesGoodsReceiptId: string | null;
}

/**
 * The **kernel** command union — what `#post` plans movements from. A family's
 * *source* command (`InventoryGoodsReceiptPostingCommandV1`) is deliberately
 * NOT a member: it carries no `transactionId`, no `sourceType` and no companion
 * revision, because those are derived under the profile rather than supplied.
 * `PS-1` conflated the two, which is how a receipt ended up being an adjustment
 * command in every sense that mattered.
 */
export type InventoryPostingCommandV1 =
  | InventoryAdjustmentPostingCommandV1
  | InventoryStockCountPostingCommandV1
  | InventoryTransferPostingCommandV1;

/**
 * PS-2 adds `receipt`. ADR-0049 §5 priced this at eight code sites plus a
 * migration and the probe pays it in fixture form rather than in the shipped
 * release: the compiled enums are extended in the probe's own definition, so
 * `PUR-2` inherits a measured price rather than an estimate.
 */
export type InventoryPostingRoleV1 =
  'adjustment' | 'correction' | 'count' | 'receipt' | 'transfer';

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
  readonly sourceId: string;
  readonly sourceLine: string;
  readonly sourceRevision: number;
  readonly sourceType: string;
  readonly stockDimensionSetVersion: 'v1';
  readonly transactionLineId: string;
  readonly unitId: string;
}

export interface PostedStockCountLineEvidenceV1 {
  readonly countedQuantity: string;
  readonly expectedQuantity: string;
  readonly itemId: string;
  readonly movementId: string;
  readonly reversalOfMovementId: string | null;
  readonly sourceLine: string;
  readonly stockCountLineId: string;
  readonly transactionLineId: string;
  readonly unitId: string;
  readonly varianceQuantity: string;
}

export interface PostedStockCountEvidenceV1 {
  readonly kind: InventoryStockCountKindV1;
  readonly lines: readonly PostedStockCountLineEvidenceV1[];
  readonly locationId: string;
  readonly stockCountId: string;
  readonly supersedesStockCountId: string | null;
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
  readonly stockCountEvidence: PostedStockCountEvidenceV1 | null;
  readonly transactionId: string;
  readonly trust: InventoryPostingTrustLinksV1;
}

export type InventoryAdjustmentPostingResultV1 = InventoryPostingResultV1;
export type InventoryTransferPostingResultV1 = InventoryPostingResultV1;
export type InventoryStockCountPostingResultV1 = InventoryPostingResultV1;

type RecordedInventoryPostingResult = Omit<
  InventoryPostingResultV1,
  'movements' | 'stockCountEvidence'
> & {
  readonly stockCountEvidence?: PostedStockCountEvidenceV1 | null;
  readonly movements: readonly (Omit<
    PostedInventoryMovementV1,
    'postingRole'
  > & {
    readonly postingRole?: InventoryPostingRoleV1;
  })[];
};

export type InventoryPostingErrorCode =
  | 'INVENTORY_ADJUSTMENT_APPROVAL_REQUIRED'
  | 'INVENTORY_ADJUSTMENT_REASON_REQUIRED'
  | 'INVENTORY_BACKDATE_LIMIT_EXCEEDED'
  | 'INVENTORY_BASE_UNIT_IMMUTABLE'
  | 'INVENTORY_COUNT_APPROVAL_REQUIRED'
  | 'INVENTORY_COUNT_COMPENSATION_CONFLICT'
  | 'INVENTORY_COUNT_EVIDENCE_CONFLICT'
  | 'INVENTORY_COUNT_REASON_REQUIRED'
  | 'INVENTORY_ITEM_INACTIVE'
  | 'INVENTORY_ITEM_UNIT_MISMATCH'
  | 'INVENTORY_LEGAL_ENTITY_INACTIVE'
  | 'INVENTORY_LOCATION_INACTIVE'
  | 'INVENTORY_PERIOD_CLOSED'
  | 'INVENTORY_POSTING_CAPABILITY_MISMATCH'
  /** PS-1: the invoking capability is registered, but not for this family. */
  | 'INVENTORY_POSTING_COMMAND_FAMILY_NOT_ADMITTED'
  | 'INVENTORY_POSTING_COMPANION_CONFLICT'
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
  movementReversalOfMovementColumn: string;
  movementStockVersionV1: string;
  periodLock: EntityBinding;
  periodLockClosedThroughColumn: string;
  schemaName: string;
  transaction: EntityBinding;
  /** PS-2. Raw compiled options, so a profile can name any of them by local id. */
  transactionTypeOptions: readonly string[];
  movementPostingRoleOptions: readonly string[];
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
  stockCount: EntityBinding;
  stockCountActorColumn: string;
  stockCountCountedAtColumn: string;
  stockCountInitialKind: string;
  stockCountCorrectionKind: string;
  stockCountKindColumn: string;
  stockCountLocationColumn: string;
  stockCountPostedState: string;
  stockCountReasonCodeColumn: string;
  stockCountReasonNarrativeColumn: string;
  stockCountRecordedAtColumn: string;
  stockCountRelationToTransactionColumn: string;
  stockCountReviewedState: string;
  stockCountReversalKind: string;
  stockCountStateColumn: string;
  stockCountSupersedesColumn: string;
  stockCountLine: EntityBinding;
  stockCountLineCountedColumn: string;
  stockCountLineExpectedColumn: string;
  stockCountLineItemColumn: string;
  stockCountLineLineNumberColumn: string;
  stockCountLineRelationToSessionColumn: string;
  stockCountLineRelationToTransactionLineColumn: string;
  stockCountLineReversalColumn: string;
  stockCountLineUnitColumn: string;
  stockCountLineVarianceColumn: string;
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
  readonly version:
    | typeof standardInventoryPostingInputDigestVersion
    | typeof stockCountInventoryPostingInputDigestVersion;
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
      readonly familyId: 'adjustment';
      readonly postingRole: 'adjustment';
    }
  | {
      readonly command: InventoryTransferPostingCommandV1;
      readonly familyId: 'transfer';
      readonly postingRole: 'transfer';
    }
  | {
      readonly command: InventoryStockCountPostingCommandV1;
      readonly familyId: 'stockCount';
      readonly postingRole: 'correction' | 'count';
    }
  | {
      /**
       * The kernel movement-planning shape, **derived** from `source` under the
       * profile. It is not an adjustment command and is never built by a
       * caller: `transactionId`, every `transactionLineId`, `sourceType` and
       * `sourceRevision` are all derived here rather than supplied.
       */
      readonly command: InventoryAdjustmentPostingCommandV1;
      readonly familyId: 'goodsReceipt';
      readonly postingRole: 'receipt';
      readonly source: InventoryGoodsReceiptPostingCommandV1;
    };

/**
 * PS-1 PROBE ONLY. One companion line, derived from a source line under lock.
 * `transactionLineId` is deterministic for the same reason the header id is:
 * a retried posting must land on the same rows rather than mint a second set.
 */
export interface InventoryCompanionLineDerivationV1 {
  readonly fromLocationId: string | null;
  readonly itemId: string;
  readonly lineNumber: string;
  readonly quantity: string;
  readonly toLocationId: string | null;
  readonly transactionLineId: string;
  readonly unitId: string;
}

/**
 * PS-1 PROBE ONLY. The complete companion representation, derived from the
 * locked source. It carries **no** state and **no** type: the kernel selects
 * both, exactly as `transitionTransactionToPosted` selects the posted state
 * from compiled storage rather than from an input. A port that could name its
 * companion's `type` could mint a companion whose header claims an origin its
 * movements do not have — which is the third condition ADR-0049 omitted, and
 * which `PS-0`'s own fixture violated by staging a header typed `adjustment`
 * while its `source_type` said `goodsReceipt`.
 */
export interface InventoryCompanionDerivationV1 {
  readonly effectiveAt: string;
  readonly lines: readonly InventoryCompanionLineDerivationV1[];
  readonly number: string;
  readonly reason: { readonly code: string; readonly narrative: string | null };
  readonly sourceId: string;
  readonly sourceType: string;
  readonly transactionId: string;
}

/**
 * PS-0 PROBE ONLY — NOT FOR MERGE.
 *
 * The cross-domain source-aggregate port. A foreign document aggregate cannot
 * *enter* this service's transaction: `#post` calls `pool.connect()` itself and
 * never accepts a client, so there is no outside position from which to join it.
 * What the transaction can do is *carry* the aggregate, by handing it the client
 * at the two points ADR-0026's transaction contract already names — step 4/5
 * (locks held, module role assumed, business validation) and step 7 (inside the
 * single post-lock savepoint, compare-and-swap transition).
 *
 * This is the same shape ADR-0029 gave `stock_count`, with the hard-coded
 * `isStockCountPosting` branches replaced by an injected port.
 */
export interface InventorySourceAggregateStepV1 {
  /** Diagnostic name of the foreign aggregate family, e.g. `goods_receipt`. */
  readonly familyId: string;
  /**
   * PS-1 PROBE ONLY. The companion derivation, returned as *data* rather than
   * written by the port.
   *
   * `PS-0` left the companion `inventory_transaction` with no writer: `#post`
   * requires it to already exist, and this port only locked and transitioned.
   * `PS-1` rules that the kernel creates it, from a derivation the port computes
   * off the source rows it has just locked. Two properties follow that a staged
   * companion cannot have:
   *
   *  - **Congruence by construction.** The derivation is read under the same
   *    lock, in the same transaction, that the movement append and the source
   *    transition share. There is no window in which the source can move away
   *    from its companion, so no repair policy is owed for source edits.
   *  - **The kernel stays the sole writer.** The port never holds an `INSERT`
   *    into `inventory_transaction`; it returns values. `#post` remains the only
   *    code that writes the companion, exactly as it is the only code that
   *    writes a movement.
   */
  deriveCompanion(
    client: PoolClient,
    context: TrustedRequestContext,
    command: InventoryPostingCommandV1,
  ): Promise<InventoryCompanionDerivationV1>;
  /**
   * ADR-0026 step 4/5. Every stock identity is already locked and the request
   * key is held. Must row-lock the foreign aggregate in a deterministic order,
   * validate it against the persisted state, and return a digest of everything
   * it validated. No caller preflight may substitute for this.
   *
   * PS-2 calls this *ahead* of the companion header lock, so the source is
   * locked before the companion is derived from it. That is a **reorder** of the
   * {companion header, source} edge, not a widening — no edge is added — and a
   * reorder is only sound if it is uniform across every family. See `#post`.
   */
  lockAndValidate(
    client: PoolClient,
    context: TrustedRequestContext,
    command: InventoryPostingCommandV1,
  ): Promise<string>;
  /**
   * ADR-0026 step 7, inside the post-lock savepoint. Must be a compare-and-swap
   * against the digest returned by `lockAndValidate`, so a row that changed
   * after validation cannot escape observation.
   */
  transition(
    client: PoolClient,
    context: TrustedRequestContext,
    command: InventoryPostingCommandV1,
    evidenceDigest: string,
    recordedAt: string,
  ): Promise<void>;
}

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
    /** PS-0 PROBE ONLY — NOT FOR MERGE. */
    private readonly sourceAggregate: InventorySourceAggregateStepV1 | null = null,
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
      familyId: 'adjustment',
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
      familyId: 'transfer',
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
      familyId: 'stockCount',
      postingRole: parsed.kind === 'initial' ? 'count' : 'correction',
    });
  }

  /**
   * PS-2 PROBE ONLY. A goods receipt is **not** an adjustment, and this entry
   * point exists so it stops pretending to be one.
   *
   * `PS-1` posted receipts through `postAdjustment` with an
   * `InventoryAdjustmentPostingCommandV1`, which handed them `postingRole:
   * 'adjustment'`, the adjustment companion type, adjustment reason and
   * approval semantics, and a domain event named for an adjustment — recreating
   * the exact `type = adjustment` / `source_type = goodsReceipt` pair its own
   * ruling said was structurally forbidden. Its test read the type column and
   * never asserted on it, so nothing caught it.
   */
  async postGoodsReceipt(
    context: TrustedRequestContext,
    actorEnvelope: TrustedActorEnvelope,
    command: InventoryGoodsReceiptPostingCommandV1,
  ): Promise<InventoryPostingResultV1> {
    const profile = resolveProfile(this.registration, 'goodsReceipt');
    const source = validateGoodsReceiptCommand(command);
    return this.#post(context, actorEnvelope, {
      command: kernelCommandForGoodsReceipt(profile, source),
      familyId: 'goodsReceipt',
      postingRole: 'receipt',
      source,
    });
  }

  /**
   * PS-2. Where a companion's content comes from, chosen by the profile's
   * `sourceStep` rather than by whether a port was injected.
   *
   * `foreignPort` delegates to the cross-domain port, which has already locked
   * its rows. `inventoryInternal` derives from the kernel command directly —
   * that is the stock-count path, and it is the one `PS-1` had no answer for.
   */
  /** PS-2. A `foreignPort` family without a port refuses; it does not proceed. */
  #requireSourcePort(
    profile: InventoryPostingFamilyProfilePayloadV1,
  ): InventorySourceAggregateStepV1 {
    if (!this.sourceAggregate) {
      throw postingError(
        'INVENTORY_POSTING_COMPANION_CONFLICT',
        `posting family ${profile.familyId} declares a foreign source step and no port is registered`,
        { family: profile.familyId },
      );
    }
    return this.sourceAggregate;
  }

  async #companionDerivation(
    client: PoolClient,
    context: TrustedRequestContext,
    profile: InventoryPostingFamilyProfilePayloadV1,
    posting: ParsedPosting,
  ): Promise<InventoryCompanionDerivationV1> {
    if (profile.sourceStep === 'foreignPort') {
      return await this.#requireSourcePort(profile).deriveCompanion(
        client,
        context,
        posting.command,
      );
    }
    const { command } = posting;
    // A stock count names one location for the whole session; an adjustment
    // names one per line. Both reach the companion as a line-level location,
    // because that is what `inventory_transaction_line` stores.
    const commandLocationId =
      'locationId' in command ? command.locationId : null;
    return Object.freeze({
      effectiveAt: command.effectiveAt,
      lines: Object.freeze(
        command.lines.map((line, index) => {
          const quantity =
            'quantityDelta' in line
              ? line.quantityDelta
              : 'varianceQuantity' in line
                ? line.varianceQuantity
                : line.quantity;
          const negative = quantity.startsWith('-');
          const locationId =
            'locationId' in line
              ? line.locationId
              : 'toLocationId' in line
                ? line.toLocationId
                : commandLocationId;
          return Object.freeze({
            fromLocationId: negative ? locationId : null,
            itemId: line.itemId,
            lineNumber: String(index + 1),
            quantity,
            toLocationId: negative ? null : locationId,
            transactionLineId: line.transactionLineId,
            unitId: line.unitId,
          });
        }),
      ),
      number: `${profile.companion.sourceTypeLiteral}-${command.sourceId.slice(0, 8)}`,
      reason: command.reason,
      sourceId: command.sourceId,
      sourceType: profile.companion.sourceTypeLiteral,
      transactionId: command.transactionId,
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
    // PS-2. Admission, not identity, and resolved from the compiled catalog by
    // the family the entry point named — never inferred from a diagnostic
    // string or from the posting role, both of which a caller controls. It runs
    // before `pool.connect()`, so an unadmitted family never opens a
    // transaction.
    const profile = resolveProfile(this.registration, posting.familyId);
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
      // PS-2. The source aggregate is locked and validated BEFORE the companion
      // is derived from it, so the derivation cannot read a row that moves
      // before the movement lands.
      //
      // **This is a REORDER, not a widening, and PS-1 was wrong to call it a
      // widening.** The edge moved from {companion header → source} to {source →
      // companion header}; no edge was added. A reorder is only safe if it is
      // uniform, and PS-1's was not: it applied to the injected foreign port
      // while `lockAndAssertStockCountEvidence` kept taking the header first,
      // leaving two families acquiring the same two locks in opposite orders —
      // a genuine ABBA hazard between a receipt posting and a stock count.
      // The profile makes it uniform: every family with a source document
      // locks the source first, and that uniformity is the reason the reorder
      // is admissible at all.
      // PS-2. Gated on the PROFILE, not on whether a port happened to be
      // injected. `sourceStep` was declared and unenforced for exactly one
      // commit, and a declared-but-unenforced field is this programme's worst
      // defect class — it is `stateMachines`, it is `transitionStateEffect`,
      // and it is the `familyId` string that made a receipt an adjustment.
      const sourceAggregateDigest =
        profile.sourceStep === 'foreignPort'
          ? await this.#requireSourcePort(profile).lockAndValidate(
              client,
              context,
              parsed,
            )
          : null;
      // PS-2. The companion writer, keyed on the **profile** rather than on
      // whether a port happened to be injected. That is what stops
      // `postStockCount` escaping it: stock count is a companion-origin family,
      // so it gets a kernel-written companion on the same path a receipt does,
      // which is what leaves Inventory's dependency extension non-empty and
      // gives the reachability gate its second class to close.
      if (profile.companion.createdByKernel) {
        const derivation = await this.#companionDerivation(
          client,
          context,
          profile,
          posting,
        );
        await createCompanionTransaction(
          client,
          this.#binding,
          context,
          actorEnvelope,
          profile,
          posting,
          derivation,
          recordedAt,
        );
      }
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
      const countEvidenceDigest = isStockCountPosting(posting)
        ? await lockAndAssertStockCountEvidence(
            client,
            this.#binding,
            context,
            posting,
          )
        : null;
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

      await assertInventoryDraftHeader(
        client,
        this.#binding,
        context,
        profile,
        posting,
      );
      if (isStockCountPosting(posting)) {
        await assertStockCountCompensationAvailable(
          client,
          this.#binding,
          context,
          posting,
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
      let stockCountRevision: number | null = null;
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
          profile,
          posting,
          lineSetDigest,
        );
        if (isStockCountPosting(posting)) {
          stockCountRevision = await transitionStockCountToPosted(
            client,
            this.#binding,
            context,
            actorEnvelope,
            posting,
            countEvidenceDigest!,
            recordedAt,
          );
        }
        // PS-0 PROBE ONLY — NOT FOR MERGE. Same savepoint, same transaction,
        // after the movements exist and the companion transaction is posted.
        if (profile.sourceStep === 'foreignPort') {
          await this.#requireSourcePort(profile).transition(
            client,
            context,
            parsed,
            sourceAggregateDigest!,
            recordedAt,
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
      const stockCountEvidence = isStockCountPosting(posting)
        ? await readBackStockCountEvidence(
            client,
            this.#binding,
            context,
            posting,
            persistedMovements,
          )
        : null;
      await resetModuleRole(client);
      const ids = mintEvidenceIds(this.mintUuid);
      const resultWithoutTrust = {
        capabilityId: this.registration.capabilityId,
        capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
        movements: persistedMovements,
        negativeStockFlag,
        recordedAt,
        replayed: false,
        stockCountEvidence,
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
        stockCountRevision ?? transactionRevision,
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
  // Contract identity (2) is still equality — one kernel, one baseline.
  if (
    registration.capabilityVersion !== INVENTORY_POSTING_CAPABILITY_VERSION ||
    registration.dependencySetRoot !== INVENTORY_POSTING_DEPENDENCY_SET_ROOT
  ) {
    throw postingError(
      'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      'posting registration does not match the frozen capability contract',
    );
  }
  // PS-2: the catalog is the single source for identity (1) and (3). A
  // capability is admitted because some profile names it, and its extension is
  // derived from exactly those profiles — there is no second list to disagree
  // with the first.
  const catalog =
    registration.postingFamilyCatalog ?? INVENTORY_POSTING_FAMILY_CATALOG_V1;
  if (
    catalog.schemaVersion !== 'northstar.inventory-posting-family-profile/v1' ||
    catalog.profiles.length === 0
  ) {
    throw postingError(
      'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      'posting registration does not carry an admitted posting-family catalog',
    );
  }
  const familyIds = new Set<string>();
  for (const profile of catalog.profiles) {
    if (familyIds.has(profile.familyId)) {
      throw postingError(
        'INVENTORY_POSTING_CAPABILITY_MISMATCH',
        `posting-family catalog declares ${profile.familyId} twice`,
      );
    }
    familyIds.add(profile.familyId);
    // Provenance and companion type are the profile's, and a companion-origin
    // family must create its companion. An `authored` family that claimed a
    // kernel writer, or a `companion` family that did not, is the exact
    // combination that let `postStockCount` escape PS-1's writer.
    if (
      (profile.companion.origin === 'companion') !==
      profile.companion.createdByKernel
    ) {
      throw postingError(
        'INVENTORY_POSTING_CAPABILITY_MISMATCH',
        `posting family ${profile.familyId} disagrees with itself about who writes its transaction`,
      );
    }
    // Reachability follows origin. A companion that stayed generically
    // reachable, or an authored document that did not, is a defect in the
    // declaration rather than a policy choice.
    const expectedReachability =
      profile.companion.origin === 'companion' ? 'closed' : 'admitted';
    if (
      profile.reachability.genericAuthoring !== expectedReachability ||
      profile.reachability.genericRead !== expectedReachability
    ) {
      throw postingError(
        'INVENTORY_POSTING_CAPABILITY_MISMATCH',
        `posting family ${profile.familyId} declares reachability its origin does not permit`,
      );
    }
  }
  if (
    !catalog.profiles.some(
      (profile) => profile.capabilityId === registration.capabilityId,
    )
  ) {
    throw postingError(
      'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      `capability ${registration.capabilityId} is named by no posting family`,
    );
  }
  if (
    registration.postingFamilyCatalogContentHash !== undefined &&
    !sha256Pattern.test(registration.postingFamilyCatalogContentHash)
  ) {
    throw postingError(
      'INVENTORY_POSTING_CAPABILITY_MISMATCH',
      'postingFamilyCatalogContentHash must be a lowercase SHA-256 digest',
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
    movementReversalOfMovementColumn: requiredField(
      movement,
      'inventory_movement_reversal_of_movement_id',
    ).name,
    movementStockVersionV1: requiredEnumOption(movementStockVersion, 'v1'),
    periodLock,
    periodLockClosedThroughColumn:
      periodLockEntity.periodLock.closedThroughColumn,
    schemaName: target.providerAbi.managedSchema,
    transaction,
    transactionTypeOptions: transactionType.enumOptionIds,
    movementPostingRoleOptions: movementPostingRole.enumOptionIds,
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
    stockCount,
    stockCountActorColumn: requiredField(stockCount, 'stock_count_actor_id')
      .name,
    stockCountCountedAtColumn: requiredField(
      stockCount,
      'stock_count_counted_at',
    ).name,
    stockCountCorrectionKind: requiredEnumOption(stockCountKind, 'correction'),
    stockCountInitialKind: requiredEnumOption(stockCountKind, 'initial'),
    stockCountKindColumn: stockCountKind.name,
    stockCountLocationColumn: requiredField(
      stockCount,
      'stock_count_location_id',
    ).name,
    stockCountPostedState: requiredEnumOption(stockCountState, 'posted'),
    stockCountReasonCodeColumn: requiredField(
      stockCount,
      'stock_count_reason_code',
    ).name,
    stockCountReasonNarrativeColumn: requiredField(
      stockCount,
      'stock_count_reason_narrative',
    ).name,
    stockCountRecordedAtColumn: requiredField(
      stockCount,
      'stock_count_recorded_at',
    ).name,
    stockCountRelationToTransactionColumn: requiredRelationColumn(
      target,
      stockCountEntity,
      'inventory_transaction',
    ),
    stockCountReviewedState: requiredEnumOption(stockCountState, 'reviewed'),
    stockCountReversalKind: requiredEnumOption(stockCountKind, 'reversal'),
    stockCountStateColumn: stockCountState.name,
    stockCountSupersedesColumn: requiredRelationColumn(
      target,
      stockCountEntity,
      'stock_count',
    ),
    stockCountLine,
    stockCountLineCountedColumn: requiredField(
      stockCountLine,
      'stock_count_line_counted_quantity',
    ).name,
    stockCountLineExpectedColumn: requiredField(
      stockCountLine,
      'stock_count_line_expected_quantity',
    ).name,
    stockCountLineItemColumn: requiredField(
      stockCountLine,
      'stock_count_line_item_id',
    ).name,
    stockCountLineLineNumberColumn: requiredField(
      stockCountLine,
      'stock_count_line_line_number',
    ).name,
    stockCountLineRelationToSessionColumn: requiredRelationColumn(
      target,
      stockCountLineEntity,
      'stock_count',
    ),
    stockCountLineRelationToTransactionLineColumn: requiredRelationColumn(
      target,
      stockCountLineEntity,
      'inventory_transaction_line',
    ),
    stockCountLineReversalColumn: requiredField(
      stockCountLine,
      'stock_count_line_reversal_of_movement_id',
    ).name,
    stockCountLineUnitColumn: requiredField(
      stockCountLine,
      'stock_count_line_unit_id',
    ).name,
    stockCountLineVarianceColumn: requiredField(
      stockCountLine,
      'stock_count_line_variance_quantity',
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
    // PS-2. A receipt is its own posting role. It resolves generically from the
    // compiled enum so adding one is a declaration, not another switch arm.
    case 'receipt':
      return requiredCompiledOption(
        binding.movementPostingRoleOptions,
        'inventory_movement_posting_role_receipt',
        'inventory_movement_posting_role',
      );
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

/**
 * PS-2. The companion's transaction type comes from the **profile**, not from a
 * switch on posting role.
 *
 * That switch is what made `PS-1`'s receipt carry `type = adjustment` while its
 * `source_type` said `goodsReceipt` — the pair its own ruling called
 * structurally forbidden. A family declares its companion type once, and the
 * only way to change it is to change the declaration.
 */
function transactionType(
  binding: PostingStorageBinding,
  profile: InventoryPostingFamilyProfilePayloadV1,
): string {
  return requiredCompiledOption(
    binding.transactionTypeOptions,
    profile.companion.transactionTypeLocalId,
    'inventory_transaction_type',
  );
}

/** PS-2. Resolves a compiled enum option a profile names by its local id. */
function requiredCompiledOption(
  options: readonly string[],
  localId: string,
  fieldLabel: string,
): string {
  const matches = options.filter((option) => option.endsWith(`.${localId}`));
  if (matches.length !== 1) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `${fieldLabel} lacks unique compiled option ${localId}`,
      { localId },
    );
  }
  return matches[0]!;
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
  validateCommandEnvelope(command, [
    'kind',
    'locationId',
    'stockCountId',
    'supersedesStockCountId',
  ]);
  if (!['initial', 'correction', 'reversal'].includes(command.kind)) {
    throw inputError('stock count kind is not supported');
  }
  requiredUuid(command.locationId, 'locationId');
  requiredUuid(command.stockCountId, 'stockCountId');
  if (command.sourceType !== 'stockCount') {
    throw inputError('stock-count sourceType must be stockCount');
  }
  if (command.sourceId.toLowerCase() !== command.stockCountId.toLowerCase()) {
    throw inputError('stock-count sourceId must equal stockCountId');
  }
  if (command.kind === 'initial') {
    if (command.supersedesStockCountId !== null) {
      throw inputError('an initial stock count cannot supersede another count');
    }
  } else {
    if (command.supersedesStockCountId === null) {
      throw inputError('a correction or reversal must supersede a stock count');
    }
    requiredUuid(command.supersedesStockCountId, 'supersedesStockCountId');
    if (
      command.supersedesStockCountId.toLowerCase() ===
      command.stockCountId.toLowerCase()
    ) {
      throw inputError('a stock count cannot supersede itself');
    }
  }
  if (!Array.isArray(command.lines) || command.lines.length === 0) {
    throw inputError('a stock count requires at least one line');
  }
  const naturalKeys = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const line of command.lines) {
    exactKeys(line, [
      'countedQuantity',
      'expectedQuantity',
      'itemId',
      'reversalOfMovementId',
      'sourceLine',
      'stockCountLineId',
      'transactionLineId',
      'unitId',
      'varianceQuantity',
    ]);
    validateLineIdentity(line);
    requiredUuid(line.stockCountLineId, 'line.stockCountLineId');
    if (evidenceIds.has(line.stockCountLineId.toLowerCase())) {
      throw inputError('stock-count lines repeat a stockCountLineId');
    }
    evidenceIds.add(line.stockCountLineId.toLowerCase());
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
    if (expected < 0n || counted < 0n) {
      throw inputError('expected and counted quantities cannot be negative');
    }
    if (counted - expected !== variance) {
      throw inputError('varianceQuantity must equal counted minus expected');
    }
    if (command.kind === 'reversal') {
      if (line.reversalOfMovementId === null) {
        throw inputError('a reversal line must name reversalOfMovementId');
      }
      requiredUuid(line.reversalOfMovementId, 'line.reversalOfMovementId');
    } else if (line.reversalOfMovementId !== null) {
      throw inputError('only reversal lines may name reversalOfMovementId');
    }
    assertUniqueSourceLine(naturalKeys, line.sourceLine, 'correction');
  }
  const parsed = structuredClone(command);
  return {
    ...normalizeCommandEnvelope(parsed),
    locationId: parsed.locationId.toLowerCase(),
    sourceId: parsed.sourceId.toLowerCase(),
    stockCountId: parsed.stockCountId.toLowerCase(),
    supersedesStockCountId:
      parsed.supersedesStockCountId?.toLowerCase() ?? null,
    lines: parsed.lines.map((line) => ({
      ...line,
      countedQuantity: normalizeDecimal(line.countedQuantity),
      expectedQuantity: normalizeDecimal(line.expectedQuantity),
      itemId: line.itemId.toLowerCase(),
      reversalOfMovementId: line.reversalOfMovementId?.toLowerCase() ?? null,
      stockCountLineId: line.stockCountLineId.toLowerCase(),
      transactionLineId: line.transactionLineId.toLowerCase(),
      varianceQuantity: normalizeDecimal(line.varianceQuantity),
    })),
  };
}

function validateCommandEnvelope(
  command: InventoryPostingCommandV1,
  additionalKeys: readonly string[] = [],
): void {
  exactKeys(command, [
    'authorization',
    'channel',
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
    ...additionalKeys,
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
  if (posting.postingRole === 'adjustment' || posting.postingRole === 'receipt') {
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
  if (isStockCountPosting(posting)) {
    return posting.command.lines.map((line) =>
      plannedMovement(
        posting.command,
        line,
        posting.command.locationId,
        line.varianceQuantity,
        line.sourceLine,
        posting.postingRole,
        mintUuid,
        line.reversalOfMovementId,
      ),
    );
  }
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

function plannedMovement(
  command: InventoryPostingCommandV1,
  line:
    | InventoryAdjustmentLineV1
    | InventoryStockCountLineV1
    | InventoryTransferLineV1,
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
  // PS-2. `receipt` has no configuration dials yet. ADR-0049 §5 priced them —
  // `receipt_reason_requirement` and `receipt_approval_threshold` columns plus a
  // widened `provision_inventory_scope` — and `PUR-2` owes that migration. Until
  // it lands the probe borrows the adjustment dials **explicitly**, so the gap
  // is visible here rather than silently defaulting to the weakest setting.
  const configuredRole: Exclude<InventoryPostingRoleV1, 'receipt'> =
    postingRole === 'receipt' ? 'adjustment' : postingRole;
  const reason = configuration.reasonRequirements[configuredRole];
  if (
    command.reason.code.trim().length === 0 ||
    (reason === 'codeAndNarrative' &&
      (command.reason.narrative === null ||
        command.reason.narrative.trim().length === 0))
  ) {
    const code =
      postingRole === 'adjustment' || postingRole === 'receipt'
        ? 'INVENTORY_ADJUSTMENT_REASON_REQUIRED'
        : postingRole === 'transfer'
          ? 'INVENTORY_TRANSFER_REASON_REQUIRED'
          : 'INVENTORY_COUNT_REASON_REQUIRED';
    throw postingError(code, `${postingRole} requires ${reason}`);
  }
  const threshold = configuration.approvalThresholds[configuredRole];
  if (threshold === null) return;
  const scaledThreshold = decimalToScaled(threshold, 'approval threshold');
  const exceeds =
    posting.postingRole === 'adjustment' || posting.postingRole === 'receipt'
      ? posting.command.lines.some(
          (line) =>
            absolute(decimalToScaled(line.quantityDelta, 'quantity')) >
            scaledThreshold,
        )
      : posting.postingRole === 'transfer'
        ? posting.command.lines.some(
            (line) =>
              decimalToScaled(line.quantity, 'quantity') > scaledThreshold,
          )
        : posting.command.lines.some(
            (line) =>
              absolute(
                decimalToScaled(line.varianceQuantity, 'varianceQuantity'),
              ) > scaledThreshold,
          );
  if (exceeds && actor.approvingHumanId === null) {
    const code =
      postingRole === 'adjustment'
        ? 'INVENTORY_ADJUSTMENT_APPROVAL_REQUIRED'
        : postingRole === 'transfer'
          ? 'INVENTORY_TRANSFER_APPROVAL_REQUIRED'
          : 'INVENTORY_COUNT_APPROVAL_REQUIRED';
    throw postingError(
      code,
      `${postingRole} exceeds approval threshold ${threshold}`,
      { threshold },
    );
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

/**
 * PS-1 PROBE ONLY. The companion writer.
 *
 * Three properties, each one of the conditions ADR-0049 left unsupplied:
 *
 *  1. **Deterministic one-to-one identity, protected by the database.** The
 *     header id is the port's derivation, which is a v5-style deterministic
 *     function of (tenant, environment, legal entity, source type, source id) —
 *     so a retried posting lands on the same row rather than minting a second.
 *     `ON CONFLICT DO NOTHING` plus a re-read is what makes partial creation
 *     self-repairing: there is no orphan to reap, because the only way to
 *     create a companion is inside the transaction that also posts it. The
 *     uniqueness that makes this one-to-one is a `UNIQUE (tenant_id,
 *     environment_id, source_type, source_id)` index, which `PUR-2` owes as a
 *     migration; this probe asserts the invariant it will enforce.
 *  2. **Server-selected type and state.** Both come from the compiled binding
 *     and the posting role, never from the derivation. A port cannot mint a
 *     header claiming an origin its movements do not have.
 *  3. **Origin carried and enforced.** `source_type`/`source_id` are written
 *     here from the same command the movements take theirs from, and
 *     `assertInventoryDraftHeader` — shipped, unmodified — re-pins both under
 *     the header lock a few statements later.
 */
async function createCompanionTransaction(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  actorEnvelope: TrustedActorEnvelope,
  profile: InventoryPostingFamilyProfilePayloadV1,
  posting: ParsedPosting,
  derivation: InventoryCompanionDerivationV1,
  recordedAt: string,
): Promise<void> {
  const { command } = posting;
  // PS-2. Provenance is the profile's literal, checked against what the kernel
  // command carries. A port that returned a different origin is refused rather
  // than trusted.
  if (derivation.sourceType !== profile.companion.sourceTypeLiteral) {
    throw postingError(
      'INVENTORY_POSTING_COMPANION_CONFLICT',
      `posting family ${profile.familyId} derived a companion whose origin is not its declared provenance`,
      { transactionId: command.transactionId },
    );
  }
  if (derivation.transactionId !== command.transactionId) {
    throw postingError(
      'INVENTORY_POSTING_COMPANION_CONFLICT',
      'the derived companion identity does not match the command',
      { transactionId: command.transactionId },
    );
  }
  if (
    derivation.sourceType !== command.sourceType ||
    derivation.sourceId !== command.sourceId
  ) {
    throw postingError(
      'INVENTORY_POSTING_COMPANION_CONFLICT',
      'the derived companion does not carry the command origin',
      { transactionId: command.transactionId },
    );
  }
  const local = (id: string): string => requiredField(binding.transaction, id).name;
  const headerColumns = [
    'tenant_id',
    'environment_id',
    binding.transaction.legalEntityColumn!,
    binding.transaction.recordIdColumn,
    binding.transactionStateColumn,
    binding.transactionTypeColumn,
    local('inventory_transaction_number'),
    local('inventory_transaction_effective_at'),
    local('inventory_transaction_recorded_at'),
    local('inventory_transaction_reason_code'),
    local('inventory_transaction_reason_narrative'),
    local('inventory_transaction_source_type'),
    local('inventory_transaction_source_id'),
    local('inventory_transaction_actor_id'),
  ];
  const headerValues = [
    context.tenantId,
    context.environmentId,
    command.legalEntityId,
    derivation.transactionId,
    // Server-selected, both of them. Not derivable by the port.
    binding.transactionDraftState,
    transactionType(binding, profile),
    derivation.number,
    derivation.effectiveAt,
    recordedAt,
    derivation.reason.code || null,
    derivation.reason.narrative,
    derivation.sourceType,
    derivation.sourceId,
    actorEnvelope.actor.executionPrincipal.principalId,
  ];
  await client.query(
    `INSERT INTO ${table(binding, binding.transaction)}
       (${headerColumns.map(quoted).join(', ')})
     VALUES (${headerValues.map((_, index) => `$${String(index + 1)}`).join(', ')})
     ON CONFLICT DO NOTHING`,
    headerValues,
  );
  for (const line of derivation.lines) {
    const lineColumns = [
      'tenant_id',
      'environment_id',
      binding.transactionLine.legalEntityColumn!,
      binding.transactionLine.recordIdColumn,
      binding.transactionLineRelationToTransactionColumn,
      binding.transactionLineItemColumn,
      binding.transactionLineFromLocationColumn,
      binding.transactionLineToLocationColumn,
      binding.transactionLineQuantityColumn,
      binding.transactionLineLineNumberColumn,
      binding.transactionLineUnitColumn,
    ];
    const lineValues = [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      line.transactionLineId,
      derivation.transactionId,
      line.itemId,
      line.fromLocationId,
      line.toLocationId,
      line.quantity,
      line.lineNumber,
      line.unitId,
    ];
    await client.query(
      `INSERT INTO ${table(binding, binding.transactionLine)}
         (${lineColumns.map(quoted).join(', ')})
       VALUES (${lineValues.map((_, index) => `$${String(index + 1)}`).join(', ')})
       ON CONFLICT DO NOTHING`,
      lineValues,
    );
  }
}

/**
 * PS-2. Resolves the profile a posting runs under, and refuses if the invoking
 * capability does not own it.
 *
 * This is what replaces `PS-1`'s magic string. The family is not inferred from
 * a diagnostic name on an injected port, nor from the posting role — both of
 * which the caller controls. It is named by the entry point (`postAdjustment`,
 * `postStockCount`, `postGoodsReceipt`), looked up in the compiled catalog, and
 * checked against the registration's own capability. Everything else the family
 * varies by — posting role, companion type, provenance, revision ownership,
 * identity derivation, reachability — is then read off the profile rather than
 * re-derived at each use site.
 */
/**
 * PS-2. A v5-shaped deterministic identity. Deterministic is what makes partial
 * creation self-repairing — a retry derives the same ids, so the companion
 * writer's `ON CONFLICT DO NOTHING` converges instead of minting a second row.
 */
export function derivedIdentity(
  namespace: string,
  ...parts: readonly string[]
): string {
  const hash = createHash('sha1').update(namespace);
  for (const part of parts) hash.update('\0').update(part);
  const bytes = Buffer.from(hash.digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const COMPANION_HEADER_NAMESPACE =
  'northstar.inventory-companion-transaction/v1';
const COMPANION_LINE_NAMESPACE = 'northstar.inventory-companion-line/v1';

function validateGoodsReceiptCommand(
  command: InventoryGoodsReceiptPostingCommandV1,
): InventoryGoodsReceiptPostingCommandV1 {
  requiredUuid(command.goodsReceiptId, 'goodsReceiptId');
  requiredUuid(command.purchaseOrderId, 'purchaseOrderId');
  requiredUuid(command.legalEntityId, 'legalEntityId');
  requiredUuid(command.idempotencyKey, 'idempotencyKey');
  if (
    !Number.isSafeInteger(command.sourceExpectedRevision) ||
    command.sourceExpectedRevision < 0
  ) {
    throw postingError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'sourceExpectedRevision must be a non-negative integer',
    );
  }
  if (command.lines.length === 0) {
    throw postingError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'a goods receipt posting carries at least one line',
    );
  }
  return command;
}

/**
 * PS-2. The profile-governed normalization from a receipt to kernel work.
 *
 * Every identity and every provenance value is derived here. `sourceType` is
 * the profile's literal, never the caller's — that is what makes a companion
 * header incapable of claiming an origin its movements do not have. Both the
 * companion header id and each companion line id are derived, closing the half
 * of `PS-1`'s identity story that was still caller-supplied.
 */
function kernelCommandForGoodsReceipt(
  profile: InventoryPostingFamilyProfilePayloadV1,
  source: InventoryGoodsReceiptPostingCommandV1,
): InventoryAdjustmentPostingCommandV1 {
  const sourceType = profile.companion.sourceTypeLiteral;
  const transactionId = derivedIdentity(
    COMPANION_HEADER_NAMESPACE,
    source.legalEntityId,
    sourceType,
    source.goodsReceiptId,
  );
  return Object.freeze({
    authorization: source.authorization,
    channel: source.channel,
    effectiveAt: source.effectiveAt,
    idempotencyKey: source.idempotencyKey,
    legalEntityId: source.legalEntityId,
    lines: Object.freeze(
      source.lines.map((line) =>
        Object.freeze({
          itemId: line.itemId,
          locationId: line.locationId,
          quantityDelta: line.quantity,
          sourceLine: line.sourceLine,
          transactionLineId: derivedIdentity(
            COMPANION_LINE_NAMESPACE,
            transactionId,
            line.goodsReceiptLineId,
          ),
          unitId: line.unitId,
        }),
      ),
    ),
    reason: source.reason,
    sourceId: source.goodsReceiptId,
    // The foreign document's revision. The companion's is kernel-minted and is
    // deliberately not representable here.
    sourceRevision: source.sourceExpectedRevision,
    sourceType,
    stockDimensionSetVersion: 'v1',
    transactionId,
  });
}

function resolveProfile(
  registration: InventoryPostingRegistrationV1,
  familyId: InventoryPostingCommandFamilyV1,
): InventoryPostingFamilyProfilePayloadV1 {
  const catalog =
    registration.postingFamilyCatalog ?? INVENTORY_POSTING_FAMILY_CATALOG_V1;
  const profile = catalog.profiles.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (!profile) {
    throw postingError(
      'INVENTORY_POSTING_COMMAND_FAMILY_NOT_ADMITTED',
      `the compiled posting-family catalog declares no ${familyId} family`,
      { family: familyId },
    );
  }
  if (profile.capabilityId !== registration.capabilityId) {
    throw postingError(
      'INVENTORY_POSTING_COMMAND_FAMILY_NOT_ADMITTED',
      `capability ${registration.capabilityId} may not execute the ${familyId} command family`,
      { capabilityId: registration.capabilityId, family: familyId },
    );
  }
  return profile;
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
  profile: InventoryPostingFamilyProfilePayloadV1,
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
      transactionType(binding, profile),
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
  if (posting.postingRole === 'adjustment' || posting.postingRole === 'receipt') {
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
          posting.command.locationId,
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
  locationId: string,
  line: InventoryStockCountLineV1,
): boolean {
  const negative = line.varianceQuantity.startsWith('-');
  return (
    row !== undefined &&
    String(row.itemId).toLowerCase() === line.itemId &&
    normalizeDatabaseDecimal(String(row.quantity)) === line.varianceQuantity &&
    String(row.unitId) === line.unitId &&
    String(row.lineNumber) === line.sourceLine &&
    nullableUuid(row.fromLocationId) === (negative ? locationId : null) &&
    nullableUuid(row.toLocationId) === (negative ? null : locationId)
  );
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : String(value).toLowerCase();
}

function isStockCountPosting(
  posting: ParsedPosting,
): posting is Extract<ParsedPosting, { postingRole: 'correction' | 'count' }> {
  return (
    posting.postingRole === 'count' || posting.postingRole === 'correction'
  );
}

function stockCountKindFromStorage(
  binding: PostingStorageBinding,
  value: string,
): InventoryStockCountKindV1 {
  if (value === binding.stockCountInitialKind) return 'initial';
  if (value === binding.stockCountCorrectionKind) return 'correction';
  if (value === binding.stockCountReversalKind) return 'reversal';
  throw postingError(
    'INVENTORY_COUNT_EVIDENCE_CONFLICT',
    `stock count returned unsupported kind ${value}`,
  );
}

function stockCountKindToStorage(
  binding: PostingStorageBinding,
  value: InventoryStockCountKindV1,
): string {
  switch (value) {
    case 'initial':
      return binding.stockCountInitialKind;
    case 'correction':
      return binding.stockCountCorrectionKind;
    case 'reversal':
      return binding.stockCountReversalKind;
  }
}

async function lockAndAssertStockCountEvidence(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  posting: Extract<ParsedPosting, { postingRole: 'correction' | 'count' }>,
): Promise<string> {
  const { command } = posting;
  const session = await client.query<Record<string, unknown>>(
    `SELECT ${quoted(binding.stockCountStateColumn)} AS state,
            ${quoted(binding.stockCountKindColumn)} AS kind,
            ${quoted(binding.stockCountLocationColumn)}::text AS "locationId",
            to_char(${quoted(binding.stockCountCountedAtColumn)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "countedAt",
            ${quoted(binding.stockCountReasonCodeColumn)} AS "reasonCode",
            ${quoted(binding.stockCountReasonNarrativeColumn)} AS "reasonNarrative",
            ${quoted(binding.stockCountSupersedesColumn)}::text AS "supersedesStockCountId",
            ${quoted(binding.stockCountRelationToTransactionColumn)}::text AS "transactionId",
            ${quoted(binding.stockCount.revisionColumn)}::integer AS revision
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
  const row = session.rows[0];
  const state = row?.state;
  if (
    session.rows.length !== 1 ||
    (state !== binding.stockCountReviewedState &&
      state !== binding.stockCountPostedState) ||
    stockCountKindFromStorage(binding, String(row!.kind)) !== command.kind ||
    String(row!.locationId).toLowerCase() !== command.locationId ||
    String(row!.countedAt) !== command.effectiveAt ||
    String(row!.reasonCode ?? '') !== command.reason.code ||
    (row!.reasonNarrative === null ? null : String(row!.reasonNarrative)) !==
      command.reason.narrative ||
    nullableUuid(row!.supersedesStockCountId) !==
      command.supersedesStockCountId ||
    String(row!.transactionId).toLowerCase() !== command.transactionId ||
    Number(row!.revision) !==
      (state === binding.stockCountReviewedState
        ? command.sourceRevision
        : command.sourceRevision + 1)
  ) {
    throw postingError(
      'INVENTORY_COUNT_EVIDENCE_CONFLICT',
      `stock count ${command.stockCountId} does not exactly match the reviewed evidence`,
      { stockCountId: command.stockCountId },
    );
  }

  const lines = await client.query<Record<string, unknown>>(
    `SELECT ${quoted(binding.stockCountLine.recordIdColumn)}::text AS "stockCountLineId",
            ${quoted(binding.stockCountLineItemColumn)}::text AS "itemId",
            ${quoted(binding.stockCountLineLineNumberColumn)}::text AS "sourceLine",
            ${quoted(binding.stockCountLineExpectedColumn)}::text AS "expectedQuantity",
            ${quoted(binding.stockCountLineCountedColumn)}::text AS "countedQuantity",
            ${quoted(binding.stockCountLineVarianceColumn)}::text AS "varianceQuantity",
            ${quoted(binding.stockCountLineUnitColumn)} AS "unitId",
            ${quoted(binding.stockCountLineReversalColumn)}::text AS "reversalOfMovementId",
            ${quoted(binding.stockCountLineRelationToTransactionLineColumn)}::text AS "transactionLineId"
       FROM ${table(binding, binding.stockCountLine)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.stockCountLine.legalEntityColumn!)} = $3
        AND ${quoted(binding.stockCountLineRelationToSessionColumn)} = $4
        AND ${quoted(binding.stockCountLine.archiveColumn)} IS NULL
      ORDER BY ${quoted(binding.stockCountLine.recordIdColumn)}
      FOR NO KEY UPDATE`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.stockCountId,
    ],
  );
  if (lines.rows.length !== command.lines.length) {
    throw postingError(
      'INVENTORY_COUNT_EVIDENCE_CONFLICT',
      `stock count ${command.stockCountId} line set differs from the posting command`,
      { stockCountId: command.stockCountId },
    );
  }
  const byId = new Map(
    lines.rows.map((line) => [
      String(line.stockCountLineId).toLowerCase(),
      line,
    ]),
  );
  for (const line of command.lines) {
    const persisted = byId.get(line.stockCountLineId);
    if (
      persisted === undefined ||
      String(persisted.itemId).toLowerCase() !== line.itemId ||
      String(persisted.sourceLine) !== line.sourceLine ||
      normalizeDatabaseDecimal(String(persisted.expectedQuantity)) !==
        line.expectedQuantity ||
      normalizeDatabaseDecimal(String(persisted.countedQuantity)) !==
        line.countedQuantity ||
      normalizeDatabaseDecimal(String(persisted.varianceQuantity)) !==
        line.varianceQuantity ||
      String(persisted.unitId) !== line.unitId ||
      nullableUuid(persisted.reversalOfMovementId) !==
        line.reversalOfMovementId ||
      nullableUuid(persisted.transactionLineId) !== line.transactionLineId
    ) {
      throw postingError(
        'INVENTORY_COUNT_EVIDENCE_CONFLICT',
        `stock-count line ${line.stockCountLineId} differs from the posting command`,
        { stockCountLineId: line.stockCountLineId },
      );
    }
  }
  const digest = await client.query<{ digest: string }>(
    `SELECT ${stockCountEvidenceDigestSql(binding, '$1', '$2', '$3', '$4')} AS digest`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.stockCountId,
    ],
  );
  if (!/^[0-9a-f]{32}$/u.test(digest.rows[0]?.digest ?? '')) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'stock-count evidence digest could not be captured',
      { stockCountId: command.stockCountId },
    );
  }
  return digest.rows[0]!.digest;
}

async function assertStockCountCompensationAvailable(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  posting: Extract<ParsedPosting, { postingRole: 'correction' | 'count' }>,
): Promise<void> {
  const { command } = posting;
  if (command.kind === 'initial') return;
  const prior = await client.query<Record<string, unknown>>(
    `SELECT ${quoted(binding.stockCountStateColumn)} AS state,
            ${quoted(binding.stockCountLocationColumn)}::text AS "locationId"
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
      command.supersedesStockCountId,
    ],
  );
  if (
    prior.rows.length !== 1 ||
    prior.rows[0]!.state !== binding.stockCountPostedState ||
    String(prior.rows[0]!.locationId).toLowerCase() !== command.locationId
  ) {
    throw postingError(
      'INVENTORY_COUNT_COMPENSATION_CONFLICT',
      'a correction or reversal must supersede one posted count at the same location',
      { supersedesStockCountId: command.supersedesStockCountId! },
    );
  }
  const alreadyCompensated = await client.query<{ present: boolean }>(
    `SELECT true AS present
       FROM ${table(binding, binding.stockCount)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.stockCount.legalEntityColumn!)} = $3
        AND ${quoted(binding.stockCountSupersedesColumn)} = $4
        AND ${quoted(binding.stockCount.recordIdColumn)} <> $5
        AND ${quoted(binding.stockCountStateColumn)} = $6
        AND ${quoted(binding.stockCount.archiveColumn)} IS NULL
      LIMIT 1
      FOR NO KEY UPDATE`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.supersedesStockCountId,
      command.stockCountId,
      binding.stockCountPostedState,
    ],
  );
  if (alreadyCompensated.rows[0]?.present) {
    throw postingError(
      'INVENTORY_COUNT_COMPENSATION_CONFLICT',
      `stock count ${command.supersedesStockCountId!} already has a posted compensation`,
      { supersedesStockCountId: command.supersedesStockCountId! },
    );
  }
  if (command.kind !== 'reversal') return;
  for (const line of command.lines) {
    const priorMovement = await client.query<Record<string, unknown>>(
      `SELECT ${quoted(requiredField(binding.movement, 'inventory_movement_item_id').name)}::text AS "itemId",
              ${quoted(requiredField(binding.movement, 'inventory_movement_location_id').name)}::text AS "locationId",
              ${quoted(requiredField(binding.movement, 'inventory_movement_quantity_delta').name)}::text AS "quantityDelta",
              ${quoted(requiredField(binding.movement, 'inventory_movement_unit_id').name)} AS "unitId"
         FROM ${table(binding, binding.movement)} AS movement
         JOIN ${table(binding, binding.stockCountLine)} AS count_line
           ON count_line.tenant_id = movement.tenant_id
          AND count_line.environment_id = movement.environment_id
          AND count_line.${quoted(binding.stockCountLine.legalEntityColumn!)} = movement.${quoted(binding.movement.legalEntityColumn!)}
          AND count_line.${quoted(binding.stockCountLineRelationToTransactionLineColumn)} = movement.${quoted(binding.movementRelationToLineColumn)}
        WHERE movement.tenant_id = $1 AND movement.environment_id = $2
          AND movement.${quoted(binding.movement.legalEntityColumn!)} = $3
          AND movement.${quoted(binding.movement.recordIdColumn)} = $4
          AND count_line.${quoted(binding.stockCountLineRelationToSessionColumn)} = $5
          AND count_line.${quoted(binding.stockCountLine.archiveColumn)} IS NULL`,
      [
        context.tenantId,
        context.environmentId,
        command.legalEntityId,
        line.reversalOfMovementId,
        command.supersedesStockCountId,
      ],
    );
    const priorLine = priorMovement.rows[0];
    if (
      priorMovement.rows.length !== 1 ||
      String(priorLine!.itemId).toLowerCase() !== line.itemId ||
      String(priorLine!.locationId).toLowerCase() !== command.locationId ||
      String(priorLine!.unitId) !== line.unitId ||
      databaseDecimalToScaled(String(priorLine!.quantityDelta)) !==
        -decimalToScaled(line.varianceQuantity, 'line.varianceQuantity')
    ) {
      throw postingError(
        'INVENTORY_COUNT_COMPENSATION_CONFLICT',
        `reversal line ${line.stockCountLineId} is not the exact inverse of its superseded movement`,
        { stockCountLineId: line.stockCountLineId },
      );
    }
  }
}

function stockCountEvidenceDigestSql(
  binding: PostingStorageBinding,
  tenantParameter: string,
  environmentParameter: string,
  legalEntityParameter: string,
  stockCountParameter: string,
): string {
  return `(SELECT md5(jsonb_build_object(
              'session', to_jsonb(count_session),
              'lines', COALESCE((
                SELECT jsonb_agg(to_jsonb(count_line)
                         ORDER BY count_line.${quoted(binding.stockCountLine.recordIdColumn)}::text)
                  FROM ${table(binding, binding.stockCountLine)} AS count_line
                 WHERE count_line.tenant_id = ${tenantParameter}
                   AND count_line.environment_id = ${environmentParameter}
                   AND count_line.${quoted(binding.stockCountLine.legalEntityColumn!)} = ${legalEntityParameter}
                   AND count_line.${quoted(binding.stockCountLineRelationToSessionColumn)} = ${stockCountParameter}
                   AND count_line.${quoted(binding.stockCountLine.archiveColumn)} IS NULL
              ), '[]'::jsonb)
            )::text)
       FROM ${table(binding, binding.stockCount)} AS count_session
      WHERE count_session.tenant_id = ${tenantParameter}
        AND count_session.environment_id = ${environmentParameter}
        AND count_session.${quoted(binding.stockCount.legalEntityColumn!)} = ${legalEntityParameter}
        AND count_session.${quoted(binding.stockCount.recordIdColumn)} = ${stockCountParameter}
        AND count_session.${quoted(binding.stockCount.archiveColumn)} IS NULL)`;
}

async function transitionStockCountToPosted(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  actorEnvelope: TrustedActorEnvelope,
  posting: Extract<ParsedPosting, { postingRole: 'correction' | 'count' }>,
  evidenceDigest: string,
  recordedAt: string,
): Promise<number> {
  const { command } = posting;
  const result = await client.query<{ revision: number }>(
    `UPDATE ${table(binding, binding.stockCount)}
        SET ${quoted(binding.stockCountStateColumn)} = $5,
            ${quoted(binding.stockCountRecordedAtColumn)} = $6::timestamptz,
            ${quoted(binding.stockCountActorColumn)} = $7,
            ${quoted(binding.stockCount.revisionColumn)} = ${quoted(binding.stockCount.revisionColumn)} + 1
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.stockCount.legalEntityColumn!)} = $3
        AND ${quoted(binding.stockCount.recordIdColumn)} = $4
        AND ${quoted(binding.stockCountStateColumn)} = $8
        AND ${quoted(binding.stockCountKindColumn)} = $9
        AND ${quoted(binding.stockCountLocationColumn)} = $10
        AND ${quoted(binding.stockCountRelationToTransactionColumn)} = $11
        AND ${quoted(binding.stockCountSupersedesColumn)} IS NOT DISTINCT FROM $12::uuid
        AND ${quoted(binding.stockCount.revisionColumn)} = $13
        AND ${quoted(binding.stockCount.archiveColumn)} IS NULL
        AND ${stockCountEvidenceDigestSql(binding, '$1', '$2', '$3', '$4')} = $14
      RETURNING ${quoted(binding.stockCount.revisionColumn)}::integer AS revision`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.stockCountId,
      binding.stockCountPostedState,
      recordedAt,
      actorEnvelope.actor.executionPrincipal.principalId,
      binding.stockCountReviewedState,
      stockCountKindToStorage(binding, command.kind),
      command.locationId,
      command.transactionId,
      command.supersedesStockCountId,
      command.sourceRevision,
      evidenceDigest,
    ],
  );
  if (
    result.rowCount !== 1 ||
    result.rows[0]?.revision !== command.sourceRevision + 1
  ) {
    throw postingError(
      'INVENTORY_COUNT_EVIDENCE_CONFLICT',
      `stock count ${command.stockCountId} changed after evidence validation`,
      { stockCountId: command.stockCountId },
    );
  }
  return result.rows[0].revision;
}

async function readBackStockCountEvidence(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  posting: Extract<ParsedPosting, { postingRole: 'correction' | 'count' }>,
  movements: readonly PostedInventoryMovementV1[],
): Promise<PostedStockCountEvidenceV1> {
  const { command } = posting;
  const session = await client.query<Record<string, unknown>>(
    `SELECT ${quoted(binding.stockCountKindColumn)} AS kind,
            ${quoted(binding.stockCountLocationColumn)}::text AS "locationId",
            ${quoted(binding.stockCountSupersedesColumn)}::text AS "supersedesStockCountId"
       FROM ${table(binding, binding.stockCount)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.stockCount.legalEntityColumn!)} = $3
        AND ${quoted(binding.stockCount.recordIdColumn)} = $4
        AND ${quoted(binding.stockCountStateColumn)} = $5
        AND ${quoted(binding.stockCount.archiveColumn)} IS NULL`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.stockCountId,
      binding.stockCountPostedState,
    ],
  );
  if (session.rows.length !== 1) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_REJECTED',
      'stock-count session read-back did not return the posted session',
    );
  }
  const lines = await client.query<Record<string, unknown>>(
    `SELECT ${quoted(binding.stockCountLine.recordIdColumn)}::text AS "stockCountLineId",
            ${quoted(binding.stockCountLineItemColumn)}::text AS "itemId",
            ${quoted(binding.stockCountLineLineNumberColumn)}::text AS "sourceLine",
            ${quoted(binding.stockCountLineExpectedColumn)}::text AS "expectedQuantity",
            ${quoted(binding.stockCountLineCountedColumn)}::text AS "countedQuantity",
            ${quoted(binding.stockCountLineVarianceColumn)}::text AS "varianceQuantity",
            ${quoted(binding.stockCountLineUnitColumn)} AS "unitId",
            ${quoted(binding.stockCountLineReversalColumn)}::text AS "reversalOfMovementId",
            ${quoted(binding.stockCountLineRelationToTransactionLineColumn)}::text AS "transactionLineId"
       FROM ${table(binding, binding.stockCountLine)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.stockCountLine.legalEntityColumn!)} = $3
        AND ${quoted(binding.stockCountLineRelationToSessionColumn)} = $4
        AND ${quoted(binding.stockCountLine.archiveColumn)} IS NULL
      ORDER BY ${quoted(binding.stockCountLineLineNumberColumn)}`,
    [
      context.tenantId,
      context.environmentId,
      command.legalEntityId,
      command.stockCountId,
    ],
  );
  if (lines.rows.length !== command.lines.length) {
    throw postingError(
      'INVENTORY_POSTING_STORAGE_REJECTED',
      'stock-count line read-back did not return the complete evidence set',
    );
  }
  const movementByLine = new Map(
    movements.map((movement) => [movement.transactionLineId, movement]),
  );
  const evidenceLines = lines.rows.map((line) => {
    const transactionLineId = String(line.transactionLineId).toLowerCase();
    const movement = movementByLine.get(transactionLineId);
    if (!movement) {
      throw postingError(
        'INVENTORY_POSTING_STORAGE_REJECTED',
        `stock-count line ${String(line.stockCountLineId)} has no posted movement`,
      );
    }
    return Object.freeze({
      countedQuantity: normalizeDatabaseDecimal(String(line.countedQuantity)),
      expectedQuantity: normalizeDatabaseDecimal(String(line.expectedQuantity)),
      itemId: String(line.itemId).toLowerCase(),
      movementId: movement.movementId,
      reversalOfMovementId: nullableUuid(line.reversalOfMovementId),
      sourceLine: String(line.sourceLine),
      stockCountLineId: String(line.stockCountLineId).toLowerCase(),
      transactionLineId,
      unitId: String(line.unitId),
      varianceQuantity: normalizeDatabaseDecimal(String(line.varianceQuantity)),
    });
  });
  const persistedSession = session.rows[0]!;
  return Object.freeze({
    kind: stockCountKindFromStorage(binding, String(persistedSession.kind)),
    lines: Object.freeze(evidenceLines),
    locationId: String(persistedSession.locationId).toLowerCase(),
    stockCountId: command.stockCountId,
    supersedesStockCountId: nullableUuid(
      persistedSession.supersedesStockCountId,
    ),
  });
}

async function transitionTransactionToPosted(
  client: PoolClient,
  binding: PostingStorageBinding,
  context: TrustedRequestContext,
  profile: InventoryPostingFamilyProfilePayloadV1,
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
      transactionType(binding, profile),
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
              ${quoted(binding.movementReversalOfMovementColumn)}::text AS "reversalOfMovementId",
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
  const recordType = `${namespace}:record.${isStockCountPosting(posting) ? 'stock_count' : postingRole}`;
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
  const changesInput: BusinessFieldChangeInput[] = [
    businessChange(
      'state',
      isStockCountPosting(posting) ? 'reviewed' : 'draft',
      'posted',
    ),
    businessChange('recordedAt', null, result.recordedAt),
    businessChange(
      'quantityDelta',
      null,
      result.movements.map((movement) => movement.quantityDelta),
    ),
    ...(result.stockCountEvidence
      ? [
          businessChange(
            'expectedQuantity',
            null,
            result.stockCountEvidence.lines.map(
              (line) => line.expectedQuantity,
            ),
          ),
          businessChange(
            'countedQuantity',
            null,
            result.stockCountEvidence.lines.map((line) => line.countedQuantity),
          ),
          businessChange(
            'varianceQuantity',
            null,
            result.stockCountEvidence.lines.map(
              (line) => line.varianceQuantity,
            ),
          ),
        ]
      : []),
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
    stockCountEvidence: classified('INTERNAL', result.stockCountEvidence),
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
      isStockCountPosting(posting)
        ? posting.command.stockCountId
        : command.transactionId,
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
  if (posting.postingRole === 'adjustment' || posting.postingRole === 'receipt') {
    return posting.command.lines.map((line) => ({
      sourceLine: line.sourceLine,
    }));
  }
  if (posting.postingRole === 'count' || posting.postingRole === 'correction') {
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
  const version = isStockCountPosting(posting)
    ? stockCountInventoryPostingInputDigestVersion
    : standardInventoryPostingInputDigestVersion;
  return Object.freeze({
    value: digestCommand(posting, version),
    version,
  });
}

function digestCommand(posting: ParsedPosting, version: number): string {
  const { command } = posting;
  const { idempotencyKey, ...semanticInput } = command;
  void idempotencyKey;
  const digestInput =
    version === legacyInventoryPostingInputDigestVersion
      ? posting.postingRole === 'adjustment'
        ? semanticInput
        : unsupportedReceiptVersion(version)
      : version === standardInventoryPostingInputDigestVersion
        ? posting.postingRole === 'adjustment' ||
          posting.postingRole === 'transfer'
          ? { postingRole: posting.postingRole, ...semanticInput }
          : unsupportedReceiptVersion(version)
        : version === stockCountInventoryPostingInputDigestVersion
          ? isStockCountPosting(posting)
            ? { postingRole: posting.postingRole, ...semanticInput }
            : unsupportedReceiptVersion(version)
          : unsupportedReceiptVersion(version);
  return createHash('sha256').update(canonicalize(digestInput)).digest('hex');
}

function recordedResultForReplay(
  receipt: RecordedReceiptRow,
): InventoryPostingResultV1 {
  const version = receipt.input_digest_version;
  if (
    version !== legacyInventoryPostingInputDigestVersion &&
    version !== standardInventoryPostingInputDigestVersion &&
    version !== stockCountInventoryPostingInputDigestVersion
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
    }),
  );
  return Object.freeze({
    ...receipt.mutation_result,
    movements,
    replayed: true,
    stockCountEvidence:
      version === stockCountInventoryPostingInputDigestVersion
        ? requiredRecordedStockCountEvidence(
            receipt.mutation_result.stockCountEvidence,
          )
        : null,
  });
}

function requiredRecordedPostingRole(
  postingRole: InventoryPostingRoleV1 | undefined,
  version: number,
): InventoryPostingRoleV1 {
  if (
    version === standardInventoryPostingInputDigestVersion &&
    (postingRole === 'adjustment' || postingRole === 'transfer')
  ) {
    return postingRole;
  }
  if (
    version === stockCountInventoryPostingInputDigestVersion &&
    (postingRole === 'count' || postingRole === 'correction')
  ) {
    return postingRole;
  }
  throw postingError(
    'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
    'persisted posting receipt has no valid posting role',
  );
}

function requiredRecordedStockCountEvidence(
  evidence: PostedStockCountEvidenceV1 | null | undefined,
): PostedStockCountEvidenceV1 {
  if (
    evidence &&
    Array.isArray(evidence.lines) &&
    evidence.lines.length > 0 &&
    ['initial', 'correction', 'reversal'].includes(evidence.kind)
  ) {
    return evidence;
  }
  throw postingError(
    'INVENTORY_POSTING_IDEMPOTENCY_CONFLICT',
    'persisted stock-count receipt has no readable count evidence',
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
  const code = postgresErrorProperty(error, 'code');
  // PS-0 PROBE ONLY — NOT FOR MERGE, but the defect is real and pre-existing.
  // Without a shape check this reads *any* error carrying a string `code` as a
  // PostgreSQL error, so a foreign source-aggregate refusal (or a Node
  // `ERR_*` error) is relabelled `INVENTORY_POSTING_STORAGE_REJECTED` and its
  // true cause is lost. SQLSTATE is exactly five uppercase alphanumerics.
  return code !== undefined && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
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
