import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import type pg from 'pg';

import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  applyCustomizationPatches,
  compileCustomizationCandidate,
  compileInSandbox,
  parseCustomizationPatch,
  parseSerializedRelease,
  SandboxFailure,
  serializeRelease,
  type CustomizationPatch,
} from '../../packages/customization/src/index.js';
import {
  parseCompiledApplication,
  provisionInventoryScope,
  ReleaseRoutingOperationGateway,
  ReleaseRoutingQueryGateway,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { SemanticOperationGateway } from '../../packages/runtime/src/semantic-operation-gateway.js';
import { SemanticQueryGateway } from '../../packages/runtime/src/semantic-query-gateway.js';

const authoredPath = resolve('apps/web/release/app.authored.json');
const authored = JSON.parse(readFileSync(authoredPath, 'utf8')) as Record<
  string,
  unknown
>;
const tip = parseCompiledApplication(
  JSON.parse(
    readFileSync(resolve('apps/web/release/app.compiled.json'), 'utf8'),
  ) as unknown,
).application;
const acknowledgement = readUnboundPermissionAcknowledgementFor(
  authoredPath,
  'northstar.app:package.application',
);

const equipment = patch({
  fields: [
    { label: 'Name', required: true, type: 'text' },
    { label: 'Serial number', type: 'text' },
    { label: 'Purchase date', type: 'date' },
    {
      label: 'Status',
      options: ['In service', 'Under repair', 'Retired'],
      type: 'choice',
    },
  ],
  kind: 'addRecordType',
  label: 'Equipment',
});

test('a request outside the four patch kinds is unsupported and names what is missing', () => {
  const outcome = parseCustomizationPatch({
    kind: 'addWorkflow',
    label: 'Approve equipment purchases',
  });
  assert.equal(outcome.status, 'unsupported');
  assert.equal(
    outcome.status === 'unsupported' && outcome.missingCapability,
    'addWorkflow',
  );
  const malformed = parseCustomizationPatch({
    fields: [{ label: 'Status', type: 'choice' }],
    kind: 'addRecordType',
    label: 'Equipment',
  });
  assert.equal(malformed.status, 'invalid');
});

test('patch application refuses the §10.6 boundary with stable codes, never partially', () => {
  const refusals: Array<[CustomizationPatch, string]> = [
    [
      patch({
        entity: 'northstar.app:entity.inventory_movement',
        field: { label: 'Note', type: 'text' },
        kind: 'addField',
      }),
      'CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET',
    ],
    [
      patch({
        enumField: 'northstar.app:field.location_status',
        kind: 'addChoice',
        option: 'Lost',
      }),
      'CUSTOMIZE_CHOICE_PLATFORM_OWNED',
    ],
    [
      patch({
        entity: 'northstar.app:entity.party',
        field: { label: 'Party name', type: 'text' },
        kind: 'addField',
      }),
      'CUSTOMIZE_DUPLICATE_LABEL',
    ],
  ];
  for (const [candidate, code] of refusals) {
    const outcome = applyCustomizationPatches(authored, [candidate]);
    assert.equal(outcome.status, 'refused', code);
    assert.equal(outcome.status === 'refused' && outcome.code, code);
  }
  const twice = applyCustomizationPatches(authored, [equipment, equipment]);
  assert.equal(
    twice.status === 'refused' && twice.code,
    'CUSTOMIZE_RECORD_TYPE_EXISTS',
  );
  assert.equal(twice.status === 'refused' && twice.patchIndex, 1);
  const page = applyCustomizationPatches(authored, [
    patch({
      hide: ['northstar.app:field.location_code'],
      kind: 'arrangeLayout',
      surface: 'northstar.app:surface.location_form',
    }),
  ]);
  assert.equal(page.status, 'unsupported');
});

test('a tenant-authored definition compiles only in the isolated worker', () => {
  const inProcess = compileCustomizationCandidate({
    acknowledgement,
    base: authored,
    chain: [equipment],
    parent: tip,
  });
  assert.equal(inProcess.status, 'rejected');
  assert.ok(
    inProcess.status === 'rejected' &&
      JSON.stringify(inProcess.diagnostics).includes(
        'COMPILER_UNTRUSTED_INPUT_GATE_REQUIRED',
      ),
    'without the worker attestation the compiler keeps refusing tenant input',
  );
});

test('the worker refuses to compile without an explicit heap ceiling', async () => {
  await assert.rejects(
    compileInSandbox(sandboxRequest([equipment]), {
      launch: (path, execArgv, environment) =>
        fork(path, [], {
          env: environment,
          execArgv: execArgv.filter(
            (argument) => !argument.startsWith('--max-old-space-size='),
          ),
          serialization: 'advanced',
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        }),
    }),
    (error: unknown) =>
      error instanceof SandboxFailure &&
      error.code === 'SANDBOX_REFUSED_ENVIRONMENT',
  );
});

test('the runner kills the worker at its wall clock', async () => {
  await assert.rejects(
    compileInSandbox(sandboxRequest([equipment]), {
      startTimer: (_milliseconds, onExpiry) => {
        queueMicrotask(onExpiry);
        return () => undefined;
      },
    }),
    (error: unknown) =>
      error instanceof SandboxFailure && error.code === 'SANDBOX_TIMED_OUT',
  );
});

test('Equipment drafts deterministically into a new table and a plain diff naming only its own constructs', async () => {
  const first = await compileInSandbox(sandboxRequest([equipment]));
  const second = await compileInSandbox(sandboxRequest([equipment]));
  assert.equal(first.status, 'compiled');
  assert.equal(second.status, 'compiled');
  if (first.status !== 'compiled' || second.status !== 'compiled') return;
  const [step] = first.steps;
  assert.ok(step);
  assert.equal(
    step.release.releaseRoot,
    second.steps[0]!.release.releaseRoot,
    're-applying the same patch to the same base reproduces the release',
  );
  assert.notEqual(step.release.releaseRoot, tip.compiled.releaseRoot);
  // The package itself changes only by becoming tenant-authored.
  const subjects = step.diff.changes
    .filter(
      (change) =>
        change.constructKind !== 'projection' &&
        change.constructKind !== 'packageDefinition',
    )
    .map((change) => change.subjectId);
  assert.ok(subjects.length > 0);
  for (const subject of subjects) {
    // Besides its own constructs, the first record type adds the one Custom
    // menu group every record type is listed under (LOOK-1 round 2).
    if (subject === 'northstar.app:module.custom_record-types') continue;
    assert.match(subject, /:[a-z_-]+\.custom_equipment/u, subject);
  }
  assert.ok(
    subjects.includes('northstar.app:module.custom_record-types'),
    'the first record type declares the Custom group',
  );
  assert.ok(
    step.diff.changes.every(
      (change) =>
        change.changeKind !== 'removed' ||
        change.constructKind === 'projection',
    ),
  );
  assert.match(
    step.rendered.text,
    /New record type "Equipment" with 4 fields/u,
  );
  assert.match(
    step.rendered.text,
    /Status \(one of "In service", "Under repair", "Retired"\)/u,
  );
  assert.match(step.rendered.text, /Stored data: a new table, a new index\./u);
  assert.match(step.diff.canonicalDiffDigest, /^[0-9a-f]{64}$/u);
  assert.match(step.rendered.renderedDigest, /^[0-9a-f]{64}$/u);
  const candidate = parseSerializedRelease(step.release);
  assert.equal(candidate.compiled.releaseRoot, step.release.releaseRoot);
});

test('a chain re-applies its recorded prefix exactly and the next patch builds on it', async () => {
  const choice = patch({
    enumField: 'northstar.app:field.custom_equipment_status',
    kind: 'addChoice',
    option: 'Lost',
  });
  const single = await compileInSandbox(sandboxRequest([equipment]));
  const chained = await compileInSandbox(sandboxRequest([equipment, choice]));
  assert.equal(single.status, 'compiled');
  assert.equal(chained.status, 'compiled');
  if (single.status !== 'compiled' || chained.status !== 'compiled') return;
  assert.equal(
    chained.steps[0]!.release.releaseRoot,
    single.steps[0]!.release.releaseRoot,
  );
  assert.match(
    chained.steps[1]!.rendered.text,
    /Equipment "Status" gains the choice "Lost"/u,
  );
  assert.match(
    chained.steps[1]!.rendered.text,
    /a wider list of allowed choices/u,
  );
});

function sandboxRequest(chain: readonly CustomizationPatch[]) {
  return {
    acknowledgement,
    base: authored,
    chain,
    tip: serializeRelease(tip),
  };
}

function patch(input: unknown): CustomizationPatch {
  const parsed = parseCustomizationPatch(input);
  if (parsed.status !== 'parsed') {
    throw new Error(`test patch did not parse: ${JSON.stringify(parsed)}`);
  }
  return parsed.patch;
}

test('every public method of both gateways is routed by the release a view names', () => {
  const publicMethods = (prototype: object) =>
    Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .sort();
  for (const [base, routing] of [
    [SemanticQueryGateway, ReleaseRoutingQueryGateway],
    [SemanticOperationGateway, ReleaseRoutingOperationGateway],
  ] as const) {
    const methods = publicMethods(base.prototype);
    assert.ok(methods.length > 0);
    assert.deepEqual(
      methods.filter((name) => !Object.hasOwn(routing.prototype, name)),
      [],
      `${routing.name} must override every public method of ${base.name}`,
    );
  }
});

test('boot scope provisioning reads and writes only on the release-scope lock client (review B1b)', async () => {
  const existingRoot = 'cd'.repeat(32);
  const statements: { readonly sql: string; readonly values: unknown[] }[] = [];
  const client = {
    query: (sql: string, values: unknown[] = []) => {
      statements.push({ sql: sql.replace(/\s+/gu, ' ').trim(), values });
      return Promise.resolve({
        rows: sql.includes('contract_release_root')
          ? [{ contract_release_root: existingRoot }]
          : [],
      });
    },
    release: () => undefined,
  };
  const adminPool = {
    connect: () => Promise.resolve(client),
    query: () => {
      throw new Error('the admin pool was used outside the held client');
    },
  } as unknown as pg.Pool;
  const provisioning = {
    legalEntityId: 'legal-entity',
  } as unknown as Parameters<typeof provisionInventoryScope>[3];
  await provisionInventoryScope(
    adminPool,
    {
      environmentId: 'environment',
      principalId: 'principal',
      tenantId: 'tenant',
    } as unknown as Parameters<typeof provisionInventoryScope>[1],
    'ab'.repeat(32),
    provisioning,
  );
  assert.deepEqual(
    statements.map(
      (statement) =>
        /^SELECT (\S+?)\(/u.exec(statement.sql)?.[1] ??
        statement.sql.slice(0, 40),
    ),
    [
      'pg_advisory_lock',
      'SELECT contract_release_root FROM platfo',
      'platform.provision_inventory_scope',
      'pg_advisory_unlock',
    ],
  );
  assert.equal(
    statements[2]!.values[7],
    existingRoot,
    'an existing scope keeps its root',
  );
});
