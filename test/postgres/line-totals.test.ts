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

import type { Pool } from 'pg';

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

async function withRental(
  label: string,
  options: RentalOptions,
  run: (world: AgentWorld, pool: Pool) => Promise<void>,
) {
  await withEphemeralPostgres(
    label,
    async ({ connection, pool }) => {
      const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
      // Installing runs release verification on the declaring release.
      const runtime = await startRuntime(databaseUrl, label, {
        compiledApplication: rentalApplication(rentalContractAuthored(options)),
      }).catch((error: unknown) =>
        assert.fail(
          `a declaring release failed to install: ${String(
            (error as { code?: string }).code,
          )} ${(error as Error).message}`,
        ),
      );
      try {
        await run(worldOver(runtime, String(connection.database)), pool);
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
        line(header.recordId, { days: '1', daily_rate: '1', discount: '150' }),
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
      async (world) => {
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

        // Two concurrent creates at maximum - 1 under a parent-path
        // validation: exactly one is refused by name, and none deadlocks.
        for (let round = 0; round < 3; round += 1) {
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
          assert.doesNotMatch(raced.join('\n'), /40P01|deadlock/u);
          assert.equal(
            raced.filter((entry) => /"outcome":"succeeded"/u.test(entry))
              .length,
            1,
            `two concurrent creates at max-1 did not serialize: ${raced.join(' | ')}`,
          );
        }

        // A shared line's update and its archive, concurrently, never
        // deadlock: both lock the line before the header.
        for (let round = 0; round < 3; round += 1) {
          const header = await contract();
          const created = await line(header.recordId, {
            days: '2',
            daily_rate: '5',
          });
          assert.equal(created.outcome, 'succeeded');
          const record = created.readBack!;
          const raced = await Promise.all([
            outcome(lifecycle('update', record, { daily_rate: '6' })),
            outcome(lifecycle('archive', record)),
          ]);
          assert.doesNotMatch(
            raced.join('\n'),
            /40P01|deadlock/u,
            `a shared update and an archive of one line deadlocked: ${raced.join(' | ')}`,
          );
        }
        // The operands verification wrote (one) fit; the amount is derived
        // from what a caller sends.
        assert.equal(
          canonical((await read(lines[1]!.recordId)).values[AMOUNT]),
          '1',
        );
      },
    );
  },
);
