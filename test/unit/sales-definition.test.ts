import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADOPTED_LANGUAGE_VERSION,
  ADOPTED_NORMALIZATION_PROFILE_VERSION,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  COMPOSED_MODULE_NAMES,
  composedApplicationDefinition,
} from '../../packages/domain/src/app/builder.js';
import {
  LEGAL_ENTITY_FAMILY_MAP_V1,
  LEGAL_ENTITY_RELATION_SEMANTICS_V1,
} from '../../packages/domain/src/inventory/contracts.js';
import {
  SALES_IDS,
  salesModuleDefinition,
} from '../../packages/domain/src/sales/index.js';
import { evaluateRegisteredOperationPrecondition } from '../../packages/runtime/src/semantic-operation-gateway.js';

interface Definition {
  entities: Array<{ entityId: string }>;
  fields: Array<{ entity: { targetId: string }; fieldId: string }>;
  languageVersion: string;
  normalizationProfileVersion: string;
  operations: Array<{
    effect: { kind: string; transition?: { targetId: string } };
    operationId: string;
    permission: { targetId: string };
    precondition?: Record<string, unknown>;
  }>;
  permissions: Array<{
    action: string;
    permissionId: string;
    resource: { targetId: string };
  }>;
  queries: Array<{
    legalEntityScope?: { cardinality: string };
    queryId: string;
    selections: Array<{ field: { targetId: string } }>;
  }>;
  relations: Array<{
    ownership: string;
    relationId: string;
    sourceEntity: { targetId: string };
    targetEntity: { targetId: string };
  }>;
  stateMachines: Array<{
    initialState: { targetId: string };
    states: Array<{ stateId: string; terminal: boolean }>;
    transitions: Array<{
      fromState: { targetId: string };
      permission: { targetId: string };
      toState: { targetId: string };
      transitionId: string;
    }>;
  }>;
  surfaces: Array<{ slots: Array<{ slot: string }>; surfaceId: string }>;
}

function definition(): Definition {
  return salesModuleDefinition() as unknown as Definition;
}

test('sales fulfillment metadata is a complete order, reservation and shipment document', () => {
  const authored = definition();
  assert.equal(authored.languageVersion, ADOPTED_LANGUAGE_VERSION);
  assert.equal(
    authored.normalizationProfileVersion,
    ADOPTED_NORMALIZATION_PROFILE_VERSION,
  );
  assert.equal(authored.entities.length, 7);
  assert.equal(authored.fields.length, 35);
  assert.equal(authored.operations.length, 27);
  assert.equal(authored.permissions.length, 33);
  assert.equal(authored.queries.length, 28);
  assert.equal(authored.surfaces.length, 19);
  for (const local of [
    'sales_order',
    'sales_order_line',
    'reservation',
    'shipment',
    'shipment_line',
  ]) {
    for (const role of ['list', 'detail', 'form']) {
      const surface = authored.surfaces.find((candidate) =>
        candidate.surfaceId.endsWith(`:surface.${local}_${role}`),
      );
      assert.ok(surface, `${local} ${role}`);
      if (role !== 'list')
        assert.ok(
          surface.slots.some((slot) => slot.slot === 'commandBar'),
          `${local} ${role} command bar`,
        );
    }
  }
});

test('the state machine releases and cancels only through compiled targets', () => {
  const authored = definition();
  const machine = authored.stateMachines[0]!;
  assert.equal(machine.initialState.targetId, SALES_IDS.stateIds.draft);
  assert.deepEqual(
    machine.states.map((state) => [state.stateId, state.terminal]),
    [
      [SALES_IDS.stateIds.draft, false],
      [SALES_IDS.stateIds.released, false],
      ['northstar.sales:state.sales_order_closed', false],
      [SALES_IDS.stateIds.cancelled, true],
    ],
  );
  assert.deepEqual(
    authored.operations
      .filter((operation) => operation.effect.kind === 'transitionStateEffect')
      .map((operation) => operation.operationId),
    [
      'northstar.sales:operation.sales_order_release',
      'northstar.sales:operation.sales_order_draft_cancel',
    ],
  );
  const stateField = (
    normalizeApplicationPackage(salesModuleDefinition()) as unknown as {
      fields: Array<{ fieldId: string; fieldType: { kind: string } }>;
    }
  ).fields.filter((field) => field.fieldId === SALES_IDS.stateFieldId);
  assert.equal(stateField.length, 1);
  assert.equal(stateField[0]!.fieldType.kind, 'enumFieldType');
  assert.equal(
    authored.fields.some((field) => field.fieldId === SALES_IDS.stateFieldId),
    false,
  );
});

test('draft editing is admitted and every released/cancelled edit is refused by the server predicate', () => {
  const authored = definition();
  const guarded = authored.operations.filter(
    (operation) =>
      operation.operationId.startsWith(
        'northstar.sales:operation.sales_order_',
      ) &&
      !operation.operationId.includes('sales_order_line_') &&
      [
        'createRecordEffect',
        'updateRecordEffect',
        'archiveRecordEffect',
        'restoreRecordEffect',
      ].includes(operation.effect.kind),
  );
  assert.equal(guarded.length, 4);
  for (const operation of guarded) {
    assert.ok(operation.precondition);
    assert.equal(
      evaluateRegisteredOperationPrecondition(
        operation.precondition! as Parameters<
          typeof evaluateRegisteredOperationPrecondition
        >[0],
        {
          [SALES_IDS.stateFieldId]: SALES_IDS.stateIds.draft,
        } as Parameters<typeof evaluateRegisteredOperationPrecondition>[1],
      ).outcome,
      'holds',
    );
    for (const state of ['released', 'cancelled'] as const)
      assert.equal(
        evaluateRegisteredOperationPrecondition(
          operation.precondition! as Parameters<
            typeof evaluateRegisteredOperationPrecondition
          >[0],
          {
            [SALES_IDS.stateFieldId]: SALES_IDS.stateIds[state],
          } as Parameters<typeof evaluateRegisteredOperationPrecondition>[1],
        ).outcome,
        'refused',
        `${operation.operationId} must refuse ${state}`,
      );
  }
});

test('line mutations inherit their parent guards and fulfillment references are explicit', () => {
  const authored = definition();
  assert.equal(authored.relations.length, 9);
  assert.deepEqual(
    authored.relations.map((relation) => relation.relationId),
    Object.values(SALES_IDS.relationIds),
  );
  assert.equal(
    authored.relations.find(
      (relation) =>
        relation.relationId === SALES_IDS.relationIds.salesOrderLineOrder,
    )?.ownership,
    'parentScopedChild',
  );
  assert.equal(
    authored.operations
      .filter((operation) =>
        operation.operationId.includes('sales_order_line_'),
      )
      .some((operation) => operation.precondition !== undefined),
    false,
  );
  assert.equal(
    authored.relations.find(
      (relation) =>
        relation.relationId ===
        'northstar.sales:relation.shipment_line_shipment',
    )?.ownership,
    'parentScopedChild',
  );
});

test('all sales permissions are exact current-policy contracts', () => {
  const authored = definition();
  assert.deepEqual(
    authored.permissions.map((permission) => [
      permission.action,
      permission.permissionId,
      permission.resource.targetId,
    ]),
    [
      ...['create', 'read', 'update', 'archive', 'restore'].map((action) => [
        action,
        `northstar.sales:permission.sales_order_${action}`,
        SALES_IDS.entityIds.salesOrder,
      ]),
      ...['create', 'read', 'update', 'archive', 'restore'].map((action) => [
        action,
        `northstar.sales:permission.sales_order_line_${action}`,
        SALES_IDS.entityIds.salesOrderLine,
      ]),
      ...['create', 'read', 'update', 'archive', 'restore'].map((action) => [
        action,
        `northstar.sales:permission.reservation_${action}`,
        'northstar.sales:entity.reservation',
      ]),
      [
        'read',
        'northstar.sales:permission.reservation_balance_read',
        'northstar.sales:entity.reservation_balance',
      ],
      ...['create', 'read', 'update', 'archive', 'restore'].map((action) => [
        action,
        `northstar.sales:permission.shipment_${action}`,
        'northstar.sales:entity.shipment',
      ]),
      ...['create', 'read', 'update', 'archive', 'restore'].map((action) => [
        action,
        `northstar.sales:permission.shipment_line_${action}`,
        'northstar.sales:entity.shipment_line',
      ]),
      [
        'read',
        'northstar.sales:permission.sales_order_shipped_read',
        'northstar.sales:entity.sales_order_shipped',
      ],
      [
        'transition',
        'northstar.sales:permission.sales_order_release',
        SALES_IDS.entityIds.salesOrder,
      ],
      [
        'transition',
        'northstar.sales:permission.sales_order_cancel',
        SALES_IDS.entityIds.salesOrder,
      ],
      [
        'transition',
        'northstar.sales:permission.sales_order_close',
        SALES_IDS.entityIds.salesOrder,
      ],
      [
        'transition',
        'northstar.sales:permission.reservation_reserve',
        'northstar.sales:entity.reservation',
      ],
      [
        'transition',
        'northstar.sales:permission.reservation_release',
        'northstar.sales:entity.reservation',
      ],
      [
        'transition',
        'northstar.sales:permission.shipment_post',
        'northstar.sales:entity.shipment',
      ],
    ],
  );
});

test('sales queries and storage are explicitly entity-owned', () => {
  const authored = definition();
  assert.equal(
    authored.queries.every(
      (query) => query.legalEntityScope?.cardinality === 'exactlyOne',
    ),
    true,
  );
  for (const familyId of ['sales_order', 'sales_order_line'])
    assert.deepEqual(
      LEGAL_ENTITY_FAMILY_MAP_V1.find((rule) => rule.familyId === familyId),
      { classification: 'entityOwned', familyId },
    );
  assert.deepEqual(
    LEGAL_ENTITY_RELATION_SEMANTICS_V1.find(
      (rule) => rule.sourceFamilyId === 'sales_order_line',
    ),
    {
      semantics: 'sameEntity',
      sourceFamilyId: 'sales_order_line',
      targetFamilyId: 'sales_order',
    },
  );
});

test('sales is the sixth compiled navigation group and fulfillment is registered behavior', () => {
  assert.deepEqual(COMPOSED_MODULE_NAMES, [
    'party',
    'catalog',
    'location',
    'inventory',
    'purchasing',
    'sales',
  ]);
  const composed = composedApplicationDefinition() as unknown as Definition & {
    modules: Array<{ label: string; orderKey: number }>;
  };
  assert.deepEqual(composed.modules.at(-1), {
    composition: {
      kind: 'compositionSeam',
      schemaVersion: 'v5',
      status: 'unsupported',
    },
    kind: 'moduleDefinition',
    label: 'Sales',
    moduleId: 'northstar.app:module.sales',
    orderKey: 60,
    ownerPackageId: 'northstar.app:package.application',
    schemaVersion: 'v5',
  });
  const salesOperations = composed.operations.filter((operation) =>
    operation.operationId.includes(':operation.sales_order'),
  );
  assert.equal(
    salesOperations.filter(
      (operation) => operation.effect.kind === 'registeredCapabilityEffect',
    ).length,
    2,
  );
  assert.match(JSON.stringify(salesModuleDefinition()), /reservation/gu);
  assert.match(JSON.stringify(salesModuleDefinition()), /shipment/gu);
});
