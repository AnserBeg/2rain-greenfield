/**
 * CUSTOMIZE-6 slice 2: decimal, money, quantity, long-text and currency fields
 * on tenant LINE TABLES, with line money whose currency is fixed, stored on
 * the line, or stored on the line's header (read through the parent link).
 * Each refusal names the one check whose removal reds it (rule 8; the
 * record and test/evidence/CUSTOMIZE-6-s2.expected-red.json list them).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

import { readReportsPredecessor } from '../helpers/reports-preceding-release.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  CurrencyViaSchema,
  ReportCurrencyBindingSchema,
} from '../../packages/canonical-model/src/schemas.js';
import {
  LINE_LOGICAL_FIELD_READER,
  LOGICAL_FIELD_READER,
  deriveLogicalFieldBindings,
  logicalFieldReaderFloor,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import { resolveReportChoices } from '../../packages/canonical-model/src/declared-report.js';
import { formulaFieldType } from '../../packages/canonical-model/src/formula-validation-bindings.js';
import { displayTypeForField } from '../../packages/canonical-model/src/calculated-display-bindings.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/protocol.js';
import { literalValidationDraft } from '../../packages/customization/src/validation-draft.js';
import { compileLiteralFormulaRules } from '../../packages/compiler/src/formula-validation-plan.js';
import * as customization from '../../packages/customization/src/index.js';
import {
  allowedTextsContractProblem,
  logicalFieldBindingsProblem,
} from '../../packages/postgres-provider/src/logical-field-admission.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { logicalSuffix } from '../../apps/web/src/surface-composition.js';
import { renderValueControl } from '../../apps/web/src/editor-controls.js';
import { headerCurrencyFieldIds } from '../../apps/web/src/document-editor.js';
import type { CompiledLogicalField } from '../../apps/web/src/surface-contract.js';

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
const order = `${NS}:entity.custom_work_order`;
const lines = `${NS}:entity.custom_work_order_lines`;
const parentLink = `${NS}:relation.custom_work_order_lines_parent`;
const h = (local: string) => `${NS}:field.custom_work_order_${local}`;
const l = (local: string) => `${NS}:field.custom_work_order_lines_${local}`;
const orderType = {
  kind: 'addRecordType',
  label: 'Work order',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Name', type: 'text', required: true },
    { label: 'Currency', type: 'currency' },
  ],
};
const lineTable = {
  kind: 'addLineTable',
  entity: order,
  label: 'Lines',
  fields: [
    { label: 'Task', type: 'text' },
    { label: 'Hours', type: 'quantity', scale: 2, unit: 'h' },
    {
      label: 'Rate',
      type: 'money',
      currency: { kind: 'stored', fieldLabel: 'Currency' },
    },
    { label: 'Discount', type: 'decimal', scale: 2 },
    { label: 'Notes', type: 'longText' },
    { label: 'Fee', type: 'money', currency: { kind: 'fixed', code: 'CAD' } },
    { label: 'Line currency', type: 'currency' },
    {
      label: 'Duty',
      type: 'money',
      currency: { kind: 'stored', fieldLabel: 'Line currency' },
    },
  ],
};
const patch = (input: unknown) =>
  customization.CustomizationPatchSchema.parse(input);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Forged = Record<string, any>;

function applied(chain: unknown[]): Forged {
  const result = customization.applyCustomizationPatches(
    base,
    chain.map(patch),
  );
  assert.ok(result.status === 'applied', JSON.stringify(result));
  return result.authored as Forged;
}
async function compileFrom(
  authored: Forged,
  chain: unknown[],
): Promise<customization.SandboxResponse> {
  return customization.compileInSandbox({
    acknowledgement,
    base: authored,
    chain: chain.map(patch),
    tip: customization.serializeRelease(tip),
  });
}
function released(result: customization.SandboxResponse) {
  assert.ok(result.status === 'compiled', JSON.stringify(result).slice(0, 900));
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
      ) as Forged,
    };
  };
  return {
    surface: read(PROJECTION_FAMILY_IDS.surfaceManifest),
    operation: read(PROJECTION_FAMILY_IDS.operationCatalog),
  };
}
/** The diagnostics a normalization throws, or "admitted". */
const refusalOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return JSON.stringify(
      (error as { diagnostics?: unknown }).diagnostics ?? String(error),
    );
  }
  return 'admitted';
};
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

test('the currency path is REPORTS-1 slice 2 link-path encoding: one or two relation IDs, absent for the record itself', () => {
  assert.equal(CurrencyViaSchema.safeParse([parentLink]).success, true);
  assert.equal(
    CurrencyViaSchema.safeParse([parentLink, `${NS}:relation.other`]).success,
    true,
  );
  for (const wrong of [[], [parentLink, parentLink, parentLink], parentLink])
    assert.equal(CurrencyViaSchema.safeParse(wrong).success, false);
  const stored = {
    kind: 'stored',
    fieldId: h('currency'),
    codes: ['CAD', 'USD', 'EUR'],
  };
  // The key is `via`, optional, and only on a stored binding.
  assert.equal(ReportCurrencyBindingSchema.safeParse(stored).success, true);
  assert.equal(
    ReportCurrencyBindingSchema.safeParse({ ...stored, via: [parentLink] })
      .success,
    true,
  );
  assert.equal(
    ReportCurrencyBindingSchema.safeParse({ ...stored, path: [parentLink] })
      .success,
    false,
  );
  assert.equal(
    ReportCurrencyBindingSchema.safeParse({
      kind: 'fixed',
      currencyCode: 'CAD',
      via: [parentLink],
    }).success,
    false,
  );
});

test('Customize writes a line amount in the header currency with the parent-link path', () => {
  const result = customization.applyCustomizationPatches(
    base,
    [orderType, lineTable].map(patch),
  );
  const amounts =
    result.status === 'applied'
      ? (result.authored.entities as Forged[]).find(
          (e) => e.entityId === lines,
        )!.reportSource.amounts
      : result.status;
  assert.deepEqual(
    amounts,
    [
      {
        fieldId: l('rate'),
        currency: {
          kind: 'stored',
          fieldId: h('currency'),
          via: [parentLink],
          codes: ['CAD', 'USD', 'EUR'],
        },
      },
      { fieldId: l('fee'), currency: { kind: 'fixed', currencyCode: 'CAD' } },
      {
        fieldId: l('duty'),
        currency: {
          kind: 'stored',
          fieldId: l('line_currency'),
          codes: ['CAD', 'USD', 'EUR'],
        },
      },
    ],
    'a line amount lost its header currency path',
  );
});

test('a line long-text field is edited in a text area', () => {
  const editor = (applied([orderType, lineTable]).surfaces as Forged[]).find(
    (s) => s.surfaceId === `${NS}:surface.custom_work_order_form`,
  )!.documentEditor;
  assert.deepEqual(
    (editor.lineFields as Forged[]).find((x) => x.fieldId === l('notes'))!
      .presentation,
    { kind: 'multiline' },
    'a line long-text field is not a text area',
  );
});

test('a line currency field is searchable, like a record currency field', () => {
  // Release verification cannot hold a 3-character value out of search, so
  // a non-searchable line currency fails approval.
  const field = (applied([orderType, lineTable]).fields as Forged[]).find(
    (x) => x.fieldId === l('line_currency'),
  )!;
  assert.equal(
    field.searchable,
    true,
    'a line currency field is held out of search',
  );
});

test('a line table holds every logical kind; line money reads a fixed, a line or a header currency', async () => {
  const { surface, operation } = released(
    await compileFrom(base, [orderType, lineTable]),
  );
  assert.equal(surface.floor, LINE_LOGICAL_FIELD_READER);
  const bindings = new Map(
    (surface.payload.logicalFieldBindings as Forged[]).map((b) => [
      b.fieldId,
      b,
    ]),
  );
  assert.deepEqual(bindings.get(l('rate'))!.currency.via, [parentLink]);
  assert.equal(bindings.get(l('hours'))!.unit.label, 'h');
  assert.equal(bindings.get(l('discount'))!.scale, 2);
  assert.equal(bindings.get(l('notes'))!.logicalType, 'longText');
  // The line currency's write contract carries its codes.
  const contracts = (operation.payload.operations as Forged[]).flatMap(
    (o) => (o.inputContract?.fields ?? []) as Forged[],
  );
  const lineCurrency = contracts.filter(
    (x) => x.fieldId === l('line_currency'),
  );
  assert.ok(lineCurrency.length > 0);
  for (const contract of lineCurrency)
    assert.deepEqual(contract.allowedTexts, ['CAD', 'USD', 'EUR']);
});

test('a currency label on both the line and its header is refused as ambiguous', () => {
  const result = customization.applyCustomizationPatches(
    base,
    [
      orderType,
      {
        ...lineTable,
        fields: [
          { label: 'Task', type: 'text' },
          { label: 'Currency', type: 'currency' },
          {
            label: 'Rate',
            type: 'money',
            currency: { kind: 'stored', fieldLabel: 'Currency' },
          },
        ],
      },
    ].map(patch),
  );
  assert.notEqual(
    result.status,
    'applied',
    'an ambiguous currency label was resolved',
  );
  assert.match(JSON.stringify(result), /name the one to read by its field ID/u);
});

test('the report source refuses a currency path that is not the line parent link', () => {
  const authored = applied([orderType, lineTable]);
  const rate = (authored.entities as Forged[])
    .find((e) => e.entityId === lines)!
    .reportSource.amounts.find((a: Forged) => a.fieldId === l('rate'));
  rate.currency.via = [
    `${NS}:relation.custom_work_order_lines_parent`,
    parentLink,
  ];
  assert.match(
    refusalOf(() => normalizeApplicationPackage(authored)),
    /A stored currency path must be the line's own parent link/u,
    'a two-hop currency path was admitted',
  );
});

/** The bindings of a normalized line definition after `forge` edits it. */
function derivedAfter(forge: (definition: Forged) => void) {
  const forged = structuredClone(
    normalizeApplicationPackage(applied([orderType, lineTable])),
  ) as unknown as Forged;
  forge(forged);
  return deriveLogicalFieldBindings(
    forged as Parameters<typeof deriveLogicalFieldBindings>[0],
  );
}
const relation = (definition: Forged) =>
  (definition.relations as Forged[]).find((r) => r.relationId === parentLink)!;
const pathRefusal = /reads a declared currency field of the line's header/u;

test('a reference link from the line is not a currency path', () => {
  const outcome = derivedAfter((definition) => {
    const link = structuredClone(relation(definition));
    link.relationId = `${NS}:relation.custom_work_order_lines_site`;
    link.ownership = 'reference';
    (definition.relations as Forged[]).push(link);
    (definition.entities as Forged[])
      .find((e) => e.entityId === lines)!
      .reportSource.amounts.find(
        (a: Forged) => a.fieldId === l('rate'),
      ).currency.via = [link.relationId];
  });
  assert.equal(outcome.status, 'refused', 'a reference link was admitted');
  assert.match((outcome as { message: string }).message, pathRefusal);
});

test("a parent link from another record type is not the line's currency path", () => {
  const outcome = derivedAfter((definition) => {
    relation(definition).sourceEntity.targetId = order;
  });
  assert.equal(
    outcome.status,
    'refused',
    'a path from another record type was admitted',
  );
  assert.match((outcome as { message: string }).message, pathRefusal);
});

test('a retired parent link is not a currency path', () => {
  const outcome = derivedAfter((definition) => {
    relation(definition).lifecycle = 'retired';
  });
  assert.equal(outcome.status, 'refused', 'a retired parent link was admitted');
  assert.match((outcome as { message: string }).message, pathRefusal);
});

test('only a declared money field reads its currency through a path', () => {
  const authored = applied([orderType, lineTable]);
  authored.logicalFields = (authored.logicalFields as Forged[]).filter(
    (d) => d.fieldId !== l('rate'),
  );
  assert.match(
    refusalOf(() => normalizeApplicationPackage(authored)),
    /A currency read through a path belongs to a declared money field/u,
    'an undeclared amount read its currency through a path',
  );
});

test('a header currency read through the path must be a declared currency field of the header', () => {
  const normalized = normalizeApplicationPackage(
    applied([orderType, lineTable]),
  ) as unknown as Forged;
  const forged = structuredClone(normalized);
  forged.logicalFields = (forged.logicalFields as Forged[]).filter(
    (d) => d.fieldId !== h('currency'),
  );
  const outcome = deriveLogicalFieldBindings(
    forged as Parameters<typeof deriveLogicalFieldBindings>[0],
  );
  assert.equal(
    outcome.status,
    'refused',
    'an undeclared header currency was bound',
  );
  assert.match(
    (outcome as { message: string }).message,
    /reads a declared currency field of the line's header/u,
  );
});

test('a retired currency field of another record type is not skipped as bound', () => {
  // Slice-1 follow-up (rule 14): only the holding record type's own retired
  // currency stays bound; naming another type's retired field refuses.
  const authored = applied([
    orderType,
    lineTable,
    {
      kind: 'addRecordType',
      label: 'Supplier',
      fields: [
        { label: 'Name', type: 'text', required: true },
        { label: 'Currency', type: 'currency' },
      ],
    },
  ]);
  (authored.fields as Forged[]).find(
    (x) => x.fieldId === `${NS}:field.custom_supplier_currency`,
  )!.lifecycle = 'retired';
  const duty = (authored.entities as Forged[])
    .find((e) => e.entityId === lines)!
    .reportSource.amounts.find((a: Forged) => a.fieldId === l('duty'));
  duty.currency.fieldId = `${NS}:field.custom_supplier_currency`;
  assert.match(
    refusalOf(() => normalizeApplicationPackage(authored)),
    /three-character currency field on the amount record or its header/u,
    "another record type's retired currency was skipped",
  );
});

const floorOf = (def: unknown) =>
  logicalFieldReaderFloor(def as Parameters<typeof logicalFieldReaderFloor>[0]);

test('the line rung: line declarations raise the floor, nothing else does', () => {
  // A line table with a quantity alone: a line declaration, no path.
  const plainLines = normalizeApplicationPackage(
    applied([
      orderType,
      {
        ...lineTable,
        fields: [
          { label: 'Task', type: 'text' },
          { label: 'Hours', type: 'quantity', scale: 2, unit: 'h' },
        ],
      },
    ]),
  );
  assert.equal(
    floorOf(plainLines),
    LINE_LOGICAL_FIELD_READER,
    'a line declaration did not raise the floor',
  );
  assert.equal(
    floorOf(normalizeApplicationPackage(applied([orderType, lineTable]))),
    LINE_LOGICAL_FIELD_READER,
  );
  assert.equal(
    floorOf(normalizeApplicationPackage(applied([orderType]))),
    LOGICAL_FIELD_READER,
  );
  assert.equal(floorOf(normalizeApplicationPackage(base)), null);
});

test('a forged path-read currency raises the floor without a line declaration', () => {
  // A forged revision whose header amount reads through a path, with no line
  // declaration, still asks for the line rung.
  const forged = structuredClone(
    normalizeApplicationPackage(applied([orderType])),
  ) as unknown as Forged;
  (forged.entities as Forged[]).find(
    (e) => e.entityId === order,
  )!.reportSource = {
    amounts: [
      {
        fieldId: h('deposit'),
        currency: {
          kind: 'stored',
          fieldId: h('currency'),
          via: [parentLink],
          codes: ['CAD'],
        },
      },
    ],
  };
  assert.equal(
    floorOf(forged),
    LINE_LOGICAL_FIELD_READER,
    'a path-read currency did not raise the floor',
  );
});

test('serving refuses line logical fields below the line rung, and the line rung without them', () => {
  const lined = normalizeApplicationPackage(applied([orderType, lineTable]));
  const headerOnly = normalizeApplicationPackage(applied([orderType]));
  const derived = deriveLogicalFieldBindings(
    lined as unknown as Parameters<typeof deriveLogicalFieldBindings>[0],
  );
  assert.ok(derived.status === 'bound');
  const payload = { logicalFieldBindings: derived.bindings };
  assert.equal(
    logicalFieldBindingsProblem(
      payload,
      LINE_LOGICAL_FIELD_READER,
      bytes(lined),
    ),
    null,
  );
  assert.equal(
    logicalFieldBindingsProblem(payload, LOGICAL_FIELD_READER, bytes(lined)),
    'line logical fields need the line logical field surface reader floor.',
    'a line declaration was served below the line rung',
  );
  const plain = deriveLogicalFieldBindings(
    headerOnly as unknown as Parameters<typeof deriveLogicalFieldBindings>[0],
  );
  assert.ok(plain.status === 'bound');
  assert.equal(
    logicalFieldBindingsProblem(
      { logicalFieldBindings: plain.bindings },
      LINE_LOGICAL_FIELD_READER,
      bytes(headerOnly),
    ),
    'line logical field floor without line logical fields.',
    'an unexplained line rung was served',
  );
});

test('the write contracts must carry exactly the declared allowed values', async () => {
  const { operation } = released(
    await compileFrom(base, [orderType, lineTable]),
  );
  const definition = normalizeApplicationPackage(
    applied([orderType, lineTable]),
  );
  assert.equal(
    allowedTextsContractProblem(operation.payload, bytes(definition)),
    null,
  );
  const stripped = structuredClone(operation.payload);
  for (const o of stripped.operations as Forged[])
    for (const x of (o.inputContract?.fields ?? []) as Forged[])
      if (x.fieldId === l('line_currency')) delete x.allowedTexts;
  assert.match(
    allowedTextsContractProblem(stripped, bytes(definition)) ?? '',
    /disagrees with the allowed values declared/u,
    'a contract without its declared codes was admitted',
  );
  const widened = structuredClone(operation.payload);
  for (const o of widened.operations as Forged[])
    for (const x of (o.inputContract?.fields ?? []) as Forged[])
      if (x.fieldId === h('currency')) x.allowedTexts = ['CAD', 'USD', 'GBP'];
  assert.match(
    allowedTextsContractProblem(widened, bytes(definition)) ?? '',
    /disagrees with the allowed values declared/u,
  );
});

test('header-read line money has no single currency: formulas and calculated displays refuse it', () => {
  const normalized = normalizeApplicationPackage(
    applied([orderType, lineTable]),
  ) as unknown as Forged;
  const field = (id: string) =>
    (normalized.fields as Forged[]).find((x) => x.fieldId === id)!;
  const typed = (id: string) =>
    formulaFieldType(
      field(id) as Parameters<typeof formulaFieldType>[0],
      normalized as Parameters<typeof formulaFieldType>[1],
    );
  assert.equal(typed(l('rate')), null, 'header-read money was typed');
  assert.equal(typed(l('duty')), null);
  assert.equal(
    (typed(l('fee')) as { currency: string | null }).currency,
    'CAD',
  );
  const display = (id: string) =>
    displayTypeForField(
      field(id) as Parameters<typeof displayTypeForField>[0],
      normalized as Parameters<typeof displayTypeForField>[1],
    );
  assert.equal(display(l('rate')), null);
  assert.equal(display(l('fee'))?.currency, 'CAD');
});

test('a v1 report never reads a currency through a path', () => {
  const amount = {
    fieldId: l('rate'),
    type: 'decimal',
    precision: 18,
    scale: 2,
    presence: 'optional',
    classification: 'internal',
    currency: {
      kind: 'stored',
      fieldId: h('currency'),
      via: [parentLink],
      codes: ['CAD', 'USD', 'EUR'],
    },
  };
  const offer = {
    source: {
      kind: 'generatedCollection',
      grain: 'record',
      listSurfaceId: `${NS}:surface.custom_work_order_lines_list`,
      queryId: `${NS}:query.custom_work_order_lines_list`,
      entityId: lines,
      readPermissionId: `${NS}:permission.custom_work_order_lines_read`,
      scope: 'company',
    },
    label: 'Lines',
    fields: [
      { operand: amount, label: 'Rate' },
      // Present on the offer, so only the path refuses.
      {
        operand: {
          fieldId: h('currency'),
          type: 'text',
          maximumLength: 3,
          collation: 'binary',
          presence: 'optional',
          classification: 'internal',
        },
        label: 'Currency',
      },
      {
        operand: {
          fieldId: l('task'),
          type: 'text',
          maximumLength: 240,
          collation: 'unicodeCaseInsensitive',
          presence: 'optional',
          classification: 'internal',
        },
        label: 'Task',
      },
    ],
  };
  const result = resolveReportChoices(
    offer as never,
    {
      dimensions: [{ kind: 'direct', fieldId: l('task') }],
      filters: [],
      measures: [
        {
          kind: 'inline',
          measureId: `${NS}:measure.custom_rate`,
          label: 'Rate',
          operator: { kind: 'sum', fieldId: l('rate') },
        },
      ],
      outputs: [{ kind: 'table' }],
    } as never,
  );
  assert.equal(result, h('currency'), 'a v1 body read a header currency');
});

test('the witness synthesizer draws a line currency field only from its codes', () => {
  const authored = applied([orderType, lineTable]);
  const normalized = normalizeApplicationPackage(authored) as unknown as Forged;
  const create = (normalized.operations as Forged[]).find(
    (o) => o.operationId === `${NS}:operation.custom_work_order_lines_create`,
  )!;
  const update = (normalized.operations as Forged[]).find(
    (o) => o.operationId === `${NS}:operation.custom_work_order_lines_update`,
  )!;
  // The literal rule Customize writes for a record field, drawn for the line
  // type's own create and update.
  const rule = literalValidationDraft(
    {
      entityId: lines,
      label: 'Lines',
      operationIds: [String(create.operationId), String(update.operationId)],
      fields: [
        {
          fieldId: l('line_currency'),
          label: 'Line currency',
          valueType: { kind: 'text' },
        },
      ],
    },
    {
      fieldId: l('line_currency'),
      check: 'required',
      limit: '',
      message: 'Choose the line currency.',
    },
  );
  const plan = compileLiteralFormulaRules(
    normalizeApplicationPackage(applied([orderType, lineTable, rule])),
  );
  assert.ok(plan.status === 'compiled', JSON.stringify(plan).slice(0, 900));
  const seen: unknown[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object')
      for (const [key, inner] of Object.entries(value)) {
        if (key === l('line_currency')) seen.push(inner);
        walk(inner);
      }
  };
  walk(plan.payload.witnesses);
  assert.ok(seen.length > 0, 'no witness names the line currency');
  for (const value of seen)
    assert.ok(
      value === null ||
        ['CAD', 'USD', 'EUR'].includes(
          String((value as { value?: unknown } | null)?.value ?? value),
        ),
      `a line witness writes a value the field does not allow: ${JSON.stringify(value)}`,
    );
});

const binding = (currency: unknown): CompiledLogicalField =>
  ({
    fieldId: l('rate'),
    entityId: lines,
    logicalType: 'money',
    scale: 2,
    currency,
  }) as CompiledLogicalField;
const viaHeader = binding({
  kind: 'stored',
  fieldId: h('currency'),
  via: [parentLink],
  codes: ['CAD', 'USD', 'EUR'],
});

test("a line amount shows its header's currency, and says so without the header", () => {
  const line = { values: { [h('currency')]: 'CAD' } };
  const header = { values: { [h('currency')]: 'USD' } };
  assert.equal(
    logicalSuffix(viaHeader, line, header),
    'USD',
    "a line amount ignored its header's currency",
  );
  assert.equal(logicalSuffix(viaHeader, line), '(header currency)');
  assert.equal(
    logicalSuffix(viaHeader, line, { values: { [h('currency')]: 'GBP' } }),
    '(no listed currency)',
  );
});

test("the editor's line cell reads its header's currency", () => {
  const html = renderValueControl({
    row: { id: 'line-1', values: { [l('rate')]: '95.5' } },
    field: { fieldId: l('rate'), label: 'Rate' },
    compiled: {
      fieldId: l('rate'),
      kind: 'exactDecimalFieldType',
      required: false,
      logical: viaHeader,
    },
    input: {
      fieldId: l('rate'),
      kind: 'exactDecimalFieldType',
      required: false,
      bounds: { maximumLength: null, precision: 18, scale: 2 },
    },
    frozen: false,
    index: 0,
    accessibleName: null,
    focus: null,
    error: null,
    header: { id: 'header', values: { [h('currency')]: 'USD' } },
  } as never);
  assert.match(html, /step="0\.01"/u);
  assert.match(
    html,
    /data-field-unit>USD<\/span>/u,
    'the editor line cell lost its header currency',
  );
});

test('the editor refreshes lines when the header currency they read changes', () => {
  assert.deepEqual(
    headerCurrencyFieldIds([
      { logical: viaHeader },
      {
        logical: binding({
          kind: 'stored',
          fieldId: l('line_currency'),
          codes: ['CAD'],
        }),
      },
      { logical: binding({ kind: 'fixed', currencyCode: 'CAD' }) },
      {},
    ]),
    [h('currency')],
    'the header currency is not a line source',
  );
});

test("the approval text names the header's currency for a line amount", async () => {
  const result = await compileFrom(base, [orderType, lineTable]);
  assert.ok(result.status === 'compiled', JSON.stringify(result).slice(0, 400));
  const text = JSON.stringify(result.steps.at(-1));
  for (const line of [
    "Rate (money in the Work order's Currency (CAD, USD, EUR))",
    "Duty (money in the record's Line currency (CAD, USD, EUR))",
    'Fee (money in CAD)',
    'Hours (quantity in h, 2 decimals)',
    'Notes (long text)',
  ])
    assert.ok(text.includes(line), `the approval text lacks "${line}"`);
});

test('the drafter is told a line money field may read its header currency', () => {
  const schema = JSON.stringify(customization.drafterToolSchema());
  assert.match(schema, /looked up on the line first, then on its record/u);
  const kinds = customization.drafterKindLines().join('\n');
  assert.match(kinds, /line money field in the header currency/u);
});

const later = [
  {
    kind: 'addField',
    entity: order,
    field: { label: 'Site', type: 'text' },
  },
  {
    kind: 'arrangeLayout',
    surface: `${NS}:surface.custom_work_order_list`,
    relabel: [{ field: h('name'), label: 'Order' }],
  },
  {
    kind: 'arrangeLayout',
    surface: `${NS}:surface.custom_work_order_lines_list`,
    relabel: [{ field: l('task'), label: 'Job' }],
  },
];
/** The authored line definition with these fields retired in the base. */
function retiring(...ids: string[]): Forged {
  const retired = structuredClone(applied([orderType, lineTable]));
  for (const id of ids)
    (retired.fields as Forged[]).find((x) => x.fieldId === id)!.lifecycle =
      'retired';
  return retired;
}
/** The compile's surface, or a red naming what refused a later compile. */
function compiledLater(result: customization.SandboxResponse, what: string) {
  assert.equal(
    result.status,
    'compiled',
    `${what} refused a later compile: ${JSON.stringify(result).slice(0, 600)}`,
  );
  return released(result).surface;
}

test('rule 10: with line money active, adding a field and arranging both lists compile', async () => {
  const surface = compiledLater(
    await compileFrom(applied([orderType, lineTable]), later),
    'an active line amount',
  );
  assert.equal(surface.floor, LINE_LOGICAL_FIELD_READER);
});

test('rule 10: a retired header currency leaves its line amounts bound, and later compiles still pass', async () => {
  // The header currency retires while the line rate reading it stays live.
  const surface = compiledLater(
    await compileFrom(retiring(h('currency')), later),
    'a retired header currency',
  );
  const ids = (surface.payload.logicalFieldBindings as Forged[]).map(
    (b) => b.fieldId,
  );
  assert.equal(ids.includes(h('currency')), false);
  assert.ok(ids.includes(l('rate')), 'the line rate lost its binding');
});

test('rule 10: a retired line currency leaves its line amounts bound, and later compiles still pass', async () => {
  const surface = compiledLater(
    await compileFrom(retiring(l('line_currency')), later),
    'a retired line currency',
  );
  const ids = (surface.payload.logicalFieldBindings as Forged[]).map(
    (b) => b.fieldId,
  );
  assert.ok(ids.includes(l('duty')), 'the line duty lost its binding');
});

test('rule 10: after line money, its header currency and a line quantity retire, adding a field and arranging both lists still compile', async () => {
  const retiredBase = retiring(
    l('rate'),
    h('currency'),
    l('hours'),
    l('duty'),
    l('line_currency'),
  );
  const surface = compiledLater(
    await compileFrom(retiredBase, later),
    'retired line fields',
  );
  const ids = (surface.payload.logicalFieldBindings as Forged[]).map(
    (b) => b.fieldId,
  );
  for (const id of [l('rate'), h('currency'), l('hours')])
    assert.equal(ids.includes(id), false, id);
  // Retired declarations still hold the line rung.
  assert.equal(surface.floor, LINE_LOGICAL_FIELD_READER);
  const source = (
    normalizeApplicationPackage(retiredBase).entities as Forged[]
  ).find((e) => e.entityId === lines)!.reportSource;
  assert.equal(source.amounts.length, 3);
});

test('rule 10: a label-only base change replays the later changes clean, active and retired', async () => {
  for (const ids of [[], [l('rate'), h('currency')]]) {
    const relabelled = retiring(...ids);
    // Labels only: the bindings name fields by ID.
    (relabelled.fields as Forged[]).find(
      (x) => x.fieldId === h('currency'),
    )!.label = 'Billing currency';
    (relabelled.fields as Forged[]).find(
      (x) => x.fieldId === l('rate'),
    )!.label = 'Hourly rate';
    const changes = later.map(patch);
    const result = await customization.compileInSandbox({
      acknowledgement,
      base: relabelled,
      chain: changes,
      tip: customization.serializeRelease(tip),
      upgradeBaseRoot: customization.serializeRelease(tip).releaseRoot,
      origins: changes.map((_, i) => ({
        patchId: randomUUID(),
        differentBase: true,
        ...(i === 0 && { parent: applied([orderType, lineTable]) }),
      })),
    });
    compiledLater(result, `a label-only base change (${ids.length} retired)`);
  }
});
