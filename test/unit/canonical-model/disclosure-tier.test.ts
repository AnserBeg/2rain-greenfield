import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CanonicalModelError,
  canonicalize,
  normalizeApplicationPackage,
  parseAuthoredApplicationPackageJson,
  type VersionedAuthoredApplicationPackage,
} from '../../../packages/canonical-model/src/index.js';

/**
 * `CanonicalModelError` is raised for every canonical rule in the model, so the
 * class alone identifies nothing. Every red below asserts the diagnostic CODE,
 * and the forcing reds additionally assert the `objectId`, so a control cannot
 * pass by failing for a neighbouring reason.
 */
function diagnosticCodes(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (!(error instanceof CanonicalModelError)) throw error;
    return error.diagnostics.map((entry) => entry.code);
  }
  throw new Error('expected normalization to refuse, and it accepted');
}

function fixture(): VersionedAuthoredApplicationPackage {
  return parseAuthoredApplicationPackageJson(
    readFileSync('test/fixtures/canonical-model/representative.authored.json'),
  );
}

/**
 * The fixture's `item_get` selects `item_name` and `item_status`, neither of
 * which authors a `presence`, so normalization defaults both to `optional` and
 * the record surface reaches NO forcing field. That absence is what makes the
 * same fixture serve both directions of the rule.
 */
function nonForcing(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture())) as Record<string, unknown>;
}

function forcing(): Record<string, unknown> {
  const authored = nonForcing();
  const fields = authored.fields as { fieldId: string; presence?: string }[];
  const selected = fields.find(
    (field) => field.fieldId === 'northstar.inventory:field.item_name',
  );
  assert.ok(selected, 'fixture must still declare item_name');
  selected.presence = 'required';
  return authored;
}

/** `record:sections` renders the surface's fields; `record:titleStatus` does not. */
const SECTIONS_SLOT = 'northstar.inventory:slot.item_sections';
const TITLE_STATUS_SLOT = 'northstar.inventory:slot.item_title_status';

function withTier(
  authored: Record<string, unknown>,
  tier: string,
  slotId: string = SECTIONS_SLOT,
): Record<string, unknown> {
  const surfaces = authored.surfaces as {
    slots: { slotId: string; disclosureTier?: string }[];
  }[];
  const slot = surfaces[0]!.slots.find(
    (candidate) => candidate.slotId === slotId,
  );
  assert.ok(slot, `fixture must still declare ${slotId}`);
  slot.disclosureTier = tier;
  return authored;
}

function normalizedSlots(
  authored: Record<string, unknown>,
): { slotId: string; disclosureTier?: string }[] {
  const normalized = normalizeApplicationPackage(authored) as unknown as {
    surfaces: { slots: { slotId: string; disclosureTier?: string }[] }[];
  };
  return normalized.surfaces[0]!.slots;
}

test('an absent disclosure tier stays absent through normalization', () => {
  const slots = normalizedSlots(nonForcing());
  assert.ok(slots.length > 0, 'the rule must read a non-empty slot set');
  for (const slot of slots) {
    assert.ok(
      !Object.hasOwn(slot, 'disclosureTier'),
      `${slot.slotId} gained a materialized tier`,
    );
  }
});

/**
 * The negative control for the invariant above, and the one that matters most:
 * if normalization ever materializes the default, these two byte strings become
 * equal and every recorded release root moves. Recorded as an executed
 * difference rather than a comment, because "we did not materialize it" is
 * otherwise unobservable.
 */
test('materializing the default would move the normalized bytes', () => {
  const absent = canonicalize(normalizeApplicationPackage(nonForcing()));
  const materialized = canonicalize(
    normalizeApplicationPackage(withTier(nonForcing(), 'always')),
  );
  assert.notEqual(
    absent,
    materialized,
    'an explicit always must differ from an absent tier, or absence is not preserved',
  );
  assert.ok(!absent.includes('disclosureTier'));
  assert.ok(materialized.includes('disclosureTier'));
});

test('always is accepted on a slot that reaches a required field', () => {
  const slots = normalizedSlots(withTier(forcing(), 'always'));
  const slot = slots.find((entry) => entry.slotId === SECTIONS_SLOT);
  assert.equal(slot?.disclosureTier, 'always');
});

test('RED: progressive on a slot reaching a required field is refused', () => {
  const codes = diagnosticCodes(() =>
    normalizeApplicationPackage(withTier(forcing(), 'progressive')),
  );
  assert.deepEqual(codes, ['CANON_SURFACE_DISCLOSURE_TIER_FORCED_ALWAYS']);
});

test('RED: the forcing refusal names the offending slot, not the surface', () => {
  try {
    normalizeApplicationPackage(withTier(forcing(), 'progressive'));
    throw new Error('expected normalization to refuse, and it accepted');
  } catch (error) {
    assert.ok(error instanceof CanonicalModelError);
    const refusal = error.diagnostics.find(
      (entry) => entry.code === 'CANON_SURFACE_DISCLOSURE_TIER_FORCED_ALWAYS',
    );
    assert.equal(refusal?.objectId, SECTIONS_SLOT);
    assert.equal(refusal?.path, '$.surfaces.slots.disclosureTier');
    assert.match(refusal?.rule ?? '', /item_name/u);
  }
});

/**
 * The vacuity control for the forcing rule. Without it, an implementation that
 * refused EVERY `progressive` would pass the red above and be indistinguishable
 * from the rule this packet was asked for. The subject is identical except that
 * no selected field is required.
 */
test('CONTROL: progressive is accepted where no reachable field forces always', () => {
  const slots = normalizedSlots(withTier(nonForcing(), 'progressive'));
  const slot = slots.find((entry) => entry.slotId === SECTIONS_SLOT);
  assert.equal(
    slot?.disclosureTier,
    'progressive',
    'the rule must read the forcing set, not the word progressive',
  );
});

/**
 * The vacuity control for the field-bearing narrowing, and the reason the
 * narrowing exists. `titleStatus` renders no field, so deferring it conceals
 * nothing -- even on a surface that reaches a required field. Without this the
 * rule is per-surface, and `progressive` is unusable on every record surface in
 * the composed application, all of which reach one of its 50 required fields.
 */
test('CONTROL: a non-field-bearing slot may defer even on a forcing surface', () => {
  const slots = normalizedSlots(
    withTier(forcing(), 'progressive', TITLE_STATUS_SLOT),
  );
  const slot = slots.find((entry) => entry.slotId === TITLE_STATUS_SLOT);
  assert.equal(
    slot?.disclosureTier,
    'progressive',
    'titleStatus renders no field, so no forcing field can be concealed by deferring it',
  );
});

test('RED: onDemand is refused even where nothing forces always', () => {
  const codes = diagnosticCodes(() =>
    normalizeApplicationPackage(withTier(nonForcing(), 'onDemand')),
  );
  assert.deepEqual(
    codes,
    ['CANON_SURFACE_DISCLOSURE_TIER_UNHONOURED'],
    'onDemand is unhonourable everywhere, so it must not depend on the forcing set',
  );
});

/**
 * Ordering matters for the author, not just for us: on a forcing slot,
 * `onDemand` is wrong for a reason that has nothing to do with the forcing set,
 * and reporting FORCED_ALWAYS would send them to change the wrong thing.
 */
test('RED: onDemand on a forcing slot still refuses as unhonoured', () => {
  const codes = diagnosticCodes(() =>
    normalizeApplicationPackage(withTier(forcing(), 'onDemand')),
  );
  assert.deepEqual(codes, ['CANON_SURFACE_DISCLOSURE_TIER_UNHONOURED']);
});

test('RED: an unknown tier never reaches the rule at all', () => {
  const codes = diagnosticCodes(() =>
    normalizeApplicationPackage(withTier(nonForcing(), 'whenConvenient')),
  );
  assert.ok(
    codes.includes('CANON_SCHEMA_INVALID'),
    `closed vocabulary must be refused by the schema; got ${codes.join(', ')}`,
  );
});
