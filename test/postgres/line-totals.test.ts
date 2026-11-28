/**
 * LINE-TOTALS slice 1 (ADR-0094) on PostgreSQL: a tenant-built rental contract
 * whose lines derive a stored amount (days x daily rate x (1 - discount %)),
 * whose header GET reads an on-read total, and whose line writes lock the
 * header and count its live lines. Each assertion names the one check whose
 * removal reds it (rule 8; test/evidence/LINE-TOTALS-s1.expected-red.json).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { escapeIdentifier, type Pool } from 'pg';

import { openCustomizeService } from '../../apps/api/src/composition-root.js';
import { draftTemplateBinding } from '../../packages/customization/src/record-template-binding.js';
import type { RequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import { COMPANY, worldOver, type AgentWorld } from '../agent/agent-world.js';
import { startRuntime } from '../helpers/customization-fixture.js';
import {
  AMOUNT,
  h,
  l,
  NS,
  PARENT,
  TEMPLATE_FORM,
  TOTAL,
  rentalApplication,
  rentalContractAuthored,
  type RentalOptions,
} from '../helpers/line-totals-fixture.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

/** "0.50" and "0.5" are one value; compare canonical spellings. */
const canonical = (value: unknown) =>
  typeof value === 'string'
    ? value.replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '')
    : value;
const outcome = (promise: Promise<{ outcome: string }>) =>
  promise.then(
    (result) => JSON.stringify(result),
    (error: Error & { code?: string }) =>
      `${String(error.code)} ${error.message}`,
  );

/** The module table holding one record (physical names are hashed). */
async function tableHolding(pool: Pool, recordId: string): Promise<string> {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'north_star_module' AND column_name = 'record_id'`,
  );
  for (const { table_name } of tables.rows) {
    const hit = await pool.query(
      `SELECT 1 FROM north_star_module.${escapeIdentifier(table_name)} WHERE record_id = $1`,
      [recordId],
    );
    if (hit.rowCount) return table_name;
  }
  throw new Error(`no module table holds ${recordId}`);
}

/**
 * The database's detected-deadlock count. With `previous`, it waits out the
 * statistics flush (backends report within ten seconds of going idle) and
 * returns as soon as the count moves, or the unchanged count after 12 s.
 */
async function deadlocks(pool: Pool, previous?: number): Promise<number> {
  const read = async () => {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_stat_clear_snapshot()');
      const result = await client.query<{ n: string }>(
        `SELECT deadlocks::text AS n FROM pg_stat_database
          WHERE datname = current_database()`,
      );
      return Number(result.rows[0]?.n ?? 0);
    } finally {
      client.release();
    }
  };
  if (previous === undefined) return read();
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const count = await read();
    if (count !== previous) return count;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return read();
}

/** Wait until at least `count` sessions of this database wait on a lock. */
async function lockWaiters(pool: Pool, count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const waiting = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((waiting.rows[0]?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fewer than ${String(count)} sessions waited on a lock`);
}

async function withRental(
  label: string,
  options: RentalOptions,
  run: (
    world: AgentWorld,
    pool: Pool,
    install: { databaseUrl: string; compiledApplication: unknown },
  ) => Promise<void>,
) {
  await withEphemeralPostgres(
    label,
    async ({ connection, pool }) => {
      const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
      // Installing runs release verification on the declaring release.
      const compiledApplication = rentalApplication(
        rentalContractAuthored(options),
      );
      const runtime = await startRuntime(databaseUrl, label, {
        compiledApplication,
      }).catch((error: unknown) =>
        assert.fail(
          `a declaring release failed to install: ${String(
            (error as { code?: string }).code,
          )} ${(error as Error).message}`,
        ),
      );
      try {
        await run(worldOver(runtime, String(connection.database)), pool, {
          databaseUrl,
          compiledApplication,
        });
      } finally {
        await runtime.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
}

function arrange(world: AgentWorld, shared = false) {
  const scope = (company: string) => (shared ? {} : { legalEntityId: company });
  const contract = async (
    company: string = COMPANY,
    currency = 'USD',
    name = 'Spring hire',
  ) => {
    const created = await world.invoke('custom_rental_contract_create', {
      recordId: randomUUID(),
      ...scope(company),
      values: { [h('name')]: name, [h('currency')]: currency },
    });
    assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
    return created.readBack!;
  };
  let number = 0;
  const line = (
    parent: string,
    values: Record<string, string>,
    company: string = COMPANY,
  ) =>
    world.invoke('custom_rental_contract_lines_create', {
      recordId: randomUUID(),
      ...scope(company),
      values: {
        [l('line_number')]: String(++number),
        [l('item')]: 'Excavator',
        ...Object.fromEntries(
          Object.entries(values).map(([local, value]) => [l(local), value]),
        ),
      },
      relations: { [PARENT]: parent },
    });
  const lifecycle = (
    verb: 'archive' | 'restore' | 'update',
    record: { recordId: string; revision: number },
    patch?: Record<string, string>,
  ) =>
    world.invoke(`custom_rental_contract_lines_${verb}`, {
      recordId: record.recordId,
      expectedRevision: record.revision,
      ...(patch
        ? {
            patch: Object.fromEntries(
              Object.entries(patch).map(([local, value]) => [l(local), value]),
            ),
          }
        : {}),
    });
  /** A get as the demo manager, in one company's scope (owned records). */
  const get = (
    local: string,
    recordId: string,
    company: string | null = shared ? null : COMPANY,
  ) =>
    world.runtime.entry.run(
      { headers: { cookie: 'northstar-demo-actor=manager' } },
      (view) =>
        world.runtime.queryGateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: `${NS}:query.${local}_get`,
          arguments: {
            recordId,
            ...(company
              ? { [`${NS}:parameter.${local}_get_legal_entity_scope`]: company }
              : {}),
          },
        }),
    );
  const read = async (recordId: string) => {
    const result = await get('custom_rental_contract_lines', recordId);
    assert.equal(result.records.length, 1, JSON.stringify(result));
    return result.records[0]!;
  };
  const header = async (recordId: string, company?: string | null) => {
    const result = await get('custom_rental_contract', recordId, company);
    assert.equal(result.records.length, 1, JSON.stringify(result));
    return result.records[0]!;
  };
  return { contract, line, lifecycle, read, header, get };
}

test(
  'LINE-TOTALS-s1 derive: a line stores its rounded amount on create and update, refuses a sent amount, and the header currency is create-only',
  { timeout: 900_000 },
  async () => {
    await withRental('line-totals-derive', {}, async (world) => {
      const { contract, line, read } = arrange(world);
      const header = await contract();

      // Derived on create, read back by a plain GET: 1.5 x 0.33 = 0.495,
      // rounded half away from zero to 0.50.
      const first = await line(header.recordId, {
        days: '1.5',
        daily_rate: '0.33',
      });
      assert.equal(first.outcome, 'succeeded', JSON.stringify(first));
      assert.equal(
        canonical((await read(first.readBack!.recordId)).values[AMOUNT]),
        '0.5',
        'a line create did not derive its amount',
      );

      // A blank discount is priced as 0 (absentAs); 12.5% is applied exactly.
      const discounted = await line(header.recordId, {
        days: '1',
        daily_rate: '10',
        discount: '12.5',
      });
      assert.equal(discounted.outcome, 'succeeded');
      assert.equal(
        canonical(discounted.readBack!.values[AMOUNT]),
        '8.75',
        'the read-back lost the stored derived value',
      );

      // A rate-only update recomputes from the stored days (the merge).
      const updated = await world.invoke(
        'custom_rental_contract_lines_update',
        {
          recordId: first.readBack!.recordId,
          expectedRevision: first.readBack!.revision,
          patch: { [l('daily_rate')]: '0.5' },
        },
      );
      assert.equal(updated.outcome, 'succeeded', JSON.stringify(updated));
      assert.equal(
        canonical((await read(first.readBack!.recordId)).values[AMOUNT]),
        '0.75',
        'a rate-only update did not recompute the amount from the stored days',
      );

      // A caller-sent amount is refused as a field outside the writable set.
      const sent = await outcome(
        line(header.recordId, { days: '1', daily_rate: '1', amount: '999' }),
      );
      assert.match(
        sent,
        /^MODULE_FIELD_UNSUPPORTED operation input contains a field outside its writable set/u,
        'a caller-sent derived amount was accepted',
      );

      // An amount that does not fit its field refuses by name, never 22003.
      const overflow = await outcome(
        line(header.recordId, {
          days: '999999999',
          daily_rate: '999999999',
        }),
      );
      assert.match(
        overflow,
        /^MODULE_DERIVED_VALUE_OVERFLOW /u,
        'an overflowing derived amount was not refused by name',
      );

      // Q2, declared as validations on the operands: a discount above 100
      // and a negative rate (stored-currency money against zero) refuse.
      const discount = await outcome(
        line(header.recordId, {
          days: '1',
          daily_rate: '1',
          discount: '150',
        }),
      );
      assert.match(
        discount,
        /Use a discount from 0 to 100\./u,
        'a 150% discount was accepted',
      );
      const negative = await outcome(
        line(header.recordId, { days: '1', daily_rate: '-1' }),
      );
      assert.match(
        negative,
        /The daily rate cannot be negative\./u,
        'a negative stored-currency rate was accepted',
      );

      // The header currency is create-only: an update naming it is refused.
      const currency = await outcome(
        world.invoke('custom_rental_contract_update', {
          recordId: header.recordId,
          expectedRevision: header.revision,
          patch: { [h('currency')]: 'CAD' },
        }),
      );
      assert.match(
        currency,
        /^MODULE_FIELD_UNSUPPORTED operation input contains a field outside its writable set/u,
        'a create-only currency was changed on update',
      );
      const renamed = await world.invoke('custom_rental_contract_update', {
        recordId: header.recordId,
        expectedRevision: header.revision,
        patch: { [h('name')]: 'Summer hire' },
      });
      assert.equal(renamed.outcome, 'succeeded', JSON.stringify(renamed));
    });
  },
);

test(
  'LINE-TOTALS-s1 total: the header get reads the sum of its live lines, absent with an unpriced line, per company, and withheld without the line read',
  { timeout: 900_000 },
  async () => {
    await withRental('line-totals-total', {}, async (world, pool) => {
      const { contract, line, lifecycle, header, get } = arrange(world);
      const north = await contract();
      const other = await contract(COMPANY, 'USD', 'Autumn hire');
      for (const values of [
        { days: '1.5', daily_rate: '0.33' },
        { days: '1', daily_rate: '10', discount: '12.5' },
      ]) {
        const created = await line(north.recordId, values);
        assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
      }
      // Another contract's line of the same company.
      assert.equal(
        (await line(other.recordId, { days: '7', daily_rate: '100' })).outcome,
        'succeeded',
      );
      assert.equal(
        canonical((await header(north.recordId)).values[TOTAL]),
        '9.25',
        "the total counted another record's lines or missed its own",
      );
      // An empty contract totals a typed zero.
      assert.equal(
        canonical((await header((await contract()).recordId)).values[TOTAL]),
        '0',
      );

      // One unpriced live line makes the total ABSENT, never a partial sum.
      const unpriced = await line(north.recordId, { days: '2' });
      assert.equal(unpriced.outcome, 'succeeded', JSON.stringify(unpriced));
      const absent = await header(north.recordId);
      assert.ok(Object.hasOwn(absent.values, TOTAL));
      assert.equal(
        absent.values[TOTAL],
        null,
        'an unpriced line did not make the total absent',
      );
      // Archived, it is left out again.
      const archived = await lifecycle('archive', unpriced.readBack!);
      assert.equal(archived.outcome, 'succeeded', JSON.stringify(archived));
      assert.equal(
        canonical((await header(north.recordId)).values[TOTAL]),
        '9.25',
        'an archived line was counted in the total',
      );

      // Two companies in the SAME tenant and environment.
      const south = randomUUID();
      const southCreated = await world.invoke('legal_entity_create', {
        recordId: south,
        values: {
          [`${NS}:field.legal_entity_code`]: 'SOUTH',
          [`${NS}:field.legal_entity_name`]: 'South',
          [`${NS}:field.legal_entity_status`]: `${NS}:option.legal_entity_status_active`,
          [`${NS}:field.legal_entity_is_default`]: false,
        },
      });
      assert.equal(southCreated.outcome, 'succeeded');
      const southern = await contract(south);
      assert.equal(
        (await line(southern.recordId, { days: '9', daily_rate: '999' }, south))
          .outcome,
        'succeeded',
      );
      assert.equal(
        canonical((await header(southern.recordId, south)).values[TOTAL]),
        '8991',
      );
      assert.equal(
        canonical((await header(north.recordId)).values[TOTAL]),
        '9.25',
        "another company's line counted in the total",
      );
      // A North-scoped principal is refused South's contract and its total.
      const { tenantId, environmentId } = world.runtime.identity;
      const narrowed = await pool.query(
        'UPDATE platform.current_policy_memberships SET legal_entity_id=$3 WHERE (tenant_id,environment_id)=($1,$2) AND legal_entity_id IS NULL AND revoked_at IS NULL',
        [tenantId, environmentId, COMPANY],
      );
      assert.ok(narrowed.rowCount);
      const crossed = await outcome(
        get('custom_rental_contract', southern.recordId, south),
      );
      assert.doesNotMatch(crossed, /8991/u, "South's total reached North");
      assert.match(crossed, /SEMANTIC_QUERY_POLICY_DENIED|"records":\[\]/u);

      // Without the lines' read the total is WITHHELD and the header answered.
      const { permissionId } = await world.runtime.entry.run(
        { headers: { cookie: 'northstar-demo-actor=manager' } },
        (view) =>
          Promise.resolve(
            registeredSemanticQueryFromPinnedView(
              view,
              `${NS}:query.custom_rental_contract_lines_list`,
            )!,
          ),
      );
      const removed = await pool.query(
        `DELETE FROM platform.current_policy_permission_grants
          WHERE tenant_id = $1 AND environment_id = $2 AND permission_id = $3`,
        [tenantId, environmentId, permissionId],
      );
      assert.ok(removed.rowCount);
      const withheld = await header(north.recordId);
      assert.equal(withheld.values[h('name')], 'Spring hire');
      assert.ok(
        !Object.hasOwn(withheld.values, TOTAL) &&
          JSON.stringify(withheld.withheldFieldIds) === JSON.stringify([TOTAL]),
        `a total over lines the reader cannot see was not withheld: ${JSON.stringify(withheld)}`,
      );
    });
  },
);

test(
  'LINE-TOTALS-s1 maximum: a shared contract with unconstrained operands verifies, refuses line N+1 on create and restore, and its concurrent line writes serialize without deadlock',
  { timeout: 900_000 },
  async () => {
    await withRental(
      'line-totals-maximum',
      {
        shared: true,
        validations: false,
        pathValidation: true,
        maximumLines: 3,
      },
      async (world, pool) => {
        const { contract, line, lifecycle, read } = arrange(world, true);
        const full = await contract();
        const lines = [];
        for (let index = 0; index < 3; index += 1) {
          const created = await line(full.recordId, {
            days: '1',
            daily_rate: '1',
          });
          assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
          lines.push(created.readBack!);
        }
        assert.match(
          await outcome(line(full.recordId, { days: '1', daily_rate: '1' })),
          /^MODULE_LINE_MAXIMUM_EXCEEDED /u,
          'line N+1 was accepted on create',
        );
        // Archive one, fill its place, and restoring it would be line N+1.
        const archived = await lifecycle('archive', lines[0]!);
        assert.equal(archived.outcome, 'succeeded', JSON.stringify(archived));
        assert.equal(
          (await line(full.recordId, { days: '1', daily_rate: '1' })).outcome,
          'succeeded',
        );
        assert.match(
          await outcome(lifecycle('restore', archived.readBack!)),
          /^MODULE_LINE_MAXIMUM_EXCEEDED /u,
          'a restore past the maximum was accepted',
        );

        // The header lock is taken before the path read (prepareMutation's
        // FOR SHARE on the parent). Made deterministic: a third session holds
        // the header FOR UPDATE, both creates queue on it, then it is
        // released. Locked first, the two creates serialize on the header;
        // had the lock come after the path read, both would hold FOR SHARE
        // and each ask for NO KEY UPDATE, which deadlocks.
        const placed = await contract();
        for (let index = 0; index < 2; index += 1)
          assert.equal(
            (await line(placed.recordId, { days: '1', daily_rate: '1' }))
              .outcome,
            'succeeded',
          );
        const headerTable = await tableHolding(pool, placed.recordId);
        const unplaced = await deadlocks(pool);
        const blocker = await pool.connect();
        let queued: string[];
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            `SELECT 1 FROM north_star_module.${escapeIdentifier(headerTable)} WHERE record_id = $1 FOR UPDATE`,
            [placed.recordId],
          );
          const racing = [0, 1].map(() =>
            outcome(line(placed.recordId, { days: '1', daily_rate: '1' })),
          );
          await lockWaiters(pool, 2);
          await blocker.query('COMMIT');
          queued = await Promise.all(racing);
        } finally {
          await blocker.query('ROLLBACK').catch(() => undefined);
          blocker.release();
        }
        assert.equal(
          await deadlocks(pool, unplaced),
          unplaced,
          `line creates took the header lock after the path read and deadlocked: ${queued.join(' | ')}`,
        );
        assert.equal(
          queued.filter((entry) => /"outcome":"succeeded"/u.test(entry)).length,
          1,
          queued.join(' | '),
        );

        // Two concurrent creates at maximum - 1 under a parent-path
        // validation: exactly one is refused by name, and none deadlocks. A
        // deadlock is retried once by the write path, so it is observed in
        // the database's own deadlock counter, not in the outcome.
        const before = await deadlocks(pool);
        for (let round = 0; round < 6; round += 1) {
          const header = await contract();
          for (let index = 0; index < 2; index += 1)
            assert.equal(
              (await line(header.recordId, { days: '1', daily_rate: '1' }))
                .outcome,
              'succeeded',
            );
          const raced = await Promise.all(
            [0, 1].map(() =>
              outcome(line(header.recordId, { days: '1', daily_rate: '1' })),
            ),
          );
          assert.equal(
            raced.filter((entry) => /"outcome":"succeeded"/u.test(entry))
              .length,
            1,
            `two concurrent creates at max-1 did not serialize: ${raced.join(' | ')}`,
          );
          assert.ok(
            raced.some((entry) =>
              /^MODULE_LINE_MAXIMUM_EXCEEDED /u.test(entry),
            ),
            `two concurrent creates at max-1 did not serialize: ${raced.join(' | ')}`,
          );
        }
        assert.equal(
          await deadlocks(pool, before),
          before,
          'concurrent line creates under a parent-path validation deadlocked',
        );

        // A shared line's update and its archive never deadlock: both lock
        // the line before the header. Made deterministic: a third session
        // holds the line FOR SHARE, the update queues for the line first, the
        // archive second (and has waited past deadlock_timeout), and then the
        // line is released. Had the archive taken the header first, the
        // update would hold the line and wait on the header while the archive
        // held the header and waited on the line; the update, detecting it,
        // would lose and find the line archived on its retry.
        const header = await contract();
        const created = await line(header.recordId, {
          days: '2',
          daily_rate: '5',
        });
        assert.equal(created.outcome, 'succeeded');
        const record = created.readBack!;
        const table = await tableHolding(pool, record.recordId);
        const ordered = await deadlocks(pool);
        const holder = await pool.connect();
        let settled: string[];
        try {
          await holder.query('BEGIN');
          await holder.query(
            `SELECT 1 FROM north_star_module.${escapeIdentifier(table)} WHERE record_id = $1 FOR SHARE`,
            [record.recordId],
          );
          const updating = outcome(
            lifecycle('update', record, { daily_rate: '6' }),
          );
          await lockWaiters(pool, 1);
          const archiving = outcome(lifecycle('archive', record));
          await lockWaiters(pool, 2);
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          await holder.query('COMMIT');
          settled = await Promise.all([updating, archiving]);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          holder.release();
        }
        assert.equal(
          await deadlocks(pool, ordered),
          ordered,
          `a shared update and an archive of one line deadlocked: ${settled.join(' | ')}`,
        );
        assert.match(
          settled[0]!,
          /"outcome":"succeeded"/u,
          `a shared update and an archive of one line deadlocked: ${settled.join(' | ')}`,
        );
        assert.match(settled[1]!, /^MODULE_REVISION_CONFLICT /u, settled[1]);

        // The amount is derived from what a caller sends.
        assert.equal(
          canonical((await read(lines[1]!.recordId)).values[AMOUNT]),
          '1',
        );
      },
    );
  },
);

test(
  'LINE-TOTALS-s1 template: a template member line and an entered line each store their derived amount, and the header total is their sum',
  { timeout: 900_000 },
  async () => {
    // A record-template binding on the contract form (maximum 200, the
    // compile minimum for a templated relation). Template columns carry no
    // decimal, so the amount's operands default when blank: one day at 40.00.
    await withRental(
      'line-totals-template',
      { template: true, maximumLines: 200 },
      async (world, _pool, install) => {
        const { read, header } = arrange(world);
        // Template verification needs the verifier connection, which only
        // the Customize service's admission has: the binding is activated
        // there, over the installed declaring release.
        const opened = await openCustomizeService({
          databaseUrl: install.databaseUrl,
          tenantSlug: 'line-totals-template',
          compiledApplication: install.compiledApplication as never,
        });
        try {
          const offers = (await opened.service.targets()).templateBindings!;
          const offer = offers.find(
            (entry) => entry.frame.formId === TEMPLATE_FORM,
          );
          assert.ok(offer, 'the rental form offers no template binding');
          const drafted = await opened.service.draft(
            draftTemplateBinding(offers, {
              formId: TEMPLATE_FORM,
              contextId: null,
              required: false,
              lifecycle: 'active',
              fields: offer.columns.map((column) => ({
                fieldId: column.fieldId,
                copyEligible: true,
              })),
            }),
            'visualBuilder',
          );
          assert.ok(drafted.status === 'drafted', JSON.stringify(drafted));
          await opened.service.approve(drafted.patchId);
          await opened.service.activate(drafted.patchId);
        } finally {
          await opened.close();
        }
        const library = world.runtime.recordTemplates;
        const run = <T>(work: (view: RequestRuntimeView) => Promise<T>) =>
          world.runtime.entry.run(
            { headers: { cookie: 'northstar-demo-actor=manager' } },
            work,
          );
        const target = { company: COMPANY, form: TEMPLATE_FORM };
        const review = await run((view) =>
          library.review(view, target, null, 0, {
            version: 1,
            label: 'Standard hire',
            columns: [{ fieldId: l('item'), caption: 'Item' }],
            members: [
              {
                key: 'delivery',
                kind: 'row',
                caption: 'Delivery',
                cells: { [l('item')]: 'Delivery' },
              },
            ],
          }),
        );
        const published = await run((view) =>
          library.publish(view, review.reviewId, review.digest),
        );
        await run((view) =>
          library.assign(view, target, 'wholeType', 0, published.revisionId),
        );

        // One create inserts the template's member line (insert site one)
        // and one entered line (insert site two) under the new header.
        const entered = randomUUID();
        const input = {
          recordId: randomUUID(),
          legalEntityId: COMPANY,
          relations: {},
          values: { [h('name')]: 'Templated hire', [h('currency')]: 'USD' },
          templateLines: [
            {
              recordId: entered,
              values: {
                [l('item')]: 'Excavator',
                [l('days')]: '2',
                [l('daily_rate')]: '15',
              },
            },
          ],
        };
        const key = randomUUID();
        await run((view) =>
          library.prepareCreate(view, TEMPLATE_FORM, key, input),
        );
        const created = await world.invoke(
          'custom_rental_contract_create',
          input,
          { idempotencyKey: key },
        );
        assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
        const pin = await run((view) =>
          library.application(view, target, input.recordId),
        );
        const member = pin?.memberRows.delivery;
        assert.ok(member, JSON.stringify(pin));
        assert.equal(
          canonical((await read(member)).values[AMOUNT]),
          '40',
          'a template member line did not derive its amount',
        );
        assert.equal(
          canonical((await read(entered)).values[AMOUNT]),
          '30',
          'an entered template line did not derive its amount',
        );
        assert.equal(
          canonical((await header(input.recordId)).values[TOTAL]),
          '70',
          'the header total is not the sum of its template lines',
        );
      },
    );
  },
);
