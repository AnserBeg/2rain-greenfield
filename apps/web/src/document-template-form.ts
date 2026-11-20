import { randomUUID } from 'node:crypto';
import type { DocumentTemplateRevision } from '../../../packages/canonical-model/src/document-template-schema.js';
import { slug } from '../../../packages/customization/src/apply.js';
import type {
  DocumentTemplateChoice,
  DocumentTemplateTarget,
} from '../../../packages/customization/src/targets.js';
import { escapeHtml as h } from './html.js';

const kinds = [
  ['quote', 'Quote'],
  ['purchaseOrder', 'Purchase order'],
  ['invoice', 'Invoice'],
  ['workOrder', 'Work order'],
  ['contract', 'Contract'],
] as const;
const locale = [
  ['en-CA', 'English (Canada)'],
  ['fr-CA', 'French (Canada)'],
  ['en-US', 'English (United States)'],
] as const;

export function documentTemplateSelector(
  targets: readonly DocumentTemplateTarget[],
) {
  if (!targets.length) return '';
  return `<form method="get"><fieldset><legend>Document templates</legend>
    <input type="hidden" name="customize" value="1">
    <label>Record type <select name="documentTemplate">${options(targets.map(({ entityId, label }) => [entityId, label]))}</select></label>
    <button>Open templates</button></fieldset></form>`;
}

export function documentTemplateForm(
  target: DocumentTemplateTarget | undefined,
  revisionId: string | null,
): string {
  if (!target)
    return '<h1>Document templates</h1><p>This record type is unavailable.</p><a href="/?customize">Back to Customize</a>';
  const current = target.templates.find(
    (revision) => revision.revisionId === revisionId,
  );
  const baseUrl = new URLSearchParams({
    customize: '1',
    documentTemplate: target.entityId,
  });
  const active = target.templates
    .map((revision) => {
      const revise = new URLSearchParams(baseUrl);
      revise.set('revision', revision.revisionId);
      return `<li>${h(revision.label)} <a href="/?${h(revise.toString())}">Revise</a>
      <form method="post"><input type="hidden" name="action" value="draft">
      <input type="hidden" name="kind" value="retireDocumentTemplate">
      <input type="hidden" name="templateId" value="${h(revision.templateId)}">
      <input type="hidden" name="previousRevisionId" value="${h(revision.revisionId)}">
      <button>Draft retirement</button></form></li>`;
    })
    .join('');
  const identityOptions = target.queries.flatMap((query) =>
    query.fields
      .filter(
        ({ kind }) => kind === 'textFieldType' || kind === 'integerFieldType',
      )
      .map(
        ({ fieldId, label }) =>
          [
            query.queryId + '/' + fieldId,
            label + ' (' + queryTitle(query.queryId) + ')',
          ] as const,
      ),
  );
  const headerOptions = target.queries.flatMap((query) =>
    query.fields.map(
      ({ fieldId, label }) =>
        [
          query.queryId + '/' + fieldId,
          label + ' (' + queryTitle(query.queryId) + ')',
        ] as const,
    ),
  );
  const fields =
    current?.layout.filter((block) => block.kind === 'field') ?? [];
  const fieldSlots = Array.from(
    { length: Math.max(6, fields.length) },
    (_, index) =>
      `<label>Field ${index + 1} <select name="field_${index}"><option value="">Leave empty</option>
      ${options(headerOptions, fields[index] ? current?.headerQueryId + '/' + fields[index].fieldId : undefined)}</select></label>`,
  ).join('');
  const table = current?.layout.find((block) => block.kind === 'table');
  const tableOptions = target.tables.flatMap(
    ({ queryId, relationId, label, fields }) =>
      fields.map(
        ({ fieldId, label: fieldLabel }) =>
          [
            queryId + '/' + relationId + '/' + fieldId,
            label + ' · ' + fieldLabel,
          ] as const,
      ),
  );
  const tableSlots = tableOptions.length
    ? Array.from(
        { length: 6 },
        (_, index) =>
          `<label>Column ${index + 1} <select name="column_${index}"><option value="">Leave empty</option>
      ${options(tableOptions, table?.columns[index] ? [table.queryId, table.parentRelationId, table.columns[index].fieldId].join('/') : undefined)}
    </select></label>`,
      ).join('')
    : '';
  const heading = current?.layout.find((block) => block.kind === 'heading');
  const text = current?.layout.find((block) => block.kind === 'text');
  const logo = current?.branding.logo;
  const logoLink = logo
    ? '/documents?' +
      new URLSearchParams({
        surface: logo.surfaceId,
        record: logo.recordId,
        link: logo.linkId,
        version: logo.versionId,
        ...(logo.companyId ? { company: logo.companyId } : {}),
      })
    : '';
  const value = (value: string | undefined) => h(value ?? '');

  return `<h1>Document templates for ${h(target.label)}</h1>
    ${active ? `<ul>${active}</ul>` : ''}
    <form method="post" data-customize-form="addDocumentTemplateRevision"><fieldset>
    <legend>${current ? 'Revise template' : 'New template'}</legend>
    <input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="addDocumentTemplateRevision">
    <input type="hidden" name="entity" value="${h(target.entityId)}">
    <input type="hidden" name="previousRevisionId" value="${value(current?.revisionId)}">
    <label>Template name <input name="label" required maxlength="80" value="${value(current?.label)}"></label>
    <label>Document kind <select name="documentKind" ${current ? 'disabled' : ''}>${options(kinds, current?.documentKind)}</select></label>
    <label>Issued number <select name="identity" required>${options(identityOptions, current ? current.headerQueryId + '/' + current.identityFieldId : undefined)}</select></label>
    <label>Heading <input name="heading" required maxlength="80" value="${value(heading?.text)}"></label>
    <label>Text <textarea name="body" maxlength="500">${value(text?.text)}</textarea></label>
    ${fieldSlots}
    <label>Currency field <select name="currencyField"><option value="">None</option>${options(headerOptions, current?.currencyFieldId ? current.headerQueryId + '/' + current.currencyFieldId : undefined)}</select></label>
    ${
      tableSlots
        ? `<details><summary>Line table</summary><label>Table heading <input name="tableLabel" maxlength="80" value="${value(table?.label)}"></label>
      ${tableSlots}<label>Line currency field <select name="lineCurrency"><option value="">None</option>
      ${options(tableOptions, table?.currencyFieldId ? [table.queryId, table.parentRelationId, table.currencyFieldId].join('/') : undefined)}</select></label></details>`
        : ''
    }
    <label>Display name <input name="displayName" required maxlength="80" value="${value(current?.branding.displayName)}"></label>
    <label>Ink color <input name="ink" type="color" value="${value(current?.branding.ink)}"></label>
    <label>Accent color <input name="accent" type="color" value="${value(current?.branding.accent)}"></label>
    <label>Logo <input name="logo" maxlength="1000" value="${h(logoLink)}" placeholder="Paste a PNG or JPEG attachment’s preview link"></label>
    <label>Locale <select name="locale">${options(locale, current?.format.locale)}</select></label>
    <label>Time zone <input name="timeZone" required maxlength="64" value="${h(current?.format.timeZone ?? 'UTC')}"></label>
    <label>Currency <select name="currency">${plainOptions(['CAD', 'USD', 'EUR', 'GBP'], current?.format.currency)}</select></label>
    <label>Date format <select name="dateStyle">${plainOptions(['short', 'medium', 'long'], current?.format.dateStyle)}</select></label>
    <label>Page size <select name="pageSize">${plainOptions(['LETTER', 'A4'], current?.format.pageSize)}</select></label>
    <label><input type="checkbox" name="numberGrouping"${current?.format.numberGrouping !== false ? ' checked' : ''}> Group digits</label>
    <label><input type="checkbox" name="pageNumbers"${current?.pageNumbers !== false ? ' checked' : ''}> Page numbers</label>
    <button>Draft template revision</button></fieldset></form><a href="/?customize">Back to Customize</a>`;
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
  const layout: DocumentTemplateRevision['layout'] = [
    { kind: 'heading', text: form.heading ?? '' },
    ...(form.body?.trim() ? [{ kind: 'text' as const, text: form.body }] : []),
    ...selected('field_').map((entry) => ({
      kind: 'field' as const,
      ...fromHeader(entry),
    })),
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
    layout.push({
      kind: 'table',
      queryId: table.queryId,
      parentRelationId: table.relationId,
      label: form.tableLabel ?? '',
      columns: columns.map(fromTable),
      currencyFieldId: form.lineCurrency
        ? fromTable(form.lineCurrency).fieldId
        : null,
    });
  }
  const namespace = target.entityId.split(':')[0]!;
  const logo = form.logo?.trim()
    ? new URL(form.logo, 'https://internal.invalid')
    : null;
  if (logo && logo.pathname !== '/documents')
    throw new Error('Paste a file preview link from the Files section.');
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
    branding: {
      displayName: form.displayName,
      ink: form.ink,
      accent: form.accent,
      logo: logo
        ? {
            surfaceId: logo.searchParams.get('surface'),
            recordId: logo.searchParams.get('record'),
            companyId: logo.searchParams.get('company'),
            linkId: logo.searchParams.get('link'),
            versionId: logo.searchParams.get('version'),
          }
        : null,
    },
    layout,
    pageNumbers: form.pageNumbers === 'on',
  };
}

function queryTitle(id: string) {
  return id.split(':query.')[1]?.replaceAll('_', ' ') ?? id;
}

function plainOptions(
  choices: readonly string[],
  selected: string | undefined,
) {
  return options(
    choices.map((value) => [value, value]),
    selected,
  );
}

function options(
  choices: readonly (readonly [string, string])[],
  selected?: string,
) {
  return choices
    .map(
      ([value, label]) =>
        `<option value="${h(value)}"${value === selected ? ' selected' : ''}>${h(label)}</option>`,
    )
    .join('');
}
