import {
  DEFAULT_AGE_BANDS,
  ReportChoicesSchema,
  ReportDimensionSchema,
  ReportOperatorSchema,
  canonicalize,
  type ReportAgeBand,
  type ReportDimension,
  type ReportOperator,
} from '@north-star/canonical-model';
import {
  draftMeasure,
  draftReport,
  type ReportTarget,
} from '@north-star/customization';

type Field = ReportTarget['fields'][number];
const local = (id: string) => id.split(':')[1]!.replace(/[^a-z0-9]+/gu, '_');
export const allFields = (t: ReportTarget): Field[] => [
  ...t.fields,
  ...t.links.flatMap((l) => l.fields),
];
const numeric = (f: Field) =>
  ['decimal', 'integer', 'quantity'].includes(f.operand.type);
export const at = (f: Field) =>
  f.operand.via
    ? { fieldId: f.operand.fieldId, via: f.operand.via }
    : { fieldId: f.operand.fieldId };

/** Author-declared bands from edges such as "30,60,90": not yet due, then
 * 0–30, 31–60, 61–90 and 91+, each day in exactly one band. */
export function ageBandsFromEdges(edges: string): ReportAgeBand[] {
  const cuts = edges
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map(Number);
  if (!cuts.length) return [...DEFAULT_AGE_BANDS];
  if (
    cuts.some(
      (c, i) =>
        !Number.isSafeInteger(c) || c < 0 || (i > 0 && c <= cuts[i - 1]!),
    )
  )
    throw new Error('Age edges are increasing whole days, such as 30,60,90.');
  const bands: ReportAgeBand[] = [
    { bandId: 'not_due', label: 'Not yet due', from: null, through: -1 },
  ];
  let from = 0;
  for (const c of cuts) {
    bands.push({
      bandId: `d${from}_${c}`,
      label: `${from}–${c}`,
      from,
      through: c,
    });
    from = c + 1;
  }
  bands.push({ bandId: `d${from}`, label: `${from}+`, from, through: null });
  return bands;
}

/** Every dimension the source offers, as the exact choice it submits. */
export function dimensionChoices(t: ReportTarget, edges: string) {
  return allFields(t).flatMap((f) => {
    const base = at(f);
    const direct = { label: f.label, value: { kind: 'direct', ...base } };
    if (!f.operand.basis) return [direct];
    return [
      direct,
      ...(['day', 'week', 'month'] as const).map((unit) => ({
        label: `${f.label} by ${unit}`,
        value: { kind: 'calendar', ...base, unit },
      })),
      {
        label: `${f.label} age`,
        value: {
          kind: 'age',
          ...base,
          bands: ageBandsFromEdges(edges),
          absentLabel: 'No ' + f.label.toLowerCase(),
        },
      },
    ];
  });
}

/** Every measure the source offers. Fields of another record are offered only
 * as distinct counts: measuring them here would repeat them once per row. */
export function measureChoices(t: ReportTarget) {
  const ns = t.source.entityId.split(':')[0]!;
  const inline = (
    measureId: string,
    label: string,
    operator: ReportOperator,
    shown = label,
  ) => ({
    label: shown,
    value: { kind: 'inline', measureId, label, operator } as Record<
      string,
      unknown
    >,
  });
  const out = [
    inline(
      ns + ':measure.custom_count',
      'Count',
      { kind: 'count' },
      t.grain === 'line' ? 'Count lines' : 'Count records',
    ),
  ];
  for (const f of t.fields) {
    const id = (op: string) =>
      f.operand.fieldId.replace(':field.', `:measure.custom_${op}_`);
    const field = { fieldId: f.operand.fieldId };
    if (f.operand.currency || f.operand.type === 'quantity')
      out.push(
        inline(id('sum'), f.label, { kind: 'sum', ...field }, 'Sum ' + f.label),
      );
    if (numeric(f))
      out.push(
        inline(id('average'), 'Average ' + f.label, {
          kind: 'average',
          ...field,
        }),
      );
    if (
      numeric(f) ||
      f.operand.type === 'date' ||
      f.operand.basis === 'civilDate'
    )
      for (const op of ['min', 'max'] as const)
        out.push(
          inline(id(op), `${op === 'min' ? 'Minimum' : 'Maximum'} ${f.label}`, {
            kind: op,
            ...field,
          }),
        );
  }
  for (const f of allFields(t))
    out.push(
      inline(
        f.operand.fieldId.replace(':field.', ':measure.custom_distinct_') +
          (f.operand.via ? '_via_' + local(f.operand.via.join('_')) : ''),
        'Distinct ' + f.label,
        { kind: 'distinctCount', ...at(f) },
      ),
    );
  for (const l of t.links)
    out.push(
      inline(
        ns + ':measure.custom_distinct_' + local(l.link.via.join('_')),
        'Distinct ' + l.label,
        { kind: 'distinctTargets', via: l.link.via },
      ),
    );
  return [
    ...out,
    ...t.measures.map((m) => ({
      label: m.label + ' (approved measure)',
      value: {
        kind: 'approved',
        measureId: m.measureId,
        contractDigest: m.contractDigest,
      } as Record<string, unknown>,
    })),
  ];
}
export const same = (a: unknown, b: unknown) =>
  canonicalize(a) === canonicalize(b);
export const pick = <T extends { value: Record<string, unknown> }>(
  choices: T[],
  chosen: unknown,
) => {
  const unlabelled = (v: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'label'));
  const wanted = unlabelled(chosen as Record<string, unknown>);
  return choices.find((c) => same(unlabelled(c.value), wanted));
};

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
  const edges = form.ageEdges ?? '';
  // Slice-1 forms named a field directly; slice-2 forms submit the choice.
  const dimension = (v: string): ReportDimension => {
    if (!v.startsWith('{'))
      return { kind: 'direct', fieldId: v } as ReportDimension;
    const d = ReportDimensionSchema.parse(JSON.parse(v));
    return d.kind === 'age' ? { ...d, bands: ageBandsFromEdges(edges) } : d;
  };
  const dimensions = Array.from({ length: 4 }, (_, i) => form['group' + i])
    .filter((v): v is string => !!v)
    .map(dimension);
  const offered = measureChoices(target);
  const measures = Object.entries(form)
    .filter(([k]) => /^measure\d+$/u.test(k))
    .map(([, v]) => {
      const m = pick(offered, JSON.parse(v));
      if (!m) throw new Error('Choose an offered measure.');
      return m.value;
    });
  // Slice-1 forms: a count checkbox and one sum checkbox per field.
  if (form.count) measures.unshift(offered[0]!.value);
  for (const f of target.fields)
    if (form['sum:' + f.operand.fieldId]) {
      const sum = pick(offered, {
        kind: 'inline',
        measureId: f.operand.fieldId.replace(':field.', ':measure.custom_sum_'),
        operator: { kind: 'sum', fieldId: f.operand.fieldId },
      });
      if (sum) measures.push(sum.value);
    }
  const filter = (key: string) =>
    key.startsWith('{') ? JSON.parse(key) : { fieldId: key };
  const choices = ReportChoicesSchema.parse({
    ...(target.grain === 'line' && { grain: 'line' }),
    dimensions,
    measures,
    filters: Object.entries(form)
      .filter(([k, v]) => k.startsWith('filter:') && v)
      .map(([k, kind]) => ({ kind, ...filter(k.slice('filter:'.length)) })),
    outputs: [{ kind: 'table' }, ...(form.csv ? [{ kind: 'csv' }] : [])],
  });
  return draftReport(target, form.label ?? '', choices, id);
}

export function measureSubmission(
  targets: readonly ReportTarget[],
  form: Readonly<Record<string, string>>,
) {
  const target = targets.find((t) => t.source.listSurfaceId === form.surface);
  if (!target) throw new Error('Report source unavailable.');
  const previous = target.namedMeasures.find(
    (m) => m.revision.measureId === form.measureId,
  );
  if ((previous?.revision.revisionId ?? '') !== (form.prior ?? ''))
    throw new Error('Reopen the measure before approving it.');
  const status =
    form.status === 'approved' || form.status === 'retired'
      ? form.status
      : 'trial';
  return draftMeasure(
    target,
    form.label ?? '',
    status,
    status === 'trial'
      ? ReportOperatorSchema.parse(JSON.parse(form.operator ?? '{}'))
      : undefined,
    form.measureId || undefined,
  );
}
