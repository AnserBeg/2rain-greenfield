import assert from 'node:assert/strict';
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  postgresTestImage,
  removeEphemeralPostgresContainer,
  waitUntilReady,
} from '../helpers/postgres.js';

const postgresLeakVictimPath = 'test/fixtures/postgres-leak-victim.ts';
const postgresContainerGuardPath = 'scripts/guard-ephemeral-postgres.mjs';

interface LeakVictimMarker {
  readonly containerName: string;
  readonly parentPid: number;
  readonly pid: number;
}

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

test('named type imports do not masquerade as authority declarations', () => {
  const root = createArchitectureFixture({
    'package.json': packageManifest('fixture'),
    'packages/runtime/package.json': packageManifest('@north-star/runtime'),
    'packages/runtime/src/authority.ts': 'export class SemanticQueryGateway {}',
    'apps/web/package.json': packageManifest('@north-star/web'),
    'apps/web/src/consumer.ts': [
      "import { type SemanticQueryGateway } from '../../../packages/runtime/src/authority.js';",
      'export function useGateway(gateway: SemanticQueryGateway): void { void gateway; }',
    ].join('\n'),
  });

  try {
    assert.equal(
      checkArchitecture(root).violations.some((violation) =>
        violation.message.includes(
          'duplicate canonical authority declaration SemanticQueryGateway',
        ),
      ),
      false,
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

for (const control of [
  { expectedSignal: 'SIGKILL', label: 'kill -9', signal: 'SIGKILL' },
  { expectedSignal: 'SIGINT', label: 'SIGINT', signal: 'SIGINT' },
  { expectedSignal: 'SIGTERM', label: 'SIGTERM', signal: 'SIGTERM' },
] as const) {
  test(`ephemeral PostgreSQL is removed after harness ${control.label}`, async () => {
    const victim = spawnPostgresLeakVictim('worker');
    const marker = await waitForLeakVictimMarker(victim);
    assertContainerExists(marker.containerName);

    try {
      assert.equal(victim.kill(control.signal), true);
      const [exitCode, signal] = (await once(victim, 'exit')) as [
        number | null,
        NodeJS.Signals | null,
      ];
      assert.equal(exitCode, null);
      assert.equal(signal, control.expectedSignal);
      await assertContainerRemoved(marker.containerName);
    } finally {
      removeContainerIndependently(marker.containerName);
      killProcessIfAlive(marker.pid);
    }
  });
}

test('ephemeral PostgreSQL is removed after an uncaught harness exception', async () => {
  const victim = spawnPostgresLeakVictim('worker');
  const marker = await waitForLeakVictimMarker(victim);
  assertContainerExists(marker.containerName);

  try {
    assert.equal(victim.kill('SIGUSR2'), true);
    const [exitCode, signal] = (await once(victim, 'exit')) as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert.equal(exitCode, 1);
    assert.equal(signal, null);
    await assertContainerRemoved(marker.containerName);
  } finally {
    removeContainerIndependently(marker.containerName);
    killProcessIfAlive(marker.pid);
  }
});

test('ephemeral PostgreSQL is removed when the harness parent is killed', async () => {
  const parent = spawnPostgresLeakVictim('parent');
  const marker = await waitForLeakVictimMarker(parent);
  assertContainerExists(marker.containerName);
  assert.equal(marker.parentPid, parent.pid);

  try {
    assert.equal(parent.kill('SIGKILL'), true);
    const [exitCode, signal] = (await once(parent, 'exit')) as [
      number | null,
      NodeJS.Signals | null,
    ];
    assert.equal(exitCode, null);
    assert.equal(signal, 'SIGKILL');
    await assertContainerRemoved(marker.containerName);
    assertProcessAlive(marker.pid);
  } finally {
    removeContainerIndependently(marker.containerName);
    killProcessIfAlive(marker.pid);
  }
});

test('matrix pre-lock guard sweeps a planted stale PostgreSQL container', async () => {
  const containerName = `north-star-leak-guard-stale-${process.pid}`;
  const lockPath = `/tmp/north-star-leak-guard-stale-${process.pid}.lock`;
  const fakeBin = mkdtempSync(join(tmpdir(), 'north-star-leak-docker-'));
  const dockerPath = execFileSync('which', ['docker'], {
    encoding: 'utf8',
  }).trim();
  const dockerWrapper = join(fakeBin, 'docker');
  startPlantedPostgresContainer(containerName);
  assertContainerExists(containerName);
  writeFileSync(
    dockerWrapper,
    [
      '#!/usr/bin/env bash',
      'set -eu',
      'if [ "${1:-}" = ps ]; then',
      '  exec "$REAL_DOCKER" ps --all --filter "name=^/${TARGET_CONTAINER}$" --format "{{json .ID}}\\t{{json .Names}}"',
      'fi',
      'exec "$REAL_DOCKER" "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(dockerWrapper, 0o755);
  const holder = spawnLockHolder(lockPath);
  await waitForProcessMarker(holder, 'LOCK_READY');

  try {
    const result = spawnSync(
      'bash',
      ['scripts/run-matrix.sh', 'LEAK-STALE-CONTROL', process.cwd()],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NORTH_STAR_CONTAINER_STALE_SECONDS: '0',
          NORTH_STAR_TEST_LOCK_PATH: lockPath,
          NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: '0',
          PATH: `${fakeBin}:${process.env.PATH}`,
          REAL_DOCKER: dockerPath,
          TARGET_CONTAINER: containerName,
        },
      },
    );
    assert.equal(result.status, 75, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`swept stale ${containerName}`, 'u'),
    );
    await assertContainerRemoved(containerName);
  } finally {
    holder.stdin.end();
    await once(holder, 'exit');
    removeContainerIndependently(containerName);
    rmSync(lockPath, { force: true });
    rmSync(fakeBin, { force: true, recursive: true });
  }
});

test('matrix pre-lock guard does not touch a concurrent lane container', async () => {
  const containerName = `north-star-leak-guard-concurrent-${process.pid}`;
  const lockPath = `/tmp/north-star-leak-guard-concurrent-${process.pid}.lock`;
  startPlantedPostgresContainer(containerName);
  assertContainerExists(containerName);
  const holder = spawnLockHolder(lockPath);
  await waitForProcessMarker(holder, 'LOCK_READY');

  try {
    const result = spawnSync(
      'bash',
      ['scripts/run-matrix.sh', 'LEAK-CONCURRENT-CONTROL', process.cwd()],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NORTH_STAR_CONTAINER_POST_LOCK_GRACE_ATTEMPTS: '0',
          NORTH_STAR_CONTAINER_STALE_SECONDS: '3600',
          NORTH_STAR_TEST_LOCK_PATH: lockPath,
          NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: '0',
        },
      },
    );
    assert.equal(result.status, 75, result.stderr);
    assertContainerExists(containerName);
  } finally {
    holder.stdin.end();
    await once(holder, 'exit');
    removeContainerIndependently(containerName);
    rmSync(lockPath, { force: true });
  }
});

test('matrix refuses to start when a recent planted container remains after lock acquisition', async () => {
  const containerName = `north-star-leak-guard-refusal-${process.pid}`;
  const lockPath = `/tmp/north-star-leak-guard-refusal-${process.pid}.lock`;
  startPlantedPostgresContainer(containerName);
  assertContainerExists(containerName);

  try {
    const result = spawnSync(
      'bash',
      ['scripts/run-matrix.sh', 'LEAK-REFUSAL-CONTROL', process.cwd()],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NORTH_STAR_CONTAINER_POST_LOCK_GRACE_ATTEMPTS: '0',
          NORTH_STAR_CONTAINER_STALE_SECONDS: '3600',
          NORTH_STAR_TEST_LOCK_PATH: lockPath,
          NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: '0',
        },
      },
    );
    assert.equal(result.status, 76, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /POSTGRES_CONTAINER_CONTAMINATION/u);
    assert.match(result.stderr, new RegExp(containerName, 'u'));
    assert.match(
      result.stderr,
      new RegExp(`docker rm --force ${containerName}`, 'u'),
    );
    assertContainerExists(containerName);
  } finally {
    removeContainerIndependently(containerName);
    rmSync(lockPath, { force: true });
  }
});

test('matrix container guard refuses an unrecognized Docker inventory row', () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'north-star-leak-parser-'));
  const dockerWrapper = join(fakeBin, 'docker');
  writeFileSync(
    dockerWrapper,
    "#!/usr/bin/env bash\nprintf 'not-a-docker-inventory-row\\n'\n",
  );
  chmodSync(dockerWrapper, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [postgresContainerGuardPath, 'pre-lock'],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      },
    );
    assert.equal(result.status, 74);
    assert.match(
      result.stderr,
      /POSTGRES_CONTAINER_GUARD_FAILED: unrecognized docker ps row/u,
    );
  } finally {
    rmSync(fakeBin, { force: true, recursive: true });
  }
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

function spawnPostgresLeakVictim(
  mode: 'parent' | 'worker',
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--import', 'tsx', postgresLeakVictimPath, mode],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

function waitForLeakVictimMarker(
  child: ChildProcessWithoutNullStreams,
): Promise<LeakVictimMarker> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      reject(
        new Error(
          `PostgreSQL leak victim exited before its marker: code=${String(exitCode)} signal=${String(signal)} stderr=${stderr}`,
        ),
      );
    };
    child.once('exit', onExit);
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /POSTGRES_LEAK_VICTIM=(\{[^\n]+\})\n/u.exec(stdout);
      if (!match) return;
      child.off('exit', onExit);
      resolve(JSON.parse(match[1]!) as LeakVictimMarker);
    });
  });
}

function assertContainerExists(containerName: string): void {
  const inspected = spawnSync(
    'docker',
    ['inspect', '--format', '{{.State.Status}}', containerName],
    { encoding: 'utf8' },
  );
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(inspected.stdout.trim(), 'running');
}

async function assertContainerRemoved(containerName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const inspected = spawnSync('docker', ['inspect', containerName], {
      encoding: 'utf8',
    });
    if (
      inspected.status !== 0 &&
      /no such (?:container|object)/iu.test(inspected.stderr)
    ) {
      return;
    }
    assert.equal(
      inspected.status,
      0,
      `unexpected Docker inspect failure: ${inspected.stderr}`,
    );
    await delay(50);
  }
  assert.fail(`container survived its owner: ${containerName}`);
}

function removeContainerIndependently(containerName: string): void {
  const removed = spawnSync('docker', ['rm', '--force', containerName], {
    encoding: 'utf8',
  });
  if (
    removed.status !== 0 &&
    !/no such (?:container|object)/iu.test(removed.stderr)
  ) {
    assert.fail(`independent container cleanup failed: ${removed.stderr}`);
  }
}

function killProcessIfAlive(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ESRCH'
    ) {
      throw error;
    }
  }
}

function assertProcessAlive(pid: number): void {
  assert.doesNotThrow(() => process.kill(pid, 0));
}

function startPlantedPostgresContainer(containerName: string): void {
  const started = spawnSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--env',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      postgresTestImage,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(started.status, 0, started.stderr);
}

function spawnLockHolder(lockPath: string): ChildProcessWithoutNullStreams {
  return spawn(
    'flock',
    [
      '--no-fork',
      '--exclusive',
      lockPath,
      process.execPath,
      '-e',
      "process.stdout.write('LOCK_READY\\n'); process.stdin.resume()",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

function waitForProcessMarker(
  child: ChildProcessWithoutNullStreams,
  marker: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      reject(
        new Error(
          `process exited before ${marker}: code=${String(exitCode)} signal=${String(signal)} stderr=${stderr}`,
        ),
      );
    };
    child.once('exit', onExit);
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes(marker)) return;
      child.off('exit', onExit);
      resolve();
    });
  });
}
