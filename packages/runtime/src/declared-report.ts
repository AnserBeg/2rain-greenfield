import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  canonicalize,
  GROUPED_RESULT_VERSION,
  type GroupedRow,
} from '@north-star/canonical-model';
import type { RegisteredReport } from '../../compiler/src/declared-reports.js';
import type { RequestRuntimeView } from './request-runtime-view.js';

export const REPORT_READER_POLICY = Object.freeze({
  facts: 10_000,
  groups: 500,
  page: 50,
  bytes: 2 * 1024 * 1024,
  statementMs: 2000,
  deadlineMs: 5000,
});
export type ReportLimits = {
  readonly [K in keyof typeof REPORT_READER_POLICY]: number;
};
export type ReportParameter =
  string | readonly string[] | { from: string; until: string };
export interface ReportRequest {
  queryId: string;
  company: string;
  parameters: Readonly<Record<string, ReportParameter>>;
  pageSize: number;
  cursor?: string;
  export?: { resultDigest: string };
}
export interface ReportHorizon {
  readInstant: string;
  businessDate: string;
  zone: string;
  boundary: string;
}
export interface ReportPage {
  kind: 'page';
  schemaVersion: typeof GROUPED_RESULT_VERSION;
  groups: GroupedRow[];
  totals: GroupedRow[];
  next: string | null;
  resultDigest: string;
  horizon: ReportHorizon;
  dimensionTypes: RegisteredReport['columns'][number]['type'][];
  dimensionLabels: string[];
  measureLabels: string[];
}
export type ReportResult =
  | ReportPage
  | { kind: 'unavailable' | 'narrow' | 'refresh' }
  | { kind: 'csv'; bytes: string; receiptId: string };
export interface ReportSnapshot {
  groups: GroupedRow[];
  totals: GroupedRow[];
  facts: number;
  horizon: ReportHorizon;
}
const key = randomBytes(32);
export const reportHash = (v: unknown) =>
  createHash('sha256').update(canonicalize(v)).digest('hex');
const seal = (value: unknown) => {
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return (
    data + '.' + createHmac('sha256', key).update(data).digest('base64url')
  );
};
function unseal(value: string) {
  if (value.length > 32_768) return null;
  const [data, sig, extra] = value.split('.');
  if (!data || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', key).update(data).digest();
  const supplied = Buffer.from(sig, 'base64url');
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return null;
  return JSON.parse(Buffer.from(data, 'base64url').toString()) as {
    binding: string;
    last: string;
    expires: number;
  };
}
export const partitionLabel = (r: GroupedRow) =>
  r.partition.kind === 'currency'
    ? r.partition.code
    : r.partition.kind === 'noCurrency'
      ? 'No currency'
      : '';
export function displayGroupKey(
  report: RegisteredReport,
  i: number,
  value: string | null,
) {
  const field = report.columns.find(
    (c) => c.fieldId === report.revision.body.dimensions[i]?.fieldId,
  );
  return value === null
    ? 'Unspecified'
    : (field?.options?.find((o) => o.id === value)?.label ?? value);
}
function csvCell(value: string, numeric = false) {
  const text =
    !numeric &&
    (/^[=+@-]/u.test(value.trimStart()) ||
      (value.length > 0 && value.charCodeAt(0) < 32))
      ? "'" + value
      : value;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function reportCsv(
  report: RegisteredReport,
  snapshot: ReportSnapshot,
  company: string,
) {
  const { body } = report.revision;
  const labels = body.dimensions.map(
    (d) => report.columns.find((c) => c.fieldId === d.fieldId)!.label,
  );
  const prefix = [
    'Row',
    'Company',
    'Business date',
    'Time zone',
    'Day boundary',
    'Read instant',
  ];
  const header = [
    ...prefix,
    ...labels,
    'Currency',
    ...body.measures.flatMap((m) => [
      m.label,
      'Unit',
      'Records without ' + m.label,
    ]),
  ];
  const row = (kind: string, r: GroupedRow) => {
    const context = [
      kind,
      company,
      snapshot.horizon.businessDate,
      snapshot.horizon.zone,
      snapshot.horizon.boundary,
      snapshot.horizon.readInstant,
    ];
    const keys = body.dimensions.map((_, i) =>
      kind === 'Total' ? '' : displayGroupKey(report, i, r.keys[i] ?? null),
    );
    return [
      ...[...context, ...keys, partitionLabel(r)].map((v) => csvCell(v)),
      ...r.cells.flatMap((c) => [
        csvCell(c.value, true),
        csvCell(c.unitId ?? ''),
        csvCell(String(c.recordsWithoutMeasure), true),
      ]),
    ].join(',');
  };
  return (
    [
      header.map((v) => csvCell(v)).join(','),
      ...snapshot.groups.map((r) => row('Group', r)),
      ...snapshot.totals.map((r) => row('Total', r)),
    ].join('\r\n') + '\r\n'
  );
}
export function reportPage(
  view: RequestRuntimeView,
  report: RegisteredReport,
  req: ReportRequest,
  snapshot: ReportSnapshot,
  limits: ReportLimits,
): ReportPage | { kind: 'narrow' | 'refresh' } {
  const dimensionLabels = report.revision.body.dimensions.map(
    (d) => report.columns.find((c) => c.fieldId === d.fieldId)!.label,
  );
  const dimensionTypes = report.revision.body.dimensions.map((d) => {
    const field = report.columns.find((c) => c.fieldId === d.fieldId)!;
    return field.basis === 'civilDate' ? 'date' : field.type;
  });
  const measureLabels = report.revision.body.measures.map((m) => m.label);
  const result = {
    groups: snapshot.groups,
    totals: snapshot.totals,
    dimensionLabels,
    dimensionTypes,
    measureLabels,
  };
  if (
    snapshot.groups.length > limits.groups ||
    Buffer.byteLength(JSON.stringify(result)) > limits.bytes
  )
    return { kind: 'narrow' };
  const resultDigest = reportHash({
    ...result,
    labels: report.columns.map((c) => c.options ?? null),
  });
  const binding = reportHash([
    view.principalId,
    view.tenantId,
    view.environmentId,
    req.company,
    view.release.releaseId,
    view.pointer.fence,
    view.entryPolicyVersion,
    report.queryId,
    report.revision.revisionId,
    req.parameters,
    snapshot.horizon.businessDate,
    snapshot.horizon.zone,
    snapshot.horizon.boundary,
    resultDigest,
  ]);
  if (req.export && req.export.resultDigest !== binding)
    return { kind: 'refresh' };
  const rowKey = (r: GroupedRow) => canonicalize([r.partition, r.keys]);
  let start = 0;
  const now = Date.parse(snapshot.horizon.readInstant);
  if (req.cursor) {
    const token = unseal(req.cursor);
    if (!token || now >= token.expires || token.binding !== binding)
      return { kind: 'refresh' };
    const index = snapshot.groups.findIndex((r) => rowKey(r) === token.last);
    if (index < 0) return { kind: 'refresh' };
    start = index + 1;
  }
  const groups = snapshot.groups.slice(start, start + req.pageSize);
  const next =
    start + groups.length < snapshot.groups.length
      ? seal({ binding, last: rowKey(groups.at(-1)!), expires: now + 900_000 })
      : null;
  return {
    kind: 'page',
    schemaVersion: GROUPED_RESULT_VERSION,
    groups,
    totals: snapshot.totals,
    next,
    resultDigest: binding,
    horizon: snapshot.horizon,
    dimensionLabels,
    dimensionTypes,
    measureLabels,
  };
}

export function validReportParameters(
  report: RegisteredReport,
  req: ReportRequest,
) {
  const declarations = report.revision.body.filters;
  if (
    !req.parameters ||
    typeof req.parameters !== 'object' ||
    Array.isArray(req.parameters)
  )
    return false;
  const date = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\d$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  return Object.entries(req.parameters).every(([id, value]) => {
    const filter = declarations.find((f) => f.fieldId === id);
    const field = report.columns.find((f) => f.fieldId === id);
    if (!field || !filter) return false;
    if (filter.kind === 'dateRange')
      return (
        !!value &&
        typeof value === 'object' &&
        'from' in value &&
        'until' in value &&
        Object.keys(value).length === 2 &&
        date(value.from) &&
        date(value.until) &&
        value.from < value.until
      );
    if (filter.kind === 'membership')
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 32 &&
        value.every((v) => field.options?.some((o) => o.id === v))
      );
    if (
      typeof value !== 'string' ||
      value.length > Math.min(field.maximumLength ?? 512, 512)
    )
      return false;
    switch (field.type) {
      case 'choice':
        return !!field.options?.some((o) => o.id === value);
      case 'boolean':
        return ['true', 'false'].includes(value);
      case 'integer':
        return /^-?(0|[1-9]\d{0,17})$/u.test(value);
      case 'quantity':
      case 'decimal':
        return /^-?(0|[1-9]\d{0,37})(\.\d{1,18})?$/u.test(value);
      case 'date':
        return date(value);
      case 'instant':
        return (
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value) &&
          Number.isFinite(Date.parse(value))
        );
      default:
        return true;
    }
  });
}
