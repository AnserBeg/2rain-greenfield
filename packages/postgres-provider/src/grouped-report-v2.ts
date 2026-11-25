import type { PoolClient } from 'pg';
import type { StorageEntityTarget } from '../../compiler/src/storage.js';
import type { GroupedExecution } from '../../runtime/src/semantic-query-gateway.js';
import {
  RESTRICTED_KEY,
  averageValue,
  emptyCell,
  finishGroups,
  type CurrencyPartition,
  type GroupKey,
  type GroupedRow,
  type ReportBodyV2,
  type ReportDimensionSpec,
  type ReportMeasureSpec,
} from '@north-star/canonical-model';
import {
  effectiveMeasures,
  filterParameterId,
  reportColumnFor,
  type RegisteredReport,
} from '../../canonical-model/src/declared-report.js';
import type {
  ReportHorizon,
  ReportLimits,
  ReportSnapshot,
} from '../../runtime/src/declared-report.js';

const ident = (v: string) => {
  if (!/^[a-z][a-z_0-9]*$/u.test(v))
    throw new Error('Invalid report index identifier');
  return '"' + v + '"';
};
type Column = RegisteredReport['columns'][number];
type Via = readonly string[] | undefined;
const pathKey = (via: Via) => via?.join('>') ?? '';

export interface ReportPolicyHooks {
  /** The issued live narrowing of the source list, at the grain alias. */
  grain(alias: string, values: unknown[], predicates: string[]): void;
  /** The issued live narrowing of link i's target list, at its alias. */
  link(i: number, alias: string, values: unknown[], predicates: string[]): void;
}

/** REPORTS-1 slice 2. One bounded, authorized snapshot of a v2 report:
 * company scope and the cap-plus-one probe run on the grain's own index range
 * first; declared to-one links are looked up by their scoped unique key under
 * their own row policy; a hidden target is Restricted, never its ID. */
export async function readGroupedSnapshotV2(
  client: PoolClient,
  entity: StorageEntityTarget,
  linkEntities: readonly StorageEntityTarget[],
  request: Pick<GroupedExecution, 'report' | 'input' | 'remaining'> & {
    view: Pick<GroupedExecution['view'], 'tenantId' | 'environmentId'>;
    scope: Pick<GroupedExecution['scope'], 'legalEntityIds'>;
  },
  horizon: ReportHorizon,
  policy: ReportPolicyHooks,
  limits: ReportLimits,
  indexReady: (
    table: string,
    index: string,
    keys: string[],
  ) => Promise<boolean>,
): Promise<ReportSnapshot | { kind: 'narrow' | 'unavailable' }> {
  const { report, view, input, scope } = request;
  const body = report.revision.body as ReportBodyV2;
  const links = report.links ?? [];
  const { table, index, keys } = report.accessPath;
  if (
    entity.physicalTableName !== table ||
    links.some((l, i) => linkEntities[i]?.physicalTableName !== l.table) ||
    !(await indexReady(table, index, keys))
  )
    return { kind: 'unavailable' };
  const company = scope.legalEntityIds[0];
  const args: unknown[] = [];
  const param = (value: unknown) => {
    args.push(value);
    return '$' + args.length;
  };
  const aliasOf = (via: Via) => {
    if (!via) return 'g';
    const i = links.findIndex((l) => pathKey(l.via) === pathKey(via));
    if (i < 0) throw new Error('Undeclared report link');
    return 'l' + i;
  };
  const columnOf = (o: { fieldId: string; via?: Via }): Column => {
    const c = reportColumnFor(report, o);
    if (!c) throw new Error('Unknown report operand');
    return c;
  };
  const raw = (o: { fieldId: string; via?: Via }) =>
    aliasOf(o.via) + '.' + ident(columnOf(o).columnName);
  // The CASE prefix of a path: absent at a null relation, Restricted where
  // the next target is not admitted. The grain itself is always present.
  const guard = (via: Via, value: string, hidden = "'r'") => {
    if (!via) return value;
    let sql = 'CASE';
    for (let hop = 1; hop <= via.length; hop++) {
      const link = links.findIndex(
        (l) => pathKey(l.via) === pathKey(via.slice(0, hop)),
      );
      const previous = hop === 1 ? 'g' : aliasOf(via.slice(0, hop - 1));
      sql += ` WHEN ${previous}.${ident(links[link]!.relationColumn)} IS NULL THEN NULL WHEN l${link}.record_id IS NULL THEN ${hidden}`;
    }
    return sql + ` ELSE ${value} END`;
  };
  const civilDate = (o: { fieldId: string; via?: Via }) => {
    const c = columnOf(o);
    const r = raw(o);
    return c.type === 'date'
      ? `${r}::date`
      : c.basis === 'civilDate'
        ? `(${r} AT TIME ZONE 'UTC')::date`
        : `((${r} AT TIME ZONE ${param(horizon.zone)}) - (${param(horizon.boundary)}::time - time '00:00'))::date`;
  };
  const text = (o: { fieldId: string; via?: Via }) => {
    const c = columnOf(o);
    const r = raw(o);
    if (c.collation === 'unicodeCaseInsensitive')
      return `north_star_module.nsm_unicode_case_fold_v1(${r}::text) COLLATE "C"`;
    if (c.type === 'date' || c.basis === 'civilDate')
      return `to_char(${civilDate(o)}, 'YYYY-MM-DD')`;
    if (c.type === 'instant')
      return `to_char(${r} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    return `${r}::text COLLATE "C"`;
  };

  // 1. Candidates: tenant, environment, company and the declared date range
  // on the grain's index, probed to the cap plus one before anything else.
  const conditions = [
    `g.tenant_id=${param(view.tenantId)}`,
    `g.environment_id=${param(view.environmentId)}`,
  ];
  if (entity.legalEntity)
    conditions.push(`g.legal_entity_id=${param(company)}::uuid`);
  for (const f of body.filters) {
    const v = input.parameters[filterParameterId(f)];
    if (f.kind !== 'dateRange' || !v || typeof v !== 'object' || !('from' in v))
      continue;
    const c = columnOf(f);
    const endpoint = (d: string) =>
      c.type === 'date'
        ? param(d) + '::date'
        : c.basis === 'civilDate'
          ? `(${param(d)}::date::timestamp AT TIME ZONE 'UTC')`
          : `((${param(d)}::date+${param(horizon.boundary)}::time) AT TIME ZONE ${param(horizon.zone)})`;
    conditions.push(
      `${raw(f)} >= ${endpoint(v.from)} AND ${raw(f)} < ${endpoint(v.until)}`,
    );
  }
  const budget = async () => {
    const ms = Math.min(limits.statementMs, request.remaining());
    await client.query(
      "SELECT pg_catalog.set_config('statement_timeout',$1,true)",
      [String(ms)],
    );
  };
  const range = `FROM north_star_module.${ident(table)} g WHERE ${conditions.join(' AND ')} ORDER BY ${keys.map((k) => 'g.' + ident(k)).join(',')} LIMIT ${param(limits.facts + 1)}`;
  await budget();
  const probe = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM (SELECT 1 ${range}) candidates`,
    args,
  );
  if (probe.rows[0]!.n > limits.facts) return { kind: 'narrow' };

  // 2. Joins: each hop by the target's scoped unique key, same company when
  // the target is company-owned, live and under its own row policy.
  const joins = links.map((l, i) => {
    const alias = 'l' + i;
    const previous = l.via.length === 1 ? 'g' : aliasOf(l.via.slice(0, -1));
    const on = [
      `${alias}.tenant_id=${previous}.tenant_id`,
      `${alias}.environment_id=${previous}.environment_id`,
      `${alias}.record_id=${previous}.${ident(l.relationColumn)}`,
      `${alias}.archived_at IS NULL`,
    ];
    if (l.legalEntity)
      on.push(`${alias}.legal_entity_id=${param(company)}::uuid`);
    policy.link(i, alias, args, on);
    return `LEFT JOIN north_star_module.${ident(l.table)} ${alias} ON ${on.join(' AND ')}`;
  });
  const predicates = ['g.archived_at IS NULL'];
  policy.grain('g', args, predicates);
  links.forEach((l, i) => {
    if (l.required) predicates.push(`l${i}.record_id IS NOT NULL`);
  });
  for (const f of body.filters) {
    const value = input.parameters[filterParameterId(f)];
    if (value === undefined || f.kind === 'dateRange') continue;
    // A hidden or absent target never matches a filter on its value.
    const folded = columnOf(f).collation === 'unicodeCaseInsensitive';
    predicates.push(
      f.kind === 'membership'
        ? `${raw(f)}::text=ANY(${param(value)}::text[])`
        : folded
          ? `${text(f)} = north_star_module.nsm_unicode_case_fold_v1(${param(value)}::text) COLLATE "C"`
          : `${text(f)} = ${param(value)}`,
    );
  }

  // 3. Group keys: 'v'-prefixed values, 'r' for Restricted, NULL for absence.
  const asOf = param(horizon.businessDate);
  const dims = body.dimensions.map((d, i) => {
    let value: string;
    if (d.kind === 'direct') value = `'v' || ${text(d)}`;
    else if (d.kind === 'calendar') {
      const day = civilDate(d);
      value =
        d.unit === 'day'
          ? `'v' || to_char(${day}, 'YYYY-MM-DD')`
          : d.unit === 'week'
            ? `'v' || to_char(date_trunc('week', ${day})::date, 'YYYY-MM-DD')`
            : `'v' || to_char(${day}, 'YYYY-MM')`;
    } else {
      const age = `(${asOf}::date - ${civilDate(d)})`;
      value =
        'CASE' +
        d.bands
          .map(
            (b) =>
              ` WHEN ${[
                ...(b.from === null ? [] : [`${age} >= ${param(b.from)}::int`]),
                ...(b.through === null
                  ? []
                  : [`${age} <= ${param(b.through)}::int`]),
                'TRUE',
              ].join(' AND ')} THEN ${param('v' + b.bandId)}::text`,
          )
          .join('') +
        ' END';
    }
    return guard(d.via, value) + ' AS d' + i;
  });
  const names = dims.map((_, i) => 'd' + i);

  // 4. Measures at the grain; distinct counts may reach through a path.
  const measures = effectiveMeasures(report);
  const operands = measures.map((m) => {
    const op = m.operator;
    if (op.kind === 'count') return undefined;
    if (op.kind === 'distinctTargets') return undefined;
    return columnOf(op);
  });
  const currency = operands.find(
    (c, i) =>
      c?.currency &&
      ['sum', 'min', 'max', 'average'].includes(measures[i]!.operator.kind),
  )?.currency;
  const partition =
    currency?.kind === 'stored'
      ? `CASE WHEN g.${ident(columnOf({ fieldId: currency.fieldId }).columnName)}=ANY(${param(currency.codes)}::text[]) THEN g.${ident(columnOf({ fieldId: currency.fieldId }).columnName)} END`
      : currency?.kind === 'fixed'
        ? param(currency.currencyCode) + '::text'
        : 'NULL::text';
  const values = measures.map((m, i) => {
    const op = m.operator;
    if (op.kind === 'count') return 'NULL::text AS m' + i;
    if (op.kind === 'distinctTargets')
      return `${aliasOf(op.via)}.record_id AS m${i}`;
    const c = operands[i]!;
    const v =
      op.kind === 'distinctCount'
        ? text(op)
        : c.type === 'date' || c.basis === 'civilDate'
          ? civilDate(op)
          : raw(op);
    return guard(op.via, v, 'NULL') + ' AS m' + i;
  });
  const scaleOf = (i: number) => operands[i]?.scale ?? 0;
  const aggregates = measures.map((m, i) => {
    const op = m.operator;
    const missing = `count(*) FILTER (WHERE m${i} IS NULL)::int AS missing${i}`;
    const c = operands[i];
    const dateLike = c && (c.type === 'date' || c.basis === 'civilDate');
    switch (op.kind) {
      case 'count':
        return `count(*)::text AS v${i}, 0 AS missing${i}, 0 AS n${i}`;
      case 'sum':
        return `COALESCE(SUM(m${i}),0)::numeric(38,${scaleOf(i)})::text AS v${i}, ${missing}, 0 AS n${i}`;
      case 'average':
        return `COALESCE(SUM(m${i}),0)::numeric(38,${scaleOf(i)})::text AS v${i}, ${missing}, count(m${i})::int AS n${i}`;
      case 'min':
      case 'max': {
        const fn = op.kind === 'min' ? 'MIN' : 'MAX';
        return dateLike
          ? `to_char(${fn}(m${i}), 'YYYY-MM-DD') AS v${i}, ${missing}, 0 AS n${i}`
          : `(${fn}(m${i}))::numeric(38,${scaleOf(i)})::text AS v${i}, ${missing}, 0 AS n${i}`;
      }
      case 'distinctCount':
      case 'distinctTargets':
        return `count(DISTINCT m${i})::text AS v${i}, ${missing}, 0 AS n${i}`;
    }
  });
  const grouping = names.length
    ? `GROUP BY GROUPING SETS ((part,${names.join(',')}),(part))`
    : 'GROUP BY part';
  const totalFlag = names.length ? `grouping(d0)::int` : '1';
  const partitions =
    currency?.kind === 'stored' ? currency.codes.length + 1 : 1;
  await budget();
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (SELECT g.* ${range}), admitted AS (
      SELECT ${partition} AS part${dims.length ? ',' + dims.join(',') : ''},${values.join(',')}
      FROM candidates g ${joins.join(' ')}
      WHERE ${predicates.join(' AND ')})
    SELECT part${names.length ? ',' + names.join(',') : ''},${totalFlag} AS total,count(*)::int AS facts,${aggregates.join(',')}
    FROM admitted ${grouping}
    ORDER BY total DESC
    LIMIT ${param(limits.groups + 1 + partitions)}`,
    args,
  );
  const key = (v: unknown): GroupKey =>
    v == null ? null : v === 'r' ? RESTRICTED_KEY : String(v).slice(1);
  const specs: ReportMeasureSpec[] = measures.map((m, i) => ({
    id: m.measureId,
    operator: m.operator.kind,
    scale: scaleOf(i),
    ...(operands[i]?.type && { type: operands[i]!.type }),
    ...(operands[i]?.unitId &&
      ['sum', 'min', 'max', 'average'].includes(m.operator.kind) && {
        unitId: operands[i]!.unitId!,
      }),
  }));
  const groups: GroupedRow[] = [];
  const totals: GroupedRow[] = [];
  let facts = 0;
  for (const r of result.rows) {
    const part: CurrencyPartition = !currency
      ? { kind: 'unitless' }
      : r.part === null
        ? { kind: 'noCurrency' }
        : { kind: 'currency', code: String(r.part) };
    const row: GroupedRow = {
      partition: part,
      keys: r.total ? [] : names.map((n) => key(r[n])),
      cells: specs.map((m, i) => {
        const v = r['v' + i] == null ? null : String(r['v' + i]);
        return {
          measureId: m.id,
          value:
            m.operator === 'average'
              ? averageValue(v ?? '0', Number(r['n' + i]), m.scale)
              : v,
          ...(m.unitId && { unitId: m.unitId }),
          ...(m.operator === 'average' && {
            exact: { sum: v ?? '0', count: Number(r['n' + i]) },
          }),
          recordsWithoutMeasure: Number(r['missing' + i]),
        };
      }),
    };
    if (r.total) {
      totals.push(row);
      facts += Number(r.facts);
    } else groups.push(row);
  }
  if (groups.length > limits.groups) return { kind: 'narrow' };
  if (!totals.length && currency?.kind !== 'stored')
    totals.push({
      keys: [],
      partition: currency
        ? { kind: 'currency', code: currency.currencyCode }
        : { kind: 'unitless' },
      cells: specs.map(emptyCell),
    });
  const dimSpecs: ReportDimensionSpec[] = body.dimensions.map((d) => {
    const c = columnOf(d);
    return {
      operand: d.fieldId,
      kind: d.kind,
      type: c.type,
      ...(c.basis && { basis: c.basis }),
      ...(d.kind === 'calendar' && { unit: d.unit }),
      ...(d.kind === 'age' && { bands: d.bands }),
      ...(d.kind === 'direct' &&
        c.type === 'choice' &&
        c.options && { options: c.options.map((o) => o.id) }),
    };
  });
  const filled = finishGroups(
    dimSpecs,
    specs,
    groups,
    totals.map((t) => t.partition),
  );
  if (filled.length > limits.groups) return { kind: 'narrow' };
  return { groups: filled, totals, facts, horizon };
}
