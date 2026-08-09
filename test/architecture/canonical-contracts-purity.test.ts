import assert from 'node:assert/strict';
import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { checkPredicateDispatchTripwire } from '../../packages/dev-tooling/src/predicate-dispatch-tripwire/index.js';
import {
  ADOPTED_LANGUAGE_VERSION,
  ADOPTED_NORMALIZATION_PROFILE_VERSION,
  LATEST_LANGUAGE_VERSION,
  SUPPORTED_LANGUAGE_VERSIONS,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  DEFAULT_COMPILER_PROFILE,
  MODULE_COMPILER_PROFILE,
  SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS,
  selectAdoptedProfileVersion,
} from '../../packages/compiler/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { platformModuleDefinition } from '../../packages/domain/src/platform/definition.js';

const contractsRoot = join(process.cwd(), 'packages/canonical-model/src');

test('canonical contracts validate only and determinism avoids ambient inputs', () => {
  const sources = readdirSync(contractsRoot)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({
      file,
      source: readFileSync(join(contractsRoot, file), 'utf8'),
    }));

  const forbidden = [
    '.default(',
    '.transform(',
    '.coerce',
    'Date.now(',
    'Math.random(',
    '.localeCompare(',
    'fetch(',
    'node:http',
    'node:https',
  ];
  for (const { file, source } of sources) {
    for (const token of forbidden) {
      assert.equal(
        source.includes(token),
        false,
        `${file} contains forbidden determinism/validation token ${token}`,
      );
    }
  }
});

test('git attributes pin LF and protect golden vectors from text conversion', () => {
  const attributes = readFileSync('.gitattributes', 'utf8');
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(attributes, /^\*\.golden\.bytes -text$/m);
  assert.match(attributes, /^\*\.golden\.sha256 -text$/m);
});

test('literal-true predicate dispatch has one canonical owner, with a server-inclusive canary', () => {
  const productionRoots = [
    join(process.cwd(), 'packages/canonical-model/src'),
    join(process.cwd(), 'packages/runtime/src'),
  ];
  const sources = productionRoots.flatMap((root) =>
    readdirSync(root)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => ({
        file: join(root, file),
        source: readFileSync(join(root, file), 'utf8'),
      })),
  );

  assert.deepEqual(findLiteralTrueDispatches(sources), []);
  assert.deepEqual(
    findLiteralTrueDispatches([
      {
        file: 'packages/runtime/src/future-server-evaluator.ts',
        source:
          "return value.kind === 'booleanPredicate' && value.value === true;",
      },
    ]),
    ['packages/runtime/src/future-server-evaluator.ts'],
  );
});

function findLiteralTrueDispatches(
  sources: readonly { file: string; source: string }[],
): string[] {
  return sources
    .filter(
      ({ file, source }) =>
        !file.endsWith('/predicate-kernel.ts') &&
        /\.kind\s*===\s*['"]booleanPredicate['"][\s\S]{0,160}\.value\s*===\s*true/.test(
          source,
        ),
    )
    .map(({ file }) => file)
    .sort();
}

test('predicate dispatch inventory flags a quarry-shaped second evaluator', () => {
  const tripwirePath =
    'packages/dev-tooling/src/predicate-dispatch-tripwire/index.ts';
  const productionSources: Array<{ path: string; source: string }> = globSync([
    'apps/*/src/**/*.ts',
    'packages/*/src/**/*.ts',
  ])
    .filter((path) => path !== tripwirePath)
    .sort()
    .map((path) => ({ path, source: readFileSync(path, 'utf8') }));
  if (process.env.Q1P2_DEMONSTRATE_TRIPWIRE === '1') {
    productionSources.push(quarryMetricFork());
  }
  assert.deepEqual(
    checkPredicateDispatchTripwire(productionSources, {
      requireCompleteInventory: true,
    }),
    [],
  );

  const quarryShapedFork = checkPredicateDispatchTripwire([quarryMetricFork()]);
  assert.deepEqual(
    quarryShapedFork.map(({ code, path }) => ({ code, path })),
    [
      {
        code: 'PREDICATE_DISPATCH_UNREGISTERED',
        path: 'packages/runtime/src/runtime-metric-service.ts',
      },
    ],
  );

  const kernelPath = 'packages/canonical-model/src/predicate-kernel.ts';
  assert.deepEqual(
    checkPredicateDispatchTripwire([
      { path: kernelPath, source: readFileSync(kernelPath, 'utf8') },
    ]),
    [],
  );
  assert.ok(
    checkPredicateDispatchTripwire([], { requireCompleteInventory: true })
      .length > 0,
    'zero production input must not pass the dispatch inventory',
  );
  console.log(
    `Q1-P2 dispatch tripwire synthetic=${quarryShapedFork[0]?.code ?? 'missing'} production=0 legitimate_kernel=0`,
  );
});

function quarryMetricFork(): { path: string; source: string } {
  return {
    path: 'packages/runtime/src/runtime-metric-service.ts',
    source: `
      function metricValue(condition) {
        switch (condition.kind) {
          case 'booleanPredicate': return condition.value;
          case 'fieldComparisonPredicate': return compare(condition);
          case 'notPredicate': return !metricValue(condition.term);
          case 'allPredicate': return condition.terms.every(metricValue);
          case 'anyPredicate': return condition.terms.some(metricValue);
        }
      }
    `,
  };
}

/**
 * A cut version must not become anyone's default before it is adopted.
 *
 * The adoption ratchet pins the CONSTANTS -- `ADOPTED === v4`, `LATEST === v5`
 * -- and that is necessary but not sufficient: it stays green while a compiler
 * default, a normalizer selector, a fixture builder or a projection dispatch
 * alias quietly selects `LATEST` instead. Both halves below close that gap, one
 * structurally and one behaviourally.
 *
 * The rule this enforces is ADR-0047 §2's, restated from
 * `DEFAULT_COMPILER_PROFILE`: "Keyed to the ADOPTED version, not the latest
 * readable one. A newly cut but unadopted version must not silently become
 * every caller's default profile."
 */
test('the newest readable version is reported, never selected', () => {
  const constantNames = [
    'LATEST_LANGUAGE_VERSION',
    'LATEST_NORMALIZATION_PROFILE_VERSION',
  ];
  const productionFiles = globSync(
    ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    { cwd: process.cwd() },
  ).filter(
    (file) =>
      !file.endsWith('.test.ts') &&
      !file.endsWith('packages/canonical-model/src/constants.ts'),
  );

  const selections: string[] = [];
  for (const file of productionFiles) {
    // Re-exporting a constant is not selecting it, and an `import`/`export`
    // clause spans lines, so the whole statement is removed rather than
    // matched line by line -- which is what a first attempt at this got wrong.
    const source = readFileSync(file, 'utf8').replaceAll(
      /^(?:import|export)\s[^;]*;/gmu,
      '',
    );
    source.split('\n').forEach((line, index) => {
      for (const name of constantNames) {
        if (!line.includes(name)) continue;
        // Interpolating it into operator-facing text is REPORTING it, which is
        // the only use the adoption discipline permits before adoption.
        if (line.includes(`\${${name}}`)) continue;
        selections.push(`${file}:${String(index + 1)}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    selections,
    [],
    `a cut-but-unadopted version must not be selected:\n${selections.join('\n')}`,
  );

  // The behavioural half: every default follows ADOPTED.
  assert.equal(
    DEFAULT_COMPILER_PROFILE.languageVersion,
    ADOPTED_LANGUAGE_VERSION,
  );
  assert.equal(
    MODULE_COMPILER_PROFILE.languageVersion,
    ADOPTED_LANGUAGE_VERSION,
  );
  assert.equal(
    DEFAULT_COMPILER_PROFILE.normalizationProfileVersion,
    ADOPTED_NORMALIZATION_PROFILE_VERSION,
  );

  // THE DISCRIMINATING HALF, and it must not be an assertion about today's
  // constants -- replaced by `LANG-ADOPT-v5`.
  //
  // This read `assert.notEqual(LATEST_LANGUAGE_VERSION, ADOPTED_LANGUAGE_VERSION)`,
  // which is a PREMISE: it says a gap exists for the scan above to protect. The
  // premise is false between an adoption and the next cut, and that is a normal
  // state, not a defect -- `LANG-ADOPT-v5` closed the gap and this line went red
  // while nothing it guards had moved. Worse than the red: once the two
  // constants are equal, the assertions above and the scan above them all pass
  // under the wrong rule, because "take the adopted version" and "take the
  // latest readable version" are indistinguishable when adoption IS the newest
  // cut. Deleting the premise would leave a control that cannot fail for the
  // reason it exists.
  //
  // `compiler.ts` already isolated the selection rule for exactly this reason,
  // in its own words: "asserting it against live constants alone proves
  // nothing." So the rule is exercised on a CONSTRUCTED readable set whose
  // adopted member is deliberately NOT its last, where the two rules disagree
  // and the wrong one is observable -- and it stays observable no matter what
  // today's constants happen to be.
  const readable = ['a', 'b', 'c'] as const;
  assert.equal(selectAdoptedProfileVersion(readable, 'b'), 'b');
  assert.notEqual(selectAdoptedProfileVersion(readable, 'b'), readable.at(-1));
  // Fails closed rather than substituting a default: an adopted version outside
  // the readable set is a programming error, and silently falling back to the
  // newest readable one is the defect this whole test exists to catch.
  assert.throws(
    () => selectAdoptedProfileVersion(readable, 'd' as 'a'),
    /adopted version d is not a member of the readable set/u,
  );
  // And both live axes go THROUGH that rule rather than inlining it. Asserted
  // as agreement with the profile, which holds in both the gap and the no-gap
  // state.
  assert.equal(
    selectAdoptedProfileVersion(
      SUPPORTED_LANGUAGE_VERSIONS,
      ADOPTED_LANGUAGE_VERSION,
    ),
    DEFAULT_COMPILER_PROFILE.languageVersion,
  );
  assert.equal(
    selectAdoptedProfileVersion(
      SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS,
      ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    ),
    DEFAULT_COMPILER_PROFILE.compilerSemanticProfileVersion,
  );
  // LATEST is still readable, and still not required to be adopted. Stated as
  // ordering and position rather than equality or inequality, because both of
  // those describe a moment in the cut/adopt cycle rather than the invariant.
  assert.ok(
    SUPPORTED_LANGUAGE_VERSIONS.indexOf(LATEST_LANGUAGE_VERSION) >=
      SUPPORTED_LANGUAGE_VERSIONS.indexOf(ADOPTED_LANGUAGE_VERSION),
    'the adopted version can never be newer than the newest readable one',
  );
  assert.equal(
    SUPPORTED_LANGUAGE_VERSIONS.at(-1),
    LATEST_LANGUAGE_VERSION,
    'LATEST must be the last member of the supported list, or "newest readable" names nothing',
  );

  assert.equal(
    normalizeApplicationPackage(composedApplicationDefinition())
      .languageVersion,
    ADOPTED_LANGUAGE_VERSION,
  );
  // Platform is a first-party module OUTSIDE the composed package, so the
  // assertion above cannot see it, and nothing else asserted its version at
  // all. Node-version purity is what forces every module to move together; a
  // guard covering four of the five modules does not observe that rule.
  assert.equal(
    normalizeApplicationPackage(platformModuleDefinition()).languageVersion,
    ADOPTED_LANGUAGE_VERSION,
  );
});
