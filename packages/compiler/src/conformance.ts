import {
  LANGUAGE_VERSION,
  canonicalizeAndHash,
  languageHasMaterializedStateFields,
  type NormalizedApplicationPackage,
} from '@north-star/canonical-model';

import { compilerDiagnostic } from './diagnostics.js';
import {
  COMPILER_DIAGNOSTIC_VERSION,
  type CompilerDiagnostic,
} from './protocol.js';

const REQUIRED_QUERY_TYPES = Object.freeze(['get', 'list'] as const);
const REQUIRED_OPERATION_EFFECTS = Object.freeze([
  'archiveRecordEffect',
  'createRecordEffect',
  'restoreRecordEffect',
  'updateRecordEffect',
] as const);
const REQUIRED_SURFACE_ROLES = Object.freeze([
  'form',
  'list',
  'record',
] as const);

const INVENTORY_CONTRACT_SCHEMA_VERSION =
  'northstar.inventory-contract/v1' as const;
const INVENTORY_CONTRACT_RELEASE_VERSION =
  'northstar.inventory-contract-release/v1' as const;
const STOCK_DIMENSION_SET_ID = 'northstar.stock-dimension-set/v1' as const;
const INVENTORY_POSTING_DEPENDENCY_SET_ROOT =
  'ffd4e9f6103b5c6053c39b62fe64e69dd255cb0c86cfd349ae465ab25179b3d3' as const;
const LEGAL_ENTITY_FAMILY_CONTRACT_VERSION =
  'northstar.legal-entity-family-contract/v1' as const;
const LEGAL_ENTITY_FAMILY_RULES = Object.freeze([
  { classification: 'tenantShared', familyId: 'legal_entity' },
  { classification: 'tenantShared', familyId: 'party' },
  { classification: 'tenantShared', familyId: 'party_role' },
  { classification: 'tenantShared', familyId: 'item' },
  { classification: 'tenantShared', familyId: 'location' },
  { classification: 'entityOwned', familyId: 'inventory_movement' },
  { classification: 'entityOwned', familyId: 'inventory_transaction' },
  { classification: 'entityOwned', familyId: 'inventory_transaction_line' },
  { classification: 'entityOwned', familyId: 'inventory_period_lock' },
  { classification: 'entityOwned', familyId: 'posted_stock_balance' },
  { classification: 'entityOwned', familyId: 'reservation' },
  { classification: 'entityOwned', familyId: 'stock_count' },
  { classification: 'entityOwned', familyId: 'stock_count_line' },
] as const);
const INVENTORY_FACT_STORAGE_RULES = Object.freeze([
  {
    familyId: 'inventory_movement',
    mutability: 'appendOnly',
    partitionBy: 'tenantBusinessPeriod',
  },
] as const);
const INVENTORY_PROVIDER_WRITTEN_READ_MODEL_RULES = Object.freeze([
  {
    classification: 'providerWritten',
    familyId: 'posted_stock_balance',
    maintainerId:
      'northstar.postgresql-module-provider:posted-stock-balance/v1',
  },
] as const);
const INVENTORY_STORAGE_REFERENCE_RULES = Object.freeze([
  {
    fieldLocalId: 'inventory_transaction_line_item_id',
    required: true,
    semantics: 'crossEntityAllowed',
    sourceFamilyId: 'inventory_transaction_line',
    targetFamilyId: 'item',
  },
  {
    fieldLocalId: 'inventory_transaction_line_from_location_id',
    required: false,
    semantics: 'sameEntity',
    sourceFamilyId: 'inventory_transaction_line',
    targetFamilyId: 'location',
  },
  {
    fieldLocalId: 'inventory_transaction_line_to_location_id',
    required: false,
    semantics: 'sameEntity',
    sourceFamilyId: 'inventory_transaction_line',
    targetFamilyId: 'location',
  },
  {
    fieldLocalId: 'inventory_movement_item_id',
    required: true,
    semantics: 'crossEntityAllowed',
    sourceFamilyId: 'inventory_movement',
    targetFamilyId: 'item',
  },
  {
    fieldLocalId: 'inventory_movement_location_id',
    required: true,
    semantics: 'sameEntity',
    sourceFamilyId: 'inventory_movement',
    targetFamilyId: 'location',
  },
  {
    fieldLocalId: 'stock_count_location_id',
    required: true,
    semantics: 'sameEntity',
    sourceFamilyId: 'stock_count',
    targetFamilyId: 'location',
  },
  {
    fieldLocalId: 'stock_count_line_item_id',
    required: true,
    semantics: 'crossEntityAllowed',
    sourceFamilyId: 'stock_count_line',
    targetFamilyId: 'item',
  },
] as const);
const REQUIRED_INVENTORY_MODULE_FAMILIES = Object.freeze([
  'legal_entity',
  'inventory_transaction',
  'inventory_transaction_line',
  'inventory_period_lock',
  'inventory_movement',
  'stock_count',
  'stock_count_line',
] as const);
const INVENTORY_PERIOD_LOCK_STORAGE_RULE = Object.freeze({
  advanceOperationLocalId: 'advance_period_lock',
  familyId: 'inventory_period_lock',
  reopenOperationLocalId: 'reopen_period',
  scope: 'onePerLegalEntity',
} as const);
const INVENTORY_MOVEMENT_FIELD_ROLES = Object.freeze({
  effectiveAt: 'inventory_movement_effective_at',
  itemId: 'inventory_movement_item_id',
  locationId: 'inventory_movement_location_id',
  postingRole: 'inventory_movement_posting_role',
  recordedAt: 'inventory_movement_recorded_at',
  sourceId: 'inventory_movement_source_id',
  sourceLine: 'inventory_movement_source_line',
  sourceRevision: 'inventory_movement_source_revision',
  sourceType: 'inventory_movement_source_type',
  unitId: 'inventory_movement_unit_id',
} as const);
const LEGAL_ENTITY_MASTER_FIELD_ROLES = Object.freeze({
  code: 'legal_entity_code',
  isDefault: 'legal_entity_is_default',
  name: 'legal_entity_name',
  status: 'legal_entity_status',
} as const);
const LEGAL_ENTITY_RELATION_RULES = Object.freeze([
  {
    semantics: 'sameEntity',
    sourceFamilyId: 'inventory_movement',
    targetFamilyId: 'location',
  },
  {
    semantics: 'sameEntity',
    sourceFamilyId: 'inventory_movement',
    targetFamilyId: 'inventory_transaction',
  },
  {
    semantics: 'sameEntity',
    sourceFamilyId: 'inventory_movement',
    targetFamilyId: 'inventory_transaction_line',
  },
  {
    semantics: 'crossEntityAllowed',
    sourceFamilyId: 'inventory_movement',
    targetFamilyId: 'item',
  },
  {
    semantics: 'crossEntityAllowed',
    sourceFamilyId: 'party_role',
    targetFamilyId: 'party',
  },
  {
    semantics: 'sameEntity',
    sourceFamilyId: 'inventory_transaction_line',
    targetFamilyId: 'inventory_transaction',
  },
  {
    semantics: 'sameEntity',
    sourceFamilyId: 'stock_count',
    targetFamilyId: 'inventory_transaction',
  },
  {
    semantics: 'sameEntity',
    sourceFamilyId: 'stock_count',
    targetFamilyId: 'stock_count',
  },
  {
    semantics: 'sameEntity',
    sourceFamilyId: 'stock_count_line',
    targetFamilyId: 'stock_count',
  },
  {
    semantics: 'sameEntity',
    sourceFamilyId: 'stock_count_line',
    targetFamilyId: 'inventory_transaction_line',
  },
] as const);
const LEGAL_ENTITY_GOVERNED_PACKAGES = Object.freeze([
  'catalog',
  'inventory',
  'location',
  'party',
] as const);
const INVENTORY_POSTING_ROLES = Object.freeze([
  'adjustment',
  'transfer',
  'count',
  'correction',
  'reBaseline',
] as const);
const NEGATIVE_STOCK_MODES = Object.freeze([
  'reject',
  'allowWithFlag',
  'allow',
] as const);
const REASON_REQUIREMENTS = Object.freeze([
  'codeOnly',
  'codeAndNarrative',
] as const);
const CANONICAL_DECIMAL_V2 = /^(?:0|-[1-9]\d*|[1-9]\d*)(?:\.\d*[1-9])?$/;
const MOVEMENT_MONEY_TOKEN =
  /(?:amount|money|monetary|value|cost|price|currency)/iu;
const COUNT_EVIDENCE_MONEY_TOKEN =
  /(?:amount|money|monetary|valuation|cost|price|currency)/iu;
type InventoryMovementModuleFieldShape =
  | { kind: 'dateTime'; precision: 'millisecond'; timezone: 'utcInstant' }
  | { kind: 'decimal'; precision: 38; scale: 18 }
  | {
      kind: 'enum';
      options: readonly { label: string; optionLocalId: string }[];
    }
  | { kind: 'integer' }
  | { kind: 'text'; maximumLength: number };
interface InventoryMovementModuleFieldRule {
  fieldLocalId: string;
  presence: 'optional' | 'required';
  shape: InventoryMovementModuleFieldShape;
}
const INVENTORY_MOVEMENT_MODULE_FIELD_RULES = Object.freeze([
  {
    fieldLocalId: 'inventory_movement_stock_dimension_set_version',
    presence: 'required',
    shape: {
      kind: 'enum',
      options: [
        { label: 'v1', optionLocalId: 'stock_dimension_set_version_v1' },
      ],
    },
  },
  {
    fieldLocalId: 'inventory_movement_item_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'inventory_movement_location_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'inventory_movement_quantity_delta',
    presence: 'required',
    shape: { kind: 'decimal', precision: 38, scale: 18 },
  },
  {
    fieldLocalId: 'inventory_movement_unit_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 32 },
  },
  {
    fieldLocalId: 'inventory_movement_effective_at',
    presence: 'required',
    shape: {
      kind: 'dateTime',
      precision: 'millisecond',
      timezone: 'utcInstant',
    },
  },
  {
    fieldLocalId: 'inventory_movement_recorded_at',
    presence: 'required',
    shape: {
      kind: 'dateTime',
      precision: 'millisecond',
      timezone: 'utcInstant',
    },
  },
  {
    fieldLocalId: 'inventory_movement_source_type',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'inventory_movement_source_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'inventory_movement_source_line',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'inventory_movement_source_revision',
    presence: 'required',
    shape: { kind: 'integer' },
  },
  {
    fieldLocalId: 'inventory_movement_posting_role',
    presence: 'required',
    shape: {
      kind: 'enum',
      options: [
        {
          label: 'adjustment',
          optionLocalId: 'inventory_posting_role_adjustment',
        },
        { label: 'transfer', optionLocalId: 'inventory_posting_role_transfer' },
        { label: 'count', optionLocalId: 'inventory_posting_role_count' },
        {
          label: 'correction',
          optionLocalId: 'inventory_posting_role_correction',
        },
        {
          label: 'reBaseline',
          optionLocalId: 'inventory_posting_role_re_baseline',
        },
      ],
    },
  },
  {
    fieldLocalId: 'inventory_movement_reason_code',
    presence: 'optional',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'inventory_movement_reason_narrative',
    presence: 'optional',
    shape: { kind: 'text', maximumLength: 1000 },
  },
  {
    fieldLocalId: 'inventory_movement_actor_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'inventory_movement_reversal_of_movement_id',
    presence: 'optional',
    shape: { kind: 'text', maximumLength: 80 },
  },
] as const satisfies readonly InventoryMovementModuleFieldRule[]);
const POSTED_STOCK_BALANCE_MODULE_FIELD_RULES = Object.freeze([
  {
    fieldLocalId: 'posted_stock_balance_item_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'posted_stock_balance_location_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'posted_stock_balance_posted_quantity',
    presence: 'required',
    shape: { kind: 'decimal', precision: 38, scale: 18 },
  },
  {
    fieldLocalId: 'posted_stock_balance_unit_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 32 },
  },
] as const satisfies readonly InventoryMovementModuleFieldRule[]);
const STOCK_COUNT_MODULE_FIELD_RULES = Object.freeze([
  {
    fieldLocalId: 'stock_count_number',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 60 },
  },
  {
    fieldLocalId: 'stock_count_kind',
    presence: 'required',
    shape: {
      kind: 'enum',
      options: [
        { label: 'initial', optionLocalId: 'stock_count_kind_initial' },
        { label: 'correction', optionLocalId: 'stock_count_kind_correction' },
        { label: 'reversal', optionLocalId: 'stock_count_kind_reversal' },
      ],
    },
  },
  {
    fieldLocalId: 'stock_count_state',
    presence: 'required',
    shape: {
      kind: 'enum',
      options: [
        { label: 'draft', optionLocalId: 'stock_count_state_draft' },
        { label: 'counting', optionLocalId: 'stock_count_state_counting' },
        { label: 'reviewed', optionLocalId: 'stock_count_state_reviewed' },
        { label: 'posted', optionLocalId: 'stock_count_state_posted' },
      ],
    },
  },
  {
    fieldLocalId: 'stock_count_location_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'stock_count_counted_at',
    presence: 'required',
    shape: {
      kind: 'dateTime',
      precision: 'millisecond',
      timezone: 'utcInstant',
    },
  },
  {
    fieldLocalId: 'stock_count_recorded_at',
    presence: 'optional',
    shape: {
      kind: 'dateTime',
      precision: 'millisecond',
      timezone: 'utcInstant',
    },
  },
  {
    fieldLocalId: 'stock_count_actor_id',
    presence: 'optional',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'stock_count_reason_code',
    presence: 'optional',
    shape: { kind: 'text', maximumLength: 80 },
  },
  {
    fieldLocalId: 'stock_count_reason_narrative',
    presence: 'optional',
    shape: { kind: 'text', maximumLength: 1000 },
  },
] as const satisfies readonly InventoryMovementModuleFieldRule[]);
const STOCK_COUNT_LINE_MODULE_FIELD_RULES = Object.freeze([
  {
    fieldLocalId: 'stock_count_line_line_number',
    presence: 'required',
    shape: { kind: 'integer' },
  },
  {
    fieldLocalId: 'stock_count_line_item_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 80 },
  },
  ...[
    'stock_count_line_expected_quantity',
    'stock_count_line_counted_quantity',
    'stock_count_line_variance_quantity',
  ].map((fieldLocalId) => ({
    fieldLocalId,
    presence: 'required' as const,
    shape: {
      kind: 'decimal' as const,
      precision: 38 as const,
      scale: 18 as const,
    },
  })),
  {
    fieldLocalId: 'stock_count_line_unit_id',
    presence: 'required',
    shape: { kind: 'text', maximumLength: 32 },
  },
  {
    fieldLocalId: 'stock_count_line_reversal_of_movement_id',
    presence: 'optional',
    shape: { kind: 'text', maximumLength: 80 },
  },
] as const satisfies readonly InventoryMovementModuleFieldRule[]);
const INVENTORY_MOVEMENT_CANDIDATE_FIELDS = Object.freeze([
  'movementId',
  'stockDimensionSetVersion',
  'stockIdentity',
  'quantityDelta',
  'unitId',
  'effectiveAt',
  'recordedAt',
  'sourceType',
  'sourceId',
  'sourceLine',
  'postingRole',
] as const);

type InventoryPostingRole = (typeof INVENTORY_POSTING_ROLES)[number];
export type LegalEntityFamilyClassification = 'entityOwned' | 'tenantShared';
export type LegalEntityRelationSemantics = 'sameEntity' | 'crossEntityAllowed';
type NegativeStockMode = (typeof NEGATIVE_STOCK_MODES)[number];
type ReasonRequirement = (typeof REASON_REQUIREMENTS)[number];

export type InventoryContractDiagnosticCode =
  | 'INVENTORY_BASE_UNIT_IMMUTABLE'
  | 'INVENTORY_CONFIGURATION_MALFORMED'
  | 'INVENTORY_CONFIGURATION_OUT_OF_RANGE'
  | 'INVENTORY_CONFIGURATION_REQUIRED'
  | 'INVENTORY_CONTRACT_INVALID'
  | 'INVENTORY_COUNT_EVIDENCE_INVALID'
  | 'INVENTORY_COUNT_EVIDENCE_MONEY_FORBIDDEN'
  | 'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED'
  | 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN'
  | 'INVENTORY_MOVEMENT_VALUE_DERIVATION_FORBIDDEN'
  | 'INVENTORY_POSTING_DEPENDENCY_UNDECLARED'
  | 'INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED'
  | 'INVENTORY_STOCK_DIMENSION_MEMBER_REQUIRED'
  | 'INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN'
  | 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED'
  | 'INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN'
  | 'INVENTORY_TERMINAL_GUARD_MISSING';

export interface InventoryContractDiagnostic {
  bindingMovementId: string | null;
  code: InventoryContractDiagnosticCode;
  path: string;
  rule: string;
  subjectId: string | null;
}

export interface InventoryPostingConfigurationV1 {
  approvalThresholds: Readonly<Record<InventoryPostingRole, string | null>>;
  maximumBackdateDays: number;
  negativeStock: NegativeStockMode;
  reasonRequirements: Readonly<Record<InventoryPostingRole, ReasonRequirement>>;
}

export interface InventoryContractReleaseRecordV1 {
  capabilityId: string;
  capabilityVersion: number;
  configuration: InventoryPostingConfigurationV1;
  configurationScope: 'legalEntity';
  contract: Record<string, unknown>;
  schemaVersion: typeof INVENTORY_CONTRACT_RELEASE_VERSION;
}

export interface CompiledInventoryContractV1 {
  canonicalBytes: Uint8Array;
  release: InventoryContractReleaseRecordV1;
  releaseRoot: string;
}

export type InventoryContractCompileResult =
  | {
      diagnostics: [];
      release: CompiledInventoryContractV1;
      status: 'compiled';
    }
  | {
      diagnostics: InventoryContractDiagnostic[];
      release: null;
      status: 'failed';
    };

export interface InventoryMovementCandidateV1 {
  effectiveAt?: string;
  movementId?: string;
  postingRole?: InventoryPostingRole;
  quantityDelta?: string;
  recordedAt?: string;
  sourceId?: string;
  sourceLine?: string;
  sourceType?: string;
  stockDimensionSetVersion?: string;
  stockIdentity?: Partial<
    Record<'legalEntityId' | 'itemId' | 'locationId', string>
  >;
  unitId?: string;
}

export interface InventoryBaseUnitChangeAttemptV1 {
  bindingMovementId: string | null;
  currentBaseUnitId: string;
  itemId: string;
  requestedBaseUnitId: string;
}

export type InventoryConformanceResult =
  | { diagnostics: []; status: 'accepted' }
  | { diagnostics: InventoryContractDiagnostic[]; status: 'rejected' };

export type PinnedLegalEntityFamilyResolution =
  | {
      classification: LegalEntityFamilyClassification;
      familyId: string;
      status: 'classified';
    }
  | { familyId: string; status: 'undeclared' }
  | { familyId: string | null; status: 'outsidePinnedContract' };

/**
 * The G3 family map is a pinned domain contract, not canonical syntax. Known
 * family IDs are derived from canonical entity IDs; an unknown family in a
 * governed package is an error rather than an ownership default. Other module
 * families remain outside this G3-only contract until the G6 generalization.
 */
export function resolvePinnedLegalEntityFamily(
  packageId: string,
  entityId: string,
): PinnedLegalEntityFamilyResolution {
  const familyId = canonicalFamilyId(entityId);
  const rule = LEGAL_ENTITY_FAMILY_RULES.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (rule) {
    return {
      classification: rule.classification,
      familyId: rule.familyId,
      status: 'classified',
    };
  }
  if (isLegalEntityGovernedPackage(packageId)) {
    return { familyId: familyId ?? entityId, status: 'undeclared' };
  }
  return { familyId, status: 'outsidePinnedContract' };
}

export interface PinnedInventoryFactStorageRule {
  familyId: string;
  mutability: 'appendOnly';
  partitionBy: 'tenantBusinessPeriod';
}

export interface PinnedInventoryProviderWrittenReadModelRule {
  classification: 'providerWritten';
  familyId: string;
  maintainerId: string;
}

export interface PinnedInventoryStorageReferenceRule {
  fieldLocalId: string;
  required: boolean;
  semantics: LegalEntityRelationSemantics;
  sourceFamilyId: string;
  targetFamilyId: string;
}

export interface PinnedInventoryPeriodLockStorageRule {
  advanceOperationLocalId: 'advance_period_lock';
  familyId: 'inventory_period_lock';
  reopenOperationLocalId: 'reopen_period';
  scope: 'onePerLegalEntity';
}

export type InventoryMovementStorageFieldRole =
  keyof typeof INVENTORY_MOVEMENT_FIELD_ROLES;

export function resolvePinnedInventoryFactStorage(
  _packageId: string,
  entityId: string,
): PinnedInventoryFactStorageRule | null {
  const familyId = canonicalFamilyId(entityId);
  if (!familyId) return null;
  const rule = INVENTORY_FACT_STORAGE_RULES.find(
    (candidate) => candidate.familyId === familyId,
  );
  return rule ? { ...rule } : null;
}

/**
 * Resolves the compiler's pinned provider-written candidate rule. No authored
 * key participates, and packageId is deliberately not an authority because
 * composition rewrites the containing package identity. Module conformance
 * separately proves the maintainer's exact field ABI before this rule earns
 * the CRUD/Form exemption. This mirrors fact storage's resolver-plus-shape
 * validation split while preserving canonical family identity in composition.
 */
export function resolvePinnedInventoryProviderWrittenReadModel(
  _packageId: string,
  entityId: string,
): PinnedInventoryProviderWrittenReadModelRule | null {
  const familyId = canonicalFamilyId(entityId);
  if (!familyId) return null;
  const rule = INVENTORY_PROVIDER_WRITTEN_READ_MODEL_RULES.find(
    (candidate) => candidate.familyId === familyId,
  );
  return rule ? { ...rule } : null;
}

export function resolvePinnedInventoryStorageReference(
  entityId: string,
  fieldId: string,
): PinnedInventoryStorageReferenceRule | null {
  const sourceFamilyId = canonicalFamilyId(entityId);
  const fieldLocalId = canonicalFieldLocalId(fieldId);
  if (!sourceFamilyId || !fieldLocalId) return null;
  const rule = INVENTORY_STORAGE_REFERENCE_RULES.find(
    (candidate) =>
      candidate.sourceFamilyId === sourceFamilyId &&
      candidate.fieldLocalId === fieldLocalId,
  );
  return rule ? { ...rule } : null;
}

export function resolvePinnedInventoryPeriodLockStorage(
  entityId: string,
): PinnedInventoryPeriodLockStorageRule | null {
  return canonicalFamilyId(entityId) ===
    INVENTORY_PERIOD_LOCK_STORAGE_RULE.familyId
    ? { ...INVENTORY_PERIOD_LOCK_STORAGE_RULE }
    : null;
}

export function resolvePinnedInventoryMovementFieldRole(
  packageId: string,
  entityId: string,
  fieldId: string,
): InventoryMovementStorageFieldRole | null {
  const fact = resolvePinnedInventoryFactStorage(packageId, entityId);
  if (!fact) return null;
  const marker = ':field.';
  const offset = fieldId.lastIndexOf(marker);
  const localId = offset < 0 ? null : fieldId.slice(offset + marker.length);
  for (const [role, declaredLocalId] of Object.entries(
    INVENTORY_MOVEMENT_FIELD_ROLES,
  )) {
    if (localId === declaredLocalId) {
      return role as InventoryMovementStorageFieldRole;
    }
  }
  return null;
}

export function isPinnedInventoryBaseUnitField(
  packageId: string,
  entityId: string,
  fieldId: string,
): boolean {
  const family = resolvePinnedLegalEntityFamily(packageId, entityId);
  if (family.status !== 'classified' || family.familyId !== 'item') {
    return false;
  }
  return fieldId.endsWith(':field.item_base_unit');
}

function inventoryMovementFieldShapeMatches(
  field: NormalizedApplicationPackage['fields'][number],
  rule: InventoryMovementModuleFieldRule,
  namespace: string,
): boolean {
  if (field.lifecycle !== 'active' || field.presence !== rule.presence) {
    return false;
  }
  const fieldType = field.fieldType;
  switch (rule.shape.kind) {
    case 'dateTime':
      return (
        fieldType.kind === 'dateTimeFieldType' &&
        fieldType.precision === rule.shape.precision &&
        fieldType.timezoneSemantics === rule.shape.timezone
      );
    case 'decimal':
      return (
        fieldType.kind === 'exactDecimalFieldType' &&
        fieldType.precision === rule.shape.precision &&
        fieldType.scale === rule.shape.scale &&
        fieldType.representation === 'canonicalString'
      );
    case 'enum':
      return (
        fieldType.kind === 'enumFieldType' &&
        sameStringArray(
          fieldType.options.map(
            (option) => `${option.label}|${option.optionId}`,
          ),
          rule.shape.options.map(
            (option) =>
              `${option.label}|${namespace}:option.${option.optionLocalId}`,
          ),
        )
      );
    case 'integer':
      return (
        fieldType.kind === 'integerFieldType' &&
        fieldType.representation === 'canonicalString'
      );
    case 'text':
      return (
        fieldType.kind === 'textFieldType' &&
        fieldType.maximumLength === rule.shape.maximumLength
      );
  }
}

function activeTextFieldShapeMatches(
  field: NormalizedApplicationPackage['fields'][number],
  presence: 'optional' | 'required',
  maximumLength: number,
): boolean {
  return (
    field.lifecycle === 'active' &&
    field.presence === presence &&
    field.fieldType.kind === 'textFieldType' &&
    field.fieldType.maximumLength === maximumLength
  );
}

function validateRequiredInventoryEntitySet(
  packageRevision: NormalizedApplicationPackage,
  diagnostics: CompilerDiagnostic[],
): void {
  const observedFamilies = new Set(
    packageRevision.entities
      .filter((entity) => entity.lifecycle === 'active')
      .map((entity) => canonicalFamilyId(entity.entityId))
      .filter((familyId): familyId is string => familyId !== null),
  );
  const packageFamily = canonicalPackageLocalId(
    packageRevision.package.packageId,
  );
  if (
    packageFamily !== 'inventory' &&
    !REQUIRED_INVENTORY_MODULE_FAMILIES.some((familyId) =>
      observedFamilies.has(familyId),
    )
  ) {
    return;
  }
  for (const familyId of REQUIRED_INVENTORY_MODULE_FAMILIES) {
    if (observedFamilies.has(familyId)) continue;
    diagnostics.push(
      inventoryModuleDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        `$.entities.${familyId}`,
        `${packageRevision.package.namespace}:entity.${familyId}`,
      ),
    );
  }
}

function validateRecordedTimeProjectionRetention(
  packageRevision: NormalizedApplicationPackage,
  diagnostics: CompilerDiagnostic[],
): void {
  const recordedAtFieldId = `${packageRevision.package.namespace}:field.inventory_movement_recorded_at`;
  const missingRecordedAt = packageRevision.queries.some(
    (query) =>
      query.lifecycle === 'active' &&
      canonicalFamilyId(query.sourceEntity.targetId) === 'inventory_movement' &&
      !query.selections.some(
        (selection) => selection.field.targetId === recordedAtFieldId,
      ),
  );
  if (!missingRecordedAt) return;
  diagnostics.push(
    inventoryModuleDiagnostic(
      'INVENTORY_CONTRACT_INVALID',
      '$.queries.inventory_movement_recorded_at',
      recordedAtFieldId,
    ),
  );
}

function validatePinnedInventoryMovementEntity(
  packageRevision: NormalizedApplicationPackage,
  entityId: string,
  diagnostics: CompilerDiagnostic[],
): void {
  const fields = packageRevision.fields.filter(
    (field) => field.entity.targetId === entityId,
  );
  const rules = new Map<string, InventoryMovementModuleFieldRule>(
    INVENTORY_MOVEMENT_MODULE_FIELD_RULES.map((rule) => [
      rule.fieldLocalId,
      rule,
    ]),
  );
  const observed = new Set<string>();
  for (const field of fields) {
    const localId = canonicalFieldLocalId(field.fieldId);
    const rule = localId ? rules.get(localId) : undefined;
    if (!rule) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          MOVEMENT_MONEY_TOKEN.test(field.fieldId)
            ? 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN'
            : 'INVENTORY_CONTRACT_INVALID',
          `$.fields.${localId ?? field.fieldId}`,
          field.fieldId,
        ),
      );
      continue;
    }
    observed.add(rule.fieldLocalId);
    if (
      !inventoryMovementFieldShapeMatches(
        field,
        rule,
        packageRevision.package.namespace,
      )
    ) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          rule.fieldLocalId === 'inventory_movement_stock_dimension_set_version'
            ? 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED'
            : 'INVENTORY_CONTRACT_INVALID',
          `$.fields.${rule.fieldLocalId}`,
          field.fieldId,
        ),
      );
    }
  }
  for (const rule of INVENTORY_MOVEMENT_MODULE_FIELD_RULES) {
    if (observed.has(rule.fieldLocalId)) continue;
    const fieldId = `${packageRevision.package.namespace}:field.${rule.fieldLocalId}`;
    diagnostics.push(
      inventoryModuleDiagnostic(
        rule.fieldLocalId === 'inventory_movement_stock_dimension_set_version'
          ? 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED'
          : 'INVENTORY_CONTRACT_INVALID',
        `$.fields.${rule.fieldLocalId}`,
        fieldId,
      ),
    );
  }
}

/**
 * Proves the storage ABI named by the pinned PostgreSQL maintainer before the
 * provider-written classification may omit authored CRUD and Form. The exact
 * field set is intentional: an extra required field would be just as orphaned
 * as a missing one because the provider never authors a value for it.
 */
function validatePinnedPostedStockBalanceEntity(
  packageRevision: NormalizedApplicationPackage,
  entityId: string,
  diagnostics: CompilerDiagnostic[],
): boolean {
  const diagnosticCount = diagnostics.length;
  const expected = new Map<string, InventoryMovementModuleFieldRule>(
    POSTED_STOCK_BALANCE_MODULE_FIELD_RULES.map((rule) => [
      rule.fieldLocalId,
      rule,
    ]),
  );
  const observed = new Set<string>();
  for (const field of packageRevision.fields.filter(
    (candidate) => candidate.entity.targetId === entityId,
  )) {
    const localId = canonicalFieldLocalId(field.fieldId);
    const rule = localId ? expected.get(localId) : undefined;
    if (!rule) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          `$.fields.${localId ?? field.fieldId}`,
          field.fieldId,
        ),
      );
      continue;
    }
    observed.add(rule.fieldLocalId);
    if (
      !inventoryMovementFieldShapeMatches(
        field,
        rule,
        packageRevision.package.namespace,
      )
    ) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          `$.fields.${rule.fieldLocalId}`,
          field.fieldId,
        ),
      );
    }
  }
  for (const rule of POSTED_STOCK_BALANCE_MODULE_FIELD_RULES) {
    if (observed.has(rule.fieldLocalId)) continue;
    diagnostics.push(
      inventoryModuleDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        `$.fields.${rule.fieldLocalId}`,
        `${packageRevision.package.namespace}:field.${rule.fieldLocalId}`,
      ),
    );
  }
  const movementEntities = packageRevision.entities.filter(
    (candidate) =>
      candidate.lifecycle === 'active' &&
      canonicalFamilyId(candidate.entityId) === 'inventory_movement',
  );
  if (movementEntities.length !== 1) {
    diagnostics.push(
      inventoryModuleDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.entities.inventory_movement',
        `${packageRevision.package.namespace}:entity.inventory_movement`,
      ),
    );
  }
  return diagnostics.length === diagnosticCount;
}

function operationTargetsEntity(
  packageRevision: NormalizedApplicationPackage,
  operation: NormalizedApplicationPackage['operations'][number],
  entityId: string,
): boolean {
  if ('entity' in operation.effect) {
    return operation.effect.entity.targetId === entityId;
  }
  if (operation.effect.kind !== 'transitionStateEffect') return false;
  const transitionId = operation.effect.transition.targetId;
  return packageRevision.stateMachines.some(
    (machine) =>
      machine.entity.targetId === entityId &&
      machine.transitions.some(
        (transition) => transition.transitionId === transitionId,
      ),
  );
}

function validatePinnedInventoryCountEntity(
  packageRevision: NormalizedApplicationPackage,
  entityId: string,
  rules: readonly InventoryMovementModuleFieldRule[],
  diagnostics: CompilerDiagnostic[],
): void {
  const expected = new Map(rules.map((rule) => [rule.fieldLocalId, rule]));
  const observed = new Set<string>();
  for (const field of packageRevision.fields.filter(
    (candidate) => candidate.entity.targetId === entityId,
  )) {
    const localId = canonicalFieldLocalId(field.fieldId);
    const rule = localId ? expected.get(localId) : undefined;
    if (!rule) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          COUNT_EVIDENCE_MONEY_TOKEN.test(field.fieldId)
            ? 'INVENTORY_COUNT_EVIDENCE_MONEY_FORBIDDEN'
            : 'INVENTORY_COUNT_EVIDENCE_INVALID',
          `$.fields.${localId ?? field.fieldId}`,
          field.fieldId,
        ),
      );
      continue;
    }
    observed.add(rule.fieldLocalId);
    if (
      !inventoryMovementFieldShapeMatches(
        field,
        rule,
        packageRevision.package.namespace,
      )
    ) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          'INVENTORY_COUNT_EVIDENCE_INVALID',
          `$.fields.${rule.fieldLocalId}`,
          field.fieldId,
        ),
      );
    }
  }
  for (const rule of rules) {
    if (observed.has(rule.fieldLocalId)) continue;
    diagnostics.push(
      inventoryModuleDiagnostic(
        'INVENTORY_COUNT_EVIDENCE_INVALID',
        `$.fields.${rule.fieldLocalId}`,
        `${packageRevision.package.namespace}:field.${rule.fieldLocalId}`,
      ),
    );
  }
}

function validatePinnedStockCountTerminalGuard(
  packageRevision: NormalizedApplicationPackage,
  entityId: string,
  authoredOperations: AuthoredOperationConformanceInput,
  diagnostics: CompilerDiagnostic[],
): void {
  const namespace = packageRevision.package.namespace;
  const stateFieldId = `${namespace}:field.stock_count_state`;
  const stateField = packageRevision.fields.find(
    (candidate) => candidate.fieldId === stateFieldId,
  );
  if (!stateField || stateField.presence !== 'required') {
    diagnostics.push(
      inventoryModuleDiagnostic(
        'INVENTORY_TERMINAL_GUARD_MISSING',
        '$.fields.stock_count_state.presence',
        stateFieldId,
      ),
    );
  }

  const expectedPrecondition = {
    kind: 'notPredicate',
    schemaVersion: authoredOperations.languageVersion,
    term: {
      field: {
        kind: 'fieldReference',
        schemaVersion: authoredOperations.languageVersion,
        targetId: stateFieldId,
      },
      kind: 'fieldComparisonPredicate',
      operator: 'equals',
      schemaVersion: authoredOperations.languageVersion,
      value: {
        kind: 'textValue',
        schemaVersion: authoredOperations.languageVersion,
        value: `${namespace}:option.stock_count_state_posted`,
      },
    },
  };
  const expectedPreconditionRoot = inventoryCanonicalRoot(expectedPrecondition);
  for (const [action, effectKind] of [
    ['archive', 'archiveRecordEffect'],
    ['create', 'createRecordEffect'],
    ['restore', 'restoreRecordEffect'],
    ['update', 'updateRecordEffect'],
  ] as const) {
    const operationId = `${namespace}:operation.stock_count_${action}`;
    const operation = packageRevision.operations.find(
      (candidate) => candidate.operationId === operationId,
    );
    const authoredOperation = authoredOperations.operations.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (
      !operation ||
      !authoredOperation ||
      operation.lifecycle !== 'active' ||
      operation.tier !== 'o0' ||
      operation.effect.kind !== effectKind ||
      !('entity' in operation.effect) ||
      operation.effect.entity.targetId !== entityId ||
      inventoryCanonicalRoot(authoredOperation.precondition) !==
        expectedPreconditionRoot
    ) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          'INVENTORY_TERMINAL_GUARD_MISSING',
          `$.operations.stock_count_${action}.precondition`,
          operationId,
        ),
      );
    }
  }
}

function validatePinnedInventoryCountRelations(
  packageRevision: NormalizedApplicationPackage,
  diagnostics: CompilerDiagnostic[],
): void {
  const namespace = packageRevision.package.namespace;
  if (
    canonicalPackageLocalId(packageRevision.package.packageId) !==
      'inventory' &&
    !packageRevision.entities.some((entity) =>
      ['stock_count', 'stock_count_line'].includes(
        canonicalFamilyId(entity.entityId) ?? '',
      ),
    )
  ) {
    return;
  }
  const rules = [
    [
      'stock_count_transaction',
      'stock_count',
      'inventory_transaction',
      'reference',
      true,
    ],
    [
      'stock_count_supersedes',
      'stock_count',
      'stock_count',
      'reference',
      false,
    ],
    [
      'stock_count_line_session',
      'stock_count_line',
      'stock_count',
      'parentScopedChild',
      true,
    ],
    [
      'stock_count_line_transaction_line',
      'stock_count_line',
      'inventory_transaction_line',
      'reference',
      true,
    ],
  ] as const;
  for (const [localId, source, target, ownership, required] of rules) {
    const relationId = `${namespace}:relation.${localId}`;
    const relation = packageRevision.relations.find(
      (candidate) => candidate.relationId === relationId,
    );
    if (
      relation?.lifecycle !== 'active' ||
      relation.cardinality !== 'manyToOne' ||
      relation.ownership !== ownership ||
      relation.required !== required ||
      relation.sourceEntity.targetId !== `${namespace}:entity.${source}` ||
      relation.targetEntity.targetId !== `${namespace}:entity.${target}`
    ) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          'INVENTORY_COUNT_EVIDENCE_INVALID',
          `$.relations.${localId}`,
          relationId,
        ),
      );
    }
  }
}

export type LegalEntityMasterFieldRole =
  keyof typeof LEGAL_ENTITY_MASTER_FIELD_ROLES;

export function isPinnedLegalEntityMaster(
  packageId: string,
  entityId: string,
): boolean {
  const family = resolvePinnedLegalEntityFamily(packageId, entityId);
  return family.status === 'classified' && family.familyId === 'legal_entity';
}

export function resolvePinnedLegalEntityMasterFieldRole(
  packageId: string,
  entityId: string,
  fieldId: string,
): LegalEntityMasterFieldRole | null {
  if (!isPinnedLegalEntityMaster(packageId, entityId)) return null;
  const marker = ':field.';
  const offset = fieldId.lastIndexOf(marker);
  const localId = offset < 0 ? null : fieldId.slice(offset + marker.length);
  for (const [role, declaredLocalId] of Object.entries(
    LEGAL_ENTITY_MASTER_FIELD_ROLES,
  )) {
    if (localId === declaredLocalId) return role as LegalEntityMasterFieldRole;
  }
  return null;
}

export function resolvePinnedLegalEntityRelationSemantics(
  sourceFamilyId: string,
  targetFamilyId: string,
): LegalEntityRelationSemantics | null {
  return (
    LEGAL_ENTITY_RELATION_RULES.find(
      (rule) =>
        rule.sourceFamilyId === sourceFamilyId &&
        rule.targetFamilyId === targetFamilyId,
    )?.semantics ?? null
  );
}

export interface AuthoredOperationConformanceInput {
  readonly languageVersion: string;
  readonly operations: readonly {
    readonly operationId: string;
    readonly precondition: unknown;
  }[];
}

export function validateModuleConformance(
  packageRevision: NormalizedApplicationPackage,
  authoredOperations: AuthoredOperationConformanceInput = packageRevision,
): CompilerDiagnostic[] {
  if (packageRevision.languageVersion !== LANGUAGE_VERSION) return [];
  const diagnostics: CompilerDiagnostic[] = [];
  validateRequiredInventoryEntitySet(packageRevision, diagnostics);
  validateRecordedTimeProjectionRetention(packageRevision, diagnostics);
  validatePinnedInventoryCountRelations(packageRevision, diagnostics);
  const storageById = new Map(
    packageRevision.storageMappings.map((mapping) => [
      mapping.storageMappingId,
      mapping,
    ]),
  );
  const qualifiedProviderWrittenReadModels = new Set<string>();

  for (const entity of packageRevision.entities) {
    const family = resolvePinnedLegalEntityFamily(
      packageRevision.package.packageId,
      entity.entityId,
    );
    if (family.status !== 'classified') {
      continue;
    }
    if (
      [
        'inventory_movement',
        'posted_stock_balance',
        'stock_count',
        'stock_count_line',
      ].includes(family.familyId) &&
      entity.lifecycle !== 'active'
    ) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          family.familyId === 'inventory_movement' ||
            family.familyId === 'posted_stock_balance'
            ? 'INVENTORY_CONTRACT_INVALID'
            : 'INVENTORY_COUNT_EVIDENCE_INVALID',
          `$.entities.${family.familyId}.lifecycle`,
          entity.entityId,
        ),
      );
    }
    if (family.familyId === 'inventory_movement') {
      validatePinnedInventoryMovementEntity(
        packageRevision,
        entity.entityId,
        diagnostics,
      );
    } else if (family.familyId === 'posted_stock_balance') {
      if (
        entity.lifecycle === 'active' &&
        validatePinnedPostedStockBalanceEntity(
          packageRevision,
          entity.entityId,
          diagnostics,
        )
      ) {
        qualifiedProviderWrittenReadModels.add(entity.entityId);
      }
    } else if (family.familyId === 'stock_count') {
      validatePinnedInventoryCountEntity(
        packageRevision,
        entity.entityId,
        STOCK_COUNT_MODULE_FIELD_RULES,
        diagnostics,
      );
      validatePinnedStockCountTerminalGuard(
        packageRevision,
        entity.entityId,
        authoredOperations,
        diagnostics,
      );
    } else if (family.familyId === 'stock_count_line') {
      validatePinnedInventoryCountEntity(
        packageRevision,
        entity.entityId,
        STOCK_COUNT_LINE_MODULE_FIELD_RULES,
        diagnostics,
      );
    }
  }

  for (const mapping of packageRevision.storageMappings.filter(
    (entry) => entry.lifecycle === 'active',
  )) {
    if (mapping.storageClass === null || mapping.storageClass === undefined) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_STORAGE_CLASS_REQUIRED',
          'wholeModelValidation',
          '$.storageMappings.storageClass',
          mapping.storageMappingId,
        ),
      );
    } else if (mapping.storageClass === 'generatedTyped') {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_GENERATED_STORAGE_UNSUPPORTED',
          'wholeModelValidation',
          '$.storageMappings.storageClass',
          mapping.storageMappingId,
        ),
      );
    }
    if (mapping.promotion) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_STORAGE_PROMOTION_UNSUPPORTED',
          'wholeModelValidation',
          '$.storageMappings.promotion.capabilityId',
          mapping.storageMappingId,
        ),
      );
    }
  }

  // The AUTHORED revision's version, not the dispatch alias's. `packageRevision`
  // here is `projectionDispatchRevision(...)`, whose `languageVersion` is
  // rewritten to the legacy compatibility literal -- which is exactly why the
  // guard at the top of this function compares against `LANGUAGE_VERSION`.
  // Asking the alias what version the author wrote is always answered "v2".
  const materializedStateFields = languageHasMaterializedStateFields(
    authoredOperations.languageVersion as Parameters<
      typeof languageHasMaterializedStateFields
    >[0],
  );
  for (const operation of packageRevision.operations) {
    if (
      operation.effect.kind === 'deleteRecordEffect' ||
      operation.effect.kind === 'purgeRecordEffect' ||
      operation.effect.kind === 'destroyRecordEffect'
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED',
          'wholeModelValidation',
          '$.operations.effect.kind',
          operation.operationId,
        ),
      );
    }
    // Honoured or refused, at every version -- ADR-0041's rule applied to the
    // construct that provoked it. Below v5 the state field is not an ordinary
    // field, so nothing can write it, no predicate can address it and no query
    // can select it; the effect compiles into a catalog the runtime cannot
    // admit. Refusing it HERE, by name and by subject, is what stops that
    // release from being built. Without this the failure surfaces at request
    // time as an anonymous `MalformedPinnedOperationCatalogError` that takes
    // every unrelated operation in the release down with it -- the ADR-0046
    // defect ADR-0050 §1 recorded.
    if (
      operation.effect.kind === 'transitionStateEffect' &&
      !materializedStateFields
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_TRANSITION_EFFECT_UNSUPPORTED',
          'wholeModelValidation',
          '$.operations.effect.kind',
          operation.operationId,
        ),
      );
    }
    // The language declares TWO permissions for a transition -- the
    // operation's and the transition's (`schemas.ts:634`) -- and execution
    // honours exactly one: the gateway authorizes `definition.permissionId`,
    // which is the operation's. A transition declaring `release_restricted`
    // under an operation declaring `edit_basic` would therefore execute on
    // `edit_basic`, and the declaration a reader trusts is the one ignored.
    // That is this packet's own defect class one field down, so it is refused
    // here rather than carried.
    //
    // EQUALITY, not a second runtime decision. `transitionStateEffect` holds
    // exactly one transition reference, so the two are 1:1 today and one
    // authorization is the whole truth. When an effect carries more than one
    // transition that stops being true -- and this rule fails loudly at that
    // moment, which is the trigger to revisit rather than a silent
    // generalization made in advance.
    if (
      operation.effect.kind === 'transitionStateEffect' &&
      'transition' in operation.effect
    ) {
      const carried = operation.effect.transition.targetId;
      const transition = packageRevision.stateMachines
        .flatMap((machine) => machine.transitions)
        .find((candidate) => candidate.transitionId === carried);
      if (
        transition &&
        transition.permission.targetId !== operation.permission.targetId
      ) {
        diagnostics.push(
          compilerDiagnostic(
            'COMPILER_TRANSITION_PERMISSION_MISMATCH',
            'wholeModelValidation',
            '$.operations.permission',
            operation.operationId,
          ),
        );
      }
    }
  }
  for (const field of packageRevision.fields) {
    if (
      field.classification === 'confidential' ||
      field.classification === 'restricted'
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'MODULE_CLASSIFICATION_UNSUPPORTED',
          'wholeModelValidation',
          '$.fields.classification',
          field.fieldId,
        ),
      );
    }
    if (
      isPinnedInventoryBaseUnitField(
        packageRevision.package.packageId,
        field.entity.targetId,
        field.fieldId,
      ) &&
      !activeTextFieldShapeMatches(field, 'required', 32)
    ) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.fields.item_base_unit',
          field.fieldId,
        ),
      );
    }
  }
  for (const query of packageRevision.queries) {
    if (
      query.queryType === 'resolve' &&
      (query.resolveMatchKeys?.length ?? 0) === 0
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_RESOLVE_MATCH_AUTHORITY_REQUIRED',
          'wholeModelValidation',
          '$.queries.resolveMatchKeys',
          query.queryId,
        ),
      );
    }
  }
  for (const surface of packageRevision.surfaces) {
    if (surface.renderer) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_RENDERER_FORM_UNSUPPORTED',
          'wholeModelValidation',
          '$.surfaces.renderer',
          surface.surfaceId,
        ),
      );
    }
  }

  const queryById = new Map(
    packageRevision.queries.map((query) => [query.queryId, query]),
  );
  const operationById = new Map(
    packageRevision.operations.map((operation) => [
      operation.operationId,
      operation,
    ]),
  );
  const assertedEntities = new Set<string>();
  for (const assertion of packageRevision.assertions.filter(
    (entry) => entry.lifecycle === 'active',
  )) {
    if (assertion.invocation.kind === 'queryInvocation') {
      const query = queryById.get(assertion.invocation.query.targetId);
      if (query) {
        assertedEntities.add(query.sourceEntity.targetId);
      }
    } else {
      const operation = operationById.get(
        assertion.invocation.operation.targetId,
      );
      if (operation && 'entity' in operation.effect) {
        assertedEntities.add(operation.effect.entity.targetId);
      }
    }
  }

  for (const entity of packageRevision.entities.filter(
    (entry) => entry.lifecycle === 'active',
  )) {
    const family = resolvePinnedLegalEntityFamily(
      packageRevision.package.packageId,
      entity.entityId,
    );
    const factStorage = resolvePinnedInventoryFactStorage(
      packageRevision.package.packageId,
      entity.entityId,
    );
    const providerWrittenReadModelRule =
      resolvePinnedInventoryProviderWrittenReadModel(
        packageRevision.package.packageId,
        entity.entityId,
      );
    const providerWrittenReadModel =
      providerWrittenReadModelRule &&
      qualifiedProviderWrittenReadModels.has(entity.entityId)
        ? providerWrittenReadModelRule
        : null;
    const periodLockStorage = resolvePinnedInventoryPeriodLockStorage(
      entity.entityId,
    );
    if (family.status === 'undeclared') {
      diagnostics.push(
        inventoryModuleDiagnostic(
          'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED',
          '$.entities.entityId',
          entity.entityId,
        ),
      );
    }
    const mapping = storageById.get(entity.storage.targetId);
    if (!mapping || mapping.lifecycle !== 'active') {
      missing(diagnostics, entity.entityId, 'storage');
    }

    const queryTypes = new Set(
      packageRevision.queries
        .filter(
          (query) =>
            query.lifecycle === 'active' &&
            query.tier === 'q0' &&
            query.sourceEntity.targetId === entity.entityId,
        )
        .map((query) => query.queryType),
    );
    for (const queryType of REQUIRED_QUERY_TYPES) {
      if (!queryTypes.has(queryType)) {
        missing(diagnostics, entity.entityId, `query.${queryType}`);
      }
    }

    const entityOperations = packageRevision.operations.filter(
      (operation) =>
        operation.lifecycle === 'active' &&
        operation.tier === 'o0' &&
        'entity' in operation.effect &&
        operation.effect.entity.targetId === entity.entityId,
    );
    const operationEffects = new Set(
      entityOperations.map((operation) => operation.effect.kind),
    );
    const authoredEntityOperations = providerWrittenReadModelRule
      ? packageRevision.operations.filter((operation) =>
          operationTargetsEntity(packageRevision, operation, entity.entityId),
        )
      : [];
    if (factStorage?.mutability === 'appendOnly' && operationEffects.size > 0) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED',
          'wholeModelValidation',
          '$.operations.effect.kind',
          entity.entityId,
        ),
      );
    }
    if (providerWrittenReadModelRule && authoredEntityOperations.length > 0) {
      diagnostics.push(
        compilerDiagnostic(
          'COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED',
          'wholeModelValidation',
          '$.operations.providerWritten',
          entity.entityId,
        ),
      );
    }
    for (const effect of REQUIRED_OPERATION_EFFECTS) {
      if (
        factStorage?.mutability !== 'appendOnly' &&
        !periodLockStorage &&
        !providerWrittenReadModel &&
        !operationEffects.has(effect)
      ) {
        missing(
          diagnostics,
          entity.entityId,
          `operation.${effect.replace('RecordEffect', '')}`,
        );
      }
    }
    if (periodLockStorage) {
      const requiredOperationIds = new Set<string>([
        `${packageRevision.package.namespace}:operation.${periodLockStorage.advanceOperationLocalId}`,
        `${packageRevision.package.namespace}:operation.${periodLockStorage.reopenOperationLocalId}`,
      ]);
      const observedOperationIds = new Set<string>(
        entityOperations.map((operation) => operation.operationId),
      );
      for (const operationId of requiredOperationIds) {
        if (!observedOperationIds.has(operationId)) {
          missing(diagnostics, entity.entityId, `operation.${operationId}`);
        }
      }
      if (
        entityOperations.length !== requiredOperationIds.size ||
        entityOperations.some(
          (operation) =>
            operation.effect.kind !== 'updateRecordEffect' ||
            !requiredOperationIds.has(operation.operationId),
        )
      ) {
        missing(diagnostics, entity.entityId, 'operation.periodLockLifecycle');
      }
      for (const [operationLocalId, permissionLocalId] of [
        [
          periodLockStorage.advanceOperationLocalId,
          periodLockStorage.advanceOperationLocalId,
        ],
        [
          periodLockStorage.reopenOperationLocalId,
          periodLockStorage.reopenOperationLocalId,
        ],
      ] as const) {
        const operationId = `${packageRevision.package.namespace}:operation.${operationLocalId}`;
        const permissionId = `${packageRevision.package.namespace}:permission.${permissionLocalId}`;
        const operation = entityOperations.find(
          (candidate) => candidate.operationId === operationId,
        );
        if (operation && operation.permission.targetId !== permissionId) {
          diagnostics.push(
            inventoryModuleDiagnostic(
              'INVENTORY_CONTRACT_INVALID',
              `$.operations.${operationLocalId}.permission`,
              operationId,
            ),
          );
        }
      }
    }

    const surfaceRoles = new Set(
      packageRevision.surfaces
        .filter((surface) => {
          if (surface.lifecycle !== 'active') return false;
          const query = queryById.get(surface.dataSource.targetId);
          return query?.sourceEntity.targetId === entity.entityId;
        })
        .map((surface) => surface.surfaceRole),
    );
    for (const role of REQUIRED_SURFACE_ROLES) {
      if (
        !(
          (factStorage?.mutability === 'appendOnly' ||
            periodLockStorage ||
            providerWrittenReadModel) &&
          role === 'form'
        ) &&
        !surfaceRoles.has(role)
      ) {
        missing(diagnostics, entity.entityId, `surface.${role}`);
      }
    }

    if (!assertedEntities.has(entity.entityId)) {
      missing(diagnostics, entity.entityId, 'verification.executableScenario');
    }

    if (family.status === 'classified') {
      const referenceRules = INVENTORY_STORAGE_REFERENCE_RULES.filter(
        (rule) => rule.sourceFamilyId === family.familyId,
      );
      const entityFields = packageRevision.fields.filter(
        (field) => field.entity.targetId === entity.entityId,
      );
      for (const rule of referenceRules) {
        const field = entityFields.find(
          (candidate) =>
            canonicalFieldLocalId(candidate.fieldId) === rule.fieldLocalId,
        );
        if (
          !field ||
          !activeTextFieldShapeMatches(
            field,
            rule.required ? 'required' : 'optional',
            80,
          )
        ) {
          diagnostics.push(
            inventoryModuleDiagnostic(
              'INVENTORY_CONTRACT_INVALID',
              `$.fields.${rule.fieldLocalId}`,
              `${packageRevision.package.namespace}:field.${rule.fieldLocalId}`,
            ),
          );
        }
      }
    }
  }
  for (const relation of packageRevision.relations) {
    const source = resolvePinnedLegalEntityFamily(
      packageRevision.package.packageId,
      relation.sourceEntity.targetId,
    );
    const target = resolvePinnedLegalEntityFamily(
      packageRevision.package.packageId,
      relation.targetEntity.targetId,
    );
    if (source.status === 'undeclared' || target.status === 'undeclared') {
      continue;
    }
    if (
      source.status === 'outsidePinnedContract' &&
      target.status === 'outsidePinnedContract'
    ) {
      continue;
    }
    if (
      source.status !== 'classified' ||
      target.status !== 'classified' ||
      resolvePinnedLegalEntityRelationSemantics(
        source.familyId,
        target.familyId,
      ) === null
    ) {
      diagnostics.push(
        inventoryModuleDiagnostic(
          'INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED',
          '$.relations',
          relation.relationId,
        ),
      );
    }
  }
  return diagnostics;
}

/**
 * Compiles the inventory posting protocol declaration independently of the
 * canonical application language. The result is canonical, content-addressed
 * release data; no runtime behavior or storage representation is emitted here.
 */
export function compileInventoryContract(
  definition: unknown,
  configuredValues: unknown = {},
): InventoryContractCompileResult {
  const diagnostics = validateInventoryContractDefinition(definition);
  if (diagnostics.length > 0 || !isRecord(definition)) {
    return failedInventoryContract(diagnostics);
  }

  const configurationResult = materializeInventoryConfiguration(
    definition,
    configuredValues,
  );
  if (configurationResult.diagnostics.length > 0) {
    return failedInventoryContract(configurationResult.diagnostics);
  }

  const release: InventoryContractReleaseRecordV1 = {
    capabilityId: definition.capabilityId as string,
    capabilityVersion: definition.capabilityVersion as number,
    configuration: configurationResult.configuration!,
    configurationScope: 'legalEntity',
    contract: definition,
    schemaVersion: INVENTORY_CONTRACT_RELEASE_VERSION,
  };

  try {
    const canonical = canonicalizeAndHash(release);
    const frozenRelease = deepFreeze(
      JSON.parse(canonical.text) as InventoryContractReleaseRecordV1,
    );
    return {
      diagnostics: [],
      release: {
        canonicalBytes: canonical.bytes,
        release: frozenRelease,
        releaseRoot: canonical.contentHash,
      },
      status: 'compiled',
    };
  } catch {
    return failedInventoryContract([
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$',
        typeof definition.capabilityId === 'string'
          ? definition.capabilityId
          : null,
      ),
    ]);
  }
}

/**
 * Conformance seam consumed by the later posting handler. It proves that v1
 * cannot accept an absent/unknown version or manufacture an `unspecified`
 * member for any launch dimension.
 */
export function validateInventoryMovementCandidate(
  compiled: CompiledInventoryContractV1,
  candidate: InventoryMovementCandidateV1,
): InventoryConformanceResult {
  const diagnostics: InventoryContractDiagnostic[] = [];
  const candidateRecord = candidate as unknown;
  if (!isRecord(candidateRecord)) {
    return inventoryConformanceResult([
      inventoryDiagnostic('INVENTORY_CONTRACT_INVALID', '$.movement', null),
    ]);
  }

  const allowedFields = new Set<string>(INVENTORY_MOVEMENT_CANDIDATE_FIELDS);
  for (const fieldId of Object.keys(candidateRecord)) {
    if (allowedFields.has(fieldId)) continue;
    diagnostics.push(
      inventoryDiagnostic(
        MOVEMENT_MONEY_TOKEN.test(fieldId)
          ? 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN'
          : 'INVENTORY_CONTRACT_INVALID',
        `$.movement.${fieldId}`,
        fieldId,
      ),
    );
  }

  for (const fieldId of [
    'movementId',
    'unitId',
    'effectiveAt',
    'recordedAt',
    'sourceType',
    'sourceId',
    'sourceLine',
  ]) {
    const value = candidateRecord[fieldId];
    if (typeof value !== 'string' || value.length === 0) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          `$.movement.${fieldId}`,
          fieldId,
        ),
      );
    }
  }

  if (
    typeof candidateRecord.quantityDelta !== 'string' ||
    !canonicalDecimalWithin(candidateRecord.quantityDelta, 38, 18)
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.movement.quantityDelta',
        'quantityDelta',
      ),
    );
  }
  if (
    typeof candidateRecord.postingRole !== 'string' ||
    !(INVENTORY_POSTING_ROLES as readonly string[]).includes(
      candidateRecord.postingRole,
    )
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.movement.postingRole',
        'postingRole',
      ),
    );
  }

  const stock = nestedRecord(compiled.release.contract, ['stockDimensionSet']);
  const v1 = stock ? nestedRecord(stock, ['v1']) : undefined;
  const allowedVersions = v1?.allowedVersions;
  const dimensions = stock?.dimensions;
  const version = candidateRecord.stockDimensionSetVersion;

  if (typeof version !== 'string' || version.length === 0) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED',
        '$.movement.stockDimensionSetVersion',
        null,
      ),
    );
  } else if (
    !Array.isArray(allowedVersions) ||
    !allowedVersions.includes(version)
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN',
        '$.movement.stockDimensionSetVersion',
        version,
      ),
    );
  }

  if (Array.isArray(dimensions)) {
    for (const dimension of dimensions) {
      if (typeof dimension !== 'string') continue;
      const value =
        isRecord(candidateRecord.stockIdentity) &&
        candidateRecord.stockIdentity[dimension];
      if (typeof value !== 'string' || value.length === 0) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_STOCK_DIMENSION_MEMBER_REQUIRED',
            `$.movement.stockIdentity.${dimension}`,
            dimension,
          ),
        );
      } else if (
        value === 'unspecified' ||
        value.endsWith('.unspecified') ||
        value.endsWith(':unspecified')
      ) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN',
            `$.movement.stockIdentity.${dimension}`,
            value,
          ),
        );
      }
    }
  }

  if (isRecord(candidateRecord.stockIdentity)) {
    const dimensionNames = new Set(
      Array.isArray(dimensions)
        ? dimensions.filter(
            (dimension): dimension is string => typeof dimension === 'string',
          )
        : [],
    );
    for (const fieldId of Object.keys(candidateRecord.stockIdentity)) {
      if (dimensionNames.has(fieldId)) continue;
      diagnostics.push(
        inventoryDiagnostic(
          MOVEMENT_MONEY_TOKEN.test(fieldId)
            ? 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN'
            : 'INVENTORY_CONTRACT_INVALID',
          `$.movement.stockIdentity.${fieldId}`,
          fieldId,
        ),
      );
    }
  }

  return inventoryConformanceResult(diagnostics);
}

/**
 * Pure operation-contract check: a changed unit is admissible only before any
 * movement binds the item. The rejection carries the exact binding movement.
 */
export function validateInventoryBaseUnitChange(
  compiled: CompiledInventoryContractV1,
  attempt: InventoryBaseUnitChangeAttemptV1,
): InventoryConformanceResult {
  if (
    attempt.currentBaseUnitId === attempt.requestedBaseUnitId ||
    attempt.bindingMovementId === null
  ) {
    return { diagnostics: [], status: 'accepted' };
  }

  const baseUnit = nestedRecord(compiled.release.contract, ['baseUnit']);
  if (baseUnit?.changeWhenBound !== 'reject') {
    return inventoryConformanceResult([
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.baseUnit.changeWhenBound',
        attempt.itemId,
      ),
    ]);
  }

  return inventoryConformanceResult([
    inventoryDiagnostic(
      'INVENTORY_BASE_UNIT_IMMUTABLE',
      '$.item.baseUnitId',
      attempt.itemId,
      attempt.bindingMovementId,
    ),
  ]);
}

function validateInventoryContractDefinition(
  definition: unknown,
): InventoryContractDiagnostic[] {
  const diagnostics: InventoryContractDiagnostic[] = [];
  if (!isRecord(definition)) {
    return [inventoryDiagnostic('INVENTORY_CONTRACT_INVALID', '$', null)];
  }

  expectInventoryLiteral(
    diagnostics,
    definition,
    ['schemaVersion'],
    INVENTORY_CONTRACT_SCHEMA_VERSION,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['capabilityId'],
    'northstar.inventory:capability.posting',
  );
  expectInventoryLiteral(diagnostics, definition, ['capabilityVersion'], 1);

  validateLegalEntityContract(diagnostics, definition);
  validateProviderWrittenReadModelContract(diagnostics, definition);
  validateStockDimensionSet(diagnostics, definition);
  validateMovementContract(diagnostics, definition);
  validateCountEvidenceContract(diagnostics, definition);
  validateBaseUnitContract(diagnostics, definition);
  validateTemporalContract(diagnostics, definition);
  validateMonetaryBoundary(diagnostics, definition);
  validateAuthoritativeDependencies(diagnostics, definition);
  validateInventoryConfigurationDeclaration(diagnostics, definition);
  validateSameInstantRule(diagnostics, definition);
  validateV2DecimalLimit(diagnostics, definition);

  return sortInventoryDiagnostics(diagnostics);
}

function validateProviderWrittenReadModelContract(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['readModels', 'authoredOperations'],
    'forbidden',
  );
  const readModels = nestedRecord(definition, ['readModels']);
  if (
    !readModels ||
    !hasExactKeys(readModels, ['authoredOperations', 'providerWritten'])
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.readModels',
        'providerWritten',
      ),
    );
    return;
  }
  const rules = readModels.providerWritten;
  if (!Array.isArray(rules)) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.readModels.providerWritten',
        null,
      ),
    );
    return;
  }
  const observed = new Set<string>();
  for (const rule of rules) {
    if (
      !isRecord(rule) ||
      !hasExactKeys(rule, ['classification', 'familyId', 'maintainerId']) ||
      rule.classification !== 'providerWritten' ||
      typeof rule.familyId !== 'string' ||
      typeof rule.maintainerId !== 'string' ||
      rule.maintainerId.length === 0 ||
      observed.has(rule.familyId)
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.readModels.providerWritten',
          isRecord(rule) && typeof rule.familyId === 'string'
            ? rule.familyId
            : null,
        ),
      );
      continue;
    }
    observed.add(rule.familyId);
  }
  for (const expected of INVENTORY_PROVIDER_WRITTEN_READ_MODEL_RULES) {
    const rule = rules.find(
      (candidate) =>
        isRecord(candidate) && candidate.familyId === expected.familyId,
    );
    if (
      !isRecord(rule) ||
      rule.classification !== expected.classification ||
      rule.maintainerId !== expected.maintainerId
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          `$.readModels.providerWritten.${expected.familyId}`,
          expected.familyId,
        ),
      );
    }
  }
  for (const familyId of observed) {
    if (
      !INVENTORY_PROVIDER_WRITTEN_READ_MODEL_RULES.some(
        (rule) => rule.familyId === familyId,
      )
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          `$.readModels.providerWritten.${familyId}`,
          familyId,
        ),
      );
    }
  }
  if (
    rules.length === INVENTORY_PROVIDER_WRITTEN_READ_MODEL_RULES.length &&
    !rules.every(
      (rule, index) =>
        isRecord(rule) &&
        rule.familyId ===
          INVENTORY_PROVIDER_WRITTEN_READ_MODEL_RULES[index]?.familyId,
    )
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.readModels.providerWritten',
        'canonicalOrder',
      ),
    );
  }
}

function validateCountEvidenceContract(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  const countEvidence = nestedRecord(definition, ['countEvidence']);
  const expectations: Array<[readonly string[], string]> = [
    [['countEvidence', 'correctionBehavior'], 'appendCompensatingCount'],
    [['countEvidence', 'hardDelete'], 'forbidden'],
    [['countEvidence', 'lineEntityFamilyId'], 'stock_count_line'],
    [
      ['countEvidence', 'movementLink'],
      'stockCountLineToTransactionLineToInventoryMovement',
    ],
    [['countEvidence', 'preservation'], 'threeDistinctPersistedValues'],
    [['countEvidence', 'reversalBehavior'], 'appendExactInverseMovement'],
    [['countEvidence', 'sessionEntityFamilyId'], 'stock_count'],
    [['countEvidence', 'sessionTransition'], 'reviewedToPostedWithMovement'],
  ];
  for (const [path, value] of expectations) {
    expectInventoryLiteral(diagnostics, definition, path, value);
  }
  if (
    !countEvidence ||
    !hasExactKeys(countEvidence, [
      'correctionBehavior',
      'hardDelete',
      'lineEntityFamilyId',
      'lineValues',
      'movementLink',
      'preservation',
      'reversalBehavior',
      'sessionEntityFamilyId',
      'sessionTransition',
    ])
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_COUNT_EVIDENCE_INVALID',
        '$.countEvidence',
        'countEvidence',
      ),
    );
  }

  const lineValues = countEvidence?.lineValues;
  const expectedValues = [
    ['expectedQuantity', 'expectedPhysicalQuantity'],
    ['countedQuantity', 'countedPhysicalQuantity'],
    ['varianceQuantity', 'countedMinusExpectedVariance'],
  ] as const;
  if (
    !Array.isArray(lineValues) ||
    lineValues.length !== expectedValues.length
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_COUNT_EVIDENCE_INVALID',
        '$.countEvidence.lineValues',
        null,
      ),
    );
  } else {
    for (const [index, [fieldId, semantic]] of expectedValues.entries()) {
      const value = lineValues[index];
      const shape = isRecord(value) ? value.valueShape : undefined;
      if (
        !isRecord(value) ||
        !hasExactKeys(value, [
          'fieldId',
          'presence',
          'semantic',
          'valueShape',
        ]) ||
        value.fieldId !== fieldId ||
        value.presence !== 'required' ||
        value.semantic !== semantic ||
        !isRecord(shape) ||
        !hasExactKeys(shape, [
          'precision',
          'representation',
          'scale',
          'signed',
          'unitFieldId',
        ]) ||
        shape.precision !== 38 ||
        shape.representation !== 'canonicalDecimalStringV2' ||
        shape.scale !== 18 ||
        shape.signed !== true ||
        shape.unitFieldId !== 'unitId'
      ) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_COUNT_EVIDENCE_INVALID',
            `$.countEvidence.lineValues.${index}`,
            fieldId,
          ),
        );
      }
    }
  }

  const inspect = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (COUNT_EVIDENCE_MONEY_TOKEN.test(value)) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_COUNT_EVIDENCE_MONEY_FORBIDDEN',
            path,
            value,
          ),
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, `${path}.${index}`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (COUNT_EVIDENCE_MONEY_TOKEN.test(key)) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_COUNT_EVIDENCE_MONEY_FORBIDDEN',
            `${path}.${key}`,
            key,
          ),
        );
      }
      inspect(entry, `${path}.${key}`);
    }
  };
  inspect(countEvidence, '$.countEvidence');
}

function validateLegalEntityContract(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['legalEntity', 'version'],
    LEGAL_ENTITY_FAMILY_CONTRACT_VERSION,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['legalEntity', 'undeclaredFamily', 'diagnosticCode'],
    'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['legalEntity', 'undeclaredFamily', 'disposition'],
    'compileFailure',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['legalEntity', 'undeclaredRelation', 'diagnosticCode'],
    'INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['legalEntity', 'undeclaredRelation', 'disposition'],
    'compileFailure',
  );

  const legalEntity = nestedRecord(definition, ['legalEntity']);
  if (
    !legalEntity ||
    !hasExactKeys(legalEntity, [
      'families',
      'relations',
      'undeclaredFamily',
      'undeclaredRelation',
      'version',
    ])
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.legalEntity',
        'legalEntity',
      ),
    );
  }
  for (const key of ['undeclaredFamily', 'undeclaredRelation'] as const) {
    const declaration = legalEntity ? nestedRecord(legalEntity, [key]) : null;
    if (
      !declaration ||
      !hasExactKeys(declaration, ['diagnosticCode', 'disposition'])
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          `$.legalEntity.${key}`,
          key,
        ),
      );
    }
  }
  const families = legalEntity?.families;
  if (!Array.isArray(families)) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED',
        '$.legalEntity.families',
        null,
      ),
    );
  } else {
    const observed = new Set<string>();
    for (const rule of families) {
      if (
        !isRecord(rule) ||
        !hasExactKeys(rule, ['classification', 'familyId']) ||
        typeof rule.familyId !== 'string' ||
        !['entityOwned', 'tenantShared'].includes(
          typeof rule.classification === 'string' ? rule.classification : '',
        ) ||
        observed.has(rule.familyId)
      ) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_CONTRACT_INVALID',
            '$.legalEntity.families',
            isRecord(rule) && typeof rule.familyId === 'string'
              ? rule.familyId
              : null,
          ),
        );
        continue;
      }
      observed.add(rule.familyId);
    }
    for (const expected of LEGAL_ENTITY_FAMILY_RULES) {
      const rule = families.find(
        (candidate) =>
          isRecord(candidate) && candidate.familyId === expected.familyId,
      );
      if (!rule) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED',
            `$.legalEntity.families.${expected.familyId}`,
            expected.familyId,
          ),
        );
      } else if (rule.classification !== expected.classification) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_CONTRACT_INVALID',
            `$.legalEntity.families.${expected.familyId}.classification`,
            expected.familyId,
          ),
        );
      }
    }
    for (const familyId of observed) {
      if (
        !LEGAL_ENTITY_FAMILY_RULES.some((rule) => rule.familyId === familyId)
      ) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_CONTRACT_INVALID',
            `$.legalEntity.families.${familyId}`,
            familyId,
          ),
        );
      }
    }
    if (
      families.length === LEGAL_ENTITY_FAMILY_RULES.length &&
      !families.every(
        (rule, index) =>
          isRecord(rule) &&
          rule.familyId === LEGAL_ENTITY_FAMILY_RULES[index]?.familyId &&
          rule.classification ===
            LEGAL_ENTITY_FAMILY_RULES[index]?.classification,
      )
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.legalEntity.families',
          'order',
        ),
      );
    }
  }

  const relations = legalEntity?.relations;
  if (!Array.isArray(relations)) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED',
        '$.legalEntity.relations',
        null,
      ),
    );
    return;
  }
  const observedRelations = new Set<string>();
  for (const rule of relations) {
    const key = legalEntityRelationKey(rule);
    if (
      key === null ||
      !isRecord(rule) ||
      !hasExactKeys(rule, ['semantics', 'sourceFamilyId', 'targetFamilyId']) ||
      observedRelations.has(key)
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.legalEntity.relations',
          key,
        ),
      );
      continue;
    }
    observedRelations.add(key);
  }
  for (const expected of LEGAL_ENTITY_RELATION_RULES) {
    const key = `${expected.sourceFamilyId}->${expected.targetFamilyId}`;
    const rule = relations.find(
      (candidate) => legalEntityRelationKey(candidate) === key,
    );
    if (!rule) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED',
          `$.legalEntity.relations.${key}`,
          key,
        ),
      );
    } else if (isRecord(rule) && rule.semantics !== expected.semantics) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          `$.legalEntity.relations.${key}.semantics`,
          key,
        ),
      );
    }
  }
  for (const key of observedRelations) {
    if (
      !LEGAL_ENTITY_RELATION_RULES.some(
        (rule) => `${rule.sourceFamilyId}->${rule.targetFamilyId}` === key,
      )
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          `$.legalEntity.relations.${key}`,
          key,
        ),
      );
    }
  }
  if (
    relations.length === LEGAL_ENTITY_RELATION_RULES.length &&
    !relations.every((rule, index) => {
      const expected = LEGAL_ENTITY_RELATION_RULES[index];
      return (
        expected !== undefined &&
        isRecord(rule) &&
        rule.sourceFamilyId === expected.sourceFamilyId &&
        rule.targetFamilyId === expected.targetFamilyId &&
        rule.semantics === expected.semantics
      );
    })
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.legalEntity.relations',
        'order',
      ),
    );
  }
}

function validateStockDimensionSet(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'setId'],
    STOCK_DIMENSION_SET_ID,
  );
  expectInventoryStringArray(
    diagnostics,
    definition,
    ['stockDimensionSet', 'dimensions'],
    ['legalEntityId', 'itemId', 'locationId'],
  );
  expectInventoryStringArray(
    diagnostics,
    definition,
    ['stockDimensionSet', 'v1', 'allowedVersions'],
    ['v1'],
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'v1', 'membersRequiredAtPosting'],
    true,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'v1', 'unspecifiedMembers'],
    'structurallyUnreachable',
    'INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'extension', 'addition'],
    'governedVersionedEvent',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'extension', 'reBaselineOperationId'],
    'northstar.inventory:operation.re_baseline',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'extension', 'removal'],
    'unsupported',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['stockDimensionSet', 'extension', 'unspecifiedFromVersion'],
    2,
  );
}

function validateMovementContract(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['movement', 'kind'],
    'quantityOnlyMovement',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['movement', 'updatePath'],
    'none',
  );
  const movement = nestedRecord(definition, ['movement']);
  const fields = movement?.fields;
  if (!Array.isArray(fields)) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.movement.fields',
        'northstar.inventory:capability.posting',
      ),
    );
    return;
  }

  const expected = new Map<string, string>([
    ['movementId', 'identifier'],
    ['stockDimensionSetVersion', 'stockDimensionSetVersion'],
    ['quantityDelta', 'quantity'],
    ['unitId', 'unit'],
    ['effectiveAt', 'instant'],
    ['recordedAt', 'instant'],
    ['sourceType', 'sourceType'],
    ['sourceId', 'identifier'],
    ['sourceLine', 'sourceLine'],
    ['postingRole', 'postingRole'],
  ]);
  const seen = new Set<string>();

  for (const field of fields) {
    if (!isRecord(field) || typeof field.fieldId !== 'string') {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.movement.fields',
          null,
        ),
      );
      continue;
    }
    const path = `$.movement.fields.${field.fieldId}`;
    const semantic = typeof field.semantic === 'string' ? field.semantic : '';
    const shape = isRecord(field.valueShape) ? field.valueShape : undefined;
    if (
      /(?:amount|money|value|cost|price|currency)/iu.test(field.fieldId) ||
      /(?:amount|money|monetaryValue|cost|price|currency)/iu.test(semantic) ||
      shape?.kind === 'moneyFieldType'
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_MOVEMENT_MONEY_FORBIDDEN',
          path,
          field.fieldId,
        ),
      );
      continue;
    }
    if (
      !expected.has(field.fieldId) ||
      expected.get(field.fieldId) !== semantic ||
      field.immutable !== true ||
      field.presence !== 'required' ||
      seen.has(field.fieldId)
    ) {
      diagnostics.push(
        inventoryDiagnostic('INVENTORY_CONTRACT_INVALID', path, field.fieldId),
      );
      continue;
    }
    seen.add(field.fieldId);
  }

  for (const fieldId of expected.keys()) {
    if (!seen.has(fieldId)) {
      diagnostics.push(
        inventoryDiagnostic(
          fieldId === 'stockDimensionSetVersion'
            ? 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED'
            : 'INVENTORY_CONTRACT_INVALID',
          `$.movement.fields.${fieldId}`,
          fieldId,
        ),
      );
    }
  }

  const versionField = fields.find(
    (field) => isRecord(field) && field.fieldId === 'stockDimensionSetVersion',
  );
  const versionShape =
    isRecord(versionField) && isRecord(versionField.valueShape)
      ? versionField.valueShape
      : undefined;
  if (!sameStringArray(versionShape?.allowedValues, ['v1'])) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN',
        '$.movement.fields.stockDimensionSetVersion.valueShape.allowedValues',
        null,
      ),
    );
  }

  const quantityField = fields.find(
    (field) => isRecord(field) && field.fieldId === 'quantityDelta',
  );
  const quantityShape =
    isRecord(quantityField) && isRecord(quantityField.valueShape)
      ? quantityField.valueShape
      : undefined;
  const exactQuantityShape =
    quantityShape?.precision === 38 &&
    quantityShape.scale === 18 &&
    quantityShape.signed === true &&
    quantityShape.representation === 'canonicalDecimalStringV2' &&
    quantityShape.unitFieldId === 'unitId';
  if (!exactQuantityShape) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.movement.fields.quantityDelta.valueShape',
        'quantityDelta',
      ),
    );
  }
}

function validateBaseUnitContract(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  const expectations: Array<[readonly string[], string]> = [
    [['baseUnit', 'bindingFact'], 'firstPostedMovement'],
    [['baseUnit', 'changeWhenBound'], 'reject'],
    [['baseUnit', 'diagnostic', 'bindingMovementField'], 'movementId'],
    [['baseUnit', 'diagnostic', 'code'], 'INVENTORY_BASE_UNIT_IMMUTABLE'],
    [['baseUnit', 'operationContract'], 'namedBaseUnitChange'],
  ];
  for (const [path, value] of expectations) {
    expectInventoryLiteral(diagnostics, definition, path, value);
  }
  const itemFieldId = nestedValue(definition, ['baseUnit', 'itemFieldId']);
  if (
    typeof itemFieldId !== 'string' ||
    !itemFieldId.endsWith(':field.item_base_unit')
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.baseUnit.itemFieldId',
        typeof itemFieldId === 'string' ? itemFieldId : null,
      ),
    );
  }
}

function validateTemporalContract(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  const expectations: Array<[readonly string[], string | boolean]> = [
    [['temporal', 'effectiveAt', 'source'], 'operationInput'],
    [['temporal', 'recordedAt', 'source'], 'trustedRequestContext'],
    [['temporal', 'recordedAt', 'updatePath'], 'none'],
    [['temporal', 'recordedAt', 'projectionRetention'], 'required'],
    [
      ['temporal', 'businessCalendar', 'timeZone'],
      'tenantDeclaredIanaRequired',
    ],
    [
      ['temporal', 'businessCalendar', 'businessDayBoundary'],
      'tenantDeclaredRequired',
    ],
    [['temporal', 'businessCalendar', 'utcDefault'], 'forbidden'],
    [['temporal', 'periodLock', 'closedThroughScope'], 'legalEntity'],
    [['temporal', 'periodLock', 'enforcement'], 'insidePostingTransaction'],
    [
      ['temporal', 'periodLock', 'advance', 'operationId'],
      'northstar.inventory:operation.advance_period_lock',
    ],
    [
      ['temporal', 'periodLock', 'advance', 'permissionId'],
      'northstar.inventory:permission.advance_period_lock',
    ],
    [['temporal', 'periodLock', 'advance', 'audited'], true],
    [
      ['temporal', 'periodLock', 'reopen', 'operationId'],
      'northstar.inventory:operation.reopen_period',
    ],
    [
      ['temporal', 'periodLock', 'reopen', 'permissionId'],
      'northstar.inventory:permission.reopen_period',
    ],
    [['temporal', 'periodLock', 'reopen', 'audited'], true],
  ];
  for (const [path, value] of expectations) {
    expectInventoryLiteral(diagnostics, definition, path, value);
  }
}

function validateMonetaryBoundary(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  const expectations: Array<[readonly string[], string]> = [
    [['monetaryBoundary', 'countEvidenceMonetaryFields'], 'forbidden'],
    [['monetaryBoundary', 'movementAmountFields'], 'forbidden'],
    [
      ['monetaryBoundary', 'movementDerivedMonetaryArtifacts'],
      'compileFailure',
    ],
    [['monetaryBoundary', 'receiptCostOwner'], 'G4'],
    [['monetaryBoundary', 'valuationCapability'], 'unsupported'],
  ];
  for (const [path, value] of expectations) {
    expectInventoryLiteral(diagnostics, definition, path, value);
  }

  const artifacts = definition.compiledArtifacts;
  if (!Array.isArray(artifacts)) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.compiledArtifacts',
        null,
      ),
    );
    return;
  }
  const artifactIds = new Set<string>();
  for (const artifact of artifacts) {
    if (
      !isRecord(artifact) ||
      !hasExactKeys(artifact, ['artifactId', 'outputSemantic', 'source'])
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.compiledArtifacts',
          isRecord(artifact) && typeof artifact.artifactId === 'string'
            ? artifact.artifactId
            : null,
        ),
      );
      continue;
    }

    const artifactId = artifact.artifactId;
    const output = artifact.outputSemantic;
    if (
      typeof artifactId !== 'string' ||
      artifactId.length === 0 ||
      artifactIds.has(artifactId) ||
      artifact.source !== 'inventoryMovement' ||
      typeof output !== 'string'
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.compiledArtifacts',
          typeof artifactId === 'string' ? artifactId : null,
        ),
      );
      continue;
    }
    artifactIds.add(artifactId);

    if (MOVEMENT_MONEY_TOKEN.test(output)) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_MOVEMENT_VALUE_DERIVATION_FORBIDDEN',
          '$.compiledArtifacts.outputSemantic',
          artifactId,
        ),
      );
    } else if (!['fact', 'quantity', 'time', 'text'].includes(output)) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.compiledArtifacts.outputSemantic',
          artifactId,
        ),
      );
    }
  }
}

function validateAuthoritativeDependencies(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['authoritativeDependencies', 'version'],
    4,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['authoritativeDependencies', 'exhaustiveByConstruction'],
    true,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['authoritativeDependencies', 'undeclaredAccess'],
    'compileFailure',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['authoritativeDependencies', 'dependencySetRoot'],
    INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  );
  const dependencyContract = nestedRecord(definition, [
    'authoritativeDependencies',
  ]);
  const dependencies = dependencyContract?.dependencies;
  const accessPlan = dependencyContract?.accessPlan;
  if (!Array.isArray(dependencies) || !Array.isArray(accessPlan)) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONTRACT_INVALID',
        '$.authoritativeDependencies',
        'northstar.inventory:capability.posting',
      ),
    );
    return;
  }

  for (const [name, entries] of [
    ['dependencies', dependencies],
    ['accessPlan', accessPlan],
  ] as const) {
    if (
      inventoryCanonicalRoot(entries) !== INVENTORY_POSTING_DEPENDENCY_SET_ROOT
    ) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          `$.authoritativeDependencies.${name}`,
          name,
        ),
      );
    }
  }

  const declared = new Set<string>();
  for (const entry of dependencies) {
    const key = inventoryDependencyKey(entry);
    if (key === null || declared.has(key)) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONTRACT_INVALID',
          '$.authoritativeDependencies.dependencies',
          isRecord(entry) && typeof entry.dependencyId === 'string'
            ? entry.dependencyId
            : null,
        ),
      );
      continue;
    }
    declared.add(key);
  }

  for (const entry of accessPlan) {
    const key = inventoryDependencyKey(entry);
    if (key !== null && declared.has(key)) continue;
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_POSTING_DEPENDENCY_UNDECLARED',
        '$.authoritativeDependencies.accessPlan',
        isRecord(entry) && typeof entry.dependencyId === 'string'
          ? entry.dependencyId
          : null,
      ),
    );
  }
}

function validateInventoryConfigurationDeclaration(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  const configuration = nestedRecord(definition, ['configuration']);
  if (configuration) {
    for (const key of Object.keys(configuration)) {
      if (
        ![
          'dials',
          'scope',
          'scopeRationale',
          'valuesAreReleaseRecorded',
          'version',
        ].includes(key)
      ) {
        diagnostics.push(
          inventoryDiagnostic(
            'INVENTORY_CONFIGURATION_MALFORMED',
            `$.configuration.${key}`,
            key,
          ),
        );
      }
    }
  }
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'scope'],
    'legalEntity',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'valuesAreReleaseRecorded'],
    true,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'version'],
    1,
  );
  const scopeRationale = nestedValue(definition, [
    'configuration',
    'scopeRationale',
  ]);
  if (typeof scopeRationale !== 'string' || scopeRationale.length === 0) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONFIGURATION_REQUIRED',
        '$.configuration.scopeRationale',
        'scopeRationale',
      ),
    );
  }
  const dials = nestedRecord(definition, ['configuration', 'dials']);
  const requiredDials = [
    'negativeStock',
    'reasonRequirements',
    'approvalThresholds',
    'maximumBackdateDays',
  ];
  for (const dialName of requiredDials) {
    if (!dials || !Object.hasOwn(dials, dialName)) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONFIGURATION_REQUIRED',
          `$.configuration.dials.${dialName}`,
          dialName,
        ),
      );
    }
  }
  if (!dials) return;

  for (const dialName of Object.keys(dials)) {
    if (requiredDials.includes(dialName)) continue;
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONFIGURATION_MALFORMED',
        `$.configuration.dials.${dialName}`,
        dialName,
      ),
    );
  }

  const dialKeys: Readonly<Record<string, readonly string[]>> = {
    approvalThresholds: [
      'comparison',
      'default',
      'exactBaseUnit',
      'kind',
      'precision',
      'scale',
    ],
    maximumBackdateDays: ['default', 'kind', 'maximum', 'minimum'],
    negativeStock: ['default', 'evaluation', 'kind', 'values'],
    reasonRequirements: ['default', 'kind'],
  };
  for (const dialName of requiredDials) {
    const dial = nestedRecord(dials, [dialName]);
    if (!dial) continue;
    for (const key of Object.keys(dial)) {
      if (dialKeys[dialName]?.includes(key)) continue;
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONFIGURATION_MALFORMED',
          `$.configuration.dials.${dialName}.${key}`,
          key,
        ),
      );
    }
  }

  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'negativeStock', 'kind'],
    'enum',
  );
  expectInventoryStringArray(
    diagnostics,
    definition,
    ['configuration', 'dials', 'negativeStock', 'values'],
    NEGATIVE_STOCK_MODES,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'negativeStock', 'default'],
    'reject',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'negativeStock', 'evaluation'],
    'insidePostingTransactionAgainstSerializedState',
  );

  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'reasonRequirements', 'kind'],
    'postingRoleReasonMap',
  );
  const reasonDefaults = nestedValue(definition, [
    'configuration',
    'dials',
    'reasonRequirements',
    'default',
  ]);
  validateReasonMap(
    diagnostics,
    reasonDefaults,
    '$.configuration.dials.reasonRequirements.default',
    'INVENTORY_CONFIGURATION_REQUIRED',
  );

  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'approvalThresholds', 'kind'],
    'postingRoleExactQuantityMap',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'approvalThresholds', 'exactBaseUnit'],
    true,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'approvalThresholds', 'precision'],
    38,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'approvalThresholds', 'scale'],
    18,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'approvalThresholds', 'comparison'],
    'absoluteQuantityGreaterThan',
  );
  const thresholdDefaults = nestedValue(definition, [
    'configuration',
    'dials',
    'approvalThresholds',
    'default',
  ]);
  validateApprovalMap(
    diagnostics,
    thresholdDefaults,
    '$.configuration.dials.approvalThresholds.default',
    'INVENTORY_CONFIGURATION_REQUIRED',
  );

  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'maximumBackdateDays', 'kind'],
    'integer',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'maximumBackdateDays', 'minimum'],
    0,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'maximumBackdateDays', 'maximum'],
    3650,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['configuration', 'dials', 'maximumBackdateDays', 'default'],
    0,
  );
}

function validateSameInstantRule(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['sameInstantTieBreak', 'scope'],
    'global',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['sameInstantTieBreak', 'configurable'],
    false,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['sameInstantTieBreak', 'rule'],
    'ascendingCanonicalValueOrder',
  );
  expectInventoryStringArray(
    diagnostics,
    definition,
    ['sameInstantTieBreak', 'ordering'],
    [
      'effectiveAt',
      'recordedAt',
      'sourceType',
      'sourceId',
      'sourceLine',
      'postingRole',
      'movementId',
    ],
  );
}

function validateV2DecimalLimit(
  diagnostics: InventoryContractDiagnostic[],
  definition: Record<string, unknown>,
): void {
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['v2DecimalLimit', 'canonicalPattern'],
    '^(?:0|-[1-9]\\d*|[1-9]\\d*)(?:\\.\\d*[1-9])?$',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['v2DecimalLimit', 'fieldShapePermitted'],
    true,
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['v2DecimalLimit', 'signedSubUnitExample'],
    '-0.25',
  );
  expectInventoryLiteral(
    diagnostics,
    definition,
    ['v2DecimalLimit', 'signedSubUnitValues'],
    'inexpressibleUntilV3',
  );
}

function materializeInventoryConfiguration(
  definition: Record<string, unknown>,
  configuredValues: unknown,
): {
  configuration: InventoryPostingConfigurationV1 | null;
  diagnostics: InventoryContractDiagnostic[];
} {
  if (!isRecord(configuredValues)) {
    return {
      configuration: null,
      diagnostics: [
        inventoryDiagnostic(
          'INVENTORY_CONFIGURATION_MALFORMED',
          '$.configuration.values',
          null,
        ),
      ],
    };
  }

  const diagnostics: InventoryContractDiagnostic[] = [];
  const allowedKeys = new Set([
    'approvalThresholds',
    'maximumBackdateDays',
    'negativeStock',
    'reasonRequirements',
  ]);
  for (const key of Object.keys(configuredValues)) {
    if (!allowedKeys.has(key)) {
      diagnostics.push(
        inventoryDiagnostic(
          'INVENTORY_CONFIGURATION_MALFORMED',
          `$.configuration.values.${key}`,
          key,
        ),
      );
    }
  }

  const dials = nestedRecord(definition, ['configuration', 'dials'])!;
  const negativeStockDial = nestedRecord(dials, ['negativeStock'])!;
  const backdateDial = nestedRecord(dials, ['maximumBackdateDays'])!;
  const reasonDial = nestedRecord(dials, ['reasonRequirements'])!;
  const approvalDial = nestedRecord(dials, ['approvalThresholds'])!;

  const negativeStock = Object.hasOwn(configuredValues, 'negativeStock')
    ? configuredValues.negativeStock
    : negativeStockDial.default;
  if (
    typeof negativeStock !== 'string' ||
    !(NEGATIVE_STOCK_MODES as readonly string[]).includes(negativeStock)
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONFIGURATION_MALFORMED',
        '$.configuration.values.negativeStock',
        typeof negativeStock === 'string' ? negativeStock : null,
      ),
    );
  }

  const maximumBackdateDays = Object.hasOwn(
    configuredValues,
    'maximumBackdateDays',
  )
    ? configuredValues.maximumBackdateDays
    : backdateDial.default;
  if (
    typeof maximumBackdateDays !== 'number' ||
    !Number.isSafeInteger(maximumBackdateDays) ||
    maximumBackdateDays < Number(backdateDial.minimum) ||
    maximumBackdateDays > Number(backdateDial.maximum)
  ) {
    diagnostics.push(
      inventoryDiagnostic(
        'INVENTORY_CONFIGURATION_OUT_OF_RANGE',
        '$.configuration.values.maximumBackdateDays',
        typeof maximumBackdateDays === 'number'
          ? String(maximumBackdateDays)
          : null,
      ),
    );
  }

  const reasonRequirements = Object.hasOwn(
    configuredValues,
    'reasonRequirements',
  )
    ? configuredValues.reasonRequirements
    : reasonDial.default;
  validateReasonMap(
    diagnostics,
    reasonRequirements,
    '$.configuration.values.reasonRequirements',
    'INVENTORY_CONFIGURATION_MALFORMED',
  );

  const approvalThresholds = Object.hasOwn(
    configuredValues,
    'approvalThresholds',
  )
    ? configuredValues.approvalThresholds
    : approvalDial.default;
  validateApprovalMap(
    diagnostics,
    approvalThresholds,
    '$.configuration.values.approvalThresholds',
    'INVENTORY_CONFIGURATION_OUT_OF_RANGE',
  );

  if (diagnostics.length > 0) {
    return {
      configuration: null,
      diagnostics: sortInventoryDiagnostics(diagnostics),
    };
  }
  return {
    configuration: {
      approvalThresholds: approvalThresholds as Record<
        InventoryPostingRole,
        string | null
      >,
      maximumBackdateDays: maximumBackdateDays as number,
      negativeStock: negativeStock as NegativeStockMode,
      reasonRequirements: reasonRequirements as Record<
        InventoryPostingRole,
        ReasonRequirement
      >,
    },
    diagnostics: [],
  };
}

function validateReasonMap(
  diagnostics: InventoryContractDiagnostic[],
  value: unknown,
  path: string,
  code: InventoryContractDiagnosticCode,
): void {
  if (!isRecord(value) || !hasExactKeys(value, INVENTORY_POSTING_ROLES)) {
    diagnostics.push(inventoryDiagnostic(code, path, null));
    return;
  }
  for (const role of INVENTORY_POSTING_ROLES) {
    if (!(REASON_REQUIREMENTS as readonly unknown[]).includes(value[role])) {
      diagnostics.push(inventoryDiagnostic(code, `${path}.${role}`, role));
    }
  }
}

function validateApprovalMap(
  diagnostics: InventoryContractDiagnostic[],
  value: unknown,
  path: string,
  code: InventoryContractDiagnosticCode,
): void {
  if (!isRecord(value) || !hasExactKeys(value, INVENTORY_POSTING_ROLES)) {
    diagnostics.push(inventoryDiagnostic(code, path, null));
    return;
  }
  for (const role of INVENTORY_POSTING_ROLES) {
    const threshold = value[role];
    if (
      threshold !== null &&
      (typeof threshold !== 'string' ||
        threshold.startsWith('-') ||
        !canonicalDecimalWithin(threshold, 38, 18))
    ) {
      diagnostics.push(inventoryDiagnostic(code, `${path}.${role}`, role));
    }
  }
}

function canonicalDecimalWithin(
  value: string,
  precision: number,
  scale: number,
): boolean {
  if (!CANONICAL_DECIMAL_V2.test(value)) return false;
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [integer = '', fractional = ''] = unsigned.split('.');
  return (
    integer.length + fractional.length <= precision &&
    fractional.length <= scale
  );
}

function validateSameValue(actual: unknown, expected: unknown): boolean {
  return actual === expected;
}

function expectInventoryLiteral(
  diagnostics: InventoryContractDiagnostic[],
  root: Record<string, unknown>,
  path: readonly string[],
  expected: unknown,
  code: InventoryContractDiagnosticCode = 'INVENTORY_CONTRACT_INVALID',
): void {
  if (validateSameValue(nestedValue(root, path), expected)) return;
  diagnostics.push(
    inventoryDiagnostic(code, `$.${path.join('.')}`, path.at(-1) ?? null),
  );
}

function expectInventoryStringArray(
  diagnostics: InventoryContractDiagnostic[],
  root: Record<string, unknown>,
  path: readonly string[],
  expected: readonly string[],
): void {
  if (sameStringArray(nestedValue(root, path), expected)) return;
  diagnostics.push(
    inventoryDiagnostic(
      'INVENTORY_CONTRACT_INVALID',
      `$.${path.join('.')}`,
      path.at(-1) ?? null,
    ),
  );
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function inventoryDependencyKey(value: unknown): string | null {
  if (
    !isRecord(value) ||
    typeof value.dependencyId !== 'string' ||
    typeof value.access !== 'string' ||
    typeof value.authority !== 'string'
  ) {
    return null;
  }
  if (!['read', 'append', 'transition'].includes(value.access)) return null;
  if (
    ![
      'trustedContext',
      'operationInput',
      'catalog',
      'location',
      'party',
      'inventory',
      'trust',
    ].includes(value.authority)
  ) {
    return null;
  }
  return `${value.access}\0${value.authority}\0${value.dependencyId}`;
}

function canonicalFamilyId(entityId: string): string | null {
  const marker = ':entity.';
  const offset = entityId.lastIndexOf(marker);
  if (offset < 1) return null;
  const familyId = entityId.slice(offset + marker.length);
  return familyId.length > 0 ? familyId : null;
}

function canonicalPackageLocalId(packageId: string): string | null {
  const marker = ':package.';
  const offset = packageId.lastIndexOf(marker);
  if (offset < 1) return null;
  const localId = packageId.slice(offset + marker.length);
  return localId.length > 0 ? localId : null;
}

function canonicalFieldLocalId(fieldId: string): string | null {
  const marker = ':field.';
  const offset = fieldId.lastIndexOf(marker);
  if (offset < 1) return null;
  const localId = fieldId.slice(offset + marker.length);
  return localId.length > 0 ? localId : null;
}

function isLegalEntityGovernedPackage(packageId: string): boolean {
  return LEGAL_ENTITY_GOVERNED_PACKAGES.some((packageFamily) =>
    packageId.endsWith(`:package.${packageFamily}`),
  );
}

function legalEntityRelationKey(value: unknown): string | null {
  if (
    !isRecord(value) ||
    typeof value.sourceFamilyId !== 'string' ||
    typeof value.targetFamilyId !== 'string' ||
    (value.semantics !== 'sameEntity' &&
      value.semantics !== 'crossEntityAllowed')
  ) {
    return null;
  }
  return `${value.sourceFamilyId}->${value.targetFamilyId}`;
}

function inventoryCanonicalRoot(value: unknown): string | null {
  try {
    return canonicalizeAndHash(value).contentHash;
  } catch {
    return null;
  }
}

function nestedRecord(
  root: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | undefined {
  const value = nestedValue(root, path);
  return isRecord(value) ? value : undefined;
}

function nestedValue(
  root: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return sameStringArray(actual, keys);
}

const INVENTORY_DIAGNOSTIC_RULES: Readonly<
  Record<InventoryContractDiagnosticCode, string>
> = Object.freeze({
  INVENTORY_BASE_UNIT_IMMUTABLE:
    'an item base unit cannot change after the first posted movement binds it',
  INVENTORY_CONFIGURATION_MALFORMED:
    'inventory posting configuration accepts only its declared typed dials',
  INVENTORY_CONFIGURATION_OUT_OF_RANGE:
    'inventory posting configuration values remain inside their declared exact bounds',
  INVENTORY_CONFIGURATION_REQUIRED:
    'every required inventory posting dial declares its type and release-recorded default',
  INVENTORY_CONTRACT_INVALID:
    'the inventory capability compiles only its pinned declaration and provider ABI shapes',
  INVENTORY_COUNT_EVIDENCE_INVALID:
    'stock-count evidence preserves its reviewed session, line linkage, and expected, counted, and variance quantities as distinct facts',
  INVENTORY_COUNT_EVIDENCE_MONEY_FORBIDDEN:
    'stock-count evidence is physical-quantity evidence and contains no monetary member',
  INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED:
    'every governed family has one explicit entityOwned or tenantShared classification and no default',
  INVENTORY_MOVEMENT_MONEY_FORBIDDEN:
    'an inventory movement is a quantity-only fact and carries no monetary field',
  INVENTORY_MOVEMENT_VALUE_DERIVATION_FORBIDDEN:
    'no compiled artifact derives a monetary value from inventory movement facts',
  INVENTORY_POSTING_DEPENDENCY_UNDECLARED:
    'inventory posting reads and writes only through its published authoritative dependency set',
  INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED:
    'every governed relation endpoint pair has one pinned sameEntity or crossEntityAllowed semantic',
  INVENTORY_STOCK_DIMENSION_MEMBER_REQUIRED:
    'every v1 stock dimension has a real required value at posting',
  INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN:
    'v1 stock dimensions cannot manufacture an unspecified member',
  INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED:
    'every inventory movement declares the stock-dimension-set version it uses',
  INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN:
    'an inventory movement uses only a known released stock-dimension-set version',
  INVENTORY_TERMINAL_GUARD_MISSING:
    'stock-count generic operations refuse terminal posted evidence through one exact required-state precondition',
});

function inventoryModuleDiagnostic(
  code:
    | 'INVENTORY_CONTRACT_INVALID'
    | 'INVENTORY_COUNT_EVIDENCE_INVALID'
    | 'INVENTORY_COUNT_EVIDENCE_MONEY_FORBIDDEN'
    | 'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED'
    | 'INVENTORY_MOVEMENT_MONEY_FORBIDDEN'
    | 'INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED'
    | 'INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED'
    | 'INVENTORY_TERMINAL_GUARD_MISSING',
  path: string,
  subjectId: string | null,
): CompilerDiagnostic {
  const acceptedAlternative: Readonly<Record<typeof code, string>> =
    Object.freeze({
      INVENTORY_CONTRACT_INVALID:
        'make the compiled Inventory family match its pinned contract shape exactly',
      INVENTORY_COUNT_EVIDENCE_INVALID:
        'declare the complete stock-count session and line evidence shape, including all three distinct quantity values and its posting links',
      INVENTORY_COUNT_EVIDENCE_MONEY_FORBIDDEN:
        'keep stock-count evidence physical-quantity-only; financial value belongs to G4',
      INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED:
        'add the family to the pinned inventory legal-entity map before compiling it; no ownership default exists',
      INVENTORY_MOVEMENT_MONEY_FORBIDDEN:
        'keep inventory movement facts quantity-only and derive financial value in its separately governed accounting authority',
      INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED:
        'add the canonical endpoint pair to the pinned inventory relation-semantics contract before compiling it',
      INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED:
        'declare the required exactly-v1 stock-dimension-set version field on every inventory movement',
      INVENTORY_TERMINAL_GUARD_MISSING:
        'declare the exact not-posted precondition on all four stock-count generic operations and keep stock_count_state required',
    });
  return {
    acceptedAlternative: acceptedAlternative[code],
    code,
    diagnosticVersion: COMPILER_DIAGNOSTIC_VERSION,
    occurrenceIndex: 0,
    path,
    phase: 'wholeModelValidation',
    rule: INVENTORY_DIAGNOSTIC_RULES[code],
    severity: 'error',
    subjectId,
  };
}

function inventoryDiagnostic(
  code: InventoryContractDiagnosticCode,
  path: string,
  subjectId: string | null,
  bindingMovementId: string | null = null,
): InventoryContractDiagnostic {
  return {
    bindingMovementId,
    code,
    path,
    rule: INVENTORY_DIAGNOSTIC_RULES[code],
    subjectId,
  };
}

function sortInventoryDiagnostics(
  diagnostics: InventoryContractDiagnostic[],
): InventoryContractDiagnostic[] {
  return diagnostics.sort(
    (left, right) =>
      compareInventoryCodeUnits(left.path, right.path) ||
      compareInventoryCodeUnits(left.code, right.code) ||
      compareInventoryCodeUnits(left.subjectId ?? '', right.subjectId ?? ''),
  );
}

function compareInventoryCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failedInventoryContract(
  diagnostics: InventoryContractDiagnostic[],
): InventoryContractCompileResult {
  return {
    diagnostics: sortInventoryDiagnostics(diagnostics),
    release: null,
    status: 'failed',
  };
}

function inventoryConformanceResult(
  diagnostics: InventoryContractDiagnostic[],
): InventoryConformanceResult {
  return diagnostics.length === 0
    ? { diagnostics: [], status: 'accepted' }
    : {
        diagnostics: sortInventoryDiagnostics(diagnostics),
        status: 'rejected',
      };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function missing(
  diagnostics: CompilerDiagnostic[],
  entityId: string,
  family: string,
): void {
  diagnostics.push(
    compilerDiagnostic(
      'COMPILER_ENTITY_PROJECTION_MISSING',
      'wholeModelValidation',
      `$.conformance.${family}`,
      entityId,
    ),
  );
}
