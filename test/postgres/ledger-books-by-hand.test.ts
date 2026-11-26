import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg, { type PoolClient } from 'pg';

import { startComposedApplication } from '../../apps/api/src/composition-root.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

// ACCOUNTING-1 slice 1a-ii: the scalar confirmation-class operations (books
// start, set up chart, put account) in a composed application, so a company is
// a live record of the released legal-entity master. Two companies share ONE
// tenant and environment; principals are company-scoped or unscoped. Every
// call is made as north_star_runtime through platform.ledger_review and
// platform.ledger_confirm.

const NS = 'northstar.app:';
const role = (name: string) => `northstar.ledger:role.${name}`;
const BOOKS = [
  'northstar.ledger:permission.books_configure',
  'northstar.ledger:capability.books',
] as const;
const READ = [
  'northstar.ledger:permission.journal_read',
  'northstar.ledger:capability.journal',
] as const;
const STARTER = {
  starterId: 'northstar.ledger:starter.canada',
  starterVersion: 1,
};

interface Reviewed {
  reviewId: string;
  digest: string;
  terms: Record<string, unknown>;
}

test(
  'ledger books by hand: books start, chart and accounts, confirmed against the release fence',
  { timeout: 1_200_000 },
  async (t) => {
    await withEphemeralPostgres(
      'ledger-books',
      async ({ connection: c, pool }) => {
        const databaseUrl = `postgresql://${c.user}@${c.host}:${c.port}/${c.database}`;
        const tenantSlug = 'ledger-books';
        const app = await startComposedApplication({
          databaseUrl,
          port: 0,
          tenantSlug,
        });
        const runtime = new pg.Pool({
          ...c,
          user: 'north_star_runtime',
          max: 3,
        });
        try {
          const world = worldOver(
            app.runtime,
            c.database,
            databaseUrl,
            tenantSlug,
          );
          const companyB = randomUUID();
          const created = await world.invoke('legal_entity_create', {
            recordId: companyB,
            relations: {},
            values: {
              [NS + 'field.legal_entity_name']: 'Second company',
              [NS + 'field.legal_entity_code']: 'LEDGERB',
              [NS + 'field.legal_entity_is_default']: false,
              [NS + 'field.legal_entity_status']:
                NS + 'option.legal_entity_status_active',
            },
          });
          assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
          const pointer = (
            await pool.query<{
              tenant: string;
              environment: string;
              release: string;
              fence: string;
            }>(
              `SELECT p.tenant_id AS tenant, p.environment_id AS environment, p.release_id AS release, p.fence::text AS fence
                 FROM platform.active_release_pointers p JOIN platform.tenants tn ON tn.id = p.tenant_id
                WHERE tn.slug = $1`,
              [tenantSlug],
            )
          ).rows[0]!;
          const { tenant, environment } = pointer;
          // Any committed trust invocation of this tenant stands in for the
          // gateway's: the review only links to it.
          const receipt = (
            await pool.query<{ id: string }>(
              'SELECT invocation_id AS id FROM platform.trust_action_invocations WHERE (tenant_id, environment_id) = ($1,$2) LIMIT 1',
              [tenant, environment],
            )
          ).rows[0]!.id;

          const principal = async (
            grants: readonly (readonly [string, string])[],
            company: string | null,
          ) => {
            const id = randomUUID(),
              policyRole = randomUUID();
            await pool.query(
              'INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES ($1,$2,$3,$4)',
              [
                tenant,
                environment,
                policyRole,
                `ledger_${policyRole.slice(0, 8)}`,
              ],
            );
            for (const [permission, resource] of grants)
              await pool.query(
                'INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id) VALUES ($1,$2,$3,$4,$5)',
                [tenant, environment, policyRole, permission, resource],
              );
            await pool.query(
              'INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id) VALUES ($1,$2,gen_random_uuid(),$3,$4,$5)',
              [tenant, environment, id, policyRole, company],
            );
            return id;
          };
          const scopedA = await principal([BOOKS], COMPANY);
          const unscoped = await principal([BOOKS], null);
          const reader = await principal([READ], null);

          const as = async <T>(
            who: string,
            work: (client: PoolClient) => Promise<T>,
          ): Promise<T> => {
            const client = await runtime.connect();
            try {
              await client.query(
                "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false),set_config('north_star.principal_id',$3,false)",
                [tenant, environment, who],
              );
              return await work(client);
            } finally {
              client.release();
            }
          };
          const fence = async () =>
            (
              await pool.query<{ release: string; fence: string }>(
                'SELECT release_id AS release, fence::text AS fence FROM platform.active_release_pointers WHERE (tenant_id, environment_id) = ($1,$2)',
                [tenant, environment],
              )
            ).rows[0]!;
          const review = async (
            who: string,
            company: string,
            operation: string,
            input: object,
          ): Promise<Reviewed> => {
            const current = await fence();
            return as(
              who,
              async (client) =>
                (
                  await client.query<{ r: Reviewed }>(
                    'SELECT platform.ledger_review($1,$2,$3,$4,$5) AS r',
                    [
                      company,
                      current.release,
                      current.fence,
                      operation,
                      JSON.stringify(input),
                    ],
                  )
                ).rows[0]!.r,
            );
          };
          const confirm = (
            who: string,
            reviewed: Reviewed,
            digest = reviewed.digest,
          ) =>
            as(who, async (client) => {
              await client.query('SELECT platform.ledger_confirm($1,$2,$3)', [
                reviewed.reviewId,
                digest,
                receipt,
              ]);
            });
          /** The refusal text, or "admitted", so a red names what happened. */
          const settled = (pending: Promise<unknown>) =>
            pending.then(
              () => 'admitted',
              (error: unknown) => String((error as Error).message),
            );
          const booksStart = async (company: string) =>
            (
              await pool.query<{ day: string | null }>(
                "SELECT to_char(books_start,'YYYY-MM-DD') AS day FROM platform.ledger_companies WHERE (tenant_id, environment_id, company_id) = ($1,$2,$3)",
                [tenant, environment, company],
              )
            ).rows[0]?.day ?? null;
          const codes = async (company: string) =>
            (
              await pool.query<{ code: string }>(
                'SELECT account_code AS code FROM platform.ledger_accounts WHERE (tenant_id, environment_id, company_id) = ($1,$2,$3) ORDER BY 1',
                [tenant, environment, company],
              )
            ).rows.map((row) => row.code);

          await t.test(
            'books start is confirmed only with the exact digest of its review',
            async () => {
              const reviewed = await review(scopedA, COMPANY, 'booksStart', {
                date: '2026-01-01',
              });
              assert.deepEqual(reviewed.terms, {
                company: COMPANY,
                date: '2026-01-01',
                operation: 'booksStart',
                prior: null,
              });
              const wrong = await settled(
                confirm(scopedA, reviewed, '0'.repeat(64)),
              );
              assert.match(
                wrong,
                /ledger\.digestMismatch/u,
                `a confirm with another digest was admitted: ${wrong}`,
              );
              await confirm(scopedA, reviewed);
              assert.equal(await booksStart(COMPANY), '2026-01-01');
              const again = await settled(confirm(scopedA, reviewed));
              assert.match(
                again,
                /ledger\.reviewConsumed/u,
                `a consumed books-start review was confirmed again: ${again}`,
              );
            },
          );
          await t.test(
            'a principal scoped to one company is refused on another company of the tenant',
            async () => {
              const outcome = await settled(
                review(scopedA, companyB, 'booksStart', { date: '2026-01-01' }),
              );
              assert.match(
                outcome,
                /ledger\.unavailable/u,
                `a principal scoped to company A reviewed company B: ${outcome}`,
              );
            },
          );
          await t.test(
            'a company must be a live record of the released legal-entity master',
            async () => {
              const outcome = await settled(
                review(unscoped, randomUUID(), 'booksStart', {
                  date: '2026-01-01',
                }),
              );
              assert.match(
                outcome,
                /ledger\.unavailable/u,
                `an unscoped member started books for a company that does not exist: ${outcome}`,
              );
            },
          );
          await t.test(
            'a read permission never authorizes a books change',
            async () => {
              const outcome = await settled(
                review(reader, COMPANY, 'putAccount', {
                  code: '1020',
                  kind: role('cash'),
                  label: 'Petty cash',
                  active: true,
                }),
              );
              assert.match(
                outcome,
                /ledger\.unavailable/u,
                `a journal reader changed the chart: ${outcome}`,
              );
            },
          );
          await t.test(
            'set up chart adds the starter accounts of the chosen jurisdictions once',
            async () => {
              const reviewed = await review(scopedA, COMPANY, 'setUpChart', {
                ...STARTER,
                jurisdictions: ['CA-BC', 'CA'],
              });
              await confirm(scopedA, reviewed);
              const first = await codes(COMPANY);
              assert.equal(first.length, 26);
              assert.ok(first.includes('2210') && !first.includes('2220'));
              const again = await settled(confirm(scopedA, reviewed));
              assert.match(
                again,
                /ledger\.reviewConsumed/u,
                `a consumed chart review was confirmed again: ${again}`,
              );
              await confirm(
                scopedA,
                await review(scopedA, COMPANY, 'setUpChart', {
                  ...STARTER,
                  jurisdictions: ['CA', 'CA-SK'],
                }),
              );
              const second = await codes(COMPANY);
              assert.equal(
                second.length,
                27,
                'a reapplied starter duplicated accounts',
              );
              assert.ok(second.includes('2220'));
            },
          );
          await t.test(
            'put account mints the account ID and never changes a kind',
            async () => {
              const smuggled = await settled(
                review(scopedA, COMPANY, 'putAccount', {
                  create: true,
                  accountId: randomUUID(),
                  code: '1020',
                  kind: role('cash'),
                  label: 'Petty cash',
                  active: true,
                }),
              );
              assert.match(smuggled, /ledger\.invalidOperation/u);
              const reviewed = await review(scopedA, COMPANY, 'putAccount', {
                code: '1020',
                kind: role('cash'),
                label: 'Petty cash',
                active: true,
              });
              assert.equal(reviewed.terms.create, true);
              await confirm(scopedA, reviewed);
              const accountId = String(reviewed.terms.accountId);
              const again = await settled(confirm(scopedA, reviewed));
              assert.match(
                again,
                /ledger\.reviewConsumed/u,
                `a consumed account review was confirmed again: ${again}`,
              );
              await confirm(
                scopedA,
                await review(scopedA, COMPANY, 'putAccount', {
                  accountId,
                  code: '1020',
                  kind: role('cash'),
                  label: 'Petty cash box',
                  active: false,
                }),
              );
              const kind = await settled(
                review(scopedA, COMPANY, 'putAccount', {
                  accountId,
                  code: '1020',
                  kind: role('expense'),
                  label: 'Petty cash box',
                  active: false,
                }),
              );
              assert.match(kind, /ledger\.accountKindFixed/u);
            },
          );
          await t.test(
            'chart and put account refuse a company whose books have not started',
            async () => {
              const outcome = await settled(
                review(unscoped, companyB, 'setUpChart', {
                  ...STARTER,
                  jurisdictions: ['CA'],
                }),
              );
              assert.match(outcome, /ledger\.booksNotStarted/u);
            },
          );
          await t.test(
            'confirm re-derives its terms under the locks and refuses a stale review',
            async () => {
              const stale = await review(unscoped, companyB, 'booksStart', {
                date: '2026-02-01',
              });
              await confirm(
                unscoped,
                await review(unscoped, companyB, 'booksStart', {
                  date: '2026-03-01',
                }),
              );
              const outcome = await settled(confirm(unscoped, stale));
              assert.match(
                outcome,
                /ledger\.reviewStale/u,
                `a stale review was confirmed: ${outcome}`,
              );
              assert.equal(await booksStart(companyB), '2026-03-01');
            },
          );
          await t.test(
            'a starter code held by an account of another kind refuses the chart',
            async () => {
              await confirm(
                unscoped,
                await review(unscoped, companyB, 'putAccount', {
                  code: '6000',
                  kind: role('other_expense'),
                  label: 'Sundry',
                  active: true,
                }),
              );
              await assert.rejects(
                review(unscoped, companyB, 'setUpChart', {
                  ...STARTER,
                  jurisdictions: ['CA'],
                }),
                /ledger\.chartKindConflict/u,
                'a starter account was kept under another kind',
              );
            },
          );
          await t.test(
            "a review's terms never change, even while it is consumed",
            async () => {
              const reviewed = await review(unscoped, companyB, 'putAccount', {
                code: '1030',
                kind: role('cash'),
                label: 'Till',
                active: true,
              });
              await assert.rejects(
                pool.query(
                  `UPDATE platform.ledger_operation_reviews SET consumed_at = clock_timestamp(), receipt_id = $2,
                     terms = jsonb_set(terms, '{code}', '"9999"') WHERE review_id = $1`,
                  [reviewed.reviewId, receipt],
                ),
                /ledger\.reviewImmutable/u,
                "a review's terms changed",
              );
              await assert.rejects(
                pool.query(
                  'DELETE FROM platform.ledger_operation_reviews WHERE review_id = $1',
                  [reviewed.reviewId],
                ),
                /ledger\.reviewImmutable/u,
                'a review was deleted',
              );
            },
          );
          await t.test(
            'only north_star_runtime executes review and confirm',
            async () => {
              const { rows } = await pool.query<{ entry: string }>(
                `SELECT r.rolname || ' ' || f AS entry FROM pg_roles r CROSS JOIN unnest($1::text[]) f
                  WHERE NOT r.rolsuper AND r.oid <> (SELECT proowner FROM pg_proc WHERE oid = f::regprocedure)
                    AND has_function_privilege(r.oid, f::regprocedure, 'EXECUTE') ORDER BY 1`,
                [
                  [
                    'platform.ledger_review(uuid,uuid,bigint,text,jsonb)',
                    'platform.ledger_confirm(uuid,text,uuid)',
                    'north_star_internal.ledger_operation_terms(uuid,text,jsonb,boolean)',
                    'north_star_internal.ledger_operation_access(uuid,uuid,bigint,boolean)',
                    'north_star_internal.ledger_company_live(uuid,boolean)',
                    'north_star_internal.ledger_may(uuid,text,text)',
                    'north_star_internal.ledger_release_storage()',
                    'north_star_internal.ledger_review_immutable()',
                  ],
                ],
              );
              assert.deepEqual(
                rows.map((row) => row.entry),
                [
                  'north_star_runtime platform.ledger_confirm(uuid,text,uuid)',
                  'north_star_runtime platform.ledger_review(uuid,uuid,bigint,text,jsonb)',
                ],
                'a ledger operation function is executable beyond its grant',
              );
            },
          );
          // Last: it moves the active pointer's fence.
          await t.test(
            'a review never confirms across a release switch and back',
            async () => {
              const reviewed = await review(scopedA, COMPANY, 'putAccount', {
                code: '1040',
                kind: role('cash'),
                label: 'Float',
                active: true,
              });
              // A switch away and back leaves the same release under a fence
              // two higher. The activation kernel's swap guard is bypassed
              // here only to reach that end state without two activations.
              const client = await pool.connect();
              try {
                await client.query('BEGIN');
                await client.query(
                  "SET LOCAL session_replication_role = 'replica'",
                );
                await client.query(
                  'UPDATE platform.active_release_pointers SET fence = fence + 2 WHERE (tenant_id, environment_id) = ($1,$2)',
                  [tenant, environment],
                );
                await client.query('COMMIT');
              } finally {
                client.release();
              }
              const outcome = await settled(confirm(scopedA, reviewed));
              assert.match(
                outcome,
                /ledger\.staleRelease/u,
                `a review confirmed across a release switch: ${outcome}`,
              );
            },
          );
        } finally {
          await runtime.end();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
