import type {
  SurfaceComposition,
  SurfaceList,
  VersionedNormalizedApplicationPackage,
} from './schemas.js';
import {
  CanonicalModelError,
  compareCodeUnits,
  diagnostic,
} from './diagnostics.js';

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
  const relations = new Map(
    model.relations.map((relation) => [String(relation.relationId), relation]),
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
    const progressOutputs = new Set(
      list.progress
        ? [
            ...Object.values(list.progress.outputs),
            ...(list.progress.additionalDone
              ? [list.progress.additionalDone.output]
              : []),
          ]
        : [],
    );
    // A read model's figures, such as an order's total, are computed from the
    // page the list statement returned, so they exist only after paging.
    const readModelOutputs = new Set<string>(
      'readModel' in query && query.readModel
        ? Object.values(query.readModel.resultFields)
        : [],
    );
    for (const column of list.columns) {
      if (progressOutputs.has(column.field)) {
        // A progress figure exists only in the list statement's answer: it is
        // shown as it is, and never sorted, labelled or formatted like a field.
        if (
          column.sortable ||
          column.role !== 'value' ||
          column.format ||
          column.reference ||
          column.statusRoles ||
          column.overdue
        )
          fail(column.columnId, 'a progress column is an unsorted plain value');
        continue;
      }
      if (readModelOutputs.has(column.field)) {
        // Shown -- as money when declared -- and never sorted, filtered,
        // searched or counted: nothing before the page can read it. A view,
        // filter or sort naming it is refused below as an unselected field.
        if (
          column.sortable ||
          column.role !== 'value' ||
          (column.format !== undefined && column.format !== 'money') ||
          column.reference ||
          column.statusRoles ||
          column.overdue
        )
          fail(
            column.columnId,
            'a read-model column is an unsorted value, plain or money',
          );
        continue;
      }
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
      if (view.open && !list.progress)
        fail(view.viewId, "an open view needs the List's declared progress");
      if (view.before) {
        // Compared in SQL against an instant: a calendar date or a UTC
        // instant, never a text-stored offset time.
        const compared = fields.get(view.before.field)?.fieldType;
        if (
          !selected.has(view.before.field) ||
          !(
            compared?.kind === 'dateFieldType' ||
            (compared?.kind === 'dateTimeFieldType' &&
              compared.timezoneSemantics === 'utcInstant')
          )
        )
          fail(
            view.viewId,
            'a before view compares a selected date or UTC instant field',
          );
      }
    }
    for (const column of list.columns) {
      if (!column.overdue) continue;
      // One declaration drives both the tab and the marker: the named view
      // keeps rows before today on the very date this column shows.
      const marked = list.views.find(
        (view) => view.viewId === column.overdue?.view,
      );
      if (column.format !== 'date' || marked?.before?.field !== column.field)
        fail(
          column.columnId,
          'an overdue marker names a view that keeps rows before today on its own date',
        );
    }
    if (list.progress) {
      const progress = list.progress;
      const source = (entry: typeof progress.lines) => {
        const summed = queries.get(entry.query.targetId);
        if (
          !summed ||
          summed.queryType !== 'list' ||
          summed.lifecycle !== 'active' ||
          summed.tier !== 'q0'
        )
          return fail(id, 'list progress reads an active q0 list query');
        if (
          !summed.selections.some(
            (selection) => selection.field.targetId === entry.quantity,
          ) ||
          fields.get(entry.quantity)?.fieldType.kind !== 'exactDecimalFieldType'
        )
          fail(id, 'list progress sums an exact decimal its query selects');
        // The executor joins these rows within the List's own companies, so a
        // company-scoped read needs a company-scoped List to be issued under.
        if (
          'legalEntityScope' in summed &&
          summed.legalEntityScope &&
          !('legalEntityScope' in query && query.legalEntityScope)
        )
          fail(
            id,
            'list progress reads company rows only under a company List',
          );
        return summed;
      };
      const lines = source(progress.lines);
      const done = source(progress.done);
      const toLines = relations.get(progress.lines.relation);
      if (
        !toLines ||
        toLines.lifecycle !== 'active' ||
        toLines.ownership !== 'parentScopedChild' ||
        toLines.sourceEntity.targetId !== lines.sourceEntity.targetId ||
        toLines.targetEntity.targetId !== query.sourceEntity.targetId
      )
        fail(
          id,
          "list progress lines are the List's children through a parentScopedChild relation",
        );
      const toDone = relations.get(progress.done.relation);
      if (
        !toDone ||
        toDone.lifecycle !== 'active' ||
        toDone.sourceEntity.targetId !== done.sourceEntity.targetId ||
        toDone.targetEntity.targetId !== lines.sourceEntity.targetId
      )
        fail(
          id,
          'list progress done rows point at its lines through a relation',
        );
      if (progress.additionalDone) {
        const additional = source(progress.additionalDone);
        const link = relations.get(progress.additionalDone.relation);
        if (
          !link ||
          link.lifecycle !== 'active' ||
          link.sourceEntity.targetId !== additional.sourceEntity.targetId ||
          link.targetEntity.targetId !== lines.sourceEntity.targetId
        )
          fail(id, 'additional progress facts point at the same lines');
        unique(
          progress.additionalDone.filters.map((filter) => filter.field),
          id,
          'additional progress filters',
        );
        for (const filter of progress.additionalDone.filters) {
          const field = fields.get(filter.field);
          if (
            !field ||
            field.entity.targetId !== additional.sourceEntity.targetId ||
            !additional.selections.some(
              (selection) => selection.field.targetId === filter.field,
            ) ||
            !['enumFieldType', 'textFieldType', 'booleanFieldType'].includes(
              field.fieldType.kind,
            )
          )
            fail(
              id,
              'additional progress filters name selected scalar fields of their query',
            );
        }
      }
      unique(
        [
          ...Object.values(progress.outputs),
          ...(progress.additionalDone ? [progress.additionalDone.output] : []),
        ],
        id,
        'progress outputs',
      );
      if (
        [...progressOutputs].some(
          (output) => fields.has(output) || columns.has(output),
        )
      )
        fail(id, 'list progress outputs name no field or column');
      // A read model writes its figures into the same row values, after the
      // statement: one of them would silently replace a summed figure.
      if ([...progressOutputs].some((output) => readModelOutputs.has(output)))
        fail(id, 'list progress outputs name no read-model figure');
      if (progress.openIn) {
        unique(progress.openIn.values, id, 'progress open values');
        for (const value of progress.openIn.values)
          filterable(progress.openIn.field, value, id);
      }
      // Omitted figures serve every view that does not keep open rows; a List
      // whose every view keeps them would serve nothing at all.
      if (
        progress.whenDenied === 'omit' &&
        list.views.length > 0 &&
        list.views.every((view) => view.open)
      )
        fail(
          id,
          'a List that omits denied progress keeps a view that does not need it',
        );
    }
    if (list.rowActions) {
      unique(
        list.rowActions.map((action) => action.actionId),
        id,
        'row action ids',
      );
      // The page a row links to: the record surfaces over the List's records.
      // A section is a dataset of every one of them, so the link lands where
      // it says whichever page the runtime opens.
      const records = model.surfaces.filter(
        (candidate) =>
          candidate.surfaceRole === 'record' &&
          candidate.lifecycle === 'active' &&
          queries.get(String(candidate.dataSource.targetId))?.sourceEntity
            .targetId === query.sourceEntity.targetId,
      );
      if (records.length === 0)
        fail(id, "list row actions link to the record page of the List's rows");
      const ordered = [...list.rowActions].sort(
        (left, right) =>
          left.orderKey - right.orderKey ||
          compareCodeUnits(left.actionId, right.actionId),
      );
      for (const [index, action] of ordered.entries()) {
        if (!action.when) {
          // The first action whose condition holds is the row's: nothing
          // after an unconditional one could ever be shown.
          if (index < ordered.length - 1)
            fail(
              action.actionId,
              'an unconditional row action is the last one',
            );
        } else {
          const filters = action.when.filters ?? [];
          if (filters.length === 0 && !action.when.open)
            fail(
              action.actionId,
              'a row action condition names a filter or open',
            );
          unique(
            filters.map((filter) => filter.field),
            action.actionId,
            'row action filter fields',
          );
          for (const filter of filters)
            filterable(filter.field, filter.value, action.actionId);
          if (action.when.open && !list.progress)
            fail(
              action.actionId,
              "a row action's open condition needs the List's declared progress",
            );
        }
        if (
          action.section !== undefined &&
          !records.every((record) =>
            (
              ('composition' in record ? record.composition : undefined) as
                SurfaceComposition | undefined
            )?.children.some((child) => child.datasetId === action.section),
          )
        )
          fail(
            action.actionId,
            "a row action's section is a dataset of the List's record page",
          );
      }
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
