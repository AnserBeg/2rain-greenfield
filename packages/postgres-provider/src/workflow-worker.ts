import type { TrustedRequestContext } from '@north-star/runtime';
import pg, { type Pool } from 'pg';
import { withTrustedRequestTransaction } from './request-context.js';
import {
  PostgresWorkflowConsumer,
  withWorkflowTransaction,
} from './workflow-consumer.js';
import {
  PostgresWorkflowExecution,
  WorkflowRemedyRefused,
  type WorkflowBusinessClock,
} from './workflow-execution.js';
import { PostgresWorkflowGateway } from './workflow-gateway.js';

/** One scheduler pass. Separate pools keep enumeration off the request role. */
export class PostgresWorkflowWorker {
  readonly #consumer: PostgresWorkflowConsumer;
  readonly #execution: PostgresWorkflowExecution;
  readonly #gateway: PostgresWorkflowGateway;

  constructor(
    private readonly workerPool: Pool,
    private readonly runtimePool: Pool,
    businessClock?: WorkflowBusinessClock,
  ) {
    this.#consumer = new PostgresWorkflowConsumer(workerPool);
    this.#gateway = new PostgresWorkflowGateway(runtimePool);
    this.#execution = new PostgresWorkflowExecution(
      workerPool,
      runtimePool,
      this.#gateway,
      undefined,
      businessClock,
    );
  }

  async poll(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.workerPool.query('SELECT platform.booking_sweep_due(16)');
    } catch (error) {
      failures.push(error);
    }
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

  async worklist(operator: TrustedRequestContext) {
    const approvals = await withTrustedRequestTransaction(
      this.runtimePool,
      operator,
      async (client) =>
        (
          await client.query<{
            runId: string;
            cursor: number;
            fence: string;
            digest: string;
            companyId: string | null;
            summary: string;
            operationId: string;
            input: unknown;
          }>(
            `SELECT run_id AS "runId", cursor, fence::text, plan_digest AS digest,
                  approval.company_id AS "companyId",
                  plan.value #>> '{request,summary}' AS summary,
                  plan.value #>> '{request,operationId}' AS "operationId",
                  plan.value #> '{request,input}' AS input
             FROM platform.workflow_approval_worklist() AS approval
            CROSS JOIN LATERAL (SELECT convert_from(approval.plan, 'UTF8')::jsonb AS value) AS plan`,
          )
        ).rows,
    );
    const suspended = await this.#gateway
      .withRemedyAuthority(operator, () =>
        withWorkflowTransaction(
          this.workerPool,
          {
            tenant_id: operator.tenantId,
            environment_id: operator.environmentId,
          },
          async (client) =>
            (
              await client.query<{
                runId: string;
                workflowId: string;
                reason: string;
              }>(
                `SELECT run_id AS "runId", workflow_id AS "workflowId", reason
             FROM platform.workflow_runs
            WHERE tenant_id = $1 AND environment_id = $2 AND status = 'SUSPENDED'
            ORDER BY created_at, run_id LIMIT 100`,
                [operator.tenantId, operator.environmentId],
              )
            ).rows,
        ),
      )
      .catch((error: unknown) => {
        if (error instanceof WorkflowRemedyRefused) return [];
        throw error;
      });
    return { approvals, suspended };
  }

  decide(
    operator: TrustedRequestContext,
    selection: { runId: string; cursor: number; fence: string; digest: string },
    decision: 'APPROVED' | 'DECLINED',
  ) {
    return withTrustedRequestTransaction(
      this.runtimePool,
      operator,
      async (client) =>
        (
          await client.query<{ decided: boolean }>(
            'SELECT platform.workflow_decide_approval($1, $2, $3, $4, $5) AS decided',
            [
              selection.runId,
              selection.cursor,
              selection.fence,
              selection.digest,
              decision,
            ],
          )
        ).rows[0]!.decided,
    );
  }
}

export interface WorkflowSchedulerConfig {
  readonly businessClock?: WorkflowBusinessClock;
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
) {
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
  const worker = new PostgresWorkflowWorker(
    workerPool,
    runtimePool,
    config.businessClock,
  );
  const stop = superviseWorkflowPolls(worker, reportFailure);
  return {
    worker,
    async close() {
      await stop();
      await Promise.all([workerPool.end(), runtimePool.end()]);
    },
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
