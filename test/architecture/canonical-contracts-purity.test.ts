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
 * NO PRODUCTION FILE REFERENCES A `LATEST_*` CONSTANT EXCEPT TO REPORT IT.
 *
 * READ THE TITLE LITERALLY. This control was called "the newest readable
 * version is reported, never selected" for four review rounds, and that name
 * was a claim it could not support. It is a SOURCE-REFERENCE scan: it resolves
 * bindings for two named constants and classifies their uses. It says nothing
 * about newest-readable values reached by any other derivation.
 *
 * NARROWED IN ROUND 4, after a fifth escape and on the repository's own
 * convergence rule. The prior four repairs were each a real fix to a real hole
 * -- a strip that deleted the subject, a rename that changed its name, a glob
 * that never reached it, an exemption that swallowed it -- and each was
 * followed by a cheaper escape than the one before. The fifth needed no
 * obfuscation at all:
 *
 *     profile.languageVersion === SUPPORTED_LANGUAGE_VERSIONS.at(-1)!
 *
 * selects the newest readable version using an identifier production already
 * imports. Measured on the real `DEFAULT_COMPILER_PROFILE`: the profile still
 * resolved to v5, every behavioural assertion held, and this scan stayed green.
 * A sixth token rule would have bought a sixth escape.
 *
 * WHAT THIS CONTROL PROVES: direct and named-alias references to
 * `LATEST_LANGUAGE_VERSION` and `LATEST_NORMALIZATION_PROFILE_VERSION` do not
 * appear in production except interpolated into operator-facing text.
 *
 * WHAT IT DOES NOT PROVE, recorded rather than implied: that the newest
 * readable version is never SELECTED. Any derivation that reaches it without
 * naming it -- the ordered supported list's last member being the obvious one
 * -- is outside this scan by construction. Closing that needs a production
 * SELECTOR SEAM, exercised on a constructed readable set whose adopted member
 * is deliberately not its last, with `DEFAULT_COMPILER_PROFILE` proven to be
 * produced through it. That is `adoption-selector-seam`, and it is a design
 * change rather than another rule here.
 *
 * The behavioural assertions below are unchanged and still carry ADR-0047 §2's
 * rule: every default follows ADOPTED, and the selection rule itself is
 * exercised on a constructed set where the two candidate rules disagree.
 */
test('no production file references a LATEST_ constant except to report it', () => {
  const constantNames = [
    'LATEST_LANGUAGE_VERSION',
    'LATEST_NORMALIZATION_PROFILE_VERSION',
  ];
  // `apps/*/scripts/**` is in the set because the RELEASE COMPILERS live there
  // and construct compiler profiles -- review round 3 found them unscanned.
  // They are not incidental tooling: `compile-app-release.ts` is the
  // implementation that makes "the constant is not the artifact event" true,
  // and `compile-demo-release.ts` is why the shell root holds. A LATEST_*
  // selection introduced in either is invisible to every other gate this
  // packet identified.
  const productionFiles = globSync(
    ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'apps/*/scripts/**/*.ts'],
    { cwd: process.cwd() },
  ).filter((file) => !file.endsWith('.test.ts'));

  // THE SCAN MUST REACH ITS SUBJECT -- the third erasure mode found on this
  // control, after a strip that removed the subject and a rename that changed
  // its name.
  //
  // Nothing tied the glob to anything. Repoint it at a path that matches no
  // files and `selections` is `[]`, the assertion below passes, and every
  // synthetic control stays green because those call `latestVersionSelections`
  // directly. Measured: `packages/*/lib/**/*.ts` matches 0 files and this gate
  // reports the tree clean.
  //
  // A non-empty check does NOT close it: a glob pointed at the wrong tree is
  // non-empty. What closes it is naming the file the gate exists to guard --
  // `DEFAULT_COMPILER_PROFILE` lives here, and it is the selection site every
  // round of this review has attacked.
  // Each subject is pinned by name. A glob is a discovery mechanism, and this
  // control has now been caught missing its subject twice -- once by matching
  // nothing, once by matching the wrong tree -- so the required members are
  // asserted rather than assumed.
  for (const required of [
    'packages/compiler/src/compiler.ts',
    'apps/web/scripts/compile-app-release.ts',
    'apps/web/scripts/compile-demo-release.ts',
  ]) {
    assert.ok(
      productionFiles.includes(required),
      `the scan must reach ${required}; a glob that misses a selection site reports every tree clean`,
    );
  }

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

  // (h) A TEMPLATE-DERIVED SELECTION -- round three's finding, and the
  //     value-preserving one: it copies the newest readable version into the
  //     adopted constant through an interpolation, so both are equal today and
  //     nothing behavioural moves. At the next cut the adopted value follows
  //     latest silently.
  const templateSelection = detected(
    "export const ADOPTED_LANGUAGE_VERSION =\n  `${LATEST_LANGUAGE_VERSION}` as (typeof LANGUAGE_VERSIONS)['v5'];\n",
  );
  assert.equal(templateSelection.length, 1, templateSelection.join('\n'));

  // (i) the same shape one layer in: a template feeding a PROFILE field. This
  //     one carries literal text, so rule (i) alone would exempt it; it is the
  //     version-binding rule that catches it.
  const templateProfileField = detected(
    'export const PROFILE = { languageVersion: `${LATEST_LANGUAGE_VERSION}` };\n',
  );
  assert.equal(templateProfileField.length, 1, templateProfileField.join('\n'));

  // (j) and the legitimate sink still passes -- BOTH real reporting sites in
  //     this tree, one a call argument and one a message-record property.
  //     Without this, (h) and (i) are satisfiable by forbidding every
  //     interpolation, which would red `normalize.ts` and get the exemption
  //     widened back by whoever hits it next.
  assert.deepEqual(
    detected(
      'const d = diagnostic(code, path, `value must satisfy a closed supported schema through ${LATEST_LANGUAGE_VERSION}`);\n',
    ),
    [],
  );
  assert.deepEqual(
    detected(
      'const alternatives = {\n  CANON_VERSION_UNSUPPORTED: `use a supported version through ${LATEST_LANGUAGE_VERSION}`,\n};\n',
    ),
    [],
  );

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
      // Interpolating it into operator-facing TEXT is REPORTING it, which is
      // the only use the adoption discipline permits before adoption.
      //
      // NOT every interpolation -- corrected in review round 3. The exemption
      // was `parent is a TemplateSpan`, which is a syntactic position, not a
      // sink. Measured: `ADOPTED_LANGUAGE_VERSION = \`${LATEST_LANGUAGE_VERSION}\`
      // as (typeof LANGUAGE_VERSIONS)['v5']` preserves the runtime value
      // (both are v5 today), type-checks, leaves compiled output unchanged,
      // and PASSED this scan. At the next cut the adopted value would follow
      // latest silently, which is the one coupling this gate exists to refuse.
      //
      // Two independent rules, because one is not enough.
      //
      // (i) A REPORTING template carries literal text around the value. A
      //     value-preserving coercion cannot: any added text changes the
      //     string, so `\`${X}\`` with an empty head and tail is the only
      //     shape that copies a version, and it is never a message. Both real
      //     reporting sites in this tree carry text
      //     (`normalize.ts:600`, `:2493`).
      const enclosingTemplate =
        parent !== undefined &&
        ts.isTemplateSpan(parent) &&
        parent.expression === node
          ? (parent.parent as ts.TemplateExpression | undefined)
          : undefined;
      const carriesLiteralText =
        enclosingTemplate !== undefined &&
        (enclosingTemplate.head.text.length > 0 ||
          enclosingTemplate.templateSpans.some(
            (span) => span.literal.text.length > 0,
          ));
      // (ii) Even WITH text, a template whose value becomes a version binding
      //      is a selection. `\`v${n}\`` assigned to a profile field or an
      //      adopted constant selects; it does not report.
      const versionBindingNames = new Set([
        'languageVersion',
        'normalizationProfileVersion',
        'compilerSemanticProfileVersion',
        'schemaVersion',
        'ADOPTED_LANGUAGE_VERSION',
        'ADOPTED_NORMALIZATION_PROFILE_VERSION',
      ]);
      const becomesVersionBinding = (from: ts.Node | undefined): boolean => {
        let current: ts.Node | undefined = from;
        while (current !== undefined) {
          if (
            (ts.isVariableDeclaration(current) ||
              ts.isPropertyAssignment(current) ||
              ts.isPropertySignature(current)) &&
            ts.isIdentifier(current.name)
          ) {
            return versionBindingNames.has(current.name.text);
          }
          if (ts.isCallExpression(current) || ts.isReturnStatement(current)) {
            return false;
          }
          current = current.parent as ts.Node | undefined;
        }
        return false;
      };
      const isReported =
        carriesLiteralText && !becomesVersionBinding(enclosingTemplate);
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
