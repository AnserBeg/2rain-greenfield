import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { APPLICATION_IDS } from '../../packages/domain/src/app/builder.js';
import {
  composedApplicationSeed,
  type ComposedApplicationSeedRecord,
} from '../../packages/domain/src/app/seed.js';
import { runShutdown } from '../../apps/api/src/dev-lifecycle.js';
import {
  DEFAULT_DEV_CONTAINER_NAME,
  DEV_CONTAINER_VARIABLE,
  RESERVED_CONTAINER_PREFIX,
  RETIRED_CONTAINER_VARIABLE,
  resolveDevContainer,
} from '../../apps/api/src/dev-container.js';

/**
 * The seed and the dev server's printed URLs are checked against the COMPILED
 * RELEASE, not against `APPLICATION_IDS`.
 *
 * That distinction is the whole point of this file. `APPLICATION_IDS` is a
 * second, hand-maintained spelling of identifiers the module definitions build
 * privately through their own `ids(namespace)` factories — nothing makes the
 * two agree. Asserting the seed against `APPLICATION_IDS` would compare a
 * table with itself. The compiled application release is the program's stated
 * authority for what the application contains, so it is what this reads.
 */
const compiledPath = resolve('apps/web/release/app.compiled.json');

interface DeclaredIdentifiers {
  readonly fieldIds: ReadonlySet<string>;
  readonly optionIdsByFieldId: ReadonlyMap<string, ReadonlySet<string>>;
  readonly operationIds: ReadonlySet<string>;
  readonly surfaceIds: ReadonlySet<string>;
}

function declaredIdentifiers(): DeclaredIdentifiers {
  const envelope = JSON.parse(readFileSync(compiledPath, 'utf8')) as {
    applications: { normalizedDefinitionBytesBase64: string }[];
  };
  const head = envelope.applications.at(-1);
  assert.ok(head, 'the compiled application release carries no application');
  const definition = JSON.parse(
    Buffer.from(head.normalizedDefinitionBytesBase64, 'base64').toString(
      'utf8',
    ),
  ) as {
    fields: {
      fieldId: string;
      fieldType: { kind: string; options?: { optionId: string }[] };
    }[];
    operations: { operationId: string }[];
    surfaces: { surfaceId: string }[];
  };
  const optionIdsByFieldId = new Map<string, ReadonlySet<string>>();
  for (const field of definition.fields) {
    if (field.fieldType.kind === 'enumFieldType' && field.fieldType.options) {
      optionIdsByFieldId.set(
        field.fieldId,
        new Set(field.fieldType.options.map((option) => option.optionId)),
      );
    }
  }
  return {
    fieldIds: new Set(definition.fields.map((field) => field.fieldId)),
    operationIds: new Set(
      definition.operations.map((operation) => operation.operationId),
    ),
    optionIdsByFieldId,
    surfaceIds: new Set(
      definition.surfaces.map((surface) => surface.surfaceId),
    ),
  };
}

/**
 * The seed as it stood before it was authored beside the modules, recorded
 * here as a literal so the equality below compares against something the seed
 * cannot move. Deriving it from `composedApplicationSeed` would be the
 * "expectation read from its own subject" defect.
 */
const previousInlineSeed: readonly ComposedApplicationSeedRecord[] = (() => {
  const namespace = 'northstar.app';
  const entry = (
    localEntity: string,
    ordinal: number,
    values: Record<string, string>,
  ): ComposedApplicationSeedRecord => {
    const suffix = String(ordinal).padStart(12, '0');
    return {
      idempotencyKey: `72000000-0000-4000-8000-${suffix}`,
      operationId: `${namespace}:operation.${localEntity}_create`,
      recordId: `71000000-0000-4000-8000-${suffix}`,
      values: Object.fromEntries(
        Object.entries(values).map(([local, value]) => [
          `${namespace}:field.${local}`,
          value,
        ]),
      ),
    };
  };
  return [
    entry('party', 1, {
      party_contact_summary: 'Purchasing · ap@alpine.example',
      party_name: 'Alpine Office Supply',
      party_number: 'P-1001',
    }),
    entry('party', 2, {
      party_contact_summary: 'Wholesale · orders@northwind.example',
      party_name: 'Northwind Goods',
      party_number: 'P-1002',
    }),
    entry('party', 3, {
      party_contact_summary: 'Local delivery · hello@prairie.example',
      party_name: 'Prairie Paper Co.',
      party_number: 'P-1003',
    }),
    entry('party', 4, {
      party_contact_summary: 'Preferred supplier · team@summit.example',
      party_name: 'Summit Industrial',
      party_number: 'P-1004',
    }),
    entry('item', 11, {
      item_base_unit: 'EA',
      item_description: 'Recycled ruled notebook, 80 pages',
      item_name: 'Field notebook',
      item_sku: 'OFF-100',
    }),
    entry('item', 12, {
      item_base_unit: 'BOX',
      item_description: 'Black fine-point pens, pack of twelve',
      item_name: 'Fine-point pen set',
      item_sku: 'OFF-120',
    }),
    entry('item', 13, {
      item_base_unit: 'EA',
      item_description: 'Adjustable task lamp, forest green',
      item_name: 'Task lamp',
      item_sku: 'OFF-210',
    }),
    entry('item', 14, {
      item_base_unit: 'PACK',
      item_description: 'Compostable shipping labels, pack of 100',
      item_name: 'Shipping labels',
      item_sku: 'OPS-310',
    }),
    entry('location', 21, {
      location_code: 'CAL-WH',
      location_name: 'Calgary warehouse',
      location_type: `${namespace}:option.warehouse`,
    }),
    entry('location', 22, {
      location_code: 'EDM-ST',
      location_name: 'Edmonton store',
      location_type: `${namespace}:option.store`,
    }),
    entry('location', 23, {
      location_code: 'VAN-WH',
      location_name: 'Vancouver warehouse',
      location_type: `${namespace}:option.warehouse`,
    }),
    entry('location', 24, {
      location_code: 'YYC-ST',
      location_name: 'Beltline store',
      location_type: `${namespace}:option.store`,
    }),
  ];
})();

test('the demo profile serializes identically to the seed it replaced', () => {
  const demo = composedApplicationSeed('demo');
  // Exact serialized equality, not deepEqual. deepEqual ignores property
  // insertion order, so it cannot distinguish a values map whose keys were
  // reordered — and JSON.stringify, which is how these reach the wire, can.
  assert.equal(
    JSON.stringify(demo),
    JSON.stringify(previousInlineSeed),
    'the demo profile is the browser suite’s subject; changing its bytes changes a reviewed test',
  );
  assert.equal(demo.length, 12);
});

test('the distributor profile extends the demo profile without altering it', () => {
  const demo = composedApplicationSeed('demo');
  const distributor = composedApplicationSeed('distributor');
  assert.equal(
    JSON.stringify(distributor.slice(0, demo.length)),
    JSON.stringify(demo),
    'the distributor profile must be a prefix-preserving superset of demo',
  );
  assert.ok(
    distributor.length > demo.length,
    'the distributor profile adds no records',
  );
  const recordIds = new Set(distributor.map((record) => record.recordId));
  assert.equal(
    recordIds.size,
    distributor.length,
    'two seed records share a record identifier',
  );
  const keys = new Set(distributor.map((record) => record.idempotencyKey));
  assert.equal(
    keys.size,
    distributor.length,
    'two seed records share an idempotency key',
  );
});

test('the distributor profile fills a list past its declared page size', () => {
  // 100 is the modules' declared maximumResultCount. Below it the item list
  // renders no "Next page" link and the dev environment cannot show a human
  // that pagination works at all.
  const items = composedApplicationSeed('distributor').filter(
    (record) =>
      record.operationId === APPLICATION_IDS.catalog.createOperationId,
  );
  assert.ok(
    items.length > 100,
    `the item seed must exceed the declared page size of 100; got ${String(items.length)}`,
  );
});

test('every seeded identifier exists in the compiled application release', () => {
  const declared = declaredIdentifiers();
  const seed = composedApplicationSeed('distributor');
  assert.ok(seed.length > 0, 'the seed is empty, so this gate read nothing');
  let checkedOptions = 0;
  for (const record of seed) {
    assert.ok(
      declared.operationIds.has(record.operationId),
      `seed operation ${record.operationId} is not in the compiled release`,
    );
    for (const [fieldId, value] of Object.entries(record.values)) {
      assert.ok(
        declared.fieldIds.has(fieldId),
        `seed field ${fieldId} is not in the compiled release`,
      );
      const options = declared.optionIdsByFieldId.get(fieldId);
      if (options) {
        checkedOptions += 1;
        assert.ok(
          options.has(value),
          `seed value ${value} is not a declared option of ${fieldId}`,
        );
      }
    }
  }
  assert.ok(
    checkedOptions > 0,
    'no enum-valued field was seeded, so the option check read nothing',
  );
});

test('the surfaces the dev server prints exist in the compiled application release', () => {
  // apps/api/src/main.ts prints these three as the human entry points. They
  // come from APPLICATION_IDS, which nothing else validates, so a surface
  // rename would produce a valid release and a banner of dead links.
  const declared = declaredIdentifiers();
  for (const surfaceId of [
    APPLICATION_IDS.catalog.listSurfaceId,
    APPLICATION_IDS.party.listSurfaceId,
    APPLICATION_IDS.location.listSurfaceId,
  ]) {
    assert.ok(
      declared.surfaceIds.has(surfaceId),
      `the dev server prints ${surfaceId}, which is not in the compiled release`,
    );
  }
});

test('the dev container name refuses the prefix the matrix guard scans', () => {
  // Unrepresentable rather than detectable. `guard-ephemeral-postgres.mjs`
  // scans `name=^/north-star-` and `run-matrix.sh` invokes it AFTER taking the
  // exclusive lock, so a dev container under that name makes the matrix exit
  // 76 with the slot burned, and past an hour the age sweep removes it without
  // checking whether its owner is alive.
  assert.throws(
    () =>
      resolveDevContainer({
        [DEV_CONTAINER_VARIABLE]: 'north-star-my-dev-db',
      }),
    /must not start with "north-star-"/u,
  );
  // The admission twin: a refusal-only assertion is satisfied by a guard that
  // refuses everything.
  const admitted = resolveDevContainer({
    [DEV_CONTAINER_VARIABLE]: 'my-dev-db',
  });
  assert.equal(admitted.name, 'my-dev-db');
  assert.equal(admitted.volume, 'my-dev-db-data');
});

test('the retired container variable is refused rather than ignored', () => {
  // Four packet records still pass this variable with a `north-star-` value.
  // Ignoring it silently started a container the caller did not name while
  // `dev:stop` targeted a third name.
  assert.throws(
    () =>
      resolveDevContainer({
        [RETIRED_CONTAINER_VARIABLE]: 'north-star-g2-p5da-check',
      }),
    /is no longer read/u,
  );
});

test('the default dev container is outside the reserved prefix', () => {
  const resolved = resolveDevContainer({});
  assert.equal(resolved.name, DEFAULT_DEV_CONTAINER_NAME);
  assert.ok(
    !resolved.name.startsWith(RESERVED_CONTAINER_PREFIX),
    'the default dev container name is inside the reserved test prefix',
  );
  assert.equal(resolved.volume, `${DEFAULT_DEV_CONTAINER_NAME}-data`);
});

test('shutdown runs every step and reports each failure', async () => {
  // The branches this drives are unreachable from a live run: closing the
  // application rejecting, and the container stop failing. Before the fix, the
  // first skipped the stop entirely and the process still exited 0.
  const closeFailure = new Error('close rejected');
  const stopFailure = new Error('stop rejected');
  const both = await runShutdown({
    closeApplication: () => Promise.reject(closeFailure),
    stopContainer: () => Promise.reject(stopFailure),
  });
  assert.deepEqual(
    both.failures,
    [closeFailure, stopFailure],
    'a rejecting close must not suppress the container stop',
  );
  assert.deepEqual(both.ran, ['closeApplication', 'stopContainer']);

  // The admission twin: both succeeding reports no failure, so the assertion
  // above is not satisfied by a shutdown that always reports failure.
  const clean = await runShutdown({
    closeApplication: () => Promise.resolve(),
    stopContainer: () => Promise.resolve(),
  });
  assert.deepEqual(clean.failures, []);
});

test('shutdown waits for an in-flight container command before stopping', async () => {
  // The ordering IS the fix. Stopping before the create settles lets the
  // creation finish afterwards, leaving a container with no owner.
  const order: string[] = [];
  let settled = false;
  const outcome = await runShutdown({
    settleContainerCommand: async () => {
      await new Promise((done) => setImmediate(done));
      settled = true;
      order.push('settled');
    },
    stopContainer: () => {
      assert.ok(settled, 'the stop ran before the create/start had settled');
      order.push('stopped');
      return Promise.resolve();
    },
  });
  assert.deepEqual(order, ['settled', 'stopped']);
  assert.deepEqual(outcome.failures, []);
});

test('a failing container command still leads to a stop, and is not itself a failure', async () => {
  // A create that fails is a reason to clean up, not a reason to skip it.
  let stopped = false;
  const outcome = await runShutdown({
    settleContainerCommand: () => Promise.reject(new Error('docker run died')),
    stopContainer: () => {
      stopped = true;
      return Promise.resolve();
    },
  });
  assert.ok(stopped, 'a failed create/start skipped the cleanup');
  assert.deepEqual(
    outcome.failures,
    [],
    'a failed create/start must not be reported as a shutdown failure',
  );
});

/**
 * Spawns the real dev entry point against a stubbed `docker` on PATH.
 *
 * The stub is what makes these runnable in the unit suite: no daemon, no image
 * pull, no port binding. Its marker file stands in for the container — if the
 * marker survives, a real container would have survived too.
 *
 * `stop` behaviour is a parameter because the two facts under test are
 * different: whether cleanup HAPPENS, and whether a cleanup that FAILS is
 * reported. The second is only observable at the process boundary, which is
 * why these spawn the entry point instead of calling `runShutdown` directly.
 */
function spawnDevEntryPoint(options: {
  readonly runSeconds: string;
  readonly stopFails: boolean;
}): {
  readonly child: ReturnType<typeof spawn>;
  readonly log: string;
  readonly marker: string;
  readonly root: string;
  readonly stderr: () => string;
  readonly exit: Promise<number | null>;
} {
  const root = mkdtempSync(join(tmpdir(), 'dev-lifecycle-'));
  const log = join(root, 'docker.log');
  const marker = join(root, 'container');
  const stop = options.stopFails
    ? // Deliberately NOT an absence error: `stopContainer` treats "no such
      // container" as success, so an absence message here would prove nothing.
      `echo "Error response from daemon: cannot stop container" >&2; exit 1`
    : `if [ -e "${marker}" ]; then rm "${marker}"; fi; exit 0`;
  writeFileSync(
    join(root, 'docker'),
    [
      '#!/usr/bin/env bash',
      `echo "$1" >> "${log}"`,
      'case "$1" in',
      '  container) echo "Error: No such container: stub" >&2; exit 1 ;;',
      `  run) sleep ${options.runSeconds}; : > "${marker}"; ` +
        `echo run-end >> "${log}"; exit 0 ;;`,
      `  stop) ${stop} ;;`,
      '  exec) exit 1 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'),
    { mode: 0o755 },
  );
  let stderr = '';
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('apps/api/src/main.ts')],
    {
      env: {
        ...process.env,
        NORTH_STAR_DATABASE_PORT: '55999',
        NORTH_STAR_DEV_DATABASE_CONTAINER: 'stub-dev-db',
        PATH: `${root}:${process.env.PATH ?? ''}`,
        PORT: '4999',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exit = new Promise<number | null>((done) => {
    child.once('exit', (code) => done(code));
  });
  return { child, exit, log, marker, root, stderr: () => stderr };
}

async function waitForDockerVerb(
  log: string,
  verb: string,
  timeoutMilliseconds = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (existsSync(log) && readFileSync(log, 'utf8').includes(verb)) {
      return readFileSync(log, 'utf8');
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
}

test('a signal while the container command is in flight leaves no container behind', async () => {
  // The window round 2 review identified: SIGTERM arrives while
  // `docker run --detach` is still executing. The process must not exit until
  // that command settles and the container it created has been stopped.
  const dev = spawnDevEntryPoint({ runSeconds: '1.5', stopFails: false });
  try {
    const observed = await waitForDockerVerb(dev.log, 'run');
    assert.ok(
      observed.includes('run'),
      `docker run never started: ${observed}`,
    );
    assert.ok(
      !observed.includes('run-end'),
      'the run completed before the signal, so the in-flight window was not exercised',
    );
    dev.child.kill('SIGTERM');
    await dev.exit;
  } finally {
    dev.child.kill('SIGKILL');
  }

  const transcript = readFileSync(dev.log, 'utf8');
  assert.ok(
    transcript.includes('run-end'),
    'shutdown did not wait for the in-flight container command to settle',
  );
  assert.ok(
    transcript.includes('stop'),
    'no container stop was issued for a container this process created',
  );
  assert.ok(
    !existsSync(dev.marker),
    'the container outlived the process that created it',
  );
  rmSync(dev.root, { force: true, recursive: true });
});

test('the dev command exits non-zero and says so when the container stop fails', async () => {
  // Round 3 review: the helper test proves `runShutdown` REPORTS a failing
  // stop. It does not prove the dev command acts on that report. Deleting the
  // exit-code choice or the diagnostic writes in main.ts left every other
  // control green, so this observes both at the process boundary.
  const dev = spawnDevEntryPoint({ runSeconds: '0', stopFails: true });
  let code: number | null;
  try {
    await waitForDockerVerb(dev.log, 'run-end');
    dev.child.kill('SIGTERM');
    code = await dev.exit;
  } finally {
    dev.child.kill('SIGKILL');
  }

  assert.ok(
    readFileSync(dev.log, 'utf8').includes('stop'),
    'the stop was never attempted, so its failure was not what was measured',
  );
  assert.equal(
    code,
    1,
    'a failed container stop must exit non-zero; the user is otherwise told the leak did not happen',
  );
  assert.match(
    dev.stderr(),
    /COMPOSED_APPLICATION_SHUTDOWN_FAILED/u,
    'a failed container stop must be reported on stderr',
  );
  assert.match(
    dev.stderr(),
    /dev:stop/u,
    'the diagnostic must name the command that clears the leak',
  );
  rmSync(dev.root, { force: true, recursive: true });
});

test('the dev command exits zero and stays quiet when the container stop succeeds', async () => {
  // The admission twin for the test above: without it, a dev command that
  // always exited 1 and always printed the diagnostic would satisfy it.
  const dev = spawnDevEntryPoint({ runSeconds: '0', stopFails: false });
  let code: number | null;
  try {
    await waitForDockerVerb(dev.log, 'run-end');
    dev.child.kill('SIGTERM');
    code = await dev.exit;
  } finally {
    dev.child.kill('SIGKILL');
  }

  assert.equal(code, 0, 'a clean shutdown must exit zero');
  assert.doesNotMatch(
    dev.stderr(),
    /COMPOSED_APPLICATION_SHUTDOWN_FAILED/u,
    'a clean shutdown must not report a shutdown failure',
  );
  // Without this, moving the hint outside its `failures.length > 0` branch
  // keeps both process tests green while every successful shutdown tells the
  // operator their container may still be running. The hint is failure-only,
  // and that placement is the thing under test.
  assert.doesNotMatch(
    dev.stderr(),
    /dev:stop/u,
    'a clean shutdown must not suggest cleanup for a leak that did not occur',
  );
  assert.ok(
    !existsSync(dev.marker),
    'the container outlived the process that created it',
  );
  rmSync(dev.root, { force: true, recursive: true });
});
