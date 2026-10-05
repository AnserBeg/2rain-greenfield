import {
  inventoryValuationReadModel,
  commercialReadModelWithInventoryCost,
} from '../../packages/postgres-provider/src/inventory-valuation-read-model.js';
import type { SurfaceComposition } from '../../packages/canonical-model/src/index.js';
import { documentEditor } from '../../apps/web/src/document-editor.js';
import {
  resolveWorkspaceEntry,
  workspaceSearch,
} from '../../apps/web/src/workspace-entry.js';
import {
  loadSurfaceComposition,
  submitCompositionAction,
  renderCompositionFields,
  renderCompositionHeader,
  renderCompositionChildren,
  renderCompositionActions,
} from '../../apps/web/src/surface-composition.js';
import assert from 'node:assert/strict';
import { CanonicalModelError } from '@north-star/canonical-model';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import test from 'node:test';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';

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
  ModuleRuntimeInterpreterError,
  relationTargetPlans,
} from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { fulfillmentProjectionIdentity } from '../../packages/postgres-provider/src/fulfillment.js';
import { fulfillmentReadModel } from '../../packages/postgres-provider/src/fulfillment-read-model.js';
import { commercialReadModel } from '../../packages/postgres-provider/src/commercial-read-model.js';
import { purchaseOrderApprovalInput } from '../../packages/postgres-provider/src/purchase-order-approval-executor.js';
import { encodeSharedListCursor } from '../../packages/runtime/src/list-behavior/index.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SEMANTIC_OPERATION_RESULT_VERSION,
  SemanticOperationGateway,
  parsePinnedOperationCatalog,
  SemanticOperationMediationAuthority,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationExecutionRequest,
  type SemanticOperationExecutor,
  type SemanticOperationNonAcceptedRequest,
  type SemanticOperationResultEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  MalformedSemanticQueryRequestError,
  SEMANTIC_QUERY_RESULT_VERSION,
  SEMANTIC_QUERY_REQUEST_VERSION,
  registeredSemanticQueryFromPinnedView,
  SemanticQueryGateway,
  SemanticQueryPolicyDeniedError,
  type SemanticQueryExecutionRequest,
  type SemanticQueryExecutor,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  trustedContextForRequestRuntimeView,
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
import { renderSurfaceDataComponent } from '../../apps/web/src/component-registry.js';
import {
  declaredListArguments,
  readDeclaredListState,
} from '../../apps/web/src/list-declaration.js';
import {
  renderSurfaceRuntimeWithData,
  semanticOperationRequestFor,
  submitSurfaceRuntimeIntent,
  type SurfaceRuntimeGateways,
} from '../../apps/web/src/surface-runtime.js';
import {
  SurfaceProjectionError,
  pickerEnumerationQuery,
  readCompiledSurfaceDataBinding,
  readCompiledSurfaceManifest,
  type CompiledSurfaceDataBinding,
} from '../../apps/web/src/surface-contract.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
} from '../fixtures/g2/module-conformance/definitions.js';
import { governedStorageTarget } from '../helpers/governed-storage-target.js';
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

test('the compatibility list derives field prefixes from record identity', async () => {
  const definition = ordinaryModuleV1();
  const compatibilitySurfaceId = `${FIXTURE_IDS.namespace}:surface.receipts_queue_list`;
  const surfaces = definition.surfaces as Array<Record<string, unknown>>;
  const authoredList = surfaces.find(
    (surface) =>
      surface.surfaceId === `${FIXTURE_IDS.namespace}:surface.master_list`,
  );
  assert.ok(authoredList);
  authoredList.label = 'A/P receipts list';
  authoredList.surfaceId = compatibilitySurfaceId;

  const compiled = compileFixture(definition);
  const policy = new RecordingPolicy('ALLOW');
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const surface = readCompiledSurfaceManifest(view).surfaces.find(
    (candidate) => candidate.surfaceId === compatibilitySurfaceId,
  );
  assert.ok(surface);

  const html = renderSurfaceDataComponent({
    data: {
      records: [
        record(
          'a6000000-0000-4000-8000-000000000006',
          'Compatibility specimen',
          FIXTURE_IDS.entityIds.parent,
        ),
      ],
      status: 'READY',
    },
    feedback: null,
    operations: [],
    surface,
  });

  assert.match(html, /<h2>A\/P receipts<\/h2>/u);
  assert.match(html, /<th scope="col">Name<\/th>/u);
  assert.doesNotMatch(html, /Master name|Receipts queue name/u);
});

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
      [`empty:${FIXTURE_IDS.fieldIds.parentName}`]: 'emptyText',
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
  assert.match(result.html, /INVALID_SURFACE_BINDING/);
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
    [`empty:${FIXTURE_IDS.fieldIds.parentName}`]: 'emptyText',
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
const DIVERGENT_CHILD_FORM_SURFACE = `${FIXTURE_IDS.namespace}:surface.rfq_assignment_form`;
const CHILD_CREATE_OPERATION = `${FIXTURE_IDS.namespace}:operation.master_role_create`;
const CHILD_UPDATE_OPERATION = `${FIXTURE_IDS.namespace}:operation.master_role_update`;
const REQUIRED_RELATION_ID = `${FIXTURE_IDS.namespace}:relation.master_role_parent`;

function fixtureWithRefusingChildUpdate(): Record<string, unknown> {
  const definition = fixtureWithChildFormAnatomy();
  assert.ok(Array.isArray(definition.operations));
  const update = definition.operations.find(
    (operation) => operation.operationId === CHILD_UPDATE_OPERATION,
  );
  assert.ok(update, 'the fixture must contribute a child update operation');
  assert.equal(
    update.precondition,
    undefined,
    'the refusal specimen must vary only the update precondition',
  );
  update.precondition = {
    field: {
      kind: 'fieldReference',
      schemaVersion: 'v3',
      targetId: FIXTURE_IDS.fieldIds.childRole,
    },
    kind: 'fieldComparisonPredicate',
    operator: 'equals',
    schemaVersion: 'v3',
    value: {
      kind: 'textValue',
      schemaVersion: 'v3',
      value: FIXTURE_IDS.optionIds.buyer,
    },
  };
  return definition;
}

function fixtureWithChildFormAnatomy(): Record<string, unknown> {
  const definition = ordinaryModuleV1();
  assert.ok(Array.isArray(definition.surfaces));
  const form = definition.surfaces
    .map(asRecord)
    .find((surface) => surface.surfaceId === CHILD_FORM_SURFACE);
  assert.ok(form && Array.isArray(form.slots));
  assert.equal(
    form.slots.length,
    1,
    'the baseline fixture must isolate the sections-only survivor',
  );
  const section = asRecord(form.slots[0]);
  form.slots = (
    [
      ['breadcrumb', 10],
      ['titleStatus', 20],
      ['commandBar', 30],
      ['keyFacts', 40],
      ['sections', 50],
    ] as const
  ).map(([slot, orderKey]) => ({
    ...structuredClone(section),
    orderKey,
    slot,
    slotId: `${FIXTURE_IDS.namespace}:slot.master_role_form_${String(orderKey)}`,
  }));
  return definition;
}

function fixtureWithDivergentChildForm(): Record<string, unknown> {
  const definition = fixtureWithChildFormAnatomy();
  assert.ok(Array.isArray(definition.surfaces));
  const form = definition.surfaces
    .map(asRecord)
    .find((surface) => surface.surfaceId === CHILD_FORM_SURFACE);
  assert.ok(form);
  form.label = 'RFQ & R&D assignment form';
  form.surfaceId = DIVERGENT_CHILD_FORM_SURFACE;
  return definition;
}

test('a required relation renders a complete target list as a native picker', async () => {
  const compiled = compileFixture(fixtureWithDivergentChildForm());
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const parentRecordId = executor.seed(tenantA, 'Northwind supplier');
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );

  const rendered = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(DIVERGENT_CHILD_FORM_SURFACE)}`,
    semanticGateways(policy, executor),
  );

  assert.equal(rendered.statusCode, 200);
  assert.match(rendered.html, /<form id="surface-record-form"/u);
  assert.match(
    rendered.html,
    new RegExp(
      `<select name="relation:${REQUIRED_RELATION_ID}"[^>]* required>`,
      'u',
    ),
  );
  assert.match(rendered.html, /<span>Parent<\/span><select/u);
  assert.doesNotMatch(
    rendered.html,
    /Master role parent|RFQ R&amp;D assignment parent/u,
  );
  assert.match(
    rendered.html,
    new RegExp(
      `<option value="${parentRecordId}">Northwind supplier</option>`,
      'u',
    ),
  );
  assert.doesNotMatch(rendered.html, /<script\b/iu);
});

test('a scoped target list receives the selected entity under its own declared operand', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  executor.seed(tenantA, 'Scoped supplier');
  const sourceScopeParameterId = `${FIXTURE_IDS.namespace}:parameter.master_role_get_scope`;
  const targetScopeParameterId = `${FIXTURE_IDS.namespace}:parameter.master_list_scope`;
  const legalEntityId = 'af000000-0000-4000-8000-00000000000f';
  const view = await issuedView(
    runtimeEntry(
      compiled,
      policy,
      { a: identity(tenantA, environmentA, principalA) },
      (projections) =>
        scopedRelationProjections(
          projections,
          sourceScopeParameterId,
          targetScopeParameterId,
        ),
    ),
    'a',
  );

  const rendered = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}&${encodeURIComponent(sourceScopeParameterId)}=${legalEntityId}`,
    semanticGateways(policy, executor),
  );

  assert.equal(rendered.statusCode, 200);
  assert.match(rendered.html, new RegExp(`relation:${REQUIRED_RELATION_ID}`));
  const targetCall = executor.queryCalls.find(
    (call) =>
      call.definition.queryId === `${FIXTURE_IDS.namespace}:query.master_list`,
  );
  assert.ok(targetCall, 'the declared target list query must execute');
  const targetArguments = asRecord(targetCall.arguments);
  assert.equal(targetArguments[targetScopeParameterId], legalEntityId);
  assert.equal(
    Object.hasOwn(targetArguments, sourceScopeParameterId),
    false,
    'the target query receives its own declared key, not the source form key',
  );
});

test('hasMore refuses a relation picker while truncation alone does not', async () => {
  const compiled = compileFixture(fixtureWithChildFormAnatomy());
  const policy = new RecordingPolicy('ALLOW');
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const parent = record(
    randomUUID(),
    'Bounded supplier',
    FIXTURE_IDS.entityIds.parent,
  );
  const renderWithCoverage = (hasMore: boolean, truncatedByMaximum: boolean) =>
    renderSurfaceRuntimeWithData(
      view,
      `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`,
      {
        operationGateway: new SemanticOperationGateway(
          policy,
          new InMemoryGenericExecutor(),
        ),
        operationMediation: new SemanticOperationMediationAuthority(),
        queryGateway: fixedQueryGateway(
          'exact',
          [parent],
          (request, count) => ({
            ...listCoverage(request, count),
            hasMore,
            nextCursor: hasMore ? 'next-page-exists' : null,
            totalCount: count + (hasMore ? 1 : 0),
            truncatedByMaximum,
          }),
        ),
      },
    );

  const complete = await renderWithCoverage(false, false);
  assert.match(complete.html, /<form id="surface-record-form"/u);
  assert.match(complete.html, /data-platform-slot="record:commandBar"/u);
  assert.match(
    complete.html,
    /<button[^>]+form="surface-record-form"[^>]*>Save<\/button>/u,
  );

  const incomplete = await renderWithCoverage(true, false);
  assert.match(
    incomplete.html,
    /data-diagnostic-code="RELATION_ENUMERATION_UNAVAILABLE"/u,
  );
  assert.match(
    incomplete.html,
    new RegExp(`<code data-message-subject>${REQUIRED_RELATION_ID}</code>`),
  );
  assert.doesNotMatch(incomplete.html, /<form id="surface-record-form"/u);
  assert.doesNotMatch(
    incomplete.html,
    new RegExp(`<select name="relation:${REQUIRED_RELATION_ID}"`),
  );
  const incompleteCommandBar = incomplete.html.match(
    /<div\b[^>]*data-platform-slot="record:commandBar"[^>]*>[\s\S]*?<\/div>/u,
  );
  assert.ok(incompleteCommandBar);
  assert.match(incompleteCommandBar[0], /data-slot-state="ready"/u);
  assert.doesNotMatch(
    incompleteCommandBar[0],
    /<button\b[^>]*>\s*Save\s*<\/button>/u,
  );
  assert.doesNotMatch(incompleteCommandBar[0], /COMPONENT_RENDER_FAILED/u);

  const clampedButComplete = await renderWithCoverage(false, true);
  assert.match(clampedButComplete.html, /<form id="surface-record-form"/u);
  assert.match(
    clampedButComplete.html,
    /<button[^>]+form="surface-record-form"[^>]*>Save<\/button>/u,
  );
  assert.match(
    clampedButComplete.html,
    new RegExp(`relation:${REQUIRED_RELATION_ID}`),
  );
  assert.doesNotMatch(
    clampedButComplete.html,
    /RELATION_ENUMERATION_UNAVAILABLE/u,
  );

  const completeEmpty = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`,
    {
      operationGateway: new SemanticOperationGateway(
        policy,
        new InMemoryGenericExecutor(),
      ),
      operationMediation: new SemanticOperationMediationAuthority(),
      queryGateway: fixedQueryGateway('exact', []),
    },
  );
  assert.match(completeEmpty.html, /<form id="surface-record-form"/u);
  assert.match(
    completeEmpty.html,
    new RegExp(
      `<select name="relation:${REQUIRED_RELATION_ID}"[^>]* required>`,
    ),
  );
  const emptyRelationSelect = completeEmpty.html.match(
    new RegExp(
      `<select name="relation:${REQUIRED_RELATION_ID}"[^>]*>(.*?)</select>`,
      'u',
    ),
  );
  assert.ok(emptyRelationSelect);
  assert.doesNotMatch(
    emptyRelationSelect[1]!,
    new RegExp(`<option value="[^"]+">`),
    'an empty but complete result renders no invented target and is not an enumeration refusal',
  );
});

test('a targetless optional relation renders nothing while a required one refuses by name', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const render = async (required: boolean) => {
    const executor = new InMemoryGenericExecutor();
    const view = await issuedView(
      runtimeEntry(
        compiled,
        policy,
        { a: identity(tenantA, environmentA, principalA) },
        (projections) => targetlessRelationProjections(projections, required),
      ),
      'a',
    );
    return {
      executor,
      response: await renderSurfaceRuntimeWithData(
        view,
        `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`,
        semanticGateways(policy, executor),
      ),
    };
  };

  const optional = await render(false);
  assert.match(optional.response.html, /<form id="surface-record-form"/u);
  assert.doesNotMatch(
    optional.response.html,
    /class="form-field relation-picker"/u,
  );
  assert.equal(
    optional.executor.queryCalls.length,
    0,
    'a targetless optional relation must not invent a query or a None-only picker',
  );

  const required = await render(true);
  assert.match(
    required.response.html,
    /data-diagnostic-code="RELATION_ENUMERATION_UNAVAILABLE"/u,
  );
  assert.match(
    required.response.html,
    new RegExp(`<code data-message-subject>${REQUIRED_RELATION_ID}</code>`),
  );
  assert.doesNotMatch(
    required.response.html,
    /<form id="surface-record-form"/u,
  );
});

test('a second candidate list surface refuses instead of choosing by order', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  executor.seed(tenantA, 'Ambiguous supplier');
  const view = await issuedView(
    runtimeEntry(
      compiled,
      policy,
      { a: identity(tenantA, environmentA, principalA) },
      (projections) => {
        const payload = structuredClone(projections.surface.payload) as {
          surfaces: Record<string, unknown>[];
        };
        const target = payload.surfaces.find(
          (surface) =>
            surface.surfaceId ===
            `${FIXTURE_IDS.namespace}:surface.master_list`,
        );
        assert.ok(target);
        payload.surfaces.push({
          ...structuredClone(target),
          surfaceId: `${FIXTURE_IDS.namespace}:surface.master_list_alternate`,
        });
        return {
          ...projections,
          surface: {
            ...projections.surface,
            payload: payload as unknown as ImmutableJsonValue,
          },
        };
      },
    ),
    'a',
  );

  const rendered = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}`,
    semanticGateways(policy, executor),
  );
  assert.match(
    rendered.html,
    /data-diagnostic-code="RELATION_ENUMERATION_UNAVAILABLE"/u,
  );
  assert.match(
    rendered.html,
    new RegExp(`<code data-message-subject>${REQUIRED_RELATION_ID}</code>`),
  );
  assert.equal(
    executor.queryCalls.length,
    0,
    'ambiguous list authority must refuse before either candidate is invoked',
  );
});

test('relation inputs are visibly frozen on update forms', async () => {
  const compiled = compileFixture(fixtureWithDivergentChildForm());
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const childRecordId = executor.seed(
    tenantA,
    'Existing role',
    FIXTURE_IDS.entityIds.child,
  );
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );

  const rendered = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(DIVERGENT_CHILD_FORM_SURFACE)}&record=${childRecordId}`,
    semanticGateways(policy, executor),
  );
  assert.match(rendered.html, /data-relation-freeze/u);
  assert.match(rendered.html, /<form id="surface-record-form"/u);
  assert.match(rendered.html, /data-platform-slot="record:commandBar"/u);
  assert.match(
    rendered.html,
    /<button[^>]+form="surface-record-form"[^>]*>Save<\/button>/u,
  );
  assert.match(
    rendered.html,
    new RegExp(`data-relation-id="${REQUIRED_RELATION_ID}"`),
  );
  assert.match(rendered.html, /<strong>Parent<\/strong>/u);
  assert.doesNotMatch(rendered.html, /Master role parent/u);
  assert.match(rendered.html, /Locked after creation/u);
  assert.match(rendered.html, /cannot be changed later/u);
  assert.doesNotMatch(
    rendered.html,
    new RegExp(`<select name="relation:${REQUIRED_RELATION_ID}"`),
  );
});

test('relation inputs stay visibly frozen when the update precondition does not hold', async () => {
  const compiled = compileFixture(fixtureWithRefusingChildUpdate());
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const childRecordId = executor.seedValues(
    tenantA,
    { [FIXTURE_IDS.fieldIds.childRole]: FIXTURE_IDS.optionIds.owner },
    FIXTURE_IDS.entityIds.child,
  );
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );

  const rendered = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}&record=${childRecordId}`,
    semanticGateways(policy, executor),
  );
  assert.match(rendered.html, /data-relation-freeze/u);
  assert.match(
    rendered.html,
    new RegExp(`data-relation-id="${REQUIRED_RELATION_ID}"`),
  );
  assert.match(rendered.html, /Locked after creation/u);
  assert.match(rendered.html, /cannot be changed later/u);
  assert.doesNotMatch(rendered.html, /<form id="surface-record-form"/u);
  const refusedCommandBar = rendered.html.match(
    /<div\b[^>]*data-platform-slot="record:commandBar"[^>]*>[\s\S]*?<\/div>/u,
  );
  assert.ok(refusedCommandBar);
  assert.match(refusedCommandBar[0], /data-slot-state="ready"/u);
  assert.doesNotMatch(
    refusedCommandBar[0],
    /<button\b[^>]*>\s*Save\s*<\/button>/u,
  );
  assert.doesNotMatch(refusedCommandBar[0], /COMPONENT_RENDER_FAILED/u);
  assert.doesNotMatch(
    rendered.html,
    new RegExp(`<select name="relation:${REQUIRED_RELATION_ID}"`),
  );
});

test('the browser and gateway share whole-catalog root and identity authority', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const projections = runtimeProjections(compiled);
  const validPayload = structuredClone(projections.operation.payload) as {
    operations: Record<string, unknown>[];
    [key: string]: unknown;
  };
  const viewFor = (payload: ImmutableJsonValue) =>
    issuedView(
      runtimeEntry(
        compiled,
        policy,
        { a: identity(tenantA, environmentA, principalA) },
        (current) => ({
          ...current,
          operation: { ...current.operation, payload },
        }),
      ),
      'a',
    );

  const valid = await operationCatalogConsumerDecisions(
    await viewFor(validPayload as unknown as ImmutableJsonValue),
    policy,
  );
  assert.deepEqual(valid, { browser: 'accepted', gateway: 'accepted' });

  const extraRoot = structuredClone(validPayload);
  extraRoot.forged = true;
  assert.deepEqual(
    await operationCatalogConsumerDecisions(
      await viewFor(extraRoot as unknown as ImmutableJsonValue),
      policy,
    ),
    {
      browser:
        'pinned operation catalog is invalid: object keys do not match the closed contract',
      gateway: 'object keys do not match the closed contract',
    },
    'both consumers must refuse the extra root key for the shared closed-root reason',
  );

  const crossEntityCollision = structuredClone(validPayload);
  const otherEntityOperation = crossEntityCollision.operations.find(
    (operation) =>
      operation.operationId ===
      `${FIXTURE_IDS.namespace}:operation.master_update`,
  );
  assert.ok(otherEntityOperation);
  // One property changes. The operation remains on the parent entity, so if
  // catalog-wide identity admission is deleted the child surface sees one
  // create and cannot fail through its per-entity create arity instead.
  otherEntityOperation.operationId = CHILD_CREATE_OPERATION;
  assert.deepEqual(
    await operationCatalogConsumerDecisions(
      await viewFor(crossEntityCollision as unknown as ImmutableJsonValue),
      policy,
    ),
    {
      browser:
        'pinned operation catalog is invalid: pinned operation catalog contains a duplicate operationId',
      gateway: 'pinned operation catalog contains a duplicate operationId',
    },
    'both consumers must refuse a collision on another entity for the shared catalog-wide reason',
  );
});

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

test('scoped create carries each URL operand under its declared system-input key', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const scopeParameterId = `${FIXTURE_IDS.namespace}:parameter.master_get_legal_entity_scope`;
  const view = await issuedView(
    runtimeEntry(
      compiled,
      policy,
      { a: identity(tenantA, environmentA, principalA) },
      (projections) =>
        scopedCreateProjections(projections, scopeParameterId, true),
    ),
    'a',
  );
  const gateways = semanticGateways(policy, executor);
  const firstLegalEntityId = 'ac000000-0000-4000-8000-00000000000c';
  const secondLegalEntityId = 'ad000000-0000-4000-8000-00000000000d';
  const formSurface = `${FIXTURE_IDS.namespace}:surface.master_form`;

  const rendered = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(formSurface)}&${encodeURIComponent(scopeParameterId)}=${firstLegalEntityId}`,
    gateways,
  );
  assert.equal(rendered.statusCode, 200);
  assert.match(
    rendered.html,
    new RegExp(
      `form id="surface-record-form"[^>]+action="[^"]*${encodeURIComponent(scopeParameterId)}=${firstLegalEntityId}`,
    ),
    'the rendered POST action must retain the selected operand across the browser handoff',
  );

  const submit = (selection: readonly string[]) => {
    const url = new URL('http://surface-runtime.local');
    url.searchParams.set('surface', formSurface);
    for (const legalEntityId of selection) {
      url.searchParams.append(scopeParameterId, legalEntityId);
    }
    return submitSurfaceRuntimeIntent(
      view,
      `${url.pathname}${url.search}`,
      {
        idempotencyKey: randomUUID(),
        operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
        recordId: randomUUID(),
        [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Scoped create',
      },
      gateways,
    );
  };

  for (const legalEntityId of [firstLegalEntityId, secondLegalEntityId]) {
    const response = await submit([legalEntityId]);
    assert.equal(response.statusCode, 200);
  }
  assert.deepEqual(
    executor.operationCalls.map((call) => asRecord(call.input).legalEntityId),
    [firstLegalEntityId, secondLegalEntityId],
    'a second URL value must move the effective operand; one hardcoded fixture value cannot satisfy both arms',
  );
  const operationPolicyInputs = policy.calls
    .map((call) => call.decisionInput)
    .filter(
      (input) =>
        isRecord(input) &&
        input.kind === 'registeredSemanticOperationPolicyInput',
    );
  assert.deepEqual(
    operationPolicyInputs
      .slice(-2)
      .map((input) => asRecord(asRecord(input).input).legalEntityId),
    [firstLegalEntityId, secondLegalEntityId],
    'the registered operation permission authorizes the exact untrusted operand',
  );

  for (const invalidSelection of [
    [] as const,
    [firstLegalEntityId, secondLegalEntityId] as const,
  ]) {
    const response = await submit(invalidSelection);
    assert.equal(response.statusCode, 422);
  }
  assert.equal(
    executor.operationCalls.length,
    2,
    'omission and multiplicity refuse before execution',
  );

  const deniedPolicy = new RecordingPolicy((request) =>
    request.permissionId === `${FIXTURE_IDS.namespace}:permission.master_create`
      ? 'DENY'
      : 'ALLOW',
  );
  const deniedExecutor = new InMemoryGenericExecutor();
  const deniedView = await issuedView(
    runtimeEntry(
      compiled,
      deniedPolicy,
      { a: identity(tenantA, environmentA, principalA) },
      (projections) =>
        scopedCreateProjections(projections, scopeParameterId, true),
    ),
    'a',
  );
  const deniedUrl = `/?surface=${encodeURIComponent(formSurface)}&${encodeURIComponent(scopeParameterId)}=${firstLegalEntityId}`;
  const denied = await submitSurfaceRuntimeIntent(
    deniedView,
    deniedUrl,
    {
      idempotencyKey: randomUUID(),
      operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
      recordId: randomUUID(),
      [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Denied scoped create',
    },
    semanticGateways(deniedPolicy, deniedExecutor),
  );
  assert.equal(denied.statusCode, 403);
  assert.equal(deniedExecutor.operationCalls.length, 0);
});

test('an inactive legal-entity refusal keeps its provider subject at the web boundary', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const legalEntityId = 'ae000000-0000-4000-8000-00000000000e';
  const failure = new ModuleRuntimeInterpreterError(
    'MODULE_LEGAL_ENTITY_CREATE_INACTIVE',
    'legal entity is not active for new work',
    legalEntityId,
  );
  const executor = new InMemoryGenericExecutor(failure);
  const scopeParameterId = `${FIXTURE_IDS.namespace}:parameter.master_get_legal_entity_scope`;
  const view = await issuedView(
    runtimeEntry(
      compiled,
      policy,
      { a: identity(tenantA, environmentA, principalA) },
      (projections) =>
        scopedCreateProjections(projections, scopeParameterId, true),
    ),
    'a',
  );
  const response = await submitSurfaceRuntimeIntent(
    view,
    `/?surface=${encodeURIComponent(`${FIXTURE_IDS.namespace}:surface.master_form`)}&${encodeURIComponent(scopeParameterId)}=${legalEntityId}`,
    {
      idempotencyKey: randomUUID(),
      operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
      recordId: randomUUID(),
      [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Inactive refusal',
    },
    semanticGateways(policy, executor),
  );

  assert.equal(response.statusCode, 422);
  assert.match(
    response.html,
    /data-diagnostic-code="OPERATION_LEGAL_ENTITY_INACTIVE"/u,
  );
  assert.match(
    response.html,
    new RegExp(`<code data-message-subject>${legalEntityId}</code>`),
  );
  assert.equal(executor.operationCalls.length, 0);
});

test('an unscoped create refuses a supplied URL operand beside its admitted twin', async () => {
  const compiled = compileFixture();
  const policy = new RecordingPolicy('ALLOW');
  const executor = new InMemoryGenericExecutor();
  const scopeParameterId = `${FIXTURE_IDS.namespace}:parameter.master_get_legal_entity_scope`;
  const view = await issuedView(
    runtimeEntry(
      compiled,
      policy,
      { a: identity(tenantA, environmentA, principalA) },
      (projections) =>
        scopedCreateProjections(projections, scopeParameterId, false),
    ),
    'a',
  );
  const formSurface = `${FIXTURE_IDS.namespace}:surface.master_form`;
  const submission = {
    idempotencyKey: randomUUID(),
    operationId: `${FIXTURE_IDS.namespace}:operation.master_create`,
    recordId: randomUUID(),
    [`value:${FIXTURE_IDS.fieldIds.parentName}`]: 'Unscoped create',
  };
  const gateways = semanticGateways(policy, executor);

  const refused = await submitSurfaceRuntimeIntent(
    view,
    `/?surface=${encodeURIComponent(formSurface)}&${encodeURIComponent(scopeParameterId)}=ac000000-0000-4000-8000-00000000000c`,
    submission,
    gateways,
  );
  assert.equal(refused.statusCode, 422);
  assert.equal(executor.operationCalls.length, 0);

  const admitted = await submitSurfaceRuntimeIntent(
    view,
    `/?surface=${encodeURIComponent(formSurface)}`,
    { ...submission, idempotencyKey: randomUUID(), recordId: randomUUID() },
    gateways,
  );
  assert.equal(admitted.statusCode, 200);
  assert.equal(executor.operationCalls.length, 1);
  assert.equal(
    Object.hasOwn(asRecord(executor.operationCalls[0]!.input), 'legalEntityId'),
    false,
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
        const contract = clone.inputContract as Record<string, unknown>;
        // Keep the second contract independently valid. v3 with zero relations
        // is malformed before agreement is considered, which made this control
        // pass for the wrong reason and never reach the block it named.
        contract.schemaVersion = 'northstar.module-input-contract/v1';
        contract.relationInputs = [];
        contract.closedArgumentKeys = ['recordId', 'relations', 'values'];
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SurfaceProjectionError);
      assert.equal(error.code, 'INVALID_SURFACE_BINDING');
      assert.equal(
        error.message,
        'surface entity has create operations declaring different relation inputs',
      );
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
    readonly [string, string, (operation: Record<string, unknown>) => void]
  > = [
    [
      'relations declared on an update effect',
      'pinned relation inputs are admitted only on create effects',
      (operation) => {
        (operation.effect as Record<string, unknown>).kind =
          'updateRecordEffect';
      },
    ],
    [
      'a create contract omitting the relations closed key',
      'pinned relation argument key and operation effect disagree',
      (operation) => {
        (
          operation.inputContract as Record<string, unknown>
        ).closedArgumentKeys = ['recordId', 'values'];
      },
    ],
    [
      'a duplicated relation identity',
      'pinned relation inputs repeat a relation identity',
      (operation) => {
        const contract = operation.inputContract as Record<string, unknown>;
        const relations = contract.relationInputs as unknown[];
        contract.relationInputs = [relations[0], structuredClone(relations[0])];
      },
    ],
  ];

  for (const [reason, expectedDiagnostic, mutate] of refusals) {
    await assert.rejects(
      read(forge(mutate)),
      (error: unknown) => {
        assert.ok(
          error instanceof SurfaceProjectionError,
          `${reason}: the BROWSER must refuse, got ${String(error)}`,
        );
        assert.equal(error.code, 'INVALID_SURFACE_BINDING');
        assert.match(
          error.message,
          new RegExp(
            expectedDiagnostic.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
          ),
          `${reason}: refusal carried the wrong reason`,
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
test('unavailable relation authority remains named when the update precondition does not hold', async () => {
  const policy = new RecordingPolicy('ALLOW');
  const compiled = compileFixture(fixtureWithRefusingChildUpdate());
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
  const executor = new InMemoryGenericExecutor();
  const childRecordId = executor.seed(
    tenantA,
    'Unknown relation authority',
    FIXTURE_IDS.entityIds.child,
  );
  const unavailableUpdate = await renderSurfaceRuntimeWithData(
    view,
    `/?surface=${encodeURIComponent(CHILD_FORM_SURFACE)}&record=${childRecordId}`,
    semanticGateways(policy, executor),
  );
  assert.match(
    unavailableUpdate.html,
    /data-diagnostic-code="QUERY_UNSUPPORTED"/u,
  );
  assert.doesNotMatch(
    unavailableUpdate.html,
    /<form id="surface-record-form"/u,
    'unavailable relation authority must refuse rather than masquerade as no relations',
  );
  const unavailableCommandBar = unavailableUpdate.html.match(
    /<div\b[^>]*data-platform-slot="record:commandBar"[^>]*>[\s\S]*?<\/div>/u,
  );
  assert.ok(unavailableCommandBar);
  assert.match(unavailableCommandBar[0], /data-slot-state="ready"/u);
  assert.doesNotMatch(
    unavailableCommandBar[0],
    /<button\b[^>]*>\s*Save\s*<\/button>/u,
  );
  assert.doesNotMatch(unavailableCommandBar[0], /COMPONENT_RENDER_FAILED/u);
  assert.doesNotMatch(
    unavailableUpdate.html,
    new RegExp(`<select name="relation:${REQUIRED_RELATION_ID}"`),
  );
  assert.doesNotMatch(unavailableUpdate.html, /data-relation-freeze/u);

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

/**
 * Review round 2: the browser validated only the relation slice, so it still
 * bound catalogs the gateway refuses on TOP-LEVEL contract shape. Each case
 * mutates one property the relation parser never inspects, and asserts the
 * browser refuses it -- which it can only do by running the complete pinned
 * operation authority.
 */
test('the browser refuses contracts malformed outside the relation slice', async () => {
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
    assert.ok(operation);
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

  // ADMISSION TWIN.
  assert.equal(
    (await read(forge(() => undefined))).relationInputs.status,
    'known',
  );

  const refusals: ReadonlyArray<
    readonly [string, string, (operation: Record<string, unknown>) => void]
  > = [
    [
      'fields set to null',
      'pinned operation input contract has an invalid shape',
      (operation) => {
        (operation.inputContract as Record<string, unknown>).fields = null;
      },
    ],
    [
      'writableFieldIds omitted',
      'object keys do not match the closed contract',
      (operation) => {
        delete (operation.inputContract as Record<string, unknown>)
          .writableFieldIds;
      },
    ],
    [
      'an unknown top-level contract key',
      'object keys do not match the closed contract',
      (operation) => {
        (operation.inputContract as Record<string, unknown>).forged = 1;
      },
    ],
    [
      'a non-string closed argument key',
      'pinned operation input contract has an invalid shape',
      (operation) => {
        (
          operation.inputContract as Record<string, unknown>
        ).closedArgumentKeys = ['recordId', 'relations', 'values', 7];
      },
    ],
    [
      'a repeated field identity',
      'pinned field inputs repeat a field identity',
      (operation) => {
        const contract = operation.inputContract as Record<string, unknown>;
        const fields = contract.fields as unknown[];
        contract.fields = [fields[0], structuredClone(fields[0])];
      },
    ],
  ];

  for (const [reason, expectedDiagnostic, mutate] of refusals) {
    await assert.rejects(
      read(forge(mutate)),
      (error: unknown) => {
        assert.ok(
          error instanceof SurfaceProjectionError,
          `${reason}: the BROWSER must refuse, got ${String(error)}`,
        );
        assert.equal(error.code, 'INVALID_SURFACE_BINDING');
        assert.match(
          error.message,
          new RegExp(
            expectedDiagnostic.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
          ),
          `${reason}: refusal carried the wrong reason`,
        );
        return true;
      },
      reason,
    );
  }

  // Catalog-wide identity (including the cross-entity deletion-dead control)
  // is exercised against BOTH consumers above. Keeping the old same-entity
  // clone here would be dishonest: deleting duplicate-id admission made it
  // refuse later through create arity and left the supposed control green.
});

/**
 * Review round 2: a create carrying NO input contract is a legitimate compiled
 * state -- the projection emits one only for the current language version -- and
 * it was being read as `known: []`, i.e. "this entity positively declares no
 * relations". Three specimens, because two of them were previously conflated.
 */
test('a create with no contract is unavailable, not known-empty', async () => {
  const policy = new RecordingPolicy('ALLOW');
  const compiled = compileFixture();
  const projections = runtimeProjections(compiled);

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
    return readCompiledSurfaceDataBinding(view, surface).relationInputs;
  };

  const mutate = (
    change: (operations: Record<string, unknown>[]) => void,
  ): ImmutableJsonValue => {
    const payload = structuredClone(projections.operation.payload) as {
      operations: Record<string, unknown>[];
    };
    change(payload.operations);
    return payload as unknown as ImmutableJsonValue;
  };

  // 1. create present WITH a contract -> known (admission twin).
  assert.equal((await read(mutate(() => undefined))).status, 'known');

  // 2. create present WITHOUT a contract -> unavailable. This is the state the
  //    previous fix collapsed back into known-empty.
  const contractless = await read(
    mutate((operations) => {
      const create = operations.find(
        (operation) => operation.operationId === CHILD_CREATE_OPERATION,
      );
      assert.ok(create);
      delete create.inputContract;
    }),
  );
  assert.equal(
    contractless.status,
    'unavailable',
    'a create with no contract carries no authority',
  );

  // 3. no create at all -> unavailable.
  const noCreate = await read(
    mutate((operations) => {
      const index = operations.findIndex(
        (operation) => operation.operationId === CHILD_CREATE_OPERATION,
      );
      operations.splice(index, 1);
    }),
  );
  assert.equal(noCreate.status, 'unavailable');
});

class RecordingPolicy implements CurrentPolicyGateway {
  readonly calls: CurrentPolicyDecisionRequest[] = [];

  constructor(
    private readonly decision:
      | 'ALLOW'
      | 'DENY'
      | ((request: CurrentPolicyDecisionRequest) => 'ALLOW' | 'DENY'),
  ) {}

  async authorize(request: CurrentPolicyDecisionRequest) {
    this.calls.push(request);
    return {
      decision:
        typeof this.decision === 'function'
          ? this.decision(request)
          : this.decision,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'surface-binding-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'surface-binding-policy/v1' };
  }
}

async function operationCatalogConsumerDecisions(
  view: RequestRuntimeView,
  policy: CurrentPolicyGateway,
): Promise<Readonly<{ browser: string; gateway: string }>> {
  const manifest = readCompiledSurfaceManifest(view);
  const surface = manifest.surfaces.find(
    (candidate) => candidate.surfaceId === CHILD_FORM_SURFACE,
  );
  assert.ok(surface);
  let browser = 'accepted';
  try {
    readCompiledSurfaceDataBinding(view, surface);
  } catch (error) {
    assert.ok(error instanceof SurfaceProjectionError);
    assert.equal(error.code, 'INVALID_SURFACE_BINDING');
    browser = error.message;
  }

  const mediation = new SemanticOperationMediationAuthority();
  const gateway = new SemanticOperationGateway(
    policy,
    new InMemoryGenericExecutor(),
    mediation,
  );
  let gatewayDecision = 'accepted';
  try {
    await gateway.invoke(
      view,
      {
        confirmationGrant: null,
        idempotencyKey: randomUUID(),
        input: {
          recordId: randomUUID(),
          relations: { [REQUIRED_RELATION_ID]: randomUUID() },
          values: {
            [FIXTURE_IDS.fieldIds.childRole]: FIXTURE_IDS.optionIds.owner,
          },
        },
        operationId: CHILD_CREATE_OPERATION,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      mediation.issueInvocation(view, 'UI'),
    );
  } catch (error) {
    assert.ok(error instanceof Error);
    gatewayDecision = error.message;
  }
  return Object.freeze({ browser, gateway: gatewayDecision });
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

  constructor(private readonly operationFailure: Error | null = null) {}

  seed(
    tenantId: string,
    name: string,
    entityId: string = FIXTURE_IDS.entityIds.parent,
  ): string {
    const recordId = randomUUID();
    this.tenantRecords(tenantId).set(
      recordId,
      record(recordId, name, entityId),
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
    entityId: string = FIXTURE_IDS.entityIds.parent,
  ): string {
    const recordId = randomUUID();
    this.tenantRecords(tenantId).set(
      recordId,
      Object.freeze({
        archived: false,
        entityId,
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
    if (!('arguments' in request) && this.operationFailure) {
      throw this.operationFailure;
    }
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
  executor: SemanticQueryExecutor & SemanticOperationExecutor,
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
  coverage: (
    request: SemanticQueryExecutionRequest,
    returnedCount: number,
  ) => NonNullable<SemanticQueryResultEnvelope['listCoverage']> = listCoverage,
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
            listCoverage: coverage(request, projectedRecords.length),
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
    parentScope: null,
    projectedSearchValueCount:
      request.list.query.search.length === 0
        ? 0
        : request.definition.selections.length,
    requestedPageSize: request.list.query.requestedPageSize,
    returnedCount,
    schemaVersion: 'northstar.shared-list-result/v1',
    search: request.list.query.search,
    // Echoed as the PostgreSQL executor does (CATALOG-EXTRAS): the children
    // a search also matches through.
    ...(request.list.query.searchChildren
      ? { searchChildren: request.list.query.searchChildren }
      : {}),
    sort: request.list.query.sort,
    totalCount: request.list.query.pageOffset + returnedCount,
    truncatedByMaximum: request.list.query.truncatedByMaximum,
  });
}

function runtimeEntry(
  compiled: CompileSuccess,
  policy: CurrentPolicyGateway,
  identities: Readonly<Record<string, AuthenticatedIdentity>>,
  transform: (
    projections: LoadedRequestRuntimeDefinition['projections'],
  ) => LoadedRequestRuntimeDefinition['projections'] = (projections) =>
    projections,
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
          projections: transform(runtimeProjections(compiled)),
          release: { contentHash: compiled.releaseRoot, releaseId },
          tenantId: context.tenantId,
        };
      },
    },
    policy,
  );
}

function scopedCreateProjections(
  projections: LoadedRequestRuntimeDefinition['projections'],
  scopeParameterId: string,
  systemInput: boolean,
): LoadedRequestRuntimeDefinition['projections'] {
  const operationPayload = structuredClone(projections.operation.payload) as {
    operations: Record<string, unknown>[];
  };
  const create = operationPayload.operations.find(
    (operation) =>
      operation.operationId ===
      `${FIXTURE_IDS.namespace}:operation.master_create`,
  );
  assert.ok(create);
  const contract = asRecord(create.inputContract);
  assert.ok(Array.isArray(contract.closedArgumentKeys));
  if (systemInput) {
    contract.closedArgumentKeys = [
      ...contract.closedArgumentKeys,
      'legalEntityId',
    ];
    assert.ok(
      contract.schemaVersion === 'northstar.module-input-contract/v1' ||
        contract.schemaVersion === 'northstar.module-input-contract/v3',
    );
    contract.schemaVersion =
      contract.schemaVersion === 'northstar.module-input-contract/v1'
        ? 'northstar.module-input-contract/v2'
        : 'northstar.module-input-contract/v4';
    contract.systemInput = {
      argumentKey: 'legalEntityId',
      classification: 'INTERNAL',
      immutableAfterCreate: true,
      physicalColumn: 'legal_entity_id',
      required: true,
      valueKind: 'uuid',
    };
  }

  const queryPayload = structuredClone(projections.query.payload) as {
    queries: Record<string, unknown>[];
  };
  const get = queryPayload.queries.find(
    (query) => query.queryId === `${FIXTURE_IDS.namespace}:query.master_get`,
  );
  assert.ok(get);
  get.legalEntityScope = {
    cardinality: 'exactlyOne',
    kind: 'queryLegalEntityScope',
    operand: {
      kind: 'queryParameterReference',
      parameterId: scopeParameterId,
      schemaVersion: 'v5',
    },
    schemaVersion: 'v5',
  };
  get.parameters = [
    {
      orderKey: 10,
      parameterId: scopeParameterId,
      parameterType: {
        kind: 'legalEntityReferenceParameterType',
        schemaVersion: 'v5',
      },
    },
  ];
  return {
    ...projections,
    operation: {
      ...projections.operation,
      payload: operationPayload as unknown as ImmutableJsonValue,
    },
    query: {
      ...projections.query,
      payload: queryPayload as unknown as ImmutableJsonValue,
    },
  };
}

function scopedRelationProjections(
  projections: LoadedRequestRuntimeDefinition['projections'],
  sourceScopeParameterId: string,
  targetScopeParameterId: string,
): LoadedRequestRuntimeDefinition['projections'] {
  const operationPayload = structuredClone(projections.operation.payload) as {
    operations: Record<string, unknown>[];
  };
  const create = operationPayload.operations.find(
    (operation) => operation.operationId === CHILD_CREATE_OPERATION,
  );
  assert.ok(create);
  const contract = asRecord(create.inputContract);
  assert.equal(contract.schemaVersion, 'northstar.module-input-contract/v3');
  assert.ok(Array.isArray(contract.closedArgumentKeys));
  contract.closedArgumentKeys = [
    ...contract.closedArgumentKeys,
    'legalEntityId',
  ];
  contract.schemaVersion = 'northstar.module-input-contract/v4';
  contract.systemInput = {
    argumentKey: 'legalEntityId',
    classification: 'INTERNAL',
    immutableAfterCreate: true,
    physicalColumn: 'legal_entity_id',
    required: true,
    valueKind: 'uuid',
  };

  const queryPayload = structuredClone(projections.query.payload) as {
    queries: Record<string, unknown>[];
  };
  const scopeQuery = (queryId: string, parameterId: string): void => {
    const query = queryPayload.queries.find(
      (candidate) => candidate.queryId === queryId,
    );
    assert.ok(query, `${queryId} must exist in the fixture`);
    query.legalEntityScope = {
      cardinality: 'exactlyOne',
      kind: 'queryLegalEntityScope',
      operand: {
        kind: 'queryParameterReference',
        parameterId,
        schemaVersion: 'v5',
      },
      schemaVersion: 'v5',
    };
    query.parameters = [
      {
        orderKey: 10,
        parameterId,
        parameterType: {
          kind: 'legalEntityReferenceParameterType',
          schemaVersion: 'v5',
        },
      },
    ];
  };
  scopeQuery(
    `${FIXTURE_IDS.namespace}:query.master_role_get`,
    sourceScopeParameterId,
  );
  scopeQuery(
    `${FIXTURE_IDS.namespace}:query.master_list`,
    targetScopeParameterId,
  );
  return {
    ...projections,
    operation: {
      ...projections.operation,
      payload: operationPayload as unknown as ImmutableJsonValue,
    },
    query: {
      ...projections.query,
      payload: queryPayload as unknown as ImmutableJsonValue,
    },
  };
}

function targetlessRelationProjections(
  projections: LoadedRequestRuntimeDefinition['projections'],
  required: boolean,
): LoadedRequestRuntimeDefinition['projections'] {
  const operationPayload = structuredClone(projections.operation.payload) as {
    operations: Record<string, unknown>[];
  };
  const create = operationPayload.operations.find(
    (operation) => operation.operationId === CHILD_CREATE_OPERATION,
  );
  assert.ok(create);
  const contract = asRecord(create.inputContract);
  assert.equal(contract.schemaVersion, 'northstar.module-input-contract/v3');
  assert.ok(Array.isArray(contract.relationInputs));
  const relation = contract.relationInputs[0];
  assert.ok(isRecord(relation));
  contract.schemaVersion = 'northstar.module-input-contract/v1';
  delete relation.targetEntityId;
  relation.required = required;
  return {
    ...projections,
    operation: {
      ...projections.operation,
      payload: operationPayload as unknown as ImmutableJsonValue,
    },
  };
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
  assert.equal(
    result.status,
    'compiled',
    JSON.stringify(result.status === 'failed' ? result.diagnostics : null),
  );
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
 * page-level `INVALID_SURFACE_BINDING`, so three holes stayed green: a per-intent
 * exemption (`intent !== 'update' && bound > arity`), the same independently
 * for `archive` and `restore`, and a bare `throw` swapped in for
 * `invalidBinding(...)`. `INVALID_SURFACE_BINDING` is what the runtime renders
 * for any unreadable binding, so it cannot tell those apart.
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
 * RAIN WORKSPACE INTERACTION COMPLETION, milestone A. The composed Inventory
 * period lock declares two update operations (advance and reopen) and no form,
 * so its read-only List and Record rendered INVALID_SURFACE_BINDING. A family
 * with no form renders no update at all: the surplus is left unbound and the
 * read surfaces bind. A surplus that could still render -- archive, on the
 * Record -- is refused by name exactly as before, and the table above keeps a
 * family WITH a form refusing its surplus update.
 */
test('a form-less family leaves a surplus update unbound and still reads', async () => {
  const bindings = async (
    source: Record<string, unknown>,
    surfaceIds: readonly string[],
  ) => {
    const view = await issuedView(
      runtimeEntry(compileFixture(source), new RecordingPolicy('ALLOW'), {
        a: identity(tenantA, environmentA, principalA),
      }),
      'a',
    );
    const surfaces = readCompiledSurfaceManifest(view).surfaces;
    return surfaceIds.map((surfaceId) => {
      const surface = surfaces.find(
        (candidate) => candidate.surfaceId === surfaceId,
      );
      assert.ok(surface, surfaceId);
      return readCompiledSurfaceDataBinding(view, surface);
    });
  };
  // The composed period lock: two update operations, no form.
  for (const binding of await bindings(composedApplicationDefinition(), [
    'northstar.app:surface.inventory_period_lock_list',
    'northstar.app:surface.inventory_period_lock_detail',
  ]))
    assert.deepEqual(
      binding.operations.map((operation) => operation.intent),
      [],
    );

  // The same surplus beside a form still refuses by name.
  const withForm = composedApplicationDefinition();
  const operations = withForm.operations as Array<Record<string, unknown>>;
  const update = operations.find(
    (candidate) =>
      candidate.operationId === 'northstar.app:operation.party_update',
  );
  assert.ok(update);
  operations.push({
    ...update,
    operationId: 'northstar.app:operation.party_update_alternate',
  });
  await assert.rejects(
    async () => bindings(withForm, ['northstar.app:surface.party_list']),
    (error: unknown) => {
      assert.ok(error instanceof SurfaceProjectionError);
      assert.equal(error.code, 'INVALID_SURFACE_BINDING');
      assert.match(error.message, /\bupdate\b/u);
      return true;
    },
  );
});

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
  assert.deepEqual(labels, ['Release', 'Cancel']);
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
    inputFields: null,
    intent: 'command' as const,
    label: 'Release',
    operationId: `${FIXTURE_IDS.namespace}:operation.master_release`,
    precondition: Object.freeze({}),
    systemInputArgumentKey: null,
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

// RAIN-META-SALES: an unrelated package, with every product identity renamed.
function workshopComposition(label: string): Record<string, unknown> {
  const definition = JSON.parse(
    JSON.stringify(ordinaryModuleV1())
      .replaceAll('northstar.modulefixture', 'workshop.jobs')
      .replaceAll('master_role', 'assignment')
      .replaceAll('master', 'job')
      .replaceAll('"v3"', '"v6"')
      .replaceAll('northstar.normalization/v3', 'northstar.normalization/v6'),
  ) as Record<string, unknown>;
  const surfaces = definition.surfaces as Array<Record<string, unknown>>;
  const surface = surfaces.find(
    (value) => value.surfaceId === 'workshop.jobs:surface.job_record',
  )!;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  surface.composition = {
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    fields: [
      {
        columnId: 'workshop.jobs:column.name',
        label,
        orderKey: 10,
        field: 'workshop.jobs:field.job_name',
      },
    ],
    children: [
      {
        datasetId: 'workshop.jobs:dataset.assignments',
        label: 'Assigned work',
        orderKey: 10,
        query: ref('queryReference', 'workshop.jobs:query.assignment_list'),
        parent: {
          relationId: 'workshop.jobs:relation.assignment_parent',
          ownership: 'parentScopedChild',
          value: { source: 'record', field: 'recordId' },
        },
        columns: [
          {
            columnId: 'workshop.jobs:column.role',
            label: 'Responsibility',
            orderKey: 10,
            field: 'workshop.jobs:field.assignment_kind',
          },
        ],
      },
    ],
    actions: [
      {
        actionId: 'workshop.jobs:action.retire',
        label: 'Retire assignment',
        description: 'Archive this assignment.',
        orderKey: 10,
        datasetId: 'workshop.jobs:dataset.assignments',
        conditions: [],
        inputs: [],
        steps: [
          {
            stepId: 'workshop.jobs:step.archive',
            operation: ref(
              'operationReference',
              'workshop.jobs:operation.assignment_archive',
            ),
            bindings: [
              {
                path: ['recordId'],
                value: { source: 'selected', field: 'recordId' },
              },
              {
                path: ['expectedRevision'],
                value: { source: 'selected', field: 'revision' },
              },
            ],
          },
        ],
      },
    ],
  };
  (surface.slots as unknown[]).push(
    ...['sections', 'commandBar'].map((slot, index) => ({
      kind: 'surfaceSlot',
      schemaVersion: 'v6',
      slot,
      slotId: `workshop.jobs:slot.extra_${index}`,
      orderKey: 20 + index,
      content: ref(
        'opaqueSurfaceContentReference',
        'workshop.jobs:capability.standard_surface_content',
      ),
    })),
  );
  (surface.slots as unknown[]).push({
    kind: 'surfaceSlot',
    schemaVersion: 'v6',
    slot: 'childTables',
    slotId: 'workshop.jobs:slot.children',
    orderKey: 60,
    content: ref(
      'opaqueSurfaceContentReference',
      'workshop.jobs:capability.standard_surface_content',
    ),
  });
  return definition;
}

function presentedWorkshop(
  label: string,
  reverse = false,
  dialog = false,
): Record<string, unknown> {
  const value = workshopComposition(label);
  const surface = (value.surfaces as Array<Record<string, unknown>>).find(
    (surface) => surface.composition,
  )!;
  const composition = surface.composition as SurfaceComposition;
  composition.presentation = {
    header: { title: composition.fields[0]!.columnId, subtitle: [], facts: [] },
    context: { label, description: 'Select an assignment to retire it.' },
    recordActions: 'progressive',
    technicalDetails: 'progressive',
    ...(dialog
      ? { task: { mode: 'nativeDialog' as const, fallback: 'page' as const } }
      : {}),
  };
  const child = composition.children[0]!;
  if (dialog)
    child.sort = [
      {
        fieldId: child.columns[0]!
          .field as SurfaceComposition['fields'][number]['columnId'],
        direction: 'ascending',
      },
    ];
  child.presentation = {
    selection: 'explicit',
    ...(dialog ? { compact: 'scrollTable' as const } : {}),
    description: 'Assignments scoped to this workshop job.',
  };
  child.columns[0]!.presentation = { role: 'primary', priority: 0 };
  child.columns.push({
    columnId:
      'workshop.jobs:column.revision' as SurfaceComposition['fields'][number]['columnId'],
    label: 'Version',
    field: 'revision',
    orderKey: 20,
    presentation: { role: reverse ? 'detail' : 'quantity', priority: 1 },
  });
  composition.actions[0]!.presentation = { placement: 'selection' };
  (surface.slots as Array<Record<string, unknown>>).push({
    kind: 'surfaceSlot',
    schemaVersion: 'v6',
    slot: 'titleStatus',
    slotId: 'workshop.jobs:slot.header',
    orderKey: 1,
    content: {
      kind: 'opaqueSurfaceContentReference',
      schemaVersion: 'v6',
      targetId: 'workshop.jobs:capability.standard_surface_content',
    },
  });
  return value;
}

test('v6 composition renders two compiled presentation revisions and renamed non-Sales child actions through the same runtime', async () => {
  const first = compileFixture(workshopComposition('Work title'));
  const second = compileFixture(workshopComposition('Assignment heading'));
  assert.notEqual(first.releaseRoot, second.releaseRoot);
  const presented = compileFixture(presentedWorkshop('Assignments'));
  const varied = compileFixture(presentedWorkshop('Responsibilities', true));
  const dialog = compileFixture(
    presentedWorkshop('Dialog assignments', false, true),
  );
  assert.notEqual(presented.releaseRoot, varied.releaseRoot);
  const policy = new RecordingPolicy('ALLOW');
  const root: SemanticRecordDto = {
    entityId: 'workshop.jobs:entity.job',
    recordId: randomUUID(),
    revision: 1,
    archived: false,
    values: { 'workshop.jobs:field.job_name': 'Warehouse audit' },
  };
  const child: SemanticRecordDto = {
    entityId: 'workshop.jobs:entity.assignment',
    recordId: randomUUID(),
    revision: 7,
    archived: false,
    values: { 'workshop.jobs:field.assignment_kind': 'Supervisor' },
  };
  const observed: SemanticQueryExecutionRequest[] = [];
  const executor = new InMemoryGenericExecutor();
  let gateways: SurfaceRuntimeGateways = {
    ...semanticGateways(policy, executor),
    queryGateway: new SemanticQueryGateway(policy, {
      async execute(request) {
        observed.push(request);
        return {
          kind: 'semanticQueryResult',
          schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
          queryId: request.definition.queryId,
          outcome: 'exact',
          unsupportedReason: null,
          records: request.list ? [child] : [root],
          ...(request.list
            ? {
                listCoverage: {
                  ...listCoverage(request, 1),
                  parentScope: request.list.query.parentScope,
                },
              }
            : {}),
        };
      },
    }),
  };
  for (const [compiled, label] of [
    [first, 'Work title'],
    [second, 'Assignment heading'],
    [presented, 'Assignments'],
    [varied, 'Responsibilities'],
    [dialog, 'Dialog assignments'],
  ] as const) {
    const view = await issuedView(
      runtimeEntry(compiled, policy, {
        a: identity(tenantA, environmentA, principalA),
      }),
      'a',
    );
    const surface = readCompiledSurfaceManifest(view).surfaces.find(
      (value) => value.surfaceId === 'workshop.jobs:surface.job_record',
    )!;
    const url = new URL('http://fixture/');
    url.searchParams.set('surface', surface.surfaceId);
    url.searchParams.set('record', root.recordId);
    url.searchParams.set('dataset', 'workshop.jobs:dataset.assignments');
    url.searchParams.set(
      'select:workshop.jobs:dataset.assignments',
      child.recordId,
    );
    const data = await loadSurfaceComposition(
      view,
      surface,
      root,
      url.href,
      null,
      gateways,
    );
    assert.equal(data.children[0]?.status, 'ready');
    assert.equal(data.selected?.recordId, child.recordId);
    if (surface.composition?.presentation) {
      assert.match(
        renderCompositionHeader(surface, data),
        /<h1>Warehouse audit<\/h1>/,
      );
      const children = renderCompositionChildren(data, surface, view);
      assert.match(children, /<strong>Supervisor<\/strong>/);
      assert.doesNotMatch(children, /Selected record actions/);
      assert.match(
        children,
        compiled === varied
          ? /Supporting details/
          : /data-cell-role="quantity"/,
      );
      const html = await renderSurfaceRuntimeWithData(view, url.href, gateways);
      assert.match(html.html, /composition-header/);
      assert.match(html.html, /composition-local-actions/);
    } else
      assert.match(renderCompositionFields(surface, data), new RegExp(label));
    assert.match(renderCompositionChildren(data), /Supervisor/);
    assert.match(
      renderCompositionActions(surface, data, view),
      /Retire assignment/,
    );
    assert.deepEqual(observed.at(-1)?.list?.query.parentScope, {
      relationId: 'workshop.jobs:relation.assignment_parent',
      recordId: root.recordId,
    });
    if (compiled === dialog)
      assert.deepEqual(observed.at(-1)?.list?.query.sort, [
        {
          fieldId: 'workshop.jobs:field.assignment_kind',
          direction: 'ascending',
        },
      ]);
  }
  // Removing the provider's exact-scope receipt must fail the child, never show a broad list.
  const view = await issuedView(
    runtimeEntry(first, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const surface = readCompiledSurfaceManifest(view).surfaces.find(
    (value) => value.surfaceId === 'workshop.jobs:surface.job_record',
  )!;
  gateways = { ...gateways, queryGateway: fixedQueryGateway('exact', [child]) };
  const refused = await loadSurfaceComposition(
    view,
    surface,
    root,
    '/',
    null,
    gateways,
  );
  assert.equal(refused.children[0]?.status, 'failed');
  assert.deepEqual(refused.children[0]?.rows, []);
  assert.doesNotMatch(
    renderCompositionActions(surface, refused, view),
    /Retire assignment/,
  );
});

test('Record presentation refuses unresolved headers, ambiguous hierarchy and implicit write selection', () => {
  for (const mutate of [
    (value: SurfaceComposition) => {
      value.presentation!.header.title =
        'workshop.jobs:column.absent' as SurfaceComposition['fields'][number]['columnId'];
    },
    (value: SurfaceComposition) => {
      value.children[0]!.columns[1]!.presentation!.role = 'primary';
    },
    (value: SurfaceComposition) => {
      value.actions[0]!.presentation!.placement = 'row';
    },
    (value: SurfaceComposition) => {
      value.children[0]!.presentation!.selection = 'none';
    },
    (value: SurfaceComposition) => {
      delete value.presentation;
    },
  ]) {
    const authored = presentedWorkshop('Assignments');
    mutate(
      (authored.surfaces as Array<{ composition?: SurfaceComposition }>).find(
        (value) => value.composition,
      )!.composition!,
    );
    assert.throws(() => normalizeApplicationPackage(authored));
  }
});

test('Task presentation requires explicit page fallback and declared child sorting', () => {
  for (const policy of [
    { mode: 'nativeDialog' },
    { mode: 'nativeDialog', fallback: 'hidden' },
    { mode: 'salesDialog', fallback: 'page' },
  ]) {
    const definition = presentedWorkshop('Assignments');
    const surface = (
      definition.surfaces as Array<Record<string, unknown>>
    ).find((surface) => surface.composition)!;
    (surface.composition as SurfaceComposition).presentation!.task =
      policy as NonNullable<SurfaceComposition['presentation']>['task'];
    assert.throws(
      () => normalizeApplicationPackage(definition),
      CanonicalModelError,
    );
  }
  const definition = presentedWorkshop('Assignments', false, true);
  const surface = (definition.surfaces as Array<Record<string, unknown>>).find(
    (surface) => surface.composition,
  )!;
  (surface.composition as SurfaceComposition).children[0]!.sort = [
    {
      fieldId:
        'workshop.jobs:field.unavailable' as SurfaceComposition['fields'][number]['columnId'],
      direction: 'ascending',
    },
  ];
  assert.throws(
    () => normalizeApplicationPackage(definition),
    CanonicalModelError,
  );
});

test('v6 composition refuses undeclared context, operation fields and cyclic child dependencies', () => {
  const valid = workshopComposition('Work title');
  normalizeApplicationPackage(valid);
  for (const mutate of [
    (composition: SurfaceComposition) => {
      composition.fields[0]!.field = 'workshop.jobs:field.missing';
    },
    (composition: SurfaceComposition) => {
      composition.actions[0]!.conditions = [
        {
          value: { source: 'input', inputId: composition.actions[0]!.actionId },
          operator: 'equals',
          compare: 'x',
        },
      ];
    },
    (composition: SurfaceComposition) => {
      composition.children[0]!.parent!.value = {
        source: 'selected',
        datasetId: composition.children[0]!.datasetId,
        field: 'recordId',
      };
    },
    (composition: SurfaceComposition) => {
      composition.actions[0]!.steps[0]!.bindings[0]!.path = [
        'values',
        'workshop.jobs:field.job_name',
      ];
    },
  ]) {
    const candidate = structuredClone(valid);
    const surface = (candidate.surfaces as Array<Record<string, unknown>>).find(
      (value) => value.composition,
    )!;
    mutate(surface.composition as SurfaceComposition);
    assert.throws(
      () => normalizeApplicationPackage(candidate),
      /CANON_SCHEMA_INVALID/,
    );
  }
});

test('composed tasks retain reviewed inputs and retry keys, and stop on committed withheld read-back', async () => {
  for (const withheld of [false, true]) {
    const definition = workshopComposition('Work title');
    const authoredSurface = (
      definition.surfaces as Array<Record<string, unknown>>
    ).find((surface) => surface.composition)!;
    const composition = authoredSurface.composition as SurfaceComposition;
    const ref = (kind: string, targetId: string) => ({
      kind,
      schemaVersion: 'v6',
      targetId,
    });
    // Mutate authored data, then compile; no HTML or pinned projection is fabricated.
    (authoredSurface.composition as unknown as { actions: unknown[] }).actions =
      [
        {
          actionId: 'workshop.jobs:action.rename',
          label: 'Rename work',
          description: 'Update the work title.',
          orderKey: 10,
          conditions: [],
          inputs: [
            {
              inputId: 'workshop.jobs:input.title',
              label: 'New title',
              orderKey: 10,
              type: 'text',
              required: true,
            },
          ],
          steps: [
            {
              stepId: 'workshop.jobs:step.rename',
              operation: ref(
                'operationReference',
                'workshop.jobs:operation.job_update',
              ),
              bindings: [
                {
                  path: ['recordId'],
                  value: { source: 'record', field: 'recordId' },
                },
                {
                  path: ['expectedRevision'],
                  value: { source: 'record', field: 'revision' },
                },
                {
                  path: ['patch', 'workshop.jobs:field.job_name'],
                  value: {
                    source: 'input',
                    inputId: 'workshop.jobs:input.title',
                  },
                },
              ],
            },
            ...(withheld
              ? [
                  {
                    stepId: 'workshop.jobs:step.after',
                    operation: ref(
                      'operationReference',
                      'workshop.jobs:operation.job_archive',
                    ),
                    bindings: [
                      {
                        path: ['recordId'],
                        value: {
                          source: 'step',
                          stepId: 'workshop.jobs:step.rename',
                          field: 'recordId',
                        },
                      },
                      {
                        path: ['expectedRevision'],
                        value: {
                          source: 'step',
                          stepId: 'workshop.jobs:step.rename',
                          field: 'revision',
                        },
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
      ];
    composition.children = [];
    const operation = (
      definition.operations as Array<Record<string, unknown>>
    ).find(
      (operation) =>
        operation.operationId === 'workshop.jobs:operation.job_update',
    )!;
    operation.confirmation = 'humanRequired';
    const compiled = compileFixture(definition);
    const policy = new RecordingPolicy('ALLOW');
    const view = await issuedView(
      runtimeEntry(compiled, policy, {
        a: identity(tenantA, environmentA, principalA),
      }),
      'a',
    );
    const surface = readCompiledSurfaceManifest(view).surfaces.find(
      (surface) => surface.surfaceId === 'workshop.jobs:surface.job_record',
    )!;
    const root: SemanticRecordDto = {
      entityId: 'workshop.jobs:entity.job',
      recordId: randomUUID(),
      revision: 3,
      archived: false,
      values: { 'workshop.jobs:field.job_name': 'Original' },
    };
    const calls: SemanticOperationExecutionRequest[] = [];
    const mediation = new SemanticOperationMediationAuthority();
    const gateways: SurfaceRuntimeGateways = {
      queryGateway: fixedQueryGateway('exact', [root]),
      operationMediation: mediation,
      operationGateway: new SemanticOperationGateway(
        policy,
        {
          async execute(request) {
            calls.push(request);
            if (!withheld && calls.length === 1)
              throw new Error('Simulated lost transport after acceptance');
            return {
              kind: 'semanticOperationResult',
              schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
              operationId: request.definition.operationId,
              outcome: 'succeeded',
              readBack: withheld ? null : { ...root, revision: 4 },
              unsupportedReason: null,
              trust: {
                invocationId: randomUUID(),
                changeDocumentId: randomUUID(),
                domainEventId: randomUUID(),
                outboxId: randomUUID(),
              },
            };
          },
          async recordNonAccepted() {},
        },
        mediation,
      ),
    };
    const url = `/?surface=${encodeURIComponent(surface.surfaceId)}&record=${root.recordId}`;
    const submit = (body: Record<string, string>) =>
      submitCompositionAction(
        view,
        surface,
        url,
        { compositionAction: 'workshop.jobs:action.rename', ...body },
        gateways,
        (html) => ({ statusCode: 200, html }),
      );
    const initial = await submit({});
    const taskToken = hiddenValue(initial.html, 'taskToken');
    const invalid = await submit({
      taskToken,
      taskStage: 'prepare',
      'workshop.jobs:input.title': '',
    });
    assert.match(invalid.html, /COMPOSITION_INPUT_INVALID/);
    assert.equal(calls.length, 0);
    const preview = await submit({
      taskToken,
      taskStage: 'prepare',
      'workshop.jobs:input.title': 'Reviewed title',
    });
    assert.match(preview.html, /Reviewed title/);
    assert.equal(calls.length, 0);
    await assert.rejects(() =>
      gateways.operationGateway.invoke(
        view,
        {
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
          operationId: 'workshop.jobs:operation.job_update',
          input: {
            recordId: root.recordId,
            expectedRevision: 3,
            patch: { 'workshop.jobs:field.job_name': 'Bypass' },
          },
          idempotencyKey: randomUUID(),
          confirmationGrant: null,
        },
        mediation.issueInvocation(view, 'AGENT'),
      ),
    );
    assert.equal(
      calls.length,
      0,
      'the actual gateway rejects missing confirmation',
    );
    const result = await submit({
      taskToken,
      taskStage: 'confirm',
      preparedId: hiddenValue(preview.html, 'preparedId'),
    });
    assert.equal(calls.length, 1);
    if (withheld) {
      assert.match(result.html, /COMPOSITION_COMMITTED_WITHHELD/);
      await submit({ taskToken, taskStage: 'retry' });
      assert.equal(
        calls.length,
        1,
        'no dependent step runs after withheld read-back',
      );
    } else {
      assert.match(result.html, /COMPOSITION_UNCERTAIN/);
      assert.match(result.html, /Reviewed title/);
      const done = await submit({
        taskToken,
        taskStage: 'retry',
        'workshop.jobs:input.title': 'Tampered',
      });
      assert.match(done.html, /COMPOSITION_COMPLETE/);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1]!.input, calls[0]!.input);
      assert.equal(calls[1]!.idempotencyKey, calls[0]!.idempotencyKey);
      assert.deepEqual(calls[1]!.input, {
        recordId: root.recordId,
        expectedRevision: 3,
        patch: { 'workshop.jobs:field.job_name': 'Reviewed title' },
      });
    }
  }
});

test('cached pinned query catalogs keep whole-catalog refusal, view isolation and current policy', async () => {
  const compiled = compileFixture();
  let allowed = true;
  const policy = new RecordingPolicy(() => (allowed ? 'ALLOW' : 'DENY'));
  const identities = { a: identity(tenantA, environmentA, principalA) };
  const view = await issuedView(
    runtimeEntry(compiled, policy, identities),
    'a',
  );
  const queryId = `${FIXTURE_IDS.namespace}:query.master_get`;
  assert.ok(registeredSemanticQueryFromPinnedView(view, queryId));
  assert.ok(registeredSemanticQueryFromPinnedView(view, queryId));
  const mutablePayload = structuredClone(view.projections.query.payload) as {
    queries: unknown[];
  };
  const projectionOnly = {
    projections: {
      query: { ...view.projections.query, payload: mutablePayload },
    },
  } as unknown as RequestRuntimeView;
  assert.ok(registeredSemanticQueryFromPinnedView(projectionOnly, queryId));
  mutablePayload.queries.push(mutablePayload.queries[0]);
  assert.throws(
    () => registeredSemanticQueryFromPinnedView(projectionOnly, queryId),
    /duplicate queryId/,
  );
  const gateway = new SemanticQueryGateway(
    policy,
    new InMemoryGenericExecutor(),
  );
  const request = {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId,
    arguments: {
      recordId: 'a6000000-0000-4000-8000-000000000006',
      includeArchived: false,
    },
  };
  await gateway.invoke(view, request);
  allowed = false;
  await assert.rejects(
    () => gateway.invoke(view, request),
    /permission|denied/i,
  );
  const malformed = await issuedView(
    runtimeEntry(compiled, policy, identities, (projections) => {
      const payload = structuredClone(projections.query.payload) as {
        queries: unknown[];
      };
      payload.queries.push(payload.queries[0]);
      return {
        ...projections,
        query: { ...projections.query, payload: payload as ImmutableJsonValue },
      };
    }),
    'a',
  );
  // A valid first match must not bypass a duplicate later in another view's
  // catalog; failure must not publish a partially validated cache either.
  for (const id of [queryId, `${FIXTURE_IDS.namespace}:query.master_list`])
    assert.throws(
      () => registeredSemanticQueryFromPinnedView(malformed, id),
      /duplicate queryId/,
    );
});

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function correctionTaskFixture(dialog = false, summary = false) {
  const definition = presentedWorkshop('Work title', false, dialog);
  const surface = (definition.surfaces as Array<Record<string, unknown>>).find(
    (value) => value.composition,
  )!;
  const composition = surface.composition as SurfaceComposition;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  // A separate declared permission lets a label dependency fail while root and child reads remain allowed.
  const fields = definition.fields as Array<Record<string, unknown>>;
  const nameField = fields.find(
    (value) => value.fieldId === 'workshop.jobs:field.job_name',
  )!;
  for (const [index, suffix] of ['amount', 'notes', 'utc_instant'].entries())
    fields.push({
      ...structuredClone(nameField),
      fieldId: `workshop.jobs:field.job_${suffix}`,
      label: suffix,
      orderKey: 100 + index,
      presence: 'optional',
    });
  const queries = definition.queries as Array<Record<string, unknown>>;
  for (const type of ['get', 'list']) {
    const source = queries.find(
      (value) => value.queryId === `workshop.jobs:query.job_${type}`,
    )!;
    queries.push({
      ...JSON.parse(
        JSON.stringify(source).replaceAll(
          ':selection.job_',
          ':selection.location_',
        ),
      ),
      queryId: `workshop.jobs:query.location_${type}`,
      permission: ref(
        'permissionReference',
        type === 'get'
          ? 'workshop.jobs:permission.location_label_read'
          : 'workshop.jobs:permission.location_read',
      ),
    });
  }
  for (const suffix of ['location_read', 'location_label_read'])
    (definition.permissions as unknown[]).push({
      kind: 'permissionDefinition',
      schemaVersion: 'v6',
      permissionId: `workshop.jobs:permission.${suffix}`,
      label: 'Read location labels',
      action: 'read',
      resource: ref('entityReference', 'workshop.jobs:entity.job'),
    });
  composition.fields.push({
    columnId: 'workshop.jobs:column.location',
    label: 'Location',
    orderKey: 20,
    field: 'recordId',
    reference: {
      query: ref('queryReference', 'workshop.jobs:query.location_get'),
      labelField: ref('fieldReference', 'workshop.jobs:field.job_name'),
    },
  } as SurfaceComposition['fields'][number]);
  composition.actions = [
    {
      actionId: 'workshop.jobs:action.change',
      label: 'Change assignment',
      description: 'Review assignment inputs.',
      orderKey: 10,
      datasetId: 'workshop.jobs:dataset.assignments',
      conditions: [],
      inputs: [
        {
          inputId: 'workshop.jobs:input.quantity',
          label: 'Quantity',
          orderKey: 10,
          type: 'quantity',
          required: true,
        },
        {
          inputId: 'workshop.jobs:input.location',
          label: 'Location',
          orderKey: 20,
          type: 'reference',
          required: true,
          query: ref('queryReference', 'workshop.jobs:query.location_list'),
          labelField: ref('fieldReference', 'workshop.jobs:field.job_name'),
        },
      ],
      steps: [
        {
          stepId: 'workshop.jobs:step.change',
          operation: ref(
            'operationReference',
            'workshop.jobs:operation.job_update',
          ),
          bindings: [
            {
              path: ['recordId'],
              value: { source: 'record', field: 'recordId' },
            },
            {
              path: ['expectedRevision'],
              value: { source: 'record', field: 'revision' },
            },
            {
              path: ['patch', 'workshop.jobs:field.job_amount'],
              value: {
                source: 'input',
                inputId: 'workshop.jobs:input.quantity',
              },
            },
            {
              path: ['patch', 'workshop.jobs:field.job_notes'],
              value: {
                source: 'input',
                inputId: 'workshop.jobs:input.location',
              },
            },
            {
              path: ['patch', 'workshop.jobs:field.job_utc_instant'],
              value: { source: 'generated', value: 'instant' },
            },
          ],
        },
        {
          stepId: 'workshop.jobs:step.after',
          operation: ref(
            'operationReference',
            'workshop.jobs:operation.job_archive',
          ),
          bindings: [
            {
              path: ['recordId'],
              value: {
                source: 'step',
                stepId: 'workshop.jobs:step.change',
                field: 'recordId',
              },
            },
            {
              path: ['expectedRevision'],
              value: {
                source: 'step',
                stepId: 'workshop.jobs:step.change',
                field: 'revision',
              },
            },
          ],
        },
      ],
    },
  ] as unknown as SurfaceComposition['actions'];
  if (summary) {
    const child = composition.children[0]!;
    const source = fields.find(
      (value) => value.fieldId === 'workshop.jobs:field.assignment_kind',
    )!;
    for (const [index, suffix] of ['amount', 'unit'].entries()) {
      fields.push({
        ...structuredClone(source),
        fieldId: `workshop.jobs:field.assignment_${suffix}`,
        fieldType: {
          kind: 'textFieldType',
          schemaVersion: 'v6',
          maximumLength: 240,
        },
        label: suffix,
        orderKey: 120 + index,
      });
      for (const query of queries.filter(
        (value) =>
          (value.sourceEntity as { targetId: string }).targetId ===
          'workshop.jobs:entity.assignment',
      ))
        (query.selections as unknown[]).push({
          kind: 'querySelection',
          schemaVersion: 'v6',
          selectionId: `workshop.jobs:selection.assignment_${suffix}_${query.queryType}`,
          field: ref(
            'fieldReference',
            `workshop.jobs:field.assignment_${suffix}`,
          ),
          orderKey: 120 + index,
        });
      child.columns.push({
        columnId: `workshop.jobs:column.${suffix}`,
        label: suffix,
        orderKey: 120 + index,
        field: `workshop.jobs:field.assignment_${suffix}`,
        presentation: {
          role: suffix === 'amount' ? 'quantity' : 'secondary',
          priority: 120 + index,
        },
      } as SurfaceComposition['fields'][number]);
    }
    const column = (columnId: string) => ({
      datasetId: child.datasetId,
      columnId: `workshop.jobs:column.${columnId}`,
    });
    composition.actions[0]!.presentation = {
      placement: 'selection',
      task: {
        summary: {
          identity: column('role'),
          quantity: {
            value: column('amount'),
            unit: column('unit'),
            label: 'hours assigned',
          },
        },
        confirmation: {
          title: 'Assign',
          reviewLabel: 'Review assignment',
          confirmLabel: 'Confirm assignment',
          quantity: {
            source: 'input',
            inputId: 'workshop.jobs:input.quantity',
          },
          unit: column('unit'),
          context: { source: 'input', inputId: 'workshop.jobs:input.location' },
        },
      },
    } as NonNullable<SurfaceComposition['actions'][number]['presentation']>;
  }
  (definition.operations as Array<Record<string, unknown>>).find(
    (value) => value.operationId === 'workshop.jobs:operation.job_update',
  )!.confirmation = 'humanRequired';
  const compiled = compileFixture(definition);
  const denied = new Set<string>();
  const policy = new RecordingPolicy((request) =>
    denied.has(request.permissionId) ? 'DENY' : 'ALLOW',
  );
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const root: SemanticRecordDto = {
    entityId: 'workshop.jobs:entity.job',
    recordId: randomUUID(),
    revision: 3,
    archived: false,
    values: { 'workshop.jobs:field.job_name': 'PROTECTED_ROOT_SENTINEL' },
  };
  const child: SemanticRecordDto = {
    entityId: 'workshop.jobs:entity.assignment',
    recordId: randomUUID(),
    revision: 7,
    archived: false,
    values: {
      'workshop.jobs:field.assignment_kind': 'PROTECTED_CHILD_SENTINEL',
      ...(summary
        ? {
            'workshop.jobs:field.assignment_amount': '12',
            'workshop.jobs:field.assignment_unit': 'hours',
          }
        : {}),
    },
  };
  const locations = ['A', 'B'].map((suffix) => ({
    ...root,
    recordId: randomUUID(),
    values: { 'workshop.jobs:field.job_name': `PROTECTED_LOCATION_${suffix}` },
  }));
  const calls: SemanticOperationExecutionRequest[] = [];
  const effects: string[] = [];
  let beforeReferenceList: (() => Promise<void>) | undefined;
  let execute:
    ((request: SemanticOperationExecutionRequest) => Promise<void>) | undefined;
  let withheld = false;
  const mediation = new SemanticOperationMediationAuthority();
  const trust = {
    invocationId: randomUUID(),
    changeDocumentId: randomUUID(),
    domainEventId: randomUUID(),
    outboxId: randomUUID(),
  };
  const gateways: SurfaceRuntimeGateways = {
    queryGateway: new SemanticQueryGateway(policy, {
      async execute(request) {
        if (request.definition.queryId === 'workshop.jobs:query.location_list')
          await beforeReferenceList?.();
        const records = request.definition.queryId.includes(':query.location_')
          ? request.list
            ? locations
            : [locations[0]!]
          : request.list
            ? [child]
            : [root];
        return {
          kind: 'semanticQueryResult',
          schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
          queryId: request.definition.queryId,
          outcome: 'exact',
          unsupportedReason: null,
          records,
          ...(request.list
            ? {
                listCoverage: {
                  ...listCoverage(request, records.length),
                  parentScope: request.list.query.parentScope,
                },
              }
            : {}),
        };
      },
    }),
    operationMediation: mediation,
    operationGateway: new SemanticOperationGateway(
      policy,
      {
        async execute(request) {
          calls.push(request);
          if (!effects.includes(request.idempotencyKey))
            effects.push(request.idempotencyKey);
          await execute?.(request);
          return {
            kind: 'semanticOperationResult',
            schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
            operationId: request.definition.operationId,
            outcome: 'succeeded',
            readBack: withheld ? null : { ...root, revision: 4 },
            unsupportedReason: null,
            trust,
          };
        },
        async recordNonAccepted() {},
      },
      mediation,
    ),
  };
  const url = `/?surface=workshop.jobs%3Asurface.job_record&record=${root.recordId}&dataset=workshop.jobs%3Adataset.assignments&select:workshop.jobs:dataset.assignments=${child.recordId}`;
  const submit = (body: Record<string, string>) =>
    submitSurfaceRuntimeIntent(
      view,
      url,
      { compositionAction: 'workshop.jobs:action.change', ...body },
      gateways,
    );
  const initial = await submit({});
  assert.match(initial.html, /PROTECTED_ROOT_SENTINEL/);
  assert.match(initial.html, /PROTECTED_CHILD_SENTINEL/);
  assert.match(initial.html, /PROTECTED_LOCATION_A/);
  const taskToken = hiddenValue(initial.html, 'taskToken');
  const prepare = (quantity: string, location: string) =>
    submit({
      taskToken,
      taskStage: 'prepare',
      'workshop.jobs:input.quantity': quantity,
      'workshop.jobs:input.location': location,
    });
  const confirmation = (html: string) => ({
    taskToken,
    taskStage: 'confirm',
    preparedId: /name="preparedId" value="([^"]*)"/.exec(html)?.[1] ?? '',
  });
  return {
    initial,
    submit,
    prepare,
    confirmation,
    taskToken,
    denied,
    calls,
    effects,
    locations,
    renameChild(value: string) {
      (child.values as Record<string, string>)[
        'workshop.jobs:field.assignment_kind'
      ] = value;
    },
    trust,
    beforeReferences(value: typeof beforeReferenceList) {
      beforeReferenceList = value;
    },
    onExecute(value: typeof execute) {
      execute = value;
    },
    setWithheld() {
      withheld = true;
    },
  };
}

const assertTaskRedacted = (response: { html: string }) => {
  assert.doesNotMatch(
    JSON.stringify(response),
    /PROTECTED_(?:ROOT_SENTINEL|CHILD_SENTINEL|LOCATION_[AB])/,
    'the complete response must not redisclose protected cached data',
  );
};

test('explicit Task summary and frozen proposal reuse non-Sales declarations in dialog and page', async (t) => {
  for (const dialog of [true, false])
    await t.test(dialog ? 'native dialog' : 'page', async () => {
      const fixture = await correctionTaskFixture(dialog, true);
      const summary =
        fixture.initial.html.match(
          /<section class="composition-task-summary"[^>]*>[\s\S]*?<\/section>/,
        )?.[0] ?? '';
      assert.match(summary, /PROTECTED_CHILD_SENTINEL/);
      assert.match(summary, /12 hours/);
      assert.doesNotMatch(summary, /Version/);
      assert.match(
        fixture.initial.html,
        /<summary>Supporting details<\/summary>/,
      );
      let reads = 0;
      fixture.beforeReferences(async () => {
        if (++reads === 2) {
          fixture.renameChild('CURRENT_ASSIGNMENT_LABEL');
          (fixture.locations[0]!.values as Record<string, string>)[
            'workshop.jobs:field.job_name'
          ] = 'CURRENT_LOCATION_LABEL';
        }
      });
      const review = await fixture.prepare('8', fixture.locations[0]!.recordId);
      const proposed =
        review.html.match(
          /<section class="composition-task-confirmation"[^>]*>[\s\S]*?<\/section>/,
        )?.[0] ?? '';
      assert.match(proposed, /Assign <strong>8 hours<\/strong>/);
      assert.match(proposed, /PROTECTED_CHILD_SENTINEL/);
      assert.match(proposed, /PROTECTED_LOCATION_A/);
      assert.doesNotMatch(proposed, /CURRENT_LOCATION_LABEL/);
      assert.match(review.html, />Confirm assignment<\/button>/);
      assert.equal(fixture.calls.length, 0);
      await fixture.submit({
        ...fixture.confirmation(review.html),
        'workshop.jobs:input.quantity': '99',
        'workshop.jobs:input.location': fixture.locations[1]!.recordId,
      });
      assert.equal(fixture.calls.length, 2);
      assert.equal(
        (fixture.calls[0]!.input as { patch: Record<string, string> }).patch[
          'workshop.jobs:field.job_amount'
        ],
        '8',
      );
      await fixture.submit(fixture.confirmation(review.html));
      assert.equal(fixture.calls.length, 2);
      fixture.denied.add('workshop.jobs:permission.assignment_read');
      assertTaskRedacted(
        await fixture.submit(fixture.confirmation(review.html)),
      );
    });
});

test('Task summaries refuse foreign selections, mismatched scope and undeclared confirmation inputs', () => {
  for (const change of [
    (task: TaskSummary) => {
      task.summary.identity.datasetId = 'northstar.app:dataset.order_shipments';
    },
    (task: TaskSummary) => {
      task.summary.quantity!.unit.datasetId =
        'northstar.app:dataset.fulfillment_lines';
    },
    (task: TaskSummary) => {
      task.confirmation.quantity = {
        source: 'input',
        inputId: 'northstar.app:input.location',
      };
    },
    (task: TaskSummary) => {
      task.summary.identity.columnId = 'northstar.app:column.missing';
    },
  ]) {
    const definition = composedApplicationDefinition();
    const surface = (
      definition.surfaces as Array<{ composition?: SurfaceComposition }>
    ).find((value) =>
      value.composition?.actions.some(
        (action) => action.actionId === 'northstar.app:action.ship_reserved',
      ),
    )!;
    const task = surface.composition!.actions.find(
      (action) => action.actionId === 'northstar.app:action.ship_reserved',
    )!.presentation!.task!;
    change(task as unknown as TaskSummary);
    assert.throws(
      () => compileFixture(definition),
      (error: unknown) =>
        error instanceof CanonicalModelError &&
        /task/.test(JSON.stringify(error)),
    );
  }
});
type TaskSummary = {
  summary: {
    identity: { datasetId: string; columnId: string };
    quantity?: { unit: { datasetId: string } };
  };
  confirmation: {
    quantity:
      | { source: 'input'; inputId: string }
      | { source: 'column'; datasetId: string; columnId: string };
  };
};

/** Bounded order-entry witnesses: real canonical contracts/gateways, synthetic storage. */
/**
 * A well-formed quantity the stub provider refuses as MODULE_FIELD_VALUE_INVALID.
 * The editor admits it -- it is a plain decimal inside the declared bounds -- so
 * it stands for a provider rule the editor cannot know, and the refusal arrives
 * after earlier save steps have committed, which is what F2/F3 exercise.
 */
const PROVIDER_REFUSED_QUANTITY = '404';
/** A line's own value that is visible before read loss and redacted after it. */
const CHILD_SENTINEL = '424242.4242';

class OrderEntryExecutor
  implements SemanticQueryExecutor, SemanticOperationExecutor
{
  readonly rows = new Map<string, SemanticRecordDto>();
  readonly owners = new Map<string, string>();
  readonly calls: SemanticOperationExecutionRequest[] = [];
  readonly receipts = new Map<string, SemanticOperationResultEnvelope>();
  readonly failingQueries = new Set<string>();
  failAt = 0;
  failAfterCommitAt = 0;
  onControlledFailure: (() => void) | null = null;
  withheld = false;
  namespace = 'northstar.app';
  /**
   * Opt-in shared-list paging like the PostgreSQL executor: substring search
   * over the selected fields, pages of the effective size in insertion order,
   * and cursors minted for the exact query shape. Off, every list returns all
   * rows, as the existing witnesses expect.
   */
  pageLists = false;
  /** List executions per query that reached this executor, for bounded-work checks. */
  readonly listReads = new Map<string, number>();
  /**
   * Reads of a query wait while it is held, so a test can deliver answers
   * out of order. `hold` returns the release.
   */
  readonly holds = new Map<string, Promise<void>>();
  hold(queryId: string) {
    let release!: () => void;
    this.holds.set(
      queryId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      this.holds.delete(queryId);
      release();
    };
  }
  seed(
    entity: string,
    values: Record<string, ImmutableJsonValue>,
    scope?: string,
  ) {
    const recordId = randomUUID();
    this.rows.set(recordId, {
      recordId,
      entityId: `${this.namespace}:entity.${entity}`,
      // Like a newly added nullable storage column in the PostgreSQL DTO.
      values: {
        ...(entity === 'purchase_order'
          ? {
              [`${this.namespace}:field.purchase_order_supplier_reference`]:
                null,
            }
          : {}),
        ...values,
      },
      revision: 1,
      archived: false,
    });
    if (scope) this.owners.set(recordId, scope);
    return recordId;
  }
  /** A party with active roles, as the picker's declared eligibility reads them. */
  seedParty(
    values: Record<string, ImmutableJsonValue>,
    roles: readonly ('customer' | 'supplier')[] = ['customer', 'supplier'],
  ) {
    const party = this.seed('party', values);
    for (const role of roles)
      this.seed('party_role', {
        [`${this.namespace}:field.party_role_kind`]: `${this.namespace}:option.${role}`,
        [`${this.namespace}:field.party_role_status`]: `${this.namespace}:option.active`,
        [`${this.namespace}:relation.party_role_party`]: party,
      });
    return party;
  }
  async recordNonAccepted() {}
  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope>;
  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  async execute(
    request: SemanticQueryExecutionRequest | SemanticOperationExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope | SemanticOperationResultEnvelope> {
    if ('arguments' in request) {
      await this.holds.get(request.definition.queryId);
      if (this.failingQueries.has(request.definition.queryId))
        throw new Error('Isolated provider read failure');
      const args = asRecord(request.arguments);
      const scope = request.definition.legalEntityScope
        ? args[request.definition.legalEntityScope.operand.parameterId]
        : null;
      const parent = request.list?.query.parentScope;
      const reference = request.list?.query.referenceScope;
      const fieldFilters = request.list?.query.fieldFilters;
      const related = request.list?.relatedFilter;
      // Like the PostgreSQL executor: exact filters and the related-record
      // existence check apply before paging, and both are echoed.
      const selected = [...this.rows.values()].filter(
        (row) =>
          row.entityId === request.definition.sourceEntityId &&
          (!this.owners.has(row.recordId) ||
            this.owners.get(row.recordId) === scope) &&
          (!row.archived || args.includeArchived === true) &&
          (!args.recordId || row.recordId === args.recordId) &&
          (!parent || row.values[parent.relationId] === parent.recordId) &&
          (!reference ||
            row.values[reference.relationId] === reference.recordId) &&
          (fieldFilters ?? []).every(
            (filter) => row.values[filter.fieldId] === filter.value,
          ) &&
          (!related ||
            [...this.rows.values()].some(
              (candidate) =>
                candidate.entityId === related.relatedEntityId &&
                !candidate.archived &&
                candidate.values[related.relationId] === row.recordId &&
                related.fieldFilters.every(
                  (filter) => candidate.values[filter.fieldId] === filter.value,
                ),
            )),
      );
      // Like the PostgreSQL statement: progress sums the row's active lines
      // and their active done rows inside the row's own company, and an open
      // or before filter narrows the set before paging. Both are echoed.
      // Whole units only in this witness.
      const progress = request.list?.progress;
      const beforeFilters = request.list?.query.beforeFilters;
      const figures = (row: SemanticRecordDto) => {
        if (!progress) return null;
        const company = this.owners.get(row.recordId);
        const active = (candidate: SemanticRecordDto, entityId: string) =>
          candidate.entityId === entityId &&
          !candidate.archived &&
          this.owners.get(candidate.recordId) === company;
        const lines = [...this.rows.values()].filter(
          (candidate) =>
            active(candidate, progress.linesEntityId) &&
            candidate.values[progress.lines.relationId] === row.recordId,
        );
        const ordered = lines.reduce(
          (total, line) => total + Number(line.values[progress.lines.fieldId]),
          0,
        );
        const done = [...this.rows.values()]
          .filter(
            (candidate) =>
              active(candidate, progress.doneEntityId) &&
              lines.some(
                (line) =>
                  candidate.values[progress.done.relationId] === line.recordId,
              ),
          )
          .reduce(
            (total, entry) =>
              total + Number(entry.values[progress.done.fieldId]),
            0,
          );
        const open =
          !progress.openIn ||
          progress.openIn.values.includes(
            String(row.values[progress.openIn.fieldId]),
          )
            ? ordered - done
            : 0;
        return { ordered, done, open };
      };
      // Like the PostgreSQL statement (SUPPLY-WARNINGS): a line's coverage is
      // what its covering rows' related rows hold; its uncovered quantity is
      // what it has open less that, never below zero; per item, free stock --
      // the plus sums less the minus sums over rows holding the item's id, in
      // the row's company, never below zero -- covers it, and the rest is
      // short, stated in the short states only. Covered counts each line at
      // most for what it has open. Whole units only in this witness.
      const supplied = new Map<string, { covered: number; short: number }>();
      const supplyOf = (row: SemanticRecordDto) => {
        const supply = progress?.supply;
        if (!progress || !supply) return null;
        const known = supplied.get(row.recordId);
        if (known) return known;
        const company = this.owners.get(row.recordId);
        const entityOf = (queryId: string) =>
          progress.supplyEntityIds![queryId]!;
        const live = (candidate: SemanticRecordDto, entityId: string) =>
          candidate.entityId === entityId &&
          !candidate.archived &&
          this.owners.get(candidate.recordId) === company;
        const all = [...this.rows.values()];
        const holding = (
          related: { queryId: string; relationId: string; fieldId: string },
          held: SemanticRecordDto,
        ) =>
          all
            .filter(
              (candidate) =>
                live(candidate, entityOf(related.queryId)) &&
                candidate.values[related.relationId] === held.recordId,
            )
            .reduce(
              (total, candidate) =>
                total + Number(candidate.values[related.fieldId]),
              0,
            );
        const lines = all
          .filter(
            (candidate) =>
              live(candidate, progress.linesEntityId) &&
              candidate.values[progress.lines.relationId] === row.recordId,
          )
          .map((line) => {
            const done = all
              .filter(
                (candidate) =>
                  live(candidate, progress.doneEntityId) &&
                  candidate.values[progress.done.relationId] === line.recordId,
              )
              .reduce(
                (total, entry) =>
                  total + Number(entry.values[progress.done.fieldId]),
                0,
              );
            const covered = all
              .filter(
                (candidate) =>
                  live(candidate, entityOf(supply.coverage.queryId)) &&
                  candidate.values[supply.coverage.relationId] ===
                    line.recordId,
              )
              .reduce(
                (total, cover) =>
                  total + holding(supply.coverage.related, cover),
                0,
              );
            return {
              item: String(line.values[supply.itemFieldId] ?? ''),
              open: Number(line.values[progress.lines.fieldId]) - done,
              covered,
            };
          });
        // A parent through a relation, or the record whose id the rows hold
        // in a reference field: a location belongs to no company.
        const parentHolds = (
          candidate: SemanticRecordDto,
          within: NonNullable<(typeof supply.free.plus)[number]['within']>,
        ) => {
          const parent = this.rows.get(
            String(
              candidate.values[
                within.referenceFieldId ?? within.relationId ?? ''
              ],
            ),
          );
          return (
            parent !== undefined &&
            parent.entityId === entityOf(within.queryId) &&
            !parent.archived &&
            (within.referenceFieldId !== undefined ||
              this.owners.get(parent.recordId) === company) &&
            within.values.includes(String(parent.values[within.fieldId]))
          );
        };
        const part = (sum: (typeof supply.free.plus)[number], item: string) =>
          all
            .filter(
              (candidate) =>
                live(candidate, entityOf(sum.rows.queryId)) &&
                candidate.values[sum.rows.matchFieldId] === item &&
                (!sum.within || parentHolds(candidate, sum.within)),
            )
            .reduce((total, candidate) => {
              const quantity = sum.rows.quantityFieldId
                ? Number(candidate.values[sum.rows.quantityFieldId])
                : 0;
              const related = sum.related ? holding(sum.related, candidate) : 0;
              return (
                total +
                (sum.sum === 'rows'
                  ? quantity
                  : sum.sum === 'related'
                    ? related
                    : Math.max(quantity - related, 0))
              );
            }, 0);
        const uncovered = new Map<string, number>();
        for (const line of lines)
          uncovered.set(
            line.item,
            (uncovered.get(line.item) ?? 0) +
              Math.max(line.open - line.covered, 0),
          );
        const stated =
          !supply.shortIn ||
          supply.shortIn.values.includes(
            String(row.values[supply.shortIn.fieldId]),
          );
        let short = 0;
        if (stated)
          for (const [item, left] of uncovered) {
            if (left <= 0) continue;
            const free =
              supply.free.plus.reduce(
                (total, sum) => total + part(sum, item),
                0,
              ) -
              supply.free.minus.reduce(
                (total, sum) => total + part(sum, item),
                0,
              );
            short += Math.max(left - Math.max(free, 0), 0);
          }
        const answer = {
          covered: lines.reduce(
            (total, line) =>
              total + Math.min(line.covered, Math.max(line.open, 0)),
            0,
          ),
          short,
        };
        supplied.set(row.recordId, answer);
        return answer;
      };
      // Like the PostgreSQL statement (REPLENISHMENT): each figure adds up
      // rows of its own query's entity that hold the listed row's id, in the
      // List's company; totals, bands and the latest parent follow, and a
      // kept band narrows the set before paging. Echoed like progress.
      const listed = request.list?.figures;
      const figured = new Map<
        string,
        {
          values: Record<string, string | null>;
          labels: Record<string, string | null>;
        }
      >();
      const figuresOf = (row: SemanticRecordDto) => {
        if (!listed) return null;
        const known = figured.get(row.recordId);
        if (known) return known;
        const entityOf = (queryId: string) => listed.entityIds[queryId]!;
        const live = (candidate: SemanticRecordDto, queryId: string) =>
          candidate.entityId === entityOf(queryId) &&
          !candidate.archived &&
          this.owners.get(candidate.recordId) === scope;
        const matching = (rows: { queryId: string; matchFieldId: string }) =>
          [...this.rows.values()].filter(
            (candidate) =>
              live(candidate, rows.queryId) &&
              candidate.values[rows.matchFieldId] === row.recordId,
          );
        // A parent through a relation, or the record whose id the rows hold
        // in a reference field: a location belongs to no company (LOCATIONS).
        const parentOf = (
          candidate: SemanticRecordDto,
          within: {
            fieldId: string;
            queryId: string;
            relationId?: string;
            referenceFieldId?: string;
            values: readonly string[];
          },
        ) => {
          const parent = this.rows.get(
            String(
              candidate.values[
                within.referenceFieldId ?? within.relationId ?? ''
              ],
            ),
          );
          return parent &&
            (within.referenceFieldId === undefined
              ? live(parent, within.queryId)
              : parent.entityId === entityOf(within.queryId) &&
                !parent.archived) &&
            within.values.includes(String(parent.values[within.fieldId]))
            ? parent
            : null;
        };
        const values: Record<string, string | null> = {};
        const labels: Record<string, string | null> = {};
        const numbers = new Map<string, number | null>();
        for (const sum of listed.figures.sums) {
          let total = 0;
          for (const candidate of matching(sum.rows)) {
            if (sum.within && !parentOf(candidate, sum.within)) continue;
            const quantity = sum.rows.quantityFieldId
              ? Number(candidate.values[sum.rows.quantityFieldId])
              : 0;
            const related = sum.related
              ? [...this.rows.values()]
                  .filter(
                    (pointing) =>
                      live(pointing, sum.related!.queryId) &&
                      pointing.values[sum.related!.relationId] ===
                        candidate.recordId,
                  )
                  .reduce(
                    (added, pointing) =>
                      added + Number(pointing.values[sum.related!.fieldId]),
                    0,
                  )
              : 0;
            total +=
              sum.sum === 'rows'
                ? quantity
                : sum.sum === 'related'
                  ? related
                  : Math.max(quantity - related, 0);
          }
          numbers.set(sum.figureId, total);
        }
        const operand = (value: { figureId: string } | { fieldId: string }) => {
          if ('figureId' in value) return numbers.get(value.figureId) ?? null;
          const stated = row.values[value.fieldId];
          return stated === null || stated === undefined
            ? null
            : Number(stated);
        };
        // CATALOG-EXTRAS: by the row's own enumeration, a field, a figure,
        // or the List company's percentage of one; nothing stated, nothing.
        const taken = (
          value:
            | { figureId: string }
            | { fieldId: string }
            | {
                percent: {
                  of: { figureId: string } | { fieldId: string };
                  company: { queryId: string; fieldId: string };
                };
              }
            | undefined,
        ) => {
          if (value === undefined) return null;
          if (!('percent' in value)) return operand(value);
          const of = operand(value.percent.of);
          const company = this.rows.get(String(scope));
          const percent =
            company?.entityId === entityOf(value.percent.company.queryId)
              ? company.values[value.percent.company.fieldId]
              : undefined;
          return of === null || percent === null || percent === undefined
            ? null
            : (of * Number(percent)) / 100;
        };
        for (const choice of listed.figures.choices ?? []) {
          const by = String(row.values[choice.byFieldId] ?? '');
          const hit = choice.cases.find((entry) => entry.values.includes(by));
          numbers.set(
            choice.figureId,
            hit ? taken(hit.value) : taken(choice.otherwise),
          );
        }
        for (const total of listed.figures.totals ?? []) {
          const parts = [
            ...total.plus.map((value) => operand(value)),
            ...total.minus.map((value) => {
              const part = operand(value);
              return part === null ? null : -part;
            }),
          ];
          // An unstated field leaves the total unstated, never 0.
          const added = parts.some((part) => part === null)
            ? null
            : parts.reduce<number>((sum, part) => sum + part!, 0);
          numbers.set(
            total.figureId,
            added !== null && total.floor === 'zero'
              ? Math.max(added, 0)
              : added,
          );
        }
        for (const [figureId, number] of numbers)
          values[figureId] = number === null ? null : String(number);
        for (const band of listed.figures.bands ?? []) {
          const of = numbers.get(band.of) ?? null;
          const hit = band.cases.find((entry) => {
            if (entry.when)
              return entry.when.values.includes(
                String(row.values[entry.when.fieldId]),
              );
            const compared = entry.below ?? entry.atMost!;
            const threshold =
              'value' in compared ? Number(compared.value) : operand(compared);
            if (of === null || threshold === null) return false;
            return entry.below ? of < threshold : of <= threshold;
          });
          values[band.figureId] = hit ? hit.value : band.otherwise;
        }
        for (const latest of listed.figures.latest ?? []) {
          const parents = matching(latest.rows)
            .map((candidate) => parentOf(candidate, latest.within))
            .filter((parent): parent is SemanticRecordDto => parent !== null)
            .sort(
              (left, right) =>
                String(right.values[latest.byFieldId] ?? '').localeCompare(
                  String(left.values[latest.byFieldId] ?? ''),
                ) || right.recordId.localeCompare(left.recordId),
            );
          const value = parents[0]?.values[latest.valueFieldId];
          const labelled =
            typeof value === 'string' ? this.rows.get(value) : undefined;
          values[latest.figureId] = typeof value === 'string' ? value : null;
          labels[latest.figureId] =
            labelled?.entityId === entityOf(latest.label.queryId)
              ? displayValue(labelled.values[latest.label.fieldId])
              : null;
        }
        const answer = { values, labels };
        figured.set(row.recordId, answer);
        return answer;
      };
      const kept = request.list?.query.figures?.keep;
      const narrowed = selected.filter(
        (row) =>
          (!kept ||
            kept.values.includes(
              String(figuresOf(row)?.values[kept.figureId]),
            )) &&
          (!progress?.openOnly || (figures(row)?.open ?? 0) > 0) &&
          (!progress?.supply?.keep ||
            (supplyOf(row)?.[progress.supply.keep] ?? 0) > 0) &&
          (beforeFilters ?? []).every((filter) => {
            const value = row.values[filter.fieldId];
            return (
              typeof value === 'string' &&
              Date.parse(value) < Date.parse(filter.before)
            );
          }),
      );
      const project = (row: SemanticRecordDto) => {
        const listedFigures = figuresOf(row);
        if (listedFigures) {
          const projected = projectedListRecord(request, row);
          return {
            ...projected,
            values: { ...projected.values, ...listedFigures.values },
            displayValues: {
              ...projected.displayValues,
              ...listedFigures.labels,
            },
          };
        }
        const projected = projectedListRecord(request, row);
        const summed = figures(row);
        const supply = supplyOf(row);
        return summed && progress
          ? {
              ...projected,
              values: {
                ...projected.values,
                [progress.outputs.ordered]: String(summed.ordered),
                [progress.outputs.done]: String(summed.done),
                [progress.outputs.open]: String(summed.open),
                ...(supply && progress.supply
                  ? {
                      [progress.supply.outputs.covered]: String(supply.covered),
                      [progress.supply.outputs.short]: String(supply.short),
                    }
                  : {}),
              },
            }
          : projected;
      };
      const echoed = {
        ...(reference ? { referenceScope: reference } : {}),
        ...(fieldFilters ? { fieldFilters } : {}),
        ...(request.list?.query.relatedFilter
          ? { relatedFilter: request.list.query.relatedFilter }
          : {}),
        ...(request.list?.query.progress
          ? { progress: request.list.query.progress }
          : {}),
        ...(request.list?.query.figures
          ? { figures: request.list.query.figures }
          : {}),
        ...(beforeFilters ? { beforeFilters } : {}),
        ...(request.list?.query.outputMode
          ? { outputMode: request.list.query.outputMode }
          : {}),
      };
      if (request.list)
        this.listReads.set(
          request.definition.queryId,
          (this.listReads.get(request.definition.queryId) ?? 0) + 1,
        );
      if (request.list && this.pageLists) {
        const query = request.list.query;
        const term = query.search.trim().toLowerCase();
        const children = request.list.searchChildren ?? [];
        const matching = term
          ? narrowed.filter(
              (row) =>
                request.definition.selections.some(({ fieldId }) =>
                  String(row.values[fieldId] ?? '')
                    .toLowerCase()
                    .includes(term),
                ) ||
                // CATALOG-EXTRAS: or through an active child holding it.
                children.some((child) =>
                  [...this.rows.values()].some(
                    (candidate) =>
                      candidate.entityId === child.childEntityId &&
                      !candidate.archived &&
                      candidate.values[child.relationId] === row.recordId &&
                      String(candidate.values[child.fieldId] ?? '')
                        .toLowerCase()
                        .includes(term),
                  ),
                ),
            )
          : narrowed;
        const page = matching.slice(
          query.pageOffset,
          query.pageOffset + query.effectivePageSize,
        );
        const hasMore = query.pageOffset + page.length < matching.length;
        return {
          kind: 'semanticQueryResult',
          schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
          queryId: request.definition.queryId,
          outcome: 'exact',
          records: page.map(project),
          unsupportedReason: null,
          listCoverage: {
            ...listCoverage(request, page.length),
            hasMore,
            nextCursor: hasMore
              ? encodeSharedListCursor(
                  request.definition.queryId,
                  query,
                  query.pageOffset + page.length,
                )
              : null,
            parentScope: parent ?? null,
            totalCount: matching.length,
            ...echoed,
          },
        };
      }
      // Like the PostgreSQL resolve: an exact case-folded match of the text
      // on the declared keys; one identifier match and no name match is
      // exact, anything else that matched is ambiguous (WAREHOUSE-MODE).
      if (request.definition.queryType === 'resolve') {
        const text = String(args.text ?? '').toLowerCase();
        const matching = (authority: 'advisory' | 'identifier') =>
          selected.filter((row) =>
            (request.definition.resolveMatchKeys ?? []).some(
              (key) =>
                key.authority === authority &&
                String(row.values[key.fieldId] ?? '').toLowerCase() === text,
            ),
          );
        const identifiers = matching('identifier');
        const advisories = matching('advisory');
        const resolved = [...new Set([...identifiers, ...advisories])];
        return {
          kind: 'semanticQueryResult',
          schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
          queryId: request.definition.queryId,
          outcome:
            resolved.length === 0
              ? 'not-found'
              : identifiers.length === 1 && advisories.length === 0
                ? 'exact'
                : 'ambiguous',
          records: resolved,
          unsupportedReason: null,
        };
      }
      const records = request.list ? narrowed.map(project) : selected;
      return {
        kind: 'semanticQueryResult',
        schemaVersion: SEMANTIC_QUERY_RESULT_VERSION,
        queryId: request.definition.queryId,
        outcome: records.length || request.list ? 'exact' : 'not-found',
        records,
        unsupportedReason: null,
        ...(request.list
          ? {
              listCoverage: {
                ...listCoverage(request, records.length),
                parentScope: parent ?? null,
                ...echoed,
              },
            }
          : {}),
      };
    }
    this.calls.push(request);
    if (this.failAt === this.calls.length) {
      this.onControlledFailure?.();
      throw new Error('Isolated line failure');
    }
    const cached = this.receipts.get(request.idempotencyKey);
    if (cached) return cached;
    const input = asRecord(request.input);
    const recordId = String(input.recordId);
    const previous = this.rows.get(recordId);
    if (previous && input.expectedRevision !== previous.revision)
      throw new ModuleRuntimeInterpreterError(
        'MODULE_REVISION_CONFLICT',
        'Isolated stale line',
      );
    if (
      previous?.archived &&
      request.definition.effect.kind === 'archiveRecordEffect'
    )
      throw new ModuleRuntimeInterpreterError(
        'MODULE_MUTATION_CONFLICT',
        'Isolated duplicate archive',
      );
    if (
      Object.entries(asRecord(input.values ?? input.patch ?? {})).some(
        ([fieldId, value]) =>
          fieldId.endsWith('_ordered_quantity') &&
          value === PROVIDER_REFUSED_QUANTITY,
      )
    ) {
      this.onControlledFailure?.();
      throw new ModuleRuntimeInterpreterError(
        'MODULE_FIELD_VALUE_INVALID',
        'Isolated invalid quantity',
      );
    }
    const local =
      request.definition.effect.entity.targetId.split(':entity.')[1]!;
    const stored = operationRecord(request, previous, recordId, {
      ...(!previous &&
      ['sales_order', 'service_request', 'purchase_order'].includes(local)
        ? {
            [`${this.namespace}:derived_state_field.machine.${local}_lifecycle`]: `${this.namespace}:state.${local}_draft`,
          }
        : {}),
      ...asRecord(input.values ?? input.patch ?? {}),
      ...asRecord(input.relations ?? {}),
    });
    this.rows.set(recordId, stored);
    if (input.legalEntityId)
      this.owners.set(recordId, String(input.legalEntityId));
    const result: SemanticOperationResultEnvelope = {
      kind: 'semanticOperationResult',
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: this.withheld ? null : stored,
      unsupportedReason: null,
      trust: {
        changeDocumentId: randomUUID(),
        domainEventId: randomUUID(),
        invocationId: randomUUID(),
        outboxId: randomUUID(),
      },
    };
    this.receipts.set(request.idempotencyKey, result);
    if (this.failAfterCommitAt === this.calls.length) {
      this.onControlledFailure?.();
      throw new Error('Isolated response failure after commit');
    }
    return result;
  }
}
async function orderEntryWitness(
  variant = false,
  /** A metadata variation applied to the authored package before it compiles. */
  mutate: (
    source: ReturnType<typeof composedApplicationDefinition>,
  ) => void = () => {},
) {
  const source = composedApplicationDefinition();
  mutate(source);
  if (variant)
    for (const surface of source.surfaces as Array<Record<string, unknown>>) {
      if (String(surface.surfaceId).endsWith(':surface.purchase_order_detail'))
        surface.label = 'Service procurement';
      const editor = surface.documentEditor as
        { lineFields: Array<{ fieldId: string; label: string }> } | undefined;
      if (
        editor &&
        String(surface.surfaceId).includes(':surface.purchase_order_')
      )
        for (const field of editor.lineFields)
          if (field.label === 'Quantity') field.label = 'Requested units';
    }
  const compiled = compileFixture(source);
  const executor = new OrderEntryExecutor();
  const ns = executor.namespace;
  const scopes = [randomUUID(), randomUUID()];
  const allowed = new Set<string>(scopes);
  const deniedReads = new Set<string>();
  const policy = new RecordingPolicy((request) => {
    const input = asRecord(request.decisionInput);
    return deniedReads.has(request.permissionId) ||
      (input.kind === 'legalEntityReadScopePolicyInput' &&
        !allowed.has(String(input.legalEntityId)))
      ? 'DENY'
      : 'ALLOW';
  });
  for (const [index, scope] of scopes.entries())
    executor.rows.set(scope, {
      entityId: `${ns}:entity.legal_entity`,
      recordId: scope,
      revision: 1,
      archived: false,
      values: {
        [`${ns}:field.legal_entity_name`]: `Company ${index + 1}`,
        [`${ns}:field.legal_entity_status`]: `${ns}:option.legal_entity_status_active`,
      },
    });
  const party = executor.seedParty({
    [`${ns}:field.party_name`]: 'Readable customer',
  });
  const item = executor.seed('item', {
    [`${ns}:field.item_name`]: 'Readable product',
    [`${ns}:field.item_sku`]: 'SKU-WITNESS',
    [`${ns}:field.item_base_unit`]: 'EA',
  });
  const principal = randomUUID();
  const entry = runtimeEntry(compiled, policy, {
    a: identity(tenantA, environmentA, principal),
    b: identity(tenantA, environmentB, principal),
    c: identity(tenantB, environmentA, principal),
    d: identity(tenantA, environmentA, randomUUID()),
  });
  const view = await issuedView(entry, 'a');
  const surfaces = readCompiledSurfaceManifest(view).surfaces;
  const local = variant ? 'purchase_order' : 'sales_order';
  const form = surfaces.find(
    (value) => value.surfaceId === `${ns}:surface.${local}_form`,
  )!;
  const list = surfaces.find(
    (value) => value.surfaceId === `${ns}:surface.${local}_list`,
  )!;
  const gateways: SurfaceRuntimeGateways = {
    ...semanticGateways(policy, executor),
    queryGateway: new SemanticQueryGateway(
      policy,
      executor,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        'northstar.sales:capability.fulfillment': async ({ result }) => result,
        // The purchase order page reads its record with its totals
        // (PURCHASING-PARITY); this witness states none of them, as the read
        // model does for a figure it cannot state.
        'northstar.sales:capability.commercial': async ({
          definition,
          result,
        }) => ({
          ...result,
          records: result.records.map((record) => ({
            ...record,
            values: {
              ...record.values,
              ...Object.fromEntries(
                Object.values(definition.readModel!.resultFields).map(
                  (fieldId) => [fieldId, null],
                ),
              ),
            },
          })),
        }),
        'northstar.inventory:capability.valuation': async ({
          definition,
          result,
        }) => ({
          ...result,
          records: result.records.map((record) => ({
            ...record,
            values: {
              ...record.values,
              ...Object.fromEntries(
                Object.values(definition.readModel!.resultFields).map(
                  (field) => [field, null],
                ),
              ),
            },
          })),
        }),
      },
    ),
  };
  const url = new URL(
    `http://fixture.local/?surface=${encodeURIComponent(form.surfaceId)}&${encodeURIComponent(`${ns}:parameter.${local}_get_legal_entity_scope`)}=${scopes[0]}`,
  );
  const open = () =>
    documentEditor(view, form, surfaces, url, scopes[0]!, gateways);
  const post = (
    rendered: NonNullable<Awaited<ReturnType<typeof open>>>,
    action: string,
    values: Record<string, string> = {},
  ) =>
    documentEditor(view, form, surfaces, url, scopes[0]!, gateways, {
      draftSession: hiddenValue(rendered.slots!.keyFacts!, 'draftSession'),
      draftVersion: hiddenValue(rendered.slots!.keyFacts!, 'draftVersion'),
      draftAction: action,
      ...values,
    });
  const values = (rendered: NonNullable<Awaited<ReturnType<typeof open>>>) => {
    const result: Record<string, string> = {};
    const html = Object.values(rendered.slots!).join('');
    for (const match of html.matchAll(/name="(draft:[^"]+)"/g)) {
      const field = match[1]!;
      const name = field.split(':field.')[1]!;
      result[field] = name.endsWith('_number')
        ? 'SO-WITNESS'
        : name.endsWith('_customer_party_id') ||
            name.endsWith('_supplier_party_id')
          ? party
          : name.endsWith('_item_id')
            ? item
            : name.endsWith('_order_date')
              ? '2026-09-15T12:00'
              : name.endsWith('_currency')
                ? 'CAD'
                : name.endsWith('_ordered_quantity')
                  ? '10'
                  : name.endsWith('_unit_id')
                    ? 'EA'
                    : name.endsWith('_unit_price')
                      ? '12.5'
                      : '';
    }
    return result;
  };
  return {
    executor,
    ns,
    party,
    item,
    scopes,
    allowed,
    deniedReads,
    policy,
    entry,
    view,
    surfaces,
    form,
    list,
    gateways,
    url,
    open,
    post,
    values,
  };
}

type OrderEntryWitness = Awaited<ReturnType<typeof orderEntryWitness>>;

async function persistedDraft(f: OrderEntryWitness, lineCount = 1) {
  let editor = (await f.open())!;
  for (let index = 1; index < lineCount; index++)
    editor = (await f.post(editor, 'add', f.values(editor)))!;
  const saved = (await f.post(editor, 'save', f.values(editor)))!;
  assert.equal(saved.statusCode, 303);
  const recordId = new URL(
    saved.location!,
    'http://fixture.local',
  ).searchParams.get('record')!;
  f.url.searchParams.set('record', recordId);
  return { editor: (await f.open())!, recordId };
}

function draftField(
  values: Record<string, string>,
  rowId: string,
  suffix: string,
) {
  const field = Object.keys(values).find(
    (candidate) => candidate.includes(rowId) && candidate.endsWith(suffix),
  );
  assert.ok(field, `missing ${suffix} input for ${rowId}`);
  return field;
}

const assertDraftOutcomeRedacted = (response: {
  html: string;
  statusCode: number;
}) => {
  assert.equal(response.statusCode, 200);
  assert.match(response.html, /DRAFT_EDITOR_PARTIAL_COMMIT_WITHHELD/);
  assert.doesNotMatch(
    response.html,
    /PROTECTED_(?:ROOT|CHILD)_SENTINEL|424242\.4242|<form\b|<button\b|data-draft-line/,
  );
};

test('order entry: unrelated metadata renders the shared editor; partial save freezes exact retry and duplicate replay', async () => {
  const f = await orderEntryWitness(true);
  let form = (await f.open())!;
  // The product picker searches the declared list query; nothing is preloaded.
  assert.doesNotMatch(form.slots!.sections!, /Readable product/);
  assert.match(form.slots!.sections!, /Requested units/);
  const lineId = /data-draft-line="([^"]+)"/.exec(form.slots!.sections!)![1]!;
  const productField = `${f.ns}:field.purchase_order_line_item_id`;
  form = (await f.post(form, `search:${lineId}:${productField}`, {
    [`draftSearch:${lineId}:${productField}`]: 'Readable',
  }))!;
  assert.match(
    form.slots!.sections!,
    /<strong>Readable product<\/strong><small>SKU-WITNESS · EA<\/small>/,
  );
  form = (await f.post(form, 'add', f.values(form)))!;
  const values = f.values(form);
  f.executor.failAt = 3;
  const failed = (await f.post(form, 'save', values))!;
  assert.equal(failed.statusCode, 422);
  assert.match(failed.slots!.keyFacts!, /committed/);
  assert.match(failed.slots!.commandBar!, /Retry save/);
  assert.equal(
    [...f.executor.rows.values()].filter((row) =>
      row.entityId.endsWith(':entity.purchase_order_line'),
    ).length,
    1,
  );
  const failedCall = f.executor.calls[2]!;
  const input = structuredClone(failedCall.input);
  f.executor.failAt = 0;
  f.url.searchParams.set(
    'record',
    String(asRecord(f.executor.calls[0]!.input).recordId),
  );
  const completed = await f.post(
    failed,
    'retry',
    Object.fromEntries(Object.keys(values).map((key) => [key, 'forged'])),
  );
  assert.equal(completed!.statusCode, 303);
  assert.deepEqual(f.executor.calls[3]!.input, input);
  assert.equal(f.executor.calls[3]!.idempotencyKey, failedCall.idempotencyKey);
  assert.equal(
    f.executor.calls.filter((call) =>
      call.definition.operationId.endsWith('.purchase_order_create'),
    ).length,
    1,
  );
  const duplicate = await f.post(failed, 'retry');
  assert.equal(duplicate!.location, completed!.location);
  assert.equal(f.executor.calls.length, 4);
  const lines = [...f.executor.rows.values()].filter((row) =>
    row.entityId.endsWith(':entity.purchase_order_line'),
  );
  assert.equal(lines.length, 2);
  assert.ok(
    lines.every(
      (row) =>
        row.values[`${f.ns}:relation.purchase_order_line_order`] ===
          f.url.searchParams.get('record') &&
        f.executor.owners.get(row.recordId) === f.scopes[0],
    ),
  );
});

test('order entry F1: a receipt-persisted header update bypasses only the fresh-edit check and retries its exact frozen request', async () => {
  const f = await orderEntryWitness();
  const { editor, recordId } = await persistedDraft(f);
  const line = [...f.executor.rows.values()].find((candidate) =>
    candidate.entityId.endsWith(':entity.sales_order_line'),
  )!;
  const changed = f.values(editor);
  changed[draftField(changed, recordId, '_notes')] = 'recovered header';
  changed[draftField(changed, line.recordId, '_ordered_quantity')] = '11';
  f.executor.failAfterCommitAt = f.executor.calls.length + 1;
  const failed = (await f.post(editor, 'save', changed))!;
  assert.equal(failed.statusCode, 422);
  const failedCall = f.executor.calls.at(-1)!;
  assert.ok(f.executor.receipts.has(failedCall.idempotencyKey));
  assert.equal(f.executor.rows.get(recordId)!.revision, 2);
  f.executor.failAfterCommitAt = 0;
  const retried = await f.post(
    failed,
    'retry',
    Object.fromEntries(Object.keys(changed).map((key) => [key, 'forged'])),
  );
  assert.equal(retried!.statusCode, 303);
  const replay = f.executor.calls.at(-2)!;
  assert.equal(replay.idempotencyKey, failedCall.idempotencyKey);
  assert.deepEqual(replay.input, failedCall.input);
  assert.equal(f.executor.rows.get(recordId)!.revision, 2);
  assert.equal(
    f.executor.rows.get(line.recordId)!.values[
      `${f.ns}:field.sales_order_line_ordered_quantity`
    ],
    '11',
  );

  const denied = await orderEntryWitness();
  const deniedDraft = await persistedDraft(denied);
  const deniedValues = denied.values(deniedDraft.editor);
  deniedValues[draftField(deniedValues, deniedDraft.recordId, '_notes')] =
    'authorized once';
  denied.executor.failAfterCommitAt = denied.executor.calls.length + 1;
  const deniedFailure = (await denied.post(
    deniedDraft.editor,
    'save',
    deniedValues,
  ))!;
  const deniedRequest = denied.executor.calls.at(-1)!;
  denied.deniedReads.add(deniedRequest.definition.permissionId);
  denied.executor.failAfterCommitAt = 0;
  const callCount = denied.executor.calls.length;
  const refused = await denied.post(deniedFailure, 'retry');
  assert.equal(refused!.statusCode, 422);
  assert.equal(denied.executor.calls.length, callCount);
});

test('order entry F2: a completed archive is reconciled after correctable line input while an unexecuted removal still confirms', async () => {
  const f = await orderEntryWitness();
  let { editor } = await persistedDraft(f, 2);
  const lines = [...f.executor.rows.values()].filter((candidate) =>
    candidate.entityId.endsWith(':entity.sales_order_line'),
  );
  const [removed, corrected] = lines;
  const invalid = f.values(editor);
  invalid[draftField(invalid, corrected!.recordId, '_ordered_quantity')] =
    PROVIDER_REFUSED_QUANTITY;
  editor = (await f.post(editor, `remove:${removed!.recordId}`, invalid))!;
  const review = (await f.post(editor, 'save', invalid))!;
  assert.match(review.slots!.commandBar!, /Confirm removal and save/);
  const failed = (await f.post(review, 'confirm'))!;
  assert.equal(failed.statusCode, 422);
  assert.equal(f.executor.rows.get(removed!.recordId)!.archived, true);
  const repaired = f.values(failed);
  repaired[draftField(repaired, corrected!.recordId, '_ordered_quantity')] =
    '12';
  const completed = await f.post(failed, 'save', repaired);
  assert.equal(completed!.statusCode, 303);
  assert.equal(
    f.executor.calls.filter(
      (call) => call.definition.effect.kind === 'archiveRecordEffect',
    ).length,
    1,
  );
  assert.equal(
    f.executor.rows.get(corrected!.recordId)!.values[
      `${f.ns}:field.sales_order_line_ordered_quantity`
    ],
    '12',
  );

  const pending = await orderEntryWitness();
  ({ editor } = await persistedDraft(pending, 2));
  const pendingLines = [...pending.executor.rows.values()].filter((candidate) =>
    candidate.entityId.endsWith(':entity.sales_order_line'),
  );
  const [invalidLine, stillRemoved] = pendingLines;
  const pendingValues = pending.values(editor);
  pendingValues[
    draftField(pendingValues, invalidLine!.recordId, '_ordered_quantity')
  ] = PROVIDER_REFUSED_QUANTITY;
  editor = (await pending.post(
    editor,
    `remove:${stillRemoved!.recordId}`,
    pendingValues,
  ))!;
  const pendingReview = (await pending.post(editor, 'save', pendingValues))!;
  const pendingFailure = (await pending.post(pendingReview, 'confirm'))!;
  const correctedValues = pending.values(pendingFailure);
  correctedValues[
    draftField(correctedValues, invalidLine!.recordId, '_ordered_quantity')
  ] = '12';
  const secondReview = (await pending.post(
    pendingFailure,
    'save',
    correctedValues,
  ))!;
  assert.match(secondReview.slots!.commandBar!, /Confirm removal and save/);
  assert.equal(
    pending.executor.calls.filter(
      (call) => call.definition.effect.kind === 'archiveRecordEffect',
    ).length,
    0,
  );
});

test('order entry F3: post-execution read refusal returns a redacted partial-commit outcome without another mutation', async (t) => {
  const exercise = async (readFailure: 'authorization' | 'provider') => {
    const f = await orderEntryWitness();
    const { editor, recordId } = await persistedDraft(f);
    const line = [...f.executor.rows.values()].find((candidate) =>
      candidate.entityId.endsWith(':entity.sales_order_line'),
    )!;
    const changed = f.values(editor);
    changed[draftField(changed, recordId, '_notes')] =
      'PROTECTED_ROOT_SENTINEL';
    changed[draftField(changed, line.recordId, '_ordered_quantity')] = '13';
    f.executor.failAt = f.executor.calls.length + 2;
    f.executor.onControlledFailure = () => {
      if (readFailure === 'authorization') {
        f.deniedReads.add(`${f.ns}:permission.sales_order_read`);
        f.deniedReads.add(`${f.ns}:permission.sales_order_line_read`);
      } else f.executor.failingQueries.add(f.form.dataSourceQueryId);
    };
    const submission = {
      draftSession: hiddenValue(editor.slots!.keyFacts!, 'draftSession'),
      draftVersion: hiddenValue(editor.slots!.keyFacts!, 'draftVersion'),
      draftAction: 'save',
      ...changed,
    };
    const response = await submitSurfaceRuntimeIntent(
      f.view,
      f.url.pathname + f.url.search,
      submission,
      f.gateways,
    );
    assertDraftOutcomeRedacted(response);
    const calls = f.executor.calls.length;
    const repeated = await submitSurfaceRuntimeIntent(
      f.view,
      f.url.pathname + f.url.search,
      submission,
      f.gateways,
    );
    assertDraftOutcomeRedacted(repeated);
    assert.equal(f.executor.calls.length, calls);
  };
  await t.test('authorization withdrawn', () => exercise('authorization'));
  await t.test('provider read failure', () => exercise('provider'));

  await t.test(
    'correctable failure clears pending but retains commitment',
    async () => {
      const f = await orderEntryWitness();
      let { editor } = await persistedDraft(f, 2);
      const lines = [...f.executor.rows.values()].filter((candidate) =>
        candidate.entityId.endsWith(':entity.sales_order_line'),
      );
      const [removed, invalidLine] = lines;
      const invalid = f.values(editor);
      invalid[draftField(invalid, invalidLine!.recordId, '_ordered_quantity')] =
        PROVIDER_REFUSED_QUANTITY;
      editor = (await f.post(editor, `remove:${removed!.recordId}`, invalid))!;
      const review = (await f.post(editor, 'save', invalid))!;
      f.executor.onControlledFailure = () => {
        f.deniedReads.add(`${f.ns}:permission.sales_order_read`);
        f.deniedReads.add(`${f.ns}:permission.sales_order_line_read`);
      };
      const confirmation = {
        draftSession: hiddenValue(review.slots!.keyFacts!, 'draftSession'),
        draftVersion: hiddenValue(review.slots!.keyFacts!, 'draftVersion'),
        draftAction: 'confirm',
      };
      const response = await submitSurfaceRuntimeIntent(
        f.view,
        f.url.pathname + f.url.search,
        confirmation,
        f.gateways,
      );
      assertDraftOutcomeRedacted(response);
      const calls = f.executor.calls.length;
      assert.equal(f.executor.rows.get(removed!.recordId)!.archived, true);
      assertDraftOutcomeRedacted(
        await submitSurfaceRuntimeIntent(
          f.view,
          f.url.pathname + f.url.search,
          confirmation,
          f.gateways,
        ),
      );
      assert.equal(f.executor.calls.length, calls);
    },
  );

  const unknown = await orderEntryWitness();
  const unknownDraft = await persistedDraft(unknown);
  unknown.executor.failingQueries.add(unknown.form.dataSourceQueryId);
  const calls = unknown.executor.calls.length;
  const refused = await submitSurfaceRuntimeIntent(
    unknown.view,
    unknown.url.pathname + unknown.url.search,
    {
      draftSession: hiddenValue(
        unknownDraft.editor.slots!.keyFacts!,
        'draftSession',
      ),
      draftVersion: hiddenValue(
        unknownDraft.editor.slots!.keyFacts!,
        'draftVersion',
      ),
      draftAction: 'save',
      ...unknown.values(unknownDraft.editor),
    },
    unknown.gateways,
  );
  assert.equal(refused.statusCode, 422);
  assert.equal(unknown.executor.calls.length, calls);
});

test('order entry F3: read loss between partial-save submissions redacts acknowledged work before retry', async (t) => {
  const partialFailure = async (pending: 'cleared' | 'retained') => {
    const f = await orderEntryWitness();
    const { editor, recordId } = await persistedDraft(f);
    const line = [...f.executor.rows.values()].find((candidate) =>
      candidate.entityId.endsWith(':entity.sales_order_line'),
    )!;
    const changed = f.values(editor);
    changed[draftField(changed, recordId, '_notes')] =
      'PROTECTED_ROOT_SENTINEL';
    changed[draftField(changed, line.recordId, '_unit_price')] = CHILD_SENTINEL;
    const quantity = draftField(changed, line.recordId, '_ordered_quantity');
    changed[quantity] =
      pending === 'cleared' ? PROVIDER_REFUSED_QUANTITY : '13';
    if (pending === 'retained') f.executor.failAt = f.executor.calls.length + 2;

    const first = await submitSurfaceRuntimeIntent(
      f.view,
      f.url.pathname + f.url.search,
      {
        draftSession: hiddenValue(editor.slots!.keyFacts!, 'draftSession'),
        draftVersion: hiddenValue(editor.slots!.keyFacts!, 'draftVersion'),
        draftAction: 'save',
        ...changed,
      },
      f.gateways,
    );
    assert.equal(first.statusCode, 422);
    assert.match(first.html, /PROTECTED_ROOT_SENTINEL/);
    assert.match(first.html, new RegExp(CHILD_SENTINEL.replace('.', '\\.')));
    assert.match(first.html, /<form\b[^>]*data-document-editor/);
    assert.doesNotMatch(first.html, /DRAFT_EDITOR_PARTIAL_COMMIT_WITHHELD/);
    if (pending === 'cleared') {
      assert.match(first.html, /1 save operations committed/);
      assert.match(first.html, />Save draft<\/button>/);
    } else {
      assert.match(first.html, /data-save-progress/);
      assert.match(first.html, />Retry save<\/button>/);
    }

    const retryValues = { ...changed, [quantity]: '12' };
    return {
      f,
      retry: {
        draftSession: hiddenValue(first.html, 'draftSession'),
        draftVersion: hiddenValue(first.html, 'draftVersion'),
        draftAction: pending === 'cleared' ? 'save' : 'retry',
        ...retryValues,
      },
    };
  };

  for (const scenario of [
    {
      name: 'cleared pending, header policy denial',
      pending: 'cleared',
      read: 'header',
      failure: 'policy',
    },
    {
      name: 'cleared pending, child provider failure',
      pending: 'cleared',
      read: 'child',
      failure: 'provider',
    },
    {
      name: 'retained pending, child policy denial',
      pending: 'retained',
      read: 'child',
      failure: 'policy',
    },
    {
      name: 'retained pending, header provider failure',
      pending: 'retained',
      read: 'header',
      failure: 'provider',
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const { f, retry } = await partialFailure(scenario.pending);
      if (scenario.failure === 'policy')
        f.deniedReads.add(
          `${f.ns}:permission.sales_order${scenario.read === 'child' ? '_line' : ''}_read`,
        );
      else
        f.executor.failingQueries.add(
          scenario.read === 'header'
            ? f.form.dataSourceQueryId
            : f.form.documentEditor!.lineQueryId,
        );
      const calls = f.executor.calls.length;
      const second = await submitSurfaceRuntimeIntent(
        f.view,
        f.url.pathname + f.url.search,
        retry,
        f.gateways,
      );
      assertDraftOutcomeRedacted(second);
      assert.equal(f.executor.calls.length, calls);
      assertDraftOutcomeRedacted(
        await submitSurfaceRuntimeIntent(
          f.view,
          f.url.pathname + f.url.search,
          retry,
          f.gateways,
        ),
      );
      assert.equal(f.executor.calls.length, calls);
    });
  }

  await t.test('authorized retained retry still completes', async () => {
    const { f, retry } = await partialFailure('retained');
    f.executor.failAt = 0;
    const completed = await submitSurfaceRuntimeIntent(
      f.view,
      f.url.pathname + f.url.search,
      retry,
      f.gateways,
    );
    assert.equal(completed.statusCode, 303);
  });

  await t.test('invalid and foreign continuations remain refused', async () => {
    const { f, retry } = await partialFailure('retained');
    const calls = f.executor.calls.length;
    for (const [view, submission] of [
      [f.view, { ...retry, draftSession: randomUUID() }],
      [await issuedView(f.entry, 'd'), retry],
    ] as const) {
      const refused = await submitSurfaceRuntimeIntent(
        view,
        f.url.pathname + f.url.search,
        submission,
        f.gateways,
      );
      assert.equal(refused.statusCode, 422);
      assert.doesNotMatch(refused.html, /DRAFT_EDITOR_PARTIAL_COMMIT_WITHHELD/);
    }
    assert.equal(f.executor.calls.length, calls);
  });

  await t.test(
    'uncertain-only execution retains ordinary refusal',
    async () => {
      const f = await orderEntryWitness();
      const { editor, recordId } = await persistedDraft(f);
      const changed = f.values(editor);
      changed[draftField(changed, recordId, '_notes')] = 'uncertain header';
      f.executor.failAfterCommitAt = f.executor.calls.length + 1;
      const first = (await f.post(editor, 'save', changed))!;
      assert.equal(first.statusCode, 422);
      assert.doesNotMatch(
        Object.values(first.slots!).join(''),
        /DRAFT_EDITOR_PARTIAL_COMMIT_WITHHELD/,
      );
      f.executor.failAfterCommitAt = 0;
      f.executor.failingQueries.add(f.form.dataSourceQueryId);
      const calls = f.executor.calls.length;
      const refused = await submitSurfaceRuntimeIntent(
        f.view,
        f.url.pathname + f.url.search,
        {
          draftSession: hiddenValue(first.slots!.keyFacts!, 'draftSession'),
          draftVersion: hiddenValue(first.slots!.keyFacts!, 'draftVersion'),
          draftAction: 'retry',
        },
        f.gateways,
      );
      assert.equal(refused.statusCode, 422);
      assert.doesNotMatch(refused.html, /DRAFT_EDITOR_PARTIAL_COMMIT_WITHHELD/);
      assert.equal(f.executor.calls.length, calls);
    },
  );
});

test('order entry picker and quick create: offered-only selection, verified carrier, governed create with stable keys', async (t) => {
  type Rendered = NonNullable<Awaited<ReturnType<OrderEntryWitness['open']>>>;
  const html = (rendered: Rendered) => Object.values(rendered.slots!).join('');
  const headerOf = (rendered: Rendered) =>
    /name="draft:([0-9a-f-]{36}):northstar\.app:field\.sales_order_currency"/.exec(
      rendered.slots!.keyFacts!,
    )![1]!;
  const carrier = (rendered: Rendered, rowId: string, fieldId: string) =>
    new RegExp(`name="draft:${rowId}:${fieldId}" value="([^"]*)"`).exec(
      html(rendered),
    )![1]!;
  const creates = (f: OrderEntryWitness, local: string) =>
    f.executor.calls.filter(
      (call) =>
        call.definition.operationId === `${f.ns}:operation.${local}_create`,
    );
  const submitCreate = (
    f: OrderEntryWitness,
    rendered: Rendered,
    values: Record<string, string>,
    verb = 'submit',
    task = hiddenValue(rendered.slots!.keyFacts!, 'draftCreateTask'),
  ) =>
    documentEditor(
      f.view,
      f.form,
      f.surfaces,
      f.url,
      f.scopes[0]!,
      f.gateways,
      {
        draftSession: hiddenValue(rendered.slots!.keyFacts!, 'draftSession'),
        draftVersion: hiddenValue(rendered.slots!.keyFacts!, 'draftVersion'),
        draftCreateTask: task,
        draftCreate: verb,
        ...values,
      },
    ) as Promise<Rendered>;
  const openCreate = async (f: OrderEntryWitness, term: string) => {
    const editor = (await f.open())!;
    const header = headerOf(editor);
    const customer = `${f.ns}:field.sales_order_customer_party_id`;
    const opened = (await f.post(editor, `create:${header}:${customer}`, {
      [`draft:${header}:${f.ns}:field.sales_order_notes`]: 'SO-KEPT',
      [`draftSearch:${header}:${customer}`]: term,
    }))!;
    return { header, customer, opened };
  };

  await t.test(
    'selection comes only from offered results and is re-read',
    async () => {
      const f = await orderEntryWitness();
      let editor = (await f.open())!;
      const header = headerOf(editor);
      const customer = `${f.ns}:field.sales_order_customer_party_id`;
      const forged = (await f.post(
        editor,
        `select:${header}:${customer}:${f.party}`,
      ))!;
      assert.equal(forged.statusCode, 422);
      assert.equal(carrier(forged, header, customer), '');
      editor = (await f.post(forged, `search:${header}:${customer}`, {
        [`draftSearch:${header}:${customer}`]: 'Readable',
      }))!;
      assert.match(
        editor.slots!.keyFacts!,
        /class="reference-option"[^>]*><strong>Readable customer<\/strong>/,
      );
      const selected = (await f.post(
        editor,
        `select:${header}:${customer}:${f.party}`,
      ))!;
      assert.equal(selected.statusCode, 200);
      assert.equal(carrier(selected, header, customer), f.party);
      assert.match(
        selected.slots!.keyFacts!,
        /data-selected-label="Readable customer"/,
      );
      assert.equal(f.executor.calls.length, 0);
    },
  );

  await t.test(
    'a form-changed carrier needs an authorized exact read',
    async () => {
      const f = await orderEntryWitness();
      const editor = (await f.open())!;
      const header = headerOf(editor);
      const customer = `${f.ns}:field.sales_order_customer_party_id`;
      const unknown = (await f.post(editor, 'refresh', {
        [`draft:${header}:${customer}`]: randomUUID(),
      }))!;
      assert.equal(unknown.statusCode, 422);
      assert.match(unknown.slots!.keyFacts!, /data-editor-reference-refused/);
      assert.equal(carrier(unknown, header, customer), '');
      const other = f.executor.seedParty({
        [`${f.ns}:field.party_name`]: 'Unreadable customer',
      });
      f.deniedReads.add(`${f.ns}:permission.party_read`);
      const denied = (await f.post(unknown, 'refresh', {
        [`draft:${header}:${customer}`]: other,
      }))!;
      assert.equal(denied.statusCode, 422);
      assert.equal(carrier(denied, header, customer), '');
      f.deniedReads.delete(`${f.ns}:permission.party_read`);
      const readable = (await f.post(denied, 'refresh', {
        [`draft:${header}:${customer}`]: other,
      }))!;
      assert.equal(readable.statusCode, 200);
      assert.equal(carrier(readable, header, customer), other);
      // The derived unit is never taken from the form.
      const line = /data-draft-line="([^"]+)"/.exec(
        readable.slots!.sections!,
      )![1]!;
      const item = `${f.ns}:field.sales_order_line_item_id`;
      const derived = (await f.post(readable, 'refresh', {
        [`draft:${line}:${item}`]: f.item,
        [`draft:${line}:${f.ns}:field.sales_order_line_unit_id`]: 'FORGED',
      }))!;
      assert.match(derived.slots!.sections!, /class="derived-value"[^>]*>EA</);
      assert.doesNotMatch(derived.slots!.sections!, /FORGED/);
    },
  );

  await t.test(
    'create uses governed steps with stable keys, then selects',
    async () => {
      const f = await orderEntryWitness();
      const { header, customer, opened } = await openCreate(
        f,
        'Zenith Glazing',
      );
      assert.match(
        opened.slots!.keyFacts!,
        /<dialog class="editor-create" open/,
      );
      assert.match(
        opened.slots!.keyFacts!,
        /name="create:northstar\.app:field\.party_name" value="Zenith Glazing"/,
      );
      const paused = (await f.post(opened, 'add'))!;
      assert.equal(paused.statusCode, 409);
      assert.match(paused.slots!.keyFacts!, /data-editor-paused/);
      assert.equal(
        paused.slots!.sections!.match(/data-draft-line=/g)!.length,
        1,
      );
      const created = await submitCreate(f, paused, {
        [`create:${f.ns}:field.party_number`]: 'C-100',
        [`create:${f.ns}:field.party_name`]: 'Zenith Glazing',
      });
      assert.equal(created.statusCode, 200);
      assert.match(created.slots!.keyFacts!, /data-editor-create-selected/);
      assert.doesNotMatch(created.slots!.keyFacts!, /<dialog/);
      assert.match(created.slots!.keyFacts!, />SO-KEPT<\/textarea>/);
      const [party] = creates(f, 'party');
      const [role] = creates(f, 'party_role');
      assert.equal(creates(f, 'party').length, 1);
      assert.equal(creates(f, 'party_role').length, 1);
      const partyId = String(asRecord(party!.input).recordId);
      assert.equal(carrier(created, header, customer), partyId);
      assert.deepEqual(asRecord(asRecord(role!.input).values), {
        [`${f.ns}:field.party_role_kind`]: `${f.ns}:option.customer`,
        [`${f.ns}:field.party_role_status`]: `${f.ns}:option.active`,
      });
      assert.deepEqual(asRecord(asRecord(role!.input).relations), {
        [`${f.ns}:relation.party_role_party`]: partyId,
      });
      // A replay of the same create form is a stale version; nothing is written.
      const replay = await submitCreate(f, paused, {
        [`create:${f.ns}:field.party_number`]: 'C-100',
        [`create:${f.ns}:field.party_name`]: 'Zenith Glazing',
      });
      assert.equal(replay.statusCode, 409);
      // A current version carrying a closed task is refused, not re-run.
      const stale = await submitCreate(
        f,
        created,
        { [`create:${f.ns}:field.party_name`]: 'Zenith Glazing' },
        'submit',
        hiddenValue(paused.slots!.keyFacts!, 'draftCreateTask'),
      );
      assert.equal(stale.statusCode, 422);
      assert.equal(creates(f, 'party').length, 1);
      assert.equal(creates(f, 'party_role').length, 1);
    },
  );

  await t.test(
    'cancel writes nothing and returns to the kept draft',
    async () => {
      const f = await orderEntryWitness();
      const { header, customer, opened } = await openCreate(f, 'Ghost Supply');
      const cancelled = await submitCreate(f, opened, {}, 'cancel');
      assert.equal(cancelled.statusCode, 200);
      assert.equal(f.executor.calls.length, 0);
      assert.doesNotMatch(cancelled.slots!.keyFacts!, /<dialog/);
      assert.match(cancelled.slots!.keyFacts!, />SO-KEPT<\/textarea>/);
      assert.equal(carrier(cancelled, header, customer), '');
      assert.match(
        cancelled.slots!.keyFacts!,
        /role="combobox"[^>]*aria-label="Customer"[^>]*autofocus/,
      );
    },
  );

  await t.test(
    'a denied create is reported without a write or a selection',
    async () => {
      const f = await orderEntryWitness();
      const { header, customer, opened } = await openCreate(f, 'Denied Party');
      f.deniedReads.add(`${f.ns}:permission.party_create`);
      const denied = await submitCreate(f, opened, {
        [`create:${f.ns}:field.party_number`]: 'C-DENIED',
        [`create:${f.ns}:field.party_name`]: 'Denied Party',
      });
      assert.equal(denied.statusCode, 422);
      assert.match(
        denied.slots!.keyFacts!,
        /data-diagnostic-code="OPERATION_PERMISSION_DENIED"/,
      );
      assert.match(
        denied.slots!.keyFacts!,
        /<dialog class="editor-create" open/,
      );
      assert.equal(f.executor.calls.length, 0);
      assert.equal(carrier(denied, header, customer), '');
    },
  );

  await t.test(
    'a partial create is named, never selected, and retry reuses its keys',
    async () => {
      const f = await orderEntryWitness();
      const { header, customer, opened } = await openCreate(f, 'Partial Party');
      f.executor.failAt = f.executor.calls.length + 2;
      const partial = await submitCreate(f, opened, {
        [`create:${f.ns}:field.party_number`]: 'C-PART',
        [`create:${f.ns}:field.party_name`]: 'Partial Party',
      });
      assert.equal(partial.statusCode, 422);
      assert.match(partial.slots!.keyFacts!, /1 of 2 create steps committed/);
      assert.match(partial.slots!.keyFacts!, />Retry<\/button>/);
      assert.equal(carrier(partial, header, customer), '');
      f.executor.failAt = 0;
      const retried = await submitCreate(f, partial, {
        [`create:${f.ns}:field.party_name`]: 'forged',
      });
      assert.equal(retried.statusCode, 200);
      assert.match(retried.slots!.keyFacts!, /data-editor-create-selected/);
      const parties = creates(f, 'party');
      const roles = creates(f, 'party_role');
      assert.equal(parties.length, 1);
      assert.equal(roles.length, 2);
      assert.equal(roles[0]!.idempotencyKey, roles[1]!.idempotencyKey);
      assert.deepEqual(roles[0]!.input, roles[1]!.input);
      const party = f.executor.rows.get(
        String(asRecord(parties[0]!.input).recordId),
      )!;
      assert.equal(party.values[`${f.ns}:field.party_name`], 'Partial Party');
      assert.equal(carrier(retried, header, customer), party.recordId);
    },
  );

  await t.test(
    'a created record that cannot be read back is not selected',
    async () => {
      const f = await orderEntryWitness();
      const { header, customer, opened } = await openCreate(
        f,
        'Withheld Party',
      );
      f.deniedReads.add(`${f.ns}:permission.party_read`);
      const withheld = await submitCreate(f, opened, {
        [`create:${f.ns}:field.party_number`]: 'C-HELD',
        [`create:${f.ns}:field.party_name`]: 'Withheld Party',
      });
      assert.match(withheld.slots!.keyFacts!, /data-editor-create-withheld/);
      assert.equal(carrier(withheld, header, customer), '');
      assert.equal(creates(f, 'party').length, 1);
    },
  );
});

test('order entry values: exact decimals, bounded before any write, choice set and stored values kept', async (t) => {
  await t.test(
    'decimals are canonical, compared by value and bounded before any write',
    async () => {
      const f = await orderEntryWitness();
      const key = (rendered: Record<string, string>, suffix: string) =>
        Object.keys(rendered).find((candidate) => candidate.endsWith(suffix))!;
      let editor = (await f.open())!;
      {
        // A header problem: the label holds only the field's name, and the
        // message after the control describes it (aria-describedby).
        const values = f.values(editor);
        const refused = (await f.post(editor, 'save', {
          ...values,
          [key(values, 'field.sales_order_order_date')]: '',
        }))!;
        assert.equal(refused.statusCode, 422);
        const header = refused.slots!.keyFacts!;
        assert.match(
          header,
          /<label class="form-field__label" for="([^"]+)">Order date \(UTC\) \*<\/label><input(?=[^>]*\sid="\1")(?=[^>]*\saria-describedby="\1-error")/,
        );
        assert.match(header, /<small class="field-error" id="[^"]+-error">/);
        assert.doesNotMatch(
          header,
          /<label\b(?:(?!<\/label>)[\s\S])*class="field-error"/,
        );
        assert.equal(f.executor.calls.length, 0);
        editor = refused;
      }
      for (const [entry, message] of [
        [
          '1.1234567890123456789012',
          /Use at most 18 digits after the decimal point/,
        ],
        ['1e3', /Enter a plain number, such as 12\.5\./],
      ] as const) {
        const values = f.values(editor);
        editor = (await f.post(editor, 'save', {
          ...values,
          [key(values, '_ordered_quantity')]: entry,
        }))!;
        assert.equal(editor.statusCode, 422);
        assert.match(editor.slots!.keyFacts!, /data-editor-problems/);
        assert.match(editor.slots!.sections!, message);
        // A problem describes its control; it never becomes part of a label.
        assert.doesNotMatch(
          editor.slots!.keyFacts! + editor.slots!.sections!,
          /<label\b(?:(?!<\/label>)[\s\S])*class="field-error"/,
        );
        // The refused entry is kept exactly as typed.
        assert.ok(editor.slots!.sections!.includes(`value="${entry}"`));
        assert.equal(f.executor.calls.length, 0);
      }
      const values = f.values(editor);
      const saved = (await f.post(editor, 'save', {
        ...values,
        [key(values, '_ordered_quantity')]: '010.500',
        [key(values, '_unit_price')]: '12.50',
      }))!;
      assert.equal(saved.statusCode, 303);
      const lineCall = f.executor.calls.find((call) =>
        call.definition.operationId.endsWith('.sales_order_line_create'),
      )!;
      const lineValues = asRecord(asRecord(lineCall.input).values);
      assert.equal(
        lineValues[`${f.ns}:field.sales_order_line_ordered_quantity`],
        '10.5',
      );
      assert.equal(
        lineValues[`${f.ns}:field.sales_order_line_unit_price`],
        '12.5',
      );
      // A stored spelling with trailing zeros is the same exact value:
      // reopening shows it canonically and an unchanged save plans no update.
      const line = f.executor.rows.get(
        String(asRecord(lineCall.input).recordId),
      )!;
      f.executor.rows.set(line.recordId, {
        ...line,
        values: {
          ...line.values,
          [`${f.ns}:field.sales_order_line_ordered_quantity`]:
            '10.500000000000000000',
        },
      });
      f.url.searchParams.set(
        'record',
        new URL(saved.location!, 'http://fixture.local').searchParams.get(
          'record',
        )!,
      );
      const reopened = (await f.open())!;
      assert.match(reopened.slots!.sections!, /value="10\.5"/);
      const calls = f.executor.calls.length;
      const unchanged = (await f.post(reopened, 'save'))!;
      assert.equal(unchanged.statusCode, 303);
      assert.equal(f.executor.calls.length, calls);
    },
  );

  await t.test(
    'a choice admits only its offered set; a stored value outside it is kept',
    async () => {
      const f = await orderEntryWitness();
      const editor = (await f.open())!;
      assert.match(
        editor.slots!.keyFacts!,
        /<option value="CAD" selected>CAD · Canadian dollar<\/option>/,
      );
      const values = f.values(editor);
      const currency = Object.keys(values).find((key) =>
        key.endsWith('_currency'),
      )!;
      const refused = (await f.post(editor, 'save', {
        ...values,
        [currency]: 'XYZ',
      }))!;
      assert.equal(refused.statusCode, 422);
      assert.match(
        refused.slots!.keyFacts!,
        /Currency: choose one of the offered values/,
      );
      assert.equal(f.executor.calls.length, 0);
      const { recordId } = await persistedDraft(f);
      const header = f.executor.rows.get(recordId)!;
      f.executor.rows.set(recordId, {
        ...header,
        values: {
          ...header.values,
          [`${f.ns}:field.sales_order_currency`]: 'GBP',
        },
      });
      const reopened = (await f.open())!;
      assert.match(
        reopened.slots!.keyFacts!,
        /<option value="GBP" selected>GBP \(current value\)<\/option>/,
      );
      const kept = f.values(reopened);
      kept[draftField(kept, recordId, '_currency')] = 'GBP';
      kept[draftField(kept, recordId, '_notes')] = 'unrelated edit';
      const saved = (await f.post(reopened, 'save', kept))!;
      assert.equal(saved.statusCode, 303);
      const update = f.executor.calls.at(-1)!;
      assert.equal(
        asRecord(asRecord(update.input).patch)[
          `${f.ns}:field.sales_order_currency`
        ],
        'GBP',
      );
    },
  );
});

/**
 * RAIN WORKSPACE INTERACTION COMPLETION, milestone A. Customer and vendor
 * pickers offer only parties with an active role of that kind, filtered by the
 * list query itself, and every selection route re-checks it. A quick create is
 * offered only when current policy would let the principal start every step,
 * asked without executing anything; a revocation is observed on the next
 * render and the create action is refused rather than opened.
 */
test('Milestone A: role-eligible lookups and policy-aware quick create', async (t) => {
  type Rendered = NonNullable<Awaited<ReturnType<OrderEntryWitness['open']>>>;
  const keyFacts = (rendered: Rendered) => rendered.slots!.keyFacts!;
  const headerOf = (rendered: Rendered) =>
    /name="draft:([0-9a-f-]{36}):northstar\.app:field\.(?:sales|purchase)_order_currency"/.exec(
      keyFacts(rendered),
    )![1]!;
  const optionNames = (rendered: Rendered) =>
    [
      ...keyFacts(rendered).matchAll(
        /class="reference-option"[^>]*><strong>([^<]+)<\/strong>/g,
      ),
    ].map((match) => match[1]);
  const seeded = (f: OrderEntryWitness) => ({
    // Server search over the selected fields, as the PostgreSQL executor does.
    paged: (f.executor.pageLists = true),
    supplierOnly: f.executor.seedParty(
      {
        [`${f.ns}:field.party_name`]: 'Supplier only co',
      },
      ['supplier'],
    ),
    customerOnly: f.executor.seedParty(
      {
        [`${f.ns}:field.party_name`]: 'Customer only co',
      },
      ['customer'],
    ),
    dual: f.executor.seedParty({
      [`${f.ns}:field.party_name`]: 'Dual role co',
    }),
    inactive: (() => {
      const party = f.executor.seed('party', {
        [`${f.ns}:field.party_name`]: 'Inactive role co',
      });
      f.executor.seed('party_role', {
        [`${f.ns}:field.party_role_kind`]: `${f.ns}:option.customer`,
        [`${f.ns}:field.party_role_status`]: `${f.ns}:option.inactive`,
        [`${f.ns}:relation.party_role_party`]: party,
      });
      return party;
    })(),
    none: f.executor.seed('party', {
      [`${f.ns}:field.party_name`]: 'No role co',
    }),
  });

  await t.test(
    'lookups offer only active roles of the picker kind',
    async () => {
      for (const variant of [false, true]) {
        const f = await orderEntryWitness(variant);
        seeded(f);
        const editor = (await f.open())!;
        const header = headerOf(editor);
        const field = `${f.ns}:field.${variant ? 'purchase_order_supplier' : 'sales_order_customer'}_party_id`;
        const searched = (await f.post(editor, `search:${header}:${field}`, {
          [`draftSearch:${header}:${field}`]: 'co',
        }))!;
        assert.deepEqual(
          optionNames(searched).sort(),
          variant
            ? ['Dual role co', 'Supplier only co']
            : ['Customer only co', 'Dual role co'],
        );
        assert.equal(f.executor.calls.length, 0, 'a lookup writes nothing');
      }
    },
  );

  await t.test('every selection route re-checks eligibility', async () => {
    const f = await orderEntryWitness();
    const parties = seeded(f);
    const editor = (await f.open())!;
    const header = headerOf(editor);
    const customer = `${f.ns}:field.sales_order_customer_party_id`;
    // A readable supplier-only party forged into the form carrier is refused.
    const forged = (await f.post(editor, 'refresh', {
      [`draft:${header}:${customer}`]: parties.supplierOnly,
    }))!;
    assert.equal(forged.statusCode, 422);
    assert.match(keyFacts(forged), /data-editor-reference-refused/);
    // An offered party that loses its role before selection is refused.
    const searched = (await f.post(forged, `search:${header}:${customer}`, {
      [`draftSearch:${header}:${customer}`]: 'Customer only',
    }))!;
    assert.deepEqual(optionNames(searched), ['Customer only co']);
    for (const row of f.executor.rows.values())
      if (
        row.values[`${f.ns}:relation.party_role_party`] === parties.customerOnly
      )
        f.executor.rows.set(row.recordId, {
          ...row,
          values: {
            ...row.values,
            [`${f.ns}:field.party_role_status`]: `${f.ns}:option.inactive`,
          },
        });
    const lost = (await f.post(
      searched,
      `select:${header}:${customer}:${parties.customerOnly}`,
    ))!;
    assert.equal(lost.statusCode, 422);
    assert.doesNotMatch(
      keyFacts(lost),
      new RegExp(
        `name="draft:${header}:${customer}" value="${parties.customerOnly}"`,
      ),
    );
    // A dual-role party is a legitimate customer.
    const dual = (await f.post(lost, `search:${header}:${customer}`, {
      [`draftSearch:${header}:${customer}`]: 'Dual',
    }))!;
    const chosen = (await f.post(
      dual,
      `select:${header}:${customer}:${parties.dual}`,
    ))!;
    assert.equal(chosen.statusCode, 200);
    assert.match(
      keyFacts(chosen),
      new RegExp(`name="draft:${header}:${customer}" value="${parties.dual}"`),
    );
  });

  await t.test(
    'quick create is offered only when every step may start',
    async () => {
      const f = await orderEntryWitness();
      let editor = (await f.open())!;
      assert.match(keyFacts(editor), /\+ New customer/);
      for (const permission of ['party_create', 'party_role_create']) {
        f.deniedReads.add(`${f.ns}:permission.${permission}`);
        editor = (await f.post(editor, 'refresh'))!;
        assert.doesNotMatch(keyFacts(editor), /\+ New customer/, permission);
        const header = headerOf(editor);
        const customer = `${f.ns}:field.sales_order_customer_party_id`;
        const refused = (await f.post(editor, `create:${header}:${customer}`))!;
        assert.equal(refused.statusCode, 422, permission);
        assert.doesNotMatch(
          keyFacts(refused),
          /<form[^>]*data-editor-create[\s>]/,
          permission,
        );
        f.deniedReads.delete(`${f.ns}:permission.${permission}`);
        editor = (await f.post(refused, 'refresh'))!;
        assert.match(keyFacts(editor), /\+ New customer/, permission);
      }
      assert.equal(f.executor.calls.length, 0, 'the preview never writes');
    },
  );

  await t.test(
    'quick create names existing matches before a second record is made',
    async () => {
      const f = await orderEntryWitness();
      seeded(f);
      const editor = (await f.open())!;
      const header = headerOf(editor);
      const customer = `${f.ns}:field.sales_order_customer_party_id`;
      const opened = (await f.post(editor, `create:${header}:${customer}`, {
        [`draftSearch:${header}:${customer}`]: 'only co',
      }))!;
      const warning =
        /<section class="editor-create__duplicates"[\s\S]*?<\/section>/.exec(
          keyFacts(opened),
        )?.[0] ?? '';
      // Every match is named, read now; only one this field offers can be
      // chosen instead of creating.
      assert.match(
        warning,
        /Customer only co<\/strong>(?:(?!<li>)[\s\S])*already offered in this field/,
      );
      assert.match(
        warning,
        /Supplier only co<\/strong>(?:(?!<li>)[\s\S])*exists, but is not offered in this field/,
      );
      assert.match(keyFacts(opened), /<form[^>]*data-editor-create[\s>]/);
      assert.equal(f.executor.calls.length, 0, 'the warning never writes');
      // A failed read omits the warning; nothing read earlier is shown again.
      f.executor.failingQueries.add(`${f.ns}:query.party_list`);
      const failed = (await f.post(opened, 'refresh'))!;
      assert.match(keyFacts(failed), /<form[^>]*data-editor-create[\s>]/);
      assert.doesNotMatch(
        keyFacts(failed),
        /editor-create__duplicates|Supplier only co/,
      );
      f.executor.failingQueries.delete(`${f.ns}:query.party_list`);
      // A name nothing matches warns about nothing.
      const cancelled = (await f.post(failed, 'refresh', {
        draftCreateTask: hiddenValue(keyFacts(failed), 'draftCreateTask'),
        draftCreate: 'cancel',
      }))!;
      const fresh = (await f.post(cancelled, `create:${header}:${customer}`, {
        [`draftSearch:${header}:${customer}`]: 'Unmatched Glazing',
      }))!;
      assert.match(keyFacts(fresh), /<form[^>]*data-editor-create[\s>]/);
      assert.doesNotMatch(keyFacts(fresh), /editor-create__duplicates/);
      assert.equal(f.executor.calls.length, 0);
    },
  );
});

/**
 * RAIN WORKSPACE INTERACTION COMPLETION, milestone B. A reference field is
 * answered in place: a lookup answers only its own region, a selection only its
 * field and that row's declared dependents. Every answer is bound to the draft
 * session, the field's newest lookup request and its selection generation, so a
 * late or duplicated answer can neither overwrite a newer edit nor select from
 * superseded results, and two fields answering out of order never touch each
 * other. Nothing here captures the form or advances the page's draft version.
 */
test('Milestone B: reference fields answer in place, bound to their own request and generation', async (t) => {
  type Answer = NonNullable<Awaited<ReturnType<typeof documentEditor>>>;
  const setup = async () => {
    const f = await orderEntryWitness();
    f.executor.pageLists = true;
    const dual = f.executor.seedParty({
      [`${f.ns}:field.party_name`]: 'Dual role co',
    });
    const editor = (await f.open())!;
    const all = Object.values(editor.slots!).join('');
    const header =
      /name="draft:([0-9a-f-]{36}):northstar\.app:field\.sales_order_currency"/.exec(
        all,
      )![1]!;
    const line =
      /name="draft:([0-9a-f-]{36}):northstar\.app:field\.sales_order_line_item_id"/.exec(
        all,
      )![1]!;
    const session = hiddenValue(editor.slots!.keyFacts!, 'draftSession');
    const version = hiddenValue(editor.slots!.keyFacts!, 'draftVersion');
    const customer = `${f.ns}:field.sales_order_customer_party_id`;
    const product = `${f.ns}:field.sales_order_line_item_id`;
    const fragment = (values: Record<string, string>, scope = f.scopes[0]!) =>
      documentEditor(
        f.view,
        f.form,
        f.surfaces,
        f.url,
        scope,
        f.gateways,
        { draftSession: session, draftVersion: version, ...values },
        'fragment',
      ) as Promise<Answer>;
    const search = (
      rowId: string,
      fieldId: string,
      term: string,
      seq: number,
    ) =>
      fragment({
        draftAction: `search:${rowId}:${fieldId}`,
        draftLookupSeq: String(seq),
        [`draftSearch:${rowId}:${fieldId}`]: term,
      });
    const select = (
      rowId: string,
      fieldId: string,
      recordId: string,
      seq: number,
      generation: number,
    ) =>
      fragment({
        draftAction: `select:${rowId}:${fieldId}:${recordId}`,
        draftLookupSeq: String(seq),
        draftFieldGeneration: String(generation),
      });
    const targets = (answer: Answer) =>
      [...answer.html.matchAll(/data-fragment-target="([^"]+)"/g)].map(
        (match) => match[1]!,
      );
    const id = (rowId: string, fieldId: string) =>
      `editor-${rowId}-${fieldId.replace(/[^a-z0-9]/giu, '-')}`;
    // The customer's declared followers (ruling E), in declaration order: a
    // follower that is a picker is replaced whole, any other by its control.
    const customerFollowers = (rowId: string) =>
      [
        ['salesperson_party_id', true],
        ['currency', false],
        ['payment_terms', false],
        // Ruling B: the order's tax code, then each charge's code and the
        // rate frozen from it.
        ['tax_code_id', true],
        ['freight_tax_code_id', true],
        ['freight_tax_rate_percent', false],
        ['other_fee_tax_code_id', true],
        ['other_fee_tax_rate_percent', false],
        ['ship_to_address_id', true],
        ['ship_to_name', false],
        ['ship_to_street', false],
        ['ship_to_city', false],
        ['ship_to_region', false],
        ['ship_to_postal_code', false],
        ['ship_to_country', false],
      ].map(
        ([name, picker]) =>
          `${id(rowId, `${f.ns}:field.sales_order_${String(name)}`)}${picker ? '-field' : ''}`,
      );
    return {
      f,
      dual,
      header,
      line,
      session,
      customer,
      product,
      fragment,
      search,
      select,
      targets,
      id,
      customerFollowers,
      editor,
    };
  };

  await t.test(
    'a lookup answers only its own region and writes nothing',
    async () => {
      const s = await setup();
      const answer = await s.search(s.header, s.customer, 'Readable', 1);
      assert.equal(answer.fragment, true);
      assert.equal(answer.statusCode, 200);
      assert.deepEqual(s.targets(answer), [
        `${s.id(s.header, s.customer)}-lookup`,
      ]);
      assert.match(answer.html, /<strong>Readable customer<\/strong>/);
      // "+ New customer" is the popup's last row.
      assert.match(answer.html, /\+ New customer<\/button><\/li><\/ul>/);
      // No document: no form, fieldset or other field of the order.
      assert.doesNotMatch(
        answer.html,
        /<form|<fieldset|data-document-editor|sales_order_currency/,
      );
      assert.equal(s.f.executor.calls.length, 0);
      // The page's draft version did not move: its next full submit applies.
      const page = (await s.f.post(s.editor, 'refresh'))!;
      assert.equal(page.statusCode, 200);
    },
  );

  await t.test(
    'an older lookup answer is superseded and cannot be selected from',
    async () => {
      const s = await setup();
      assert.equal(
        (await s.search(s.header, s.customer, 'Readable', 2)).statusCode,
        200,
      );
      const older = await s.search(s.header, s.customer, 'Dual', 1);
      assert.equal(older.statusCode, 409);
      assert.equal(older.html, '');
      const newer = await s.search(s.header, s.customer, 'Dual', 3);
      assert.match(newer.html, /Dual role co/);
      assert.doesNotMatch(newer.html, /Readable customer/);
      // A record only the superseded request offered is not selectable any more.
      const stale = await s.select(s.header, s.customer, s.f.party, 2, 0);
      assert.equal(stale.statusCode, 409);
      assert.match(stale.html, /Those results changed/);
      const chosen = await s.select(s.header, s.customer, s.dual, 3, 0);
      assert.equal(chosen.statusCode, 200);
      assert.match(chosen.html, /data-selected-label="Dual role co"/);
      assert.equal(s.f.executor.calls.length, 0);
    },
  );

  await t.test(
    'two fields answering out of order never touch each other',
    async () => {
      const s = await setup();
      // The customer lookup is held; the product lookup and selection finish
      // first; then the customer answer arrives and applies to its field only.
      const release = s.f.executor.hold(`${s.f.ns}:query.party_list`);
      const slowCustomer = s.search(s.header, s.customer, 'Readable', 1);
      const productLookup = await s.search(s.line, s.product, 'Readable', 1);
      assert.deepEqual(s.targets(productLookup), [
        `${s.id(s.line, s.product)}-lookup`,
      ]);
      const productChosen = await s.select(s.line, s.product, s.f.item, 1, 0);
      assert.equal(productChosen.statusCode, 200);
      // The field and its declared dependents -- the unit, the price in the
      // order's currency and its list price, the tax code from the order and
      // the rate frozen from it (ruling B) -- and nothing else.
      assert.deepEqual(s.targets(productChosen), [
        `${s.id(s.line, s.product)}-field`,
        s.id(s.line, `${s.f.ns}:field.sales_order_line_unit_id`),
        s.id(s.line, `${s.f.ns}:field.sales_order_line_unit_price`),
        s.id(s.line, `${s.f.ns}:field.sales_order_line_list_price`),
        `${s.id(s.line, `${s.f.ns}:field.sales_order_line_tax_code_id`)}-field`,
        s.id(s.line, `${s.f.ns}:field.sales_order_line_tax_rate_percent`),
      ]);
      assert.match(productChosen.html, />EA</);
      release();
      const customerLookup = await slowCustomer;
      assert.equal(customerLookup.statusCode, 200);
      assert.deepEqual(s.targets(customerLookup), [
        `${s.id(s.header, s.customer)}-lookup`,
      ]);
      assert.doesNotMatch(customerLookup.html, /Readable product/);
      const customerChosen = await s.select(
        s.header,
        s.customer,
        s.f.party,
        1,
        0,
      );
      assert.equal(customerChosen.statusCode, 200);
      // A full save then carries both in-place selections exactly.
      const values = s.f.values(s.editor);
      const saved = (await s.f.post(s.editor, 'save', values))!;
      assert.equal(saved.statusCode, 303);
      const stored = [...s.f.executor.rows.values()];
      assert.ok(stored.some((row) => row.values[s.customer] === s.f.party));
      assert.ok(stored.some((row) => row.values[s.product] === s.f.item));
    },
  );

  await t.test(
    'a late or replayed selection cannot overwrite a newer one',
    async () => {
      const s = await setup();
      await s.search(s.header, s.customer, 'Readable', 1);
      const winner = await s.select(s.header, s.customer, s.f.party, 1, 0);
      assert.equal(winner.statusCode, 200);
      await s.search(s.header, s.customer, 'Dual', 2);
      // Replayed with the generation it was based on: refused, current value shown.
      const replayed = await s.select(s.header, s.customer, s.dual, 2, 0);
      assert.equal(replayed.statusCode, 409);
      assert.match(replayed.html, /changed meanwhile/);
      assert.match(replayed.html, /data-selected-label="Readable customer"/);
      // Overtaken while its exact read was in flight: a clear lands first.
      const hold = s.f.executor.hold(`${s.f.ns}:query.party_get`);
      const overtaken = s.select(s.header, s.customer, s.dual, 2, 1);
      await new Promise((resolve) => setImmediate(resolve));
      const cleared = await s.fragment({
        draftAction: `clear:${s.header}:${s.customer}`,
        draftFieldGeneration: '1',
      });
      assert.equal(cleared.statusCode, 200);
      hold();
      const late = await overtaken;
      assert.equal(late.statusCode, 409);
      assert.doesNotMatch(late.html, /data-selected-label="Dual role co"/);
      assert.match(
        late.html,
        new RegExp(`name="draft:${s.header}:${s.customer}" value=""`),
      );
    },
  );

  await t.test(
    'a withdrawn read drops the results and discloses nothing',
    async () => {
      const s = await setup();
      assert.match(
        (await s.search(s.header, s.customer, 'Readable', 1)).html,
        /Readable customer/,
      );
      s.f.deniedReads.add(`${s.f.ns}:permission.party_read`);
      const denied = await s.search(s.header, s.customer, 'Readable', 2);
      assert.equal(denied.statusCode, 422);
      assert.doesNotMatch(denied.html, /Readable customer/);
      assert.match(denied.html, /data-message=/);
      const selectDenied = await s.select(
        s.header,
        s.customer,
        s.f.party,
        2,
        0,
      );
      assert.notEqual(selectDenied.statusCode, 200);
      assert.doesNotMatch(selectDenied.html, /Readable customer/);
    },
  );

  await t.test(
    'a failed read answers with its refusal and no earlier results',
    async () => {
      const s = await setup();
      assert.match(
        (await s.search(s.header, s.customer, 'Readable', 1)).html,
        /Readable customer/,
      );
      s.f.executor.failingQueries.add(`${s.f.ns}:query.party_list`);
      const failed = await s.search(s.header, s.customer, 'Readable', 2);
      assert.equal(failed.statusCode, 422);
      assert.deepEqual(s.targets(failed), [
        `${s.id(s.header, s.customer)}-lookup`,
      ]);
      assert.doesNotMatch(failed.html, /Readable customer/);
      assert.match(failed.html, /data-message=/);
      s.f.executor.failingQueries.delete(`${s.f.ns}:query.party_list`);
      // The dropped lookup offers nothing to select from.
      const orphan = await s.select(s.header, s.customer, s.f.party, 2, 0);
      assert.equal(orphan.statusCode, 409);
      assert.equal(s.f.executor.calls.length, 0);
    },
  );

  await t.test(
    'a removed row, another company and an expired session are not answered in place',
    async () => {
      const s = await setup();
      let editor = (await s.f.post(s.editor, 'add', s.f.values(s.editor)))!;
      const extra = [
        ...Object.values(editor.slots!)
          .join('')
          .matchAll(
            /name="draft:([0-9a-f-]{36}):northstar\.app:field\.sales_order_line_item_id"/g,
          ),
      ]
        .map((match) => match[1]!)
        .find((rowId) => rowId !== s.line)!;
      editor = (await s.f.post(editor, `remove:${extra}`))!;
      assert.equal(editor.statusCode, 200);
      const removed = await s.search(extra, s.product, 'Readable', 1);
      assert.equal(removed.statusCode, 422);
      assert.equal(removed.fragment, true);
      const foreign = await s.fragment(
        {
          draftAction: `search:${s.header}:${s.customer}`,
          draftLookupSeq: '1',
        },
        s.f.scopes[1]!,
      );
      assert.equal(foreign.fallback, true);
      const expired = await documentEditor(
        s.f.view,
        s.f.form,
        s.f.surfaces,
        s.f.url,
        s.f.scopes[0]!,
        s.f.gateways,
        {
          draftSession: randomUUID(),
          draftAction: `search:${s.header}:${s.customer}`,
          draftLookupSeq: '1',
        },
        'fragment',
      );
      assert.equal(expired?.fallback, true);
      assert.equal(s.f.executor.calls.length, 0);
    },
  );

  await t.test(
    'create opens in place, returns to its field and is truthful when refused',
    async () => {
      const s = await setup();
      const opened = await s.fragment({
        draftAction: `create:${s.header}:${s.customer}`,
        draftFieldGeneration: '0',
        [`draftSearch:${s.header}:${s.customer}`]: 'Zenith Glazing',
      });
      assert.deepEqual(s.targets(opened), ['editor-create-slot']);
      assert.match(opened.html, /data-editor-create-fragment/);
      assert.match(
        opened.html,
        /name="create:[^"]+party_name" value="Zenith Glazing"/,
      );
      assert.doesNotMatch(opened.html, /data-task-close/);
      const task = hiddenValue(opened.html, 'draftCreateTask');
      // While it is open the order is paused, in place as well as in full.
      const paused = await s.search(s.header, s.customer, 'x', 1);
      assert.equal(paused.statusCode, 409);
      const created = await s.fragment({
        draftCreateTask: task,
        draftCreate: 'submit',
        [`create:${s.f.ns}:field.party_number`]: 'C-ZEN',
        [`create:${s.f.ns}:field.party_name`]: 'Zenith Glazing',
      });
      assert.equal(created.statusCode, 200);
      assert.deepEqual(s.targets(created), [
        'editor-create-slot',
        `${s.id(s.header, s.customer)}-field`,
        ...s.customerFollowers(s.header),
      ]);
      assert.match(created.html, /data-selected-label="Zenith Glazing"/);
      assert.match(created.html, /data-editor-create-selected/);
      assert.equal(s.f.executor.calls.length, 2);

      // Refused by current policy after the flow opened: Cancel only.
      const again = await s.fragment({
        draftAction: `create:${s.header}:${s.customer}`,
        draftFieldGeneration: /data-reference-generation="(\d+)"/.exec(
          created.html,
        )![1]!,
        [`draftSearch:${s.header}:${s.customer}`]: 'Refused Co',
      });
      const refusedTask = hiddenValue(again.html, 'draftCreateTask');
      s.f.deniedReads.add(`${s.f.ns}:permission.party_create`);
      const refused = await s.fragment({
        draftCreateTask: refusedTask,
        draftCreate: 'submit',
        [`create:${s.f.ns}:field.party_number`]: 'C-REF',
        [`create:${s.f.ns}:field.party_name`]: 'Refused Co',
      });
      assert.equal(refused.statusCode, 422);
      assert.match(refused.html, /data-editor-create-denied/);
      assert.doesNotMatch(refused.html, /value="submit"/);
      const cancelled = await s.fragment({
        draftCreateTask: refusedTask,
        draftCreate: 'cancel',
      });
      assert.deepEqual(s.targets(cancelled), [
        'editor-create-slot',
        `${s.id(s.header, s.customer)}-field`,
        ...s.customerFollowers(s.header),
      ]);
      assert.match(cancelled.html, /data-selected-label="Zenith Glazing"/);
      assert.equal(s.f.executor.calls.length, 2, 'nothing more was written');
    },
  );

  await t.test(
    'a selection from a superseded offered set is refused after its read',
    async () => {
      const s = await setup();
      await s.search(s.header, s.customer, 'Dual', 1);
      // The chosen record's exact read is held while a newer search replaces
      // the offered set with one that does not contain it.
      const hold = s.f.executor.hold(`${s.f.ns}:query.party_get`);
      const older = s.select(s.header, s.customer, s.dual, 1, 0);
      await new Promise((resolve) => setImmediate(resolve));
      const newer = await s.search(s.header, s.customer, 'Readable', 2);
      assert.equal(newer.statusCode, 200);
      assert.doesNotMatch(newer.html, /Dual role co/);
      hold();
      const late = await older;
      assert.equal(late.statusCode, 409);
      assert.doesNotMatch(late.html, /data-selected-label="Dual role co"/);
      assert.match(
        late.html,
        new RegExp(`name="draft:${s.header}:${s.customer}" value=""`),
      );
      // The newer lookup survives, and its own result can be chosen.
      const chosen = await s.select(s.header, s.customer, s.f.party, 2, 0);
      assert.equal(chosen.statusCode, 200);
      assert.match(chosen.html, /data-selected-label="Readable customer"/);
      assert.equal(s.f.executor.calls.length, 0);
    },
  );

  await t.test(
    'a create-open that finishes late never replaces the open create',
    async () => {
      const s = await setup();
      const open = (name: string, generation: string) =>
        s.fragment({
          draftAction: `create:${s.header}:${s.customer}`,
          draftFieldGeneration: generation,
          [`draftSearch:${s.header}:${s.customer}`]: name,
        });
      // The first availability check is held; a second create-open overtakes it.
      const gateway = s.f.gateways.operationGateway;
      const preview = gateway.previewEligibility.bind(gateway);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      gateway.previewEligibility = (async (
        ...args: Parameters<typeof preview>
      ) => {
        if (first) {
          first = false;
          await gate;
        }
        return preview(...args);
      }) as typeof gateway.previewEligibility;
      try {
        const slow = open('Slow Glazing', '0');
        await new Promise((resolve) => setImmediate(resolve));
        const fast = await open('Fast Glazing', '0');
        assert.deepEqual(s.targets(fast), ['editor-create-slot']);
        const fastTask = hiddenValue(fast.html, 'draftCreateTask');
        release();
        const late = await slow;
        assert.equal(late.statusCode, 409);
        assert.doesNotMatch(late.html, /data-editor-create-fragment/);
        // The create that opened first still owns the flow and its keys.
        const cancelled = await s.fragment({
          draftCreateTask: fastTask,
          draftCreate: 'cancel',
        });
        assert.equal(cancelled.statusCode, 200);
        assert.deepEqual(s.targets(cancelled), [
          'editor-create-slot',
          `${s.id(s.header, s.customer)}-field`,
          ...s.customerFollowers(s.header),
        ]);
      } finally {
        gateway.previewEligibility = preview;
      }
      // A create-open based on an older field generation opens nothing.
      await s.search(s.header, s.customer, 'Readable', 1);
      assert.equal(
        (await s.select(s.header, s.customer, s.f.party, 1, 0)).statusCode,
        200,
      );
      const stale = await open('Stale Glazing', '0');
      assert.equal(stale.statusCode, 409);
      assert.match(stale.html, /changed meanwhile/);
      assert.doesNotMatch(stale.html, /data-editor-create-fragment/);
      assert.equal(s.f.executor.calls.length, 0);
    },
  );

  await t.test('a refused quick create focuses its first problem', async () => {
    const s = await setup();
    const opened = await s.fragment({
      draftAction: `create:${s.header}:${s.customer}`,
      draftFieldGeneration: '0',
      [`draftSearch:${s.header}:${s.customer}`]: 'Focus Glazing',
    });
    const refused = await s.fragment({
      draftCreateTask: hiddenValue(opened.html, 'draftCreateTask'),
      draftCreate: 'submit',
      [`create:${s.f.ns}:field.party_number`]: 'C-FOCUS',
      [`create:${s.f.ns}:field.party_name`]: '',
    });
    // The number is valid and comes first; the problem is the name, and it
    // alone is marked for the script and autofocused natively.
    assert.match(
      refused.html,
      /name="create:[^"]+party_name"[^>]*data-task-initial-focus autofocus/,
    );
    assert.equal(
      refused.html.match(/\sdata-task-initial-focus[\s>]/g)?.length,
      1,
    );
    assert.equal(s.f.executor.calls.length, 0);
  });
});

/**
 * The fragment transport over HTTP: only the owned script's same-origin POST,
 * carrying the custom header, is answered in place. A cross-site request is
 * refused, an ordinary POST stays a page, anything the page must answer asks
 * for the fallback, and the page's CSP admits same-origin fetch and nothing
 * more.
 */
test('Milestone B: the fragment transport is same-origin, header-bound and falls back to the page', async () => {
  const f = await orderEntryWitness();
  const server = createSurfaceRuntimeServer(f.entry, f.gateways);
  const baseUrl = await listen(server);
  const path = f.url.pathname + f.url.search;
  try {
    const page = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: 'a' },
    });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get('content-security-policy')!,
      /connect-src 'self';/,
    );
    assert.match(html, /<script>/);
    const session = hiddenValue(html, 'draftSession');
    const header =
      /name="draft:([0-9a-f-]{36}):northstar\.app:field\.sales_order_currency"/.exec(
        html,
      )![1]!;
    const customer = `${f.ns}:field.sales_order_customer_party_id`;
    const body = new URLSearchParams({
      draftSession: session,
      draftVersion: '0',
      draftAction: `search:${header}:${customer}`,
      draftLookupSeq: '1',
      [`draftSearch:${header}:${customer}`]: 'Readable',
    });
    const post = (headers: Record<string, string>, form = body) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: 'a',
          'content-type': 'application/x-www-form-urlencoded',
          ...headers,
        },
        body: form,
        redirect: 'manual',
      });
    const inPlace = await post({
      'x-rain-fragment': '1',
      'sec-fetch-site': 'same-origin',
    });
    assert.equal(inPlace.status, 200);
    assert.equal(inPlace.headers.get('x-rain-fragment'), 'fragment');
    const answer = await inPlace.text();
    assert.match(answer, /^<template data-fragment-target="[^"]+-lookup">/);
    assert.match(answer, /Readable customer/);
    const crossSite = await post({
      'x-rain-fragment': '1',
      'sec-fetch-site': 'cross-site',
    });
    assert.equal(crossSite.status, 403);
    assert.equal(await crossSite.text(), '');
    // Without fetch metadata the request must name this server as its origin.
    const noMetadata = await post({ 'x-rain-fragment': '1' });
    assert.equal(noMetadata.status, 403);
    const foreignOrigin = await post({
      'x-rain-fragment': '1',
      origin: 'https://elsewhere.example',
    });
    assert.equal(foreignOrigin.status, 403);
    const next = new URLSearchParams(body);
    next.set('draftLookupSeq', '2');
    const ownOrigin = await post(
      { 'x-rain-fragment': '1', origin: new URL(baseUrl).origin },
      next,
    );
    assert.equal(ownOrigin.status, 200);
    assert.equal(ownOrigin.headers.get('x-rain-fragment'), 'fragment');
    const ordinary = await post({});
    assert.match(await ordinary.text(), /^<!doctype html>/);
    const unknown = new URLSearchParams(body);
    unknown.set('draftSession', randomUUID());
    const expired = await post(
      { 'x-rain-fragment': '1', 'sec-fetch-site': 'same-origin' },
      unknown,
    );
    assert.equal(expired.status, 409);
    assert.equal(expired.headers.get('x-rain-fragment-fallback'), 'page');
    assert.equal(f.executor.calls.length, 0);
  } finally {
    await close(server);
  }
});

/**
 * RAIN WORKSPACE INTERACTION COMPLETION, milestone C. A composed Task reuses
 * the editor's control semantics. Receiving shows the selected line's product
 * base unit read on the server (a forged unit is ignored), offers the declared
 * currency codes starting from the order's own currency (a forged code is
 * refused), and takes the bound field's exact-decimal bounds for the cost (a
 * malformed cost is named beside its input). Nothing runs until every input is
 * admitted; the committed line carries exactly the reviewed values.
 */
test('Milestone C: receiving inputs are derived, offered and exact, never free text', async () => {
  const f = await orderEntryWitness(true);
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const location = f.executor.seed('location', {
    [`${ns}:field.location_name`]: 'Calgary warehouse',
  });
  const otherLocation = f.executor.seed('location', {
    [`${ns}:field.location_name`]: 'Edmonton yard',
  });
  const order = f.executor.seed(
    'purchase_order',
    {
      [`${ns}:field.purchase_order_number`]: 'PO-RECEIVE',
      [`${ns}:field.purchase_order_supplier_party_id`]: f.party,
      [`${ns}:field.purchase_order_currency`]: 'USD',
      [`${ns}:field.purchase_order_order_date`]: '2026-09-26T09:30:00Z',
      // Selected but unset, as the provider returns them.
      [`${ns}:field.purchase_order_expected_date`]: null,
      [`${ns}:field.purchase_order_notes`]: null,
      // Where the order says its goods are received.
      [`${ns}:field.purchase_order_receiving_location_id`]: location,
      // PURCHASING-PARITY's commercial terms, unset.
      ...Object.fromEntries(
        [
          'payment_terms',
          'tax_code_id',
          'freight_amount',
          'freight_tax_code_id',
          'freight_tax_rate_percent',
          'other_fee_amount',
          'other_fee_tax_code_id',
          'other_fee_tax_rate_percent',
        ].map((name) => [`${ns}:field.purchase_order_${name}`, null]),
      ),
      [`${ns}:derived_state_field.machine.purchase_order_lifecycle`]: `${ns}:state.purchase_order_released`,
    },
    scope,
  );
  const line = f.executor.seed(
    'purchase_order_line',
    {
      [`${ns}:field.purchase_order_line_line_number`]: '1',
      [`${ns}:field.purchase_order_line_item_id`]: f.item,
      [`${ns}:field.purchase_order_line_ordered_quantity`]: '10',
      [`${ns}:field.purchase_order_line_unit_price`]: '2.4',
      [`${ns}:field.purchase_order_line_discount_percent`]: null,
      [`${ns}:field.purchase_order_line_tax_code_id`]: null,
      [`${ns}:field.purchase_order_line_tax_rate_percent`]: null,
      [`${ns}:relation.purchase_order_line_order`]: order,
    },
    scope,
  );
  const lines = `${ns}:dataset.purchasing_lines`;
  const params = new URLSearchParams({
    surface: `${ns}:surface.purchase_order_detail`,
    record: order,
    // The page reads through the order's totals query (PURCHASING-PARITY).
    [`${ns}:parameter.commercial_purchase_order_get_legal_entity_scope`]: scope,
    dataset: lines,
    selected: line,
    [`select:${lines}`]: line,
  });
  const path = `/?${params}`;
  const input = (name: string) => `${ns}:input.receive_${name}`;
  const submit = (body: Record<string, string>) =>
    submitSurfaceRuntimeIntent(
      f.view,
      path,
      { compositionAction: `${ns}:action.receive_known`, ...body },
      f.gateways,
    );
  const entry = await submit({});
  assert.equal(entry.statusCode, 200);
  const taskToken = hiddenValue(entry.html, 'taskToken');
  // The unit is shown, not asked for; the currency is a choice starting from
  // the order's USD; the cost is a decimal input.
  assert.match(
    entry.html,
    /<output class="derived-value" data-derived-input>EA<\/output>/,
  );
  assert.doesNotMatch(entry.html, new RegExp(`name="${input('unit')}"`));
  assert.match(
    entry.html,
    new RegExp(
      `<select name="${input('currency')}"[^>]*>[\\s\\S]*?<option value="USD" selected>`,
    ),
  );
  assert.match(
    entry.html,
    new RegExp(`<input name="${input('cost')}"[^>]*inputmode="decimal"`),
  );
  // The location starts from where the order is received, among the offered
  // locations; the receipt's paperwork is asked for, and neither is required.
  assert.match(
    entry.html,
    new RegExp(
      `<select name="${input('location')}" required><option value="">Select…</option><option value="${location}" selected>Calgary warehouse</option><option value="${otherLocation}" >Edmonton yard</option></select>`,
    ),
  );
  assert.match(
    entry.html,
    new RegExp(
      `<label class="field">Packing slip / delivery note<input name="${input('packing_slip')}" value=""></label>`,
    ),
  );
  assert.match(
    entry.html,
    new RegExp(
      `<label class="field">Notes<textarea name="${input('notes')}" rows="3"></textarea></label>`,
    ),
  );
  const forged = await submit({
    taskToken,
    taskStage: 'prepare',
    [input('quantity')]: '2',
    [input('unit')]: 'BOX',
    [input('location')]: otherLocation,
    [input('cost')]: '2.4.5',
    [input('currency')]: 'GBP',
  });
  // A submitted location is kept over the order's.
  assert.match(
    forged.html,
    new RegExp(
      `<option value="${location}" >Calgary warehouse</option><option value="${otherLocation}" selected>Edmonton yard</option>`,
    ),
  );
  assert.match(forged.html, /COMPOSITION_INPUT_INVALID/);
  assert.match(forged.html, /Choose one of the offered values\./);
  assert.match(forged.html, /Enter a plain number, such as 12\.5\./);
  // The first input with a problem takes focus (autofocus without the script);
  // each message follows its label and describes the input.
  assert.match(
    forged.html,
    new RegExp(
      `<input name="${input('cost')}"[^>]*data-task-initial-focus autofocus`,
    ),
  );
  assert.equal(forged.html.match(/\sdata-task-initial-focus[\s>]/g)?.length, 1);
  assert.match(
    forged.html,
    /<\/label><small class="field-error" id="[^"]*receive_cost-error">Enter a plain number/,
  );
  assert.equal(f.executor.calls.length, 0, 'nothing runs before admission');
  const review = await submit({
    taskToken,
    taskStage: 'prepare',
    [input('quantity')]: '2',
    [input('unit')]: 'BOX',
    [input('location')]: location,
    [input('cost')]: '2.450',
    [input('currency')]: 'CAD',
    [input('packing_slip')]: ' PS-4471 ',
    [input('notes')]: '',
  });
  assert.match(review.html, /<dt>Base unit<\/dt><dd>EA<\/dd>/);
  assert.match(review.html, /<dd>2\.45<\/dd>/);
  assert.match(review.html, /<dd>CAD · Canadian dollar<\/dd>/);
  assert.match(
    review.html,
    /<dt>Packing slip \/ delivery note<\/dt><dd>PS-4471<\/dd>/,
  );
  assert.equal(f.executor.calls.length, 0);
  await submit({
    taskToken,
    taskStage: 'confirm',
    preparedId: hiddenValue(review.html, 'preparedId'),
  });
  // The receipt keeps its paperwork; the notes left empty are no value.
  const receipt = f.executor.calls.find((call) =>
    call.definition.operationId.endsWith(':operation.goods_receipt_create'),
  );
  assert.ok(receipt, 'the receipt create ran');
  const header = asRecord(asRecord(receipt.input).values);
  assert.equal(header[`${ns}:field.goods_receipt_location_id`], location);
  assert.equal(header[`${ns}:field.goods_receipt_packing_slip`], 'PS-4471');
  assert.equal(header[`${ns}:field.goods_receipt_notes`], null);
  const receiptLine = f.executor.calls.find((call) =>
    call.definition.operationId.endsWith(
      ':operation.goods_receipt_line_create',
    ),
  );
  assert.ok(receiptLine, 'the receipt line create ran');
  const values = asRecord(asRecord(receiptLine.input).values);
  assert.equal(values[`${ns}:field.goods_receipt_line_unit_id`], 'EA');
  assert.equal(values[`${ns}:field.goods_receipt_line_currency`], 'CAD');
  assert.equal(values[`${ns}:field.goods_receipt_line_unit_cost`], '2.45');
  assert.equal(values[`${ns}:field.goods_receipt_line_quantity`], '2');
});

/**
 * The same shared semantics in an unrelated, renamed package: a declared
 * choice on a workshop Task admits only its offered values, starting from its
 * declared default, with no Sales or Purchasing identity anywhere in the path.
 */
test('Milestone C: a renamed non-Sales Task input uses the same declared choice semantics', async () => {
  const definition = workshopComposition('Work title');
  const authoredSurface = (
    definition.surfaces as Array<Record<string, unknown>>
  ).find((surface) => surface.composition)!;
  const composition = authoredSurface.composition as unknown as {
    actions: unknown[];
    children: unknown[];
  };
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  composition.children = [];
  composition.actions = [
    {
      actionId: 'workshop.jobs:action.classify',
      label: 'Classify work',
      description: 'Choose the work class.',
      orderKey: 10,
      conditions: [],
      inputs: [
        {
          inputId: 'workshop.jobs:input.class',
          label: 'Work class',
          orderKey: 10,
          type: 'text',
          required: true,
          presentation: {
            kind: 'choice',
            options: [
              { value: 'Routine', label: 'Routine work' },
              { value: 'Urgent', label: 'Urgent work' },
            ],
            defaultValue: 'Routine',
          },
        },
      ],
      steps: [
        {
          stepId: 'workshop.jobs:step.classify',
          operation: ref(
            'operationReference',
            'workshop.jobs:operation.job_update',
          ),
          bindings: [
            {
              path: ['recordId'],
              value: { source: 'record', field: 'recordId' },
            },
            {
              path: ['expectedRevision'],
              value: { source: 'record', field: 'revision' },
            },
            {
              path: ['patch', 'workshop.jobs:field.job_name'],
              value: { source: 'input', inputId: 'workshop.jobs:input.class' },
            },
          ],
        },
      ],
    },
  ];
  const compiled = compileFixture(definition);
  const policy = new RecordingPolicy('ALLOW');
  const view = await issuedView(
    runtimeEntry(compiled, policy, {
      a: identity(tenantA, environmentA, principalA),
    }),
    'a',
  );
  const surface = readCompiledSurfaceManifest(view).surfaces.find(
    (value) => value.surfaceId === 'workshop.jobs:surface.job_record',
  )!;
  const root: SemanticRecordDto = {
    entityId: 'workshop.jobs:entity.job',
    recordId: randomUUID(),
    revision: 3,
    archived: false,
    values: { 'workshop.jobs:field.job_name': 'Original' },
  };
  const calls: SemanticOperationExecutionRequest[] = [];
  const mediation = new SemanticOperationMediationAuthority();
  const gateways: SurfaceRuntimeGateways = {
    queryGateway: fixedQueryGateway('exact', [root]),
    operationMediation: mediation,
    operationGateway: new SemanticOperationGateway(
      policy,
      {
        async execute(request) {
          calls.push(request);
          return {
            kind: 'semanticOperationResult',
            schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
            operationId: request.definition.operationId,
            outcome: 'succeeded',
            readBack: { ...root, revision: 4 },
            unsupportedReason: null,
            trust: {
              invocationId: randomUUID(),
              changeDocumentId: randomUUID(),
              domainEventId: randomUUID(),
              outboxId: randomUUID(),
            },
          };
        },
        async recordNonAccepted() {},
      },
      mediation,
    ),
  };
  const url = `/?surface=${encodeURIComponent(surface.surfaceId)}&record=${root.recordId}`;
  const submit = (body: Record<string, string>) =>
    submitCompositionAction(
      view,
      surface,
      url,
      { compositionAction: 'workshop.jobs:action.classify', ...body },
      gateways,
      (html) => ({ statusCode: 200, html }),
    );
  const initial = await submit({});
  assert.match(
    initial.html,
    /<select name="workshop\.jobs:input\.class" required>[\s\S]*?<option value="Routine" selected>Routine work<\/option>/,
  );
  const taskToken = hiddenValue(initial.html, 'taskToken');
  const forged = await submit({
    taskToken,
    taskStage: 'prepare',
    'workshop.jobs:input.class': 'Anything',
  });
  assert.match(forged.html, /Choose one of the offered values\./);
  assert.equal(calls.length, 0);
  const review = await submit({
    taskToken,
    taskStage: 'prepare',
    'workshop.jobs:input.class': 'Urgent',
  });
  assert.match(review.html, /<dd>Urgent work<\/dd>/);
  const done = await submit({
    taskToken,
    taskStage: 'confirm',
    preparedId: hiddenValue(review.html, 'preparedId'),
  });
  assert.match(done.html, /data-task-result/);
  assert.match(done.html, /Classify work: done/);
  assert.deepEqual(asRecord(calls[0]!.input).patch, {
    'workshop.jobs:field.job_name': 'Urgent',
  });
});

test('FORM-1: unselected lookup results are shown only under the current read authority of each response', async () => {
  const f = await orderEntryWitness();
  const sentinelId = f.executor.seedParty({
    [`${f.ns}:field.party_name`]: 'FORM1_NAME_SENTINEL',
    [`${f.ns}:field.party_number`]: 'FORM1-NUMBER-SENTINEL',
  });
  const protectedResults = /FORM1_NAME_SENTINEL|FORM1-NUMBER-SENTINEL/;
  const path = f.url.pathname + f.url.search;
  const customer = `${f.ns}:field.sales_order_customer_party_id`;
  // Every request below goes through SurfaceRuntime and the real gateways.
  let page = await renderSurfaceRuntimeWithData(f.view, path, f.gateways);
  const header =
    /name="draft:([0-9a-f-]{36}):northstar\.app:field\.sales_order_currency"/.exec(
      page.html,
    )![1]!;
  const submit = async (action: string, extra: Record<string, string> = {}) => {
    page = await submitSurfaceRuntimeIntent(
      f.view,
      path,
      {
        draftSession: hiddenValue(page.html, 'draftSession'),
        draftVersion: hiddenValue(page.html, 'draftVersion'),
        draftAction: action,
        [`draft:${header}:${f.ns}:field.sales_order_notes`]: 'SO-FORM1',
        ...extra,
      },
      f.gateways,
    );
    return page;
  };
  const search = { [`draftSearch:${header}:${customer}`]: 'FORM1' };

  await submit(`search:${header}:${customer}`, search);
  assert.match(page.html, /<strong>FORM1_NAME_SENTINEL<\/strong>/);
  assert.match(page.html, /<small>FORM1-NUMBER-SENTINEL<\/small>/);
  const calls = f.executor.calls.length;

  // Read access is withdrawn between requests; company/order access remains.
  f.deniedReads.add(`${f.ns}:permission.party_read`);
  await submit('add');
  assert.equal(page.html.match(/data-draft-line=/g)!.length, 2);
  assert.doesNotMatch(page.html, protectedResults);
  await submit(`search:${header}:${customer}`, search);
  assert.doesNotMatch(page.html, protectedResults);
  await submit(`more:${header}:${customer}`);
  assert.doesNotMatch(page.html, protectedResults);
  assert.match(page.html, />SO-FORM1<\/textarea>/);
  // Read handling performed no business mutation.
  assert.equal(f.executor.calls.length, calls);

  // Authorized control: search, More and selection work again.
  f.deniedReads.delete(`${f.ns}:permission.party_read`);
  await submit(`search:${header}:${customer}`, search);
  assert.match(page.html, /<strong>FORM1_NAME_SENTINEL<\/strong>/);
  await submit(`more:${header}:${customer}`);
  assert.match(page.html, /<strong>FORM1_NAME_SENTINEL<\/strong>/);
  await submit(`select:${header}:${customer}:${sentinelId}`);
  assert.ok(
    page.html.includes(
      `name="draft:${header}:${customer}" value="${sentinelId}"`,
    ),
  );
  assert.match(page.html, /data-selected-label="FORM1_NAME_SENTINEL"/);
  assert.equal(f.executor.calls.length, calls);
});

test('FORM-PAGING: a bounded lookup says when more matches exist beyond its display limit', async (t) => {
  const limitMessage = 'More matches exist. Refine your search.';
  const paged = async (count: number) => {
    const f = await orderEntryWitness();
    f.executor.pageLists = true;
    const ids = Array.from({ length: count }, (_, index) =>
      f.executor.seedParty({
        [`${f.ns}:field.party_name`]: `Paging match ${String(index + 1).padStart(3, '0')}`,
        [`${f.ns}:field.party_number`]: `PM-${index + 1}`,
      }),
    );
    const path = f.url.pathname + f.url.search;
    const customer = `${f.ns}:field.sales_order_customer_party_id`;
    // Every request goes through SurfaceRuntime and the real gateways.
    let page = await renderSurfaceRuntimeWithData(f.view, path, f.gateways);
    const header =
      /name="draft:([0-9a-f-]{36}):northstar\.app:field\.sales_order_currency"/.exec(
        page.html,
      )![1]!;
    const submit = async (
      action: string,
      extra: Record<string, string> = {},
    ) => {
      page = await submitSurfaceRuntimeIntent(
        f.view,
        path,
        {
          draftSession: hiddenValue(page.html, 'draftSession'),
          draftVersion: hiddenValue(page.html, 'draftVersion'),
          draftAction: action,
          [`draft:${header}:${f.ns}:field.sales_order_notes`]: 'SO-PAGING',
          ...extra,
        },
        f.gateways,
      );
      return page;
    };
    const search = (term: string) =>
      submit(`search:${header}:${customer}`, {
        [`draftSearch:${header}:${customer}`]: term,
      });
    const more = () => submit(`more:${header}:${customer}`);
    const shown = () =>
      page.html.match(/class="reference-option"/g)?.length ?? 0;
    const moreOffered = () =>
      page.html.includes(`value="more:${header}:${customer}"`);
    return {
      f,
      ids,
      header,
      customer,
      submit,
      search,
      more,
      shown,
      moreOffered,
      html: () => page.html,
    };
  };

  await t.test(
    '201 matches: the limit is stated, never presented as exhaustion; narrowing finds match 201',
    async () => {
      const p = await paged(201);
      await p.search('Paging match');
      assert.equal(p.shown(), 20);
      assert.ok(p.moreOffered());
      assert.ok(!p.html().includes(limitMessage));
      // Below the cap with more pages, More works normally.
      await p.more();
      assert.equal(p.shown(), 40);
      assert.ok(p.moreOffered());
      for (let page = 3; page <= 10; page++) await p.more();
      assert.equal(p.shown(), 200);
      assert.ok(p.html().includes(limitMessage));
      assert.ok(!p.moreOffered(), 'no More button that cannot advance');
      assert.doesNotMatch(p.html(), /No customer matches/);
      // The refinement field is described by the message and receives focus.
      const searchBox = /<input type="text" role="combobox"[^>]*>/.exec(
        p.html(),
      )![0];
      const status = /aria-describedby="[^"]*?([^" ]*-status)"/.exec(
        searchBox,
      )![1]!;
      assert.match(
        p.html(),
        new RegExp(
          `id="${status}" role="status"><p class="reference-empty reference-limit"`,
        ),
      );
      assert.match(searchBox, /\sautofocus[\s>]/);
      // A directly submitted More at the cap: bounded work, the same truthful state.
      const partyReads = () =>
        p.f.executor.listReads.get(`${p.f.ns}:query.party_list`) ?? 0;
      const reads = partyReads();
      const capped = await p.more();
      assert.equal(capped.statusCode, 200);
      // At most the ten displayed pages, re-read once under this request's authority.
      assert.ok(partyReads() - reads <= 10);
      assert.equal(p.shown(), 200);
      assert.ok(p.html().includes(limitMessage));
      assert.ok(!p.moreOffered());
      // A narrower search starts again at page one and replaces the offered set.
      await p.search('Paging match 201');
      assert.equal(p.shown(), 1);
      assert.match(p.html(), /<strong>Paging match 201<\/strong>/);
      assert.ok(!p.html().includes(limitMessage));
      const earlier = await p.submit(
        `select:${p.header}:${p.customer}:${p.ids[4]}`,
      );
      assert.equal(earlier.statusCode, 422);
      assert.ok(
        p.html().includes(`name="draft:${p.header}:${p.customer}" value=""`),
      );
      await p.submit(`select:${p.header}:${p.customer}:${p.ids[200]}`);
      assert.ok(
        p
          .html()
          .includes(
            `name="draft:${p.header}:${p.customer}" value="${p.ids[200]}"`,
          ),
      );
      assert.match(p.html(), /data-selected-label="Paging match 201"/);
      assert.match(p.html(), />SO-PAGING<\/textarea>/);
      assert.equal(p.f.executor.calls.length, 0);
    },
  );

  await t.test(
    'exactly 200 matches: genuine exhaustion is not called truncation',
    async () => {
      const p = await paged(200);
      await p.search('Paging match');
      for (let page = 2; page <= 10; page++) await p.more();
      assert.equal(p.shown(), 200);
      assert.ok(!p.html().includes(limitMessage));
      assert.ok(!p.moreOffered());
    },
  );

  await t.test(
    'read withdrawn at the limit: no earlier labels and no availability claim',
    async () => {
      const p = await paged(201);
      await p.search('Paging match');
      for (let page = 2; page <= 10; page++) await p.more();
      assert.ok(p.html().includes(limitMessage));
      p.f.deniedReads.add(`${p.f.ns}:permission.party_read`);
      for (const response of [await p.submit('add'), await p.more()]) {
        assert.doesNotMatch(response.html, /Paging match|PM-\d/);
        assert.ok(!response.html.includes(limitMessage));
      }
      assert.equal(p.f.executor.calls.length, 0);
    },
  );
});

test('FORM-3: a declared choice inside quick create is rendered, defaulted and admitted before any create step', async (t) => {
  type Rendered = NonNullable<Awaited<ReturnType<OrderEntryWitness['open']>>>;
  const choice = {
    kind: 'choice',
    options: [
      { value: 'EA', label: 'EA · Each' },
      { value: 'BOX', label: 'BOX · Box' },
    ],
    defaultValue: 'EA',
  };
  const createSubmit = (
    f: OrderEntryWitness,
    rendered: Rendered,
    values: Record<string, string>,
  ) =>
    documentEditor(
      f.view,
      f.form,
      f.surfaces,
      f.url,
      f.scopes[0]!,
      f.gateways,
      {
        draftSession: hiddenValue(rendered.slots!.keyFacts!, 'draftSession'),
        draftVersion: hiddenValue(rendered.slots!.keyFacts!, 'draftVersion'),
        draftCreateTask: hiddenValue(
          rendered.slots!.keyFacts!,
          'draftCreateTask',
        ),
        draftCreate: 'submit',
        ...values,
      },
    ) as Promise<Rendered>;
  const selectFor = (html: string, name: string) =>
    new RegExp(`<select[^>]*name="${name}"[^>]*>(.*?)</select>`, 's').exec(
      html,
    )?.[1];

  await t.test(
    'Sales product create: base unit is a declared choice',
    async () => {
      const f = await orderEntryWitness(false, (source) => {
        for (const surface of source.surfaces as Array<
          Record<string, unknown>
        >) {
          const editor = surface.documentEditor as
            | {
                lineFields: Array<{
                  fieldId: string;
                  reference?: {
                    create: {
                      fields: Array<{
                        fieldId: string;
                        presentation?: unknown;
                      }>;
                    };
                  };
                }>;
              }
            | undefined;
          if (!String(surface.surfaceId).endsWith(':surface.sales_order_form'))
            continue;
          const product = editor!.lineFields.find((field) =>
            field.fieldId.endsWith('_line_item_id'),
          )!;
          for (const collected of product.reference!.create.fields)
            if (String(collected.fieldId).endsWith(':field.item_base_unit'))
              collected.presentation = choice;
        }
      });
      const unit = `create:${f.ns}:field.item_base_unit`;
      let editor = (await f.open())!;
      const line = /data-draft-line="([^"]+)"/.exec(
        editor.slots!.sections!,
      )![1]!;
      const productField = `${f.ns}:field.sales_order_line_item_id`;
      editor = (await f.post(editor, `create:${line}:${productField}`, {
        [`draftSearch:${line}:${productField}`]: 'Pallet jack',
      }))!;
      const options = selectFor(editor.slots!.keyFacts!, unit);
      assert.ok(options, 'the declared choice renders as a select');
      assert.match(options, /<option value="EA" selected>EA · Each<\/option>/);
      assert.match(options, /<option value="BOX">BOX · Box<\/option>/);
      const forged = await createSubmit(f, editor, {
        [`create:${f.ns}:field.item_sku`]: 'PJ-1',
        [`create:${f.ns}:field.item_name`]: 'Pallet jack',
        [unit]: 'PALLET',
      });
      assert.equal(forged.statusCode, 422);
      assert.match(
        forged.slots!.keyFacts!,
        /Base unit: choose one of the offered values/,
      );
      assert.equal(f.executor.calls.length, 0);
      // The entered, refused value is not replaced by the default; the form stays open.
      assert.doesNotMatch(
        selectFor(forged.slots!.keyFacts!, unit) ?? '',
        /value="EA" selected/,
      );
      const created = await createSubmit(f, forged, {
        [`create:${f.ns}:field.item_sku`]: 'PJ-1',
        [`create:${f.ns}:field.item_name`]: 'Pallet jack',
        [unit]: 'BOX',
      });
      assert.equal(created.statusCode, 200);
      assert.match(created.slots!.keyFacts!, /data-editor-create-selected/);
      const [item] = f.executor.calls;
      assert.equal(f.executor.calls.length, 1);
      assert.equal(
        asRecord(asRecord(item!.input).values)[`${f.ns}:field.item_base_unit`],
        'BOX',
      );
      assert.match(created.slots!.sections!, /class="derived-value"[^>]*>BOX</);
    },
  );

  await t.test(
    'non-Sales two-step create: a refused later-step choice commits no step',
    async () => {
      const id = (kind: string, local: string) =>
        `northstar.app:${kind}.${local}`;
      const f = await orderEntryWitness(true, (source) => {
        for (const surface of source.surfaces as Array<
          Record<string, unknown>
        >) {
          if (
            !String(surface.surfaceId).endsWith(':surface.purchase_order_form')
          )
            continue;
          const editor = surface.documentEditor as {
            headerFields: Array<Record<string, unknown>>;
          };
          const notes = editor.headerFields.find((field) =>
            String(field.fieldId).endsWith('_notes'),
          )!;
          delete notes.presentation;
          notes.label = 'Adjustment';
          notes.reference = {
            queryId: id('query', 'inventory_transaction_list'),
            getQueryId: id('query', 'inventory_transaction_get'),
            labelFieldIds: [id('field', 'inventory_transaction_number')],
            create: {
              label: 'New adjustment',
              explanation: 'Creates the adjustment and its first line.',
              fields: [
                {
                  fieldId: id('field', 'inventory_transaction_number'),
                  label: 'Adjustment number',
                },
                {
                  fieldId: id('field', 'inventory_transaction_line_unit_id'),
                  label: 'Line unit',
                  presentation: choice,
                },
              ],
              steps: [
                {
                  operationId: id('operation', 'inventory_transaction_create'),
                  fixed: [
                    {
                      fieldId: id('field', 'inventory_transaction_state'),
                      value: id('option', 'inventory_transaction_state_draft'),
                    },
                    {
                      fieldId: id('field', 'inventory_transaction_type'),
                      value: id(
                        'option',
                        'inventory_transaction_type_adjustment',
                      ),
                    },
                  ],
                },
                {
                  operationId: id(
                    'operation',
                    'inventory_transaction_line_create',
                  ),
                  relations: [
                    {
                      relationId: id(
                        'relation',
                        'inventory_transaction_line_transaction',
                      ),
                      step: 0,
                    },
                  ],
                },
              ],
              selectStep: 0,
            },
          };
        }
      });
      const unit = `create:${f.ns}:field.inventory_transaction_line_unit_id`;
      let editor = (await f.open())!;
      const header =
        /name="draft:([0-9a-f-]{36}):northstar\.app:field\.purchase_order_currency"/.exec(
          editor.slots!.keyFacts!,
        )![1]!;
      const notes = `${f.ns}:field.purchase_order_notes`;
      editor = (await f.post(editor, `create:${header}:${notes}`))!;
      assert.match(
        selectFor(editor.slots!.keyFacts!, unit) ?? '',
        /<option value="EA" selected>/,
      );
      const forged = await createSubmit(f, editor, {
        [`create:${f.ns}:field.inventory_transaction_number`]: 'ADJ-FORM3',
        [unit]: 'PALLET',
      });
      assert.equal(forged.statusCode, 422);
      assert.match(
        forged.slots!.keyFacts!,
        /Line unit: choose one of the offered values/,
      );
      // Zero create-step effects: not even the earlier transaction step ran.
      assert.equal(f.executor.calls.length, 0);
      const created = await createSubmit(f, forged, {
        [`create:${f.ns}:field.inventory_transaction_number`]: 'ADJ-FORM3',
        [unit]: 'BOX',
      });
      assert.match(created.slots!.keyFacts!, /data-editor-create-selected/);
      const [transaction, line] = f.executor.calls;
      assert.equal(f.executor.calls.length, 2);
      assert.equal(
        asRecord(asRecord(line!.input).values)[
          `${f.ns}:field.inventory_transaction_line_unit_id`
        ],
        'BOX',
      );
      assert.equal(
        asRecord(asRecord(line!.input).relations)[
          `${f.ns}:relation.inventory_transaction_line_transaction`
        ],
        asRecord(transaction!.input).recordId,
      );
    },
  );
});

test('order entry: choice, advisory preference invalidation, foreign scope and identity separation never retarget an open buffer', async () => {
  const f = await orderEntryWitness();
  const entryUrl = new URL(
    `http://fixture.local/?surface=${encodeURIComponent(f.list.surfaceId)}`,
  );
  assert.equal(
    (await resolveWorkspaceEntry(
      f.view,
      f.list,
      new URL(entryUrl),
      f.gateways.queryGateway,
    ))!.selected,
    null,
  );
  const explicit = new URL(entryUrl);
  explicit.searchParams.set(
    `${f.ns}:parameter.sales_order_list_legal_entity_scope`,
    f.scopes[1]!,
  );
  assert.equal(
    (await resolveWorkspaceEntry(
      f.view,
      f.list,
      explicit,
      f.gateways.queryGateway,
    ))!.selected,
    f.scopes[1],
  );
  assert.equal(
    (await resolveWorkspaceEntry(
      f.view,
      f.list,
      new URL(entryUrl),
      f.gateways.queryGateway,
    ))!.selected,
    f.scopes[1],
  );
  for (const token of ['b', 'c', 'd'])
    assert.equal(
      (await resolveWorkspaceEntry(
        await issuedView(f.entry, token),
        f.list,
        new URL(entryUrl),
        f.gateways.queryGateway,
      ))!.selected,
      null,
    );
  const duplicate = new URL(explicit);
  duplicate.searchParams.append(
    `${f.ns}:parameter.sales_order_list_legal_entity_scope`,
    f.scopes[0]!,
  );
  assert.equal(
    (await resolveWorkspaceEntry(
      f.view,
      f.list,
      duplicate,
      f.gateways.queryGateway,
    ))!.invalid,
    true,
  );
  const company = f.executor.rows.get(f.scopes[1]!)!;
  f.executor.rows.set(company.recordId, {
    ...company,
    values: {
      ...company.values,
      [`${f.ns}:field.legal_entity_status`]: `${f.ns}:option.legal_entity_status_inactive`,
    },
  });
  assert.equal(
    (await resolveWorkspaceEntry(
      f.view,
      f.list,
      new URL(entryUrl),
      f.gateways.queryGateway,
    ))!.selected,
    f.scopes[0],
  );
  assert.equal(
    (await resolveWorkspaceEntry(
      f.view,
      f.list,
      explicit,
      f.gateways.queryGateway,
    ))!.invalid,
    true,
  );
  f.executor.rows.set(company.recordId, company);
  await assert.rejects(
    f.gateways.queryGateway.invoke(f.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: `${f.ns}:query.sales_order_list`,
      arguments: { includeArchived: false },
    }),
  );
  const draft = (await f.open())!;
  f.allowed.delete(f.scopes[1]!);
  assert.equal(
    (await resolveWorkspaceEntry(
      f.view,
      f.list,
      new URL(entryUrl),
      f.gateways.queryGateway,
    ))!.selected,
    f.scopes[0],
  );
  assert.equal(
    (await resolveWorkspaceEntry(
      f.view,
      f.list,
      explicit,
      f.gateways.queryGateway,
    ))!.invalid,
    true,
  );
  explicit.searchParams.set(
    `${f.ns}:parameter.sales_order_list_legal_entity_scope`,
    randomUUID(),
  );
  assert.equal(
    (await resolveWorkspaceEntry(
      f.view,
      f.list,
      explicit,
      f.gateways.queryGateway,
    ))!.invalid,
    true,
  );
  const saved = await f.post(draft, 'save', f.values(draft));
  assert.equal(saved!.statusCode, 303);
  assert.equal(
    f.executor.owners.get(
      String(asRecord(f.executor.calls[0]!.input).recordId),
    ),
    f.scopes[0],
  );
  const pinned = (await f.open())!;
  f.allowed.delete(f.scopes[0]!);
  const beforeRevocation = f.executor.calls.length;
  const denied = await submitSurfaceRuntimeIntent(
    f.view,
    f.url.pathname + f.url.search,
    {
      draftSession: hiddenValue(pinned.slots!.keyFacts!, 'draftSession'),
      draftVersion: hiddenValue(pinned.slots!.keyFacts!, 'draftVersion'),
      draftAction: 'save',
      ...f.values(pinned),
    },
    f.gateways,
  );
  assert.equal(denied.statusCode, 422);
  assert.match(denied.html, /WORKSPACE_COMPANY_UNAVAILABLE/);
  assert.equal(f.executor.calls.length, beforeRevocation);
  f.allowed.clear();
  assert.equal(
    (await resolveWorkspaceEntry(
      f.view,
      f.list,
      new URL(entryUrl),
      f.gateways.queryGateway,
    ))!.options.length,
    0,
  );
});
test('order entry: stale edits retain inputs, released documents stay locked, persisted removal confirms immutable archive and committed readback never retries', async () => {
  const f = await orderEntryWitness();
  let editor = (await f.open())!;
  const initial = await f.post(editor, 'save', f.values(editor));
  const id = new URL(
    initial!.location!,
    'http://fixture.local',
  ).searchParams.get('record')!;
  f.url.searchParams.set('record', id);
  editor = (await f.open())!;
  const header = f.executor.rows.get(id)!;
  f.executor.rows.set(id, { ...header, revision: header.revision + 1 });
  const values = f.values(editor);
  const notes = Object.keys(values).find((key) => key.endsWith('_notes'))!;
  values[notes] = 'Retained stale input';
  const stale = (await f.post(editor, 'save', values))!;
  assert.equal(stale.statusCode, 409);
  assert.match(stale.slots!.keyFacts!, /Retained stale input/);
  editor = (await f.open())!;
  const line = [...f.executor.rows.values()].find((row) =>
    row.entityId.endsWith(':entity.sales_order_line'),
  )!;
  const removalValues = f.values(editor);
  removalValues[
    Object.keys(removalValues).find(
      (key) => key.includes(line.recordId) && key.endsWith('_ordered_quantity'),
    )!
  ] = '999';
  editor = (await f.post(editor, `remove:${line.recordId}`, removalValues))!;
  const before = f.executor.calls.length;
  const review = (await f.post(editor, 'save', f.values(editor)))!;
  assert.equal(f.executor.calls.length, before);
  assert.match(review.slots!.commandBar!, /Confirm removal and save/);
  assert.doesNotMatch(review.slots!.sections!, /value="999"/);
  await f.post(review, 'confirm', {
    [`draft:${line.recordId}:${f.ns}:field.sales_order_line_ordered_quantity`]:
      '999',
  });
  assert.equal(f.executor.rows.get(line.recordId)!.archived, true);
  const updated = f.executor.rows.get(id)!;
  f.executor.rows.set(id, {
    ...updated,
    values: {
      ...updated.values,
      [`${f.ns}:derived_state_field.machine.sales_order_lifecycle`]: `${f.ns}:state.sales_order_released`,
    },
  });
  const locked = await f.open();
  assert.equal(locked!.statusCode, 422);
  assert.match(locked!.html, /DRAFT_EDITOR_LOCKED/);
  const g = await orderEntryWitness();
  const open = (await g.open())!;
  g.executor.withheld = true;
  const committed = (await g.post(open, 'save', g.values(open)))!;
  assert.equal(committed.statusCode, 200);
  assert.match(committed.html, /OPERATION_COMMITTED_READBACK_WITHHELD/);
  assert.doesNotMatch(
    committed.html,
    /Readable customer|Readable product|Retry save/,
  );
  g.deniedReads.add(`${g.ns}:permission.sales_order_read`);
  g.deniedReads.add(`${g.ns}:permission.sales_order_line_read`);
  assert.equal((await g.post(open, 'retry'))!.statusCode, 200);
  assert.equal(g.executor.calls.length, 1);
});

test('order entry: buffered persisted lines recheck read authority before edits and redact withheld repeats', async () => {
  const f = await orderEntryWitness();
  const initial = (await f.open())!;
  const saved = (await f.post(initial, 'save', f.values(initial)))!;
  f.url.searchParams.set(
    'record',
    new URL(saved.location!, 'http://fixture.local').searchParams.get(
      'record',
    )!,
  );
  const editor = (await f.open())!;
  f.deniedReads.add(`${f.ns}:permission.sales_order_line_read`);
  const before = f.executor.calls.length;
  const denied = await submitSurfaceRuntimeIntent(
    f.view,
    f.url.pathname + f.url.search,
    {
      draftSession: hiddenValue(editor.slots!.keyFacts!, 'draftSession'),
      draftVersion: hiddenValue(editor.slots!.keyFacts!, 'draftVersion'),
      draftAction: 'save',
      ...f.values(editor),
    },
    f.gateways,
  );
  assert.equal(denied.statusCode, 422);
  assert.doesNotMatch(
    denied.html,
    /Readable customer|Readable product|<fieldset[^>]*data-draft-line/,
  );
  assert.equal(f.executor.calls.length, before);
});

test('native Task policy reuses non-Sales forms, fresh Record context and exact prepared identity', async () => {
  const fixture = await correctionTaskFixture(true);
  const review = await fixture.prepare('8', fixture.locations[0]!.recordId);
  assert.equal((review.html.match(/<dialog /g) ?? []).length, 1);
  assert.equal((review.html.match(/<script\b/g) ?? []).length, 1);
  assert.match(review.html, /data-task-fallback="page"/);
  assert.match(review.html, /data-task-phase="review"/);
  assert.match(
    review.html,
    /data-composition-dataset="workshop.jobs:dataset.assignments"/,
  );
  assert.equal((review.html.match(/name="preparedId"/g) ?? []).length, 1);
  assert.equal(fixture.calls.length, 0);
  const replacement = await fixture.prepare(
    '5',
    fixture.locations[1]!.recordId,
  );
  await fixture.submit(fixture.confirmation(review.html));
  assert.equal(fixture.calls.length, 0);
  const result = await fixture.submit(fixture.confirmation(replacement.html));
  assert.match(result.html, /data-task-phase="result"/);
  assert.match(result.html, /Closing this task does not undo submitted work/);
  assert.equal(fixture.calls.length, 2);
  await fixture.submit(fixture.confirmation(replacement.html));
  assert.equal(fixture.calls.length, 2);
  fixture.denied.add('workshop.jobs:permission.assignment_read');
  const denied = await fixture.submit(fixture.confirmation(replacement.html));
  assertTaskRedacted(denied);
  assert.doesNotMatch(denied.html, /<dialog /);
});

test('P1 task response rechecks root, child and label reads and redacts committed withheld repeats', async (t) => {
  for (const permission of [
    'job_read',
    'assignment_read',
    'location_label_read',
  ])
    await t.test(permission, async () => {
      const fixture = await correctionTaskFixture();
      const preview = await fixture.prepare(
        '8',
        fixture.locations[0]!.recordId,
      );
      assert.match(preview.html, /PROTECTED_LOCATION_A/);
      fixture.denied.add(`workshop.jobs:permission.${permission}`);
      const denied = await fixture.submit({
        taskToken: fixture.taskToken,
        taskStage: 'edit',
      });
      assertTaskRedacted(denied);
      assert.equal(fixture.calls.length, 0);
    });
  await t.test('committed withheld and repeated requests', async () => {
    const fixture = await correctionTaskFixture();
    const preview = await fixture.prepare('8', fixture.locations[0]!.recordId);
    fixture.setWithheld();
    fixture.onExecute(async () => {
      fixture.denied.add('workshop.jobs:permission.location_read');
    });
    for (const body of [
      fixture.confirmation(preview.html),
      { taskToken: fixture.taskToken, taskStage: 'retry' },
      fixture.confirmation(preview.html),
    ]) {
      const response = await fixture.submit(body);
      assert.equal(
        response.statusCode,
        200,
        'a committed operation remains success when display is withheld',
      );
      assert.match(response.html, /COMPOSITION_COMMITTED_WITHHELD/);
      assertTaskRedacted(response);
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.effects.length, 1);
    }
  });
});

test('P2 stale review cannot confirm replacement inputs', async () => {
  const fixture = await correctionTaskFixture();
  const first = await fixture.prepare('8', fixture.locations[0]!.recordId);
  const latest = await fixture.prepare('5', fixture.locations[1]!.recordId);
  await fixture.submit(fixture.confirmation(first.html));
  assert.equal(
    fixture.calls.length,
    0,
    'stale review form must not dispatch the latest session values',
  );
  await fixture.submit(fixture.confirmation(latest.html));
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(
    (asRecord(fixture.calls[0]!.input).patch as Record<string, unknown>)[
      'workshop.jobs:field.job_amount'
    ],
    '5',
  );
  assert.deepEqual(
    (asRecord(fixture.calls[0]!.input).patch as Record<string, unknown>)[
      'workshop.jobs:field.job_notes'
    ],
    fixture.locations[1]!.recordId,
  );
});

test('P2 missing forged and unprepared confirmations never dispatch', async () => {
  const fixture = await correctionTaskFixture();
  for (const preparedId of ['', 'forged'])
    await fixture.submit({
      taskToken: fixture.taskToken,
      taskStage: 'confirm',
      preparedId,
    });
  assert.equal(fixture.calls.length, 0);
  const valid = await fixture.prepare('5', fixture.locations[1]!.recordId);
  for (const preparedId of ['', 'forged'])
    await fixture.submit({
      taskToken: fixture.taskToken,
      taskStage: 'confirm',
      preparedId,
    });
  assert.equal(fixture.calls.length, 0);
  await fixture.submit(fixture.confirmation(valid.html));
  await fixture.submit(fixture.confirmation(valid.html));
  assert.equal(
    fixture.calls.length,
    2,
    'completed confirmation cannot repost either step',
  );
  assert.equal(fixture.effects.length, 2);
});

test('P2 deferred preparation cannot overwrite newer confirmed inputs and retry keeps exact keys', async () => {
  const fixture = await correctionTaskFixture();
  const validating = deferredSignal();
  const finishValidation = deferredSignal();
  let referenceReads = 0;
  fixture.beforeReferences(async () => {
    if (referenceReads++ === 0) {
      validating.resolve();
      await finishValidation.promise;
    }
  });
  const older = fixture.prepare('8', fixture.locations[0]!.recordId);
  await validating.promise;
  const latest = await fixture.prepare('5', fixture.locations[1]!.recordId);
  const executing = deferredSignal();
  const finishExecution = deferredSignal();
  fixture.onExecute(async () => {
    if (fixture.calls.length === 1) {
      executing.resolve();
      await finishExecution.promise;
      throw new Error('Controlled response loss after fixture effect');
    }
  });
  const confirmed = fixture.submit(fixture.confirmation(latest.html));
  await executing.promise;
  finishValidation.resolve();
  const superseded = await older;
  assert.match(superseded.html, /COMPOSITION_TASK_UNAVAILABLE/);
  const duplicate = await fixture.submit(fixture.confirmation(latest.html));
  assert.match(duplicate.html, /COMPOSITION_BUSY/);
  await fixture.prepare('9', fixture.locations[0]!.recordId);
  assert.equal(fixture.calls.length, 1);
  finishExecution.resolve();
  assert.match((await confirmed).html, /COMPOSITION_UNCERTAIN/);
  const retried = await fixture.submit({
    taskToken: fixture.taskToken,
    taskStage: 'retry',
    'workshop.jobs:input.quantity': '99',
  });
  assert.match(retried.html, /COMPOSITION_COMPLETE/);
  assert.equal(fixture.calls.length, 3);
  assert.deepEqual(
    fixture.calls[1]!.input,
    fixture.calls[0]!.input,
    'generated instant, reviewed values and revision are unchanged',
  );
  assert.equal(
    fixture.calls[1]!.idempotencyKey,
    fixture.calls[0]!.idempotencyKey,
  );
  const patch = asRecord(fixture.calls[1]!.input).patch as Record<
    string,
    unknown
  >;
  assert.equal(patch['workshop.jobs:field.job_amount'], '5');
  assert.equal(
    patch['workshop.jobs:field.job_notes'],
    fixture.locations[1]!.recordId,
  );
  assert.equal(
    fixture.effects.length,
    2,
    'same-key retry adds no second fixture effect',
  );
});

test('P1 uncertain response redacts preview inputs after dependency revocation and permits same-key recovery', async () => {
  const fixture = await correctionTaskFixture();
  const prepared = await fixture.prepare('5', fixture.locations[1]!.recordId);
  fixture.onExecute(async () => {
    if (fixture.calls.length === 1) {
      fixture.denied.add('workshop.jobs:permission.location_read');
      throw new Error('Controlled response loss');
    }
  });
  const uncertain = await fixture.submit(fixture.confirmation(prepared.html));
  assert.match(uncertain.html, /COMPOSITION_UNCERTAIN/);
  assertTaskRedacted(uncertain);
  assert.equal(fixture.calls.length, 1);
  fixture.denied.clear();
  const recovered = await fixture.submit({
    taskToken: fixture.taskToken,
    taskStage: 'retry',
  });
  assert.equal(recovered.statusCode, 200);
  assert.match(recovered.html, /PROTECTED_ROOT_SENTINEL/);
  assert.match(recovered.html, /COMPOSITION_COMPLETE/);
  assert.deepEqual(fixture.calls[1]!.input, fixture.calls[0]!.input);
  assert.equal(
    fixture.calls[1]!.idempotencyKey,
    fixture.calls[0]!.idempotencyKey,
  );
});

test('PURCHASING-PARITY: Expected receipts sums, counts and marks late orders in the statement, re-authorizing progress per request', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const [scope, foreign] = f.scopes as [string, string];
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const list = id('surface', 'expected_receipt_list');
  const view = (local: string) =>
    id('list_view', `expected_receipt_list_${local}`);
  const column = (local: string) =>
    id('list_column', `expected_receipt_list_${local}`);
  // Orders with lines and received quantities, stored as the providers do:
  // a line points at its order, a received row at its line.
  const order = (
    number: string,
    state: string,
    expected: string | null,
    lines: readonly (readonly [ordered: number, received: number])[],
    company = scope,
    archivedLine?: number,
  ) => {
    const orderId = f.executor.seed(
      'purchase_order',
      {
        [id('field', 'purchase_order_number')]: number,
        [id('field', 'purchase_order_supplier_party_id')]: f.party,
        [id('field', 'purchase_order_expected_date')]: expected,
        [id('field', 'purchase_order_currency')]: 'CAD',
        [id('derived_state_field', 'machine.purchase_order_lifecycle')]: id(
          'state',
          `purchase_order_${state}`,
        ),
      },
      company,
    );
    for (const [ordered, received] of lines) {
      const lineId = f.executor.seed(
        'purchase_order_line',
        {
          [id('field', 'purchase_order_line_ordered_quantity')]:
            String(ordered),
          [id('relation', 'purchase_order_line_order')]: orderId,
        },
        company,
      );
      if (received > 0)
        f.executor.seed(
          'purchase_order_received',
          {
            [id('field', 'purchase_order_received_received_quantity')]:
              String(received),
            [id('relation', 'purchase_order_received_order_line')]: lineId,
          },
          company,
        );
    }
    if (archivedLine !== undefined) {
      const lineId = f.executor.seed(
        'purchase_order_line',
        {
          [id('field', 'purchase_order_line_ordered_quantity')]:
            String(archivedLine),
          [id('relation', 'purchase_order_line_order')]: orderId,
        },
        company,
      );
      f.executor.rows.set(lineId, {
        ...f.executor.rows.get(lineId)!,
        archived: true,
      });
    }
    return orderId;
  };
  const late = order('PO-LATE', 'released', '2026-09-25T12:00:00.000Z', [
    [10, 4],
    [5, 0],
  ]);
  order('PO-FUTURE', 'released', '2026-10-09T00:00:00.000Z', [[6, 0]]);
  order('PO-DONE', 'released', '2026-09-20T00:00:00.000Z', [[3, 3]]);
  order('PO-DRAFT', 'draft', '2026-09-01T00:00:00.000Z', [[7, 0]]);
  order(
    'PO-YESTERDAY',
    'released',
    '2026-09-28T23:00:00.000Z',
    [[8, 0]],
    scope,
    2,
  );
  order('PO-UNDATED', 'released', null, [[2, 0]]);
  order(
    'PO-FOREIGN',
    'released',
    '2026-09-01T00:00:00.000Z',
    [[9, 0]],
    foreign,
  );
  const parameter = `${ns}:parameter.expected_receipt_list_legal_entity_scope`;
  const url = (parameters: Record<string, string> = {}) =>
    `/?${new URLSearchParams({ surface: list, [parameter]: scope, ...parameters }).toString()}`;
  const at = (instant: string) => ({
    ...f.gateways,
    clock: () => new Date(instant),
  });
  const counts = (html: string) =>
    Object.fromEntries(
      [
        ...html.matchAll(
          /data-view-id="([^"]+)"[^>]*>(?:<span>[^<]*<\/span>)<span class="list-view__count" data-view-count="(\d+)"/gu,
        ),
      ].map((match) => [match[1]!, Number(match[2]!)]),
    );
  const cell = (html: string, recordId: string, local: string) =>
    new RegExp(
      `data-record-id="${recordId}"[\\s\\S]*?data-column-id="${column(local)}">([\\s\\S]*?)</td>`,
      'u',
    ).exec(html)?.[1];

  // Tabs are server counts of the open and before filters, under one clock.
  const today = await renderSurfaceRuntimeWithData(
    f.view,
    url(),
    at('2026-09-29T15:00:00.000Z'),
  );
  assert.equal(today.statusCode, 200);
  assert.deepEqual(counts(today.html), {
    [view('to_receive')]: 4,
    [view('late')]: 2,
    [view('all_released')]: 5,
  });
  assert.match(today.html, /data-list-total="4"/u);
  assert.match(today.html, /data-list-anchor="2026-09-29T00:00:00\.000Z"/u);
  // Order-level units across its active lines; an archived line adds nothing.
  assert.equal(cell(today.html, late, 'ordered'), '15');
  assert.equal(cell(today.html, late, 'received'), '4');
  assert.equal(cell(today.html, late, 'open'), '11');
  assert.match(
    cell(today.html, late, 'expected_date') ?? '',
    /Sep 25, 2026 <span class="status-pill" data-status-role="attention" data-overdue-days="4">4 days late<\/span>/u,
  );
  assert.match(today.html, /data-overdue-days="1">1 day late/u);
  assert.equal([...today.html.matchAll(/data-overdue-days=/gu)].length, 2);
  assert.doesNotMatch(today.html, /PO-DONE|PO-DRAFT|PO-FOREIGN/u);
  // Progress columns are shown, never offered as a sort.
  assert.doesNotMatch(
    today.html,
    new RegExp(`data-sort-column="${column('open')}"`, 'u'),
  );

  // The Late tab is the before-today set; another day moves it.
  const lateTab = await renderSurfaceRuntimeWithData(
    f.view,
    url({ view: view('late') }),
    at('2026-09-29T15:00:00.000Z'),
  );
  assert.match(lateTab.html, /data-list-total="2"/u);
  assert.match(lateTab.html, /PO-LATE/u);
  assert.match(lateTab.html, /PO-YESTERDAY/u);
  const earlier = await renderSurfaceRuntimeWithData(
    f.view,
    url({ view: view('late') }),
    at('2026-09-26T10:00:00.000Z'),
  );
  assert.match(earlier.html, /data-list-total="1"/u);
  assert.match(earlier.html, /data-overdue-days="1">1 day late/u);

  // Every progress read passed current policy for the companies listed.
  const progressCalls = f.policy.calls.filter(
    (call) =>
      (call.decisionInput as { kind?: string }).kind ===
      'registeredSemanticListProgressPolicyInput',
  );
  assert.deepEqual(
    [...new Set(progressCalls.map((call) => call.permissionId))].sort(),
    [
      id('permission', 'purchase_order_line_read'),
      id('permission', 'purchase_order_received_read'),
    ],
  );
  assert.ok(
    progressCalls.every(
      (call) =>
        JSON.stringify(
          (call.decisionInput as { arguments: Record<string, unknown> })
            .arguments[parameter],
        ) === JSON.stringify([scope]),
    ),
  );

  // The export carries the figures as exact decimals, one statement per view.
  const exported = await renderSurfaceRuntimeWithData(
    f.view,
    url({ export: 'csv' }),
    at('2026-09-29T15:00:00.000Z'),
  );
  assert.equal(exported.statusCode, 200);
  const rows = exported
    .download!.body.replace(/^\uFEFF/u, '')
    .trimEnd()
    .split('\r\n');
  assert.equal(
    rows[0],
    'Number,Supplier,Expected,Ordered,Received,Open,Currency',
  );
  assert.equal(rows.length - 1, 4);
  assert.ok(
    rows.some(
      (row) => row.startsWith('PO-LATE,') && row.includes(',15,4,11,CAD'),
    ),
  );

  // The agent reads the same List through its published preset.
  const presets = (
    f.view.projections.agent.payload as {
      listPresets: Array<{
        surfaceId: string;
        progress?: { outputs: Record<string, string> };
        views: Array<{ viewId: string; open?: true; before?: unknown }>;
      }>;
    }
  ).listPresets;
  const preset = presets.find((value) => value.surfaceId === list)!;
  assert.ok(preset.progress);
  assert.deepEqual(
    preset.views.map((value) => [
      value.viewId,
      value.open === true,
      value.before !== undefined,
    ]),
    [
      [view('to_receive'), true, false],
      [view('late'), true, true],
      [view('all_released'), false, false],
    ],
  );

  // Two Lists read purchase orders: the Purchase orders List keeps standing
  // for them -- its navigation and the receipt form's order picker. It reads
  // its orders with their totals (ORDER-PARITY), under its own parameter.
  const orders = await renderSurfaceRuntimeWithData(
    f.view,
    `/?${new URLSearchParams({ surface: id('surface', 'purchase_order_list'), [`${ns}:parameter.commercial_purchase_order_list_legal_entity_scope`]: scope }).toString()}`,
    at('2026-09-29T15:00:00.000Z'),
  );
  assert.match(
    orders.html,
    /<strong class="topbar__context">Purchase orders<\/strong>/u,
  );
  assert.match(
    today.html,
    /<strong class="topbar__context">Expected receipts<\/strong>/u,
  );
  for (const [page, current] of [
    [today.html, 'expected_receipt_list'],
    [orders.html, 'purchase_order_list'],
  ] as const) {
    const marked = [
      ...page.matchAll(
        /<a href="\/\?surface=northstar\.app%3Asurface\.([a-z_]+)[^"]*" aria-current="page">/gu,
      ),
    ].map((match) => match[1]);
    assert.deepEqual(marked, [current]);
  }
  const receiptForm = await renderSurfaceRuntimeWithData(
    f.view,
    `/?${new URLSearchParams({ surface: id('surface', 'goods_receipt_form'), [`${ns}:parameter.goods_receipt_get_legal_entity_scope`]: scope }).toString()}`,
    f.gateways,
  );
  assert.doesNotMatch(receiptForm.html, /RELATION_ENUMERATION_UNAVAILABLE/u);
  assert.match(receiptForm.html, /PO-LATE/u);

  // Without received-quantity read the List is refused by the progress
  // query's name; the Purchase orders List reads it as supplementary figures
  // (ORDER-PARITY) and still serves without them.
  f.deniedReads.add(id('permission', 'purchase_order_received_read'));
  const denied = await renderSurfaceRuntimeWithData(
    f.view,
    url(),
    at('2026-09-29T15:00:00.000Z'),
  );
  assert.match(denied.html, /data-diagnostic-code="QUERY_PERMISSION_DENIED"/u);
  assert.doesNotMatch(denied.html, /PO-LATE/u);
  const refused = await f.gateways.queryGateway
    .invoke(f.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: id('query', 'expected_receipt_list'),
      arguments: {
        includeArchived: false,
        [parameter]: scope,
        list: {
          cursor: null,
          matchMode: 'substring',
          pageSize: 10,
          relationLabels: [],
          schemaVersion: 'northstar.shared-list-query/v1',
          search: '',
          sort: [],
          progress: {
            lines: {
              fieldId: id('field', 'purchase_order_line_ordered_quantity'),
              queryId: id('query', 'purchase_order_line_list'),
              relationId: id('relation', 'purchase_order_line_order'),
            },
            done: {
              fieldId: id('field', 'purchase_order_received_received_quantity'),
              queryId: id('query', 'purchase_order_received_list'),
              relationId: id('relation', 'purchase_order_received_order_line'),
            },
            outputs: {
              done: id('list_output', 'expected_receipt_list_received'),
              open: id('list_output', 'expected_receipt_list_open'),
              ordered: id('list_output', 'expected_receipt_list_ordered'),
            },
          },
        },
      },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  assert.ok(refused instanceof SemanticQueryPolicyDeniedError);
  assert.equal(refused.queryId, id('query', 'purchase_order_received_list'));
  const stillServed = await renderSurfaceRuntimeWithData(
    f.view,
    `/?${new URLSearchParams({ surface: id('surface', 'purchase_order_list'), [`${ns}:parameter.commercial_purchase_order_list_legal_entity_scope`]: scope }).toString()}`,
    f.gateways,
  );
  assert.doesNotMatch(stillServed.html, /QUERY_PERMISSION_DENIED/u);
  assert.match(stillServed.html, /PO-LATE/u);
});

test('PURCHASING-PARITY: a line with nothing left to arrive offers no receipt; a withheld open quantity keeps it offered', async () => {
  const f = await orderEntryWitness(true);
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const order = f.executor.seed(
    'purchase_order',
    {
      [`${ns}:field.purchase_order_number`]: 'PO-NOTHING-OPEN',
      [`${ns}:field.purchase_order_supplier_party_id`]: f.party,
      [`${ns}:field.purchase_order_currency`]: 'CAD',
      [`${ns}:field.purchase_order_order_date`]: '2026-09-26T09:30:00Z',
      // Selected but unset, as the provider returns them.
      ...Object.fromEntries(
        [
          'expected_date',
          'notes',
          'receiving_location_id',
          'payment_terms',
          'tax_code_id',
          'freight_amount',
          'freight_tax_code_id',
          'freight_tax_rate_percent',
          'other_fee_amount',
          'other_fee_tax_code_id',
          'other_fee_tax_rate_percent',
        ].map((name) => [`${ns}:field.purchase_order_${name}`, null]),
      ),
      [`${ns}:derived_state_field.machine.purchase_order_lifecycle`]: `${ns}:state.purchase_order_released`,
    },
    scope,
  );
  const line = f.executor.seed(
    'purchase_order_line',
    {
      [`${ns}:field.purchase_order_line_line_number`]: '1',
      [`${ns}:field.purchase_order_line_item_id`]: f.item,
      [`${ns}:field.purchase_order_line_ordered_quantity`]: '2',
      [`${ns}:field.purchase_order_line_unit_price`]: '2.4',
      [`${ns}:field.purchase_order_line_discount_percent`]: null,
      [`${ns}:field.purchase_order_line_tax_code_id`]: null,
      [`${ns}:field.purchase_order_line_tax_rate_percent`]: null,
      [`${ns}:relation.purchase_order_line_order`]: order,
    },
    scope,
  );
  const lines = `${ns}:dataset.purchasing_lines`;
  const path = `/?${new URLSearchParams({
    surface: `${ns}:surface.purchase_order_detail`,
    record: order,
    [`${ns}:parameter.commercial_purchase_order_get_legal_entity_scope`]: scope,
    dataset: lines,
    selected: line,
    [`select:${lines}`]: line,
  })}`;
  // The commercial read model states the line's open quantity as given: a
  // canonical decimal, or nothing when the received read is withheld.
  const gatewaysStating = (open: string | null): SurfaceRuntimeGateways => ({
    ...f.gateways,
    queryGateway: new SemanticQueryGateway(
      f.policy,
      f.executor,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        'northstar.sales:capability.fulfillment': async ({ result }) => result,
        'northstar.sales:capability.commercial': async ({
          definition,
          result,
        }) => ({
          ...result,
          records: result.records.map((record) => ({
            ...record,
            values: {
              ...record.values,
              ...Object.fromEntries(
                Object.entries(definition.readModel!.resultFields).map(
                  ([key, fieldId]) => [
                    fieldId,
                    key === 'open_to_receive' ? open : null,
                  ],
                ),
              ),
            },
          })),
        }),
      },
    ),
  });
  const receive = ['receive_known', 'receive_absent'].map(
    (local) => `value="${ns}:action.${local}"`,
  );
  for (const [open, offered] of [
    ['0', false],
    [null, true],
    ['3', true],
  ] as const) {
    const html = (
      await renderSurfaceRuntimeWithData(f.view, path, gatewaysStating(open))
    ).html;
    // The line stays selected either way; only what it offers changes.
    assert.match(html, /aria-current="true">Selected<\/a>/u, String(open));
    for (const action of receive)
      assert.equal(html.includes(action), offered, `${action} open=${open}`);
  }
  // A stale page cannot start the receipt: submission re-checks the offer.
  const stale = await submitSurfaceRuntimeIntent(
    f.view,
    path,
    { compositionAction: `${ns}:action.receive_known` },
    gatewaysStating('0'),
  );
  assert.match(stale.html, /COMPOSITION_TASK_UNAVAILABLE/u);
  assert.equal(f.executor.calls.length, 0);
});

test('ORDER-PARITY: order Lists sum their lines, link each row to its work, and serve without figures current policy withholds', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const [scope, foreign] = f.scopes as [string, string];
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  // The real commercial read model states each paged order's total from its
  // lines, read through the gateway as the List's own request is.
  const gateways: SurfaceRuntimeGateways = {
    ...f.gateways,
    clock: () => new Date('2026-09-29T15:00:00.000Z'),
    queryGateway: new SemanticQueryGateway(
      f.policy,
      f.executor,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        'northstar.sales:capability.fulfillment': async ({ result }) => result,
        'northstar.sales:capability.commercial': commercialReadModel,
      },
    ),
  };
  const counts = (html: string) =>
    Object.fromEntries(
      [
        ...html.matchAll(
          /data-view-id="([^"]+)"[^>]*>(?:<span>[^<]*<\/span>)(?:<span class="list-view__count" data-view-count="(\d+)")?/gu,
        ),
      ].map((match) => [
        match[1]!,
        match[2] === undefined ? null : Number(match[2]),
      ]),
    );
  const row = (html: string, recordId: string) =>
    new RegExp(
      `<tr data-compact-card="true" data-record-id="${recordId}">([\\s\\S]*?)</tr>`,
      'u',
    ).exec(html)?.[1] ?? '';
  const cell = (html: string, recordId: string, column: string) =>
    new RegExp(`data-column-id="${column}">([\\s\\S]*?)</td>`, 'u').exec(
      row(html, recordId),
    )?.[1];
  const action = (html: string, recordId: string) => {
    const match =
      /<a class="secondary-action" href="([^"]+)" data-row-action="([^"]+)" aria-label="([^"]+)">([^<]+)<\/a>/u.exec(
        row(html, recordId),
      );
    return match
      ? {
          href: match[1]!.replaceAll('&amp;', '&'),
          actionId: match[2]!,
          name: match[3]!,
          label: match[4]!,
        }
      : null;
  };
  const withheldMark = '<span class="muted">—</span>';

  // Sales: orders with lines and shipped quantities, stored as the providers
  // do -- a line points at its order, a shipped row at its line.
  const salesOrder = (
    number: string,
    state: string,
    lines: readonly (readonly [ordered: number, shipped: number])[],
    company = scope,
  ) => {
    const orderId = f.executor.seed(
      'sales_order',
      {
        [id('field', 'sales_order_number')]: number,
        [id('field', 'sales_order_customer_party_id')]: f.party,
        [id('field', 'sales_order_order_date')]: '2026-09-20T12:00:00.000Z',
        [id('field', 'sales_order_currency')]: 'CAD',
        [id('derived_state_field', 'machine.sales_order_lifecycle')]: id(
          'state',
          `sales_order_${state}`,
        ),
      },
      company,
    );
    for (const [ordered, shipped] of lines) {
      const lineId = f.executor.seed(
        'sales_order_line',
        {
          [id('field', 'sales_order_line_ordered_quantity')]: String(ordered),
          [id('relation', 'sales_order_line_order')]: orderId,
        },
        company,
      );
      if (shipped > 0)
        f.executor.seed(
          'sales_order_shipped',
          {
            [id('field', 'sales_order_shipped_shipped_quantity')]:
              String(shipped),
            [id('relation', 'sales_order_shipped_order_line')]: lineId,
          },
          company,
        );
    }
    return orderId;
  };
  const open = salesOrder('SO-OPEN', 'released', [
    [10, 4],
    [5, 0],
  ]);
  const shipped = salesOrder('SO-SHIPPED', 'released', [[3, 3]]);
  const draft = salesOrder('SO-DRAFT', 'draft', [[7, 0]]);
  salesOrder('SO-FOREIGN', 'released', [[9, 0]], foreign);
  const salesView = (local: string) =>
    id('list_view', `sales_order_list_${local}`);
  const salesColumn = (local: string) =>
    id('list_column', `sales_order_list_${local}`);
  const salesUrl = (parameters: Record<string, string> = {}) =>
    `/?${new URLSearchParams({
      surface: id('surface', 'sales_order_list'),
      [id('parameter', 'sales_order_list_legal_entity_scope')]: scope,
      ...parameters,
    }).toString()}`;

  const sales = await renderSurfaceRuntimeWithData(
    f.view,
    salesUrl(),
    gateways,
  );
  assert.equal(sales.statusCode, 200);
  // Tabs are server counts; To ship is released with something open. These
  // lines name no stocked item, so what is open on the released order is
  // short (SUPPLY-WARNINGS) and nothing is reserved.
  assert.deepEqual(counts(sales.html), {
    [salesView('all')]: 3,
    [salesView('to_ship')]: 1,
    [salesView('blocked')]: 1,
    [salesView('reserved')]: 0,
    [salesView('draft')]: 1,
    [salesView('released')]: 2,
    [salesView('closed')]: 0,
    [salesView('cancelled')]: 0,
  });
  assert.equal(cell(sales.html, open, salesColumn('ordered')), '15');
  assert.equal(cell(sales.html, open, salesColumn('shipped')), '4');
  assert.equal(cell(sales.html, open, salesColumn('open')), '11');
  // Open reads 0 outside the released state, and once all has shipped.
  assert.equal(cell(sales.html, draft, salesColumn('open')), '0');
  assert.equal(cell(sales.html, shipped, salesColumn('open')), '0');
  assert.doesNotMatch(sales.html, /SO-FOREIGN/u);
  assert.match(sales.html, /<th scope="col">Actions<\/th>/u);
  // The row's one action: Fulfill while something is open on a released
  // order, at its fulfillment section; otherwise View, at the page itself.
  const fulfill = action(sales.html, open)!;
  assert.deepEqual(
    [fulfill.label, fulfill.name, fulfill.actionId],
    [
      'Fulfill',
      'Fulfill SO-OPEN',
      id('list_row_action', 'sales_order_list_fulfill'),
    ],
  );
  const target = new URL(fulfill.href, 'http://fixture.local');
  assert.equal(
    target.searchParams.get('surface'),
    id('surface', 'sales_order_detail'),
  );
  assert.equal(target.searchParams.get('record'), open);
  assert.equal(
    target.searchParams.get(
      id('parameter', 'commercial_order_get_legal_entity_scope'),
    ),
    scope,
  );
  assert.equal(target.hash, `#${id('dataset', 'fulfillment_lines')}`);
  for (const other of [shipped, draft]) {
    const view = action(sales.html, other)!;
    assert.equal(view.label, 'View');
    assert.equal(new URL(view.href, 'http://fixture.local').hash, '');
  }
  // Progress re-enters current policy for the companies listed, every request.
  const progressCalls = f.policy.calls.filter(
    (call) =>
      (call.decisionInput as { kind?: string }).kind ===
      'registeredSemanticListProgressPolicyInput',
  );
  assert.deepEqual(
    [...new Set(progressCalls.map((call) => call.permissionId))].sort(),
    [
      id('permission', 'sales_order_line_read'),
      id('permission', 'sales_order_shipped_read'),
    ],
  );
  // One page, eight tab counts: each passed both reads.
  assert.equal(progressCalls.length, 2 * 9);
  const toShip = await renderSurfaceRuntimeWithData(
    f.view,
    salesUrl({ view: salesView('to_ship') }),
    gateways,
  );
  assert.match(toShip.html, /data-list-total="1"/u);
  assert.match(toShip.html, /SO-OPEN/u);
  assert.doesNotMatch(toShip.html, /SO-SHIPPED|SO-DRAFT/u);

  // Without shipped-quantity read the figures are supplementary: the List
  // serves its other views with "—", saying which figures it reads without;
  // To ship, which only they can judge, is refused by name and not counted.
  f.deniedReads.add(id('permission', 'sales_order_shipped_read'));
  const withheld = await renderSurfaceRuntimeWithData(
    f.view,
    salesUrl(),
    gateways,
  );
  assert.equal(withheld.statusCode, 200);
  assert.doesNotMatch(withheld.html, /data-diagnostic-code=/u);
  assert.deepEqual(counts(withheld.html), {
    [salesView('all')]: 3,
    [salesView('to_ship')]: null,
    [salesView('blocked')]: null,
    [salesView('reserved')]: null,
    [salesView('draft')]: 1,
    [salesView('released')]: 2,
    [salesView('closed')]: 0,
    [salesView('cancelled')]: 0,
  });
  // The supply extends the progress, so it is withheld with it.
  for (const local of ['ordered', 'shipped', 'open', 'short'])
    assert.equal(cell(withheld.html, open, salesColumn(local)), withheldMark);
  assert.match(
    withheld.html,
    new RegExp(
      `data-list-progress-withheld="${id('query', 'sales_order_shipped_list')}">Ordered, Shipped, Open and Short are withheld by current policy; To ship, Blocked by supply and Reserved need them and are unavailable.<`,
      'u',
    ),
  );
  // Nothing open can be stated, so no row promises the work.
  assert.equal(action(withheld.html, open)?.label, 'View');
  const refusedView = await renderSurfaceRuntimeWithData(
    f.view,
    salesUrl({ view: salesView('to_ship') }),
    gateways,
  );
  assert.match(
    refusedView.html,
    /data-diagnostic-code="QUERY_PERMISSION_DENIED"/u,
  );
  assert.doesNotMatch(refusedView.html, /SO-OPEN/u);
  assert.equal(counts(refusedView.html)[salesView('all')], 3);
  assert.match(refusedView.html, /aria-current="page"><span>To ship<\/span>/u);
  // The export follows the page: the figures' columns are empty; an open
  // view refuses rather than writing every row.
  const exported = await renderSurfaceRuntimeWithData(
    f.view,
    salesUrl({ export: 'csv' }),
    gateways,
  );
  assert.equal(exported.statusCode, 200);
  const csv = exported
    .download!.body.replace(/^\uFEFF/u, '')
    .trimEnd()
    .split('\r\n');
  assert.equal(
    csv[0],
    'Number,Customer,Salesperson,Order date,Requested,Status,Ordered,Shipped,Open,Short,Currency',
  );
  assert.ok(csv.some((line) => /^SO-OPEN,.*,,,,,CAD$/u.test(line)));
  const refusedExport = await renderSurfaceRuntimeWithData(
    f.view,
    salesUrl({ view: salesView('to_ship'), export: 'csv' }),
    gateways,
  );
  assert.equal(refusedExport.statusCode, 422);
  assert.match(refusedExport.html, /QUERY_PERMISSION_DENIED/u);
  // The gateway itself still refuses a request carrying the progress, by
  // the progress query's name: the fallback is the runtime's, per request.
  const refused = await gateways.queryGateway
    .invoke(f.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: id('query', 'sales_order_list'),
      arguments: {
        includeArchived: false,
        [id('parameter', 'sales_order_list_legal_entity_scope')]: scope,
        list: {
          cursor: null,
          matchMode: 'substring',
          pageSize: 10,
          relationLabels: [],
          schemaVersion: 'northstar.shared-list-query/v1',
          search: '',
          sort: [],
          progress: {
            lines: {
              fieldId: id('field', 'sales_order_line_ordered_quantity'),
              queryId: id('query', 'commercial_lines'),
              relationId: id('relation', 'sales_order_line_order'),
            },
            done: {
              fieldId: id('field', 'sales_order_shipped_shipped_quantity'),
              queryId: id('query', 'sales_order_shipped_list'),
              relationId: id('relation', 'sales_order_shipped_order_line'),
            },
            outputs: {
              done: id('list_output', 'sales_order_list_shipped'),
              open: id('list_output', 'sales_order_list_open'),
              ordered: id('list_output', 'sales_order_list_ordered'),
            },
          },
        },
      },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  assert.ok(refused instanceof SemanticQueryPolicyDeniedError);
  assert.equal(refused.queryId, id('query', 'sales_order_shipped_list'));
  f.deniedReads.clear();

  // Purchasing: the List reads its commercial clone, so each order states its
  // total from its own lines, beside its received and open units.
  const purchase = (
    number: string,
    state: string,
    expected: string | null,
    lines: readonly (readonly [
      ordered: number,
      received: number,
      price: string | null,
    ])[],
  ) => {
    const orderId = f.executor.seed(
      'purchase_order',
      {
        [id('field', 'purchase_order_number')]: number,
        [id('field', 'purchase_order_supplier_party_id')]: f.party,
        [id('field', 'purchase_order_order_date')]: '2026-09-01T12:00:00.000Z',
        [id('field', 'purchase_order_expected_date')]: expected,
        [id('field', 'purchase_order_currency')]: 'CAD',
        [id('derived_state_field', 'machine.purchase_order_lifecycle')]: id(
          'state',
          `purchase_order_${state}`,
        ),
      },
      scope,
    );
    for (const [index, [ordered, received, price]] of lines.entries()) {
      const lineId = f.executor.seed(
        'purchase_order_line',
        {
          [id('field', 'purchase_order_line_line_number')]: String(index + 1),
          [id('field', 'purchase_order_line_ordered_quantity')]:
            String(ordered),
          [id('field', 'purchase_order_line_unit_price')]: price,
          [id('relation', 'purchase_order_line_order')]: orderId,
        },
        scope,
      );
      if (received > 0)
        f.executor.seed(
          'purchase_order_received',
          {
            [id('field', 'purchase_order_received_received_quantity')]:
              String(received),
            [id('relation', 'purchase_order_received_order_line')]: lineId,
          },
          scope,
        );
    }
    return orderId;
  };
  const late = purchase('PO-LATE', 'released', '2026-09-25T12:00:00.000Z', [
    [10, 4, '2.5'],
    [5, 0, '1.2'],
  ]);
  const received = purchase('PO-RECEIVED', 'released', null, [[3, 3, '4']]);
  const unpriced = purchase('PO-UNPRICED', 'draft', null, [[2, 0, null]]);
  const purchaseView = (local: string) =>
    id('list_view', `purchase_order_list_${local}`);
  const purchaseColumn = (local: string) =>
    id('list_column', `purchase_order_list_${local}`);
  // The clone renames the company parameter; the List reads by its own.
  const purchaseUrl = (parameters: Record<string, string> = {}) =>
    `/?${new URLSearchParams({
      surface: id('surface', 'purchase_order_list'),
      [id('parameter', 'commercial_purchase_order_list_legal_entity_scope')]:
        scope,
      ...parameters,
    }).toString()}`;
  const orders = await renderSurfaceRuntimeWithData(
    f.view,
    purchaseUrl(),
    gateways,
  );
  assert.equal(orders.statusCode, 200);
  assert.deepEqual(counts(orders.html), {
    [purchaseView('all')]: 3,
    [purchaseView('to_receive')]: 1,
    [purchaseView('late')]: 1,
    [purchaseView('draft')]: 1,
    [purchaseView('released')]: 2,
    [purchaseView('closed')]: 0,
    [purchaseView('cancelled')]: 0,
  });
  assert.equal(cell(orders.html, late, purchaseColumn('ordered')), '15');
  assert.equal(cell(orders.html, late, purchaseColumn('received')), '4');
  assert.equal(cell(orders.html, late, purchaseColumn('open')), '11');
  // 10 × 2.50 + 5 × 1.20, untaxed: the figure the order page states.
  assert.equal(cell(orders.html, late, purchaseColumn('total')), '31.00');
  assert.equal(cell(orders.html, received, purchaseColumn('total')), '12.00');
  // An unpriced line states no total, never a guessed one.
  assert.equal(
    cell(orders.html, unpriced, purchaseColumn('total')),
    withheldMark,
  );
  // The Total is shown, never offered as a sort; the Expected date of the
  // row the Late tab counts reads how late it is.
  assert.doesNotMatch(
    orders.html,
    new RegExp(`data-sort-column="${purchaseColumn('total')}"`, 'u'),
  );
  assert.match(
    cell(orders.html, late, purchaseColumn('expected_date')) ?? '',
    /data-overdue-days="4">4 days late/u,
  );
  const receive = action(orders.html, late)!;
  assert.deepEqual(
    [receive.label, receive.name],
    ['Receive', 'Receive PO-LATE'],
  );
  const receiving = new URL(receive.href, 'http://fixture.local');
  assert.equal(
    receiving.searchParams.get('surface'),
    id('surface', 'purchase_order_detail'),
  );
  assert.equal(
    receiving.searchParams.get(
      id('parameter', 'commercial_purchase_order_get_legal_entity_scope'),
    ),
    scope,
  );
  assert.equal(receiving.hash, `#${id('dataset', 'purchasing_lines')}`);
  assert.equal(action(orders.html, received)?.label, 'View');
  assert.equal(action(orders.html, unpriced)?.label, 'View');
  // The page read its query and each paged order's lines, nothing else.
  const binding = readCompiledSurfaceDataBinding(
    f.view,
    f.surfaces.find(
      (value) => value.surfaceId === id('surface', 'purchase_order_list'),
    )!,
  );
  assert.equal(
    binding.query.queryId,
    id('query', 'commercial_purchase_order_list'),
  );

  // Without line read neither the figures nor the totals can be stated: the
  // List still serves every view that is not open, with "—" for both.
  f.deniedReads.add(id('permission', 'purchase_order_line_read'));
  const linesWithheld = await renderSurfaceRuntimeWithData(
    f.view,
    purchaseUrl(),
    gateways,
  );
  assert.equal(linesWithheld.statusCode, 200);
  assert.doesNotMatch(linesWithheld.html, /data-diagnostic-code=/u);
  for (const local of ['ordered', 'received', 'open', 'total'])
    assert.equal(
      cell(linesWithheld.html, late, purchaseColumn(local)),
      withheldMark,
      local,
    );
  assert.match(
    linesWithheld.html,
    new RegExp(
      `data-list-progress-withheld="${id('query', 'purchase_order_line_list')}">Ordered, Received and Open are withheld by current policy; To receive and Late need them and are unavailable.<`,
      'u',
    ),
  );
  assert.doesNotMatch(linesWithheld.html, /data-overdue-days=/u);
  assert.equal(action(linesWithheld.html, late)?.label, 'View');
  const lateRefused = await renderSurfaceRuntimeWithData(
    f.view,
    purchaseUrl({ view: purchaseView('late') }),
    gateways,
  );
  assert.match(
    lateRefused.html,
    /data-diagnostic-code="QUERY_PERMISSION_DENIED"/u,
  );
  assert.deepEqual(counts(lateRefused.html), {
    [purchaseView('all')]: 3,
    [purchaseView('to_receive')]: null,
    [purchaseView('late')]: null,
    [purchaseView('draft')]: 1,
    [purchaseView('released')]: 2,
    [purchaseView('closed')]: 0,
    [purchaseView('cancelled')]: 0,
  });
  // A single order's read keeps refusing: its page is its lines.
  await assert.rejects(
    gateways.queryGateway.invoke(f.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: id('query', 'commercial_purchase_order_get'),
      arguments: {
        recordId: late,
        includeArchived: false,
        [id('parameter', 'commercial_purchase_order_get_legal_entity_scope')]:
          scope,
      },
    }),
    SemanticQueryPolicyDeniedError,
  );
  // Expected receipts keeps its refusal: its progress is its purpose.
  f.deniedReads.clear();
  f.deniedReads.add(id('permission', 'purchase_order_received_read'));
  const expected = await renderSurfaceRuntimeWithData(
    f.view,
    `/?${new URLSearchParams({
      surface: id('surface', 'expected_receipt_list'),
      [id('parameter', 'expected_receipt_list_legal_entity_scope')]: scope,
    }).toString()}`,
    gateways,
  );
  assert.match(
    expected.html,
    /data-diagnostic-code="QUERY_PERMISSION_DENIED"/u,
  );
  assert.doesNotMatch(expected.html, /data-view-id=/u);
  // With received read withheld the totals still stand: they read lines.
  const receivedWithheld = await renderSurfaceRuntimeWithData(
    f.view,
    purchaseUrl(),
    gateways,
  );
  assert.equal(
    cell(receivedWithheld.html, late, purchaseColumn('total')),
    '31.00',
  );
  assert.equal(
    cell(receivedWithheld.html, late, purchaseColumn('received')),
    withheldMark,
  );
});

test('SUPPLY-WARNINGS: the Sales orders List counts Blocked by supply and Reserved in the statement, marks what each order is short and links reserved work to its shipments, without the supply current policy withholds', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const [scope, foreign] = f.scopes as [string, string];
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const field = (local: string) => id('field', local);
  const relation = (local: string) => id('relation', local);
  const salesView = (local: string) =>
    id('list_view', `sales_order_list_${local}`);
  const salesColumn = (local: string) =>
    id('list_column', `sales_order_list_${local}`);
  const salesUrl = (parameters: Record<string, string> = {}) =>
    `/?${new URLSearchParams({
      surface: id('surface', 'sales_order_list'),
      [id('parameter', 'sales_order_list_legal_entity_scope')]: scope,
      ...parameters,
    }).toString()}`;
  const counts = (html: string) =>
    Object.fromEntries(
      [
        ...html.matchAll(
          /data-view-id="([^"]+)"[^>]*>(?:<span>[^<]*<\/span>)(?:<span class="list-view__count" data-view-count="(\d+)")?/gu,
        ),
      ].map((match) => [
        match[1]!,
        match[2] === undefined ? null : Number(match[2]),
      ]),
    );
  const row = (html: string, recordId: string) =>
    new RegExp(
      `<tr data-compact-card="true" data-record-id="${recordId}">([\\s\\S]*?)</tr>`,
      'u',
    ).exec(html)?.[1] ?? '';
  const cell = (html: string, recordId: string, local: string) =>
    new RegExp(
      `data-column-id="${salesColumn(local)}">([\\s\\S]*?)</td>`,
      'u',
    ).exec(row(html, recordId))?.[1];
  const action = (html: string, recordId: string) => {
    const match =
      /<a class="secondary-action" href="([^"]+)" data-row-action="([^"]+)" aria-label="([^"]+)">([^<]+)<\/a>/u.exec(
        row(html, recordId),
      );
    return match
      ? {
          href: match[1]!.replaceAll('&amp;', '&'),
          actionId: match[2]!,
          name: match[3]!,
          label: match[4]!,
        }
      : null;
  };
  const rows = (html: string) =>
    [
      ...html.matchAll(
        /<tr data-compact-card="true" data-record-id="([^"]+)">/gu,
      ),
    ]
      .map((match) => match[1]!)
      .sort();
  const withheldMark = '<span class="muted">—</span>';
  const shortMark =
    ' <span class="status-pill" data-status-role="blocked" data-short-mark="true"><span aria-hidden="true">!</span><span class="sr-only">Short of stock</span></span>';

  // Stock as the providers keep it: posted balances by item and location,
  // reservations with what their balances still hold. Free stock of the valve
  // now is the 10 at the warehouse less the 3 + 2 reservations hold there:
  // 5. The 4 in quarantine is on hand but not usable, and what a reservation
  // holds there reduces nothing usable; another company's 100 is its own.
  const location = (code: string, status: string) =>
    f.executor.seed('location', {
      [field('location_code')]: code,
      [field('location_name')]: code,
      [field('location_type')]: id('option', 'location_type_warehouse'),
      [field('location_status')]: id('option', `location_status_${status}`),
      [field('location_status_reason')]: null,
      [field('location_status_changed_at')]: null,
    });
  const warehouse = location('WH-1', 'usable');
  const hold = location('QA-HOLD', 'quarantine');
  const valve = f.executor.seed('item', {
    [field('item_name')]: 'Valve',
    [field('item_sku')]: 'VALVE-10',
    [field('item_base_unit')]: 'EA',
  });
  const bolt = f.executor.seed('item', {
    [field('item_name')]: 'Bolt',
    [field('item_sku')]: 'BOLT-20',
    [field('item_base_unit')]: 'EA',
  });
  const balance = (
    itemId: string,
    locationId: string,
    quantity: string,
    company = scope,
  ) =>
    f.executor.seed(
      'posted_stock_balance',
      {
        [field('posted_stock_balance_item_id')]: itemId,
        [field('posted_stock_balance_location_id')]: locationId,
        [field('posted_stock_balance_posted_quantity')]: quantity,
        [field('posted_stock_balance_unit_id')]: 'EA',
      },
      company,
    );
  balance(valve, warehouse, '10');
  balance(valve, hold, '4');
  balance(valve, warehouse, '100', foreign);
  balance(bolt, warehouse, '3');
  const reserve = (
    itemId: string,
    locationId: string,
    remaining: string,
    lineId: string | null,
  ) => {
    const reservationId = f.executor.seed(
      'reservation',
      {
        [field('reservation_number')]: `RSV-${randomUUID()}`,
        [field('reservation_state')]: id('option', 'reservation_state_active'),
        [field('reservation_item_id')]: itemId,
        [field('reservation_location_id')]: locationId,
        [field('reservation_quantity')]: remaining,
        [field('reservation_unit_id')]: 'EA',
        [field('reservation_reason')]: null,
        ...(lineId ? { [relation('reservation_order_line')]: lineId } : {}),
      },
      scope,
    );
    f.executor.seed(
      'reservation_balance',
      {
        [field('reservation_balance_remaining_quantity')]: remaining,
        [field('reservation_balance_unit_id')]: 'EA',
        [relation('reservation_balance_reservation')]: reservationId,
      },
      scope,
    );
  };
  // Orders: each line points at its order, a shipped row at its line.
  const sale = (
    number: string,
    state: string,
    lines: readonly (readonly [itemId: string, ordered: string])[],
    company = scope,
  ) => {
    const orderId = f.executor.seed(
      'sales_order',
      {
        [field('sales_order_number')]: number,
        [field('sales_order_customer_party_id')]: f.party,
        [field('sales_order_order_date')]: '2026-10-01T12:00:00.000Z',
        [field('sales_order_currency')]: 'CAD',
        [id('derived_state_field', 'machine.sales_order_lifecycle')]: id(
          'state',
          `sales_order_${state}`,
        ),
      },
      company,
    );
    const lineIds = lines.map(([itemId, ordered], index) =>
      f.executor.seed(
        'sales_order_line',
        {
          [field('sales_order_line_item_id')]: itemId,
          [field('sales_order_line_line_number')]: String(index + 1),
          [field('sales_order_line_ordered_quantity')]: ordered,
          [relation('sales_order_line_order')]: orderId,
        },
        company,
      ),
    );
    return { orderId, lineIds };
  };
  // Two valve lines share the 5 free: 9 ordered with 3 of its own reserved
  // and 5 more leave 11 uncovered, so the order is 6 short.
  const short = sale('SO-SHORT', 'released', [
    [valve, '9'],
    [valve, '5'],
  ]);
  reserve(valve, warehouse, '3', short.lineIds[0]!);
  // Stock reserved for another order: covered, so nothing short.
  const elsewhere = sale('SO-ELSEWHERE', 'released', [[valve, '2']]);
  reserve(valve, warehouse, '2', elsewhere.lineIds[0]!);
  // Held in quarantine: shown as reserved there, never reducing usable stock.
  reserve(valve, hold, '1', null);
  // Enough bolts free: open, nothing reserved, nothing short.
  const bolts = sale('SO-BOLTS', 'released', [[bolt, '3']]);
  // A draft asking for more bolts than are free is short, as its page says,
  // but not blocked: only a confirmed order waits for supply.
  const draft = sale('SO-DRAFT', 'draft', [[bolt, '5']]);
  // Nothing is short once an order is closed.
  const closed = sale('SO-CLOSED', 'closed', [[valve, '7']]);
  sale('SO-FOREIGN', 'released', [[valve, '50']], foreign);

  const supplyCalls = () =>
    f.policy.calls.filter(
      (call) =>
        (call.decisionInput as { kind?: string }).kind ===
        'registeredSemanticListSupplyPolicyInput',
    );
  const before = supplyCalls().length;
  const sales = await renderSurfaceRuntimeWithData(
    f.view,
    salesUrl(),
    f.gateways,
  );
  assert.equal(sales.statusCode, 200);
  assert.doesNotMatch(sales.html, /SO-FOREIGN|data-list-supply-withheld/u);
  // Every tab is a server count of exactly its set.
  assert.deepEqual(counts(sales.html), {
    [salesView('all')]: 5,
    [salesView('to_ship')]: 3,
    [salesView('blocked')]: 1,
    [salesView('reserved')]: 2,
    [salesView('draft')]: 1,
    [salesView('released')]: 3,
    [salesView('closed')]: 1,
    [salesView('cancelled')]: 0,
  });
  // Short is the order's, marked where anything is short.
  assert.equal(cell(sales.html, short.orderId, 'short'), `6${shortMark}`);
  assert.equal(cell(sales.html, draft.orderId, 'short'), `2${shortMark}`);
  for (const order of [elsewhere, bolts, closed])
    assert.equal(cell(sales.html, order.orderId, 'short'), '0');
  assert.equal(cell(sales.html, short.orderId, 'open'), '14');
  // Reserved stock still to ship leads the row's actions: a link to the
  // order's fulfillment section, where its own ship Task is.
  const post = action(sales.html, short.orderId)!;
  assert.deepEqual(
    [post.label, post.name, post.actionId],
    [
      'Post shipment',
      'Post shipment SO-SHORT',
      id('list_row_action', 'sales_order_list_post_shipment'),
    ],
  );
  const target = new URL(post.href, 'http://fixture.local');
  assert.equal(
    target.searchParams.get('surface'),
    id('surface', 'sales_order_detail'),
  );
  assert.equal(target.searchParams.get('record'), short.orderId);
  assert.equal(target.hash, `#${id('dataset', 'fulfillment_lines')}`);
  assert.equal(action(sales.html, elsewhere.orderId)?.label, 'Post shipment');
  assert.equal(action(sales.html, bolts.orderId)?.label, 'Fulfill');
  for (const order of [draft, closed])
    assert.equal(action(sales.html, order.orderId)?.label, 'View');
  // The supply re-enters current policy for the List's company on every
  // request -- the page and each of the eight tab counts -- query by query.
  const calls = supplyCalls().slice(before);
  assert.deepEqual(
    [...new Set(calls.map((call) => call.permissionId))].sort(),
    [
      id('permission', 'location_read'),
      id('permission', 'posted_stock_balance_read'),
      id('permission', 'reservation_balance_read'),
      id('permission', 'reservation_read'),
    ],
  );
  assert.equal(calls.length, 5 * 9);
  const scopeParameter = id('parameter', 'sales_order_list_legal_entity_scope');
  for (const call of calls) {
    const input = call.decisionInput as {
      queryId: string;
      arguments: Record<string, unknown>;
    };
    assert.deepEqual(
      input.arguments[scopeParameter],
      input.queryId === id('query', 'location_list') ? undefined : [scope],
      input.queryId,
    );
  }

  // Each supply tab lists, counts and exports exactly its set.
  const blocked = await renderSurfaceRuntimeWithData(
    f.view,
    salesUrl({ view: salesView('blocked') }),
    f.gateways,
  );
  assert.match(blocked.html, /data-list-total="1"/u);
  assert.deepEqual(rows(blocked.html), [short.orderId]);
  const reserved = await renderSurfaceRuntimeWithData(
    f.view,
    salesUrl({ view: salesView('reserved') }),
    f.gateways,
  );
  assert.match(reserved.html, /data-list-total="2"/u);
  assert.deepEqual(
    rows(reserved.html),
    [short.orderId, elsewhere.orderId].sort(),
  );
  const exported = await renderSurfaceRuntimeWithData(
    f.view,
    salesUrl({ view: salesView('blocked'), export: 'csv' }),
    f.gateways,
  );
  assert.equal(exported.statusCode, 200);
  const csv = exported
    .download!.body.replace(/^\uFEFF/u, '')
    .trimEnd()
    .split('\r\n');
  assert.equal(
    csv[0],
    'Number,Customer,Salesperson,Order date,Requested,Status,Ordered,Shipped,Open,Short,Currency',
  );
  assert.equal(csv.length, 2);
  assert.match(csv[1]!, /^SO-SHORT,.*,14,0,14,6,CAD$/u);

  // The agent path: the preset carries the supply as the argument it is.
  const preset = (
    f.view.projections.agent.payload as {
      listPresets: Array<{
        surfaceId: string;
        progress?: { supply?: { outputs: Record<string, string> } };
        views: Array<{ viewId: string; supply?: string }>;
      }>;
    }
  ).listPresets.find(
    (value) => value.surfaceId === id('surface', 'sales_order_list'),
  )!;
  assert.deepEqual(preset.progress?.supply?.outputs, {
    covered: id('list_output', 'sales_order_list_covered'),
    short: id('list_output', 'sales_order_list_short'),
  });
  assert.deepEqual(
    preset.views.flatMap((value) =>
      value.supply ? [[value.viewId, value.supply]] : [],
    ),
    [
      [salesView('blocked'), 'short'],
      [salesView('reserved'), 'covered'],
    ],
  );

  // Without stock read the supply is supplementary: the List serves with its
  // progress and "—" for Short, says what it reads without, and the two
  // supply tabs are refused by name and uncounted. Nothing reserved can be
  // stated, so no row promises a shipment.
  for (const [permission, queryId] of [
    ['posted_stock_balance_read', 'workspace_stock'],
    ['location_read', 'location_list'],
    ['reservation_balance_read', 'reservation_balance_list'],
  ] as const) {
    f.deniedReads.add(id('permission', permission));
    const withheld = await renderSurfaceRuntimeWithData(
      f.view,
      salesUrl(),
      f.gateways,
    );
    assert.equal(withheld.statusCode, 200, permission);
    assert.doesNotMatch(withheld.html, /data-diagnostic-code=/u);
    assert.deepEqual(counts(withheld.html), {
      [salesView('all')]: 5,
      [salesView('to_ship')]: 3,
      [salesView('blocked')]: null,
      [salesView('reserved')]: null,
      [salesView('draft')]: 1,
      [salesView('released')]: 3,
      [salesView('closed')]: 1,
      [salesView('cancelled')]: 0,
    });
    assert.equal(cell(withheld.html, short.orderId, 'short'), withheldMark);
    assert.equal(cell(withheld.html, short.orderId, 'open'), '14');
    assert.match(
      withheld.html,
      new RegExp(
        `data-list-supply-withheld="${id('query', queryId)}">Short is withheld by current policy; Blocked by supply and Reserved need it and are unavailable.<`,
        'u',
      ),
    );
    assert.equal(action(withheld.html, short.orderId)?.label, 'Fulfill');
    const refused = await renderSurfaceRuntimeWithData(
      f.view,
      salesUrl({ view: salesView('blocked') }),
      f.gateways,
    );
    assert.match(
      refused.html,
      /data-diagnostic-code="QUERY_PERMISSION_DENIED"/u,
    );
    assert.match(refused.html, /data-list-supply-withheld=/u);
    assert.equal(rows(refused.html).length, 0);
    assert.equal(counts(refused.html)[salesView('all')], 5);
    // The export follows the page: Short is empty, a supply tab refuses.
    const file = await renderSurfaceRuntimeWithData(
      f.view,
      salesUrl({ export: 'csv' }),
      f.gateways,
    );
    assert.equal(file.statusCode, 200);
    assert.ok(
      file
        .download!.body.split('\r\n')
        .some((line) => /^SO-SHORT,.*,14,0,14,,CAD$/u.test(line)),
    );
    const refusedFile = await renderSurfaceRuntimeWithData(
      f.view,
      salesUrl({ view: salesView('reserved'), export: 'csv' }),
      f.gateways,
    );
    assert.equal(refusedFile.statusCode, 422);
    f.deniedReads.clear();
  }
  // The gateway itself still refuses a request carrying the supply, by the
  // supply query's name: the fallback is the web runtime's, per request.
  f.deniedReads.add(id('permission', 'posted_stock_balance_read'));
  const list = readCompiledSurfaceManifest(f.view).surfaces.find(
    (value) => value.surfaceId === id('surface', 'sales_order_list'),
  )!.list!;
  const denied = await f.gateways.queryGateway
    .invoke(f.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: id('query', 'sales_order_list'),
      arguments: declaredListArguments(
        list,
        readDeclaredListState(list, new URL('http://list.local/')),
        {
          mode: 'page',
          now: new Date('2026-10-05T12:00:00.000Z'),
          queryId: id('query', 'sales_order_list'),
          scopeArguments: { [scopeParameter]: scope },
        },
      ),
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  assert.ok(denied instanceof SemanticQueryPolicyDeniedError);
  assert.equal(denied.queryId, id('query', 'workspace_stock'));
  f.deniedReads.clear();
});

test('ORDER-PARITY: a picker over purchase orders enumerates their plain list query, never the read-model clone the List reads', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  f.executor.seed(
    'purchase_order',
    {
      [id('field', 'purchase_order_number')]: 'PO-PICKED',
      [id('field', 'purchase_order_supplier_party_id')]: f.party,
      [id('field', 'purchase_order_currency')]: 'CAD',
      [id('derived_state_field', 'machine.purchase_order_lifecycle')]: id(
        'state',
        'purchase_order_released',
      ),
    },
    scope,
  );
  // Every query the commercial read model is run for, as the gateway runs it.
  const computed: string[] = [];
  const gateways: SurfaceRuntimeGateways = {
    ...f.gateways,
    queryGateway: new SemanticQueryGateway(
      f.policy,
      f.executor,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        'northstar.sales:capability.fulfillment': async ({ result }) => result,
        'northstar.sales:capability.commercial': async ({
          definition,
          result,
        }) => {
          computed.push(definition.queryId);
          return result;
        },
      },
    ),
  };
  const clone = id('query', 'commercial_purchase_order_list');
  const plain = id('query', 'purchase_order_list');
  const reads = (queryId: string) => f.executor.listReads.get(queryId) ?? 0;
  const before = { clone: reads(clone), plain: reads(plain) };

  // The receipt form's order picker: its options are the orders' labels.
  const form = await renderSurfaceRuntimeWithData(
    f.view,
    `/?${new URLSearchParams({ surface: id('surface', 'goods_receipt_form'), [id('parameter', 'goods_receipt_get_legal_entity_scope')]: scope }).toString()}`,
    gateways,
  );
  assert.doesNotMatch(form.html, /RELATION_ENUMERATION_UNAVAILABLE/u);
  assert.match(form.html, /PO-PICKED/u);
  // Through the plain query, never the clone and never its read model.
  assert.equal(reads(clone), before.clone);
  assert.ok(reads(plain) > before.plain);
  // A copy: an assertion on `computed` itself would narrow it to never[].
  assert.deepEqual([...computed], []);

  // Which List stands for purchase orders is unchanged: Purchase orders, whose
  // query is the clone; the picker chooses the query, not the List. Its entry
  // authorization query is preferred over an equivalent plain clone (the
  // Expected receipts worklist's), and a List without a read model keeps its
  // own query.
  const surface = (local: string) =>
    f.surfaces.find((value) => value.surfaceId === id('surface', local))!;
  const listQuery = (local: string) => {
    const bound = readCompiledSurfaceDataBinding(f.view, surface(local)).query;
    assert.notEqual(bound.queryType, 'aggregate');
    return bound as Exclude<typeof bound, { queryType: 'aggregate' }>;
  };
  assert.equal(listQuery('purchase_order_list').queryId, clone);
  assert.equal(
    pickerEnumerationQuery(
      f.view,
      surface('purchase_order_list'),
      listQuery('purchase_order_list'),
    ).queryId,
    plain,
  );
  for (const local of ['expected_receipt_list', 'sales_order_list'])
    assert.equal(
      pickerEnumerationQuery(f.view, surface(local), listQuery(local)).queryId,
      id('query', local),
    );

  // The List itself still reads its orders with their totals.
  await renderSurfaceRuntimeWithData(
    f.view,
    `/?${new URLSearchParams({ surface: id('surface', 'purchase_order_list'), [id('parameter', 'commercial_purchase_order_list_legal_entity_scope')]: scope }).toString()}`,
    gateways,
  );
  assert.ok(reads(clone) > before.clone);
  assert.ok(computed.includes(clone));
});

// ORDER-PARITY increment B: record pages that show their exceptions and their
// progress, link to the records they name, and work through several rows.
const regexpText = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** A submitted value of a named control, as the page renders it. */
function controlValue(html: string, name: string): string | undefined {
  return new RegExp(`name="${regexpText(name)}" value="([^"]*)"`, 'u').exec(
    html,
  )?.[1];
}
/** Every row a multi-row Task shows, in order. */
function taskRowIds(html: string): string[] {
  return [...html.matchAll(/data-task-row="([^"]+)"/gu)].map(
    (match) => match[1]!,
  );
}
/** A released purchase order and its lines, stored as the providers do. */
function seedPurchaseOrder(
  f: OrderEntryWitness,
  lines: readonly string[],
  state = 'released',
) {
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const order = f.executor.seed(
    'purchase_order',
    {
      [`${ns}:field.purchase_order_number`]: 'PO-000042',
      [`${ns}:field.purchase_order_supplier_party_id`]: f.party,
      [`${ns}:field.purchase_order_currency`]: 'CAD',
      [`${ns}:field.purchase_order_order_date`]: '2026-09-26T09:30:00Z',
      ...Object.fromEntries(
        [
          'expected_date',
          'notes',
          'receiving_location_id',
          'payment_terms',
          'tax_code_id',
          'freight_amount',
          'freight_tax_code_id',
          'freight_tax_rate_percent',
          'other_fee_amount',
          'other_fee_tax_code_id',
          'other_fee_tax_rate_percent',
        ].map((name) => [`${ns}:field.purchase_order_${name}`, null]),
      ),
      [`${ns}:derived_state_field.machine.purchase_order_lifecycle`]: `${ns}:state.purchase_order_${state}`,
    },
    scope,
  );
  const lineIds = lines.map((ordered, index) =>
    f.executor.seed(
      'purchase_order_line',
      {
        [`${ns}:field.purchase_order_line_line_number`]: String(index + 1),
        [`${ns}:field.purchase_order_line_item_id`]: f.item,
        [`${ns}:field.purchase_order_line_ordered_quantity`]: ordered,
        [`${ns}:field.purchase_order_line_unit_price`]: '2.4',
        [`${ns}:field.purchase_order_line_discount_percent`]: null,
        [`${ns}:field.purchase_order_line_tax_code_id`]: null,
        [`${ns}:field.purchase_order_line_tax_rate_percent`]: null,
        [`${ns}:relation.purchase_order_line_order`]: order,
      },
      scope,
    ),
  );
  return { order, lines: lineIds };
}
/** A gateway whose read models state the figures a test gives them. */
function statingGateways(
  f: OrderEntryWitness,
  stated: {
    readonly commercial?: (
      key: string,
      record: SemanticRecordDto,
    ) => ImmutableJsonValue;
    readonly fulfillment?: (
      key: string,
      record: SemanticRecordDto,
    ) => ImmutableJsonValue;
    readonly receiving?: (
      key: string,
      record: SemanticRecordDto,
    ) => ImmutableJsonValue;
  },
  executor: SemanticQueryExecutor = f.executor,
): SurfaceRuntimeGateways {
  const stating =
    (
      state:
        | ((key: string, record: SemanticRecordDto) => ImmutableJsonValue)
        | undefined,
    ) =>
    async ({
      definition,
      result,
    }: {
      definition: { readModel?: { resultFields: Record<string, string> } };
      result: SemanticQueryResultEnvelope;
    }) => ({
      ...result,
      records: result.records.map((record) => ({
        ...record,
        values: {
          ...record.values,
          ...Object.fromEntries(
            Object.entries(definition.readModel!.resultFields).map(
              ([key, fieldId]) => [fieldId, state ? state(key, record) : null],
            ),
          ),
        },
      })),
    });
  return {
    ...f.gateways,
    queryGateway: new SemanticQueryGateway(
      f.policy,
      executor,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        'northstar.sales:capability.fulfillment': stated.fulfillment
          ? stating(stated.fulfillment)
          : async ({ result }) => result,
        'northstar.sales:capability.commercial': stating(stated.commercial),
        'northstar.purchasing:capability.receiving': stating(stated.receiving),
        'northstar.inventory:capability.valuation': stating(undefined),
      },
    ),
  };
}

/**
 * The receiving routes as this witness keeps them: a receipt takes its number
 * when it is created, as the server assigns one, and the receiving capability
 * posts it -- marked posted under its next revision, a replayed key answered
 * with its first answer. Every call is recorded with the witness's own.
 */
function receivingGateways(
  f: OrderEntryWitness,
  gateways: SurfaceRuntimeGateways,
): SurfaceRuntimeGateways {
  const ns = f.ns;
  let numbered = 0;
  const executor: SemanticOperationExecutor = {
    recordNonAccepted: () => f.executor.recordNonAccepted(),
    async execute(request) {
      const result = await f.executor.execute(request);
      const created = result.readBack;
      if (
        request.definition.operationId ===
          `${ns}:operation.goods_receipt_create` &&
        created
      ) {
        const stored = f.executor.rows.get(created.recordId)!;
        f.executor.rows.set(created.recordId, {
          ...stored,
          values: {
            ...stored.values,
            [`${ns}:field.goods_receipt_number`]: `RCV-${String(++numbered).padStart(6, '0')}`,
          },
        });
      }
      return result;
    },
  };
  const receiving: RegisteredCapabilityOperationExecutor = {
    capabilityId: 'northstar.purchasing:capability.receiving',
    async prepareAuthorization(request) {
      return {
        decisionInput: request.input,
        legalEntityReadScopeIds: [f.scopes[0]!],
        readBackArguments: {
          recordId: asRecord(request.input).recordId as string,
          includeArchived: false,
        },
      };
    },
    async execute(request) {
      f.executor.calls.push(request as never);
      if (f.executor.failAt === f.executor.calls.length)
        throw new Error('Isolated post failure');
      const cached = f.executor.receipts.get(request.idempotencyKey);
      if (cached) return cached;
      const draft = f.executor.rows.get(
        String(asRecord(request.input).recordId),
      )!;
      const posted: SemanticRecordDto = {
        ...draft,
        revision: draft.revision + 1,
        values: {
          ...draft.values,
          [`${ns}:field.goods_receipt_state`]: `${ns}:option.goods_receipt_state_posted`,
        },
      };
      f.executor.rows.set(posted.recordId, posted);
      const result: SemanticOperationResultEnvelope = {
        kind: 'semanticOperationResult',
        schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
        operationId: request.definition.operationId,
        outcome: 'succeeded',
        readBack: posted,
        unsupportedReason: null,
        trust: {
          changeDocumentId: randomUUID(),
          domainEventId: randomUUID(),
          invocationId: randomUUID(),
          outboxId: randomUUID(),
        },
      };
      f.executor.receipts.set(request.idempotencyKey, result);
      return result;
    },
  };
  return {
    ...gateways,
    operationGateway: new SemanticOperationGateway(
      f.policy,
      executor,
      gateways.operationMediation,
      undefined,
      [receiving],
    ),
  };
}

test('ORDER-PARITY: an invoice states its sales order through its own get, labels it under current policy on every request and opens it', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const order = f.executor.seed(
    'sales_order',
    {
      [id('field', 'sales_order_number')]: 'SO-000321',
      [id('field', 'sales_order_customer_party_id')]: f.party,
      [id('field', 'sales_order_order_date')]: '2026-09-20T12:00:00.000Z',
      [id('field', 'sales_order_currency')]: 'CAD',
      [id('derived_state_field', 'machine.sales_order_lifecycle')]: id(
        'state',
        'sales_order_released',
      ),
    },
    scope,
  );
  const invoice = f.executor.seed(
    'customer_invoice',
    {
      [id('field', 'customer_invoice_number')]: 'INV-000007',
      [id('field', 'customer_invoice_state')]: id(
        'option',
        'customer_invoice_state_open',
      ),
      [id('field', 'customer_invoice_invoice_date')]:
        '2026-09-21T12:00:00.000Z',
      [id('field', 'customer_invoice_due_date')]: '2026-10-21T12:00:00.000Z',
      [id('field', 'customer_invoice_customer_party_id')]: f.party,
      [id('field', 'customer_invoice_currency')]: 'CAD',
      [id('field', 'customer_invoice_payment_terms')]: null,
      ...Object.fromEntries(
        [
          'subtotal',
          'charges',
          'tax',
          'total',
          'paid_amount',
          'credited_amount',
          'balance',
        ].map((name) => [id('field', `customer_invoice_${name}`), '0']),
      ),
      [id('relation', 'customer_invoice_order')]: order,
    },
    scope,
  );
  // Like the PostgreSQL provider: a stored relation is no value of a get, and
  // each relation a get is asked to state is resolved by the provider's own
  // planner against the governed compiled storage.
  const storage = await governedStorageTarget();
  const gets: Record<string, unknown>[] = [];
  const executor: SemanticQueryExecutor = {
    async execute(request) {
      const result = await f.executor.execute(request);
      if (request.definition.queryType !== 'get') return result;
      const args = asRecord(request.arguments);
      gets.push({ queryId: request.definition.queryId, ...args });
      const targets = relationTargetPlans(
        storage,
        storage.entities.find(
          (value) => value.entityId === request.definition.sourceEntityId,
        )!,
        args.relationTargets as ImmutableJsonValue | undefined,
      );
      return {
        ...result,
        records: result.records.map((record) => ({
          ...record,
          values: Object.fromEntries(
            Object.entries(record.values).filter(
              ([key]) => !key.includes(':relation.'),
            ),
          ),
          ...(targets.length
            ? {
                relationLabels: Object.fromEntries(
                  targets.map((target) => [
                    target.relationId,
                    {
                      label: null,
                      recordId:
                        (record.values[target.relationId] as
                          string | undefined) ?? null,
                    },
                  ]),
                ),
              }
            : {}),
        })),
      };
    },
  };
  const gateways = statingGateways(f, {}, executor);
  const path = `/?${new URLSearchParams({
    surface: id('surface', 'customer_invoice_detail'),
    record: invoice,
    [id('parameter', 'customer_invoice_get_legal_entity_scope')]: scope,
  }).toString()}`;
  const fact = (html: string) =>
    /<div><dt>Sales order<\/dt><dd>([^<]*)<\/dd><\/div>/u.exec(html)?.[1];

  const page = await renderSurfaceRuntimeWithData(f.view, path, gateways);
  assert.equal(page.statusCode, 200);
  assert.equal(fact(page.html), 'SO-000321');
  // The invoice's compiled display get states its order, the relation the page names.
  const invoiceQuery = readCompiledSurfaceManifest(f.view).surfaces.find(
    (surface) => surface.surfaceId === id('surface', 'customer_invoice_detail'),
  )!.dataSourceQueryId;
  assert.ok(invoiceQuery);
  assert.deepEqual(
    gets.find((read) => read.queryId === invoiceQuery)?.relationTargets,
    [id('relation', 'customer_invoice_order')],
  );
  // Open sales order: the order's own page in this company, with no way
  // "back" to a page that is not the order's.
  const href = /<a class="button" href="([^"]+)">Open sales order<\/a>/u
    .exec(page.html)?.[1]
    ?.replaceAll('&amp;', '&');
  assert.ok(href);
  const target = new URL(href, 'http://fixture.local');
  assert.equal(
    target.searchParams.get('surface'),
    id('surface', 'sales_order_detail'),
  );
  assert.equal(target.searchParams.get('record'), order);
  assert.equal(
    target.searchParams.get(
      id('parameter', 'commercial_order_get_legal_entity_scope'),
    ),
    scope,
  );
  assert.equal(target.searchParams.get('returnTo'), null);
  // Current policy decides the label on every request: withheld, the fact
  // reads "—" and the invoice still serves; restored, it reads again.
  f.deniedReads.add(id('permission', 'sales_order_read'));
  const withheld = await renderSurfaceRuntimeWithData(f.view, path, gateways);
  assert.equal(withheld.statusCode, 200);
  assert.equal(fact(withheld.html), '—');
  assert.match(withheld.html, /INV-000007/u);
  f.deniedReads.delete(id('permission', 'sales_order_read'));
  assert.equal(
    fact((await renderSurfaceRuntimeWithData(f.view, path, gateways)).html),
    'SO-000321',
  );

  // The gateway rules the argument's shape; the provider its meaning.
  const read = (queryId: string, args: Record<string, ImmutableJsonValue>) =>
    gateways.queryGateway.invoke(f.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: id('query', queryId),
      arguments: {
        ...args,
        [id('parameter', `${queryId}_legal_entity_scope`)]: scope,
      },
    });
  for (const relationTargets of [
    [],
    'customer_invoice_order',
    [7],
    ['not a canonical id'],
    Array.from({ length: 5 }, (_, index) => id('relation', `r${index}`)),
    [
      id('relation', 'customer_invoice_order'),
      id('relation', 'customer_invoice_order'),
    ],
  ])
    await assert.rejects(
      read('customer_invoice_get', {
        recordId: invoice,
        includeArchived: false,
        relationTargets: relationTargets as ImmutableJsonValue,
      }),
      MalformedSemanticQueryRequestError,
      JSON.stringify(relationTargets),
    );
  await assert.rejects(
    read('customer_invoice_list', {
      includeArchived: false,
      relationTargets: [id('relation', 'customer_invoice_order')],
    }),
    /relation targets belong only to a registered get query/u,
  );
  // A relation the invoice does not own, or none at all, is refused by name.
  for (const relation of [
    id('relation', 'sales_order_line_order'),
    id('relation', 'missing'),
  ])
    await assert.rejects(
      read('customer_invoice_get', {
        recordId: invoice,
        includeArchived: false,
        relationTargets: [relation],
      }),
      (error: unknown) =>
        error instanceof ModuleRuntimeInterpreterError &&
        error.code === 'MODULE_RELATION_TARGET_INVALID',
      relation,
    );
});

test('ORDER-PARITY: a truck receipt receives several lines in one receipt, filled from what is open, one request key per run', async () => {
  const f = await orderEntryWitness(true);
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const location = f.executor.seed('location', {
    [id('field', 'location_name')]: 'Receiving dock',
  });
  const {
    order,
    lines: [lineA, lineB, lineC, lineD],
  } = seedPurchaseOrder(f, ['5', '2', '4', '3']);
  // Open to receive, as the commercial read model states it: nothing left on
  // B, and C's received read withheld.
  const open = new Map<string, string | null>([
    [lineA!, '5'],
    [lineB!, '0'],
    [lineC!, null],
    [lineD!, '3'],
  ]);
  const gateways = receivingGateways(
    f,
    statingGateways(f, {
      commercial: (key, record) =>
        key === 'open_to_receive' ? (open.get(record.recordId) ?? null) : null,
    }),
  );
  const action = id('action', 'receive_lines_known');
  const path = `/?${new URLSearchParams({
    surface: id('surface', 'purchase_order_detail'),
    record: order,
    [id('parameter', 'commercial_purchase_order_get_legal_entity_scope')]:
      scope,
  }).toString()}`;
  const page = await renderSurfaceRuntimeWithData(f.view, path, gateways);
  assert.equal(page.statusCode, 200);
  // Offered on the record, and as the order's next step.
  assert.match(
    page.html,
    new RegExp(`name="compositionAction" value="${regexpText(action)}"`, 'u'),
  );
  assert.match(
    page.html,
    new RegExp(`data-next-action="${regexpText(action)}"`, 'u'),
  );
  assert.match(
    page.html,
    /aria-label="Next action: Receive lines with actual cost"/u,
  );

  const start = await submitSurfaceRuntimeIntent(
    f.view,
    path,
    { compositionAction: action },
    gateways,
  );
  assert.equal(start.statusCode, 200);
  // Nothing else is started while the Task is open.
  assert.doesNotMatch(start.html, /data-next-action=/u);
  const token = hiddenValue(start.html, 'taskToken');
  // Every line with something to arrive, and the one whose figure is withheld.
  assert.deepEqual(taskRowIds(start.html), [lineA, lineC, lineD]);
  const quantity = (line: string) =>
    `${id('input', 'receive_lines_quantity')}@${line}`;
  const cost = (line: string) => `${id('input', 'receive_lines_cost')}@${line}`;
  for (const line of [lineA!, lineC!, lineD!]) {
    assert.equal(controlValue(start.html, quantity(line)), '');
    assert.equal(controlValue(start.html, cost(line)), '');
  }
  // Each row's inputs are named with the line they belong to.
  assert.match(
    start.html,
    /aria-label="Quantity to receive, Readable product, Line 1"/u,
  );
  assert.match(
    start.html,
    /<button type="submit" class="secondary-action" name="taskStage" value="fill" formnovalidate>Fill open quantities<\/button>/u,
  );
  // Enter reviews the Task; it never fills.
  assert.ok(
    start.html.indexOf('data-task-default') <
      start.html.indexOf('value="fill"'),
  );
  const post = (values: Record<string, string>) =>
    submitSurfaceRuntimeIntent(
      f.view,
      path,
      { taskToken: token, compositionAction: action, ...values },
      gateways,
    );
  const header = {
    [id('input', 'receive_lines_location')]: location,
    [id('input', 'receive_lines_currency')]: 'CAD',
    [id('input', 'receive_lines_packing_slip')]: 'PS-77',
    [id('input', 'receive_lines_notes')]: '',
  };

  // Fill: each row from what is still open; the withheld line stays empty
  // and what was entered elsewhere is kept.
  const filled = await post({ taskStage: 'fill', ...header });
  assert.equal(controlValue(filled.html, quantity(lineA!)), '5');
  assert.equal(controlValue(filled.html, quantity(lineD!)), '3');
  assert.equal(controlValue(filled.html, quantity(lineC!)), '');
  assert.equal(
    controlValue(filled.html, id('input', 'receive_lines_packing_slip')),
    'PS-77',
  );
  // Nothing entered on any line: refused beside the rows, nothing written.
  const empty = await post({ taskStage: 'prepare', ...header });
  assert.match(empty.html, /COMPOSITION_INPUT_INVALID/u);
  assert.match(empty.html, /Enter at least one line\./u);
  // A line given a quantity needs its cost; a bad quantity is named on its line.
  const invalid = await post({
    taskStage: 'prepare',
    ...header,
    [quantity(lineA!)]: '5',
    [quantity(lineD!)]: '-1',
    [cost(lineD!)]: '2',
  });
  assert.match(
    invalid.html,
    new RegExp(`id="${regexpText(`${cost(lineA!)}-error`)}">Required\\.<`, 'u'),
  );
  assert.match(
    invalid.html,
    new RegExp(
      `id="${regexpText(`${quantity(lineD!)}-error`)}">Enter a positive exact quantity\\.<`,
      'u',
    ),
  );
  assert.equal(f.executor.calls.length, 0);

  // Two lines of the truck; the withheld line is left empty and skipped.
  const review = await post({
    taskStage: 'prepare',
    ...header,
    [quantity(lineA!)]: '5',
    [cost(lineA!)]: '2.50',
    [quantity(lineD!)]: '2',
    [cost(lineD!)]: '1.2',
  });
  assert.match(review.html, /data-task-phase="review"/u);
  assert.deepEqual(taskRowIds(review.html), [lineA, lineD]);
  assert.equal(f.executor.calls.length, 0);
  // The second line's run fails: the reviewed runs are retried as they were.
  f.executor.failAt = 3;
  const failed = await post({
    taskStage: 'confirm',
    preparedId: hiddenValue(review.html, 'preparedId'),
  });
  assert.match(failed.html, /COMPOSITION_UNCERTAIN/u);
  f.executor.failAt = 0;
  const done = await post({ taskStage: 'retry' });
  assert.match(done.html, /Receive lines with actual cost: done/u);
  const calls = f.executor.calls;
  assert.deepEqual(
    calls.map((call) => call.definition.operationId),
    [
      id('operation', 'goods_receipt_create'),
      id('operation', 'goods_receipt_line_create'),
      id('operation', 'goods_receipt_line_create'),
      id('operation', 'goods_receipt_line_create'),
      id('operation', 'goods_receipt_post'),
    ],
  );
  // One key per run, and the retried run kept its key and its exact input.
  assert.equal(calls[3]!.idempotencyKey, calls[2]!.idempotencyKey);
  assert.deepEqual(calls[3]!.input, calls[2]!.input);
  assert.equal(
    new Set(calls.map((call) => call.idempotencyKey)).size,
    calls.length - 1,
  );
  const receipt = asRecord(calls[0]!.input);
  const receiptId = String(receipt.recordId);
  assert.deepEqual(asRecord(receipt.values), {
    [id('field', 'goods_receipt_state')]: id(
      'option',
      'goods_receipt_state_draft',
    ),
    [id('field', 'goods_receipt_kind')]: id(
      'option',
      'goods_receipt_kind_initial',
    ),
    [id('field', 'goods_receipt_effective_at')]: asRecord(receipt.values)[
      id('field', 'goods_receipt_effective_at')
    ],
    [id('field', 'goods_receipt_location_id')]: location,
    [id('field', 'goods_receipt_reason_code')]: 'RECEIVE',
    [id('field', 'goods_receipt_reason_narrative')]:
      'Receive from purchase order',
    [id('field', 'goods_receipt_packing_slip')]: 'PS-77',
    [id('field', 'goods_receipt_notes')]: null,
  });
  assert.deepEqual(asRecord(receipt.relations), {
    [id('relation', 'goods_receipt_order')]: order,
  });
  const lineRuns = [calls[1]!, calls[3]!].map((call) => asRecord(call.input));
  assert.notEqual(lineRuns[0]!.recordId, lineRuns[1]!.recordId);
  assert.deepEqual(
    lineRuns.map((run) => {
      const values = asRecord(run.values);
      return [
        values[id('field', 'goods_receipt_line_line_number')],
        values[id('field', 'goods_receipt_line_quantity')],
        values[id('field', 'goods_receipt_line_unit_id')],
        values[id('field', 'goods_receipt_line_unit_cost')],
        values[id('field', 'goods_receipt_line_currency')],
        values[id('field', 'goods_receipt_line_cost_status')],
        asRecord(run.relations)[
          id('relation', 'goods_receipt_line_order_line')
        ],
        asRecord(run.relations)[id('relation', 'goods_receipt_line_receipt')],
      ];
    }),
    [
      [
        '1',
        '5',
        'EA',
        '2.5',
        'CAD',
        id('option', 'goods_receipt_line_cost_status_known'),
        lineA,
        receiptId,
      ],
      [
        '4',
        '2',
        'EA',
        '1.2',
        'CAD',
        id('option', 'goods_receipt_line_cost_status_known'),
        lineD,
        receiptId,
      ],
    ],
  );
  assert.deepEqual(asRecord(calls[4]!.input), {
    recordId: receiptId,
    expectedRevision: 1,
  });
  // A line with nothing open anywhere offers no truck receipt.
  const none = statingGateways(f, {
    commercial: (key) => (key === 'open_to_receive' ? '0' : null),
  });
  const closed = await renderSurfaceRuntimeWithData(f.view, path, none);
  assert.doesNotMatch(
    closed.html,
    new RegExp(`value="${regexpText(action)}"`, 'u'),
  );
});

test('ORDER-PARITY: reversing a receipt reverses each line that still adds to stock, at exactly that, through the receiving routes', async () => {
  const f = await orderEntryWitness(true);
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const location = f.executor.seed('location', {
    [id('field', 'location_name')]: 'Receiving dock',
  });
  const {
    order,
    lines: [lineA, lineB],
  } = seedPurchaseOrder(f, ['5', '2']);
  const receipt = (state: 'draft' | 'posted') =>
    f.executor.seed(
      'goods_receipt',
      {
        [id('field', 'goods_receipt_number')]: `RCV-${state}`,
        [id('field', 'goods_receipt_state')]: id(
          'option',
          `goods_receipt_state_${state}`,
        ),
        [id('field', 'goods_receipt_kind')]: id(
          'option',
          'goods_receipt_kind_initial',
        ),
        [id('field', 'goods_receipt_effective_at')]: '2026-09-27T10:00:00Z',
        [id('field', 'goods_receipt_location_id')]: location,
        [id('field', 'goods_receipt_packing_slip')]: null,
        [id('relation', 'goods_receipt_order')]: order,
      },
      scope,
    );
  const posted = receipt('posted');
  const receiptLine = (
    parent: string,
    number: string,
    orderLine: string,
    quantity: string,
  ) =>
    f.executor.seed(
      'goods_receipt_line',
      {
        [id('field', 'goods_receipt_line_line_number')]: number,
        [id('field', 'goods_receipt_line_item_id')]: f.item,
        [id('field', 'goods_receipt_line_quantity')]: quantity,
        [id('field', 'goods_receipt_line_unit_id')]: 'EA',
        [id('field', 'goods_receipt_line_cost_status')]: id(
          'option',
          'goods_receipt_line_cost_status_known',
        ),
        // As the PostgreSQL provider reads a stored decimal back: at its
        // column's scale, which is not an input the provider admits.
        [id('field', 'goods_receipt_line_unit_cost')]: '2.500000000000000000',
        [id('field', 'goods_receipt_line_currency')]: 'CAD',
        [id('field', 'goods_receipt_line_reversal_of_movement_id')]: null,
        [id('relation', 'goods_receipt_line_receipt')]: parent,
        [id('relation', 'goods_receipt_line_order_line')]: orderLine,
      },
      scope,
    );
  const first = receiptLine(posted, '1', lineA!, '4');
  // Already compensated in full: nothing of it is offered.
  receiptLine(posted, '2', lineB!, '2');
  // What each line still adds to stock, its movement and order line, as the
  // receiving read model states them: the second is already compensated.
  const movement = '0b000000-0000-4000-8000-00000000000a';
  let movementsStated = true;
  const receiving = (key: string, record: SemanticRecordDto) => {
    const line = record.recordId === first;
    if (key === 'order_line') return line ? lineA! : lineB!;
    if (!movementsStated) return null;
    if (key === 'movement') return line ? movement : randomUUID();
    if (key === 'reversible') return line ? '4' : '0';
    return line ? '-4' : '0';
  };
  const gateways = receivingGateways(
    f,
    statingGateways(f, {
      commercial: (key) => (key === 'open_to_receive' ? '1' : null),
      receiving,
    }),
  );
  const receipts = id('dataset', 'purchasing_receipts');
  const action = id('action', 'reverse_receipt');
  const pathFor = (selected: string) =>
    `/?${new URLSearchParams({
      surface: id('surface', 'purchase_order_detail'),
      record: order,
      [id('parameter', 'commercial_purchase_order_get_legal_entity_scope')]:
        scope,
      dataset: receipts,
      selected,
      [`select:${receipts}`]: selected,
    }).toString()}`;
  const path = pathFor(posted);
  const page = await renderSurfaceRuntimeWithData(f.view, path, gateways);
  assert.equal(page.statusCode, 200);
  // The selected receipt shows its lines and offers its reversal.
  assert.match(
    page.html,
    /data-composition-dataset="northstar\.app:dataset\.purchasing_receipt_lines" data-resolution="ready"/u,
  );
  assert.match(
    page.html,
    new RegExp(`name="compositionAction" value="${regexpText(action)}"`, 'u'),
  );
  const start = await submitSurfaceRuntimeIntent(
    f.view,
    path,
    { compositionAction: action },
    gateways,
  );
  const token = hiddenValue(start.html, 'taskToken');
  assert.deepEqual(taskRowIds(start.html), [first]);
  const post = (values: Record<string, string>) =>
    submitSurfaceRuntimeIntent(
      f.view,
      path,
      { taskToken: token, compositionAction: action, ...values },
      gateways,
    );
  const review = await post({
    taskStage: 'prepare',
    [id('input', 'reverse_receipt_reason')]: 'Wrong item delivered',
  });
  assert.deepEqual(taskRowIds(review.html), [first]);
  const done = await post({
    taskStage: 'confirm',
    preparedId: hiddenValue(review.html, 'preparedId'),
  });
  assert.match(done.html, /Reverse receipt: done/u);
  const calls = f.executor.calls;
  assert.deepEqual(
    calls.map((call) => call.definition.operationId),
    [
      id('operation', 'goods_receipt_create'),
      id('operation', 'goods_receipt_line_create'),
      id('operation', 'goods_receipt_post'),
    ],
  );
  const header = asRecord(calls[0]!.input);
  const values = asRecord(header.values);
  assert.deepEqual(
    [
      values[id('field', 'goods_receipt_kind')],
      values[id('field', 'goods_receipt_state')],
      values[id('field', 'goods_receipt_location_id')],
      values[id('field', 'goods_receipt_reason_code')],
      values[id('field', 'goods_receipt_reason_narrative')],
    ],
    [
      id('option', 'goods_receipt_kind_reversal'),
      id('option', 'goods_receipt_state_draft'),
      location,
      'REVERSE',
      'Wrong item delivered',
    ],
  );
  assert.deepEqual(asRecord(header.relations), {
    [id('relation', 'goods_receipt_order')]: order,
    [id('relation', 'goods_receipt_supersedes')]: posted,
  });
  const line = asRecord(calls[1]!.input);
  const lineValues = asRecord(line.values);
  assert.deepEqual(
    [
      lineValues[id('field', 'goods_receipt_line_line_number')],
      lineValues[id('field', 'goods_receipt_line_quantity')],
      lineValues[id('field', 'goods_receipt_line_reversal_of_movement_id')],
      lineValues[id('field', 'goods_receipt_line_cost_status')],
      lineValues[id('field', 'goods_receipt_line_unit_cost')],
      lineValues[id('field', 'goods_receipt_line_currency')],
      lineValues[id('field', 'goods_receipt_line_unit_id')],
    ],
    [
      '1',
      '-4',
      movement,
      id('option', 'goods_receipt_line_cost_status_known'),
      '2.5',
      'CAD',
      'EA',
    ],
  );
  assert.deepEqual(asRecord(line.relations), {
    [id('relation', 'goods_receipt_line_receipt')]: header.recordId,
    [id('relation', 'goods_receipt_line_order_line')]: lineA,
  });
  assert.deepEqual(asRecord(calls[2]!.input), {
    recordId: header.recordId,
    expectedRevision: 1,
  });

  // Without the movement read nothing is stated, so nothing is offered, and
  // a page opened before cannot start it.
  movementsStated = false;
  const withheld = await renderSurfaceRuntimeWithData(f.view, path, gateways);
  assert.doesNotMatch(
    withheld.html,
    new RegExp(`value="${regexpText(action)}"`, 'u'),
  );
  const stale = await submitSurfaceRuntimeIntent(
    f.view,
    path,
    { compositionAction: action },
    gateways,
  );
  assert.match(stale.html, /COMPOSITION_TASK_UNAVAILABLE/u);
  // A draft receipt has nothing to reverse.
  movementsStated = true;
  const draft = receipt('draft');
  receiptLine(draft, '1', lineA!, '1');
  const drafted = await renderSurfaceRuntimeWithData(
    f.view,
    pathFor(draft),
    gateways,
  );
  assert.doesNotMatch(
    drafted.html,
    new RegExp(`value="${regexpText(action)}"`, 'u'),
  );
  assert.equal(f.executor.calls.length, 3);
});

test('ORDER-PARITY: an order page names the lines it is short and shows where it stands, with the first next step offered now', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const seedOrder = (state: string) => {
    const order = f.executor.seed(
      'sales_order',
      {
        [id('field', 'sales_order_number')]: `SO-${state}`,
        [id('field', 'sales_order_customer_party_id')]: f.party,
        [id('field', 'sales_order_order_date')]: '2026-09-20T12:00:00.000Z',
        [id('field', 'sales_order_requested_date')]: '2026-10-11T00:00:00.000Z',
        [id('field', 'sales_order_currency')]: 'CAD',
        ...Object.fromEntries(
          [
            'notes',
            'salesperson_party_id',
            'payment_terms',
            'ship_to_name',
            'ship_to_region',
            'tax_code_id',
            'freight_amount',
            'freight_tax_code_id',
            'other_fee_amount',
            'other_fee_tax_code_id',
          ].map((name) => [id('field', `sales_order_${name}`), null]),
        ),
        // A complete ship-to, which Confirm requires (ruling E).
        [id('field', 'sales_order_ship_to_street')]: '100 Industrial Way',
        [id('field', 'sales_order_ship_to_city')]: 'Calgary',
        [id('field', 'sales_order_ship_to_postal_code')]: 'T2P 0A1',
        [id('field', 'sales_order_ship_to_country')]: 'Canada',
        [id('derived_state_field', 'machine.sales_order_lifecycle')]: id(
          'state',
          `sales_order_${state}`,
        ),
      },
      scope,
    );
    const lines = ['5', '3'].map((ordered, index) =>
      f.executor.seed(
        'sales_order_line',
        {
          [id('field', 'sales_order_line_line_number')]: String(index + 1),
          [id('field', 'sales_order_line_item_id')]: f.item,
          [id('field', 'sales_order_line_ordered_quantity')]: ordered,
          [id('field', 'sales_order_line_unit_id')]: 'EA',
          ...Object.fromEntries(
            ['unit_price', 'list_price', 'discount_percent', 'tax_code_id'].map(
              (name) => [id('field', `sales_order_line_${name}`), null],
            ),
          ),
          [id('relation', 'sales_order_line_order')]: order,
        },
        scope,
      ),
    );
    return { order, lines };
  };
  const path = (order: string) =>
    `/?${new URLSearchParams({
      surface: id('surface', 'sales_order_detail'),
      record: order,
      [id('parameter', 'commercial_order_get_legal_entity_scope')]: scope,
    }).toString()}`;
  const draft = seedOrder('draft');
  let short = new Map<string, string | null>([
    [draft.lines[0]!, '2'],
    [draft.lines[1]!, '0'],
  ]);
  let toInvoice: string | null = null;
  const gateways = statingGateways(f, {
    fulfillment: (key, record) =>
      key === 'short'
        ? (short.get(record.recordId) ?? null)
        : key === 'available_now'
          ? '3'
          : key === 'shipped' || key === 'coverage'
            ? '0'
            : String(
                record.values[id('field', 'sales_order_line_ordered_quantity')],
              ),
    commercial: (key) =>
      key === 'order_to_invoice'
        ? toInvoice
        : key === 'order_total'
          ? toInvoice && '25'
          : null,
  });
  const alert = (html: string) =>
    /<section class="composition-alert"[^>]*>([\s\S]*?)<\/section>/u.exec(
      html,
    )?.[1];
  const states = (html: string) =>
    [...html.matchAll(/<li data-step-state="([a-z]+)"/gu)].map(
      (match) => match[1],
    );

  const drafted = await renderSurfaceRuntimeWithData(
    f.view,
    path(draft.order),
    gateways,
  );
  assert.equal(drafted.statusCode, 200);
  // The line short of free stock is named; the covered one is not.
  const banner = alert(drafted.html);
  assert.ok(banner);
  assert.match(
    banner,
    /<h2 id="composition-alert-0">Fulfillment exception<\/h2>/u,
  );
  assert.deepEqual(
    [...banner.matchAll(/<li data-record-id="([^"]+)">/gu)].map(
      (match) => match[1],
    ),
    [draft.lines[0]],
  );
  assert.match(
    banner,
    /<strong>Readable product<\/strong> <span>Short 2<\/span>/u,
  );
  // Never a live region, so it never competes with an outcome's status.
  assert.doesNotMatch(banner, /role=/u);
  assert.deepEqual(states(drafted.html), [
    'current',
    'upcoming',
    'upcoming',
    'upcoming',
  ]);
  // Next: the order's own Confirm, as its command bar offers it, under its
  // own name.
  assert.match(
    drafted.html,
    new RegExp(
      `data-next-operation="${regexpText(id('operation', 'sales_order_release'))}"`,
      'u',
    ),
  );
  assert.match(drafted.html, /aria-label="Next action: [^"]+"/u);
  // Nothing short, or nothing stated: no banner.
  for (const stated of ['0', null]) {
    short = new Map(draft.lines.map((line) => [line, stated]));
    assert.equal(
      alert(
        (
          await renderSurfaceRuntimeWithData(
            f.view,
            path(draft.order),
            gateways,
          )
        ).html,
      ),
      undefined,
    );
  }
  // Confirmed with shipped quantity to invoice: invoicing needs attention,
  // and invoicing it is the next step.
  const released = seedOrder('released');
  toInvoice = '2';
  const confirmed = await renderSurfaceRuntimeWithData(
    f.view,
    path(released.order),
    gateways,
  );
  assert.deepEqual(states(confirmed.html), [
    'complete',
    'current',
    'attention',
    'upcoming',
  ]);
  assert.match(
    confirmed.html,
    new RegExp(
      `data-next-action="${regexpText(id('action', 'invoice_shipped'))}"`,
      'u',
    ),
  );
  assert.match(
    confirmed.html,
    /aria-label="Next action: Invoice shipped quantities"/u,
  );
  // A cancelled order stopped at every step, with nothing next -- even with
  // figures that would otherwise offer a step.
  const cancelled = seedOrder('cancelled');
  const stopped = await renderSurfaceRuntimeWithData(
    f.view,
    path(cancelled.order),
    gateways,
  );
  assert.deepEqual(states(stopped.html), [
    'stopped',
    'stopped',
    'stopped',
    'stopped',
  ]);
  assert.doesNotMatch(stopped.html, /data-next-(?:action|operation)=/u);
});

test('APPROVAL-PO: Place order Task dispatches the exact record revision and optional supplier reference through the gateway', async () => {
  const f = await orderEntryWitness(true);
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const order = seedPurchaseOrder(f, ['5'], 'draft').order;
  const path = `/?${new URLSearchParams({ surface: `${ns}:surface.purchase_order_detail`, record: order, [`${ns}:parameter.commercial_purchase_order_get_legal_entity_scope`]: scope })}`;
  const calls: unknown[] = [];
  let dispatchFailure: unknown;
  class ObservedGateway extends SemanticOperationGateway {
    override async invoke(
      ...args: Parameters<SemanticOperationGateway['invoke']>
    ) {
      try {
        return await super.invoke(...args);
      } catch (error) {
        dispatchFailure = error;
        throw error;
      }
    }
  }
  const capability: RegisteredCapabilityOperationExecutor = {
    capabilityId: 'northstar.purchasing:capability.order_approvals',
    async prepareAuthorization(request) {
      purchaseOrderApprovalInput(request.input, 'release');
      return {
        decisionInput: { legalEntityId: scope },
        legalEntityReadScopeIds: [scope],
        readBackArguments: { recordId: order },
      };
    },
    async execute(request) {
      calls.push(request.input);
      return {
        kind: 'semanticOperationResult',
        schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
        operationId: request.definition.operationId,
        outcome: 'succeeded',
        readBack: f.executor.rows.get(order)!,
        unsupportedReason: null,
        trust: {
          changeDocumentId: randomUUID(),
          domainEventId: randomUUID(),
          invocationId: randomUUID(),
          outboxId: randomUUID(),
        },
      };
    },
  };
  const base = statingGateways(f, {
    commercial: (key) => (key === 'approval_ready' ? true : null),
  });
  const gateways = {
    ...base,
    operationGateway: new ObservedGateway(
      f.policy,
      f.executor,
      base.operationMediation,
      undefined,
      [capability],
    ),
  };
  for (const supplierReference of ['', 'SUP-UI']) {
    const start = await submitSurfaceRuntimeIntent(
      f.view,
      path,
      {
        compositionAction: `${ns}:action.place_order`,
      },
      gateways,
    );
    const taskToken = hiddenValue(start.html, 'taskToken');
    const submit = (values: Record<string, string>) =>
      submitSurfaceRuntimeIntent(
        f.view,
        path,
        { compositionAction: `${ns}:action.place_order`, taskToken, ...values },
        gateways,
      );
    const review = await submit({
      taskStage: 'prepare',
      [`${ns}:input.place_supplier_reference`]: supplierReference,
    });
    const done = await submit({
      taskStage: 'confirm',
      preparedId: hiddenValue(review.html, 'preparedId'),
    });
    if (dispatchFailure) throw dispatchFailure;
    assert.match(done.html, /Place order: done/u, done.html);
    assert.deepEqual(calls.at(-1), {
      recordId: order,
      expectedRevision: f.executor.rows.get(order)!.revision,
      arguments: { supplierReference: supplierReference || null },
    });
  }
});

test('APPROVAL-PO: declared Tasks gate Place order on current approval and suppress the unconditioned capability command', async () => {
  const f = await orderEntryWitness(true);
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const order = seedPurchaseOrder(f, ['5'], 'draft').order;
  const path = `/?${new URLSearchParams({ surface: `${ns}:surface.purchase_order_detail`, record: order, [`${ns}:parameter.commercial_purchase_order_get_legal_entity_scope`]: scope })}`;
  for (const [status, required, ready, submit] of [
    ['Not requested', true, false, true],
    ['Pending', true, false, false],
    ['Approved', true, true, false],
    ['Rejected', true, false, true],
    ['Not required', false, true, false],
    [null, null, null, false],
  ] as const) {
    const html = (
      await renderSurfaceRuntimeWithData(
        f.view,
        path,
        statingGateways(f, {
          commercial: (key) =>
            ({
              approval_status: status,
              approval_required: required,
              approval_ready: ready,
            })[key as 'approval_status'] ?? null,
        }),
      )
    ).html;
    assert.equal(
      html.includes(`value="${ns}:action.place_order"`),
      ready === true,
      String(status),
    );
    assert.equal(
      html.includes(`value="${ns}:action.submit_approval"`),
      submit,
      String(status),
    );
    assert.doesNotMatch(
      html,
      /name="operationId" value="northstar.app:operation.purchase_order_release"/u,
      'a raw Release command must not bypass the declared Task',
    );
  }
  const request = f.executor.seed(
    'purchase_order_approval',
    {
      [`${ns}:field.purchase_order_approval_number`]: 'REQ-TEST',
      [`${ns}:field.purchase_order_approval_order_number`]: 'PO-000042',
      [`${ns}:field.purchase_order_approval_state`]: `${ns}:option.purchase_order_approval_state_pending`,
      [`${ns}:field.purchase_order_approval_kind`]: 'order',
      [`${ns}:field.purchase_order_approval_revision_digest`]: '0'.repeat(64),
      [`${ns}:field.purchase_order_approval_requested_by`]: 'buyer',
      ...Object.fromEntries(
        [
          'reason',
          'decided_by',
          'decision_reason',
          'current_quantity',
          'proposed_quantity',
        ].map((name) => [`${ns}:field.purchase_order_approval_${name}`, null]),
      ),
      [`${ns}:relation.purchase_order_approval_order`]: order,
    },
    scope,
  );
  const requestPath = `/?${new URLSearchParams({ surface: `${ns}:surface.purchase_order_approval_detail`, record: request, [`${ns}:parameter.purchase_order_approval_get_legal_entity_scope`]: scope })}`;
  const html = (
    await renderSurfaceRuntimeWithData(
      f.view,
      requestPath,
      statingGateways(f, {}),
    )
  ).html;
  for (const action of ['approve', 'reject'])
    assert.ok(
      html.includes(`value="${ns}:action.approval_${action}"`),
      html.replace(/<[^>]*>/gu, ' ').slice(-3500),
    );
  assert.match(html, /PO-000042/u);

  f.deniedReads.add(`${ns}:permission.purchase_order_approve`);
  const denied = await renderSurfaceRuntimeWithData(
    f.view,
    requestPath,
    statingGateways(f, {}),
  );
  for (const action of ['approve', 'reject']) {
    assert.ok(
      !denied.html.includes(`value="${ns}:action.approval_${action}"`),
      `${action} must not be offered without the current approve permission`,
    );
    const forged = await submitSurfaceRuntimeIntent(
      f.view,
      requestPath,
      { compositionAction: `${ns}:action.approval_${action}` },
      statingGateways(f, {}),
    );
    assert.equal(forged.statusCode, 422);
    assert.match(forged.html, /COMPOSITION_TASK_UNAVAILABLE/u);
  }
  assert.match(
    denied.html,
    /PO-000042/u,
    'denied decisions must not hide the record',
  );
  f.deniedReads.delete(`${ns}:permission.purchase_order_approve`);
  const restored = await renderSurfaceRuntimeWithData(
    f.view,
    requestPath,
    statingGateways(f, {}),
  );
  assert.ok(restored.html.includes(`value="${ns}:action.approval_approve"`));
  const authorize = f.policy.authorize.bind(f.policy);
  f.policy.authorize = (request) => {
    if (
      asRecord(request.decisionInput).kind ===
      'semanticOperationEligibilityPolicyInput'
    )
      throw new Error('permission preview unavailable');
    return authorize(request);
  };
  try {
    const unavailable = await renderSurfaceRuntimeWithData(
      f.view,
      requestPath,
      statingGateways(f, {}),
    );
    assert.ok(
      !unavailable.html.includes(`value="${ns}:action.approval_approve"`),
    );
    assert.ok(
      !unavailable.html.includes(`value="${ns}:action.approval_reject"`),
    );
    assert.match(unavailable.html, /PO-000042/u);
  } finally {
    f.policy.authorize = authorize;
  }
});

test('PAYABLES: the order lists its bills and offers billing only while the order states something to bill; a bill binds its lines, payments and credits and offers each command in its states', async () => {
  const f = await orderEntryWitness(true);
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const order = f.executor.seed(
    'purchase_order',
    {
      [`${ns}:field.purchase_order_number`]: 'PO-BILLED',
      [`${ns}:field.purchase_order_supplier_party_id`]: f.party,
      [`${ns}:field.purchase_order_currency`]: 'CAD',
      [`${ns}:field.purchase_order_order_date`]: '2026-09-26T09:30:00Z',
      ...Object.fromEntries(
        [
          'expected_date',
          'notes',
          'receiving_location_id',
          'payment_terms',
          'tax_code_id',
          'freight_amount',
          'freight_tax_code_id',
          'freight_tax_rate_percent',
          'other_fee_amount',
          'other_fee_tax_code_id',
          'other_fee_tax_rate_percent',
        ].map((name) => [`${ns}:field.purchase_order_${name}`, null]),
      ),
      [`${ns}:derived_state_field.machine.purchase_order_lifecycle`]: `${ns}:state.purchase_order_released`,
    },
    scope,
  );
  const figures = (balance: string, paid: string) =>
    Object.fromEntries(
      (
        [
          ['subtotal', '22.5'],
          ['charges', '35'],
          ['tax', '2.38'],
          ['total', '59.88'],
          ['paid_amount', paid],
          ['credited_amount', '0'],
          ['balance', balance],
        ] as const
      ).map(([name, value]) => [`${ns}:field.vendor_bill_${name}`, value]),
    );
  const bill = (number: string, state: string, balance: string, paid: string) =>
    f.executor.seed(
      'vendor_bill',
      {
        [`${ns}:field.vendor_bill_number`]: number,
        [`${ns}:field.vendor_bill_state`]: `${ns}:option.vendor_bill_state_${state}`,
        [`${ns}:field.vendor_bill_bill_date`]: '2026-09-30T10:00:00.000Z',
        [`${ns}:field.vendor_bill_due_date`]: '2026-10-30T10:00:00.000Z',
        [`${ns}:field.vendor_bill_supplier_party_id`]: f.party,
        [`${ns}:field.vendor_bill_supplier_invoice_number`]: `INV-${number}`,
        [`${ns}:field.vendor_bill_currency`]: 'CAD',
        [`${ns}:field.vendor_bill_payment_terms`]: null,
        ...figures(balance, paid),
        [`${ns}:relation.vendor_bill_order`]: order,
      },
      scope,
    );
  const open = bill('BILL-000001', 'open', '59.88', '0');
  const paid = bill('BILL-000002', 'paid', '0', '59.88');
  f.executor.seed(
    'vendor_bill_line',
    {
      [`${ns}:field.vendor_bill_line_line_number`]: '1',
      [`${ns}:field.vendor_bill_line_item_id`]: f.item,
      [`${ns}:field.vendor_bill_line_unit_id`]: 'EA',
      [`${ns}:field.vendor_bill_line_quantity`]: '2',
      [`${ns}:field.vendor_bill_line_unit_price`]: '12.5',
      [`${ns}:field.vendor_bill_line_discount_percent`]: '10',
      [`${ns}:field.vendor_bill_line_tax_rate_percent`]: '5',
      [`${ns}:field.vendor_bill_line_amount`]: '22.5',
      [`${ns}:field.vendor_bill_line_tax`]: '1.13',
      [`${ns}:relation.vendor_bill_line_bill`]: open,
    },
    scope,
  );
  f.executor.seed(
    'vendor_payment',
    {
      [`${ns}:field.vendor_payment_number`]: 'VPAY-000001',
      [`${ns}:field.vendor_payment_state`]: `${ns}:option.vendor_payment_state_posted`,
      [`${ns}:field.vendor_payment_payment_date`]: '2026-09-30T11:00:00.000Z',
      [`${ns}:field.vendor_payment_amount`]: '59.88',
      [`${ns}:field.vendor_payment_method`]: `${ns}:option.vendor_payment_method_cheque`,
      [`${ns}:field.vendor_payment_reference`]: 'CHQ-3301',
      [`${ns}:relation.vendor_payment_bill`]: paid,
    },
    scope,
  );
  // The commercial read model states what is to bill as given; the order's
  // total is stated.
  const stating = (toBill: string | null): SurfaceRuntimeGateways =>
    statingGateways(f, {
      commercial: (key) =>
        key === 'order_to_bill'
          ? toBill
          : key === 'order_total'
            ? '10.00'
            : null,
    });
  const orderPath = `/?${new URLSearchParams({
    surface: `${ns}:surface.purchase_order_detail`,
    record: order,
    [`${ns}:parameter.commercial_purchase_order_get_legal_entity_scope`]: scope,
  })}`;
  for (const [toBill, offered] of [
    ['2', true],
    ['0', false],
    [null, false],
  ] as const) {
    const html = (
      await renderSurfaceRuntimeWithData(f.view, orderPath, stating(toBill))
    ).html;
    assert.equal(
      html.includes(`value="${ns}:action.bill_received"`),
      offered,
      `Bill received quantities with ${String(toBill)} to bill`,
    );
    // Its progression's Billing step needs attention exactly then; a
    // released order is otherwise billing as it receives.
    assert.deepEqual(
      [...html.matchAll(/<li data-step-state="([a-z]+)"/gu)].map(
        (match) => match[1],
      ),
      [
        'complete',
        'complete',
        'current',
        offered ? 'attention' : 'current',
        'upcoming',
      ],
      `the order's progression with ${String(toBill)} to bill`,
    );
    // The order's bills, each with its balance, whatever it offers.
    assert.match(
      html,
      new RegExp(
        `data-composition-dataset="${ns}:dataset.purchasing_bills" data-resolution="ready"`,
        'u',
      ),
    );
    assert.match(html, /BILL-000001/u);
    assert.match(html, /BILL-000002/u);
    assert.match(html, /INV-BILL-000001/u);
  }

  // A bill binds its lines, payments and credits; each command is offered
  // only where the bill's state admits it.
  const billPath = (recordId: string) =>
    `/?${new URLSearchParams({
      surface: `${ns}:surface.vendor_bill_detail`,
      record: recordId,
      [`${ns}:parameter.vendor_bill_get_legal_entity_scope`]: scope,
    })}`;
  const offeredOn = (html: string) =>
    ['bill_record_payment', 'bill_record_credit', 'bill_void'].filter((local) =>
      html.includes(`value="${ns}:action.${local}"`),
    );
  const openHtml = (
    await renderSurfaceRuntimeWithData(f.view, billPath(open), stating(null))
  ).html;
  // Its line is read; it has no payment or credit yet, and neither read
  // fails.
  for (const [dataset, resolution] of [
    ['bill_lines', 'ready'],
    ['bill_payments', 'empty'],
    ['bill_credits', 'empty'],
  ] as const)
    assert.match(
      openHtml,
      new RegExp(
        `data-composition-dataset="${ns}:dataset.${dataset}" data-resolution="${resolution}"`,
        'u',
      ),
      dataset,
    );
  assert.match(openHtml, /BILL-000001/u);
  assert.match(openHtml, /INV-BILL-000001/u);
  assert.match(openHtml, /59\.88/u);
  assert.deepEqual(offeredOn(openHtml), [
    'bill_record_payment',
    'bill_record_credit',
    'bill_void',
  ]);
  const paidHtml = (
    await renderSurfaceRuntimeWithData(f.view, billPath(paid), stating(null))
  ).html;
  assert.deepEqual(offeredOn(paidHtml), []);
  assert.match(
    paidHtml,
    new RegExp(
      `data-composition-dataset="${ns}:dataset.bill_payments" data-resolution="ready"`,
      'u',
    ),
  );
  assert.match(paidHtml, /VPAY-000001/u);
});

test('inventory valuation executes declared scoped dependencies, pages history and rechecks current policy', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const scope = f.scopes[0]!;
  f.executor.pageLists = true;
  const header = f.executor.seed(
    'goods_receipt',
    {
      [`${ns}:field.goods_receipt_state`]: `${ns}:option.goods_receipt_state_posted`,
    },
    scope,
  );
  const line = f.executor.seed(
    'goods_receipt_line',
    {
      [`${ns}:field.goods_receipt_line_item_id`]: f.item,
      [`${ns}:field.goods_receipt_line_unit_id`]: 'EA',
      [`${ns}:field.goods_receipt_line_cost_status`]: `${ns}:option.goods_receipt_line_cost_status_known`,
      [`${ns}:field.goods_receipt_line_unit_cost`]: '5',
      [`${ns}:field.goods_receipt_line_currency`]: 'CAD',
    },
    scope,
  );
  const seedMovement = (
    company: string,
    sourceId: string,
    sourceLine: string,
    quantity: string,
    sourceType = 'goodsReceipt',
  ) =>
    f.executor.seed(
      'inventory_movement',
      Object.fromEntries(
        Object.entries({
          item_id: f.item,
          unit_id: 'EA',
          quantity_delta: quantity,
          effective_at: '2026-09-30T10:00:00.000Z',
          recorded_at: '2026-09-30T10:00:00.000Z',
          source_type: sourceType,
          source_id: sourceId,
          source_line: sourceLine,
          posting_role: `${ns}:option.inventory_posting_role_receipt`,
          reversal_of_movement_id: null,
        }).map(([key, value]) => [
          `${ns}:field.inventory_movement_${key}`,
          value,
        ]),
      ),
      company,
    );
  seedMovement(scope, header, line, '2');
  // More than one history page, all unvalued, and another company's quantity.
  for (let i = 0; i < 100; i++)
    seedMovement(scope, randomUUID(), randomUUID(), '1', 'opening');
  seedMovement(f.scopes[1]!, randomUUID(), randomUUID(), '999', 'opening');
  const gateway = new SemanticQueryGateway(
    f.policy,
    f.executor,
    undefined,
    undefined,
    undefined,
    undefined,
    { 'northstar.inventory:capability.valuation': inventoryValuationReadModel },
  );
  const query = registeredSemanticQueryFromPinnedView(
    f.view,
    `${ns}:query.inventory_value_get`,
  )!;
  const request = {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId: query.queryId,
    arguments: {
      recordId: f.item,
      includeArchived: false,
      [query.legalEntityScope!.operand.parameterId]: scope,
    },
  };
  const read = await gateway.invoke(f.view, request);
  assert.equal(read.records[0]!.values[`${ns}:metric.on_hand`], '102');
  assert.equal(
    read.records[0]!.values[`${ns}:metric.inventory_value`],
    'CAD 10.00',
  );
  assert.equal(
    read.records[0]!.values[`${ns}:metric.unvalued_quantity`],
    '100',
  );
  assert.equal(
    f.executor.listReads.get(`${ns}:query.inventory_movement_list`),
    2,
  );
  f.deniedReads.add(`${ns}:permission.goods_receipt_line_read`);
  await assert.rejects(
    gateway.invoke(f.view, request),
    SemanticQueryPolicyDeniedError,
  );
});

test('PAYABLES (PY-G): each order line shows its three-way match as the read model states it, and a bill names and opens its order', async () => {
  const f = await orderEntryWitness(true);
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const {
    order,
    lines: [billedAbove, unbilled, matched],
  } = seedPurchaseOrder(f, ['3', '4', '2']);
  // The match as the purchase-line read model states it, per line; one line
  // unstated, as a withheld bill read leaves it.
  const stated = new Map<string, Record<string, string | null>>([
    [
      billedAbove!,
      {
        received: '1',
        billed: '2',
        to_bill: '0',
        match_status: 'Billed above received',
      },
    ],
    [
      unbilled!,
      {
        received: '4',
        billed: '1',
        to_bill: '3',
        match_status: 'Received, not billed',
      },
    ],
    [
      matched!,
      { received: '2', billed: null, to_bill: null, match_status: null },
    ],
  ]);
  const gateways = statingGateways(f, {
    commercial: (key, record) => stated.get(record.recordId)?.[key] ?? null,
  });
  const orderPage = await renderSurfaceRuntimeWithData(
    f.view,
    `/?${new URLSearchParams({
      surface: id('surface', 'purchase_order_detail'),
      record: order,
      [id('parameter', 'commercial_purchase_order_get_legal_entity_scope')]:
        scope,
    }).toString()}`,
    gateways,
  );
  assert.equal(orderPage.statusCode, 200);
  const section = new RegExp(
    `<section id="${regexpText(id('dataset', 'purchasing_lines'))}"[\\s\\S]*?</section>`,
    'u',
  ).exec(orderPage.html)?.[0];
  assert.ok(section, 'the Order lines section renders');
  for (const label of ['Billed', 'To bill'])
    assert.match(
      section,
      new RegExp(`<th scope="col"[^>]*>${label}</th>`, 'u'),
    );
  const row = (line: string) =>
    new RegExp(
      `<tr[^>]*data-record-id="${regexpText(line)}"[^>]*>([\\s\\S]*?)</tr>`,
      'u',
    ).exec(section)?.[1] ?? '';
  const cell = (line: string, label: string) =>
    new RegExp(`<td data-column-label="${label}"[^>]*>([^<]*)</td>`, 'u').exec(
      row(line),
    )?.[1];
  // The match reads beside the product, without opening details.
  const match = (line: string) =>
    /<span class="composition-cell-label">Match<\/span> ([^<]*)<\/span>/u.exec(
      row(line),
    )?.[1];
  assert.equal(match(billedAbove!), 'Billed above received');
  assert.equal(cell(billedAbove!, 'Billed'), '2');
  assert.equal(cell(billedAbove!, 'To bill'), '0');
  assert.equal(match(unbilled!), 'Received, not billed');
  assert.equal(cell(unbilled!, 'To bill'), '3');
  // Unstated is shown as unstated, never a zero or a guessed match.
  assert.equal(match(matched!), '—');
  assert.equal(cell(matched!, 'Billed'), '—');
  // Shown, never enforced: receiving is still offered on the line billed
  // above what arrived.
  assert.match(
    orderPage.html,
    new RegExp(
      `name="compositionAction" value="${regexpText(id('action', 'receive_lines_known'))}"`,
      'u',
    ),
  );

  // The bill names its order through the stored relation and opens it.
  const bill = f.executor.seed(
    'vendor_bill',
    {
      [id('field', 'vendor_bill_number')]: 'BILL-000007',
      [id('field', 'vendor_bill_state')]: id(
        'option',
        'vendor_bill_state_open',
      ),
      [id('field', 'vendor_bill_bill_date')]: '2026-09-30T10:00:00.000Z',
      [id('field', 'vendor_bill_due_date')]: '2026-10-30T10:00:00.000Z',
      [id('field', 'vendor_bill_supplier_party_id')]: f.party,
      [id('field', 'vendor_bill_supplier_invoice_number')]: 'INV-5501',
      [id('field', 'vendor_bill_currency')]: 'CAD',
      [id('field', 'vendor_bill_payment_terms')]: null,
      ...Object.fromEntries(
        [
          'subtotal',
          'charges',
          'tax',
          'total',
          'paid_amount',
          'credited_amount',
          'balance',
        ].map((name) => [id('field', `vendor_bill_${name}`), '0']),
      ),
      [id('relation', 'vendor_bill_order')]: order,
    },
    scope,
  );
  // Like the PostgreSQL provider: a stored relation is no value of a get,
  // and each relation a get is asked to state is resolved against the
  // governed compiled storage.
  const storage = await governedStorageTarget();
  const gets: Record<string, unknown>[] = [];
  const executor: SemanticQueryExecutor = {
    async execute(request) {
      const result = await f.executor.execute(request);
      if (request.definition.queryType !== 'get') return result;
      const args = asRecord(request.arguments);
      gets.push({ queryId: request.definition.queryId, ...args });
      const targets = relationTargetPlans(
        storage,
        storage.entities.find(
          (value) => value.entityId === request.definition.sourceEntityId,
        )!,
        args.relationTargets as ImmutableJsonValue | undefined,
      );
      return {
        ...result,
        records: result.records.map((record) => ({
          ...record,
          values: Object.fromEntries(
            Object.entries(record.values).filter(
              ([key]) => !key.includes(':relation.'),
            ),
          ),
          ...(targets.length
            ? {
                relationLabels: Object.fromEntries(
                  targets.map((target) => [
                    target.relationId,
                    {
                      label: null,
                      recordId:
                        (record.values[target.relationId] as
                          string | undefined) ?? null,
                    },
                  ]),
                ),
              }
            : {}),
        })),
      };
    },
  };
  const billGateways = statingGateways(f, {}, executor);
  const billPath = `/?${new URLSearchParams({
    surface: id('surface', 'vendor_bill_detail'),
    record: bill,
    [id('parameter', 'vendor_bill_get_legal_entity_scope')]: scope,
  }).toString()}`;
  const fact = (html: string) =>
    /<div><dt>Purchase order<\/dt><dd>([^<]*)<\/dd><\/div>/u.exec(html)?.[1];
  const page = await renderSurfaceRuntimeWithData(
    f.view,
    billPath,
    billGateways,
  );
  assert.equal(page.statusCode, 200);
  assert.equal(fact(page.html), 'PO-000042');
  // The bill's own get stated its order, the one relation the page names.
  assert.deepEqual(
    gets.find((read) => read.queryId === id('query', 'vendor_bill_get'))
      ?.relationTargets,
    [id('relation', 'vendor_bill_order')],
  );
  const href = /<a class="button" href="([^"]+)">Open purchase order<\/a>/u
    .exec(page.html)?.[1]
    ?.replaceAll('&amp;', '&');
  assert.ok(href);
  const target = new URL(href, 'http://fixture.local');
  assert.equal(
    target.searchParams.get('surface'),
    id('surface', 'purchase_order_detail'),
  );
  assert.equal(target.searchParams.get('record'), order);
  assert.equal(
    target.searchParams.get(
      id('parameter', 'commercial_purchase_order_get_legal_entity_scope'),
    ),
    scope,
  );
  // Current policy decides the label on every request: withheld, the fact
  // reads "—" and the bill still serves.
  f.deniedReads.add(id('permission', 'purchase_order_read'));
  const withheld = await renderSurfaceRuntimeWithData(
    f.view,
    billPath,
    billGateways,
  );
  assert.equal(withheld.statusCode, 200);
  assert.equal(fact(withheld.html), '—');
  assert.match(withheld.html, /BILL-000007/u);
  f.deniedReads.delete(id('permission', 'purchase_order_read'));
});

test('INVENTORY-PARITY: the item page lists the stock and movements of one company by the item field, picks the company like an entry and re-authorizes every read', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const [scope, foreign] = f.scopes as [string, string];
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const field = (local: string) => id('field', local);
  const parameter = id(
    'parameter',
    'posted_stock_balance_list_legal_entity_scope',
  );
  // An item and two locations as the providers return them: every field
  // their gets and lists select.
  const item = f.executor.seed('item', {
    [field('item_sku')]: 'VEST-M',
    [field('item_name')]: 'Safety vest (medium)',
    [field('item_description')]: null,
    [field('item_base_unit')]: 'EA',
    [field('item_price_cad')]: '24.5',
    [field('item_price_usd')]: null,
    [field('item_price_eur')]: null,
    // REPLENISHMENT: unset, as an item saved before them reads.
    [field('item_reorder_point')]: null,
    [field('item_reorder_up_to')]: null,
    [field('item_preferred_location_id')]: null,
    [field('item_standard_cost_cad')]: null,
    [field('item_standard_cost_usd')]: null,
    [field('item_standard_cost_eur')]: null,
    // CATALOG-EXTRAS: as PostgreSQL stores them unless set: their defaults.
    [field('item_inventory_policy')]: id(
      'option',
      'item_inventory_policy_stocked',
    ),
    [field('item_reorder_rule')]: id('option', 'item_reorder_rule_manual'),
  });
  const location = (code: string) =>
    f.executor.seed('location', {
      [field('location_code')]: code,
      [field('location_name')]: `${code} warehouse`,
      [field('location_type')]: id('option', 'warehouse'),
      // LOCATIONS: usable, as a location saved before its status reads.
      [field('location_status')]: id('option', 'location_status_usable'),
      [field('location_status_reason')]: null,
      [field('location_status_changed_at')]: null,
    });
  const main = location('CAL-WH');
  const overflow = location('VAN-WH');
  const balance = (
    itemId: string,
    locationId: string,
    quantity: string,
    company = scope,
  ) =>
    f.executor.seed(
      'posted_stock_balance',
      {
        [field('posted_stock_balance_item_id')]: itemId,
        [field('posted_stock_balance_location_id')]: locationId,
        [field('posted_stock_balance_posted_quantity')]: quantity,
        [field('posted_stock_balance_unit_id')]: 'EA',
      },
      company,
    );
  const mainStock = balance(item, main, '13.000000000000000000');
  const overflowStock = balance(item, overflow, '6.000000000000000000');
  balance(f.item, main, '99.000000000000000000');
  const foreignStock = balance(item, main, '7.000000000000000000', foreign);
  // Reservations with the balances the fulfillment projection keeps: what
  // is left on each. A released reservation holds nothing; a draft has no
  // balance yet; another item's reservation is not this item's.
  const reservation = (
    locationId: string,
    state: string,
    remaining: string | null,
    itemId = item,
  ) => {
    const reservationId = f.executor.seed(
      'reservation',
      {
        [field('reservation_number')]: `RSV-${randomUUID()}`,
        [field('reservation_state')]: id(
          'option',
          `reservation_state_${state}`,
        ),
        [field('reservation_item_id')]: itemId,
        [field('reservation_location_id')]: locationId,
        [field('reservation_quantity')]: '3',
        [field('reservation_unit_id')]: 'EA',
        [field('reservation_reason')]: null,
      },
      scope,
    );
    if (remaining === null) return;
    const balanceId = fulfillmentProjectionIdentity(
      f.view,
      scope,
      'reservation',
      reservationId,
    );
    f.executor.rows.set(balanceId, {
      archived: false,
      entityId: id('entity', 'reservation_balance'),
      recordId: balanceId,
      revision: 1,
      values: {
        [field('reservation_balance_remaining_quantity')]: remaining,
        [field('reservation_balance_unit_id')]: 'EA',
      },
    });
    f.executor.owners.set(balanceId, scope);
  };
  reservation(main, 'partially_consumed', '1');
  reservation(main, 'released', '0');
  reservation(overflow, 'draft', null);
  reservation(main, 'active', '5', f.item);
  // Movements, newest first as the list is asked for them.
  const movement = (
    effective: string,
    role: string,
    locationId: string,
    delta: string,
    source: string,
    reason: string,
    itemId = item,
    company = scope,
  ) =>
    f.executor.seed(
      'inventory_movement',
      {
        [field('inventory_movement_item_id')]: itemId,
        [field('inventory_movement_location_id')]: locationId,
        [field('inventory_movement_effective_at')]: effective,
        [field('inventory_movement_recorded_at')]: effective,
        [field('inventory_movement_posting_role')]: id(
          'option',
          `inventory_posting_role_${role}`,
        ),
        [field('inventory_movement_quantity_delta')]: delta,
        [field('inventory_movement_unit_id')]: 'EA',
        [field('inventory_movement_source_type')]: source,
        [field('inventory_movement_reason_code')]: reason,
      },
      company,
    );
  const shipped = movement(
    '2026-09-29T15:00:00.000Z',
    'shipment',
    main,
    '-2.000000000000000000',
    'shipment',
    'SHIP',
  );
  movement(
    '2026-09-29T14:00:00.000Z',
    'receipt',
    main,
    '5.000000000000000000',
    'goodsReceipt',
    'RECEIVE',
  );
  movement(
    '2026-09-29T13:00:00.000Z',
    'adjustment',
    overflow,
    '6.000000000000000000',
    'test',
    'SETUP',
  );
  movement(
    '2026-09-29T12:00:00.000Z',
    'adjustment',
    main,
    '10.000000000000000000',
    'test',
    'SETUP',
  );
  movement(
    '2026-09-29T11:00:00.000Z',
    'adjustment',
    main,
    '99.000000000000000000',
    'test',
    'OTHER-ITEM',
    f.item,
  );
  const foreignMovement = movement(
    '2026-09-29T10:00:00.000Z',
    'adjustment',
    main,
    '7.000000000000000000',
    'test',
    'FOREIGN',
    item,
    foreign,
  );
  // The fulfillment read model the product registers, over this storage.
  const readModels = {
    'northstar.sales:capability.fulfillment': fulfillmentReadModel,
    'northstar.sales:capability.commercial': async ({
      result,
    }: {
      result: SemanticQueryResultEnvelope;
    }) => result,
  };
  const gateways = (executor: SemanticQueryExecutor = f.executor) => ({
    ...f.gateways,
    queryGateway: new SemanticQueryGateway(
      f.policy,
      executor,
      undefined,
      undefined,
      undefined,
      undefined,
      readModels,
    ),
  });
  const page = (parameters: Record<string, string> = {}) =>
    `/?${new URLSearchParams({
      surface: id('surface', 'item_detail'),
      record: item,
      ...parameters,
    }).toString()}`;
  const escaped = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const section = (html: string, local: string) =>
    new RegExp(
      `<section id="${escaped(id('dataset', `item_${local}`))}"[\\s\\S]*?</section>`,
      'u',
    ).exec(html)?.[0] ?? '';
  const rows = (html: string, local: string) =>
    [
      ...section(html, local).matchAll(
        /<tr data-compact-card="true" data-presented-row="true" data-record-id="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gu,
      ),
    ].map((match) => ({
      recordId: match[1]!,
      cells: Object.fromEntries(
        [
          ...match[2]!.matchAll(
            /<td data-column-label="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gu,
          ),
        ].map((cell) => [cell[1]!, cell[2]!.replace(/<[^>]+>/gu, '')]),
      ),
    }));
  const reads = (queryLocal: string) =>
    f.policy.calls.filter(
      (call) =>
        (call.decisionInput as { kind?: string; queryId?: string }).kind ===
          'registeredSemanticQueryPolicyInput' &&
        (call.decisionInput as { queryId?: string }).queryId ===
          id('query', queryLocal),
    );

  // Two authorized companies and no choice yet: the item and the company bar
  // show, and each company-owned section asks for the company.
  const unchosen = await renderSurfaceRuntimeWithData(
    f.view,
    page(),
    gateways(),
  );
  assert.equal(unchosen.statusCode, 200);
  assert.match(unchosen.html, /<h1>Safety vest \(medium\)<\/h1>/u);
  assert.match(
    unchosen.html,
    new RegExp(`data-scope-parameter-id="${escaped(parameter)}"`, 'u'),
  );
  for (const local of ['stock', 'movements'])
    assert.match(
      section(unchosen.html, local),
      /data-resolution="failed"[\s\S]*data-message="QUERY_LEGAL_ENTITY_SCOPE_REQUIRED"/u,
    );
  assert.equal(reads('item_stock_positions').length, 0);
  assert.equal(reads('inventory_movement_list').length, 0);

  // The chosen company: its stock at each location, reserved and available,
  // and its movements of this item, newest first.
  const chosen = await renderSurfaceRuntimeWithData(
    f.view,
    page({ [parameter]: scope }),
    gateways(),
  );
  assert.equal(chosen.statusCode, 200);
  assert.deepEqual(rows(chosen.html, 'stock'), [
    {
      recordId: mainStock,
      cells: {
        Location: 'CAL-WH',
        Status: 'Usable',
        'On hand': '13',
        Reserved: '1',
        Available: '12',
        Unit: 'EA',
      },
    },
    {
      recordId: overflowStock,
      cells: {
        Location: 'VAN-WH',
        Status: 'Usable',
        'On hand': '6',
        Reserved: '0',
        Available: '6',
        Unit: 'EA',
      },
    },
  ]);
  const movements = rows(chosen.html, 'movements');
  assert.deepEqual(
    movements.map((row) => [
      row.cells.Role,
      row.cells.Location,
      row.cells.Change,
      row.cells.Source,
      row.cells.Reason,
    ]),
    [
      ['shipment', 'CAL-WH', '-2', 'shipment', 'SHIP'],
      ['receipt', 'CAL-WH', '5', 'goodsReceipt', 'RECEIVE'],
      ['adjustment', 'VAN-WH', '6', 'test', 'SETUP'],
      ['adjustment', 'CAL-WH', '10', 'test', 'SETUP'],
    ],
  );
  assert.equal(movements[0]!.recordId, shipped);
  assert.match(movements[0]!.cells.Date!, /Sep 29, 2026.*UTC/u);
  assert.doesNotMatch(chosen.html, /OTHER-ITEM|FOREIGN/u);
  assert.ok(!chosen.html.includes(foreignStock));
  // The item's own facts: its unit and prices as money.
  assert.match(chosen.html, /<dt>Base unit<\/dt><dd>EA<\/dd>/u);
  assert.match(chosen.html, /<dt>Price \(CAD\)<\/dt><dd>24\.50<\/dd>/u);
  // The bar offers each company on this same item and marks the chosen one;
  // navigation carries the choice to the company's Lists.
  const bar =
    /<nav class="workspace-context-bar"[\s\S]*?<\/nav>/u.exec(
      chosen.html,
    )?.[0] ?? '';
  const offered = [
    ...bar.matchAll(/href="([^"]+)" data-legal-entity-id="([^"]+)"([^>]*)>/gu),
  ].map((match) => {
    const url = new URL(match[1]!, 'http://x');
    return [
      match[2],
      url.searchParams.get('surface'),
      url.searchParams.get('record'),
      url.searchParams.get(parameter),
      match[3]!.includes('aria-current="true"'),
    ];
  });
  assert.deepEqual(offered, [
    [scope, id('surface', 'item_detail'), item, scope, true],
    [foreign, id('surface', 'item_detail'), item, foreign, false],
  ]);
  assert.match(
    chosen.html,
    new RegExp(
      `href="/\\?surface=${escaped(encodeURIComponent(id('surface', 'posted_stock_balance_list')))}&${escaped(encodeURIComponent(parameter))}=${scope}"`,
      'u',
    ),
  );
  // Each dataset read passed current policy with its field scope, its sort
  // and the chosen company -- never a broader read filtered afterwards.
  for (const [queryLocal, fieldLocal, sort] of [
    [
      'item_stock_positions',
      'posted_stock_balance_item_id',
      [
        {
          fieldId: field('posted_stock_balance_posted_quantity'),
          direction: 'descending',
        },
      ],
    ],
    [
      'inventory_movement_list',
      'inventory_movement_item_id',
      [
        {
          fieldId: field('inventory_movement_effective_at'),
          direction: 'descending',
        },
        {
          fieldId: field('inventory_movement_recorded_at'),
          direction: 'descending',
        },
      ],
    ],
  ] as const) {
    const [call] = reads(queryLocal);
    assert.ok(call, queryLocal);
    const args = (
      call.decisionInput as {
        arguments: Record<string, { fieldFilters?: unknown; sort?: unknown }>;
      }
    ).arguments;
    assert.deepEqual(args.list!.fieldFilters, [
      { fieldId: field(fieldLocal), value: item },
    ]);
    assert.deepEqual(args.list!.sort, sort);
    assert.equal(
      args[id('parameter', `${queryLocal}_legal_entity_scope`)],
      scope,
    );
  }

  // The last company chosen is the default; another company shows its own.
  const remembered = await renderSurfaceRuntimeWithData(
    f.view,
    page(),
    gateways(),
  );
  assert.equal(remembered.statusCode, 303);
  assert.equal(
    new URL(remembered.location!, 'http://x').searchParams.get(parameter),
    scope,
  );
  assert.equal(
    new URL(remembered.location!, 'http://x').searchParams.get('record'),
    item,
  );
  const other = await renderSurfaceRuntimeWithData(
    f.view,
    page({ [parameter]: foreign }),
    gateways(),
  );
  assert.deepEqual(
    rows(other.html, 'stock').map((row) => [
      row.recordId,
      row.cells['On hand'],
      row.cells.Reserved,
      row.cells.Available,
    ]),
    [[foreignStock, '7', '0', '7']],
  );
  assert.deepEqual(
    rows(other.html, 'movements').map((row) => row.recordId),
    [foreignMovement],
  );
  assert.equal(
    new URL(
      (await renderSurfaceRuntimeWithData(f.view, page(), gateways()))
        .location!,
      'http://x',
    ).searchParams.get(parameter),
    foreign,
  );
  // A company outside the offered set is refused by name.
  const invalid = await renderSurfaceRuntimeWithData(
    f.view,
    page({ [parameter]: randomUUID() }),
    gateways(),
  );
  assert.equal(invalid.statusCode, 422);
  assert.match(invalid.html, /WORKSPACE_COMPANY_UNAVAILABLE/u);
  // With one authorized company, it is picked whatever was chosen before.
  f.allowed.delete(foreign);
  const single = await renderSurfaceRuntimeWithData(f.view, page(), gateways());
  assert.equal(single.statusCode, 303);
  assert.equal(
    new URL(single.location!, 'http://x').searchParams.get(parameter),
    scope,
  );
  f.allowed.add(foreign);

  // Current authority on every read: without reservation read the stock is
  // refused by the reservation query's name, never shown as unreserved, and
  // the movements still show; without movement read, the reverse.
  f.deniedReads.add(id('permission', 'reservation_read'));
  const withoutReservations = await renderSurfaceRuntimeWithData(
    f.view,
    page({ [parameter]: scope }),
    gateways(),
  );
  assert.match(
    section(withoutReservations.html, 'stock'),
    /data-resolution="failed"[\s\S]*data-message="COMPOSITION_CHILD_FAILED"/u,
  );
  assert.equal(rows(withoutReservations.html, 'stock').length, 0);
  assert.equal(rows(withoutReservations.html, 'movements').length, 4);
  const refused = await gateways()
    .queryGateway.invoke(f.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: id('query', 'item_stock_positions'),
      arguments: {
        includeArchived: false,
        [id('parameter', 'item_stock_positions_legal_entity_scope')]: scope,
        list: {
          cursor: null,
          fieldFilters: [
            { fieldId: field('posted_stock_balance_item_id'), value: item },
          ],
          matchMode: 'substring',
          pageSize: 10,
          relationLabels: [],
          schemaVersion: 'northstar.shared-list-query/v1',
          search: '',
          sort: [],
        },
      },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  assert.ok(refused instanceof SemanticQueryPolicyDeniedError);
  assert.equal(refused.queryId, id('query', 'workspace_stock_reservations'));
  f.deniedReads.delete(id('permission', 'reservation_read'));
  f.deniedReads.add(id('permission', 'inventory_movement_read'));
  const withoutMovements = await renderSurfaceRuntimeWithData(
    f.view,
    page({ [parameter]: scope }),
    gateways(),
  );
  assert.match(
    section(withoutMovements.html, 'movements'),
    /data-resolution="failed"[\s\S]*data-message="COMPOSITION_CHILD_FAILED"/u,
  );
  assert.equal(rows(withoutMovements.html, 'stock').length, 2);
  f.deniedReads.delete(id('permission', 'inventory_movement_read'));

  // An executor that ignores the field scope answers every item's rows
  // without echoing it: each section is refused, never shown as this item's.
  const ignoring: SemanticQueryExecutor = {
    async execute(request) {
      if (!request.list?.query.fieldFilters) return f.executor.execute(request);
      const { fieldFilters: _ignored, ...query } = request.list.query;
      void _ignored;
      return f.executor.execute({
        ...request,
        list: { ...request.list, query },
      });
    },
  };
  const broad = await renderSurfaceRuntimeWithData(
    f.view,
    page({ [parameter]: scope }),
    gateways(ignoring),
  );
  assert.equal(broad.statusCode, 200);
  for (const local of ['stock', 'movements']) {
    assert.match(
      section(broad.html, local),
      /data-resolution="failed"[\s\S]*data-message="COMPOSITION_CHILD_FAILED"/u,
    );
    assert.equal(rows(broad.html, local).length, 0);
  }
  assert.doesNotMatch(broad.html, /OTHER-ITEM|>99</u);
});

test('INVENTORY-PARITY: a stock document is entered in the shared editor; its first save writes the draft state and names the document as its own posting source, and nothing later rewrites them', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const field = (local: string) => id('field', local);
  const location = (code: string, name: string) =>
    f.executor.seed('location', {
      [field('location_code')]: code,
      [field('location_name')]: name,
      [field('location_type')]: id('option', 'warehouse'),
    });
  const main = location('CAL-WH', 'Calgary warehouse');
  location('VAN-WH', 'Vancouver warehouse');
  const form = f.surfaces.find(
    (value) => value.surfaceId === id('surface', 'inventory_transaction_form'),
  )!;
  assert.ok(form.documentEditor, 'the stock document form is the editor');
  const url = new URL(
    `http://fixture.local/?surface=${encodeURIComponent(form.surfaceId)}&${encodeURIComponent(id('parameter', 'inventory_transaction_get_legal_entity_scope'))}=${scope}`,
  );
  const open = () =>
    documentEditor(f.view, form, f.surfaces, url, scope, f.gateways);
  type Rendered = NonNullable<Awaited<ReturnType<typeof open>>>;
  const post = (
    rendered: Rendered,
    action: string,
    values: Record<string, string> = {},
  ) =>
    documentEditor(f.view, form, f.surfaces, url, scope, f.gateways, {
      draftSession: hiddenValue(rendered.slots!.keyFacts!, 'draftSession'),
      draftVersion: hiddenValue(rendered.slots!.keyFacts!, 'draftVersion'),
      draftAction: action,
      ...values,
    });
  const page = (rendered: Rendered) => Object.values(rendered.slots!).join('');
  // Every offered control, as an operator fills a damaged-stock adjustment:
  // two units taken from the Calgary warehouse.
  const entered: Record<string, string> = {
    inventory_transaction_type: id(
      'option',
      'inventory_transaction_type_adjustment',
    ),
    inventory_transaction_reason_code: 'DAMAGED',
    inventory_transaction_reason_narrative: 'Forklift damage',
    inventory_transaction_effective_at: '2026-09-30T00:00',
    inventory_transaction_line_item_id: f.item,
    inventory_transaction_line_from_location_id: main,
    inventory_transaction_line_to_location_id: '',
    inventory_transaction_line_quantity: '-2',
  };
  const fill = (
    rendered: Rendered,
    changed: Record<string, string> = {},
  ): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const match of page(rendered).matchAll(/name="(draft:[^"]+)"/g)) {
      const local = match[1]!.split(':field.')[1]!;
      result[match[1]!] = changed[local] ?? entered[local] ?? '';
    }
    return result;
  };

  const editor = (await open())!;
  const html = page(editor);
  assert.match(html, /<legend>Stock document<\/legend>/u);
  assert.match(
    html,
    /A draft does not change stock; Post is a separate, confirmed action\./u,
  );
  // Of the stored types only an adjustment or a transfer is offered, the
  // adjustment first; the reasons include opening stock.
  const type = new RegExp(
    `<select[^>]*name="draft:[^"]+:${field('inventory_transaction_type').replaceAll('.', '\\.')}"[^>]*>([\\s\\S]*?)</select>`,
    'u',
  ).exec(html)?.[1];
  assert.deepEqual(
    [...(type ?? '').matchAll(/<option value="([^"]*)"( selected)?>/gu)].map(
      (option) => [option[1], option[2] === ' selected'],
    ),
    [
      [id('option', 'inventory_transaction_type_adjustment'), true],
      [id('option', 'inventory_transaction_type_transfer'), false],
    ],
  );
  assert.match(html, /<option value="OPENING">Opening stock<\/option>/u);
  // The number is the server's, and the state and source are the editor's
  // own: none of them is a control.
  for (const local of [
    'inventory_transaction_number',
    'inventory_transaction_state',
    'inventory_transaction_source_type',
    'inventory_transaction_source_id',
    'inventory_transaction_recorded_at',
    'inventory_transaction_actor_id',
  ])
    assert.doesNotMatch(html, new RegExp(`name="draft:[^"]+:${field(local)}"`));
  const headerId = new RegExp(
    `name="draft:([^:"]+):${field('inventory_transaction_type').replaceAll('.', '\\.')}"`,
    'u',
  ).exec(html)![1]!;

  // A forged number, state, source or actor rides along and is ignored.
  const saved = (await post(editor, 'save', {
    ...fill(editor),
    [`draft:${headerId}:${field('inventory_transaction_number')}`]:
      'STK-FORGED',
    [`draft:${headerId}:${field('inventory_transaction_state')}`]: id(
      'option',
      'inventory_transaction_state_posted',
    ),
    [`draft:${headerId}:${field('inventory_transaction_source_id')}`]: 'forged',
    [`draft:${headerId}:${field('inventory_transaction_actor_id')}`]: 'forged',
  }))!;
  assert.equal(saved.statusCode, 303);
  const recordId = new URL(
    saved.location!,
    'http://fixture.local',
  ).searchParams.get('record')!;
  assert.equal(recordId, headerId);
  const [create, line] = f.executor.calls;
  assert.equal(
    create!.definition.operationId,
    id('operation', 'inventory_transaction_create'),
  );
  const created = asRecord(create!.input);
  assert.equal(created.recordId, recordId);
  assert.equal(created.legalEntityId, scope);
  // When and by whom it was first recorded: the save's instant and the
  // saving principal, never typed.
  const {
    [field('inventory_transaction_recorded_at')]: recordedAt,
    ...firstSave
  } = asRecord(created.values);
  assert.match(
    String(recordedAt),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  );
  assert.deepEqual(firstSave, {
    [field('inventory_transaction_type')]: id(
      'option',
      'inventory_transaction_type_adjustment',
    ),
    [field('inventory_transaction_reason_code')]: 'DAMAGED',
    [field('inventory_transaction_reason_narrative')]: 'Forklift damage',
    [field('inventory_transaction_effective_at')]: '2026-09-30T00:00:00.000Z',
    [field('inventory_transaction_state')]: id(
      'option',
      'inventory_transaction_state_draft',
    ),
    [field('inventory_transaction_source_type')]: 'inventoryTransaction',
    [field('inventory_transaction_source_id')]: recordId,
    [field('inventory_transaction_actor_id')]:
      trustedContextForRequestRuntimeView(f.view).principalId,
  });
  // The line: the product, where the stock comes from, the signed quantity,
  // the product's own unit and the next line number, under this document.
  const lineInput = asRecord(line!.input);
  assert.deepEqual(asRecord(lineInput.values), {
    [field('inventory_transaction_line_item_id')]: f.item,
    [field('inventory_transaction_line_from_location_id')]: main,
    [field('inventory_transaction_line_to_location_id')]: null,
    [field('inventory_transaction_line_quantity')]: '-2',
    [field('inventory_transaction_line_unit_id')]: 'EA',
    [field('inventory_transaction_line_line_number')]: '1',
  });
  assert.deepEqual(lineInput.relations, {
    [id('relation', 'inventory_transaction_line_transaction')]: recordId,
  });
  assert.equal(f.executor.calls.length, 2);

  // Reopened, the draft updates only what changed: the create values are
  // never sent again, so the document stays its own posting source.
  url.searchParams.set('record', recordId);
  const reopened = (await open())!;
  const updated = (await post(
    reopened,
    'save',
    fill(reopened, {
      inventory_transaction_reason_narrative: 'Forklift damage, bay 4',
    }),
  ))!;
  assert.equal(updated.statusCode, 303);
  assert.equal(f.executor.calls.length, 3);
  assert.deepEqual(asRecord(asRecord(f.executor.calls[2]!.input).patch), {
    [field('inventory_transaction_type')]: id(
      'option',
      'inventory_transaction_type_adjustment',
    ),
    [field('inventory_transaction_reason_code')]: 'DAMAGED',
    [field('inventory_transaction_reason_narrative')]: 'Forklift damage, bay 4',
    [field('inventory_transaction_effective_at')]: '2026-09-30T00:00:00.000Z',
  });
  const stored = f.executor.rows.get(recordId)!;
  assert.equal(
    stored.values[field('inventory_transaction_source_id')],
    recordId,
  );

  // Once posted, the document is no longer editable here.
  f.executor.rows.set(recordId, {
    ...stored,
    values: {
      ...stored.values,
      [field('inventory_transaction_state')]: id(
        'option',
        'inventory_transaction_state_posted',
      ),
    },
  });
  const locked = (await open())!;
  assert.equal(locked.statusCode, 422);
  assert.match(locked.html, /DRAFT_EDITOR_LOCKED/u);
});

test('INVENTORY-PARITY: a new stock document is dated the instant it opens, not midnight, and a save that keeps that date sends it (ruling INV-A)', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const field = (local: string) => id('field', local);
  const main = f.executor.seed('location', {
    [field('location_code')]: 'CAL-WH',
    [field('location_name')]: 'Calgary warehouse',
    [field('location_type')]: id('option', 'warehouse'),
  });
  const form = f.surfaces.find(
    (value) => value.surfaceId === id('surface', 'inventory_transaction_form'),
  )!;
  const url = new URL(
    `http://fixture.local/?surface=${encodeURIComponent(form.surfaceId)}&${encodeURIComponent(id('parameter', 'inventory_transaction_get_legal_entity_scope'))}=${scope}`,
  );
  // The request clock: an afternoon instant, with milliseconds.
  const gateways: SurfaceRuntimeGateways = {
    ...f.gateways,
    clock: () => new Date('2026-09-30T14:03:27.456Z'),
  };
  const editor = (await documentEditor(
    f.view,
    form,
    f.surfaces,
    url,
    scope,
    gateways,
  ))!;
  const html = Object.values(editor.slots!).join('');
  const effective = new RegExp(
    `<input type="datetime-local"[^>]*name="draft:[^"]+:${field('inventory_transaction_effective_at').replaceAll('.', '\\.')}" value="([^"]*)"`,
    'u',
  ).exec(html);
  // Now, to the second its control shows -- not midnight, which would date a
  // document that takes stock before the stock that arrived this morning.
  assert.equal(effective?.[1], '2026-09-30T14:03:27');

  // Saved with that date as shown: the create sends the same instant.
  const entered: Record<string, string> = {
    inventory_transaction_effective_at: effective![1]!,
    inventory_transaction_type: id(
      'option',
      'inventory_transaction_type_adjustment',
    ),
    inventory_transaction_reason_code: 'DAMAGED',
    inventory_transaction_reason_narrative: 'Forklift damage',
    inventory_transaction_line_item_id: f.item,
    inventory_transaction_line_from_location_id: main,
    inventory_transaction_line_quantity: '-2',
  };
  const submission: Record<string, string> = {};
  for (const match of html.matchAll(/name="(draft:[^"]+)"/g))
    submission[match[1]!] = entered[match[1]!.split(':field.')[1]!] ?? '';
  const saved = (await documentEditor(
    f.view,
    form,
    f.surfaces,
    url,
    scope,
    gateways,
    {
      draftSession: hiddenValue(editor.slots!.keyFacts!, 'draftSession'),
      draftVersion: hiddenValue(editor.slots!.keyFacts!, 'draftVersion'),
      draftAction: 'save',
      ...submission,
    },
  ))!;
  assert.equal(saved.statusCode, 303);
  const create = f.executor.calls.find(
    (call) =>
      call.definition.operationId ===
      id('operation', 'inventory_transaction_create'),
  );
  assert.equal(
    asRecord(asRecord(create!.input).values)[
      field('inventory_transaction_effective_at')
    ],
    '2026-09-30T14:03:27.000Z',
  );
});

test('REPLENISHMENT: Stock by item and the Buying worklist add up each item in one company in the statement, keep a band per tab and refuse a denied figure query by its name', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const [scope, foreign] = f.scopes as [string, string];
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const field = (local: string) => id('field', local);
  const relation = (local: string) => id('relation', local);
  const stockList = id('surface', 'item_stock_list');
  const buyingList = id('surface', 'item_buying_list');
  const parameter = (list: string) =>
    id('parameter', `${list}_legal_entity_scope`);
  // Items as the providers return them: every field their lists select.
  const item = (
    sku: string,
    name: string,
    reorderPoint: string | null,
    reorderUpTo: string | null,
  ) =>
    f.executor.seed('item', {
      [field('item_sku')]: sku,
      [field('item_name')]: name,
      [field('item_description')]: null,
      [field('item_base_unit')]: 'EA',
      [field('item_price_cad')]: null,
      [field('item_price_usd')]: null,
      [field('item_price_eur')]: null,
      [field('item_reorder_point')]: reorderPoint,
      [field('item_reorder_up_to')]: reorderUpTo,
      [field('item_preferred_location_id')]: null,
      [field('item_standard_cost_cad')]: '12.5',
      [field('item_standard_cost_usd')]: null,
      [field('item_standard_cost_eur')]: null,
      [field('item_inventory_policy')]: id(
        'option',
        'item_inventory_policy_stocked',
      ),
      [field('item_reorder_rule')]: id('option', 'item_reorder_rule_manual'),
    });
  const valve = item('VALVE-10', 'Valve', '10', '40');
  const bolt = item('BOLT-20', 'Bolt', '5', null);
  const nut = item('NUT-30', 'Nut', null, null);
  // Every row here sits at a usable location (LOCATIONS): its stock is usable
  // and what is left of it available.
  const warehouse = f.executor.seed('location', {
    [field('location_code')]: 'WH-1',
    [field('location_name')]: 'Main warehouse',
    [field('location_type')]: id('option', 'warehouse'),
    [field('location_status')]: id('option', 'location_status_usable'),
    [field('location_status_reason')]: null,
    [field('location_status_changed_at')]: null,
  });
  const balance = (itemId: string, quantity: string, company = scope) =>
    f.executor.seed(
      'posted_stock_balance',
      {
        [field('posted_stock_balance_item_id')]: itemId,
        [field('posted_stock_balance_location_id')]: warehouse,
        [field('posted_stock_balance_posted_quantity')]: quantity,
        [field('posted_stock_balance_unit_id')]: 'EA',
      },
      company,
    );
  balance(valve, '8');
  balance(valve, '4');
  balance(valve, '50', foreign);
  balance(bolt, '2');
  balance(nut, '100');
  // What each reservation still holds: a released one nothing, a draft one
  // has no balance yet.
  const reservation = (
    itemId: string,
    state: string,
    remaining: string | null,
  ) => {
    const reservationId = f.executor.seed(
      'reservation',
      {
        [field('reservation_number')]: `RSV-${randomUUID()}`,
        [field('reservation_state')]: id(
          'option',
          `reservation_state_${state}`,
        ),
        [field('reservation_item_id')]: itemId,
        [field('reservation_location_id')]: warehouse,
        [field('reservation_quantity')]: '3',
        [field('reservation_unit_id')]: 'EA',
        [field('reservation_reason')]: null,
      },
      scope,
    );
    if (remaining !== null)
      f.executor.seed(
        'reservation_balance',
        {
          [field('reservation_balance_remaining_quantity')]: remaining,
          [field('reservation_balance_unit_id')]: 'EA',
          [relation('reservation_balance_reservation')]: reservationId,
        },
        scope,
      );
  };
  reservation(valve, 'active', '3');
  reservation(valve, 'released', '0');
  reservation(valve, 'draft', null);
  // Purchase orders: a line points at its order, a received row at its line.
  const supplier = (name: string) =>
    f.executor.seedParty({ [field('party_name')]: name }, ['supplier']);
  const acme = supplier('Acme Supply');
  const brightway = supplier('Brightway Parts');
  const cobalt = supplier('Cobalt Trading');
  const purchase = (
    state: string,
    supplierId: string,
    ordered: string,
    lines: readonly (readonly [
      itemId: string,
      quantity: string,
      received: string,
    ])[],
    company = scope,
  ) => {
    const orderId = f.executor.seed(
      'purchase_order',
      {
        [field('purchase_order_number')]: `PO-${randomUUID().slice(0, 8)}`,
        [field('purchase_order_supplier_party_id')]: supplierId,
        [field('purchase_order_order_date')]: ordered,
        [field('purchase_order_currency')]: 'CAD',
        [id('derived_state_field', 'machine.purchase_order_lifecycle')]: id(
          'state',
          `purchase_order_${state}`,
        ),
      },
      company,
    );
    for (const [itemId, quantity, received] of lines) {
      const lineId = f.executor.seed(
        'purchase_order_line',
        {
          [field('purchase_order_line_item_id')]: itemId,
          [field('purchase_order_line_ordered_quantity')]: quantity,
          [relation('purchase_order_line_order')]: orderId,
        },
        company,
      );
      if (received !== '0')
        f.executor.seed(
          'purchase_order_received',
          {
            [field('purchase_order_received_received_quantity')]: received,
            [relation('purchase_order_received_order_line')]: lineId,
          },
          company,
        );
    }
  };
  // Incoming is what released orders still have to receive, line by line:
  // 10 - 4, and nothing from a line received beyond its order.
  purchase('released', acme, '2026-09-20T09:00:00.000Z', [
    [valve, '10', '4'],
    [valve, '3', '5'],
  ]);
  // A closed order adds nothing incoming but names the latest supplier; a
  // draft, however recent, does neither.
  purchase('closed', brightway, '2026-09-25T09:00:00.000Z', [
    [valve, '5', '5'],
  ]);
  purchase('draft', cobalt, '2026-09-28T09:00:00.000Z', [[valve, '20', '0']]);
  purchase(
    'released',
    cobalt,
    '2026-09-29T09:00:00.000Z',
    [[valve, '30', '0']],
    foreign,
  );
  // Open demand is what confirmed sales orders still have to ship.
  const sale = (
    state: string,
    lines: readonly (readonly [
      itemId: string,
      quantity: string,
      shipped: string,
    ])[],
    company = scope,
  ) => {
    const orderId = f.executor.seed(
      'sales_order',
      {
        [field('sales_order_number')]: `SO-${randomUUID().slice(0, 8)}`,
        [field('sales_order_customer_party_id')]: f.party,
        [field('sales_order_currency')]: 'CAD',
        [id('derived_state_field', 'machine.sales_order_lifecycle')]: id(
          'state',
          `sales_order_${state}`,
        ),
      },
      company,
    );
    for (const [itemId, quantity, shipped] of lines) {
      const lineId = f.executor.seed(
        'sales_order_line',
        {
          [field('sales_order_line_item_id')]: itemId,
          [field('sales_order_line_ordered_quantity')]: quantity,
          [relation('sales_order_line_order')]: orderId,
        },
        company,
      );
      if (shipped !== '0')
        f.executor.seed(
          'sales_order_shipped',
          {
            [field('sales_order_shipped_shipped_quantity')]: shipped,
            [relation('sales_order_shipped_order_line')]: lineId,
          },
          company,
        );
    }
  };
  sale('released', [
    [valve, '15', '5'],
    [bolt, '6', '0'],
  ]);
  sale('draft', [[valve, '7', '0']]);
  sale('released', [[bolt, '40', '0']], foreign);

  const url = (
    list: string,
    local: string,
    parameters: Record<string, string> = {},
  ) =>
    `/?${new URLSearchParams({ surface: list, [parameter(local)]: scope, ...parameters }).toString()}`;
  const counts = (html: string) =>
    Object.fromEntries(
      [
        ...html.matchAll(
          /data-view-id="([^"]+)"[^>]*>(?:<span>[^<]*<\/span>)<span class="list-view__count" data-view-count="(\d+)"/gu,
        ),
      ].map((match) => [match[1]!, Number(match[2]!)]),
    );
  const cell = (html: string, recordId: string, list: string, local: string) =>
    new RegExp(
      `data-record-id="${recordId}"[\\s\\S]*?data-column-id="${id('list_column', `${list}_${local}`)}">([\\s\\S]*?)</td>`,
      'u',
    ).exec(html)?.[1];
  const view = (list: string, local: string) =>
    id('list_view', `${list}_${local}`);
  const figureCalls = () =>
    f.policy.calls.filter(
      (call) =>
        (call.decisionInput as { kind?: string }).kind ===
        'registeredSemanticListFiguresPolicyInput',
    );

  // Stock by item: every item, its figures from this company's rows alone.
  const before = figureCalls().length;
  const stock = await renderSurfaceRuntimeWithData(
    f.view,
    url(stockList, 'item_stock_list'),
    f.gateways,
  );
  assert.equal(stock.statusCode, 200);
  assert.match(stock.html, /data-list-total="4"/u);
  assert.deepEqual(counts(stock.html), {
    [view('item_stock_list', 'all')]: 4,
    [view('item_stock_list', 'shortage')]: 1,
    [view('item_stock_list', 'reorder')]: 1,
  });
  const stockCell = (recordId: string, local: string) =>
    cell(stock.html, recordId, 'item_stock_list', local);
  // On hand 8 + 4 (the other company's 50 is not this company's), all of it
  // usable, reserved what the active reservation still holds, incoming 6,
  // open demand 10: projected 12 + 6 - 10 = 8, at or below its reorder
  // point of 10.
  assert.deepEqual(
    [
      'on_hand',
      'usable',
      'reserved',
      'available',
      'incoming',
      'open_demand',
      'projected',
      'reorder_point',
    ].map((local) => stockCell(valve, local)),
    ['12', '12', '3', '9', '6', '10', '8', '10'],
  );
  assert.equal(
    stockCell(valve, 'status'),
    '<span class="status-pill" data-status-role="attention">Reorder</span>',
  );
  // Projected below zero is a shortage whatever the reorder point.
  assert.equal(stockCell(bolt, 'projected'), '-4');
  assert.equal(
    stockCell(bolt, 'status'),
    '<span class="status-pill" data-status-role="blocked">Shortage</span>',
  );
  // An item without a reorder point is never due.
  assert.equal(stockCell(nut, 'reorder_point'), '<span class="muted">—</span>');
  assert.equal(
    stockCell(nut, 'status'),
    '<span class="status-pill" data-status-role="success">Healthy</span>',
  );
  // Figures are shown, never offered as a sort.
  assert.doesNotMatch(
    stock.html,
    new RegExp(
      `data-sort-column="${id('list_column', 'item_stock_list_projected')}"`,
      'u',
    ),
  );
  // Every figure query passed current policy, per request, for this List's
  // company alone; the label query reads no company.
  const stockCalls = figureCalls().slice(before);
  assert.deepEqual(
    [
      ...new Set(
        stockCalls.map(
          (call) => (call.decisionInput as { queryId: string }).queryId,
        ),
      ),
    ].sort(),
    [
      'commercial_lines',
      // CATALOG-EXTRAS: the company's reorder percentage.
      'legal_entity_list',
      // LOCATIONS: each row's location, for its status.
      'location_list',
      'posted_stock_balance_list',
      'purchase_order_line_list',
      'purchase_order_list',
      'purchase_order_received_list',
      'reservation_balance_list',
      'sales_order_list',
      'sales_order_shipped_list',
      'workspace_stock_reservations',
    ].map((local) => id('query', local)),
  );
  // A location belongs to no company: its List is read without one.
  const shared = (call: (typeof stockCalls)[number]) =>
    (call.decisionInput as { queryId: string }).queryId ===
    id('query', 'location_list');
  // The company's own record is read as a label is, without a company.
  const companyRead = (call: (typeof stockCalls)[number]) =>
    (call.decisionInput as { queryId: string }).queryId ===
    id('query', 'legal_entity_list');
  assert.ok(
    stockCalls
      .filter((call) => !companyRead(call))
      .every(
        (call) =>
          JSON.stringify(
            (call.decisionInput as { arguments: Record<string, unknown> })
              .arguments[parameter('item_stock_list')],
          ) === (shared(call) ? undefined : JSON.stringify([scope])),
      ),
  );
  assert.ok(
    stockCalls
      .filter(companyRead)
      .every(
        (call) =>
          Object.keys(
            (call.decisionInput as { arguments: Record<string, unknown> })
              .arguments,
          ).join() === 'fieldIds,relationIds',
      ),
  );

  // A tab counts and pages the rows its band keeps.
  const shortage = await renderSurfaceRuntimeWithData(
    f.view,
    url(stockList, 'item_stock_list', {
      view: view('item_stock_list', 'shortage'),
    }),
    f.gateways,
  );
  assert.match(shortage.html, /data-list-total="1"/u);
  assert.match(shortage.html, /BOLT-20/u);
  assert.doesNotMatch(shortage.html, /VALVE-10|NUT-30/u);

  // The Buying worklist: what is due, back up to its level, from whom last.
  const buying = await renderSurfaceRuntimeWithData(
    f.view,
    url(buyingList, 'item_buying_list'),
    f.gateways,
  );
  assert.equal(buying.statusCode, 200);
  assert.match(buying.html, /data-list-total="2"/u);
  assert.deepEqual(counts(buying.html), {
    [view('item_buying_list', 'to_buy')]: 2,
  });
  assert.doesNotMatch(buying.html, /NUT-30|SKU-WITNESS/u);
  const buyingCell = (recordId: string, local: string) =>
    cell(buying.html, recordId, 'item_buying_list', local);
  assert.deepEqual(
    [
      'available',
      'projected',
      'reorder_point',
      'reorder_up_to',
      'suggested',
      'last_supplier',
    ].map((local) => buyingCell(valve, local)),
    ['9', '8', '10', '40', '32', 'Brightway Parts'],
  );
  // Without a level the suggestion is unstated, and without a purchase
  // order there is no last supplier: "—", never 0.
  assert.equal(buyingCell(bolt, 'suggested'), '<span class="muted">—</span>');
  assert.equal(
    buyingCell(bolt, 'last_supplier'),
    '<span class="muted">—</span>',
  );
  const labelCalls = figureCalls().filter(
    (call) =>
      (call.decisionInput as { queryId: string }).queryId ===
      id('query', 'party_list'),
  );
  assert.ok(labelCalls.length > 0);
  assert.ok(
    labelCalls.every(
      (call) =>
        Object.keys(
          (call.decisionInput as { arguments: Record<string, unknown> })
            .arguments,
        ).join() === 'fieldIds,relationIds',
    ),
  );

  // The export reads the same figures and names each band by its label.
  const exported = await renderSurfaceRuntimeWithData(
    f.view,
    url(stockList, 'item_stock_list', { export: 'csv' }),
    f.gateways,
  );
  assert.equal(exported.statusCode, 200);
  const rows = exported
    .download!.body.replace(/^\uFEFF/u, '')
    .trimEnd()
    .split('\r\n');
  assert.equal(
    rows[0],
    'SKU,Item,Unit,On hand,Usable,Reserved,Available,Incoming,Open demand,Projected,Reorder point,Status',
  );
  assert.equal(rows.length - 1, 4);
  assert.ok(rows.includes('VALVE-10,Valve,EA,12,12,3,9,6,10,8,10,Reorder'));
  // A negative figure is guarded like any cell a spreadsheet would read as a
  // formula.
  assert.ok(rows.includes("BOLT-20,Bolt,EA,2,2,0,2,0,6,'-4,5,Shortage"));
  // An item with neither level reads empty, never 0.
  assert.ok(rows.includes('NUT-30,Nut,EA,100,100,0,100,0,0,100,,Healthy'));

  // The agent reads the same List through its published preset: the
  // figures argument the web sends, each view's band as `keep`.
  const preset = (
    f.view.projections.agent.payload as {
      listPresets: Array<{
        surfaceId: string;
        figures?: { sums: unknown[] };
        figureLabels?: Record<string, Record<string, string>>;
        views: Array<{
          viewId: string;
          band?: { figureId: string; values: string[] };
        }>;
      }>;
    }
  ).listPresets.find((value) => value.surfaceId === stockList)!;
  assert.equal(preset.figures?.sums.length, 6);
  assert.deepEqual(
    preset.figureLabels?.[id('list_figure', 'item_stock_list_status')],
    {
      // CATALOG-EXTRAS: a non-stocked item's band, named first.
      [id('list_band', 'item_stock_list_not_stocked')]: 'Not stocked',
      [id('list_band', 'item_stock_list_shortage')]: 'Shortage',
      [id('list_band', 'item_stock_list_reorder')]: 'Reorder',
      [id('list_band', 'item_stock_list_healthy')]: 'Healthy',
    },
  );
  assert.deepEqual(
    preset.views.map((value) => value.band?.values),
    [
      undefined,
      [id('list_band', 'item_stock_list_shortage')],
      [id('list_band', 'item_stock_list_reorder')],
    ],
  );

  // Without reservation balances the List is refused by that query's name:
  // a figure is the List's purpose, never omitted.
  f.deniedReads.add(id('permission', 'reservation_balance_read'));
  const denied = await renderSurfaceRuntimeWithData(
    f.view,
    url(stockList, 'item_stock_list'),
    f.gateways,
  );
  assert.match(denied.html, /data-diagnostic-code="QUERY_PERMISSION_DENIED"/u);
  assert.doesNotMatch(denied.html, /VALVE-10/u);
  const refused = await f.gateways.queryGateway
    .invoke(f.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: id('query', 'item_stock_list'),
      arguments: {
        includeArchived: false,
        [parameter('item_stock_list')]: scope,
        list: {
          cursor: null,
          matchMode: 'substring',
          pageSize: 10,
          relationLabels: [],
          schemaVersion: 'northstar.shared-list-query/v1',
          search: '',
          sort: [],
          figures: {
            sums: [
              {
                figureId: id('list_figure', 'item_stock_list_reserved'),
                rows: {
                  matchFieldId: field('reservation_item_id'),
                  queryId: id('query', 'workspace_stock_reservations'),
                },
                related: {
                  fieldId: field('reservation_balance_remaining_quantity'),
                  queryId: id('query', 'reservation_balance_list'),
                  relationId: relation('reservation_balance_reservation'),
                },
                sum: 'related',
              },
            ],
          },
        },
      },
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  assert.ok(refused instanceof SemanticQueryPolicyDeniedError);
  assert.equal(refused.queryId, id('query', 'reservation_balance_list'));
});

test('REPLENISHMENT: the item form chooses its preferred location from the location list by name and keeps the plain control when that list cannot be read', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const field = (local: string) => id('field', local);
  const location = (code: string, name: string) =>
    f.executor.seed('location', {
      [field('location_code')]: code,
      [field('location_name')]: name,
      [field('location_type')]: id('option', 'warehouse'),
    });
  const vancouver = location('VAN-WH', 'Vancouver warehouse');
  const calgary = location('CAL-WH', 'Calgary warehouse');
  const valve = f.executor.seed('item', {
    [field('item_sku')]: 'VALVE-10',
    [field('item_name')]: 'Valve',
    [field('item_description')]: null,
    [field('item_base_unit')]: 'EA',
    [field('item_price_cad')]: null,
    [field('item_price_usd')]: null,
    [field('item_price_eur')]: null,
    [field('item_reorder_point')]: '10',
    [field('item_reorder_up_to')]: '40',
    [field('item_preferred_location_id')]: vancouver,
    // As PostgreSQL states a numeric: at its column's scale.
    [field('item_standard_cost_cad')]: '12.500000000000000000',
    [field('item_standard_cost_usd')]: null,
    [field('item_standard_cost_eur')]: null,
    [field('item_inventory_policy')]: id(
      'option',
      'item_inventory_policy_stocked',
    ),
    [field('item_reorder_rule')]: id('option', 'item_reorder_rule_manual'),
  });
  const form = (record?: string) =>
    renderSurfaceRuntimeWithData(
      f.view,
      `/?${new URLSearchParams({ surface: id('surface', 'item_form'), ...(record ? { record } : {}) }).toString()}`,
      f.gateways,
    );
  const select = (html: string) =>
    new RegExp(
      `<select name="value:${field('item_preferred_location_id')}"[^>]*data-form-reference="${field('item_preferred_location_id')}"[^>]*>([\\s\\S]*?)</select>`,
      'u',
    ).exec(html)?.[1];
  // Offered by name, sorted; the stored id is the one selected and submitted.
  const edit = await form(valve);
  assert.equal(edit.statusCode, 200);
  assert.equal(
    select(edit.html),
    `<option value="">None</option><option value="${calgary}">Calgary warehouse</option><option value="${vancouver}" selected>Vancouver warehouse</option>`,
  );
  // A stored decimal reads in canonical spelling, the one the write path
  // admits: saved untouched, the form is not refused for trailing zeros.
  assert.match(
    edit.html,
    new RegExp(
      `name="value:${field('item_standard_cost_cad')}" value="12\\.5"`,
      'u',
    ),
  );
  // A new item starts with none chosen.
  const created = await form();
  assert.match(select(created.html) ?? '', /<option value="" selected>None/u);
  // The item page names the location; the header and facts never depend on
  // reading it.
  const itemPage = () =>
    renderSurfaceRuntimeWithData(
      f.view,
      `/?${new URLSearchParams({
        surface: id('surface', 'item_detail'),
        record: valve,
        [id('parameter', 'posted_stock_balance_list_legal_entity_scope')]:
          f.scopes[0]!,
      }).toString()}`,
      f.gateways,
    );
  const preferred = (html: string) =>
    /<div><dt>Preferred location<\/dt><dd>([^<]*)<\/dd><\/div>/u.exec(
      html,
    )?.[1];
  const named = await itemPage();
  assert.equal(named.statusCode, 200);
  assert.equal(preferred(named.html), 'Vancouver warehouse');
  assert.match(named.html, /<div><dt>Standard cost \(CAD\)<\/dt><dd>12\.50</u);
  // A location list the principal may not read leaves the plain control:
  // the stored id is kept, never replaced by a partial choice.
  f.deniedReads.add(id('permission', 'location_read'));
  const plain = await form(valve);
  assert.equal(select(plain.html), undefined);
  assert.match(
    plain.html,
    new RegExp(
      `name="value:${field('item_preferred_location_id')}" value="${vancouver}"`,
      'u',
    ),
  );
  // Withheld, the item's details are refused, as any field read through a
  // get current policy withholds is; nothing of the location is disclosed.
  const withheld = await itemPage();
  assert.match(withheld.html, /data-message="COMPOSITION_CHILD_FAILED"/u);
  assert.doesNotMatch(withheld.html, /Vancouver warehouse/u);
  f.deniedReads.delete(id('permission', 'location_read'));
  // An archived location is gone from the choice and from the page alike:
  // the page still reads, the field "—"; the item keeps its id.
  f.executor.rows.set(vancouver, {
    ...f.executor.rows.get(vancouver)!,
    archived: true,
  });
  const gone = await itemPage();
  assert.match(gone.html, /<h1>Valve<\/h1>/u);
  assert.equal(preferred(gone.html), '—');
  assert.match(
    select((await form(valve)).html) ?? '',
    new RegExp(`<option value="${vancouver}" selected>Unavailable \\(`, 'u'),
  );
});

/**
 * LOCATIONS: a location's inventory status says what its stock may be used
 * for. Its page shows the status and changes it only through "Change status",
 * which requires a reason and writes status, reason and instant in one
 * governed update; the generic form leaves all three out. Stock by item, the
 * Buying worklist and the item page count only a usable location's stock as
 * usable or available, reached through the location id each row holds.
 */
test('LOCATIONS: a location changes its status with a reason in one update, its form leaves the status out, and only usable stock is usable or available', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const [scope] = f.scopes as [string, string];
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const field = (local: string) => id('field', local);
  const relation = (local: string) => id('relation', local);
  const status = (local: string) => id('option', `location_status_${local}`);
  const escaped = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const location = (
    code: string,
    name: string,
    state: string,
    reason: string | null = null,
  ) =>
    f.executor.seed('location', {
      [field('location_code')]: code,
      [field('location_name')]: name,
      [field('location_type')]: id('option', 'warehouse'),
      [field('location_status')]: status(state),
      [field('location_status_reason')]: reason,
      [field('location_status_changed_at')]: reason
        ? '2026-10-01T09:30:00.000Z'
        : null,
      // A get states every relation, null when unset (slice 2).
      [id('relation', 'location_parent')]: null,
    });
  const main = location('WH-1', 'Main warehouse', 'usable');
  const hold = location('QA-1', 'Quality hold', 'quarantine', 'Water damage');
  const closed = location('OLD-1', 'Closed bay', 'usable');
  f.executor.rows.set(closed, {
    ...f.executor.rows.get(closed)!,
    archived: true,
  });
  const valve = f.executor.seed('item', {
    [field('item_sku')]: 'VALVE-10',
    [field('item_name')]: 'Valve',
    [field('item_description')]: null,
    [field('item_base_unit')]: 'EA',
    [field('item_price_cad')]: null,
    [field('item_price_usd')]: null,
    [field('item_price_eur')]: null,
    [field('item_reorder_point')]: '10',
    [field('item_reorder_up_to')]: '40',
    [field('item_preferred_location_id')]: null,
    [field('item_standard_cost_cad')]: null,
    [field('item_standard_cost_usd')]: null,
    [field('item_standard_cost_eur')]: null,
  });
  const balance = (locationId: string, quantity: string) =>
    f.executor.seed(
      'posted_stock_balance',
      {
        [field('posted_stock_balance_item_id')]: valve,
        [field('posted_stock_balance_location_id')]: locationId,
        [field('posted_stock_balance_posted_quantity')]: quantity,
        [field('posted_stock_balance_unit_id')]: 'EA',
      },
      scope,
    );
  const mainStock = balance(main, '8');
  const holdStock = balance(hold, '4');
  const closedStock = balance(closed, '2');
  const reservation = (locationId: string, remaining: string) => {
    const reservationId = f.executor.seed(
      'reservation',
      {
        [field('reservation_number')]: `RSV-${randomUUID()}`,
        [field('reservation_state')]: id('option', 'reservation_state_active'),
        [field('reservation_item_id')]: valve,
        [field('reservation_location_id')]: locationId,
        [field('reservation_quantity')]: remaining,
        [field('reservation_unit_id')]: 'EA',
        [field('reservation_reason')]: null,
      },
      scope,
    );
    // Stock by item reads balances by their relation; the item page's read
    // model by the projection's own identity.
    f.executor.seed(
      'reservation_balance',
      {
        [field('reservation_balance_remaining_quantity')]: remaining,
        [field('reservation_balance_unit_id')]: 'EA',
        [relation('reservation_balance_reservation')]: reservationId,
      },
      scope,
    );
    const balanceId = fulfillmentProjectionIdentity(
      f.view,
      scope,
      'reservation',
      reservationId,
    );
    f.executor.rows.set(balanceId, {
      archived: false,
      entityId: id('entity', 'reservation_balance'),
      recordId: balanceId,
      revision: 1,
      values: {
        [field('reservation_balance_remaining_quantity')]: remaining,
        [field('reservation_balance_unit_id')]: 'EA',
      },
    });
    f.executor.owners.set(balanceId, scope);
  };
  reservation(main, '3');
  reservation(hold, '1');

  // Stock by item: on hand 14 everywhere; usable 8, the main warehouse's
  // alone -- the quarantined 4 and the archived bay's 2 are not; reserved 4,
  // of which 3 at a usable location: available 8 - 3 = 5; projected 8.
  const listUrl = (list: string, parameters: Record<string, string> = {}) =>
    `/?${new URLSearchParams({
      surface: id('surface', list),
      [id('parameter', `${list}_legal_entity_scope`)]: scope,
      ...parameters,
    }).toString()}`;
  const cell = (html: string, list: string, local: string) =>
    new RegExp(
      `data-record-id="${valve}"[\\s\\S]*?data-column-id="${id('list_column', `${list}_${local}`)}">([\\s\\S]*?)</td>`,
      'u',
    ).exec(html)?.[1];
  const stock = await renderSurfaceRuntimeWithData(
    f.view,
    listUrl('item_stock_list'),
    f.gateways,
  );
  assert.equal(stock.statusCode, 200);
  assert.deepEqual(
    [
      'on_hand',
      'usable',
      'reserved',
      'available',
      'incoming',
      'open_demand',
      'projected',
    ].map((local) => cell(stock.html, 'item_stock_list', local)),
    ['14', '8', '4', '5', '0', '0', '8'],
  );
  // At or below its reorder point of 10, so the worklist suggests 40 - 8.
  const buying = await renderSurfaceRuntimeWithData(
    f.view,
    listUrl('item_buying_list'),
    f.gateways,
  );
  assert.deepEqual(
    ['usable', 'available', 'projected', 'suggested'].map((local) =>
      cell(buying.html, 'item_buying_list', local),
    ),
    ['8', '5', '8', '32'],
  );
  // Every location's status read through the location List, under current
  // policy, by field: no relation names it.
  const locationReads = f.policy.calls.filter(
    (call) =>
      (call.decisionInput as { kind?: string; queryId?: string }).kind ===
        'registeredSemanticListFiguresPolicyInput' &&
      (call.decisionInput as { queryId?: string }).queryId ===
        id('query', 'location_list'),
  );
  assert.ok(locationReads.length > 0);
  for (const call of locationReads)
    assert.deepEqual(
      (call.decisionInput as { arguments: Record<string, unknown> }).arguments,
      { fieldIds: [field('location_status')], relationIds: [] },
    );
  // The location List withheld refuses Stock by item by its name: a usable
  // figure is never guessed.
  f.deniedReads.add(id('permission', 'location_read'));
  const withheld = await renderSurfaceRuntimeWithData(
    f.view,
    listUrl('item_stock_list'),
    f.gateways,
  );
  assert.match(
    withheld.html,
    /data-diagnostic-code="QUERY_PERMISSION_DENIED"/u,
  );
  assert.doesNotMatch(withheld.html, /VALVE-10/u);
  f.deniedReads.delete(id('permission', 'location_read'));

  // The Location List: each location's type and status; the status filter
  // keeps the quarantined location alone.
  const locations = (parameters: Record<string, string> = {}) =>
    renderSurfaceRuntimeWithData(
      f.view,
      `/?${new URLSearchParams({ surface: id('surface', 'location_list'), ...parameters }).toString()}`,
      f.gateways,
    );
  const all = await locations();
  assert.equal(all.statusCode, 200);
  assert.match(all.html, /QA-1/u);
  assert.match(all.html, /WH-1/u);
  assert.match(
    all.html,
    /<span class="status-pill" data-status-role="attention">Quarantine<\/span>/u,
  );
  assert.match(
    all.html,
    /<span class="status-pill" data-status-role="success">Usable<\/span>/u,
  );
  const quarantined = await locations({
    [id('list_filter', 'location_list_status')]: status('quarantine'),
  });
  assert.match(quarantined.html, /QA-1/u);
  assert.doesNotMatch(quarantined.html, /WH-1/u);
  assert.match(quarantined.html, /Water damage/u);

  // The location page shows its status in its header, with the reason.
  const pageUrl = (recordId: string) =>
    `/?${new URLSearchParams({ surface: id('surface', 'location_detail'), record: recordId }).toString()}`;
  const holdPage = await renderSurfaceRuntimeWithData(
    f.view,
    pageUrl(hold),
    f.gateways,
  );
  assert.equal(holdPage.statusCode, 200);
  assert.match(
    holdPage.html,
    /<span class="composition-business-status">Quarantine<\/span>/u,
  );
  assert.match(holdPage.html, /<dt>Status reason<\/dt><dd>Water damage<\/dd>/u);
  assert.match(holdPage.html, /Change status/u);

  // The item page names each location's status, and nothing is available at
  // a location that is not usable. (Its Location column reads live locations
  // only, so the archived bay's balance leaves first: filed.)
  f.executor.rows.delete(closedStock);
  const readModels = {
    'northstar.sales:capability.fulfillment': fulfillmentReadModel,
    'northstar.sales:capability.commercial': async ({
      result,
    }: {
      result: SemanticQueryResultEnvelope;
    }) => result,
  };
  const itemPage = await renderSurfaceRuntimeWithData(
    f.view,
    `/?${new URLSearchParams({
      surface: id('surface', 'item_detail'),
      record: valve,
      [id('parameter', 'posted_stock_balance_list_legal_entity_scope')]: scope,
    }).toString()}`,
    {
      ...f.gateways,
      queryGateway: new SemanticQueryGateway(
        f.policy,
        f.executor,
        undefined,
        undefined,
        undefined,
        undefined,
        readModels,
      ),
    },
  );
  assert.equal(itemPage.statusCode, 200);
  const stockRow = (recordId: string) =>
    Object.fromEntries(
      [
        ...(
          new RegExp(
            `<tr data-compact-card="true" data-presented-row="true" data-record-id="${recordId}"[^>]*>([\\s\\S]*?)</tr>`,
            'u',
          ).exec(itemPage.html)?.[1] ?? ''
        ).matchAll(/<td data-column-label="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gu),
      ].map((match) => [match[1]!, match[2]!.replace(/<[^>]+>/gu, '')]),
    );
  assert.deepEqual(stockRow(mainStock), {
    Location: 'WH-1',
    Status: 'Usable',
    'On hand': '8',
    Reserved: '3',
    Available: '5',
    Unit: 'EA',
  });
  assert.deepEqual(stockRow(holdStock), {
    Location: 'QA-1',
    Status: 'Quarantine',
    'On hand': '4',
    Reserved: '1',
    Available: '0',
    Unit: 'EA',
  });

  // "Change status": a reason is required, and the change is one update of
  // the status, the reason and the instant.
  const input = (local: string) => id('input', local);
  const submit = (body: Record<string, string>) =>
    submitSurfaceRuntimeIntent(
      f.view,
      pageUrl(main),
      { compositionAction: id('action', 'location_change_status'), ...body },
      f.gateways,
    );
  const entry = await submit({});
  assert.equal(entry.statusCode, 200);
  const taskToken = hiddenValue(entry.html, 'taskToken');
  // The status starts from the location's own.
  assert.match(
    entry.html,
    new RegExp(
      `<option value="${escaped(status('usable'))}" selected>Usable</option>`,
      'u',
    ),
  );
  const unexplained = await submit({
    taskToken,
    taskStage: 'prepare',
    [input('location_status')]: status('damaged'),
    [input('location_status_reason')]: '',
  });
  assert.match(unexplained.html, /COMPOSITION_INPUT_INVALID/u);
  const forged = await submit({
    taskToken,
    taskStage: 'prepare',
    [input('location_status')]: id('option', 'location_type_scrap'),
    [input('location_status_reason')]: 'Forged',
  });
  assert.match(forged.html, /COMPOSITION_INPUT_INVALID/u);
  assert.equal(f.executor.calls.length, 0, 'nothing runs before admission');
  const review = await submit({
    taskToken,
    taskStage: 'prepare',
    [input('location_status')]: status('damaged'),
    [input('location_status_reason')]: 'Forklift impact on rack 3',
  });
  assert.match(review.html, /<dd>Damaged<\/dd>/u);
  assert.match(review.html, /Forklift impact on rack 3/u);
  assert.equal(f.executor.calls.length, 0);
  await submit({
    taskToken,
    taskStage: 'confirm',
    preparedId: hiddenValue(review.html, 'preparedId'),
  });
  assert.equal(f.executor.calls.length, 1);
  const [update] = f.executor.calls;
  assert.equal(
    update!.definition.operationId,
    id('operation', 'location_update'),
  );
  const changed = asRecord(update!.input);
  assert.equal(changed.recordId, main);
  const patch = asRecord(changed.patch);
  assert.deepEqual(Object.keys(patch).sort(), [
    field('location_status'),
    field('location_status_changed_at'),
    field('location_status_reason'),
  ]);
  assert.equal(patch[field('location_status')], status('damaged'));
  assert.equal(
    patch[field('location_status_reason')],
    'Forklift impact on rack 3',
  );
  assert.ok(
    Number.isFinite(
      Date.parse(String(patch[field('location_status_changed_at')])),
    ),
  );

  // The generic form edits the code, name and type and leaves the status, its
  // reason and its time to the page: never shown, and never sent.
  const formUrl = (recordId?: string) =>
    `/?${new URLSearchParams({
      surface: id('surface', 'location_form'),
      ...(recordId ? { record: recordId } : {}),
    }).toString()}`;
  const blank = await renderSurfaceRuntimeWithData(
    f.view,
    formUrl(),
    f.gateways,
  );
  assert.match(blank.html, /<dt>Fields<\/dt><dd>3 ready<\/dd>/u);
  const editing = await renderSurfaceRuntimeWithData(
    f.view,
    formUrl(hold),
    f.gateways,
  );
  for (const local of ['location_code', 'location_name', 'location_type'])
    assert.match(
      editing.html,
      new RegExp(`name="value:${escaped(field(local))}"`, 'u'),
    );
  for (const local of [
    'location_status',
    'location_status_reason',
    'location_status_changed_at',
  ])
    assert.doesNotMatch(
      editing.html,
      new RegExp(`name="(?:value|empty):${escaped(field(local))}"`, 'u'),
    );
  const save = {
    idempotencyKey: randomUUID(),
    operationId: id('operation', 'location_update'),
    recordId: hold,
    expectedRevision: '1',
    [`value:${field('location_code')}`]: 'QA-1',
    [`empty:${field('location_code')}`]: 'nothing',
    [`value:${field('location_name')}`]: 'Quality hold bay',
    [`empty:${field('location_name')}`]: 'nothing',
    [`value:${field('location_type')}`]: id(
      'option',
      'location_type_quarantine',
    ),
    // A forged status rides along and is never read.
    [`value:${field('location_status')}`]: status('usable'),
  };
  const preview = await submitSurfaceRuntimeIntent(
    f.view,
    formUrl(hold),
    save,
    f.gateways,
  );
  const grant = /name="confirmationGrant" value="([^"]+)"/u.exec(
    preview.html,
  )?.[1];
  if (grant)
    await submitSurfaceRuntimeIntent(
      f.view,
      formUrl(hold),
      { ...save, confirmationGrant: grant },
      f.gateways,
    );
  assert.equal(f.executor.calls.length, 2);
  const saved = asRecord(asRecord(f.executor.calls[1]!.input).patch);
  assert.deepEqual(Object.keys(saved).sort(), [
    field('location_code'),
    field('location_name'),
    field('location_type'),
  ]);
  assert.equal(
    saved[field('location_type')],
    id('option', 'location_type_quarantine'),
  );
});

test('LOCATIONS slice 2: a location names the location it is inside, its container lists it, and the create form offers the parent', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const field = (local: string) => id('field', local);
  const parent = id('relation', 'location_parent');
  const location = (
    code: string,
    name: string,
    type: string,
    container: string | null,
  ) =>
    f.executor.seed('location', {
      [field('location_code')]: code,
      [field('location_name')]: name,
      [field('location_type')]: id('option', type),
      [field('location_status')]: id('option', 'location_status_usable'),
      [field('location_status_reason')]: null,
      [field('location_status_changed_at')]: null,
      [parent]: container,
    });
  const warehouse = location('CAL-WH', 'Calgary warehouse', 'warehouse', null);
  const bin = location('CAL-A1', 'Aisle 1', 'location_type_storage', warehouse);
  location('VAN-WH', 'Vancouver warehouse', 'warehouse', null);
  const page = (recordId: string) =>
    renderSurfaceRuntimeWithData(
      f.view,
      `/?${new URLSearchParams({ surface: id('surface', 'location_detail'), record: recordId }).toString()}`,
      f.gateways,
    );
  // The bin names its warehouse by name.
  const binPage = await page(bin);
  assert.equal(binPage.statusCode, 200);
  assert.match(binPage.html, /<dt>Inside<\/dt><dd>Calgary warehouse<\/dd>/u);
  // The warehouse names no container and lists its bin, never the other
  // warehouse.
  const warehousePage = await page(warehouse);
  assert.match(warehousePage.html, /<dt>Inside<\/dt><dd>—<\/dd>/u);
  const inside =
    new RegExp(
      `<section id="${id('dataset', 'location_children').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"[\\s\\S]*?</section>`,
      'u',
    ).exec(warehousePage.html)?.[0] ?? '';
  assert.match(inside, /Locations inside/u);
  assert.match(inside, new RegExp(`data-record-id="${bin}"`, 'u'));
  assert.match(inside, /CAL-A1/u);
  assert.doesNotMatch(inside, /VAN-WH/u);
  // Read through the location list scoped by the parent relation, under
  // current policy.
  assert.ok(
    f.policy.calls.some(
      (call) =>
        (call.decisionInput as { queryId?: string }).queryId ===
        id('query', 'location_list'),
    ),
  );
  // The create form offers every location as the parent, chosen once.
  const form = await renderSurfaceRuntimeWithData(
    f.view,
    `/?${new URLSearchParams({ surface: id('surface', 'location_form') }).toString()}`,
    f.gateways,
  );
  const picker =
    new RegExp(
      `<select name="relation:${parent.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"[^>]*>([\\s\\S]*?)</select>`,
      'u',
    ).exec(form.html)?.[1] ?? '';
  assert.match(picker, /<option value="">None<\/option>/u);
  for (const recordId of [warehouse, bin])
    assert.match(picker, new RegExp(`<option value="${recordId}">`, 'u'));
  // An existing location's form states the parent is locked.
  const editing = await renderSurfaceRuntimeWithData(
    f.view,
    `/?${new URLSearchParams({ surface: id('surface', 'location_form'), record: bin }).toString()}`,
    f.gateways,
  );
  assert.match(editing.html, /Locked after creation/u);
  assert.doesNotMatch(editing.html, /name="relation:/u);
});

/**
 * CATALOG-EXTRAS through the real gateway, list runtime and Task runtime: the
 * Items List and a product picker find an item by an active alias -- reading
 * the aliases only when there is text to search -- and the merge Task never
 * offers the item as its own survivor, then writes the merged-SKU alias on
 * the survivor before archiving the duplicate.
 */
test('CATALOG-EXTRAS: an alias finds its item in the Items List and a product picker, and the merge Task never merges an item into itself', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const [scope] = f.scopes as [string, string];
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const field = (local: string) => id('field', local);
  f.executor.pageLists = true;
  const item = (sku: string, name: string) =>
    f.executor.seed('item', {
      [field('item_sku')]: sku,
      [field('item_name')]: name,
      [field('item_description')]: null,
      [field('item_base_unit')]: 'EA',
      [field('item_price_cad')]: null,
      [field('item_price_usd')]: null,
      [field('item_price_eur')]: null,
      [field('item_reorder_point')]: null,
      [field('item_reorder_up_to')]: null,
      [field('item_preferred_location_id')]: null,
      [field('item_standard_cost_cad')]: null,
      [field('item_standard_cost_usd')]: null,
      [field('item_standard_cost_eur')]: null,
      [field('item_inventory_policy')]: id(
        'option',
        'item_inventory_policy_stocked',
      ),
      [field('item_reorder_rule')]: id('option', 'item_reorder_rule_manual'),
    });
  const notebook = item('NB-80', 'Notebook');
  const duplicate = item('NB-80-DUP', 'Notebook');
  const alias = (value: string, kind: string) =>
    f.executor.seed('item_alias', {
      [field('item_alias_value')]: value,
      [field('item_alias_kind')]: id('option', `item_alias_kind_${kind}`),
      [id('relation', 'item_alias_item')]: notebook,
    });
  alias('BC-0042', 'barcode');
  const removed = alias('OLD-7', 'alternate_sku');
  f.executor.rows.set(removed, {
    ...f.executor.rows.get(removed)!,
    archived: true,
  });
  const childReads = () =>
    f.policy.calls.filter(
      (call) =>
        (call.decisionInput as { kind?: string }).kind ===
        'registeredSemanticListSearchChildPolicyInput',
    );
  const items = async (q?: string) => {
    const page = await renderSurfaceRuntimeWithData(
      f.view,
      `/?${new URLSearchParams({ surface: id('surface', 'item_list'), ...(q ? { q } : {}) }).toString()}`,
      f.gateways,
    );
    assert.equal(page.statusCode, 200);
    return [...page.html.matchAll(/data-record-id="([^"]+)"/gu)].map(
      (match) => match[1]!,
    );
  };
  // The Items List finds the notebook by its barcode, in any case; never by
  // an alias it no longer has.
  const before = childReads().length;
  assert.deepEqual(await items('bc-0042'), [notebook]);
  const read = childReads().slice(before);
  assert.ok(read.length > 0);
  assert.ok(
    read.every(
      (call) =>
        (call.decisionInput as { queryId: string }).queryId ===
        id('query', 'item_alias_list'),
    ),
  );
  assert.deepEqual(await items('old-7'), []);
  // An unsearched List reads no alias at all.
  const unsearched = childReads().length;
  assert.ok((await items()).includes(notebook));
  assert.equal(childReads().length, unsearched);
  // A product picker searches the same way, through its declared children.
  type Editor = {
    lineFields: Array<{
      fieldId: string;
      reference?: {
        queryId: string;
        searchChildren?: Array<{
          fieldId: string;
          queryId: string;
          relationId: string;
        }>;
      };
    }>;
  };
  const editor = readCompiledSurfaceManifest(f.view).surfaces.find(
    (value) => value.surfaceId === id('surface', 'sales_order_detail'),
  )!.documentEditor as unknown as Editor;
  const product = editor.lineFields.find(
    (value) => value.fieldId === field('sales_order_line_item_id'),
  )!.reference!;
  const found = await workspaceSearch(
    f.view,
    f.gateways.queryGateway,
    product.queryId,
    scope,
    'BC-0042',
    null,
    undefined,
    undefined,
    product.searchChildren,
  );
  assert.deepEqual(
    found.records.map((record) => record.recordId),
    [notebook],
  );

  // Merging the duplicate: the notebook is offered, the duplicate is not.
  const surface = readCompiledSurfaceManifest(f.view).surfaces.find(
    (value) => value.surfaceId === id('surface', 'item_detail'),
  )!;
  const url = `/?${new URLSearchParams({
    surface: surface.surfaceId,
    record: duplicate,
    [id('parameter', 'posted_stock_balance_list_legal_entity_scope')]: scope,
  }).toString()}`;
  const survivor = id('input', 'item_survivor');
  // The item page reads its stock through the fulfillment read model the
  // product registers.
  const pageGateways = {
    ...f.gateways,
    queryGateway: new SemanticQueryGateway(
      f.policy,
      f.executor,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        'northstar.sales:capability.fulfillment': fulfillmentReadModel,
        'northstar.sales:capability.commercial': async ({
          result,
        }: {
          result: SemanticQueryResultEnvelope;
        }) => result,
      },
    ),
  };
  const submit = (body: Record<string, string>) =>
    submitCompositionAction(
      f.view,
      surface,
      url,
      { compositionAction: id('action', 'item_merge'), ...body },
      pageGateways,
      (html) => ({ statusCode: 200, html }),
    );
  const initial = await submit({});
  const offered = [
    ...(
      new RegExp(
        `<select name="${survivor.replaceAll('.', '\\.')}"[^>]*>([\\s\\S]*?)</select>`,
        'u',
      ).exec(initial.html)?.[1] ?? ''
    ).matchAll(/<option value="([^"]+)"/gu),
  ].map((match) => match[1]!);
  assert.ok(offered.includes(notebook));
  assert.ok(!offered.includes(duplicate));
  const taskToken = hiddenValue(initial.html, 'taskToken');
  const calls = f.executor.calls.length;
  // A forged choice of the item itself is refused before anything runs:
  // it never reaches review.
  const forged = await submit({
    taskToken,
    taskStage: 'prepare',
    [survivor]: duplicate,
  });
  assert.doesNotMatch(forged.html, /name="preparedId"/u);
  assert.match(
    forged.html,
    /Choose an available reference\.|COMPOSITION_TASK_UNAVAILABLE/u,
  );
  assert.equal(f.executor.calls.length, calls);
  const review = await submit({
    taskToken,
    taskStage: 'prepare',
    [survivor]: notebook,
  });
  const done = await submit({
    taskToken,
    taskStage: 'confirm',
    preparedId: hiddenValue(review.html, 'preparedId'),
  });
  // Both steps committed; the duplicate it retired can no longer be shown,
  // so the Task says it is complete rather than re-reading it.
  assert.match(done.html, /data-task-result|COMPOSITION_COMPLETE/u);
  const merged = f.executor.calls.slice(calls);
  assert.deepEqual(
    merged.map((call) => call.definition.operationId),
    [id('operation', 'item_alias_create'), id('operation', 'item_archive')],
  );
  const created = asRecord(merged[0]!.input);
  assert.deepEqual(asRecord(created.values), {
    [field('item_alias_value')]: 'NB-80-DUP',
    [field('item_alias_kind')]: id('option', 'item_alias_kind_merged_sku'),
  });
  assert.deepEqual(asRecord(created.relations), {
    [id('relation', 'item_alias_item')]: notebook,
  });
  assert.equal(asRecord(merged[1]!.input).recordId, duplicate);
  // The duplicate's SKU now finds the notebook, and the duplicate is gone.
  assert.deepEqual(await items('NB-80-DUP'), [notebook]);
});

test('WAREHOUSE-MODE: the warehouse opens each List view with its count in the company, and a scanned number or SKU opens its record, else keeps the code and says why', async () => {
  const f = await orderEntryWitness();
  // Counts page like the PostgreSQL executor: one row and the total.
  f.executor.pageLists = true;
  const ns = f.ns;
  const [scope, foreign] = f.scopes as [string, string];
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const field = (local: string) => id('field', local);
  const warehouse = id('surface', 'inventory_warehouse');
  const scopeParameter = id('parameter', 'on_hand_legal_entity_id');
  // Purchase orders: one released with something to arrive, one received in
  // full, a draft, and one released in the other company.
  const purchase = (
    number: string,
    state: string,
    ordered: number,
    received: number,
    company = scope,
  ) => {
    const orderId = f.executor.seed(
      'purchase_order',
      {
        [field('purchase_order_number')]: number,
        [field('purchase_order_supplier_party_id')]: f.party,
        [field('purchase_order_expected_date')]: '2026-10-01T00:00:00.000Z',
        [field('purchase_order_currency')]: 'CAD',
        [id('derived_state_field', 'machine.purchase_order_lifecycle')]: id(
          'state',
          `purchase_order_${state}`,
        ),
      },
      company,
    );
    const lineId = f.executor.seed(
      'purchase_order_line',
      {
        [field('purchase_order_line_ordered_quantity')]: String(ordered),
        [id('relation', 'purchase_order_line_order')]: orderId,
      },
      company,
    );
    if (received)
      f.executor.seed(
        'purchase_order_received',
        {
          [field('purchase_order_received_received_quantity')]:
            String(received),
          [id('relation', 'purchase_order_received_order_line')]: lineId,
        },
        company,
      );
    return orderId;
  };
  const toReceive = purchase('PO-000001', 'released', 5, 0);
  purchase('PO-000002', 'released', 3, 3);
  purchase('PO-000003', 'draft', 7, 0);
  purchase('PO-000009', 'released', 9, 0, foreign);
  // Sales orders: one released with something still to ship, one shipped.
  const sale = (number: string, ordered: number, shipped: number) => {
    const orderId = f.executor.seed(
      'sales_order',
      {
        [field('sales_order_number')]: number,
        [field('sales_order_customer_party_id')]: f.party,
        [field('sales_order_currency')]: 'CAD',
        [id('derived_state_field', 'machine.sales_order_lifecycle')]: id(
          'state',
          'sales_order_released',
        ),
      },
      scope,
    );
    const lineId = f.executor.seed(
      'sales_order_line',
      {
        [field('sales_order_line_ordered_quantity')]: String(ordered),
        [id('relation', 'sales_order_line_order')]: orderId,
      },
      scope,
    );
    if (shipped)
      f.executor.seed(
        'sales_order_shipped',
        {
          [field('sales_order_shipped_shipped_quantity')]: String(shipped),
          [id('relation', 'sales_order_shipped_order_line')]: lineId,
        },
        scope,
      );
    return orderId;
  };
  const toShip = sale('SO-000001', 4, 1);
  sale('SO-000002', 2, 2);
  // Stock documents: two transfers and an adjustment here, a transfer there.
  const stock = (number: string, type: string, company = scope) =>
    f.executor.seed(
      'inventory_transaction',
      {
        [field('inventory_transaction_number')]: number,
        [field('inventory_transaction_type')]: id(
          'option',
          `inventory_transaction_type_${type}`,
        ),
        [field('inventory_transaction_state')]: id(
          'option',
          'inventory_transaction_state_draft',
        ),
      },
      company,
    );
  const transfer = stock('STK-000001', 'transfer');
  stock('STK-000002', 'transfer');
  stock('STK-000003', 'adjustment');
  stock('STK-000004', 'transfer', foreign);
  const receipt = f.executor.seed(
    'goods_receipt',
    { [field('goods_receipt_number')]: 'RCV-000001' },
    scope,
  );
  const shipment = f.executor.seed(
    'shipment',
    { [field('shipment_number')]: 'SHP-000001' },
    scope,
  );
  const vest = f.executor.seed('item', {
    [field('item_sku')]: 'VEST-M',
    [field('item_name')]: 'Safety vest',
    [field('item_base_unit')]: 'EA',
  });
  // A second item NAMED like a code: typing its name opens nothing.
  f.executor.seed('item', {
    [field('item_sku')]: 'GLOVE-L',
    [field('item_name')]: 'Gloves',
    [field('item_base_unit')]: 'PAIR',
  });
  const page = (parameters: Record<string, string> = {}) =>
    `/?${new URLSearchParams({ surface: warehouse, ...parameters }).toString()}`;
  const render = (parameters: Record<string, string> = {}) =>
    renderSurfaceRuntimeWithData(f.view, page(parameters), {
      ...f.gateways,
      clock: () => new Date('2026-10-02T12:00:00.000Z'),
    });
  const surfaceOf = (local: string) =>
    f.surfaces.find((surface) => surface.surfaceId === id('surface', local))!;
  const scopeOf = (local: string) =>
    readCompiledSurfaceDataBinding(f.view, surfaceOf(local)).query
      .legalEntityScope!.operand.parameterId;

  // Navigation names the Warehouse among Inventory's destinations.
  const unchosen = await render();
  assert.match(
    unchosen.html,
    new RegExp(
      `<a href="/\\?surface=${encodeURIComponent(warehouse).replace(/%/gu, '%')}[^"]*"[^>]*><span class="nav-icon" aria-hidden="true">W</span><span>Warehouse</span>`,
      'u',
    ),
  );
  // Two authorized companies and no choice yet: the page asks for one and
  // reads nothing for the tiles.
  assert.equal(unchosen.statusCode, 422);
  assert.match(
    unchosen.html,
    /data-diagnostic-code="QUERY_LEGAL_ENTITY_SCOPE_REQUIRED"/u,
  );
  assert.doesNotMatch(unchosen.html, /data-launcher-tile=/u);

  const chosen = await render({ [scopeParameter]: scope });
  assert.equal(chosen.statusCode, 200);
  assert.match(chosen.html, /<h1>Warehouse<\/h1>/u);
  const tiles = [
    ...chosen.html.matchAll(
      /<a class="launcher-tile" href="([^"]+)" data-launcher-tile="([^"]+)"><strong class="launcher-tile__label">([^<]+)<\/strong>(?:<span class="launcher-tile__count" data-launcher-count>(\d+)<\/span>)?(?:<span class="launcher-tile__view">([^<]+)<\/span>)?/gu,
    ),
  ].map((match) => ({
    href: match[1]!.replaceAll('&amp;', '&'),
    tileId: match[2]!,
    label: match[3]!,
    count: match[4] === undefined ? null : Number(match[4]),
    view: match[5] ?? null,
  }));
  // Each tile opens its List at its view in the chosen company, and counts
  // that view as the List counts its own tab: the other company's
  // documents, the closed and the draft ones are not work here.
  assert.deepEqual(
    tiles.map(({ label, count, view }) => [label, count, view]),
    [
      ['Receive', 1, 'To receive'],
      ['Put away', 2, 'Transfers'],
      ['Pick and ship', 1, 'To ship'],
    ],
  );
  const href = (list: string, view: string) =>
    `/?${new URLSearchParams({
      surface: id('surface', list),
      view: id('list_view', `${list}_${view}`),
      [scopeOf(list)]: scope,
    }).toString()}`;
  assert.deepEqual(
    tiles.map((tile) => tile.href),
    [
      href('expected_receipt_list', 'to_receive'),
      href('inventory_transaction_list', 'transfers'),
      href('sales_order_list', 'to_ship'),
    ],
  );
  // The scan box: one field, focused, submitted as a GET in this company.
  assert.match(
    chosen.html,
    new RegExp(
      `<form id="launcher-scan-[^"]+" class="launcher-scan__form" method="get" action="/" role="search"><input type="hidden" name="surface" value="${warehouse}"><input type="hidden" name="${scopeParameter}" value="${scope}"><label class="launcher-scan__field"><span>Scan or type a SKU or document number</span><input name="scan" value="" data-scan-input="true"[^>]* required autofocus></label></form>`,
      'u',
    ),
  );
  assert.match(
    chosen.html,
    /<button type="submit" form="launcher-scan-[^"]+">Open<\/button>/u,
  );

  // A number opens its document in the company, whatever its case; a SKU
  // opens the item at its stock.
  const opened = async (code: string) => {
    const response = await render({ [scopeParameter]: scope, scan: code });
    assert.equal(response.statusCode, 303, `${code} opens its record`);
    return response.location;
  };
  const recordPage = (local: string, recordId: string, parameter: string) =>
    `/?${new URLSearchParams({
      surface: id('surface', local),
      record: recordId,
      [parameter]: scope,
    }).toString()}`;
  assert.equal(
    await opened('po-000001'),
    recordPage(
      'purchase_order_detail',
      toReceive,
      scopeOf('purchase_order_detail'),
    ),
  );
  assert.equal(
    await opened(' SO-000001 '),
    recordPage('sales_order_detail', toShip, scopeOf('sales_order_detail')),
  );
  assert.equal(
    await opened('RCV-000001'),
    recordPage(
      'goods_receipt_detail',
      receipt,
      scopeOf('goods_receipt_detail'),
    ),
  );
  assert.equal(
    await opened('SHP-000001'),
    recordPage('shipment_detail', shipment, scopeOf('shipment_detail')),
  );
  assert.equal(
    await opened('STK-000001'),
    recordPage(
      'inventory_transaction_detail',
      transfer,
      scopeOf('inventory_transaction_detail'),
    ),
  );
  // An item is every company's: it opens in this one, under the company
  // parameter its own page's entry reads.
  assert.equal(
    await opened('VEST-M'),
    recordPage(
      'item_detail',
      vest,
      id('parameter', 'posted_stock_balance_list_legal_entity_scope'),
    ),
  );

  // Another company's number, or nothing at all, opens nothing; the code
  // stays in the box beside the reason.
  const refused = async (code: string, outcome: string) => {
    const response = await render({ [scopeParameter]: scope, scan: code });
    assert.equal(response.statusCode, 422, `${code} opens nothing`);
    assert.match(
      response.html,
      new RegExp(`data-message="${outcome}"`, 'u'),
      `${code} reads ${outcome}`,
    );
    assert.match(
      response.html,
      new RegExp(
        `<input name="scan" value="${code}"[^>]* aria-invalid="true"`,
        'u',
      ),
    );
    // The tiles still offer the work.
    assert.match(response.html, /data-launcher-tile=/u);
    return response;
  };
  await refused('PO-000009', 'SCAN_NO_MATCH');
  await refused('NOPE-1', 'SCAN_NO_MATCH');
  // A name is not a code: it matches, but never opens.
  await refused('Safety vest', 'SCAN_NOT_EXACT');
  // A blank scan asks nothing.
  const reads = f.policy.calls.length;
  const blank = await render({ [scopeParameter]: scope, scan: '   ' });
  assert.equal(blank.statusCode, 200);
  assert.ok(
    f.policy.calls
      .slice(reads)
      .every(
        (call) =>
          (call.decisionInput as { queryId?: string }).queryId?.endsWith(
            '_resolve',
          ) !== true,
      ),
  );

  // A document current policy withholds is passed over without a word that
  // it exists: the same answer as no document at all.
  f.deniedReads.add(id('permission', 'goods_receipt_read'));
  await refused('RCV-000001', 'SCAN_NO_MATCH');
  // ... and a List current policy withholds keeps its tile, uncounted.
  f.deniedReads.add(id('permission', 'inventory_transaction_read'));
  const withheld = await render({ [scopeParameter]: scope });
  assert.match(
    withheld.html,
    /data-launcher-tile="[^"]*put_away"><strong class="launcher-tile__label">Put away<\/strong><span class="launcher-tile__view">Transfers<\/span>/u,
  );
});

test('WAREHOUSE-MODE: the period lock page closes the period through a UTC instant and reopens it to an earlier one, each reviewed and confirmed under its own operation', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const [scope] = f.scopes as [string, string];
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const closedThrough = id('field', 'inventory_period_lock_closed_through');
  const lock = f.executor.seed(
    'inventory_period_lock',
    { [closedThrough]: null },
    scope,
  );
  const surface = f.surfaces.find(
    (candidate) =>
      candidate.surfaceId === id('surface', 'inventory_period_lock_detail'),
  )!;
  const url = `/?${new URLSearchParams({
    surface: surface.surfaceId,
    record: lock,
    [readCompiledSurfaceDataBinding(f.view, surface).query.legalEntityScope!
      .operand.parameterId]: scope,
  }).toString()}`;
  const command = (local: string) =>
    id('action', `inventory_period_lock_${local}`);
  const input = (local: string) =>
    id('input', `inventory_period_lock_${local}_through`);

  // An open period offers only Close: there is nothing to reopen.
  const open = await renderSurfaceRuntimeWithData(f.view, url, f.gateways);
  assert.equal(open.statusCode, 200);
  assert.match(open.html, /<h2>Posting period<\/h2>/u);
  assert.match(
    open.html,
    new RegExp(
      `<input type="hidden" name="compositionAction" value="${command('close')}"><button type="submit">Close period through</button>`,
      'u',
    ),
  );
  assert.doesNotMatch(open.html, /Reopen to/u);
  // The lock offers no other record action: no empty disclosure is shown.
  assert.doesNotMatch(
    open.html,
    /<details class="composition-record-actions">/u,
  );

  const task = async (local: string) => {
    const submit = (body: Record<string, string>) =>
      submitSurfaceRuntimeIntent(
        f.view,
        url,
        { compositionAction: command(local), ...body },
        f.gateways,
      );
    const initial = await submit({});
    return {
      initial,
      submit,
      taskToken: hiddenValue(initial.html, 'taskToken'),
    };
  };

  // Close: an explicit-UTC date and time, to the second.
  const close = await task('close');
  assert.match(
    close.initial.html,
    new RegExp(
      `<label class="field">Close through \\(UTC\\)<input type="datetime-local" step="1" name="${input('close')}" value="" required>`,
      'u',
    ),
  );
  const unreadable = await close.submit({
    taskToken: close.taskToken,
    taskStage: 'prepare',
    [input('close')]: 'end of September',
  });
  assert.match(unreadable.html, /COMPOSITION_INPUT_INVALID/u);
  assert.match(unreadable.html, /Enter a date and time\./u);
  assert.equal(f.executor.calls.length, 0);
  // Reviewed as the field stores it, and only a confirmation changes it.
  const review = await close.submit({
    taskToken: close.taskToken,
    taskStage: 'prepare',
    [input('close')]: '2026-09-30T23:59:59',
  });
  assert.match(review.html, /2026-09-30T23:59:59\.000Z/u);
  assert.match(review.html, /Confirm Close period through/u);
  assert.equal(f.executor.calls.length, 0);
  await close.submit({
    taskToken: close.taskToken,
    taskStage: 'confirm',
    preparedId: hiddenValue(review.html, 'preparedId'),
  });
  assert.equal(f.executor.calls.length, 1);
  const advanced = f.executor.calls[0]!;
  assert.equal(
    advanced.definition.operationId,
    id('operation', 'advance_period_lock'),
  );
  assert.deepEqual(advanced.input, {
    recordId: lock,
    expectedRevision: 1,
    patch: { [closedThrough]: '2026-09-30T23:59:59.000Z' },
  });

  // A closed period offers Reopen, whose operation also asks for its human
  // confirmation: the Task's confirmation carries the grant.
  const closed = await renderSurfaceRuntimeWithData(f.view, url, f.gateways);
  assert.match(closed.html, /Reopen to/u);
  const reopen = await task('reopen');
  assert.match(
    reopen.initial.html,
    /Reopen to \(UTC\)<input type="datetime-local"/u,
  );
  const reopenReview = await reopen.submit({
    taskToken: reopen.taskToken,
    taskStage: 'prepare',
    [input('reopen')]: '2026-09-15T00:00',
  });
  assert.match(reopenReview.html, /2026-09-15T00:00:00\.000Z/u);
  await reopen.submit({
    taskToken: reopen.taskToken,
    taskStage: 'confirm',
    preparedId: hiddenValue(reopenReview.html, 'preparedId'),
  });
  assert.equal(f.executor.calls.length, 2);
  const reopened = f.executor.calls[1]!;
  assert.equal(
    reopened.definition.operationId,
    id('operation', 'reopen_period'),
  );
  assert.deepEqual(reopened.input, {
    recordId: lock,
    expectedRevision: 2,
    patch: { [closedThrough]: '2026-09-15T00:00:00.000Z' },
  });
  // The gateway executes a human-confirmed operation only with a grant for
  // exactly this input; the Task's confirmation issued it.
  assert.equal(
    parsePinnedOperationCatalog(f.view.projections.operation.payload).find(
      (operation) => operation.operationId === id('operation', 'reopen_period'),
    )?.confirmation,
    'humanRequired',
  );
});

test('VALUATION: shipment and invoice costs follow declared line references; policy denial withholds supplementary cost without guessing margin', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const seed = (
    local: string,
    values: Record<string, ImmutableJsonValue>,
    relations: Record<string, string> = {},
  ) =>
    f.executor.seed(
      local,
      {
        ...Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            `${ns}:field.${local}_${key}`,
            value,
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(relations).map(([key, value]) => [
            `${ns}:relation.${local}_${key}`,
            value,
          ]),
        ),
      },
      scope,
    );
  const order = seed('sales_order', { number: 'SO-COST', currency: 'CAD' });
  const orderLine = seed(
    'sales_order_line',
    {
      line_number: '1',
      item_id: f.item,
      unit_id: 'EA',
      ordered_quantity: '4',
      unit_price: '25',
      discount_percent: null,
    },
    { order },
  );
  const shipment = seed(
    'shipment',
    { number: 'SHIP-COST', state: `${ns}:option.shipment_state_posted` },
    { order },
  );
  const packed = seed(
    'shipment_line',
    { line_number: '1', item_id: f.item, unit_id: 'EA', quantity: '4' },
    { shipment, order_line: orderLine },
  );
  const invoice = seed(
    'customer_invoice',
    {
      number: 'INV-COST',
      state: `${ns}:option.customer_invoice_state_open`,
      currency: 'CAD',
      invoice_date: '2026-09-30T10:00:04.000Z',
    },
    { order },
  );
  seed(
    'customer_invoice_line',
    {
      line_number: '1',
      item_id: f.item,
      unit_id: 'EA',
      quantity: '4',
      amount: '100',
    },
    { invoice, order_line: orderLine },
  );
  const movement = (
    sourceType: string,
    sourceId: string,
    sourceLine: string,
    quantity: string,
    instant: number,
  ) =>
    seed('inventory_movement', {
      item_id: f.item,
      unit_id: 'EA',
      quantity_delta: quantity,
      effective_at: `2026-09-30T10:00:0${instant}.000Z`,
      recorded_at: `2026-09-30T10:00:0${instant}.000Z`,
      source_type: sourceType,
      source_id: sourceId,
      source_line: sourceLine,
      posting_role: `${ns}:option.inventory_posting_role_${sourceType === 'shipment' ? 'shipment' : 'receipt'}`,
      reversal_of_movement_id: null,
    });
  for (const [instant, cost] of [
    [1, '5'],
    [2, '15'],
    [4, '30'],
  ] as const) {
    const header = seed('goods_receipt', {
      state: `${ns}:option.goods_receipt_state_posted`,
    });
    const line = seed('goods_receipt_line', {
      item_id: f.item,
      unit_id: 'EA',
      cost_status: `${ns}:option.goods_receipt_line_cost_status_known`,
      unit_cost: cost,
      currency: 'CAD',
    });
    movement('goodsReceipt', header, line, '10', instant);
  }
  movement('shipment', shipment, packed, '-4', 3);
  const executor: SemanticQueryExecutor = {
    async execute(request) {
      const result = await f.executor.execute(request);
      // Like the provider, the declared/authorized relation labels expose the
      // persisted reference identity separately from its human-readable label.
      return {
        ...result,
        records: result.records.map((row) => ({
          ...row,
          relationLabels: Object.fromEntries(
            (request.list?.relationLabels ?? []).map((label) => [
              label.relationId,
              {
                recordId:
                  typeof row.values[label.relationId] === 'string'
                    ? String(row.values[label.relationId])
                    : null,
                label: null,
              },
            ]),
          ),
        })),
      };
    },
  };
  const gateway = new SemanticQueryGateway(
    f.policy,
    executor,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      'northstar.inventory:capability.valuation': inventoryValuationReadModel,
      'northstar.sales:capability.commercial':
        commercialReadModelWithInventoryCost,
    },
  );
  const read = async (local: string, recordId: string) => {
    const query = registeredSemanticQueryFromPinnedView(
      f.view,
      `${ns}:query.${local}`,
    )!;
    return gateway.invoke(f.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: query.queryId,
      arguments: {
        recordId,
        includeArchived: false,
        [query.legalEntityScope!.operand.parameterId]: scope,
      },
    });
  };
  for (const [local, id] of [
    ['valuation_shipment_get', shipment],
    ['commercial_order_get', order],
    ['valuation_customer_invoice_get', invoice],
  ]) {
    const row = (await read(local!, id!)).records[0]!;
    assert.equal(row.values[`${ns}:metric.cost_of_goods`], 'CAD 40.00');
    assert.equal(row.values[`${ns}:metric.cost_unvalued_quantity`], '0');
    if (local !== 'valuation_shipment_get')
      assert.equal(row.values[`${ns}:metric.product_margin`], 'CAD 60.00');
  }
  assert.equal(
    (await read('inventory_value_get', f.item)).records[0]!.values[
      `${ns}:metric.inventory_value`
    ],
    'CAD 460.00',
  );
  f.deniedReads.add(`${ns}:permission.goods_receipt_line_read`);
  const withheld = (await read('commercial_order_get', order)).records[0]!;
  assert.equal(withheld.values[`${ns}:metric.order_total`], '100.00');
  assert.equal(withheld.values[`${ns}:metric.cost_of_goods`], null);
  assert.equal(withheld.values[`${ns}:metric.product_margin`], null);
  assert.equal(
    withheld.values[`${ns}:metric.cost_coverage`],
    'Withheld by current policy',
  );
  await assert.rejects(
    read('inventory_value_get', f.item),
    SemanticQueryPolicyDeniedError,
  );
});

test('VALUATION: landed bill charges follow authorized bill/receipt/order lineage and refuse denied bill reads', async () => {
  const f = await orderEntryWitness();
  const ns = f.ns;
  const scope = f.scopes[0]!;
  const seed = (
    local: string,
    values: Record<string, ImmutableJsonValue>,
    relations: Record<string, string> = {},
  ) =>
    f.executor.seed(
      local,
      {
        ...Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            `${ns}:field.${local}_${key}`,
            value,
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(relations).map(([key, value]) => [
            `${ns}:relation.${local}_${key}`,
            value,
          ]),
        ),
      },
      scope,
    );

  const order = seed('purchase_order', { number: 'PO-LAND' });
  const ordered = seed(
    'purchase_order_line',
    { line_number: '1', item_id: f.item, unit_id: 'EA' },
    { order },
  );
  const receipt = seed(
    'goods_receipt',
    { number: 'GR-LAND', state: `${ns}:option.goods_receipt_state_posted` },
    { order },
  );
  const receiptLine = seed(
    'goods_receipt_line',
    {
      item_id: f.item,
      unit_id: 'EA',
      cost_status: `${ns}:option.goods_receipt_line_cost_status_known`,
      unit_cost: '5',
      currency: 'CAD',
    },
    { receipt, order_line: ordered },
  );
  seed('inventory_movement', {
    item_id: f.item,
    unit_id: 'EA',
    quantity_delta: '10',
    effective_at: '2026-09-30T10:00:01.000Z',
    recorded_at: '2026-09-30T10:00:01.000Z',
    source_type: 'goodsReceipt',
    source_id: receipt,
    source_line: receiptLine,
    posting_role: `${ns}:option.inventory_posting_role_receipt`,
    reversal_of_movement_id: null,
  });
  const bill = seed(
    'vendor_bill',
    {
      number: 'BILL-LAND',
      state: `${ns}:option.vendor_bill_state_open`,
      currency: 'CAD',
      charges: '20',
      bill_date: '2026-09-30T10:00:02.000Z',
    },
    { order },
  );
  seed(
    'vendor_bill_line',
    { item_id: f.item, unit_id: 'EA', quantity: '10' },
    { bill, order_line: ordered },
  );
  const executor: SemanticQueryExecutor = {
    async execute(request) {
      const result = await f.executor.execute(request);
      // Like the provider, the declared/authorized relation labels expose the
      // persisted reference identity separately from its human-readable label.
      return {
        ...result,
        records: result.records.map((row) => ({
          ...row,
          relationLabels: Object.fromEntries(
            (request.list?.relationLabels ?? []).map((label) => [
              label.relationId,
              {
                recordId:
                  typeof row.values[label.relationId] === 'string'
                    ? String(row.values[label.relationId])
                    : null,
                label: null,
              },
            ]),
          ),
        })),
      };
    },
  };

  const gateway = new SemanticQueryGateway(
    f.policy,
    executor,
    undefined,
    undefined,
    undefined,
    undefined,
    { 'northstar.inventory:capability.valuation': inventoryValuationReadModel },
  );
  const read = async (local: string, recordId: string) => {
    const query = registeredSemanticQueryFromPinnedView(
      f.view,
      `${ns}:query.${local}`,
    )!;
    return gateway.invoke(f.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: query.queryId,
      arguments: {
        recordId,
        includeArchived: false,
        [query.legalEntityScope!.operand.parameterId]: scope,
      },
    });
  };

  const row = (await read('inventory_value_get', f.item)).records[0]!;
  assert.equal(row.values[`${ns}:metric.inventory_value`], 'CAD 70.00');
  assert.equal(row.values[`${ns}:metric.average_cost`], 'CAD 7');
  assert.equal(
    row.values[`${ns}:metric.landed_cost_coverage`],
    'Allocated by actual receipt value',
  );
  const sale = seed('sales_order', { currency: 'CAD' });
  const sold = seed(
    'sales_order_line',
    {
      item_id: f.item,
      unit_id: 'EA',
      unit_price: '25',
      discount_percent: null,
    },
    { order: sale },
  );
  const shipment = seed(
    'shipment',
    { state: `${ns}:option.shipment_state_posted` },
    { order: sale },
  );
  const packed = seed(
    'shipment_line',
    { item_id: f.item, unit_id: 'EA', quantity: '2' },
    { shipment, order_line: sold },
  );
  seed('inventory_movement', {
    item_id: f.item,
    unit_id: 'EA',
    quantity_delta: '-2',
    effective_at: '2026-09-30T10:00:03.000Z',
    recorded_at: '2026-09-30T10:00:03.000Z',
    source_type: 'shipment',
    source_id: shipment,
    source_line: packed,
    posting_role: `${ns}:option.inventory_posting_role_shipment`,
    reversal_of_movement_id: null,
  });
  assert.equal(
    (await read('valuation_shipment_get', shipment)).records[0]!.values[
      `${ns}:metric.cost_of_goods`
    ],
    'CAD 14.00',
  );
  assert.equal(
    (await read('inventory_value_get', f.item)).records[0]!.values[
      `${ns}:metric.inventory_value`
    ],
    'CAD 56.00',
  );
  f.deniedReads.add(`${ns}:permission.vendor_bill_read`);
  assert.equal(
    (await read('valuation_shipment_get', shipment)).records[0]!.values[
      `${ns}:metric.cost_coverage`
    ],
    'Withheld by current policy',
  );
  await assert.rejects(
    read('inventory_value_get', f.item),
    SemanticQueryPolicyDeniedError,
  );
});
