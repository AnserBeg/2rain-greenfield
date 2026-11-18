import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from 'node:zlib';

/**
 * SPEED-1 slice 5: the runtime's static assets, served same-origin from
 * content-hash routes (`/assets/<name>-<sha256>.<ext>`) for a year, immutable:
 * a changed file is a new route. Nothing here is personal or tenant data.
 *
 * The fonts are IBM Plex (OFL-1.1) from the pinned `@fontsource/ibm-plex-*`
 * packages, read once at start; nothing is fetched from a font host. Only the
 * Latin and Latin Extended subsets, as WOFF2, are served; their `@font-face`
 * rules keep each subset's `unicode-range`, so a page downloads only the faces
 * and subsets it draws.
 */
export interface StaticAsset {
  readonly body: Buffer;
  readonly contentType: string;
  /** Precompressed bodies; absent for formats that are compressed already. */
  readonly encodings: Readonly<{ br?: Buffer; gzip?: Buffer }>;
}

const FONT_FAMILIES = [
  ['ibm-plex-sans', 'IBM Plex Sans', [400, 500, 600]],
  ['ibm-plex-serif', 'IBM Plex Serif', [500]],
  ['ibm-plex-mono', 'IBM Plex Mono', [400, 500]],
] as const;
const FONT_SUBSETS = ['latin', 'latin-ext'] as const;

const assets = new Map<string, StaticAsset>();

/** The route of `body` under `name`, registered for serving. */
export function registerStaticAsset(
  name: string,
  extension: string,
  contentType: string,
  body: Buffer,
  compress: boolean,
): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 20);
  const href = `/assets/${name}-${hash}.${extension}`;
  assets.set(
    href,
    Object.freeze({
      body,
      contentType,
      encodings: compress
        ? Object.freeze({
            br: brotliCompressSync(body, {
              params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
            }),
            gzip: gzipSync(body, { level: 9 }),
          })
        : Object.freeze({}),
    }),
  );
  return href;
}

export function staticAsset(pathname: string): StaticAsset | undefined {
  return assets.get(pathname);
}

function fontFaces(): string {
  const require = createRequire(import.meta.url);
  const faces: string[] = [];
  for (const [packageName, family, weights] of FONT_FAMILIES) {
    for (const weight of weights) {
      const cssPath = require.resolve(
        `@fontsource/${packageName}/${String(weight)}.css`,
      );
      const css = readFileSync(cssPath, 'utf8');
      for (const subset of FONT_SUBSETS) {
        const file = `${packageName}-${subset}-${String(weight)}-normal`;
        const range = new RegExp(
          `/\\* ${file} \\*/\\s*@font-face \\{[^}]*unicode-range: ([^;]+);`,
          'u',
        ).exec(css)?.[1];
        if (!range)
          throw new Error(`@fontsource/${packageName} has no ${file} face`);
        const href = registerStaticAsset(
          file,
          'woff2',
          'font/woff2',
          readFileSync(join(dirname(cssPath), 'files', `${file}.woff2`)),
          false,
        );
        faces.push(
          `@font-face{font-family:'${family}';font-style:normal;font-display:swap;font-weight:${String(weight)};src:url(${href}) format('woff2');unicode-range:${range}}`,
        );
      }
    }
  }
  return `${faces.join('\n')}\n`;
}

/** The `@font-face` rules for every served face, as their own stylesheet. */
export const FONT_STYLESHEET_HREF = registerStaticAsset(
  'fonts',
  'css',
  'text/css; charset=utf-8',
  Buffer.from(fontFaces(), 'utf8'),
  true,
);
