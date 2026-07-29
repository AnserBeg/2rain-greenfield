import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import type { SchemaSnapshot } from '../../packages/postgres-provider/src/migrations.js';
import {
  enumerateTenantTables,
  enumerateTenantTablesFromSnapshot,
  parseTenantCompletenessManifest,
  TenantCompletenessError,
  type TenantCompletenessManifest,
  type TenantTableClassification,
  verifyTenantCompleteness,
} from '../../packages/dev-tooling/src/tenant-completeness.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const manifestPath = resolve(
  'test/architecture/tenant-completeness.manifest.json',
);
const snapshotPath = resolve('db/schema.snapshot.json');

test('the checked manifest classifies every current table exactly once', () => {
  const manifest = loadManifest();
  const tables = enumerateTenantTablesFromSnapshot(loadSnapshot());
  const verified = verifyTenantCompleteness(manifest, tables);

  assert.equal(verified.tableCount, 46);
  assert.equal(verified.tenantScopedCount, 39);
  assert.equal(verified.tenantIndependentCount, 7);
  assert.equal(
    verified.classifications.find(
      ({ schema, table }) => schema === 'platform' && table === 'tenants',
    )?.classification,
    'tenant-scoped',
  );
  assert.equal(
    verified.classifications.find(
      ({ schema, table }) =>
        schema === 'platform' && table === 'release_artifact_blobs',
    )?.classification,
    'tenant-independent',
  );
});

test('empty and unknown-kind enumerations fail closed', (context) => {
  const manifest = loadManifest();
  const empty = expectDiagnostic(
    () => verifyTenantCompleteness(manifest, []),
    'TENANT_ENUMERATION_EMPTY',
  );
  context.diagnostic(empty.message);

  const snapshot = loadSnapshot();
  const first = snapshot.relations[0];
  assert.ok(first);
  const unknown = expectDiagnostic(
    () =>
      enumerateTenantTablesFromSnapshot({
        ...snapshot,
        relations: [{ ...first, kind: '?' }, ...snapshot.relations.slice(1)],
      }),
    'TENANT_ENUMERATION_OBJECT_KIND_UNKNOWN',
  );
  context.diagnostic(unknown.message);
});

test('duplicate, business-independent, and missing-column classifications fail', (context) => {
  const tables = enumerateTenantTablesFromSnapshot(loadSnapshot());
  const manifest = loadManifest();
  const duplicate = expectDiagnostic(
    () =>
      verifyTenantCompleteness(
        {
          ...manifest,
          tables: [...manifest.tables, manifest.tables[0]!],
        },
        tables,
      ),
    'TENANT_CLASSIFICATION_DUPLICATE',
  );
  context.diagnostic(duplicate.message);

  const businessIndependent = mutateClassification(
    manifest,
    'platform.tenant_fixture_records',
    {
      classification: 'tenant-independent',
      reason:
        'Fixture business records would remain shared across every tenant under this deliberately invalid negative control.',
      reasonCode: 'shared-immutable-catalog',
      schema: 'platform',
      table: 'tenant_fixture_records',
    },
  );
  const business = expectDiagnostic(
    () => verifyTenantCompleteness(businessIndependent, tables),
    'TENANT_INDEPENDENT_BUSINESS_TABLE',
  );
  context.diagnostic(business.message);

  const missingColumn = mutateClassification(
    manifest,
    'platform.saved_master_filters',
    {
      classification: 'tenant-scoped',
      schema: 'platform',
      table: 'saved_master_filters',
      tenantColumn: 'missing_tenant_id',
    },
  );
  const missing = expectDiagnostic(
    () => verifyTenantCompleteness(missingColumn, tables),
    'TENANT_COLUMN_MISSING',
  );
  context.diagnostic(missing.message);
});

test('absence of a tenant column is not an independence reason', (context) => {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    tables: Array<Record<string, unknown>>;
  };
  const classification = raw.tables.find(
    ({ schema, table }) =>
      schema === 'north_star_internal' && table === 'schema_migrations',
  );
  assert.ok(classification);
  classification.reason =
    'No tenant column exists, so this deliberately invalid declaration calls the table independent.';
  const error = expectDiagnostic(
    () => parseTenantCompletenessManifest(raw),
    'TENANT_INDEPENDENT_REASON_INVALID',
  );
  context.diagnostic(error.message);
});

test('ADR-0011 enumeration discovers unclassified tables in known and new schemas', async (context) => {
  const manifest = loadManifest();
  await withEphemeralPostgres('tenant-completeness', async ({ pool }) => {
    const client = await pool.connect();
    try {
      await runMigrations(
        client,
        await loadMigrations(resolve('db/migrations')),
      );
      assert.equal(
        verifyTenantCompleteness(manifest, await enumerateTenantTables(client))
          .tableCount,
        46,
      );

      await client.query(
        `CREATE TABLE platform.g3_p2a_unclassified_probe (
           tenant_id uuid NOT NULL,
           record_id uuid NOT NULL PRIMARY KEY
         )`,
      );
      const existingSchemaTables = await enumerateTenantTables(client);
      const observedExistingSchemaError = captureDiagnostic(() =>
        verifyTenantCompleteness(manifest, existingSchemaTables),
      );
      assert.equal(
        observedExistingSchemaError.code,
        'TENANT_TABLE_UNCLASSIFIED',
      );
      assert.match(
        observedExistingSchemaError.message,
        /platform\.g3_p2a_unclassified_probe/u,
      );
      context.diagnostic(observedExistingSchemaError.message);
      await client.query('DROP TABLE platform.g3_p2a_unclassified_probe');

      await client.query('CREATE SCHEMA g3_p2a_unlisted_plane');
      await client.query(
        `CREATE TABLE g3_p2a_unlisted_plane.shadow_business_records (
           tenant_id uuid NOT NULL,
           record_id uuid NOT NULL PRIMARY KEY
         )`,
      );
      const newSchemaTables = await enumerateTenantTables(client);
      assert.ok(
        newSchemaTables.some(
          ({ schema, table }) =>
            schema === 'g3_p2a_unlisted_plane' &&
            table === 'shadow_business_records',
        ),
      );
      const newSchemaError = captureDiagnostic(() =>
        verifyTenantCompleteness(manifest, newSchemaTables),
      );
      assert.equal(newSchemaError.code, 'TENANT_TABLE_UNCLASSIFIED');
      assert.match(
        newSchemaError.message,
        /g3_p2a_unlisted_plane\.shadow_business_records/u,
      );
      context.diagnostic(newSchemaError.message);
    } finally {
      client.release();
    }
  });
});

function loadManifest(): TenantCompletenessManifest {
  return parseTenantCompletenessManifest(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
  );
}

function loadSnapshot(): SchemaSnapshot {
  return JSON.parse(readFileSync(snapshotPath, 'utf8')) as SchemaSnapshot;
}

function mutateClassification(
  manifest: TenantCompletenessManifest,
  key: string,
  replacement: TenantTableClassification,
): TenantCompletenessManifest {
  return {
    ...manifest,
    tables: manifest.tables.map((classification) =>
      `${classification.schema}.${classification.table}` === key
        ? replacement
        : classification,
    ),
  };
}

function expectDiagnostic(
  run: () => unknown,
  code: TenantCompletenessError['code'],
): TenantCompletenessError {
  const error = captureDiagnostic(run);
  assert.equal(error.code, code);
  return error;
}

function captureDiagnostic(run: () => unknown): TenantCompletenessError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof TenantCompletenessError);
    return error;
  }
  assert.fail('expected tenant-completeness verification to fail');
}
