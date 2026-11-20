import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import {
  composedDestinationIcon,
  composedDestinationLabel,
  composedDestinationPlacement,
} from '../../packages/domain/src/app/builder.js';
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
 * Stock documents (INVENTORY-PARITY) and stock counts (STOCK-COUNTS): each an
 * operational List of its own name, and the shared editor on the record and
 * form pages, entered with a company.
 */
const EDITED_DOCUMENTS: Readonly<Record<string, string>> = {
  inventory_transaction: 'Inventory transactions',
  stock_count: 'Stock counts',
};
/**
 * The stock documents List reads the documents a person records through its
 * own filtered query (STOCK-COUNTS, ADR-0049 condition 3).
 */
const LIST_QUERIES: Readonly<Record<string, string>> = {
  inventory_transaction_list: 'inventory_document_list',
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
};
/**
 * The stock count page (STOCK-COUNTS): its lines through the count read
 * model, the movements naming it, the counts superseding it, and its
 * Correct, Reverse and Open actions.
 */
const COUNT_PAGE = 'stock_count_detail';

function expectedInventoryWorkspace(namespace: string, surface: Value): Value {
  const surfaceId = String(surface.surfaceId);
  const local = surfaceId.split(':surface.')[1];
  assert.ok(local, `inventory surface must have a local ID: ${surfaceId}`);
  const document = local.replace(/_(list|detail|form)$/, '');
  const owner = LINE_OWNERS[document] ?? null;
  const list = surface.surfaceRole === 'list';
  // A destination's placement (LOOK-1 round 2): an occasional one is listed
  // under its group's Other; one may be listed in another module's group.
  const placement = list ? composedDestinationPlacement(local) : null;
  const edited = Object.hasOwn(EDITED_DOCUMENTS, document);
  const membership = list
    ? placement?.occasional
      ? 'setup'
      : document === 'posted_stock_balance' || edited
        ? 'operational'
        : owner
          ? 'contextual'
          : 'setup'
    : 'contextual';
  // A navigation destination's declared icon (LOOK-1).
  const icon =
    membership === 'contextual' ? undefined : composedDestinationIcon(local);
  return {
    membership,
    ...(placement?.navigationModuleId
      ? { navigationModuleId: placement.navigationModuleId }
      : {}),
    ...(icon ? { icon } : {}),
    ...(owner ? { ownerSurfaceId: `${namespace}:surface.${owner}_list` } : {}),
    ...(owner ||
    document === 'posted_stock_balance' ||
    edited ||
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

/** The two stock task presentations both invoke the existing governed Post once. */
function assertStockPostingActions(namespace: string, actions: unknown): void {
  const id = (kind: string, local: string) => `${namespace}:${kind}.${local}`;
  assert.ok(Array.isArray(actions));
  assert.deepEqual(
    actions.map((action: Value) => [
      action.actionId,
      action.label,
      action.inputs,
      action.datasetId ?? null,
      action.rows ?? null,
      action.conditions,
      (action.steps as Value[]).map((step) => [step.operation, step.bindings]),
    ]),
    ['adjustment', 'transfer'].map((type) => [
      id('action', `inventory_post_${type}`),
      'Post',
      [],
      null,
      null,
      [
        {
          value: {
            source: 'record',
            field: id('field', 'inventory_transaction_state'),
          },
          operator: 'equals',
          compare: id('option', 'inventory_transaction_state_draft'),
        },
        {
          value: {
            source: 'record',
            field: id('field', 'inventory_transaction_type'),
          },
          operator: 'equals',
          compare: id('option', `inventory_transaction_type_${type}`),
        },
      ],
      [
        [
          {
            kind: 'operationReference',
            schemaVersion: 'v6',
            targetId: id('operation', 'inventory_transaction_post'),
          },
          [
            {
              path: ['recordId'],
              value: { source: 'record', field: 'recordId' },
            },
            {
              path: ['expectedRevision'],
              value: { source: 'record', field: 'revision' },
            },
          ],
        ],
      ],
    ]),
    'stock task is one governed Post over the document and its revision',
  );
}

/**
 * A document composition adds only its own line datasets and rendering slots.
 * Stock documents may present the existing Post with its current document
 * revision; stock counts remain read-only. Every original slot binding stays.
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
  if (local === 'inventory_transaction_detail')
    assertStockPostingActions(namespace, composition.actions);
  else
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
  assertDocumentSlots(source, slots, local);
}

/** The two slots a document composition adds; key facts move last. */
function assertDocumentSlots(
  source: Value,
  slots: unknown,
  local = String(source.surfaceId).split(':surface.')[1] ?? '',
): void {
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
 * The stock count editor (STOCK-COUNTS), pinned the same way: its pages and
 * lines, editable while a draft or counting, the values its first save
 * writes, and the zeros each new line starts its figures at.
 */
function assertStockCountEditor(namespace: string, editor: unknown): void {
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
      id('surface', 'stock_count_form'),
      id('surface', 'stock_count_detail'),
      id('surface', 'stock_count_line_form'),
      id('query', 'stock_count_line_list'),
      id('relation', 'stock_count_line_session'),
      id('field', 'stock_count_state'),
      [
        id('option', 'stock_count_state_draft'),
        id('option', 'stock_count_state_counting'),
      ],
      id('field', 'stock_count_line_line_number'),
      'sequential',
    ],
    'the stock count editor edits counts and their lines',
  );
  assert.deepEqual(
    editor.createValues,
    [
      {
        fieldId: id('field', 'stock_count_state'),
        value: {
          source: 'literal',
          value: id('option', 'stock_count_state_draft'),
        },
      },
      {
        fieldId: id('field', 'stock_count_kind'),
        value: {
          source: 'literal',
          value: id('option', 'stock_count_kind_initial'),
        },
      },
      {
        fieldId: id('field', 'stock_count_counted_at'),
        value: { source: 'generated', value: 'instant' },
      },
    ],
    'a stock count is saved as an initial draft with a provisional instant',
  );
  assert.deepEqual(
    editor.lineCreateValues,
    ['expected_quantity', 'counted_quantity', 'variance_quantity'].map(
      (local) => ({
        fieldId: id('field', `stock_count_line_${local}`),
        value: { source: 'literal', value: '0' },
      }),
    ),
    'a new count line starts its figures at zero for review to replace',
  );
}

/** The stock count page's datasets and actions (STOCK-COUNTS). */
function assertCountComposition(namespace: string, composition: unknown): void {
  const id = (kind: string, local: string) => `${namespace}:${kind}.${local}`;
  record(composition);
  assert.equal(composition.kind, 'surfaceComposition');
  const children = composition.children as Value[];
  assert.deepEqual(
    children.map((child) => [
      (child.query as Value).targetId,
      child.parent
        ? [
            (child.parent as Value).relationId,
            (child.parent as Value).ownership,
          ]
        : (child.fieldScope as Value).fieldId,
    ]),
    [
      [
        id('query', 'stock_count_count_lines'),
        [id('relation', 'stock_count_line_session'), 'parentScopedChild'],
      ],
      [
        id('query', 'inventory_movement_list'),
        id('field', 'inventory_movement_source_id'),
      ],
      [
        id('query', 'stock_count_list'),
        [id('relation', 'stock_count_supersedes'), 'reference'],
      ],
    ],
    'the count page shows its lines, its movements and what supersedes it',
  );
  assert.deepEqual(
    (composition.actions as Value[]).map((action) => action.actionId),
    [
      'count_start',
      'count_review',
      'count_post',
      'count_reopen',
      'count_cancel_draft',
      'count_cancel_counting',
      'count_cancel_reviewed',
      'correct_count',
      'reverse_count',
      'open_compensation',
    ].map((local) => id('action', local)),
    'the count page offers its lifecycle and compensation actions',
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
    const document =
      Object.hasOwn(DOCUMENT_LINES, local) || local === COUNT_PAGE;
    const edited = local.replace(/_(list|detail|form)$/, '');
    const stockDocument = Object.hasOwn(EDITED_DOCUMENTS, edited);
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
      (edited === 'stock_count'
        ? assertStockCountEditor
        : assertStockDocumentEditor)(namespace, documentEditor);
    else
      assert.equal(
        documentEditor,
        undefined,
        `editor added to ${String(source.surfaceId)}`,
      );
    if (local === COUNT_PAGE) {
      assertCountComposition(namespace, composition);
      assertDocumentSlots(source, slots);
    } else if (document)
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
    // A destination's plain name (LOOK-1) is the composed label.
    const plainName = composedDestinationLabel(local);
    assert.deepEqual(
      protectedSurface,
      {
        ...protectedSource,
        ...(stockDocument && source.surfaceRole === 'list'
          ? { label: EDITED_DOCUMENTS[edited] }
          : plainName
            ? { label: plainName }
            : {}),
        ...(Object.hasOwn(LIST_QUERIES, local)
          ? {
              dataSource: {
                kind: 'queryReference',
                schemaVersion: 'v6',
                targetId: `${namespace}:query.${LIST_QUERIES[local]!}`,
              },
            }
          : {}),
      },
      `composition altered protected bindings for ${String(source.surfaceId)}`,
    );
    assert.deepEqual(
      workspace,
      expectedInventoryWorkspace(namespace, source),
      `composition added an unauthorized workspace for ${String(source.surfaceId)}`,
    );
  }
}
