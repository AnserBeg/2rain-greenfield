import type { TrustedRequestContext } from '@north-star/runtime';
import type { Pool } from 'pg';
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
