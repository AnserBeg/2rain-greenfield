import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  CanonicalModelError,
  canonicalize,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';

import {
  checkSurfaceAccessibility,
  checkSurfaceGrammarConformance,
  checkProductSurfaceGrammarRatchet,
  formatProductSurfaceGrammarRatchet,
  formatSurfaceGrammarResult,
  projectCompactSurfaces,
  type ConformanceNavigationEntry,
  type ConformanceNavigationTree,
  type ConformanceSurface,
  type ProductSurfaceGrammarObservation,
} from '../../packages/dev-tooling/src/surface-grammar-conformance/index.js';
import {
  checkSurfaceRuntimeSeam,
  checkUxGrammarPin,
} from '../../packages/dev-tooling/src/surface-runtime-seam.js';
import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompileSuccess,
  type ContentAddressedArtifact,
  type ProjectionManifestEnvelope,
} from '../../packages/compiler/src/index.js';
import {
  catalogModuleDefinition,
  composedApplicationDefinition,
  locationModuleDefinition,
  partyModuleDefinition,
  platformModuleDefinition,
} from '../../packages/domain/src/index.js';
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/index.js';
import { purchasingModuleDefinition } from '../../packages/domain/src/purchasing/index.js';
import { salesModuleDefinition } from '../../packages/domain/src/sales/index.js';
import { PRODUCT_SURFACE_GRAMMAR_BASELINE } from './surface-grammar-conformance.baseline.js';
import {
  compiledSurfaceGrammarSurfaces,
  compileSurfaceGrammarFixture,
} from '../fixtures/g2/surface-grammar/compiled.js';
import {
  SURFACE_GRAMMAR_FIXTURE_IDS,
  authoredSurfaceGrammarFixture,
} from '../fixtures/g2/surface-grammar/definitions.js';
import {
  createArchitectureFixture,
  removeArchitectureFixture,
} from '../helpers/architecture-fixture.js';

const seamPaths = [
  '.agents/skills/ux-grammar/SKILL.md',
  'apps/web/src/app-server.ts',
  'apps/web/src/component-registry.ts',
  'apps/web/src/surface-runtime.ts',
] as const;

const productModuleDefinitions = [
  { create: catalogModuleDefinition, sourceDirectory: 'catalog' },
  { create: inventoryModuleDefinition, sourceDirectory: 'inventory' },
  { create: locationModuleDefinition, sourceDirectory: 'location' },
  { create: partyModuleDefinition, sourceDirectory: 'party' },
  { create: platformModuleDefinition, sourceDirectory: 'platform' },
  { create: purchasingModuleDefinition, sourceDirectory: 'purchasing' },
  { create: salesModuleDefinition, sourceDirectory: 'sales' },
] as const;

test('compiled production modules match the reviewed surface-grammar debt baseline', () => {
  assert.deepEqual(
    discoveredDomainModuleDirectories(),
    PRODUCT_SURFACE_GRAMMAR_BASELINE.map(
      (entry) => entry.sourceDirectory,
    ).toSorted(),
  );

  const result = checkProductSurfaceGrammarRatchet(
    compileProductSurfaceGrammarObservations(),
    PRODUCT_SURFACE_GRAMMAR_BASELINE,
  );

  console.log(formatProductSurfaceGrammarRatchet(result));
  assert.equal(result.modulesRead, 7);
  assert.deepEqual(
    result.observations.map((observation) => ({
      moduleId: observation.moduleId,
      packageId: observation.packageId,
      sourceDirectory: observation.sourceDirectory,
      violationCount: observation.observedViolationCount,
    })),
    PRODUCT_SURFACE_GRAMMAR_BASELINE,
  );
  assert.deepEqual(result.violations, []);
});

test('product ratchet red: substituting the conformant synthetic fixture cannot satisfy product identity', () => {
  const observations = compileProductSurfaceGrammarObservations();
  const authoredFixture = authoredSurfaceGrammarFixture();
  const fixtureIdentity = definitionIdentity(authoredFixture);
  const fixtureObservation: ProductSurfaceGrammarObservation = {
    ...fixtureIdentity,
    result: checkSurfaceGrammarConformance(
      compiledSurfaceGrammarSurfaces(compileSurfaceGrammarFixture()),
    ),
    // Even relabelling the input as Catalog cannot hide the package/module IDs.
    sourceDirectory: 'catalog',
  };
  const substituted = observations.map((observation) =>
    observation.sourceDirectory === 'catalog'
      ? fixtureObservation
      : observation,
  );

  const result = checkProductSurfaceGrammarRatchet(
    substituted,
    PRODUCT_SURFACE_GRAMMAR_BASELINE,
  );
  assert.ok(
    result.violations.some(
      (violation) =>
        violation.ruleId === 'SGR002_PRODUCT_MODULE_SET' &&
        violation.subjectId === fixtureIdentity.packageId,
    ),
  );
});

test('product ratchet red: an increase in a real compiled module count fails', () => {
  const observations = compileProductSurfaceGrammarObservations();
  const catalog = observations[0]!;
  const baselineCount = baselineViolationCount(catalog.packageId);
  observations[0] = {
    ...catalog,
    result: {
      ...catalog.result,
      violations: violationsAtCount(catalog, baselineCount + 1),
    },
  };

  const result = checkProductSurfaceGrammarRatchet(
    observations,
    PRODUCT_SURFACE_GRAMMAR_BASELINE,
  );
  assert.deepEqual(ratchetRuleIds(result), ['SGR003_VIOLATION_INCREASE']);
});

test('product ratchet red: an unrecorded decrease in a real compiled module count fails', () => {
  const observations = compileProductSurfaceGrammarObservations();
  const catalog = observations[0]!;
  const baselineCount = baselineViolationCount(catalog.packageId);
  observations[0] = {
    ...catalog,
    result: {
      ...catalog.result,
      violations: violationsAtCount(catalog, baselineCount - 1),
    },
  };

  const result = checkProductSurfaceGrammarRatchet(
    observations,
    PRODUCT_SURFACE_GRAMMAR_BASELINE,
  );
  assert.deepEqual(ratchetRuleIds(result), ['SGR004_UNRECORDED_DECREASE']);
});

test('product ratchet red: zero compiled modules reports the observed zero', () => {
  const result = checkProductSurfaceGrammarRatchet(
    [],
    PRODUCT_SURFACE_GRAMMAR_BASELINE,
  );
  assert.equal(result.modulesRead, 0);
  assert.ok(ratchetRuleIds(result).includes('SGR001_NO_PRODUCT_MODULES'));
  assert.match(
    formatProductSurfaceGrammarRatchet(result),
    /^product surface grammar ratchet: FAIL \(0 compiled product modules read;/,
  );
});

test('compiler-produced fixtures cover all five archetypes, required slots, focus order, roles, and compact projection', () => {
  const compiled = compileSurfaceGrammarFixture();
  const surfaces = compiledSurfaceGrammarSurfaces(compiled);
  const compact = projectCompactSurfaces(surfaces);
  const result = checkSurfaceGrammarConformance(surfaces, null, compact);

  assert.equal(result.surfacesRead, 5);
  assert.equal(result.compactSurfacesRead, 5);
  assert.deepEqual(result.violations, []);
  assert.equal(
    formatSurfaceGrammarResult('surface grammar', result),
    'surface grammar: PASS (5 active surfaces read; 5 compact surfaces read)',
  );
  assert.deepEqual(compact, projectCompactSurfaces(surfaces));
  assert.ok(
    surfaces.every((surface) =>
      surface.slots.every(
        (slot) =>
          slot.contentReferenceId === SURFACE_GRAMMAR_FIXTURE_IDS.componentId,
      ),
    ),
  );
});

test('compiled navigation stays flat within budget and groups mounted modules beyond it', () => {
  const flatManifest = compiledSurfaceManifest(
    compileDefinition(composedApplicationBelowNavigationBudget()),
  );
  const flatCompact = projectCompactSurfaces(
    flatManifest.surfaces,
    flatManifest.navigation,
  );
  assert.equal(flatManifest.surfaces.length, 12);
  assert.equal(flatManifest.navigation, null);
  assert.equal(
    flatManifest.payloadSchemaVersion,
    COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  );
  // 1 -> 3 BY `profile-v2-adoption`, and this is a real compatibility move
  // rather than a re-derived digest. The floor is
  // `emitsFieldKinds ? 3 : navigation ? 2 : 1` (`projections.ts`), so adopting
  // v2 raises it on EVERY manifest, flat or grouped -- 3 outranks the grouping
  // bump of 2, which is why a flat manifest now reads 3 rather than 1.
  //
  // The field-kind packet allocated 3 deliberately, in preference to arguing
  // that a reader dropping `fields` degrades safely: that argument is a claim
  // about browser submission behaviour and two attempts to gate it failed.
  //
  // WHAT THIS PACKET DID NOT DO, stated because a reader will assume otherwise:
  // nothing enforces this floor. The only comparison of `minimumVersion`
  // anywhere is `compiler.ts`'s dependency validity check (safe integer, >= 1);
  // the provider persists the value and the web reader passes it through, and
  // no consumer refuses a manifest whose floor exceeds what it supports. So the
  // number is currently a declaration, not a gate. Filed, not fixed -- see
  // `current-plan.md`, `runtime-capability-floor-unenforced`.
  assert.equal(flatManifest.requiredRuntimeCapability.minimumVersion, 4);
  assert.equal(flatCompact.navigationEntryIds.length, 4);
  assert.deepEqual(
    navigationRuleIds(
      checkSurfaceGrammarConformance(
        flatManifest.surfaces,
        flatManifest.navigation,
        flatCompact,
      ),
    ),
    [],
  );

  const groupedManifest = compiledSurfaceManifest(
    compileDefinition(composedApplicationWithInventory()),
  );
  const grouped = groupedManifest.navigation;
  assert.ok(grouped);
  const compact = projectCompactSurfaces(groupedManifest.surfaces, grouped);
  // 34 + RECEIPT's seventeen Purchasing surfaces + Sales' nineteen surfaces.
  assert.equal(groupedManifest.surfaces.length, 70);
  assert.equal(
    groupedManifest.payloadSchemaVersion,
    COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  );
  // 2 -> 3 BY `profile-v2-adoption`. The grouped arm read 2 because
  // `navigation` bumped it; field kinds outrank that, so both arms now read 3
  // and the flat/grouped DISTINCTION in this floor is no longer observable.
  //
  // That loss is worth naming rather than absorbing: the pair of assertions used
  // to discriminate 1-vs-2 and now discriminates nothing, so a regression that
  // stopped bumping for `navigation` would keep both green. The grouping
  // behaviour itself is still gated -- by `payloadSchemaVersion` immediately
  // above and by `navigationSurfaceIds` immediately below -- so no property is
  // left unguarded, but this particular assertion is now weaker than it reads.
  assert.equal(groupedManifest.requiredRuntimeCapability.minimumVersion, 5);
  // 13 + Purchasing's six lists + Sales' seven lists.
  assert.equal(navigationSurfaceIds(grouped.entries).length, 26);
  // Sales is the sixth module, so the compiler groups Purchasing and Sales
  // under the fifth compact entry rather than exceeding the navigation budget.
  assert.deepEqual(
    grouped.entries.map((entry) => entry.label),
    ['Party', 'Catalog', 'Location', 'Inventory', 'More'],
  );
  assert.deepEqual(compact.navigationEntryIds, [
    'northstar.app:module.party',
    'northstar.app:module.catalog',
    'northstar.app:module.location',
    'northstar.app:module.inventory',
    'northstar.app:navigation.more',
  ]);
  assert.deepEqual(
    navigationRuleIds(
      checkSurfaceGrammarConformance(
        groupedManifest.surfaces,
        grouped,
        compact,
      ),
    ),
    [],
  );

  const inventory = grouped.entries.find(
    (entry) => entry.navigationId === 'northstar.app:module.inventory',
  );
  assert.ok(inventory);
  assert.deepEqual(navigationSurfaceIds([inventory]), [
    'northstar.app:surface.inventory_movement_list',
    'northstar.app:surface.inventory_on_hand_lookup',
    'northstar.app:surface.inventory_period_lock_list',
    'northstar.app:surface.inventory_transaction_line_list',
    'northstar.app:surface.inventory_transaction_list',
    'northstar.app:surface.legal_entity_list',
    'northstar.app:surface.posted_stock_balance_list',
    'northstar.app:surface.stock_count_line_list',
    'northstar.app:surface.stock_count_list',
  ]);

  const overflowManifest = compiledSurfaceManifest(
    compileDefinition(sixModuleNavigationDefinition()),
  );
  const overflow = overflowManifest.navigation;
  assert.ok(overflow);
  assert.equal(
    overflowManifest.payloadSchemaVersion,
    GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  );
  // 2 -> 3 BY `profile-v2-adoption`, the third and last site. All three arms of
  // this test -- flat, grouped, overflow -- now read 3, for the reason recorded
  // at the flat arm above.
  assert.equal(overflowManifest.requiredRuntimeCapability.minimumVersion, 3);
  assert.equal(navigationSurfaceIds(overflow.entries).length, 6);
  assert.deepEqual(
    overflow.entries.map((entry) => entry.label),
    ['Module 1', 'Module 2', 'Module 3', 'Module 4', 'More'],
  );
  assert.deepEqual(
    navigationRuleIds(
      checkSurfaceGrammarConformance(
        overflowManifest.surfaces,
        overflow,
        projectCompactSurfaces(overflowManifest.surfaces, overflow),
      ),
    ),
    [],
  );
});

test('compiled navigation reachability reds reject missing, duplicate, and compact-omitted entries', () => {
  const manifest = compiledSurfaceManifest(
    compileDefinition(composedApplicationWithInventory()),
  );
  const navigation = manifest.navigation;
  assert.ok(navigation);

  assert.deepEqual(
    navigationRuleIds(checkSurfaceGrammarConformance(manifest.surfaces, null)),
    ['SG007_DESKTOP_NAVIGATION_BUDGET', 'SG008_COMPACT_NAVIGATION_BUDGET'],
  );

  const missingLeaf: ConformanceNavigationTree = {
    ...navigation,
    entries: navigation.entries.map((entry) =>
      entry.navigationId === 'northstar.app:module.inventory'
        ? { ...entry, children: entry.children.slice(1) }
        : entry,
    ),
  };
  assert.deepEqual(
    navigationRuleIds(
      checkSurfaceGrammarConformance(manifest.surfaces, missingLeaf),
    ),
    ['SG012_NAVIGATION_REACHABILITY'],
  );

  const duplicateLeaf: ConformanceNavigationTree = {
    ...navigation,
    entries: navigation.entries.map((entry) =>
      entry.navigationId === 'northstar.app:module.inventory' &&
      entry.children[0]
        ? { ...entry, children: [...entry.children, entry.children[0]] }
        : entry,
    ),
  };
  assert.deepEqual(
    navigationRuleIds(
      checkSurfaceGrammarConformance(manifest.surfaces, duplicateLeaf),
    ),
    ['SG012_NAVIGATION_REACHABILITY'],
  );

  const compact = projectCompactSurfaces(manifest.surfaces, navigation);
  assert.deepEqual(
    navigationRuleIds(
      checkSurfaceGrammarConformance(manifest.surfaces, navigation, {
        ...compact,
        navigationEntryIds: compact.navigationEntryIds.slice(1),
      }),
    ),
    ['SG012_NAVIGATION_REACHABILITY'],
  );
});

test('compiler vocabulary red: unknown archetype is rejected', () => {
  const codes = compilationDiagnosticCodes((surfaces) => {
    surfaces[0]!.archetype = 'dashboard';
  });
  assert.deepEqual(codes, ['CANON_SURFACE_ARCHETYPE_UNSUPPORTED']);
});

test('compiler vocabulary red: unknown slot is rejected', () => {
  const codes = compilationDiagnosticCodes((surfaces) => {
    surfaceFor(surfaces, 'home').slots[0]!.slot = 'hero';
  });
  assert.deepEqual(codes, ['CANON_SURFACE_SLOT_UNSUPPORTED']);
});

test('compiler vocabulary red: duplicate named slot is rejected', () => {
  const codes = compilationDiagnosticCodes((surfaces) => {
    const surface = surfaceFor(surfaces, 'list');
    const duplicate = structuredClone(surface.slots[0]!);
    duplicate.orderKey = 999;
    duplicate.slotId = 'northstar.shell:slot.grammar_duplicate_title';
    surface.slots.push(duplicate);
  });
  assert.deepEqual(codes, ['CANON_SURFACE_SLOT_DUPLICATE']);
});

test('compiler vocabulary red: non-role status token is rejected', () => {
  const codes = compilationDiagnosticCodes((surfaces) => {
    surfaceFor(surfaces, 'task').statusRoles = ['warning'];
  });
  assert.deepEqual(codes, ['CANON_SURFACE_STATUS_ROLE_UNSUPPORTED']);
});

test('required-slot red: a compiler-valid incomplete anatomy fails conformance', () => {
  const surfaces = compiledSurfaceGrammarSurfaces(
    compileSurfaceGrammarFixture({
      omitSlot: { archetype: 'record', slot: 'activity' },
    }),
  );
  assert.deepEqual(ruleIds(checkSurfaceGrammarConformance(surfaces)), [
    'SG003_REQUIRED_SLOT',
    'SG009_COMPACT_SLOT',
  ]);
});

test('focus-order red: equal adjacent order keys fail conformance', () => {
  const surfaces = mutableCompiledSurfaces();
  const list = surfaceFor(surfaces, 'list');
  list.slots[1]!.orderKey = list.slots[0]!.orderKey;
  assert.deepEqual(ruleIds(checkSurfaceGrammarConformance(surfaces)), [
    'SG005_FOCUS_ORDER',
  ]);
});

test('compact navigation budget red: a sixth navigation item fails the five-item budget', () => {
  const surfaces = addClonedSurfaces(mutableCompiledSurfaces(), 4);
  assert.deepEqual(ruleIds(checkSurfaceGrammarConformance(surfaces)), [
    'SG008_COMPACT_NAVIGATION_BUDGET',
  ]);
});

test('desktop navigation budget red: an eighth navigation item fails the seven-item budget', () => {
  const surfaces = addClonedSurfaces(mutableCompiledSurfaces(), 6);
  const projected = projectCompactSurfaces(surfaces);
  const compact = {
    navigationEntryIds: projected.navigationEntryIds.slice(0, 5),
    surfaces: projected.surfaces,
  };
  assert.deepEqual(
    ruleIds(checkSurfaceGrammarConformance(surfaces, null, compact)),
    ['SG007_DESKTOP_NAVIGATION_BUDGET', 'SG012_NAVIGATION_REACHABILITY'],
  );
});

test('compact projection red: omitting a required mobile slot fails the projection gate', () => {
  const surfaces = compiledSurfaceGrammarSurfaces();
  const projected = projectCompactSurfaces(surfaces);
  const compact = {
    navigationEntryIds: [...projected.navigationEntryIds],
    surfaces: projected.surfaces.map((surface) => ({
      slots: [...surface.slots],
      surfaceId: surface.surfaceId,
    })),
  };
  const list = compact.surfaces.find(
    (surface) =>
      surface.surfaceId === SURFACE_GRAMMAR_FIXTURE_IDS.surfaceIds.list,
  );
  assert.ok(list);
  list.slots = list.slots.filter((slot) => slot !== 'bulkActions');
  assert.deepEqual(
    ruleIds(checkSurfaceGrammarConformance(surfaces, null, compact)),
    ['SG009_COMPACT_SLOT'],
  );
});

test('zero-input red reports that zero active and compact surfaces were read', () => {
  const result = checkSurfaceGrammarConformance([]);
  assert.equal(result.surfacesRead, 0);
  assert.equal(result.compactSurfacesRead, 0);
  assert.ok(ruleIds(result).includes('SG001_NO_SURFACES'));
  assert.match(
    formatSurfaceGrammarResult('surface grammar', result),
    /^surface grammar: FAIL \(0 active surfaces read; 0 compact surfaces read;/,
  );
});

test('closed status token contrast pairs and a 44px target pass the automated floor', () => {
  // ADR-0035 §4, both themes. These are the shipped token values, read back out
  // of `apps/web/src/design-tokens.ts` rather than copied, so a token edited
  // below its floor fails here and not only in the browser suite — which is the
  // computed-from-token-values check ADR-0035's Consequences section requires.
  const light = shippedStatusRoleColors('light');
  const dark = shippedStatusRoleColors('dark');
  assert.deepEqual(
    light.map((pair) => pair.subjectId),
    ['success', 'attention', 'blocked', 'inProgress'],
  );
  assert.deepEqual(
    dark.map((pair) => pair.subjectId),
    ['success', 'attention', 'blocked', 'inProgress'],
  );

  const result = checkSurfaceAccessibility(
    [...light, ...dark],
    [{ height: 44, subjectId: 'minimum-target', width: 44 }],
  );
  assert.equal(result.contrastPairsRead, 8);
  assert.equal(result.targetsRead, 1);
  assert.deepEqual(result.violations, []);
});

test('token red: a shipped status token moved below its floor is observed', () => {
  const light = shippedStatusRoleColors('light');
  const success = light.find((pair) => pair.subjectId === 'success');
  assert.ok(success);
  // ADR-0035 §2 measured `#89CFF0` at 1.71:1 on white and forbids it carrying
  // text. Putting the brand on a status ground is that forbidden move.
  const result = checkSurfaceAccessibility(
    light.map((pair) =>
      pair.subjectId === 'success' ? { ...pair, foreground: '#89CFF0' } : pair,
    ),
    [{ height: 44, subjectId: 'minimum-target', width: 44 }],
  );
  assert.equal(result.contrastPairsRead, 4);
  assert.deepEqual(ruleIds(result), ['SG010_CONTRAST']);
});

test('token red: an empty token block reports that zero status pairs were read', () => {
  const result = checkSurfaceAccessibility(
    [],
    [{ height: 44, subjectId: 'minimum-target', width: 44 }],
  );
  assert.equal(result.contrastPairsRead, 0);
  assert.deepEqual(result.violations, []);
  // The count is the guard: zero pairs is a silent pass on the check above, so
  // that test asserts the exact expected count rather than only `violations`.
});

test('contrast red: a failing foreground/background pair is observed', () => {
  const result = checkSurfaceAccessibility(
    [
      {
        background: '#ffffff',
        foreground: '#cccccc',
        subjectId: 'induced-low-contrast',
      },
    ],
    [{ height: 44, subjectId: 'valid-target', width: 44 }],
  );
  assert.deepEqual(ruleIds(result), ['SG010_CONTRAST']);
});

test('target-size red: a 43px target is observed below the 44px floor', () => {
  const result = checkSurfaceAccessibility(
    [
      {
        background: '#ffffff',
        foreground: '#000000',
        subjectId: 'valid-contrast',
      },
    ],
    [{ height: 43, subjectId: 'induced-small-target', width: 44 }],
  );
  assert.deepEqual(ruleIds(result), ['SG011_TARGET_SIZE']);
});

test('SurfaceRuntime-only scan and the G1 skill-document pin remain green', () => {
  assert.deepEqual(checkSurfaceRuntimeSeam(process.cwd()).violations, []);
  assert.deepEqual(checkUxGrammarPin(process.cwd()).violations, []);
});

test('bespoke-screen red: a module-specific React screen outside the compiled path fails SURF001', () => {
  const files = Object.fromEntries(
    seamPaths.map((path) => [path, readFileSync(path, 'utf8')]),
  );
  files['apps/web/src/modules/party-screen.tsx'] =
    'export function PartyScreen() { return <main><h1>Party</h1><form><button>Save</button></form></main>; }';
  const root = createArchitectureFixture(files);

  try {
    const violations = checkSurfaceRuntimeSeam(root).violations;
    assert.ok(
      violations.some(
        (violation) =>
          violation.file === 'apps/web/src/modules/party-screen.tsx' &&
          violation.ruleId === 'SURF001_RUNTIME_BYPASS',
      ),
    );
  } finally {
    removeArchitectureFixture(root);
  }
});

const DESIGN_TOKENS_PATH = 'apps/web/src/design-tokens.ts';
const TOKEN_BLOCK_START = '/* token-definition-block:start */';
const TOKEN_BLOCK_END = '/* token-definition-block:end */';
const DARK_SCHEME_MARKER = '@media (prefers-color-scheme:dark)';
const STATUS_ROLE_TOKENS = [
  { subjectId: 'success', token: 'success' },
  { subjectId: 'attention', token: 'attention' },
  { subjectId: 'blocked', token: 'blocked' },
  { subjectId: 'inProgress', token: 'inprogress' },
] as const;

/**
 * Reads the shipped ADR-0035 status roles back out of the token-definition
 * block, so the contrast check observes the values the browser will receive
 * rather than a number copied into a table. ADR-0035's own Consequences section
 * records why: recomputing the table by hand on 2026-07-31 found `--b700`
 * labelled AAA at a real 6.92:1.
 *
 * The two schemes resolve differently and deliberately. Light roles are
 * `var(--s-*)` references and resolve through the primitive layer; dark roles
 * carry their scheme-specific values directly, because a dark status ground is
 * not any light primitive shifted — it is a separately designed colour, which
 * is what ADR-0035 §10's "designed, never inverted" means. `resolveToken`
 * therefore follows `var()` chains when they exist and returns the literal when
 * they do not; both paths end at the value the browser receives.
 *
 * Read as text, never imported: `apps/web` is a consumer of the packages this
 * suite checks, and an import would invert that edge.
 */
function shippedStatusRoleColors(
  scheme: 'dark' | 'light',
): { background: string; foreground: string; subjectId: string }[] {
  const tokens = readDesignTokens(scheme);
  return STATUS_ROLE_TOKENS.map(({ subjectId, token }) => ({
    background: resolveToken(tokens, `status-${token}-ground`),
    foreground: resolveToken(tokens, `status-${token}-ink`),
    subjectId,
  }));
}

function readDesignTokens(scheme: 'dark' | 'light'): Map<string, string> {
  const source = readFileSync(
    resolve(process.cwd(), DESIGN_TOKENS_PATH),
    'utf8',
  );
  const start = source.indexOf(TOKEN_BLOCK_START);
  const end = source.indexOf(TOKEN_BLOCK_END, start + TOKEN_BLOCK_START.length);
  assert.ok(start >= 0 && end > start, 'token-definition block not found');
  const block = source.slice(start, end);
  const darkAt = block.indexOf(DARK_SCHEME_MARKER);
  assert.ok(darkAt > 0, 'designed dark-mode block not found');

  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gu)) {
    if (scheme === 'light' && match.index > darkAt) continue;
    tokens.set(match[1]!, match[2]!.trim());
  }
  assert.ok(tokens.size > 0, `no ${scheme} tokens read`);
  return tokens;
}

function resolveToken(tokens: Map<string, string>, name: string): string {
  let value = tokens.get(name);
  for (let hops = 0; hops < 8 && value !== undefined; hops += 1) {
    const reference = /^var\(\s*--([a-z0-9-]+)\s*\)$/u.exec(value);
    if (!reference) return value;
    value = tokens.get(reference[1]!);
  }
  throw new Error(`unresolved design token --${name}`);
}

interface MutableAuthoredSurface {
  archetype: string;
  slots: Array<Record<string, unknown>>;
  statusRoles: string[];
  surfaceId: string;
}

interface MutableCompiledSurface {
  archetype: string;
  lifecycle: string;
  slots: Array<{ orderKey: number; slot: string; slotId: string }>;
  statusRoles: string[];
  surfaceId: string;
  surfaceRole?: string | null;
}

function compileProductSurfaceGrammarObservations(): ProductSurfaceGrammarObservation[] {
  return productModuleDefinitions.map(({ create, sourceDirectory }) => {
    const definition = create();
    // Purchasing and Sales declare registered Inventory boundaries and cannot
    // compile as false standalone modules. Compile either in the real composed
    // dependency context, then select exactly its authored surface locals.
    const needsComposedContext = ['purchasing', 'sales'].includes(
      sourceDirectory,
    );
    const normalized = normalizeApplicationPackage(
      needsComposedContext ? composedApplicationDefinition() : definition,
    );
    const compiled = compileApplication({
      dependencies: [],
      expectedActiveRelease: null,
      kind: 'compilerInput',
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes: new TextEncoder().encode(
        canonicalize(normalized),
      ),
      // Version-from-artifact: each product module compiles under the profile
      // for the version it declares. Inventory is at v4 while the others remain
      // v3, so a pinned profile fails one of them whichever version it names.
      profile: {
        ...MODULE_COMPILER_PROFILE,
        languageVersion: normalized.languageVersion,
        normalizationProfileVersion: normalized.normalizationProfileVersion,
      },
    });
    assert.equal(compiled.status, 'compiled');
    const identity = definitionIdentity(definition);
    const manifest = compiledSurfaceManifest(compiled);
    const surfaces = needsComposedContext
      ? moduleSurfaces(definition, manifest.surfaces, sourceDirectory)
      : manifest.surfaces;
    return {
      ...identity,
      result: checkSurfaceGrammarConformance(
        surfaces,
        needsComposedContext ? null : manifest.navigation,
      ),
      sourceDirectory,
    };
  });
}

function moduleSurfaces(
  definition: unknown,
  surfaces: readonly ConformanceSurface[],
  sourceDirectory: string,
): readonly ConformanceSurface[] {
  assert.ok(definition && typeof definition === 'object');
  const authored = (definition as { surfaces?: { surfaceId?: unknown }[] })
    .surfaces;
  assert.ok(Array.isArray(authored));
  const locals = new Set(
    authored.map(({ surfaceId }) => {
      if (typeof surfaceId !== 'string') {
        throw new TypeError(
          `${sourceDirectory} surface identity must be a string`,
        );
      }
      return surfaceId.slice(surfaceId.indexOf(':surface.') + 9);
    }),
  );
  const selected = surfaces.filter((surface) =>
    locals.has(
      surface.surfaceId.slice(surface.surfaceId.indexOf(':surface.') + 9),
    ),
  );
  assert.equal(selected.length, locals.size);
  return selected;
}

interface ConformanceSurfaceManifest {
  readonly navigation: ConformanceNavigationTree | null;
  readonly payloadSchemaVersion: string;
  readonly requiredRuntimeCapability: {
    readonly capabilityId: string;
    readonly minimumVersion: number;
  };
  readonly surfaces: readonly ConformanceSurface[];
}

function compiledSurfaceManifest(
  compiled: CompileSuccess,
): ConformanceSurfaceManifest {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
  );
  assert.ok(reference);
  const manifest = decodeArtifact<ProjectionManifestEnvelope>(
    artifact(compiled, reference.artifactRoot),
  );
  const chunkHash = manifest.chunks[0]?.contentHash;
  assert.ok(chunkHash);
  const payload = decodeArtifact<{
    navigation?: ConformanceNavigationTree;
    schemaVersion: string;
    surfaces: ConformanceSurface[];
  }>(artifact(compiled, chunkHash));
  assert.equal(payload.schemaVersion, reference.payloadSchemaVersion);
  return {
    navigation: payload.navigation ?? null,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    requiredRuntimeCapability: reference.requiredRuntimeCapability,
    surfaces: payload.surfaces,
  };
}

function compileDefinition(
  definition: Record<string, unknown>,
): CompileSuccess {
  const normalized = normalizeApplicationPackage(definition);
  const compiled = compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    profile: {
      ...DEFAULT_COMPILER_PROFILE,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
    },
  });
  if (compiled.status !== 'compiled') {
    throw new Error(JSON.stringify(compiled.diagnostics));
  }
  return compiled;
}

function composedApplicationWithInventory(): Record<string, unknown> {
  const composed = structuredClone(composedApplicationDefinition());
  const inventory = inventoryModuleDefinition('northstar.app');
  for (const collectionName of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'relations',
    'stateMachines',
    'storageMappings',
    'surfaces',
  ] as const) {
    const target = composed[collectionName];
    const source = inventory[collectionName];
    assert.ok(Array.isArray(target));
    assert.ok(Array.isArray(source));
    for (const sourceEntry of source) {
      assert.equal(
        target.filter(
          (candidate) =>
            JSON.stringify(candidate) === JSON.stringify(sourceEntry),
        ).length,
        1,
        `composed application must contain each inventory ${collectionName} entry exactly once`,
      );
    }
  }
  const modules = composed.modules;
  const inventoryModules = inventory.modules;
  assert.ok(Array.isArray(modules));
  assert.ok(Array.isArray(inventoryModules));
  const inventoryModule = inventoryModules[0];
  assert.ok(inventoryModule && typeof inventoryModule === 'object');
  assert.equal(
    modules.filter(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        'moduleId' in candidate &&
        'moduleId' in inventoryModule &&
        candidate.moduleId === inventoryModule.moduleId,
    ).length,
    1,
    'composed application must contain the inventory module exactly once',
  );
  return composed;
}

/**
 * The composed application BELOW the flat navigation budget.
 *
 * `MAX_PRIMARY_NAVIGATION_ENTRIES` is 5 and it counts navigation SURFACES, not
 * modules. Party contributes two lists, so Party + Catalog + Location is four
 * and stays flat. `PUR-1` mounted Purchasing with two more lists, which takes
 * the without-Inventory composition to six and groups it -- so this fixture now
 * strips Purchasing as well, or the flat arm of the test below has no flat
 * manifest to observe. The GROUPED arm is unchanged and still reads the real
 * composed application.
 */
function composedApplicationBelowNavigationBudget(): Record<string, unknown> {
  let composed = composedApplicationWithInventory();
  composed = withoutModule(
    composed,
    inventoryModuleDefinition('northstar.app'),
    'inventory',
  );
  composed = withoutModule(
    composed,
    purchasingModuleDefinition('northstar.app'),
    'purchasing',
  );
  composed = withoutModule(
    composed,
    salesModuleDefinition('northstar.app'),
    'sales',
  );
  return composed;
}

function withoutModule(
  composed: Record<string, unknown>,
  module: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  for (const collectionName of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'relations',
    'stateMachines',
    'storageMappings',
    'surfaces',
  ] as const) {
    const target = composed[collectionName];
    const source = module[collectionName];
    assert.ok(Array.isArray(target));
    assert.ok(Array.isArray(source));
    const idKey = {
      assertions: 'assertionId',
      entities: 'entityId',
      fields: 'fieldId',
      operations: 'operationId',
      permissions: 'permissionId',
      queries: 'queryId',
      relations: 'relationId',
      stateMachines: 'machineId',
      storageMappings: 'storageMappingId',
      surfaces: 'surfaceId',
    }[collectionName];
    const ids = new Set(source.map((entry) => entry[idKey]));
    for (const id of ids)
      assert.equal(
        target.filter((candidate) => candidate[idKey] === id).length,
        1,
        `flat fixture must identify each ${label} ${collectionName} entry exactly once`,
      );
    // Composition may change presentation/query bodies and add module-owned dependencies.
    // Remove by canonical identity and declared module ownership, never byte equality.
    composed[collectionName] = target.filter(
      (candidate) =>
        !ids.has(candidate[idKey]) &&
        candidate.module?.targetId !== `northstar.app:module.${label}`,
    );
  }
  const modules = composed.modules;
  const sourceModules = module.modules;
  assert.ok(Array.isArray(modules));
  assert.ok(Array.isArray(sourceModules));
  const sourceModule = sourceModules[0];
  assert.ok(sourceModule && typeof sourceModule === 'object');
  assert.ok('moduleId' in sourceModule);
  composed.modules = modules.filter(
    (candidate) =>
      candidate === null ||
      typeof candidate !== 'object' ||
      !('moduleId' in candidate) ||
      candidate.moduleId !== sourceModule.moduleId,
  );
  assert.equal(
    modules.length - (composed.modules as unknown[]).length,
    1,
    `flat fixture must remove the ${label} module exactly once`,
  );
  return composed;
}

function sixModuleNavigationDefinition(): Record<string, unknown> {
  const definition = authoredSurfaceGrammarFixture();
  const modules = definition.modules;
  const entities = definition.entities;
  const fields = definition.fields;
  const permissions = definition.permissions;
  const queries = definition.queries;
  const storageMappings = definition.storageMappings;
  const surfaces = definition.surfaces;
  assert.ok(Array.isArray(modules));
  assert.ok(Array.isArray(entities));
  assert.ok(Array.isArray(fields));
  assert.ok(Array.isArray(permissions));
  assert.ok(Array.isArray(queries));
  assert.ok(Array.isArray(storageMappings));
  assert.ok(Array.isArray(surfaces));
  const module = modules[0];
  const entity = entities[0];
  const field = fields[0];
  const permission = permissions[0];
  const query = queries[0];
  const storageMapping = storageMappings[0];
  const list = surfaces.find(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      'archetype' in candidate &&
      candidate.archetype === 'list',
  );
  assert.ok(module && typeof module === 'object');
  assert.ok(entity && typeof entity === 'object');
  assert.ok(field && typeof field === 'object');
  assert.ok(permission && typeof permission === 'object');
  assert.ok(query && typeof query === 'object');
  assert.ok(storageMapping && typeof storageMapping === 'object');
  assert.ok(list && typeof list === 'object');

  const families = Array.from({ length: 6 }, (_, index) => {
    const suffix = String(index + 1);
    const ids = {
      entity: `northstar.shell:entity.navigation_${suffix}`,
      field: `northstar.shell:field.navigation_${suffix}_name`,
      module: `northstar.shell:module.navigation_${suffix}`,
      permission: `northstar.shell:permission.navigation_${suffix}_read`,
      query: `northstar.shell:query.navigation_${suffix}_get`,
      storage: `northstar.shell:storage.navigation_${suffix}`,
      surface: `northstar.shell:surface.navigation_${suffix}`,
    };
    const nextEntity = mutableRecord(structuredClone(entity));
    nextEntity.entityId = ids.entity;
    mutableRecord(nextEntity.module).targetId = ids.module;
    mutableRecord(nextEntity.storage).targetId = ids.storage;

    const nextField = mutableRecord(structuredClone(field));
    nextField.fieldId = ids.field;
    mutableRecord(nextField.entity).targetId = ids.entity;

    const nextPermission = mutableRecord(structuredClone(permission));
    nextPermission.permissionId = ids.permission;
    mutableRecord(nextPermission.resource).targetId = ids.entity;

    const nextQuery = mutableRecord(structuredClone(query));
    nextQuery.queryId = ids.query;
    mutableRecord(nextQuery.module).targetId = ids.module;
    mutableRecord(nextQuery.permission).targetId = ids.permission;
    mutableRecord(nextQuery.sourceEntity).targetId = ids.entity;
    const selections = nextQuery.selections;
    assert.ok(Array.isArray(selections));
    const selection = mutableRecord(selections[0]);
    selection.selectionId = `northstar.shell:selection.navigation_${suffix}_name`;
    mutableRecord(selection.field).targetId = ids.field;

    const nextStorage = mutableRecord(structuredClone(storageMapping));
    nextStorage.storageMappingId = ids.storage;
    mutableRecord(nextStorage.entity).targetId = ids.entity;

    const nextSurface = mutableRecord(structuredClone(list));
    nextSurface.label = `Navigation ${suffix}`;
    nextSurface.surfaceId = ids.surface;
    mutableRecord(nextSurface.module).targetId = ids.module;
    mutableRecord(nextSurface.dataSource).targetId = ids.query;
    const slots = nextSurface.slots;
    assert.ok(Array.isArray(slots));
    for (const slotValue of slots) {
      const slot = mutableRecord(slotValue);
      slot.slotId = `${String(slot.slotId)}_${suffix}`;
    }

    return {
      entity: nextEntity,
      field: nextField,
      module: {
        ...structuredClone(module),
        label: `Module ${suffix}`,
        moduleId: ids.module,
        orderKey: (index + 1) * 10,
      },
      permission: nextPermission,
      query: nextQuery,
      storage: nextStorage,
      surface: nextSurface,
    };
  });
  definition.modules = families.map((family) => family.module);
  definition.entities = families.map((family) => family.entity);
  definition.fields = families.map((family) => family.field);
  definition.permissions = families.map((family) => family.permission);
  definition.queries = families.map((family) => family.query);
  definition.storageMappings = families.map((family) => family.storage);
  definition.surfaces = families.map((family) => family.surface);
  return definition;
}

function mutableRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function navigationSurfaceIds(
  entries: readonly ConformanceNavigationEntry[],
): string[] {
  return entries.flatMap((entry) =>
    entry.kind === 'navigationSurface'
      ? [entry.surfaceId]
      : navigationSurfaceIds(entry.children),
  );
}

function artifact(
  compiled: CompileSuccess,
  contentHash: string,
): ContentAddressedArtifact {
  const value = compiled.bundle.artifacts.find(
    (candidate) => candidate.contentHash === contentHash,
  );
  assert.ok(value);
  return value;
}

function decodeArtifact<T>(artifactValue: ContentAddressedArtifact): T {
  return JSON.parse(
    new TextDecoder().decode(artifactValue.canonicalBytes),
  ) as T;
}

function definitionIdentity(definition: unknown): {
  moduleId: string;
  packageId: string;
} {
  assert.ok(definition && typeof definition === 'object');
  const value = definition as {
    modules?: readonly { moduleId?: unknown }[];
    package?: { packageId?: unknown };
  };
  const packageDefinition = value.package as
    { packageId?: unknown } | undefined;
  const modules = value.modules as
    readonly { moduleId?: unknown }[] | undefined;
  const packageId = packageDefinition?.packageId;
  if (typeof packageId !== 'string') throw new Error('missing packageId');
  assert.equal(modules?.length, 1);
  const moduleId = modules[0]?.moduleId;
  if (typeof moduleId !== 'string') throw new Error('missing moduleId');
  return { moduleId, packageId };
}

function discoveredDomainModuleDirectories(): string[] {
  const root = resolve(process.cwd(), 'packages/domain/src');
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(resolve(root, entry.name, 'definition.ts')),
    )
    .map((entry) => entry.name)
    .toSorted();
}

function ratchetRuleIds(result: {
  readonly violations: readonly { readonly ruleId: string }[];
}): string[] {
  return result.violations.map((violation) => violation.ruleId).sort();
}

function baselineViolationCount(packageId: string): number {
  const baseline = PRODUCT_SURFACE_GRAMMAR_BASELINE.find(
    (entry) => entry.packageId === packageId,
  );
  assert.ok(baseline);
  return baseline.violationCount;
}

function violationsAtCount(
  observation: ProductSurfaceGrammarObservation,
  count: number,
): ConformanceSurfaceGrammarViolations {
  const seed = observation.result.violations[0];
  assert.ok(seed);
  return Array.from({ length: count }, (_, index) =>
    observation.result.violations[index]
      ? observation.result.violations[index]!
      : {
          ...seed,
          message: 'induced additional real-module violation',
          subjectId: `${observation.moduleId}:induced-${String(index)}`,
        },
  );
}

type ConformanceSurfaceGrammarViolations =
  ProductSurfaceGrammarObservation['result']['violations'];

function compilationDiagnosticCodes(
  mutate: (surfaces: MutableAuthoredSurface[]) => void,
): string[] {
  const authored = authoredSurfaceGrammarFixture() as {
    surfaces: MutableAuthoredSurface[];
  };
  mutate(authored.surfaces);
  try {
    const normalizedDefinitionBytes = new TextEncoder().encode(
      canonicalize(normalizeApplicationPackage(authored)),
    );
    const normalizedDefinition = parseNormalizedApplicationPackageJson(
      normalizedDefinitionBytes,
    );
    const result = compileApplication({
      dependencies: [],
      expectedActiveRelease: null,
      kind: 'compilerInput',
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes,
      profile: {
        ...DEFAULT_COMPILER_PROFILE,
        languageVersion: normalizedDefinition.languageVersion,
        normalizationProfileVersion:
          normalizedDefinition.normalizationProfileVersion,
      },
    });
    assert.equal(result.status, 'failed');
    return result.diagnostics.map((diagnostic) => diagnostic.code).sort();
  } catch (error) {
    assert.ok(error instanceof CanonicalModelError);
    return error.diagnostics.map((diagnostic) => diagnostic.code).sort();
  }
}

function mutableCompiledSurfaces(): MutableCompiledSurface[] {
  return structuredClone(
    compiledSurfaceGrammarSurfaces(),
  ) as unknown as MutableCompiledSurface[];
}

function surfaceFor<T extends { archetype: string }>(
  surfaces: T[],
  archetype: string,
): T {
  const surface = surfaces.find(
    (candidate) => candidate.archetype === archetype,
  );
  assert.ok(surface);
  return surface;
}

function addClonedSurfaces(
  surfaces: MutableCompiledSurface[],
  count: number,
): MutableCompiledSurface[] {
  for (let index = 0; index < count; index += 1) {
    const clone = structuredClone(surfaceFor(surfaces, 'list'));
    clone.surfaceId = `${clone.surfaceId}_extra_${index}`;
    surfaces.push(clone);
  }
  return surfaces;
}

function ruleIds(result: {
  readonly violations: readonly { readonly ruleId: string }[];
}): string[] {
  return result.violations.map((violation) => violation.ruleId).sort();
}

function navigationRuleIds(result: {
  readonly violations: readonly { readonly ruleId: string }[];
}): string[] {
  return ruleIds(result).filter(
    (ruleId) =>
      ruleId === 'SG007_DESKTOP_NAVIGATION_BUDGET' ||
      ruleId === 'SG008_COMPACT_NAVIGATION_BUDGET' ||
      ruleId === 'SG012_NAVIGATION_REACHABILITY',
  );
}
