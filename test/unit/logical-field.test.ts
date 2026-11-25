/**
 * CUSTOMIZE-6 slice 1: tenant decimal, money, quantity, long text and currency
 * fields, from the patch through the compiler, the serving check, formula
 * and display typing, the drafter and the web controls. Each refusal below
 * names the one check whose removal reds it (rule 8; the record lists them).
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { readReportsPredecessor } from '../helpers/reports-preceding-release.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  LOGICAL_FIELD_READER,
  canonicalize,
  deriveLogicalFieldBindings,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import { formulaFieldType } from '../../packages/canonical-model/src/formula-validation-bindings.js';
import { displayTypeForField } from '../../packages/canonical-model/src/calculated-display-bindings.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/protocol.js';
import * as customization from '../../packages/customization/src/index.js';
import { logicalFieldBindingsProblem } from '../../packages/postgres-provider/src/logical-field-admission.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { renderFormControl } from '../../apps/web/src/component-registry.js';
import { logicalSuffix } from '../../apps/web/src/surface-composition.js';
import { literalValidationDraft } from '../../packages/customization/src/validation-draft.js';
import { compileLiteralFormulaRules } from '../../packages/compiler/src/formula-validation-plan.js';
import { renderValueControl } from '../../apps/web/src/editor-controls.js';
import { captureDraftFields } from '../../apps/web/src/document-editor.js';
import type {
  CompiledLogicalField,
  CompiledSurfaceField,
} from '../../apps/web/src/surface-contract.js';

const authoredPath = resolve('apps/web/release/app.authored.json');
const base = readReportsPredecessor(
  'apps/web/release/app.authored.json',
) as Record<string, unknown>;
const tip = parseCompiledApplication(
  readReportsPredecessor('apps/web/release/app.compiled.json'),
).application;
const acknowledgement = readUnboundPermissionAcknowledgementFor(
  authoredPath,
  'northstar.app:package.application',
);
const NS = 'northstar.app';
const shipment = `${NS}:entity.custom_shipment`;
const f = (local: string) => `${NS}:field.custom_shipment_${local}`;
const shipmentType = {
  kind: 'addRecordType',
  label: 'Shipment',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Name', type: 'text', required: true },
    { label: 'Weight', type: 'quantity', scale: 3, unit: 'kg' },
    { label: 'Rate', type: 'decimal', scale: 4 },
    { label: 'Currency', type: 'currency' },
    {
      label: 'Freight',
      type: 'money',
      currency: { kind: 'stored', fieldLabel: 'Currency' },
    },
    {
      label: 'Deposit',
      type: 'money',
      currency: { kind: 'fixed', code: 'CAD' },
    },
    { label: 'Notes', type: 'longText' },
  ],
};
const patch = (input: unknown) =>
  customization.CustomizationPatchSchema.parse(input);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Forged = Record<string, any>;
const note = {
  kind: 'addField',
  entity: shipment,
  field: { label: 'Carrier', type: 'text' },
};

function applied(chain: unknown[]): Forged {
  const result = customization.applyCustomizationPatches(
    base,
    chain.map(patch),
  );
  assert.ok(result.status === 'applied', JSON.stringify(result));
  return result.authored as Forged;
}
async function compile(
  chain: unknown[],
  mutate?: (def: Forged) => void,
): Promise<customization.SandboxResponse> {
  if (!mutate)
    return customization.compileInSandbox({
      acknowledgement,
      base,
      chain: chain.map(patch),
      tip: customization.serializeRelease(tip),
    });
  const authored = structuredClone(applied(chain));
  mutate(authored);
  return customization.compileInSandbox({
    acknowledgement,
    base: authored,
    chain: [patch(note)],
    tip: customization.serializeRelease(tip),
  });
}
function surfaceOf(result: customization.SandboxResponse) {
  assert.ok(result.status === 'compiled', JSON.stringify(result).slice(0, 800));
  const bundle = customization.parseSerializedRelease(
    result.steps.at(-1)!.release,
  ).compiled.bundle;
  const read = (familyId: string) => {
    const projection = bundle.releaseManifest.projections.find(
      (p) => p.familyId === familyId,
    )!;
    const manifest = bundle.artifacts.find(
      (a) => a.contentHash === projection.artifactRoot,
    )!;
    const chunk = JSON.parse(
      new TextDecoder().decode(manifest.canonicalBytes),
    ) as { chunks: { contentHash: string }[] };
    const artifact = bundle.artifacts.find(
      (a) => a.contentHash === chunk.chunks[0]!.contentHash,
    )!;
    return {
      floor: projection.requiredRuntimeCapability.minimumVersion,
      payload: JSON.parse(
        new TextDecoder().decode(artifact.canonicalBytes),
      ) as Record<string, unknown>,
    };
  };
  return {
    surface: read(PROJECTION_FAMILY_IDS.surfaceManifest),
    operation: read(PROJECTION_FAMILY_IDS.operationCatalog),
  };
}

const expectedBindings = [
  {
    fieldId: f('currency'),
    entityId: shipment,
    logicalType: 'currencyCode',
    allowedValues: ['CAD', 'USD', 'EUR'],
  },
  {
    fieldId: f('deposit'),
    entityId: shipment,
    logicalType: 'money',
    scale: 2,
    currency: { kind: 'fixed', currencyCode: 'CAD' },
  },
  {
    fieldId: f('freight'),
    entityId: shipment,
    logicalType: 'money',
    scale: 2,
    currency: {
      kind: 'stored',
      fieldId: f('currency'),
      codes: ['CAD', 'USD', 'EUR'],
    },
  },
  { fieldId: f('notes'), entityId: shipment, logicalType: 'longText' },
  { fieldId: f('rate'), entityId: shipment, logicalType: 'decimal', scale: 4 },
  {
    fieldId: f('weight'),
    entityId: shipment,
    logicalType: 'quantity',
    scale: 3,
    unit: { unitId: `${NS}:capability.unit_kg`, label: 'kg' },
  },
];

test('the five kinds store existing scalars and bind in the surface manifest at the logical rung', async () => {
  const authored = applied([shipmentType]);
  const field = (local: string) =>
    (authored.fields as Forged[]).find((x) => x.fieldId === f(local))!;
  assert.equal(field('weight').fieldType.kind, 'quantityFieldType');
  assert.equal(
    field('weight').fieldType.baseUnit.targetId,
    `${NS}:capability.unit_kg`,
  );
  assert.equal(field('rate').fieldType.kind, 'exactDecimalFieldType');
  assert.equal(field('rate').fieldType.scale, 4);
  assert.equal(field('deposit').fieldType.scale, 2);
  assert.equal(field('freight').fieldType.scale, 2);
  assert.equal(field('notes').fieldType.maximumLength, 4000);
  assert.equal(field('currency').fieldType.maximumLength, 3);
  assert.equal(field('currency').collation, 'binary');
  const entity = (authored.entities as Forged[]).find(
    (e) => e.entityId === shipment,
  )!;
  // Money appends to the record type's REPORTS-1 amount binding.
  assert.deepEqual(entity.reportSource.amounts, [
    {
      fieldId: f('freight'),
      currency: {
        kind: 'stored',
        fieldId: f('currency'),
        codes: ['CAD', 'USD', 'EUR'],
      },
    },
    { fieldId: f('deposit'), currency: { kind: 'fixed', currencyCode: 'CAD' } },
  ]);
  const { surface, operation } = surfaceOf(await compile([shipmentType]));
  assert.deepEqual(surface.payload.logicalFieldBindings, expectedBindings);
  assert.equal(surface.floor, LOGICAL_FIELD_READER);
  assert.equal('logicalFieldBindings' in operation.payload, false);
});

test('a release without logical fields emits no key, binding or floor', async () => {
  const plain = {
    kind: 'addRecordType',
    label: 'Shipment',
    companyOwnership: 'entityOwned',
    fields: [{ label: 'Name', type: 'text', required: true }],
  };
  assert.equal(
    'logicalFields' in normalizeApplicationPackage(applied([plain])),
    false,
  );
  const { surface } = surfaceOf(await compile([plain]));
  assert.equal('logicalFieldBindings' in surface.payload, false);
  assert.ok(surface.floor < LOGICAL_FIELD_READER);
});

test('added fields reuse one unit spelling and name a stored currency by ID', async () => {
  const volume = {
    kind: 'addField',
    entity: shipment,
    field: { label: 'Volume', type: 'quantity', scale: 2, unit: 'm3' },
  };
  const fee = {
    kind: 'addField',
    entity: shipment,
    field: {
      label: 'Fee',
      type: 'money',
      currency: { kind: 'stored', fieldId: f('currency') },
    },
  };
  const billing = {
    kind: 'changeSet',
    patches: [
      {
        kind: 'addField',
        entity: shipment,
        field: { label: 'Billing currency', type: 'currency' },
      },
      {
        kind: 'addField',
        entity: shipment,
        field: {
          label: 'Duty',
          type: 'money',
          currency: { kind: 'stored', fieldLabel: 'Billing currency' },
        },
      },
    ],
  };
  const { surface } = surfaceOf(
    await compile([shipmentType, volume, fee, billing]),
  );
  const bindings = surface.payload.logicalFieldBindings as Forged[];
  assert.deepEqual(bindings.find((b) => b.fieldId === f('volume'))!.unit, {
    unitId: `${NS}:capability.unit_m3`,
    label: 'm3',
  });
  assert.equal(
    bindings.find((b) => b.fieldId === f('fee'))!.currency.fieldId,
    f('currency'),
  );
  assert.equal(
    bindings.find((b) => b.fieldId === f('duty'))!.currency.fieldId,
    f('billing_currency'),
  );
  // Removing the one-spelling check in declareLogicalFields reds this.
  const tare = customization.applyCustomizationPatches(base, [
    patch(shipmentType),
    patch({
      kind: 'addField',
      entity: shipment,
      field: { label: 'Tare', type: 'quantity', scale: 3, unit: 'KG' },
    }),
  ]);
  assert.match(JSON.stringify(tare), /already written .{0,2}kg/u);
});

test('built-in record types, line tables and a missing currency field are named gaps', () => {
  const refused = (chain: unknown[]) => {
    const result = customization.applyCustomizationPatches(
      base,
      chain.map(patch),
    );
    assert.notEqual(result.status, 'applied');
    return JSON.stringify(result);
  };
  assert.match(
    refused([
      {
        kind: 'addField',
        entity: `${NS}:entity.item`,
        field: { label: 'Weight', type: 'decimal', scale: 2 },
      },
    ]),
    /built-in record types/u,
  );
  assert.match(
    refused([
      shipmentType,
      {
        kind: 'addLineTable',
        entity: shipment,
        label: 'Packages',
        fields: [
          { label: 'Label', type: 'text' },
          { label: 'Mass', type: 'quantity', scale: 1, unit: 'kg' },
        ],
      },
    ]),
    /line fields/u,
  );
  assert.match(
    refused([
      shipmentType,
      {
        kind: 'addField',
        entity: shipment,
        field: {
          label: 'Duty',
          type: 'money',
          currency: { kind: 'stored', fieldLabel: 'Duty currency' },
        },
      },
    ]),
    /no currency field .{0,2}Duty currency/u,
  );
  for (const field of [
    { label: 'Rate', type: 'decimal' },
    { label: 'Rate', type: 'text', scale: 2 },
    { label: 'Fee', type: 'money' },
    { label: 'Mass', type: 'quantity', scale: 1 },
    {
      label: 'Fee',
      type: 'money',
      currency: { kind: 'stored', fieldId: f('currency'), fieldLabel: 'X' },
    },
  ])
    assert.equal(
      customization.CustomFieldSchema.safeParse(field).success,
      false,
      JSON.stringify(field),
    );
});

const declarations = (def: Forged) => def.logicalFields as Forged[];
function refusedWith(
  result: customization.SandboxResponse,
  message: string,
): string {
  assert.notEqual(result.status, 'compiled', message);
  return JSON.stringify(result);
}

test('the compiler refuses money whose currency the record type does not bind', async () => {
  assert.match(
    refusedWith(
      await compile([shipmentType], (def) => {
        const entity = (def.entities as Forged[]).find(
          (e) => e.entityId === shipment,
        )!;
        entity.reportSource.amounts = entity.reportSource.amounts.filter(
          (a: Forged) => a.fieldId !== f('deposit'),
        );
      }),
      'money without a bound currency compiled',
    ),
    /logical field northstar\.app:field\.custom_shipment_deposit: money stores an exact decimal bound to a currency/u,
  );
});

test('the compiler refuses a currency code compared case-insensitively', async () => {
  assert.match(
    refusedWith(
      await compile([shipmentType], (def) => {
        (def.fields as Forged[]).find(
          (x) => x.fieldId === f('currency'),
        )!.collation = 'unicodeCaseInsensitive';
      }),
      'a case-insensitive currency code compiled',
    ),
    /currency code stores three characters compared exactly/u,
  );
});

test('the compiler refuses a quantity whose base unit is not its declared unit', async () => {
  assert.match(
    refusedWith(
      await compile([shipmentType], (def) => {
        declarations(def).find((d) => d.fieldId === f('weight'))!.unitLabel =
          'lb';
      }),
      'a quantity with another unit compiled',
    ),
    /quantity stores its declared unit/u,
  );
});

test('the compiler refuses a logical field on a first-party record type', async () => {
  assert.match(
    refusedWith(
      await compile([shipmentType], (def) => {
        declarations(def).push({
          schemaVersion: 'v6',
          fieldId: `${NS}:field.item_name`,
          entityId: `${NS}:entity.item`,
          logicalType: 'longText',
        });
      }),
      'a first-party logical field compiled',
    ),
    /only a tenant record type can hold a longText field/u,
  );
});

test('with logical fields active and after they retire, adding a field and arranging the list still compile', async () => {
  const later = [
    {
      kind: 'addField',
      entity: shipment,
      field: { label: 'Bay', type: 'text' },
    },
    {
      kind: 'arrangeLayout',
      surface: `${NS}:surface.custom_shipment_list`,
      relabel: [{ field: f('name'), label: 'Shipment' }],
    },
  ];
  surfaceOf(await compile([shipmentType, ...later]));
  // Retire money (still bound in the report source), the currency it reads
  // and the quantity in the BASE, then add and arrange after the retirement.
  const retiredBase = structuredClone(applied([shipmentType]));
  for (const local of ['deposit', 'freight', 'currency', 'weight'])
    (retiredBase.fields as Forged[]).find(
      (x) => x.fieldId === f(local),
    )!.lifecycle = 'retired';
  const retired = await customization.compileInSandbox({
    acknowledgement,
    base: retiredBase,
    chain: later.map(patch),
    tip: customization.serializeRelease(tip),
  });
  const { surface } = surfaceOf(retired);
  const ids = (surface.payload.logicalFieldBindings as Forged[]).map(
    (b) => b.fieldId,
  );
  for (const local of ['deposit', 'freight', 'weight'])
    assert.equal(ids.includes(f(local)), false, local);
  assert.equal(surface.floor, LOGICAL_FIELD_READER);
  // The retired amounts stay in the report source, unvalidated.
  const entity = (
    normalizeApplicationPackage(retiredBase).entities as Forged[]
  ).find((e) => e.entityId === shipment)!;
  assert.equal(entity.reportSource.amounts.length, 2);
});

function servingFixture() {
  const normalized = normalizeApplicationPackage(applied([shipmentType]));
  const revision = new TextEncoder().encode(JSON.stringify(normalized));
  const derived = deriveLogicalFieldBindings(
    normalized as unknown as Parameters<typeof deriveLogicalFieldBindings>[0],
  );
  assert.ok(derived.status === 'bound');
  assert.equal(canonicalize(derived.bindings), canonicalize(expectedBindings));
  return { revision, payload: { logicalFieldBindings: derived.bindings } };
}

test('serving refuses surface bindings that disagree with the recomputed ones', () => {
  const { revision, payload } = servingFixture();
  assert.equal(
    logicalFieldBindingsProblem(payload, LOGICAL_FIELD_READER, revision),
    null,
  );
  const widened = structuredClone(expectedBindings) as Forged[];
  widened.find((b) => b.fieldId === f('rate'))!.scale = 2;
  assert.equal(
    logicalFieldBindingsProblem(
      { logicalFieldBindings: widened },
      LOGICAL_FIELD_READER,
      revision,
    ),
    'logical field bindings disagree with the field declarations.',
    'a widened scale was served',
  );
  assert.match(
    logicalFieldBindingsProblem({}, LOGICAL_FIELD_READER, revision) ?? '',
    /disagree/u,
  );
});

test('serving refuses a declaration below its reader rung and a rung without one', () => {
  const { revision, payload } = servingFixture();
  assert.equal(
    logicalFieldBindingsProblem(payload, LOGICAL_FIELD_READER - 1, revision),
    'logical field bindings need the logical field surface reader floor.',
    'a declaration was served below its rung',
  );
  const plain = new TextEncoder().encode(
    JSON.stringify(normalizeApplicationPackage(base)),
  );
  assert.equal(logicalFieldBindingsProblem({}, 40, plain), null);
  assert.match(
    logicalFieldBindingsProblem({}, LOGICAL_FIELD_READER, plain) ?? '',
    /floor without logical field declarations/u,
  );
  assert.match(
    logicalFieldBindingsProblem(payload, LOGICAL_FIELD_READER, plain) ?? '',
    /bindings without declarations/u,
  );
});

test('a currency field reads its allowed codes from its own declaration', () => {
  const normalized = normalizeApplicationPackage(
    applied([shipmentType]),
  ) as unknown as Forged;
  const declaration = (normalized.logicalFields as Forged[]).find(
    (d) => d.fieldId === f('currency'),
  )!;
  assert.deepEqual(declaration.allowedValues, ['CAD', 'USD', 'EUR']);
  const derive = (def: Forged) =>
    deriveLogicalFieldBindings(
      def as Parameters<typeof deriveLogicalFieldBindings>[0],
    );
  const codes = (def: Forged) => {
    const outcome = derive(def);
    assert.ok(outcome.status === 'bound', JSON.stringify(outcome));
    return outcome.bindings.find((b) => b.fieldId === f('currency'))!
      .allowedValues;
  };
  assert.deepEqual(codes(normalized), ['CAD', 'USD', 'EUR']);
  // The binding follows the declaration, not a platform constant.
  const narrowed = structuredClone(normalized);
  (narrowed.logicalFields as Forged[]).find(
    (d) => d.fieldId === f('currency'),
  )!.allowedValues = ['USD'];
  assert.deepEqual(
    codes(narrowed),
    ['USD'],
    'the binding ignored the declaration',
  );
  const widened = structuredClone(normalized);
  (widened.logicalFields as Forged[]).find(
    (d) => d.fieldId === f('currency'),
  )!.allowedValues = ['CAD', 'GBP'];
  assert.match(
    JSON.stringify(derive(widened)),
    /a currency field allows only CAD, USD, EUR/u,
  );
});

test('a currency field refuses unlisted codes on write through its own contract and is searchable', async () => {
  const authored = applied([shipmentType]);
  const currency = (authored.fields as Forged[]).find(
    (x) => x.fieldId === f('currency'),
  )!;
  assert.equal(currency.searchable, true, 'the currency field is searchable');
  assert.equal(
    ((authored.formulaRules ?? []) as Forged[]).length,
    0,
    'the allowed codes are not a formula rule',
  );
  const { operation } = surfaceOf(await compile([shipmentType]));
  const contract = (local: string) =>
    (
      (operation.payload.operations as Forged[]).find(
        (o) => o.operationId === `${NS}:operation.custom_shipment_${local}`,
      )!.inputContract.fields as Forged[]
    ).find((x) => x.fieldId === f('currency'))!;
  for (const local of ['create', 'update'])
    assert.deepEqual(
      contract(local).allowedTexts,
      ['CAD', 'USD', 'EUR'],
      'the write contract lacks the allowed values',
    );
});

test('a currency field and two validated optional numbers compile together', async () => {
  const type = {
    kind: 'addRecordType',
    label: 'Shipment',
    companyOwnership: 'entityOwned',
    fields: [
      { label: 'Name', type: 'text', required: true },
      { label: 'Currency', type: 'currency' },
      { label: 'Pieces', type: 'number' },
      { label: 'Pallets', type: 'number' },
    ],
  };
  const target = customization
    .customizationTargets(normalizeApplicationPackage(applied([type])))
    .validationTargets!.find((t) => t.entityId === shipment)!;
  const rule = (local: string) =>
    literalValidationDraft(target, {
      fieldId: f(local),
      check: 'minimum',
      limit: '1',
      message: `At least one ${local}.`,
    });
  const result = await compile([type, rule('pieces'), rule('pallets')]);
  assert.equal(
    result.status,
    'compiled',
    `two rules beside a currency field refused: ${JSON.stringify(result).slice(0, 600)}`,
  );
});

test('formula validation types tenant money in its fixed currency', () => {
  const normalized = normalizeApplicationPackage(
    applied([shipmentType]),
  ) as unknown as Forged;
  const field = (local: string) =>
    (normalized.fields as Forged[]).find((x) => x.fieldId === f(local))!;
  const typed = (local: string) =>
    formulaFieldType(
      field(local) as Parameters<typeof formulaFieldType>[0],
      normalized as Parameters<typeof formulaFieldType>[1],
    );
  assert.equal(
    (typed('deposit') as { currency: string | null } | null)?.currency,
    'CAD',
    'tenant money lost its currency',
  );
  // A stored currency varies by record: no single currency to compare in.
  assert.equal(typed('freight'), null);
  assert.equal((typed('rate') as { currency: string | null }).currency, null);
  // Without the revision the field reads as it did before (no currency).
  assert.equal(
    (
      formulaFieldType(
        field('deposit') as Parameters<typeof formulaFieldType>[0],
      ) as { currency: string | null }
    ).currency,
    null,
  );
  const display = (local: string) =>
    displayTypeForField(
      field(local) as Parameters<typeof displayTypeForField>[0],
      normalized as Parameters<typeof displayTypeForField>[1],
    );
  assert.deepEqual(display('rate'), {
    precision: 18,
    scale: 4,
    currency: null,
    unit: null,
  });
  assert.equal(display('deposit')?.currency, 'CAD');
  assert.equal(display('freight'), null);
});

test("the approval text names each field's currency, unit and scale", async () => {
  const result = await compile([shipmentType]);
  assert.ok(result.status === 'compiled', JSON.stringify(result).slice(0, 400));
  const text = JSON.stringify(result.steps.at(-1));
  for (const line of [
    'Deposit (money in CAD)',
    "Freight (money in the record's Currency (CAD, USD, EUR))",
    'Weight (quantity in kg, 3 decimals)',
    'Rate (decimal, 4 decimals)',
    'Notes (long text)',
    'Currency (currency: one of CAD, USD, EUR)',
  ])
    assert.ok(text.includes(line), `the approval text lacks "${line}"`);
});

test('the drafter describes the new kinds from their schemas', () => {
  const schema = JSON.stringify(customization.drafterToolSchema());
  for (const word of [
    'longText',
    'quantity',
    'fieldLabel',
    'Required for type money',
  ])
    assert.ok(schema.includes(word), word);
  const lines = customization.drafterKindLines().join('\n');
  assert.match(lines, /quantity is an exact amount in a unit/u);
});

const logical = (binding: Partial<CompiledLogicalField>) =>
  ({ fieldId: 'x', entityId: shipment, ...binding }) as CompiledLogicalField;
const textField = (
  binding: Partial<CompiledLogicalField>,
): CompiledSurfaceField => ({
  fieldId: f('notes'),
  kind: 'textFieldType',
  required: false,
  logical: logical(binding),
});

test('a long-text control keeps paragraphs and a leading blank line', () => {
  const notes = renderFormControl(
    textField({ logicalType: 'longText' }),
    undefined,
    f('notes'),
    0,
    '\nFirst line\nSecond line',
  );
  assert.equal(
    notes.storedValueUnavailable,
    false,
    'a paragraph value was flagged unavailable',
  );
  assert.match(
    notes.html,
    /<textarea[^>]*maxlength="4000"[^>]*>\n\nFirst line\nSecond line<\/textarea>/u,
  );
});

test('a currency control offers only its codes and flags any other', () => {
  const code = (value: string) =>
    renderFormControl(
      textField({
        logicalType: 'currencyCode',
        currencyCodes: ['CAD', 'USD', 'EUR'],
      }),
      undefined,
      f('currency'),
      0,
      value,
    );
  assert.match(code('USD').html, /<option value="USD" selected>USD<\/option>/u);
  // A code outside the list is announced, never posted as another value.
  assert.equal(code('cad').storedValueUnavailable, true);
});

test('a scaled number steps by its scale and shows its unit; money shows only a listed code', () => {
  const weight = renderFormControl(
    {
      fieldId: f('weight'),
      kind: 'quantityFieldType',
      required: false,
      logical: logical({
        logicalType: 'quantity',
        scale: 3,
        unit: { unitId: `${NS}:capability.unit_kg`, label: 'kg' } as never,
      }),
    },
    undefined,
    f('weight'),
    0,
    '12.5',
  );
  assert.match(weight.html, /step="0\.001"/u);
  assert.match(weight.html, /data-field-unit>kg<\/span>/u);
  const stored = logical({
    logicalType: 'money',
    scale: 2,
    currency: {
      kind: 'stored',
      fieldId: f('currency'),
      codes: ['CAD', 'USD'],
    } as never,
  });
  const suffix = (code: string) =>
    logicalSuffix(stored, {
      recordId: 'r',
      values: { [f('currency')]: code },
    } as never);
  assert.equal(suffix('USD'), 'USD');
  assert.equal(suffix('GBP'), '(no listed currency)');
  assert.equal(suffix('cad'), '(no listed currency)');
  assert.equal(logicalSuffix(stored), null);
});

test('the document editor text area keeps a leading blank line, bounds its length and posts CRLF as one break', () => {
  const input = {
    fieldId: f('notes'),
    kind: 'textFieldType',
    required: false,
    bounds: { maximumLength: 4000, precision: null, scale: null },
  } as never;
  const field = {
    fieldId: f('notes'),
    label: 'Notes',
    presentation: { kind: 'multiline' },
  } as never;
  const html = renderValueControl({
    row: { id: 'r1', values: { [f('notes')]: '\nFirst\nSecond' } },
    field,
    compiled: undefined,
    input,
    frozen: false,
    index: 0,
    accessibleName: null,
    focus: null,
    error: null,
  } as never);
  assert.match(
    html,
    /<textarea[^>]*maxlength="4000"[^>]*>\n\nFirst\nSecond<\/textarea>/u,
    'the editor text area lost its leading blank line or bound',
  );
  const row = { id: 'r1', values: {} as Record<string, unknown> };
  const refused = captureDraftFields(
    row as never,
    [field] as never,
    new Map([[f('notes'), input]]) as never,
    { [`draft:r1:${f('notes')}`]: '\r\nFirst\r\nSecond' } as never,
  );
  assert.deepEqual(refused, []);
  assert.equal(row.values[f('notes')], '\nFirst\nSecond');
});

test('verification witnesses for a rule on a currency field hold only its declared codes', () => {
  const base1 = normalizeApplicationPackage(applied([shipmentType]));
  const target = customization
    .customizationTargets(base1)
    .validationTargets!.find((t) => t.entityId === shipment)!;
  const rule = literalValidationDraft(target, {
    fieldId: f('currency'),
    check: 'required',
    limit: '',
    message: 'Choose the currency.',
  });
  const plan = compileLiteralFormulaRules(
    normalizeApplicationPackage(applied([shipmentType, rule])),
  );
  assert.ok(plan.status === 'compiled', JSON.stringify(plan));
  const seen: unknown[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object')
      for (const [key, inner] of Object.entries(value)) {
        if (key === f('currency')) seen.push(inner);
        walk(inner);
      }
  };
  walk(plan.payload.witnesses);
  assert.ok(seen.length > 0, 'no witness names the currency field');
  for (const value of seen)
    assert.ok(
      value === null ||
        (typeof value === 'object' &&
          ['CAD', 'USD', 'EUR'].includes(
            String((value as { value?: unknown }).value ?? value),
          )) ||
        ['CAD', 'USD', 'EUR'].includes(String(value)),
      `a witness writes a value the field does not allow: ${JSON.stringify(value)}`,
    );
});
