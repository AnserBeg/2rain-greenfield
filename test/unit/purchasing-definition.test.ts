import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADOPTED_LANGUAGE_VERSION,
  ADOPTED_NORMALIZATION_PROFILE_VERSION,
  CanonicalModelError,
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type CompilerInput,
  type StorageTargetPayloadV1,
  type StorageTransitionEnvelope,
} from '../../packages/compiler/src/index.js';
import {
  COMPOSED_MODULE_NAMES,
  composedApplicationDefinition,
} from '../../packages/domain/src/app/builder.js';
import {
  LEGAL_ENTITY_FAMILY_MAP_V1,
  LEGAL_ENTITY_RELATION_SEMANTICS_V1,
} from '../../packages/domain/src/inventory/contracts.js';
import {
  PAYABLES_CAPABILITY_ID,
  PURCHASING_IDS,
  purchasingModuleDefinition,
} from '../../packages/domain/src/purchasing/index.js';
import { evaluateRegisteredOperationPrecondition } from '../../packages/runtime/src/semantic-operation-gateway.js';
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/definition.js';
import { purchaseOrderRevisionDigest, currentPurchaseOrderApproval } from '../../packages/postgres-provider/src/purchase-order-approval.js';
import { purchaseOrderApprovalInput } from '../../packages/postgres-provider/src/purchase-order-approval-executor.js';
import { localDemoActor } from '../../packages/runtime/src/local-demo-actor.js';

test('approval revision identity changes for a header edit, line edit, addition or removal, never for query order', () => {
  const lines = [{ recordId: 'b', revision: 1 }, { recordId: 'a', revision: 2 }];
  const digest = purchaseOrderRevisionDigest(1, lines);
  assert.equal(purchaseOrderRevisionDigest(1, [...lines].reverse()), digest);
  for (const changed of [purchaseOrderRevisionDigest(2, lines), purchaseOrderRevisionDigest(1, [{ recordId: 'a', revision: 3 }, lines[0]!]), purchaseOrderRevisionDigest(1, lines.slice(1)), purchaseOrderRevisionDigest(1, [...lines, { recordId: 'c', revision: 1 }])]) assert.notEqual(changed, digest);
  assert.equal(currentPurchaseOrderApproval(digest, [{ digest, state: 'approved', kind: 'order' }]), 'Approved');
  assert.equal(currentPurchaseOrderApproval(digest, [{ digest: 'prior', state: 'approved', kind: 'order' }]), 'Not requested');
  assert.equal(currentPurchaseOrderApproval(digest, [{ digest, state: 'approved', kind: 'amendment' }]), 'Not requested');
  assert.equal(currentPurchaseOrderApproval(digest, [{ digest, state: 'consumed', kind: 'order' }]), 'Not requested');
});

test('approval inputs refuse forged actors, unknown arguments, missing decision reasons and inexact quantities', () => {
  const base = { recordId: 'record', expectedRevision: 1 };
  assert.equal(purchaseOrderApprovalInput({ ...base, arguments: { reason: 'Checked supplier terms' } }, 'approve').reason, 'Checked supplier terms');
  assert.equal(purchaseOrderApprovalInput({ ...base, arguments: { supplierReference: null } }, 'release').supplierReference, null);
  for (const input of [{ ...base, principalId: 'manager' }, { ...base, arguments: { decidedBy: 'manager', reason: 'x' } }, { ...base, arguments: { reason: '  ' } }, { ...base, expectedRevision: 1.5 }, { ...base, arguments: { reason: 'x'.repeat(1001) } }]) assert.throws(() => purchaseOrderApprovalInput(input, 'approve'));
  for (const quantity of ['-1', '1e3', '1.0000000000000000001', 1]) assert.throws(() => purchaseOrderApprovalInput({ ...base, arguments: { quantity, reason: 'Changed demand' } }, 'amend'));
  assert.equal(localDemoActor(undefined), 'buyer');
  assert.equal(localDemoActor('irrelevant=yes; northstar-demo-actor=manager'), 'manager');
  assert.equal(localDemoActor('northstar-demo-actor=administrator'), 'buyer');
});

test('the approval inbox is a declared List and requests have no generic write path or new PO state', () => {
  const model = normalizeApplicationPackage(composedApplicationDefinition());
  const request = 'northstar.app:entity.purchase_order_approval';
  assert.ok(model.surfaces.find((surface) => surface.surfaceId === 'northstar.app:surface.purchase_order_approval_list')?.list);
  assert.equal(model.operations.some((operation) => 'entity' in operation.effect && operation.effect.entity.targetId === request), false);
  assert.equal(model.stateMachines.find((machine) => machine.machineId === 'northstar.app:machine.purchase_order_lifecycle')?.states.length, 4);
  assert.equal(model.operations.find((operation) => operation.operationId === 'northstar.app:operation.purchase_order_release')?.label, 'Place order');
  for (const local of ['approve', 'reject']) assert.equal(model.operations.find((operation) => operation.operationId === `northstar.app:operation.purchase_order_approval_${local}`)?.permission.targetId, 'northstar.app:permission.purchase_order_approve');
});

const namespace = PURCHASING_IDS.namespace;
const stateFieldId = PURCHASING_IDS.stateFieldId;
const orderEntityId = PURCHASING_IDS.entityIds.purchaseOrder;
const lineEntityId = PURCHASING_IDS.entityIds.purchaseOrderLine;

/**
 * The lifecycle as this module declares it, written out once as literal data
 * rather than read back out of the definition. A table derived from the subject
 * cannot disagree with it, which is the whole failure mode these controls exist
 * to catch.
 */
const LIFECYCLE = {
  initialState: 'draft',
  states: [
    ['draft', 'Draft', false],
    ['released', 'Released', false],
    ['closed', 'Closed', false],
    ['cancelled', 'Cancelled', true],
  ],
  transitions: [
    ['release', 'draft', 'released'],
    ['draft_cancel', 'draft', 'cancelled'],
    ['close', 'released', 'closed'],
    ['reopen', 'closed', 'released'],
    ['cancel', 'released', 'cancelled'],
  ],
} as const;

/**
 * The transitions a generic transition operation drives. `close`, `reopen` and
 * the committed `cancel` are DECLARED EDGES ONLY for the press -- plan section
 * 7.17 says what closes an order is `PUR-2`'s to decide, and PURCHASING-PARITY
 * refuses a cancel after any net receipt -- so each is moved by a guarded
 * receiving operation that reads the order's receipts under its lock.
 */
const DRIVEN = ['release', 'draft_cancel'] as const;
const DECLARED_ONLY = ['close', 'reopen', 'cancel'] as const;

/**
 * Five transitions, four permissions: both cancels authorize on one
 * `purchase_order_cancel` permission. ADR-0050 section 7's equality rule is per
 * operation/transition PAIR, so sharing one id across two pairs satisfies it.
 */
const TRANSITION_PERMISSIONS: Readonly<Record<string, string>> = {
  cancel: 'cancel',
  close: 'close',
  draft_cancel: 'cancel',
  release: 'release',
  reopen: 'reopen',
};

/** Every state-to-state pair the ruling REFUSES, so absence is asserted rather than assumed. */
const REFUSED_MOVES = [
  ['released', 'draft'],
  ['closed', 'draft'],
  ['cancelled', 'draft'],
  ['closed', 'cancelled'],
  ['cancelled', 'released'],
  ['cancelled', 'closed'],
  ['draft', 'closed'],
] as const;

const GENERIC_ACTIONS = ['create', 'update', 'archive', 'restore'] as const;

// ===========================================================================
// BAND A -- the state field.
//
// A purchase order in the wrong state is a stored fact every later reader takes
// as true, and nobody meets that failure on use. AGENTS.md section 6 therefore asks
// for one recorded red per vacuity vector, each varying exactly one property.
// The vectors and where each is discharged are named at the control that
// discharges it.
// ===========================================================================

test('the machine materializes exactly one state field, at the id normalization derives', () => {
  const shipped = normalized();

  // The subject, read from normalization's output rather than from the module's
  // own constant.
  const enumFields = orderEnumFields(shipped);
  assert.equal(
    enumFields.length,
    1,
    `purchase_order carries ${String(enumFields.length)} enum fields; a document has one state field, not two`,
  );
  const state = enumFields[0]!;
  assert.equal(state.fieldId, stateFieldId);
  assert.equal(state.label, 'State');
  assert.equal(
    state.orderKey,
    0,
    'the state field precedes every authored field',
  );
  assert.equal(state.presence, 'required');
  assert.equal(state.defaultSemantics, 'declaredDefault');
  assert.deepEqual(state.defaultValue, {
    kind: 'textValue',
    schemaVersion: ADOPTED_LANGUAGE_VERSION,
    value: PURCHASING_IDS.stateIds.draft,
  });
  assert.equal(state.searchable, false);
  assert.equal(state.entity.targetId, orderEntityId);

  // The options ARE the machine's states, so `stateId` and `optionId` are one
  // identity rather than two that must be kept in step.
  assert.deepEqual(
    state.fieldType.options?.map((option) => [option.optionId, option.label]),
    LIFECYCLE.states.map(([local, label]) => [
      PURCHASING_IDS.stateIds[local],
      label,
    ]),
  );

  // No `state` was authored anywhere: the only enum on the entity is the one
  // above, and no authored field carries that local name.
  assert.equal(
    authored().fields.some((field) =>
      /:field\.purchase_order_state$/u.test(field.fieldId),
    ),
    false,
  );
});

test("control: the derived state field id is normalization's answer, not this module's constant", () => {
  // VACUITY VECTOR -- the subject repaired before it is measured. The id is
  // spelled twice: `normalize.ts` derives it from the machine, and
  // `definition.ts` re-derives it so preconditions and selections can address
  // it. If the assertion above read the module's constant on both sides it
  // would pass while the two disagreed.
  //
  // Varying EXACTLY ONE property -- the machine id -- moves normalization's
  // derived field and leaves the module's constant behind, and the package
  // refuses by name rather than compiling against a field that is not there.
  //
  // The refusal pair is exactly the one ADR-0050 section 1 measured before the
  // ruling: a precondition on the state field fails `CANON_REFERENCE_UNRESOLVED`
  // and a query selecting it fails `CANON_QUERY_FIELD_LOCALITY`. Here they mean
  // the ruling is working -- the field exists at the id the MACHINE names, and
  // nowhere else.
  assertRefusalPair(
    normalizationRefusal((definition) => {
      definition.stateMachines[0]!.machineId = `${namespace}:machine.renamed`;
    }),
  );

  // And the derivation itself is observed rather than asserted: renaming the
  // machine moves the field to the id the SAME rule predicts.
  const renamed = normalizeApplicationPackage(
    mutated((definition) => {
      definition.stateMachines[0]!.machineId = `${namespace}:machine.renamed`;
      stripStateFieldReferences(definition);
    }),
  ) as unknown as NormalizedShape;
  assert.equal(
    orderEnumFields(renamed)[0]?.fieldId,
    `${namespace}:derived_state_field.machine.renamed`,
  );
});

test('control: with no machine there is no state field, and every reader of it refuses by name', () => {
  // VACUITY VECTOR -- the subject absent entirely. One property varies:
  // `stateMachines` becomes empty, which is what every other first-party module
  // still declares.
  assertRefusalPair(
    normalizationRefusal((definition) => {
      definition.stateMachines = [];
    }),
  );

  // And the field really is gone rather than merely unreferenced.
  const machineless = normalizeApplicationPackage(
    mutated((definition) => {
      definition.stateMachines = [];
      stripStateFieldReferences(definition);
    }),
  ) as unknown as NormalizedShape;
  assert.deepEqual(orderEnumFields(machineless), []);
});

test('control: an authored field cannot counterfeit the state identity, and a second enum is visible', () => {
  // VACUITY VECTOR -- a proxy satisfied while the fact does not hold, twice
  // over.
  //
  // (a) An authored field carrying the DERIVED id would satisfy any check that
  //     looks the id up, while the column it mints is an ordinary caller-
  //     writable text field.
  assert.deepEqual(
    normalizationRefusal((definition) => {
      definition.fields.push(
        authoredField(orderEntityId, stateFieldId, 'State', 90, {
          kind: 'textFieldType',
          maximumLength: 40,
          schemaVersion: ADOPTED_LANGUAGE_VERSION,
        }),
      );
    }),
    ['CANON_STATE_FIELD_COLLISION'],
  );

  // (b) A second enum under a DIFFERENT id is not refused by the compiler -- it
  //     is an ordinary field -- so the "exactly one enum" assertion above is
  //     what stands between this module and two state fields. It must red.
  const twoStates = normalizeApplicationPackage(
    mutated((definition) => {
      definition.fields.push(
        authoredField(
          orderEntityId,
          `${namespace}:field.purchase_order_state`,
          'Order state',
          90,
          {
            kind: 'enumFieldType',
            options: LIFECYCLE.states.map(([local, label], index) => ({
              kind: 'enumOption',
              label,
              optionId: `${namespace}:option.purchase_order_state_${local}`,
              orderKey: (index + 1) * 10,
              schemaVersion: ADOPTED_LANGUAGE_VERSION,
            })),
            schemaVersion: ADOPTED_LANGUAGE_VERSION,
          },
        ),
      );
    }),
  ) as unknown as NormalizedShape;
  assert.equal(orderEnumFields(twoStates).length, 2);
});

test('control: the enum-field reader fails on empty input rather than passing over it', () => {
  // VACUITY VECTOR -- the check reading zero input. `orderEnumFields` selects by
  // entity id; a wrong entity id, or an entity with no fields, would return []
  // and every "exactly one" assertion would become "exactly zero" unless the
  // count is asserted. It is, so this control shows the empty case is a red.
  assert.throws(() => {
    const empty = normalizeApplicationPackage(
      mutated((definition) => {
        definition.stateMachines = [];
        stripStateFieldReferences(definition);
      }),
    ) as unknown as NormalizedShape;
    const found = orderEnumFields(empty);
    assert.equal(found.length, 1);
  }, /Expected values to be strictly equal/u);
});

test('control: the projection reader refuses a shape it does not recognise', () => {
  // VACUITY VECTOR -- output shapes the parser does not recognise. Every
  // compiled assertion below reads through `projectionPayload`. If it returned
  // `undefined` for an absent family, `payload.operations?.find(...)` would be
  // `undefined` and optional-chained assertions would pass over nothing.
  assert.throws(
    () => projectionPayload(compile(), 'northstar.projection:not-a-family'),
    /not-a-family/u,
  );
});

test('the state field is machine-owned: no caller-writable contract admits it', () => {
  const operations = operationCatalog(compile());
  for (const operation of operations) {
    assert.equal(
      operation.inputContract?.writableFieldIds.includes(stateFieldId) ?? false,
      false,
      `${operation.operationId} admits the state field as caller input`,
    );
  }

  // The two creates write their authored fields and only those -- except the
  // order number, which the server assigns (SALES-PARITY numbering) and the
  // create contract names as an assignment instead of an input.
  const numberFieldId = PURCHASING_IDS.fieldIds.purchaseOrder.number;
  assert.deepEqual(
    writableFieldIds(
      operations,
      `${namespace}:operation.purchase_order_create`,
    ),
    Object.values(PURCHASING_IDS.fieldIds.purchaseOrder)
      .filter((fieldId) => fieldId !== numberFieldId)
      .toSorted(),
  );
  const createContract = operations.find(
    (operation) =>
      operation.operationId === `${namespace}:operation.purchase_order_create`,
  )?.inputContract as
    { assignedFields?: Array<{ fieldId: string; prefix: string }> } | undefined;
  assert.deepEqual(
    createContract?.assignedFields?.map((field) => [
      field.fieldId,
      field.prefix,
    ]),
    [[numberFieldId, 'PO']],
  );
  assert.deepEqual(
    writableFieldIds(
      operations,
      `${namespace}:operation.purchase_order_line_create`,
    ),
    Object.values(PURCHASING_IDS.fieldIds.purchaseOrderLine).toSorted(),
  );
});

test('control: an ordinary authored state WOULD be caller-writable, so the exclusion is a real one', () => {
  // Varying exactly one property -- the machine is replaced by an authored enum
  // of the same four values -- shows the exclusion above is the ruling at work
  // and not an artifact of the field being absent from `fields`.
  const withAuthoredState = compile(
    mutated((definition) => {
      definition.stateMachines = [];
      stripStateFieldReferences(definition);
      definition.fields.push(
        authoredField(
          orderEntityId,
          `${namespace}:field.purchase_order_state`,
          'Order state',
          90,
          {
            kind: 'enumFieldType',
            options: LIFECYCLE.states.map(([local, label], index) => ({
              kind: 'enumOption',
              label,
              optionId: `${namespace}:option.purchase_order_state_${local}`,
              orderKey: (index + 1) * 10,
              schemaVersion: ADOPTED_LANGUAGE_VERSION,
            })),
            schemaVersion: ADOPTED_LANGUAGE_VERSION,
          },
        ),
      );
    }),
  );
  assert.equal(
    writableFieldIds(
      operationCatalog(withAuthoredState),
      `${namespace}:operation.purchase_order_create`,
    ).includes(`${namespace}:field.purchase_order_state`),
    true,
  );
});

test('the state field is on the read path: every purchase order query selects it', () => {
  const queries = queryCatalog(compile()).filter(
    (query) => query.sourceEntityId === orderEntityId,
  );
  assert.equal(
    queries.length,
    4,
    'the read-path control examined the wrong number of purchase_order queries',
  );
  for (const query of queries) {
    assert.equal(
      query.selections.some((selection) => selection.fieldId === stateFieldId),
      true,
      `${query.queryId} cannot report the order's state`,
    );
    // State first, matching its materialized orderKey of 0.
    assert.equal(query.selections[0]?.fieldId, stateFieldId);
  }

  // The line has no state of its own and must not pretend to.
  for (const query of queryCatalog(compile()).filter(
    (query) => query.sourceEntityId === lineEntityId,
  )) {
    assert.equal(
      query.selections.some((selection) => selection.fieldId === stateFieldId),
      false,
    );
  }
});

test('control: dropping one selection reds the read-path check', () => {
  // ADR-0050 section 6 item 1 -- "nothing yet admits it to query selections, so a
  // released purchase order cannot be listed by state" -- is the gap this
  // module cannot ship without. Below v5 the selection is not expressible at
  // all; at v5 it is expressible AND omittable, so omission is what this
  // control observes.
  const thinned = compile(
    mutated((definition) => {
      const list = definition.queries.find(
        (query) => query.queryId === `${namespace}:query.purchase_order_list`,
      )!;
      list.selections = list.selections.filter(
        (selection) => selection.field.targetId !== stateFieldId,
      );
    }),
  );
  const list = queryCatalog(thinned).find(
    (query) => query.queryId === `${namespace}:query.purchase_order_list`,
  );
  assert.equal(
    list?.selections.some((selection) => selection.fieldId === stateFieldId),
    false,
  );
});

// ===========================================================================
// BAND A -- the release and cancel transitions, and the two the bridge added.
// ===========================================================================

test('the machine declares the whole lifecycle and nothing outside it', () => {
  const machines = normalized().stateMachines;
  assert.equal(machines.length, 1);
  const machine = machines[0]!;
  assert.equal(machine.entity.targetId, orderEntityId);
  assert.equal(
    machine.initialState.targetId,
    PURCHASING_IDS.stateIds[LIFECYCLE.initialState],
  );
  assert.deepEqual(
    machine.states.map((state) => [state.stateId, state.label, state.terminal]),
    LIFECYCLE.states.map(([local, label, terminal]) => [
      PURCHASING_IDS.stateIds[local],
      label,
      terminal,
    ]),
  );

  const declared = machine.transitions.map((transition) => [
    transition.fromState.targetId,
    transition.toState.targetId,
  ]);
  assert.deepEqual(
    declared.toSorted(),
    LIFECYCLE.transitions
      .map(([, from, to]) => [
        PURCHASING_IDS.stateIds[from],
        PURCHASING_IDS.stateIds[to],
      ])
      .toSorted(),
  );

  // Absence asserted, not assumed. `released -> draft` is refused because draft
  // asserts no commitments exist; `cancelled -> anything` because cancelled is
  // terminal and the answer is a reissue.
  for (const [from, to] of REFUSED_MOVES) {
    assert.equal(
      declared.some(
        (pair) =>
          pair[0] === PURCHASING_IDS.stateIds[from] &&
          pair[1] === PURCHASING_IDS.stateIds[to],
      ),
      false,
      `${from} -> ${to} is declared and the ruling refuses it`,
    );
  }
});

test('control: an added move is seen by the same check that asserts absence', () => {
  // Without this the absence assertion above could be satisfied by a check that
  // reads the wrong collection and finds nothing anywhere.
  const reopened = normalizeApplicationPackage(
    mutated((definition) => {
      definition.stateMachines[0]!.transitions.push({
        fromState: canonicalReference(
          'stateReference',
          PURCHASING_IDS.stateIds.released,
        ),
        kind: 'transitionDefinition',
        label: 'Return to draft',
        orderKey: 90,
        permission: canonicalReference(
          'permissionReference',
          `${namespace}:permission.purchase_order_release`,
        ),
        schemaVersion: ADOPTED_LANGUAGE_VERSION,
        toState: canonicalReference(
          'stateReference',
          PURCHASING_IDS.stateIds.draft,
        ),
        transitionId: `${namespace}:transition.purchase_order_unrelease`,
      });
    }),
  ) as unknown as NormalizedShape;
  assert.equal(
    reopened.stateMachines[0]!.transitions.some(
      (transition) =>
        transition.fromState.targetId === PURCHASING_IDS.stateIds.released &&
        transition.toState.targetId === PURCHASING_IDS.stateIds.draft,
    ),
    true,
  );
});

test('every transition compiles to a resolved effect with a closed, patchless contract', () => {
  const operations = operationCatalog(compile());
  for (const [action, from, to] of LIFECYCLE.transitions.filter(([local]) =>
    (DRIVEN as readonly string[]).includes(local),
  )) {
    const operation = operations.find(
      (candidate) =>
        candidate.operationId ===
        `${namespace}:operation.purchase_order_${action}`,
    );
    assert.ok(operation, `purchase_order_${action} is absent`);
    assert.equal(
      operation.tier,
      'o0',
      'a record transition runs on the generic press',
    );
    assert.equal(operation.effect.kind, 'transitionStateEffect');

    // The compiler is the single authority for what a transition means: the
    // runtime never walks the machine, so these four facts have to be resolved
    // here or they are nowhere.
    assert.equal(operation.effect.entity?.targetId, orderEntityId);
    assert.equal(operation.effect.stateFieldId, stateFieldId);
    assert.equal(operation.effect.fromStateId, PURCHASING_IDS.stateIds[from]);
    assert.equal(operation.effect.toStateId, PURCHASING_IDS.stateIds[to]);
    assert.equal(
      operation.effect.transition?.targetId,
      PURCHASING_IDS.transitionIds[action],
    );

    // No caller patch, so ADR-0034's projected-image hazard is structurally
    // absent rather than excepted.
    assert.deepEqual(operation.inputContract?.closedArgumentKeys, [
      'expectedRevision',
      'recordId',
    ]);
    assert.deepEqual(operation.inputContract?.writableFieldIds, []);
    assert.deepEqual(operation.inputContract?.fields, []);
    assert.equal(
      operation.readBackQueryId,
      `${namespace}:query.purchase_order_get`,
    );
  }
});

test('control: the compiled target is read from the machine, not from the operation id', () => {
  // Varying exactly one property -- the release operation's transition
  // reference -- must move its compiled target. A check that trusted the
  // operation id would not notice.
  const swapped = compile(
    mutated((definition) => {
      definition.operations.find(
        (operation) =>
          operation.operationId ===
          `${namespace}:operation.purchase_order_release`,
      )!.effect.transition!.targetId = PURCHASING_IDS.transitionIds.cancel;
      // The permission must move with it or the mismatch rule refuses first,
      // which would make this control observe the wrong refusal.
      definition.operations.find(
        (operation) =>
          operation.operationId ===
          `${namespace}:operation.purchase_order_release`,
      )!.permission.targetId = `${namespace}:permission.purchase_order_cancel`;
    }),
  );
  const release = operationCatalog(swapped).find(
    (operation) =>
      operation.operationId === `${namespace}:operation.purchase_order_release`,
  );
  assert.equal(release?.effect.toStateId, PURCHASING_IDS.stateIds.cancelled);
});

test('control: a transition naming no declared transition refuses by name', () => {
  // VACUITY VECTOR -- the subject absent entirely, one layer in. The operation
  // survives; the transition it names does not.
  assert.deepEqual(
    normalizationRefusal((definition) => {
      definition.stateMachines[0]!.transitions =
        definition.stateMachines[0]!.transitions.filter(
          (transition) =>
            transition.transitionId !== PURCHASING_IDS.transitionIds.release,
        );
    }).toSorted(),
    ['CANON_REFERENCE_UNRESOLVED'],
  );
});

test('a transition permission that disagrees with its operation is refused, and the matched case still compiles', () => {
  // ADR-0050 section 7's two owed controls, together, because the first alone is
  // satisfiable by refusing every transition -- which would pass a mismatch
  // control while destroying the feature.
  //
  // The rule exists because the language declares TWO permissions and execution
  // honours ONE: the gateway authorizes the operation's `permissionId`, and the
  // compiled effect carries no permission at all.
  assert.equal(compile().status, 'compiled');
  for (const action of DRIVEN) {
    const permissionId = `${namespace}:permission.purchase_order_${TRANSITION_PERMISSIONS[action]!}`;
    const transition = normalized().stateMachines[0]!.transitions.find(
      (candidate) =>
        candidate.transitionId === PURCHASING_IDS.transitionIds[action],
    );
    const operation = normalized().operations.find(
      (candidate) =>
        candidate.operationId ===
        `${namespace}:operation.purchase_order_${action}`,
    );
    assert.equal(transition?.permission.targetId, permissionId);
    assert.equal(operation?.permission.targetId, permissionId);
  }

  assert.deepEqual(
    compileRefusal((definition) => {
      definition.stateMachines[0]!.transitions.find(
        (transition) =>
          transition.transitionId === PURCHASING_IDS.transitionIds.release,
      )!.permission.targetId = `${namespace}:permission.purchase_order_read`;
    }),
    ['COMPILER_TRANSITION_PERMISSION_MISMATCH'],
  );
});

test('each transition permission is a transition permission, on the document it moves', () => {
  const distinct = [...new Set(Object.values(TRANSITION_PERMISSIONS))];
  const permissions = authored().permissions.filter((permission) =>
    distinct.some(
      (local) =>
        permission.permissionId ===
        `${namespace}:permission.purchase_order_${local}`,
    ),
  );
  assert.equal(permissions.length, distinct.length);
  assert.equal(
    distinct.length,
    LIFECYCLE.transitions.length - 1,
    'both cancels must share one permission, or this control observes nothing',
  );
  for (const permission of permissions) {
    assert.equal(permission.action, 'transition');
    assert.equal(permission.resource.targetId, orderEntityId);
  }
});

// ===========================================================================
// BAND A -- the preconditions.
//
// These read the COMPILED precondition and evaluate it with the same kernel
// entry point the gateway and `prepareMutation` call, so the assertion observes
// the decision rather than the declaration.
// ===========================================================================

test('the header guard admits a draft and refuses every committed state', () => {
  const guard = precondition(
    operationCatalog(compile()),
    `${namespace}:operation.purchase_order_update`,
  );

  assert.equal(evaluate(guard, stateImage('draft')), 'holds');
  for (const state of ['released', 'closed', 'cancelled'] as const) {
    assert.equal(
      evaluate(guard, stateImage(state)),
      'refused',
      `an order in ${state} is still editable`,
    );
  }

  // The create candidate image is the caller's patch, and the state field is
  // excluded from it -- so the guard has to hold on an image with no state key
  // or no purchase order could ever be created. This is why the guard is
  // spelled negatively.
  assert.equal(evaluate(guard, {}), 'holds');
});

test('control: with a literal-true guard every committed state holds, so the assertion discriminates', () => {
  // VACUITY VECTOR -- a proxy satisfied while the fact does not hold. Varying
  // exactly one property: the guard is replaced by literal true, which is what
  // normalization supplies when no precondition is declared.
  const ungated = compile(
    mutated((definition) => {
      for (const action of GENERIC_ACTIONS) {
        delete definition.operations.find(
          (operation) =>
            operation.operationId ===
            `${namespace}:operation.purchase_order_${action}`,
        )!.precondition;
      }
    }),
  );
  const guard = precondition(
    operationCatalog(ungated),
    `${namespace}:operation.purchase_order_update`,
  );
  for (const state of ['released', 'closed', 'cancelled'] as const) {
    assert.equal(evaluate(guard, stateImage(state)), 'holds');
  }
});

test('control: the guard is keyed to the state field, and a wrongly keyed image proves it', () => {
  // VACUITY VECTOR -- the check reading zero input. An image keyed by anything
  // else leaves the state ABSENT, and under ADR-0021 total-absence semantics
  // `not(equals)` holds on absence -- so a mis-keyed image would report `holds`
  // for a released order and the refusal above would be unobservable.
  const guard = precondition(
    operationCatalog(compile()),
    `${namespace}:operation.purchase_order_update`,
  );
  assert.equal(
    evaluate(guard, {
      [`${namespace}:field.purchase_order_state`]:
        PURCHASING_IDS.stateIds.released,
    }),
    'holds',
  );
  assert.equal(evaluate(guard, stateImage('released')), 'refused');
});

test('all four generic header operations carry one guard, and the lines declare none', () => {
  const operations = operationCatalog(compile());
  const guards = GENERIC_ACTIONS.map((action) =>
    canonicalize(
      precondition(
        operations,
        `${namespace}:operation.purchase_order_${action}`,
      ),
    ),
  );
  assert.equal(
    new Set(guards).size,
    1,
    'the four header operations do not carry the same guard',
  );

  // ADR-0034's parent-aggregate rule is what closes the lines, so a line-level
  // declaration would be a second authority for the same fact.
  for (const action of GENERIC_ACTIONS) {
    assert.equal(
      Object.hasOwn(
        authored().operations.find(
          (operation) =>
            operation.operationId ===
            `${namespace}:operation.purchase_order_line_${action}`,
        )!,
        'precondition',
      ),
      false,
      `purchase_order_line_${action} declares a redundant line-level guard`,
    );
  }
});

test('the line guard is the header UPDATE precondition, carried by a parent-scoped relation', () => {
  // `parentGuardsFromCatalog` derives its guards from every active
  // `updateRecordEffect` operation on the parent entity, and
  // `requireRelationTarget` applies them when the relation is
  // `parentScopedChild`. Both halves are asserted here; the RUNTIME application
  // of them is observed by `test:postgres`, not by this file.
  const relation = authored().relations.find(
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
  assert.equal(relation.archiveBehavior, 'restrict');
  assert.equal(relation.sourceEntity.targetId, lineEntityId);
  assert.equal(relation.targetEntity.targetId, orderEntityId);

  const parentUpdates = operationCatalog(compile()).filter(
    (operation) =>
      operation.effect.kind === 'updateRecordEffect' &&
      operation.effect.entity?.targetId === orderEntityId &&
      operation.lifecycle === 'active',
  );
  assert.equal(
    parentUpdates.length,
    1,
    'the number of parent guards a line inherits changed',
  );
  assert.equal(
    canonicalize(parentUpdates[0]!.precondition),
    canonicalize(
      precondition(
        operationCatalog(compile()),
        `${namespace}:operation.purchase_order_update`,
      ),
    ),
  );
});

test('each transition is offered only where it can move the record', () => {
  // The whole truth table, read from compiled data through the real kernel. A
  // transition offered on a record it cannot move is a button that fails on
  // press; one withheld where it applies is a document with no exit.
  const operations = operationCatalog(compile());
  const expected: Record<string, readonly string[]> = {
    cancel: ['released'],
    close: ['released'],
    draft_cancel: ['draft'],
    release: ['draft'],
    reopen: ['closed'],
  };
  for (const action of [...DRIVEN, ...DECLARED_ONLY]) {
    const guard = precondition(
      operations,
      `${namespace}:operation.purchase_order_${action}`,
    );
    for (const [state] of LIFECYCLE.states) {
      const holds = evaluate(guard, stateImage(state)) === 'holds';
      assert.equal(
        holds,
        expected[action]!.includes(state),
        `purchase_order_${action} on a ${state} order: expected ${
          expected[action]!.includes(state) ? 'holds' : 'refused'
        }`,
      );
    }
    // Every transition's precondition is a POSITIVE comparison, so an absent
    // state never offers a command. A transition always has a prior image, so
    // the create-candidate problem that forces the header's negative form does
    // not arise here.
    assert.equal(evaluate(guard, {}), 'refused');
  }
});

test('close, reopen and the committed cancel use the guarded receiving capability, never generic state transitions', () => {
  // THE FINDING THIS EXISTS FOR. An earlier version of this module emitted an
  // operation for every transition in the table, which made `released -> closed`
  // and `closed -> released` executable through the semantic operation gateway
  // TODAY -- with no receipt-derived closure rule, no open-to-receive
  // calculation, and no `PUR-2` mechanism of any kind behind them. An arbitrary
  // manual close would have become a stored business fact every later reader
  // takes as true, on a document that is then uneditable with no amend path.
  //
  // A state names a DESTINATION; an active transition operation grants a
  // PRESENT BEHAVIOUR. The measured one-way-door cost licenses the first and not
  // the second -- see the control below.
  const machine = normalized().stateMachines[0]!;
  const operations = operationCatalog(compile());

  for (const action of DECLARED_ONLY) {
    // The EDGE is declared, so `PUR-2` binds an operation without touching the
    // machine -- and without a lineage entry for a state.
    assert.equal(
      machine.transitions.some(
        (transition) =>
          transition.transitionId === PURCHASING_IDS.transitionIds[action],
      ),
      true,
      `${action} must remain a declared edge`,
    );
    // And NOTHING can invoke it. Asserted against the compiled catalog rather
    // than the authored operations, because the catalog is what the gateway
    // reads.
    assert.equal(
      operations.some(
        (operation) =>
          operation.effect.transition?.targetId ===
          PURCHASING_IDS.transitionIds[action],
      ),
      false,
      `${action} is invocable, so a caller can persist that move today`,
    );
    assert.equal(
      operations.find(
        (operation) =>
          operation.operationId ===
          `${namespace}:operation.purchase_order_${action}`,
      )?.effect.kind,
      'registeredCapabilityEffect',
      `${action} must run through receiving, which reads the order's receipts`,
    );
  }

  // The check is not passing over an empty catalog: the two driven
  // transitions ARE invocable, by the same reader.
  assert.deepEqual(
    operations
      .filter((operation) => operation.effect.kind === 'transitionStateEffect')
      .map((operation) => operation.operationId)
      .toSorted(),
    DRIVEN.map(
      (action) => `${namespace}:operation.purchase_order_${action}`,
    ).toSorted(),
  );
});

test('control: binding an operation to a declared-only edge is visible to that check', () => {
  // VACUITY VECTOR -- a proxy satisfied while the fact does not hold. Varying
  // exactly one property: `close` gains the operation this packet declines to
  // emit. The check above must see it.
  const bound = compile(
    mutated((definition) => {
      definition.operations = definition.operations.filter(
        (operation) =>
          operation.operationId !==
          `${namespace}:operation.purchase_order_close`,
      );
      definition.operations.push({
        confirmation: 'none',
        effect: {
          kind: 'transitionStateEffect',
          schemaVersion: ADOPTED_LANGUAGE_VERSION,
          transition: canonicalReference(
            'transitionReference',
            PURCHASING_IDS.transitionIds.close,
          ),
        },
        kind: 'operationDefinition',
        module: canonicalReference('moduleReference', PURCHASING_IDS.moduleId),
        operationId: `${namespace}:operation.purchase_order_close`,
        permission: canonicalReference(
          'permissionReference',
          `${namespace}:permission.purchase_order_close`,
        ),
        readBack: canonicalReference(
          'queryReference',
          `${namespace}:query.purchase_order_get`,
        ),
        schemaVersion: ADOPTED_LANGUAGE_VERSION,
        tier: 'o0',
      } as unknown as AuthoredShape['operations'][number]);
    }),
  );
  assert.equal(
    operationCatalog(bound).some(
      (operation) =>
        operation.effect.transition?.targetId ===
        PURCHASING_IDS.transitionIds.close,
    ),
    true,
  );
});

test('a declared edge costs no state, and adding one later would', () => {
  // The measurement that separates the two halves of ADR-0059, and the reason
  // deferring `close`/`reopen` to `PUR-2` is cheap while deferring the `closed`
  // STATE would not have been.
  //
  // A transition declared with no operation referencing it COMPILES...
  assert.equal(compile().status, 'compiled');

  // ...and adding a transition to an already-materialized machine compiles
  // against it with NO retype, because states define the enum options and
  // transitions do not.
  const withoutReopen = mutated((definition) => {
    definition.stateMachines[0]!.transitions =
      definition.stateMachines[0]!.transitions.filter(
        (transition) =>
          transition.transitionId !== PURCHASING_IDS.transitionIds.reopen,
      );
  });
  const prior = mustCompile(
    compilerInput(
      withoutReopen,
      expectedActiveReleaseFrom(
        mustCompile(compilerInput(emptied(withoutReopen))),
      ),
    ),
  );
  const readded = compileApplication(
    compilerInput(
      purchasingModuleDefinition(),
      expectedActiveReleaseFrom(prior),
    ),
  );
  assert.equal(
    readded.status,
    'compiled',
    'adding a transition to a shipped machine must not retype the state column',
  );
});

// ===========================================================================
// BAND B -- surfaces, form anatomy, labels, list behaviour, mount.
// One discriminating red per claim.
//
// Not individually controlled, and named rather than left implicit: the
// rendered outcome of these declarations. Whether a `commandBar` slot actually
// draws a Release button, and whether ADR-0056's precedence orders it before
// Cancel, is observed by `apps/web/test/browser/**`. This file controls the
// DECLARATION each of those reads.
// ===========================================================================

test('purchasing and receiving surfaces use registered anatomy; received projection has no edit form', () => {
  const expected = new Map<string, readonly string[]>([
    ['list', ['title', 'dataGrid', 'bulkActions']],
    [
      'detail',
      ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
    ],
    [
      'form',
      ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections'],
    ],
  ]);
  const surfaces = authored().surfaces;
  assert.equal(surfaces.length, 17);
  assert.equal(
    surfaces.some(
      (surface) =>
        surface.surfaceId ===
        `${namespace}:surface.purchase_order_received_form`,
    ),
    false,
  );
  for (const local of [
    'purchase_order',
    'purchase_order_line',
    'goods_receipt',
    'goods_receipt_line',
  ]) {
    for (const [suffix, slots] of expected) {
      const surface = surfaces.find(
        (candidate) =>
          candidate.surfaceId === `${namespace}:surface.${local}_${suffix}`,
      );
      assert.ok(surface, `${local}_${suffix} is absent`);
      assert.deepEqual(
        surface.slots.map((slot) => slot.slot),
        slots,
      );
      assert.deepEqual(surface.statusRoles, []);
      assert.equal(
        surface.dataSource.targetId,
        `${namespace}:query.${local}_${suffix === 'list' ? 'list' : 'get'}`,
      );
    }
  }

  // R3(b): `activity` and `childTables` are registered nowhere in this
  // runtime, so authoring either ships an inert form. The Inventory forms that
  // did are the incident ADR-0054 closed.
  assert.doesNotMatch(
    JSON.stringify(surfaces),
    /"slot":"(activity|childTables)"/u,
  );
});

test('the command verbs are the ones the renderer reads', () => {
  // ADR-0056 gives the web renderer a closed precedence keyed on the final
  // underscore-delimited verb: `release` first, `cancel` last, everything else
  // in compiled order. `surface-contract.ts` derives the button label from the
  // same suffix. Both read the operation ID, so the ID is presentation data.
  const operationIds = authored().operations.map(
    (operation) => operation.operationId,
  );
  for (const action of DRIVEN) {
    assert.equal(
      operationIds.includes(`${namespace}:operation.purchase_order_${action}`),
      true,
    );
  }
  for (const action of DECLARED_ONLY) {
    assert.equal(
      operationIds.includes(`${namespace}:operation.purchase_order_${action}`),
      true,
      `${action} must be a guarded receiving operation`,
    );
  }
  // BOTH cancels end in `_cancel`, deliberately: ADR-0056 ranks on the final
  // verb and `operationLabel` derives the button text from it, so each presents
  // as "Cancel" -- the word for what each does. They are never offered together
  // because their preconditions are disjoint, which the command matrix proves.
  assert.deepEqual(
    operationIds
      .filter((operationId) => /_(release|cancel)$/u.test(operationId))
      .toSorted(),
    [
      `${namespace}:operation.purchase_order_cancel`,
      `${namespace}:operation.purchase_order_draft_cancel`,
      `${namespace}:operation.purchase_order_release`,
    ],
  );
});

test('the composed application derives its modules from an ordered registry', () => {
  // Plan §7.2 assigned this refactor to "the first packet that mounts anything"
  // and §7.5's `PUR-1` row repeats it. Before it, `builder.ts` named every
  // module SIX times -- factory list, destructured tuple, truthiness guard,
  // hard-coded count in an error string, a re-listed array for module ordering,
  // and a second re-listed array for the capability comparison.
  //
  // What this control can prove is DERIVATION rather than enumeration: the
  // composed module list, its length, and its ordering all follow the registry
  // rather than any separately maintained literal.
  const composed = composedApplicationDefinition() as unknown as AuthoredShape;
  assert.deepEqual(COMPOSED_MODULE_NAMES, [
    'sales',
    'purchasing',
    'inventory',
    'party',
    'catalog',
    'location',
  ]);
  assert.equal(composed.modules.length, COMPOSED_MODULE_NAMES.length);
  assert.deepEqual(
    composed.modules.map((module) => module.label),
    ['Sales', 'Purchasing', 'Inventory', 'Party', 'Catalog', 'Location'],
  );
  // `orderKey` is derived from registry POSITION, which is what makes order the
  // only thing the registry has to declare.
  assert.deepEqual(
    composed.modules.map((module) => module.orderKey),
    COMPOSED_MODULE_NAMES.map((_, index) => (index + 1) * 10),
  );
  // Every mounted module contributes exactly one moduleDefinition, so nothing
  // downstream needs a count of its own.
  assert.equal(
    new Set(composed.modules.map((module) => module.moduleId)).size,
    COMPOSED_MODULE_NAMES.length,
  );
});

test('Purchasing and Sales lead the business navigation within budget', () => {
  const composed = composedApplicationDefinition() as unknown as AuthoredShape;
  assert.deepEqual(
    composed.modules.map((module) => module.label),
    ['Sales', 'Purchasing', 'Inventory', 'Party', 'Catalog', 'Location'],
  );

  const navigation = surfaceManifest(compile(composed)).navigation;
  assert.ok(navigation, 'the composed application emits no navigation tree');
  assert.deepEqual(
    navigation.entries.map((entry) => entry.label),
    ['Sales', 'Purchasing', 'Inventory', 'Party', 'More'],
    'supporting masters belong under the compiled overflow group',
  );
});

test('the composed application carries the Purchasing and Sales machines', () => {
  const composed = normalizeApplicationPackage(
    composedApplicationDefinition(),
  ) as unknown as NormalizedShape;
  assert.deepEqual(
    composed.stateMachines.map((machine) => machine.machineId),
    [
      'northstar.app:machine.purchase_order_lifecycle',
      'northstar.app:machine.sales_order_lifecycle',
    ],
  );
  // The composed module re-instantiates under `northstar.app`, so the derived
  // field id carries that namespace too. A hardcoded purchasing-namespace id
  // in the app would silently address nothing.
  assert.equal(
    composed.fields.some(
      (field) =>
        field.fieldId ===
        'northstar.app:derived_state_field.machine.purchase_order_lifecycle',
    ),
    true,
  );
});

// ===========================================================================
// Scope and the pinned registries.
// ===========================================================================

test('commercial order intent stays separate from received facts; no sales or hard delete operations', () => {
  const definition = authored();
  assert.deepEqual(
    definition.fields
      .filter((field) => field.entity.targetId === orderEntityId)
      .map((field) => field.fieldId),
    [
      PURCHASING_IDS.fieldIds.purchaseOrder.number,
      PURCHASING_IDS.fieldIds.purchaseOrder.supplierPartyId,
      PURCHASING_IDS.fieldIds.purchaseOrder.orderDate,
      PURCHASING_IDS.fieldIds.purchaseOrder.expectedDate,
      PURCHASING_IDS.fieldIds.purchaseOrder.currency,
      PURCHASING_IDS.fieldIds.purchaseOrder.notes,
      PURCHASING_IDS.fieldIds.purchaseOrder.receivingLocationId,
    ],
  );
  assert.deepEqual(
    definition.fields
      .filter((field) => field.entity.targetId === lineEntityId)
      .map((field) => field.fieldId),
    [
      PURCHASING_IDS.fieldIds.purchaseOrderLine.lineNumber,
      PURCHASING_IDS.fieldIds.purchaseOrderLine.itemId,
      PURCHASING_IDS.fieldIds.purchaseOrderLine.orderedQuantity,
      PURCHASING_IDS.fieldIds.purchaseOrderLine.unitPrice,
    ],
  );

  // ADR-0065: received quantity is a separate provider-written projection,
  // never an independently writable counter on the authored order line.
  assert.equal(
    definition.fields.some(
      (field) =>
        field.fieldId ===
        `${namespace}:field.purchase_order_received_received_quantity`,
    ),
    true,
  );
  assert.equal(
    definition.fields.some(
      (field) =>
        field.fieldId === `${namespace}:field.goods_receipt_line_cost_status`,
    ),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(definition),
    /sales_order|shipment|reservation/iu,
  );
  assert.equal(
    definition.operations.some((operation) =>
      /delete|purge|destroy/iu.test(
        `${operation.operationId} ${operation.effect.kind}`,
      ),
    ),
    false,
  );

  // Money, per plan section 7.3 as corrected: currency on the header and optional
  // unit price on the line are retained; no valuation, invoicing, tax or AR.
  assert.equal(
    definition.fields.find(
      (field) =>
        field.fieldId === PURCHASING_IDS.fieldIds.purchaseOrderLine.unitPrice,
    )?.presence,
    'optional',
  );
});

test('both purchasing families are entity-owned in every registry, and lower a legal entity column', () => {
  for (const familyId of ['purchase_order', 'purchase_order_line']) {
    const family = LEGAL_ENTITY_FAMILY_MAP_V1.find(
      (candidate) => candidate.familyId === familyId,
    );
    assert.ok(family, `${familyId} is an undeclared legal-entity family`);
    assert.equal(family.classification, 'entityOwned');
  }
  assert.equal(
    LEGAL_ENTITY_RELATION_SEMANTICS_V1.some(
      (rule) =>
        rule.sourceFamilyId === 'purchase_order_line' &&
        rule.targetFamilyId === 'purchase_order' &&
        rule.semantics === 'sameEntity',
    ),
    true,
  );

  // The domain map is not the enforcement point -- `conformance.ts` holds the
  // compiler's copy, and it is what decides the lowering. This assertion reads
  // the LOWERED result, so it observes the compiler's answer rather than the
  // domain declaration. `test/compiler/inventory-contract.cases.ts` deep-equals
  // the two registries against each other.
  const storage = projectionPayload<StorageTargetPayloadV1>(
    compile(),
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  for (const entityId of [orderEntityId, lineEntityId]) {
    const entity = storage.entities.find(
      (candidate) => candidate.entityId === entityId,
    );
    assert.ok(entity, `${entityId} has no lowered storage`);
    assert.equal(entity.legalEntity?.column, 'legal_entity_id');
    assert.equal(entity.legalEntity?.familyClassification, 'entityOwned');
    assert.equal(entity.legalEntity?.immutableAfterCreate, true);
    // The retired parallel construct stays retired: the state lives in an
    // ordinary column, and `derivedStateFields` is empty even on the entity
    // that owns a machine.
    assert.deepEqual(entity.derivedStateFields ?? [], []);
  }
});

test('the module rides the adopted language version and compiles deterministically', () => {
  const definition = authored();
  assert.equal(definition.languageVersion, ADOPTED_LANGUAGE_VERSION);
  assert.equal(
    definition.normalizationProfileVersion,
    ADOPTED_NORMALIZATION_PROFILE_VERSION,
  );
  assert.equal(definition.entities.length, 6);
  assert.equal(definition.queries.length, 24);
  assert.equal(definition.operations.length, 27);
  assert.equal(definition.permissions.length, 32);
  assert.equal(definition.assertions.length, 6);

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

  // Section 7.7 again, observed rather than argued: the physical shape comes from
  // this envelope at activation. It creates and never destroys, and it carries
  // the state column -- so nothing anywhere needs a purchasing migration, and an
  // empty one would be a second authority for the same fact.
  const transition = projectionPayload<StorageTransitionEnvelope>(
    first,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  assert.equal(transition.elements.length > 0, true);
  assert.equal(
    transition.elements.some((element) =>
      /delete|drop|truncate|destroy/iu.test(element.kind),
    ),
    false,
  );
  // Both tables are created here, by the projection, at activation.
  assert.deepEqual(
    transition.elements
      .filter((element) => element.kind === 'createTable')
      .map((element) => element.subjectId)
      .filter((id) =>
        [
          orderEntityId,
          lineEntityId,
          `${namespace}:entity.goods_receipt`,
          `${namespace}:entity.goods_receipt_line`,
          `${namespace}:entity.purchase_order_received`,
        ].includes(id),
      )
      .toSorted(),
    [
      orderEntityId,
      lineEntityId,
      `${namespace}:entity.goods_receipt`,
      `${namespace}:entity.goods_receipt_line`,
      `${namespace}:entity.purchase_order_received`,
    ].toSorted(),
  );
});

test('RECEIPT received projection refuses authored o0, o1 and transition write paths', () => {
  const entityId = `${namespace}:entity.purchase_order_received`;
  for (const tier of ['o0', 'o1', 'transition'] as const) {
    const definition = purchasingModuleDefinition() as Record<string, unknown>;
    const operations = definition.operations as Array<Record<string, unknown>>;
    const template = operations.find((row) =>
      String(row.operationId).endsWith(
        tier === 'o0' ? '.goods_receipt_update' : '.goods_receipt_post',
      ),
    )!;
    operations.push({
      ...structuredClone(template),
      operationId: `${namespace}:operation.received_illegal_${tier}`,
      readBack: {
        kind: 'queryReference',
        schemaVersion: ADOPTED_LANGUAGE_VERSION,
        targetId: `${namespace}:query.purchase_order_received_get`,
      },
      ...(tier === 'o0'
        ? {
            effect: {
              kind: 'updateRecordEffect',
              schemaVersion: ADOPTED_LANGUAGE_VERSION,
              entity: {
                kind: 'entityReference',
                schemaVersion: ADOPTED_LANGUAGE_VERSION,
                targetId: entityId,
              },
            },
          }
        : {}),
    });
    if (tier === 'transition') {
      const machines = definition.stateMachines as Array<
        Record<string, unknown>
      >;
      const machine = JSON.parse(
        JSON.stringify(machines[0]).replaceAll(
          'purchase_order',
          'received_illegal',
        ),
      ) as Record<string, unknown>;
      machine.entity = {
        kind: 'entityReference',
        schemaVersion: ADOPTED_LANGUAGE_VERSION,
        targetId: entityId,
      };
      machines.push(machine);
      const operation = operations.at(-1)!;
      operation.tier = 'o0';
      operation.effect = {
        kind: 'transitionStateEffect',
        schemaVersion: ADOPTED_LANGUAGE_VERSION,
        transition: {
          kind: 'transitionReference',
          schemaVersion: ADOPTED_LANGUAGE_VERSION,
          targetId: `${namespace}:transition.received_illegal_release`,
        },
      };
      operation.permission = {
        kind: 'permissionReference',
        schemaVersion: ADOPTED_LANGUAGE_VERSION,
        targetId: `${namespace}:permission.purchase_order_release`,
      };
      for (const transition of machine.transitions as Array<
        Record<string, unknown>
      >)
        transition.permission = {
          kind: 'permissionReference',
          schemaVersion: ADOPTED_LANGUAGE_VERSION,
          targetId: `${namespace}:permission.purchase_order_release`,
        };
    }
    const result = compileApplication(compilerInput(definition));
    assert.equal(
      result.status,
      'failed',
      'provider-written quantity refuses every authored write tier',
    );
    if (result.status === 'failed')
      assert.ok(
        result.diagnostics.some(
          (row) =>
            row.code === 'COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED' &&
            row.subjectId === entityId,
        ),
        'provider-written quantity refuses every authored write tier',
      );
  }
});

test('release verification plans no scenario it cannot arrange for the state field', () => {
  // ADR-0050 section 6 item 2. Both the `enumReject` and `searchableExclusion`
  // scenarios probe a field THROUGH the create operation, and the state field
  // is structurally excluded from that contract -- so minting either would ask
  // the provider to populate a field it is forbidden to populate, which is
  // `VERIFICATION_EXCLUDED_FIELD_VALUE_MISSING`. Not emitting differs from
  // skipping: nothing is admitted unexecuted.
  const plan = projectionPayload<{
    scenarios: readonly { kind: string; subjectId: string }[];
  }>(compile(), PROJECTION_FAMILY_IDS.verificationPlan);
  assert.equal(
    plan.scenarios.some((scenario) => scenario.subjectId === stateFieldId),
    false,
  );
  // The plan is not empty, so the assertion above is not passing over nothing.
  assert.equal(
    plan.scenarios.some((scenario) => scenario.kind === 'searchableExclusion'),
    true,
  );
});

// ===========================================================================
// Harness.
// ===========================================================================

interface AuthoredShape {
  fields: Array<{
    entity: { targetId: string };
    fieldId: string;
    presence: string;
  }>;
  languageVersion: string;
  modules: Array<{ label: string; moduleId: string; orderKey: number }>;
  normalizationProfileVersion: string;
  operations: Array<{
    effect: {
      entity?: { targetId: string };
      kind: string;
      transition?: { targetId: string };
    };
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
    queryId: string;
    selections: Array<{ field: { targetId: string } }>;
  }>;
  relations: Array<{
    archiveBehavior: string;
    ownership: string;
    relationId: string;
    required: boolean;
    sourceEntity: { targetId: string };
    targetEntity: { targetId: string };
  }>;
  stateMachines: Array<{
    machineId: string;
    transitions: Array<{
      [key: string]: unknown;
      fromState: { targetId: string };
      permission: { targetId: string };
      toState: { targetId: string };
      transitionId: string;
    }>;
  }>;
  surfaces: Array<{
    dataSource: { targetId: string };
    slots: Array<{ slot: string }>;
    statusRoles: string[];
    surfaceId: string;
  }>;
  assertions: unknown[];
  entities: unknown[];
}

interface NormalizedField {
  defaultSemantics: string;
  defaultValue?: unknown;
  entity: { targetId: string };
  fieldId: string;
  fieldType: {
    kind: string;
    options?: Array<{ label: string; optionId: string }>;
  };
  label: string;
  orderKey: number;
  presence: string;
  searchable: boolean;
}

interface NormalizedShape {
  fields: NormalizedField[];
  operations: Array<{ operationId: string; permission: { targetId: string } }>;
  stateMachines: Array<{
    entity: { targetId: string };
    initialState: { targetId: string };
    machineId: string;
    states: Array<{ label: string; stateId: string; terminal: boolean }>;
    transitions: Array<{
      [key: string]: unknown;
      fromState: { targetId: string };
      permission: { targetId: string };
      toState: { targetId: string };
      transitionId: string;
    }>;
  }>;
}

interface CompiledOperation {
  effect: {
    entity?: { targetId: string };
    fromStateId?: string;
    kind: string;
    stateFieldId?: string;
    toStateId?: string;
    transition?: { targetId: string };
  };
  inputContract?: {
    closedArgumentKeys: string[];
    fields: unknown[];
    writableFieldIds: string[];
  };
  lifecycle: string;
  operationId: string;
  precondition: Record<string, unknown>;
  readBackQueryId: string;
  tier: string;
}

interface CompiledQuery {
  queryId: string;
  selections: Array<{ fieldId: string }>;
  sourceEntityId: string;
}

function authored(): AuthoredShape {
  return purchasingModuleDefinition() as unknown as AuthoredShape;
}

function normalized(): NormalizedShape {
  return normalizeApplicationPackage(
    purchasingModuleDefinition(),
  ) as unknown as NormalizedShape;
}

/** A deep copy with exactly one property varied. The subject is never mutated. */
function mutated(vary: (definition: AuthoredShape) => void): AuthoredShape {
  const copy = structuredClone(
    purchasingModuleDefinition(),
  ) as unknown as AuthoredShape;
  vary(copy);
  return copy;
}

/**
 * Compiles the module AGAINST AN EMPTY PRIOR RELEASE, which is what a first
 * activation actually is. Without a prior release the compiler emits no
 * `storage-transition` family at all, and that family is the one that matters
 * most here: plan section 7.7 rules that module tables are created by
 * `module-storage-materializer.ts` FROM the compiled storage-transition
 * projection at release activation, and that `db/migrations/*.sql` stays
 * platform and kernel only. There is no purchasing migration because the
 * projection below is the authority for physical shape.
 */
test('PURCHASING-PARITY: the product application prices a purchase order like a sales order', () => {
  type Loose = Record<string, unknown>;
  const app = composedApplicationDefinition() as unknown as {
    fields: Array<Loose & { fieldId: string; fieldType: Loose }>;
    queries: Array<Loose & { queryId: string; readModel?: Loose }>;
    surfaces: Array<Loose & { surfaceId: string }>;
  };
  const local = (value: string) => value.split('.').pop()!;
  const commercial = [
    'purchase_order_payment_terms',
    'purchase_order_tax_code_id',
    'purchase_order_freight_amount',
    'purchase_order_freight_tax_code_id',
    'purchase_order_other_fee_amount',
    'purchase_order_other_fee_tax_code_id',
    'purchase_order_freight_tax_rate_percent',
    'purchase_order_other_fee_tax_rate_percent',
    'purchase_order_line_discount_percent',
    'purchase_order_line_tax_code_id',
    'purchase_order_line_tax_rate_percent',
  ];
  const declared = new Set(app.fields.map((value) => local(value.fieldId)));
  assert.deepEqual(
    commercial.filter((name) => !declared.has(name)),
    [],
    'every commercial field is declared in the product application',
  );
  // A purchasing-only compile carries none of them: they read Catalog tax
  // codes, which it does not compose.
  const standalone = new Set(
    (
      purchasingModuleDefinition() as unknown as {
        fields: Array<{ fieldId: string }>;
      }
    ).fields.map((value) => local(value.fieldId)),
  );
  assert.deepEqual(
    commercial.filter((name) => standalone.has(name)),
    [],
  );
  // A goods receipt is numbered by the server, like the order: RCV-000001.
  assert.deepEqual(
    app.fields.find((value) => local(value.fieldId) === 'goods_receipt_number')!
      .numbering,
    {
      kind: 'documentSequence',
      sequenceId: 'northstar.app:document_sequence.goods_receipt',
      prefix: 'RCV',
      minimumDigits: 6,
      start: 1,
    },
  );
  // Terms are labelled as a Party's, so the supplier's default fills them.
  const terms = app.fields.find(
    (value) => local(value.fieldId) === 'purchase_order_payment_terms',
  )!.fieldType as { options: Array<{ label: string }> };
  assert.deepEqual(
    terms.options.map((option) => option.label),
    ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'],
  );
  // The editor: supplier defaults, two weeks out, a line tax code from the
  // order, rates frozen from the codes.
  const editor = app.surfaces.find(
    (value) => local(value.surfaceId) === 'purchase_order_form',
  )!.documentEditor as {
    headerFields: Array<Loose & { fieldId: string }>;
    lineFields: Array<Loose & { fieldId: string }>;
  };
  const header = (name: string) =>
    editor.headerFields.find(
      (value) => local(value.fieldId) === `purchase_order_${name}`,
    )!;
  const line = (name: string) =>
    editor.lineFields.find(
      (value) => local(value.fieldId) === `purchase_order_line_${name}`,
    )!;
  assert.equal(header('expected_date').defaultDaysFromToday, 14);
  for (const [name, source] of [
    ['currency', 'party_default_currency'],
    ['payment_terms', 'party_payment_terms'],
    ['tax_code_id', 'party_default_tax_code_id'],
  ] as const)
    assert.deepEqual(
      header(name).defaultFrom,
      {
        referenceFieldId:
          'northstar.app:field.purchase_order_supplier_party_id',
        sourceFieldId: `northstar.app:field.${source}`,
      },
      name,
    );
  assert.equal(
    (line('tax_code_id').defaultFrom as Loose).headerFieldId,
    'northstar.app:field.purchase_order_tax_code_id',
  );
  assert.deepEqual(
    ['freight_tax_rate_percent', 'other_fee_tax_rate_percent'].map(
      (name) => (header(name).presentation as Loose).kind,
    ),
    ['derived', 'derived'],
  );
  assert.equal(
    (line('tax_rate_percent').presentation as Loose).kind,
    'derived',
  );
  // Priced lines and totals are read through the commercial read model.
  const bindings = Object.fromEntries(
    app.queries
      .filter((value) => value.readModel)
      .map((value) => [
        local(value.queryId),
        (value.readModel as { binding: string }).binding,
      ]),
  );
  assert.equal(
    bindings.commercial_purchase_order_lines,
    'northstar.sales:read_model.commercial_purchase_line',
  );
  assert.equal(
    bindings.commercial_purchase_order_get,
    'northstar.sales:read_model.commercial_purchase_order',
  );
  const detail = app.surfaces.find(
    (value) => local(value.surfaceId) === 'purchase_order_detail',
  )! as unknown as {
    dataSource: { targetId: string };
    composition: {
      fields: Array<{ columnId: string; format?: string }>;
      presentation: { print: { totals: string[] } };
    };
  };
  assert.equal(
    local(detail.dataSource.targetId),
    'commercial_purchase_order_get',
  );
  assert.deepEqual(detail.composition.presentation.print.totals.map(local), [
    'purchasing_subtotal',
    'purchasing_freight',
    'purchasing_other_fee',
    'purchasing_tax',
    'purchasing_total',
  ]);
  assert.deepEqual(
    detail.composition.fields
      .filter((value) => value.format === 'money')
      .map((value) => local(value.columnId)),
    [
      'purchasing_freight',
      'purchasing_other_fee',
      'purchasing_subtotal',
      'purchasing_charges',
      'purchasing_tax',
      'purchasing_total',
    ],
  );
});

test('PURCHASING-PARITY: an order line shows what is still to arrive, and its open remainder closes with a reason', () => {
  type Loose = Record<string, unknown>;
  const app = composedApplicationDefinition() as unknown as {
    queries: Array<Loose & { queryId: string; readModel?: Loose }>;
    surfaces: Array<Loose & { surfaceId: string }>;
  };
  const local = (value: string) => value.split('.').pop()!;
  // The purchase line read model states received and open-to-receive from the
  // receiving projection, read through its own get under current policy.
  const lines = app.queries.find(
    (value) => local(value.queryId) === 'commercial_purchase_order_lines',
  )!.readModel as {
    queries: Record<string, { targetId: string }>;
    resultFields: Record<string, string>;
  };
  assert.deepEqual(Object.keys(lines.resultFields).toSorted(), [
    'line_amount',
    'line_tax',
    'open_to_receive',
    'received',
  ]);
  assert.equal(
    lines.queries.received?.targetId,
    'northstar.app:query.purchase_order_received_get',
  );
  const composition = (
    app.surfaces.find(
      (value) => local(value.surfaceId) === 'purchase_order_detail',
    )! as unknown as {
      composition: {
        children: Array<{
          datasetId: string;
          query: { targetId: string };
          columns: Array<{ columnId: string; field: string }>;
        }>;
        actions: Array<
          Loose & {
            actionId: string;
            conditions: Loose[];
            inputs: Array<Loose & { inputId: string }>;
            steps: Array<{
              operation: { targetId: string };
              bindings: Array<{ path: string[]; value: Loose }>;
            }>;
          }
        >;
      };
    }
  ).composition;
  const orderLines = composition.children.find(
    (value) => local(value.datasetId) === 'purchasing_lines',
  )!;
  assert.equal(
    local(orderLines.query.targetId),
    'commercial_purchase_order_lines',
  );
  assert.deepEqual(
    orderLines.columns
      .filter((value) => value.field.includes(':metric.'))
      .map((value) => [local(value.columnId), local(value.field)]),
    [
      ['purchasing_received', 'received'],
      ['purchasing_open', 'open_to_receive'],
    ],
  );
  // Offered on a released order's line with something still open; the new
  // ordered quantity is the line's received quantity, staged with the reason
  // and applied by the receiving amend, which refuses less than received.
  const close = composition.actions.find(
    (value) => local(value.actionId) === 'close_remainder',
  )!;
  assert.equal(local(String(close.datasetId)), 'purchasing_lines');
  assert.deepEqual(close.conditions, [
    {
      value: {
        source: 'record',
        field:
          'northstar.app:derived_state_field.machine.purchase_order_lifecycle',
      },
      operator: 'equals',
      compare: 'northstar.app:state.purchase_order_released',
    },
    {
      value: {
        source: 'selected',
        field: 'northstar.app:metric.open_to_receive',
      },
      operator: 'positive',
      compare: null,
    },
  ]);
  assert.deepEqual(
    close.inputs.map((value) => [
      local(value.inputId),
      value.required,
      (value.presentation as Loose | undefined)?.kind,
    ]),
    [['close_remainder_reason', true, 'multiline']],
  );
  assert.deepEqual(
    close.steps.map((value) => local(value.operation.targetId)),
    ['purchase_order_amendment_create', 'purchase_order_line_amend'],
  );
  const staged = Object.fromEntries(
    close.steps[0]!.bindings.map((value) => [
      local(value.path.at(-1)!),
      value.value,
    ]),
  );
  assert.deepEqual(staged.purchase_order_amendment_quantity, {
    source: 'selected',
    field: 'northstar.app:metric.received',
  });
  assert.deepEqual(staged.purchase_order_amendment_line_revision, {
    source: 'selected',
    field: 'revision',
  });
  // A close request: the amend closes to what is received when it runs.
  assert.deepEqual(staged.purchase_order_amendment_close_remainder, {
    source: 'literal',
    value: true,
  });
  assert.deepEqual(staged.purchase_order_amendment_reason, {
    source: 'input',
    inputId: 'northstar.app:input.close_remainder_reason',
  });
  assert.deepEqual(staged.purchase_order_amendment_order_line, {
    source: 'selected',
    field: 'recordId',
  });
  assert.deepEqual(
    close.steps[1]!.bindings.map((value) => [value.path, value.value]),
    [
      [['recordId'], { source: 'selected', field: 'recordId' }],
      [['expectedRevision'], { source: 'selected', field: 'revision' }],
    ],
  );
});

test('PURCHASING-PARITY: a receipt keeps its paperwork, and receiving starts where the order is received', () => {
  type Loose = Record<string, unknown>;
  type Field = Loose & {
    fieldId: string;
    entity: { targetId: string };
    fieldType: Loose;
    orderKey: number;
  };
  type Column = Loose & {
    columnId: string;
    field: string;
    reference?: {
      query: { targetId: string };
      labelField: { targetId: string };
    };
  };
  const local = (value: string) => value.split('.').pop()!;
  // Base fields, so the purchasing-only compile declares them too.
  const standalone = (
    purchasingModuleDefinition() as unknown as { fields: Field[] }
  ).fields;
  for (const [name, entity, label, maximumLength] of [
    [
      'goods_receipt_packing_slip',
      'goods_receipt',
      'Packing slip / delivery note',
      80,
    ],
    ['goods_receipt_notes', 'goods_receipt', 'Notes', 1000],
    [
      'purchase_order_receiving_location_id',
      'purchase_order',
      'Receive into',
      80,
    ],
  ] as const) {
    const declared = standalone.find((value) => local(value.fieldId) === name);
    assert.ok(declared, `${name} is declared`);
    assert.deepEqual(
      [
        local(declared.entity.targetId),
        declared.label,
        declared.fieldType.kind,
        declared.fieldType.maximumLength,
      ],
      [entity, label, 'textFieldType', maximumLength],
      name,
    );
    // Optional and never searched: nothing has to be typed to save.
    assert.deepEqual(
      [declared.presence, declared.defaultSemantics, declared.searchable],
      ['optional', 'nullable', false],
      name,
    );
  }
  const app = composedApplicationDefinition() as unknown as {
    fields: Field[];
    surfaces: Array<Loose & { surfaceId: string }>;
  };
  // Beside the commercial terms, each order field keeps its own orderKey.
  const orderKeys = app.fields
    .filter((value) => local(value.entity.targetId) === 'purchase_order')
    .map((value) => value.orderKey);
  assert.equal(new Set(orderKeys).size, orderKeys.length);
  // The draft editor picks the location from the Location list.
  const editor = app.surfaces.find(
    (value) => local(value.surfaceId) === 'purchase_order_form',
  )!.documentEditor as { headerFields: Array<Loose & { fieldId: string }> };
  const receiveInto = editor.headerFields.find(
    (value) => local(value.fieldId) === 'purchase_order_receiving_location_id',
  );
  assert.ok(receiveInto, 'the draft editor offers Receive into');
  assert.equal(receiveInto.label, 'Receive into');
  assert.deepEqual(receiveInto.reference, {
    queryId: 'northstar.app:query.location_list',
    getQueryId: 'northstar.app:query.location_get',
    labelFieldIds: ['northstar.app:field.location_name'],
    detailFieldIds: ['northstar.app:field.location_code'],
  });
  const composition = app.surfaces.find(
    (value) => local(value.surfaceId) === 'purchase_order_detail',
  )!.composition as {
    presentation: { header: { facts: string[] } };
    fields: Column[];
    children: Array<{ datasetId: string; columns: Column[] }>;
    actions: Array<{
      actionId: string;
      inputs: Array<Loose & { inputId: string }>;
      steps: Array<{
        operation: { targetId: string };
        bindings: Array<{ path: string[]; value: Loose }>;
      }>;
    }>;
  };
  // The order's page reads the location's name in its details, not the header.
  const shown = composition.fields.find(
    (value) => local(value.columnId) === 'purchasing_receive_into',
  );
  assert.ok(shown, 'the order page shows Receive into');
  assert.deepEqual(
    [
      shown.label,
      local(shown.field),
      shown.reference?.query.targetId,
      shown.reference?.labelField.targetId,
    ],
    [
      'Receive into',
      'purchase_order_receiving_location_id',
      'northstar.app:query.location_get',
      'northstar.app:field.location_name',
    ],
  );
  assert.equal(
    composition.presentation.header.facts.includes(shown.columnId),
    false,
  );
  // Each connected receipt shows its packing slip.
  assert.deepEqual(
    composition.children
      .find((value) => local(value.datasetId) === 'purchasing_receipts')!
      .columns.filter(
        (value) => local(value.field) === 'goods_receipt_packing_slip',
      )
      .map((value) => [local(value.columnId), value.label]),
    [['purchasing_packing_slip', 'Packing slip']],
  );
  for (const suffix of ['known', 'absent']) {
    const action = composition.actions.find(
      (value) => local(value.actionId) === `receive_${suffix}`,
    )!;
    const input = (name: string) =>
      action.inputs.find((value) => local(value.inputId) === `receive_${name}`);
    // Both paperwork inputs may stay empty; notes take several lines.
    assert.deepEqual(
      ['packing_slip', 'notes'].map((name) => {
        const value = input(name);
        return [
          value?.label,
          value?.type,
          value?.required,
          (value?.presentation as Loose | undefined)?.kind,
        ];
      }),
      [
        ['Packing slip / delivery note', 'text', false, undefined],
        ['Notes', 'text', false, 'multiline'],
      ],
      suffix,
    );
    // They are kept on the receipt the first step creates.
    const create = action.steps[0]!;
    assert.equal(local(create.operation.targetId), 'goods_receipt_create');
    const bound = Object.fromEntries(
      create.bindings.map((value) => [local(value.path.at(-1)!), value.value]),
    );
    assert.deepEqual(
      [bound.goods_receipt_packing_slip, bound.goods_receipt_notes],
      [
        {
          source: 'input',
          inputId: 'northstar.app:input.receive_packing_slip',
        },
        { source: 'input', inputId: 'northstar.app:input.receive_notes' },
      ],
      suffix,
    );
    // The receiving location starts from the order's own.
    assert.deepEqual(
      input('location')?.defaultFrom,
      {
        source: 'record',
        field: 'northstar.app:field.purchase_order_receiving_location_id',
      },
      suffix,
    );
  }
  // The whole declaration is admitted, the default included.
  assert.doesNotThrow(() => normalizeApplicationPackage(structuredClone(app)));
});

function compile(
  definition: unknown = purchasingModuleDefinition(),
): CompileSuccess {
  const empty = mustCompile(compilerInput(emptied(definition)));
  return mustCompile(
    compilerInput(definition, expectedActiveReleaseFrom(empty)),
  );
}

function mustCompile(input: CompilerInput): CompileSuccess {
  const result = compileApplication(input);
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

/** The same package with every declared family emptied -- a release with no module content. */
function emptied(definition: unknown): Record<string, unknown> {
  const copy = structuredClone(definition) as Record<string, unknown>;
  for (const family of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'relations',
    'stateMachines',
    'storageMappings',
    'surfaces',
  ]) {
    copy[family] = [];
  }
  return copy;
}

function compilerInput(
  definition: unknown,
  expectedActiveRelease: CompilerInput['expectedActiveRelease'] = null,
): CompilerInput {
  // Receiving depends on the inventory ledger. Compile the unchanged module
  // with that real dependency, in memory only; never produce serving artifacts.
  const composed = structuredClone(definition) as Record<string, unknown>;
  if (
    (composed.package as { namespace: string }).namespace === namespace &&
    (composed.entities as unknown[]).length > 0
  ) {
    const dependency = inventoryModuleDefinition(namespace) as Record<
      string,
      unknown
    >;
    for (const family of [
      'assertions',
      'entities',
      'fields',
      'operations',
      'permissions',
      'queries',
      'relations',
      'stateMachines',
      'storageMappings',
      'surfaces',
      'modules',
    ]) {
      composed[family] = [
        ...((composed[family] as unknown[]) ?? []),
        ...((dependency[family] as unknown[]) ?? []),
      ];
    }
    composed.capabilityRequirements = [
      ...(composed.capabilityRequirements as unknown[]),
      ...(dependency.capabilityRequirements as unknown[]).slice(1),
    ];
    composed.modules = (composed.modules as Record<string, unknown>[]).map(
      (module, index) => ({
        ...module,
        ownerPackageId: (composed.package as { packageId: string }).packageId,
        orderKey: (index + 1) * 10,
      }),
    );
  }
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalizeApplicationPackage(composed)),
    ),
    profile: { ...MODULE_COMPILER_PROFILE },
  };
}

/**
 * The distinct diagnostic codes normalization raises for one varied property.
 * Throwing when the mutation is ACCEPTED is deliberate: a control that silently
 * reports "no refusal" as an empty list would pass a `deepEqual` against `[]`
 * that a reader might write by accident.
 */
function normalizationRefusal(
  vary: (definition: AuthoredShape) => void,
): string[] {
  try {
    normalizeApplicationPackage(mutated(vary));
  } catch (error) {
    if (!(error instanceof CanonicalModelError)) throw error;
    return [...new Set(error.diagnostics.map((diagnostic) => diagnostic.code))];
  }
  throw new Error(
    'the varied definition normalized; the control observed nothing',
  );
}

function compileRefusal(vary: (definition: AuthoredShape) => void): string[] {
  const varied = mutated(vary);
  const empty = mustCompile(compilerInput(emptied(varied)));
  const result = compileApplication(
    compilerInput(varied, expectedActiveReleaseFrom(empty)),
  );
  if (result.status === 'compiled') {
    throw new Error(
      'the varied definition compiled; the control observed nothing',
    );
  }
  return [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))];
}

/** Every enum field on `purchase_order`, which is what "one state field" counts. */
/**
 * The refusal a vanished state field produces. `CANON_REFERENCE_UNRESOLVED` is
 * the fact under control -- the module's constant no longer names a field --
 * and it is REQUIRED. `CANON_QUERY_FIELD_LOCALITY` rides along only while the
 * read path selects the field, so it is admitted but not required: requiring it
 * would couple these controls to the read path and make them red for a reason
 * that already has its own test.
 *
 * Any THIRD code still reds, so this stays a closed observation rather than a
 * loosened one.
 */
function assertRefusalPair(codes: readonly string[]): void {
  assert.equal(
    codes.includes('CANON_REFERENCE_UNRESOLVED'),
    true,
    codes.join(),
  );
  assert.deepEqual(
    codes.filter(
      (code) =>
        code !== 'CANON_REFERENCE_UNRESOLVED' &&
        code !== 'CANON_QUERY_FIELD_LOCALITY',
    ),
    [],
  );
}

function orderEnumFields(shape: NormalizedShape): NormalizedField[] {
  return shape.fields.filter(
    (field) =>
      field.entity.targetId === orderEntityId &&
      field.fieldType.kind === 'enumFieldType',
  );
}

/**
 * Removes every reference to the derived state field, so a control that varies
 * the MACHINE observes the machine's own consequence rather than the unresolved
 * references that follow from it.
 */
function stripStateFieldReferences(definition: AuthoredShape): void {
  definition.operations = definition.operations.filter(
    (operation) => operation.effect.kind !== 'transitionStateEffect',
  );
  for (const operation of definition.operations) {
    delete operation.precondition;
  }
  for (const query of definition.queries) {
    query.selections = query.selections.filter(
      (selection) => selection.field.targetId !== stateFieldId,
    );
  }
  // The transition PERMISSIONS stay: the machine's own transitions still
  // reference them, and removing them would make the control observe four
  // unresolved permission references instead of the one fact it varies.
}

function authoredField(
  entityId: string,
  fieldId: string,
  label: string,
  orderKey: number,
  fieldType: Record<string, unknown>,
): AuthoredShape['fields'][number] {
  return {
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'none',
    entity: canonicalReference('entityReference', entityId),
    fieldId,
    fieldType,
    kind: 'fieldDefinition',
    label,
    orderKey,
    presence: 'required',
    reportable: true,
    schemaVersion: ADOPTED_LANGUAGE_VERSION,
    searchable: false,
  } as unknown as AuthoredShape['fields'][number];
}

function canonicalReference(kind: string, targetId: string) {
  return { kind, schemaVersion: ADOPTED_LANGUAGE_VERSION, targetId };
}

function operationCatalog(compiled: CompileSuccess): CompiledOperation[] {
  return projectionPayload<{ operations: CompiledOperation[] }>(
    compiled,
    PROJECTION_FAMILY_IDS.operationCatalog,
  ).operations;
}

function queryCatalog(compiled: CompileSuccess): CompiledQuery[] {
  return projectionPayload<{ queries: CompiledQuery[] }>(
    compiled,
    PROJECTION_FAMILY_IDS.queryCatalog,
  ).queries;
}

function surfaceManifest(compiled: CompileSuccess): {
  navigation?: { entries: Array<{ label: string }> };
} {
  return projectionPayload(compiled, PROJECTION_FAMILY_IDS.surfaceManifest);
}

function precondition(
  operations: readonly CompiledOperation[],
  operationId: string,
): Record<string, unknown> {
  const operation = operations.find(
    (candidate) => candidate.operationId === operationId,
  );
  assert.ok(operation, `${operationId} is absent from the compiled catalog`);
  return operation.precondition;
}

function writableFieldIds(
  operations: readonly CompiledOperation[],
  operationId: string,
): string[] {
  const operation = operations.find(
    (candidate) => candidate.operationId === operationId,
  );
  assert.ok(operation, `${operationId} is absent from the compiled catalog`);
  return [...(operation.inputContract?.writableFieldIds ?? [])];
}

/** One record image carrying only the state, which is all any guard here reads. */
function stateImage(state: string): Record<string, string> {
  const stateId = (PURCHASING_IDS.stateIds as Record<string, string>)[state];
  assert.ok(stateId, `${state} is not a declared state`);
  return { [stateFieldId]: stateId };
}

function evaluate(
  guard: Record<string, unknown>,
  image: Record<string, unknown>,
): string {
  return evaluateRegisteredOperationPrecondition(
    guard as Parameters<typeof evaluateRegisteredOperationPrecondition>[0],
    image as Parameters<typeof evaluateRegisteredOperationPrecondition>[1],
  ).outcome;
}

/**
 * Reads one projection payload out of a compiled bundle, and REFUSES rather
 * than returning `undefined` when the family, its root, or its first chunk is
 * missing -- see the unrecognised-shape control.
 */
function projectionPayload<T>(compiled: CompileSuccess, familyId: string): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (!reference) throw new Error(`no projection family ${familyId}`);
  const root = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  if (!root) throw new Error(`no artifact root for ${familyId}`);
  const manifest = JSON.parse(
    new TextDecoder().decode(root.canonicalBytes),
  ) as {
    chunks: Array<{ contentHash: string }>;
  };
  const first = manifest.chunks[0]?.contentHash;
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === first,
  );
  if (!chunk) throw new Error(`no first chunk for ${familyId}`);
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as T;
}

// ===========================================================================
// PAYABLES: vendor bills, vendor payments and vendor credits (owner rulings
// PY-A to PY-I), declared behind the product application's `payables` option.
// ===========================================================================

type PayablesShape = {
  entities: Array<{ entityId: string }>;
  fields: Array<{
    fieldId: string;
    presence: string;
    searchable: boolean;
    numbering?: { prefix: string; sequenceId: string; minimumDigits: number };
  }>;
  operations: Array<{
    operationId: string;
    effect: { kind: string; capability?: { targetId: string } };
    permission: { targetId: string };
    precondition?: unknown;
    readBack: { targetId: string };
    tier: string;
  }>;
  permissions: Array<{ permissionId: string; action: string }>;
  queries: Array<{
    queryId: string;
    queryType: string;
    legalEntityScope?: { cardinality: string };
    exportMaximumResultCount?: number;
    resolveMatchKeys?: Array<{ field: { targetId: string } }>;
  }>;
  relations: Array<{
    relationId: string;
    ownership: string;
    sourceEntity: { targetId: string };
    targetEntity: { targetId: string };
  }>;
  surfaces: Array<{ surfaceId: string }>;
  capabilityRequirements: Array<{
    capabilityId: string;
    declaredEffects: string[];
  }>;
};

function payables(): PayablesShape {
  return purchasingModuleDefinition(namespace, {
    commercialTerms: true,
    payables: true,
  }) as unknown as PayablesShape;
}

const PAYABLES_LOCALS = [
  'vendor_bill',
  'vendor_bill_line',
  'vendor_payment',
  'vendor_credit',
] as const;

test('PAYABLES: a compile without the payables option declares none of it, and payables require commercial terms', () => {
  for (const definition of [
    purchasingModuleDefinition(),
    purchasingModuleDefinition(namespace, { commercialTerms: true }),
  ])
    assert.doesNotMatch(JSON.stringify(definition), /vendor_|payables/u);
  assert.throws(
    () => purchasingModuleDefinition(namespace, { payables: true }),
    /payables require the commercial terms/u,
  );
  const declared = payables();
  assert.deepEqual(
    declared.entities
      .map((entity) => entity.entityId)
      .filter((id) => id.includes(':entity.vendor_')),
    PAYABLES_LOCALS.map((local) => `${namespace}:entity.${local}`),
  );
  assert.deepEqual(
    declared.capabilityRequirements
      .filter(
        (requirement) => requirement.capabilityId === PAYABLES_CAPABILITY_ID,
      )
      .map((requirement) => requirement.declaredEffects),
    [['recordMutation']],
  );
  // The product application composes it.
  const composed = composedApplicationDefinition() as unknown as PayablesShape;
  assert.ok(
    composed.entities.some(
      (entity) => entity.entityId === 'northstar.app:entity.vendor_bill',
    ),
  );
});

test('PAYABLES: documents change only as drafts, post once through the payables capability, and are numbered BILL, VPAY and VCM', () => {
  const declared = payables();
  for (const [local, prefix] of [
    ['vendor_bill', 'BILL'],
    ['vendor_payment', 'VPAY'],
    ['vendor_credit', 'VCM'],
  ] as const) {
    const number = declared.fields.find(
      (field) => field.fieldId === `${namespace}:field.${local}_number`,
    );
    assert.equal(number?.numbering?.prefix, prefix);
    assert.equal(number?.numbering?.minimumDigits, 6);
    assert.equal(
      number?.numbering?.sequenceId,
      `${namespace}:document_sequence.${local}`,
    );
    const state = `${namespace}:field.${local}_state`;
    for (const action of GENERIC_ACTIONS) {
      const operation = declared.operations.find(
        (candidate) =>
          candidate.operationId === `${namespace}:operation.${local}_${action}`,
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
      assert.equal(
        evaluate(`${namespace}:option.${local}_state_draft`),
        'holds',
      );
      assert.equal(
        evaluate(
          `${namespace}:option.${local}_state_${local === 'vendor_bill' ? 'open' : 'posted'}`,
        ),
        'refused',
        `${local}_${action} must refuse a posted document`,
      );
    }
  }
  // A bill's lines declare no guard of their own: the parent-scoped relation
  // carries the bill's draft guard down to them.
  assert.ok(
    declared.operations
      .filter((operation) =>
        operation.operationId.startsWith(
          `${namespace}:operation.vendor_bill_line_`,
        ),
      )
      .every((operation) => operation.precondition === undefined),
  );
  assert.deepEqual(
    declared.relations
      .filter((relation) => relation.relationId.includes(':relation.vendor_'))
      .map((relation) => [
        relation.relationId.split(':relation.')[1],
        relation.sourceEntity.targetId.split(':entity.')[1],
        relation.targetEntity.targetId.split(':entity.')[1],
        relation.ownership,
      ]),
    [
      ['vendor_bill_order', 'vendor_bill', 'purchase_order', 'reference'],
      [
        'vendor_bill_line_bill',
        'vendor_bill_line',
        'vendor_bill',
        'parentScopedChild',
      ],
      [
        'vendor_bill_line_order_line',
        'vendor_bill_line',
        'purchase_order_line',
        'reference',
      ],
      ['vendor_payment_bill', 'vendor_payment', 'vendor_bill', 'reference'],
      ['vendor_credit_bill', 'vendor_credit', 'vendor_bill', 'reference'],
    ],
  );
  // Each command runs on the payables capability, confirmed by a person, and
  // is offered only in the state it applies to.
  const commands = declared.operations.filter(
    (operation) =>
      operation.effect.capability?.targetId === PAYABLES_CAPABILITY_ID,
  );
  assert.deepEqual(
    commands.map((operation) => operation.operationId),
    [
      `${namespace}:operation.vendor_bill_post`,
      `${namespace}:operation.vendor_bill_void`,
      `${namespace}:operation.vendor_payment_post`,
      `${namespace}:operation.vendor_credit_post`,
    ],
  );
  for (const [operation, local, holds, refuses] of [
    [commands[0]!, 'vendor_bill', 'draft', 'open'],
    [commands[1]!, 'vendor_bill', 'open', 'partially_paid'],
    [commands[2]!, 'vendor_payment', 'draft', 'posted'],
    [commands[3]!, 'vendor_credit', 'draft', 'posted'],
  ] as const) {
    assert.equal(operation.tier, 'o1');
    assert.equal(
      operation.readBack.targetId,
      `${namespace}:query.${local}_get`,
    );
    const evaluate = (state: string) =>
      evaluateRegisteredOperationPrecondition(
        operation.precondition as Parameters<
          typeof evaluateRegisteredOperationPrecondition
        >[0],
        {
          [`${namespace}:field.${local}_state`]: `${namespace}:option.${local}_state_${state}`,
        } as Parameters<typeof evaluateRegisteredOperationPrecondition>[1],
      ).outcome;
    assert.equal(evaluate(holds), 'holds');
    assert.equal(evaluate(refuses), 'refused');
  }
});

test('PAYABLES: twenty-four permissions, entity-owned queries, a bill List export bound and a vendor invoice number that is optional and searchable', () => {
  const declared = payables();
  const permissions = declared.permissions.filter((permission) =>
    permission.permissionId.includes(':permission.vendor_'),
  );
  assert.equal(permissions.length, 24);
  assert.deepEqual(
    permissions
      .filter((permission) => permission.action === 'transition')
      .map((permission) => permission.permissionId.split(':permission.')[1]),
    [
      'vendor_bill_post',
      'vendor_bill_void',
      'vendor_payment_post',
      'vendor_credit_post',
    ],
  );
  const queries = declared.queries.filter((query) =>
    query.queryId.includes(':query.vendor_'),
  );
  assert.equal(queries.length, 16);
  assert.ok(
    queries.every(
      (query) => query.legalEntityScope?.cardinality === 'exactlyOne',
    ),
    'every payables query is scoped to exactly one company',
  );
  assert.deepEqual(
    queries
      .filter((query) => query.exportMaximumResultCount !== undefined)
      .map((query) => [query.queryId, query.exportMaximumResultCount]),
    [[`${namespace}:query.vendor_bill_list`, 5_000]],
  );
  assert.deepEqual(
    PAYABLES_LOCALS.map((local) =>
      queries
        .find(
          (query) => query.queryId === `${namespace}:query.${local}_resolve`,
        )
        ?.resolveMatchKeys?.map((key) => key.field.targetId),
    ),
    [
      [`${namespace}:field.vendor_bill_number`],
      [`${namespace}:field.vendor_bill_line_item_id`],
      [`${namespace}:field.vendor_payment_number`],
      [`${namespace}:field.vendor_credit_number`],
    ],
  );
  const reference = declared.fields.find(
    (field) =>
      field.fieldId ===
      `${namespace}:field.vendor_bill_supplier_invoice_number`,
  );
  assert.equal(reference?.presence, 'optional');
  assert.equal(reference?.searchable, true);
  // Every family is classified in both registries (entity-owned, same
  // company as what it names).
  for (const local of PAYABLES_LOCALS)
    assert.equal(
      LEGAL_ENTITY_FAMILY_MAP_V1.find((family) => family.familyId === local)
        ?.classification,
      'entityOwned',
    );
  for (const [source, target] of [
    ['vendor_bill', 'purchase_order'],
    ['vendor_bill_line', 'vendor_bill'],
    ['vendor_bill_line', 'purchase_order_line'],
    ['vendor_payment', 'vendor_bill'],
    ['vendor_credit', 'vendor_bill'],
  ] as const)
    assert.ok(
      LEGAL_ENTITY_RELATION_SEMANTICS_V1.some(
        (rule) =>
          rule.sourceFamilyId === source &&
          rule.targetFamilyId === target &&
          rule.semantics === 'sameEntity',
      ),
      `${source} -> ${target} is a same-company relation`,
    );
  // Twelve standard surfaces: a list, a detail and a form for each.
  assert.equal(
    declared.surfaces.filter((surface) =>
      surface.surfaceId.includes(':surface.vendor_'),
    ).length,
    12,
  );
});
