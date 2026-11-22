import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { PRESENTATION_READER } from '../../packages/canonical-model/src/surface-presentation-schema.js';
import { presentationMember } from '../../packages/customization/src/presentation-revision.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import { withArchivedCustomizationRuntime } from '../helpers/archived-runtime-process.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

// UI-CUSTOM-1 slice 1 on a running server: a cell tone and a whole-row tone
// follow a between-field comparison (on hand below reorder point), change when
// the value changes, show only the viewer's company's rows in one tenant, and
// the preceding serving binary answers before the rule and refuses it by name.

const ns = 'northstar.app';
/** origin/main at the branch point: the preceding serving binary, reader 44. */
const preceding = '37bfd47311c58060000cebca49d5f55174e3874a';
const field = (local: string) => `${ns}:field.custom_stock_item_${local}`;
const list = `${ns}:surface.custom_stock_item_list`;

const archivedQuery = `
import { readFile } from 'node:fs/promises';
import { CAPABILITY_EXECUTOR_FACTORIES } from './apps/api/src/erp-capabilities.ts';
import { ObservabilityMetrics } from './packages/observability/src/index.ts';
import { rolePool, trustedContext } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { composeServingGateways, loadServingRelease } from './packages/postgres-provider/src/serving-gateways.ts';
import { PostgresRequestRuntimeViewService } from './packages/postgres-provider/src/request-runtime-view-service.ts';
import { AuthenticatedRequestEntryAdapter } from './packages/runtime/src/request-context.ts';
import { AuthenticatedRequestRuntimeEntryAdapter } from './packages/runtime/src/request-runtime-view.ts';
import { SEMANTIC_QUERY_REQUEST_VERSION } from './packages/runtime/src/semantic-query-gateway.ts';
const {databaseUrl,identity}=JSON.parse(await readFile(process.argv[2],'utf8'));
const pool=rolePool(databaseUrl,'north_star_runtime',4);
let phase='load';
try {
  const loader=new PostgresRequestRuntimeViewService(pool);
  const context=await trustedContext(identity);
  const {release}=await loader.load(context);
  phase='query';
  const serving=await loadServingRelease(pool,context,release.releaseId);
  const {policy,queryGateway}=composeServingGateways(pool,pool,context,serving,new ObservabilityMetrics(),{
    providerErrorMappings:[],capabilityOperationExecutorFactories:CAPABILITY_EXECUTOR_FACTORIES,localDemoIdentity:true,
  });
  const entry=new AuthenticatedRequestRuntimeEntryAdapter(new AuthenticatedRequestEntryAdapter(async()=>identity),loader,policy);
  const result=await entry.run({},view=>queryGateway.invoke(view,{schemaVersion:SEMANTIC_QUERY_REQUEST_VERSION,queryId:'northstar.app:query.legal_entity_list',arguments:{}}));
  console.log(JSON.stringify({outcome:'answered', ids:result.records.map(r=>r.recordId)}));
} catch(error) {
  console.log(JSON.stringify({outcome:'refused',phase,code:error.code,message:error.message}));
} finally { await pool.end(); }
`;

test(
  'a declared low-stock rule tones the cell and the row on the served list, follows the value, and the preceding reader refuses it by name',
  { timeout: 900_000 },
  async () => {
    await withEphemeralPostgres(
      'presentation-list',
      async ({ connection }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'presentation-list',
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const activate = async (change: unknown) => {
            const drafted = await opened.service.draft(change, 'visualBuilder');
            assert.ok(drafted.status === 'drafted', JSON.stringify(drafted));
            await opened.service.approve(drafted.patchId);
            await opened.service.activate(drafted.patchId);
          };
          await activate({
            kind: 'addRecordType',
            label: 'Stock item',
            companyOwnership: 'entityOwned',
            fields: [
              { label: 'Name', type: 'text', required: true },
              { label: 'On hand', type: 'number' },
              { label: 'Reorder point', type: 'number' },
            ],
          });
          const readInput = {
            databaseUrl: options.databaseUrl,
            identity: app.runtime.identity,
          };
          await withArchivedCustomizationRuntime(preceding, async (run) => {
            const control = (await run(archivedQuery, readInput)) as {
              outcome: string;
              ids?: string[];
            };
            assert.equal(control.outcome, 'answered', JSON.stringify(control));
            assert.ok((control.ids ?? []).length > 0);

            const target = (await opened.service.targets()).presentation!;
            await activate(
              presentationMember(target, {
                kind: 'addPresentationRevision',
                surface: list,
                tones: [
                  {
                    target: 'cell',
                    fieldId: field('on_hand'),
                    operator: 'lessThan',
                    compareTo: { fieldId: field('reorder_point') },
                    tone: 'blocked',
                    reason: 'Low stock',
                  },
                  {
                    target: 'row',
                    fieldId: field('on_hand'),
                    operator: 'lessThan',
                    compareTo: { fieldId: field('reorder_point') },
                    tone: 'attention',
                    reason: 'Reorder',
                  },
                ],
                columns: [{ fieldId: field('name'), width: 'wide' }],
                density: 'comfortable',
              }),
            );
            const refused = await run(archivedQuery, readInput);
            assert.deepEqual(refused, {
              outcome: 'refused',
              phase: 'load',
              code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
              message: `runtime capability northstar.runtime:capability.surface-manifest requires version ${String(PRESENTATION_READER)} and this runtime supports 44`,
            });
          });

          // Two companies in the SAME tenant and environment.
          const world = worldOver(app.runtime, String(connection.database));
          const south = randomUUID();
          const southCreated = await world.invoke('legal_entity_create', {
            recordId: south,
            values: {
              [`${ns}:field.legal_entity_code`]: 'SOUTH',
              [`${ns}:field.legal_entity_name`]: 'South',
              [`${ns}:field.legal_entity_status`]: `${ns}:option.legal_entity_status_active`,
              [`${ns}:field.legal_entity_is_default`]: false,
            },
          });
          assert.equal(southCreated.outcome, 'succeeded');
          const create = async (
            company: string,
            name: string,
            onHand: string,
          ) => {
            const created = await world.invoke('custom_stock_item_create', {
              recordId: randomUUID(),
              legalEntityId: company,
              values: {
                [field('name')]: name,
                [field('on_hand')]: onHand,
                [field('reorder_point')]: '5',
              },
            });
            assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
            return created.readBack!;
          };
          const low = await create(COMPANY, 'Bolt', '2');
          const fine = await create(COMPANY, 'Nut', '9');
          const southLow = await create(south, 'Southern washer', '1');

          const page = async () => {
            const url = new URL(app.baseUrl);
            url.searchParams.set('surface', list);
            url.searchParams.set(
              `${ns}:parameter.custom_stock_item_list_legal_entity_scope`,
              COMPANY,
            );
            const response = await fetch(url, { redirect: 'manual' });
            const html = await response.text();
            assert.equal(response.status, 200, html.slice(0, 400));
            const row = (recordId: string) =>
              new RegExp(
                `<tr data-compact-card="true"([^>]*) data-record-id="${recordId}">([\\s\\S]*?)</tr>`,
                'u',
              ).exec(html);
            return { html, row };
          };
          const first = await page();
          const lowRow = first.row(low.recordId);
          assert.ok(lowRow, 'the low item is listed');
          assert.match(
            lowRow[1]!,
            /data-row-tone="attention" data-tone-rule="northstar\.app:tone\.custom_reorder"/u,
          );
          assert.match(
            lowRow[2]!,
            /<span class="status-pill" data-status-role="blocked" data-tone-rule="northstar\.app:tone\.custom_low_stock">Low stock<\/span>/u,
          );
          assert.match(
            lowRow[2]!,
            /<span class="status-pill" data-status-role="attention" data-tone-rule="northstar\.app:tone\.custom_reorder">Reorder<\/span>/u,
          );
          const fineRow = first.row(fine.recordId);
          assert.ok(fineRow);
          assert.equal(fineRow[1], '');
          assert.doesNotMatch(fineRow[2]!, /data-tone-rule/u);
          // South's row, low too, is never read for North: no row, no tone.
          assert.equal(first.row(southLow.recordId), null);
          assert.doesNotMatch(first.html, /Southern washer/u);
          assert.match(first.html, /data-density="comfortable"/u);
          assert.match(
            first.html,
            /data-column-width="wide" data-column-overflow="wrap"/u,
          );

          // The tone follows the value.
          const raised = await world.invoke('custom_stock_item_update', {
            recordId: low.recordId,
            expectedRevision: low.revision,
            patch: { [field('on_hand')]: '12' },
          });
          assert.equal(raised.outcome, 'succeeded', JSON.stringify(raised));
          const second = (await page()).row(low.recordId);
          assert.ok(second);
          assert.equal(second[1], '');
          assert.doesNotMatch(second[2]!, /data-tone-rule/u);
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
