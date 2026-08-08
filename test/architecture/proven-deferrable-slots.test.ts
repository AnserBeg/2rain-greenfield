import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PROVEN_DEFERRABLE_SURFACE_SLOTS } from '../../packages/canonical-model/src/index.js';
import {
  ACTION_TOKENS,
  DYNAMIC_DISPATCH,
  FIELD_TOKENS,
  INPUT_TOKENS,
  PROTECTED_TOKENS,
  declarations,
  protectedCategories,
  reaches,
  slotRenderers,
} from '../helpers/renderer-consumption.js';

const REGISTRY_SOURCE = 'apps/web/src/component-registry.ts';

/**
 * `PROVEN_DEFERRABLE_SURFACE_SLOTS` claims its members render no surface field,
 * no required input and no action. This proves exactly that claim, for the one
 * member that remains.
 *
 * The compiler cannot import `apps/web` -- `check:boundaries` enforces the
 * dependency direction -- so the set is DECLARED in `canonical-model` and BOUND
 * here, where a test may read both sides.
 *
 * A PROXY, not an observation (AGENTS.md §6): it reads source text. That is why
 * reaching `renderReferencedComponent` is DISQUALIFYING rather than a documented
 * gap -- an unprovable slot forces instead of defaulting to deferrable.
 *
 * **The mutation harness below is part of the gate, not a report artifact.** The
 * previous round's table was produced by a harness that was never committed, and
 * an independent replay against the same predicates found four survivors. Every
 * predicate here is now shown to fire against a planted violation, in an
 * executed suite.
 */
function registrySource(): string {
  return readFileSync(REGISTRY_SOURCE, 'utf8');
}

function deferrableKeys(): readonly string[] {
  return Object.entries(PROVEN_DEFERRABLE_SURFACE_SLOTS).flatMap(
    ([archetype, slots]) =>
      (slots as readonly string[]).map((slot) => `${archetype}:${slot}`),
  );
}

test('the slot registry is readable, so the proofs have a subject', () => {
  const renderers = slotRenderers(registrySource());
  assert.ok(
    renderers.size >= 8,
    `expected the slot registry to be parsed; read ${String(renderers.size)} entries`,
  );
  for (const key of deferrableKeys()) {
    assert.ok(
      renderers.has(key),
      `${key} is declared deferrable but is not a registered slot`,
    );
  }
});

/**
 * **The one admitted category, named rather than hidden by omitting a
 * predicate.** `renderBreadcrumb` emits `<a href=...>` to the related list
 * surface. Links ARE watched -- dropping the predicate to make the member pass
 * would be the fourth proxy this packet has been blocked for -- so the admission
 * is explicit here instead.
 *
 * A wayfinding link is not protected content. §3.2 forces `always` for key
 * facts, status, required inputs and anything blocking; a breadcrumb link is
 * none of them, and deferring it conceals no field, no input and no action.
 *
 * **What this gate therefore does and does not prove, stated exactly.** It
 * PROVES `record:breadcrumb` reaches no field, no required input, no action
 * control and no dynamic dispatch. It does NOT prove the link is harmless -- the
 * predicate cannot tell a breadcrumb link from `list:title`'s
 * `<a class="primary-action">New</a>`, which reaches the same single category.
 * That admission is a RULING recorded in the constant, not a proof, and
 * `list:title` stays out of the allow-list by membership rather than by anything
 * measured here. Saying so is the difference between a narrow true claim and the
 * proxy this packet has been blocked for three times.
 */
const ADMITTED_CATEGORIES: readonly string[] = Object.freeze(['link']);

test('every proven-deferrable slot reaches no protected category', () => {
  const source = registrySource();
  const bodies = declarations(source);
  const renderers = slotRenderers(source);
  const keys = deferrableKeys();
  assert.deepEqual(
    keys,
    ['record:breadcrumb'],
    'one slot, one archetype, unconditional -- progressive applies to record:breadcrumb and nothing else',
  );
  for (const key of keys) {
    const renderer = renderers.get(key)!;
    const seen = protectedCategories(bodies, renderer);
    assert.deepEqual(
      seen.filter((category) => !ADMITTED_CATEGORIES.includes(category)),
      [],
      `${key} (${renderer}) reaches protected content and cannot be deferrable`,
    );
    assert.deepEqual(
      seen,
      ['link'],
      `${key} must reach the admitted navigation link and nothing else`,
    );
  }
});

test('every slot reaching protected content is excluded', () => {
  const source = registrySource();
  const bodies = declarations(source);
  const deferrable = new Set(deferrableKeys());
  const excluded: string[] = [];
  for (const [key, renderer] of slotRenderers(source)) {
    const categories = protectedCategories(bodies, renderer);
    if (
      categories.some((category) => !ADMITTED_CATEGORIES.includes(category))
    ) {
      excluded.push(key);
      assert.ok(
        !deferrable.has(key),
        `${key} reaches protected content, yet is declared deferrable`,
      );
    }
  }
  assert.deepEqual(
    excluded.sort(),
    [
      'list:bulkActions',
      'list:dataGrid',
      'record:commandBar',
      'record:keyFacts',
      'record:sections',
      'record:titleStatus',
      'task:decision',
      'task:primaryAction',
      'task:scanInput',
    ],
    'the exclusion set is pinned, so a renderer that stops reaching protected content cannot quietly become admissible',
  );
});

/**
 * The limit the exclusion above cannot express, asserted so it cannot be
 * forgotten. `list:title` reaches exactly one category -- the admitted `link` --
 * because `renderListTitle` emits `<a class="primary-action">New</a>`. By these
 * predicates it is indistinguishable from `record:breadcrumb`. It is kept out of
 * the allow-list by MEMBERSHIP, not by measurement, and a packet that widens the
 * set must close this gap first rather than reason from the gate's silence.
 */
test('list:title is indistinguishable from breadcrumb by these predicates', () => {
  const source = registrySource();
  const bodies = declarations(source);
  const renderers = slotRenderers(source);
  assert.deepEqual(
    protectedCategories(bodies, renderers.get('list:title')!),
    ['link'],
    'renderListTitle reaches only the admitted link category',
  );
  assert.deepEqual(
    protectedCategories(bodies, renderers.get('record:breadcrumb')!),
    ['link'],
  );
  assert.ok(
    !deferrableKeys().includes('list:title'),
    'list:title must stay out of the allow-list even though the predicates cannot exclude it',
  );
});

/**
 * The named reasons the two most recently deleted members were deleted, held
 * open so neither can be restored without this failing first.
 */
test('commandBar reaches an action and dataGrid reaches a field', () => {
  const bodies = declarations(registrySource());
  assert.ok(
    reaches(bodies, 'renderCommandBar', ACTION_TOKENS),
    'renderCommandBar emits a submit control on form surfaces',
  );
  assert.ok(reaches(bodies, 'renderDataGrid', FIELD_TOKENS));
  assert.ok(reaches(bodies, 'renderTaskScanInput', INPUT_TOKENS));
  assert.ok(reaches(bodies, 'renderTaskDecision', DYNAMIC_DISPATCH));
});

/**
 * THE MUTATION HARNESS. Each planted violation is injected into the renderer
 * this gate certifies, and the gate must see it. The four cases are the exact
 * survivors an independent replay found against the previous walk: a required
 * input, an action button, a field read through `record.values[...]`, and a
 * helper moved into an arrow function.
 *
 * `SURVIVOR` is printed when a planted violation is NOT seen, and the assertion
 * that follows fails on the same condition -- so the marker is proven able to
 * fire rather than assumed.
 */
const MUTATIONS: ReadonlyArray<{
  readonly expect: string;
  readonly name: string;
  readonly plant: (source: string) => string;
}> = Object.freeze([
  {
    expect: 'input',
    name: 'a required input inside the certified renderer',
    plant: (source) =>
      source.replace(
        'function renderBreadcrumb(context: SurfaceComponentContext): string {',
        'function renderBreadcrumb(context: SurfaceComponentContext): string {\n  const planted = `<input name="scan" required>`;\n  void planted;',
      ),
  },
  {
    expect: 'action',
    name: 'an action button inside the certified renderer',
    plant: (source) =>
      source.replace(
        'function renderBreadcrumb(context: SurfaceComponentContext): string {',
        'function renderBreadcrumb(context: SurfaceComponentContext): string {\n  const planted = `<button type="submit">Go</button>`;\n  void planted;',
      ),
  },
  {
    expect: 'field',
    name: 'a field read through record.values[...]',
    plant: (source) =>
      source.replace(
        'function renderBreadcrumb(context: SurfaceComponentContext): string {',
        'function renderBreadcrumb(context: SurfaceComponentContext): string {\n  void plantedFieldRead({ values: {} });',
      ) +
      '\nconst plantedFieldRead = (record: { values: Record<string, unknown> }) =>\n  record.values["item_name"];\n',
  },
  {
    expect: 'action',
    name: 'a helper moved into an arrow function',
    plant: (source) =>
      source.replace(
        'function renderBreadcrumb(context: SurfaceComponentContext): string {',
        'function renderBreadcrumb(context: SurfaceComponentContext): string {\n  void plantedArrowHelper();',
      ) +
      '\nconst plantedArrowHelper = () => `<button type="button">x</button>`;\n',
  },
]);

test('every predicate fires against a planted violation', () => {
  const source = registrySource();
  const baseline = protectedCategories(
    declarations(source),
    'renderBreadcrumb',
  );
  assert.deepEqual(
    baseline,
    ['link'],
    'the baseline must be the admitted link',
  );
  const survivors: string[] = [];
  for (const mutation of MUTATIONS) {
    const mutated = mutation.plant(source);
    assert.notEqual(
      mutated,
      source,
      `${mutation.name}: the plant did not apply, so this proves nothing`,
    );
    const seen = protectedCategories(declarations(mutated), 'renderBreadcrumb');
    // Baseline-relative: breadcrumb already reaches the admitted `link`, so a
    // plant must ADD its own category rather than merely be present alongside.
    if (!seen.includes(mutation.expect) || baseline.includes(mutation.expect)) {
      // eslint-disable-next-line no-console
      console.log(`SURVIVOR: ${mutation.name} (expected ${mutation.expect})`);
      survivors.push(mutation.name);
    }
  }
  assert.deepEqual(
    survivors,
    [],
    'a planted violation the gate cannot see is a survivor, and the certified renderer is not certified',
  );
});

/**
 * The marker itself must be able to fire, or its absence above means nothing.
 * A deliberately unseeable plant -- a category no predicate watches -- is
 * expected to survive.
 */
test('the SURVIVOR marker fires when a plant is genuinely unseen', () => {
  const bodies = declarations(
    registrySource().replace(
      'function renderBreadcrumb(context: SurfaceComponentContext): string {',
      'function renderBreadcrumb(context: SurfaceComponentContext): string {\n  const planted = `<marquee>unwatched</marquee>`;\n  void planted;',
    ),
  );
  assert.deepEqual(
    protectedCategories(bodies, 'renderBreadcrumb'),
    ['link'],
    'an unwatched category must add nothing, or this harness cannot distinguish a survivor from a catch',
  );
  assert.ok(
    PROTECTED_TOKENS.every(
      ([, token]) => !token.test('<marquee>unwatched</marquee>'),
    ),
    'the unseeable plant must genuinely match no predicate',
  );
});
