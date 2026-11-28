import { DOCUMENT_POSTING_OPERATION_READER } from '../../packages/canonical-model/src/document-posting.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import { withArchivedCustomizationRuntime } from '../helpers/archived-runtime-process.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

// CUSTOMIZE-6 slice 2 on a running server: a tenant work order whose lines
// hold hours in h, a rate in the work order's own currency, a fixed CAD fee
// and notes. Its record page shows each line amount in its header's code and
// only the viewer's company's lines in one tenant; a line currency outside
// its codes is refused on write; and the preceding serving binary (rung 50)
// answers, reproduces slice-1 bytes, and refuses the line change by name,
// fed the change as recorded.

const ns = 'northstar.app';
/** origin/main 8014e43f1 (TRAIN-R, before TRAIN-S): the preceding serving binary, reader 50. */
const preceding = '8014e43f1524ad834afd9235203227a9c9b19140';
const h = (local: string) => `${ns}:field.custom_work_order_${local}`;
const l = (local: string) => `${ns}:field.custom_work_order_lines_${local}`;

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

const orderType = {
  kind: 'addRecordType',
  label: 'Work order',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Name', type: 'text', required: true },
    { label: 'Currency', type: 'currency' },
    {
      label: 'Deposit',
      type: 'money',
      currency: { kind: 'fixed', code: 'CAD' },
    },
  ],
};
const lineTable = {
  kind: 'addLineTable',
  entity: `${ns}:entity.custom_work_order`,
  label: 'Lines',
  fields: [
    { label: 'Task', type: 'text' },
    { label: 'Hours', type: 'quantity', scale: 2, unit: 'h' },
    {
      label: 'Rate',
      type: 'money',
      currency: { kind: 'stored', fieldLabel: 'Currency' },
    },
    { label: 'Fee', type: 'money', currency: { kind: 'fixed', code: 'CAD' } },
    { label: 'Notes', type: 'longText' },
    { label: 'Line currency', type: 'currency' },
  ],
};

test(
  'line money in its header currency, quantities and notes serve per company, refuse unlisted codes, and the preceding reader refuses the line change by name',
  { timeout: 900_000 },
  async () => {
    await withEphemeralPostgres(
      'line-logical-fields',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'line-logical-fields',
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
          const readInput = {
            databaseUrl: options.databaseUrl,
            identity: app.runtime.identity,
          };
          await withArchivedCustomizationRuntime(preceding, async (run) => {
            // DOCUMENT-POSTING: every composed release now carries operation
            // reader 10, so the preceding binary cannot answer on, or compile,
            // the current first-party base; that half is owed in
            // FIRST-TENANT-OWED.md (older-reader "answers" proofs, 2026-11-28).
            await activate(orderType);
            await activate(lineTable);
            const refused = await run(archivedQuery, readInput);
            assert.deepEqual(refused, {
              outcome: 'refused',
              phase: 'load',
              code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
              message: `runtime capability northstar.runtime:capability.operation-catalog requires version ${DOCUMENT_POSTING_OPERATION_READER} and this runtime supports 7`,
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
          const createOrder = async (company: string, name: string) => {
            const created = await world.invoke('custom_work_order_create', {
              recordId: randomUUID(),
              legalEntityId: company,
              values: {
                [h('name')]: name,
                [h('currency')]: 'USD',
                [h('deposit')]: '50',
              },
            });
            assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
            return created.readBack!.recordId;
          };
          const createLine = (
            company: string,
            parent: string,
            values: Record<string, string>,
          ) =>
            world.invoke('custom_work_order_lines_create', {
              recordId: randomUUID(),
              legalEntityId: company,
              values: {
                [l('line_number')]: String(values.number ?? '1'),
                [l('task')]: values.task ?? 'Task',
                ...(values.rate ? { [l('rate')]: values.rate } : {}),
                ...(values.hours ? { [l('hours')]: values.hours } : {}),
                ...(values.fee ? { [l('fee')]: values.fee } : {}),
                ...(values.notes ? { [l('notes')]: values.notes } : {}),
                ...(values.code ? { [l('line_currency')]: values.code } : {}),
              },
              relations: {
                [`${ns}:relation.custom_work_order_lines_parent`]: parent,
              },
            });
          const north = await createOrder(COMPANY, 'North repair');
          for (const line of [
            {
              number: '1',
              task: 'Inspect',
              rate: '1250',
              hours: '1.5',
              fee: '10',
            },
            {
              number: '2',
              task: 'Repair',
              rate: '95.5',
              hours: '2',
              notes: 'Bring\nparts.',
            },
          ]) {
            const created = await createLine(COMPANY, north, line);
            assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
          }
          const southern = await createOrder(south, 'South repair');
          const southLine = await createLine(south, southern, {
            task: 'Southern sentinel',
            rate: '9999',
          });
          assert.equal(
            southLine.outcome,
            'succeeded',
            JSON.stringify(southLine),
          );

          // A line currency outside its codes is refused on write.
          for (const code of ['GBP', 'usd']) {
            const refusedWrite = await createLine(COMPANY, north, {
              number: '9',
              task: `Refused ${code}`,
              code,
            }).then(
              (result) => JSON.stringify(result),
              (error: Error & { code?: string }) =>
                `${String(error.code)} ${error.message}`,
            );
            assert.doesNotMatch(refusedWrite, /"outcome":"succeeded"/u, code);
            assert.match(
              refusedWrite,
              /MODULE_FIELD_VALUE_NOT_ALLOWED Choose CAD, USD or EUR\./u,
              code,
            );
          }

          // Narrow every principal of this tenant and environment to North,
          // so from here the company check alone refuses South (MIGRATION-RULE
          // finding 2: two companies in one tenant, a company-scoped principal).
          const { tenantId, environmentId } = app.runtime.identity;
          const narrowed = await pool.query(
            'UPDATE platform.current_policy_memberships SET legal_entity_id=$3 WHERE (tenant_id,environment_id)=($1,$2) AND legal_entity_id IS NULL AND revoked_at IS NULL',
            [tenantId, environmentId, COMPANY],
          );
          assert.ok(narrowed.rowCount);

          // Writing: the North principal still adds a line to North's order,
          // and cannot add one to South's, whichever company it names, so no
          // North line ever reads South's currency.
          const northLine = await createLine(COMPANY, north, {
            number: '3',
            task: 'Narrowed North line',
            rate: '10',
          });
          assert.equal(
            northLine.outcome,
            'succeeded',
            JSON.stringify(northLine),
          );
          // Naming South, the company policy refuses; naming North under
          // South's order, the parent relation contract refuses.
          for (const [company, code] of [
            [south, 'SEMANTIC_OPERATION_POLICY_DENIED'],
            [COMPANY, 'MODULE_RELATION_VIOLATION'],
          ] as const) {
            const crossedWrite = await createLine(company, southern, {
              number: '4',
              task: 'Crossed line',
              rate: '1',
            }).then(
              (result) => JSON.stringify(result),
              (error: Error & { code?: string }) =>
                `${String(error.code)} ${error.message}`,
            );
            assert.match(
              crossedWrite,
              new RegExp(`^${code} `, 'u'),
              `a North line was written under South's order (${company})`,
            );
          }

          // Reading: the work order's page lists its lines with the header's
          // code, and only North's.
          const page = async (company: string, recordId: string) => {
            const url = new URL('/', app.baseUrl);
            url.searchParams.set(
              'surface',
              `${ns}:surface.custom_work_order_detail`,
            );
            url.searchParams.set('record', recordId);
            url.searchParams.set(
              `${ns}:parameter.custom_work_order_get_legal_entity_scope`,
              company,
            );
            const response = await fetch(url, {
              headers: { cookie: 'northstar-demo-actor=manager' },
            });
            return { status: response.status, html: await response.text() };
          };
          const shown = await page(COMPANY, north);
          assert.equal(shown.status, 200, shown.html.slice(0, 600));
          assert.match(
            shown.html,
            />1,250\.00 USD</u,
            "a line amount lost its header's currency",
          );
          assert.match(shown.html, />95\.50 USD</u);
          assert.match(shown.html, />10\.00 CAD</u);
          assert.match(shown.html, />1\.5 h</u);
          assert.doesNotMatch(shown.html, /Southern sentinel/u);
          assert.doesNotMatch(shown.html, /9,999\.00/u);
          // The document editor on North's order: each line rate's suffix is
          // the header's code, and the header currency re-renders the lines.
          const editorUrl = new URL('/', app.baseUrl);
          editorUrl.searchParams.set(
            'surface',
            `${ns}:surface.custom_work_order_form`,
          );
          editorUrl.searchParams.set('record', north);
          editorUrl.searchParams.set(
            `${ns}:parameter.custom_work_order_get_legal_entity_scope`,
            COMPANY,
          );
          const editor = await fetch(editorUrl, {
            headers: { cookie: 'northstar-demo-actor=manager' },
          });
          const editorHtml = await editor.text();
          assert.equal(editor.status, 200, editorHtml.slice(0, 600));
          // Header fields carry no USD suffix (the deposit is fixed CAD) and
          // the fee is fixed CAD, so each USD suffix is a line rate's.
          // Three North lines carry a rate.
          const usd = editorHtml.match(/data-field-unit>USD<\/span>/gu) ?? [];
          assert.ok(
            usd.length >= 3,
            `the editor's line rates lost their header's currency (${String(usd.length)} USD suffixes)`,
          );
          assert.doesNotMatch(editorHtml, /\(header currency\)/u);
          // Only the header currency is a line source on this type.
          assert.match(
            editorHtml,
            /data-line-source/u,
            'the header currency is not a line source in the editor',
          );

          // The narrowed North principal asking for South's order in South's
          // own scope sees none of its lines.
          const crossed = await page(south, southern);
          assert.notEqual(crossed.status, 200, crossed.html.slice(0, 600));
          assert.doesNotMatch(crossed.html, /Southern sentinel/u);
          assert.doesNotMatch(crossed.html, /9,999\.00/u);
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
