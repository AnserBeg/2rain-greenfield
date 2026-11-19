import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRAFT_CUSTOMIZATION_TOOL,
  draftPatchFromRequest,
  draftingSystemPrompt,
  type DraftingModel,
} from '../../packages/customization/src/index.js';

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
