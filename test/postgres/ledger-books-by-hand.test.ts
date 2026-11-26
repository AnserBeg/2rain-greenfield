import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg, { type PoolClient } from 'pg';

import { startComposedApplication } from '../../apps/api/src/composition-root.js';
import { SEMANTIC_OPERATION_REQUEST_VERSION } from '../../packages/runtime/src/semantic-operation-gateway.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

// ACCOUNTING-1 slice 1a-ii, ruling A: a ledger operation is confirmed through
// the Semantic Operation gateway; the executor attests the verified grant as
// north_star_approval_issuer and the apply definer consumes it once. Here the
// thinnest path, books start, in a composed application, so a company is a
// live record of the released legal-entity master. Two companies share ONE
// tenant and environment. The SQL reds attest a valid grant themselves and
// call the apply as north_star_runtime, so each refusal dies alone in SQL;
// one test drives the whole path through the gateway.

const NS = 'northstar.app:';
const BOOKS_START = `${NS}operation.bookkeeping_books_start_set`;
const BOOKS = [
  'northstar.ledger:permission.books_configure',
  'northstar.ledger:capability.books',
] as const;
const READ = [
  'northstar.ledger:permission.journal_read',
  'northstar.ledger:capability.journal',
] as const;

test(
  'ledger books by hand: books start through the gateway, attested and consumed once',
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
        const issuer = new pg.Pool({
          ...c,
          user: 'north_star_approval_issuer',
          max: 1,
        });
        try {
          const world = worldOver(
            app.runtime,
            tenantSlug,
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
          const { tenant, environment } = (
            await pool.query<{ tenant: string; environment: string }>(
              `SELECT p.tenant_id AS tenant, p.environment_id AS environment
                 FROM platform.active_release_pointers p JOIN platform.tenants tn ON tn.id = p.tenant_id
                WHERE tn.slug = $1`,
              [tenantSlug],
            )
          ).rows[0]!;
          const pointer = async () =>
            (
              await pool.query<{ release: string; fence: string }>(
                'SELECT release_id AS release, fence::text AS fence FROM platform.active_release_pointers WHERE (tenant_id, environment_id) = ($1,$2)',
                [tenant, environment],
              )
            ).rows[0]!;

          const policyRole = async (
            grants: readonly (readonly [string, string])[],
          ) => {
            const id = randomUUID();
            await pool.query(
              'INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES ($1,$2,$3,$4)',
              [tenant, environment, id, `ledger_${id.slice(0, 8)}`],
            );
            for (const [permission, resource] of grants)
              await pool.query(
                'INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id) VALUES ($1,$2,$3,$4,$5)',
                [tenant, environment, id, permission, resource],
              );
            return id;
          };
          const member = async (
            principal: string,
            role: string,
            company: string | null,
          ) =>
            pool.query(
              'INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id) VALUES ($1,$2,gen_random_uuid(),$3,$4,$5)',
              [tenant, environment, principal, role, company],
            );
          const books = await policyRole([BOOKS]);
          const reading = await policyRole([READ]);
          const scopedA = randomUUID(),
            unscoped = randomUUID(),
            reader = randomUUID();
          await member(scopedA, books, COMPANY);
          await member(unscoped, books, null);
          await member(reader, reading, null);

          interface Call {
            who: string;
            company: string;
            date?: string;
            expectedPrior?: string | null;
            fence?: string;
          }
          const inputOf = (call: Call) => ({
            arguments: {
              date: call.date ?? '2026-01-01',
              expectedPrior: call.expectedPrior ?? null,
            },
            expectedRevision: 1,
            recordId: call.company,
          });
          /** Attests a grant for exactly this request, as the issuer role. */
          const attest = async (call: Call, input: object = inputOf(call)) => {
            const current = await pointer();
            const grant = randomUUID(),
              key = randomUUID();
            await issuer.query(
              'SELECT platform.ledger_attest_approval($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
              [
                grant,
                tenant,
                environment,
                call.who,
                call.who,
                current.release,
                call.fence ?? current.fence,
                BOOKS_START,
                key,
                JSON.stringify(input),
                'UI',
              ],
            );
            return { grant, key, release: current.release };
          };
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
              await client.query('ROLLBACK').catch(() => undefined);
              client.release();
            }
          };
          const apply = (
            client: PoolClient,
            call: Call,
            attested: { grant: string; key: string; release: string },
            input: object = inputOf(call),
          ) =>
            client.query(
              'SELECT platform.ledger_apply_books_start($1,$2,$3,$4,$5,$6,$7)',
              [
                attested.grant,
                attested.release,
                call.fence ?? undefined,
                BOOKS_START,
                attested.key,
                'UI',
                JSON.stringify(input),
              ],
            );
          /** One attested apply inside a transaction that is rolled back. */
          const tryApply = async (call: Call, input?: object) => {
            const fence = call.fence ?? (await pointer()).fence;
            const attested = await attest({ ...call, fence });
            return as(call.who, async (client) => {
              await client.query('BEGIN');
              return settled(
                apply(client, { ...call, fence }, attested, input),
              );
            });
          };
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

          await t.test(
            'an attested request applies, and only the exact request it was attested for',
            async () => {
              const call = { who: scopedA, company: COMPANY };
              assert.equal(await tryApply(call), 'admitted');
              const other = await tryApply(call, {
                ...inputOf(call),
                arguments: { date: '2026-02-01', expectedPrior: null },
              });
              assert.match(
                other,
                /ledger\.approvalRequired/u,
                `an apply ran on a grant attested for another input: ${other}`,
              );
            },
          );
          await t.test('an attested grant is consumed once', async () => {
            const call = { who: scopedA, company: COMPANY };
            const fence = (await pointer()).fence;
            const attested = await attest({ ...call, fence });
            const second = await as(scopedA, async (client) => {
              await client.query('BEGIN');
              await apply(client, { ...call, fence }, attested);
              return settled(apply(client, { ...call, fence }, attested));
            });
            assert.match(
              second,
              /ledger\.approvalSpent/u,
              `a consumed grant applied again: ${second}`,
            );
          });
          await t.test(
            'a principal scoped to one company is refused on another company of the tenant',
            async () => {
              const outcome = await tryApply({
                who: scopedA,
                company: companyB,
              });
              assert.match(
                outcome,
                /ledger\.unavailable/u,
                `a principal scoped to company A started company B's books: ${outcome}`,
              );
            },
          );
          await t.test(
            'a company must be a live record of the released legal-entity master',
            async () => {
              const outcome = await tryApply({
                who: unscoped,
                company: randomUUID(),
              });
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
              const outcome = await tryApply({ who: reader, company: COMPANY });
              assert.match(
                outcome,
                /ledger\.unavailable/u,
                `a journal reader started books: ${outcome}`,
              );
            },
          );
          await t.test(
            'a grant attested under an earlier release fence never applies',
            async () => {
              const stale = String(BigInt((await pointer()).fence) - 1n);
              const outcome = await tryApply({
                who: scopedA,
                company: COMPANY,
                fence: stale,
              });
              assert.match(
                outcome,
                /ledger\.staleRelease/u,
                `a grant applied under a moved release fence: ${outcome}`,
              );
            },
          );
          await t.test(
            'books start replaces only the value the person expected',
            async () => {
              const outcome = await tryApply({
                who: scopedA,
                company: COMPANY,
                expectedPrior: '2025-01-01',
              });
              assert.match(
                outcome,
                /ledger\.priorChanged/u,
                `books start replaced a value the person did not see: ${outcome}`,
              );
            },
          );
          await t.test(
            'only the issuer attests and only north_star_runtime applies',
            async () => {
              const { rows } = await pool.query<{ entry: string }>(
                `SELECT r.rolname || ' ' || f AS entry FROM pg_roles r CROSS JOIN unnest($1::text[]) f
                  WHERE NOT r.rolsuper AND r.oid <> (SELECT proowner FROM pg_proc WHERE oid = f::regprocedure)
                    AND has_function_privilege(r.oid, f::regprocedure, 'EXECUTE') ORDER BY 1`,
                [
                  [
                    'platform.ledger_attest_approval(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid,jsonb,text)',
                    'platform.ledger_apply_books_start(uuid,uuid,bigint,text,uuid,text,jsonb)',
                    'north_star_internal.ledger_consume_grant(uuid,uuid,bigint,text,uuid,jsonb,text)',
                    'north_star_internal.ledger_operation_access(uuid,uuid,bigint,boolean)',
                    'north_star_internal.ledger_company_live(uuid,boolean)',
                    'north_star_internal.ledger_may(uuid,text,text)',
                    'north_star_internal.ledger_release_storage()',
                    'north_star_internal.ledger_grant_immutable()',
                    'north_star_internal.ledger_grant_receipt()',
                  ],
                ],
              );
              assert.deepEqual(
                rows.map((row) => row.entry),
                [
                  'north_star_approval_issuer platform.ledger_attest_approval(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid,jsonb,text)',
                  'north_star_runtime platform.ledger_apply_books_start(uuid,uuid,bigint,text,uuid,text,jsonb)',
                ],
                'a ledger operation function is executable beyond its grant',
              );
            },
          );
          await t.test(
            'the gateway confirms books start end to end and records its trust receipt',
            async () => {
              const local = { headers: { authorization: 'local' } };
              const principal = await app.runtime.entry.run(local, (view) =>
                Promise.resolve(view.principalId),
              );
              await member(principal, books, COMPANY);
              const outcome = await app.runtime.entry.run(
                local,
                async (view) => {
                  const input = {
                    arguments: { date: '2026-01-01', expectedPrior: null },
                    expectedRevision: 1,
                    recordId: COMPANY,
                  };
                  return app.runtime.operationGateway.invoke(
                    view,
                    {
                      confirmationGrant:
                        app.runtime.operationMediation.issueConfirmationGrant(
                          view,
                          BOOKS_START,
                          input,
                        ),
                      idempotencyKey: randomUUID(),
                      input,
                      operationId: BOOKS_START,
                      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                    },
                    app.runtime.operationMediation.issueInvocation(view, 'UI'),
                  );
                },
              );
              assert.equal(
                outcome.outcome,
                'succeeded',
                JSON.stringify(outcome),
              );
              assert.equal(await booksStart(COMPANY), '2026-01-01');
              const receipt = await pool.query<{ ok: boolean }>(
                `SELECT EXISTS (SELECT FROM platform.ledger_approval_grants g JOIN platform.trust_action_invocations i
                   ON (i.tenant_id, i.environment_id, i.invocation_id) = (g.tenant_id, g.environment_id, g.invocation_id)
                  WHERE g.operation_id = $1 AND i.action_id = $1 AND i.outcome = 'SUCCEEDED') AS ok`,
                [BOOKS_START],
              );
              assert.equal(receipt.rows[0]!.ok, true);
            },
          );
          // Last: under its control a commit without a receipt would succeed
          // and start company B's books.
          await t.test(
            'a consumed grant never commits without its trust receipt',
            async () => {
              const call = { who: unscoped, company: companyB };
              const fence = (await pointer()).fence;
              const attested = await attest({ ...call, fence });
              const outcome = await as(unscoped, async (client) => {
                await client.query('BEGIN');
                await apply(client, { ...call, fence }, attested);
                return settled(client.query('COMMIT'));
              });
              assert.match(
                outcome,
                /ledger\.receiptUnverified/u,
                `a consumed grant committed with no trust receipt: ${outcome}`,
              );
            },
          );
        } finally {
          await issuer.end();
          await runtime.end();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
