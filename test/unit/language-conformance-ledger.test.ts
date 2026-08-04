import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { lowerStorageTargetV1 } from '../../packages/compiler/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { platformModuleDefinition } from '../../packages/domain/src/platform/definition.js';
import {
  LANGUAGE_COVERAGE_LEDGER_VERSION,
  LANGUAGE_COVERAGE_RECEIPT_VERSION,
  compareCodePoints,
  deriveLanguageCoverageDecisionId,
  deriveLanguageCoverageLedger,
  deriveDecisionSetDigest,
  deriveObligationSetDigest,
  decodeLanguageCoverageObservationSnapshot,
  evaluateLanguageCoverage,
  languageCoverageProducerFileKey,
  makeLanguageCoverageReceipt,
  observeLanguageCoverage,
  type LanguageCoverageDecision,
  type LanguageCoverageDecisionBody,
  type LanguageCoverageLedger,
  type LanguageCoverageObligation,
  type LanguageCoverageReceipt,
} from '../helpers/language-conformance-ledger.js';
import { parseReachabilityEvidence } from '../helpers/reachability-evidence.js';
import { getReachabilityProducer } from '../helpers/reachability-producers.js';

const testFile = 'test/unit/language-conformance-ledger.test.ts';
const runId = 'language-conformance-control';
const producerCredit = languageCoverageProducerFileKey({
  suiteId: 'unit',
  testFile,
});

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

test('missing-axis control retains finite members beside open union members', () => {
  const ledger = deriveLanguageCoverageLedger();

  assert.deepEqual(
    axis(ledger, 'authoredLanguage', '$.assertions[].expectedDiagnosticCode')
      ?.values,
    [null],
  );
  for (const path of [
    '$.entities[].columns[].fieldContract.bounds.maximumLength',
    '$.entities[].columns[].fieldContract.bounds.precision',
    '$.entities[].columns[].fieldContract.bounds.scale',
    '$.entities[].indexes[].predicate',
  ]) {
    assert.deepEqual(
      axis(ledger, 'loweredStorage', path)?.values,
      [null],
      path,
    );
  }
});

test('derived-subject controls refuse an empty authored or lowered type surface', () => {
  for (const { authoredSource, expected, loweredSource } of [
    {
      authoredSource: 'export type VersionedAuthoredApplicationPackage = {};\n',
      expected: /LANGUAGE_COVERAGE_AUTHORED_LEDGER_SUBJECT_EMPTY/u,
      loweredSource: "export type StorageTargetPayloadV1 = { kind: 'one' };\n",
    },
    {
      authoredSource:
        "export type VersionedAuthoredApplicationPackage = { kind: 'one' | 'two' };\n",
      expected: /LANGUAGE_COVERAGE_LOWERED_LEDGER_SUBJECT_EMPTY/u,
      loweredSource: 'export type StorageTargetPayloadV1 = {};\n',
    },
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'language-ledger-subject-'));
    try {
      mkdirSync(resolve(root, 'packages/canonical-model/src'), {
        recursive: true,
      });
      mkdirSync(resolve(root, 'packages/compiler/src'), { recursive: true });
      writeFileSync(
        resolve(root, 'tsconfig.json'),
        `${JSON.stringify({
          compilerOptions: { strict: true },
          files: [
            'packages/canonical-model/src/schemas.ts',
            'packages/compiler/src/storage.ts',
          ],
        })}\n`,
      );
      writeFileSync(
        resolve(root, 'packages/canonical-model/src/schemas.ts'),
        authoredSource,
      );
      writeFileSync(
        resolve(root, 'packages/compiler/src/storage.ts'),
        loweredSource,
      );
      assert.throws(() => deriveLanguageCoverageLedger(root), expected);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test('singleton-narrowing control keeps the obligation of an axis narrowed to one unhonored value', () => {
  // The replay of what 5g3-langnarrow found. `joinEligibility` admitted two
  // values; refusing `none` left `query` — a value still accepted with zero
  // consumers — as the sole survivor. A shape's obligation must not depend on
  // how many siblings it happens to have.
  const admitsBoth = derivedLedgerFor("  joinEligibility: 'none' | 'query';\n");
  const narrowedToSingleton = derivedLedgerFor("  joinEligibility: 'query';\n");

  assert.deepEqual(
    axis(admitsBoth, 'authoredLanguage', '$.joinEligibility')?.values,
    ['none', 'query'],
  );
  assert.deepEqual(
    axis(narrowedToSingleton, 'authoredLanguage', '$.joinEligibility')?.values,
    ['query'],
    'an axis narrowed to a single value must stay represented at size 1',
  );
  assert.ok(
    narrowedToSingleton.obligations.some(
      (obligation) =>
        obligation.id === 'authoredLanguage:$.joinEligibility="query"',
    ),
    'the surviving unhonored value must keep its obligation',
  );
  assert.notEqual(
    narrowedToSingleton.digest,
    admitsBoth.digest,
    'narrowing an axis from two values to one must move the ledger digest',
  );

  // The same rule read off the real language rather than a synthetic one:
  // ADR-0041 narrowed relation cardinality to the single value the storage
  // lowerer implements, and that value still owes an obligation.
  const language = deriveLanguageCoverageLedger();
  assert.deepEqual(
    axis(language, 'authoredLanguage', '$.relations[].cardinality')?.values,
    ['manyToOne'],
  );
});

test('removal control distinguishes an axis retired from the language from one narrowed to a singleton', () => {
  // The fix must not pin every axis forever. A member genuinely removed from
  // the language leaves the ledger, and the two facts must not share a digest:
  // langnarrow measured them as byte-identical.
  const narrowedToSingleton = derivedLedgerFor("  joinEligibility: 'query';\n");
  const removed = derivedLedgerFor('');

  assert.equal(
    axis(removed, 'authoredLanguage', '$.joinEligibility'),
    undefined,
    'an axis removed from the language must leave the ledger',
  );
  assert.ok(
    !removed.obligations.some((obligation) =>
      obligation.axis.startsWith('$.joinEligibility'),
    ),
  );
  assert.notEqual(
    removed.digest,
    narrowedToSingleton.digest,
    'removed-from-the-language and narrowed-to-an-unhonored-singleton are different facts and must not share a digest',
  );
  // The companion axis proves the removal was scoped: nothing else moved.
  assert.deepEqual(axis(removed, 'authoredLanguage', '$.ownership')?.values, [
    'parentScopedChild',
    'reference',
  ]);
});

test('ledger bytes and code-point ordering do not depend on the ambient locale', () => {
  assert.deepEqual(['ä', 'z', '😀', 'A'].sort(compareCodePoints), [
    'A',
    'z',
    'ä',
    '😀',
  ]);

  const helperPath = resolve('test/helpers/language-conformance-ledger.ts');
  const script = `const ledger = require(${JSON.stringify(helperPath)}); process.stdout.write(ledger.stableStringify(ledger.deriveLanguageCoverageLedger()));`;
  const outputs = ['C', 'sv_SE.UTF-8'].map((locale) => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', script],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: locale },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  });
  assert.equal(outputs[0], outputs[1]);
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
    /green proves the derived specification choices, observed partition, and exact decision identities match their reviewed records, not that decision-covered shapes execute; changing a decision record requires a new identity/u,
  );
});

test('observation controls refuse absent subjects and zero observations', () => {
  const ledger = fixtureLedger();

  assert.throws(
    () => decodeLanguageCoverageObservationSnapshot(ledger, undefined),
    /LANGUAGE_COVERAGE_OBSERVATION_SNAPSHOT_MISSING/u,
  );
  assert.throws(
    () => decodeLanguageCoverageObservationSnapshot(ledger, {}),
    /LANGUAGE_COVERAGE_OBSERVATION_SNAPSHOT_EMPTY/u,
  );
  const snapshot = {
    bitmapEncoding: 'sorted-obligation-bitset-msb0-hex/v1',
    ledgerDigest: ledger.digest,
    obligationCount: ledger.obligations.length,
    observedBitmap: '80',
    observedCount: 1,
  };
  assert.throws(
    () =>
      decodeLanguageCoverageObservationSnapshot(ledger, {
        ...snapshot,
        bitmapEncoding: 'sorted-obligation-bitset-lsb0-hex/v1',
      }),
    /LANGUAGE_COVERAGE_OBSERVATION_BITMAP_ENCODING_INVALID/u,
  );
  assert.throws(
    () =>
      decodeLanguageCoverageObservationSnapshot(ledger, {
        ...snapshot,
        ledgerDigest: 'stale-fixture-ledger-digest',
      }),
    /LANGUAGE_COVERAGE_STALE_OBSERVATION_SNAPSHOT: snapshot names stale-fixture-ledger-digest, current ledger is fixture-ledger-digest/u,
  );
  assert.throws(
    () =>
      decodeLanguageCoverageObservationSnapshot(ledger, {
        ...snapshot,
        obligationCount: 2,
      }),
    /LANGUAGE_COVERAGE_OBSERVATION_COUNT_MISMATCH: snapshot names 2, ledger has 1/u,
  );
  assert.throws(
    () =>
      decodeLanguageCoverageObservationSnapshot(ledger, {
        ...snapshot,
        observedBitmap: 'not-hex',
      }),
    /LANGUAGE_COVERAGE_OBSERVATION_BITMAP_INVALID/u,
  );
  assert.throws(
    () =>
      decodeLanguageCoverageObservationSnapshot(ledger, {
        ...snapshot,
        observedBitmap: '',
      }),
    /LANGUAGE_COVERAGE_OBSERVATION_BITMAP_LENGTH_MISMATCH/u,
  );
  assert.throws(
    () =>
      decodeLanguageCoverageObservationSnapshot(ledger, {
        ...snapshot,
        observedCount: 0,
      }),
    /LANGUAGE_COVERAGE_OBSERVATION_BITMAP_COUNT_MISMATCH: snapshot names 0, bitmap contains 1/u,
  );
  assert.throws(
    () =>
      decodeLanguageCoverageObservationSnapshot(ledger, {
        ...snapshot,
        observedBitmap: 'c0',
      }),
    /LANGUAGE_COVERAGE_OBSERVATION_BITMAP_PADDING_SET/u,
  );
  assert.throws(
    () =>
      decodeLanguageCoverageObservationSnapshot(ledger, {
        bitmapEncoding: 'sorted-obligation-bitset-msb0-hex/v1',
        ledgerDigest: ledger.digest,
        obligationCount: ledger.obligations.length,
        observedBitmap: '00',
        observedCount: 0,
      }),
    /LANGUAGE_COVERAGE_OBSERVATION_SNAPSHOT_ZERO_OBSERVATIONS/u,
  );
  assert.throws(
    () =>
      observeLanguageCoverage(ledger, {
        applicationPackages: [],
        storageTargets: [{}],
      }),
    /LANGUAGE_COVERAGE_AUTHORED_OBSERVATION_SUBJECT_EMPTY/u,
  );
  assert.throws(
    () =>
      observeLanguageCoverage(ledger, {
        applicationPackages: [{}],
        storageTargets: [],
      }),
    /LANGUAGE_COVERAGE_LOWERED_OBSERVATION_SUBJECT_EMPTY/u,
  );
  assert.throws(
    () =>
      observeLanguageCoverage(ledger, {
        applicationPackages: [{}],
        storageTargets: [{}],
      }),
    /LANGUAGE_COVERAGE_CURRENT_OBSERVATION_EMPTY/u,
  );
});

test('phantom-axis control refuses a claim for an obligation absent from the derived ledger', () => {
  const ledger = fixtureLedger();

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set([producerCredit]),
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
    observedFact: {
      expectedValue: false,
      kind: 'persistedEffect',
      observedValue: false,
      subject: 'fixture stored value',
    },
  } satisfies LanguageCoverageReceipt;

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set([producerCredit]),
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

test('receipt-shape control refuses an unrecognized outcome', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;

  assert.throws(
    () =>
      makeLanguageCoverageReceipt({
        obligationId: obligation.id,
        observedFact: persistedFact(),
        outcome: 'unexpected-output-shape',
        producer: { suiteId: 'unit', testFile },
        receiptId: 'unknown-outcome',
        runId,
        version: LANGUAGE_COVERAGE_RECEIPT_VERSION,
        witnessId: 'receipt-shape-control',
      } as never),
    /LANGUAGE_COVERAGE_RECEIPT_OUTCOME_INVALID: unexpected-output-shape/u,
  );
});

test('receipt evidence must be versioned, nonempty, outcome-specific, and suite-bound', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;
  const base = {
    obligationId: obligation.id,
    outcome: 'executed' as const,
    producer: { suiteId: 'unit', testFile },
    receiptId: 'receipt-body-control',
    runId,
    version: LANGUAGE_COVERAGE_RECEIPT_VERSION,
    witnessId: 'receipt-body-control',
  };

  assert.throws(
    () => makeLanguageCoverageReceipt({ ...base, observedFact: {} }),
    /LANGUAGE_COVERAGE_RECEIPT_OBSERVED_FACT_EMPTY: receipt-body-control/u,
  );
  assert.throws(
    () =>
      makeLanguageCoverageReceipt({
        ...base,
        observedFact: { declarationSeen: true },
      }),
    /LANGUAGE_COVERAGE_EXECUTION_FACT_INVALID: receipt-body-control/u,
  );
  assert.throws(
    () =>
      makeLanguageCoverageReceipt({
        ...base,
        observedFact: persistedFact(),
        version: 'northstar.language-coverage-receipt/v0',
      } as never),
    /LANGUAGE_COVERAGE_RECEIPT_VERSION_INVALID: northstar.language-coverage-receipt\/v0/u,
  );
  assert.throws(
    () =>
      makeLanguageCoverageReceipt({
        ...base,
        observedFact: { diagnostic: 'OTHER', kind: 'typedRefusal' },
        outcome: 'typedRefusal',
        refusalDiagnostic: 'EXPECTED',
      }),
    /LANGUAGE_COVERAGE_REFUSAL_FACT_MISMATCH: receipt-body-control/u,
  );
  for (const invalidDiagnostic of ['   ', 7] as const) {
    assert.throws(
      () =>
        makeLanguageCoverageReceipt({
          ...base,
          observedFact: {
            diagnostic: invalidDiagnostic,
            kind: 'typedRefusal',
          },
          outcome: 'typedRefusal',
          refusalDiagnostic: invalidDiagnostic,
        } as never),
      /LANGUAGE_COVERAGE_REFUSAL_WITHOUT_DIAGNOSTIC: receipt-body-control/u,
    );
  }
  assert.throws(
    () =>
      makeLanguageCoverageReceipt({
        ...base,
        observedFact: {
          accepted: true,
          honored: true,
          kind: 'unhonored',
        },
        outcome: 'unhonored',
      }),
    /LANGUAGE_COVERAGE_UNHONORED_FACT_INVALID: receipt-body-control/u,
  );

  const receipt = makeLanguageCoverageReceipt({
    ...base,
    observedFact: persistedFact(),
  });
  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set([
          languageCoverageProducerFileKey({
            suiteId: 'architecture',
            testFile,
          }),
        ]),
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
        receipts: [receipt],
        runId,
      }),
    new RegExp(
      `LANGUAGE_COVERAGE_RECEIPT_UNCREDITED_PRODUCER: unit:${escapeRegExp(testFile)}`,
      'u',
    ),
  );
});

test('receipt uniqueness controls refuse duplicate claims and produced receipts', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;
  const receipt = executionReceipt(obligation);
  const claim = {
    expectedOutcome: 'executed' as const,
    obligationId: obligation.id,
    receiptId: receipt.receiptId,
  };
  const base = {
    acceptedButUnhonoredObligationIds: new Set<string>(),
    creditedProducerFiles: new Set([producerCredit]),
    decisionObservedObligationIds: new Set<string>(),
    decisions: fixtureDecisions(ledger),
    ledger,
    observedObligationIds: new Set<string>(),
    runId,
  };

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        ...base,
        receiptClaims: [claim, { ...claim, receiptId: 'duplicate-claim' }],
        receipts: [receipt],
      }),
    new RegExp(
      `LANGUAGE_COVERAGE_DUPLICATE_RECEIPT_CLAIM: ${escapeRegExp(obligation.id)}`,
      'u',
    ),
  );
  assert.throws(
    () =>
      evaluateLanguageCoverage({
        ...base,
        receiptClaims: [claim],
        receipts: [receipt, receipt],
      }),
    /LANGUAGE_COVERAGE_DUPLICATE_RECEIPT: valid-execution-receipt/u,
  );
});

test('receipt credit refuses reachability evidence from another run or suite', () => {
  const producer = getReachabilityProducer('unit');
  const evidence = JSON.stringify({
    argv: producer.argv,
    files: [{ path: resolve(testFile), realResultCount: 1 }],
    runId: 'previous-run',
    runner: producer.runner,
    suiteId: producer.id,
    suiteSucceeded: true,
    version: 2,
  });
  assert.throws(
    () => parseReachabilityEvidence(evidence, producer, runId),
    new RegExp(
      `Stale reachability evidence for unit: expected run ${runId}, received previous-run`,
      'u',
    ),
  );
  assert.throws(
    () =>
      parseReachabilityEvidence(
        JSON.stringify({ ...JSON.parse(evidence), runId, suiteId: 'compiler' }),
        producer,
        runId,
      ),
    /Reachability evidence metadata mismatch for unit/u,
  );
});

test('entry-skip control names an obligation with neither evidence nor a written decision', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set([producerCredit]),
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

test('receipt-claim control refuses a claim that no current run produced', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set([producerCredit]),
        decisionObservedObligationIds: new Set(),
        decisions: fixtureDecisions(ledger),
        ledger,
        observedObligationIds: new Set(),
        receiptClaims: [
          {
            expectedOutcome: 'executed',
            obligationId: obligation.id,
            receiptId: 'never-produced',
          },
        ],
        receipts: [],
        runId,
      }),
    new RegExp(
      `LANGUAGE_COVERAGE_UNCLAIMED_ENTRY: ${escapeRegExp(obligation.id)}`,
      'u',
    ),
  );
});

test('refusal-distinguisher control cannot use a typed refusal as an execution receipt', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;
  const refusal = makeLanguageCoverageReceipt({
    obligationId: obligation.id,
    observedFact: {
      diagnostic: 'SYNTHETIC_TYPED_REFUSAL',
      kind: 'typedRefusal',
    },
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
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set([producerCredit]),
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

test('disposition controls reject honoured behavior classified as a defect and unhonored behavior classified as supported', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;
  const executed = executionReceipt(obligation);
  const defectSet = new Set([obligation.id]);

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: defectSet,
        creditedProducerFiles: new Set([producerCredit]),
        decisionObservedObligationIds: new Set(),
        decisions: decisionsFor(
          ledger,
          new Set(),
          'classified-defect',
          defectSet,
        ),
        ledger,
        observedObligationIds: new Set(),
        receiptClaims: [
          {
            expectedOutcome: 'executed',
            obligationId: obligation.id,
            receiptId: executed.receiptId,
          },
        ],
        receipts: [executed],
        runId,
      }),
    new RegExp(
      `LANGUAGE_COVERAGE_DISPOSITION_MISMATCH: ${escapeRegExp(obligation.id)} is classified accepted-but-unhonored but receipt observed executed`,
      'u',
    ),
  );

  const unhonored = makeLanguageCoverageReceipt({
    obligationId: obligation.id,
    observedFact: { accepted: true, honored: false, kind: 'unhonored' },
    outcome: 'unhonored',
    producer: { suiteId: 'unit', testFile },
    receiptId: 'unhonored-receipt',
    runId,
    version: LANGUAGE_COVERAGE_RECEIPT_VERSION,
    witnessId: 'reverse-disposition-control',
  });
  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set([producerCredit]),
        decisionObservedObligationIds: new Set(),
        decisions: fixtureDecisions(ledger),
        ledger,
        observedObligationIds: new Set(),
        receiptClaims: [
          {
            expectedOutcome: 'unhonored',
            obligationId: obligation.id,
            receiptId: unhonored.receiptId,
          },
        ],
        receipts: [unhonored],
        runId,
      }),
    new RegExp(
      `LANGUAGE_COVERAGE_DISPOSITION_MISMATCH: ${escapeRegExp(obligation.id)} is classified supported but receipt observed unhonored`,
      'u',
    ),
  );
});

test('a bare defect-inventory addition cannot retain the prior decision identities', () => {
  const ledger = fixtureLedger();
  const obligation = ledger.obligations[0]!;
  const defectSet = new Set([obligation.id]);

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: defectSet,
        creditedProducerFiles: new Set(),
        decisionObservedObligationIds: new Set(),
        decisions: fixtureDecisions(ledger),
        ledger,
        observedObligationIds: new Set(),
        receiptClaims: [],
        receipts: [],
        runId,
      }),
    /LANGUAGE_COVERAGE_STALE_DEFECT_INVENTORY_SET/u,
  );

  assert.doesNotThrow(() =>
    evaluateLanguageCoverage({
      acceptedButUnhonoredObligationIds: defectSet,
      creditedProducerFiles: new Set(),
      decisionObservedObligationIds: new Set(),
      decisions: decisionsFor(
        ledger,
        new Set(),
        'new-defect-inventory-decision',
        defectSet,
      ),
      ledger,
      observedObligationIds: new Set(),
      receiptClaims: [],
      receipts: [],
      runId,
    }),
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
          ? persistedFact()
          : {
              diagnostic: 'SYNTHETIC_TYPED_REFUSAL',
              kind: 'typedRefusal',
            },
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
      acceptedButUnhonoredObligationIds: new Set(),
      creditedProducerFiles: new Set([producerCredit]),
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
      acceptedButUnhonoredObligationIds: new Set(),
      creditedProducerFiles: new Set(),
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
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set(),
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
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set(),
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

  const mechanicallyRetargetedDecisions = baselineDecisions.map((decision) => ({
    ...decision,
    obligationSetDigest: deriveDecisionSetDigest(
      ledger,
      changedObserved,
      decision.category,
    ),
  }));
  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set(),
        decisionObservedObligationIds: changedObserved,
        decisions: mechanicallyRetargetedDecisions,
        ledger,
        observedObligationIds: changedObserved,
        receiptClaims: [],
        receipts: [],
        runId,
      }),
    /LANGUAGE_COVERAGE_STALE_DECISION_IDENTITY: first-party-baseline-/u,
  );

  const newDecisions = decisionsFor(
    ledger,
    changedObserved,
    'new-explicit-decision',
  );
  for (const [index, decision] of newDecisions.entries()) {
    assert.notEqual(decision.decisionId, baselineDecisions[index]?.decisionId);
  }
  const newDecisionResult = evaluateLanguageCoverage({
    acceptedButUnhonoredObligationIds: new Set(),
    creditedProducerFiles: new Set(),
    decisionObservedObligationIds: changedObserved,
    decisions: newDecisions,
    ledger,
    observedObligationIds: changedObserved,
    receiptClaims: [],
    receipts: [],
    runId,
  });
  assert.equal(newDecisionResult.decisionCount, ledger.obligations.length);
});

test('product-deletion control detects removal of an observed lowered relation fact', () => {
  const ledger = deriveLanguageCoverageLedger();
  const packages = firstPartyPackages();
  const storageTargets = storageTargetsFor(packages);
  const baselineObserved = observeLanguageCoverage(ledger, {
    applicationPackages: packages,
    storageTargets,
  });
  const originPresence = ledger.obligations.find(
    (obligation) =>
      obligation.id ===
      'loweredStorage:$.relations[].relationColumn.origin.$presence="present"',
  );
  assert.ok(originPresence);
  assert.equal(baselineObserved.has(originPresence.id), true);

  const implementationRemoved = structuredClone(storageTargets);
  for (const target of implementationRemoved) {
    for (const relation of recordArray(
      target as unknown as Record<string, unknown>,
      'relations',
    )) {
      const relationColumn = relation.relationColumn;
      if (
        typeof relationColumn === 'object' &&
        relationColumn !== null &&
        !Array.isArray(relationColumn)
      ) {
        delete (relationColumn as Record<string, unknown>).origin;
      }
    }
  }
  const changedObserved = observeLanguageCoverage(ledger, {
    applicationPackages: packages,
    storageTargets: implementationRemoved,
  });
  assert.equal(changedObserved.has(originPresence.id), false);

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set(),
        decisionObservedObligationIds: baselineObserved,
        decisions: decisionsFor(
          ledger,
          baselineObserved,
          'product-deletion-baseline',
        ),
        ledger,
        observedObligationIds: changedObserved,
        receiptClaims: [],
        receipts: [],
        runId,
      }),
    new RegExp(
      `LANGUAGE_COVERAGE_OBSERVATION_CHANGED: ${escapeRegExp(originPresence.id)} moved from observedRelationScope to unobserved`,
      'u',
    ),
  );
});

test('a written decision is tied to the exact derived ledger digest', () => {
  const ledger = fixtureLedger();
  const [decision] = fixtureDecisions(ledger);
  assert.ok(decision);

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set(),
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

test('language-growth control invalidates decisions when the derived ledger gains an obligation', () => {
  const ledger = fixtureLedger();
  const added: LanguageCoverageObligation = {
    axis: '$.relations[].cardinality',
    id: 'authoredLanguage:$.relations[].cardinality="oneToMany"',
    specification: 'authoredLanguage',
    value: 'oneToMany',
  };
  const grownLedger: LanguageCoverageLedger = {
    ...ledger,
    axes: [
      {
        axis: added.axis,
        specification: added.specification,
        values: ['manyToOne', added.value],
      },
    ],
    digest: 'grown-fixture-ledger-digest',
    obligations: [...ledger.obligations, added],
  };

  assert.throws(
    () =>
      evaluateLanguageCoverage({
        acceptedButUnhonoredObligationIds: new Set(),
        creditedProducerFiles: new Set(),
        decisionObservedObligationIds: new Set(),
        decisions: fixtureDecisions(ledger),
        ledger: grownLedger,
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

function derivedLedgerFor(
  authoredMember: string,
): ReturnType<typeof deriveLanguageCoverageLedger> {
  const root = mkdtempSync(join(tmpdir(), 'language-ledger-narrowing-'));
  try {
    mkdirSync(resolve(root, 'packages/canonical-model/src'), {
      recursive: true,
    });
    mkdirSync(resolve(root, 'packages/compiler/src'), { recursive: true });
    writeFileSync(
      resolve(root, 'tsconfig.json'),
      `${JSON.stringify({
        compilerOptions: { strict: true },
        files: [
          'packages/canonical-model/src/schemas.ts',
          'packages/compiler/src/storage.ts',
        ],
      })}\n`,
    );
    writeFileSync(
      resolve(root, 'packages/canonical-model/src/schemas.ts'),
      `export type VersionedAuthoredApplicationPackage = {\n  ownership: 'reference' | 'parentScopedChild';\n${authoredMember}};\n`,
    );
    writeFileSync(
      resolve(root, 'packages/compiler/src/storage.ts'),
      "export type StorageTargetPayloadV1 = { archiveBehavior: 'restrict' | 'retainReference' };\n",
    );
    return deriveLanguageCoverageLedger(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function fixtureLedger(): LanguageCoverageLedger {
  const obligation: LanguageCoverageObligation = {
    axis: '$.relations[].cardinality',
    id: 'authoredLanguage:$.relations[].cardinality="manyToOne"',
    specification: 'authoredLanguage',
    value: 'manyToOne',
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
  acceptedButUnhonored: ReadonlySet<string> = new Set(),
): LanguageCoverageDecision[] {
  return (
    [
      'observedRelationScope',
      'observedOutsideRelationScope',
      'unobserved',
    ] as const
  ).map((category) => {
    const body = {
      acceptedButUnhonoredSetDigest:
        deriveObligationSetDigest(acceptedButUnhonored),
      category,
      ledgerDigest: ledger.digest,
      obligationSetDigest: deriveDecisionSetDigest(ledger, observed, category),
      rationale: `The ${category} fixture partition is explicit.`,
      revisitCondition:
        'A changed partition requires evidence or a new decision.',
    } satisfies LanguageCoverageDecisionBody;
    return {
      ...body,
      decisionId: deriveLanguageCoverageDecisionId(
        `${prefix}-${category}`,
        body,
      ),
    };
  });
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
    observedFact: persistedFact(),
    outcome: 'executed',
    producer: { suiteId: 'unit', testFile },
    receiptId: 'valid-execution-receipt',
    runId,
    version: LANGUAGE_COVERAGE_RECEIPT_VERSION,
    witnessId: 'evidence-tamper-control',
  });
}

function persistedFact(): Readonly<Record<string, unknown>> {
  return {
    expectedValue: true,
    kind: 'persistedEffect',
    observedValue: true,
    subject: 'fixture stored value',
  };
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
