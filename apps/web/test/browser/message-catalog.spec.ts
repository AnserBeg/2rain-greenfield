import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
} from '../../../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  type CurrentPolicyGateway,
} from '../../../../packages/runtime/src/request-runtime-view.js';
import { createSurfaceRuntimeServer } from '../../src/app-server.js';
import { renderSurfaceDataComponent } from '../../src/component-registry.js';
import { createDemoRequestRuntimeEntry } from '../../src/demo-runtime.js';
import {
  SURFACE_MESSAGE_CATALOG,
  SURFACE_MESSAGE_CODES,
  type SurfaceMessageCode,
} from '../../src/message-catalog.js';
import {
  QUERY_DIAGNOSTIC_CODES,
  type QueryDiagnosticCode,
} from '../../src/message-catalog.js';
import { readCompiledSurfaceManifest } from '../../src/surface-contract.js';
import { renderApplicationDiagnostic } from '../../src/surface-runtime.js';
import { compiledFixturePath, demoEntry } from '../helpers.js';

/**
 * ADR-0048 §5. The claim is *the user read the registered sentence*, and before
 * this file nothing observed it: `surface-data-binding.spec.ts:364` drives the
 * one path where `QUERY_UNSUPPORTED` rendered a hardcoded string and asserts
 * only that the element carries `data-diagnostic-code="QUERY_UNSUPPORTED"`.
 * Attribute is declaration; `textContent` is the produced effect.
 *
 * **The census comes from `keyof typeof`, never from what a fixture rendered.**
 * That is ADR-0035 §2.2's generative error stated as a rule — the completeness
 * claim there was written from the gate's own coverage and was false.
 *
 * **The expected string is never computed.** Every comparison below reads
 * `SURFACE_MESSAGE_CATALOG[code].sentence` directly. This file deliberately does
 * not import `messageBody`, `surfaceMessage` or `messageStatusRole`; a gate that
 * asked the renderer what it should have rendered would agree with itself.
 * `surface-runtime-contract.test.ts` asserts that abstention against this file's
 * source rather than leaving it to this comment.
 */

interface RenderedMessageSample {
  readonly code: string;
  readonly detail: string;
  readonly detailCount: number;
  readonly sentence: string;
  readonly sentenceCount: number;
  readonly statusRole: string;
  readonly visible: boolean;
}

/**
 * The subject selector is `[role="alert"]`, not `[data-diagnostic-code]`. A
 * message that loses its code attribute is still collected and reported, rather
 * than dropping out of the sample and leaving the gate green over an empty set.
 */
async function readMessageSamples(
  page: Page,
): Promise<readonly RenderedMessageSample[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"]')]
      .map((element) => {
        const style = getComputedStyle(element);
        const text = (selector: string): string =>
          (element.querySelector(selector)?.textContent ?? '').trim();
        const rectangle = element.getBoundingClientRect();
        return {
          code: element.getAttribute('data-diagnostic-code') ?? '',
          detail: text('[data-message-detail]'),
          detailCount: element.querySelectorAll('[data-message-detail]').length,
          sentence: text('[data-message-sentence]'),
          sentenceCount: element.querySelectorAll('[data-message-sentence]')
            .length,
          statusRole: element.getAttribute('data-status-role') ?? '',
          visible:
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number.parseFloat(style.opacity) > 0 &&
            rectangle.width > 0 &&
            rectangle.height > 0,
        };
      })
      .sort((left, right) => left.code.localeCompare(right.code)),
  );
}

/**
 * Pure, so every control below feeds it a perturbed observation rather than
 * needing a perturbed application. Same shape as `observeRedundantEncoding` in
 * `surface-grammar.spec.ts`.
 */
function observeCatalogMessages(
  samples: readonly RenderedMessageSample[],
  expectedCodes: readonly string[],
): string[] {
  const violations: string[] = [];
  if (expectedCodes.length === 0) violations.push('ZERO_CODES_READ');
  if (samples.length === 0) violations.push('NO_MESSAGE_OBSERVED');

  const observed = new Set<string>();
  for (const sample of samples) {
    if (sample.code === '') {
      violations.push('MESSAGE_CODE_ABSENT');
      continue;
    }
    observed.add(sample.code);
    const entry = (
      SURFACE_MESSAGE_CATALOG as Readonly<
        Record<string, (typeof SURFACE_MESSAGE_CATALOG)[SurfaceMessageCode]>
      >
    )[sample.code];
    if (!entry) {
      violations.push(`MESSAGE_CODE_UNREGISTERED:${sample.code}`);
      continue;
    }
    if (!sample.visible) {
      // Text nobody can see is not text the user read, so this is reported
      // alone rather than as three violations for one cause.
      violations.push(`MESSAGE_IMPERCEPTIBLE:${sample.code}`);
      continue;
    }
    if (sample.sentenceCount !== 1) {
      violations.push(`MESSAGE_SENTENCE_ABSENT:${sample.code}`);
    } else if (sample.sentence !== entry.sentence) {
      violations.push(`MESSAGE_SENTENCE_MISMATCH:${sample.code}`);
    }
    if (sample.detailCount !== 1) {
      violations.push(`MESSAGE_DETAIL_ABSENT:${sample.code}`);
    } else if (sample.detail !== entry.detail) {
      violations.push(`MESSAGE_DETAIL_MISMATCH:${sample.code}`);
    }
    const expectedRole =
      entry.consequence === 'blocking' ? 'blocked' : 'attention';
    if (sample.statusRole !== expectedRole) {
      violations.push(`MESSAGE_STATUS_ROLE_MISMATCH:${sample.code}`);
    }
  }
  for (const code of expectedCodes) {
    if (!observed.has(code)) violations.push(`MESSAGE_NOT_RENDERED:${code}`);
  }
  return violations.sort();
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('gate server did not bind a TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** A demo shell whose compiled fixture has been perturbed in one place. */
async function mutatedFixtureUrl(
  label: string,
  mutate: (surface: {
    payload: Record<string, unknown>;
    payloadSchemaVersion: string;
  }) => void,
): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), `u6a-${label}-`));
  temporaryDirectories.push(directory);
  const fixture = JSON.parse(readFileSync(compiledFixturePath, 'utf8')) as {
    projections: {
      surface: {
        payload: Record<string, unknown>;
        payloadSchemaVersion: string;
      };
    };
  };
  mutate(fixture.projections.surface);
  const path = join(directory, 'mutated.json');
  writeFileSync(path, JSON.stringify(fixture));
  return await listen(
    createSurfaceRuntimeServer(
      createDemoRequestRuntimeEntry({
        compiledFixturePath: path,
        environmentId: '20000000-0000-4000-8000-000000000002',
        pointerFence: 7,
        pointerId: '30000000-0000-4000-8000-000000000003',
        principalId: '40000000-0000-4000-8000-000000000004',
        releaseId: '50000000-0000-4000-8000-000000000005',
        tenantId: '10000000-0000-4000-8000-000000000001',
      }),
    ),
  );
}

/** A shell whose entry refuses before any release can be pinned. */
async function refusingEntryUrl(
  authenticate: () => Promise<AuthenticatedIdentity | null>,
  load: () => Promise<never>,
): Promise<string> {
  const policy: CurrentPolicyGateway = Object.freeze({
    async authorize() {
      return Object.freeze({
        decision: 'ALLOW' as const,
        decisionVersion: 'northstar.current-policy-decision/v1' as const,
        policyVersion: 'gate-policy-v1',
      });
    },
    async readCurrentVersion() {
      return Object.freeze({ policyVersion: 'gate-policy-v1' });
    },
  });
  return await listen(
    createSurfaceRuntimeServer(
      new AuthenticatedRequestRuntimeEntryAdapter(
        new AuthenticatedRequestEntryAdapter(authenticate),
        Object.freeze({ load }),
        policy,
      ),
    ),
  );
}

const identity: AuthenticatedIdentity = Object.freeze({
  environmentId: '20000000-0000-4000-8000-000000000002',
  principalId: '40000000-0000-4000-8000-000000000004',
  tenantId: '10000000-0000-4000-8000-000000000001',
});

/**
 * Serves whatever `renderApplicationDiagnostic` produces for one code. This is
 * the census half of the gate: it proves the shared body renderer is faithful
 * for **all** registered codes, and it deliberately proves nothing about
 * reachability — that is what the real-path drivers below are for, and what the
 * declared shortfall accounts for.
 */
async function censusServerUrl(): Promise<string> {
  const surface = await demoEntry().run(
    {},
    (view) => readCompiledSurfaceManifest(view).surfaces[0]!,
  );
  return await listen(
    createServer((request, response) => {
      const parameters = new URL(request.url ?? '/', 'http://gate.local')
        .searchParams;
      const code = parameters.get('code') ?? '';
      const slot = parameters.get('shape') === 'slot';
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (slot) {
        // The slot renderer is a second path to the same catalog. Observing
        // only the page renderer would leave every QUERY_* code's real
        // treatment unmeasured.
        response.end(
          `<!doctype html><html lang="en"><body>${renderSurfaceDataComponent({
            data: { code: code as QueryDiagnosticCode, status: 'DIAGNOSTIC' },
            feedback: null,
            operations: [],
            surface,
          })}</body></html>`,
        );
        return;
      }
      response.end(
        renderApplicationDiagnostic(
          422,
          code === 'UNSUPPORTED_COMPONENT'
            ? { code, subject: 'northstar.shell:component.absent' }
            : {
                code: code as Exclude<
                  SurfaceMessageCode,
                  'UNSUPPORTED_COMPONENT'
                >,
              },
        ).html,
      );
    }),
  );
}

let shellUrl: string;
let censusUrl: string;
let methodProbeUrl: string;
const realPathUrls = new Map<string, string>();

test.beforeAll(async () => {
  shellUrl = await listen(createSurfaceRuntimeServer(demoEntry()));
  censusUrl = await censusServerUrl();
  methodProbeUrl = await listen(
    createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      // Playwright's page.goto cannot issue a POST, so the method is exercised
      // by a real form submission from a separate origin — which is also how a
      // browser would actually produce this fault.
      response.end(
        `<!doctype html><html lang="en"><body><form id="probe" method="post" action="${shellUrl}/"><button type="submit">post</button></form></body></html>`,
      );
    }),
  );

  realPathUrls.set(
    'INVALID_SURFACE_MANIFEST',
    await mutatedFixtureUrl('manifest', ({ payload }) => {
      payload.surfaces = 'not-an-array';
    }),
  );
  realPathUrls.set(
    'UNSUPPORTED_SURFACE_VERSION',
    await mutatedFixtureUrl('version', (surface) => {
      // The version fence is on the projection envelope. Mutating
      // payload.schemaVersion instead trips INVALID_SURFACE_MANIFEST, which is
      // what surface-runtime-contract.test.ts:227 already drives.
      surface.payloadSchemaVersion =
        'northstar.surface-manifest-payload/unsupported';
    }),
  );
  realPathUrls.set(
    'NO_ACTIVE_SURFACE',
    await mutatedFixtureUrl('retired', ({ payload }) => {
      for (const surface of payload.surfaces as Record<string, unknown>[]) {
        surface.lifecycle = 'retired';
      }
    }),
  );
  realPathUrls.set(
    'DUPLICATE_SURFACE_ID',
    await mutatedFixtureUrl('duplicate', ({ payload }) => {
      const surfaces = payload.surfaces as Record<string, unknown>[];
      surfaces.push({ ...surfaces[0] });
    }),
  );
  realPathUrls.set(
    'INVALID_SURFACE_SLOT',
    await mutatedFixtureUrl('slot', ({ payload }) => {
      const surfaces = payload.surfaces as Record<string, unknown>[];
      const slots = surfaces[0]!.slots as Record<string, unknown>[];
      slots.push({ ...slots[0] });
    }),
  );
  realPathUrls.set(
    'AUTHENTICATION_REQUIRED',
    await refusingEntryUrl(
      async () => null,
      async () => {
        throw new Error('unreachable: authentication refuses first');
      },
    ),
  );
  realPathUrls.set(
    'REQUEST_RUNTIME_VIEW_UNAVAILABLE',
    await refusingEntryUrl(
      async () => identity,
      async () => {
        throw new Error('gate: definition loader is unavailable');
      },
    ),
  );
});

test.afterAll(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Reachability census — declared, never implied
// ---------------------------------------------------------------------------

/**
 * A real-path driver navigates a request that raises the code the way the
 * application raises it, so it observes reachability *and* text. Every entry is
 * a URL a browser can reach.
 */
const REAL_PATH_DRIVERS: Readonly<
  Partial<Record<SurfaceMessageCode, (page: Page) => Promise<unknown>>>
> = {
  AUTHENTICATION_REQUIRED: (page) =>
    page.goto(realPathUrls.get('AUTHENTICATION_REQUIRED')!),
  COMPONENT_RENDER_FAILED: (page) =>
    page.goto(`${shellUrl}/?surface=${encodeURIComponent(rendererErrorId())}`),
  DUPLICATE_SURFACE_ID: (page) =>
    page.goto(realPathUrls.get('DUPLICATE_SURFACE_ID')!),
  INVALID_SURFACE_MANIFEST: (page) =>
    page.goto(realPathUrls.get('INVALID_SURFACE_MANIFEST')!),
  INVALID_SURFACE_SLOT: (page) =>
    page.goto(realPathUrls.get('INVALID_SURFACE_SLOT')!),
  METHOD_NOT_ALLOWED: async (page) => {
    await page.goto(methodProbeUrl);
    await page.getByRole('button', { name: 'post' }).click();
    await page.waitForURL(`${shellUrl}/`);
  },
  NO_ACTIVE_SURFACE: (page) =>
    page.goto(realPathUrls.get('NO_ACTIVE_SURFACE')!),
  REQUEST_RUNTIME_VIEW_UNAVAILABLE: (page) =>
    page.goto(realPathUrls.get('REQUEST_RUNTIME_VIEW_UNAVAILABLE')!),
  ROUTE_NOT_FOUND: (page) => page.goto(`${shellUrl}/not-a-route`),
  UNKNOWN_SURFACE: (page) => page.goto(`${shellUrl}/?surface=not-in-release`),
  UNSUPPORTED_COMPONENT: (page) =>
    page.goto(`${shellUrl}/?surface=${encodeURIComponent(unsupportedId())}`),
  UNSUPPORTED_SURFACE_VERSION: (page) =>
    page.goto(realPathUrls.get('UNSUPPORTED_SURFACE_VERSION')!),
  UNTRUSTED_CONTEXT_REJECTED: async (page) => {
    // A caller-supplied identity header is the whole fault; it must be sent on
    // the real request rather than simulated.
    await page.setExtraHTTPHeaders({ 'x-tenant-id': 'caller-chosen' });
    await page.goto(shellUrl);
    await page.setExtraHTTPHeaders({});
  },
};

/**
 * **Declared, with a reason each. A subset is acceptable; an implied 27 is
 * not.** Every code here is still text-observed by the census pass below; what
 * is missing is a real-path drive, so reachability for these rests on the
 * source-literal check in `surface-runtime-contract.test.ts` rather than on an
 * executed request.
 */
const DECLARED_NO_REAL_PATH_DRIVER: Readonly<
  Partial<Record<SurfaceMessageCode, string>>
> = {
  INVALID_SURFACE_BINDING:
    'Not reachable under its own name at all. readCompiledSurfaceDataBinding ' +
    'throws SurfaceProjectionError(INVALID_SURFACE_BINDING) and ' +
    'surface-runtime.ts:113 catches it and renders QUERY_UNSUPPORTED, so no ' +
    'request can produce this code. That is a code-accuracy defect reported as ' +
    'a finding, not a copy defect; correcting it moves a data-diagnostic-code ' +
    'that surface-data-binding.spec.ts:364 asserts, which this packet is ' +
    'fenced from moving. Text is still observed by the census pass.',
  INVALID_SURFACE_NAVIGATION:
    'Reachable, and already driven by a real request in ' +
    'surface-grammar.spec.ts:230, which owns the over-budget grouped-navigation ' +
    'fixture and the v0-reader server built on it. Rebuilding that fixture here ' +
    'would put a second authority for one compiled navigation tree in the ' +
    'repository, which is the defect this programme keeps paying for elsewhere.',
  OPERATION_CONFIRMATION_REQUIRED:
    'Write path. Producing it needs the compile-and-serve gateway fixture that ' +
    'surface-data-binding.spec.ts owns — a compiled ordinaryModuleV1 release, ' +
    'a mediation authority and a stateful executor, about 150 lines. Copying ' +
    'that here creates a second authority for one fixture module; the right ' +
    'home for a real-path drive is that spec, and it is routed as follow-up.',
  OPERATION_CONFIRMATION_STALE:
    'Write path, same gateway fixture. Additionally needs a grant issued and ' +
    'then invalidated by changing the input between preview and confirm, which ' +
    'is a two-request journey the fixture above exists to support.',
  OPERATION_PERMISSION_DENIED:
    'Write path, same gateway fixture, plus a denying CurrentPolicyGateway. ' +
    'Every server in this file composes an allow-policy because the codes it ' +
    'drives arise before policy is consulted.',
  OPERATION_UNAVAILABLE:
    'Write path, same gateway fixture, plus an executor that fails the ' +
    'operation after it is accepted. Reached through the residual branch of ' +
    'operationMessageCode, which the unit-level mapping test covers directly.',
  OPERATION_UNSUPPORTED:
    'Write path, same gateway fixture. Needs a surface whose compiled operation ' +
    'binding is absent or whose intent is unregistered, which the demo shell ' +
    'fixture has no surface for.',
  QUERY_AMBIGUOUS:
    'Read path. Needs a query gateway whose executor returns the ambiguous ' +
    'outcome, which means the compile-and-serve fixture above. The demo shell ' +
    'is composed without gateways and cannot reach a read outcome at all.',
  QUERY_LEGAL_ENTITY_SCOPE_REQUIRED:
    'Read path, and already driven by a real request against the real composed ' +
    'release in composed-application.spec.ts:989. Needs a legal-entity-scoped ' +
    'query, which exists only in the composed application, not the demo shell.',
  QUERY_NOT_FOUND:
    'Read path, and already driven by a real request in ' +
    'composed-application.spec.ts:1463 against a failed record slot. Same ' +
    'gateway-fixture reason as the rest of the read path.',
  QUERY_PARAMETER_REQUIRED:
    'Read path. Needs an aggregate query with declared parameters left blank; ' +
    'the demo shell fixture declares no aggregate surface, so this needs the ' +
    'composed release or the gateway fixture.',
  QUERY_PERMISSION_DENIED:
    'Read path, same gateway fixture, plus a denying CurrentPolicyGateway for ' +
    'the same reason as the operation case above.',
  QUERY_UNAVAILABLE:
    'Read path, and already driven by a real request in ' +
    'surface-data-binding.spec.ts:262, whose executor fails one slot while ' +
    'siblings render. Same gateway-fixture reason.',
  QUERY_UNSUPPORTED:
    'Read path, and already driven by a real request in ' +
    'surface-data-binding.spec.ts:364 — the exact tree ADR-0048 was ruled on. ' +
    'Same gateway-fixture reason.',
};

function partitionViolations(
  census: readonly string[],
  drivers: readonly string[],
  declared: readonly string[],
): string[] {
  const violations: string[] = [];
  const driverSet = new Set(drivers);
  const declaredSet = new Set(declared);
  for (const code of census) {
    const covered = driverSet.has(code);
    const excused = declaredSet.has(code);
    if (covered && excused)
      violations.push(`CODE_BOTH_DRIVEN_AND_EXCUSED:${code}`);
    if (!covered && !excused) violations.push(`CODE_UNACCOUNTED:${code}`);
  }
  for (const code of [...drivers, ...declared]) {
    if (!census.includes(code)) violations.push(`CODE_NOT_REGISTERED:${code}`);
  }
  return violations.sort();
}

test('every registered code is either driven by a real path or declared with a reason', () => {
  expect(
    partitionViolations(
      SURFACE_MESSAGE_CODES,
      Object.keys(REAL_PATH_DRIVERS),
      Object.keys(DECLARED_NO_REAL_PATH_DRIVER),
    ),
  ).toEqual([]);
  for (const reason of Object.values(DECLARED_NO_REAL_PATH_DRIVER)) {
    expect(reason.length).toBeGreaterThan(40);
  }
  console.log(
    `message catalog reachability: ${Object.keys(REAL_PATH_DRIVERS).length} of ` +
      `${SURFACE_MESSAGE_CODES.length} codes driven by a real request path; ` +
      `${Object.keys(DECLARED_NO_REAL_PATH_DRIVER).length} declared without one`,
  );
});

test('reachability red: a registered code with neither a driver nor a reason is unaccounted', () => {
  expect(
    partitionViolations(
      [...SURFACE_MESSAGE_CODES, 'A_CODE_NOBODY_RAISES'],
      Object.keys(REAL_PATH_DRIVERS),
      Object.keys(DECLARED_NO_REAL_PATH_DRIVER),
    ),
  ).toEqual(['CODE_UNACCOUNTED:A_CODE_NOBODY_RAISES']);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('every registered code renders the sentence the catalog registers', async ({
  page,
}) => {
  const violations: string[] = [];
  for (const code of SURFACE_MESSAGE_CODES) {
    await page.goto(`${censusUrl}/?code=${encodeURIComponent(code)}`);
    violations.push(
      ...observeCatalogMessages(await readMessageSamples(page), [code]),
    );
  }
  expect(violations).toEqual([]);
});

test('the slot renderer resolves the same catalog as the page renderer', async ({
  page,
}) => {
  const violations: string[] = [];
  for (const code of QUERY_DIAGNOSTIC_CODES) {
    await page.goto(
      `${censusUrl}/?shape=slot&code=${encodeURIComponent(code)}`,
    );
    violations.push(
      ...observeCatalogMessages(await readMessageSamples(page), [code]),
    );
  }
  expect(violations).toEqual([]);
});

test('real request paths render the sentence the catalog registers', async ({
  page,
}) => {
  const violations: string[] = [];
  for (const [code, drive] of Object.entries(REAL_PATH_DRIVERS)) {
    await drive(page);
    violations.push(
      ...observeCatalogMessages(await readMessageSamples(page), [code]),
    );
  }
  expect(violations).toEqual([]);
});

// ---------------------------------------------------------------------------
// Controls — one per vacuity vector, not one overall
// ---------------------------------------------------------------------------

test('control: a page rendering no message reds on zero observed', async ({
  page,
}) => {
  // Live half: the healthy shell root carries no alert at all, so the selector
  // is not matching everything, and the observer reds when handed that page.
  await page.goto(shellUrl);
  const healthy = await readMessageSamples(page);
  expect(healthy).toHaveLength(0);
  expect(observeCatalogMessages(healthy, ['UNKNOWN_SURFACE'])).toEqual([
    'MESSAGE_NOT_RENDERED:UNKNOWN_SURFACE',
    'NO_MESSAGE_OBSERVED',
  ]);
});

test('control: a census that reads zero codes reds instead of passing empty', async ({
  page,
}) => {
  await page.goto(`${censusUrl}/?code=UNKNOWN_SURFACE`);
  const samples = await readMessageSamples(page);
  expect(samples).toHaveLength(1);
  expect(observeCatalogMessages(samples, [])).toEqual(['ZERO_CODES_READ']);
});

test('control: the live tree — correct code attribute, sentence from somewhere else', async ({
  page,
}) => {
  // This is the defect ADR-0048 was ruled on, reproduced from a real rendering:
  // the element carries the right code and the wrong words. The attribute
  // assertion that shipped on main passes here; this gate does not.
  await page.goto(`${censusUrl}/?code=QUERY_UNSUPPORTED`);
  const [rendered] = await readMessageSamples(page);
  expect(rendered?.code).toBe('QUERY_UNSUPPORTED');
  const hardcoded = {
    ...rendered!,
    sentence: 'Compiled surface unavailable',
  };
  expect(observeCatalogMessages([hardcoded], ['QUERY_UNSUPPORTED'])).toEqual([
    'MESSAGE_SENTENCE_MISMATCH:QUERY_UNSUPPORTED',
  ]);
});

test('control: a message rendered without its code attribute reds rather than being skipped', async ({
  page,
}) => {
  await page.goto(`${censusUrl}/?code=NO_ACTIVE_SURFACE`);
  await page.evaluate(() => {
    document
      .querySelector('[role="alert"]')
      ?.removeAttribute('data-diagnostic-code');
  });
  const samples = await readMessageSamples(page);
  expect(samples).toHaveLength(1);
  expect(observeCatalogMessages(samples, ['NO_ACTIVE_SURFACE'])).toEqual([
    'MESSAGE_CODE_ABSENT',
    'MESSAGE_NOT_RENDERED:NO_ACTIVE_SURFACE',
  ]);
});

test('control: a message hidden from the user reds as imperceptible, not as correct text', async ({
  page,
}) => {
  await page.goto(`${censusUrl}/?code=ROUTE_NOT_FOUND`);
  await page.addStyleTag({
    content: '[role="alert"]{display:none!important}',
  });
  expect(
    observeCatalogMessages(await readMessageSamples(page), ['ROUTE_NOT_FOUND']),
  ).toEqual(['MESSAGE_IMPERCEPTIBLE:ROUTE_NOT_FOUND']);
});

test('control: an unregistered code rendered on the page is reported, not ignored', async ({
  page,
}) => {
  await page.goto(`${censusUrl}/?code=UNKNOWN_SURFACE`);
  await page.evaluate(() => {
    document
      .querySelector('[role="alert"]')
      ?.setAttribute('data-diagnostic-code', 'NOT_IN_THE_CATALOG');
  });
  expect(
    observeCatalogMessages(await readMessageSamples(page), ['UNKNOWN_SURFACE']),
  ).toEqual([
    'MESSAGE_CODE_UNREGISTERED:NOT_IN_THE_CATALOG',
    'MESSAGE_NOT_RENDERED:UNKNOWN_SURFACE',
  ]);
});

function compiledSurfaces(): readonly Record<string, unknown>[] {
  const fixture = JSON.parse(readFileSync(compiledFixturePath, 'utf8')) as {
    projections: {
      surface: { payload: { surfaces: Record<string, unknown>[] } };
    };
  };
  return fixture.projections.surface.payload.surfaces;
}

function unsupportedId(): string {
  const surface = compiledSurfaces().find(
    (candidate) => candidate.label === 'Unsupported component',
  );
  if (!surface) throw new Error('compiled unsupported surface is missing');
  return String(surface.surfaceId);
}

function rendererErrorId(): string {
  const surface = compiledSurfaces().find(
    (candidate) => candidate.label === 'Renderer error',
  );
  if (!surface) throw new Error('compiled renderer-error surface is missing');
  return String(surface.surfaceId);
}
