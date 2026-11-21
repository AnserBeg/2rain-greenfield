import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fitMap,
  mapCentre,
  mapExtent,
  panMap,
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
  const exactCentre = mapCentre(v);
  for (const points of [[stop], [exactCentre], [exactCentre, exactCentre]]) {
    const p = points[0]!;
    const view = fitMap(points, 'small'),
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

test('keyboard pan reaches the next coarse cell on every size at maximum zoom', () => {
  for (const size of ['small', 'medium', 'large'] as const) {
    const view = { x: 9000, y: 4500, zoom: 13, size };
    const [, height] = MAP_SIZES[size];
    const north = panMap(view, 0, -height / 3);
    assert.ok(north.y > view.y);
    assert.deepEqual(panMap(north, 0, height / 3), view);
    assert.deepEqual(panMap({ ...view, y: 8999 }, 0, -1), { ...view, y: 8999 });
  }
});

test('a timed-out adapter is cancelled and an issued navigation reserves at most once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers<AbortSignal>();
  const fake = new FakeMapImageryProvider();
  let reserves = 0;
  const service = new MapImagery(
    {
      contract: fake.contract,
      raster(_view, signal) {
        started.resolve(signal);
        return new Promise<Buffer>(() => {});
      },
    },
    () => 0,
  );
  const handle = service.issue(companyA, v);
  const reserve = async () => {
    reserves++;
  };
  const refused = assert.rejects(
    service.image(handle, companyA, reserve),
    /unavailable/,
  );
  const signal = await started.promise;
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(fake.contract.deadlineMs);
  await refused;
  assert.equal(signal.aborted, true);
  await assert.rejects(service.image(handle, companyA, reserve), /unavailable/);
  assert.equal(reserves, 1);
});

test('late, oversized and mismatched rasters never populate the public cache', async () => {
  const fake = new FakeMapImageryProvider();
  const valid = await fake.raster(v);
  const changed = (offset: number) => {
    const bytes = Buffer.from(valid);
    bytes[offset] = bytes[offset]! ^ 1;
    return bytes;
  };
  for (const invalid of [
    valid.subarray(0, 32),
    Buffer.concat([valid, Buffer.alloc(fake.contract.maxBytes)]),
    changed(0),
    changed(12),
    changed(19),
    changed(23),
    valid,
  ]) {
    let clock = 0;
    let calls = 0;
    const service = new MapImagery(
      {
        contract: fake.contract,
        async raster() {
          if (++calls === 1) {
            if (invalid === valid) clock += fake.contract.deadlineMs + 1;
            return invalid;
          }
          return valid;
        },
      },
      () => clock,
    );
    const first = service.issue(companyA, v);
    await assert.rejects(
      service.image(first, companyA, async () => {}),
      /unavailable/,
    );
    const second = service.issue(companyB, v);
    assert.deepEqual(
      await service.image(second, companyB, async () => {}),
      valid,
    );
    assert.equal(calls, 2);
  }
});
