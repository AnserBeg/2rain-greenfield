import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  BUILD_MODE_SWITCHES as TOOLING_SWITCHES,
  buildModeSwitch as toolingSwitch,
} from '../../packages/dev-tooling/src/build-mode.js';
import {
  BUILD_MODE_SWITCHES,
  buildModeSwitch,
  type BuildModeSwitchName,
} from '../../scripts/build-mode.mjs';
import {
  deriveLanguageCoverageDecisionId,
  evaluateLanguageCoverage,
  type LanguageCoverageDecision,
  type LanguageCoverageLedger,
} from '../helpers/language-conformance-ledger.js';
import {
  regenerateCoverageDecisions,
  type CoverageDecisionsDocument,
} from '../helpers/language-coverage-regenerate.js';
import {
  expectedMigrationNames,
  pinnedMigrationNames,
} from '../helpers/migration-list.js';
import { recordClaimExitCode } from './record-claim-fidelity.js';

function withTree<T>(files: Record<string, string>, run: (root: string) => T) {
  const root = mkdtempSync(join(tmpdir(), 'build-mode-'));
  try {
    for (const [path, body] of Object.entries(files)) {
      writeFileSync(join(root, path), body);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const config = (enabled: boolean, switches: Record<string, boolean>) =>
  JSON.stringify({ enabled, switches, version: 1 });

test('BUILD-MODE-1: the env can only force strict', () => {
  assert.deepEqual([...TOOLING_SWITCHES], [...BUILD_MODE_SWITCHES]);
  const off = { NORTH_STAR_BUILD_MODE: 'off' };
  for (const name of BUILD_MODE_SWITCHES) {
    assert.equal(buildModeSwitch(name, { env: off }), false, name);
    assert.equal(toolingSwitch(name, { env: off }), false, name);
  }
});

test('BUILD-MODE-1: both readers agree; a missing file, enabled=false or a false switch is strict', () => {
  const cases: [Record<string, string>, boolean][] = [
    [{}, false],
    [{ 'build-mode.json': config(true, { trainCapLifted: true }) }, true],
    [{ 'build-mode.json': config(false, { trainCapLifted: true }) }, false],
    [{ 'build-mode.json': config(true, { trainCapLifted: false }) }, false],
    [{ 'build-mode.json': config(true, {}) }, false],
  ];
  for (const [files, expected] of cases) {
    withTree(files, (root) => {
      for (const name of BUILD_MODE_SWITCHES) {
        const want = expected && name === 'trainCapLifted';
        assert.equal(buildModeSwitch(name, { env: {}, root }), want);
        assert.equal(toolingSwitch(name, { env: {}, root }), want);
      }
    });
  }
  for (const body of [
    '{"enabled":true,"switches":{"trainCapLiftd":true},"version":1}',
    '{"enabled":"yes","switches":{},"version":1}',
    '{"enabled":true,"switches":{},"version":2}',
  ]) {
    withTree({ 'build-mode.json': body }, (root) => {
      assert.throws(() => buildModeSwitch('trainCapLifted', { env: {}, root }));
      assert.throws(() => toolingSwitch('trainCapLifted', { env: {}, root }));
    });
  }
  assert.throws(() =>
    buildModeSwitch('everything' as BuildModeSwitchName, { env: {} }),
  );
});

test('BUILD-MODE-1 migrationListByGlob: build mode derives the list from disk; strict returns the pin', () => {
  const onDisk = readdirSync(resolve('db/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.deepEqual(expectedMigrationNames({ buildMode: true }), onDisk);
  const pinned = pinnedMigrationNames();
  assert.deepEqual(expectedMigrationNames({ buildMode: false }), pinned);

  withTree({}, (directory) => {
    const write = (...names: string[]) => {
      for (const name of readdirSync(directory)) rmSync(join(directory, name));
      for (const name of names) writeFileSync(join(directory, name), '');
    };
    const pin = ['0001_a.sql', '0002_b.sql'];
    // A new migration needs no edit in build mode...
    write('0001_a.sql', '0002_b.sql', '0003_c.sql');
    assert.deepEqual(
      expectedMigrationNames({ buildMode: true, directory, pinned: pin }),
      ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
    );
    // ...and still forces the pin edit in strict mode (the old behaviour).
    assert.notDeepEqual(
      expectedMigrationNames({ buildMode: false, directory, pinned: pin }),
      readdirSync(directory).sort(),
    );
    // Append-only and contiguous hold in build mode.
    write('0001_a.sql', '0002_renamed.sql', '0003_c.sql');
    assert.throws(
      () => expectedMigrationNames({ buildMode: true, directory, pinned: pin }),
      /append-only: pinned 0002_b\.sql is now 0002_renamed\.sql/u,
    );
    write('0001_a.sql', '0003_c.sql');
    assert.throws(
      () => expectedMigrationNames({ buildMode: true, directory, pinned: [] }),
      /must be contiguous/u,
    );
    write('0001_a.sql', '0002_b.sql', '0002_x.sql');
    assert.throws(
      () => expectedMigrationNames({ buildMode: true, directory, pinned: pin }),
      /must be contiguous/u,
    );
    write('0001_a.sql');
    assert.throws(
      () => expectedMigrationNames({ buildMode: true, directory, pinned: pin }),
      /append-only: pinned 0002_b\.sql is missing/u,
    );
  });
});

test('BUILD-MODE-1 recordChecksReportOnly: findings exit 0 in build mode and 1 strict', () => {
  const finding = { findings: [{}] } as unknown as Parameters<
    typeof recordClaimExitCode
  >[0];
  assert.equal(recordClaimExitCode(finding, true), 0);
  assert.equal(recordClaimExitCode(finding, false), 1);
  assert.equal(recordClaimExitCode({ findings: [] }, false), 0);
});

// A synthetic ledger the real evaluator accepts with decisions alone.
function ledger(
  digest: string,
  axes: { axis: string; values: string[] }[],
): LanguageCoverageLedger {
  const full = axes.map(({ axis, values }) => ({
    axis,
    specification: 'authoredLanguage' as const,
    values,
  }));
  return {
    axes: full,
    digest,
    obligations: full
      .flatMap((axis) =>
        axis.values.map((value) => ({
          axis: axis.axis,
          id: `authoredLanguage:${axis.axis}=${JSON.stringify(value)}`,
          specification: 'authoredLanguage' as const,
          value,
        })),
      )
      .sort((left, right) => (left.id < right.id ? -1 : 1)),
    roots: {
      authoredLanguage: {
        exportName: 'VersionedAuthoredApplicationPackage',
        sourcePath: 'packages/canonical-model/src/schemas.ts',
      },
      loweredStorage: {
        exportName: 'StorageTargetPayloadV1',
        sourcePath: 'packages/compiler/src/storage.ts',
      },
    },
    version: 'northstar.language-coverage-ledger/v1',
  };
}

function evaluate(
  document: CoverageDecisionsDocument,
  current: LanguageCoverageLedger,
  observed: ReadonlySet<string>,
) {
  return evaluateLanguageCoverage({
    acceptedButUnhonoredObligationIds: new Set(),
    creditedProducerFiles: new Set(),
    decisionObservedObligationIds: observed,
    decisions: document.decisions,
    ledger: current,
    observedObligationIds: observed,
    receiptClaims: [],
    receipts: [],
    runId: 'fixture',
  });
}

test('BUILD-MODE-1 languageCoverageDigestRegeneration: a new value is regenerated, a new kind is refused', () => {
  const before = ledger('digest-1', [
    { axis: '$.relations[].kind', values: ['a', 'b'] },
    { axis: '$.fields[].type', values: ['text'] },
  ]);
  const placeholder = (
    name: string,
    category: LanguageCoverageDecision['category'],
  ): LanguageCoverageDecision => ({
    acceptedButUnhonoredSetDigest: 'x',
    category,
    decisionId: `${name}@x`,
    ledgerDigest: 'x',
    obligationSetDigest: 'x',
    rationale: `reviewed rationale for ${name}`,
    revisitCondition: `revisit ${name}`,
  });
  const seed: CoverageDecisionsDocument = {
    acceptedButUnhonoredObligationIds: [],
    decisions: [
      placeholder('relations', 'observedRelationScope'),
      placeholder('outside', 'observedOutsideRelationScope'),
      placeholder('unobserved', 'unobserved'),
    ],
    ledgerDigest: 'x',
    obligationKinds: [
      'authoredLanguage:$.fields[].type',
      'authoredLanguage:$.relations[].kind',
    ],
    observationSnapshot: {} as CoverageDecisionsDocument['observationSnapshot'],
    version: 'northstar.language-coverage-decisions/v1',
  };
  const observedBefore = new Set([
    'authoredLanguage:$.relations[].kind="a"',
    'authoredLanguage:$.fields[].type="text"',
  ]);
  const first = regenerateCoverageDecisions(seed, before, observedBefore);
  assert.ok(first.ok);
  evaluate(first.document, before, observedBefore);

  // A new VALUE on an existing axis, newly observed: the old document is stale
  // to the real evaluator, the regenerated one passes, rationale untouched.
  const after = ledger('digest-2', [
    { axis: '$.relations[].kind', values: ['a', 'b', 'c'] },
    { axis: '$.fields[].type', values: ['text'] },
  ]);
  const observedAfter = new Set([
    ...observedBefore,
    'authoredLanguage:$.relations[].kind="c"',
  ]);
  assert.throws(
    () => evaluate(first.document, after, observedAfter),
    /LANGUAGE_COVERAGE_STALE_DECISION/u,
  );
  const second = regenerateCoverageDecisions(
    first.document,
    after,
    observedAfter,
  );
  assert.ok(second.ok);
  assert.equal(second.changed, true);
  evaluate(second.document, after, observedAfter);
  for (const [index, decision] of second.document.decisions.entries()) {
    const original: LanguageCoverageDecision = first.document.decisions[index]!;
    assert.equal(decision.rationale, original.rationale);
    assert.equal(decision.revisitCondition, original.revisitCondition);
    assert.equal(decision.category, original.category);
    const name = decision.decisionId.slice(
      0,
      decision.decisionId.lastIndexOf('@'),
    );
    assert.equal(name, original.decisionId.split('@')[0]);
    const { decisionId, ...body } = decision;
    assert.equal(decisionId, deriveLanguageCoverageDecisionId(name, body));
  }
  // Already current: nothing to rewrite.
  const third = regenerateCoverageDecisions(
    second.document,
    after,
    observedAfter,
  );
  assert.ok(third.ok);
  assert.equal(third.changed, false);

  // A NEW KIND (axis) is refused, naming it.
  const newKind = ledger('digest-3', [
    { axis: '$.relations[].kind', values: ['a', 'b', 'c'] },
    { axis: '$.fields[].type', values: ['text'] },
    { axis: '$.fields[].unit', values: ['kg'] },
  ]);
  const refused = regenerateCoverageDecisions(
    second.document,
    newKind,
    observedAfter,
  );
  assert.equal(refused.ok, false);
  assert.deepEqual(!refused.ok && refused.newKinds, [
    'authoredLanguage:$.fields[].unit',
  ]);
  // A document with no reviewed kinds list cannot be regenerated at all.
  const { obligationKinds: _dropped, ...unlisted } = second.document;
  void _dropped;
  assert.equal(
    regenerateCoverageDecisions(unlisted, after, observedAfter).ok,
    false,
  );
});
