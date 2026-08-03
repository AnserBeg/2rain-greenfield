import {
  existsSync,
  globSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import {
  reachabilityProducers,
  type ReachabilityProducer,
  type ReachabilityRunner,
} from './reachability-producers.js';
import { resolveReachabilityRunId } from './reachability-run.mjs';

export interface ExecutedFileEvidence {
  readonly path: string;
  readonly realResultCount: number;
}

export interface SuiteEvidence {
  readonly version: 2;
  readonly suiteId: string;
  readonly runId: string;
  readonly argv: readonly string[];
  readonly runner: ReachabilityRunner;
  readonly suiteSucceeded: boolean;
  readonly files: readonly ExecutedFileEvidence[];
}

export interface AggregateEvidenceOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

const repositoryGlobExcludes = [
  '.git/**',
  'dist/**',
  '**/dist/**',
  'node_modules/**',
  '**/node_modules/**',
] as const;

export function discoverRepositoryTests(
  repositoryRoot = process.cwd(),
): Set<string> {
  return new Set(
    [
      ...globSync('**/*.test.ts', {
        cwd: repositoryRoot,
        exclude: repositoryGlobExcludes,
      }),
      ...globSync('**/*.spec.ts', {
        cwd: repositoryRoot,
        exclude: repositoryGlobExcludes,
      }),
    ]
      .map(normalizeSeparators)
      .sort(),
  );
}

export function findUnreachableTests(
  discoveredTests: ReadonlySet<string>,
  executedTests: ReadonlySet<string>,
): string[] {
  return [...discoveredTests].filter((path) => !executedTests.has(path)).sort();
}

export function aggregateEvidence(
  repositoryRoot = process.cwd(),
  producers: readonly ReachabilityProducer[] = reachabilityProducers,
  options: AggregateEvidenceOptions = {},
): { readonly discoveredCount: number; readonly executedCount: number } {
  const discovered = discoverRepositoryTests(repositoryRoot);
  if (discovered.size === 0) {
    throw new Error('Repository test discovery returned zero files');
  }
  const currentRunId = resolveReachabilityRunId(
    options.environment === undefined
      ? { repositoryRoot }
      : { repositoryRoot, environment: options.environment },
  );

  const executed = new Set<string>();
  for (const producer of producers) {
    const artifactPath = resolve(repositoryRoot, producer.evidencePath);
    if (!existsSync(artifactPath)) {
      throw new Error(
        `Missing reachability evidence for ${producer.id}: ${producer.evidencePath}`,
      );
    }
    const serialized = readFileSync(artifactPath, 'utf8');
    if (serialized.trim().length === 0) {
      throw new Error(
        `Empty reachability evidence for ${producer.id}: ${producer.evidencePath}`,
      );
    }
    const evidence = parseReachabilityEvidence(
      serialized,
      producer,
      currentRunId,
    );
    if (!evidence.suiteSucceeded) {
      throw new Error(`Evidence producer did not succeed: ${producer.id}`);
    }
    if (evidence.files.length === 0) {
      throw new Error(
        `Evidence producer executed zero test files: ${producer.id}`,
      );
    }

    const artifactPaths = new Set<string>();
    for (const file of evidence.files) {
      if (
        !Number.isSafeInteger(file.realResultCount) ||
        file.realResultCount <= 0
      ) {
        throw new Error(
          `Invalid real-result count from ${producer.id}: ${String(file.realResultCount)}`,
        );
      }
      const repositoryPath = normalizeEvidencePath(repositoryRoot, file.path);
      if (artifactPaths.has(repositoryPath)) {
        throw new Error(
          `Duplicate executed-file evidence from ${producer.id}: ${repositoryPath}`,
        );
      }
      artifactPaths.add(repositoryPath);
      if (!discovered.has(repositoryPath)) {
        throw new Error(
          `Executed file is outside repository test discovery: ${repositoryPath}`,
        );
      }
      executed.add(repositoryPath);
    }
  }

  const unreachable = findUnreachableTests(discovered, executed);
  if (unreachable.length > 0) {
    throw new Error(`Unreachable test files: ${unreachable.join(', ')}`);
  }
  return { discoveredCount: discovered.size, executedCount: executed.size };
}

export function normalizeEvidencePath(
  repositoryRoot: string,
  emittedPath: string,
): string {
  if (!isAbsolute(emittedPath)) {
    throw new Error(`Unnormalizable executed-file path: ${emittedPath}`);
  }
  if (!existsSync(emittedPath) || !statSync(emittedPath).isFile()) {
    throw new Error(`Unnormalizable executed-file path: ${emittedPath}`);
  }
  const root = realpathSync(repositoryRoot);
  const absolute = realpathSync(emittedPath);
  const repositoryPath = relative(root, absolute);
  if (
    repositoryPath === '' ||
    repositoryPath === '..' ||
    repositoryPath.startsWith(`..${sep}`) ||
    isAbsolute(repositoryPath)
  ) {
    throw new Error(`Unnormalizable executed-file path: ${emittedPath}`);
  }
  return normalizeSeparators(repositoryPath);
}

export function parseReachabilityEvidence(
  serialized: string,
  producer: ReachabilityProducer,
  currentRunId: string,
): SuiteEvidence {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error(
      `Invalid reachability evidence JSON for ${producer.id}: ${producer.evidencePath}`,
    );
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid reachability evidence object for ${producer.id}`);
  }
  if (value.version !== 2 || value.suiteId !== producer.id) {
    throw new Error(
      `Reachability evidence metadata mismatch for ${producer.id}`,
    );
  }
  if (typeof value.runId !== 'string') {
    throw new Error(`Missing reachability run token from ${producer.id}`);
  }
  if (value.runId !== currentRunId) {
    throw new Error(
      `Stale reachability evidence for ${producer.id}: expected run ${currentRunId}, received ${value.runId}`,
    );
  }
  if (
    !Array.isArray(value.argv) ||
    value.argv.some((argument) => typeof argument !== 'string')
  ) {
    throw new Error(`Invalid observed argv from ${producer.id}`);
  }
  if (!sameArguments(value.argv, producer.argv)) {
    throw new Error(
      `Observed argv mismatch for ${producer.id}: expected ${JSON.stringify(producer.argv)}, received ${JSON.stringify(value.argv)}`,
    );
  }
  if (
    value.runner !== producer.runner ||
    typeof value.suiteSucceeded !== 'boolean' ||
    !Array.isArray(value.files)
  ) {
    throw new Error(
      `Reachability evidence metadata mismatch for ${producer.id}`,
    );
  }
  const files = value.files.map((file) => {
    if (
      !isRecord(file) ||
      typeof file.path !== 'string' ||
      typeof file.realResultCount !== 'number'
    ) {
      throw new Error(`Invalid executed-file entry from ${producer.id}`);
    }
    return { path: file.path, realResultCount: file.realResultCount };
  });
  return {
    version: 2,
    suiteId: producer.id,
    runId: currentRunId,
    argv: value.argv,
    runner: producer.runner,
    suiteSucceeded: value.suiteSucceeded,
    files,
  };
}

function sameArguments(
  observed: readonly string[],
  declared: readonly string[],
): boolean {
  return (
    observed.length === declared.length &&
    observed.every((argument, index) => argument === declared[index])
  );
}

function normalizeSeparators(path: string): string {
  return path.split(sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
