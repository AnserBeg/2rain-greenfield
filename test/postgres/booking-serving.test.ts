import assert from 'node:assert/strict';
import test from 'node:test';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { withArchivedCustomizationRuntime } from '../helpers/archived-runtime-process.js';
import { applicationBeforeStockCountWorkflow } from '../helpers/application-before-stock-count-workflow.js';
import {
  bookingRelease,
  demoItem,
  usageField,
  usageQuery,
  withBookingApplication,
} from '../helpers/booking-release.js';

test('the compiler requires a distinct steward write for a correction and admits its separate 90-day age', () => {
  bookingRelease('operation', true);
  bookingRelease('operation');
});

const archivedQuery = `
import { readFile } from 'node:fs/promises';
import { ObservabilityMetrics } from './packages/observability/src/index.ts';
import { AuthenticatedRequestEntryAdapter } from './packages/runtime/src/request-context.ts';
import { AuthenticatedRequestRuntimeEntryAdapter } from './packages/runtime/src/request-runtime-view.ts';
import { SEMANTIC_QUERY_REQUEST_VERSION } from './packages/runtime/src/semantic-query-gateway.ts';
import { rolePool, trustedContext } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { composeServingGateways, loadServingRelease } from './packages/postgres-provider/src/serving-gateways.ts';
import { PostgresRequestRuntimeViewService } from './packages/postgres-provider/src/request-runtime-view-service.ts';
const {databaseUrl,identity,recordId}=JSON.parse(await readFile(process.argv[2],'utf8'));
const pool=rolePool(databaseUrl,'north_star_runtime',2);
try {
  const loader=new PostgresRequestRuntimeViewService(pool), context=await trustedContext(identity);
  const definition=await loader.load(context);
  const serving=await loadServingRelease(pool,context,definition.release.releaseId);
  const {policy,queryGateway}=composeServingGateways(pool,pool,context,serving,new ObservabilityMetrics(),{providerErrorMappings:[],writeInvariants:[]});
  const entry=new AuthenticatedRequestRuntimeEntryAdapter(new AuthenticatedRequestEntryAdapter(async()=>identity),loader,policy);
  const dto=await entry.run({},view=>queryGateway.invoke(view,{schemaVersion:SEMANTIC_QUERY_REQUEST_VERSION,queryId:'northstar.app:query.item_get',arguments:{recordId}}));
  console.log(JSON.stringify({outcome:dto.outcome,id:dto.records[0]?.recordId}));
} catch(error){console.log(JSON.stringify({outcome:'refused',code:error.code,message:error.message}));}
finally {await pool.end();}
`;
test(
  'the preceding serving binary answers an item query and refuses each new booking protocol by reader name',
  { skip: !process.env.CI },
  async () => {
    await withArchivedCustomizationRuntime(
      '0a9f7ca52304969c65092893f50375c90f8c2265',
      async (run) => {
        for (const mode of ['baseline', 'operation', 'query'] as const) {
          await withBookingApplication(
            mode === 'baseline'
              ? applicationBeforeStockCountWorkflow().release
              : bookingRelease(mode),
            async (f) => {
              const probe = (await run(archivedQuery, {
                databaseUrl: f.databaseUrl,
                identity: f.app.runtime.identity,
                recordId: demoItem,
              })) as {
                outcome: string;
                code?: string;
                message?: string;
                id?: string;
              };
              if (mode === 'baseline')
                assert.deepEqual(probe, { outcome: 'exact', id: demoItem });
              else {
                assert.equal(
                  probe.code,
                  'UNSUPPORTED_RUNTIME_CAPABILITY',
                  JSON.stringify(probe),
                );
                assert.match(
                  probe.message ?? '',
                  mode === 'operation'
                    ? /operation-catalog requires version 6/u
                    : /query-catalog requires version 5/u,
                );
              }
            },
          );
        }
      },
    );
  },
);

test('the serving booking query reads a saved owner at cursor zero through its released evidence permission', async () => {
  await withBookingApplication(bookingRelease('query'), async (f) => {
    const result = await f.app.runtime.entry.run(
      { headers: { cookie: 'northstar-demo-actor=buyer' } },
      (view) =>
        f.app.runtime.queryGateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: usageQuery,
          arguments: {
            recordId: demoItem,
            usage: {
              from: '2030-02-10T00:00:00Z',
              until: '2030-02-20T00:00:00Z',
            },
          },
        }),
    );
    assert.equal(result.kind, 'semanticQueryResult');
    assert.equal(result.outcome, 'exact');
    assert.deepEqual(
      (
        result.records[0]!.values[usageField] as {
          cursor: string;
          bookings: unknown[];
        }
      ).cursor,
      '0',
    );
  });
});
