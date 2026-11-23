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
import { DRAFTER_KINDS } from '../../packages/customization/src/ai-draft-kinds.js';
import { renderDeclaredList } from '../../apps/web/src/component-registry.js';
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
  const equal = row({
    [stock('on_hand')]: '5',
    [stock('reorder_point')]: '5.0',
  });
  assert.equal(equal.row, null);
  const unknown = row({
    [stock('on_hand')]: null,
    [stock('reorder_point')]: '5',
  });
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
  const operands = targetsOf(base).find(
    (t) => t.surfaceId === stockList,
  )!.operands;
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
  for (const context of [
    CONTEXT_OPERAND_IDS.today,
    CONTEXT_OPERAND_IDS.currentUser,
  ])
    assert.throws(
      () =>
        bindToneCondition(
          operands,
          'r',
          compare(field(stock('on_hand')), field(context)) as never,
        ),
      /cannot read a context value/u,
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
  // Arranging the list keeps compiling with the rule active: hiding the
  // toned and the sized columns leaves those entries inert, by field ID.
  const arranged = applied(defn, [
    {
      kind: 'arrangeLayout',
      surface: stockList,
      hide: [stock('on_hand'), stock('name')],
    },
  ]);
  const arrangedModel = normalizeApplicationPackage(arranged) as unknown as {
    surfaces: Json[];
  };
  const arrangedList = arrangedModel.surfaces.find(
    (s) => s.surfaceId === stockList,
  )!;
  const hidden = compilePresentationFn(arrangedModel as never, arrangedList);
  const hiddenColumns = (
    arrangedList.list as { columns: { field: string }[] }
  ).columns.map((c) => c.field);
  if (!hiddenColumns.includes(stock('on_hand')))
    assert.ok(
      hidden.inert?.some((entry) => entry.subject === stock('on_hand')),
      JSON.stringify(hidden.inert),
    );
  assert.ok(
    evaluableTones(hidden).every(
      (rule) =>
        rule.target.kind !== 'listCell' ||
        hiddenColumns.includes(rule.target.fieldId),
    ),
  );
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
  ((surface.presentation as Json).toneRules as Json[])[0]!.when = {
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
  assert.equal(
    presentRow(rules, { [outcome]: optionId }).row?.reason,
    'No-show',
  );
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

// ---- UI-CUSTOM-1 slice 1 fix round (Fable review D1-D5, R2) ----

const tonesOn = (definition: Json, surfaceId = stockList) => {
  const model = normalizeApplicationPackage(definition) as unknown as {
    surfaces: Json[];
  };
  return evaluableTones(
    compilePresentationFn(
      model as never,
      model.surfaces.find((s) => s.surfaceId === surfaceId)!,
    ),
  );
};
const band = (reason: string, tone: string, below: string) => ({
  target: 'cell',
  fieldId: stock('on_hand'),
  operator: 'lessThan',
  compareTo: { value: below },
  tone,
  reason,
});
const sandboxSteps = async (chain: unknown[]) => {
  const compiled = await customization.compileInSandbox({
    acknowledgement,
    base: authored,
    chain: chain.map(patch),
    tip: customization.serializeRelease(tip),
  });
  assert.ok(compiled.status === 'compiled', JSON.stringify(compiled));
  return compiled.steps;
};
const lastLines = async (chain: unknown[]) =>
  (await sandboxSteps(chain)).at(-1)!.rendered.lines.join('\n');
// The approval diff of one changed list, rendered as the Customize service
// renders it, without compiling a release for each step.
const diffLines = (from: Json, to: Json) =>
  customization
    .renderReleaseDiff({
      diff: {
        changes: [
          {
            constructKind: 'surfaceDefinition',
            changeKind: 'changed',
            subjectId: stockList,
          },
        ],
      } as never,
      from: normalizeApplicationPackage(from) as never,
      storage: [],
      to: normalizeApplicationPackage(to) as never,
    })
    .lines.join('\n');
const escaped = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

test('an edited rule keeps its place, so earlier rules still win, and the approval diff shows each rule in order with its condition', async () => {
  const v1 = member(base, {
    kind: 'addPresentationRevision',
    surface: stockList,
    tones: [
      band('Low stock', 'blocked', '5'),
      band('Reorder soon', 'attention', '20'),
    ],
  });
  const first = applied(base, [v1]);
  const toneAt = (definition: Json, onHand: string) =>
    presentRow(tonesOn(definition), { [stock('on_hand')]: onHand }).cells.get(
      stock('on_hand'),
    )?.reason;
  assert.equal(toneAt(first, '2'), 'Low stock');
  // Redraft only the red threshold: the rule is replaced where it stands.
  const v2 = member(first, {
    kind: 'addPresentationRevision',
    surface: stockList,
    tones: [band('Low stock', 'blocked', '6')],
  });
  assert.deepEqual(
    v2.toneRules.map((rule) => rule.reason.text),
    ['Low stock', 'Reorder soon'],
  );
  const second = applied(first, [v2]);
  assert.equal(toneAt(second, '2'), 'Low stock');
  assert.equal(toneAt(second, '5'), 'Low stock');
  assert.equal(toneAt(second, '12'), 'Reorder soon');
  // A new rule goes last.
  const v3 = member(second, {
    kind: 'addPresentationRevision',
    surface: stockList,
    tones: [band('Out', 'blocked', '1')],
  });
  assert.deepEqual(
    v3.toneRules.map((rule) => rule.reason.text),
    ['Low stock', 'Reorder soon', 'Out'],
  );
  // The drafter is told that earlier rules win.
  assert.match(
    DRAFTER_KINDS.addPresentationRevision.guidance,
    /earliest rule that holds wins/u,
  );
  const lines = await lastLines([stockItem, v1, v2]);
  assert.match(
    lines,
    /rule 1 of 2: show "Low stock" as blocked on the On hand cell when On hand is below "6"\. An earlier rule that holds wins\./u,
  );
  assert.match(
    lines,
    /rule 2 of 2: show "Reorder soon" as attention on the On hand cell when On hand is below "20"/u,
  );
});

test('a yes/no value is only yes or no: true, yes, false and no bind, anything else is refused by name', () => {
  const clinic = applied(authored, [
    {
      kind: 'addRecordType',
      label: 'Referral',
      companyOwnership: 'entityOwned',
      fields: [
        { label: 'Patient', type: 'text', required: true },
        { label: 'Urgent', type: 'yesNo' },
      ],
    },
  ]);
  const surface = `${ns}:surface.custom_referral_list`;
  const urgent = `${ns}:field.custom_referral_urgent`;
  const draft = (value: string) => ({
    kind: 'addPresentationRevision',
    surface,
    tones: [
      {
        target: 'row',
        fieldId: urgent,
        operator: 'equal',
        compareTo: { value },
        tone: 'attention',
        reason: 'Urgent',
      },
    ],
  });
  const bound = (value: string) =>
    (
      member(clinic, draft(value)).toneRules[0]!.when as {
        right: { scalar: { value: unknown } };
      }
    ).right.scalar.value;
  assert.equal(bound('true'), true);
  assert.equal(bound('Yes'), true);
  assert.equal(bound('false'), false);
  assert.equal(bound('no'), false);
  for (const value of ['checked', '1', 'on'])
    assert.throws(
      () => member(clinic, draft(value)),
      new RegExp(`Give Urgent yes or no .*not "${value}"`, 'u'),
    );
});

test('a retired presentation is followed by a new one, and a stale or repeated retire is refused', () => {
  const first = member(base, lowStock());
  let defn = applied(base, [first]);
  const retired = member(defn, {
    kind: 'addPresentationRevision',
    surface: stockList,
    retire: true,
  });
  defn = applied(defn, [retired]);
  assert.throws(
    () =>
      member(defn, {
        kind: 'addPresentationRevision',
        surface: stockList,
        retire: true,
      }),
    /no presentation to retire/u,
  );
  const again = member(defn, lowStock());
  assert.equal(again.status, 'active');
  assert.equal(again.predecessor, retired.revisionId);
  const stale = customization.applyCustomizationPatches(defn, [
    patch({ ...again, predecessor: null }),
  ]);
  assert.equal(stale.status, 'refused');
  defn = applied(defn, [again]);
  assert.equal(
    presentRow(tonesOn(defn), {
      [stock('on_hand')]: '2',
      [stock('reorder_point')]: '5',
    }).row?.reason,
    'Reorder',
  );
});

test('after a toned or sized column is hidden, the next revision drops the entries that no longer bind and the diff names them', () => {
  const v1 = member(base, {
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
    ],
    columns: [{ fieldId: stock('reorder_point'), width: 'narrow' }],
  });
  const first = applied(base, [v1]);
  const density = {
    kind: 'addPresentationRevision',
    surface: stockList,
    density: 'compact',
  };
  // The toned column is hidden: the rule is dropped, the size kept.
  const hideToned = {
    kind: 'arrangeLayout',
    surface: stockList,
    hide: [stock('on_hand')],
  };
  const toned = applied(first, [hideToned]);
  const afterToned = member(toned, density);
  assert.deepEqual(afterToned.toneRules, []);
  assert.deepEqual(
    afterToned.sizing.map(
      (entry) => entry.kind === 'listColumn' && entry.fieldId,
    ),
    [stock('reorder_point')],
  );
  applied(toned, [afterToned]);
  // The sized column is hidden: the size is dropped.
  const hideSized = {
    kind: 'arrangeLayout',
    surface: stockList,
    hide: [stock('reorder_point')],
  };
  const sized = applied(first, [hideSized]);
  const afterSized = member(sized, density);
  assert.deepEqual(afterSized.sizing, []);
  applied(sized, [afterSized]);
  const lines = diffLines(sized, applied(sized, [afterSized]));
  assert.match(
    lines,
    new RegExp(
      `stop sizing column Reorder point \\(${escaped(stock('reorder_point'))}\\)`,
      'u',
    ),
  );
  assert.match(lines, /use compact density/u);
  const tonedLines = diffLines(toned, applied(toned, [afterToned]));
  assert.match(tonedLines, /remove the colour rule "Low stock"/u);
});

test('presentation applies to a protected first-party list, where layout stays refused (orchestrator ruling on R2)', () => {
  const invoices = `${ns}:surface.customer_invoice_list`;
  const target = targetsOf(authored).find((t) => t.surfaceId === invoices);
  assert.ok(target, 'the invoice list is offered for presentation');
  const column = target.columns[0]!.fieldId;
  const arranged = customization.applyCustomizationPatches(authored, [
    patch({
      kind: 'arrangeLayout',
      surface: invoices,
      relabel: [{ field: column, label: 'Renamed' }],
    }),
  ]);
  assert.equal(arranged.status, 'refused');
  assert.match(
    JSON.stringify(arranged),
    /CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET/u,
  );
  const operand = target.operands.find(
    (o) => target.columns.some((c) => c.fieldId === o.fieldId) && !o.options,
  )!;
  assert.ok(operand, 'the invoice list shows a value a rule can read');
  const presented = customization.applyCustomizationPatches(authored, [
    patch(
      member(authored, {
        kind: 'addPresentationRevision',
        surface: invoices,
        tones: [
          {
            target: 'row',
            fieldId: operand.fieldId,
            operator: 'equal',
            compareTo: { fieldId: operand.fieldId },
            tone: 'attention',
            reason: 'Check',
          },
        ],
        columns: [{ fieldId: column, width: 'narrow' }],
        density: 'compact',
      }),
    ),
  ]);
  assert.equal(presented.status, 'applied', JSON.stringify(presented));
});

test('a clipped column clips its text, never the cell: the row and cell tone pills sit outside the clip', async () => {
  const revision = member(base, lowStock());
  assert.ok(
    revision.sizing.some(
      (entry) =>
        entry.kind === 'listColumn' &&
        entry.fieldId === stock('name') &&
        entry.overflow === 'truncate',
    ),
  );
  const onHandClip = member(applied(base, [revision]), {
    kind: 'addPresentationRevision',
    surface: stockList,
    columns: [
      { fieldId: stock('on_hand'), width: 'narrow', overflow: 'truncate' },
    ],
  });
  const steps = await sandboxSteps([stockItem, revision, onHandClip]);
  const release = customization.parseSerializedRelease(steps.at(-1)!.release);
  const manifest = projectionPayload(
    release.compiled,
    PROJECTION_FAMILY_IDS.surfaceManifest,
  ) as { surfaces: Json[] };
  const surface = manifest.surfaces.find((s) => s.surfaceId === stockList)!;
  const title = 'Hex bolt M12 x 80 zinc plated grade 8.8 box of 200';
  const html = renderDeclaredList({
    base: new URLSearchParams(),
    presentation: surface.presentation as CompiledPresentation,
    coverage: {
      schemaVersion: 'v1',
      totalCount: 1,
      returnedCount: 1,
      effectivePageSize: 25,
      pageOffset: 0,
    } as never,
    detailHref: () => '/?surface=detail',
    exportLimit: null,
    list: surface.list as never,
    now: new Date('2026-11-22T12:00:00Z'),
    present: (_record, _fieldId, value) =>
      value === null || value === undefined ? '' : String(value),
    progressWithheld: null,
    supplyWithheld: null,
    recordLabel: 'Stock item',
    records: [
      {
        recordId: '00000000-0000-4000-8000-000000000001',
        archived: false,
        values: {
          [stock('name')]: title,
          [stock('on_hand')]: '2',
          [stock('reorder_point')]: '5',
        },
      } as never,
    ],
    rowActionHref: () => null,
    selectionCell: null,
    state: {
      filterValues: {},
      includeArchived: false,
      page: 1,
      search: '',
      sort: [],
      sortIsExplicit: false,
      viewId: null,
    },
  });
  const cell = (label: string) =>
    new RegExp(
      `<td data-column-label="${escaped(label)}"[^>]*data-column-wrap="clip"[^>]*>([\\s\\S]*?)</td>`,
      'u',
    ).exec(html)?.[1];
  const titleCell = cell('Name');
  assert.ok(titleCell, html);
  // The title link sits in the clip span; the row's word follows it, outside.
  assert.match(
    titleCell,
    /^<span class="cell-clip"><a class="record-link"[^>]*>Hex bolt[^<]*<\/a><\/span> <span class="status-pill" data-status-role="attention" data-tone-rule="[^"]+">Reorder<\/span>$/u,
  );
  const onHandCell = cell('On hand');
  assert.ok(onHandCell, html);
  assert.match(
    onHandCell,
    /^<span class="cell-clip">2<\/span> <span class="status-pill" data-status-role="blocked" data-tone-rule="[^"]+">Low stock<\/span>$/u,
  );
});
