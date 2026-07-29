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
  type EnumeratedTenantTable,
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

  assert.equal(verified.tableCount, 49);
  assert.equal(verified.tenantScopedCount, 42);
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

test('duplicate, independent-authority, and missing-column classifications fail', (context) => {
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

  const wrongIndependentAuthority = mutateClassification(
    manifest,
    'platform.release_artifact_blobs',
    {
      classification: 'tenant-independent',
      reason:
        'Content-addressed canonical release bytes are immutable and deliberately shared; tenant reachability is recorded by tenant-release links.',
      reasonCode: 'shared-immutable-catalog',
      schema: 'platform',
      table: 'release_artifact_blobs',
    },
  );
  const authority = expectDiagnostic(
    () => verifyTenantCompleteness(wrongIndependentAuthority, tables),
    'TENANT_INDEPENDENT_AUTHORITY_INVALID',
  );
  context.diagnostic(authority.message);

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

test('count mismatches and malformed classifications fail closed', (context) => {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    expectedTableCount: number;
    tables: Array<Record<string, unknown>>;
  };
  const parserCount = expectDiagnostic(
    () =>
      parseTenantCompletenessManifest({
        ...raw,
        expectedTableCount: raw.expectedTableCount + 1,
      }),
    'TENANT_TABLE_COUNT_MISMATCH',
  );
  context.diagnostic(`parser: ${parserCount.message}`);

  const manifest = loadManifest();
  const tables = enumerateTenantTablesFromSnapshot(loadSnapshot());
  const verifierCount = expectDiagnostic(
    () =>
      verifyTenantCompleteness(
        {
          ...manifest,
          expectedTableCount: manifest.expectedTableCount + 1,
        },
        tables,
      ),
    'TENANT_TABLE_COUNT_MISMATCH',
  );
  context.diagnostic(`verifier: ${verifierCount.message}`);

  const malformed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    tables: Array<Record<string, unknown>>;
  };
  assert.ok(malformed.tables[0]);
  malformed.tables[0].unreviewedDefault = true;
  const malformedError = expectDiagnostic(
    () => parseTenantCompletenessManifest(malformed),
    'TENANT_MANIFEST_INVALID',
  );
  context.diagnostic(malformedError.message);
});

test('stale and untrusted tenant-column declarations fail closed', (context) => {
  const manifest = loadManifest();
  const tables = enumerateTenantTablesFromSnapshot(loadSnapshot());
  const stale = expectDiagnostic(
    () =>
      verifyTenantCompleteness(
        {
          ...manifest,
          expectedTableCount: manifest.expectedTableCount + 1,
          tables: [
            ...manifest.tables,
            {
              classification: 'tenant-scoped',
              schema: 'platform',
              table: 'removed_business_records',
              tenantColumn: 'tenant_id',
            },
          ],
        },
        tables,
      ),
    'TENANT_CLASSIFICATION_STALE',
  );
  context.diagnostic(stale.message);

  const wrongUuid = mutateClassification(
    manifest,
    'platform.saved_master_filters',
    {
      classification: 'tenant-scoped',
      schema: 'platform',
      table: 'saved_master_filters',
      tenantColumn: 'environment_id',
    },
  );
  const wrongUuidError = expectDiagnostic(
    () => verifyTenantCompleteness(wrongUuid, tables),
    'TENANT_COLUMN_INVALID',
  );
  context.diagnostic(wrongUuidError.message);

  for (const [label, column] of [
    ['nullable', { dataType: 'uuid', isNullable: true, name: 'tenant_id' }],
    ['non-uuid', { dataType: 'text', isNullable: false, name: 'tenant_id' }],
  ] as const) {
    const invalidTables = mutateEnumeratedColumn(
      tables,
      'platform.saved_master_filters',
      'tenant_id',
      column,
    );
    const error = expectDiagnostic(
      () => verifyTenantCompleteness(manifest, invalidTables),
      'TENANT_COLUMN_INVALID',
    );
    assert.match(error.message, /platform\.saved_master_filters\.tenant_id/u);
    context.diagnostic(`${label}: ${error.message}`);
  }
});

test('partitioned, foreign, managed-module, and tenant-root branches fail closed', (context) => {
  const manifest = loadManifest();
  const snapshot = loadSnapshot();
  for (const [kind, expectedKind, table] of [
    ['p', 'partitioned-table', 'unclassified_partitioned_records'],
    ['f', 'foreign-table', 'unclassified_foreign_records'],
  ] as const) {
    const enumerated = enumerateTenantTablesFromSnapshot({
      ...snapshot,
      columns: [
        ...snapshot.columns,
        {
          column_name: 'tenant_id',
          data_type: 'uuid',
          is_nullable: false,
          relation: table,
          schema: 'g3_p2a_relation_kinds',
        },
      ],
      relations: [
        ...snapshot.relations,
        {
          kind,
          relation: table,
          schema: 'g3_p2a_relation_kinds',
        },
      ],
    });
    assert.equal(
      enumerated.find(
        (entry) =>
          entry.schema === 'g3_p2a_relation_kinds' && entry.table === table,
      )?.kind,
      expectedKind,
    );
    const error = expectDiagnostic(
      () => verifyTenantCompleteness(manifest, enumerated),
      'TENANT_TABLE_UNCLASSIFIED',
    );
    context.diagnostic(error.message);
  }

  const managedModule: EnumeratedTenantTable = {
    columns: [{ dataType: 'uuid', isNullable: false, name: 'record_id' }],
    kind: 'table',
    schema: 'north_star_module',
    table: 'managed_business_records',
  };
  const managedError = expectDiagnostic(
    () =>
      verifyTenantCompleteness(
        {
          ...manifest,
          expectedTableCount: manifest.expectedTableCount + 1,
          tables: [
            ...manifest.tables,
            {
              classification: 'tenant-independent',
              reason:
                'This deliberately invalid managed-module declaration claims a shared catalog identity for business records.',
              reasonCode: 'shared-immutable-catalog',
              schema: managedModule.schema,
              table: managedModule.table,
            },
          ],
        },
        [...enumerateTenantTablesFromSnapshot(snapshot), managedModule],
      ),
    'TENANT_INDEPENDENT_BUSINESS_TABLE',
  );
  context.diagnostic(managedError.message);

  const rootIndependent = mutateClassification(manifest, 'platform.tenants', {
    classification: 'tenant-independent',
    reason:
      'This deliberately invalid declaration treats the global tenant identity registry as a shared immutable catalog.',
    reasonCode: 'shared-immutable-catalog',
    schema: 'platform',
    table: 'tenants',
  });
  const rootError = expectDiagnostic(
    () =>
      verifyTenantCompleteness(
        rootIndependent,
        enumerateTenantTablesFromSnapshot(snapshot),
      ),
    'TENANT_INDEPENDENT_BUSINESS_TABLE',
  );
  context.diagnostic(rootError.message);
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
        49,
      );

      await client.query(
        `CREATE TABLE platform.g3_p2a_tenantless_business_records (
           record_id uuid NOT NULL PRIMARY KEY,
           display_name text NOT NULL
         )`,
      );
      const tenantlessBusinessTables = await enumerateTenantTables(client);
      const tenantlessBusinessTable = tenantlessBusinessTables.find(
        ({ schema, table }) =>
          schema === 'platform' &&
          table === 'g3_p2a_tenantless_business_records',
      );
      assert.ok(tenantlessBusinessTable);
      assert.equal(
        tenantlessBusinessTable.columns.some(
          ({ name }) => name === 'tenant_id',
        ),
        false,
      );
      const forgedIndependentManifest: TenantCompletenessManifest = {
        ...manifest,
        expectedTableCount: manifest.expectedTableCount + 1,
        tables: [
          ...manifest.tables,
          {
            classification: 'tenant-independent',
            reason:
              'Business records are incorrectly presented as a shared immutable catalog across every tenant for this negative control.',
            reasonCode: 'shared-immutable-catalog',
            schema: 'platform',
            table: 'g3_p2a_tenantless_business_records',
          },
        ],
      };
      const forgedIndependentError = expectDiagnostic(
        () =>
          verifyTenantCompleteness(
            forgedIndependentManifest,
            tenantlessBusinessTables,
          ),
        'TENANT_INDEPENDENT_AUTHORITY_INVALID',
      );
      context.diagnostic(forgedIndependentError.message);
      await client.query(
        'DROP TABLE platform.g3_p2a_tenantless_business_records',
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

function mutateEnumeratedColumn(
  tables: readonly EnumeratedTenantTable[],
  key: string,
  columnName: string,
  replacement: EnumeratedTenantTable['columns'][number],
): readonly EnumeratedTenantTable[] {
  return tables.map((table) =>
    `${table.schema}.${table.table}` === key
      ? {
          ...table,
          columns: table.columns.map((column) =>
            column.name === columnName ? replacement : column,
          ),
        }
      : table,
  );
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
