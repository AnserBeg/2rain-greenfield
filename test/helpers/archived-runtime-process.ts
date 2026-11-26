import type { DraftOutcome } from '../../packages/postgres-provider/src/customization-service.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

const execute = promisify(execFile);

/** The database an archived probe opens, wherever its input names one. */
function probedDatabase(input: unknown): string | undefined {
  const record = input as {
    databaseUrl?: unknown;
    options?: { databaseUrl?: unknown };
  } | null;
  const url = record?.databaseUrl ?? record?.options?.databaseUrl;
  return typeof url === 'string' ? url : undefined;
}

/**
 * The archived tree's migration files, named and digested as its own loader
 * does (sha256 of the UTF-8 text). Read here rather than imported, so the
 * browser runner's loader never resolves a provider module.
 */
async function archivedMigrations(directory: string) {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return Promise.all(
    names.map(async (name) => ({
      name,
      checksum: createHash('sha256')
        .update(await readFile(join(directory, name), 'utf8'))
        .digest('hex'),
    })),
  );
}

// Ordered by the stored bigint: the text alias would sort 10 before 2. The
// time travels as text, so the restore is exact to the microsecond.
const ledgerQuery = `SELECT m.ordinal::text AS ordinal, m.name, m.checksum, m.applied_at::text AS applied_at
  FROM north_star_internal.schema_migrations m ORDER BY m.ordinal`;
// One presentation at a time per database, held from mask to restore. Not the
// migration lock: the archived migrate() takes that one inside the run.
const presentationLock = 'north-star:archived-ledger-presentation:v1';

interface LedgerRow {
  readonly ordinal: string;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}

/**
 * UPGRADE-2 entry condition (owner ruling, option 1): an archived tree meets
 * the database at its OWN migration level. Its `migrate()` refuses, by name,
 * a ledger that records a migration it has no file for, and that is correct
 * behaviour for a real rollback. A probe of an older binary therefore sees
 * the ledger as it stood at that binary's level: every recorded migration
 * after the archived tree's last file is set aside for the probe and put
 * back, with its ordinal and its applied_at text, and the restore is checked
 * row for row.
 *
 * Exactly the ledger is presented at the older level. The schema still holds
 * the later objects, which is safe only while later migrations are additive to
 * what older code writes; one that alters such an object makes the older
 * binary fail on its own, by name. It is also safe only while nothing but
 * migrate() reads the ledger: the reader proof moves the release pointer in
 * the parent while the ledger is presented. Nothing is set aside when the
 * archived files are not a prefix of the ledger (a renamed or edited
 * migration, or a file the database never applied): the archived `migrate()`
 * then refuses or applies exactly as it would in production.
 *
 * One session holds an advisory lock from mask to restore, so two
 * presentations on one database never interleave. A killed test process
 * never restores, and a failed restore throws rather than retrying; both are
 * harmless because every caller uses its own throwaway container
 * (test/helpers/postgres.ts, withEphemeralPostgres).
 *
 * Any packet that adds a migration passes through here unchanged.
 */
export async function presentLedgerAtArchivedLevel(
  databaseUrl: string,
  migrationDirectory: string,
): Promise<(() => Promise<void>) | undefined> {
  const files = await archivedMigrations(migrationDirectory);
  const holder = new pg.Client({ connectionString: databaseUrl });
  await holder.connect();
  let held = false;
  const release = async () => {
    if (held)
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [
        presentationLock,
      ]);
    await holder.end();
  };
  try {
    const exists = await holder.query<{ present: boolean }>(
      `SELECT to_regclass('north_star_internal.schema_migrations') IS NOT NULL AS present`,
    );
    if (!exists.rows[0]?.present) {
      await release();
      return undefined;
    }
    await holder.query('SELECT pg_advisory_lock(hashtext($1))', [
      presentationLock,
    ]);
    held = true;
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE north_star_internal.schema_migrations');
    const ledger = await holder.query<LedgerRow>(ledgerQuery);
    const prefix =
      ledger.rows.length > files.length &&
      files.every(
        (file, index) =>
          ledger.rows[index]?.name === file.name &&
          ledger.rows[index]?.checksum === file.checksum,
      );
    if (!prefix) {
      await holder.query('ROLLBACK');
      await release();
      return undefined;
    }
    const later = ledger.rows.slice(files.length);
    await holder.query(
      `DELETE FROM north_star_internal.schema_migrations
       WHERE ordinal = ANY($1::bigint[])`,
      [later.map((row) => row.ordinal)],
    );
    await holder.query('COMMIT');
    return async () => {
      try {
        await holder.query('BEGIN');
        for (const row of later)
          await holder.query(
            `INSERT INTO north_star_internal.schema_migrations
               (ordinal, name, checksum, applied_at)
             OVERRIDING SYSTEM VALUE VALUES ($1::bigint, $2, $3, $4::timestamptz)`,
            [row.ordinal, row.name, row.checksum, row.applied_at],
          );
        const after = await holder.query<LedgerRow>(ledgerQuery);
        if (JSON.stringify(after.rows) !== JSON.stringify(ledger.rows))
          throw new Error(
            'The archived probe changed the migration ledger; it is not restored.',
          );
        await holder.query('COMMIT');
      } catch (error) {
        await holder.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        await release();
      }
    };
  } catch (error) {
    await holder.query('ROLLBACK').catch(() => undefined);
    await release().catch(() => undefined);
    throw error;
  }
}
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
      const databaseUrl = probedDatabase(input);
      const restore = databaseUrl
        ? await presentLedgerAtArchivedLevel(
            databaseUrl,
            join(workspace, 'db', 'migrations'),
          )
        : undefined;
      let result;
      try {
        result = await execute(
          process.execPath,
          ['--import', 'tsx', script, data],
          { cwd: workspace, maxBuffer: 64 * 1024 * 1024 },
        );
      } finally {
        await restore?.();
      }
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

export const reportsPredecessor = '5710c05ae2529b742bf15f8f484c75c0b3930180';
// REPORTS-1 slice 2: the serving binary on main immediately before the slice
// merges (main 7eb3a948 after TRAIN-Q, rung 50).
export const reportsAnalysisPredecessor =
  '7eb3a948b83b3d67574c110e8d42ad8ab2920d04';

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
    writeInvariants: [],
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
