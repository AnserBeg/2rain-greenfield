import {
  getReachabilityProducer,
  type ReachabilityProducer,
} from './reachability-producers.js';

import { quickFiles, contractFile } from './quick-files.js';

export function quickSelection() {
  const { files, nodeFiles, browserFiles } = quickFiles();
  const producers: ReachabilityProducer[] = [
    'unit',
    'compiler',
    'architecture',
  ].map(getReachabilityProducer);
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
