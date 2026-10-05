import type {
  SurfaceComposition,
  VersionedNormalizedApplicationPackage,
} from './schemas.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';
import { pickerEligibilityProblem } from './picker-eligibility.js';

/** Closed, cross-reference checked composition. No expression or arbitrary property path executes. */
export function validateSurfaceCompositions(
  model: VersionedNormalizedApplicationPackage,
): void {
  const queries = new Map(
    model.queries.map((query) => [String(query.queryId), query]),
  );
  const operations = new Map(
    model.operations.map((operation) => [
      String(operation.operationId),
      operation,
    ]),
  );
  const surfaces = new Set(
    model.surfaces.map((surface) => String(surface.surfaceId)),
  );
  const fail = (id: string, reason: string): never => {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_SCHEMA_INVALID',
        '$.surfaces.composition',
        reason,
        'use declared fields, queries, operations and context bindings',
        id,
      ),
    ]);
  };
  const unique = (values: readonly string[], id: string) => {
    if (new Set(values).size !== values.length)
      fail(
        id,
        'composition identities must be unique in their local collection',
      );
  };
  const fieldsFor = (queryId: string): Set<string> => {
    const query = queries.get(queryId);
    if (!query || query.queryType === 'aggregate')
      return fail(queryId, 'composition requires a record query');
    return new Set([
      'recordId',
      'revision',
      ...query.selections.map((selection) => String(selection.field.targetId)),
      ...('readModel' in query && query.readModel
        ? Object.values(query.readModel.resultFields)
        : []),
    ]);
  };
  for (const query of model.queries)
    if ('readModel' in query && query.readModel) {
      const readModel = query.readModel;
      if (
        !model.capabilityRequirements.some(
          (capability) =>
            capability.capabilityId === readModel.capability.targetId &&
            capability.supportStatus === 'supported',
        )
      )
        fail(query.queryId, 'read model requires a supported capability');
      for (const dependency of Object.values(readModel.queries)) {
        const target = queries.get(dependency.targetId);
        if (
          dependency.kind !== 'queryReference' ||
          !target ||
          ('readModel' in target && target.readModel)
        )
          fail(
            query.queryId,
            'read-model dependencies must be declared base queries; recursive read models are unsupported',
          );
      }
      unique(
        [
          ...query.selections.map((selection) =>
            String(selection.field.targetId),
          ),
          ...Object.values(readModel.resultFields),
        ],
        query.queryId,
      );
      if (readModel.capability.kind !== 'capabilityReference')
        fail(query.queryId, 'read model requires a capability reference');
    }
  for (const surface of model.surfaces) {
    if (!('composition' in surface) || !surface.composition) continue;
    const composition = surface.composition;
    if (surface.archetype !== 'record' || surface.surfaceRole !== 'record')
      fail(surface.surfaceId, 'composition is supported on record surfaces');
    if (
      !surface.slots.some((slot) => slot.slot === 'sections') ||
      !surface.slots.some((slot) => slot.slot === 'childTables')
    )
      fail(
        surface.surfaceId,
        'composition declares sections and childTables slots',
      );
    unique(
      composition.children.map((child) => child.datasetId),
      surface.surfaceId,
    );
    unique(
      composition.actions.map((action) => action.actionId),
      surface.surfaceId,
    );
    const children = new Map(
      composition.children.map((child) => [String(child.datasetId), child]),
    );
    // A record's own reference to another record (an invoice's sales order)
    // is stated by its record query when the page names the relation: the
    // stored target id, never a label. Only the record's get states one.
    const recordQuery = queries.get(surface.dataSource.targetId);
    const recordRelation = (field: string) =>
      recordQuery?.queryType === 'get'
        ? model.relations.find(
            (relation) =>
              relation.relationId === field &&
              relation.sourceEntity.targetId ===
                recordQuery.sourceEntity.targetId,
          )
        : undefined;
    const columns = (
      values: SurfaceComposition['fields'],
      queryId: string,
      relations = false,
    ) => {
      unique(
        values.map((value) => value.columnId),
        surface.surfaceId,
      );
      const fields = fieldsFor(queryId);
      for (const column of values) {
        const related = relations ? recordRelation(column.field) : undefined;
        if (related) {
          // Read through the related record's own get, under its own policy.
          if (
            !column.reference ||
            queries.get(column.reference.query.targetId)?.sourceEntity
              .targetId !== related.targetEntity.targetId
          )
            fail(
              surface.surfaceId,
              'a related record column reads its label through the related get',
            );
        } else if (!fields.has(column.field))
          fail(surface.surfaceId, 'column is not a declared query result');
        // A read model states its figures as exact decimals; a declared field
        // must be one to be shown as money.
        if (
          column.format === 'money' &&
          (column.reference ||
            model.fields.some(
              (field) =>
                field.fieldId === column.field &&
                field.fieldType.kind !== 'exactDecimalFieldType',
            ))
        )
          fail(surface.surfaceId, 'a money column reads an exact decimal');
        if (column.reference) {
          const target = queries.get(column.reference.query.targetId);
          if (
            column.reference.query.kind !== 'queryReference' ||
            target?.queryType !== 'get' ||
            !fieldsFor(target.queryId).has(column.reference.labelField.targetId)
          )
            fail(
              surface.surfaceId,
              'reference presentation requires an exact get and selected label',
            );
        }
      }
    };
    columns(composition.fields, surface.dataSource.targetId, true);
    // The record's get states at most four related records per read.
    if (
      new Set(
        [
          ...composition.fields.map((column) => column.field),
          ...composition.actions.flatMap((action) =>
            action.navigate?.record.source === 'record'
              ? [action.navigate.record.field]
              : [],
          ),
        ].filter((field) => recordRelation(field)),
      ).size > 4
    )
      fail(surface.surfaceId, 'a record names at most four related records');
    if (composition.fields.some((column) => column.presentation))
      fail(
        surface.surfaceId,
        'cell hierarchy belongs to dataset columns; root fields use header roles',
      );
    const presentation = composition.presentation;
    if (presentation) {
      const header = presentation.header;
      const ids = [
        header.title,
        ...header.subtitle,
        ...header.facts,
        ...(header.status ? [header.status] : []),
      ];
      unique(ids, surface.surfaceId);
      if (
        ids.some(
          (id) => !composition.fields.some((column) => column.columnId === id),
        )
      )
        fail(
          surface.surfaceId,
          'header roles require declared composition columns',
        );
      if (!surface.slots.some((slot) => slot.slot === 'titleStatus'))
        fail(surface.surfaceId, 'header presentation requires titleStatus');
      const print = presentation.print;
      if (print) {
        unique(print.datasets, surface.surfaceId);
        if (
          print.datasets.some(
            (id) =>
              !composition.children.some((child) => child.datasetId === id),
          )
        )
          fail(surface.surfaceId, 'a printed dataset is a declared child');
        if (
          print.note &&
          !composition.fields.some((column) => column.columnId === print.note)
        )
          fail(surface.surfaceId, 'a printed note is a declared column');
        if (print.totals) {
          unique(print.totals, surface.surfaceId);
          if (
            print.totals.some(
              (id) =>
                !composition.fields.some((column) => column.columnId === id),
            )
          )
            fail(surface.surfaceId, 'printed totals are declared columns');
        }
      }
      // A block reads declared columns the header does not already show, each
      // in one block.
      const blocked = (presentation.blocks ?? []).flatMap(
        (block) => block.columns,
      );
      unique(blocked, surface.surfaceId);
      if (
        blocked.some(
          (id) =>
            ids.includes(id) ||
            !composition.fields.some((column) => column.columnId === id),
        )
      )
        fail(
          surface.surfaceId,
          'a block lists declared columns the header does not show',
        );
      // An alert names its rows by their primary cell and states a stored
      // figure of each, never a label.
      const named = (datasetId: string) =>
        children
          .get(datasetId)
          ?.columns.some(
            (column) => column.presentation?.role === 'primary',
          ) === true;
      const alerts = presentation.alerts ?? [];
      unique(
        alerts.map((alert) => `${alert.datasetId} ${alert.columnId}`),
        surface.surfaceId,
      );
      for (const alert of alerts) {
        const column = children
          .get(alert.datasetId)
          ?.columns.find((value) => value.columnId === alert.columnId);
        if (!column || column.reference)
          fail(
            surface.surfaceId,
            'an alert reads a stated column of a declared dataset',
          );
        if (!named(alert.datasetId))
          fail(
            surface.surfaceId,
            'an alert names its rows by a primary column',
          );
      }
      const progression = presentation.progression;
      if (progression) {
        unique(
          progression.steps.map((step) => step.label),
          surface.surfaceId,
        );
        const recordFields = fieldsFor(surface.dataSource.targetId);
        for (const step of progression.steps) {
          if (!step.current.length && !step.complete.length)
            fail(
              surface.surfaceId,
              'a progression step declares when it is current or complete',
            );
          if (
            [
              ...step.current,
              ...step.complete,
              ...(step.attention ?? []),
              ...(step.stopped ?? []),
            ].some(
              (condition) =>
                condition.value.source !== 'record' ||
                !recordFields.has(condition.value.field),
            )
          )
            fail(
              surface.surfaceId,
              'progression conditions read record values',
            );
          // Documents are named by their primary cell, else their first.
          if (step.documents && !children.has(step.documents))
            fail(
              surface.surfaceId,
              'progression documents are a declared dataset',
            );
        }
        unique(
          progression.next.map((entry) =>
            'action' in entry
              ? `action ${entry.action}`
              : `operation ${entry.operation.targetId}`,
          ),
          surface.surfaceId,
        );
        for (const entry of progression.next) {
          if ('action' in entry) {
            const action = composition.actions.find(
              (value) => value.actionId === entry.action,
            );
            if (!action || action.datasetId)
              fail(
                surface.surfaceId,
                'a next action is a record task of this composition',
              );
          } else {
            const operation = operations.get(entry.operation.targetId);
            if (
              entry.operation.kind !== 'operationReference' ||
              !operation ||
              queries.get(operation.readBack.targetId)?.sourceEntity
                .targetId !== recordQuery?.sourceEntity.targetId
            )
              fail(
                surface.surfaceId,
                'a next operation acts on the record this page shows',
              );
          }
        }
      }
    }
    for (const child of composition.children) {
      if (
        child.presentation?.selectedActions &&
        child.presentation.selection !== 'explicit'
      )
        fail(
          surface.surfaceId,
          'selected row actions require explicit selection',
        );
      if (
        child.sort?.some(
          (entry) =>
            !fieldsFor(child.query.targetId).has(entry.fieldId) ||
            ['recordId', 'revision'].includes(entry.fieldId),
        )
      )
        fail(surface.surfaceId, 'child sorting requires declared query fields');
      unique(
        (child.sort ?? []).map((entry) => entry.fieldId),
        surface.surfaceId,
      );
      if (child.presentation && !presentation)
        fail(
          surface.surfaceId,
          'dataset presentation requires record presentation',
        );
      const primaries = child.columns.filter(
        (column) => column.presentation?.role === 'primary',
      );
      if (
        child.columns.some((column) => column.presentation) &&
        primaries.length !== 1
      )
        fail(
          surface.surfaceId,
          'column hierarchy requires exactly one primary',
        );
      if (
        child.columns.some((column) => column.presentation) &&
        !child.presentation
      )
        fail(
          surface.surfaceId,
          'column hierarchy requires dataset presentation',
        );
    }
    for (const action of composition.actions) {
      if (action.presentation && (!presentation || !action.datasetId))
        fail(
          surface.surfaceId,
          'contextual actions require record presentation and a dataset',
        );
      if (
        action.presentation?.placement === 'selection' &&
        children.get(action.datasetId!)?.presentation?.selection !== 'explicit'
      )
        fail(
          surface.surfaceId,
          'contextual operations require an explicitly selectable dataset',
        );
      if (
        action.presentation?.placement === 'row' &&
        (!action.navigate || action.steps.length)
      )
        fail(
          surface.surfaceId,
          'row placement is read-only navigation; operations require explicit selection',
        );
    }

    const contextValue = (
      value: SurfaceComposition['actions'][number]['steps'][number]['bindings'][number]['value'],
      datasetId?: string,
    ) => {
      if (
        value.source === 'record' &&
        fieldsFor(surface.dataSource.targetId).has(value.field)
      )
        return;
      if (value.source === 'literal') return;
      if (value.source === 'selected') {
        const child = children.get(value.datasetId ?? datasetId ?? '');
        if (child && fieldsFor(child.query.targetId).has(value.field)) return;
      }
      fail(
        surface.surfaceId,
        'context binding requires a declared record or selected result',
      );
    };
    const previousChildren = new Set<string>();
    for (const child of [...composition.children].sort(
      (a, b) => a.orderKey - b.orderKey,
    )) {
      const query = queries.get(child.query.targetId);
      if (
        child.query.kind !== 'queryReference' ||
        query?.queryType !== 'list' ||
        !child.parent
      )
        fail(surface.surfaceId, 'child datasets require a scoped list');
      const relation = model.relations.find(
        (value) => value.relationId === child.parent!.relationId,
      );
      if (
        !relation ||
        relation.sourceEntity.targetId !== query!.sourceEntity.targetId ||
        relation.ownership !== child.parent!.ownership
      )
        fail(
          surface.surfaceId,
          'child scope must name its own declared relation and ownership',
        );
      contextValue(child.parent!.value);
      if (
        child.parent!.value.source === 'selected' &&
        (!child.parent!.value.datasetId ||
          !previousChildren.has(child.parent!.value.datasetId))
      )
        fail(
          surface.surfaceId,
          'child dependencies must name an earlier dataset',
        );
      const parentValue = child.parent!.value;
      const sourceQuery =
        parentValue.source === 'record'
          ? queries.get(surface.dataSource.targetId)
          : parentValue.source === 'selected'
            ? queries.get(children.get(parentValue.datasetId!)!.query.targetId)
            : undefined;
      if (
        !sourceQuery ||
        parentValue.source === 'literal' ||
        !('field' in parentValue) ||
        parentValue.field !== 'recordId' ||
        sourceQuery.sourceEntity.targetId !== relation!.targetEntity.targetId
      )
        fail(
          surface.surfaceId,
          'child parent must map the declared target record identity',
        );
      columns(child.columns, child.query.targetId);
      previousChildren.add(child.datasetId);
    }
    for (const action of composition.actions) {
      if (Boolean(action.navigate) === action.steps.length > 0)
        fail(surface.surfaceId, 'an action either navigates or executes steps');
      if (action.datasetId && !children.has(action.datasetId))
        fail(surface.surfaceId, 'action selects a declared dataset');
      if (action.navigate && !surfaces.has(action.navigate.surface.targetId))
        fail(surface.surfaceId, 'navigation targets a declared surface');
      for (const condition of action.conditions)
        contextValue(condition.value, action.datasetId);
      if (action.navigate) {
        const target = model.surfaces.find(
          (candidate) =>
            candidate.surfaceId === action.navigate!.surface.targetId,
        );
        if (
          action.navigate.surface.kind !== 'surfaceReference' ||
          action.navigate.query.kind !== 'queryReference' ||
          target?.dataSource.targetId !== action.navigate.query.targetId
        )
          fail(
            surface.surfaceId,
            'navigation must use its target surface query',
          );
        // A record may open the record it refers to -- an invoice its sales
        // order -- on a page that reads that record's own entity.
        const record = action.navigate.record;
        const related =
          record.source === 'record' ? recordRelation(record.field) : undefined;
        if (related) {
          if (
            action.datasetId ||
            queries.get(action.navigate.query.targetId)?.sourceEntity
              .targetId !== related.targetEntity.targetId
          )
            fail(
              surface.surfaceId,
              'navigation to a related record opens a page of that record',
            );
        } else contextValue(record, action.datasetId);
      }
      // A multi-row Task: the rows it works through, the inputs asked once
      // per row and the steps run once per row.
      const rows = action.rows;
      const perRow = action.inputs.filter((input) => input.perRow);
      const eachSteps = action.steps.filter((step) => step.each);
      if (!rows && perRow.length)
        fail(surface.surfaceId, 'per-row inputs require declared task rows');
      if (!rows && eachSteps.length)
        fail(surface.surfaceId, 'per-row steps require declared task rows');
      const selectedContext = new Set<string>();
      for (
        let dataset = action.datasetId;
        dataset && !selectedContext.has(dataset);
      ) {
        selectedContext.add(dataset);
        const parent = children.get(dataset)?.parent?.value;
        dataset = parent?.source === 'selected' ? parent.datasetId : undefined;
      }
      if (rows) {
        const target = children.get(rows.datasetId);
        const parent = target?.parent?.value;
        // The rows belong to the record, or to the row the Task was started
        // from -- never to a selection the Task does not carry.
        if (
          !target ||
          rows.datasetId === action.datasetId ||
          !(
            parent?.source === 'record' ||
            (parent?.source === 'selected' &&
              selectedContext.has(parent.datasetId ?? ''))
          )
        )
          fail(
            surface.surfaceId,
            'task rows are a dataset of the record or of the selected row',
          );
        if (!eachSteps.length)
          fail(surface.surfaceId, 'task rows require a per-row step');
        if (action.presentation?.task)
          fail(surface.surfaceId, 'a multi-row task has no single-row summary');
        const rowFields = fieldsFor(target!.query.targetId);
        for (const condition of rows.conditions) {
          const value = condition.value;
          if (
            !(
              value.source === 'selected' &&
              (value.datasetId ?? rows.datasetId) === rows.datasetId &&
              rowFields.has(value.field)
            ) &&
            !(
              value.source === 'record' &&
              fieldsFor(surface.dataSource.targetId).has(value.field)
            )
          )
            fail(
              surface.surfaceId,
              'row conditions read the row or the record',
            );
        }
        for (const input of perRow) {
          const fill = input.perRow!.fillFrom;
          if (
            !['quantity', 'text'].includes(input.type) ||
            input.defaultFrom ||
            (input.presentation && input.presentation.kind !== 'derived') ||
            (input.presentation && fill)
          )
            fail(
              surface.surfaceId,
              'per-row inputs are typed quantities or text, or derived from their row',
            );
          if (
            fill &&
            (fill.datasetId !== rows.datasetId ||
              !target!.columns.some(
                (column) => column.columnId === fill.columnId,
              ))
          )
            fail(
              surface.surfaceId,
              'a per-row input fills from a column of its row',
            );
        }
        if (
          Boolean(rows.fillLabel) !==
          perRow.some((input) => input.perRow!.fillFrom)
        )
          fail(
            surface.surfaceId,
            'a fill control is labelled exactly when a per-row input fills',
          );
      }
      for (const input of action.inputs) {
        const query = input.query
          ? queries.get(input.query.targetId)
          : undefined;
        if (input.type === 'reference') {
          if (
            input.query?.kind !== 'queryReference' ||
            input.labelField?.kind !== 'fieldReference' ||
            query?.queryType !== 'list' ||
            !fieldsFor(query.queryId).has(input.labelField.targetId)
          )
            fail(
              surface.surfaceId,
              'reference input requires a declared list and label',
            );
          const problem = input.eligibility
            ? pickerEligibilityProblem(
                model,
                input.eligibility,
                String(query!.sourceEntity.targetId),
              )
            : null;
          if (problem) fail(surface.surfaceId, problem);
        } else if (input.query || input.labelField || input.eligibility)
          fail(
            surface.surfaceId,
            'only reference inputs declare lookup queries',
          );
        // A reference input may start from a value the record itself stores,
        // read from a field the surface's record query selects.
        if (
          input.defaultFrom &&
          (input.type !== 'reference' ||
            !fieldsFor(surface.dataSource.targetId).has(
              input.defaultFrom.field,
            ))
        )
          fail(
            surface.surfaceId,
            'only reference inputs default from a declared record field',
          );
        const presented = input.presentation;
        if (!presented) continue;
        if (input.type !== 'text')
          fail(surface.surfaceId, 'input presentation applies to text inputs');
        if (presented.kind === 'choice') {
          const values = presented.options.map((option) => option.value);
          if (
            new Set(values).size !== values.length ||
            (presented.defaultValue !== undefined &&
              !values.includes(presented.defaultValue)) ||
            (presented.defaultFrom !== undefined &&
              !fieldsFor(surface.dataSource.targetId).has(
                presented.defaultFrom.field,
              ))
          )
            fail(
              surface.surfaceId,
              'choice inputs require unique values, a listed default and a declared record default',
            );
        }
        if (presented.kind === 'derived') {
          // Derived from the row the action selected (or its parent context),
          // so the value can never come from somewhere the user did not pick;
          // a per-row input, from its own row.
          const ancestry = input.perRow
            ? new Set([action.rows?.datasetId ?? ''])
            : selectedContext;
          if (
            !ancestry.has(presented.column.datasetId) ||
            !children
              .get(presented.column.datasetId)
              ?.columns.some(
                (column) => column.columnId === presented.column.columnId,
              )
          )
            fail(
              surface.surfaceId,
              'derived inputs require a column of the selected dataset or its parent context',
            );
        }
      }
      unique(
        action.inputs.map((input) => input.inputId),
        surface.surfaceId,
      );
      const task = action.presentation?.task;
      if (task) {
        if (
          action.presentation?.placement !== 'selection' ||
          !action.steps.length
        )
          fail(
            surface.surfaceId,
            'task summaries require a selected operation',
          );
        const ancestry = new Set<string>();
        let dataset = action.datasetId;
        while (dataset && !ancestry.has(dataset)) {
          ancestry.add(dataset);
          const parent = children.get(dataset)?.parent?.value;
          dataset =
            parent?.source === 'selected' ? parent.datasetId : undefined;
        }
        const taskColumn = (reference: {
          datasetId: string;
          columnId: string;
        }) => {
          const column = children
            .get(reference.datasetId)
            ?.columns.find((value) => value.columnId === reference.columnId);
          if (!ancestry.has(reference.datasetId) || !column)
            fail(
              surface.surfaceId,
              'task summaries require columns from the selected dataset or its parent context',
            );
          return column!;
        };
        const taskValue = (
          value: NonNullable<
            NonNullable<
              SurfaceComposition['actions'][number]['presentation']
            >['task']
          >['confirmation']['quantity'],
          type: 'quantity' | 'reference',
        ) => {
          if (value.source === 'column') {
            const column = taskColumn(value);
            if (type === 'quantity' && column.presentation?.role !== 'quantity')
              fail(
                surface.surfaceId,
                'task confirmation quantity requires a quantity column',
              );
          } else if (
            !action.inputs.some(
              (input) => input.inputId === value.inputId && input.type === type,
            )
          )
            fail(
              surface.surfaceId,
              'task confirmation requires a declared input of the matching type',
            );
        };
        taskColumn(task.summary.identity);
        if (task.summary.secondary) taskColumn(task.summary.secondary);
        if (task.summary.context) taskColumn(task.summary.context);
        if (task.summary.quantity) {
          const quantity = task.summary.quantity;
          if (
            quantity.value.datasetId !== quantity.unit.datasetId ||
            taskColumn(quantity.value).presentation?.role !== 'quantity'
          )
            fail(
              surface.surfaceId,
              'task summary quantity and unit require the same selected dataset scope',
            );
          taskColumn(quantity.unit);
        }
        taskValue(task.confirmation.quantity, 'quantity');
        taskColumn(task.confirmation.unit);
        if (task.confirmation.context)
          taskValue(task.confirmation.context, 'reference');
      }
      unique(
        action.steps.map((step) => step.stepId),
        surface.surfaceId,
      );
      const prior = new Set<string>();
      for (const step of action.steps) {
        if (
          step.operation.kind !== 'operationReference' ||
          !operations.has(step.operation.targetId)
        )
          fail(surface.surfaceId, 'step invokes a declared operation');
        unique(
          step.bindings.map((binding) => binding.path.join('.')),
          surface.surfaceId,
        );
        for (const binding of step.bindings) {
          if (
            binding.path.some((part) =>
              ['__proto__', 'prototype', 'constructor'].includes(part),
            )
          )
            fail(surface.surfaceId, 'unsafe input path');
          if (
            ![
              'recordId',
              'expectedRevision',
              'legalEntityId',
              'values',
              'relations',
              'patch',
            ].includes(binding.path[0]!)
          )
            fail(
              surface.surfaceId,
              'step binds supported operation inputs only',
            );
          const operation = operations.get(step.operation.targetId)!;
          const effect = operation.effect;
          const root = binding.path[0]!;
          if (
            ['recordId', 'expectedRevision', 'legalEntityId'].includes(root) &&
            binding.path.length !== 1
          )
            fail(surface.surfaceId, 'system inputs are scalar');
          if (['values', 'patch', 'relations'].includes(root)) {
            if (binding.path.length !== 2 || !('entity' in effect))
              fail(
                surface.surfaceId,
                'field mappings require a declared record effect',
              );
            if (root === 'relations') {
              if (
                effect.kind !== 'createRecordEffect' ||
                !model.relations.some(
                  (relation) =>
                    relation.relationId === binding.path[1] &&
                    relation.sourceEntity.targetId ===
                      ('entity' in effect ? effect.entity.targetId : ''),
                )
              )
                fail(
                  surface.surfaceId,
                  'relation mapping is not an input of this operation',
                );
            } else if (
              !model.fields.some(
                (field) =>
                  field.fieldId === binding.path[1] &&
                  field.entity.targetId ===
                    ('entity' in effect ? effect.entity.targetId : ''),
              ) ||
              (root === 'values'
                ? effect.kind !== 'createRecordEffect'
                : effect.kind !== 'updateRecordEffect')
            )
              fail(
                surface.surfaceId,
                'field mapping is not an input of this operation',
              );
          }
          const value = binding.value;
          const bound =
            value.source === 'input'
              ? action.inputs.find((input) => input.inputId === value.inputId)
              : undefined;
          if (value.source === 'input' && !bound)
            fail(surface.surfaceId, 'step input must be declared');
          // A per-row value exists only in the run for its row.
          if (bound?.perRow && !step.each)
            fail(
              surface.surfaceId,
              'a per-row input is bound only in a per-row step',
            );
          if (value.source === 'step') {
            const sourceStep = action.steps.find(
              (candidate) => candidate.stepId === value.stepId,
            );
            const sourceOperation = sourceStep
              ? operations.get(sourceStep.operation.targetId)
              : undefined;
            if (
              !prior.has(value.stepId) ||
              !sourceOperation ||
              !fieldsFor(sourceOperation.readBack.targetId).has(value.field)
            )
              fail(
                surface.surfaceId,
                'step mapping must select an earlier operation read-back',
              );
            // A per-row step reads an earlier per-row step's read-back of
            // its own row -- the reservation it then reserves and ships from
            // (SALES-EXTRAS); nothing else reads a per-row read-back.
            if (sourceStep?.each && !step.each)
              fail(
                surface.surfaceId,
                'no step reads the read-back of a per-row step but a later per-row step, of its own row',
              );
          }
          if (
            value.source === 'record' &&
            !fieldsFor(surface.dataSource.targetId).has(value.field)
          )
            fail(surface.surfaceId, 'record mapping requires a selected field');
          if (value.source === 'selected') {
            // In a per-row step an unnamed selection is that step's row.
            const datasetId =
              value.datasetId ??
              (step.each ? rows?.datasetId : undefined) ??
              action.datasetId ??
              '';
            const child = children.get(datasetId);
            if (!child || !fieldsFor(child.query.targetId).has(value.field))
              fail(
                surface.surfaceId,
                'selected mapping requires a declared dataset result',
              );
            if (rows && datasetId === rows.datasetId && !step.each)
              fail(
                surface.surfaceId,
                'a task row is read only in a per-row step',
              );
          }
        }
        prior.add(step.stepId);
      }
    }
  }
}

/** Presentation collections are ordered sets; operation steps remain an authored sequence. */
export function normalizeSurfaceComposition(
  composition: SurfaceComposition,
): SurfaceComposition {
  const ordered = <T extends { orderKey: number }>(
    entries: T[],
    key: keyof T,
  ): T[] =>
    [...entries].sort(
      (a, b) =>
        a.orderKey - b.orderKey ||
        (String(a[key]) < String(b[key])
          ? -1
          : String(a[key]) > String(b[key])
            ? 1
            : 0),
    );
  return {
    ...composition,
    fields: ordered(composition.fields, 'columnId'),
    children: ordered(composition.children, 'datasetId').map((child) => ({
      ...child,
      columns: ordered(child.columns, 'columnId'),
    })),
    actions: ordered(composition.actions, 'actionId').map((action) => ({
      ...action,
      inputs: ordered(action.inputs, 'inputId'),
      steps: action.steps.map((step) => ({
        ...step,
        bindings: [...step.bindings].sort((a, b) => {
          const x = a.path.join('.'),
            y = b.path.join('.');
          return x < y ? -1 : x > y ? 1 : 0;
        }),
      })),
    })),
  };
}
