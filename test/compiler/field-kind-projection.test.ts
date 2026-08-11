import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
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
 * The property everything below rests on. A field gated on the ADOPTED profile
 * version fails `check:app-release`; the same field gated on a cut-but-unadopted
 * version leaves the whole recorded lineage byte-identical (ADR-0047, measured
 * by `U5-design`). Asserted against the constant directly, because a compile
 * derives its profile from the artifact and cannot see this constant move.
 */
test('per-field kinds ride the UNADOPTED compiler-semantic v2', () => {
  assert.notEqual(
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    'adopting v2 moves every recorded release root; `ux-picker` does not adopt',
  );
});

/**
 * The refusal half: nothing reaches a recorded release. Every surface in the
 * adopted-profile manifest lacks the key ENTIRELY -- `Object.hasOwn`, not a
 * falsy read, because an empty array would also be a new byte in every
 * projection and would move the roots the gate exists to protect.
 */
test('the adopted profile emits no per-field kinds at all', () => {
  const surfaces = surfacesAt(ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION);
  assert.ok(surfaces.length > 0, 'the fixture must project surfaces');
  for (const surface of surfaces) {
    assert.equal(
      Object.hasOwn(surface, 'fields'),
      false,
      `${surface.surfaceId} must carry no compiled field kinds`,
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
 */
test('the v2 release root differs from the adopted one for the same package', () => {
  assert.notEqual(
    compileAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION).releaseRoot,
    compileAt(ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION).releaseRoot,
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
