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
