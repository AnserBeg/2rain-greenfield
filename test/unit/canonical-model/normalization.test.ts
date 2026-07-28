import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getEncoding } from 'js-tiktoken';

import {
  CanonicalModelError,
  LANGUAGE_VERSION,
  LANGUAGE_VERSIONS,
  LATEST_LANGUAGE_VERSION,
  LATEST_NORMALIZATION_PROFILE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  NORMALIZATION_PROFILE_VERSIONS,
  SUPPORTED_LANGUAGE_VERSIONS,
  SUPPORTED_NORMALIZATION_PROFILE_VERSIONS,
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

test('v0, v1, and v2 readers retain their exact normalized bytes', () => {
  const authored = parseAuthoredApplicationPackageJson(
    readFileSync(fixturePath),
  );
  const expected = new Map([
    [
      'v0-experimental',
      {
        digest:
          '00444e2e40aedea745ea23cc89ac5f2f01f9234dcae2473481b39134f3f036ba',
        profile: 'northstar.normalization/v0-experimental',
      },
    ],
    [
      'v1',
      {
        digest:
          '7126210813d43a1b8097f8500c8d3ece3ef5966dfdbe27bbfe988f035bcd0231',
        profile: 'northstar.normalization/v1',
      },
    ],
    [
      'v2',
      {
        digest:
          '538ed9deca0fed3f2c2340ce05ce65213fbacb02f153544b1d58cc9844d5048a',
        profile: 'northstar.normalization/v2',
      },
    ],
  ]);

  for (const [languageVersion, receipt] of expected) {
    const candidate = replaceVersion(
      authored,
      'v0-experimental',
      languageVersion,
    ) as typeof authored;
    candidate.normalizationProfileVersion = receipt.profile as never;
    assert.equal(
      canonicalizeAndHash(normalizeApplicationPackage(candidate)).contentHash,
      receipt.digest,
      languageVersion,
    );
  }
});

test('v3 selects its profile, rejects mixed nodes, and leaves adopted v2 explicit', () => {
  assert.equal(LANGUAGE_VERSION, LANGUAGE_VERSIONS.v2);
  assert.equal(
    NORMALIZATION_PROFILE_VERSION,
    NORMALIZATION_PROFILE_VERSIONS.v2,
  );
  assert.equal(LATEST_LANGUAGE_VERSION, LANGUAGE_VERSIONS.v3);
  assert.equal(
    LATEST_NORMALIZATION_PROFILE_VERSION,
    NORMALIZATION_PROFILE_VERSIONS.v3,
  );
  assert.deepEqual(SUPPORTED_LANGUAGE_VERSIONS, [
    LANGUAGE_VERSIONS.experimentalV0,
    LANGUAGE_VERSIONS.v1,
    LANGUAGE_VERSIONS.v2,
    LANGUAGE_VERSIONS.v3,
  ]);
  assert.deepEqual(SUPPORTED_NORMALIZATION_PROFILE_VERSIONS, [
    NORMALIZATION_PROFILE_VERSIONS.experimentalV0,
    NORMALIZATION_PROFILE_VERSIONS.v1,
    NORMALIZATION_PROFILE_VERSIONS.v2,
    NORMALIZATION_PROFILE_VERSIONS.v3,
  ]);

  const authored = parseAuthoredApplicationPackageJson(
    readFileSync(fixturePath),
  );
  const v3 = replaceVersion(
    authored,
    'v0-experimental',
    'v3',
  ) as typeof authored;
  v3.normalizationProfileVersion = NORMALIZATION_PROFILE_VERSIONS.v3;
  const normalized = normalizeApplicationPackage(v3);
  assert.equal(normalized.languageVersion, LANGUAGE_VERSIONS.v3);
  assert.equal(
    normalized.normalizationProfileVersion,
    NORMALIZATION_PROFILE_VERSIONS.v3,
  );
  assert.equal(
    canonicalize(
      normalizeApplicationPackage(canonicalAuthoredProjection(normalized)),
    ),
    canonicalize(normalized),
  );

  const mixed = structuredClone(v3);
  mixed.fields[0]!.schemaVersion = LANGUAGE_VERSION;
  assert.throws(
    () => normalizeApplicationPackage(mixed),
    (error: unknown) =>
      error instanceof CanonicalModelError &&
      error.diagnostics.some(
        (diagnostic) => diagnostic.code === 'CANON_VERSION_MIXED',
      ),
  );

  // Structural proxy for the append-only design: a future entry extends the
  // catalog without changing any stable existing binding.
  const hypotheticalV4 = { ...LANGUAGE_VERSIONS, v4: 'v4' as const };
  const hypotheticalProfileV4 = {
    ...NORMALIZATION_PROFILE_VERSIONS,
    v4: 'northstar.normalization/v4' as const,
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(hypotheticalV4).filter(([name]) => name !== 'v4'),
    ),
    LANGUAGE_VERSIONS,
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(hypotheticalProfileV4).filter(([name]) => name !== 'v4'),
    ),
    NORMALIZATION_PROFILE_VERSIONS,
  );
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

function replaceVersion(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) {
    return value.map((entry) => replaceVersion(entry, from, to));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceVersion(entry, from, to),
      ]),
    );
  }
  return value;
}
