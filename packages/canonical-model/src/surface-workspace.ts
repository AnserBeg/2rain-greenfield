import type { VersionedNormalizedApplicationPackage } from './schemas.js';
import { CanonicalModelError, diagnostic } from './diagnostics.js';
import { pickerEligibilityProblem } from './picker-eligibility.js';

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
        // Offered values the field admits: text that fits it, or options of
        // its enumeration -- a narrower set, never a wider or retyped one.
        const admissible = (value: string) =>
          type?.kind === 'textFieldType'
            ? value.length <= type.maximumLength
            : type?.kind === 'enumFieldType' &&
              type.options.some((option) => option.optionId === value);
        if (
          (type?.kind !== 'textFieldType' && type?.kind !== 'enumFieldType') ||
          new Set(values).size !== values.length ||
          !values.every(admissible) ||
          (presentation.defaultValue !== undefined &&
            !values.includes(presentation.defaultValue))
        )
          fail(
            surface.surfaceId,
            'choice presentation requires a text or enumeration field, unique admissible values and a listed default',
          );
        return;
      }
      const source = siblings.find(
        (value) => value.fieldId === presentation.referenceFieldId,
      );
      const sources = [
        presentation.sourceFieldId,
        ...(presentation.sourceByHeader?.cases ?? []).map(
          (value) => value.sourceFieldId,
        ),
      ];
      if (
        (type?.kind !== 'textFieldType' &&
          type?.kind !== 'exactDecimalFieldType') ||
        !source?.reference?.getQueryId ||
        !sources.every((id) => holds(type, fields.get(id)?.fieldType)) ||
        !selects(source.reference.queryId, sources) ||
        !reads(
          source.reference.getQueryId,
          source.reference.queryId,
          sources,
        ) ||
        (presentation.sourceByHeader &&
          !headerChooses(presentation.sourceByHeader, fieldId))
      )
        fail(
          surface.surfaceId,
          'derived presentation requires a text or decimal field and a sibling reference whose list selects a compatible source',
        );
    };
    // Whether a field of type `target` can hold a value of type `source`:
    // text no longer than itself or an enumeration's label; an enumeration
    // offering each source label once; a decimal of at least the same scale.
    const holds = (
      target: (typeof model.fields)[number]['fieldType'] | undefined,
      source: (typeof model.fields)[number]['fieldType'] | undefined,
    ): boolean => {
      if (target?.kind === 'textFieldType')
        return source?.kind === 'textFieldType'
          ? source.maximumLength <= target.maximumLength
          : source?.kind === 'enumFieldType' &&
              source.options.every(
                (option) => [...option.label].length <= target.maximumLength,
              );
      if (target?.kind === 'enumFieldType')
        return (
          source?.kind === 'enumFieldType' &&
          source.options.every(
            (option) =>
              target.options.filter((value) => value.label === option.label)
                .length === 1,
          )
        );
      if (target?.kind === 'exactDecimalFieldType')
        return (
          source?.kind === 'exactDecimalFieldType' &&
          source.scale <= target.scale &&
          source.precision - source.scale <= target.precision - target.scale
        );
      return false;
    };
    // A header field chooses the source by the value it holds: a declared
    // header field (not the chosen one itself), unique values it can hold.
    const headerChooses = (
      chooser: { headerFieldId: string; cases: readonly { value: string }[] },
      fieldId: string,
    ) => {
      const header = editor.headerFields.find(
        (value) => value.fieldId === chooser.headerFieldId,
      );
      const type = fields.get(chooser.headerFieldId)?.fieldType;
      const values = chooser.cases.map((value) => value.value);
      return (
        !!header &&
        chooser.headerFieldId !== fieldId &&
        new Set(values).size === values.length &&
        values.every((value) =>
          type?.kind === 'enumFieldType'
            ? type.options.some((option) => option.optionId === value)
            : type?.kind === 'textFieldType' &&
              [...value].length <= type.maximumLength,
        )
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
    const checkEligibility = (
      eligibility: NonNullable<
        NonNullable<
          (typeof editor.headerFields)[number]['reference']
        >['eligibility']
      >,
      pickerEntityId: string,
    ) => {
      const problem = pickerEligibilityProblem(
        model,
        eligibility,
        pickerEntityId,
      );
      if (problem) fail(surface.surfaceId, problem);
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
        const target = fields.get(field.fieldId)?.fieldType;
        if (
          field.defaultDaysFromToday !== undefined &&
          (field.defaultFrom ||
            field.presentation ||
            field.reference ||
            target?.kind !== 'dateTimeFieldType' ||
            target.timezoneSemantics !== 'utcInstant')
        )
          fail(
            surface.surfaceId,
            'a default counted from today is a UTC date-time field with no other default',
          );
        if (
          field.defaultNow &&
          (field.defaultDaysFromToday !== undefined ||
            field.defaultFrom ||
            field.presentation ||
            field.reference ||
            target?.kind !== 'dateTimeFieldType' ||
            target.timezoneSemantics !== 'utcInstant')
        )
          fail(
            surface.surfaceId,
            'a default of now is a UTC date-time field with no other default',
          );
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
          if (field.reference.within) checkWithin(field, declared);
          if (field.reference.create)
            checkCreate(
              field.reference.create,
              String(
                queries.get(field.reference.queryId)!.sourceEntity.targetId,
              ),
            );
        }
        if (field.defaultFrom) checkDefault(field, declared);
      }
      // Defaults cascade (a customer's default address, then that address's
      // lines), so a cycle would never settle.
      for (const field of declared) {
        const seen = new Set<string>();
        let current: (typeof declared)[number] | undefined = field;
        while (current?.defaultFrom) {
          if (seen.has(current.fieldId))
            fail(surface.surfaceId, 'editor defaults must not form a cycle');
          seen.add(current.fieldId);
          const next: string = current.defaultFrom.referenceFieldId;
          current = declared.find((value) => value.fieldId === next);
        }
      }
    };
    const siblingReference = (
      declared: typeof editor.headerFields,
      referenceFieldId: string,
      fieldId: string,
    ) => {
      const source = declared.find(
        (value) => value.fieldId === referenceFieldId,
      );
      return source?.reference?.getQueryId && source.fieldId !== fieldId
        ? { ...source.reference, getQueryId: source.reference.getQueryId }
        : null;
    };
    // A scoped picker lists the records an owned relation ties to the sibling's
    // selection -- an exact parent-scoped read. It cannot also create, because
    // a created record would need that relation bound as well.
    const checkWithin = (
      field: (typeof editor.headerFields)[number],
      declared: typeof editor.headerFields,
    ) => {
      const within = field.reference!.within!;
      const sibling = siblingReference(
        declared,
        within.referenceFieldId,
        field.fieldId,
      );
      const relation = model.relations.find(
        (value) => value.relationId === within.relationId,
      );
      const picker = queries.get(field.reference!.queryId);
      if (
        !sibling ||
        !field.reference!.getQueryId ||
        field.reference!.create ||
        relation?.ownership !== 'parentScopedChild' ||
        relation.sourceEntity.targetId !== picker?.sourceEntity.targetId ||
        relation.targetEntity.targetId !==
          queries.get(sibling.queryId)?.sourceEntity.targetId ||
        ('legalEntityScope' in picker && picker.legalEntityScope)
      )
        fail(
          surface.surfaceId,
          'a scoped picker requires an unscoped List whose owned relation targets a sibling reference, and cannot create',
        );
    };
    // A default copies a value the sibling's record already holds into a field
    // that can hold it: text into text at least as long, an enumeration's label
    // into text that fits it, an enumeration into one offering each of the
    // same labels once, never into a derived field.
    const checkDefault = (
      field: (typeof editor.headerFields)[number],
      declared: typeof editor.headerFields,
    ) => {
      const declaredDefault = field.defaultFrom!;
      const sibling = siblingReference(
        declared,
        declaredDefault.referenceFieldId,
        field.fieldId,
      );
      const target = fields.get(field.fieldId)?.fieldType;
      const sources = [
        ...(declaredDefault.sourceFieldId
          ? [declaredDefault.sourceFieldId]
          : []),
        ...(declaredDefault.sourceByHeader?.cases ?? []).map(
          (value) => value.sourceFieldId,
        ),
      ];
      // Either the header's value of a field, or the sibling's record.
      const fromHeader = declaredDefault.headerFieldId;
      const valid = fromHeader
        ? sources.length === 0 &&
          fromHeader !== field.fieldId &&
          editor.headerFields.some((value) => value.fieldId === fromHeader) &&
          holds(target, fields.get(fromHeader)?.fieldType)
        : sources.length > 0 &&
          sources.every((id) => holds(target, fields.get(id)?.fieldType)) &&
          !!sibling &&
          selects(sibling.queryId, sources) &&
          reads(sibling.getQueryId, sibling.queryId, sources) &&
          (!declaredDefault.sourceByHeader ||
            headerChooses(declaredDefault.sourceByHeader, field.fieldId));
      if (!sibling || field.presentation?.kind === 'derived' || !valid)
        fail(
          surface.surfaceId,
          'an editor default requires a sibling reference whose record holds a compatible selected source',
        );
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
    // What a never-saved document's first create also writes: header fields
    // the editor does not offer, each once, with a value the field admits --
    // text that fits, an option of its enumeration, the document's own record
    // id or the saving principal into text long enough to hold one, or the
    // save's instant into a UTC instant.
    const headerEntity = headerQuery!.sourceEntity.targetId;
    const offered = new Set(
      [...editor.headerFields, ...editor.lineFields].map((value) =>
        String(value.fieldId),
      ),
    );
    const createValues = editor.createValues ?? [];
    const createsHeader = model.operations.some(
      (operation) =>
        operation.effect.kind === 'createRecordEffect' &&
        'entity' in operation.effect &&
        operation.effect.entity.targetId === headerEntity,
    );
    if (
      new Set(createValues.map((value) => value.fieldId)).size !==
      createValues.length
    )
      fail(surface.surfaceId, 'a create value names each field once');
    for (const entry of createValues) {
      const type = fields.get(entry.fieldId)?.fieldType;
      const value = entry.value;
      // A record id or principal is a uuid: text of at least 36 characters.
      // The save's instant is a UTC instant.
      const admissible =
        value.source === 'record' || value.source === 'actor'
          ? type?.kind === 'textFieldType' && type.maximumLength >= 36
          : value.source === 'generated'
            ? type?.kind === 'dateTimeFieldType' &&
              type.timezoneSemantics === 'utcInstant'
            : type?.kind === 'textFieldType'
              ? [...value.value].length <= type.maximumLength
              : type?.kind === 'enumFieldType' &&
                type.options.some((option) => option.optionId === value.value);
      if (
        !createsHeader ||
        fields.get(entry.fieldId)?.entity.targetId !== headerEntity ||
        offered.has(String(entry.fieldId)) ||
        !admissible
      )
        fail(
          surface.surfaceId,
          'a create value is a header field no editor field offers, holding a value it admits',
        );
    }
  }
}
