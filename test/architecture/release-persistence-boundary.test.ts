import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const read = (path: string): string => readFileSync(resolve(path), 'utf8');

test('Freeze C ports consume Freeze A/B without a compiler or activation authority', () => {
  const contractsManifest = JSON.parse(
    read('packages/platform-runtime/package.json'),
  ) as { dependencies?: Record<string, string>; name: string };
  const contracts = read('packages/platform-runtime/src/release-records.ts');
  const provider = read('packages/postgres-provider/src/release-repository.ts');

  assert.equal(contractsManifest.name, '@north-star/platform-runtime');
  assert.deepEqual(contractsManifest.dependencies, undefined);
  assert.match(
    provider,
    /import \{[\s\S]*type CompileSuccess[\s\S]*\} from '@north-star\/compiler'/,
  );
  assert.doesNotMatch(provider, /\bcompileApplication\s*\(/);
  assert.doesNotMatch(contracts, /@north-star\/compiler/);
  assert.doesNotMatch(
    contracts,
    /\b(?:activate|approve|rollback|compareAndSwap|update|delete)[A-Z]\w*\s*\(/,
  );
  assert.match(contracts, /interface ActiveReleasePointerIdentity/);
  assert.match(contracts, /interface ReleaseApprovalIdentity/);
  assert.match(contracts, /interface ReleaseActivationAttemptIdentity/);
  assert.match(contracts, /interface VerificationEvidenceIdentity/);
});

test('migration owns one immutable RLS release schema with no blob hash oracle', () => {
  const migrationNames = readdirSync(resolve('db/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.deepEqual(migrationNames, [
    '0001_platform_tenancy.sql',
    '0002_trusted_request_context.sql',
    '0003_immutable_release_persistence.sql',
    '0004_release_activation_contracts.sql',
    '0005_release_activation_kernel.sql',
  ]);

  const migration = read(
    'db/migrations/0003_immutable_release_persistence.sql',
  );
  const blobTable = migration.match(
    /CREATE TABLE platform\.release_artifact_blobs \(([\s\S]*?)\n\);/,
  )?.[1];
  assert.ok(blobTable);
  assert.doesNotMatch(
    blobTable,
    /tenant_id|environment_id|principal_id|coordinator_id/,
  );
  assert.doesNotMatch(migration, /GRANT\s+SELECT[^;]*release_artifact_blobs/i);
  assert.match(
    migration,
    /REVOKE ALL ON platform\.release_artifact_blobs FROM PUBLIC/,
  );
  assert.equal(
    [
      ...migration.matchAll(
        /CREATE RULE .*_reject_(?:update|delete)\nAS ON (?:UPDATE|DELETE)/g,
      ),
    ].length,
    12,
  );
  assert.equal([...migration.matchAll(/FORCE ROW LEVEL SECURITY/g)].length, 5);
  assert.equal(
    [
      ...migration.matchAll(
        /CREATE POLICY .*_(?:select|insert)_trusted_context/g,
      ),
    ].length,
    10,
  );
  assert.doesNotMatch(migration, /FOR (?:ALL|UPDATE|DELETE)\b/);
  assert.match(
    migration,
    /CREATE FUNCTION platform\.read_tenant_release_artifacts\(requested_release_id uuid\)/,
  );
  assert.doesNotMatch(
    migration,
    /CREATE (?:TABLE|VIEW|FUNCTION) platform\.[^(\s]*(?:approval|activation|active_release_pointer)/i,
  );
});

test('registered release verification precedes root insertion and serving code never compiles', () => {
  const provider = read('packages/postgres-provider/src/release-repository.ts');
  const postgresTest = read('test/postgres/releases.test.ts');
  const verification = provider.indexOf(
    'const verified = verifyCompiledRelease(command.compiledRelease, revision)',
  );
  const transaction = provider.indexOf(
    'await withTrustedRequestTransaction(this.pool, context',
    verification,
  );
  const rootInsert = provider.indexOf(
    'await insertReleaseRoot(client, command, verified)',
    transaction,
  );

  assert.ok(verification > 0);
  assert.ok(transaction > verification);
  assert.ok(rootInsert > transaction);
  assert.match(postgresTest, /const bootstrap = mustCompile\(bootstrapBytes\)/);
  assert.match(
    postgresTest,
    /const repository = new PostgresImmutableReleaseRepository/,
  );
  assert.ok(
    postgresTest.indexOf('const bootstrap = mustCompile(bootstrapBytes)') <
      postgresTest.indexOf(
        'const repository = new PostgresImmutableReleaseRepository',
      ),
  );
});
