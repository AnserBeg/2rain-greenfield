import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
  ReportChoicesSchema,
} from '../../packages/canonical-model/src/index.js';
import {
  compileInSandbox,
  serializeRelease,
  parseSerializedRelease,
} from '../../packages/customization/src/index.js';
import {
  draftReport,
  reportTargets,
} from '../../packages/customization/src/report-revision.js';
import type { StorageTransitionEnvelope } from '../../packages/compiler/src/protocol.js';
import { previewReportIndexes } from '../../packages/postgres-provider/src/report-index-build.js';
import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/storage.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import { projectionPayload } from '../compiler/helpers.js';
import type { RegisteredReport } from '../../packages/compiler/src/declared-reports.js';
import { readGroupedSnapshot } from '../../packages/postgres-provider/src/grouped-report.js';
import { REPORT_READER_POLICY } from '../../packages/runtime/src/declared-report.js';
import {
  firstPartyAuthored,
  compiledApplication,
  authoredPath,
} from '../helpers/customization-fixture.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

test('the PostgreSQL Invoice candidate probe uses the named date index and stops at cap plus one before any residual, even with hidden facts', async () => {
  const normalize = (value: unknown) => {
    const parsed = parseAuthoredApplicationPackageJson(JSON.stringify(value));
    assert.ok(parsed.languageVersion === 'v6');
    return normalizeApplicationPackage(parsed);
  };
  const base = normalize(firstPartyAuthored);
  const target = reportTargets(base).find((t) =>
    t.source.entityId.endsWith('entity.customer_invoice'),
  )!;
  const field = (local: string) =>
    target.fields.find((f) => f.operand.fieldId.endsWith('_' + local))!.operand
      .fieldId;
  const customer = field('customer_party_id'),
    date = field('invoice_date'),
    balance = field('balance');
  const patch = draftReport(
    target,
    'Customer balances',
    ReportChoicesSchema.parse({
      dimensions: [{ kind: 'direct', fieldId: customer }],
      filters: [
        { kind: 'dateRange', fieldId: date },
        { kind: 'equals', fieldId: customer },
      ],
      measures: [
        {
          kind: 'inline',
          measureId: 'northstar.app:measure.custom_balance',
          operator: { kind: 'sum', fieldId: balance },
          label: 'Balance',
        },
      ],
      outputs: [{ kind: 'table' }, { kind: 'csv' }],
    }),
  );
  const candidate = await compileInSandbox({
    base: firstPartyAuthored,
    tip: serializeRelease(
      parseCompiledApplication(compiledApplication).application,
    ),
    chain: [patch],
    acknowledgement: readUnboundPermissionAcknowledgementFor(
      authoredPath,
      'northstar.app:package.application',
    ),
  });
  assert.ok(
    candidate.status === 'compiled',
    JSON.stringify(candidate.status === 'compiled' ? [] : candidate),
  );
  const compiled = parseSerializedRelease(candidate.steps[0]!.release).compiled;
  const storage = projectionPayload<StorageTargetPayloadV1>(
    compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const entity = storage.entities.find(
    (e) => e.entityId === target.source.entityId,
  )!;
  const [report] = projectionPayload<{ groupedReports: RegisteredReport[] }>(
    compiled,
    PROJECTION_FAMILY_IDS.queryCatalog,
  ).groupedReports;
  assert.ok(report);
  const { table, index, keys } = report.accessPath;
  const col = (local: string) =>
    report.columns.find((c) => c.fieldId === field(local))!.columnName;
  const relation = 'north_star_module.' + table;
  const horizon = {
    zone: 'America/Edmonton',
    boundary: '00:00:00',
    businessDate: '2026-11-01',
    readInstant: '2026-11-01T12:00:00Z',
  };
  const tenantId = randomUUID(),
    environmentId = randomUUID(),
    company = randomUUID();
  const view = { tenantId, environmentId },
    scope = { legalEntityIds: [company] };
  const input = {
    queryId: report.queryId,
    parameters: { [date]: { from: '2026-11-01', until: '2026-11-02' } },
    company,
    pageSize: 1,
  };
  await withEphemeralPostgres('report-bounds', async ({ pool }) => {
    const client = await pool.connect();
    try {
      await client.query('CREATE SCHEMA north_star_module');
      await client.query(
        `CREATE TABLE ${relation}(tenant_id uuid,environment_id uuid,legal_entity_id uuid,record_id uuid,archived_at timestamptz,${col('customer_party_id')} text,${col('invoice_date')} timestamptz,${col('balance')} numeric(38,18),${col('currency')} varchar(3),visible boolean)`,
      );
      await client.query(
        `CREATE INDEX ${index} ON ${relation} (${keys.join(',')})`,
      );
      // Other companies make the named company/date range selective at launch volume.
      await client.query(
        `INSERT INTO ${relation} SELECT $1,$2,gen_random_uuid(),gen_random_uuid(),NULL,'A','2026-11-01',999,'CAD',true FROM generate_series(1,15000)`,
        [tenantId, environmentId],
      );
      const insert = async (
        t: string,
        group: string,
        amount: string | null,
        currency: string | null,
        visible = true,
      ) =>
        client.query(
          `INSERT INTO ${relation} VALUES($1,$2,$3,gen_random_uuid(),NULL,$4,'2026-11-01',$5,$6,$7)`,
          [t, environmentId, company, group, amount, currency, visible],
        );
      await insert(randomUUID(), 'A', '1000', 'CAD');
      await insert(tenantId, 'A', '12', 'CAD');
      await insert(tenantId, 'B', '3', null);
      await insert(tenantId, 'B', null, null, false);
      await client.query('ANALYZE ' + relation);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      let observedPlan: unknown;
      // EXPLAIN the exact parameterized provider probe on the same connection and snapshot.
      const observed = new Proxy(client, {
        get(target, prop) {
          if (prop !== 'query') return Reflect.get(target, prop);
          return async (sql: string, args?: unknown[]) => {
            if (sql.startsWith('SELECT count(*)::int AS n FROM'))
              observedPlan = (
                await client.query('EXPLAIN (ANALYZE,FORMAT JSON) ' + sql, args)
              ).rows[0]!['QUERY PLAN'];
            return client.query(sql, args);
          };
        },
      }) as PoolClient;
      const run = (
        facts: number,
        groups: number,
        showHidden: boolean,
        parameters:
          typeof input.parameters | Record<string, string> = input.parameters,
      ) =>
        readGroupedSnapshot(
          observed,
          entity,
          {
            view,
            scope,
            input: { ...input, parameters },
            report,
            remaining: () => 5000,
          },
          horizon,
          (_, predicates) => {
            if (!showHidden) predicates.push('visible');
          },
          { ...REPORT_READER_POLICY, facts, groups },
        );
      const exact = await run(3, 2, false);
      assert.ok(!('kind' in exact), JSON.stringify(exact));
      assert.equal(exact.facts, 2);
      assert.deepEqual(
        exact.totals.map((t) => [
          t.partition,
          t.cells[0]!.value,
          t.cells[0]!.recordsWithoutMeasure,
        ]),
        [
          [{ kind: 'currency', code: 'CAD' }, '12.000000000000000000', 0],
          [{ kind: 'noCurrency' }, '3.000000000000000000', 0],
        ],
      );
      assert.ok(
        JSON.stringify(observedPlan).includes(index),
        'provider did not scan ' + index,
      );
      assert.deepEqual(await run(3, 1, false), { kind: 'narrow' });
      const all = await run(3, 2, true);
      assert.ok(!('kind' in all));
      assert.equal(all.totals[1]?.cells[0]?.recordsWithoutMeasure, 1);
      await insert(tenantId, 'C', null, null, false);
      await insert(tenantId, 'D', null, null, false);
      assert.deepEqual(await run(3, 2, false, { [customer]: 'nonexistent' }), {
        kind: 'narrow',
      });
      assert.deepEqual(await run(3, 2, true), { kind: 'narrow' });
      const plan = JSON.stringify(observedPlan);
      assert.match(
        plan,
        /"Node Type":"Limit"[^}]*"Actual Rows":4/u,
        'provider scanned past the fourth scoped candidate',
      );
      const transition = projectionPayload<StorageTransitionEnvelope>(
        compiled,
        PROJECTION_FAMILY_IDS.storageTransition,
      );
      await client.query(
        'UPDATE pg_catalog.pg_index SET indisvalid=false WHERE indexrelid=$1::regclass',
        ['north_star_module.' + index],
      );
      assert.deepEqual(await run(3, 2, true), { kind: 'unavailable' });
      const invalid = await previewReportIndexes(
        client,
        [report],
        transition.elements,
      );
      assert.ok(
        invalid?.includes('already in use') &&
          invalid.includes(keys.join(', ')),
        invalid ?? 'invalid path was accepted',
      );
      await client.query('DROP INDEX north_star_module.' + index);
      const missing = await previewReportIndexes(client, [report], []);
      assert.ok(
        missing?.includes(keys.join(', ')),
        'a missing, unplanned index must be refused by key',
      );
      assert.deepEqual(await run(3, 2, true), { kind: 'unavailable' });
      // An INCLUDE column can be returned from the index but cannot order the candidate range.
      await client.query(
        `CREATE INDEX ${index} ON ${relation} (${keys.slice(0, -1).join(',')}) INCLUDE (${keys.at(-1)})`,
      );
      assert.deepEqual(await run(3, 2, true), { kind: 'unavailable' });
      await client.query('ROLLBACK');
      // Exercise the provider's use of the released collation on both sides of equality
      // and on the group key. The module storage suite owns the versioned Unicode fold ABI.
      await client.query(
        'CREATE FUNCTION north_star_module.nsm_unicode_case_fold_v1(text) RETURNS text LANGUAGE SQL IMMUTABLE STRICT AS $$ SELECT lower($1) $$',
      );
      await insert(tenantId, 'a', '2', 'CAD');
      const folded = {
        ...report,
        columns: report.columns.map((c) =>
          c.fieldId === customer
            ? { ...c, collation: 'unicodeCaseInsensitive' as const }
            : c,
        ),
      };
      const combined = await readGroupedSnapshot(
        client,
        entity,
        {
          view,
          scope,
          input: {
            ...input,
            parameters: { ...input.parameters, [customer]: 'a' },
          },
          report: folded,
          remaining: () => 5000,
        },
        horizon,
        (_, predicates) => predicates.push('visible'),
        REPORT_READER_POLICY,
      );
      assert.ok(!('kind' in combined));
      assert.deepEqual(
        combined.groups.map((r) => [r.keys, r.cells[0]?.value]),
        [[['a'], '14.000000000000000000']],
      );
      await client.query("SET TIME ZONE 'America/Edmonton'");
      const civil = await readGroupedSnapshot(
        client,
        entity,
        {
          view,
          scope,
          input,
          report: {
            ...report,
            revision: {
              ...report.revision,
              body: {
                ...report.revision.body,
                dimensions: [{ kind: 'direct', fieldId: date }],
              },
            },
          },
          remaining: () => 5000,
        },
        horizon,
        (_, predicates) => predicates.push('visible'),
      );
      assert.ok(!('kind' in civil) && civil.groups.length > 0);
      for (const row of civil.groups)
        assert.deepEqual(row.keys, ['2026-11-01']);
    } finally {
      client.release();
    }
  });
});
