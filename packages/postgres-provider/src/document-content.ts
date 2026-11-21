import { createHash } from 'node:crypto';
import { decode } from 'jpeg-js';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { crc32, inflateSync } from 'node:zlib';
import {
  DOCUMENT_BLOB_MAX_BYTES,
  DOCUMENT_DEMO_SCANNER_LABEL,
} from '../../canonical-model/src/documents.js';
import { DocumentRequestError } from '../../runtime/src/document-gateway.js';

export interface DocumentScanner {
  readonly mode: 'real' | 'demo';
  readonly label: string;
  readonly policyVersion: string;
  scan(input: {
    readonly bytes: Uint8Array;
    readonly digest: string;
    readonly contentType: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly clean: boolean; readonly digest: string }>;
}

export const DEMO_DOCUMENT_SCANNER: DocumentScanner = Object.freeze({
  mode: 'demo',
  label: DOCUMENT_DEMO_SCANNER_LABEL,
  policyVersion: 'northstar.document-scanner.local-demo/v1',
  async scan({ digest }: Parameters<DocumentScanner['scan']>[0]) {
    return { clean: true, digest };
  },
});

export function documentDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const imagePixels = 16 * 1024 * 1024;

export async function validateDocumentContent(
  bytes: Buffer,
  declared: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    let detected: string;
    if (bytes.length === 0 || bytes.length > DOCUMENT_BLOB_MAX_BYTES)
      throw new Error('size');
    if (bytes.subarray(0, 8).equals(pngSignature)) {
      detected = 'image/png';
      validatePng(bytes);
    } else if (bytes[0] === 255 && bytes[1] === 216) {
      detected = 'image/jpeg';
      validateJpegFraming(bytes);
      const image = decode(bytes, {
        maxResolutionInMP: 16,
        maxMemoryUsageInMB: 96,
        tolerantDecoding: false,
        useTArray: true,
      });
      if (image.width * image.height > imagePixels)
        throw new Error('JPEG dimensions');
    } else if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
      detected = 'application/pdf';
      await validatePdf(bytes, signal);
    } else {
      throw new Error('unknown type');
    }
    if (declared !== detected && declared !== 'application/octet-stream')
      throw new Error('content type mismatch');
    return detected;
  } catch {
    signal?.throwIfAborted();
    throw new DocumentRequestError(
      415,
      'Choose a valid PDF, JPEG or PNG file.',
    );
  }
}

function validateJpegFraming(bytes: Buffer) {
  let cursor = 2;
  let inScan = false;
  let sawScan = false;
  while (cursor < bytes.length) {
    if (inScan) {
      cursor = bytes.indexOf(255, cursor);
      if (cursor === -1) break;
    }
    if (bytes[cursor++] !== 255) throw new Error('JPEG marker');
    while (bytes[cursor] === 255) cursor++;
    const marker = bytes[cursor++];
    if (
      inScan &&
      (marker === 0 || (marker !== undefined && marker >= 208 && marker <= 215))
    )
      continue;
    inScan = false;
    if (marker === 217 && cursor === bytes.length && sawScan) return;
    if (
      marker === undefined ||
      marker === 0 ||
      (marker >= 208 && marker <= 217) ||
      cursor + 2 > bytes.length
    )
      throw new Error('JPEG marker');
    const length = bytes.readUInt16BE(cursor);
    if (length < 2 || cursor + length > bytes.length)
      throw new Error('JPEG segment length');
    cursor += length;
    if (marker === 218) {
      sawScan = true;
      inScan = true;
    }
  }
  throw new Error('JPEG end marker');
}

function validatePng(bytes: Buffer): void {
  let offset = pngSignature.length;
  let expectedRows = 0;
  let rowBytes = 0;
  const data: Buffer[] = [];
  let sawPalette = false;
  let needsPalette = false;
  let endedData = false;
  let chunks = 0;
  while (offset + 12 <= bytes.length) {
    if (++chunks > 4096) throw new Error('PNG chunk count');
    const length = bytes.readUInt32BE(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) throw new Error('PNG chunk length');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const value = bytes.subarray(offset + 8, end);
    if (
      !/^[A-Za-z]{4}$/u.test(type) ||
      crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)
    )
      throw new Error('PNG chunk checksum');
    if (chunks === 1 && type !== 'IHDR') throw new Error('PNG header');
    if (type !== 'IDAT' && data.length) endedData = true;
    switch (type) {
      case 'IHDR': {
        if (chunks !== 1 || value.length !== 13) throw new Error('PNG header');
        const width = value.readUInt32BE(0);
        const height = value.readUInt32BE(4);
        const depth = value[8]!;
        const color = value[9]!;
        const channels = new Map([
          [0, 1],
          [2, 3],
          [3, 1],
          [4, 2],
          [6, 4],
        ]).get(color);
        const depths =
          color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
        if (
          !width ||
          !height ||
          width * height > imagePixels ||
          !channels ||
          !depths.includes(depth) ||
          value[10] ||
          value[11] ||
          value[12]
        )
          throw new Error('PNG dimensions or encoding');
        needsPalette = color === 3;
        expectedRows = height;
        rowBytes = Math.ceil((width * channels * depth) / 8) + 1;
        if (rowBytes * height > 64 * 1024 * 1024)
          throw new Error('PNG decoded size');
        break;
      }
      case 'PLTE':
        if (
          sawPalette ||
          data.length ||
          !length ||
          length > 768 ||
          length % 3 !== 0
        )
          throw new Error('PNG palette');
        sawPalette = true;
        break;
      case 'IDAT':
        if (endedData || (needsPalette && !sawPalette))
          throw new Error('PNG data order');
        data.push(value);
        break;
      case 'IEND': {
        if (length || end + 4 !== bytes.length || !data.length)
          throw new Error('PNG trailer');
        const decoded = inflateSync(Buffer.concat(data), {
          maxOutputLength: rowBytes * expectedRows,
          info: true,
        }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (
          decoded.buffer.length !== rowBytes * expectedRows ||
          decoded.engine.bytesWritten !==
            data.reduce((sum, chunk) => sum + chunk.length, 0)
        )
          throw new Error('PNG raster size');
        for (let row = 0; row < expectedRows; row++) {
          if (decoded.buffer[row * rowBytes]! > 4)
            throw new Error('PNG filter');
        }
        return;
      }
      // The v1 preview accepts the ordinary single-image PNG profile.
      case 'acTL':
      case 'fcTL':
      case 'fdAT':
        throw new Error('animated PNG');
      default:
        if (/^[A-Z]/u.test(type)) throw new Error('unknown PNG critical chunk');
    }
    offset = end + 4;
  }
  throw new Error('PNG trailer missing');
}

// The OS address-space limit also covers native buffers and mappings. A worker
// heap limit alone cannot bound those allocations. prlimit execs the worker in place.
async function validatePdf(bytes: Buffer, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const workerSpecifier = '@north-star/postgres-provider/document-pdf-worker';
  // The production loader resolves from the source twin of a compiled module.
  const workerPath =
    typeof import.meta.resolve === 'function'
      ? fileURLToPath(import.meta.resolve(workerSpecifier))
      : createRequire(import.meta.url).resolve(workerSpecifier);
  const worker = spawn(
    'prlimit',
    [
      '--as=1073741824',
      '--cpu=4',
      '--core=0',
      '--',
      process.execPath,
      '--jitless',
      '--max-old-space-size=96',
      workerPath,
    ],
    { stdio: ['pipe', 'ignore', 'ignore'], env: {} },
  );
  const stop = () => {
    worker.kill('SIGKILL');
  };
  const expires = performance.now() + 5000;
  const timer = setTimeout(stop, 5000);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('close', (code) =>
        code === 0 && performance.now() < expires
          ? resolve()
          : reject(new Error('PDF worker refused input')),
      );
      // An early refusal closes the pipe; the worker exit supplies the verdict.
      worker.stdin.on('error', () => undefined);
      worker.stdin.end(bytes);
    });
    signal?.throwIfAborted();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
