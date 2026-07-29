import {
  PARTY_IDS,
  partyModuleDefinition,
} from '../../../../packages/domain/src/party/index.js';

export const NUMERIC_SORT_FIELD_ID =
  `${PARTY_IDS.namespace}:field.party_numeric_sort_probe` as const;

export function numericPartyModuleDefinition(): Record<string, unknown> {
  const definition = structuredClone(partyModuleDefinition());
  const schemaVersion = requiredString(definition, 'languageVersion');
  const fields = requiredArray(definition, 'fields');
  fields.push({
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'nullable',
    entity: reference(
      'entityReference',
      PARTY_IDS.entityIds.party,
      schemaVersion,
    ),
    fieldId: NUMERIC_SORT_FIELD_ID,
    fieldType: {
      kind: 'integerFieldType',
      representation: 'canonicalString',
      schemaVersion,
    },
    kind: 'fieldDefinition',
    label: 'Numeric sort probe',
    orderKey: 40,
    presence: 'optional',
    reportable: true,
    schemaVersion,
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
        field: reference(
          'fieldReference',
          NUMERIC_SORT_FIELD_ID,
          schemaVersion,
        ),
        kind: 'querySelection',
        orderKey: 40,
        schemaVersion,
        selectionId: `${PARTY_IDS.namespace}:selection.party_numeric_sort_probe_${String(query.queryType)}`,
      });
    }
  }
  return definition;
}

function reference(kind: string, targetId: string, schemaVersion: string) {
  return { kind, schemaVersion, targetId };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string')
    throw new Error(`fixture ${key} must be a string`);
  return value;
}

function requiredArray(
  record: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`fixture ${key} must be an array`);
  return value as Array<Record<string, unknown>>;
}
