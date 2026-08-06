import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import {
  STATUS_ROLES,
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
 * ADR-0035 observations. Every one reads the *rendered* page in a live browser
 * rather than the stylesheet source, because the fact each asserts is "what the
 * user's machine resolved", not "what someone typed".
 *
 * Revision 1 closed five holes an independent review found in the first round,
 * and the shape of all five was the same: the gate measured a property of a
 * subject without first proving the subject was there, was complete, or was the
 * one the doctrine names. So the sample below carries geometry, text and the
 * generated dot alongside colour, the coverage set comes from the canonical
 * vocabulary rather than from the fixture that rendered the page, the token the
 * colour should have come from is resolved separately and compared, and a
 * non-opaque computed colour is refused instead of being truncated into a
 * confident wrong number.
 */
interface StatusRoleSample {
  readonly background: string;
  readonly dotArea: number;
  readonly dotContent: string;
  readonly dotDisplay: string;
  readonly foreground: string;
  readonly height: number;
  readonly subjectId: string;
  readonly text: string;
  readonly tokenGround: string;
  readonly tokenInk: string;
  readonly visible: boolean;
  readonly width: number;
}

test('every canonical status role renders perceivably, from its own token', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  // The fixture must still declare the whole vocabulary; if it ever shrinks the
  // failure belongs here and not silently inside a smaller coverage set.
  assert.deepEqual(
    [...builder.statusRoles].toSorted(),
    [...STATUS_ROLES].toSorted(),
  );
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );

  const samples = await readStatusRoleSamples(page);
  // Pinned to the canonical vocabulary, NOT to the compiled fixture. The first
  // round compared the fixture against itself, so both sides shrank together.
  assert.deepEqual(
    samples.map((sample) => sample.subjectId).toSorted(),
    [...STATUS_ROLES].toSorted(),
  );

  const encoding = observeRedundantEncoding(samples);
  const routing = observeTokenRouting(samples);
  const brand = await readBrandHue(page);
  const separability = observeBrandStatusSeparability(samples, brand.hue);
  const accessibility = observeAccessibility(samples, []);

  assert.equal(encoding.rolesRead, STATUS_ROLES.length);
  assert.equal(routing.rolesRead, STATUS_ROLES.length);
  assert.equal(accessibility.contrastPairsRead, STATUS_ROLES.length);
  assert.equal(separability.hueSamplesRead, STATUS_ROLES.length * 2);
  assert.ok(separability.chromaticHueSamplesRead > 0);
  // A near-grey brand would make the reserved band meaningless, so the band's
  // own source is checked before it is trusted as a comparator.
  assert.ok(brand.chroma >= CHROMATIC_FLOOR);
  console.log(
    `rendered status palette: ${String(encoding.rolesRead)} roles perceivable, ${String(routing.rolesRead)} token-routed, ${String(accessibility.contrastPairsRead)} contrast pairs, ${String(separability.hueSamplesRead)} hue samples (${String(separability.chromaticHueSamplesRead)} chromatic) against a rendered brand hue of ${brand.hue.toFixed(1)}°`,
  );

  assert.deepEqual(encoding.violations, []);
  assert.deepEqual(routing.violations, []);
  assert.deepEqual(accessibility.violations, []);
  assert.deepEqual(separability.violations, []);
});

test('redundant-encoding red: a hidden status role is observed while its siblings stay green', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );
  await page.addStyleTag({
    content: '[data-status-role=success]{display:none!important}',
  });

  const samples = await readStatusRoleSamples(page);
  const encoding = observeRedundantEncoding(samples);
  // The subject is still fully read — this is the vacuity vector, so the count
  // has to stay at four while exactly one role reds.
  assert.equal(encoding.rolesRead, STATUS_ROLES.length);
  assert.deepEqual(encoding.violations, [
    'REDUNDANT_ENCODING_IMPERCEPTIBLE:success',
  ]);
});

test('redundant-encoding red: colour without the dot is observed as colour alone', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );
  // ADR-0035 §5 calls colour + dot + word non-negotiable. This removes exactly
  // the dot and leaves colour and word intact.
  await page.addStyleTag({
    content: '[data-status-role]::before{display:none!important}',
  });

  const encoding = observeRedundantEncoding(await readStatusRoleSamples(page));
  assert.equal(encoding.rolesRead, STATUS_ROLES.length);
  assert.deepEqual(
    encoding.violations.toSorted(),
    [...STATUS_ROLES]
      .toSorted()
      .map((role) => `REDUNDANT_ENCODING_DOT:${role}`),
  );
});

test('token-routing red: an off-brand contrast-safe literal in a status selector is observed', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );
  // The whole point of this control: a green that clears 4.5:1 and sits nowhere
  // near the brand hue. Contrast and separability must stay green underneath so
  // that the routing assertion is demonstrably the only thing that reds. This
  // is the tree ADR-0035's doctrine forbids and the first round could not see:
  // no new hex literal, the tokens still declared and still well-formed, and
  // every colour gate satisfied by hardcoded values.
  await page.addStyleTag({
    content:
      '[data-status-role=success]{color:hsl(150 70% 22%)!important;background:hsl(150 45% 93%)!important}',
  });

  const samples = await readStatusRoleSamples(page);
  const brand = await readBrandHue(page);
  assert.deepEqual(observeAccessibility(samples, []).violations, []);
  assert.deepEqual(
    observeBrandStatusSeparability(samples, brand.hue).violations,
    [],
  );
  assert.deepEqual(observeRedundantEncoding(samples).violations, []);

  const routing = observeTokenRouting(samples);
  assert.equal(routing.rolesRead, STATUS_ROLES.length);
  assert.deepEqual(routing.violations, [
    'TOKEN_ROUTING:success:background',
    'TOKEN_ROUTING:success:foreground',
  ]);
});

test('separability red: a status role moved into the rendered brand hue is observed', async ({
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

  const samples = await readStatusRoleSamples(page);
  const brand = await readBrandHue(page);
  assert.deepEqual(observeAccessibility(samples, []).violations, []);
  const separability = observeBrandStatusSeparability(samples, brand.hue);
  assert.equal(separability.hueSamplesRead, STATUS_ROLES.length * 2);
  assert.deepEqual(separability.violations, [
    'BRAND_HUE:inProgress:background',
    'BRAND_HUE:inProgress:foreground',
  ]);
});

test('separability red: the band follows the brand token rather than a copied constant', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );
  // Move the BRAND onto inProgress's indigo instead of moving a status role.
  // A hardcoded 199° comparator stays green here; a derived one cannot.
  await page.addStyleTag({
    content: ':root{--brand:var(--s-inprogress-ink)!important}',
  });

  const samples = await readStatusRoleSamples(page);
  const brand = await readBrandHue(page);
  assert.ok(brand.chroma >= CHROMATIC_FLOOR);
  assert.ok(hueDistance(brand.hue, 199) > BRAND_HUE_BAND_DEGREES);
  const separability = observeBrandStatusSeparability(samples, brand.hue);
  assert.equal(separability.hueSamplesRead, STATUS_ROLES.length * 2);
  assert.deepEqual(separability.violations, [
    'BRAND_HUE:inProgress:background',
    'BRAND_HUE:inProgress:foreground',
  ]);
});

test('opacity red: a non-opaque status ground is refused rather than measured as black', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );
  // `rgba(0,0,0,0)` truncated to three channels reads as pure black, which
  // "passes" against light text. Refusing it is the only honest answer without
  // compositing against the real underlying surface.
  await page.addStyleTag({
    content: '[data-status-role=blocked]{background:transparent!important}',
  });

  const observed = observeAccessibility(await readStatusRoleSamples(page), []);
  assert.equal(observed.contrastPairsRead, STATUS_ROLES.length);
  assert.deepEqual(observed.violations, ['NON_OPAQUE:blocked:background']);
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

test('every status role is remapped for dark mode and holds the floor there', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );

  const dark = await readStatusRoleSamples(page);
  const light = await lightSchemeStatusRoleSamples(page, builder.surfaceId);
  // Per role, not per page. `notDeepEqual` over the whole array passed when a
  // single element differed, so three roles could carry light values into dark.
  const remapping = observeDarkRemapping(dark, light);
  const encoding = observeRedundantEncoding(dark);
  const routing = observeTokenRouting(dark);
  const brand = await readBrandHue(page);
  const separability = observeBrandStatusSeparability(dark, brand.hue);
  const accessibility = observeAccessibility(dark, []);

  assert.equal(remapping.rolesCompared, STATUS_ROLES.length);
  assert.equal(encoding.rolesRead, STATUS_ROLES.length);
  assert.equal(routing.rolesRead, STATUS_ROLES.length);
  assert.equal(accessibility.contrastPairsRead, STATUS_ROLES.length);
  assert.ok(separability.chromaticHueSamplesRead > 0);
  console.log(
    `dark scheme status palette: ${String(remapping.rolesCompared)} roles remapped, ${String(encoding.rolesRead)} perceivable, ${String(routing.rolesRead)} token-routed, ${String(accessibility.contrastPairsRead)} contrast pairs, ${String(separability.hueSamplesRead)} hue samples (${String(separability.chromaticHueSamplesRead)} chromatic)`,
  );

  assert.deepEqual(remapping.violations, []);
  assert.deepEqual(encoding.violations, []);
  assert.deepEqual(routing.violations, []);
  assert.deepEqual(accessibility.violations, []);
  assert.deepEqual(separability.violations, []);
});

test('dark-mode red: one role left on its light values is observed', async ({
  page,
}) => {
  const builder = fixtureSurface('builder');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(
    `${baseUrl}/?surface=${encodeURIComponent(builder.surfaceId)}`,
  );
  // `--s-*` are the light status primitives and are NOT redefined under dark, so
  // this restores exactly the light pair. Contrast stays green (7.07:1) and no
  // literal moves, which is what makes the partial-remap case invisible without
  // a per-role comparison.
  await page.addStyleTag({
    content:
      '[data-status-role=success]{color:var(--s-success-ink)!important;background:var(--s-success-ground)!important}',
  });

  const dark = await readStatusRoleSamples(page);
  const light = await lightSchemeStatusRoleSamples(page, builder.surfaceId);
  assert.deepEqual(observeAccessibility(dark, []).violations, []);
  const remapping = observeDarkRemapping(dark, light);
  assert.equal(remapping.rolesCompared, STATUS_ROLES.length);
  assert.deepEqual(remapping.violations, ['DARK_SCHEME_UNMAPPED:success']);
});

test('dark-mode red: the light-ground accent on a dark ground is observed below the floor', async ({
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

  const observed = observeAccessibility(await readStatusRoleSamples(page), []);
  assert.equal(observed.contrastPairsRead, STATUS_ROLES.length);
  assert.deepEqual(
    observed.violations.toSorted(),
    [...STATUS_ROLES].toSorted().map((role) => `CONTRAST:${role}`),
  );
});

/**
 * One pass over the page per scheme. Colour, geometry, visible text and the
 * generated dot come off the same element, and the token the colour is supposed
 * to have come from is resolved beside it through a probe that deliberately
 * carries no `data-status-role` — so a stylesheet that overrides the role
 * selectors moves the rendered pair and leaves the probe alone.
 */
async function readStatusRoleSamples(
  page: Page,
): Promise<readonly StatusRoleSample[]> {
  return await page.evaluate(() => {
    const tokenSuffix = (role: string) => role.toLowerCase();
    const probe = document.createElement('span');
    probe.setAttribute('data-token-probe', '');
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    document.body.append(probe);
    const resolve = (property: string): string => {
      probe.style.color = '';
      probe.style.color = `var(${property})`;
      return getComputedStyle(probe).color;
    };
    try {
      return [...document.querySelectorAll('[data-status-role]')]
        .map((element) => {
          const role = element.getAttribute('data-status-role') ?? 'missing';
          const style = getComputedStyle(element);
          const dot = getComputedStyle(element, '::before');
          const rectangle = element.getBoundingClientRect();
          const dotWidth = Number.parseFloat(dot.width);
          const dotHeight = Number.parseFloat(dot.height);
          return {
            background: style.backgroundColor,
            dotArea:
              Number.isFinite(dotWidth) && Number.isFinite(dotHeight)
                ? dotWidth * dotHeight
                : 0,
            dotContent: dot.content,
            dotDisplay: dot.display,
            foreground: style.color,
            height: rectangle.height,
            subjectId: role,
            text: (element.textContent ?? '').trim(),
            tokenGround: resolve(`--status-${tokenSuffix(role)}-ground`),
            tokenInk: resolve(`--status-${tokenSuffix(role)}-ink`),
            visible:
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number.parseFloat(style.opacity) > 0,
            width: rectangle.width,
          };
        })
        .sort((left, right) => left.subjectId.localeCompare(right.subjectId));
    } finally {
      probe.remove();
    }
  });
}

async function lightSchemeStatusRoleSamples(
  page: Page,
  surfaceId: string,
): Promise<readonly StatusRoleSample[]> {
  const lightPage = await page.context().newPage();
  try {
    await lightPage.emulateMedia({ colorScheme: 'light' });
    await lightPage.goto(
      `${baseUrl}/?surface=${encodeURIComponent(surfaceId)}`,
    );
    return await readStatusRoleSamples(lightPage);
  } finally {
    await lightPage.close();
  }
}

/**
 * ADR-0035 §5: every status renders colour + dot + word on a tinted ground,
 * never colour alone. Nothing observed this in round one, so a stylesheet
 * carrying `[data-status-role]{display:none}` kept every colour gate green
 * against a page showing no status at all.
 */
function observeRedundantEncoding(samples: readonly StatusRoleSample[]) {
  const violations: string[] = [];
  for (const sample of samples) {
    if (!sample.visible || sample.width <= 0 || sample.height <= 0) {
      // Word and dot are meaningless on something nobody can see, so this is
      // reported alone rather than as three violations for one cause.
      violations.push(`REDUNDANT_ENCODING_IMPERCEPTIBLE:${sample.subjectId}`);
      continue;
    }
    if (sample.text.length === 0) {
      violations.push(`REDUNDANT_ENCODING_WORD:${sample.subjectId}`);
    }
    if (
      sample.dotContent === 'none' ||
      sample.dotDisplay === 'none' ||
      sample.dotArea <= 0
    ) {
      violations.push(`REDUNDANT_ENCODING_DOT:${sample.subjectId}`);
    }
  }
  return { rolesRead: samples.length, violations };
}

/**
 * The seam plan §8.6 and `ux-grammar` both require and nothing joined up: the
 * colour on screen must be the colour the role token resolves to. Without this
 * a tree can replace every status selector with `rgb()` or `hsl()` literals and
 * satisfy the hex ratchet, the token-value contrast check and the rendered
 * contrast check simultaneously.
 */
function observeTokenRouting(samples: readonly StatusRoleSample[]) {
  const violations: string[] = [];
  for (const sample of samples) {
    if (sample.background !== sample.tokenGround) {
      violations.push(`TOKEN_ROUTING:${sample.subjectId}:background`);
    }
    if (sample.foreground !== sample.tokenInk) {
      violations.push(`TOKEN_ROUTING:${sample.subjectId}:foreground`);
    }
  }
  return { rolesRead: samples.length, violations };
}

/**
 * ADR-0035 §10 requires both themes designed. Compared per role: a whole-array
 * inequality passes when one element of four differs.
 */
function observeDarkRemapping(
  dark: readonly StatusRoleSample[],
  light: readonly StatusRoleSample[],
) {
  const lightByRole = new Map(
    light.map((sample) => [sample.subjectId, sample] as const),
  );
  const violations: string[] = [];
  let rolesCompared = 0;
  for (const sample of dark) {
    const counterpart = lightByRole.get(sample.subjectId);
    if (!counterpart) {
      violations.push(`DARK_SCHEME_UNCOMPARED:${sample.subjectId}`);
      continue;
    }
    rolesCompared += 1;
    if (
      sample.background === counterpart.background &&
      sample.foreground === counterpart.foreground
    ) {
      violations.push(`DARK_SCHEME_UNMAPPED:${sample.subjectId}`);
    }
  }
  return { rolesCompared, violations };
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
 * it. The band is derived from the rendered `--brand` rather than a copied
 * constant, so moving the brand onto a status hue is caught from either side.
 */
const BRAND_HUE_BAND_DEGREES = 20;
// Below this chroma a colour has no hue worth competing with — a near-grey
// cannot fight the identity colour. Reported separately so a palette that went
// achromatic cannot pass this gate by having nothing left to measure.
const CHROMATIC_FLOOR = 0.06;

async function readBrandHue(
  page: Page,
): Promise<{ readonly chroma: number; readonly hue: number }> {
  const rendered = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.left = '-9999px';
    probe.style.color = 'var(--brand)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  const brand = parseComputedColor(rendered);
  if (!brand.opaque) throw new Error(`brand token is not opaque: ${rendered}`);
  return hueOf(brand.hex);
}

function observeBrandStatusSeparability(
  samples: readonly StatusRoleSample[],
  brandHue: number,
) {
  const violations: string[] = [];
  let hueSamplesRead = 0;
  let chromaticHueSamplesRead = 0;
  for (const sample of samples) {
    for (const channel of ['background', 'foreground'] as const) {
      hueSamplesRead += 1;
      const color = parseComputedColor(sample[channel]);
      if (!color.opaque) continue;
      const measurement = hueOf(color.hex);
      if (measurement.chroma < CHROMATIC_FLOOR) continue;
      chromaticHueSamplesRead += 1;
      if (hueDistance(measurement.hue, brandHue) <= BRAND_HUE_BAND_DEGREES) {
        violations.push(`BRAND_HUE:${sample.subjectId}:${channel}`);
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

/**
 * ADR-0035 §6 alignment, at the layer that actually shipped.
 *
 * `surface-runtime.ts:1176-1177` went out ungated. The reason given was that no
 * real numeric cell exists while the compiled numeric type is blocked, and that
 * gating it would mean inventing a subject. That reasoning was wrong, and the
 * distinction is worth keeping: the fabricated-subject vacuity is about
 * inventing *data*. The fact under test here is *cascade behaviour* — a compact
 * card cell selector at 0-2-2 beat the numeric override at 0-2-1, so a marked
 * cell rendered left-aligned — and that is real whether or not real data flows
 * through it.
 *
 * **This proves the CSS, not the feature.** Nothing marks a cell `.cell-numeric`
 * on the shared-list path today; that is the blocked numeric-type work and this
 * gate does not claim it.
 */
test('a marked numeric cell aligns right in both projections, and its compact label stays left', async ({
  page,
}) => {
  await page.goto(baseUrl);

  const wide = await readNumericCellAlignment(page, 1280);
  const compact = await readNumericCellAlignment(page, 390);

  console.log(
    `numeric cell alignment: wide cell=${wide.cell} label=${wide.label}; compact cell=${compact.cell} label=${compact.label} (compact card layout ${String(compact.isCard)})`,
  );
  // The compact rule only exists because the card cell selector wins at that
  // width; asserting the card layout is active is what stops this passing as a
  // second reading of the wide rule.
  assert.equal(wide.isCard, false);
  assert.equal(compact.isCard, true);
  assert.equal(wide.cell, 'right');
  assert.equal(compact.cell, 'right');
  assert.equal(compact.label, 'left');
});

test('alignment red: removing the compact override returns the cell to left while wide stays right', async ({
  page,
}) => {
  await page.goto(baseUrl);
  // Same specificity as the shipped rule and later in order, so it wins — which
  // reproduces the pre-fix cascade exactly: the 0-2-2 card rule deciding the
  // cell and the 0-2-1 numeric override losing.
  await page.addStyleTag({
    content:
      '@media(max-width:800px){.data-table-wrap tr[data-compact-card=true] td:has(.cell-numeric){text-align:left}}',
  });

  const wide = await readNumericCellAlignment(page, 1280);
  const compact = await readNumericCellAlignment(page, 390);
  assert.equal(compact.isCard, true);
  assert.equal(compact.cell, 'left');
  // The compact case reds on its own: the wide rule is untouched, so a single
  // control cannot be mistaken for both halves failing together.
  assert.equal(wide.cell, 'right');
});

/**
 * Builds the compact card structure the compiled list emits and reads what the
 * shipped stylesheet resolves for it. The markup is constructed rather than
 * navigated to because the numeric marker has no producer yet — stated in the
 * test above rather than hidden here.
 */
async function readNumericCellAlignment(
  page: Page,
  width: number,
): Promise<{
  readonly cell: string;
  readonly isCard: boolean;
  readonly label: string;
}> {
  await page.setViewportSize({ height: 844, width });
  return await page.evaluate(() => {
    document
      .querySelectorAll('[data-alignment-probe]')
      .forEach((existing) => existing.remove());
    const wrap = document.createElement('div');
    wrap.className = 'data-table-wrap';
    wrap.setAttribute('data-alignment-probe', '');
    wrap.innerHTML =
      '<table><tbody><tr data-compact-card="true">' +
      '<td data-column-label="Quantity"><span class="cell-numeric">1,250.00</span></td>' +
      '</tr></tbody></table>';
    document.body.append(wrap);
    const cell = wrap.querySelector('td');
    if (!cell) throw new Error('numeric probe cell was not created');
    const cellStyle = getComputedStyle(cell);
    const labelStyle = getComputedStyle(cell, '::before');
    const observed = {
      cell: cellStyle.textAlign,
      isCard: cellStyle.display === 'grid',
      label: labelStyle.textAlign,
    };
    wrap.remove();
    return observed;
  });
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
  const accessibility = observeAccessibility(computedPairs, targets);
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

/**
 * A computed colour is only measurable when it is opaque. The first round took
 * the first three numbers and discarded alpha, so an element with no background
 * computed `rgba(0, 0, 0, 0)` and was measured as pure black — a confident
 * number for a colour that is not there, and one that passes against light
 * text. Compositing against the effective underlying surface is the other
 * honest answer; it needs the whole ancestor stack and every intervening
 * background, so this refuses instead and the caller records the refusal.
 */
interface ComputedColor {
  readonly hex: string;
  readonly opaque: boolean;
}

function parseComputedColor(value: string): ComputedColor {
  const channels = value.match(/-?\d+(?:\.\d+)?/g);
  if (!channels || channels.length < 3) {
    throw new Error(`unsupported computed color ${value}`);
  }
  const alpha = channels.length > 3 ? Number(channels[3]) : 1;
  if (!Number.isFinite(alpha) || alpha < 1) {
    return { hex: '', opaque: false };
  }
  return {
    hex: `#${channels
      .slice(0, 3)
      .map((channel) =>
        Math.round(Number(channel)).toString(16).padStart(2, '0'),
      )
      .join('')}`,
    opaque: true,
  };
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
    const foreground = parseComputedColor(pair.foreground);
    const background = parseComputedColor(pair.background);
    if (!foreground.opaque) {
      violations.push(`NON_OPAQUE:${pair.subjectId}:foreground`);
    }
    if (!background.opaque) {
      violations.push(`NON_OPAQUE:${pair.subjectId}:background`);
    }
    if (!foreground.opaque || !background.opaque) continue;
    if (contrastRatio(foreground.hex, background.hex) < 4.5) {
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
