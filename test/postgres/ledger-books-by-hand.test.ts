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
// tenant and environment. The SQL reds attest a grant themselves and call the
// apply as north_star_runtime, so each refusal dies alone in SQL; the gateway
// tests drive the whole path with the permissions the product install grants.
// Only some tests commit: the SQL reds roll back, the gateway tests commit on
// company A, and the receipt tests commit on company B, each reading the books
// start it replaces, so an admission under a control never changes what a
// later test expects.

const NS = 'northstar.app:';
const BOOKS_START = `${NS}operation.bookkeeping_books_start_set`;
const BOOKS_START_PERMISSION = `${NS}permission.bookkeeping_books_start_set`;
const CAPABILITY = 'northstar.ledger:capability.ledger_books_start';
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
          /** The policy version the gateway would decide under now. */
          const policyVersion = async () =>
            (
              await pool.query<{ version: string }>(
                `SELECT 'northstar.current-policy/' || coalesce((SELECT policy_version::text
                   FROM platform.current_policy_epochs WHERE (tenant_id, environment_id) = ($1,$2)), '0') AS version`,
                [tenant, environment],
              )
            ).rows[0]!.version;
          // The released legal-entity master's table and revision column, read
          // from the storage plan as the ledger reads them.
          const master = (
            await pool.query<{ tableName: string; column: string }>(
              `SELECT v->>'physicalTableName' AS "tableName", v#>>'{optimisticRevision,column}' AS column
                 FROM platform.active_release_pointers p
                 JOIN platform.tenant_release_projection_links projection USING (tenant_id, environment_id, release_id)
                 JOIN platform.tenant_release_chunk_links chunk USING (tenant_id, environment_id, release_id, projection_instance_id)
                 JOIN platform.release_artifact_blobs blob ON blob.content_hash = chunk.chunk_hash
                   AND blob.artifact_kind = 'projectionChunk'
                 CROSS JOIN jsonb_array_elements(convert_from(blob.canonical_bytes, 'UTF8')::jsonb->'entities') v
                WHERE (p.tenant_id, p.environment_id) = ($1,$2)
                  AND projection.projection_family_id = 'northstar.compiler:projection-family.storage-target'
                  AND v ? 'legalEntityMaster'`,
              [tenant, environment],
            )
          ).rows;
          assert.equal(master.length, 1, 'one released legal-entity master');
          const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
          /** The company record's stored revision. */
          const revisionOf = async (company: string) =>
            Number(
              (
                await pool.query<{ revision: string }>(
                  `SELECT ${quoted(master[0]!.column)}::text AS revision
                     FROM north_star_module.${quoted(master[0]!.tableName)}
                    WHERE (tenant_id, environment_id, record_id) = ($1,$2,$3)`,
                  [tenant, environment, company],
                )
              ).rows[0]!.revision,
            );

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
            revision?: number;
          }
          /** Every fact a grant binds and an apply presents. */
          interface Facts {
            capability: string;
            principal: string;
            human: string;
            release: string;
            fence: string;
            operation: string;
            key: string;
            channel: string;
            policy: string;
          }
          const inputOf = async (call: Call) => ({
            arguments: {
              date: call.date ?? '2026-01-01',
              expectedPrior: call.expectedPrior ?? null,
            },
            expectedRevision: call.revision ?? (await revisionOf(call.company)),
            recordId: call.company,
          });
          const factsOf = async (call: Call): Promise<Facts> => {
            const current = await pointer();
            return {
              capability: CAPABILITY,
              principal: call.who,
              human: call.who,
              release: current.release,
              fence: call.fence ?? current.fence,
              operation: BOOKS_START,
              key: randomUUID(),
              channel: 'UI',
              policy: await policyVersion(),
            };
          };
          /** Attests a grant as the issuer role, saying exactly `facts`. */
          const attest = (grant: string, facts: Facts, input: object) =>
            issuer.query(
              'SELECT platform.ledger_attest_approval($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
              [
                grant,
                facts.capability,
                tenant,
                environment,
                facts.principal,
                facts.human,
                facts.release,
                facts.fence,
                facts.operation,
                facts.key,
                JSON.stringify(input),
                facts.channel,
              ],
            );
          const apply = (
            client: PoolClient,
            grant: string,
            facts: Facts,
            input: object,
          ) =>
            client.query<{ result: { invocationId: string } }>(
              'SELECT platform.ledger_apply_books_start($1,$2,$3,$4,$5,$6,$7,$8) AS result',
              [
                grant,
                facts.release,
                facts.fence,
                facts.operation,
                facts.key,
                facts.channel,
                facts.policy,
                JSON.stringify(input),
              ],
            );
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
          /** The refusal text, or "admitted", so a red names what happened. */
          const settled = (pending: Promise<unknown>) =>
            pending.then(
              () => 'admitted',
              (error: unknown) => String((error as Error).message),
            );
          /**
           * One attested apply as `call.who`, in a transaction that is rolled
           * back. `attested` changes what the grant says and `applied` what
           * the apply presents; `input` is the applied input and
           * `attestedInput` the grant's (the same unless given); `between`
           * runs after the attestation.
           */
          const tryApply = async (
            call: Call,
            change: {
              input?: object;
              attestedInput?: object;
              attested?: Partial<Facts>;
              applied?: Partial<Facts>;
              between?: () => Promise<unknown>;
            } = {},
          ) => {
            const facts = await factsOf(call);
            const input = change.input ?? (await inputOf(call));
            const grant = randomUUID();
            await attest(
              grant,
              { ...facts, ...change.attested },
              change.attestedInput ?? input,
            );
            await change.between?.();
            return as(call.who, async (client) => {
              await client.query('BEGIN');
              return settled(
                apply(client, grant, { ...facts, ...change.applied }, input),
              );
            });
          };
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
              const attestedInput = await inputOf(call);
              const other = await tryApply(call, {
                attestedInput,
                input: {
                  ...attestedInput,
                  arguments: { date: '2026-02-01', expectedPrior: null },
                },
              });
              assert.match(
                other,
                /ledger\.approvalRequired/u,
                `an apply ran on a grant attested for another input: ${other}`,
              );
            },
          );
          const mismatches: readonly (readonly [
            keyof Facts,
            string,
            string,
          ])[] = [
            ['principal', unscoped, 'another principal'],
            [
              'operation',
              `${NS}operation.legal_entity_update`,
              'another operation',
            ],
            ['key', randomUUID(), 'another request key'],
            ['channel', 'API', 'another channel'],
            ['release', randomUUID(), 'another release'],
          ];
          for (const [fact, other, label] of mismatches)
            await t.test(
              `a grant attested for ${label} never applies`,
              async () => {
                const attested: Partial<Facts> = {};
                attested[fact] = other;
                // The principal's grant names that principal as its human.
                if (fact === 'principal') attested.human = other;
                const outcome = await tryApply(
                  { who: scopedA, company: COMPANY },
                  { attested },
                );
                assert.match(
                  outcome,
                  /ledger\.approvalRequired/u,
                  `a grant attested for ${label} applied: ${outcome}`,
                );
              },
            );
          await t.test(
            'a grant attested for another ledger capability never applies in books start',
            async () => {
              const outcome = await tryApply(
                { who: scopedA, company: COMPANY },
                {
                  attested: {
                    capability: 'northstar.ledger:capability.general_ledger',
                  },
                },
              );
              assert.match(
                outcome,
                /ledger\.approvalRequired/u,
                `books start consumed a grant attested for the post: ${outcome}`,
              );
            },
          );
          await t.test('an attested grant is consumed once', async () => {
            const call = { who: scopedA, company: COMPANY };
            const facts = await factsOf(call);
            const input = await inputOf(call);
            const grant = randomUUID();
            await attest(grant, facts, input);
            const second = await as(scopedA, async (client) => {
              await client.query('BEGIN');
              await apply(client, grant, facts, input);
              return settled(apply(client, grant, facts, input));
            });
            assert.match(
              second,
              /ledger\.approvalSpent/u,
              `a consumed grant applied again: ${second}`,
            );
          });
          await t.test(
            'an unconsumed grant expires 15 minutes after its attestation',
            async () => {
              const call = { who: scopedA, company: COMPANY };
              const facts = await factsOf(call);
              const input = await inputOf(call);
              const grant = randomUUID();
              // Attested 16 minutes ago, written directly: an UPDATE of
              // attested_at is refused (ledger.grantImmutable).
              await pool.query(
                `INSERT INTO platform.ledger_approval_grants (tenant_id, environment_id, grant_id, capability_id,
                   principal_id, human_id, release_id, fence, operation_id, request_key, input, channel, attested_at)
                 VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11, clock_timestamp() - interval '16 minutes')`,
                [
                  tenant,
                  environment,
                  grant,
                  facts.capability,
                  facts.principal,
                  facts.release,
                  facts.fence,
                  facts.operation,
                  facts.key,
                  JSON.stringify(input),
                  facts.channel,
                ],
              );
              const outcome = await as(scopedA, async (client) => {
                await client.query('BEGIN');
                return settled(apply(client, grant, facts, input));
              });
              assert.match(
                outcome,
                /ledger\.approvalExpired/u,
                `a grant attested 16 minutes ago applied: ${outcome}`,
              );
            },
          );
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
                revision: 1,
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
            'a confirmation against another company revision never applies',
            async () => {
              const outcome = await tryApply({
                who: scopedA,
                company: COMPANY,
                revision: (await revisionOf(COMPANY)) + 1,
              });
              assert.match(
                outcome,
                /ledger\.staleRevision/u,
                `books start applied against a company revision it was not confirmed on: ${outcome}`,
              );
            },
          );
          await t.test(
            'a decision under a policy version that has since moved never applies',
            async () => {
              const outcome = await tryApply(
                { who: scopedA, company: COMPANY },
                // A grant written after the decision moves the epoch.
                { between: () => policyRole([READ]) },
              );
              assert.match(
                outcome,
                /ledger\.stalePolicy/u,
                `books start applied under a policy version that had moved: ${outcome}`,
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
            'a blank or missing expectedPrior means no books start yet, as a Task left blank sends',
            async () => {
              const call = { who: scopedA, company: COMPANY };
              for (const args of [
                { date: '2026-01-01', expectedPrior: '' },
                { date: '2026-01-01' },
              ]) {
                const input = { ...(await inputOf(call)), arguments: args };
                assert.equal(
                  await tryApply(call, { input }),
                  'admitted',
                  JSON.stringify(args),
                );
              }
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
                    'platform.ledger_attest_approval(uuid,text,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid,jsonb,text)',
                    'platform.ledger_apply_books_start(uuid,uuid,bigint,text,uuid,text,text,jsonb)',
                    'platform.ledger_apply_account_put(uuid,uuid,bigint,text,uuid,text,text,jsonb)',
                    'platform.ledger_apply_chart_setup(uuid,uuid,bigint,text,uuid,text,text,jsonb)',
                    'north_star_internal.ledger_consume_grant(uuid,text,uuid,bigint,text,uuid,jsonb,text)',
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
                  'north_star_approval_issuer platform.ledger_attest_approval(uuid,text,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid,jsonb,text)',
                  'north_star_runtime platform.ledger_apply_account_put(uuid,uuid,bigint,text,uuid,text,text,jsonb)',
                  'north_star_runtime platform.ledger_apply_books_start(uuid,uuid,bigint,text,uuid,text,text,jsonb)',
                  'north_star_runtime platform.ledger_apply_chart_setup(uuid,uuid,bigint,text,uuid,text,text,jsonb)',
                ],
                'a ledger operation function is executable beyond its grant',
              );
            },
          );

          // The gateway, with the grants the product install wrote: no test
          // seeds a ledger permission for the local principal.
          const local = { headers: { authorization: 'local' } };
          const principal = await app.runtime.entry.run(local, (view) =>
            Promise.resolve(view.principalId),
          );
          /** Books start on company A through the gateway: 'succeeded' or the refusal. */
          const viaGateway = async (date: string) => {
            const input = {
              arguments: { date, expectedPrior: await booksStart(COMPANY) },
              expectedRevision: await revisionOf(COMPANY),
              recordId: COMPANY,
            };
            return app.runtime.entry
              .run(local, (view) =>
                app.runtime.operationGateway.invoke(
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
                ),
              )
              .then(
                (result) =>
                  result.outcome === 'succeeded'
                    ? 'succeeded'
                    : `${result.outcome} ${String(result.unsupportedReason)}`,
                (error: unknown) =>
                  `${String((error as Error).message)} ${String((error as { code?: unknown }).code)}`,
              );
          };
          /** The latest books-start trust receipt's change and policy version. */
          const lastReceipt = async () =>
            (
              await pool.query<{
                policy: string;
                field: string;
                old: string;
                oldValue: string | null;
                value: string | null;
              }>(
                `SELECT i.policy_version AS policy, d.changes->0->>'fieldId' AS field,
                        d.changes->0->'oldState'->>'state' AS old, d.changes->0->'oldState'->>'value' AS "oldValue",
                        d.changes->0->'newState'->>'value' AS value
                   FROM platform.ledger_approval_grants g
                   JOIN platform.trust_action_invocations i
                     ON (i.tenant_id, i.environment_id, i.invocation_id) = (g.tenant_id, g.environment_id, g.invocation_id)
                   JOIN platform.trust_business_change_documents d
                     ON (d.tenant_id, d.environment_id, d.change_document_id) = (i.tenant_id, i.environment_id, i.change_document_id)
                  WHERE (g.tenant_id, g.environment_id) = ($1,$2) AND g.operation_id = $3 AND i.outcome = 'SUCCEEDED'
                    AND d.record_id = $4
                  ORDER BY g.consumed_at DESC LIMIT 1`,
                [tenant, environment, BOOKS_START, COMPANY],
              )
            ).rows[0];
          /** Revokes `permission` on the local principal's roles for `work`. */
          const withoutGrant = async <T>(
            permission: string,
            work: () => Promise<T>,
          ): Promise<T> => {
            const revoked = (
              await pool.query<{ role: string }>(
                `UPDATE platform.current_policy_permission_grants g SET revoked_at = clock_timestamp()
                  WHERE (g.tenant_id, g.environment_id, g.permission_id) = ($1,$2,$3) AND g.revoked_at IS NULL
                    AND g.role_id IN (SELECT m.role_id FROM platform.current_policy_memberships m
                      WHERE (m.tenant_id, m.environment_id, m.principal_id) = ($1,$2,$4) AND m.revoked_at IS NULL)
                  RETURNING g.role_id AS role`,
                [tenant, environment, permission, principal],
              )
            ).rows.map((row) => row.role);
            try {
              return await work();
            } finally {
              await pool.query(
                `UPDATE platform.current_policy_permission_grants SET revoked_at = NULL
                  WHERE (tenant_id, environment_id, permission_id) = ($1,$2,$3) AND role_id = ANY($4::uuid[])`,
                [tenant, environment, permission, revoked],
              );
            }
          };

          await t.test(
            'a role granted books start receives the ledger permission it needs, and books start commits with its evidence',
            async () => {
              const first = await viaGateway('2026-01-01');
              assert.equal(
                first,
                'succeeded',
                `books start through the gateway was refused: ${first}`,
              );
              assert.equal(await booksStart(COMPANY), '2026-01-01');
              assert.deepEqual(
                await lastReceipt(),
                {
                  policy: await policyVersion(),
                  field: 'northstar.ledger.fact.booksStart',
                  old: 'ABSENT',
                  oldValue: null,
                  value: '2026-01-01',
                },
                'the first books start receipt does not record its change and policy version',
              );
              const second = await viaGateway('2026-02-01');
              assert.equal(second, 'succeeded', second);
              assert.deepEqual(
                await lastReceipt(),
                {
                  policy: await policyVersion(),
                  field: 'northstar.ledger.fact.booksStart',
                  old: 'VALUE',
                  oldValue: '2026-01-01',
                  value: '2026-02-01',
                },
                'the change document did not record the books start it replaced',
              );
            },
          );
          await t.test(
            'the books-start permission without the ledger grant is refused by the ledger',
            async () => {
              const outcome = await withoutGrant(BOOKS[0], () =>
                viaGateway('2026-03-01'),
              );
              assert.match(
                outcome,
                /ledger\.unavailable/u,
                `a role without the ledger grant started books: ${outcome}`,
              );
            },
          );
          await t.test(
            'the ledger grant without the books-start permission is refused by the gateway',
            async () => {
              const outcome = await withoutGrant(BOOKS_START_PERMISSION, () =>
                viaGateway('2026-03-01'),
              );
              assert.match(
                outcome,
                /SEMANTIC_OPERATION_POLICY_DENIED/u,
                `a role without the books-start permission started books: ${outcome}`,
              );
            },
          );

          // Putting an account (1a-ii). Company C's books are started by a
          // fixture row, not by books start, so no books-start control can
          // change what these tests see; one account (code 1000) is seeded the
          // same way. Every SQL test rolls back; only the gateway test commits
          // (code 1200).
          const companyC = randomUUID();
          const createdC = await world.invoke('legal_entity_create', {
            recordId: companyC,
            relations: {},
            values: {
              [NS + 'field.legal_entity_name']: 'Third company',
              [NS + 'field.legal_entity_code']: 'LEDGERC',
              [NS + 'field.legal_entity_is_default']: false,
              [NS + 'field.legal_entity_status']:
                NS + 'option.legal_entity_status_active',
            },
          });
          assert.equal(createdC.outcome, 'succeeded', JSON.stringify(createdC));
          await pool.query(
            `INSERT INTO platform.ledger_companies (tenant_id, environment_id, company_id, books_start)
               VALUES ($1,$2,$3,'2026-01-01');
             INSERT INTO platform.ledger_entry_counters (tenant_id, environment_id, company_id) VALUES ($1,$2,$3);
             INSERT INTO platform.ledger_accounts (tenant_id, environment_id, company_id, account_id, account_code, kind_role_id, active, label)
               VALUES ($1,$2,$3,gen_random_uuid(),'1000','northstar.ledger:role.cash',true,'Bank');`.replaceAll(
              /\$([123])/gu,
              (_, n: string) =>
                `'${[tenant, environment, companyC][Number(n) - 1]}'::uuid`,
            ),
          );
          const ACCOUNT_PUT = `${NS}operation.bookkeeping_account_put`;
          const ACCOUNT_PUT_CAPABILITY =
            'northstar.ledger:capability.ledger_account_put';
          interface PutCall {
            who: string;
            company: string;
            code?: string;
            label?: string;
            active?: string;
            expectedLabel?: string | null;
            expectedActive?: string | null;
            revision?: number;
          }
          const putInputOf = async (call: PutCall) => ({
            arguments: {
              code: call.code ?? '1100',
              kind: 'cash',
              label: call.label ?? 'Petty cash',
              active: call.active ?? 'yes',
              expectedLabel: call.expectedLabel ?? null,
              expectedActive: call.expectedActive ?? null,
            },
            expectedRevision: call.revision ?? (await revisionOf(call.company)),
            recordId: call.company,
          });
          const applyPut = (
            client: PoolClient,
            grant: string,
            facts: Facts,
            input: object,
          ) =>
            client.query<{
              result: {
                invocationId: string;
                changes: {
                  fact: string;
                  old: string | null;
                  new: string | null;
                }[];
              };
            }>(
              'SELECT platform.ledger_apply_account_put($1,$2,$3,$4,$5,$6,$7,$8) AS result',
              [
                grant,
                facts.release,
                facts.fence,
                facts.operation,
                facts.key,
                facts.channel,
                facts.policy,
                JSON.stringify(input),
              ],
            );
          /** One attested account put, rolled back: the result or the refusal. */
          const tryPut = async (
            call: PutCall,
            change: {
              attested?: Partial<Facts>;
              applied?: Partial<Facts>;
            } = {},
          ) => {
            const facts = {
              ...(await factsOf({ who: call.who, company: call.company })),
              capability: ACCOUNT_PUT_CAPABILITY,
              operation: ACCOUNT_PUT,
            };
            const input = await putInputOf(call);
            const grant = randomUUID();
            await attest(grant, { ...facts, ...change.attested }, input);
            return as(call.who, async (client) => {
              await client.query('BEGIN');
              return applyPut(
                client,
                grant,
                { ...facts, ...change.applied },
                input,
              ).then(
                (result) => result.rows[0]!.result,
                (error: unknown) => String((error as Error).message),
              );
            });
          };
          const outcomeOf = (result: unknown) =>
            typeof result === 'string' ? result : 'admitted';

          await t.test(
            'an account put creates an account under a generated ID and changes the account the person expected',
            async () => {
              const created = await tryPut({
                who: unscoped,
                company: companyC,
              });
              assert.equal(typeof created, 'object', String(created));
              const changes = (
                created as {
                  changes: {
                    fact: string;
                    old: string | null;
                    new: string | null;
                  }[];
                }
              ).changes;
              const fact = (name: string) =>
                changes.find((c) => c.fact === name);
              assert.equal(fact('accountId')?.old, null);
              assert.match(String(fact('accountId')?.new), /^[0-9a-f-]{36}$/u);
              assert.deepEqual(fact('accountKind'), {
                fact: 'accountKind',
                old: null,
                new: 'northstar.ledger:role.cash',
              });
              const renamed = await tryPut({
                who: unscoped,
                company: companyC,
                code: '1000',
                label: 'Main bank',
                active: 'no',
                expectedLabel: 'Bank',
                expectedActive: 'yes',
              });
              assert.equal(typeof renamed, 'object', String(renamed));
              const renamedChanges = (
                renamed as {
                  changes: {
                    fact: string;
                    old: string | null;
                    new: string | null;
                  }[];
                }
              ).changes;
              assert.deepEqual(
                renamedChanges.filter((c) =>
                  ['accountLabel', 'accountActive'].includes(c.fact),
                ),
                [
                  { fact: 'accountLabel', old: 'Bank', new: 'Main bank' },
                  { fact: 'accountActive', old: 'yes', new: 'no' },
                ],
              );
            },
          );
          await t.test(
            'an account put replaces only the account the person expected',
            async () => {
              const outcome = outcomeOf(
                await tryPut({
                  who: unscoped,
                  company: companyC,
                  code: '1000',
                  label: 'Main bank',
                  expectedLabel: 'Cash box',
                  expectedActive: 'yes',
                }),
              );
              assert.match(
                outcome,
                /ledger\.priorChanged/u,
                `an account put replaced an account the person did not expect: ${outcome}`,
              );
            },
          );
          await t.test(
            'a grant attested for another ledger capability never applies in an account put',
            async () => {
              const outcome = outcomeOf(
                await tryPut(
                  { who: unscoped, company: companyC },
                  { attested: { capability: CAPABILITY } },
                ),
              );
              assert.match(
                outcome,
                /ledger\.approvalRequired/u,
                `an account put consumed a grant attested for books start: ${outcome}`,
              );
            },
          );
          await t.test(
            'a read permission never authorizes an account put',
            async () => {
              const outcome = outcomeOf(
                await tryPut({ who: reader, company: companyC }),
              );
              assert.match(
                outcome,
                /ledger\.unavailable/u,
                `a journal reader put an account: ${outcome}`,
              );
            },
          );
          await t.test(
            'an account put against another company revision never applies',
            async () => {
              const outcome = outcomeOf(
                await tryPut({
                  who: unscoped,
                  company: companyC,
                  revision: (await revisionOf(companyC)) + 1,
                }),
              );
              assert.match(
                outcome,
                /ledger\.staleRevision/u,
                `an account put applied against a company revision it was not confirmed on: ${outcome}`,
              );
            },
          );
          await t.test(
            'an account put decided under a policy version that has since moved never applies',
            async () => {
              const outcome = outcomeOf(
                await tryPut(
                  { who: unscoped, company: companyC },
                  { applied: { policy: 'northstar.current-policy/987654321' } },
                ),
              );
              assert.match(
                outcome,
                /ledger\.stalePolicy/u,
                `an account put applied under a policy version that had moved: ${outcome}`,
              );
            },
          );
          await t.test(
            'an account put before books start refuses by name',
            async () => {
              const outcome = outcomeOf(
                await tryPut({ who: unscoped, company: companyB }),
              );
              assert.match(
                outcome,
                /ledger\.booksNotStarted/u,
                `an account put before books start was not refused by name: ${outcome}`,
              );
            },
          );
          await t.test(
            'an account put of an unknown kind refuses by name',
            async () => {
              const facts = {
                ...(await factsOf({ who: unscoped, company: companyC })),
                capability: ACCOUNT_PUT_CAPABILITY,
                operation: ACCOUNT_PUT,
              };
              const input = await putInputOf({
                who: unscoped,
                company: companyC,
              });
              input.arguments.kind = 'no_such_kind';
              const grant = randomUUID();
              await attest(grant, facts, input);
              const outcome = await as(unscoped, async (client) => {
                await client.query('BEGIN');
                return settled(applyPut(client, grant, facts, input));
              });
              assert.match(
                outcome,
                /ledger\.unknownAccountKind/u,
                `an account of an unknown kind was not refused by name: ${outcome}`,
              );
            },
          );
          await t.test(
            'a role granted account put receives the ledger permission it needs, and an account put commits with its evidence',
            async () => {
              const input = {
                arguments: {
                  code: '1200',
                  kind: 'cash',
                  label: 'Savings',
                  active: 'yes',
                  expectedLabel: null,
                  expectedActive: null,
                },
                expectedRevision: await revisionOf(companyC),
                recordId: companyC,
              };
              const outcome = await app.runtime.entry
                .run(local, (view) =>
                  app.runtime.operationGateway.invoke(
                    view,
                    {
                      confirmationGrant:
                        app.runtime.operationMediation.issueConfirmationGrant(
                          view,
                          ACCOUNT_PUT,
                          input,
                        ),
                      idempotencyKey: randomUUID(),
                      input,
                      operationId: ACCOUNT_PUT,
                      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                    },
                    app.runtime.operationMediation.issueInvocation(view, 'UI'),
                  ),
                )
                .then(
                  (result) =>
                    result.outcome === 'succeeded'
                      ? 'succeeded'
                      : `${result.outcome} ${String(result.unsupportedReason)}`,
                  (error: unknown) =>
                    `${String((error as Error).message)} ${String((error as { code?: unknown }).code)}`,
                );
              assert.equal(
                outcome,
                'succeeded',
                `an account put through the gateway was refused: ${outcome}`,
              );
              const { rows } = await pool.query<{
                facts: Record<string, string>;
              }>(
                `SELECT jsonb_object_agg(c->>'fieldId', c->'newState'->>'value') AS facts
                   FROM platform.ledger_approval_grants g
                   JOIN platform.trust_action_invocations i
                     ON (i.tenant_id, i.environment_id, i.invocation_id) = (g.tenant_id, g.environment_id, g.invocation_id)
                   JOIN platform.trust_business_change_documents d
                     ON (d.tenant_id, d.environment_id, d.change_document_id) = (i.tenant_id, i.environment_id, i.change_document_id)
                   CROSS JOIN jsonb_array_elements(d.changes) c
                  WHERE (g.tenant_id, g.environment_id, g.operation_id) = ($1,$2,$3) AND d.record_id = $4`,
                [tenant, environment, ACCOUNT_PUT, companyC],
              );
              assert.deepEqual(
                [
                  rows[0]?.facts['northstar.ledger.fact.accountCode'],
                  rows[0]?.facts['northstar.ledger.fact.accountLabel'],
                ],
                ['1200', 'Savings'],
                'the account put receipt does not record the account it created',
              );
            },
          );
          // Last of the account puts: under its control the commit succeeds.
          await t.test(
            'a consumed account-put grant never commits without its trust receipt',
            async () => {
              const facts = {
                ...(await factsOf({ who: unscoped, company: companyC })),
                capability: ACCOUNT_PUT_CAPABILITY,
                operation: ACCOUNT_PUT,
              };
              const input = await putInputOf({
                who: unscoped,
                company: companyC,
                code: '1900',
              });
              const grant = randomUUID();
              await attest(grant, facts, input);
              const outcome = await as(unscoped, async (client) => {
                await client.query('BEGIN');
                await applyPut(client, grant, facts, input);
                return settled(client.query('COMMIT'));
              });
              assert.match(
                outcome,
                /ledger\.receiptUnverified/u,
                `a consumed account-put grant committed with no trust receipt: ${outcome}`,
              );
            },
          );

          // Setting up a chart (1a-ii). Companies D and E have books started by
          // a fixture row and no accounts; company C's seeded account 1000 is
          // a starter code. SQL tests on D roll back, the gateway test commits
          // on E, and the receipt test on D runs last.
          const startedCompany = async (name: string, code: string) => {
            const id = randomUUID();
            const made = await world.invoke('legal_entity_create', {
              recordId: id,
              relations: {},
              values: {
                [NS + 'field.legal_entity_name']: name,
                [NS + 'field.legal_entity_code']: code,
                [NS + 'field.legal_entity_is_default']: false,
                [NS + 'field.legal_entity_status']:
                  NS + 'option.legal_entity_status_active',
              },
            });
            assert.equal(made.outcome, 'succeeded', JSON.stringify(made));
            await pool.query(
              "INSERT INTO platform.ledger_companies (tenant_id, environment_id, company_id, books_start) VALUES ($1,$2,$3,'2026-01-01')",
              [tenant, environment, id],
            );
            await pool.query(
              'INSERT INTO platform.ledger_entry_counters (tenant_id, environment_id, company_id) VALUES ($1,$2,$3)',
              [tenant, environment, id],
            );
            return id;
          };
          const companyD = await startedCompany('Fourth company', 'LEDGERD');
          const companyE = await startedCompany('Fifth company', 'LEDGERE');
          const CHART_SETUP = `${NS}operation.bookkeeping_chart_setup`;
          const CHART_CAPABILITY =
            'northstar.ledger:capability.ledger_chart_setup';
          interface ChartCall {
            who: string;
            company: string;
            starter?: string;
            jurisdiction?: string;
            revision?: number;
          }
          const chartInputOf = async (call: ChartCall) => ({
            arguments: {
              starter: call.starter ?? 'canada',
              version: '1',
              jurisdiction: call.jurisdiction ?? 'CA-BC',
            },
            expectedRevision: call.revision ?? (await revisionOf(call.company)),
            recordId: call.company,
          });
          const applyChart = (
            client: PoolClient,
            grant: string,
            facts: Facts,
            input: object,
          ) =>
            client.query<{ result: { changes: { fact: string }[] } }>(
              'SELECT platform.ledger_apply_chart_setup($1,$2,$3,$4,$5,$6,$7,$8) AS result',
              [
                grant,
                facts.release,
                facts.fence,
                facts.operation,
                facts.key,
                facts.channel,
                facts.policy,
                JSON.stringify(input),
              ],
            );
          const chartFacts = async (call: ChartCall) => ({
            ...(await factsOf({ who: call.who, company: call.company })),
            capability: CHART_CAPABILITY,
            operation: CHART_SETUP,
          });
          /** One attested chart setup, rolled back: the fact names or the refusal. */
          const tryChart = async (
            call: ChartCall,
            change: {
              attested?: Partial<Facts>;
              applied?: Partial<Facts>;
            } = {},
          ) => {
            const facts = await chartFacts(call);
            const input = await chartInputOf(call);
            const grant = randomUUID();
            await attest(grant, { ...facts, ...change.attested }, input);
            return as(call.who, async (client) => {
              await client.query('BEGIN');
              return applyChart(
                client,
                grant,
                { ...facts, ...change.applied },
                input,
              ).then(
                (result) => result.rows[0]!.result.changes.map((c) => c.fact),
                (error: unknown) => String((error as Error).message),
              );
            });
          };
          const chartOutcome = (result: unknown) =>
            typeof result === 'string' ? result : 'admitted';

          await t.test(
            'a chart setup adds the starter accounts of the chosen province',
            async () => {
              const facts = await tryChart({
                who: unscoped,
                company: companyD,
              });
              assert.ok(Array.isArray(facts), String(facts));
              assert.equal(facts[0], 'chartStarter');
              assert.ok(facts.includes('account1000'), 'the country rows');
              assert.ok(facts.includes('account2110'), 'the BC row');
              assert.ok(!facts.includes('account2120'), 'not the SK row');
              assert.ok(!facts.includes('account2130'), 'not the MB row');
            },
          );
          await t.test(
            'a chart setup never overwrites an account: a starter code in use refuses the whole chart',
            async () => {
              const outcome = chartOutcome(
                await tryChart({ who: unscoped, company: companyC }),
              );
              assert.match(
                outcome,
                /ledger\.chartCodeTaken/u,
                `a chart setup over an account in use was not refused by name: ${outcome}`,
              );
            },
          );
          await t.test(
            'a grant attested for another ledger capability never applies in a chart setup',
            async () => {
              const outcome = chartOutcome(
                await tryChart(
                  { who: unscoped, company: companyD },
                  { attested: { capability: ACCOUNT_PUT_CAPABILITY } },
                ),
              );
              assert.match(
                outcome,
                /ledger\.approvalRequired/u,
                `a chart setup consumed a grant attested for account put: ${outcome}`,
              );
            },
          );
          await t.test(
            'a read permission never authorizes a chart setup',
            async () => {
              const outcome = chartOutcome(
                await tryChart({ who: reader, company: companyD }),
              );
              assert.match(
                outcome,
                /ledger\.unavailable/u,
                `a journal reader set up a chart: ${outcome}`,
              );
            },
          );
          await t.test(
            'a chart setup against another company revision never applies',
            async () => {
              const outcome = chartOutcome(
                await tryChart({
                  who: unscoped,
                  company: companyD,
                  revision: (await revisionOf(companyD)) + 1,
                }),
              );
              assert.match(
                outcome,
                /ledger\.staleRevision/u,
                `a chart setup applied against a company revision it was not confirmed on: ${outcome}`,
              );
            },
          );
          await t.test(
            'a chart setup decided under a policy version that has since moved never applies',
            async () => {
              const outcome = chartOutcome(
                await tryChart(
                  { who: unscoped, company: companyD },
                  { applied: { policy: 'northstar.current-policy/987654321' } },
                ),
              );
              assert.match(
                outcome,
                /ledger\.stalePolicy/u,
                `a chart setup applied under a policy version that had moved: ${outcome}`,
              );
            },
          );
          await t.test(
            'a chart setup before books start refuses by name',
            async () => {
              const outcome = chartOutcome(
                await tryChart({ who: unscoped, company: companyB }),
              );
              assert.match(
                outcome,
                /ledger\.chartBeforeBooksStart/u,
                `a chart setup before books start was not refused by name: ${outcome}`,
              );
            },
          );
          await t.test(
            'an unknown starter or jurisdiction refuses by name',
            async () => {
              const outcome = chartOutcome(
                await tryChart({
                  who: unscoped,
                  company: companyD,
                  jurisdiction: 'ZZ',
                }),
              );
              assert.match(
                outcome,
                /ledger\.unknownStarter/u,
                `an unknown starter was not refused by name: ${outcome}`,
              );
            },
          );
          await t.test(
            'a role granted chart setup receives the ledger permission it needs, and a chart setup commits with its evidence',
            async () => {
              const input = await chartInputOf({
                who: unscoped,
                company: companyE,
                jurisdiction: 'CA',
              });
              const outcome = await app.runtime.entry
                .run(local, (view) =>
                  app.runtime.operationGateway.invoke(
                    view,
                    {
                      confirmationGrant:
                        app.runtime.operationMediation.issueConfirmationGrant(
                          view,
                          CHART_SETUP,
                          input,
                        ),
                      idempotencyKey: randomUUID(),
                      input,
                      operationId: CHART_SETUP,
                      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                    },
                    app.runtime.operationMediation.issueInvocation(view, 'UI'),
                  ),
                )
                .then(
                  (result) =>
                    result.outcome === 'succeeded'
                      ? 'succeeded'
                      : `${result.outcome} ${String(result.unsupportedReason)}`,
                  (error: unknown) =>
                    `${String((error as Error).message)} ${String((error as { code?: unknown }).code)}`,
                );
              assert.equal(
                outcome,
                'succeeded',
                `a chart setup through the gateway was refused: ${outcome}`,
              );
              const { rows } = await pool.query<{
                starter: string | null;
                accounts: string;
              }>(
                `SELECT (SELECT c->'newState'->>'value' FROM jsonb_array_elements(d.changes) c
                          WHERE c->>'fieldId' = 'northstar.ledger.fact.chartStarter') AS starter,
                        (SELECT count(*) FROM platform.ledger_accounts a
                          WHERE (a.tenant_id, a.environment_id, a.company_id) = ($1,$2,$4))::text AS accounts
                   FROM platform.ledger_approval_grants g
                   JOIN platform.trust_action_invocations i
                     ON (i.tenant_id, i.environment_id, i.invocation_id) = (g.tenant_id, g.environment_id, g.invocation_id)
                   JOIN platform.trust_business_change_documents d
                     ON (d.tenant_id, d.environment_id, d.change_document_id) = (i.tenant_id, i.environment_id, i.change_document_id)
                  WHERE (g.tenant_id, g.environment_id, g.operation_id) = ($1,$2,$3) AND d.record_id = $5`,
                [tenant, environment, CHART_SETUP, companyE, companyE],
              );
              assert.deepEqual(
                rows[0],
                {
                  starter: 'northstar.ledger:starter.canada@1 CA',
                  accounts: '29',
                },
                'the chart setup receipt does not record the starter it applied',
              );
            },
          );
          // Last of the chart setups: under its control the commit succeeds.
          await t.test(
            'a consumed chart-setup grant never commits without its trust receipt',
            async () => {
              const call = { who: unscoped, company: companyD };
              const facts = await chartFacts(call);
              const input = await chartInputOf(call);
              const grant = randomUUID();
              await attest(grant, facts, input);
              const outcome = await as(unscoped, async (client) => {
                await client.query('BEGIN');
                await applyChart(client, grant, facts, input);
                return settled(client.query('COMMIT'));
              });
              assert.match(
                outcome,
                /ledger\.receiptUnverified/u,
                `a consumed chart-setup grant committed with no trust receipt: ${outcome}`,
              );
            },
          );

          // The receipt the deferred check reads at commit. The runtime role
          // can insert trust rows, so these tests write a complete receipt
          // themselves (company B's creation receipt, re-keyed) with one fact
          // changed. The trust tables' deferred keys and checks all hold, so
          // only the ledger's check can refuse it.
          const template = (
            await pool.query<{ invocation: string }>(
              `SELECT invocation_id AS invocation FROM platform.trust_action_invocations
                WHERE (tenant_id, environment_id, action_id, outcome) = ($1,$2,$3,'SUCCEEDED')
                ORDER BY recorded_at LIMIT 1`,
              [tenant, environment, `${NS}operation.legal_entity_create`],
            )
          ).rows[0]!.invocation;
          interface Receipt {
            action: string;
            channel: string;
            approver: string | null;
            record: string;
          }
          const forge = async (
            client: PoolClient,
            invocation: string,
            who: string,
            release: string,
            receipt: Receipt,
          ) => {
            const request = randomUUID();
            const ids = {
              invocation_id: invocation,
              request_id: request,
              correlation_id: randomUUID(),
              action_id: receipt.action,
              release_id: release,
              change_document_id: randomUUID(),
              domain_event_id: randomUUID(),
              outbox_id: randomUUID(),
            };
            const actor = {
              execution_principal_kind: 'HUMAN',
              execution_principal_id: who,
              subject_principal_kind: null,
              subject_principal_id: null,
              initiating_human_id: who,
              approving_human_id: receipt.approver,
              delegation_id: null,
              delegating_principal_kind: null,
              delegating_principal_id: null,
              delegated_to_principal_kind: null,
              delegated_to_principal_id: null,
            };
            await client.query(
              "SELECT set_config('north_star.request_id',$1,true)",
              [request],
            );
            const copy = async (table: string, change: object) => {
              const inserted = await client.query(
                `INSERT INTO platform.${table}
                 SELECT (jsonb_populate_record(NULL::platform.${table}, to_jsonb(t) || $4::jsonb)).*
                   FROM platform.${table} t
                  WHERE (t.tenant_id, t.environment_id, t.invocation_id) = ($1,$2,$3)`,
                [tenant, environment, template, JSON.stringify(change)],
              );
              assert.equal(inserted.rowCount, 1, `one ${table} row copied`);
            };
            await copy('trust_action_invocations', {
              ...ids,
              ...actor,
              channel: receipt.channel,
            });
            await copy('trust_business_change_documents', {
              ...ids,
              ...actor,
              record_id: receipt.record,
            });
            await copy('trust_domain_events', ids);
            await copy('trust_outbox', {
              ...ids,
              deduplication_key: `ledger-receipt-test:${request}`,
            });
          };
          /** Applies books start on company B and commits with `receipt`. */
          const commitWith = async (receipt: Receipt | null) => {
            const call = {
              who: unscoped,
              company: companyB,
              expectedPrior: await booksStart(companyB),
            };
            const facts = await factsOf(call);
            const input = await inputOf(call);
            const grant = randomUUID();
            await attest(grant, facts, input);
            return as(unscoped, async (client) => {
              await client.query('BEGIN');
              const applied = await apply(client, grant, facts, input);
              if (receipt)
                await forge(
                  client,
                  applied.rows[0]!.result.invocationId,
                  unscoped,
                  facts.release,
                  receipt,
                );
              return settled(client.query('COMMIT'));
            });
          };
          const exact: Receipt = {
            action: BOOKS_START,
            channel: 'UI',
            approver: null,
            record: companyB,
          };
          await t.test(
            'a receipt naming every fact of the grant verifies it at commit',
            async () => {
              const outcome = await commitWith(exact);
              assert.equal(outcome, 'admitted', outcome);
            },
          );
          const wrongReceipts: readonly (readonly [
            string,
            Partial<Receipt>,
          ])[] = [
            [
              'another operation',
              { action: `${NS}operation.legal_entity_update` },
            ],
            ['another channel', { channel: 'API' }],
            ['another approving human', { approver: randomUUID() }],
            ['another company record', { record: COMPANY }],
          ];
          for (const [label, wrong] of wrongReceipts)
            await t.test(
              `a receipt of ${label} never verifies the grant`,
              async () => {
                const outcome = await commitWith({ ...exact, ...wrong });
                assert.match(
                  outcome,
                  /ledger\.receiptUnverified/u,
                  `a receipt of ${label} verified the grant: ${outcome}`,
                );
              },
            );
          // Last: under its control a commit without a receipt would succeed.
          await t.test(
            'a consumed grant never commits without its trust receipt',
            async () => {
              const outcome = await commitWith(null);
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
