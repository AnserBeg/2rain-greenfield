import assert from 'node:assert/strict';
import { resolve as resolvePath } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// SPEED-1 slice 6: the compiled start's resolve hook sends a workspace module
// that resolves to TypeScript to its compiled twin under dist/, looks up a
// bare package from a compiled module where the workspace's node_modules
// are, and leaves everything else alone.

const root = pathToFileURL(`${resolvePath('.')}/`).href;
const dist = `${root}dist/`;

test('SPEED-1 compiled start: workspace TypeScript resolves to dist; third-party and builtins do not', async () => {
  const { resolve } = (await import(
    pathToFileURL(resolvePath('scripts/production-resolve.mjs')).href
  )) as {
    resolve: (
      specifier: string,
      context: { parentURL?: string },
      next: (
        specifier: string,
        context: { parentURL?: string },
      ) => Promise<{ format?: string; url: string }>,
    ) => Promise<{ format?: string; url: string }>;
  };
  const seen: { parentURL: string | undefined; specifier: string }[] = [];
  const next =
    (url: string) =>
    async (specifier: string, context: { parentURL?: string }) => {
      seen.push({ parentURL: context.parentURL, specifier });
      return { url };
    };
  const compiledParent = `${dist}apps/api/src/composition-root.js`;

  const workspace = await resolve(
    '@north-star/postgres-provider/request-work-meter',
    { parentURL: compiledParent },
    next(`${root}packages/postgres-provider/src/request-work-meter.ts`),
  );
  assert.deepEqual(workspace, {
    format: 'module',
    url: `${dist}packages/postgres-provider/src/request-work-meter.js`,
  });
  // The bare package was looked up from the source twin's directory.
  assert.equal(
    seen.at(-1)?.parentURL,
    `${root}apps/api/src/composition-root.js`,
  );

  const relative = await resolve(
    './surface-runtime.js',
    { parentURL: `${dist}apps/web/src/app-server.js` },
    next(`${dist}apps/web/src/surface-runtime.js`),
  );
  assert.equal(relative.url, `${dist}apps/web/src/surface-runtime.js`);
  assert.equal(seen.at(-1)?.parentURL, `${dist}apps/web/src/app-server.js`);

  const thirdParty = `${root}node_modules/.pnpm/pg@8/node_modules/pg/lib/index.js`;
  assert.equal(
    (await resolve('pg', { parentURL: compiledParent }, next(thirdParty))).url,
    thirdParty,
  );
  assert.equal(
    (await resolve('node:fs', { parentURL: compiledParent }, next('node:fs')))
      .url,
    'node:fs',
  );
  assert.equal(seen.at(-1)?.parentURL, compiledParent);
});

test('the compiled sandbox launcher resolves its fork and loader from the workspace', async (t) => {
  const { mkdtemp, mkdir, symlink, writeFile, rm, readFile } =
    await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const ts = await import('typescript');
  const temporary = await mkdtemp(join(tmpdir(), 'workflow-compiled-launch-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await symlink(resolvePath('packages'), join(temporary, 'packages'));
  const out = join(temporary, 'dist/packages/customization/src');
  await mkdir(out, { recursive: true });
  await writeFile(join(temporary, 'dist/package.json'), '{"type":"module"}');
  const source = await readFile(
    resolvePath('packages/customization/src/sandbox.ts'),
    'utf8',
  );
  await writeFile(
    join(out, 'sandbox.js'),
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText,
  );
  const compiled = (await import(
    pathToFileURL(join(out, 'sandbox.js')).href
  )) as typeof import('../../packages/customization/src/sandbox.js');
  for (const kind of ['verifyWorkflowDraft', 'compile'] as const) {
    const marker = new Error('observed launch');
    assert.throws(
      () =>
        compiled.runSandboxRequest(
          kind,
          {},
          {
            launch: (path, argv) => {
              assert.ok(path.startsWith(join(temporary, 'packages/')));
              assert.ok(
                argv.includes(
                  pathToFileURL(
                    join(
                      temporary,
                      'packages/customization/src/sandbox-loader.mjs',
                    ),
                  ).href,
                ),
              );
              throw marker;
            },
          },
          { heapLimitMegabytes: 512, wallClockLimitMilliseconds: 30000 },
          (v) => v,
        ),
      marker,
    );
  }
});
