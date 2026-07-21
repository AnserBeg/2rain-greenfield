import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { checkArchitecture } from '../../packages/dev-tooling/src/architecture-boundaries.js';
import {
  createArchitectureFixture,
  packageManifest,
  removeArchitectureFixture,
} from '../helpers/architecture-fixture.js';

test('the greenfield repository satisfies executable architecture boundaries', () => {
  const result = checkArchitecture(process.cwd());
  assert.deepEqual(result.violations, []);
});

test('protected packages reject forbidden workspace and provider imports', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'packages/canonical-model/package.json': packageManifest(
      '@north-star/canonical-model',
    ),
    'packages/domain-inventory/package.json': packageManifest(
      '@north-star/domain-inventory',
    ),
    'packages/domain-inventory/src/index.ts': 'export const inventory = true;',
    'packages/domain-sales/package.json': packageManifest(
      '@north-star/domain-sales',
      { '@north-star/domain-inventory': 'workspace:*' },
    ),
    'packages/domain-sales/src/index.ts':
      "import '@north-star/domain-inventory';\nexport const sales = true;",
    'packages/compiler/package.json': JSON.stringify({
      name: '@north-star/compiler',
      private: true,
      dependencies: {
        zod: 'workspace:@north-star/domain-inventory@*',
        malformed: { target: '@north-star/canonical-model' },
      },
      devDependencies: { slonik: '1.0.0' },
    }),
    'packages/compiler/src/provider.ts':
      "import { neon } from '@neondatabase/serverless';\nexport const client = neon;",
  });

  try {
    const violations = checkArchitecture(root).violations;
    const ruleIds = new Set(violations.map((violation) => violation.ruleId));
    assert.ok(ruleIds.has('BND001_WORKSPACE_DIRECTION'));
    assert.ok(ruleIds.has('BND002_PROTECTED_IMPORT'));
    assert.equal(
      violations.filter(
        (violation) => violation.ruleId === 'BND001_WORKSPACE_DIRECTION',
      ).length,
      3,
    );
    assert.ok(ruleIds.has('CFG004_DEPENDENCY_TARGET'));
  } finally {
    removeArchitectureFixture(root);
  }
});

test('framework and alternate application authorities fail closed', () => {
  const root = createArchitectureFixture({
    'package.json':
      '{"name":"fixture","private":true,"dependencies":{"legacy":"npm:@agent-native\\u002fcore@1.0.0","patched":"patch:@agent-native\\u002fcore@1.0.0#./fix.patch"},"pnpm":{"overrides":{"@agent-native\\u002fcore":"1.0.0"}}}',
    'packages/runtime/package.json': packageManifest('@north-star/runtime'),
    'packages/runtime/src/authority.ts': [
      "import '@agent-native/core/runtime';",
      'export class AgentNativeCoreFacade {}',
      "export const tenantPackageOverlay = 'release-1';",
      'export const actionRegistry = new Map();',
      'export const BusinessAuditLedger = [];',
    ].join('\n'),
  });

  try {
    const violations = checkArchitecture(root).violations;
    const ruleIds = new Set(violations.map((violation) => violation.ruleId));
    assert.ok(ruleIds.has('AUTH001_AGENT_NATIVE_CORE'));
    assert.ok(ruleIds.has('AUTH002_RELEASE_AUTHORITY'));
    assert.ok(ruleIds.has('AUTH003_GATEWAY_BYPASS'));
    assert.ok(ruleIds.has('AUTH007_DUPLICATE_TRUST'));
    assert.ok(
      violations.some(
        (violation) =>
          violation.file === 'package.json' &&
          violation.message.includes('parsed manifest'),
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('unnamed, duplicate, and unclassified packages fail closed', () => {
  const duplicateManifest = packageManifest('@north-star/duplicate');
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'packages/mystery/package.json': JSON.stringify({ private: true }),
    'packages/mystery/src/provider.ts': "import '@neondatabase/serverless';",
    'packages/unknown-a/package.json': duplicateManifest,
    'packages/unknown-b/package.json': duplicateManifest,
  });

  try {
    const ruleIds = new Set(
      checkArchitecture(root).violations.map((violation) => violation.ruleId),
    );
    assert.ok(ruleIds.has('CFG002_PACKAGE_IDENTITY'));
    assert.ok(ruleIds.has('CFG003_PACKAGE_CLASSIFICATION'));
    assert.ok(ruleIds.has('BND002_PROTECTED_IMPORT'));
  } finally {
    removeArchitectureFixture(root);
  }
});

test('inventory peers, hard deletes, and prohibited agent tools fail closed', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'packages/domain-inventory/package.json': packageManifest(
      '@north-star/domain-inventory',
    ),
    'packages/domain-inventory/src/inventory.ts': [
      'export const currentQuantity = 10;',
      'export function hardDeleteBusinessRecord() {}',
    ].join('\n'),
    'packages/runtime/package.json': packageManifest('@north-star/runtime'),
    'packages/runtime/generated/model-facing-tool-catalog.json': JSON.stringify(
      { tools: ['erp_query', 'inventory_lookup', 'raw_database_tool'] },
      null,
      2,
    ),
    'packages/runtime/generated/operations-agent-tool-profile.json':
      JSON.stringify({
        tools: ['erp_discover', 'erp_execute', 'erp_plan', 'erp_query'],
      }),
    'packages/runtime/generated/model-facing-standalone-tool-schema.json':
      JSON.stringify({ name: 'inventory_lookup', inputSchema: {} }),
    'dist/generated/model-facing-tool-catalog.json': JSON.stringify({
      tools: ['shell_tool'],
    }),
    'dist/generated/model-facing-standalone-tool-schema.js':
      "export const schema = { name: 'inventory_lookup' };",
  });

  try {
    const violations = checkArchitecture(root).violations;
    const ruleIds = new Set(violations.map((violation) => violation.ruleId));
    assert.ok(ruleIds.has('AUTH004_INVENTORY_PEER'));
    assert.ok(ruleIds.has('AUTH005_AGENT_TOOL'));
    assert.ok(ruleIds.has('AUTH006_HARD_DELETE'));
    assert.ok(
      violations.some((violation) =>
        violation.message.includes('must contain exactly the five'),
      ),
    );
    assert.ok(
      violations.some((violation) =>
        violation.file.endsWith('model-facing-standalone-tool-schema.json'),
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('API, worker, SQL, and cross-domain write bypasses fail closed', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'apps/api/package.json': packageManifest('@north-star/api'),
    'apps/api/src/route.ts':
      'export const rows = prisma.salesOrder.findMany();',
    'apps/worker/package.json': packageManifest('@north-star/worker'),
    'apps/worker/src/job.ts': [
      'export const removed = repository.clear();',
      'export const purge = repository.createQueryBuilder().delete().from(orderTable);',
    ].join('\n'),
    'packages/domain-sales/package.json': packageManifest(
      '@north-star/domain-sales',
    ),
    'packages/domain-sales/src/write.ts':
      "export const read = 'SELECT * FROM inventory.movements';\nexport const sql = 'UPDATE inventory_balance SET quantity = 0';\nexport const peer = prisma.inventoryBalance.update({});",
    'db/migrations/001-delete.sql':
      'DELETE FROM sales_order;\nTRUNCATE TABLE purchasing_order;',
  });

  try {
    const violations = checkArchitecture(root).violations;
    const ruleIds = new Set(violations.map((violation) => violation.ruleId));
    assert.ok(ruleIds.has('AUTH003_GATEWAY_BYPASS'));
    assert.ok(ruleIds.has('AUTH004_INVENTORY_PEER'));
    assert.ok(ruleIds.has('AUTH006_HARD_DELETE'));
    assert.ok(
      violations.some(
        (violation) =>
          violation.file.endsWith('apps/api/src/route.ts') &&
          violation.ruleId === 'AUTH003_GATEWAY_BYPASS',
      ),
    );
    assert.ok(
      violations.some(
        (violation) =>
          violation.file.endsWith('packages/domain-sales/src/write.ts') &&
          violation.message.includes('cross-domain table'),
      ),
    );
    assert.ok(
      violations.some((violation) =>
        violation.file.endsWith('db/migrations/001-delete.sql'),
      ),
    );
    assert.ok(
      violations.some((violation) => violation.message.includes('TRUNCATE')),
    );
    assert.ok(
      violations.some(
        (violation) =>
          violation.file.endsWith('apps/worker/src/job.ts') &&
          violation.ruleId === 'AUTH006_HARD_DELETE',
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('canonical authorities are unique and live only in owning packages', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'packages/platform-runtime/package.json': packageManifest(
      '@north-star/platform-runtime',
    ),
    'packages/platform-runtime/src/release.ts':
      'export interface ActiveReleasePointer { releaseId: string }',
    'packages/domain-sales/package.json': packageManifest(
      '@north-star/domain-sales',
    ),
    'packages/domain-sales/src/alternate.ts': [
      "export let ActiveReleasePointer = 'release-2';",
      "export { pointer as TenantRelease } from './pointer.js';",
      'export interface BusinessChangeDocument { id: string }',
    ].join('\n'),
  });

  try {
    const violations = checkArchitecture(root).violations;
    assert.ok(
      violations.some(
        (violation) =>
          violation.ruleId === 'AUTH002_RELEASE_AUTHORITY' &&
          violation.message.includes('duplicate canonical authority'),
      ),
    );
    assert.ok(
      violations.some(
        (violation) =>
          violation.ruleId === 'AUTH002_RELEASE_AUTHORITY' &&
          violation.message.includes('TenantRelease') &&
          violation.message.includes('outside'),
      ),
    );
    assert.ok(
      violations.some(
        (violation) =>
          violation.ruleId === 'AUTH007_DUPLICATE_TRUST' &&
          violation.message.includes('outside its sole authority package'),
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('the CLI exits non-zero and reports stable rule evidence', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'packages/compiler/package.json': packageManifest('@north-star/compiler'),
    'packages/compiler/src/provider.ts':
      "import { neon } from '@neondatabase/serverless';\nexport const client = neon;",
    'dist/generated/model-facing-tool-catalog.js':
      "export const tools = ['erp_discover', 'erp_execute', 'erp_plan', 'erp_query', 'erp_verify', 'inventory_lookup'];",
  });

  try {
    const cli = join(
      process.cwd(),
      'packages/dev-tooling/src/check-boundaries.ts',
    );
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', cli, '--root', root],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BND002_PROTECTED_IMPORT/);
    assert.match(result.stderr, /packages\/compiler\/src\/provider\.ts:1/);
    assert.match(result.stderr, /AUTH005_AGENT_TOOL/);
    assert.match(
      result.stderr,
      /dist\/generated\/model-facing-tool-catalog\.js:1/,
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('the root test command includes the architecture gate', () => {
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts.test ?? '', /test:architecture/);
});
