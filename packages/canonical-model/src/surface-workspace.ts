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
        if (field.reference) {
          const query = queries.get(field.reference.queryId);
          if (
            query?.queryType !== 'list' ||
            !field.reference.labelFieldIds.every((id) =>
              query.selections.some((value) => value.field.targetId === id),
            )
          )
            fail(
              surface.surfaceId,
              'reference picker requires a declared List with readable selected labels',
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
