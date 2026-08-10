import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import test from 'node:test';

import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  type CompilerSemanticProfileVersion,
  type CompileSuccess,
  type ContentAddressedArtifact,
} from '../../packages/compiler/src/index.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
} from '../../packages/runtime/src/request-context.js';
import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationNonAcceptedRequest,
  type SemanticOperationResultEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_RESULT_VERSION,
  SemanticQueryGateway,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeProjectionFamily,
  type RequestRuntimeView,
  type RuntimeProjection,
} from '../../packages/runtime/src/request-runtime-view.js';
import { createSurfaceRuntimeServer } from '../../apps/web/src/app-server.js';
import {
  renderSurfaceRuntimeWithData,
  submitSurfaceRuntimeIntent,
  type SurfaceRuntimeGateways,
} from '../../apps/web/src/surface-runtime.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
} from '../fixtures/g2/module-conformance/definitions.js';

const tenantA = 'a1000000-0000-4000-8000-000000000001';
const tenantB = 'b1000000-0000-4000-8000-000000000001';
const environmentA = 'a2000000-0000-4000-8000-000000000002';
const environmentB = 'b2000000-0000-4000-8000-000000000002';
const principalA = 'a3000000-0000-4000-8000-000000000003';
const principalB = 'b3000000-0000-4000-8000-000000000003';
const releaseId = 'd4000000-0000-4000-8000-000000000004';
const pointerId = 'd5000000-0000-4000-8000-000000000005';

test('compiled fixture surfaces bind live Q0/O0 data through one pinned request path', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  executor.seed(tenantA, 'Tenant A live');
  executor.seed(tenantB, 'Tenant B hidden');
  const gateways = semanticGateways(policy, executor);
  const server = createSurfaceRuntimeServer(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
      b: identity(tenantB, environmentB, principalB),
    }),
    gateways,
  );
  const baseUrl = await listen(server);
  try {
    const list = await fetch(
      `${baseUrl}/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_list`)}`,
      { headers: { authorization: 'a' } },
    );
    const listHtml = await list.text();
    assert.equal(list.status, 200);
    assert.match(listHtml, /Tenant A live/);
    assert.doesNotMatch(listHtml, /Tenant B hidden/);
    assert.doesNotMatch(
      listHtml,
      /north_star_module|nsm_[ctik]_|storageClass/i,
    );

    const formSurface = `${FIXTURE_IDS.namespace}:surface.master_form`;
    const create = await fetch(
      `${baseUrl}/?surface=${encodeURIComponent(formSurface)}`,
      {
        body: new URLSearchParams({
          idempotencyKey: randomUUID(),
          intent: 'create',
          recordId: randomUUID(),
          [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Created in browser',
        }),
        headers: {
          authorization: 'a',
          'content-type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      },
    );
    const createHtml = await create.text();
    assert.equal(create.status, 200);
    assert.match(createHtml, /Created in browser/);
    assert.match(createHtml, /data-operation-intent="create"/);
    assert.match(createHtml, /data-trust-linked="true"/);
    assert.equal(executor.operationCalls.length, 1);
    assert.equal(executor.operationCalls[0]?.context.tenantId, tenantA);
    assert.equal(
      executor.operationCalls[0]?.context.environmentId,
      environmentA,
    );
    assert.equal(executor.operationCalls[0]?.context.principalId, principalA);
    assert.equal(executor.trustFacts.length, 1);
    assert.deepEqual(Object.keys(executor.trustFacts[0]!.links).sort(), [
      'changeDocumentId',
      'domainEventId',
      'invocationId',
      'outboxId',
    ]);

    const createdInput = asRecord(executor.operationCalls[0]!.input);
    const createdId = String(createdInput.recordId);
    const update = await postIntent(baseUrl, formSurface, {
      expectedRevision: '1',
      intent: 'update',
      recordId: createdId,
      [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Updated in browser',
    });
    assert.match(update, /Updated in browser/);
    const recordSurface = `${FIXTURE_IDS.namespace}:surface.master_record`;
    const archived = await postIntent(baseUrl, recordSurface, {
      expectedRevision: '2',
      intent: 'archive',
      recordId: createdId,
    });
    assert.match(archived, /Archived · revision 3/);
    const restored = await postIntent(baseUrl, recordSurface, {
      expectedRevision: '3',
      intent: 'restore',
      recordId: createdId,
    });
    assert.match(restored, /Active · revision 4/);
    assert.deepEqual(
      executor.operationCalls.map((call) => call.definition.effect.kind),
      [
        'createRecordEffect',
        'updateRecordEffect',
        'archiveRecordEffect',
        'restoreRecordEffect',
      ],
    );
    assert.equal(executor.trustFacts.length, 4);
    assert.ok(
      policy.calls.some(
        (call) =>
          call.permissionId ===
          'northstar.runtime:permission.semantic-operation-boundary',
      ),
    );
  } finally {
    await close(server);
  }
});

test('frozen Q0 outcomes and gateway failures render bounded safe states', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const operationMediation = new SemanticOperationMediationAuthority();
  const operationGateway = new SemanticOperationGateway(
    policy,
    new InMemoryGenericExecutor(),
    operationMediation,
  );
  const recordUrl = `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}&record=${randomUUID()}`;
  const cases: ReadonlyArray<
    readonly [SemanticQueryResultEnvelope['outcome'], string]
  > = [
    ['ambiguous', 'QUERY_AMBIGUOUS'],
    ['not-found', 'QUERY_NOT_FOUND'],
    ['unsupported', 'QUERY_UNSUPPORTED'],
  ];
  for (const [outcome, diagnostic] of cases) {
    const result = await renderSurfaceRuntimeWithData(view, recordUrl, {
      operationGateway,
      operationMediation,
      queryGateway: fixedQueryGateway(outcome, []),
    });
    assert.equal(result.statusCode, 200);
    assert.match(result.html, new RegExp(diagnostic));
  }

  const empty = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_list`)}`,
    {
      operationGateway,
      operationMediation,
      queryGateway: fixedQueryGateway('exact', []),
    },
  );
  assert.match(empty.html, /data-data-state="empty"/);

  const denied = await renderSurfaceRuntimeWithData(view, recordUrl, {
    operationGateway,
    operationMediation,
    queryGateway: new SemanticQueryGateway(
      new RecordingPolicy('DENY'),
      new InMemoryGenericExecutor(),
    ),
  });
  assert.match(denied.html, /QUERY_PERMISSION_DENIED/);

  const unavailable = await renderSurfaceRuntimeWithData(view, recordUrl, {
    operationGateway,
    operationMediation,
    queryGateway: new SemanticQueryGateway(new RecordingPolicy('ALLOW'), {
      async execute() {
        throw new Error('north_star_module.private_table');
      },
    }),
  });
  assert.match(unavailable.html, /QUERY_UNAVAILABLE/);
  assert.doesNotMatch(unavailable.html, /private_table|north_star_module/);
});

test('compiler-valid collection queries fail closed on singular surfaces', async () => {
  const definition = ordinaryModuleV1();
  assert.ok(Array.isArray(definition.surfaces));
  const form = definition.surfaces
    .map(asRecord)
    .find(
      (surface) =>
        surface.surfaceId === `${FIXTURE_IDS.namespace}:surface.master_form`,
    );
  assert.ok(form);
  asRecord(form.dataSource).targetId =
    `${FIXTURE_IDS.namespace}:query.master_list`;

  const compiled = compileFixture(definition);
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const result = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`,
    semanticGateways(policy, executor),
  );

  assert.equal(result.statusCode, 422);
  assert.match(result.html, /QUERY_UNSUPPORTED/);
  assert.equal(executor.queryCalls.length, 0);
});

test('human-confirmed forms render the authoritative operation read-back without a follow-up query', async () => {
  const definition = ordinaryModuleV1();
  assert.ok(Array.isArray(definition.operations));
  for (const operation of definition.operations.map(asRecord)) {
    if (
      operation.operationId ===
        `${FIXTURE_IDS.namespace}:operation.master_create` ||
      operation.operationId ===
        `${FIXTURE_IDS.namespace}:operation.master_update`
    ) {
      operation.confirmation = 'humanRequired';
    }
  }

  const compiled = compileFixture(definition);
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  let queryCalls = 0;
  const operationMediation = new SemanticOperationMediationAuthority();
  const gateways: SurfaceRuntimeGateways = {
    operationGateway: new SemanticOperationGateway(
      policy,
      executor,
      operationMediation,
    ),
    operationMediation,
    queryGateway: new SemanticQueryGateway(policy, {
      async execute() {
        queryCalls += 1;
        throw new Error('follow-up query must not replace operation read-back');
      },
    }),
  };
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const formUrl = `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}`;
  const initial = await renderSurfaceRuntimeWithData(view, formUrl, gateways);
  assert.doesNotMatch(initial.html, /name="confirmed"/);
  assert.match(initial.html, /name="idempotencyKey"/);

  const createSubmission = {
    idempotencyKey: randomUUID(),
    intent: 'create',
    recordId: randomUUID(),
    [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Authoritative read-back',
  };
  const preview = await submitSurfaceRuntimeIntent(
    view,
    formUrl,
    createSubmission,
    gateways,
  );
  assert.equal(preview.statusCode, 200);
  assert.match(preview.html, /data-confirmation-step="preview"/);
  assert.match(preview.html, /Confirm Create/);
  assert.equal(executor.operationCalls.length, 0);
  assert.equal(
    hiddenValue(preview.html, 'idempotencyKey'),
    createSubmission.idempotencyKey,
  );
  const createGrant = hiddenValue(preview.html, 'confirmationGrant');

  const created = await submitSurfaceRuntimeIntent(
    view,
    formUrl,
    {
      ...createSubmission,
      confirmationGrant: createGrant,
    },
    gateways,
  );
  assert.equal(created.statusCode, 200);
  assert.match(created.html, /Authoritative read-back/);
  assert.doesNotMatch(created.html, /name="confirmed"/);
  assert.equal(queryCalls, 0);
  assert.equal(executor.operationCalls.length, 1);

  const createInput = asRecord(executor.operationCalls[0]!.input);
  const updateSubmission = {
    expectedRevision: '1',
    idempotencyKey: randomUUID(),
    intent: 'update',
    recordId: String(createInput.recordId),
    [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Updated read-back',
  };
  const updatePreview = await submitSurfaceRuntimeIntent(
    view,
    formUrl,
    updateSubmission,
    gateways,
  );
  const updated = await submitSurfaceRuntimeIntent(
    view,
    formUrl,
    {
      ...updateSubmission,
      confirmationGrant: hiddenValue(updatePreview.html, 'confirmationGrant'),
    },
    gateways,
  );
  assert.equal(updated.statusCode, 200);
  assert.match(updated.html, /Updated read-back/);
  assert.equal(queryCalls, 0);
  assert.equal(executor.operationCalls.length, 2);
});

test('a capability command is artifact-bound, render-minted, and deliberately confirmed', async () => {
  const definition = ordinaryModuleV1();
  const capabilityId = `${FIXTURE_IDS.namespace}:capability.post`;
  const operationId = `${FIXTURE_IDS.namespace}:operation.master_post`;
  assert.ok(Array.isArray(definition.capabilityRequirements));
  definition.capabilityRequirements.push({
    capabilityId,
    capabilityVersion: 1,
    declaredEffects: ['appendFact'],
    kind: 'capabilityRequirement',
    requiredProjections: ['operation', 'surface', 'verification'],
    schemaVersion: 'v3',
    supportStatus: 'supported',
  });
  assert.ok(Array.isArray(definition.permissions));
  definition.permissions.push({
    action: 'transition',
    kind: 'permissionDefinition',
    label: 'Post master',
    lifecycle: 'active',
    permissionId: `${FIXTURE_IDS.namespace}:permission.master_post`,
    resource: {
      kind: 'entityReference',
      schemaVersion: 'v3',
      targetId: FIXTURE_IDS.entityIds.parent,
    },
    schemaVersion: 'v3',
  });
  assert.ok(Array.isArray(definition.operations));
  definition.operations.push({
    confirmation: 'humanRequired',
    effect: {
      capability: {
        kind: 'capabilityReference',
        schemaVersion: 'v3',
        targetId: capabilityId,
      },
      kind: 'registeredCapabilityEffect',
      schemaVersion: 'v3',
    },
    kind: 'operationDefinition',
    module: {
      kind: 'moduleReference',
      schemaVersion: 'v3',
      targetId: FIXTURE_IDS.moduleId,
    },
    operationId,
    permission: {
      kind: 'permissionReference',
      schemaVersion: 'v3',
      targetId: `${FIXTURE_IDS.namespace}:permission.master_post`,
    },
    precondition: {
      field: {
        kind: 'fieldReference',
        schemaVersion: 'v3',
        targetId: FIXTURE_IDS.fieldIds.parentName,
      },
      kind: 'fieldComparisonPredicate',
      operator: 'equals',
      schemaVersion: 'v3',
      value: { kind: 'textValue', schemaVersion: 'v3', value: 'Draft' },
    },
    readBack: {
      kind: 'queryReference',
      schemaVersion: 'v3',
      targetId: `${FIXTURE_IDS.namespace}:query.master_get`,
    },
    schemaVersion: 'v3',
    tier: 'o1',
  });
  assert.ok(Array.isArray(definition.surfaces));
  const recordSurface = definition.surfaces
    .map(asRecord)
    .find(
      (surface) =>
        surface.surfaceId === `${FIXTURE_IDS.namespace}:surface.master_record`,
    );
  assert.ok(recordSurface && Array.isArray(recordSurface.slots));
  recordSurface.slots.push({
    content: {
      kind: 'opaqueSurfaceContentReference',
      schemaVersion: 'v3',
      targetId: `${FIXTURE_IDS.namespace}:capability.standard_surface_content`,
    },
    kind: 'surfaceSlot',
    orderKey: 20,
    schemaVersion: 'v3',
    slot: 'commandBar',
    slotId: `${FIXTURE_IDS.namespace}:slot.master_record_command_bar`,
  });

  const compiled = compileFixture(definition);
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const recordId = executor.seed(tenantA, 'Draft');
  const gateways = semanticGateways(policy, executor);
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const recordUrl = `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}&record=${encodeURIComponent(recordId)}`;
  const rendered = await renderSurfaceRuntimeWithData(
    view,
    recordUrl,
    gateways,
  );
  assert.match(
    rendered.html,
    new RegExp(`data-capability-id="${capabilityId}"`),
  );
  assert.match(rendered.html, /Draft staged\./);
  const renderedKey = hiddenValue(rendered.html, 'idempotencyKey');
  assert.match(
    renderedKey,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  const preview = await submitSurfaceRuntimeIntent(
    view,
    recordUrl,
    {
      expectedRevision: '1',
      idempotencyKey: renderedKey,
      intent: 'command',
      recordId,
    },
    gateways,
  );
  assert.equal(preview.statusCode, 200);
  assert.match(preview.html, /data-confirmation-step="preview"/);
  assert.match(preview.html, /data-predicted-effects="registered-capability"/);
  assert.match(preview.html, new RegExp(`<code>${capabilityId}</code>`));
  assert.equal(hiddenValue(preview.html, 'idempotencyKey'), renderedKey);
  assert.equal(executor.operationCalls.length, 0);
});

const REQUIRED_RELATION_ID = `${FIXTURE_IDS.namespace}:relation.master_role_parent`;
const CHILD_FORM_SURFACE = `${FIXTURE_IDS.namespace}:surface.master_role_form`;

/**
 * The acceptance criterion for `ux-reference-picker`, stated as the thing that
 * must be impossible rather than the thing that must work: a create through a
 * REQUIRED relation cannot be satisfied unless the wire carries it.
 *
 * The specimen is the fixture's own `master_role_parent`, which declared
 * `required: true` long before this packet existed. It was not authored to make
 * this gate pass.
 */
test('a required relation is pickable and reaches the operation input', async () => {
  const compiled = compileFixture(
    ordinaryModuleV1(),
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  );
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const parentRecordId = executor.seed(tenantA, 'Northwind');
  const entry = runtimeEntry(compiled, policy, {
    a: identity(tenantA, environmentA, principalA),
  });
  const view = await issuedView(entry, 'a');
  const gateways = semanticGateways(policy, executor);

  const rendered = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`,
    gateways,
  );

  assert.match(
    rendered.html,
    new RegExp(`<select name="relation:${REQUIRED_RELATION_ID}" required>`),
    'a required relation must render a required server-side control',
  );
  assert.match(
    rendered.html,
    new RegExp(`<option value="${parentRecordId}">Northwind</option>`),
    'the control must offer the target entity’s records, labelled by its display field',
  );
  assert.doesNotMatch(
    rendered.html,
    /<script/,
    'ADR-0036 §2 admits no script here; a server-rendered select needs none',
  );

  const before = executor.operationCalls.length;
  await submitSurfaceRuntimeIntent(
    view,
    `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`,
    {
      idempotencyKey: randomUUID(),
      intent: 'create',
      recordId: randomUUID(),
      [`relation:${REQUIRED_RELATION_ID}`]: parentRecordId,
      [`value:${FIXTURE_IDS.fieldIds.childRole}`]: FIXTURE_IDS.optionIds.owner,
    },
    gateways,
  );

  assert.equal(
    executor.operationCalls.length,
    before + 1,
    'the create must have been executed, not refused',
  );
  const input = asRecord(executor.operationCalls.at(-1)!.input);
  assert.deepEqual(
    input.relations,
    { [REQUIRED_RELATION_ID]: parentRecordId },
    'the relation must arrive keyed by relation id, carrying the chosen record',
  );
});

/**
 * The negative control, and the one that decides whether the gate above is
 * worth anything. Compiled at the ADOPTED profile the relation carries no
 * target entity, so the picker cannot be built -- and the form must REFUSE
 * rather than render controls whose submission the provider is certain to
 * reject. A gate that only ever sees the wire present cannot tell the wire from
 * the renderer.
 */
test('without the relation target the create form refuses instead of rendering', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  executor.seed(tenantA, 'Northwind');
  const entry = runtimeEntry(compiled, policy, {
    a: identity(tenantA, environmentA, principalA),
  });
  const view = await issuedView(entry, 'a');

  const rendered = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`,
    semanticGateways(policy, executor),
  );

  assert.doesNotMatch(
    rendered.html,
    /<select name="relation:/,
    'no target entity means no control can be offered',
  );
  assert.doesNotMatch(
    rendered.html,
    /id="surface-record-form"/,
    'an unsatisfiable create form must not render at all',
  );
  assert.match(
    rendered.html,
    /data-diagnostic-code="QUERY_UNSUPPORTED"/,
    'the refusal is named rather than silent (ADR-0052 §5)',
  );
});

/**
 * Raised in review: the picker took page one and ignored list coverage, so a
 * target entity with more records than the query maximum produced a control
 * that looked complete while every target after page one was unselectable.
 *
 * The prior harness could not catch it -- `listCoverage` hardcoded
 * `hasMore: false`, so the gate could never see the state it needed to refuse.
 */
test('a target the picker cannot enumerate completely refuses rather than truncating', async () => {
  const compiled = compileFixture(
    ordinaryModuleV1(),
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  );
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  executor.seed(tenantA, 'Northwind');
  const entry = runtimeEntry(compiled, policy, {
    a: identity(tenantA, environmentA, principalA),
  });
  const view = await issuedView(entry, 'a');
  const url = `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`;

  // Admission twin: the SAME tree with complete coverage must render, or this
  // control would pass against a picker that never renders at all.
  const complete = await renderSurfaceRuntimeWithData(
    view,
    url,
    semanticGateways(policy, executor),
  );
  assert.match(
    complete.html,
    new RegExp(`<select name="relation:${REQUIRED_RELATION_ID}" required>`),
    'complete coverage must still render the control',
  );

  executor.reportsMoreRecords = true;
  const truncated = await renderSurfaceRuntimeWithData(
    view,
    url,
    semanticGateways(policy, executor),
  );
  assert.doesNotMatch(
    truncated.html,
    /<select name="relation:/,
    'an incompletely enumerable target must not render a partial picker',
  );
  assert.match(
    truncated.html,
    /data-diagnostic-code="QUERY_UNSUPPORTED"/,
    'and the required relation makes the whole form refuse, by name',
  );
});

/**
 * Raised in review: the browser had its own relation-input parser that accepted
 * `targetEntityId` whenever present and turned absence into `null`, so a forged
 * artifact the operation gateway refuses would have been admitted here. Both
 * readers now run `parsePinnedRelationInputs`, and this proves the browser side
 * refuses in BOTH directions rather than only the convenient one.
 */
test('the browser reader refuses a contract whose version and relation keys disagree', async () => {
  const policy = new RecordingPolicy('ALLOW');
  const url = `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`;

  const forgeries = [
    {
      // v1 carrying a v3-only key.
      from: COMPILER_SEMANTIC_PROFILE_V2_VERSION,
      mutate: (contract: Record<string, unknown>) => {
        contract.schemaVersion = 'northstar.module-input-contract/v1';
      },
      name: 'a v1 contract carrying targetEntityId',
    },
    {
      // v3 missing the key it declares.
      from: COMPILER_SEMANTIC_PROFILE_V2_VERSION,
      mutate: (contract: Record<string, unknown>) => {
        for (const relation of contract.relationInputs as Record<
          string,
          unknown
        >[]) {
          delete relation.targetEntityId;
        }
      },
      name: 'a v3 contract missing targetEntityId',
    },
  ];

  for (const forgery of forgeries) {
    const compiled = compileFixture(ordinaryModuleV1(), forgery.from);
    const projections = runtimeProjections(compiled);
    const payload = structuredClone(projections.operation.payload) as Record<
      string,
      unknown
    >;
    let mutated = 0;
    for (const operation of payload.operations as Record<string, unknown>[]) {
      const contract = operation.inputContract as
        Record<string, unknown> | undefined;
      if (!contract || (contract.relationInputs as unknown[]).length === 0) {
        continue;
      }
      forgery.mutate(contract);
      mutated += 1;
    }
    assert.ok(
      mutated > 0,
      `${forgery.name}: the forgery must actually reach a relation-bearing contract`,
    );

    const entry = new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(async () =>
        identity(tenantA, environmentA, principalA),
      ),
      {
        async load(context): Promise<LoadedRequestRuntimeDefinition> {
          return {
            environmentId: context.environmentId,
            pointer: { fence: 1, pointerId },
            projections: {
              ...projections,
              operation: {
                ...projections.operation,
                payload: payload as unknown as ImmutableJsonValue,
              },
            },
            release: { contentHash: compiled.releaseRoot, releaseId },
            tenantId: context.tenantId,
          };
        },
      },
      policy,
    );
    const view = await issuedView(entry, 'a');
    const rendered = await renderSurfaceRuntimeWithData(
      view,
      url,
      semanticGateways(policy, new InMemoryGenericExecutor()),
    );
    assert.doesNotMatch(
      rendered.html,
      /<select name="relation:/,
      `${forgery.name}: must not produce a control`,
    );
    assert.match(
      rendered.html,
      /data-diagnostic-code="QUERY_UNSUPPORTED"/,
      `${forgery.name}: must be refused as an unreadable binding`,
    );
  }
});

class RecordingPolicy implements CurrentPolicyGateway {
  readonly calls: CurrentPolicyDecisionRequest[] = [];

  constructor(private readonly decision: 'ALLOW' | 'DENY') {}

  async authorize(request: CurrentPolicyDecisionRequest) {
    this.calls.push(request);
    return {
      decision: this.decision,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'surface-binding-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'surface-binding-policy/v1' };
  }
}

class InMemoryGenericExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  /** When true, every list result claims more records sit behind a cursor. */
  reportsMoreRecords = false;

  readonly nonAcceptedCalls: SemanticOperationNonAcceptedRequest[] = [];
  readonly operationCalls: SemanticOperationExecutionRequest[] = [];
  readonly queryCalls: SemanticQueryExecutionRequest[] = [];
  readonly trustFacts: Array<{
    readonly links: NonNullable<SemanticOperationResultEnvelope['trust']>;
    readonly tenantId: string;
  }> = [];
  private readonly recordsByTenant = new Map<
    string,
    Map<string, SemanticRecordDto>
  >();

  seed(tenantId: string, name: string): string {
    const recordId = randomUUID();
    this.tenantRecords(tenantId).set(
      recordId,
      record(recordId, name, FIXTURE_IDS.entityIds.parent),
    );
    return recordId;
  }

  async recordNonAccepted(
    request: SemanticOperationNonAcceptedRequest,
  ): Promise<void> {
    this.nonAcceptedCalls.push(request);
  }

  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope>;
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  async execute(
    request: SemanticQueryExecutionRequest | SemanticOperationExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope | SemanticOperationResultEnvelope> {
    return 'arguments' in request
      ? this.query(request)
      : this.operation(request);
  }

  private async query(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope> {
    this.queryCalls.push(request);
    const values = [...this.tenantRecords(request.context.tenantId).values()];
    const args = asRecord(request.arguments);
    const selected =
      request.definition.queryType === 'get'
        ? values.filter((entry) => entry.recordId === args.recordId)
        : values;
    const visible =
      args.includeArchived === true
        ? selected
        : selected.filter((entry) => !entry.archived);
    const records = request.list
      ? visible.map((entry) => projectedListRecord(request, entry))
      : visible;
    const result: SemanticQueryResultEnvelope = {
      kind: 'semanticQueryResult',
      outcome:
        visible.length > 0 || request.definition.queryType === 'list'
          ? 'exact'
          : 'not-found',
      queryId: request.definition.queryId,
      records,
      schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
      unsupportedReason: null,
    };
    return request.list
      ? {
          ...result,
          listCoverage: listCoverage(
            request,
            records.length,
            this.reportsMoreRecords,
          ),
        }
      : result;
  }

  private async operation(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    this.operationCalls.push(request);
    const input = asRecord(request.input);
    const recordId = String(input.recordId);
    const tenantRecords = this.tenantRecords(request.context.tenantId);
    const previous = tenantRecords.get(recordId);
    const values = asRecord(input.values ?? input.patch ?? {});
    const stored = operationRecord(request, previous, recordId, values);
    tenantRecords.set(recordId, stored);
    const links = {
      changeDocumentId: randomUUID(),
      domainEventId: randomUUID(),
      invocationId: randomUUID(),
      outboxId: randomUUID(),
    };
    this.trustFacts.push({ links, tenantId: request.context.tenantId });
    return {
      kind: 'semanticOperationResult',
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: stored,
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      trust: links,
      unsupportedReason: null,
    };
  }

  private tenantRecords(tenantId: string): Map<string, SemanticRecordDto> {
    const existing = this.recordsByTenant.get(tenantId);
    if (existing) return existing;
    const created = new Map<string, SemanticRecordDto>();
    this.recordsByTenant.set(tenantId, created);
    return created;
  }
}

function semanticGateways(
  policy: CurrentPolicyGateway,
  executor: InMemoryGenericExecutor,
): SurfaceRuntimeGateways {
  const operationMediation = new SemanticOperationMediationAuthority();
  return {
    operationGateway: new SemanticOperationGateway(
      policy,
      executor,
      operationMediation,
    ),
    operationMediation,
    queryGateway: new SemanticQueryGateway(policy, executor),
  };
}

function hiddenValue(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  assert.ok(match?.[1]);
  return match[1];
}

function fixedQueryGateway(
  outcome: SemanticQueryResultEnvelope['outcome'],
  records: readonly SemanticRecordDto[],
): SurfaceRuntimeGateways['queryGateway'] {
  return new SemanticQueryGateway(new RecordingPolicy('ALLOW'), {
    async execute(request) {
      const projectedRecords = request.list
        ? records.map((entry) => projectedListRecord(request, entry))
        : records;
      const result: SemanticQueryResultEnvelope = {
        kind: 'semanticQueryResult',
        outcome,
        queryId: request.definition.queryId,
        records: projectedRecords,
        schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
        unsupportedReason: outcome === 'unsupported' ? 'fixture' : null,
      };
      return request.list
        ? {
            ...result,
            listCoverage: listCoverage(request, projectedRecords.length),
          }
        : result;
    },
  });
}

function projectedListRecord(
  request: SemanticQueryExecutionRequest,
  record: SemanticRecordDto,
): SemanticRecordDto {
  return Object.freeze({
    ...record,
    displayValues: Object.freeze(
      Object.fromEntries(
        request.definition.selections.map(({ fieldId }) => [
          fieldId,
          displayValue(record.values[fieldId]),
        ]),
      ),
    ),
    relationLabels: Object.freeze({}),
  });
}

function displayValue(value: ImmutableJsonValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function listCoverage(
  request: SemanticQueryExecutionRequest,
  returnedCount: number,
  hasMore = false,
): NonNullable<SemanticQueryResultEnvelope['listCoverage']> {
  assert.ok(request.list);
  return Object.freeze({
    effectivePageSize: request.list.query.effectivePageSize,
    hasMore,
    includeArchived: request.list.query.includeArchived,
    matchMode: request.list.query.matchMode,
    nextCursor: hasMore ? 'cursor-page-2' : null,
    pageOffset: request.list.query.pageOffset,
    projectedSearchValueCount:
      request.list.query.search.length === 0
        ? 0
        : request.definition.selections.length,
    requestedPageSize: request.list.query.requestedPageSize,
    returnedCount,
    schemaVersion: 'northstar.shared-list-result/v1',
    search: request.list.query.search,
    sort: request.list.query.sort,
    totalCount: request.list.query.pageOffset + returnedCount,
    truncatedByMaximum: request.list.query.truncatedByMaximum,
  });
}

function runtimeEntry(
  compiled: CompileSuccess,
  policy: CurrentPolicyGateway,
  identities: Readonly<Record<string, AuthenticatedIdentity>>,
): AuthenticatedRequestRuntimeEntryAdapter {
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async (request) => {
      const token = request.headers?.authorization;
      return typeof token === 'string' ? (identities[token] ?? null) : null;
    }),
    {
      async load(context): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId: context.environmentId,
          pointer: { fence: 1, pointerId },
          projections: runtimeProjections(compiled),
          release: { contentHash: compiled.releaseRoot, releaseId },
          tenantId: context.tenantId,
        };
      },
    },
    policy,
  );
}

async function issuedView(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  token: string,
): Promise<RequestRuntimeView> {
  return entry.run({ headers: { authorization: token } }, (view) => view);
}

function identity(
  tenantId: string,
  environmentId: string,
  principalId: string,
): AuthenticatedIdentity {
  return { environmentId, principalId, tenantId };
}

function record(
  recordId: string,
  name: string,
  entityId: string,
): SemanticRecordDto {
  return Object.freeze({
    archived: false,
    entityId,
    recordId,
    revision: 1,
    values: Object.freeze({ [FIXTURE_IDS.fieldIds.parentName]: name }),
  });
}

function operationRecord(
  request: SemanticOperationExecutionRequest,
  previous: SemanticRecordDto | undefined,
  recordId: string,
  values: Record<string, unknown>,
): SemanticRecordDto {
  const kind = request.definition.effect.kind;
  const nextValues =
    kind === 'createRecordEffect'
      ? values
      : { ...(previous?.values ?? {}), ...values };
  return Object.freeze({
    archived:
      kind === 'archiveRecordEffect'
        ? true
        : kind === 'restoreRecordEffect'
          ? false
          : (previous?.archived ?? false),
    entityId: request.definition.effect.entity.targetId,
    recordId,
    revision: (previous?.revision ?? 0) + 1,
    values: Object.freeze(nextValues as Record<string, ImmutableJsonValue>),
  });
}

function runtimeProjections(
  compiled: CompileSuccess,
): LoadedRequestRuntimeDefinition['projections'] {
  return {
    agent: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.agent),
    catalog: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog),
    operation: projection(
      compiled,
      REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
    ),
    query: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.query),
    surface: projection(compiled, REQUEST_RUNTIME_PROJECTION_FAMILIES.surface),
  };
}

function projection<TFamily extends RequestRuntimeProjectionFamily>(
  compiled: CompileSuccess,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  assert.ok(reference);
  const manifestValue = decode(artifact(compiled, reference.artifactRoot));
  assert.ok(Array.isArray(manifestValue.chunks));
  const descriptor = manifestValue.chunks[0];
  assert.ok(isRecord(descriptor));
  assert.equal(typeof descriptor.contentHash, 'string');
  return {
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: decode(
      artifact(compiled, String(descriptor.contentHash)),
    ) as unknown as ImmutableJsonValue,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  };
}

function artifact(
  compiled: CompileSuccess,
  contentHash: string,
): ContentAddressedArtifact {
  const value = compiled.bundle.artifacts.find(
    (candidate) => candidate.contentHash === contentHash,
  );
  assert.ok(value);
  return value;
}

function decode(value: ContentAddressedArtifact): Record<string, unknown> {
  const decoded: unknown = JSON.parse(
    new TextDecoder().decode(value.canonicalBytes),
  );
  assert.ok(isRecord(decoded));
  return decoded;
}

function compileFixture(
  definition: Record<string, unknown> = ordinaryModuleV1(),
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion = MODULE_COMPILER_PROFILE.compilerSemanticProfileVersion,
): CompileSuccess {
  const normalized = normalizeApplicationPackage(definition);
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    // Version-from-artifact: compile the fixture at the version it declares.
    profile: {
      ...MODULE_COMPILER_PROFILE,
      compilerSemanticProfileVersion,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
    },
  });
  assert.equal(result.status, 'compiled');
  return result as CompileSuccess;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function postIntent(
  baseUrl: string,
  surfaceId: string,
  submission: Record<string, string>,
): Promise<string> {
  const mediated = {
    idempotencyKey: randomUUID(),
    ...submission,
  };
  const response = await fetch(
    `${baseUrl}/?surface=${encodeURIComponent(surfaceId)}`,
    {
      body: new URLSearchParams(mediated),
      headers: {
        authorization: 'a',
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  if (!html.includes('data-confirmation-step="preview"')) return html;
  const confirmed = Object.fromEntries(
    [
      ...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g),
    ].map((match) => [match[1]!, match[2]!]),
  );
  const confirmedResponse = await fetch(
    `${baseUrl}/?surface=${encodeURIComponent(surfaceId)}`,
    {
      body: new URLSearchParams(confirmed),
      headers: {
        authorization: 'a',
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    },
  );
  assert.equal(confirmedResponse.status, 200);
  return confirmedResponse.text();
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
