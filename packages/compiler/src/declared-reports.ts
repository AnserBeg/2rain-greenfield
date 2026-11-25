import type {
  MeasureRevision,
  ReportBodyV2,
  ReportRevision,
  V6NormalizedApplicationPackage,
} from '../../canonical-model/src/schemas.js';
import {
  GROUPED_AGGREGATE_PROFILE,
  GROUPED_RESULT_VERSION,
} from '../../canonical-model/src/grouped-aggregate.js';
import {
  reportQueryId,
  reportOffer,
  reportBindingProblem,
  type EffectiveReportMeasure,
  type RegisteredReport,
  type RegisteredReportLink,
} from '../../canonical-model/src/declared-report.js';
import {
  measureBodyProblem,
  operandKey,
  reportOfferV2,
  type ReportOfferV2,
} from '../../canonical-model/src/declared-report-v2.js';
import type { StorageTargetPayloadV1 } from './storage.js';

type Entity = StorageTargetPayloadV1['entities'][number];

function accessPath(
  entity: Entity,
  scope: 'company' | 'tenant',
  dateColumn: string | undefined,
) {
  const keys = [
    'tenant_id',
    'environment_id',
    ...(entity.legalEntity ? ['legal_entity_id'] : []),
    ...(dateColumn ? [dateColumn] : []),
    'record_id',
  ];
  const path =
    entity.indexes.find(
      (i) =>
        i.indexKind === 'reportAccess' &&
        i.columnNames.join('/') === keys.join('/'),
    ) ??
    (!entity.legalEntity &&
    !dateColumn &&
    scope === 'tenant' &&
    entity.primaryKey.columns.join('/') === keys.join('/')
      ? entity.primaryKey
      : undefined);
  if (!path) throw new Error('REPORT_INDEX_UNAVAILABLE: ' + keys.join(', '));
  return { table: entity.physicalTableName, index: path.physicalName, keys };
}

/** Each hop is a declared many-to-one relation from the previous record,
 * looked up by the target's scoped unique key. A company-owned target is
 * joined within the run's company; a tenant-scoped grain cannot reach one. */
function lowerLinks(
  body: ReportBodyV2,
  grain: Entity,
  storage: StorageTargetPayloadV1,
): RegisteredReportLink[] {
  return body.links.map((link) => {
    const relationId = link.via.at(-1)!;
    const previous =
      link.via.length === 1
        ? grain
        : storage.entities.find(
            (e) =>
              e.entityId ===
              body.links.find(
                (l) => l.via.join('>') === link.via.slice(0, -1).join('>'),
              )?.entityId,
          );
    const relation = storage.relations.find((r) => r.relationId === relationId);
    const target = storage.entities.find((e) => e.entityId === link.entityId);
    if (
      !previous ||
      !relation ||
      !target ||
      target.factStorage ||
      relation.sourceEntityId !== previous.entityId ||
      relation.targetEntityId !== target.entityId ||
      relation.foreignKey.targetColumns.at(-1) !==
        target.recordIdentity.column ||
      !target.primaryKey.columns.includes(target.recordIdentity.column) ||
      !!target.legalEntity !== (link.scope === 'company') ||
      (body.source.scope === 'tenant' && link.scope === 'company')
    )
      throw new Error('REPORT_LINK_UNAVAILABLE: ' + relationId);
    return {
      via: [...link.via],
      entityId: link.entityId,
      queryId: link.queryId,
      readPermissionId: link.readPermissionId,
      required: link.required,
      table: target.physicalTableName,
      relationColumn: relation.relationColumn.physicalName,
      legalEntity: !!target.legalEntity,
    };
  });
}

function lowerOne(
  def: V6NormalizedApplicationPackage,
  storage: StorageTargetPayloadV1,
  surface: { surfaceId: string; label: string },
  revision: ReportRevision,
  kind?: 'measure',
): RegisteredReport {
  const { body } = revision;
  const problem = reportBindingProblem(def, body);
  if (problem) throw new Error('REPORT_BINDING_UNAVAILABLE: ' + problem);
  const entity = storage.entities.find(
    (e) => e.entityId === body.source.entityId,
  );
  if (
    !entity ||
    !!entity.legalEntity !== (body.source.scope === 'company') ||
    entity.factStorage
  )
    throw new Error('REPORT_SCOPE_UNAVAILABLE: ' + body.source.entityId);
  const v2 = body.version === 'grouped-report/v2';
  const offerV2 = v2
    ? reportOfferV2(def, body.source.listSurfaceId, body.links)
    : null;
  const offered = v2
    ? [...offerV2!.fields, ...offerV2!.links.flatMap((l) => l.fields)]
    : reportOffer(def, body.source.listSurfaceId)!.fields;
  const links = v2 ? lowerLinks(body, entity, storage) : [];
  // A line body always joins its declared parent as a required link.
  if (
    v2 &&
    body.source.grain === 'line' &&
    !links.some(
      (l) =>
        l.required &&
        l.via.length === 1 &&
        l.via[0] === body.source.parentRelationId,
    )
  )
    throw new Error(
      'REPORT_LINK_UNAVAILABLE: ' + (body.source.parentRelationId ?? 'parent'),
    );
  const columns = body.operands.map((operand) => {
    const via = 'via' in operand ? operand.via : undefined;
    const owner = via
      ? storage.entities.find(
          (e) =>
            e.entityId ===
            links.find((l) => l.via.join('>') === via.join('>'))?.entityId,
        )
      : entity;
    const storageColumn = owner?.columns.find(
      (c) => c.canonicalFieldId === operand.fieldId,
    );
    if (!storageColumn)
      throw new Error('REPORT_COLUMN_UNAVAILABLE: ' + operand.fieldId);
    const field = offered.find(
      (f) => operandKey(f.operand) === operandKey(operand),
    )!;
    return {
      ...operand,
      columnName: storageColumn.physicalName,
      label: field.label,
      ...(field.options && { options: field.options }),
    };
  });
  const date = body.filters.find((f) => f.kind === 'dateRange');
  const dateColumn =
    date &&
    columns.find((c) => c.fieldId === date.fieldId && !('via' in c && c.via));
  const query = def.queries.find((q) => q.queryId === body.source.queryId)!;
  const scopeOf = (queryId: string) => {
    const q = def.queries.find((candidate) => candidate.queryId === queryId);
    return q && 'legalEntityScope' in q && q.legalEntityScope
      ? { legalEntityScope: q.legalEntityScope }
      : {};
  };
  const measures = (offer: ReportOfferV2): EffectiveReportMeasure[] =>
    body.measures.map((m) => {
      if (m.kind === 'inline')
        return {
          measureId: m.measureId,
          label: m.label,
          operator: m.operator,
        };
      const approved = offer.measures.find(
        (a) =>
          a.measureId === m.measureId && a.contractDigest === m.contractDigest,
      );
      const inner = approved?.body.measures[0];
      if (!approved || inner?.kind !== 'inline')
        throw new Error('REPORT_MEASURE_UNAVAILABLE: ' + m.measureId);
      return {
        measureId: m.measureId,
        label: approved.label,
        operator: inner.operator,
        approved: { contractDigest: m.contractDigest },
      };
    });
  return {
    queryId: reportQueryId(revision.reportId),
    tier: 'q1' as const,
    profile: GROUPED_AGGREGATE_PROFILE,
    resultContract: GROUPED_RESULT_VERSION,
    surfaceId: surface.surfaceId,
    label: surface.label,
    revision,
    ...('legalEntityScope' in query && query.legalEntityScope
      ? { legalEntityScope: query.legalEntityScope }
      : {}),
    columns,
    accessPath: accessPath(entity, body.source.scope, dateColumn?.columnName),
    ...(offerV2 && {
      links: links.map((l) => ({ ...l, ...scopeOf(l.queryId) })),
      measures: measures(offerV2),
    }),
    ...(kind && { kind }),
  } satisfies RegisteredReport;
}

export function lowerDeclaredReports(
  def: V6NormalizedApplicationPackage,
  storage: StorageTargetPayloadV1,
): RegisteredReport[] {
  return def.surfaces.flatMap((s) => {
    if (s.lifecycle !== 'active') return [];
    if (s.report) return [lowerOne(def, storage, s, s.report)];
    if (!('measure' in s) || !s.measure) return [];
    // A named measure registers its own total: the trial runs on authorized
    // data through the same bounded reader and confers nothing on reports.
    const m = s.measure as MeasureRevision;
    const problem = measureBodyProblem(m.measureId, m.body);
    if (problem) throw new Error('REPORT_MEASURE_UNAVAILABLE: ' + problem);
    return [
      lowerOne(
        def,
        storage,
        s,
        {
          reportId: m.measureId,
          revisionId: m.revisionId,
          predecessorDigest: m.predecessorDigest,
          contractDigest: m.contractDigest,
          body: m.body,
        },
        'measure',
      ),
    ];
  });
}
