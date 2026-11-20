import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { quickSelection } from '../../test/helpers/quick-ci.ts';
const { nodeFiles } = quickSelection();
if (nodeFiles.length) {
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      '--test-reporter=./test/helpers/node-test-evidence-reporter.mjs',
      '--test-reporter-destination=test-results/reachability/quick-node.json',
      '--test-reporter=tap',
      '--test-reporter-destination=stdout',
      ...nodeFiles,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, REACHABILITY_SUITE_ID: 'quick-node' },
    },
  );
}
