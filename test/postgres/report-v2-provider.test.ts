import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  DEFAULT_AGE_BANDS,
  RESTRICTED_KEY,
  evaluateReportFacts,
  type ReportCurrencyBinding,
  type ReportMeasureSpec,
} from '../../packages/canonical-model/src/index.js';
import type { RegisteredReport } from '../../packages/canonical-model/src/declared-report.js';
import { readGroupedSnapshotV2 } from '../../packages/postgres-provider/src/grouped-report-v2.js';
import {
  reportHorizon,
  reportIndexReady,
} from '../../packages/postgres-provider/src/grouped-report.js';
import {
  REPORT_READER_POLICY,
  type ReportHorizon,
} from '../../packages/runtime/src/declared-report.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

// REPORTS-1 s2, provider level: the v2 reader on bare tables, with the issued
// row policy modelled as a `visible` column on every input. Each assertion
// compares the provider with the reference evaluator, so removing one layer
// (grain policy, link policy, the company predicate on the grain or a join,
// the required parent, typed equality, minor-unit rounding) reds here alone.
const F = (local: string) => 'northstar.app:field.t_' + local;
const R = (local: string) => 'northstar.app:relation.t_' + local;
const codes = ['CAD', 'USD', 'EUR'] as const;
const stored: ReportCurrencyBinding = {
  kind: 'stored',
  fieldId: F('bill_currency') as never,
  codes: [...codes],
};
const col = (
  fieldId: string,
  columnName: string,
  type: string,
  extra: Record<string, unknown> = {},
) => ({
  fieldId,
  columnName,
  type,
  label: columnName,
  presence: 'optional',
  classification: 'internal',
  ...extra,
});
const billColumns = [
  col(F('bill_balance'), 'balance', 'decimal', {
    scale: 18,
    currency: stored,
  }),
  col(F('bill_currency'), 'currency', 'text', { collation: 'binary' }),
  col(F('bill_due'), 'due', 'instant', { basis: 'civilDate' }),
  col(F('bill_stamp'), 'stamp', 'instant', { basis: 'instant' }),
];
const vendorRegion = col(F('vendor_region'), 'region', 'text', {
  collation: 'binary',
  via: [R('vendor')],
});
const siteZone = col(F('site_zone'), 'zone', 'text', {
  collation: 'binary',
  via: [R('vendor'), R('site')],
});
const vendorLink = {
  via: [R('vendor')],
  entityId: 'v',
  queryId: 'qv',
  readPermissionId: 'pv',
  required: false,
  table: 't_vendor',
  relationColumn: 'vendor_ref',
  legalEntity: true,
};
const siteLink = {
  ...vendorLink,
  via: [R('vendor'), R('site')],
  table: 't_site',
  relationColumn: 'site_ref',
};
const keys = ['tenant_id', 'environment_id', 'legal_entity_id', 'record_id'];
const registered = (
  table: string,
  body: Record<string, unknown>,
  columns: unknown[],
  links: unknown[],
  measures: { measureId: string; operator: Record<string, unknown> }[],
) =>
  ({
    queryId: 'q',
    revision: { body: { version: 'grouped-report/v2', ...body } },
    columns,
    links,
    measures: measures.map((m) => ({ ...m, label: m.measureId })),
    accessPath: { table, index: table + '_access', keys },
  }) as unknown as RegisteredReport;
const operatorSpec = (id: string, operator: string, operand?: string) =>
  ({
    id,
    operator,
    scale: operand === 'balance' ? 18 : 0,
    ...(operand && { operand }),
    ...(operand === 'balance' && {
      type: 'decimal',
      currency: { ...stored, fieldId: 'currency' },
    }),
  }) as ReportMeasureSpec;

test('the v2 reader applies grain and link policy, company scope, the required parent, typed equality, zoned periods and minor-unit averages exactly as the reference', async () => {
  const tenantId = randomUUID();
  const environmentId = randomUUID();
  const north = randomUUID();
  const south = randomUUID();
  await withEphemeralPostgres('report-v2-provider', async ({ pool }) => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('CREATE SCHEMA north_star_module');
      await client.query('CREATE SCHEMA platform');
      await client.query(
        'CREATE TABLE platform.inventory_tenant_calendars(tenant_id uuid, time_zone text, business_day_boundary time)',
      );
      await client.query(
        "INSERT INTO platform.inventory_tenant_calendars VALUES ($1,'America/Toronto','04:00')",
        [tenantId],
      );
      const scope =
        'tenant_id uuid, environment_id uuid, legal_entity_id uuid, record_id uuid, archived_at timestamptz, visible boolean';
      for (const [table, columns] of [
        ['t_site', 'zone text'],
        ['t_vendor', 'region text, site_ref uuid'],
        [
          't_bill',
          'balance numeric(38,18), currency varchar(3), due timestamptz, stamp timestamptz, vendor_ref uuid',
        ],
        ['t_line', 'bill_ref uuid'],
      ] as const) {
        await client.query(
          `CREATE TABLE north_star_module.${table}(${scope}, ${columns})`,
        );
        await client.query(
          `CREATE INDEX ${table}_access ON north_star_module.${table} (${keys.join(',')})`,
        );
      }
      const insert = (
        table: string,
        company: string,
        values: Record<string, unknown>,
        visible = true,
      ) => {
        const id = randomUUID();
        const names = Object.keys(values);
        return client
          .query(
            `INSERT INTO north_star_module.${table}(tenant_id,environment_id,legal_entity_id,record_id,visible${names.map((n) => ',' + n).join('')}) VALUES ($1,$2,$3,$4,$5${names.map((_, i) => ',$' + (i + 6)).join('')})`,
            [
              tenantId,
              environmentId,
              company,
              id,
              visible,
              ...Object.values(values),
            ],
          )
          .then(() => id);
      };
      const s1 = await insert('t_site', north, { zone: 'Z1' });
      const s2 = await insert('t_site', north, { zone: 'Z2' }, false);
      const v1 = await insert('t_vendor', north, {
        region: 'east',
        site_ref: s1,
      });
      const v2 = await insert('t_vendor', north, {
        region: 'west',
        site_ref: s2,
      });
      const v3 = await insert('t_vendor', north, { region: 'north' }, false);
      const vS = await insert('t_vendor', south, { region: 'east' });
      const bill = (
        company: string,
        vendor: string | null,
        currency: string,
        balance: string | null,
        due: string | null,
        stamp: string,
        visible = true,
      ) =>
        insert(
          't_bill',
          company,
          {
            vendor_ref: vendor,
            currency,
            balance,
            due: due && due + 'T00:00:00Z',
            stamp,
          },
          visible,
        );
      // North facts, then hidden and other-company rows that must not count.
      const facts = [
        [v1, 'east', 'Z1', 'CAD', '1.00', '2026-03-01', '2026-03-08T07:30:00Z'],
        [v1, 'east', 'Z1', 'CAD', '2.25', '2026-03-01', '2026-03-08T08:30:00Z'],
        [v2, 'west', null, 'USD', '3.10', '2026-02-01', '2026-11-01T07:30:00Z'],
        [v3, null, null, 'USD', '4.00', null, '2026-11-01T09:30:00Z'],
        [null, null, null, 'CAD', null, '2026-11-02', '2026-11-02T12:00:00Z'],
        // A North bill pointing at South's vendor: Restricted, never "east".
        [vS, null, null, 'CAD', '7.00', '2026-03-01', '2026-03-02T12:00:00Z'],
      ] as const;
      const bills: string[] = [];
      for (const [vendor, , , currency, balance, due, stamp] of facts)
        bills.push(await bill(north, vendor, currency, balance, due, stamp));
      const hiddenBill = await bill(
        north,
        v1,
        'CAD',
        '5.00',
        '2026-03-01',
        '2026-03-03T12:00:00Z',
        false,
      );
      const southBill = await bill(
        south,
        vS,
        'CAD',
        '999.00',
        '2026-03-01',
        '2026-03-03T12:00:00Z',
      );
      for (const parent of [bills[0]!, bills[0]!, hiddenBill])
        await insert('t_line', north, { bill_ref: parent });
      await insert('t_line', south, { bill_ref: southBill });

      // The run's business date at the company calendar's day boundary, on
      // both sides of it on a DST date.
      const at = async (instant: string) =>
        (await reportHorizon(client, tenantId, new Date(instant))).businessDate;
      assert.equal(await at('2026-03-08T07:30:00Z'), '2026-03-07');
      assert.equal(await at('2026-03-08T08:30:00Z'), '2026-03-08');
      assert.equal(await at('2026-11-01T07:30:00Z'), '2026-10-31');
      assert.equal(await at('2026-11-01T09:30:00Z'), '2026-11-01');
      const horizon: ReportHorizon = await reportHorizon(
        client,
        tenantId,
        new Date('2026-11-03T12:00:00Z'),
      );
      assert.equal(horizon.businessDate, '2026-11-03');
      const calendar = {
        businessDate: horizon.businessDate,
        zone: horizon.zone,
        boundary: horizon.boundary,
      };

      const run = async (
        report: RegisteredReport,
        parameters: Record<string, unknown> = {},
      ) => {
        const table = report.accessPath.table;
        const result = await readGroupedSnapshotV2(
          client,
          { physicalTableName: table, legalEntity: {} } as never,
          (report.links ?? []).map((l) => ({
            physicalTableName: l.table,
          })) as never,
          {
            report,
            input: {
              queryId: 'q',
              company: north,
              parameters,
              pageSize: 50,
            },
            remaining: () => 5000,
            view: { tenantId, environmentId },
            scope: { legalEntityIds: [north] },
          } as never,
          horizon,
          {
            grain: (alias, _values, predicates) =>
              predicates.push(alias + '.visible'),
            link: (_i, alias, _values, predicates) =>
              predicates.push(alias + '.visible'),
          },
          REPORT_READER_POLICY,
          (t, i, k) => reportIndexReady(client, t, i, k),
        );
        assert.ok(!('kind' in result), JSON.stringify(result));
        return result;
      };
      const RESTRICTED = RESTRICTED_KEY as { restricted: true };
      const reference = facts.map(
        ([vendor, region, zone, currency, balance, due, stamp]) => ({
          // An unreadable or other-company vendor is Restricted.
          region: vendor === null ? null : (region ?? RESTRICTED),
          vendor: vendor === v1 || vendor === v2 ? vendor : null,
          zone: vendor === null ? null : vendor === v1 ? zone : RESTRICTED,
          currency,
          balance,
          due: due && due + 'T00:00:00.000Z',
          stamp,
        }),
      );

      // Grouped through a link, with money min, max and average per currency.
      const byRegion = registered(
        't_bill',
        {
          dimensions: [
            { kind: 'direct', fieldId: F('vendor_region'), via: [R('vendor')] },
          ],
          filters: [
            { kind: 'equals', fieldId: F('bill_balance') },
            { kind: 'equals', fieldId: F('bill_due') },
          ],
        },
        [...billColumns, vendorRegion],
        [vendorLink],
        [
          { measureId: 'count', operator: { kind: 'count' } },
          {
            measureId: 'vendors',
            operator: { kind: 'distinctTargets', via: [R('vendor')] },
          },
          {
            measureId: 'least',
            operator: { kind: 'min', fieldId: F('bill_balance') },
          },
          {
            measureId: 'most',
            operator: { kind: 'max', fieldId: F('bill_balance') },
          },
          {
            measureId: 'mean',
            operator: { kind: 'average', fieldId: F('bill_balance') },
          },
        ],
      );
      const measures = [
        operatorSpec('count', 'count'),
        operatorSpec('vendors', 'distinctTargets', 'vendor'),
        operatorSpec('least', 'min', 'balance'),
        operatorSpec('most', 'max', 'balance'),
        operatorSpec('mean', 'average', 'balance'),
      ];
      const expected = evaluateReportFacts(
        [{ operand: 'region', kind: 'direct', type: 'text' }],
        measures,
        reference,
        calendar,
      );
      const actual = await run(byRegion);
      assert.deepEqual(actual.groups, expected.groups);
      assert.deepEqual(actual.totals, expected.totals);
      // R8: an amount's average rounds at its currency's minor unit.
      const cad = actual.totals.find(
        (t) => t.partition.kind === 'currency' && t.partition.code === 'CAD',
      )!;
      assert.deepEqual(
        [cad.cells[4]!.value, cad.cells[4]!.exact],
        ['3.42', { sum: '10.250000000000000000', count: 3 }],
      );
      // Typed equality: a number at another scale and a stored instant match.
      const only = async (parameters: Record<string, string>) =>
        (await run(byRegion, parameters)).totals.map((t) => [
          t.partition,
          t.cells[0]!.value,
        ]);
      assert.deepEqual(await only({ [F('bill_balance')]: '2.250' }), [
        [{ kind: 'currency', code: 'CAD' }, '1'],
      ]);
      assert.deepEqual(
        await only({ [F('bill_due')]: '2026-02-01T00:00:00.000Z' }),
        [[{ kind: 'currency', code: 'USD' }, '1']],
      );

      // Two hops: a hidden Site is Restricted even when its vendor is readable.
      const byZone = registered(
        't_bill',
        {
          dimensions: [
            {
              kind: 'direct',
              fieldId: F('site_zone'),
              via: [R('vendor'), R('site')],
            },
          ],
          filters: [],
        },
        [...billColumns, siteZone],
        [vendorLink, siteLink],
        [{ measureId: 'count', operator: { kind: 'count' } }],
      );
      const zoned = await run(byZone);
      assert.deepEqual(
        zoned.groups,
        evaluateReportFacts(
          [{ operand: 'zone', kind: 'direct', type: 'text' }],
          [operatorSpec('count', 'count')],
          reference,
          calendar,
        ).groups,
      );

      // An instant-basis field is zoned at the boundary across both DST
      // changes, by day and by age.
      for (const dimension of [
        { kind: 'calendar', fieldId: F('bill_stamp'), unit: 'day' },
        {
          kind: 'age',
          fieldId: F('bill_stamp'),
          bands: DEFAULT_AGE_BANDS,
          absentLabel: 'No stamp',
        },
      ]) {
        const report = registered(
          't_bill',
          { dimensions: [dimension], filters: [] },
          billColumns,
          [],
          [{ measureId: 'count', operator: { kind: 'count' } }],
        );
        assert.deepEqual(
          (await run(report)).groups,
          evaluateReportFacts(
            [
              {
                operand: 'stamp',
                kind: dimension.kind as 'calendar' | 'age',
                type: 'instant',
                basis: 'instant',
                ...(dimension.kind === 'calendar'
                  ? { unit: 'day' as const }
                  : { bands: DEFAULT_AGE_BANDS }),
              },
            ],
            [operatorSpec('count', 'count')],
            reference,
            calendar,
          ).groups,
        );
      }

      // Line grain: a line counts only while its parent is admitted.
      const parentLink = {
        ...vendorLink,
        via: [R('line_bill')],
        table: 't_bill',
        relationColumn: 'bill_ref',
        required: true,
      };
      const lines = registered(
        't_line',
        { dimensions: [], filters: [] },
        [],
        [parentLink],
        [
          { measureId: 'lines', operator: { kind: 'count' } },
          {
            measureId: 'bills',
            operator: { kind: 'distinctTargets', via: [R('line_bill')] },
          },
        ],
      );
      assert.deepEqual(
        (await run(lines)).totals.map((t) => t.cells.map((c) => c.value)),
        [['2', '1']],
      );
    } finally {
      client.release();
    }
  });
});
