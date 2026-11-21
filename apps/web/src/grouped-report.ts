import type { RegisteredReport } from '../../../packages/compiler/src/declared-reports.js';
import {
  displayGroupKey,
  partitionLabel,
  REPORT_READER_POLICY,
  type ReportRequest,
  type ReportResult,
} from '../../../packages/runtime/src/declared-report.js';
import type { GroupedRow } from '@north-star/canonical-model';
import { escapeHtml as h } from './html.js';

export function reportRequest(
  report: RegisteredReport,
  url: URL,
  company: string,
): ReportRequest {
  const parameters: Record<string, ReportRequest['parameters'][string]> = {};
  for (const filter of report.revision.body.filters) {
    const id = filter.fieldId;
    if (filter.kind === 'dateRange') {
      const from = url.searchParams.get(id + '.from') ?? '';
      const until = url.searchParams.get(id + '.until') ?? '';
      if (from || until) parameters[id] = { from, until };
    } else {
      const values = url.searchParams.getAll(id).filter((v) => v !== '');
      if (values.length)
        parameters[id] =
          filter.kind === 'membership'
            ? values
            : values.length === 1
              ? values[0]!
              : values;
    }
  }
  return {
    company,
    queryId: report.queryId,
    parameters,
    pageSize: Number(
      url.searchParams.get('pageSize') ?? REPORT_READER_POLICY.page,
    ),
    ...(url.searchParams.has('after') && {
      cursor: url.searchParams.get('after')!,
    }),
    ...(url.searchParams.get('export') === 'csv' && {
      export: { resultDigest: url.searchParams.get('result') ?? '' },
    }),
  };
}

export function groupedReportHtml(
  report: RegisteredReport,
  url: URL,
  company: string,
  answer: Exclude<ReportResult, { kind: 'csv' }>,
  canExport: boolean,
) {
  const base = new URLSearchParams(url.search);
  for (const key of ['after', 'export', 'result']) base.delete(key);
  const href = (params: URLSearchParams) => '/?' + h(params.toString());
  const filters = report.revision.body.filters.map((f) => {
    const field = report.columns.find((c) => c.fieldId === f.fieldId)!;
    const input = (id: string, label: string, type: string) =>
      '<label>' +
      h(label) +
      ' <input type="' +
      type +
      '" name="' +
      h(id) +
      '" value="' +
      h(base.get(id) ?? '') +
      '"></label>';
    if (f.kind === 'dateRange')
      return (
        '<fieldset><legend>' +
        h(field.label) +
        '</legend>' +
        input(f.fieldId + '.from', 'From', 'date') +
        input(f.fieldId + '.until', 'Before', 'date') +
        '</fieldset>'
      );
    if (field.options)
      return (
        '<label>' +
        h(field.label) +
        ' <select name="' +
        h(f.fieldId) +
        '"' +
        (f.kind === 'membership' ? ' multiple' : '') +
        '><option value="">All</option>' +
        field.options
          .map(
            (o) =>
              '<option value="' +
              h(o.id) +
              '"' +
              (base.getAll(f.fieldId).includes(o.id) ? ' selected' : '') +
              '>' +
              h(o.label) +
              '</option>',
          )
          .join('') +
        '</select></label>'
      );
    return input(f.fieldId, field.label, 'text');
  });
  const filterFields = new Set(
    report.revision.body.filters.flatMap((f) => [
      f.fieldId,
      f.fieldId + '.from',
      f.fieldId + '.until',
    ]),
  );
  const hidden = [...base]
    .filter(([k]) => !filterFields.has(k))
    .map(
      ([k, v]) =>
        '<input type="hidden" name="' + h(k) + '" value="' + h(v) + '">',
    )
    .join('');
  const form = filters.length
    ? '<form method="get">' +
      hidden +
      filters.join('') +
      '<button>Apply filters</button></form>'
    : '';
  if (answer.kind !== 'page') {
    const text =
      answer.kind === 'refresh'
        ? 'Results changed. Refresh the report.'
        : answer.kind === 'narrow'
          ? 'Narrow the filter'
          : 'View not available';
    return (
      form +
      '<p role="status">' +
      text +
      '</p>' +
      (answer.kind === 'refresh'
        ? '<a href="' + href(base) + '">Refresh report</a>'
        : '')
    );
  }
  const isMoney = report.columns.some((c) => c.currency);
  const headings = [
    ...answer.dimensionLabels,
    ...(isMoney ? ['Currency'] : []),
    ...answer.measureLabels,
  ];
  const cell = (label: string, text: string) =>
    '<td data-label="' + h(label) + '">' + h(text) + '</td>';
  const row = (r: GroupedRow, total: boolean) =>
    '<tr>' +
    answer.dimensionLabels
      .map((label, i) =>
        cell(
          label,
          total
            ? i === 0
              ? 'All groups'
              : ''
            : displayGroupKey(report, i, r.keys[i] ?? null),
        ),
      )
      .join('') +
    (isMoney ? cell('Currency', partitionLabel(r)) : '') +
    r.cells
      .map((c, i) => {
        const m = report.revision.body.measures[i]!;
        const coverage =
          m.operator.kind === 'sum'
            ? ' <small>' +
              c.recordsWithoutMeasure +
              (c.recordsWithoutMeasure === 1
                ? ' record without '
                : ' records without ') +
              h(m.label) +
              '</small>'
            : '';
        return (
          '<td data-label="' +
          h(m.label) +
          '">' +
          h(c.value) +
          (c.unitId ? ' ' + h(c.unitId) : '') +
          coverage +
          '</td>'
        );
      })
      .join('') +
    '</tr>';
  const table =
    '<table class="grouped-report-table"><caption>' +
    h(report.label) +
    '</caption><thead><tr>' +
    headings.map((label) => '<th scope="col">' + h(label) + '</th>').join('') +
    '</tr></thead><tbody>' +
    answer.groups.map((r) => row(r, false)).join('') +
    '</tbody><tfoot>' +
    answer.totals.map((r) => row(r, true)).join('') +
    '</tfoot></table>';
  const next = new URLSearchParams(base);
  if (answer.next) next.set('after', answer.next);
  const csv = new URLSearchParams(base);
  csv.set('export', 'csv');
  csv.set('result', answer.resultDigest);
  return (
    form +
    '<p>Company ' +
    h(company) +
    ' · Business date ' +
    h(answer.horizon.businessDate) +
    ' · ' +
    h(answer.horizon.zone) +
    ' at ' +
    h(answer.horizon.boundary) +
    ' · Read at ' +
    h(answer.horizon.readInstant) +
    '</p>' +
    table +
    (answer.groups.length ? '' : '<p>No matching records</p>') +
    (answer.next
      ? '<a rel="next" href="' + href(next) + '">Next page</a>'
      : '') +
    (canExport ? ' <a download href="' + href(csv) + '">Export CSV</a>' : '')
  );
}
