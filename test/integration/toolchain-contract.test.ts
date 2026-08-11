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
 * The root importer's recorded `prettier` edge, read from `pnpm-lock.yaml`.
 *
 * **This replaced an attempt to enumerate the authorities that can rebind the
 * formatter, which review rounds 2 and 3 defeated four times.** The manifest
 * was one authority; `pnpm-workspace.yaml` overrides were another; and inside
 * overrides alone, `prettier@>3.9.4` (a package-RANGE selector, not a parent
 * selector) and `greenfield-north-star-erp>prettier` (a parent selector whose
 * parent IS the root package) both reach the root edge. A root `.pnpmfile.mjs`
 * `readPackage` hook reaches it without touching either file. Each was measured
 * rewriting the effective edge while the enumerating gate reported no failure.
 *
 * Enumerating inputs was the wrong shape. **Every one of those authorities has
 * to pass through this entry to take effect**, so the contract observes the
 * outcome instead. It is also strictly less code.
 *
 * Parsing the lockfile is not the same risk as parsing `pnpm-workspace.yaml`
 * was. The lockfile is machine-generated in one canonical shape; the workspace
 * file is hand-written and admits arbitrary valid-YAML spellings, which is
 * exactly how a quoted `"overrides":` key slipped past the previous reader as
 * "no overrides at all". This reader still throws rather than returning a
 * benign default for anything it does not recognise.
 */
function lockfileFormatterEdge(lockfile: string): {
  specifier: string;
  version: string;
} {
  const lines = lockfile.split('\n');
  const importers = lines.findIndex((line) => /^importers:\s*$/.test(line));
  if (importers === -1) {
    throw new Error('pnpm-lock.yaml has no importers section');
  }
  const root = lines.findIndex(
    (line, index) => index > importers && /^ {2}\.:\s*$/.test(line),
  );
  if (root === -1) {
    throw new Error('pnpm-lock.yaml has no root importer');
  }
  for (let index = root + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    // A new importer, or a new top-level section, ends the root importer.
    if (/^\S/.test(line) || /^ {2}\S/.test(line)) break;
    if (!/^ {6}(?:'prettier'|"prettier"|prettier):\s*$/.test(line)) continue;
    const specifier = /^ {8}specifier:\s*(\S+)\s*$/.exec(
      lines[index + 1] ?? '',
    );
    const version = /^ {8}version:\s*(\S+)\s*$/.exec(lines[index + 2] ?? '');
    if (!specifier || !version) {
      throw new Error(
        'pnpm-lock.yaml root importer declares prettier in a shape this contract cannot read',
      );
    }
    return { specifier: specifier[1]!, version: version[1]! };
  }
  throw new Error('pnpm-lock.yaml root importer does not declare prettier');
}

/**
 * **The invariant, stated over the effective edge rather than over any one file
 * that influences it.**
 *
 * Three facts, and each is load-bearing:
 *
 * 1. the manifest declares an exact version -- so nothing drifts on a refresh;
 * 2. the lockfile's effective SPECIFIER equals it -- so no override, no parent
 *    selector and no pnpmfile hook has widened or redirected the edge;
 * 3. the resolved VERSION equals it -- so the formatter that actually runs is
 *    the one this contract names, and a patch-bearing or aliased resolution is
 *    not silently substituted.
 *
 * A genuinely non-root override such as `eslint>prettier` leaves the root
 * importer untouched and stays admitted, with no special case for it -- the
 * discrimination the enumerating version had to hand-code, and got wrong.
 *
 * `package.json`'s `pnpm.overrides` is inert under pnpm 11 with a workspace
 * file present, but this contract no longer depends on that being true.
 */
test('the formatter edge the lockfile will install is the exact pin the manifest declares', () => {
  const declared = JSON.parse(readFileSync('package.json', 'utf8'))
    .devDependencies?.prettier;
  assert.ok(
    isExactVersionSpecifier(declared),
    `prettier must be pinned to an exact version, got ${JSON.stringify(declared)}`,
  );

  const edge = lockfileFormatterEdge(readFileSync('pnpm-lock.yaml', 'utf8'));
  assert.equal(
    edge.specifier,
    declared,
    'the lockfile effective specifier must equal the declared pin; an override, a root-parent selector or a pnpmfile hook has rebound it',
  );
  assert.equal(
    edge.version,
    declared,
    'the resolved formatter version must equal the declared pin',
  );
});

/**
 * The reader, executed directly. The live assertion above passes identically
 * against a reader that returned the declared pin unconditionally, so these
 * cases are what stop it being vacuous -- and every rejection case is a shape
 * that previously read as benign.
 */
test('the lockfile reader observes the root edge and refuses what it cannot read', () => {
  const lock = [
    'importers:',
    '',
    '  .:',
    '    devDependencies:',
    '      eslint:',
    '        specifier: ^9.34.0',
    '        version: 9.39.5',
    '      prettier:',
    '        specifier: 3.9.5',
    '        version: 3.9.5',
    '',
    '  apps/web:',
    '    devDependencies:',
    '      prettier:',
    '        specifier: ^1.0.0',
    '        version: 1.0.0',
  ].join('\n');
  assert.deepEqual(lockfileFormatterEdge(lock), {
    specifier: '3.9.5',
    version: '3.9.5',
  });

  assert.throws(
    () => lockfileFormatterEdge('packages:\n  foo: {}\n'),
    /no importers section/,
  );
  assert.throws(
    () =>
      lockfileFormatterEdge(
        'importers:\n\n  apps/web:\n    devDependencies:\n',
      ),
    /no root importer/,
  );
  assert.throws(
    () =>
      lockfileFormatterEdge(
        'importers:\n\n  .:\n    devDependencies:\n      eslint:\n        specifier: ^9\n        version: 9\n',
      ),
    /does not declare prettier/,
    'a root importer without prettier must be fatal, never read as satisfied',
  );
  assert.throws(
    () =>
      lockfileFormatterEdge(
        'importers:\n\n  .:\n    devDependencies:\n      prettier:\n        resolution: something\n',
      ),
    /cannot read/,
    'an unrecognised prettier entry shape must be fatal',
  );
});
