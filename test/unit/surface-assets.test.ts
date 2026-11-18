import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { createSurfaceRuntimeServer } from '../../apps/web/src/app-server.js';
import { FONT_STYLESHEET_HREF } from '../../apps/web/src/surface-assets.js';
import { SURFACE_STYLESHEET } from '../../apps/web/src/surface-runtime.js';

// SPEED-1 slice 5: the stylesheet is served once from its content-hash route,
// immutable and precompressed; pages link it; the CSP admits no inline style.

test('SPEED-1 assets: the stylesheet route is immutable and compressed; pages link it under style-src self', async () => {
  const server = createSurfaceRuntimeServer(
    // The asset route and an unknown route never reach request entry.
    {} as Parameters<typeof createSurfaceRuntimeServer>[0],
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  try {
    assert.match(
      SURFACE_STYLESHEET.href,
      /^\/assets\/surface-[0-9a-f]{20}\.css$/u,
    );
    const raw = async (encoding: string) => {
      const { request } = await import('node:http');
      return new Promise<{
        body: Buffer;
        headers: Record<string, string | string[] | undefined>;
        status: number;
      }>((resolve, reject) => {
        const outgoing = request(
          `${base}${SURFACE_STYLESHEET.href}`,
          { headers: { 'accept-encoding': encoding } },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
            incoming.on('end', () => {
              resolve({
                body: Buffer.concat(chunks),
                headers: incoming.headers,
                status: incoming.statusCode ?? 0,
              });
            });
          },
        );
        outgoing.on('error', reject);
        outgoing.end();
      });
    };
    const brotli = await raw('gzip, br');
    assert.equal(brotli.status, 200);
    assert.equal(
      brotli.headers['cache-control'],
      'public, max-age=31536000, immutable',
    );
    assert.equal(brotli.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(brotli.headers['content-encoding'], 'br');
    assert.equal(
      brotliDecompressSync(brotli.body).toString('utf8'),
      SURFACE_STYLESHEET.css,
    );
    const gzip = await raw('gzip');
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.equal(
      gunzipSync(gzip.body).toString('utf8'),
      SURFACE_STYLESHEET.css,
    );
    const identity = await raw('identity, br;q=0');
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.equal(identity.body.toString('utf8'), SURFACE_STYLESHEET.css);

    // Another hash is not the stylesheet; a page is personal and no-store,
    // links the stylesheet, and carries no inline style.
    const stale = await fetch(
      `${base}/assets/surface-00000000000000000000.css`,
    );
    assert.equal(stale.status, 404);
    assert.equal(stale.headers.get('cache-control'), 'no-store');
    const csp = stale.headers.get('content-security-policy') ?? '';
    assert.match(csp, /style-src 'self';/u);
    assert.match(csp, /font-src 'self';/u);
    assert.doesNotMatch(csp, /unsafe-inline/u);
    const page = await stale.text();
    assert.ok(
      page.includes(
        `<link rel="stylesheet" href="${SURFACE_STYLESHEET.href}">`,
      ),
    );
    assert.doesNotMatch(page, /<style\b|\sstyle=/u);

    // The fonts: their own stylesheet, every face a pinned WOFF2 on its own
    // immutable route; nothing from a font host.
    assert.ok(
      page.includes(`<link rel="stylesheet" href="${FONT_STYLESHEET_HREF}">`),
    );
    const fonts = await fetch(`${base}${FONT_STYLESHEET_HREF}`);
    assert.equal(fonts.status, 200);
    const faces = await fonts.text();
    const urls = [...faces.matchAll(/url\(([^)]+)\)/gu)].map(
      (match) => match[1]!,
    );
    assert.equal(urls.length, 12, 'six faces, Latin and Latin Extended each');
    for (const family of ['IBM Plex Sans', 'IBM Plex Serif', 'IBM Plex Mono'])
      assert.ok(faces.includes(`font-family:'${family}'`), family);
    for (const url of urls) {
      assert.match(
        url,
        /^\/assets\/ibm-plex-[a-z]+-latin(?:-ext)?-[456]00-normal-[0-9a-f]{20}\.woff2$/u,
      );
      const font = await fetch(`${base}${url}`);
      assert.equal(font.status, 200);
      assert.equal(font.headers.get('content-type'), 'font/woff2');
      assert.equal(
        font.headers.get('cache-control'),
        'public, max-age=31536000, immutable',
      );
      assert.equal(
        Buffer.from(await font.arrayBuffer())
          .subarray(0, 4)
          .toString('latin1'),
        'wOF2',
      );
    }
  } finally {
    server.close();
  }
});

test('SPEED-1 assets: no web template carries an inline style the CSP would refuse', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const offenders = readdirSync('apps/web/src')
    .filter((name) => name.endsWith('.ts'))
    .filter((name) =>
      /<style\b|\sstyle="/u.test(readFileSync(`apps/web/src/${name}`, 'utf8')),
    );
  assert.deepEqual(offenders, []);
});

test('SPEED-1 assets: a page is compressed when the client accepts it, and stays no-store', async () => {
  const html = `<!doctype html><p>${'Purchase order '.repeat(400)}</p>`;
  const server = createSurfaceRuntimeServer({
    run: async () => ({ html, statusCode: 200 }),
  } as unknown as Parameters<typeof createSurfaceRuntimeServer>[0]);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { request } = await import('node:http');
  const get = (encoding: string) =>
    new Promise<{
      body: Buffer;
      headers: Record<string, string | string[] | undefined>;
    }>((resolve, reject) => {
      const outgoing = request(
        `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`,
        { headers: { 'accept-encoding': encoding } },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () => {
            resolve({ body: Buffer.concat(chunks), headers: incoming.headers });
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  try {
    const compressed = await get('br');
    assert.equal(compressed.headers['content-encoding'], 'br');
    assert.equal(compressed.headers['cache-control'], 'no-store');
    assert.equal(compressed.headers.vary, 'accept-encoding');
    assert.equal(brotliDecompressSync(compressed.body).toString('utf8'), html);
    assert.ok(compressed.body.length < html.length / 4);
    const plain = await get('identity');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString('utf8'), html);
  } finally {
    server.close();
  }
});
