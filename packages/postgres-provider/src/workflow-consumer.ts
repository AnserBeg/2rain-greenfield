import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { RECEIPT_POSTED_EVENT } from '../../domain/src/purchasing/receipt-posted-event.js';

export const RECEIPT_POSTED_TYPE = RECEIPT_POSTED_EVENT.eventType;
const FIRST_UUID = '00000000-0000-0000-0000-000000000000';
export const WORKFLOW_POLL_BATCH_SIZE = 64;

export interface WorkflowScope {
  readonly tenant_id: string;
  readonly environment_id: string;
}

export interface WorkflowPointer {
  readonly pointer_id: string;
  readonly fence: string;
  readonly release_id: string | null;
}

interface Watermark {
  readonly release_root: string;
  readonly definition_bindings: Readonly<
    Record<
      string,
      { readonly digest: string; readonly unattendedOperations: unknown }
    >
  >;
}

interface ReceiptCandidate {
  readonly outbox_id: string;
  readonly release_id: string;
  readonly release_content_hash: string;
  readonly event_id: string | null;
  readonly receipt_id: string | null;
  readonly legal_entity_id: string | null;
  readonly trigger_principal_id: string | null;
}

// Bound the unresolved source page before validating the linked trust rows.
export const WORKFLOW_RECEIPT_PAGE_SQL = `
  WITH page AS MATERIALIZED (
    SELECT tenant_id, environment_id, outbox_id
      FROM platform.workflow_event_sources
     WHERE tenant_id = $1 AND environment_id = $2 AND outbox_id >= $3
       AND event_type = $8 AND NOT resolved
     ORDER BY outbox_id
     LIMIT $4
  )
  SELECT o.outbox_id, o.release_id, o.release_content_hash,
         event.domain_event_id AS event_id, change.record_id AS receipt_id,
         invocation.policy_inputs #>> '{legalEntityId,value}' AS legal_entity_id,
         change.execution_principal_id AS trigger_principal_id
    FROM page
    JOIN platform.trust_outbox AS o USING (tenant_id, environment_id, outbox_id)
    LEFT JOIN platform.trust_domain_events AS event
      ON event.tenant_id = o.tenant_id AND event.environment_id = o.environment_id
     AND event.domain_event_id = o.domain_event_id AND event.outbox_id = o.outbox_id
     AND event.invocation_id = o.invocation_id AND event.change_document_id = o.change_document_id
     AND event.release_id = o.release_id AND event.release_content_hash = o.release_content_hash
     AND event.event_type = o.event_type AND event.event_schema_version = o.event_schema_version
     AND event.action_id = o.action_id AND o.action_id = $5 AND o.event_schema_version = $6
     AND event.payload #>> '{legalEntityId,representation}' = 'VALUE'
    LEFT JOIN platform.trust_action_invocations AS invocation
      ON invocation.tenant_id = event.tenant_id AND invocation.environment_id = event.environment_id
     AND invocation.invocation_id = event.invocation_id AND invocation.action_id = event.action_id
     AND invocation.outcome = 'SUCCEEDED'
     AND invocation.policy_inputs #>> '{legalEntityId,representation}' = 'VALUE'
     AND invocation.policy_inputs #>> '{legalEntityId,value}' = event.payload #>> '{legalEntityId,value}'
    LEFT JOIN platform.trust_business_change_documents AS change
      ON change.tenant_id = o.tenant_id AND change.environment_id = o.environment_id
     AND change.change_document_id = event.change_document_id AND change.invocation_id = event.invocation_id
     AND change.release_id = event.release_id AND change.release_content_hash = event.release_content_hash
     AND change.domain_event_id = event.domain_event_id AND change.outbox_id = o.outbox_id
     AND change.action_id = event.action_id AND change.record_type = $7
   WHERE o.event_type = $8
   ORDER BY o.outbox_id`;

export class PostgresWorkflowConsumer {
  constructor(private readonly pool: Pool) {}

  async scopes(): Promise<readonly WorkflowScope[]> {
    const client = await this.pool.connect();
    try {
      await assertWorkerRole(client);
      return (
        await client.query<WorkflowScope>(
          'SELECT * FROM platform.workflow_environment_ids()',
        )
      ).rows;
    } finally {
      client.release();
    }
  }

  async claim(scope: WorkflowScope): Promise<number> {
    const key = `${scope.tenant_id}/${scope.environment_id}`;
    return withWorkflowTransaction(this.pool, scope, async (client) => {
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
        [`northstar.workflow-consume/v1:${key}`],
      );
      if (!lock.rows[0]?.acquired) return 0;
      const pointer = await lockWorkflowPointer(client);
      if (!pointer?.release_id) return 0;
      const watermark = await verifiedWorkflowWatermark(client, scope, pointer);
      if (!watermark) return 0;
      const scopeKeys = [scope.tenant_id, scope.environment_id];
      const definitions = await client.query<{ workflow_id: string }>(
        `SELECT d.workflow_id
            FROM platform.workflow_definitions AS d
            JOIN platform.workflow_activation_watermarks AS w USING (tenant_id, environment_id, release_id)
           WHERE d.tenant_id = $1 AND d.environment_id = $2 AND d.release_id = $3 AND d.event_type = $4
             AND w.pointer_id = $5 AND w.fence = $6
             AND w.definition_bindings->d.workflow_id->>'digest' = platform.workflow_definition_digest(d)
           ORDER BY d.workflow_id`,
        [
          ...scopeKeys,
          pointer.release_id,
          RECEIPT_POSTED_TYPE,
          pointer.pointer_id,
          pointer.fence,
        ],
      );
      if (!definitions.rows.length) return 0;
      const position = await client.query<{ next_outbox_id: string }>(
        `SELECT next_outbox_id FROM platform.workflow_receipt_scan_positions
           WHERE tenant_id = $1 AND environment_id = $2 AND pointer_id = $3 AND fence = $4`,
        [...scopeKeys, pointer.pointer_id, pointer.fence],
      );
      const after = position.rows[0]?.next_outbox_id ?? FIRST_UUID;
      const candidates = await client.query<ReceiptCandidate>(
        WORKFLOW_RECEIPT_PAGE_SQL,
        [
          ...scopeKeys,
          after,
          WORKFLOW_POLL_BATCH_SIZE + 1,
          RECEIPT_POSTED_EVENT.postingAction,
          RECEIPT_POSTED_EVENT.schemaVersion,
          RECEIPT_POSTED_EVENT.recordType,
          RECEIPT_POSTED_TYPE,
        ],
      );
      let count = 0;
      for (const event of candidates.rows.slice(0, WORKFLOW_POLL_BATCH_SIZE)) {
        const eligible =
          event.release_id === pointer.release_id &&
          event.release_content_hash === watermark.release_root &&
          validReceipt(event);
        await client.query(
          `INSERT INTO platform.workflow_event_occurrences (
             tenant_id, environment_id, outbox_id, pointer_id, fence, disposition
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            ...scopeKeys,
            event.outbox_id,
            pointer.pointer_id,
            pointer.fence,
            eligible ? 'CLAIMED' : 'INELIGIBLE',
          ],
        );
        if (!eligible) continue;
        for (const { workflow_id } of definitions.rows) {
          const instance = await client.query<{ instance_id: string }>(
            `INSERT INTO platform.workflow_instances (
               tenant_id, environment_id, instance_id, outbox_id, event_id,
               workflow_id, legal_entity_id, receipt_id, trigger_principal_id
             )
             SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                    $6::text, $7::uuid, $8::uuid, $9::uuid
             WHERE NOT EXISTS (
               SELECT 1 FROM platform.workflow_instances
                WHERE tenant_id = $1 AND environment_id = $2
                  AND event_id = $5 AND workflow_id = $6
             )
             RETURNING instance_id`,
            [
              ...scopeKeys,
              randomUUID(),
              event.outbox_id,
              event.event_id,
              workflow_id,
              event.legal_entity_id,
              event.receipt_id,
              event.trigger_principal_id,
            ],
          );
          if (!instance.rows[0]) continue;
          await client.query(
            `INSERT INTO platform.workflow_runs (
               tenant_id, environment_id, run_id, instance_id, workflow_id, pointer_id,
               release_id, release_root, initial_fence, execution_fence
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
            [
              ...scopeKeys,
              randomUUID(),
              instance.rows[0].instance_id,
              workflow_id,
              pointer.pointer_id,
              pointer.release_id,
              watermark.release_root,
              pointer.fence,
            ],
          );
          count++;
        }
      }
      const next = candidates.rows[WORKFLOW_POLL_BATCH_SIZE];
      await client.query(
        `INSERT INTO platform.workflow_receipt_scan_positions (
             tenant_id, environment_id, pointer_id, fence, next_outbox_id
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, environment_id) DO UPDATE
           SET pointer_id = EXCLUDED.pointer_id, fence = EXCLUDED.fence,
               next_outbox_id = EXCLUDED.next_outbox_id`,
        [
          ...scopeKeys,
          pointer.pointer_id,
          pointer.fence,
          next?.outbox_id ?? FIRST_UUID,
        ],
      );
      return count;
    });
  }
}

function validReceipt(event: ReceiptCandidate): boolean {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return [
    event.event_id,
    event.receipt_id,
    event.legal_entity_id,
    event.trigger_principal_id,
  ].every((id) => id !== null && uuid.test(id));
}

export async function withWorkflowTransaction<T>(
  pool: Pool,
  scope: WorkflowScope,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let failure: Error | undefined;
  try {
    await client.query('BEGIN');
    await assertWorkerRole(client);
    await client.query(
      `SELECT set_config('north_star.tenant_id', $1, true),
              set_config('north_star.environment_id', $2, true)`,
      [scope.tenant_id, scope.environment_id],
    );
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollback) {
      failure = new AggregateError(
        [error, rollback],
        'workflow rollback failed',
      );
      throw failure;
    }
    throw error;
  } finally {
    client.release(failure);
  }
}

async function assertWorkerRole(client: PoolClient): Promise<void> {
  const role = await client.query<{ safe: boolean }>(
    `SELECT session_user = 'north_star_workflow_worker'
        AND current_user = session_user AND NOT (rolsuper OR rolbypassrls) AS safe
       FROM pg_roles WHERE rolname = current_user`,
  );
  if (!role.rows[0]?.safe)
    throw new Error('Workflow scheduler requires the scoped worker login');
}

export async function lockWorkflowPointer(
  client: PoolClient,
): Promise<WorkflowPointer | null> {
  return (
    (
      await client.query<WorkflowPointer>(
        'SELECT * FROM platform.workflow_lock_pointer()',
      )
    ).rows[0] ?? null
  );
}

export async function verifiedWorkflowWatermark(
  client: PoolClient,
  scope: WorkflowScope,
  pointer: WorkflowPointer,
): Promise<Watermark | null> {
  return (
    (
      await client.query<Watermark>(
        `SELECT release_root, definition_bindings FROM platform.workflow_activation_watermarks
      WHERE tenant_id = $1 AND environment_id = $2 AND pointer_id = $3 AND fence = $4 AND release_id = $5
        AND verified_approval_binding`,
        [
          scope.tenant_id,
          scope.environment_id,
          pointer.pointer_id,
          pointer.fence,
          pointer.release_id,
        ],
      )
    ).rows[0] ?? null
  );
}
