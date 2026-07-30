import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const read = (path: string): string => readFileSync(resolve(path), 'utf8');

test('Freeze D has one provider-neutral RequestRuntimeView authority and preserves request-context exports', () => {
  const runtime = read('packages/runtime/src/request-runtime-view.ts');
  const requestContext = read('packages/runtime/src/request-context.ts');
  const manifest = JSON.parse(read('packages/runtime/package.json')) as {
    dependencies?: Record<string, string>;
    exports: Record<string, string>;
  };
  const productionSources = readdirSync(resolve('packages/runtime/src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => read(`packages/runtime/src/${name}`))
    .join('\n');

  assert.equal(
    [...productionSources.matchAll(/interface RequestRuntimeView\s*\{/g)]
      .length,
    1,
  );
  assert.equal(manifest.exports['.'], './src/request-context.ts');
  assert.equal(
    manifest.exports['./request-context'],
    './src/request-context.ts',
  );
  assert.equal(
    manifest.exports['./request-runtime-view'],
    './src/request-runtime-view.ts',
  );
  assert.deepEqual(manifest.dependencies, {
    '@north-star/canonical-model': 'workspace:*',
  });
  assert.match(requestContext, /class AuthenticatedRequestEntryAdapter/);
  assert.match(requestContext, /issuedContexts = new WeakSet/);
  assert.match(runtime, /class AuthenticatedRequestRuntimeEntryAdapter/);
  assert.match(runtime, /this\.requestEntry\.enter\(request\)/);
  assert.match(runtime, /issuedViews = new WeakSet/);
  assert.doesNotMatch(
    runtime,
    /@north-star\/(?:compiler|postgres-provider|platform-runtime)/,
  );
  assert.doesNotMatch(
    runtime,
    /AsyncLocalStorage|defaultTenant|defaultEnvironment|globalActiveRelease|reloadOnAccess|Uint8Array/,
  );
});

test('policy stays live and deferred pinning stays explicit and serializable', () => {
  const runtime = read('packages/runtime/src/request-runtime-view.ts');

  assert.match(runtime, /interface CurrentPolicyGateway/);
  assert.match(runtime, /readCurrentVersion\(/);
  assert.match(runtime, /authorize\(/);
  assert.match(runtime, /authorizeCurrentPolicy/);
  assert.match(runtime, /const decision = await gateway\.authorize\(request\)/);
  assert.doesNotMatch(runtime, /ReleaseApproval|approver|executor.*policy/i);
  assert.match(runtime, /interface PinnedRuntimeContextEnvelope/);
  assert.match(runtime, /createPinnedRuntimeContextEnvelope/);
  assert.match(runtime, /parsePinnedRuntimeContextEnvelope/);
  assert.doesNotMatch(
    runtime,
    /(?:fromAmbient|reconstructFromProcess|currentPinnedContext|ambientContext)/,
  );
  for (const field of [
    'tenantId',
    'environmentId',
    'principalId',
    'entryPolicyVersion',
    'pointerId',
    'pointerFence',
    'releaseId',
    'releaseContentHash',
  ]) {
    assert.match(runtime, new RegExp(`readonly ${field}:`));
  }
  assert.match(runtime, /status: 'STALE_RELEASE_REPLAN'/);
  assert.match(runtime, /status: 'CURRENT'/);
});

test('PostgreSQL owns same-statement fill, P4b invalidation, and no release mutation authority', () => {
  const provider = read(
    'packages/postgres-provider/src/request-runtime-view-service.ts',
  );
  const manifest = JSON.parse(
    read('packages/postgres-provider/package.json'),
  ) as { exports: Record<string, string> };

  assert.equal(
    manifest.exports['./request-runtime-view-service'],
    './src/request-runtime-view-service.ts',
  );
  assert.match(provider, /ReleaseInvalidationFenceState/);
  assert.match(provider, /ReleaseActivationInvalidationEvent/);
  assert.match(provider, /shouldDiscardFenceTaggedCache/);
  assert.match(provider, /const authoritativeSnapshotSql =/);
  assert.match(
    provider,
    /FROM platform\.active_release_pointers[\s\S]*LEFT JOIN platform\.tenant_releases[\s\S]*read_tenant_release_artifacts[\s\S]*tenant_release_projection_links[\s\S]*tenant_release_chunk_links/,
  );
  assert.match(
    provider,
    /All mutable pointer and immutable release\/artifact facts are read by this[\s\S]*one statement/,
  );
  assert.match(provider, /await this\.#readPointerAuthority\(context\)/);
  assert.match(provider, /definitionMatchesAuthority/);
  assert.doesNotMatch(provider, /\bcompileApplication\s*\(/);
  assert.doesNotMatch(
    provider,
    /(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+platform\.active_release_pointers/i,
  );
  assert.doesNotMatch(
    provider,
    /AsyncLocalStorage|defaultTenant|globalActiveRelease/,
  );
});

test('issued legal-entity read scope is generic, explicit, and complete across read dispatch', () => {
  const runtime = read('packages/runtime/src/request-runtime-view.ts');
  const gateway = read('packages/runtime/src/semantic-query-gateway.ts');
  const interpreter = read(
    'packages/postgres-provider/src/module-runtime-interpreter.ts',
  );
  const requestContext = read(
    'packages/postgres-provider/src/request-context.ts',
  );
  const savedFilters = read(
    'packages/postgres-provider/src/saved-filter-executor.ts',
  );
  const compiler = read('packages/compiler/src/storage.ts');
  const scopeMechanism = interpreter.slice(
    interpreter.indexOf('export function legalEntityReadScopeRequirement'),
    interpreter.indexOf('function createChanges'),
  );

  assert.match(runtime, /issuedLegalEntityReadScopes = new WeakMap/);
  assert.match(runtime, /for \(const legalEntityId of legalEntityIds\)/);
  assert.match(runtime, /issuedLegalEntityReadScopes\.get\(value\) !== view/);
  assert.match(
    gateway,
    /await verifyLegalEntityReadScope\(\s*this\.currentPolicy,\s*executionContext\.legalEntityReadScope,\s*view,\s*definition\.sourceEntityId,\s*\)/u,
  );
  assert.match(scopeMechanism, /Object\.hasOwn\(entity, 'legalEntity'\)/);
  assert.match(scopeMechanism, /MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED/);
  assert.match(scopeMechanism, /MODULE_LEGAL_ENTITY_READ_SCOPE_NOT_FOUND/);
  assert.match(scopeMechanism, /= ANY\(\$1::uuid\[\]\)/);
  assert.doesNotMatch(
    scopeMechanism,
    /inventory|INVENTORY|entityId\.(?:includes|endsWith)|moduleId/u,
  );
  assert.match(
    interpreter,
    /legalEntityReadScopeJoinConjunction\(\s*plan\.target,\s*readScope,\s*values,\s*plan\.tableAlias/u,
  );
  assert.ok(
    [...interpreter.matchAll(/appendLegalEntityReadScopePredicate\(/gu)]
      .length >= 7,
  );
  assert.match(savedFilters, /this\.#requiredFallback\(\)\.execute\(request\)/);
  assert.match(savedFilters, /return fallback\.executeAggregate\(request\)/);
  assert.doesNotMatch(savedFilters, /FROM north_star_module/u);
  assert.doesNotMatch(requestContext, /set_config\('north_star\.legal_entity/u);
  assert.match(
    compiler,
    /legalEntity\?: \{[\s\S]*familyClassification: 'entityOwned'/u,
  );

  const victimControls = [
    [
      runtime,
      'issuedLegalEntityReadScopes.get(value) !== view',
      /issuedLegalEntityReadScopes\.get\(value\) !== view/,
    ],
    [
      scopeMechanism,
      "Object.hasOwn(entity, 'legalEntity')",
      /Object\.hasOwn\(entity, 'legalEntity'\)/,
    ],
    [
      scopeMechanism,
      'MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED',
      /MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED/,
    ],
    [
      scopeMechanism,
      'MODULE_LEGAL_ENTITY_READ_SCOPE_NOT_FOUND',
      /MODULE_LEGAL_ENTITY_READ_SCOPE_NOT_FOUND/,
    ],
    [
      gateway,
      'await verifyLegalEntityReadScope(',
      /await verifyLegalEntityReadScope\(/,
    ],
    [
      interpreter,
      'legalEntityReadScopeJoinConjunction(',
      /legalEntityReadScopeJoinConjunction\(/,
    ],
    [
      savedFilters,
      'this.#requiredFallback().execute(request)',
      /this\.#requiredFallback\(\)\.execute\(request\)/,
    ],
    [
      savedFilters,
      'return fallback.executeAggregate(request)',
      /return fallback\.executeAggregate\(request\)/,
    ],
  ] as const;
  for (const [source, victim, invariant] of victimControls) {
    const mutant = source.replaceAll(victim, '/* victim removed */');
    assert.doesNotMatch(mutant, invariant, `mutation survived: ${victim}`);
  }
});
