/**
 * AI-RELY-1 slice 1: coverage gates that need no model. Each fails when its
 * check is removed (rule 8; the record names the mutations).
 *   (a) every drafted kind has a scored eval case or a dated, named exception;
 *   (b) `classifyDraftOutcome`, one test per branch, with the allowlist pinned;
 *   (d) every repairable refusal tells the model what to change.
 * Gate (c), capability coverage, needs the compiled release:
 * `test/agent/capability-coverage.test.ts`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTHORING_RULES,
  DRAFT_SHAPE_CAPABILITIES,
  DRAFTER_KIND_NAMES,
} from '../../packages/customization/src/index.js';
import {
  classifyDraftOutcome,
  REPAIRABLE_REFUSAL_CODES,
  type DraftOutcome,
} from '../../packages/postgres-provider/src/customization-service.js';
import {
  BUILD_CASES,
  EVAL_CASE_EXCEPTIONS,
  scoredKinds,
} from '../agent/build-eval-cases.js';

// ------------------------------------------------------------ (a) eval cases

test('(a) every drafted kind has a scored eval case or a dated, named exception', () => {
  const scored = new Set(BUILD_CASES.flatMap((c) => scoredKinds(c)));
  const missing = DRAFTER_KIND_NAMES.filter(
    (kind) => !scored.has(kind) && !(kind in EVAL_CASE_EXCEPTIONS),
  );
  assert.deepEqual(missing, [], 'drafted kinds no eval case scores');
  for (const [kind, exception] of Object.entries(EVAL_CASE_EXCEPTIONS)) {
    assert.ok(
      (DRAFTER_KIND_NAMES as readonly string[]).includes(kind),
      `${kind}: an exception for a kind the drafter does not emit`,
    );
    assert.ok(!scored.has(kind), `${kind} is scored now: remove its exception`);
    assert.match(exception.since, /^\d{4}-\d{2}-\d{2}$/u, kind);
    assert.ok(exception.owner.trim() && exception.reason.trim(), kind);
  }
});

test('(a) scored kinds are read from the expectation, one case per shape', () => {
  const kinds = (id: string) =>
    [...scoredKinds(BUILD_CASES.find((c) => c.id === id)!)].sort();
  assert.deepEqual(kinds('M01'), ['addRecordType']);
  assert.deepEqual(kinds('M06'), [
    'addLineTable',
    'addLink',
    'addRecordType',
    'changeSet',
    'declareLifecycle',
  ]);
  assert.deepEqual(kinds('F01'), ['addField']);
  assert.deepEqual(kinds('W01'), ['saveWorkflow']);
  assert.deepEqual(kinds('F06'), ['addBoardViewRevision']);
  for (const id of ['B01', 'B02', 'B03'])
    assert.deepEqual(kinds(id), ['addRatePlanVersion'], id);
  assert.deepEqual(kinds('U02'), [], 'an unsupported case scores no kind');
});

// ------------------------------------------------------------ (b) classifier

const refused = (code?: string): DraftOutcome => ({
  status: 'refused',
  message: 'refused',
  ...(code ? { code } : {}),
});

/** Every patch-application refusal code and whether the model may repair it. */
const EXPECTED_REPAIRABLE: Readonly<
  Record<keyof typeof AUTHORING_RULES, boolean>
> = {
  CUSTOMIZE_CHOICE_PLATFORM_OWNED: true,
  CUSTOMIZE_DUPLICATE_LABEL: true,
  CUSTOMIZE_RECORD_TYPE_EXISTS: true,
  CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET: true,
  CUSTOMIZE_TARGET_NOT_CHOICE: true,
  CUSTOMIZE_TARGET_NOT_FOUND: true,
  CUSTOMIZE_LIST_VIEW_INVALID: true,
  CUSTOMIZE_FIELD_NOT_ON_LIST: true,
  CUSTOMIZE_BOARD_CONFLICT: true,
  CUSTOMIZE_LAYOUT_CONFLICT: true,
  CUSTOMIZE_RECORD_TEMPLATE_CONFLICT: true,
  CUSTOMIZE_PRESENTATION_CONFLICT: true,
  // A button bound to a Task the person may not run: final (filed).
  CUSTOMIZE_POPUP_CONFLICT: false,
  // REPORTS (merged 2026-11-22): final on main, not in the allowlist (filed).
  CUSTOMIZE_REPORT_CONFLICT: false,
  // PLANNER-1 Map: final, not in the allowlist (a slice 2 task, filed).
  CUSTOMIZE_MAP_CONFLICT: false,
};

test('(b) a drafted outcome is accepted', () => {
  const drafted = {
    status: 'drafted',
    patchId: 'p',
  } as unknown as DraftOutcome;
  assert.equal(classifyDraftOutcome(drafted).status, 'accepted');
});

test('(b) a schema-invalid draft is repaired with its issues', () => {
  const result = classifyDraftOutcome({
    status: 'invalid',
    message: 'invalid draft',
    issues: ['label: required'],
  });
  assert.equal(result.status, 'repair');
  assert.ok(
    result.status === 'repair' &&
      result.diagnostics.includes('label: required'),
  );
});

test('(b) a compiler rejection is repaired; a replay rejection is final', () => {
  assert.equal(
    classifyDraftOutcome({ status: 'rejected', message: 'compile' }).status,
    'repair',
  );
  assert.equal(
    classifyDraftOutcome({
      status: 'rejected',
      message: 'replay',
      replayDiagnostics: {} as never,
    }).status,
    'final',
  );
});

test('(b) each refusal code is repaired exactly when the allowlist names it', () => {
  assert.deepEqual(
    Object.keys(EXPECTED_REPAIRABLE).sort(),
    Object.keys(AUTHORING_RULES).sort(),
    'every refusal code is classified here',
  );
  for (const [code, repairable] of Object.entries(EXPECTED_REPAIRABLE))
    assert.equal(
      classifyDraftOutcome(refused(code)).status,
      repairable ? 'repair' : 'final',
      code,
    );
  assert.deepEqual(
    [...REPAIRABLE_REFUSAL_CODES].sort(),
    Object.entries(EXPECTED_REPAIRABLE)
      .filter(([, repairable]) => repairable)
      .map(([code]) => code)
      .sort(),
  );
});

test('(b) authority, staleness and uncoded refusals are final', () => {
  for (const code of [
    'CUSTOMIZE_DRAFT_STALE',
    'CUSTOMIZE_AUTHOR_REQUIRED',
    'CUSTOMIZE_POPUP_OPERATION_DENIED',
    'CUSTOMIZE_APPROVAL_RECONCILIATION_REQUIRED',
  ])
    assert.equal(classifyDraftOutcome(refused(code)).status, 'final', code);
  assert.equal(classifyDraftOutcome(refused()).status, 'final');
});

test('(b) only a draft-shape unsupported outcome is repaired', () => {
  for (const capability of DRAFT_SHAPE_CAPABILITIES)
    assert.equal(
      classifyDraftOutcome({
        status: 'unsupported',
        message: 'shape',
        missingCapability: capability,
      }).status,
      'repair',
      capability,
    );
  assert.equal(
    classifyDraftOutcome({
      status: 'unsupported',
      message: 'limit',
      missingCapability: 'booking',
    }).status,
    'final',
  );
  assert.equal(
    classifyDraftOutcome({ status: 'unsupported', message: 'none' }).status,
    'final',
  );
});

// ------------------------------------------------- (d) what to change

test('(d) every repairable refusal carries its code, message and the rule it broke', () => {
  assert.ok(REPAIRABLE_REFUSAL_CODES.size > 0);
  for (const code of REPAIRABLE_REFUSAL_CODES) {
    const rules = AUTHORING_RULES[code as keyof typeof AUTHORING_RULES];
    assert.ok(rules.length > 0, `${code} has no rule`);
    for (const rule of rules)
      assert.ok(
        rule.trim().split(/\s+/u).length >= 6,
        `${code}: rule too thin`,
      );
    const result = classifyDraftOutcome({
      status: 'refused',
      code,
      message: 'Use a tenant field ID.',
    });
    assert.ok(result.status === 'repair', code);
    assert.equal(result.diagnostics[0], `${code}: Use a tenant field ID.`);
    for (const rule of rules)
      assert.ok(
        result.diagnostics.includes(`rule: ${rule}`),
        `${code}: ${rule}`,
      );
  }
});

test('(d) a final refusal is not given rules to argue with', () => {
  const result = classifyDraftOutcome(refused('CUSTOMIZE_DRAFT_STALE'));
  assert.equal(result.status, 'final');
});
