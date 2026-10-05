import assert from 'node:assert/strict';
import test from 'node:test';
import { withOrderEntryFixture } from '../helpers/order-entry-fixture.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
import {
  fulfillmentColumn,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
} from '../../packages/postgres-provider/src/fulfillment.js';

const ns = 'northstar.app';
const field = (name: string) => `${ns}:field.${name}`;
const parent = `${ns}:relation.location_parent`;
const amount = (value: string) => {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  assert.ok(match);
  const units = BigInt(`${match[2]}${(match[3] ?? '').padEnd(18, '0')}`);
  return match[1] ? -units : units;
};
const decimal = (value: bigint) => {
  const digits = (value < 0n ? -value : value).toString().padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${digits.slice(0, -18)}${fraction ? `.${fraction}` : ''}`;
};

test('LOCATIONS-2: cycles refuse, a moved subtree reclassifies stock, and warehouse figures equal an independent movement and parent-row computation', async () => {
  await withOrderEntryFixture(async (fixture) => {
    const seed = (await fixture.measure('locations-2')) as {
      notebook: string;
      warehouse: string;
      second: string;
      bin: string;
      nested: string;
    };
    const target = await governedStorageTarget();
    const entity = (local: string) =>
      target.entities.find(
        (entry) => entry.entityId === `${ns}:entity.${local}`,
      )!;
    const locations = entity('location');
    const movements = entity('inventory_movement');
    const parentColumn = target.relations.find(
      (entry) => entry.relationId === parent,
    )!.relationColumn.physicalName;
    const identity = [
      fixture.app.runtime.identity.tenantId,
      fixture.app.runtime.identity.environmentId,
    ];
    const source = async () =>
      (
        await fixture.pool.query<{ id: string; parent: string | null }>(
          `SELECT record_id::text AS id, ${q(parentColumn)}::text AS parent FROM ${fulfillmentTable(locations)} WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL`,
          identity,
        )
      ).rows;
    // Independent traversal over stored rows, never the provider's recursive CTE.
    const truth = async (root: string) => {
      const parents = new Map(
        (await source()).map((row) => [row.id, row.parent]),
      );
      const belongs = (location: string) => {
        const seen = new Set<string>();
        for (
          let at: string | null | undefined = location;
          at;
          at = parents.get(at)
        ) {
          if (at === root) return true;
          if (seen.has(at)) assert.fail('stored location cycle');
          seen.add(at);
        }
        return false;
      };
      const rows = (
        await fixture.pool.query<{ location: string; quantity: string }>(
          `SELECT ${q(fulfillmentColumn(movements, 'inventory_movement_location_id'))}::text AS location, ${q(fulfillmentColumn(movements, 'inventory_movement_quantity_delta'))}::text AS quantity FROM ${fulfillmentTable(movements)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(movements.legalEntity!.column)}=$3 AND ${q(fulfillmentColumn(movements, 'inventory_movement_item_id'))}=$4`,
          [...identity, fixture.scope, seed.notebook],
        )
      ).rows;
      return decimal(
        rows
          .filter((row) => belongs(row.location))
          .reduce((sum, row) => sum + amount(row.quantity), 0n),
      );
    };
    const list = async (local: string, root: string) => {
      const url = new URL(fixture.app.baseUrl);
      url.searchParams.set('surface', `${ns}:surface.${local}`);
      url.searchParams.set(`${ns}:list_selector.${local}_warehouse`, root);
      if (local !== 'location_list')
        url.searchParams.set(
          `${ns}:parameter.${local}_legal_entity_scope`,
          fixture.scope,
        );
      const response = await fetch(url);
      assert.equal(response.status, 200);
      return response.text();
    };
    const observed = (html: string, record: string, label: string) => {
      const row = new RegExp(
        `<tr[^>]*data-record-id="${record}"[^>]*>([\\s\\S]*?)</tr>`,
      ).exec(html)?.[1];
      assert.ok(row);
      const cell = new RegExp(
        `<td[^>]*data-column-label="${label}"[^>]*>([\\s\\S]*?)</td>`,
      ).exec(row)?.[1];
      assert.ok(cell);
      return cell.replace(/<[^>]+>/g, '').trim();
    };
    assert.equal(await truth(seed.warehouse), '10');
    assert.equal(await truth(seed.second), '0');
    for (const root of [seed.warehouse, seed.second])
      assert.equal(
        observed(await list('item_stock_list', root), seed.notebook, 'On hand'),
        await truth(root),
      );
    assert.equal(
      observed(
        await list('location_list', seed.warehouse),
        seed.nested,
        'Warehouse',
      ),
      'Calgary warehouse',
    );
    const moved = await fixture.invoke('location_update', {
      recordId: seed.bin,
      expectedRevision: 1,
      patch: {},
      relations: { [parent]: seed.second },
    });
    assert.equal(moved.outcome, 'succeeded');
    assert.equal(await truth(seed.warehouse), '6');
    assert.equal(await truth(seed.second), '4');
    for (const root of [seed.warehouse, seed.second]) {
      assert.equal(
        observed(await list('item_stock_list', root), seed.notebook, 'On hand'),
        await truth(root),
      );
      assert.equal(
        observed(await list('item_buying_list', root), seed.notebook, 'Usable'),
        await truth(root),
      );
    }
    const descendants = await list('location_list', seed.second);
    assert.equal(
      observed(descendants, seed.nested, 'Warehouse'),
      'Second warehouse',
    );
    assert.ok(!descendants.includes(`data-record-id="${seed.warehouse}"`));
    const rejects = (code: string) => (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === code;
    await assert.rejects(
      fixture.invoke('location_update', {
        recordId: seed.second,
        expectedRevision: 1,
        patch: {},
        relations: { [parent]: seed.nested },
      }),
      rejects('MODULE_RELATION_CYCLE'),
    );
    await assert.rejects(
      fixture.invoke('location_update', {
        recordId: seed.bin,
        expectedRevision: 2,
        patch: {},
        relations: { [parent]: seed.bin },
      }),
      rejects('MODULE_RELATION_CYCLE'),
    );
    await assert.rejects(
      fixture.invoke('location_update', {
        recordId: seed.bin,
        expectedRevision: 2,
        patch: {
          [field('location_status')]: `${ns}:option.location_status_quarantine`,
        },
      }),
      rejects('MODULE_FIELD_UNSUPPORTED'),
    );
    await assert.rejects(
      fixture.invoke('location_update_status', {
        recordId: seed.bin,
        expectedRevision: 2,
        patch: {
          [field('location_status')]: `${ns}:option.location_status_quarantine`,
          [field('location_status_reason')]: '  ',
          [field('location_status_changed_at')]: '2026-10-05T12:00:00.000Z',
        },
      }),
      rejects('MODULE_FIELD_VALUE_INVALID'),
    );
    await assert.rejects(
      fixture.create(
        'location',
        {
          code: 'NO-STATUS-WRITE',
          name: 'No status write',
          type: `${ns}:option.storage`,
          status: `${ns}:option.location_status_quarantine`,
        },
        {},
        false,
      ),
      rejects('MODULE_FIELD_UNSUPPORTED'),
    );
    const changedAt = '2026-10-05T12:00:00.000Z';
    const statusChange = await fixture.invoke('location_update_status', {
      recordId: seed.bin,
      expectedRevision: 2,
      patch: {
        [field('location_status')]: `${ns}:option.location_status_quarantine`,
        [field('location_status_reason')]: 'Inspection hold',
        [field('location_status_changed_at')]: changedAt,
      },
    });
    assert.equal(statusChange.outcome, 'succeeded');
    const storedStatus = await fixture.pool.query<{
      status: string;
      reason: string;
      at: Date;
    }>(
      `SELECT ${q(fulfillmentColumn(locations, 'location_status'))} AS status, ${q(fulfillmentColumn(locations, 'location_status_reason'))} AS reason, ${q(fulfillmentColumn(locations, 'location_status_changed_at'))} AS at FROM ${fulfillmentTable(locations)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3`,
      [...identity, seed.bin],
    );
    assert.equal(
      storedStatus.rows[0]?.status,
      `${ns}:option.location_status_quarantine`,
    );
    assert.equal(storedStatus.rows[0]?.reason, 'Inspection hold');
    assert.equal(storedStatus.rows[0]?.at.toISOString(), changedAt);
    const a = await fixture.create(
      'location',
      { code: 'CYCLE-A', name: 'Cycle A', type: `${ns}:option.warehouse` },
      {},
      false,
    );
    const b = await fixture.create(
      'location',
      { code: 'CYCLE-B', name: 'Cycle B', type: `${ns}:option.warehouse` },
      {},
      false,
    );
    const race = await Promise.allSettled(
      [
        [a, b],
        [b, a],
      ].map(([from, to]) =>
        fixture.invoke('location_update', {
          recordId: from!.recordId,
          expectedRevision: 1,
          patch: {},
          relations: { [parent]: to!.recordId },
        }),
      ),
    );
    assert.equal(
      race.filter((entry) => entry.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      race.filter(
        (entry) =>
          entry.status === 'rejected' &&
          rejects('MODULE_RELATION_CYCLE')(entry.reason),
      ).length,
      1,
    );
  });
});
