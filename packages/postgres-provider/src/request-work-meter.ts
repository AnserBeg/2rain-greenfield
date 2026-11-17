import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import type pg from 'pg';

/**
 * The database work one HTTP request causes, counted at the application's
 * PostgreSQL clients (SPEED-1). Counting only: nothing here decides, caches or
 * changes a statement, and a request outside a meter is not observed at all.
 *
 * - `statements`: every statement sent, transaction control and connection
 *   cleanup included, as the server's statement log counts them.
 * - `transactions`: each `BEGIN`, plus each statement run outside one (an
 *   implicit transaction); session commands (`SET`, `RESET`, `SHOW`,
 *   `DISCARD`) outside a transaction are statements, never transactions.
 * - `authorization`: statements reading the live policy tables
 *   (`platform.current_policy_*`): the epoch and every permission decision.
 * - `repeats`: a statement whose text and parameters equal one already sent
 *   in this request. Transaction control, session commands and the trusted
 *   envelope (the login-role check, the identity `set_config`, the module
 *   role facts) are excluded: every transaction carries them by design.
 */
export interface RequestWorkCounts {
  readonly authorization: number;
  readonly repeats: number;
  readonly statements: number;
  readonly transactions: number;
}

export class RequestWorkMeter {
  #authorization = 0;
  #repeats = 0;
  #statements = 0;
  #transactions = 0;
  readonly #open = new WeakSet<object>();
  readonly #seen = new Set<string>();

  /** One statement sent on `client` (any object identifying the connection). */
  observe(client: object, text: string, values: unknown): void {
    this.#statements += 1;
    const head = text.trimStart().slice(0, 32).toUpperCase();
    if (/^(?:BEGIN|START\s+TRANSACTION)\b/u.test(head)) {
      this.#open.add(client);
      this.#transactions += 1;
      return;
    }
    if (
      /^(?:COMMIT|END|ABORT)\b/u.test(head) ||
      /^ROLLBACK\b(?!\s+TO\b)/u.test(head)
    ) {
      this.#open.delete(client);
      return;
    }
    if (/^(?:SAVEPOINT|RELEASE|ROLLBACK\s+TO)\b/u.test(head)) return;
    if (/^(?:SET|RESET|SHOW|DISCARD)\b/u.test(head)) return;
    if (!this.#open.has(client)) this.#transactions += 1;
    if (/\bplatform\.current_policy_/u.test(text)) this.#authorization += 1;
    if (envelopeStatement(text)) return;
    const key = `${text}\u0000${parameterKey(values)}`;
    if (this.#seen.has(key)) this.#repeats += 1;
    else this.#seen.add(key);
  }

  counts(): RequestWorkCounts {
    return Object.freeze({
      authorization: this.#authorization,
      repeats: this.#repeats,
      statements: this.#statements,
      transactions: this.#transactions,
    });
  }
}

/** The trusted envelope every request transaction carries (request-context.ts and the module role switch). */
function envelopeStatement(text: string): boolean {
  return (
    /\bFROM\s+pg_catalog\.pg_roles\b/u.test(text) ||
    /^\s*SELECT\s+set_config\('north_star\.tenant_id'/u.test(text)
  );
}

let unserializable = 0;

function parameterKey(values: unknown): string {
  if (values === undefined || values === null) return '';
  try {
    return JSON.stringify(values, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value.toString()}n` : value,
    );
  } catch {
    // An unserializable parameter is never claimed equal to another.
    unserializable += 1;
    return `unserializable:${String(unserializable)}`;
  }
}

const currentMeter = new AsyncLocalStorage<RequestWorkMeter>();

/**
 * Count every statement a client of `pool` sends while a request meter is
 * current. Installed once per physical connection, before the pool hands it
 * out; without a current meter the wrapper only forwards the call.
 */
export function meterPoolStatements(pool: pg.Pool): pg.Pool {
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
      ...args: unknown[]
    ) => {
      const meter = currentMeter.getStore();
      if (meter) {
        const [first, second] = args;
        const config =
          typeof first === 'object' && first !== null
            ? (first as { text?: unknown; values?: unknown })
            : undefined;
        const text =
          typeof first === 'string'
            ? first
            : typeof config?.text === 'string'
              ? config.text
              : '';
        meter.observe(
          client,
          text,
          typeof first === 'string' ? second : config?.values,
        );
      }
      return query(...args);
    };
  });
  return pool;
}

/**
 * One request handled inside a fresh meter. `serverTiming` reads the counts so
 * far as a `Server-Timing` header value; the caller emits it in dev and test
 * only.
 */
export interface RequestWorkProbe {
  measure<T>(handle: (serverTiming: () => string) => Promise<T>): Promise<T>;
}

export function createRequestWorkProbe(): RequestWorkProbe {
  return Object.freeze({
    measure<T>(handle: (serverTiming: () => string) => Promise<T>) {
      const meter = new RequestWorkMeter();
      const started = performance.now();
      return currentMeter.run(meter, () =>
        handle(() =>
          serverTimingValue(meter.counts(), performance.now() - started),
        ),
      );
    },
  });
}

/** Run `work` under `meter`; for tests and benchmarks that measure without HTTP. */
export function runWithRequestWorkMeter<T>(
  meter: RequestWorkMeter,
  work: () => T,
): T {
  return currentMeter.run(meter, work);
}

export function serverTimingValue(
  counts: RequestWorkCounts,
  milliseconds: number,
): string {
  return [
    `db-transactions;desc="${String(counts.transactions)}"`,
    `db-statements;desc="${String(counts.statements)}"`,
    `db-authorization;desc="${String(counts.authorization)}"`,
    `db-repeats;desc="${String(counts.repeats)}"`,
    `app;dur=${milliseconds.toFixed(1)}`,
  ].join(', ');
}

/** The inverse of `serverTimingValue`, for the page budget test. */
export function parseServerTiming(
  header: string | null,
): (RequestWorkCounts & { readonly milliseconds: number }) | null {
  if (!header) return null;
  const desc = (name: string) => {
    const match = new RegExp(`(?:^|,\\s*)${name};desc="(\\d+)"`, 'u').exec(
      header,
    );
    return match ? Number(match[1]) : null;
  };
  const duration = /(?:^|,\s*)app;dur=([\d.]+)/u.exec(header);
  const counts = {
    authorization: desc('db-authorization'),
    repeats: desc('db-repeats'),
    statements: desc('db-statements'),
    transactions: desc('db-transactions'),
  };
  if (Object.values(counts).some((value) => value === null) || !duration)
    return null;
  return Object.freeze({
    authorization: counts.authorization!,
    milliseconds: Number(duration[1]),
    repeats: counts.repeats!,
    statements: counts.statements!,
    transactions: counts.transactions!,
  });
}
