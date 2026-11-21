import assert from 'node:assert/strict';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { renderMapStopList } from '../../apps/web/src/map-view.js';
import { finishMapPage } from '../../packages/postgres-provider/src/map-page.js';
import type { SemanticQueryExecutionRequest } from '../../packages/runtime/src/semantic-query-gateway.js';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  normalizeApplicationPackage,
  mapBindingConflicts,
  mapDigest,
} from '../../packages/canonical-model/src/index.js';
import {
  applyCustomizationPatches,
  compileInSandbox,
  serializeRelease,
  CustomizationPatchSchema,
  customizationTargets,
  draftMapRevision,
  draftPatchFromRequest,
  draftingSystemPrompt,
  DRAFT_CUSTOMIZATION_TOOL,
  MapDraftSchema,
} from '../../packages/customization/src/index.js';
import { replayCustomizationPatches } from '../../packages/customization/src/upgrade-replay.js';

const base = JSON.parse(
  readFileSync('apps/web/release/app.authored.json', 'utf8'),
);
const entity = 'northstar.app:entity.custom_stop',
  address = 'northstar.app:field.custom_stop_address';
const chain = [
  CustomizationPatchSchema.parse({
    kind: 'changeSet',
    patches: [
      {
        kind: 'addRecordType',
        label: 'Stop',
        companyOwnership: 'entityOwned',
        fields: [
          { type: 'text', label: 'Name', required: true },
          { type: 'choice', label: 'Route', options: ['North', 'South'] },
          { type: 'number', label: 'Sequence' },
        ],
      },
      {
        kind: 'addAddressField',
        schemaVersion: 'v6',
        entity,
        fieldId: address,
        label: 'Address',
        required: false,
      },
    ],
  }),
];
function applied(input: typeof chain, source = base) {
  const out = applyCustomizationPatches(source, input);
  assert.ok(
    out.status === 'applied',
    JSON.stringify(out.status === 'applied' ? null : out),
  );
  return out.authored;
}
function offered() {
  const model = normalizeApplicationPackage(applied(chain));
  const targets = customizationTargets(model);
  const target = targets.maps?.find((t) => t.frame.entityId === entity);
  assert.ok(target);
  const choice = {
    kind: 'addMapViewRevision' as const,
    surface: target.frame.listSurfaceId,
    label: 'Dispatch stops',
    addressFieldId: address,
    groupFieldId: target.groups[0]!.fieldId,
    orderFieldId: target.orders.find((f) => f.label === 'Sequence')!.fieldId,
    direction: 'asc' as const,
  };
  return { model, targets, target, choice };
}
test('Map choices survive label changes, unrelated fields and list arrangements while active and retired', () => {
  const { model, target, choice } = offered(),
    revision = draftMapRevision(target, choice);
  assert.equal(revision.resultDigest, mapDigest(revision.body));
  assert.deepEqual(mapBindingConflicts(model, revision.body), []);
  const active = [...chain, revision];
  const current = customizationTargets(
    normalizeApplicationPackage(applied(active)),
  ).maps!.find((t) => t.frame.entityId === entity)!;
  const retired = draftMapRevision(current, choice, current.views[0], true);
  for (const prefix of [active, [...active, retired]]) {
    const changes = [
      ...prefix,
      CustomizationPatchSchema.parse({
        kind: 'addField',
        entity,
        field: { type: 'text', label: 'Dispatch note' },
        screens: 'record',
      }),
      CustomizationPatchSchema.parse({
        kind: 'arrangeLayout',
        surface: choice.surface,
        relabel: [{ field: choice.orderFieldId, label: 'Visit number' }],
      }),
    ];
    const result = normalizeApplicationPackage(applied(changes));
    assert.deepEqual(
      result.surfaces.find(
        (s) => s.surfaceId === revision.surfaceId && 'map' in s,
      )?.archetype,
      'map',
    );
    const replay = replayCustomizationPatches(base, changes);
    assert.equal(
      replay.status,
      'applied',
      JSON.stringify(replay.status === 'applied' ? null : replay),
    );
    if (replay.status === 'applied')
      assert.deepEqual(replay.authored, applied(changes));
  }
  const removed = {
    ...model,
    fields: model.fields.filter((f) => f.fieldId !== address),
  };
  assert.ok(
    mapBindingConflicts(removed, revision.body).some(
      (c) => c.code === 'RETIRED_TARGET' && c.subject === address,
    ),
  );
});
test('drafter advertises the Map schema and emits the same selected contracts as Customize', async () => {
  const { targets, target, choice } = offered();
  assert.ok(
    draftingSystemPrompt(targets).includes(
      JSON.stringify(MapDraftSchema.toJSONSchema()),
    ),
  );
  for (const direction of ['asc', 'desc'] as const) {
    const input = { ...choice, direction };
    const expected = draftMapRevision(target, input);
    const model = {
      modelId: 'map-test',
      async next() {
        return {
          text: '',
          toolCalls: [{ id: 'map', name: DRAFT_CUSTOMIZATION_TOOL, input }],
        };
      },
    };
    const result = await draftPatchFromRequest(
      model,
      'Map stops by route and sequence',
      targets,
    );
    assert.ok(
      result.status === 'parsed' && result.patch.kind === 'addMapViewRevision',
      JSON.stringify(result),
    );
    assert.equal(result.patch.resultDigest, expected.resultDigest);
  }
});

test('overflow displays the governed page size', async () => {
  const { target, choice } = offered();
  const revision = draftMapRevision(target, choice);
  const companyId = randomUUID();
  const candidates = Array.from({ length: 101 }, (_, i) => ({
    record: {
      recordId: randomUUID(),
      entityId: entity,
      archived: false,
      revision: 1,
      values: {},
    },
    group: 'North',
    ordered: true,
    ordinal: i + 1,
  }));
  const client = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  const surface = {
    archetype: 'map',
    lifecycle: 'active',
    surfaceId: revision.surfaceId,
    map: {
      revisionId: revision.revisionId,
      predecessor: revision.predecessor,
      body: revision.body,
      resultDigest: revision.resultDigest,
    },
  };
  const view = {
    projections: { surface: { payload: { surfaces: [surface] } } },
    pointer: { fence: 1 },
    release: { contentHash: 'test' },
  };
  for (const [queryLimit, expected] of [
    [7, 7],
    [120, 100],
  ] as const) {
    const request = {
      view,
      definition: {
        queryId: revision.body.listQueryId,
        sourceEntityId: entity,
        maximumResultCount: queryLimit,
      },
      legalEntityReadScope: { legalEntityIds: [companyId] },
      arguments: {
        mapPage: {
          surfaceId: revision.surfaceId,
          revisionId: revision.revisionId,
          companyId,
        },
      },
    } as unknown as SemanticQueryExecutionRequest;
    const page = await finishMapPage(client, request, candidates);
    assert.equal(page.records.length, expected);
    const coverage = page.mapCoverage!;
    assert.ok(coverage.hasNext);
    const html = renderMapStopList(
      page.records.map(() => '<li>Stop</li>'),
      coverage,
      '/?stops=' + coverage.hasNext,
    );
    assert.ok(html.includes('Showing ' + expected + ' of this filter’s stops'));
    const last = await finishMapPage(
      client,
      request,
      candidates.slice(0, expected),
    );
    assert.equal(last.mapCoverage!.hasNext, undefined);
    assert.doesNotMatch(
      renderMapStopList([], last.mapCoverage!, null),
      /Showing|Next/u,
    );
  }
});

test('a label-only upgrade compiles active and retired Map choices', async () => {
  const { target, choice } = offered();
  const active = draftMapRevision(target, choice);
  const retired = draftMapRevision(target, choice, active, true);
  const authoring = applied(chain);
  const relabelled = structuredClone(authoring);
  const field = (
    relabelled.fields as { fieldId: string; label: string }[]
  ).find((f) => f.fieldId === choice.orderFieldId)!;
  field.label = 'Visit order';
  const followups = [
    CustomizationPatchSchema.parse({
      kind: 'addField',
      entity,
      field: { type: 'text', label: 'Arrival instructions' },
      screens: 'record',
    }),
    CustomizationPatchSchema.parse({
      kind: 'arrangeLayout',
      surface: choice.surface,
      relabel: [{ field: choice.orderFieldId, label: 'Visit number' }],
    }),
  ];
  const { application } = parseCompiledApplication(
    JSON.parse(readFileSync('apps/web/release/app.compiled.json', 'utf8')),
  );
  const tip = serializeRelease(application);
  const acknowledgement = readUnboundPermissionAcknowledgementFor(
    'apps/web/release/app.authored.json',
    'northstar.app:package.application',
  );
  for (const revisions of [[active], [active, retired]]) {
    const changes = [...revisions, ...followups];
    const result = await compileInSandbox({
      base: relabelled,
      acknowledgement,
      tip,
      chain: changes,
      upgradeBaseRoot: tip.releaseRoot,
      origins: changes.map((_, i) => ({
        patchId: randomUUID(),
        differentBase: true,
        ...(i === 0 && { parent: authoring }),
      })),
    });
    assert.equal(
      result.status,
      'compiled',
      JSON.stringify(result.status === 'compiled' ? null : result),
    );
  }
});
