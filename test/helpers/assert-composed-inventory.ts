import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import { declareLists } from '../../packages/domain/src/app/list-declarations.js';

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
/**
 * Stock documents (INVENTORY-PARITY): an operational List of its own name,
 * and the shared editor on the record and form pages, entered with a company.
 */
const STOCK_DOCUMENT = 'inventory_transaction';
const STOCK_DOCUMENT_LIST_LABEL = 'Inventory transactions';
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
    ? document === 'posted_stock_balance' || document === STOCK_DOCUMENT
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
    document === STOCK_DOCUMENT ||
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
 * The period lock page (WAREHOUSE-MODE): its own two operations as record
 * commands -- each binds the record, its revision and a UTC instant into
 * Closed through, and nothing else -- with the command bar, sections and child
 * tables slots that render them; every other slot keeps its binding.
 */
function assertPeriodLockComposition(
  namespace: string,
  source: Value,
  composition: unknown,
  slots: unknown,
): void {
  const id = (kind: string, local: string) => `${namespace}:${kind}.${local}`;
  record(composition);
  assert.equal(composition.kind, 'surfaceComposition');
  assert.deepEqual(composition.children, [], 'the period lock shows no rows');
  const closedThrough = id('field', 'inventory_period_lock_closed_through');
  assert.deepEqual(
    (composition.actions as Value[]).map((action) => [
      (
        (action.inputs as Value[]).map((input) => input.type) as unknown[]
      ).join(),
      (action.steps as Value[]).map((step) => [
        (step.operation as Value).targetId,
        (step.bindings as Value[]).map((binding) => [
          (binding.path as string[]).join('.'),
          (binding.value as Value).source,
        ]),
      ]),
    ]),
    ['advance_period_lock', 'reopen_period'].map((operation) => [
      'instant',
      [
        [
          id('operation', operation),
          [
            ['recordId', 'record'],
            ['expectedRevision', 'record'],
            [`patch.${closedThrough}`, 'input'],
          ],
        ],
      ],
    ]),
    'the period lock commands are its own two operations over Closed through',
  );
  const original = source.slots as Value[];
  const slotId = `${String(source.surfaceId).replace(':surface.', ':slot.')}`;
  const content = original[0]!.content;
  const slot = (name: string, suffix: string, orderKey: number) => ({
    kind: 'surfaceSlot',
    schemaVersion: 'v6',
    slot: name,
    slotId: `${slotId}_${suffix}`,
    orderKey,
    content,
  });
  assert.deepEqual(
    slots,
    [
      ...original.map((value) =>
        value.slot === 'keyFacts' ? { ...value, orderKey: 90 } : value,
      ),
      slot('sections', 'sections', 50),
      slot('commandBar', 'command_bar', 30),
      slot('childTables', 'children', 60),
    ],
    'the period lock composition may only add the slots that render it',
  );
}

/**
 * The stock document editor, pinned by what makes it this document's: its
 * pages, lines, draft state and the values its first save writes -- the draft
 * state, the document itself as its posting source, the save's time and the
 * saving person.
 */
function assertStockDocumentEditor(namespace: string, editor: unknown): void {
  const id = (kind: string, local: string) => `${namespace}:${kind}.${local}`;
  record(editor);
  assert.deepEqual(
    [
      editor.kind,
      editor.headerFormSurfaceId,
      editor.recordSurfaceId,
      editor.lineFormSurfaceId,
      editor.lineQueryId,
      editor.parentRelationId,
      editor.stateFieldId,
      editor.editableStateIds,
      editor.lineNumberFieldId,
      editor.saveMode,
    ],
    [
      'draftDocumentEditor',
      id('surface', 'inventory_transaction_form'),
      id('surface', 'inventory_transaction_detail'),
      id('surface', 'inventory_transaction_line_form'),
      id('query', 'inventory_transaction_line_list'),
      id('relation', 'inventory_transaction_line_transaction'),
      id('field', 'inventory_transaction_state'),
      [id('option', 'inventory_transaction_state_draft')],
      id('field', 'inventory_transaction_line_line_number'),
      'sequential',
    ],
    'the stock document editor edits inventory transactions and their lines',
  );
  assert.deepEqual(
    editor.createValues,
    [
      {
        fieldId: id('field', 'inventory_transaction_state'),
        value: {
          source: 'literal',
          value: id('option', 'inventory_transaction_state_draft'),
        },
      },
      {
        fieldId: id('field', 'inventory_transaction_source_type'),
        value: { source: 'literal', value: 'inventoryTransaction' },
      },
      {
        fieldId: id('field', 'inventory_transaction_source_id'),
        value: { source: 'record', field: 'recordId' },
      },
      {
        fieldId: id('field', 'inventory_transaction_recorded_at'),
        value: { source: 'generated', value: 'instant' },
      },
      {
        fieldId: id('field', 'inventory_transaction_actor_id'),
        value: { source: 'actor', field: 'principalId' },
      },
    ],
    'a stock document is saved as a draft naming itself as its source, with when and by whom',
  );
}

/**
 * Composition may add only the independently pinned workspace declaration to
 * inventory surfaces -- and to stock documents their editor, List name and
 * the editor's command bar placement. Identity/count and every original
 * binding stay exact.
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
    const stockDocument =
      local.replace(/_(list|detail|form)$/, '') === STOCK_DOCUMENT;
    const {
      workspace,
      composition,
      slots,
      documentEditor,
      ...protectedSurface
    } = candidate;
    // The one other addition the product makes to an inventory surface is its
    // declared List (SALES-PARITY), with the saved-views slot its views need.
    const declared = declareLists(namespace, [source])[0];
    record(declared);
    const { slots: sourceSlots, ...protectedSource } = declared;
    if (stockDocument && source.surfaceRole !== 'list')
      assertStockDocumentEditor(namespace, documentEditor);
    else
      assert.equal(
        documentEditor,
        undefined,
        `editor added to ${String(source.surfaceId)}`,
      );
    if (document)
      assertDocumentComposition(namespace, local, source, composition, slots);
    else if (local === 'inventory_period_lock_detail')
      assertPeriodLockComposition(namespace, source, composition, slots);
    else {
      assert.equal(
        composition,
        undefined,
        `composition added to ${String(source.surfaceId)}`,
      );
      // The editor's form places its command bar after the lines.
      assert.deepEqual(
        slots,
        stockDocument && source.surfaceRole === 'form'
          ? (sourceSlots as Value[]).map((slot) =>
              slot.slot === 'commandBar' ? { ...slot, orderKey: 90 } : slot,
            )
          : sourceSlots,
        `composition altered protected slots for ${String(source.surfaceId)}`,
      );
    }
    assert.deepEqual(
      protectedSurface,
      stockDocument && source.surfaceRole === 'list'
        ? { ...protectedSource, label: STOCK_DOCUMENT_LIST_LABEL }
        : protectedSource,
      `composition altered protected bindings for ${String(source.surfaceId)}`,
    );
    assert.deepEqual(
      workspace,
      expectedInventoryWorkspace(namespace, source),
      `composition added an unauthorized workspace for ${String(source.surfaceId)}`,
    );
  }
}
