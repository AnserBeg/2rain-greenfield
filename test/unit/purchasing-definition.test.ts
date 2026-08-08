import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompileSuccess,
  type CompilerInput,
  type StorageTargetPayloadV1,
} from '../../packages/compiler/src/index.js';
import { LEGAL_ENTITY_FAMILY_MAP_V1 } from '../../packages/domain/src/inventory/contracts.js';
import {
  PURCHASING_IDS,
  purchasingModuleDefinition,
} from '../../packages/domain/src/purchasing/index.js';

type AuthoredOperation = {
  effect: { entity: { targetId: string }; kind: string };
  operationId: string;
  precondition?: Record<string, unknown>;
  tier: string;
};

const namespace = PURCHASING_IDS.namespace;
const states = ['draft', 'released', 'closed', 'cancelled'] as const;

test('the purchase order authors one enumerated state and no state machine', () => {
  const definition = authored();
  assert.deepEqual(definition.stateMachines, []);

  const state = definition.fields.find(
    (field) => field.fieldId === PURCHASING_IDS.fieldIds.purchaseOrder.state,
  );
  assert.ok(state, 'purchase_order_state is absent');
  assert.equal(state.fieldType.kind, 'enumFieldType');
  assert.equal(
    state.presence,
    'required',
    'an optional state operand makes the guard absent-satisfiable',
  );
  assert.deepEqual(
    state.fieldType.options?.map((option) => option.optionId),
    states.map((value) => `${namespace}:option.purchase_order_state_${value}`),
  );

  // The lifecycle lives in exactly one place. A `stateMachines` entry would be
  // a second description of it that nothing in packages/runtime/ ever reads.
  assert.doesNotMatch(
    JSON.stringify(definition),
    /stateMachineDefinition|transitionDefinition/u,
  );
});

test('the header guards its four generic operations and the lines declare nothing', () => {
  const definition = authored();
  const byId = new Map(
    definition.operations.map((operation) => [
      operation.operationId,
      operation,
    ]),
  );

  const notReleased = {
    kind: 'notPredicate',
    schemaVersion: 'v4',
    term: comparison('released'),
  };
  for (const action of ['create', 'update', 'archive', 'restore'] as const) {
    const operation = byId.get(
      `${namespace}:operation.purchase_order_${action}`,
    );
    assert.ok(operation, `purchase_order_${action} is absent`);
    assert.equal(operation.tier, 'o0');
    assert.deepEqual(
      operation.precondition,
      notReleased,
      `purchase_order_${action} does not carry the not-released guard`,
    );
  }

  // The parent-aggregate rule is the whole point: a mutating operation on the
  // source of an active parentScopedChild relation must also satisfy the
  // parent's precondition, so the lines need zero declarations of their own.
  for (const action of ['create', 'update', 'archive', 'restore'] as const) {
    const operation = byId.get(
      `${namespace}:operation.purchase_order_line_${action}`,
    );
    assert.ok(operation, `purchase_order_line_${action} is absent`);
    assert.equal(
      Object.hasOwn(operation, 'precondition'),
      false,
      `purchase_order_line_${action} declares a redundant line-level guard`,
    );
  }

  const relation = definition.relations.find(
    (candidate) =>
      candidate.relationId ===
      PURCHASING_IDS.relationIds.purchaseOrderLineOrder,
  );
  assert.ok(relation, 'the line-to-order relation is absent');
  assert.equal(
    relation.ownership,
    'parentScopedChild',
    'a reference relation is deliberately exempt from the parent-aggregate rule',
  );
  assert.equal(relation.required, true);
});

test('both purchasing families are entity-owned and lower a legal entity column', () => {
  for (const familyId of ['purchase_order', 'purchase_order_line']) {
    const rule = LEGAL_ENTITY_FAMILY_MAP_V1.find(
      (candidate) => candidate.familyId === familyId,
    );
    assert.ok(rule, `${familyId} is an undeclared legal-entity family`);
    assert.equal(rule.classification, 'entityOwned');
  }

  const storage = projectionPayload<StorageTargetPayloadV1>(
    compile(),
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  for (const familyId of ['purchase_order', 'purchase_order_line']) {
    const entity = storage.entities.find(
      (candidate) => candidate.entityId === `${namespace}:entity.${familyId}`,
    );
    assert.ok(entity, `${familyId} has no lowered storage`);
    assert.equal(entity.legalEntity?.column, 'legal_entity_id');
    assert.equal(entity.legalEntity?.familyClassification, 'entityOwned');
    assert.equal(entity.legalEntity?.immutableAfterCreate, true);
  }
});

test('the document carries its plan shape and nothing from receiving or valuation', () => {
  const definition = authored();
  assert.deepEqual(
    definition.fields
      .filter(
        (field) =>
          field.entity.targetId === PURCHASING_IDS.entityIds.purchaseOrder,
      )
      .map((field) => field.fieldId),
    [
      PURCHASING_IDS.fieldIds.purchaseOrder.number,
      PURCHASING_IDS.fieldIds.purchaseOrder.supplierPartyId,
      PURCHASING_IDS.fieldIds.purchaseOrder.state,
      PURCHASING_IDS.fieldIds.purchaseOrder.orderDate,
      PURCHASING_IDS.fieldIds.purchaseOrder.expectedDate,
      PURCHASING_IDS.fieldIds.purchaseOrder.currency,
      PURCHASING_IDS.fieldIds.purchaseOrder.notes,
    ],
  );
  assert.deepEqual(
    definition.fields
      .filter(
        (field) =>
          field.entity.targetId === PURCHASING_IDS.entityIds.purchaseOrderLine,
      )
      .map((field) => field.fieldId),
    [
      PURCHASING_IDS.fieldIds.purchaseOrderLine.lineNumber,
      PURCHASING_IDS.fieldIds.purchaseOrderLine.itemId,
      PURCHASING_IDS.fieldIds.purchaseOrderLine.orderedQuantity,
      PURCHASING_IDS.fieldIds.purchaseOrderLine.unitPrice,
    ],
  );

  // No received quantity, anywhere. It is a derived read model (plan 6.2) and
  // PUR-1 posts no receipts, so a stored column could only ever hold zero --
  // and choosing to store it would pre-commit PS-0's over-receipt race to
  // compare-and-swap when PUR-2 may need lock-and-sum on a derived value.
  // The absence is the decision being left open, so it is asserted.
  assert.doesNotMatch(JSON.stringify(definition), /received/iu);

  // PUR-1 is the document only: no receipt, no movement, no posting role, and
  // nothing on the sales side.
  assert.doesNotMatch(
    JSON.stringify(definition),
    /goods_receipt|inventory_movement|posting|sales_order|shipment|reservation/iu,
  );
  assert.equal(
    definition.operations.some((operation) =>
      /delete|purge|destroy/iu.test(
        `${operation.operationId} ${operation.effect.kind}`,
      ),
    ),
    false,
  );
});

test('the module compiles standalone into every walking-slice projection', () => {
  const first = compile();
  const second = compile();
  assert.equal(first.releaseRoot, second.releaseRoot);

  const familyIds = new Set(
    first.bundle.releaseManifest.projections.map(
      (projection) => projection.familyId,
    ),
  );
  for (const familyId of [
    PROJECTION_FAMILY_IDS.storageTarget,
    PROJECTION_FAMILY_IDS.storageTransition,
    PROJECTION_FAMILY_IDS.queryCatalog,
    PROJECTION_FAMILY_IDS.operationCatalog,
    PROJECTION_FAMILY_IDS.surfaceManifest,
    PROJECTION_FAMILY_IDS.agentDiscovery,
    PROJECTION_FAMILY_IDS.reporting,
    PROJECTION_FAMILY_IDS.verificationPlan,
  ]) {
    assert.equal(familyIds.has(familyId), true, familyId);
  }

  const definition = authored();
  assert.equal(definition.entities.length, 2);
  assert.equal(definition.queries.length, 8);
  assert.equal(definition.operations.length, 8);
  assert.equal(definition.surfaces.length, 6);
  assert.equal(definition.assertions.length, 2);
});

function comparison(state: (typeof states)[number]): Record<string, unknown> {
  return {
    field: {
      kind: 'fieldReference',
      schemaVersion: 'v4',
      targetId: PURCHASING_IDS.fieldIds.purchaseOrder.state,
    },
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: 'v4',
    value: {
      kind: 'textValue',
      schemaVersion: 'v4',
      value: `${namespace}:option.purchase_order_state_${state}`,
    },
  };
}

function authored(): {
  assertions: unknown[];
  entities: unknown[];
  fields: Array<{
    entity: { targetId: string };
    fieldId: string;
    fieldType: { kind: string; options?: Array<{ optionId: string }> };
    presence: string;
  }>;
  operations: AuthoredOperation[];
  queries: unknown[];
  relations: Array<{
    ownership: string;
    relationId: string;
    required: boolean;
  }>;
  stateMachines: unknown[];
  surfaces: unknown[];
} {
  return purchasingModuleDefinition() as ReturnType<typeof authored>;
}

function compile(): CompileSuccess {
  const result = compileApplication(input(purchasingModuleDefinition()));
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function input(definition: unknown): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalizeApplicationPackage(definition)),
    ),
    profile: { ...MODULE_COMPILER_PROFILE },
  };
}

function projectionPayload<T>(compiled: CompileSuccess, familyId: string): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const root = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  assert.ok(root);
  const manifest = JSON.parse(
    new TextDecoder().decode(root.canonicalBytes),
  ) as { chunks: Array<{ contentHash: string }> };
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  assert.ok(chunk);
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}
