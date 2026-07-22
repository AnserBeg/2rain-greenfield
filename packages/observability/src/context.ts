import { randomBytes, randomUUID } from 'node:crypto';

export interface ObservationContext {
  readonly correlationId: string;
  readonly traceId: string;
  readonly traceParent: string;
}

export interface ObservationContextInput {
  readonly correlationId?: string;
  readonly traceParent?: string;
}

export interface ObservationIdFactory {
  readonly correlationId: () => string;
  readonly spanId: () => string;
  readonly traceId: () => string;
}

const traceParentPattern =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu;

const defaultIdFactory: ObservationIdFactory = {
  correlationId: randomUUID,
  spanId: () => randomBytes(8).toString('hex'),
  traceId: () => randomBytes(16).toString('hex'),
};

export function createObservationContext(
  input: ObservationContextInput,
  ids: ObservationIdFactory = defaultIdFactory,
): ObservationContext {
  const incomingCorrelationId = input.correlationId?.trim();
  const correlationId =
    incomingCorrelationId && incomingCorrelationId.length > 0
      ? incomingCorrelationId
      : ids.correlationId();
  const incomingTraceParent = parseTraceParent(input.traceParent);

  if (incomingTraceParent) {
    return Object.freeze({
      correlationId,
      traceId: incomingTraceParent.traceId,
      traceParent: incomingTraceParent.value,
    });
  }

  const traceId = requireHexIdentifier(ids.traceId(), 32, 'trace');
  const spanId = requireHexIdentifier(ids.spanId(), 16, 'span');
  return Object.freeze({
    correlationId,
    traceId,
    traceParent: `00-${traceId}-${spanId}-01`,
  });
}

function parseTraceParent(
  value: string | undefined,
): { traceId: string; value: string } | undefined {
  const match = traceParentPattern.exec(value?.trim() ?? '');
  if (!match) return undefined;
  const version = match[1]?.toLowerCase();
  const traceId = match[2]?.toLowerCase();
  const spanId = match[3]?.toLowerCase();
  const flags = match[4]?.toLowerCase();
  if (!version || !traceId || !spanId || !flags) return undefined;
  if (/^0+$/u.test(traceId) || /^0+$/u.test(spanId)) return undefined;
  return { traceId, value: `${version}-${traceId}-${spanId}-${flags}` };
}

function requireHexIdentifier(
  value: string,
  length: number,
  name: string,
): string {
  const normalized = value.toLowerCase();
  if (
    normalized.length !== length ||
    !/^[0-9a-f]+$/u.test(normalized) ||
    /^0+$/u.test(normalized)
  ) {
    throw new TypeError(`${name} id factory returned an invalid identifier`);
  }
  return normalized;
}
