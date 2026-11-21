import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/storage.js';
import type { ReportRequest } from '../../packages/runtime/src/declared-report.js';
import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  COMPANY_ACCESS_INDEX,
  COMPANY_ACCESS_INDEX_READER,
} from '../../packages/canonical-model/src/index.js';
import {
  compileInSandbox,
  CustomizationPatchSchema,
  serializeRelease,
  type SerializedRelease,
} from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { recordedPatch } from '../helpers/customization-patch-record.js';
import { withArchivedCustomizationRuntime } from '../helpers/archived-runtime-process.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

import {
  reportsPredecessor,
  readReportsPredecessor,
} from '../helpers/reports-preceding-release.js';

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

async function assertStoredBytes(
  pool: Pool,
  releaseId: string,
  expected: SerializedRelease,
) {
  const revision = await pool.query<{
    content_hash: string;
    desired_state: Buffer;
  }>(
    `SELECT r.content_hash, p.desired_state FROM platform.tenant_releases r
     JOIN platform.app_package_revisions p ON p.tenant_id=r.tenant_id AND p.revision_id=r.app_package_revision_id
     WHERE r.release_id=$1`,
    [releaseId],
  );
  assert.equal(revision.rows[0]?.content_hash, expected.releaseRoot);
  assert.equal(
    revision.rows[0]?.desired_state.toString('base64'),
    expected.normalizedDefinitionBytesBase64,
  );
  const blobs = await pool.query<{
    content_hash: string;
    canonical_bytes: Buffer;
  }>(
    `SELECT l.content_hash, b.canonical_bytes FROM platform.tenant_release_artifact_links l
     JOIN platform.release_artifact_blobs b USING (content_hash) WHERE l.release_id=$1
     UNION ALL
     SELECT r.content_hash, b.canonical_bytes FROM platform.tenant_releases r
     JOIN platform.release_artifact_blobs b USING (content_hash) WHERE r.release_id=$1`,
    [releaseId],
  );
  assert.deepEqual(
    new Map(
      blobs.rows.map((b) => [
        b.content_hash,
        b.canonical_bytes.toString('base64'),
      ]),
    ),
    new Map(
      expected.artifacts.map((a) => [
        String(a.contentHash),
        String(a.canonicalBytesBase64),
      ]),
    ),
  );
}

test(
  'persisted first-party and pre-key company bytes agree, and the preceding reader answers a query before refusing a newly indexed company type',
  { timeout: 900_000 },
  async () => {
    const path = 'apps/web/release/app.authored.json';
    const compiledApplication = readReportsPredecessor(
      'apps/web/release/app.compiled.json',
    );
    const tip = serializeRelease(
      parseCompiledApplication(compiledApplication).application,
    );
    await withEphemeralPostgres(
      'report-company-reader',
      async ({ pool, connection }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'report-company-reader',
          compiledApplication,
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const readInput = {
            identity: app.runtime.identity,
            databaseUrl: options.databaseUrl,
          };
          await withArchivedCustomizationRuntime(
            reportsPredecessor,
            async (run) => {
              await assertStoredBytes(pool, app.runtime.activeReleaseId, tip);
              const control = (await run(archivedQuery, readInput)) as {
                outcome: string;
                ids: string[];
              };
              assert.equal(
                control.outcome,
                'answered',
                JSON.stringify(control),
              );
              assert.ok(
                control.ids.length > 0,
                'the scoped company list actually returned a company',
              );
              const change = CustomizationPatchSchema.parse({
                kind: 'addRecordType',
                companyOwnership: 'entityOwned',
                label: 'Historical inspection',
                fields: [{ type: 'text', label: 'Name' }],
              });
              const historical = (await run(
                `
          import {readFile} from 'node:fs/promises';
          import {openCustomizeService} from './apps/api/src/composition-root.ts';
          const {options,change}=JSON.parse(await readFile(process.argv[2],'utf8'));
          const opened=await openCustomizeService(options);
          try {
            const draft=await opened.service.draft(change,'visualBuilder');
            if(draft.status!=='drafted')throw new Error(JSON.stringify(draft));
            console.log(JSON.stringify(draft.patchId));
          } finally {await opened.close();}
        `,
                {
                  options: {
                    databaseUrl: options.databaseUrl,
                    tenantSlug: options.tenantSlug,
                  },
                  change,
                },
              )) as string;
              const old = await recordedPatch(pool, historical);
              assert.deepEqual(JSON.parse(old.payload.toString()), change);
              const reproduced = await compileInSandbox({
                base: readReportsPredecessor(path),
                chain: [change],
                tip,
                acknowledgement: readUnboundPermissionAcknowledgementFor(
                  path,
                  'northstar.app:package.application',
                ),
              });
              assert.ok(reproduced.status === 'compiled');
              await assertStoredBytes(
                pool,
                old.resulting_release_id,
                reproduced.steps[0]!.release,
              );
              const draft = await opened.service.draft(
                { ...change, label: 'Inspection' },
                'visualBuilder',
              );
              assert.ok(draft.status === 'drafted', JSON.stringify(draft));
              const fresh = await recordedPatch(pool, draft.patchId);
              assert.equal(
                JSON.parse(fresh.payload.toString()).companyAccessIndex,
                COMPANY_ACCESS_INDEX,
              );
              await opened.service.approve(draft.patchId);
              await opened.service.activate(draft.patchId);
              const index =
                'nsm_i_57kahsinwt3fo73cpq5mduuaqnwmyh6a7jjowaafqx5jvwtbwnsa';
              const ready = await pool.query(
                'SELECT indisready AND indisvalid AS ready FROM pg_catalog.pg_index WHERE indexrelid=pg_catalog.to_regclass($1)',
                ['north_star_module.' + index],
              );
              assert.equal(ready.rows[0]?.ready, true);
              const requireRefusal = async () =>
                assert.deepEqual(await run(archivedQuery, readInput), {
                  outcome: 'refused',
                  phase: 'load',
                  code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
                  message:
                    'runtime capability northstar.runtime:capability.surface-manifest requires version ' +
                    COMPANY_ACCESS_INDEX_READER +
                    ' and this runtime supports 37',
                });
              await requireRefusal();
              // Mutate only the extracted production loader in this disposable archive.
              await run(
                `
                import assert from 'node:assert/strict';
                import {readFile, writeFile} from 'node:fs/promises';
                const file='packages/runtime/src/request-runtime-view.ts';
                const source=await readFile(file,'utf8');
                const guard='if (requirement.minimumVersion > entry.maximumSupportedVersion)';
                assert.equal(source.split(guard).length,2);
                await writeFile(file,source.replace(guard,'if (false)'));
                console.log('null');
              `,
                {},
              );
              await assert.rejects(requireRefusal, { name: 'AssertionError' });
              const mutant = (await run(archivedQuery, readInput)) as {
                phase?: string;
                outcome: string;
              };
              assert.ok(
                mutant.phase === 'query' || mutant.outcome === 'answered',
                'without the floor check the preceding loader admitted the indexed release',
              );

              await assertStoredBytes(
                pool,
                old.resulting_release_id,
                reproduced.steps[0]!.release,
              );
            },
          );
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

test(
  'Invoice report reads exact company partitions and coverage, filters civil dates, pages complete totals and issues audited bytes',
  { timeout: 900_000 },
  async () => {
    const { randomUUID, createHash } = await import('node:crypto');
    const { ReportChoicesSchema } =
      await import('../../packages/canonical-model/src/schemas.js');
    const { draftReport } =
      await import('../../packages/customization/src/report-revision.js');
    const { REPORT_EXPORT_PERMISSION, reportColumnPermission, reportQueryId } =
      await import('../../packages/canonical-model/src/declared-report.js');
    const { firstPartyAuthored } =
      await import('../helpers/customization-fixture.js');
    const { singleTransitionApplication } =
      await import('../helpers/application-without-line-create-values.js');
    const compiledApplication =
      singleTransitionApplication(firstPartyAuthored).release;
    const { projectionPayload } = await import('../compiler/helpers.js');
    const { PROJECTION_FAMILY_IDS } =
      await import('../../packages/compiler/src/index.js');
    const { COMPANY, worldOver } = await import('../agent/agent-world.js');
    await withEphemeralPostgres(
      'report-invoice',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://postgres@127.0.0.1:${connection.port}/postgres`,
          tenantSlug: 'report-invoice',
          compiledApplication,
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const olderReader = (minimumVersion: number) =>
            withArchivedCustomizationRuntime(
              reportsPredecessor,
              async (run) => {
                const result = await run(archivedQuery, {
                  databaseUrl: options.databaseUrl,
                  identity: app.runtime.identity,
                });
                assert.deepEqual(result, {
                  outcome: 'refused',
                  phase: 'load',
                  code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
                  message:
                    'runtime capability northstar.runtime:capability.surface-manifest requires version ' +
                    minimumVersion +
                    ' and this runtime supports 37',
                });
              },
            );
          await olderReader(
            (await import('../../packages/canonical-model/src/constants.js'))
              .REPORT_SOURCE_READER,
          );
          const target = (await opened.service.targets()).reports!.find((t) =>
            t.source.entityId.endsWith(':entity.customer_invoice'),
          )!;
          const id = (suffix: string) =>
            target.fields.find((f) => f.operand.fieldId.endsWith('_' + suffix))!
              .operand.fieldId;
          const revision = draftReport(
            target,
            'Balance by customer',
            ReportChoicesSchema.parse({
              dimensions: [
                { kind: 'direct', fieldId: id('customer_party_id') },
              ],
              filters: [{ kind: 'dateRange', fieldId: id('invoice_date') }],
              measures: [
                {
                  kind: 'inline',
                  operator: { kind: 'sum', fieldId: id('balance') },
                  measureId: 'northstar.app:measure.custom_balance',
                  label: 'Balance',
                },
              ],
              outputs: [{ kind: 'table' }, { kind: 'csv' }],
            }),
          );
          const draft = await opened.service.draft(revision, 'visualBuilder');
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          await opened.service.activate(draft.patchId);
          await olderReader(
            (
              await import('../../packages/canonical-model/src/declared-report.js')
            ).DECLARED_REPORT_READER,
          );
          const types = projectionPayload<StorageTargetPayloadV1>(
            parseCompiledApplication(compiledApplication).application.compiled,
            PROJECTION_FAMILY_IDS.storageTarget,
          );
          const entity = types.entities.find(
            (e) => e.entityId === target.source.entityId,
          )!;
          const table = 'north_star_module.' + entity.physicalTableName;
          const col = (name: string) =>
            entity.columns.find((c) => c.canonicalFieldId === id(name))!
              .physicalName;
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const north = COMPANY;
          const world = worldOver(app.runtime, 'postgres');
          const south = randomUUID();
          await world.invoke('legal_entity_create', {
            recordId: south,
            values: {
              'northstar.app:field.legal_entity_code': 'SOUTH',
              'northstar.app:field.legal_entity_name': 'South',
              'northstar.app:field.legal_entity_status':
                'northstar.app:option.legal_entity_status_active',
              'northstar.app:field.legal_entity_is_default': false,
            },
          });
          const customer = app.seededRecords.find(
            (r) => r.operationId === 'northstar.app:operation.party_create',
          )!.recordId;
          const orderColumn = types.relations.find(
            (r) =>
              r.relationId === 'northstar.app:relation.customer_invoice_order',
          )!.relationColumn.physicalName;
          const orders = new Map<string, string>();
          for (const company of [north, south]) {
            const orderId = randomUUID();
            const parent = await world.invoke('sales_order_create', {
              recordId: orderId,
              legalEntityId: company,
              values: {
                'northstar.app:field.sales_order_customer_party_id': customer,
                'northstar.app:field.sales_order_order_date':
                  '2026-11-01T00:00:00.000Z',
                'northstar.app:field.sales_order_currency': 'CAD',
              },
            });
            assert.ok(parent.outcome === 'succeeded', JSON.stringify(parent));
            orders.set(company, orderId);
          }
          const insert = async (
            company: string,
            group: string,
            amount: string | null,
            currency: string | null,
            day = '2026-11-01',
            writer: Pool | PoolClient = pool,
          ) => {
            const record = randomUUID();
            await writer.query(
              `INSERT INTO ${table} (tenant_id,environment_id,legal_entity_id,record_id,revision,${orderColumn},${['number', 'state', 'invoice_date', 'customer_party_id', 'balance', 'currency'].map(col).join(',')}) VALUES ($1,$2,$3,$4,1,$11,$5,$6,$7,$8,$9,$10)`,
              [
                tenantId,
                environmentId,
                company,
                record,
                record,
                'northstar.app:option.customer_invoice_state_open',
                day + 'T00:00:00Z',
                group,
                amount,
                currency,
                orders.get(company),
              ],
            );
            return record;
          };
          const edit = await insert(north, customer, '10.25', 'CAD');
          await insert(north, customer, '1.75', 'CAD');
          await insert(north, customer, '4.00', 'USD');
          await insert(north, customer, '-0.005', 'EUR');
          await insert(north, customer, null, 'CAD');
          await insert(north, customer, '3.00', null);
          await insert(south, customer, '90.00', 'CAD');
          await insert(north, customer, '100', 'CAD', '2026-11-02');
          const membership = await pool.query(
            'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE (tenant_id,environment_id,principal_id)=($1,$2,$3) AND legal_entity_id IS NULL',
            [tenantId, environmentId, principalId, north],
          );
          assert.ok(membership.rowCount);
          const request = {
            queryId: reportQueryId(revision.reportId),
            company: north,
            parameters: {
              [id('invoice_date')]: { from: '2026-11-01', until: '2026-11-02' },
            },
            pageSize: 2,
          };
          const run = (overrides: Partial<ReportRequest> = {}) =>
            app.runtime.entry.run({}, (view) =>
              app.runtime.queryGateway.invokeGrouped(view, {
                ...request,
                ...overrides,
              }),
            );
          const page = await run();
          assert.ok(page.kind === 'page', JSON.stringify(page));
          assert.deepEqual(
            page.totals.map((t) => [
              t.partition,
              t.cells[0]!.value,
              t.cells[0]!.recordsWithoutMeasure,
            ]),
            [
              [{ kind: 'currency', code: 'CAD' }, '12.000000000000000000', 1],
              [{ kind: 'currency', code: 'EUR' }, '-0.005000000000000000', 0],
              [{ kind: 'currency', code: 'USD' }, '4.000000000000000000', 0],
              [{ kind: 'noCurrency' }, '3.000000000000000000', 0],
            ],
          );
          assert.ok(page.next);
          const next = await run({ cursor: page.next });
          assert.ok(next.kind === 'page');
          assert.deepEqual(next.totals, page.totals);
          assert.deepEqual(
            [...page.groups, ...next.groups].map((r) => r.partition),
            page.totals.map((r) => r.partition),
          );
          const url = new URL('/', app.baseUrl);
          url.searchParams.set(
            'surface',
            revision.reportId.replace(
              ':report.custom_',
              ':surface.custom_report_',
            ),
          );
          url.searchParams.set(
            'northstar.app:parameter.customer_invoice_list_legal_entity_scope',
            north,
          );
          url.searchParams.set(id('invoice_date') + '.from', '2026-11-01');
          url.searchParams.set(id('invoice_date') + '.until', '2026-11-02');
          const html = await (await fetch(url)).text();
          for (const text of [
            'Balance by customer',
            'No currency',
            '1 record without Balance',
            '-0.005000000000000000',
            'Export CSV',
          ])
            assert.ok(html.includes(text), 'missing in report table: ' + text);
          const file = await run({
            export: { resultDigest: page.resultDigest },
          });
          assert.ok(file.kind === 'csv', JSON.stringify(file));
          assert.ok(file.bytes.includes(customer));
          assert.match(file.bytes, /"-0.005000000000000000"/u);
          assert.match(file.bytes, /"No currency"/u);
          assert.match(file.bytes, /Records without Balance/u);
          const receipt = await pool.query(
            'SELECT metadata,execution_principal_id FROM platform.trust_action_invocations WHERE invocation_id=$1',
            [file.receiptId],
          );
          assert.equal(receipt.rows[0]?.execution_principal_id, principalId);
          const evidence = receipt.rows[0]!.metadata;
          assert.equal(
            evidence.outputDigest.value,
            createHash('sha256').update(file.bytes).digest('hex'),
          );
          assert.equal(evidence.byteCount.value, Buffer.byteLength(file.bytes));
          assert.equal(evidence.companyId.value, north);
          assert.equal(evidence.reportId.value, revision.reportId);
          assert.equal(evidence.revisionId.value, revision.revisionId);
          assert.deepEqual(
            [
              evidence.facts.value,
              evidence.groups.value,
              evidence.totals.value,
            ],
            [6, 4, 4],
          );
          const blocker = await pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'LOCK TABLE ' + table + ' IN ACCESS EXCLUSIVE MODE',
            );
            assert.deepEqual(
              await run(),
              { kind: 'narrow' },
              'a PostgreSQL statement timeout must ask for a narrower filter',
            );
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          // Refuse this scoped issuance at the real append. The transport must receive no file.
          await pool.query(
            "ALTER TABLE platform.trust_action_invocations ADD CONSTRAINT report_audit_unavailable CHECK (action_id <> 'northstar.runtime:action.issue_report_csv') NOT VALID",
          );
          assert.deepEqual(
            await run({ export: { resultDigest: page.resultDigest } }),
            { kind: 'unavailable' },
          );
          await pool.query(
            'ALTER TABLE platform.trust_action_invocations DROP CONSTRAINT report_audit_unavailable',
          );
          assert.deepEqual(await run({ company: south }), {
            kind: 'unavailable',
          });
          assert.deepEqual(await run({ pageSize: 51 }), { kind: 'narrow' });
          await pool.query(
            `UPDATE ${table} SET ${col('balance')}=11 WHERE record_id=$1`,
            [edit],
          );
          assert.deepEqual(await run({ cursor: page.next }), {
            kind: 'refresh',
          });
          assert.deepEqual(
            await run({ export: { resultDigest: page.resultDigest } }),
            { kind: 'refresh' },
          );
          const revoke = async (permission: string) => {
            const revoked = await pool.query(
              'UPDATE platform.current_policy_permission_grants SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND environment_id=$2 AND permission_id=$4 AND role_id IN (SELECT role_id FROM platform.current_policy_memberships WHERE principal_id=$3)',
              [tenantId, environmentId, principalId, permission],
            );
            assert.ok(revoked.rowCount);
          };
          await revoke(REPORT_EXPORT_PERMISSION);
          const after = await run();
          assert.ok(after.kind === 'page');
          assert.deepEqual(
            await run({ export: { resultDigest: after.resultDigest } }),
            { kind: 'unavailable' },
          );
          await revoke(reportColumnPermission(id('currency')));
          assert.deepEqual(await run(), { kind: 'unavailable' });
          // A second range needs its own existing-table index. The size check counts
          // both companies and runs again under the same lock as CREATE INDEX.
          const dueDate = id('due_date');
          const second = draftReport(
            target,
            'Due balances by customer',
            ReportChoicesSchema.parse({
              dimensions: revision.body.dimensions,
              measures: revision.body.measures,
              outputs: revision.body.outputs,
              filters: [{ kind: 'dateRange', fieldId: dueDate }],
            }),
          );
          const size = Number(
            (await pool.query('SELECT count(*) AS n FROM ' + table)).rows[0]!.n,
          );
          const previous = process.env.NORTH_STAR_REPORT_INDEX_ROW_CEILING;
          const writer = await pool.connect();
          try {
            process.env.NORTH_STAR_REPORT_INDEX_ROW_CEILING = String(size - 1);
            const tooLarge = await opened.service.draft(
              second,
              'visualBuilder',
            );
            assert.ok(tooLarge.status === 'refused', JSON.stringify(tooLarge));
            assert.match(tooLarge.message, /Due balances by customer/u);
            assert.ok(tooLarge.message.includes(col('due_date')));
            process.env.NORTH_STAR_REPORT_INDEX_ROW_CEILING = String(size);
            const atCeiling = await opened.service.draft(
              second,
              'visualBuilder',
            );
            assert.ok(
              atCeiling.status === 'drafted',
              JSON.stringify(atCeiling),
            );
            await opened.service.approve(atCeiling.patchId);
            await writer.query('BEGIN');
            await insert(south, customer, '1', 'CAD', '2026-11-01', writer);
            const outcome = opened.service.activate(atCeiling.patchId).then(
              () => null,
              (error: unknown) => error,
            );
            const bound = performance.now() + 60_000;
            let waiting = false;
            while (!waiting && performance.now() < bound) {
              waiting =
                (
                  await pool.query(
                    "SELECT 1 FROM pg_locks WHERE relation=$1::regclass AND mode='ShareLock' AND NOT granted",
                    [table],
                  )
                ).rowCount === 1;
              if (!waiting) await delay(25);
            }
            assert.ok(
              waiting,
              'the approved report build must wait on the pooled Invoice table',
            );
            await writer.query('COMMIT');
            const failure = await outcome;
            assert.ok(
              failure instanceof Error &&
                failure.message.includes(col('due_date')) &&
                /ceiling/u.test(failure.message),
              String(failure),
            );
            assert.equal(
              (await opened.service.status()).activeReleaseId,
              draft.releaseId,
            );
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
            if (previous === undefined)
              delete process.env.NORTH_STAR_REPORT_INDEX_ROW_CEILING;
            else process.env.NORTH_STAR_REPORT_INDEX_ROW_CEILING = previous;
          }
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
