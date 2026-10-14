import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { FullConfig, Reporter } from '@playwright/test/reporter';

import {
  getPlaywrightReachabilityProducer,
  type PlaywrightReachabilityProducer,
  type ReachabilityProducer,
} from './reachability-producers.js';
import { resolveReachabilityRunId } from './reachability-run.mjs';

/**
 * Each Playwright config names the producer it runs as (`{ producer: id }`),
 * so two browser jobs record their invocations side by side. A config that
 * names none, or names anything but a Playwright producer, fails its run
 * rather than writing another producer's evidence.
 */
export interface PlaywrightUnfilteredReporterOptions {
  readonly producer?: unknown;
}

export default class PlaywrightUnfilteredReporter implements Reporter {
  private readonly producerId: unknown;
  private violation: string | undefined;

  constructor(options: PlaywrightUnfilteredReporterOptions = {}) {
    this.producerId = options.producer;
  }

  onBegin(config: FullConfig): void {
    try {
      const producer = getPlaywrightReachabilityProducer(this.producerId);
      const argv = process.argv.slice(2);
      assertUnfilteredPlaywrightRun(producer, argv, config);
      writeObservedInvocation(producer, argv);
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
  producer: Pick<ReachabilityProducer, 'argv'>,
  arguments_: readonly string[],
  config: Pick<FullConfig, 'grep' | 'grepInvert' | 'projects' | 'shard'>,
): void {
  if (
    arguments_.length !== producer.argv.length ||
    arguments_.some((argument, index) => argument !== producer.argv[index])
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

function writeObservedInvocation(
  producer: PlaywrightReachabilityProducer,
  argv: readonly string[],
): void {
  const repositoryRoot = resolve('.');
  const path = resolve(repositoryRoot, producer.invocationEvidencePath);
  const runId = resolveReachabilityRunId({ repositoryRoot });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, runId, argv }, null, 2)}\n`,
  );
}

function isDefaultGrep(value: RegExp | readonly RegExp[]): boolean {
  return (
    !Array.isArray(value) &&
    value instanceof RegExp &&
    value.source === '.*' &&
    value.flags === ''
  );
}
