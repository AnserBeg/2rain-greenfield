import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADOPTED_LANGUAGE_VERSION,
  ADOPTED_NORMALIZATION_PROFILE_VERSION,
  CanonicalModelError,
  SUPPORTED_LANGUAGE_VERSIONS,
  SUPPORTED_NORMALIZATION_PROFILE_VERSIONS,
  canonicalAuthoredProjection,
  canonicalize,
  languageHasLegalEntityQueryScope,
  languageHasMaterializedStateFields,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
} from '../../packages/compiler/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { FIXTURE_IDS } from '../fixtures/g2/module-conformance/definitions.js';

import { projectionPayload } from './helpers.js';
import { scopedModuleAt } from './v4-definition.js';

/**
 * ADOPTION MUST EXERCISE THE SHAPE, NOT THE VERSION. Added by `LANG-ADOPT-v5`.
 *
 * `5g3-sm-impl`'s transferable finding is why this file exists: of its five
 * version defects, TWO were unreachable by any generic version fixture, because
 * a package that does not carry the shape a version introduced normalizes
 * perfectly at that version. Its words: "a version-cut checklist that only
 * compiles a plain package at the new version proves nothing about the shapes
 * the new version cannot express."
 *
 * That applies with full force to this adoption. v5's distinguishing feature is
 * the materialized state field, `v5NormalizedShape` is `v4NormalizedShape` with
 * one field changed, and NO first-party module declares a state machine -- all
 * five declare `stateMachines: []`. The composed application's new lineage
 * entry therefore differs from its predecessor in version stamps alone, and
 * every gate passing over it proves that adoption BROKE NOTHING, not that v5
 * WORKS.
 *
 * The fixture below carries the shape. It ships no product state machine: the
 * first of those arrives with `PUR-1`, and converting an existing enumeration
 * into a machine would be a feature change to an entity ADR-0029 hardened.
 */

const NAMESPACE = FIXTURE_IDS.namespace;
const MACHINE_ID = `${NAMESPACE}:machine.master_lifecycle`;
const OPEN_STATE_ID = `${NAMESPACE}:state.master_open`;
const CLOSED_STATE_ID = `${NAMESPACE}:state.master_closed`;
/** Derived by `normalize.ts` from the machine id. Never authored. */
const DERIVED_STATE_FIELD_ID = `${NAMESPACE}:derived_state_field.machine.master_lifecycle`;

/**
 * The newest version that does NOT materialize, derived by walking back from
 * the adopted one rather than named.
 *
 * Deriving it is the point. `5g3-sm-impl` closed its own materialization gate
 * by asking the ORDERED supported list "at or after the introducing version"
 * instead of enumerating levels, precisely so a later cut inherits the rule with
 * no edit. A control that then hard-codes `'v4'` as "below" re-opens the same
 * hole one layer up and goes stale silently at the next adoption.
 */
const VERSION_BELOW_MATERIALIZATION = (() => {
  const adoptedIndex = SUPPORTED_LANGUAGE_VERSIONS.indexOf(
    ADOPTED_LANGUAGE_VERSION,
  );
  for (let index = adoptedIndex - 1; index >= 0; index -= 1) {
    const candidate = SUPPORTED_LANGUAGE_VERSIONS[index]!;
    if (!languageHasMaterializedStateFields(candidate)) return candidate;
  }
  throw new Error(
    'no supported version below the adopted one declines materialization',
  );
})();

test('a state machine materializes exactly one state field at the adopted version, and none below it', () => {
  // Named, not assumed. Every claim in this file depends on the adopted version
  // being one that materializes, and on the fixture's scope operand being
  // admitted at both versions under comparison.
  assert.equal(
    languageHasMaterializedStateFields(ADOPTED_LANGUAGE_VERSION),
    true,
  );
  assert.equal(
    languageHasMaterializedStateFields(VERSION_BELOW_MATERIALIZATION),
    false,
  );
  assert.equal(
    languageHasLegalEntityQueryScope(ADOPTED_LANGUAGE_VERSION),
    true,
  );
  assert.equal(
    languageHasLegalEntityQueryScope(VERSION_BELOW_MATERIALIZATION),
    true,
  );

  const adopted = machineModuleAt(ADOPTED_LANGUAGE_VERSION);
  const below = machineModuleAt(VERSION_BELOW_MATERIALIZATION);

  // THE SPECIMEN VARIES ONE PROPERTY. Without this the pair is two packages
  // differing in unknown ways, and "materialization is what changed" would be
  // an inference rather than an observation.
  assert.deepEqual(
    stripVersionStamps(adopted),
    stripVersionStamps(below),
    'the two specimens must differ in version stamps and nothing else',
  );

  const authoredFieldIds = new Set(
    (adopted.fields as { fieldId: string }[]).map((field) => field.fieldId),
  );
  assert.equal(
    authoredFieldIds.has(DERIVED_STATE_FIELD_ID),
    false,
    'the state field must be derived, not authored, or this file proves nothing',
  );

  const materialized = normalizeApplicationPackage(adopted);
  const derived = materialized.fields.filter(
    (field) => !authoredFieldIds.has(field.fieldId),
  );
  assert.equal(derived.length, 1);

  // Asserted WHOLE rather than by `fieldId`. A partial materialization -- right
  // id, wrong kind, missing options, no default, authored-looking presence -- is
  // exactly the counterfeit `normalize.ts` refuses as
  // `CANON_STATE_FIELD_COLLISION`, and an id-only check would admit it here.
  assert.deepEqual(derived[0], {
    classification: 'internal',
    collation: 'binary',
    defaultSemantics: 'declaredDefault',
    defaultValue: {
      kind: 'textValue',
      schemaVersion: ADOPTED_LANGUAGE_VERSION,
      value: OPEN_STATE_ID,
    },
    entity: {
      kind: 'entityReference',
      schemaVersion: ADOPTED_LANGUAGE_VERSION,
      targetId: FIXTURE_IDS.entityIds.parent,
    },
    fieldId: DERIVED_STATE_FIELD_ID,
    // An ORDINARY enumeration field, which is ADR-0050's whole ruling: the
    // parallel `derivedStateField` storage construct is retired and the state
    // becomes something a predicate can address and a query can select.
    fieldType: {
      kind: 'enumFieldType',
      options: [
        {
          kind: 'enumOption',
          label: 'Open',
          optionId: OPEN_STATE_ID,
          orderKey: 10,
          schemaVersion: ADOPTED_LANGUAGE_VERSION,
        },
        {
          kind: 'enumOption',
          label: 'Closed',
          optionId: CLOSED_STATE_ID,
          orderKey: 20,
          schemaVersion: ADOPTED_LANGUAGE_VERSION,
        },
      ],
      schemaVersion: ADOPTED_LANGUAGE_VERSION,
    },
    kind: 'fieldDefinition',
    label: 'State',
    lifecycle: 'active',
    orderKey: 0,
    presence: 'required',
    reportable: true,
    schemaVersion: ADOPTED_LANGUAGE_VERSION,
    searchable: false,
  });

  // The discriminating half: the same authored shape one version back
  // materializes NOTHING, so the assertions above observe the VERSION's
  // behaviour rather than the fixture's contents.
  const unmaterialized = normalizeApplicationPackage(below);
  assert.deepEqual(
    unmaterialized.fields
      .map((field) => field.fieldId)
      .filter((fieldId) => !authoredFieldIds.has(fieldId)),
    [],
  );
  assert.equal(
    materialized.fields.length,
    unmaterialized.fields.length + 1,
    'materialization is the only field-count difference between the two versions',
  );
});

test('the materialized package compiles through the unmodified default profile', () => {
  const materializedBytes = normalizedBytesOf(
    machineModuleAt(ADOPTED_LANGUAGE_VERSION),
  );

  // NO VERSION OVERRIDE, and that is the whole point of this control. Every
  // fixture helper in this repository hides this arm: `helpers.ts`,
  // `test/fixtures/g2/party/compiler.ts` and `surface-grammar/compiled.ts` all
  // spread the profile and then overwrite `languageVersion` from the package
  // under compile, so they pass whatever the adopted version is and can never
  // observe it moving. Three sibling fixture compilers do the opposite -- pin
  // `MODULE_COMPILER_PROFILE` with no override -- and passed only because module
  // and adopted version coincided, which is the latent the `LANG-ADOPT` (v4)
  // ledger row recorded and this adoption cashed in.
  const compiled = compileApplication({
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: materializedBytes,
    profile: { ...DEFAULT_COMPILER_PROFILE },
  });
  assert.equal(compiled.status, 'compiled');
  if (compiled.status !== 'compiled') return;

  const storage = projectionPayload<{
    entities: Array<{
      checkConstraints: Array<{
        canonicalFieldId: string;
        checkKind: string;
        enumOptionIds?: readonly string[];
      }>;
      columns: Array<{
        canonicalFieldId: string;
        defaultValue: { value?: string } | null;
      }>;
      derivedStateFields: Array<{ fieldId: string }>;
      entityId: string;
    }>;
  }>(compiled, PROJECTION_FAMILY_IDS.storageTarget);
  const entity = storage.entities.find(
    (candidate) => candidate.entityId === FIXTURE_IDS.entityIds.parent,
  );
  assert.ok(entity, 'the machine entity is absent from the storage target');

  // The state reaches storage as an ORDINARY COLUMN carrying the initial state
  // as its default...
  const stateColumn = entity.columns.find(
    (column) => column.canonicalFieldId === DERIVED_STATE_FIELD_ID,
  );
  assert.ok(
    stateColumn,
    'the materialized state field must reach the storage target as an ordinary column',
  );
  assert.equal(stateColumn.defaultValue?.value, OPEN_STATE_ID);
  // ...and the database enforces the machine's state set, so "one document has
  // exactly one state" is a storage constraint rather than a convention. A
  // column name alone would pass while the column admitted any text.
  assert.deepEqual(
    entity.checkConstraints
      .filter(
        (constraint) => constraint.canonicalFieldId === DERIVED_STATE_FIELD_ID,
      )
      .map((constraint) => ({
        checkKind: constraint.checkKind,
        enumOptionIds: [...(constraint.enumOptionIds ?? [])],
      })),
    [
      {
        checkKind: 'enumDomain',
        enumOptionIds: [CLOSED_STATE_ID, OPEN_STATE_ID],
      },
    ],
  );
  // ...and NOT through the parallel construct ADR-0050 retired. This half is
  // load-bearing: the assertions above stay green while the old construct is
  // ALSO emitted, which is a document carrying two states -- the defect the ADR
  // names and the reason "honour one, retire the other" was never available.
  assert.deepEqual(entity.derivedStateFields, []);
});

test('the materialized package round-trips through the canonical authored projection', () => {
  const materialized = normalizeApplicationPackage(
    machineModuleAt(ADOPTED_LANGUAGE_VERSION),
  );
  const projected = canonicalAuthoredProjection(materialized) as unknown as {
    fields: Array<{ fieldId: string }>;
    stateMachines: Array<Record<string, unknown>>;
  };

  // Measured, not assumed, and the measurement is the interesting half: the
  // projection DROPS the machine's `stateField` -- that identity is owned by the
  // machine and re-derived -- while KEEPING the materialized field, because
  // after materialization it is an ordinary field like any other. So the second
  // normalization pass finds the field already present, and the
  // `alreadyMaterialized` guard is what stops it minting a duplicate identity.
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      projected.stateMachines[0] ?? {},
      'stateField',
    ),
    false,
  );
  assert.ok(
    projected.fields.some((field) => field.fieldId === DERIVED_STATE_FIELD_ID),
    'the materialized field survives the authored projection as an ordinary field',
  );

  assert.equal(
    canonicalize(normalizeApplicationPackage(projected)),
    canonicalize(materialized),
  );
});

test('a mixed-version composition is refused by name while the uniform one is admitted', () => {
  // The admission twin, and it is not optional: a refusal-only control is
  // satisfied by a guard that refuses every composition.
  const uniform = composedApplicationDefinition();
  assert.equal(
    normalizeApplicationPackage(uniform).languageVersion,
    ADOPTED_LANGUAGE_VERSION,
  );

  // One module held one version back -- the `G3-P5` shape that created the
  // `lang-adopt` row, and the reason adoption is application-wide rather than
  // per-module.
  const mixed = structuredClone(uniform) as {
    entities: Array<{
      entityId: string;
      module: { targetId: string };
      schemaVersion: string;
    }>;
  };
  const heldBack = mixed.entities.filter((entity) =>
    entity.module.targetId.endsWith(':module.party'),
  );
  assert.ok(heldBack.length > 0, 'the party module contributes no entity');
  const heldBackIds = heldBack.map((entity) => entity.entityId).sort();
  for (const entity of heldBack) {
    entity.schemaVersion = VERSION_BELOW_MATERIALIZATION;
  }

  assert.throws(
    () => normalizeApplicationPackage(mixed),
    (error: unknown) => {
      assert.ok(error instanceof CanonicalModelError);
      const mixedVersion = error.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'CANON_VERSION_MIXED',
      );
      // ATTRIBUTION, not a count. `objectId` names each offending node, so the
      // reds map one-to-one onto the nodes this specimen moved and to nothing
      // else -- the checklist's "a red count is not attribution" row, which was
      // written from four reds that turned out to be three specimens.
      assert.deepEqual(
        [...mixedVersion].map((diagnostic) => diagnostic.objectId).sort(),
        heldBackIds,
      );
      // Refused at the SCHEMA layer, measured rather than predicted: the v5 node
      // schema is `z.literal('v5')`, so a held-back stamp never reaches the
      // semantic `CANON_VERSION_MIXED` at `normalize.ts:874` whose remedy reads
      // "use <version> for every schemaVersion". The rule text that DOES fire
      // interpolates the newest readable version, so it stays honest across
      // cuts without being edited.
      assert.deepEqual(
        [...new Set(mixedVersion.map((diagnostic) => diagnostic.path))].sort(),
        mixedVersion
          .map((_, index) => `$.entities[${String(index)}].schemaVersion`)
          .sort(),
      );
      return true;
    },
  );
});

/**
 * The compilable module-conformance fixture at `languageVersion`, carrying one
 * real state machine on its parent entity.
 *
 * Built on `scopedModuleAt` rather than on the canonical-model representative
 * fixture, and the reason is a measurement: the representative package
 * NORMALIZES but does not COMPILE at any version -- it declares unsupported
 * capabilities and incomplete entity conformance -- so a compile control built
 * on it would have proved a refusal unrelated to the language.
 */
function machineModuleAt(languageVersion: string): Record<string, unknown> {
  const normalizationProfileVersion =
    SUPPORTED_NORMALIZATION_PROFILE_VERSIONS[
      SUPPORTED_LANGUAGE_VERSIONS.indexOf(
        languageVersion as (typeof SUPPORTED_LANGUAGE_VERSIONS)[number],
      )
    ];
  if (normalizationProfileVersion === undefined) {
    throw new Error(`no normalization profile for ${languageVersion}`);
  }
  if (
    languageVersion === ADOPTED_LANGUAGE_VERSION &&
    normalizationProfileVersion !== ADOPTED_NORMALIZATION_PROFILE_VERSION
  ) {
    throw new Error(
      'the supported lists disagree about the adopted normalization profile',
    );
  }
  const definition = scopedModuleAt(
    languageVersion,
    normalizationProfileVersion,
  ) as unknown as Record<string, unknown>;
  const reference = (kind: string, targetId: string) => ({
    kind,
    schemaVersion: languageVersion,
    targetId,
  });
  definition.stateMachines = [
    {
      entity: reference('entityReference', FIXTURE_IDS.entityIds.parent),
      initialState: reference('stateReference', OPEN_STATE_ID),
      kind: 'stateMachineDefinition',
      machineId: MACHINE_ID,
      schemaVersion: languageVersion,
      states: [
        {
          kind: 'stateDefinition',
          label: 'Open',
          orderKey: 10,
          schemaVersion: languageVersion,
          stateId: OPEN_STATE_ID,
        },
        {
          kind: 'stateDefinition',
          label: 'Closed',
          orderKey: 20,
          schemaVersion: languageVersion,
          stateId: CLOSED_STATE_ID,
          terminal: true,
        },
      ],
      transitions: [
        {
          fromState: reference('stateReference', OPEN_STATE_ID),
          kind: 'transitionDefinition',
          label: 'Close master',
          orderKey: 10,
          permission: reference(
            'permissionReference',
            `${NAMESPACE}:permission.master_update`,
          ),
          schemaVersion: languageVersion,
          toState: reference('stateReference', CLOSED_STATE_ID),
          transitionId: `${NAMESPACE}:transition.master_close`,
        },
      ],
    },
  ];
  return definition;
}

function normalizedBytesOf(authored: unknown): Uint8Array {
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(authored)),
  );
}

/** Every version stamp blanked, so two specimens can be compared for sameness. */
function stripVersionStamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVersionStamps);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) =>
        key === 'schemaVersion' ||
        key === 'languageVersion' ||
        key === 'normalizationProfileVersion'
          ? [key, 'STAMP']
          : [key, stripVersionStamps(entry)],
      ),
    );
  }
  return value;
}
