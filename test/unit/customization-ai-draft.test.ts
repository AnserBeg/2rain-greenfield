import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRAFT_CUSTOMIZATION_TOOL,
  applyCustomizationPatches,
  customizationTargets,
  draftPatchFromRequest,
  draftingSystemPrompt,
  parseCustomizationPatch,
  type DraftingModel,
} from '../../packages/customization/src/index.js';
import { readFileSync } from 'node:fs';
import {
  normalizeApplicationPackage,
  type SurfaceList,
} from '../../packages/canonical-model/src/index.js';

const targets = Object.freeze({
  choiceFields: [],
  lists: [
    {
      columns: [{ fieldId: 'northstar.app:field.party_name', label: 'Name' }],
      label: 'Party list',
      surfaceId: 'northstar.app:surface.party_list',
    },
  ],
  recordTypes: [
    {
      entityId: 'northstar.app:entity.party',
      label: 'Party',
      tenantAuthored: false,
    },
  ],
});

const equipment = {
  fields: [
    { label: 'Name', type: 'text' },
    { label: 'Serial number', type: 'text' },
    { label: 'Status', options: ['In service', 'Retired'], type: 'choice' },
  ],
  kind: 'addRecordType',
  label: 'Equipment',
};

test('plain English drafts item margin on the item page and Items list', async () => {
  const application = normalizeApplicationPackage(
    JSON.parse(
      readFileSync('apps/web/release/app.authored.json', 'utf8'),
    ) as unknown,
  );
  const options = customizationTargets(application);
  const seen: { system: string; toolNames: string[]; turns: number }[] = [];
  const result = await draftPatchFromRequest(
    scripted(
      [
        {
          toolInput: {
            kind: 'addCalculatedDisplayField',
            surface: 'northstar.app:surface.item_detail',
            calculation: {
              label: 'Margin CAD',
              operator: 'subtract',
              leftFieldId: 'northstar.app:field.item_price_cad',
              rightFieldId: 'northstar.app:field.item_standard_cost_cad',
              listSurfaceId: 'northstar.app:surface.item_list',
            },
          },
        },
      ],
      seen,
    ),
    'Show CAD margin as CAD price minus CAD standard cost on item details and in the Items list.',
    options,
  );
  assert.match(seen[0]?.system ?? '', /Calculated display targets/u);
  assert.ok(
    result.status === 'parsed' &&
      result.patch.kind === 'addCalculatedDisplayField',
    JSON.stringify(result),
  );
  assert.deepEqual(result.patch.field.resultType, {
    precision: 39,
    scale: 18,
    currency: 'CAD',
    unit: null,
  });
  assert.deepEqual(
    result.patch.field.displaySinks.map(({ kind }) => kind),
    ['record', 'list'],
  );
  const grouped = parseCustomizationPatch({
    kind: 'changeSet',
    patches: [equipment, result.patch],
  });
  assert.ok(grouped.status === 'unsupported');
  assert.equal(
    grouped.missingCapability,
    'calculated displays in a grouped draft',
  );
});

test('plain English drafts a governed literal validation on the selected field', async () => {
  const entityId = 'northstar.app:entity.item';
  const fieldId = 'northstar.app:field.item_description';
  const message = 'Enter an inspection description.';
  const operations = [
    'northstar.app:operation.item_create',
    'northstar.app:operation.item_update',
  ];
  const seen: { system: string; toolNames: string[]; turns: number }[] = [];
  const result = await draftPatchFromRequest(
    scripted(
      [
        {
          toolInput: {
            kind: 'addValidation',
            entity: entityId,
            validation: { fieldId, check: 'required', message },
          },
        },
      ],
      seen,
    ),
    'Require an inspection description before saving items.',
    {
      ...targets,
      validationTargets: [
        {
          entityId,
          label: 'Item',
          operationIds: operations,
          fields: [
            { fieldId, label: 'Description', valueType: { kind: 'text' } },
          ],
        },
      ],
    },
  );
  assert.match(
    seen[0]?.system ?? '',
    /Record types and fields that support validation/u,
  );
  assert.ok(
    result.status === 'parsed' && result.patch.kind === 'addValidation',
  );
  assert.equal(result.patch.rule.message, message);
  assert.deepEqual(result.patch.rule.boundOperationIds, operations);
  assert.deepEqual(result.patch.rule.fieldAnchors, [fieldId]);
  const grouped = parseCustomizationPatch({
    kind: 'changeSet',
    patches: [equipment, result.patch],
  });
  assert.ok(grouped.status === 'unsupported');
  assert.equal(grouped.missingCapability, 'validation in a grouped draft');
});

test('plain English drafts a comparison with the declared parent location field', async () => {
  const entityId = 'northstar.app:entity.location';
  const fieldId = 'northstar.app:field.location_name';
  const relationId = 'northstar.app:relation.location_parent';
  const message = 'Use a different name from the parent location.';
  const seen: { system: string; toolNames: string[]; turns: number }[] = [];
  const result = await draftPatchFromRequest(
    scripted(
      [
        {
          toolInput: {
            kind: 'addValidation',
            entity: entityId,
            validation: {
              fieldId,
              check: 'compareFields',
              operator: 'notEqual',
              otherFieldId: fieldId,
              relationId,
              message,
            },
          },
        },
      ],
      seen,
    ),
    'Do not allow a location inside another to have the same name.',
    {
      ...targets,
      validationTargets: [
        {
          entityId,
          label: 'Location',
          operationIds: [
            'northstar.app:operation.location_create',
            'northstar.app:operation.location_update',
          ],
          fields: [{ fieldId, label: 'Name', valueType: { kind: 'text' } }],
          relatedFields: [
            {
              relationId,
              fieldId,
              label: 'Parent location name',
              valueType: { kind: 'text' },
            },
          ],
        },
      ],
    },
  );
  assert.match(
    seen[0]?.system ?? '',
    /location_parent → northstar\.app:field\.location_name/u,
  );
  assert.ok(
    result.status === 'parsed' && result.patch.kind === 'addValidation',
  );
  const predicate = result.patch.rule.predicate;
  assert.ok(predicate.kind === 'comparison' && predicate.right.kind === 'path');
  assert.deepEqual(predicate.right.relationIds, [relationId]);
  assert.equal(predicate.right.fieldId, fieldId);
  assert.equal(result.patch.rule.message, message);
});

/** A model that answers each turn from a script and records what it saw. */
function scripted(
  turns: readonly ({ text?: string; toolInput?: unknown } | null)[],
  seen: { system: string; toolNames: string[]; turns: number }[] = [],
): DraftingModel {
  let index = 0;
  return {
    modelId: 'scripted',
    next(request) {
      seen.push({
        system: request.system,
        toolNames: request.tools.map((tool) => tool.name),
        turns: request.conversation.length,
      });
      const turn = turns[index] ?? null;
      index += 1;
      return Promise.resolve({
        text: turn?.text ?? '',
        toolCalls:
          turn && 'toolInput' in turn
            ? [
                {
                  id: `call-${String(index)}`,
                  input: turn.toolInput,
                  name: DRAFT_CUSTOMIZATION_TOOL,
                },
              ]
            : [],
      });
    },
  };
}

test('a plain-English request becomes exactly the typed patch the model proposed', async () => {
  const seen: { system: string; toolNames: string[]; turns: number }[] = [];
  const outcome = await draftPatchFromRequest(
    scripted([{ toolInput: equipment }], seen),
    'Add an Equipment record with serial number and status',
    targets,
  );
  assert.equal(outcome.status, 'parsed');
  assert.deepEqual(outcome.status === 'parsed' && outcome.patch, equipment);
  assert.deepEqual(seen[0]!.toolNames, [DRAFT_CUSTOMIZATION_TOOL]);
  assert.match(seen[0]!.system, /northstar\.app:entity\.party — Party/u);
  assert.match(seen[0]!.system, /Never answer in text/u);
});

test('the scripted assistant uses the exact role and operation for a restriction', async () => {
  const roleKey = 'warehouse-clerk';
  const id = 'northstar.app:operation.purchase_order_close';
  const change = {
    kind: 'narrowPermission',
    roleKey,
    target: { kind: 'operation', id },
  };
  const seen: { system: string; toolNames: string[]; turns: number }[] = [];
  const result = await draftPatchFromRequest(
    scripted([{ toolInput: change }], seen),
    'Keep warehouse clerks from closing a purchase order.',
    {
      ...targets,
      permissionRoleKeys: [roleKey],
      permissionActions: [{ id, label: 'Close purchase order' }],
    },
  );
  assert.match(seen[0]!.system, /warehouse-clerk/u);
  assert.match(
    seen[0]!.system,
    /northstar\.app:operation\.purchase_order_close — Close purchase order/u,
  );
  assert.deepEqual(result.status === 'parsed' && result.patch, change);
});

test('the scripted assistant drafts a Today metric from the declared list measures', async () => {
  const definition = normalizeApplicationPackage(
    JSON.parse(readFileSync('apps/web/release/app.authored.json', 'utf8')),
  );
  const choices = customizationTargets(
    definition as unknown as Parameters<typeof customizationTargets>[0],
  );
  const measure = {
    kind: 'addMetricCard',
    surface: 'northstar.app:surface.item_list',
    label: 'Catalog prices in CAD',
    sumField: 'northstar.app:field.item_price_cad',
  };
  const seen: { system: string; toolNames: string[]; turns: number }[] = [];
  const result = await draftPatchFromRequest(
    scripted([{ toolInput: measure }], seen),
    'On Today, sum the CAD prices of the items in the catalog.',
    choices,
  );
  assert.match(
    seen[0]!.system,
    /sum northstar\.app:field\.item_price_cad "Price \(CAD\)"/u,
  );
  assert.deepEqual(result.status === 'parsed' && result.patch, measure);
});

test('text is never taken as a change, and a malformed patch gets one repair turn', async () => {
  const textOnly = await draftPatchFromRequest(
    scripted([{ text: JSON.stringify(equipment) }, { text: 'Done.' }]),
    'Add Equipment',
    targets,
  );
  assert.equal(textOnly.status, 'invalid');

  const repaired = await draftPatchFromRequest(
    scripted([
      {
        toolInput: {
          ...equipment,
          fields: [{ label: 'Status', type: 'choice' }],
        },
      },
      { toolInput: equipment },
    ]),
    'Add Equipment',
    targets,
  );
  assert.equal(repaired.status, 'parsed');

  const stillWrong = await draftPatchFromRequest(
    scripted([
      { toolInput: { kind: 'addRecordType', label: 'Equipment' } },
      { toolInput: { kind: 'addRecordType', label: 'Equipment', extra: 1 } },
    ]),
    'Add Equipment',
    targets,
  );
  assert.equal(stillWrong.status, 'invalid');
});

test('one tool call drafts an ordered change set and separate proposals cannot discard a requested edit', async () => {
  const change = {
    kind: 'changeSet',
    patches: [
      equipment,
      {
        kind: 'addField',
        entity: 'northstar.app:entity.custom_equipment',
        field: { label: 'Inspection date', type: 'date' },
      },
    ],
  };
  const request = 'Add Equipment and give it an inspection date';
  assert.deepEqual(
    await draftPatchFromRequest(
      scripted([{ toolInput: change }]),
      request,
      targets,
    ),
    { status: 'parsed', patch: change },
  );
  const separate: DraftingModel = {
    modelId: 'scripted',
    next: async () => ({
      text: '',
      toolCalls: change.patches.map((input, index) => ({
        id: String(index),
        input,
        name: DRAFT_CUSTOMIZATION_TOOL,
      })),
    }),
  };
  assert.deepEqual(await draftPatchFromRequest(separate, request, targets), {
    status: 'invalid',
    issues: ['propose the complete change in one tool call'],
  });
});

test('a request outside the four kinds comes back unsupported, naming what is missing', async () => {
  const outcome = await draftPatchFromRequest(
    scripted([
      {
        toolInput: {
          kind: 'unsupported',
          missingCapability: 'approval workflow',
        },
      },
    ]),
    'Make purchase orders over 5000 need two approvals',
    targets,
  );
  assert.equal(outcome.status, 'unsupported');
  assert.equal(
    outcome.status === 'unsupported' && outcome.missingCapability,
    'approval workflow',
  );
});

test('the prompt names only targets the §10.6 rules allow', () => {
  const prompt = draftingSystemPrompt(targets);
  assert.match(prompt, /northstar\.app:surface\.party_list/u);
  assert.match(prompt, /\(none yet\)/u);
  assert.doesNotMatch(prompt, /inventory_movement/u);
});

test('drafting admits a link in the record creation change and refuses adding it later', async () => {
  const link = {
    kind: 'addLink',
    entity: 'northstar.app:entity.custom_equipment',
    label: 'Supplier',
    target: 'northstar.app:entity.party',
  };
  const change = { kind: 'changeSet', patches: [equipment, link] };
  assert.deepEqual(
    await draftPatchFromRequest(
      scripted([{ toolInput: change }]),
      'Create Equipment with a supplier link',
      targets,
    ),
    { patch: change, status: 'parsed' },
  );
  for (const toolInput of [
    link,
    {
      kind: 'unsupported',
      missingCapability: 'links on a published record type',
    },
  ]) {
    assert.deepEqual(
      await draftPatchFromRequest(
        scripted([{ toolInput }]),
        'Add a supplier link to our existing Equipment records',
        targets,
      ),
      {
        message:
          'Links can be added when the record type is first created; adding one later is coming soon',
        missingCapability: 'links on a published record type',
        status: 'unsupported',
      },
    );
  }
});

test('a scripted request to add a standard field as a list column uses its offered target', async () => {
  const base = JSON.parse(
    readFileSync('apps/web/release/app.authored.json', 'utf8'),
  ) as Record<string, unknown>;
  const offered = customizationTargets(
    normalizeApplicationPackage(base) as unknown as Parameters<
      typeof customizationTargets
    >[0],
  );
  const input = {
    kind: 'arrangeLayout',
    surface: 'northstar.app:surface.item_list',
    order: ['northstar.app:field.item_standard_cost_usd'],
  };
  const seen: { system: string; toolNames: string[]; turns: number }[] = [];
  const outcome = await draftPatchFromRequest(
    scripted([{ toolInput: input }], seen),
    'Show standard cost in US dollars first on the product list',
    offered,
  );
  assert.equal(outcome.status, 'parsed');
  assert.match(
    seen[0]!.system,
    /item_standard_cost_usd "Standard cost \(USD\)" \(available, hidden\)/u,
  );
  if (outcome.status !== 'parsed') return;
  const applied = applyCustomizationPatches(base, [outcome.patch]);
  assert.equal(applied.status, 'applied');
  if (applied.status !== 'applied') return;
  const model = normalizeApplicationPackage(applied.authored);
  const surface = model.surfaces.find((s) => s.surfaceId === input.surface)!;
  assert.equal(
    'list' in surface && (surface.list as SurfaceList).columns[0]?.field,
    input.order[0],
  );
});

test('a scripted request to save a warehouse view uses its declared columns and filter option', async () => {
  const definition = JSON.parse(
    readFileSync('apps/web/release/app.authored.json', 'utf8'),
  ) as Record<string, unknown>;
  const offered = customizationTargets(
    normalizeApplicationPackage(definition) as unknown as Parameters<
      typeof customizationTargets
    >[0],
  );
  const input = {
    kind: 'saveListView' as const,
    surface: 'northstar.app:surface.location_list',
    label: 'Warehouses',
    columns: [
      'northstar.app:list_column.location_list_name',
      'northstar.app:list_column.location_list_code',
    ],
    sort: [
      {
        column: 'northstar.app:list_column.location_list_name',
        direction: 'descending' as const,
      },
    ],
    filters: [
      {
        field: 'northstar.app:field.location_type',
        value: 'northstar.app:option.warehouse',
      },
    ],
  };
  const seen: { system: string; toolNames: string[]; turns: number }[] = [];
  const outcome = await draftPatchFromRequest(
    scripted([{ toolInput: input }], seen),
    'Give me a Warehouses tab on Locations with name then code, names from Z to A.',
    offered,
  );
  assert.deepEqual(outcome, { status: 'parsed', patch: input });
  assert.match(
    seen[0]!.system,
    /location_list_code "Code" \(required title\)/u,
  );
  assert.match(
    seen[0]!.system,
    /location_type "Type": northstar.app:option.warehouse "Warehouse"/u,
  );
  assert.equal(
    applyCustomizationPatches(definition, [outcome.patch]).status,
    'applied',
  );
});

test('the drafter binds a grouped Invoice balance from the generated report schema and refuses an unoffered source', async () => {
  const application = normalizeApplicationPackage(
    JSON.parse(readFileSync('apps/web/release/app.authored.json', 'utf8')),
  );
  const options = customizationTargets(application);
  const list = options.reports!.find((r) =>
    r.source.queryId.endsWith(':query.customer_invoice_list'),
  )!;
  const customer = 'northstar.app:field.customer_invoice_customer_party_id';
  const balance = 'northstar.app:field.customer_invoice_balance';
  const request =
    'Make a Balance by customer report for Invoices, with currency totals and CSV.';
  const report = {
    listSurfaceId: list.source.listSurfaceId,
    label: 'Balance by customer',
    status: 'active',
    choices: {
      dimensions: [{ kind: 'direct', fieldId: customer }],
      filters: [],
      measures: [
        {
          kind: 'inline',
          measureId: 'northstar.app:measure.custom_balance',
          label: 'Balance',
          operator: { kind: 'sum', fieldId: balance },
        },
      ],
      outputs: [{ kind: 'table' }, { kind: 'csv' }],
    },
  };
  const seen: { system: string; toolNames: string[]; turns: number }[] = [];
  const result = await draftPatchFromRequest(
    scripted([{ toolInput: { kind: 'addReportRevision', report } }], seen),
    request,
    options,
  );
  assert.ok(
    result.status === 'parsed' && result.patch.kind === 'addReportRevision',
    JSON.stringify(result),
  );
  assert.equal(result.patch.body.source.entityId, list.source.entityId);
  assert.deepEqual(
    result.patch.body.operands.map((f) => f.fieldId),
    [balance, 'northstar.app:field.customer_invoice_currency', customer].sort(),
  );
  const { ReportDraftSchema } =
    await import('../../packages/customization/src/report-revision.js');
  assert.ok(
    seen[0]!.system.includes(JSON.stringify(ReportDraftSchema.toJSONSchema())),
  );
  const invalid = await draftPatchFromRequest(
    scripted([
      {
        toolInput: {
          kind: 'addReportRevision',
          report: {
            ...report,
            listSurfaceId: 'northstar.app:surface.invented',
          },
        },
      },
    ]),
    request,
    options,
  );
  assert.notEqual(invalid.status, 'parsed');
});
