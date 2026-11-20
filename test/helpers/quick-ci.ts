import {
  getReachabilityProducer,
  type ReachabilityProducer,
} from './reachability-producers.js';

export const fixedQuickSuites = ['unit', 'compiler', 'architecture'] as const;
const contractFile = 'apps/web/test/surface-runtime-contract.test.ts';
export function fixedQuickFile(path: string): boolean {
  return (
    /^test\/(?:architecture|compiler|unit)\//u.test(path) &&
    path !== 'test/compiler/performance-budget.test.ts'
  );
}
export function quickSelection() {
  const selected: unknown = JSON.parse(process.env.CI_FILES ?? '');
  if (
    !Array.isArray(selected) ||
    !selected.every((file): file is string => typeof file === 'string')
  )
    throw new Error('Missing quick CI file selection');
  const files: string[] = selected;
  const nodeFiles = files.filter(
    (file) =>
      !fixedQuickFile(file) &&
      file !== contractFile &&
      file.endsWith('.test.ts'),
  );
  const browserFiles = files.filter((file) => file.endsWith('.spec.ts'));
  const producers: ReachabilityProducer[] = fixedQuickSuites.map(
    getReachabilityProducer,
  );
  if (files.includes(contractFile))
    producers.push(getReachabilityProducer('contracts'));
  if (nodeFiles.length)
    producers.push({
      ...getReachabilityProducer('integration'),
      id: 'quick-node',
      argv: nodeFiles,
      evidencePath: 'test-results/reachability/quick-node.json',
    });
  if (browserFiles.length)
    producers.push(getReachabilityProducer('quick-browser'));
  return { files, nodeFiles, browserFiles, producers };
}
