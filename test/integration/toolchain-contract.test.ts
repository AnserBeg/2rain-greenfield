import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the scaffold declares one pinned package manager', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

  assert.equal(packageJson.packageManager, 'pnpm@11.9.0');
  assert.equal(packageJson.engines.node, '22.22.2');
});

/**
 * An exact `major.minor.patch`, optionally with a prerelease or build tag.
 * Everything a range operator can express is rejected, including the bare
 * partial versions (`3`, `3.9`) that npm treats as ranges.
 */
function isExactVersionSpecifier(specifier: unknown): boolean {
  return (
    typeof specifier === 'string' &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(specifier)
  );
}

/**
 * The formatter is the one dev dependency whose version is an invariant of
 * every source byte in the repository, so a range in its specifier silently
 * rewrites the whole tree the first time a lockfile refresh resolves higher.
 * That is not hypothetical: `^3.6.2` resolving to 3.9.5 left fourteen files
 * failing `pnpm format`, and because `format` and `lint` are the first steps
 * of the main matrix block, the matrix aborted before a single suite ran.
 *
 * **Why this gate reads the manifest rather than the lockfile.** The cheapest
 * way to lose the pin is to revert the two specifier strings and leave the
 * resolved version alone. That tree is internally consistent, so
 * `pnpm install --frozen-lockfile` accepts it, installs the same formatter,
 * and `pnpm format` stays green — measured, not assumed. Every downstream step
 * then sees an identical executable tree and the drift returns silently at the
 * next refresh. The manifest specifier is the only place that damage is
 * visible, so this is where it is observed.
 *
 * Manifest-versus-lockfile agreement is not restated here: the matrix's own
 * `pnpm install --frozen-lockfile` already refuses a lockfile whose recorded
 * specifier disagrees with the manifest.
 *
 * Exactness is required generically rather than by hardcoding a version, so a
 * deliberate reviewed upgrade to another exact version stays a one-line change
 * and does not have to edit its own gate.
 */
test('the formatter is pinned to an exact version, not a range', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const specifier = packageJson.devDependencies?.prettier;

  assert.ok(
    specifier !== undefined,
    'root package.json must declare a prettier devDependency',
  );
  assert.ok(
    isExactVersionSpecifier(specifier),
    `prettier must be pinned to an exact version, got ${JSON.stringify(specifier)}`,
  );
});

/**
 * The negative control, and it is the reason this file can be trusted.
 *
 * A gate never observed failing is not evidence, and the assertion above
 * passes against the current manifest whether or not the predicate means
 * anything — a predicate that returned `true` unconditionally would look
 * identical from outside. These cases execute the discriminator directly, so
 * the rejecting behaviour is observed rather than inferred from a green run.
 *
 * `^3.6.2` is listed first because it is the exact specifier this repository
 * actually regressed under.
 */
test('range and non-version specifiers are rejected', () => {
  const rejected = [
    '^3.6.2',
    '^3.9.5',
    '~3.9.5',
    '>=3.6.2',
    '>=3.6.2 <4',
    '3.6.2 - 3.9.5',
    '3',
    '3.9',
    '3.9.x',
    '*',
    '',
    'latest',
    'next',
    '=3.9.5',
    'v3.9.5',
    ' 3.9.5',
    '3.9.5 ',
    'npm:prettier@3.9.5',
    'workspace:*',
    'github:prettier/prettier#3.9.5',
    undefined,
    null,
    395,
  ];

  for (const specifier of rejected) {
    assert.equal(
      isExactVersionSpecifier(specifier),
      false,
      `${JSON.stringify(specifier)} must not count as an exact pin`,
    );
  }
});

/** The other direction: exactness must not be so strict it forbids upgrading. */
test('exact versions, including prerelease and build tags, are accepted', () => {
  for (const specifier of [
    '3.9.5',
    '3.9.6',
    '4.0.0',
    '10.20.30',
    '3.9.5-rc.1',
    '3.9.5+build.1',
  ]) {
    assert.equal(
      isExactVersionSpecifier(specifier),
      true,
      `${specifier} must count as an exact pin`,
    );
  }
});
