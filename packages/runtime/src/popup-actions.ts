import type { CompiledPopup } from '../../canonical-model/src/popup-actions.js';

export { CompiledPopupSchema } from '../../canonical-model/src/schemas.js';
import {
  evaluateRegisteredOperationPrecondition,
  parsePinnedOperationCatalog,
  type SemanticOperationGateway,
} from './semantic-operation-gateway.js';
import type { SemanticRecordDto } from './semantic-query-gateway.js';
import type { RequestRuntimeView } from './request-runtime-view.js';

export async function availablePopups(
  view: RequestRuntimeView,
  declarations: readonly CompiledPopup[],
  record: SemanticRecordDto,
  scope: string | null,
  gateway: SemanticOperationGateway,
) {
  if (record.archived) return [];
  const operations = parsePinnedOperationCatalog(
    view.projections.operation.payload,
  );
  const results = await Promise.all(
    declarations.map(async (p) => {
      const op = operations.find(
        (o) => o.operationId === p.revision.target.operationId,
      );
      if (
        !p.task ||
        p.revision.status !== 'active' ||
        !op ||
        op.lifecycle !== 'active' ||
        evaluateRegisteredOperationPrecondition(op.precondition, record.values)
          .outcome !== 'holds'
      )
        return [];
      for (const binding of p.task.steps[0]!.bindings) {
        if (
          binding.value.source === 'record' &&
          !['recordId', 'revision'].includes(binding.value.field) &&
          !Object.hasOwn(record.values, binding.value.field)
        )
          return [];
      }
      for (const c of p.task.conditions) {
        if (
          c.value.source !== 'record' ||
          !Object.hasOwn(record.values, c.value.field)
        )
          return [];
        const value = record.values[c.value.field];
        if (
          c.operator === 'positive'
            ? typeof value !== 'string' ||
              !/^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/u.test(value)
            : c.operator === 'equals'
              ? value !== c.compare
              : value === c.compare
        )
          return [];
      }
      return (await gateway
        .previewTaskEligibility(view, [op.operationId], scope)
        .catch(() => 'ineligible')) === 'eligible'
        ? [p]
        : [];
    }),
  );
  return results.flat();
}
