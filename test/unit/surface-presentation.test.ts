import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  normalizeApplicationPackage,
  PRESENTATION_READER,
  presentRow,
  evaluableTones,
  bindToneCondition,
  PresentationProblem,
  surfacePlacements,
  PLACEMENT_KINDS,
  TONE_PLACEMENTS,
  CONTEXT_OPERAND_IDS,
  type CompiledPresentation,
} from '../../packages/canonical-model/src/index.js';
import { PROJECTION_FAMILY_IDS } from '../../packages/compiler/src/index.js';
import * as customization from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { presentationDeclarationProblem } from '../../packages/postgres-provider/src/presentation-admission.js';
import { projectionPayload } from '../compiler/helpers.js';
import { compilePresentation as compilePresentationFn } from '../../packages/canonical-model/src/surface-presentation.js';

type Json = Record<string, unknown>;
const file = 'apps/web/release/app.authored.json';
const authored: Json = JSON.parse(readFileSync(file, 'utf8'));
const tip = parseCompiledApplication(
  JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
).application;
const acknowledgement = readUnboundPermissionAcknowledgementFor(
  file,
  'northstar.app:package.application',
);
const ns = 'northstar.app';
const patch = (input: unknown) =>
  customization.CustomizationPatchSchema.parse(input);
function applied(source: Json, changes: unknown[]): Json {
  const result = customization.applyCustomizationPatches(
    source,
    changes.map(patch),
  );
  assert.ok(result.status === 'applied', JSON.stringify(result));
  return result.authored as Json;
}
const targetsOf = (definition: Json) =>
  customization.customizationTargets(
    normalizeApplicationPackage(definition) as unknown as Parameters<
      typeof customization.customizationTargets
    >[0],
  ).presentation!;

// Three businesses, three apps with different names and IDs (rule 16).
const stockItem = {
  kind: 'addRecordType',
  label: 'Stock item',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Name', type: 'text', required: true },
    { label: 'On hand', type: 'number' },
    { label: 'Reorder point', type: 'number' },
  ],
};
const visit = {
  kind: 'addRecordType',
  label: 'Visit',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Patient', type: 'text', required: true },
    { label: 'Outcome', type: 'choice', options: ['Seen', 'No-show'] },
  ],
};
const rental = {
  kind: 'addRecordType',
  label: 'Rental',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Contract', type: 'text', required: true },
    { label: 'Units out', type: 'number' },
    { label: 'Units returned', type: 'number' },
  ],
};
const stock = (local: string) => `${ns}:field.custom_stock_item_${local}`;
const stockList = `${ns}:surface.custom_stock_item_list`;
const lowStock = (extra: Json = {}) => ({
  kind: 'addPresentationRevision',
  surface: stockList,
  tones: [
    {
      target: 'cell',
      fieldId: stock('on_hand'),
      operator: 'lessThan',
      compareTo: { fieldId: stock('reorder_point') },
      tone: 'blocked',
      reason: 'Low stock',
    },
    {
      target: 'row',
      fieldId: stock('on_hand'),
      operator: 'lessThan',
      compareTo: { fieldId: stock('reorder_point') },
      tone: 'attention',
      reason: 'Reorder',
    },
  ],
  columns: [{ fieldId: stock('name'), width: 'wide', overflow: 'truncate' }],
  density: 'comfortable',
  ...extra,
});

const base = applied(authored, [stockItem]);
const member = (definition: Json, draft: unknown) =>
  customization.presentationMember(targetsOf(definition), draft);

test('the placement model names every surface kind and a tone target set, derived from the compiled surface', () => {
  assert.deepEqual(PLACEMENT_KINDS, [
    'formHeader',
    'formSection',
    'field',
    'listToolbar',
    'listRow',
    'listCell',
    'lineTableToolbar',
    'lineRow',
    'lineCell',
    'boardCard',
    'metricCard',
    'homeSection',
  ]);
  assert.ok(TONE_PLACEMENTS.every((k) => PLACEMENT_KINDS.includes(k)));
  const model = normalizeApplicationPackage(base) as unknown as {
    surfaces: Json[];
    queries: Json[];
  };
  const list = model.surfaces.find((s) => s.surfaceId === stockList)!;
  const kinds = surfacePlacements(model, list).map((p) => p.kind);
  assert.ok(kinds.includes('listRow') && kinds.includes('listCell'));
  const detail = model.surfaces.find(
    (s) => s.surfaceId === `${ns}:surface.custom_stock_item_detail`,
  )!;
  assert.ok(
    surfacePlacements(model, detail).some(
      (p) => p.kind === 'field' && p.fieldId === stock('on_hand'),
    ),
  );
});

test('a between-field condition tones the cell and the row, three-valued, and never guesses a withheld value', () => {
  const revision = member(base, lowStock());
  const defn = applied(base, [revision]);
  const model = normalizeApplicationPackage(defn) as unknown as {
    surfaces: Json[];
  };
  const surface = model.surfaces.find((s) => s.surfaceId === stockList)!;
  const compiled = compilePresentationFn(model as never, surface);
  const rules = evaluableTones(compiled);
  const row = (values: Json) => presentRow(rules, values);
  const low = row({ [stock('on_hand')]: '2', [stock('reorder_point')]: '5' });
  assert.equal(low.cells.get(stock('on_hand'))?.tone, 'blocked');
  assert.equal(low.cells.get(stock('on_hand'))?.reason, 'Low stock');
  assert.equal(low.row?.tone, 'attention');
  const fine = row({ [stock('on_hand')]: '9', [stock('reorder_point')]: '5' });
  assert.equal(fine.cells.size, 0);
  assert.equal(fine.row, null);
  const equal = row({ [stock('on_hand')]: '5', [stock('reorder_point')]: '5.0' });
  assert.equal(equal.row, null);
  const unknown = row({ [stock('on_hand')]: null, [stock('reorder_point')]: '5' });
  assert.equal(unknown.row, null);
  assert.deepEqual(unknown.unavailable, []);
  // A field the viewer may not read is absent from the row: no tone, and the
  // rule is reported unavailable rather than judged.
  const hidden = row({ [stock('on_hand')]: '2' });
  assert.equal(hidden.row, null);
  assert.equal(hidden.cells.size, 0);
  assert.equal(hidden.unavailable.length, 2);
});


test('a condition binds only values the list reads, of one type, and refuses linked records, context values and unrendered placements by name', () => {
  const model = normalizeApplicationPackage(base) as unknown as Json;
  const operands = targetsOf(base).find((t) => t.surfaceId === stockList)!
    .operands;
  const field = (fieldId: string) => ({
    schemaVersion: 'v6' as const,
    kind: 'field' as const,
    fieldId,
    select: 'value' as const,
  });
  const compare = (left: unknown, right: unknown) => ({
    schemaVersion: 'v6' as const,
    kind: 'comparison' as const,
    operator: 'lessThan' as const,
    left,
    right,
  });
  const refused = (when: unknown, subject: string) =>
    assert.throws(
      () => bindToneCondition(operands, 'r', when as never),
      (error: unknown) =>
        error instanceof PresentationProblem && error.subject === subject,
    );
  refused(
    compare(field(stock('on_hand')), field(`${ns}:field.item_sku`)),
    `${ns}:field.item_sku`,
  );
  refused(
    compare(field(stock('on_hand')), {
      schemaVersion: 'v6',
      kind: 'path',
      relationIds: [`${ns}:relation.x_y`],
      fieldId: stock('reorder_point'),
    }),
    'r',
  );
  refused(
    compare(field(stock('on_hand')), field(CONTEXT_OPERAND_IDS.today)),
    CONTEXT_OPERAND_IDS.today,
  );
  refused(compare(field(stock('on_hand')), field(stock('name'))), 'r');
  // An unrendered placement is named; the stored member already accepts it.
  const revision = member(base, lowStock());
  const widened = structuredClone(revision);
  widened.toneRules[0]!.target = {
    schemaVersion: 'v6',
    kind: 'metricCard',
    metricId: 'open_orders',
  };
  const outcome = customization.applyCustomizationPatches(base, [widened]);
  assert.equal(outcome.status, 'refused');
  assert.match(JSON.stringify(outcome), /metricCard placement/u);
  void model;
});

test('the member persists choices by stable ID: a field add and a relabel keep it, a stale revision is refused, and a retired one is not validated', () => {
  const first = member(base, lowStock());
  let defn = applied(base, [first]);
  defn = applied(defn, [
    {
      kind: 'addField',
      entity: `${ns}:entity.custom_stock_item`,
      field: { label: 'Bin', type: 'text' },
      screens: 'record',
    },
    {
      kind: 'arrangeLayout',
      surface: stockList,
      relabel: [{ field: stock('on_hand'), label: 'Qty on hand' }],
    },
  ]);
  const stale = structuredClone(first);
  stale.revisionId = '6b0d7a4e-6d2c-4b9e-9a51-1d3c1f7d0a11';
  const refusal = customization.applyCustomizationPatches(defn, [stale]);
  assert.equal(refusal.status, 'refused');
  assert.match(JSON.stringify(refusal), /CUSTOMIZE_PRESENTATION_CONFLICT/u);
  const retired = member(defn, {
    kind: 'addPresentationRevision',
    surface: stockList,
    retire: true,
  });
  assert.equal(retired.status, 'retired');
  defn = applied(defn, [retired]);
  // A retired revision is carried, never validated: corrupt its rule and the
  // definition still normalizes; adding a field still compiles.
  const surface = (defn.surfaces as Json[]).find(
    (s) => s.surfaceId === stockList,
  )!;
  (
    (surface.presentation as Json).toneRules as Json[]
  )[0]!.when = {
    schemaVersion: 'v6',
    kind: 'required',
    operand: {
      schemaVersion: 'v6',
      kind: 'field',
      fieldId: `${ns}:field.gone_forever`,
      select: 'value',
    },
  };
  applied(defn, [
    {
      kind: 'addField',
      entity: `${ns}:entity.custom_stock_item`,
      field: { label: 'Aisle', type: 'text' },
      screens: 'record',
    },
  ]);
});

test('the same block serves a clinic and a rental firm with different names and IDs', () => {
  const clinic = applied(authored, [visit]);
  const outcome = `${ns}:field.custom_visit_outcome`;
  const noShow = member(clinic, {
    kind: 'addPresentationRevision',
    surface: `${ns}:surface.custom_visit_list`,
    tones: [
      {
        target: 'row',
        fieldId: outcome,
        operator: 'equal',
        compareTo: { value: 'No-show' },
        tone: 'attention',
        reason: 'No-show',
      },
    ],
  });
  const clinicModel = normalizeApplicationPackage(
    applied(clinic, [noShow]),
  ) as unknown as { surfaces: Json[] };
  const rules = evaluableTones(
    compilePresentationFn(
      clinicModel as never,
      clinicModel.surfaces.find(
        (s) => s.surfaceId === `${ns}:surface.custom_visit_list`,
      )!,
    ),
  );
  const optionId = (
    noShow.toneRules[0]!.when as { right: { scalar: { value: string } } }
  ).right.scalar.value;
  assert.match(optionId, /no_show/u);
  assert.equal(presentRow(rules, { [outcome]: optionId }).row?.reason, 'No-show');
  assert.equal(presentRow(rules, { [outcome]: 'x' }).row, null);

  const firm = applied(authored, [rental]);
  const field = (local: string) => `${ns}:field.custom_rental_${local}`;
  const late = member(firm, {
    kind: 'addPresentationRevision',
    surface: `${ns}:surface.custom_rental_list`,
    tones: [
      {
        target: 'cell',
        fieldId: field('units_returned'),
        operator: 'lessThan',
        compareTo: { fieldId: field('units_out') },
        tone: 'blocked',
        reason: 'Units still out',
      },
    ],
  });
  applied(firm, [late]);
});

test('a declared presentation compiles at reader rung 49 and admission refuses a compiled key that differs from the declaration', async () => {
  const revision = patch(member(base, lowStock()));
  const compiled = await customization.compileInSandbox({
    acknowledgement,
    base: authored,
    chain: [patch(stockItem), revision],
    tip: customization.serializeRelease(tip),
  });
  assert.ok(compiled.status === 'compiled', JSON.stringify(compiled));
  const floor = (index: number) =>
    customization
      .parseSerializedRelease(compiled.steps[index]!.release)
      .compiled.bundle.releaseManifest.projections.find(
        (p) => p.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
      )!.requiredRuntimeCapability.minimumVersion;
  assert.ok(floor(0) < PRESENTATION_READER);
  assert.equal(floor(1), PRESENTATION_READER);
  const release = customization.parseSerializedRelease(
    compiled.steps[1]!.release,
  );
  const manifest = projectionPayload(
    release.compiled,
    PROJECTION_FAMILY_IDS.surfaceManifest,
  ) as { surfaces: Json[] };
  const definition = JSON.parse(
    Buffer.from(
      compiled.steps[1]!.release.normalizedDefinitionBytesBase64,
      'base64',
    ).toString('utf8'),
  );
  assert.equal(presentationDeclarationProblem(definition, manifest), null);
  const surface = manifest.surfaces.find((s) => s.surfaceId === stockList)!;
  const presentation = surface.presentation as CompiledPresentation;
  assert.ok(presentation.operands);
  const tampered = structuredClone(manifest);
  (
    tampered.surfaces.find((s) => s.surfaceId === stockList)!
      .presentation as CompiledPresentation
  ).revision.toneRules[0]!.tone = 'success';
  assert.match(
    presentationDeclarationProblem(definition, tampered) ?? '',
    /differs/u,
  );
});
