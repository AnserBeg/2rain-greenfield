import assert from 'node:assert/strict';
import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import ts from 'typescript';

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
  ).filter((file) => !file.endsWith('.test.ts'));

  const selections = productionFiles.flatMap((file) =>
    latestVersionSelections(file, readFileSync(file, 'utf8'), constantNames),
  );
  assert.deepEqual(
    selections,
    [],
    `a cut-but-unadopted version must not be selected:\n${selections.join('\n')}`,
  );

  // NEGATIVE CONTROLS FOR THE SCAN ITSELF, committed rather than run once by
  // hand. The scan is the only thing standing between a cut version and every
  // caller's default, and review found it deleting its own subject: the old
  // `^(?:import|export)\s[^;]*;` strip removed EXPORTED INITIALIZED
  // DECLARATIONS, and `DEFAULT_COMPILER_PROFILE` is exactly that, so the
  // production selector was erased before the scan looked at it. Measured on
  // the real declaration: the whole statement reduced to the empty string.
  //
  // Each control below is a way the scan can pass while the fact is false.
  const detected = (source: string) =>
    latestVersionSelections('synthetic.ts', source, constantNames);

  // (a) an exported initializer that SELECTS the newest readable version. This
  //     is the escape the old strip created, and the cheapest broken tree:
  //     point the exported default at LATEST directly, leave the selector
  //     helper untouched, and every live equality still holds because LATEST
  //     and ADOPTED are equal today. The wrong route would surface at the next
  //     cut, years from the edit.
  assert.equal(
    detected(
      'export const DEFAULT_COMPILER_PROFILE: Profile =\n  profiles.find((p) => p.languageVersion === LATEST_LANGUAGE_VERSION)!;\n',
    ).length,
    1,
  );

  // (b) a PURE re-export is not a selection, and must not be reported. Without
  //     this the fix for (a) is satisfiable by deleting the strip entirely,
  //     which turns every re-export into a false red and gets the scan
  //     weakened again by whoever hits it next.
  assert.deepEqual(
    detected(
      "export { LATEST_LANGUAGE_VERSION } from './constants.js';\nimport { LATEST_NORMALIZATION_PROFILE_VERSION } from './constants.js';\n",
    ),
    [],
  );

  // (c) ALIASING the adopted constant to the latest readable one, inside the
  //     file that declares both. `constants.ts` used to be excluded wholesale,
  //     so `ADOPTED = LATEST` was invisible to the scan that exists to forbid
  //     exactly that. It is no longer excluded; only a constant's own
  //     declaration name is exempt.
  assert.equal(
    detected(
      'export const LATEST_LANGUAGE_VERSION = LANGUAGE_VERSIONS.v5;\nexport const ADOPTED_LANGUAGE_VERSION = LATEST_LANGUAGE_VERSION;\n',
    ).length,
    1,
  );

  // (d) reporting is still permitted, which is the one use the discipline
  //     allows before adoption. Without it (a) and (c) are satisfiable by a
  //     scan that flags every mention.
  assert.deepEqual(
    detected(
      'const message = `use a supported version through ${LATEST_LANGUAGE_VERSION}`;\n',
    ),
    [],
  );

  // (e) AN ALIASED IMPORT BINDING -- round two's finding, and the cheapest
  //     mutation of all: it edits one import line, not the initializer. The
  //     guarded name then appears ONLY inside the skipped import declaration
  //     and every selection site spells the local binding. Reproduced against
  //     the real `compiler.ts`: `DEFAULT_COMPILER_PROFILE` selected the newest
  //     readable version and this scan stayed green, along with every
  //     behavioural assertion, because both constants are equal today.
  //
  //     Two reds are expected, and they are different facts: the alias itself,
  //     and the use it enables. A scan that reported only the first would pass
  //     on an alias introduced in one file and used in another.
  const aliasedImport = detected(
    "import { LATEST_LANGUAGE_VERSION as ADOPTED_LANGUAGE_VERSION } from './constants.js';\nexport const DEFAULT_PROFILE = { languageVersion: ADOPTED_LANGUAGE_VERSION };\n",
  );
  assert.equal(aliasedImport.length, 2, aliasedImport.join('\n'));
  assert.match(aliasedImport[0] ?? '', /imported under the alias/u);

  // (f) an UNALIASED import of the same constant is a binding, not a rename, so
  //     the import line itself must not be reported -- only uses are. Without
  //     this, (e) is satisfiable by flagging every import specifier, which would
  //     red every legitimate reader of the constant and get the scan weakened.
  const plainImport = detected(
    "import { LATEST_LANGUAGE_VERSION } from './constants.js';\nconst reported = `through ${LATEST_LANGUAGE_VERSION}`;\n",
  );
  assert.deepEqual(plainImport, []);

  // (g) a RENAMING re-export carries the same indirection one module out:
  //     downstream files import the new name and receive the guarded constant.
  //     A plain re-export renames nothing and is control (b) above.
  const aliasedReExport = detected(
    "export { LATEST_LANGUAGE_VERSION as ADOPTED_LANGUAGE_VERSION } from './constants.js';\n",
  );
  assert.equal(aliasedReExport.length, 1, aliasedReExport.join('\n'));
  assert.match(aliasedReExport[0] ?? '', /re-exported under the alias/u);

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

/**
 * Every place a production file REFERS to a cut-but-unadopted version constant,
 * excluding the three things that are not selections.
 *
 * SYNTAX-AWARE ON PURPOSE. This replaced a regex
 * (`^(?:import|export)\s[^;]*;`) that stripped whole statements before
 * scanning, on the reasoning that an import clause spans lines. It also
 * stripped every EXPORTED INITIALIZED DECLARATION -- and
 * `DEFAULT_COMPILER_PROFILE` is one, so the scan erased the production
 * selector it exists to inspect and then reported it clean. Measured on the
 * real declaration: the statement reduced to the empty string.
 *
 * A narrower regex would have moved the boundary rather than removed it, so
 * the question "is this statement an import or a pure re-export?" is asked of
 * the parser instead. `ImportDeclaration` and `ExportDeclaration` cover
 * `import ...`, `export { X } from '...'` and `export { X }`; a
 * `VariableStatement` carrying an `export` modifier is NOT either of those,
 * which is the whole point.
 */
function latestVersionSelections(
  file: string,
  source: string,
  constantNames: readonly string[],
): string[] {
  const names = new Set(constantNames);
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const selections: string[] = [];

  // PASS 1 -- resolve BINDINGS, not spellings. Review round 2 found the scan
  // following identifier text: `import { LATEST_LANGUAGE_VERSION as
  // ADOPTED_LANGUAGE_VERSION }` puts the guarded name only inside a skipped
  // import declaration, and every selection site then spells the local binding,
  // which is not a guarded name. Reproduced against the real
  // `DEFAULT_COMPILER_PROFILE`: the compiler default selected the newest
  // readable version and this scan stayed GREEN, as did every behavioural
  // assertion, because both constants are equal today. That is the same defect
  // as round one's -- a rename at the boundary makes the subject invisible --
  // and it is cheaper, because it edits one import line rather than the
  // initializer.
  //
  // A guarded constant reached under any local name is still the guarded
  // constant, so the local name joins the scanned set. The rename itself is ALSO
  // reported: aliasing a version constant to the name of a different version
  // constant is the indirection, whether or not the alias is ever used.
  const guarded = (name: string): boolean => names.has(name);
  const bindingNames = new Set(constantNames);
  const report = (node: ts.Node, note?: string): void => {
    const { line } = parsed.getLineAndCharacterOfPosition(node.getStart());
    selections.push(
      `${file}:${String(line + 1)}: ${source.split('\n')[line]?.trim() ?? ''}${
        note === undefined ? '' : ` -- ${note}`
      }`,
    );
  };

  const collectBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          if (!guarded(imported)) continue;
          bindingNames.add(specifier.name.text);
          if (specifier.propertyName !== undefined) {
            report(
              specifier,
              `${imported} imported under the alias ${specifier.name.text}`,
            );
          }
        }
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      const bindings = node.exportClause;
      if (bindings !== undefined && ts.isNamedExports(bindings)) {
        for (const specifier of bindings.elements) {
          const exported = specifier.propertyName?.text ?? specifier.name.text;
          // A RENAMING re-export is the same name-changing indirection one
          // module out: downstream files import the new name and receive the
          // guarded constant. A plain re-export renames nothing and is not a
          // selection.
          if (guarded(exported) && specifier.propertyName !== undefined) {
            report(
              specifier,
              `${exported} re-exported under the alias ${specifier.name.text}`,
            );
          }
        }
      }
      return;
    }
    ts.forEachChild(node, collectBindings);
  };
  ts.forEachChild(parsed, collectBindings);

  // PASS 2 -- uses of every binding that resolves to a guarded constant.
  const visit = (node: ts.Node): void => {
    // Importing or re-exporting a constant is not selecting it; pass 1 has
    // already ruled on the specifiers.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isIdentifier(node) && bindingNames.has(node.text)) {
      const parent = node.parent as ts.Node | undefined;
      // A constant's own declaration is not a selection of itself. This is what
      // lets `constants.ts` be scanned rather than excluded wholesale -- the
      // exclusion is why `ADOPTED_LANGUAGE_VERSION = LATEST_LANGUAGE_VERSION`
      // was invisible to the one control that forbids it.
      const isOwnDeclarationName =
        parent !== undefined &&
        ts.isVariableDeclaration(parent) &&
        parent.name === node;
      // Interpolating it into operator-facing text is REPORTING it, which is
      // the only use the adoption discipline permits before adoption.
      const isReported =
        parent !== undefined &&
        ts.isTemplateSpan(parent) &&
        parent.expression === node;
      if (!isOwnDeclarationName && !isReported) {
        const { line } = parsed.getLineAndCharacterOfPosition(node.getStart());
        selections.push(
          `${file}:${String(line + 1)}: ${
            source.split('\n')[line]?.trim() ?? node.text
          }`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(parsed, visit);
  return selections;
}
