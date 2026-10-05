import { governedProjection } from '../../../test/helpers/governed-storage-target.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  SURFACE_CLIENT_CSP_HASH,
  SURFACE_CLIENT_SCRIPT,
} from '../src/surface-client.js';

import {
  STATUS_ROLES,
  SurfaceCompositionSchema,
  SurfaceDocumentEditorSchema,
  SurfaceListSchema,
} from '@north-star/canonical-model';
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
import { composedApplicationDefinition } from '../../../packages/domain/src/app/builder.js';
import {
  declaredCellText,
  declaredListArguments,
  declaredListCsv,
  declaredRowAction,
  figureBandLabel,
  overdueDays,
  readDeclaredListState,
  shortMarked,
  startOfTodayUtc,
  viewNeedsProgress,
  viewNeedsSupply,
  withheldProgressQuery,
  withheldSupplyQuery,
} from '../src/list-declaration.js';
import { renderSurfaceRuntime } from '../src/surface-runtime.js';
import {
  INTENT_RENDERED_ARITY,
  readCompiledSurfaceManifest,
  type CompiledSurfaceDefinition,
} from '../src/surface-contract.js';
import {
  compositionProgressionStates,
  renderCompositionAlerts,
  renderCompositionChildren,
  renderCompositionHeader,
  renderCompositionProgression,
  type CompositionData,
} from '../src/surface-composition.js';
import {
  renderLauncherAction,
  renderLauncherScan,
  renderLauncherTiles,
  type LauncherRenderData,
} from '../src/surface-launcher.js';
import { entryCompanyChoice } from '../src/workspace-entry.js';
import { createValuesFor } from '../src/document-editor.js';
import { compiledFixturePath, demoEntry, webRoot } from './helpers.js';

const APP_SERVER_RUNTIME_VIEW_REFUSAL_IMPORT =
  "import { RequestRuntimeViewRefusalError } from '@north-star/runtime/request-runtime-view';\n";

test('script-free pages retain a CSP that exactly pins the owned Task enhancement', async () => {
  const server = createSurfaceRuntimeServer(demoEntry());
  const baseUrl = await listen(server);
  try {
    const response = await fetch(baseUrl);
    const html = await response.text();
    assert.doesNotMatch(html, /<script\b/u);
    const assertPinned = (document: string, csp: string) => {
      const scripts = [
        ...document.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
      ];
      assert.equal(scripts.length, 1);
      const hash = `sha256-${createHash('sha256').update(scripts[0]![1]!).digest('base64')}`;
      assert.equal(csp.match(/script-src ([^;]+)/)?.[1], `'${hash}'`);
      assert.equal(hash, SURFACE_CLIENT_CSP_HASH);
    };
    const csp = response.headers.get('content-security-policy')!;
    const enhanced = html.replace(
      '</body>',
      `<script>${SURFACE_CLIENT_SCRIPT}</script></body>`,
    );
    assertPinned(enhanced, csp);
    assert.throws(() =>
      assertPinned(
        enhanced.replace('</body>', '<script>void 0</script></body>'),
        csp,
      ),
    );
    assert.throws(() =>
      assertPinned(
        enhanced.replace(
          '</body>',
          '<script src="/unexpected.js"></script></body>',
        ),
        csp,
      ),
    );
    assert.throws(() =>
      assertPinned(enhanced.replace('<script>', '<script>void 0;'), csp),
    );
    assert.throws(() =>
      assertPinned(
        enhanced,
        csp.replace(SURFACE_CLIENT_CSP_HASH, 'sha256-forged'),
      ),
    );
    assert.deepEqual(REFUSED_MESSAGE_PLACEMENTS, ['modal', 'toast']);
  } finally {
    await close(server);
  }
});

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

/**
 * PURCHASING-PARITY: a declared List's "before today" is made from the
 * request's injected clock, never compiled in. The shared List runtime knows
 * no surface, so a synthetic declaration stands in for Expected receipts.
 */
test('a declared List sends before-today as the injected day, keeps each tab open filter and marks the same rows late', () => {
  const ns = 'northstar.fixture';
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const released = id('state', 'order_released');
  const state = id('field', 'order_state');
  const expected = id('field', 'order_expected_date');
  const output = (local: string) => id('list_output', `worklist_${local}`);
  const ref = (targetId: string) => ({
    kind: 'queryReference',
    schemaVersion: 'v6',
    targetId,
  });
  const list = SurfaceListSchema.parse({
    kind: 'surfaceList',
    schemaVersion: 'v6',
    pageSize: 2,
    columns: [
      {
        columnId: id('list_column', 'worklist_number'),
        label: 'Number',
        orderKey: 10,
        field: id('field', 'order_number'),
        role: 'title',
        priority: 0,
        sortable: true,
      },
      {
        columnId: id('list_column', 'worklist_expected'),
        label: 'Expected',
        orderKey: 20,
        field: expected,
        role: 'value',
        priority: 1,
        sortable: true,
        format: 'date',
        overdue: { view: id('list_view', 'worklist_late') },
      },
      ...(['ordered', 'received', 'open'] as const).map((local, index) => ({
        columnId: id('list_column', `worklist_${local}`),
        label: local,
        orderKey: 30 + index * 10,
        field: output(local),
        role: 'value',
        priority: 2 + index,
        sortable: false,
      })),
    ],
    defaultSort: [
      {
        columnId: id('list_column', 'worklist_expected'),
        direction: 'ascending',
      },
    ],
    views: [
      {
        viewId: id('list_view', 'worklist_open'),
        label: 'To receive',
        orderKey: 10,
        filters: [{ field: state, value: released }],
        open: true,
      },
      {
        viewId: id('list_view', 'worklist_late'),
        label: 'Late',
        orderKey: 20,
        filters: [{ field: state, value: released }],
        open: true,
        before: { field: expected, anchor: 'startOfTodayUtc' },
      },
      {
        viewId: id('list_view', 'worklist_all'),
        label: 'All',
        orderKey: 30,
        filters: [{ field: state, value: released }],
      },
    ],
    filters: [],
    export: { format: 'csv' },
    progress: {
      lines: {
        query: ref(id('query', 'order_line_list')),
        relation: id('relation', 'order_line_order'),
        quantity: id('field', 'order_line_quantity'),
      },
      done: {
        query: ref(id('query', 'order_received_list')),
        relation: id('relation', 'order_received_line'),
        quantity: id('field', 'order_received_quantity'),
      },
      openIn: { field: state, values: [released] },
      outputs: {
        ordered: output('ordered'),
        done: output('received'),
        open: output('open'),
      },
    },
  });
  const queryId = id('query', 'worklist');
  // One second before midnight UTC: still the 29th, whatever the host zone.
  const now = new Date('2026-09-29T23:59:59.999Z');
  assert.equal(startOfTodayUtc(now).toISOString(), '2026-09-29T00:00:00.000Z');
  const late = readDeclaredListState(
    list,
    new URL(
      `http://list.local/?view=${encodeURIComponent(id('list_view', 'worklist_late'))}&page=2`,
    ),
  );
  type Sent = {
    list: {
      cursor: string | null;
      beforeFilters?: unknown;
      progress?: { openOnly?: true; outputs: unknown };
    };
  };
  const sent = (
    options: Partial<Parameters<typeof declaredListArguments>[2]>,
  ) =>
    declaredListArguments(list, late, {
      mode: 'page',
      now,
      queryId,
      scopeArguments: {},
      ...options,
    }) as unknown as Sent;
  const page = sent({ pageOffset: 2 });
  assert.deepEqual(page.list.beforeFilters, [
    { before: '2026-09-29T00:00:00.000Z', fieldId: expected },
  ]);
  assert.equal(page.list.progress?.openOnly, true);
  // The page-2 cursor is the gateway's own: it decodes for this day and shape
  // and for no other.
  const parse = (value: Sent) =>
    listBehavior.parseSharedListArguments(
      value as unknown as Parameters<
        typeof listBehavior.parseSharedListArguments
      >[0],
      { declaredParameterIds: [], maximumResultCount: 100, queryId },
    );
  assert.equal(parse(page)?.pageOffset, 2);
  const tomorrow = sent({
    now: new Date('2026-09-30T00:00:00.000Z'),
    pageOffset: 2,
  });
  assert.throws(
    () =>
      parse({
        list: { ...tomorrow.list, cursor: page.list.cursor },
      }),
    (error: unknown) =>
      error instanceof listBehavior.SharedListContractError &&
      error.code === 'LIST_CURSOR_INVALID',
  );
  // Each tab is counted with its own filters and the same clock.
  const count = (local: string) =>
    sent({ mode: 'count', viewId: id('list_view', `worklist_${local}`) }).list;
  assert.equal(count('open').progress?.openOnly, true);
  assert.equal(count('open').beforeFilters, undefined);
  assert.deepEqual(count('late').beforeFilters, page.list.beforeFilters);
  assert.equal(count('all').progress?.openOnly, undefined);
  assert.deepEqual(count('all').progress?.outputs, {
    done: output('received'),
    open: output('open'),
    ordered: output('ordered'),
  });

  // "N days late" judges the Late view's conditions on the row's own values.
  const column = list.columns.find((value) => value.overdue)!;
  const row = (values: Record<string, string | null>) => ({
    archived: false,
    entityId: id('entity', 'order'),
    recordId: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    values: {
      [state]: released,
      [expected]: '2026-09-25T12:00:00.000Z',
      [output('ordered')]: '15',
      [output('received')]: '4',
      [output('open')]: '11',
      ...values,
    },
  });
  assert.equal(overdueDays(list, column, row({}), now), 4);
  assert.equal(
    overdueDays(
      list,
      column,
      row({ [expected]: '2026-09-28T23:59:59.999Z' }),
      now,
    ),
    1,
  );
  for (const values of [
    { [expected]: '2026-09-29T00:00:00.000Z' },
    { [expected]: null },
    { [output('open')]: '0' },
    { [output('open')]: '0.000' },
    { [state]: id('state', 'order_closed') },
  ])
    assert.equal(overdueDays(list, column, row(values), now), null);

  // The export keeps the summed figures as the exact decimals they are.
  const csv = declaredListCsv(
    list,
    [row({ [id('field', 'order_number')]: 'PO-1', [output('open')]: '10.5' })],
    (_record, _fieldId, value) => String(value),
  );
  assert.equal(
    csv,
    '\uFEFFNumber,Expected,ordered,received,open\r\nPO-1,2026-09-25T12:00:00.000Z,15,4,10.5\r\n',
  );
});

/**
 * REPLENISHMENT: Stock by item, as the product declares it, sends its figures
 * with every page, count and export request -- a tab's band as `keep` -- the
 * gateway's own contract parses them and binds them into the cursor, and a
 * band's value is shown and exported as the label the List declares.
 */
test('a declared List sends its figures with every request, keeps each tab band and shows a band by its label', () => {
  const ns = 'northstar.app';
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const surface = (
    composedApplicationDefinition().surfaces as Array<Record<string, unknown>>
  ).find((value) => value.surfaceId === id('surface', 'item_stock_list'))!;
  const list = SurfaceListSchema.parse(surface.list);
  const queryId = id('query', 'item_stock_list');
  const now = new Date('2026-10-04T12:00:00.000Z');
  const status = id('list_figure', 'item_stock_list_status');
  const band = (local: string) => id('list_band', `item_stock_list_${local}`);
  const view = (local: string) => id('list_view', `item_stock_list_${local}`);
  type Sent = {
    list: {
      cursor: string | null;
      figures?: {
        keep?: { figureId: string; values: string[] };
        sums: Array<{
          figureId: string;
          sum: string;
          within?: Record<string, unknown>;
        }>;
        bands?: Array<{ figureId: string; otherwise: string }>;
      };
    };
  };
  const sent = (
    state: ReturnType<typeof readDeclaredListState>,
    options: Partial<Parameters<typeof declaredListArguments>[2]> = {},
  ) =>
    declaredListArguments(list, state, {
      mode: 'page',
      now,
      queryId,
      scopeArguments: {},
      ...options,
    }) as unknown as Sent;
  const state = (local?: string) =>
    readDeclaredListState(
      list,
      new URL(
        `http://list.local/?${local ? `view=${encodeURIComponent(view(local))}&` : ''}page=2`,
      ),
    );
  // Every request carries the declaration's figures, labels left out.
  const all = sent(state(), { pageOffset: 50 });
  assert.deepEqual(
    all.list.figures?.sums.map((value) => value.sum),
    ['rows', 'rows', 'related', 'related', 'remaining', 'remaining'],
  );
  // LOCATIONS: Usable and what reservations hold at usable locations reach
  // their location through the id the rows hold, not a relation.
  const usableSum = all.list.figures?.sums.find(
    (value) => value.figureId === id('list_figure', 'item_stock_list_usable'),
  );
  assert.deepEqual(usableSum?.within, {
    fieldId: id('field', 'location_status'),
    queryId: id('query', 'location_list'),
    referenceFieldId: id('field', 'posted_stock_balance_location_id'),
    values: [id('option', 'location_status_usable')],
  });
  assert.equal(all.list.figures?.keep, undefined);
  assert.equal(all.list.figures?.bands?.[0]?.otherwise, band('healthy'));
  assert.doesNotMatch(JSON.stringify(all.list.figures), /"label"/u);
  // A tab keeps its band, for the page and for its count alike.
  const shortage = sent(state('shortage'), { pageOffset: 50 });
  assert.deepEqual(shortage.list.figures?.keep, {
    figureId: status,
    values: [band('shortage')],
  });
  assert.deepEqual(
    sent(state(), { mode: 'count', viewId: view('reorder') }).list.figures
      ?.keep,
    { figureId: status, values: [band('reorder')] },
  );
  // The gateway's contract reads them back, and the page-2 cursor of one
  // tab decodes for that tab and for no other.
  const parse = (value: Sent) =>
    listBehavior.parseSharedListArguments(
      value as unknown as Parameters<
        typeof listBehavior.parseSharedListArguments
      >[0],
      {
        declaredParameterIds: [],
        exportMaximumResultCount: 5000,
        maximumResultCount: 100,
        queryId,
      },
    );
  assert.deepEqual(parse(shortage)?.figures?.keep, {
    figureId: status,
    values: [band('shortage')],
  });
  assert.deepEqual(
    parse(all)?.figures?.sums.find(
      (value) => value.figureId === usableSum?.figureId,
    )?.within,
    usableSum?.within,
  );
  // A parent through a relation and a reference field at once, or through
  // neither, never reaches a statement.
  for (const within of [
    { ...usableSum!.within, relationId: id('relation', 'any') },
    Object.fromEntries(
      Object.entries(usableSum!.within!).filter(
        ([key]) => key !== 'referenceFieldId',
      ),
    ),
  ])
    assert.throws(
      () =>
        parse({
          list: {
            ...all.list,
            cursor: null,
            figures: {
              ...all.list.figures!,
              sums: all.list.figures!.sums.map((value) =>
                value === usableSum ? { ...value, within } : value,
              ),
            },
          },
        }),
      (error: unknown) =>
        error instanceof listBehavior.SharedListContractError &&
        error.code === 'LIST_INPUT_MALFORMED',
    );
  assert.equal(parse(shortage)?.pageOffset, 50);
  assert.throws(
    () => parse({ list: { ...all.list, cursor: shortage.list.cursor } }),
    (error: unknown) =>
      error instanceof listBehavior.SharedListContractError &&
      error.code === 'LIST_CURSOR_INVALID',
  );
  // A keep the List's bands do not declare never reaches a statement.
  assert.throws(
    () =>
      parse({
        list: {
          ...shortage.list,
          cursor: null,
          figures: {
            ...shortage.list.figures!,
            keep: { figureId: status, values: [band('overstock')] },
          },
        },
      }),
    (error: unknown) =>
      error instanceof listBehavior.SharedListContractError &&
      error.code === 'LIST_INPUT_MALFORMED',
  );

  // A band reads as its label in the page and in the export; a figure the
  // statement could not state reads empty, never 0.
  assert.equal(figureBandLabel(list, status, band('reorder')), 'Reorder');
  assert.equal(figureBandLabel(list, status, 'not a band value'), null);
  assert.equal(
    figureBandLabel(list, id('field', 'item_sku'), band('reorder')),
    null,
  );
  const row = {
    archived: false,
    entityId: id('entity', 'item'),
    recordId: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    values: {
      [id('field', 'item_sku')]: 'VALVE-10',
      [id('field', 'item_name')]: 'Valve',
      [id('field', 'item_base_unit')]: 'EA',
      [id('field', 'item_reorder_point')]: null,
      ...Object.fromEntries(
        [
          'on_hand',
          'usable',
          'reserved',
          'available',
          'incoming',
          'open_demand',
        ].map((local) => [id('list_figure', `item_stock_list_${local}`), '1']),
      ),
      [id('list_figure', 'item_stock_list_projected')]: '-4',
      [status]: band('shortage'),
    },
  };
  const present = (
    _record: unknown,
    fieldId: string,
    value: Parameters<typeof figureBandLabel>[2],
  ) => figureBandLabel(list, fieldId, value) ?? String(value);
  const statusColumn = list.columns.find((value) => value.field === status)!;
  assert.equal(declaredCellText(statusColumn, row, present), 'Shortage');
  assert.equal(
    declaredListCsv(list, [row], present),
    "\uFEFFSKU,Item,Unit,On hand,Usable,Reserved,Available,Incoming,Open demand,Projected,Reorder point,Status\r\nVALVE-10,Valve,EA,1,1,1,1,1,1,'-4,,Shortage\r\n",
  );
});

/**
 * PAYABLES: the Bills List the product declares runs on the same List runtime
 * as every other: each state tab is one exact filter, the newest bill comes
 * first, the vendor is named through its label, and the export keeps exact
 * figures while a supplier invoice number a spreadsheet would run as a
 * formula leaves inert.
 */
test('the declared Bills List filters each state tab exactly, orders the newest bill first and exports a supplier invoice number inert', () => {
  const ns = 'northstar.app';
  const surface = (
    composedApplicationDefinition().surfaces as Array<Record<string, unknown>>
  ).find((value) => value.surfaceId === `${ns}:surface.vendor_bill_list`)!;
  const list = SurfaceListSchema.parse(surface.list);
  const view = (local: string) => `${ns}:list_view.vendor_bill_list_${local}`;
  const queryId = `${ns}:query.vendor_bill_list`;
  const now = new Date('2026-09-30T12:00:00.000Z');
  type Sent = {
    list: {
      fieldFilters?: unknown;
      referenceLabels?: { referenceId: string; sourceFieldId: string }[];
      sort: unknown;
    };
  };
  const sent = (local: string, mode: 'page' | 'count' = 'page') =>
    declaredListArguments(
      list,
      readDeclaredListState(
        list,
        new URL(`http://list.local/?view=${encodeURIComponent(view(local))}`),
      ),
      { mode, now, queryId, scopeArguments: {} },
    ) as unknown as Sent;
  const partial = sent('partially_paid');
  assert.deepEqual(partial.list.fieldFilters, [
    {
      fieldId: `${ns}:field.vendor_bill_state`,
      value: `${ns}:option.vendor_bill_state_partially_paid`,
    },
  ]);
  assert.deepEqual(partial.list.sort, [
    { direction: 'descending', fieldId: `${ns}:field.vendor_bill_bill_date` },
  ]);
  assert.deepEqual(
    partial.list.referenceLabels?.map((label) => label.sourceFieldId),
    [`${ns}:field.vendor_bill_supplier_party_id`],
  );
  // All is unfiltered; a tab count sends no order.
  assert.equal(sent('all').list.fieldFilters, undefined);
  assert.deepEqual(sent('void', 'count').list.sort, []);

  const bill = {
    archived: false,
    entityId: `${ns}:entity.vendor_bill`,
    recordId: '00000000-0000-4000-8000-000000000001',
    revision: 2,
    relationLabels: {
      [`${ns}:list_column.vendor_bill_list_vendor`]: {
        label: 'Alpine Office Supply',
        recordId: '00000000-0000-4000-8000-000000000002',
      },
    },
    values: {
      [`${ns}:field.vendor_bill_number`]: 'BILL-000001',
      [`${ns}:field.vendor_bill_supplier_invoice_number`]:
        '=HYPERLINK("http://x")',
      [`${ns}:field.vendor_bill_bill_date`]: '2026-09-30T10:00:00.000Z',
      [`${ns}:field.vendor_bill_due_date`]: '2026-10-30T10:00:00.000Z',
      [`${ns}:field.vendor_bill_state`]: `${ns}:option.vendor_bill_state_partially_paid`,
      [`${ns}:field.vendor_bill_total`]: '59.880000000000000000',
      [`${ns}:field.vendor_bill_balance`]: '39.880000000000000000',
      [`${ns}:field.vendor_bill_currency`]: 'CAD',
    },
  };
  const csv = declaredListCsv(list, [bill], (_record, _fieldId, value) =>
    String(value).endsWith('_partially_paid')
      ? 'Partially paid'
      : String(value),
  );
  assert.equal(
    csv,
    '\uFEFFNumber,Vendor,Supplier invoice,Bill date,Due,Status,Total,Balance,Currency\r\n' +
      'BILL-000001,Alpine Office Supply,"\'=HYPERLINK(""http://x"")",2026-09-30T10:00:00.000Z,2026-10-30T10:00:00.000Z,Partially paid,59.880000000000000000,39.880000000000000000,CAD\r\n',
  );
});

/**
 * ORDER-PARITY: a row's action is the first declared one whose condition holds
 * on the row's own server-projected values; supplementary progress (`omit`)
 * is re-requested without, only for views that do not keep open rows. The
 * shared List runtime knows no surface, so a synthetic declaration stands in
 * for the order Lists; their markup is rendered by the integration witness.
 */
test('a declared List links a row to its first applicable action and reads without withheld figures', () => {
  const ns = 'northstar.fixture';
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const released = id('state', 'order_released');
  const state = id('field', 'order_state');
  const output = (local: string) => id('list_output', `orders_${local}`);
  const ref = (targetId: string) => ({
    kind: 'queryReference',
    schemaVersion: 'v6',
    targetId,
  });
  const list = SurfaceListSchema.parse({
    kind: 'surfaceList',
    schemaVersion: 'v6',
    pageSize: 2,
    columns: [
      {
        columnId: id('list_column', 'orders_number'),
        label: 'Number',
        orderKey: 10,
        field: id('field', 'order_number'),
        role: 'title',
        priority: 0,
        sortable: true,
      },
      ...(['ordered', 'shipped', 'open'] as const).map((local, index) => ({
        columnId: id('list_column', `orders_${local}`),
        label: local,
        orderKey: 20 + index * 10,
        field: output(local),
        role: 'value',
        priority: 1 + index,
        sortable: false,
      })),
      {
        columnId: id('list_column', 'orders_total'),
        label: 'Total',
        orderKey: 50,
        field: id('metric', 'order_total'),
        role: 'value',
        priority: 4,
        sortable: false,
        format: 'money',
      },
    ],
    defaultSort: [
      { columnId: id('list_column', 'orders_number'), direction: 'ascending' },
    ],
    views: [
      {
        viewId: id('list_view', 'orders_all'),
        label: 'All',
        orderKey: 10,
        filters: [],
      },
      {
        viewId: id('list_view', 'orders_to_ship'),
        label: 'To ship',
        orderKey: 20,
        filters: [{ field: state, value: released }],
        open: true,
      },
    ],
    filters: [],
    export: { format: 'csv' },
    progress: {
      lines: {
        query: ref(id('query', 'order_line_list')),
        relation: id('relation', 'order_line_order'),
        quantity: id('field', 'order_line_quantity'),
      },
      done: {
        query: ref(id('query', 'order_shipped_list')),
        relation: id('relation', 'order_shipped_line'),
        quantity: id('field', 'order_shipped_quantity'),
      },
      openIn: { field: state, values: [released] },
      outputs: {
        ordered: output('ordered'),
        done: output('shipped'),
        open: output('open'),
      },
      whenDenied: 'omit',
    },
    // Declared out of order: the order key, not the position, decides.
    rowActions: [
      {
        actionId: id('list_row_action', 'orders_view'),
        label: 'View',
        orderKey: 20,
      },
      {
        actionId: id('list_row_action', 'orders_fulfill'),
        label: 'Fulfill',
        orderKey: 10,
        when: { filters: [{ field: state, value: released }], open: true },
        section: id('dataset', 'fulfillment_lines'),
      },
    ],
  });
  const row = (values: Record<string, string | null>) => ({
    archived: false,
    entityId: id('entity', 'order'),
    recordId: '00000000-0000-4000-8000-000000000002',
    revision: 1,
    values: {
      [state]: released,
      [id('field', 'order_number')]: 'SO-1',
      [output('ordered')]: '15',
      [output('shipped')]: '4',
      [output('open')]: '11',
      ...values,
    },
  });
  const chosen = (values: Record<string, string | null>) =>
    declaredRowAction(list, row(values))?.label;
  assert.equal(chosen({}), 'Fulfill');
  // Nothing open, another state, or figures the row does not state: View.
  for (const values of [
    { [output('open')]: '0' },
    { [output('open')]: '0.000' },
    { [state]: id('state', 'order_draft') },
    { [output('open')]: null },
  ])
    assert.equal(chosen(values), 'View', JSON.stringify(values));
  const withheld = row({});
  delete (withheld.values as Record<string, unknown>)[output('open')];
  assert.equal(declaredRowAction(list, withheld)?.label, 'View');
  // Only the open view needs the figures.
  assert.equal(
    viewNeedsProgress(list, id('list_view', 'orders_to_ship')),
    true,
  );
  assert.equal(viewNeedsProgress(list, id('list_view', 'orders_all')), false);
  assert.equal(viewNeedsProgress(list, null), false);

  // Only a policy refusal of one of the two summed queries is a withheld
  // figure, and only on a List that declares its figures supplementary.
  const deniedFor = (queryId: string) =>
    new queryGateway.SemanticQueryPolicyDeniedError(queryId, {
      release: { contentHash: 'fixture', releaseId: 'fixture' },
    } as unknown as IssuedRequestRuntimeView);
  assert.equal(
    withheldProgressQuery(list, deniedFor(id('query', 'order_shipped_list'))),
    id('query', 'order_shipped_list'),
  );
  assert.equal(
    withheldProgressQuery(list, deniedFor(id('query', 'order_line_list'))),
    id('query', 'order_line_list'),
  );
  for (const refusal of [
    deniedFor(id('query', 'orders')),
    deniedFor(id('query', 'party_list')),
    new Error(`current policy denied query ${id('query', 'order_line_list')}`),
  ])
    assert.equal(withheldProgressQuery(list, refusal), null);
  const purpose = SurfaceListSchema.parse({
    ...list,
    progress: { ...list.progress, whenDenied: undefined },
  });
  assert.equal(
    withheldProgressQuery(
      purpose,
      deniedFor(id('query', 'order_shipped_list')),
    ),
    null,
  );

  // Without its figures the request carries no progress; an open view is
  // never read that way, since it would count every row.
  const now = new Date('2026-09-29T12:00:00.000Z');
  const all = readDeclaredListState(list, new URL('http://list.local/'));
  const sent = declaredListArguments(list, all, {
    mode: 'page',
    now,
    queryId: id('query', 'orders'),
    scopeArguments: {},
    withoutProgress: true,
  }) as unknown as { list: Record<string, unknown> };
  assert.equal('progress' in sent.list, false);
  assert.equal(
    'progress' in
      (
        declaredListArguments(list, all, {
          mode: 'count',
          now,
          queryId: id('query', 'orders'),
          scopeArguments: {},
        }) as unknown as { list: Record<string, unknown> }
      ).list,
    true,
  );
  assert.throws(() =>
    declaredListArguments(list, all, {
      mode: 'count',
      now,
      queryId: id('query', 'orders'),
      scopeArguments: {},
      viewId: id('list_view', 'orders_to_ship'),
      withoutProgress: true,
    }),
  );
  // Withheld figures and an unstated total are no value: the page reads "\u2014"
  // for them and the file leaves their cells empty.
  const unstated = row({ [output('ordered')]: null });
  delete (unstated.values as Record<string, unknown>)[output('shipped')];
  delete (unstated.values as Record<string, unknown>)[output('open')];
  for (const column of list.columns.slice(1))
    assert.equal(declaredCellText(column, unstated), null, column.label);
  assert.equal(
    declaredCellText(
      list.columns[4]!,
      row({ [id('metric', 'order_total')]: '1234.5' }),
    ),
    '1,234.50',
  );
  assert.equal(
    declaredListCsv(list, [unstated], (_record, _fieldId, value) =>
      String(value),
    ),
    '\uFEFFNumber,ordered,shipped,open,Total\r\nSO-1,,,,\r\n',
  );
});

test('a declared List sends its supply with its progress, keeps each supply tab, marks what a row is short and reads without a withheld supply', () => {
  const ns = 'northstar.fixture';
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const released = id('state', 'order_released');
  const draft = id('state', 'order_draft');
  const state = id('field', 'order_state');
  const output = (local: string) => id('list_output', `orders_${local}`);
  const ref = (targetId: string) => ({
    kind: 'queryReference',
    schemaVersion: 'v6',
    targetId,
  });
  const usable = (reference: string) => ({
    reference,
    query: ref(id('query', 'location_list')),
    field: id('field', 'location_status'),
    values: [id('option', 'location_status_usable')],
  });
  const balances = {
    query: ref(id('query', 'reservation_balance_list')),
    relation: id('relation', 'reservation_balance_reservation'),
    quantity: id('field', 'reservation_balance_remaining_quantity'),
  };
  const list = SurfaceListSchema.parse({
    kind: 'surfaceList',
    schemaVersion: 'v6',
    pageSize: 2,
    columns: [
      {
        columnId: id('list_column', 'orders_number'),
        label: 'Number',
        orderKey: 10,
        field: id('field', 'order_number'),
        role: 'title',
        priority: 0,
        sortable: true,
      },
      ...(['open', 'short'] as const).map((local, index) => ({
        columnId: id('list_column', `orders_${local}`),
        label: local === 'open' ? 'Open' : 'Short',
        orderKey: 20 + index * 10,
        field: output(local),
        role: 'value',
        priority: 1 + index,
        sortable: false,
      })),
    ],
    defaultSort: [
      { columnId: id('list_column', 'orders_number'), direction: 'ascending' },
    ],
    views: [
      {
        viewId: id('list_view', 'orders_all'),
        label: 'All',
        orderKey: 10,
        filters: [],
      },
      {
        viewId: id('list_view', 'orders_blocked'),
        label: 'Blocked by supply',
        orderKey: 20,
        filters: [{ field: state, value: released }],
        supply: 'short',
      },
      {
        viewId: id('list_view', 'orders_reserved'),
        label: 'Reserved',
        orderKey: 30,
        filters: [{ field: state, value: released }],
        supply: 'covered',
      },
    ],
    filters: [],
    export: { format: 'csv' },
    progress: {
      lines: {
        query: ref(id('query', 'order_line_list')),
        relation: id('relation', 'order_line_order'),
        quantity: id('field', 'order_line_quantity'),
      },
      done: {
        query: ref(id('query', 'order_shipped_list')),
        relation: id('relation', 'order_shipped_line'),
        quantity: id('field', 'order_shipped_quantity'),
      },
      openIn: { field: state, values: [released] },
      outputs: {
        ordered: output('ordered'),
        done: output('shipped'),
        open: output('open'),
      },
      whenDenied: 'omit',
      supply: {
        coverage: {
          query: ref(id('query', 'reservations')),
          relation: id('relation', 'reservation_order_line'),
          related: balances,
        },
        item: id('field', 'order_line_item_id'),
        free: {
          plus: [
            {
              rows: {
                query: ref(id('query', 'stock')),
                match: id('field', 'stock_item_id'),
                quantity: id('field', 'stock_quantity'),
              },
              within: usable(id('field', 'stock_location_id')),
              sum: 'rows',
            },
          ],
          minus: [
            {
              rows: {
                query: ref(id('query', 'stock_reservations')),
                match: id('field', 'reservation_item_id'),
              },
              within: usable(id('field', 'reservation_location_id')),
              related: balances,
              sum: 'related',
            },
          ],
        },
        shortIn: { field: state, values: [draft, released] },
        outputs: { covered: output('covered'), short: output('short') },
        whenDenied: 'omit',
      },
    },
    rowActions: [
      {
        actionId: id('list_row_action', 'orders_post_shipment'),
        label: 'Post shipment',
        orderKey: 10,
        when: {
          filters: [{ field: state, value: released }],
          supply: 'covered',
        },
        section: id('dataset', 'fulfillment_lines'),
      },
      {
        actionId: id('list_row_action', 'orders_fulfill'),
        label: 'Fulfill',
        orderKey: 20,
        when: { filters: [{ field: state, value: released }], open: true },
        section: id('dataset', 'fulfillment_lines'),
      },
      {
        actionId: id('list_row_action', 'orders_view'),
        label: 'View',
        orderKey: 30,
      },
    ],
  });
  const now = new Date('2026-10-05T12:00:00.000Z');
  const queryId = id('query', 'orders');
  type Sent = {
    list: {
      progress?: {
        openOnly?: true;
        supply?: { keep?: string; outputs: Record<string, string> };
      };
      cursor: string | null;
    } & Record<string, unknown>;
  };
  const sent = (
    viewId: string | null,
    options: { withoutProgress?: boolean; withoutSupply?: boolean } = {},
  ) =>
    declaredListArguments(
      list,
      readDeclaredListState(list, new URL('http://list.local/')),
      {
        mode: 'count',
        now,
        queryId,
        scopeArguments: {},
        viewId,
        ...options,
      },
    ) as unknown as Sent;
  // Every request carries the supply inside its progress; a supply tab adds
  // its keep, for its page and its count alike.
  const all = sent(id('list_view', 'orders_all'));
  assert.deepEqual(all.list.progress?.supply?.outputs, {
    covered: output('covered'),
    short: output('short'),
  });
  assert.equal(all.list.progress?.supply?.keep, undefined);
  assert.equal(
    sent(id('list_view', 'orders_blocked')).list.progress?.supply?.keep,
    'short',
  );
  assert.equal(
    sent(id('list_view', 'orders_reserved')).list.progress?.supply?.keep,
    'covered',
  );
  // The gateway's closed contract reads it back.
  const parse = (value: Sent) =>
    listBehavior.parseSharedListArguments(
      value as unknown as Parameters<
        typeof listBehavior.parseSharedListArguments
      >[0],
      {
        declaredParameterIds: [],
        exportMaximumResultCount: 5000,
        maximumResultCount: 100,
        queryId,
      },
    );
  const parsed = parse(sent(id('list_view', 'orders_blocked')))?.progress;
  assert.equal(parsed?.supply?.keep, 'short');
  assert.equal(parsed?.supply?.itemFieldId, id('field', 'order_line_item_id'));
  assert.deepEqual(parsed?.supply?.free.plus[0]?.within, {
    fieldId: id('field', 'location_status'),
    queryId: id('query', 'location_list'),
    referenceFieldId: id('field', 'stock_location_id'),
    values: [id('option', 'location_status_usable')],
  });
  // A keep that is neither, an output shadowing a progress output and an
  // unknown member never reach a statement.
  const supply = all.list.progress!.supply!;
  for (const malformed of [
    { ...supply, keep: 'incoming' },
    { ...supply, outputs: { ...supply.outputs, short: output('open') } },
    { ...supply, outputs: { covered: output('x'), short: output('x') } },
    { ...supply, incoming: true },
  ])
    assert.throws(
      () =>
        parse({
          list: {
            ...all.list,
            progress: { ...all.list.progress!, supply: malformed },
          },
        }),
      /list supply|list progress|closed contract/u,
    );
  // Without its supply the progress still goes; a supply tab is never read
  // without it, nor without the progress it extends.
  const withoutSupply = sent(id('list_view', 'orders_all'), {
    withoutSupply: true,
  });
  assert.ok(withoutSupply.list.progress);
  assert.equal('supply' in withoutSupply.list.progress, false);
  for (const options of [{ withoutSupply: true }, { withoutProgress: true }])
    assert.throws(() => sent(id('list_view', 'orders_blocked'), options));
  assert.equal(viewNeedsSupply(list, id('list_view', 'orders_blocked')), true);
  assert.equal(viewNeedsSupply(list, id('list_view', 'orders_all')), false);
  assert.equal(
    viewNeedsProgress(list, id('list_view', 'orders_reserved')),
    true,
  );

  // The row's action: reserved stock still to ship first, then open work.
  const row = (values: Record<string, string | null>) => ({
    archived: false,
    entityId: id('entity', 'order'),
    recordId: '00000000-0000-4000-8000-000000000003',
    revision: 1,
    values: {
      [state]: released,
      [id('field', 'order_number')]: 'SO-3',
      [output('open')]: '11',
      [output('covered')]: '3',
      [output('short')]: '6',
      ...values,
    },
  });
  const chosen = (values: Record<string, string | null>) =>
    declaredRowAction(list, row(values))?.label;
  assert.equal(chosen({}), 'Post shipment');
  for (const values of [
    { [output('covered')]: '0' },
    { [output('covered')]: '0.000' },
    { [output('covered')]: null },
  ])
    assert.equal(chosen(values), 'Fulfill', JSON.stringify(values));
  assert.equal(chosen({ [state]: draft }), 'View');
  const withheld = row({});
  delete (withheld.values as Record<string, unknown>)[output('covered')];
  assert.equal(declaredRowAction(list, withheld)?.label, 'Fulfill');
  // Only a positive Short is marked, and only in the Short column.
  const [, open, short] = list.columns;
  assert.equal(shortMarked(list, short!, row({})), true);
  assert.equal(shortMarked(list, open!, row({})), false);
  for (const value of ['0', '0.000', null])
    assert.equal(
      shortMarked(list, short!, row({ [output('short')]: value })),
      false,
      String(value),
    );
  assert.equal(shortMarked(list, short!, withheld), true);
  // The file keeps the machine value.
  assert.equal(
    declaredListCsv(list, [row({})], (_record, _fieldId, value) =>
      String(value),
    ),
    '\uFEFFNumber,Open,Short\r\nSO-3,11,6\r\n',
  );

  // Only a policy refusal of a supply query is a withheld supply, and only
  // on a List that declares its supply supplementary.
  const deniedFor = (denied: string) =>
    new queryGateway.SemanticQueryPolicyDeniedError(denied, {
      release: { contentHash: 'fixture', releaseId: 'fixture' },
    } as unknown as IssuedRequestRuntimeView);
  for (const local of [
    'reservations',
    'reservation_balance_list',
    'stock',
    'location_list',
    'stock_reservations',
  ])
    assert.equal(
      withheldSupplyQuery(list, deniedFor(id('query', local))),
      id('query', local),
    );
  for (const refusal of [
    deniedFor(id('query', 'order_line_list')),
    deniedFor(queryId),
    new Error(`current policy denied query ${id('query', 'stock')}`),
  ])
    assert.equal(withheldSupplyQuery(list, refusal), null);
  assert.equal(
    withheldProgressQuery(list, deniedFor(id('query', 'stock'))),
    null,
  );
  const purpose = SurfaceListSchema.parse({
    ...list,
    progress: {
      ...list.progress,
      supply: { ...list.progress!.supply, whenDenied: undefined },
    },
  });
  assert.equal(
    withheldSupplyQuery(purpose, deniedFor(id('query', 'stock'))),
    null,
  );
});

test('a record names its short rows and its progress, and offers only the first next step, as a plain form under its own name', () => {
  const ns = 'northstar.fixture';
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const state = id('field', 'order_state');
  const inState = (value: string, operator = 'equals') => ({
    value: { source: 'record', field: state },
    operator,
    compare: id('state', `order_${value}`),
  });
  const column = (
    local: string,
    label: string,
    orderKey: number,
    field: string,
    role?: string,
  ) => ({
    columnId: id('column', local),
    label,
    orderKey,
    field,
    ...(role ? { presentation: { role, priority: orderKey } } : {}),
  });
  const composition = SurfaceCompositionSchema.parse({
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'number'),
        subtitle: [],
        facts: [],
        status: id('column', 'state'),
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
      alerts: [
        {
          label: 'Fulfillment exception',
          description: 'Open quantity free stock does not cover.',
          datasetId: id('dataset', 'lines'),
          columnId: id('column', 'short'),
        },
      ],
      progression: {
        title: 'Order to cash',
        steps: [
          {
            label: 'Order',
            current: [inState('draft')],
            complete: [inState('draft', 'notEquals')],
            stopped: [inState('cancelled')],
          },
          {
            label: 'Fulfillment',
            current: [inState('released')],
            complete: [inState('closed')],
            attention: [
              {
                value: { source: 'record', field: id('metric', 'to_invoice') },
                operator: 'positive',
                compare: null,
              },
            ],
            stopped: [inState('cancelled')],
            documents: id('dataset', 'shipments'),
          },
        ],
        next: [
          { operation: ref('operationReference', id('operation', 'release')) },
          { action: id('action', 'close') },
        ],
      },
    },
    fields: [
      column('number', 'Order', 10, id('field', 'order_number')),
      column('state', 'State', 20, state),
    ],
    children: ['lines', 'shipments'].map((local, index) => ({
      datasetId: id('dataset', local),
      label: local === 'lines' ? 'Lines' : 'Shipments',
      orderKey: 10 + index * 10,
      query: ref('queryReference', id('query', `${local}_list`)),
      presentation: { selection: 'none' },
      parent: {
        relationId: id('relation', `${local}_order`),
        value: { source: 'record', field: 'recordId' },
        ownership: 'reference',
      },
      columns:
        local === 'lines'
          ? [
              column('item', 'Item', 10, id('field', 'line_item'), 'primary'),
              column('short', 'Short', 20, id('metric', 'short'), 'quantity'),
            ]
          : [column('shipment', 'Shipment', 10, id('field', 'number'))],
    })),
    actions: [
      {
        actionId: id('action', 'close'),
        label: 'Close order',
        description: 'Closes the order.',
        orderKey: 10,
        conditions: [inState('released')],
        inputs: [],
        steps: [
          {
            stepId: id('step', 'close'),
            operation: ref('operationReference', id('operation', 'close')),
            bindings: [
              {
                path: ['recordId'],
                value: { source: 'record', field: 'recordId' },
              },
            ],
          },
        ],
      },
    ],
  });
  const surface = {
    surfaceId: id('surface', 'order_detail'),
    label: 'Order',
    composition,
    dataSourceQueryId: id('query', 'order_get'),
  } as unknown as CompiledSurfaceDefinition;
  const dto = (
    recordId: string,
    values: Record<string, string | null>,
  ): CompositionData['record'] => ({
    archived: false,
    entityId: id('entity', 'order'),
    recordId,
    revision: 1,
    values,
  });
  const data = (
    order: Record<string, string | null>,
    shortages: readonly (string | null)[],
    shipments = 0,
    status: 'ready' | 'failed' = 'ready',
  ): CompositionData => {
    const record = dto('00000000-0000-4000-8000-000000000001', {
      [id('field', 'order_number')]: 'SO-1',
      [id('metric', 'to_invoice')]: null,
      ...order,
    });
    return {
      record,
      fields: { record, cells: {} },
      fieldsFailed: false,
      children: [
        {
          definition: composition.children[0]!,
          status,
          rows: shortages.map((short, index) => {
            const line = dto(`00000000-0000-4000-8000-00000000010${index}`, {
              [id('metric', 'short')]: short,
            });
            return {
              record: line,
              cells: {
                [id('column', 'item')]: `Item ${String(index + 1)}`,
                [id('column', 'short')]: short ?? '—',
              },
            };
          }),
        },
        {
          definition: composition.children[1]!,
          status: shipments ? 'ready' : 'empty',
          rows: Array.from({ length: shipments }, (_, index) => ({
            record: dto(`00000000-0000-4000-8000-00000000020${index}`, {}),
            cells: { [id('column', 'shipment')]: `SHP-${String(index + 1)}` },
          })),
        },
      ],
      selections: {},
      selected: null,
      selectedDatasetId: null,
      url: '/?surface=order&record=00000000-0000-4000-8000-000000000001',
      scope: null,
    };
  };
  const draft = { [state]: id('state', 'order_draft') };
  const released = { [state]: id('state', 'order_released') };

  // Only rows stating a positive figure are named, by their primary cell; a
  // zero, an unstated figure or a failed dataset states nothing.
  const banner = renderCompositionAlerts(
    surface,
    data(draft, ['2', '0', null, '0.5']),
  );
  assert.deepEqual(
    [
      ...banner.matchAll(
        /<li data-record-id="[^"]+"><strong>([^<]+)<\/strong> <span>([^<]+)<\/span>/gu,
      ),
    ].map((match) => [match[1], match[2]]),
    [
      ['Item 1', 'Short 2'],
      ['Item 4', 'Short 0.5'],
    ],
  );
  assert.match(
    banner,
    /<h2 id="composition-alert-0">Fulfillment exception<\/h2>/u,
  );
  // Never a live region: an outcome's status stays the page's only one.
  assert.doesNotMatch(banner, /role=|aria-live/u);
  assert.equal(renderCompositionAlerts(surface, data(draft, ['0', null])), '');
  assert.equal(
    renderCompositionAlerts(surface, data(draft, ['3'], 0, 'failed')),
    '',
  );

  // States: stopped, then attention, then complete, then current.
  assert.deepEqual(compositionProgressionStates(surface, data(draft, [])), [
    'current',
    'upcoming',
  ]);
  assert.deepEqual(compositionProgressionStates(surface, data(released, [])), [
    'complete',
    'current',
  ]);
  assert.deepEqual(
    compositionProgressionStates(
      surface,
      data({ ...released, [id('metric', 'to_invoice')]: '1' }, []),
    ),
    ['complete', 'attention'],
  );
  assert.deepEqual(
    compositionProgressionStates(
      surface,
      data({ [state]: id('state', 'order_cancelled') }, []),
    ),
    ['stopped', 'stopped'],
  );

  // The first next entry offered now: the operation the page offers, else
  // the record task whose conditions hold -- a plain form, no script needed,
  // named apart from the command bar's own control.
  const offered: string[] = [];
  const operationControl =
    (available: boolean) => (operationId: string, prefix: string) => {
      offered.push(operationId);
      return available
        ? `<form method="post" data-offered="${operationId}"><button type="submit" aria-label="${prefix}: Release">Release</button></form>`
        : null;
    };
  const view = {} as never;
  const first = renderCompositionProgression(
    surface,
    data(draft, [], 8),
    view,
    operationControl(true),
  );
  assert.match(
    first,
    new RegExp(`data-next-operation="${id('operation', 'release')}"`, 'u'),
  );
  assert.match(first, /aria-label="Next action: Release"/u);
  assert.deepEqual(offered, [id('operation', 'release')]);
  // Current and attention steps carry aria-current; markers are not read.
  assert.match(
    first,
    /<li data-step-state="current" aria-current="step"><span class="composition-progression-marker" aria-hidden="true">1<\/span>/u,
  );
  // Documents: the first six by their primary cell, then how many more.
  assert.equal((first.match(/<li><span>SHP-/gu) ?? []).length, 6);
  assert.match(
    first,
    new RegExp(
      `<a href="#${id('dataset', 'shipments')}">2 more in Shipments</a>`,
      'u',
    ),
  );
  const next = renderCompositionProgression(
    surface,
    data(released, []),
    view,
    operationControl(false),
  );
  assert.match(
    next,
    new RegExp(
      `<form method="post" action="[^"]+"><input type="hidden" name="compositionAction" value="${id('action', 'close')}"><button type="submit" aria-label="Next action: Close order">Close order</button></form>`,
      'u',
    ),
  );
  // Nothing next while a Task is open, once stopped, or with nothing offered.
  for (const [order, offerNext] of [
    [released, false],
    [{ [state]: id('state', 'order_cancelled') }, true],
    [{ [state]: id('state', 'order_closed') }, true],
  ] as const)
    assert.doesNotMatch(
      renderCompositionProgression(
        surface,
        data(order, []),
        view,
        operationControl(false),
        offerNext,
      ),
      /data-next-(?:action|operation)=/u,
    );
  // A record whose own fields failed states no progress at all.
  assert.equal(
    renderCompositionProgression(
      surface,
      { ...data(draft, []), fieldsFailed: true },
      view,
      operationControl(true),
    ),
    '',
  );
});

test('the task rows, alert and progression lay out at phone width without a sideways scroll', () => {
  const source = readFileSync(`${webRoot}/src/surface-runtime.ts`, 'utf8');
  // Steps wrap into as many columns as fit; the banner and every panel span
  // the page; a task row becomes a labelled card through the shared rule.
  for (const rule of [
    '.composition-progression-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))',
    '.composition-alert{grid-column:1/-1;',
    '.composition-progression{grid-column:1/-1;',
    '.composition-progression-next>div{flex:1 1 16rem;min-width:0}',
    '.data-table-wrap tr[data-compact-card=true] td{display:grid;',
  ])
    assert.ok(source.includes(rule), rule);
  const composition = readFileSync(
    `${webRoot}/src/surface-composition.ts`,
    'utf8',
  );
  // Each task row is a compact card whose cells carry their labels.
  assert.match(
    composition,
    /<tr data-compact-card="true" data-task-row="\$\{h\(rowId\)\}">/u,
  );
  assert.match(composition, /data-column-label="\$\{h\(input\.label\)\}"/u);
});

test('WAREHOUSE-MODE: a launcher renders large tiles and one scan field that works without script, and lays out at phone width', () => {
  const source = readFileSync(`${webRoot}/src/surface-runtime.ts`, 'utf8');
  // Three tiles a row on a tablet, one at phone width, each a target far
  // above 44px; the scan field and its action are as tall as a thumb.
  for (const rule of [
    '.launcher-tiles ul{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))',
    '.launcher-tile{display:flex;flex-direction:column;gap:var(--space-1);min-height:144px',
    '.launcher-scan__field input{min-height:56px',
    '.launcher-action button{min-height:56px}',
    '@media(max-width:800px){.launcher-tiles ul{grid-template-columns:minmax(0,1fr)}.launcher-tile{min-height:96px}.launcher-action button{width:100%}}',
    // The action is a Task's primary action: at phone width it sticks above
    // the bottom navigation, as every Task's does.
    '.command-bar,.task-primary-action{position:sticky;z-index:3;bottom:80px;',
  ])
    assert.ok(source.includes(rule), rule);

  const surface = {
    label: 'Warehouse',
    surfaceId: 'northstar.app:surface.inventory_warehouse',
    launcher: {
      kind: 'surfaceLauncher',
      schemaVersion: 'v6',
      tiles: [],
      scan: { label: 'Scan a <code>', actionLabel: 'Open', targets: [] },
    },
  } as unknown as CompiledSurfaceDefinition;
  const data: LauncherRenderData = {
    tiles: [
      {
        tileId: 'northstar.app:launcher_tile.receive',
        label: 'Receive <now>',
        description: 'Orders & lines',
        href: '/?surface=a&view=b',
        count: 2,
        viewLabel: 'To receive',
      },
      {
        tileId: 'northstar.app:launcher_tile.put_away',
        label: 'Put away',
        description: 'Transfers',
        href: '/?surface=c',
        count: null,
        viewLabel: null,
      },
    ],
    scope: { parameterId: 'northstar.app:parameter.company', value: 'c1' },
    scan: null,
  };
  // Every tile is a link carrying its own escaped words; a count that could
  // not be read is left out, never shown as zero.
  assert.equal(
    renderLauncherTiles(surface, data),
    '<nav class="launcher-tiles" aria-label="Warehouse"><ul>' +
      '<li><a class="launcher-tile" href="/?surface=a&amp;view=b" data-launcher-tile="northstar.app:launcher_tile.receive"><strong class="launcher-tile__label">Receive &lt;now&gt;</strong><span class="launcher-tile__count" data-launcher-count>2</span><span class="launcher-tile__view">To receive</span><span class="launcher-tile__description">Orders &amp; lines</span></a></li>' +
      '<li><a class="launcher-tile" href="/?surface=c" data-launcher-tile="northstar.app:launcher_tile.put_away"><strong class="launcher-tile__label">Put away</strong><span class="launcher-tile__description">Transfers</span></a></li>' +
      '</ul></nav>',
  );
  // One GET form in the page's company: Enter submits it, a wedge scanner
  // types into its focused field, and nothing needs script.
  const blank = renderLauncherScan(surface, data);
  assert.match(
    blank,
    /<form id="launcher-scan-northstar-app-surface-inventory-warehouse" class="launcher-scan__form" method="get" action="\/" role="search"><input type="hidden" name="surface" value="northstar\.app:surface\.inventory_warehouse"><input type="hidden" name="northstar\.app:parameter\.company" value="c1"><label class="launcher-scan__field"><span>Scan a &lt;code&gt;<\/span><input name="scan" value="" data-scan-input="true" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" maxlength="120" required autofocus><\/label><\/form>/u,
  );
  assert.doesNotMatch(blank, /data-message=/u);
  // A code that opened nothing stays in the box, described by the reason.
  const missed = renderLauncherScan(surface, {
    ...data,
    scan: { code: 'PO-<9>', outcome: 'SCAN_NO_MATCH' },
  });
  assert.match(
    missed,
    /<input name="scan" value="PO-&lt;9&gt;"[^>]* aria-invalid="true" aria-describedby="launcher-scan-northstar-app-surface-inventory-warehouse-message">/u,
  );
  assert.match(
    missed,
    /<div id="launcher-scan-northstar-app-surface-inventory-warehouse-message" class="launcher-scan__message" role="alert" data-message="SCAN_NO_MATCH"/u,
  );
  assert.equal(
    renderLauncherAction(surface),
    '<div class="task-primary-action launcher-action"><button type="submit" form="launcher-scan-northstar-app-surface-inventory-warehouse">Open</button></div>',
  );
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
  // the code-bearing provider and runtime-view refusals, then 34 with
  // committed success whose current-policy read-back is withheld. The count
  // is pinned so
  // registering a code is a deliberate, visible edit; moving it is the intended
  // cost of adding one, not a symptom.
  // RAIN-META-SALES adds nine generic composition task/dataset treatments.
  // RAIN-ORDER-ENTRY adds company refusal, shared draft conflict/lock treatments,
  // and the redacted partial-commit outcome.
  // SALES-PARITY adds the declared-List export refusal (never a partial file).
  // WAREHOUSE-MODE adds the two answers of a scan that opened nothing.
  assert.equal(SURFACE_MESSAGE_CODES.length, 50);

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
    'document-editor.ts',
    'workspace-entry.ts',
    'component-registry.ts',
    'demo-runtime.ts',
    'html.ts',
    'list-runtime.ts',
    'message-render.ts',
    'surface-contract.ts',
    'surface-composition.ts',
    'surface-launcher.ts',
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
    'document-editor.ts',
    'app-server.ts',
    'component-registry.ts',
    'gateway-error-codes.ts',
    'surface-contract.ts',
    'surface-composition.ts',
    'surface-launcher.ts',
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

test('an entry picks the only authorized company, else the last one chosen; a record every company shares may default, a document may not', () => {
  const [first, second] = [
    '00000000-0000-4000-8000-00000000000a',
    '00000000-0000-4000-8000-00000000000b',
  ] as const;
  const choose = (
    offered: readonly string[],
    explicit: readonly string[] = [],
    preference: string | undefined = undefined,
    mayDefault = true,
  ) => entryCompanyChoice({ offered, explicit, preference, mayDefault });
  // The only authorized company is picked, whatever was chosen before.
  assert.deepEqual(choose([first], [], second), {
    selected: first,
    invalid: false,
  });
  // Several: the one chosen last while it is still offered, else none.
  assert.deepEqual(choose([first, second], [], second), {
    selected: second,
    invalid: false,
  });
  assert.deepEqual(
    choose([first, second], [], '00000000-0000-4000-8000-00000000000c'),
    { selected: null, invalid: false },
  );
  assert.deepEqual(choose([first, second]), { selected: null, invalid: false });
  assert.deepEqual(choose([]), { selected: null, invalid: false });
  // A surface that may not default (an existing document) picks nothing.
  assert.deepEqual(choose([first], [], first, false), {
    selected: null,
    invalid: false,
  });
  // An explicit company must be exactly one offered company.
  assert.deepEqual(choose([first, second], [second]), {
    selected: second,
    invalid: false,
  });
  assert.deepEqual(
    choose([first], ['00000000-0000-4000-8000-00000000000c']).invalid,
    true,
  );
  assert.deepEqual(choose([first, second], [first, second]), {
    selected: null,
    invalid: true,
  });
});

test('a field-scoped section renders its rows, asks for a company it lacks and refuses a failed read without rows', () => {
  const ns = 'northstar.fixture';
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const ref = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: 'v6',
    targetId,
  });
  const composition = SurfaceCompositionSchema.parse({
    kind: 'surfaceComposition',
    schemaVersion: 'v6',
    presentation: {
      header: {
        title: id('column', 'thing_name'),
        subtitle: [],
        facts: [id('column', 'thing_unit')],
      },
      recordActions: 'progressive',
      technicalDetails: 'progressive',
    },
    fields: [
      {
        columnId: id('column', 'thing_name'),
        label: 'Name',
        orderKey: 10,
        field: id('field', 'thing_name'),
      },
      {
        columnId: id('column', 'thing_unit'),
        label: 'Unit',
        orderKey: 20,
        field: id('field', 'thing_unit'),
      },
    ],
    children: [
      {
        datasetId: id('dataset', 'thing_stock'),
        presentation: {
          selection: 'none',
          description: 'Missing or unavailable data is not zero stock.',
        },
        label: 'Stock by place',
        orderKey: 10,
        query: ref('queryReference', id('query', 'stock_list')),
        fieldScope: {
          fieldId: id('field', 'stock_thing_id'),
          value: { source: 'record', field: 'recordId' },
        },
        columns: [
          {
            columnId: id('column', 'stock_place'),
            label: 'Place',
            orderKey: 10,
            field: id('field', 'stock_place'),
            presentation: { role: 'primary', priority: 10 },
          },
          {
            columnId: id('column', 'stock_available'),
            label: 'Available',
            orderKey: 20,
            field: id('metric', 'available'),
            presentation: { role: 'quantity', priority: 20 },
          },
        ],
      },
    ],
    actions: [],
  });
  const surface = {
    composition,
    label: 'Thing detail',
    surfaceId: id('surface', 'thing_detail'),
  } as unknown as CompiledSurfaceDefinition;
  const thing = {
    archived: false,
    entityId: id('entity', 'thing'),
    recordId: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    values: {},
  };
  const data = (
    child: Omit<CompositionData['children'][number], 'definition'>,
  ): CompositionData => ({
    record: thing,
    fields: {
      record: thing,
      cells: {
        [id('column', 'thing_name')]: 'Safety vest',
        [id('column', 'thing_unit')]: 'EA',
      },
    },
    fieldsFailed: false,
    children: [{ definition: composition.children[0]!, ...child }],
    selections: {},
    selected: null,
    selectedDatasetId: null,
    url: '/?surface=thing',
    scope: null,
  });
  const view = {} as IssuedRequestRuntimeView;
  const row = {
    record: { ...thing, recordId: '00000000-0000-4000-8000-000000000002' },
    cells: {
      [id('column', 'stock_place')]: 'CAL-WH',
      [id('column', 'stock_available')]: '12',
    },
  };
  const ready = renderCompositionChildren(
    data({ rows: [row], status: 'ready' }),
    surface,
    view,
  );
  assert.match(
    ready,
    /data-resolution="ready"[\s\S]*<th scope="col" class="">Place<\/th><th scope="col" class="composition-quantity">Available<\/th>/u,
  );
  assert.match(ready, /<strong>CAL-WH<\/strong>/u);
  assert.match(
    ready,
    /data-column-label="Available" data-column-priority="20" data-cell-role="quantity">12<\/td>/u,
  );
  assert.match(ready, /About these quantities/u);
  // No selection column: the section is read-only.
  assert.doesNotMatch(ready, />Actions<\/th>|>Select</u);
  assert.match(
    renderCompositionHeader(surface, data({ rows: [], status: 'empty' })),
    /<h1>Safety vest<\/h1>[\s\S]*<dt>Unit<\/dt><dd>EA<\/dd>/u,
  );
  // One company's rows with no company chosen: the section asks for one.
  const waiting = renderCompositionChildren(
    data({
      rows: [],
      status: 'failed',
      error: 'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED',
    }),
    surface,
    view,
  );
  assert.match(
    waiting,
    /<div role="status" data-message="QUERY_LEGAL_ENTITY_SCOPE_REQUIRED"/u,
  );
  assert.doesNotMatch(waiting, /<table|COMPOSITION_CHILD_FAILED/u);
  // A failed read is a refusal, never an empty table.
  const failed = renderCompositionChildren(
    data({ rows: [], status: 'failed', error: 'COMPOSITION_CHILD_FAILED' }),
    surface,
    view,
  );
  assert.match(
    failed,
    /<div role="alert" data-message="COMPOSITION_CHILD_FAILED"/u,
  );
  assert.doesNotMatch(failed, /<table/u);
});

test('a document editor writes its declared create values on the header first create only', () => {
  const ns = 'northstar.fixture';
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const definition = SurfaceDocumentEditorSchema.parse({
    kind: 'draftDocumentEditor',
    headerFormSurfaceId: id('surface', 'slip_form'),
    recordSurfaceId: id('surface', 'slip_detail'),
    lineFormSurfaceId: id('surface', 'slip_line_form'),
    lineQueryId: id('query', 'slip_line_list'),
    parentRelationId: id('relation', 'slip_line_slip'),
    stateFieldId: id('field', 'slip_state'),
    editableStateIds: [id('option', 'slip_state_draft')],
    headerFields: [{ fieldId: id('field', 'slip_reason'), label: 'Reason' }],
    lineFields: [{ fieldId: id('field', 'slip_line_item'), label: 'Item' }],
    lineNumberFieldId: id('field', 'slip_line_number'),
    saveMode: 'sequential',
    createValues: [
      {
        fieldId: id('field', 'slip_state'),
        value: { source: 'literal', value: id('option', 'slip_state_draft') },
      },
      {
        fieldId: id('field', 'slip_source_id'),
        value: { source: 'record', field: 'recordId' },
      },
      {
        fieldId: id('field', 'slip_recorded_at'),
        value: { source: 'generated', value: 'instant' },
      },
      {
        fieldId: id('field', 'slip_actor_id'),
        value: { source: 'actor', field: 'principalId' },
      },
    ],
  });
  const header = {
    id: '00000000-0000-4000-8000-0000000000a1',
    record: null,
    removed: false,
  };
  const save = {
    instant: '2026-09-30T14:05:09.123Z',
    principalId: '00000000-0000-4000-8000-0000000000b2',
  };
  // The header's first create: the literal as declared, its own id -- the id
  // the create itself sends -- and the save's instant and principal.
  assert.deepEqual(createValuesFor(definition, header, true, save), {
    [id('field', 'slip_state')]: id('option', 'slip_state_draft'),
    [id('field', 'slip_source_id')]: header.id,
    [id('field', 'slip_recorded_at')]: save.instant,
    [id('field', 'slip_actor_id')]: save.principalId,
  });
  // Never an update of a saved header, a removal or a line.
  assert.deepEqual(
    createValuesFor(
      definition,
      { ...header, record: { recordId: header.id } },
      true,
      save,
    ),
    {},
  );
  assert.deepEqual(
    createValuesFor(definition, { ...header, removed: true }, true, save),
    {},
  );
  assert.deepEqual(createValuesFor(definition, header, false, save), {});
  // An editor that declares none writes none.
  const { createValues: _declared, ...plain } = definition;
  void _declared;
  assert.deepEqual(createValuesFor(plain, header, true, save), {});
});

/**
 * CATALOG-EXTRAS: the Items List, as the product declares it, sends its
 * searched children -- an item's aliases -- with every page, count and
 * export request, and the gateway's own contract binds them into the cursor;
 * Stock by item sends its reorder-point choice and its non-stocked band case,
 * and shows that band by its label.
 */
test('the Items List sends its searched children with every request and Stock by item its reorder-point choice and not-stocked band', () => {
  const ns = 'northstar.app';
  const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;
  const declared = (local: string) =>
    SurfaceListSchema.parse(
      (
        composedApplicationDefinition().surfaces as Array<
          Record<string, unknown>
        >
      ).find((value) => value.surfaceId === id('surface', local))!.list,
    );
  const now = new Date('2026-10-05T12:00:00.000Z');
  type Sent = {
    list: {
      cursor: string | null;
      searchChildren?: unknown;
      figures?: {
        choices?: unknown;
        bands?: Array<{ cases: unknown[]; figureId: string }>;
      };
    };
  };
  const items = declared('item_list');
  const queryId = id('query', 'item_list');
  const children = [
    {
      fieldId: id('field', 'item_alias_value'),
      queryId: id('query', 'item_alias_list'),
      relationId: id('relation', 'item_alias_item'),
    },
  ];
  const sent = (
    list: ReturnType<typeof declared>,
    url: string,
    options: Partial<Parameters<typeof declaredListArguments>[2]> = {},
  ) =>
    declaredListArguments(list, readDeclaredListState(list, new URL(url)), {
      mode: 'page',
      now,
      queryId,
      scopeArguments: {},
      ...options,
    }) as unknown as Sent;
  const page = sent(items, 'http://list.local/?q=bc-0042&page=2', {
    pageOffset: 50,
  });
  assert.deepEqual(page.list.searchChildren, children);
  assert.deepEqual(
    sent(items, 'http://list.local/', { mode: 'count' }).list.searchChildren,
    children,
  );
  const parse = (value: Sent) =>
    listBehavior.parseSharedListArguments(
      value as unknown as Parameters<
        typeof listBehavior.parseSharedListArguments
      >[0],
      { declaredParameterIds: [], maximumResultCount: 100, queryId },
    );
  assert.deepEqual(parse(page)?.searchChildren, children);
  assert.equal(parse(page)?.pageOffset, 50);
  // A cursor minted for a search through the aliases never pages one without.
  const { searchChildren: _children, ...without } = page.list;
  void _children;
  assert.throws(
    () => parse({ list: without }),
    (error: unknown) =>
      error instanceof listBehavior.SharedListContractError &&
      error.code === 'LIST_CURSOR_INVALID',
  );

  const stock = declared('item_stock_list');
  const all = sent(stock, 'http://list.local/', {
    queryId: id('query', 'item_stock_list'),
  });
  assert.deepEqual(all.list.figures?.choices, [
    {
      byFieldId: id('field', 'item_reorder_rule'),
      cases: [
        {
          value: {
            percent: {
              company: {
                fieldId: id('field', 'legal_entity_reorder_point_percent'),
                queryId: id('query', 'legal_entity_list'),
              },
              of: { fieldId: id('field', 'item_reorder_up_to') },
            },
          },
          values: [id('option', 'item_reorder_rule_company')],
        },
      ],
      figureId: id('list_figure', 'item_stock_list_reorder_point'),
      otherwise: { fieldId: id('field', 'item_reorder_point') },
    },
  ]);
  const status = id('list_figure', 'item_stock_list_status');
  const band = all.list.figures?.bands?.find(
    (value) => value.figureId === status,
  );
  assert.deepEqual(band?.cases[0], {
    value: id('list_band', 'item_stock_list_not_stocked'),
    when: {
      fieldId: id('field', 'item_inventory_policy'),
      values: [id('option', 'item_inventory_policy_non_stocked')],
    },
  });
  assert.deepEqual(band?.cases.at(-1), {
    value: id('list_band', 'item_stock_list_reorder'),
    atMost: { figureId: id('list_figure', 'item_stock_list_reorder_point') },
  });
  assert.equal(
    figureBandLabel(
      stock,
      status,
      id('list_band', 'item_stock_list_not_stocked'),
    ),
    'Not stocked',
  );
});

test("inventory value is a declared List; an item's cost is read through its valuation query", () => {
  const definition = composedApplicationDefinition();
  const surfaces = definition.surfaces as Record<string, unknown>[];
  const list = surfaces.find(
    (surface) =>
      surface.surfaceId === 'northstar.app:surface.inventory_value_list',
  )!;
  const declaration = SurfaceListSchema.parse(list.list);
  assert.deepEqual(
    declaration.columns.map((column) => column.label),
    [
      'Item',
      'On hand',
      'Average cost',
      'Known value',
      'Unvalued quantity',
      'Landed cost coverage',
    ],
  );
  assert.ok(declaration.columns.slice(1).every((column) => !column.sortable));
  // INTEGRATION (decision I-V1): the item page stays INVENTORY-PARITY's stock
  // page, read through the plain item get and entered through the Posted
  // stock List, which REPLENISHMENT, LOCATIONS, CATALOG-EXTRAS and
  // WAREHOUSE-MODE build on. VALUATION's figures are the Inventory value
  // List's, read per item through inventory_value_get; putting them on the
  // item page as well is owed to a combined page.
  const item = surfaces.find(
    (surface) => surface.surfaceId === 'northstar.app:surface.item_detail',
  )!;
  assert.equal(
    (item.dataSource as { targetId?: string } | undefined)?.targetId,
    'northstar.app:query.item_get',
  );
  const valuation = (definition.queries as Record<string, unknown>[]).find(
    (query) => query.queryId === 'northstar.app:query.inventory_value_get',
  ) as { readModel?: { resultFields?: Record<string, string> } } | undefined;
  assert.deepEqual(Object.values(valuation?.readModel?.resultFields ?? {}), [
    'northstar.app:metric.on_hand',
    'northstar.app:metric.average_cost',
    'northstar.app:metric.inventory_value',
    'northstar.app:metric.unvalued_quantity',
    'northstar.app:metric.landed_cost_coverage',
  ]);
});

test('inventory shipment cost is declared separately from packed facts and customer invoice print fields', async () => {
  const app = composedApplicationDefinition();
  const ns = 'northstar.app';
  const surfaces = app.surfaces as Record<string, unknown>[];
  const queries = app.queries as Record<string, unknown>[];
  const shipment = SurfaceCompositionSchema.parse(
    surfaces.find(
      (surface) => surface.surfaceId === `${ns}:surface.shipment_detail`,
    )!.composition,
  );
  const relief = shipment.children.find(
    (child) => child.datasetId === `${ns}:dataset.shipment_relief`,
  )!;
  assert.equal(
    relief.query.targetId,
    `${ns}:query.valuation_shipment_line_list`,
  );
  assert.ok(
    relief.columns.some(
      (column) => column.field === `${ns}:metric.cost_of_goods`,
    ),
  );
  const invoice = SurfaceCompositionSchema.parse(
    surfaces.find(
      (surface) =>
        surface.surfaceId === `${ns}:surface.customer_invoice_detail`,
    )!.composition,
  );
  const margin = invoice.fields.find(
    (column) => column.field === `${ns}:metric.product_margin`,
  )!;
  const cost = invoice.fields.find(
    (column) => column.field === `${ns}:metric.cost_of_goods`,
  )!;
  const printed = [
    ...invoice.presentation!.header!.facts,
    ...invoice.presentation!.print!.totals!,
  ];
  assert.ok(
    !printed.includes(margin.columnId) && !printed.includes(cost.columnId),
  );
  const compiled = await governedProjection<{
    queries: {
      queryId: string;
      sourceEntityId: string;
      queryType: string;
      readModel?: unknown;
    }[];
  }>('northstar.compiler:projection-family.query-catalog');
  for (const local of ['shipment_get', 'customer_invoice_get']) {
    assert.ok(
      compiled.payload.queries.some(
        (query) =>
          query.sourceEntityId ===
            `${ns}:entity.${local.replace('_get', '')}` &&
          query.queryType === 'get' &&
          query.readModel === undefined,
      ),
      'the serving compiled artifact retains a plain get for admission',
    );
    const stored = queries.find(
      (query) => query.queryId === `${ns}:query.${local}`,
    )!;
    assert.ok(
      stored,
      'release admission retains a plain get for each costed entity',
    );
    assert.equal(stored.readModel, undefined);
    assert.equal(stored.queryType, 'get');
    const model = queries.find(
      (query) => query.queryId === `${ns}:query.valuation_${local}`,
    )!.readModel as {
      capability: { targetId: string };
      queries: Record<string, { targetId: string }>;
    };
    assert.equal(
      model.capability.targetId,
      'northstar.inventory:capability.valuation',
    );
    assert.ok(
      Object.values(model.queries).every(
        (dependency) =>
          !queries.find((query) => query.queryId === dependency.targetId)!
            .readModel,
      ),
    );
  }
});
