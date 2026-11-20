import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  defaultBoardChoices,
  draftBoardRevision,
} from '../../packages/customization/src/board-revision.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

// CALENDAR-1 Board v2 fix, review findings 3 and 5: who sees and makes a move,
// in which company, and how a partial read renders. One tenant, two companies.
const NS = 'northstar.app:';
const type = 'custom_deal';
const entity = `${NS}entity.${type}`;
const name = `${NS}field.${type}_name`;
const markWon = `${NS}operation.${type}_action_mark_won`;
const markLost = `${NS}operation.${type}_action_mark_lost`;
const scope = `${NS}parameter.${type}_list_legal_entity_scope`;
const manager = 'northstar-demo-actor=manager';

test(
  'a company-scoped Board offers only granted live moves in its company, refuses a forged confirm and never renders a partial read as empty',
  { timeout: 900_000 },
  async (t) => {
    await withEphemeralPostgres(
      'board-policy',
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'board-policy',
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        const activate = async (change: unknown) => {
          const draft = await opened.service.draft(change, 'visualBuilder');
          assert.ok(draft.status === 'drafted', JSON.stringify(draft));
          await opened.service.approve(draft.patchId);
          await opened.service.activate(draft.patchId);
        };
        try {
          await activate({
            kind: 'changeSet',
            patches: [
              {
                kind: 'addRecordType',
                label: 'Deal',
                companyOwnership: 'entityOwned',
                fields: [{ label: 'Name', type: 'text', required: true }],
              },
              {
                kind: 'declareLifecycle',
                entity,
                initial: 'Open',
                states: [
                  { label: 'Open' },
                  { label: 'Won' },
                  { label: 'Lost' },
                ],
                transitions: [
                  { from: 'Open', to: 'Won', label: 'Mark won' },
                  { from: 'Open', to: 'Lost', label: 'Mark lost' },
                ],
              },
            ],
          });
          const target = (await opened.service.targets()).boards?.find(
            (b) => b.frame.entityId === entity,
          );
          assert.ok(target, 'a company-owned tenant type offers a Board');
          assert.equal(target.frame.listQuery.companyScope, 'exactlyOne');
          const board = draftBoardRevision(
            target,
            'Deals',
            defaultBoardChoices(target),
          );
          assert.deepEqual(
            board.body.grouping.moves.map((m) => m.operationId).sort(),
            [markLost, markWon],
          );
          await activate(board);
          const world = worldOver(app.runtime, String(connection.database));
          const other = randomUUID();
          await world.invoke('legal_entity_create', {
            recordId: other,
            values: {
              [`${NS}field.legal_entity_code`]: 'DEALS-B',
              [`${NS}field.legal_entity_name`]: 'Deals B',
              [`${NS}field.legal_entity_is_default`]: false,
              [`${NS}field.legal_entity_status`]: `${NS}option.legal_entity_status_active`,
            },
          });
          const companyOf = new Map<string, string>();
          const deal = async (company: string, label: string) => {
            const recordId = randomUUID();
            const result = await world.invoke(`${type}_create`, {
              legalEntityId: company,
              recordId,
              values: { [name]: label },
            });
            assert.equal(result.outcome, 'succeeded', label);
            companyOf.set(recordId, company);
            return recordId;
          };
          const alpha = await deal(COMPANY, 'Alpha one');
          const beta = await deal(other, 'Beta one');
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const tables = await pool.query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables
              WHERE table_schema = 'north_star_module' AND table_name LIKE '%deal%'`,
          );
          const table = tables.rows[0]?.table_name;
          assert.ok(table, JSON.stringify(tables.rows));
          const url = (company: string) => {
            const value = new URL('/', app.baseUrl);
            value.searchParams.set('surface', board.surfaceId);
            value.searchParams.set(scope, company);
            return value;
          };
          const get = async (company: string, cookie = '') => {
            const response = await fetch(url(company), {
              headers: { cookie },
            });
            return { status: response.status, html: await response.text() };
          };
          const post = async (
            company: string,
            form: Record<string, string>,
            cookie = '',
          ) => {
            const response = await fetch(url(company), {
              method: 'POST',
              headers: {
                cookie,
                origin: new URL(app.baseUrl).origin,
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams(form).toString(),
              redirect: 'manual',
            });
            return { status: response.status, html: await response.text() };
          };
          const hiddenValue = (html: string, field: string) =>
            html.match(new RegExp(`name="${field}" value="([^"]*)"`, 'u'))?.[1];
          const revision = (recordId: string) =>
            app.runtime.entry.run(
              { headers: { cookie: manager } },
              async (view) => {
                const result = await app.runtime.queryGateway.invoke(view, {
                  schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                  queryId: `${NS}query.${type}_get`,
                  arguments: {
                    recordId,
                    [`${NS}parameter.${type}_get_legal_entity_scope`]:
                      companyOf.get(recordId)!,
                  },
                });
                assert.ok(result.records[0], 'the manager reads ' + recordId);
                return result.records[0].revision;
              },
            );
          const openState = target.stages.find((s) => s.label === 'Open')!;
          const open = async (company: string, recordId: string, cookie = '') =>
            post(
              company,
              {
                boardAction: 'open',
                recordId,
                expectedRevision: String(await revision(recordId)),
                sourceState: openState.stateId,
              },
              cookie,
            );
          const moveCard = (label: string) =>
            `aria-label="Move card: ${label}"`;

          // The buyer is a company-scoped principal of the first company.
          const membership = await pool.query(
            'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND revoked_at IS NULL',
            [tenantId, environmentId, principalId, COMPANY],
          );
          assert.ok(membership.rowCount);

          await t.test('a company-scoped read and move', async () => {
            const page = await get(COMPANY);
            assert.equal(page.status, 200, page.html.slice(-600));
            assert.match(page.html, /Alpha one/u);
            assert.doesNotMatch(page.html, /Beta one/u);
            assert.match(page.html, new RegExp(moveCard('Alpha one'), 'u'));
            const task = await open(COMPANY, alpha);
            assert.match(task.html, /Won · Mark won/u);
            const reviewed = await post(COMPANY, {
              boardAction: 'choose',
              recordId: alpha,
              expectedRevision: hiddenValue(task.html, 'expectedRevision')!,
              sourceState: openState.stateId,
              idempotencyKey: hiddenValue(task.html, 'idempotencyKey')!,
              boardTicket: hiddenValue(task.html, 'boardTicket')!,
              operationId: markWon,
            });
            assert.match(reviewed.html, /Confirm Mark won/u);
            const confirm = {
              boardAction: 'confirm',
              recordId: alpha,
              expectedRevision: hiddenValue(reviewed.html, 'expectedRevision')!,
              sourceState: openState.stateId,
              idempotencyKey: hiddenValue(reviewed.html, 'idempotencyKey')!,
              boardTicket: hiddenValue(reviewed.html, 'boardTicket')!,
              operationId: markWon,
            };
            // The human-required operation's review step: no grant, no move.
            const ungranted = await post(COMPANY, confirm);
            assert.equal(ungranted.status, 403);
            assert.match(ungranted.html, /Review this move before confirming/u);
            // A forged ticket: the choice ticket replayed as a confirmation.
            const forged = await post(COMPANY, {
              ...confirm,
              boardTicket: hiddenValue(task.html, 'boardTicket')!,
              confirmationGrant: hiddenValue(
                reviewed.html,
                'confirmationGrant',
              )!,
            });
            assert.equal(forged.status, 403);
            assert.match(forged.html, /Open the move again/u);
            const before = await revision(alpha);
            const moved = await post(COMPANY, {
              ...confirm,
              confirmationGrant: hiddenValue(
                reviewed.html,
                'confirmationGrant',
              )!,
            });
            assert.match(moved.html, /Mark won completed/u);
            assert.equal(await revision(alpha), before + 1);
          });

          await t.test(
            'a cross-company read and move are refused',
            async () => {
              const page = await get(other);
              assert.doesNotMatch(page.html, /Beta one/u);
              const before = await revision(beta);
              const task = await open(COMPANY, beta);
              assert.doesNotMatch(task.html, /Destination and action/u);
              assert.match(task.html, /unavailable/u);
              assert.equal(await revision(beta), before);
              // The manager, with no company restriction, sees the other company.
              const managed = await get(other, manager);
              assert.match(managed.html, /Beta one/u);
            },
          );

          const alphaTwo = await deal(COMPANY, 'Alpha two');
          await t.test(
            'a move granted only to an automation principal is never offered to a person',
            async () => {
              // The buyer's own role keeps every grant except the two
              // transitions. A separate automation principal holds them.
              const role = async (key: string, exclude: readonly string[]) => {
                const roleId = randomUUID();
                await pool.query(
                  `INSERT INTO platform.current_policy_roles (tenant_id, environment_id, role_id, role_key, revoked_at)
                 VALUES ($1,$2,$3,$4,NULL)`,
                  [tenantId, environmentId, roleId, key],
                );
                await pool.query(
                  `INSERT INTO platform.current_policy_permission_grants (tenant_id, environment_id, role_id, permission_id, resource_id, revoked_at)
                 SELECT g.tenant_id, g.environment_id, $3, g.permission_id, g.resource_id, NULL
                   FROM platform.current_policy_permission_grants g
                   JOIN platform.current_policy_memberships m
                     ON m.tenant_id = g.tenant_id AND m.environment_id = g.environment_id AND m.role_id = g.role_id
                  WHERE g.tenant_id = $1 AND g.environment_id = $2 AND m.principal_id = $4
                    AND g.revoked_at IS NULL AND m.revoked_at IS NULL
                    AND NOT g.permission_id = ANY($5::text[])`,
                  [tenantId, environmentId, roleId, principalId, exclude],
                );
                return roleId;
              };
              const transitions = [
                `${NS}permission.${type}_action_mark_won`,
                `${NS}permission.${type}_action_mark_lost`,
              ];
              const automation = await role('board-automation', []);
              await pool.query(
                `INSERT INTO platform.current_policy_memberships (tenant_id, environment_id, membership_id, principal_id, role_id, legal_entity_id, revoked_at)
               VALUES ($1,$2,$3,$4,$5,NULL,NULL)`,
                [
                  tenantId,
                  environmentId,
                  randomUUID(),
                  randomUUID(),
                  automation,
                ],
              );
              const person = await role('board-person', transitions);
              await pool.query(
                'UPDATE platform.current_policy_memberships SET role_id=$4 WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND revoked_at IS NULL',
                [tenantId, environmentId, principalId, person],
              );
              const page = await get(COMPANY);
              assert.match(page.html, /Alpha two/u);
              assert.doesNotMatch(
                page.html,
                new RegExp(moveCard('Alpha two'), 'u'),
              );
              const task = await open(COMPANY, alphaTwo);
              assert.equal(task.status, 403);
              assert.match(task.html, /No move is available for this card/u);
            },
          );

          await t.test(
            'a narrowed transition disappears from the Task',
            async () => {
              const before = await open(COMPANY, alphaTwo, manager);
              assert.match(before.html, /Won · Mark won/u);
              await activate({
                kind: 'narrowPermission',
                target: { kind: 'operation', id: markWon },
                roleKey: 'local-demo-full-release',
              });
              const after = await open(COMPANY, alphaTwo, manager);
              assert.doesNotMatch(after.html, /Mark won/u);
              assert.match(after.html, /Lost · Mark lost/u);
            },
          );

          await t.test(
            'a scan ceiling or a timeout renders a partial Board, never an empty stage',
            async () => {
              // 513 rows in this company: the 512-row inspection window overflows.
              for (let n = 0; n < 512; n += 32)
                await Promise.all(
                  Array.from({ length: 32 }, (_, i) =>
                    deal(COMPANY, 'Bulk ' + String(n + i)),
                  ),
                );
              const page = await get(COMPANY, manager);
              assert.equal(page.status, 200);
              assert.match(
                page.html,
                /Narrow the search\. This stage is partially loaded\./u,
              );
              assert.doesNotMatch(page.html, /<p>No cards<\/p>/u);
              // A statement timeout is also partial coverage, with no rows.
              const lock = await pool.connect();
              try {
                await lock.query('BEGIN');
                await lock.query(
                  `LOCK TABLE north_star_module.${table} IN ACCESS EXCLUSIVE MODE`,
                );
                const result = await app.runtime.entry.run(
                  { headers: { cookie: manager } },
                  (view) =>
                    app.runtime.queryGateway.invoke(view, {
                      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
                      queryId: board.body.listQuery.queryId,
                      arguments: {
                        [scope]: COMPANY,
                        boardPage: {
                          surfaceId: board.surfaceId,
                          revisionId: board.revisionId,
                          stages: [openState.stateId],
                          filters: [],
                        },
                      },
                    }),
                );
                assert.deepEqual(result.boardCoverage, {
                  revisionId: board.revisionId,
                  scanLimitReached: true,
                });
                assert.equal(result.records.length, 0);
              } finally {
                await lock.query('ROLLBACK');
                lock.release();
              }
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
