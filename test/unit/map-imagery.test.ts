import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fitMap,
  mapCentre,
  mapExtent,
  MAP_SIZES,
  projectPin,
} from '../../packages/canonical-model/src/map-viewport.js';
import {
  FakeMapImageryProvider,
  MapImagery,
  type MapImageScope,
} from '../../packages/postgres-provider/src/map-imagery.js';

const companyA: MapImageScope = {
  tenantId: 'tenant',
  environmentId: 'env',
  companyId: 'A',
  principalId: 'dispatcher',
  releaseId: 'release',
  fence: '4',
  policyVersion: '7',
  surfaceId: 'map',
  installationId: 'A-install',
};
const companyB = { ...companyA, companyId: 'B', installationId: 'B-install' };
const stop = { latitude: 53.51, longitude: -113.49 };
const v = fitMap([stop], 'small');
test('single-stop fit sends a coarse viewport even at the cell centre', () => {
  for (const p of [stop, { latitude: 53.51234, longitude: -113.49678 }]) {
    const view = fitMap([p, p], 'small'),
      centre = mapCentre(view),
      box = mapExtent(view);
    assert.notDeepEqual(centre, p);
    assert.ok(box.east - box.west >= 0.04);
    const pos = projectPin(view, p);
    assert.ok(pos.x >= 0 && pos.x <= 320 && pos.y >= 0 && pos.y <= 240);
  }
});
test('image request binds its company before cache lookup', async () => {
  const service = new MapImagery(undefined, () => 0),
    handle = service.issue(companyA, v);
  const bytes = await service.image(handle, companyA, async () => {});
  assert.equal(bytes.readUInt32BE(16), 320);
  for (const field of Object.keys(companyA) as (keyof MapImageScope)[]) {
    // Keep every other identity, read grant, installation and fence identical.
    await assert.rejects(
      service.image(handle, { ...companyA, [field]: 'different' }, async () =>
        assert.fail(),
      ),
      /unavailable/,
    );
  }
});
test('separately authorized companies reuse public bytes', async () => {
  let reserves = 0,
    calls = 0;
  const fake = new FakeMapImageryProvider();
  const service = new MapImagery(
    {
      contract: fake.contract,
      async raster(input) {
        calls++;
        return fake.raster(input);
      },
    },
    () => 0,
  );
  const handles = [service.issue(companyA, v), service.issue(companyB, v)];
  const results = await Promise.all(
    handles.map((handle, index) =>
      service.image(handle, index === 0 ? companyA : companyB, async () => {
        reserves++;
      }),
    ),
  );
  assert.deepEqual(results[0], results[1]);
  assert.equal(calls, 1);
  assert.equal(reserves, 1);
});
test('each preset returns a deterministic PNG of the requested dimensions', async () => {
  const provider = new FakeMapImageryProvider();
  for (const size of ['small', 'medium', 'large'] as const) {
    const image = await provider.raster({ ...v, size });
    assert.deepEqual(
      [image.readUInt32BE(16), image.readUInt32BE(20)],
      MAP_SIZES[size],
    );
    assert.deepEqual(image, await provider.raster({ ...v, size }));
  }
});
test('a cold refusal makes no provider call and leaves the viewport retryable', async () => {
  let calls = 0,
    time = 0;
  const fake = new FakeMapImageryProvider();
  const service = new MapImagery(
    {
      contract: fake.contract,
      async raster(input) {
        calls++;
        return fake.raster(input);
      },
    },
    () => time,
  );
  const handle = service.issue(companyA, v);
  await assert.rejects(
    service.image(handle, companyA, async () => {
      throw new Error('quota');
    }),
    /quota/,
  );
  assert.equal(calls, 0);
  await service.image(handle, companyA, async () => {});
  assert.equal(calls, 1);
  time += 120001;
  await assert.rejects(
    service.image(handle, companyA, async () => {}),
    /unavailable/,
  );
});
