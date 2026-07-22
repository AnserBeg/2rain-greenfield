import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import {
  createObservationContext,
  type ObservationContextInput,
  type ObservationIdFactory,
  type ObservabilityMetrics,
  type StructuredLogger,
} from '@north-star/observability';

export interface ReadinessProbe {
  readonly check: () => Promise<void>;
}

export interface HealthServerDependencies {
  readonly logger: StructuredLogger;
  readonly metrics: ObservabilityMetrics;
  readonly postgres: ReadinessProbe;
  readonly ids?: ObservationIdFactory;
}

export function createHealthServer(
  dependencies: HealthServerDependencies,
): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, dependencies);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: HealthServerDependencies,
): Promise<void> {
  const correlationId = firstHeader(request, 'x-correlation-id');
  const traceParent = firstHeader(request, 'traceparent');
  const input: ObservationContextInput = {
    ...(correlationId ? { correlationId } : {}),
    ...(traceParent ? { traceParent } : {}),
  };
  const context = createObservationContext(input, dependencies.ids);
  const route = observedRoute(request.url);
  let statusCode = 500;

  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-correlation-id', context.correlationId);
  response.setHeader('traceparent', context.traceParent);

  try {
    if (request.method !== 'GET') {
      statusCode = 405;
      writeJson(response, statusCode, { status: 'method_not_allowed' });
      return;
    }

    if (route === '/healthz') {
      statusCode = 200;
      writeJson(response, statusCode, { status: 'ok' });
      return;
    }

    if (route === '/readyz') {
      try {
        await dependencies.postgres.check();
        dependencies.metrics.recordReadiness('ready');
        statusCode = 200;
        writeJson(response, statusCode, {
          checks: { postgres: 'up' },
          status: 'ready',
        });
      } catch (error) {
        dependencies.metrics.recordReadiness('not_ready');
        dependencies.metrics.recordError('readiness.postgres_unavailable');
        dependencies.logger.error(
          'readiness.check.failed',
          context,
          'readiness.postgres_unavailable',
          error,
          { dependency: 'postgres' },
        );
        statusCode = 503;
        writeJson(response, statusCode, {
          checks: { postgres: 'down' },
          status: 'not_ready',
        });
      }
      return;
    }

    if (route === '/metrics') {
      statusCode = 200;
      response.statusCode = statusCode;
      response.setHeader(
        'content-type',
        'text/plain; version=0.0.4; charset=utf-8',
      );
      response.end(dependencies.metrics.renderPrometheus());
      return;
    }

    statusCode = 404;
    writeJson(response, statusCode, { status: 'not_found' });
  } finally {
    dependencies.metrics.recordRequest(route, statusCode);
    dependencies.logger.info('http.request.completed', context, {
      method: request.method ?? 'UNKNOWN',
      route,
      statusCode,
    });
  }
}

function firstHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function observedRoute(url: string | undefined) {
  const pathname = new URL(url ?? '/', 'http://localhost').pathname;
  if (pathname === '/healthz') return '/healthz' as const;
  if (pathname === '/readyz') return '/readyz' as const;
  if (pathname === '/metrics') return '/metrics' as const;
  return 'other' as const;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(body)}\n`);
}
