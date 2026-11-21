import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import {
  MAP_SIZES,
  MapViewportSchema,
  mapExtent,
  type MapViewport,
} from '../../canonical-model/src/map-viewport.js';

const contract = Object.freeze({
  id: 'map.viewport/v1',
  style: 'demo-grid/v1',
  language: 'en',
  maxBytes: 1_048_576,
  deadlineMs: 500,
  maxCalls: 1,
  attribution: 'Demo Maps · simulated basemap',
});
export interface MapImageryProvider {
  readonly contract: typeof contract;
  raster(viewport: MapViewport): Promise<Buffer>;
}
function chunk(kind: string, data: Buffer) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(kind, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(
    crc32(bytes.subarray(4, bytes.length - 4)),
    bytes.length - 4,
  );
  return bytes;
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export class FakeMapImageryProvider implements MapImageryProvider {
  readonly contract = contract;
  async raster(input: MapViewport) {
    const v = MapViewportSchema.parse(input),
      [width, height] = MAP_SIZES[v.size],
      box = mapExtent(v);
    const rows = Buffer.alloc((width + 1) * height);
    const step = 2 ** Math.ceil(Math.log2(box.scale * 60));
    const grid = (deg: number) =>
      Math.abs(deg / step - Math.round(deg / step)) < box.scale / step;
    const meridians = Array.from({ length: width }, (_, x) =>
      grid(box.west + x * box.scale),
    );
    for (let y = 0; y < height; y++) {
      const lat = box.north - y * box.scale;
      const parallel = grid(lat);
      for (let x = 0; x < width; x++)
        rows[y * (width + 1) + 1 + x] = parallel || meridians[x] ? 1 : 0;
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 3;
    return Buffer.concat([
      signature,
      chunk('IHDR', header),
      chunk('PLTE', Buffer.from([218, 231, 224, 158, 183, 175])),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}
export interface MapImageScope {
  tenantId: string;
  environmentId: string;
  companyId: string;
  principalId: string;
  fence: string;
  releaseId: string;
  policyVersion: string;
  surfaceId: string;
  installationId: string;
}
export interface MapImageRequest {
  scope: MapImageScope;
  viewport: MapViewport;
}
const lifetime = 120_000;
const publicLifetime = 900_000;
function trim<K, V>(map: Map<K, V>, limit: number) {
  while (map.size >= limit) map.delete(map.keys().next().value!);
}
// A handle represents one human navigation. Only public raster bytes share a cache entry.
export class MapImagery {
  private readonly requests = new Map<
    string,
    MapImageRequest & { expires: number }
  >();
  private readonly publicBytes = new Map<
    string,
    { expires: number; bytes: Promise<Buffer> }
  >();
  constructor(
    private readonly provider: MapImageryProvider = new FakeMapImageryProvider(),
    private readonly now = () => performance.now(),
  ) {}
  issue(scope: MapImageScope, viewport: MapViewport) {
    const handle = randomUUID();
    trim(this.requests, 2048);
    this.requests.set(handle, {
      scope: { ...scope },
      viewport: MapViewportSchema.parse(viewport),
      expires: this.now() + lifetime,
    });
    return handle;
  }
  request(handle: string) {
    const request = this.requests.get(handle);
    return request && request.expires > this.now() ? request : undefined;
  }
  async image(
    handle: string,
    live: MapImageScope,
    reserve: () => Promise<void>,
  ) {
    const req = this.request(handle);
    if (
      !req ||
      req.scope.companyId !== live.companyId ||
      req.scope.tenantId !== live.tenantId ||
      req.scope.environmentId !== live.environmentId ||
      req.scope.principalId !== live.principalId ||
      req.scope.fence !== live.fence ||
      req.scope.releaseId !== live.releaseId ||
      req.scope.policyVersion !== live.policyVersion ||
      req.scope.surfaceId !== live.surfaceId ||
      req.scope.installationId !== live.installationId
    )
      throw new Error('Map image unavailable.');
    const { viewport: v } = req,
      c = this.provider.contract;
    const key = JSON.stringify([
      c.id,
      c.style,
      c.language,
      v.x,
      v.y,
      v.zoom,
      v.size,
    ]);
    const hit = this.publicBytes.get(key);
    if (hit && hit.expires > this.now()) return hit.bytes;
    const bytes = (async () => {
      await reserve();
      const start = this.now(),
        data = await this.provider.raster(v);
      const [width, height] = MAP_SIZES[v.size];
      if (
        this.now() - start > c.deadlineMs ||
        data.length < 33 ||
        data.length > c.maxBytes ||
        !signature.equals(data.subarray(0, 8)) ||
        data.toString('ascii', 12, 16) !== 'IHDR' ||
        data.readUInt32BE(16) !== width ||
        data.readUInt32BE(20) !== height
      )
        throw new Error('Map image unavailable.');
      return data;
    })();
    trim(this.publicBytes, 64);
    this.publicBytes.set(key, { bytes, expires: this.now() + publicLifetime });
    try {
      return await bytes;
    } catch (error) {
      if (this.publicBytes.get(key)?.bytes === bytes)
        this.publicBytes.delete(key);
      throw error;
    }
  }
}
