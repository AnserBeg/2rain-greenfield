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

import { COMPANY, worldOver, type AgentWorld } from '../agent/agent-world.js';
import { startRuntime } from '../helpers/customization-fixture.js';
import {
  AMOUNT,
  h,
  l,
  PARENT,
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
      const runtime = await startRuntime(databaseUrl, label, {
        compiledApplication: rentalApplication(rentalContractAuthored(options)),
      });
      try {
        await run(worldOver(runtime, String(connection.database)), pool);
      } finally {
        await runtime.close();
      }
    },
    LINEAGE_INSTALL_VOLUME,
  );
}

function arrange(world: AgentWorld) {
  const contract = async (company = COMPANY, currency = 'USD') => {
    const created = await world.invoke('custom_rental_contract_create', {
      recordId: randomUUID(),
      legalEntityId: company,
      values: { [h('name')]: 'Spring hire', [h('currency')]: currency },
    });
    assert.equal(created.outcome, 'succeeded', JSON.stringify(created));
    return created.readBack!;
  };
  let number = 0;
  const line = (
    parent: string,
    values: Record<string, string>,
    company = COMPANY,
  ) =>
    world.invoke('custom_rental_contract_lines_create', {
      recordId: randomUUID(),
      legalEntityId: company,
      values: {
        [l('line_number')]: String(++number),
        [l('item')]: 'Excavator',
        ...Object.fromEntries(
          Object.entries(values).map(([local, value]) => [l(local), value]),
        ),
      },
      relations: { [PARENT]: parent },
    });
  const read = (recordId: string) =>
    world.read('custom_rental_contract_lines', recordId);
  return { contract, line, read };
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
