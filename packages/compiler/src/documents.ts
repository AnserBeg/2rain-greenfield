import type { VersionedNormalizedApplicationPackage } from '@north-star/canonical-model';
import {
  DOCUMENTS_PAYLOAD_VERSION,
  documentAttachOperation,
  documentAttachPermission,
  documentGenerateOperation,
} from '../../canonical-model/src/documents.js';

import { compileDocumentTemplates } from './document-templates.js';

export function compileDocuments(
  definition: VersionedNormalizedApplicationPackage,
) {
  if (definition.languageVersion !== 'v6') return null;
  const fields = definition.documentFields ?? [];
  const categories = definition.documentCategories ?? [];
  const templates = compileDocumentTemplates(definition);
  if (templates.message) return templates;
  if (fields.length === 0 && categories.length === 0 && !templates.templates)
    return null;

  const calculatedFields = definition.calculatedDisplayFields ?? [];
  const ids = new Set<string>(
    [...definition.fields, ...calculatedFields].map(({ fieldId }) => fieldId),
  );
  const labels = new Set([
    ...definition.fields.map(({ entity, label }) =>
      JSON.stringify([entity.targetId, label.toLowerCase()]),
    ),
    ...calculatedFields.map(({ entityId, label }) =>
      JSON.stringify([entityId, label.toLowerCase()]),
    ),
  ]);
  const fieldsById = new Map(fields.map((field) => [field.fieldId, field]));
  const categoriesById = new Map(
    categories.map((category) => [category.categoryId, category]),
  );
  for (const field of fields) {
    const labelKey = JSON.stringify([
      field.entityId,
      field.label.toLowerCase(),
    ]);
    if (ids.has(field.fieldId) || labels.has(labelKey)) {
      return {
        subjectId: field.fieldId,
        message: 'Document field IDs and labels must be unique on the record.',
      };
    }
    ids.add(field.fieldId);
    labels.add(labelKey);
    const allowed = new Set(field.allowedCategoryIds);
    if (allowed.size !== field.allowedCategoryIds.length) {
      return {
        subjectId: field.fieldId,
        message: 'A file field lists each allowed category once.',
      };
    }
    for (const categoryId of allowed) {
      const category = categoriesById.get(categoryId);
      if (
        category?.fieldId !== field.fieldId ||
        category.entityId !== field.entityId
      ) {
        return {
          subjectId: field.fieldId,
          message:
            'Each category must belong to this file field and record type.',
        };
      }
    }
  }
  const categoryIds = new Set<string>();
  for (const category of categories) {
    const field = fieldsById.get(category.fieldId);
    if (
      categoryIds.has(category.categoryId) ||
      new Set(category.contentTypes).size !== category.contentTypes.length ||
      !field ||
      field.entityId !== category.entityId ||
      !field.allowedCategoryIds.includes(category.categoryId) ||
      category.maxCount > field.maxCount
    ) {
      return {
        subjectId: category.categoryId,
        message:
          'A category needs a unique ID, distinct content types and a matching file field with room for its count.',
      };
    }
    categoryIds.add(category.categoryId);
  }

  const bindings = [];
  const templateEntityIds = new Set(
    (templates.templates?.revisions ?? []).map(({ entityId }) => entityId),
  );
  const activeTemplateEntities = new Set(
    (templates.templates?.revisions ?? [])
      .filter((revision) =>
        templates.templates!.pointers.some(
          ({ activeRevisionId }) => activeRevisionId === revision.revisionId,
        ),
      )
      .map(({ entityId }) => entityId),
  );
  const fileEntityIds = new Set(fields.map(({ entityId }) => entityId));
  for (const entityId of new Set([...fileEntityIds, ...templateEntityIds])) {
    const entity = definition.entities.find(
      (entry) => entry.entityId === entityId,
    );
    const surfaces = definition.surfaces.filter(
      (entry) => entry.surfaceRole === 'record' && entry.lifecycle === 'active',
    );
    const recordQueries = definition.queries.filter(
      (entry) =>
        entry.sourceEntity.targetId === entityId &&
        entry.queryType === 'get' &&
        entry.tier === 'q0' &&
        entry.lifecycle === 'active' &&
        surfaces.some(
          (surface) => surface.dataSource.targetId === entry.queryId,
        ),
    );
    const query =
      recordQueries.find(
        (entry) => !('readModel' in entry) || !entry.readModel,
      ) ?? (templateEntityIds.has(entityId) ? recordQueries[0] : undefined);
    if (!entity || entity.lifecycle !== 'active' || !query) {
      if (!activeTemplateEntities.has(entityId) && !fileEntityIds.has(entityId))
        continue;
      return {
        subjectId: entityId,
        message:
          'Documents need an active record type with a governed Record read.',
      };
    }
    bindings.push({
      entityId,
      queryId: query.queryId,
      attachPermissionId: documentAttachPermission(entityId),
      attachOperationId: documentAttachOperation(entityId),
      ...(activeTemplateEntities.has(entityId) && {
        generateOperationId: documentGenerateOperation(entityId),
      }),
      surfaceIds: surfaces
        .filter((surface) => surface.dataSource.targetId === query.queryId)
        .map((surface) => surface.surfaceId),
    });
  }
  return {
    payload: {
      kind: 'documentsPayload',
      schemaVersion: DOCUMENTS_PAYLOAD_VERSION,
      bindings,
      fields,
      categories,
      ...(templates.templates && { templates: templates.templates }),
    },
  };
}
