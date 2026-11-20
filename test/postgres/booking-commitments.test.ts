import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import type { PoolClient } from 'pg';

import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

function fixtureId(label: string): string {
  return createHash('md5')
    .update(label)
    .digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-$3-$4-$5');
}
const tenant = fixtureId('tenant'),
  environment = fixtureId('env'),
  principal = fixtureId('staff'),
  release = fixtureId('release');
const owner = (n: number) => fixtureId('owner' + String(n));
const resource = (n: number) => fixtureId('resource' + String(n));
const window = (start: string, end: string) => ({
  kind: 'time',
  start: '2030-02-11T' + start,
  end: '2030-02-11T' + end,
});
const hold = (
  n: number,
  resourceNumber: number,
  interval: object,
  quantity = '1',
) => ({
  recordId: owner(n),
  expectedOwnerRevision: 1,
  resourceId: resource(resourceNumber),
  expectedRevision: 0,
  quantity,
  interval,
});
interface Result {
  bookingId: string;
  revision: number;
  state: string;
  refused?: string;
  invocationId: string;
  domainEventId: string;
  deadline: string;
}

test('booking commitment writer', async (t) => {
  await withEphemeralPostgres('booking-commitments', async ({ pool }) => {
    const admin = await pool.connect(),
      left = await pool.connect(),
      right = await pool.connect(),
      issuer = await pool.connect();
    try {
      await runMigrations(admin, await loadMigrations('db/migrations'));
      await admin.query(
        await readFile('test/fixtures/booking-commitments.sql', 'utf8'),
      );
      await issuer.query('SET ROLE north_star_approval_issuer');
      const policy =
        'northstar.current-policy/' +
        String(
          (
            await admin.query(
              'SELECT policy_version FROM platform.current_policy_epochs WHERE tenant_id=$1',
              [tenant],
            )
          ).rows[0]!.policy_version,
        );
      const requestId = randomUUID();
      const actor = {
        executionPrincipal: { kind: 'HUMAN', principalId: principal },
        requestId,
        channel: 'UI',
        policyVersion: policy,
      };
      for (const client of [left, right]) {
        await client.query('SET ROLE north_star_runtime');
        await client.query(
          "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false),set_config('north_star.principal_id',$3,false),set_config('north_star.request_id',$4,false)",
          [tenant, environment, principal, requestId],
        );
      }
      let activeFence = 1;
      const grant = async (
        id: string,
        action: string,
        key: string,
        input: object,
        who = principal,
        fence = activeFence,
      ) => {
        await issuer.query(
          'SELECT platform.attest_booking_approval($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10)',
          [
            id,
            tenant,
            environment,
            who,
            release,
            fence,
            action,
            key,
            input,
            'UI',
          ],
        );
      };
      const call = async (
        client: PoolClient,
        verb: string,
        args: object,
        key: string = randomUUID(),
        kind = 'unit',
        who = principal,
        approval: string | null | undefined = undefined,
      ): Promise<Result> => {
        const action =
          'example.booking:operation.' + verb.toLowerCase() + '_' + kind;
        let grantId = approval;
        if (verb !== 'hold' && approval === undefined) {
          grantId = randomUUID();
          await grant(grantId, action, key, args, who);
        }
        const { rows } = await client.query<{ result: Result }>(
          'SELECT platform.booking_apply($1,$6,$2,$3,$4,$5) AS result',
          [
            release,
            action,
            key,
            args,
            {
              ...actor,
              executionPrincipal: { kind: 'HUMAN', principalId: who },
              approvalGrantId: grantId,
            },
            activeFence,
          ],
        );
        return rows[0]!.result;
      };
      const terms = (n: number, booking: Result) => ({
        recordId: owner(n),
        expectedOwnerRevision: 1,
        bookingId: booking.bookingId,
        expectedRevision: booking.revision,
      });
      const capacity = (n: number, quantity: string, revision: number) => ({
        recordId: resource(n),
        expectedOwnerRevision: 1,
        resourceId: resource(n),
        quantity,
        reason: 'scheduled capacity',
        expectedRevision: revision,
      });
      const time = (instant: string) =>
        admin.query('UPDATE public.booking_test_clock SET instant=$1', [
          instant,
        ]);
      const rightPid = Number(
        (await right.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      const leftPid = Number(
        (await left.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
      );
      // Observe the wait in PostgreSQL before releasing the winning transaction.
      const waitForRight = async (blocker = leftPid) => {
        const deadline = performance.now() + 30000;
        while (performance.now() < deadline) {
          const row = (
            await admin.query(
              'SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked',
              [blocker, rightPid],
            )
          ).rows[0];
          if (row?.blocked === true) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail('the contender never waited on the other session');
      };
      const race = async (
        first: () => Promise<Result>,
        second: () => Promise<Result>,
      ) => {
        await left.query('BEGIN');
        try {
          const winner = await first();
          assert.ok(!winner.refused, winner.refused);
          const contender = second();
          void contender.catch(() => undefined);
          await waitForRight();
          await left.query('COMMIT');
          return [winner, await contender] as const;
        } finally {
          await left.query('ROLLBACK');
        }
      };
      await t.test(
        'two companies racing for a shared unit commit one claim, one receipt and one event',
        async () => {
          const args = hold(1, 1, window('09:00', '11:00')),
            key = randomUUID();
          const [won, lost] = await race(
            () => call(left, 'hold', args, key),
            () => call(right, 'hold', hold(2, 1, window('10:00', '12:00'))),
          );
          assert.equal(
            lost.refused,
            'booking.noLongerAvailable',
            'the conflicting unit hold acquired capacity',
          );
          assert.deepEqual(
            (
              await admin.query(`SELECT
          (SELECT count(*)::int FROM platform.booking_commitments) AS facts,
          (SELECT count(*)::int FROM platform.booking_history) AS revisions,
          (SELECT count(*)::int FROM platform.semantic_operation_receipts) AS receipts,
          (SELECT count(*)::int FROM platform.trust_outbox) AS events`)
            ).rows,
            [{ facts: 1, revisions: 1, receipts: 1, events: 1 }],
          );
          const event = (
            await admin.query(
              'SELECT event_type,event_schema_version,payload FROM platform.trust_domain_events WHERE domain_event_id=$1',
              [won.domainEventId],
            )
          ).rows[0]!;
          assert.equal(event.event_type, 'booking.changed');
          assert.equal(event.event_schema_version, 'booking.changed/v1');
          assert.deepEqual(Object.keys(event.payload).sort(), [
            'effectiveAt',
            'operation',
            'ownerScope',
            'owners',
          ]);
          assert.deepEqual(event.payload.owners.value, [
            {
              ownerRef: {
                entityId: 'example.booking:entity.visit',
                recordId: owner(1),
              },
              previousCursor: '0',
              cursor: '1',
              bookings: [{ bookingId: won.bookingId, revision: 1 }],
            },
          ]);
          const confirmed = await call(right, 'confirm', terms(1, won));
          assert.equal(confirmed.state, 'confirmed');
          assert.deepEqual(await call(right, 'hold', args, key), won);
          await assert.rejects(
            call(right, 'hold', { ...args, quantity: '2' }, key),
            /booking.requestKeyConflict/u,
          );
          assert.equal(
            (await call(right, 'cancel', terms(1, confirmed))).state,
            'cancelled',
          );
        },
      );
      await t.test(
        'adjacent claims fit and the database rejects empty, open, closed-end and infinite intervals',
        async () => {
          for (const [n, start, end] of [
            [3, '09:00', '10:00'],
            [4, '10:00', '11:00'],
          ] as const)
            assert.equal(
              (await call(left, 'hold', hold(n, 2, window(start, end)))).state,
              'hold',
            );
          for (const range of [
            'empty',
            '(2030-01-02,2030-01-03)',
            '[2030-01-02,2030-01-03]',
            '(,2030-01-02)',
            '[2030-01-02,)',
            '[-infinity,infinity)',
          ])
            await assert.rejects(
              admin.query('SELECT $1::platform.booking_interval', [range]),
              { code: '23514' },
            );
        },
      );
      await t.test(
        'last pool quantity, dated capacity reductions and rescheduling serialize at the resource lock',
        async () => {
          await call(
            left,
            'setCapacity',
            capacity(3, '10', 0),
            randomUUID(),
            'pool',
          );
          const poolHold = (
            c: PoolClient,
            n: number,
            q: string,
            start = '09:00',
            end = '11:00',
          ) =>
            call(
              c,
              'hold',
              hold(n, 3, window(start, end), q),
              randomUUID(),
              'pool',
            );
          const [first, last] = await race(
            () => poolHold(left, 5, '6', '09:00', '10:00'),
            () => poolHold(right, 6, '5'),
          );
          assert.equal(
            last.refused,
            'booking.noLongerAvailable',
            'the pool admitted demand beyond its dated capacity',
          );
          assert.equal(
            (await poolHold(left, 6, '6', '10:00', '11:00')).state,
            'hold',
          );
          assert.equal((await poolHold(left, 7, '4')).state, 'hold');
          assert.equal(
            (
              await call(
                right,
                'setCapacity',
                capacity(3, '9', 1),
                randomUUID(),
                'pool',
              )
            ).refused,
            'booking.noLongerAvailable',
          );
          assert.equal(first.revision, 1);
          await call(
            left,
            'setCapacity',
            capacity(4, '4', 0),
            randomUUID(),
            'pool',
          );
          const [, declined] = await race(
            () =>
              call(
                left,
                'setCapacity',
                capacity(4, '3', 1),
                randomUUID(),
                'pool',
              ),
            () =>
              call(
                right,
                'hold',
                hold(8, 4, window('09:00', '10:00'), '4'),
                randomUUID(),
                'pool',
              ),
          );
          assert.equal(declined.refused, 'booking.noLongerAvailable');
          const original = await call(
            left,
            'hold',
            hold(9, 5, window('09:00', '10:00')),
          );
          const [, conflict] = await race(
            () => call(left, 'hold', hold(10, 5, window('10:00', '11:00'))),
            () =>
              call(right, 'changeInterval', {
                ...terms(9, original),
                interval: window('09:00', '11:00'),
              }),
          );
          assert.equal(
            conflict.refused,
            'booking.noLongerAvailable',
            'the reschedule displaced a competing unit hold',
          );
          const kept = (
            await admin.query(
              'SELECT revision,upper(occupied_interval) AS ending FROM platform.booking_commitments WHERE booking_id=$1',
              [original.bookingId],
            )
          ).rows[0]!;
          assert.equal(kept.revision, 1);
          assert.equal(kept.ending.toISOString(), '2030-02-11T17:00:00.000Z');
        },
      );
      await t.test(
        'invalid isolation, forged owners and direct table writes refuse',
        async () => {
          await left.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(
            call(left, 'hold', hold(11, 6, window('09:00', '10:00'))),
            /booking.requiresReadCommitted/u,
          );
          await left.query('ROLLBACK');
          await assert.rejects(
            call(right, 'hold', {
              ...hold(11, 6, window('09:00', '10:00')),
              recordId: randomUUID(),
            }),
            /booking.endpointUnavailable/u,
          );
          await assert.rejects(
            right.query(
              "UPDATE platform.booking_commitments SET state='confirmed'",
            ),
            { code: '42501' },
          );
          await assert.rejects(
            admin.query('TRUNCATE platform.booking_history'),
            /booking.historyImmutable/u,
          );
        },
      );
      await t.test(
        'archive and another company cannot change an active allocation',
        async () => {
          const held = await call(
            left,
            'hold',
            hold(18, 9, window('09:00', '10:00')),
          );
          await right.query('SELECT platform.lock_record_allocations($1,$2)', [
            'example.booking:entity.visit',
            owner(18),
          ]);
          await admin.query('SET ROLE north_star_module_runtime');
          try {
            await admin.query(
              "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false),set_config('north_star.principal_id',$3,false)",
              [tenant, environment, principal],
            );
            await assert.rejects(
              admin.query(
                'SELECT north_star_internal.require_record_archivable($1,$2)',
                ['example.booking:entity.visit', owner(18)],
              ),
              /booking.activeAllocation/u,
            );
          } finally {
            await admin.query('RESET ROLE');
          }
          const scoped = fixtureId('scoped');
          await right.query(
            "SELECT set_config('north_star.principal_id',$1,false)",
            [scoped],
          );
          try {
            const own = await call(
              right,
              'hold',
              hold(31, 18, window('09:00', '10:00')),
              randomUUID(),
              'unit',
              scoped,
            );
            assert.equal(
              (
                await call(
                  right,
                  'confirm',
                  terms(31, own),
                  randomUUID(),
                  'unit',
                  scoped,
                )
              ).state,
              'confirmed',
            );
            await assert.rejects(
              call(
                right,
                'confirm',
                terms(18, held),
                randomUUID(),
                'unit',
                scoped,
              ),
              /booking.endpointUnavailable/u,
            );
            await right.query('SET ROLE north_star_module_runtime');
            try {
              await right.query(
                'SELECT north_star_internal.require_record_archivable($1,$2)',
                ['example.booking:entity.visit', owner(18)],
              );
              await assert.rejects(
                right.query(
                  'SELECT north_star_internal.require_record_archivable($1,$2)',
                  ['example.booking:entity.visit', owner(31)],
                ),
                /booking.activeAllocation/u,
              );
            } finally {
              await right.query('SET ROLE north_star_runtime');
            }
          } finally {
            await right.query(
              "SELECT set_config('north_star.principal_id',$1,false)",
              [principal],
            );
          }
          assert.equal(
            (await call(left, 'cancel', terms(18, held))).state,
            'cancelled',
          );
        },
      );
      await t.test(
        'a missing audit row rolls back the entire decision',
        async () => {
          await admin.query(`CREATE FUNCTION public.suppress_booking_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
          CREATE TRIGGER booking_drop_outbox BEFORE INSERT ON platform.trust_outbox FOR EACH ROW EXECUTE FUNCTION public.suppress_booking_outbox()`);
          try {
            await assert.rejects(
              call(left, 'hold', hold(19, 10, window('09:00', '10:00'))),
              /booking.evidenceMismatch/u,
            );
            const result = await admin.query(
              'SELECT FROM platform.booking_owner_cursors WHERE record_id=$1',
              [owner(19)],
            );
            assert.equal(result.rowCount, 0);
          } finally {
            await admin.query(
              'DROP TRIGGER booking_drop_outbox ON platform.trust_outbox',
            );
          }
        },
      );
      await t.test(
        'a trigger writing a managed record aborts the booking',
        async () => {
          await admin.query(`CREATE FUNCTION public.touch_managed_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          UPDATE north_star_module.test_booking_owners SET revision=revision+1 WHERE record_id=md5('owner20')::uuid;
          RETURN NEW; END $$;
          CREATE TRIGGER booking_unexpected_write AFTER INSERT ON platform.booking_history FOR EACH ROW EXECUTE FUNCTION public.touch_managed_owner()`);
          try {
            await assert.rejects(
              call(left, 'hold', hold(20, 11, window('09:00', '10:00'))),
              /booking.unexpectedModuleWrite/u,
            );
            assert.equal(
              (
                await admin.query(
                  'SELECT revision FROM north_star_module.test_booking_owners WHERE record_id=$1',
                  [owner(20)],
                )
              ).rows[0]!.revision,
              '1',
            );
          } finally {
            await admin.query(
              'DROP TRIGGER booking_unexpected_write ON platform.booking_history',
            );
          }
        },
      );
      await t.test(
        'SQL accepts only an attested approval bound to this decision',
        async () => {
          const privileges = await right.query(`SELECT
          has_function_privilege(current_user,'platform.attest_booking_approval(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid,jsonb,text)','EXECUTE') AS issue,
          has_table_privilege(current_user,'platform.booking_approval_grants','INSERT') AS insert`);
          assert.deepEqual(privileges.rows, [{ issue: false, insert: false }]);
          const held = await call(
            left,
            'hold',
            hold(24, 15, window('10:00', '11:00')),
          );
          const args = terms(24, held),
            id = randomUUID(),
            key = randomUUID(),
            action = 'example.booking:operation.confirm_unit';
          await assert.rejects(
            call(right, 'confirm', args, key, 'unit', principal, null),
            /booking.approvalRequired/u,
          );
          await grant(id, action, key, args);
          const confirmed = await call(
            right,
            'confirm',
            args,
            key,
            'unit',
            principal,
            id,
          );
          assert.equal(confirmed.state, 'confirmed');
          assert.deepEqual(
            await call(right, 'confirm', args, key, 'unit', principal, id),
            confirmed,
          );
          const otherKey = randomUUID();
          await grant(id, action, otherKey, args);
          await assert.rejects(
            call(right, 'confirm', args, otherKey, 'unit', principal, id),
            /booking.approvalRequired/u,
          );
          assert.deepEqual(
            (
              await admin.query(
                'SELECT consumed, human_id FROM platform.booking_approval_grants WHERE grant_id=$1',
                [id],
              )
            ).rows,
            [{ consumed: true, human_id: principal }],
          );
        },
      );
      await t.test(
        'first hold and archive agree after the row lock; an old archive snapshot refuses',
        async () => {
          const endpoint = ['example.booking:entity.visit', owner(25)];
          await right.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          try {
            await right.query('SELECT txid_current_snapshot()');
            await left.query('BEGIN');
            assert.equal(
              (await call(left, 'hold', hold(25, 16, window('10:00', '11:00'))))
                .state,
              'hold',
            );
            await assert.rejects(
              right.query(
                'SELECT platform.lock_record_allocations($1,$2)',
                endpoint,
              ),
              /booking.requiresReadCommitted/u,
            );
          } finally {
            await right.query('ROLLBACK');
            await left.query('ROLLBACK');
          }
          await right.query('BEGIN');
          try {
            await right.query(
              'SELECT platform.lock_record_allocations($1,$2)',
              endpoint,
            );
            await left.query('BEGIN');
            assert.equal(
              (await call(left, 'hold', hold(25, 16, window('10:00', '11:00'))))
                .state,
              'hold',
            );
            await right.query('SET LOCAL ROLE north_star_module_runtime');
            const archive = right.query(
              'SELECT record_id FROM north_star_module.test_booking_owners WHERE record_id=$1 FOR UPDATE',
              [owner(25)],
            );
            await waitForRight();
            await left.query('COMMIT');
            await archive;
            await assert.rejects(
              right.query(
                'SELECT north_star_internal.require_record_archivable($1,$2)',
                endpoint,
              ),
              /booking.activeAllocation/u,
            );
          } finally {
            await left.query('ROLLBACK');
            await right.query('ROLLBACK');
          }
          await right.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          try {
            await right.query('SET LOCAL ROLE north_star_module_runtime');
            await assert.rejects(
              right.query(
                'SELECT north_star_internal.require_record_archivable($1,$2)',
                endpoint,
              ),
              /booking.requiresReadCommitted/u,
            );
          } finally {
            await right.query('ROLLBACK');
          }
        },
      );
      await t.test(
        'a parent used by another operation is locked before its child',
        async () => {
          const adminPid = Number(
            (await admin.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
          );
          await admin.query('BEGIN');
          const row = owner(26);
          await admin.query(
            'SELECT FROM north_star_module.test_booking_parents WHERE record_id=$1 FOR UPDATE',
            [row],
          );
          const writer = call(
            right,
            'hold',
            hold(26, 17, window('10:00', '11:00')),
          );
          void writer.catch(() => undefined);
          try {
            await waitForRight(adminPid);
            await admin.query(
              'SELECT FROM north_star_module.test_booking_owners WHERE record_id=$1 FOR UPDATE NOWAIT',
              [row],
            );
          } finally {
            await admin.query('ROLLBACK');
          }
          assert.equal((await writer).state, 'hold');
        },
      );
      await t.test(
        'one owner cursor spans successful writes and a failed concurrent write on another diary',
        async () => {
          const [held, denied] = await race(
            () => call(left, 'hold', hold(27, 19, window('10:00', '11:00'))),
            () => call(right, 'hold', hold(27, 20, window('10:00', '11:00'))),
          );
          assert.equal(denied.refused, 'booking.slotOccupied');
          const confirmed = await call(left, 'confirm', terms(27, held));
          await call(left, 'cancel', terms(27, confirmed));
          const other = await call(
            right,
            'hold',
            hold(27, 20, window('10:00', '11:00')),
          );
          assert.equal(other.state, 'hold');
          const chain = await admin.query(
            `SELECT v.payload #>> '{owners,value,0,previousCursor}' AS prev,
          v.payload #>> '{owners,value,0,cursor}' AS current,h.booking_id FROM platform.booking_history h
          JOIN platform.booking_owner_cursors o USING(tenant_id,environment_id,owner_key)
          JOIN platform.trust_domain_events v ON (v.tenant_id,v.environment_id,v.invocation_id)=(h.tenant_id,h.environment_id,h.receipt_id)
          WHERE o.record_id=$1 ORDER BY h.cursor_value`,
            [owner(27)],
          );
          assert.deepEqual(
            chain.rows,
            [held, held, held, other].map((b, i) => ({
              prev: String(i),
              current: String(i + 1),
              booking_id: b.bookingId,
            })),
          );
        },
      );
      await t.test(
        'post-lock today and Change interval retain the agreement and clamp occupation',
        async () => {
          const today = {
            kind: 'date',
            start: '2030-02-10',
            end: '2030-02-12',
          };
          const early = await call(left, 'hold', hold(12, 7, today));
          const project = async (id: string) =>
            (
              await admin.query(
                `SELECT lower(agreed_interval) AS agreed,lower(occupied_interval) AS occupied
          FROM platform.booking_commitments WHERE booking_id=$1`,
                [id],
              )
            ).rows[0]!;
          assert.equal(
            (await project(early.bookingId)).agreed.toISOString(),
            '2030-02-10T15:00:00.000Z',
          );
          assert.equal(
            (await project(early.bookingId)).occupied.toISOString(),
            '2030-02-10T18:00:00.000Z',
            'the hold occupied time before the decision',
          );
          await call(left, 'cancel', terms(12, early));
          const later = await call(
            right,
            'hold',
            hold(13, 7, window('13:00', '14:00')),
          );
          await time('2030-02-10T18:05Z');
          const moved = await call(left, 'changeInterval', {
            ...terms(13, later),
            interval: today,
          });
          assert.equal(moved.revision, 2);
          assert.equal(
            (await project(later.bookingId)).occupied.toISOString(),
            '2030-02-10T18:05:00.000Z',
          );
          assert.equal(
            (await project(later.bookingId)).agreed.toISOString(),
            '2030-02-10T15:00:00.000Z',
          );
          await left.query('BEGIN');
          await call(left, 'cancel', terms(13, moved));
          const waiting = call(right, 'hold', hold(14, 7, today));
          void waiting.catch(() => undefined);
          await waitForRight();
          await time('2030-02-11T07:00Z');
          await left.query('COMMIT');
          assert.equal((await waiting).refused, 'booking.startInPast');
        },
      );
      await t.test(
        'overlapping agreements fit when their occupied intervals are adjacent',
        async () => {
          const morning = await call(
            left,
            'hold',
            hold(22, 14, window('08:00', '11:00')),
          );
          assert.equal(
            (await call(left, 'confirm', terms(22, morning))).state,
            'confirmed',
          );
          await time('2030-02-11T18:00Z'); // 11:00 in the pinned calendar.
          const day = await call(
            right,
            'hold',
            hold(23, 14, {
              kind: 'date',
              start: '2030-02-11',
              end: '2030-02-12',
            }),
          );
          assert.equal(
            day.state,
            'hold',
            'the two adjacent occupied intervals did not fit',
          );
          const read = await admin.query(
            `SELECT a.agreed_interval && b.agreed_interval AS agreements,
          upper(a.occupied_interval)=lower(b.occupied_interval) AS adjacent FROM platform.booking_commitments a,
          platform.booking_commitments b WHERE a.booking_id=$1 AND b.booking_id=$2`,
            [morning.bookingId, day.bookingId],
          );
          assert.deepEqual(read.rows, [{ agreements: true, adjacent: true }]);
        },
      );
      await t.test(
        'expiry wins at equality after a lock wait and a backward clock cannot revive the claim',
        async () => {
          await time('2030-02-11T07:00Z');
          const held = await call(
            left,
            'hold',
            hold(15, 8, window('09:00', '10:00')),
          );
          await left.query('BEGIN');
          await call(left, 'hold', hold(16, 8, window('10:00', '11:00')));
          const waiting = call(right, 'confirm', terms(15, held));
          void waiting.catch(() => undefined);
          await waitForRight();
          await time(held.deadline);
          await left.query('COMMIT');
          assert.equal(
            (await waiting).refused,
            'booking.closed',
            'confirmation won at the expiry deadline',
          );
          const evidence = (
            await admin.query(
              `SELECT h.reason,h.effective_at,h.recorded_at,o.event_schema_version
          FROM platform.booking_history h JOIN platform.trust_outbox o ON o.invocation_id=h.receipt_id
          WHERE h.booking_id=$1 AND h.revision=2`,
              [held.bookingId],
            )
          ).rows[0]!;
          assert.equal(evidence.reason, 'hold expired');
          assert.equal(+evidence.effective_at, Date.parse(held.deadline));
          assert.equal(+evidence.recorded_at, Date.parse(held.deadline));
          assert.equal(evidence.event_schema_version, 'booking.changed/v1');
          await time('2030-02-11T06:00Z');
          const again = await call(
            left,
            'hold',
            hold(17, 8, {
              kind: 'date',
              start: '2030-02-11',
              end: '2030-02-12',
            }),
          );
          assert.equal(again.state, 'hold');
          const stored = (
            await admin.query(
              'SELECT lower(occupied_interval) AS start_at FROM platform.booking_commitments WHERE booking_id=$1',
              [again.bookingId],
            )
          ).rows[0]!;
          assert.equal(
            +stored.start_at,
            Date.parse(held.deadline),
            'the backward-step hold ignored the diary time floor',
          );
        },
      );
      await t.test(
        'before the 08:00 day boundary today occupies from the 06:00 decision',
        async () => {
          await time('2030-02-11T13:00Z');
          const held = await call(
            left,
            'hold',
            hold(28, 13, {
              kind: 'date',
              start: '2030-02-11',
              end: '2030-02-12',
            }),
          );
          assert.equal(held.state, 'hold');
          const bounds = await admin.query(
            'SELECT lower(agreed_interval) AS agreed,lower(occupied_interval) AS occupied FROM platform.booking_commitments WHERE booking_id=$1',
            [held.bookingId],
          );
          assert.equal(
            bounds.rows[0]!.agreed.toISOString(),
            '2030-02-11T15:00:00.000Z',
          );
          assert.equal(
            bounds.rows[0]!.occupied.toISOString(),
            '2030-02-11T13:00:00.000Z',
          );
          assert.equal(
            (await call(right, 'hold', hold(29, 13, window('06:30', '07:30'))))
              .refused,
            'booking.noLongerAvailable',
          );
        },
      );
      await t.test(
        'a worker skips a foreground owner cursor and commits unrelated expiries with colliding user keys',
        async () => {
          await time('2030-02-11T14:00Z');
          const held = await call(
            left,
            'hold',
            hold(32, 10, window('09:00', '10:00')),
          );
          const expiryKey = fixtureId(
            'booking.expire/' + held.bookingId + '/1',
          );
          const locked = await call(
            left,
            'hold',
            hold(33, 11, window('09:00', '10:00')),
            expiryKey,
          );
          assert.equal(locked.state, 'hold');
          await time(locked.deadline);
          await admin.query('BEGIN');
          try {
            await admin.query(
              'SELECT FROM platform.booking_owner_cursors WHERE record_id=$1 FOR UPDATE',
              [owner(33)],
            );
            await right.query('SET ROLE north_star_workflow_worker');
            await right.query("SET lock_timeout='1500ms'");
            await right.query('SELECT platform.booking_sweep_due(128)');
            const states = await admin.query(
              'SELECT state FROM platform.booking_commitments WHERE booking_id=$1',
              [held.bookingId],
            );
            assert.equal(states.rows[0]!.state, 'cancelled');
            assert.equal(
              (
                await admin.query(
                  'SELECT state FROM platform.booking_commitments WHERE booking_id=$1',
                  [locked.bookingId],
                )
              ).rows[0]!.state,
              'hold',
            );
            assert.equal(
              (
                await admin.query(
                  'SELECT FROM platform.booking_receipts WHERE request_key=$1',
                  [expiryKey],
                )
              ).rowCount,
              2,
            );
          } finally {
            await admin.query('ROLLBACK');
            await right.query('RESET lock_timeout');
            await right.query('SET ROLE north_star_runtime');
          }
          await admin.query('SELECT platform.booking_sweep_due(128)');
          assert.equal(
            (
              await admin.query(
                'SELECT state FROM platform.booking_commitments WHERE booking_id=$1',
                [locked.bookingId],
              )
            ).rows[0]!.state,
            'cancelled',
          );
        },
      );
      await t.test(
        'one conflicting receipt leaves only its own hold due',
        async () => {
          await time('2030-02-11T14:20Z');
          const failed = await call(
            left,
            'hold',
            hold(34, 10, window('09:00', '10:00')),
          );
          const due = await call(
            right,
            'hold',
            hold(35, 10, window('10:00', '11:00')),
          );
          assert.equal(failed.state, 'hold');
          assert.equal(due.state, 'hold');
          await admin.query(`CREATE FUNCTION public.conflict_one_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.operation_id='expireHold' AND NEW.input->>'bookingId'=TG_ARGV[0] THEN
            RAISE unique_violation; END IF; RETURN NEW; END $$`);
          // Install the conflict on this one fixture booking, on the same diary as its neighbour.
          await admin.query(`CREATE TRIGGER booking_expiry_conflict BEFORE INSERT ON platform.booking_receipts
          FOR EACH ROW EXECUTE FUNCTION public.conflict_one_expiry('${failed.bookingId}')`);
          try {
            await time(due.deadline);
            await admin.query('SELECT platform.booking_sweep_due(128)');
            assert.deepEqual(
              (
                await admin.query(
                  'SELECT state FROM platform.booking_commitments WHERE booking_id=$1',
                  [due.bookingId],
                )
              ).rows,
              [{ state: 'cancelled' }],
            );
            assert.deepEqual(
              (
                await admin.query(
                  'SELECT state FROM platform.booking_commitments WHERE booking_id=$1',
                  [failed.bookingId],
                )
              ).rows,
              [{ state: 'hold' }],
            );
          } finally {
            await admin.query(
              'DROP TRIGGER booking_expiry_conflict ON platform.booking_receipts',
            );
          }
          await admin.query('SELECT platform.booking_sweep_due(128)');
          assert.deepEqual(
            (
              await admin.query(
                'SELECT revision FROM platform.booking_commitments WHERE booking_id=$1',
                [failed.bookingId],
              )
            ).rows,
            [{ revision: 2 }],
          );
        },
      );
      await t.test(
        'the bounded worker expires a due hold once and keeps its original authority',
        async () => {
          await time('2030-02-11T08:00Z');
          const holdForWorker = await call(
            left,
            'hold',
            hold(21, 12, window('09:00', '10:00')),
          );
          assert.equal(holdForWorker.state, 'hold');
          await time('2030-02-11T08:30Z');
          await admin.query('SET ROLE north_star_workflow_worker');
          try {
            for (let i = 0; i < 20; i++) {
              const rows = await admin.query(
                'SELECT platform.booking_sweep_due(1) AS count',
              );
              if (rows.rows[0]!.count === 0) break;
              assert.equal(rows.rows[0]!.count, 1);
            }
            assert.equal(
              (
                await admin.query(
                  'SELECT platform.booking_sweep_due(1) AS count',
                )
              ).rows[0]!.count,
              0,
            );
          } finally {
            await admin.query('RESET ROLE');
          }
          const evidence = await admin.query(
            `SELECT i.execution_principal_kind AS actor, i.causation_id=issued.receipt_id AS linked
          FROM platform.booking_history h JOIN platform.booking_history issued ON (issued.booking_id,issued.revision)=(h.booking_id,1)
          JOIN platform.trust_action_invocations i ON i.invocation_id=h.receipt_id
          JOIN platform.booking_owner_cursors o ON o.owner_key=h.owner_key
          WHERE h.operation='expireHold' AND o.record_id=$1`,
            [owner(21)],
          );
          assert.deepEqual(evidence.rows, [{ actor: 'SYSTEM', linked: true }]);
        },
      );
      await t.test(
        'a fresh approval is required when the same release returns at a new fence',
        async () => {
          await time('2030-02-11T15:00Z');
          const held = await call(
            left,
            'hold',
            hold(36, 20, window('11:00', '12:00')),
          );
          assert.equal(held.state, 'hold');
          const args = terms(36, held),
            id = randomUUID(),
            key = randomUUID();
          const action = 'example.booking:operation.confirm_unit';
          await grant(id, action, key, args);
          const alternate = randomUUID();
          await admin.query(
            `INSERT INTO platform.tenant_releases
          (tenant_id,environment_id,release_id,app_package_revision_id,compiler_version,compiler_semantic_profile_version,
           output_protocol_version,content_hash,compiler_attestation_digest,verification_evidence_id,created_by)
          SELECT tenant_id,environment_id,$2,app_package_revision_id,compiler_version,compiler_semantic_profile_version,
           output_protocol_version,content_hash,compiler_attestation_digest,gen_random_uuid(),created_by
          FROM platform.tenant_releases WHERE release_id=$1`,
            [release, alternate],
          );
          for (const target of [alternate, release]) {
            const moved = await admin.query(
              'UPDATE platform.active_release_pointers SET release_id=$3,fence=fence+1 WHERE tenant_id=$1 AND environment_id=$2 RETURNING fence',
              [tenant, environment, target],
            );
            activeFence = Number(moved.rows[0]!.fence);
          }
          assert.equal(activeFence, 3);
          await assert.rejects(
            call(right, 'confirm', args, key, 'unit', principal, id),
            /booking.approvalRequired/u,
          );
          const confirmed = await call(right, 'confirm', args, key);
          assert.equal(confirmed.state, 'confirmed');
        },
      );
    } finally {
      issuer.release();
      left.release();
      right.release();
      admin.release();
    }
  });
});
