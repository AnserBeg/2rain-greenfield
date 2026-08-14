import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  PROJECTION_FAMILY_IDS,
  type CompilerSemanticProfileVersion,
} from '../../packages/compiler/src/index.js';
import {
  EVERY_KIND_FIELD_IDS,
  everyFieldKindModule,
} from '../fixtures/g2/module-conformance/field-kinds.js';

import {
  compilerInput,
  mustCompile,
  normalizedBytes,
  projectionPayload,
} from './helpers.js';

interface ManifestField {
  readonly fieldId: string;
  readonly kind: string;
  readonly options?: readonly {
    readonly label: string;
    readonly optionId: string;
  }[];
  readonly required: boolean;
  readonly temporal?: {
    readonly precision: string | null;
    readonly timezoneSemantics: string;
  };
}

interface ManifestSurface {
  readonly fieldIds: readonly string[];
  readonly fields?: readonly ManifestField[];
  readonly surfaceId: string;
}

const FORM_SURFACE = 'northstar.modulefixture:surface.master_form';

function compileAt(version: CompilerSemanticProfileVersion) {
  const base = compilerInput(normalizedBytes(everyFieldKindModule()));
  return mustCompile({
    ...base,
    profile: { ...base.profile, compilerSemanticProfileVersion: version },
  });
}

function surfacesAt(
  version: CompilerSemanticProfileVersion,
): readonly ManifestSurface[] {
  return projectionPayload<{ readonly surfaces: readonly ManifestSurface[] }>(
    compileAt(version),
    PROJECTION_FAMILY_IDS.surfaceManifest,
  ).surfaces;
}

function formSurface(version: CompilerSemanticProfileVersion): ManifestSurface {
  const surface = surfacesAt(version).find(
    (entry) => entry.surfaceId === FORM_SURFACE,
  );
  assert.ok(surface, 'the fixture must still project its form surface');
  return surface;
}

/**
 * CORRECTED BY `profile-v2-adoption`. This was an adoption ratchet asserting
 * `ADOPTED !== v2`, so that the packet which adopted would be forced to come
 * here and look. It worked; this is that packet.
 *
 * What the ratchet protected is unchanged and still gated below: the per-field
 * kinds ride v2 and reach NO profile earlier than v2, so every recorded entry
 * compiled under v0 or v1 still reproduces its stored root. What changed is only
 * which side of the line the adopted constant sits on.
 */
test('per-field kinds ride compiler-semantic v2, which is now adopted', () => {
  assert.equal(
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    'profile-v2-adoption moved the constant; per-field kinds now reach the serving head',
  );
});

/**
 * The refusal half: the gated shape reaches no EARLIER profile. Every surface in
 * a v1 manifest lacks the key ENTIRELY -- `Object.hasOwn`, not a falsy read,
 * because an empty array would also be a new byte in every projection and would
 * move the recorded roots this gate exists to protect.
 *
 * PINNED TO v1 LITERALLY by `profile-v2-adoption`, not read from the adopted
 * constant. Before adoption those were the same version and the distinction did
 * not matter; now they are different, and the fact worth gating is the one about
 * the HISTORICAL profile -- entries 0-8 are recorded under v0/v1 and must keep
 * reproducing. Reading the adopted constant here would silently retarget the
 * gate at whatever is adopted next and stop guarding history at all.
 */
test('a pre-v2 profile emits no per-field kinds at all', () => {
  const surfaces = surfacesAt(COMPILER_SEMANTIC_PROFILE_V1_VERSION);
  assert.ok(surfaces.length > 0, 'the fixture must project surfaces');
  for (const surface of surfaces) {
    assert.equal(
      Object.hasOwn(surface, 'fields'),
      false,
      `${surface.surfaceId} must carry no compiled field kinds at v1`,
    );
  }
});

/**
 * The admission twin. Without it the refusal above is satisfied by a projection
 * that emits nothing under any version -- which is exactly what this file
 * looked like before the packet.
 */
test('v2 emits one field entry per selected field, in the same order', () => {
  const surface = formSurface(COMPILER_SEMANTIC_PROFILE_V2_VERSION);
  assert.ok(surface.fields, 'v2 must carry compiled field kinds');
  assert.deepEqual(
    surface.fields.map((field) => field.fieldId),
    [...surface.fieldIds],
  );
});

/**
 * Gating protects the roots only if the gated bytes are real. Two compiles of
 * ONE package differing only in profile version must produce different release
 * roots; if they did not, the emission would be doing nothing and every
 * assertion above would pass vacuously.
 *
 * REPOINTED TO v1 BY `profile-v2-adoption`, and this is the whole reason the
 * repointing matters. The comparison used to read the adopted constant; adoption
 * made that constant v2, so the assertion would have compiled the SAME profile
 * twice and asserted a release root differs from itself. That is precisely the
 * tautology review caught in `relation-target-projection.test.ts` in the other
 * direction on 2026-08-10, where `catalogAt(ADOPTED)` vs `catalogAt(V1)` was one
 * compilation compared with itself.
 *
 * The general hazard, worth stating once: an assertion whose two sides are the
 * adopted constant and a literal version is one adoption away from becoming a
 * tautology, and it goes green rather than red when it does. Pin BOTH sides to
 * literals whenever the property is about the difference between two versions.
 */
test('the v2 release root differs from the v1 root for the same package', () => {
  assert.notEqual(
    compileAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION).releaseRoot,
    compileAt(COMPILER_SEMANTIC_PROFILE_V1_VERSION).releaseRoot,
  );
});

test('every declared field kind reaches the manifest verbatim', () => {
  const fields = new Map(
    formSurface(COMPILER_SEMANTIC_PROFILE_V2_VERSION).fields?.map((field) => [
      field.fieldId,
      field,
    ]),
  );
  // Read off the fixture's declarations rather than off the projection: the
  // expectation must come from what the package SAYS, never from the artifact
  // under test.
  const declared = new Map(
    (
      everyFieldKindModule().fields as readonly {
        readonly fieldId: string;
        readonly fieldType: { readonly kind: string };
      }[]
    ).map((field) => [field.fieldId, field.fieldType.kind]),
  );
  assert.ok(fields.size > 0, 'the form surface must select fields');
  for (const [fieldId, field] of fields) {
    assert.equal(field.kind, declared.get(fieldId), fieldId);
  }
  assert.deepEqual(
    [...new Set([...fields.values()].map((field) => field.kind))].sort(),
    [...new Set(declared.values())].sort(),
    'the form surface must exercise every kind the fixture declares',
  );
});

/**
 * The discriminants a review blocked the first cut for omitting. `kind` alone
 * does not say whether a time is second or millisecond precise, nor whether a
 * date-time is a UTC instant or carries a real offset -- and a control chosen
 * without them cannot express the stored value at all.
 *
 * Read off the fixture's declarations, never off the artifact under test.
 */
test('temporal precision and timezone semantics are carried, and only for temporal kinds', () => {
  const fields = new Map(
    formSurface(COMPILER_SEMANTIC_PROFILE_V2_VERSION).fields?.map((field) => [
      field.fieldId,
      field,
    ]),
  );
  const declared = new Map(
    (
      everyFieldKindModule().fields as readonly {
        readonly fieldId: string;
        readonly fieldType: Record<string, unknown>;
      }[]
    ).map((field) => [field.fieldId, field.fieldType]),
  );
  const temporalKinds = new Set([
    'dateFieldType',
    'dateTimeFieldType',
    'timeFieldType',
  ]);
  let temporalRead = 0;
  for (const [fieldId, field] of fields) {
    assert.equal(
      Object.hasOwn(field, 'temporal'),
      temporalKinds.has(field.kind),
      `${fieldId} carries a temporal domain exactly when it is temporal`,
    );
    if (!temporalKinds.has(field.kind)) continue;
    temporalRead += 1;
    const source = declared.get(fieldId);
    assert.ok(source);
    assert.equal(
      field.temporal?.precision,
      field.kind === 'dateFieldType' ? null : source.precision,
      fieldId,
    );
    assert.equal(
      field.temporal?.timezoneSemantics,
      field.kind === 'dateFieldType'
        ? 'calendarDate'
        : field.kind === 'timeFieldType'
          ? 'localWallTime'
          : source.timezoneSemantics,
      fieldId,
    );
  }
  // Both values of both discriminants must be present, or a hardcoded projection
  // would pass: second AND millisecond, utcInstant AND offsetDateTime.
  assert.ok(temporalRead >= 5, `only ${String(temporalRead)} temporal fields`);
  const dateTimes = [...fields.values()].filter(
    (field) => field.kind === 'dateTimeFieldType',
  );
  const times = [...fields.values()].filter(
    (field) => field.kind === 'timeFieldType',
  );
  assert.deepEqual(
    [
      ...new Set(dateTimes.map((field) => field.temporal?.timezoneSemantics)),
    ].sort(),
    ['offsetDateTime', 'utcInstant'],
  );
  assert.deepEqual(
    [...new Set(times.map((field) => field.temporal?.precision))].sort(),
    ['millisecond', 'second'],
  );
});

/**
 * A boolean's legal state count is not derivable from its kind: optional means
 * three states, required means two, and nothing else on the wire says which.
 * Carried for `U7` rather than consumed by the renderer -- and both values must
 * appear, or a constant would satisfy this.
 */
test('the required declaration is carried, in both directions', () => {
  const fields = formSurface(COMPILER_SEMANTIC_PROFILE_V2_VERSION).fields ?? [];
  const declared = new Map(
    (
      everyFieldKindModule().fields as readonly {
        readonly fieldId: string;
        readonly presence: string;
      }[]
    ).map((field) => [field.fieldId, field.presence === 'required']),
  );
  assert.ok(fields.length > 0);
  for (const field of fields) {
    assert.equal(field.required, declared.get(field.fieldId), field.fieldId);
  }
  assert.deepEqual(
    [...new Set(fields.map((field) => field.required))].sort(),
    [false, true],
    'the fixture must carry a required field and an optional one',
  );
});

test('enum options are carried, and only for enums', () => {
  const fields = new Map(
    formSurface(COMPILER_SEMANTIC_PROFILE_V2_VERSION).fields?.map((field) => [
      field.fieldId,
      field,
    ]),
  );
  const grade = fields.get(EVERY_KIND_FIELD_IDS.grade);
  const region = fields.get(EVERY_KIND_FIELD_IDS.region);
  assert.ok(grade && region);
  assert.equal(grade.options?.length, 5);
  assert.equal(region.options?.length, 6);
  assert.deepEqual(grade.options?.[0], {
    label: 'A',
    optionId: 'northstar.modulefixture:option.grade_a',
  });
  // Normalization sorts options by `orderKey` then `optionId`, so the rendered
  // order is compiled rather than incidental.
  assert.deepEqual(
    region.options?.map((option) => option.optionId),
    [
      'northstar.modulefixture:option.region_north',
      'northstar.modulefixture:option.region_south',
      'northstar.modulefixture:option.region_east',
      'northstar.modulefixture:option.region_west',
      'northstar.modulefixture:option.region_central',
      'northstar.modulefixture:option.region_offshore',
    ],
  );
  for (const [fieldId, field] of fields) {
    assert.equal(
      Object.hasOwn(field, 'options'),
      field.kind === 'enumFieldType',
      `${fieldId} carries options exactly when it is an enum`,
    );
  }
});
