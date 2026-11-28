/**
 * ADR-0073 A1, owner ruling 2026-11-21: every governed writer that creates a
 * company-owned record names it (`recordCreations`), so a recordCreated
 * workflow never misses a creation. This census fails closed: every source
 * file that inserts into a managed table, or into a table named at run time,
 * is listed with its insert count and either the number of those inserts that
 * record their creations or the reason its rows are not record creations. A
 * new insert reds here until it is classified.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const INSERT = /INSERT INTO\s+(?:north_star_module\.|\$\{)/gu;

interface Writer {
  readonly inserts: number;
  /** Inserts followed by `recordCreations` in the same function. */
  readonly records: number;
  /** Why the remaining inserts are not record creations, or are owed. */
  readonly reason?: string;
}

/**
 * SQL definer functions that insert into a table named at run time. Each type
 * they create has no create operation, so recordCreated admission refuses it.
 */
const SQL_INSERT = /'INSERT INTO (?:%s|north_star_module\.)/gu;
export const SQL_RECORD_WRITERS: Readonly<Record<string, Writer>> =
  Object.freeze({
    'db/migrations/0015_inventory_storage_foundation.sql': {
      inserts: 2,
      records: 0,
      reason:
        'Inventory projection rebuild and period-lock provisioning, superseded by 0033: no create operation.',
    },
    'db/migrations/0020_semantic_aggregate_anchors.sql': {
      inserts: 1,
      records: 0,
      reason: 'Aggregate anchor rows are platform bookkeeping, not records.',
    },
    'db/migrations/0033_definer_search_paths.sql': {
      inserts: 1,
      records: 0,
      reason:
        'provision_inventory_period_lock creates a company-owned lock row; the lock type has no create operation, so admission refuses it.',
    },
  });

export const RECORD_CREATION_WRITERS: Readonly<Record<string, Writer>> =
  Object.freeze({
    'packages/postgres-provider/src/module-runtime-interpreter.ts': {
      inserts: 1,
      records: 1,
    },
    'packages/postgres-provider/src/stock-count-route.ts': {
      inserts: 1,
      records: 1,
    },
    'packages/postgres-provider/src/module-storage-materializer.ts': {
      inserts: 3,
      records: 0,
      reason:
        'Seeds and projection rebuilds run outside a governed command; they write no trust event, so they cannot be an ADR-0073 source.',
    },
    'packages/postgres-provider/src/inventory-posting-service.ts': {
      inserts: 5,
      records: 2,
      reason:
        'Companion transactions and their lines record their creations. Movements have no create operation (admission refuses the type); fulfilment progress and balances are projections.',
    },
    'packages/postgres-provider/src/settlement-capability-executor.ts': {
      inserts: 1,
      records: 1,
    },
    'packages/postgres-provider/src/open-item-capability-executor.ts': {
      inserts: 1,
      records: 1,
    },
    'packages/postgres-provider/src/goods-receipt.ts': {
      inserts: 1,
      records: 0,
      reason: 'Receipt progress is a projection row, not a record.',
    },
    'packages/postgres-provider/src/purchase-order-approval-executor.ts': {
      inserts: 1,
      records: 1,
    },
    'packages/postgres-provider/src/fulfillment-lifecycle.ts': {
      inserts: 1,
      records: 0,
      reason: 'Reservation balances are projection rows, not records.',
    },
    'packages/postgres-provider/src/fulfillment-projections.ts': {
      inserts: 1,
      records: 0,
      reason: 'Fulfilment progress is a projection row, not a record.',
    },
    'packages/postgres-provider/src/received-quantity-projection.ts': {
      inserts: 1,
      records: 0,
      reason: 'Received quantities are projection rows, not records.',
    },
  });

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return name === 'node_modules' || name === 'dist' ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

test('every SQL insert into a run-time table is classified', () => {
  const found: Record<string, number> = {};
  for (const name of readdirSync('db/migrations')) {
    const path = `db/migrations/${name}`;
    const count = readFileSync(path, 'utf8').match(SQL_INSERT)?.length ?? 0;
    if (count) found[path] = count;
  }
  assert.deepEqual(
    found,
    Object.fromEntries(
      Object.entries(SQL_RECORD_WRITERS).map(([path, writer]) => [
        path,
        writer.inserts,
      ]),
    ),
    'a SQL insert into a run-time table was added: classify it in SQL_RECORD_WRITERS',
  );
});

test('every insert into a managed table records its creations or says why not', () => {
  const found: Record<string, number> = {};
  for (const path of sources('packages')) {
    const count = readFileSync(path, 'utf8').match(INSERT)?.length ?? 0;
    if (count) found[path.replaceAll('\\', '/')] = count;
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(found).sort()),
    Object.fromEntries(
      Object.entries(RECORD_CREATION_WRITERS)
        .map(([path, writer]) => [path, writer.inserts] as const)
        .sort(),
    ),
    'a managed-table insert was added or removed: classify it in RECORD_CREATION_WRITERS',
  );
  for (const [path, writer] of Object.entries(RECORD_CREATION_WRITERS)) {
    const calls =
      readFileSync(path, 'utf8').match(/await recordCreations\(/gu)?.length ??
      0;
    assert.equal(calls, writer.records, `${path} records its creations`);
    assert.ok(
      writer.records === writer.inserts || writer.reason,
      `${path} says why its other inserts record nothing`,
    );
  }
});
