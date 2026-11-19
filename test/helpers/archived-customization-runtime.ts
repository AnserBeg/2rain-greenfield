import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Runs the serving reader and tenant compiler from an unmodified prior tree. */
export async function withArchivedCustomizationRuntime<T>(
  revision: string,
  work: (
    run: (source: string, input: unknown) => Promise<unknown>,
  ) => Promise<T>,
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
