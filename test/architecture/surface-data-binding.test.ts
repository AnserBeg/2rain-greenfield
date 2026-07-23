import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import test from 'node:test';

const webSource = sourceFiles('apps/web/src');
const joinedWebSource = webSource
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

test('SurfaceRuntime data binding has no module or surface-specific branch', () => {
  const bindingSources = [
    'apps/web/src/app-server.ts',
    'apps/web/src/component-registry.ts',
    'apps/web/src/surface-contract.ts',
    'apps/web/src/surface-runtime.ts',
  ].map((file) => readFileSync(resolve(file), 'utf8'));
  const joined = bindingSources.join('\n');

  assert.doesNotMatch(
    joined,
    /northstar\.modulefixture|master_(?:get|list|search|resolve|create|update|archive|restore)|northstar\.(?:party|catalog|location)/i,
  );
  assert.doesNotMatch(
    joined,
    /class\s+\w*(?:Query|Operation|Surface)Handler\b|switch\s*\([^)]*(?:surfaceId|entityId|operationId)/,
  );
  assert.match(joined, /dataSourceQueryId/);
  assert.match(joined, /queryGateway\.invoke/);
  assert.match(joined, /operationGateway\.invoke/);
  assert.match(joined, /operationId:\s*operation\.operationId/);
  assert.doesNotMatch(joined, /submission\.operationId/);
});

test('apps/web has no PostgreSQL, SQL, provider, or direct database access', () => {
  for (const file of webSource) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /from\s+['"](?:pg|postgres|@north-star\/postgres-provider)(?:\/[^'"]*)?['"]|require\(['"](?:pg|postgres)/,
      `${relative(process.cwd(), file)} imports a database/provider boundary`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+.+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/i,
      `${relative(process.cwd(), file)} contains SQL`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:Pool|PoolClient|databaseClient|databaseConnection|directDatabase)\b/,
      `${relative(process.cwd(), file)} declares direct database access`,
    );
  }
  assert.match(joinedWebSource, /RequestRuntimeView/);
  assert.match(joinedWebSource, /SemanticQueryGateway/);
  assert.match(joinedWebSource, /SemanticOperationGateway/);
});

test('the definition-only G2 fixture remains outside production web code', () => {
  const fixture = readFileSync(
    resolve('test/fixtures/g2/module-conformance/definitions.ts'),
    'utf8',
  );
  assert.match(fixture, /ordinaryModuleV1/);
  assert.doesNotMatch(joinedWebSource, /FIXTURE_IDS|ordinaryModuleV1/);
  assert.doesNotMatch(
    fixture,
    /from\s+['"](?:@north-star\/runtime|@north-star\/postgres-provider|pg|postgres)/,
  );
});

function sourceFiles(directory: string): string[] {
  const root = resolve(directory);
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (['.js', '.mjs', '.ts', '.tsx'].includes(extname(entry.name))) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files.sort();
}
