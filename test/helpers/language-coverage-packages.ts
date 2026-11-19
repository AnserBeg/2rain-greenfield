import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { platformModuleDefinition } from '../../packages/domain/src/platform/definition.js';
import {
  fieldComparisonValidationDraft,
  literalValidationDraft,
} from '../../packages/customization/src/validation-draft.js';

export function languageCoverageApplicationPackages() {
  const application = composedApplicationDefinition();
  const description = 'northstar.app:field.item_description';
  const target = {
    entityId: 'northstar.app:entity.item',
    label: 'Item',
    operationIds: [
      'northstar.app:operation.item_create',
      'northstar.app:operation.item_update',
    ],
    fields: [
      {
        fieldId: description,
        label: 'Description',
        valueType: { kind: 'text' as const },
      },
    ],
  };
  const validationFixture = {
    ...application,
    formulaRules: [
      literalValidationDraft(target, {
        fieldId: description,
        check: 'required',
        limit: '',
        message: 'Enter a description.',
      }).rule,
      literalValidationDraft(target, {
        fieldId: description,
        check: 'maximumLength',
        limit: '80',
        message: 'Use 80 characters or fewer.',
      }).rule,
    ],
  };
  const name = 'northstar.app:field.location_name';
  const code = 'northstar.app:field.location_code';
  const parent = 'northstar.app:relation.location_parent';
  const location = {
    entityId: 'northstar.app:entity.location',
    label: 'Location',
    operationIds: [
      'northstar.app:operation.location_create',
      'northstar.app:operation.location_update',
    ],
    fields: [
      { fieldId: name, label: 'Name', valueType: { kind: 'text' as const } },
      { fieldId: code, label: 'Code', valueType: { kind: 'text' as const } },
    ],
    relatedFields: [
      {
        relationId: parent,
        fieldId: name,
        label: 'Parent location name',
        valueType: { kind: 'text' as const },
      },
    ],
  };
  const fieldComparisonFixture = {
    ...application,
    formulaRules: [
      fieldComparisonValidationDraft(location, {
        fieldId: name,
        operator: 'notEqual',
        otherFieldId: code,
        message: 'The name must differ from the code.',
      }).rule,
      fieldComparisonValidationDraft(location, {
        fieldId: name,
        operator: 'notEqual',
        otherFieldId: name,
        relationId: parent,
        message: 'The name must differ from the parent name.',
      }).rule,
    ],
  };
  return [
    application,
    platformModuleDefinition(),
    validationFixture,
    fieldComparisonFixture,
  ];
}
