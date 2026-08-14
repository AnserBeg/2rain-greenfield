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
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/definition.js';
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
      readonly closedArgumentKeys: readonly string[];
      readonly relationInputs: readonly RelationInput[];
      readonly schemaVersion: string;
    };
    readonly operationId: string;
  }[];
}

function compileAt(
  version: CompilerSemanticProfileVersion,
  definition: Record<string, unknown> = ordinaryModuleV1(),
): CompileSuccess {
  const normalized = normalizeApplicationPackage(definition) as {
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

function catalogAt(
  version: CompilerSemanticProfileVersion,
  definition?: Record<string, unknown>,
): OperationCatalog {
  return projectionPayload<OperationCatalog>(
    compileAt(version, definition),
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
 * REPLACES a control that proved nothing. The first version compared
 * `catalogAt(ADOPTED_...)` with `catalogAt(V1)` -- but the adopted constant IS
 * `COMPILER_SEMANTIC_PROFILE_V1_VERSION`, so it compiled the same profile twice
 * and asserted a compilation equals itself. It passed for a reason unrelated to
 * the property it named. Caught in review, 2026-08-10.
 *
 * The expectation is now a LITERAL, pinned here rather than derived from any
 * compile, so the subject cannot move both sides together. Whole-artifact byte
 * identity across the 8 recorded lineage entries is proven by
 * `check:app-release`, which recompiles each stored definition and exact-
 * compares its release root; this gate proves the narrower fact it can observe,
 * which is that the adopted profile emits the pre-packet relation shape.
 */
test('the v1 profile emits the pre-packet relation shape, pinned literally', () => {
  // REVISITED BY `profile-v2-adoption`, on this test's own written instruction.
  // The subject used to be `ADOPTED_...`, guarded by `adopted !== v2` with the
  // note "this gate is meaningless once v2 is adopted; it must be revisited
  // then". v2 is now adopted, so the subject is pinned to v1 LITERALLY.
  //
  // The property is unchanged and it is a property about HISTORY: entries 0-8
  // are recorded under v0/v1, and the three-key relation input is the shape
  // they must keep reproducing. Had this kept reading the adopted constant,
  // both `deepEqual` blocks below would describe the same profile -- the
  // four-key one -- and the test would fail loudly rather than silently, which
  // is how this packet found it. The self-comparison hazard the file header
  // records being caught in review on 2026-08-10 is the same one, mirrored.
  assert.notEqual(
    COMPILER_SEMANTIC_PROFILE_V1_VERSION,
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    'the two pinned subjects must be different profiles or neither block discriminates',
  );
  assert.deepEqual(
    requiredRelationInput(COMPILER_SEMANTIC_PROFILE_V1_VERSION),
    {
      archiveBehavior: 'restrict',
      relationId: REQUIRED_RELATION_ID,
      required: true,
    },
    'exactly three keys, and no targetEntityId, at the historical v1 profile',
  );
  assert.deepEqual(
    requiredRelationInput(COMPILER_SEMANTIC_PROFILE_V2_VERSION),
    {
      archiveBehavior: 'restrict',
      relationId: REQUIRED_RELATION_ID,
      required: true,
      targetEntityId: FIXTURE_IDS.entityIds.parent,
    },
    'exactly four keys at v2, or the gate above is not discriminating',
  );
});

test('the input contract version names both optional shapes independently', () => {
  const v2Catalog = catalogAt(COMPILER_SEMANTIC_PROFILE_V2_VERSION);
  // Pinned to v1 literally by `profile-v2-adoption` for the same reason as the
  // test above: this was `catalogAt(ADOPTED_...)`, and adoption made that the
  // v2 catalog, so the "keeps the pre-existing version" loop below would have
  // been asserting v3 === v1 against the very catalog the first loop already
  // covers. The contrast the test is named for is v1-vs-v2, not
  // adopted-vs-latest.
  const v1Catalog = catalogAt(COMPILER_SEMANTIC_PROFILE_V1_VERSION);

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
  for (const version of versionsFor(v1Catalog, true)) {
    assert.equal(
      version,
      MODULE_INPUT_CONTRACT_VERSION,
      'a pre-v2 profile keeps the pre-existing version, which is what the recorded entries must reproduce',
    );
  }

  assert.notEqual(
    MODULE_INPUT_CONTRACT_V4_VERSION,
    MODULE_INPUT_CONTRACT_V2_VERSION,
    'the systemInput axis stays distinct from the relation axis',
  );
});

/**
 * The v4 quadrant -- systemInput AND relation targets together -- which the
 * tenant-shared fixture cannot reach because it declares no legal entity. Raised
 * in review as evidenced only by source inspection. Inventory is the specimen:
 * `stock_count_line` carries a legal entity and two required relations.
 */
test('an operation with both a legal entity and relations declares v4', () => {
  const catalog = catalogAt(
    COMPILER_SEMANTIC_PROFILE_V2_VERSION,
    inventoryModuleDefinition() as unknown as Record<string, unknown>,
  );
  const both = catalog.operations.filter(
    (operation) =>
      operation.inputContract !== undefined &&
      operation.inputContract.relationInputs.length > 0 &&
      operation.inputContract.closedArgumentKeys.includes('legalEntityId'),
  );
  assert.ok(
    both.length > 0,
    'inventory must contribute an operation carrying both shapes',
  );
  for (const operation of both) {
    assert.equal(
      operation.inputContract!.schemaVersion,
      MODULE_INPUT_CONTRACT_V4_VERSION,
      'both shapes present must declare v4, not v2 or v3',
    );
    for (const relation of operation.inputContract!.relationInputs) {
      assert.ok(
        relation.targetEntityId !== undefined,
        'a v4 relation input carries its target',
      );
    }
  }

  const relationsOnly = catalog.operations.filter(
    (operation) =>
      operation.inputContract !== undefined &&
      operation.inputContract.relationInputs.length > 0 &&
      !operation.inputContract.closedArgumentKeys.includes('legalEntityId'),
  );
  for (const operation of relationsOnly) {
    assert.equal(
      operation.inputContract!.schemaVersion,
      MODULE_INPUT_CONTRACT_V3_VERSION,
      'relations without a legal entity stay v3, so v4 is not a blanket bump',
    );
  }
});
