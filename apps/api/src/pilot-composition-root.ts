import pg from 'pg';
import { ObservabilityMetrics } from '../../../packages/observability/src/index.js';
import { SYSTEM_EXECUTION_PRINCIPAL } from '../../../packages/platform-runtime/src/index.js';
import { AuthenticatedRequestEntryAdapter } from '../../../packages/runtime/src/request-context.js';
import { AuthenticatedRequestRuntimeEntryAdapter } from '../../../packages/runtime/src/request-runtime-view.js';
import {
  composeServingGateways,
  readVerifiedServing,
  loadServingRelease,
} from '../../../packages/postgres-provider/src/serving-gateways.js';
import { PostgresRequestRuntimeViewService } from '@north-star/postgres-provider/request-runtime-view-service';
import {
  staffRequestEntry,
  withReadSnapshot,
} from '@north-star/postgres-provider/request-context';
import {
  createRequestWorkProbe,
  meterPoolStatements,
} from '@north-star/postgres-provider/request-work-meter';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '@north-star/postgres-provider/inventory-provider-error-mappings';
import { createSurfaceRuntimeServer } from '@north-star/web/app-server';
import { COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION } from '@north-star/web/sales-section';
import { CAPABILITY_EXECUTOR_FACTORIES } from './erp-capabilities.js';
import {
  assertPilotDatabase,
  check,
  cookieValue,
  digest,
  validateRealm,
  type StaffRealm,
} from './staff-protocol.js';
import { erpTransport, sessionCookie } from './staff-erp-transport.js';

export async function createPilotApplication(options: {
  realm: StaffRealm;
  runtimeDatabaseUrl: string;
  identityCa?: Buffer;
  localDemoIdentity?: boolean;
}) {
  check(!options.localDemoIdentity);
  validateRealm(options.realm);
  const r = options.realm;
  const pool = meterPoolStatements(
    new pg.Pool({ connectionString: options.runtimeDatabaseUrl, max: 6 }),
  );
  const evidence = meterPoolStatements(
    new pg.Pool({ connectionString: options.runtimeDatabaseUrl, max: 2 }),
  );
  const close = () => Promise.all([pool.end(), evidence.end()]);
  try {
    await assertPilotDatabase(pool, 'north_star_runtime', r);
    const service = await new AuthenticatedRequestEntryAdapter(async () => ({
      tenantId: r.tenantId,
      environmentId: r.environmentId,
      principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
    })).enter({});
    const pointer = await readVerifiedServing(pool, service);
    check(pointer);
    const serving = await loadServingRelease(pool, service, pointer.releaseId);
    const { queryGateway, operationGateway, operationMediation, policy } =
      composeServingGateways(
        pool,
        evidence,
        service,
        serving,
        new ObservabilityMetrics(),
        {
          capabilityOperationExecutorFactories: CAPABILITY_EXECUTOR_FACTORIES,
          providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
        },
      );
    const entry = new AuthenticatedRequestRuntimeEntryAdapter(
      staffRequestEntry(pool, (request) => {
        const handle = cookieValue(request.headers?.cookie, sessionCookie);
        return handle
          ? {
              tenantId: r.tenantId,
              environmentId: r.environmentId,
              digest: digest(handle),
              foreground:
                request.headers?.['sec-fetch-user'] === '?1' ||
                (request.headers?.['sec-fetch-site'] === 'same-origin' &&
                  ['task', '1'].includes(
                    String(request.headers?.['x-rain-fragment']),
                  )),
            }
          : null;
      }),
      new PostgresRequestRuntimeViewService(pool),
      policy,
    );
    const server = createSurfaceRuntimeServer(
      entry,
      {
        queryGateway,
        operationGateway,
        operationMediation,
        applicationExtension: COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION,
      },
      null,
      undefined,
      {
        staffTransport: erpTransport(r, options.identityCa),
        readSnapshot: (work, opts) => withReadSnapshot(pool, work, opts),
        requestWork: createRequestWorkProbe(),
      },
    );
    return { server, close };
  } catch (error) {
    await close();
    throw error;
  }
}
