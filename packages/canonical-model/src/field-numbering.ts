import type { VersionedNormalizedApplicationPackage } from './schemas.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';

/**
 * A numbered field is assigned by the server on create and is nobody's input.
 * It must be a required text field under the tenant-wide unique business key
 * (so an archived record keeps its number reserved) and long enough for the
 * format, and nothing may offer it for entry: no editor field, no composition
 * binding. A declaration the runtime could not honour is refused here.
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
    if (
      field.fieldType.kind === 'textFieldType' &&
      field.fieldType.maximumLength <
        numbering.prefix.length + 1 + numbering.minimumDigits
    )
      fail(id, 'the number field is shorter than its format');
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
