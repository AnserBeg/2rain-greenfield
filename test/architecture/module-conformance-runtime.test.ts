import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import test from 'node:test';

const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);

test('domain packages cannot own PostgreSQL, SQL, or generic Q0/O0 execution', () => {
  for (const file of sourceFiles('packages/domain')) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /from\s+['"](?:pg|postgres)(?:\/[^'"]*)?['"]|require\(['"](?:pg|postgres)/,
      `${relative(process.cwd(), file)} imports a PostgreSQL client`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+[^;]+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i,
      `${relative(process.cwd(), file)} contains SQL`,
    );
    assert.doesNotMatch(
      source,
      /Semantic(?:Query|Operation)Executor|PostgresModuleRuntimeInterpreter|class\s+\w*(?:Query|Operation)Handler\b/,
      `${relative(process.cwd(), file)} contains Q0/O0 execution code`,
    );
  }
});

test('one generic provider interpreter serves registration data without module literals', () => {
  const providerFiles = sourceFiles('packages/postgres-provider/src');
  const declarations = providerFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/class\s+(\w*ModuleRuntimeInterpreter\w*)\b/g)]
      .map((match) => ({ file, name: match[1]! }))
      .filter((entry) => !entry.name.endsWith('Error'));
  });
  assert.deepEqual(
    declarations.map((entry) => [
      relative(process.cwd(), entry.file),
      entry.name,
    ]),
    [
      [
        'packages/postgres-provider/src/module-runtime-interpreter.ts',
        'PostgresModuleRuntimeInterpreter',
      ],
    ],
  );

  const production = [...sourceFiles('packages/runtime/src'), ...providerFiles]
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    production,
    /northstar\.ordinary|master_(?:get|list|search|resolve|create|update|archive|restore)/,
  );
});

test('the Inventory capability adapter hydrates drafts but delegates every mutation to posting', () => {
  const source = readFileSync(
    resolve(
      'packages/postgres-provider/src/inventory-posting-capability-executor.ts',
    ),
    'utf8',
  );
  const mutatingSql =
    /\b(?:INSERT\s+INTO|UPDATE\s+[^;]+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i;

  assert.match(source, /\bSELECT\b/);
  assert.doesNotMatch(source, mutatingSql);
  assert.match(source, /new PostgresInventoryPostingService\(/);
  assert.match(source, /this\.#posting\.postAdjustment\(/);

  assert.match(
    'UPDATE north_star_module.draft SET state = posted',
    mutatingSql,
    'negative control must recognize a direct adapter mutation',
  );
});

test('the conformance fixture is definition data, not emitted module TypeScript', () => {
  const fixtureDirectory = resolve('test/fixtures/g2/module-conformance');
  const names = readdirSync(fixtureDirectory).sort();
  assert.deepEqual(names, [
    'definitions.ts',
    'package.json',
    'v1-v2.release.structural.golden.json',
    'v1-v2.transition.structural.golden.json',
  ]);
  const definition = readFileSync(
    join(fixtureDirectory, 'definitions.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    definition,
    /from\s+['"](?:pg|postgres|@north-star\/runtime|@north-star\/postgres-provider)/,
  );
  assert.doesNotMatch(
    definition,
    /(?:class|function)\s+\w*(?:Handler|Executor|Gateway|Repository|Service)\b/,
  );

  const metamorphic = readFileSync(
    resolve('test/postgres/module-runtime.test.ts'),
    'utf8',
  );
  assert.match(metamorphic, /ordinaryModuleV2ForNamespace\(namespace\)/);
  assert.match(metamorphic, /randomUUID\(\)/);
  assert.match(metamorphic, /new PostgresModuleRuntimeInterpreter/);
});

function sourceFiles(directory: string): string[] {
  const root = resolve(directory);
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (sourceExtensions.has(extname(entry.name))) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}
