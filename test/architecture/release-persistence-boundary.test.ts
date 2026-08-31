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
    '0006_trust_substrate.sql',
    '0007_module_storage_transitions.sql',
    '0008_module_runtime_role_assumption.sql',
    '0009_semantic_operation_receipts.sql',
    '0010_semantic_operation_receipt_scope.sql',
    '0011_module_fold_function_ddl_witness.sql',
    '0012_saved_master_filters.sql',
    '0013_release_verification_evidence.sql',
    '0014_archive_excluding_module_uniqueness.sql',
    '0015_inventory_storage_foundation.sql',
    '0016_inventory_posting_receipt_digest_version.sql',
    '0017_inventory_stock_count_receipt_digest_version.sql',
    '0018_release_verification_derivations.sql',
    '0019_inventory_release_provenance_and_partition_null_safety.sql',
    '0020_semantic_aggregate_anchors.sql',
    '0021_bounded_fresh_tenant_install_evidence.sql',
    '0022_module_storage_relation_requiredness_relaxation.sql',
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
