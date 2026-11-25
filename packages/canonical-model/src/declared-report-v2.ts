import { canonicalize, canonicalizeAndHash } from './canonicalize.js';
import {
  ReportBodyV2Schema,
  type MeasureRevision,
  type ReportBodyV2,
  type ReportChoices,
  type ReportLink,
  type ReportOperator,
} from './schemas.js';
import { ageBandProblem } from './grouped-aggregate-v2.js';
import {
  baseReportOffer,
  type ReportCatalogSource,
  type ReportOffer,
} from './declared-report.js';

type Row = Record<string, unknown>;
const ref = (value: unknown) =>
  (value as { targetId?: string } | undefined)?.targetId;
const live = (row: Row | undefined): row is Row =>
  !!row && row.lifecycle !== 'retired';

/** REPORTS-1 slice 2: surface reader rung for v2 report bodies (calendar and
 * age dimensions, declared links and line grain, min/max/average/distinct and
 * approved measure references). Provisional; renumbered at the merge. */
export const REPORT_ANALYSIS_READER = 50;
/** A released named measure (trial or approved). Separable from v2 reports:
 * a measure can be released before any report binds it. */
export const REPORT_MEASURE_READER = 51;

type FieldPath = {
  fieldId: string;
  via?: readonly string[] | undefined;
};
export type ReportOperandV2 = ReportBodyV2['operands'][number];
export const pathKey = (via: readonly string[] | undefined) =>
  via?.join('>') ?? '';
export const operandKey = (o: FieldPath) => pathKey(o.via) + '|' + o.fieldId;

export interface ReportLinkOffer {
  readonly link: ReportLink;
  readonly label: string;
  readonly parent: boolean;
  readonly fields: ReportOffer['fields'];
}
export interface ApprovedMeasureOffer {
  readonly measureId: string;
  readonly contractDigest: string;
  readonly label: string;
  readonly body: ReportBodyV2;
}
export interface ReportOfferV2 extends ReportOffer {
  readonly grain: 'record' | 'line';
  readonly sourceV2: ReportBodyV2['source'];
  readonly links: readonly ReportLinkOffer[];
  readonly measures: readonly ApprovedMeasureOffer[];
  /** The slice-1 offer of the same list, when it has one. */
  readonly v1: ReportOffer | null;
}

/** The record-grain list of a link target: the first live list, by ID, whose
 * source is that type and whose own offer is admitted. */
function targetList(def: ReportCatalogSource, entityId: string) {
  return def.surfaces
    .filter((s) => live(s) && s.archetype === 'list' && !s.report && !s.measure)
    .map((s) => String(s.surfaceId))
    .sort()
    .map((id) => baseReportOffer(def, id, false))
    .find((offer) => offer?.source.entityId === entityId);
}

export function reportOfferV2(
  def: ReportCatalogSource,
  listSurfaceId: string,
): ReportOfferV2 | null {
  const base = baseReportOffer(def, listSurfaceId, true);
  if (!base) return null;
  const grain = base.parentRelationId ? 'line' : 'record';
  const sourceV2 = ReportBodyV2Schema.shape.source.parse({
    ...base.source,
    grain,
    ...(base.parentRelationId && { parentRelationId: base.parentRelationId }),
  });
  const links: ReportLinkOffer[] = [];
  const walk = (
    entityId: string,
    scope: 'company' | 'tenant',
    prefix: ReportLink['via'] | [],
  ) => {
    if (prefix.length >= 2) return;
    for (const r of (def.relations ?? [])
      .filter(
        (r) =>
          live(r) &&
          r.cardinality === 'manyToOne' &&
          r.joinEligibility === 'query' &&
          ref(r.sourceEntity) === entityId,
      )
      .sort((a, b) => (String(a.relationId) < String(b.relationId) ? -1 : 1))) {
      const target = targetList(def, String(ref(r.targetEntity)));
      // A tenant-scoped grain cannot scope a company-owned target.
      if (!target || (scope === 'tenant' && target.source.scope === 'company'))
        continue;
      const via = [...prefix, String(r.relationId)] as ReportLink['via'];
      const parent =
        prefix.length === 0 && r.relationId === base.parentRelationId;
      links.push({
        link: {
          via,
          entityId: target.source.entityId,
          listSurfaceId: target.source.listSurfaceId,
          queryId: target.source.queryId,
          readPermissionId: target.source.readPermissionId,
          scope: target.source.scope,
          required: parent,
        },
        label: target.label,
        parent,
        fields: target.fields.map((f) => ({
          ...f,
          operand: { ...f.operand, via },
          label: target.label + ' › ' + f.label,
        })),
      });
      walk(target.source.entityId, target.source.scope, via);
    }
  };
  walk(base.source.entityId, base.source.scope, []);
  const measures = def.surfaces.flatMap((s) => {
    const m = s.measure as MeasureRevision | undefined;
    return live(s) &&
      m?.status === 'approved' &&
      m.body.source.listSurfaceId === listSurfaceId
      ? [
          {
            measureId: m.measureId,
            contractDigest: m.contractDigest,
            label: String(s.label),
            body: m.body,
          },
        ]
      : [];
  });
  return {
    source: base.source,
    label: base.label,
    fields: base.fields,
    grain,
    sourceV2,
    links,
    measures,
    v1: grain === 'record' ? base : null,
  };
}

const v1Shape = (offer: ReportOfferV2, choices: LooseChoices) =>
  offer.grain === 'record' &&
  (choices.grain ?? 'record') === 'record' &&
  choices.dimensions.length > 0 &&
  choices.dimensions.every((d) => d.kind === 'direct' && !d.via) &&
  choices.filters.every((f) => !('via' in f && f.via)) &&
  choices.measures.every(
    (m) =>
      m.kind === 'inline' &&
      (m.operator.kind === 'count' ||
        (m.operator.kind === 'sum' && !m.operator.via)),
  );
export const isV1Shape = v1Shape;

type LooseChoices = Omit<ReportChoices, 'dimensions'> & {
  dimensions: ReportChoices['dimensions'] | [];
};
const MEASURED_AT_GRAIN = new Set(['sum', 'average', 'min', 'max']);

/** Resolve v2 choices against the offer. Returns the body, or the first ID
 * (or a sentence) the author must change. Fan-out refuses here, in preview. */
export function resolveReportChoicesV2(
  offer: ReportOfferV2,
  choices: LooseChoices,
): ReportBodyV2 | string {
  if ((choices.grain ?? offer.grain) !== offer.grain)
    return offer.grain === 'line'
      ? 'This source is one row per line.'
      : 'Choose a line table for one row per line.';
  const fields = new Map(
    [...offer.fields, ...offer.links.flatMap((l) => l.fields)].map((f) => [
      operandKey(f.operand),
      f.operand,
    ]),
  );
  const linkOffers = new Map(offer.links.map((l) => [pathKey(l.link.via), l]));
  const deps = new Map<string, ReportOperandV2>();
  const links = new Map<string, ReportLink>();
  const useLink = (via: readonly string[] | undefined) => {
    if (!via) return true;
    for (let i = 1; i <= via.length; i++) {
      const l = linkOffers.get(pathKey(via.slice(0, i)));
      if (!l) return false;
      links.set(pathKey(l.link.via), l.link);
    }
    return true;
  };
  const add = (f: FieldPath) => {
    const operand = fields.get(operandKey(f));
    if (!operand || !useLink(f.via)) return undefined;
    deps.set(operandKey(f), operand);
    return operand;
  };
  const named = (f: FieldPath) =>
    (f.via ? f.via.join(' › ') + ' › ' : '') + f.fieldId;
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (
    !unique(choices.dimensions.map((d) => operandKey(d) + d.kind)) ||
    !unique(choices.filters.map((f) => operandKey(f))) ||
    !unique(choices.measures.map((m) => m.measureId)) ||
    !unique(choices.outputs.map((o) => o.kind)) ||
    !choices.outputs.some((o) => o.kind === 'table')
  )
    return 'Use distinct columns, measures and outputs and include a table.';
  for (const d of choices.dimensions) {
    const f = add(d);
    if (!f || (f.type === 'text' && (f.maximumLength ?? 0) > 512))
      return named(d);
    if (d.kind !== 'direct' && !f.basis) return named(d);
    if (d.kind === 'age') {
      const problem = ageBandProblem(d.bands);
      if (problem) return problem;
    }
  }
  for (const filter of choices.filters) {
    const field = add(filter);
    if (
      !field ||
      (filter.kind === 'membership' && field.type !== 'choice') ||
      (filter.kind === 'dateRange' && !field.basis)
    )
      return named(filter);
  }
  if (choices.filters.filter((f) => f.kind === 'dateRange').length > 1)
    return 'Choose one indexed date range.';
  let partition: string | undefined;
  const measureOperator = (operator: ReportOperator): string | null => {
    if (operator.kind === 'count') return null;
    if (operator.kind === 'distinctTargets')
      return useLink(operator.via) ? null : operator.via.join(' › ');
    const f = add(operator);
    if (!f) return named(operator);
    // A fact measured from another record would repeat once per row of this
    // grain: a header balance summed per line, or a target summed per source.
    if (MEASURED_AT_GRAIN.has(operator.kind) && operator.via)
      return (
        named(operator) +
        ' belongs to another record and would repeat once per ' +
        (offer.grain === 'line' ? 'line' : 'row') +
        '. Measure it at its own grain, or count distinct ' +
        'records instead.'
      );
    const numeric = ['decimal', 'integer', 'quantity'].includes(f.type);
    if (operator.kind === 'sum' && !(f.currency || f.type === 'quantity'))
      return named(operator);
    if (operator.kind === 'average' && !numeric) return named(operator);
    if (
      (operator.kind === 'min' || operator.kind === 'max') &&
      !(numeric || f.type === 'date' || f.basis === 'civilDate')
    )
      return named(operator);
    if (operator.kind === 'distinctCount' && f.type === 'instant' && !f.basis)
      return named(operator);
    if (operator.kind === 'distinctCount') return null;
    if (f.currency?.kind === 'stored' && !add({ fieldId: f.currency.fieldId }))
      return f.currency.fieldId;
    const key = canonicalize(f.currency ?? f.unitId ?? null);
    if (partition !== undefined && partition !== key) return named(operator);
    partition = key;
    return null;
  };
  for (const m of choices.measures) {
    if (m.kind === 'inline') {
      const problem = measureOperator(m.operator);
      if (problem) return problem;
      continue;
    }
    const approved = offer.measures.find(
      (a) =>
        a.measureId === m.measureId && a.contractDigest === m.contractDigest,
    );
    if (!approved) return m.measureId;
    const inner = approved.body.measures[0];
    if (inner?.kind !== 'inline') return m.measureId;
    const problem = measureOperator(inner.operator);
    if (problem) return problem;
  }
  if (offer.grain === 'line' && offer.sourceV2.parentRelationId)
    useLink([offer.sourceV2.parentRelationId]);
  return ReportBodyV2Schema.parse({
    version: 'grouped-report/v2',
    source: offer.sourceV2,
    dimensions: choices.dimensions,
    filters: choices.filters,
    measures: choices.measures,
    outputs: choices.outputs,
    links: [...links.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, l]) => l),
    operands: [...deps.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, o]) => o),
  });
}

export function reportDigestV2(body: ReportBodyV2) {
  return canonicalizeAndHash({
    ...body,
    measures: body.measures.map((m) =>
      m.kind === 'inline'
        ? { kind: m.kind, measureId: m.measureId, operator: m.operator }
        : m,
    ),
  }).contentHash;
}

/** Structural comparison on another base: the chosen bindings, their pinned
 * contracts and links must resolve identically. */
export function reportBindingProblemV2(
  def: ReportCatalogSource,
  body: ReportBodyV2,
): string | null {
  const offer = reportOfferV2(def, body.source.listSurfaceId);
  if (!offer || canonicalize(offer.sourceV2) !== canonicalize(body.source))
    return body.source.queryId;
  const bound = resolveReportChoicesV2(offer, {
    grain: body.source.grain,
    dimensions: body.dimensions,
    filters: body.filters,
    measures: body.measures,
    outputs: body.outputs,
  });
  if (typeof bound === 'string') return bound;
  const expected = new Map(body.operands.map((o) => [operandKey(o), o]));
  const operand =
    bound.operands.find(
      (o) =>
        canonicalize(o) !== canonicalize(expected.get(operandKey(o)) ?? null),
    ) ??
    body.operands.find(
      (o) => !bound.operands.some((b) => operandKey(b) === operandKey(o)),
    );
  if (operand) return operand.fieldId;
  if (canonicalize(bound.links) !== canonicalize(body.links))
    return (
      body.links
        .find(
          (l) => !bound.links.some((b) => canonicalize(b) === canonicalize(l)),
        )
        ?.via.at(-1) ??
      bound.links[0]?.via.at(-1) ??
      body.source.queryId
    );
  return null;
}

/** A named measure is a v2 body with no dimension and one inline measure. */
export function measureBodyProblem(
  measureId: string,
  body: ReportBodyV2,
): string | null {
  const [inner, extra] = body.measures;
  return body.dimensions.length ||
    extra ||
    inner?.kind !== 'inline' ||
    inner.measureId !== measureId
    ? measureId
    : null;
}
