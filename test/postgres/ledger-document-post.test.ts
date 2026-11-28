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

// DOCUMENT-POSTING slice 1: a staged manual journal posts through the general
// document-posting binding. The thin path drives the product's gateway with
// the grants the install wrote; the SQL reds attest a grant as the issuer and
// call the apply as north_star_runtime, so each refusal dies alone in SQL and
// rolls back. Two companies share ONE tenant and environment; their books
// start, accounts and counters are fixture rows, so no books-start control can
// change what these tests see.

const NS = 'northstar.app:';
const POST = `${NS}operation.bookkeeping_draft_post`;
const POST_PERMISSION = `${NS}permission.bookkeeping_draft_post`;
const CAPABILITY = 'northstar.ledger:capability.general_ledger';
const JOURNAL_POST = [
  'northstar.ledger:permission.journal_post',
  'northstar.ledger:capability.journal',
] as const;
const BOOKS = [
  'northstar.ledger:permission.books_configure',
  'northstar.ledger:capability.books',
] as const;
const field = (local: string) => `${NS}field.${local}`;
const option = (local: string) => `${NS}option.${local}`;
const DRAFT_ENTITY = `${NS}entity.bookkeeping_draft`;
const LINE_ENTITY = `${NS}entity.bookkeeping_draft_line`;
const STATE_FIELD = `${NS}derived_state_field.machine.bookkeeping_draft_lifecycle`;
const READY = `${NS}state.bookkeeping_draft_state_ready`;
const POSTED = `${NS}state.bookkeeping_draft_state_posted`;
const RELATION = `${NS}relation.bookkeeping_draft_line_draft`;

interface StorageEntity {
  physicalTableName: string;
  columns: { canonicalFieldId: string; physicalName: string }[];
  optimisticRevision: { column: string };
}
const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

test(
  'ledger document post: a staged journal posts once through the document-posting binding',
  { timeout: 1_200_000 },
  async (t) => {
    await withEphemeralPostgres(
      'ledger-document-post',
      async ({ connection: c, pool }) => {
        const databaseUrl = `postgresql://${c.user}@${c.host}:${c.port}/${c.database}`;
        const tenantSlug = 'ledger-document-post';
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
              [field('legal_entity_name')]: 'Second company',
              [field('legal_entity_code')]: 'POSTB',
              [field('legal_entity_is_default')]: false,
              [field('legal_entity_status')]: option(
                'legal_entity_status_active',
              ),
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
          for (const [company, codes] of [
            [COMPANY, ['1000', '3000', '1100', '1200']],
            [companyB, ['1000', '3000', '7777']],
          ] as const) {
            await pool.query(
              `INSERT INTO platform.ledger_companies (tenant_id, environment_id, company_id, books_start)
                 VALUES ($1,$2,$3,'2026-01-01')`,
              [tenant, environment, company],
            );
            await pool.query(
              'INSERT INTO platform.ledger_entry_counters (tenant_id, environment_id, company_id) VALUES ($1,$2,$3)',
              [tenant, environment, company],
            );
            for (const code of codes)
              await pool.query(
                `INSERT INTO platform.ledger_accounts (tenant_id, environment_id, company_id, account_id, account_code,
                   kind_role_id, active, label) VALUES ($1,$2,$3,gen_random_uuid(),$4,$5,$6,$7)`,
                [
                  tenant,
                  environment,
                  company,
                  code,
                  code === '3000'
                    ? 'northstar.ledger:role.owner_equity'
                    : code === '1100'
                      ? 'northstar.ledger:role.receivable'
                      : 'northstar.ledger:role.cash',
                  code !== '1200',
                  `Account ${code}`,
                ],
              );
          }
          const pointer = async () =>
            (
              await pool.query<{ release: string; fence: string }>(
                'SELECT release_id AS release, fence::text AS fence FROM platform.active_release_pointers WHERE (tenant_id, environment_id) = ($1,$2)',
                [tenant, environment],
              )
            ).rows[0]!;
          const policyVersion = async () =>
            (
              await pool.query<{ version: string }>(
                `SELECT 'northstar.current-policy/' || coalesce((SELECT policy_version::text
                   FROM platform.current_policy_epochs WHERE (tenant_id, environment_id) = ($1,$2)), '0') AS version`,
                [tenant, environment],
              )
            ).rows[0]!.version;
          // The released storage of the draft and its lines, as the ledger
          // reads it: by canonical ID.
          const storage = async (entityId: string) =>
            (
              await pool.query<{ entity: StorageEntity }>(
                `SELECT v AS entity FROM platform.active_release_pointers p
                   JOIN platform.tenant_release_projection_links projection USING (tenant_id, environment_id, release_id)
                   JOIN platform.tenant_release_chunk_links chunk USING (tenant_id, environment_id, release_id, projection_instance_id)
                   JOIN platform.release_artifact_blobs blob ON blob.content_hash = chunk.chunk_hash
                     AND blob.artifact_kind = 'projectionChunk'
                   CROSS JOIN jsonb_array_elements(convert_from(blob.canonical_bytes, 'UTF8')::jsonb->'entities') v
                  WHERE (p.tenant_id, p.environment_id) = ($1,$2)
                    AND projection.projection_family_id = 'northstar.compiler:projection-family.storage-target'
                    AND v->>'entityId' = $3`,
                [tenant, environment, entityId],
              )
            ).rows[0]!.entity;
          const draftTable = await storage(DRAFT_ENTITY);
          const lineTable = await storage(LINE_ENTITY);
          const column = (entity: StorageEntity, fieldId: string) =>
            quoted(
              entity.columns.find((col) => col.canonicalFieldId === fieldId)!
                .physicalName,
            );
          const relationColumn = (
            await pool.query<{ name: string }>(
              `SELECT r#>>'{relationColumn,physicalName}' AS name FROM platform.active_release_pointers p
                 JOIN platform.tenant_release_projection_links projection USING (tenant_id, environment_id, release_id)
                 JOIN platform.tenant_release_chunk_links chunk USING (tenant_id, environment_id, release_id, projection_instance_id)
                 JOIN platform.release_artifact_blobs blob ON blob.content_hash = chunk.chunk_hash
                   AND blob.artifact_kind = 'projectionChunk'
                 CROSS JOIN jsonb_array_elements(convert_from(blob.canonical_bytes, 'UTF8')::jsonb->'relations') r
                WHERE (p.tenant_id, p.environment_id) = ($1,$2)
                  AND projection.projection_family_id = 'northstar.compiler:projection-family.storage-target'
                  AND r->>'relationId' = $3`,
              [tenant, environment, RELATION],
            )
          ).rows[0]!.name;
          /** The draft's stored revision and state. */
          const draftRow = async (draft: string) =>
            (
              await pool.query<{ revision: string; state: string }>(
                `SELECT ${quoted(draftTable.optimisticRevision.column)}::text AS revision,
                        ${column(draftTable, STATE_FIELD)} AS state
                   FROM north_star_module.${quoted(draftTable.physicalTableName)}
                  WHERE (tenant_id, environment_id, record_id) = ($1,$2,$3)`,
                [tenant, environment, draft],
              )
            ).rows[0]!;
          const revisionOf = async (draft: string) =>
            Number((await draftRow(draft)).revision);
          const lineRows = async (draft: string) =>
            (
              await pool.query<{ id: string; revision: string }>(
                `SELECT record_id::text AS id, ${quoted(lineTable.optimisticRevision.column)}::text AS revision
                   FROM north_star_module.${quoted(lineTable.physicalTableName)}
                  WHERE (tenant_id, environment_id) = ($1,$2) AND ${quoted(relationColumn)} = $3
                  ORDER BY ${column(lineTable, field('bookkeeping_draft_line_number'))}`,
                [tenant, environment, draft],
              )
            ).rows;
          /** Writes a line's amount directly (a fixture, not a person's edit). */
          const setAmounts = (draft: string, amount: string) =>
            pool.query(
              `UPDATE north_star_module.${quoted(lineTable.physicalTableName)}
                  SET ${column(lineTable, field('bookkeeping_draft_line_amount'))} = $4
                WHERE (tenant_id, environment_id) = ($1,$2) AND ${quoted(relationColumn)} = $3`,
              [tenant, environment, draft, amount],
            );

          // The product's gateway, as the local principal the install granted.
          const local = { headers: { authorization: 'local' } };
          const principal = await app.runtime.entry.run(local, (view) =>
            Promise.resolve(view.principalId),
          );
          const viaGateway = (local_: string, input: object) =>
            app.runtime.entry
              .run(local, async (view) => {
                const operationId = `${NS}operation.${local_}`;
                const confirmed = operationId === POST;
                return app.runtime.operationGateway.invoke(
                  view,
                  {
                    confirmationGrant: confirmed
                      ? app.runtime.operationMediation.issueConfirmationGrant(
                          view,
                          operationId,
                          input as never,
                        )
                      : null,
                    idempotencyKey: randomUUID(),
                    input: input as never,
                    operationId,
                    schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                  },
                  app.runtime.operationMediation.issueInvocation(view, 'UI'),
                );
              })
              .then(
                (result) =>
                  result.outcome === 'succeeded'
                    ? 'succeeded'
                    : `${result.outcome} ${String(result.unsupportedReason)}`,
                (error: unknown) =>
                  `${String((error as Error).message)} ${String((error as { code?: unknown }).code)}`,
              );
          const ok = (outcome: string, label: string) =>
            assert.equal(outcome, 'succeeded', `${label}: ${outcome}`);
          interface Line {
            code: string;
            side: 'debit' | 'credit';
            amount: string;
          }
          const balanced: readonly Line[] = [
            { code: '1000', side: 'debit', amount: '100' },
            { code: '3000', side: 'credit', amount: '100' },
          ];
          /** A Draft journal with its lines, entered through the gateway. */
          const draftOf = async (
            company: string,
            lines: readonly Line[] = balanced,
          ) => {
            const draft = randomUUID();
            ok(
              await viaGateway('bookkeeping_draft_create', {
                recordId: draft,
                legalEntityId: company,
                relations: {},
                values: {
                  [field('bookkeeping_draft_kind')]: option(
                    'bookkeeping_draft_kind_manual',
                  ),
                  [field('bookkeeping_draft_currency')]: 'CAD',
                  [field('bookkeeping_draft_date')]: '2026-03-01',
                  [field('bookkeeping_draft_memo')]: 'Owner investment',
                },
              }),
              'a journal draft was not created',
            );
            for (const [index, line] of lines.entries())
              ok(
                await viaGateway('bookkeeping_draft_line_create', {
                  recordId: randomUUID(),
                  legalEntityId: company,
                  relations: { [RELATION]: draft },
                  values: {
                    [field('bookkeeping_draft_line_number')]: String(index + 1),
                    [field('bookkeeping_draft_line_account_code')]: line.code,
                    [field('bookkeeping_draft_line_side')]: option(
                      `bookkeeping_draft_line_side_${line.side}`,
                    ),
                    [field('bookkeeping_draft_line_amount')]: line.amount,
                  },
                }),
                'a journal line was not created',
              );
            return draft;
          };
          const ready = async (draft: string) =>
            ok(
              await viaGateway('bookkeeping_draft_ready', {
                recordId: draft,
                expectedRevision: await revisionOf(draft),
              }),
              'a draft was not marked ready',
            );
          const readyDraftOf = async (
            company: string,
            lines: readonly Line[] = balanced,
          ) => {
            const draft = await draftOf(company, lines);
            await ready(draft);
            return draft;
          };
          const entriesOf = async (
            draft: string,
            client: pg.Pool | PoolClient = pool,
          ) =>
            (
              await client.query<{
                kind: string;
                amounts: string;
                company: string;
              }>(
                `SELECT x.entry_kind AS kind, x.company_id::text AS company,
                        string_agg(l.side || l.amount::text, ',' ORDER BY l.line_number) AS amounts
                   FROM platform.ledger_entries x JOIN platform.ledger_lines l USING (tenant_id, environment_id, entry_id)
                  WHERE (x.tenant_id, x.environment_id, x.record_id) = ($1,$2,$3)
                  GROUP BY x.entry_id, x.entry_kind, x.company_id`,
                [tenant, environment, draft],
              )
            ).rows;

          // SQL reds: principals with exactly the ledger grants they name.
          const policyRole = async (
            grants: readonly (readonly [string, string])[],
          ) => {
            const role = randomUUID();
            await pool.query(
              'INSERT INTO platform.current_policy_roles(tenant_id,environment_id,role_id,role_key) VALUES ($1,$2,$3,$4)',
              [tenant, environment, role, `post_${role.slice(0, 8)}`],
            );
            for (const [permission, resource] of grants)
              await pool.query(
                'INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id) VALUES ($1,$2,$3,$4,$5)',
                [tenant, environment, role, permission, resource],
              );
            return role;
          };
          const member = (who: string, role: string, company: string | null) =>
            pool.query(
              'INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id) VALUES ($1,$2,gen_random_uuid(),$3,$4,$5)',
              [tenant, environment, who, role, company],
            );
          const posting = await policyRole([JOURNAL_POST]);
          const configuring = await policyRole([BOOKS]);
          const poster = randomUUID(),
            posterA = randomUUID(),
            configurer = randomUUID();
          await member(poster, posting, null);
          await member(posterA, posting, COMPANY);
          await member(configurer, configuring, null);
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
          const settled = (pending: Promise<unknown>) =>
            pending.then(
              () => 'admitted',
              (error: unknown) => String((error as Error).message),
            );
          interface Call {
            who?: string;
            draft: string;
            revision?: number;
            capability?: string;
            fence?: string;
            isolation?: string;
            /** Commits an admitted post (the SQL reds roll back). */
            commit?: boolean;
          }
          /**
           * One attested post as `who` (the unscoped poster by default), in a
           * transaction that is rolled back. Returns the refusal, "admitted",
           * or what `after` reads inside the transaction.
           */
          const tryPost = async (call: Call) => {
            const who = call.who ?? poster;
            const current = await pointer();
            const fence = call.fence ?? current.fence;
            const key = randomUUID();
            const grant = randomUUID();
            const input = {
              expectedRevision: call.revision ?? (await revisionOf(call.draft)),
              recordId: call.draft,
            };
            await issuer.query(
              'SELECT platform.ledger_attest_approval($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
              [
                grant,
                call.capability ?? CAPABILITY,
                tenant,
                environment,
                who,
                who,
                current.release,
                fence,
                POST,
                key,
                JSON.stringify(input),
                'UI',
              ],
            );
            const policy = await policyVersion();
            return as(who, async (client) => {
              await client.query(
                `BEGIN ISOLATION LEVEL ${call.isolation ?? 'READ COMMITTED'}`,
              );
              const outcome = await settled(
                client.query(
                  'SELECT platform.ledger_apply_document_post($1,$2,$3,$4,$5,$6,$7,$8) AS result',
                  [
                    grant,
                    current.release,
                    fence,
                    POST,
                    key,
                    'UI',
                    policy,
                    JSON.stringify(input),
                  ],
                ),
              );
              if (outcome === 'admitted' && call.commit)
                await client.query('COMMIT');
              return outcome;
            });
          };

          await t.test(
            'a CAD journal marked ready posts one manual entry through the gateway, and the draft is posted',
            async () => {
              const draft = await readyDraftOf(COMPANY);
              const readyRevision = await revisionOf(draft);
              ok(
                await viaGateway('bookkeeping_draft_post', {
                  recordId: draft,
                  expectedRevision: readyRevision,
                }),
                'the post through the gateway was refused',
              );
              assert.deepEqual(await entriesOf(draft), [
                { kind: 'manual', company: COMPANY, amounts: 'D10000,C10000' },
              ]);
              assert.deepEqual(await draftRow(draft), {
                revision: String(readyRevision + 1),
                state: POSTED,
              });
              const receipt = (
                await pool.query<{ facts: string }>(
                  `SELECT string_agg(c->>'fieldId' || '=' || coalesce(c->'newState'->>'value', '-'), ' '
                            ORDER BY c->>'fieldId') AS facts
                     FROM platform.trust_business_change_documents d CROSS JOIN jsonb_array_elements(d.changes) c
                    WHERE (d.tenant_id, d.environment_id, d.record_id) = ($1,$2,$3)
                      AND d.changes::text LIKE '%northstar.ledger.fact.%'`,
                  [tenant, environment, draft],
                )
              ).rows[0]!.facts;
              assert.match(
                receipt,
                new RegExp(
                  `^northstar\\.ledger\\.fact\\.entryNumber=1 northstar\\.ledger\\.fact\\.state=${POSTED.replaceAll('.', '\\.')}$`,
                  'u',
                ),
                'the post receipt does not record the state and entry number',
              );
              const again = await viaGateway('bookkeeping_draft_post', {
                recordId: draft,
                expectedRevision: readyRevision + 1,
              });
              assert.match(
                again,
                /ledger\.notReady/u,
                `a posted draft posted again: ${again}`,
              );
              assert.equal((await entriesOf(draft)).length, 1);
            },
          );

          await t.test(
            'line create, update and archive are refused once the draft is Ready, and once it is Posted',
            async () => {
              const draft = await readyDraftOf(COMPANY);
              const attempts = async (label: string) => {
                const [line] = await lineRows(draft);
                const outcomes = {
                  create: await viaGateway('bookkeeping_draft_line_create', {
                    recordId: randomUUID(),
                    legalEntityId: COMPANY,
                    relations: { [RELATION]: draft },
                    values: {
                      [field('bookkeeping_draft_line_number')]: '9',
                      [field('bookkeeping_draft_line_account_code')]: '1000',
                      [field('bookkeeping_draft_line_side')]: option(
                        'bookkeeping_draft_line_side_debit',
                      ),
                      [field('bookkeeping_draft_line_amount')]: '5',
                    },
                  }),
                  update: await viaGateway('bookkeeping_draft_line_update', {
                    recordId: line!.id,
                    expectedRevision: Number(line!.revision),
                    patch: { [field('bookkeeping_draft_line_amount')]: '7' },
                  }),
                  archive: await viaGateway('bookkeeping_draft_line_archive', {
                    recordId: line!.id,
                    expectedRevision: Number(line!.revision),
                  }),
                };
                for (const [write, outcome] of Object.entries(outcomes))
                  assert.notEqual(
                    outcome,
                    'succeeded',
                    `a line ${write} on a ${label} draft was admitted`,
                  );
              };
              await attempts('Ready');
              ok(
                await viaGateway('bookkeeping_draft_post', {
                  recordId: draft,
                  expectedRevision: await revisionOf(draft),
                }),
                'the post was refused',
              );
              await attempts('Posted');
              assert.deepEqual(await entriesOf(draft), [
                { kind: 'manual', company: COMPANY, amounts: 'D10000,C10000' },
              ]);
            },
          );

          await t.test(
            'the post reads every line committed while it waited on the header',
            async () => {
              const draft = await readyDraftOf(COMPANY);
              // A writer outside the gateway holds the header as a line
              // writer does (FOR SHARE) and changes both amounts.
              const writer = await pool.connect();
              try {
                await writer.query('BEGIN');
                await writer.query(
                  `SELECT 1 FROM north_star_module.${quoted(draftTable.physicalTableName)}
                    WHERE (tenant_id, environment_id, record_id) = ($1,$2,$3) FOR SHARE`,
                  [tenant, environment, draft],
                );
                await writer.query(
                  `UPDATE north_star_module.${quoted(lineTable.physicalTableName)}
                      SET ${column(lineTable, field('bookkeeping_draft_line_amount'))} = 150
                    WHERE (tenant_id, environment_id) = ($1,$2) AND ${quoted(relationColumn)} = $3`,
                  [tenant, environment, draft],
                );
                const posted = tryPost({ draft, commit: true });
                for (let i = 0; i < 100; i += 1) {
                  const waiting = await pool.query(
                    `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
                       AND query LIKE '%ledger_apply_document_post%'`,
                  );
                  if (waiting.rowCount) break;
                  await new Promise((resolve) => setTimeout(resolve, 100));
                }
                await writer.query('COMMIT');
                assert.equal(await posted, 'admitted');
                assert.equal(
                  (await entriesOf(draft))[0]?.amounts ?? 'none',
                  'D15000,C15000',
                  'the post missed a line change committed while it waited',
                );
              } finally {
                await writer.query('ROLLBACK').catch(() => undefined);
                writer.release();
              }
            },
          );

          await t.test(
            'a draft forced back to Ready cannot post a second entry',
            async () => {
              const draft = await readyDraftOf(COMPANY);
              assert.equal(await tryPost({ draft }), 'admitted');
              ok(
                await viaGateway('bookkeeping_draft_post', {
                  recordId: draft,
                  expectedRevision: await revisionOf(draft),
                }),
                'the post was refused',
              );
              // A writer outside the gateway moves the state back.
              await pool.query(
                `UPDATE north_star_module.${quoted(draftTable.physicalTableName)}
                    SET ${column(draftTable, STATE_FIELD)} = $4
                  WHERE (tenant_id, environment_id, record_id) = ($1,$2,$3)`,
                [tenant, environment, draft, READY],
              );
              const second = await tryPost({ draft });
              assert.match(
                second,
                /ledger\.documentPosted/u,
                `a draft forced back to Ready posted a second entry: ${second}`,
              );
            },
          );

          await t.test(
            'a grant attested for books start never applies in the post',
            async () => {
              const draft = await readyDraftOf(COMPANY);
              const outcome = await tryPost({
                draft,
                capability: 'northstar.ledger:capability.ledger_books_start',
              });
              assert.match(
                outcome,
                /ledger\.approvalRequired/u,
                `the post consumed a grant attested for books start: ${outcome}`,
              );
            },
          );

          await t.test(
            'journal_post is the money gate: books_configure alone cannot post, and each layer refuses without its grant',
            async () => {
              const draft = await readyDraftOf(COMPANY);
              const configured = await tryPost({ draft, who: configurer });
              assert.match(
                configured,
                /ledger\.unavailable/u,
                `books_configure alone posted a journal: ${configured}`,
              );
              const withoutGrant = async (permission: string) => {
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
                  return await viaGateway('bookkeeping_draft_post', {
                    recordId: draft,
                    expectedRevision: await revisionOf(draft),
                  });
                } finally {
                  await pool.query(
                    `UPDATE platform.current_policy_permission_grants SET revoked_at = NULL
                      WHERE (tenant_id, environment_id, permission_id) = ($1,$2,$3) AND role_id = ANY($4::uuid[])`,
                    [tenant, environment, permission, revoked],
                  );
                }
              };
              const noLedger = await withoutGrant(JOURNAL_POST[0]);
              assert.match(
                noLedger,
                /ledger\.unavailable/u,
                `the post permission without journal_post posted: ${noLedger}`,
              );
              const noOperation = await withoutGrant(POST_PERMISSION);
              assert.match(
                noOperation,
                /SEMANTIC_OPERATION_POLICY_DENIED/u,
                `journal_post without the post permission posted: ${noOperation}`,
              );
              assert.deepEqual(await entriesOf(draft), []);
            },
          );

          await t.test(
            "a principal of company A cannot post company B's journal, nor book to B's account codes",
            async () => {
              const draftB = await readyDraftOf(companyB);
              const foreign = await tryPost({ draft: draftB, who: posterA });
              assert.match(
                foreign,
                /ledger\.unavailable/u,
                `a principal of company A posted company B's journal: ${foreign}`,
              );
              assert.equal(await tryPost({ draft: draftB }), 'admitted');
              const draftA = await readyDraftOf(COMPANY, [
                { code: '7777', side: 'debit', amount: '100' },
                { code: '3000', side: 'credit', amount: '100' },
              ]);
              const code = await tryPost({ draft: draftA, who: posterA });
              assert.match(
                code,
                /ledger\.accountUnavailable/u,
                `company A's journal booked to an account code only company B has: ${code}`,
              );
            },
          );

          await t.test(
            'amounts are whole minor units: 0, -1.00 and 0.001 CAD refuse, and the conversion is exact at exponents 0, 2, 3 and 4',
            async () => {
              const convert = (amount: string, exponent: number) =>
                settled(
                  pool
                    .query<{ minor: string }>(
                      'SELECT north_star_internal.ledger_minor_units($1::numeric, $2::smallint)::text AS minor',
                      [amount, exponent],
                    )
                    .then((result) => {
                      throw new Error(`converted ${result.rows[0]!.minor}`);
                    }),
                );
              for (const [amount, exponent, expected] of [
                ['12', 0, 'converted 12'],
                ['1.5', 0, 'ledger.unrepresentableAmount'],
                ['100.00', 2, 'converted 10000'],
                ['1.234', 2, 'ledger.unrepresentableAmount'],
                ['1.234', 3, 'converted 1234'],
                ['1.2345', 4, 'converted 12345'],
                ['0.00001', 4, 'ledger.unrepresentableAmount'],
                ['0', 2, 'ledger.amountNotPositive'],
                ['-1.00', 2, 'ledger.amountNotPositive'],
                ['99999999999999.99', 2, 'converted 9999999999999999'],
              ] as const)
                assert.equal(
                  await convert(amount, exponent),
                  expected,
                  `the minor-unit conversion of ${amount} at exponent ${exponent} is not exact`,
                );
              for (const [amount, reason] of [
                ['0', /ledger\.amountNotPositive/u],
                ['-1', /ledger\.amountNotPositive/u],
                ['0.001', /ledger\.unrepresentableAmount/u],
              ] as const) {
                const draft = await draftOf(COMPANY);
                await setAmounts(draft, amount);
                await ready(draft);
                const outcome = await tryPost({ draft });
                assert.match(
                  outcome,
                  reason,
                  `a CAD journal of ${amount} posted: ${outcome}`,
                );
              }
            },
          );

          await t.test(
            'a confirmation of the Ready revision before a reopen, edit and Ready again is refused',
            async () => {
              const draft = await readyDraftOf(COMPANY);
              const confirmed = await revisionOf(draft);
              ok(
                await viaGateway('bookkeeping_draft_reopen', {
                  recordId: draft,
                  expectedRevision: confirmed,
                }),
                'the reopen was refused',
              );
              for (const line of await lineRows(draft))
                ok(
                  await viaGateway('bookkeeping_draft_line_update', {
                    recordId: line.id,
                    expectedRevision: Number(line.revision),
                    patch: { [field('bookkeeping_draft_line_amount')]: '250' },
                  }),
                  'a line edit on the reopened draft was refused',
                );
              await ready(draft);
              const stale = await tryPost({ draft, revision: confirmed });
              assert.match(
                stale,
                /ledger\.staleRevision/u,
                `a post confirmed on an earlier Ready revision applied: ${stale}`,
              );
            },
          );

          await t.test(
            'the post refuses a Draft, an inactive or control account, another release and repeatable read',
            async () => {
              const draft = await draftOf(COMPANY);
              assert.match(await tryPost({ draft }), /ledger\.notReady/u);
              await ready(draft);
              assert.match(
                await tryPost({ draft, fence: '999999' }),
                /ledger\.staleRelease/u,
              );
              assert.match(
                await tryPost({ draft, isolation: 'REPEATABLE READ' }),
                /ledger\.requiresReadCommitted/u,
              );
              for (const [code, reason] of [
                ['1200', /ledger\.accountInactive/u],
                ['1100', /ledger\.controlRoleRefused/u],
              ] as const) {
                const other = await readyDraftOf(COMPANY, [
                  { code, side: 'debit', amount: '100' },
                  { code: '3000', side: 'credit', amount: '100' },
                ]);
                assert.match(await tryPost({ draft: other }), reason);
              }
            },
          );

          await t.test(
            'only north_star_runtime executes the post and the draft company read',
            async () => {
              const { rows } = await pool.query<{ entry: string }>(
                `SELECT r.rolname || ' ' || f AS entry FROM pg_roles r CROSS JOIN unnest($1::text[]) f
                  WHERE NOT r.rolsuper AND r.oid <> (SELECT proowner FROM pg_proc WHERE oid = f::regprocedure)
                    AND has_function_privilege(r.oid, f::regprocedure, 'EXECUTE') ORDER BY 1`,
                [
                  [
                    'platform.ledger_apply_document_post(uuid,uuid,bigint,text,uuid,text,text,jsonb)',
                    'platform.ledger_document_company(uuid,text,uuid)',
                    'north_star_internal.ledger_document_binding(uuid,text)',
                    'north_star_internal.ledger_release_projection(uuid,text)',
                    'north_star_internal.ledger_minor_units(numeric,smallint)',
                    'north_star_internal.ledger_bound_column(jsonb,text)',
                  ],
                ],
              );
              assert.deepEqual(
                rows.map((row) => row.entry),
                [
                  'north_star_runtime platform.ledger_apply_document_post(uuid,uuid,bigint,text,uuid,text,text,jsonb)',
                  'north_star_runtime platform.ledger_document_company(uuid,text,uuid)',
                ],
                'a document-post function is executable beyond its grant',
              );
            },
          );
        } finally {
          await runtime.end();
          await issuer.end();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
