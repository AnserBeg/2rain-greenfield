import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

import { WEB_SURFACE_HEX_LITERAL_BASELINE } from './web-surface-hex-literal.baseline.js';

const HEX_COLOR_LITERAL_PATTERN =
  /(?<![0-9A-Za-z_-])#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})(?![0-9A-Za-z_-])/gu;

interface HexLiteralObservation {
  readonly occurrenceCount: number;
  readonly sourceFilesRead: number;
}

type HexLiteralViolation =
  | 'WEB_SURFACE_HEX_LITERAL_INCREASE'
  | 'WEB_SURFACE_HEX_LITERAL_UNRECORDED_DECREASE';

function observeWebSurfaceHexLiterals(): HexLiteralObservation {
  const sourceRoot = resolve(WEB_SURFACE_HEX_LITERAL_BASELINE.sourceRoot);
  const sourceFiles = discoverFiles(sourceRoot);
  let occurrenceCount = 0;

  for (const sourceFile of sourceFiles) {
    const sourceText = readFileSync(sourceFile, 'utf8');
    occurrenceCount += sourceText.match(HEX_COLOR_LITERAL_PATTERN)?.length ?? 0;
  }

  return { occurrenceCount, sourceFilesRead: sourceFiles.length };
}

function checkWebSurfaceHexLiteralRatchet(
  observation: HexLiteralObservation,
): readonly HexLiteralViolation[] {
  if (
    observation.occurrenceCount ===
    WEB_SURFACE_HEX_LITERAL_BASELINE.occurrenceCount
  ) {
    return [];
  }

  return [
    observation.occurrenceCount >
    WEB_SURFACE_HEX_LITERAL_BASELINE.occurrenceCount
      ? 'WEB_SURFACE_HEX_LITERAL_INCREASE'
      : 'WEB_SURFACE_HEX_LITERAL_UNRECORDED_DECREASE',
  ];
}

function discoverFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      return entry.isDirectory() ? discoverFiles(entryPath) : [entryPath];
    })
    .toSorted();
}

test('web surface source matches the reviewed hex-literal occurrence baseline', () => {
  const observation = observeWebSurfaceHexLiterals();

  assert.ok(
    observation.sourceFilesRead > 0,
    `no source files read below ${relative(process.cwd(), resolve(WEB_SURFACE_HEX_LITERAL_BASELINE.sourceRoot))}`,
  );
  assert.deepEqual(checkWebSurfaceHexLiteralRatchet(observation), []);
  assert.equal(
    observation.occurrenceCount,
    WEB_SURFACE_HEX_LITERAL_BASELINE.occurrenceCount,
  );
});

test('web surface hex-literal ratchet red: baseline plus one fails', () => {
  const observation = observeWebSurfaceHexLiterals();

  assert.deepEqual(
    checkWebSurfaceHexLiteralRatchet({
      ...observation,
      occurrenceCount: WEB_SURFACE_HEX_LITERAL_BASELINE.occurrenceCount + 1,
    }),
    ['WEB_SURFACE_HEX_LITERAL_INCREASE'],
  );
});

test('web surface hex-literal ratchet red: an unrecorded decrease fails', () => {
  const observation = observeWebSurfaceHexLiterals();

  assert.deepEqual(
    checkWebSurfaceHexLiteralRatchet({
      ...observation,
      occurrenceCount: WEB_SURFACE_HEX_LITERAL_BASELINE.occurrenceCount - 1,
    }),
    ['WEB_SURFACE_HEX_LITERAL_UNRECORDED_DECREASE'],
  );
});
