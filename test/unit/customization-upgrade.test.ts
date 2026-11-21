import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { replayCustomizationPatches } from '../../packages/customization/src/upgrade-replay.js';
import * as customization from '../../packages/customization/src/index.js';
import {
  normalizeApplicationPackage,
  type SurfaceLayout,
} from '../../packages/canonical-model/src/index.js';
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
function declaration(def: Base, table: string, key: string, subject: string) {
  const found = (def[table] as Base[]).find((row) => row[key] === subject);
  assert.ok(found, subject);
  return found;
}
interface ReplayCase {
  prefix?: unknown[];
  conflict: Base;
  change: unknown;
  code: string;
  subject: string;
}
function retirement(
  table: string,
  key: string,
  subject: string,
  change: unknown,
): ReplayCase {
  const conflict = structuredClone(base);
  declaration(conflict, table, key, subject).lifecycle = 'retired';
  return { conflict, change, subject, code: 'RETIRED_TARGET' };
}
function collision(
  change: unknown,
  subject: string,
  mutate: (target: Base) => void,
  code = 'ID_COLLISION',
): ReplayCase {
  const conflict = structuredClone(base);
  mutate(conflict);
  return { conflict, change, subject, code };
}
const changeSet = (...patches: unknown[]) => ({ kind: 'changeSet', patches });
const item = id('entity.item');
const itemList = id('surface.item_list');
const itemSku = id('field.item_sku');
const itemFiles = {
  ...files,
  entityId: item,
  fieldId: id('field.custom_item_photos'),
};
const itemRetired = (change: unknown) =>
  retirement('entities', 'entityId', item, change);
const listRetired = (change: unknown) =>
  retirement('surfaces', 'surfaceId', itemList, change);
const retiredAction = (change: unknown) =>
  retirement('operations', 'operationId', action.id, change);
const board = targets.boards!.find(
  (t) => t.frame.listSurfaceId === id('surface.purchase_order_list'),
)!;
const form = targets.layouts!.find(
  (l) =>
    l.body.surfaceId === id('surface.sales_order_form') &&
    l.body.mode === 'create',
)!;
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
const cancel = id('operation.purchase_order_draft_cancel');
const newOption = id('option.custom_equipment_status_loaned');
const terms = id('field.sales_order_payment_terms');
function appendOption(target: Base, optionId: string, label: string) {
  const type = declaration(target, 'fields', 'fieldId', terms).fieldType as {
    options: Base[];
  };
  type.options.push({ ...type.options[0], optionId, label, orderKey: 90 });
}
const cases = {
  addBoardViewRevision: retirement(
    'operations',
    'operationId',
    cancel,
    customization.draftBoardRevision(
      board,
      'Purchasing stages',
      customization.defaultBoardChoices(board),
    ),
  ),
  addAddressField: itemRetired(address),
  addMapPlacement: retirement(
    'surfaces',
    'surfaceId',
    mapSurface,
    changeSet(address, map),
  ),
  addRecordType: collision(
    record,
    String((base.modules as Base[])[0]!.moduleId),
    (target) => {
      (target.modules as Base[])[0]!.label = 'Equipment';
    },
  ),
  addField: itemRetired({ ...field, entity: item }),
  addChoice: collision(
    changeSet(record, {
      kind: 'addChoice',
      enumField: id('field.custom_equipment_status'),
      option: 'Loaned',
    }),
    newOption,
    (target) => appendOption(target, newOption, 'Loan terms'),
  ),
  addLink: itemRetired(
    changeSet(record, {
      kind: 'addLink',
      entity: equipment,
      target: item,
      label: 'Product',
    }),
  ),
  addLineTable: collision(
    changeSet(record, {
      kind: 'addLineTable',
      entity: equipment,
      label: 'Parts',
      fields: [{ label: 'Part', type: 'text' }],
    }),
    id('entity.custom_equipment_lines'),
    (target) => {
      (target.entities as Base[]).push({
        ...(target.entities as Base[])[0],
        entityId: id('entity.custom_equipment_lines'),
        label: 'Equipment lines',
      });
    },
  ),
  declareLifecycle: collision(
    changeSet(record, {
      kind: 'declareLifecycle',
      entity: equipment,
      initial: 'Pending',
      states: [{ label: 'Pending' }, { label: 'Passed' }],
      transitions: [{ from: 'Pending', to: 'Passed', label: 'Pass' }],
    }),
    id('permission.custom_equipment_action_pass'),
    (target) => {
      (target.permissions as Base[]).push({
        ...(target.permissions as Base[])[0],
        permissionId: id('permission.custom_equipment_action_pass'),
      });
    },
  ),
  arrangeLayout: listRetired({
    kind: 'arrangeLayout',
    surface: itemList,
    relabel: [{ field: itemSku, label: 'Code' }],
  }),
  addLayoutRevision: retirement(
    'surfaces',
    'surfaceId',
    form.body.surfaceId,
    customization.layoutCommand(form, { action: 'create', label: 'Delivery' }),
  ),
  saveListView: listRetired({
    kind: 'saveListView',
    surface: itemList,
    label: 'Stock codes',
    columns: [id('list_column.item_list_sku')],
    sort: [],
    filters: [],
  }),
  addValidation: retirement('fields', 'fieldId', price, rule),
  addCalculatedDisplayField: retirement('fields', 'fieldId', price, calculated),
  addMetricCard: listRetired({
    kind: 'addMetricCard',
    surface: itemList,
    label: 'Stock count',
  }),
  addDocumentField: itemRetired(itemFiles),
  addUploadCategory: itemRetired(
    changeSet(
      {
        kind: 'addUploadCategory',
        schemaVersion: 'northstar.document-category/v1',
        entityId: item,
        fieldId: itemFiles.fieldId,
        categoryId: id('category.custom_item_evidence'),
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
        ...itemFiles,
        allowedCategoryIds: [id('category.custom_item_evidence')],
      },
    ),
  ),
  narrowPermission: retiredAction(limit),
  unNarrowPermission: {
    ...retiredAction({ ...limit, kind: 'unNarrowPermission' }),
    prefix: [limit],
  },
  saveWorkflow: retirement('queries', 'queryId', id('query.item_list'), {
    kind: 'saveWorkflow',
    workflow: {
      workflowId: 'after-receiving',
      schemaVersion: 'v6',
      trigger: 'goodsReceiptPosted',
      bodyDigest: 'a'.repeat(64),
      grants: { queries: [id('query.item_list')], operations: [] },
    },
  }),
  changeSet: itemRetired(changeSet({ ...field, entity: item }, itemFiles)),
} satisfies Record<customization.CustomizationPatchKind, ReplayCase>;

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
    ID_COLLISION:
      'A first-party declaration occupies the proposed tenant ID or name.',
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
    const chain = [
      ...('prefix' in example ? example.prefix : []),
      example.change,
    ].map(patch);
    const origins = chain.map((_, index) => ({
      patchId: String(index + 1),
      differentBase: true,
      ...(index === 0 && { parent: base }),
    }));
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
          f.subject === example.subject &&
          f.code === example.code &&
          f.patchId === origins.at(-1)!.patchId,
      ),
      JSON.stringify(conflict),
    );
    const compatible = structuredClone(base);
    declaration(compatible, 'fields', 'fieldId', itemSku).label =
      'Stock identifier';
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

function replayApplied(target: Base, change: unknown) {
  const result = replayCustomizationPatches(
    target,
    [patch(change)],
    [{ parent: base, differentBase: true, patchId: 'saved' }],
  );
  assert.ok(
    result.status === 'applied',
    JSON.stringify(result.status === 'applied' ? null : result),
  );
  return result.authored;
}
function replayedLayout(target: Base, revision: customization.LayoutRevision) {
  const result = replayApplied(target, revision);
  const surface = declaration(
    result,
    'surfaces',
    'surfaceId',
    revision.surface,
  );
  return (surface.layouts as SurfaceLayout[]).find(
    (l) => l.body.mode === revision.mode,
  )!;
}
function salesColumns(target: Base) {
  const page = declaration(
    target,
    'surfaces',
    'surfaceId',
    salesPage.body.surfaceId,
  );
  return (page.composition as { fields: { field: string; orderKey: number }[] })
    .fields;
}
function rename(target: customization.LayoutTarget, member: string) {
  return customization.layoutCommand(target, {
    action: 'rename',
    member,
    label: 'Office label',
  });
}
test('an appended choice preserves a list column and a form override', () => {
  const target = structuredClone(base);
  appendOption(target, id('option.sales_order_payment_terms_net_90'), 'Net 90');
  const edited = replayApplied(target, {
    kind: 'arrangeLayout',
    surface: id('surface.sales_order_list'),
    order: [terms],
    relabel: [{ field: terms, label: 'Due terms' }],
  });
  const list = declaration(
    edited,
    'surfaces',
    'surfaceId',
    id('surface.sales_order_list'),
  ).list as { columns: Base[] };
  assert.equal(list.columns.find((c) => c.field === terms)?.label, 'Due terms');
  const layout = replayedLayout(target, rename(form, terms));
  assert.equal(
    layout.body.sections.flatMap((s) => s.fields).find((f) => f.id === terms)!
      .label.text,
    'Office label',
  );
});
test('a document header label preserves the tenant override on a different base', () => {
  const target = structuredClone(base);
  const customer = id('field.sales_order_customer_party_id');
  for (const surface of target.surfaces as Base[]) {
    const editor = surface.documentEditor as
      { headerFormSurfaceId: string; headerFields: Base[] } | undefined;
    if (editor?.headerFormSurfaceId === form.body.surfaceId)
      editor.headerFields.find((f) => f.fieldId === customer)!.label = 'Client';
  }
  const layout = replayedLayout(target, rename(form, customer));
  assert.equal(
    layout.body.sections.flatMap((s) => s.fields).find((f) => f.id === customer)
      ?.label.text,
    'Office label',
  );
});
test('an early optional detail field changes the eighth field tier and goes last when it has no predecessor', () => {
  const target = applied(base, [
    {
      ...field,
      entity: id('entity.sales_order'),
      field: { label: 'Dock code', type: 'text' },
    },
  ]);
  const added = id('field.custom_sales_order_dock_code');
  salesColumns(target).find((c) => c.field === added)!.orderKey = 1;
  const eighth = salesPage.body.sections[0]!.fields[7]!;
  assert.equal(eighth.tier, 'always');
  const layout = replayedLayout(target, rename(salesPage, eighth.id));
  const fields = layout.body.sections[0]!.fields;
  assert.equal(fields.find((f) => f.id === eighth.id)!.tier, 'progressive');
  assert.equal(
    fields.find((f) => f.id === eighth.id)!.label.text,
    'Office label',
  );
  assert.equal(fields.at(-1)!.id, added);
  assert.equal(layout.placementRuleVersion, 1);
});
test('moving a section does not bind its untouched children', () => {
  const shipping = salesPage.body.sections.find((s) =>
    s.fields.some((f) => f.id === city),
  )!;
  const layout = replayedLayout(
    salesDefinition('retired'),
    customization.layoutCommand(salesPage, {
      action: 'up',
      member: shipping.id,
    }),
  );
  assert.ok(
    !layout.body.sections.flatMap((s) => s.fields).some((f) => f.id === city),
  );
  assert.equal(
    layout.body.order.indexOf(shipping.id),
    salesPage.body.order.indexOf(shipping.id) - 1,
  );
});
test('a renamed member may cross an untouched sibling on its base', () => {
  const target = structuredClone(base);
  const region = id('field.sales_order_ship_to_region');
  const fields = salesColumns(target);
  const a = fields.find((c) => c.field === city)!;
  const b = fields.find((c) => c.field === region)!;
  [a.orderKey, b.orderKey] = [b.orderKey, a.orderKey];
  const layout = replayedLayout(target, rename(salesPage, region));
  const group = layout.body.sections.find((s) =>
    s.fields.some((f) => f.id === region),
  )!.fields;
  assert.ok(
    group.findIndex((f) => f.id === region) <
      group.findIndex((f) => f.id === city),
  );
  assert.equal(group.find((f) => f.id === region)!.label.text, 'Office label');
});
test('a change of scope reports the expected and observed classification', () => {
  const target = structuredClone(base);
  declaration(target, 'fields', 'fieldId', price).classification =
    'confidential';
  const result = inspectReplay(target, [rule]);
  assert.equal(result.status, 'replayConflict');
  assert.deepEqual(
    result.findings.map((f) => [f.code, f.subject, f.expected, f.observed]),
    [['INCOMPATIBLE_SCOPE', price, 'internal', 'confidential']],
  );
});
test('a valid historical edit must reproduce on its recorded parent', () => {
  const revision = rename(form, terms);
  revision.resultLayoutDigest = '0'.repeat(64);
  const result = inspectReplay(base, [revision]);
  assert.equal(result.status, 'replayConflict');
  assert.deepEqual(
    result.findings.map((f) => [f.patchId, f.code]),
    [['1', 'CUSTOMIZE_LINEAGE_NOT_REPRODUCIBLE']],
  );
  assert.match(String(result.findings[0]!.observed), /digest/u);
});
test('an ordinary draft needs the authoring parent of each different-base layout', () => {
  const result = customization.applyCustomizationPatches(
    base,
    [rename(form, terms)],
    [{ patchId: 'saved', differentBase: true }],
  );
  assert.equal(result.status, 'refused');
  assert.match(result.message, /authoring parent is missing/u);
});
test('report subjects are sorted inside each edit before moving to the next patch', () => {
  const target = structuredClone(base);
  const sku = id('field.item_sku'),
    name = id('field.item_name');
  for (const subject of [sku, name])
    declaration(target, 'fields', 'fieldId', subject).lifecycle = 'retired';
  const result = inspectReplay(target, [
    {
      kind: 'arrangeLayout',
      surface: itemList,
      relabel: [
        { field: sku, label: 'Code' },
        { field: name, label: 'Title' },
      ],
    },
    {
      kind: 'arrangeLayout',
      surface: itemList,
      relabel: [{ field: name, label: 'Stock' }],
    },
  ]);
  assert.equal(result.status, 'replayConflict');
  assert.deepEqual(
    result.findings.map((f) => [f.patchIndex, f.editIndex, f.subject]),
    [
      [0, 0, name],
      [0, 0, sku],
      [1, 0, name],
    ],
  );
});

test('the final formula check identifies retired and retyped operands of rules and calculations', () => {
  const original = normalizeApplicationPackage(base);
  for (const change of [rule, calculated]) {
    const source = normalizeApplicationPackage(applied(base, [change]));
    for (const retired of [true, false]) {
      const destination = structuredClone(original);
      const operand = destination.fields.find((f) => f.fieldId === price)!;
      if (retired) operand.lifecycle = 'retired';
      else
        operand.fieldType = {
          ...operand.fieldType,
          kind: 'textFieldType',
          maximumLength: 64,
        } as typeof operand.fieldType;
      const finding = customization.finalFormulaConflict(
        source,
        destination,
        original,
        [patch(change)],
        [{ patchId: 'formula' }],
      );
      assert.deepEqual(
        [finding?.patchId, finding?.subject, finding?.code],
        ['formula', price, retired ? 'RETIRED_TARGET' : 'INCOMPATIBLE_TYPE'],
      );
    }
  }
});
