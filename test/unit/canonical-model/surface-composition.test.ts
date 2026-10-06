import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalModelError,
  normalizeApplicationPackage,
  SurfaceCompositionSchema,
} from '../../../packages/canonical-model/src/index.js';
import { validateSurfaceCompositions } from '../../../packages/canonical-model/src/surface-composition.js';
import { composedApplicationDefinition } from '../../../packages/domain/src/app/builder.js';

// ORDER-PARITY increment B: record alerts and progression, multi-row Tasks
// (`rows`, `perRow`, `each`) and record columns and links naming a relation of
// their record. The composed application is normalized once; each refusal
// mutates a copy of one composition and asks the composition validator alone,
// so every rule is judged by name without normalizing the application again.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ns = 'northstar.app';
const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
const normalized = normalizeApplicationPackage(
  composedApplicationDefinition() as never,
) as unknown as Json;

function composition(model: Json, surface: string): Json {
  const found = (model.surfaces as Json[]).find(
    (value) => value.surfaceId === id('surface', surface),
  );
  assert.ok(found?.composition, surface);
  return found.composition as Json;
}
function action(value: Json, local: string): Json {
  const found = (value.actions as Json[]).find(
    (candidate) => candidate.actionId === id('action', local),
  );
  assert.ok(found, local);
  return found;
}
/** The validator's named refusal of one mutated copy of the application. */
function refused(surface: string, mutate: (value: Json, model: Json) => void) {
  const model = structuredClone(normalized);
  mutate(composition(model, surface), model);
  try {
    validateSurfaceCompositions(model as never);
  } catch (error) {
    assert.ok(error instanceof CanonicalModelError, String(error));
    return error.diagnostics.map((diagnostic) => diagnostic.rule).join(' ');
  }
  assert.fail('the declaration was accepted');
}
/**
 * COMPOSITION-BOUNDS-RAISE (ADR-0070, owner ruling 2026-10-05, "raise it"): the
 * composition bounds raised for parity, as literals so a silent move reds here.
 * Measured need on 2026-10-05 across INTEGRATION and its pending leaves: 34
 * page fields and 16 page actions (over 30 and 12), 11 steps in one Task (over
 * 5), and 8 of 8 datasets, 6 of 6 header facts, 12 of 12 List columns used.
 */
const COMPOSITION_BOUNDS = Object.freeze({
  actions: 24,
  children: 12,
  facts: 8,
  fields: 48,
  listColumns: 16,
  steps: 12,
});
/** Appends copies of existing members, each with a fresh id, until `count`. */
function padMembers(
  members: Json[],
  count: number,
  idKey: string,
  eligible: (member: Json) => boolean = () => true,
): void {
  const sources = members.filter(eligible);
  for (let index = 0; members.length < count; index += 1) {
    const copy = structuredClone(sources[index % sources.length]!);
    copy[idKey] = String(copy[idKey]).replace(/([^.]*)$/u, `pad${index}_$1`);
    if ('orderKey' in copy) copy.orderKey = 9_000 + index;
    members.push(copy);
  }
}

const condition = (
  value: Json,
  operator = 'equals',
  compare: unknown = 'x',
) => ({
  value,
  operator,
  compare,
});
const record = (field: string) => ({ source: 'record', field });
const selected = (field: string, datasetId?: string) => ({
  source: 'selected',
  field,
  ...(datasetId ? { datasetId } : {}),
});

test('APPROVAL-PO arguments are scalar capability members, never a generic record mutation or nested object', () => {
  const purchase = composition(normalized, 'purchase_order_detail');
  const place = action(purchase, 'place_order');
  assert.ok(
    (place.steps[0].bindings as Json[]).some(
      (binding) => binding.path.join('.') === 'arguments.supplierReference',
    ),
  );
  validateSurfaceCompositions(structuredClone(normalized) as never);
  for (const path of [
    ['arguments'],
    ['arguments', 'supplierReference', 'nested'],
  ])
    assert.match(
      refused('purchase_order_detail', (value) => {
        const step = action(value, 'place_order').steps[0];
        (step.bindings as Json[]).find(
          (binding) => binding.path[0] === 'arguments',
        )!.path = path;
      }),
      /capability arguments require a registered effect and one scalar member/u,
    );
  assert.match(
    refused('purchase_order_detail', (value) => {
      action(value, 'place_order').steps[0].operation.targetId = id(
        'operation',
        'purchase_order_update',
      );
    }),
    /capability arguments require a registered effect and one scalar member/u,
  );
});

// Was "stays inside the existing twelve-action composition bound" and pinned
// 13 actions as refused. COMPOSITION-BOUNDS-RAISE (ADR-0070, owner ruling
// 2026-10-05) moves that bound to 24, because the parity leaves together put 16
// actions on this page; the exact edge is pinned by the boundary test below.
test('APPROVAL-PO stays inside the composition action bound', () => {
  const purchase = composition(normalized, 'purchase_order_detail');
  assert.ok(purchase.actions.length <= COMPOSITION_BOUNDS.actions);
  assert.equal(SurfaceCompositionSchema.safeParse(purchase).success, true);
  const padded = structuredClone(purchase);
  padMembers(padded.actions, COMPOSITION_BOUNDS.actions + 1, 'actionId');
  assert.equal(SurfaceCompositionSchema.safeParse(padded).success, false);
});

test('the composed pages declare alerts, progression, multi-row Tasks and a related order, and validate', () => {
  validateSurfaceCompositions(structuredClone(normalized) as never);
  const sales = composition(normalized, 'sales_order_detail');
  assert.deepEqual(
    (sales.presentation.alerts as Json[]).map((alert) => [
      alert.label,
      alert.datasetId,
      alert.columnId,
    ]),
    [
      [
        'Fulfillment exception',
        id('dataset', 'fulfillment_lines'),
        id('column', 'short'),
      ],
    ],
  );
  assert.deepEqual(
    (sales.presentation.progression.steps as Json[]).map((step) => step.label),
    ['Sales order', 'Fulfillment', 'Invoicing', 'Closed'],
  );
  const purchase = composition(normalized, 'purchase_order_detail');
  assert.deepEqual(
    (purchase.presentation.progression.steps as Json[]).map(
      (step) => step.label,
    ),
    // PAYABLES: billing follows receiving, needing attention while anything
    // received is not yet billed.
    ['Draft', 'Released', 'Receiving', 'Billing', 'Closed'],
  );
  assert.deepEqual(purchase.presentation.progression.next, [
    { action: id('action', 'submit_approval') },
    { action: id('action', 'place_order') },
    { action: id('action', 'receive_lines_known') },
    { action: id('action', 'bill_received') },
    {
      operation: {
        kind: 'operationReference',
        schemaVersion: 'v6',
        targetId: id('operation', 'purchase_order_close'),
      },
    },
  ]);
  // One receipt, a line per row given a quantity, then the post.
  const truck = action(purchase, 'receive_lines_known');
  assert.equal(truck.rows.datasetId, id('dataset', 'purchasing_lines'));
  assert.equal(truck.rows.fillLabel, 'Fill open quantities');
  assert.deepEqual(
    (truck.steps as Json[]).map((step) => [
      step.operation.targetId,
      step.each ?? false,
    ]),
    [
      [id('operation', 'goods_receipt_create'), false],
      [id('operation', 'goods_receipt_line_create'), true],
      [id('operation', 'goods_receipt_post'), false],
    ],
  );
  assert.deepEqual(
    (truck.inputs as Json[])
      .filter((input) => input.perRow)
      .map((input) => input.inputId),
    [
      id('input', 'receive_lines_quantity'),
      id('input', 'receive_lines_unit'),
      id('input', 'receive_lines_cost'),
    ],
  );
  const reverse = action(purchase, 'reverse_receipt');
  assert.equal(reverse.datasetId, id('dataset', 'purchasing_receipts'));
  assert.equal(
    reverse.rows.datasetId,
    id('dataset', 'purchasing_receipt_lines'),
  );
  const invoice = composition(normalized, 'customer_invoice_detail');
  assert.equal(
    (invoice.fields as Json[]).find(
      (column) => column.columnId === id('column', 'invoice_order'),
    )?.field,
    id('relation', 'customer_invoice_order'),
  );
  assert.deepEqual(action(invoice, 'invoice_open_order').navigate.record, {
    source: 'record',
    field: id('relation', 'customer_invoice_order'),
  });
});

test('an alert reads a stated column of a declared dataset and names its rows by a primary column', () => {
  const alert = (value: Json) => value.presentation.alerts[0] as Json;
  assert.match(
    refused('sales_order_detail', (value) => {
      alert(value).datasetId = id('dataset', 'missing');
    }),
    /an alert reads a stated column of a declared dataset/u,
  );
  assert.match(
    refused('sales_order_detail', (value) => {
      alert(value).columnId = id('column', 'missing');
    }),
    /an alert reads a stated column of a declared dataset/u,
  );
  // The item column is a label read through the item's get, not a figure.
  assert.match(
    refused('sales_order_detail', (value) => {
      alert(value).columnId = id('column', 'item');
    }),
    /an alert reads a stated column of a declared dataset/u,
  );
  // Shipments declare no column hierarchy, so no row can be named.
  assert.match(
    refused('sales_order_detail', (value) => {
      Object.assign(alert(value), {
        datasetId: id('dataset', 'order_shipments'),
        columnId: id('column', 'shipment'),
      });
    }),
    /an alert names its rows by a primary column/u,
  );
  assert.match(
    refused('sales_order_detail', (value) => {
      value.presentation.alerts.push({ ...alert(value), label: 'Again' });
    }),
    /composition identities must be unique/u,
  );
  // At most three banners; unknown keys fail the closed schema.
  const sales = composition(normalized, 'sales_order_detail');
  const parsed = (mutate: (value: Json) => void) => {
    const value = structuredClone(sales);
    mutate(value);
    return SurfaceCompositionSchema.safeParse(value).success;
  };
  assert.equal(
    parsed(() => {}),
    true,
  );
  assert.equal(
    parsed((value) => {
      value.presentation.alerts = Array.from({ length: 4 }, () => alert(value));
    }),
    false,
  );
  assert.equal(
    parsed((value) => {
      alert(value).when = [];
    }),
    false,
  );
});

test('a progression reads the record, lists declared documents and offers record tasks or operations on this record', () => {
  const step = (value: Json, index: number) =>
    value.presentation.progression.steps[index] as Json;
  assert.match(
    refused('sales_order_detail', (value) => {
      Object.assign(step(value, 3), { current: [], complete: [] });
    }),
    /a progression step declares when it is current or complete/u,
  );
  for (const read of [
    selected(id('field', 'sales_order_line_item_id')),
    record(id('field', 'missing')),
    { source: 'literal', value: 'x' },
  ])
    assert.match(
      refused('sales_order_detail', (value) => {
        step(value, 0).current = [condition(read)];
      }),
      /progression conditions read record values/u,
      JSON.stringify(read),
    );
  assert.match(
    refused('sales_order_detail', (value) => {
      step(value, 1).stopped = [condition(selected('recordId'))];
    }),
    /progression conditions read record values/u,
  );
  assert.match(
    refused('sales_order_detail', (value) => {
      step(value, 1).documents = id('dataset', 'missing');
    }),
    /progression documents are a declared dataset/u,
  );
  assert.match(
    refused('sales_order_detail', (value) => {
      step(value, 2).label = step(value, 1).label;
    }),
    /composition identities must be unique/u,
  );
  // Reserving is a line's Task, not the record's.
  for (const next of [
    { action: id('action', 'reserve_stock') },
    { action: id('action', 'missing') },
  ])
    assert.match(
      refused('sales_order_detail', (value) => {
        value.presentation.progression.next = [next];
      }),
      /a next action is a record task of this composition/u,
    );
  // Posting a receipt acts on a receipt, not on this order.
  assert.match(
    refused('sales_order_detail', (value) => {
      value.presentation.progression.next = [
        {
          operation: {
            kind: 'operationReference',
            schemaVersion: 'v6',
            targetId: id('operation', 'goods_receipt_post'),
          },
        },
      ];
    }),
    /a next operation acts on the record this page shows/u,
  );
  assert.match(
    refused('sales_order_detail', (value) => {
      const [first] = value.presentation.progression.next as Json[];
      value.presentation.progression.next = [first, first];
    }),
    /composition identities must be unique/u,
  );
  const sales = composition(normalized, 'sales_order_detail');
  const parsed = (mutate: (value: Json) => void) => {
    const value = structuredClone(sales);
    mutate(value);
    return SurfaceCompositionSchema.safeParse(value).success;
  };
  // Two to eight steps, at most six next entries, a closed step shape.
  assert.equal(
    parsed((value) => {
      value.presentation.progression.steps.splice(1);
    }),
    false,
  );
  assert.equal(
    parsed((value) => {
      value.presentation.progression.steps = Array.from({ length: 9 }, () =>
        step(value, 0),
      );
    }),
    false,
  );
  assert.equal(
    parsed((value) => {
      value.presentation.progression.next = Array.from({ length: 7 }, () => ({
        action: id('action', 'invoice_shipped'),
      }));
    }),
    false,
  );
  assert.equal(
    parsed((value) => {
      step(value, 0).summary = 'Draft';
    }),
    false,
  );
  assert.equal(
    parsed((value) => {
      step(value, 0).stopped = [];
    }),
    false,
  );
});

test('a multi-row Task declares its rows, reads each row only in a per-row step and fills only from its rows', () => {
  const truck = (value: Json) => action(value, 'receive_lines_known');
  const reverse = (value: Json) => action(value, 'reverse_receipt');
  const perRow = (value: Json, local: string) =>
    (truck(value).inputs as Json[]).find(
      (input) => input.inputId === id('input', `receive_lines_${local}`),
    )!;
  // Without rows, neither per-row steps nor per-row inputs mean anything.
  assert.match(
    refused('purchase_order_detail', (value) => {
      delete truck(value).rows;
    }),
    /per-row inputs require declared task rows/u,
  );
  assert.match(
    refused('purchase_order_detail', (value) => {
      delete reverse(value).rows;
    }),
    /per-row steps require declared task rows/u,
  );
  assert.match(
    refused('purchase_order_detail', (value) => {
      for (const step of truck(value).steps as Json[]) delete step.each;
    }),
    /task rows require a per-row step|a per-row input is bound only in a per-row step/u,
  );
  // A row's quantity is bound where the rows run, never in the header.
  const notes = (value: Json) =>
    ((truck(value).steps as Json[])[0]!.bindings as Json[]).find(
      (binding) => binding.path[1] === id('field', 'goods_receipt_notes'),
    )!;
  assert.match(
    refused('purchase_order_detail', (value) => {
      notes(value).value = {
        source: 'input',
        inputId: id('input', 'receive_lines_quantity'),
      };
    }),
    /a per-row input is bound only in a per-row step/u,
  );
  assert.match(
    refused('purchase_order_detail', (value) => {
      notes(value).value = selected(
        id('field', 'purchase_order_line_line_number'),
        id('dataset', 'purchasing_lines'),
      );
    }),
    /a task row is read only in a per-row step/u,
  );
  // The post reads the header's read-back; a row's read-back is its own.
  assert.match(
    refused('purchase_order_detail', (value) => {
      const steps = truck(value).steps as Json[];
      const post = steps[2]!;
      (post.bindings as Json[])[0]!.value = {
        source: 'step',
        stepId: steps[1]!.stepId,
        field: 'recordId',
      };
    }),
    /no step reads the read-back of a per-row step/u,
  );
  for (const datasetId of [
    // The receipt the reversal is started from is its selection, not rows.
    id('dataset', 'purchasing_receipts'),
    id('dataset', 'missing'),
  ])
    assert.match(
      refused('purchase_order_detail', (value) => {
        reverse(value).rows.datasetId = datasetId;
      }),
      /task rows are a dataset of the record or of the selected row/u,
      datasetId,
    );
  // A receipt's lines belong to a selected receipt this record Task lacks.
  assert.match(
    refused('purchase_order_detail', (value) => {
      truck(value).rows.datasetId = id('dataset', 'purchasing_receipt_lines');
    }),
    /task rows are a dataset of the record or of the selected row|a per-row input fills from a column of its row|derived inputs require/u,
  );
  assert.match(
    refused('purchase_order_detail', (value) => {
      truck(value).rows.conditions = [
        condition(selected('recordId', id('dataset', 'purchasing_receipts'))),
      ];
    }),
    /row conditions read the row or the record/u,
  );
  assert.match(
    refused('purchase_order_detail', (value) => {
      Object.assign(perRow(value, 'cost'), {
        type: 'reference',
        query: {
          kind: 'queryReference',
          schemaVersion: 'v6',
          targetId: id('query', 'location_list'),
        },
        labelField: {
          kind: 'fieldReference',
          schemaVersion: 'v6',
          targetId: id('field', 'location_name'),
        },
      });
    }),
    /per-row inputs are typed quantities or text, or derived from their row/u,
  );
  assert.match(
    refused('purchase_order_detail', (value) => {
      perRow(value, 'cost').presentation = { kind: 'multiline' };
    }),
    /per-row inputs are typed quantities or text, or derived from their row/u,
  );
  assert.match(
    refused('purchase_order_detail', (value) => {
      perRow(value, 'quantity').perRow.fillFrom = {
        datasetId: id('dataset', 'purchasing_priced_lines'),
        columnId: id('column', 'purchasing_priced_quantity'),
      };
    }),
    /a per-row input fills from a column of its row/u,
  );
  assert.match(
    refused('purchase_order_detail', (value) => {
      delete truck(value).rows.fillLabel;
    }),
    /a fill control is labelled exactly when a per-row input fills/u,
  );
  assert.match(
    refused('purchase_order_detail', (value) => {
      reverse(value).rows.fillLabel = 'Fill';
    }),
    /a fill control is labelled exactly when a per-row input fills/u,
  );
  assert.match(
    refused('purchase_order_detail', (value) => {
      perRow(value, 'unit').presentation.column = {
        datasetId: id('dataset', 'purchasing_priced_lines'),
        columnId: id('column', 'purchasing_priced_item'),
      };
    }),
    /derived inputs require a column of the selected dataset or its parent context/u,
  );
  // A multi-row Task reviews its rows, not one selected line's summary.
  assert.match(
    refused('purchase_order_detail', (value) => {
      const receive = action(value, 'receive_known');
      reverse(value).presentation = {
        placement: 'selection',
        task: {
          ...structuredClone(receive.presentation?.task ?? {}),
          summary: {
            identity: {
              datasetId: id('dataset', 'purchasing_receipts'),
              columnId: id('column', 'purchasing_receipt'),
            },
          },
          confirmation: {
            title: 'Reverse',
            reviewLabel: 'Review',
            confirmLabel: 'Confirm',
            quantity: {
              source: 'column',
              datasetId: id('dataset', 'purchasing_receipt_lines'),
              columnId: id('column', 'purchasing_receipt_quantity'),
            },
            unit: {
              datasetId: id('dataset', 'purchasing_receipt_lines'),
              columnId: id('column', 'purchasing_receipt_unit'),
            },
          },
        },
      };
    }),
    /a multi-row task has no single-row summary/u,
  );
  const purchase = composition(normalized, 'purchase_order_detail');
  const parsed = (mutate: (value: Json) => void) => {
    const value = structuredClone(purchase);
    mutate(value);
    return SurfaceCompositionSchema.safeParse(value).success;
  };
  // `each` is true or absent; at most four row conditions; closed shapes.
  assert.equal(
    parsed((value) => {
      (truck(value).steps as Json[])[1]!.each = false;
    }),
    false,
  );
  assert.equal(
    parsed((value) => {
      truck(value).rows.conditions = Array.from({ length: 5 }, () =>
        condition(record('recordId')),
      );
    }),
    false,
  );
  assert.equal(
    parsed((value) => {
      perRow(value, 'quantity').perRow.label = 'Quantity';
    }),
    false,
  );
});

test('a record names a relation of its own entity only through the related get, and opens only a page of that record', () => {
  const orderColumn = (value: Json) =>
    (value.fields as Json[]).find(
      (column) => column.columnId === id('column', 'invoice_order'),
    )!;
  assert.match(
    refused('customer_invoice_detail', (value) => {
      delete orderColumn(value).reference;
    }),
    /a related record column reads its label through the related get/u,
  );
  // The party's get does not read a sales order.
  assert.match(
    refused('customer_invoice_detail', (value) => {
      orderColumn(value).reference.query.targetId = id('query', 'party_get');
      orderColumn(value).reference.labelField.targetId = id(
        'field',
        'party_name',
      );
    }),
    /a related record column reads its label through the related get/u,
  );
  // A relation the invoice does not own is no value of this record.
  assert.match(
    refused('customer_invoice_detail', (value) => {
      orderColumn(value).field = id('relation', 'sales_order_line_order');
    }),
    /column is not a declared query result/u,
  );
  // A related order opens the order's own page, never another entity's.
  assert.match(
    refused('customer_invoice_detail', (value) => {
      const open = action(value, 'invoice_open_order');
      open.navigate.surface.targetId = id('surface', 'party_detail');
      open.navigate.query.targetId = (
        (normalized.surfaces as Json[]).find(
          (surface) => surface.surfaceId === id('surface', 'party_detail'),
        )!.dataSource as Json
      ).targetId;
    }),
    /navigation to a related record opens a page of that record/u,
  );
  // One get states at most four related records.
  assert.match(
    refused('customer_invoice_detail', (value, model) => {
      const invoice = id('entity', 'customer_invoice');
      const order = id('entity', 'sales_order');
      const template = (model.relations as Json[]).find(
        (relation) =>
          relation.relationId === id('relation', 'customer_invoice_order'),
      )!;
      for (let index = 1; index <= 4; index++) {
        const relationId = id('relation', `customer_invoice_extra_${index}`);
        (model.relations as Json[]).push({
          ...structuredClone(template),
          relationId,
          sourceEntity: { ...template.sourceEntity, targetId: invoice },
          targetEntity: { ...template.targetEntity, targetId: order },
        });
        (value.fields as Json[]).push({
          ...structuredClone(orderColumn(value)),
          columnId: id('column', `invoice_extra_${index}`),
          field: relationId,
        });
      }
    }),
    /a record names at most four related records/u,
  );
});

test('the parity composition bounds admit exactly their maximum and refuse one more', () => {
  const authored = composedApplicationDefinition() as unknown as Json;
  const surfaceOf = (model: Json, local: string): Json => {
    const found = (model.surfaces as Json[]).find(
      (value) => value.surfaceId === id('surface', local),
    );
    assert.ok(found, local);
    return found;
  };
  const header = (value: Json): Json => value.presentation.header as Json;
  const at = (local: string): string =>
    `$.surfaces[${(authored.surfaces as Json[]).findIndex(
      (value) => value.surfaceId === id('surface', local),
    )}]`;
  const reserveStep = (
    surfaceOf(authored, 'sales_order_detail').composition.actions as Json[]
  ).findIndex((value) => value.actionId === id('action', 'reserve_stock'));
  const cases: Array<{
    bound: number;
    fill: (model: Json, count: number) => void;
    name: string;
    path: string;
    surface: string;
  }> = [
    {
      bound: COMPOSITION_BOUNDS.fields,
      fill: (model, count) =>
        padMembers(
          surfaceOf(model, 'sales_order_detail').composition.fields,
          count,
          'columnId',
        ),
      name: 'record page fields',
      path: `${at('sales_order_detail')}.composition.fields`,
      surface: 'sales_order_detail',
    },
    {
      bound: COMPOSITION_BOUNDS.actions,
      fill: (model, count) =>
        padMembers(
          surfaceOf(model, 'purchase_order_detail').composition.actions,
          count,
          'actionId',
        ),
      name: 'record page actions',
      path: `${at('purchase_order_detail')}.composition.actions`,
      surface: 'purchase_order_detail',
    },
    {
      bound: COMPOSITION_BOUNDS.children,
      fill: (model, count) =>
        padMembers(
          surfaceOf(model, 'sales_order_detail').composition.children,
          count,
          'datasetId',
        ),
      name: 'record page datasets',
      path: `${at('sales_order_detail')}.composition.children`,
      surface: 'sales_order_detail',
    },
    {
      bound: COMPOSITION_BOUNDS.steps,
      fill: (model, count) =>
        padMembers(
          action(
            surfaceOf(model, 'sales_order_detail').composition,
            'reserve_stock',
          ).steps,
          count,
          'stepId',
        ),
      name: 'Task steps',
      path: `${at('sales_order_detail')}.composition.actions[${reserveStep}].steps`,
      surface: 'sales_order_detail',
    },
    {
      bound: COMPOSITION_BOUNDS.facts,
      fill: (model, count) => {
        const page = surfaceOf(model, 'sales_order_detail').composition;
        const shown = header(page);
        const used = new Set([
          shown.title,
          shown.status,
          ...shown.subtitle,
          ...shown.facts,
          ...((page.presentation.blocks ?? []) as Json[]).flatMap(
            (block) => block.columns as string[],
          ),
        ]);
        const free = (page.fields as Json[])
          .map((field) => field.columnId as string)
          .filter((columnId) => !used.has(columnId));
        while (shown.facts.length < count) shown.facts.push(free.shift());
      },
      name: 'header key facts',
      path: `${at('sales_order_detail')}.composition.presentation.header.facts`,
      surface: 'sales_order_detail',
    },
    {
      bound: COMPOSITION_BOUNDS.listColumns,
      fill: (model, count) =>
        padMembers(
          surfaceOf(model, 'sales_order_list').list.columns,
          count,
          'columnId',
          (column) => column.role !== 'title',
        ),
      name: 'List columns',
      path: `${at('sales_order_list')}.list.columns`,
      surface: 'sales_order_list',
    },
  ];
  for (const entry of cases) {
    const atMaximum = structuredClone(authored);
    entry.fill(atMaximum, entry.bound);
    normalizeApplicationPackage(atMaximum as never);

    const oneMore = structuredClone(authored);
    entry.fill(oneMore, entry.bound + 1);
    const refusals = [1, 2].map(() => {
      try {
        normalizeApplicationPackage(oneMore as never);
      } catch (error) {
        assert.ok(error instanceof CanonicalModelError, String(error));
        return error.diagnostics;
      }
      return assert.fail(`${entry.name}: ${entry.bound + 1} was accepted`);
    });
    assert.deepEqual(
      refusals[0],
      [
        {
          acceptedAlternative:
            'use the exported authored schema and canonical example',
          code: 'CANON_SCHEMA_INVALID',
          objectId: id('surface', entry.surface),
          occurrenceIndex: 0,
          path: entry.path,
          phase: 'canonicalModel',
          rule: 'value must satisfy a closed supported schema through v6',
        },
      ],
      entry.name,
    );
    assert.deepEqual(
      refusals[1],
      refusals[0],
      `${entry.name} is deterministic`,
    );
  }
});
