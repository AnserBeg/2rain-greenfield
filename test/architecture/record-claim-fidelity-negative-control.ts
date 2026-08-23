// The `ux-picker` round-3 failure, reproduced on demand.
//
// Run it and watch the gate red:
//
//   node --import tsx test/architecture/record-claim-fidelity-negative-control.ts
//
// It builds two dangling commits in which the claimed implementation file is
// byte-identical, exactly as `56762ce` was after a drift probe's
// `git checkout -- <path>` reverted the round's work along with the mutation,
// and asks the real checker whether the record's claim holds. The file it
// claims is one the WORKING TREE really does contain and really has changed,
// so a checker reading the working tree — or reading the commit message, or
// the packet's prose — reports success here. This one does not.
import {
  formatReport,
  repositoryRoot,
  verifyRecordClaims,
} from './record-claim-fidelity.js';
import {
  RECORD_CLAIM_CONTROLS,
  buildSyntheticWorld,
} from './record-claim-fidelity-controls.js';

function main(): void {
  const root = repositoryRoot();
  const control = RECORD_CLAIM_CONTROLS.find(
    ({ code }) => code === 'RECORD_CLAIM_PATH_UNCHANGED',
  );
  if (!control) {
    throw new Error('the unchanged-path control is missing');
  }
  const input = control.run(buildSyntheticWorld(root))[0];
  if (!input) {
    throw new Error('the unchanged-path control produced no world');
  }
  const report = verifyRecordClaims(input);
  process.stderr.write(`${formatReport(report)}\n`);
  if (report.findings.length === 0) {
    process.stderr.write(
      'record-claim-fidelity: the unchanged-path claim was NOT caught — the gate is vacuous\n',
    );
    process.exitCode = 2;
    return;
  }
  // Exit 1 IS the demonstration: this file exists to be watched failing.
  process.exitCode = 1;
}

main();
