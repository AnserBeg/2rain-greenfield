import type { RegisteredReport } from '../../../packages/canonical-model/src/declared-report.js';
import {
  REPORT_READER_POLICY,
  type ReportRequest,
} from '../../../packages/runtime/src/declared-report.js';

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
