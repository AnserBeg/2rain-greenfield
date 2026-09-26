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
  // A legacy picker with no exact get keeps its admitted behaviour.
  assert.doesNotThrow(() =>
    normalizeApplicationPackage(
      variant((reference) => {
        delete reference.getQueryId;
      }),
    ),
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
