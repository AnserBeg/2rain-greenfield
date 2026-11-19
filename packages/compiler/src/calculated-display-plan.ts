import { bindCalculatedDisplayField } from '../../canonical-model/src/calculated-display-bindings.js';
import {
  projectCalculatedDisplay,
  type CalculatedDisplayProjectionEntry,
} from '../../canonical-model/src/calculated-display-projection.js';
import type { VersionedNormalizedApplicationPackage } from '../../canonical-model/src/schemas.js';

export function compileCalculatedDisplayFields(
  revision: VersionedNormalizedApplicationPackage,
):
  | {
      readonly status: 'compiled';
      readonly fields: readonly CalculatedDisplayProjectionEntry[];
    }
  | {
      readonly status: 'refused';
      readonly subjectId: string;
      readonly message: string;
    } {
  const fields: CalculatedDisplayProjectionEntry[] = [];
  if (revision.languageVersion !== 'v6') return { status: 'compiled', fields };
  const seen = new Set<string>(revision.fields.map(({ fieldId }) => fieldId));
  for (const definition of revision.calculatedDisplayFields ?? []) {
    const bound = bindCalculatedDisplayField(definition, revision);
    if (bound.status === 'refused' || seen.has(definition.fieldId))
      return {
        status: 'refused',
        subjectId: definition.fieldId,
        message:
          bound.status === 'refused'
            ? bound.message
            : 'A calculated display field ID must be unique.',
      };
    fields.push(projectCalculatedDisplay(bound.binding));
    seen.add(definition.fieldId);
  }
  return { status: 'compiled', fields };
}
