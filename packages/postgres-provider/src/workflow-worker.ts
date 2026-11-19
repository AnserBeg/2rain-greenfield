import type { TrustedRequestContext } from '@north-star/runtime';
import pg, { type Pool } from 'pg';
import { PostgresWorkflowConsumer } from './workflow-consumer.js';
import { PostgresWorkflowExecution } from './workflow-execution.js';
import { PostgresWorkflowGateway } from './workflow-gateway.js';

/** One scheduler pass. Separate pools keep enumeration off the request role. */
export class PostgresWorkflowWorker {
  readonly #consumer: PostgresWorkflowConsumer;
  readonly #execution: PostgresWorkflowExecution;

  constructor(workerPool: Pool, runtimePool: Pool) {
    this.#consumer = new PostgresWorkflowConsumer(workerPool);
    this.#execution = new PostgresWorkflowExecution(
      workerPool,
      runtimePool,
      new PostgresWorkflowGateway(runtimePool),
    );
  }

  async poll(): Promise<void> {
    const failures: unknown[] = [];
    for (const scope of await this.#consumer.scopes()) {
      try {
        await this.#consumer.claim(scope);
        await this.#execution.tick(scope);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Workflow scheduler pass failed');
  }

  remedy(
    operator: TrustedRequestContext,
    runIds: readonly string[],
    action: 'retry' | 'cancel',
  ) {
    return this.#execution.remedy(operator, runIds, action);
  }
}

export interface WorkflowSchedulerConfig {
  readonly workerDatabaseUrl: string;
  readonly runtimeDatabaseUrl: string;
}

export function workflowSchedulerConfig(
  env: NodeJS.ProcessEnv,
): WorkflowSchedulerConfig | undefined {
  const enabled = env.NORTH_STAR_WORKFLOW_SCHEDULER;
  if (enabled === undefined || enabled === 'off') return undefined;
  if (enabled !== 'on')
    throw new Error('NORTH_STAR_WORKFLOW_SCHEDULER must be on or off');
  const workerDatabaseUrl = env.NORTH_STAR_WORKFLOW_WORKER_DATABASE_URL;
  const runtimeDatabaseUrl = env.NORTH_STAR_WORKFLOW_RUNTIME_DATABASE_URL;
  validateRoleUrl(workerDatabaseUrl, 'north_star_workflow_worker');
  validateRoleUrl(runtimeDatabaseUrl, 'north_star_runtime');
  return { workerDatabaseUrl, runtimeDatabaseUrl };
}

function validateRoleUrl(
  url: string | undefined,
  role: string,
): asserts url is string {
  if (!url)
    throw new Error(`Workflow scheduler requires a database URL for ${role}`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid workflow scheduler database URL for ${role}`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.username !== role
  )
    throw new Error(`Workflow scheduler requires a database URL for ${role}`);
}

export function startWorkflowScheduler(
  config: WorkflowSchedulerConfig,
  reportFailure: () => void,
): () => Promise<void> {
  validateRoleUrl(config.workerDatabaseUrl, 'north_star_workflow_worker');
  validateRoleUrl(config.runtimeDatabaseUrl, 'north_star_runtime');
  const workerPool = new pg.Pool({
    connectionString: config.workerDatabaseUrl,
    connectionTimeoutMillis: 5_000,
    max: 2,
  });
  const runtimePool = new pg.Pool({
    connectionString: config.runtimeDatabaseUrl,
    connectionTimeoutMillis: 5_000,
    max: 4,
  });
  workerPool.on('error', reportFailure);
  runtimePool.on('error', reportFailure);
  const stop = superviseWorkflowPolls(
    new PostgresWorkflowWorker(workerPool, runtimePool),
    reportFailure,
  );
  return async () => {
    await stop();
    await Promise.all([workerPool.end(), runtimePool.end()]);
  };
}

export function superviseWorkflowPolls(
  worker: Pick<PostgresWorkflowWorker, 'poll'>,
  reportFailure: () => void,
  interval = 1_000,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll(): Promise<void> {
    try {
      await worker.poll();
    } catch {
      reportFailure();
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          active = poll();
        }, interval).unref();
    }
  }
  let active = poll();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await active;
  };
}
