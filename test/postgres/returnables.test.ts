import assert from 'node:assert/strict';
import test from 'node:test';

import type { PoolClient } from 'pg';

import {
  formatCents,
  parseExact,
  toCents,
} from '../../packages/postgres-provider/src/commercial-amounts.js';
import {
  fulfillmentColumn,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
} from '../../packages/postgres-provider/src/fulfillment.js';
import { InventoryPostingError } from '../../packages/postgres-provider/src/inventory-posting-error.js';
import { ModuleRuntimeInterpreterError } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';

const ns = 'northstar.app';

/** A stored exact decimal as money: `30.000000000000000000` -> `30.00`. */
function money(value: ImmutableJsonValue | undefined): string | null {
  const parsed = parseExact(value);
  return parsed ? formatCents(toCents(parsed.units, parsed.scale)) : null;
}

/** A stored whole quantity: `6.000000000000000000` -> `6`. */
function whole(value: ImmutableJsonValue | undefined): string | null {
  const parsed = parseExact(value);
  return parsed ? String(parsed.units / 10n ** BigInt(parsed.scale)) : null;
}

/** A capability refusal, or a generic write's, by its code. */
function refusedWith(code: string) {
  return (error: unknown) =>
    (error instanceof InventoryPostingError ||
      error instanceof ModuleRuntimeInterpreterError) &&
    error.code === code;
}

type Fixture = Parameters<Parameters<typeof withOrderEntryFixture>[0]>[0];

/** Returnable types, custody records and their events over one fixture. */
function returnablesKit(fixture: Fixture) {
  const option = (local: string, name: string, value: string) =>
    `${ns}:option.${local}_${name}_${value}`;
  const value = (record: SemanticRecordDto, local: string, name: string) =>
    record.values[`${ns}:field.${local}_${name}`];
  const type = (code: string, deposits: Record<string, string | null>) =>
    fixture.create(
      'returnable_asset_type',
      {
        code,
        name: `${code} returnable`,
        asset_class: option('returnable_asset_type', 'asset_class', 'keg'),
        deposit_cad: deposits.cad ?? null,
        deposit_usd: deposits.usd ?? null,
        deposit_eur: deposits.eur ?? null,
      },
      {},
      false,
    );
  /** A new custody record of the fixture's party, as the party page starts one. */
  const custody = (
    typeId: string,
    direction: 'out' | 'held',
    currency: 'cad' | 'usd' | 'eur' = 'cad',
  ) =>
    fixture.create(
      'returnable_custody',
      {
        state: option('returnable_custody', 'state', 'new'),
        party_id: fixture.customer,
        direction: option('returnable_custody', 'direction', direction),
        asset_type_id: typeId,
        currency: option('returnable_custody', 'currency', currency),
      },
      { party: fixture.customer, asset_type: typeId },
    );
  const draft = (
    custodyId: string,
    kind: 'issue' | 'return' | 'forfeit' | 'refund',
    values: {
      quantity?: string;
      amount?: string;
      method?: 'cash' | 'cheque' | 'bank_transfer' | null;
      reference?: string;
    },
  ) =>
    fixture.create(
      'returnable_event',
      {
        state: option('returnable_event', 'state', 'draft'),
        kind: option('returnable_event', 'kind', kind),
        event_date: new Date().toISOString(),
        quantity: values.quantity ?? null,
        amount: values.amount ?? null,
        method: values.method
          ? option('returnable_event', 'method', values.method)
          : null,
        reference: values.reference ?? null,
        reason: `${kind} proof`,
      },
      { custody: custodyId },
    );
  const post = async (
    custodyId: string,
    kind: 'issue' | 'return' | 'forfeit' | 'refund',
    values: Parameters<typeof draft>[2],
  ) => {
    const event = await draft(custodyId, kind, values);
    const result = await fixture.invoke('returnable_event_post', {
      recordId: event.recordId,
      expectedRevision: event.revision,
    });
    assert.equal(result.outcome, 'succeeded', kind);
    return result.readBack!;
  };
  const query = async (
    local: string,
    arguments_: Record<string, ImmutableJsonValue>,
  ) =>
    fixture.app.runtime.entry.run({ headers: {} }, (view) => {
      const definition = registeredSemanticQueryFromPinnedView(
        view,
        `${ns}:query.${local}`,
      )!;
      return fixture.app.runtime.queryGateway.invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: definition.queryId,
        arguments: {
          ...arguments_,
          ...(definition.legalEntityScope
            ? {
                [definition.legalEntityScope.operand.parameterId]:
                  fixture.scope,
              }
            : {}),
        },
      });
    });
  const reread = async (local: string, recordId: string) =>
    (await query(`${local}_get`, { recordId, includeArchived: false }))
      .records[0]!;
  /** The custody figures as the custody record states them. */
  const figures = async (custodyId: string) => {
    const record = await reread('returnable_custody', custodyId);
    const read = (name: string) => value(record, 'returnable_custody', name);
    return {
      state: String(read('state')).split('returnable_custody_state_')[1],
      unit: money(read('unit_deposit')),
      issued: whole(read('issued_quantity')),
      returned: whole(read('returned_quantity')),
      forfeited: whole(read('forfeited_quantity')),
      outstanding: whole(read('outstanding_quantity')),
      taken: money(read('deposit_taken')),
      refunded: money(read('deposit_refunded')),
      kept: money(read('deposit_forfeited')),
      held: money(read('deposit_held')),
      refundable: money(read('deposit_refundable')),
    };
  };
  /**
   * The same figures computed independently, straight from storage: the
   * custody's posted events summed by kind, by this test's own reading of the
   * bounds -- issued less returned and forfeited is outstanding; taken less
   * refunded and kept is held.
   */
  const independent = async (custodyId: string) => {
    const target = await governedStorageTarget();
    const event = target.entities.find(
      (entity) => entity.entityId === `${ns}:entity.returnable_event`,
    )!;
    const custodyColumn = target.relations.find(
      (relation) =>
        relation.relationId === `${ns}:relation.returnable_event_custody`,
    )!.relationColumn.physicalName;
    const column = (name: string) =>
      q(fulfillmentColumn(event, `returnable_event_${name}`));
    const rows = await fixture.pool.query<{
      kind: string;
      quantity: string | null;
      amount: string | null;
    }>(
      `SELECT ${column('kind')} AS kind, ${column('quantity')}::text AS quantity,
              ${column('amount')}::text AS amount
         FROM ${fulfillmentTable(event)}
        WHERE tenant_id=$1 AND environment_id=$2 AND ${q(custodyColumn)}=$3
          AND archived_at IS NULL AND ${column('state')}=$4`,
      [
        fixture.app.runtime.identity.tenantId,
        fixture.app.runtime.identity.environmentId,
        custodyId,
        option('returnable_event', 'state', 'posted'),
      ],
    );
    const total = (kind: string, of: 'quantity' | 'amount') =>
      rows.rows
        .filter((row) => row.kind === option('returnable_event', 'kind', kind))
        .reduce((sum, row) => {
          const parsed = parseExact(row[of]);
          return parsed ? sum + toCents(parsed.units, parsed.scale) : sum;
        }, 0n);
    const units = (kind: string) => total(kind, 'quantity') / 100n;
    const issued = units('issue');
    const returned = units('return');
    const forfeited = units('forfeit');
    const taken = total('issue', 'amount');
    const refunded = total('refund', 'amount');
    const kept = total('forfeit', 'amount');
    return {
      issued: String(issued),
      returned: String(returned),
      forfeited: String(forfeited),
      outstanding: String(issued - returned - forfeited),
      taken: formatCents(taken),
      refunded: formatCents(refunded),
      kept: formatCents(kept),
      held: formatCents(taken - refunded - kept),
    };
  };
  /** Every stock movement and balance row of the fixture's company. */
  const stock = async () => {
    const target = await governedStorageTarget();
    const rows = async (local: string) => {
      const entity = target.entities.find(
        (value) => value.entityId === `${ns}:entity.${local}`,
      )!;
      return (
        await fixture.pool.query(
          `SELECT * FROM ${fulfillmentTable(entity)}
            WHERE tenant_id=$1 AND environment_id=$2 ORDER BY record_id`,
          [
            fixture.app.runtime.identity.tenantId,
            fixture.app.runtime.identity.environmentId,
          ],
        )
      ).rows;
    };
    return JSON.stringify({
      movements: await rows('inventory_movement'),
      balances: await rows('posted_stock_balance'),
    });
  };
  return {
    option,
    value,
    type,
    custody,
    draft,
    post,
    reread,
    figures,
    independent,
    stock,
  };
}

test('returnables: deposits on issue, bounded returns and forfeits, refunds bounded by the deposit on what came back, off the stock ledger', async () => {
  await withOrderEntryFixture(async (fixture) => {
    const kit = returnablesKit(fixture);
    const stockBefore = await kit.stock();
    const keg = await kit.type('KEG-50', { cad: '30', usd: null, eur: '25.5' });
    const rtn = await kit.custody(keg.recordId, 'out');
    assert.match(
      String(kit.value(rtn, 'returnable_custody', 'number')),
      /^RTN-\d{6}$/u,
    );
    assert.equal((await kit.figures(rtn.recordId)).state, 'new');

    // Nothing is returned, forfeited or refunded before anything is issued.
    await assert.rejects(
      kit.post(rtn.recordId, 'return', { quantity: '1' }),
      refusedWith('RETURNABLES_NOTHING_ISSUED'),
    );

    // Issue 6 kegs: the deposit is taken at the type's CAD deposit, by the
    // method entered by hand, and the event is dated and attributed.
    const issue = await kit.post(rtn.recordId, 'issue', {
      quantity: '6',
      method: 'cheque',
      reference: 'CHQ-4410',
    });
    assert.equal(
      money(kit.value(issue, 'returnable_event', 'amount')),
      '180.00',
    );
    assert.match(
      String(kit.value(issue, 'returnable_event', 'state')),
      /returnable_event_state_posted$/u,
    );
    assert.ok(kit.value(issue, 'returnable_event', 'recorded_by'));
    assert.ok(
      Date.parse(String(kit.value(issue, 'returnable_event', 'event_date'))),
    );
    assert.deepEqual(await kit.figures(rtn.recordId), {
      state: 'open',
      unit: '30.00',
      issued: '6',
      returned: '0',
      forfeited: '0',
      outstanding: '6',
      taken: '180.00',
      refunded: '0.00',
      kept: '0.00',
      held: '180.00',
      refundable: '0.00',
    });

    // The unit deposit is frozen on the custody: a later change of the
    // type's deposit leaves the next Issue at 30.00.
    const repriced = await fixture.invoke('returnable_asset_type_update', {
      recordId: keg.recordId,
      expectedRevision: keg.revision,
      patch: { [`${ns}:field.returnable_asset_type_deposit_cad`]: '40' },
    });
    assert.equal(repriced.outcome, 'succeeded');
    const more = await kit.post(rtn.recordId, 'issue', {
      quantity: '1',
      method: 'cash',
    });
    assert.equal(money(kit.value(more, 'returnable_event', 'amount')), '30.00');

    // A deposit taken names how it was paid.
    await assert.rejects(
      kit.post(rtn.recordId, 'issue', { quantity: '1' }),
      refusedWith('RETURNABLES_METHOD_REQUIRED'),
    );
    // Quantities are whole assets.
    await assert.rejects(
      kit.post(rtn.recordId, 'return', { quantity: '1.5' }),
      refusedWith('RETURNABLES_QUANTITY_INVALID'),
    );

    // Return 4: the deposit on them becomes refundable.
    await kit.post(rtn.recordId, 'return', { quantity: '4' });
    let now = await kit.figures(rtn.recordId);
    assert.deepEqual(
      [now.state, now.outstanding, now.refundable, now.held],
      ['open', '3', '120.00', '210.00'],
    );

    // Return plus forfeit never exceeds what was issued: four more, either
    // way, is refused and changes nothing.
    for (const kind of ['return', 'forfeit'] as const)
      await assert.rejects(
        kit.post(rtn.recordId, kind, { quantity: '4' }),
        refusedWith('RETURNABLES_QUANTITY_EXCEEDS_OUTSTANDING'),
      );
    assert.deepEqual(await kit.figures(rtn.recordId), now);

    // Two returns racing for the last three: the custody row serializes
    // them, so exactly one posts and the other is refused.
    const race = await Promise.allSettled([
      kit.post(rtn.recordId, 'return', { quantity: '2' }),
      kit.post(rtn.recordId, 'return', { quantity: '2' }),
    ]);
    assert.equal(
      race.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    );
    assert.ok(
      race.some(
        (outcome) =>
          outcome.status === 'rejected' &&
          refusedWith('RETURNABLES_QUANTITY_EXCEEDS_OUTSTANDING')(
            outcome.reason,
          ),
      ),
    );

    // Forfeit the last one: its deposit is kept, never refundable.
    await kit.post(rtn.recordId, 'forfeit', { quantity: '1' });
    now = await kit.figures(rtn.recordId);
    assert.deepEqual(now, {
      state: 'awaiting_refund',
      unit: '30.00',
      issued: '7',
      returned: '6',
      forfeited: '1',
      outstanding: '0',
      taken: '210.00',
      refunded: '0.00',
      kept: '30.00',
      held: '180.00',
      refundable: '180.00',
    });

    // A refund never exceeds the deposit taken on what came back, and names
    // how it was paid back.
    await assert.rejects(
      kit.post(rtn.recordId, 'refund', {
        amount: '180.01',
        method: 'bank_transfer',
      }),
      refusedWith('RETURNABLES_REFUND_EXCEEDS_DEPOSIT'),
    );
    await assert.rejects(
      kit.post(rtn.recordId, 'refund', { amount: '100' }),
      refusedWith('RETURNABLES_METHOD_REQUIRED'),
    );
    await assert.rejects(
      kit.post(rtn.recordId, 'refund', {
        amount: '0.001',
        method: 'cash',
      }),
      refusedWith('RETURNABLES_AMOUNT_INVALID'),
    );
    const refund = await kit.post(rtn.recordId, 'refund', {
      amount: '100',
      method: 'bank_transfer',
      reference: 'EFT-88',
    });
    assert.equal(
      money(kit.value(refund, 'returnable_event', 'amount')),
      '100.00',
    );
    await assert.rejects(
      kit.post(rtn.recordId, 'refund', { amount: '80.01', method: 'cash' }),
      refusedWith('RETURNABLES_REFUND_EXCEEDS_DEPOSIT'),
    );
    await kit.post(rtn.recordId, 'refund', { amount: '80', method: 'cash' });
    now = await kit.figures(rtn.recordId);
    // Nothing is held any more: 180.00 went back and 30.00 was kept.
    assert.deepEqual(
      [now.state, now.refunded, now.kept, now.held, now.refundable],
      ['closed', '180.00', '30.00', '0.00', '0.00'],
    );
    // The custody's figures are what its posted events add up to.
    const restated = await kit.independent(rtn.recordId);
    assert.deepEqual(restated, {
      issued: now.issued,
      returned: now.returned,
      forfeited: now.forfeited,
      outstanding: now.outstanding,
      taken: now.taken,
      refunded: now.refunded,
      kept: now.kept,
      held: now.held,
    });

    // A posted event and an issued custody are no longer written by the
    // generic writes: only the capability moves them.
    const posted = await kit.reread('returnable_event', refund.recordId);
    await assert.rejects(
      fixture.invoke('returnable_event_update', {
        recordId: posted.recordId,
        expectedRevision: posted.revision,
        patch: { [`${ns}:field.returnable_event_amount`]: '1' },
      }),
      refusedWith('MODULE_OPERATION_PRECONDITION_REFUSED'),
    );
    const issued = await kit.reread('returnable_custody', rtn.recordId);
    await assert.rejects(
      fixture.invoke('returnable_custody_update', {
        recordId: issued.recordId,
        expectedRevision: issued.revision,
        patch: {
          [`${ns}:field.returnable_custody_issued_quantity`]: '100',
        },
      }),
      refusedWith('MODULE_FIELD_UNSUPPORTED'),
    );
    await assert.rejects(
      fixture.invoke('returnable_custody_update', {
        recordId: issued.recordId,
        expectedRevision: issued.revision,
        patch: { [`${ns}:field.returnable_custody_notes`]: 'edited' },
      }),
      refusedWith('MODULE_OPERATION_PRECONDITION_REFUSED'),
    );
    // A posted event does not post again.
    await assert.rejects(
      fixture.invoke('returnable_event_post', {
        recordId: posted.recordId,
        expectedRevision: posted.revision,
      }),
      refusedWith('RETURNABLES_EVENT_STATE_CONFLICT'),
    );

    // One custody record per party, type, direction and currency: a second
    // one's first Issue is refused, naming the first.
    const second = await kit.custody(keg.recordId, 'out');
    await assert.rejects(
      kit.post(second.recordId, 'issue', { quantity: '1', method: 'cash' }),
      (error: unknown) =>
        refusedWith('RETURNABLES_CUSTODY_DUPLICATE')(error) &&
        String((error as Error).message).includes(
          String(kit.value(rtn, 'returnable_custody', 'number')),
        ),
    );
    // A currency the type states no deposit in is refused until stated.
    const usd = await kit.custody(keg.recordId, 'out', 'usd');
    await assert.rejects(
      kit.post(usd.recordId, 'issue', { quantity: '1', method: 'cash' }),
      refusedWith('RETURNABLES_DEPOSIT_UNSTATED'),
    );
    // The same party's supplier kegs we hold are their own custody record,
    // in their own currency.
    const held = await kit.custody(keg.recordId, 'held', 'eur');
    await kit.post(held.recordId, 'issue', {
      quantity: '2',
      method: 'bank_transfer',
    });
    assert.deepEqual(
      [
        (await kit.figures(held.recordId)).unit,
        (await kit.figures(held.recordId)).taken,
      ],
      ['25.50', '51.00'],
    );

    // Off the stock ledger: no movement or balance was written.
    assert.equal(await kit.stock(), stockBefore);
  });
});

test('returnables: a party holds our returnables only as an active customer, and we hold a supplier’s only as an active supplier', async () => {
  await withOrderEntryFixture(async (fixture) => {
    const kit = returnablesKit(fixture);
    const crate = await kit.type('CRATE-1', { cad: '5' });
    // The fixture's party has both roles; a party with none holds nothing.
    const stranger = await fixture.create(
      'party',
      { number: 'PTY-RTN-1', name: 'No-role party' },
      {},
      false,
    );
    for (const direction of ['out', 'held'] as const) {
      const custody = await fixture.create(
        'returnable_custody',
        {
          state: `${ns}:option.returnable_custody_state_new`,
          party_id: stranger.recordId,
          direction: `${ns}:option.returnable_custody_direction_${direction}`,
          asset_type_id: crate.recordId,
          currency: `${ns}:option.returnable_custody_currency_cad`,
        },
        { party: stranger.recordId, asset_type: crate.recordId },
      );
      await assert.rejects(
        kit.post(custody.recordId, 'issue', { quantity: '1', method: 'cash' }),
        refusedWith('RETURNABLES_PARTY_ROLE_MISSING'),
      );
    }
    // A custody whose party link names another party than its party field
    // is refused rather than trusted.
    const mismatched = await fixture.create(
      'returnable_custody',
      {
        state: `${ns}:option.returnable_custody_state_new`,
        party_id: stranger.recordId,
        direction: `${ns}:option.returnable_custody_direction_out`,
        asset_type_id: crate.recordId,
        currency: `${ns}:option.returnable_custody_currency_cad`,
      },
      { party: fixture.customer, asset_type: crate.recordId },
    );
    await assert.rejects(
      kit.post(mismatched.recordId, 'issue', { quantity: '1', method: 'cash' }),
      refusedWith('RETURNABLES_CUSTODY_INVALID'),
    );
    // So is one whose type link and type field differ.
    const pallet = await kit.type('PALLET-1', { cad: '12' });
    const retyped = await fixture.create(
      'returnable_custody',
      {
        state: `${ns}:option.returnable_custody_state_new`,
        party_id: fixture.customer,
        direction: `${ns}:option.returnable_custody_direction_out`,
        asset_type_id: crate.recordId,
        currency: `${ns}:option.returnable_custody_currency_cad`,
      },
      { party: fixture.customer, asset_type: pallet.recordId },
    );
    await assert.rejects(
      kit.post(retyped.recordId, 'issue', { quantity: '1', method: 'cash' }),
      refusedWith('RETURNABLES_CUSTODY_INVALID'),
    );
  });
});

test('returnables: only the capability writes a custody’s figures, an in-use returnable type is not archived, and overlapping first Issues and refunds serialize', async () => {
  await withOrderEntryFixture(async (fixture) => {
    const kit = returnablesKit(fixture);
    const figure = (name: string) => `${ns}:field.returnable_custody_${name}`;
    const keg = await kit.type('KEG-30', { cad: '25' });

    // F1. A New custody holds no figure, and no generic write can state one:
    // the figures are outside every generic create's and update's writable
    // set, so only a posted event moves them.
    const fresh = await kit.custody(keg.recordId, 'out');
    for (const [name, value] of [
      ['outstanding_quantity', '1.5'],
      ['deposit_refundable', '999'],
      ['unit_deposit', '25'],
    ] as const)
      await assert.rejects(
        fixture.invoke('returnable_custody_update', {
          recordId: fresh.recordId,
          expectedRevision: fresh.revision,
          patch: { [figure(name)]: value },
        }),
        (error: unknown) => refusedWith('MODULE_FIELD_UNSUPPORTED')(error),
        `a generic update stating ${name} is refused`,
      );
    await assert.rejects(
      fixture.create(
        'returnable_custody',
        {
          state: kit.option('returnable_custody', 'state', 'new'),
          party_id: fixture.customer,
          direction: kit.option('returnable_custody', 'direction', 'out'),
          asset_type_id: keg.recordId,
          currency: kit.option('returnable_custody', 'currency', 'usd'),
          outstanding_quantity: '4',
        },
        { party: fixture.customer, asset_type: keg.recordId },
      ),
      refusedWith('MODULE_FIELD_UNSUPPORTED'),
    );
    // A writable field still edits a New custody, which stays the canonical
    // empty image: New, with every figure absent.
    const noted = await fixture.invoke('returnable_custody_update', {
      recordId: fresh.recordId,
      expectedRevision: fresh.revision,
      patch: { [figure('notes')]: 'Kegs for the spring order' },
    });
    assert.equal(noted.outcome, 'succeeded');
    const empty = await kit.reread('returnable_custody', fresh.recordId);
    assert.match(
      String(kit.value(empty, 'returnable_custody', 'state')),
      /returnable_custody_state_new$/u,
    );
    for (const name of [
      'unit_deposit',
      'issued_quantity',
      'returned_quantity',
      'forfeited_quantity',
      'outstanding_quantity',
      'deposit_taken',
      'deposit_refunded',
      'deposit_forfeited',
      'deposit_held',
      'deposit_refundable',
    ])
      assert.equal(
        kit.value(empty, 'returnable_custody', name) ?? null,
        null,
        `${name} is absent on a New custody`,
      );
    // An event's attribution is the capability's too.
    await assert.rejects(
      fixture.create(
        'returnable_event',
        {
          state: kit.option('returnable_event', 'state', 'draft'),
          kind: kit.option('returnable_event', 'kind', 'issue'),
          event_date: new Date().toISOString(),
          quantity: '1',
          reason: 'attributed by hand',
          recorded_by: 'someone else',
        },
        { custody: fresh.recordId },
      ),
      refusedWith('MODULE_FIELD_UNSUPPORTED'),
    );

    // F3. A custody names its type through a restrict link: the type is not
    // archived while a live custody names it, and an archived type starts no
    // custody. Once the New custody is archived, the type may be.
    const archiveType = (record: { recordId: string; revision: number }) =>
      fixture.invoke('returnable_asset_type_archive', {
        recordId: record.recordId,
        expectedRevision: record.revision,
      });
    const spare = await kit.type('KEG-SPARE', { cad: '10' });
    const lonely = await kit.custody(spare.recordId, 'out');
    await assert.rejects(
      archiveType(spare),
      refusedWith('MODULE_ARCHIVE_RESTRICTED'),
    );
    const parked = await fixture.invoke('returnable_custody_archive', {
      recordId: lonely.recordId,
      expectedRevision: lonely.revision,
    });
    assert.equal(parked.outcome, 'succeeded');
    assert.equal((await archiveType(spare)).outcome, 'succeeded');
    await assert.rejects(
      kit.custody(spare.recordId, 'held'),
      refusedWith('MODULE_RELATION_VIOLATION'),
    );

    // Evidence: two first Issues of DIFFERENT custody records for the same
    // company, party, type, direction and currency, held at the custody
    // key's transaction lock until both wait there: exactly one posts, and
    // the other is refused naming it.
    const scope = [
      fixture.app.runtime.identity.tenantId,
      fixture.app.runtime.identity.environmentId,
    ];
    const barrier = async (
      hold: (client: PoolClient) => Promise<unknown>,
      posts: () => Promise<unknown>[],
      what: string,
    ) => {
      const client = await fixture.pool.connect();
      try {
        await client.query('BEGIN');
        await hold(client);
        const racing = posts();
        const settled = Promise.allSettled(racing);
        let waiting = 0;
        for (let attempt = 0; attempt < 200 && waiting < 2; attempt++) {
          const done = await Promise.race([
            settled.then(() => true),
            new Promise<false>((resolve) =>
              setTimeout(() => resolve(false), 100),
            ),
          ]);
          waiting = Number(
            (
              await fixture.pool.query<{ count: string }>(
                `SELECT count(DISTINCT pid)::text AS count FROM pg_locks
                  WHERE NOT granted AND pid <> $1`,
                [(client as unknown as { processID: number }).processID],
              )
            ).rows[0]!.count,
          );
          if (done) break;
        }
        assert.equal(
          waiting,
          2,
          `both ${what} wait at the serialization point`,
        );
        await client.query('COMMIT');
        return await settled;
      } finally {
        client.release();
      }
    };
    const first = await kit.custody(keg.recordId, 'out');
    const second = await kit.custody(keg.recordId, 'out');
    const firstDraft = await kit.draft(first.recordId, 'issue', {
      quantity: '2',
      method: 'cash',
    });
    const secondDraft = await kit.draft(second.recordId, 'issue', {
      quantity: '3',
      method: 'cheque',
    });
    const postDraft = (event: { recordId: string; revision: number }) =>
      fixture.invoke('returnable_event_post', {
        recordId: event.recordId,
        expectedRevision: event.revision,
      });
    const firstIssues = await barrier(
      (client) =>
        client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended(
             $1::text || ':' || $2::text || ':' || $3::text || ':' || $4::text
             || ':' || $5::text || ':' || $6::text || ':' || $7::text || ':' || $8::text, 0))`,
          [
            ...scope,
            'northstar.party:capability.returnables',
            fixture.scope,
            fixture.customer,
            keg.recordId,
            'out',
            'cad',
          ],
        ),
      () => [postDraft(firstDraft), postDraft(secondDraft)],
      'first Issues',
    );
    assert.equal(
      firstIssues.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
      'exactly one first Issue posts',
    );
    const winner = firstIssues[0]!.status === 'fulfilled' ? first : second;
    assert.ok(
      firstIssues.some(
        (outcome) =>
          outcome.status === 'rejected' &&
          refusedWith('RETURNABLES_CUSTODY_DUPLICATE')(outcome.reason) &&
          String((outcome.reason as Error).message).includes(
            String(kit.value(winner, 'returnable_custody', 'number')),
          ),
      ),
      'the other is refused, naming the custody that posted',
    );

    // Evidence: two refunds of one custody, each within what is refundable
    // and together beyond it, held at the custody row until both wait there:
    // exactly one posts.
    await kit.post(winner.recordId, 'return', { quantity: '2' });
    const refundable = (await kit.figures(winner.recordId)).refundable;
    assert.equal(refundable, '50.00');
    const refunds = [
      await kit.draft(winner.recordId, 'refund', {
        amount: '30',
        method: 'cash',
      }),
      await kit.draft(winner.recordId, 'refund', {
        amount: '30',
        method: 'bank_transfer',
      }),
    ];
    const custodyTable = fulfillmentTable(
      (await governedStorageTarget()).entities.find(
        (entity) => entity.entityId === `${ns}:entity.returnable_custody`,
      )!,
    );
    const racedRefunds = await barrier(
      (client) =>
        client.query(
          `SELECT 1 FROM ${custodyTable} WHERE record_id = $1 FOR UPDATE`,
          [winner.recordId],
        ),
      () => refunds.map(postDraft),
      'refunds',
    );
    assert.equal(
      racedRefunds.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
      'exactly one refund posts',
    );
    assert.ok(
      racedRefunds.some(
        (outcome) =>
          outcome.status === 'rejected' &&
          refusedWith('RETURNABLES_REFUND_EXCEEDS_DEPOSIT')(outcome.reason),
      ),
      'the other is refused for exceeding what is refundable',
    );
    const after = await kit.figures(winner.recordId);
    assert.deepEqual([after.refunded, after.refundable], ['30.00', '20.00']);
  });
});
