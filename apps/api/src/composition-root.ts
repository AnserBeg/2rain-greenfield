import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';

import {
  createComposedApplicationRuntime,
  type ComposedApplicationRuntime,
  type InventoryScopeProvisioning,
} from '@north-star/postgres-provider/composed-application-runtime';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '@north-star/postgres-provider/inventory-provider-error-mappings';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/inventory-posting-capability-executor';
import { createSurfaceRuntimeServer } from '@north-star/web/app-server';

export interface ComposedApplicationServerOptions {
  readonly databaseUrl: string;
  readonly host?: string;
  readonly port?: number;
  readonly rollbackReleaseRoot?: string;
  readonly tenantSlug?: string;
}

export interface RunningComposedApplication {
  readonly baseUrl: string;
  readonly runtime: ComposedApplicationRuntime;
  readonly seededRecords: readonly ComposedApplicationSeedReceipt[];
  readonly server: Server;
  close(): Promise<void>;
}

export interface ComposedApplicationSeedReceipt {
  readonly operationId: string;
  readonly recordId: string;
  readonly trust: {
    readonly changeDocumentId: string;
    readonly domainEventId: string;
    readonly invocationId: string;
    readonly outboxId: string;
  };
}

export const COMPOSED_APPLICATION_INVENTORY_SCOPE = Object.freeze({
  adjustmentApprovalThreshold: null,
  adjustmentReasonRequirement: 'codeAndNarrative',
  businessDayBoundary: '00:00:00',
  configurationVersion: 1,
  correctionApprovalThreshold: null,
  correctionReasonRequirement: 'codeAndNarrative',
  countApprovalThreshold: null,
  countReasonRequirement: 'codeAndNarrative',
  entityCode: 'DEFAULT',
  entityName: 'Default legal entity',
  legalEntityId: '74000000-0000-4000-8000-000000000001',
  maximumBackdateDays: 0,
  negativeStock: 'reject',
  rebaselineApprovalThreshold: null,
  rebaselineReasonRequirement: 'codeAndNarrative',
  timeZone: 'UTC',
  transferApprovalThreshold: null,
  transferReasonRequirement: 'codeOnly',
} as const satisfies InventoryScopeProvisioning);

/** Thin transport root: provider assembly owns persistence and runtime wiring. */
export async function startComposedApplication(
  options: ComposedApplicationServerOptions,
): Promise<RunningComposedApplication> {
  const compiledApplication = JSON.parse(
    await readFile(
      new URL('../../web/release/app.compiled.json', import.meta.url),
      'utf8',
    ),
  ) as unknown;
  const runtime = await createComposedApplicationRuntime({
    capabilityOperationExecutorFactories: [
      INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
    ],
    compiledApplication,
    databaseUrl: options.databaseUrl,
    inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
    migrationsDirectory: new URL('../../../db/migrations/', import.meta.url)
      .pathname,
    providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
    ...(options.rollbackReleaseRoot !== undefined
      ? {
          releaseSelection: {
            kind: 'rollback' as const,
            targetReleaseRoot: options.rollbackReleaseRoot,
          },
        }
      : {}),
    tenantSlug: options.tenantSlug ?? 'local-composed-application',
  });
  const seededRecords = await seedComposedApplication(runtime);
  const server = createSurfaceRuntimeServer(runtime.entry, {
    operationGateway: runtime.operationGateway,
    operationMediation: runtime.operationMediation,
    queryGateway: runtime.queryGateway,
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4174, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await runtime.close();
    throw new Error('composed application server has no TCP address');
  }
  let closed = false;
  return Object.freeze({
    baseUrl: `http://${host}:${String(address.port)}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await runtime.close();
    },
    runtime,
    seededRecords,
    server,
  });
}

const applicationNamespace = 'northstar.app';

const demoSeed = Object.freeze([
  seedEntry('party', 1, {
    party_contact_summary: 'Purchasing · ap@alpine.example',
    party_name: 'Alpine Office Supply',
    party_number: 'P-1001',
  }),
  seedEntry('party', 2, {
    party_contact_summary: 'Wholesale · orders@northwind.example',
    party_name: 'Northwind Goods',
    party_number: 'P-1002',
  }),
  seedEntry('party', 3, {
    party_contact_summary: 'Local delivery · hello@prairie.example',
    party_name: 'Prairie Paper Co.',
    party_number: 'P-1003',
  }),
  seedEntry('party', 4, {
    party_contact_summary: 'Preferred supplier · team@summit.example',
    party_name: 'Summit Industrial',
    party_number: 'P-1004',
  }),
  seedEntry('item', 11, {
    item_base_unit: 'EA',
    item_description: 'Recycled ruled notebook, 80 pages',
    item_name: 'Field notebook',
    item_sku: 'OFF-100',
  }),
  seedEntry('item', 12, {
    item_base_unit: 'BOX',
    item_description: 'Black fine-point pens, pack of twelve',
    item_name: 'Fine-point pen set',
    item_sku: 'OFF-120',
  }),
  seedEntry('item', 13, {
    item_base_unit: 'EA',
    item_description: 'Adjustable task lamp, forest green',
    item_name: 'Task lamp',
    item_sku: 'OFF-210',
  }),
  seedEntry('item', 14, {
    item_base_unit: 'PACK',
    item_description: 'Compostable shipping labels, pack of 100',
    item_name: 'Shipping labels',
    item_sku: 'OPS-310',
  }),
  seedEntry('location', 21, {
    location_code: 'CAL-WH',
    location_name: 'Calgary warehouse',
    location_type: `${applicationNamespace}:option.warehouse`,
  }),
  seedEntry('location', 22, {
    location_code: 'EDM-ST',
    location_name: 'Edmonton store',
    location_type: `${applicationNamespace}:option.store`,
  }),
  seedEntry('location', 23, {
    location_code: 'VAN-WH',
    location_name: 'Vancouver warehouse',
    location_type: `${applicationNamespace}:option.warehouse`,
  }),
  seedEntry('location', 24, {
    location_code: 'YYC-ST',
    location_name: 'Beltline store',
    location_type: `${applicationNamespace}:option.store`,
  }),
]);

async function seedComposedApplication(
  runtime: ComposedApplicationRuntime,
): Promise<readonly ComposedApplicationSeedReceipt[]> {
  return runtime.entry.run(
    { headers: { authorization: 'local-demo-seed' } },
    async (view) => {
      const receipts: ComposedApplicationSeedReceipt[] = [];
      for (const seed of demoSeed) {
        const result = await runtime.operationGateway.invoke(
          view,
          {
            confirmationGrant: null,
            idempotencyKey: seed.idempotencyKey,
            input: { recordId: seed.recordId, values: seed.values },
            operationId: seed.operationId,
            schemaVersion: 'northstar.semantic-operation-request/v1',
          },
          runtime.operationMediation.issueInvocation(view, 'UI'),
        );
        if (
          result.outcome !== 'succeeded' ||
          !result.readBack ||
          !result.trust
        ) {
          throw new Error(`demo seed operation failed: ${seed.operationId}`);
        }
        receipts.push(
          Object.freeze({
            operationId: seed.operationId,
            recordId: result.readBack.recordId,
            trust: result.trust,
          }),
        );
      }
      return Object.freeze(receipts);
    },
  );
}

function seedEntry(
  localEntity: 'item' | 'location' | 'party',
  ordinal: number,
  values: Readonly<Record<string, string>>,
) {
  const suffix = String(ordinal).padStart(12, '0');
  return Object.freeze({
    idempotencyKey: `72000000-0000-4000-8000-${suffix}`,
    operationId: `${applicationNamespace}:operation.${localEntity}_create`,
    recordId: `71000000-0000-4000-8000-${suffix}`,
    values: Object.freeze(
      Object.fromEntries(
        Object.entries(values).map(([localField, value]) => [
          `${applicationNamespace}:field.${localField}`,
          value,
        ]),
      ),
    ),
  });
}
