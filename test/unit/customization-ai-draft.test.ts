import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRAFT_CUSTOMIZATION_TOOL,
  applyCustomizationPatches,
  customizationTargets,
  draftPatchFromRequest,
  draftingSystemPrompt,
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
