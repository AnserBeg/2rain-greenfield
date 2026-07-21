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
    'packages/compiler/package.json': packageManifest('@north-star/compiler'),
    'packages/compiler/src/provider.ts':
      "import { Client } from 'pg';\nexport const client = Client;",
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
      '@agent-native/core': '1.0.0',
    }),
    'packages/runtime/package.json': packageManifest('@north-star/runtime'),
    'packages/runtime/src/authority.ts': [
      "export const globalActiveRelease = 'release-1';",
      'export const loadActionsFromStaticRegistry = () => [];',
      'export const universalAuditJournal = [];',
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
      { tools: ['erp_query', 'erp_delete', 'rawDatabaseTool'] },
      null,
      2,
    ),
  });

  try {
    const ruleIds = new Set(
      checkArchitecture(root).violations.map((violation) => violation.ruleId),
    );
    assert.ok(ruleIds.has('AUTH004_INVENTORY_PEER'));
    assert.ok(ruleIds.has('AUTH005_AGENT_TOOL'));
    assert.ok(ruleIds.has('AUTH006_HARD_DELETE'));
  } finally {
    removeArchitectureFixture(root);
  }
});

test('the CLI exits non-zero and reports stable rule evidence', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'packages/compiler/package.json': packageManifest('@north-star/compiler'),
    'packages/compiler/src/provider.ts':
      "import { Client } from 'pg';\nexport const client = Client;",
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
