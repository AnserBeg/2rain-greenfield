import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { STATUS_ROLES } from '@north-star/canonical-model';
import {
  RequestRuntimeViewLoadError,
  type RequestRuntimeViewLoadErrorCode,
} from '@north-star/postgres-provider/request-runtime-view-service';

import * as listBehavior from '../../../packages/runtime/src/list-behavior/index.js';
import { ModuleRuntimeInterpreterError } from '../../../packages/postgres-provider/src/module-runtime-interpreter.js';
import {
  AuthenticatedRequestEntryAdapter,
  type UntrustedRequestInput,
} from '../../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  REQUEST_RUNTIME_VIEW_REFUSAL_CODES,
  RequestRuntimeViewRefusalError,
  type CurrentPolicyGateway,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeViewRefusalCode,
} from '../../../packages/runtime/src/request-runtime-view.js';
import type { RequestRuntimeView as IssuedRequestRuntimeView } from '../../../packages/runtime/src/request-runtime-view.js';
import * as resolveByName from '../../../packages/runtime/src/resolve-by-name.js';
import * as operationGateway from '../../../packages/runtime/src/semantic-operation-gateway.js';
import * as queryGateway from '../../../packages/runtime/src/semantic-query-gateway.js';
import {
  MAPPED_OPERATION_ERROR_NAMES,
  MAPPED_QUERY_ERROR_NAMES,
  operationMessageRef,
} from '../src/gateway-error-codes.js';
import { createSurfaceRuntimeServer } from '../src/app-server.js';
import {
  MESSAGE_PLACEMENTS,
  OPERATION_DIAGNOSTIC_CODES,
  QUERY_DIAGNOSTIC_CODES,
  REFUSED_MESSAGE_PLACEMENTS,
  SURFACE_MESSAGE_CATALOG,
  SURFACE_MESSAGE_CODES,
  messageStatusRole,
} from '../src/message-catalog.js';
import {
  REGISTERED_SURFACE_COMPONENT_IDS,
  SURFACE_SLOT_RESOLUTION_STATES,
  renderRegisteredSurfaceComponent,
  surfaceHasUnsupportedComponent,
  surfaceSupportsRuntimeIntent,
} from '../src/component-registry.js';
import { readDemoCompiledFixture } from '../src/demo-runtime.js';
import { renderSurfaceRuntime } from '../src/surface-runtime.js';
import {
  INTENT_RENDERED_ARITY,
  readCompiledSurfaceManifest,
} from '../src/surface-contract.js';
import { compiledFixturePath, demoEntry, webRoot } from './helpers.js';

const APP_SERVER_RUNTIME_VIEW_REFUSAL_IMPORT =
  "import { RequestRuntimeViewRefusalError } from '@north-star/runtime/request-runtime-view';\n";

function assertAppServerRuntimeRefusalBoundary(source: string): void {
  const occurrences =
    source.split(APP_SERVER_RUNTIME_VIEW_REFUSAL_IMPORT).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      'app-server must import exactly one runtime-owned refusal declaration',
    );
  }
  if (/postgres-provider/u.test(source)) {
    throw new Error('app-server may not import a postgres-provider authority');
  }
}

type ProviderCodesMissingFromRuntime = Exclude<
  RequestRuntimeViewLoadErrorCode,
  RequestRuntimeViewRefusalCode
>;
type RuntimeCodesMissingFromProvider = Exclude<
  RequestRuntimeViewRefusalCode,
  RequestRuntimeViewLoadErrorCode
>;

const PROVIDER_CODES_MISSING_FROM_RUNTIME = Object.freeze(
  {},
) satisfies Readonly<Record<ProviderCodesMissingFromRuntime, never>>;
const RUNTIME_CODES_MISSING_FROM_PROVIDER = Object.freeze(
  {},
) satisfies Readonly<Record<RuntimeCodesMissingFromProvider, never>>;

test('checked-in shell artifact is parse-normalized deterministic compiler output', () => {
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      `${webRoot}/scripts/compile-demo-release.ts`,
      '--check',
    ],
    { cwd: `${webRoot}/../..`, stdio: 'pipe' },
  );
});

test('navigation is emitted only from the compiled surface projection', async () => {
  const fixture = readDemoCompiledFixture(compiledFixturePath);
  const projection = projectionRecord(fixture, 'surface');
  const payload = record(projection.payload);
  const compiledSurfaces = arrayOfRecords(payload.surfaces);
  const compiledLabels = compiledSurfaces.map((surface) =>
    String(surface.label),
  );

  const rendererSource = readFileSync(
    `${webRoot}/src/surface-runtime.ts`,
    'utf8',
  );
  const registrySource = readFileSync(
    `${webRoot}/src/component-registry.ts`,
    'utf8',
  );
  for (const label of compiledLabels) {
    assert.equal(rendererSource.includes(`>${label}<`), false);
    assert.equal(registrySource.includes(`>${label}<`), false);
  }

  const html = await demoEntry().run(
    {},
    (view) => renderSurfaceRuntime(view, '/').html,
  );
  const positions = compiledLabels.map((label) => html.indexOf(`>${label}<`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
  );
});

test('renderer accepts one issued view and has no ambient release access', async () => {
  const view = await demoEntry().run({}, (issued) => issued);
  const manifest = readCompiledSurfaceManifest(view);
  assert.equal(manifest.surfaces.length, 4);
  assert.throws(
    () =>
      renderSurfaceRuntime(
        { ...view } as unknown as Parameters<typeof renderSurfaceRuntime>[0],
        '/',
      ),
    /must be issued/,
  );

  for (const relativePath of [
    'src/component-registry.ts',
    'src/surface-contract.ts',
    'src/surface-runtime.ts',
  ]) {
    const source = readFileSync(`${webRoot}/${relativePath}`, 'utf8');
    assert.doesNotMatch(
      source,
      /ActiveReleasePointer|releaseRepository|global[A-Z][A-Za-z]*Release|process\.env|postgres-provider|node:fs/,
    );
  }
  const serverSource = readFileSync(`${webRoot}/src/app-server.ts`, 'utf8');
  assert.doesNotMatch(
    serverSource,
    /ActiveReleasePointer|releaseRepository|global[A-Z][A-Za-z]*Release|process\.env|node:fs/,
  );
  assertAppServerRuntimeRefusalBoundary(serverSource);
});

test('app-server runtime refusal boundary red: the required runtime-owned import cannot disappear', () => {
  const serverSource = readFileSync(`${webRoot}/src/app-server.ts`, 'utf8');
  const withoutRuntimeRefusalImport = serverSource.replace(
    APP_SERVER_RUNTIME_VIEW_REFUSAL_IMPORT,
    '',
  );
  assert.notEqual(withoutRuntimeRefusalImport, serverSource);
  assert.doesNotMatch(withoutRuntimeRefusalImport, /postgres-provider/u);
  assert.throws(
    () => assertAppServerRuntimeRefusalBoundary(withoutRuntimeRefusalImport),
    /app-server must import exactly one runtime-owned refusal declaration/u,
  );
});

test('app-server runtime refusal boundary red: a provider loader import is refused', () => {
  const serverSource = readFileSync(`${webRoot}/src/app-server.ts`, 'utf8');
  const withAmbientLoader = `${serverSource}\nimport { PostgresRequestRuntimeViewService } from '@north-star/postgres-provider/request-runtime-view-service';\n`;
  assert.notEqual(withAmbientLoader, serverSource);
  assert.equal(
    withAmbientLoader.split(APP_SERVER_RUNTIME_VIEW_REFUSAL_IMPORT).length - 1,
    1,
  );
  assert.throws(
    () => assertAppServerRuntimeRefusalBoundary(withAmbientLoader),
    /app-server may not import a postgres-provider authority/u,
  );
});

test('every typed runtime-view refusal crosses the HTTP boundary with its code', async () => {
  assert.deepEqual(PROVIDER_CODES_MISSING_FROM_RUNTIME, {});
  assert.deepEqual(RUNTIME_CODES_MISSING_FROM_PROVIDER, {});
  assert.equal(Object.keys(REQUEST_RUNTIME_VIEW_REFUSAL_CODES).length, 15);
  let refusalCode: RequestRuntimeViewLoadErrorCode = 'ACTIVE_POINTER_MISSING';
  const currentPolicy: CurrentPolicyGateway = Object.freeze({
    async authorize() {
      return Object.freeze({
        decision: 'ALLOW' as const,
        decisionVersion: 'northstar.current-policy-decision/v1' as const,
        policyVersion: 'runtime-view-refusal-gate-v1',
      });
    },
    async readCurrentVersion() {
      return Object.freeze({
        policyVersion: 'runtime-view-refusal-gate-v1',
      });
    },
  });
  const server = createSurfaceRuntimeServer(
    new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(async () => ({
        environmentId: '20000000-0000-4000-8000-000000000002',
        principalId: '40000000-0000-4000-8000-000000000004',
        tenantId: '10000000-0000-4000-8000-000000000001',
      })),
      Object.freeze({
        async load(): Promise<never> {
          throw new RequestRuntimeViewLoadError(
            refusalCode,
            'typed refusal from the runtime-view loader',
          );
        },
      }),
      currentPolicy,
    ),
  );
  const baseUrl = await listen(server);

  try {
    for (const code of Object.keys(
      REQUEST_RUNTIME_VIEW_REFUSAL_CODES,
    ) as RequestRuntimeViewRefusalCode[]) {
      refusalCode = code;
      const response = await fetch(baseUrl);
      assert.equal(response.status, 500, code);
      const html = await response.text();
      assert.match(html, /data-message="REQUEST_RUNTIME_VIEW_REFUSED"/u, code);
      assert.match(
        html,
        /data-diagnostic-code="REQUEST_RUNTIME_VIEW_REFUSED"/u,
        code,
      );
      assert.match(html, /data-status-role="blocked"/u, code);
      assert.match(
        html,
        /<h1 data-message-sentence>Runtime view refused<\/h1>/u,
        code,
      );
      assert.match(
        html,
        new RegExp(`<code data-message-subject>${code}</code>`, 'u'),
        code,
      );
      assert.match(
        html,
        /<code data-message-code>REQUEST_RUNTIME_VIEW_REFUSED<\/code>/u,
        code,
      );
      assert.doesNotMatch(html, /REQUEST_RUNTIME_VIEW_UNAVAILABLE/u, code);
    }
  } finally {
    await close(server);
  }
});

test('a synchronous loader refusal is translated before current policy is called', async () => {
  const loaderFailure = new RequestRuntimeViewLoadError(
    'ACTIVE_POINTER_MISSING',
    'synchronous loader refusal',
  );
  let policyCalls = 0;
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    runtimeRefusalRequestEntry(),
    Object.freeze({
      load(): Promise<never> {
        throw loaderFailure;
      },
    }),
    Object.freeze({
      async authorize() {
        return allowedCurrentPolicyDecision();
      },
      async readCurrentVersion() {
        policyCalls += 1;
        return currentPolicyVersionEvidence();
      },
    }),
  );

  await assert.rejects(
    entry.run({}, () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof RequestRuntimeViewRefusalError);
      assert.equal(error.code, 'ACTIVE_POINTER_MISSING');
      return true;
    },
  );
  assert.equal(policyCalls, 0);
});

test('immediate loader and policy rejections retain loader-first Promise.all precedence', async () => {
  const loaderFailure = new RequestRuntimeViewLoadError(
    'ACTIVE_RELEASE_NOT_VISIBLE',
    'immediately rejected loader refusal',
  );
  const policyFailure = new Error('immediately rejected current policy');
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    runtimeRefusalRequestEntry(),
    Object.freeze({
      load(): Promise<never> {
        return Promise.reject(loaderFailure);
      },
    }),
    Object.freeze({
      async authorize() {
        return allowedCurrentPolicyDecision();
      },
      readCurrentVersion(): Promise<never> {
        return Promise.reject(policyFailure);
      },
    }),
  );

  await assert.rejects(
    entry.run({}, () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof RequestRuntimeViewRefusalError);
      assert.equal(error.code, 'ACTIVE_RELEASE_NOT_VISIBLE');
      return true;
    },
  );
});

test('a synchronous policy throw wins before an already-rejected loader is joined', async () => {
  const loaderFailure = new RequestRuntimeViewLoadError(
    'ACTIVE_RELEASE_NOT_VISIBLE',
    'already-rejected loader refusal',
  );
  const policyFailure = new RequestRuntimeViewLoadError(
    'ACTIVE_RELEASE_NOT_ADMITTED',
    'synchronous current-policy failure',
  );
  const loaderRejection = Promise.reject(loaderFailure);
  // Promise.all never receives this promise when policy throws synchronously.
  // Observe it independently so the test does not manufacture an unhandled
  // rejection while preserving its already-rejected state.
  void loaderRejection.catch(() => undefined);
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    runtimeRefusalRequestEntry(),
    Object.freeze({
      load(): Promise<never> {
        return loaderRejection;
      },
    }),
    Object.freeze({
      async authorize() {
        return allowedCurrentPolicyDecision();
      },
      readCurrentVersion(): Promise<never> {
        throw policyFailure;
      },
    }),
  );

  await assert.rejects(
    entry.run({}, () => undefined),
    (error: unknown) => {
      assert.equal(error, policyFailure);
      assert.equal(error instanceof RequestRuntimeViewRefusalError, false);
      return true;
    },
  );
});

test('a pending policy rejection settles without waiting for the loader', async () => {
  const loadedDefinition = await loadedRuntimeDefinitionFixture();
  const definitionLoad = controlledPromise<LoadedRequestRuntimeDefinition>();
  const policyRead =
    controlledPromise<ReturnType<typeof currentPolicyVersionEvidence>>();
  const policyFailure = new RequestRuntimeViewLoadError(
    'ACTIVE_RELEASE_NOT_ADMITTED',
    'pending current-policy failure',
  );
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    runtimeRefusalRequestEntry(),
    Object.freeze({
      load() {
        return definitionLoad.promise;
      },
    }),
    Object.freeze({
      async authorize() {
        return allowedCurrentPolicyDecision();
      },
      readCurrentVersion() {
        return policyRead.promise;
      },
    }),
  );
  const observation = observePromise(entry.run({}, () => undefined));

  policyRead.reject(policyFailure);
  await nextEventLoopTurn();
  try {
    assert.deepEqual(observation.current(), {
      error: policyFailure,
      status: 'rejected',
    });
  } finally {
    definitionLoad.resolve(loadedDefinition);
  }
  await observation.complete;
});

test('a pending loader rejection settles without waiting for current policy', async () => {
  const definitionLoad = controlledPromise<LoadedRequestRuntimeDefinition>();
  const policyRead =
    controlledPromise<ReturnType<typeof currentPolicyVersionEvidence>>();
  const loaderFailure = new RequestRuntimeViewLoadError(
    'ACTIVE_POINTER_MISSING',
    'pending loader refusal',
  );
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    runtimeRefusalRequestEntry(),
    Object.freeze({
      load() {
        return definitionLoad.promise;
      },
    }),
    Object.freeze({
      async authorize() {
        return allowedCurrentPolicyDecision();
      },
      readCurrentVersion() {
        return policyRead.promise;
      },
    }),
  );
  const observation = observePromise(entry.run({}, () => undefined));

  definitionLoad.reject(loaderFailure);
  await nextEventLoopTurn();
  try {
    const outcome = observation.current();
    assert.equal(outcome.status, 'rejected');
    assert.ok(outcome.error instanceof RequestRuntimeViewRefusalError);
    assert.equal(outcome.error.code, 'ACTIVE_POINTER_MISSING');
  } finally {
    policyRead.resolve(currentPolicyVersionEvidence());
  }
  await observation.complete;
});

test('runtime refusal recognition rejects every one-property structural near miss', async () => {
  const validCode = 'ACTIVE_POINTER_MISSING';
  const wrongName = Object.assign(new Error('wrong name'), {
    code: validCode,
  });
  const missingCode = new Error('missing code');
  missingCode.name = 'RequestRuntimeViewLoadError';
  const numericCode = Object.assign(new Error('numeric code'), {
    code: 7,
  });
  numericCode.name = 'RequestRuntimeViewLoadError';
  const unknownCode = Object.assign(new Error('unknown string code'), {
    code: 'RUNTIME_VIEW_CODE_ADDED_WITHOUT_A_RUNTIME_CONTRACT',
  });
  unknownCode.name = 'RequestRuntimeViewLoadError';
  const specimens: ReadonlyArray<{
    readonly failure: unknown;
    readonly name: string;
  }> = [
    {
      failure: Object.freeze({
        code: validCode,
        name: 'RequestRuntimeViewLoadError',
      }),
      name: 'plain object with exact name and valid code',
    },
    { failure: wrongName, name: 'Error with wrong name and valid code' },
    { failure: missingCode, name: 'Error with exact name and missing code' },
    { failure: numericCode, name: 'Error with exact name and numeric code' },
    {
      failure: unknownCode,
      name: 'Error with exact name and unknown string code',
    },
  ];

  for (const specimen of specimens) {
    let policyCalls = 0;
    const entry = new AuthenticatedRequestRuntimeEntryAdapter(
      runtimeRefusalRequestEntry(),
      Object.freeze({
        load(): Promise<never> {
          throw specimen.failure;
        },
      }),
      Object.freeze({
        async authorize() {
          return allowedCurrentPolicyDecision();
        },
        async readCurrentVersion() {
          policyCalls += 1;
          return currentPolicyVersionEvidence();
        },
      }),
    );

    await assert.rejects(
      entry.run({}, () => undefined),
      (error: unknown) => {
        assert.equal(error, specimen.failure, specimen.name);
        assert.equal(
          error instanceof RequestRuntimeViewRefusalError,
          false,
          specimen.name,
        );
        return true;
      },
    );
    assert.equal(policyCalls, 0, specimen.name);

    const server = createSurfaceRuntimeServer(entry);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(baseUrl);
      assert.equal(response.status, 500, specimen.name);
      assertRuntimeViewUnavailable(await response.text(), specimen.name);
      assert.equal(policyCalls, 0, specimen.name);
    } finally {
      await close(server);
    }
  }
});

test('runtime entry translation is confined to loader failures', async () => {
  const loadedDefinition = await loadedRuntimeDefinitionFixture();
  const policyFailure = new RequestRuntimeViewLoadError(
    'ACTIVE_RELEASE_NOT_ADMITTED',
    'current-policy failure with the provider error shape',
  );
  const policyEntry = new AuthenticatedRequestRuntimeEntryAdapter(
    runtimeRefusalRequestEntry(),
    Object.freeze({
      async load() {
        return loadedDefinition;
      },
    }),
    Object.freeze({
      async authorize() {
        return allowedCurrentPolicyDecision();
      },
      readCurrentVersion(): Promise<never> {
        return Promise.reject(policyFailure);
      },
    }),
  );
  await assert.rejects(
    policyEntry.run({}, () => undefined),
    (error: unknown) => {
      assert.equal(error, policyFailure);
      assert.equal(error instanceof RequestRuntimeViewRefusalError, false);
      return true;
    },
  );
  const server = createSurfaceRuntimeServer(policyEntry);
  const baseUrl = await listen(server);
  try {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 500);
    assertRuntimeViewUnavailable(
      await response.text(),
      'provider-shaped current-policy failure',
    );
  } finally {
    await close(server);
  }

  const unitOfWorkFailure = new RequestRuntimeViewLoadError(
    'ACTIVE_RELEASE_NOT_VISIBLE',
    'unit-of-work failure with the provider error shape',
  );
  await assert.rejects(
    demoEntry().run({}, () => {
      throw unitOfWorkFailure;
    }),
    (error: unknown) => {
      assert.equal(error, unitOfWorkFailure);
      assert.equal(error instanceof RequestRuntimeViewRefusalError, false);
      return true;
    },
  );
});

test('an asynchronous unit-of-work rejection retains exact identity', async () => {
  const unitOfWorkFailure = new RequestRuntimeViewLoadError(
    'ACTIVE_RELEASE_NOT_VISIBLE',
    'asynchronous unit-of-work failure with the provider error shape',
  );
  await assert.rejects(
    demoEntry().run({}, () => Promise.reject(unitOfWorkFailure)),
    (error: unknown) => {
      assert.equal(error, unitOfWorkFailure);
      assert.equal(error instanceof RequestRuntimeViewRefusalError, false);
      return true;
    },
  );
});

test('an asynchronous unit-of-work rejection remains unavailable at HTTP', async () => {
  const unitOfWorkFailure = new RequestRuntimeViewLoadError(
    'ACTIVE_RELEASE_NOT_VISIBLE',
    'asynchronous unit-of-work failure with the provider error shape',
  );
  const loadedDefinition = await loadedRuntimeDefinitionFixture();
  class AsyncUnitOfWorkFailureEntry extends AuthenticatedRequestRuntimeEntryAdapter {
    override run<T>(
      request: UntrustedRequestInput,
      unitOfWork: (view: IssuedRequestRuntimeView) => Promise<T> | T,
    ): Promise<T> {
      return super.run(request, async (view) => {
        await unitOfWork(view);
        throw unitOfWorkFailure;
      });
    }
  }
  const httpEntry = new AsyncUnitOfWorkFailureEntry(
    runtimeRefusalRequestEntry(),
    Object.freeze({
      async load() {
        return loadedDefinition;
      },
    }),
    Object.freeze({
      async authorize() {
        return allowedCurrentPolicyDecision();
      },
      async readCurrentVersion() {
        return currentPolicyVersionEvidence();
      },
    }),
  );
  const server = createSurfaceRuntimeServer(httpEntry);
  const baseUrl = await listen(server);
  try {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 500);
    assertRuntimeViewUnavailable(
      await response.text(),
      'provider-shaped asynchronous unit-of-work failure',
    );
  } finally {
    await close(server);
  }
});

test('provider refusals retain known copy and otherwise use an honest code-bearing residual', () => {
  assert.deepEqual(
    operationMessageRef(
      new ModuleRuntimeInterpreterError(
        'MODULE_LEGAL_ENTITY_CREATE_INACTIVE',
        'inactive',
        'legal-entity-42',
      ),
    ),
    {
      code: 'OPERATION_LEGAL_ENTITY_INACTIVE',
      subject: 'legal-entity-42',
    },
  );
  assert.deepEqual(
    operationMessageRef(
      new ModuleRuntimeInterpreterError(
        'MODULE_REQUIRED_FIELD_MISSING',
        'required',
      ),
    ),
    {
      code: 'OPERATION_REFUSED',
      subject: 'MODULE_REQUIRED_FIELD_MISSING',
    },
  );
  assert.deepEqual(
    operationMessageRef(
      new ModuleRuntimeInterpreterError(
        'MODULE_EXTENSION_REFUSAL_ADDED_LATER',
        'extension',
      ),
    ),
    {
      code: 'OPERATION_REFUSED',
      subject: 'MODULE_EXTENSION_REFUSAL_ADDED_LATER',
    },
  );
  assert.deepEqual(operationMessageRef(new Error('failure without identity')), {
    code: 'OPERATION_UNAVAILABLE',
  });
});

test('closed registry returns diagnostics for unknown and failing components', async () => {
  assert.deepEqual(SURFACE_SLOT_RESOLUTION_STATES, [
    'pending',
    'ready',
    'empty',
    'failed',
  ]);
  assert.equal(Object.isFrozen(SURFACE_SLOT_RESOLUTION_STATES), true);
  assert.equal(Object.isFrozen(REGISTERED_SURFACE_COMPONENT_IDS), true);
  assert.deepEqual(REGISTERED_SURFACE_COMPONENT_IDS, [
    'northstar.shell:component.error_probe',
    'northstar.shell:component.release_summary',
    'northstar.shell:component.setup_checklist',
  ]);

  await demoEntry().run({}, (view) => {
    const surfaces = readCompiledSurfaceManifest(view).surfaces;
    const unsupported = surfaces.find(
      (surface) => surface.label === 'Unsupported component',
    );
    const failing = surfaces.find(
      (surface) => surface.label === 'Renderer error',
    );
    assert.ok(unsupported?.slots[0]);
    assert.ok(failing?.slots[0]);
    assert.equal(surfaceHasUnsupportedComponent(unsupported), true);
    assert.equal(surfaceHasUnsupportedComponent(failing), false);
    for (const unsupportedSlot of ['activity', 'childTables'] as const) {
      const formWithUnsupportedNonMutationSlot: typeof unsupported = {
        ...unsupported,
        archetype: 'record' as const,
        slots: [
          { ...unsupported.slots[0], slot: 'sections' as const },
          { ...unsupported.slots[0], slot: unsupportedSlot },
        ],
        surfaceRole: 'form' as const,
      };
      assert.equal(
        surfaceHasUnsupportedComponent(formWithUnsupportedNonMutationSlot),
        true,
        unsupportedSlot,
      );
      assert.equal(
        surfaceSupportsRuntimeIntent(
          view,
          formWithUnsupportedNonMutationSlot,
          [],
          'create',
        ),
        true,
        unsupportedSlot,
      );
      const compiledUnsupportedSlot =
        formWithUnsupportedNonMutationSlot.slots[1];
      assert.ok(compiledUnsupportedSlot);
      const result = renderRegisteredSurfaceComponent({
        slot: compiledUnsupportedSlot,
        surface: formWithUnsupportedNonMutationSlot,
        view,
      });
      assert.equal(result.state, 'failed', unsupportedSlot);
      assert.match(result.html, /data-slot-state="failed"/u, unsupportedSlot);
      assert.match(result.html, /UNSUPPORTED_COMPONENT/u, unsupportedSlot);
    }
    const unsupportedResult = renderRegisteredSurfaceComponent({
      slot: unsupported.slots[0],
      surface: unsupported,
      view,
    });
    const failingResult = renderRegisteredSurfaceComponent({
      slot: failing.slots[0],
      surface: failing,
      view,
    });
    assert.equal(unsupportedResult.state, 'failed');
    assert.match(unsupportedResult.html, /data-slot-state="failed"/);
    assert.match(unsupportedResult.html, /UNSUPPORTED_COMPONENT/);
    assert.equal(failingResult.state, 'failed');
    assert.match(failingResult.html, /data-slot-state="failed"/);
    assert.match(failingResult.html, /COMPONENT_RENDER_FAILED/);
  });
});

test('unbound slots authorize no default loading treatment', async () => {
  await demoEntry().run({}, (view) => {
    const exemplar = readCompiledSurfaceManifest(view).surfaces[0];
    assert.ok(exemplar?.slots[0]);
    const dataGrid = {
      ...exemplar.slots[0],
      slot: 'dataGrid',
    };
    const surface = {
      ...exemplar,
      archetype: 'list' as const,
      slots: [dataGrid],
      surfaceRole: 'list' as const,
    };
    const result = renderRegisteredSurfaceComponent({
      data: { status: 'UNBOUND' },
      slot: dataGrid,
      surface,
      view,
    });
    assert.equal(result.state, 'pending');
    assert.match(result.html, /data-slot-state="pending"/);
    assert.doesNotMatch(result.html, /spinner|skeleton|loading/i);

    const titleStatus = {
      ...exemplar.slots[0],
      slot: 'titleStatus',
    };
    const recordSurface = {
      ...exemplar,
      archetype: 'record' as const,
      slots: [titleStatus],
      statusRoles: [],
      surfaceRole: 'record' as const,
    };
    const titleResult = renderRegisteredSurfaceComponent({
      data: { status: 'UNBOUND' },
      slot: titleStatus,
      surface: recordSurface,
      view,
    });
    assert.equal(titleResult.state, 'ready');
    assert.match(titleResult.html, /data-slot-state="ready"/);
    assert.doesNotMatch(titleResult.html, /spinner|skeleton|loading/i);
  });
});

test('inherited object names cannot execute as unregistered components', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'g1-p7-registry-'));
  try {
    const fixture = JSON.parse(
      readFileSync(compiledFixturePath, 'utf8'),
    ) as Record<string, unknown>;
    const surface = projectionRecord(fixture, 'surface');
    const payload = record(surface.payload);
    const firstSurface = arrayOfRecords(payload.surfaces)[0];
    assert.ok(firstSurface);
    const firstSlot = arrayOfRecords(firstSurface.slots)[0];
    assert.ok(firstSlot);
    firstSlot.contentReferenceId = 'constructor';
    const inheritedNamePath = join(temporaryDirectory, 'inherited-name.json');
    writeFileSync(inheritedNamePath, JSON.stringify(fixture));

    await demoEntry(inheritedNamePath).run({}, (view) => {
      const result = renderSurfaceRuntime(view, '/');
      assert.equal(result.statusCode, 200);
      assert.match(result.html, /UNSUPPORTED_COMPONENT/);
      assert.doesNotMatch(result.html, /\[object Object\]/);
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test('unknown surface and malformed projection fail as rendered diagnostics', async () => {
  await demoEntry().run({}, (view) => {
    const unknown = renderSurfaceRuntime(view, '/?surface=not-in-release');
    assert.equal(unknown.statusCode, 404);
    assert.match(unknown.html, /UNKNOWN_SURFACE/);
  });

  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'g1-p7-surface-'));
  try {
    const fixture = JSON.parse(
      readFileSync(compiledFixturePath, 'utf8'),
    ) as Record<string, unknown>;
    const surface = projectionRecord(fixture, 'surface');
    const payload = record(surface.payload);
    payload.schemaVersion = 'northstar.surface-manifest-payload/unsupported';
    const malformedPath = join(temporaryDirectory, 'malformed.json');
    writeFileSync(malformedPath, JSON.stringify(fixture));
    await demoEntry(malformedPath).run({}, (view) => {
      const malformed = renderSurfaceRuntime(view, '/');
      assert.equal(malformed.statusCode, 422);
      assert.match(malformed.html, /INVALID_SURFACE_MANIFEST/);
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

/**
 * ADR-0048 §§2-4. Every claim the catalog makes about itself, asserted rather
 * than commented.
 */
test('the message catalog honours the vocabulary it declares', () => {
  assert.equal(Object.isFrozen(SURFACE_MESSAGE_CATALOG), true);
  // 27 -> 28 with `ux-picker`'s `INVALID_SURFACE_FIELD`, 29 with
  // `form-wire-semantics`' `OPERATION_INPUT_INVALID`, then 30 with the scoped
  // create operand's subject-bearing inactive-legal-entity refusal, then 31
  // with the relation-id-bearing incomplete-enumeration refusal, then 33 with
  // the code-bearing provider and runtime-view refusals. The count
  // is pinned so
  // registering a code is a deliberate, visible edit; moving it is the intended
  // cost of adding one, not a symptom.
  assert.equal(SURFACE_MESSAGE_CODES.length, 33);

  for (const code of SURFACE_MESSAGE_CODES) {
    const entry = SURFACE_MESSAGE_CATALOG[code];
    const where = `${code}: `;
    assert.ok(entry.sentence.length > 0, `${where}empty sentence`);
    assert.ok(entry.detail.length > 0, `${where}empty detail`);

    // A sentence is a headline, not a paragraph, and never a template.
    assert.doesNotMatch(
      entry.sentence,
      /[.]$/u,
      `${where}sentence ends in a period`,
    );
    for (const field of [
      entry.sentence,
      entry.detail,
      entry.nextAction ?? '',
    ]) {
      assert.doesNotMatch(field, /\$\{|%s|\{\d?\}/u, `${where}template hole`);
    }

    // §3: colour resolves through the pinned roles and adds no hue.
    assert.ok(
      (STATUS_ROLES as readonly string[]).includes(messageStatusRole(code)),
      `${where}status role is outside the pinned vocabulary`,
    );

    // §4: admissible placements, and the two refused spellings never appear.
    assert.ok(entry.placements.length > 0, `${where}no admissible placement`);
    for (const placement of entry.placements) {
      assert.ok(
        (MESSAGE_PLACEMENTS as readonly string[]).includes(placement),
        `${where}unknown placement ${placement}`,
      );
      assert.equal(
        (REFUSED_MESSAGE_PLACEMENTS as readonly string[]).includes(placement),
        false,
        `${where}refused placement ${placement}`,
      );
    }

    // An advisory message claims the user can act now, so it owes an action.
    // The converse does not hold: a blocking message may still offer one.
    if (entry.consequence === 'advisory') {
      assert.notEqual(
        entry.nextAction,
        null,
        `${where}advisory with no action`,
      );
    }
  }

  for (const code of QUERY_DIAGNOSTIC_CODES) {
    assert.ok(SURFACE_MESSAGE_CATALOG[code].placements.includes('slot'));
  }
  for (const code of OPERATION_DIAGNOSTIC_CODES) {
    assert.ok(SURFACE_MESSAGE_CATALOG[code].placements.includes('page'));
  }
});

/**
 * The structural companion ADR-0048 §5 asks for, in the shape this file already
 * uses for compiled navigation labels at the top: a sentence that reached the
 * user must have come from the catalog, so no other source file may contain one.
 *
 * This is a **source scan, and therefore a proxy** — it observes that the string
 * is not written elsewhere, not that the renderer read it from here. The browser
 * gate observes the latter. Neither is sufficient alone: the scan cannot see a
 * sentence composed at runtime, and the browser gate cannot see a hardcoded
 * sentence on a path no fixture drives.
 */
test('no user-facing sentence is written outside the catalog', () => {
  const sources = [
    'app-server.ts',
    'component-registry.ts',
    'demo-runtime.ts',
    'html.ts',
    'list-runtime.ts',
    'message-render.ts',
    'surface-contract.ts',
    'surface-runtime.ts',
  ];
  const contents = new Map(
    sources.map((name) => [
      name,
      readFileSync(`${webRoot}/src/${name}`, 'utf8'),
    ]),
  );

  for (const code of SURFACE_MESSAGE_CODES) {
    const entry = SURFACE_MESSAGE_CATALOG[code];
    for (const copy of [entry.sentence, entry.detail, entry.nextAction ?? '']) {
      if (copy === '') continue;
      const offenders = sources.filter((name) =>
        contents.get(name)!.includes(copy),
      );
      assert.deepEqual(
        offenders,
        [],
        `${code}: "${copy}" is written in ${offenders.join(', ')} as well as the catalog`,
      );
    }
  }
});

/**
 * ADR-0048 §2's *registered but never raised* direction, which `keyof typeof`
 * does not close. A code with no raise site is an entry the user can never see,
 * and it would sit in the catalog looking exactly like a working one.
 *
 * A source-literal scan is a proxy for reachability; the browser gate's 15
 * real-path drivers are the observation. The two are reported separately rather
 * than as one number.
 */
test('every registered code has a raise site outside the catalog', () => {
  const sources = [
    'app-server.ts',
    'component-registry.ts',
    'gateway-error-codes.ts',
    'surface-contract.ts',
    'surface-runtime.ts',
  ].map((name) =>
    stripComments(readFileSync(`${webRoot}/src/${name}`, 'utf8')),
  );

  const unraised = SURFACE_MESSAGE_CODES.filter(
    (code) => !sources.some((source) => source.includes(`'${code}'`)),
  );
  assert.deepEqual(unraised, []);
});

test('raise-site red: a code named only in a comment does not count as raised', () => {
  const commented = stripComments(
    `// UNKNOWN_SURFACE lives here\n/* 'NO_ACTIVE_SURFACE' too */\nconst x = 'ROUTE_NOT_FOUND';\n`,
  );
  assert.equal(commented.includes(`'NO_ACTIVE_SURFACE'`), false);
  assert.equal(commented.includes('UNKNOWN_SURFACE'), false);
  assert.equal(commented.includes(`'ROUTE_NOT_FOUND'`), true);
});

/**
 * **What this scan cannot prove, stated rather than implied** (AGENTS.md §6).
 * Stripping comments closes the commented-out hole outright. It does **not**
 * close the dead-branch hole: a code named in unreachable code would still
 * count as raised. The 15 executed real-path drivers are the observation; this
 * is the proxy that covers the rest.
 */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/\/\/[^\n]*/gu, '');
}

/**
 * The half `Record<union, …>` exhaustiveness cannot reach: a gateway error class
 * added in `packages/runtime` cannot fail a compile in `apps/web`. This reads
 * the loaded module objects and compares their actual exported error classes
 * against the mapping's declared names — an observation of the module, not a
 * parse of its source.
 */
test('the gateway error mapping covers every error class the gateways export', () => {
  /**
   * **Runtime `.name`, not the export key.** Dispatch reads `error.name`
   * (`gateway-error-codes.ts`), and `name` is an instance field rather than a
   * prototype property, so it can only be read by constructing one. Comparing
   * export keys let a class exported as `FooError` carrying
   * `name = 'BarError'` satisfy this test and fall through to the residual at
   * runtime. Not a live misclassification — the invariant was the weak part.
   *
   * Construction is attempted with progressively wider stub arguments and a
   * failure is **reported**, never skipped: a class this cannot instantiate is
   * a class whose dispatch name is unverified.
   */
  assert.deepEqual(
    [
      ...instanceNames(queryGateway),
      ...instanceNames(listBehavior),
      ...instanceNames(resolveByName),
    ].sort(),
    [...MAPPED_QUERY_ERROR_NAMES].sort(),
  );
  assert.deepEqual(
    instanceNames(operationGateway),
    [...MAPPED_OPERATION_ERROR_NAMES].sort(),
  );
});

/**
 * The vector this closes cannot be produced from the tree: it needs an error
 * class whose export key and runtime `name` disagree, and every such class
 * lives in `packages/runtime`, outside this packet's lease. So the red is
 * in-process against a synthetic module, the same way
 * `surface-grammar-conformance.test.ts` perturbs a fixture rather than the
 * product. What it demonstrates is exact: the comparison that shipped in round
 * one would have accepted this module, and this one does not.
 */
test('mapping red: an export key and a runtime name that disagree are observed', () => {
  const misnamed = {
    FooError: class extends Error {
      override readonly name = 'BarError';
    },
  };
  assert.deepEqual(Object.keys(misnamed), ['FooError']);
  assert.deepEqual(instanceNames(misnamed), ['BarError']);

  const unconstructible = {
    HostileError: class extends Error {
      constructor() {
        super();
        throw new TypeError('refuses every argument list');
      }
    },
  };
  assert.throws(
    () => instanceNames(unconstructible),
    /could not be constructed, so its dispatch name is unverified/,
  );
});

/** Runtime `.name` is an instance field, so reading it means constructing one. */
function instanceNames(namespace: Readonly<Record<string, unknown>>): string[] {
  {
    const stub = {
      release: { contentHash: 'stub', releaseId: 'stub' },
    } as never;
    return Object.entries(namespace)
      .filter(
        ([, value]) =>
          typeof value === 'function' &&
          (value as { prototype?: unknown }).prototype instanceof Error,
      )
      .map(([exportKey, value]) => {
        const Constructor = value as new (...args: never[]) => Error;
        for (const argumentList of [
          [],
          ['stub'],
          ['stub', stub],
          ['stub', stub, stub],
        ]) {
          try {
            const instance = new Constructor(...(argumentList as never[]));
            assert.equal(
              typeof instance.name,
              'string',
              `${exportKey} has no runtime name`,
            );
            return instance.name;
          } catch {
            continue;
          }
        }
        assert.fail(
          `${exportKey} could not be constructed, so its dispatch name is unverified`,
        );
      })
      .sort();
  }
}

/**
 * ADR-0048 §5's last control, made structural: a gate that asked the renderer
 * what it should have rendered would agree with itself no matter what either
 * one did.
 */
test('the rendered-text gate never obtains its expected string from the renderer', () => {
  // Comments are stripped first: the gate's own header explains which helpers
  // it abstains from, and a scan that read prose would fail on the explanation
  // rather than on the behaviour.
  const gate = stripComments(
    readFileSync(`${webRoot}/test/browser/message-catalog.spec.ts`, 'utf8'),
  );
  for (const forbidden of [
    'messageBody',
    'messageAttributes',
    'surfaceMessage',
    'messageStatusRole',
    'message-render',
  ]) {
    assert.equal(
      gate.includes(forbidden),
      false,
      `the gate imports or calls ${forbidden}`,
    );
  }
  assert.ok(gate.includes('SURFACE_MESSAGE_CATALOG'));
});

/**
 * `INTENT_RENDERED_ARITY` decides which intents still refuse a second
 * operation, so it is the one place a lifted limit could quietly become a
 * lifted-for-everything limit. The browser gate observes the refusal firing;
 * this pins the arity that produces it, and each entry is asserted against the
 * renderer it claims as its authority. A new intent added without a rendering
 * decision fails on the key list.
 */
test('only the intent with a control per operation admits more than one', () => {
  assert.equal(Object.isFrozen(INTENT_RENDERED_ARITY), true);
  assert.deepEqual(Object.keys(INTENT_RENDERED_ARITY).sort(), [
    'archive',
    'command',
    'create',
    'restore',
    'update',
  ]);

  // One Save button per form surface; one lifecycle button per archived state.
  for (const intent of ['archive', 'create', 'restore', 'update'] as const) {
    assert.equal(INTENT_RENDERED_ARITY[intent], 1, `${intent} is not singular`);
  }
  // One named button per command, which is the whole reason the limit lifted.
  assert.equal(INTENT_RENDERED_ARITY.command, Number.POSITIVE_INFINITY);

  // The renderers those arities name as their authority. A `find` restored in
  // the command bar would re-impose the limit while this table still said it
  // had lifted -- drift the browser gate reads as a fixture problem, not a
  // product one. This is a SOURCE SCAN and therefore a proxy; the browser gate
  // observes the two controls actually rendering.
  const registry = readFileSync(`${webRoot}/src/component-registry.ts`, 'utf8');
  assert.match(
    registry,
    /const commands = record\s*\?\s*\(context\.operations \?\? \[\]\)\.filter\(/u,
  );
  assert.match(registry, /const intent = record \? 'update' : 'create';/u);
  assert.match(
    registry,
    /const intent = record\.archived \? 'restore' : 'archive';/u,
  );
});

/**
 * AGENTS.md §6's vacuity vectors for the check above, both run in-process
 * against copies because the product cannot hold either shape and stay green:
 * a table gone permissive, and a proxy satisfied while the fact does not hold.
 */
test('arity red: a permissive table and a re-imposed find are both observed', () => {
  const permissive: Readonly<Record<string, number>> = Object.freeze({
    ...INTENT_RENDERED_ARITY,
    create: Number.POSITIVE_INFINITY,
  });
  assert.throws(() => {
    for (const intent of ['archive', 'create', 'restore', 'update']) {
      assert.equal(permissive[intent], 1, `${intent} is not singular`);
    }
  }, /create is not singular/u);

  const reImposed =
    'const commands = record ? (context.operations ?? []).find(';
  assert.doesNotMatch(
    reImposed,
    /const commands = record\s*\?\s*\(context\.operations \?\? \[\]\)\.filter\(/u,
  );
});

function runtimeRefusalRequestEntry(): AuthenticatedRequestEntryAdapter {
  return new AuthenticatedRequestEntryAdapter(async () => ({
    environmentId: '20000000-0000-4000-8000-000000000002',
    principalId: '40000000-0000-4000-8000-000000000004',
    tenantId: '10000000-0000-4000-8000-000000000001',
  }));
}

function allowedCurrentPolicyDecision() {
  return Object.freeze({
    decision: 'ALLOW' as const,
    decisionVersion: 'northstar.current-policy-decision/v1' as const,
    policyVersion: 'runtime-view-refusal-gate-v1',
  });
}

function currentPolicyVersionEvidence() {
  return Object.freeze({
    policyVersion: 'runtime-view-refusal-gate-v1',
  });
}

function controlledPromise<T>(): Readonly<{
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}> {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle, refuse) => {
    resolve = settle;
    reject = refuse;
  });
  return Object.freeze({ promise, reject, resolve });
}

function observePromise<T>(promise: Promise<T>): Readonly<{
  complete: Promise<void>;
  current: () =>
    | Readonly<{ status: 'pending' }>
    | Readonly<{ error: unknown; status: 'rejected' }>
    | Readonly<{ status: 'fulfilled'; value: T }>;
}> {
  let outcome:
    | Readonly<{ status: 'pending' }>
    | Readonly<{ error: unknown; status: 'rejected' }>
    | Readonly<{ status: 'fulfilled'; value: T }> = Object.freeze({
    status: 'pending',
  });
  const complete = promise.then(
    (value) => {
      outcome = Object.freeze({ status: 'fulfilled', value });
    },
    (error: unknown) => {
      outcome = Object.freeze({ error, status: 'rejected' });
    },
  );
  return Object.freeze({
    complete,
    current: () => outcome,
  });
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function loadedRuntimeDefinitionFixture(): Promise<LoadedRequestRuntimeDefinition> {
  const view = await demoEntry().run({}, (issued) => issued);
  return Object.freeze({
    environmentId: view.environmentId,
    pointer: view.pointer,
    projections: view.projections,
    release: view.release,
    tenantId: view.tenantId,
  });
}

function assertRuntimeViewUnavailable(html: string, specimen: string): void {
  assert.match(
    html,
    /data-message="REQUEST_RUNTIME_VIEW_UNAVAILABLE"/u,
    specimen,
  );
  assert.match(
    html,
    /data-diagnostic-code="REQUEST_RUNTIME_VIEW_UNAVAILABLE"/u,
    specimen,
  );
  assert.match(html, /data-status-role="blocked"/u, specimen);
  assert.match(
    html,
    /<h1 data-message-sentence>Application shell unavailable<\/h1>/u,
    specimen,
  );
  assert.match(
    html,
    /<code data-message-code>REQUEST_RUNTIME_VIEW_UNAVAILABLE<\/code>/u,
    specimen,
  );
  assert.doesNotMatch(html, /data-message-subject/u, specimen);
  assert.doesNotMatch(html, /REQUEST_RUNTIME_VIEW_REFUSED/u, specimen);
}

function projectionRecord(
  fixture: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  return record(record(fixture.projections)[name]);
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
