import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalModelError,
  platformContract,
} from '../../packages/canonical-model/src/index.js';
import { normalizeApplicationPackage } from '../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import {
  SurfaceDocumentEditorSchema,
  SurfaceWorkspaceSchema,
} from '../../packages/canonical-model/src/index.js';
import type { StorageTargetPayloadV1 } from '../../packages/compiler/src/index.js';
import { legalEntityReadScopeRequirement } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { moneyText } from '../../apps/web/src/list-declaration.js';
import { declaredDefault } from '../../apps/web/src/control-semantics.js';

test('DROP-SHIP declares route, company-owned delivery, symmetric demand links and Tasks', () => {
  const model = normalizeApplicationPackage(composedApplicationDefinition());
  const delivery = model.entities.find((entity) => entity.entityId.endsWith(':entity.drop_ship_delivery'));
  assert.ok(delivery);
  const number = model.fields.find((field) => field.fieldId.endsWith(':field.drop_ship_delivery_number'))!;
  assert.equal(number.numbering?.prefix, 'DSD');
  assert.equal(model.relations.filter((relation) => relation.sourceEntity.targetId === delivery.entityId).length, 4);
  for (const order of ['sales_order', 'purchase_order']) {
    const page = model.surfaces.find((surface) => surface.surfaceId.endsWith(`:surface.${order}_detail`))!;
    assert.ok('composition' in page && page.composition?.children.some((child) => child.label === 'Deliveries'));
  }
  assert.ok(model.operations.some((op) => op.operationId.endsWith(':operation.sales_order_create_drop_ship_po') && op.effect.kind === 'registeredCapabilityEffect'));
});

test('the scaffold exposes a canonical workspace contract', () => {
  assert.deepEqual(platformContract, {
    authority: 'canonical-model',
    product: 'greenfield-north-star-erp',
  });
});

test('legal-entity read scope dispatches only from compiler-owned storage metadata', () => {
  type StorageEntity = StorageTargetPayloadV1['entities'][number];
  const syntheticEntityOwned = {
    entityId: 'northstar.synthetic:entity.unrelated_fact',
    legalEntity: {
      column: 'legal_entity_id',
      familyClassification: 'entityOwned',
      immutableAfterCreate: true,
      nullable: false,
      postgresqlType: 'uuid',
      referencedFamilyId: 'legal_entity',
    },
  } as unknown as StorageEntity;
  const syntheticTenantShared = {
    entityId: 'northstar.synthetic:entity.shared_reference',
  } as unknown as StorageEntity;

  assert.deepEqual(legalEntityReadScopeRequirement(syntheticEntityOwned), {
    column: 'legal_entity_id',
    kind: 'legalEntity',
  });
  assert.equal(legalEntityReadScopeRequirement(syntheticTenantShared), null);
});

test('workspace declarations preserve contextual surfaces and support an unrelated document editor', () => {
  const authored = JSON.parse(
    JSON.stringify(composedApplicationDefinition())
      .replaceAll('northstar.app', 'northstar.servicefixture')
      .replaceAll('sales_order', 'service_request'),
  );
  const model = normalizeApplicationPackage(authored);
  const workspace = model.surfaces.find(
    (value) =>
      value.surfaceId ===
      'northstar.servicefixture:surface.service_request_list',
  )!;
  assert.equal(
    SurfaceWorkspaceSchema.parse(
      'workspace' in workspace && workspace.workspace,
    ).membership,
    'operational',
  );
  const line = model.surfaces.find(
    (value) =>
      value.surfaceId ===
      'northstar.servicefixture:surface.service_request_line_list',
  )!;
  assert.equal(
    SurfaceWorkspaceSchema.parse('workspace' in line && line.workspace)
      .membership,
    'contextual',
  );
  const form = model.surfaces.find(
    (value) =>
      value.surfaceId ===
      'northstar.servicefixture:surface.service_request_form',
  )!;
  const editor = SurfaceDocumentEditorSchema.parse(
    'documentEditor' in form && form.documentEditor,
  );
  assert.equal(
    editor.recordSurfaceId,
    'northstar.servicefixture:surface.service_request_detail',
  );
  assert.equal(editor.saveMode, 'sequential');
});

test('canonical workspace/editor declarations refuse wrong ownership, undeclared references and atomic claims', () => {
  const source = composedApplicationDefinition();
  const mutate = (change: (surface: Record<string, unknown>) => void) => {
    const candidate = structuredClone(source);
    const surface = (candidate.surfaces as Record<string, unknown>[]).find(
      (value) => String(value.surfaceId).endsWith(':surface.sales_order_form'),
    )!;
    change(surface);
    assert.throws(() => normalizeApplicationPackage(candidate));
  };
  mutate((surface) => {
    (surface.documentEditor as Record<string, unknown>).parentRelationId =
      'northstar.app:relation.shipment_order';
  });
  mutate((surface) => {
    (surface.documentEditor as Record<string, unknown>).lineQueryId =
      'northstar.app:query.missing';
  });
  mutate((surface) => {
    (surface.documentEditor as Record<string, unknown>).saveMode = 'atomic';
  });
  mutate((surface) => {
    (surface.workspace as Record<string, unknown>).ownerSurfaceId =
      'northstar.app:surface.sales_order_line_list';
  });
});

test('editor controls are closed, typed declarations checked against the entity model', () => {
  const source = composedApplicationDefinition();
  type Field = Record<string, unknown> & {
    fieldId: string;
    presentation?: Record<string, unknown>;
    reference?: Record<string, unknown> & {
      create?: Record<string, unknown> & {
        steps: (Record<string, unknown> & {
          fixed?: Record<string, unknown>[];
        })[];
        fields: Record<string, unknown>[];
      };
    };
  };
  const refuse = (
    change: (editor: { headerFields: Field[]; lineFields: Field[] }) => void,
    expected: RegExp,
  ) => {
    const candidate = structuredClone(source);
    const surface = (candidate.surfaces as Record<string, unknown>[]).find(
      (value) => String(value.surfaceId).endsWith(':surface.sales_order_form'),
    )!;
    change(
      surface.documentEditor as { headerFields: Field[]; lineFields: Field[] },
    );
    assert.throws(
      () => normalizeApplicationPackage(candidate),
      (error: unknown) =>
        error instanceof CanonicalModelError &&
        error.diagnostics.some((value) => expected.test(JSON.stringify(value))),
    );
  };
  const header = (editor: { headerFields: Field[] }, suffix: string) =>
    editor.headerFields.find((field) => field.fieldId.endsWith(suffix))!;
  const line = (editor: { lineFields: Field[] }, suffix: string) =>
    editor.lineFields.find((field) => field.fieldId.endsWith(suffix))!;

  // The shipped declarations are admitted.
  assert.doesNotThrow(() =>
    normalizeApplicationPackage(structuredClone(source)),
  );
  // Closed schema: an undeclared control property is refused, not ignored.
  refuse((editor) => {
    header(editor, '_currency').presentation!.placeholder = 'Pick one';
  }, /CANON_SCHEMA_INVALID.*headerFields\[\d+\]\.presentation"/);
  // A choice default must be one of its offered values.
  refuse((editor) => {
    header(editor, '_currency').presentation!.defaultValue = 'JPY';
  }, /choice presentation requires/);
  // A choice cannot be declared over a non-text field.
  refuse((editor) => {
    header(editor, '_order_date').presentation = {
      kind: 'choice',
      options: [{ value: 'today', label: 'Today' }],
    };
  }, /choice presentation requires/);
  // A derived value must name a sibling reference whose get reads the source.
  refuse((editor) => {
    line(editor, '_unit_id').presentation!.sourceFieldId =
      'northstar.app:field.item_description_missing';
  }, /derived presentation requires/);
  // A picker with create needs an exact get of the same entity.
  refuse((editor) => {
    delete header(editor, '_customer_party_id').reference!.getQueryId;
  }, /searchable picker requires an exact get/);
  refuse((editor) => {
    header(editor, '_customer_party_id').reference!.getQueryId =
      'northstar.app:query.item_get';
  }, /a supplied exact get must be a get of the picker entity/);
  // Create steps must be governed creates, select the picker's entity, and
  // carry only admissible fixed values and earlier-step relations.
  refuse((editor) => {
    header(
      editor,
      '_customer_party_id',
    ).reference!.create!.steps[0]!.operationId =
      'northstar.app:operation.party_update';
  }, /create flow steps must be governed create operations/);
  refuse((editor) => {
    header(editor, '_customer_party_id').reference!.create!.selectStep = 1;
  }, /create flow must select a record of the picker entity/);
  refuse((editor) => {
    header(
      editor,
      '_customer_party_id',
    ).reference!.create!.steps[1]!.fixed![0]!.value =
      'northstar.app:option.not_a_role';
  }, /fixed create values must be admissible/);
  refuse((editor) => {
    header(editor, '_customer_party_id').reference!.create!.fields.push({
      fieldId: 'northstar.app:field.item_sku',
      label: 'SKU',
    });
  }, /each collected create field must belong to exactly one step/);
  // A reference is presented by its picker, never by a presentation too.
  refuse((editor) => {
    header(editor, '_customer_party_id').presentation = { kind: 'multiline' };
  }, /a reference field is presented by its picker/);
});

test('FORM-4: every supplied exact get is validated, whether or not the picker creates or shows details', () => {
  const source = composedApplicationDefinition();
  type Reference = Record<string, unknown> & {
    create?: unknown;
    detailFieldIds?: unknown;
    getQueryId?: string;
    labelFieldIds: string[];
  };
  const variant = (change: (reference: Reference) => void) => {
    const candidate = structuredClone(source);
    const surface = (candidate.surfaces as Record<string, unknown>[]).find(
      (value) => String(value.surfaceId).endsWith(':surface.sales_order_form'),
    )!;
    const customer = (
      surface.documentEditor as {
        headerFields: { fieldId: string; reference?: Reference }[];
      }
    ).headerFields.find((field) =>
      field.fieldId.endsWith('_customer_party_id'),
    )!.reference!;
    // A plain picker: a list and an exact get, no quick create, no details.
    delete customer.create;
    delete customer.detailFieldIds;
    change(customer);
    return candidate;
  };
  // Literal expectations, written here rather than read from the validator.
  const suppliedGetRefused =
    'a supplied exact get must be a get of the picker entity reading its labels and details';
  const refusedWith = (candidate: unknown, rule: string) =>
    assert.throws(
      () => normalizeApplicationPackage(candidate),
      (error: unknown) =>
        error instanceof CanonicalModelError &&
        error.diagnostics.some((value) => value.rule === rule),
    );

  assert.doesNotThrow(() => normalizeApplicationPackage(variant(() => {})));
  // Mismatched entity: an item get on a party picker.
  refusedWith(
    variant((reference) => {
      reference.getQueryId = 'northstar.app:query.item_get';
    }),
    suppliedGetRefused,
  );
  // Wrong kind: the list itself named as the exact get.
  refusedWith(
    variant((reference) => {
      reference.getQueryId = 'northstar.app:query.party_list';
    }),
    suppliedGetRefused,
  );
  // Missing binding.
  refusedWith(
    variant((reference) => {
      reference.getQueryId = 'northstar.app:query.party_missing_get';
    }),
    suppliedGetRefused,
  );
  // A same-entity get that does not select the picker's label. It is a second
  // get added only for this picker, so no other surface's reads change.
  const addedGet = (candidate: Record<string, unknown>, label: boolean) => {
    const queries = candidate.queries as {
      queryId: string;
      selections: { selectionId: string; field: { targetId: string } }[];
    }[];
    const partyGet = queries.find(
      (query) => query.queryId === 'northstar.app:query.party_get',
    )!;
    queries.push({
      ...structuredClone(partyGet),
      queryId: 'northstar.app:query.party_number_get',
      selections: structuredClone(partyGet.selections)
        .filter(
          (selection) =>
            label || !selection.field.targetId.endsWith(':field.party_name'),
        )
        .map((selection) => ({
          ...selection,
          selectionId: selection.selectionId.replace(
            'party_get',
            'party_number_get',
          ),
        })),
    });
    return candidate;
  };
  const numberGet = (reference: Reference) => {
    reference.getQueryId = 'northstar.app:query.party_number_get';
  };
  refusedWith(addedGet(variant(numberGet), false), suppliedGetRefused);
  // The same added get reading the label is admitted: the refusal is the label.
  assert.doesNotThrow(() =>
    normalizeApplicationPackage(addedGet(variant(numberGet), true)),
  );
  // A legacy picker with no exact get keeps its admitted behaviour, in a
  // legacy header where nothing is defaulted or scoped through it.
  const legacy = variant((reference) => {
    delete reference.getQueryId;
  });
  for (const field of (
    (legacy.surfaces as Record<string, unknown>[]).find((value) =>
      String(value.surfaceId).endsWith(':surface.sales_order_form'),
    )!.documentEditor as {
      headerFields: {
        defaultFrom?: unknown;
        reference?: { within?: unknown };
      }[];
    }
  ).headerFields) {
    delete field.defaultFrom;
    delete field.reference?.within;
  }
  assert.doesNotThrow(() => normalizeApplicationPackage(legacy));
  // Once a default reads through it, the picker needs its exact get.
  refusedWith(
    variant((reference) => {
      delete reference.getQueryId;
    }),
    'an editor default requires a sibling reference whose record holds a compatible selected source',
  );
});

test('picker eligibility and Task input presentation are closed, typed declarations', () => {
  const source = composedApplicationDefinition();
  type Loose = Record<string, unknown>;
  type Eligibility = {
    queryId: string;
    filters: { fieldId: string; value: string }[];
    [key: string]: unknown;
  };
  type Input = {
    inputId: string;
    presentation?: {
      kind: string;
      defaultValue?: string;
      defaultFrom?: { field: string };
      column?: { columnId: string };
    };
  };
  const surface = (candidate: Loose, suffix: string) =>
    (candidate.surfaces as Loose[]).find((value) =>
      String(value.surfaceId).endsWith(suffix),
    )!;
  const eligibility = (candidate: Loose) =>
    (
      surface(candidate, ':surface.sales_order_form').documentEditor as {
        headerFields: {
          fieldId: string;
          reference: { eligibility: Eligibility };
        }[];
      }
    ).headerFields.find((field) =>
      field.fieldId.endsWith('_customer_party_id'),
    )!.reference.eligibility;
  const receiveInput = (candidate: Loose, name: string) =>
    (
      surface(candidate, ':surface.purchase_order_detail').composition as {
        actions: { actionId: string; inputs: Input[] }[];
      }
    ).actions
      .find((action) => action.actionId.endsWith(':action.receive_known'))!
      .inputs.find((input) =>
        input.inputId.endsWith(`:input.receive_${name}`),
      )!;
  const refuse = (change: (candidate: Loose) => void, expected: RegExp) => {
    const candidate = structuredClone(source);
    change(candidate);
    assert.throws(
      () => normalizeApplicationPackage(candidate),
      (error: unknown) =>
        error instanceof CanonicalModelError &&
        error.diagnostics.some((value) => expected.test(JSON.stringify(value))),
    );
  };

  assert.doesNotThrow(() =>
    normalizeApplicationPackage(structuredClone(source)),
  );
  // Eligibility: an unscoped list of an entity whose owned relation points at
  // the picker's entity, filtered by its own selected fields and admissible values.
  refuse((candidate) => {
    eligibility(candidate).queryId = 'northstar.app:query.item_list';
  }, /picker eligibility requires/);
  refuse((candidate) => {
    eligibility(candidate).queryId = 'northstar.app:query.sales_order_list';
  }, /picker eligibility requires/);
  refuse((candidate) => {
    eligibility(candidate).filters[0]!.value =
      'northstar.app:option.not_a_role';
  }, /picker eligibility filters require/);
  refuse((candidate) => {
    eligibility(candidate).filters[0]!.fieldId =
      'northstar.app:field.party_name';
  }, /picker eligibility filters require/);
  refuse((candidate) => {
    eligibility(candidate).includeInactive = true;
  }, /CANON_SCHEMA_INVALID/);
  // Task inputs: presentation only on text inputs; a listed default; a
  // record default the surface actually reads; a derived column of the
  // selected dataset.
  refuse((candidate) => {
    receiveInput(candidate, 'quantity').presentation = { kind: 'multiline' };
  }, /input presentation applies to text inputs/);
  refuse((candidate) => {
    receiveInput(candidate, 'currency').presentation!.defaultValue = 'JPY';
  }, /choice inputs require/);
  refuse((candidate) => {
    receiveInput(candidate, 'currency').presentation!.defaultFrom!.field =
      'northstar.app:field.item_name';
  }, /choice inputs require/);
  refuse((candidate) => {
    receiveInput(candidate, 'unit').presentation!.column!.columnId =
      'northstar.app:column.purchasing_receipt';
  }, /derived inputs require/);
});

test('a reference Task input may start from a field its record query selects', () => {
  const source = composedApplicationDefinition();
  type Loose = Record<string, unknown>;
  type Input = Loose & {
    inputId: string;
    defaultFrom?: { source: string; field: string };
  };
  const receiveInput = (candidate: Loose, name: string) =>
    (
      (candidate.surfaces as Loose[]).find((value) =>
        String(value.surfaceId).endsWith(':surface.purchase_order_detail'),
      )!.composition as { actions: { actionId: string; inputs: Input[] }[] }
    ).actions
      .find((action) => action.actionId.endsWith(':action.receive_known'))!
      .inputs.find((input) =>
        input.inputId.endsWith(`:input.receive_${name}`),
      )!;
  const refuse = (change: (candidate: Loose) => void, expected: RegExp) => {
    const candidate = structuredClone(source);
    change(candidate);
    assert.throws(
      () => normalizeApplicationPackage(candidate),
      (error: unknown) =>
        error instanceof CanonicalModelError &&
        error.diagnostics.some((value) => expected.test(JSON.stringify(value))),
    );
  };
  const receivingLocation = {
    source: 'record',
    field: 'northstar.app:field.purchase_order_receiving_location_id',
  };
  // Admitted and kept: the order's receiving location, which the workspace's
  // record query selects, on the receiving location picker.
  assert.deepEqual(
    receiveInput(
      normalizeApplicationPackage(structuredClone(source)) as unknown as Loose,
      'location',
    ).defaultFrom,
    receivingLocation,
  );
  // Refused on a text input, and from a field the record query does not select.
  refuse((candidate) => {
    receiveInput(candidate, 'cost').defaultFrom = receivingLocation;
  }, /only reference inputs default from a declared record field/);
  refuse((candidate) => {
    receiveInput(candidate, 'location').defaultFrom!.field =
      'northstar.app:field.location_name';
  }, /only reference inputs default from a declared record field/);
  // A closed declaration: the record is its only source.
  refuse((candidate) => {
    receiveInput(candidate, 'location').defaultFrom!.source = 'selected';
  }, /CANON_SCHEMA_INVALID/);
});

test('editor defaults, scoped pickers, Task input eligibility and print blocks are closed, typed declarations', () => {
  const source = composedApplicationDefinition();
  type Loose = Record<string, unknown>;
  type EditorField = {
    fieldId: string;
    presentation?: Loose;
    defaultFrom?: { referenceFieldId: string; sourceFieldId: string };
    reference?: Loose & {
      within?: { referenceFieldId: string; relationId: string };
      create?: unknown;
    };
    [key: string]: unknown;
  };
  const surface = (candidate: Loose, suffix: string) =>
    (candidate.surfaces as Loose[]).find((value) =>
      String(value.surfaceId).endsWith(suffix),
    )!;
  const editor = (candidate: Loose) =>
    surface(candidate, ':surface.sales_order_form').documentEditor as {
      headerFields: EditorField[];
      lineFields: EditorField[];
    };
  const header = (candidate: Loose, name: string) =>
    editor(candidate).headerFields.find((field) =>
      field.fieldId.endsWith(`:field.sales_order_${name}`),
    )!;
  const customerWorkspace = (candidate: Loose) =>
    surface(candidate, ':surface.party_detail').composition as {
      actions: { actionId: string; inputs: Loose[] }[];
      presentation: { print?: Loose };
    };
  const refuse = (change: (candidate: Loose) => void, expected: RegExp) => {
    const candidate = structuredClone(source);
    change(candidate);
    assert.throws(
      () => normalizeApplicationPackage(candidate),
      (error: unknown) =>
        error instanceof CanonicalModelError &&
        error.diagnostics.some((value) => expected.test(JSON.stringify(value))),
    );
  };

  assert.doesNotThrow(() =>
    normalizeApplicationPackage(structuredClone(source)),
  );
  // A default reads a selected field of a sibling picker's record.
  refuse((candidate) => {
    header(candidate, 'currency').defaultFrom!.referenceFieldId =
      'northstar.app:field.sales_order_order_date';
  }, /an editor default requires a sibling reference/);
  refuse((candidate) => {
    header(candidate, 'currency').defaultFrom!.sourceFieldId =
      'northstar.app:field.party_role_kind';
  }, /an editor default requires a sibling reference/);
  // ...into a field that can hold it: text no shorter than the source.
  refuse((candidate) => {
    header(candidate, 'currency').defaultFrom!.sourceFieldId =
      'northstar.app:field.party_name';
  }, /an editor default requires a sibling reference/);
  // ...or an enumeration whose every label fits the text (a currency code).
  refuse((candidate) => {
    header(candidate, 'currency').defaultFrom!.sourceFieldId =
      'northstar.app:field.party_payment_terms';
  }, /an editor default requires a sibling reference/);
  // ...an enumeration offering each source label exactly once.
  refuse((candidate) => {
    const terms = (candidate.fields as Loose[]).find(
      (field) =>
        field.fieldId === 'northstar.app:field.sales_order_payment_terms',
    )!.fieldType as { options: { label: string }[] };
    terms.options[2]!.label = 'Thirty days';
  }, /an editor default requires a sibling reference/);
  // ...never a read-only derived field.
  refuse((candidate) => {
    editor(candidate).lineFields.find((field) =>
      field.fieldId.endsWith(':field.sales_order_line_unit_id'),
    )!.defaultFrom = {
      referenceFieldId: 'northstar.app:field.sales_order_line_item_id',
      sourceFieldId: 'northstar.app:field.item_base_unit',
    };
  }, /an editor default requires a sibling reference/);
  // Defaults cascade, so they must settle.
  refuse((candidate) => {
    header(candidate, 'customer_party_id').defaultFrom = {
      referenceFieldId: 'northstar.app:field.sales_order_ship_to_address_id',
      sourceFieldId: 'northstar.app:field.party_address_label',
    };
  }, /editor defaults must not form a cycle/);
  refuse((candidate) => {
    (header(candidate, 'currency').defaultFrom as Loose).fallback = 'CAD';
  }, /CANON_SCHEMA_INVALID/);
  // A scoped picker lists the records an owned relation ties to its sibling.
  refuse((candidate) => {
    header(candidate, 'ship_to_address_id').reference!.within!.relationId =
      'northstar.app:relation.party_role_party';
  }, /a scoped picker requires/);
  refuse((candidate) => {
    header(
      candidate,
      'ship_to_address_id',
    ).reference!.within!.referenceFieldId =
      'northstar.app:field.sales_order_order_date';
  }, /a scoped picker requires/);
  refuse((candidate) => {
    header(candidate, 'ship_to_address_id').reference!.create = structuredClone(
      header(candidate, 'customer_party_id').reference!.create,
    );
  }, /a scoped picker requires/);
  // Task input eligibility: a reference input's, with the picker's rules.
  refuse((candidate) => {
    const inputs = customerWorkspace(candidate).actions.find((action) =>
      action.actionId.endsWith(':action.party_set_salesperson'),
    )!.inputs;
    (
      inputs[0]!.eligibility as { filters: { value: string }[] }
    ).filters[0]!.value = 'northstar.app:option.not_a_role';
  }, /picker eligibility filters require/);
  refuse((candidate) => {
    const action = customerWorkspace(candidate).actions.find((value) =>
      value.actionId.endsWith(':action.party_set_salesperson'),
    )!;
    const eligibility = action.inputs[0]!.eligibility;
    customerWorkspace(candidate).actions.find((value) =>
      value.actionId.endsWith(':action.party_add_address'),
    )!.inputs[0]!.eligibility = eligibility;
  }, /only reference inputs declare lookup queries/);
  // A block names declared columns the header does not already show.
  refuse((candidate) => {
    (
      surface(candidate, ':surface.sales_order_detail').composition as {
        presentation: { blocks: { columns: string[] }[] };
      }
    ).presentation.blocks[0]!.columns.push('northstar.app:column.not_declared');
  }, /a block lists declared columns the header does not show/);
  refuse((candidate) => {
    (
      surface(candidate, ':surface.sales_order_detail').composition as {
        presentation: { blocks: { columns: string[] }[] };
      }
    ).presentation.blocks[0]!.columns.push('northstar.app:column.currency');
  }, /a block lists declared columns the header does not show/);
});

test('ruling B declarations: prices chosen by the order currency, a line tax code from the order, frozen rates and printed totals', () => {
  const source = composedApplicationDefinition();
  type Loose = Record<string, unknown>;
  type EditorField = {
    fieldId: string;
    presentation?: Loose & {
      sourceByHeader?: {
        headerFieldId: string;
        cases: { value: string; sourceFieldId: string }[];
      };
    };
    defaultFrom?: Loose & {
      headerFieldId?: string;
      sourceByHeader?: {
        headerFieldId: string;
        cases: { value: string; sourceFieldId: string }[];
      };
    };
    [key: string]: unknown;
  };
  const editor = (candidate: Loose) =>
    (candidate.surfaces as Loose[]).find((value) =>
      String(value.surfaceId).endsWith(':surface.sales_order_form'),
    )!.documentEditor as { lineFields: EditorField[] };
  const line = (candidate: Loose, name: string) =>
    editor(candidate).lineFields.find((field) =>
      field.fieldId.endsWith(`:field.sales_order_line_${name}`),
    )!;
  const refuse = (change: (candidate: Loose) => void, expected: RegExp) => {
    const candidate = structuredClone(source);
    change(candidate);
    assert.throws(
      () => normalizeApplicationPackage(candidate),
      (error: unknown) =>
        error instanceof CanonicalModelError &&
        error.diagnostics.some((value) => expected.test(JSON.stringify(value))),
    );
  };
  assert.doesNotThrow(() =>
    normalizeApplicationPackage(structuredClone(source)),
  );
  // The chooser is a declared header field, and each value is one it holds.
  refuse((candidate) => {
    line(candidate, 'unit_price').defaultFrom!.sourceByHeader!.headerFieldId =
      'northstar.app:field.sales_order_line_line_number';
  }, /an editor default requires a sibling reference/);
  refuse((candidate) => {
    line(candidate, 'unit_price').defaultFrom!.sourceByHeader!.cases[0]!.value =
      'CADX';
  }, /an editor default requires a sibling reference/);
  refuse((candidate) => {
    const cases = line(candidate, 'unit_price').defaultFrom!.sourceByHeader!
      .cases;
    cases[1]!.value = cases[0]!.value;
  }, /an editor default requires a sibling reference/);
  // A price chosen by currency is a decimal the line can hold.
  refuse((candidate) => {
    line(
      candidate,
      'unit_price',
    ).defaultFrom!.sourceByHeader!.cases[0]!.sourceFieldId =
      'northstar.app:field.item_name';
  }, /an editor default requires a sibling reference/);
  // A derived decimal (the list price) reads a decimal.
  refuse((candidate) => {
    line(candidate, 'list_price').presentation!.sourceFieldId =
      'northstar.app:field.item_sku';
  }, /derived presentation requires a text or decimal field/);
  // A line copying a header value copies one it can hold.
  refuse((candidate) => {
    line(candidate, 'tax_code_id').defaultFrom!.headerFieldId =
      'northstar.app:field.sales_order_freight_amount';
  }, /an editor default requires a sibling reference/);
  // A header copy names no record source as well.
  refuse((candidate) => {
    line(candidate, 'tax_code_id').defaultFrom!.sourceFieldId =
      'northstar.app:field.item_name';
  }, /an editor default requires a sibling reference/);
  // Printed totals are declared columns.
  refuse((candidate) => {
    (
      (candidate.surfaces as Loose[]).find((value) =>
        String(value.surfaceId).endsWith(':surface.sales_order_detail'),
      )!.composition as {
        presentation: { print: { totals: string[] } };
      }
    ).presentation.print.totals.push('northstar.app:column.not_declared');
  }, /printed totals are declared columns/);
});

test('money columns read exact decimals and show grouped digits with two decimals, never rounded', () => {
  const source = composedApplicationDefinition();
  type Loose = Record<string, unknown>;
  type Column = Loose & { columnId: string; format?: string; role?: string };
  const surface = (candidate: Loose, local: string) =>
    (candidate.surfaces as Loose[]).find((value) =>
      String(value.surfaceId).endsWith(`:surface.${local}`),
    ) as Loose & {
      composition?: { fields: Column[] };
      list?: { columns: Column[] };
    };
  const invoiceColumn = (candidate: Loose, local: string) =>
    surface(candidate, 'customer_invoice_detail').composition!.fields.find(
      (value) => value.columnId.endsWith(`:column.invoice_${local}`),
    )!;
  const refuse = (change: (candidate: Loose) => void, expected: RegExp) => {
    const candidate = structuredClone(source);
    change(candidate);
    assert.throws(
      () => normalizeApplicationPackage(candidate),
      (error: unknown) =>
        error instanceof CanonicalModelError &&
        error.diagnostics.some((value) => expected.test(JSON.stringify(value))),
    );
  };
  assert.doesNotThrow(() =>
    normalizeApplicationPackage(structuredClone(source)),
  );
  // The shipped declarations: an invoice's figures and the Invoices List.
  assert.equal(invoiceColumn(source, 'balance').format, 'money');
  assert.deepEqual(
    surface(source, 'customer_invoice_list')
      .list!.columns.filter((value) => value.format === 'money')
      .map((value) => value.columnId.split('.').pop()),
    ['customer_invoice_list_total', 'customer_invoice_list_balance'],
  );
  // A money column reads an exact decimal: not text, not a referenced label.
  refuse((candidate) => {
    invoiceColumn(candidate, 'number').format = 'money';
  }, /a money column reads an exact decimal/);
  refuse((candidate) => {
    invoiceColumn(candidate, 'customer').format = 'money';
  }, /a money column reads an exact decimal/);
  refuse((candidate) => {
    surface(candidate, 'customer_invoice_list').list!.columns.find(
      (value) => value.role === 'title',
    )!.format = 'money';
  }, /a money column reads an exact decimal field/);
  // Shown with grouped digits and at least two decimals; never rounded.
  for (const [stored, shown] of [
    ['1234.5', '1,234.50'],
    ['25', '25.00'],
    ['0.1', '0.10'],
    ['12.345', '12.345'],
    ['12.500', '12.50'],
    ['-1000000', '-1,000,000.00'],
    ['not a number', 'not a number'],
  ] as const)
    assert.equal(moneyText(stored), shown, stored);
});

test('a new order starts its requested date three weeks out, a default counted from today', () => {
  const source = composedApplicationDefinition();
  type Loose = Record<string, unknown>;
  type EditorField = Loose & {
    fieldId: string;
    defaultDaysFromToday?: number;
    defaultFrom?: Loose;
  };
  const header = (candidate: Loose) =>
    (
      (candidate.surfaces as Loose[]).find((value) =>
        String(value.surfaceId).endsWith(':surface.sales_order_form'),
      )!.documentEditor as { headerFields: EditorField[] }
    ).headerFields;
  const headerField = (candidate: Loose, name: string) =>
    header(candidate).find((field) =>
      field.fieldId.endsWith(`:field.sales_order_${name}`),
    )!;
  const refuse = (change: (candidate: Loose) => void) => {
    const candidate = structuredClone(source);
    change(candidate);
    assert.throws(
      () => normalizeApplicationPackage(candidate),
      (error: unknown) =>
        error instanceof CanonicalModelError &&
        error.diagnostics.some((value) =>
          /a default counted from today is a UTC date-time field with no other default/.test(
            JSON.stringify(value),
          ),
        ),
    );
  };
  assert.equal(headerField(source, 'requested_date').defaultDaysFromToday, 21);
  // Only a UTC date-time field, and never beside another default.
  refuse((candidate) => {
    headerField(candidate, 'freight_amount').defaultDaysFromToday = 21;
  });
  refuse((candidate) => {
    headerField(candidate, 'ship_to_city').defaultDaysFromToday = 21;
  });
  // Midnight UTC of the day 21 days after the draft opens.
  assert.equal(
    declaredDefault(
      { defaultDaysFromToday: 21 },
      new Date('2026-09-29T23:30:00.000Z'),
    ),
    '2026-10-20T00:00:00.000Z',
  );
  assert.equal(
    declaredDefault(
      { defaultDaysFromToday: 0 },
      new Date('2026-12-31T05:00:00Z'),
    ),
    '2026-12-31T00:00:00.000Z',
  );
});

test('PAYABLES: the purchase order lists its bills and offers billing only when a post would bill something; a bill offers each command only in its states; the Invoices List reads as before', () => {
  const ns = 'northstar.app';
  type Loose = Record<string, unknown>;
  type Condition = { value: Loose; operator: string; compare: unknown };
  type Action = Loose & {
    actionId: string;
    conditions: Condition[];
    inputs: Loose[];
    steps: { operation: { targetId: string } }[];
    navigate?: { surface: { targetId: string }; query: { targetId: string } };
  };
  type Composition = {
    children: (Loose & {
      datasetId: string;
      label: string;
      query: { targetId: string };
      parent: { relationId: string };
    })[];
    actions: Action[];
  };
  const source = composedApplicationDefinition() as Loose;
  const composition = (local: string) =>
    (
      (source.surfaces as Loose[]).find(
        (value) => value.surfaceId === `${ns}:surface.${local}`,
      ) as Loose & { composition: Composition }
    ).composition;
  const order = composition('purchase_order_detail');
  const bills = order.children.find((child) => child.label === 'Bills')!;
  assert.equal(bills.query.targetId, `${ns}:query.vendor_bill_list`);
  assert.equal(bills.parent.relationId, `${ns}:relation.vendor_bill_order`);
  const action = (value: Composition, local: string) =>
    value.actions.find((entry) => entry.actionId === `${ns}:action.${local}`)!;
  const billing = action(order, 'bill_received');
  assert.equal(billing.label, 'Bill received quantities');
  // Offered while the order states received quantity not yet billed and a
  // total -- the read model counts each line's own positive part, as the
  // post bills.
  assert.deepEqual(
    billing.conditions.map((condition) => [
      condition.value.field,
      condition.operator,
    ]),
    [
      [`${ns}:metric.order_to_bill`, 'positive'],
      [`${ns}:metric.order_total`, 'positive'],
    ],
  );
  assert.deepEqual(
    billing.inputs.map((input) => [input.label, input.type, input.required]),
    [['Supplier invoice number', 'text', false]],
  );
  assert.deepEqual(
    billing.steps.map((step) => step.operation.targetId),
    [`${ns}:operation.vendor_bill_create`, `${ns}:operation.vendor_bill_post`],
  );
  assert.equal(
    action(order, 'open_bill').navigate?.surface.targetId,
    `${ns}:surface.vendor_bill_detail`,
  );
  // The order's read model states what is to bill, from its lines, their
  // receipts and its live bills.
  const readModel = (
    (source.queries as Loose[]).find(
      (query) => query.queryId === `${ns}:query.commercial_purchase_order_get`,
    ) as Loose & {
      readModel: {
        queries: Record<string, { targetId: string }>;
        resultFields: Record<string, string>;
      };
    }
  ).readModel;
  assert.equal(
    readModel.resultFields.order_to_bill,
    `${ns}:metric.order_to_bill`,
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(readModel.queries).map(([key, value]) => [
        key,
        value.targetId,
      ]),
    ),
    {
      lines: `${ns}:query.commercial_purchase_lines`,
      received: `${ns}:query.purchase_order_received_get`,
      bills: `${ns}:query.vendor_bill_list`,
      billLines: `${ns}:query.vendor_bill_line_list`,
    },
  );

  // The bill: each command where its state admits it, and nowhere else (the
  // way back to its order is a link, not a command, and is always there).
  const bill = composition('vendor_bill_detail');
  assert.deepEqual(
    bill.children.map((child) => child.label),
    ['Bill lines', 'Payments', 'Vendor credits'],
  );
  const offered = (state: string) =>
    bill.actions
      .filter((entry) => !entry.navigate)
      .filter((entry) =>
        entry.conditions.every((condition) => {
          const stateOption = `${ns}:option.vendor_bill_state_${state}`;
          assert.equal(condition.value.field, `${ns}:field.vendor_bill_state`);
          return condition.operator === 'equals'
            ? condition.compare === stateOption
            : condition.compare !== stateOption;
        }),
      )
      .map((entry) => entry.label);
  assert.deepEqual(offered('draft'), []);
  assert.deepEqual(offered('open'), [
    'Record payment',
    'Record vendor credit',
    'Void bill',
  ]);
  assert.deepEqual(offered('partially_paid'), [
    'Record payment',
    'Record vendor credit',
  ]);
  assert.deepEqual(offered('paid'), []);
  assert.deepEqual(offered('void'), []);

  // The Invoices List, now one settlement List among two, lowers exactly as
  // it did before the Bills List joined it.
  const list = (local: string) =>
    (
      (source.surfaces as Loose[]).find(
        (value) => value.surfaceId === `${ns}:surface.${local}`,
      ) as Loose & {
        list: {
          columns: (Loose & { columnId: string; label: string })[];
          views: { viewId: string; label: string }[];
          defaultSort: { columnId: string; direction: string }[];
        };
      }
    ).list;
  const invoices = list('customer_invoice_list');
  assert.deepEqual(
    invoices.columns.map((column) => [
      column.columnId.split('customer_invoice_list_')[1],
      column.label,
      column.field,
      column.format ?? null,
    ]),
    [
      ['number', 'Number', `${ns}:field.customer_invoice_number`, null],
      [
        'customer',
        'Customer',
        `${ns}:field.customer_invoice_customer_party_id`,
        null,
      ],
      [
        'invoice_date',
        'Invoice date',
        `${ns}:field.customer_invoice_invoice_date`,
        'date',
      ],
      ['due_date', 'Due', `${ns}:field.customer_invoice_due_date`, 'date'],
      ['status', 'Status', `${ns}:field.customer_invoice_state`, null],
      ['total', 'Total', `${ns}:field.customer_invoice_total`, 'money'],
      ['balance', 'Balance', `${ns}:field.customer_invoice_balance`, 'money'],
      ['currency', 'Currency', `${ns}:field.customer_invoice_currency`, null],
    ],
  );
  assert.deepEqual(invoices.defaultSort, [
    {
      columnId: `${ns}:list_column.customer_invoice_list_invoice_date`,
      direction: 'descending',
    },
  ]);
  // The Bills List: the same shape with the supplier's own invoice number.
  const billList = list('vendor_bill_list');
  assert.deepEqual(
    billList.columns.map((column) => column.label),
    [
      'Number',
      'Vendor',
      'Supplier invoice',
      'Bill date',
      'Due',
      'Status',
      'Total',
      'Balance',
      'Currency',
    ],
  );
  assert.deepEqual(
    billList.views.map((view) => view.label),
    ['All', 'Open', 'Partially paid', 'Paid', 'Void'],
  );
});

test('PAYABLES (PY-G): each order line shows its three-way match from the purchase-line read model, and a bill names and opens its order', () => {
  const ns = 'northstar.app';
  type Loose = Record<string, unknown>;
  const source = composedApplicationDefinition() as Loose;
  const composition = (local: string) =>
    (
      (source.surfaces as Loose[]).find(
        (value) => value.surfaceId === `${ns}:surface.${local}`,
      ) as Loose & {
        composition: {
          presentation: { header: { facts: string[] } };
          fields: (Loose & { columnId: string; field: string })[];
          children: (Loose & {
            label: string;
            query: { targetId: string };
            columns: (Loose & {
              columnId: string;
              label: string;
              field: string;
              presentation?: { role: string };
            })[];
          })[];
          actions: (Loose & {
            actionId: string;
            conditions: unknown[];
            navigate?: {
              surface: { targetId: string };
              query: { targetId: string };
              record: { source: string; field: string };
            };
          })[];
        };
      }
    ).composition;
  // The Order lines section: ordered and received, then billed, left to
  // bill and the match, read from the purchase-line read model.
  const lines = composition('purchase_order_detail').children.find(
    (child) => child.label === 'Order lines',
  )!;
  assert.equal(
    lines.query.targetId,
    `${ns}:query.commercial_purchase_order_lines`,
  );
  assert.deepEqual(
    lines.columns
      .filter((column) =>
        ['billed', 'to_bill', 'match'].some((local) =>
          column.columnId.endsWith(`:column.purchasing_${local}`),
        ),
      )
      .map((column) => [column.label, column.field, column.presentation?.role]),
    [
      ['Billed', `${ns}:metric.billed`, 'quantity'],
      ['To bill', `${ns}:metric.to_bill`, 'quantity'],
      ['Match', `${ns}:metric.match_status`, 'secondary'],
    ],
  );
  // Shown, never enforced: no action is conditioned on the match.
  assert.doesNotMatch(
    JSON.stringify(
      composition('purchase_order_detail').actions.map(
        (action) => action.conditions,
      ),
    ),
    /metric\.(?:billed|to_bill|match_status)/u,
  );
  const readModel = (
    (source.queries as Loose[]).find(
      (query) =>
        query.queryId === `${ns}:query.commercial_purchase_order_lines`,
    ) as Loose & {
      readModel: {
        queries: Record<string, { targetId: string }>;
        resultFields: Record<string, string>;
      };
    }
  ).readModel;
  assert.deepEqual(Object.keys(readModel.resultFields), [
    'line_amount',
    'line_tax',
    'received',
    'open_to_receive',
    'billed',
    'to_bill',
    'match_status',
  ]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(readModel.queries).map(([key, value]) => [
        key,
        value.targetId,
      ]),
    ),
    {
      received: `${ns}:query.purchase_order_received_get`,
      billLines: `${ns}:query.vendor_bill_line_list`,
      bills: `${ns}:query.vendor_bill_list`,
      bill: `${ns}:query.vendor_bill_get`,
    },
  );

  // The bill names its order through the stored relation, labelled by the
  // order's own get, and opens it -- from wherever the bill was opened.
  const bill = composition('vendor_bill_detail');
  const order = bill.fields.find((column) =>
    column.columnId.endsWith(':column.bill_order'),
  )!;
  assert.equal(order.field, `${ns}:relation.vendor_bill_order`);
  assert.deepEqual(order.reference, {
    query: {
      kind: 'queryReference',
      schemaVersion: 'v6',
      targetId: `${ns}:query.purchase_order_get`,
    },
    labelField: {
      kind: 'fieldReference',
      schemaVersion: 'v6',
      targetId: `${ns}:field.purchase_order_number`,
    },
  });
  assert.equal(bill.presentation.header.facts[0], `${ns}:column.bill_order`);
  assert.ok(bill.presentation.header.facts.length <= 6);
  const open = bill.actions.find(
    (action) => action.actionId === `${ns}:action.bill_open_order`,
  )!;
  assert.deepEqual(open.conditions, []);
  assert.deepEqual(open.navigate, {
    surface: {
      kind: 'surfaceReference',
      schemaVersion: 'v6',
      targetId: `${ns}:surface.purchase_order_detail`,
    },
    query: {
      kind: 'queryReference',
      schemaVersion: 'v6',
      targetId: `${ns}:query.commercial_purchase_order_get`,
    },
    record: { source: 'record', field: `${ns}:relation.vendor_bill_order` },
  });
  // The page still validates as a whole.
  assert.doesNotThrow(() =>
    normalizeApplicationPackage(structuredClone(source)),
  );
});
