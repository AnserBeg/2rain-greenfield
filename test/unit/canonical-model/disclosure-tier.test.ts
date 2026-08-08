import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ADOPTED_LANGUAGE_VERSION,
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

/**
 * Authored at the ADOPTED language version, not at the version the shared
 * fixture happens to carry. ADR-0047 §7: a rule proven at a superseded version
 * proves the widening, not the rule.
 *
 * The extra slots exist so the unconditional refusal has subjects across the
 * range it now covers -- a slot that renders shell furniture (`commandBar`), one
 * that renders only navigation (`breadcrumb`), and a task surface whose
 * `scanInput` and `primaryAction` an aggregate query would leave un-forced under
 * any field-based rule. None of them is deferrable: `progressive` is refused
 * everywhere, so what these subjects prove is that the refusal does not depend
 * on what a slot renders.
 */
function fixture(): VersionedAuthoredApplicationPackage {
  const shared = readFileSync(
    'test/fixtures/canonical-model/representative.authored.json',
    'utf8',
  );
  const upgraded = JSON.parse(
    shared.replaceAll('"v3"', `"${ADOPTED_LANGUAGE_VERSION}"`),
  ) as { surfaces: { slots: Record<string, unknown>[] }[] };
  const slots = upgraded.surfaces[0]!.slots;
  const content = { ...(slots[0]!.content as Record<string, unknown>) };
  const addSlot = (slot: string, slotId: string, orderKey: number) => {
    slots.push({
      content,
      kind: 'surfaceSlot',
      orderKey,
      schemaVersion: ADOPTED_LANGUAGE_VERSION,
      slot,
      slotId,
    });
  };
  addSlot('commandBar', COMMAND_BAR_SLOT, 30);
  addSlot('breadcrumb', BREADCRUMB_SLOT, 40);
  // A task surface, so the aggregate-task hole has subjects. Its query selects
  // nothing forcing, which is exactly the shape the old deny-list let through:
  // `selections = []` meant nothing forced, while `scanInput` still renders
  // required inputs and `primaryAction` still renders the submit control.
  (
    upgraded as unknown as { surfaces: Record<string, unknown>[] }
  ).surfaces.push({
    archetype: 'task',
    dataSource: {
      ...((upgraded.surfaces[0]! as unknown as { dataSource: unknown })
        .dataSource as Record<string, unknown>),
    },
    kind: 'surfaceDefinition',
    label: 'Item lookup',
    module: {
      ...((upgraded.surfaces[0]! as unknown as { module: unknown })
        .module as Record<string, unknown>),
    },
    schemaVersion: ADOPTED_LANGUAGE_VERSION,
    slots: [
      {
        content,
        kind: 'surfaceSlot',
        orderKey: 10,
        schemaVersion: ADOPTED_LANGUAGE_VERSION,
        slot: 'scanInput',
        slotId: SCAN_INPUT_SLOT,
      },
      {
        content,
        kind: 'surfaceSlot',
        orderKey: 20,
        schemaVersion: ADOPTED_LANGUAGE_VERSION,
        slot: 'primaryAction',
        slotId: PRIMARY_ACTION_SLOT,
      },
    ],
    statusRoles: [],
    surfaceId: 'northstar.inventory:surface.item_lookup',
  });
  return parseAuthoredApplicationPackageJson(
    Buffer.from(JSON.stringify(upgraded)),
  );
}

test('the fixture is authored at the adopted language version', () => {
  const authored = fixture() as unknown as { languageVersion: string };
  assert.equal(
    authored.languageVersion,
    ADOPTED_LANGUAGE_VERSION,
    'a rule proven at a superseded version proves the widening, not the rule',
  );
});

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

/**
 * Subjects spanning what a slot may render -- fields, shell furniture, pure
 * navigation, required inputs, a submit control. `progressive` is refused on
 * every one of them, which is what makes the refusal unconditional rather than
 * a narrower rule wearing a broader name.
 */
const SECTIONS_SLOT = 'northstar.inventory:slot.item_sections';
const TITLE_STATUS_SLOT = 'northstar.inventory:slot.item_title_status';
const COMMAND_BAR_SLOT = 'northstar.inventory:slot.item_command_bar';
const BREADCRUMB_SLOT = 'northstar.inventory:slot.item_breadcrumb';
const SCAN_INPUT_SLOT = 'northstar.inventory:slot.item_scan_input';
const PRIMARY_ACTION_SLOT = 'northstar.inventory:slot.item_primary_action';

function withTier(
  authored: Record<string, unknown>,
  tier: string,
  slotId: string = SECTIONS_SLOT,
): Record<string, unknown> {
  const surfaces = authored.surfaces as {
    slots: { slotId: string; disclosureTier?: string }[];
  }[];
  const slot = surfaces
    .flatMap((surface) => surface.slots)
    .find((candidate) => candidate.slotId === slotId);
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
  return normalized.surfaces.flatMap((surface) => surface.slots);
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

test('always is accepted on any slot', () => {
  const slots = normalizedSlots(withTier(forcing(), 'always'));
  const slot = slots.find((entry) => entry.slotId === SECTIONS_SLOT);
  assert.equal(slot?.disclosureTier, 'always');
});

/**
 * A DELIBERATE REVERSAL. `record:breadcrumb` was the last admitted member and is
 * now refused like every other slot. It was admitted by ruling rather than
 * proof: the source-text gate could not distinguish its `<a href>` from
 * `list:title`'s `<a class="primary-action">New</a>`. Rather than buy a fifth
 * predicate, the tier is refused outright.
 */
test('RED: progressive on breadcrumb is refused, reversing its former admission', () => {
  const codes = diagnosticCodes(() =>
    normalizeApplicationPackage(
      withTier(nonForcing(), 'progressive', BREADCRUMB_SLOT),
    ),
  );
  assert.deepEqual(codes, ['CANON_SURFACE_DISCLOSURE_TIER_NOT_DEFERRABLE']);
});

/**
 * The inversion's core red, and it no longer depends on the surface reaching a
 * required field. `record:sections` renders the surface's fields, so it is
 * refused like every other slot, and no longer needs the surface to reach a
 * required field for the rule to fire.
 */
test('RED: progressive on a field-rendering slot is refused as not deferrable', () => {
  const codes = diagnosticCodes(() =>
    normalizeApplicationPackage(withTier(nonForcing(), 'progressive')),
  );
  assert.deepEqual(codes, ['CANON_SURFACE_DISCLOSURE_TIER_NOT_DEFERRABLE']);
});

test('RED: the refusal names the offending slot, not the surface', () => {
  try {
    normalizeApplicationPackage(withTier(nonForcing(), 'progressive'));
    throw new Error('expected normalization to refuse, and it accepted');
  } catch (error) {
    assert.ok(error instanceof CanonicalModelError);
    const refusal = error.diagnostics.find(
      (entry) => entry.code === 'CANON_SURFACE_DISCLOSURE_TIER_NOT_DEFERRABLE',
    );
    assert.equal(refusal?.objectId, SECTIONS_SLOT);
    assert.equal(refusal?.path, '$.surfaces.slots.disclosureTier');
  }
});

test('RED: progressive on titleStatus is refused, because it renders the display field', () => {
  const codes = diagnosticCodes(() =>
    normalizeApplicationPackage(
      withTier(nonForcing(), 'progressive', TITLE_STATUS_SLOT),
    ),
  );
  assert.deepEqual(codes, ['CANON_SURFACE_DISCLOSURE_TIER_NOT_DEFERRABLE']);
});

/**
 * The aggregate-task hole, which the deny-list could not close. An aggregate
 * surface selects no field, so under the old rule NOTHING forced -- while
 * `scanInput` still rendered the query's parameters as required inputs and
 * `primaryAction` still rendered the submit control. Under the unconditional
 * refusal both are refused, without the rule needing to know either fact.
 */
test('RED: progressive on task scanInput is refused', () => {
  const codes = diagnosticCodes(() =>
    normalizeApplicationPackage(
      withTier(nonForcing(), 'progressive', SCAN_INPUT_SLOT),
    ),
  );
  assert.deepEqual(codes, ['CANON_SURFACE_DISCLOSURE_TIER_NOT_DEFERRABLE']);
});

test('RED: progressive on task primaryAction is refused', () => {
  const codes = diagnosticCodes(() =>
    normalizeApplicationPackage(
      withTier(nonForcing(), 'progressive', PRIMARY_ACTION_SLOT),
    ),
  );
  assert.deepEqual(codes, ['CANON_SURFACE_DISCLOSURE_TIER_NOT_DEFERRABLE']);
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

/**
 * `commandBar` was briefly a conditional member and is now simply refused.
 * `renderCommandBar` emits `<button type="submit">Save</button>` whenever the
 * surface role is `form`, so deferring it defers the primary action -- with no
 * confirmed operation anywhere.
 */
test('RED: progressive on commandBar is refused, with no conditional arm', () => {
  const codes = diagnosticCodes(() =>
    normalizeApplicationPackage(
      withTier(nonForcing(), 'progressive', COMMAND_BAR_SLOT),
    ),
  );
  assert.deepEqual(codes, ['CANON_SURFACE_DISCLOSURE_TIER_NOT_DEFERRABLE']);
});
