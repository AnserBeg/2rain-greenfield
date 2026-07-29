import type { PoolClient } from 'pg';

import {
  captureSchemaSnapshot,
  SCHEMA_SNAPSHOT_VERSION,
  type SchemaSnapshot,
} from '../../postgres-provider/src/migrations.js';

export const TENANT_COMPLETENESS_MANIFEST_VERSION =
  'northstar.tenant-completeness-manifest/v1' as const;

export const TENANT_INDEPENDENT_DEFINITION =
  'A table is tenant-independent only when its rows represent a database-wide kernel mechanism or immutable content deliberately shared across tenants; business records are never tenant-independent, and absence of a tenant column is not evidence.';

const tableRelationKinds = new Set(['f', 'p', 'r']);
const knownNonTableRelationKinds = new Set(['c', 'm', 'v']);
const independentReasonCodes = new Set([
  'kernel-integrity-witness',
  'migration-history',
  'shared-immutable-catalog',
  'shared-immutable-content',
]);

export type TenantIndependentReasonCode =
  | 'kernel-integrity-witness'
  | 'migration-history'
  | 'shared-immutable-catalog'
  | 'shared-immutable-content';

export interface TenantScopedClassification {
  readonly classification: 'tenant-scoped';
  readonly schema: string;
  readonly table: string;
  readonly tenantColumn: string;
}

export interface TenantIndependentClassification {
  readonly classification: 'tenant-independent';
  readonly reason: string;
  readonly reasonCode: TenantIndependentReasonCode;
  readonly schema: string;
  readonly table: string;
}

export type TenantTableClassification =
  TenantIndependentClassification | TenantScopedClassification;

export interface TenantCompletenessManifest {
  readonly expectedTableCount: number;
  readonly schemaVersion: typeof TENANT_COMPLETENESS_MANIFEST_VERSION;
  readonly tables: readonly TenantTableClassification[];
  readonly tenantIndependentDefinition: typeof TENANT_INDEPENDENT_DEFINITION;
}

export interface EnumeratedTenantColumn {
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly name: string;
}

export interface EnumeratedTenantTable {
  readonly columns: readonly EnumeratedTenantColumn[];
  readonly kind: 'foreign-table' | 'partitioned-table' | 'table';
  readonly schema: string;
  readonly table: string;
}

export interface VerifiedTenantCompleteness {
  readonly classifications: readonly TenantTableClassification[];
  readonly tableCount: number;
  readonly tenantIndependentCount: number;
  readonly tenantScopedCount: number;
}

export type TenantCompletenessDiagnosticCode =
  | 'TENANT_CLASSIFICATION_DUPLICATE'
  | 'TENANT_CLASSIFICATION_STALE'
  | 'TENANT_ENUMERATION_DUPLICATE'
  | 'TENANT_ENUMERATION_EMPTY'
  | 'TENANT_ENUMERATION_OBJECT_KIND_UNKNOWN'
  | 'TENANT_INDEPENDENT_BUSINESS_TABLE'
  | 'TENANT_INDEPENDENT_REASON_INVALID'
  | 'TENANT_MANIFEST_INVALID'
  | 'TENANT_TABLE_COUNT_MISMATCH'
  | 'TENANT_TABLE_UNCLASSIFIED'
  | 'TENANT_COLUMN_INVALID'
  | 'TENANT_COLUMN_MISSING';

export class TenantCompletenessError extends Error {
  override readonly name = 'TenantCompletenessError';

  constructor(
    readonly code: TenantCompletenessDiagnosticCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export async function enumerateTenantTables(
  client: PoolClient,
): Promise<readonly EnumeratedTenantTable[]> {
  const schemas = await client.query<{ schema_name: string }>(
    `SELECT namespace.nspname AS schema_name
       FROM pg_catalog.pg_namespace AS namespace
      WHERE namespace.nspname !~ '^pg_'
        AND namespace.nspname <> 'information_schema'
      ORDER BY namespace.nspname`,
  );
  const names = schemas.rows.map((row) => row.schema_name);
  if (names.length === 0) {
    throw new TenantCompletenessError(
      'TENANT_ENUMERATION_EMPTY',
      'the non-system schema enumeration returned zero schemas',
    );
  }

  // ADR-0011 already owns catalog object enumeration. Reuse its versioned
  // snapshot walk for every discovered non-system schema instead of issuing a
  // tenancy-specific pg_class table query.
  return enumerateTenantTablesFromSnapshot(
    await captureSchemaSnapshot(client, names),
  );
}

export function enumerateTenantTablesFromSnapshot(
  snapshot: SchemaSnapshot,
): readonly EnumeratedTenantTable[] {
  if (snapshot.version !== SCHEMA_SNAPSHOT_VERSION) {
    throw new TenantCompletenessError(
      'TENANT_ENUMERATION_OBJECT_KIND_UNKNOWN',
      `unsupported ADR-0011 schema snapshot version ${String(snapshot.version)}`,
    );
  }

  const columnsByTable = new Map<string, EnumeratedTenantColumn[]>();
  for (const rawColumn of snapshot.columns) {
    const column = objectRecord(rawColumn, 'schema snapshot column');
    const schema = requiredString(column.schema, 'column.schema');
    const table = requiredString(column.relation, 'column.relation');
    const name = requiredString(column.column_name, 'column.column_name');
    const dataType = requiredString(column.data_type, 'column.data_type');
    if (typeof column.is_nullable !== 'boolean') {
      invalidManifest(
        `column ${schema}.${table}.${name} has invalid nullability`,
      );
    }
    const key = tableKey(schema, table);
    const prior = columnsByTable.get(key) ?? [];
    prior.push({ dataType, isNullable: column.is_nullable, name });
    columnsByTable.set(key, prior);
  }

  const tables: EnumeratedTenantTable[] = [];
  const seen = new Set<string>();
  for (const rawRelation of snapshot.relations) {
    const relation = objectRecord(rawRelation, 'schema snapshot relation');
    const schema = requiredString(relation.schema, 'relation.schema');
    const table = requiredString(relation.relation, 'relation.relation');
    const rawKind = requiredString(relation.kind, 'relation.kind');
    if (knownNonTableRelationKinds.has(rawKind)) continue;
    if (!tableRelationKinds.has(rawKind)) {
      throw new TenantCompletenessError(
        'TENANT_ENUMERATION_OBJECT_KIND_UNKNOWN',
        `unknown relation kind ${rawKind} for ${schema}.${table}`,
      );
    }
    const key = tableKey(schema, table);
    if (seen.has(key)) {
      throw new TenantCompletenessError(
        'TENANT_ENUMERATION_DUPLICATE',
        `ADR-0011 enumerated ${key} more than once`,
      );
    }
    seen.add(key);
    tables.push({
      columns: (columnsByTable.get(key) ?? []).toSorted((left, right) =>
        compareCodeUnits(left.name, right.name),
      ),
      kind:
        rawKind === 'r'
          ? 'table'
          : rawKind === 'p'
            ? 'partitioned-table'
            : 'foreign-table',
      schema,
      table,
    });
  }
  if (tables.length === 0) {
    throw new TenantCompletenessError(
      'TENANT_ENUMERATION_EMPTY',
      'ADR-0011 enumerated zero tables',
    );
  }
  return tables.toSorted(compareTables);
}

export function parseTenantCompletenessManifest(
  value: unknown,
): TenantCompletenessManifest {
  const manifest = exactObject(value, 'manifest', [
    'expectedTableCount',
    'schemaVersion',
    'tables',
    'tenantIndependentDefinition',
  ]);
  if (manifest.schemaVersion !== TENANT_COMPLETENESS_MANIFEST_VERSION) {
    invalidManifest(
      `unsupported schemaVersion ${String(manifest.schemaVersion)}`,
    );
  }
  if (manifest.tenantIndependentDefinition !== TENANT_INDEPENDENT_DEFINITION) {
    invalidManifest(
      'tenantIndependentDefinition does not match the frozen v1 definition',
    );
  }
  if (
    !Number.isInteger(manifest.expectedTableCount) ||
    Number(manifest.expectedTableCount) < 1
  ) {
    invalidManifest('expectedTableCount must be a positive integer');
  }
  if (!Array.isArray(manifest.tables)) {
    invalidManifest('tables must be an array');
  }

  const tables = manifest.tables.map((raw, index) =>
    parseClassification(raw, `tables[${index}]`),
  );
  if (tables.length !== manifest.expectedTableCount) {
    throw new TenantCompletenessError(
      'TENANT_TABLE_COUNT_MISMATCH',
      `manifest declares ${String(manifest.expectedTableCount)} tables but contains ${String(tables.length)} classifications`,
    );
  }

  return {
    expectedTableCount: manifest.expectedTableCount as number,
    schemaVersion: TENANT_COMPLETENESS_MANIFEST_VERSION,
    tables,
    tenantIndependentDefinition: TENANT_INDEPENDENT_DEFINITION,
  };
}

export function verifyTenantCompleteness(
  manifest: TenantCompletenessManifest,
  tables: readonly EnumeratedTenantTable[],
): VerifiedTenantCompleteness {
  if (tables.length === 0) {
    throw new TenantCompletenessError(
      'TENANT_ENUMERATION_EMPTY',
      'cannot verify tenant completeness against zero tables',
    );
  }

  const classifications = new Map<string, TenantTableClassification>();
  for (const classification of manifest.tables) {
    const key = tableKey(classification.schema, classification.table);
    if (classifications.has(key)) {
      throw new TenantCompletenessError(
        'TENANT_CLASSIFICATION_DUPLICATE',
        `${key} has more than one tenancy classification`,
      );
    }
    classifications.set(key, classification);
  }

  const observed = new Set<string>();
  for (const table of tables) {
    const key = tableKey(table.schema, table.table);
    if (observed.has(key)) {
      throw new TenantCompletenessError(
        'TENANT_ENUMERATION_DUPLICATE',
        `ADR-0011 enumerated ${key} more than once`,
      );
    }
    observed.add(key);
    const classification = classifications.get(key);
    if (!classification) {
      throw new TenantCompletenessError(
        'TENANT_TABLE_UNCLASSIFIED',
        `${key} has no tenant-completeness classification`,
      );
    }
    verifyClassification(table, classification);
  }

  for (const key of classifications.keys()) {
    if (!observed.has(key)) {
      throw new TenantCompletenessError(
        'TENANT_CLASSIFICATION_STALE',
        `${key} is classified but was not enumerated`,
      );
    }
  }
  if (
    tables.length !== manifest.expectedTableCount ||
    classifications.size !== manifest.expectedTableCount
  ) {
    throw new TenantCompletenessError(
      'TENANT_TABLE_COUNT_MISMATCH',
      `expected ${String(manifest.expectedTableCount)} tables, enumerated ${String(tables.length)}, and resolved ${String(classifications.size)} classifications`,
    );
  }

  const sorted = [...classifications.values()].toSorted(compareClassifications);
  return {
    classifications: sorted,
    tableCount: sorted.length,
    tenantIndependentCount: sorted.filter(
      ({ classification }) => classification === 'tenant-independent',
    ).length,
    tenantScopedCount: sorted.filter(
      ({ classification }) => classification === 'tenant-scoped',
    ).length,
  };
}

export function formatTenantClassifications(
  verified: VerifiedTenantCompleteness,
): string {
  const rows = [
    'table\tclassification\ttenant-column-or-reason',
    ...verified.classifications.map((classification) => {
      const detail =
        classification.classification === 'tenant-scoped'
          ? classification.tenantColumn
          : `${classification.reasonCode}: ${classification.reason}`;
      return `${tableKey(classification.schema, classification.table)}\t${classification.classification}\t${detail}`;
    }),
  ];
  return `${rows.join('\n')}\n`;
}

function parseClassification(
  value: unknown,
  path: string,
): TenantTableClassification {
  const discriminator = objectRecord(value, path).classification;
  if (discriminator === 'tenant-scoped') {
    const scoped = exactObject(value, path, [
      'classification',
      'schema',
      'table',
      'tenantColumn',
    ]);
    return {
      classification: 'tenant-scoped',
      schema: requiredIdentifier(scoped.schema, `${path}.schema`),
      table: requiredIdentifier(scoped.table, `${path}.table`),
      tenantColumn: requiredIdentifier(
        scoped.tenantColumn,
        `${path}.tenantColumn`,
      ),
    };
  }
  if (discriminator === 'tenant-independent') {
    const independent = exactObject(value, path, [
      'classification',
      'reason',
      'reasonCode',
      'schema',
      'table',
    ]);
    const reasonCode = requiredString(
      independent.reasonCode,
      `${path}.reasonCode`,
    );
    if (!independentReasonCodes.has(reasonCode)) {
      invalidManifest(`${path}.reasonCode is not a governed v1 reason code`);
    }
    const reason = requiredString(independent.reason, `${path}.reason`).trim();
    if (
      reason.length < 24 ||
      /^(?:has |with )?no tenant (?:column|id)|tenant[- ]independent|not tenant[- ]scoped/iu.test(
        reason,
      )
    ) {
      throw new TenantCompletenessError(
        'TENANT_INDEPENDENT_REASON_INVALID',
        `${path}.reason must explain the platform-wide mechanism or shared immutable identity; absence of a tenant column is not a reason`,
      );
    }
    return {
      classification: 'tenant-independent',
      reason,
      reasonCode: reasonCode as TenantIndependentReasonCode,
      schema: requiredIdentifier(independent.schema, `${path}.schema`),
      table: requiredIdentifier(independent.table, `${path}.table`),
    };
  }
  invalidManifest(`${path}.classification is unknown`);
}

function verifyClassification(
  table: EnumeratedTenantTable,
  classification: TenantTableClassification,
): void {
  const key = tableKey(table.schema, table.table);
  if (classification.classification === 'tenant-independent') {
    if (
      table.schema === 'north_star_module' ||
      table.columns.some(({ name }) => name === 'tenant_id') ||
      key === 'platform.tenants'
    ) {
      throw new TenantCompletenessError(
        'TENANT_INDEPENDENT_BUSINESS_TABLE',
        `${key} is a business or tenant-bearing table and cannot be tenant-independent`,
      );
    }
    return;
  }

  const tenantColumn = table.columns.find(
    ({ name }) => name === classification.tenantColumn,
  );
  if (!tenantColumn) {
    throw new TenantCompletenessError(
      'TENANT_COLUMN_MISSING',
      `${key} names missing tenant column ${classification.tenantColumn}`,
    );
  }
  const isTrustedName =
    classification.tenantColumn === 'tenant_id' ||
    (key === 'platform.tenants' && classification.tenantColumn === 'id');
  if (
    !isTrustedName ||
    tenantColumn.isNullable ||
    tenantColumn.dataType !== 'uuid'
  ) {
    throw new TenantCompletenessError(
      'TENANT_COLUMN_INVALID',
      `${key}.${tenantColumn.name} must be a required uuid trusted tenant identifier`,
    );
  }
}

function exactObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = objectRecord(value, path);
  const actualKeys = Object.keys(record).toSorted();
  const expectedKeys = [...keys].toSorted();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    invalidManifest(`${path} must contain exactly ${expectedKeys.join(', ')}`);
  }
  return record;
}

function objectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidManifest(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredIdentifier(value: unknown, path: string): string {
  const identifier = requiredString(value, path);
  if (!/^[a-z][a-z0-9_]*$/u.test(identifier)) {
    invalidManifest(`${path} must be a lower-snake-case PostgreSQL identifier`);
  }
  return identifier;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalidManifest(`${path} must be a non-empty string`);
  }
  return value;
}

function invalidManifest(message: string): never {
  throw new TenantCompletenessError('TENANT_MANIFEST_INVALID', message);
}

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function compareTables(
  left: EnumeratedTenantTable,
  right: EnumeratedTenantTable,
): number {
  return compareCodeUnits(
    tableKey(left.schema, left.table),
    tableKey(right.schema, right.table),
  );
}

function compareClassifications(
  left: TenantTableClassification,
  right: TenantTableClassification,
): number {
  return compareCodeUnits(
    tableKey(left.schema, left.table),
    tableKey(right.schema, right.table),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
