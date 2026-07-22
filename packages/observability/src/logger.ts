import type { ObservationContext } from './context.js';

export type LogLevel = 'error' | 'info';
export type StructuredLogValue = boolean | number | string | null;
export type StructuredLogFields = Readonly<Record<string, StructuredLogValue>>;

export interface StructuredErrorEvidence {
  readonly code: string;
  readonly type: string;
}

export interface StructuredLogRecord {
  readonly correlationId: string;
  readonly event: string;
  readonly fields: StructuredLogFields;
  readonly level: LogLevel;
  readonly timestamp: string;
  readonly traceId: string;
  readonly error?: StructuredErrorEvidence;
}

export type StructuredLogSink = (line: string) => void;

export interface StructuredLoggerOptions {
  readonly clock?: () => Date;
  readonly sink?: StructuredLogSink;
}

export class StructuredLogger {
  readonly #clock: () => Date;
  readonly #sink: StructuredLogSink;

  constructor(options: StructuredLoggerOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#sink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  }

  info(
    event: string,
    context: ObservationContext,
    fields: StructuredLogFields = {},
  ): StructuredLogRecord {
    return this.#write('info', event, context, fields);
  }

  error(
    event: string,
    context: ObservationContext,
    code: string,
    error: unknown,
    fields: StructuredLogFields = {},
  ): StructuredLogRecord {
    return this.#write('error', event, context, fields, {
      code,
      type: error instanceof Error ? error.name : 'UnknownError',
    });
  }

  #write(
    level: LogLevel,
    event: string,
    context: ObservationContext,
    fields: StructuredLogFields,
    error?: StructuredErrorEvidence,
  ): StructuredLogRecord {
    const record: StructuredLogRecord = Object.freeze({
      correlationId: context.correlationId,
      ...(error ? { error: Object.freeze({ ...error }) } : {}),
      event,
      fields: Object.freeze(sortFields(fields)),
      level,
      timestamp: this.#clock().toISOString(),
      traceId: context.traceId,
    });
    this.#sink(JSON.stringify(record));
    return record;
  }
}

function sortFields(
  fields: StructuredLogFields,
): Record<string, StructuredLogValue> {
  return Object.fromEntries(
    Object.entries(fields).sort(([left], [right]) => compareKeys(left, right)),
  );
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
