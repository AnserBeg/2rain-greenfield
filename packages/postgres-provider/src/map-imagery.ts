import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import {
  MAP_SIZES,
  MapViewportSchema,
  mapExtent,
  mercatorLatitude,
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
  readonly contract: {
    id: string;
    style: string;
    language: string;
    attribution: string;
    maxBytes: number;
    deadlineMs: number;
    maxCalls: 1;
  };
  raster(viewport: MapViewport, signal: AbortSignal): Promise<Buffer>;
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
    const meridians = Buffer.from(
      Array.from({ length: width }, (_, x) =>
        Number(grid(box.west + x * box.scale)),
      ),
    );
    for (let y = 0; y < height; y++) {
      const start = y * (width + 1) + 1;
      if (grid(mercatorLatitude(box.top - y * box.scale)))
        rows.fill(1, start, start + width);
      else meridians.copy(rows, start);
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
    MapImageRequest & { expires: number; called: boolean }
  >();
  private readonly publicBytes = new Map<
    string,
    { expires: number; bytes: Buffer }
  >();
  private readonly pending = new Map<string, Promise<Buffer>>();
  constructor(
    private readonly provider: MapImageryProvider = new FakeMapImageryProvider(),
    private readonly now = () => performance.now(),
  ) {}
  issue(scope: MapImageScope, viewport: MapViewport) {
    const handle = randomUUID();
    trim(this.requests, 2048);
    this.requests.set(handle, {
      scope: { ...scope },
      called: false,
      viewport: MapViewportSchema.parse(viewport),
      expires: this.now() + lifetime,
    });
    return handle;
  }
  request(handle: string) {
    const request = this.requests.get(handle);
    return request && request.expires > this.now() ? request : undefined;
  }
  private authorized(handle: string, live: MapImageScope) {
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
    return req;
  }
  async browserViewport(
    handle: string,
    live: MapImageScope,
    reserve: () => Promise<void>,
  ) {
    const req = this.authorized(handle, live);
    if (req.called) throw new Error('Map display unavailable.');
    req.called = true;
    await reserve();
    return req.viewport;
  }
  async image(
    handle: string,
    live: MapImageScope,
    reserve: () => Promise<void>,
  ) {
    const req = this.authorized(handle, live);
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
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    if (req.called || this.pending.size >= 64)
      throw new Error('Map image unavailable.');
    const fetchRaster = async () => {
      await reserve();
      req.called = true;
      const start = this.now();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Map image unavailable.'));
        }, c.deadlineMs);
      });
      try {
        const data = await Promise.race([
          this.provider.raster(v, controller.signal),
          deadline,
        ]);
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
        trim(this.publicBytes, 64);
        this.publicBytes.set(key, {
          bytes: data,
          expires: this.now() + publicLifetime,
        });
        return data;
      } finally {
        clearTimeout(timer);
      }
    };
    const bytes = fetchRaster();
    this.pending.set(key, bytes);
    try {
      return await bytes;
    } finally {
      this.pending.delete(key);
    }
  }
}
