import { isNarrowableOperationId } from '@north-star/canonical-model';
import {
  CUSTOMIZABLE_FIRST_PARTY_ENTITY_LOCALS,
  isTenantId,
  listColumnId,
} from './apply.js';

/**
 * What a person may point a change at, read from the live release's own
 * definition with the same §10.6 rules patch application enforces: record
 * types to add a field to, choice fields to add a choice to, and lists to
 * arrange. The Customize screen offers only these; the patch is still checked
 * again when it is applied.
 */
export interface CustomizationTargets {
  readonly metricLists?: readonly MetricListTarget[];
  readonly permissionRoleKeys?: readonly string[];
  readonly permissionRoleLabels?: Readonly<Record<string, string>>;
  readonly permissionRestrictions?: readonly {
    readonly operationId: string;
    readonly roleKey: string;
  }[];
  readonly permissionActions?: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly choiceFields: readonly {
    readonly fieldId: string;
    readonly label: string;
    readonly options: readonly string[];
  }[];
  readonly forms?: readonly {
    readonly surfaceId: string;
    readonly label: string;
    readonly fields: readonly {
      readonly fieldId: string;
      readonly label: string;
      readonly upFront: boolean;
    }[];
  }[];
  readonly lists: readonly {
    readonly columns: readonly {
      readonly hidden?: true;
      readonly fieldId: string;
      readonly label: string;
    }[];
    readonly label: string;
    readonly surfaceId: string;
    readonly savedView?: {
      readonly columns: readonly {
        readonly columnId: string;
        readonly label: string;
        readonly title: boolean;
        readonly sortable: boolean;
      }[];
      readonly filters: readonly {
        readonly field: string;
        readonly label: string;
        readonly options: readonly { value: string; label: string }[];
      }[];
    };
  }[];
  readonly recordTypes: readonly {
    readonly entityId: string;
    readonly label: string;
    readonly tenantAuthored: boolean;
  }[];
}

export interface MetricListTarget {
  readonly surfaceId: string;
  readonly label: string;
  readonly views: readonly {
    readonly viewId: string;
    readonly label: string;
  }[];
  readonly measures: readonly {
    readonly fieldId: string;
    readonly label: string;
  }[];
}

type Json = Record<string, unknown>;

export function customizationTargets(definition: {
  readonly entities: readonly Json[];
  readonly fields: readonly Json[];
  readonly operations?: readonly Json[];
  readonly operationRoleNarrowings?: CustomizationTargets['permissionRestrictions'];
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
  const forms = definition.surfaces
    .filter((surface) => surface.surfaceRole === 'form')
    .map((surface) => {
      const fields = ((surface.documentEditor as Json | undefined)
        ?.headerFields ??
        (surface.form as Json | undefined)?.fields ??
        []) as Json[];
      return {
        surfaceId: String(surface.surfaceId),
        label: String(surface.label),
        fields: fields
          .filter((field) => isTenantId(String(field.fieldId)))
          .map((field) => ({
            fieldId: String(field.fieldId),
            label: String(field.label),
            upFront: field.disclosure !== 'more',
          })),
      };
    })
    .filter((form) => form.fields.length > 0);
  const availableColumns = (surface: Json) => {
    const query = definition.queries.find(
      (q) => q.queryId === (surface.dataSource as Json).targetId,
    );
    const entityId = (query?.sourceEntity as Json | undefined)?.targetId;
    const columns = (
      ((surface.list as Json | undefined)?.columns ??
        ((query?.selections ?? []) as Json[]).map((selection) => {
          const fieldId = (selection.field as Json).targetId;
          return {
            field: fieldId,
            label: definition.fields.find((field) => field.fieldId === fieldId)
              ?.label,
            orderKey: selection.orderKey,
          };
        })) as Json[]
    )
      .slice()
      .sort((a, b) => Number(a.orderKey) - Number(b.orderKey))
      .map((c) => ({ fieldId: String(c.field), label: String(c.label) }));
    return [
      ...columns,
      ...definition.fields
        .filter(
          (f) =>
            (f.entity as Json).targetId === entityId &&
            !columns.some((c) => c.fieldId === f.fieldId),
        )
        .map((f) => ({
          fieldId: String(f.fieldId),
          label: String(f.label),
          hidden: true as const,
        })),
    ];
  };
  const lists = definition.surfaces
    .filter(
      (surface) =>
        surface.surfaceRole === 'list' &&
        eligible(
          queryEntity.get(String((surface.dataSource as Json).targetId)) ?? '',
        ),
    )
    .map((surface) => {
      const surfaceId = String(surface.surfaceId);
      const columns = availableColumns(surface);
      const declared = surface.list as Json | undefined;
      const entity = queryEntity.get(
        String((surface.dataSource as Json).targetId),
      )!;
      const [namespace, entityName] = entity.split(':');
      const declaredColumns = declared?.columns as Json[] | undefined;
      const visible = declaredColumns
        ? declaredColumns
            .slice()
            .sort((a, b) => Number(a.orderKey) - Number(b.orderKey))
            .map((column) => ({
              columnId: String(column.columnId),
              label: String(column.label),
              title: column.role === 'title',
              sortable: column.sortable === true,
            }))
        : columns
            .filter((column) => !('hidden' in column))
            .map((column, index) => ({
              columnId: listColumnId(
                namespace!,
                entityName!.slice('entity.'.length),
                column.fieldId,
              ),
              label: column.label,
              title: index === 0,
              sortable: true,
            }));
      const filters = (declared?.filters ?? []) as NonNullable<
        CustomizationTargets['lists'][number]['savedView']
      >['filters'];
      return {
        columns,
        label: String(surface.label),
        surfaceId,
        ...(((declared?.views as Json[] | undefined)?.filter(
          (view) => view.layout,
        ).length ?? 0) < 8 && visible.length > 0
          ? { savedView: { columns: visible, filters } }
          : {}),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  const metricLists = definition.surfaces.some(
    (surface) =>
      String(surface.surfaceId).endsWith(':surface.inventory_today') &&
      surface.launcher,
  )
    ? definition.surfaces
        .flatMap((surface) => {
          const list = surface.list as Json | undefined;
          if (
            !list ||
            surface.surfaceRole !== 'list' ||
            surface.lifecycle !== 'active'
          )
            return [];
          const query = definition.queries.find(
            (candidate) =>
              candidate.queryId === (surface.dataSource as Json).targetId,
          );
          if (
            !query ||
            query.queryType !== 'list' ||
            query.tier !== 'q0' ||
            query.lifecycle !== 'active' ||
            query.readModel
          )
            return [];
          return [
            {
              surfaceId: String(surface.surfaceId),
              label: String(surface.label),
              views: (list.views as Json[]).map((view) => ({
                viewId: String(view.viewId),
                label: String(view.label),
              })),
              measures: (list.progress || list.figures
                ? []
                : ((query.listSumFields ?? []) as string[])
              ).map((fieldId) => ({
                fieldId,
                label: String(
                  definition.fields.find((field) => field.fieldId === fieldId)
                    ?.label,
                ),
              })),
            },
          ];
        })
        .sort((left, right) => left.label.localeCompare(right.label))
    : [];
  return Object.freeze({
    ...(definition.operationRoleNarrowings && {
      permissionRestrictions: definition.operationRoleNarrowings,
    }),
    ...(definition.operations && {
      permissionActions: definition.operations
        .filter(
          (operation) =>
            operation.lifecycle === 'active' &&
            isNarrowableOperationId(String(operation.operationId)),
        )
        .map((operation) => ({
          id: String(operation.operationId),
          label: String(
            operation.label ??
              String(operation.operationId)
                .split(':operation.')
                .at(-1)!
                .replaceAll('_', ' '),
          ),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    }),
    choiceFields,
    forms,
    lists,
    recordTypes,
    ...(metricLists.length ? { metricLists } : {}),
  });
}
