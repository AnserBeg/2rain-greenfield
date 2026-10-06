import type {
  SurfaceComposition,
  SurfaceList,
  SurfaceListFigures,
  SurfaceListSupply,
  VersionedNormalizedApplicationPackage,
} from './schemas.js';
import {
  CanonicalModelError,
  compareCodeUnits,
  diagnostic,
} from './diagnostics.js';
import {
  pickerEligibilityProblem,
  searchChildProblem,
} from './picker-eligibility.js';

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
    const columns = new Map<string, SurfaceList['columns'][number]>(
      list.columns.map((column) => [column.columnId, column]),
    );
    // The supply's figures are progress figures too: computed by the same
    // statement, shown as they are and never sorted (SUPPLY-WARNINGS).
    const progressOutputs = new Set<string>(
      list.progress
        ? [
            ...Object.values(list.progress.outputs),
            ...Object.values(list.progress.supply?.outputs ?? {}),
          ]
        : [],
    );
    // Figures computed by the list statement, by id: sums and totals are
    // exact decimals, a band names a range by value, a latest is a record id.
    const figureKinds = new Map<string, 'band' | 'latest' | 'number'>([
      ...(list.figures?.sums ?? []).map(
        (sum) => [sum.figureId, 'number'] as const,
      ),
      ...(list.figures?.choices ?? []).map(
        (choice) => [choice.figureId, 'number'] as const,
      ),
      ...(list.figures?.totals ?? []).map(
        (total) => [total.figureId, 'number'] as const,
      ),
      ...(list.figures?.bands ?? []).map(
        (band) => [band.figureId, 'band'] as const,
      ),
      ...(list.figures?.latest ?? []).map(
        (latest) => [latest.figureId, 'latest'] as const,
      ),
    ]);
    const bandValues = new Map<string, ReadonlySet<string>>(
      (list.figures?.bands ?? []).map((band) => [
        band.figureId,
        new Set([
          ...band.cases.map((entry) => entry.value),
          band.otherwise.value,
        ]),
      ]),
    );
    // A read model's figures, such as an order's total, are computed from the
    // page the list statement returned, so they exist only after paging.
    const readModelOutputs = new Set<string>(
      'readModel' in query && query.readModel
        ? Object.values(query.readModel.resultFields)
        : [],
    );
    for (const column of list.columns) {
      const figure = figureKinds.get(column.field);
      if (figure) {
        // Computed in the statement: shown as it is, never sorted, formatted
        // or labelled like a field -- but a number figure may read as money
        // (REPORTS-HOME). A band reads as its row's status.
        if (
          column.sortable ||
          (column.format !== undefined &&
            !(figure === 'number' && column.format === 'money')) ||
          column.reference ||
          column.overdue ||
          (figure === 'band'
            ? column.role !== 'status' ||
              !(column.statusRoles ?? []).every((entry) =>
                bandValues.get(column.field)?.has(entry.value),
              )
            : column.role !== 'value' || column.statusRoles)
        )
          fail(
            column.columnId,
            'a figure column is an unsorted value and a band column its status',
          );
        if (column.statusRoles)
          unique(
            column.statusRoles.map((entry) => entry.value),
            column.columnId,
            'status role values',
          );
        continue;
      }
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
      if (view.supply && !list.progress?.supply)
        fail(view.viewId, "a supply view needs the List's declared supply");
      if (view.band) {
        const values = bandValues.get(view.band.figure);
        unique(view.band.values, view.viewId, 'view band values');
        if (!values || !view.band.values.every((value) => values.has(value)))
          fail(
            view.viewId,
            "a view keeps values of one of the List's band figures",
          );
      }
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
    // What the progress supply and the figures join by compiled identity: list
    // queries the gateway authorizes per request, fields they select, and the
    // relations between their entities.
    const selects = (
      source: { selections: readonly { field: { targetId: string } }[] },
      fieldId: string,
    ) =>
      source.selections.some(
        (selection) => String(selection.field.targetId) === fieldId,
      );
    const read = (targetId: string, subject = 'list figures read') => {
      const source = queries.get(targetId);
      if (
        !source ||
        source.queryType !== 'list' ||
        source.lifecycle !== 'active' ||
        source.tier !== 'q0' ||
        ('readModel' in source && source.readModel)
      )
        return fail(
          id,
          `${subject} active q0 list queries without a read model`,
        );
      // The executor reads these rows within the List's own companies, so a
      // company-scoped read needs a company-scoped List to be issued under.
      if (
        'legalEntityScope' in source &&
        source.legalEntityScope &&
        !('legalEntityScope' in query && query.legalEntityScope)
      )
        fail(id, `${subject} company rows only under a company List`);
      return source;
    };
    const decimal = (
      source: { selections: readonly { field: { targetId: string } }[] },
      fieldId: string,
      what = 'a figure sums',
    ) => {
      if (
        !selects(source, fieldId) ||
        fields.get(fieldId)?.fieldType.kind !== 'exactDecimalFieldType'
      )
        fail(id, `${what} an exact decimal its query selects`);
    };
    const parentOf = (
      rows: ReturnType<typeof read>,
      within: NonNullable<SurfaceListFigures['sums'][number]['within']>,
      subject?: string,
    ) => {
      const parent = read(within.query.targetId, subject);
      if ('relation' in within) {
        const relation = relations.get(within.relation);
        if (
          !relation ||
          relation.lifecycle !== 'active' ||
          relation.sourceEntity.targetId !== rows.sourceEntity.targetId ||
          relation.targetEntity.targetId !== parent.sourceEntity.targetId
        )
          fail(id, "a figure's parent is its rows' parent through a relation");
      } else {
        // The record whose id the rows hold as text, as a stock balance
        // holds its location: a record id is 36 characters.
        const reference = fields.get(within.reference);
        if (
          !selects(rows, within.reference) ||
          reference?.entity.targetId !== rows.sourceEntity.targetId ||
          reference.fieldType.kind !== 'textFieldType' ||
          reference.fieldType.maximumLength < 36
        )
          fail(
            id,
            "a figure's parent is the record whose id its rows hold in a text field their query selects",
          );
      }
      unique(within.values, id, 'figure parent values');
      const state = fields.get(within.field);
      if (
        !selects(parent, within.field) ||
        (state?.fieldType.kind === 'enumFieldType' &&
          !within.values.every((value) =>
            state.fieldType.kind === 'enumFieldType'
              ? state.fieldType.options.some(
                  (option) => option.optionId === value,
                )
              : false,
          ))
      )
        fail(
          id,
          "a figure's parent values are values of a field its parent query selects",
        );
      return parent;
    };
    // The supply (SUPPLY-WARNINGS) joins the progress lines to what covers
    // them and to their item's free stock, by compiled identity only: list
    // queries the gateway authorizes per request, the fields they select and
    // the relations between their entities. Anything else is refused here.
    const validateSupply = (
      supply: SurfaceListSupply,
      lines: ReturnType<typeof read>,
    ) => {
      const reads = (targetId: string) => read(targetId, 'list supply reads');
      const covering = reads(supply.coverage.query.targetId);
      const toLine = relations.get(supply.coverage.relation);
      if (
        !toLine ||
        toLine.lifecycle !== 'active' ||
        toLine.sourceEntity.targetId !== covering.sourceEntity.targetId ||
        toLine.targetEntity.targetId !== lines.sourceEntity.targetId
      )
        fail(
          id,
          "list supply coverage rows point at the List's lines through a relation",
        );
      const holding = reads(supply.coverage.related.query.targetId);
      const toCovering = relations.get(supply.coverage.related.relation);
      if (
        !toCovering ||
        toCovering.lifecycle !== 'active' ||
        toCovering.sourceEntity.targetId !== holding.sourceEntity.targetId ||
        toCovering.targetEntity.targetId !== covering.sourceEntity.targetId
      )
        fail(
          id,
          'list supply coverage holds what related rows pointing at it hold',
        );
      decimal(holding, supply.coverage.related.quantity, 'list supply adds');
      // A line names what it asks for by its record id: 36 characters.
      const item = fields.get(supply.item);
      if (
        !selects(lines, supply.item) ||
        item?.entity.targetId !== lines.sourceEntity.targetId ||
        item.fieldType.kind !== 'textFieldType' ||
        item.fieldType.maximumLength < 36
      )
        fail(
          id,
          "list supply names a line's item by a text field the lines' query selects",
        );
      for (const sum of [...supply.free.plus, ...supply.free.minus]) {
        const rows = reads(sum.rows.query.targetId);
        const match = fields.get(sum.rows.match);
        if (
          !selects(rows, sum.rows.match) ||
          match?.entity.targetId !== rows.sourceEntity.targetId ||
          match.fieldType.kind !== 'textFieldType' ||
          match.fieldType.maximumLength < 36
        )
          fail(
            id,
            "a supply sum's rows hold the item's id in a text field their query selects",
          );
        // `rows` adds a quantity, `related` related rows, `remaining` both.
        if (
          (sum.rows.quantity !== undefined) !== (sum.sum !== 'related') ||
          (sum.related !== undefined) !== (sum.sum !== 'rows')
        )
          fail(id, 'a supply sum names exactly the parts it adds up');
        if (sum.rows.quantity !== undefined)
          decimal(rows, sum.rows.quantity, 'list supply adds');
        if (sum.within) parentOf(rows, sum.within, 'list supply reads');
        if (sum.related) {
          const pointing = reads(sum.related.query.targetId);
          const relation = relations.get(sum.related.relation);
          if (
            !relation ||
            relation.lifecycle !== 'active' ||
            relation.sourceEntity.targetId !== pointing.sourceEntity.targetId ||
            relation.targetEntity.targetId !== rows.sourceEntity.targetId
          )
            fail(
              id,
              "a supply sum's related rows point at its rows through a relation",
            );
          decimal(pointing, sum.related.quantity, 'list supply adds');
        }
      }
      if (supply.shortIn) {
        unique(supply.shortIn.values, id, 'supply short values');
        for (const value of supply.shortIn.values)
          filterable(supply.shortIn.field, value, id);
      }
      // Omitted supply serves every view that keeps neither covered nor short
      // rows; a List whose every view keeps them would serve nothing at all.
      if (
        supply.whenDenied === 'omit' &&
        list.views.length > 0 &&
        list.views.every((view) => view.supply)
      )
        fail(
          id,
          'a List that omits denied supply keeps a view that does not need it',
        );
    };
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
      unique(
        [
          ...Object.values(progress.outputs),
          ...Object.values(progress.supply?.outputs ?? {}),
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
      if (progress.supply) validateSupply(progress.supply, lines);
    }
    // Every figure names what the statement joins by compiled identity: list
    // queries the gateway authorizes per request, fields they select, and the
    // relations between their entities. Anything else is refused here.
    const validateFigures = (figures: SurfaceListFigures) => {
      if (list.progress)
        fail(id, 'a List declares progress or figures, not both');
      const declared = [...figureKinds.keys()];
      unique(
        [
          ...figures.sums.map((entry) => entry.figureId),
          ...(figures.choices ?? []).map((entry) => entry.figureId),
          ...(figures.totals ?? []).map((entry) => entry.figureId),
          ...(figures.bands ?? []).map((entry) => entry.figureId),
          ...(figures.latest ?? []).map((entry) => entry.figureId),
        ],
        id,
        'figure ids',
      );
      if (
        declared.some(
          (figure) =>
            fields.has(figure) ||
            columns.has(figure) ||
            readModelOutputs.has(figure) ||
            progressOutputs.has(figure),
        )
      )
        fail(id, 'list figures name no field, column or other output');
      const matched = (rows: {
        query: { targetId: string };
        match: string;
      }) => {
        const source = read(rows.query.targetId);
        const match = fields.get(rows.match);
        // A record id is 36 characters; a shorter field could not hold one.
        if (
          !selects(source, rows.match) ||
          match?.entity.targetId !== source.sourceEntity.targetId ||
          match.fieldType.kind !== 'textFieldType' ||
          match.fieldType.maximumLength < 36
        )
          fail(
            id,
            "a figure's rows hold the listed record's id in a text field their query selects",
          );
        return source;
      };
      const numbers = new Set<string>();
      // A text field holding a record id: 36 characters at least.
      const recordIdField = (
        source: ReturnType<typeof read>,
        fieldId: string,
      ) => {
        const field = fields.get(fieldId);
        return (
          selects(source, fieldId) &&
          field?.entity.targetId === source.sourceEntity.targetId &&
          field.fieldType.kind === 'textFieldType' &&
          field.fieldType.maximumLength >= 36
        );
      };
      for (const sum of figures.sums) {
        // REPORTS-HOME: the rows hold the listed record's id, or their parent
        // does (`within.match`) -- exactly one of them.
        const parentMatch =
          sum.within && 'match' in sum.within ? sum.within.match : undefined;
        if ((sum.rows.match === undefined) === (parentMatch === undefined))
          fail(
            id,
            "a figure's rows or their parent hold the listed record's id, exactly one",
          );
        const rows =
          sum.rows.match !== undefined
            ? matched({ query: sum.rows.query, match: sum.rows.match })
            : read(sum.rows.query.targetId);
        // `rows` adds a quantity, `related` related rows, `remaining` both,
        // `count` nothing but how many rows there are.
        const quantity = sum.sum === 'rows' || sum.sum === 'remaining';
        const related = sum.sum === 'related' || sum.sum === 'remaining';
        if (
          (sum.rows.quantity !== undefined) !== quantity ||
          (sum.related !== undefined) !== related
        )
          fail(id, 'a figure names exactly the parts its sum adds up');
        if (sum.rows.quantity !== undefined) decimal(rows, sum.rows.quantity);
        const parent = sum.within ? parentOf(rows, sum.within) : undefined;
        if (parentMatch !== undefined && !recordIdField(parent!, parentMatch))
          fail(
            id,
            "a figure's parent holds the listed record's id in a text field its query selects",
          );
        if (sum.where) {
          unique(sum.where.values, id, 'figure where values');
          const kept = fields.get(sum.where.field)?.fieldType;
          if (
            !selects(rows, sum.where.field) ||
            fields.get(sum.where.field)?.entity.targetId !==
              rows.sourceEntity.targetId ||
            !(kept?.kind === 'enumFieldType'
              ? sum.where.values.every((value) =>
                  kept.options.some((option) => option.optionId === value),
                )
              : kept?.kind === 'textFieldType' &&
                sum.where.values.every(
                  (value) => value.length <= kept.maximumLength,
                ))
          )
            fail(
              id,
              "a figure keeps rows by values of an enumeration or text field its rows' query selects",
            );
        }
        if (sum.age) {
          const dated = fields.get(sum.age.field)?.fieldType;
          if (
            !selects(rows, sum.age.field) ||
            fields.get(sum.age.field)?.entity.targetId !==
              rows.sourceEntity.targetId ||
            !(
              dated?.kind === 'dateFieldType' ||
              (dated?.kind === 'dateTimeFieldType' &&
                dated.timezoneSemantics === 'utcInstant')
            )
          )
            fail(
              id,
              "a figure's age reads a date or UTC instant its rows' query selects",
            );
          if (
            (sum.age.from === undefined && sum.age.to === undefined) ||
            (sum.age.from !== undefined &&
              sum.age.to !== undefined &&
              sum.age.from > sum.age.to)
          )
            fail(id, "a figure's age names a range of days, from before to");
        }
        if (sum.currency !== undefined) {
          const currency = sum.currency;
          if (!figures.currency)
            fail(id, 'a currency figure needs the List to declare currencies');
          // The rows' own currency, or -- matched through it -- their
          // parent's, as an order line is in its order's currency.
          const holder = [rows, ...(parent ? [parent] : [])].find(
            (source) =>
              fields.get(currency)?.entity.targetId ===
              source.sourceEntity.targetId,
          );
          if (
            !holder ||
            !selects(holder, currency) ||
            fields.get(currency)?.fieldType.kind !== 'textFieldType'
          )
            fail(
              id,
              "a figure's currency is a text field its rows' or their parent's query selects",
            );
        }
        if (sum.price) {
          if (sum.sum !== 'rows' && sum.sum !== 'remaining')
            fail(id, 'a priced figure adds its rows or what remains of them');
          decimal(rows, sum.price.field, 'a figure prices with');
          if (sum.price.discount !== undefined)
            decimal(rows, sum.price.discount, 'a figure discounts by');
        }
        if (sum.related) {
          const pointing = read(sum.related.query.targetId);
          const relation = relations.get(sum.related.relation);
          if (
            !relation ||
            relation.lifecycle !== 'active' ||
            relation.sourceEntity.targetId !== pointing.sourceEntity.targetId ||
            relation.targetEntity.targetId !== rows.sourceEntity.targetId
          )
            fail(
              id,
              "a figure's related rows point at its rows through a relation",
            );
          decimal(pointing, sum.related.quantity);
        }
        numbers.add(sum.figureId);
      }
      const listedDecimal = (fieldId: string) =>
        selected.has(fieldId) &&
        fields.get(fieldId)?.fieldType.kind === 'exactDecimalFieldType';
      // An enumeration of the listed row's own, and options of it.
      const listedOptions = (
        fieldId: string,
        values: readonly string[],
        what: string,
      ) => {
        const type = fields.get(fieldId)?.fieldType;
        unique(values, id, `${what} values`);
        if (
          !selected.has(fieldId) ||
          type?.kind !== 'enumFieldType' ||
          !values.every((value) =>
            type.options.some((option) => option.optionId === value),
          )
        )
          fail(
            id,
            `a ${what} names options of an enumeration the List selects`,
          );
      };
      // CATALOG-EXTRAS: per row, the first case holding the row's own value
      // of an enumeration, else the otherwise; a missing value leaves the
      // figure unstated. A percentage reads the List's one company -- the
      // legal entity it is read in -- through an unscoped list of companies;
      // the executor holds that list to the legal-entity master.
      for (const choice of figures.choices ?? []) {
        listedOptions(
          choice.by,
          choice.cases.flatMap((entry) => entry.values),
          'choice',
        );
        const taken = (
          value: NonNullable<
            SurfaceListFigures['choices']
          >[number]['otherwise'],
        ) => {
          if (!value) return;
          const operand = 'percent' in value ? value.percent.of : value;
          if (
            'figure' in operand
              ? !numbers.has(operand.figure)
              : !listedDecimal(operand.field)
          )
            fail(
              id,
              'a choice takes figures declared before it or exact decimals the List selects',
            );
          if (!('percent' in value)) return;
          const company = queries.get(value.percent.company.query.targetId);
          if (!('legalEntityScope' in query && query.legalEntityScope))
            fail(
              id,
              "a company's percentage is read only under a company List",
            );
          if (
            !company ||
            company.queryType !== 'list' ||
            company.lifecycle !== 'active' ||
            company.tier !== 'q0' ||
            ('legalEntityScope' in company && company.legalEntityScope) ||
            ('readModel' in company && company.readModel) ||
            !selects(company, value.percent.company.field) ||
            fields.get(value.percent.company.field)?.fieldType.kind !==
              'exactDecimalFieldType'
          )
            fail(
              id,
              "a company's percentage is an exact decimal of an active unscoped q0 list query",
            );
        };
        for (const entry of choice.cases) taken(entry.value);
        taken(choice.otherwise);
        numbers.add(choice.figureId);
      }
      for (const total of figures.totals ?? []) {
        for (const operand of [...total.plus, ...total.minus])
          if (
            'figure' in operand
              ? !numbers.has(operand.figure)
              : !listedDecimal(operand.field)
          )
            fail(
              id,
              'a total adds figures declared before it or exact decimals the List selects',
            );
        numbers.add(total.figureId);
      }
      for (const band of figures.bands ?? []) {
        if (!numbers.has(band.of))
          fail(id, 'a band names the range of a sum or a total');
        for (const entry of band.cases) {
          const threshold = entry.below ?? entry.atMost;
          // Exactly one test: a comparison, or the row's own enumeration.
          if (
            [entry.below, entry.atMost, entry.when].filter(
              (value) => value !== undefined,
            ).length !== 1 ||
            (threshold &&
              'field' in threshold &&
              !listedDecimal(threshold.field))
          )
            fail(
              id,
              'a band case compares with one fixed decimal or exact decimal the List selects',
            );
          if (
            threshold &&
            'figure' in threshold &&
            !numbers.has(threshold.figure)
          )
            fail(id, 'a band case compares with a figure declared before it');
          if (entry.when)
            listedOptions(entry.when.field, entry.when.values, 'band case');
        }
        unique(
          [...band.cases.map((entry) => entry.value), band.otherwise.value],
          id,
          'band values',
        );
      }
      for (const latest of figures.latest ?? []) {
        const rows = matched(latest.rows);
        const parent = parentOf(rows, latest.within);
        const by = fields.get(latest.by)?.fieldType;
        if (
          !selects(parent, latest.by) ||
          !(
            by?.kind === 'dateFieldType' ||
            (by?.kind === 'dateTimeFieldType' &&
              by.timezoneSemantics === 'utcInstant')
          ) ||
          !selects(parent, latest.value) ||
          fields.get(latest.value)?.fieldType.kind !== 'textFieldType'
        )
          fail(
            id,
            'a latest figure orders its parents by a date and reads a record id their query selects',
          );
        // Joined on the record id alone, with no company, as a label is.
        const label = queries.get(latest.label.query.targetId);
        if (
          !label ||
          label.queryType !== 'list' ||
          label.lifecycle !== 'active' ||
          label.tier !== 'q0' ||
          ('legalEntityScope' in label && label.legalEntityScope) ||
          !selects(label, latest.label.field)
        )
          fail(
            id,
            'a latest label reads a selected field of an active unscoped q0 list query',
          );
      }
      // REPORTS-HOME: the currencies a List's currency sums are read in, one
      // at a time, and only where some sum is read in one.
      if (figures.currency) {
        unique(
          figures.currency.options.map((option) => option.value),
          id,
          'currency values',
        );
        if (!figures.sums.some((sum) => sum.currency !== undefined))
          fail(id, 'a List declares currencies for its currency figures');
      }
      // A report's totals: number figures added up over the whole filtered
      // set, each once.
      if (figures.summary) {
        unique(figures.summary, id, 'summary figures');
        if (!figures.summary.every((figure) => numbers.has(figure)))
          fail(id, "a List's summary adds up its sums, choices and totals");
        // Each total reads under the label, and as the money, of the column
        // that shows the figure on every row.
        if (
          !figures.summary.every((figure) =>
            list.columns.some((column) => column.field === figure),
          )
        )
          fail(id, "a List's summary adds up figures its columns show");
      }
    };
    if (list.figures) validateFigures(list.figures);
    // REPORTS-HOME: only the rows a related entity points at, as a picker's
    // eligibility keeps them.
    if (list.eligibility) {
      const problem = pickerEligibilityProblem(
        model,
        list.eligibility,
        String(query.sourceEntity.targetId),
      );
      if (problem) fail(id, problem);
    }
    // REPORTS-HOME: the record page a List opens its rows in, when its
    // entity has another: an active record page over the List's entity.
    if (list.record !== undefined) {
      const page = model.surfaces.find(
        (candidate) => String(candidate.surfaceId) === list.record,
      );
      if (
        !page ||
        page.lifecycle !== 'active' ||
        page.surfaceRole !== 'record' ||
        queries.get(String(page.dataSource.targetId))?.sourceEntity.targetId !==
          query.sourceEntity.targetId
      )
        fail(id, "a List's record page is an active record page of its rows");
    }
    // CATALOG-EXTRAS: a search that also finds a row through its children,
    // each through its own relation once.
    if (list.searchChildren) {
      unique(
        list.searchChildren.map((child) => child.relation),
        id,
        'search children relations',
      );
      for (const child of list.searchChildren) {
        const problem = searchChildProblem(
          model,
          {
            queryId: child.query.targetId,
            relationId: child.relation,
            fieldId: child.field,
          },
          String(query.sourceEntity.targetId),
        );
        if (problem) fail(id, problem);
      }
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
      // A List that names its record page links there alone (REPORTS-HOME).
      const records = model.surfaces.filter(
        (candidate) =>
          candidate.surfaceRole === 'record' &&
          candidate.lifecycle === 'active' &&
          (list.record === undefined ||
            String(candidate.surfaceId) === list.record) &&
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
          if (
            filters.length === 0 &&
            !action.when.open &&
            action.when.supply === undefined
          )
            fail(
              action.actionId,
              'a row action condition names a filter, open or supply',
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
          if (action.when.supply && !list.progress?.supply)
            fail(
              action.actionId,
              "a row action's supply condition needs the List's declared supply",
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
