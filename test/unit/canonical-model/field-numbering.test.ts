import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalModelError,
  normalizeApplicationPackage,
} from '../../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../../packages/domain/src/app/builder.js';

type Json = Record<string, unknown>;
type Application = Json & { fields: Json[]; surfaces: Json[] };
const ns = 'northstar.app';

function application(): Application {
  return structuredClone(composedApplicationDefinition()) as Application;
}
const field = (app: Application, id: string) =>
  app.fields.find((value) => value.fieldId === `${ns}:field.${id}`)!;

function refused(mutate: (app: Application) => void): string {
  const app = application();
  mutate(app);
  try {
    normalizeApplicationPackage(app as never);
  } catch (error) {
    assert.ok(error instanceof CanonicalModelError, String(error));
    return error.diagnostics.map((diagnostic) => diagnostic.rule).join(' ');
  }
  assert.fail('the numbering was accepted');
}

test('Sales, Purchase and shipment numbers are declared server-assigned sequences', () => {
  const normalized = normalizeApplicationPackage(
    composedApplicationDefinition() as never,
  );
  assert.deepEqual(
    normalized.fields
      .flatMap((value) => {
        const numbering = (
          value as { numbering?: { prefix: string; sequenceId: string } }
        ).numbering;
        return numbering
          ? [[value.fieldId, numbering.prefix, numbering.sequenceId]]
          : [];
      })
      .sort(),
    [
      // Ruling C: the credit, invoice and payment numbers.
      [
        `${ns}:field.customer_credit_number`,
        'CM',
        `${ns}:document_sequence.customer_credit`,
      ],
      [
        `${ns}:field.customer_invoice_number`,
        'INV',
        `${ns}:document_sequence.customer_invoice`,
      ],
      [
        `${ns}:field.customer_payment_number`,
        'PAY',
        `${ns}:document_sequence.customer_payment`,
      ],
      // RETURNS (ruling D): a customer return's RMA number.
      [
        `${ns}:field.customer_return_number`,
        'RMA',
        `${ns}:document_sequence.customer_return`,
      ],
      // PURCHASING-PARITY: a goods receipt's number, RCV-000001.
      [
        `${ns}:field.goods_receipt_number`,
        'RCV',
        `${ns}:document_sequence.goods_receipt`,
      ],
      // INVENTORY-PARITY: a stock document's number, STK-000001.
      [
        `${ns}:field.inventory_transaction_number`,
        'STK',
        `${ns}:document_sequence.inventory_transaction`,
      ],
      [
        `${ns}:field.purchase_order_number`,
        'PO',
        `${ns}:document_sequence.purchase_order`,
      ],
      [
        `${ns}:field.sales_order_number`,
        'SO',
        `${ns}:document_sequence.sales_order`,
      ],
      [
        `${ns}:field.shipment_number`,
        'SHP',
        `${ns}:document_sequence.shipment`,
      ],
      // STOCK-COUNTS: a stock count's number, CNT-000001.
      [
        `${ns}:field.stock_count_number`,
        'CNT',
        `${ns}:document_sequence.stock_count`,
      ],
      // PAYABLES (PY-E): the bill, vendor credit and vendor payment numbers,
      // each its own sequence, so PAY- and CM- stay receivables' own.
      [
        `${ns}:field.vendor_bill_number`,
        'BILL',
        `${ns}:document_sequence.vendor_bill`,
      ],
      [
        `${ns}:field.vendor_credit_number`,
        'VCM',
        `${ns}:document_sequence.vendor_credit`,
      ],
      [
        `${ns}:field.vendor_payment_number`,
        'VPAY',
        `${ns}:document_sequence.vendor_payment`,
      ],
      // RETURNS (ruling R-A): a vendor return's VRT number.
      [
        `${ns}:field.vendor_return_number`,
        'VRT',
        `${ns}:document_sequence.vendor_return`,
      ],
    ],
  );
});

test('a numbering the runtime could not honour is refused by name', () => {
  const numbering = (prefix: string, sequence = 'probe') => ({
    kind: 'documentSequence',
    sequenceId: `${ns}:document_sequence.${sequence}`,
    prefix,
    minimumDigits: 6,
    start: 1,
  });
  const cases: Array<[string, (app: Application) => void]> = [
    [
      'a document number is a text field',
      (app) => {
        field(app, 'sales_order_order_date').numbering = numbering('OD');
      },
    ],
    [
      'a document number is required on every record',
      (app) => {
        field(app, 'sales_order_notes').numbering = numbering('NT');
      },
    ],
    [
      'a document number is a tenant-wide unique business key',
      (app) => {
        field(app, 'sales_order_currency').numbering = numbering('CU');
      },
    ],
    [
      'shorter than its format',
      (app) => {
        (
          field(app, 'sales_order_number').numbering as {
            minimumDigits: number;
          }
        ).minimumDigits = 12;
        (
          field(app, 'sales_order_number').fieldType as {
            maximumLength: number;
          }
        ).maximumLength = 10;
      },
    ],
    [
      // Release verification's `V-` sentinels would read as this sequence's
      // numbers, advancing it and colliding with its values.
      'reserved for release verification sentinels',
      (app) => {
        (
          field(app, 'sales_order_number').numbering as { prefix: string }
        ).prefix = 'V';
      },
    ],
    [
      // The first number is the start, wider than its minimum digits:
      // `ABCDEFGH-1000000000` is 19 characters in a field of 18, which the
      // sentinel floor alone admits.
      'shorter than its format',
      (app) => {
        Object.assign(field(app, 'sales_order_number').numbering as Json, {
          prefix: 'ABCDEFGH',
          minimumDigits: 1,
          start: 1_000_000_000,
        });
        (
          field(app, 'sales_order_number').fieldType as {
            maximumLength: number;
          }
        ).maximumLength = 18;
      },
    ],
    [
      // A 3-character field would leave release verification 16 possible
      // sentinels (`V-0`..`V-f`); 17 characters leave fewer than 64 bits.
      'release verification sentinels keep 64 bits',
      (app) => {
        Object.assign(field(app, 'sales_order_number').numbering as Json, {
          minimumDigits: 1,
          start: 1,
        });
        (
          field(app, 'sales_order_number').fieldType as {
            maximumLength: number;
          }
        ).maximumLength = 17;
      },
    ],
    [
      'each document sequence numbers one field',
      (app) => {
        field(app, 'purchase_order_number').numbering = numbering(
          'PO',
          'sales_order',
        );
      },
    ],
    [
      'an assigned number is not an editor field',
      (app) => {
        const form = app.surfaces.find(
          (value) => value.surfaceId === `${ns}:surface.sales_order_form`,
        )!;
        (form.documentEditor as { headerFields: Json[] }).headerFields.unshift({
          fieldId: `${ns}:field.sales_order_number`,
          label: 'Number',
        });
      },
    ],
    [
      // A stock document's first create writes its declared values; never
      // its number, which the server assigns.
      'an assigned number is not a create value',
      (app) => {
        const form = app.surfaces.find(
          (value) =>
            value.surfaceId === `${ns}:surface.inventory_transaction_form`,
        )!;
        (form.documentEditor as { createValues: Json[] }).createValues.push({
          fieldId: `${ns}:field.inventory_transaction_number`,
          value: { source: 'literal', value: 'STK-TYPED' },
        });
      },
    ],
    [
      'an assigned number is not a composition input',
      (app) => {
        for (const surface of app.surfaces) {
          const composition = surface.composition as
            | { actions: Array<{ steps: Array<{ bindings: Json[] }> }> }
            | undefined;
          const step = composition?.actions
            .flatMap((action) => action.steps)
            .find((value) =>
              value.bindings.some((binding) =>
                (binding.path as string[]).includes(
                  `${ns}:field.shipment_state`,
                ),
              ),
            );
          if (step) {
            step.bindings.push({
              path: ['values', `${ns}:field.shipment_number`],
              value: { source: 'literal', value: 'SHP-TYPED' },
            });
            return;
          }
        }
        assert.fail('no shipment create step found');
      },
    ],
  ];
  for (const [reason, mutate] of cases)
    assert.match(refused(mutate), new RegExp(reason), reason);
});

test('a field wide enough for its first number and for verification sentinels is admitted', () => {
  const app = application();
  // `SO-1000` needs 7 characters; verification's sentinels need 18.
  Object.assign(field(app, 'sales_order_number').numbering as Json, {
    minimumDigits: 1,
    start: 1000,
  });
  (
    field(app, 'sales_order_number').fieldType as { maximumLength: number }
  ).maximumLength = 18;
  assert.doesNotThrow(() => normalizeApplicationPackage(app as never));
});

test('a malformed prefix fails the closed schema', () => {
  assert.match(
    refused((app) => {
      (
        field(app, 'sales_order_number').numbering as { prefix: string }
      ).prefix = 'so-';
    }),
    /closed supported schema/u,
  );
});
