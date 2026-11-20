import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import type pg from 'pg';
import { renderCompositionFields } from '../../apps/web/src/surface-composition.js';
import {
  declaredListArguments,
  declaredListCsv,
  declaredViewFilters,
  readDeclaredListState,
} from '../../apps/web/src/list-declaration.js';
import type { CompiledSurfaceDefinition } from '../../apps/web/src/surface-contract.js';
import {
  canonicalize,
  CanonicalModelError,
  normalizeApplicationPackage,
  type SurfaceList,
} from '../../packages/canonical-model/src/index.js';
import {
  compileApplicationRelease,
  expectedActiveReleaseFrom,
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
} from '../../packages/compiler/src/index.js';

import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  applyCustomizationPatches,
  compileCustomizationCandidate,
  customizationTargets,
  CUSTOMIZATION_PATCH_KINDS,
  CustomizationPatchSchema,
  compileInSandbox,
  parseCustomizationPatch,
  parseSerializedRelease,
  SandboxFailure,
  serializeRelease,
  type CustomizationPatch,
} from '../../packages/customization/src/index.js';
import {
  assertAgentOperationsPlannable,
  parseCompiledApplication,
  provisionInventoryScope,
  ReleaseRoutingOperationGateway,
  ReleaseRoutingQueryGateway,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { SemanticOperationGateway } from '../../packages/runtime/src/semantic-operation-gateway.js';
import { SemanticQueryGateway } from '../../packages/runtime/src/semantic-query-gateway.js';
import { unsupportedRuntimeCapability } from '../../packages/runtime/src/request-runtime-view.js';
import {
  authorizeSharedListFields,
  parseSharedListArguments,
} from '../../packages/runtime/src/list-behavior/index.js';

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

test('an active action must be exposed with its exact read-back when its module is activated', () => {
  assert.doesNotThrow(() => assertAgentOperationsPlannable(tip));
  const { compiled } = tip;
  const family = compiled.bundle.releaseManifest.projections.find(
    (p) => p.familyId === PROJECTION_FAMILY_IDS.agentDiscovery,
  )!;
  const manifest = compiled.bundle.artifacts.find(
    (a) => a.contentHash === family.artifactRoot,
  )!;
  const chunk = (
    JSON.parse(new TextDecoder().decode(manifest.canonicalBytes)) as {
      chunks: { contentHash: string }[];
    }
  ).chunks[0]!;
  const artifacts = compiled.bundle.artifacts.map((artifact) => {
    if (artifact.contentHash !== chunk.contentHash) return artifact;
    const profile = JSON.parse(
      new TextDecoder().decode(artifact.canonicalBytes),
    ) as { operations: { operationId: string }[] };
    profile.operations = profile.operations.filter(
      (op) => op.operationId !== 'northstar.app:operation.item_create',
    );
    return {
      ...artifact,
      canonicalBytes: new TextEncoder().encode(JSON.stringify(profile)),
    };
  });
  assert.throws(
    () =>
      assertAgentOperationsPlannable({
        ...tip,
        compiled: { ...compiled, bundle: { ...compiled.bundle, artifacts } },
      }),
    /cannot plan and read back declared operation northstar.app:operation.item_create/u,
  );
});

test('the v1 patch vocabulary is add-only', () => {
  const releasedKinds = [
    'addRecordType',
    'addField',
    'addChoice',
    'arrangeLayout',
    'saveListView',
    'addLink',
    'addLineTable',
    'declareLifecycle',
    'addMetricCard',
    'narrowPermission',
    'unNarrowPermission',
    'changeSet',
  ];
  const [singlePatch, changeSet] = CustomizationPatchSchema.options;
  const schemaKinds = [
    ...singlePatch.options.map((schema) => schema.shape.kind.value),
    changeSet.shape.kind.value,
  ];
  assert.deepEqual([...CUSTOMIZATION_PATCH_KINDS].sort(), schemaKinds.sort());
  for (const kind of releasedKinds)
    assert.ok(
      schemaKinds.some((current) => current === kind),
      kind,
    );
});

test('action permission changes require the standalone authoring path', () => {
  for (const kind of ['narrowPermission', 'unNarrowPermission']) {
    const permission = {
      kind,
      roleKey: 'viewer',
      target: { kind: 'operation', id: 'northstar.app:operation.party_update' },
    };
    assert.equal(parseCustomizationPatch(permission).status, 'parsed');
    assert.deepEqual(
      parseCustomizationPatch({
        kind: 'changeSet',
        patches: [equipment, permission],
      }),
      {
        status: 'unsupported',
        missingCapability: 'action permission changes in a grouped draft',
        message: 'Action permission changes need their own draft.',
      },
    );
  }
});

test('an unknown patch kind is unsupported and named, including inside a change set', () => {
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
  const batch = parseCustomizationPatch({
    kind: 'changeSet',
    patches: [equipment, { kind: 'subscribeToGoodsReceipt' }],
  });
  assert.equal(batch.status, 'unsupported');
  assert.equal(
    batch.status === 'unsupported' && batch.missingCapability,
    'subscribeToGoodsReceipt',
  );
  for (const patches of [
    [],
    [equipment],
    Array(17).fill(equipment),
    [equipment, { kind: 'changeSet', patches: [equipment, equipment] }],
  ]) {
    assert.equal(
      parseCustomizationPatch({ kind: 'changeSet', patches }).status,
      'invalid',
    );
  }
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

test('a company-owned tenant record compiles scoped queries and explains the choice in the diff', async () => {
  const outcome = await compileInSandbox(
    sandboxRequest([
      patch({
        companyOwnership: 'entityOwned',
        fields: [{ label: 'Name', type: 'text' }],
        kind: 'addRecordType',
        label: 'Site review',
      }),
    ]),
  );
  assert.equal(
    outcome.status,
    'compiled',
    JSON.stringify(outcome.status === 'compiled' ? [] : outcome),
  );
  if (outcome.status !== 'compiled') return;
  assert.match(
    outcome.steps[0]!.rendered.text,
    /each record belongs to one company/iu,
  );
});

test('a tenant-shared source cannot compile a link to a company-owned receipt', async () => {
  const relationId = 'northstar.app:relation.custom_site_review_receipt';
  const reference = (targetId: string) => ({
    kind: 'entityReference',
    schemaVersion: 'v6',
    targetId,
  });
  const base = structuredClone(authored);
  (base.relations as unknown[]).push({
    archiveBehavior: 'retainReference',
    cardinality: 'manyToOne',
    joinEligibility: 'query',
    kind: 'relationDefinition',
    orderKey: 10,
    ownership: 'reference',
    relationId,
    required: false,
    schemaVersion: 'v6',
    sourceEntity: reference('northstar.app:entity.custom_site_review'),
    targetEntity: reference('northstar.app:entity.goods_receipt'),
  });
  const compile = (companyOwnership: 'entityOwned' | 'tenantShared') =>
    compileInSandbox({
      ...sandboxRequest([
        patch({
          companyOwnership,
          fields: [{ label: 'Name', type: 'text' }],
          kind: 'addRecordType',
          label: 'Site review',
        }),
      ]),
      base,
    });
  const [accepted, rejected] = await Promise.all([
    compile('entityOwned'),
    compile('tenantShared'),
  ]);
  assert.equal(
    accepted.status,
    'compiled',
    JSON.stringify(accepted.status === 'compiled' ? [] : accepted),
  );
  assert.match(
    JSON.stringify(rejected),
    /INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED/u,
  );
  assert.match(JSON.stringify(rejected), new RegExp(relationId, 'u'));
});

test('a tenant lifecycle compiles guarded operations and refuses an undeclared state', async () => {
  const lifecycle = {
    entity: 'northstar.app:entity.custom_equipment',
    initial: 'Pending',
    kind: 'declareLifecycle',
    states: [{ label: 'Pending' }, { label: 'Passed' }],
    transitions: [{ from: 'Pending', label: 'Pass', to: 'Passed' }],
  };
  const accepted = await compileInSandbox(
    sandboxRequest([
      patch({ kind: 'changeSet', patches: [equipment, lifecycle] }),
    ]),
  );
  assert.equal(
    accepted.status,
    'compiled',
    JSON.stringify(accepted.status === 'compiled' ? [] : accepted),
  );
  const refused = applyCustomizationPatches(authored, [
    equipment,
    patch({ ...lifecycle, initial: 'Undeclared' }),
  ]);
  assert.equal(refused.status, 'unsupported');
});

test('tenant line tables use the document editor with or without company scope and lifecycle', async () => {
  const entity = 'northstar.app:entity.custom_quality_review';
  const header = {
    companyOwnership: 'entityOwned',
    fields: [{ label: 'Name', type: 'text' }],
    kind: 'addRecordType',
    label: 'Quality review',
  };
  const lifecycle = {
    entity,
    initial: 'Pending',
    kind: 'declareLifecycle',
    states: [
      { label: 'Pending', role: 'inProgress' },
      { label: 'Passed', role: 'success' },
    ],
    transitions: [{ from: 'Pending', label: 'Pass', to: 'Passed' }],
  };
  const lines = {
    entity,
    fields: [
      { label: 'Characteristic', required: true, type: 'text' },
      { label: 'Measured value', type: 'number' },
      { label: 'Pass', type: 'yesNo' },
    ],
    kind: 'addLineTable',
    label: 'Results',
  };
  const change = (members: object[]) =>
    patch({ kind: 'changeSet', patches: members });
  const link = {
    entity,
    kind: 'addLink',
    label: 'Goods receipt',
    target: 'northstar.app:entity.goods_receipt',
  };
  const links = [
    link,
    ...(['party', 'item', 'location'] as const).map((target) => ({
      ...link,
      label: target,
      target: `northstar.app:entity.${target}`,
    })),
  ];
  const sharedTarget = {
    ...header,
    companyOwnership: 'tenantShared',
    label: 'Review source',
  };
  const accepted = await compileInSandbox(
    surfaceCompatibilityRequest([change([header, lifecycle, lines])]),
  );
  assert.equal(
    accepted.status,
    'compiled',
    JSON.stringify(accepted.status === 'compiled' ? [] : accepted),
  );
  if (accepted.status === 'compiled') {
    const family = PROJECTION_FAMILY_IDS.surfaceManifest;
    const surfaceRequirement = parseSerializedRelease(
      accepted.steps[0]!.release,
    ).compiled.bundle.releaseManifest.projections.find(
      (projection) => projection.familyId === family,
    )!.requiredRuntimeCapability;
    const reader23 = {
      [family]: {
        capabilityId: surfaceRequirement.capabilityId,
        maximumSupportedVersion: 23,
      },
    };
    assert.equal(surfaceRequirement.minimumVersion, 23);
    assert.equal(
      unsupportedRuntimeCapability(family, surfaceRequirement, reader23),
      null,
    );
    const projections = accepted.steps[0]!.release.artifacts.map(
      (artifact) =>
        JSON.parse(
          Buffer.from(String(artifact.canonicalBytesBase64), 'base64').toString(
            'utf8',
          ),
        ) as {
          kind: string;
          surfaces?: CompiledSurfaceDefinition[];
        },
    );
    const surfaces = projections.find(
      (artifact) => artifact.kind === 'surfaceManifestPayload',
    )!.surfaces!;
    const form = surfaces.find((surface) =>
      surface.surfaceId.endsWith('.custom_quality_review_form'),
    )!;
    assert.equal(
      form.documentEditor?.parentRelationId,
      'northstar.app:relation.custom_quality_review_lines_parent',
    );
    assert.deepEqual(form.documentEditor?.editableStateIds, [
      'northstar.app:state.custom_quality_review_pending',
    ]);
    const detail = surfaces.find((surface) =>
      surface.surfaceId.endsWith('.custom_quality_review_detail'),
    )!;
    assert.equal(detail.composition?.children[0]?.label, 'Results');
    assert.deepEqual(
      detail.composition?.presentation?.progression?.steps.map(
        (step) => step.label,
      ),
      ['Pending', 'Passed'],
    );
  }
  for (const members of [
    [header, lines],
    [{ ...header, companyOwnership: 'tenantShared' }, lifecycle, lines],
    [
      sharedTarget,
      { ...header, companyOwnership: 'tenantShared' },
      {
        ...link,
        target: 'northstar.app:entity.custom_review_source',
        label: 'Source',
      },
      lines,
    ],
    [header, ...links, lines, lifecycle],
  ]) {
    const extended = await compileInSandbox(
      surfaceCompatibilityRequest([change(members)]),
    );
    assert.equal(
      extended.status,
      'compiled',
      JSON.stringify(extended.status === 'compiled' ? [] : extended),
    );
    if (extended.status !== 'compiled') continue;
    const family = PROJECTION_FAMILY_IDS.surfaceManifest;
    const requirement = parseSerializedRelease(
      extended.steps[0]!.release,
    ).compiled.bundle.releaseManifest.projections.find(
      (projection) => projection.familyId === family,
    )!.requiredRuntimeCapability;
    for (const maximumSupportedVersion of [25, 24, 23, 22]) {
      assert.match(
        unsupportedRuntimeCapability(family, requirement, {
          [family]: {
            capabilityId: requirement.capabilityId,
            maximumSupportedVersion,
          },
        }) ?? '',
        /26/u,
      );
    }
    assert.equal(requirement.minimumVersion, 26);
    assert.equal(unsupportedRuntimeCapability(family, requirement), null);
  }
  const visual = await compileInSandbox(
    surfaceCompatibilityRequest([
      patch(header),
      change([...links, lines, lifecycle]),
    ]),
  );
  assert.deepEqual(visual, {
    message:
      'Links can be added when the record type is first created; adding one later is coming soon',
    missingCapability: 'links on a published record type',
    patchIndex: 1,
    status: 'unsupported',
  });
  const uncovered = applyCustomizationPatches(authored, [
    change([header, { ...link, required: true }, lines]),
  ]);
  assert.equal(uncovered.status, 'applied');
  const form = (uncovered.authored.surfaces as Record<string, unknown>[]).find(
    (surface) =>
      String(surface.surfaceId).endsWith('.custom_quality_review_form'),
  )!;
  delete (form.documentEditor as Record<string, unknown>).headerRelations;
  assert.throws(
    () => normalizeApplicationPackage(uncovered.authored),
    (error: unknown) =>
      /picker for each required header relation/u.test(JSON.stringify(error)),
  );
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

// Measure each customization floor with lower-floor first-party surfaces.
let surfaceCompatibilityBase:
  Pick<ReturnType<typeof sandboxRequest>, 'base' | 'tip'> | undefined;
function surfaceCompatibilityRequest(chain: readonly CustomizationPatch[]) {
  if (!surfaceCompatibilityBase) {
    const base = structuredClone(authored);
    for (const { documentEditor } of base.surfaces as {
      documentEditor?: { lineCreateValues?: unknown };
    }[]) {
      if (documentEditor) delete documentEditor.lineCreateValues;
    }
    const normalized = normalizeApplicationPackage(base);
    const normalizedDefinitionBytes = new TextEncoder().encode(
      canonicalize(normalized),
    );
    const compiled = compileApplicationRelease(
      {
        kind: 'compilerInput',
        dependencies: [],
        expectedActiveRelease: null,
        limits: { ...DEFAULT_COMPILER_LIMITS },
        normalizedDefinitionBytes,
        profile: {
          ...MODULE_COMPILER_PROFILE,
          languageVersion: normalized.languageVersion,
          normalizationProfileVersion: normalized.normalizationProfileVersion,
        },
      },
      acknowledgement,
    );
    assert.ok(compiled.status === 'compiled', JSON.stringify(compiled));
    surfaceCompatibilityBase = {
      base,
      tip: serializeRelease({ compiled, normalizedDefinitionBytes }),
    };
  }
  return { acknowledgement, ...surfaceCompatibilityBase, chain };
}

test('a change set compiles only its final definition and refuses a broken dependency order', async () => {
  const addSerial = patch({
    entity: 'northstar.app:entity.custom_equipment',
    field: { label: 'Inspection date', type: 'date' },
    kind: 'addField',
    screens: 'record',
  });
  const change = patch({ kind: 'changeSet', patches: [equipment, addSerial] });
  const result = await compileInSandbox(sandboxRequest([change]));
  assert.equal(result.status, 'compiled');
  if (result.status !== 'compiled') return;
  assert.equal(result.steps.length, 1);
  const step = result.steps[0]!;
  assert.match(step.rendered.text, /Equipment/u);
  const definition = parseSerializedRelease(
    step.release,
  ).normalizedDefinitionBytes;
  assert.match(
    new TextDecoder().decode(definition),
    /custom_equipment_inspection_date/u,
  );
  const reversed = patch({
    kind: 'changeSet',
    patches: [addSerial, equipment],
  });
  assert.deepEqual(await compileInSandbox(sandboxRequest([reversed])), {
    code: 'CUSTOMIZE_TARGET_NOT_FOUND',
    message:
      'There is no record type northstar.app:entity.custom_equipment to add a field to.',
    patchIndex: 0,
    status: 'refused',
  });
});

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

test('permission narrowing compiles an exact active action on one role', async () => {
  const action = 'northstar.app:operation.purchase_order_close';
  const restriction = patch({
    kind: 'narrowPermission',
    roleKey: 'local-demo-full-release',
    target: { kind: 'operation', id: action },
  });
  assert.equal(
    applyCustomizationPatches(authored, [restriction, restriction]).status,
    'refused',
  );
  assert.equal(
    applyCustomizationPatches(authored, [
      patch({
        kind: 'narrowPermission',
        roleKey: 'local-demo-full-release',
        target: {
          kind: 'operation',
          id: 'northstar.app:operation.nonexistent',
        },
      }),
    ]).status,
    'refused',
  );
  const exactKey = ' local-demo-full-release ';
  const spacedRole = parseCustomizationPatch({
    kind: 'narrowPermission',
    roleKey: exactKey,
    target: { kind: 'operation', id: action },
  });
  assert.ok(
    spacedRole.status === 'parsed' &&
      spacedRole.patch.kind === 'narrowPermission',
  );
  assert.equal(spacedRole.patch.roleKey, exactKey);
  const removal = patch({
    kind: 'unNarrowPermission',
    roleKey: 'local-demo-full-release',
    target: { kind: 'operation', id: action },
  });
  assert.equal(
    applyCustomizationPatches(authored, [removal]).status,
    'refused',
  );
  const restored = applyCustomizationPatches(authored, [restriction, removal]);
  assert.equal(restored.status, 'applied');
  assert.ok(
    restored.status === 'applied' &&
      !('operationRoleNarrowings' in restored.authored),
  );
  assert.throws(
    () =>
      normalizeApplicationPackage({
        ...authored,
        operationRoleNarrowings: [
          {
            operationId: 'northstar.app:operation.customize_approve',
            roleKey: 'local-demo-full-release',
          },
        ],
      }),
    (error: unknown) =>
      error instanceof CanonicalModelError &&
      error.diagnostics.some(
        ({ code, path }) =>
          code === 'CANON_SCHEMA_INVALID' &&
          path === '$.operationRoleNarrowings[0].operationId',
      ),
  );
  const compiled = await compileInSandbox(sandboxRequest([restriction]));
  assert.ok(compiled.status === 'compiled', JSON.stringify(compiled));
  const step = compiled.steps[0]!;
  assert.match(
    step.rendered.text,
    /Role "local-demo-full-release" can no longer grant access/u,
  );
  const release = parseSerializedRelease(step.release);
  const catalog = release.compiled.bundle.releaseManifest.projections.find(
    (projection) =>
      projection.familyId === PROJECTION_FAMILY_IDS.operationCatalog,
  )!;
  assert.equal(catalog.requiredRuntimeCapability.minimumVersion, 2);
  assert.equal(
    unsupportedRuntimeCapability(
      catalog.familyId,
      catalog.requiredRuntimeCapability,
    ),
    null,
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(release.normalizedDefinitionBytes).toString('utf8'))
      .operationRoleNarrowings,
    [{ operationId: action, roleKey: 'local-demo-full-release' }],
  );
});

test('Today compiles only declared numeric measures of a direct List', async () => {
  const card = {
    kind: 'addMetricCard',
    surface: 'northstar.app:surface.item_list',
    label: 'Catalog prices in CAD',
    sumField: 'northstar.app:field.item_price_cad',
  };
  const compiled = await compileInSandbox(
    surfaceCompatibilityRequest([patch(card)]),
  );
  assert.equal(compiled.status, 'compiled', JSON.stringify(compiled));
  assert.match(compiled.steps[0]!.rendered.text, /sums Price \(CAD\) in/u);
  const { projections } = parseSerializedRelease(compiled.steps[0]!.release)
    .compiled.bundle.releaseManifest;
  for (const [family, floor] of [
    [PROJECTION_FAMILY_IDS.surfaceManifest, 25],
    [PROJECTION_FAMILY_IDS.agentDiscovery, 4],
    [PROJECTION_FAMILY_IDS.queryCatalog, 3],
  ] as const) {
    const requirement = projections.find(
      (projection) => projection.familyId === family,
    )!.requiredRuntimeCapability;
    assert.equal(requirement.minimumVersion, floor);
    assert.equal(unsupportedRuntimeCapability(family, requirement), null);
  }
  const invalidCard = patch({
    ...card,
    sumField: 'northstar.app:field.item_name',
  });
  const rejected = applyCustomizationPatches(authored, [invalidCard]);
  assert.equal(rejected.status, 'refused');
  const malformed = structuredClone(authored);
  const query = (malformed.queries as Record<string, unknown>[]).find(
    (query) => query.queryId === 'northstar.app:query.item_list',
  )!;
  query.listSumFields = ['northstar.app:field.item_name'];
  assert.throws(
    () => normalizeApplicationPackage(malformed),
    /CANON_LIST_SUM_FIELD_INVALID/u,
  );
});

test('a saved Location view compiles its own columns, sort and declared filter', async () => {
  const baseView = {
    kind: 'saveListView',
    surface: 'northstar.app:surface.location_list',
    label: 'Warehouses',
    columns: [
      'northstar.app:list_column.location_list_name',
      'northstar.app:list_column.location_list_code',
    ],
    sort: [
      {
        column: 'northstar.app:list_column.location_list_name',
        direction: 'descending',
      },
    ],
    filters: [
      {
        field: 'northstar.app:field.location_type',
        value: 'northstar.app:option.warehouse',
      },
    ],
  };
  const saved = patch(baseView);
  const compiled = await compileInSandbox(surfaceCompatibilityRequest([saved]));
  assert.equal(compiled.status, 'compiled', JSON.stringify(compiled));
  const { projections } = parseSerializedRelease(compiled.steps[0]!.release)
    .compiled.bundle.releaseManifest;
  for (const [familyId, version] of [
    [PROJECTION_FAMILY_IDS.surfaceManifest, 24],
    [PROJECTION_FAMILY_IDS.agentDiscovery, 3],
  ] as const) {
    const requirement = projections.find(
      (projection) => projection.familyId === familyId,
    )!.requiredRuntimeCapability;
    assert.equal(requirement.minimumVersion, version);
    assert.equal(unsupportedRuntimeCapability(familyId, requirement), null);
    assert.match(
      unsupportedRuntimeCapability(familyId, requirement, {
        [familyId]: {
          capabilityId: requirement.capabilityId,
          maximumSupportedVersion: version - 1,
        },
      }) ?? '',
      /requires version/u,
    );
  }
  assert.match(
    compiled.steps[0]!.rendered.text,
    /Columns in order: Name, Code\./u,
  );
  assert.match(
    compiled.steps[0]!.rendered.text,
    /Filter: Type is Warehouse\./u,
  );

  const result = applyCustomizationPatches(authored, [saved]);
  assert.equal(result.status, 'applied');
  const normalized = normalizeApplicationPackage(result.authored);
  const surface = normalized.surfaces.find(
    (s) => s.surfaceId === baseView.surface,
  )!;
  const list = ('list' in surface && surface.list) as SurfaceList;
  assert.deepEqual(
    list.views.map((view) => view.label),
    ['All', 'Warehouses'],
  );
  assert.deepEqual(list.views[1]?.layout?.columns, baseView.columns);
  assert.deepEqual(list.views[1]?.layout?.sort, [
    { columnId: baseView.sort[0]!.column, direction: 'descending' },
  ]);
  const all = list.views[0]!;
  const warehouses = list.views[1]!;
  const filterId = list.filters.find(
    (filter) => filter.field === baseView.filters[0]!.field,
  )!.filterId;
  const url = new URL('http://local/');
  url.searchParams.set('view', warehouses.viewId);
  url.searchParams.set(filterId, 'northstar.app:option.store');
  const state = readDeclaredListState(list, url);
  const queryId = 'northstar.app:query.location_list';
  const read = {
    mode: 'page' as const,
    now: new Date('2026-11-18T00:00:00Z'),
    queryId,
    scopeArguments: {},
  };
  const limits = { declaredParameterIds: [], maximumResultCount: 100, queryId };
  const selected = parseSharedListArguments(
    declaredListArguments(list, state, read),
    limits,
  )!;
  assert.deepEqual(selected.fieldFilters, [
    { fieldId: baseView.filters[0]!.field, value: baseView.filters[0]!.value },
  ]);
  assert.deepEqual(selected.sort, [
    { fieldId: 'northstar.app:field.location_name', direction: 'descending' },
  ]);
  assert.deepEqual(declaredViewFilters(list, state, all), [
    {
      fieldId: baseView.filters[0]!.field,
      value: 'northstar.app:option.store',
    },
  ]);
  assert.equal(
    declaredListCsv(
      list,
      [
        {
          archived: false,
          entityId: 'northstar.app:entity.location',
          recordId: 'location',
          revision: 1,
          values: {
            'northstar.app:field.location_name': 'Main warehouse',
            'northstar.app:field.location_code': 'W-1',
            [baseView.filters[0]!.field]: baseView.filters[0]!.value,
          },
        },
      ],
      (_record, _field, value) => String(value),
      warehouses.viewId,
    ),
    '\uFEFFName,Code\r\nMain warehouse,W-1\r\n',
  );
  assert.throws(
    () =>
      authorizeSharedListFields(
        {
          ...selected,
          sort: [],
          viewCounts: [
            { viewId: warehouses.viewId, filters: selected.fieldFilters! },
          ],
        },
        { selectedFieldIds: new Set() },
      ),
    /list query selects/u,
  );

  const refused = await compileInSandbox(
    surfaceCompatibilityRequest([
      patch({
        ...baseView,
        filters: [
          { ...baseView.filters[0], value: 'northstar.app:option.invalid' },
        ],
      }),
    ]),
  );
  assert.equal(refused.status, 'refused');
  assert.equal(refused.code, 'CUSTOMIZE_LIST_VIEW_INVALID');

  const invalidLayout = structuredClone(result.authored);
  const edited = (
    invalidLayout.surfaces as { surfaceId: string; list?: SurfaceList }[]
  ).find((s) => s.surfaceId === baseView.surface)!;
  edited.list!.views[1]!.layout!.columns.splice(1, 1);
  assert.throws(
    () => normalizeApplicationPackage(invalidLayout),
    (error) =>
      error instanceof CanonicalModelError &&
      error.diagnostics.some((entry) => entry.rule.includes('keeps its title')),
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

test('upgrade diagnostics name the missing tenant target and the new first-party base deterministically', async () => {
  const base = structuredClone(authored);
  const surface = 'northstar.app:surface.item_list';
  base.surfaces = (base.surfaces as { surfaceId: string }[]).filter(
    (entry) => entry.surfaceId !== surface,
  );
  const request = {
    acknowledgement,
    base,
    chain: [
      patch({
        kind: 'arrangeLayout',
        surface,
        relabel: [
          { field: 'northstar.app:field.item_name', label: 'Warehouse name' },
        ],
      }),
    ],
    tip: serializeRelease(tip),
    upgradeBaseRoot: tip.compiled.releaseRoot,
  };
  const first = await compileInSandbox(request);
  const second = await compileInSandbox(request);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'rejected');
  assert.ok(first.status === 'rejected');
  assert.equal(first.code, 'CUSTOMIZE_UPGRADE_CONFLICT');
  assert.match(
    JSON.stringify(first.diagnostics),
    /firstPartyBase.*tenantPatch.*item_list.*There is no screen/u,
  );
});

test('an upgrade compiles field, layout and metric intent as one transition from the prior live tenant release', async () => {
  const chain = [
    patch({
      kind: 'addField',
      entity: 'northstar.app:entity.item',
      screens: 'record',
      field: { label: 'Shelf code', type: 'text' },
    }),
    patch({
      kind: 'arrangeLayout',
      surface: 'northstar.app:surface.item_list',
      relabel: [
        { field: 'northstar.app:field.item_name', label: 'Warehouse name' },
      ],
    }),
    patch({
      kind: 'addMetricCard',
      surface: 'northstar.app:surface.item_list',
      label: 'Catalog prices in CAD',
      sumField: 'northstar.app:field.item_price_cad',
    }),
  ];
  const original = await compileInSandbox(sandboxRequest(chain));
  assert.ok(original.status === 'compiled');
  const source = original.steps.at(-1)!.release;
  const base = structuredClone(authored);
  (base.fields as { fieldId: string; label: string }[]).find(
    (field) => field.fieldId === 'northstar.app:field.item_sku',
  )!.label = 'Stock number';
  const normalized = normalizeApplicationPackage(base);
  const normalizedDefinitionBytes = new TextEncoder().encode(
    canonicalize(normalized),
  );
  const compiled = compileApplicationRelease(
    {
      kind: 'compilerInput',
      dependencies: [],
      expectedActiveRelease: expectedActiveReleaseFrom(tip.compiled),
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes,
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion: normalized.languageVersion,
        normalizationProfileVersion: normalized.normalizationProfileVersion,
      },
    },
    acknowledgement,
  );
  assert.ok(compiled.status === 'compiled');
  const replay = await compileInSandbox({
    acknowledgement,
    base,
    chain,
    tip: source,
    upgradeBaseRoot: compiled.releaseRoot,
  });
  assert.ok(replay.status === 'compiled', JSON.stringify(replay));
  assert.equal(replay.steps.length, 1);
  assert.equal(replay.steps[0]!.diff.fromManifestRoot, source.releaseRoot);
  const next = JSON.parse(
    Buffer.from(
      replay.steps[0]!.release.normalizedDefinitionBytesBase64,
      'base64',
    ).toString('utf8'),
  ) as {
    fields: { label: string }[];
    surfaces: {
      surfaceId: string;
      list?: { columns: { label: string }[] };
      launcher?: { metrics?: { label: string; sumField: string }[] };
    }[];
  };
  assert.ok(next.fields.some((field) => field.label === 'Stock number'));
  assert.ok(next.fields.some((field) => field.label === 'Shelf code'));
  assert.ok(
    next.surfaces
      .find(
        (surface) => surface.surfaceId === 'northstar.app:surface.item_list',
      )
      ?.list?.columns.some((column) => column.label === 'Warehouse name'),
  );
  const card = next.surfaces.find(
    (surface) => surface.surfaceId === 'northstar.app:surface.inventory_today',
  )?.launcher?.metrics?.[0];
  assert.equal(card?.label, 'Catalog prices in CAD');
  assert.equal(card?.sumField, 'northstar.app:field.item_price_cad');
});

test('a whole-package upgrade rejection keeps the compiler subject without attributing a patch', async () => {
  const request = sandboxRequest([
    patch({
      kind: 'arrangeLayout',
      surface: 'northstar.app:surface.item_list',
      relabel: [
        {
          field: 'northstar.app:field.item_name',
          label: 'Private tenant heading',
        },
      ],
    }),
  ]);
  const permissionId = 'northstar.app:permission.future_read';
  const response = await compileInSandbox({
    ...request,
    upgradeBaseRoot: tip.compiled.releaseRoot,
    acknowledgement: {
      ...acknowledgement,
      evaluatorBindings: [
        ...(acknowledgement.evaluatorBindings ?? []),
        { ...acknowledgement.evaluatorBindings![0]!, permissionId },
      ],
    },
  });
  assert.ok(response.status === 'rejected', JSON.stringify(response));
  assert.equal('patchIndex' in response, false);
  const diagnostics = response.diagnostics as {
    firstPartySubject?: string;
    tenantPatch?: unknown;
    patchIndex?: number;
  }[];
  assert.ok(
    diagnostics.some((d) => d.firstPartySubject === permissionId),
    JSON.stringify(diagnostics),
  );
  assert.ok(
    diagnostics.every((d) => !('tenantPatch' in d) && !('patchIndex' in d)),
  );
});

test('a field-only chain reproduces with historical bindings and upgrades onto an added permission', async () => {
  const request = sandboxRequest([
    patch({
      kind: 'addField',
      entity: 'northstar.app:entity.item',
      field: { label: 'Shelf code', type: 'text' },
      screens: 'record',
    }),
  ]);
  const old = await compileInSandbox(request);
  assert.ok(old.status === 'compiled');
  const base = structuredClone(authored);
  const permissions = base.permissions as { permissionId: string }[];
  const permission = {
    ...permissions.find(
      (p) =>
        p.permissionId === acknowledgement.evaluatorBindings![0]!.permissionId,
    )!,
    permissionId: 'northstar.app:permission.future_create',
  };
  permissions.push(permission);
  const additional = {
    ...acknowledgement.evaluatorBindings![0]!,
    permissionId: permission.permissionId,
  };
  const obsolete = {
    ...permission,
    permissionId: 'northstar.app:permission.unbound_legacy',
  };
  permissions.push(obsolete);
  const nextAcknowledgement = {
    ...acknowledgement,
    entries: [
      ...acknowledgement.entries,
      { permissionId: obsolete.permissionId, resource: additional.resource },
    ],
    evaluatorBindings: [
      ...(acknowledgement.evaluatorBindings ?? []),
      additional,
    ],
  };
  const history = await compileInSandbox({
    ...request,
    acknowledgement: nextAcknowledgement,
    historical: true,
  });
  assert.ok(
    history.status === 'compiled',
    JSON.stringify(history.status !== 'compiled' && history.diagnostics),
  );
  assert.equal(
    history.steps[0]!.release.releaseRoot,
    old.steps[0]!.release.releaseRoot,
  );
  const upgraded = await compileInSandbox({
    ...request,
    base,
    acknowledgement: nextAcknowledgement,
    tip: history.steps[0]!.release,
    upgradeBaseRoot: tip.compiled.releaseRoot,
  });
  assert.ok(
    upgraded.status === 'compiled',
    JSON.stringify(upgraded.status !== 'compiled' && upgraded.diagnostics),
  );
  const reproduced = await compileInSandbox({
    ...request,
    base,
    acknowledgement,
    stepAcknowledgements: [nextAcknowledgement],
    tip: history.steps[0]!.release,
    upgradeBaseRoot: tip.compiled.releaseRoot,
  });
  assert.ok(
    reproduced.status === 'compiled',
    'removed permissions require their recorded acknowledgement and evaluator binding',
  );
  assert.equal(
    reproduced.steps[0]!.release.releaseRoot,
    upgraded.steps[0]!.release.releaseRoot,
  );
});
