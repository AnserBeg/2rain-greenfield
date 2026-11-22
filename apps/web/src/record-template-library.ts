import { randomUUID } from 'node:crypto';
import type { RecordTemplateBinding } from '@north-star/canonical-model';
import {
  RecordTemplateContentSchema,
  type RecordTemplateContent,
} from '../../../packages/canonical-model/src/record-template-content.js';
import type {
  RecordTemplateLibrary,
  RecordTemplateRevision,
  TemplateLibraryTarget,
} from '../../../packages/runtime/src/record-template-library.js';
import type { RequestRuntimeView } from '../../../packages/runtime/src/request-runtime-view.js';
import { escapeHtml as h } from './html.js';

type Form = Readonly<Record<string, string>>;
const hidden = (name: string, value: string | number) =>
  `<input type="hidden" name="${h(name)}" value="${h(String(value))}">`;
const button = (value: string, caption: string) =>
  `<button name="templateAction" value="${value}">${caption}</button>`;
const option = (value: string, label: string, selected: boolean) =>
  `<option value="${h(value)}"${selected ? ' selected' : ''}>${h(label)}</option>`;
const key = () => 'm_' + randomUUID();
function defaults(
  binding: RecordTemplateBinding,
  labels: Map<string, string>,
): RecordTemplateContent {
  return {
    version: 1,
    label: '',
    columns: binding.body.columns.map((c) => ({
      fieldId: c.fieldId,
      caption: labels.get(c.fieldId) ?? c.fieldId,
    })),
    members: [{ key: key(), kind: 'question', caption: '', cells: {} }],
  };
}
function parseForm(
  binding: RecordTemplateBinding,
  f: Form,
): RecordTemplateContent {
  const choices = binding.body.columns
    .flatMap((c, i) =>
      f['include' + i]
        ? [
            {
              fieldId: c.fieldId,
              caption: f['column' + i] ?? '',
              position: Number(f['position' + i]),
            },
          ]
        : [],
    )
    .sort((a, b) => a.position - b.position);
  const members = Array.from(
    { length: Math.min(100, Number(f.count) || 0) },
    (_, i) => {
      const prefix = 'row' + i + '_';
      const cells = Object.fromEntries(
        binding.body.columns.flatMap((col, j) => {
          const v = f[prefix + j];
          return v && choices.some((c) => c.fieldId === col.fieldId)
            ? [
                [
                  col.fieldId,
                  col.fieldType === 'booleanFieldType' &&
                  (v === 'true' || v === 'false')
                    ? v === 'true'
                    : v,
                ],
              ]
            : [];
        }),
      );
      return {
        key: f[prefix + 'key'],
        kind: f[prefix + 'kind'],
        caption: f[prefix + 'caption'],
        cells,
        ...(f[prefix + 'source'] || f[prefix + 'parent']
          ? {
              source: {
                rowId: f[prefix + 'source'],
                parentId: f[prefix + 'parent'],
              },
            }
          : {}),
      };
    },
  );
  return RecordTemplateContentSchema.parse({
    version: 1,
    label: f.label,
    columns: choices.map(({ fieldId, caption }) => ({ fieldId, caption })),
    members,
  });
}
function editor(
  binding: RecordTemplateBinding,
  content: RecordTemplateContent,
  templateId: string,
  predecessor: number,
  labels: Map<string, string>,
) {
  const fields = binding.body.columns.map((c, i) => {
    const index = content.columns.findIndex((v) => v.fieldId === c.fieldId);
    return `<label><input name="include${i}" type="checkbox"${index >= 0 ? ' checked' : ''}>${h(labels.get(c.fieldId) ?? c.fieldId)}</label><label>Caption <input name="column${i}" value="${h(content.columns[index]?.caption ?? labels.get(c.fieldId) ?? '')}" maxlength="120"></label><label>Position <input name="position${i}" type="number" min="1" max="24" value="${index >= 0 ? index + 1 : i + 1}"></label>`;
  });
  const members = content.members.map((m, i) => {
    const prefix = 'row' + i + '_';
    return `<fieldset><legend>Item ${i + 1}</legend>${hidden(prefix + 'key', m.key)}<label>Kind <select name="${prefix}kind">${['question', 'row', 'section', 'instruction', 'member'].map((k) => option(k, k, k === m.kind)).join('')}</select></label><label>Caption <input name="${prefix}caption" value="${h(m.caption)}" required maxlength="500"></label>${binding.body.columns.map((c, j) => (c.copyEligible ? `<label>${h(labels.get(c.fieldId) ?? c.fieldId)} default <input name="${prefix + j}" value="${h(String(m.cells[c.fieldId] ?? ''))}"></label>` : '')).join('')}<details><summary>Copy selected values from a saved row</summary><label>Source record ID <input name="${prefix}parent" value="${h(m.source?.parentId ?? '')}"></label><label>Source line ID <input name="${prefix}source" value="${h(m.source?.rowId ?? '')}"></label></details></fieldset>`;
  });
  return `<form method="post">${hidden('templateId', templateId)}${hidden('predecessor', predecessor)}${hidden('count', members.length)}<label>Template name <input name="label" value="${h(content.label)}" required maxlength="120"></label><fieldset><legend>Columns</legend>${fields.join('')}</fieldset>${members.join('')}${members.length < 100 ? button('append', 'Add item') : ''}${button('review', 'Preview publication')}</form>`;
}
export async function templateLibraryPanel(
  view: RequestRuntimeView,
  library: RecordTemplateLibrary,
  target: TemplateLibraryTarget,
  binding: RecordTemplateBinding,
  labels: Map<string, string>,
  f?: Form,
  draft?: (
    binding: RecordTemplateBinding,
    request: string,
  ) => Promise<RecordTemplateContent>,
) {
  const header = '<section class="panel"><h2>Templates</h2>';
  const history = await library.history(view, target);
  if (f?.templateAction === 'draftContent' && draft) {
    await library.requireAuthor(view, target);
    return (
      header +
      editor(binding, await draft(binding, f.request ?? ''), '', 0, labels) +
      '</section>'
    );
  }
  let feedback = '';
  if (f?.templateAction === 'publish') {
    const published = await library.publish(
      view,
      f.reviewId ?? '',
      f.digest ?? '',
    );
    feedback = `<p role="status">Published revision ${published.number}.</p>`;
  } else if (f?.templateAction === 'assign') {
    const version = await library.assign(
      view,
      target,
      f.context ?? '',
      Number(f.expectedVersion),
      f.revisionId ?? '',
    );
    feedback = `<p role="status">Assigned revision. Assignment version ${version}.</p>`;
  } else if (f?.templateAction === 'retire') {
    await library.retire(view, f.templateId ?? '', Number(f.predecessor));
    feedback = '<p role="status">Retired template.</p>';
  }
  const current = feedback ? await library.history(view, target) : history;
  if (f?.templateAction === 'review' || f?.templateAction === 'append') {
    const content = parseForm(binding, f);
    const id = f.templateId ?? '',
      previous = Number(f.predecessor);
    if (f.templateAction === 'append') {
      if (content.members.length < 100)
        content.members.push({
          key: key(),
          kind: 'row',
          caption: '',
          cells: {},
        });
      return (
        header + editor(binding, content, id, previous, labels) + '</section>'
      );
    }
    const reviewed = await library.review(
      view,
      target,
      id || null,
      previous,
      content,
    );
    return (
      header +
      `<h3>Review ${h(content.label)}</h3><p>Audience: this company’s authorized template readers.</p><ol>${content.members.map((m) => `<li>${h(m.caption)} ${content.columns.map((c) => (Object.hasOwn(m.cells, c.fieldId) ? h(c.caption + ' ' + String(m.cells[c.fieldId])) : '')).join(' ')}</li>`).join('')}</ol><form method="post">${hidden('reviewId', reviewed.reviewId)}${hidden('digest', reviewed.digest)}${button('publish', 'Publish reviewed revision')}</form><details><summary>Edit draft</summary>${editor(binding, content, id, previous, labels)}</details></section>`
    );
  }
  const latest = new Map<string, RecordTemplateRevision>();
  for (const r of current)
    if (!latest.has(r.templateId)) latest.set(r.templateId, r);
  const active = Array.from(latest.values()).filter((r) => !r.retired);
  const chosen =
    f?.templateAction === 'edit'
      ? active.find((r) => r.templateId === f.templateId)
      : undefined;
  const controls = Array.from(latest.values())
    .map(
      (r) =>
        `<li>${h(r.content.label)} · revision ${r.number}${r.retired ? ' · Retired' : `<form method="post">${hidden('templateId', r.templateId)}${hidden('predecessor', r.number)}${button('edit', 'Draft successor')}${button('retire', 'Retire')}</form>`}</li>`,
    )
    .join('');
  const revisions = current.filter((r) => !r.retired);
  const assign = revisions.length
    ? `<form method="post"><label>Published revision <select name="revisionId">${revisions.map((r) => option(r.revisionId, r.content.label + ' · ' + r.number, false)).join('')}</select></label>${binding.body.context.kind === 'wholeType' ? hidden('context', 'wholeType') : '<label>Context ID <input name="context" required></label>'}<label>Current assignment version <input type="number" min="0" name="expectedVersion" value="0" required></label>${button('assign', 'Assign revision')}</form>`
    : '';
  return (
    header +
    (draft
      ? '<form method="post"><label>Describe a template <textarea name="request" required maxlength="4000"></textarea></label>' +
        button('draftContent', 'Draft from description') +
        '</form>'
      : '') +
    feedback +
    '<ul>' +
    controls +
    '</ul>' +
    assign +
    editor(
      binding,
      chosen?.content ?? defaults(binding, labels),
      chosen?.templateId ?? '',
      chosen?.number ?? 0,
      labels,
    ) +
    '</section>'
  );
}
