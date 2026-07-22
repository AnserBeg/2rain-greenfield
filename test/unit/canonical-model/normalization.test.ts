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

test('explicit sibling order and equivalent UTC datetime spellings normalize canonically', () => {
  const authored = parseAuthoredApplicationPackageJson(
    readFileSync(fixturePath),
  );
  authored.entities[0]!.orderKey = 20;
  authored.entities[1]!.orderKey = 10;
  const ordered = normalizeApplicationPackage(authored);
  assert.deepEqual(
    ordered.entities.map((entity) => entity.entityId),
    [
      'northstar.inventory:entity.item_alias',
      'northstar.inventory:entity.item',
    ],
  );

  const withDateTime = (
    value: string,
    timezoneSemantics: 'utcInstant' | 'offsetDateTime' = 'utcInstant',
  ) => {
    const candidate = parseAuthoredApplicationPackageJson(
      readFileSync(fixturePath),
    );
    const dateTimeField = candidate.fields.find(
      (field) => field.fieldId === 'northstar.inventory:field.item_counted_at',
    )!;
    assert.equal(dateTimeField.fieldType.kind, 'dateTimeFieldType');
    if (dateTimeField.fieldType.kind === 'dateTimeFieldType') {
      dateTimeField.fieldType.timezoneSemantics = timezoneSemantics;
    }
    candidate.queries[0]!.filter = {
      field: {
        kind: 'fieldReference',
        schemaVersion: 'v0-experimental',
        targetId: 'northstar.inventory:field.item_counted_at' as never,
      },
      kind: 'fieldComparisonPredicate',
      operator: 'equals',
      schemaVersion: 'v0-experimental',
      value: {
        kind: 'dateTimeValue',
        schemaVersion: 'v0-experimental',
        value,
      },
    };
    return normalizeApplicationPackage(candidate);
  };
  const zulu = withDateTime('2026-07-21T12:00:00Z');
  const zeroOffset = withDateTime('2026-07-21T12:00:00+00:00');
  assert.equal(canonicalize(zulu), canonicalize(zeroOffset));
  assert.equal(
    (zulu.queries[0]!.filter as { value: { value: string } }).value.value,
    '2026-07-21T12:00:00.000Z',
  );

  const offsetZulu = withDateTime('2026-07-21T12:00:00Z', 'offsetDateTime');
  const explicitOffset = withDateTime(
    '2026-07-21T12:00:00+00:00',
    'offsetDateTime',
  );
  assert.equal(canonicalize(offsetZulu), canonicalize(explicitOffset));
  assert.equal(
    (offsetZulu.queries[0]!.filter as { value: { value: string } }).value.value,
    '2026-07-21T12:00:00.000+00:00',
  );
});

test('fresh pinned-Node processes ignore timezone and locale inputs', () => {
  const script = [
    "import {readFileSync} from 'node:fs';",
    "import {canonicalizeAndHash,normalizeApplicationPackage,parseAuthoredApplicationPackageJson} from './packages/canonical-model/src/index.ts';",
    "const authored=parseAuthoredApplicationPackageJson(readFileSync('./test/fixtures/canonical-model/representative.authored.json'));",
    "authored.queries[0].filter={field:{kind:'fieldReference',schemaVersion:'v0-experimental',targetId:'northstar.inventory:field.item_counted_at'},kind:'fieldComparisonPredicate',operator:'equals',schemaVersion:'v0-experimental',value:{kind:'dateTimeValue',schemaVersion:'v0-experimental',value:'2026-07-21T23:30:00-07:00'}};",
    'const result=canonicalizeAndHash(normalizeApplicationPackage(authored));',
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
    authoredTokens: 3_785,
    normalizedTokens: 2_721,
  });
});
