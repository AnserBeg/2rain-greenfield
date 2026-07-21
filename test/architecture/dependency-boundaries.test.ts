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
    'packages/compiler/package.json': packageManifest('@north-star/compiler', {
      '@neondatabase/serverless': '1.0.0',
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
      2,
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('framework and alternate application authorities fail closed', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture', {
      legacy: 'npm:@agent-native/core@1.0.0',
    }),
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
    const ruleIds = new Set(
      checkArchitecture(root).violations.map((violation) => violation.ruleId),
    );
    assert.ok(ruleIds.has('AUTH001_AGENT_NATIVE_CORE'));
    assert.ok(ruleIds.has('AUTH002_RELEASE_AUTHORITY'));
    assert.ok(ruleIds.has('AUTH003_GATEWAY_BYPASS'));
    assert.ok(ruleIds.has('AUTH007_DUPLICATE_TRUST'));
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
    'dist/generated/model-facing-tool-catalog.json': JSON.stringify({
      tools: ['shell_tool'],
    }),
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
  } finally {
    removeArchitectureFixture(root);
  }
});

test('API, worker, SQL, and cross-domain write bypasses fail closed', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'apps/api/package.json': packageManifest('@north-star/api'),
    'apps/api/src/route.ts': "export const rows = client.query('select 1');",
    'apps/worker/package.json': packageManifest('@north-star/worker'),
    'apps/worker/src/job.ts':
      'export const removed = repository.delete(orderId);',
    'packages/domain-sales/package.json': packageManifest(
      '@north-star/domain-sales',
    ),
    'packages/domain-sales/src/write.ts':
      "export const read = 'SELECT * FROM inventory_movement';\nexport const sql = 'UPDATE inventory_balance SET quantity = 0';\nexport const peer = prisma.inventoryBalance.update({});",
    'db/migrations/001-delete.sql': 'DELETE FROM sales_order;',
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
          violation.file.endsWith('packages/domain-sales/src/write.ts') &&
          violation.message.includes('cross-domain table'),
      ),
    );
    assert.ok(
      violations.some((violation) =>
        violation.file.endsWith('db/migrations/001-delete.sql'),
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
      'export interface ActiveReleasePointer { releaseId: string }',
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
