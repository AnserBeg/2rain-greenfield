export const contractFile = 'apps/web/test/surface-runtime-contract.test.ts';
export function fixedQuickFile(path: string): boolean {
  return (
    /^test\/(?:architecture|compiler|unit)\//u.test(path) &&
    path !== 'test/compiler/performance-budget.test.ts'
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
  const nodeFiles = files.filter(
    (file) =>
      !fixedQuickFile(file) &&
      file !== contractFile &&
      file.endsWith('.test.ts'),
  );
  const browserFiles = files.filter((file) => file.endsWith('.spec.ts'));
  return { files, nodeFiles, browserFiles };
}
