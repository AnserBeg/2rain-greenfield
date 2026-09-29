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
