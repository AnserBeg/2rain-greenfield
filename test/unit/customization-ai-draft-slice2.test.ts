/**
 * AI-BUILD-1 slice 2: the drafter's generated kind descriptions and their
 * fail-closed coverage, the bounded repair loop, and the members the drafter
 * now converts from choices (address, map, files, and a board on a record
 * type created in the same change set).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import {
  AUTHORING_RULES,
  CUSTOMIZATION_PATCH_KINDS,
  DRAFT_CUSTOMIZATION_TOOL,
  DRAFTER_EXCEPTIONS,
  DRAFTER_KIND_NAMES,
  DRAFTING_TOOL,
  MAXIMUM_DRAFT_REPAIRS,
  applyCustomizationPatches,
  boundedDiagnostics,
  customizationTargets,
  describeDrafterKind,
  drafterCoverage,
  draftPatchFromRequest,
  parseCustomizationPatch,
  type CustomizationPatch,
  type DraftingConversationEntry,
  type DraftingModel,
} from '../../packages/customization/src/index.js';
import { CAPABILITY_BUCKETS } from '../agent/build-eval-cases.js';

const NS = 'northstar.app';
const application = normalizeApplicationPackage(
  JSON.parse(
    readFileSync('apps/web/release/app.authored.json', 'utf8'),
  ) as unknown,
) as unknown as Record<string, unknown>;
const targets = customizationTargets(
  application as unknown as Parameters<typeof customizationTargets>[0],
);

interface Seen {
  conversation: readonly DraftingConversationEntry[];
  system: string;
}
function scripted(
  inputs: readonly unknown[],
  seen: Seen[] = [],
): DraftingModel {
  let index = 0;
  return {
    modelId: 'scripted',
    next(request) {
      seen.push({
        conversation: [...request.conversation],
        system: request.system,
      });
      const input = inputs[index];
      index += 1;
      if (index > inputs.length) throw new Error('scripted model exhausted');
      return Promise.resolve({
        text: '',
        toolCalls: [
          {
            id: `call-${String(index)}`,
            input,
            name: DRAFT_CUSTOMIZATION_TOOL,
          },
        ],
      });
    },
  };
}

const lastFeedback = (seen: readonly Seen[]) => {
  const entry = seen.at(-1)?.conversation.at(-1);
  return entry?.role === 'tool' ? entry.results[0]!.content : '';
};

// ---------------------------------------------------------------- coverage

test('every patch kind is drafted or carries a dated, named exception (fail closed)', () => {
  const coverage = drafterCoverage();
  assert.deepEqual(coverage.missing, [], 'patch kinds the drafter cannot emit');
  assert.deepEqual(
    coverage.unknown,
    [],
    'drafter kinds that are not patch kinds',
  );
  for (const [kind, exception] of Object.entries(DRAFTER_EXCEPTIONS)) {
    assert.match(exception.since, /^\d{4}-\d{2}-\d{2}$/u, kind);
    assert.ok(exception.owner.trim() && exception.reason.trim(), kind);
    assert.ok(!DRAFTER_KIND_NAMES.includes(kind as never), kind);
  }
  // Each covered kind is offered by the tool and described in it.
  const offered = (
    DRAFTING_TOOL.inputSchema as {
      properties: { kind: { enum: readonly string[] } };
    }
  ).properties.kind.enum;
  for (const kind of CUSTOMIZATION_PATCH_KINDS)
    if (!(kind in DRAFTER_EXCEPTIONS)) {
      assert.ok(offered.includes(kind), `${kind} not offered by the tool`);
      assert.ok(
        DRAFTING_TOOL.description.includes(describeDrafterKind(kind as never)),
        `${kind} not described`,
      );
    }
});

test('the kind descriptions are generated from the patch schemas', () => {
  // The limits stated to the model are the schema's own.
  assert.match(describeDrafterKind('addRecordType'), /\(1 to 24\)/u);
  assert.match(describeDrafterKind('addLineTable'), /\(1 to 15\)/u);
  assert.match(describeDrafterKind('declareLifecycle'), /\(2 to 8\)/u);
  assert.match(
    describeDrafterKind('saveWorkflow'),
    /workflowId: text matching \^\[a-z\]\[a-z0-9-\]\{0,63\}\$/u,
  );
  assert.doesNotMatch(describeDrafterKind('addField'), /screens/u);
});

test('the tool schema is one top-level object a provider accepts', () => {
  const schema = DRAFTING_TOOL.inputSchema as Record<string, unknown>;
  assert.equal(schema.type, 'object');
  assert.ok(!('oneOf' in schema) && !('anyOf' in schema));
  const text = JSON.stringify(schema);
  assert.doesNotMatch(text, /\\\\p\{/u, 'no Unicode property escapes');
  assert.doesNotMatch(text, /\$schema/u);
});

test('the platform rules name every patch refusal code, and the distinct-label rule', () => {
  for (const [code, rules] of Object.entries(AUTHORING_RULES))
    assert.ok(rules.length > 0, code);
  assert.match(
    DRAFTING_TOOL.description,
    /every action \(transition\) label is distinct/u,
  );
});

// ---------------------------------------------------------------- repair loop

const equipment = {
  kind: 'addRecordType',
  label: 'Equipment',
  fields: [{ label: 'Name', type: 'text' }],
};

test('a draft the check refuses goes back with its diagnostics, at most twice', async () => {
  const seen: Seen[] = [];
  const checks: unknown[] = [];
  const outcome = await draftPatchFromRequest(
    scripted([equipment, equipment, equipment], seen),
    'Add equipment',
    targets,
    {
      check: (draft) => {
        checks.push(draft);
        return Promise.resolve({
          status: 'repair' as const,
          diagnostics: ['CUSTOMIZE_DUPLICATE_LABEL: Use distinct names.'],
          value: `refused ${String(checks.length)}`,
        });
      },
    },
  );
  assert.equal(seen.length, 1 + MAXIMUM_DRAFT_REPAIRS);
  assert.equal(checks.length, 3);
  assert.deepEqual(outcome, {
    status: 'checked',
    value: 'refused 3',
    repairs: 2,
  });
  assert.match(
    lastFeedback(seen),
    /CUSTOMIZE_DUPLICATE_LABEL: Use distinct names/u,
  );
});

test('a repaired draft is accepted on the turn it passes, and records the turn', async () => {
  const seen: Seen[] = [];
  const outcome = await draftPatchFromRequest(
    scripted([{ kind: 'addRecordType', label: 'Equipment' }, equipment], seen),
    'Add equipment',
    targets,
    {
      check: () =>
        Promise.resolve({ status: 'accepted' as const, value: 'drafted' }),
    },
  );
  assert.deepEqual(outcome, {
    status: 'checked',
    value: 'drafted',
    repairs: 1,
  });
  assert.match(lastFeedback(seen), /fields/u);
});

test('a final outcome and an unsupported answer are never repaired', async () => {
  const seen: Seen[] = [];
  const final = await draftPatchFromRequest(
    scripted([equipment, equipment], seen),
    'Add equipment',
    targets,
    {
      check: () =>
        Promise.resolve({ status: 'final' as const, value: 'author required' }),
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(final.status === 'checked' && final.value, 'author required');
  const refusal = await draftPatchFromRequest(
    scripted([
      { kind: 'unsupported', missingCapability: 'booking' },
      equipment,
    ]),
    'Make equipment bookable',
    targets,
    { check: () => Promise.reject(new Error('never checked')) },
  );
  assert.equal(refusal.status, 'unsupported');
});

test('diagnostics are bounded in count and length', () => {
  const shown = boundedDiagnostics(
    Array.from({ length: 20 }, (_, i) => `${String(i)} ${'x'.repeat(900)}`),
  );
  assert.equal(shown.length, 9);
  assert.ok(shown.slice(0, 8).every((line) => line.length <= 401));
  assert.match(shown[8]!, /12 more not shown/u);
});

// ---------------------------------------------------------------- new members

const parsedChange = async (input: unknown) => {
  const outcome = await draftPatchFromRequest(
    scripted([input]),
    'request',
    targets,
    {
      definition: application,
    },
  );
  assert.equal(outcome.status, 'parsed', JSON.stringify(outcome));
  return (outcome as { patch: CustomizationPatch }).patch;
};

test('a board drafts in the same change as its new record type, and rule 10 holds after', async () => {
  const entity = `${NS}:entity.custom_rental_contract`;
  const patch = await parsedChange({
    kind: 'changeSet',
    patches: [
      {
        kind: 'addRecordType',
        label: 'Rental contract',
        fields: [
          { label: 'Contract number', type: 'text' },
          { label: 'Start date', type: 'date' },
        ],
      },
      {
        kind: 'declareLifecycle',
        entity,
        initial: 'Quote',
        states: [
          { label: 'Quote' },
          { label: 'On rent', role: 'inProgress' },
          { label: 'Closed', role: 'success' },
        ],
        transitions: [
          { from: 'Quote', to: 'On rent', label: 'Start rental' },
          { from: 'On rent', to: 'Closed', label: 'Close' },
        ],
      },
      { kind: 'addBoardViewRevision', entity, label: 'Contracts board' },
    ],
  });
  assert.ok(patch.kind === 'changeSet');
  const board = patch.patches.at(-1)!;
  assert.equal(board.kind, 'addBoardViewRevision');
  const applied = applyCustomizationPatches(application, [patch]);
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  // Rule 10: with the board active, adding a field and arranging the list
  // on that type still apply.
  const later: CustomizationPatch[] = [
    patch,
    {
      kind: 'addField',
      entity,
      field: { label: 'Site', type: 'text' },
    },
    {
      kind: 'arrangeLayout',
      surface: `${NS}:surface.custom_rental_contract_list`,
      relabel: [
        {
          field: `${NS}:field.custom_rental_contract_start_date`,
          label: 'Starts',
        },
      ],
    },
  ];
  const after = applyCustomizationPatches(application, later);
  assert.equal(after.status, 'applied', JSON.stringify(after));
});

test('a board on a record type with no lifecycle earlier in the change is invalid, not guessed', async () => {
  const outcome = await draftPatchFromRequest(
    scripted([
      {
        kind: 'changeSet',
        patches: [
          equipment,
          {
            kind: 'addBoardViewRevision',
            entity: `${NS}:entity.custom_equipment`,
            label: 'Board',
          },
        ],
      },
    ]),
    'request',
    targets,
    { definition: application, maximumRepairs: 0 },
  );
  assert.equal(outcome.status, 'invalid');
});

test('an address field and its map draft from a record type and a label', async () => {
  const party = `${NS}:entity.party`;
  const patch = await parsedChange({
    kind: 'changeSet',
    patches: [
      { kind: 'addAddressField', entity: party, label: 'Delivery address' },
      { kind: 'addMapPlacement', field: 'Delivery address' },
    ],
  });
  assert.ok(patch.kind === 'changeSet');
  const [address, map] = patch.patches;
  assert.ok(address?.kind === 'addAddressField');
  assert.equal(address.fieldId, `${NS}:field.custom_party_delivery_address`);
  assert.ok(map?.kind === 'addMapPlacement');
  assert.equal(map.fieldId, address.fieldId);
  const applied = applyCustomizationPatches(application, [patch]);
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
});

test('a files field drafts with its categories as one change', async () => {
  const item = `${NS}:entity.item`;
  const patch = await parsedChange({
    kind: 'addDocumentField',
    entity: item,
    label: 'Spec sheets',
    maxCount: 3,
    categories: ['Datasheet', 'Certificate'],
  });
  assert.ok(patch.kind === 'changeSet');
  assert.deepEqual(
    patch.patches.map((member) => member.kind),
    ['addDocumentField', 'addUploadCategory', 'addUploadCategory'],
  );
  assert.equal(parseCustomizationPatch(patch).status, 'parsed');
  const single = await parsedChange({
    kind: 'addDocumentField',
    entity: item,
    label: 'Photos',
  });
  assert.equal(single.kind, 'addDocumentField');
});

// ---------------------------------------------------------------- scorer

test('capability buckets match whole words (the baseline refusal texts)', () => {
  const buckets = (text: string) =>
    Object.entries(CAPABILITY_BUCKETS)
      .filter(([, pattern]) => pattern.test(text))
      .map(([name]) => name);
  assert.deepEqual(
    buckets(
      'Date-range booking of equipment units, with checks for overlapping bookings and availability',
    ),
    ['booking'],
  );
  assert.deepEqual(
    buckets(
      'links on a published record type Links can be added when the record type is first created; adding one later is coming soon',
    ),
    ['linkLater'],
  );
  assert.deepEqual(buckets('address field with map pin on customers (party)'), [
    'address',
  ]);
  assert.deepEqual(
    buckets('scheduled customer email reminders before a rental end date'),
    ['email'],
  );
  assert.deepEqual(
    buckets(
      'PDF document generation from sales orders with customer e-signature',
    ),
    ['template'],
  );
  assert.deepEqual(
    buckets('board view for a record type created in the same change set'),
    ['board'],
  );
});
