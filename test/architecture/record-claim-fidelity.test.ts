import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  RECORD_CLAIM_CODES,
  collectRepositoryInput,
  declaredNames,
  formatReport,
  repositoryRoot,
  verifyRecordClaims,
  type RecordClaimCode,
} from './record-claim-fidelity.js';
import {
  RECORD_CLAIM_CONTROLS,
  buildSyntheticWorld,
  greenInput,
  runRecordClaimControls,
} from './record-claim-fidelity-controls.js';

const root = repositoryRoot();

test('the record layer is clean at this tree', (context) => {
  const report = verifyRecordClaims(collectRepositoryInput(root));
  context.diagnostic(formatReport(report));
  assert.deepEqual(
    report.findings.map(({ code, subject }) => `${code} ${subject}`),
    [],
  );
});

test('at least one packet record declares claims, and they are observed', (context) => {
  const report = verifyRecordClaims(collectRepositoryInput(root));
  assert.ok(
    report.declaredPackets.includes('record-claim-fidelity'),
    'this packet must declare its own claims, or the gate ships unexercised',
  );
  // The positive direction. Without it every Family A control could be
  // satisfied by a checker that finds a fault in everything.
  assert.ok(report.pathsObserved > 0);
  assert.ok(report.symbolsObserved > 0);
  assert.ok(report.ledgerRows > 100);
  assert.ok(report.routingsResolved > 0);
  context.diagnostic(
    `${report.declaredPackets.length} declaring record(s); ${report.pathsObserved} path(s) and ${report.symbolsObserved} symbol(s) observed`,
  );
});

test('the synthetic world this gate is controlled against is itself green', () => {
  const world = buildSyntheticWorld(root);
  assert.deepEqual(verifyRecordClaims(greenInput(world)).findings, []);
});

test('every diagnostic carries exactly one control, and each control dies alone', (context) => {
  const controlled = RECORD_CLAIM_CONTROLS.map(({ code }) => code);
  assert.deepEqual(
    [...controlled].sort(),
    [...RECORD_CLAIM_CODES].sort(),
    'each diagnostic must be controlled exactly once — a code with two controls loses attribution, and a code with none is never observed failing',
  );

  const results = runRecordClaimControls(root);
  for (const result of results) {
    context.diagnostic(
      `${result.code}: observed ${result.observed.join(', ')}`,
    );
    assert.deepEqual(
      result.observed,
      [result.code],
      `${result.title} — the control must red on its own assertion and on nothing else`,
    );
    assert.ok(result.passed, result.title);
  }
  assert.equal(results.length, RECORD_CLAIM_CODES.length);
});

test('the controls leave no trace in the working tree', () => {
  // The subject repaired before it is measured is a vacuity vector, so the
  // verifier must share no code path with anything that writes a tree. The
  // controls build dangling commits in the object database; if one ever
  // checked something out, this reds.
  const status = (): string =>
    execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    });
  const before = status();
  runRecordClaimControls(root);
  assert.equal(status(), before);
});

test('claim fidelity is decided by the frozen tree, never by the working tree', (context) => {
  const world = buildSyntheticWorld(root);
  const control = RECORD_CLAIM_CONTROLS.find(
    ({ code }) => code === 'RECORD_CLAIM_PATH_UNCHANGED',
  );
  assert.ok(control);
  // The claimed path really exists and really differs in the working tree; only
  // the frozen commits say it is unchanged. This is the ux-picker r3 shape.
  const finding = verifyRecordClaims(control.run(world)[0]!).findings[0];
  assert.equal(finding?.code, 'RECORD_CLAIM_PATH_UNCHANGED');
  assert.match(finding?.subject ?? '', /record-claim-fidelity\.ts$/u);
  context.diagnostic(finding?.message ?? '');
});

test('a declared name comes from the AST, so a mention is not a declaration', () => {
  const mentioned = declaredNames(
    'probe.ts',
    [
      '// mentioned is discussed here.',
      "const other = 'mentioned';",
      'export {};',
    ].join('\n'),
  );
  assert.equal(mentioned.has('mentioned'), false);
  assert.equal(mentioned.has('other'), true);

  const declared = declaredNames(
    'probe.ts',
    [
      'export function fn(): void {}',
      'export class Cls {}',
      'export interface Iface { a: string }',
      'export type Alias = string;',
      'export enum Enum { A }',
      'const { destructured } = { destructured: 1 };',
      'const inner = 1;',
      'export { inner as renamed };',
    ].join('\n'),
  );
  for (const name of [
    'fn',
    'Cls',
    'Iface',
    'Alias',
    'Enum',
    'destructured',
    'renamed',
  ]) {
    assert.ok(declared.has(name), `${name} must resolve as a declaration`);
  }
  // A name declared only inside a function body is not a module-level symbol,
  // and the block may not claim one.
  assert.equal(
    declaredNames(
      'probe.ts',
      'function outer() { const hidden = 1; return hidden; }',
    ).has('hidden'),
    false,
  );
});

test('the operator-facing gate and this suite run the same checker', () => {
  // scripts/check-records.sh is what the orchestrator runs at a checkpoint. If
  // it drifted from the suite, one of them would stop being evidence.
  const output = execFileSync(
    'bash',
    ['scripts/check-records.sh', '--self-test'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.match(output, /check-records self-test: OK \(16 controls/u);
  for (const code of RECORD_CLAIM_CODES satisfies readonly RecordClaimCode[]) {
    assert.ok(
      output.includes(code),
      `${code} must appear in the self-test report`,
    );
  }
});
