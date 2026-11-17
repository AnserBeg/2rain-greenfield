import { CUSTOMIZABLE_FIRST_PARTY_ENTITY_LOCALS, isTenantId } from './apply.js';

/**
 * What a person may point a change at, read from the live release's own
 * definition with the same §10.6 rules patch application enforces: record
 * types to add a field to, choice fields to add a choice to, and lists to
 * arrange. The Customize screen offers only these; the patch is still checked
 * again when it is applied.
 */
export interface CustomizationTargets {
  readonly choiceFields: readonly {
    readonly fieldId: string;
    readonly label: string;
    readonly options: readonly string[];
  }[];
  readonly lists: readonly {
    readonly columns: readonly {
      readonly fieldId: string;
      readonly label: string;
    }[];
    readonly label: string;
    readonly surfaceId: string;
  }[];
  readonly recordTypes: readonly {
    readonly entityId: string;
    readonly label: string;
    readonly tenantAuthored: boolean;
  }[];
}

type Json = Record<string, unknown>;

export function customizationTargets(definition: {
  readonly entities: readonly Json[];
  readonly fields: readonly Json[];
  readonly queries: readonly Json[];
  readonly surfaces: readonly Json[];
}): CustomizationTargets {
  const eligible = (entityId: string) =>
    isTenantId(entityId) ||
    (CUSTOMIZABLE_FIRST_PARTY_ENTITY_LOCALS as readonly string[]).includes(
      (entityId.split(':')[1] ?? '').split('.').slice(1).join('.'),
    );
  const entityLabel = new Map(
    definition.entities.map((entity) => [
      String(entity.entityId),
      String(entity.label),
    ]),
  );
  const recordTypes = definition.entities
    .filter((entity) => eligible(String(entity.entityId)))
    .map((entity) => ({
      entityId: String(entity.entityId),
      label: String(entity.label),
      tenantAuthored: isTenantId(String(entity.entityId)),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const choiceFields = definition.fields
    .filter(
      (field) =>
        isTenantId(String(field.fieldId)) &&
        (field.fieldType as Json).kind === 'enumFieldType',
    )
    .map((field) => ({
      fieldId: String(field.fieldId),
      label: `${entityLabel.get(String((field.entity as Json).targetId)) ?? ''} — ${String(field.label)}`,
      options: ((field.fieldType as Json).options as Json[])
        .slice()
        .sort((left, right) => Number(left.orderKey) - Number(right.orderKey))
        .map((option) => String(option.label)),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const queryEntity = new Map(
    definition.queries.map((query) => [
      String(query.queryId),
      String((query.sourceEntity as Json | undefined)?.targetId ?? ''),
    ]),
  );
  const lists = definition.surfaces
    .filter(
      (surface) =>
        surface.surfaceRole === 'list' &&
        surface.list !== undefined &&
        eligible(
          queryEntity.get(String((surface.dataSource as Json).targetId)) ?? '',
        ),
    )
    .map((surface) => ({
      columns: (((surface.list as Json).columns as Json[]) ?? [])
        .slice()
        .sort((left, right) => Number(left.orderKey) - Number(right.orderKey))
        .map((column) => ({
          fieldId: String(column.field),
          label: String(column.label),
        })),
      label: String(surface.label),
      surfaceId: String(surface.surfaceId),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return Object.freeze({ choiceFields, lists, recordTypes });
}
