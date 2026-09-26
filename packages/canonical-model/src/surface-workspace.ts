import type { VersionedNormalizedApplicationPackage } from './schemas.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';

/** Typed declarations also prove their cross-entity and contextual references. */
export function validateSurfaceWorkspaces(
  model: VersionedNormalizedApplicationPackage,
) {
  const surfaces = new Map(
    model.surfaces.map((value) => [String(value.surfaceId), value]),
  );
  const queries = new Map(
    model.queries.map((value) => [String(value.queryId), value]),
  );
  const fields = new Map(
    model.fields.map((value) => [String(value.fieldId), value]),
  );
  const fail = (id: string, reason: string): never => {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_SCHEMA_INVALID',
        '$.surfaces.workspace',
        reason,
        'declare compatible existing entities, queries, fields and owning workspaces',
        id,
      ),
    ]);
  };
  for (const surface of model.surfaces) {
    if ('workspace' in surface && surface.workspace) {
      const workspace = surface.workspace;
      if (
        workspace.membership !== 'contextual' &&
        surface.surfaceRole !== 'list'
      )
        fail(surface.surfaceId, 'navigation members must be Lists');
      if (workspace.ownerSurfaceId) {
        const owner = surfaces.get(workspace.ownerSurfaceId);
        if (
          !owner ||
          owner.lifecycle !== 'active' ||
          !('workspace' in owner) ||
          owner.workspace?.membership === 'contextual'
        )
          fail(
            surface.surfaceId,
            'context owner must be a reachable active workspace',
          );
      }
      if (workspace.entry) {
        const entry = workspace.entry;
        const company = queries.get(entry.companyQueryId);
        const authorized = queries.get(entry.authorizationQueryId);
        if (
          !company ||
          company.queryType !== 'list' ||
          ('legalEntityScope' in company && company.legalEntityScope) ||
          !authorized ||
          authorized.queryType !== 'list' ||
          !('legalEntityScope' in authorized) ||
          authorized.legalEntityScope?.cardinality !== 'exactlyOne'
        )
          fail(
            surface.surfaceId,
            'entry requires unscoped company enumeration and an explicitly scoped authorization List',
          );
        const names = new Set(
          ('selections' in company! ? company.selections : []).map((value) =>
            String(value.field.targetId),
          ),
        );
        if (
          !names.has(entry.companyNameFieldId) ||
          !names.has(entry.companyStateFieldId)
        )
          fail(
            surface.surfaceId,
            'company identity/state must be selected fields',
          );
        const state = fields.get(entry.companyStateFieldId);
        if (
          state?.fieldType.kind !== 'enumFieldType' ||
          !state.fieldType.options.some(
            (value) => value.optionId === entry.activeStateId,
          )
        )
          fail(
            surface.surfaceId,
            'active company state must be declared by its enum',
          );
      }
    }
    if (!('documentEditor' in surface) || !surface.documentEditor) continue;
    const editor = surface.documentEditor;
    if (surface.archetype !== 'record')
      fail(surface.surfaceId, 'draft editors use the Record archetype');
    const header = surfaces.get(editor.headerFormSurfaceId);
    const record = surfaces.get(editor.recordSurfaceId);
    const line = surfaces.get(editor.lineFormSurfaceId);
    const headerQuery = header && queries.get(header.dataSource.targetId);
    const recordQuery = record && queries.get(record.dataSource.targetId);
    const lineFormQuery = line && queries.get(line.dataSource.targetId);
    const lineQuery = queries.get(editor.lineQueryId);
    if (
      header?.surfaceRole !== 'form' ||
      record?.surfaceRole !== 'record' ||
      line?.surfaceRole !== 'form' ||
      !headerQuery ||
      !recordQuery ||
      !lineQuery ||
      !lineFormQuery ||
      lineQuery.queryType !== 'list' ||
      headerQuery.sourceEntity.targetId !== recordQuery.sourceEntity.targetId ||
      lineFormQuery.sourceEntity.targetId !== lineQuery.sourceEntity.targetId
    )
      fail(
        surface.surfaceId,
        'editor must bind compatible header and child form/query surfaces',
      );
    const relation = model.relations.find(
      (value) => value.relationId === editor.parentRelationId,
    );
    if (
      relation?.ownership !== 'parentScopedChild' ||
      relation.sourceEntity.targetId !== lineQuery!.sourceEntity.targetId ||
      relation.targetEntity.targetId !== headerQuery!.sourceEntity.targetId
    )
      fail(
        surface.surfaceId,
        'editor parent must be the declared immutable owning relation',
      );
    // The exact get must read the same entity as the list and select whatever
    // the picker shows or derives, so a selection never needs a list scan.
    const reads = (
      getQueryId: string,
      listQueryId: string,
      fieldIds: readonly string[],
    ) => {
      const get = queries.get(getQueryId);
      const list = queries.get(listQueryId);
      return (
        get?.queryType === 'get' &&
        get.sourceEntity.targetId === list?.sourceEntity.targetId &&
        fieldIds.every((id) =>
          get.selections.some((value) => value.field.targetId === id),
        )
      );
    };
    const selects = (queryId: string, fieldIds: readonly string[]) => {
      const query = queries.get(queryId);
      return (
        query?.queryType === 'list' &&
        fieldIds.every((id) =>
          query.selections.some((value) => value.field.targetId === id),
        )
      );
    };
    // A presentation only changes how the editor offers a value. It is checked
    // against the field's real type so a declaration can never widen or retype
    // what the domain admits.
    const checkPresentation = (
      presentation: NonNullable<
        (typeof editor.headerFields)[number]['presentation']
      >,
      fieldId: string,
      siblings: typeof editor.headerFields,
    ) => {
      const type = fields.get(fieldId)?.fieldType;
      if (presentation.kind === 'multiline') {
        if (type?.kind !== 'textFieldType')
          fail(
            surface.surfaceId,
            'multiline presentation requires a text field',
          );
        return;
      }
      if (presentation.kind === 'choice') {
        const values = presentation.options.map((option) => option.value);
        if (
          type?.kind !== 'textFieldType' ||
          new Set(values).size !== values.length ||
          values.some((value) => value.length > type.maximumLength) ||
          (presentation.defaultValue !== undefined &&
            !values.includes(presentation.defaultValue))
        )
          fail(
            surface.surfaceId,
            'choice presentation requires a text field, unique admissible values and a listed default',
          );
        return;
      }
      const source = siblings.find(
        (value) => value.fieldId === presentation.referenceFieldId,
      );
      if (
        type?.kind !== 'textFieldType' ||
        !source?.reference?.getQueryId ||
        !selects(source.reference.queryId, [presentation.sourceFieldId]) ||
        !reads(source.reference.getQueryId, source.reference.queryId, [
          presentation.sourceFieldId,
        ])
      )
        fail(
          surface.surfaceId,
          'derived presentation requires a text field and a sibling reference whose list selects the source',
        );
    };
    const operations = new Map(
      model.operations.map((value) => [String(value.operationId), value]),
    );
    // A create flow may only chain existing governed create operations. Each
    // collected field must land on exactly one step, fixed values must be
    // admissible, relations may only point backwards, and the selected record
    // must be readable through the picker's own list.
    const checkCreate = (
      create: NonNullable<
        NonNullable<(typeof editor.headerFields)[number]['reference']>['create']
      >,
      pickerEntityId: string,
    ) => {
      const stepEntities = create.steps.map((step) => {
        const effect = operations.get(step.operationId)?.effect;
        if (effect?.kind !== 'createRecordEffect')
          return fail(
            surface.surfaceId,
            'create flow steps must be governed create operations',
          );
        return String(effect.entity.targetId);
      });
      if (
        create.selectStep >= create.steps.length ||
        stepEntities[create.selectStep] !== pickerEntityId
      )
        fail(
          surface.surfaceId,
          'create flow must select a record of the picker entity',
        );
      for (const collected of create.fields) {
        const owner = fields.get(collected.fieldId)?.entity.targetId;
        if (stepEntities.filter((entity) => entity === owner).length !== 1)
          fail(
            surface.surfaceId,
            'each collected create field must belong to exactly one step',
          );
        if (collected.presentation)
          checkPresentation(collected.presentation, collected.fieldId, []);
      }
      create.steps.forEach((step, index) => {
        for (const fixed of step.fixed ?? []) {
          const field = fields.get(fixed.fieldId);
          const type = field?.fieldType;
          if (
            field?.entity.targetId !== stepEntities[index] ||
            (type?.kind === 'enumFieldType' &&
              !type.options.some(
                (option) => option.optionId === fixed.value,
              )) ||
            (type?.kind === 'textFieldType' &&
              fixed.value.length > type.maximumLength) ||
            (type?.kind !== 'enumFieldType' && type?.kind !== 'textFieldType')
          )
            fail(
              surface.surfaceId,
              'fixed create values must be admissible values of the step entity',
            );
        }
        for (const bound of step.relations ?? []) {
          const relation = model.relations.find(
            (value) => value.relationId === bound.relationId,
          );
          if (
            bound.step >= index ||
            relation?.sourceEntity.targetId !== stepEntities[index] ||
            relation?.targetEntity.targetId !== stepEntities[bound.step]
          )
            fail(
              surface.surfaceId,
              'create relations must bind an earlier step of the related entity',
            );
        }
      });
    };
    // Eligibility reads another entity's whole unscoped, unfiltered List: its
    // owned relation must point from that entity to the picker's (so one
    // record's eligibility is an exact parent-scoped read), and every filter
    // must be a selected field of it with an admissible value.
    const checkEligibility = (
      eligibility: NonNullable<
        NonNullable<
          (typeof editor.headerFields)[number]['reference']
        >['eligibility']
      >,
      pickerEntityId: string,
    ) => {
      const query = queries.get(eligibility.queryId);
      const relation = model.relations.find(
        (value) => value.relationId === eligibility.relationId,
      );
      if (
        query?.queryType !== 'list' ||
        ('legalEntityScope' in query && query.legalEntityScope) ||
        ('filter' in query &&
          query.filter &&
          !(
            query.filter.kind === 'booleanPredicate' &&
            'value' in query.filter &&
            query.filter.value === true
          )) ||
        relation?.sourceEntity.targetId !== query.sourceEntity.targetId ||
        relation.targetEntity.targetId !== pickerEntityId ||
        relation.ownership !== 'parentScopedChild' ||
        new Set(eligibility.filters.map((filter) => filter.fieldId)).size !==
          eligibility.filters.length
      )
        fail(
          surface.surfaceId,
          'picker eligibility requires an unscoped List of an entity related to the picker entity',
        );
      for (const filter of eligibility.filters) {
        const type = fields.get(filter.fieldId)?.fieldType;
        if (
          !selects(eligibility.queryId, [filter.fieldId]) ||
          (type?.kind === 'enumFieldType'
            ? !type.options.some((option) => option.optionId === filter.value)
            : type?.kind !== 'textFieldType' ||
              filter.value.length > type.maximumLength)
        )
          fail(
            surface.surfaceId,
            'picker eligibility filters require selected fields and admissible values',
          );
      }
    };
    const checkFields = (
      declared: typeof editor.headerFields,
      entityId: string,
    ) => {
      if (
        new Set(declared.map((value) => value.fieldId)).size !== declared.length
      )
        fail(surface.surfaceId, 'editor fields must be unique');
      for (const field of declared) {
        if (fields.get(field.fieldId)?.entity.targetId !== entityId)
          fail(
            surface.surfaceId,
            'editor fields must belong to their form entity',
          );
        if (field.reference && field.presentation)
          fail(
            surface.surfaceId,
            'a reference field is presented by its picker, not a presentation',
          );
        if (field.presentation)
          checkPresentation(field.presentation, field.fieldId, declared);
        if (field.reference) {
          if (
            !selects(field.reference.queryId, [
              ...field.reference.labelFieldIds,
              ...(field.reference.detailFieldIds ?? []),
            ])
          )
            fail(
              surface.surfaceId,
              'reference picker requires a declared List with readable selected labels',
            );
          const shown = [
            ...field.reference.labelFieldIds,
            ...(field.reference.detailFieldIds ?? []),
          ];
          // Any exact get that is supplied is checked, whatever else the picker
          // declares: a get is how a selection is labelled and re-read.
          if (
            field.reference.getQueryId !== undefined &&
            !reads(field.reference.getQueryId, field.reference.queryId, shown)
          )
            fail(
              surface.surfaceId,
              'a supplied exact get must be a get of the picker entity reading its labels and details',
            );
          // Only a picker that creates or shows details needs one; an older
          // declaration without a get keeps the behaviour it was released with.
          if (
            (field.reference.create || field.reference.detailFieldIds) &&
            field.reference.getQueryId === undefined
          )
            fail(
              surface.surfaceId,
              'a searchable picker requires an exact get of the same entity reading its labels',
            );
          if (field.reference.eligibility)
            checkEligibility(
              field.reference.eligibility,
              String(
                queries.get(field.reference.queryId)!.sourceEntity.targetId,
              ),
            );
          if (field.reference.create)
            checkCreate(
              field.reference.create,
              String(
                queries.get(field.reference.queryId)!.sourceEntity.targetId,
              ),
            );
        }
      }
    };
    checkFields(editor.headerFields, headerQuery!.sourceEntity.targetId);
    checkFields(editor.lineFields, lineQuery!.sourceEntity.targetId);
    if (
      fields.get(editor.lineNumberFieldId)?.entity.targetId !==
      lineQuery!.sourceEntity.targetId
    )
      fail(surface.surfaceId, 'line identity field must belong to the child');
    const state = fields.get(editor.stateFieldId);
    if (
      state?.entity.targetId !== headerQuery!.sourceEntity.targetId ||
      state.fieldType.kind !== 'enumFieldType' ||
      !editor.editableStateIds.every(
        (id) =>
          state.fieldType.kind === 'enumFieldType' &&
          state.fieldType.options.some((value) => value.optionId === id),
      )
    )
      fail(
        surface.surfaceId,
        'editable states must belong to the document state field',
      );
  }
}
