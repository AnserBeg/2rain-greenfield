import { resolve } from 'node:path';

import { beginReachabilityRun } from './reachability-run.mjs';

const runId = beginReachabilityRun({ repositoryRoot: resolve('.') });
process.stdout.write(`reachability run: ${runId}\n`);
