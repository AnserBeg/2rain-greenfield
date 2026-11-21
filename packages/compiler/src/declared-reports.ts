import type { V6NormalizedApplicationPackage } from '../../canonical-model/src/schemas.js';
import {
  GROUPED_AGGREGATE_PROFILE,
  GROUPED_RESULT_VERSION,
} from '../../canonical-model/src/grouped-aggregate.js';
import {
  reportQueryId,
  reportOffer,
  reportBindingProblem,
} from '../../canonical-model/src/declared-report.js';
import type { StorageTargetPayloadV1 } from './storage.js';

export function lowerDeclaredReports(
  def: V6NormalizedApplicationPackage,
  storage: StorageTargetPayloadV1,
) {
  return def.surfaces.flatMap((s) => {
    if (!s.report || s.lifecycle !== 'active') return [];
    const { body } = s.report;
    const problem = reportBindingProblem(def, body);
    if (problem) throw new Error('REPORT_BINDING_UNAVAILABLE: ' + problem);
    const offer = reportOffer(def, body.source.listSurfaceId)!;
    const entity = storage.entities.find(
      (e) => e.entityId === body.source.entityId,
    );
    if (
      !entity ||
      !!entity.legalEntity !== (body.source.scope === 'company') ||
      entity.factStorage
    )
      throw new Error('REPORT_SCOPE_UNAVAILABLE: ' + body.source.entityId);
    const columns = body.operands.map((operand) => {
      const storageColumn = entity.columns.find(
        (c) => c.canonicalFieldId === operand.fieldId,
      );
      if (!storageColumn)
        throw new Error('REPORT_COLUMN_UNAVAILABLE: ' + operand.fieldId);
      const field = offer.fields.find(
        (f) => f.operand.fieldId === operand.fieldId,
      )!;
      return {
        ...operand,
        columnName: storageColumn.physicalName,
        label: field.label,
        ...(field.options && { options: field.options }),
      };
    });
    const date = body.filters.find((f) => f.kind === 'dateRange');
    const dateColumn = date && columns.find((c) => c.fieldId === date.fieldId);
    const keys = [
      'tenant_id',
      'environment_id',
      ...(entity.legalEntity ? ['legal_entity_id'] : []),
      ...(dateColumn ? [dateColumn.columnName] : []),
      'record_id',
    ];
    const path =
      entity.indexes.find(
        (i) =>
          i.indexKind === 'reportAccess' &&
          i.columnNames.join('/') === keys.join('/'),
      ) ??
      (!entity.legalEntity &&
      !date &&
      entity.primaryKey.columns.join('/') === keys.join('/')
        ? entity.primaryKey
        : undefined);
    if (!path) throw new Error('REPORT_INDEX_UNAVAILABLE: ' + keys.join(', '));
    const query = def.queries.find((q) => q.queryId === body.source.queryId)!;
    return [
      {
        queryId: reportQueryId(s.report.reportId),
        tier: 'q1' as const,
        profile: GROUPED_AGGREGATE_PROFILE,
        resultContract: GROUPED_RESULT_VERSION,
        surfaceId: s.surfaceId,
        label: s.label,
        revision: s.report,
        ...('legalEntityScope' in query && query.legalEntityScope
          ? { legalEntityScope: query.legalEntityScope }
          : {}),
        columns,
        accessPath: {
          table: entity.physicalTableName,
          index: path.physicalName,
          keys,
        },
      },
    ];
  });
}
export type RegisteredReport = ReturnType<typeof lowerDeclaredReports>[number];
