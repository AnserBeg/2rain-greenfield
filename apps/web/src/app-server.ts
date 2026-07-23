import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import {
  AuthenticationRequiredError,
  UntrustedIdentityInputError,
} from '@north-star/runtime/request-context';
import type { AuthenticatedRequestRuntimeEntryAdapter } from '@north-star/runtime/request-runtime-view';

import {
  renderApplicationDiagnostic,
  renderSurfaceRuntime,
  renderSurfaceRuntimeWithData,
  submitSurfaceRuntimeIntent,
  type SurfaceRuntimeGateways,
  type SurfaceRuntimeResponse,
} from './surface-runtime.js';

/** HTTP composition owns transport only; the issued view owns definition. */
export function createSurfaceRuntimeServer(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  gateways?: SurfaceRuntimeGateways,
): Server {
  return createServer((request, response) => {
    void handleRequest(entry, gateways, request, response);
  });
}

async function handleRequest(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  gateways: SurfaceRuntimeGateways | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-security-policy',
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action ${gateways ? "'self'" : "'none'"}; frame-ancestors 'none'`,
  );
  response.setHeader('x-content-type-options', 'nosniff');

  if (request.method !== 'GET' && (request.method !== 'POST' || !gateways)) {
    writeHtml(
      response,
      renderApplicationDiagnostic(
        405,
        'Method not allowed',
        gateways
          ? 'The SurfaceRuntime accepts semantic reads and form intents only.'
          : 'The SurfaceRuntime shell accepts browser reads only.',
        'METHOD_NOT_ALLOWED',
      ),
    );
    return;
  }

  const url = new URL(request.url ?? '/', 'http://surface-runtime.local');
  if (url.pathname !== '/') {
    writeHtml(
      response,
      renderApplicationDiagnostic(
        404,
        'Route not found',
        'The requested route is not part of the compiled application shell.',
        'ROUTE_NOT_FOUND',
      ),
    );
    return;
  }

  try {
    const submission =
      request.method === 'POST' ? await readFormSubmission(request) : null;
    const result = gateways
      ? await entry.run({ headers: request.headers }, (view) =>
          submission
            ? submitSurfaceRuntimeIntent(view, url.href, submission, gateways)
            : renderSurfaceRuntimeWithData(view, url.href, gateways),
        )
      : await entry.run({ headers: request.headers }, (view) =>
          renderSurfaceRuntime(view, url.href),
        );
    writeHtml(response, result);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      writeHtml(
        response,
        renderApplicationDiagnostic(
          401,
          'Sign-in required',
          'An authenticated request is required before a release can be pinned.',
          'AUTHENTICATION_REQUIRED',
        ),
      );
      return;
    }
    if (error instanceof UntrustedIdentityInputError) {
      writeHtml(
        response,
        renderApplicationDiagnostic(
          400,
          'Untrusted context rejected',
          'Tenant and environment identity cannot be selected by browser input.',
          'UNTRUSTED_CONTEXT_REJECTED',
        ),
      );
      return;
    }
    writeHtml(
      response,
      renderApplicationDiagnostic(
        500,
        'Application shell unavailable',
        'The request could not construct its pinned runtime view.',
        'REQUEST_RUNTIME_VIEW_UNAVAILABLE',
      ),
    );
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
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(result.html);
}
