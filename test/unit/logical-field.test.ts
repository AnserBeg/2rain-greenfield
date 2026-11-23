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
function refusalOf(result: customization.SandboxResponse): string {
  assert.notEqual(result.status, 'compiled');
  return JSON.stringify(result);
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
  { fieldId: f('currency'), entityId: shipment, logicalType: 'currencyCode' },
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

test('the compiler refuses a forged declaration by field', async () => {
  const declarations = (def: Forged) => def.logicalFields as Forged[];
  // deriveLogicalFieldBindings: money without its report-source currency.
  assert.match(
    refusalOf(
      await compile([shipmentType], (def) => {
        const entity = (def.entities as Forged[]).find(
          (e) => e.entityId === shipment,
        )!;
        entity.reportSource.amounts = entity.reportSource.amounts.filter(
          (a: Forged) => a.fieldId !== f('deposit'),
        );
      }),
    ),
    /logical field northstar\.app:field\.custom_shipment_deposit: money stores an exact decimal bound to a currency/u,
  );
  // deriveLogicalFieldBindings: a currency code that compares case-insensitively.
  assert.match(
    refusalOf(
      await compile([shipmentType], (def) => {
        (def.fields as Forged[]).find(
          (x) => x.fieldId === f('currency'),
        )!.collation = 'unicodeCaseInsensitive';
      }),
    ),
    /currency code stores three characters compared exactly/u,
  );
  // deriveLogicalFieldBindings: a quantity whose base unit is not its declared unit.
  assert.match(
    refusalOf(
      await compile([shipmentType], (def) => {
        declarations(def).find((d) => d.fieldId === f('weight'))!.unitLabel =
          'lb';
      }),
    ),
    /quantity stores its declared unit/u,
  );
  // compileLogicalFields: a first-party record type.
  assert.match(
    refusalOf(
      await compile([shipmentType], (def) => {
        declarations(def).push({
          schemaVersion: 'v6',
          fieldId: `${NS}:field.item_name`,
          entityId: `${NS}:entity.item`,
          logicalType: 'longText',
        });
      }),
    ),
    /only a tenant record type can hold a longText field/u,
  );
});

test('with logical fields active and after one retires, adding a field and arranging the list still compile', async () => {
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
  const retired = await compile([shipmentType, ...later], (def) => {
    for (const local of ['deposit', 'weight'])
      (def.fields as Forged[]).find((x) => x.fieldId === f(local))!.lifecycle =
        'retired';
    // REPORTS-1 binds only active amounts: a retired money field leaves the
    // report source with it, while its logical declaration stays (rule 10).
    const entity = (def.entities as Forged[]).find(
      (e) => e.entityId === shipment,
    )!;
    entity.reportSource.amounts = entity.reportSource.amounts.filter(
      (a: Forged) => a.fieldId !== f('deposit'),
    );
  });
  const { surface } = surfaceOf(retired);
  const ids = (surface.payload.logicalFieldBindings as Forged[]).map(
    (b) => b.fieldId,
  );
  assert.equal(ids.includes(f('deposit')), false);
  assert.equal(ids.includes(f('weight')), false);
  assert.equal(surface.floor, LOGICAL_FIELD_READER);
});

test('serving admission recomputes the bindings and refuses a disagreement, a stray binding and an understated floor', () => {
  const normalized = normalizeApplicationPackage(applied([shipmentType]));
  const revision = new TextEncoder().encode(JSON.stringify(normalized));
  const derived = deriveLogicalFieldBindings(
    normalized as unknown as Parameters<typeof deriveLogicalFieldBindings>[0],
  );
  assert.ok(derived.status === 'bound');
  assert.equal(canonicalize(derived.bindings), canonicalize(expectedBindings));
  const payload = { logicalFieldBindings: derived.bindings };
  assert.equal(
    logicalFieldBindingsProblem(payload, LOGICAL_FIELD_READER, revision),
    null,
  );
  // The comparator: a widened scale is refused.
  const widened = structuredClone(expectedBindings) as Forged[];
  widened.find((b) => b.fieldId === f('rate'))!.scale = 2;
  assert.match(
    logicalFieldBindingsProblem(
      { logicalFieldBindings: widened },
      LOGICAL_FIELD_READER,
      revision,
    ) ?? '',
    /disagree/u,
  );
  assert.match(
    logicalFieldBindingsProblem({}, LOGICAL_FIELD_READER, revision) ?? '',
    /disagree/u,
  );
  // The floor check: a declaration served below its rung.
  assert.match(
    logicalFieldBindingsProblem(payload, LOGICAL_FIELD_READER - 1, revision) ??
      '',
    /need the logical field surface reader floor/u,
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

test('formula validation and calculated displays read tenant money in its own currency', () => {
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
  assert.equal(typed('deposit')?.kind, 'decimal');
  assert.equal(
    (typed('deposit') as { currency: string | null }).currency,
    'CAD',
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

test('web controls keep paragraphs, offer only accepted currency codes and step by scale', () => {
  const logical = (binding: Partial<CompiledLogicalField>) =>
    ({ fieldId: 'x', entityId: shipment, ...binding }) as CompiledLogicalField;
  const text = (
    binding: Partial<CompiledLogicalField>,
  ): CompiledSurfaceField => ({
    fieldId: f('notes'),
    kind: 'textFieldType',
    required: false,
    logical: logical(binding),
  });
  const paragraphs = 'First line\nSecond line';
  const notes = renderFormControl(
    text({ logicalType: 'longText' }),
    undefined,
    f('notes'),
    0,
    paragraphs,
  );
  assert.equal(notes.storedValueUnavailable, false);
  assert.match(
    notes.html,
    /<textarea[^>]*>First line\nSecond line<\/textarea>/u,
  );
  const code = (value: string) =>
    renderFormControl(
      text({
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
    '12.500',
  );
  assert.match(weight.html, /step="0\.001"/u);
  assert.match(weight.html, /data-field-unit>kg<\/span>/u);
  const stored = logical({
    logicalType: 'money',
    scale: 2,
    currency: {
      kind: 'stored',
      fieldId: f('currency'),
      codes: ['CAD'],
    } as never,
  });
  assert.equal(
    logicalSuffix(stored, {
      recordId: 'r',
      values: { [f('currency')]: 'USD' },
    } as never),
    'USD',
  );
  assert.equal(logicalSuffix(stored), null);
});
