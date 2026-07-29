import { z } from 'zod';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  CURRENCY_MINOR_UNITS_V0,
  PROMOTE_STORAGE_CLASS_CAPABILITY_ID,
  QUERY_PARAMETER_LIMIT_V3,
  SUPPORTED_LANGUAGE_VERSIONS,
  SUPPORTED_NORMALIZATION_PROFILE_VERSIONS,
  STATUS_ROLES,
  SURFACE_ARCHETYPES,
  type CanonicalLanguageVersion,
} from './constants.js';

const nodeVersion = z.enum(SUPPORTED_LANGUAGE_VERSIONS);
const legacyNodeVersion = z.enum(['v0-experimental', 'v1', 'v2']);
const v3NodeVersion = z.literal('v3');
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

export type PredicateExpression =
  | {
      kind: 'booleanPredicate';
      schemaVersion: CanonicalLanguageVersion;
      value: boolean;
    }
  | {
      field: z.infer<typeof CanonicalReferenceSchema>;
      kind: 'fieldComparisonPredicate';
      operator: 'equals' | 'notEquals' | 'lessThan' | 'greaterThan';
      schemaVersion: CanonicalLanguageVersion;
      value: CanonicalScalar;
    }
  | {
      kind: 'allPredicate' | 'anyPredicate';
      schemaVersion: CanonicalLanguageVersion;
      terms: PredicateExpression[];
    }
  | {
      kind: 'notPredicate';
      schemaVersion: CanonicalLanguageVersion;
      term: PredicateExpression;
    };

export type PredicateExpressionV3 =
  | {
      kind: 'booleanPredicate';
      schemaVersion: 'v3';
      value: boolean;
    }
  | {
      field: z.infer<typeof CanonicalReferenceSchema>;
      kind: 'fieldComparisonPredicate';
      operator:
        | 'equals'
        | 'notEquals'
        | 'lessThan'
        | 'greaterThan'
        | 'greaterThanOrEqual'
        | 'lessThanOrEqual';
      schemaVersion: 'v3';
      value: CanonicalScalar | QueryParameterReference;
    }
  | {
      kind: 'allPredicate' | 'anyPredicate';
      schemaVersion: 'v3';
      terms: PredicateExpressionV3[];
    }
  | {
      kind: 'notPredicate';
      schemaVersion: 'v3';
      term: PredicateExpressionV3;
    };

export type VersionedPredicateExpression =
  PredicateExpression | PredicateExpressionV3;

export interface QueryParameterReference {
  readonly kind: 'queryParameterReference';
  readonly parameterId: z.infer<typeof CanonicalIdSchema>;
  readonly schemaVersion: 'v3';
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
      schemaVersion: v3NodeVersion,
      value: z.string().max(4_000),
    }),
    z.strictObject({
      kind: z.literal('booleanValue'),
      schemaVersion: v3NodeVersion,
      value: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal('integerValue'),
      schemaVersion: v3NodeVersion,
      value: CanonicalIntegerStringSchema,
    }),
    z.strictObject({
      kind: z.literal('exactDecimalValue'),
      schemaVersion: v3NodeVersion,
      value: CanonicalSignedDecimalStringSchema,
    }),
    z
      .strictObject({
        currencyCode: CurrencyCodeSchema,
        kind: z.literal('moneyValue'),
        minorUnit: z.int().min(0).max(6),
        schemaVersion: v3NodeVersion,
        value: CanonicalSignedDecimalStringSchema,
      })
      .refine(
        (value) =>
          CURRENCY_MINOR_UNITS_V0[value.currencyCode] === value.minorUnit,
      ),
    z.strictObject({
      kind: z.literal('dateValue'),
      schemaVersion: v3NodeVersion,
      value: IsoDateValueSchema,
    }),
    z.strictObject({
      kind: z.literal('timeValue'),
      schemaVersion: v3NodeVersion,
      value: IsoTimeValueSchema,
    }),
    z.strictObject({
      kind: z.literal('dateTimeValue'),
      schemaVersion: v3NodeVersion,
      value: IsoDateTimeValueSchema,
    }),
    z.strictObject({
      baseUnit: CanonicalReferenceSchema,
      kind: z.literal('quantityValue'),
      schemaVersion: v3NodeVersion,
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
    schemaVersion: v3NodeVersion,
  });

const legacyPredicateExpressionSchema: z.ZodType<PredicateExpression> = z.lazy(
  () =>
    z.union([
      z.strictObject({
        kind: z.literal('booleanPredicate'),
        schemaVersion: legacyNodeVersion,
        value: z.boolean(),
      }),
      z.strictObject({
        field: CanonicalReferenceSchema,
        kind: z.literal('fieldComparisonPredicate'),
        operator: z.enum(['equals', 'notEquals', 'lessThan', 'greaterThan']),
        schemaVersion: legacyNodeVersion,
        value: legacyCanonicalScalarSchema,
      }),
      z.strictObject({
        kind: z.literal('allPredicate'),
        schemaVersion: legacyNodeVersion,
        terms: z.array(legacyPredicateExpressionSchema),
      }),
      z.strictObject({
        kind: z.literal('anyPredicate'),
        schemaVersion: legacyNodeVersion,
        terms: z.array(legacyPredicateExpressionSchema),
      }),
      z.strictObject({
        kind: z.literal('notPredicate'),
        schemaVersion: legacyNodeVersion,
        term: legacyPredicateExpressionSchema,
      }),
    ]),
);

const v3PredicateExpressionSchema: z.ZodType<PredicateExpressionV3> = z.lazy(
  () =>
    z.union([
      z.strictObject({
        kind: z.literal('booleanPredicate'),
        schemaVersion: v3NodeVersion,
        value: z.boolean(),
      }),
      z.strictObject({
        field: CanonicalReferenceSchema,
        kind: z.literal('fieldComparisonPredicate'),
        operator: z.enum([
          'equals',
          'notEquals',
          'lessThan',
          'greaterThan',
          'greaterThanOrEqual',
          'lessThanOrEqual',
        ]),
        schemaVersion: v3NodeVersion,
        value: z.union([
          v3CanonicalScalarSchema,
          QueryParameterReferenceSchema,
        ]),
      }),
      z.strictObject({
        kind: z.literal('allPredicate'),
        schemaVersion: v3NodeVersion,
        terms: z.array(v3PredicateExpressionSchema),
      }),
      z.strictObject({
        kind: z.literal('anyPredicate'),
        schemaVersion: v3NodeVersion,
        terms: z.array(v3PredicateExpressionSchema),
      }),
      z.strictObject({
        kind: z.literal('notPredicate'),
        schemaVersion: v3NodeVersion,
        term: v3PredicateExpressionSchema,
      }),
    ]),
);

const v3CompatibilityPredicateExpressionSchema: z.ZodType<PredicateExpression> =
  z.lazy(() =>
    z.union([
      z.strictObject({
        kind: z.literal('booleanPredicate'),
        schemaVersion: v3NodeVersion,
        value: z.boolean(),
      }),
      z.strictObject({
        field: CanonicalReferenceSchema,
        kind: z.literal('fieldComparisonPredicate'),
        operator: z.enum(['equals', 'notEquals', 'lessThan', 'greaterThan']),
        schemaVersion: v3NodeVersion,
        value: v3CanonicalScalarSchema,
      }),
      z.strictObject({
        kind: z.literal('allPredicate'),
        schemaVersion: v3NodeVersion,
        terms: z.array(v3CompatibilityPredicateExpressionSchema),
      }),
      z.strictObject({
        kind: z.literal('anyPredicate'),
        schemaVersion: v3NodeVersion,
        terms: z.array(v3CompatibilityPredicateExpressionSchema),
      }),
      z.strictObject({
        kind: z.literal('notPredicate'),
        schemaVersion: v3NodeVersion,
        term: v3CompatibilityPredicateExpressionSchema,
      }),
    ]),
  );

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

const normalizedRelationDefinition = z.strictObject({
  archiveBehavior: z.enum(['restrict', 'retainReference']),
  cardinality: z.enum(['oneToOne', 'manyToOne', 'oneToMany']),
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
  schemaVersion: v3NodeVersion,
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
  schemaVersion: v3NodeVersion,
});
const normalizedQueryParameterDefinition =
  authoredQueryParameterDefinition.extend({
    parameterType: FieldTypeSchema,
  });
const authoredQueryAggregateSelection = z.strictObject({
  field: CanonicalReferenceSchema,
  kind: z.literal('queryAggregateSelection'),
  operator: z.literal('sum'),
  schemaVersion: v3NodeVersion,
  selectionId: CanonicalIdSchema,
});
const normalizedQueryAggregateSelection =
  authoredQueryAggregateSelection.extend({
    resultType: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('exactDecimalAggregateResultType'),
        precision: z.literal(38),
        scale: z.int().min(0).max(18),
        schemaVersion: v3NodeVersion,
      }),
      z.strictObject({
        baseUnit: CanonicalReferenceSchema,
        kind: z.literal('quantityAggregateResultType'),
        precision: z.literal(38),
        scale: z.int().min(0).max(18),
        schemaVersion: v3NodeVersion,
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
  schemaVersion: v3NodeVersion,
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
  schemaVersion: v3NodeVersion,
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
  schemaVersion: v3NodeVersion,
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
  // The collection is the v3 closed-set reservation. Row 4d owns its element
  // spelling, so 4b deliberately admits no impact-analysis content.
  impactAnalyses: z.tuple([]),
  languageVersion: v3NodeVersion,
  operations: z.array(normalizedV3OperationDefinition),
  queries: z.array(normalizedV3QueryDefinition),
} as const;

const LegacyNormalizedApplicationPackageSchema = z.strictObject(
  legacyNormalizedShape,
);
const V3NormalizedApplicationPackageSchema = z.strictObject(v3NormalizedShape);

export const VersionedNormalizedApplicationPackageSchema = z.discriminatedUnion(
  'languageVersion',
  [
    LegacyNormalizedApplicationPackageSchema,
    V3NormalizedApplicationPackageSchema,
  ],
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
  impactAnalyses: z.tuple([]),
  languageVersion: v3NodeVersion,
  operations: z.array(authoredV3OperationDefinition),
  queries: z.array(authoredV3QueryDefinition),
} as const;

const LegacyAuthoredApplicationPackageSchema =
  z.strictObject(legacyAuthoredShape);
const V3AuthoredApplicationPackageSchema = z.strictObject(v3AuthoredShape);

export const VersionedAuthoredApplicationPackageSchema = z.discriminatedUnion(
  'languageVersion',
  [LegacyAuthoredApplicationPackageSchema, V3AuthoredApplicationPackageSchema],
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
export type VersionedAuthoredApplicationPackage =
  AuthoredApplicationPackage | V3AuthoredApplicationPackage;
export type VersionedNormalizedApplicationPackage =
  NormalizedApplicationPackage | V3NormalizedApplicationPackage;
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
