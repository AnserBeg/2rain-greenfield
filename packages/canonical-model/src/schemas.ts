import { z } from 'zod';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  CURRENCY_MINOR_UNITS_V0,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  STATUS_ROLES,
  SURFACE_ARCHETYPES,
} from './constants.js';

const nodeVersion = z.literal(LANGUAGE_VERSION);
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
      schemaVersion: typeof LANGUAGE_VERSION;
      value: boolean;
    }
  | {
      field: z.infer<typeof CanonicalReferenceSchema>;
      kind: 'fieldComparisonPredicate';
      operator: 'equals' | 'notEquals' | 'lessThan' | 'greaterThan';
      schemaVersion: typeof LANGUAGE_VERSION;
      value: CanonicalScalar;
    }
  | {
      kind: 'allPredicate' | 'anyPredicate';
      schemaVersion: typeof LANGUAGE_VERSION;
      terms: PredicateExpression[];
    }
  | {
      kind: 'notPredicate';
      schemaVersion: typeof LANGUAGE_VERSION;
      term: PredicateExpression;
    };

export type CanonicalScalar =
  | {
      kind: 'textValue';
      schemaVersion: typeof LANGUAGE_VERSION;
      value: string;
    }
  | {
      kind: 'booleanValue';
      schemaVersion: typeof LANGUAGE_VERSION;
      value: boolean;
    }
  | {
      kind: 'integerValue' | 'exactDecimalValue';
      schemaVersion: typeof LANGUAGE_VERSION;
      value: string;
    }
  | {
      currencyCode: string;
      kind: 'moneyValue';
      minorUnit: number;
      schemaVersion: typeof LANGUAGE_VERSION;
      value: string;
    }
  | {
      kind: 'dateValue' | 'timeValue' | 'dateTimeValue';
      schemaVersion: typeof LANGUAGE_VERSION;
      value: string;
    }
  | {
      baseUnit: z.infer<typeof CanonicalReferenceSchema>;
      kind: 'quantityValue';
      schemaVersion: typeof LANGUAGE_VERSION;
      value: string;
    };

export const CanonicalScalarSchema: z.ZodType<CanonicalScalar> =
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('textValue'),
      schemaVersion: nodeVersion,
      value: z.string().max(4_000),
    }),
    z.strictObject({
      kind: z.literal('booleanValue'),
      schemaVersion: nodeVersion,
      value: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal('integerValue'),
      schemaVersion: nodeVersion,
      value: CanonicalIntegerStringSchema,
    }),
    z.strictObject({
      kind: z.literal('exactDecimalValue'),
      schemaVersion: nodeVersion,
      value: CanonicalDecimalStringSchema,
    }),
    z
      .strictObject({
        currencyCode: CurrencyCodeSchema,
        kind: z.literal('moneyValue'),
        minorUnit: z.int().min(0).max(6),
        schemaVersion: nodeVersion,
        value: CanonicalDecimalStringSchema,
      })
      .refine(
        (value) =>
          CURRENCY_MINOR_UNITS_V0[value.currencyCode] === value.minorUnit,
      ),
    z.strictObject({
      kind: z.literal('dateValue'),
      schemaVersion: nodeVersion,
      value: IsoDateValueSchema,
    }),
    z.strictObject({
      kind: z.literal('timeValue'),
      schemaVersion: nodeVersion,
      value: IsoTimeValueSchema,
    }),
    z.strictObject({
      kind: z.literal('dateTimeValue'),
      schemaVersion: nodeVersion,
      value: IsoDateTimeValueSchema,
    }),
    z.strictObject({
      baseUnit: CanonicalReferenceSchema,
      kind: z.literal('quantityValue'),
      schemaVersion: nodeVersion,
      value: CanonicalDecimalStringSchema,
    }),
  ]);

export const PredicateExpressionSchema: z.ZodType<PredicateExpression> = z.lazy(
  () =>
    z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('booleanPredicate'),
        schemaVersion: nodeVersion,
        value: z.boolean(),
      }),
      z.strictObject({
        field: CanonicalReferenceSchema,
        kind: z.literal('fieldComparisonPredicate'),
        operator: z.enum(['equals', 'notEquals', 'lessThan', 'greaterThan']),
        schemaVersion: nodeVersion,
        value: CanonicalScalarSchema,
      }),
      z.strictObject({
        kind: z.literal('allPredicate'),
        schemaVersion: nodeVersion,
        terms: z.array(PredicateExpressionSchema),
      }),
      z.strictObject({
        kind: z.literal('anyPredicate'),
        schemaVersion: nodeVersion,
        terms: z.array(PredicateExpressionSchema),
      }),
      z.strictObject({
        kind: z.literal('notPredicate'),
        schemaVersion: nodeVersion,
        term: PredicateExpressionSchema,
      }),
    ]),
);

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
  classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
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
  schemaVersion: nodeVersion,
  slots: z.array(surfaceSlot),
  statusRoles: z.array(z.enum(STATUS_ROLES)),
  surfaceId: CanonicalIdSchema,
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
const normalizedQueryDefinition = z.strictObject({
  filter: PredicateExpressionSchema,
  kind: z.literal('queryDefinition'),
  lifecycle: z.enum(['active', 'retired']),
  maximumResultCount: boundedCount,
  module: CanonicalReferenceSchema,
  permission: CanonicalReferenceSchema,
  queryId: CanonicalIdSchema,
  queryType: z.enum(['get', 'list', 'resolve']),
  schemaVersion: nodeVersion,
  selections: z.array(querySelection).min(1),
  sourceEntity: CanonicalReferenceSchema,
  tier: z.enum(['q0', 'q1']),
});
const authoredQueryDefinition = normalizedQueryDefinition.extend({
  filter: PredicateExpressionSchema.optional(),
  lifecycle: z.enum(['active', 'retired']).optional(),
});

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
  precondition: PredicateExpressionSchema,
  readBack: CanonicalReferenceSchema,
  schemaVersion: nodeVersion,
  tier: z.enum(['o0', 'o1']),
});
const authoredOperationDefinition = normalizedOperationDefinition.extend({
  lifecycle: z.enum(['active', 'retired']).optional(),
  precondition: PredicateExpressionSchema.optional(),
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
  schemaVersion: nodeVersion,
  storageClass: z.enum(['dedicatedTable', 'generatedTyped']),
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

const normalizedShape = {
  assertions: z.array(normalizedAssertionDefinition),
  canonicalizationProfileVersion: z.literal(CANONICALIZATION_PROFILE_VERSION),
  capabilityRequirements: z.array(normalizedCapabilityRequirement),
  entities: z.array(normalizedEntityDefinition),
  fields: z.array(normalizedFieldDefinition),
  hashAlgorithm: z.literal(CONTENT_HASH_ALGORITHM),
  kind: z.literal('applicationPackageRevision'),
  languageVersion: z.literal(LANGUAGE_VERSION),
  modules: z.array(normalizedModuleDefinition),
  normalizationProfileVersion: z.literal(NORMALIZATION_PROFILE_VERSION),
  operations: z.array(normalizedOperationDefinition),
  package: normalizedPackageDefinition,
  permissions: z.array(normalizedPermissionDefinition),
  queries: z.array(normalizedQueryDefinition),
  relations: z.array(normalizedRelationDefinition),
  schemaVersion: nodeVersion,
  stateMachines: z.array(normalizedStateMachineDefinition),
  storageMappings: z.array(normalizedStorageMappingDefinition),
  surfaces: z.array(normalizedSurfaceDefinition),
} as const;

export const NormalizedApplicationPackageSchema =
  z.strictObject(normalizedShape);

export const AuthoredApplicationPackageSchema = z.strictObject({
  assertions: z.array(authoredAssertionDefinition),
  canonicalizationProfileVersion: z
    .literal(CANONICALIZATION_PROFILE_VERSION)
    .optional(),
  capabilityRequirements: z.array(authoredCapabilityRequirement),
  entities: z.array(authoredEntityDefinition),
  fields: z.array(authoredFieldDefinition),
  hashAlgorithm: z.literal(CONTENT_HASH_ALGORITHM).optional(),
  kind: z.literal('applicationPackageRevision'),
  languageVersion: z.literal(LANGUAGE_VERSION),
  modules: z.array(authoredModuleDefinition),
  normalizationProfileVersion: z
    .literal(NORMALIZATION_PROFILE_VERSION)
    .optional(),
  operations: z.array(authoredOperationDefinition),
  package: authoredPackageDefinition,
  permissions: z.array(authoredPermissionDefinition),
  queries: z.array(authoredQueryDefinition),
  relations: z.array(authoredRelationDefinition),
  schemaVersion: nodeVersion,
  stateMachines: z.array(authoredStateMachineDefinition),
  storageMappings: z.array(authoredStorageMappingDefinition),
  surfaces: z.array(authoredSurfaceDefinition),
});

export type AuthoredApplicationPackage = z.infer<
  typeof AuthoredApplicationPackageSchema
>;
export type NormalizedApplicationPackage = z.infer<
  typeof NormalizedApplicationPackageSchema
>;
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
