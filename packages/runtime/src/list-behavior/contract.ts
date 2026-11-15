import type { ImmutableJsonValue } from '../request-runtime-view.js';

/**
 * The closed-contract strictness primitives. They live in their own leaf so
 * that request parsing and cursor decoding can both refuse a malformed shape
 * without either importing the other: `index.ts` and `cursor.ts` depend on
 * this file, and this file depends on neither.
 */
export class SharedListContractError extends Error {
  override readonly name = 'SharedListContractError';

  constructor(
    readonly code:
      | 'LIST_CURSOR_INVALID'
      | 'LIST_EXPORT_UNSUPPORTED'
      | 'LIST_FIELD_NOT_AUTHORIZED'
      | 'LIST_INPUT_MALFORMED'
      | 'LIST_RESULT_MALFORMED',
    message: string,
    readonly subjectId: string | null = null,
  ) {
    super(message);
  }
}

export function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  allowMissing = false,
): void {
  const actual = Object.keys(value).sort();
  const expectedSorted = [...expected].sort();
  if (
    actual.some((key) => !expectedSorted.includes(key)) ||
    (!allowMissing && actual.join('\0') !== expectedSorted.join('\0'))
  ) {
    throw malformed('list object keys do not match the closed contract');
  }
}

export function malformed(message: string): SharedListContractError {
  return new SharedListContractError('LIST_INPUT_MALFORMED', message);
}

export function isRecord(
  value: unknown,
): value is Readonly<Record<string, ImmutableJsonValue | undefined>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
