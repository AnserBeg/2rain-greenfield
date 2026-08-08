import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCLOSURE_TIERS } from '../../packages/canonical-model/src/index.js';
import {
  ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  COMPILER_SEMANTIC_PROFILE_VERSION,
  PROJECTION_FAMILY_IDS,
  SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS,
  type CompilerSemanticProfileVersion,
} from '../../packages/compiler/src/index.js';

import {
  compilerInput,
  fixtureBytes,
  mustCompile,
  projectionPayload,
} from './helpers.js';

interface ManifestSlot {
  readonly disclosureTier?: string;
  readonly slotId: string;
}

interface SurfaceManifest {
  readonly surfaces: readonly { readonly slots: readonly ManifestSlot[] }[];
}

function manifestSlotsAt(
  version: CompilerSemanticProfileVersion,
): readonly ManifestSlot[] {
  const base = compilerInput(fixtureBytes('vertical-v1'));
  const compiled = mustCompile({
    ...base,
    profile: { ...base.profile, compilerSemanticProfileVersion: version },
  });
  const manifest = projectionPayload<SurfaceManifest>(
    compiled,
    PROJECTION_FAMILY_IDS.surfaceManifest,
  );
  return manifest.surfaces.flatMap((surface) => surface.slots);
}

/**
 * The property this packet actually depends on. `U5-design` measured that a
 * field gated on the ADOPTED version fails `check:app-release` outright, and
 * that the same field gated on a cut-but-unadopted version leaves the lineage
 * byte-identical. This asserts the constant that keeps us on the safe side of
 * that line, directly rather than through a compile -- a compile derives its
 * profile from the artifact and cannot see this constant move.
 */
test('compiler-semantic v2 is readable and NOT adopted', () => {
  assert.ok(
    SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS.includes(
      COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    ),
    'v2 must be readable',
  );
  assert.equal(
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
    'adopting v2 mints a lineage entry and moves 7 pinned expectations; U5b does not adopt',
  );
});

test('the axis stays append-only when v2 is cut', () => {
  assert.deepEqual(
    [...SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS],
    [
      COMPILER_SEMANTIC_PROFILE_VERSION,
      COMPILER_SEMANTIC_PROFILE_V1_VERSION,
      COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    ],
    'cutting a version appends; it never renames or drops an existing one',
  );
});

test('the disclosure tier is emitted at v2 and at no earlier version', () => {
  const atV2 = manifestSlotsAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION);
  assert.ok(atV2.length > 0, 'the fixture must contribute slots to read');
  for (const slot of atV2) {
    assert.equal(
      slot.disclosureTier,
      'always',
      `${slot.slotId} must resolve an undeclared tier to always at v2`,
    );
  }

  // The half that protects the recorded lineage: every entry on disk was
  // compiled at v0 or v1, so the field must be absent at both or reproduction
  // of those entries changes.
  for (const earlier of [
    COMPILER_SEMANTIC_PROFILE_VERSION,
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  ]) {
    const slots = manifestSlotsAt(earlier);
    assert.ok(slots.length > 0);
    for (const slot of slots) {
      assert.ok(
        !Object.hasOwn(slot, 'disclosureTier'),
        `${slot.slotId} leaked a tier into ${earlier}, which every recorded entry reproduces under`,
      );
    }
  }
});

/**
 * Resolution happens at projection time, not in the normalized definition. This
 * separates "the tier is absent from the definition" from "the tier is absent
 * from the projection" -- they are different facts, and conflating them is how a
 * materialized default would slip past the canonical-model control.
 */
test('an undeclared tier resolves in the projection while staying absent upstream', () => {
  const base = compilerInput(fixtureBytes('vertical-v1'));
  const normalized = new TextDecoder().decode(base.normalizedDefinitionBytes);
  assert.ok(
    !normalized.includes('disclosureTier'),
    'the normalized definition must not carry a tier the author never declared',
  );
  assert.ok(
    manifestSlotsAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION).every(
      (slot) => slot.disclosureTier === 'always',
    ),
  );
});

/**
 * The `minimumVersion` reasoning recorded at `surfaceManifestPayload`'s emission
 * site is conditional, and this makes the condition executable rather than a
 * comment someone has to remember.
 *
 * That reasoning holds because every tier a reader might DROP resolves to more
 * disclosure, never less: an absent tier reads as `always`, so a reader that
 * ignores the field under-defers rather than conceals. A fourth spelling meaning
 * "hide" would invert that and silently invalidate the emission site's argument
 * without touching this projection at all. Pinning the exact set forces whoever
 * adds one to come back here.
 */
test('the tier vocabulary is exactly the three granted values', () => {
  assert.deepEqual(
    [...DISCLOSURE_TIERS],
    ['always', 'progressive', 'onDemand'],
    'surfaceManifestPayload keeps surface-manifest minimumVersion at 1 because no tier value means "hide" -- a reader that drops the field under-defers rather than conceals. Adding a tier requires re-deriving that argument at the emission site before changing this list.',
  );
});
