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

/**
 * The override keys declared in `pnpm-workspace.yaml`, read strictly.
 *
 * **Throws rather than skipping anything it cannot read.** A parser that
 * silently ignores an unfamiliar line is a gate that passes vacuously on
 * precisely the input that would hide a rebind, so every shape inside the
 * block is either understood or fatal. `overrides` written inline (`{...}`)
 * is fatal for the same reason.
 */
function pnpmWorkspaceOverrideKeys(source: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^overrides:/.test(line));
  if (start === -1) return [];
  if (!/^overrides:\s*(#.*)?$/.test(lines[start]!)) {
    throw new Error(
      'pnpm-workspace.yaml declares overrides in a form this contract cannot read',
    );
  }
  const keys: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    // A column-0 line ends the block.
    if (!/^\s/.test(line)) break;
    const entry =
      /^\s+(?:'([^']+)'|"([^"]+)"|([^'"#\s][^:]*?))\s*:\s*\S.*$/.exec(line);
    if (!entry) {
      throw new Error(
        `unreadable entry in pnpm-workspace.yaml overrides: ${JSON.stringify(line)}`,
      );
    }
    keys.push((entry[1] ?? entry[2] ?? entry[3]!).trim());
  }
  return keys;
}

/**
 * Whether an override key can rebind the ROOT `prettier` dependency -- the one
 * whose binary `pnpm format` actually runs.
 *
 * `prettier`, `prettier@^3` and `prettier@3.9.6` all can. A `parent>prettier`
 * key scopes to some other package's dependency and cannot reach the root
 * binary, so it is deliberately left alone rather than banned on sight.
 */
function claimsRootFormatter(overrideKey: string): boolean {
  if (overrideKey.includes('>')) return false;
  return overrideKey.split('@')[0] === 'prettier';
}

/**
 * **The manifest is not the only resolution authority, and review round 2
 * caught this gate assuming it was.**
 *
 * `pnpm-workspace.yaml`'s `overrides` block is repository-controlled and pnpm
 * applies it to direct dependencies, replacing the declared specifier. Adding
 * `overrides.prettier: ^3.9.5` while leaving `"prettier": "3.9.5"` untouched
 * was measured to rewrite the lockfile's recorded specifier to `^3.9.5` --
 * with the manifest assertion above still green, the rejection table still
 * green, and `pnpm install --frozen-lockfile` still exit 0. The formatter edge
 * becomes range-governed again and the gate never notices.
 *
 * So the contract observes the effective selector, not just the manifest one.
 *
 * Any override claiming the root formatter is rejected whatever its value,
 * including an exact one: an exact override that disagrees with the manifest
 * would make the version that runs differ from the version this file reports
 * as authoritative, which is the same class of lie in the other direction.
 *
 * `package.json`'s `pnpm.overrides` was tested and is INERT under pnpm 11 with
 * a workspace file present -- the specifier stayed `3.9.5` -- so it is not
 * guarded here. If that ever changes, this is the contract that must grow.
 */
test('no workspace override can rebind the formatter', () => {
  const keys = pnpmWorkspaceOverrideKeys(
    readFileSync('pnpm-workspace.yaml', 'utf8'),
  );
  const claiming = keys.filter(claimsRootFormatter);

  assert.deepEqual(
    claiming,
    [],
    `pnpm-workspace.yaml overrides must not rebind the formatter; found ${JSON.stringify(claiming)}`,
  );
});

/** The discriminator, executed directly rather than inferred from a green run. */
test('override keys that can claim the root formatter are recognised', () => {
  for (const key of ['prettier', 'prettier@^3.9.5', 'prettier@3.9.6']) {
    assert.equal(claimsRootFormatter(key), true, `${key} claims the root`);
  }
  for (const key of ['brace-expansion', 'js-yaml', 'eslint>prettier']) {
    assert.equal(
      claimsRootFormatter(key),
      false,
      `${key} does not claim the root`,
    );
  }
});

/** The reader finds a planted override, and fails closed on shapes it cannot read. */
test('the overrides reader observes entries and refuses what it cannot parse', () => {
  const planted = [
    'packages:',
    '  - apps/*',
    '',
    'overrides:',
    '  prettier: ^3.9.5',
    "  js-yaml: '>=4.3.1 <5'",
    '',
    'allowBuilds:',
    '  esbuild: true',
  ].join('\n');
  assert.deepEqual(pnpmWorkspaceOverrideKeys(planted), ['prettier', 'js-yaml']);
  assert.equal(pnpmWorkspaceOverrideKeys('packages:\n  - apps/*\n').length, 0);

  assert.throws(
    () => pnpmWorkspaceOverrideKeys('overrides: { prettier: ^3.9.5 }\n'),
    /cannot read/,
    'an inline overrides mapping must be fatal, never silently skipped',
  );
  assert.throws(
    () => pnpmWorkspaceOverrideKeys('overrides:\n  - prettier\n'),
    /unreadable entry/,
    'a sequence entry must be fatal, never silently skipped',
  );
});
