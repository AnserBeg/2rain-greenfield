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
  type SurfaceRuntimeResponse,
} from './surface-runtime.js';

/** HTTP composition owns transport only; the issued view owns definition. */
export function createSurfaceRuntimeServer(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
): Server {
  return createServer((request, response) => {
    void handleRequest(entry, request, response);
  });
}

async function handleRequest(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.setHeader('cache-control', 'no-store');
  response.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  response.setHeader('x-content-type-options', 'nosniff');

  if (request.method !== 'GET') {
    writeHtml(
      response,
      renderApplicationDiagnostic(
        405,
        'Method not allowed',
        'The SurfaceRuntime shell accepts browser reads only.',
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
    const result = await entry.run({ headers: request.headers }, (view) =>
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

function writeHtml(
  response: ServerResponse,
  result: SurfaceRuntimeResponse,
): void {
  response.statusCode = result.statusCode;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(result.html);
}
