import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as customization from '../../packages/customization/src/index.js';
import {
  BOARD_READER,
  boardDigest,
  moveContractDigest,
  normalizeApplicationPackage,
  type BoardBody,
} from '../../packages/canonical-model/src/index.js';
import { VALIDATION_NODE_VERSION } from '../../packages/canonical-model/src/formula-validation.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import { replayCustomizationPatches } from '../../packages/customization/src/upgrade-replay.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import {
  boardBindingsProblem,
  boardDeclarationProblem,
} from '../../packages/postgres-provider/src/board-admission.js';
import { projectionPayload } from '../compiler/helpers.js';

// CALENDAR-1 Board v2 fix (ADR-0086, view revision member shape). Each test
// names the packet proof it carries.
type Json = Record<string, unknown>;
type Revision = ReturnType<typeof customization.draftBoardRevision>;
const file = 'apps/web/release/app.authored.json';
const authored: Json = JSON.parse(readFileSync(file, 'utf8'));
const tip = parseCompiledApplication(
  JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
).application;
const acknowledgement = readUnboundPermissionAcknowledgementFor(
  file,
  'northstar.app:package.application',
);
const id = (s: string) => 'northstar.app:' + s;
const patch = (input: unknown) =>
  customization.CustomizationPatchSchema.parse(input);
const opportunity = id('entity.custom_opportunity');
const tenant = patch({
  kind: 'changeSet',
  patches: [
    {
      kind: 'addRecordType',
      label: 'Opportunity',
      fields: [{ label: 'Name', type: 'text', required: true }],
    },
    {
      kind: 'declareLifecycle',
      entity: opportunity,
      initial: 'Open',
      states: [{ label: 'Open' }, { label: 'Won', role: 'success' }],
      transitions: [{ from: 'Open', to: 'Won', label: 'Mark won' }],
    },
  ],
});
const addAmount = patch({
  kind: 'addField',
  entity: opportunity,
  field: { label: 'Amount', type: 'text' },
  screens: 'record',
});
const poList = id('surface.purchase_order_list');
const cancel = id('operation.purchase_order_draft_cancel');
const orderDate = id('field.purchase_order_order_date');
const expected = id('field.purchase_order_expected_date');

function applied(base: Json, chain: unknown[]) {
  const result = customization.applyCustomizationPatches(
    base,
    chain.map(patch),
  );
  assert.ok(
    result.status === 'applied',
    JSON.stringify(result.status === 'applied' ? null : result),
  );
  return result.authored;
}
function target(base: Json, chain: unknown[], listOrEntity: string) {
  const found = customization
    .customizationTargets(normalizeApplicationPackage(applied(base, chain)))
    .boards!.find(
      (t) =>
        t.frame.listSurfaceId === listOrEntity ||
        t.frame.entityId === listOrEntity,
    );
  assert.ok(found, 'the List offers a Board');
  return found;
}
/** Compile the whole chain's final step in the tenant sandbox. */
async function compiles(chain: unknown[]) {
  const result = await customization.compileInSandbox({
    acknowledgement,
    base: authored,
    chain: chain.map(patch),
    tip: customization.serializeRelease(tip),
    startAt: chain.length - 1,
  });
  assert.ok(
    result.status === 'compiled',
    JSON.stringify(result.status === 'compiled' ? null : result),
  );
  return result;
}
function retire(offer: customization.BoardTarget, board: Revision) {
  return customization.draftBoardRevision(
    offer,
    board.label,
    customization.choicesOf(board.body),
    {
      surfaceId: board.surfaceId,
      label: board.label,
      revisionId: board.revisionId,
      lifecycle: 'active',
      body: board.body,
    },
    'retired',
  );
}
function rebind(
  offer: customization.BoardTarget,
  board: Revision,
  choices: customization.BoardChoices,
) {
  return customization.draftBoardRevision(offer, board.label, choices, {
    surfaceId: board.surfaceId,
    label: board.label,
    revisionId: board.revisionId,
    lifecycle: 'active',
    body: board.body,
  });
}
const origins = (source: Json, length: number) =>
  Array.from({ length }, (_, index) => ({
    patchId: 'p' + index,
    differentBase: true,
    ...(index === 0 && { parent: source }),
  }));
/** Replay a chain recorded on `source` onto a changed first-party base. */
function replay(source: Json, base: Json, chain: unknown[]) {
  const parsed = chain.map(patch);
  return customization.compileCustomizationCandidate({
    acknowledgement,
    base,
    chain: parsed,
    parent: tip,
    upgradeReplay: true,
    origins: origins(source, parsed.length),
  });
}
/** The serving admission of a compiled step, as the loader and verifier run it. */
function admission(result: { steps: readonly { release: unknown }[] }) {
  const release = customization.parseSerializedRelease(
    result.steps.at(-1)!.release as Parameters<
      typeof customization.parseSerializedRelease
    >[0],
  );
  const payload = (family: string) =>
    projectionPayload<Json>(
      release.compiled,
      family as Parameters<typeof projectionPayload>[1],
    );
  const surface = release.compiled.bundle.releaseManifest.projections.find(
    (p) => p.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
  )!;
  const manifest = payload(PROJECTION_FAMILY_IDS.surfaceManifest);
  const floor = surface.requiredRuntimeCapability.minimumVersion;
  const operations = payload(PROJECTION_FAMILY_IDS.operationCatalog);
  const queries = payload(PROJECTION_FAMILY_IDS.queryCatalog);
  const definition = JSON.parse(
    new TextDecoder().decode(release.normalizedDefinitionBytes),
  ) as unknown;
  return {
    manifest,
    floor,
    problem: (m: Json = manifest, f = floor) =>
      boardBindingsProblem(m, f, operations, queries) ??
      boardDeclarationProblem(definition, m, f),
  };
}
const findings = (result: ReturnType<typeof replay>) =>
  result.status === 'replayConflict'
    ? result.findings.map((f) => [f.code, f.subject])
    : result.status;
/** Replay onto a changed base and compile it in the sandbox, as an upgrade does. */
async function replaysClean(source: Json, base: Json, chain: unknown[]) {
  const parsed = chain.map(patch);
  const result = await customization.compileInSandbox({
    acknowledgement,
    base,
    chain: parsed,
    origins: origins(source, parsed.length),
    tip: customization.serializeRelease(tip),
    upgradeBaseRoot: tip.compiled.releaseRoot,
  });
  assert.ok(
    result.status === 'compiled',
    JSON.stringify(result.status === 'compiled' ? null : result),
  );
  return result;
}
const changed = (mutate: (base: Json) => void) => {
  const base = structuredClone(authored);
  mutate(base);
  return base;
};
const rows = (base: Json, table: string) => base[table] as Json[];
const byId = (base: Json, table: string, key: string, value: string) =>
  rows(base, table).find((row) => row[key] === value)!;
const refusedWith = (reason: string) => (error: unknown) =>
  JSON.stringify((error as { diagnostics?: unknown }).diagnostics).includes(
    reason,
  );
const poMachine = (base: Json) =>
  byId(
    base,
    'stateMachines',
    'machineId',
    id('machine.purchase_order_lifecycle'),
  );
const poOffer = target(authored, [], poList);
const poBoard = customization.draftBoardRevision(
  poOffer,
  'Purchase order board',
  customization.defaultBoardChoices(poOffer),
);

test('Board v2 records explicit choices by stable ID, with the version literal 2 and no labels', () => {
  assert.equal(poBoard.version, 2);
  assert.equal(poBoard.body.version, 2);
  assert.equal(poBoard.body.grouping.version, 2);
  assert.deepEqual(poBoard.body.facts, [
    { fieldId: orderDate, fieldType: 'dateTimeFieldType' },
    { fieldId: expected, fieldType: 'dateTimeFieldType' },
    {
      fieldId: id('field.purchase_order_currency'),
      fieldType: 'textFieldType',
    },
  ]);
  assert.deepEqual(
    poBoard.body.grouping.moves.map((m) => [m.operationId, m.tier]),
    [[cancel, 'o0']],
  );
  assert.doesNotMatch(
    JSON.stringify(poBoard),
    /"label":"(?!Purchase order board)/u,
  );
  assert.equal(poBoard.resultDigest, boardDigest(poBoard.body));
  // Reader: a v1-shaped patch (the withdrawn shape) is refused by the parser.
  const v1 = {
    kind: 'addBoardViewRevision',
    schemaVersion: 'v6',
    surfaceId: poBoard.surfaceId,
    listSurfaceId: poList,
    label: 'Purchase order board',
    lifecycle: 'active',
    revisionId: poBoard.revisionId,
    predecessor: null,
    grouping: {
      kind: 'lifecycleState',
      version: 1,
      machineId: id('machine.purchase_order_lifecycle'),
      states: poBoard.body.grouping.stages.map((s) => s.stateId),
    },
    resultDigest: poBoard.resultDigest,
  };
  assert.equal(
    customization.CustomizationPatchSchema.safeParse(v1).success,
    false,
  );
  const issues =
    customization.BoardViewRevisionSchema.safeParse(v1).error!.issues;
  assert.ok(
    issues.some((i) => i.path.join('.') === 'version'),
    JSON.stringify(issues),
  );
  assert.equal(BOARD_READER, 37);
});

test('proof: from a Board with zero facts, and again after retiring it, adding a field still compiles', async () => {
  const offer = target(authored, [tenant], opportunity);
  assert.deepEqual(offer.defaultFacts, []);
  const board = customization.draftBoardRevision(offer, 'Pipeline', {
    stateIds: offer.stages.map((s) => s.stateId),
    operationIds: offer.moves.map((m) => m.operationId),
    factFieldIds: [],
  });
  assert.deepEqual(board.body.facts, []);
  await compiles([tenant, board, addAmount]);
  await compiles([tenant, board, retire(offer, board), addAmount]);
});

const poArrangements = [
  {
    kind: 'arrangeLayout',
    surface: poList,
    relabel: [{ field: orderDate, label: 'Ordered on' }],
  },
  { kind: 'arrangeLayout', surface: poList, hide: [orderDate] },
  {
    kind: 'arrangeLayout',
    surface: poList,
    order: [expected, id('field.purchase_order_number')],
  },
  {
    kind: 'arrangeLayout',
    surface: poList,
    hide: [id('field.purchase_order_number')],
  },
  {
    kind: 'narrowPermission',
    target: { kind: 'operation', id: cancel },
    roleKey: 'viewer',
  },
];
// Not expressible today: a validation rule binds only create and update
// operations, never a lifecycle transition. Pinned so the day it becomes
// expressible this proof is owed (CALENDAR-1 Board v2 fix, E15).
const transitionValidation = {
  kind: 'addValidation',
  rule: {
    kind: 'validationRule',
    schemaVersion: VALIDATION_NODE_VERSION,
    ruleId: id('rule.custom_cancel_needs_notes'),
    targetId: id('entity.purchase_order'),
    boundOperationIds: [cancel],
    trigger: {
      schemaVersion: VALIDATION_NODE_VERSION,
      kind: 'afterDefaultsOrChangedFields',
    },
    absence: {
      schemaVersion: VALIDATION_NODE_VERSION,
      kind: 'validationThreeValued',
    },
    effect: 'refuse',
    existingRecords: 'grandfather',
    message: 'Explain the cancellation in the notes.',
    fieldAnchors: [id('field.purchase_order_notes')],
    predicate: {
      schemaVersion: VALIDATION_NODE_VERSION,
      kind: 'comparison',
      operator: 'notEqual',
      left: {
        schemaVersion: VALIDATION_NODE_VERSION,
        kind: 'field',
        fieldId: id('field.purchase_order_notes'),
        select: 'value',
      },
      right: {
        schemaVersion: VALIDATION_NODE_VERSION,
        kind: 'literal',
        scalar: { kind: 'text', value: 'none' },
      },
    },
  },
};
test('proof: from a Board with chosen facts, and again after retiring it, relabelling, hiding and reordering a fact column, hiding the title column and narrowing its operation still compile', async () => {
  // Normalization is where v1 refused; check each change alone, then compile
  // the whole chain once with the Board active and once after retiring it.
  const retired = retire(poOffer, poBoard);
  for (const change of poArrangements) {
    normalizeApplicationPackage(applied(authored, [poBoard, change]));
    normalizeApplicationPackage(applied(authored, [poBoard, retired, change]));
  }
  await compiles([poBoard, ...poArrangements]);
  await compiles([poBoard, retired, ...poArrangements]);
  assert.throws(
    () =>
      normalizeApplicationPackage(
        applied(authored, [poBoard, transitionValidation]),
      ),
    refusedWith('Bind the rule to active create and update operations'),
  );
});

test('proof: a label-only base change to a stage, a fact column or an operation replays clean', async () => {
  const relabel = (stage: boolean) =>
    changed((base) => {
      const machine = poMachine(base);
      if (stage) {
        (machine.states as Json[])[0]!.label = 'Being drafted';
        return;
      }
      (machine.transitions as Json[]).find(
        (t) => t.transitionId === id('transition.purchase_order_draft_cancel'),
      )!.label = 'Withdraw order';
      const list = byId(base, 'surfaces', 'surfaceId', poList).list as {
        columns: Json[];
      };
      list.columns.find((c) => c.field === orderDate)!.label = 'Placed on';
      byId(base, 'fields', 'fieldId', expected).label = 'Due';
    });
  const retired = retire(poOffer, poBoard);
  for (const chain of [[poBoard], [poBoard, retired]]) {
    await replaysClean(authored, relabel(true), chain);
    await replaysClean(authored, relabel(false), chain);
  }
});

const removed: [string, (base: Json) => void, [string, string][]][] = [
  [
    'operation',
    (base) => {
      base.operations = rows(base, 'operations').filter(
        (o) => o.operationId !== cancel,
      );
    },
    [['RETIRED_TARGET', cancel]],
  ],
  [
    'field',
    (base) => {
      byId(base, 'fields', 'fieldId', expected).lifecycle = 'retired';
    },
    [['RETIRED_TARGET', expected]],
  ],
  [
    'stage',
    (base) => {
      const machine = poMachine(base);
      machine.states = (machine.states as Json[]).filter(
        (s) => s.stateId !== id('state.purchase_order_closed'),
      );
    },
    [['RETIRED_TARGET', id('state.purchase_order_closed')]],
  ],
  [
    'transition',
    (base) => {
      const machine = poMachine(base);
      machine.transitions = (machine.transitions as Json[]).filter(
        (t) => t.transitionId !== id('transition.purchase_order_draft_cancel'),
      );
    },
    [['RETIRED_TARGET', id('transition.purchase_order_draft_cancel')]],
  ],
  [
    'retargeted edge',
    (base) => {
      (
        (poMachine(base).transitions as Json[]).find(
          (t) =>
            t.transitionId === id('transition.purchase_order_draft_cancel'),
        )!.toState as Json
      ).targetId = id('state.purchase_order_closed');
    },
    [['INCOMPATIBLE_TYPE', cancel]],
  ],
  [
    'field type',
    (base) => {
      byId(base, 'fields', 'fieldId', expected).fieldType = {
        kind: 'dateFieldType',
        calendar: 'iso8601',
        schemaVersion: 'v6',
        timezoneSemantics: 'calendarDate',
      };
    },
    [['INCOMPATIBLE_TYPE', expected]],
  ],
  [
    'tier o0 to o1',
    (base) => {
      byId(base, 'operations', 'operationId', cancel).tier = 'o1';
    },
    [['INCOMPATIBLE_TYPE', cancel]],
  ],
];
for (const [what, mutate, codes] of removed)
  test(`proof: a base change to a bound ${what} yields its exact typed conflict naming its ID`, () => {
    const result = replay(authored, changed(mutate), [poBoard]);
    assert.deepEqual(findings(result), codes);
  });

test('proof: a base change of a bound operation confirmation from none to humanRequired replays clean', async () => {
  const source = changed((base) => {
    byId(base, 'operations', 'operationId', cancel).confirmation = 'none';
  });
  const offer = target(source, [], poList);
  const board = customization.draftBoardRevision(
    offer,
    'Purchase order board',
    customization.defaultBoardChoices(offer),
  );
  // The pinned contract is identical: confirmation is read live by the Task.
  assert.equal(board.resultDigest, poBoard.resultDigest);
  await replaysClean(source, authored, [board]);
});

test('proof: active then retired, and active then rebound, replay clean on a base that removed an operation only the first revision bound', async () => {
  const withoutCancel = changed((base) => {
    base.operations = rows(base, 'operations').filter(
      (o) => o.operationId !== cancel,
    );
  });
  const rebound = rebind(poOffer, poBoard, {
    ...customization.defaultBoardChoices(poOffer),
    operationIds: [],
  });
  for (const chain of [
    [poBoard, retire(poOffer, poBoard)],
    [poBoard, rebound],
  ]) {
    // The serving reader admits the compiled release too: a retired Board's
    // bindings are not checked, and the rebound Board binds nothing removed.
    const served = admission(
      await replaysClean(authored, withoutCancel, chain),
    );
    assert.equal(served.floor, BOARD_READER);
    assert.equal(served.problem(), null);
  }
});

test('proof: a new base operation between two chosen stages is not offered until a new revision chooses it', () => {
  const close = id('operation.purchase_order_close_board');
  const withClose = changed((base) => {
    const copy = structuredClone(
      byId(base, 'operations', 'operationId', cancel),
    );
    copy.operationId = close;
    ((copy.effect as Json).transition as Json).targetId = id(
      'transition.purchase_order_close',
    );
    copy.precondition = {
      ...(copy.precondition as Json),
      value: {
        kind: 'textValue',
        schemaVersion: 'v6',
        value: id('state.purchase_order_released'),
      },
    };
    rows(base, 'operations').push(copy);
  });
  const offered = target(withClose, [], poList);
  assert.ok(offered.moves.some((m) => m.operationId === close));
  const result = replayCustomizationPatches(
    withClose,
    [patch(poBoard)],
    origins(authored, 1),
  );
  assert.ok(result.status === 'applied', JSON.stringify(result));
  const board = normalizeApplicationPackage(result.authored).surfaces.find(
    (s) => s.surfaceId === poBoard.surfaceId,
  ) as unknown as { board: { body: BoardBody } };
  assert.deepEqual(
    board.board.body.grouping.moves.map((m) => m.operationId),
    [cancel],
  );
  const chosen = rebind(offered, poBoard, {
    ...customization.choicesOf(poBoard.body),
    operationIds: [cancel, close],
  });
  assert.deepEqual(
    chosen.body.grouping.moves.map((m) => m.operationId),
    [cancel, close],
  );
});

test('proof: on the authoring base a patch whose digest does not match its recorded IDs and contracts is refused', () => {
  const refused = (change: Revision, message: RegExp) => {
    const result = customization.applyCustomizationPatches(authored, [
      patch(change),
    ]);
    assert.equal(result.status, 'refused', JSON.stringify(result));
    assert.match((result as { message: string }).message, message);
  };
  // The body was edited after the digest was taken.
  const tampered = structuredClone(poBoard);
  tampered.body.facts.pop();
  refused(tampered, /digest does not match its recorded bindings/u);
  // A self-consistent body whose choices this base never offered: the
  // supplier is selected by the list query but is not the List's title.
  const forged = structuredClone(poBoard);
  forged.body.title = {
    fieldId: id('field.purchase_order_supplier_party_id'),
    fieldType: 'textFieldType',
  };
  forged.resultDigest = boardDigest(forged.body);
  refused(forged, /recorded IDs and contracts on this base/u);
});

test('proof: normalization checks the recorded digest and each binding by ID, never re-deriving, and skips a retired Board', () => {
  const built = applied(authored, [poBoard]);
  const board = (base: Json) =>
    rows(base, 'surfaces').find((s) => s.surfaceId === poBoard.surfaceId)!;
  const tampered = structuredClone(built);
  (board(tampered).board as { body: BoardBody }).body.facts.pop();
  assert.throws(
    () => normalizeApplicationPackage(tampered),
    refusedWith('digest does not match its recorded bindings'),
  );
  // A self-consistent member whose operation this package does not declare.
  const gone = id('operation.custom_gone');
  const dangling = structuredClone(built);
  const member = board(dangling).board as {
    body: BoardBody;
    resultDigest: string;
  };
  const move = member.body.grouping.moves[0]!;
  move.operationId = gone;
  move.contractDigest = moveContractDigest(move);
  member.resultDigest = boardDigest(member.body);
  assert.throws(
    () => normalizeApplicationPackage(dangling),
    refusedWith(`Board binding ${gone} is absent or retired`),
  );
  board(dangling).lifecycle = 'retired';
  normalizeApplicationPackage(dangling);
});

test('proof: the serving reader refuses an understated surface floor, a stated floor without a Board, and a forged move', async () => {
  const served = admission(await compiles([poBoard]));
  assert.equal(served.floor, BOARD_READER);
  assert.equal(served.problem(), null);
  // Finding 6: a manifest carrying a Board under the preceding rung.
  assert.equal(
    served.problem(served.manifest, BOARD_READER - 1),
    'Board bindings and the surface reader floor disagree.',
  );
  const boardless = structuredClone(served.manifest);
  boardless.surfaces = (boardless.surfaces as Json[]).filter(
    (s) => s.archetype !== 'board',
  );
  assert.equal(
    served.problem(boardless, BOARD_READER),
    'Board bindings and the surface reader floor disagree.',
  );
  // A self-consistent move whose operation the catalog binds differently.
  const forged = structuredClone(served.manifest);
  const member = (forged.surfaces as Json[]).find(
    (s) => s.archetype === 'board',
  )!.board as { body: BoardBody; resultDigest: string };
  const move = member.body.grouping.moves[0]!;
  move.toStateId = id('state.purchase_order_closed');
  member.body.grouping.stages = [
    ...member.body.grouping.stages.filter((s) => s.stateId !== move.toStateId),
    { stateId: move.toStateId },
  ];
  move.contractDigest = moveContractDigest(move);
  member.resultDigest = boardDigest(member.body);
  assert.equal(
    served.problem(forged, BOARD_READER),
    'The Board move must bind the declared lifecycle transition.',
  );
});

test('a Board on a List that no longer qualifies can still be retired', () => {
  const built = applied(authored, [poBoard]);
  // A second Record surface for purchase orders that names no owner makes the
  // authoring gates refuse the List; the recorded Board stays valid.
  const record = structuredClone(
    rows(built, 'surfaces').find(
      (s) => s.surfaceId === poBoard.body.recordSurfaceId,
    )!,
  );
  const twin = id('surface.purchase_order_detail_twin');
  record.surfaceId = twin;
  delete record.workspace;
  for (const slot of record.slots as Json[])
    slot.slotId = String(slot.slotId) + '_twin';
  rows(built, 'surfaces').push(record);
  const owner = rows(built, 'surfaces').find(
    (s) => s.surfaceId === poBoard.body.recordSurfaceId,
  )!;
  delete owner.workspace;
  const def = normalizeApplicationPackage(built);
  const found = customization
    .customizationTargets(def)
    .boards!.find((t) => t.frame.listSurfaceId === poList)!;
  assert.equal(found.retireOnly, true);
  const retired = customization.draftBoardRevision(
    found,
    'Purchase order board',
    customization.choicesOf(poBoard.body),
    found.views[0],
    'retired',
  );
  const result = customization.applyCustomizationPatches(built, [
    patch(retired),
  ]);
  assert.equal(result.status, 'applied', JSON.stringify(result));
});
