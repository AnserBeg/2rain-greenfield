import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  FIELD_BEARING_SURFACE_SLOTS,
  SURFACE_SLOTS,
} from '../../packages/canonical-model/src/index.js';

const REGISTRY_SOURCE = 'apps/web/src/component-registry.ts';

/**
 * The authority for `FIELD_BEARING_SURFACE_SLOTS` is what a slot's registered
 * renderer actually consumes, and this derives that from the renderer rather
 * than restating a hand-kept list.
 *
 * The compiler cannot import `apps/web` -- the dependency direction forbids it,
 * and `check:boundaries` enforces that -- so the set is DECLARED in
 * `canonical-model` and BOUND here, where a test may read both sides.
 *
 * **This is a proxy and not an observation (AGENTS.md §6).** It reads source
 * text, so it follows only statically-resolvable calls. Dynamic dispatch through
 * `componentRegistry[contentReferenceId]` is invisible to it: a shell component
 * reached that way could consume a field without this gate seeing it. What it
 * does prove is that no renderer named in the slot registry reaches a field
 * token by a path a reader could follow -- which is the failure that actually
 * occurred, since `record:titleStatus` reaches `displayFieldId` through exactly
 * such a path and was classified as bearing no field.
 *
 * The observing version would render each `(archetype, slot)` with a sentinel
 * field value and check whether it reaches the HTML. That needs a
 * `RequestRuntimeView` for a record surface, which only the provider builds, so
 * it belongs in `test/postgres` or a browser journey.
 */
const FIELD_TOKENS = /\bfieldIds\b|\bdisplayFieldId\b/u;

function registrySource(): string {
  return readFileSync(REGISTRY_SOURCE, 'utf8');
}

function slotRenderers(source: string): ReadonlyMap<string, string> {
  const renderers = new Map<string, string>();
  for (const entry of source.matchAll(
    /'([a-z]+):([A-Za-z]+)':\s*\{([\s\S]*?)\n {4}\}/gu,
  )) {
    const renderer = /renderer:\s*([A-Za-z_$][\w$]*)/u.exec(entry[3]!);
    if (renderer) renderers.set(`${entry[1]!}:${entry[2]!}`, renderer[1]!);
  }
  return renderers;
}

function functionBody(source: string, name: string): string {
  return (
    new RegExp(`function ${name}\\s*\\([\\s\\S]*?\\n\\}`, 'mu').exec(
      source,
    )?.[0] ?? ''
  );
}

function consumesField(
  source: string,
  name: string,
  seen = new Set<string>(),
): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const body = functionBody(source, name);
  if (body.length === 0) return false;
  if (FIELD_TOKENS.test(body)) return true;
  for (const call of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const callee = call[1]!;
    if (
      callee !== name &&
      new RegExp(`function ${callee}\\s*\\(`, 'u').test(source) &&
      consumesField(source, callee, seen)
    ) {
      return true;
    }
  }
  return false;
}

function derivedFieldBearingSlots(
  source: string,
): Record<string, readonly string[]> {
  const renderers = slotRenderers(source);
  const derived: Record<string, string[]> = Object.fromEntries(
    Object.keys(SURFACE_SLOTS).map((archetype) => [archetype, []]),
  );
  for (const [key, renderer] of [...renderers].sort()) {
    const [archetype, slot] = key.split(':') as [string, string];
    if (consumesField(source, renderer)) derived[archetype]!.push(slot);
  }
  return derived;
}

test('the slot registry is readable, so the derivation has a subject', () => {
  const renderers = slotRenderers(registrySource());
  assert.ok(
    renderers.size >= 8,
    `expected the slot registry to be parsed; read ${String(renderers.size)} entries`,
  );
  assert.ok(renderers.has('record:titleStatus'));
  assert.ok(renderers.has('record:sections'));
});

test('FIELD_BEARING_SURFACE_SLOTS equals what the registered renderers consume', () => {
  const derived = derivedFieldBearingSlots(registrySource());
  const declared = Object.fromEntries(
    Object.entries(FIELD_BEARING_SURFACE_SLOTS).map(([archetype, slots]) => [
      archetype,
      [...slots],
    ]),
  );
  assert.deepEqual(derived, declared);
});

/**
 * The two facts that made the hand-kept list wrong in both directions, asserted
 * directly so a future edit cannot quietly restore either.
 */
test('titleStatus consumes a field and decision does not', () => {
  const source = registrySource();
  assert.ok(
    consumesField(source, 'renderTitleStatus'),
    'renderTitleStatus reaches displayFieldId through recordTitle',
  );
  assert.ok(
    !consumesField(source, 'renderTaskDecision'),
    'renderTaskDecision renders an aggregate result, not a surface field',
  );
});

/**
 * `ownsDataResolution` is a different fact and must never be reintroduced as the
 * authority. Asserted as a DISAGREEMENT rather than a comment: if the two ever
 * coincide again this test fails and the reason is re-examined, rather than the
 * flag silently becoming a plausible substitute.
 */
test('ownsDataResolution is not the field-bearing authority', () => {
  const source = registrySource();
  const owning = new Set<string>();
  for (const entry of source.matchAll(
    /'([a-z]+):([A-Za-z]+)':\s*\{([\s\S]*?)\n {4}\}/gu,
  )) {
    if (/ownsDataResolution:\s*true/u.test(entry[3]!)) {
      owning.add(`${entry[1]!}:${entry[2]!}`);
    }
  }
  const bearing = new Set(
    Object.entries(FIELD_BEARING_SURFACE_SLOTS).flatMap(([archetype, slots]) =>
      slots.map((slot) => `${archetype}:${slot}`),
    ),
  );
  assert.ok(
    owning.size > 0,
    'the flag must be readable for this to mean anything',
  );
  assert.ok(
    owning.has('task:decision') && !bearing.has('task:decision'),
    'task:decision owns data resolution and bears no field',
  );
  assert.ok(
    bearing.has('record:titleStatus') && !owning.has('record:titleStatus'),
    'record:titleStatus bears a field and does not own data resolution',
  );
});
