import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as customization from '../../packages/customization/src/index.js';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { VALIDATION_NODE_VERSION } from '../../packages/canonical-model/src/formula-validation.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';

type Base = Record<string, unknown>;
const file = 'apps/web/release/app.authored.json';
const base: Base = JSON.parse(readFileSync(file, 'utf8'));
const tip = parseCompiledApplication(
  JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
).application;
const acknowledgement = readUnboundPermissionAcknowledgementFor(
  file,
  'northstar.app:package.application',
);
const patch = (input: unknown) =>
  customization.CustomizationPatchSchema.parse(input);
function applied(source: Base, changes: unknown[]) {
  const result = customization.applyCustomizationPatches(
    source,
    changes.map(patch),
  );
  assert.ok(
    result.status === 'applied',
    JSON.stringify(result.status === 'applied' ? null : result),
  );
  return result.authored;
}
const id = (s: string) => 'northstar.app:' + s;
const equipment = id('entity.custom_equipment');
const record = {
  kind: 'addRecordType',
  label: 'Equipment',
  companyOwnership: 'entityOwned',
  fields: [
    { label: 'Name', type: 'text', required: true },
    { label: 'Status', type: 'choice', options: ['Ready', 'Held'] },
  ],
};
const extended = applied(base, [record]);
const field = {
  kind: 'addField',
  entity: equipment,
  field: { label: 'Bay', type: 'text' },
  screens: 'record',
};
const action = { kind: 'operation', id: id('operation.item_update') };
const limit = { kind: 'narrowPermission', target: action, roleKey: 'viewer' };
const files = {
  kind: 'addDocumentField',
  schemaVersion: 'northstar.document-field/v1',
  entityId: equipment,
  fieldId: id('field.custom_equipment_photos'),
  label: 'Evidence',
  type: 'files',
  maxCount: 1,
  required: false,
  allowedCategoryIds: [],
};
const schemaVersion = VALIDATION_NODE_VERSION;
const price = id('field.item_price_cad');
const rule = {
  kind: 'addValidation',
  rule: {
    kind: 'validationRule',
    schemaVersion,
    ruleId: id('rule.custom_minimum_item_price'),
    targetId: id('entity.item'),
    boundOperationIds: [
      id('operation.item_create'),
      id('operation.item_update'),
    ],
    trigger: { schemaVersion, kind: 'afterDefaultsOrChangedFields' },
    absence: { schemaVersion, kind: 'validationThreeValued' },
    effect: 'refuse',
    existingRecords: 'grandfather',
    message: 'Enter a price of at least $10.',
    fieldAnchors: [price],
    predicate: {
      schemaVersion,
      kind: 'comparison',
      operator: 'greaterThanOrEqual',
      left: { schemaVersion, kind: 'field', fieldId: price, select: 'value' },
      right: {
        schemaVersion,
        kind: 'literal',
        scalar: {
          kind: 'decimal',
          value: '10',
          precision: 38,
          scale: 4,
          currency: null,
          unit: null,
        },
      },
    },
  },
};
const targets = customization.customizationTargets(
  normalizeApplicationPackage(base),
);
const calculated = customization.calculatedDisplayDraft(
  targets.calculatedDisplayTargets!.find(
    (t) => t.recordSurfaceId === id('surface.item_detail'),
  )!,
  {
    label: 'Margin CAD',
    operator: 'subtract',
    leftFieldId: price,
    rightFieldId: id('field.item_standard_cost_cad'),
    listSurfaceId: id('surface.item_list'),
  },
);
const layout = customization
  .customizationTargets(normalizeApplicationPackage(extended))
  .layouts!.find(
    (l) =>
      l.body.surfaceId === id('surface.custom_equipment_form') &&
      l.body.mode === 'create',
  )!;
const revision = customization.layoutCommand(layout, {
  action: 'create',
  label: 'Delivery',
});
const workflow = {
  kind: 'saveWorkflow',
  workflow: {
    workflowId: 'after-receiving',
    schemaVersion: 'v6',
    trigger: 'goodsReceiptPosted',
    bodyDigest: 'a'.repeat(64),
    grants: { queries: [id('query.custom_equipment_list')], operations: [] },
  },
};
const template = {
  kind: 'addDocumentTemplateRevision',
  schemaVersion: 'northstar.document-template-revision/v1',
  templateId: id('template.custom_equipment_sheet'),
  revisionId: id('revision.custom_equipment_sheet_1'),
  previousRevisionId: null,
  entityId: equipment,
  label: 'Equipment sheet',
  documentKind: 'workOrder',
  headerQueryId: id('query.custom_equipment_get'),
  identityFieldId: id('field.custom_equipment_name'),
  currencyFieldId: null,
  format: {
    locale: 'en-CA',
    timeZone: 'America/Edmonton',
    currency: 'CAD',
    dateStyle: 'medium',
    numberGrouping: true,
    pageSize: 'LETTER',
  },
  layout: [{ kind: 'heading', text: 'Equipment sheet' }],
  pageNumbers: true,
};
const templated = applied(extended, [template]);
interface ReplayCase {
  source: Base;
  conflict: Base;
  change: unknown;
  code: string;
}
const retired = (change: unknown): ReplayCase => ({
  source: extended,
  conflict: base,
  change,
  code: 'RETIRED_TARGET',
});
const occupied = (
  change: unknown,
  code: string,
  source = base,
): ReplayCase => ({
  source,
  conflict: applied(source, [change]),
  change,
  code,
});
const address = {
  kind: 'addAddressField',
  schemaVersion: 'v6',
  entity: id('entity.item'),
  fieldId: id('field.custom_item_site'),
  label: 'Site',
  required: false,
};
const mapSurface = id('surface.item_detail');
const map = {
  kind: 'addMapPlacement',
  schemaVersion: 'v6',
  fieldId: address.fieldId,
  surfaceId: mapSurface,
  placementId: id('placement.custom_site_map'),
  sectionId:
    mapSurface + '/detail/northstar.app:slot.item_detail_sections/details',
};
const withEquipmentLifecycle = applied(extended, [
  {
    kind: 'declareLifecycle',
    entity: equipment,
    initial: 'Pending',
    states: [{ label: 'Pending' }, { label: 'Passed' }],
    transitions: [{ from: 'Pending', to: 'Passed', label: 'Pass' }],
  },
]);
const equipmentBoard = customization
  .customizationTargets(normalizeApplicationPackage(withEquipmentLifecycle))
  .boards!.find((target) => target.frame.entityId === equipment)!;
const appointment = {
  kind: 'addDateTimeField',
  schemaVersion: 'northstar.date-time-field/v1',
  target: { kind: 'tenantRecordType', recordTypeId: equipment },
  fieldId: id('field.custom_equipment_service_at'),
  label: 'Service appointment',
  required: false,
  zoneSource: { kind: 'perRecordIana', version: 'v1' },
};
const cases = {
  addDateTimeField: occupied(appointment, 'FIELD_COLLISION', extended),
  addBoardViewRevision: {
    source: withEquipmentLifecycle,
    conflict: extended,
    change: customization.draftBoardRevision(
      equipmentBoard,
      'Equipment inspections',
      customization.defaultBoardChoices(equipmentBoard),
    ),
    code: 'RETIRED_TARGET',
  },
  addAddressField: occupied(address, 'FIELD_COLLISION'),
  addMapPlacement: {
    source: applied(base, [address]),
    conflict: base,
    change: map,
    code: 'RETIRED_TARGET',
  },
  addRecordType: occupied(record, 'WHOLE_PACKAGE_FAILURE'),
  addField: retired(field),
  addChoice: retired({
    kind: 'addChoice',
    enumField: id('field.custom_equipment_status'),
    option: 'Loaned',
  }),
  addLink: retired({
    kind: 'addLink',
    entity: equipment,
    target: id('entity.item'),
    label: 'Product',
  }),
  addLineTable: retired({
    kind: 'addLineTable',
    entity: equipment,
    label: 'Parts',
    fields: [{ label: 'Part', type: 'text' }],
  }),
  declareLifecycle: retired({
    kind: 'declareLifecycle',
    entity: equipment,
    initial: 'Pending',
    states: [{ label: 'Pending' }, { label: 'Passed' }],
    transitions: [{ from: 'Pending', to: 'Passed', label: 'Pass' }],
  }),
  arrangeLayout: retired({
    kind: 'arrangeLayout',
    surface: id('surface.custom_equipment_list'),
    relabel: [{ field: id('field.custom_equipment_name'), label: 'Tool' }],
  }),
  addLayoutRevision: retired(revision),
  saveListView: retired({
    kind: 'saveListView',
    surface: id('surface.custom_equipment_list'),
    label: 'All tools',
    columns: [id('list_column.custom_equipment_list_name')],
    sort: [],
    filters: [],
  }),
  addValidation: occupied(rule, 'WHOLE_PACKAGE_FAILURE'),
  addCalculatedDisplayField: occupied(calculated, 'FIELD_COLLISION'),
  addMetricCard: retired({
    kind: 'addMetricCard',
    surface: id('surface.custom_equipment_list'),
    label: 'Equipment count',
  }),
  addDocumentField: retired(files),
  addUploadCategory: retired({
    kind: 'changeSet',
    patches: [
      {
        kind: 'addUploadCategory',
        schemaVersion: 'northstar.document-category/v1',
        entityId: equipment,
        fieldId: files.fieldId,
        categoryId: id('category.custom_equipment_evidence'),
        label: 'Evidence',
        contentTypes: ['image/png'],
        maxBytes: 1024,
        maxCount: 1,
        required: false,
        retentionClass: 'northstar.documents:retention.manual',
        visibility: 'internal',
        documentExpiryDate: null,
      },
      {
        ...files,
        allowedCategoryIds: [id('category.custom_equipment_evidence')],
      },
    ],
  }),
  addDocumentTemplateRevision: retired(template),
  retireDocumentTemplate: {
    source: templated,
    conflict: extended,
    change: {
      kind: 'retireDocumentTemplate',
      schemaVersion: 'northstar.document-template-retire/v1',
      templateId: template.templateId,
      previousRevisionId: template.revisionId,
    },
    code: 'RETIRED_TARGET',
  },
  narrowPermission: occupied(limit, 'WHOLE_PACKAGE_FAILURE'),
  unNarrowPermission: {
    source: applied(base, [limit]),
    conflict: base,
    change: { ...limit, kind: 'unNarrowPermission' },
    code: 'WHOLE_PACKAGE_FAILURE',
  },
  saveWorkflow: retired(workflow),
  changeSet: retired({ kind: 'changeSet', patches: [field, files] }),
} satisfies Record<customization.CustomizationPatchKind, ReplayCase>;

test('an active or retired template never blocks editing its record type', async () => {
  const retire = {
    kind: 'retireDocumentTemplate',
    schemaVersion: 'northstar.document-template-retire/v1',
    templateId: template.templateId,
    previousRevisionId: template.revisionId,
  };
  const arrange = {
    kind: 'arrangeLayout',
    surface: id('surface.custom_equipment_list'),
    relabel: [{ field: id('field.custom_equipment_name'), label: 'Tool' }],
  };
  for (const state of [[template], [template, retire]])
    for (const edit of [field, arrange]) {
      const result = await customization.compileInSandbox({
        acknowledgement,
        base: extended,
        chain: [...state, edit].map(patch),
        tip: customization.serializeRelease(tip),
      });
      assert.equal(
        result.status,
        'compiled',
        `${state.length === 1 ? 'active' : 'retired'} template, ${edit.kind}: ${JSON.stringify(result)}`.slice(
          0,
          2000,
        ),
      );
    }
});
test('upgrade replay admission and its named cases cover the independently parsed vocabulary', () => {
  const admitted = [...customization.UPGRADE_PATCH_KINDS].sort();
  assert.deepEqual(
    admitted,
    [...customization.CUSTOMIZATION_PATCH_KINDS].sort(),
  );
  const [single, changeSet] = customization.CustomizationPatchSchema.options;
  assert.deepEqual(
    [
      ...single.options.map((member) => member.shape.kind.value),
      changeSet.shape.kind.value,
    ].sort(),
    admitted,
  );
  assert.deepEqual(Object.keys(cases).sort(), admitted);
  assert.deepEqual(
    customization.unadmittedMembers({
      kind: 'changeSet',
      patches: [{ kind: 'addField' }, { kind: 'futureKind' }],
    }),
    [{ kind: 'futureKind', memberIndex: 1 }],
  );
});
test('upgrade diagnostic codes and meanings match v1', () => {
  assert.deepEqual(customization.UPGRADE_CODES_V1, {
    RETIRED_TARGET: 'A referenced subject is absent on the destination.',
    MOVED_MEMBER: 'A member or anchor has a different placement.',
    INCOMPATIBLE_TYPE: 'A bound subject has a different contract.',
    INCOMPATIBLE_SCOPE: 'A subject has a different scope.',
    FIELD_COLLISION:
      'A first-party field occupies the proposed tenant field ID or name.',
    MISSING_BODY: 'A bound artifact body is missing.',
    REMOVED_ACTION: 'A workflow action is absent.',
    CHANGED_ACTION_SIGNATURE:
      'A bound workflow action has a different contract.',
    REQUIRED_INPUT_CONCEALED: 'A tenant layout conceals a required input.',
    UNSATISFIABLE_RULE:
      'A destination constraint defeats a tenant validation witness.',
    WORKFLOW_FIXTURE_FAILED:
      'A workflow fixture fails verification under the destination SDK.',
    KIND_NOT_ADMITTED: 'A patch kind has no replay admission.',
    CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE:
      'The recorded source lineage cannot be reproduced.',
    WHOLE_PACKAGE_FAILURE:
      'The package cannot be replayed or the refusal is unclassified.',
  });
});
for (const [kind, example] of Object.entries(cases)) {
  test(`upgrade replay of ${kind} accepts a compatible base and identifies a conflicting base`, async () => {
    const chain = [patch(example.change)];
    const origins = [
      {
        patchId: '7d2d4a88-f026-4485-b081-3be230bc587f',
        parent: example.source,
        differentBase: true,
      },
    ];
    const conflict = customization.compileCustomizationCandidate({
      acknowledgement,
      base: example.conflict,
      chain,
      parent: tip,
      origins,
      upgradeReplay: true,
    });
    assert.equal(conflict.status, 'replayConflict');
    assert.ok(
      conflict.findings.some(
        (f) =>
          (kind === 'changeSet' || f.patchKind === kind) &&
          f.code === example.code &&
          f.patchId === origins[0]!.patchId,
      ),
      JSON.stringify(conflict),
    );
    const compatible = structuredClone(example.source);
    (compatible.fields as { fieldId: string; label: string }[]).find(
      (f) => f.fieldId === id('field.item_sku'),
    )!.label = 'Stock identifier';
    if (kind === 'addBoardViewRevision') {
      // The compatible move relabels what the Board binds: its title field,
      // that field's List column and the transition its move operates.
      const name = id('field.custom_equipment_name');
      (compatible.fields as { fieldId: string; label: string }[]).find(
        (f) => f.fieldId === name,
      )!.label = 'Asset name';
      (
        (compatible.surfaces as { surfaceId: string; list?: Base }[]).find(
          (s) => s.surfaceId === id('surface.custom_equipment_list'),
        )!.list!.columns as { field: string; label: string }[]
      ).find((c) => c.field === name)!.label = 'Asset';
      (compatible.stateMachines as { transitions: { label: string }[] }[]).find(
        (m) =>
          (m as unknown as { entity: { targetId: string } }).entity.targetId ===
          equipment,
      )!.transitions[0]!.label = 'Certify';
    }
    const result = await customization.compileInSandbox({
      acknowledgement,
      base: compatible,
      chain,
      origins,
      tip: customization.serializeRelease(tip),
      upgradeBaseRoot: tip.compiled.releaseRoot,
    });
    assert.ok(
      result.status === 'compiled',
      JSON.stringify(result.status === 'compiled' ? null : result),
    );
  });
}

function inspectReplay(target: Base, changes: unknown[], source = base) {
  const chain = changes.map(patch);
  return customization.compileCustomizationCandidate({
    acknowledgement,
    base: target,
    chain,
    parent: tip,
    upgradeReplay: true,
    origins: chain.map((_, i) => ({
      patchId: String(i + 1),
      differentBase: true,
      ...(i === 0 && { parent: source }),
    })),
  });
}
const salesPage = targets.layouts!.find(
  (l) =>
    l.body.surfaceId === id('surface.sales_order_detail') &&
    l.body.mode === 'detail',
)!;
const city = id('field.sales_order_ship_to_city');
const cityEdit = customization.layoutCommand(salesPage, {
  action: 'move',
  member: city,
  destination: salesPage.body.sections[0]!.id,
});
function salesDefinition(change: 'moved' | 'retired' | 'retyped') {
  const target = structuredClone(base);
  const surfaces = target.surfaces as {
    surfaceId: string;
    composition: {
      fields: { field: string; columnId: string }[];
      presentation: { blocks: { columns: string[] }[] };
    };
  }[];
  const composition = surfaces.find(
    (s) => s.surfaceId === salesPage.body.surfaceId,
  )!.composition;
  if (change === 'retyped') {
    const fields = target.fields as {
      fieldId: string;
      fieldType: { maxLength?: number };
    }[];
    fields.find((f) => f.fieldId === city)!.fieldType.maxLength = 42;
  } else {
    const group = composition.presentation.blocks[0]!;
    group.columns = group.columns.filter(
      (c) => c !== id('column.ship_to_city'),
    );
    if (change === 'retired')
      composition.fields = composition.fields.filter((c) => c.field !== city);
  }
  return target;
}
for (const [variant, code] of [
  ['moved', 'MOVED_MEMBER'],
  ['retired', 'RETIRED_TARGET'],
  ['retyped', 'INCOMPATIBLE_TYPE'],
] as const) {
  test(`structural layout replay identifies a ${variant} binding on the destination`, () => {
    const result = inspectReplay(salesDefinition(variant), [cityEdit]);
    assert.equal(result.status, 'replayConflict');
    assert.deepEqual(
      result.findings.map((f) => [f.subject, f.code, f.editIndex]),
      [[city, code, 0]],
    );
    assert.notDeepEqual(
      result.findings[0]!.expected,
      result.findings[0]!.observed,
    );
  });
}
test('one replay reports independent changes and points blocked changes at their originating edits', () => {
  const collision = {
    ...field,
    entity: id('entity.item'),
    field: { label: 'Shelf code', type: 'text' },
  };
  const target = applied(salesDefinition('moved'), [collision]);
  const sourceAfter = applied(base, [cityEdit]);
  const layout = customization
    .customizationTargets(normalizeApplicationPackage(sourceAfter))
    .layouts!.find(
      (l) =>
        l.body.surfaceId === salesPage.body.surfaceId &&
        l.body.mode === 'detail',
    )!;
  const successor = customization.layoutCommand(layout, {
    action: 'rename',
    member: city,
    label: 'Destination city',
  });
  const result = inspectReplay(target, [cityEdit, collision, successor]);
  assert.equal(result.status, 'replayConflict');
  assert.deepEqual(
    result.findings.map((f) => [f.patchId, f.code]),
    [
      ['1', 'MOVED_MEMBER'],
      ['2', 'FIELD_COLLISION'],
    ],
  );
  assert.deepEqual(
    result.blocked.map((b) => [b.patchId, b.blockedBy.patchId]),
    [['3', '1']],
  );
});
test('a changeSet member depending on a failed creation is blocked while unrelated members are checked', () => {
  const collision = {
    ...field,
    entity: id('entity.item'),
    field: { label: 'Shelf code', type: 'text' },
  };
  const target = applied(base, [collision]);
  // A base module has taken the tenant type's proposed name.
  (target.modules as { label: string }[])[0]!.label = 'Equipment';
  const result = inspectReplay(target, [
    { kind: 'changeSet', patches: [record, field, collision] },
  ]);
  assert.equal(result.status, 'replayConflict');
  assert.deepEqual(
    result.findings.map((f) => f.memberIndex),
    [0, 2],
  );
  assert.deepEqual(
    result.blocked.map((b) => [b.memberIndex, b.blockedBy.memberIndex]),
    [[1, 0]],
  );
});
test('a failed validation witness identifies the tenant rule and the conflicting base constraint', () => {
  const stricter = structuredClone(rule);
  stricter.rule.ruleId = id('rule.custom_platform_price_floor');
  stricter.rule.predicate.right.scalar.value = '20';
  const target = applied(base, [stricter]);
  const result = inspectReplay(target, [rule]);
  assert.equal(result.status, 'replayConflict');
  const finding = result.findings[0]!;
  assert.equal(finding.code, 'UNSATISFIABLE_RULE');
  assert.equal(finding.subject, rule.rule.ruleId);
  assert.deepEqual(
    (finding.observed as { constraints: string[] }).constraints,
    [stricter.rule.ruleId],
  );
});

test('an unrelated layout edit is still checked when its sibling refers to a failed field creation', () => {
  const added = {
    ...field,
    entity: id('entity.sales_order'),
    field: { type: 'text', label: 'Loading bay' },
  };
  const source = applied(base, [added]);
  const target = applied(salesDefinition('moved'), [added]);
  const page = customization
    .customizationTargets(normalizeApplicationPackage(source))
    .layouts!.find(
      (l) =>
        l.body.surfaceId === salesPage.body.surfaceId &&
        l.body.mode === 'detail',
    )!;
  const edits = [id('field.custom_sales_order_loading_bay'), city].map(
    (member) => {
      const parent = page.body.sections.find((s) =>
        s.fields.some((f) => f.id === member),
      )!;
      return {
        kind: 'rename' as const,
        schemaVersion: 'v6' as const,
        id: member,
        parent: parent.id,
        label: { schemaVersion: 'v6' as const, text: 'Destination' },
      };
    },
  );
  const result = inspectReplay(target, [
    added,
    customization.draftLayoutRevision(page, edits),
  ]);
  assert.equal(result.status, 'replayConflict');
  assert.deepEqual(
    result.findings.map((f) => [f.patchId, f.editIndex, f.code]),
    [
      ['1', 0, 'FIELD_COLLISION'],
      ['2', 1, 'MOVED_MEMBER'],
    ],
  );
  assert.deepEqual(
    result.blocked.map((b) => [b.patchId, b.editIndex, b.blockedBy.patchId]),
    [['2', 0, '1']],
  );
});
