import { randomUUID } from 'node:crypto';
import type { DocumentTemplateRevision } from '../../../packages/canonical-model/src/document-template-schema.js';
import { slug } from '../../../packages/customization/src/apply.js';
import type {
  DocumentTemplateChoice,
  DocumentTemplateTarget,
} from '../../../packages/customization/src/targets.js';

export const unsupportedTemplateLayout =
  'This template layout cannot be edited in this form.';

export function canReviseTemplateInForm(
  revision: DocumentTemplateRevision,
  target: DocumentTemplateTarget,
): boolean {
  if (revision.layout[0]?.kind !== 'heading') return false;
  const order = { heading: 0, text: 1, field: 2, table: 3 } as const;
  const header = target.queries.find(
    ({ queryId }) => queryId === revision.headerQueryId,
  );
  const hasField = (
    fields: readonly DocumentTemplateChoice[] | undefined,
    fieldId: string,
  ) => fields?.some((field) => field.fieldId === fieldId) === true;
  if (
    !hasField(header?.fields, revision.identityFieldId) ||
    (revision.currencyFieldId &&
      !hasField(header?.fields, revision.currencyFieldId))
  )
    return false;
  return revision.layout.every((block, index) => {
    if (
      index > 0 &&
      (order[block.kind] < order[revision.layout[index - 1]!.kind] ||
        (block.kind !== 'field' &&
          block.kind === revision.layout[index - 1]!.kind))
    )
      return false;
    if (block.kind === 'field') return hasField(header?.fields, block.fieldId);
    if (block.kind !== 'table') return true;
    const table = target.tables.find(
      ({ queryId, relationId }) =>
        queryId === block.queryId && relationId === block.parentRelationId,
    );
    return (
      block.columns.every(({ fieldId }) => hasField(table?.fields, fieldId)) &&
      (!block.currencyFieldId || hasField(table?.fields, block.currencyFieldId))
    );
  });
}

export function templatePatchFromForm(
  form: Readonly<Record<string, string>>,
  target: DocumentTemplateTarget | undefined,
) {
  if (!target) throw new Error('Choose a record type.');
  const previous = target.templates.find(
    ({ revisionId }) => revisionId === form.previousRevisionId,
  );
  if (form.previousRevisionId && !previous)
    throw new Error('The template revision has changed.');
  if (previous && !canReviseTemplateInForm(previous, target))
    throw new Error(unsupportedTemplateLayout);
  const label = (form.label ?? '').trim();
  const [headerQueryId, identityFieldId] = (form.identity ?? '').split('/');
  const header = target.queries.find(
    ({ queryId }) => queryId === headerQueryId,
  );
  if (!header || !identityFieldId)
    throw new Error('Choose the source of the issued number.');
  const selected = (prefix: string) =>
    Array.from({ length: 24 }, (_, i) => form[prefix + i]).filter(
      Boolean,
    ) as string[];
  const findField = (
    choices: readonly DocumentTemplateChoice[],
    fieldId: string | undefined,
  ) => {
    const field = choices.find((entry) => entry.fieldId === fieldId);
    if (!field) throw new Error('Choose a field from the selected source.');
    return { fieldId: field.fieldId, label: field.label };
  };
  const fromHeader = (entry: string) => {
    const [queryId, fieldId] = entry.split('/');
    if (queryId !== headerQueryId)
      throw new Error(
        'The issued number, header fields and currency must use the same record query.',
      );
    return findField(header.fields, fieldId);
  };
  const previousFields = previous?.layout.filter(
    (block) => block.kind === 'field',
  );
  const currentLabel = (
    field: { fieldId: string; label: string },
    prior?: { fieldId: string; label: string },
  ) => (prior?.fieldId === field.fieldId ? prior.label : field.label);
  const layout: DocumentTemplateRevision['layout'] = [
    { kind: 'heading', text: form.heading ?? '' },
    ...(form.body?.trim() ? [{ kind: 'text' as const, text: form.body }] : []),
    ...selected('field_').map((entry, index) => {
      const field = fromHeader(entry);
      return {
        kind: 'field' as const,
        ...field,
        label: currentLabel(field, previousFields?.[index]),
      };
    }),
  ];
  const columns = selected('column_');
  if (columns.length) {
    const [queryId, relationId] = columns[0]!.split('/');
    const table = target.tables.find(
      (entry) => entry.queryId === queryId && entry.relationId === relationId,
    );
    if (!table) throw new Error('Choose a line table.');
    const fromTable = (entry: string) => {
      const [query, relation, fieldId] = entry.split('/');
      if (query !== table.queryId || relation !== table.relationId)
        throw new Error('Choose columns from one line table.');
      return findField(table.fields, fieldId);
    };
    const previousTable = previous?.layout.find(
      (block) => block.kind === 'table',
    );
    layout.push({
      kind: 'table',
      queryId: table.queryId,
      parentRelationId: table.relationId,
      label: form.tableLabel ?? '',
      columns: columns.map((entry, index) => {
        const field = fromTable(entry);
        return {
          ...field,
          label: currentLabel(field, previousTable?.columns[index]),
        };
      }),
      currencyFieldId: form.lineCurrency
        ? fromTable(form.lineCurrency).fieldId
        : null,
    });
  }
  const namespace = target.entityId.split(':')[0]!;
  return {
    kind: 'addDocumentTemplateRevision',
    schemaVersion: 'northstar.document-template-revision/v1',
    templateId:
      previous?.templateId ?? `${namespace}:template.custom_${slug(label)}`,
    revisionId: `${namespace}:revision.custom_${randomUUID()}`,
    previousRevisionId: previous?.revisionId ?? null,
    entityId: target.entityId,
    label,
    documentKind: previous?.documentKind ?? form.documentKind,
    headerQueryId,
    identityFieldId,
    currencyFieldId: form.currencyField
      ? fromHeader(form.currencyField).fieldId
      : null,
    format: {
      locale: form.locale,
      timeZone: form.timeZone,
      currency: form.currency,
      dateStyle: form.dateStyle,
      numberGrouping: form.numberGrouping === 'on',
      pageSize: form.pageSize,
    },
    layout,
    pageNumbers: form.pageNumbers === 'on',
  };
}
