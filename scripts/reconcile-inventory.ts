import pg from 'pg';
import type { StorageTargetPayloadV1 } from '../packages/compiler/src/index.js';
import { AuthenticatedRequestEntryAdapter } from '../packages/runtime/src/request-context.js';
import { PostgresRequestRuntimeViewService } from '../packages/postgres-provider/src/request-runtime-view-service.js';
import { withTrustedRequestTransaction } from '../packages/postgres-provider/src/request-context.js';
import {
  PostgresInventoryReconciliationService,
  renderInventoryReconciliationReport,
} from '../packages/postgres-provider/src/inventory-reconciliation-service.js';

// Operator CLI: the configured database credential authenticates the operator.
// Never starts the application, seeds data, migrates storage or rebuilds it.
async function main(): Promise<void> {
  const [tenantId, environmentId, principalId, ...legalEntityIds] =
    process.argv.slice(2);
  if (
    !tenantId ||
    !environmentId ||
    !principalId ||
    legalEntityIds.length === 0 ||
    !process.env.DATABASE_URL
  ) {
    throw new Error(
      'Usage: DATABASE_URL=<north_star_runtime URL> node --import tsx scripts/reconcile-inventory.ts TENANT ENVIRONMENT PRINCIPAL LEGAL_ENTITY [LEGAL_ENTITY...]',
    );
  }
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    options: '-c default_transaction_read_only=on',
  });
  try {
    const context = await new AuthenticatedRequestEntryAdapter(async () => ({
      tenantId,
      environmentId,
      principalId,
    })).enter({ headers: {} });
    const definition = await new PostgresRequestRuntimeViewService(pool).load(
      context,
    );
    const target = await withTrustedRequestTransaction(
      pool,
      context,
      async (client) => {
        const result = await client.query<{ canonical_bytes: Buffer }>(
          `SELECT canonical_bytes FROM platform.read_tenant_release_artifacts($1)
          WHERE artifact_kind = 'projectionChunk'
            AND domain_tag = 'northstar.compiler.projection-chunk/v0-experimental/northstar.compiler:projection-family.storage-target'`,
          [definition.release.releaseId],
        );
        if (result.rows.length !== 1)
          throw new Error('Active release requires exactly one storage target');
        const value = JSON.parse(
          result.rows[0]!.canonical_bytes.toString('utf8'),
        ) as StorageTargetPayloadV1;
        if (value.kind !== 'storageTargetPayload')
          throw new Error('Invalid active storage target');
        return value;
      },
    );
    const movement = target.entities.find((entity) =>
      entity.entityId.endsWith(':entity.inventory_movement'),
    );
    if (!movement) throw new Error('Active release has no inventory ledger');
    const namespace = movement.entityId.split(':')[0]!;
    const report = await new PostgresInventoryReconciliationService(pool, {
      storageTarget: target,
      aggregateQueryId: `${namespace}:query.inventory_movement_on_hand`,
      aggregateParameterIds: {
        atTime: `${namespace}:parameter.on_hand_at_time`,
        recordedAtHorizon: `${namespace}:parameter.on_hand_recorded_at_horizon`,
        itemId: `${namespace}:parameter.on_hand_item_id`,
        locationId: `${namespace}:parameter.on_hand_location_id`,
        legalEntityId: `${namespace}:parameter.on_hand_legal_entity_id`,
      },
    }).reconcile(context, {
      legalEntityIds,
      scopeId: 'operator-inventory-reconciliation',
    });
    process.stdout.write(
      `${renderInventoryReconciliationReport(report).join('\n')}\n${JSON.stringify(report)}\n`,
    );
    process.exitCode =
      report.outcome === 'consistent'
        ? 0
        : report.outcome === 'discrepant'
          ? 2
          : 3;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
