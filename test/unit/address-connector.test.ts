import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  AddressInputSchema,
  addressColumnId,
  addressComponents,
  normalizeApplicationPackage,
} from '@north-star/canonical-model';
import {
  applyCustomizationPatches,
  parseCustomizationPatch,
} from '../../packages/customization/src/index.js';
import { lowerStorageTargetV1 } from '../../packages/compiler/src/storage.js';
import { compileAddressBindings } from '../../packages/compiler/src/address.js';
import { addressProvider } from '../../packages/postgres-provider/src/address-provider.js';
import { addressProjectionRefusal } from '../../packages/postgres-provider/src/request-runtime-view-service.js';

const base = JSON.parse(
  readFileSync('apps/web/release/app.authored.json', 'utf8'),
);
function patch(local: string) {
  return {
    kind: 'addAddressField',
    schemaVersion: 'v6',
    entity: 'northstar.app:entity.' + local,
    fieldId: 'northstar.app:field.custom_' + local + '_site',
    label: 'Site',
    required: false,
  } as const;
}
test('Address patches admit the five office types and a tenant type, and refuse receipt and line records', () => {
  for (const local of ['goods_receipt', 'purchase_order_line']) {
    const parsed = parseCustomizationPatch(patch(local));
    assert.equal(parsed.status, 'parsed');
    const result = applyCustomizationPatches(base, [patch(local)]);
    assert.ok(result.status === 'refused');
    assert.equal(result.code, 'CUSTOMIZE_TARGET_IN_TIER_B_DEPENDENCY_SET');
  }
  for (const local of [
    'party',
    'item',
    'location',
    'sales_order',
    'purchase_order',
    'custom_job',
  ]) {
    const result = applyCustomizationPatches(base, [
      ...(local === 'custom_job'
        ? [
            {
              kind: 'addRecordType' as const,
              label: 'Job',
              fields: [{ label: 'Name', type: 'text' as const }],
            },
          ]
        : []),
      patch(local),
    ]);
    assert.ok(result.status === 'applied');
    const compiled = compileAddressBindings(
      normalizeApplicationPackage(result.authored),
    );
    assert.ok(compiled && 'payload' in compiled, JSON.stringify(compiled));
    assert.equal(compiled.payload.bindings[0]?.fieldId, patch(local).fieldId);
  }
});
test('CI selects the deterministic fake even when Google and the real demo are explicitly requested', async (t) => {
  const prior = process.env.CI;
  const demo = process.env.NORTH_STAR_CONNECTOR_DEMO;
  process.env.CI = 'true';
  process.env.NORTH_STAR_CONNECTOR_DEMO = '1';
  t.after(() => {
    if (prior === undefined) delete process.env.CI;
    else process.env.CI = prior;
    if (demo === undefined) delete process.env.NORTH_STAR_CONNECTOR_DEMO;
    else process.env.NORTH_STAR_CONNECTOR_DEMO = demo;
  });
  const transport = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('unexpected network');
  });
  const selection = addressProvider(
    {
      tenantId: randomUUID(),
      companyId: randomUUID(),
      environmentId: randomUUID(),
      installationId: randomUUID(),
      account: 'test',
    },
    'google',
    true,
    true,
  );
  const pin = await selection.geocode('47 Jasper Street');
  assert.equal(selection.name, 'fake');
  assert.deepEqual(await selection.geocode('47 Jasper Street'), pin);
  assert.match(selection.staticMap(pin) ?? '', /Demo Maps/);
  assert.equal(transport.mock.callCount(), 0);
});
test('typed text alone satisfies Address presence and a user pin must be finite and in range', () => {
  const value = {
    schemaVersion: 'northstar.address-value/v1',
    text: '123 Avenue',
  };
  assert.ok(AddressInputSchema.safeParse(value).success);
  for (const extra of [
    { text: ' ' },
    { pin: { kind: 'user', latitude: '90.1', longitude: '0' } },
    { pin: { kind: 'google', latitude: '0', longitude: '0' } },
  ])
    assert.equal(
      AddressInputSchema.safeParse({ ...value, ...extra }).success,
      false,
    );
});

test('retiring a logical Address withdraws its binding and map while retaining every scalar for rollback', () => {
  const add = patch('item');
  const surfaceId = 'northstar.app:surface.item_detail';
  const map = {
    kind: 'addMapPlacement' as const,
    schemaVersion: 'v6' as const,
    fieldId: add.fieldId,
    surfaceId,
    placementId: 'northstar.app:placement.custom_site_map',
    sectionId:
      surfaceId + '/detail/northstar.app:slot.item_detail_sections/details',
  };
  const result = applyCustomizationPatches(base, [add, map]);
  assert.ok(result.status === 'applied');
  const definition = normalizeApplicationPackage(result.authored);
  const serving = compileAddressBindings(definition);
  assert.ok(serving && 'payload' in serving);
  assert.deepEqual(
    serving.payload.placements.map((p) => p.placementId),
    [map.placementId],
  );
  const field = definition.fields.find((f) => f.fieldId === add.fieldId)!;
  const activeStorage = lowerStorageTargetV1(definition);
  const retired = {
    ...definition,
    fields: definition.fields.map((f) =>
      f === field ? { ...f, lifecycle: 'retired' as const } : f,
    ),
  };
  const projection = compileAddressBindings(retired);
  assert.ok(projection && 'payload' in projection);
  assert.deepEqual(projection.payload.retiredFieldIds, [add.fieldId]);
  assert.deepEqual(projection.payload.bindings, []);
  assert.deepEqual(projection.payload.placements, []);
  const fieldIds = new Set(
    addressComponents.map((component) =>
      addressColumnId(add.fieldId, component),
    ),
  );
  const columns = (storage: typeof activeStorage) =>
    storage.entities
      .find((entity) => entity.entityId === add.entity)!
      .columns.filter((column) => fieldIds.has(column.canonicalFieldId));
  assert.equal(columns(activeStorage).length, fieldIds.size);
  assert.deepEqual(
    columns(lowerStorageTargetV1(retired, activeStorage)),
    columns(activeStorage),
  );
});

// The loader's Address agreement, one comparator per test. The PostgreSQL
// request-runtime-view suite proves load() applies it to a persisted release.
const binding = {
  schemaVersion: 'v6',
  fieldId: 'northstar.app:field.custom_item_site',
  entityId: 'northstar.app:entity.item',
  contractVersion: 'northstar.address/v1',
  mappingVersion: 'v1',
  recordQueryId: 'northstar.app:query.item_get',
  editOperationIds: ['northstar.app:operation.item_update'],
  suggestQueryId: 'northstar.app:query.item_address_suggest',
  geocodeOperationId: 'northstar.app:operation.item_address_geocode',
  mapQueryId: 'northstar.app:query.item_address_map',
} as const;
const placement = {
  schemaVersion: 'v6',
  placementId: 'northstar.app:placement.custom_item_map',
  fieldId: binding.fieldId,
  surfaceId: 'northstar.app:surface.item_detail',
  sectionId: 'northstar.app:surface.item_detail/detail/sections/details',
} as const;
const consistent = (placements: readonly object[] = []) => ({
  linked: true,
  declared: true,
  consumerPayloads: [0, 1, 2].map(() => ({ addressBindings: [binding] })),
  surfaceFloor: placements.length ? 32 : 31,
  connector: () => ({
    kind: 'connectorPayload',
    schemaVersion: 'northstar.connector-payload/v1',
    bindings: [binding],
    placements,
    layouts: [],
  }),
});
test('the loader serves a consistent Address release with and without a map placement', () => {
  assert.equal(addressProjectionRefusal(consistent()), null);
  assert.equal(addressProjectionRefusal(consistent([placement])), null);
  assert.equal(
    addressProjectionRefusal({
      linked: false,
      declared: false,
      consumerPayloads: [{}, {}, {}],
      surfaceFloor: 30,
      connector: () => assert.fail('an undeclared connector was read'),
    }),
    null,
  );
});
test('the loader refuses a connector link without its declaration', () => {
  // Nothing else is wrong: no consumer is bound and the floor is below Address.
  assert.equal(
    addressProjectionRefusal({
      linked: true,
      declared: false,
      consumerPayloads: [{}, {}, {}],
      surfaceFloor: 30,
      connector: () => assert.fail('an undeclared connector was read'),
    }),
    'Address declarations and consumers disagree.',
    'a linked but undeclared connector was served',
  );
});
test('the loader refuses a map placement below the map reader floor', () => {
  assert.equal(
    addressProjectionRefusal({ ...consistent([placement]), surfaceFloor: 31 }),
    'Address bindings or surface floor are invalid.',
    'a map placement was served at the Address field floor',
  );
});
test('the loader refuses a consumer that pins different Address bindings', () => {
  const release = consistent();
  assert.equal(
    addressProjectionRefusal({
      ...release,
      consumerPayloads: [
        ...release.consumerPayloads.slice(0, 2),
        {
          addressBindings: [
            { ...binding, mapQueryId: 'northstar.app:query.item_other_map' },
          ],
        },
      ],
    }),
    'Address bindings or surface floor are invalid.',
    'a consumer with different Address bindings was served',
  );
});
