import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';

import pg, { type PoolClient } from 'pg';

import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const discussion = 'staffDiscussion/v1';
const email = 'email/v1';
const visit = 'example.booking:entity.visit';
const account = 'example.booking:entity.account';
const relation = 'example.booking:relation.account';

async function scalar(c: PoolClient, sql: string, args: unknown[] = []) {
  const { rows } = await c.query<{ value: string }>(sql, args);
  assert.equal(rows.length, 1);
  return rows[0]!.value;
}

async function begin(c: PoolClient, actor = 'staff', repeatable = false) {
  await c.query(repeatable ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
  await c.query(
    `SELECT set_config('north_star.tenant_id',md5('tenant')::uuid::text,true),
            set_config('north_star.environment_id',md5('env')::uuid::text,true),
            set_config('north_star.principal_id',md5($1)::uuid::text,true)`,
    [actor],
  );
}
function admit(
  c: PoolClient,
  channel: string,
  options: {
    company?: string;
    record?: string;
    entity?: string;
    bindings?: string[];
    contacts?: string[];
    staff?: string[];
    fence?: number;
  } = {},
) {
  return scalar(
    c,
    `SELECT platform.communication_admit_record(md5($1)::uuid,md5('release')::uuid,$2,$3,$4,md5($5)::uuid,$6,
       ARRAY(SELECT ROW('example.booking:entity.account',md5(s)::uuid)::platform.communication_record FROM unnest($7::text[]) s),
       ARRAY(SELECT md5(s)::uuid FROM unnest($8::text[]) s)) AS value`,
    [
      options.company ?? 'company0',
      options.fence ?? 1,
      channel,
      options.entity ?? visit,
      options.record ?? 'owner2',
      options.bindings ?? [relation],
      options.contacts ?? [],
      options.staff ?? ['staff'],
    ],
  );
}
const resolveThread = (c: PoolClient, ticket: string) =>
  scalar(c, 'SELECT platform.communication_resolve_thread($1) AS value', [
    ticket,
  ]);
const participants = async (c: PoolClient, ticket: string, id: string) =>
  (
    await c.query<{ id: string }>(
      'SELECT id FROM platform.communication_write_participants($1,$2) id',
      [ticket, id],
    )
  ).rows;
const direct = (c: PoolClient, peer: string) =>
  scalar(
    c,
    "SELECT platform.communication_admit_direct(md5('company0')::uuid,md5('release')::uuid,1,md5($1)::uuid) AS value",
    [peer],
  );

test('shared communication writer', async (t) => {
  await withEphemeralPostgres(
    'communication-threads',
    async ({ pool, connection }) => {
      const admin = await pool.connect(),
        left = await pool.connect(),
        right = await pool.connect();
      const runtime = new pg.Pool({
        ...connection,
        user: 'north_star_runtime',
        max: 1,
      });
      try {
        await runMigrations(admin, await loadMigrations('db/migrations'));
        await admin.query(
          await readFile('test/fixtures/booking-commitments.sql', 'utf8'),
        );
        await admin.query(`
        INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
          SELECT md5('tenant')::uuid,md5('env')::uuid,md5('role')::uuid,'example.booking:permission.'||action||'_'||entity,
            'example.booking:entity.'||entity FROM unnest(ARRAY['visit','account','asset']) entity
            CROSS JOIN unnest(ARRAY['prepare_email','discussion_post']) action;
        INSERT INTO platform.current_policy_permission_grants(tenant_id,environment_id,role_id,permission_id,resource_id)
          VALUES(md5('tenant')::uuid,md5('env')::uuid,md5('role')::uuid,
            'northstar.communication:permission.staff_chat_post','northstar.communication:resource.staff_chat');
        INSERT INTO platform.current_policy_memberships(tenant_id,environment_id,membership_id,principal_id,role_id,legal_entity_id)
          SELECT md5('tenant')::uuid,md5('env')::uuid,gen_random_uuid(),md5(p)::uuid,md5('role')::uuid,md5(company)::uuid
            FROM (VALUES ('west','company0'),('east','company1')) AS v(p,company);
      `);
        for (const c of [left, right])
          await c.query('SET ROLE north_star_communication_operation');
        t.afterEach(async () => {
          await left.query('ROLLBACK');
          await right.query('ROLLBACK');
        });
        // Tests roll back their own failed attempts, so each refusal is tested on a live connection.
        await t.test(
          'only governed SQL operations may invoke the writer',
          async () => {
            const tables = [
              'threads',
              'record_links',
              'participants',
              'discussion_anchors',
              'participant_channels',
            ];
            for (const name of tables) {
              await assert.rejects(
                runtime.query(`SELECT * FROM platform.communication_${name}`),
                { code: '42501' },
              );
              const { rows } = await admin.query(
                `SELECT relrowsecurity AND relforcerowsecurity AS guarded,
            has_any_column_privilege('north_star_runtime',oid,'SELECT,INSERT,UPDATE,REFERENCES')
            OR has_table_privilege('north_star_runtime',oid,'DELETE,TRUNCATE,TRIGGER') AS permitted
            FROM pg_class WHERE oid=$1::regclass`,
                ['platform.communication_' + name],
              );
              assert.deepEqual(rows, [{ guarded: true, permitted: false }]);
            }
            await assert.rejects(
              runtime.query(
                'SELECT platform.communication_resolve_thread(gen_random_uuid())',
              ),
              { code: '42501' },
            );
            await assert.rejects(
              runtime.query('SET ROLE north_star_communication_operation'),
              { code: '42501' },
            );
          },
        );
        for (const record of ['owner2', 'owner6']) {
          await begin(left);
          await left.query(
            'SELECT platform.communication_register_discussion($1)',
            [await admit(left, discussion, { record })],
          );
          await left.query('COMMIT');
        }
        await t.test('canonical requirements precede creation', async () => {
          await begin(left);
          const ticket = await admit(left, discussion, { record: 'owner8' });
          await assert.rejects(
            resolveThread(left, ticket),
            /communication.unavailable/,
            'unregistered anchor created a thread',
          );
          await left.query('ROLLBACK');
          await begin(left);
          await assert.rejects(
            left.query(
              'SELECT platform.communication_register_discussion($1)',
              [await admit(left, discussion, { bindings: [] })],
            ),
            /communication.unavailable/,
            'saved anchor requirements changed',
          );
          assert.equal(
            await scalar(
              admin,
              'SELECT count(*)::text AS value FROM platform.communication_threads',
            ),
            '0',
          );
        });
        await t.test(
          'each authorization fence refuses independently',
          async () => {
            const denied = async (
              reason: string,
              actor: string,
              call: () => Promise<unknown>,
              pattern = /communication.unavailable/,
            ) => {
              await begin(left, actor);
              try {
                await assert.rejects(call, pattern, reason);
              } finally {
                await left.query('ROLLBACK');
              }
            };
            await denied(
              'foreign company admitted the correct owner',
              'west',
              () =>
                admit(left, email, { company: 'company1', record: 'owner1' }),
            );
            await denied('foreign record entered the thread', 'staff', () =>
              admit(left, email, { record: 'owner1', bindings: [] }),
            );
            await denied('foreign contact entered the thread', 'staff', () =>
              admit(left, email, { contacts: ['owner1'] }),
            );
            await denied('foreign staff entered the thread', 'staff', () =>
              admit(left, email, { staff: ['east'] }),
            );
            await denied(
              'unknown channel admitted',
              'staff',
              () => admit(left, 'unbound'),
              /communication.invalidScope/,
            );
            await denied(
              'stale activation admitted',
              'staff',
              () => admit(left, email, { fence: 99 }),
              /communication.staleRelease/,
            );
            await denied('missing binding admitted', 'staff', () =>
              admit(left, email, { bindings: ['unknown'] }),
            );
            await denied(
              'outbound contact admitted to discussion',
              'staff',
              () => admit(left, discussion, { contacts: ['owner2'] }),
              /communication.invalidScope/,
            );
            await denied(
              'direct chat with self admitted',
              'staff',
              () => direct(left, 'staff'),
              /communication.invalidScope/,
            );
            await denied('foreign direct peer admitted', 'staff', () =>
              direct(left, 'east'),
            );
            await begin(left, 'staff', true);
            try {
              await assert.rejects(
                admit(left, email),
                /communication.requiresReadCommitted/,
              );
            } finally {
              await left.query('ROLLBACK');
            }
            for (const [channel, perm] of [
              [discussion, 'discussion_post_account'],
              [email, 'prepare_email_visit'],
            ] as const) {
              await admin.query(
                'UPDATE platform.current_policy_permission_grants SET revoked_at=now() WHERE permission_id=$1',
                ['example.booking:permission.' + perm],
              );
              try {
                await denied(
                  'revoked ' + perm + ' admitted',
                  'staff',
                  () => admit(left, channel),
                  /communication.unavailable/,
                );
              } finally {
                await admin.query(
                  'UPDATE platform.current_policy_permission_grants SET revoked_at=NULL WHERE permission_id=$1',
                  ['example.booking:permission.' + perm],
                );
              }
            }
          },
        );

        await t.test(
          'the scope guard covers a shared record independently of its write grant',
          async () => {
            await begin(admin, 'west');
            try {
              await assert.rejects(
                admin.query(
                  "SELECT platform.communication_fence(md5('company1')::uuid,md5('release')::uuid,1)",
                ),
                /communication.unavailable/,
                'writer fence admitted a nonmember',
              );
            } finally {
              await admin.query('ROLLBACK');
            }
          },
        );
        // Observe the actual contested lock. A second successful call after commit alone
        // would also pass with sequential scheduling or the wrong lock class.
        const race = async (first: string, second: string, same: boolean) => {
          const firstId = await resolveThread(left, first);
          let done = false;
          const competing = resolveThread(right, second).finally(() => {
            done = true;
          });
          void competing.catch(() => {});
          try {
            const started = performance.now();
            while (!done) {
              const { rows } = await admin.query(
                `SELECT EXISTS(SELECT FROM pg_stat_activity a WHERE a.pid=$1
              AND a.wait_event='advisory' AND $2=ANY(pg_blocking_pids(a.pid))) AS waiting`,
                [rightPid, leftPid],
              );
              if (rows[0]?.waiting) break;
              assert.ok(
                performance.now() - started < 30_000,
                'second creator did not wait on the shared creation key',
              );
              await pause(10);
            }
            assert.equal(
              done,
              false,
              'creation did not serialize before thread lookup',
            );
            await left.query('COMMIT');
            const secondId = await competing;
            assert.equal(
              firstId === secondId,
              same,
              'thread identity disagrees with the complete link set',
            );
            await right.query('COMMIT');
            return firstId;
          } finally {
            await left.query('ROLLBACK');
            await competing.catch(() => {});
            await right.query('ROLLBACK');
          }
        };
        const leftPid = await scalar(
          left,
          'SELECT pg_backend_pid()::text AS value',
        );
        const rightPid = await scalar(
          right,
          'SELECT pg_backend_pid()::text AS value',
        );
        await begin(left);
        const sharedTicket = await admit(left, email, { contacts: ['owner2'] });
        const shared = await resolveThread(left, sharedTicket);
        await participants(left, sharedTicket, shared);
        await left.query('COMMIT');
        await t.test(
          'first post and email share the primary key and only identical link sets',
          async () => {
            await begin(left);
            await begin(right);
            const created = await race(
              await admit(left, discussion, { record: 'owner6' }),
              await admit(right, email, { record: 'owner6' }),
              true,
            );
            await begin(left);
            await begin(right);
            await race(
              await admit(left, discussion, { record: 'owner6' }),
              await admit(right, email, { bindings: [], record: 'owner6' }),
              false,
            );
            const { rows } = await admin.query(
              "SELECT entity_id,record_id=md5('owner6')::uuid AS saved FROM platform.communication_record_links WHERE thread_id=$1 ORDER BY entity_id",
              [created],
            );
            assert.deepEqual(rows, [
              { entity_id: account, saved: true },
              { entity_id: visit, saved: true },
            ]);
          },
        );
        await t.test(
          'stale or omitted links refuse before waiting on the creation key',
          async () => {
            await begin(left);
            await resolveThread(left, await admit(left, email));
            try {
              await begin(right);
              await right.query("SET LOCAL lock_timeout='2s'");
              await assert.rejects(
                resolveThread(
                  right,
                  await admit(right, discussion, { bindings: [] }),
                ),
                /communication.unavailable/,
              );
            } finally {
              await right.query('ROLLBACK');
              await left.query('ROLLBACK');
            }
            await admin.query(
              "UPDATE north_star_module.test_booking_owners SET parent_id=md5('owner4')::uuid WHERE record_id=md5('owner2')::uuid",
            );
            try {
              await begin(left);
              await assert.rejects(
                resolveThread(left, await admit(left, discussion)),
                /communication.unavailable/,
              );
            } finally {
              await left.query('ROLLBACK');
              await admin.query(
                "UPDATE north_star_module.test_booking_owners SET parent_id=record_id WHERE record_id=md5('owner2')::uuid",
              );
            }
          },
        );
        await t.test(
          'participants are bound to the locked thread, company and channel',
          async () => {
            await begin(left);
            const ticket = await admit(left, email, { contacts: ['owner2'] });
            await assert.rejects(
              participants(left, ticket, shared),
              /communication.unavailable/,
            );
            await left.query('ROLLBACK');
            await begin(left);
            const live = await admit(left, email, { contacts: ['owner2'] });
            await left.query(
              'SELECT platform.communication_lock_thread($1,$2)',
              [live, shared],
            );
            const ids = await participants(left, live, shared);
            assert.equal(ids.length, 2);
            assert.deepEqual(await participants(left, live, shared), ids);
            await left.query('COMMIT');
            await begin(left);
            await assert.rejects(
              participants(left, live, shared),
              /communication.unavailable/,
            );
            await left.query('ROLLBACK');
            await begin(left);
            const staff = await admit(left, discussion);
            await left.query(
              'SELECT platform.communication_lock_thread($1,$2)',
              [staff, shared],
            );
            const staffIds = await participants(left, staff, shared);
            assert.equal(staffIds.length, 1);
            assert.ok(
              ids.some(({ id }) => id === staffIds[0]?.id),
              'one staff subject has two participant identities',
            );

            await left.query('COMMIT');
            const { rows: channelRows } = await admin.query(
              'SELECT channel,count(*)::int AS count FROM platform.communication_participant_channels WHERE thread_id=$1 GROUP BY channel ORDER BY channel',
              [shared],
            );
            assert.deepEqual(channelRows, [
              { channel: email, count: 2 },
              { channel: discussion, count: 1 },
            ]);
          },
        );
        await t.test(
          'a creation batch also locks existing thread rows in ID order',
          async () => {
            await begin(left);
            const different = await resolveThread(
              left,
              await admit(left, email, { bindings: [] }),
            );
            await left.query('COMMIT');
            await begin(left);
            const linked = await admit(left, email),
              primaryOnly = await admit(left, email, { bindings: [] });
            const [low, high] =
              shared < different
                ? [linked, primaryOnly]
                : [primaryOnly, linked];
            await left.query(
              'SELECT platform.communication_lock_creations($1)',
              [[high, low]],
            );
            await left.query('SAVEPOINT ordered');
            await resolveThread(left, high);
            await assert.rejects(
              resolveThread(left, low),
              /communication.lockOrder/,
              'creation batch locked an earlier existing thread row',
            );
            await left.query('ROLLBACK TO ordered');
            await resolveThread(left, low);
            await resolveThread(left, high);
          },
        );
        await t.test(
          'a transaction cannot return to earlier lock classes',
          async () => {
            await begin(left);
            const first = await admit(left, email);
            const next = await admit(left, email, { record: 'owner4' });
            await left.query(
              'SELECT platform.communication_lock_thread($1,$2)',
              [first, shared],
            );
            await left.query('SAVEPOINT by_id');
            await assert.rejects(
              resolveThread(left, next),
              /communication.lockOrder/,
              'by-ID locker acquired a later creation key',
            );
            await left.query('ROLLBACK TO by_id');
            await assert.rejects(
              admit(left, email),
              /communication.lockOrder/,
              'record fences taken after the thread',
            );
            await left.query('ROLLBACK TO by_id');
            await participants(left, first, shared);
            await assert.rejects(
              left.query('SELECT platform.communication_lock_thread($1,$2)', [
                first,
                shared,
              ]),
              /communication.lockOrder/,
              'thread row locked after participant rows',
            );
          },
        );
        await t.test(
          'release, membership, saved record, thread and participant stay locked until commit',
          async () => {
            await begin(left);
            const live = await admit(left, email, { contacts: ['owner2'] });
            await left.query(
              'SELECT platform.communication_lock_thread($1,$2)',
              [live, shared],
            );
            await participants(left, live, shared);
            for (const [name, sql, args] of [
              [
                'release',
                "SELECT FROM platform.active_release_pointers WHERE tenant_id=md5('tenant')::uuid FOR UPDATE NOWAIT",
                [],
              ],
              [
                'policy',
                "SELECT FROM platform.current_policy_epochs WHERE tenant_id=md5('tenant')::uuid FOR UPDATE NOWAIT",
                [],
              ],
              [
                'saved record',
                "SELECT FROM north_star_module.test_booking_owners WHERE record_id=md5('owner2')::uuid FOR UPDATE NOWAIT",
                [],
              ],
              [
                'thread',
                'SELECT FROM platform.communication_threads WHERE thread_id=$1 FOR UPDATE NOWAIT',
                [shared],
              ],
              [
                'existing participant',
                'SELECT FROM platform.communication_participants WHERE thread_id=$1 FOR UPDATE NOWAIT',
                [shared],
              ],
            ] as const) {
              await assert.rejects(
                admin.query(sql, [...args]),
                { code: '55P03' },
                name + ' lock released before commit',
              );
            }
            assert.equal(
              await scalar(
                left,
                "SELECT count(*)::text AS value FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()",
              ),
              '0',
            );
          },
        );
        await t.test(
          'a by-ID lock cannot cross an acting company on the same shared record',
          async () => {
            const sharedRecord = {
              entity: 'example.booking:entity.asset',
              record: 'resource1',
              bindings: [],
            };
            await begin(left);
            const first = await resolveThread(
              left,
              await admit(left, email, sharedRecord),
            );
            await left.query('COMMIT');
            await begin(right);
            const other = await admit(right, email, {
              ...sharedRecord,
              company: 'company1',
            });
            await assert.rejects(
              right.query('SELECT platform.communication_lock_thread($1,$2)', [
                other,
                first,
              ]),
              /communication.unavailable/,
            );
            await right.query('ROLLBACK');
            await begin(right);
            const second = await resolveThread(
              right,
              await admit(right, email, {
                ...sharedRecord,
                company: 'company1',
              }),
            );
            assert.notEqual(first, second);
            await right.query('COMMIT');
          },
        );
        await t.test(
          'opposite direct requests lock the same sorted staff pair',
          async () => {
            await begin(left, 'west');
            await begin(right, 'staff');
            const id = await race(
              await direct(left, 'staff'),
              await direct(right, 'west'),
              true,
            );
            await begin(left, 'west');
            const ticket = await direct(left, 'staff');
            await left.query(
              'SELECT platform.communication_lock_thread($1,$2)',
              [ticket, id],
            );
            assert.equal((await participants(left, ticket, id)).length, 2);
            await left.query('ROLLBACK');
          },
        );
      } finally {
        for (const c of [left, right]) {
          await c.query('ROLLBACK');
          c.release();
        }
        admin.release();
        await runtime.end();
      }
    },
  );
});
