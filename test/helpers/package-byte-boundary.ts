import assert from 'node:assert/strict';

import {
  canonicalize,
  normalizeApplicationPackage,
  type VersionedAuthoredApplicationPackage,
} from '../../packages/canonical-model/src/index.js';

/**
 * The v0 package-byte maximum, written as a literal on purpose: the boundary
 * tests pin the VALUE, so moving `STRUCTURAL_LIMITS_V0` without an owner ruling
 * (ADR-0070, STRUCTURAL-LIMITS-RAISE) reds them instead of silently following.
 */
export const PACKAGE_BYTE_MAXIMUM_V0 = 4_194_304;

/** One text default may carry at most this many scalars (`maximumStringScalars`). */
const PADDING_VALUE_MAXIMUM = 4_000;

export type PackageByteMeasure = (authored: unknown) => number;

/** Canonical bytes of the authored package, as `normalizeApplicationPackage` measures them first. */
export const authoredCanonicalBytes: PackageByteMeasure = (authored) =>
  new TextEncoder().encode(canonicalize(authored as never)).byteLength;

/** Canonical bytes of the normalized package, as `normalizeApplicationPackage` measures them last. */
export const normalizedCanonicalBytes: PackageByteMeasure = (authored) =>
  new TextEncoder().encode(canonicalize(normalizeApplicationPackage(authored)))
    .byteLength;

export interface PackageByteBoundary {
  /** Measures exactly the target under the chosen measure. */
  readonly atTarget: VersionedAuthoredApplicationPackage;
  /** The same package with one more ASCII byte in one text default. */
  readonly oneByteOver: VersionedAuthoredApplicationPackage;
}

/**
 * Pads `base` with declared-default text fields on the entity that owns its
 * first field until `measure` reports exactly `target` bytes, then builds the
 * same package one byte larger. Every padding field has fixed-width ids, labels
 * and order keys, so each adds the same byte count and the last defaults absorb
 * the remainder byte for byte; the result is asserted, never assumed.
 */
export function packageAtByteBoundary(
  base: VersionedAuthoredApplicationPackage,
  measure: PackageByteMeasure,
  target: number = PACKAGE_BYTE_MAXIMUM_V0,
): PackageByteBoundary {
  const one = measure(padded(base, [PADDING_VALUE_MAXIMUM]));
  const perField =
    measure(padded(base, [PADDING_VALUE_MAXIMUM, PADDING_VALUE_MAXIMUM])) - one;
  let count = Math.ceil((target - one) / perField) + 1;
  let excess = one + (count - 1) * perField - target;
  if (excess === 0) {
    // One default must sit below its maximum so the +1 package exists.
    count += 1;
    excess = perField;
  }
  const lengths = Array.from({ length: count }, () => PADDING_VALUE_MAXIMUM);
  for (let index = count - 1; excess > 0; index -= 1) {
    const shed = Math.min(excess, PADDING_VALUE_MAXIMUM - 1);
    lengths[index]! -= shed;
    excess -= shed;
  }
  const atTarget = padded(base, lengths);
  assert.equal(measure(atTarget), target, 'byte-boundary package missed');

  const grown = [...lengths];
  grown[grown.findLastIndex((length) => length < PADDING_VALUE_MAXIMUM)]! += 1;
  const oneByteOver = padded(base, grown);
  assert.equal(
    authoredCanonicalBytes(oneByteOver),
    authoredCanonicalBytes(atTarget) + 1,
    'the one-byte-over package must differ by exactly one authored byte',
  );
  return { atTarget, oneByteOver };
}

function padded(
  base: VersionedAuthoredApplicationPackage,
  lengths: readonly number[],
): VersionedAuthoredApplicationPackage {
  const authored = structuredClone(base);
  const template = authored.fields[0]!;
  const namespace = authored.package.namespace;
  for (const [index, length] of lengths.entries()) {
    const ordinal = String(index).padStart(4, '0');
    authored.fields.push({
      ...structuredClone(template),
      defaultSemantics: 'declaredDefault',
      defaultValue: {
        kind: 'textValue',
        schemaVersion: template.schemaVersion,
        value: 'x'.repeat(length),
      },
      fieldId: `${namespace}:field.byte_boundary_${ordinal}`,
      fieldType: {
        kind: 'textFieldType',
        maximumLength: PADDING_VALUE_MAXIMUM,
        schemaVersion: template.schemaVersion,
      },
      label: `Byte boundary ${ordinal}`,
      orderKey: 100_000 + index,
    } as typeof template);
  }
  return authored;
}
