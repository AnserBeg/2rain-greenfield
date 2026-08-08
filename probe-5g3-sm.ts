/**
 * 5g3-sm PROBE ONLY -- NOT FOR MERGE.
 *
 * Walks a `transitionStateEffect` operation outward from the canonical layer
 * and records the exact site at which each layer stops.
 */
import {
  CanonicalModelError,
  canonicalize,
  normalizeApplicationPackage,
} from './packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  PROJECTION_FAMILY_IDS,
  compileApplication,
  type CompilerInput,
} from './packages/compiler/src/index.js';
import { ordinaryModuleV1 } from './test/fixtures/g2/module-conformance/definitions.js';

const namespace = 'northstar.modulefixture';
const version = 'v3';
const reference = (kind: string, targetId: string) => ({
  kind,
  schemaVersion: version,
  targetId,
});

const machineId = `${namespace}:machine.master_lifecycle`;
const draftStateId = `${namespace}:state.master_draft`;
const releasedStateId = `${namespace}:state.master_released`;
const transitionId = `${namespace}:transition.master_release`;
const permissionId = `${namespace}:permission.master_release`;
const operationId = `${namespace}:operation.master_release`;
const derivedFieldId = `${namespace}:derived_state_field.machine.master_lifecycle`;

function withTransition(
  mutate?: (definition: Record<string, any>) => void,
): Record<string, unknown> {
  const definition = structuredClone(ordinaryModuleV1()) as Record<string, any>;
  definition.stateMachines = [
    {
      entity: reference('entityReference', `${namespace}:entity.master`),
      initialState: reference('stateReference', draftStateId),
      kind: 'stateMachineDefinition',
      machineId,
      schemaVersion: version,
      states: [
        {
          kind: 'stateDefinition',
          label: 'Draft',
          orderKey: 10,
          schemaVersion: version,
          stateId: draftStateId,
        },
        {
          kind: 'stateDefinition',
          label: 'Released',
          orderKey: 20,
          schemaVersion: version,
          stateId: releasedStateId,
        },
      ],
      transitions: [
        {
          fromState: reference('stateReference', draftStateId),
          kind: 'transitionDefinition',
          label: 'Release master',
          orderKey: 10,
          permission: reference('permissionReference', permissionId),
          schemaVersion: version,
          toState: reference('stateReference', releasedStateId),
          transitionId,
        },
      ],
    },
  ];
  definition.permissions.push({
    action: 'transition',
    kind: 'permissionDefinition',
    label: 'master release',
    permissionId,
    resource: reference('entityReference', `${namespace}:entity.master`),
    schemaVersion: version,
  });
  definition.operations.push({
    confirmation: 'none',
    effect: {
      kind: 'transitionStateEffect',
      schemaVersion: version,
      transition: reference('transitionReference', transitionId),
    },
    kind: 'operationDefinition',
    module: reference('moduleReference', `${namespace}:module.master`),
    operationId,
    permission: reference('permissionReference', permissionId),
    readBack: reference('queryReference', `${namespace}:query.master_get`),
    schemaVersion: version,
    tier: 'o0',
  });
  mutate?.(definition);
  return definition;
}

function input(definition: unknown): CompilerInput {
  const normalized = normalizeApplicationPackage(definition) as Record<
    string,
    unknown
  >;
  return {
    dependencies: [],
    expectedActiveRelease: null,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: new TextEncoder().encode(
      canonicalize(normalized),
    ),
    profile: {
      ...MODULE_COMPILER_PROFILE,
      languageVersion: normalized.languageVersion,
      normalizationProfileVersion: normalized.normalizationProfileVersion,
    },
  } as CompilerInput;
}

function measure(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof CanonicalModelError) {
      console.log(
        `STOP ${label}\n     ${JSON.stringify(error.diagnostics)}\n`,
      );
      return;
    }
    console.log(`STOP ${label}\n     ${(error as Error).message}\n`);
  }
}

console.log('=== A. canonical layer ===');
measure('normalize accepts stateMachine + transitionStateEffect', () => {
  const normalized = normalizeApplicationPackage(withTransition()) as any;
  console.log('OK   normalize accepts it');
  console.log(
    '     derived stateField =',
    JSON.stringify(normalized.stateMachines[0].stateField),
  );
  console.log(
    '     authored projection keeps stateField? ',
    JSON.stringify(normalized.stateMachines[0].stateField !== undefined),
  );
});

console.log('\n=== B. can a predicate address the derived state field? ===');
measure('operation precondition referencing the derived state field', () => {
  normalizeApplicationPackage(
    withTransition((definition) => {
      const operation = definition.operations.find(
        (entry: { operationId: string }) => entry.operationId === operationId,
      );
      operation.precondition = {
        field: reference('fieldReference', derivedFieldId),
        kind: 'fieldComparisonPredicate',
        operator: 'equals',
        schemaVersion: version,
        value: {
          kind: 'textValue',
          schemaVersion: version,
          value: draftStateId,
        },
      };
    }),
  );
  console.log('OK   predicate resolved the derived state field');
});

console.log('\n=== C. can a query select the derived state field? ===');
measure('query selection referencing the derived state field', () => {
  normalizeApplicationPackage(
    withTransition((definition) => {
      const query = definition.queries.find((entry: { queryId: string }) =>
        entry.queryId.endsWith(':query.master_get'),
      );
      query.selections.push({
        field: reference('fieldReference', derivedFieldId),
        kind: 'querySelection',
        orderKey: 900,
        schemaVersion: version,
        selectionId: `${namespace}:selection.master_get_state`,
      });
    }),
  );
  console.log('OK   query selection resolved the derived state field');
});

console.log('\n=== D. compiler ===');
measure('compileApplication', () => {
  const result = compileApplication(input(withTransition())) as any;
  console.log('     status =', result.status);
  if (result.status !== 'compiled') {
    console.log('     diagnostics =', JSON.stringify(result.diagnostics));
    return;
  }
  const payloadFor = (familyId: string) => {
    const projection = result.bundle.releaseManifest.projections.find(
      (entry: { familyId: string }) => entry.familyId === familyId,
    );
    const manifestArtifact = result.bundle.artifacts.find(
      (entry: { contentHash: string }) =>
        entry.contentHash === projection.artifactRoot,
    );
    const manifest = JSON.parse(
      new TextDecoder().decode(manifestArtifact.canonicalBytes),
    );
    const chunk = result.bundle.artifacts.find(
      (entry: { contentHash: string }) =>
        entry.contentHash === manifest.chunks[0]?.contentHash,
    );
    return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes));
  };
  console.log(
    '     projection families =',
    JSON.stringify(
      result.bundle.releaseManifest.projections.map(
        (entry: { familyId: string }) => entry.familyId,
      ),
    ),
  );
  const operations = payloadFor(
    PROJECTION_FAMILY_IDS.operationCatalog,
  )?.operations;
  const compiled = operations?.find(
    (entry: { operationId: string }) => entry.operationId === operationId,
  );
  console.log('     compiled operation =', JSON.stringify(compiled));
  const storage = payloadFor(PROJECTION_FAMILY_IDS.storageTarget);
  const master = storage?.entities?.find(
    (entry: { entityId: string }) =>
      entry.entityId === `${namespace}:entity.master`,
  );
  console.log(
    '     derivedStateFields =',
    JSON.stringify(master?.derivedStateFields),
  );
  console.log(
    '     entity.columns =',
    JSON.stringify(
      master?.columns?.map((c: { canonicalFieldId: string }) => c.canonicalFieldId),
    ),
  );
  const semantic = payloadFor(PROJECTION_FAMILY_IDS.semanticModel);
  const transitionConstruct = semantic?.constructs?.find(
    (entry: { subjectId: string }) => entry.subjectId === transitionId,
  );
  console.log(
    '     semantic-model construct for the transition =',
    JSON.stringify(transitionConstruct),
  );
});
