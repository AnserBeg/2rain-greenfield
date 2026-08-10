import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalize,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION,
  COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  COMPILER_SEMANTIC_PROFILE_VERSION,
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  MODULE_INPUT_CONTRACT_VERSION,
  MODULE_INPUT_CONTRACT_V2_VERSION,
  MODULE_INPUT_CONTRACT_V3_VERSION,
  MODULE_INPUT_CONTRACT_V4_VERSION,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompilerInput,
  type CompilerSemanticProfileVersion,
  type CompileSuccess,
} from '../../packages/compiler/src/index.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
} from '../fixtures/g2/module-conformance/definitions.js';
import { projectionPayload } from './helpers.js';

/**
 * The fixture already declared a REQUIRED relation before this packet existed
 * (`master_role_parent`, `required: true`), and so does first-party `party_role`
 * in the shipped release. Neither specimen was authored to make this gate pass,
 * which is the point: a self-chosen specimen measures the author's model of the
 * defect rather than the defect.
 */
const REQUIRED_RELATION_ID = `${FIXTURE_IDS.namespace}:relation.master_role_parent`;

interface RelationInput {
  readonly archiveBehavior: string;
  readonly relationId: string;
  readonly required: boolean;
  readonly targetEntityId?: string;
}

interface OperationCatalog {
  readonly operations: readonly {
    readonly effect: { readonly kind: string };
    readonly inputContract?: {
      readonly relationInputs: readonly RelationInput[];
      readonly schemaVersion: string;
    };
    readonly operationId: string;
  }[];
}

function compileAt(version: CompilerSemanticProfileVersion): CompileSuccess {
  const normalized = normalizeApplicationPackage(ordinaryModuleV1()) as {
    readonly languageVersion?: string;
    readonly normalizationProfileVersion?: string;
  };
  const base = {
    ...MODULE_COMPILER_PROFILE,
    ...(normalized.languageVersion === undefined
      ? {}
      : { languageVersion: normalized.languageVersion }),
    ...(normalized.normalizationProfileVersion === undefined
      ? {}
      : {
          normalizationProfileVersion: normalized.normalizationProfileVersion,
        }),
  } as CompilerInput['profile'];
  const compilerInput: CompilerInput = {
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    profile: { ...base, compilerSemanticProfileVersion: version },
  };
  const result = compileApplication(compilerInput);
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function catalogAt(version: CompilerSemanticProfileVersion): OperationCatalog {
  return projectionPayload<OperationCatalog>(
    compileAt(version),
    PROJECTION_FAMILY_IDS.operationCatalog,
  );
}

function requiredRelationInput(
  version: CompilerSemanticProfileVersion,
): RelationInput {
  const catalog = catalogAt(version);
  const relations = catalog.operations.flatMap(
    (operation) => operation.inputContract?.relationInputs ?? [],
  );
  const relation = relations.find(
    (entry) => entry.relationId === REQUIRED_RELATION_ID,
  );
  assert.ok(
    relation,
    'the fixture must contribute a required relation input to read',
  );
  assert.equal(relation.required, true, 'the specimen must be REQUIRED');
  return relation;
}

test('a required relation carries its target entity at v2, and at no earlier version', () => {
  const atV2 = requiredRelationInput(COMPILER_SEMANTIC_PROFILE_V2_VERSION);
  assert.equal(
    atV2.targetEntityId,
    FIXTURE_IDS.entityIds.parent,
    'v2 must name the entity whose records are candidates',
  );

  for (const earlier of [
    COMPILER_SEMANTIC_PROFILE_VERSION,
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
  ]) {
    assert.equal(
      requiredRelationInput(earlier).targetEntityId,
      undefined,
      `${earlier} must not carry a key it does not declare`,
    );
  }
});

/**
 * The negative control for the vector that actually bit during development:
 * gating the VERSION while emitting the KEY unconditionally. That mistake
 * typechecks, passes every shape assertion above at v2, and silently moves
 * every recorded release root. Only an artifact-bytes comparison catches it.
 */
test('an unadopted profile leaves the emitted catalog bytes untouched', () => {
  const adopted = ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION;
  assert.notEqual(
    adopted,
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    'this gate is meaningless once v2 is adopted; it must be revisited then',
  );
  assert.deepEqual(
    catalogAt(adopted),
    catalogAt(COMPILER_SEMANTIC_PROFILE_V1_VERSION),
    'the adopted profile must emit exactly what it emitted before v2 was cut',
  );
  assert.notDeepEqual(
    catalogAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION),
    catalogAt(adopted),
    'v2 must actually differ, or the test above proves nothing',
  );
});

test('the input contract version names both optional shapes independently', () => {
  const v2Catalog = catalogAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION);
  const adoptedCatalog = catalogAt(ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION);

  const versionsFor = (catalog: OperationCatalog, withRelations: boolean) =>
    catalog.operations
      .filter(
        (operation) =>
          operation.inputContract !== undefined &&
          operation.inputContract.relationInputs.length > 0 === withRelations,
      )
      .map((operation) => operation.inputContract!.schemaVersion);

  // The fixture is tenant-shared, so it carries no systemInput and exercises
  // the v1/v3 column of the 2x2. v2/v4 are asserted by the gateway's
  // biconditional rather than here, where no specimen declares a legal entity.
  for (const version of versionsFor(v2Catalog, true)) {
    assert.equal(
      version,
      MODULE_INPUT_CONTRACT_V3_VERSION,
      'relation inputs with targets declare v3',
    );
  }
  for (const version of versionsFor(v2Catalog, false)) {
    assert.equal(
      version,
      MODULE_INPUT_CONTRACT_VERSION,
      'an operation with no relations is unchanged by this ADR',
    );
  }
  for (const version of versionsFor(adoptedCatalog, true)) {
    assert.equal(
      version,
      MODULE_INPUT_CONTRACT_VERSION,
      'an unadopted profile keeps the pre-existing version',
    );
  }

  assert.notEqual(
    MODULE_INPUT_CONTRACT_V4_VERSION,
    MODULE_INPUT_CONTRACT_V2_VERSION,
    'the systemInput axis stays distinct from the relation axis',
  );
});
