import { addressSettings } from './address-settings.js';
import { offerPlaces } from './address-context.js';
import { createServer } from 'node:http';
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from 'node:zlib';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import {
  AuthenticationRequiredError,
  UntrustedIdentityInputError,
} from '@north-star/runtime/request-context';
import { RequestRuntimeViewRefusalError } from '@north-star/runtime/request-runtime-view';
import { trustedContextForRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type { AuthenticatedRequestRuntimeEntryAdapter } from '@north-star/runtime/request-runtime-view';
import { SURFACE_CLIENT_CSP_HASH } from './surface-client.js';
import {
  ASSISTANT_PANEL_CSP_HASH,
  withAssistantPanel,
  type AssistantMount,
} from './assistant-panel.js';
import { staticAsset, type StaticAsset } from './surface-assets.js';
import type { DocumentGateway } from '../../../packages/runtime/src/document-gateway.js';
import { mountDocumentHttp } from './document-http.js';

import {
  renderCustomizeScreen,
  type CustomizeScreenService,
} from './customize-screen.js';
import {
  loadWorkflowApprovals,
  WORKFLOW_APPROVALS_HREF,
  type WorkflowApprovalsService,
} from './workflow-approvals.js';

import {
  FRAGMENT_REQUEST_HEADER,
  renderApplicationDiagnostic,
  renderSurfaceRuntime,
  renderWorkflowApprovals,
  withLocalDemoIdentity,
  withStaffSession,
  renderSurfaceRuntimeWithData,
  submitSurfaceRuntimeFragment,
  submitSurfaceRuntimeIntent,
  SURFACE_STYLESHEET,
  taskRecoveryNotice,
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
  /**
   * SPEED-1: a page read (a GET, or a task's step) runs all its reads in one
   * read snapshot, ended by `finishReads` or when the page is assembled; a
   * policy change while it was held discards the page. Absent, each read is
   * a transaction of its own.
   */
  readonly readSnapshot?: <T>(
    work: (finishReads: () => Promise<void>) => Promise<T>,
    options?: { readonly retry?: boolean },
  ) => Promise<T>;
  readonly requestWork?: RequestWorkProbe;
  readonly selectedDemoActor?: (
    cookie: string | undefined,
  ) => 'buyer' | 'manager';
  readonly staffTransport?: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<{ csrf: string; identityOrigin: string } | null>;
  /** The assistant panel (AGENT-3, local demo only); absent, no panel. */
  readonly assistant?: AssistantMount;
  readonly documents?: DocumentGateway;
  readonly workflowApprovals?: WorkflowApprovalsService;
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
  const documents =
    options.documents && mountDocumentHttp(entry, options.documents);
  return createServer((request, response) => {
    htmlEncodings.set(response, acceptedEncoding(request));
    const handle = async () => {
      if (options.staffTransport) {
        try {
          const transport = await options.staffTransport(request, response);
          if (!transport) return;
          const url = new URL(request.url ?? '/', 'https://staff.invalid');
          const forbidden = (key: string) =>
            /^(?:localDemoActAs|principal[_-]?id|tenant[_-]?id|environment[_-]?id)$/iu.test(
              key,
            );
          if ([...url.searchParams.keys()].some(forbidden)) throw new Error();
          if (
            request.method === 'POST' &&
            documents &&
            url.pathname === '/documents'
          ) {
            if (request.headers['x-erp-csrf'] !== transport.csrf)
              throw new Error();
          } else if (request.method === 'POST') {
            if (
              !(request.headers['content-type'] ?? '').startsWith(
                'application/x-www-form-urlencoded',
              )
            )
              throw new Error();
            const form = await readFormSubmission(request);
            if (
              (request.headers['x-erp-csrf'] ?? form._csrf) !==
                transport.csrf ||
              Object.keys(form).some(forbidden)
            )
              throw new Error();
            const clean = { ...form };
            delete clean._csrf;
            staffForms.set(request, clean);
          }
          staffResponses.set(response, transport);
        } catch {
          response.statusCode = 403;
          response.end();
          return;
        }
      }
      return handleRequest(
        entry,
        gateways,
        request,
        response,
        demoActors,
        customize,
        options.readSnapshot,
        gateways ? options.assistant : undefined,
        documents,
        options.workflowApprovals,
        options.selectedDemoActor,
      );
    };
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
  readSnapshot?: SurfaceRuntimeServerOptions['readSnapshot'],
  assistant?: AssistantMount,
  documents?: ReturnType<typeof mountDocumentHttp>,
  workflowApprovals?: WorkflowApprovalsService,
  selectedDemoActor?: (cookie: string | undefined) => 'buyer' | 'manager',
): Promise<void> {
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-security-policy',
    // `connect-src 'self'` admits only the owned script's same-origin fragment
    // POSTs (ADR-0036 behaviour 7); script, style and form rules are unchanged.
    `default-src 'none'; script-src '${SURFACE_CLIENT_CSP_HASH}'${assistant ? ` '${ASSISTANT_PANEL_CSP_HASH}'` : ''}; style-src 'self'; font-src 'self'; img-src data:; connect-src ${gateways ? "'self'" : "'none'"}; base-uri 'none'; form-action ${gateways ? "'self'" : "'none'"}; frame-ancestors 'none'`,
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
  if (gateways?.addresses && demoActors && url.pathname === '/address/settings') {
    try{
      if(request.method==='POST'&&!sameOriginRequest(request))throw Error();
      const form=request.method==='POST'?await readFormSubmission(request):undefined;
      const html=await entry.run({headers:request.headers},view=>addressSettings(view,gateways.addresses!,gateways.queryGateway,form));
      response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end(html);
    } catch {response.writeHead(403);response.end('Company settings unavailable for this account.');}
    return;
  }
  if (gateways?.addresses && url.pathname === '/address/suggest') {
    if (request.method !== 'POST' || !sameOriginRequest(request)) {response.writeHead(403);response.end();return;}
    try {
      const form=await readFormSubmission(request);
      const answer=await entry.run({headers:request.headers},async view=>{
        const gateway=gateways.addresses!;
        const account=(await gateway.installations(view)).find(i=>i.installationId===form.installationId);
        if(!account) throw new Error();
        const t={companyId:account.companyId,recordId:form.recordId??'',fieldId:form.fieldId??''};
        const session=form.session??'';
        const result=await gateway.suggest(view,t,form.queryId??'',form.text??'',session);
        return {attribution:result.attribution,suggestions:offerPlaces(view,t.recordId,t.fieldId,account,session,result.suggestions,result.attribution)};
      });
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(answer));
    } catch {response.writeHead(422);response.end();}
    return;
  }
  if (documents && url.pathname === '/documents') {
    await documents(request, response, url, sameOriginRequest(request));
    return;
  }
  const asset =
    request.method === 'GET' ? staticAsset(url.pathname) : undefined;
  if (asset) {
    writeStaticAsset(request, response, asset);
    return;
  }
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

  const submitTask = (
    submission: Readonly<Record<string, string>>,
    fragment: boolean,
  ) => {
    const submit = () =>
      entry.run({ headers: request.headers }, (view) =>
        submitSurfaceRuntimeIntent(
          view,
          url.href,
          submission,
          gateways!,
          fragment ? 'task-fragment' : 'page',
        ),
      );
    if (!readSnapshot) return submit();
    // ADR-0071: the step's reads are checked at the response boundary.
    // An invocation leaves that snapshot and checks policy live.
    return readSnapshot(submit, { retry: false }).catch((error: unknown) => {
      if (!policyChangedDuringStep(error)) throw error;
      return ['confirm', 'apply', 'retry'].includes(
        submission.taskStage ?? '',
      ) && typeof submission.taskToken === 'string'
        ? taskRecoveryNotice(url.href, submission, fragment)
        : policyChangedRedirect(url);
    });
  };

  // A fragment is the owned script's same-origin POST: it must carry the custom
  // header (which a cross-site form cannot set) and prove its origin -- by
  // same-origin fetch metadata where the browser sends it, otherwise by an
  // Origin naming this server. Anything else is an ordinary request.
  const fragmentRequest = request.headers[FRAGMENT_REQUEST_HEADER];
  const taskFragment = fragmentRequest === 'task';
  const fragment =
    request.method === 'POST' &&
    gateways !== undefined &&
    (fragmentRequest === '1' || taskFragment);
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
      if (taskFragment) {
        if (!taskStep(submission)) {
          fallback();
          return;
        }
        const result = await submitTask(submission, true);
        if (result.location) {
          response.setHeader(
            `${FRAGMENT_REQUEST_HEADER}-refresh`,
            result.location,
          );
          writeHtml(response, { html: '', statusCode: 409 });
        } else if (result.html === '' && result.statusCode === 409) fallback();
        else writeHtml(response, result);
        return;
      }
      const result = await entry.run({ headers: request.headers }, (view) =>
        submitSurfaceRuntimeFragment(view, url.href, submission, gateways),
      );
      if (result.fallback) fallback();
      else writeHtml(response, result);
    } catch {
      if (taskFragment) writeHtml(response, { html: '', statusCode: 500 });
      else fallback();
    }
    return;
  }

  try {
    const submission =
      request.method === 'POST' ? await readFormSubmission(request) : null;
    if (
      workflowApprovals &&
      url.searchParams.has('approvals') &&
      !(submission && Object.hasOwn(submission, 'localDemoActAs'))
    ) {
      if (submission && !sameOriginRequest(request)) {
        writeHtml(response, { statusCode: 403, html: '' });
        return;
      }
      const result = await entry.run(
        { headers: request.headers },
        async (view) =>
          renderWorkflowApprovals(
            view,
            await loadWorkflowApprovals(
              trustedContextForRequestRuntimeView(view),
              workflowApprovals,
              submission,
            ),
          ),
      );
      const page = withLocalDemoIdentity(
        result,
        demoActors,
        (demoActors && selectedDemoActor?.(request.headers.cookie)) || 'buyer',
        WORKFLOW_APPROVALS_HREF,
      );
      writeHtml(
        response,
        assistant ? withAssistantPanel(page, WORKFLOW_APPROVALS_HREF) : page,
      );
      return;
    }
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
      const result = await entry.run(
        { headers: request.headers },
        async (view) =>
          renderCustomizeScreen(
            await customize(),
            url.href,
            submission,
            SURFACE_STYLESHEET.href,
            trustedContextForRequestRuntimeView(view),
          ),
      );
      const customizePage = withLocalDemoIdentity(
        result,
        demoActors,
        (demoActors && selectedDemoActor?.(request.headers.cookie)) || 'buyer',
      );
      // The assistant links here ("Review it on the Customize screen"); the
      // panel comes along (end review X15).
      writeHtml(
        response,
        assistant
          ? withAssistantPanel(
              customizePage,
              workflowApprovals && WORKFLOW_APPROVALS_HREF,
            )
          : customizePage,
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
      ? submission
        ? taskStep(submission)
          ? await submitTask(submission, false)
          : await entry.run({ headers: request.headers }, (view) =>
              submitSurfaceRuntimeIntent(view, url.href, submission, gateways),
            )
        : readSnapshot
          ? await readSnapshot((finishReads) =>
              entry.run({ headers: request.headers }, (view) =>
                renderSurfaceRuntimeWithData(view, url.href, gateways, null, {
                  finishReads,
                }),
              ),
            )
          : await entry.run({ headers: request.headers }, (view) =>
              renderSurfaceRuntimeWithData(view, url.href, gateways),
            )
      : await entry.run({ headers: request.headers }, (view) =>
          renderSurfaceRuntime(view, url.href),
        );
    const page = withLocalDemoIdentity(
      result,
      demoActors,
      (demoActors && selectedDemoActor?.(request.headers.cookie)) || 'buyer',
      workflowApprovals && WORKFLOW_APPROVALS_HREF,
    );
    writeHtml(
      response,
      assistant
        ? withAssistantPanel(page, workflowApprovals && WORKFLOW_APPROVALS_HREF)
        : page,
    );
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

/**
 * The provider's `ReadSnapshotPolicyChangedError`, known by name: the web
 * layer never imports the provider.
 */
function policyChangedDuringStep(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'ReadSnapshotPolicyChangedError' &&
    (error as { code?: unknown }).code === 'READ_SNAPSHOT_POLICY_CHANGED'
  );
}

/**
 * The step's page again, under the policy now current. Whatever the step
 * committed stays committed (its receipt is the invocation's own); the
 * protected page is assembled afresh, or refused, by the GET.
 */
function policyChangedRedirect(url: URL): SurfaceRuntimeResponse {
  const page = new URL(url.href);
  for (const name of [...page.searchParams.keys()])
    if (name.toLowerCase().includes('task')) page.searchParams.delete(name);
  return {
    html: '',
    location: `${page.pathname}${page.search}`,
    statusCode: 303,
  };
}

/**
 * A composition task's step: open, fill, Review or Confirm. Every other POST
 * (a form's save, a draft editor) keeps a transaction per read.
 */
function taskStep(submission: Readonly<Record<string, string>>): boolean {
  return (
    typeof submission.compositionAction === 'string' &&
    submission.compositionAction !== ''
  );
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

const staffForms = new WeakMap<
  IncomingMessage,
  Readonly<Record<string, string>>
>();
const staffResponses = new WeakMap<
  ServerResponse,
  { csrf: string; identityOrigin: string }
>();

async function readFormSubmission(
  request: IncomingMessage,
): Promise<Readonly<Record<string, string>>> {
  const prepared = staffForms.get(request);
  if (prepared) return prepared;
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

/**
 * SPEED-1: a static asset from its content-hash route (`surface-assets.ts`):
 * a year, immutable, precompressed where that helps. It holds no personal or
 * tenant data, so it may be cached anywhere.
 */
function writeStaticAsset(
  request: IncomingMessage,
  response: ServerResponse,
  asset: StaticAsset,
): void {
  const accepted = acceptedEncoding(request);
  const encoding = accepted && asset.encodings[accepted] ? accepted : null;
  response.statusCode = 200;
  response.setHeader('cache-control', 'public, max-age=31536000, immutable');
  response.setHeader('content-type', asset.contentType);
  response.setHeader('vary', 'accept-encoding');
  if (encoding) response.setHeader('content-encoding', encoding);
  response.end(encoding ? asset.encodings[encoding] : asset.body);
}

/** The best encoding the client accepts: brotli, then gzip, else none. */
function acceptedEncoding(request: IncomingMessage): 'br' | 'gzip' | null {
  const header = String(request.headers['accept-encoding'] ?? '');
  const accepts = (name: string) =>
    header
      .split(',')
      .map((part) => part.trim().split(';'))
      .some(
        ([token, ...parameters]) =>
          token?.trim().toLowerCase() === name &&
          !parameters.some((parameter) =>
            /^\s*q\s*=\s*0(?:\.0*)?\s*$/u.test(parameter),
          ),
      );
  return accepts('br') ? 'br' : accepts('gzip') ? 'gzip' : null;
}

/** Each response's negotiated encoding for its HTML, read as it is written. */
const htmlEncodings = new WeakMap<ServerResponse, 'br' | 'gzip' | null>();

function writeHtml(
  response: ServerResponse,
  result: SurfaceRuntimeResponse,
): void {
  const staff = staffResponses.get(response);
  if (staff) result = withStaffSession(result, staff);
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
  // Personalized HTML stays `no-store`; it is compressed when the client
  // accepts it (a fast brotli level: this runs on every page).
  const encoding = htmlEncodings.get(response) ?? null;
  if (!encoding || result.html.length < 1024) {
    response.end(result.html);
    return;
  }
  response.setHeader('vary', 'accept-encoding');
  response.setHeader('content-encoding', encoding);
  response.end(
    encoding === 'br'
      ? brotliCompressSync(result.html, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
        })
      : gzipSync(result.html, { level: 6 }),
  );
}
export { assistantCompany, type AssistantCompany } from './surface-runtime.js';
