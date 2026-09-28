import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

type Value = Readonly<Record<string, unknown>>;

function record(value: unknown): asserts value is Value {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
}

/** Inventory List queries scoped to exactly one company (independently pinned). */
const COMPANY_SCOPED = new Set([
  'inventory_movement',
  'inventory_period_lock',
  'posted_stock_balance',
  'inventory_transaction',
  'inventory_transaction_line',
  'stock_count',
  'stock_count_line',
]);
/** Line tables shown inside the document that owns them. */
const LINE_OWNERS: Readonly<Record<string, string>> = {
  inventory_transaction_line: 'inventory_transaction',
  stock_count_line: 'stock_count',
};
/** Read-only document compositions: their line datasets, by parent relation. */
const DOCUMENT_LINES: Readonly<Record<string, readonly [string, string][]>> = {
  inventory_transaction_detail: [
    [
      'inventory_transaction_line_list',
      'inventory_transaction_line_transaction',
    ],
    ['inventory_movement_list', 'inventory_movement_transaction'],
  ],
  stock_count_detail: [['stock_count_line_list', 'stock_count_line_session']],
};

function expectedInventoryWorkspace(namespace: string, surface: Value): Value {
  const surfaceId = String(surface.surfaceId);
  const local = surfaceId.split(':surface.')[1];
  assert.ok(local, `inventory surface must have a local ID: ${surfaceId}`);
  const document = local.replace(/_(list|detail|form)$/, '');
  const owner = LINE_OWNERS[document] ?? null;
  const list = surface.surfaceRole === 'list';
  const membership = list
    ? document === 'posted_stock_balance'
      ? 'operational'
      : owner
        ? 'contextual'
        : 'setup'
    : 'contextual';
  return {
    membership,
    ...(owner ? { ownerSurfaceId: `${namespace}:surface.${owner}_list` } : {}),
    ...(owner ||
    document === 'posted_stock_balance' ||
    (list && COMPANY_SCOPED.has(document))
      ? {
          entry: {
            companyQueryId: `${namespace}:query.legal_entity_list`,
            companyNameFieldId: `${namespace}:field.legal_entity_name`,
            companyStateFieldId: `${namespace}:field.legal_entity_status`,
            activeStateId: `${namespace}:option.legal_entity_status_active`,
            policy: 'authorizedSingleOrPreference',
            authorizationQueryId: `${namespace}:query.${owner ?? document}_list`,
          },
        }
      : {}),
  };
}

/**
 * A read-only document composition may add exactly its line datasets, scoped
 * by their declared parent relations, with no action, and the two slots that
 * render it; every other slot keeps its binding (key facts move last).
 */
function assertDocumentComposition(
  namespace: string,
  local: string,
  source: Value,
  composition: unknown,
  slots: unknown,
): void {
  const lines = DOCUMENT_LINES[local]!;
  record(composition);
  assert.equal(composition.kind, 'surfaceComposition');
  assert.deepEqual(
    composition.actions,
    [],
    `${local} composition declares no action`,
  );
  const children = composition.children as Value[];
  assert.deepEqual(
    children.map((child) => [
      (child.query as Value).targetId,
      (child.parent as Value).relationId,
      (child.parent as Value).ownership,
      ((child.parent as Value).value as Value).source,
    ]),
    lines.map(([query, relation]) => [
      `${namespace}:query.${query}`,
      `${namespace}:relation.${relation}`,
      'parentScopedChild',
      'record',
    ]),
    `${local} composition may only show its own lines`,
  );
  const original = source.slots as Value[];
  const slotId = `${String(source.surfaceId).replace(':surface.', ':slot.')}`;
  const content = original[0]!.content;
  assert.deepEqual(
    slots,
    [
      ...original.map((slot) =>
        slot.slot === 'keyFacts' ? { ...slot, orderKey: 90 } : slot,
      ),
      ...(original.some((slot) => slot.slot === 'sections')
        ? []
        : [
            {
              kind: 'surfaceSlot',
              schemaVersion: 'v6',
              slot: 'sections',
              slotId: `${slotId}_sections`,
              orderKey: 50,
              content,
            },
          ]),
      {
        kind: 'surfaceSlot',
        schemaVersion: 'v6',
        slot: 'childTables',
        slotId: `${slotId}_children`,
        orderKey: 60,
        content,
      },
    ],
    `${local} composition may only add the slots that render it`,
  );
}

/**
 * Composition may add only the independently pinned workspace declaration to
 * inventory surfaces. Identity/count and every original binding stay exact.
 */
export function assertComposedInventoryCollection(
  collection: string,
  composed: readonly unknown[],
  inventory: readonly unknown[],
  namespace: string,
): void {
  for (const source of inventory) {
    if (collection !== 'surfaces') {
      assert.equal(
        composed.filter((candidate) => isDeepStrictEqual(candidate, source))
          .length,
        1,
        `composed application must contain each inventory ${collection} entry exactly once`,
      );
      continue;
    }
    record(source);
    assert.equal(typeof source.surfaceId, 'string');
    const matches = composed.filter(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        (candidate as Value).surfaceId === source.surfaceId,
    );
    assert.equal(
      matches.length,
      1,
      `composed application must contain inventory surface ${String(source.surfaceId)} exactly once`,
    );
    const candidate = matches[0];
    record(candidate);
    const local = String(source.surfaceId).split(':surface.')[1] ?? '';
    const document = Object.hasOwn(DOCUMENT_LINES, local);
    const { workspace, composition, slots, ...protectedSurface } = candidate;
    const { slots: sourceSlots, ...protectedSource } = source;
    if (document)
      assertDocumentComposition(namespace, local, source, composition, slots);
    else {
      assert.equal(
        composition,
        undefined,
        `composition added to ${String(source.surfaceId)}`,
      );
      assert.deepEqual(
        slots,
        sourceSlots,
        `composition altered protected slots for ${String(source.surfaceId)}`,
      );
    }
    assert.deepEqual(
      protectedSurface,
      protectedSource,
      `composition altered protected bindings for ${String(source.surfaceId)}`,
    );
    assert.deepEqual(
      workspace,
      expectedInventoryWorkspace(namespace, source),
      `composition added an unauthorized workspace for ${String(source.surfaceId)}`,
    );
  }
}
