import type { VersionedNormalizedApplicationPackage } from './schemas.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';

/**
 * A maintained field is written by one registered capability and by no
 * generic operation: the compiler leaves it out of every generic create's and
 * update's writable inputs. The declaration must name a capability this
 * package requires with the `recordMutation` effect, and the field must be one
 * a generic create can leave unstated -- optional, not a business key, not a
 * numbered field. Nothing may offer it for entry: no editor field, no
 * composition binding. A declaration the runtime could not honour is refused
 * here.
 */
export function validateFieldMaintenance(
  model: VersionedNormalizedApplicationPackage,
): void {
  const fail = (id: string, reason: string): never => {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_SCHEMA_INVALID',
        '$.fields.maintainedBy',
        reason,
        'name a record-mutating capability on an optional field that no form or task writes',
        id,
      ),
    ]);
  };
  const mutating = new Set(
    model.capabilityRequirements
      .filter((requirement) =>
        requirement.declaredEffects.includes('recordMutation'),
      )
      .map((requirement) => String(requirement.capabilityId)),
  );
  const maintained = new Set<string>();
  for (const field of model.fields) {
    if (!('maintainedBy' in field) || !field.maintainedBy) continue;
    const id = String(field.fieldId);
    if (!mutating.has(String(field.maintainedBy.targetId)))
      fail(
        id,
        'a maintained field names a capability this package requires with the recordMutation effect',
      );
    if (field.presence !== 'optional')
      fail(
        id,
        'a maintained field is optional: a generic create leaves it unstated',
      );
    if (field.businessKey === 'tenantEnvironmentCaseInsensitiveUnique')
      fail(id, 'a maintained field is not a business key');
    if ('numbering' in field && field.numbering)
      fail(id, 'a numbered field is assigned on create, not maintained');
    maintained.add(id);
  }
  if (maintained.size === 0) return;
  for (const surface of model.surfaces) {
    const editor =
      'documentEditor' in surface ? surface.documentEditor : undefined;
    for (const field of [
      ...(editor?.headerFields ?? []),
      ...(editor?.lineFields ?? []),
    ])
      if (maintained.has(String(field.fieldId)))
        fail(
          String(field.fieldId),
          'a maintained figure is not an editor field',
        );
    const composition =
      'composition' in surface ? surface.composition : undefined;
    for (const action of composition?.actions ?? [])
      for (const step of action.steps)
        for (const binding of step.bindings)
          if (binding.path.some((segment) => maintained.has(segment)))
            fail(
              String(action.actionId),
              'a maintained figure is not a composition input',
            );
  }
}
