import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { canonicalize } from '../../packages/canonical-model/src/index.js';
import {
  COMPILER_DIAGNOSTIC_COPY,
  compileApplication,
} from '../../packages/compiler/src/index.js';
import {
  authoredFixture,
  compilerInput,
  fixtureBytes,
  normalizedBytes,
} from './helpers.js';

test('authored collection permutations converge before compilation', () => {
  const authored = authoredFixture('vertical-v2');
  const expected = compileApplication(compilerInput(normalizedBytes(authored)));
  assert.equal(expected.status, 'compiled');
  if (expected.status !== 'compiled') return;

  for (let seed = 1; seed <= 12; seed += 1) {
    const candidate = structuredClone(authored);
    candidate.modules = permute(candidate.modules, seed);
    candidate.entities = permute(candidate.entities, seed);
    candidate.fields = permute(candidate.fields, seed);
    candidate.surfaces = permute(candidate.surfaces, seed);
    candidate.queries = permute(candidate.queries, seed);
    candidate.operations = permute(candidate.operations, seed);
    candidate.permissions = permute(candidate.permissions, seed);
    candidate.storageMappings = permute(candidate.storageMappings, seed);
    candidate.capabilityRequirements = permute(
      candidate.capabilityRequirements,
      seed,
    );
    candidate.queries = candidate.queries.map((query) => ({
      ...query,
      selections: permute(query.selections, seed + 17),
    }));
    const result = compileApplication(
      compilerInput(normalizedBytes(candidate)),
    );
    assert.equal(result.status, 'compiled');
    if (result.status === 'compiled') {
      assert.equal(result.releaseRoot, expected.releaseRoot);
      assert.deepEqual(
        result.bundle.releaseManifestBytes,
        expected.bundle.releaseManifestBytes,
      );
    }
  }
});

test('fresh pinned-Node processes ignore cwd, locale, timezone, and lifetime', () => {
  assert.equal(process.version, 'v22.22.2');
  const bytes = fixtureBytes('vertical-v1');
  const encoded = Buffer.from(bytes).toString('base64');
  const script = resolve('test/compiler/subprocess-compile.ts');
  const tsx = resolve('node_modules/tsx/dist/loader.mjs');
  const run = (cwd: string, environment: Record<string, string>) =>
    execFileSync(process.execPath, ['--import', tsx, script, encoded], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    });
  const root = resolve('.');
  const packageDirectory = resolve('packages/compiler');
  const first = run(root, { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' });
  const second = run(packageDirectory, {
    LANG: 'fr_CA.UTF-8',
    LC_ALL: 'fr_CA.UTF-8',
    TZ: 'America/Edmonton',
  });
  const third = run(root, { LANG: 'tr_TR.UTF-8', TZ: 'Pacific/Auckland' });
  assert.equal(first, second);
  assert.equal(first, third);
});

test('compiler diagnostic prose is hand-written and outside structural order', () => {
  const source = readFileSync('packages/compiler/src/compiler.ts', 'utf8');
  assert.doesNotMatch(
    source,
    /error\.(?:message|stack)|String\(error\)|zod|invalid_type|unrecognized_keys/i,
  );
  for (const copy of Object.values(COMPILER_DIAGNOSTIC_COPY)) {
    assert.equal(typeof copy.rule, 'string');
    assert.equal(typeof copy.acceptedAlternative, 'string');
    assert.ok(copy.rule.length > 0);
    assert.ok(copy.acceptedAlternative.length > 0);
  }

  const failure = compileApplication(
    compilerInput(new TextEncoder().encode(canonicalize({ invalid: true }))),
  );
  assert.equal(failure.status, 'failed');
  assert.ok(failure.diagnostics.length > 0);
  for (const diagnostic of failure.diagnostics) {
    assert.doesNotMatch(diagnostic.rule, /invalid_type|unrecognized_keys/i);
    assert.doesNotMatch(
      diagnostic.acceptedAlternative,
      /invalid_type|unrecognized_keys/i,
    );
  }
});

function permute<T>(values: T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}
