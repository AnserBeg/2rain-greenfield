import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getEncoding } from 'js-tiktoken';

import {
  canonicalAuthoredProjection,
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
} from '../../../packages/canonical-model/src/index.js';

const fixturePath =
  'test/fixtures/canonical-model/representative.authored.json';

test('normalization laws converge sparse, explicit, reordered, and canonical-authored forms', () => {
  const authored = parseAuthoredApplicationPackageJson(
    readFileSync(fixturePath),
  );
  const normalized = normalizeApplicationPackage(authored);
  const normalizedAgain = normalizeApplicationPackage(normalized);
  const canonicalAuthored = canonicalAuthoredProjection(normalized);
  const projectedAgain = normalizeApplicationPackage(canonicalAuthored);

  const reordered = structuredClone(authored);
  reordered.entities.reverse();
  reordered.fields.reverse();
  reordered.permissions.reverse();
  reordered.storageMappings.reverse();
  reordered.capabilityRequirements.reverse();
  reordered.capabilityRequirements.forEach((capability) =>
    capability.requiredProjections.reverse(),
  );
  const reorderedAgain = normalizeApplicationPackage(reordered);

  const expected = canonicalize(normalized);
  assert.equal(canonicalize(normalizedAgain), expected);
  assert.equal(canonicalize(projectedAgain), expected);
  assert.equal(canonicalize(reorderedAgain), expected);
  assert.equal(normalized.fields[0]?.lifecycle, 'active');
  assert.equal(normalized.fields[0]?.presence, 'optional');
});

test('representative normalized package has the pinned content hash', () => {
  const normalized = normalizeApplicationPackage(
    parseAuthoredApplicationPackageJson(readFileSync(fixturePath)),
  );
  const expectedHash = readFileSync(
    'test/fixtures/canonical-model/representative.normalized.golden.sha256',
    'utf8',
  ).trim();
  assert.equal(canonicalizeAndHash(normalized).contentHash, expectedHash);
});

test('canonical byte and domain-separated hash vectors are stable', () => {
  const vector = {
    z: 0,
    array: [{ kind: 'x', value: '-12.34' }, true, null],
    a: 'é',
  };
  const expectedHex = readFileSync(
    'test/fixtures/canonical-model/canonical-profile.golden.bytes',
    'utf8',
  ).trim();
  const expectedHash = readFileSync(
    'test/fixtures/canonical-model/canonical-profile.golden.sha256',
    'utf8',
  ).trim();
  const result = canonicalizeAndHash(vector);
  assert.equal(Buffer.from(result.bytes).toString('hex'), expectedHex);
  assert.equal(result.contentHash, expectedHash);
  assert.notEqual(canonicalize({ value: 'é' }), canonicalize({ value: 'é' }));
});

test('fresh pinned-Node processes ignore timezone and locale inputs', () => {
  const script = [
    "import {readFileSync} from 'node:fs';",
    "import {canonicalizeAndHash,normalizeApplicationPackage,parseAuthoredApplicationPackageJson} from './packages/canonical-model/src/index.ts';",
    "const input=readFileSync('./test/fixtures/canonical-model/representative.authored.json');",
    'const result=canonicalizeAndHash(normalizeApplicationPackage(parseAuthoredApplicationPackageJson(input)));',
    'process.stdout.write(`${result.contentHash}:${result.bytes.length}`);',
  ].join('');
  const run = (timezone: string, locale: string): string => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, LANG: locale, LC_ALL: locale, TZ: timezone },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(run('UTC', 'C'), run('Pacific/Auckland', 'C.UTF-8'));
});

test('representative token counts are pinned telemetry, not a correctness gate', () => {
  const authoredText = readFileSync(fixturePath, 'utf8');
  const normalizedText = canonicalize(
    normalizeApplicationPackage(
      parseAuthoredApplicationPackageJson(authoredText),
    ),
  );
  const tokenizer = getEncoding('cl100k_base');
  const telemetry = {
    tokenizer: 'js-tiktoken@1.0.21/cl100k_base',
    authoredTokens: tokenizer.encode(authoredText).length,
    normalizedTokens: tokenizer.encode(normalizedText).length,
  };
  assert.deepEqual(telemetry, {
    tokenizer: 'js-tiktoken@1.0.21/cl100k_base',
    authoredTokens: 3_826,
    normalizedTokens: 2_710,
  });
});
