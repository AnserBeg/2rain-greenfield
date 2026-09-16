import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { RequestRuntimeViewLoadError } from '@north-star/postgres-provider/request-runtime-view-service';

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
  QUERY_DIAGNOSTIC_CODES,
  SURFACE_MESSAGE_CATALOG,
  SURFACE_MESSAGE_CODES,
  type QueryDiagnosticCode,
  type SurfaceMessageCode,
  type SurfaceMessageRef,
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

/**
 * The subject the census server is asked to render. Declared here, used both to
 * drive the render and to expect it — so the expected value comes from this
 * fixture, never from the renderer under test.
 */
const CENSUS_SUBJECT = 'northstar.shell:component.absent';
const CENSUS_LEGAL_ENTITY_SUBJECT = '74000000-0000-4000-8000-000000000099';
const CENSUS_RELATION_SUBJECT = 'northstar.inventory:relation.line_transaction';
const CENSUS_OPERATION_REFUSAL_SUBJECT = 'MODULE_REQUIRED_FIELD_MISSING';
const CENSUS_RUNTIME_VIEW_REFUSAL_SUBJECT = 'UNSUPPORTED_RUNTIME_CAPABILITY';
const CENSUS_SUBJECTS = Object.freeze({
  OPERATION_LEGAL_ENTITY_INACTIVE: CENSUS_LEGAL_ENTITY_SUBJECT,
  OPERATION_REFUSED: CENSUS_OPERATION_REFUSAL_SUBJECT,
  RELATION_ENUMERATION_UNAVAILABLE: CENSUS_RELATION_SUBJECT,
  REQUEST_RUNTIME_VIEW_REFUSED: CENSUS_RUNTIME_VIEW_REFUSAL_SUBJECT,
  UNSUPPORTED_COMPONENT: CENSUS_SUBJECT,
});

function censusMessageRef(code: SurfaceMessageCode): SurfaceMessageRef {
  switch (code) {
    case 'OPERATION_LEGAL_ENTITY_INACTIVE':
      return { code, subject: CENSUS_LEGAL_ENTITY_SUBJECT };
    case 'OPERATION_REFUSED':
      return { code, subject: CENSUS_OPERATION_REFUSAL_SUBJECT };
    case 'RELATION_ENUMERATION_UNAVAILABLE':
      return { code, subject: CENSUS_RELATION_SUBJECT };
    case 'REQUEST_RUNTIME_VIEW_REFUSED':
      return { code, subject: CENSUS_RUNTIME_VIEW_REFUSAL_SUBJECT };
    case 'UNSUPPORTED_COMPONENT':
      return { code, subject: CENSUS_SUBJECT };
    default:
      return { code };
  }
}

interface MessagePart {
  readonly count: number;
  readonly text: string;
  readonly visible: boolean;
}

interface RenderedMessageSample {
  readonly code: string;
  readonly detail: MessagePart;
  readonly nextAction: MessagePart;
  readonly role: string;
  readonly sentence: MessagePart;
  readonly statusRole: string;
  readonly subject: MessagePart;
  readonly visible: boolean;
}

/**
 * The subject selector is `[data-message]` — the census marker every catalog
 * treatment carries — **not** `[role="alert"]`. Sampling by role fixed the
 * census to diagnostics and could never have seen a success confirmation
 * (`role="status"`) or an empty state (no role at all). That selector change
 * means such a treatment would be *sampled*; it does **not** mean `U6b` is
 * covered. `U6b` owes real-path observations of its own renderers, and an
 * earlier version of this comment implying otherwise was wrong.
 *
 * Visibility is read per element **and through its ancestors**. Hiding
 * `[data-message-sentence]` alone leaves the card visible and its `textContent`
 * readable; an ancestor at `opacity: 0` leaves every descendant reporting
 * opacity 1 with a non-zero rectangle, because opacity composites rather than
 * inherits.
 *
 * **What this still cannot prove, stated rather than implied** (AGENTS.md §6).
 * "Perceptible" here means: laid out with a non-zero box, and no ancestor
 * applying `display:none`, `visibility:hidden` or a zero effective opacity. It
 * is **not** "the user read the text". It does not observe clipping by an
 * `overflow:hidden` ancestor, displacement outside the viewport or behind
 * another element, `color: transparent` or text painted on a ground of its own
 * colour, `clip-path`, `filter: opacity(0)`, or `content-visibility: hidden`.
 * Closing those needs pixel sampling or an accessibility-tree read, and neither
 * is in this packet.
 */
async function readMessageSamples(
  page: Page,
): Promise<readonly RenderedMessageSample[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll('[data-message]')]
      .map((element) => {
        const perceptible = (node: Element): boolean => {
          const rectangle = node.getBoundingClientRect();
          if (rectangle.width <= 0 || rectangle.height <= 0) return false;
          // Opacity COMPOSITES through ancestors; it does not inherit. A
          // wrapper at opacity:0 leaves every descendant reporting 1 with a
          // non-zero rectangle, so reading each node's own style called an
          // invisible card fully visible. Walk to the document root and
          // multiply.
          let effectiveOpacity = 1;
          for (
            let current: Element | null = node;
            current !== null;
            current = current.parentElement
          ) {
            const style = getComputedStyle(current);
            if (style.display === 'none' || style.visibility === 'hidden') {
              return false;
            }
            effectiveOpacity *= Number.parseFloat(style.opacity);
            if (!(effectiveOpacity > 0)) return false;
          }
          return true;
        };
        const part = (selector: string) => {
          const found = element.querySelectorAll(selector);
          const first = found[0];
          return {
            count: found.length,
            text: (first?.textContent ?? '').trim(),
            visible: first !== undefined && perceptible(first),
          };
        };
        return {
          code: element.getAttribute('data-message') ?? '',
          detail: part('[data-message-detail]'),
          nextAction: part('[data-message-next-action]'),
          role: element.getAttribute('role') ?? '',
          sentence: part('[data-message-sentence]'),
          statusRole: element.getAttribute('data-status-role') ?? '',
          subject: part('[data-message-subject]'),
          visible: perceptible(element),
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
  expectedSubjects: Readonly<Record<string, string>> = {},
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
      // alone rather than as one violation per part for one cause.
      violations.push(`MESSAGE_IMPERCEPTIBLE:${sample.code}`);
      continue;
    }

    // Every registered field of the entry is an effect the user is owed. A part
    // that is required-and-absent, present-and-wrong, or present-and-hidden are
    // three different failures and are named separately.
    const required = (
      label: string,
      part: MessagePart,
      expected: string | null,
    ): void => {
      if (expected === null) {
        if (part.count !== 0)
          violations.push(`MESSAGE_${label}_UNEXPECTED:${sample.code}`);
        return;
      }
      if (part.count !== 1) {
        violations.push(`MESSAGE_${label}_ABSENT:${sample.code}`);
        return;
      }
      if (!part.visible) {
        violations.push(`MESSAGE_${label}_HIDDEN:${sample.code}`);
        return;
      }
      if (part.text !== expected) {
        violations.push(`MESSAGE_${label}_MISMATCH:${sample.code}`);
      }
    };

    required('SENTENCE', sample.sentence, entry.sentence);
    required('DETAIL', sample.detail, entry.detail);
    required('NEXT_ACTION', sample.nextAction, entry.nextAction);
    // The subject is a semantic runtime value — which component the release
    // named — so proving it non-empty proved nothing: shipping a different
    // identifier keeps the count at one, the element visible and the text
    // non-empty. The expected value is derived by the caller from the same
    // fixture that drove the render, never from the renderer.
    required(
      'SUBJECT',
      sample.subject,
      entry.subject === null ? null : (expectedSubjects[sample.code] ?? ''),
    );
    if (entry.subject !== null && expectedSubjects[sample.code] === undefined) {
      violations.push(`MESSAGE_SUBJECT_EXPECTATION_MISSING:${sample.code}`);
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
          censusMessageRef(code as SurfaceMessageCode),
        ).html,
      );
    }),
  );
}

let shellUrl: string;
let censusUrl: string;
let methodProbeUrl: string;
const realPathUrls = new Map<string, string>();
let catalogFixture: ReturnType<typeof spawn>;
let catalogFixtureExit: Promise<unknown[]>;
let requestCatalogMeasurement: (
  phase: string,
  orderId?: string,
) => Promise<Record<string, unknown>>;

test.beforeAll(async () => {
  test.setTimeout(120_000);
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
    'INVALID_SURFACE_FIELD',
    await mutatedFixtureUrl('field', ({ payload }) => {
      // Parity-correct and otherwise well-formed: one entry per selected field,
      // in order, every entry a real kind -- except the first, whose kind alone
      // is outside the reader's closed vocabulary. One property varied, so the
      // refusal is attributable to the kind check and to nothing else.
      for (const surface of payload.surfaces as Record<string, unknown>[]) {
        const fieldIds = surface.fieldIds as string[];
        surface.fields = fieldIds.map((fieldId, index) => ({
          fieldId,
          kind: index === 0 ? 'relationFieldType' : 'textFieldType',
        }));
      }
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
    'REQUEST_RUNTIME_VIEW_REFUSED',
    await refusingEntryUrl(
      async () => identity,
      async () => {
        throw new RequestRuntimeViewLoadError(
          'UNSUPPORTED_RUNTIME_CAPABILITY',
          'gate: pinned runtime capability is unsupported',
        );
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
  catalogFixture = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'test/helpers/order-entry-fixture.ts',
      '--serve',
      '--verify',
    ],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  catalogFixtureExit = once(catalogFixture, 'exit');
  let output = '';
  let consumed = '';
  let resolveReady!: (url: string) => void;
  let rejectReady!: (error: Error) => void;
  let resolveMeasurement:
    ((value: Record<string, unknown>) => void) | undefined;
  let rejectMeasurement: ((error: Error) => void) | undefined;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  catalogFixture.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    consumed += text;
    const match = /ORDER_ENTRY_URL=(.*)/.exec(output);
    if (match) resolveReady(match[1]!);
    const lines = consumed.split('\n');
    consumed = lines.pop()!;
    for (const line of lines)
      if (line.startsWith('ORDER_ENTRY_MEASURED=')) {
        resolveMeasurement?.(
          JSON.parse(line.slice('ORDER_ENTRY_MEASURED='.length)) as Record<
            string,
            unknown
          >,
        );
        resolveMeasurement = undefined;
        rejectMeasurement = undefined;
      }
  });
  catalogFixture.stderr!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  catalogFixture.once('error', rejectReady);
  catalogFixture.once('exit', () => {
    const error = new Error(`catalog fixture exited early\n${output}`);
    rejectReady(error);
    rejectMeasurement?.(error);
  });
  requestCatalogMeasurement = (phase, orderId) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (resolveMeasurement)
        return reject(new Error('catalog measurement already pending'));
      resolveMeasurement = resolve;
      rejectMeasurement = reject;
      catalogFixture.stdin!.write(JSON.stringify({ phase, orderId }) + '\n');
    });
  const entryUrl = new URL(await ready);
  const setup = await requestCatalogMeasurement('catalog_setup');
  const form = (recordId: unknown) => {
    const parameters = new URLSearchParams({
      surface: 'northstar.app:surface.sales_order_form',
      record: String(recordId),
      'northstar.app:parameter.sales_order_get_legal_entity_scope': String(
        setup.scope,
      ),
    });
    return `${entryUrl.origin}/?${parameters}`;
  };
  realPathUrls.set('DRAFT_EDITOR_CONFLICT', form(setup.conflictId));
  realPathUrls.set('DRAFT_EDITOR_LOCKED', form(setup.lockedId));
  const unavailable = new URL(entryUrl.origin);
  unavailable.searchParams.set(
    'surface',
    'northstar.app:surface.sales_order_list',
  );
  unavailable.searchParams.set(
    'northstar.app:parameter.sales_order_list_legal_entity_scope',
    '74000000-0000-4000-8000-000000000099',
  );
  realPathUrls.set('WORKSPACE_COMPANY_UNAVAILABLE', unavailable.href);
});

test.afterAll(async () => {
  catalogFixture.kill('SIGTERM');
  await catalogFixtureExit;
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
  DRAFT_EDITOR_CONFLICT: async (page) => {
    await page.goto(realPathUrls.get('DRAFT_EDITOR_CONFLICT')!);
    await requestCatalogMeasurement(
      'catalog_advance',
      new URL(page.url()).searchParams.get('record')!,
    );
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  },
  DRAFT_EDITOR_LOCKED: (page) =>
    page.goto(realPathUrls.get('DRAFT_EDITOR_LOCKED')!),
  INVALID_SURFACE_FIELD: (page) =>
    page.goto(realPathUrls.get('INVALID_SURFACE_FIELD')!),
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
  REQUEST_RUNTIME_VIEW_REFUSED: (page) =>
    page.goto(realPathUrls.get('REQUEST_RUNTIME_VIEW_REFUSED')!),
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
  WORKSPACE_COMPANY_UNAVAILABLE: (page) =>
    page.goto(realPathUrls.get('WORKSPACE_COMPANY_UNAVAILABLE')!),
};

/**
 * **Declared, with a reason each. A subset is acceptable; an implied 27 is
 * not.** Every code here is still text-observed by the census pass; what is
 * missing is an executed request, so reachability for these rests on the
 * source-literal scan in `surface-runtime-contract.test.ts`.
 *
 * The remaining codes are **two different things, and calling them all
 * "structural" was
 * wrong**:
 *
 * - Some are already driven by a real request in another spec —
 *   `INVALID_SURFACE_BINDING`, `INVALID_SURFACE_NAVIGATION`,
 *   `OPERATION_REFUSED`, `QUERY_LEGAL_ENTITY_SCOPE_REQUIRED`, `QUERY_NOT_FOUND`,
 *   `QUERY_UNAVAILABLE`, `QUERY_UNSUPPORTED`, and
 *   `RELATION_ENUMERATION_UNAVAILABLE`. Their
 *   reachability is observed; only the text assertion lives elsewhere.
 * - The rest are engineering calls about fixture cost and ownership — the
 *   remaining `OPERATION_*` codes plus `QUERY_AMBIGUOUS`, `QUERY_PARAMETER_REQUIRED` and
 *   `QUERY_PERMISSION_DENIED`. Each needs the compile-and-serve gateway fixture
 *   another spec owns. Judgements, defensible, and not structural facts.
 */
const DECLARED_NO_REAL_PATH_DRIVER: Readonly<
  Partial<Record<SurfaceMessageCode, string>>
> = {
  COMPOSITION_BUSY:
    'Requires two concurrent confirmations of one process-local task. The generic census observes text; this file does not own that concurrency fixture.',
  COMPOSITION_CHILD_EMPTY:
    'The initially empty reservation and shipment datasets are exercised by meta-sales.spec.ts against real PostgreSQL; this census observes catalog text.',
  COMPOSITION_CHILD_FAILED:
    'A missing exact-scope receipt is driven in test/integration/surface-data-binding.test.ts; the catalog census is not a second query fixture.',
  COMPOSITION_COMMITTED_WITHHELD:
    'The generic gateway task integration test observes a committed withheld readback and no later step. This census observes its catalog treatment.',
  COMPOSITION_COMPLETE:
    'The real reserve, ship and release paths render this in meta-sales.spec.ts; the independent census checks its registered message text.',
  COMPOSITION_INPUT_INVALID:
    'Negative quantity retention is driven through the browser task in meta-sales.spec.ts. This census checks the catalog treatment independently.',
  COMPOSITION_SELECTION_REQUIRED:
    'Requires a composed child action before any selected row. The census observes text; a separate real-path browser driver is not claimed here.',
  COMPOSITION_TASK_UNAVAILABLE:
    'Requires an expired, foreign or lost process-local task token. The census observes text; no expiration browser driver is claimed here.',
  COMPOSITION_UNCERTAIN:
    'The task integration test injects a gateway transport failure and observes stable inputs and idempotency keys on retry. This census observes text.',
  OPERATION_COMMITTED_READBACK_WITHHELD:
    'Driven through the real receiving gateway and evaluator in ' +
    'receiving.composed-application.spec.ts: a commit-time read-grant revocation ' +
    'shows committed success, trust IDs and no retry form. That spec owns the ' +
    'governed release and PostgreSQL revocation fixture; this census also ' +
    'observes the registered message text.',
  INVALID_SURFACE_BINDING:
    'Reachable, and driven by a real request in surface-data-binding.spec.ts ' +
    'beside unsupported-query and unavailable-runtime-view controls. That ' +
    'test owns the compiled binding fixture needed to vary only the binding.',
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
  OPERATION_INPUT_INVALID:
    'Write path, and already driven by malformed-boolean and malformed-empty-' +
    'intent requests beside their admission twins in surface-data-binding.spec.ts. ' +
    'That file owns the compiled field-kind release and stateful executor needed ' +
    'to prove the request is refused before semantic invocation.',
  OPERATION_LEGAL_ENTITY_INACTIVE:
    'Write path, and driven by a request through the compiled web binding in ' +
    'surface-data-binding.test.ts beside its exact provider subject assertion. ' +
    'A browser driver additionally needs the composed PostgreSQL fixture and ' +
    'an archived legal-entity seed, which this catalog fixture does not own.',
  OPERATION_PERMISSION_DENIED:
    'Write path, same gateway fixture, plus a denying CurrentPolicyGateway. ' +
    'Every server in this file composes an allow-policy because the codes it ' +
    'drives arise before policy is consulted.',
  OPERATION_REFUSED:
    'Write path, and driven by a real provider-parser refusal in ' +
    'surface-data-binding.spec.ts. That file owns the compiled form and ' +
    'stateful executor needed to submit one invalid field while preserving ' +
    'every other write precondition.',
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
  RELATION_ENUMERATION_UNAVAILABLE:
    'Relation create path, and driven by a real request in ' +
    'surface-data-binding.test.ts beside the hasMore completeness control. ' +
    'That compiled relation fixture owns the target list and query gateway ' +
    'needed to produce the named slot refusal.',
};

/**
 * The census itself is checked against the catalog rather than merely used.
 *
 * **The real vector is a coordinated truncation**: the census and the two
 * accounting tables below shrinking together. The partition check alone cannot
 * see that, because it only asks whether the census and the tables agree with
 * each other, and both are hand-maintained. Comparing against
 * `Object.keys(SURFACE_MESSAGE_CATALOG)` introduces an authority neither of
 * them can move.
 *
 * A bare `SURFACE_MESSAGE_CODES.slice(0, 1)` was **not** the hole — it already
 * reddened through `CODE_NOT_REGISTERED`, verified by running both gate
 * revisions against that truncation. An earlier version of this comment said
 * the partition "stayed consistent" under it, and that history is false.
 */
function censusViolations(census: readonly string[]): string[] {
  const registered = Object.keys(SURFACE_MESSAGE_CATALOG).sort();
  const observed = [...census].sort();
  return [
    ...registered
      .filter((code) => !observed.includes(code))
      .map((code) => `CENSUS_OMITS:${code}`),
    ...observed
      .filter((code) => !registered.includes(code))
      .map((code) => `CENSUS_INVENTS:${code}`),
  ].sort();
}

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
  expect(censusViolations(SURFACE_MESSAGE_CODES)).toEqual([]);
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

test('census red: a truncated census is observed, not only an emptied one', () => {
  // The shape the earlier zero-input control missed entirely.
  expect(censusViolations(SURFACE_MESSAGE_CODES.slice(0, 1))).toHaveLength(
    SURFACE_MESSAGE_CODES.length - 1,
  );
  expect(censusViolations(SURFACE_MESSAGE_CODES.slice(0, 1))).toContain(
    'CENSUS_OMITS:UNKNOWN_SURFACE',
  );
  expect(censusViolations([])).toHaveLength(SURFACE_MESSAGE_CODES.length);
  expect(censusViolations([...SURFACE_MESSAGE_CODES, 'INVENTED'])).toEqual([
    'CENSUS_INVENTS:INVENTED',
  ]);
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
      ...observeCatalogMessages(
        await readMessageSamples(page),
        [code],
        CENSUS_SUBJECTS,
      ),
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
  test.setTimeout(120_000);
  const violations: string[] = [];
  for (const [code, drive] of Object.entries(REAL_PATH_DRIVERS)) {
    await drive(page);
    violations.push(
      ...observeCatalogMessages(await readMessageSamples(page), [code], {
        REQUEST_RUNTIME_VIEW_REFUSED: CENSUS_RUNTIME_VIEW_REFUSAL_SUBJECT,
        // Derived from the compiled fixture the shell actually served, so a
        // renderer that substituted a different component identifier is caught
        // rather than merely counted.
        UNSUPPORTED_COMPONENT: unsupportedComponentReferenceId(),
      }),
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
    sentence: { ...rendered!.sentence, text: 'Compiled surface unavailable' },
  };
  expect(observeCatalogMessages([hardcoded], ['QUERY_UNSUPPORTED'])).toEqual([
    'MESSAGE_SENTENCE_MISMATCH:QUERY_UNSUPPORTED',
  ]);
});

test('control: a treatment rendered outside role="alert" is still seen', async ({
  page,
}) => {
  // The census marker is data-message, so a treatment that is not an alert —
  // which is what every U6b success confirmation and empty state will be — is
  // sampled rather than silently excluded from the gate's own scope.
  await page.goto(`${censusUrl}/?code=NO_ACTIVE_SURFACE`);
  await page.evaluate(() => {
    document.querySelector('[data-message]')?.setAttribute('role', 'status');
  });
  const asStatus = await readMessageSamples(page);
  expect(asStatus).toHaveLength(1);
  expect(asStatus[0]?.role).toBe('status');
  expect(observeCatalogMessages(asStatus, ['NO_ACTIVE_SURFACE'])).toEqual([]);

  await page.evaluate(() => {
    document.querySelector('[data-message]')?.removeAttribute('role');
  });
  const roleless = await readMessageSamples(page);
  expect(roleless).toHaveLength(1);
  expect(roleless[0]?.role).toBe('');
  expect(observeCatalogMessages(roleless, ['NO_ACTIVE_SURFACE'])).toEqual([]);

  // And the selector this replaced would have seen neither.
  expect(await page.locator('[role="alert"]').count()).toBe(0);
});

test('control: a next action or subject deleted from the template is observed', async ({
  page,
}) => {
  // The reviewer's nominated execution, as a permanent control: message-render
  // emits ${nextAction}${subject}, and before this the sample read neither.
  await page.goto(`${censusUrl}/?code=UNSUPPORTED_COMPONENT`);
  const [full] = await readMessageSamples(page);
  expect(full?.nextAction.count).toBe(0);
  expect(full?.subject.count).toBe(1);
  expect(
    observeCatalogMessages(
      [{ ...full!, subject: { count: 0, text: '', visible: false } }],
      ['UNSUPPORTED_COMPONENT'],
      { UNSUPPORTED_COMPONENT: CENSUS_SUBJECT },
    ),
  ).toEqual(['MESSAGE_SUBJECT_ABSENT:UNSUPPORTED_COMPONENT']);

  await page.goto(`${censusUrl}/?code=AUTHENTICATION_REQUIRED`);
  const [withAction] = await readMessageSamples(page);
  expect(withAction?.nextAction.count).toBe(1);
  expect(
    observeCatalogMessages(
      [{ ...withAction!, nextAction: { count: 0, text: '', visible: false } }],
      ['AUTHENTICATION_REQUIRED'],
    ),
  ).toEqual(['MESSAGE_NEXT_ACTION_ABSENT:AUTHENTICATION_REQUIRED']);
});

test('control: a wrong but non-empty subject is observed, not just counted', async ({
  page,
}) => {
  // Presence and non-emptiness were satisfied by ANY identifier. Shipping a
  // different component name keeps count at one, the element visible and the
  // text non-empty — §6's proxy-satisfied-while-the-fact-is-false vector.
  await page.goto(`${censusUrl}/?code=UNSUPPORTED_COMPONENT`);
  const [rendered] = await readMessageSamples(page);
  expect(rendered?.subject.text).toBe(CENSUS_SUBJECT);

  const substituted = {
    ...rendered!,
    subject: { ...rendered!.subject, text: 'northstar.shell:component.other' },
  };
  expect(
    observeCatalogMessages([substituted], ['UNSUPPORTED_COMPONENT'], {
      UNSUPPORTED_COMPONENT: CENSUS_SUBJECT,
    }),
  ).toEqual(['MESSAGE_SUBJECT_MISMATCH:UNSUPPORTED_COMPONENT']);

  // And an assertion run with no expected subject reports the gap rather than
  // silently reverting to a presence check.
  expect(
    observeCatalogMessages([rendered!], ['UNSUPPORTED_COMPONENT'], {}),
  ).toEqual([
    'MESSAGE_SUBJECT_EXPECTATION_MISSING:UNSUPPORTED_COMPONENT',
    'MESSAGE_SUBJECT_MISMATCH:UNSUPPORTED_COMPONENT',
  ]);
});

test('control: an opacity-zero ancestor is observed, not reported as visible', async ({
  page,
}) => {
  // Opacity composites through ancestors and does not inherit, so every
  // descendant still reports opacity 1 with a non-zero rectangle. Reading each
  // node's own style called this fully visible.
  await page.goto(`${censusUrl}/?code=AUTHENTICATION_REQUIRED`);
  await page.evaluate(() => {
    const message = document.querySelector('[data-message]');
    const wrapper = document.createElement('div');
    wrapper.style.opacity = '0';
    message?.parentElement?.insertBefore(wrapper, message);
    if (message) wrapper.append(message);
  });

  const ownStyleSaysVisible = await page.evaluate(() => {
    const node = document.querySelector('[data-message-sentence]');
    if (!node) return false;
    const style = getComputedStyle(node);
    const rectangle = node.getBoundingClientRect();
    return (
      Number.parseFloat(style.opacity) === 1 &&
      rectangle.width > 0 &&
      rectangle.height > 0
    );
  });
  expect(ownStyleSaysVisible).toBe(true);

  expect(
    observeCatalogMessages(await readMessageSamples(page), [
      'AUTHENTICATION_REQUIRED',
    ]),
  ).toEqual(['MESSAGE_IMPERCEPTIBLE:AUTHENTICATION_REQUIRED']);
});

test('control: a part hidden on its own is observed while the card stays visible', async ({
  page,
}) => {
  // Card-level visibility called this correct: the section is visible and
  // textContent still returns the words nobody can read.
  await page.goto(`${censusUrl}/?code=AUTHENTICATION_REQUIRED`);
  await page.addStyleTag({
    content: '[data-message-next-action]{display:none!important}',
  });
  const samples = await readMessageSamples(page);
  expect(samples[0]?.visible).toBe(true);
  expect(samples[0]?.nextAction.text.length).toBeGreaterThan(0);
  expect(observeCatalogMessages(samples, ['AUTHENTICATION_REQUIRED'])).toEqual([
    'MESSAGE_NEXT_ACTION_HIDDEN:AUTHENTICATION_REQUIRED',
  ]);
});

test('control: a message rendered without its code attribute reds rather than being skipped', async ({
  page,
}) => {
  await page.goto(`${censusUrl}/?code=NO_ACTIVE_SURFACE`);
  await page.evaluate(() => {
    document.querySelector('[data-message]')?.setAttribute('data-message', '');
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
    content: '[data-message]{display:none!important}',
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
      .querySelector('[data-message]')
      ?.setAttribute('data-message', 'NOT_IN_THE_CATALOG');
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

/** The component id the compiled fixture names, read from the artifact. */
function unsupportedComponentReferenceId(): string {
  const surface = compiledSurfaces().find(
    (candidate) => candidate.label === 'Unsupported component',
  );
  const slots = surface?.slots as
    { contentReferenceId?: unknown }[] | undefined;
  const reference = slots?.[0]?.contentReferenceId;
  if (typeof reference !== 'string') {
    throw new Error('compiled unsupported surface names no component');
  }
  return reference;
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
