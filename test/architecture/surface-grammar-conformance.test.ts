import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  CanonicalModelError,
  canonicalize,
  normalizeApplicationPackage,
} from '@north-star/canonical-model';

import {
  checkSurfaceAccessibility,
  checkSurfaceGrammarConformance,
  checkProductSurfaceGrammarRatchet,
  formatProductSurfaceGrammarRatchet,
  formatSurfaceGrammarResult,
  projectCompactSurfaces,
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
  { create: locationModuleDefinition, sourceDirectory: 'location' },
  { create: partyModuleDefinition, sourceDirectory: 'party' },
  { create: platformModuleDefinition, sourceDirectory: 'platform' },
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
  assert.equal(result.modulesRead, 4);
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
  const result = checkSurfaceGrammarConformance(surfaces, compact);

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

test('entity-scoped navigation observes the composed application and rejects an over-budget application', () => {
  const normalized = normalizeApplicationPackage(
    composedApplicationDefinition(),
  );
  const compiled = compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    profile: { ...MODULE_COMPILER_PROFILE },
  });
  assert.equal(compiled.status, 'compiled');
  const surfaces = compiledSurfaceManifest(compiled);
  const compact = projectCompactSurfaces(surfaces);
  const expectedListSurfaceIds = surfaces
    .filter(
      (surface) =>
        surface.lifecycle === 'active' && surface.surfaceRole === 'list',
    )
    .map((surface) => surface.surfaceId);

  assert.equal(surfaces.length, 12);
  assert.deepEqual(compact.navigationSurfaceIds, expectedListSurfaceIds);
  assert.equal(compact.navigationSurfaceIds.length, 4);
  assert.deepEqual(
    navigationRuleIds(checkSurfaceGrammarConformance(surfaces, compact)),
    [],
  );

  const exemplar = surfaces.find((surface) => surface.surfaceRole === 'list');
  assert.ok(exemplar);
  const overBudget = [
    ...surfaces,
    ...Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(exemplar),
      surfaceId: `${exemplar.surfaceId}_over_budget_${String(index + 1)}`,
    })),
  ];
  const overBudgetRuleIds = navigationRuleIds(
    checkSurfaceGrammarConformance(overBudget),
  );
  console.log(
    `G2-P5d-nav composed navigation: ${String(compact.navigationSurfaceIds.length)}/7; synthetic navigation: 8/7 -> ${overBudgetRuleIds.join(',')}`,
  );
  assert.deepEqual(overBudgetRuleIds, [
    'SG007_DESKTOP_NAVIGATION_BUDGET',
    'SG008_COMPACT_NAVIGATION_BUDGET',
  ]);
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
    navigationSurfaceIds: projected.navigationSurfaceIds.slice(0, 5),
    surfaces: projected.surfaces,
  };
  assert.deepEqual(ruleIds(checkSurfaceGrammarConformance(surfaces, compact)), [
    'SG007_DESKTOP_NAVIGATION_BUDGET',
  ]);
});

test('compact projection red: omitting a required mobile slot fails the projection gate', () => {
  const surfaces = compiledSurfaceGrammarSurfaces();
  const projected = projectCompactSurfaces(surfaces);
  const compact = {
    navigationSurfaceIds: [...projected.navigationSurfaceIds],
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
  assert.deepEqual(ruleIds(checkSurfaceGrammarConformance(surfaces, compact)), [
    'SG009_COMPACT_SLOT',
  ]);
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
  const result = checkSurfaceAccessibility(
    [
      { background: '#e8f6ed', foreground: '#246240', subjectId: 'success' },
      {
        background: '#fff7e8',
        foreground: '#8a5918',
        subjectId: 'attention',
      },
      { background: '#fff0ee', foreground: '#8f3028', subjectId: 'blocked' },
      {
        background: '#edf7fc',
        foreground: '#2d607d',
        subjectId: 'inProgress',
      },
    ],
    [{ height: 44, subjectId: 'minimum-target', width: 44 }],
  );
  assert.equal(result.contrastPairsRead, 4);
  assert.equal(result.targetsRead, 1);
  assert.deepEqual(result.violations, []);
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
    const normalized = normalizeApplicationPackage(definition);
    const compiled = compileApplication({
      dependencies: [],
      expectedActiveRelease: null,
      kind: 'compilerInput',
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes: new TextEncoder().encode(
        canonicalize(normalized),
      ),
      profile: { ...MODULE_COMPILER_PROFILE },
    });
    assert.equal(compiled.status, 'compiled');
    const identity = definitionIdentity(normalized);
    const surfaces = compiledSurfaceManifest(compiled);
    return {
      ...identity,
      result: checkSurfaceGrammarConformance(surfaces),
      sourceDirectory,
    };
  });
}

function compiledSurfaceManifest(
  compiled: CompileSuccess,
): readonly ConformanceSurface[] {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
  );
  assert.ok(reference);
  const manifest = decodeArtifact<ProjectionManifestEnvelope>(
    artifact(compiled, reference.artifactRoot),
  );
  const chunkHash = manifest.chunks[0]?.contentHash;
  assert.ok(chunkHash);
  const payload = decodeArtifact<{ surfaces: ConformanceSurface[] }>(
    artifact(compiled, chunkHash),
  );
  return payload.surfaces;
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
    const result = compileApplication({
      dependencies: [],
      expectedActiveRelease: null,
      kind: 'compilerInput',
      limits: { ...DEFAULT_COMPILER_LIMITS },
      normalizedDefinitionBytes,
      profile: { ...DEFAULT_COMPILER_PROFILE },
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
      ruleId === 'SG008_COMPACT_NAVIGATION_BUDGET',
  );
}
