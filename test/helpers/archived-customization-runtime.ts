import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  canonicalize,
  parseNormalizedApplicationPackageJson,
} from '../../packages/canonical-model/src/index.js';
import {
  compileInSandbox,
  parseCustomizationPatch,
  parseSerializedRelease,
} from '../../packages/customization/src/index.js';

const execute = promisify(execFile);
type ArchivedRunner = (source: string, input: unknown) => Promise<unknown>;

export async function assertArchivedTenantEnvelope(run: ArchivedRunner) {
  const patch = parseCustomizationPatch({
    kind: 'addField',
    entity: 'northstar.app:entity.item',
    field: { label: 'Inspection notes', type: 'text' },
  });
  assert.ok(patch.status === 'parsed');
  // The historical runner supplies both compilers with the same base, policy,
  // and parent bytes independently of changes to the current lineage.
  const { request, release: historical } = (await run(
    `
import { readFile } from 'node:fs/promises';
import { readUnboundPermissionAcknowledgementFor } from './apps/web/scripts/unbound-permission-acknowledgement.ts';
import { parseCompiledApplication } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { compileInSandbox } from './packages/customization/src/sandbox.ts';
import { serializeRelease } from './packages/customization/src/release-envelope.ts';
const path = 'apps/web/release/app.authored.json';
const compiled = parseCompiledApplication(JSON.parse(await readFile('apps/web/release/app.compiled.json', 'utf8')));
const request = {
  acknowledgement: readUnboundPermissionAcknowledgementFor(path, 'northstar.app:package.application'),
  base: JSON.parse(await readFile(path, 'utf8')),
  chain: [JSON.parse(await readFile(process.argv[2], 'utf8'))],
  tip: serializeRelease(compiled.applications.at(-1) ?? compiled.bootstrap),
};
const result = await compileInSandbox(request);
if (result.status !== 'compiled') throw new Error(JSON.stringify(result));
console.log(JSON.stringify({ request, release: result.steps[0].release }));
`,
    patch.patch,
  )) as {
    request: Parameters<typeof compileInSandbox>[0];
    release: unknown;
  };
  const current = await compileInSandbox(request);
  assert.ok(current.status === 'compiled', JSON.stringify(current));
  const envelope = current.steps[0]?.release;
  assert.ok(envelope);
  const compiled = parseSerializedRelease(envelope);
  assert.equal(
    parseNormalizedApplicationPackageJson(compiled.normalizedDefinitionBytes)
      .package.provenance,
    'tenantAuthored',
  );
  assert.equal(
    canonicalize(envelope),
    canonicalize(historical),
    'both tenant runners reproduce the entire v6 envelope with formula declarations absent',
  );
}

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
