import type { PoolClient } from 'pg';
import type { StorageTransitionElement } from '@north-star/compiler';
import type { RegisteredReport } from '../../compiler/src/declared-reports.js';
import { reportIndexReady } from './grouped-report.js';

type AccessPath = RegisteredReport['accessPath'];
const maximumRows = 10_000;

/** Deploy policy. A pooled table counts once across all tenants. */
export async function reportIndexCeilingProblem(
  client: PoolClient,
  path: AccessPath,
  subject: string,
): Promise<string | null> {
  const configured = process.env.NORTH_STAR_REPORT_INDEX_ROW_CEILING;
  const ceiling = configured === undefined ? maximumRows : Number(configured);
  const name = subject + ' (' + path.keys.join(', ') + ')';
  if (!Number.isSafeInteger(ceiling) || ceiling < 0 || ceiling > maximumRows)
    return 'Invalid locking index row ceiling for ' + name;
  try {
    const { rows } = await client.query<{ exceeds: boolean }>(
      'SELECT north_star_internal.module_table_exceeds($1, $2) AS exceeds',
      [path.table, ceiling],
    );
    return rows[0]?.exceeds === false
      ? null
      : name +
          ' exceeds the locking index ceiling of ' +
          ceiling +
          ' rows and requires an online build.';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === '42883')
      return 'The pooled-table size probe is unavailable for ' + name;
    throw error;
  }
}

export async function previewReportIndexes(
  client: PoolClient,
  reports: readonly RegisteredReport[],
  elements: readonly StorageTransitionElement[],
): Promise<string | null> {
  for (const report of reports) {
    const path = report.accessPath;
    if (await reportIndexReady(client, path.table, path.index, path.keys))
      continue;
    const planned = elements.find(
      (e) => e.kind === 'createIndex' && e.physicalObjectName === path.index,
    );
    if (!planned)
      return report.label + ' needs a ready index on ' + path.keys.join(', ');
    if (planned.classification.preparationValidity !== 'deferredOnlineFamily')
      continue;
    const problem = await reportIndexCeilingProblem(client, path, report.label);
    if (problem) return problem;
  }
  return null;
}
