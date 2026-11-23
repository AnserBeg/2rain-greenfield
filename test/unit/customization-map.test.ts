import assert from 'node:assert/strict';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  readMapSlots,
  renderMapStopList,
} from '../../apps/web/src/map-view.js';
import {
  mapBindingsProblem,
  mapDeclarationProblem,
} from '../../packages/postgres-provider/src/map-admission.js';
import { finishMapPage } from '../../packages/postgres-provider/src/map-page.js';
import type { SemanticQueryExecutionRequest } from '../../packages/runtime/src/semantic-query-gateway.js';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  normalizeApplicationPackage,
  MAP_VIEW_READER,
  SURFACE_SLOTS,
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
  describeDrafterKind,
  DRAFTING_TOOL,
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
const words = { narrow: [] };
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
  // The tool describes the member from MapDraftSchema itself (rule 12), and
  // the prompt lists the collection's choices by ID.
  const description = describeDrafterKind('addMapViewRevision');
  assert.ok(DRAFTING_TOOL.description.includes(description));
  for (const key of Object.keys(MapDraftSchema.shape).filter(
    (key) => key !== 'kind',
  ))
    assert.match(description, new RegExp(`\\b${key}\\b`, 'u'), key);
  assert.ok(
    draftingSystemPrompt(targets).includes(
      JSON.stringify(target.frame.listSurfaceId),
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

test('route filter labels come from the Map collection when the Record omits the group', async () => {
  const { target, choice } = offered();
  const revision = draftMapRevision(target, choice);
  const group = revision.body.group!;
  const surface = {
    label: 'Dispatch',
    map: revision,
    surfaceId: revision.surfaceId,
    fields: [
      {
        kind: 'enumFieldType',
        fieldId: group.fieldId,
        options: [{ optionId: 'route-north', label: 'North depot' }],
      },
    ],
  } as unknown as Parameters<typeof readMapSlots>[1];
  const record = {
    surfaceId: revision.body.recordSurfaceId,
    lifecycle: 'active',
    fields: [],
  } as unknown as Parameters<typeof readMapSlots>[1];
  const gateways = {
    queryGateway: {
      previewEligibility: async () => 'eligible',
      invoke: async () => ({
        outcome: 'exact',
        records: [],
        mapCoverage: {
          revisionId: revision.revisionId,
          pageSize: 100,
          stops: [],
        },
      }),
    },
  } as unknown as Parameters<typeof readMapSlots>[6];
  const slots = await readMapSlots(
    {} as Parameters<typeof readMapSlots>[0],
    surface,
    [record],
    new URL('http://localhost/?route=route-north'),
    {},
    'company-a',
    gateways,
  );
  assert.match(slots.savedViews, /value="route-north" selected>North depot</u);
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
      { narrow: [] },
    );
    assert.ok(
      html.includes('Showing ' + expected + ' of 101 in this filter</p>'),
      html,
    );
    const last = await finishMapPage(
      client,
      request,
      candidates.slice(0, expected),
    );
    assert.equal(last.mapCoverage!.hasNext, undefined);
    assert.doesNotMatch(
      renderMapStopList([], last.mapCoverage!, null, words),
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

test('Map admission binds the reader, collection, selected fields, slots and connector to the released revision', () => {
  const { target, choice } = offered();
  const { surfaceId, lifecycle, body, revisionId, predecessor, resultDigest } =
    draftMapRevision(target, choice);
  const surface = {
    surfaceId,
    archetype: 'map',
    lifecycle,
    map: { body, revisionId, predecessor, resultDigest },
    slots: SURFACE_SLOTS.map.map((slot) => ({ slot })),
    workspace: { ownerSurfaceId: body.listSurfaceId },
    dataSourceQueryId: body.listQueryId,
  };
  const list = {
    surfaceId: body.listSurfaceId,
    dataSourceQueryId: body.listQueryId,
    lifecycle: 'active',
  };
  const record = {
    surfaceId: body.recordSurfaceId,
    dataSourceQueryId: body.getQueryId,
    lifecycle: 'active',
  };
  const query = {
    queryId: body.listQueryId,
    queryType: 'list',
    sourceEntityId: body.entityId,
    legalEntityScope: { cardinality: body.companyScope },
    selections: [
      body.label.fieldId,
      body.addressFieldId,
      body.order.field.fieldId,
      body.group!.fieldId,
    ].map((fieldId) => ({ fieldId })),
  };
  const get = {
    queryId: body.getQueryId,
    queryType: 'get',
    sourceEntityId: body.entityId,
  };
  const viewport = {
    fieldId: body.addressFieldId,
    surfaceId,
    contract: body.viewport,
  };
  const inspect = (
    surfaces: unknown[] = [surface, list, record],
    floor = MAP_VIEW_READER,
    queries: unknown[] = [query, get],
    viewports: unknown[] = [viewport],
  ) => mapBindingsProblem({ surfaces }, floor, { queries }, { viewports });
  assert.equal(inspect(), null);
  assert.ok(inspect(undefined, MAP_VIEW_READER - 1));
  assert.ok(inspect([list, record], MAP_VIEW_READER, undefined, []));
  for (const replacement of [
    { ...surface, archetype: 'list' },
    { ...surface, slots: surface.slots.slice(1) },
    { ...surface, map: { ...surface.map, resultDigest: '0'.repeat(64) } },
    { ...surface, map: { ...surface.map, predecessor: revisionId } },
    { ...surface, dataSourceQueryId: body.getQueryId },
    { ...surface, workspace: { ownerSurfaceId: body.recordSurfaceId } },
  ])
    assert.ok(inspect([replacement, list, record]));
  assert.ok(inspect([surface, list]));
  assert.ok(inspect([surface, record]));
  assert.ok(inspect(undefined, undefined, [query]));
  assert.ok(inspect(undefined, undefined, [get]));
  assert.ok(
    inspect(undefined, undefined, [
      { ...query, legalEntityScope: { cardinality: 'different' } },
      get,
    ]),
  );
  for (const { fieldId } of query.selections)
    assert.ok(
      inspect(undefined, undefined, [
        {
          ...query,
          selections: query.selections.filter((s) => s.fieldId !== fieldId),
        },
        get,
      ]),
    );
  assert.ok(
    inspect(undefined, undefined, undefined, [
      { ...viewport, fieldId: body.label.fieldId },
    ]),
  );
  assert.equal(
    mapDeclarationProblem(
      { surfaces: [surface] },
      { surfaces: [surface, list, record] },
    ),
    null,
  );
  assert.ok(
    mapDeclarationProblem(
      { surfaces: [surface] },
      { surfaces: [{ ...surface, lifecycle: 'retired' }] },
    ),
  );
});

test('a Map beyond its candidate budget asks the dispatcher to narrow the search', () => {
  const partial = renderMapStopList([], { partial: true }, null, words);
  assert.match(partial, /Narrow the search/);
  assert.doesNotMatch(partial, /Nothing in this filter/);
  assert.match(
    renderMapStopList([], { partial: false }, null, words),
    /Nothing in this filter/,
  );
});

// ---- PLANNER-1 slice 1 review fixes: provider descriptors and wording ----

function stubMap(options: {
  readonly stops: readonly {
    recordId: string;
    group: string | null;
    ordinal: number | null;
    point: { latitude: number; longitude: number } | null;
    provenance: string;
  }[];
  readonly values?: (index: number) => Record<string, unknown>;
  readonly displayValues?: (index: number) => Record<string, string>;
  readonly coverage?: Record<string, unknown>;
  readonly url?: string;
}) {
  const { target, choice } = offered();
  const revision = draftMapRevision(target, choice);
  const group = revision.body.group!;
  const surface = {
    label: 'Sales map',
    map: revision,
    surfaceId: revision.surfaceId,
    fields: [
      {
        kind: 'enumFieldType',
        fieldId: group.fieldId,
        options: [
          { optionId: 'north', label: 'North' },
          { optionId: 'south', label: 'South' },
        ],
      },
    ],
  } as unknown as Parameters<typeof readMapSlots>[1];
  const owner = {
    surfaceId: revision.body.listSurfaceId,
    lifecycle: 'active',
    label: 'Parties',
    list: { columns: [{ field: group.fieldId, label: 'Territory' }] },
  } as unknown as Parameters<typeof readMapSlots>[1];
  const record = {
    surfaceId: revision.body.recordSurfaceId,
    lifecycle: 'active',
    fields: [],
  } as unknown as Parameters<typeof readMapSlots>[1];
  const records = options.stops.map((s, i) => ({
    recordId: s.recordId,
    entityId: entity,
    archived: false,
    revision: 1,
    values: options.values?.(i) ?? {},
    ...(options.displayValues && { displayValues: options.displayValues(i) }),
  }));
  const gateways = {
    viewportNavigation: true,
    addresses: { issueViewport: () => 'handle-1' },
    queryGateway: {
      previewEligibility: async () => 'eligible',
      invoke: async () => ({
        outcome: 'exact',
        records,
        mapCoverage: {
          revisionId: revision.revisionId,
          pageSize: 100,
          partial: false,
          stops: options.stops,
          ...options.coverage,
        },
      }),
    },
  } as unknown as Parameters<typeof readMapSlots>[6];
  return {
    revision,
    render: () =>
      readMapSlots(
        {} as Parameters<typeof readMapSlots>[0],
        surface,
        [owner, record],
        new URL(options.url ?? 'http://localhost/'),
        {},
        'company-a',
        gateways,
        (recordId) => '/?record=' + recordId,
      ),
  };
}
const stop = (
  recordId: string,
  group: string,
  ordinal: number,
  latitude: number,
) => ({
  recordId,
  group,
  ordinal,
  point: { latitude, longitude: -114 + ordinal / 100 },
  provenance: 'User pin',
});

test('a third provider declared only in its adapter descriptor drives display and credit', async () => {
  const { MAP_PROVIDERS } =
    await import('../../packages/postgres-provider/src/address-provider.js');
  const { target, choice } = offered();
  const revision = draftMapRevision(target, choice);
  const companyId = randomUUID();
  const recordId = randomUUID();
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
  const request = {
    view: {
      projections: { surface: { payload: { surfaces: [surface] } } },
      pointer: { fence: 1 },
      release: { contentHash: 'test' },
    },
    definition: {
      queryId: revision.body.listQueryId,
      sourceEntityId: entity,
      maximumResultCount: 100,
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
  const candidates = [
    {
      record: {
        recordId,
        entityId: entity,
        archived: false,
        revision: 1,
        values: {},
      },
      group: 'north',
      ordered: true,
      ordinal: 1,
    },
  ];
  const installed = (provider: string) =>
    ({
      query: async () => ({
        rows: [
          {
            installation_id: randomUUID(),
            provider,
            record_id: recordId,
            latitude: '51.05',
            longitude: '-114.07',
          },
        ],
      }),
    }) as unknown as PoolClient;
  // Only the descriptor table changes; the generic page read is unedited.
  const providers = {
    ...MAP_PROVIDERS,
    'osm-like': { display: 'raster', attribution: 'OSM-like tiles' },
    'globe-like': {
      display: 'browser',
      attribution: 'Globe tiles',
      frame: {
        document: 'globe-js',
        title: 'Globe',
        browserKey: () => 'k',
      },
    },
  } as const;
  for (const [name, display, attribution] of [
    ['osm-like', 'raster', 'OSM-like tiles'],
    ['globe-like', 'browser', 'Globe tiles'],
    ['fake', 'raster', 'Demo Maps'],
    ['google', 'browser', 'Google Maps'],
  ] as const) {
    const coverage = (
      await finishMapPage(installed(name), request, candidates, providers)
    ).mapCoverage!;
    assert.equal(coverage.display, display, name);
    assert.equal(coverage.attribution, attribution, name);
    assert.equal(coverage.stops[0]!.provenance, attribution, name);
  }
  // An undeclared provider gets no display at all, not another's.
  const unknown = (
    await finishMapPage(installed('unlisted'), request, candidates, providers)
  ).mapCoverage!;
  assert.equal(unknown.display, undefined);
  assert.equal(unknown.installationId, undefined);
  // The renderer prints the credit it is given.
  const { render } = stubMap({
    stops: [stop(randomUUID(), 'north', 1, 51.05)],
    coverage: {
      installationId: 'i-1',
      display: 'raster',
      attribution: 'OSM-like tiles',
    },
  });
  const slots = await render();
  assert.match(slots.mapCanvas, /<p>OSM-like tiles<\/p>/u);
  assert.match(slots.mapCanvas, /\/map\/image\?/u);
});

test('generic Map code names no map provider', () => {
  for (const file of [
    'packages/postgres-provider/src/map-page.ts',
    'packages/runtime/src/address-gateway.ts',
    'apps/web/src/map-view.ts',
    'apps/web/src/map-display-origins.ts',
    'apps/web/src/app-server.ts',
    'apps/web/src/surface-client.ts',
  ])
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /\b(?:google|fake|demo maps)\b/iu,
      file,
    );
});

test('a Parties map grouped by Territory speaks in its declared labels and titles', async () => {
  const { target, choice } = offered();
  const labelField = draftMapRevision(target, choice).body.label.fieldId;
  const { render } = stubMap({
    stops: [stop(randomUUID(), 'north', 1, 51.05)],
    values: () => ({ [labelField]: 'party-7f3a' }),
    displayValues: () => ({ [labelField]: 'Acme Ltd' }),
    coverage: { hasNext: randomUUID(), total: 30 },
  });
  const slots = await render();
  const all = slots.savedViews + slots.mapCanvas + slots.stopList;
  assert.match(slots.savedViews, /<label>Territory <select name="route">/u);
  assert.match(slots.savedViews, /<option value="ungrouped">No Territory</u);
  assert.match(slots.mapCanvas, /Show all in this filter/u);
  assert.match(slots.mapCanvas, /aria-label="Territory legend"/u);
  assert.match(
    slots.stopList,
    /Showing 1 of 30 in this filter — choose a Territory/u,
  );
  assert.match(all, /1\. Acme Ltd/u);
  assert.doesNotMatch(all, /party-7f3a/u);
  // Visible words only: markup and URLs keep their own parameter names.
  const text = all.replace(/<[^>]*>/gu, ' ');
  assert.doesNotMatch(text, /\bRoutes?\b|All routes|\bstops\b/iu);
});

test('two routes on one page get different styles in first-seen order', async () => {
  const { render } = stubMap({
    stops: [
      stop(randomUUID(), 'north', 1, 51.05),
      stop(randomUUID(), 'north', 2, 51.06),
      stop(randomUUID(), 'south', 1, 51.0),
      stop(randomUUID(), 'south', 2, 51.01),
    ],
  });
  const { mapCanvas } = await render();
  assert.match(mapCanvas, /<li class="group-0">North · solid<\/li>/u);
  assert.match(mapCanvas, /<li class="group-1">South · dashed<\/li>/u);
  assert.match(mapCanvas, /map-route group-0/u);
  assert.match(mapCanvas, /map-route group-1/u);
});

test('Next fits its own page unless an area is chosen, and the summary counts this page', async () => {
  const stops = [
    stop(randomUUID(), 'north', 1, 51.05),
    stop(randomUUID(), 'north', 2, 51.06),
  ];
  const fitted = await stubMap({
    stops,
    coverage: { hasNext: randomUUID() },
    url: 'http://localhost/?cx=3325&cy=7165&zoom=9&size=medium',
  }).render();
  const next = /href="([^"]*)">Next</u.exec(fitted.stopList)![1]!;
  assert.doesNotMatch(next, /[?&](?:amp;)?(?:cx|cy|zoom)=/u);
  assert.match(next, /stops=/u);
  const inArea = await stubMap({
    stops,
    coverage: { hasNext: randomUUID() },
    url: 'http://localhost/?cx=3325&cy=7165&zoom=9&size=medium&area=1',
  }).render();
  assert.match(
    /href="([^"]*)">Next</u.exec(inArea.stopList)![1]!,
    /cx=3325&amp;cy=7165&amp;zoom=9/u,
  );
  // A frame far from the page's pins draws none of them on the canvas.
  const away = await stubMap({
    stops,
    url: 'http://localhost/?cx=100&cy=100&zoom=9&size=medium',
  }).render();
  assert.match(away.mapCanvas, /Map · 0 of 2 on the map/u);
  const own = await stubMap({ stops }).render();
  assert.match(own.mapCanvas, /Map · 2 of 2 on the map/u);
});
