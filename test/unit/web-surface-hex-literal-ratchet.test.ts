import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

import {
  createArchitectureFixture,
  removeArchitectureFixture,
} from '../helpers/architecture-fixture.js';
import { WEB_SURFACE_HEX_LITERAL_BASELINE } from './web-surface-hex-literal.baseline.js';

const HEX_COLOR_LITERAL_PATTERN =
  /(?<![0-9A-Za-z_-])#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})(?![0-9A-Za-z_-])/gu;

interface HexLiteralOccurrence {
  readonly file: string;
  readonly index: number;
  readonly literal: string;
}

interface HexLiteralObservation {
  readonly occurrenceCount: number;
  readonly occurrences: readonly HexLiteralOccurrence[];
  readonly occurrencesOutsideTokenBlock: readonly HexLiteralOccurrence[];
  readonly sourceFilesRead: number;
  readonly tokenBlockFound: boolean;
}

type HexLiteralViolation =
  | 'WEB_SURFACE_HEX_LITERAL_INCREASE'
  | 'WEB_SURFACE_HEX_LITERAL_OUTSIDE_TOKEN_BLOCK'
  | 'WEB_SURFACE_HEX_LITERAL_TOKEN_BLOCK_MISSING'
  | 'WEB_SURFACE_HEX_LITERAL_UNRECORDED_DECREASE';

/**
 * ADR-0035 replaced "how much literal-colour debt is left" with "where is the
 * colour declared". The scan is unchanged — every file below `sourceRoot`, read
 * from source — but the fact it now observes is that each occurrence sits
 * inside the one delimited token-definition block. A literal on a render path
 * fails even when the total is unmoved, which is the case a pure count ratchet
 * cannot see.
 */
function observeWebSurfaceHexLiterals(
  rootDirectory = process.cwd(),
): HexLiteralObservation {
  const sourceRoot = resolve(
    rootDirectory,
    WEB_SURFACE_HEX_LITERAL_BASELINE.sourceRoot,
  );
  const sourceFiles = discoverFiles(sourceRoot);
  const tokenBlock = tokenBlockRange(rootDirectory);
  const occurrences: HexLiteralOccurrence[] = [];

  for (const sourceFile of sourceFiles) {
    const repoPath = repositoryPath(rootDirectory, sourceFile);
    const sourceText = readFileSync(sourceFile, 'utf8');
    for (const match of sourceText.matchAll(HEX_COLOR_LITERAL_PATTERN)) {
      occurrences.push({
        file: repoPath,
        index: match.index,
        literal: match[0],
      });
    }
  }

  return {
    occurrenceCount: occurrences.length,
    occurrences,
    occurrencesOutsideTokenBlock: occurrences.filter(
      (occurrence) =>
        tokenBlock === null ||
        occurrence.file !==
          WEB_SURFACE_HEX_LITERAL_BASELINE.tokenBlock.sourceFile ||
        occurrence.index < tokenBlock.start ||
        occurrence.index > tokenBlock.end,
    ),
    sourceFilesRead: sourceFiles.length,
    tokenBlockFound: tokenBlock !== null,
  };
}

function tokenBlockRange(
  rootDirectory: string,
): { readonly end: number; readonly start: number } | null {
  const { end, sourceFile, start } =
    WEB_SURFACE_HEX_LITERAL_BASELINE.tokenBlock;
  let source: string;
  try {
    source = readFileSync(resolve(rootDirectory, sourceFile), 'utf8');
  } catch {
    return null;
  }
  const startIndex = source.indexOf(start);
  if (startIndex < 0) return null;
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) return null;
  return { end: endIndex, start: startIndex };
}

function checkWebSurfaceHexLiteralRatchet(
  observation: HexLiteralObservation,
): readonly HexLiteralViolation[] {
  const violations: HexLiteralViolation[] = [];
  if (!observation.tokenBlockFound) {
    violations.push('WEB_SURFACE_HEX_LITERAL_TOKEN_BLOCK_MISSING');
  }
  if (observation.occurrencesOutsideTokenBlock.length > 0) {
    violations.push('WEB_SURFACE_HEX_LITERAL_OUTSIDE_TOKEN_BLOCK');
  }
  if (
    observation.occurrenceCount >
    WEB_SURFACE_HEX_LITERAL_BASELINE.occurrenceCount
  ) {
    violations.push('WEB_SURFACE_HEX_LITERAL_INCREASE');
  } else if (
    observation.occurrenceCount <
    WEB_SURFACE_HEX_LITERAL_BASELINE.occurrenceCount
  ) {
    violations.push('WEB_SURFACE_HEX_LITERAL_UNRECORDED_DECREASE');
  }
  return violations;
}

function discoverFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      return entry.isDirectory() ? discoverFiles(entryPath) : [entryPath];
    })
    .toSorted();
}

function repositoryPath(rootDirectory: string, file: string): string {
  return relative(resolve(rootDirectory), file).split(sep).join('/');
}

/**
 * A copy of the real web source below a temporary root, so the negative
 * controls exercise the same scan against a genuinely mutated tree instead of a
 * hand-built observation object. The verifier never shares a code path with the
 * thing it verifies: `injections` writes files, the scan only reads them.
 */
function webSourceFixture(injections: Record<string, string> = {}): string {
  const sourceRoot = resolve(WEB_SURFACE_HEX_LITERAL_BASELINE.sourceRoot);
  const files: Record<string, string> = {};
  for (const file of discoverFiles(sourceRoot)) {
    files[repositoryPath(process.cwd(), file)] = readFileSync(file, 'utf8');
  }
  for (const [path, source] of Object.entries(injections)) {
    files[path] = source;
  }
  return createArchitectureFixture(files);
}

test('web surface colour literals all resolve inside the one token-definition block', () => {
  const observation = observeWebSurfaceHexLiterals();

  assert.ok(
    observation.sourceFilesRead > 0,
    `no source files read below ${relative(process.cwd(), resolve(WEB_SURFACE_HEX_LITERAL_BASELINE.sourceRoot))}`,
  );
  // Without this the location check passes vacuously on a tree with no colour
  // in it at all, which is exactly what a half-finished extraction looks like.
  assert.ok(
    observation.occurrenceCount > 0,
    'no hex colour literals read; the token block itself must declare the palette',
  );
  assert.ok(observation.tokenBlockFound);
  console.log(
    `web surface hex literals: ${String(observation.occurrenceCount)} occurrences across ${String(observation.sourceFilesRead)} files, ${String(observation.occurrencesOutsideTokenBlock.length)} outside the token block`,
  );

  assert.deepEqual(
    observation.occurrencesOutsideTokenBlock.map(
      (occurrence) => `${occurrence.file}:${occurrence.literal}`,
    ),
    [],
  );
  assert.deepEqual(checkWebSurfaceHexLiteralRatchet(observation), []);
  assert.equal(
    observation.occurrenceCount,
    WEB_SURFACE_HEX_LITERAL_BASELINE.occurrenceCount,
  );
});

test('token-block red: a hex literal injected into a render path is located and fails', () => {
  const runtimePath = 'apps/web/src/surface-runtime.ts';
  const root = webSourceFixture({
    [runtimePath]: readFileSync(resolve(runtimePath), 'utf8').replace(
      '.record-link{color:var(--accent-ink)',
      '.record-link{color:#1478AE',
    ),
  });

  try {
    const observation = observeWebSurfaceHexLiterals(root);
    assert.ok(observation.sourceFilesRead > 0);
    assert.deepEqual(
      observation.occurrencesOutsideTokenBlock.map(
        (occurrence) => `${occurrence.file}:${occurrence.literal}`,
      ),
      [`${runtimePath}:#1478AE`],
    );
    assert.deepEqual(checkWebSurfaceHexLiteralRatchet(observation), [
      'WEB_SURFACE_HEX_LITERAL_OUTSIDE_TOKEN_BLOCK',
      'WEB_SURFACE_HEX_LITERAL_INCREASE',
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('token-block red: a literal moved out of the block fails while the count is unchanged', () => {
  const tokensPath = WEB_SURFACE_HEX_LITERAL_BASELINE.tokenBlock.sourceFile;
  const tokens = readFileSync(resolve(tokensPath), 'utf8');
  const root = webSourceFixture({
    // The palette shrinks by one and the render path gains one, so the total is
    // unmoved. A count-only ratchet is silent here; the location check is not.
    [tokensPath]: tokens.replace('--n0:#FFFFFF;', '--n0:white;'),
    'apps/web/src/surface-runtime.ts': readFileSync(
      resolve('apps/web/src/surface-runtime.ts'),
      'utf8',
    ).replace('.muted{color:var(--ink-muted)}', '.muted{color:#FFFFFF}'),
  });

  try {
    const observation = observeWebSurfaceHexLiterals(root);
    assert.equal(
      observation.occurrenceCount,
      WEB_SURFACE_HEX_LITERAL_BASELINE.occurrenceCount,
    );
    assert.deepEqual(checkWebSurfaceHexLiteralRatchet(observation), [
      'WEB_SURFACE_HEX_LITERAL_OUTSIDE_TOKEN_BLOCK',
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
});

test('token-block red: a missing token block is reported rather than passing empty', () => {
  const tokensPath = WEB_SURFACE_HEX_LITERAL_BASELINE.tokenBlock.sourceFile;
  const root = webSourceFixture({
    [tokensPath]: readFileSync(resolve(tokensPath), 'utf8').replace(
      WEB_SURFACE_HEX_LITERAL_BASELINE.tokenBlock.start,
      '/* removed */',
    ),
  });

  try {
    const observation = observeWebSurfaceHexLiterals(root);
    assert.equal(observation.tokenBlockFound, false);
    assert.deepEqual(checkWebSurfaceHexLiteralRatchet(observation), [
      'WEB_SURFACE_HEX_LITERAL_TOKEN_BLOCK_MISSING',
      'WEB_SURFACE_HEX_LITERAL_OUTSIDE_TOKEN_BLOCK',
    ]);
  } finally {
    removeArchitectureFixture(root);
  }
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
