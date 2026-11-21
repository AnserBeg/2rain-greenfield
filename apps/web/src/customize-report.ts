import { ReportChoicesSchema } from '@north-star/canonical-model';
import { draftReport, type ReportTarget } from '@north-star/customization';

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
