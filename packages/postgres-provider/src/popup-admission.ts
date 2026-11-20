import { canonicalize } from '../../canonical-model/src/canonicalize.js';
import type { LayoutDefinition } from '../../canonical-model/src/layout.js';
import {
  compiledPopups,
  POPUP_READER,
} from '../../canonical-model/src/popup-actions.js';
import { CompiledPopupSchema } from '../../runtime/src/popup-actions.js';
type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value : []);
const object = (value: unknown) => (value ?? {}) as Row;
export function popupDeclarationProblem(
  definition: unknown,
  manifest: unknown,
  floor: number,
) {
  const def = definition as LayoutDefinition;
  const actual = rows(object(manifest).surfaces).filter(
    (s) => 'popupActions' in s,
  );
  const declared = rows(def?.surfaces).filter((s) => 'popupActions' in s);
  if (
    actual.length !== declared.length ||
    (declared.length > 0 && floor < POPUP_READER) ||
    (!declared.length && floor === POPUP_READER)
  )
    return 'The pop-up declaration and reader floor disagree.';
  for (const s of declared) {
    const content = actual.find((a) => a.surfaceId === s.surfaceId);
    if (
      !content ||
      canonicalize(compiledPopups(def, s)) !==
        canonicalize(content.popupActions)
    )
      return 'The compiled pop-up differs from the approved record action.';
  }
  return null;
}
export function popupBindingsProblem(
  manifest: unknown,
  floor: number,
  operations: unknown,
  queries: unknown,
) {
  const declaring = rows(object(manifest).surfaces).filter(
    (s) => 'popupActions' in s,
  );
  if (
    (floor === POPUP_READER && !declaring.length) ||
    (floor < POPUP_READER && declaring.length)
  )
    return 'The pop-up reader floor disagrees with the surface.';
  for (const s of declaring) {
    const parsed = CompiledPopupSchema.array().min(1).safeParse(s.popupActions);
    if (!parsed.success) return 'Invalid record action.';
    for (const { revision: r, task } of parsed.data) {
      const query = rows(object(queries).queries).find(
        (q) => q.queryId === s.dataSourceQueryId,
      );
      if (
        !query ||
        r.surface !== s.surfaceId ||
        !rows(s.slots).some(
          (slot) => slot.slot === 'commandBar' && slot.slotId === r.slot,
        )
      )
        return 'The record action has no bound page or slot.';
      if (r.status === 'retired' && !task) continue;
      const op = rows(object(operations).operations).find(
        (o) => o.operationId === r.target.operationId,
      );
      if (
        r.status !== 'active' ||
        !op ||
        op.lifecycle !== 'active' ||
        !task ||
        task.actionId !== r.actionId ||
        task.steps.length !== 1 ||
        task.steps[0]!.operation.targetId !== op.operationId
      )
        return 'The record action has no bound operation.';
      if (r.target.kind === 'update') {
        const fields = rows(object(op.inputContract).fields);
        const effect = object(op.effect);
        if (
          effect.kind !== 'updateRecordEffect' ||
          object(effect.entity).targetId !== query.sourceEntityId ||
          r.inputs.some(
            (i) =>
              !fields.some(
                (f) => f.fieldId === i.binding && f.writable === true,
              ),
          )
        )
          return 'The pop-up update has no matching writable field.';
      }
    }
  }
  return null;
}
