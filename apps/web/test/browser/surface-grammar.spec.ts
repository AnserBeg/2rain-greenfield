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
  FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION,
  GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION,
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
let navigationBudgetBaseUrl: string;
let invalidNavigationBaseUrl: string;
let server: Server;
let incompleteServer: Server;
let navigationBudgetServer: Server;
let invalidNavigationServer: Server;
let fixtureDirectory: string;
let surfaces: readonly FixtureCompiledSurface[];

test.beforeAll(async () => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'north-star-surface-grammar-'));
  const fixturePath = join(fixtureDirectory, 'compiled.json');
  const incompleteFixturePath = join(
    fixtureDirectory,
    'compiled-incomplete.json',
  );
  const navigationBudgetFixturePath = join(
    fixtureDirectory,
    'compiled-navigation-budget.json',
  );
  const invalidNavigationFixturePath = join(
    fixtureDirectory,
    'compiled-navigation-invalid.json',
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
  writeFileSync(
    navigationBudgetFixturePath,
    `${JSON.stringify(groupedNavigationRuntimeFixture(), null, 2)}\n`,
  );
  writeFileSync(
    invalidNavigationFixturePath,
    `${JSON.stringify(v0GroupedNavigationRuntimeFixture(), null, 2)}\n`,
  );
  surfaces = compiledSurfaceGrammarSurfaces();
  server = createSurfaceRuntimeServer(demoEntry(fixturePath));
  incompleteServer = createSurfaceRuntimeServer(
    demoEntry(incompleteFixturePath),
  );
  navigationBudgetServer = createSurfaceRuntimeServer(
    demoEntry(navigationBudgetFixturePath),
  );
  invalidNavigationServer = createSurfaceRuntimeServer(
    demoEntry(invalidNavigationFixturePath),
  );
  [
    baseUrl,
    incompleteBaseUrl,
    navigationBudgetBaseUrl,
    invalidNavigationBaseUrl,
  ] = await Promise.all([
    listen(server),
    listen(incompleteServer),
    listen(navigationBudgetServer),
    listen(invalidNavigationServer),
  ]);
});

test.afterAll(async () => {
  await Promise.all([
    close(server),
    close(incompleteServer),
    close(navigationBudgetServer),
    close(invalidNavigationServer),
  ]);
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

test('compiled groups keep six list surfaces reachable through five primary entries', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(navigationBudgetBaseUrl);
  const navigation = page.getByRole('navigation', {
    name: 'Release navigation',
  });
  const primaryEntries = navigation.locator('.navigation-tree > li');
  await expect(primaryEntries).toHaveCount(5);
  await expect(primaryEntries.getByRole('link')).toHaveCount(4);
  const more = primaryEntries.getByRole('group').filter({ hasText: 'More' });
  await expect(more).toHaveCount(1);

  const primaryTargets = await primaryEntries
    .locator(':scope > a, :scope > details > summary')
    .evaluateAll((elements) =>
      elements.map((element, index) => {
        const rectangle = element.getBoundingClientRect();
        return {
          height: rectangle.height,
          subjectId: `grouped-compact-navigation-${index}`,
          width: rectangle.width,
        };
      }),
    );
  assert.equal(primaryTargets.length, 5);
  assert.deepEqual(observeAccessibility([], primaryTargets).violations, []);
  await expect(page.locator('.sidebar')).toHaveCSS('position', 'fixed');
  await expect(page.locator('.sidebar')).toHaveCSS('bottom', '0px');
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(more.locator('summary')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(more.locator('a > span:nth-child(2)')).toHaveText([
    'Module 5',
    'Module 6',
  ]);
  await assertNoHorizontalDocumentScroll(page);

  const expectedSurfaceLabels = Array.from(
    { length: 6 },
    (_, index) => `Budget item ${index + 1} list`,
  );
  for (let index = 0; index < expectedSurfaceLabels.length; index += 1) {
    if (index >= 4) {
      await more.getByText('More', { exact: true }).click();
    }
    const link =
      index < 4
        ? primaryEntries.nth(index).getByRole('link')
        : more.getByRole('link', { name: `Module ${index + 1}` });
    await link.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      expectedSurfaceLabels[index]!,
    );
  }

  await page.setViewportSize({ height: 720, width: 1280 });
  await expect(primaryEntries).toHaveCount(5);
  await more.getByText('More', { exact: true }).click();
  await expect(navigation.getByRole('link')).toHaveCount(6);
});

test('version boundary red: a v0 reader refuses grouped navigation instead of degrading', async ({
  page,
}) => {
  const response = await page.goto(invalidNavigationBaseUrl);
  expect(response?.status()).toBe(422);
  await expect(page.getByRole('alert')).toHaveAttribute(
    'data-diagnostic-code',
    'INVALID_SURFACE_NAVIGATION',
  );
});

/**
 * ADR-0035 observations. Every one of these reads the *rendered* page in a live
 * browser rather than the stylesheet source, because the fact each asserts is
 * "what the user's machine resolved", not "what someone typed". Each carries a
 * read-count guard: a run against a page with no status chips and no skeleton
 * would otherwise pass while proving nothing.
 */
test('rendered status roles hold the contrast floor and stay off the brand hue', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );

  const pairs = await readStatusColorPairs(page);
  assert.deepEqual(
    pairs.map((pair) => pair.subjectId).toSorted(),
    // Deliberately compared against the compiled definition, not a literal, so
    // the subject cannot silently shrink to one easy chip.
    [...builder.statusRoles].toSorted(),
  );
  const accessibility = observeAccessibility(pairs, []);
  assert.ok(accessibility.contrastPairsRead > 0);
  assert.equal(accessibility.contrastPairsRead, builder.statusRoles.length);
  assert.deepEqual(accessibility.violations, []);

  const separability = observeBrandStatusSeparability(pairs);
  assert.ok(separability.hueSamplesRead > 0);
  assert.ok(separability.chromaticHueSamplesRead > 0);
  assert.equal(separability.hueSamplesRead, pairs.length * 2);
  console.log(
    `rendered status palette: ${String(accessibility.contrastPairsRead)} contrast pairs, ${String(separability.hueSamplesRead)} hue samples (${String(separability.chromaticHueSamplesRead)} chromatic)`,
  );
  assert.deepEqual(separability.violations, []);
});

test('contrast red: a rendered status pair forced below 4.5:1 is observed', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );
  await page.addStyleTag({
    content:
      '[data-status-role=blocked]{color:#c9c2c1!important;background:#ffffff!important}',
  });

  const observed = observeAccessibility(await readStatusColorPairs(page), []);
  assert.ok(observed.contrastPairsRead > 0);
  assert.deepEqual(observed.violations, ['CONTRAST:blocked']);
});

test('separability red: a status role moved into the brand hue is observed', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );
  // b700 on b100 clears 4.5:1 comfortably, so the only thing this can trip is
  // the separability rule — the contrast gate stays green underneath it.
  await page.addStyleTag({
    content:
      '[data-status-role=inProgress]{color:var(--b700)!important;background:var(--b100)!important}',
  });

  const pairs = await readStatusColorPairs(page);
  assert.deepEqual(observeAccessibility(pairs, []).violations, []);
  const separability = observeBrandStatusSeparability(pairs);
  assert.ok(separability.hueSamplesRead > 0);
  assert.deepEqual(separability.violations, [
    'BRAND_HUE:inProgress:background',
    'BRAND_HUE:inProgress:foreground',
  ]);
});

test('reduced motion is honoured: the shimmer animates by contract and is absent under reduce', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );

  // The positive direction first. Without it "absent under reduce" is satisfied
  // by never shipping a shimmer at all, which is the vacuity vector here.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const animating = await readSkeletonMotion(page);
  assert.ok(animating.length > 0);
  assert.deepEqual(animating, [
    {
      animationDuration: '2s',
      animationName: 'skeleton-sweep',
      display: 'block',
      subjectId: 'skeleton-probe',
      timingFunction: 'linear',
    },
  ]);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await readSkeletonMotion(page);
  const observed = observeReducedMotion(reduced);
  assert.ok(observed.skeletonsRead > 0);
  console.log(
    `shimmer under reduced motion: ${String(observed.skeletonsRead)} skeletons read, animation ${reduced[0]?.animationName ?? 'unread'}, display ${reduced[0]?.display ?? 'unread'}`,
  );
  assert.deepEqual(observed.violations, []);
});

test('reduced-motion red: a shimmer that survives the reduce query is observed', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({
    content:
      '.skeleton::after{display:block!important;animation:skeleton-sweep 2000ms linear infinite!important}',
  });

  const observed = observeReducedMotion(await readSkeletonMotion(page));
  assert.ok(observed.skeletonsRead > 0);
  assert.deepEqual(observed.violations, [
    'REDUCED_MOTION_SHIMMER:skeleton-probe',
  ]);
});

test('dark mode holds the contrast floor rather than merely having a media query', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );

  const pairs = await readStatusColorPairs(page);
  const light = await lightSchemeStatusColorPairs(page, builder.surfaceId);
  // Proves the emulation actually reached the page: a stylesheet with a dark
  // block nobody applies would otherwise return the light values and pass.
  assert.notDeepEqual(pairs, light);

  const accessibility = observeAccessibility(pairs, []);
  assert.ok(accessibility.contrastPairsRead > 0);
  assert.equal(accessibility.contrastPairsRead, builder.statusRoles.length);
  const separability = observeBrandStatusSeparability(pairs);
  assert.ok(separability.chromaticHueSamplesRead > 0);
  console.log(
    `dark scheme status palette: ${String(accessibility.contrastPairsRead)} contrast pairs, ${String(separability.hueSamplesRead)} hue samples (${String(separability.chromaticHueSamplesRead)} chromatic)`,
  );
  assert.deepEqual(accessibility.violations, []);
  assert.deepEqual(separability.violations, []);
});

test('dark mode red: the light-ground accent on a dark ground is observed below the floor', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );
  // ADR-0035 §10: naive inversion puts --b600 on a dark ground. This is that
  // inversion, executed, and the gate has to see it.
  await page.addStyleTag({
    content: '[data-status-role]{color:var(--b600)!important}',
  });

  const observed = observeAccessibility(await readStatusColorPairs(page), []);
  assert.equal(observed.contrastPairsRead, builder.statusRoles.length);
  assert.deepEqual(
    observed.violations.toSorted(),
    [...builder.statusRoles].toSorted().map((role) => `CONTRAST:${role}`),
  );
});

async function readStatusColorPairs(page: Page): Promise<
  readonly {
    readonly background: string;
    readonly foreground: string;
    readonly subjectId: string;
  }[]
> {
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
  return computedPairs.map((pair) => ({
    ...pair,
    background: rgbToHex(pair.background),
    foreground: rgbToHex(pair.foreground),
  }));
}

async function lightSchemeStatusColorPairs(
  page: Page,
  surfaceId: string,
): Promise<
  readonly {
    readonly background: string;
    readonly foreground: string;
    readonly subjectId: string;
  }[]
> {
  const context = page.context();
  const lightPage = await context.newPage();
  try {
    await lightPage.emulateMedia({ colorScheme: 'light' });
    await lightPage.goto(
      `${baseUrl}/?surface=${encodeURIComponent(surfaceId)}`,
    );
    return await readStatusColorPairs(lightPage);
  } finally {
    await lightPage.close();
  }
}

/**
 * The shimmer's subject is the shipped stylesheet, not any surface: skeleton
 * geometry is packet `U5` and nothing renders a skeleton yet. So the probe is
 * an element carrying the shipped `.skeleton` class, and what is observed is
 * what the browser resolved for it — including the `::after` pseudo-element the
 * animation actually lives on.
 */
async function readSkeletonMotion(page: Page): Promise<
  readonly {
    readonly animationDuration: string;
    readonly animationName: string;
    readonly display: string;
    readonly subjectId: string;
    readonly timingFunction: string;
  }[]
> {
  return await page.evaluate(() => {
    document
      .querySelectorAll('[data-skeleton-probe]')
      .forEach((existing) => existing.remove());
    const probe = document.createElement('div');
    probe.className = 'skeleton';
    probe.setAttribute('data-skeleton-probe', 'skeleton-probe');
    probe.style.width = '200px';
    probe.style.height = '20px';
    document.body.append(probe);
    return [...document.querySelectorAll('[data-skeleton-probe]')].map(
      (element) => {
        const sheen = getComputedStyle(element, '::after');
        return {
          animationDuration: sheen.animationDuration,
          animationName: sheen.animationName,
          display: sheen.display,
          subjectId: element.getAttribute('data-skeleton-probe') ?? 'unnamed',
          timingFunction: sheen.animationTimingFunction,
        };
      },
    );
  });
}

function observeReducedMotion(
  skeletons: readonly {
    readonly animationName: string;
    readonly display: string;
    readonly subjectId: string;
  }[],
) {
  return {
    skeletonsRead: skeletons.length,
    violations: skeletons
      .filter(
        (skeleton) =>
          skeleton.animationName !== 'none' && skeleton.display !== 'none',
      )
      .map((skeleton) => `REDUCED_MOTION_SHIMMER:${skeleton.subjectId}`),
  };
}

/**
 * ADR-0035 §4: the brand hue is reserved and no status role may resolve into
 * it. Derived from the rendered colour rather than asserted against a token
 * name, because the rule is about what the eye competes with.
 */
const BRAND_HUE_DEGREES = 199;
const BRAND_HUE_BAND_DEGREES = 20;
// Below this chroma a colour has no hue worth competing with — a near-grey
// cannot fight the identity colour. Reported separately so a palette that went
// achromatic cannot pass this gate by having nothing left to measure.
const CHROMATIC_FLOOR = 0.06;

function observeBrandStatusSeparability(
  pairs: readonly {
    readonly background: string;
    readonly foreground: string;
    readonly subjectId: string;
  }[],
) {
  const violations: string[] = [];
  let hueSamplesRead = 0;
  let chromaticHueSamplesRead = 0;
  for (const pair of pairs) {
    for (const channel of ['background', 'foreground'] as const) {
      hueSamplesRead += 1;
      const sample = hueOf(pair[channel]);
      if (sample.chroma < CHROMATIC_FLOOR) continue;
      chromaticHueSamplesRead += 1;
      if (
        hueDistance(sample.hue, BRAND_HUE_DEGREES) <= BRAND_HUE_BAND_DEGREES
      ) {
        violations.push(`BRAND_HUE:${pair.subjectId}:${channel}`);
      }
    }
  }
  return { chromaticHueSamplesRead, hueSamplesRead, violations };
}

function hueOf(color: string): { chroma: number; hue: number } {
  const [red, green, blue] = [1, 3, 5].map(
    (offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255,
  ) as [number, number, number];
  const max = Math.max(red, green, blue);
  const chroma = max - Math.min(red, green, blue);
  if (chroma === 0) return { chroma: 0, hue: 0 };
  const raw =
    max === red
      ? ((green - blue) / chroma) % 6
      : max === green
        ? (blue - red) / chroma + 2
        : (red - green) / chroma + 4;
  return { chroma, hue: (raw * 60 + 360) % 360 };
}

function hueDistance(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

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
        candidate.archetype === 'home' ||
        candidate.archetype === 'list' ||
        candidate.archetype === 'task',
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

async function assertNoHorizontalDocumentScroll(page: Page): Promise<void> {
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

function groupedNavigationRuntimeFixture(): Readonly<Record<string, unknown>> {
  const fixture = structuredClone(surfaceGrammarRuntimeFixture()) as Record<
    string,
    unknown
  >;
  const projections = fixture.projections as Record<string, unknown>;
  const surfaceProjection = projections.surface as Record<string, unknown>;
  const payload = surfaceProjection.payload as Record<string, unknown>;
  const compiledSurfaces = payload.surfaces as Array<Record<string, unknown>>;
  const listSurface = compiledSurfaces.find(
    (surface) => surface.archetype === 'list',
  );
  assert.ok(listSurface);
  const navigationSurfaces = Array.from({ length: 6 }, (_, index) => ({
    ...structuredClone(listSurface),
    label: `Budget item ${index + 1} list`,
    surfaceId: `${String(listSurface.surfaceId)}.budget_${index + 1}`,
  }));
  payload.surfaces = navigationSurfaces;
  surfaceProjection.payloadSchemaVersion =
    GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION;
  payload.schemaVersion = GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION;
  const moduleGroup = (index: number) => ({
    children: [
      {
        kind: 'navigationSurface',
        surfaceId: navigationSurfaces[index]!.surfaceId,
      },
    ],
    kind: 'navigationGroup',
    label: `Module ${index + 1}`,
    navigationId: `northstar.grammar:module.budget_${index + 1}`,
  });
  payload.navigation = {
    entries: [
      ...Array.from({ length: 4 }, (_, index) => moduleGroup(index)),
      {
        children: [moduleGroup(4), moduleGroup(5)],
        kind: 'navigationGroup',
        label: 'More',
        navigationId: 'northstar.grammar:navigation.more',
      },
    ],
    kind: 'navigationTree',
  };
  return fixture;
}

function v0GroupedNavigationRuntimeFixture(): Readonly<
  Record<string, unknown>
> {
  const fixture = structuredClone(groupedNavigationRuntimeFixture()) as Record<
    string,
    unknown
  >;
  const projections = fixture.projections as Record<string, unknown>;
  const surfaceProjection = projections.surface as Record<string, unknown>;
  const payload = surfaceProjection.payload as Record<string, unknown>;
  surfaceProjection.payloadSchemaVersion =
    FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION;
  payload.schemaVersion = FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION;
  return fixture;
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
