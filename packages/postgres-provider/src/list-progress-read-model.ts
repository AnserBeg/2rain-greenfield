import type { StorageTargetPayloadV1 } from '@north-star/compiler';

type Entity = StorageTargetPayloadV1['entities'][number];
type Column = Entity['columns'][number];
export interface AdditionalListProgressPlan {
  readonly entity: Entity;
  readonly lineColumn: string;
  readonly quantityColumn: string;
  readonly filters: readonly {
    readonly column: Column;
    readonly value: string;
  }[];
  readonly output: string;
}

/** Commercial facts stay off the ledger; this read joins the same live lines. */
export function additionalListProgressSql(
  plan: AdditionalListProgressPlan | undefined,
  lines: Entity,
  activeLines: string,
  sql: {
    readonly quote: (name: string) => string;
    readonly column: (alias: string, name: string) => string;
    readonly bind: (value: unknown) => string;
    readonly scope: (entity: Entity, alias: string) => string;
    readonly sameCompany: (
      alias: string,
      entity: Entity,
      anchorAlias: string,
      anchor: Entity,
    ) => string;
  },
): string {
  if (!plan) return '0';
  const line = 'table_progress_line';
  const fact = 'table_progress_additional';
  const q = sql.column;
  return `(SELECT coalesce(sum(${q(fact, plan.quantityColumn)}), 0)
    FROM north_star_module.${sql.quote(lines.physicalTableName)} AS ${sql.quote(line)}
    JOIN north_star_module.${sql.quote(plan.entity.physicalTableName)} AS ${sql.quote(fact)}
      ON ${q(fact, 'tenant_id')}=${q(line, 'tenant_id')}
     AND ${q(fact, 'environment_id')}=${q(line, 'environment_id')}
     AND ${q(fact, plan.lineColumn)}=${q(line, lines.recordIdentity.column)}
     AND ${q(fact, plan.entity.archive.archivedAtColumn)} IS NULL
     ${sql.sameCompany(fact, plan.entity, line, lines)}${sql.scope(plan.entity, fact)}
     ${plan.filters.map((filter) => `AND ${q(fact, filter.column.physicalName)}::text=${sql.bind(filter.value)}::text`).join('\n')}
    WHERE ${activeLines})`;
}
