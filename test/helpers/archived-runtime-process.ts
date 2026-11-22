import type { DraftOutcome } from '../../packages/postgres-provider/src/customization-service.js';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export type ArchivedRunner = (
  source: string,
  input: unknown,
) => Promise<unknown>;

export function archivedRuntimeRead(
  run: ArchivedRunner,
  input: { readonly databaseUrl: string; readonly identity: unknown },
): Promise<{ outcome: string; code?: string; message?: string }> {
  return run(archivedServingRead, input) as Promise<{
    outcome: string;
    code?: string;
    message?: string;
  }>;
}

/** Runs the serving reader and tenant compiler from an unmodified prior tree. */
export async function withArchivedCustomizationRuntime<T>(
  revision: string,
  work: (run: ArchivedRunner) => Promise<T>,
  // Edits the extracted tree before install, for a reader build that no
  // commit ever carried (a capability cap below the revision's own).
  prepare?: (workspace: string) => Promise<void>,
): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), 'north-star-old-reader-'));
  const workspace = join(temporary, 'workspace');
  try {
    await mkdir(workspace);
    const archive = join(temporary, 'reader.tar');
    const commit = await execute('git', ['archive', '--format=tar', revision], {
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
    });
    await writeFile(archive, commit.stdout);
    await execute('tar', ['-xf', archive, '-C', workspace]);
    await prepare?.(workspace);
    const install = [
      'pnpm',
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
    ];
    try {
      await execute('corepack', [...install, '--offline'], { cwd: workspace });
    } catch {
      await execute('corepack', install, { cwd: workspace });
    }
    return await work(async (source, input) => {
      const script = join(workspace, 'customization-probe.mts');
      const data = join(temporary, 'input.json');
      await Promise.all([
        writeFile(script, source, 'utf8'),
        writeFile(data, JSON.stringify(input), 'utf8'),
      ]);
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', script, data],
        { cwd: workspace, maxBuffer: 64 * 1024 * 1024 },
      );
      return JSON.parse(result.stdout) as unknown;
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Invoke the previous release loader using its own policy on supported readers. */
export const archivedServingRead = `
import { readFile } from 'node:fs/promises';
import { rolePool, trustedContext } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { PostgresRequestRuntimeViewService } from './packages/postgres-provider/src/request-runtime-view-service.ts';
const { databaseUrl, identity } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const pool = rolePool(databaseUrl, 'north_star_runtime', 1);
try {
  const view = await new PostgresRequestRuntimeViewService(pool).load(await trustedContext(identity));
  console.log(JSON.stringify({ outcome: 'loaded', root: view.release.contentHash }));
} catch (error) {
  console.log(JSON.stringify({ outcome: 'refused', code: error.code, message: error.message }));
} finally {
  await pool.end();
}
`;

export const reportsPredecessor = '7046abc74feacc8943874f1ced6d4674ddcb7548';

// Produce genuine pre-index change sets for witnesses isolating earlier reader floors.
export async function draftBeforeCompanyAccessIndex(
  options: {
    databaseUrl: string;
    tenantSlug: string;
    compiledApplication: unknown;
  },
  patch: unknown,
  channel: 'declarativeEditor' | 'visualBuilder',
  request?: string,
): Promise<DraftOutcome> {
  return withArchivedCustomizationRuntime(
    reportsPredecessor,
    async (run) =>
      (await run(
        `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { openCustomizeService } from './apps/api/src/composition-root.ts';
      import { DRAFT_CUSTOMIZATION_TOOL } from './packages/customization/src/ai-draft.ts';
      import { scriptedModel } from './packages/operations-agent/src/model.ts';
      const { options, patch, channel, request } = JSON.parse(await readFile(process.argv[2], 'utf8'));
      const opened = await openCustomizeService({
        ...options,
        draftingProvider: async () => scriptedModel([(conversation) => {
          assert.deepEqual(conversation, [{ role: 'user', text: request }]);
          return { toolCalls: [{ name: DRAFT_CUSTOMIZATION_TOOL, input: patch }] };
        }]),
      });
      try {
        const draft = request
          ? await opened.service.draftFromRequest(request)
          : await opened.service.draft(patch, channel);
        console.log(JSON.stringify(draft));
      } finally { await opened.close(); }
    `,
        { options, patch, channel, request },
      )) as DraftOutcome,
  );
}
/**
 * The previous serving binary's request path with one query issued: it loads
 * the request view (where capability refusals happen), then resolves a query
 * from the pinned catalog, which parses that whole catalog. "loaded" alone is
 * not proof that a reader can serve a release, because catalogs parse lazily.
 */
export const archivedServingQuery = `
import { readFile } from 'node:fs/promises';
import { rolePool, trustedContext } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { PostgresRequestRuntimeViewService } from './packages/postgres-provider/src/request-runtime-view-service.ts';
import { registeredSemanticQueryFromPinnedView } from './packages/runtime/src/semantic-query-gateway.ts';
const { databaseUrl, identity, queryId } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const pool = rolePool(databaseUrl, 'north_star_runtime', 1);
let stage = 'load';
try {
  const view = await new PostgresRequestRuntimeViewService(pool).load(await trustedContext(identity));
  stage = 'query';
  const query = registeredSemanticQueryFromPinnedView(view, queryId);
  console.log(JSON.stringify({ outcome: 'served', root: view.release.contentHash, queryId: query.queryId }));
} catch (error) {
  console.log(JSON.stringify({ outcome: 'refused', stage, code: error.code ?? error.name, message: error.message }));
} finally {
  await pool.end();
}
`;

/** Use the archived loader and its governed query gateway on persisted releases. */
export const archivedStockCountQuery = `
import { readFile } from 'node:fs/promises';
import { ObservabilityMetrics } from './packages/observability/src/index.ts';
import { rolePool, trustedContext } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { PostgresRequestRuntimeViewService } from './packages/postgres-provider/src/request-runtime-view-service.ts';
import { composeServingGateways, loadServingRelease } from './packages/postgres-provider/src/serving-gateways.ts';
import { AuthenticatedRequestRuntimeEntryAdapter } from './packages/runtime/src/request-runtime-view.ts';
import { AuthenticatedRequestEntryAdapter } from './packages/runtime/src/request-context.ts';
import { SEMANTIC_QUERY_REQUEST_VERSION } from './packages/runtime/src/semantic-query-gateway.ts';
const { databaseUrl, identity, queryId, args } = JSON.parse(await readFile(process.argv[2], 'utf8'));
const pool = rolePool(databaseUrl, 'north_star_runtime', 2);
try {
  const service = new PostgresRequestRuntimeViewService(pool);
  const context = await trustedContext(identity);
  const active = await service.load(context);
  const serving = await loadServingRelease(pool, context, active.release.releaseId);
  const gates = composeServingGateways(pool, pool, context, serving, new ObservabilityMetrics(), {
    providerErrorMappings: [],
  });
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    service,
    gates.policy,
  );
  const result = await entry.run({ headers: {} }, (view) => gates.queryGateway.invoke(view, {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId,
    arguments: args,
  }));
  console.log(JSON.stringify({ outcome: 'queried', root: active.release.contentHash, records: result.records }));
} catch (error) {
  console.log(JSON.stringify({ outcome: 'refused', code: error.code, message: error.message }));
} finally {
  await pool.end();
}
`;
