import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PROVEN_DEFERRABLE_SURFACE_SLOTS } from '../../packages/canonical-model/src/index.js';

const REGISTRY_SOURCE = 'apps/web/src/component-registry.ts';

/**
 * `PROVEN_DEFERRABLE_SURFACE_SLOTS` is an ALLOW-list, and this proves each
 * member against the renderer that justifies it.
 *
 * The inversion is what makes this gate tractable. Under the previous deny-list
 * the gate had to prove a walk EXHAUSTIVE -- every path from every renderer to
 * every field token, including paths through
 * `componentRegistry[contentReferenceId]` that no source walk can follow. It
 * could not, and the unprovable case silently defaulted to deferrable. Inverted,
 * the gate proves a handful of slots render nothing protected and everything
 * else forces by default, so an incomplete walk costs over-disclosure instead of
 * concealment.
 *
 * The compiler cannot import `apps/web` -- `check:boundaries` enforces the
 * dependency direction -- so the set is DECLARED in `canonical-model` and BOUND
 * here, where a test may read both sides.
 */
const FIELD_TOKENS = /\bfieldIds\b|\bdisplayFieldId\b/u;
const DYNAMIC_DISPATCH = /\brenderReferencedComponent\s*\(/u;

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

function reaches(
  source: string,
  name: string,
  token: RegExp,
  seen = new Set<string>(),
): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const body = functionBody(source, name);
  if (body.length === 0) return false;
  if (token.test(body)) return true;
  for (const call of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const callee = call[1]!;
    if (
      callee !== name &&
      new RegExp(`function ${callee}\\s*\\(`, 'u').test(source) &&
      reaches(source, callee, token, seen)
    ) {
      return true;
    }
  }
  return false;
}

function deferrableKeys(): readonly string[] {
  return Object.entries(PROVEN_DEFERRABLE_SURFACE_SLOTS).flatMap(
    ([archetype, slots]) =>
      Object.keys(slots as Record<string, string>).map(
        (slot) => `${archetype}:${slot}`,
      ),
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

test('no proven-deferrable slot consumes a surface field', () => {
  const source = registrySource();
  const renderers = slotRenderers(source);
  assert.ok(deferrableKeys().length > 0, 'the allow-list must have members');
  for (const key of deferrableKeys()) {
    const renderer = renderers.get(key)!;
    assert.ok(
      !reaches(source, renderer, FIELD_TOKENS),
      `${key} (${renderer}) reaches a field token and cannot be deferrable`,
    );
  }
});

/**
 * The assertion that retires the previous round's unfollowable-edge finding. A
 * slot whose renderer can reach `renderReferencedComponent` dispatches on a
 * runtime key, so no static reading can prove what it renders. Under the
 * allow-list that is not a gap to document -- it is a disqualification.
 */
test('no proven-deferrable slot can reach dynamic dispatch', () => {
  const source = registrySource();
  const renderers = slotRenderers(source);
  for (const key of deferrableKeys()) {
    const renderer = renderers.get(key)!;
    assert.ok(
      !reaches(source, renderer, DYNAMIC_DISPATCH),
      `${key} (${renderer}) reaches renderReferencedComponent, so it can never be proven safe`,
    );
  }
});

/**
 * The other direction, and the one that would catch a member added without its
 * proof: every registered slot that consumes a field or dispatches dynamically
 * must be absent from the allow-list.
 */
test('every field-consuming or dynamically dispatched slot is excluded', () => {
  const source = registrySource();
  const deferrable = new Set(deferrableKeys());
  const excluded: string[] = [];
  for (const [key, renderer] of slotRenderers(source)) {
    if (
      reaches(source, renderer, FIELD_TOKENS) ||
      reaches(source, renderer, DYNAMIC_DISPATCH)
    ) {
      excluded.push(key);
      assert.ok(
        !deferrable.has(key),
        `${key} renders protected content or dispatches dynamically, yet is declared deferrable`,
      );
    }
  }
  assert.ok(
    excluded.length >= 6,
    `expected the exclusion to have real subjects; found ${String(excluded.length)}`,
  );
  for (const key of [
    'record:titleStatus',
    'record:sections',
    'record:keyFacts',
    'list:dataGrid',
    'task:decision',
    'task:scanInput',
    'task:primaryAction',
  ]) {
    assert.ok(excluded.includes(key), `${key} must be excluded`);
  }
});

/**
 * The shortfall, asserted rather than only written down. The set is two slots on
 * one archetype and it is expected to stay that way; a packet that grows it must
 * come through this test and restate the size deliberately.
 */
test('the proven-deferrable set is as small as the report claims', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(PROVEN_DEFERRABLE_SURFACE_SLOTS).map(
        ([archetype, slots]) => [
          archetype,
          Object.keys(slots as Record<string, string>),
        ],
      ),
    ),
    {
      builder: [],
      home: [],
      list: [],
      record: ['breadcrumb', 'commandBar'],
      task: [],
    },
    'progressive applies to two slots on one archetype; §3.2 wants per-field and per-section, and slot granularity cannot express it',
  );
});
