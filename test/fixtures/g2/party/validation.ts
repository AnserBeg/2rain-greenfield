import { literalValidationDraft } from '../../../../packages/customization/src/validation-draft.js';
import { PARTY_IDS, partyModuleDefinition } from './definition.js';

export const contactDate = `${PARTY_IDS.namespace}:field.party_contact_date`;
export function datedPartyDefinition() {
  const definition = partyModuleDefinition();
  const fields = definition.fields as Array<Record<string, unknown>>;
  const source = fields.find(
    (field) => field.fieldId === PARTY_IDS.fieldIds.contactSummary,
  )!;
  fields.push({
    ...source,
    label: 'Contact date',
    fieldId: contactDate,
    orderKey: 90,
    collation: 'binary',
    fieldType: {
      kind: 'dateFieldType',
      calendar: 'iso8601',
      timezoneSemantics: 'calendarDate',
      schemaVersion: 'v6',
    },
  });
  const { rule } = literalValidationDraft(
    {
      entityId: PARTY_IDS.entityIds.party,
      label: 'Party',
      operationIds: ['create', 'update'].map(
        (action) => `${PARTY_IDS.namespace}:operation.party_${action}`,
      ),
      fields: [
        {
          fieldId: contactDate,
          label: 'Contact date',
          valueType: { kind: 'date' },
        },
      ],
    },
    {
      fieldId: contactDate,
      check: 'notBeforeToday',
      limit: '',
      message: 'Use today or an earlier contact date.',
    },
  );
  if (rule.predicate.kind !== 'comparison')
    throw new Error('Expected a date comparison');
  return {
    ...definition,
    formulaRules: [
      {
        ...rule,
        predicate: { ...rule.predicate, operator: 'lessThanOrEqual' },
      },
    ],
  };
}
