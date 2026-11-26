import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import pg, { type PoolClient } from 'pg';

import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

// ACCOUNTING-1 slice 1a-i (ADR-0093 sections 4, 6, 8 and 9). Two companies
// share ONE tenant and environment throughout. Storage checks insert directly
// as the table owner, bypassing the writer; writer checks go through
// north_star_internal.ledger_write_entry. The journal_read permission is in no
// catalog until slice 1a-ii, so its grant row is hand-seeded on the resource
// northstar.ledger:capability.journal.

const role = (name: string) => `northstar.ledger:role.${name}`;
const READ_PERMISSION = 'northstar.ledger:permission.journal_read';
const READ_RESOURCE = 'northstar.ledger:capability.journal';
const TABLES = [
  'ledger_currencies',
  'ledger_core_roles',
  'ledger_companies',
  'ledger_entry_counters',
  'ledger_accounts',
  'ledger_entries',
  'ledger_lines',
  'ledger_balances',
];
const TENANT_TABLES = TABLES.slice(2);
const READS = [
  'platform.ledger_read_lines(uuid,date,date,bigint,integer,integer)',
  'platform.ledger_read_balances(uuid,date,date)',
];
const INTERNAL = [
  'north_star_internal.ledger_append_only()',
  'north_star_internal.ledger_entry_balanced()',
  'north_star_internal.ledger_require_writer()',
  'north_star_internal.ledger_business_day(uuid,timestamp with time zone)',
  'north_star_internal.ledger_provision_company(uuid)',
  'north_star_internal.ledger_set_books_start(uuid,date)',
  'north_star_internal.ledger_set_closed_through(uuid,date)',
  'north_star_internal.ledger_put_account(uuid,uuid,text,text,text,boolean)',
  'north_star_internal.ledger_civil_date(text)',
  'north_star_internal.ledger_write_entry(uuid,text,jsonb,text,jsonb,jsonb)',
  'north_star_internal.ledger_may_read(uuid)',
];

interface Company {
  id: string;
  cash: string;
  bank: string;
  revenue: string;
  receivable: string;
  opening: string;
}
type Line = Record<string, unknown>;

async function world(t: TestContext, part: 'core' | 'isolation') {
  await withEphemeralPostgres(
    `ledger-${part}`,
    async ({ pool, connection }) => {
      const tenant = randomUUID(),
        environment = randomUUID(),
        principal = randomUUID(),
        policyRole = randomUUID();
      const sessions: PoolClient[] = [];
      const runtime = new pg.Pool({
        ...connection,
        user: 'north_star_runtime',
        max: 2,
      });
      const session = async () => {
        const client = await pool.connect();
        sessions.push(client);
        await client.query(
          "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false)",
          [tenant, environment],
        );
        return client;
      };
      try {
        const admin = await session();
        await runMigrations(admin, await loadMigrations('db/migrations'));
        await admin.query(
          "INSERT INTO platform.tenants(id,slug) VALUES ($1,'ledger')",
          [tenant],
        );
        await admin.query(
          "INSERT INTO platform.environments(tenant_id,id,slug) VALUES ($1,$2,'ledger')",
          [tenant, environment],
        );
        await admin.query(
          "INSERT INTO platform.inventory_tenant_calendars(tenant_id,time_zone,business_day_boundary) VALUES ($1,'America/Vancouver','00:00')",
          [tenant],
        );
        const [w1, w2, w3] = [
          await session(),
          await session(),
          await session(),
        ];

        const company = async (
          booksStart: string | null = '2026-01-01',
        ): Promise<Company> => {
          const c: Company = {
            id: randomUUID(),
            cash: randomUUID(),
            bank: randomUUID(),
            revenue: randomUUID(),
            receivable: randomUUID(),
            opening: randomUUID(),
          };
          await admin.query(
            'SELECT north_star_internal.ledger_provision_company($1)',
            [c.id],
          );
          if (booksStart)
            await admin.query(
              'SELECT north_star_internal.ledger_set_books_start($1,$2)',
              [c.id, booksStart],
            );
          for (const [account, code, kind] of [
            [c.cash, '1000', 'cash'],
            [c.bank, '1010', 'cash'],
            [c.receivable, '1200', 'receivable'],
            [c.opening, '3900', 'opening_balance'],
            [c.revenue, '4000', 'revenue'],
          ] as const)
            await admin.query(
              'SELECT north_star_internal.ledger_put_account($1,$2,$3,$4,$5,true)',
              [c.id, account, code, role(kind), `Account ${code}`],
            );
          return c;
        };
        const operation = (ordinal = 1, receipt: string = randomUUID()) => ({
          operationReceiptId: receipt,
          entryOrdinal: ordinal,
        });
        const write = async (
          client: PoolClient,
          companyId: string,
          kind: string,
          basis: object,
          lines: Line[],
          provenance: object = operation(),
          currency = 'CAD',
        ): Promise<string> =>
          (
            await client.query<{ id: string }>(
              'SELECT north_star_internal.ledger_write_entry($1,$2,$3,$4,$5,$6) AS id',
              [
                companyId,
                kind,
                JSON.stringify(basis),
                currency,
                JSON.stringify(lines),
                JSON.stringify(provenance),
              ],
            )
          ).rows[0]!.id;
        const pair = (
          debit: string,
          credit: string,
          amount = 10500,
        ): Line[] => [
          { accountId: debit, side: 'D', amount },
          { accountId: credit, side: 'C', amount },
        ];
        const manual = (
          client: PoolClient,
          c: Company,
          day: string,
          lines = pair(c.cash, c.revenue),
        ) => write(client, c.id, 'manual', { civil: day }, lines);
        const posting = (record: string = randomUUID()) => ({
          sourceTypeId: 'example.sales:entity.invoice',
          recordId: record,
          sourceHeaderRevision: 1,
          sourceLineSetVersion: 1,
          ruleId: 'example.sales:posting.issued',
          ruleVersion: 1,
        });
        const postingLines = (c: Company): Line[] => [
          { accountId: c.cash, roleId: role('cash'), side: 'D', amount: 500 },
          {
            accountId: c.revenue,
            roleId: role('revenue'),
            side: 'C',
            amount: 500,
          },
        ];
        const waitUntilBlocked = async (blocked: PoolClient) => {
          const pid = (
            await blocked.query<{ pid: number }>(
              'SELECT pg_backend_pid() AS pid',
            )
          ).rows[0]!.pid;
          return async () => {
            for (let attempt = 0; attempt < 400; attempt++) {
              const { rows } = await admin.query<{ waiting: boolean }>(
                'SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting',
                [pid],
              );
              if (rows[0]!.waiting) return;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert.fail('the second session never waited on a lock');
          };
        };
        /** The refusal text, or "admitted", so a red names what happened. */
        const settled = (pending: Promise<unknown>) =>
          pending.then(
            () => 'admitted',
            (error: unknown) => String((error as Error).message),
          );
        const count = async (sql: string, params: unknown[]) =>
          Number(
            (
              await admin.query<{ n: string }>(
                `SELECT count(*) AS n FROM ${sql}`,
                params,
              )
            ).rows[0]!.n,
          );
        /** One storage transaction as the owner, bypassing the writer. */
        const direct = async (
          c: Company,
          lines: Line[],
          entry: Record<string, unknown> = {},
        ) => {
          const entryId = randomUUID();
          const row: Record<string, unknown> = {
            currency_code: 'CAD',
            entry_kind: 'manual',
            operation_receipt_id: randomUUID(),
            entry_ordinal: 1,
            entry_number: 900000 + Math.floor(Math.random() * 99999),
            ...entry,
          };
          await w3.query('BEGIN');
          try {
            await w3.query(
              `INSERT INTO platform.ledger_entries(tenant_id,environment_id,entry_id,company_id,currency_code,accounting_date,
               recorded_at,entry_kind,record_id,operation_receipt_id,entry_ordinal,entry_number,inputs_digest)
             VALUES ($1,$2,$3,$4,$5,'2026-02-01',clock_timestamp(),$6,$7,$8,$9,$10,repeat('a',64))`,
              [
                tenant,
                environment,
                entryId,
                c.id,
                row.currency_code,
                row.entry_kind,
                row.record_id ?? null,
                row.operation_receipt_id,
                row.entry_ordinal,
                row.entry_number,
              ],
            );
            let n = 0;
            for (const line of lines) {
              n++;
              await w3.query(
                `INSERT INTO platform.ledger_lines(tenant_id,environment_id,entry_id,line_number,company_id,account_id,role_id,
                 side,currency_code,amount,counterparty_party_id,dimension_set_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [
                  tenant,
                  environment,
                  entryId,
                  n,
                  line.companyId ?? c.id,
                  line.accountId,
                  role('cash'),
                  line.side,
                  line.currency ?? 'CAD',
                  line.amount,
                  line.counterparty ?? null,
                  line.dimensionSet ?? null,
                ],
              );
            }
            await w3.query('COMMIT');
          } catch (error) {
            await w3.query('ROLLBACK');
            throw error;
          }
        };

        const a = await company(),
          b = await company();

        if (part === 'core') {
          // ---------------------------------------------------------------- storage
          await t.test(
            'storage refuses an unbalanced entry at commit',
            async () => {
              await assert.rejects(
                direct(a, [
                  { accountId: a.cash, side: 'D', amount: 100 },
                  { accountId: a.revenue, side: 'C', amount: 90 },
                ]),
                /ledger\.unbalanced/u,
                'an unbalanced entry committed',
              );
            },
          );
          await t.test(
            'storage refuses an entry with no lines at commit',
            async () => {
              await assert.rejects(
                direct(a, []),
                /ledger\.tooFewLines/u,
                'an entry with no lines committed',
              );
            },
          );
          await t.test(
            'storage refuses a line in another currency than its entry',
            async () => {
              await assert.rejects(
                direct(a, [
                  {
                    accountId: a.cash,
                    side: 'D',
                    amount: 100,
                    currency: 'USD',
                  },
                  {
                    accountId: a.revenue,
                    side: 'C',
                    amount: 100,
                    currency: 'USD',
                  },
                ]),
                /ledger_lines_entry_currency/u,
                'a USD line joined a CAD entry',
              );
            },
          );
          await t.test(
            'storage refuses a zero or negative amount',
            async () => {
              for (const amount of [0, -100])
                await assert.rejects(
                  direct(a, [
                    { accountId: a.cash, side: 'D', amount },
                    { accountId: a.revenue, side: 'C', amount },
                  ]),
                  /ledger_lines_amount_positive/u,
                  'a non-positive amount was stored',
                );
            },
          );
          await t.test(
            "storage refuses another company's account on an entry",
            async () => {
              await assert.rejects(
                direct(a, [
                  { accountId: b.cash, side: 'D', amount: 100 },
                  { accountId: a.revenue, side: 'C', amount: 100 },
                ]),
                /ledger_lines_account_company/u,
                "company A's entry stored company B's account",
              );
            },
          );
          await t.test('storage refuses a counterparty on a line', async () => {
            await assert.rejects(
              direct(a, [
                {
                  accountId: a.cash,
                  side: 'D',
                  amount: 100,
                  counterparty: randomUUID(),
                },
                { accountId: a.revenue, side: 'C', amount: 100 },
              ]),
              /ledger_lines_counterparty_reserved/u,
              'a reserved counterparty was stored',
            );
          });
          await t.test(
            'storage refuses a dimension set on a line',
            async () => {
              await assert.rejects(
                direct(a, [
                  {
                    accountId: a.cash,
                    side: 'D',
                    amount: 100,
                    dimensionSet: randomUUID(),
                  },
                  { accountId: a.revenue, side: 'C', amount: 100 },
                ]),
                /ledger_lines_dimension_set_reserved/u,
                'a reserved dimension set was stored',
              );
            },
          );
          await t.test(
            'storage refuses a posting entry without its source',
            async () => {
              await assert.rejects(
                direct(a, pair(a.cash, a.revenue), {
                  entry_kind: 'posting',
                  operation_receipt_id: null,
                  entry_ordinal: null,
                }),
                /ledger_entries_kind_shape/u,
                'a posting entry without a source was stored',
              );
            },
          );
          await t.test(
            'entries and lines refuse update, delete and truncate even for the owner',
            async () => {
              await manual(w1, a, '2026-01-15');
              for (const sql of [
                "UPDATE platform.ledger_entries SET reason_code='edited'",
                'DELETE FROM platform.ledger_entries',
                'TRUNCATE platform.ledger_entries CASCADE',
                'UPDATE platform.ledger_lines SET amount=amount+1',
                'DELETE FROM platform.ledger_lines',
                'TRUNCATE platform.ledger_lines',
              ])
                await assert.rejects(
                  w3.query(sql),
                  /ledger\.appendOnly/u,
                  `the owner ran: ${sql}`,
                );
            },
          );
          await t.test(
            'no non-owner role holds a ledger table privilege and RLS is forced',
            async () => {
              const { rows } = await admin.query<{ entry: string }>(
                `SELECT r.rolname || ' ' || c.relname || ' ' || p.privilege AS entry
             FROM pg_roles r CROSS JOIN pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'platform'
             CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
            WHERE c.relname = ANY($1) AND NOT r.rolsuper AND r.oid <> c.relowner
              -- PostgreSQL's predefined pg_* roles are reached only by membership,
              -- and every member is itself a row of pg_roles checked here.
              AND (r.rolcanlogin OR r.rolname !~ '^pg_')
              AND has_table_privilege(r.oid, c.oid, p.privilege)
            ORDER BY 1`,
                [TABLES],
              );
              assert.deepEqual(
                rows,
                [],
                'a non-owner role holds a ledger table privilege',
              );
              const rls = await admin.query<{ relname: string }>(
                `SELECT relname FROM pg_class WHERE relnamespace = 'platform'::regnamespace AND relname = ANY($1)
              AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
                [TENANT_TABLES],
              );
              assert.deepEqual(
                rls.rows.map((row) => row.relname),
                [...TENANT_TABLES].sort(),
                'a tenant ledger table does not force row-level security',
              );
              const runtimeClient = await runtime.connect();
              try {
                await assert.rejects(
                  runtimeClient.query(
                    "UPDATE platform.ledger_entries SET reason_code='x'",
                  ),
                  /permission denied/u,
                  'the runtime role reached a ledger table',
                );
              } finally {
                runtimeClient.release();
              }
            },
          );
          await t.test(
            'only north_star_runtime executes the two reads and no one the internal functions',
            async () => {
              const { rows } = await admin.query<{ entry: string }>(
                `SELECT r.rolname || ' ' || f AS entry FROM pg_roles r CROSS JOIN unnest($1::text[]) f
            WHERE NOT r.rolsuper AND r.oid <> (SELECT proowner FROM pg_proc WHERE oid = f::regprocedure)
              AND has_function_privilege(r.oid, f::regprocedure, 'EXECUTE') ORDER BY 1`,
                [[...READS, ...INTERNAL]],
              );
              assert.deepEqual(
                rows.map((row) => row.entry),
                READS.map((f) => `north_star_runtime ${f}`).sort(),
                'a ledger function is executable beyond its grant',
              );
            },
          );

          // ----------------------------------------------------------------- writer
          await t.test(
            'a manual journal posts with roles copied from the stored accounts',
            async () => {
              const c = await company();
              const id = await write(
                w1,
                c.id,
                'manual',
                { civil: '2026-02-10' },
                [
                  {
                    accountId: c.cash,
                    roleId: role('revenue'),
                    side: 'D',
                    amount: 10500,
                  },
                  { accountId: c.revenue, side: 'C', amount: 10500 },
                ],
              );
              const lines = await admin.query<{
                role_id: string;
                amount: string;
              }>(
                'SELECT role_id, amount FROM platform.ledger_lines WHERE entry_id=$1 ORDER BY line_number',
                [id],
              );
              assert.deepEqual(
                lines.rows.map((row) => row.role_id),
                [role('cash'), role('revenue')],
                'a manual line took its role from caller input',
              );
              const entry = await admin.query<{
                entry_number: string;
                accounting_date: string;
                recorded_at: Date;
              }>(
                "SELECT entry_number, to_char(accounting_date,'YYYY-MM-DD') AS accounting_date, recorded_at FROM platform.ledger_entries WHERE entry_id=$1",
                [id],
              );
              assert.equal(entry.rows[0]!.entry_number, '1');
              assert.equal(entry.rows[0]!.accounting_date, '2026-02-10');
              const balances = await admin.query<{
                debit_total: string;
                credit_total: string;
                horizon_matches: boolean;
              }>(
                `SELECT debit_total, credit_total, recorded_horizon = (SELECT recorded_at FROM platform.ledger_entries WHERE entry_id = $2) AS horizon_matches FROM platform.ledger_balances
            WHERE company_id=$1 ORDER BY debit_total DESC`,
                [c.id, id],
              );
              assert.deepEqual(
                balances.rows.map((row) => [
                  row.debit_total,
                  row.credit_total,
                  row.horizon_matches,
                ]),
                [
                  ['10500', '0', true],
                  ['0', '10500', true],
                ],
              );
            },
          );
          await t.test(
            'a manual line on a control-role account is refused',
            async () => {
              await assert.rejects(
                manual(w1, a, '2026-02-10', pair(a.receivable, a.revenue)),
                /ledger\.controlRoleRefused/u,
                'a manual line posted to a control-role account',
              );
            },
          );
          await t.test(
            'a posting line whose role class misfits the account is refused',
            async () => {
              await assert.rejects(
                write(
                  w1,
                  a.id,
                  'posting',
                  { instant: '2026-02-10T20:00:00Z' },
                  [
                    {
                      accountId: a.cash,
                      roleId: role('revenue'),
                      side: 'D',
                      amount: 500,
                    },
                    {
                      accountId: a.revenue,
                      roleId: role('revenue'),
                      side: 'C',
                      amount: 500,
                    },
                  ],
                  posting(),
                ),
                /ledger\.roleMisfit/u,
                'a revenue leg posted to a cash account',
              );
            },
          );
          await t.test('an inactive account is refused at entry', async () => {
            const c = await company();
            await admin.query(
              "SELECT north_star_internal.ledger_put_account($1,$2,'1010',$3,'Bank',false)",
              [c.id, c.bank, role('cash')],
            );
            await assert.rejects(
              manual(w1, c, '2026-02-10', pair(c.bank, c.revenue)),
              /ledger\.accountInactive/u,
              'an entry posted to an inactive account',
            );
          });
          await t.test(
            "the writer refuses another company's account",
            async () => {
              await assert.rejects(
                manual(w1, a, '2026-02-10', pair(b.cash, a.revenue)),
                /ledger\.accountUnavailable/u,
                "company A's entry reached company B's account",
              );
            },
          );
          await t.test('an account kind never changes', async () => {
            await assert.rejects(
              admin.query(
                "SELECT north_star_internal.ledger_put_account($1,$2,'1000',$3,'Cash',true)",
                [a.id, a.cash, role('expense')],
              ),
              /ledger\.accountKindFixed/u,
              'an account changed its kind',
            );
          });
          await t.test('no entry posts before books start is set', async () => {
            const c = await company(null);
            await assert.rejects(
              manual(w1, c, '2026-02-10'),
              /ledger\.booksNotStarted/u,
              'an entry posted with no books start',
            );
          });
          await t.test(
            'closed-through refuses its own date and admits the next day',
            async () => {
              const c = await company();
              await admin.query(
                "SELECT north_star_internal.ledger_set_closed_through($1,'2026-03-31')",
                [c.id],
              );
              await assert.rejects(
                manual(w1, c, '2026-03-31'),
                /ledger\.closedBooks/u,
                'an entry posted on the closed-through date',
              );
              await manual(w1, c, '2026-04-01');
            },
          );
          await t.test(
            'a manual entry before books start is refused',
            async () => {
              await assert.rejects(
                manual(w1, a, '2025-12-31'),
                /ledger\.beforeBooksStart/u,
                'a manual entry predates books start',
              );
            },
          );
          await t.test('an opening entry may predate books start', async () => {
            const c = await company();
            await write(
              w1,
              c.id,
              'opening',
              { civil: '2025-12-31' },
              pair(c.cash, c.opening, 2500),
            );
          });
          await t.test('a source kind refuses a civil date basis', async () => {
            await assert.rejects(
              write(
                w1,
                a.id,
                'posting',
                { civil: '2026-02-10' },
                postingLines(a),
                posting(),
              ),
              /ledger\.dateBasisRefused/u,
              'a posting entry took a caller-typed civil date',
            );
          });
          await t.test(
            'an instant is dated by the company calendar, not the UTC date',
            async () => {
              const c = await company();
              await admin.query(
                "SELECT north_star_internal.ledger_set_closed_through($1,'2026-03-31')",
                [c.id],
              );
              // 05:30 UTC on April 1 is 22:30 on March 31 in Vancouver: closed books.
              await assert.rejects(
                write(
                  w1,
                  c.id,
                  'manual',
                  { instant: '2026-04-01T05:30:00Z' },
                  pair(c.cash, c.revenue),
                ),
                /ledger\.closedBooks/u,
                'an instant was dated by its UTC date into closed books',
              );
              const id = await write(
                w1,
                c.id,
                'manual',
                { instant: '2026-05-01T05:30:00Z' },
                pair(c.cash, c.revenue),
              );
              const { rows } = await admin.query<{ day: string }>(
                "SELECT to_char(accounting_date,'YYYY-MM-DD') AS day FROM platform.ledger_entries WHERE entry_id=$1",
                [id],
              );
              assert.equal(
                rows[0]!.day,
                '2026-04-30',
                'an instant was dated by its UTC date',
              );
            },
          );
          await t.test(
            'an instant without Z or a numeric offset is refused',
            async () => {
              const c = await company();
              // Without an offset PostgreSQL would read this in the session
              // time zone, a hidden zone input (review R2).
              await assert.rejects(
                write(
                  w1,
                  c.id,
                  'manual',
                  { instant: '2026-02-10T20:00:00' },
                  pair(c.cash, c.revenue),
                ),
                /ledger\.instantWithoutOffset/u,
                'an instant without an offset was read in the session time zone',
              );
              for (const instant of [
                '2026-02-10T20:00:00 America/Vancouver',
                'now',
                '2026-02-10',
                1770753600,
              ])
                await assert.rejects(
                  write(
                    w1,
                    c.id,
                    'manual',
                    { instant },
                    pair(c.cash, c.revenue),
                  ),
                  /ledger\.instantWithoutOffset/u,
                  `an instant was admitted: ${String(instant)}`,
                );
              await write(
                w1,
                c.id,
                'manual',
                { instant: '2026-02-10T12:00:00.250-08:00' },
                pair(c.cash, c.revenue),
              );
            },
          );
          await t.test(
            'a writer call committed as the runtime role passes the deferred balance check',
            async () => {
              const c = await company();
              // TEST-ONLY stand-in for a 1a-ii operation: an owner-owned
              // definer that calls the writer, executable by the runtime role.
              // The runtime session commits, so the deferred balance trigger
              // fires as north_star_runtime (review R5). Every other test
              // commits as the owner.
              await admin.query(
                `CREATE FUNCTION north_star_internal.ledger_test_runtime_write(company uuid, lines jsonb) RETURNS uuid
                 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
                   SELECT north_star_internal.ledger_write_entry(company, 'manual', '{"civil":"2026-02-10"}', 'CAD', lines,
                     jsonb_build_object('operationReceiptId', gen_random_uuid(), 'entryOrdinal', 1)) $$`,
              );
              await admin.query(
                'GRANT EXECUTE ON FUNCTION north_star_internal.ledger_test_runtime_write(uuid,jsonb) TO north_star_runtime',
              );
              const client = await runtime.connect();
              try {
                await client.query(
                  "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false)",
                  [tenant, environment],
                );
                await client.query('BEGIN');
                await client.query(
                  'SELECT north_star_internal.ledger_test_runtime_write($1,$2)',
                  [c.id, JSON.stringify(pair(c.cash, c.revenue))],
                );
                const outcome = await settled(client.query('COMMIT'));
                assert.equal(
                  outcome,
                  'admitted',
                  `a runtime-originated entry was refused at commit: ${outcome}`,
                );
              } finally {
                await client.query('ROLLBACK').catch(() => undefined);
                client.release();
                await admin.query(
                  'DROP FUNCTION north_star_internal.ledger_test_runtime_write(uuid,jsonb)',
                );
              }
              assert.equal(
                await count('platform.ledger_entries WHERE company_id=$1', [
                  c.id,
                ]),
                1,
              );
            },
          );
          await t.test(
            'a projection row that drifts from its lines refuses the next write',
            async () => {
              const c = await company();
              await manual(w1, c, '2026-02-10');
              await admin.query(
                'UPDATE platform.ledger_balances SET debit_total = debit_total + 1 WHERE company_id=$1 AND account_id=$2',
                [c.id, c.cash],
              );
              await assert.rejects(
                manual(w1, c, '2026-02-11'),
                /ledger\.projectionMismatch/u,
                'a write committed over a drifted projection',
              );
            },
          );
          await t.test(
            'the writer refuses any isolation but READ COMMITTED',
            async () => {
              await w1.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
              try {
                await assert.rejects(
                  manual(w1, a, '2026-02-12'),
                  /ledger\.requiresReadCommitted/u,
                  'the writer ran under REPEATABLE READ',
                );
              } finally {
                await w1.query('ROLLBACK');
              }
            },
          );

          // ------------------------------------------------------------------ races
          await t.test(
            'two posters racing on one source version commit one entry',
            async () => {
              const c = await company();
              const provenance = posting();
              await w1.query('BEGIN');
              await w2.query('BEGIN');
              try {
                await write(
                  w1,
                  c.id,
                  'posting',
                  { instant: '2026-02-10T20:00:00Z' },
                  postingLines(c),
                  provenance,
                );
                const blocked = await waitUntilBlocked(w2);
                // The handler is attached at creation (review R1): a refusal
                // that reaches Node before COMMIT's reply is never unhandled.
                const second = settled(
                  write(
                    w2,
                    c.id,
                    'posting',
                    { instant: '2026-02-10T20:00:00Z' },
                    postingLines(c),
                    provenance,
                  ),
                );
                await blocked();
                await w1.query('COMMIT');
                const outcome = await second;
                assert.match(
                  outcome,
                  /ledger_entries_posting_key/u,
                  `a raced duplicate posting was admitted: ${outcome}`,
                );
              } finally {
                await w1.query('ROLLBACK').catch(() => undefined);
                await w2.query('ROLLBACK');
              }
              assert.equal(
                await count('platform.ledger_entries WHERE record_id=$1', [
                  provenance.recordId,
                ]),
                1,
              );
            },
          );
          await t.test(
            'two operations racing on one receipt and ordinal commit one entry',
            async () => {
              const c = await company();
              const receipt = operation(1);
              await w1.query('BEGIN');
              await w2.query('BEGIN');
              try {
                await write(
                  w1,
                  c.id,
                  'manual',
                  { civil: '2026-02-10' },
                  pair(c.cash, c.revenue),
                  receipt,
                );
                const blocked = await waitUntilBlocked(w2);
                const second = settled(
                  write(
                    w2,
                    c.id,
                    'manual',
                    { civil: '2026-02-10' },
                    pair(c.cash, c.revenue),
                    receipt,
                  ),
                );
                await blocked();
                await w1.query('COMMIT');
                const outcome = await second;
                assert.match(
                  outcome,
                  /ledger_entries_operation_key/u,
                  `a raced duplicate operation entry was admitted: ${outcome}`,
                );
              } finally {
                await w1.query('ROLLBACK').catch(() => undefined);
                await w2.query('ROLLBACK');
              }
            },
          );
          await t.test(
            'a writer waiting on a close re-reads closed-through and refuses',
            async () => {
              const c = await company();
              await w1.query('BEGIN');
              try {
                await w1.query(
                  "SELECT north_star_internal.ledger_set_closed_through($1,'2026-03-31')",
                  [c.id],
                );
                const blocked = await waitUntilBlocked(w2);
                const writer = settled(manual(w2, c, '2026-03-31'));
                await blocked();
                await w1.query('COMMIT');
                const outcome = await writer;
                assert.match(
                  outcome,
                  /ledger\.closedBooks/u,
                  `a writer posted into a period closed while it waited: ${outcome}`,
                );
              } finally {
                await w1.query('ROLLBACK').catch(() => undefined);
              }
            },
          );
          await t.test(
            'a writer waiting on a deactivation re-reads the account and refuses',
            async () => {
              const c = await company();
              await w1.query('BEGIN');
              try {
                await w1.query(
                  "SELECT north_star_internal.ledger_put_account($1,$2,'1010',$3,'Bank',false)",
                  [c.id, c.bank, role('cash')],
                );
                const blocked = await waitUntilBlocked(w2);
                const writer = settled(
                  manual(w2, c, '2026-02-10', pair(c.bank, c.revenue)),
                );
                await blocked();
                await w1.query('COMMIT');
                const outcome = await writer;
                assert.match(
                  outcome,
                  /ledger\.accountInactive/u,
                  `a writer posted to an account deactivated while it waited: ${outcome}`,
                );
              } finally {
                await w1.query('ROLLBACK').catch(() => undefined);
              }
            },
          );
          await t.test(
            'a second writer call in one transaction refuses by name (R4 tripwire)',
            async () => {
              // Review R4: "counter last" is per writer call. T1's first entry
              // holds the counter, T2 holds balance row Y and waits on the
              // counter, and T1's second entry asks for Y. Without the
              // tripwire the two deadlock; with it T1's second call refuses
              // by name before it takes any lock.
              const c = await company();
              await w1.query('BEGIN');
              await w2.query('BEGIN');
              try {
                await manual(w1, c, '2026-02-10', pair(c.cash, c.revenue));
                const t2Blocked = await waitUntilBlocked(w2);
                const t2 = settled(
                  manual(w2, c, '2026-02-10', pair(c.bank, c.opening)),
                );
                await t2Blocked();
                const t1Second = settled(
                  manual(w1, c, '2026-02-10', pair(c.bank, c.cash)),
                );
                // Whichever settles first holds its locks until it rolls
                // back, so the other finishes only after that ROLLBACK.
                const first = await Promise.race([
                  t1Second.then((outcome) => ({ outcome, session: w1 })),
                  t2.then((outcome) => ({ outcome, session: w2 })),
                ]);
                await first.session.query('ROLLBACK');
                const outcomes = await Promise.all([t1Second, t2]);
                assert.match(
                  outcomes[0],
                  /ledger\.oneEntryPerTransaction/u,
                  `a second writer call in one transaction was not refused by name: ${outcomes.join(' | ')}`,
                );
                assert.equal(outcomes[1], 'admitted');
              } finally {
                await w1.query('ROLLBACK').catch(() => undefined);
                await w2.query('ROLLBACK').catch(() => undefined);
              }
            },
          );
          await t.test(
            'the R4 tripwire outlives the writer SET clause and clears on savepoint rollback',
            async () => {
              const c = await company();
              await w1.query('BEGIN');
              try {
                await w1.query('SAVEPOINT first_entry');
                await manual(w1, c, '2026-02-10');
                await w1.query('ROLLBACK TO SAVEPOINT first_entry');
                // The rolled-back call left no marker and no locks.
                await manual(w1, c, '2026-02-11');
                await assert.rejects(
                  manual(w1, c, '2026-02-12'),
                  /ledger\.oneEntryPerTransaction/u,
                  'a second writer call in one transaction was admitted',
                );
              } finally {
                await w1.query('ROLLBACK').catch(() => undefined);
              }
            },
          );
          await t.test(
            'an account created while a writer waits is held by its line read (R6)',
            async () => {
              // Review R6. The writer waits on account Y (bank), held by a
              // relabel; meanwhile account X is created and committed, so the
              // ascending account lock never sees X and only the per-line read
              // can hold it. The writer then waits on Y's balance row, before
              // any foreign-key check touches X. A deactivation of X must wait
              // for the writer, or the writer posts to an inactive account.
              const c = await company();
              const x = randomUUID();
              const w4 = await session();
              await manual(w1, c, '2026-02-05', pair(c.bank, c.revenue));
              await w4.query('BEGIN');
              await w3.query('BEGIN');
              try {
                await w4.query(
                  'SELECT FROM platform.ledger_balances WHERE company_id=$1 AND account_id=$2 FOR UPDATE',
                  [c.id, c.bank],
                );
                await w3.query(
                  "SELECT north_star_internal.ledger_put_account($1,$2,'1010',$3,'Bank relabelled',true)",
                  [c.id, c.bank, role('cash')],
                );
                const writerBlocked = await waitUntilBlocked(w1);
                await w1.query('BEGIN');
                const writer = settled(
                  manual(w1, c, '2026-02-10', [
                    { accountId: c.bank, side: 'D', amount: 500 },
                    { accountId: x, side: 'C', amount: 500 },
                  ]),
                );
                await writerBlocked();
                await admin.query(
                  "SELECT north_star_internal.ledger_put_account($1,$2,'4100',$3,'New revenue',true)",
                  [c.id, x, role('revenue')],
                );
                await w3.query('COMMIT');
                // Now waiting on the bank balance row, past the line read.
                await writerBlocked();
                const pid = (
                  await w2.query<{ pid: number }>(
                    'SELECT pg_backend_pid() AS pid',
                  )
                ).rows[0]!.pid;
                let finished: string | undefined;
                const deactivation = settled(
                  w2.query(
                    "SELECT north_star_internal.ledger_put_account($1,$2,'4100',$3,'New revenue',false)",
                    [c.id, x, role('revenue')],
                  ),
                ).then((outcome) => (finished = outcome));
                let waiting = false;
                for (
                  let attempt = 0;
                  attempt < 400 && !waiting && finished === undefined;
                  attempt++
                ) {
                  waiting = (
                    await admin.query<{ waiting: boolean }>(
                      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting',
                      [pid],
                    )
                  ).rows[0]!.waiting;
                  if (!waiting)
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                await w4.query('COMMIT');
                const outcome = await writer;
                await w1.query('COMMIT');
                await deactivation;
                assert.ok(
                  waiting,
                  `a deactivation committed under an uncommitted writer's line: ${String(finished)}; the writer: ${outcome}`,
                );
              } finally {
                await w4.query('ROLLBACK').catch(() => undefined);
                await w3.query('ROLLBACK').catch(() => undefined);
                await w1.query('ROLLBACK').catch(() => undefined);
              }
            },
          );
          await t.test(
            'writers lock balance rows in ascending order and never deadlock',
            async () => {
              const c = await company();
              const [low, high] = [c.cash, c.bank].sort();
              await manual(w1, c, '2026-02-10', pair(low!, high!));
              await w3.query('BEGIN');
              try {
                await w3.query(
                  'SELECT FROM platform.ledger_balances WHERE company_id=$1 AND account_id=$2 FOR UPDATE',
                  [c.id, low],
                );
                const firstBlocked = await waitUntilBlocked(w1);
                const first = manual(w1, c, '2026-02-11', pair(low!, high!, 7));
                first.catch(() => undefined); // handled at creation (review R1)
                await firstBlocked();
                const secondBlocked = await waitUntilBlocked(w2);
                const second = manual(
                  w2,
                  c,
                  '2026-02-12',
                  pair(high!, low!, 9),
                );
                second.catch(() => undefined);
                await secondBlocked();
                await w3.query('COMMIT');
                const outcomes = await Promise.allSettled([first, second]);
                for (const outcome of outcomes)
                  if (outcome.status === 'rejected')
                    assert.fail(
                      `a writer failed on lock order: ${String((outcome.reason as Error).message)}`,
                    );
              } finally {
                await w3.query('ROLLBACK').catch(() => undefined);
              }
            },
          );
        }
        if (part === 'isolation') {
          // ----------------------------------------------------- company isolation
          const a2 = await company(),
            b2 = await company();
          await t.test(
            'closing one company never refuses another in the same tenant',
            async () => {
              await admin.query(
                "SELECT north_star_internal.ledger_set_closed_through($1,'2026-03-31')",
                [a2.id],
              );
              await manual(w1, a2, '2026-04-02');
              await assert.rejects(
                manual(w1, a2, '2026-03-15'),
                /ledger\.closedBooks/u,
                'a closed company admitted an entry',
              );
              await manual(w1, b2, '2026-03-15');
              const numbers = await admin.query<{
                company_id: string;
                entry_number: string;
              }>(
                'SELECT company_id, entry_number FROM platform.ledger_entries WHERE company_id = ANY($1) ORDER BY company_id',
                [[a2.id, b2.id]],
              );
              assert.deepEqual(
                numbers.rows.map((row) => row.entry_number),
                ['1', '1'],
                'entry numbers are not per company',
              );
            },
          );
          await t.test(
            'a company-scoped principal reads only its own company',
            async () => {
              await admin.query(
                "INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES ($1,$2,$3,'bookkeeper')",
                [tenant, environment, policyRole],
              );
              await admin.query(
                'INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id) VALUES ($1,$2,$3,$4,$5)',
                [
                  tenant,
                  environment,
                  policyRole,
                  READ_PERMISSION,
                  READ_RESOURCE,
                ],
              );
              await admin.query(
                'INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id) VALUES ($1,$2,gen_random_uuid(),$3,$4,$5)',
                [tenant, environment, principal, policyRole, a2.id],
              );
              const reader = await runtime.connect();
              try {
                await reader.query(
                  "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false),set_config('north_star.principal_id',$3,false)",
                  [tenant, environment, principal],
                );
                const own = await reader.query(
                  "SELECT * FROM platform.ledger_read_lines($1,'2026-01-01','2026-12-31',NULL,NULL,500)",
                  [a2.id],
                );
                assert.equal(own.rows.length, 2);
                await assert.rejects(
                  reader.query(
                    "SELECT * FROM platform.ledger_read_lines($1,'2026-01-01','2026-12-31',NULL,NULL,500)",
                    [b2.id],
                  ),
                  /ledger\.readUnavailable/u,
                  "a principal scoped to company A read company B's lines",
                );
                await assert.rejects(
                  reader.query(
                    "SELECT * FROM platform.ledger_read_balances($1,'2026-01-01','2026-12-01')",
                    [b2.id],
                  ),
                  /ledger\.readUnavailable/u,
                  "a principal scoped to company A read company B's balances",
                );
                // The guard is on writers only: a read inside REPEATABLE READ answers.
                await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
                const balances = await reader.query(
                  "SELECT * FROM platform.ledger_read_balances($1,'2026-01-01','2026-12-01')",
                  [a2.id],
                );
                await reader.query('COMMIT');
                assert.equal(balances.rows.length, 2);
              } finally {
                reader.release();
              }
            },
          );
          await t.test(
            'a line page is bounded and continues by keyset',
            async () => {
              await manual(w1, a2, '2026-04-03');
              const reader = await runtime.connect();
              try {
                await reader.query(
                  "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false),set_config('north_star.principal_id',$3,false)",
                  [tenant, environment, principal],
                );
                const page = (
                  after: [number, number] | [null, null],
                  size: number,
                ) =>
                  reader.query<{ entry_number: string; line_number: number }>(
                    "SELECT * FROM platform.ledger_read_lines($1,'2026-01-01','2026-12-31',$2,$3,$4)",
                    [a2.id, after[0], after[1], size],
                  );
                const first = await page([null, null], 3);
                assert.equal(
                  first.rows.length,
                  3,
                  'a line page exceeded its size',
                );
                const last = first.rows.at(-1)!;
                const rest = await page(
                  [Number(last.entry_number), last.line_number],
                  3,
                );
                assert.equal(rest.rows.length, 1);
                await assert.rejects(
                  page([null, null], 501),
                  /ledger\.pageSize/u,
                  'a page above 500 lines was served',
                );
              } finally {
                reader.release();
              }
            },
          );
        }
      } finally {
        for (const client of sessions) client.release();
        await runtime.end();
      }
    },
  );
}

test('ledger journal core', (t) => world(t, 'core'));
// Its own database, so a company-scope control can select it by name.
test('ledger company isolation', (t) => world(t, 'isolation'));
