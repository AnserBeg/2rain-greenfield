import type { FullConfig, Reporter } from '@playwright/test/reporter';

const expectedArguments = [
  'test',
  '--config',
  'apps/web/playwright.config.ts',
] as const;

export default class PlaywrightUnfilteredReporter implements Reporter {
  private violation: string | undefined;

  onBegin(config: FullConfig): void {
    try {
      assertUnfilteredPlaywrightRun(process.argv.slice(2), config);
    } catch (error) {
      this.violation = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${this.violation}\n`);
    }
  }

  async onEnd(): Promise<{ status: 'failed' } | undefined> {
    return this.violation ? { status: 'failed' } : undefined;
  }

  printsToStdio(): boolean {
    return false;
  }
}

export function assertUnfilteredPlaywrightRun(
  arguments_: readonly string[],
  config: Pick<FullConfig, 'grep' | 'grepInvert' | 'projects' | 'shard'>,
): void {
  if (
    arguments_.length !== expectedArguments.length ||
    arguments_.some((argument, index) => argument !== expectedArguments[index])
  ) {
    throw new Error(
      `Filtered or unrecognized Playwright arguments: ${arguments_.join(' ')}`,
    );
  }
  if (
    !isDefaultGrep(config.grep) ||
    config.grepInvert !== null ||
    config.shard
  ) {
    throw new Error(
      'Filtered Playwright configuration is not evidence-producing',
    );
  }
  for (const project of config.projects) {
    if (!isDefaultGrep(project.grep) || project.grepInvert !== null) {
      throw new Error(
        `Filtered Playwright project is not evidence-producing: ${project.name}`,
      );
    }
  }
}

function isDefaultGrep(value: RegExp | readonly RegExp[]): boolean {
  return (
    !Array.isArray(value) &&
    value instanceof RegExp &&
    value.source === '.*' &&
    value.flags === ''
  );
}
