import type {
  SemanticQueryResultEnvelope,
  SemanticRecordDto,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import { requireSharedListResult } from '../../../packages/runtime/src/list-behavior/index.js';

export interface SharedListColumn {
  readonly columnId: string;
  readonly kind: 'field' | 'relation';
}

export interface SharedListRow {
  readonly archived: boolean;
  readonly cells: Readonly<Record<string, string | null>>;
  readonly record: SemanticRecordDto;
}

export function sharedListView(result: SemanticQueryResultEnvelope): Readonly<{
  columns: readonly SharedListColumn[];
  records: readonly SemanticRecordDto[];
  result: SemanticQueryResultEnvelope;
  rows: readonly SharedListRow[];
  listCoverage: NonNullable<SemanticQueryResultEnvelope['listCoverage']>;
}> {
  const shared = requireSharedListResult(result);
  const fieldIds = orderedKeys(
    shared.records.flatMap((record) => Object.keys(record.displayValues ?? {})),
  );
  const relationIds = orderedKeys(
    shared.records.flatMap((record) =>
      Object.keys(record.relationLabels ?? {}),
    ),
  );
  const columns = Object.freeze([
    ...fieldIds.map((columnId) =>
      Object.freeze({ columnId, kind: 'field' as const }),
    ),
    ...relationIds.map((columnId) =>
      Object.freeze({ columnId, kind: 'relation' as const }),
    ),
  ]);
  const rows = Object.freeze(
    shared.records.map((record) =>
      Object.freeze({
        archived: record.archived,
        cells: Object.freeze(
          Object.fromEntries([
            ...fieldIds.map((fieldId) => [
              fieldId,
              record.displayValues?.[fieldId] ?? null,
            ]),
            ...relationIds.map((relationId) => [
              relationId,
              record.relationLabels?.[relationId]?.label ?? null,
            ]),
          ]),
        ),
        record,
      }),
    ),
  );
  return Object.freeze({
    columns,
    records: shared.records,
    result,
    rows,
    listCoverage: shared.listCoverage,
  });
}

function orderedKeys(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}
