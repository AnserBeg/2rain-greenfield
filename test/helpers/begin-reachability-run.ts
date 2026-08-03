import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { beginReachabilityRun } from './reachability-run.mjs';

const repositoryRoot = resolve('.');
rmSync(resolve(repositoryRoot, 'test-results/language-coverage'), {
  force: true,
  recursive: true,
});
const runId = beginReachabilityRun({ repositoryRoot });
process.stdout.write(`reachability run: ${runId}\n`);
