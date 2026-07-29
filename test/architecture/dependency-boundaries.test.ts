import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { preProcessFile } from 'typescript';

import { checkArchitecture } from '../../packages/dev-tooling/src/architecture-boundaries.js';
import {
  createArchitectureFixture,
  packageManifest,
  removeArchitectureFixture,
} from '../helpers/architecture-fixture.js';
import {
  classifyEphemeralPostgresContainerState,
  inspectEphemeralPostgresContainer,
  isEphemeralPostgresReadyInsideContainer,
  removeEphemeralPostgresContainer,
  waitUntilReady,
} from '../helpers/postgres.js';

test('the greenfield repository satisfies executable architecture boundaries', () => {
  assert.deepEqual(checkArchitecture(process.cwd()).violations, []);
});

test('plain workspace edges and protected provider imports fail', () => {
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
      pg: '1.0.0',
    }),
    'packages/compiler/src/provider.ts':
      "import { Client } from 'pg';\nexport const client = Client;",
  });

  try {
    const violations = checkArchitecture(root).violations;
    const ruleIds = new Set(violations.map((violation) => violation.ruleId));
    assert.ok(ruleIds.has('BND001_WORKSPACE_DIRECTION'));
    assert.ok(ruleIds.has('BND002_PROTECTED_IMPORT'));
    assert.ok(
      violations.some((violation) =>
        violation.file.endsWith('packages/domain-sales/package.json'),
      ),
    );
    assert.ok(
      violations.some((violation) =>
        violation.file.endsWith('packages/compiler/src/provider.ts'),
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('plain framework and alternate authority declarations fail', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture', {
      '@agent-native/core': '1.0.0',
    }),
    'packages/runtime/package.json': packageManifest('@north-star/runtime'),
    'packages/runtime/src/authority-a.ts': [
      "import '@agent-native/core/runtime';",
      'export class AgentNativeCoreFacade {}',
      "export const globalActiveRelease = 'release-1';",
      'export const actionRegistry = new Map();',
      'export const universalAuditJournal = [];',
      'export interface ActiveReleasePointer { releaseId: string }',
    ].join('\n'),
    'packages/runtime/src/authority-b.ts':
      'export interface ActiveReleasePointer { releaseId: string }',
  });

  try {
    const violations = checkArchitecture(root).violations;
    const ruleIds = new Set(violations.map((violation) => violation.ruleId));
    assert.ok(ruleIds.has('AUTH001_AGENT_NATIVE_CORE'));
    assert.ok(ruleIds.has('AUTH002_RELEASE_AUTHORITY'));
    assert.ok(ruleIds.has('AUTH003_GATEWAY_BYPASS'));
    assert.ok(ruleIds.has('AUTH007_DUPLICATE_TRUST'));
    assert.ok(
      violations.some((violation) =>
        violation.message.includes('duplicate canonical authority'),
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('plain gateway, inventory, and hard-delete violations fail', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'apps/api/package.json': packageManifest('@north-star/api'),
    'apps/api/src/route.ts': "export const rows = db.query('select 1');",
    'packages/domain-sales/package.json': packageManifest(
      '@north-star/domain-sales',
    ),
    'packages/domain-sales/src/write.ts':
      "export const sql = 'UPDATE inventory_balance SET quantity = 0';",
    'packages/domain-inventory/package.json': packageManifest(
      '@north-star/domain-inventory',
    ),
    'packages/domain-inventory/src/delete.ts': [
      "export const sql = 'DELETE FROM inventory_movement';",
      'export function hardDeleteBusinessRecord() {}',
    ].join('\n'),
  });

  try {
    const violations = checkArchitecture(root).violations;
    const ruleIds = new Set(violations.map((violation) => violation.ruleId));
    assert.ok(ruleIds.has('AUTH003_GATEWAY_BYPASS'));
    assert.ok(ruleIds.has('AUTH004_INVENTORY_PEER'));
    assert.ok(ruleIds.has('AUTH006_HARD_DELETE'));
  } finally {
    removeArchitectureFixture(root);
  }
});

test('inventory append ownership follows the consolidated domain module path', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'packages/domain/package.json': packageManifest('@north-star/domain'),
    'packages/domain/src/inventory/append.ts': [
      "export const movement = 'INSERT INTO inventory_movement VALUES (1)';",
      "export const reservation = 'INSERT INTO inventory_reservation VALUES (1)';",
    ].join('\n'),
    'packages/domain/src/inventory/balance.ts':
      "export const sql = 'INSERT INTO inventory_balance VALUES (1)';",
    'packages/domain/src/inventory/delete.ts':
      "export const sql = 'DELETE FROM inventory_movement';",
    'packages/domain/src/inventory/quantity.ts':
      "export const sql = 'INSERT INTO inventory_quantity VALUES (1)';",
    'packages/domain/src/inventory/rewrite.ts':
      "export const sql = `UPDATE inventory_movement SET memo = 'changed'`;",
    'packages/domain/src/inventory/stock.ts':
      "export const sql = 'INSERT INTO inventory_stock VALUES (1)';",
    'packages/domain/src/sales/post.ts':
      "export const sql = 'INSERT INTO inventory_movement VALUES (1)';",
    'packages/domain-inventory/package.json': packageManifest(
      '@north-star/domain-inventory',
    ),
    'packages/domain-inventory/src/post.ts':
      "export const sql = 'INSERT INTO inventory_movement VALUES (1)';",
  });

  try {
    const violations = checkArchitecture(root).violations;
    const rulesFor = (path: string) =>
      violations
        .filter((violation) => violation.file.endsWith(path))
        .map((violation) => violation.ruleId)
        .sort();
    assert.deepEqual(rulesFor('packages/domain/src/inventory/append.ts'), []);
    assert.deepEqual(rulesFor('packages/domain/src/inventory/rewrite.ts'), [
      'AUTH004_INVENTORY_PEER',
    ]);
    assert.deepEqual(rulesFor('packages/domain/src/inventory/delete.ts'), [
      'AUTH004_INVENTORY_PEER',
      'AUTH006_HARD_DELETE',
    ]);
    for (const path of ['balance.ts', 'quantity.ts', 'stock.ts']) {
      assert.deepEqual(rulesFor(`packages/domain/src/inventory/${path}`), [
        'AUTH004_INVENTORY_PEER',
      ]);
    }
    assert.deepEqual(rulesFor('packages/domain/src/sales/post.ts'), [
      'AUTH003_GATEWAY_BYPASS',
    ]);
    assert.deepEqual(rulesFor('packages/domain-inventory/src/post.ts'), [
      'AUTH003_GATEWAY_BYPASS',
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('ephemeral PostgreSQL readiness observes terminal states and Docker failures exactly', async () => {
  for (const state of ['created', 'paused', 'restarting', 'running']) {
    assert.equal(classifyEphemeralPostgresContainerState(state), 'waiting');
  }
  for (const state of ['dead', 'exited', 'removed', 'removing']) {
    assert.equal(classifyEphemeralPostgresContainerState(state), 'terminal');
  }
  assert.throws(
    () => classifyEphemeralPostgresContainerState('unknown'),
    /unexpected container state/,
  );

  const containerName = 'north-star-control';
  const missing = new Error('docker inspect failed', {
    cause: {
      stderr: `Error response from daemon: No such container: ${containerName}`,
    },
  });
  const daemonUnavailable = new Error('docker inspect failed', {
    cause: { stderr: 'Cannot connect to the Docker daemon' },
  });
  const missingRunner = async (): Promise<never> => {
    throw missing;
  };
  const unavailableRunner = async (): Promise<never> => {
    throw daemonUnavailable;
  };
  const notReady = new Error('docker exec failed', {
    cause: { code: 2, stderr: '', stdout: '127.0.0.1:5432 - no response' },
  });
  const notReadyRunner = async (): Promise<never> => {
    throw notReady;
  };
  const readyRunner = async (arguments_: readonly string[]) => {
    assert.deepEqual(arguments_, [
      'exec',
      containerName,
      'pg_isready',
      '--host',
      '127.0.0.1',
      '--port',
      '5432',
      '--username',
      'postgres',
      '--dbname',
      'postgres',
    ]);
    return { stderr: '', stdout: '127.0.0.1:5432 - accepting connections' };
  };

  assert.equal(
    await inspectEphemeralPostgresContainer(containerName, missingRunner),
    'removed',
  );
  await removeEphemeralPostgresContainer(containerName, missingRunner);
  await assert.rejects(
    inspectEphemeralPostgresContainer(containerName, unavailableRunner),
    (error: unknown) => error === daemonUnavailable,
  );
  await assert.rejects(
    removeEphemeralPostgresContainer(containerName, unavailableRunner),
    (error: unknown) => error === daemonUnavailable,
  );
  assert.equal(
    await isEphemeralPostgresReadyInsideContainer(
      containerName,
      notReadyRunner,
    ),
    false,
  );
  assert.equal(
    await isEphemeralPostgresReadyInsideContainer(containerName, readyRunner),
    true,
  );
  await assert.rejects(
    isEphemeralPostgresReadyInsideContainer(containerName, unavailableRunner),
    (error: unknown) => error === daemonUnavailable,
  );
});

test('ephemeral PostgreSQL readiness retries a refused published endpoint after internal readiness', async () => {
  const refused = new Error('connect ECONNREFUSED 127.0.0.1:5432');
  let now = 0;
  let pauseCount = 0;
  let probeCount = 0;
  let logReadCount = 0;

  await waitUntilReady({}, 'north-star-race-control', {
    deadlineMilliseconds: 1_000,
    inspectContainer: async () => 'running',
    isReadyInsideContainer: async () => true,
    now: () => now,
    pause: async (milliseconds) => {
      pauseCount += 1;
      now += milliseconds;
    },
    probePublished: async () => {
      probeCount += 1;
      return probeCount < 3 ? refused : undefined;
    },
    readContainerLogs: async () => {
      logReadCount += 1;
      return { stderr: 'stderr control', stdout: 'stdout control' };
    },
  });

  assert.equal(probeCount, 3);
  assert.equal(pauseCount, 1);
  assert.equal(logReadCount, 0);
});

test('ephemeral PostgreSQL readiness reports a persistently refused endpoint only at its deadline', async () => {
  const refused = new Error('connect ECONNREFUSED 127.0.0.1:5432');
  let now = 0;
  let pauseCount = 0;
  let probeCount = 0;
  let logReadCount = 0;

  await assert.rejects(
    waitUntilReady({}, 'north-star-deadline-control', {
      deadlineMilliseconds: 250,
      inspectContainer: async () => 'running',
      isReadyInsideContainer: async () => true,
      now: () => now,
      pause: async (milliseconds) => {
        pauseCount += 1;
        now += milliseconds;
      },
      probePublished: async () => {
        probeCount += 1;
        return refused;
      },
      readContainerLogs: async () => {
        logReadCount += 1;
        return { stderr: 'stderr control', stdout: 'stdout control' };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /ready inside its container but its published endpoint is unavailable/,
      );
      assert.match(error.message, /ECONNREFUSED/);
      assert.match(error.message, /stdout controlstderr control/);
      return true;
    },
  );

  assert.equal(probeCount, 6);
  assert.equal(pauseCount, 3);
  assert.equal(logReadCount, 1);
});

test('plain raw, sixth, and wrong-count agent tool catalogs fail', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'packages/runtime/package.json': packageManifest('@north-star/runtime'),
    'packages/runtime/generated/operations-agent-tool-profile.json':
      JSON.stringify({
        profile: 'operations-agent',
        tools: [
          'erp_discover',
          'erp_execute',
          'erp_plan',
          'erp_query',
          'erp_verify',
          'erp_verify',
        ],
      }),
    'packages/runtime/generated/model-facing-tool-catalog.json': JSON.stringify(
      { tools: ['inventory_lookup'] },
    ),
    'packages/runtime/src/agent-tools.ts': [
      "export const sixth = 'erp_delete';",
      'export const rawDatabaseTool = {};',
    ].join('\n'),
  });

  try {
    const violations = checkArchitecture(root).violations;
    assert.ok(
      violations.some(
        (violation) =>
          violation.ruleId === 'AUTH005_AGENT_TOOL' &&
          violation.message.includes('inventory_lookup'),
      ),
    );
    assert.ok(
      violations.some((violation) =>
        violation.message.includes('exactly the five distinct'),
      ),
    );
    assert.ok(
      violations.some((violation) =>
        violation.message.includes('raw or administrative'),
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

test('the CLI exits non-zero with stable file and rule evidence', () => {
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

test('the PostgreSQL provider has no misleading root export or bare consumers', () => {
  const manifest = JSON.parse(
    readFileSync(
      join(process.cwd(), 'packages/postgres-provider/package.json'),
      'utf8',
    ),
  ) as { exports: Record<string, string> };
  assert.equal(manifest.exports['.'], undefined);

  const tracked = spawnSync('git', ['ls-files', '-z'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  const bareConsumers = tracked.stdout
    .split('\0')
    .filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path))
    .flatMap((path) => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      return preProcessFile(source, true, true)
        .importedFiles.filter(
          (importedFile) =>
            importedFile.fileName === '@north-star/postgres-provider',
        )
        .map(() => path);
    });
  assert.deepEqual(bareConsumers, []);
});
