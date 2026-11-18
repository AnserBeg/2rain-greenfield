import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import {
  AuthenticationRequiredError,
  UntrustedIdentityInputError,
} from '@north-star/runtime/request-context';
import { RequestRuntimeViewRefusalError } from '@north-star/runtime/request-runtime-view';
import type { AuthenticatedRequestRuntimeEntryAdapter } from '@north-star/runtime/request-runtime-view';
import { SURFACE_CLIENT_CSP_HASH } from './surface-client.js';
import {
  ASSISTANT_PANEL_CSP_HASH,
  withAssistantPanel,
  type AssistantMount,
} from './assistant-panel.js';
import { localDemoActor } from '../../../packages/runtime/src/local-demo-actor.js';

import {
  renderCustomizeScreen,
  type CustomizeScreenService,
} from './customize-screen.js';

import {
  FRAGMENT_REQUEST_HEADER,
  renderApplicationDiagnostic,
  renderSurfaceRuntime,
  withLocalDemoIdentity,
  renderSurfaceRuntimeWithData,
  submitSurfaceRuntimeFragment,
  submitSurfaceRuntimeIntent,
  surfaceRuntimeStyles,
  type SurfaceRuntimeGateways,
  type SurfaceRuntimeResponse,
} from './surface-runtime.js';

export type { SurfaceRuntimeApplicationExtension } from './surface-runtime.js';

/**
 * Dev and test only (SPEED-1): each request handled inside a fresh work meter,
 * whose counts the response carries as `Server-Timing`. Composed by the local
 * composition root; absent, nothing is measured and no header is sent.
 */
export interface RequestWorkProbe {
  measure<T>(handle: (serverTiming: () => string) => Promise<T>): Promise<T>;
}

export interface SurfaceRuntimeServerOptions {
  readonly requestWork?: RequestWorkProbe;
  /** The assistant panel (AGENT-3, local demo only); absent, no panel. */
  readonly assistant?: AssistantMount;
}

/** Each measured response's `Server-Timing` value, read as it is written. */
const serverTimings = new WeakMap<ServerResponse, () => string>();

/** HTTP composition owns transport only; the issued view owns definition. */
export function createSurfaceRuntimeServer(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  gateways?: SurfaceRuntimeGateways,
  demoActors?: readonly { key: 'buyer' | 'manager'; label: string }[] | null,
  /** The Customize screen at `/?customize`; absent, the page is not served. */
  customize?: () => Promise<CustomizeScreenService>,
  options: SurfaceRuntimeServerOptions = {},
): Server {
  return createServer((request, response) => {
    const handle = () =>
      handleRequest(
        entry,
        gateways,
        request,
        response,
        demoActors,
        customize,
        gateways ? options.assistant : undefined,
      );
    const probe = options.requestWork;
    void (probe
      ? probe.measure((serverTiming) => {
          serverTimings.set(response, serverTiming);
          return handle();
        })
      : handle());
  });
}

async function handleRequest(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  gateways: SurfaceRuntimeGateways | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  demoActors?: readonly { key: 'buyer' | 'manager'; label: string }[] | null,
  customize?: () => Promise<CustomizeScreenService>,
  assistant?: AssistantMount,
): Promise<void> {
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-security-policy',
    // `connect-src 'self'` admits only the owned script's same-origin fragment
    // POSTs (ADR-0036 behaviour 7); script, style and form rules are unchanged.
    `default-src 'none'; script-src '${SURFACE_CLIENT_CSP_HASH}'${assistant ? ` '${ASSISTANT_PANEL_CSP_HASH}'` : ''}; style-src 'unsafe-inline'; img-src data:; connect-src ${gateways ? "'self'" : "'none'"}; base-uri 'none'; form-action ${gateways ? "'self'" : "'none'"}; frame-ancestors 'none'`,
  );
  response.setHeader('x-content-type-options', 'nosniff');

  if (request.method !== 'GET' && (request.method !== 'POST' || !gateways)) {
    // One code had two sentences here, branching on whether gateways are
    // composed. That is the same defect ADR-0048 was ruled on, and the branch
    // is not a fact the user can act on: the accepted-method list belongs in an
    // `Allow` header, not in two copies of one message.
    writeHtml(
      response,
      renderApplicationDiagnostic(405, {
        code: 'METHOD_NOT_ALLOWED',
      }),
    );
    return;
  }

  const url = new URL(request.url ?? '/', 'http://surface-runtime.local');
  if (
    assistant &&
    url.pathname === '/' &&
    url.searchParams.has('assistant') &&
    (await assistant.handle(request, response, url).catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      response.end();
      return true;
    }))
  )
    return;
  if (url.pathname !== '/') {
    writeHtml(
      response,
      renderApplicationDiagnostic(404, { code: 'ROUTE_NOT_FOUND' }),
    );
    return;
  }

  // A fragment is the owned script's same-origin POST: it must carry the custom
  // header (which a cross-site form cannot set) and prove its origin -- by
  // same-origin fetch metadata where the browser sends it, otherwise by an
  // Origin naming this server. Anything else is an ordinary request.
  const fragment =
    request.method === 'POST' &&
    gateways !== undefined &&
    request.headers[FRAGMENT_REQUEST_HEADER] === '1';
  if (fragment) {
    const site = request.headers['sec-fetch-site'];
    response.setHeader(FRAGMENT_REQUEST_HEADER, 'fragment');
    const fallback = () => {
      response.setHeader(`${FRAGMENT_REQUEST_HEADER}-fallback`, 'page');
      writeHtml(response, { html: '', statusCode: 409 });
    };
    const origin = request.headers.origin;
    let sameOrigin = site === 'same-origin';
    if (site === undefined && typeof origin === 'string') {
      try {
        sameOrigin = new URL(origin).host === request.headers.host;
      } catch {
        sameOrigin = false;
      }
    }
    if (!sameOrigin) {
      writeHtml(response, { html: '', statusCode: 403 });
      return;
    }
    try {
      const submission = await readFormSubmission(request);
      const result = await entry.run({ headers: request.headers }, (view) =>
        submitSurfaceRuntimeFragment(view, url.href, submission, gateways),
      );
      if (result.fallback) fallback();
      else writeHtml(response, result);
    } catch {
      fallback();
    }
    return;
  }

  try {
    const submission =
      request.method === 'POST' ? await readFormSubmission(request) : null;
    if (
      customize &&
      url.searchParams.has('customize') &&
      !(submission && Object.hasOwn(submission, 'localDemoActAs'))
    ) {
      // A cross-site form cannot draft, approve, activate or roll back.
      if (submission && !sameOriginRequest(request)) {
        writeHtml(response, { statusCode: 403, html: '' });
        return;
      }
      const result = await entry.run({ headers: request.headers }, async () =>
        renderCustomizeScreen(
          await customize(),
          url.href,
          submission,
          surfaceRuntimeStyles(),
        ),
      );
      writeHtml(
        response,
        withLocalDemoIdentity(
          result,
          demoActors,
          localDemoActor(request.headers.cookie),
        ),
      );
      return;
    }
    if (
      demoActors &&
      submission &&
      Object.hasOwn(submission, 'localDemoActAs')
    ) {
      const actor = demoActors.find(
        (candidate) => candidate.key === submission.localDemoActAs,
      );
      if (!actor) {
        writeHtml(response, { statusCode: 400, html: '' });
        return;
      }
      // A cross-site form cannot switch the fixture's selected identity.
      const origin = request.headers.origin;
      if (
        request.headers['sec-fetch-site'] !== 'same-origin' &&
        (typeof origin !== 'string' ||
          new URL(origin).host !== request.headers.host)
      ) {
        writeHtml(response, { statusCode: 403, html: '' });
        return;
      }
      response.setHeader(
        'set-cookie',
        `northstar-demo-actor=${actor.key}; Path=/; HttpOnly; SameSite=Strict`,
      );
      // Return to the page, dropping any prepared Task owned by the prior actor.
      for (const name of [...url.searchParams.keys()])
        if (name.toLowerCase().includes('task')) url.searchParams.delete(name);
      writeHtml(response, {
        statusCode: 303,
        html: '',
        location: `${url.pathname}${url.search}`,
      });
      return;
    }
    const result = gateways
      ? await entry.run({ headers: request.headers }, (view) =>
          submission
            ? submitSurfaceRuntimeIntent(view, url.href, submission, gateways)
            : renderSurfaceRuntimeWithData(view, url.href, gateways),
        )
      : await entry.run({ headers: request.headers }, (view) =>
          renderSurfaceRuntime(view, url.href),
        );
    const page = withLocalDemoIdentity(
      result,
      demoActors,
      localDemoActor(request.headers.cookie),
    );
    writeHtml(response, assistant ? withAssistantPanel(page) : page);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      writeHtml(
        response,
        renderApplicationDiagnostic(401, { code: 'AUTHENTICATION_REQUIRED' }),
      );
      return;
    }
    if (error instanceof UntrustedIdentityInputError) {
      writeHtml(
        response,
        renderApplicationDiagnostic(400, {
          code: 'UNTRUSTED_CONTEXT_REJECTED',
        }),
      );
      return;
    }
    if (error instanceof RequestRuntimeViewRefusalError) {
      writeHtml(
        response,
        renderApplicationDiagnostic(500, runtimeViewRefusalMessage(error)),
      );
      return;
    }
    writeHtml(
      response,
      renderApplicationDiagnostic(500, {
        code: 'REQUEST_RUNTIME_VIEW_UNAVAILABLE',
      }),
    );
  }
}

export function runtimeViewRefusalMessage(
  error: RequestRuntimeViewRefusalError,
) {
  return {
    code: 'REQUEST_RUNTIME_VIEW_REFUSED' as const,
    subject: error.code,
  };
}

function sameOriginRequest(request: IncomingMessage): boolean {
  if (request.headers['sec-fetch-site'] === 'same-origin') return true;
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] !== undefined) return false;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readFormSubmission(
  request: IncomingMessage,
): Promise<Readonly<Record<string, string>>> {
  if (
    !String(request.headers['content-type'] ?? '').startsWith(
      'application/x-www-form-urlencoded',
    )
  ) {
    return Object.freeze({});
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 64 * 1024) return Object.freeze({});
    chunks.push(buffer);
  }
  const values = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return Object.freeze(
    Object.fromEntries(
      [...values.entries()].filter(([key]) => !Object.hasOwn({}, key)),
    ),
  );
}

function writeHtml(
  response: ServerResponse,
  result: SurfaceRuntimeResponse,
): void {
  response.statusCode = result.statusCode;
  const serverTiming = serverTimings.get(response);
  if (serverTiming) response.setHeader('server-timing', serverTiming());
  if (result.location) response.setHeader('location', result.location);
  if (result.download) {
    response.setHeader('content-type', result.download.contentType);
    response.setHeader(
      'content-disposition',
      `attachment; filename="${result.download.fileName}"`,
    );
    response.end(result.download.body);
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(result.html);
}
