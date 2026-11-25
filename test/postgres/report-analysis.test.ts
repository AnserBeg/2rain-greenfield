import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/storage.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import { CAPABILITY_EXECUTOR_FACTORIES } from '../../apps/api/src/erp-capabilities.js';
import {
  composeServingGateways,
  loadServingRelease,
} from '../../packages/postgres-provider/src/serving-gateways.js';
import {
  rolePool,
  trustedContext,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import type { ReportRequest } from '../../packages/runtime/src/declared-report.js';
import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  DEFAULT_AGE_BANDS,
  ReportChoicesSchema,
  evaluateReportFacts,
  type GroupedRow,
} from '../../packages/canonical-model/src/index.js';
import {
  reportColumnPermission,
  reportQueryId,
} from '../../packages/canonical-model/src/declared-report.js';
import {
  REPORT_ANALYSIS_READER,
  REPORT_MEASURE_READER,
} from '../../packages/canonical-model/src/declared-report-v2.js';
import {
  draftReport,
  reportSurfaceId,
  type ReportTarget,
} from '../../packages/customization/src/report-revision.js';
import { draftMeasure } from '../../packages/customization/src/measure-revision.js';
import type { CustomizationPatch } from '../../packages/customization/src/index.js';
import {
  reportsAnalysisPredecessor,
  withArchivedCustomizationRuntime,
} from '../helpers/archived-runtime-process.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';
import {
  AGING_AS_OF,
  AGING_DUE_DATES,
  reportAnalysisTypes,
} from '../helpers/report-analysis-fixture.js';

// The preceding serving binary answers a governed query, so "loaded" is not
// mistaken for "can serve" (catalogs parse lazily; MIGRATION-RULE rule 13).
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
    providerErrorMappings:[],writeInvariants:[],capabilityOperationExecutorFactories:CAPABILITY_EXECUTOR_FACTORIES,localDemoIdentity:true,
  });
  const entry=new AuthenticatedRequestRuntimeEntryAdapter(new AuthenticatedRequestEntryAdapter(async()=>identity),loader,policy);
  const result=await entry.run({},view=>queryGateway.invoke(view,{schemaVersion:SEMANTIC_QUERY_REQUEST_VERSION,queryId:'northstar.app:query.legal_entity_list',arguments:{}}));
  console.log(JSON.stringify({outcome:'answered', count:result.records.length}));
} catch(error) {
  console.log(JSON.stringify({outcome:'refused',phase,code:error.code,message:error.message}));
} finally { await pool.end(); }
`;

const NS = 'northstar.app';
const started = performance.now();
// Stage marks on stderr locate a slow or stuck step under a loaded runner.
const stage = (name: string) =>
  process.stderr.write(
    `report-analysis stage ${name} at ${Math.round((performance.now() - started) / 1000)}s\n`,
  );
const cells = (rows: readonly GroupedRow[]) =>
  rows.map((r) => [r.keys, r.cells.map((c) => c.value)]);

test(
  'REPORTS-1 s2: North ages invoices, groups by a linked Site, counts lines and distinct parents, trials a measure, and never sees South',
  { timeout: 2_400_000 },
  async () => {
    const { firstPartyAuthored } =
      await import('../helpers/customization-fixture.js');
    const { singleTransitionApplication } =
      await import('../helpers/application-before-stock-count-workflow.js');
    const compiledApplication =
      singleTransitionApplication(firstPartyAuthored).release;
    const { COMPANY, worldOver } = await import('../agent/agent-world.js');
    await withEphemeralPostgres(
      'report-analysis',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://postgres@127.0.0.1:${connection.port}/postgres`,
          tenantSlug: 'report-analysis',
          compiledApplication,
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        const reader = rolePool(options.databaseUrl, 'north_star_runtime', 4);
        try {
          const publish = async (patch: CustomizationPatch) => {
            const draft = await opened.service.draft(patch, 'visualBuilder');
            assert.ok(draft.status === 'drafted', JSON.stringify(draft));
            await opened.service.approve(draft.patchId);
            await opened.service.activate(draft.patchId);
            return draft;
          };
          const targets = async () => (await opened.service.targets()).reports!;
          const targetOf = (all: readonly ReportTarget[], query: string) =>
            all.find((t) => t.source.queryId === `${NS}:query.${query}`)!;
          const world = worldOver(app.runtime, 'postgres');
          const north = COMPANY;
          const south = randomUUID();
          await world.invoke('legal_entity_create', {
            recordId: south,
            values: {
              [`${NS}:field.legal_entity_code`]: 'SOUTH',
              [`${NS}:field.legal_entity_name`]: 'South',
              [`${NS}:field.legal_entity_status`]: `${NS}:option.legal_entity_status_active`,
              [`${NS}:field.legal_entity_is_default`]: false,
            },
          });

          // ---- Releases. The preceding serving binary answers first, then
          // refuses each new capability by name, fed the RECORDED change.
          let typesDraft!: { releaseId: string };
          let reportsDraft!: { releaseId: string; patchId: string };
          let trialDraft!: { releaseId: string };
          let aging!: ReturnType<typeof draftReport>;
          let byRegion!: ReturnType<typeof draftReport>;
          let lineReport!: ReturnType<typeof draftReport>;
          let trial!: ReturnType<typeof draftMeasure>;
          await withArchivedCustomizationRuntime(
            reportsAnalysisPredecessor,
            async (run) => {
              const older = () =>
                run(archivedQuery, {
                  databaseUrl: options.databaseUrl,
                  identity: app.runtime.identity,
                });
              const refusal = (minimumVersion: number) => ({
                outcome: 'refused',
                phase: 'load',
                code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
                message:
                  'runtime capability northstar.runtime:capability.surface-manifest requires version ' +
                  minimumVersion +
                  ' and this runtime supports 47',
              });
              assert.equal(
                ((await older()) as { outcome: string }).outcome,
                'answered',
              );
              stage('publish');
              typesDraft = await publish(reportAnalysisTypes);
              assert.equal(
                ((await older()) as { outcome: string }).outcome,
                'answered',
                'tenant types alone stay readable by the preceding binary',
              );
              const all = await targets();
              const invoices = targetOf(all, 'customer_invoice_list');
              const inspections = targetOf(all, 'custom_inspection_list');
              const checks = targetOf(all, 'custom_inspection_lines_list');
              const f = (t: ReportTarget, local: string) =>
                t.fields.find(
                  (x) => x.operand.fieldId === `${NS}:field.${local}`,
                )!.operand.fieldId;
              aging = draftReport(
                invoices,
                'Aging',
                ReportChoicesSchema.parse({
                  dimensions: [
                    {
                      kind: 'age',
                      fieldId: f(invoices, 'customer_invoice_due_date'),
                      bands: DEFAULT_AGE_BANDS,
                      absentLabel: 'No due date',
                    },
                  ],
                  filters: [],
                  measures: [
                    {
                      kind: 'inline',
                      measureId: `${NS}:measure.custom_count`,
                      label: 'Count',
                      operator: { kind: 'count' },
                    },
                    {
                      kind: 'inline',
                      measureId: `${NS}:measure.custom_balance`,
                      label: 'Balance',
                      operator: {
                        kind: 'sum',
                        fieldId: f(invoices, 'customer_invoice_balance'),
                      },
                    },
                  ],
                  outputs: [{ kind: 'table' }, { kind: 'csv' }],
                }),
              );
              const site = inspections.links.find((l) =>
                l.link.entityId.endsWith('custom_site'),
              )!.link.via;
              byRegion = draftReport(
                inspections,
                'Inspections by region',
                ReportChoicesSchema.parse({
                  dimensions: [
                    {
                      kind: 'direct',
                      fieldId: `${NS}:field.custom_site_region`,
                      via: site,
                    },
                  ],
                  filters: [],
                  measures: [
                    {
                      kind: 'inline',
                      measureId: `${NS}:measure.custom_count`,
                      label: 'Count',
                      operator: { kind: 'count' },
                    },
                    {
                      kind: 'inline',
                      measureId: `${NS}:measure.custom_average_score`,
                      label: 'Average score',
                      operator: {
                        kind: 'average',
                        fieldId: f(inspections, 'custom_inspection_score'),
                      },
                    },
                    {
                      kind: 'inline',
                      measureId: `${NS}:measure.custom_sites`,
                      label: 'Sites',
                      operator: { kind: 'distinctTargets', via: site },
                    },
                    {
                      kind: 'inline',
                      measureId: `${NS}:measure.custom_first_due`,
                      label: 'First due',
                      operator: {
                        kind: 'min',
                        fieldId: f(inspections, 'custom_inspection_due'),
                      },
                    },
                  ],
                  outputs: [{ kind: 'table' }, { kind: 'csv' }],
                }),
              );
              const parent = checks.links.find((l) => l.parent)!.link.via;
              lineReport = draftReport(
                checks,
                'Checks by outcome',
                ReportChoicesSchema.parse({
                  grain: 'line',
                  dimensions: [
                    {
                      kind: 'direct',
                      fieldId: `${NS}:field.custom_inspection_outcome`,
                      via: parent,
                    },
                  ],
                  filters: [],
                  measures: [
                    {
                      kind: 'inline',
                      measureId: `${NS}:measure.custom_lines`,
                      label: 'Lines',
                      operator: { kind: 'count' },
                    },
                    {
                      kind: 'inline',
                      measureId: `${NS}:measure.custom_inspections`,
                      label: 'Inspections',
                      operator: { kind: 'distinctTargets', via: parent },
                    },
                  ],
                  outputs: [{ kind: 'table' }],
                }),
              );
              // A header score summed once per line refuses in preview.
              assert.throws(
                () =>
                  draftReport(
                    checks,
                    'Fan-out',
                    ReportChoicesSchema.parse({
                      grain: 'line',
                      dimensions: lineReport.body.dimensions,
                      filters: [],
                      measures: [
                        {
                          kind: 'inline',
                          measureId: `${NS}:measure.custom_score`,
                          label: 'Score',
                          operator: {
                            kind: 'sum',
                            fieldId: f(inspections, 'custom_inspection_score'),
                            via: parent,
                          },
                        },
                      ],
                      outputs: [{ kind: 'table' }],
                    }),
                  ),
                /would repeat once per line/u,
              );
              stage('publish');
              reportsDraft = await publish({
                kind: 'changeSet',
                patches: [aging, byRegion, lineReport],
              } as CustomizationPatch);
              assert.deepEqual(await older(), refusal(REPORT_ANALYSIS_READER));
              trial = draftMeasure(
                targetOf(await targets(), 'custom_inspection_list'),
                'Inspections counted',
                'trial',
                { kind: 'count' },
              );
              stage('publish');
              trialDraft = await publish(trial);
              assert.deepEqual(await older(), refusal(REPORT_MEASURE_READER));
            },
          );

          // ---- Facts. North and South in one tenant and environment.
          assert.equal(
            (await opened.service.status()).activeReleaseId,
            trialDraft.releaseId as never,
          );
          const context = await trustedContext(app.runtime.identity);
          const serving = await loadServingRelease(
            reader,
            context,
            trialDraft.releaseId as never,
          );
          const storage = serving.projection(
            PROJECTION_FAMILY_IDS.storageTarget,
          ).payload as StorageTargetPayloadV1;
          const entity = (local: string) =>
            storage.entities.find(
              (e) => e.entityId === `${NS}:entity.${local}`,
            )!;
          const column = (local: string, field: string) =>
            entity(local).columns.find(
              (c) => c.canonicalFieldId === `${NS}:field.${field}`,
            )!.physicalName;
          const table = (local: string) =>
            'north_star_module.' + entity(local).physicalTableName;
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const customer = app.seededRecords.find(
            (r) => r.operationId === `${NS}:operation.party_create`,
          )!.recordId;
          const orderColumn = storage.relations.find(
            (r) => r.relationId === `${NS}:relation.customer_invoice_order`,
          )!.relationColumn.physicalName;
          const orders = new Map<string, string>();
          for (const company of [north, south]) {
            const orderId = randomUUID();
            const created = await world.invoke('sales_order_create', {
              recordId: orderId,
              legalEntityId: company,
              values: {
                [`${NS}:field.sales_order_customer_party_id`]: customer,
                [`${NS}:field.sales_order_order_date`]:
                  '2026-11-01T00:00:00.000Z',
                [`${NS}:field.sales_order_currency`]: 'CAD',
              },
            });
            assert.ok(created.outcome === 'succeeded', JSON.stringify(created));
            orders.set(company, orderId);
          }
          const invoice = (
            company: string,
            dueDate: string | null,
            balance: string,
          ) =>
            pool.query(
              `INSERT INTO ${table('customer_invoice')} (tenant_id,environment_id,legal_entity_id,record_id,revision,${orderColumn},${['number', 'state', 'invoice_date', 'due_date', 'customer_party_id', 'balance', 'currency'].map((n) => column('customer_invoice', 'customer_invoice_' + n)).join(',')}) VALUES ($1,$2,$3,$4::uuid,1,$5,$4::text,$6,'2026-08-01T00:00:00Z',$7,$8,$9,'CAD')`,
              [
                tenantId,
                environmentId,
                company,
                randomUUID(),
                orders.get(company),
                `${NS}:option.customer_invoice_state_open`,
                dueDate && dueDate + 'T00:00:00Z',
                customer,
                balance,
              ],
            );
          for (const d of AGING_DUE_DATES) await invoice(north, d, '1.00');
          await invoice(north, null, '1.00');
          // South's sentinel shares North's band, customer and currency.
          await invoice(south, AGING_AS_OF, '999.00');

          const optionOf = (t: ReportTarget, field: string, label: string) =>
            [...t.fields, ...t.links.flatMap((l) => l.fields)]
              .find((x) => x.operand.fieldId === `${NS}:field.${field}`)!
              .options!.find((o) => o.label === label)!.id;
          const all = await targets();
          const inspections = targetOf(all, 'custom_inspection_list');
          const east = optionOf(inspections, 'custom_site_region', 'East');
          const west = optionOf(inspections, 'custom_site_region', 'West');
          const pass = optionOf(
            inspections,
            'custom_inspection_outcome',
            'Pass',
          );
          const fail = optionOf(
            inspections,
            'custom_inspection_outcome',
            'Fail',
          );
          const create = async (
            company: string,
            local: string,
            values: Record<string, string | null>,
            relations: Record<string, string> = {},
          ) => {
            const recordId = randomUUID();
            const result = await world.invoke(`${local}_create`, {
              recordId,
              legalEntityId: company,
              values: Object.fromEntries(
                Object.entries(values)
                  .filter(([, v]) => v !== null)
                  .map(([k, v]) => [`${NS}:field.${local}_${k}`, v]),
              ),
              relations: Object.fromEntries(
                Object.entries(relations).map(([k, v]) => [
                  `${NS}:relation.${local}_${k}`,
                  v,
                ]),
              ),
            });
            assert.ok(result.outcome === 'succeeded', JSON.stringify(result));
            return recordId;
          };
          const s1 = await create(north, 'custom_site', {
            name: 'S1',
            region: east,
          });
          const s2 = await create(north, 'custom_site', {
            name: 'S2',
            region: west,
          });
          const s3 = await create(south, 'custom_site', {
            name: 'S3',
            region: east,
          });
          const inspection = (
            company: string,
            name: string,
            outcome: string,
            due: string | null,
            score: string | null,
            siteId?: string,
          ) =>
            create(
              company,
              'custom_inspection',
              { name, outcome, due, score },
              siteId ? { site: siteId } : {},
            );
          const i1 = await inspection(
            north,
            'I1',
            pass,
            '2026-11-10',
            '80',
            s1,
          );
          await inspection(north, 'I2', fail, '2026-11-12', '90', s1);
          await inspection(north, 'I3', pass, '2026-11-11', '70', s2);
          const i4 = await inspection(north, 'I4', pass, null, '60');
          await inspection(north, 'I6', fail, '2026-11-09', null);
          const i5 = await inspection(
            south,
            'I5',
            pass,
            '2026-01-01',
            '1000',
            s3,
          );
          for (const [parent, item, company] of [
            [i1, 'a', north],
            [i1, 'b', north],
            [i5, 'c', south],
          ] as const)
            await create(
              company,
              'custom_inspection_lines',
              { line_number: item === 'b' ? '2' : '1', item, points: '1' },
              { parent },
            );

          // ---- Runs. A North-only principal, the run's instant injected; the
          // business date and calendar are captured from the company calendar.
          stage('0');
          const membership = await pool.query(
            'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE (tenant_id,environment_id,principal_id)=($1,$2,$3) AND legal_entity_id IS NULL',
            [tenantId, environmentId, principalId, north],
          );
          assert.ok(membership.rowCount);
          const calendar = await pool.query<{ zone: string }>(
            'SELECT time_zone AS zone FROM platform.inventory_tenant_calendars WHERE tenant_id=$1',
            [tenantId],
          );
          const bounded = composeServingGateways(
            reader,
            reader,
            context,
            serving,
            app.runtime.metrics,
            {
              providerErrorMappings: [],
              writeInvariants: [],
              capabilityOperationExecutorFactories:
                CAPABILITY_EXECUTOR_FACTORIES,
              localDemoIdentity: true,
              // Midday on the fixture date in any zone the tenant declares.
              reportClock: () => new Date(AGING_AS_OF + 'T16:00:00Z'),
            },
          );
          const run = (
            report: { reportId?: string; measureId?: string },
            overrides: Partial<ReportRequest> = {},
          ) =>
            app.runtime.entry.run({}, (view) =>
              bounded.queryGateway.invokeGrouped(view, {
                queryId: reportQueryId(report.reportId ?? report.measureId!),
                company: north,
                parameters: {},
                pageSize: 50,
                ...overrides,
              }),
            );

          stage('1');
          const aged = await run(aging);
          assert.ok(aged.kind === 'page', JSON.stringify(aged));
          assert.equal(aged.horizon.businessDate, AGING_AS_OF);
          assert.equal(aged.horizon.zone, calendar.rows[0]!.zone);
          const cad = { kind: 'currency', code: 'CAD' };
          assert.deepEqual(
            aged.groups.map((g) => [g.partition, g.keys, g.cells[0]!.value]),
            [
              [cad, ['not_due'], '1'],
              [cad, ['d0_30'], '2'],
              [cad, ['d31_60'], '2'],
              [cad, ['d61_90'], '2'],
              [cad, ['d91'], '1'],
              [cad, [null], '1'],
            ],
          );
          // Exact company totals: South's 999.00 sentinel never contributes.
          assert.deepEqual(
            aged.totals.map((t) => [t.partition, t.cells.map((c) => c.value)]),
            [[cad, ['9', '9.000000000000000000']]],
          );
          assert.deepEqual(await run(aging, { company: south }), {
            kind: 'unavailable',
          });

          stage('2');
          const regions = await run(byRegion);
          assert.ok(regions.kind === 'page', JSON.stringify(regions));
          const reference = (
            siteRegion: Map<string, string | { restricted: true }>,
          ) =>
            evaluateReportFacts(
              [
                {
                  operand: 'region',
                  kind: 'direct',
                  type: 'choice',
                  options: [east, west],
                },
              ],
              [
                {
                  id: `${NS}:measure.custom_count`,
                  operator: 'count',
                  scale: 0,
                },
                {
                  id: `${NS}:measure.custom_average_score`,
                  operator: 'average',
                  operand: 'score',
                  scale: 0,
                  type: 'integer',
                },
                {
                  id: `${NS}:measure.custom_sites`,
                  operator: 'distinctTargets',
                  operand: 'site',
                  scale: 0,
                },
                {
                  id: `${NS}:measure.custom_first_due`,
                  operator: 'min',
                  operand: 'due',
                  scale: 0,
                  type: 'date',
                },
              ],
              [
                ['s1', '80', '2026-11-10'],
                ['s1', '90', '2026-11-12'],
                ['s2', '70', '2026-11-11'],
                [null, '60', null],
                [null, null, '2026-11-09'],
              ].map(([site, score, due]) => {
                const region = site ? siteRegion.get(site)! : null;
                return {
                  region,
                  site:
                    (region && typeof region === 'object' ? null : site) ??
                    null,
                  score: score ?? null,
                  due: due ?? null,
                };
              }),
              { businessDate: AGING_AS_OF, zone: 'UTC', boundary: '00:00:00' },
            );
          const expected = reference(
            new Map<string, string>([
              ['s1', east],
              ['s2', west],
            ]),
          );
          // The provider agrees with the reference evaluator, including the
          // exact average ratio recomputed for the total (75 = 300 / 4).
          assert.deepEqual(regions.groups, expected.groups);
          assert.deepEqual(regions.totals, expected.totals);
          assert.deepEqual(regions.totals[0]!.cells[1]!.exact, {
            sum: '300',
            count: 4,
          });
          const csv = await run(byRegion, {
            export: { resultDigest: regions.resultDigest },
          });
          assert.ok(csv.kind === 'csv', JSON.stringify(csv));
          assert.match(csv.bytes, /Average score exact sum/u);

          // A hidden (here archived) Site is one Restricted group carrying its
          // inspections. It never shows the Site and never folds into Unspecified.
          await pool.query(
            `UPDATE ${table('custom_site')} SET archived_at=clock_timestamp() WHERE record_id=$1`,
            [s2],
          );
          stage('3');
          const hidden = await run(byRegion);
          assert.ok(hidden.kind === 'page', JSON.stringify(hidden));
          assert.deepEqual(
            hidden.groups,
            reference(
              new Map<string, string | { restricted: true }>([
                ['s1', east],
                ['s2', { restricted: true }],
              ]),
            ).groups,
          );
          assert.ok(!JSON.stringify(hidden).includes(s2));
          // A row pointing at another company's Site cannot surface it. The
          // relation key already keeps companies apart; drop it to isolate the
          // join's own company predicate.
          const inspectionEntity = entity('custom_inspection');
          const siteRelation = storage.relations.find(
            (r) => r.relationId === `${NS}:relation.custom_inspection_site`,
          )!;
          stage('4');
          await pool.query(
            `ALTER TABLE ${table('custom_inspection')} DROP CONSTRAINT ${siteRelation.foreignKey.physicalName}`,
          );
          await pool.query(
            `UPDATE north_star_module.${inspectionEntity.physicalTableName} SET ${siteRelation.relationColumn.physicalName}=$1 WHERE record_id=$2`,
            [s3, i4],
          );
          stage('5');
          const crossed = await run(byRegion);
          assert.ok(crossed.kind === 'page');
          const eastRow = crossed.groups.find((g) => g.keys[0] === east)!;
          assert.equal(
            eastRow.cells[0]!.value,
            '2',
            'South Site S3 must not admit North inspection I4 into East',
          );
          assert.ok(
            crossed.groups.some(
              (g) =>
                typeof g.keys[0] === 'object' &&
                g.keys[0] !== null &&
                g.cells[0]!.value === '2',
            ),
            'I4 now points at an unreadable Site and joins I3 as Restricted',
          );

          // Line grain: two North lines against one inspection count 2 lines
          // and 1 distinct inspection. South's line is excluded.
          stage('6');
          const perLine = await run(lineReport);
          assert.ok(perLine.kind === 'page', JSON.stringify(perLine));
          // Outcome is a finite choice, so the empty member is a typed zero row.
          assert.deepEqual(
            cells(perLine.groups),
            [
              [[pass], ['2', '1']],
              [[fail], ['0', '0']],
            ].sort((a, b) =>
              String((a[0] as string[])[0]) < String((b[0] as string[])[0])
                ? -1
                : 1,
            ),
          );
          assert.deepEqual(cells(perLine.totals), [[[], ['2', '1']]]);

          // The trial runs on authorized data and confers nothing.
          stage('7');
          const trialled = await run(trial);
          assert.ok(trialled.kind === 'page', JSON.stringify(trialled));
          assert.deepEqual(trialled.groups, []);
          assert.deepEqual(cells(trialled.totals), [[[], ['5']]]);
          assert.equal(
            (await targets()).find(
              (t) => t.source.queryId === `${NS}:query.custom_inspection_list`,
            )!.measures.length,
            0,
          );

          // A hidden joined dependency withholds the whole report, even when it
          // is only the target's read grant.
          const revoke = async (permission: string) => {
            const revoked = await pool.query(
              'UPDATE platform.current_policy_permission_grants SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND environment_id=$2 AND permission_id=$4 AND role_id IN (SELECT role_id FROM platform.current_policy_memberships WHERE principal_id=$3)',
              [tenantId, environmentId, principalId, permission],
            );
            assert.ok(revoked.rowCount, permission);
          };
          const siteRead = inspections.links.find((l) =>
            l.link.entityId.endsWith('custom_site'),
          )!.link.readPermissionId;
          stage('8');
          await revoke(siteRead);
          assert.deepEqual(await run(byRegion), { kind: 'unavailable' });
          assert.equal((await run(aging)).kind, 'page');
          await revoke(
            reportColumnPermission(`${NS}:field.custom_inspection_outcome`),
          );
          assert.deepEqual(await run(lineReport), { kind: 'unavailable' });

          // The grouped List renders bands, Restricted and absence by label.
          const url = new URL('/', app.baseUrl);
          url.searchParams.set('surface', reportSurfaceId(aging.reportId));
          url.searchParams.set(
            `${NS}:parameter.customer_invoice_list_legal_entity_scope`,
            north,
          );
          stage('9');
          const html = await (await fetch(url)).text();
          for (const text of ['Aging', 'Not yet due', '91+', 'No due date'])
            assert.ok(html.includes(text), 'missing in aging table: ' + text);
          void reportsDraft;
          void typesDraft;
          void fail;
        } finally {
          await reader.end();
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
