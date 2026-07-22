import { createHash } from 'node:crypto';

import { canonicalize } from '@north-star/canonical-model';

import { HASH_ALGORITHM } from './protocol.js';

const separator = Uint8Array.of(0);

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

export function hashCanonical(
  domainTag: string,
  value: unknown,
): { bytes: Uint8Array; digest: string } {
  const bytes = canonicalBytes(value);
  return { bytes, digest: hashBytes(domainTag, bytes) };
}

export function hashBytes(domainTag: string, bytes: Uint8Array): string {
  return createHash(HASH_ALGORITHM)
    .update(domainTag, 'utf8')
    .update(separator)
    .update(bytes)
    .digest('hex');
}

export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
