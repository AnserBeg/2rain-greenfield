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

  // RE-PINNED by `pur1-intent-limit`. This line read
  // `assert.doesNotMatch(joined, /submission\.operationId/)` -- a ban on the
  // wire FIELD, which was a sufficient condition for the property it guards
  // and stopped being a necessary one. Two commands on one surface cannot be
  // told apart unless the browser names which control was pressed, so the
  // field ban refuses a correct implementation along with the bad ones.
  //
  // The property is unchanged and is now pinned directly: the browser SELECTS
  // within the compiled binding and never NAMES the operation the gateway
  // runs. So every read of the posted id must be the comparison that looks it
  // up in `binding.operations`, and the id handed to the gateway must be the
  // RESOLVED operation's -- which the assertion above already requires.
  assert.match(joined, /binding\.operations\.find\(/);
  const postedIdReads = joined
    .split('\n')
    .filter((line) => line.includes('submission.operationId'));
  assert.ok(
    postedIdReads.length > 0,
    'the posted operation id is never read, so this check proves nothing',
  );
  for (const line of postedIdReads) {
    assert.match(line, /candidate\.operationId === submission\.operationId/);
  }
});

/**
 * A source scan is a proxy for the property above; the observation is the
 * browser arm that posts three ids outside the binding, gets three refusals,
 * and then posts a bound one and gets a 200. This is the vacuity control for
 * the proxy: the leak it exists to catch, observed being caught.
 */
test('binding-authority red: a posted operation id passed onward is observed', () => {
  const leaked = [
    'const operation = binding.operations.find(',
    '  (candidate) => candidate.operationId === submission.operationId,',
    ');',
    'const result = await gateways.operationGateway.invoke(view, {',
    '  operationId: submission.operationId,',
    '});',
  ].join('\n');
  const reads = leaked
    .split('\n')
    .filter((line) => line.includes('submission.operationId'));
  assert.equal(reads.length, 2);
  assert.throws(() => {
    for (const line of reads) {
      assert.match(line, /candidate\.operationId === submission\.operationId/);
    }
  }, /operationId: submission\.operationId/);

  // And the other half: a file that never reads the posted id at all must not
  // satisfy the check by vacuous quantification over an empty list.
  const absent = 'const operation = binding.operations.find(() => true);';
  assert.equal(
    absent.split('\n').filter((line) => line.includes('submission.operationId'))
      .length,
    0,
  );
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
