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
  RECEIVABLES_CAPABILITY_ID,
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
  // Ruling C adds the invoice, its lines, the payment and the credit;
  // RETURNS (ruling D) the customer return and its lines.
  assert.equal(authored.entities.length, 13);
  // SALES-PARITY adds the shipment's carrier, reference type and reference,
  // then (ruling E) the order's salesperson, terms, ship-to address and six
  // ship-to lines, and the same six lines on the shipment; then (ruling B)
  // the order's tax code and two charges with codes and frozen rates, and the
  // line's list price, discount, tax code and frozen rate; then (ruling C)
  // 14 invoice, 9 invoice-line, 6 payment and 5 credit fields; then
  // (RETURNS) 7 return and 5 return-line fields.
  assert.equal(authored.fields.length, 110);
  // SALES-PARITY adds sales_order_reopen (ruling F), then the four
  // receivables documents' CRUD and their post and void commands; RETURNS
  // the return's and its lines' CRUD and its post.
  assert.equal(authored.operations.length, 57);
  assert.equal(authored.permissions.length, 68);
  assert.equal(authored.queries.length, 52);
  assert.equal(authored.surfaces.length, 37);
  for (const local of [
    'sales_order',
    'sales_order_line',
    'reservation',
    'shipment',
    'shipment_line',
    'customer_return',
    'customer_return_line',
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
      // Ruling F (SALES-PARITY) reopens a closed order through the
      // receivables capability, which reads the order's invoices.
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
  assert.equal(authored.relations.length, 18);
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
      // Ruling C: the receivables documents.
      ...[
        'customer_invoice',
        'customer_invoice_line',
        'customer_payment',
        'customer_credit',
        // RETURNS (ruling D): the return and its lines.
        'customer_return',
        'customer_return_line',
      ].flatMap((local) =>
        ['create', 'read', 'update', 'archive', 'restore'].map((action) => [
          action,
          `northstar.sales:permission.${local}_${action}`,
          `northstar.sales:entity.${local}`,
        ]),
      ),
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
      [
        'transition',
        'northstar.sales:permission.customer_return_post',
        'northstar.sales:entity.customer_return',
      ],
      ...(
        [
          ['customer_invoice', 'post'],
          ['customer_invoice', 'void'],
          ['customer_payment', 'post'],
          ['customer_credit', 'post'],
        ] as const
      ).map(([local, action]) => [
        'transition',
        `northstar.sales:permission.${local}_${action}`,
        `northstar.sales:entity.${local}`,
      ]),
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

test('sales leads compiled business navigation and fulfillment is registered behavior', () => {
  assert.deepEqual(COMPOSED_MODULE_NAMES, [
    'sales',
    'purchasing',
    'inventory',
    'party',
    'catalog',
    'location',
  ]);
  const composed = composedApplicationDefinition() as unknown as Definition & {
    modules: Array<{ label: string; orderKey: number }>;
  };
  assert.deepEqual(composed.modules.at(0), {
    composition: {
      kind: 'compositionSeam',
      schemaVersion: ADOPTED_LANGUAGE_VERSION,
      status: 'unsupported',
    },
    kind: 'moduleDefinition',
    label: 'Sales',
    moduleId: 'northstar.app:module.sales',
    orderKey: 10,
    ownerPackageId: 'northstar.app:package.application',
    schemaVersion: ADOPTED_LANGUAGE_VERSION,
  });
  const salesOperations = composed.operations.filter((operation) =>
    operation.operationId.includes(':operation.sales_order'),
  );
  // Close and cancel (fulfillment), and reopen (receivables, ruling F).
  assert.equal(
    salesOperations.filter(
      (operation) => operation.effect.kind === 'registeredCapabilityEffect',
    ).length,
    3,
  );
  assert.match(JSON.stringify(salesModuleDefinition()), /reservation/gu);
  assert.match(JSON.stringify(salesModuleDefinition()), /shipment/gu);
});

test('ruling F and shipping: the release command reads Confirm, a closed order reopens under confirmation, shipments carry carrier and reference', () => {
  const authored = salesModuleDefinition() as unknown as {
    operations: Array<{
      operationId: string;
      label?: string;
      confirmation: string;
      permission: { targetId: string };
      precondition: unknown;
    }>;
    stateMachines: Array<{
      transitions: Array<{
        transitionId: string;
        fromState: { targetId: string };
        toState: { targetId: string };
      }>;
    }>;
    fields: Array<{ fieldId: string; presence?: string }>;
  };
  const operation = (local: string) =>
    authored.operations.find(
      (value) => value.operationId === `northstar.sales:operation.${local}`,
    )!;
  // Presentation only: the stable id keeps its verb, so ADR-0056 still puts
  // it first on the command bar.
  assert.equal(operation('sales_order_release').label, 'Confirm');
  const reopen = operation('sales_order_reopen');
  assert.equal(reopen.confirmation, 'humanRequired');
  assert.equal(
    reopen.permission.targetId,
    'northstar.sales:permission.sales_order_close',
  );
  assert.match(
    JSON.stringify(reopen.precondition),
    /northstar\.sales:state\.sales_order_closed/u,
  );
  const transition = authored.stateMachines[0]!.transitions.find((value) =>
    value.transitionId.endsWith('transition.sales_order_reopen'),
  )!;
  assert.equal(
    transition.fromState.targetId,
    'northstar.sales:state.sales_order_closed',
  );
  assert.equal(transition.toState.targetId, SALES_IDS.stateIds.released);
  for (const name of [
    'carrier',
    'shipping_reference_kind',
    'shipping_reference',
  ])
    assert.equal(
      authored.fields.find(
        (field) => field.fieldId === `northstar.sales:field.shipment_${name}`,
      )?.presence,
      'optional',
      `shipment ${name} is optional on the entity (a correction has none)`,
    );
});

test('ruling E: Confirm and an initial shipment require a complete ship-to; a correction does not', () => {
  const authored = definition();
  type Precondition = Parameters<
    typeof evaluateRegisteredOperationPrecondition
  >[0];
  type Image = Parameters<typeof evaluateRegisteredOperationPrecondition>[1];
  const operation = (local: string) =>
    authored.operations.find(
      (value) => value.operationId === `northstar.sales:operation.${local}`,
    )!;
  const outcome = (local: string, image: Record<string, string>) =>
    evaluateRegisteredOperationPrecondition(
      operation(local).precondition as Precondition,
      image as Image,
    ).outcome;
  const shipTo = (entity: 'sales_order' | 'shipment', blank?: string) =>
    Object.fromEntries(
      ['street', 'city', 'postal_code', 'country'].map((name) => [
        `northstar.sales:field.${entity}_ship_to_${name}`,
        name === blank ? '' : `${name} value`,
      ]),
    );
  const draft = { [SALES_IDS.stateFieldId]: SALES_IDS.stateIds.draft };
  assert.equal(
    outcome('sales_order_release', { ...draft, ...shipTo('sales_order') }),
    'holds',
  );
  for (const blank of ['street', 'city', 'postal_code', 'country'])
    assert.equal(
      outcome('sales_order_release', {
        ...draft,
        ...shipTo('sales_order', blank),
      }),
      'refused',
      `Confirm must refuse a blank ${blank}`,
    );
  assert.equal(outcome('sales_order_release', draft), 'refused');
  const shipment = (kind: string) => ({
    'northstar.sales:field.shipment_state':
      'northstar.sales:option.shipment_state_draft',
    'northstar.sales:field.shipment_kind': `northstar.sales:option.shipment_kind_${kind}`,
  });
  for (const local of ['shipment_create', 'shipment_update']) {
    assert.equal(
      outcome(local, { ...shipment('initial'), ...shipTo('shipment') }),
      'holds',
    );
    assert.equal(outcome(local, shipment('initial')), 'refused');
    assert.equal(
      outcome(local, { ...shipment('initial'), ...shipTo('shipment', 'city') }),
      'refused',
    );
    assert.equal(outcome(local, shipment('correction')), 'holds');
  }
  // Archiving a draft shipment keeps its original guard: state only.
  assert.equal(outcome('shipment_archive', shipment('initial')), 'holds');
});

test('ruling C: receivables documents change only as drafts, post once through the receivables capability, and are numbered', () => {
  const authored = definition() as unknown as {
    fields: Array<{
      fieldId: string;
      numbering?: { prefix: string };
    }>;
    operations: Array<{
      operationId: string;
      effect: { kind: string; capability?: { targetId: string } };
      precondition?: unknown;
    }>;
  };
  const ns = 'northstar.sales';
  for (const [local, prefix] of [
    ['customer_invoice', 'INV'],
    ['customer_payment', 'PAY'],
    ['customer_credit', 'CM'],
  ] as const) {
    assert.equal(
      authored.fields.find(
        (field) => field.fieldId === `${ns}:field.${local}_number`,
      )?.numbering?.prefix,
      prefix,
    );
    const state = `${ns}:field.${local}_state`;
    for (const action of ['create', 'update', 'archive', 'restore']) {
      const operation = authored.operations.find(
        (candidate) =>
          candidate.operationId === `${ns}:operation.${local}_${action}`,
      )!;
      const evaluate = (value: string) =>
        evaluateRegisteredOperationPrecondition(
          operation.precondition as Parameters<
            typeof evaluateRegisteredOperationPrecondition
          >[0],
          { [state]: value } as Parameters<
            typeof evaluateRegisteredOperationPrecondition
          >[1],
        ).outcome;
      assert.equal(evaluate(`${ns}:option.${local}_state_draft`), 'holds');
      assert.equal(
        evaluate(
          `${ns}:option.${local}_state_${local === 'customer_invoice' ? 'open' : 'posted'}`,
        ),
        'refused',
        `${local}_${action} must refuse a posted document`,
      );
    }
  }
  assert.deepEqual(
    authored.operations
      .filter(
        (operation) =>
          operation.effect.capability?.targetId === RECEIVABLES_CAPABILITY_ID,
      )
      .map((operation) => operation.operationId),
    [
      `${ns}:operation.customer_invoice_post`,
      `${ns}:operation.customer_invoice_void`,
      `${ns}:operation.customer_payment_post`,
      `${ns}:operation.customer_credit_post`,
      `${ns}:operation.sales_order_reopen`,
    ],
  );
});

test('ruling D: a customer return takes an RMA number, changes only while a draft and posts through fulfillment', () => {
  const authored = definition();
  const number = authored.fields.find(
    (field) => field.fieldId === 'northstar.sales:field.customer_return_number',
  ) as unknown as { numbering?: { prefix: string } } | undefined;
  assert.equal(number?.numbering?.prefix, 'RMA');
  const draft = {
    'northstar.sales:field.customer_return_state':
      'northstar.sales:option.customer_return_state_draft',
  } as Parameters<typeof evaluateRegisteredOperationPrecondition>[1];
  const posted = {
    'northstar.sales:field.customer_return_state':
      'northstar.sales:option.customer_return_state_posted',
  } as Parameters<typeof evaluateRegisteredOperationPrecondition>[1];
  for (const local of [
    'customer_return_create',
    'customer_return_update',
    'customer_return_archive',
    'customer_return_post',
  ]) {
    const operation = authored.operations.find(
      (candidate) =>
        candidate.operationId === `northstar.sales:operation.${local}`,
    );
    assert.ok(operation?.precondition, local);
    const outcome = (image: typeof draft) =>
      evaluateRegisteredOperationPrecondition(
        operation.precondition! as Parameters<
          typeof evaluateRegisteredOperationPrecondition
        >[0],
        image,
      ).outcome;
    assert.equal(outcome(draft), 'holds', local);
    assert.equal(outcome(posted), 'refused', local);
  }
  const post = authored.operations.find(
    (operation) =>
      operation.operationId ===
      'northstar.sales:operation.customer_return_post',
  ) as unknown as {
    effect: { kind: string; capability: { targetId: string } };
    tier: string;
  };
  assert.equal(post.effect.kind, 'registeredCapabilityEffect');
  assert.equal(
    post.effect.capability.targetId,
    'northstar.sales:capability.fulfillment',
  );
  assert.equal(post.tier, 'o1');
  const relation = (local: string) =>
    authored.relations.find(
      (candidate) =>
        candidate.relationId === `northstar.sales:relation.${local}`,
    ) as unknown as { ownership: string; required: boolean } | undefined;
  assert.equal(relation('customer_return_order')?.ownership, 'reference');
  assert.equal(relation('customer_return_supersedes')?.required, false);
  assert.equal(
    relation('customer_return_line_return')?.ownership,
    'parentScopedChild',
  );
  assert.equal(
    relation('customer_return_line_order_line')?.ownership,
    'reference',
  );
  for (const familyId of ['customer_return', 'customer_return_line'])
    assert.deepEqual(
      LEGAL_ENTITY_FAMILY_MAP_V1.find((rule) => rule.familyId === familyId),
      { classification: 'entityOwned', familyId },
    );
});
