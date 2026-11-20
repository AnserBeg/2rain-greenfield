import type {
  DocumentTemplatePointer,
  DocumentTemplateRevision,
} from '../../canonical-model/src/document-template-schema.js';
import { displayTypeForField } from '../../canonical-model/src/calculated-display-bindings.js';
import type { CalculatedDisplayTarget } from './calculated-display-draft.js';
import { isNarrowableOperationId } from '@north-star/canonical-model';
import { formulaFieldType } from '../../canonical-model/src/formula-validation-bindings.js';
import { resolveValidationPath } from '../../canonical-model/src/formula-validation-path.js';
import { VALIDATION_NODE_VERSION } from '../../canonical-model/src/formula-validation.js';
import {
  CUSTOMIZABLE_FIRST_PARTY_ENTITY_LOCALS,
  isTenantId,
  linkTarget,
  listColumnId,
} from './apply.js';
import type { LiteralValidationTarget } from './validation-draft.js';

/**
 * What a person may point a change at, read from the live release's own
 * definition with the same §10.6 rules patch application enforces: record
 * types to add a field to, choice fields to add a choice to, and lists to
 * arrange. The Customize screen offers only these; the patch is still checked
 * again when it is applied.
 */
export interface DocumentTemplateChoice {
  readonly fieldId: string;
  readonly label: string;
  readonly kind: string;
}

export interface DocumentTemplateTarget {
  readonly entityId: string;
  readonly label: string;
  readonly queries: ReadonlyArray<{
    readonly queryId: string;
    readonly fields: readonly DocumentTemplateChoice[];
  }>;
  readonly tables: ReadonlyArray<{
    readonly queryId: string;
    readonly relationId: string;
    readonly label: string;
    readonly fields: readonly DocumentTemplateChoice[];
  }>;
  readonly templates: readonly DocumentTemplateRevision[];
}

export interface CustomizationTargets {
  readonly documentTemplateTargets?: readonly DocumentTemplateTarget[];
  readonly documentTargets?: readonly {
    readonly entityId: string;
    readonly label: string;
  }[];
  readonly calculatedDisplayTargets?: readonly CalculatedDisplayTarget[];
  readonly validationTargets?: readonly LiteralValidationTarget[];
  readonly linkTargets?: readonly {
    readonly entityId: string;
    readonly label: string;
    readonly companyOwned: boolean;
  }[];
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
  readonly documentTemplatePointers?: readonly DocumentTemplatePointer[];
  readonly documentTemplateRevisions?: readonly DocumentTemplateRevision[];
  readonly calculatedDisplayFields?:
    readonly { displaySinks: readonly { surfaceId: string }[] }[] | undefined;
  readonly entities: readonly Json[];
  readonly fields: readonly Json[];
  readonly languageVersion?: string;
  readonly operations?: readonly Json[];
  readonly operationRoleNarrowings?: CustomizationTargets['permissionRestrictions'];
  readonly queries: readonly Json[];
  readonly relations?: readonly Json[];
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
  const recordQueryIds = new Set(
    definition.surfaces
      .filter(
        (surface) =>
          surface.surfaceRole === 'record' && surface.lifecycle === 'active',
      )
      .map((surface) => (surface.dataSource as Json)?.targetId),
  );
  const documentEntityIds = new Set(
    definition.queries
      .filter(
        (query) =>
          query.queryType === 'get' &&
          query.tier === 'q0' &&
          query.lifecycle === 'active' &&
          !query.readModel &&
          recordQueryIds.has(query.queryId),
      )
      .map((query) => (query.sourceEntity as Json)?.targetId),
  );
  const documentTargets = definition.entities
    .filter(
      (entity) =>
        entity.lifecycle === 'active' && documentEntityIds.has(entity.entityId),
    )
    .map((entity) => ({
      entityId: String(entity.entityId),
      label: String(entity.label),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const queryChoices = (query: Json) => ({
    queryId: String(query.queryId),
    fields: ((query.selections ?? []) as Json[]).flatMap(({ field }) => {
      const member = definition.fields.find(
        ({ fieldId }) => fieldId === (field as Json)?.targetId,
      );
      return member?.lifecycle === 'active' &&
        ['public', 'internal'].includes(String(member.classification))
        ? [
            {
              fieldId: String(member.fieldId),
              label: String(member.label),
              kind: String((member.fieldType as Json).kind),
            },
          ]
        : [];
    }),
  });
  const recordQueries = definition.queries.filter(
    (query) =>
      query.tier === 'q0' &&
      query.lifecycle === 'active' &&
      !query.readModel &&
      (query.filter as Json)?.kind === 'booleanPredicate' &&
      (query.filter as Json)?.value === true &&
      ((query.parameters ?? []) as Json[]).length ===
        (query.legalEntityScope ? 1 : 0),
  );
  const documentTemplateTargets: DocumentTemplateTarget[] =
    definition.languageVersion === 'v6'
      ? definition.entities.flatMap((entity) => {
          const entityId = String(entity.entityId);
          const label = String(entity.label);
          if (
            entity.lifecycle !== 'active' ||
            !definition.queries.some(
              (query) =>
                query.queryType === 'get' &&
                query.tier === 'q0' &&
                query.lifecycle === 'active' &&
                recordQueryIds.has(query.queryId) &&
                (query.sourceEntity as Json).targetId === entityId,
            )
          )
            return [];
          const queries = recordQueries
            .filter(
              (query) =>
                query.queryType === 'get' &&
                (query.sourceEntity as Json).targetId === entityId,
            )
            .map(queryChoices)
            .filter(({ fields }) =>
              fields.some(
                ({ kind }) =>
                  kind === 'textFieldType' || kind === 'integerFieldType',
              ),
            );
          if (!queries.length) return [];
          const tables = (definition.relations ?? []).flatMap((relation) => {
            if (
              relation.ownership !== 'parentScopedChild' ||
              relation.lifecycle !== 'active' ||
              (relation.targetEntity as Json).targetId !== entityId
            )
              return [];
            const childId = String((relation.sourceEntity as Json).targetId);
            return recordQueries
              .filter(
                (query) =>
                  query.queryType === 'list' &&
                  (query.sourceEntity as Json).targetId === childId,
              )
              .map((query) => ({
                ...queryChoices(query),
                relationId: String(relation.relationId),
                label: entityLabel.get(childId) ?? childId,
              }))
              .filter(({ fields }) => fields.length);
          });
          const templates = (definition.documentTemplateRevisions ?? []).filter(
            (revision) =>
              revision.entityId === entityId &&
              definition.documentTemplatePointers?.some(
                ({ activeRevisionId }) =>
                  activeRevisionId === revision.revisionId,
              ),
          );
          return [{ entityId, label, queries, tables, templates }];
        })
      : [];
  const validationTargets =
    definition.languageVersion === 'v6'
      ? recordTypes.flatMap(({ entityId, label }) => {
          const operationIds = (definition.operations ?? []).flatMap(
            (operation) => {
              const effect = operation.effect as Json | undefined;
              return operation.lifecycle === 'active' &&
                operation.tier === 'o0' &&
                (effect?.kind === 'createRecordEffect' ||
                  effect?.kind === 'updateRecordEffect') &&
                (effect.entity as Json | undefined)?.targetId === entityId
                ? [String(operation.operationId)]
                : [];
            },
          );
          if (!operationIds.length) return [];
          const fields = definition.fields.flatMap((field) => {
            if (
              (field.entity as Json | undefined)?.targetId !== entityId ||
              field.lifecycle !== 'active' ||
              (field.classification !== 'public' &&
                field.classification !== 'internal')
            )
              return [];
            const valueType = formulaFieldType(
              field as Parameters<typeof formulaFieldType>[0],
            );
            return valueType
              ? [
                  {
                    fieldId: String(field.fieldId),
                    label: String(field.label),
                    valueType,
                  },
                ]
              : [];
          });
          const relatedFields = (definition.relations ?? []).flatMap(
            (relation) => {
              if (
                (relation.sourceEntity as Json | undefined)?.targetId !==
                entityId
              )
                return [];
              const relationId = String(relation.relationId);
              const targetId = (relation.targetEntity as Json | undefined)
                ?.targetId;
              return definition.fields.flatMap((field) => {
                if ((field.entity as Json | undefined)?.targetId !== targetId)
                  return [];
                const path = resolveValidationPath(
                  {
                    schemaVersion: VALIDATION_NODE_VERSION,
                    kind: 'path',
                    relationIds: [relationId],
                    fieldId: String(field.fieldId),
                  },
                  entityId,
                  definition as unknown as Parameters<
                    typeof resolveValidationPath
                  >[2],
                );
                const valueType = path && formulaFieldType(path.field);
                if (!path || !valueType) return [];
                const relationLabel = (
                  relationId.split(':relation.')[1] ?? relationId
                ).replaceAll('_', ' ');
                return [
                  {
                    relationId,
                    fieldId: path.field.fieldId,
                    label: `${entityLabel.get(String(targetId)) ?? relationLabel} · ${path.field.label} (${relationLabel})`,
                    valueType,
                  },
                ];
              });
            },
          );
          return fields.length
            ? [
                {
                  entityId,
                  label,
                  operationIds,
                  fields,
                  ...(relatedFields.length ? { relatedFields } : {}),
                },
              ]
            : [];
        })
      : [];
  const calculatedDisplayTargets: CalculatedDisplayTarget[] = [];
  if (definition.languageVersion === 'v6') {
    const surfaces = definition.surfaces.flatMap((surface) => {
      const kind = surface.surfaceRole;
      const columns =
        kind === 'list'
          ? (surface.list as Json | undefined)?.columns
          : (surface.composition as Json | undefined)?.fields;
      if (
        (kind !== 'list' && kind !== 'record') ||
        !Array.isArray(columns) ||
        surface.lifecycle !== 'active'
      )
        return [];
      const surfaceId = String(surface.surfaceId);
      const used = (definition.calculatedDisplayFields ?? []).filter(
        ({ displaySinks }) =>
          displaySinks.some((sink) => sink.surfaceId === surfaceId),
      ).length;
      if (
        columns.length + used >= (kind === 'list' ? 16 : 48) ||
        columns.some(({ orderKey }) => Number(orderKey) + used >= 1_000_000)
      )
        return [];
      const query = definition.queries.find(
        (query) =>
          query.lifecycle === 'active' &&
          query.queryId ===
            (surface.dataSource as Json | undefined)?.targetId &&
          !query.readModel &&
          query.tier === 'q0' &&
          query.queryType === (kind === 'record' ? 'get' : 'list'),
      );
      if (!query) return [];
      const fields = (
        query.selections as readonly { field: { targetId: string } }[]
      ).map(({ field }) => field.targetId);
      return [
        {
          kind,
          surfaceId,
          label: String(surface.label),
          entityId: String((query.sourceEntity as Json).targetId),
          fields,
        },
      ];
    });
    for (const record of surfaces.filter(({ kind }) => kind === 'record')) {
      const fields = definition.fields.flatMap((field) => {
        if (
          !record.fields.includes(String(field.fieldId)) ||
          field.lifecycle !== 'active'
        )
          return [];
        const valueType = displayTypeForField(
          field as Parameters<typeof displayTypeForField>[0],
        );
        return valueType
          ? [
              {
                fieldId: String(field.fieldId),
                label: String(field.label),
                valueType,
              },
            ]
          : [];
      });
      if (fields.length)
        calculatedDisplayTargets.push({
          entityId: record.entityId,
          label: record.label,
          recordSurfaceId: record.surfaceId,
          fields,
          lists: surfaces.filter(
            ({ kind, entityId, fields: listFields }) =>
              kind === 'list' &&
              entityId === record.entityId &&
              fields.some(({ fieldId }) => listFields.includes(fieldId)),
          ),
        });
    }
  }
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
  const linkTargets = definition.entities
    .flatMap((entity) => {
      const entityId = String(entity.entityId);
      const target = linkTarget(definition, entityId);
      return target
        ? [
            {
              entityId,
              label: String(entity.label),
              companyOwned: target.companyOwned,
            },
          ]
        : [];
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
    ...(validationTargets.length ? { validationTargets } : {}),
    ...(calculatedDisplayTargets.length ? { calculatedDisplayTargets } : {}),
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
    linkTargets,
    lists,
    recordTypes,
    ...(documentTargets.length > 0 ? { documentTargets } : {}),
    ...(documentTemplateTargets.length > 0 ? { documentTemplateTargets } : {}),
    ...(metricLists.length ? { metricLists } : {}),
  });
}
