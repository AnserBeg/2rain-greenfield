import type {
  SurfaceComposition,
  VersionedNormalizedApplicationPackage,
} from './schemas.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';

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
    const columns = (values: SurfaceComposition['fields'], queryId: string) => {
      unique(
        values.map((value) => value.columnId),
        surface.surfaceId,
      );
      const fields = fieldsFor(queryId);
      for (const column of values) {
        if (!fields.has(column.field))
          fail(surface.surfaceId, 'column is not a declared query result');
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
    columns(composition.fields, surface.dataSource.targetId);
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
        contextValue(action.navigate.record, action.datasetId);
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
        } else if (input.query || input.labelField)
          fail(
            surface.surfaceId,
            'only reference inputs declare lookup queries',
          );
      }
      unique(
        action.inputs.map((input) => input.inputId),
        surface.surfaceId,
      );
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
          if (
            value.source === 'input' &&
            !action.inputs.some((input) => input.inputId === value.inputId)
          )
            fail(surface.surfaceId, 'step input must be declared');
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
          }
          if (
            value.source === 'record' &&
            !fieldsFor(surface.dataSource.targetId).has(value.field)
          )
            fail(surface.surfaceId, 'record mapping requires a selected field');
          if (value.source === 'selected') {
            const child = children.get(
              value.datasetId ?? action.datasetId ?? '',
            );
            if (!child || !fieldsFor(child.query.targetId).has(value.field))
              fail(
                surface.surfaceId,
                'selected mapping requires a declared dataset result',
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
