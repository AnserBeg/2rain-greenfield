import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';

import {
  createComposedApplicationRuntime,
  type ComposedApplicationRuntime,
  type InventoryScopeProvisioning,
} from '@north-star/postgres-provider/composed-application-runtime';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '@north-star/postgres-provider/inventory-provider-error-mappings';
import { INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/inventory-posting-capability-executor';
import { FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/fulfillment-capability-executor';
import { RECEIVING_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/receiving-capability-executor';
import { RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY } from '@north-star/postgres-provider/receivables-capability-executor';
import { createSurfaceRuntimeServer } from '@north-star/web/app-server';
import { COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION } from '@north-star/web/sales-section';

import {
  composedApplicationSeed,
  type ComposedApplicationSeedProfile,
} from '../../../packages/domain/src/app/seed.js';

export interface ComposedApplicationServerOptions {
  /**
   * A compiled release envelope to serve instead of the checked-in one. Tests
   * use it to serve a metadata-only variation through the unchanged runtime.
   */
  readonly compiledApplication?: unknown;
  readonly databaseUrl: string;
  readonly host?: string;
  readonly port?: number;
  readonly rollbackReleaseRoot?: string;
  /**
   * Which authored seed to install. Defaults to `demo`, the small fixed
   * fixture the browser suite asserts against; the dev entry point asks for
   * `distributor`, which is a superset carrying enough volume to judge the
   * surfaces by eye.
   */
  readonly seedProfile?: ComposedApplicationSeedProfile;
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
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('the composed demo identity may bind only to loopback');
  }
  const compiledApplication =
    options.compiledApplication ??
    (JSON.parse(
      await readFile(
        new URL('../../web/release/app.compiled.json', import.meta.url),
        'utf8',
      ),
    ) as unknown);
  const runtime = await createComposedApplicationRuntime({
    capabilityOperationExecutorFactories: [
      INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY,
      RECEIVING_CAPABILITY_EXECUTOR_FACTORY,
      FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY,
      RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY,
    ],
    compiledApplication,
    databaseUrl: options.databaseUrl,
    inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
    localDemoIdentity: true,
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
  // Everything after the runtime exists must hand it back closed on failure.
  // Seeding is 176 operations and `listen` can fail with EADDRINUSE; either
  // one previously threw past an open runtime, leaving the caller with no
  // object to close and its pools and container still held.
  let seededRecords: readonly ComposedApplicationSeedReceipt[];
  let server: Server;
  try {
    seededRecords = await seedComposedApplication(
      runtime,
      options.seedProfile ?? 'demo',
    );
    server = createSurfaceRuntimeServer(runtime.entry, {
      applicationExtension: COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION,
      operationGateway: runtime.operationGateway,
      operationMediation: runtime.operationMediation,
      queryGateway: runtime.queryGateway,
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 4174, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
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

async function seedComposedApplication(
  runtime: ComposedApplicationRuntime,
  profile: ComposedApplicationSeedProfile,
): Promise<readonly ComposedApplicationSeedReceipt[]> {
  return runtime.entry.run(
    { headers: { authorization: 'local-demo-seed' } },
    async (view) => {
      const receipts: ComposedApplicationSeedReceipt[] = [];
      for (const seed of composedApplicationSeed(profile)) {
        const result = await runtime.operationGateway.invoke(
          view,
          {
            confirmationGrant: null,
            idempotencyKey: seed.idempotencyKey,
            input: {
              recordId: seed.recordId,
              values: seed.values,
              ...(seed.relations ? { relations: seed.relations } : {}),
            },
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
