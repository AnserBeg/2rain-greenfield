import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createObservationContext,
  ObservabilityMetrics,
  StructuredLogger,
} from '../../packages/observability/src/index.js';

const correlationId = 'request-correlation-001';
const traceId = '11111111111111111111111111111111';
const spanId = '2222222222222222';
const traceParent = `00-${traceId}-${spanId}-01`;

test('request observation context preserves correlation and W3C trace identity', () => {
  const propagated = createObservationContext({
    correlationId,
    traceParent: traceParent.toUpperCase(),
  });
  assert.deepEqual(propagated, {
    correlationId,
    traceId,
    traceParent,
  });

  const generated = createObservationContext(
    {},
    {
      correlationId: () => 'generated-correlation',
      spanId: () => 'AAAAAAAAAAAAAAAA',
      traceId: () => 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
  );
  assert.deepEqual(generated, {
    correlationId: 'generated-correlation',
    traceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    traceParent: '00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-aaaaaaaaaaaaaaaa-01',
  });
});

test('structured logs are deterministic and redact error messages', () => {
  const lines: string[] = [];
  const logger = new StructuredLogger({
    clock: () => new Date('2026-07-21T12:00:00.000Z'),
    sink: (line) => lines.push(line),
  });
  const context = createObservationContext({ correlationId, traceParent });

  logger.error(
    'readiness.check.failed',
    context,
    'readiness.postgres_unavailable',
    new Error('password=must-not-appear'),
    { zeta: 2, alpha: 1 },
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes('must-not-appear'), false);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    correlationId,
    error: { code: 'readiness.postgres_unavailable', type: 'Error' },
    event: 'readiness.check.failed',
    fields: { alpha: 1, zeta: 2 },
    level: 'error',
    timestamp: '2026-07-21T12:00:00.000Z',
    traceId,
  });
  assert.ok(
    (lines[0] ?? '').indexOf('"alpha"') < (lines[0] ?? '').indexOf('"zeta"'),
  );
});

test('metrics expose stable bounded request, readiness, and error evidence', () => {
  const metrics = new ObservabilityMetrics();
  metrics.recordRequest('/healthz', 200);
  metrics.recordRequest('/readyz', 200);
  metrics.recordRequest('/readyz', 503);
  metrics.recordReadiness('ready');
  metrics.recordReadiness('not_ready');
  metrics.recordError('readiness.postgres_unavailable');

  assert.equal(
    metrics.renderPrometheus(),
    [
      '# HELP north_star_http_requests_total Observed HTTP requests.',
      '# TYPE north_star_http_requests_total counter',
      'north_star_http_requests_total{route="/healthz",status_code="200"} 1',
      'north_star_http_requests_total{route="/readyz",status_code="200"} 1',
      'north_star_http_requests_total{route="/readyz",status_code="503"} 1',
      '# HELP north_star_readiness_checks_total PostgreSQL readiness outcomes.',
      '# TYPE north_star_readiness_checks_total counter',
      'north_star_readiness_checks_total{dependency="postgres",result="not_ready"} 1',
      'north_star_readiness_checks_total{dependency="postgres",result="ready"} 1',
      '# HELP north_star_errors_total Redacted platform error evidence.',
      '# TYPE north_star_errors_total counter',
      'north_star_errors_total{code="readiness.postgres_unavailable"} 1',
      '',
    ].join('\n'),
  );
});
