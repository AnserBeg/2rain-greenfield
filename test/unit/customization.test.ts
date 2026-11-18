import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import type pg from 'pg';
import { renderCompositionFields } from '../../apps/web/src/surface-composition.js';
import type { CompiledSurfaceDefinition } from '../../apps/web/src/surface-contract.js';
import {
  normalizeApplicationPackage,
  type SurfaceList,
} from '../../packages/canonical-model/src/index.js';

import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  applyCustomizationPatches,
  compileCustomizationCandidate,
  customizationTargets,
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

test('Purchase order binds the new field to both draft editors, Details and the governed write contracts', async () => {
  const fieldId = 'northstar.app:field.custom_purchase_order_person_ordering';
  const change = patch({
    kind: 'addField',
    entity: 'northstar.app:entity.purchase_order',
    field: { label: 'Person ordering', type: 'text' },
  });
  const result = await compileInSandbox(sandboxRequest([change]));
  assert.equal(
    result.status,
    'compiled',
    JSON.stringify(result.status === 'compiled' ? '' : result),
  );
  if (result.status !== 'compiled') return;
  const artifacts = result.steps[0]!.release.artifacts.map(
    (artifact) =>
      JSON.parse(
        Buffer.from(String(artifact.canonicalBytesBase64), 'base64').toString(
          'utf8',
        ),
      ) as {
        kind: string;
        surfaces?: CompiledSurfaceDefinition[];
        operations?: {
          operationId: string;
          inputContract: {
            fields: { fieldId: string; required: boolean }[];
            writableFieldIds: string[];
          };
        }[];
      },
  );
  const surfaces = artifacts.find(
    (a) => a.kind === 'surfaceManifestPayload',
  )!.surfaces!;
  for (const role of ['form', 'detail']) {
    const surface = surfaces.find((s) =>
      s.surfaceId.endsWith('.purchase_order_' + role),
    )!;
    assert.equal(
      surface.documentEditor!.headerFields.find((f) => f.fieldId === fieldId)
        ?.disclosure,
      'more',
      role,
    );
    assert.ok(surface.fieldIds.includes(fieldId), surface.surfaceId);
    if (role === 'detail') {
      const record = {
        archived: false,
        entityId: 'northstar.app:entity.purchase_order',
        recordId: 'existing',
        revision: 1,
        values: {},
      };
      const details = renderCompositionFields(surface, {
        fields: { record, cells: {} },
        fieldsFailed: false,
      });
      assert.match(details, /<dt>Person ordering<\/dt><dd>—<\/dd>/u);
      assert.equal(
        surface.composition!.fields.find((f) => f.field === fieldId)?.label,
        'Person ordering',
      );
    }
  }
  const ops = artifacts.find(
    (a) => a.kind === 'operationCatalogPayload',
  )!.operations!;
  assert.deepEqual(
    ops
      .filter((op) => op.inputContract.writableFieldIds.includes(fieldId))
      .map((op) => op.operationId)
      .sort(),
    [
      'northstar.app:operation.purchase_order_create',
      'northstar.app:operation.purchase_order_update',
    ],
  );
  for (const intent of ['create', 'update']) {
    const op = ops.find((o) =>
      o.operationId.endsWith('.purchase_order_' + intent),
    )!;
    assert.ok(op.inputContract.writableFieldIds.includes(fieldId));
    assert.equal(
      op.inputContract.fields.find((f) => f.fieldId === fieldId)?.required,
      false,
    );
  }
});

test('every offered record type exposes its field in layout choices, on the form and on the page', () => {
  for (const local of [
    'purchase_order',
    'sales_order',
    'item',
    'party',
    'location',
    'custom_equipment',
  ]) {
    const fieldId = `northstar.app:field.${local.startsWith('custom_') ? local : 'custom_' + local}_buyer_note`;
    const surface = (role: string) =>
      'northstar.app:surface.' + local + '_' + role;
    const changes = [
      ...(local === 'custom_equipment' ? [equipment] : []),
      patch({
        kind: 'addField',
        entity: 'northstar.app:entity.' + local,
        field: { label: 'Buyer note', type: 'text' },
      }),
    ];
    const model = (extra: CustomizationPatch[] = []) => {
      const result = applyCustomizationPatches(authored, [
        ...changes,
        ...extra,
      ]);
      assert.equal(result.status, 'applied');

      const normalized = normalizeApplicationPackage(result.authored);
      return normalized as unknown as Parameters<
        typeof customizationTargets
      >[0];
    };
    const original = model();
    const choices = customizationTargets(original);
    const listChoice = choices.lists
      .find((l) => l.surfaceId === surface('list'))
      ?.columns.find((c) => c.fieldId === fieldId);
    assert.ok(listChoice, local);
    if (local !== 'custom_equipment') assert.equal(listChoice.hidden, true);
    assert.equal(
      choices.forms
        ?.find((f) => f.surfaceId === surface('form'))
        ?.fields.find((f) => f.fieldId === fieldId)?.upFront,
      local === 'custom_equipment',
    );
    const record = original.surfaces.find(
      (s) => s.surfaceId === surface('detail'),
    )!;
    const get = original.queries.find(
      (q) => q.queryId === (record.dataSource as { targetId: string }).targetId,
    )!;
    assert.ok(
      (get.selections as { field: { targetId: string } }[]).some(
        (s) => s.field.targetId === fieldId,
      ),
      local,
    );
    if (record.composition)
      assert.ok(
        (record.composition as { fields: { field: string }[] }).fields.some(
          (f) => f.field === fieldId,
        ),
        local,
      );
    const arranged = customizationTargets(
      model([
        patch({
          kind: 'arrangeLayout',
          surface: surface('form'),
          upFront: [fieldId],
        }),
        patch({
          kind: 'arrangeLayout',
          surface: surface('list'),
          order: [fieldId],
        }),
      ]),
    );
    assert.deepEqual(
      arranged.lists.find((l) => l.surfaceId === surface('list'))?.columns[0],
      { fieldId, label: 'Buyer note' },
    );
    assert.equal(
      arranged.forms
        ?.find((f) => f.surfaceId === surface('form'))
        ?.fields.find((f) => f.fieldId === fieldId)?.upFront,
      true,
    );
  }
});

test('arranging a list can add any field of its entity and refuses a field of another entity', async () => {
  const fieldId = 'northstar.app:field.item_standard_cost_usd';
  const surfaceId = 'northstar.app:surface.item_list';
  const targets = customizationTargets(
    normalizeApplicationPackage(authored) as unknown as Parameters<
      typeof customizationTargets
    >[0],
  );
  assert.deepEqual(
    targets.lists
      .find((list) => list.surfaceId === surfaceId)
      ?.columns.find((column) => column.fieldId === fieldId),
    { fieldId, label: 'Standard cost (USD)', hidden: true },
  );
  const arrangement = patch({
    kind: 'arrangeLayout',
    surface: surfaceId,
    order: [fieldId],
  });
  const result = await compileInSandbox(sandboxRequest([arrangement]));
  assert.equal(result.status, 'compiled', JSON.stringify(result));
  if (result.status !== 'compiled') return;
  assert.match(result.steps[0]!.rendered.text, /Standard cost \(USD\)/u);

  const base = structuredClone(authored);
  const queries = base.queries as {
    queryId: string;
    selections: { field: { targetId: string } }[];
  }[];
  const query = queries.find(
    (q) => q.queryId === 'northstar.app:query.item_list',
  )!;
  query.selections = query.selections.filter(
    (s) => s.field.targetId !== fieldId,
  );
  const applied = applyCustomizationPatches(base, [arrangement]);
  assert.equal(applied.status, 'applied');
  if (applied.status !== 'applied') return;
  const normalized = normalizeApplicationPackage(applied.authored);
  assert.ok(
    normalized.queries
      .find((q) => q.queryId === query.queryId)!
      .selections.some((s) => s.field.targetId === fieldId),
  );
  const refused = applyCustomizationPatches(authored, [
    patch({
      kind: 'arrangeLayout',
      surface: surfaceId,
      order: ['northstar.app:field.party_credit_limit'],
    }),
  ]);
  assert.equal(refused.status, 'refused');
  assert.equal(
    refused.status === 'refused' && refused.code,
    'CUSTOMIZE_FIELD_NOT_ON_LIST',
  );
});

test('a generic Party list can be arranged through the same declared list runtime', () => {
  const surfaceId = 'northstar.app:surface.party_list';
  assert.ok(
    customizationTargets(
      normalizeApplicationPackage(authored) as unknown as Parameters<
        typeof customizationTargets
      >[0],
    ).lists.some((list) => list.surfaceId === surfaceId),
  );
  const result = applyCustomizationPatches(authored, [
    patch({
      kind: 'arrangeLayout',
      surface: surfaceId,
      order: ['northstar.app:field.party_credit_limit'],
    }),
  ]);
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') return;
  const model = normalizeApplicationPackage(result.authored);
  const surface = model.surfaces.find((s) => s.surfaceId === surfaceId)!;
  assert.equal(
    'list' in surface && (surface.list as SurfaceList).columns[0]?.field,
    'northstar.app:field.party_credit_limit',
  );
});

test('the adopted form language accepts an optional field under More details and refuses a required or unrelated field there', () => {
  const candidate = structuredClone(authored);
  const party = (
    candidate.surfaces as { surfaceId: string; form?: unknown }[]
  ).find((s) => s.surfaceId.endsWith('.party_form'))!;
  const field = {
    fieldId: 'northstar.app:field.party_contact_summary',
    label: 'Contact',
    disclosure: 'more',
  };
  party.form = { kind: 'surfaceForm', schemaVersion: 'v6', fields: [field] };
  assert.doesNotThrow(() => normalizeApplicationPackage(candidate));
  const po = (
    candidate.surfaces as {
      surfaceId: string;
      composition?: { fields: Record<string, unknown>[] };
    }[]
  ).find((s) => s.surfaceId.endsWith('.purchase_order_detail'))!;
  const column = po.composition!.fields[0]!;
  column.showWhenEmpty = true;
  assert.doesNotThrow(() => normalizeApplicationPackage(candidate));
  column.showWhenEmpty = false;
  assert.throws(() => normalizeApplicationPackage(candidate));
  delete column.showWhenEmpty;
  field.fieldId = 'northstar.app:field.party_name';
  assert.throws(
    () => normalizeApplicationPackage(candidate),
    (err: unknown) =>
      JSON.stringify(err).includes('required field cannot wait'),
  );
  field.fieldId = 'northstar.app:field.location_name';
  assert.throws(
    () => normalizeApplicationPackage(candidate),
    (err: unknown) => JSON.stringify(err).includes('visible selected field'),
  );
});

test('an owner can publish screens for a previously live query-only field while keeping its original column', () => {
  const change = patch({
    kind: 'addField',
    entity: 'northstar.app:entity.purchase_order',
    field: { label: 'Person ordering', type: 'text' },
  });
  assert.equal(change.kind, 'addField');
  const old = { ...change, legacy: true as const };
  const form = (chain: CustomizationPatch[]) => {
    const result = applyCustomizationPatches(authored, chain);
    assert.equal(result.status, 'applied');
    const normalized = normalizeApplicationPackage(result.authored);
    return normalized as unknown as Parameters<typeof customizationTargets>[0];
  };
  assert.equal(customizationTargets(form([old])).forms?.length, 0);
  const live = form([old, change]);
  assert.equal(
    live.fields.filter(
      (field) =>
        field.fieldId ===
        'northstar.app:field.custom_purchase_order_person_ordering',
    ).length,
    1,
  );
  assert.equal(customizationTargets(live).forms?.length, 1);
  assert.equal(
    applyCustomizationPatches(authored, [old, change, change]).status,
    'refused',
  );
});
