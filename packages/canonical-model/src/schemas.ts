import { z } from 'zod';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  CURRENCY_MINOR_UNITS_V0,
  DISCLOSURE_TIERS,
  PROMOTE_STORAGE_CLASS_CAPABILITY_ID,
  QUERY_PARAMETER_LIMIT_V3,
  SUPPORTED_LANGUAGE_VERSIONS,
  SUPPORTED_NORMALIZATION_PROFILE_VERSIONS,
  STATUS_ROLES,
  SURFACE_ARCHETYPES,
  type CanonicalLanguageVersion,
} from './constants.js';
import { LEGAL_ENTITY_SCOPE_CONTRACT_V1 } from './legal-entity-scope-kernel.js';

const nodeVersion = z.enum(SUPPORTED_LANGUAGE_VERSIONS);
const legacyNodeVersion = z.enum(['v0-experimental', 'v1', 'v2']);
// Node-level version for the family v3 introduced. v4 reads every v3 node, so
// the node schema admits both; `CANON_VERSION_MIXED` in normalize.ts is what
// keeps a package's nodes on the package's own version, exactly as it already
// does for the `nodeVersion` enum above.
const v3PlusNodeVersion = z.enum(['v3', 'v4', 'v5', 'v6']);
const v3NodeVersion = z.literal('v3');
// The v4 family's own node spelling. v5 reads every v4 node -- it changes no
// node shape, only what normalization DERIVES -- so the family schema admits
// both and `CANON_VERSION_MIXED` keeps a package on its own version, exactly
// as `v3PlusNodeVersion` already does one line above.
const v4PlusNodeVersion = z.enum(['v4', 'v5', 'v6']);
const v4NodeVersion = z.literal('v4');
const v5NodeVersion = z.literal('v5');
const v6NodeVersion = z.literal('v6');
const boundedOrderKey = z.int().min(0).max(1_000_000);
const boundedCount = z.int().min(1).max(1_000_000);
const positiveVersion = z.int().min(1).max(1_000_000);
const currencyCodes = Object.keys(CURRENCY_MINOR_UNITS_V0) as [
  keyof typeof CURRENCY_MINOR_UNITS_V0,
  ...(keyof typeof CURRENCY_MINOR_UNITS_V0)[],
];
const CurrencyCodeSchema = z.enum(currencyCodes);

export const CanonicalIdSchema = z
  .string()
  .min(5)
  .max(180)
  .regex(
    /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
  )
  .brand<'CanonicalId'>();

export const NamespaceSchema = z
  .string()
  .min(3)
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/)
  .brand<'CanonicalNamespace'>();

export const LabelSchema = z.string().min(1).max(240);
export const SemanticVersionSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
export const CanonicalIntegerStringSchema = z
  .string()
  .regex(/^(?:0|-[1-9]\d*|[1-9]\d*)$/);
export const CanonicalDecimalStringSchema = z
  .string()
  .regex(/^(?:0|-[1-9]\d*|[1-9]\d*)(?:\.\d*[1-9])?$/);
export const CanonicalSignedDecimalStringSchema = z
  .string()
  .regex(/^(?:0|-?(?:[1-9]\d*(?:\.\d*[1-9])?|0\.\d*[1-9]))$/);

const IsoDateValueSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isValidIsoDate);
const IsoTimeValueSchema = z
  .string()
  .regex(/^\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/)
  .refine(isValidIsoTime);
const IsoDateTimeValueSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/,
  )
  .refine(isValidIsoDateTime);

export const CanonicalReferenceSchema = z.strictObject({
  kind: z.enum([
    'moduleReference',
    'entityReference',
    'fieldReference',
    'stateMachineReference',
    'stateReference',
    'transitionReference',
    'surfaceReference',
    'queryReference',
    'operationReference',
    'permissionReference',
    'storageMappingReference',
    'capabilityReference',
    'opaqueSurfaceContentReference',
    'unitReference',
  ]),
  schemaVersion: nodeVersion,
  targetId: CanonicalIdSchema,
});

type PredicateExpressionShape<
  SchemaVersion extends CanonicalLanguageVersion,
  Operator extends string,
  Value,
> =
  | {
      kind: 'booleanPredicate';
      schemaVersion: SchemaVersion;
      value: boolean;
    }
  | {
      field: z.infer<typeof CanonicalReferenceSchema>;
      kind: 'fieldComparisonPredicate';
      operator: Operator;
      schemaVersion: SchemaVersion;
      value: Value;
    }
  | {
      kind: 'allPredicate' | 'anyPredicate';
      schemaVersion: SchemaVersion;
      terms: PredicateExpressionShape<SchemaVersion, Operator, Value>[];
    }
  | {
      kind: 'notPredicate';
      schemaVersion: SchemaVersion;
      term: PredicateExpressionShape<SchemaVersion, Operator, Value>;
    };

type LegacyPredicateOperator =
  'equals' | 'notEquals' | 'lessThan' | 'greaterThan';
type V3PredicateOperator =
  LegacyPredicateOperator | 'greaterThanOrEqual' | 'lessThanOrEqual';

export type PredicateExpression = PredicateExpressionShape<
  CanonicalLanguageVersion,
  LegacyPredicateOperator,
  CanonicalScalar
>;
export type PredicateExpressionV3 = PredicateExpressionShape<
  'v3' | 'v4' | 'v5' | 'v6',
  V3PredicateOperator,
  CanonicalScalar | QueryParameterReference
>;

export type VersionedPredicateExpression =
  PredicateExpression | PredicateExpressionV3;

export interface QueryParameterReference {
  readonly kind: 'queryParameterReference';
  readonly parameterId: z.infer<typeof CanonicalIdSchema>;
  readonly schemaVersion: 'v3' | 'v4' | 'v5' | 'v6';
}

export type CanonicalScalar =
  | {
      kind: 'textValue';
      schemaVersion: CanonicalLanguageVersion;
      value: string;
    }
  | {
      kind: 'booleanValue';
      schemaVersion: CanonicalLanguageVersion;
      value: boolean;
    }
  | {
      kind: 'integerValue' | 'exactDecimalValue';
      schemaVersion: CanonicalLanguageVersion;
      value: string;
    }
  | {
      currencyCode: string;
      kind: 'moneyValue';
      minorUnit: number;
      schemaVersion: CanonicalLanguageVersion;
      value: string;
    }
  | {
      kind: 'dateValue' | 'timeValue' | 'dateTimeValue';
      schemaVersion: CanonicalLanguageVersion;
      value: string;
    }
  | {
      baseUnit: z.infer<typeof CanonicalReferenceSchema>;
      kind: 'quantityValue';
      schemaVersion: CanonicalLanguageVersion;
      value: string;
    };

const legacyCanonicalScalarSchema: z.ZodType<CanonicalScalar> =
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('textValue'),
      schemaVersion: legacyNodeVersion,
      value: z.string().max(4_000),
    }),
    z.strictObject({
      kind: z.literal('booleanValue'),
      schemaVersion: legacyNodeVersion,
      value: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal('integerValue'),
      schemaVersion: legacyNodeVersion,
      value: CanonicalIntegerStringSchema,
    }),
    z.strictObject({
      kind: z.literal('exactDecimalValue'),
      schemaVersion: legacyNodeVersion,
      value: CanonicalDecimalStringSchema,
    }),
    z
      .strictObject({
        currencyCode: CurrencyCodeSchema,
        kind: z.literal('moneyValue'),
        minorUnit: z.int().min(0).max(6),
        schemaVersion: legacyNodeVersion,
        value: CanonicalDecimalStringSchema,
      })
      .refine(
        (value) =>
          CURRENCY_MINOR_UNITS_V0[value.currencyCode] === value.minorUnit,
      ),
    z.strictObject({
      kind: z.literal('dateValue'),
      schemaVersion: legacyNodeVersion,
      value: IsoDateValueSchema,
    }),
    z.strictObject({
      kind: z.literal('timeValue'),
      schemaVersion: legacyNodeVersion,
      value: IsoTimeValueSchema,
    }),
    z.strictObject({
      kind: z.literal('dateTimeValue'),
      schemaVersion: legacyNodeVersion,
      value: IsoDateTimeValueSchema,
    }),
    z.strictObject({
      baseUnit: CanonicalReferenceSchema,
      kind: z.literal('quantityValue'),
      schemaVersion: legacyNodeVersion,
      value: CanonicalDecimalStringSchema,
    }),
  ]);

const v3CanonicalScalarSchema: z.ZodType<CanonicalScalar> =
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('textValue'),
      schemaVersion: v3PlusNodeVersion,
      value: z.string().max(4_000),
    }),
    z.strictObject({
      kind: z.literal('booleanValue'),
      schemaVersion: v3PlusNodeVersion,
      value: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal('integerValue'),
      schemaVersion: v3PlusNodeVersion,
      value: CanonicalIntegerStringSchema,
    }),
    z.strictObject({
      kind: z.literal('exactDecimalValue'),
      schemaVersion: v3PlusNodeVersion,
      value: CanonicalSignedDecimalStringSchema,
    }),
    z
      .strictObject({
        currencyCode: CurrencyCodeSchema,
        kind: z.literal('moneyValue'),
        minorUnit: z.int().min(0).max(6),
        schemaVersion: v3PlusNodeVersion,
        value: CanonicalSignedDecimalStringSchema,
      })
      .refine(
        (value) =>
          CURRENCY_MINOR_UNITS_V0[value.currencyCode] === value.minorUnit,
      ),
    z.strictObject({
      kind: z.literal('dateValue'),
      schemaVersion: v3PlusNodeVersion,
      value: IsoDateValueSchema,
    }),
    z.strictObject({
      kind: z.literal('timeValue'),
      schemaVersion: v3PlusNodeVersion,
      value: IsoTimeValueSchema,
    }),
    z.strictObject({
      kind: z.literal('dateTimeValue'),
      schemaVersion: v3PlusNodeVersion,
      value: IsoDateTimeValueSchema,
    }),
    z.strictObject({
      baseUnit: CanonicalReferenceSchema,
      kind: z.literal('quantityValue'),
      schemaVersion: v3PlusNodeVersion,
      value: CanonicalSignedDecimalStringSchema,
    }),
  ]);

export const CanonicalScalarSchema = legacyCanonicalScalarSchema;
export const VersionedCanonicalScalarSchema: z.ZodType<CanonicalScalar> =
  z.union([legacyCanonicalScalarSchema, v3CanonicalScalarSchema]);

const QueryParameterReferenceSchema: z.ZodType<QueryParameterReference> =
  z.strictObject({
    kind: z.literal('queryParameterReference'),
    parameterId: CanonicalIdSchema,
    schemaVersion: v3PlusNodeVersion,
  });

function makePredicateExpressionSchema(
  versionSchema: z.ZodType,
  operatorSchema: z.ZodType,
  valueSchema: z.ZodType,
): z.ZodType<unknown> {
  const expression: z.ZodType<unknown> = z.lazy(() =>
    z.union([
      z.strictObject({
        kind: z.literal('booleanPredicate'),
        schemaVersion: versionSchema,
        value: z.boolean(),
      }),
      z.strictObject({
        field: CanonicalReferenceSchema,
        kind: z.literal('fieldComparisonPredicate'),
        operator: operatorSchema,
        schemaVersion: versionSchema,
        value: valueSchema,
      }),
      z.strictObject({
        kind: z.literal('allPredicate'),
        schemaVersion: versionSchema,
        terms: z.array(expression),
      }),
      z.strictObject({
        kind: z.literal('anyPredicate'),
        schemaVersion: versionSchema,
        terms: z.array(expression),
      }),
      z.strictObject({
        kind: z.literal('notPredicate'),
        schemaVersion: versionSchema,
        term: expression,
      }),
    ]),
  );
  return expression;
}

const legacyPredicateOperators = z.enum([
  'equals',
  'notEquals',
  'lessThan',
  'greaterThan',
]);
const v3PredicateOperators = z.enum([
  'equals',
  'notEquals',
  'lessThan',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThanOrEqual',
]);

const legacyPredicateExpressionSchema = makePredicateExpressionSchema(
  legacyNodeVersion,
  legacyPredicateOperators,
  legacyCanonicalScalarSchema,
) as z.ZodType<PredicateExpression>;
const v3PredicateExpressionSchema = makePredicateExpressionSchema(
  v3PlusNodeVersion,
  v3PredicateOperators,
  z.union([v3CanonicalScalarSchema, QueryParameterReferenceSchema]),
) as z.ZodType<PredicateExpressionV3>;
const v3CompatibilityPredicateExpressionSchema = makePredicateExpressionSchema(
  v3PlusNodeVersion,
  legacyPredicateOperators,
  v3CanonicalScalarSchema,
) as z.ZodType<PredicateExpression>;

export const PredicateExpressionSchema: z.ZodType<PredicateExpression> =
  z.union([
    legacyPredicateExpressionSchema,
    v3CompatibilityPredicateExpressionSchema,
  ]);
export const VersionedPredicateExpressionSchema: z.ZodType<VersionedPredicateExpression> =
  z.union([legacyPredicateExpressionSchema, v3PredicateExpressionSchema]);

const textFieldType = z.strictObject({
  kind: z.literal('textFieldType'),
  maximumLength: z.int().min(1).max(4_000),
  schemaVersion: nodeVersion,
});
const booleanFieldType = z.strictObject({
  kind: z.literal('booleanFieldType'),
  schemaVersion: nodeVersion,
});
const integerFieldType = z.strictObject({
  kind: z.literal('integerFieldType'),
  representation: z.literal('canonicalString'),
  schemaVersion: nodeVersion,
});
const exactDecimalFieldType = z
  .strictObject({
    kind: z.literal('exactDecimalFieldType'),
    precision: z.int().min(1).max(38),
    representation: z.literal('canonicalString'),
    scale: z.int().min(0).max(18),
    schemaVersion: nodeVersion,
  })
  .refine((value) => value.scale <= value.precision);
const moneyFieldType = z
  .strictObject({
    currencyCode: CurrencyCodeSchema,
    kind: z.literal('moneyFieldType'),
    minorUnit: z.int().min(0).max(6),
    precision: z.int().min(1).max(38),
    representation: z.literal('canonicalString'),
    scale: z.int().min(0).max(18),
    schemaVersion: nodeVersion,
  })
  .refine(
    (value) =>
      value.scale <= value.precision &&
      value.minorUnit <= value.scale &&
      CURRENCY_MINOR_UNITS_V0[value.currencyCode] === value.minorUnit,
  );
const dateFieldType = z.strictObject({
  calendar: z.literal('iso8601'),
  kind: z.literal('dateFieldType'),
  schemaVersion: nodeVersion,
  timezoneSemantics: z.literal('calendarDate'),
});
const timeFieldType = z.strictObject({
  kind: z.literal('timeFieldType'),
  precision: z.enum(['second', 'millisecond']),
  schemaVersion: nodeVersion,
  timezoneSemantics: z.literal('localWallTime'),
});
const dateTimeFieldType = z.strictObject({
  kind: z.literal('dateTimeFieldType'),
  precision: z.enum(['second', 'millisecond']),
  schemaVersion: nodeVersion,
  timezoneSemantics: z.enum(['utcInstant', 'offsetDateTime']),
});
const quantityFieldType = z
  .strictObject({
    baseUnit: CanonicalReferenceSchema,
    kind: z.literal('quantityFieldType'),
    precision: z.int().min(1).max(38),
    representation: z.literal('canonicalString'),
    scale: z.int().min(0).max(18),
    schemaVersion: nodeVersion,
  })
  .refine((value) => value.scale <= value.precision);
const enumOption = z.strictObject({
  kind: z.literal('enumOption'),
  label: LabelSchema,
  optionId: CanonicalIdSchema,
  orderKey: boundedOrderKey,
  schemaVersion: nodeVersion,
});
const enumFieldType = z.strictObject({
  kind: z.literal('enumFieldType'),
  options: z.array(enumOption),
  schemaVersion: nodeVersion,
});

export const FieldTypeSchema = z.discriminatedUnion('kind', [
  textFieldType,
  booleanFieldType,
  integerFieldType,
  exactDecimalFieldType,
  moneyFieldType,
  dateFieldType,
  timeFieldType,
  dateTimeFieldType,
  quantityFieldType,
  enumFieldType,
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

const normalizedPackageDefinition = z.strictObject({
  kind: z.literal('packageDefinition'),
  lifecycle: z.enum(['active', 'retired']),
  namespace: NamespaceSchema,
  packageId: CanonicalIdSchema,
  provenance: z.enum(['firstParty', 'tenantAuthored']),
  schemaVersion: nodeVersion,
  version: SemanticVersionSchema,
});
const authoredPackageDefinition = normalizedPackageDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
});

const compositionSeam = z.strictObject({
  kind: z.literal('compositionSeam'),
  schemaVersion: nodeVersion,
  status: z.literal('unsupported'),
});
const normalizedModuleDefinition = z.strictObject({
  composition: compositionSeam,
  kind: z.literal('moduleDefinition'),
  label: LabelSchema,
  lifecycle: z.enum(['active', 'retired']),
  moduleId: CanonicalIdSchema,
  orderKey: boundedOrderKey,
  ownerPackageId: CanonicalIdSchema,
  schemaVersion: nodeVersion,
});
const authoredModuleDefinition = normalizedModuleDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
});

const normalizedEntityDefinition = z.strictObject({
  entityId: CanonicalIdSchema,
  kind: z.literal('entityDefinition'),
  label: LabelSchema,
  lifecycle: z.enum(['active', 'retired']),
  module: CanonicalReferenceSchema,
  orderKey: boundedOrderKey,
  schemaVersion: nodeVersion,
  storage: CanonicalReferenceSchema,
});
const authoredEntityDefinition = normalizedEntityDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
});

const normalizedFieldDefinition = z.strictObject({
  businessKey: z
    .enum(['none', 'tenantEnvironmentCaseInsensitiveUnique'])
    .optional(),
  classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  collation: z.enum(['binary', 'unicodeCaseInsensitive']).optional(),
  defaultSemantics: z
    .enum(['none', 'nullable', 'declaredDefault', 'coalesceAtRead'])
    .optional(),
  defaultValue: CanonicalScalarSchema.optional(),
  entity: CanonicalReferenceSchema,
  fieldId: CanonicalIdSchema,
  fieldType: FieldTypeSchema,
  kind: z.literal('fieldDefinition'),
  label: LabelSchema,
  lifecycle: z.enum(['active', 'retired']),
  orderKey: boundedOrderKey,
  presence: z.enum(['optional', 'required']),
  reportable: z.boolean(),
  schemaVersion: nodeVersion,
  searchable: z.boolean(),
  storageEvolution: z
    .strictObject({
      kind: z.literal('backfillEvolution'),
      residualReadSemantics: z.enum([
        'declaredDefault',
        'coalesceAtRead',
        'requiresCompleteness',
      ]),
      schemaVersion: nodeVersion,
    })
    .optional(),
});
const authoredFieldDefinition = normalizedFieldDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
  presence: z.enum(['optional', 'required']).optional(),
  reportable: z.boolean().optional(),
  searchable: z.boolean().optional(),
});
const normalizedV3FieldDefinition = normalizedFieldDefinition.extend({
  defaultValue: v3CanonicalScalarSchema.optional(),
});
const authoredV3FieldDefinition = normalizedV3FieldDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
  presence: z.enum(['optional', 'required']).optional(),
  reportable: z.boolean().optional(),
  searchable: z.boolean().optional(),
});

const normalizedRelationDefinition = z.strictObject({
  archiveBehavior: z.enum(['restrict', 'retainReference']),
  // ADR-0041 section 1: cardinality is restricted to the value the storage
  // lowerer implements. `oneToOne` and `oneToMany` have no executing semantics,
  // so they are refused at authoring rather than accepted and discarded.
  cardinality: z.literal('manyToOne'),
  foreignKeyActions: z
    .strictObject({
      onDelete: z.literal('restrict'),
      onUpdate: z.literal('restrict'),
      schemaVersion: nodeVersion,
    })
    .optional(),
  joinEligibility: z.enum(['none', 'query']),
  kind: z.literal('relationDefinition'),
  lifecycle: z.enum(['active', 'retired']),
  orderKey: boundedOrderKey,
  ownership: z.enum(['reference', 'parentScopedChild']),
  relationId: CanonicalIdSchema,
  required: z.boolean(),
  schemaVersion: nodeVersion,
  sourceEntity: CanonicalReferenceSchema,
  targetEntity: CanonicalReferenceSchema,
});
const authoredRelationDefinition = normalizedRelationDefinition.extend({
  joinEligibility: z.enum(['none', 'query']).optional(),
  lifecycle: z.enum(['active', 'retired']).optional(),
  required: z.boolean().optional(),
});

const stateDefinition = z.strictObject({
  kind: z.literal('stateDefinition'),
  label: LabelSchema,
  orderKey: boundedOrderKey,
  schemaVersion: nodeVersion,
  stateId: CanonicalIdSchema,
  terminal: z.boolean(),
});
const authoredStateDefinition = stateDefinition.extend({
  terminal: z.boolean().optional(),
});
const transitionDefinition = z.strictObject({
  fromState: CanonicalReferenceSchema,
  kind: z.literal('transitionDefinition'),
  label: LabelSchema,
  orderKey: boundedOrderKey,
  permission: CanonicalReferenceSchema,
  schemaVersion: nodeVersion,
  toState: CanonicalReferenceSchema,
  transitionId: CanonicalIdSchema,
});
const derivedStateField = z.strictObject({
  fieldId: CanonicalIdSchema,
  kind: z.literal('derivedStateField'),
  schemaVersion: nodeVersion,
  valueKind: z.literal('stateId'),
});
const normalizedStateMachineDefinition = z.strictObject({
  entity: CanonicalReferenceSchema,
  initialState: CanonicalReferenceSchema,
  kind: z.literal('stateMachineDefinition'),
  lifecycle: z.enum(['active', 'retired']),
  machineId: CanonicalIdSchema,
  schemaVersion: nodeVersion,
  stateField: derivedStateField,
  states: z.array(stateDefinition).min(1),
  transitions: z.array(transitionDefinition),
});
const authoredStateMachineDefinition = normalizedStateMachineDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
  stateField: derivedStateField.optional(),
  states: z.array(authoredStateDefinition),
});

const surfaceSlot = z.strictObject({
  content: CanonicalReferenceSchema,
  // Optional, and deliberately NOT defaulted during normalization: an absent
  // tier stays absent, so every existing normalized definition keeps its bytes
  // and every recorded release root holds. See DEFAULT_DISCLOSURE_TIER.
  disclosureTier: z.enum(DISCLOSURE_TIERS).optional(),
  kind: z.literal('surfaceSlot'),
  orderKey: boundedOrderKey,
  schemaVersion: nodeVersion,
  slot: z.string().min(1).max(80),
  slotId: CanonicalIdSchema,
});
const normalizedSurfaceDefinition = z.strictObject({
  archetype: z.enum(SURFACE_ARCHETYPES),
  dataSource: CanonicalReferenceSchema,
  kind: z.literal('surfaceDefinition'),
  label: LabelSchema,
  lifecycle: z.enum(['active', 'retired']),
  module: CanonicalReferenceSchema,
  renderer: z
    .strictObject({
      kind: z.literal('rendererForm'),
      rendererId: CanonicalIdSchema,
      schemaVersion: nodeVersion,
    })
    .optional(),
  schemaVersion: nodeVersion,
  slots: z.array(surfaceSlot),
  statusRoles: z.array(z.enum(STATUS_ROLES)),
  surfaceId: CanonicalIdSchema,
  surfaceRole: z.enum(['list', 'record', 'form']).optional(),
});
const authoredSurfaceDefinition = normalizedSurfaceDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
});

/** v6 composition: data and actions are authored, grammar remains platform-owned. */
const compositionReference = <T extends string>(kind: T) =>
  z.strictObject({
    kind: z.literal(kind),
    schemaVersion: v6NodeVersion,
    targetId: CanonicalIdSchema,
  });
const compositionValue = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('literal'),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.strictObject({ source: z.literal('record'), field: z.string().min(1) }),
  z.strictObject({
    source: z.literal('selected'),
    field: z.string().min(1),
    datasetId: CanonicalIdSchema.optional(),
  }),
  z.strictObject({ source: z.literal('input'), inputId: CanonicalIdSchema }),
  z.strictObject({
    source: z.literal('step'),
    stepId: CanonicalIdSchema,
    field: z.string().min(1),
  }),
  z.strictObject({
    source: z.literal('generated'),
    value: z.enum(['uuid', 'instant', 'scope']),
  }),
]);
const compositionColumn = z.strictObject({
  columnId: CanonicalIdSchema,
  label: LabelSchema,
  orderKey: boundedOrderKey,
  field: z.string().min(1),
  presentation: z
    .strictObject({
      role: z.enum(['primary', 'secondary', 'quantity', 'detail']),
      priority: boundedOrderKey,
    })
    .optional(),
  reference: z
    .strictObject({
      query: compositionReference('queryReference'),
      labelField: compositionReference('fieldReference'),
    })
    .optional(),
});
const compositionCondition = z.strictObject({
  value: compositionValue,
  operator: z.enum(['equals', 'notEquals', 'positive']),
  compare: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
const compositionInput = z.strictObject({
  inputId: CanonicalIdSchema,
  label: LabelSchema,
  orderKey: boundedOrderKey,
  type: z.enum(['text', 'quantity', 'instant', 'reference']),
  required: z.boolean(),
  query: compositionReference('queryReference').optional(),
  labelField: compositionReference('fieldReference').optional(),
});
const compositionStep = z.strictObject({
  stepId: CanonicalIdSchema,
  operation: compositionReference('operationReference'),
  bindings: z
    .array(
      z.strictObject({
        path: z.array(z.string().min(1)).min(1).max(3),
        value: compositionValue,
      }),
    )
    .min(1)
    .max(60),
});
const compositionAction = z.strictObject({
  presentation: z
    .strictObject({
      placement: z.enum(['selection', 'row']),
    })
    .optional(),
  actionId: CanonicalIdSchema,
  label: LabelSchema,
  description: LabelSchema,
  orderKey: boundedOrderKey,
  datasetId: CanonicalIdSchema.optional(),
  conditions: z.array(compositionCondition).max(12),
  inputs: z.array(compositionInput).max(12),
  steps: z.array(compositionStep).max(5),
  navigate: z
    .strictObject({
      surface: compositionReference('surfaceReference'),
      query: compositionReference('queryReference'),
      record: compositionValue,
    })
    .optional(),
});
const compositionDataset = z.strictObject({
  presentation: z
    .strictObject({
      description: LabelSchema.optional(),
      selection: z.enum(['explicit', 'none']),
      compact: z.literal('scrollTable').optional(),
    })
    .optional(),
  datasetId: CanonicalIdSchema,
  label: LabelSchema,
  orderKey: boundedOrderKey,
  query: compositionReference('queryReference'),
  sort: z
    .array(
      z.strictObject({
        fieldId: CanonicalIdSchema,
        direction: z.enum(['ascending', 'descending']),
      }),
    )
    .max(3)
    .optional(),
  parent: z
    .strictObject({
      relationId: CanonicalIdSchema,
      value: compositionValue,
      ownership: z.enum(['parentScopedChild', 'reference']),
    })
    .optional(),
  columns: z.array(compositionColumn).min(1).max(30),
});
export const SurfaceCompositionSchema = z.strictObject({
  presentation: z
    .strictObject({
      header: z.strictObject({
        title: CanonicalIdSchema,
        subtitle: z.array(CanonicalIdSchema).max(4),
        facts: z.array(CanonicalIdSchema).max(6),
        status: CanonicalIdSchema.optional(),
      }),
      context: z
        .strictObject({ label: LabelSchema, description: LabelSchema })
        .optional(),
      recordActions: z.literal('progressive'),
      technicalDetails: z.literal('progressive'),
      task: z
        .strictObject({
          mode: z.literal('nativeDialog'),
          fallback: z.literal('page'),
        })
        .optional(),
    })
    .optional(),
  kind: z.literal('surfaceComposition'),
  schemaVersion: v6NodeVersion,
  fields: z.array(compositionColumn).max(30),
  children: z.array(compositionDataset).max(8),
  actions: z.array(compositionAction).max(12),
});
export type SurfaceComposition = z.infer<typeof SurfaceCompositionSchema>;
const normalizedV6SurfaceDefinition = normalizedSurfaceDefinition.extend({
  composition: SurfaceCompositionSchema.optional(),
});
const authoredV6SurfaceDefinition = normalizedV6SurfaceDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
});

const querySelection = z.strictObject({
  field: CanonicalReferenceSchema,
  kind: z.literal('querySelection'),
  orderKey: boundedOrderKey,
  schemaVersion: nodeVersion,
  selectionId: CanonicalIdSchema,
});
const resolveMatchKey = z.strictObject({
  authority: z.enum(['identifier', 'advisory']),
  field: CanonicalReferenceSchema,
  kind: z.literal('resolveMatchKey'),
  matchKeyId: CanonicalIdSchema,
  orderKey: boundedOrderKey,
  schemaVersion: nodeVersion,
});
const normalizedRowQueryDefinition = z.strictObject({
  filter: legacyPredicateExpressionSchema,
  kind: z.literal('queryDefinition'),
  lifecycle: z.enum(['active', 'retired']),
  maximumResultCount: boundedCount,
  module: CanonicalReferenceSchema,
  permission: CanonicalReferenceSchema,
  queryId: CanonicalIdSchema,
  queryType: z.enum(['get', 'list', 'search', 'resolve']),
  resolveMatchKeys: z.array(resolveMatchKey).optional(),
  schemaVersion: nodeVersion,
  selections: z.array(querySelection).min(1),
  sourceEntity: CanonicalReferenceSchema,
  tier: z.enum(['q0', 'q1']),
});
const authoredRowQueryDefinition = normalizedRowQueryDefinition.extend({
  filter: legacyPredicateExpressionSchema.optional(),
  lifecycle: z.enum(['active', 'retired']).optional(),
  resolveMatchKeys: z.array(resolveMatchKey).optional(),
});
const normalizedV3RowQueryDefinition = normalizedRowQueryDefinition.extend({
  filter: v3PredicateExpressionSchema,
  schemaVersion: v3PlusNodeVersion,
});
const authoredV3RowQueryDefinition = normalizedV3RowQueryDefinition.extend({
  filter: v3PredicateExpressionSchema.optional(),
  lifecycle: z.enum(['active', 'retired']).optional(),
  resolveMatchKeys: z.array(resolveMatchKey).optional(),
});

const authoredQueryParameterDefinition = z.strictObject({
  kind: z.literal('queryParameterDefinition'),
  orderKey: boundedOrderKey,
  parameterId: CanonicalIdSchema,
  schemaVersion: v3PlusNodeVersion,
});
const normalizedQueryParameterDefinition =
  authoredQueryParameterDefinition.extend({
    parameterType: FieldTypeSchema,
  });
const authoredQueryAggregateSelection = z.strictObject({
  field: CanonicalReferenceSchema,
  kind: z.literal('queryAggregateSelection'),
  operator: z.literal('sum'),
  schemaVersion: v3PlusNodeVersion,
  selectionId: CanonicalIdSchema,
});
const normalizedQueryAggregateSelection =
  authoredQueryAggregateSelection.extend({
    resultType: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('exactDecimalAggregateResultType'),
        precision: z.literal(38),
        scale: z.int().min(0).max(18),
        schemaVersion: v3PlusNodeVersion,
      }),
      z.strictObject({
        baseUnit: CanonicalReferenceSchema,
        kind: z.literal('quantityAggregateResultType'),
        precision: z.literal(38),
        scale: z.int().min(0).max(18),
        schemaVersion: v3PlusNodeVersion,
      }),
    ]),
  });
const normalizedAggregateQueryDefinition = z.strictObject({
  aggregate: normalizedQueryAggregateSelection,
  filter: v3PredicateExpressionSchema,
  kind: z.literal('queryDefinition'),
  lifecycle: z.enum(['active', 'retired']),
  maximumResultCount: z.literal(1),
  module: CanonicalReferenceSchema,
  parameters: z
    .array(normalizedQueryParameterDefinition)
    .max(QUERY_PARAMETER_LIMIT_V3),
  permission: CanonicalReferenceSchema,
  queryId: CanonicalIdSchema,
  queryType: z.literal('aggregate'),
  resolveMatchKeys: z.never().optional(),
  schemaVersion: v3PlusNodeVersion,
  sourceEntity: CanonicalReferenceSchema,
  tier: z.literal('q1'),
});
const authoredAggregateQueryDefinition = z.strictObject({
  aggregate: authoredQueryAggregateSelection,
  filter: v3PredicateExpressionSchema.optional(),
  kind: z.literal('queryDefinition'),
  lifecycle: z.enum(['active', 'retired']).optional(),
  maximumResultCount: z.literal(1),
  module: CanonicalReferenceSchema,
  parameters: z
    .array(authoredQueryParameterDefinition)
    .max(QUERY_PARAMETER_LIMIT_V3),
  permission: CanonicalReferenceSchema,
  queryId: CanonicalIdSchema,
  queryType: z.literal('aggregate'),
  schemaVersion: v3PlusNodeVersion,
  sourceEntity: CanonicalReferenceSchema,
  tier: z.literal('q1'),
});

const normalizedV3QueryDefinition = z.union([
  normalizedV3RowQueryDefinition,
  normalizedAggregateQueryDefinition,
]);
const authoredV3QueryDefinition = z.union([
  authoredV3RowQueryDefinition,
  authoredAggregateQueryDefinition,
]);

/**
 * v4: the legal-entity query operand.
 *
 * Tenant and environment are ambient trust identity. *Which* legal entities a
 * read consolidates is a business value that changes the answer — scope {A}
 * returns 5 where scope {A,B} returns 12 — so it is a query operand and it is
 * spelled in the query shape. The operand is an ordinary declared query
 * parameter, which is what lets an API caller supply it through the existing
 * two-argument gateway envelope without a new transport.
 *
 * The member is deliberately absent from every v3 shape above: a `strictObject`
 * rejects it there, which is how [ADR-0021]'s rule that adding a spelling to a
 * released version retroactively widens it is enforced rather than promised.
 */
const queryLegalEntityScope = z.strictObject({
  cardinality: z.enum(LEGAL_ENTITY_SCOPE_CONTRACT_V1.admittedCardinalities),
  kind: z.literal('queryLegalEntityScope'),
  operand: z.strictObject({
    kind: z.literal('queryParameterReference'),
    parameterId: CanonicalIdSchema,
    schemaVersion: v4PlusNodeVersion,
  }),
  schemaVersion: v4PlusNodeVersion,
});

/**
 * A scope operand carries legal-entity identity, not a business field value,
 * so it has no `FieldTypeSchema` spelling. Normalization derives this type for
 * exactly the parameter a `queryLegalEntityScope` names.
 */
const legalEntityReferenceParameterType = z.strictObject({
  kind: z.literal('legalEntityReferenceParameterType'),
  schemaVersion: v4PlusNodeVersion,
});
const normalizedV4QueryParameterDefinition =
  authoredQueryParameterDefinition.extend({
    parameterType: z.union([
      FieldTypeSchema,
      legalEntityReferenceParameterType,
    ]),
  });

// v4 admits parameters on row queries so a Q0 read of an entity-owned family
// can carry the same operand an aggregate does. Without it the four Q0 reads
// over an entity-owned family stay unaskable and release verification has no
// declared contract to probe.
const normalizedV4RowQueryDefinition = normalizedV3RowQueryDefinition.extend({
  legalEntityScope: queryLegalEntityScope.optional(),
  parameters: z
    .array(normalizedV4QueryParameterDefinition)
    .max(QUERY_PARAMETER_LIMIT_V3),
  schemaVersion: v4PlusNodeVersion,
});
const authoredV4RowQueryDefinition = normalizedV4RowQueryDefinition.extend({
  filter: v3PredicateExpressionSchema.optional(),
  lifecycle: z.enum(['active', 'retired']).optional(),
  parameters: z
    .array(authoredQueryParameterDefinition)
    .max(QUERY_PARAMETER_LIMIT_V3)
    .optional(),
  resolveMatchKeys: z.array(resolveMatchKey).optional(),
});
const normalizedV4AggregateQueryDefinition =
  normalizedAggregateQueryDefinition.extend({
    legalEntityScope: queryLegalEntityScope.optional(),
    parameters: z
      .array(normalizedV4QueryParameterDefinition)
      .max(QUERY_PARAMETER_LIMIT_V3),
    schemaVersion: v4PlusNodeVersion,
  });
const authoredV4AggregateQueryDefinition =
  authoredAggregateQueryDefinition.extend({
    legalEntityScope: queryLegalEntityScope.optional(),
    schemaVersion: v4PlusNodeVersion,
  });

const normalizedV4QueryDefinition = z.union([
  normalizedV4RowQueryDefinition,
  normalizedV4AggregateQueryDefinition,
]);
const authoredV4QueryDefinition = z.union([
  authoredV4RowQueryDefinition,
  authoredV4AggregateQueryDefinition,
]);

const operationEffect = z.discriminatedUnion('kind', [
  z.strictObject({
    entity: CanonicalReferenceSchema,
    kind: z.literal('createRecordEffect'),
    schemaVersion: nodeVersion,
  }),
  z.strictObject({
    entity: CanonicalReferenceSchema,
    kind: z.literal('updateRecordEffect'),
    schemaVersion: nodeVersion,
  }),
  z.strictObject({
    entity: CanonicalReferenceSchema,
    kind: z.literal('archiveRecordEffect'),
    schemaVersion: nodeVersion,
  }),
  z.strictObject({
    entity: CanonicalReferenceSchema,
    kind: z.literal('restoreRecordEffect'),
    schemaVersion: nodeVersion,
  }),
  z.strictObject({
    entity: CanonicalReferenceSchema,
    kind: z.literal('deleteRecordEffect'),
    schemaVersion: nodeVersion,
  }),
  z.strictObject({
    entity: CanonicalReferenceSchema,
    kind: z.literal('purgeRecordEffect'),
    schemaVersion: nodeVersion,
  }),
  z.strictObject({
    entity: CanonicalReferenceSchema,
    kind: z.literal('destroyRecordEffect'),
    schemaVersion: nodeVersion,
  }),
  z.strictObject({
    kind: z.literal('transitionStateEffect'),
    schemaVersion: nodeVersion,
    transition: CanonicalReferenceSchema,
  }),
  z.strictObject({
    capability: CanonicalReferenceSchema,
    kind: z.literal('registeredCapabilityEffect'),
    schemaVersion: nodeVersion,
  }),
]);
const normalizedOperationDefinition = z.strictObject({
  confirmation: z.enum(['none', 'humanRequired']),
  effect: operationEffect,
  kind: z.literal('operationDefinition'),
  lifecycle: z.enum(['active', 'retired']),
  module: CanonicalReferenceSchema,
  operationId: CanonicalIdSchema,
  permission: CanonicalReferenceSchema,
  precondition: legacyPredicateExpressionSchema,
  readBack: CanonicalReferenceSchema,
  schemaVersion: nodeVersion,
  tier: z.enum(['o0', 'o1']),
});
const authoredOperationDefinition = normalizedOperationDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
  precondition: legacyPredicateExpressionSchema.optional(),
});
const normalizedV3OperationDefinition = normalizedOperationDefinition.extend({
  precondition: v3PredicateExpressionSchema,
  schemaVersion: v3PlusNodeVersion,
});
const authoredV3OperationDefinition = normalizedV3OperationDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
  precondition: v3PredicateExpressionSchema.optional(),
});

const normalizedPermissionDefinition = z.strictObject({
  action: z.enum([
    'create',
    'read',
    'update',
    'archive',
    'restore',
    'transition',
  ]),
  kind: z.literal('permissionDefinition'),
  label: LabelSchema,
  lifecycle: z.enum(['active', 'retired']),
  permissionId: CanonicalIdSchema,
  resource: CanonicalReferenceSchema,
  schemaVersion: nodeVersion,
});
const authoredPermissionDefinition = normalizedPermissionDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
});

const assertionInvocation = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('queryInvocation'),
    query: CanonicalReferenceSchema,
    schemaVersion: nodeVersion,
  }),
  z.strictObject({
    kind: z.literal('operationInvocation'),
    operation: CanonicalReferenceSchema,
    schemaVersion: nodeVersion,
  }),
]);
const normalizedAssertionDefinition = z.strictObject({
  assertionId: CanonicalIdSchema,
  evidenceKinds: z.array(
    z.enum([
      'structure',
      'provider',
      'userInterface',
      'agent',
      'migration',
      'recovery',
    ]),
  ),
  expectedOutcome: z.enum(['succeeds', 'fails']),
  expectedDiagnosticCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .nullable(),
  invocation: assertionInvocation,
  kind: z.literal('assertionDefinition'),
  lifecycle: z.enum(['active', 'retired']),
  schemaVersion: nodeVersion,
});
const authoredAssertionDefinition = normalizedAssertionDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
});

const normalizedStorageMappingDefinition = z.strictObject({
  entity: CanonicalReferenceSchema,
  kind: z.literal('storageMappingDefinition'),
  lifecycle: z.enum(['active', 'retired']),
  promotion: z
    .strictObject({
      capabilityId: z.literal(PROMOTE_STORAGE_CLASS_CAPABILITY_ID),
      invariantVersion: z.literal(
        'northstar.storage-class-promotion-invariant/v1',
      ),
      kind: z.literal('storageClassPromotionReserve'),
      schemaVersion: nodeVersion,
    })
    .optional(),
  schemaVersion: nodeVersion,
  storageClass: z
    .enum(['dedicatedTable', 'generatedTyped'])
    .nullable()
    .optional(),
  storageMappingId: CanonicalIdSchema,
});
const authoredStorageMappingDefinition =
  normalizedStorageMappingDefinition.extend({
    lifecycle: z.enum(['active', 'retired']).optional(),
  });

const normalizedCapabilityRequirement = z.strictObject({
  capabilityId: CanonicalIdSchema,
  capabilityVersion: positiveVersion,
  declaredEffects: z
    .array(z.enum(['read', 'recordMutation', 'appendFact', 'externalEffect']))
    .min(1),
  kind: z.literal('capabilityRequirement'),
  lifecycle: z.enum(['active', 'retired']),
  requiredProjections: z
    .array(
      z.enum([
        'storage',
        'policy',
        'query',
        'operation',
        'surface',
        'agent',
        'reporting',
        'verification',
      ]),
    )
    .min(1),
  schemaVersion: nodeVersion,
  supportStatus: z.enum(['supported', 'preview', 'planned', 'unsupported']),
});
const authoredCapabilityRequirement = normalizedCapabilityRequirement.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
});

const legacyNormalizedShape = {
  assertions: z.array(normalizedAssertionDefinition),
  canonicalizationProfileVersion: z.literal(CANONICALIZATION_PROFILE_VERSION),
  capabilityRequirements: z.array(normalizedCapabilityRequirement),
  entities: z.array(normalizedEntityDefinition),
  fields: z.array(normalizedFieldDefinition),
  hashAlgorithm: z.literal(CONTENT_HASH_ALGORITHM),
  kind: z.literal('applicationPackageRevision'),
  languageVersion: legacyNodeVersion,
  modules: z.array(normalizedModuleDefinition),
  normalizationProfileVersion: z.enum(SUPPORTED_NORMALIZATION_PROFILE_VERSIONS),
  operations: z.array(normalizedOperationDefinition),
  package: normalizedPackageDefinition,
  permissions: z.array(normalizedPermissionDefinition),
  queries: z.array(normalizedRowQueryDefinition),
  relations: z.array(normalizedRelationDefinition),
  schemaVersion: nodeVersion,
  stateMachines: z.array(normalizedStateMachineDefinition),
  storageMappings: z.array(normalizedStorageMappingDefinition),
  surfaces: z.array(normalizedSurfaceDefinition),
} as const;

const v3NormalizedShape = {
  ...legacyNormalizedShape,
  fields: z.array(normalizedV3FieldDefinition),
  // The collection is the v3 closed-set reservation. Row 4d owns its element
  // spelling, so 4b deliberately admits no impact-analysis content.
  impactAnalyses: z.tuple([]),
  languageVersion: v3NodeVersion,
  operations: z.array(normalizedV3OperationDefinition),
  queries: z.array(normalizedV3QueryDefinition),
} as const;

// v4 adds no family collection. It changes exactly one family's element shape,
// so a v4 package that declares no legal-entity scope is byte-identical to the
// same package at v3 apart from its version strings.
const v4NormalizedShape = {
  ...v3NormalizedShape,
  languageVersion: v4NodeVersion,
  queries: z.array(normalizedV4QueryDefinition),
} as const;

const LegacyNormalizedApplicationPackageSchema = z.strictObject(
  legacyNormalizedShape,
);
// v5 adds no family collection and changes no element shape. It changes what
// normalization DERIVES: each state machine's state field is materialized as
// an ordinary enumeration field on its entity (ADR-0050). The authored surface
// is untouched, which is why the cut moves no recorded release root -- only a
// package that declares a state machine normalizes differently, and no
// first-party module declares one.
const v5NormalizedShape = {
  ...v4NormalizedShape,
  languageVersion: v5NodeVersion,
} as const;

export const QueryReadModelSchema = z.strictObject({
  capability: compositionReference('capabilityReference'),
  binding: CanonicalIdSchema,
  queries: z.record(z.string().min(1), compositionReference('queryReference')),
  resultFields: z.record(z.string().min(1), CanonicalIdSchema),
});
export type QueryReadModel = z.infer<typeof QueryReadModelSchema>;
const normalizedV6QueryDefinition = z.union([
  normalizedV4RowQueryDefinition.extend({
    readModel: QueryReadModelSchema.optional(),
  }),
  normalizedV4AggregateQueryDefinition,
]);
const authoredV6QueryDefinition = z.union([
  authoredV4RowQueryDefinition.extend({
    readModel: QueryReadModelSchema.optional(),
  }),
  authoredV4AggregateQueryDefinition,
]);

const v6NormalizedShape = {
  ...v5NormalizedShape,
  queries: z.array(normalizedV6QueryDefinition),
  languageVersion: v6NodeVersion,
  surfaces: z.array(normalizedV6SurfaceDefinition),
} as const;
const V6NormalizedApplicationPackageSchema = z.strictObject(v6NormalizedShape);

const V3NormalizedApplicationPackageSchema = z.strictObject(v3NormalizedShape);
const V4NormalizedApplicationPackageSchema = z.strictObject(v4NormalizedShape);
const V5NormalizedApplicationPackageSchema = z.strictObject(v5NormalizedShape);

/**
 * Marker carried on the purity issue so a canonical diagnostic can name it.
 * Node schemas for the v3 family admit v3 and v4 (v4 reads every v3 node), so
 * "one package uses one language version" cannot be expressed structurally.
 * It is enforced HERE, on the exported schemas, rather than at each function
 * parser — every entry point that skipped such a guard was a hole, and adding
 * a guard per entry point makes the next entry point the next hole.
 */
export const MIXED_NODE_VERSION_ISSUE = 'canonical:mixed-node-version';

function collectMixedNodeVersions(
  value: unknown,
  languageVersion: string,
  path: (string | number)[],
  found: { path: (string | number)[] }[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectMixedNodeVersions(entry, languageVersion, [...path, index], found),
    );
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.schemaVersion === 'string' &&
    record.schemaVersion !== languageVersion
  ) {
    found.push({ path: [...path, 'schemaVersion'] });
  }
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'schemaVersion') continue;
    collectMixedNodeVersions(entry, languageVersion, [...path, key], found);
  }
}

function withNodeVersionPurity<T extends z.ZodTypeAny>(schema: T): T {
  return schema.superRefine((value: unknown, context: z.RefinementCtx) => {
    if (typeof value !== 'object' || value === null) return;
    const languageVersion = (value as { languageVersion?: unknown })
      .languageVersion;
    if (typeof languageVersion !== 'string') return;
    const found: { path: (string | number)[] }[] = [];
    collectMixedNodeVersions(value, languageVersion, [], found);
    for (const entry of found) {
      context.addIssue({
        code: 'custom',
        message: MIXED_NODE_VERSION_ISSUE,
        path: entry.path,
      });
    }
  }) as unknown as T;
}

export const VersionedNormalizedApplicationPackageSchema =
  withNodeVersionPurity(
    z.discriminatedUnion('languageVersion', [
      LegacyNormalizedApplicationPackageSchema,
      V3NormalizedApplicationPackageSchema,
      V4NormalizedApplicationPackageSchema,
      V5NormalizedApplicationPackageSchema,
      V6NormalizedApplicationPackageSchema,
    ]),
  );
export const NormalizedApplicationPackageSchema =
  LegacyNormalizedApplicationPackageSchema;

const legacyAuthoredShape = {
  assertions: z.array(authoredAssertionDefinition),
  canonicalizationProfileVersion: z
    .literal(CANONICALIZATION_PROFILE_VERSION)
    .optional(),
  capabilityRequirements: z.array(authoredCapabilityRequirement),
  entities: z.array(authoredEntityDefinition),
  fields: z.array(authoredFieldDefinition),
  hashAlgorithm: z.literal(CONTENT_HASH_ALGORITHM).optional(),
  kind: z.literal('applicationPackageRevision'),
  languageVersion: legacyNodeVersion,
  modules: z.array(authoredModuleDefinition),
  normalizationProfileVersion: z
    .enum(SUPPORTED_NORMALIZATION_PROFILE_VERSIONS)
    .optional(),
  operations: z.array(authoredOperationDefinition),
  package: authoredPackageDefinition,
  permissions: z.array(authoredPermissionDefinition),
  queries: z.array(authoredRowQueryDefinition),
  relations: z.array(authoredRelationDefinition),
  schemaVersion: nodeVersion,
  stateMachines: z.array(authoredStateMachineDefinition),
  storageMappings: z.array(authoredStorageMappingDefinition),
  surfaces: z.array(authoredSurfaceDefinition),
} as const;

const v3AuthoredShape = {
  ...legacyAuthoredShape,
  fields: z.array(authoredV3FieldDefinition),
  impactAnalyses: z.tuple([]),
  languageVersion: v3NodeVersion,
  operations: z.array(authoredV3OperationDefinition),
  queries: z.array(authoredV3QueryDefinition),
} as const;

const v4AuthoredShape = {
  ...v3AuthoredShape,
  languageVersion: v4NodeVersion,
  queries: z.array(authoredV4QueryDefinition),
} as const;

const v5AuthoredShape = {
  ...v4AuthoredShape,
  languageVersion: v5NodeVersion,
} as const;

const v6AuthoredShape = {
  ...v5AuthoredShape,
  queries: z.array(authoredV6QueryDefinition),
  languageVersion: v6NodeVersion,
  surfaces: z.array(authoredV6SurfaceDefinition),
} as const;
const V6AuthoredApplicationPackageSchema = z.strictObject(v6AuthoredShape);

const LegacyAuthoredApplicationPackageSchema =
  z.strictObject(legacyAuthoredShape);
const V3AuthoredApplicationPackageSchema = z.strictObject(v3AuthoredShape);
const V4AuthoredApplicationPackageSchema = z.strictObject(v4AuthoredShape);
const V5AuthoredApplicationPackageSchema = z.strictObject(v5AuthoredShape);

export const VersionedAuthoredApplicationPackageSchema = withNodeVersionPurity(
  z.discriminatedUnion('languageVersion', [
    LegacyAuthoredApplicationPackageSchema,
    V3AuthoredApplicationPackageSchema,
    V4AuthoredApplicationPackageSchema,
    V5AuthoredApplicationPackageSchema,
    V6AuthoredApplicationPackageSchema,
  ]),
);
export const AuthoredApplicationPackageSchema =
  LegacyAuthoredApplicationPackageSchema;

/** Current adopted package shape. Runtime and provider consumers stay on v2. */
export type AuthoredApplicationPackage = z.infer<
  typeof LegacyAuthoredApplicationPackageSchema
>;
export type NormalizedApplicationPackage = z.infer<
  typeof LegacyNormalizedApplicationPackageSchema
>;
export type V3AuthoredApplicationPackage = z.infer<
  typeof V3AuthoredApplicationPackageSchema
>;
export type V3NormalizedApplicationPackage = z.infer<
  typeof V3NormalizedApplicationPackageSchema
>;
export type V4AuthoredApplicationPackage = z.infer<
  typeof V4AuthoredApplicationPackageSchema
>;
export type V4NormalizedApplicationPackage = z.infer<
  typeof V4NormalizedApplicationPackageSchema
>;
export type V5AuthoredApplicationPackage = z.infer<
  typeof V5AuthoredApplicationPackageSchema
>;
export type V5NormalizedApplicationPackage = z.infer<
  typeof V5NormalizedApplicationPackageSchema
>;
export type V6AuthoredApplicationPackage = z.infer<
  typeof V6AuthoredApplicationPackageSchema
>;
export type V6NormalizedApplicationPackage = z.infer<
  typeof V6NormalizedApplicationPackageSchema
>;
export type QueryLegalEntityScope = z.infer<typeof queryLegalEntityScope>;
export type VersionedAuthoredApplicationPackage =
  | AuthoredApplicationPackage
  | V3AuthoredApplicationPackage
  | V4AuthoredApplicationPackage
  | V5AuthoredApplicationPackage
  | V6AuthoredApplicationPackage;
export type VersionedNormalizedApplicationPackage =
  | NormalizedApplicationPackage
  | V3NormalizedApplicationPackage
  | V4NormalizedApplicationPackage
  | V5NormalizedApplicationPackage
  | V6NormalizedApplicationPackage;
export type CanonicalId = z.infer<typeof CanonicalIdSchema>;

function isValidIsoDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1)
    return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function isValidIsoTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?$/.exec(value);
  if (!match) return false;
  return (
    Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3]) < 60
  );
}

function isValidIsoDateTime(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !isValidIsoDate(match[1]!) || !isValidIsoTime(match[2]!)) {
    return false;
  }
  if (match[3] === 'Z') return true;
  if (match[3] === '-00:00') return false;
  const offsetHour = Number(match[4]);
  const offsetMinute = Number(match[5]);
  return (
    offsetMinute < 60 &&
    (offsetHour < 14 || (offsetHour === 14 && offsetMinute === 0))
  );
}
