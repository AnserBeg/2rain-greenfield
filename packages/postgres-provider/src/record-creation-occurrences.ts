import type { PoolClient } from 'pg';

/**
 * ADR-0073 A1, owner ruling 2026-11-21. A governed writer names every
 * company-owned record it inserts, so a `recordCreated` subscription on that
 * record type never misses one, including each line a single command creates.
 * The occurrence is recorded only while the trust service or the posting
 * kernel holds the transaction's creation action, and that writer's own outbox
 * row seals it to the committed event. The company comes from the stored row.
 *
 * Every insert into a managed table is listed in
 * `test/architecture/record-creation-writers.test.ts`; a new one fails there
 * until it calls this or states why its rows are not record creations.
 */
export async function recordCreations(
  client: PoolClient,
  entity: {
    readonly entityId: string;
    readonly physicalTableName: string;
    readonly legalEntity?: unknown;
    readonly recordIdentity?: { readonly column: string };
  },
  company: string,
  recordIds: readonly string[],
): Promise<void> {
  if (!entity.legalEntity || recordIds.length === 0) return;
  // The function refuses outside a governed write or after the seal, and
  // when a named record is not stored in this company: never a silent 0.
  await client.query(
    'SELECT north_star_internal.record_creations($1, $2, $3, $4::uuid, $5::uuid[])',
    [
      entity.physicalTableName,
      entity.recordIdentity?.column ?? 'record_id',
      entity.entityId,
      company,
      recordIds,
    ],
  );
}
