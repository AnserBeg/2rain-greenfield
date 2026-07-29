import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { SchemaSnapshot } from '../../postgres-provider/src/migrations.js';

import {
  enumerateTenantTablesFromSnapshot,
  formatTenantClassifications,
  parseTenantCompletenessManifest,
  verifyTenantCompleteness,
} from './tenant-completeness.js';

const manifestPath =
  argumentValue('--manifest') ??
  'test/architecture/tenant-completeness.manifest.json';
const snapshotPath = argumentValue('--snapshot') ?? 'db/schema.snapshot.json';
const recognizedArguments = new Set(['--list', '--manifest', '--snapshot']);

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument || !recognizedArguments.has(argument)) {
    failUsage(`unknown argument ${String(argument)}`);
  }
  if (argument === '--manifest' || argument === '--snapshot') index += 1;
}

async function main(): Promise<void> {
  const manifest = parseTenantCompletenessManifest(
    JSON.parse(await readFile(resolve(manifestPath), 'utf8')) as unknown,
  );
  const snapshot = JSON.parse(
    await readFile(resolve(snapshotPath), 'utf8'),
  ) as SchemaSnapshot;
  const verified = verifyTenantCompleteness(
    manifest,
    enumerateTenantTablesFromSnapshot(snapshot),
  );

  process.stdout.write(
    `tenant-completeness: PASS (${String(verified.tableCount)} tables; ${String(verified.tenantScopedCount)} tenant-scoped; ${String(verified.tenantIndependentCount)} tenant-independent)\n`,
  );
  if (process.argv.includes('--list')) {
    process.stdout.write(formatTenantClassifications(verified));
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    failUsage(`${name} requires a path`);
  }
  return value;
}

function failUsage(message: string): never {
  process.stderr.write(
    `${message}\nusage: node --import tsx packages/dev-tooling/src/check-tenant-completeness.ts [--manifest PATH] [--snapshot PATH] [--list]\n`,
  );
  process.exit(2);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
