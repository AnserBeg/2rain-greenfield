import type { VersionedNormalizedApplicationPackage } from './schemas.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';

/**
 * Release verification writes `V-`-prefixed sentinel values, document numbers
 * included, into the records it arranges. A document sequence may not use this
 * prefix, so a sentinel can never read as a business number of any sequence
 * nor collide with one.
 */
export const VERIFICATION_SENTINEL_PREFIX = 'V' as const;
/**
 * A verification sentinel is its prefix, a hyphen and hexadecimal digest
 * digits, cut to the field's length. A numbered field keeps at least sixteen
 * of those digits (64 bits), so the records one verification arranges keep
 * distinct numbers in a key that refuses duplicates.
 */
export const VERIFICATION_SENTINEL_MINIMUM_LENGTH =
  VERIFICATION_SENTINEL_PREFIX.length + 1 + 16;

/**
 * A numbered field is assigned by the server on create and is nobody's input.
 * It must be a required text field under a case-insensitive unique business
 * key -- the backstop among live records of its key scope; the allocator's
 * scan of every record of the tenant, archived and in every company, is what
 * keeps a number from being reused -- and long enough for its first number
 * and for release verification's sentinels. Nothing may offer it for entry:
 * no editor field, no composition binding. A declaration the runtime could not
 * honour is refused here.
 */
export function validateFieldNumbering(
  model: VersionedNormalizedApplicationPackage,
): void {
  const fail = (id: string, reason: string): never => {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_SCHEMA_INVALID',
        '$.fields.numbering',
        reason,
        'number a required, uniquely keyed text field that no form or task writes',
        id,
      ),
    ]);
  };
  const numbered = new Map<string, string>();
  const sequences = new Set<string>();
  for (const field of model.fields) {
    if (!('numbering' in field) || !field.numbering) continue;
    const numbering = field.numbering;
    const id = String(field.fieldId);
    if (field.fieldType.kind !== 'textFieldType')
      fail(id, 'a document number is a text field');
    if (field.presence !== 'required')
      fail(id, 'a document number is required on every record');
    if (field.businessKey !== 'tenantEnvironmentCaseInsensitiveUnique')
      fail(id, 'a document number is a tenant-wide unique business key');
    if (numbering.prefix === VERIFICATION_SENTINEL_PREFIX)
      fail(
        id,
        `the prefix ${VERIFICATION_SENTINEL_PREFIX} is reserved for release verification sentinels`,
      );
    // The first number is the start padded to the minimum digits; a start
    // wider than that minimum widens the first number itself.
    if (
      field.fieldType.kind === 'textFieldType' &&
      field.fieldType.maximumLength <
        numbering.prefix.length +
          1 +
          Math.max(numbering.minimumDigits, String(numbering.start).length)
    )
      fail(id, 'the number field is shorter than its format');
    if (
      field.fieldType.kind === 'textFieldType' &&
      field.fieldType.maximumLength < VERIFICATION_SENTINEL_MINIMUM_LENGTH
    )
      fail(
        id,
        `a number field holds at least ${String(VERIFICATION_SENTINEL_MINIMUM_LENGTH)} characters, so release verification sentinels stay distinct`,
      );
    if (sequences.has(numbering.sequenceId))
      fail(id, 'each document sequence numbers one field');
    sequences.add(numbering.sequenceId);
    numbered.set(id, numbering.sequenceId);
  }
  if (numbered.size === 0) return;
  for (const surface of model.surfaces) {
    const editor =
      'documentEditor' in surface ? surface.documentEditor : undefined;
    for (const field of [
      ...(editor?.headerFields ?? []),
      ...(editor?.lineFields ?? []),
    ])
      if (numbered.has(String(field.fieldId)))
        fail(
          String(field.fieldId),
          'an assigned number is not an editor field',
        );
    const composition =
      'composition' in surface ? surface.composition : undefined;
    for (const action of composition?.actions ?? [])
      for (const step of action.steps)
        for (const binding of step.bindings)
          if (binding.path.some((segment) => numbered.has(segment)))
            fail(
              String(action.actionId),
              'an assigned number is not a composition input',
            );
  }
}
