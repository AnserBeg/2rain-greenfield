import { canonicalize, canonicalizeAndHash } from './canonicalize.js';
import {
  ReportBodyV1Schema,
  type ReportBody,
  type ReportBodyV1,
  type ReportBodyV2,
  type ReportOperator,
  type ReportChoices,
  type ReportSource,
  type ReportRevision,
  type QueryLegalEntityScope,
} from './schemas.js';
import type {
  GROUPED_AGGREGATE_PROFILE,
  GROUPED_RESULT_VERSION,
} from './grouped-aggregate.js';
import { inspectPredicateForExecution } from './predicate-kernel.js';
import { selectedFieldIds } from './board.js';
import {
  isV1Shape,
  reportBindingProblemV2,
  reportDigestV2,
  resolveReportChoicesV2,
  type ReportOfferV2,
} from './declared-report-v2.js';

type Row = Record<string, unknown>;
export interface ReportCatalogSource {
  readonly entities: readonly Row[];
  readonly fields: readonly Row[];
  readonly queries: readonly Row[];
  readonly surfaces: readonly Row[];
  readonly relations?: readonly Row[];
}
export type ReportOperand = ReportBodyV2['operands'][number];
export interface ReportOffer {
  source: ReportBodyV1['source'];
  label: string;
  fields: {
    operand: ReportOperand;
    label: string;
    options?: { id: string; label: string }[];
  }[];
}
export interface RegisteredReport {
  queryId: string;
  tier: 'q1';
  profile: typeof GROUPED_AGGREGATE_PROFILE;
  resultContract: typeof GROUPED_RESULT_VERSION;
  surfaceId: string;
  label: string;
  revision: ReportRevision;
  legalEntityScope?: QueryLegalEntityScope;
  columns: (ReportOperand & {
    columnName: string;
    label: string;
    options?: { id: string; label: string }[];
  })[];
  accessPath: { table: string; index: string; keys: string[] };
  /** v2: declared to-one joins in path order, resolved against storage. */
  links?: RegisteredReportLink[];
  /** v2: effective measures, approved references resolved. */
  measures?: EffectiveReportMeasure[];
  /** A named measure registers its trial or approved total. */
  kind?: 'measure';
}
export interface RegisteredReportLink {
  via: string[];
  entityId: string;
  queryId: string;
  readPermissionId: string;
  required: boolean;
  table: string;
  /** The relation column on the previous hop (the grain for the first). */
  relationColumn: string;
  legalEntity: boolean;
  legalEntityScope?: QueryLegalEntityScope;
}
export interface EffectiveReportMeasure {
  measureId: string;
  label: string;
  operator: ReportOperator;
  approved?: { contractDigest: string };
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
  const base = baseReportOffer(definition, listSurfaceId, false);
  return (
    base && { source: base.source, label: base.label, fields: base.fields }
  );
}

/** The record type a list reads, its eligible operands and, for a line type
 * (a declared parentScopedChild), its parent relation. Slice 1 offers only
 * record types; a slice-2 line report admits the child. */
export function baseReportOffer(
  definition: ReportCatalogSource,
  listSurfaceId: string,
  lines: boolean,
) {
  const list = definition.surfaces.find((s) => s.surfaceId === listSurfaceId);
  if (
    !live(list) ||
    list.archetype !== 'list' ||
    (!list.list && !lines) ||
    list.report ||
    list.measure
  )
    return null;
  const query = definition.queries.find(
    (q) => q.queryId === ref(list.dataSource),
  );
  if (
    !live(query) ||
    query.tier !== 'q0' ||
    query.queryType !== 'list' ||
    (query.filter !== undefined &&
      inspectPredicateForExecution(query.filter).outcome !== 'accepted') ||
    query.readModel
  )
    return null;
  const entity = definition.entities.find(
    (e) => e.entityId === ref(query.sourceEntity),
  );
  if (!live(entity)) return null;
  const parents =
    definition.relations?.filter(
      (r) =>
        live(r) &&
        r.ownership === 'parentScopedChild' &&
        ref(r.sourceEntity) === entity.entityId,
    ) ?? [];
  if (parents.length > (lines ? 1 : 0)) return null;
  // A line collection need not be a declared List; a record source must be.
  if (!list.list && !parents.length) return null;
  const scope = query.legalEntityScope as
    { cardinality: string; operand: { parameterId: string } } | undefined;
  if (scope && scope.cardinality !== 'exactlyOne') return null;
  if (
    (query.parameters as { parameterId: string }[] | undefined)?.some(
      (p) => p.parameterId !== scope?.operand.parameterId,
    )
  )
    return null;
  const source = ReportBodyV1Schema.shape.source.parse({
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
    const operand = ReportBodyV1Schema.shape.operands.element.parse({
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
  return {
    source,
    label: String(list.label),
    fields,
    entity,
    query,
    parentRelationId: parents[0]?.relationId as string | undefined,
  };
}

type V1Choices = Pick<
  ReportBodyV1,
  'dimensions' | 'filters' | 'measures' | 'outputs'
>;
/** Slice-1 shapes keep their v1 body bytes; anything else resolves to v2. */
export function resolveAnyReportChoices(
  offer: ReportOfferV2,
  choices: ReportChoices,
): ReportBody | string {
  if (offer.v1 && isV1Shape(offer, choices)) {
    return resolveReportChoices(offer.v1, choices as V1Choices);
  }
  return resolveReportChoicesV2(offer, choices);
}

export function resolveReportChoices(
  offer: ReportOffer,
  input: V1Choices,
): ReportBodyV1 | string {
  const choices: V1Choices = {
    dimensions: input.dimensions,
    filters: input.filters,
    measures: input.measures,
    outputs: input.outputs,
  };
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
  return ReportBodyV1Schema.parse({
    ...choices,
    source: offer.source,
    version: 'grouped-report/v1',
    operands: [...dependencies].sort().map((id) => fields.get(id)),
  });
}

/** Only the choices and their pinned contracts enter the revision digest. */
export function reportDigest(body: ReportBody) {
  if (body.version === 'grouped-report/v2') return reportDigestV2(body);
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
  if (body.version === 'grouped-report/v2')
    return reportBindingProblemV2(def, body);
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

export const DECLARED_REPORT_READER = 44;
export function reportQueryId(reportId: string) {
  return reportId
    .replace(':report.custom_', ':query.custom_report_')
    .replace(':measure.custom_', ':query.custom_measure_');
}
export function reportColumnPermission(fieldId: string) {
  return fieldId.replace(':field.', ':permission.custom_report_field_');
}
export const REPORT_EXPORT_PERMISSION =
  'northstar.runtime:permission.report_export';

/** The measures a registration runs: v2 resolves approved references at
 * compilation; a v1 body is all inline. */
export function effectiveMeasures(
  report: RegisteredReport,
): EffectiveReportMeasure[] {
  return (
    report.measures ??
    report.revision.body.measures.flatMap((m) =>
      m.kind === 'inline'
        ? [{ measureId: m.measureId, label: m.label, operator: m.operator }]
        : [],
    )
  );
}
const pathOf = (o: { fieldId: string; via?: readonly string[] | undefined }) =>
  (o.via?.join('>') ?? '') + '|' + o.fieldId;
export function reportColumnFor(
  report: RegisteredReport,
  operand: { fieldId: string; via?: readonly string[] | undefined },
) {
  return report.columns.find((c) => pathOf(c) === pathOf(operand));
}
export function reportDimensionLabel(report: RegisteredReport, i: number) {
  const d = report.revision.body.dimensions[i]!;
  const label = reportColumnFor(report, d)?.label ?? d.fieldId;
  return d.kind === 'calendar'
    ? label + ' (' + d.unit + ')'
    : d.kind === 'age'
      ? label + ' age'
      : label;
}

/** A filter parameter is named by its field, or by its path and field. */
export const filterParameterId = (f: {
  fieldId: string;
  via?: readonly string[] | undefined;
}) => (f.via ? pathOf(f) : f.fieldId);
