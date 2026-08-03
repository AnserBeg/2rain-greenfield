import {
  FIXTURE_LANGUAGE_VERSION,
  ordinaryModuleV2ForNamespace,
} from '../g2/module-conformance/definitions.js';

export const DIMENSION_REPLAY_NAMESPACE = 'northstar.g3r2fixture';

const version = FIXTURE_LANGUAGE_VERSION;

export const DIMENSION_REPLAY_IDS = Object.freeze({
  entity: `${DIMENSION_REPLAY_NAMESPACE}:entity.master`,
  fields: {
    addedDimension: `${DIMENSION_REPLAY_NAMESPACE}:field.master_batch`,
    effectiveAt: `${DIMENSION_REPLAY_NAMESPACE}:field.master_utc_instant`,
    quantity: `${DIMENSION_REPLAY_NAMESPACE}:field.master_amount`,
    recordedAt: `${DIMENSION_REPLAY_NAMESPACE}:field.master_recorded_at`,
    stockIdentity: `${DIMENSION_REPLAY_NAMESPACE}:field.master_number`,
  },
  members: {
    batchRed: `${DIMENSION_REPLAY_NAMESPACE}:member.batch_red`,
    unspecified: `${DIMENSION_REPLAY_NAMESPACE}:member.batch_unspecified`,
  },
  module: `${DIMENSION_REPLAY_NAMESPACE}:module.master`,
  parameters: {
    addedDimension: `${DIMENSION_REPLAY_NAMESPACE}:parameter.batch`,
    atTime: `${DIMENSION_REPLAY_NAMESPACE}:parameter.at_time`,
    byAddedDimensionAtTime: `${DIMENSION_REPLAY_NAMESPACE}:parameter.batch_at_time`,
    byAddedDimensionRecordedAt: `${DIMENSION_REPLAY_NAMESPACE}:parameter.batch_recorded_at`,
    byAddedDimensionStockIdentity: `${DIMENSION_REPLAY_NAMESPACE}:parameter.batch_stock_identity`,
    recordedAt: `${DIMENSION_REPLAY_NAMESPACE}:parameter.recorded_at`,
    stockIdentity: `${DIMENSION_REPLAY_NAMESPACE}:parameter.stock_identity`,
  },
  permission: `${DIMENSION_REPLAY_NAMESPACE}:permission.master_read`,
  queries: {
    byAddedDimension: `${DIMENSION_REPLAY_NAMESPACE}:query.balance_by_batch`,
    renderAddedDimension: `${DIMENSION_REPLAY_NAMESPACE}:query.render_batch`,
    total: `${DIMENSION_REPLAY_NAMESPACE}:query.balance_total`,
  },
  selections: {
    byAddedDimension: `${DIMENSION_REPLAY_NAMESPACE}:selection.balance_by_batch`,
    renderedAddedDimension: `${DIMENSION_REPLAY_NAMESPACE}:selection.rendered_batch`,
    total: `${DIMENSION_REPLAY_NAMESPACE}:selection.balance_total`,
  },
});

export interface FixtureStockDimensionSet {
  readonly dimensions: readonly string[];
  readonly setId: 'northstar.g3r2fixture:stock-dimension-set.replay';
  readonly unspecifiedMember: string | null;
  readonly version: 1 | 2;
}

export const FIXTURE_DIMENSION_SET_V1: FixtureStockDimensionSet = Object.freeze(
  {
    dimensions: Object.freeze(['legalEntityId', 'itemId', 'locationId']),
    setId: 'northstar.g3r2fixture:stock-dimension-set.replay',
    unspecifiedMember: null,
    version: 1,
  },
);

export const FIXTURE_DIMENSION_SET_V2: FixtureStockDimensionSet = Object.freeze(
  {
    dimensions: Object.freeze([
      'legalEntityId',
      'itemId',
      'locationId',
      'batchId',
    ]),
    setId: 'northstar.g3r2fixture:stock-dimension-set.replay',
    unspecifiedMember: DIMENSION_REPLAY_IDS.members.unspecified,
    version: 2,
  },
);

export interface DimensionReplayEvent {
  readonly addedDimensionMember?: string;
  readonly effectiveAt: string;
  readonly eventId: string;
  readonly legalEntityId: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly quantity: string;
  readonly recordedAt: string;
  readonly stockDimensionSetVersion: 'v1' | 'v2';
}

const legalEntityId = '31a00000-0000-4000-8000-000000000001';
const itemA = '41a00000-0000-4000-8000-000000000001';
const itemB = '41a00000-0000-4000-8000-000000000002';
const locationA = '51a00000-0000-4000-8000-000000000001';
const locationB = '51a00000-0000-4000-8000-000000000002';

export const DIMENSION_REPLAY_STOCK = Object.freeze({
  itemA,
  itemB,
  legalEntityId,
  locationA,
  locationB,
});

export const PRIOR_DIMENSION_REPLAY_HISTORY: readonly DimensionReplayEvent[] =
  Object.freeze([
    Object.freeze({
      effectiveAt: '2026-01-02T00:00:00.000Z',
      eventId: '61a00000-0000-4000-8000-000000000001',
      itemId: itemA,
      legalEntityId,
      locationId: locationA,
      quantity: '10.500000000000000000',
      recordedAt: '2026-01-03T00:00:00.000Z',
      stockDimensionSetVersion: 'v1',
    }),
    Object.freeze({
      effectiveAt: '2026-01-10T00:00:00.000Z',
      eventId: '61a00000-0000-4000-8000-000000000002',
      itemId: itemA,
      legalEntityId,
      locationId: locationA,
      quantity: '-3.250000000000000000',
      recordedAt: '2026-02-01T00:00:00.000Z',
      stockDimensionSetVersion: 'v1',
    }),
    Object.freeze({
      effectiveAt: '2026-02-05T00:00:00.000Z',
      eventId: '61a00000-0000-4000-8000-000000000003',
      itemId: itemA,
      legalEntityId,
      locationId: locationA,
      quantity: '1.125000000000000000',
      recordedAt: '2026-02-06T00:00:00.000Z',
      stockDimensionSetVersion: 'v1',
    }),
    Object.freeze({
      effectiveAt: '2026-01-20T00:00:00.000Z',
      eventId: '61a00000-0000-4000-8000-000000000004',
      itemId: itemA,
      legalEntityId,
      locationId: locationB,
      quantity: '4.000000000000000000',
      recordedAt: '2026-01-21T00:00:00.000Z',
      stockDimensionSetVersion: 'v1',
    }),
    Object.freeze({
      effectiveAt: '2026-01-25T00:00:00.000Z',
      eventId: '61a00000-0000-4000-8000-000000000005',
      itemId: itemB,
      legalEntityId,
      locationId: locationA,
      quantity: '2.500000000000000000',
      recordedAt: '2026-01-26T00:00:00.000Z',
      stockDimensionSetVersion: 'v1',
    }),
  ]);

export const POST_EXTENSION_DIMENSION_REPLAY_EVENT: DimensionReplayEvent =
  Object.freeze({
    addedDimensionMember: DIMENSION_REPLAY_IDS.members.batchRed,
    effectiveAt: '2026-04-01T00:00:00.000Z',
    eventId: '61a00000-0000-4000-8000-000000000006',
    itemId: itemA,
    legalEntityId,
    locationId: locationA,
    quantity: '2.125000000000000000',
    recordedAt: '2026-04-02T00:00:00.000Z',
    stockDimensionSetVersion: 'v2',
  });

export function dimensionReplayModuleDefinition(
  dimensionSet: FixtureStockDimensionSet,
): Record<string, unknown> {
  const definition = ordinaryModuleV2ForNamespace(
    DIMENSION_REPLAY_NAMESPACE,
  ) as {
    fields: Array<Record<string, unknown>>;
    modules: Array<Record<string, unknown>>;
    package: Record<string, unknown>;
    queries: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  definition.package.version = dimensionSet.version === 1 ? '1.0.0' : '2.0.0';
  definition.modules[0]!.label = `G3-R2 fixture dimension set v${String(dimensionSet.version)}`;

  const quantity = requiredField(
    definition.fields,
    DIMENSION_REPLAY_IDS.fields.quantity,
  );
  quantity.label = 'Movement quantity';
  quantity.presence = 'required';
  quantity.fieldType = {
    kind: 'exactDecimalFieldType',
    precision: 38,
    representation: 'canonicalString',
    scale: 18,
    schemaVersion: version,
  };
  const effectiveAt = requiredField(
    definition.fields,
    DIMENSION_REPLAY_IDS.fields.effectiveAt,
  );
  effectiveAt.label = 'Movement effective at';
  effectiveAt.presence = 'required';
  definition.fields.push({
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'none',
    entity: reference('entityReference', DIMENSION_REPLAY_IDS.entity),
    fieldId: DIMENSION_REPLAY_IDS.fields.recordedAt,
    fieldType: {
      kind: 'dateTimeFieldType',
      precision: 'millisecond',
      schemaVersion: version,
      timezoneSemantics: 'utcInstant',
    },
    kind: 'fieldDefinition',
    label: 'Movement recorded at',
    orderKey: 80,
    presence: 'required',
    reportable: true,
    schemaVersion: version,
    searchable: false,
  });
  const stockIdentity = requiredField(
    definition.fields,
    DIMENSION_REPLAY_IDS.fields.stockIdentity,
  );
  stockIdentity.label = 'V1 stock identity';
  stockIdentity.fieldType = {
    kind: 'textFieldType',
    maximumLength: 240,
    schemaVersion: version,
  };

  definition.queries.push(balanceQuery(DIMENSION_REPLAY_IDS.queries.total));
  if (dimensionSet.version === 2) {
    definition.fields.push({
      classification: 'internal',
      collation: 'binary',
      defaultSemantics: 'none',
      entity: reference('entityReference', DIMENSION_REPLAY_IDS.entity),
      fieldId: DIMENSION_REPLAY_IDS.fields.addedDimension,
      fieldType: {
        kind: 'enumFieldType',
        options: [
          {
            kind: 'enumOption',
            label: 'Unspecified',
            optionId: DIMENSION_REPLAY_IDS.members.unspecified,
            orderKey: 10,
            schemaVersion: version,
          },
          {
            kind: 'enumOption',
            label: 'Batch red',
            optionId: DIMENSION_REPLAY_IDS.members.batchRed,
            orderKey: 20,
            schemaVersion: version,
          },
        ],
        schemaVersion: version,
      },
      kind: 'fieldDefinition',
      label: 'Batch',
      orderKey: 90,
      presence: 'required',
      reportable: true,
      schemaVersion: version,
      searchable: true,
    });
    definition.queries.push(
      balanceQuery(DIMENSION_REPLAY_IDS.queries.byAddedDimension, true),
      renderedAddedDimensionQuery(),
    );
  }
  return definition;
}

function renderedAddedDimensionQuery(): Record<string, unknown> {
  return {
    filter: {
      field: reference(
        'fieldReference',
        DIMENSION_REPLAY_IDS.fields.addedDimension,
      ),
      kind: 'fieldComparisonPredicate',
      operator: 'equals',
      schemaVersion: version,
      value: {
        kind: 'textValue',
        schemaVersion: version,
        value: DIMENSION_REPLAY_IDS.members.unspecified,
      },
    },
    kind: 'queryDefinition',
    maximumResultCount: 1,
    module: reference('moduleReference', DIMENSION_REPLAY_IDS.module),
    permission: reference(
      'permissionReference',
      DIMENSION_REPLAY_IDS.permission,
    ),
    queryId: DIMENSION_REPLAY_IDS.queries.renderAddedDimension,
    queryType: 'get',
    schemaVersion: version,
    selections: [
      {
        field: reference(
          'fieldReference',
          DIMENSION_REPLAY_IDS.fields.addedDimension,
        ),
        kind: 'querySelection',
        orderKey: 10,
        schemaVersion: version,
        selectionId: DIMENSION_REPLAY_IDS.selections.renderedAddedDimension,
      },
    ],
    sourceEntity: reference('entityReference', DIMENSION_REPLAY_IDS.entity),
    tier: 'q1',
  };
}

function balanceQuery(
  queryId: string,
  byAddedDimension = false,
): Record<string, unknown> {
  const stockIdentityParameter = byAddedDimension
    ? DIMENSION_REPLAY_IDS.parameters.byAddedDimensionStockIdentity
    : DIMENSION_REPLAY_IDS.parameters.stockIdentity;
  const atTimeParameter = byAddedDimension
    ? DIMENSION_REPLAY_IDS.parameters.byAddedDimensionAtTime
    : DIMENSION_REPLAY_IDS.parameters.atTime;
  const recordedAtParameter = byAddedDimension
    ? DIMENSION_REPLAY_IDS.parameters.byAddedDimensionRecordedAt
    : DIMENSION_REPLAY_IDS.parameters.recordedAt;
  const terms: Record<string, unknown>[] = [
    comparison(
      DIMENSION_REPLAY_IDS.fields.stockIdentity,
      'equals',
      stockIdentityParameter,
    ),
    comparison(
      DIMENSION_REPLAY_IDS.fields.effectiveAt,
      'lessThanOrEqual',
      atTimeParameter,
    ),
    comparison(
      DIMENSION_REPLAY_IDS.fields.recordedAt,
      'lessThanOrEqual',
      recordedAtParameter,
    ),
  ];
  const parameters: Record<string, unknown>[] = [
    queryParameter(stockIdentityParameter, 10),
    queryParameter(atTimeParameter, 20),
    queryParameter(recordedAtParameter, 30),
  ];
  if (byAddedDimension) {
    terms.push(
      comparison(
        DIMENSION_REPLAY_IDS.fields.addedDimension,
        'equals',
        DIMENSION_REPLAY_IDS.parameters.addedDimension,
      ),
    );
    parameters.push(
      queryParameter(DIMENSION_REPLAY_IDS.parameters.addedDimension, 40),
    );
  }
  return {
    aggregate: {
      field: reference('fieldReference', DIMENSION_REPLAY_IDS.fields.quantity),
      kind: 'queryAggregateSelection',
      operator: 'sum',
      schemaVersion: version,
      selectionId: byAddedDimension
        ? DIMENSION_REPLAY_IDS.selections.byAddedDimension
        : DIMENSION_REPLAY_IDS.selections.total,
    },
    filter: {
      kind: 'allPredicate',
      schemaVersion: version,
      terms,
    },
    kind: 'queryDefinition',
    maximumResultCount: 1,
    module: reference('moduleReference', DIMENSION_REPLAY_IDS.module),
    parameters,
    permission: reference(
      'permissionReference',
      DIMENSION_REPLAY_IDS.permission,
    ),
    queryId,
    queryType: 'aggregate',
    schemaVersion: version,
    sourceEntity: reference('entityReference', DIMENSION_REPLAY_IDS.entity),
    tier: 'q1',
  };
}

function comparison(
  fieldId: string,
  operator: 'equals' | 'lessThanOrEqual',
  parameterId: string,
): Record<string, unknown> {
  return {
    field: reference('fieldReference', fieldId),
    kind: 'fieldComparisonPredicate',
    operator,
    schemaVersion: version,
    value: {
      kind: 'queryParameterReference',
      parameterId,
      schemaVersion: version,
    },
  };
}

function queryParameter(
  parameterId: string,
  orderKey: number,
): Record<string, unknown> {
  return {
    kind: 'queryParameterDefinition',
    orderKey,
    parameterId,
    schemaVersion: version,
  };
}

function reference(kind: string, targetId: string): Record<string, unknown> {
  return { kind, schemaVersion: version, targetId };
}

function requiredField(
  fields: Array<Record<string, unknown>>,
  fieldId: string,
): Record<string, unknown> {
  const field = fields.find((candidate) => candidate.fieldId === fieldId);
  if (!field) throw new Error(`fixture field is missing: ${fieldId}`);
  return field;
}
