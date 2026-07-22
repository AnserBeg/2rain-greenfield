export type ObservedRoute = '/healthz' | '/metrics' | '/readyz' | 'other';
export type ReadinessResult = 'not_ready' | 'ready';

export interface MetricSnapshot {
  readonly errors: ReadonlyArray<readonly [code: string, count: number]>;
  readonly requests: ReadonlyArray<readonly [key: string, count: number]>;
  readonly readiness: ReadonlyArray<readonly [result: string, count: number]>;
}

export class ObservabilityMetrics {
  readonly #errors = new Map<string, number>();
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

  snapshot(): MetricSnapshot {
    return Object.freeze({
      errors: sortedEntries(this.#errors),
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
    ];
    return `${lines.join('\n')}\n`;
  }
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedEntries(
  counts: ReadonlyMap<string, number>,
): ReadonlyArray<readonly [string, number]> {
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, count]) => Object.freeze([key, count] as const));
}
