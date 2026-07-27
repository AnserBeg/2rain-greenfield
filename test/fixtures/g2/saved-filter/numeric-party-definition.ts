import {
  PARTY_IDS,
  partyModuleDefinition,
} from '../../../../packages/domain/src/party/index.js';

export const NUMERIC_SORT_FIELD_ID =
  `${PARTY_IDS.namespace}:field.party_numeric_sort_probe` as const;

export function numericPartyModuleDefinition(): Record<string, unknown> {
  const definition = structuredClone(partyModuleDefinition());
  const fields = requiredArray(definition, 'fields');
  fields.push({
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'nullable',
    entity: reference('entityReference', PARTY_IDS.entityIds.party),
    fieldId: NUMERIC_SORT_FIELD_ID,
    fieldType: {
      kind: 'integerFieldType',
      representation: 'canonicalString',
      schemaVersion: 'v2',
    },
    kind: 'fieldDefinition',
    label: 'Numeric sort probe',
    orderKey: 40,
    presence: 'optional',
    reportable: true,
    schemaVersion: 'v2',
    searchable: false,
  });

  for (const query of requiredArray(definition, 'queries')) {
    if (
      query.sourceEntity &&
      typeof query.sourceEntity === 'object' &&
      (query.sourceEntity as { targetId?: unknown }).targetId ===
        PARTY_IDS.entityIds.party
    ) {
      requiredArray(query, 'selections').push({
        field: reference('fieldReference', NUMERIC_SORT_FIELD_ID),
        kind: 'querySelection',
        orderKey: 40,
        schemaVersion: 'v2',
        selectionId: `${PARTY_IDS.namespace}:selection.party_numeric_sort_probe_${String(query.queryType)}`,
      });
    }
  }
  return definition;
}

function reference(kind: string, targetId: string) {
  return { kind, schemaVersion: 'v2', targetId };
}

function requiredArray(
  record: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`fixture ${key} must be an array`);
  return value as Array<Record<string, unknown>>;
}
