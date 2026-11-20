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
      right = await pool.connect();
    try {
      await runMigrations(admin, await loadMigrations('db/migrations'));
      await admin.query(
        await readFile('test/fixtures/booking-commitments.sql', 'utf8'),
      );
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
      const call = async (
        client: PoolClient,
        verb: string,
        args: object,
        key: string = randomUUID(),
        kind = 'unit',
      ): Promise<Result> => {
        const { rows } = await client.query<{ result: Result }>(
          'SELECT platform.booking_apply($1,1,$2,$3,$4,$5) AS result',
          [
            release,
            'example.booking:operation.' + verb.toLowerCase() + '_' + kind,
            key,
            args,
            actor,
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
      const waitForRight = async () => {
        const deadline = performance.now() + 30000;
        while (performance.now() < deadline) {
          const row = (
            await admin.query(
              'SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked',
              [leftPid, rightPid],
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
              "SELECT set_config('north_star.tenant_id',$1,false),set_config('north_star.environment_id',$2,false)",
              [tenant, environment],
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
          await assert.rejects(
            call(right, 'confirm', { ...terms(19, held) }),
            /booking.endpointUnavailable/u,
          );
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
            '2030-02-10T07:00:00.000Z',
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
            '2030-02-10T07:00:00.000Z',
          );
          await left.query('BEGIN');
          await left.query('SELECT platform.booking_apply($1,1,$2,$3,$4,$5)', [
            release,
            'example.booking:operation.cancel_unit',
            randomUUID(),
            terms(13, moved),
            actor,
          ]);
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
    } finally {
      left.release();
      right.release();
      admin.release();
    }
  });
});
