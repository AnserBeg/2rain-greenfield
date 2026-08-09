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
  assertPostedIdOnlySelects(joined);
});

/**
 * A CHEAP RATCHET, and explicitly not what the property rests on — ADR-0051 §4.
 *
 * Narrowing this scan to the property left it a source scan, and a source scan
 * stays green against `submission.selectorBypass === '1' ? operations[0] :
 * find(...)`: the compliant comparison is still written. The property is now
 * held structurally by `semanticOperationRequestFor`, whose argument list has
 * no submission in it, and which is tested directly. This check remains
 * because it is nearly free and catches the careless case early.
 */
function assertPostedIdOnlySelects(source: string): void {
  const postedIdReads = source
    .split('\n')
    .filter((line) => line.includes('submission.operationId'));
  assert.ok(
    postedIdReads.length > 0,
    'the posted operation id is never read, so this check proves nothing',
  );
  for (const line of postedIdReads) {
    assert.match(line, /candidate\.operationId === submission\.operationId/);
  }
}

/**
 * The vacuity controls for the ratchet, both running the PRODUCTION predicate
 * against their specimen rather than re-implementing it. The empty-read arm
 * previously asserted its own specimen had zero reads and never called
 * `assertPostedIdOnlySelects`, so it never observed the `length > 0` guard
 * firing — it proved a property of the fixture, not of the check.
 */
test('binding-authority red: a passed-onward id and a never-read id are both observed', () => {
  const leaked = [
    'const operation = binding.operations.find(',
    '  (candidate) => candidate.operationId === submission.operationId,',
    ');',
    'const result = await gateways.operationGateway.invoke(view, {',
    '  operationId: submission.operationId,',
    '});',
  ].join('\n');
  assert.throws(
    () => assertPostedIdOnlySelects(leaked),
    /operationId: submission\.operationId/,
  );

  // The other vacuity vector: a source that never reads the posted id must not
  // satisfy the check by quantifying over an empty list.
  assert.throws(
    () =>
      assertPostedIdOnlySelects(
        'const operation = binding.operations.find(() => true);',
      ),
    /the posted operation id is never read/,
  );

  // And the arm that shows the predicate can pass, so the two reds above are
  // not observing a check that refuses everything.
  assertPostedIdOnlySelects(
    'const operation = binding.operations.find(\n' +
      '  (candidate) => candidate.operationId === submission.operationId,\n' +
      ');',
  );
});

/**
 * ADR-0051 §4's structural half, asserted where it lives: the one construction
 * site for a gateway request cannot see the wire, and does not spread.
 */
test('the gateway request is built where the submission is not in scope', () => {
  const runtime = readFileSync(resolve('apps/web/src/surface-runtime.ts'), 'utf8');
  const helper = runtime.slice(
    runtime.indexOf('export function semanticOperationRequestFor('),
  );
  assert.notEqual(helper, '');
  const body = helper.slice(0, helper.indexOf('\n}\n') + 3);
  assert.doesNotMatch(body, /submission/);
  assert.doesNotMatch(body, /\.\.\./);
  assert.match(body, /operationId: operation\.operationId/);
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
