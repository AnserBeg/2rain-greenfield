import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

export const reachabilityRunIdPath = 'test-results/reachability/run-id';

const validRunId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * @param {{repositoryRoot: string, environment?: Readonly<Record<string, string | undefined>>, generateRunId?: () => string}} context
 */
export function beginReachabilityRun(context) {
  const environment = context.environment ?? process.env;
  const supplied = environment.REACHABILITY_RUN_ID;
  const runId = validateReachabilityRunId(
    supplied === undefined ? (context.generateRunId ?? randomUUID)() : supplied,
  );
  persistReachabilityRunId(context.repositoryRoot, runId);
  return runId;
}

/**
 * Resolve the current run for a producer. A standalone producer creates a run
 * only when no orchestrated run has ever been persisted.
 *
 * @param {{repositoryRoot: string, environment?: Readonly<Record<string, string | undefined>>, generateRunId?: () => string}} context
 */
export function ensureReachabilityRun(context) {
  const environment = context.environment ?? process.env;
  if (environment.REACHABILITY_RUN_ID !== undefined) {
    return beginReachabilityRun({ ...context, environment });
  }
  if (existsSync(resolve(context.repositoryRoot, reachabilityRunIdPath))) {
    return resolveReachabilityRunId({ ...context, environment });
  }
  return beginReachabilityRun({ ...context, environment });
}

/**
 * @param {{repositoryRoot: string, environment?: Readonly<Record<string, string | undefined>>}} context
 */
export function resolveReachabilityRunId(context) {
  const environment = context.environment ?? process.env;
  const supplied = environment.REACHABILITY_RUN_ID;
  if (supplied !== undefined) return validateReachabilityRunId(supplied);

  const path = resolve(context.repositoryRoot, reachabilityRunIdPath);
  if (!existsSync(path)) {
    throw new Error(
      `Unresolvable reachability run token: REACHABILITY_RUN_ID is unset and ${reachabilityRunIdPath} is missing`,
    );
  }
  return validateReachabilityRunId(readFileSync(path, 'utf8').trim());
}

/** @param {string} runId */
export function validateReachabilityRunId(runId) {
  if (!validRunId.test(runId)) {
    throw new Error(`Invalid reachability run token: ${JSON.stringify(runId)}`);
  }
  return runId;
}

function persistReachabilityRunId(repositoryRoot, runId) {
  const path = resolve(repositoryRoot, reachabilityRunIdPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${runId}\n`);
}
