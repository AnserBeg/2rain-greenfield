import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPILED_FIELD_KINDS,
  SurfaceProjectionError,
  readCompiledSurfaceManifest,
  type CompiledFieldKind,
  type CompiledSurfaceDefinition,
  type CompiledSurfaceField,
} from '../../apps/web/src/surface-contract.js';
import {
  canonicalize,
  normalizeApplicationPackage,
  type FieldType,
} from '../../packages/canonical-model/src/index.js';
import {
  ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  type CompileSuccess,
  type CompilerSemanticProfileVersion,
} from '../../packages/compiler/src/index.js';
import { AuthenticatedRequestEntryAdapter } from '../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyGateway,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import { partyRuntimeProjections } from '../fixtures/g2/party/compiler.js';
import { FIXTURE_IDS } from '../fixtures/g2/module-conformance/definitions.js';
import {
  EVERY_KIND_FIELD_IDS,
  everyFieldKindModule,
} from '../fixtures/g2/module-conformance/field-kinds.js';

const identity = {
  environmentId: 'c2000000-0000-4000-8000-000000000001',
  principalId: 'c2000000-0000-4000-8000-000000000002',
  tenantId: 'c2000000-0000-4000-8000-000000000003',
} as const;

const FORM_SURFACE = `${FIXTURE_IDS.namespace}:surface.master_form`;

/**
 * The completeness control, and it is a TYPE rather than an assertion on
 * purpose. `review-tiers` prefers unrepresentable to detectable: a canonical
 * field kind the reader's vocabulary omits, or a reader entry the canonical
 * model does not admit, fails `pnpm typecheck` rather than waiting for a test
 * that thought to look. The runtime assertion below only keeps the binding
 * executed, so the file's evidence is not purely static.
 */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const READER_VOCABULARY_IS_THE_CANONICAL_ONE: MutuallyAssignable<
  CompiledFieldKind,
  FieldType['kind']
> = true;

const policy: CurrentPolicyGateway = {
  async authorize() {
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'field-kind-round-trip/v1',
    };
  },
  async readCurrentVersion() {
    return { policyVersion: 'field-kind-round-trip/v1' };
  },
};

function compileAt(version: CompilerSemanticProfileVersion): CompileSuccess {
  const normalized = normalizeApplicationPackage(everyFieldKindModule()) as {
    languageVersion: string;
    normalizationProfileVersion: string;
  };
  const result = compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    profile: {
      ...MODULE_COMPILER_PROFILE,
      compilerSemanticProfileVersion: version,
      languageVersion:
        normalized.languageVersion as typeof MODULE_COMPILER_PROFILE.languageVersion,
      normalizationProfileVersion:
        normalized.normalizationProfileVersion as typeof MODULE_COMPILER_PROFILE.normalizationProfileVersion,
    },
  });
  assert.equal(
    result.status,
    'compiled',
    `expected a compile at ${version}: ${JSON.stringify(result.status === 'failed' ? result.diagnostics : [])}`,
  );
  return result as CompileSuccess;
}

async function viewOf(
  compiled: CompileSuccess,
  transform: (
    projections: LoadedRequestRuntimeDefinition['projections'],
  ) => LoadedRequestRuntimeDefinition['projections'] = (projections) =>
    projections,
): Promise<RequestRuntimeView> {
  const entry = new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    {
      async load(): Promise<LoadedRequestRuntimeDefinition> {
        return {
          environmentId: identity.environmentId,
          pointer: {
            fence: 1,
            pointerId: 'c2000000-0000-4000-8000-000000000006',
          },
          projections: transform(partyRuntimeProjections(compiled)),
          release: {
            contentHash: compiled.releaseRoot,
            releaseId: 'c2000000-0000-4000-8000-000000000007',
          },
          tenantId: identity.tenantId,
        };
      },
    },
    policy,
  );
  return entry.run({}, (view) => view);
}

// A type alias rather than an interface, deliberately: only aliases carry the
// implicit index signature that lets a mutated payload go back through
// `ImmutableJsonValue`.
type MutableSurface = {
  fieldIds: string[];
  fields?: {
    fieldId: string;
    kind: string;
    options?: { label: string; optionId: string }[];
    required?: boolean;
    temporal?: { precision: string | null; timezoneSemantics: string };
  }[];
  surfaceId: string;
};

/**
 * One corrupted payload per test, built from the REAL v2 compile so the specimen
 * differs from the admitted one in exactly the property under test. Every other
 * key -- ids, order, option shapes, the surrounding surfaces -- stays valid.
 */
async function viewWithCorruptedForm(
  corrupt: (surface: MutableSurface) => void,
): Promise<RequestRuntimeView> {
  return viewOf(
    compileAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION),
    (projections) => {
      const payload = structuredClone(projections.surface.payload) as {
        surfaces: MutableSurface[];
      };
      const surface = payload.surfaces.find(
        (entry) => entry.surfaceId === FORM_SURFACE,
      );
      assert.ok(surface?.fields, 'the v2 payload must carry a form to corrupt');
      corrupt(surface);
      return { ...projections, surface: { ...projections.surface, payload } };
    },
  );
}

function refusal(view: RequestRuntimeView): SurfaceProjectionError {
  try {
    readCompiledSurfaceManifest(view);
  } catch (error) {
    assert.ok(error instanceof SurfaceProjectionError);
    return error;
  }
  throw new assert.AssertionError({
    message: 'the reader admitted a payload it must refuse',
  });
}

function formOf(view: RequestRuntimeView): CompiledSurfaceDefinition {
  const surface = readCompiledSurfaceManifest(view).surfaces.find(
    (entry) => entry.surfaceId === FORM_SURFACE,
  );
  assert.ok(surface, 'the reader must return the form surface');
  return surface;
}

type FieldsById = ReadonlyMap<string, CompiledSurfaceField>;

function optionsOf(
  byId: FieldsById,
  fieldId: string,
): readonly { readonly label: string; readonly optionId: string }[] {
  const field = byId.get(fieldId);
  assert.ok(field?.kind === 'enumFieldType', `${fieldId} is not an enum`);
  return field.options;
}

function temporalOf(byId: FieldsById, fieldId: string): unknown {
  const field = byId.get(fieldId);
  assert.ok(field, fieldId);
  assert.ok(
    field.kind === 'dateFieldType' ||
      field.kind === 'timeFieldType' ||
      field.kind === 'dateTimeFieldType',
    `${fieldId} is not temporal`,
  );
  return field.temporal;
}

test('the reader vocabulary is exactly the canonical field-type vocabulary', () => {
  assert.equal(READER_VOCABULARY_IS_THE_CANONICAL_ONE, true);
  assert.equal(
    new Set(COMPILED_FIELD_KINDS).size,
    COMPILED_FIELD_KINDS.length,
    'the vocabulary must not repeat a kind',
  );
});

/**
 * The admission half of every refusal below: the untouched v2 payload -- the one
 * the compiler really emitted -- parses, carries a kind for every selected
 * field, and carries options for the enums and nothing else.
 *
 * Without this, each refusal test is satisfied by a reader that refuses
 * everything.
 */
test('a v2 payload survives the production reader with its kinds and options', async () => {
  const surface = formOf(
    await viewOf(compileAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION)),
  );
  assert.ok(surface.fields, 'the reader dropped the compiled field kinds');
  assert.deepEqual(
    surface.fields.map((field) => field.fieldId),
    [...surface.fieldIds],
  );
  const byId = new Map(surface.fields.map((field) => [field.fieldId, field]));
  assert.equal(byId.get(EVERY_KIND_FIELD_IDS.due)?.kind, 'dateFieldType');
  assert.equal(byId.get(EVERY_KIND_FIELD_IDS.active)?.kind, 'booleanFieldType');
  assert.equal(byId.get(EVERY_KIND_FIELD_IDS.price)?.kind, 'moneyFieldType');
  assert.equal(
    byId.get(EVERY_KIND_FIELD_IDS.weight)?.kind,
    'quantityFieldType',
  );
  assert.equal(optionsOf(byId, EVERY_KIND_FIELD_IDS.grade).length, 5);
  assert.equal(optionsOf(byId, EVERY_KIND_FIELD_IDS.region).length, 6);
  assert.equal(
    Object.hasOwn(byId.get(EVERY_KIND_FIELD_IDS.due) ?? {}, 'options'),
    false,
  );
  // The discriminants survive the reader too, in both of their values. Read
  // through a narrowing helper: after the type discriminated on kind, `temporal`
  // is not reachable without knowing the kind, which is the point of it.
  assert.deepEqual(temporalOf(byId, EVERY_KIND_FIELD_IDS.offsetMoment), {
    precision: 'second',
    timezoneSemantics: 'offsetDateTime',
  });
  assert.deepEqual(temporalOf(byId, EVERY_KIND_FIELD_IDS.preciseTime), {
    precision: 'millisecond',
    timezoneSemantics: 'localWallTime',
  });
  assert.deepEqual(temporalOf(byId, EVERY_KIND_FIELD_IDS.due), {
    precision: null,
    timezoneSemantics: 'calendarDate',
  });
  assert.equal(
    Object.hasOwn(byId.get(EVERY_KIND_FIELD_IDS.price) ?? {}, 'temporal'),
    false,
  );
  // Both directions, from the fixture's own ids rather than hand-built ones.
  assert.equal(byId.get(EVERY_KIND_FIELD_IDS.active)?.required, false);
  assert.equal(byId.get(FIXTURE_IDS.fieldIds.parentName)?.required, true);
  // Every kind the reader knows is reachable through this specimen, so the
  // refusal tests below are refusing something the admission actually covers.
  assert.deepEqual(
    [...new Set(surface.fields.map((field) => field.kind))].sort(),
    [...COMPILED_FIELD_KINDS].sort(),
    'the fixture must exercise every kind in the reader vocabulary',
  );
});

/**
 * The refusals for the discriminants the first cut did not carry at all. A
 * temporal kind whose declared domain is missing or unreadable is refused rather
 * than rendered: an enum without options shows a visibly empty choice, but a
 * date-time without its precision and timezone semantics renders a control that
 * looks correct and cannot express the stored value. The silent one is the one
 * that must fail loudly.
 *
 * Each on its own message, because a shared code cannot attribute which check
 * refused.
 */
test('RED: the reader refuses an unreadable or misplaced temporal domain', async () => {
  const grafted = refusal(
    await viewWithCorruptedForm((surface) => {
      const price = surface.fields?.find(
        (field) => field.fieldId === EVERY_KIND_FIELD_IDS.price,
      );
      assert.ok(price);
      price.temporal = { precision: 'second', timezoneSemantics: 'utcInstant' };
    }),
  );
  assert.equal(grafted.code, 'INVALID_SURFACE_FIELD');
  assert.match(
    grafted.message,
    /temporal precision that does not belong to kind moneyFieldType/,
  );

  const stripped = refusal(
    await viewWithCorruptedForm((surface) => {
      const due = surface.fields?.find(
        (field) => field.fieldId === EVERY_KIND_FIELD_IDS.due,
      );
      assert.ok(due);
      delete due.temporal;
    }),
  );
  assert.equal(stripped.code, 'INVALID_SURFACE_FIELD');
  assert.match(
    stripped.message,
    /temporal precision that does not belong to kind dateFieldType/,
  );

  const unknownSemantics = refusal(
    await viewWithCorruptedForm((surface) => {
      const moment = surface.fields?.find(
        (field) => field.fieldId === EVERY_KIND_FIELD_IDS.offsetMoment,
      );
      assert.ok(moment?.temporal);
      moment.temporal.timezoneSemantics = 'floatingLocal';
    }),
  );
  assert.equal(unknownSemantics.code, 'INVALID_SURFACE_FIELD');
  assert.match(unknownSemantics.message, /unreadable temporal domain/);

  // `null` precision belongs to `dateFieldType` alone -- a calendar date has no
  // sub-day component. A null on any other temporal kind is a control that would
  // silently pick a 60-second step.
  const nulledPrecision = refusal(
    await viewWithCorruptedForm((surface) => {
      const moment = surface.fields?.find(
        (field) => field.fieldId === EVERY_KIND_FIELD_IDS.offsetMoment,
      );
      assert.ok(moment?.temporal);
      moment.temporal.precision = null;
    }),
  );
  assert.equal(nulledPrecision.code, 'INVALID_SURFACE_FIELD');
  assert.match(
    nulledPrecision.message,
    /temporal precision that kind dateTimeFieldType cannot carry/,
  );

  const datedPrecision = refusal(
    await viewWithCorruptedForm((surface) => {
      const due = surface.fields?.find(
        (field) => field.fieldId === EVERY_KIND_FIELD_IDS.due,
      );
      assert.ok(due?.temporal);
      due.temporal.precision = 'second';
    }),
  );
  assert.equal(datedPrecision.code, 'INVALID_SURFACE_FIELD');
  assert.match(
    datedPrecision.message,
    /temporal precision that kind dateFieldType cannot carry/,
  );
});

/**
 * The pairing, one control per mapping, each varying ONLY the spelling.
 *
 * This is the finding a review had to catch because nothing here could: the
 * first cut bound `precision` to the kind and checked `timezoneSemantics` for
 * membership in the union of all four spellings, so a valid-but-wrong pair was
 * admitted and the renderer then chose its control from `kind` alone. Every
 * negative control this file already had -- unknown spellings, missing
 * `temporal`, temporal on a non-temporal kind, misplaced precision -- passes
 * against that defect, because none of them varies a spelling that is valid
 * somewhere else.
 *
 * Each specimen keeps precision, kind, ids and order exactly as the compiler
 * emitted them and moves one word.
 */
test('RED: the reader refuses a timezone spelling its kind cannot carry', async () => {
  const cases = [
    [EVERY_KIND_FIELD_IDS.due, 'dateFieldType', 'utcInstant'],
    [EVERY_KIND_FIELD_IDS.preciseTime, 'timeFieldType', 'calendarDate'],
    [EVERY_KIND_FIELD_IDS.offsetMoment, 'dateTimeFieldType', 'localWallTime'],
  ] as const;
  for (const [fieldId, kind, wrongSpelling] of cases) {
    const error = refusal(
      await viewWithCorruptedForm((surface) => {
        const field = surface.fields?.find(
          (entry) => entry.fieldId === fieldId,
        );
        assert.ok(field?.temporal, fieldId);
        field.temporal.timezoneSemantics = wrongSpelling;
      }),
    );
    assert.equal(error.code, 'INVALID_SURFACE_FIELD', fieldId);
    assert.match(
      error.message,
      new RegExp(
        `timezone semantics ${wrongSpelling} that kind ${kind} cannot carry`,
      ),
      fieldId,
    );
  }
});

/**
 * The admission twin for the three above: refusing all three is otherwise
 * satisfied by a reader that refuses every temporal field.
 *
 * `dateTimeFieldType` is the only kind with two legal spellings, so it is the
 * only place the twin can vary, and the fixture carries one field of each.
 */
test('the reader admits both spellings a date-time may legally carry', async () => {
  const surface = formOf(
    await viewOf(compileAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION)),
  );
  const byId = new Map((surface.fields ?? []).map((f) => [f.fieldId, f]));
  assert.deepEqual(
    [
      temporalOf(byId, FIXTURE_IDS.fieldIds.parentUtcInstant),
      temporalOf(byId, EVERY_KIND_FIELD_IDS.offsetMoment),
    ],
    [
      { precision: 'millisecond', timezoneSemantics: 'utcInstant' },
      { precision: 'second', timezoneSemantics: 'offsetDateTime' },
    ],
  );
});

test('RED: the reader refuses a field that does not declare whether it is required', async () => {
  const missing = refusal(
    await viewWithCorruptedForm((surface) => {
      assert.ok(surface.fields?.[0]);
      delete (surface.fields[0] as { required?: unknown }).required;
    }),
  );
  assert.equal(missing.code, 'INVALID_SURFACE_FIELD');
  assert.match(missing.message, /does not declare whether it is required/);

  const notABoolean = refusal(
    await viewWithCorruptedForm((surface) => {
      assert.ok(surface.fields?.[0]);
      (surface.fields[0] as { required?: unknown }).required = 'true';
    }),
  );
  assert.equal(notABoolean.code, 'INVALID_SURFACE_FIELD');
  assert.match(notABoolean.message, /does not declare whether it is required/);
});

/**
 * The absence twin. A reader that invented `textFieldType` for a payload the
 * compiler never described would render a form that looks right and is a lie
 * about what the compiler said.
 *
 * REPOINTED TO v1 BY `profile-v2-adoption`. This read the adopted constant, and
 * its own title claimed "the shape every recorded release actually has".
 * Adoption made the adopted profile the one that DOES emit field kinds, so read
 * through the constant this became the same subject as the presence tests above
 * and would have proved nothing about absence at all.
 *
 * Pinned to v1 literally, and the sentence about recorded releases stays exactly
 * true of it: lineage entries 0-8 are recorded under v0/v1 and carry no `fields`
 * key. Entry 9, minted by this packet, is the first that does. Both halves of
 * the round trip are therefore live -- presence at v2, absence at v1 -- which is
 * what keeps the reader discriminating rather than merely permissive.
 */
test('an absent field list stays absent through the reader at a pre-v2 profile', async () => {
  // Which of the two profiles this file exercises is the one a real request
  // actually serves. Without this the file proves the reader handles presence
  // and absence correctly while saying nothing about which it will meet.
  assert.equal(
    ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    'the presence half is the shipped half; absence below is the historical one',
  );
  const manifest = readCompiledSurfaceManifest(
    await viewOf(compileAt(COMPILER_SEMANTIC_PROFILE_V1_VERSION)),
  );
  assert.ok(manifest.surfaces.length > 0);
  for (const surface of manifest.surfaces) {
    assert.equal(
      Object.hasOwn(surface, 'fields'),
      false,
      `${surface.surfaceId}: the reader invented field kinds the projection never emitted`,
    );
  }
});

/**
 * `U5b`'s round-1 defect, one layer up. `parseSurface` builds a fresh object
 * from the keys it recognises, so a kind this reader does not know would be
 * dropped and the field would fall back to a bare text box -- indistinguishable
 * from a field the compiler never described. Refused, and the message NAMES the
 * kind, because a reader one release behind its compiler has to be able to learn
 * what it is missing.
 */
test('RED: the reader refuses a field kind outside the closed vocabulary', async () => {
  const view = await viewWithCorruptedForm((surface) => {
    const field = surface.fields?.[0];
    assert.ok(field);
    field.kind = 'relationFieldType';
  });
  const error = refusal(view);
  assert.equal(error.code, 'INVALID_SURFACE_FIELD');
  assert.match(error.message, /relationFieldType/);
});

/**
 * The dropped-field vector the projection deliberately does not guard. A short
 * `fields` array against a full `fieldIds` renders some controls correctly and
 * the rest as bare text -- the silent partial degradation this packet exists to
 * remove -- so it is one named fault instead.
 */
test('RED: the reader refuses a field list that does not match the selected fields', async () => {
  const dropped = refusal(
    await viewWithCorruptedForm((surface) => {
      surface.fields?.pop();
    }),
  );
  assert.equal(dropped.code, 'INVALID_SURFACE_FIELD');
  assert.match(dropped.message, /do not match its selected fields/);

  const reordered = refusal(
    await viewWithCorruptedForm((surface) => {
      assert.ok(surface.fields && surface.fields.length > 1);
      surface.fields.reverse();
    }),
  );
  assert.equal(reordered.code, 'INVALID_SURFACE_FIELD');
  assert.match(reordered.message, /do not match its selected fields/);
});

/**
 * The shape checks, one specimen each, asserted on their own MESSAGE rather
 * than on the shared code. A red count is not attribution: three specimens that
 * all report `INVALID_SURFACE_FIELD` would survive the deletion of two of the
 * three checks. The message is what says which one refused.
 */
test('RED: the reader refuses a malformed field list and a malformed entry', async () => {
  const notAList = refusal(
    await viewWithCorruptedForm((surface) => {
      (surface as { fields?: unknown }).fields = 'not-an-array';
    }),
  );
  assert.equal(notAList.code, 'INVALID_SURFACE_FIELD');
  assert.match(notAList.message, /non-array field list/);

  const noFieldId = refusal(
    await viewWithCorruptedForm((surface) => {
      assert.ok(surface.fields?.[0]);
      surface.fields[0] = {
        ...surface.fields[0],
        fieldId: '   ',
      };
    }),
  );
  assert.equal(noFieldId.code, 'INVALID_SURFACE_FIELD');
  assert.match(noFieldId.message, /is not a declared field/);
});

/**
 * Options are present exactly when the kind is `enumFieldType`. Both directions
 * are corrupted, because each is a different production check: an enum with no
 * options renders a choice with nothing to choose, and options on a date field
 * mean the payload came from something this reader does not understand.
 */
test('RED: the reader refuses options that do not belong to the kind', async () => {
  const stripped = refusal(
    await viewWithCorruptedForm((surface) => {
      const grade = surface.fields?.find(
        (field) => field.fieldId === EVERY_KIND_FIELD_IDS.grade,
      );
      assert.ok(grade);
      delete grade.options;
    }),
  );
  assert.equal(stripped.code, 'INVALID_SURFACE_FIELD');
  assert.match(stripped.message, /do not belong to kind enumFieldType/);

  const grafted = refusal(
    await viewWithCorruptedForm((surface) => {
      const due = surface.fields?.find(
        (field) => field.fieldId === EVERY_KIND_FIELD_IDS.due,
      );
      assert.ok(due);
      due.options = [{ label: 'Yesterday', optionId: 'x:option.yesterday' }];
    }),
  );
  assert.equal(grafted.code, 'INVALID_SURFACE_FIELD');
  assert.match(grafted.message, /do not belong to kind dateFieldType/);

  const notAList = refusal(
    await viewWithCorruptedForm((surface) => {
      const grade = surface.fields?.find(
        (field) => field.fieldId === EVERY_KIND_FIELD_IDS.grade,
      );
      assert.ok(grade);
      (grade as { options?: unknown }).options = 'not-an-array';
    }),
  );
  assert.equal(notAList.code, 'INVALID_SURFACE_FIELD');
  assert.match(notAList.message, /non-array option list/);

  const blank = refusal(
    await viewWithCorruptedForm((surface) => {
      const grade = surface.fields?.find(
        (field) => field.fieldId === EVERY_KIND_FIELD_IDS.grade,
      );
      assert.ok(grade?.options?.[0]);
      grade.options[0].label = '   ';
    }),
  );
  assert.equal(blank.code, 'INVALID_SURFACE_FIELD');
  assert.match(blank.message, /invalid enum option/);
});
