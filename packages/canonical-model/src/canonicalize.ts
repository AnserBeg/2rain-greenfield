import { createHash } from 'node:crypto';

import { CONTENT_HASH_DOMAIN } from './constants.js';
import {
  CanonicalModelError,
  compareCodeUnits,
  diagnostic,
} from './diagnostics.js';

export interface CanonicalizedContent {
  bytes: Uint8Array;
  contentHash: string;
  text: string;
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, '$');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new CanonicalModelError([
        diagnostic(
          'CANON_NUMBER_NOT_SAFE_INTEGER',
          '$',
          'JSON numbers are limited to safe integers and negative zero is forbidden',
          'encode exact decimals and large integers as constrained canonical strings',
        ),
      ]);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      compareCodeUnits(left, right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(',')}}`;
  }
  throw new CanonicalModelError([
    diagnostic(
      'CANON_VALUE_UNSUPPORTED',
      '$',
      'canonical JSON accepts only null, booleans, strings, safe integers, arrays, and plain objects',
      'replace the value with a schema-declared canonical value node',
    ),
  ]);
}

export function canonicalizeAndHash(value: unknown): CanonicalizedContent {
  const text = canonicalize(value);
  const bytes = new TextEncoder().encode(text);
  const contentHash = createHash('sha256')
    .update(CONTENT_HASH_DOMAIN, 'utf8')
    .update(Uint8Array.of(0))
    .update(bytes)
    .digest('hex');
  return { bytes, contentHash, text };
}

export function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalModelError([
          diagnostic(
            'CANON_UNICODE_LONE_SURROGATE',
            path,
            'stored strings contain Unicode scalar values without normalization',
            'replace the lone high surrogate with a valid Unicode scalar value',
          ),
        ]);
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalModelError([
        diagnostic(
          'CANON_UNICODE_LONE_SURROGATE',
          path,
          'stored strings contain Unicode scalar values without normalization',
          'replace the lone low surrogate with a valid Unicode scalar value',
        ),
      ]);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
