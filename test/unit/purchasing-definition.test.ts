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
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import {
  LEGAL_ENTITY_FAMILY_MAP_V1,
  LEGAL_ENTITY_RELATION_SEMANTICS_V1,
} from '../../packages/domain/src/inventory/contracts.js';
import {
  PURCHASING_IDS,
  purchasingModuleDefinition,
} from '../../packages/domain/src/purchasing/index.js';
import { evaluateRegisteredOperationPrecondition } from '../../packages/runtime/src/semantic-operation-gateway.js';

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
    ['close', 'released', 'closed'],
    ['reopen', 'closed', 'released'],
    ['cancel', 'released', 'cancelled'],
  ],
} as const;

/** Every state-to-state pair the ruling REFUSES, so absence is asserted rather than assumed. */
const REFUSED_MOVES = [
  ['released', 'draft'],
  ['closed', 'draft'],
  ['cancelled', 'draft'],
  ['draft', 'cancelled'],
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
  assert.deepEqual(
    normalizationRefusal((definition) => {
      definition.stateMachines[0]!.machineId = `${namespace}:machine.renamed`;
    }).toSorted(),
    ['CANON_QUERY_FIELD_LOCALITY', 'CANON_REFERENCE_UNRESOLVED'],
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
  assert.deepEqual(
    normalizationRefusal((definition) => {
      definition.stateMachines = [];
    }).toSorted(),
    ['CANON_QUERY_FIELD_LOCALITY', 'CANON_REFERENCE_UNRESOLVED'],
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

  // The two creates write their authored fields and only those.
  assert.deepEqual(
    writableFieldIds(
      operations,
      `${namespace}:operation.purchase_order_create`,
    ),
    Object.values(PURCHASING_IDS.fieldIds.purchaseOrder).toSorted(),
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
  for (const [action, from, to] of LIFECYCLE.transitions) {
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
  for (const [action] of LIFECYCLE.transitions) {
    const permissionId = `${namespace}:permission.purchase_order_${action}`;
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
  const permissions = authored().permissions.filter((permission) =>
    LIFECYCLE.transitions.some(
      ([action]) =>
        permission.permissionId ===
        `${namespace}:permission.purchase_order_${action}`,
    ),
  );
  assert.equal(permissions.length, LIFECYCLE.transitions.length);
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
    release: ['draft'],
    reopen: ['closed'],
  };
  for (const [action] of LIFECYCLE.transitions) {
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

test('six surfaces carry the anatomy this runtime registers, and nothing inert', () => {
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
  assert.equal(surfaces.length, 6);
  for (const local of ['purchase_order', 'purchase_order_line']) {
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
  for (const [action] of LIFECYCLE.transitions) {
    assert.equal(
      operationIds.includes(`${namespace}:operation.purchase_order_${action}`),
      true,
    );
  }
  assert.deepEqual(
    operationIds
      .filter((operationId) => /_(release|cancel)$/u.test(operationId))
      .toSorted(),
    [
      `${namespace}:operation.purchase_order_cancel`,
      `${namespace}:operation.purchase_order_release`,
    ],
  );
});

test('Purchasing mounts as the fifth navigation group, with no overflow', () => {
  const composed = composedApplicationDefinition() as unknown as AuthoredShape;
  assert.deepEqual(
    composed.modules.map((module) => module.label),
    ['Party', 'Catalog', 'Location', 'Inventory', 'Purchasing'],
  );

  const navigation = surfaceManifest(compile(composed)).navigation;
  assert.ok(navigation, 'the composed application emits no navigation tree');
  assert.deepEqual(
    navigation.entries.map((entry) => entry.label),
    ['Party', 'Catalog', 'Location', 'Inventory', 'Purchasing'],
    'a sixth group would collapse the tail into an overflow More',
  );
});

test('the composed application still carries exactly one state machine', () => {
  const composed = normalizeApplicationPackage(
    composedApplicationDefinition(),
  ) as unknown as NormalizedShape;
  assert.equal(composed.stateMachines.length, 1);
  assert.equal(
    composed.stateMachines[0]!.machineId,
    'northstar.app:machine.purchase_order_lifecycle',
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

test('the document carries its plan shape and nothing from receiving, valuation or sales', () => {
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

  // No received quantity, anywhere. Plan section 7.12: it ships no receipts, so a
  // stored column could only ever hold zero, and choosing to store it would
  // pre-commit PS-0's over-receipt race to compare-and-swap when PUR-2 may need
  // lock-and-sum on a derived sum. The absence IS the decision being left open,
  // so it is asserted.
  assert.doesNotMatch(JSON.stringify(definition), /received/iu);
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
  assert.equal(definition.entities.length, 2);
  assert.equal(definition.queries.length, 8);
  assert.equal(definition.operations.length, 12);
  assert.equal(definition.permissions.length, 14);
  assert.equal(definition.assertions.length, 2);

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
      .toSorted(),
    [orderEntityId, lineEntityId].toSorted(),
  );
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
  modules: Array<{ label: string }>;
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
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalizeApplicationPackage(definition)),
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
