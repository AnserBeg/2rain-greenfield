import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type pg from 'pg';

import { COMPOSED_APPLICATION_INVENTORY_SCOPE } from '../../apps/api/src/composition-root.js';
import {
  createComposedApplicationRuntime,
  type ComposedApplicationRuntime,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/inventory-posting-capability-executor.js';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '../../packages/postgres-provider/src/inventory-provider-error-mappings.js';
import { PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/purchase-order-approval-executor.js';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '../../packages/postgres-provider/src/receiving-capability-executor.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import { SEMANTIC_OPERATION_REQUEST_VERSION } from '../../packages/runtime/src/semantic-operation-gateway.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';

export const authoredPath = resolve('apps/web/release/app.authored.json');
export const firstPartyAuthored = JSON.parse(
  readFileSync(authoredPath, 'utf8'),
) as Record<string, unknown>;
export const compiledApplication = JSON.parse(
  readFileSync(resolve('apps/web/release/app.compiled.json'), 'utf8'),
) as unknown;
export const migrationsDirectory = resolve('db/migrations');
export const equipment = JSON.parse(
  readFileSync(resolve('apps/api/scripts/examples/equipment.json'), 'utf8'),
) as unknown;

export async function activeReleaseId(
  pool: pg.Pool,
  tenantId: string,
): Promise<string | null> {
  const result = await pool.query<{ release_id: string | null }>(
    'SELECT release_id FROM platform.active_release_pointers WHERE tenant_id = $1',
    [tenantId],
  );
  return result.rows[0]?.release_id ?? null;
}

export const EQUIPMENT = Object.freeze({
  create: 'northstar.app:operation.custom_equipment_create',
  list: 'northstar.app:query.custom_equipment_list',
  name: 'northstar.app:field.custom_equipment_name',
  purchaseDate: 'northstar.app:field.custom_equipment_purchase_date',
  serial: 'northstar.app:field.custom_equipment_serial_number',
  status: 'northstar.app:field.custom_equipment_status',
  inService: 'northstar.app:option.custom_equipment_status_in_service',
});

export function startRuntime(
  databaseUrl: string,
  slug: string,
  inputs: Pick<
    Parameters<typeof createComposedApplicationRuntime>[0],
    'compiledApplication' | 'customization'
  > = { compiledApplication },
) {
  return createComposedApplicationRuntime({
    capabilityOperationExecutorFactories: [
      INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
      RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
      PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY,
    ],
    ...inputs,
    databaseUrl,
    inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
    localDemoIdentity: true,
    migrationsDirectory,
    providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
    tenantSlug: slug,
  });
}

export function listEquipment(runtime: ComposedApplicationRuntime) {
  return runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
    runtime.queryGateway.invoke(view, {
      arguments: {
        includeArchived: false,
        list: {
          cursor: null,
          matchMode: 'substring',
          pageSize: 100,
          relationLabels: [],
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          search: '',
          sort: [],
        },
      },
      queryId: EQUIPMENT.list,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    }),
  );
}

export function createEquipment(
  runtime: ComposedApplicationRuntime,
  recordId: string,
) {
  return runtime.entry.run({ headers: { authorization: 'local' } }, (view) =>
    runtime.operationGateway.invoke(
      view,
      {
        confirmationGrant: null,
        idempotencyKey: randomUUID(),
        input: {
          recordId,
          values: {
            [EQUIPMENT.name]: 'Forklift 3',
            [EQUIPMENT.serial]: 'FL-0003',
            [EQUIPMENT.purchaseDate]: '2026-11-01',
            [EQUIPMENT.status]: EQUIPMENT.inService,
          },
        },
        operationId: EQUIPMENT.create,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      runtime.operationMediation.issueInvocation(view, 'UI'),
    ),
  );
}

export async function pointerFence(
  pool: pg.Pool,
  tenantId: string,
): Promise<string> {
  const result = await pool.query<{ fence: string; release_id: string }>(
    'SELECT fence::text AS fence, release_id FROM platform.active_release_pointers WHERE tenant_id = $1',
    [tenantId],
  );
  return `${result.rows[0]!.release_id}@${result.rows[0]!.fence}`;
}
