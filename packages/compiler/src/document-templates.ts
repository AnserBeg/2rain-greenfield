import type { VersionedNormalizedApplicationPackage } from '@north-star/canonical-model';
import type {
  DocumentTemplatePointer,
  DocumentTemplateRevision,
} from '../../canonical-model/src/document-template-schema.js';

type Definition = Extract<
  VersionedNormalizedApplicationPackage,
  { languageVersion: 'v6' }
>;

type Templates = {
  readonly revisions: readonly DocumentTemplateRevision[];
  readonly pointers: readonly DocumentTemplatePointer[];
};

export function compileDocumentTemplates(
  definition: Definition,
):
  | { templates?: Templates; message?: never; subjectId?: never }
  | { message: string; subjectId: string; templates?: never } {
  const revisions = definition.documentTemplateRevisions ?? [];
  const pointers = definition.documentTemplatePointers ?? [];
  if (!revisions.length && !pointers.length) return {};
  const revisionsById = new Map(
    revisions.map((revision) => [revision.revisionId, revision]),
  );
  const pointersById = new Map(
    pointers.map((pointer) => [pointer.templateId, pointer.activeRevisionId]),
  );
  const refusal = (subjectId: string, message: string) => ({
    subjectId,
    message,
  });
  if (
    revisionsById.size !== revisions.length ||
    pointersById.size !== pointers.length
  )
    return refusal(
      definition.package.packageId,
      'Template and revision IDs must be unique.',
    );
  for (const pointer of pointers) {
    if (
      !revisions.some(
        (revision) => revision.templateId === pointer.templateId,
      ) ||
      (pointer.activeRevisionId !== null &&
        revisionsById.get(pointer.activeRevisionId)?.templateId !==
          pointer.templateId)
    )
      return refusal(
        pointer.templateId,
        'A template pointer must name a revision of that template or retirement.',
      );
  }
  const firstByTemplate = new Map<string, (typeof revisions)[number]>();
  for (const revision of revisions) {
    const { templateId, revisionId, entityId, headerQueryId } = revision;
    const first = firstByTemplate.get(templateId);
    if (
      !pointersById.has(templateId) ||
      (first &&
        (first.entityId !== entityId ||
          first.documentKind !== revision.documentKind))
    )
      return refusal(
        revisionId,
        'A template keeps its record type and document kind across revisions.',
      );
    firstByTemplate.set(templateId, revision);
    // Immutable historical revisions survive retirement and remain usable as evidence.
    if (pointersById.get(templateId) !== revisionId) continue;
    const header = sourceQuery(definition, headerQueryId, 'get');
    if (header?.sourceEntity.targetId !== entityId)
      return refusal(
        revisionId,
        'The header needs a declared record query on the governing record type.',
      );
    const identity = selectedField(
      definition,
      header,
      revision.identityFieldId,
    );
    if (
      !identity ||
      !['textFieldType', 'integerFieldType'].includes(identity.fieldType.kind)
    )
      return refusal(
        revisionId,
        'The issued identity must bind to a selected text or integer field.',
      );
    if (
      !currencyIsBound(
        definition,
        header,
        revision.currencyFieldId,
        revision.layout.flatMap((block) =>
          block.kind === 'field' ? [block.fieldId] : [],
        ),
      )
    )
      return refusal(
        revisionId,
        'Money bindings must also select their declared currency field.',
      );
    for (const block of revision.layout) {
      if (
        block.kind === 'field' &&
        !selectedField(definition, header, block.fieldId)
      )
        return refusal(
          revisionId,
          'Each header binding must name a selected and admitted result field.',
        );
      if (block.kind !== 'table') continue;
      const query = sourceQuery(definition, block.queryId, 'list');
      const relation = definition.relations.find(
        ({ relationId }) => relationId === block.parentRelationId,
      );
      if (
        !query ||
        !relation ||
        relation.sourceEntity.targetId !== query.sourceEntity.targetId ||
        relation.targetEntity.targetId !== entityId ||
        relation.ownership !== 'parentScopedChild' ||
        relation.lifecycle !== 'active' ||
        Boolean(query.legalEntityScope) !== Boolean(header.legalEntityScope) ||
        block.columns.some(
          ({ fieldId }) => !selectedField(definition, query, fieldId),
        ) ||
        !currencyIsBound(
          definition,
          query,
          block.currencyFieldId,
          block.columns.map(({ fieldId }) => fieldId),
        )
      )
        return refusal(
          revisionId,
          'A table needs selected result fields from a declared child list with the same record ownership.',
        );
    }
  }
  return { templates: { revisions, pointers } };
}

function sourceQuery(definition: Definition, id: string, type: 'get' | 'list') {
  const query = definition.queries.find(({ queryId }) => queryId === id);
  return query &&
    query.queryType === type &&
    query.tier === 'q0' &&
    query.lifecycle === 'active' &&
    !query.readModel &&
    query.filter.kind === 'booleanPredicate' &&
    query.filter.value === true &&
    query.parameters.length === (query.legalEntityScope ? 1 : 0)
    ? query
    : undefined;
}

function selectedField(
  definition: Definition,
  query: NonNullable<ReturnType<typeof sourceQuery>>,
  fieldId: string,
) {
  if (!query.selections.some(({ field }) => field.targetId === fieldId)) return;
  return definition.fields.find(
    (field) =>
      field.fieldId === fieldId &&
      field.entity.targetId === query.sourceEntity.targetId &&
      field.lifecycle === 'active' &&
      (field.classification === 'public' ||
        field.classification === 'internal'),
  );
}

function currencyIsBound(
  definition: Definition,
  query: NonNullable<ReturnType<typeof sourceQuery>>,
  currencyFieldId: string | null,
  fields: readonly string[],
) {
  if (currencyFieldId === null)
    return fields.every(
      (id) =>
        selectedField(definition, query, id)?.fieldType.kind !==
        'moneyFieldType',
    );
  return (
    selectedField(definition, query, currencyFieldId)?.fieldType.kind ===
    'textFieldType'
  );
}
