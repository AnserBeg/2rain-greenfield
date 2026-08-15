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

function surfaceProjectionReference(version: CompilerSemanticProfileVersion) {
  const base = compilerInput(fixtureBytes('vertical-v1'));
  const compiled = mustCompile({
    ...base,
    profile: { ...base.profile, compilerSemanticProfileVersion: version },
  });
  const reference = compiled.bundle.releaseManifest.projections.find(
    (entry) => entry.familyId === PROJECTION_FAMILY_IDS.surfaceManifest,
  );
  assert.ok(reference, 'the surface manifest must be projected');
  return reference;
}

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
 * CORRECTED BY `profile-v2-adoption`, and the correction is the point.
 *
 * `U5b` wrote this as an adoption RATCHET: it pinned `ADOPTED === v1` so no
 * packet could adopt v2 without first being made to look at the consequences.
 * It did its job. This packet adopted deliberately, measured the consequences,
 * and corrected the assertions the move made red.
 *
 * The ratchet is INVERTED rather than deleted, because the property it guards
 * has an edge on both sides. `U5-design` measured that a projection field gated
 * on the ADOPTED version fails `check:app-release` outright, while the same
 * field gated on a cut-but-unadopted version leaves the lineage byte-identical.
 * Before adoption, readable-and-unadopted was the safe side. After adoption the
 * safe side is that v2 is BOTH readable and adopted -- a supported list that has
 * dropped its adopted member is exactly the fail-closed programming error
 * `selectAdoptedProfileVersion` exists to raise.
 *
 * Asserted against the constants directly rather than through a compile: a
 * compile derives its profile from the artifact and cannot see this constant
 * move.
 */
test('compiler-semantic v2 is readable and adopted', () => {
  assert.ok(
    SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS.includes(
      COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    ),
    'v2 must be readable',
  );
  assert.equal(
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    'profile-v2-adoption moved the adopted constant to v2, so the tier now reaches the compiled artifact',
  );
  assert.notEqual(
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
    'v1 is history now, and history is read from each entry attestation, never from this constant',
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
 * The `minimumVersion` argument recorded at `surfaceManifestPayload`'s emission
 * site, asserted where it actually lives.
 *
 * The argument has two halves and each needs its own assertion. Its PREMISE is
 * that no tier value means "hide" -- a reader that drops the field under-defers
 * rather than conceals -- and a fourth spelling would invert that silently. Its
 * CONCLUSION is the emitted number. The vocabulary test below closes the
 * premise; this closes the conclusion, which was previously guarded by nothing:
 * raising flat v2 from 1 to 2 survived every other control in this packet.
 */
/**
 * **`U5b`'s argument is unchanged; its conclusion no longer decides the floor.**
 * Corrected by `ux-picker`, which put a second field on v2.
 *
 * The tier reasoning still holds exactly as written: a reader that drops
 * `disclosureTier` renders every slot expanded, which is what `always` means, so
 * it under-defers rather than conceals, and the tier alone never needed a
 * version. But v2 now also carries `fields`, and a reader that cannot read those
 * must refuse the payload rather than render a form it cannot describe -- so any
 * v2 projection requires version 3.
 *
 * This assertion is now about what v2 CARRIES, not about the tier. Remove
 * `fields` from v2 and the tier argument puts it back at 1 on its own reasoning.
 */
test('a v2 surface projection requires the capability version its fields need', () => {
  assert.deepEqual(
    surfaceProjectionReference(COMPILER_SEMANTIC_PROFILE_V2_VERSION)
      .requiredRuntimeCapability,
    {
      capabilityId: 'northstar.runtime:capability.surface-manifest',
      minimumVersion: 3,
    },
    'v2 carries per-field kinds; a reader that cannot read them must refuse rather than render a form it cannot describe',
  );
});

/**
 * The premise of the argument above. A fourth spelling meaning "hide" would
 * invert it -- a dropped tier would then conceal rather than reveal -- without
 * touching the projection at all, so pinning the exact set forces whoever adds
 * one to re-derive the conclusion first.
 */
test('the tier vocabulary is exactly the three granted values', () => {
  assert.deepEqual(
    [...DISCLOSURE_TIERS],
    ['always', 'progressive', 'onDemand'],
    'the tier does not raise the surface-manifest floor because no tier value means "hide". Adding a tier requires re-deriving that argument before changing this list, independently of the version `fields` now allocates.',
  );
});
