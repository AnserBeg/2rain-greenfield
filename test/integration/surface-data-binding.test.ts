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
  type CompileSuccess,
  type CompilerSemanticProfileVersion,
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
  semanticOperationRequestFor,
  submitSurfaceRuntimeIntent,
  type SurfaceRuntimeGateways,
} from '../../apps/web/src/surface-runtime.js';
import {
  SurfaceProjectionError,
  readCompiledSurfaceDataBinding,
  readCompiledSurfaceManifest,
  type CompiledSurfaceDataBinding,
} from '../../apps/web/src/surface-contract.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
} from '../fixtures/g2/module-conformance/definitions.js';
import {
  EVERY_KIND_FIELD_IDS,
  everyFieldKindModule,
} from '../fixtures/g2/module-conformance/field-kinds.js';

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
          operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
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
      operationId: `${FIXTURE_IDS.namespace}:operation.master_update`,
      recordId: createdId,
      [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Updated in browser',
    });
    assert.match(update, /Updated in browser/);
    const recordSurface = `${FIXTURE_IDS.namespace}:surface.master_record`;
    const archived = await postIntent(baseUrl, recordSurface, {
      expectedRevision: '2',
      operationId: `${FIXTURE_IDS.namespace}:operation.master_archive`,
      recordId: createdId,
    });
    assert.match(archived, /Archived · revision 3/);
    const restored = await postIntent(baseUrl, recordSurface, {
      expectedRevision: '3',
      operationId: `${FIXTURE_IDS.namespace}:operation.master_restore`,
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
    operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
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
    operationId: `${FIXTURE_IDS.namespace}:operation.master_update`,
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

const EVERY_KIND_FORM = `${FIXTURE_IDS.namespace}:surface.master_form`;

async function everyKindFormHtml(
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion,
  seed?: (executor: InMemoryGenericExecutor) => string,
): Promise<string> {
  const compiled = compileFixture(
    everyFieldKindModule(),
    compilerSemanticProfileVersion,
  );
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const recordId = seed?.(executor);
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const url = `/?surface=${encodeURIComponent(EVERY_KIND_FORM)}${recordId ? `&record=${encodeURIComponent(recordId)}` : ''}`;
  const rendered = await renderSurfaceRuntimeWithData(
    view,
    url,
    semanticGateways(policy, executor),
  );
  assert.equal(rendered.statusCode, 200);
  return rendered.html;
}

function controlFor(html: string, fieldId: string): string {
  const form = html.slice(html.indexOf('<div class="form-fields">'));
  const opening = form.indexOf(`name="value:${fieldId}"`);
  assert.notEqual(
    opening,
    -1,
    `${fieldId} has no control in the rendered form`,
  );
  const start = form.lastIndexOf('<label>', opening);
  const end = form.indexOf('</label>', opening);
  assert.ok(start !== -1 && end !== -1, `${fieldId} control is not in a label`);
  return form.slice(start, end);
}

/**
 * The admission the packet owes: every kind the reader recognises renders the
 * control its type calls for, on ONE form, from a real compile.
 *
 * Read per field rather than over the whole document -- `controlFor` slices the
 * one `<label>` that owns the field's name -- so a single correct control
 * elsewhere on the page cannot satisfy another field's assertion.
 */
test('a v2 form renders the control each canonical field kind calls for', async () => {
  const html = await everyKindFormHtml(COMPILER_SEMANTIC_PROFILE_V2_VERSION);
  const expected: readonly (readonly [string, RegExp])[] = [
    [EVERY_KIND_FIELD_IDS.due, /<input type="date" /],
    [EVERY_KIND_FIELD_IDS.count, /<input type="number" inputmode="numeric" /],
    [EVERY_KIND_FIELD_IDS.price, /<input type="number" inputmode="decimal" /],
    [
      FIXTURE_IDS.fieldIds.parentAmount,
      /<input type="number" inputmode="decimal" /,
    ],
    [EVERY_KIND_FIELD_IDS.weight, /<input type="number" inputmode="decimal" /],
    [EVERY_KIND_FIELD_IDS.active, /<select /],
    [FIXTURE_IDS.fieldIds.parentName, /<input type="text" /],
    [EVERY_KIND_FIELD_IDS.grade, /<select /],
    [EVERY_KIND_FIELD_IDS.region, /<input [^>]*list="/],
  ];
  for (const [fieldId, control] of expected) {
    assert.match(controlFor(html, fieldId), control, fieldId);
  }
  // The blank option is what keeps a select from posting its first option for a
  // field the record never had a value for.
  assert.match(
    controlFor(html, EVERY_KIND_FIELD_IDS.grade),
    /<select [^>]*><option value=""><\/option>/,
  );
});

/**
 * The correction a review blocked this packet for. A control that cannot express
 * the field's declared domain destroys the value before `U7` can normalise it,
 * so the discriminants have to reach the renderer and the renderer has to use
 * them.
 */
test('a temporal control admits its declared precision and timezone semantics', async () => {
  const html = await everyKindFormHtml(COMPILER_SEMANTIC_PROFILE_V2_VERSION);

  // A time input defaults to a 60-second step and silently refuses 12:34:56.
  // Two fields of one kind differing ONLY in declared precision must differ here.
  assert.match(
    controlFor(html, FIXTURE_IDS.fieldIds.parentLocalTime),
    /<input type="time" step="1" /,
  );
  assert.match(
    controlFor(html, EVERY_KIND_FIELD_IDS.preciseTime),
    /<input type="time" step="0\.001" /,
  );

  // `datetime-local` is local time with no timezone information, so neither a
  // utcInstant's `Z` nor a real offset survives it. Refused BY NAME, with the
  // declared domain on the element, and the carrier left lossless.
  for (const [fieldId, semantics, precision] of [
    [FIXTURE_IDS.fieldIds.parentUtcInstant, 'utcInstant', 'millisecond'],
    [EVERY_KIND_FIELD_IDS.offsetMoment, 'offsetDateTime', 'second'],
  ] as const) {
    const control = controlFor(html, fieldId);
    assert.match(control, /<input type="text" /, fieldId);
    assert.doesNotMatch(control, /type="datetime-local"/u, fieldId);
    assert.match(control, /data-refused-control="datetime-local"/u, fieldId);
    assert.match(
      control,
      new RegExp(`data-timezone-semantics="${semantics}"`, 'u'),
      fieldId,
    );
    assert.match(
      control,
      new RegExp(`data-precision="${precision}"`, 'u'),
      fieldId,
    );
  }
});

/**
 * An optional boolean has THREE states and a checkbox has two. The first cut
 * rendered a checkbox beside a hidden `value="false"`, so `null`, absent and
 * `false` all rendered unchecked and all posted `"false"` -- an unrelated edit
 * on the same form rewrote a stored `null` to `false`, upstream of anywhere
 * `U7` could recover it.
 */
test('an optional boolean keeps its three states distinguishable', async () => {
  const seeded = async (value: boolean | null | undefined) =>
    controlFor(
      await everyKindFormHtml(
        COMPILER_SEMANTIC_PROFILE_V2_VERSION,
        (executor) =>
          executor.seedValues(
            tenantA,
            value === undefined ? {} : { [EVERY_KIND_FIELD_IDS.active]: value },
          ),
      ),
      EVERY_KIND_FIELD_IDS.active,
    );

  const absent = await seeded(undefined);
  const explicitNull = await seeded(null);
  const no = await seeded(false);
  const yes = await seeded(true);

  // No hidden sibling anywhere: nothing posts a value the record did not have.
  for (const control of [absent, explicitNull, no, yes]) {
    assert.doesNotMatch(control, /type="hidden"/u);
    assert.doesNotMatch(control, /type="checkbox"/u);
    assert.match(control, /<select [^>]*><option value=""><\/option>/u);
  }
  // Absent and null both select the blank; false and true select their own.
  assert.doesNotMatch(absent, /selected/u);
  assert.doesNotMatch(explicitNull, /selected/u);
  assert.match(no, /<option value="false" selected>No<\/option>/u);
  assert.doesNotMatch(no, /<option value="true" selected>/u);
  assert.match(yes, /<option value="true" selected>Yes<\/option>/u);
  assert.doesNotMatch(yes, /<option value="false" selected>/u);
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
      operationId,
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

const CHILD_FORM_SURFACE = `${FIXTURE_IDS.namespace}:surface.master_role_form`;
const CHILD_CREATE_OPERATION = `${FIXTURE_IDS.namespace}:operation.master_role_create`;
const REQUIRED_RELATION_ID = `${FIXTURE_IDS.namespace}:relation.master_role_parent`;

/**
 * The write wire this whole re-charter exists to reach: `operationInput` builds
 * a `relations` key, so a create through a REQUIRED relation is satisfiable.
 * Before it, no module with a required relation could be created from any web
 * surface -- and `master_role_parent` has declared `required: true` since long
 * before this packet.
 *
 * Rendering the control is `relation-scoped-enumeration`'s, so this posts the
 * relation directly rather than reading it off a form.
 */
test('a create submission carries its relations into the operation input', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const parentRecordId = executor.seed(tenantA, 'Northwind');
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );

  await submitSurfaceRuntimeIntent(
    view,
    `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`,
    {
      idempotencyKey: randomUUID(),
      operationId: CHILD_CREATE_OPERATION,
      recordId: randomUUID(),
      [`relation:${REQUIRED_RELATION_ID}`]: parentRecordId,
      [`value:${FIXTURE_IDS.fieldIds.childRole}`]: FIXTURE_IDS.optionIds.owner,
    },
    semanticGateways(policy, executor),
  );

  assert.equal(
    executor.operationCalls.length,
    1,
    'the create must execute rather than refuse',
  );
  const input = asRecord(executor.operationCalls[0]!.input);
  assert.deepEqual(
    input.relations,
    { [REQUIRED_RELATION_ID]: parentRecordId },
    'the relation must arrive keyed by relation id, carrying the chosen record',
  );
});

/**
 * An unselected relation is OMITTED, not sent as "". Posting "" would reach the
 * provider's `uuidRecord` and fail as a malformed uuid, which is a different
 * and less honest refusal than the declared MODULE_REQUIRED_RELATION_MISSING.
 */
test('an empty relation selection is omitted rather than sent as a blank', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );

  await submitSurfaceRuntimeIntent(
    view,
    `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`,
    {
      idempotencyKey: randomUUID(),
      operationId: CHILD_CREATE_OPERATION,
      recordId: randomUUID(),
      [`relation:${REQUIRED_RELATION_ID}`]: '',
      [`value:${FIXTURE_IDS.fieldIds.childRole}`]: FIXTURE_IDS.optionIds.owner,
    },
    semanticGateways(policy, executor),
  );

  if (executor.operationCalls.length > 0) {
    const input = asRecord(executor.operationCalls[0]!.input);
    assert.deepEqual(
      input.relations,
      {},
      'a blank selection contributes no relation key at all',
    );
  }
});

/**
 * Entity relation authority must be AGREEMENT, not cardinality. The prior
 * attempt took whichever create contract declared the most relations, so a
 * retired operation could outrank the executing one and the browser would post
 * a contract the provider does not honour.
 */
test('create contracts declaring different relations refuse rather than resolve by size', async () => {
  const policy = new RecordingPolicy('ALLOW');
  const compiled = compileFixture();
  const projections = runtimeProjections(compiled);

  const withSecondCreate = (
    mutateClone: (clone: Record<string, unknown>) => void,
  ): ImmutableJsonValue => {
    const payload = structuredClone(projections.operation.payload) as {
      operations: Record<string, unknown>[];
    };
    const original = payload.operations.find(
      (operation) => operation.operationId === CHILD_CREATE_OPERATION,
    );
    assert.ok(original, 'the fixture must contribute a child create operation');
    const clone = structuredClone(original) as Record<string, unknown>;
    clone.operationId = `${CHILD_CREATE_OPERATION}_retired`;
    clone.lifecycle = 'retired';
    mutateClone(clone);
    payload.operations.push(clone);
    return payload as unknown as ImmutableJsonValue;
  };

  const read = async (payload: ImmutableJsonValue) => {
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
              operation: { ...projections.operation, payload },
            },
            release: { contentHash: compiled.releaseRoot, releaseId },
            tenantId: context.tenantId,
          };
        },
      },
      policy,
    );
    const view = await issuedView(entry, 'a');
    const manifest = readCompiledSurfaceManifest(view);
    const surface = manifest.surfaces.find(
      (candidate) => candidate.surfaceId === CHILD_FORM_SURFACE,
    );
    assert.ok(surface);
    return readCompiledSurfaceDataBinding(view, surface);
  };

  // ADMISSION TWIN: a second create declaring the SAME relations is agreement,
  // not disagreement, and must still bind.
  const agreeing = await read(withSecondCreate(() => undefined));
  assert.equal(agreeing.relationInputs.status, 'known');
  assert.deepEqual(
    agreeing.relationInputs.status === 'known'
      ? agreeing.relationInputs.relationInputs.map(
          (relation) => relation.relationId,
        )
      : [],
    [REQUIRED_RELATION_ID],
    'identical create contracts agree and the entity keeps its relations',
  );

  await assert.rejects(
    read(
      withSecondCreate((clone) => {
        (clone.inputContract as Record<string, unknown>).relationInputs = [];
        (clone.inputContract as Record<string, unknown>).closedArgumentKeys = [
          'recordId',
          'values',
        ];
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SurfaceProjectionError);
      assert.equal(error.code, 'INVALID_SURFACE_BINDING');
      return true;
    },
    'disagreeing create contracts must refuse by name, not pick the longer one',
  );
});

/**
 * Browser/gateway contract PARITY. Raised in review: the browser called only the
 * relation-entry parser, so every effect-aware rule -- relations are
 * create-only, v3/v4 are create-only, the `relations` closed key agrees with the
 * effect -- was applied by the gateway alone. One pinned artifact then had two
 * interpretations: bindable at the surface, malformed at execution.
 *
 * Each case mutates exactly one gateway-only condition and asserts the BROWSER
 * refuses before rendering or submission.
 */
test('the browser refuses every contract the gateway refuses', async () => {
  const policy = new RecordingPolicy('ALLOW');
  const compiled = compileFixture();
  const projections = runtimeProjections(compiled);

  const forge = (
    mutate: (operation: Record<string, unknown>) => void,
  ): ImmutableJsonValue => {
    const payload = structuredClone(projections.operation.payload) as {
      operations: Record<string, unknown>[];
    };
    const operation = payload.operations.find(
      (candidate) => candidate.operationId === CHILD_CREATE_OPERATION,
    );
    assert.ok(
      operation,
      'the fixture must contribute a child create operation',
    );
    mutate(operation);
    return payload as unknown as ImmutableJsonValue;
  };

  const read = async (payload: ImmutableJsonValue) => {
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
              operation: { ...projections.operation, payload },
            },
            release: { contentHash: compiled.releaseRoot, releaseId },
            tenantId: context.tenantId,
          };
        },
      },
      policy,
    );
    const view = await issuedView(entry, 'a');
    const manifest = readCompiledSurfaceManifest(view);
    const surface = manifest.surfaces.find(
      (candidate) => candidate.surfaceId === CHILD_FORM_SURFACE,
    );
    assert.ok(surface);
    return readCompiledSurfaceDataBinding(view, surface);
  };

  // ADMISSION TWIN: the unmutated catalog must bind.
  const baseline = await read(forge(() => undefined));
  assert.equal(baseline.relationInputs.status, 'known');

  const refusals: ReadonlyArray<
    readonly [string, (operation: Record<string, unknown>) => void]
  > = [
    [
      'relations declared on an update effect',
      (operation) => {
        (operation.effect as Record<string, unknown>).kind =
          'updateRecordEffect';
      },
    ],
    [
      'a create contract omitting the relations closed key',
      (operation) => {
        (
          operation.inputContract as Record<string, unknown>
        ).closedArgumentKeys = ['recordId', 'values'];
      },
    ],
    [
      'a duplicated relation identity',
      (operation) => {
        const contract = operation.inputContract as Record<string, unknown>;
        const relations = contract.relationInputs as unknown[];
        contract.relationInputs = [relations[0], structuredClone(relations[0])];
      },
    ],
  ];

  for (const [reason, mutate] of refusals) {
    await assert.rejects(
      read(forge(mutate)),
      (error: unknown) => {
        assert.ok(
          error instanceof SurfaceProjectionError,
          `${reason}: the BROWSER must refuse, got ${String(error)}`,
        );
        return true;
      },
      reason,
    );
  }
});

/**
 * Raised in review: an entity with NO create operation has no authority for its
 * relations, and reporting `[]` there is a positive assertion the reader cannot
 * support -- indistinguishable from an entity whose create declares none.
 */
test('an entity with no create operation reports unavailable, not empty', async () => {
  const policy = new RecordingPolicy('ALLOW');
  const compiled = compileFixture();
  const projections = runtimeProjections(compiled);

  const withoutCreate = structuredClone(projections.operation.payload) as {
    operations: Record<string, unknown>[];
  };
  withoutCreate.operations = withoutCreate.operations.filter(
    (operation) => operation.operationId !== CHILD_CREATE_OPERATION,
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
              payload: withoutCreate as unknown as ImmutableJsonValue,
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
  const manifest = readCompiledSurfaceManifest(view);
  const surface = manifest.surfaces.find(
    (candidate) => candidate.surfaceId === CHILD_FORM_SURFACE,
  );
  assert.ok(surface);

  assert.equal(
    readCompiledSurfaceDataBinding(view, surface).relationInputs.status,
    'unavailable',
    'no create operation means no authority, which is not the same as none',
  );

  // ADMISSION TWIN: with the create operation present the same tree is `known`,
  // so this cannot pass against a reader that always reports unavailable.
  const withCreate = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  assert.equal(
    readCompiledSurfaceDataBinding(withCreate, surface).relationInputs.status,
    'known',
  );
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

  /**
   * Seeds a record carrying real typed values. `seed` above stores one string,
   * which is enough for a title but cannot express a JSON `true` -- and a
   * checkbox that renders `checked` only for a boolean cannot be observed
   * against a record whose boolean is the string "true".
   */
  seedValues(
    tenantId: string,
    values: Readonly<Record<string, ImmutableJsonValue>>,
  ): string {
    const recordId = randomUUID();
    this.tenantRecords(tenantId).set(
      recordId,
      Object.freeze({
        archived: false,
        entityId: FIXTURE_IDS.entityIds.parent,
        recordId,
        revision: 1,
        values: Object.freeze({ ...values }),
      }),
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
      ? { ...result, listCoverage: listCoverage(request, records.length) }
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
): NonNullable<SemanticQueryResultEnvelope['listCoverage']> {
  assert.ok(request.list);
  return Object.freeze({
    effectivePageSize: request.list.query.effectivePageSize,
    hasMore: false,
    includeArchived: request.list.query.includeArchived,
    matchMode: request.list.query.matchMode,
    nextCursor: null,
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
  // Defaults to whatever the profile constant carries, so every existing caller
  // keeps compiling exactly as before. Passed explicitly only by the field-kind
  // tests, which need the unadopted v2 -- nothing they compile is recorded, so
  // no lineage entry is minted (ADR-0047 §4a).
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

/**
 * The refusal half of `INTENT_RENDERED_ARITY`, run as a table over all four
 * singular intents and asserted on the CODE rather than on a rendered page.
 *
 * The browser arm this supplements exercised `create` alone and observed a
 * page-level `QUERY_UNSUPPORTED`, so three holes stayed green: a per-intent
 * exemption (`intent !== 'update' && bound > arity`), the same independently
 * for `archive` and `restore`, and a bare `throw` swapped in for
 * `invalidBinding(...)`. `QUERY_UNSUPPORTED` is what the runtime renders for
 * ANY unreadable binding, so it cannot tell those apart.
 *
 * Each intent carries its admission twin, because a refusal control alone is
 * satisfiable by refusing everything (`review-tiers`, af44c6f).
 */
for (const intent of ['archive', 'create', 'restore', 'update'] as const) {
  test(`a second active ${intent} operation is refused by name, and one is admitted`, async () => {
    const operationId = `${FIXTURE_IDS.namespace}:operation.master_${intent}`;

    // Admission twin first: the un-duplicated package binds, and binds exactly
    // one operation of this intent. Without it the refusal below would prove
    // nothing about the intent it names.
    const admitted = await masterRecordBinding(compileFixture());
    assert.equal(
      admitted.operations.filter((operation) => operation.intent === intent)
        .length,
      1,
      `${intent} is not bound at all, so its refusal is untested`,
    );

    const duplicated = ordinaryModuleV1();
    const operations = duplicated.operations as Array<Record<string, unknown>>;
    const original = operations.find(
      (candidate) => candidate.operationId === operationId,
    );
    assert.ok(original, `${operationId} is absent from the fixture`);
    operations.push({ ...original, operationId: `${operationId}_alternate` });

    await assert.rejects(
      async () => masterRecordBinding(compileFixture(duplicated)),
      (error: unknown) => {
        assert.ok(
          error instanceof SurfaceProjectionError,
          `${intent}: threw ${String(error)}, not a SurfaceProjectionError`,
        );
        assert.equal(error.code, 'INVALID_SURFACE_BINDING');
        assert.match(error.message, new RegExp(`\\b${intent}\\b`));
        return true;
      },
    );
  });
}

/**
 * THE PACKET'S OWN PREMISE, executable for the first time on this tree.
 *
 * `PUR-1`'s shape is a document carrying a release AND a cancel. Both are
 * `transitionStateEffect`, and `operationIntent` maps both to `command` — the
 * exact collision this packet lifted. It could not be written before: `v5` cut
 * the state machine (`5g3-sm`) and this packet keyed the binding by operation
 * id, and only the merge of the two has both.
 *
 * The capability-pair arm in the browser suite exercises the same mechanism
 * through the other effect kind. This one is the real subject.
 */
test('two transitions on one entity bind as two commands, each addressable', async () => {
  const binding = await masterRecordBinding(
    compileFixture(twoTransitionPackage()),
  );
  const commands = binding.operations.filter(
    (operation) => operation.intent === 'command',
  );

  assert.deepEqual(
    commands.map((operation) => operation.operationId),
    [
      `${FIXTURE_IDS.namespace}:operation.master_cancel`,
      `${FIXTURE_IDS.namespace}:operation.master_release`,
    ],
    'both transitions must bind, and deterministically ordered',
  );
  // Distinct ids are what makes them separately addressable; distinct labels
  // are what makes them separately pressable. Both are required and neither
  // implies the other.
  assert.deepEqual(
    commands.map((operation) => operation.label),
    ['Cancel', 'Release'],
  );
  // A transition is not a capability, so the command bar's standing
  // explanation differs — the half of the merge `5g3-sm` owns.
  assert.deepEqual(
    commands.map((operation) => operation.capabilityId),
    [null, null],
  );
});

/**
 * THE CONFLICT RESOLUTION ITSELF, which the binding assertion above does not
 * reach — REVISE round 2.
 *
 * That test stops at the premise: transitions arrive with `capabilityId: null`.
 * The reviewer disproved it as evidence with the right instrument — revert
 * `component-registry.ts` to either parent and it stays green. Restoring the
 * `34f452e` half keeps `operationId` addressing while rendering "Draft staged"
 * for both transitions; restoring the `eb02adf` half keeps the transition
 * explanation while posting a shared `intent=command`. Neither revert is
 * noticed, so neither half was under test.
 *
 * `renderCapabilityCommand` merged both halves, so both must be observed on
 * the SAME rendered forms: the addressing (`34f452e`) and the effect-sensitive
 * explanation (`eb02adf`). Each assertion below has a presence arm and an
 * absence arm, because "the new thing is here" does not exclude "the old thing
 * is also here" — which is precisely how a half-reverted merge stays green.
 */
test('the merged command bar renders both halves on the same two transition forms', async () => {
  const compiled = compileFixture(twoTransitionPackage());
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const recordId = executor.seed(tenantA, 'Draft');
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const rendered = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_record`)}&record=${encodeURIComponent(recordId)}`,
    semanticGateways(policy, executor),
  );
  assert.equal(rendered.statusCode, 200);
  const html = rendered.html;

  const forms = [
    ...html.matchAll(/<form class="capability-command"[\s\S]*?<\/form>/g),
  ].map((match) => match[0]);
  assert.equal(forms.length, 2, 'both transitions must render their own form');

  const namespace = FIXTURE_IDS.namespace;
  for (const action of ['cancel', 'release']) {
    const operationId = `${namespace}:operation.master_${action}`;
    const form = forms.find((candidate) => candidate.includes(operationId));
    assert.ok(form, `no form addresses ${operationId}`);

    // 34f452e's half: each form names its own operation on the wire...
    assert.match(
      form,
      new RegExp(
        `<input type="hidden" name="operationId" value="${operationId}">`,
      ),
    );
    // ...and the shared intent addressing it replaced is gone. Without this
    // arm, a form carrying BOTH would pass — and both is what a partial
    // revert produces.
    assert.doesNotMatch(form, /name="intent"/);

    // eb02adf's half: a transition stages no draft, so it must not claim to.
    assert.match(
      form,
      /<strong>Ready\.<\/strong> This moves the record to its next state\./,
    );
    assert.doesNotMatch(form, /Draft staged/);
  }

  // Distinct labels and deterministic order, on the rendered page rather than
  // on the binding: the two controls must be separately pressable, not merely
  // separately addressable.
  const labels = forms.map(
    (form) => /<button type="submit">([^<]+)<\/button>/.exec(form)?.[1],
  );
  assert.deepEqual(labels, ['Cancel', 'Release']);
});

/** `ordinaryModuleV1` restamped at v5, carrying a two-transition machine. */
function twoTransitionPackage(): Record<string, unknown> {
  const version = 'v5';
  const reference = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: version,
    targetId,
  });
  // Node-version purity is uniform within a package revision, so a v5 machine
  // in a v3 package is refused: the whole package is restamped.
  const restamp = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(restamp);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
          key,
          key === 'schemaVersion' ? version : restamp(inner),
        ]),
      );
    }
    return value;
  };
  const definition = restamp(ordinaryModuleV1()) as Record<string, unknown>;
  definition.languageVersion = version;

  // The record surface needs a command bar for the two transitions to have
  // anywhere to render. `entitySurfaces` gives each surface one slot.
  const recordSurface = (
    definition.surfaces as Array<Record<string, unknown>>
  ).find(
    (surface) =>
      surface.surfaceId === `${FIXTURE_IDS.namespace}:surface.master_record`,
  );
  assert.ok(recordSurface && Array.isArray(recordSurface.slots));
  recordSurface.slots.push({
    content: {
      kind: 'opaqueSurfaceContentReference',
      schemaVersion: version,
      targetId: FIXTURE_IDS.contentCapabilityId,
    },
    kind: 'surfaceSlot',
    orderKey: 20,
    schemaVersion: version,
    slot: 'commandBar',
    slotId: `${FIXTURE_IDS.namespace}:slot.master_record_command_bar`,
  });

  const namespace = FIXTURE_IDS.namespace;
  const entityId = FIXTURE_IDS.entityIds.parent;
  const draft = `${namespace}:state.master_draft`;
  const moves = [
    {
      action: 'release',
      orderKey: 10,
      to: `${namespace}:state.master_released`,
    },
    {
      action: 'cancel',
      orderKey: 20,
      to: `${namespace}:state.master_cancelled`,
    },
  ];

  definition.stateMachines = [
    {
      entity: reference('entityReference', entityId),
      initialState: reference('stateReference', draft),
      kind: 'stateMachineDefinition',
      machineId: `${namespace}:machine.master_lifecycle`,
      schemaVersion: version,
      states: [
        {
          kind: 'stateDefinition',
          label: 'Draft',
          orderKey: 10,
          schemaVersion: version,
          stateId: draft,
        },
        ...moves.map((move, index) => ({
          kind: 'stateDefinition',
          label: move.action,
          orderKey: 20 + index * 10,
          schemaVersion: version,
          stateId: move.to,
        })),
      ],
      transitions: moves.map((move) => ({
        fromState: reference('stateReference', draft),
        kind: 'transitionDefinition',
        label: `${move.action} master`,
        orderKey: move.orderKey,
        // ADR-0050 §7: a transition's permission must EQUAL its operation's,
        // refused at compile time as COMPILER_TRANSITION_PERMISSION_MISMATCH.
        permission: reference(
          'permissionReference',
          `${namespace}:permission.master_${move.action}`,
        ),
        schemaVersion: version,
        toState: reference('stateReference', move.to),
        transitionId: `${namespace}:transition.master_${move.action}`,
      })),
    },
  ];

  for (const move of moves) {
    (definition.permissions as unknown[]).push({
      action: 'transition',
      kind: 'permissionDefinition',
      label: `master ${move.action}`,
      permissionId: `${namespace}:permission.master_${move.action}`,
      resource: reference('entityReference', entityId),
      schemaVersion: version,
    });
    (definition.operations as unknown[]).push({
      confirmation: 'none',
      effect: {
        kind: 'transitionStateEffect',
        schemaVersion: version,
        transition: reference(
          'transitionReference',
          `${namespace}:transition.master_${move.action}`,
        ),
      },
      kind: 'operationDefinition',
      module: reference('moduleReference', FIXTURE_IDS.moduleId),
      operationId: `${namespace}:operation.master_${move.action}`,
      permission: reference(
        'permissionReference',
        `${namespace}:permission.master_${move.action}`,
      ),
      readBack: reference('queryReference', `${namespace}:query.master_get`),
      schemaVersion: version,
      tier: 'o0',
    });
  }
  return definition;
}

/** Reads the master record surface's binding out of a compiled fixture. */
async function masterRecordBinding(
  compiled: CompileSuccess,
): Promise<CompiledSurfaceDataBinding> {
  const policy = new RecordingPolicy('ALLOW');
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const surface = readCompiledSurfaceManifest(view).surfaces.find(
    (candidate) =>
      candidate.surfaceId === `${FIXTURE_IDS.namespace}:surface.master_record`,
  );
  assert.ok(surface);
  return readCompiledSurfaceDataBinding(view, surface);
}

/**
 * ADR-0051 §4's structural boundary, tested where it is enforced rather than
 * where it is described. The helper cannot see a submission, so the only way
 * the gateway's `operationId` can be wrong is for the resolved operation to be
 * wrong -- which is what `boundOperation` and the ratchet hold.
 */
test('the gateway request carries the resolved operation id and nothing from the wire', () => {
  const operation = Object.freeze({
    capabilityId: null,
    confirmation: 'none' as const,
    intent: 'command' as const,
    label: 'Release',
    operationId: `${FIXTURE_IDS.namespace}:operation.master_release`,
    precondition: Object.freeze({}),
  });
  const input = { expectedRevision: 1, recordId: 'r-1' };

  const request = semanticOperationRequestFor(operation, input, null, 'k-1');
  assert.equal(request.operationId, operation.operationId);
  assert.deepEqual(Object.keys(request).sort(), [
    'confirmationGrant',
    'idempotencyKey',
    'input',
    'operationId',
    'schemaVersion',
  ]);
  assert.equal(Object.isFrozen(request), true);

  // The leak the argument list makes inexpressible: an `input` carrying its
  // own `operationId` cannot reach the envelope, because nothing spreads it.
  const hostile = semanticOperationRequestFor(
    operation,
    { ...input, operationId: 'northstar.forged:operation.evil' },
    null,
    'k-2',
  );
  assert.equal(hostile.operationId, operation.operationId);
});

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
