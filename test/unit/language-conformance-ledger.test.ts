import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { lowerStorageTargetV1 } from '../../packages/compiler/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { platformModuleDefinition } from '../../packages/domain/src/platform/definition.js';
import {
  LANGUAGE_COVERAGE_LEDGER_VERSION,
  LANGUAGE_COVERAGE_RECEIPT_VERSION,
  deriveLanguageCoverageLedger,
  deriveDecisionSetDigest,
  evaluateLanguageCoverage,
  makeLanguageCoverageReceipt,
  observeLanguageCoverage,
  type LanguageCoverageDecision,
  type LanguageCoverageLedger,
  type LanguageCoverageObligation,
  type LanguageCoverageReceipt,
} from '../helpers/language-conformance-ledger.js';

const testFile = 'test/unit/language-conformance-ledger.test.ts';
const runId = 'language-conformance-control';

test('the ledger derives authored and lowered closed choices from both specifications', () => {
  const ledger = deriveLanguageCoverageLedger();

  assert.ok(
    ledger.axes.some((axis) => axis.specification === 'authoredLanguage'),
  );
  assert.ok(
    ledger.axes.some((axis) => axis.specification === 'loweredStorage'),
  );
  assert.deepEqual(
    axis(ledger, 'authoredLanguage', '$.relations[].required')?.values,
    [false, true],
  );
  assert.deepEqual(
    axis(
      ledger,
      'loweredStorage',
      '$.relations[].relationColumn.origin.$presence',
    )?.values,
    ['absent', 'present'],
  );
  assert.deepEqual(
    axis(
      ledger,
      'loweredStorage',
      '$.relations[].relationColumn.postgresqlType',
    )?.values,
    ['uuid'],
  );
  assert.deepEqual(
    axis(ledger, 'authoredLanguage', '$relationGraph.topology')?.values,
    [
      'chain',
      'directedCycle',
      'disconnectedComponents',
      'distinctEdge',
      'equalDepthDiamond',
      'fanIn',
      'fanOut',
      'noEdge',
      'parallelEdges',
      'selfEdge',
    ],
  );
});

test('the language gate is wired into local, matrix, and hosted acceptance paths', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  const matrix = readFileSync('scripts/run-matrix.sh', 'utf8');
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const gate = readFileSync('test/helpers/check-language-coverage.ts', 'utf8');

  assert.equal(
    packageJson.scripts['check:language-coverage'],
    'node --import tsx test/helpers/check-language-coverage.ts',
  );
  assert.match(
    packageJson.scripts.test ?? '',
    /corepack pnpm check:language-coverage/u,
  );
  assert.match(matrix, /corepack pnpm check:language-coverage/u);
  assert.match(workflow, /run: corepack pnpm check:language-coverage/u);
  assert.match(
    gate,
    /green proves the exact shape and decision partitions have not drifted, not that decision-covered shapes execute/u,
  );
});

test('phantom-axis control refuses a claim for an obligation absent from the derived ledger', () => {
  const ledger = fixtureLedger();

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        creditedTestFiles: new Set([testFile]),
        decisionObservedObligationIds: new Set(),
        decisions: fixtureDecisions(ledger),
        ledger,
        observedObligationIds: new Set(),
        receiptClaims: [
          {
            expectedOutcome: 'executed',
            obligationId: 'authoredLanguage:$.phantomAxis="claimable"',
            receiptId: 'phantom',
          },
        ],
        receipts: [],
        runId,
      }),
    /LANGUAGE_COVERAGE_PHANTOM_OBLIGATION/u,
  );
});

test('evidence-tamper control refuses an altered execution receipt', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;
  const receipt = executionReceipt(obligation);
  const tampered = {
    ...receipt,
    observedFact: { storedValue: 'forged-after-observation' },
  } satisfies LanguageCoverageReceipt;

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        creditedTestFiles: new Set([testFile]),
        decisionObservedObligationIds: new Set(),
        decisions: fixtureDecisions(ledger),
        ledger,
        observedObligationIds: new Set(),
        receiptClaims: [
          {
            expectedOutcome: 'executed',
            obligationId: obligation.id,
            receiptId: receipt.receiptId,
          },
        ],
        receipts: [tampered],
        runId,
      }),
    /LANGUAGE_COVERAGE_RECEIPT_TAMPERED/u,
  );
});

test('entry-skip control names an obligation with neither evidence nor a written decision', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        creditedTestFiles: new Set([testFile]),
        decisionObservedObligationIds: new Set(),
        decisions: [],
        ledger,
        observedObligationIds: new Set(),
        receiptClaims: [],
        receipts: [],
        runId,
      }),
    new RegExp(
      `LANGUAGE_COVERAGE_UNCLAIMED_ENTRY: .*${escapeRegExp(obligation.id)}`,
      'u',
    ),
  );
});

test('refusal-distinguisher control cannot use a typed refusal as an execution receipt', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;
  const refusal = makeLanguageCoverageReceipt({
    obligationId: obligation.id,
    observedFact: { diagnostic: 'SYNTHETIC_TYPED_REFUSAL' },
    outcome: 'typedRefusal',
    producer: { suiteId: 'unit', testFile },
    receiptId: 'refusal-receipt',
    refusalDiagnostic: 'SYNTHETIC_TYPED_REFUSAL',
    runId,
    version: LANGUAGE_COVERAGE_RECEIPT_VERSION,
    witnessId: 'refusal-distinguisher-control',
  });

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        creditedTestFiles: new Set([testFile]),
        decisionObservedObligationIds: new Set(),
        decisions: fixtureDecisions(ledger),
        ledger,
        observedObligationIds: new Set(),
        receiptClaims: [
          {
            expectedOutcome: 'executed',
            obligationId: obligation.id,
            receiptId: refusal.receiptId,
          },
        ],
        receipts: [refusal],
        runId,
      }),
    /LANGUAGE_COVERAGE_OUTCOME_MISMATCH/u,
  );
});

test('execution and typed-refusal receipts can take over a moved obligation without stretching its decision', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;

  for (const outcome of ['executed', 'typedRefusal'] as const) {
    const receipt = makeLanguageCoverageReceipt({
      obligationId: obligation.id,
      observedFact:
        outcome === 'executed'
          ? { storedValue: true }
          : { diagnostic: 'SYNTHETIC_TYPED_REFUSAL' },
      outcome,
      producer: { suiteId: 'unit', testFile },
      receiptId: `moved-obligation-${outcome}`,
      ...(outcome === 'typedRefusal'
        ? { refusalDiagnostic: 'SYNTHETIC_TYPED_REFUSAL' }
        : {}),
      runId,
      version: LANGUAGE_COVERAGE_RECEIPT_VERSION,
      witnessId: `moved-obligation-${outcome}-control`,
    });
    const result = evaluateLanguageCoverage({
      creditedTestFiles: new Set([testFile]),
      decisionObservedObligationIds: new Set(),
      decisions: fixtureDecisions(ledger),
      ledger,
      observedObligationIds: new Set([obligation.id]),
      receiptClaims: [
        {
          expectedOutcome: outcome,
          obligationId: obligation.id,
          receiptId: receipt.receiptId,
        },
      ],
      receipts: [receipt],
      runId,
    });
    assert.equal(result.receiptCount, 1);
    assert.equal(result.decisionCount, 0);
  }
});

test('first use of an unobserved first-party shape requires evidence or a new decision', () => {
  const ledger = deriveLanguageCoverageLedger();
  const baselinePackages = firstPartyPackages();
  const baselineObserved = observeLanguageCoverage(ledger, {
    applicationPackages: baselinePackages,
    storageTargets: storageTargetsFor(baselinePackages),
  });
  const publicClassification = ledger.obligations.find(
    (obligation) =>
      obligation.id === 'authoredLanguage:$.fields[].classification="public"',
  );
  assert.ok(publicClassification);
  assert.equal(baselineObserved.has(publicClassification.id), false);
  const baselineDecisions = decisionsFor(
    ledger,
    baselineObserved,
    'first-party-baseline',
  );

  assert.doesNotThrow(() =>
    evaluateLanguageCoverage({
      creditedTestFiles: new Set(),
      decisionObservedObligationIds: baselineObserved,
      decisions: baselineDecisions,
      ledger,
      observedObligationIds: baselineObserved,
      receiptClaims: [],
      receipts: [],
      runId,
    }),
  );

  const changedPackage = structuredClone(baselinePackages[0]!);
  const fields = recordArray(changedPackage, 'fields');
  assert.ok(fields[0]);
  fields[0].classification = 'public';
  const changedPackages = [changedPackage, baselinePackages[1]!];
  const changedObserved = observeLanguageCoverage(ledger, {
    applicationPackages: changedPackages,
    storageTargets: storageTargetsFor(changedPackages),
  });
  assert.equal(changedObserved.has(publicClassification.id), true);

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        creditedTestFiles: new Set(),
        decisionObservedObligationIds: baselineObserved,
        decisions: baselineDecisions,
        ledger,
        observedObligationIds: changedObserved,
        receiptClaims: [],
        receipts: [],
        runId,
      }),
    new RegExp(
      `LANGUAGE_COVERAGE_OBSERVATION_CHANGED: ${escapeRegExp(publicClassification.id)}`,
      'u',
    ),
  );

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        creditedTestFiles: new Set(),
        decisionObservedObligationIds: changedObserved,
        decisions: baselineDecisions,
        ledger,
        observedObligationIds: changedObserved,
        receiptClaims: [],
        receipts: [],
        runId,
      }),
    /LANGUAGE_COVERAGE_STALE_DECISION_SET: first-party-baseline-/u,
  );

  const newDecisionResult = evaluateLanguageCoverage({
    creditedTestFiles: new Set(),
    decisionObservedObligationIds: changedObserved,
    decisions: decisionsFor(ledger, changedObserved, 'new-explicit-decision'),
    ledger,
    observedObligationIds: changedObserved,
    receiptClaims: [],
    receipts: [],
    runId,
  });
  assert.equal(newDecisionResult.decisionCount, ledger.obligations.length);
});

test('a written decision is tied to the exact derived ledger digest', () => {
  const ledger = fixtureLedger();
  const [decision] = fixtureDecisions(ledger);
  assert.ok(decision);

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        creditedTestFiles: new Set(),
        decisionObservedObligationIds: new Set(),
        decisions: [{ ...decision, ledgerDigest: '0'.repeat(64) }],
        ledger,
        observedObligationIds: new Set(),
        receiptClaims: [],
        receipts: [],
        runId,
      }),
    /LANGUAGE_COVERAGE_STALE_DECISION/u,
  );
});

function axis(
  ledger: LanguageCoverageLedger,
  specification: string,
  path: string,
) {
  return ledger.axes.find(
    (candidate) =>
      candidate.specification === specification && candidate.axis === path,
  );
}

function fixtureLedger(): LanguageCoverageLedger {
  const obligation: LanguageCoverageObligation = {
    axis: '$.stateMachines[].states[].terminal',
    id: 'authoredLanguage:$.stateMachines[].states[].terminal=true',
    specification: 'authoredLanguage',
    value: true,
  };
  return {
    axes: [
      {
        axis: obligation.axis,
        specification: obligation.specification,
        values: [obligation.value],
      },
    ],
    digest: 'fixture-ledger-digest',
    obligations: [obligation],
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
    version: LANGUAGE_COVERAGE_LEDGER_VERSION,
  };
}

function fixtureDecisions(
  ledger: LanguageCoverageLedger,
): LanguageCoverageDecision[] {
  return decisionsFor(ledger, new Set(), 'fixture');
}

function decisionsFor(
  ledger: LanguageCoverageLedger,
  observed: ReadonlySet<string>,
  prefix: string,
): LanguageCoverageDecision[] {
  return (
    [
      'observedRelationScope',
      'observedOutsideRelationScope',
      'unobserved',
    ] as const
  ).map((category) => ({
    category,
    decisionId: `${prefix}-${category}`,
    ledgerDigest: ledger.digest,
    obligationSetDigest: deriveDecisionSetDigest(ledger, observed, category),
    rationale: `The ${category} fixture partition is explicit.`,
    revisitCondition:
      'A changed partition requires evidence or a new decision.',
  }));
}

function firstPartyPackages(): Record<string, unknown>[] {
  return [composedApplicationDefinition(), platformModuleDefinition()];
}

function storageTargetsFor(packages: readonly Record<string, unknown>[]) {
  return packages.map((definition) =>
    lowerStorageTargetV1(
      normalizeApplicationPackage(definition) as Parameters<
        typeof lowerStorageTargetV1
      >[0],
    ),
  );
}

function recordArray(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const candidate = value[key];
  assert.ok(Array.isArray(candidate));
  assert.ok(
    candidate.every(
      (entry) =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    ),
  );
  return candidate as Record<string, unknown>[];
}

function executionReceipt(
  obligation: LanguageCoverageObligation,
): LanguageCoverageReceipt {
  return makeLanguageCoverageReceipt({
    obligationId: obligation.id,
    observedFact: { storedValue: true },
    outcome: 'executed',
    producer: { suiteId: 'unit', testFile },
    receiptId: 'valid-execution-receipt',
    runId,
    version: LANGUAGE_COVERAGE_RECEIPT_VERSION,
    witnessId: 'evidence-tamper-control',
  });
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
