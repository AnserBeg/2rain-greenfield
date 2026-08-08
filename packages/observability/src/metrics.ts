import {
  FEEDBACK_LADDER_BANDS,
  LATENCY_SAMPLE_REJECTIONS,
  classifyFeedbackLadder,
} from './feedback-ladder.js';

export type ObservedRoute = '/healthz' | '/metrics' | '/readyz' | 'other';
export type ReadinessResult = 'not_ready' | 'ready';

/**
 * Whether the read ingress returned an envelope or threw. It deliberately does
 * not describe the data: a typed `unsupported` envelope is `answered`, because
 * the user was answered and the time it took is what the ladder grades.
 */
export type RegisteredQueryOutcome = 'answered' | 'refused';

export const REGISTERED_QUERY_OUTCOMES = Object.freeze([
  'answered',
  'refused',
] as const);

export interface MetricSnapshot {
  readonly errors: ReadonlyArray<readonly [code: string, count: number]>;
  readonly queryLatency: ReadonlyArray<readonly [key: string, count: number]>;
  readonly queryLatencyRejections: ReadonlyArray<
    readonly [reason: string, count: number]
  >;
  readonly requests: ReadonlyArray<readonly [key: string, count: number]>;
  readonly readiness: ReadonlyArray<readonly [result: string, count: number]>;
}

export class ObservabilityMetrics {
  readonly #errors = new Map<string, number>();
  readonly #queryLatency = new Map<string, number>();
  readonly #queryLatencyRejections = new Map<string, number>();
  readonly #requests = new Map<string, number>();
  readonly #readiness = new Map<string, number>();

  recordError(code: 'readiness.postgres_unavailable'): void {
    increment(this.#errors, code);
  }

  recordRequest(route: ObservedRoute, statusCode: number): void {
    increment(this.#requests, `${route}|${String(statusCode)}`);
  }

  recordReadiness(result: ReadinessResult): void {
    increment(this.#readiness, result);
  }

  /**
   * One registered-query invocation, graded against ADR-0032's ladder.
   *
   * The recorded evidence is the band, never the duration and never the query
   * id: `outcome x band` is 12 series and stays 12 series however many queries
   * a release registers. An operator wanting to know which query is slow reads
   * the observation the gateway hands its instrumentation, which does carry the
   * id; the exported counter deliberately cannot grow with the catalog.
   */
  recordRegisteredQueryLatency(
    outcome: RegisteredQueryOutcome,
    durationMilliseconds: number,
  ): void {
    const classification = classifyFeedbackLadder(durationMilliseconds);
    if (classification.kind === 'rejected') {
      increment(this.#queryLatencyRejections, classification.reason);
      return;
    }
    increment(this.#queryLatency, `${outcome}|${classification.band}`);
  }

  snapshot(): MetricSnapshot {
    return Object.freeze({
      errors: sortedEntries(this.#errors),
      queryLatency: ladderEntries(this.#queryLatency),
      queryLatencyRejections: rejectionEntries(this.#queryLatencyRejections),
      readiness: sortedEntries(this.#readiness),
      requests: sortedEntries(this.#requests),
    });
  }

  renderPrometheus(): string {
    const lines = [
      '# HELP north_star_http_requests_total Observed HTTP requests.',
      '# TYPE north_star_http_requests_total counter',
      ...sortedEntries(this.#requests).map(([key, count]) => {
        const [route = 'other', statusCode = '0'] = key.split('|');
        return `north_star_http_requests_total{route="${route}",status_code="${statusCode}"} ${String(count)}`;
      }),
      '# HELP north_star_readiness_checks_total PostgreSQL readiness outcomes.',
      '# TYPE north_star_readiness_checks_total counter',
      ...sortedEntries(this.#readiness).map(
        ([result, count]) =>
          `north_star_readiness_checks_total{dependency="postgres",result="${result}"} ${String(count)}`,
      ),
      '# HELP north_star_errors_total Redacted platform error evidence.',
      '# TYPE north_star_errors_total counter',
      ...sortedEntries(this.#errors).map(
        ([code, count]) =>
          `north_star_errors_total{code="${code}"} ${String(count)}`,
      ),
      '# HELP north_star_registered_query_latency_band_total Registered query invocations by ADR-0032 feedback-ladder band.',
      '# TYPE north_star_registered_query_latency_band_total counter',
      ...ladderEntries(this.#queryLatency).map(([key, count]) => {
        const [outcome = 'answered', band = 'under_100ms'] = key.split('|');
        return `north_star_registered_query_latency_band_total{band="${band}",outcome="${outcome}"} ${String(count)}`;
      }),
      '# HELP north_star_registered_query_latency_rejected_total Latency samples refused by name instead of graded as a band.',
      '# TYPE north_star_registered_query_latency_rejected_total counter',
      ...rejectionEntries(this.#queryLatencyRejections).map(
        ([reason, count]) =>
          `north_star_registered_query_latency_rejected_total{reason="${reason}"} ${String(count)}`,
      ),
    ];
    return `${lines.join('\n')}\n`;
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Ladder order, not lexical order: `1s_3s` sorts before `400ms_1s` as a string,
 * and an exposition that reads out of order invites a reader to compare the
 * wrong two numbers. Walking the closed cross-product is what keeps the output
 * both deterministic and ascending.
 */
function ladderEntries(
  counts: ReadonlyMap<string, number>,
): ReadonlyArray<readonly [string, number]> {
  const entries: Array<readonly [string, number]> = [];
  for (const outcome of REGISTERED_QUERY_OUTCOMES) {
    for (const band of FEEDBACK_LADDER_BANDS) {
      const key = `${outcome}|${band}`;
      const count = counts.get(key);
      if (count !== undefined) entries.push(Object.freeze([key, count]));
    }
  }
  return Object.freeze(entries);
}

function rejectionEntries(
  counts: ReadonlyMap<string, number>,
): ReadonlyArray<readonly [string, number]> {
  return Object.freeze(
    LATENCY_SAMPLE_REJECTIONS.filter((reason) => counts.has(reason)).map(
      (reason) => Object.freeze([reason, counts.get(reason)!] as const),
    ),
  );
}

function sortedEntries(
  counts: ReadonlyMap<string, number>,
): ReadonlyArray<readonly [string, number]> {
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, count]) => Object.freeze([key, count] as const));
}
