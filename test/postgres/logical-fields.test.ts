import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { LOGICAL_FIELD_READER } from '../../packages/canonical-model/src/logical-field.js';
import { ReportChoicesSchema } from '../../packages/canonical-model/src/schemas.js';
import { reportQueryId } from '../../packages/canonical-model/src/declared-report.js';
import { draftReport } from '../../packages/customization/src/report-revision.js';
import {
  compileInSandbox,
  CustomizationPatchSchema,
  preparePatchForRecording,
  type SerializedRelease,
} from '../../packages/customization/src/index.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { withArchivedCustomizationRuntime } from '../helpers/archived-runtime-process.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

// CUSTOMIZE-6 slice 1 on a running server: a tenant record type with money
// (fixed and stored currency), a quantity in kg and long notes lists each
// value with its currency or unit, shows only the viewer's company's rows in
// one tenant, sums stored-currency money per currency for a company-scoped
// principal, and the preceding serving binary answers before the change and
// refuses it by name, fed the change as recorded.

const ns = 'northstar.app';
/** origin/main d8aad66b3 (TRAIN-L): the preceding serving binary, reader 47. */
const preceding = 'd8aad66b3e6ee6231b0580f2702c26d116f5a68c';
const field = (local: string) => `${ns}:field.custom_shipment_${local}`;
const list = `${ns}:surface.custom_shipment_list`;

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

const archivedCompile = `
import { readFile } from 'node:fs/promises';
import { readUnboundPermissionAcknowledgementFor } from './apps/web/scripts/unbound-permission-acknowledgement.ts';
import { parseCompiledApplication } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { compileInSandbox, serializeRelease } from './packages/customization/src/index.ts';
const path = 'apps/web/release/app.authored.json';
const request = {
  acknowledgement: readUnboundPermissionAcknowledgementFor(path,'northstar.app:package.application'),
  base: JSON.parse(await readFile(path,'utf8')), chain: JSON.parse(await readFile(process.argv[2],'utf8')),
  tip: serializeRelease(((parsed) => parsed.applications?.at(-1) ?? parsed.application)(parseCompiledApplication(JSON.parse(await readFile('apps/web/release/app.compiled.json','utf8'))))),
};
const result = await compileInSandbox(request);
if (result.status !== 'compiled') throw new Error(JSON.stringify(result));
console.log(JSON.stringify({request,releases:result.steps.map(s => s.release)}));
`;

const shipmentType = {
  kind: 'addRecordType',
  label: 'Shipment',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Name', type: 'text', required: true },
    { label: 'Weight', type: 'quantity', scale: 3, unit: 'kg' },
    { label: 'Currency', type: 'currency' },
    {
      label: 'Freight',
      type: 'money',
      currency: { kind: 'stored', fieldLabel: 'Currency' },
    },
    {
      label: 'Deposit',
      type: 'money',
      currency: { kind: 'fixed', code: 'CAD' },
    },
    { label: 'Notes', type: 'longText' },
  ],
};

test(
  'tenant money, quantity and long text serve with currency and unit per company, sum per currency, and the preceding reader refuses them by name',
  { timeout: 900_000 },
  async () => {
    await withEphemeralPostgres(
      'logical-fields',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'logical-fields',
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
            const control = (await run(archivedQuery, readInput)) as {
              outcome: string;
              ids?: string[];
            };
            assert.equal(control.outcome, 'answered', JSON.stringify(control));
            assert.ok((control.ids ?? []).length > 0);

            // Feature-absent releases reproduce byte for byte (rule 13), fed
            // the chain AS RECORDED by the Customize service.
            const chain = [
              {
                kind: 'addRecordType',
                label: 'Spare part',
                companyOwnership: 'entityOwned',
                fields: [
                  { label: 'Name', type: 'text', required: true },
                  { label: 'On hand', type: 'number' },
                ],
              },
            ].map((change) =>
              preparePatchForRecording(CustomizationPatchSchema.parse(change)),
            );
            const historical = (await run(archivedCompile, chain)) as {
              request: Parameters<typeof compileInSandbox>[0];
              releases: SerializedRelease[];
            };
            const current = await compileInSandbox(historical.request);
            assert.ok(current.status === 'compiled', JSON.stringify(current));
            assert.equal(current.steps.length, historical.releases.length);
            for (const [index, step] of current.steps.entries())
              assert.deepEqual(step.release, historical.releases[index]);

            await activate(shipmentType);
            const refused = await run(archivedQuery, readInput);
            assert.deepEqual(refused, {
              outcome: 'refused',
              phase: 'load',
              code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
              message: `runtime capability northstar.runtime:capability.surface-manifest requires version ${String(LOGICAL_FIELD_READER)} and this runtime supports 47`,
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
            currency: string,
            freight: string,
          ) => {
            const created = await world.invoke('custom_shipment_create', {
              recordId: randomUUID(),
              legalEntityId: company,
              values: {
                [field('name')]: name,
                [field('weight')]: '12.5',
                [field('currency')]: currency,
                [field('freight')]: freight,
                [field('deposit')]: '1250',
                [field('notes')]: 'Fragile.\nKeep upright.',
              },
            });
            assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
            return created.readBack!;
          };
          const cad = await create(COMPANY, 'Bolts', 'CAD', '100.1');
          await create(COMPANY, 'Nuts', 'CAD', '0.9');
          await create(COMPANY, 'Washers', 'USD', '40');
          const southern = await create(
            south,
            'Southern pallets',
            'CAD',
            '900',
          );
          // An unlisted or lower-case code is refused on write by the
          // currency field's own rule, never summed as "No currency".
          for (const code of ['GBP', 'cad']) {
            const refusedWrite = await world
              .invoke('custom_shipment_create', {
                recordId: randomUUID(),
                legalEntityId: COMPANY,
                values: {
                  [field('name')]: `Refused ${code}`,
                  [field('currency')]: code,
                  [field('freight')]: '5',
                },
              })
              .then(
                (result) => JSON.stringify(result),
                (error: Error & { code?: string }) =>
                  `${String(error.code)} ${error.message}`,
              );
            assert.doesNotMatch(refusedWrite, /"outcome":"succeeded"/u, code);
            assert.match(
              refusedWrite,
              /MODULE_VALIDATION_REFUSED Choose CAD, USD or EUR/u,
              code,
            );
          }

          // The record form posts money and quantities as people type them
          // and keeps a note's leading blank line, with CRLF as one break.
          const formUrl = new URL(app.baseUrl);
          formUrl.searchParams.set(
            'surface',
            `${ns}:surface.custom_shipment_form`,
          );
          formUrl.searchParams.set(
            `${ns}:parameter.custom_shipment_get_legal_entity_scope`,
            COMPANY,
          );
          const headers = {
            cookie: 'northstar-demo-actor=manager',
            origin: formUrl.origin,
          };
          const formPage = await (await fetch(formUrl, { headers })).text();
          const formMatch =
            /<form id="surface-record-form" method="post" action="([^"]*)">([\s\S]*?)<\/form>/u.exec(
              formPage,
            );
          assert.ok(formMatch, formPage.slice(0, 1500));
          const body = new URLSearchParams();
          for (const [input] of formMatch[2]!.matchAll(/<input\b[^>]*>/gu)) {
            const name = /\bname="([^"]+)"/u.exec(input)?.[1];
            if (name)
              body.set(name, /\bvalue="([^"]*)"/u.exec(input)?.[1] ?? '');
          }
          for (const [, name, options] of formMatch[2]!.matchAll(
            /<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gu,
          )) {
            const chosen =
              /<option value="([^"]*)" selected>/u.exec(options!) ??
              /<option value="([^"]*)"/u.exec(options!);
            if (chosen) body.set(name!, chosen[1]!);
          }
          assert.match(
            formMatch[2]!,
            /<textarea[^>]*maxlength="4000"[^>]*>\n<\/textarea>/u,
          );
          body.set(`value:${field('name')}`, 'Typed');
          body.set(`value:${field('weight')}`, '12.500');
          body.set(`value:${field('currency')}`, 'USD');
          body.set(`value:${field('freight')}`, '19.90');
          body.set(`value:${field('deposit')}`, '1250.00');
          body.set(`value:${field('notes')}`, '\r\nFirst\r\nSecond');
          const posted = await fetch(
            new URL(formMatch[1]!.replaceAll('&amp;', '&'), formUrl),
            { method: 'POST', headers, body },
          );
          const postedHtml = await posted.text();
          assert.equal(posted.status, 200, postedHtml.slice(-1500));
          const typedId = body.get('recordId')!;
          const typed = await app.runtime.entry.run(
            { headers },
            async (view) =>
              (
                await app.runtime.queryGateway.invoke(view, {
                  schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                  queryId: `${ns}:query.custom_shipment_get`,
                  arguments: {
                    recordId: typedId,
                    [`${ns}:parameter.custom_shipment_get_legal_entity_scope`]:
                      COMPANY,
                  },
                })
              ).records[0]!,
          );
          // Read back at the field scale; the post itself was refused before.
          assert.match(String(typed.values[field('weight')]), /^12\.50*$/u);
          assert.match(String(typed.values[field('freight')]), /^19\.90*$/u);
          assert.match(
            String(typed.values[field('deposit')]),
            /^1250(?:\.0+)?$/u,
          );
          assert.equal(typed.values[field('notes')], '\nFirst\nSecond');

          const url = new URL(app.baseUrl);
          url.searchParams.set('surface', list);
          url.searchParams.set(
            `${ns}:parameter.custom_shipment_list_legal_entity_scope`,
            COMPANY,
          );
          const response = await fetch(url, { redirect: 'manual' });
          const html = await response.text();
          assert.equal(response.status, 200, html.slice(0, 400));
          const row = new RegExp(
            `data-record-id="${cad.recordId}">([\\s\\S]*?)</tr>`,
            'u',
          ).exec(html);
          assert.ok(row, 'the CAD shipment is listed');
          assert.match(row[1]!, />1,250\.00 CAD</u);
          assert.match(row[1]!, />100\.10 CAD</u);
          assert.match(row[1]!, />12\.5 kg</u);
          assert.doesNotMatch(html, /Southern pallets/u);
          assert.doesNotMatch(html, new RegExp(southern.recordId, 'u'));

          // A company-scoped principal sums stored-currency money per
          // currency, and only its own company's records.
          const target = (await opened.service.targets()).reports!.find((t) =>
            t.source.entityId.endsWith(':entity.custom_shipment'),
          )!;
          assert.ok(target, 'the shipment type is a report source');
          const revision = draftReport(
            target,
            'Freight by name',
            ReportChoicesSchema.parse({
              dimensions: [{ kind: 'direct', fieldId: field('name') }],
              filters: [],
              measures: [
                {
                  kind: 'inline',
                  operator: { kind: 'sum', fieldId: field('freight') },
                  measureId: 'northstar.app:measure.custom_freight',
                  label: 'Freight',
                },
              ],
              outputs: [{ kind: 'table' }],
            }),
          );
          await activate(revision);
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const membership = await pool.query(
            'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE (tenant_id,environment_id,principal_id)=($1,$2,$3) AND legal_entity_id IS NULL',
            [tenantId, environmentId, principalId, COMPANY],
          );
          assert.ok(membership.rowCount);
          const sum = (company: string) =>
            app.runtime.entry.run({}, (view) =>
              app.runtime.queryGateway.invokeGrouped(view, {
                queryId: reportQueryId(revision.reportId),
                company,
                parameters: {},
                pageSize: 10,
              }),
            );
          const page = await sum(COMPANY);
          assert.ok(page.kind === 'page', JSON.stringify(page));
          assert.deepEqual(
            page.totals.map((t) => [t.partition, t.cells[0]!.value]),
            [
              [{ kind: 'currency', code: 'CAD' }, '101.00'],
              [{ kind: 'currency', code: 'USD' }, '59.90'],
            ],
          );
          // The company check alone refuses South for the North principal.
          assert.deepEqual(await sum(south), { kind: 'unavailable' });
          // And the North principal's list for South shows none of South's rows.
          const southUrl = new URL(app.baseUrl);
          southUrl.searchParams.set('surface', list);
          southUrl.searchParams.set(
            `${ns}:parameter.custom_shipment_list_legal_entity_scope`,
            south,
          );
          const southHtml = await (await fetch(southUrl)).text();
          assert.doesNotMatch(southHtml, /Southern pallets/u);
          assert.doesNotMatch(southHtml, new RegExp(southern.recordId, 'u'));
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
