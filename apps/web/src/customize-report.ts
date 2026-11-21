import { ReportChoicesSchema } from '@north-star/canonical-model';
import { draftReport, type ReportTarget } from '@north-star/customization';
import { escapeHtml as h } from './html.js';

const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${h(name)}" value="${h(value)}">`;
const option = (id: string, label: string, selected: boolean) =>
  `<option value="${h(id)}"${selected ? ' selected' : ''}>${h(label)}</option>`;

export function reportEditor(target: ReportTarget, reportId: string | null) {
  const previous = target.reports.find(
    (r) => r.revision.reportId === reportId && r.lifecycle === 'active',
  );
  if (reportId && !previous) throw new Error('Report unavailable.');
  const body = previous?.revision.body;
  const visible = target.reports.filter((r) => r.lifecycle === 'active');
  const existing = visible
    .map(
      (r) =>
        `<a href="/?${h(new URLSearchParams({ customize: '', report: target.source.listSurfaceId, editReport: r.revision.reportId }).toString())}">${h(r.label)}</a>`,
    )
    .join(' ');
  const groups = Array.from(
    { length: 4 },
    (_, i) =>
      `<label>Group ${i + 1}<select name="group${i}">${option('', 'Choose a field', false)}${target.fields.map((f) => option(f.operand.fieldId, f.label, f.operand.fieldId === body?.dimensions[i]?.fieldId)).join('')}</select></label>`,
  ).join('');
  const filters = target.fields
    .map((f) => {
      const selected = body?.filters.find(
        (c) => c.fieldId === f.operand.fieldId,
      )?.kind;
      return `<label>${h(f.label)}<select name="filter:${h(f.operand.fieldId)}">${option('', 'None', !selected)}${option('equals', 'Equals', selected === 'equals')}${f.operand.type === 'choice' ? option('membership', 'One of', selected === 'membership') : ''}${f.operand.basis ? option('dateRange', 'Date range', selected === 'dateRange') : ''}</select></label>`;
    })
    .join('');
  const sums = target.fields.filter(
    (f) => f.operand.currency || f.operand.unitId,
  );
  const chosen = (id: string) =>
    !!body?.measures.some(
      (m) => m.operator.kind === 'sum' && m.operator.fieldId === id,
    );
  const count = !body || body.measures.some((m) => m.operator.kind === 'count');
  return `<h1>${previous ? 'Edit report' : 'Add report'}</h1>${existing && '<nav aria-label="Reports">' + existing + '</nav>'}<form method="post">${hidden('action', 'draft')}${hidden('kind', 'addReportRevision')}${hidden('surface', target.source.listSurfaceId)}${hidden('reportId', reportId ?? '')}${hidden('prior', previous?.revision.revisionId ?? '')}<label>Report name <input name="label" value="${h(previous?.label ?? '')}" required maxlength="240"></label><fieldset><legend>Group by</legend>${groups}</fieldset><fieldset><legend>Measures</legend><label><input type="checkbox" name="count"${count ? ' checked' : ''}>Count records</label>${sums.map((f) => `<label><input type="checkbox" name="sum:${h(f.operand.fieldId)}"${chosen(f.operand.fieldId) ? ' checked' : ''}>Sum ${h(f.label)}</label>`).join('')}</fieldset><details><summary>Filter parameters</summary>${filters}</details><label><input type="checkbox" name="csv"${!body || body.outputs.some((o) => o.kind === 'csv') ? ' checked' : ''}>Allow audited CSV</label><button name="status" value="active">Draft report</button>${previous ? '<button name="status" value="retired">Draft retirement</button>' : ''}</form>`;
}

export function reportSubmission(
  targets: readonly ReportTarget[],
  form: Readonly<Record<string, string>>,
) {
  const target = targets.find((t) => t.source.listSurfaceId === form.surface);
  if (!target) throw new Error('Report source unavailable.');
  const previous = target.reports.find(
    (r) => r.revision.reportId === form.reportId,
  );
  if ((previous?.revision.revisionId ?? '') !== form.prior)
    throw new Error('Reopen the report before editing.');
  const status = form.status === 'retired' ? 'retired' : 'active';
  const id = form.reportId || undefined;
  if (status === 'retired')
    return draftReport(target, form.label ?? '', undefined, id, status);
  const ns = target.source.entityId.split(':')[0]!;
  const dimensions = Array.from({ length: 4 }, (_, i) => form['group' + i])
    .filter(Boolean)
    .map((fieldId) => ({ kind: 'direct', fieldId }));
  const measures = target.fields
    .filter((f) => form['sum:' + f.operand.fieldId])
    .map((f) => ({
      kind: 'inline',
      measureId: f.operand.fieldId.replace(':field.', ':measure.custom_sum_'),
      label: f.label,
      operator: { kind: 'sum', fieldId: f.operand.fieldId },
    }));
  const choices = ReportChoicesSchema.parse({
    dimensions,
    measures: [
      ...(form.count
        ? [
            {
              kind: 'inline',
              measureId: ns + ':measure.custom_count',
              label: 'Count',
              operator: { kind: 'count' },
            },
          ]
        : []),
      ...measures,
    ],
    filters: target.fields
      .filter((f) => form['filter:' + f.operand.fieldId])
      .map((f) => ({
        kind: form['filter:' + f.operand.fieldId],
        fieldId: f.operand.fieldId,
      })),
    outputs: [{ kind: 'table' }, ...(form.csv ? [{ kind: 'csv' }] : [])],
  });
  return draftReport(target, form.label ?? '', choices, id);
}
