import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { platformModuleDefinition } from '../../packages/domain/src/platform/definition.js';
import { literalValidationDraft } from '../../packages/customization/src/validation-draft.js';

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
  return [application, platformModuleDefinition(), validationFixture];
}
