import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyFeedbackLadder,
  createObservationContext,
  loadingTreatmentAdmitted,
  monotonicMilliseconds,
  DOHERTY_THRESHOLD_MILLISECONDS,
  FEEDBACK_LADDER_BANDS,
  FEEDBACK_LADDER_BOUNDARIES_MILLISECONDS,
  ObservabilityMetrics,
  StructuredLogger,
  type FeedbackLadderBand,
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
  metrics.recordRegisteredQueryLatency('answered', 12.5);
  metrics.recordRegisteredQueryLatency('answered', 3_400);
  metrics.recordRegisteredQueryLatency('answered', 250);
  metrics.recordRegisteredQueryLatency('refused', 640);
  metrics.recordRegisteredQueryLatency('answered', Number.NaN);

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
      '# HELP north_star_registered_query_latency_band_total Registered query invocations by ADR-0032 feedback-ladder band.',
      '# TYPE north_star_registered_query_latency_band_total counter',
      'north_star_registered_query_latency_band_total{band="under_100ms",outcome="answered"} 1',
      'north_star_registered_query_latency_band_total{band="100ms_400ms",outcome="answered"} 1',
      'north_star_registered_query_latency_band_total{band="3s_10s",outcome="answered"} 1',
      'north_star_registered_query_latency_band_total{band="400ms_1s",outcome="refused"} 1',
      '# HELP north_star_registered_query_latency_rejected_total Latency samples refused by name instead of graded as a band.',
      '# TYPE north_star_registered_query_latency_rejected_total counter',
      'north_star_registered_query_latency_rejected_total{reason="not_finite"} 1',
      '',
    ].join('\n'),
  );
  // Ladder order, not lexical: 3s_10s precedes 400ms_1s in the exposition.
  const rendered = metrics.renderPrometheus();
  assert.ok(
    rendered.indexOf('band="100ms_400ms"') < rendered.indexOf('band="3s_10s"'),
  );
});

/**
 * ADR-0032 §1 is a table of boundaries; this is that table, executed. Both
 * sides of every boundary are asserted, so a band that swallowed its neighbour
 * — or a classifier that answered the same band for everything — cannot pass.
 */
test('the feedback ladder grades every ADR-0032 boundary into exactly one band', () => {
  assert.deepEqual(
    [...FEEDBACK_LADDER_BOUNDARIES_MILLISECONDS],
    [100, 400, 1_000, 3_000, 10_000],
    'the boundaries are ADR-0032 §1, and 400 ms is Doherty',
  );
  assert.equal(DOHERTY_THRESHOLD_MILLISECONDS, 400);
  assert.equal(FEEDBACK_LADDER_BANDS.length, 6);

  const expected: ReadonlyArray<readonly [number, FeedbackLadderBand]> = [
    [0, 'under_100ms'],
    [99.999, 'under_100ms'],
    [100, '100ms_400ms'],
    [399.999, '100ms_400ms'],
    [400, '400ms_1s'],
    [999.999, '400ms_1s'],
    [1_000, '1s_3s'],
    [2_999.999, '1s_3s'],
    [3_000, '3s_10s'],
    [9_999.999, '3s_10s'],
    [10_000, 'over_10s'],
    [86_400_000, 'over_10s'],
  ];
  for (const [durationMilliseconds, band] of expected) {
    assert.deepEqual(
      classifyFeedbackLadder(durationMilliseconds),
      { band, kind: 'band' },
      `${String(durationMilliseconds)} ms belongs to ${band}`,
    );
  }
  assert.deepEqual(
    [...new Set(expected.map(([, band]) => band))],
    [...FEEDBACK_LADDER_BANDS],
    'every declared band is reachable and none is unreachable',
  );
});

/**
 * ADR-0032 §2, executed. The rule is that a treatment is admitted only above
 * the Doherty threshold, so the two bands at or under it must refuse one.
 */
test('a loading treatment is admitted only above the Doherty threshold', () => {
  const admitted = FEEDBACK_LADDER_BANDS.filter((band) =>
    loadingTreatmentAdmitted(band),
  );
  assert.deepEqual(
    [...admitted],
    ['400ms_1s', '1s_3s', '3s_10s', 'over_10s'],
    'a sub-400 ms band that admitted a treatment would let a spinner hide a budget',
  );
  const admits = (durationMilliseconds: number): boolean => {
    const classification = classifyFeedbackLadder(durationMilliseconds);
    assert.equal(classification.kind, 'band', 'the sample must grade');
    return (
      classification.kind === 'band' &&
      loadingTreatmentAdmitted(classification.band)
    );
  };
  for (const inside of [0, 99, 100, DOHERTY_THRESHOLD_MILLISECONDS - 0.001]) {
    assert.equal(
      admits(inside),
      false,
      `${String(inside)} ms is inside budget`,
    );
  }
  for (const outside of [
    DOHERTY_THRESHOLD_MILLISECONDS,
    1_000,
    3_000,
    10_000,
  ]) {
    assert.equal(admits(outside), true, `${String(outside)} ms exceeds budget`);
  }
});

/**
 * AGENTS.md §6 records that this machine's WSL2 kernel steps its wall clock
 * backward under load. A clamp would file that as an instantaneous response,
 * which is the exact shape of an unratified aspiration: a green number that
 * measured nothing.
 */
test('an unusable latency sample is refused by name, never graded as a fast band', () => {
  for (const [sample, reason] of [
    [-1, 'negative'],
    [-0.000_001, 'negative'],
    [Number.NaN, 'not_finite'],
    [Number.POSITIVE_INFINITY, 'not_finite'],
    [Number.NEGATIVE_INFINITY, 'not_finite'],
  ] as const) {
    assert.deepEqual(classifyFeedbackLadder(sample), {
      kind: 'rejected',
      reason,
    });
  }
  assert.deepEqual(classifyFeedbackLadder(-0), {
    band: 'under_100ms',
    kind: 'band',
  });

  const metrics = new ObservabilityMetrics();
  metrics.recordRegisteredQueryLatency('answered', -3);
  metrics.recordRegisteredQueryLatency('refused', Number.NaN);
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.queryLatency, []);
  assert.deepEqual(snapshot.queryLatencyRejections, [
    ['negative', 1],
    ['not_finite', 1],
  ]);
});

/**
 * Bounded means bounded by the ladder, not by the workload. Ten thousand
 * samples across the whole range still expose twelve series, because the
 * recorder keys on `outcome x band` and never on the query that produced it.
 */
test('registered query latency evidence stays bounded under unbounded input', () => {
  const metrics = new ObservabilityMetrics();
  for (let sample = 0; sample < 10_000; sample += 1) {
    metrics.recordRegisteredQueryLatency(
      sample % 2 === 0 ? 'answered' : 'refused',
      sample * 1.7,
    );
  }
  const series = metrics
    .renderPrometheus()
    .split('\n')
    .filter((line) =>
      line.startsWith('north_star_registered_query_latency_band_total{'),
    );
  assert.equal(series.length, 12);
  assert.equal(
    new Set(series).size,
    12,
    'no series is emitted twice for one label pair',
  );
  assert.equal(
    series.reduce((total, line) => total + Number(line.split(' ').at(-1)), 0),
    10_000,
    'every recorded sample lands in exactly one band',
  );
});

test('the monotonic source never runs backward across successive reads', () => {
  let previous = monotonicMilliseconds();
  assert.ok(Number.isFinite(previous));
  for (let read = 0; read < 1_000; read += 1) {
    const current = monotonicMilliseconds();
    assert.ok(
      current >= previous,
      `monotonic read ${String(read)} went backward`,
    );
    previous = current;
  }
});
