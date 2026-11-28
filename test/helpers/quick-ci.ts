import {
  getReachabilityProducer,
  type ReachabilityProducer,
} from './reachability-producers.js';

import { quickFiles, contractFile, docsOnlyRun } from './quick-files.js';

export function quickSelection() {
  const { files, browserFiles } = quickFiles();
  const producers: ReachabilityProducer[] = (
    docsOnlyRun() ? ['architecture'] : ['unit', 'compiler', 'architecture']
  ).map(getReachabilityProducer);
  // Architecture discovers new tests by glob. Unit and compiler have
  // reviewed explicit argv, so a new file also needs the selected-file runner.
  const covered = new Set(producers.flatMap((producer) => producer.argv));
  const nodeFiles = files.filter(
    (file) =>
      file.endsWith('.test.ts') &&
      file !== contractFile &&
      !file.startsWith('test/architecture/') &&
      !covered.has(file),
  );
  if (files.includes(contractFile))
    producers.push(getReachabilityProducer('contracts'));
  if (nodeFiles.length)
    producers.push({
      runner: 'node:test',
      ciJob: 'quality',
      ciInvocation: 'node --import tsx .github/scripts/run-quick-node.mjs',
      command: 'node --import tsx .github/scripts/run-quick-node.mjs',
      implementation: {
        kind: 'helper',
        sourcePath: '.github/scripts/run-quick-node.mjs',
      },
      id: 'quick-node',
      argv: nodeFiles,
      evidencePath: 'test-results/reachability/quick-node.json',
    });
  if (browserFiles.length)
    producers.push(getReachabilityProducer('quick-browser'));
  return { files, nodeFiles, browserFiles, producers };
}
