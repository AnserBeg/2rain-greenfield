export const contractFile = 'apps/web/test/surface-runtime-contract.test.ts';
// CI-10: a docs-only pull request runs architecture as its only fixed suite.
export const docsOnlyRun = () => process.env.CI_DOCS === 'true';
export function fixedQuickFile(path: string, docs = docsOnlyRun()): boolean {
  return (
    (docs
      ? /^test\/architecture\//u
      : /^test\/(?:architecture|compiler|unit)\//u
    ).test(path) && path !== 'test/compiler/performance-budget.test.ts'
  );
}
export function quickFiles() {
  const selected: unknown = JSON.parse(process.env.CI_FILES ?? '');
  if (
    !Array.isArray(selected) ||
    !selected.every((file): file is string => typeof file === 'string')
  )
    throw new Error('Missing quick CI file selection');
  const files: string[] = selected;
  const browserFiles = files.filter((file) => file.endsWith('.spec.ts'));
  return { files, browserFiles };
}
