import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import {
  SURFACE_ARCHETYPES,
  SURFACE_SLOTS,
  canonicalize,
  normalizeApplicationPackage,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompileSuccess,
  type ProjectionFamilyId,
  type ProjectionManifestEnvelope,
} from '@north-star/compiler';

import {
  SURFACE_GRAMMAR_FIXTURE_IDS,
  authoredSurfaceGrammarFixture,
  type FixtureCompiledSurface,
  type SurfaceGrammarFixtureOptions,
} from '../../../../test/fixtures/g2/surface-grammar/definitions.js';
import { createSurfaceRuntimeServer } from '../../src/app-server.js';
import { demoEntry } from '../helpers.js';

type SurfaceArchetype = (typeof SURFACE_ARCHETYPES)[number];

let baseUrl: string;
let incompleteBaseUrl: string;
let server: Server;
let incompleteServer: Server;
let fixtureDirectory: string;
let surfaces: readonly FixtureCompiledSurface[];

test.beforeAll(async () => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'north-star-surface-grammar-'));
  const fixturePath = join(fixtureDirectory, 'compiled.json');
  const incompleteFixturePath = join(
    fixtureDirectory,
    'compiled-incomplete.json',
  );
  writeFileSync(
    fixturePath,
    `${JSON.stringify(surfaceGrammarRuntimeFixture(), null, 2)}\n`,
  );
  writeFileSync(
    incompleteFixturePath,
    `${JSON.stringify(
      surfaceGrammarRuntimeFixture({
        omitSlot: { archetype: 'list', slot: 'bulkActions' },
      }),
      null,
      2,
    )}\n`,
  );
  surfaces = compiledSurfaceGrammarSurfaces();
  server = createSurfaceRuntimeServer(demoEntry(fixturePath));
  incompleteServer = createSurfaceRuntimeServer(
    demoEntry(incompleteFixturePath),
  );
  [baseUrl, incompleteBaseUrl] = await Promise.all([
    listen(server),
    listen(incompleteServer),
  ]);
});

test.afterAll(async () => {
  await Promise.all([close(server), close(incompleteServer)]);
  rmSync(fixtureDirectory, { force: true, recursive: true });
});

for (const archetype of SURFACE_ARCHETYPES) {
  test(`compact ${archetype} journey renders the compiled definition through SurfaceRuntime`, async ({
    page,
  }) => {
    const surface = fixtureSurface(archetype);
    await page.setViewportSize({ height: 844, width: 390 });
    const response = await page.goto(
      `${baseUrl}/?surface=${encodeURIComponent(surface.surfaceId)}`,
    );
    expect(response?.status()).toBe(200);

    await requireCompactJourney(page, surface);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      surface.label,
    );
    await expect(page.locator('.app-shell')).toHaveAttribute(
      'data-release-content-hash',
      /^[0-9a-f]{64}$/,
    );
  });
}

test('compact journey red: a compiler-produced list missing bulkActions is observed as incomplete', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(
    `${incompleteBaseUrl}/?surface=${encodeURIComponent(
      SURFACE_GRAMMAR_FIXTURE_IDS.surfaceIds.list,
    )}`,
  );
  const incomplete = compiledSurfaceGrammarSurfaces(undefined).find(
    (surface) => surface.archetype === 'list',
  );
  assert.ok(incomplete);
  await assert.rejects(
    requireCompactJourney(page, incomplete),
    /COMPACT_REQUIRED_SLOT:list:expected=4:observed=3/,
  );
});

async function requireCompactJourney(
  page: Page,
  surface: FixtureCompiledSurface,
): Promise<void> {
  assert.ok(isArchetype(surface.archetype));
  const expectedSlots = SURFACE_SLOTS[surface.archetype];
  const grid = page.locator(
    `.surface-grid[data-surface-archetype="${surface.archetype}"]`,
  );
  await expect(grid).toHaveCount(1);
  const renderedSlotCount = await grid
    .locator(`[data-component="${SURFACE_GRAMMAR_FIXTURE_IDS.componentId}"]`)
    .count();
  if (renderedSlotCount !== expectedSlots.length) {
    throw new Error(
      `COMPACT_REQUIRED_SLOT:${surface.archetype}:expected=${expectedSlots.length}:observed=${renderedSlotCount}`,
    );
  }
  await expect(grid.getByRole('alert')).toHaveCount(0);

  const navigation = page.getByRole('navigation', {
    name: 'Release navigation',
  });
  await expect(navigation).toHaveCount(1);
  const links = navigation.getByRole('link');
  const expectedNavigation = surfaces
    .filter(
      (candidate) =>
        candidate.archetype === 'home' || candidate.archetype === 'list',
    )
    .map((candidate) =>
      candidate.archetype === 'list'
        ? candidate.label.replace(/\s+list$/i, '')
        : candidate.label,
    );
  await expect(links).toHaveCount(expectedNavigation.length);
  await expect(navigation.locator('a > span:nth-child(2)')).toHaveText(
    expectedNavigation,
  );
  await expect(page.locator('.app-shell')).toHaveCSS('display', 'block');
  await expect(page.locator('.sidebar')).toHaveCSS('position', 'fixed');
  await expect(page.locator('.sidebar')).toHaveCSS('bottom', '0px');
  await expect(navigation.locator('ul')).toHaveCSS('display', 'grid');

  const roles = await page
    .locator('[data-status-role]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-status-role')),
    );
  assert.deepEqual(roles, [...surface.statusRoles]);

  const computedPairs = await page
    .locator('[data-status-role]')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          background: style.backgroundColor,
          foreground: style.color,
          subjectId: element.getAttribute('data-status-role') ?? 'missing-role',
        };
      }),
    );
  const contrastPairs = computedPairs.map((pair) => ({
    ...pair,
    background: rgbToHex(pair.background),
    foreground: rgbToHex(pair.foreground),
  }));
  const targets = await links.evaluateAll((elements) =>
    elements.map((element, index) => {
      const rectangle = element.getBoundingClientRect();
      return {
        height: rectangle.height,
        subjectId: `compact-navigation-${index}`,
        width: rectangle.width,
      };
    }),
  );
  const accessibility = observeAccessibility(contrastPairs, targets);
  assert.ok(accessibility.contrastPairsRead > 0);
  assert.equal(accessibility.targetsRead, expectedNavigation.length);
  assert.deepEqual(accessibility.violations, []);

  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(links.first()).toBeFocused();
  const documentWidths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.equal(documentWidths.scroll, documentWidths.client);
}

function fixtureSurface(archetype: SurfaceArchetype): FixtureCompiledSurface {
  const surface = surfaces.find(
    (candidate) => candidate.archetype === archetype,
  );
  if (!surface) throw new Error(`missing ${archetype} fixture surface`);
  return surface;
}

function isArchetype(value: string): value is SurfaceArchetype {
  return SURFACE_ARCHETYPES.some((candidate) => candidate === value);
}

async function listen(target: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', resolve);
  });
  const address = target.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('surface grammar server did not bind a TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(target: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.close((error) => (error ? reject(error) : resolve()));
  });
}

function rgbToHex(value: string): string {
  const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3);
  if (!channels || channels.length !== 3) {
    throw new Error(`unsupported computed color ${value}`);
  }
  return `#${channels
    .map((channel) => Math.round(Number(channel)).toString(16).padStart(2, '0'))
    .join('')}`;
}

function observeAccessibility(
  contrastPairs: readonly {
    readonly background: string;
    readonly foreground: string;
    readonly subjectId: string;
  }[],
  targets: readonly {
    readonly height: number;
    readonly subjectId: string;
    readonly width: number;
  }[],
) {
  const violations: string[] = [];
  for (const pair of contrastPairs) {
    if (contrastRatio(pair.foreground, pair.background) < 4.5) {
      violations.push(`CONTRAST:${pair.subjectId}`);
    }
  }
  for (const target of targets) {
    if (target.width < 44 || target.height < 44) {
      violations.push(`TARGET_SIZE:${target.subjectId}`);
    }
  }
  return {
    contrastPairsRead: contrastPairs.length,
    targetsRead: targets.length,
    violations,
  };
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) =>
    Number.parseInt(color.slice(offset, offset + 2), 16),
  );
  const linear = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function compileBrowserFixture(
  options: SurfaceGrammarFixtureOptions = {},
): CompileSuccess {
  const normalizedDefinitionBytes = new TextEncoder().encode(
    canonicalize(
      normalizeApplicationPackage(authoredSurfaceGrammarFixture(options)),
    ),
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
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function compiledSurfaceGrammarSurfaces(
  compiled = compileBrowserFixture(),
): readonly FixtureCompiledSurface[] {
  return runtimeProjection(compiled, PROJECTION_FAMILY_IDS.surfaceManifest)
    .payload.surfaces as unknown as readonly FixtureCompiledSurface[];
}

function surfaceGrammarRuntimeFixture(
  options: SurfaceGrammarFixtureOptions = {},
): Readonly<Record<string, unknown>> {
  const compiled = compileBrowserFixture(options);
  return Object.freeze({
    compilerVersion: compiled.bundle.releaseManifest.compilerVersion,
    normalizedDefinitionDigest:
      compiled.bundle.releaseManifest.normalizedDefinitionDigest,
    outputProtocolVersion: compiled.bundle.outputProtocolVersion,
    projections: Object.freeze({
      agent: runtimeProjection(compiled, PROJECTION_FAMILY_IDS.agentDiscovery),
      catalog: runtimeProjection(compiled, PROJECTION_FAMILY_IDS.semanticModel),
      operation: runtimeProjection(
        compiled,
        PROJECTION_FAMILY_IDS.operationCatalog,
      ),
      query: runtimeProjection(compiled, PROJECTION_FAMILY_IDS.queryCatalog),
      surface: runtimeProjection(
        compiled,
        PROJECTION_FAMILY_IDS.surfaceManifest,
      ),
    }),
    releaseRoot: compiled.releaseRoot,
    schemaVersion: 'northstar.web:compiled-shell-fixture/v1',
  });
}

function runtimeProjection(
  compiled: CompileSuccess,
  familyId: ProjectionFamilyId,
): Readonly<Record<string, unknown>> & {
  readonly payload: Readonly<Record<string, unknown>>;
} {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (!reference) throw new Error(`missing projection ${familyId}`);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  if (!manifestArtifact) throw new Error(`missing manifest ${familyId}`);
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as ProjectionManifestEnvelope;
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  if (!chunk) throw new Error(`missing payload chunk ${familyId}`);
  const payload = JSON.parse(
    new TextDecoder().decode(chunk.canonicalBytes),
  ) as Readonly<Record<string, unknown>>;
  return Object.freeze({
    artifactRoot: reference.artifactRoot,
    familyId: reference.familyId,
    instanceId: reference.instanceId,
    payload,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  });
}
