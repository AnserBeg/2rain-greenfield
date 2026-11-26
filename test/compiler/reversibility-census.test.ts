/**
 * AI-UNDO-1 slice 2: the reversibility declaration derived from the
 * first-party release. The compiler emits it in the agent-discovery chunk
 * (reader floor 5) under the cut, unadopted compiler-semantic profile v3
 * (ADR-0047); the assistant routes record types no capability owns through
 * it, and a release without it asks. This census
 * is what the act-at-once set is reviewed from.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeApplicationPackage } from '../../packages/canonical-model/src/normalize.js';
import { parseReversibilityDeclaration } from '../../packages/canonical-model/src/reversibility.js';
import {
  deriveReversibility,
  type ReversibilitySource,
} from '../../packages/compiler/src/reversibility.js';
import {
  compileHeadAt,
  compiledAppView,
  compiledAppViewV3,
} from '../agent/compiled-view.js';
import { WorkflowDefinitionSchema } from '../../packages/canonical-model/src/schemas.js';
import {
  ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
} from '../../packages/compiler/src/index.js';
import { REVERSIBILITY_AGENT_READER } from '../../packages/canonical-model/src/reversibility.js';
import { PASSIVE_RELEASE_MEMBERS } from '../../packages/compiler/src/reversibility.js';

const NS = 'northstar.app';

function firstPartyDeclaration(
  extra: Record<string, unknown> = {},
  editOperations: (
    operations: Parameters<typeof deriveReversibility>[0],
  ) => Parameters<typeof deriveReversibility>[0] = (operations) => operations,
) {
  const view = compiledAppView();
  const release = {
    ...normalizeApplicationPackage(
      JSON.parse(readFileSync('apps/web/release/app.authored.json', 'utf8')),
    ),
    ...extra,
  };
  const agent = view.projections.agent.payload as {
    confirmationRequiredFor?: string[];
  };
  return deriveReversibility(
    editOperations(
      (
        view.projections.operation.payload as unknown as {
          operations: Parameters<typeof deriveReversibility>[0];
        }
      ).operations,
    ),
    release as unknown as ReversibilitySource,
    new Set(agent.confirmationRequiredFor ?? []),
  );
}

const local = (id: string) => id.split(/[.:]/u).pop()!;

test('every first-party operation carries a declaration, and the canonical reader parses it', () => {
  const declaration = firstPartyDeclaration();
  assert.equal(declaration.operations.length, 172);
  assert.deepEqual(parseReversibilityDeclaration(declaration), declaration);
  const classes: Record<string, number> = {};
  for (const operation of declaration.operations) {
    const key = `${operation.undo}/${operation.reach}`;
    classes[key] = (classes[key] ?? 0) + 1;
  }
  assert.deepEqual(classes, {
    'exact/internal': 35,
    'exact/record': 69,
    'none/internal': 2,
    'none/outward': 32,
    'residue/record': 34,
  });
  // A capability declares nothing yet, so it is the worst case.
  for (const operation of declaration.operations)
    if (operation.because.includes('capabilityUndeclared'))
      assert.equal(`${operation.undo}/${operation.reach}`, 'none/outward');
});

test('the lifecycle an edit depends on comes from the release, not from a name', () => {
  const byOperation = new Map(
    firstPartyDeclaration().operations.map((entry) => [
      local(entry.operationId),
      entry,
    ]),
  );
  const state = (id: string) => {
    const condition = byOperation.get(id)?.holdsWhile;
    return [
      condition?.state
        ? `${local(condition.state.stateFieldId)}=${condition.state.stateIds.map(local).join('|')}`
        : '',
      ...(condition?.parents ?? []).map(
        (parent) =>
          `${local(parent.relationId)}:${local(parent.stateFieldId)}=${parent.stateIds.map(local).join('|')}`,
      ),
    ].join(' ');
  };
  // A state machine's derived state field (no `_state` suffix) and its
  // initial state.
  assert.equal(
    state('sales_order_update'),
    'sales_order_lifecycle=sales_order_draft',
  );
  assert.equal(
    state('sales_order_line_update'),
    ' sales_order_line_order:sales_order_lifecycle=sales_order_draft',
  );
  // An enum the update's own precondition compares at its top level, rather
  // than one nested under a disjunction (shipment kind).
  assert.equal(state('shipment_update'), 'shipment_state=shipment_state_draft');
  // The parent a count line belongs to (replaces parentEditApprovals).
  assert.equal(
    state('stock_count_line_update'),
    ' stock_count_line_session:stock_count_state=stock_count_state_draft',
  );
  assert.equal(state('party_update'), '');
});

test('a field a rule or calculated field reads is consumed, so it is not record-only', () => {
  const name = `${NS}:field.party_name`;
  const summary = `${NS}:field.party_contact_summary`;
  const classOf = (
    declaration: ReturnType<typeof firstPartyDeclaration>,
    id: string,
  ) =>
    declaration.operations
      .find((entry) => entry.operationId === `${NS}:operation.party_update`)!
      .fields!.find((field) => field.fieldId === id)!;
  assert.equal(classOf(firstPartyDeclaration(), name).reach, 'record');
  for (const extra of [
    // A rule or calculated field names it as a reference.
    { formulaRules: [{ reads: { kind: 'fieldReference', targetId: name } }] },
    {
      calculatedDisplayFields: [
        { operand: { kind: 'fieldReference', targetId: name } },
      ],
    },
  ]) {
    const declaration = firstPartyDeclaration(extra);
    assert.equal(classOf(declaration, name).reach, 'internal');
    assert.ok(classOf(declaration, name).because.includes('readByConsumer'));
    assert.equal(classOf(declaration, summary).reach, 'record');
  }
});

const agentCapability = (manifest: {
  projections: readonly {
    familyId: string;
    requiredRuntimeCapability?: unknown;
  }[];
}) =>
  manifest.projections.find(
    (projection) =>
      projection.familyId ===
      'northstar.compiler:projection-family.agent-discovery',
  )?.requiredRuntimeCapability;

test('a release compiled under the cut v3 profile emits the declaration the release derives, behind agent-discovery floor 5', () => {
  const { view, compiled } = compiledAppViewV3();
  const emitted = parseReversibilityDeclaration(
    (view.projections.agent.payload as { reversibility?: unknown })
      .reversibility,
  );
  // The same declaration the authored release derives: gates and lifecycles
  // come from the authored preconditions, not the dispatch alias's.
  assert.deepEqual(emitted, firstPartyDeclaration());
  assert.deepEqual(agentCapability(compiled.bundle.releaseManifest), {
    capabilityId: 'northstar.runtime:capability.agent-discovery',
    minimumVersion: REVERSIBILITY_AGENT_READER,
  });
  assert.equal(REVERSIBILITY_AGENT_READER, 5);
});

test('profile v3 is v2 plus the reversibility key and nothing else', () => {
  const { view, compiled } = compiledAppViewV3();
  type Application = {
    releaseManifest: {
      projections: {
        familyId: string;
        artifactRoot: string;
        requiredRuntimeCapability?: unknown;
      }[];
    };
  };
  const file = JSON.parse(
    readFileSync('apps/web/release/app.compiled.json', 'utf8'),
  ) as { applications?: Application[]; application?: Application };
  // The checked-in release may be a v2 lineage: compare with its head entry,
  // the one compiled from today's authored package.
  const head = (file.applications?.at(-1) ?? file.application)!;
  const agentFamily = 'northstar.compiler:projection-family.agent-discovery';
  const roots = (
    projections: readonly { familyId: string; artifactRoot: string }[],
  ) =>
    Object.fromEntries(
      projections
        .filter((projection) => projection.familyId !== agentFamily)
        .map((projection) => [projection.familyId, projection.artifactRoot]),
    );
  assert.deepEqual(
    roots(compiled.bundle.releaseManifest.projections),
    roots(head.releaseManifest.projections),
  );
  const { reversibility, ...rest } = view.projections.agent.payload as Record<
    string,
    unknown
  >;
  assert.ok(reversibility);
  assert.deepEqual(rest, compiledAppView().projections.agent.payload);
});

test('the adopted v2 release carries no declaration and keeps its agent-discovery floor (v3 is cut, not adopted)', () => {
  assert.equal(
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  );
  assert.ok(
    !Object.hasOwn(
      compiledAppView().projections.agent.payload as object,
      'reversibility',
    ),
  );
  type Application = {
    releaseManifest: {
      projections: { familyId: string; requiredRuntimeCapability: unknown }[];
    };
  };
  const file = JSON.parse(
    readFileSync('apps/web/release/app.compiled.json', 'utf8'),
  ) as { applications?: Application[]; application?: Application };
  // Every lineage entry is an adopted v2 release: none carries v3's floor.
  const entries = file.applications ?? [file.application!];
  assert.ok(entries.length > 0);
  for (const entry of entries)
    assert.deepEqual(agentCapability(entry.releaseManifest), {
      capabilityId: 'northstar.runtime:capability.agent-discovery',
      // Today: assistant confirmations (2); main's floor, unchanged.
      minimumVersion: 2,
    });
});

test('every release member not known to be passive is a consumer, including one a later language adds', () => {
  const name = `${NS}:field.party_name`;
  const classOf = (declaration: ReturnType<typeof firstPartyDeclaration>) =>
    declaration.operations
      .find((entry) => entry.operationId === `${NS}:operation.party_update`)!
      .fields!.find((field) => field.fieldId === name)!;
  for (const extra of [
    { billingPlans: [{ quantityField: name }] },
    { documentTemplateRevisions: [{ body: { fieldId: name } }] },
    { connectorBindings: [{ fields: [name] }] },
    // A member no language has today counts until it is reviewed passive.
    { laterLanguageMember: [{ reads: name }] },
  ]) {
    const field = classOf(firstPartyDeclaration(extra));
    assert.equal(field.reach, 'internal', Object.keys(extra)[0]);
    assert.ok(field.because.includes('readByConsumer'));
  }
  // A passive member that names the field (a surface showing it) does not.
  assert.ok(PASSIVE_RELEASE_MEMBERS.has('surfaces'));
  assert.equal(
    classOf(firstPartyDeclaration({ mapPlacements: [{ label: name }] })).reach,
    'record',
  );
});

test('a workflow reads through its granted queries: every field a granted query names is consumed', () => {
  // A schema-valid release workflow: it names operations and queries, never
  // fields, and its body reads through the queries it is granted.
  const workflow = WorkflowDefinitionSchema.parse({
    schemaVersion: 'v6',
    workflowId: 'after-receipt',
    trigger: 'goodsReceiptPosted',
    bodyDigest: 'a'.repeat(64),
    grants: { operations: [], queries: [`${NS}:query.party_get`] },
  });
  const declaration = firstPartyDeclaration({ workflows: [workflow] });
  const classOf = (operation: string, field: string) =>
    declaration.operations
      .find((entry) => entry.operationId === `${NS}:operation.${operation}`)!
      .fields!.find((entry) => entry.fieldId === `${NS}:field.${field}`)!;
  assert.equal(classOf('party_update', 'party_name').reach, 'internal');
  assert.ok(
    classOf('party_update', 'party_name').because.includes('readByConsumer'),
  );
  // A field of a type no granted query reads stays record-only.
  assert.equal(classOf('item_update', 'item_name').reach, 'record');
  assert.equal(
    firstPartyDeclaration()
      .operations.find(
        (entry) => entry.operationId === `${NS}:operation.party_update`,
      )!
      .fields!.find((entry) => entry.fieldId === `${NS}:field.party_name`)!
      .reach,
    'record',
  );
});

test('a parent with a lifecycle but no read-back query holds in no state', () => {
  const parent = `${NS}:entity.stock_count`;
  const declaration = firstPartyDeclaration({}, (operations) =>
    operations.map((operation) =>
      operation.effect.entity?.targetId === parent &&
      (operation.effect.kind === 'updateRecordEffect' ||
        operation.effect.kind === 'createRecordEffect')
        ? (() => {
            const { readBackQueryId: _dropped, ...rest } = operation;
            void _dropped;
            return rest;
          })()
        : operation,
    ),
  );
  const line = declaration.operations.find(
    (entry) => entry.operationId === `${NS}:operation.stock_count_line_update`,
  )!;
  assert.deepEqual(line.holdsWhile?.parents, [
    {
      relationId: `${NS}:relation.stock_count_line_session`,
      stateFieldId: `${NS}:field.stock_count_state`,
      stateIds: [],
      stateLabels: [],
    },
  ]);
  assert.deepEqual(parseReversibilityDeclaration(declaration), declaration);
});

test('the head compiled under the adopted v2 profile carries no declaration', () => {
  const { result } = compileHeadAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION);
  const reference = result.bundle.releaseManifest.projections.find(
    (projection) =>
      projection.familyId ===
      'northstar.compiler:projection-family.agent-discovery',
  )!;
  const decode = (hash: string) =>
    JSON.parse(
      new TextDecoder().decode(
        result.bundle.artifacts.find((a) => a.contentHash === hash)!
          .canonicalBytes,
      ),
    ) as Record<string, unknown>;
  const payload = decode(
    (decode(reference.artifactRoot) as { chunks: { contentHash: string }[] })
      .chunks[0]!.contentHash,
  );
  assert.ok(!Object.hasOwn(payload, 'reversibility'));
  assert.equal(
    (reference.requiredRuntimeCapability as { minimumVersion: number })
      .minimumVersion,
    2,
  );
});

// For record types no capability owns (tenant-built), the derivation decides.
// First-party types are capability-owned, so their fields ask unless the
// owner declares them (packages/domain/src/app/immediate-edits.ts); this
// census measures what the derivation alone would allow, for the record.
test('census: the plain edits the derivation alone would let act at once, per operation', () => {
  const declaration = firstPartyDeclaration();
  const act = new Map<string, string[]>();
  for (const operation of declaration.operations)
    for (const field of operation.fields ?? [])
      if (
        operation.undo === 'exact' &&
        operation.reach === 'record' &&
        field.undo === 'exact' &&
        field.reach === 'record'
      )
        act.set(local(operation.operationId), [
          ...(act.get(local(operation.operationId)) ?? []),
          local(field.fieldId),
        ]);
  const total = [...act.values()].reduce((sum, list) => sum + list.length, 0);
  assert.equal(total, 233);
  // Today's eleven pairs are all inside it.
  for (const [operation, field] of [
    ['item_update', 'item_description'],
    ['item_update', 'item_name'],
    ['legal_entity_update', 'legal_entity_name'],
    ['location_update', 'location_name'],
    ['party_update', 'party_contact_summary'],
    ['party_update', 'party_name'],
    ['party_update', 'party_payment_terms'],
    ['purchase_order_update', 'purchase_order_notes'],
    ['sales_order_update', 'sales_order_notes'],
    ['stock_count_line_update', 'stock_count_line_counted_quantity'],
    ['tax_code_update', 'tax_code_name'],
  ] as const)
    assert.ok(act.get(operation)?.includes(field), `${operation} ${field}`);
  // The declared gates stay out (slice 1, AGENT-5).
  for (const field of [
    'party_credit_hold',
    'tax_code_rate_percent',
    'legal_entity_is_default',
  ])
    assert.ok(![...act.values()].some((list) => list.includes(field)), field);
  // What capability code reads but the release does not declare: these are
  // A2's shape and need a ruling before any act at once (see the record).
  for (const field of ['party_credit_limit', 'item_base_unit'])
    assert.ok(
      act
        .get(field.startsWith('party') ? 'party_update' : 'item_update')
        ?.includes(field),
      field,
    );
  void NS;
});
