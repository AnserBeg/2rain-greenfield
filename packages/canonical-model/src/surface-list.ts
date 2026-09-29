import type {
  SurfaceList,
  VersionedNormalizedApplicationPackage,
} from './schemas.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';

/**
 * A declared List is cross-reference checked against the surface's own list
 * query. Every column, view, filter and sort names a field that query selects,
 * or a label read through another declared list query, so the runtime only ever
 * turns a declaration into gateway arguments it re-authorizes. Anything the
 * runtime could not honour is refused here rather than ignored later.
 */
export function validateSurfaceLists(
  model: VersionedNormalizedApplicationPackage,
): void {
  const queries = new Map(
    model.queries.map((query) => [String(query.queryId), query]),
  );
  const fields = new Map(
    model.fields.map((field) => [String(field.fieldId), field]),
  );
  const fail = (id: string, reason: string): never => {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_SCHEMA_INVALID',
        '$.surfaces.list',
        reason,
        'declare columns, views, filters and sorts over fields the list query selects',
        id,
      ),
    ]);
  };
  const unique = (values: readonly string[], id: string, what: string) => {
    if (new Set(values).size !== values.length)
      fail(id, `list ${what} must be unique`);
  };
  for (const query of model.queries)
    if (
      'exportMaximumResultCount' in query &&
      query.exportMaximumResultCount !== undefined &&
      query.queryType !== 'list'
    )
      fail(String(query.queryId), 'only a list query declares an export limit');
  for (const surface of model.surfaces) {
    if (!('list' in surface) || !surface.list) continue;
    const list: SurfaceList = surface.list;
    const id = String(surface.surfaceId);
    if (surface.archetype !== 'list' || surface.surfaceRole !== 'list')
      fail(id, 'a list declaration belongs to a List surface');
    const query = queries.get(String(surface.dataSource.targetId));
    if (!query || query.queryType !== 'list' || query.lifecycle !== 'active')
      return fail(id, 'a declared List reads an active list query');
    const selected = new Set(
      query.selections.map((selection) => String(selection.field.targetId)),
    );
    if (list.pageSize > query.maximumResultCount)
      fail(id, 'list page size exceeds the query maximum result count');
    const slots = new Set(surface.slots.map((slot) => slot.slot));
    if (list.views.length > 0 !== slots.has('savedViews'))
      fail(id, 'saved views and the savedViews slot are declared together');

    unique(
      list.columns.map((column) => column.columnId),
      id,
      'column ids',
    );
    if (list.columns.filter((column) => column.role === 'title').length !== 1)
      fail(id, 'a declared List has exactly one title column');
    const columns = new Map(
      list.columns.map((column) => [column.columnId, column]),
    );
    for (const column of list.columns) {
      if (!selected.has(column.field))
        fail(column.columnId, 'list columns read fields the query selects');
      if (
        column.format === 'date' &&
        !['dateFieldType', 'dateTimeFieldType'].includes(
          fields.get(column.field)?.fieldType.kind ?? '',
        )
      )
        fail(column.columnId, 'a date column reads a date or date-time field');
      if (
        column.format === 'money' &&
        fields.get(column.field)?.fieldType.kind !== 'exactDecimalFieldType'
      )
        fail(column.columnId, 'a money column reads an exact decimal field');
      if (column.format && column.reference)
        fail(column.columnId, 'a reference label is shown as its label');
      if (column.statusRoles && column.role !== 'status')
        fail(column.columnId, 'status roles belong to a status column');
      if (column.statusRoles)
        unique(
          column.statusRoles.map((entry) => entry.value),
          column.columnId,
          'status role values',
        );
      if (!column.reference) continue;
      if (column.role === 'status')
        fail(column.columnId, 'a status column reads its own stored value');
      const source = fields.get(column.field);
      if (!source || source.fieldType.kind !== 'textFieldType')
        fail(column.columnId, 'a reference label reads a text record id');
      const target = queries.get(column.reference.query.targetId);
      if (
        !target ||
        target.queryType !== 'list' ||
        target.lifecycle !== 'active' ||
        target.tier !== 'q0' ||
        ('legalEntityScope' in target && target.legalEntityScope) ||
        !target.selections.some(
          (selection) =>
            selection.field.targetId === column.reference?.labelField.targetId,
        )
      )
        fail(
          column.columnId,
          'a reference label reads a selected field of an active unscoped q0 list query',
        );
    }

    unique(
      list.defaultSort.map((sort) => sort.columnId),
      id,
      'default sort columns',
    );
    for (const sort of list.defaultSort)
      if (!columns.get(sort.columnId)?.sortable)
        fail(sort.columnId, 'default sort names a sortable column');

    const filterable = (field: string, value: string, subject: string) => {
      if (!selected.has(field))
        fail(subject, 'list views and filters read fields the query selects');
      if (
        list.columns.some(
          (column) => column.field === field && column.reference,
        )
      )
        fail(
          subject,
          'list views and filters compare stored values, not labels',
        );
      const declared = fields.get(field);
      if (
        declared?.fieldType.kind === 'enumFieldType' &&
        !declared.fieldType.options.some((option) => option.optionId === value)
      )
        fail(subject, 'an enumeration filter value is one of its options');
    };
    unique(
      list.views.map((view) => view.viewId),
      id,
      'view ids',
    );
    for (const view of list.views) {
      unique(
        view.filters.map((filter) => filter.field),
        view.viewId,
        'view filter fields',
      );
      for (const filter of view.filters)
        filterable(filter.field, filter.value, view.viewId);
    }
    // The gateway accepts at most four exact filters per request: the busiest
    // view's filters plus every declared filter must fit, or some would drop.
    if (
      Math.max(0, ...list.views.map((view) => view.filters.length)) +
        list.filters.length >
      4
    )
      fail(id, 'a view and the list filters together use at most four fields');
    const viewFields = new Set(
      list.views.flatMap((view) => view.filters.map((filter) => filter.field)),
    );
    unique(
      list.filters.map((filter) => filter.filterId),
      id,
      'filter ids',
    );
    unique(
      list.filters.map((filter) => filter.field),
      id,
      'filter fields',
    );
    for (const filter of list.filters) {
      if (viewFields.has(filter.field))
        fail(filter.filterId, 'a filter field is not also a view field');
      unique(
        filter.options.map((option) => option.value),
        filter.filterId,
        'filter option values',
      );
      for (const option of filter.options)
        filterable(filter.field, option.value, filter.filterId);
    }
    if (
      list.export &&
      !(
        'exportMaximumResultCount' in query &&
        query.exportMaximumResultCount !== undefined
      )
    )
      fail(id, 'a list export requires the query to declare its export limit');
  }
}
