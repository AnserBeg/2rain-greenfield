import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  LANGUAGE_COVERAGE_LEDGER_VERSION,
  LANGUAGE_COVERAGE_RECEIPT_VERSION,
  deriveLanguageCoverageLedger,
  deriveDecisionSetDigest,
  evaluateLanguageCoverage,
  makeLanguageCoverageReceipt,
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
});

test('phantom-axis control refuses a claim for an obligation absent from the derived ledger', () => {
  const ledger = fixtureLedger();

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        creditedTestFiles: new Set([testFile]),
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

test('an unused-axis decision turns red when first-party use appears', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;
  const onlyUnusedDecision = fixtureDecisions(ledger).filter(
    (decision) => decision.category === 'unobserved',
  );

  assert.doesNotThrow(() =>
    evaluateLanguageCoverage({
      creditedTestFiles: new Set(),
      decisions: onlyUnusedDecision,
      ledger,
      observedObligationIds: new Set(),
      receiptClaims: [],
      receipts: [],
      runId,
    }),
  );
  assert.throws(
    () =>
      evaluateLanguageCoverage({
        creditedTestFiles: new Set(),
        decisions: onlyUnusedDecision,
        ledger,
        observedObligationIds: new Set([obligation.id]),
        receiptClaims: [],
        receipts: [],
        runId,
      }),
    /LANGUAGE_COVERAGE_STALE_DECISION_SET: fixture-unused/u,
  );
});

test('a written decision is tied to the exact derived ledger digest', () => {
  const ledger = fixtureLedger();
  const [decision] = fixtureDecisions(ledger);
  assert.ok(decision);

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        creditedTestFiles: new Set(),
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
  const observed = new Set<string>();
  return [
    {
      category: 'unobserved',
      decisionId: 'fixture-unused',
      ledgerDigest: ledger.digest,
      obligationSetDigest: deriveDecisionSetDigest(
        ledger,
        observed,
        'unobserved',
      ),
      rationale: 'The fixture axis is intentionally unused.',
      revisitCondition: 'First use requires executable evidence.',
    },
    {
      category: 'observedOutsideRelationScope',
      decisionId: 'fixture-observed',
      ledgerDigest: ledger.digest,
      obligationSetDigest: deriveDecisionSetDigest(
        ledger,
        observed,
        'observedOutsideRelationScope',
      ),
      rationale: 'The fixture may model an acknowledged existing use.',
      revisitCondition: 'The fixture is replaced by an execution receipt.',
    },
  ];
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
