import { canonicalize, canonicalizeAndHash } from './canonicalize.js';
import {
  ReportBodySchema,
  type ReportBody,
  type ReportChoices,
  type ReportSource,
} from './schemas.js';
import { selectedFieldIds } from './board.js';

type Row = Record<string, unknown>;
export interface ReportCatalogSource {
  readonly entities: readonly Row[];
  readonly fields: readonly Row[];
  readonly queries: readonly Row[];
  readonly surfaces: readonly Row[];
  readonly relations?: readonly Row[];
}
export type ReportOperand = ReportBody['operands'][number];
export interface ReportOffer {
  source: ReportBody['source'];
  label: string;
  fields: {
    operand: ReportOperand;
    label: string;
    options?: { id: string; label: string }[];
  }[];
}
const ref = (value: unknown) =>
  (value as { targetId?: string } | undefined)?.targetId;
const live = (row: Row | undefined): row is Row =>
  !!row && row.lifecycle !== 'retired';
const kinds: Readonly<Record<string, ReportOperand['type']>> = {
  textFieldType: 'text',
  enumFieldType: 'choice',
  booleanFieldType: 'boolean',
  integerFieldType: 'integer',
  exactDecimalFieldType: 'decimal',
  dateFieldType: 'date',
  dateTimeFieldType: 'instant',
  quantityFieldType: 'quantity',
};

/** Resolve the exact stored source and its eligible operands. Layout columns and
 * their display formats confer no source or currency authority. */
export function reportOffer(
  definition: ReportCatalogSource,
  listSurfaceId: string,
): ReportOffer | null {
  const list = definition.surfaces.find((s) => s.surfaceId === listSurfaceId);
  if (!live(list) || list.archetype !== 'list' || !list.list || list.report)
    return null;
  const query = definition.queries.find(
    (q) => q.queryId === ref(list.dataSource),
  );
  if (
    !live(query) ||
    query.tier !== 'q0' ||
    query.queryType !== 'list' ||
    (query.filter !== undefined &&
      ((query.filter as Row).kind !== 'booleanPredicate' ||
        (query.filter as Row).value !== true)) ||
    query.readModel
  )
    return null;
  const entity = definition.entities.find(
    (e) => e.entityId === ref(query.sourceEntity),
  );
  if (
    !live(entity) ||
    definition.relations?.some(
      (r) =>
        live(r) &&
        r.ownership === 'parentScopedChild' &&
        ref(r.sourceEntity) === entity.entityId,
    )
  )
    return null;
  const scope = query.legalEntityScope as
    { cardinality: string; operand: { parameterId: string } } | undefined;
  if (scope && scope.cardinality !== 'exactlyOne') return null;
  if (
    (query.parameters as { parameterId: string }[] | undefined)?.some(
      (p) => p.parameterId !== scope?.operand.parameterId,
    )
  )
    return null;
  const source = ReportBodySchema.shape.source.parse({
    kind: 'generatedCollection',
    grain: 'record',
    listSurfaceId,
    queryId: query.queryId,
    entityId: entity.entityId,
    readPermissionId: ref(query.permission),
    scope: scope ? 'company' : 'tenant',
  });
  const terms = entity.reportSource as ReportSource | undefined;
  const selected = new Set(selectedFieldIds(query));
  const fields = definition.fields.flatMap((f) => {
    if (
      !live(f) ||
      !selected.has(String(f.fieldId)) ||
      !f.reportable ||
      ref(f.entity) !== entity.entityId ||
      !['internal', 'public'].includes(String(f.classification))
    )
      return [];
    const ft = f.fieldType as Row;
    const type = kinds[String(ft.kind)];
    if (!type) return [];
    const currency = terms?.amounts?.find(
      (a) => a.fieldId === f.fieldId,
    )?.currency;
    const basis =
      type === 'date'
        ? 'civilDate'
        : terms?.dates?.find((t) => t.fieldId === f.fieldId)?.basis;
    const operand = ReportBodySchema.shape.operands.element.parse({
      fieldId: f.fieldId,
      type,
      presence: f.presence ?? 'optional',
      classification: f.classification,
      ...(typeof ft.maximumLength === 'number'
        ? { maximumLength: ft.maximumLength }
        : {}),
      ...(ft.precision !== undefined &&
        typeof ft.precision === 'number' && { precision: ft.precision }),
      ...(ft.scale !== undefined && { scale: ft.scale }),
      ...(ft.baseUnit ? { unitId: ref(ft.baseUnit) } : {}),
      ...(currency && { currency }),
      ...(basis && { basis }),
      ...(type === 'text' && { collation: f.collation ?? 'binary' }),
    });
    const options = (
      ft.options as { optionId: string; label: string }[] | undefined
    )?.map((o) => ({ id: o.optionId, label: o.label }));
    return [{ operand, label: String(f.label), ...(options && { options }) }];
  });
  return { source, label: String(list.label), fields };
}

export function resolveReportChoices(
  offer: ReportOffer,
  choices: ReportChoices,
): ReportBody | string {
  const fields = new Map(
    offer.fields.map((f) => [f.operand.fieldId as string, f.operand]),
  );
  const dependencies = new Set<string>();
  const add = (id: string) => {
    dependencies.add(id);
    return fields.get(id);
  };
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (
    !unique(choices.dimensions.map((d) => d.fieldId)) ||
    !unique(choices.filters.map((d) => d.fieldId)) ||
    !unique(choices.measures.map((m) => m.measureId)) ||
    !unique(choices.outputs.map((o) => o.kind)) ||
    !choices.outputs.some((o) => o.kind === 'table')
  )
    return 'Use distinct columns, measures and outputs and include a table.';
  for (const d of choices.dimensions) {
    const f = add(d.fieldId);
    if (!f || (f.type === 'text' && (f.maximumLength ?? 0) > 512))
      return d.fieldId;
  }
  for (const filter of choices.filters) {
    const field = add(filter.fieldId);
    if (
      !field ||
      (filter.kind === 'membership' && field.type !== 'choice') ||
      (filter.kind === 'dateRange' && !field.basis)
    )
      return filter.fieldId;
  }
  if (choices.filters.filter((f) => f.kind === 'dateRange').length > 1)
    return 'Choose one indexed date range.';
  let partition: string | undefined;
  for (const m of choices.measures) {
    if (m.operator.kind === 'count') continue;
    const f = add(m.operator.fieldId);
    if (!f || !(f.currency || f.type === 'quantity')) return m.operator.fieldId;
    if (f.currency?.kind === 'stored' && !add(f.currency.fieldId))
      return f.currency.fieldId;
    const key = canonicalize(f.currency ?? f.unitId);
    if (partition !== undefined && partition !== key) return m.operator.fieldId;
    partition = key;
  }
  return ReportBodySchema.parse({
    ...choices,
    source: offer.source,
    version: 'grouped-report/v1',
    operands: [...dependencies].sort().map((id) => fields.get(id)),
  });
}

/** Only the choices and their pinned contracts enter the revision digest. */
export function reportDigest(body: ReportBody) {
  return canonicalizeAndHash({
    ...body,
    measures: body.measures.map(({ kind, measureId, operator }) => ({
      kind,
      measureId,
      operator,
    })),
  }).contentHash;
}

/** Structural comparison on a different base. Only the active revision's
 * selected bindings participate. New choices and release labels are immaterial. */
export function reportBindingProblem(
  def: ReportCatalogSource,
  body: ReportBody,
): string | null {
  const offer = reportOffer(def, body.source.listSurfaceId);
  if (!offer || canonicalize(offer.source) !== canonicalize(body.source))
    return body.source.queryId;
  const bound = resolveReportChoices(offer, body);
  if (typeof bound === 'string') return bound;
  const expected = new Map(body.operands.map((f) => [f.fieldId, f]));
  return (
    bound.operands.find(
      (f) => canonicalize(f) !== canonicalize(expected.get(f.fieldId) ?? null),
    )?.fieldId ??
    body.operands.find(
      (f) => !bound.operands.some((b) => b.fieldId === f.fieldId),
    )?.fieldId ??
    null
  );
}

export const DECLARED_REPORT_READER = 40;
export function reportQueryId(reportId: string) {
  return reportId.replace(':report.custom_', ':query.custom_report_');
}
export function reportColumnPermission(fieldId: string) {
  return fieldId.replace(':field.', ':permission.custom_report_field_');
}
export const REPORT_EXPORT_PERMISSION =
  'northstar.runtime:permission.report_export';
