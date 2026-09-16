import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import { trustedContextForRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import pg from 'pg';

import {
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
  startComposedApplication,
} from '../../../api/src/composition-root.js';
import {
  INVENTORY_POSTING_CAPABILITY_ID,
  INVENTORY_POSTING_CAPABILITY_VERSION,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  PostgresInventoryPostingService,
  type InventoryAdjustmentPostingCommandV1,
} from '../../../../packages/postgres-provider/src/inventory-posting-service.js';
import { TrustedActorEnvelopeIssuer } from '../../../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import { SHARED_LIST_QUERY_VERSION } from '../../../../packages/runtime/src/list-behavior/index.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../../../packages/runtime/src/semantic-query-gateway.js';
import { withEphemeralPostgres } from '../../../../test/helpers/postgres.js';

const applicationNamespace = 'northstar.app';
// Bounded integration-test allowances, not latency assertions. Every journey
// below is dominated by real page loads: a traced run of the grouped-navigation
// journey measured 3.8-6.0s per navigation against 336ms for all 31 of its
// assertions combined, so a journey's cost is its navigation count and the
// per-navigation cost is the composed application's, not this packet's: the
// packet changes `surface-runtime.ts` by one line. Each bound is ~2x the
// duration measured for its slowest journey with the bounds
// lifted; all nine then passed on their assertions, so every prior failure was
// the bound rather than a defect: navigation 34.4s, on-hand 20.9s, scoped
// inventory 37.2s, posting route 49.4s, scoped form persistence 78s, focus
// ring 36.6s. The doubling absorbs hosted-runner and contention variance.
// Semantic assertions and the 5s expect timeout are unchanged.
const journeyTimeoutMilliseconds = Object.freeze({
  focusRing: 75_000,
  inventoryNavigation: 70_000,
  onHandLookup: 45_000,
  // This multi-form lifecycle now performs real current-policy reads/writes
  // and restarts the composed application, so it is the most variable journey
  // here. It measured 56.4s against its previous 60s bound in an uncontended
  // run -- passing, but with 6% of headroom on a suite that inflates 1.5-1.7x
  // under worker contention. Same allowance as the rest; not a latency
  // assertion, and all semantic assertions stay intact.
  partyLifecycle: 115_000,
  postingRoute: 100_000,
  repairedFormAnatomy: 160_000,
  scopedInventory: 75_000,
});
const sharedSetupTimeoutMilliseconds = 180_000;

type ComposedApplication = Awaited<ReturnType<typeof startComposedApplication>>;

interface ComposedApplicationFixture {
  readonly currentBaseUrl: () => string;
  readonly restart: (() => Promise<void>) | undefined;
}

interface ComposedWorkerFixtures {
  readonly composedApplication: ComposedApplicationFixture;
}

const composedTest = test.extend<object, ComposedWorkerFixtures>({
  composedApplication: [
    async ({ browserName }, use) => {
      const externalBaseUrl = process.env.COMPOSED_APPLICATION_BASE_URL;
      if (externalBaseUrl) {
        await use({
          currentBaseUrl: () => externalBaseUrl,
          restart: undefined,
        });
        return;
      }

      await withEphemeralPostgres(
        `composed-${browserName}-journeys`,
        async ({ connection, pool }) => {
          const databaseUrl = `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
          let application: ComposedApplication | undefined =
            await startComposedApplication({
              databaseUrl,
              port: 0,
              tenantSlug: 'composed-browser-tenant',
            });
          try {
            // A fresh database admits the complete immutable application lineage
            // once, including the additional on-hand surface revision.
            await assertSeedTrust(pool, application);
            await seedPostedInventory(pool, databaseUrl, application);
            await use({
              currentBaseUrl: () => {
                if (!application) {
                  throw new Error('the composed application is not running');
                }
                return application.baseUrl;
              },
              restart: async () => {
                const currentApplication = application;
                if (!currentApplication) {
                  throw new Error('the composed application is not running');
                }
                application = undefined;
                await currentApplication.close();
                application = await startComposedApplication({
                  databaseUrl,
                  port: 0,
                  tenantSlug: 'composed-browser-tenant',
                });
              },
            });
          } finally {
            await application?.close();
          }
        },
      );
    },
    { scope: 'worker', timeout: sharedSetupTimeoutMilliseconds },
  ],
});

composedTest.describe('composed application journeys', () => {
  composedTest(
    'navigates grouped Inventory and responsive lists',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.inventoryNavigation);
      await inventoryNavigationJourney(
        page,
        composedApplication.currentBaseUrl(),
      );
    },
  );

  composedTest(
    'opens grouped master, stock, and purchasing lists',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.inventoryNavigation);
      await inventoryRecordNavigationJourney(
        page,
        composedApplication.currentBaseUrl(),
      );
    },
  );

  composedTest(
    'refuses incomplete and duplicate on-hand scopes',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.onHandLookup);
      await onHandLookupRefusalJourney(
        page,
        composedApplication.currentBaseUrl(),
      );
    },
  );

  composedTest(
    'looks up on-hand stock in the selected legal entity',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.onHandLookup);
      await onHandLookupJourney(page, composedApplication.currentBaseUrl());
    },
  );

  composedTest(
    'scopes immutable Inventory movement lists',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.scopedInventory);
      await scopedInventoryListJourney(
        page,
        composedApplication.currentBaseUrl(),
      );
    },
  );

  composedTest(
    'scopes immutable Inventory records and refuses writes',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.scopedInventory);
      await scopedInventoryJourney(page, composedApplication.currentBaseUrl());
    },
  );

  composedTest(
    'renders repaired forms through their real controls',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.repairedFormAnatomy);
      await repairedFormAnatomyJourney(
        page,
        composedApplication.currentBaseUrl(),
      );
    },
  );

  composedTest(
    'saves scoped forms and two required scoped relations',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.repairedFormAnatomy);
      await scopedFormPersistenceJourney(
        page,
        composedApplication.currentBaseUrl(),
      );
    },
  );

  composedTest(
    'persists the Party lifecycle across restart',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.partyLifecycle);
      await partyLifecycleJourney(page, composedApplication.currentBaseUrl());
      if (!composedApplication.restart) return;

      // Restart runs governed application startup (including current AUTH),
      // so give it the same bounded allowance as initial fixture startup.
      composedTest.setTimeout(
        journeyTimeoutMilliseconds.partyLifecycle +
          sharedSetupTimeoutMilliseconds,
      );
      await composedTest.step('restart governed application', async () => {
        await composedApplication.restart!();
      });
      await page.goto(
        surfaceUrl(composedApplication.currentBaseUrl(), 'party_list'),
      );
      await expect(
        page.getByRole('cell', {
          name: 'Browser-persisted Party',
          exact: true,
        }),
      ).toBeVisible();
    },
  );

  composedTest(
    'renders one staged adjustment and its authored edit submission',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.postingRoute);
      await postingRouteDraftJourney(
        page,
        composedApplication.currentBaseUrl(),
      );
    },
  );

  composedTest(
    'posts one staged adjustment and keeps its business effect immutable',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.postingRoute);
      await postingRouteJourney(page, composedApplication.currentBaseUrl());
    },
  );
});

/**
 * ADR-0035 §2.2. The focus ring is gated by **derivation**, not by a list.
 *
 * §2.1 claimed `--b500` cleared 3:1 "everywhere the ring lands" and shipped two
 * states below the floor. The claim survived review because the gate measured
 * three hardcoded grounds, and "three grounds" silently became "every ground" —
 * a completeness claim taken from the test's own coverage rather than from the
 * consumers of the token.
 *
 * So this reads the shipped stylesheet out of the browser's CSSOM, finds every
 * `:focus-visible` rule there is, resolves each rule's own declared ring colour,
 * and measures it against the ground each *matched element* actually sits on.
 * Every `<details>` is forced open and both viewports are visited, because two
 * of the grounds exist only inside an open overlay. A seventh focus selector
 * added anywhere in the stylesheet is therefore measured without this file
 * changing — which is the property §2.1's gate did not have.
 *
 * It runs against the composed application because that is the only page where
 * all ten derived selectors have real elements.
 */
const FOCUS_RING_MINIMUM_CONTRAST = 3;

interface FocusRingMeasurement {
  readonly declaredRing: string;
  readonly focusable: boolean;
  readonly groundColor: string;
  readonly groundLabel: string;
  readonly renderedColor: string;
  readonly renderedStyle: string;
  readonly renderedWidth: string;
  readonly selector: string;
  readonly state: string;
}

interface FocusRingObservation {
  readonly measurements: readonly FocusRingMeasurement[];
  readonly selectorsDerived: readonly string[];
  /** Matched but with no layout box in that state — counted, never dropped. */
  readonly subjectsNotRendered: readonly string[];
  readonly selectorsWithoutSubject: readonly string[];
}

composedTest.describe('focus ring coverage', () => {
  for (const scheme of ['light', 'dark'] as const) {
    composedTest(
      `every focus-visible rule clears 3:1 on every ${scheme} ground it lands on`,
      async ({ composedApplication, page }) => {
        composedTest.setTimeout(journeyTimeoutMilliseconds.focusRing);
        const observed = await readFocusRingCoverage(
          page,
          composedApplication.currentBaseUrl(),
          scheme,
        );
        const result = observeFocusRingCoverage(observed);

        assert.ok(observed.selectorsDerived.length > 0);
        assert.ok(result.measurementsRead > 0);
        console.log(
          `focus ring coverage (${scheme}): ${String(observed.selectorsDerived.length)} :focus-visible selectors derived from the stylesheet, ${String(result.measurementsRead)} selector/ground measurements across ${String(result.grounds.length)} distinct grounds`,
        );
        console.log(`  selectors: ${observed.selectorsDerived.join(' | ')}`);
        console.log(`  grounds: ${result.grounds.join(' | ')}`);
        console.log(
          `  painted rings: ${String(result.paintedRingsRead)} of ${String(result.measurementsRead)}; subjects with no layout box: ${String(observed.subjectsNotRendered.length)}`,
        );
        console.log(`  worst: ${result.worst}`);
        assert.equal(result.paintedRingsRead, result.measurementsRead);

        // This pins a KNOWN ABSENCE, and it is not a coverage claim — the
        // distinction the confirm review named correctly. The unreached set is
        // held by EXACT equality, never by an allowlist that can grow.
        // `.list-page-link` renders only when a list has a next cursor, and no
        // composed-application list seeds past its compiled
        // `maximumResultCount`, so this packet cannot reach it; its ring is
        // `--focus-ring-surface`, which the reached selectors measure on the
        // actual grounds above. A second unreached selector, or this one
        // becoming reachable, changes the array and reds either way.
        //
        // `.form-fields select` left this set when ADR-0053's native empty-intent
        // select made the selector reachable without profile-v2 field metadata.
        // Its light and dark measurements are now part of `measurementsRead`.
        assert.deepEqual(observed.selectorsWithoutSubject, [
          '.list-page-link:focus-visible',
        ]);
        assert.deepEqual(result.violations, []);
      },
    );
  }

  composedTest(
    'focus-ring red: a seventh selector on an unmeasured ground is derived and fails',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.focusRing);
      const baseUrl = composedApplication.currentBaseUrl();
      const before = await readFocusRingCoverage(page, baseUrl);
      // Neither this selector nor this ground exists in the shipped stylesheet.
      // A gate driven by a hand-written list stays green here however wrong the
      // colour is, which is exactly how §2.1 shipped.
      const after = await readFocusRingCoverage(
        page,
        baseUrl,
        'light',
        '.skip-link:focus-visible{outline:3px solid var(--n100);outline-offset:2px}',
      );
      const result = observeFocusRingCoverage(after);

      assert.equal(
        after.selectorsDerived.length,
        before.selectorsDerived.length + 1,
      );
      assert.ok(after.selectorsDerived.includes('.skip-link:focus-visible'));
      assert.ok(
        result.measurementsRead >
          observeFocusRingCoverage(before).measurementsRead,
      );
      // Isolated: the injected selector matches an element no shipped focus rule
      // matches, so nothing else moves. The ground set is unchanged and exactly
      // one violation appears.
      assert.deepEqual(
        result.grounds,
        observeFocusRingCoverage(before).grounds,
      );
      assert.deepEqual(result.violations, [
        'FOCUS_RING_CONTRAST:.skip-link:focus-visible',
      ]);
    },
  );

  composedTest(
    'focus-ring red: one token everywhere fails wherever it is not the right end of the ramp',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.focusRing);
      // §2.1's answer, and the trap: a single token measured only against light
      // surfaces looks correct and fails where the sidebar and its flyout are.
      const observed = await readFocusRingCoverage(
        page,
        composedApplication.currentBaseUrl(),
        'light',
        ':root{--focus-ring-surface:var(--b600)!important;--focus-ring-rail:var(--b600)!important}',
      );
      const result = observeFocusRingCoverage(observed);

      assert.ok(result.measurementsRead > 0);
      assert.deepEqual(result.violations, [
        'FOCUS_RING_CONTRAST:.navigation-group > summary:focus-visible',
        'FOCUS_RING_CONTRAST:.sidebar a:focus-visible',
      ]);
    },
  );

  composedTest(
    'focus-ring red: a ring suppressed to zero width is observed as unpainted',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.focusRing);
      // The declaration still says `3px solid var(--focus-ring-rail)` and still
      // resolves to a passing colour. Only the painted indicator is gone, so
      // nothing that reads declarations can see this.
      const observed = await readFocusRingCoverage(
        page,
        composedApplication.currentBaseUrl(),
        'light',
        '.sidebar a{outline-width:0!important}',
      );
      const result = observeFocusRingCoverage(observed);

      assert.ok(result.measurementsRead > 0);
      assert.deepEqual(result.violations, [
        'FOCUS_RING_NOT_PAINTED:.sidebar a:focus-visible',
      ]);
    },
  );

  composedTest(
    'focus-ring red: outline none is observed as no indicator, not as inherited text colour',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.focusRing);
      // `resolveColor` used to strip the keyword `none`, hand the probe an empty
      // colour and read back the probe's inherited text colour — a confident
      // measurement of a ring that does not exist.
      const observed = await readFocusRingCoverage(
        page,
        composedApplication.currentBaseUrl(),
        'light',
        '.sidebar a:focus-visible{outline:none!important}',
      );
      const result = observeFocusRingCoverage(observed);

      assert.ok(result.measurementsRead > 0);
      assert.deepEqual(result.violations, [
        'FOCUS_RING_DECLARED_NONE:.sidebar a:focus-visible',
        'FOCUS_RING_NOT_PAINTED:.sidebar a:focus-visible',
      ]);
    },
  );

  composedTest(
    'focus-ring red: a painted ring that is not the declared token is observed',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.focusRing);
      // FOCUS_RING_CASCADE had no committed red: `outline-width:0` exits through
      // NOT_PAINTED, `outline:none` through DECLARED_NONE, and every token and
      // selector control exits through CONTRAST. A branch never seen to fail is
      // not evidence.
      //
      // `--n0` is a real token on this rail (`--ink-on-rail`), so this is the
      // realistic shape of the defect — another rule declaring a different
      // legitimate token wins — rather than an implausible colour. Measured on
      // both grounds `.sidebar a` occupies: 12.00:1 on `--surface-rail`
      // (`#0B3A55`) and 6.92:1 on `--surface-rail-raised` (`#0F5F8C`), against a
      // 3:1 floor, so contrast cannot fire and only the cascade check can.
      const observed = await readFocusRingCoverage(
        page,
        composedApplication.currentBaseUrl(),
        'light',
        '.sidebar a{outline-color:#FFFFFF!important}',
      );
      const result = observeFocusRingCoverage(observed);
      assert.ok(result.measurementsRead > 0);

      // The injection landed in the direction intended: painted moved, declared
      // did not. Without this the control could red for an unrelated reason.
      const railSubjects = observed.measurements.filter(
        (measurement) => measurement.selector === '.sidebar a:focus-visible',
      );
      assert.ok(railSubjects.length > 0);
      assert.deepEqual(
        [...new Set(railSubjects.map((subject) => subject.renderedColor))],
        ['rgb(255, 255, 255)'],
      );
      assert.deepEqual(
        [...new Set(railSubjects.map((subject) => subject.declaredRing))],
        ['rgb(137, 207, 240)'],
      );

      // Isolation, in order: contrast green, the two neighbouring branches
      // absent, and then the cascade set exactly.
      assert.deepEqual(
        result.violations.filter((violation) =>
          violation.startsWith('FOCUS_RING_CONTRAST:'),
        ),
        [],
      );
      assert.deepEqual(
        result.violations.filter(
          (violation) =>
            violation.startsWith('FOCUS_RING_NOT_PAINTED:') ||
            violation.startsWith('FOCUS_RING_DECLARED_NONE:'),
        ),
        [],
      );
      assert.deepEqual(result.violations, [
        'FOCUS_RING_CASCADE:.sidebar a:focus-visible',
      ]);
    },
  );

  composedTest(
    'focus-ring red: a regression confined to the dark block is observed',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.focusRing);
      // §2.2 gives the surface context --b600 light and --b300 dark. Putting the
      // light value into the dark scheme is invisible to any light-only run.
      const observed = await readFocusRingCoverage(
        page,
        composedApplication.currentBaseUrl(),
        'dark',
        ':root{--focus-ring-surface:var(--b600)!important}',
      );
      const result = observeFocusRingCoverage(observed);

      assert.ok(result.measurementsRead > 0);
      assert.ok(
        result.violations.length > 0,
        `dark-only regression was not observed; worst was ${result.worst}`,
      );
      assert.ok(
        result.violations.every((violation) =>
          violation.startsWith('FOCUS_RING_CONTRAST:'),
        ),
        result.violations.join(' | '),
      );
    },
  );

  composedTest(
    'focus-ring red: the retired --b500 fails on the ground §2.1 never measured',
    async ({ composedApplication, page }) => {
      composedTest.setTimeout(journeyTimeoutMilliseconds.focusRing);
      const observed = await readFocusRingCoverage(
        page,
        composedApplication.currentBaseUrl(),
        'light',
        ':root{--focus-ring-rail:var(--b500)!important}',
      );
      const result = observeFocusRingCoverage(observed);

      // The control is only meaningful if the flyout ground was actually
      // reached, so that is asserted before the violation is.
      assert.ok(
        result.grounds.some((ground) => ground.includes('#0f5f8c')),
        `rail-raised was never measured; grounds were ${result.grounds.join(' | ')}`,
      );
      const summaryGrounds = observed.measurements
        .filter(
          (measurement) =>
            measurement.selector ===
            '.navigation-group > summary:focus-visible',
        )
        .map((measurement) => parseComputedColor(measurement.groundColor).hex);
      const linkGrounds = observed.measurements
        .filter(
          (measurement) => measurement.selector === '.sidebar a:focus-visible',
        )
        .map((measurement) => parseComputedColor(measurement.groundColor).hex);
      // An outline with positive offset lands outside the summary on its
      // details/rail ground. Child-link outlines in the open More flyout land
      // on rail-raised. --b500 clears the former (3.61:1) and fails the latter
      // (2.08:1), so this control pins both observed grounds before the exact red.
      assert.ok(summaryGrounds.includes('#0b3a55'));
      assert.ok(linkGrounds.includes('#0f5f8c'));
      assert.deepEqual(result.violations, [
        'FOCUS_RING_CONTRAST:.sidebar a:focus-visible',
      ]);
    },
  );
});

/**
 * Drives the application into every state a ring can land in, then derives
 * coverage from the CSSOM and the DOM together.
 */
async function readFocusRingCoverage(
  page: Page,
  baseUrl: string,
  scheme: 'dark' | 'light' = 'light',
  injected: string | null = null,
): Promise<FocusRingObservation> {
  await page.emulateMedia({ colorScheme: scheme });
  const measurements: FocusRingMeasurement[] = [];
  const selectorsDerived = new Set<string>();
  const subjectsNotRendered: string[] = [];
  const withSubject = new Set<string>();

  const states: { go: () => Promise<void>; label: string }[] = [
    {
      go: async () => {
        await page.goto(surfaceUrl(baseUrl, 'party_list'));
      },
      label: 'list',
    },
    {
      go: async () => {
        await page.goto(surfaceUrl(baseUrl, 'party_form'));
      },
      label: 'form',
    },
    {
      // Navigated by href rather than clicked: in the compact viewport the
      // fixed bottom navigation intercepts the pointer, and this gate is about
      // the rendered state, not about how a human reaches it.
      go: async () => {
        await page.goto(surfaceUrl(baseUrl, 'party_list'));
        const href = await page
          .locator('.record-link')
          .first()
          .getAttribute('href');
        if (href) await page.goto(new URL(href, baseUrl).href);
      },
      label: 'record',
    },
  ];

  for (const state of states) {
    await page.setViewportSize({ height: 720, width: 1280 });
    await state.go();
    if (injected) await page.addStyleTag({ content: injected });
    for (const viewport of [
      { height: 720, label: 'wide', width: 1280 },
      { height: 844, label: 'compact', width: 390 },
    ]) {
      await page.setViewportSize({
        height: viewport.height,
        width: viewport.width,
      });
      const pass = await page.evaluate((label: string) => {
        for (const details of document.querySelectorAll('details')) {
          details.open = true;
        }

        const focusRules: { outline: string; selector: string }[] = [];
        const walk = (rules: CSSRuleList) => {
          for (const rule of rules) {
            const styleRule = rule as CSSStyleRule;
            const isStyleRule = typeof styleRule.selectorText === 'string';
            // A modern CSSStyleRule carries `cssRules` for CSS nesting, so an
            // `'cssRules' in rule` test swallows every style rule before its
            // selector is read. Recurse into both, classify by selector.
            const nested = (rule as Partial<CSSGroupingRule>).cssRules;
            if (nested && nested.length > 0) walk(nested);
            if (!isStyleRule) continue;
            if (!styleRule.selectorText.includes(':focus-visible')) continue;
            const outline =
              styleRule.style.getPropertyValue('outline') ||
              styleRule.style.getPropertyValue('outline-color') ||
              /outline\s*:\s*([^;}]+)/.exec(styleRule.cssText)?.[1] ||
              '';
            const offset = Number.parseFloat(
              styleRule.style.getPropertyValue('outline-offset') || '0',
            );
            for (const selector of styleRule.selectorText.split(',')) {
              const trimmed = selector.trim();
              if (!trimmed.includes(':focus-visible')) continue;
              focusRules.push({
                outline: `${outline}|${String(Number.isFinite(offset) ? offset : 0)}`,
                selector: trimmed,
              });
            }
          }
        };
        for (const sheet of document.styleSheets) {
          walk(sheet.cssRules);
        }

        const opaque = (color: string): boolean => {
          const parts = color.match(/-?\d+(?:\.\d+)?/g);
          if (!parts || parts.length < 3) return false;
          return parts.length > 3 ? Number(parts[3]) >= 1 : true;
        };
        const groundFor = (
          element: Element,
          outlineOffset: number,
        ): { color: string; label: string } | null => {
          let node: Element | null =
            outlineOffset < 0 ? element : element.parentElement;
          while (node) {
            const background = getComputedStyle(node).backgroundColor;
            if (opaque(background)) {
              const classes =
                typeof node.className === 'string' && node.className.trim()
                  ? `.${node.className.trim().split(/\s+/).join('.')}`
                  : '';
              return {
                color: background,
                label: `${node.tagName.toLowerCase()}${classes}`,
              };
            }
            node = node.parentElement;
          }
          return null;
        };

        const probe = document.createElement('span');
        probe.style.position = 'absolute';
        probe.style.left = '-9999px';
        document.body.append(probe);
        // `outline: none` declares no ring at all. Stripping the keyword and
        // handing the probe an empty colour reads back the probe's INHERITED
        // text colour — a confident measurement of a ring that does not exist —
        // so the absent case returns '' and the observer reports it.
        const resolveColor = (declaration: string): string => {
          const colorText = declaration
            .replace(/\b\d+(?:\.\d+)?(?:px|em|rem)\b/g, '')
            .replace(
              /\b(?:solid|dashed|dotted|double|groove|ridge|inset|outset|none|hidden|auto)\b/g,
              '',
            )
            .trim();
          if (colorText === '') return '';
          probe.style.color = '';
          probe.style.color = colorText;
          return getComputedStyle(probe).color;
        };

        const skipped: string[] = [];
        const rows: {
          declaredRing: string;
          focusable: boolean;
          groundColor: string;
          groundLabel: string;
          renderedColor: string;
          renderedStyle: string;
          renderedWidth: string;
          selector: string;
          state: string;
        }[] = [];
        const derived: string[] = [];
        try {
          for (const { outline, selector } of focusRules) {
            derived.push(selector);
            const [declaration = '', offsetText = '0'] = outline.split('|');
            const outlineOffset = Number.parseFloat(offsetText);
            const base = selector.replaceAll(':focus-visible', '');
            let matched: Element[] = [];
            try {
              matched = [...document.querySelectorAll(base)];
            } catch {
              matched = [];
            }
            const declaredRing = resolveColor(declaration);
            for (const element of matched) {
              if (element === probe) continue;
              if (element.getClientRects().length === 0) {
                skipped.push(`${selector}@${label}`);
                continue;
              }
              const ground = groundFor(element, outlineOffset);
              // The declaration is an intention; this is the indicator. Focus
              // the subject and read what the browser painted, which is the only
              // way `outline-width:0!important` elsewhere in the cascade, or a
              // rule that simply lost, can be seen at all.
              let focusable = false;
              if (element instanceof HTMLElement) {
                element.focus();
                focusable = document.activeElement === element;
              }
              const painted = getComputedStyle(element);
              rows.push({
                declaredRing,
                focusable,
                groundColor: ground?.color ?? '',
                groundLabel: ground?.label ?? 'unresolved',
                renderedColor: focusable ? painted.outlineColor : '',
                renderedStyle: focusable ? painted.outlineStyle : '',
                renderedWidth: focusable ? painted.outlineWidth : '',
                selector,
                state: label,
              });
            }
          }
        } finally {
          probe.remove();
        }
        return { derived, rows, skipped };
      }, `${state.label}/${viewport.label}`);

      for (const selector of pass.derived) selectorsDerived.add(selector);
      for (const entry of pass.skipped) subjectsNotRendered.push(entry);
      for (const row of pass.rows) {
        withSubject.add(row.selector);
        measurements.push(row);
      }
    }
  }

  return {
    measurements,
    selectorsDerived: [...selectorsDerived].sort(),
    subjectsNotRendered: subjectsNotRendered.toSorted(),
    selectorsWithoutSubject: [...selectorsDerived]
      .filter((selector) => !withSubject.has(selector))
      .sort(),
  };
}

function observeFocusRingCoverage(observation: FocusRingObservation) {
  const violations = new Set<string>();
  const grounds = new Set<string>();
  let worstRatio = Number.POSITIVE_INFINITY;
  let worst = 'none measured';

  for (const measurement of observation.measurements) {
    // Rendered first. A contrast number computed from a declaration that never
    // reached the screen is the defect this gate was blocked for.
    if (!measurement.focusable) {
      violations.add(`FOCUS_RING_UNFOCUSABLE:${measurement.selector}`);
      continue;
    }
    if (measurement.declaredRing === '') {
      violations.add(`FOCUS_RING_DECLARED_NONE:${measurement.selector}`);
      continue;
    }
    if (
      measurement.renderedStyle === 'none' ||
      measurement.renderedStyle === 'hidden' ||
      Number.parseFloat(measurement.renderedWidth) === 0
    ) {
      violations.add(`FOCUS_RING_NOT_PAINTED:${measurement.selector}`);
      continue;
    }
    // The cascade proof: what the browser painted must be the ring this
    // subject's own rule declared. A rule that lost, or an override anywhere
    // else, separates these two and nothing before this line notices.
    if (measurement.renderedColor !== measurement.declaredRing) {
      violations.add(`FOCUS_RING_CASCADE:${measurement.selector}`);
      continue;
    }
    if (measurement.groundColor === '') {
      violations.add(`FOCUS_RING_GROUND_UNRESOLVED:${measurement.selector}`);
      continue;
    }
    const ring = parseComputedColor(measurement.renderedColor);
    const ground = parseComputedColor(measurement.groundColor);
    if (!ring.opaque || !ground.opaque) {
      violations.add(`FOCUS_RING_NON_OPAQUE:${measurement.selector}`);
      continue;
    }
    const ratio = contrastRatio(ring.hex, ground.hex);
    grounds.add(`${measurement.groundLabel} ${ground.hex}`);
    if (ratio < worstRatio) {
      worstRatio = ratio;
      worst = `${measurement.selector} on ${measurement.groundLabel} (${measurement.state}) = ${ratio.toFixed(2)}:1`;
    }
    if (ratio < FOCUS_RING_MINIMUM_CONTRAST) {
      violations.add(`FOCUS_RING_CONTRAST:${measurement.selector}`);
    }
  }

  return {
    grounds: [...grounds].sort(),
    measurementsRead: observation.measurements.length,
    paintedRingsRead: observation.measurements.filter(
      (measurement) =>
        measurement.focusable &&
        measurement.renderedStyle !== 'none' &&
        Number.parseFloat(measurement.renderedWidth) > 0,
    ).length,
    violations: [...violations].sort(),
    worst,
  };
}

/** A computed colour is only measurable when it is opaque. */
function parseComputedColor(value: string): {
  readonly hex: string;
  readonly opaque: boolean;
} {
  const channels = value.match(/-?\d+(?:\.\d+)?/g);
  if (!channels || channels.length < 3) return { hex: '', opaque: false };
  const alpha = channels.length > 3 ? Number(channels[3]) : 1;
  if (!Number.isFinite(alpha) || alpha < 1) return { hex: '', opaque: false };
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

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: string): number {
  const linear = [1, 3, 5]
    .map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

async function inventoryNavigationJourney(
  page: Page,
  baseUrl: string,
): Promise<void> {
  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  const navigation = page.getByRole('navigation', {
    name: 'Release navigation',
  });
  const primaryEntries = navigation.locator('.navigation-tree > li');
  // Business modules lead compiled navigation; supporting masters share More.
  // All leaves remain reachable within the five-entry compact budget.
  await expect(primaryEntries).toHaveCount(5);
  await expect(
    primaryEntries.locator(
      ':scope > a > span:nth-child(2), :scope > details > summary > span:nth-child(2) > .nav-group-label',
    ),
  ).toHaveText(['Sales', 'Purchasing', 'Inventory', 'Party', 'More']);
  await expect(navigation.locator('a > span:nth-child(2)')).toHaveText([
    'Sales',
    'Purchasing',
    'Inventory movement',
    'Inventory period lock',
    'Inventory transaction line',
    'Inventory transaction',
    'Legal entity',
    'Posted stock',
    'Stock count line',
    'Stock count',
    'Party',
    'Party role',
    'Catalog',
    'Location',
  ]);
  const salesOwner = navigation.getByRole('link', {
    name: 'Sales',
    exact: true,
  });
  const purchasingOwner = navigation.getByRole('link', {
    name: 'Purchasing',
    exact: true,
  });
  await expect(salesOwner).toHaveAttribute(
    'href',
    /surface=northstar\.app%3Asurface\.sales_order_list/u,
  );
  await expect(purchasingOwner).toHaveAttribute(
    'href',
    /surface=northstar\.app%3Asurface\.purchase_order_list/u,
  );
  await expect(
    navigation.getByRole('link', {
      name: /Reservation|Sales order line|Shipment|Goods receipt|Purchase order line/u,
    }),
  ).toHaveCount(0);
  const reservationScope =
    await loadSurfaceScopeParameterId('reservation_list');
  await page.goto(
    scopedSurfaceUrl(
      baseUrl,
      'reservation_list',
      reservationScope,
      browserLegalEntityId,
    ),
  );
  await expect(
    page.getByRole('heading', { level: 1, name: 'Reservation' }),
  ).toBeVisible();
  await expect(salesOwner).toHaveAttribute('aria-current', 'page');
  expect(new URL(page.url()).searchParams.get(reservationScope)).toBe(
    browserLegalEntityId,
  );
  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await expect(
    navigation.getByRole('link', { name: /detail|form/i }),
  ).toHaveCount(0);
  await expect(
    primaryEntries.getByRole('group').filter({ hasText: 'Party' }),
  ).toBeVisible();
  const moreNavigation = primaryEntries
    .getByRole('group')
    .filter({ hasText: 'More' });
  await moreNavigation.getByText('More', { exact: true }).click();
  await expect(
    navigation.getByRole('link', { name: 'Catalog', exact: true }),
  ).toBeVisible();
  await expect(
    navigation.getByRole('link', { name: 'Location', exact: true }),
  ).toBeVisible();
  await moreNavigation.getByText('More', { exact: true }).click();
  const inventoryNavigation = primaryEntries
    .getByRole('group')
    .filter({ hasText: 'Inventory' });
  await expect(inventoryNavigation).toBeVisible();
  await inventoryNavigation.getByText('Inventory', { exact: true }).click();
  await expect(inventoryNavigation.locator('a > span:nth-child(2)')).toHaveText(
    [
      'Inventory movement',
      'Inventory period lock',
      'Inventory transaction line',
      'Inventory transaction',
      'Legal entity',
      'Posted stock',
      'Stock count line',
      'Stock count',
    ],
  );
  await inventoryNavigation.getByText('Inventory', { exact: true }).click();
  await expect(moreNavigation).toBeVisible();
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-platform-slot="list:title"]')).toBeVisible();
  await expect(
    page.locator('[data-platform-slot="list:dataGrid"]'),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Alpine Office Supply', exact: true }),
  ).toBeVisible();
  const responsiveList = page.locator(
    '[data-list-rendering="responsive-single"]',
  );
  const firstResponsiveRow = responsiveList
    .locator('tr[data-compact-card="true"]')
    .first();
  await expect(responsiveList).toHaveCount(1);
  await expect(firstResponsiveRow).toHaveCSS('display', 'table-row');
  const priorities = await firstResponsiveRow
    .locator('[data-column-priority]')
    .evaluateAll((cells) =>
      cells.map((cell) => Number(cell.getAttribute('data-column-priority'))),
    );
  expect(priorities).toEqual(
    [...priorities].sort((left, right) => left - right),
  );

  const bulkBar = page.locator(
    '[data-platform-slot="list:bulkActions"] [data-bulk-selection-form]',
  );
  const firstSelector = firstResponsiveRow.getByRole('checkbox');
  await expect(bulkBar.getByText('Select records to begin')).toBeVisible();
  await expect(bulkBar.getByText('Selection ready')).toBeHidden();
  await firstSelector.check();
  await expect(bulkBar.getByText('Selection ready')).toBeVisible();
  await bulkBar.getByRole('button', { name: 'Clear selection' }).click();
  await expect(firstSelector).not.toBeChecked();

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(responsiveList).toHaveCount(1);
  await expect(firstResponsiveRow).toHaveCSS('display', 'grid');
  await expect(page.locator('.sidebar')).toHaveCSS('position', 'fixed');
  await expect(page.locator('.sidebar')).toHaveCSS('bottom', '0px');
  expect(
    await navigation.getByRole('link').evaluateAll(
      (links) =>
        links.filter((link) => {
          const item = link.closest('li');
          return (
            item !== null &&
            getComputedStyle(item).display !== 'none' &&
            getComputedStyle(link).display !== 'none'
          );
        }).length,
    ),
  ).toBeLessThanOrEqual(5);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ height: 720, width: 1280 });
}

async function inventoryRecordNavigationJourney(
  page: Page,
  baseUrl: string,
): Promise<void> {
  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  const navigation = page.getByRole('navigation', {
    name: 'Release navigation',
  });
  const primaryEntries = navigation.locator('.navigation-tree > li');
  const inventoryNavigation = primaryEntries
    .getByRole('group')
    .filter({ hasText: 'Inventory' });
  const moreNavigation = primaryEntries
    .getByRole('group')
    .filter({ hasText: 'More' });
  await moreNavigation.getByText('More', { exact: true }).click();
  const purchasingNavigation = navigation.getByRole('link', {
    name: 'Purchasing',
    exact: true,
  });
  const postedStockScope = await loadSurfaceScopeParameterId(
    'posted_stock_balance_list',
  );
  const purchasingScope = await loadSurfaceScopeParameterId(
    'purchase_order_list',
  );

  await navigation.getByRole('link', { name: 'Catalog', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Item' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Field notebook', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  await moreNavigation.getByText('More', { exact: true }).click();
  await navigation.getByRole('link', { name: 'Location', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Location' }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Calgary warehouse', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  await inventoryNavigation.getByText('Inventory', { exact: true }).click();
  await inventoryNavigation
    .getByRole('link', { name: 'Posted stock', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Posted stock' }),
  ).toBeVisible();
  const company = page.getByRole('navigation', { name: 'Company' });
  await expect(company).toHaveAttribute(
    'data-scope-parameter-id',
    postedStockScope,
  );
  const defaultCompany = company.getByRole('link', {
    name: COMPOSED_APPLICATION_INVENTORY_SCOPE.entityName,
    exact: true,
  });
  const defaultCompanyHref = await defaultCompany.getAttribute('href');
  expect(defaultCompanyHref).not.toBeNull();
  expect(
    new URL(defaultCompanyHref ?? '', baseUrl).searchParams.get(
      postedStockScope,
    ),
  ).toBe(browserLegalEntityId);
  await defaultCompany.click();
  expect(new URL(page.url()).searchParams.get(postedStockScope)).toBe(
    browserLegalEntityId,
  );
  await expect(
    page.locator('[data-platform-slot="list:dataGrid"]'),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: demoItemId, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: demoLocationId, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: '5.000000000000000000', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'EA', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  const purchasingHref = await purchasingNavigation.getAttribute('href');
  expect(purchasingHref).not.toBeNull();
  expect(
    new URL(purchasingHref ?? '', baseUrl).searchParams.get(purchasingScope),
  ).toBe(browserLegalEntityId);
  await purchasingNavigation.click();
  expect(new URL(page.url()).searchParams.get(purchasingScope)).toBe(
    browserLegalEntityId,
  );
  await expect(
    page.getByRole('navigation', { name: 'Company' }).getByRole('link', {
      name: COMPOSED_APPLICATION_INVENTORY_SCOPE.entityName,
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Purchase order' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-platform-slot="list:dataGrid"]'),
  ).toBeVisible();
}

async function onHandLookupRefusalJourney(
  page: Page,
  baseUrl: string,
): Promise<void> {
  const onHandLookup = await loadOnHandLookupProjection();
  const onHandValues = new Map<string, string>([
    [onHandLookup.legalEntityParameterId, browserLegalEntityId],
    [onHandLookup.inputParameters[0]!.parameterId, demoItemId],
    [onHandLookup.inputParameters[1]!.parameterId, demoLocationId],
    [onHandLookup.inputParameters[2]!.parameterId, browserPostingInstant],
    [onHandLookup.inputParameters[3]!.parameterId, browserPostingInstant],
  ]);
  for (const missingParameterId of onHandLookup.parameterIds) {
    const missingUrl = new URL(surfaceUrl(baseUrl, 'inventory_on_hand_lookup'));
    for (const [parameterId, value] of onHandValues) {
      if (parameterId !== missingParameterId) {
        missingUrl.searchParams.set(parameterId, value);
      }
    }
    const response = await page.goto(missingUrl.href);
    expect(response?.status()).toBe(422);
    const diagnosticCode =
      missingParameterId === onHandLookup.legalEntityParameterId
        ? 'QUERY_LEGAL_ENTITY_SCOPE_REQUIRED'
        : 'QUERY_PARAMETER_REQUIRED';
    await expect(
      page.locator(`[data-diagnostic-code="${diagnosticCode}"]`),
    ).toBeVisible();
    await expect(
      page.locator('[data-platform-slot="task:scanInput"]'),
    ).toBeVisible();
    await expect(page.locator('[data-aggregate-value]')).toHaveCount(0);
  }

  const duplicateScopeUrl = new URL(
    surfaceUrl(baseUrl, 'inventory_on_hand_lookup'),
  );
  for (const [parameterId, value] of onHandValues) {
    duplicateScopeUrl.searchParams.set(parameterId, value);
  }
  duplicateScopeUrl.searchParams.append(
    onHandLookup.legalEntityParameterId,
    browserAlternateLegalEntityId,
  );
  const duplicateScopeResponse = await page.goto(duplicateScopeUrl.href);
  expect(duplicateScopeResponse?.status()).toBe(422);
  expect(
    new URL(page.url()).searchParams.getAll(
      onHandLookup.legalEntityParameterId,
    ),
  ).toEqual([browserLegalEntityId, browserAlternateLegalEntityId]);
  await expect(
    page.locator('[data-diagnostic-code="QUERY_LEGAL_ENTITY_SCOPE_REQUIRED"]'),
  ).toBeVisible();
  await expect(page.locator('[data-aggregate-value]')).toHaveCount(0);
}

async function onHandLookupJourney(page: Page, baseUrl: string): Promise<void> {
  const onHandLookup = await loadOnHandLookupProjection();
  const onHandValues = new Map<string, string>([
    [onHandLookup.legalEntityParameterId, browserLegalEntityId],
    [onHandLookup.inputParameters[0]!.parameterId, demoItemId],
    [onHandLookup.inputParameters[1]!.parameterId, demoLocationId],
    [onHandLookup.inputParameters[2]!.parameterId, browserPostingInstant],
    [onHandLookup.inputParameters[3]!.parameterId, browserPostingInstant],
  ]);

  const blankFirstDuplicateScopeUrl = new URL(
    surfaceUrl(baseUrl, 'inventory_on_hand_lookup'),
  );
  for (const [parameterId, value] of onHandValues) {
    if (parameterId !== onHandLookup.legalEntityParameterId) {
      blankFirstDuplicateScopeUrl.searchParams.set(parameterId, value);
    }
  }
  blankFirstDuplicateScopeUrl.searchParams.set(
    onHandLookup.legalEntityParameterId,
    '',
  );
  blankFirstDuplicateScopeUrl.searchParams.append(
    onHandLookup.legalEntityParameterId,
    browserLegalEntityId,
  );
  const blankFirstDuplicateScopeResponse = await page.goto(
    blankFirstDuplicateScopeUrl.href,
  );
  // A malformed scope now fails at current authorization before query
  // execution. The rendered denial is still a non-data page and retains the
  // caller's URL so the exact spoof attempt remains observable.
  expect(blankFirstDuplicateScopeResponse?.status()).toBe(200);
  expect(
    new URL(page.url()).searchParams.getAll(
      onHandLookup.legalEntityParameterId,
    ),
  ).toEqual(['', browserLegalEntityId]);
  await expect(
    page.locator('[data-diagnostic-code="QUERY_PERMISSION_DENIED"]'),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Company' })
      .locator('[aria-current="true"]'),
  ).toHaveCount(0);
  await expect(
    page
      .locator('[data-platform-slot="task:scanInput"] form')
      .locator(`input[name="${onHandLookup.legalEntityParameterId}"]`),
  ).toHaveCount(0);
  await expect(page.locator('[data-aggregate-value]')).toHaveCount(0);

  await page.goto(surfaceUrl(baseUrl, 'inventory_on_hand_lookup'));
  await expect(
    page.getByRole('heading', { level: 1, name: onHandLookup.label }),
  ).toBeVisible();
  const taskPageHeading = page.locator(
    '#surface-content > header.surface-heading',
  );
  await expect(taskPageHeading.locator(':scope > *')).toHaveText([
    onHandLookup.label,
    onHandLookup.statusRoles.join(''),
  ]);
  await expect(taskPageHeading).toHaveText(
    [onHandLookup.label, onHandLookup.statusRoles.join('')].join(' '),
  );
  await expect(taskPageHeading.locator('[data-status-role]')).toHaveText(
    onHandLookup.statusRoles,
  );
  await expect(taskPageHeading).not.toContainText(
    `${onHandLookup.archetype} surface`,
  );
  await expect(page.locator('#surface-content')).not.toContainText(
    onHandLookup.surfaceId,
  );
  await page
    .getByRole('navigation', { name: 'Company' })
    .getByRole('link', {
      name: COMPOSED_APPLICATION_INVENTORY_SCOPE.entityCode,
    })
    .click();
  expect(
    new URL(page.url()).searchParams.get(onHandLookup.legalEntityParameterId),
  ).toBe(browserLegalEntityId);
  const onHandForm = page.locator('[data-platform-slot="task:scanInput"] form');
  await expect(
    page.locator('[data-platform-slot="task:decision"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-platform-slot="task:primaryAction"]'),
  ).toBeVisible();
  expect(
    await onHandForm
      .locator('input[name]')
      .evaluateAll((inputs) =>
        inputs
          .map((input) => input.getAttribute('name'))
          .filter(
            (name): name is string => name !== null && name !== 'surface',
          ),
      ),
  ).toEqual(onHandLookup.parameterIds);
  await expect(
    page.getByRole('navigation', { name: 'Company' }),
  ).toHaveAttribute(
    'data-scope-parameter-id',
    onHandLookup.legalEntityParameterId,
  );
  for (const parameter of onHandLookup.inputParameters) {
    await onHandForm
      .locator(`input[name="${parameter.parameterId}"]`)
      .fill(onHandValues.get(parameter.parameterId) ?? '');
  }
  await page.getByRole('button', { name: 'Look up' }).click();
  const balance = page.getByRole('status', { name: 'Lookup result' });
  await expect(balance).toHaveText('5');
  await expect(balance).toHaveAttribute('data-aggregate-value', '5');

  await page
    .getByRole('navigation', { name: 'Company' })
    .getByRole('link', { name: browserAlternateInventoryScope.entityCode })
    .click();
  await expect(balance).toHaveText('0');
  expect(
    new URL(page.url()).searchParams.get(onHandLookup.legalEntityParameterId),
  ).toBe(browserAlternateLegalEntityId);
  for (const parameter of onHandLookup.inputParameters) {
    expect(new URL(page.url()).searchParams.get(parameter.parameterId)).toBe(
      onHandValues.get(parameter.parameterId),
    );
  }
  await page
    .getByRole('navigation', { name: 'Company' })
    .getByRole('link', {
      name: COMPOSED_APPLICATION_INVENTORY_SCOPE.entityCode,
    })
    .click();
  await expect(balance).toHaveText('5');
}

async function scopedInventoryListJourney(
  page: Page,
  baseUrl: string,
): Promise<void> {
  const inventoryScopeParameters = {
    movementDetail: await loadSurfaceScopeParameterId(
      'inventory_movement_detail',
    ),
    movementList: await loadSurfaceScopeParameterId('inventory_movement_list'),
    transactionDetail: await loadSurfaceScopeParameterId(
      'inventory_transaction_detail',
    ),
    transactionForm: await loadSurfaceScopeParameterId(
      'inventory_transaction_form',
    ),
    transactionList: await loadSurfaceScopeParameterId(
      'inventory_transaction_list',
    ),
  } as const;
  const unscopedMovementUrl = surfaceUrl(baseUrl, 'inventory_movement_list');
  const unscopedMovementResponse = await page.goto(unscopedMovementUrl);
  expect(unscopedMovementResponse?.status()).toBe(422);
  await expect(
    page.locator('[data-diagnostic-code="QUERY_LEGAL_ENTITY_SCOPE_REQUIRED"]'),
  ).toBeVisible();
  const legalEntityPicker = page.getByRole('navigation', {
    name: 'Company',
  });
  await expect(legalEntityPicker).toBeVisible();
  await expect(legalEntityPicker).toHaveAttribute(
    'data-scope-parameter-id',
    inventoryScopeParameters.movementList,
  );
  await expect(legalEntityPicker.locator('[aria-current="true"]')).toHaveCount(
    0,
  );
  const defaultLegalEntity = legalEntityPicker.getByRole('link', {
    name: COMPOSED_APPLICATION_INVENTORY_SCOPE.entityCode,
  });
  const defaultLegalEntityHref = await defaultLegalEntity.getAttribute('href');
  expect(defaultLegalEntityHref).not.toBeNull();
  expect(
    new URL(defaultLegalEntityHref ?? '', baseUrl).searchParams.get(
      inventoryScopeParameters.movementList,
    ),
  ).toBe(browserLegalEntityId);
  await page.setViewportSize({ height: 844, width: 390 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ height: 720, width: 1280 });
  await defaultLegalEntity.click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Inventory movement' }),
  ).toBeVisible();
  let movementRow = page.locator('tr', {
    hasText: 'browser-posted-adjustment',
  });
  await expect(movementRow).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Company' })
    .getByRole('link', { name: browserAlternateInventoryScope.entityCode })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Inventory movement' }),
  ).toBeVisible();
  await expect(movementRow).toHaveCount(0);
  expect(
    new URL(page.url()).searchParams.get(inventoryScopeParameters.movementList),
  ).toBe(browserAlternateLegalEntityId);
  await page
    .getByRole('navigation', { name: 'Company' })
    .getByRole('link', {
      name: COMPOSED_APPLICATION_INVENTORY_SCOPE.entityCode,
    })
    .click();
  movementRow = page.locator('tr', { hasText: 'browser-posted-adjustment' });
  await expect(movementRow).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'New', exact: true }),
  ).toHaveCount(0);
}

async function scopedInventoryJourney(
  page: Page,
  baseUrl: string,
): Promise<void> {
  const inventoryScopeParameters = {
    movementDetail: await loadSurfaceScopeParameterId(
      'inventory_movement_detail',
    ),
    movementList: await loadSurfaceScopeParameterId('inventory_movement_list'),
    transactionDetail: await loadSurfaceScopeParameterId(
      'inventory_transaction_detail',
    ),
    transactionForm: await loadSurfaceScopeParameterId(
      'inventory_transaction_form',
    ),
    transactionList: await loadSurfaceScopeParameterId(
      'inventory_transaction_list',
    ),
  } as const;
  await page.goto(
    scopedSurfaceUrl(
      baseUrl,
      'inventory_movement_list',
      inventoryScopeParameters.movementList,
      browserLegalEntityId,
    ),
  );
  const movementRow = page.locator('tr', {
    hasText: 'browser-posted-adjustment',
  });
  await expect(movementRow).toBeVisible();
  await movementRow.getByRole('link').click();
  expect(
    new URL(page.url()).searchParams.get(
      inventoryScopeParameters.movementDetail,
    ),
  ).toBe(browserLegalEntityId);
  await expect(
    page.getByRole('heading', { level: 1, name: 'browser-posted-adjustment' }),
  ).toBeVisible();
  await expect(page.locator('form.capability-command')).toHaveCount(0);

  const scopedInventoryNavigation = page
    .getByRole('navigation', { name: 'Release navigation' })
    .locator('.navigation-tree > li')
    .getByRole('group')
    .filter({ hasText: 'Inventory' });
  await scopedInventoryNavigation
    .getByText('Inventory', { exact: true })
    .click();
  await scopedInventoryNavigation
    .getByRole('link', { name: 'Inventory transaction', exact: true })
    .click();
  expect(
    new URL(page.url()).searchParams.get(
      inventoryScopeParameters.transactionList,
    ),
  ).toBe(browserLegalEntityId);
  const transactionRow = page.locator('tr', { hasText: 'ADJ-BROWSER-001' });
  await expect(transactionRow).toBeVisible();
  // ALSO INVERTED BY ADR-0054, and this one was not obvious from the diff.
  //
  // This asserted the Inventory transaction list offers no `New` link. That was
  // never a statement that transactions are read-only -- the module authors a
  // form for them, so they are declared writable. `renderListTitle` renders
  // `New` only through `relatedSurface(context, 'form')`, which returns the form
  // ONLY if it supports create or update; the broken anatomy made that false, so
  // the affordance vanished and the suite recorded its absence as intended.
  //
  // The declared intent is now honoured: the link exists and points at the form.
  const newTransaction = page.getByRole('link', { name: 'New', exact: true });
  await expect(newTransaction).toHaveCount(1);
  await expect(newTransaction).toHaveAttribute(
    'href',
    new RegExp(encodeURIComponent('surface.inventory_transaction_form')),
  );
  await transactionRow.getByRole('link').click();
  expect(new URL(page.url()).searchParams.get('record')).toBe(
    browserTransactionId,
  );
  await expect(
    page.locator('main code', {
      hasText: `${browserTransactionId.slice(0, 8)}…${browserTransactionId.slice(-4)}`,
    }),
  ).toBeVisible();
  await expect(page.locator('form.capability-command')).toHaveCount(0);
  // THE THIRD INVERSION, and it is the one ADR-0054 predicted rather than found.
  //
  // Archive and Restore were absent here for the same single reason as the `New`
  // link: `surfaceSupportsRuntimeIntent`'s `record` branch grants a lifecycle
  // intent only when a RELATED FORM supports create or update, so a visibly
  // inert entity cannot be mutated by posting around its release-defined UI.
  // Repairing the form is therefore what re-admits lifecycle control on the
  // paired detail surface -- one line in the module, three affordances restored.
  //
  // The grammar's placement is asserted with them: destructive actions live
  // behind the overflow and are never a lone exposed control.
  const lifecycleOverflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  const transactionArchive = page.getByRole('button', { name: 'Archive' });
  await expect(lifecycleOverflow).toBeVisible();
  await expect(transactionArchive).toBeHidden();
  await lifecycleOverflow.locator('summary').click();
  await expect(transactionArchive).toBeVisible();
  const inventoryTransactionDetailUrl = `${scopedSurfaceUrl(
    baseUrl,
    'inventory_transaction_detail',
    inventoryScopeParameters.transactionDetail,
    browserLegalEntityId,
  )}&record=${encodeURIComponent(browserTransactionId)}`;
  for (const [intent, idempotencyKey] of [
    ['archive', '74000000-0000-4000-8000-000000000007'],
    ['restore', '74000000-0000-4000-8000-000000000008'],
  ] as const) {
    const refusedLifecycleWrite = await page.request.post(
      inventoryTransactionDetailUrl,
      {
        form: {
          expectedRevision: '2',
          idempotencyKey,
          intent,
          recordId: browserTransactionId,
        },
      },
    );
    expect(refusedLifecycleWrite.status()).toBe(422);
    expect(await refusedLifecycleWrite.text()).toContain(
      'OPERATION_UNSUPPORTED',
    );
  }
  await page.goto(inventoryTransactionDetailUrl);
  await expect(
    page.locator('main code', {
      hasText: `${browserTransactionId.slice(0, 8)}…${browserTransactionId.slice(-4)}`,
    }),
  ).toBeVisible();
  const inventoryTransactionFormUrl = scopedSurfaceUrl(
    baseUrl,
    'inventory_transaction_form',
    inventoryScopeParameters.transactionForm,
    browserLegalEntityId,
  );
  // ADR-0054 INVERTS THIS BLOCK, and the inversion is the point.
  //
  // Until 2026-08-17 this asserted the scoped Inventory create form was inert:
  // an UNSUPPORTED_COMPONENT alert, zero textboxes, zero buttons, and a forged
  // write refused 422 OPERATION_UNSUPPORTED. Every one of those was TRUE and
  // every one of them was a contract on a defect -- the form declared a
  // `record:activity` slot the registry renders nowhere, so the whole surface
  // refused before a field could exist.
  //
  // Each assertion's MEANING is preserved by being turned over, not deleted:
  // the surface that could not render now renders, the slot that produced the
  // diagnostic is gone, the absent controls are present, and the write that was
  // refused at COMPOSITION is now admitted that far and judged on its content.
  await page.goto(inventoryTransactionFormUrl);
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { level: 1, name: 'New Inventory transaction' }),
  ).toBeVisible();
  await expect(page.getByRole('textbox').first()).toBeVisible();
  await expect(
    page
      .locator('[data-platform-slot="record:commandBar"]')
      .getByRole('button', {
        name: 'Save',
      }),
  ).toBeVisible();
  // The forged write is kept verbatim and still refuses 422
  // OPERATION_UNSUPPORTED.
  //
  // MEASURED 2026-08-17, and recorded because it corrects what this line was
  // believed to prove: this assertion never discriminated the anatomy defect.
  // The payload carries `intent` and no `operationId`, and ADR-0051 made the
  // write path OPERATION-addressed, so it is refused for being unaddressed no
  // matter what the surface declares. It was green before the repair and is
  // green after it, for a reason that has nothing to do with slots.
  //
  // It is kept because refusing an unaddressed write is worth asserting on its
  // own terms. It is NOT evidence about anatomy, and the discriminating write
  // below is what carries that claim.
  const forgedWrite = await page.request.post(inventoryTransactionFormUrl, {
    form: {
      idempotencyKey: '74000000-0000-4000-8000-000000000005',
      intent: 'create',
      recordId: '74000000-0000-4000-8000-000000000006',
    },
  });
  expect(forgedWrite.status()).toBe(422);
  expect(await forgedWrite.text()).toContain('OPERATION_UNSUPPORTED');
}

/**
 * ADR-0054's control: the five repaired Inventory form surfaces render.
 *
 * This is the observation the packet exists to produce, and it is deliberately
 * NOT "no longer UNSUPPORTED_COMPONENT". A surface can lose that diagnostic and
 * still be useless, so each surface must show the five grammar slots, at least
 * one real input control, and a save control that targets the form.
 *
 * `party_form` is the untouched twin: it was already conformant before this
 * packet and is asserted through the identical helper, so a regression in the
 * helper itself cannot read as an Inventory repair.
 */
const repairedInventoryForms = [
  'inventory_transaction_form',
  'inventory_transaction_line_form',
  'stock_count_form',
  'stock_count_line_form',
] as const;

async function expectRenderedRecordForm(
  page: Page,
  heading: string,
): Promise<void> {
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);
  for (const slot of [
    'record:breadcrumb',
    'record:titleStatus',
    'record:commandBar',
    'record:keyFacts',
    'record:sections',
  ]) {
    await expect(page.locator(`[data-platform-slot="${slot}"]`)).toHaveCount(1);
  }
  await expect(
    page.getByRole('heading', { level: 1, name: heading }),
  ).toBeVisible();
  await expect(
    page.locator('[data-platform-slot="record:keyFacts"]'),
  ).toContainText('New record');
  // A real create form, not an empty panel: the posting form exists, carries
  // field controls, and has a save control bound to it by id.
  const form = page.locator('form#surface-record-form');
  await expect(form).toHaveCount(1);
  expect(await form.locator('.form-field').count()).toBeGreaterThan(0);
  expect(await form.locator('input, select').count()).toBeGreaterThan(0);
  await expect(
    page
      .locator('[data-platform-slot="record:commandBar"]')
      .getByRole('button', { name: 'Save' }),
  ).toHaveAttribute('form', 'surface-record-form');
}

async function repairedFormAnatomyJourney(
  page: Page,
  baseUrl: string,
): Promise<void> {
  for (const localSurface of repairedInventoryForms) {
    const url = scopedSurfaceUrl(
      baseUrl,
      localSurface,
      await loadSurfaceScopeParameterId(localSurface),
      browserLegalEntityId,
    );
    await page.goto(url);
    await expectRenderedRecordForm(
      page,
      `New ${inventoryFormHeadings[localSurface]}`,
    );
  }

  // `legal_entity_form` is unscoped and was in the broken set too -- the
  // platform's own legal-entity form could not render, which is its own quiet
  // problem and is closed by the same one-line change.
  await page.goto(surfaceUrl(baseUrl, 'legal_entity_form'));
  await expectRenderedRecordForm(page, 'New Legal entity');
  await page.getByLabel('Code', { exact: true }).fill('LE-ANAT-1');
  await page.getByLabel('Name', { exact: true }).fill('Anatomy Legal Entity');
  await page
    .getByRole('combobox', { exact: true, name: 'Status' })
    .selectOption({ label: 'active' });
  await page
    .getByRole('combobox', { exact: true, name: 'Is default' })
    .selectOption({ label: 'No' });
  await page
    .locator('[data-platform-slot="record:commandBar"]')
    .getByRole('button', { name: 'Save' })
    .click();
  // THE PACKET'S CLAIM, END TO END. A surface that could not render at all now
  // takes an operator's input and persists a record through the real provider.
  // `legal_entity_form` is the specimen because it is the one repaired surface
  // with NO required relation and NO legal-entity system input, so the anatomy
  // is the only thing that ever stood between the operator and the record.
  await expect(page.getByRole('status')).toContainText('Create complete');
  await expect(page.locator('[data-diagnostic-code]')).toHaveCount(0);

  // The untouched twin, through the same helper.
  await page.goto(surfaceUrl(baseUrl, 'party_form'));
  await expectRenderedRecordForm(page, 'New Party');
}

async function scopedFormPersistenceJourney(
  page: Page,
  baseUrl: string,
): Promise<void> {
  const scopeParameterId = await loadSurfaceScopeParameterId(
    'inventory_transaction_form',
  );
  const listScopeParameterId = await loadSurfaceScopeParameterId(
    'inventory_transaction_list',
  );
  await createScopedInventoryTransaction(
    page,
    baseUrl,
    scopeParameterId,
    browserLegalEntityId,
    'TXN-SCOPE-A',
  );
  await createScopedInventoryTransaction(
    page,
    baseUrl,
    scopeParameterId,
    browserAlternateLegalEntityId,
    'TXN-SCOPE-B',
  );

  // The read side independently observes the persisted attribution. A
  // hardcoded first UUID can make one create green; it cannot put the second
  // record into the second entity's sealed read scope while keeping the two
  // lists disjoint.
  await expectScopedInventoryTransactions(
    page,
    baseUrl,
    listScopeParameterId,
    browserLegalEntityId,
    'TXN-SCOPE-A',
    'TXN-SCOPE-B',
  );
  await expectScopedInventoryTransactions(
    page,
    baseUrl,
    listScopeParameterId,
    browserAlternateLegalEntityId,
    'TXN-SCOPE-B',
    'TXN-SCOPE-A',
  );

  // The hardest current specimen: stock_count_line has TWO required relations,
  // both targeting legal-entity-scoped lists. Create its parent through one
  // scoped picker, then create the line through both scoped pickers.
  await createScopedStockCountLineWithRelations(page, baseUrl);

  const multipleScopeUrl = new URL(
    scopedSurfaceUrl(
      baseUrl,
      'inventory_transaction_form',
      scopeParameterId,
      browserLegalEntityId,
    ),
  );
  multipleScopeUrl.searchParams.append(
    scopeParameterId,
    browserAlternateLegalEntityId,
  );
  await expectScopedInventoryCreateRefusal(
    page,
    baseUrl,
    scopeParameterId,
    multipleScopeUrl.href,
    'TXN-SCOPE-MULTIPLE',
    'OPERATION_INPUT_INVALID',
  );
  await expectScopedInventoryCreateRefusal(
    page,
    baseUrl,
    scopeParameterId,
    surfaceUrl(baseUrl, 'inventory_transaction_form'),
    'TXN-SCOPE-OMITTED',
    'OPERATION_INPUT_INVALID',
  );
  await expectScopedInventoryCreateRefusal(
    page,
    baseUrl,
    scopeParameterId,
    scopedSurfaceUrl(
      baseUrl,
      'inventory_transaction_form',
      scopeParameterId,
      'not-a-uuid',
    ),
    'TXN-SCOPE-MALFORMED',
    // The authorization boundary refuses malformed scope before it can reach
    // provider input parsing; it must never inherit the demo role's ALLOW.
    'OPERATION_PERMISSION_DENIED',
  );
}

async function createScopedStockCountLineWithRelations(
  page: Page,
  baseUrl: string,
): Promise<void> {
  const stockCountScopeParameterId =
    await loadSurfaceScopeParameterId('stock_count_form');
  await page.goto(
    scopedSurfaceUrl(
      baseUrl,
      'stock_count_form',
      stockCountScopeParameterId,
      browserLegalEntityId,
    ),
  );
  const transactionPicker = page.getByRole('combobox', {
    exact: true,
    name: 'Transaction',
  });
  await expect(transactionPicker).toBeVisible();
  await expect(
    transactionPicker.locator('option', { hasText: 'TXN-SCOPE-A' }),
  ).toHaveCount(1);
  await expect(
    transactionPicker.locator('option', { hasText: 'TXN-SCOPE-B' }),
  ).toHaveCount(0);
  await transactionPicker.selectOption({ label: 'TXN-SCOPE-A' });
  await page.getByLabel('Number', { exact: true }).fill('COUNT-SCOPE-A');
  await page
    .getByRole('combobox', { exact: true, name: 'Kind' })
    .selectOption({ label: 'initial' });
  await page
    .getByRole('combobox', { exact: true, name: 'State' })
    .selectOption({ label: 'draft' });
  await page.getByLabel('Location', { exact: true }).fill(demoLocationId);
  await page
    .getByLabel('Counted at', { exact: true })
    .fill('2026-07-30T12:00:00.000Z');
  const stockCountId = await page
    .locator('form#surface-record-form input[name="recordId"]')
    .inputValue();
  await page
    .locator('[data-platform-slot="record:commandBar"]')
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(page.getByRole('status')).toContainText('Create complete');
  await expect(page.locator('[data-diagnostic-code]')).toHaveCount(0);
  await expect(page.locator('[data-relation-freeze]')).toContainText(
    'Transaction',
  );

  const stockCountLineScopeParameterId = await loadSurfaceScopeParameterId(
    'stock_count_line_form',
  );
  await page.goto(
    scopedSurfaceUrl(
      baseUrl,
      'stock_count_line_form',
      stockCountLineScopeParameterId,
      browserLegalEntityId,
    ),
  );
  const sessionPicker = page.getByRole('combobox', {
    exact: true,
    name: 'Session',
  });
  const transactionLinePicker = page.getByRole('combobox', {
    exact: true,
    name: 'Transaction line',
  });
  await expect(sessionPicker).toBeVisible();
  await expect(transactionLinePicker).toBeVisible();
  await sessionPicker.selectOption(stockCountId);
  await expect(
    transactionLinePicker.locator(
      `option[value="${browserTransactionLineId}"]`,
    ),
  ).toHaveCount(1);
  await transactionLinePicker.selectOption(browserTransactionLineId);
  await page.getByLabel('Line number', { exact: true }).fill('1');
  await page.getByLabel('Item', { exact: true }).fill(demoItemId);
  await page.getByLabel('Expected quantity', { exact: true }).fill('5');
  await page.getByLabel('Counted quantity', { exact: true }).fill('5');
  await page.getByLabel('Variance quantity', { exact: true }).fill('0');
  await page.getByLabel('Unit', { exact: true }).fill('EA');
  await page
    .locator('[data-platform-slot="record:commandBar"]')
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(page.getByRole('status')).toContainText('Create complete');
  await expect(page.locator('[data-diagnostic-code]')).toHaveCount(0);
  const frozenRelations = page.locator('[data-relation-freeze]');
  await expect(
    frozenRelations.getByRole('heading', { name: 'Locked after creation' }),
  ).toBeVisible();
  await expect(frozenRelations).toContainText('Session');
  await expect(frozenRelations).toContainText('Transaction line');
  await expect(frozenRelations).not.toContainText('Stock Count Line Session');
  await expect(frozenRelations).toContainText('cannot be changed later');
  await expect(sessionPicker).toHaveCount(0);
  await expect(transactionLinePicker).toHaveCount(0);
}

async function fillInventoryTransactionForm(
  page: Page,
  transactionNumber: string,
): Promise<void> {
  await page.getByLabel('Number', { exact: true }).fill(transactionNumber);
  // Six declared transaction types now cross the grammar's five-option
  // select threshold; the datalist input submits the canonical option id.
  await page
    .getByRole('combobox', { exact: true, name: 'Type' })
    .fill(
      `${applicationNamespace}:option.inventory_transaction_type_adjustment`,
    );
  await page
    .getByRole('combobox', { exact: true, name: 'State' })
    .selectOption({ label: 'draft' });
  await page.getByLabel('Source type', { exact: true }).fill('browser');
  await page
    .getByLabel('Source', { exact: true })
    .fill(transactionNumber.toLowerCase());
  await page
    .getByLabel('Effective at', { exact: true })
    .fill('2026-07-30T12:00:00.000Z');
  await page
    .getByLabel('Recorded at', { exact: true })
    .fill('2026-07-30T12:00:00.000Z');
  await page.getByLabel('Actor', { exact: true }).fill('anatomy-actor');
}

async function createScopedInventoryTransaction(
  page: Page,
  baseUrl: string,
  scopeParameterId: string,
  legalEntityId: string,
  transactionNumber: string,
): Promise<void> {
  await page.goto(
    scopedSurfaceUrl(
      baseUrl,
      'inventory_transaction_form',
      scopeParameterId,
      legalEntityId,
    ),
  );
  await fillInventoryTransactionForm(page, transactionNumber);
  await expect(page.locator('form#surface-record-form')).toHaveAttribute(
    'action',
    new RegExp(
      `${encodeURIComponent(scopeParameterId)}=${encodeURIComponent(legalEntityId)}`,
    ),
  );
  await page
    .locator('[data-platform-slot="record:commandBar"]')
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(page.getByRole('status')).toContainText('Create complete');
  await expect(page.locator('[data-diagnostic-code]')).toHaveCount(0);
}

async function expectScopedInventoryTransactions(
  page: Page,
  baseUrl: string,
  scopeParameterId: string,
  legalEntityId: string,
  visibleNumber: string,
  hiddenNumber: string,
): Promise<void> {
  await page.goto(
    scopedSurfaceUrl(
      baseUrl,
      'inventory_transaction_list',
      scopeParameterId,
      legalEntityId,
    ),
  );
  await expect(
    page.getByRole('cell', { name: visibleNumber, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(hiddenNumber, { exact: true })).toHaveCount(0);
}

async function expectScopedInventoryCreateRefusal(
  page: Page,
  baseUrl: string,
  scopeParameterId: string,
  action: string,
  transactionNumber: string,
  diagnosticCode:
    | 'OPERATION_INPUT_INVALID'
    | 'OPERATION_PERMISSION_DENIED'
    | 'OPERATION_REFUSED',
  refusalCode?: string,
): Promise<void> {
  await page.goto(
    scopedSurfaceUrl(
      baseUrl,
      'inventory_transaction_form',
      scopeParameterId,
      browserLegalEntityId,
    ),
  );
  await fillInventoryTransactionForm(page, transactionNumber);
  await page
    .locator('form#surface-record-form')
    .evaluate(
      (form, nextAction) => form.setAttribute('action', nextAction),
      action,
    );
  await page
    .locator('[data-platform-slot="record:commandBar"]')
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(
    page.locator(`[data-diagnostic-code="${diagnosticCode}"]`),
  ).toHaveCount(1);
  if (refusalCode !== undefined) {
    await expect(page.locator('[data-message-subject]')).toHaveText(
      refusalCode,
    );
  }
}

const inventoryFormHeadings = Object.freeze({
  inventory_transaction_form: 'Inventory transaction',
  inventory_transaction_line_form: 'Inventory transaction line',
  stock_count_form: 'Stock count',
  stock_count_line_form: 'Stock count line',
});

async function postingRouteDraftJourney(
  page: Page,
  baseUrl: string,
): Promise<void> {
  const scopeParameterId = await loadSurfaceScopeParameterId(
    'inventory_transaction_detail',
  );
  const detailUrl = `${scopedSurfaceUrl(
    baseUrl,
    'inventory_transaction_detail',
    scopeParameterId,
    browserLegalEntityId,
  )}&record=${encodeURIComponent(browserRouteTransactionId)}`;
  await expectRoutePostingEffect(page, baseUrl, 0, '5');
  await page.goto(detailUrl);
  const edit = page.getByRole('link', { name: 'Edit', exact: true });
  await expect(edit).toHaveCount(1);
  const editHref = await edit.getAttribute('href');
  expect(editHref).not.toBeNull();
  await page.goto(new URL(editHref ?? '', baseUrl).href);
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Edit Inventory transaction',
    }),
  ).toBeVisible();
  const form = page.locator('form#surface-record-form');
  await expect(form).toHaveCount(1);
  const updateSubmission = await form.evaluate((recordForm) =>
    Object.fromEntries(
      [...new FormData(recordForm as HTMLFormElement).entries()].map(
        ([name, value]) => [name, String(value)],
      ),
    ),
  );
  expect(updateSubmission.operationId).toBe(
    `${applicationNamespace}:operation.inventory_transaction_update`,
  );
  expect(
    updateSubmission[
      `value:${applicationNamespace}:field.inventory_transaction_state`
    ],
  ).toBe(`${applicationNamespace}:option.inventory_transaction_state_draft`);
}

async function postingRouteJourney(page: Page, baseUrl: string): Promise<void> {
  const scopeParameterId = await loadSurfaceScopeParameterId(
    'inventory_transaction_detail',
  );
  const detailUrl = `${scopedSurfaceUrl(
    baseUrl,
    'inventory_transaction_detail',
    scopeParameterId,
    browserLegalEntityId,
  )}&record=${encodeURIComponent(browserRouteTransactionId)}`;
  await page.goto(detailUrl);
  await expect(page.getByText(/Active · revision 1/)).toBeVisible();
  const edit = page.getByRole('link', { name: 'Edit', exact: true });
  await expect(edit).toHaveCount(1);
  const editHref = await edit.getAttribute('href');
  expect(editHref).not.toBeNull();
  const editUrl = new URL(editHref ?? '', baseUrl).href;
  const editPage = await page.context().newPage();
  let updateSubmission: Record<string, string>;
  try {
    await editPage.goto(editUrl);
    await expect(
      editPage.getByRole('heading', {
        level: 1,
        name: 'Edit Inventory transaction',
      }),
    ).toBeVisible();
    await expect(editPage.locator('form#surface-record-form')).toHaveCount(1);
    await expect(
      editPage
        .locator('[data-platform-slot="record:commandBar"]')
        .getByRole('button', { name: 'Save' }),
    ).toBeVisible();
    updateSubmission = await editPage
      .locator('form#surface-record-form')
      .evaluate((form) =>
        Object.fromEntries(
          [...new FormData(form as HTMLFormElement).entries()].map(
            ([name, value]) => [name, String(value)],
          ),
        ),
      );
  } finally {
    await editPage.close();
  }
  expect(updateSubmission.operationId).toBe(
    `${applicationNamespace}:operation.inventory_transaction_update`,
  );
  expect(
    updateSubmission[
      `value:${applicationNamespace}:field.inventory_transaction_state`
    ],
  ).toBe(`${applicationNamespace}:option.inventory_transaction_state_draft`);
  const command = page.locator('form.capability-command');
  await expect(command).toHaveAttribute(
    'data-capability-id',
    INVENTORY_POSTING_CAPABILITY_ID,
  );
  await expect(command).toContainText('Draft staged.');
  const renderedIdempotencyKey = await command
    .locator('input[name="idempotencyKey"]')
    .inputValue();
  await command.getByRole('button', { name: 'Post' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Confirm Post' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-predicted-effects="registered-capability"]'),
  ).toContainText(INVENTORY_POSTING_CAPABILITY_ID);
  await expect(page.locator('input[name="idempotencyKey"]')).toHaveValue(
    renderedIdempotencyKey,
  );
  const preservedSubmission = Object.fromEntries(
    await page
      .locator('form input[type="hidden"]')
      .evaluateAll((inputs) =>
        inputs.map((input) => [
          input.getAttribute('name') ?? '',
          (input as HTMLInputElement).value,
        ]),
      ),
  );

  const beforeConfirmation = await page.context().newPage();
  try {
    await beforeConfirmation.goto(detailUrl);
    await expect(
      beforeConfirmation.getByText(/Active · revision 1/),
    ).toBeVisible();
    await expect(
      beforeConfirmation.locator('form.capability-command'),
    ).toBeVisible();
  } finally {
    await beforeConfirmation.close();
  }

  await page.getByRole('button', { name: 'Confirm Post' }).click();
  await expect(page.getByRole('status')).toContainText('Post complete');
  await expect(page.getByText(/Active · revision 2/)).toBeVisible();
  await expect(page.locator('form.capability-command')).toHaveCount(0);
  await expect(edit).toHaveCount(0);

  const replay = await page.request.post(
    `${baseUrl}/?surface=${encodeURIComponent(`${applicationNamespace}:surface.inventory_transaction_detail`)}`,
    { form: preservedSubmission },
  );
  expect(replay.status()).toBe(200);
  const replayHtml = await replay.text();
  expect(replayHtml).toContain('Post complete');
  expect(replayHtml).toContain('Active · revision 2');

  // The direct URL is a second UI boundary. Hiding Edit alone leaves a pasted
  // form URL, its Save button and implicit Enter submission live.
  await page.goto(editUrl);
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Edit Inventory transaction',
    }),
  ).toBeVisible();
  await expect(page.locator('form#surface-record-form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);

  // The provider is the authority even when a caller posts around both UI
  // affordances. This is the actual operation-addressed update form captured
  // while the transaction was a draft, not a structurally invalid forgery.
  // Only revision, idempotency and state change after posting.
  const refusedRewind = await page.request.post(editUrl, {
    form: {
      ...updateSubmission,
      expectedRevision: '2',
      idempotencyKey: '74200000-0000-4000-8000-000000000003',
      [`value:${applicationNamespace}:field.inventory_transaction_state`]: `${applicationNamespace}:option.inventory_transaction_state_draft`,
    },
  });
  expect(refusedRewind.status()).toBe(422);
  const refusedRewindHtml = await refusedRewind.text();
  expect(refusedRewindHtml).toContain('OPERATION_REFUSED');
  expect(refusedRewindHtml).toContain('MODULE_OPERATION_PRECONDITION_REFUSED');
  expect(refusedRewindHtml).not.toContain('OPERATION_UNAVAILABLE');

  // One source effect remains one movement and one +3 on-hand delta. A rewind
  // followed by a second post would make these 2 and 11 respectively because
  // movement replay identity includes the source revision.
  await expectRoutePostingEffect(page, baseUrl, 1, '8');
  await page.goto(detailUrl);
  await expect(page.getByText(/Active · revision 2/)).toBeVisible();
  await expect(page.locator('form.capability-command')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Edit', exact: true }),
  ).toHaveCount(0);
}

async function expectRoutePostingEffect(
  page: Page,
  baseUrl: string,
  expectedMovementRows: number,
  expectedOnHand: string,
): Promise<void> {
  const movementUrl = scopedSurfaceUrl(
    baseUrl,
    'inventory_movement_list',
    await loadSurfaceScopeParameterId('inventory_movement_list'),
    browserLegalEntityId,
  );
  await page.goto(movementUrl);
  await expect(
    page.locator('tbody tr', { hasText: 'browser-posting-route' }),
  ).toHaveCount(expectedMovementRows);

  const onHand = await loadOnHandLookupProjection();
  const onHandUrl = new URL(surfaceUrl(baseUrl, 'inventory_on_hand_lookup'));
  const horizon = '2099-01-01T00:00:00.000Z';
  const values = [demoItemId, demoLocationId, horizon, horizon];
  onHandUrl.searchParams.set(
    onHand.legalEntityParameterId,
    browserLegalEntityId,
  );
  for (const [index, parameter] of onHand.inputParameters.entries()) {
    onHandUrl.searchParams.set(parameter.parameterId, values[index]!);
  }
  await page.goto(onHandUrl.href);
  await expect(
    page.getByRole('status', { name: 'Lookup result' }),
  ).toHaveAttribute('data-aggregate-value', expectedOnHand);
}

async function partyLifecycleJourney(
  page: Page,
  baseUrl: string,
): Promise<void> {
  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'New Party' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-platform-slot="record:keyFacts"]'),
  ).toContainText('New record');
  await expect(
    page.locator('[data-platform-slot="record:sections"]'),
  ).toBeVisible();
  await page.getByLabel('Number', { exact: true }).fill('P-BROWSER-REAL-001');
  await page
    .getByLabel('Name', { exact: true })
    .fill('Browser-persisted Party');
  await page
    .getByLabel('Contact summary', { exact: true })
    .fill('browser-persisted@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Create complete');
  await expect(
    page.locator('[data-diagnostic-code="UNSUPPORTED_COMPONENT"]'),
  ).toHaveCount(0);

  await page.goto(surfaceUrl(baseUrl, 'party_list'));
  await page.reload();
  await expect(
    page.getByRole('cell', {
      name: 'Browser-persisted Party',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'P-BROWSER-REAL-001', exact: true }),
  ).toBeVisible();
  const createdRow = page.locator('tr', { hasText: 'Browser-persisted Party' });
  const createdRecordId = await createdRow.getAttribute('data-record-id');
  expect(createdRecordId).not.toBeNull();
  await createdRow.getByRole('link').click();
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Browser-persisted Party',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }),
  ).toContainText('Party list');
  const keyFactsSlot = page.locator('[data-platform-slot="record:keyFacts"]');
  const sectionsSlot = page.locator('[data-platform-slot="record:sections"]');
  await expect(
    sectionsSlot.getByText('P-BROWSER-REAL-001', { exact: true }),
  ).toBeVisible();
  await expect(keyFactsSlot).toContainText('Revision');
  await expect(keyFactsSlot.locator('[data-field-id]')).toHaveCount(0);
  await expect(keyFactsSlot).not.toContainText(
    'browser-persisted@example.test',
  );
  await expect(sectionsSlot.locator('[data-field-id]')).toHaveCount(3);
  await expect(sectionsSlot).toContainText('browser-persisted@example.test');
  await page.setViewportSize({ height: 844, width: 390 });
  const compactSections = page.locator(
    '[data-platform-slot="record:sections"] details.record-section-group',
  );
  await expect(compactSections).toHaveAttribute('open', '');
  await expect(
    page.locator('[data-platform-slot="record:commandBar"] .command-bar'),
  ).toHaveCSS('position', 'sticky');
  const compactSectionSummary = compactSections.locator('summary');
  await compactSectionSummary.focus();
  await page.keyboard.press('Enter');
  await expect(compactSections).not.toHaveAttribute('open', '');
  await page.setViewportSize({ height: 720, width: 1280 });
  await expect(compactSectionSummary).toBeVisible();
  await compactSectionSummary.focus();
  await page.keyboard.press('Enter');
  await expect(compactSections).toHaveAttribute('open', '');
  await expect(
    compactSections.getByText('browser-persisted@example.test'),
  ).toBeVisible();
  const overflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  const archive = page.getByRole('button', { name: 'Archive' });
  await expect(overflow).toBeVisible();
  await expect(archive).toBeHidden();
  await overflow.locator('summary').click();
  await expect(archive).toBeVisible();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Edit Party' }),
  ).toBeVisible();
  await page
    .getByLabel('Contact summary', { exact: true })
    .fill('updated-after-navigation@example.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Update complete');

  const detailUrl = `${surfaceUrl(baseUrl, 'party_detail')}&record=${encodeURIComponent(createdRecordId ?? '')}`;
  await page.goto(detailUrl);
  const archiveOverflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  await archiveOverflow.locator('summary').click();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirm Archive' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm Archive' }).click();
  await expect(page.getByRole('status')).toContainText('Archive complete');
  await expect(page.getByText(/Archived · revision 3/)).toBeVisible();

  await page.goto(detailUrl);
  await expect(
    page.locator(
      '[data-platform-slot^="record:"][data-slot-state="failed"] [data-diagnostic-code="QUERY_NOT_FOUND"]',
    ),
  ).toHaveCount(2);
  await expect(
    page.locator(
      '[data-platform-slot="record:breadcrumb"][data-slot-state="ready"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-platform-slot="record:titleStatus"][data-slot-state="ready"]',
    ),
  ).toContainText('Party');
  await expect(
    page.locator(
      '[data-platform-slot="record:commandBar"][data-slot-state="ready"]',
    ),
  ).toContainText('New');

  await page.goto(
    `${surfaceUrl(baseUrl, 'party_list')}&q=${encodeURIComponent('Browser-persisted Party')}`,
  );
  await expect(
    page.locator('tr', { hasText: 'Browser-persisted Party' }),
  ).toHaveCount(0);
  const showArchived = page.getByRole('link', { name: 'Show archived' });
  await expect(showArchived).toBeVisible();
  await showArchived.click();
  const archivedRow = page.locator('tr', {
    hasText: 'Browser-persisted Party',
  });
  await expect(
    archivedRow.getByText('Archived', { exact: true }),
  ).toBeVisible();
  const hideArchived = page.getByRole('link', { name: 'Hide archived' });
  await expect(hideArchived).toBeVisible();
  await hideArchived.click();
  await expect(
    page.locator('tr', { hasText: 'Browser-persisted Party' }),
  ).toHaveCount(0);
  await expect(showArchived).toBeVisible();
  await showArchived.click();
  await expect(archivedRow).toBeVisible();
  await archivedRow.getByRole('link').click();
  await expect(page).toHaveURL(/(?:\?|&)archived=yes(?:&|$)/);
  await expect(page.getByText(/Archived · revision 3/)).toBeVisible();
  const restoreOverflow = page.locator(
    '[data-platform-slot="record:commandBar"] details.action-overflow',
  );
  await restoreOverflow.locator('summary').click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('status')).toContainText('Restore complete');

  await page.goto(detailUrl);
  await expect(page.getByText(/Active · revision 4/)).toBeVisible();
  await expect(
    page.getByText('updated-after-navigation@example.test', { exact: true }),
  ).toBeVisible();
}

const browserLegalEntityId = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;
const browserAlternateLegalEntityId = '74000000-0000-4000-8000-000000000009';
const browserAlternateInventoryScope = Object.freeze({
  ...COMPOSED_APPLICATION_INVENTORY_SCOPE,
  entityCode: 'SECOND',
  entityName: 'Second legal entity',
  legalEntityId: browserAlternateLegalEntityId,
});
const browserTransactionId = '74000000-0000-4000-8000-000000000002';
const browserTransactionLineId = '74000000-0000-4000-8000-000000000003';
const browserPostingIdempotencyKey = '74000000-0000-4000-8000-000000000004';
const rejectedBrowserTransactionId = '74100000-0000-4000-8000-000000000001';
const rejectedBrowserTransactionLineId = '74100000-0000-4000-8000-000000000002';
const rejectedBrowserPostingIdempotencyKey =
  '74100000-0000-4000-8000-000000000003';
const rejectedBrowserPostingSourceId = 'browser-rejected-superuser-adjustment';
const browserRouteTransactionId = '74200000-0000-4000-8000-000000000001';
const browserRouteTransactionLineId = '74200000-0000-4000-8000-000000000002';
const demoItemId = '71000000-0000-4000-8000-000000000011';
const demoLocationId = '71000000-0000-4000-8000-000000000021';
const browserPostingInstant = '2026-07-30T12:00:00.000Z';
const browserRoutePostingInstant = new Date().toISOString();
type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

async function seedPostedInventory(
  adminPool: pg.Pool,
  databaseUrl: string,
  application: Awaited<ReturnType<typeof startComposedApplication>>,
): Promise<void> {
  const projection = await loadPostingProjection(
    application.runtime.releaseRoot,
  );
  const identity = application.runtime.identity;
  const provisioned = await adminPool.query<{ contract_release_root: string }>(
    `SELECT contract_release_root
       FROM platform.inventory_posting_configurations
      WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3`,
    [identity.tenantId, identity.environmentId, browserLegalEntityId],
  );
  expect(provisioned.rows).toEqual([
    { contract_release_root: application.runtime.releaseRoot },
  ]);
  await provisionBrowserLegalEntity(adminPool, application);

  await application.runtime.entry.run(
    { headers: { authorization: 'browser-inventory-posting' } },
    async (view) => {
      const context = trustedContextForRequestRuntimeView(view);
      await seedInventoryDraft(adminPool, context, projection.storageTarget);
      const actor = await new TrustedActorEnvelopeIssuer({
        resolve: async () => ({
          approvingHumanId: null,
          delegation: null,
          executionPrincipal: {
            kind: 'HUMAN',
            principalId: context.principalId,
          },
          initiatingHumanId: context.principalId,
          subject: null,
        }),
      }).issue(context);
      const registration = {
        capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
        capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
        dependencySetRoot: INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
        releaseContentHash: application.runtime.releaseRoot,
        releaseId: application.runtime.activeReleaseId,
        storageTarget: projection.storageTarget,
        storageTargetContentHash: projection.contentHash,
      } as const;
      const command: InventoryAdjustmentPostingCommandV1 = {
        authorization: {
          decision: 'ALLOW',
          evaluatorVersion: 'browser-inventory-fixture/v1',
          policyVersion: 'browser-inventory-fixture/v1',
        },
        channel: 'SYSTEM',
        effectiveAt: browserPostingInstant,
        idempotencyKey: browserPostingIdempotencyKey,
        legalEntityId: browserLegalEntityId,
        lines: [
          {
            itemId: demoItemId,
            locationId: demoLocationId,
            quantityDelta: '5',
            sourceLine: '1',
            transactionLineId: browserTransactionLineId,
            unitId: 'EA',
          },
        ],
        reason: {
          code: 'browser-seed',
          narrative: 'Posted through the admitted Inventory capability',
        },
        sourceId: 'browser-posted-adjustment',
        sourceRevision: 1,
        sourceType: 'browser-checkpoint',
        stockDimensionSetVersion: 'v1',
        transactionId: browserTransactionId,
      };
      const rejectedCommand: InventoryAdjustmentPostingCommandV1 = {
        ...command,
        idempotencyKey: rejectedBrowserPostingIdempotencyKey,
        lines: [
          {
            ...command.lines[0]!,
            transactionLineId: rejectedBrowserTransactionLineId,
          },
        ],
        sourceId: rejectedBrowserPostingSourceId,
        transactionId: rejectedBrowserTransactionId,
      };
      const privilegedPool = new pg.Pool({
        connectionString: databaseUrl,
        max: 1,
      });
      try {
        await expectDatabaseRole(privilegedPool, {
          currentUser: 'postgres',
          rolsuper: true,
          sessionUser: 'postgres',
        });
        const privilegedService = new PostgresInventoryPostingService(
          privilegedPool,
          registration,
          { currentInstant: () => browserPostingInstant },
        );
        await expect(
          privilegedService.postAdjustment(context, actor, rejectedCommand),
        ).rejects.toMatchObject({
          code: 'INVENTORY_POSTING_STORAGE_INVALID',
          message:
            'INVENTORY_POSTING_STORAGE_INVALID: posting requires the unprivileged trusted runtime login',
          name: 'InventoryPostingError',
        });
      } finally {
        await privilegedPool.end();
      }
      await expectRejectedPostingAbsent(
        adminPool,
        context,
        projection.storageTarget,
      );

      const runtimeConnection = new URL(databaseUrl);
      runtimeConnection.username = 'north_star_runtime';
      runtimeConnection.password = '';
      const runtimePool = new pg.Pool({
        connectionString: runtimeConnection.href,
        max: 2,
      });
      try {
        await expectDatabaseRole(runtimePool, {
          currentUser: 'north_star_runtime',
          rolsuper: false,
          sessionUser: 'north_star_runtime',
        });
        const service = new PostgresInventoryPostingService(
          runtimePool,
          registration,
          { currentInstant: () => browserPostingInstant },
        );
        await service.postAdjustment(context, actor, command);
      } finally {
        await runtimePool.end();
      }
    },
  );

  const postedStock = await application.runtime.entry.run(
    { headers: { authorization: 'browser-inventory-balance-read' } },
    (view) =>
      application.runtime.queryGateway.invoke(view, {
        arguments: {
          [`${applicationNamespace}:parameter.posted_stock_balance_list_legal_entity_scope`]:
            browserLegalEntityId,
          includeArchived: false,
          list: {
            cursor: null,
            matchMode: 'substring',
            pageSize: 100,
            relationLabels: [],
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            search: '',
            sort: [],
          },
        },
        queryId: `${applicationNamespace}:query.posted_stock_balance_list`,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
  );
  assert.equal(postedStock.outcome, 'exact');
  assert.equal(postedStock.records.length, 1);
  assert.match(
    postedStock.records[0]!.recordId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.equal(
    postedStock.records[0]?.values[
      `${applicationNamespace}:field.posted_stock_balance_posted_quantity`
    ],
    '5.000000000000000000',
  );
}

async function provisionBrowserLegalEntity(
  pool: pg.Pool,
  application: Awaited<ReturnType<typeof startComposedApplication>>,
): Promise<void> {
  const identity = application.runtime.identity;
  const scope = browserAlternateInventoryScope;
  await pool.query(
    `SELECT platform.provision_inventory_scope(
       $1,$2,$3,$4,$5,$6,$7,$8,$9::smallint,$10,$11,
       $12,$13,$14,$15,$16,$17,$18,$19,$20,$21
     )`,
    [
      identity.tenantId,
      identity.environmentId,
      scope.legalEntityId,
      scope.entityCode,
      scope.entityName,
      scope.timeZone,
      scope.businessDayBoundary,
      application.runtime.releaseRoot,
      scope.configurationVersion,
      scope.negativeStock,
      scope.maximumBackdateDays,
      scope.adjustmentReasonRequirement,
      scope.transferReasonRequirement,
      scope.countReasonRequirement,
      scope.correctionReasonRequirement,
      scope.rebaselineReasonRequirement,
      scope.adjustmentApprovalThreshold,
      scope.transferApprovalThreshold,
      scope.countApprovalThreshold,
      scope.correctionApprovalThreshold,
      scope.rebaselineApprovalThreshold,
    ],
  );
}

async function expectDatabaseRole(
  pool: pg.Pool,
  expected: {
    readonly currentUser: string;
    readonly rolsuper: boolean;
    readonly sessionUser: string;
  },
): Promise<void> {
  const result = await pool.query<{
    currentUser: string;
    rolsuper: boolean;
    sessionUser: string;
  }>(`SELECT current_user AS "currentUser",
             session_user AS "sessionUser",
             role.rolsuper
        FROM pg_catalog.pg_roles AS role
       WHERE role.rolname = current_user`);
  expect(result.rows).toEqual([expected]);
}

async function expectRejectedPostingAbsent(
  pool: pg.Pool,
  context: ReturnType<typeof trustedContextForRequestRuntimeView>,
  target: StorageTargetPayloadV1,
): Promise<void> {
  const transaction = storageEntity(target, 'inventory_transaction');
  const transactionLine = storageEntity(target, 'inventory_transaction_line');
  const movement = storageEntity(target, 'inventory_movement');
  const movementSourceIdColumn = movement.columns.find(
    (column) => localField(column) === 'inventory_movement_source_id',
  )?.physicalName;
  if (!movementSourceIdColumn) {
    throw new TypeError('inventory movement source id column is missing');
  }
  const schema = quoted(target.providerAbi.managedSchema);
  const result = await pool.query<{
    movementRows: number;
    receiptRows: number;
    transactionLineRows: number;
    transactionRows: number;
  }>(
    `SELECT
       (SELECT count(*)::integer
          FROM ${schema}.${quoted(transaction.physicalTableName)}
         WHERE tenant_id=$1 AND environment_id=$2
           AND ${quoted(transaction.recordIdentity.column)}=$3) AS "transactionRows",
       (SELECT count(*)::integer
          FROM ${schema}.${quoted(transactionLine.physicalTableName)}
         WHERE tenant_id=$1 AND environment_id=$2
           AND ${quoted(transactionLine.recordIdentity.column)}=$4) AS "transactionLineRows",
       (SELECT count(*)::integer
          FROM ${schema}.${quoted(movement.physicalTableName)}
         WHERE tenant_id=$1 AND environment_id=$2
           AND ${quoted(movementSourceIdColumn)}=$5) AS "movementRows",
       (SELECT count(*)::integer
          FROM platform.semantic_operation_receipts
         WHERE tenant_id=$1 AND environment_id=$2
           AND action_id=$6 AND idempotency_key=$7) AS "receiptRows"`,
    [
      context.tenantId,
      context.environmentId,
      rejectedBrowserTransactionId,
      rejectedBrowserTransactionLineId,
      rejectedBrowserPostingSourceId,
      INVENTORY_POSTING_CAPABILITY_ID,
      rejectedBrowserPostingIdempotencyKey,
    ],
  );
  expect(result.rows).toEqual([
    {
      movementRows: 0,
      receiptRows: 0,
      transactionLineRows: 0,
      transactionRows: 0,
    },
  ]);
}

async function seedInventoryDraft(
  pool: pg.Pool,
  context: ReturnType<typeof trustedContextForRequestRuntimeView>,
  target: StorageTargetPayloadV1,
): Promise<void> {
  const legalEntity = storageEntity(target, 'legal_entity');
  const transaction = storageEntity(target, 'inventory_transaction');
  const transactionLine = storageEntity(target, 'inventory_transaction_line');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('north_star.tenant_id',$1,true),
              set_config('north_star.environment_id',$2,true),
              set_config('north_star.principal_id',$3,true),
              set_config('north_star.request_id',$4,true)`,
      [
        context.tenantId,
        context.environmentId,
        context.principalId,
        context.requestId,
      ],
    );
    await client.query('SET LOCAL ROLE north_star_module_runtime');
    await insertStorageEntity(client, target, legalEntity, {
      legalEntityId: null,
      recordId: browserAlternateLegalEntityId,
      relations: {},
      values: {
        legal_entity_code: browserAlternateInventoryScope.entityCode,
        legal_entity_is_default: false,
        legal_entity_name: browserAlternateInventoryScope.entityName,
        legal_entity_status: enumOption(
          legalEntity,
          'legal_entity_status',
          'active',
        ),
      },
      context,
    });
    await insertStorageEntity(client, target, transaction, {
      legalEntityId: browserLegalEntityId,
      recordId: browserTransactionId,
      relations: {},
      values: {
        inventory_transaction_actor_id: context.principalId,
        inventory_transaction_effective_at: browserPostingInstant,
        inventory_transaction_number: 'ADJ-BROWSER-001',
        inventory_transaction_reason_code: 'browser-seed',
        inventory_transaction_reason_narrative:
          'Posted through the admitted Inventory capability',
        inventory_transaction_recorded_at: browserPostingInstant,
        inventory_transaction_source_id: 'browser-posted-adjustment',
        inventory_transaction_source_type: 'browser-checkpoint',
        inventory_transaction_state: enumOption(
          transaction,
          'inventory_transaction_state',
          'draft',
        ),
        inventory_transaction_type: enumOption(
          transaction,
          'inventory_transaction_type',
          'adjustment',
        ),
      },
      context,
    });
    await insertStorageEntity(client, target, transactionLine, {
      legalEntityId: browserLegalEntityId,
      recordId: browserTransactionLineId,
      relations: {
        'northstar.app:entity.inventory_transaction': browserTransactionId,
      },
      values: {
        inventory_transaction_line_from_location_id: null,
        inventory_transaction_line_item_id: demoItemId,
        inventory_transaction_line_line_number: 1,
        inventory_transaction_line_quantity: '5',
        inventory_transaction_line_to_location_id: demoLocationId,
        inventory_transaction_line_unit_id: 'EA',
      },
      context,
    });
    await insertStorageEntity(client, target, transaction, {
      legalEntityId: browserLegalEntityId,
      recordId: browserRouteTransactionId,
      relations: {},
      values: {
        inventory_transaction_actor_id: context.principalId,
        inventory_transaction_effective_at: browserRoutePostingInstant,
        inventory_transaction_number: 'ADJ-BROWSER-ROUTE-001',
        inventory_transaction_reason_code: 'browser-route',
        inventory_transaction_reason_narrative:
          'Posted through the registered surface command',
        inventory_transaction_recorded_at: browserRoutePostingInstant,
        inventory_transaction_source_id: 'browser-posting-route',
        inventory_transaction_source_type: 'browser-checkpoint',
        inventory_transaction_state: enumOption(
          transaction,
          'inventory_transaction_state',
          'draft',
        ),
        inventory_transaction_type: enumOption(
          transaction,
          'inventory_transaction_type',
          'adjustment',
        ),
      },
      context,
    });
    await insertStorageEntity(client, target, transactionLine, {
      legalEntityId: browserLegalEntityId,
      recordId: browserRouteTransactionLineId,
      relations: {
        'northstar.app:entity.inventory_transaction': browserRouteTransactionId,
      },
      values: {
        inventory_transaction_line_from_location_id: null,
        inventory_transaction_line_item_id: demoItemId,
        inventory_transaction_line_line_number: 1,
        inventory_transaction_line_quantity: '3',
        inventory_transaction_line_to_location_id: demoLocationId,
        inventory_transaction_line_unit_id: 'EA',
      },
      context,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertStorageEntity(
  client: pg.PoolClient,
  target: StorageTargetPayloadV1,
  entity: StorageEntityTarget,
  input: {
    readonly context: ReturnType<typeof trustedContextForRequestRuntimeView>;
    readonly legalEntityId: string | null;
    readonly recordId: string;
    readonly relations: Readonly<Record<string, string>>;
    readonly values: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const relations = target.relations.filter(
    (relation) =>
      relation.sourceEntityId === entity.entityId &&
      relation.relationColumn.origin !== 'field',
  );
  const columns = [
    'tenant_id',
    'environment_id',
    ...(entity.legalEntity ? [entity.legalEntity.column] : []),
    entity.recordIdentity.column,
    ...entity.columns.map((column) => column.physicalName),
    ...relations.map((relation) => relation.relationColumn.physicalName),
  ];
  const values = [
    input.context.tenantId,
    input.context.environmentId,
    ...(entity.legalEntity ? [input.legalEntityId] : []),
    input.recordId,
    ...entity.columns.map((column) => {
      const local = localField(column);
      if (!Object.hasOwn(input.values, local)) {
        throw new TypeError(`missing browser fixture field ${local}`);
      }
      return input.values[local];
    }),
    ...relations.map((relation) => {
      const value = input.relations[relation.targetEntityId];
      if (!value) {
        throw new TypeError(
          `missing browser fixture relation ${relation.relationId}`,
        );
      }
      return value;
    }),
  ];
  await client.query(
    `INSERT INTO ${quoted(target.providerAbi.managedSchema)}.${quoted(entity.physicalTableName)}
       (${columns.map(quoted).join(',')})
     VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(',')})`,
    values,
  );
}

function storageEntity(
  target: StorageTargetPayloadV1,
  localId: string,
): StorageEntityTarget {
  const entity = target.entities.find((candidate) =>
    candidate.entityId.endsWith(`:entity.${localId}`),
  );
  if (!entity) throw new TypeError(`missing storage entity ${localId}`);
  return entity;
}

function enumOption(
  entity: StorageEntityTarget,
  localId: string,
  suffix: string,
): string {
  const column = entity.columns.find(
    (candidate) => localField(candidate) === localId,
  );
  const options = column?.fieldContract.enumOptionIds.filter((option) =>
    option.endsWith(`_${suffix}`),
  );
  if (options?.length !== 1) {
    throw new TypeError(`missing enum option ${localId}.${suffix}`);
  }
  return options[0]!;
}

function localField(column: StorageEntityTarget['columns'][number]): string {
  return column.canonicalFieldId.split(':field.').at(-1)!;
}

function quoted(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(identifier)) {
    throw new TypeError(`invalid generated identifier ${identifier}`);
  }
  return `"${identifier}"`;
}

async function loadPostingProjection(releaseRoot: string): Promise<{
  readonly contentHash: string;
  readonly storageTarget: StorageTargetPayloadV1;
}> {
  const compiled = JSON.parse(
    await readFile(
      new URL('../../release/app.compiled.json', import.meta.url),
      'utf8',
    ),
  ) as {
    readonly application?: CompiledApplicationRelease;
    readonly applications: readonly CompiledApplicationRelease[];
  };
  const application = (compiled.applications ?? [compiled.application!]).find(
    (candidate) => candidate.releaseRoot === releaseRoot,
  );
  if (!application)
    throw new TypeError('active application release is not checked in');
  const projection = application.releaseManifest.projections.find(
    (candidate) => candidate.familyId === PROJECTION_FAMILY_IDS.storageTarget,
  );
  if (!projection)
    throw new TypeError('application storage projection is missing');
  const manifestArtifact = application.artifacts.find(
    (candidate) => candidate.contentHash === projection.artifactRoot,
  );
  if (!manifestArtifact)
    throw new TypeError('storage manifest artifact is missing');
  const manifest = JSON.parse(
    Buffer.from(manifestArtifact.canonicalBytesBase64, 'base64').toString(
      'utf8',
    ),
  ) as { readonly chunks: readonly { readonly contentHash: string }[] };
  const contentHash = manifest.chunks[0]?.contentHash;
  const chunk = application.artifacts.find(
    (candidate) => candidate.contentHash === contentHash,
  );
  if (!chunk || !contentHash)
    throw new TypeError('storage chunk artifact is missing');
  return {
    contentHash,
    storageTarget: JSON.parse(
      Buffer.from(chunk.canonicalBytesBase64, 'base64').toString('utf8'),
    ) as StorageTargetPayloadV1,
  };
}

interface CompiledApplicationRelease {
  readonly artifacts: readonly {
    readonly canonicalBytesBase64: string;
    readonly contentHash: string;
  }[];
  readonly releaseManifest: {
    readonly projections: readonly {
      readonly artifactRoot: string;
      readonly familyId: string;
    }[];
  };
  readonly releaseRoot: string;
}

interface CompiledOnHandLookupProjection {
  readonly archetype: 'task';
  readonly inputParameters: readonly {
    readonly orderKey: number;
    readonly parameterId: string;
  }[];
  readonly label: string;
  readonly legalEntityParameterId: string;
  readonly parameterIds: readonly string[];
  readonly statusRoles: readonly string[];
  readonly surfaceId: string;
}

async function loadOnHandLookupProjection(): Promise<CompiledOnHandLookupProjection> {
  const compiled = JSON.parse(
    await readFile(
      new URL('../../release/app.compiled.json', import.meta.url),
      'utf8',
    ),
  ) as {
    readonly application?: CompiledApplicationRelease;
    readonly applications?: readonly CompiledApplicationRelease[];
  };
  const application = compiled.applications?.at(-1) ?? compiled.application;
  if (!application) throw new TypeError('compiled application is missing');
  const surfacePayload = projectionPayload(
    application,
    PROJECTION_FAMILY_IDS.surfaceManifest,
  ) as {
    readonly surfaces: readonly {
      readonly archetype: string;
      readonly dataSourceQueryId: string;
      readonly label: string;
      readonly statusRoles: readonly string[];
      readonly surfaceId: string;
    }[];
  };
  const surface = surfacePayload.surfaces.find(
    (candidate) =>
      candidate.surfaceId ===
      `${applicationNamespace}:surface.inventory_on_hand_lookup`,
  );
  if (!surface || surface.archetype !== 'task') {
    throw new TypeError('compiled on-hand task surface is missing');
  }
  const queryPayload = projectionPayload(
    application,
    PROJECTION_FAMILY_IDS.queryCatalog,
  ) as {
    readonly queries: readonly {
      readonly legalEntityScope?: {
        readonly operand: { readonly parameterId: string };
      };
      readonly parameters?: readonly {
        readonly orderKey: number;
        readonly parameterId: string;
      }[];
      readonly queryId: string;
      readonly queryType: string;
    }[];
  };
  const query = queryPayload.queries.find(
    (candidate) => candidate.queryId === surface.dataSourceQueryId,
  );
  const legalEntityParameterId = query?.legalEntityScope?.operand.parameterId;
  const parameters = [...(query?.parameters ?? [])].sort(
    (left, right) => left.orderKey - right.orderKey,
  );
  if (
    query?.queryType !== 'aggregate' ||
    !legalEntityParameterId ||
    parameters.length !== 5 ||
    !parameters.some(
      (parameter) => parameter.parameterId === legalEntityParameterId,
    )
  ) {
    throw new TypeError('compiled on-hand parameter contract is malformed');
  }
  return Object.freeze({
    archetype: 'task',
    inputParameters: Object.freeze(
      parameters.filter(
        (parameter) => parameter.parameterId !== legalEntityParameterId,
      ),
    ),
    label: surface.label,
    legalEntityParameterId,
    parameterIds: Object.freeze(
      parameters.map((parameter) => parameter.parameterId),
    ),
    statusRoles: Object.freeze([...surface.statusRoles]),
    surfaceId: surface.surfaceId,
  });
}

async function loadSurfaceScopeParameterId(
  localSurface: string,
): Promise<string> {
  const compiled = JSON.parse(
    await readFile(
      new URL('../../release/app.compiled.json', import.meta.url),
      'utf8',
    ),
  ) as {
    readonly application?: CompiledApplicationRelease;
    readonly applications?: readonly CompiledApplicationRelease[];
  };
  const application = compiled.applications?.at(-1) ?? compiled.application;
  if (!application) throw new TypeError('compiled application is missing');
  const surfacePayload = projectionPayload(
    application,
    PROJECTION_FAMILY_IDS.surfaceManifest,
  ) as {
    readonly surfaces: readonly {
      readonly dataSourceQueryId: string;
      readonly surfaceId: string;
    }[];
  };
  const surfaceId = `${applicationNamespace}:surface.${localSurface}`;
  const surface = surfacePayload.surfaces.find(
    (candidate) => candidate.surfaceId === surfaceId,
  );
  if (!surface)
    throw new TypeError(`compiled surface is missing: ${surfaceId}`);
  const queryPayload = projectionPayload(
    application,
    PROJECTION_FAMILY_IDS.queryCatalog,
  ) as {
    readonly queries: readonly {
      readonly legalEntityScope?: {
        readonly operand: { readonly parameterId: string };
      };
      readonly queryId: string;
    }[];
  };
  const query = queryPayload.queries.find(
    (candidate) => candidate.queryId === surface.dataSourceQueryId,
  );
  const parameterId = query?.legalEntityScope?.operand.parameterId;
  if (!parameterId) {
    throw new TypeError(`compiled surface scope is missing: ${surfaceId}`);
  }
  return parameterId;
}

function projectionPayload(
  application: CompiledApplicationRelease,
  familyId: string,
): unknown {
  const projection = application.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (!projection) throw new TypeError(`projection is missing: ${familyId}`);
  const manifest = application.artifacts.find(
    (candidate) => candidate.contentHash === projection.artifactRoot,
  );
  if (!manifest)
    throw new TypeError(`projection manifest is missing: ${familyId}`);
  const descriptor = (
    JSON.parse(
      Buffer.from(manifest.canonicalBytesBase64, 'base64').toString('utf8'),
    ) as { readonly chunks: readonly { readonly contentHash: string }[] }
  ).chunks[0];
  const chunk = application.artifacts.find(
    (candidate) => candidate.contentHash === descriptor?.contentHash,
  );
  if (!chunk) throw new TypeError(`projection chunk is missing: ${familyId}`);
  return JSON.parse(
    Buffer.from(chunk.canonicalBytesBase64, 'base64').toString('utf8'),
  ) as unknown;
}

function surfaceUrl(baseUrl: string, localSurface: string): string {
  return `${baseUrl}/?surface=${encodeURIComponent(`${applicationNamespace}:surface.${localSurface}`)}`;
}

function scopedSurfaceUrl(
  baseUrl: string,
  localSurface: string,
  scopeParameterId: string,
  legalEntityId: string,
): string {
  const url = new URL(surfaceUrl(baseUrl, localSurface));
  url.searchParams.set(scopeParameterId, legalEntityId);
  return url.href;
}

async function assertSeedTrust(
  pool: pg.Pool,
  application: Awaited<ReturnType<typeof startComposedApplication>>,
): Promise<void> {
  expect(application.seededRecords).toHaveLength(12);
  for (const seed of application.seededRecords) {
    const linked = await pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM platform.trust_action_invocations AS invocation
         JOIN platform.trust_business_change_documents AS change
           ON change.tenant_id = invocation.tenant_id
          AND change.environment_id = invocation.environment_id
          AND change.invocation_id = invocation.invocation_id
         JOIN platform.trust_domain_events AS event
           ON event.tenant_id = invocation.tenant_id
          AND event.environment_id = invocation.environment_id
          AND event.invocation_id = invocation.invocation_id
         JOIN platform.trust_outbox AS outbox
           ON outbox.tenant_id = invocation.tenant_id
          AND outbox.environment_id = invocation.environment_id
          AND outbox.invocation_id = invocation.invocation_id
        WHERE invocation.tenant_id = $1
          AND invocation.environment_id = $2
          AND invocation.invocation_id = $3
          AND invocation.change_document_id = $4
          AND invocation.domain_event_id = $5
          AND invocation.outbox_id = $6`,
      [
        application.runtime.identity.tenantId,
        application.runtime.identity.environmentId,
        seed.trust.invocationId,
        seed.trust.changeDocumentId,
        seed.trust.domainEventId,
        seed.trust.outboxId,
      ],
    );
    expect(linked.rows[0]?.count).toBe('1');
  }
}
