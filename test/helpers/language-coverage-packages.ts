import {
  baseLayout,
  type LayoutDefinition,
  layoutDigest,
} from '../../packages/canonical-model/src/layout.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { calculatedDisplayDraft } from '../../packages/customization/src/calculated-display-draft.js';
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
  const source = application as unknown as LayoutDefinition;
  const pageLayoutFixture = {
    ...application,
    surfaces: source.surfaces.map((surface) => {
      if (surface.surfaceId !== 'northstar.app:surface.purchase_order_detail')
        return surface;
      const body = baseLayout(source, surface, 'detail')!;
      return {
        ...surface,
        layouts: [
          {
            revisionId: 'c5f424f8-a0da-4836-b70e-0bb7a8da26e6',
            resultLayoutDigest: layoutDigest(body),
            body,
          },
        ],
      };
    }),
  };
  const valueType = { precision: 38, scale: 18, currency: 'CAD', unit: null };
  const price = 'northstar.app:field.item_price_cad';
  const cost = 'northstar.app:field.item_standard_cost_cad';
  const itemList = 'northstar.app:surface.item_list';
  const margin = calculatedDisplayDraft(
    {
      entityId: target.entityId,
      label: target.label,
      recordSurfaceId: 'northstar.app:surface.item_detail',
      fields: [
        { fieldId: price, label: 'Price (CAD)', valueType },
        { fieldId: cost, label: 'Standard cost (CAD)', valueType },
      ],
      lists: [{ surfaceId: itemList, label: 'Items', fields: [price, cost] }],
    },
    {
      label: 'Margin CAD',
      operator: 'subtract',
      leftFieldId: price,
      rightFieldId: cost,
      listSurfaceId: itemList,
    },
  ).field;
  const displayFixture = {
    ...application,
    calculatedDisplayFields: [
      margin,
      {
        ...margin,
        fieldId: 'northstar.app:field.custom_item_price_multiple',
        label: 'Twice the CAD price',
        expression: {
          ...margin.expression,
          operator: 'multiply' as const,
          right: {
            kind: 'decimalLiteral' as const,
            schemaVersion: 'v6' as const,
            value: '2',
            decimalType: { precision: 1, scale: 0, currency: null, unit: null },
          },
        },
        resultType: { ...valueType, precision: 39 },
      },
    ],
  };
  const workflowFixture = {
    ...application,
    workflows: [
      {
        schemaVersion: 'v6' as const,
        workflowId: 'sample-receipt-workflow',
        trigger: 'goodsReceiptPosted' as const,
        bodyDigest: 'a'.repeat(64),
        grants: { operations: [], queries: [] },
      },
    ],
  };
  return [
    pageLayoutFixture,
    application,
    workflowFixture,
    displayFixture,
    platformModuleDefinition(),
    validationFixture,
    fieldComparisonFixture,
  ];
}
