import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  getReachabilityProducer,
  observabilityTestFiles,
} from './reachability-producers.js';

const producer = getReachabilityProducer('observability');
const evidencePath = resolve(producer.evidencePath);
mkdirSync(dirname(evidencePath), { recursive: true });
rmSync(evidencePath, { force: true });

const result = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    '--test-reporter=./test/helpers/node-test-evidence-reporter.mjs',
    `--test-reporter-destination=${producer.evidencePath}`,
    '--test-reporter=tap',
    '--test-reporter-destination=stdout',
    ...observabilityTestFiles,
  ],
  {
    env: {
      ...process.env,
      REACHABILITY_COMMAND: producer.command,
      REACHABILITY_SUITE_ID: producer.id,
    },
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
