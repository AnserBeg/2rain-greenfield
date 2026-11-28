/**
 * WORKFLOW-3 s1 B8 (ADR-0073 A1 recordTransitioned; orchestrator ruling Q3,
 * 2026-11-28). Only the generic transition writer names a move of a declared
 * state machine, so a `recordTransitioned` workflow is admitted only on a
 * machine no other writer moves. This census fails closed:
 *
 *  - every source file that UPDATEs a managed table is listed with its UPDATE
 *    count and either the machines it moves or why it moves none, so a new
 *    writer reds here until it is classified;
 *  - every machine a listed writer moves is refused by the compiler's own
 *    admission rule (`workflowTransitionTargets`) on the first-party release;
 *  - only the generic writer names transitions;
 *  - no compiled caller-writable input contract admits a machine state field,
 *    so the generic update writer cannot move a machine either.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { workflowTransitionTargets } from '../../packages/compiler/src/workflows.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';

const UPDATE = /UPDATE\s+(?:north_star_module\.|\$\{)/gu;
const SQL_UPDATE = /UPDATE\s+(?:north_star_module\.|%I|%s|%\d\$I)/gu;

interface StateWriter {
  readonly updates: number;
  /** Local names of the machines whose state column this file writes. */
  readonly machines?: readonly string[];
  /** The generic transition writer: it names each move it makes. */
  readonly names?: true;
  /**
   * Fills only NULL state cells with a newly declared machine's initial state,
   * outside any governed command: no transition runs, so no move is named
   * (orchestrator confirmation, 2026-11-28).
   */
  readonly initialStateBackfill?: true;
  /** Why its UPDATEs move no machine. */
  readonly reason?: string;
}

export const RECORD_STATE_WRITERS: Readonly<Record<string, StateWriter>> =
  Object.freeze({
    'packages/postgres-provider/src/module-runtime-interpreter.ts': {
      updates: 3,
      names: true,
      reason:
        'transitionRecordState is the generic transition writer and names each move (recordTransitions); updateRecord cannot reach a state field (its input contract excludes it, asserted below); archive and restore write the archive column.',
    },
    'packages/postgres-provider/src/purchasing-order-lifecycle.ts': {
      updates: 2,
      machines: ['purchase_order_lifecycle'],
      reason:
        'Close, reopen and cancel of a purchase order; the second UPDATE amends a line quantity.',
    },
    'packages/postgres-provider/src/purchase-order-approval-executor.ts': {
      updates: 1,
      machines: ['purchase_order_lifecycle'],
      reason: 'Release (draft to released) after an approval.',
    },
    'packages/postgres-provider/src/fulfillment-lifecycle.ts': {
      updates: 4,
      machines: ['sales_order_lifecycle'],
      reason:
        'Close and cancel of a sales order; the other three write reservation_state, a choice field.',
    },
    'packages/postgres-provider/src/settlement-capability-executor.ts': {
      updates: 1,
      // Families: receivables (order: sales_order), payables (order: purchase_order).
      machines: ['sales_order_lifecycle', 'purchase_order_lifecycle'],
      reason: 'Confirm (draft to released) and reopen (closed to released).',
    },
    'packages/postgres-provider/src/inventory-posting-service.ts': {
      updates: 6,
      reason:
        'Receipt, shipment, reservation, stock count and transaction state are choice fields, not machine state; the sales order machine is only read (assertReleasedSalesOrder).',
    },
    'packages/postgres-provider/src/stock-count-route.ts': {
      updates: 2,
      reason: 'Stock count state is a choice field; lines take counts.',
    },
    'packages/postgres-provider/src/open-item-capability-executor.ts': {
      updates: 1,
      reason:
        "Issue and settlement move an open item's own tenant-declared machine (draft to open, then partially settled or settled) with its figures. Open-item normalization refuses any active generic transition on that machine, so recordTransitioned admission (every transition generic) never admits it; no first-party release declares an open item, so no machine is listed (TRAIN-Z).",
    },
    'packages/postgres-provider/src/receiving-order-capability.ts': {
      updates: 1,
      reason: 'Archives a staged amendment proposal.',
    },
    'packages/postgres-provider/src/fulfillment-projections.ts': {
      updates: 1,
      reason: 'Archives a fulfilment progress projection row.',
    },
    'packages/postgres-provider/src/received-quantity-projection.ts': {
      updates: 1,
      reason: 'Archives a received-quantity projection row.',
    },
    'packages/postgres-provider/src/module-storage-materializer.ts': {
      updates: 2,
      initialStateBackfill: true,
      reason:
        'Storage backfill fills only NULL cells of a new column (a new machine starts at its initial state, which is no declared transition) and archives a balance projection row, outside any governed command.',
    },
  });

/** SQL definers that UPDATE a table named at run time: none today. */
export const SQL_STATE_WRITERS: Readonly<Record<string, StateWriter>> =
  Object.freeze({});

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return name === 'node_modules' || name === 'dist' ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

const authored = JSON.parse(
  readFileSync('apps/web/release/app.authored.json', 'utf8'),
) as Parameters<typeof workflowTransitionTargets>[0] & {
  readonly package: { readonly namespace: string };
  readonly stateMachines: readonly {
    readonly machineId: string;
    readonly entity: { readonly targetId: string };
    readonly stateField?: { readonly fieldId: string };
  }[];
};

test('every UPDATE of a managed table is classified by the machines it moves', () => {
  const found: Record<string, number> = {};
  for (const path of sources('packages')) {
    const count = readFileSync(path, 'utf8').match(UPDATE)?.length ?? 0;
    if (count) found[path.replaceAll('\\', '/')] = count;
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(found).sort()),
    Object.fromEntries(
      Object.entries(RECORD_STATE_WRITERS)
        .map(([path, writer]) => [path, writer.updates] as const)
        .sort(),
    ),
    'a managed-table UPDATE was added or removed: classify it in RECORD_STATE_WRITERS',
  );
  for (const [path, writer] of Object.entries(RECORD_STATE_WRITERS)) {
    assert.ok(writer.reason, `${path} says what its UPDATEs write`);
    // A file that names a machine state field and is not listed as moving
    // one must say why it only reads it.
    if (
      !writer.machines &&
      !writer.names &&
      readFileSync(path, 'utf8').includes('derived_state_field')
    )
      assert.match(
        writer.reason,
        /only read/u,
        `${path} names a machine state field: list the machines it moves`,
      );
  }
});

test('only the storage backfill may write an initial state without naming a move', () => {
  assert.deepEqual(
    Object.entries(RECORD_STATE_WRITERS)
      .filter(([, writer]) => writer.initialStateBackfill)
      .map(([path]) => path),
    ['packages/postgres-provider/src/module-storage-materializer.ts'],
    'exactly one writer is an allowed initial-state backfill',
  );
  const materializer = readFileSync(
    'packages/postgres-provider/src/module-storage-materializer.ts',
    'utf8',
  );
  assert.match(
    materializer,
    /AND \$\{quoted\(located\.column\.physicalName\)\} IS NULL/u,
    'the backfill fills only NULL cells, so it never changes a stored state',
  );
});

test('every SQL UPDATE of a run-time table is classified', () => {
  const found: Record<string, number> = {};
  for (const name of readdirSync('db/migrations')) {
    const path = `db/migrations/${name}`;
    const count = readFileSync(path, 'utf8').match(SQL_UPDATE)?.length ?? 0;
    if (count) found[path] = count;
  }
  assert.deepEqual(
    found,
    Object.fromEntries(
      Object.entries(SQL_STATE_WRITERS).map(([path, writer]) => [
        path,
        writer.updates,
      ]),
    ),
    'a SQL UPDATE of a run-time table was added: classify it in SQL_STATE_WRITERS',
  );
});

test('every machine another writer moves is refused by recordTransitioned admission', () => {
  const admissible = workflowTransitionTargets(authored);
  const moved = new Set(
    Object.values(RECORD_STATE_WRITERS).flatMap(
      (writer) => writer.machines ?? [],
    ),
  );
  assert.ok(moved.size > 0, 'the census lists the machines kernels move');
  for (const local of moved) {
    const machineId = `${authored.package.namespace}:machine.${local}`;
    const machine = authored.stateMachines.find(
      (candidate) => candidate.machineId === machineId,
    );
    assert.ok(machine, `${machineId} is declared by the first-party release`);
    assert.equal(
      admissible.has(machine.entity.targetId),
      false,
      `${machineId} is moved outside the generic writer but admission admits it`,
    );
  }
});

test('only the generic transition writer names a move', () => {
  const callers: Record<string, number> = {};
  for (const path of sources('packages')) {
    const count =
      readFileSync(path, 'utf8').match(/await recordTransitions\(/gu)?.length ??
      0;
    if (count) callers[path.replaceAll('\\', '/')] = count;
  }
  assert.deepEqual(
    callers,
    Object.fromEntries(
      Object.entries(RECORD_STATE_WRITERS)
        .filter(([, writer]) => writer.names)
        .map(([path]) => [path, 1]),
    ),
    'the generic transition writer names its moves, and nothing else does',
  );
});

test('no compiled caller-writable input contract admits a machine state field', () => {
  const compiled = parseCompiledApplication(
    JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
  ).application.compiled;
  const stateFields = new Set(
    authored.stateMachines.map(({ machineId }) =>
      machineId.replace(':', ':derived_state_field.'),
    ),
  );
  assert.ok(stateFields.size > 0, 'the first-party release declares machines');
  const reference = compiled.bundle.releaseManifest.projections.find(
    (projection) =>
      projection.familyId ===
      'northstar.compiler:projection-family.operation-catalog',
  );
  assert.ok(reference, 'the operation catalog projection is present');
  const decode = (hash: string) => {
    const artifact = compiled.bundle.artifacts.find(
      (candidate) => candidate.contentHash === hash,
    );
    assert.ok(artifact, `artifact ${hash} is present`);
    return JSON.parse(new TextDecoder().decode(artifact.canonicalBytes));
  };
  const manifest = decode(reference.artifactRoot) as {
    chunks: { contentHash: string }[];
  };
  const operations = manifest.chunks.flatMap(
    ({ contentHash }) =>
      (
        decode(contentHash) as {
          operations?: {
            operationId: string;
            inputContract?: { writableFieldIds?: readonly string[] };
          }[];
        }
      ).operations ?? [],
  );
  assert.ok(operations.length > 0, 'the catalog lists operations');
  for (const operation of operations)
    for (const fieldId of operation.inputContract?.writableFieldIds ?? [])
      assert.equal(
        stateFields.has(fieldId),
        false,
        `${operation.operationId} admits machine state ${fieldId} as caller input`,
      );
});
