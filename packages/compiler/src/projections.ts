import {
  DEFAULT_DISCLOSURE_TIER,
  LANGUAGE_VERSION,
  languageHasMaterializedStateFields,
  type NormalizedApplicationPackage,
  type VersionedNormalizedApplicationPackage,
} from '@north-star/canonical-model';

import { hashCanonical } from './hash.js';
import { lowerQueryPredicate } from './predicate-lowering.js';
import {
  lowerStorageTargetV1,
  type StorageTargetPayloadV1,
} from './storage.js';
import {
  COMPILER_SEMANTIC_PROFILE_V2_VERSION,
  COMPILER_SEMANTIC_PROFILE_VERSION,
  COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION,
  GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION,
  HASH_DOMAINS,
  MODULE_INPUT_CONTRACT_VERSION,
  MODULE_INPUT_CONTRACT_V2_VERSION,
  MODULE_INPUT_CONTRACT_V3_VERSION,
  MODULE_INPUT_CONTRACT_V4_VERSION,
  OPERATIONS_AGENT_TOOL_IDS,
  POLICY_MODEL_VERSION,
  PROJECTION_FAMILY_IDS,
  VERIFICATION_PLAN_PAYLOAD_VERSION,
  VERIFICATION_SCENARIO_VERSION,
  type CompilerSemanticProfileVersion,
  type LogicalScope,
  type ProjectionFamilyId,
  type RuntimeCapabilityRequirement,
} from './protocol.js';

export interface ProjectionPayloadPlan {
  familyId: ProjectionFamilyId;
  instanceId: string;
  logicalScope: LogicalScope;
  payload: unknown;
  payloadSchemaVersion: string;
  requiredRuntimeCapability: RuntimeCapabilityRequirement;
}

/** One subject resolver shared by whole-model validation and lowering. */
export function verificationAssertionEntityId(
  packageRevision: VersionedNormalizedApplicationPackage,
  assertion: VersionedNormalizedApplicationPackage['assertions'][number],
): string | undefined {
  if (assertion.invocation.kind === 'queryInvocation') {
    const queryId = assertion.invocation.query.targetId;
    return packageRevision.queries.find((query) => query.queryId === queryId)
      ?.sourceEntity.targetId;
  }
  const operationId = assertion.invocation.operation.targetId;
  const operation = packageRevision.operations.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!operation) return undefined;
  if ('entity' in operation.effect) return operation.effect.entity.targetId;
  return packageRevision.queries.find(
    (query) => query.queryId === operation.readBack.targetId,
  )?.sourceEntity.targetId;
}

const payloadSchemaVersions: Record<
  Exclude<ProjectionFamilyId, typeof PROJECTION_FAMILY_IDS.storageTransition>,
  string
> = {
  [PROJECTION_FAMILY_IDS.agentDiscovery]:
    'northstar.agent-discovery-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.operationCatalog]:
    'northstar.operation-catalog-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.policyReferences]:
    'northstar.policy-references-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.queryCatalog]:
    'northstar.query-catalog-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.reporting]: 'northstar.reporting-payload/v1',
  [PROJECTION_FAMILY_IDS.semanticModel]:
    'northstar.semantic-model-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.storageTarget]:
    'northstar.storage-target-payload/v0-provisional',
  [PROJECTION_FAMILY_IDS.surfaceManifest]:
    FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION,
  [PROJECTION_FAMILY_IDS.verificationPlan]: VERIFICATION_PLAN_PAYLOAD_VERSION,
};

const MAX_PRIMARY_NAVIGATION_ENTRIES = 5;

const runtimeCapabilities: Record<
  Exclude<ProjectionFamilyId, typeof PROJECTION_FAMILY_IDS.storageTransition>,
  RuntimeCapabilityRequirement
> = {
  [PROJECTION_FAMILY_IDS.agentDiscovery]: {
    capabilityId: 'northstar.runtime:capability.agent-discovery',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.operationCatalog]: {
    capabilityId: 'northstar.runtime:capability.operation-catalog',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.policyReferences]: {
    capabilityId: 'northstar.runtime:capability.policy-references',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.queryCatalog]: {
    capabilityId: 'northstar.runtime:capability.query-catalog',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.reporting]: {
    capabilityId: 'northstar.runtime:capability.reporting-projection',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.semanticModel]: {
    capabilityId: 'northstar.runtime:capability.semantic-model',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.storageTarget]: {
    capabilityId: 'northstar.runtime:capability.storage-target',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.surfaceManifest]: {
    capabilityId: 'northstar.runtime:capability.surface-manifest',
    minimumVersion: 1,
  },
  [PROJECTION_FAMILY_IDS.verificationPlan]: {
    capabilityId: 'northstar.runtime:capability.verification-plan',
    minimumVersion: 1,
  },
};

export function lowerBaseProjectionPayloads(
  packageRevision: NormalizedApplicationPackage,
  previousStorageTarget: StorageTargetPayloadV1 | null = null,
  verificationPackageRevision: VersionedNormalizedApplicationPackage = packageRevision,
  // ADR-0047 §1 authorises projection dispatch on this axis; U5b is the first
  // consumer, so it is also the packet that wires it. Defaults to v0 so a
  // caller that does not pass one gets the oldest shape rather than the newest.
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion = COMPILER_SEMANTIC_PROFILE_VERSION,
): ProjectionPayloadPlan[] {
  const namespace = packageRevision.package.namespace;
  const packageScope: LogicalScope = {
    kind: 'packageScope',
    scopeId: packageRevision.package.packageId,
  };
  const queryById = new Map(
    packageRevision.queries.map((query) => [query.queryId, query] as const),
  );

  const isModuleV1 = packageRevision.languageVersion === LANGUAGE_VERSION;
  // The AUTHORED version. `packageRevision` may be the dispatch alias; the
  // third parameter is the real revision and is the only reliable source here.
  const materializedStateFields = languageHasMaterializedStateFields(
    verificationPackageRevision.languageVersion,
  );
  const currentStorageTarget = isModuleV1
    ? lowerStorageTargetV1(
        packageRevision,
        previousStorageTarget,
        materializedStateFields,
      )
    : null;
  const surfaceManifest = surfaceManifestPayload(
    packageRevision,
    queryById,
    compilerSemanticProfileVersion,
    verificationPackageRevision,
  );
  const plans = [
    plan(
      PROJECTION_FAMILY_IDS.semanticModel,
      namespace,
      packageScope,
      semanticModelPayload(packageRevision),
    ),
    plan(
      PROJECTION_FAMILY_IDS.storageTarget,
      namespace,
      packageScope,
      currentStorageTarget ?? storageTargetPayload(packageRevision),
      isModuleV1 ? currentStorageTarget?.schemaVersion : undefined,
    ),
    plan(
      PROJECTION_FAMILY_IDS.queryCatalog,
      namespace,
      packageScope,
      queryCatalogPayload(packageRevision, currentStorageTarget),
    ),
    plan(
      PROJECTION_FAMILY_IDS.operationCatalog,
      namespace,
      packageScope,
      operationCatalogPayload(
        packageRevision,
        currentStorageTarget,
        compilerSemanticProfileVersion,
      ),
    ),
    plan(
      PROJECTION_FAMILY_IDS.surfaceManifest,
      namespace,
      packageScope,
      surfaceManifest.payload,
      surfaceManifest.payloadSchemaVersion,
      surfaceManifest.requiredRuntimeCapability,
    ),
    plan(
      PROJECTION_FAMILY_IDS.policyReferences,
      namespace,
      packageScope,
      policyReferencesPayload(packageRevision),
    ),
    plan(
      PROJECTION_FAMILY_IDS.agentDiscovery,
      namespace,
      packageScope,
      agentDiscoveryPayload(packageRevision, verificationPackageRevision),
    ),
    plan(
      PROJECTION_FAMILY_IDS.verificationPlan,
      namespace,
      packageScope,
      verificationPlanPayload(verificationPackageRevision),
    ),
  ];
  if (isModuleV1) {
    plans.push(
      plan(
        PROJECTION_FAMILY_IDS.reporting,
        namespace,
        packageScope,
        reportingPayload(packageRevision),
      ),
    );
  }
  return plans;
}

/**
 * The compiled catalog entry for the v4 legal-entity operand. The gateway
 * reads exactly this to learn that a query requires a scope, which declared
 * parameter carries it, and how many entities that parameter admits — so the
 * query contract and the execution contract have one authority, not two.
 *
 * An absent member means the query declares no operand. It never means "all".
 */
export function legalEntityScopeCatalogEntry(
  query: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const scope = query.legalEntityScope;
  return scope === undefined
    ? {}
    : { legalEntityScope: structuredClone(scope) };
}

/**
 * Declared query parameters, compiled for every branch that has them. v3 emits
 * this for aggregates only; v4 row queries carry it too, because a Q0 read of
 * an entity-owned family needs the same operand an aggregate does.
 */
export function queryParameterCatalogEntries(
  query: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const parameters = query.parameters;
  if (!Array.isArray(parameters)) return [];
  return parameters.map((parameter: Record<string, unknown>) => ({
    orderKey: parameter.orderKey,
    parameterId: parameter.parameterId,
    parameterType: structuredClone(parameter.parameterType),
  }));
}

export function requiredProjectionFamily(
  requirement: string,
): ProjectionFamilyId | null {
  const mapping: Record<string, ProjectionFamilyId | null> = {
    agent: PROJECTION_FAMILY_IDS.agentDiscovery,
    operation: PROJECTION_FAMILY_IDS.operationCatalog,
    policy: PROJECTION_FAMILY_IDS.policyReferences,
    query: PROJECTION_FAMILY_IDS.queryCatalog,
    reporting: PROJECTION_FAMILY_IDS.reporting,
    storage: PROJECTION_FAMILY_IDS.storageTarget,
    surface: PROJECTION_FAMILY_IDS.surfaceManifest,
    verification: PROJECTION_FAMILY_IDS.verificationPlan,
  };
  return mapping[requirement] ?? null;
}

function plan(
  familyId: Exclude<
    ProjectionFamilyId,
    typeof PROJECTION_FAMILY_IDS.storageTransition
  >,
  namespace: string,
  logicalScope: LogicalScope,
  payload: unknown,
  payloadSchemaVersion?: string,
  requiredRuntimeCapability?: RuntimeCapabilityRequirement,
): ProjectionPayloadPlan {
  const suffix = familyId.slice(familyId.lastIndexOf('.') + 1);
  return {
    familyId,
    instanceId: `${namespace}:projection.${suffix}`,
    logicalScope,
    payload,
    payloadSchemaVersion:
      payloadSchemaVersion ?? payloadSchemaVersions[familyId],
    requiredRuntimeCapability:
      requiredRuntimeCapability ?? runtimeCapabilities[familyId],
  };
}

function semanticModelPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  const constructs: Array<{
    constructKind: string;
    semanticFingerprint: string;
    subjectId: string;
  }> = [];
  const add = (constructKind: string, subjectId: string, value: unknown) => {
    constructs.push({
      constructKind,
      semanticFingerprint: hashCanonical(HASH_DOMAINS.semanticConstruct, value)
        .digest,
      subjectId,
    });
  };

  add(
    packageRevision.package.kind,
    packageRevision.package.packageId,
    packageRevision.package,
  );
  addFamily(constructs, packageRevision.modules, 'moduleId');
  addFamily(constructs, packageRevision.entities, 'entityId');
  addFamily(constructs, packageRevision.fields, 'fieldId');
  addFamily(constructs, packageRevision.relations, 'relationId');
  addFamily(constructs, packageRevision.surfaces, 'surfaceId');
  addFamily(constructs, packageRevision.queries, 'queryId');
  addFamily(constructs, packageRevision.operations, 'operationId');
  addFamily(constructs, packageRevision.permissions, 'permissionId');
  addFamily(constructs, packageRevision.assertions, 'assertionId');
  addFamily(constructs, packageRevision.storageMappings, 'storageMappingId');
  addFamily(constructs, packageRevision.capabilityRequirements, 'capabilityId');
  for (const machine of packageRevision.stateMachines) {
    add(machine.kind, machine.machineId, machine);
    for (const state of machine.states) add(state.kind, state.stateId, state);
    for (const transition of machine.transitions) {
      add(transition.kind, transition.transitionId, transition);
    }
  }

  constructs.sort((left, right) => compare(left.subjectId, right.subjectId));
  return {
    constructs,
    kind: 'semanticModelPayload',
    schemaVersion: payloadSchemaVersions[PROJECTION_FAMILY_IDS.semanticModel],
  };
}

function storageTargetPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  const fieldsByEntity = new Map<string, typeof packageRevision.fields>();
  for (const field of packageRevision.fields) {
    const fields = fieldsByEntity.get(field.entity.targetId) ?? [];
    fields.push(field);
    fieldsByEntity.set(field.entity.targetId, fields);
  }
  const stateFieldsByEntity = new Map<
    string,
    Array<{
      fieldId: string;
      lifecycle: string;
      stateMachineId: string;
      valueKind: 'stateId';
    }>
  >();
  for (const machine of packageRevision.stateMachines) {
    const stateFields = stateFieldsByEntity.get(machine.entity.targetId) ?? [];
    stateFields.push({
      fieldId: machine.stateField.fieldId,
      lifecycle: machine.lifecycle,
      stateMachineId: machine.machineId,
      valueKind: machine.stateField.valueKind,
    });
    stateFieldsByEntity.set(machine.entity.targetId, stateFields);
  }
  const storageById = new Map(
    packageRevision.storageMappings.map((mapping) => [
      mapping.storageMappingId,
      mapping,
    ]),
  );
  return {
    entities: packageRevision.entities.map((entity) => {
      const selectedStorage = storageById.get(entity.storage.targetId);
      return {
        derivedStateFields: stateFieldsByEntity.get(entity.entityId) ?? [],
        entityId: entity.entityId,
        fields: (fieldsByEntity.get(entity.entityId) ?? []).map((field) => ({
          classification: field.classification,
          fieldId: field.fieldId,
          fieldType: field.fieldType,
          lifecycle: field.lifecycle,
          presence: field.presence,
        })),
        lifecycle: entity.lifecycle,
        storageClass: selectedStorage?.storageClass ?? null,
        storageMappingId: entity.storage.targetId,
      };
    }),
    kind: 'storageTargetPayload',
    schemaVersion: payloadSchemaVersions[PROJECTION_FAMILY_IDS.storageTarget],
  };
}

function queryCatalogPayload(
  packageRevision: NormalizedApplicationPackage,
  storage: StorageTargetPayloadV1 | null,
): unknown {
  return {
    kind: 'queryCatalogPayload',
    queries: packageRevision.queries.map((query) => ({
      filter: query.filter,
      ...(query.tier === 'q1' && storage
        ? {
            filterPlan: lowerQueryPredicate(
              query.filter,
              query.sourceEntity.targetId,
              packageRevision,
              storage,
            ),
          }
        : {}),
      lifecycle: query.lifecycle,
      maximumResultCount: query.maximumResultCount,
      permissionId: query.permission.targetId,
      queryId: query.queryId,
      queryType: query.queryType,
      ...(packageRevision.languageVersion === LANGUAGE_VERSION
        ? {
            resolveMatchKeys: (query.resolveMatchKeys ?? []).map(
              (matchKey) => ({
                authority: matchKey.authority,
                fieldId: matchKey.field.targetId,
                matchKeyId: matchKey.matchKeyId,
                orderKey: matchKey.orderKey,
              }),
            ),
          }
        : {}),
      selections: query.selections.map((selection) => ({
        fieldId: selection.field.targetId,
        orderKey: selection.orderKey,
        selectionId: selection.selectionId,
      })),
      sourceEntityId: query.sourceEntity.targetId,
      tier: query.tier,
      ...(packageRevision.languageVersion === LANGUAGE_VERSION
        ? {
            infrastructure: {
              archive: 'nullableArchivedAt',
              optimisticRevision: 'requiredOnMutation',
              recordIdentity: 'canonicalUuid',
            },
          }
        : {}),
    })),
    schemaVersion: payloadSchemaVersions[PROJECTION_FAMILY_IDS.queryCatalog],
  };
}

/**
 * A `transitionStateEffect` names a transition and nothing else. The runtime
 * needs three further facts to execute one -- the entity, the state field, and
 * the server-selected target -- and **no pinned projection carries any of
 * them**: the semantic-model projection carries a `semanticFingerprint` of the
 * transition, not its content. That measured absence is why admitting the
 * effect is a projection change rather than the execution-fence widening it
 * resembles.
 *
 * Resolving them here keeps the compiler the single authority for what a
 * transition means. The runtime never walks the machine, so it cannot reach a
 * different answer.
 *
 * Below v5 the effect is refused by `conformance.ts` before reaching this
 * point, so the unresolved arm is unreachable for a compiled release and is
 * retained only as a total function.
 */
function resolvedEffect(
  effect: NormalizedApplicationPackage['operations'][number]['effect'],
  packageRevision: NormalizedApplicationPackage,
): unknown {
  if (effect.kind !== 'transitionStateEffect') return effect;
  const machine = packageRevision.stateMachines.find((candidate) =>
    candidate.transitions.some(
      (transition) => transition.transitionId === effect.transition.targetId,
    ),
  );
  if (!machine) return effect;
  const transition = machine.transitions.find(
    (candidate) => candidate.transitionId === effect.transition.targetId,
  )!;
  return {
    entity: machine.entity,
    fromStateId: transition.fromState.targetId,
    kind: effect.kind,
    schemaVersion: effect.schemaVersion,
    stateFieldId: machine.stateField.fieldId,
    toStateId: transition.toState.targetId,
    transition: effect.transition,
  };
}

function operationCatalogPayload(
  packageRevision: NormalizedApplicationPackage,
  storageTarget: StorageTargetPayloadV1 | null,
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion,
): unknown {
  const fieldsByEntity = groupBy(
    packageRevision.fields.filter((field) => field.lifecycle === 'active'),
    (field) => field.entity.targetId,
  );
  const relationsByEntity = groupBy(
    packageRevision.relations.filter(
      (relation) => relation.lifecycle === 'active',
    ),
    (relation) => relation.sourceEntity.targetId,
  );
  const storageByEntity = new Map(
    (storageTarget?.entities ?? []).map((entity) => [entity.entityId, entity]),
  );
  const stateFieldIds = new Set(
    packageRevision.stateMachines.map((machine) => machine.stateField.fieldId),
  );
  return {
    kind: 'operationCatalogPayload',
    operations: packageRevision.operations.map((operation) => ({
      confirmation: operation.confirmation,
      effect: resolvedEffect(operation.effect, packageRevision),
      lifecycle: operation.lifecycle,
      operationId: operation.operationId,
      permissionId: operation.permission.targetId,
      precondition: operation.precondition,
      readBackQueryId: operation.readBack.targetId,
      tier: operation.tier,
      ...(packageRevision.languageVersion === LANGUAGE_VERSION
        ? {
            inputContract: operationInputContract(
              operation,
              'entity' in operation.effect
                ? // A machine's state field is never caller-writable: it is
                  // seeded from `initialState` and moved only by a transition.
                  // A caller that could patch it could forge a state, which is
                  // the whole guarantee the carrier exists to provide. This is
                  // the same exclusion `systemInput` already applies to
                  // `legalEntityId`.
                  (
                    fieldsByEntity.get(operation.effect.entity.targetId) ?? []
                  ).filter((field) => !stateFieldIds.has(field.fieldId))
                : [],
              'entity' in operation.effect
                ? (relationsByEntity.get(operation.effect.entity.targetId) ??
                    [])
                : [],
              'entity' in operation.effect
                ? storageByEntity.get(operation.effect.entity.targetId)
                : undefined,
              compilerSemanticProfileVersion,
            ),
            infrastructure: {
              archiveRepresentation: 'nullableArchivedAt',
              optimisticRevision: 'compareAndIncrement',
              recordIdentity: 'canonicalUuid',
            },
          }
        : {}),
    })),
    schemaVersion:
      payloadSchemaVersions[PROJECTION_FAMILY_IDS.operationCatalog],
  };
}

type NormalizedField = NormalizedApplicationPackage['fields'][number];

/**
 * The declared domain of a field, projected losslessly enough that a control can
 * admit all of it and no more.
 *
 * **The first cut of this carried `kind` and enum `options` only, and that was
 * wrong** -- a review found the comment claiming nothing else changes the
 * control while two temporal discriminants decide whether a control can express
 * the value at all. `timeFieldType.precision`, `dateTimeFieldType.precision` and
 * `dateTimeFieldType.timezoneSemantics` are canonical declarations: a stored
 * `2026-08-09T12:34:56.789Z` or a `-06:00` offset is simply not representable
 * by a control that does not know them, and both temporal inputs default to a
 * 60-second step, so seconds and milliseconds fail native validation before any
 * normalization gets a chance. Carrying them is not implementing `U7`'s form
 * behaviour; it is what gives `U7` a contract without a hole in it.
 *
 * `temporal` deliberately mirrors the operation input contract's already-ratified
 * shape (`operationInputContract` below), value for value. One fact, one
 * spelling, in both directions of the seam.
 *
 * `required` is carried for the same reason and **the renderer does not branch
 * on it.** A boolean's legal state count is not derivable from `kind`: an
 * optional one has three states (`true`, `false`, unset) and a required one has
 * two, and the difference is invisible to every consumer without this. `U7` owns
 * what to DO about required-ness; this owns not throwing the fact away.
 *
 * Each optional key is present exactly when its kind calls for it -- `options`
 * iff `enumFieldType`, `temporal` iff a temporal kind -- so a reader that finds
 * one missing has read a malformed payload rather than a field without choices
 * or without precision.
 */
function surfaceManifestField(field: NormalizedField): {
  readonly fieldId: string;
  readonly kind: NormalizedField['fieldType']['kind'];
  readonly options?: readonly {
    readonly label: string;
    readonly optionId: string;
  }[];
  readonly required: boolean;
  readonly temporal?: {
    readonly precision: 'millisecond' | 'second' | null;
    readonly timezoneSemantics:
      'calendarDate' | 'localWallTime' | 'offsetDateTime' | 'utcInstant';
  };
} {
  return {
    fieldId: field.fieldId,
    kind: field.fieldType.kind,
    ...(field.fieldType.kind === 'enumFieldType'
      ? {
          options: field.fieldType.options.map((option) => ({
            label: option.label,
            optionId: option.optionId,
          })),
        }
      : {}),
    required: field.presence === 'required',
    ...(field.fieldType.kind === 'dateFieldType'
      ? { temporal: { precision: null, timezoneSemantics: 'calendarDate' } }
      : field.fieldType.kind === 'timeFieldType'
        ? {
            temporal: {
              precision: field.fieldType.precision,
              timezoneSemantics: 'localWallTime',
            },
          }
        : field.fieldType.kind === 'dateTimeFieldType'
          ? {
              temporal: {
                precision: field.fieldType.precision,
                timezoneSemantics: field.fieldType.timezoneSemantics,
              },
            }
          : {}),
  };
}

function surfaceManifestPayload(
  packageRevision: NormalizedApplicationPackage,
  queryById: Map<string, NormalizedApplicationPackage['queries'][number]>,
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion,
  original: VersionedNormalizedApplicationPackage,
): {
  readonly payload: unknown;
  readonly payloadSchemaVersion:
    | typeof FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION
    | typeof GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION
    | typeof COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION;
  readonly requiredRuntimeCapability: RuntimeCapabilityRequirement;
} {
  const navigation = surfaceNavigationTree(packageRevision);
  const fieldById = new Map(
    packageRevision.fields.map((field) => [field.fieldId, field]),
  );
  // One condition, read by both the emission below and the capability floor, so
  // the floor cannot drift from what the payload actually carries.
  const emitsFieldKinds =
    compilerSemanticProfileVersion === COMPILER_SEMANTIC_PROFILE_V2_VERSION;
  // Load-bearing compatibility fence: labelling grouped output as v0 lets
  // v0 readers ignore the tree and silently reconstruct unreachable overflow.
  const composed = original.languageVersion === 'v6';
  const compositions = new Map(
    original.surfaces.map((surface) => [
      surface.surfaceId,
      'composition' in surface ? surface.composition : undefined,
    ]),
  );
  const payloadSchemaVersion = composed
    ? COMPOSED_SURFACE_MANIFEST_PAYLOAD_VERSION
    : navigation
      ? GROUPED_SURFACE_MANIFEST_PAYLOAD_VERSION
      : FLAT_SURFACE_MANIFEST_PAYLOAD_VERSION;
  return {
    payload: {
      kind: 'surfaceManifestPayload',
      ...(navigation ? { navigation } : {}),
      schemaVersion: payloadSchemaVersion,
      surfaces: packageRevision.surfaces.map((surface) => {
        const fieldIds =
          queryById
            .get(surface.dataSource.targetId)
            ?.selections.map((selection) => selection.field.targetId) ?? [];
        return {
          ...(compositions.get(surface.surfaceId)
            ? { composition: compositions.get(surface.surfaceId) }
            : {}),
          archetype: surface.archetype,
          dataSourceQueryId: surface.dataSource.targetId,
          fieldIds,
          // Gated on the UNADOPTED v2, exactly as `disclosureTier` is one level
          // down: readable and unemitted, so no recorded release root moves.
          //
          // Nothing is defaulted. Every canonical field DECLARES a `fieldType`,
          // so there is no absent kind to invent -- the projection carries what
          // the definition already says and stops. What can be absent is the
          // whole key, under every profile that is not v2, and a reader must see
          // that absence rather than a materialized default.
          //
          // `flatMap` drops a field the package does not declare. Normalization
          // refuses that package first (`CANON_REFERENCE_UNRESOLVED`), so the
          // drop is unreachable today; it is written this way rather than with an
          // assertion because the observable consequence belongs at the reader,
          // where a short `fields` against a full `fieldIds` is refused by name
          // instead of rendering half a form as bare text boxes.
          ...(emitsFieldKinds
            ? {
                fields: fieldIds.flatMap((fieldId) => {
                  const field = fieldById.get(fieldId);
                  return field ? [surfaceManifestField(field)] : [];
                }),
              }
            : {}),
          label: surface.label,
          lifecycle: surface.lifecycle,
          slots: surface.slots.map((slot) => ({
            contentReferenceId: slot.content.targetId,
            // Gated on the UNADOPTED v2, so this is readable and unemitted: no
            // recorded entry compiles under v2, and every release root holds.
            // `?? DEFAULT_DISCLOSURE_TIER` resolves an absent declaration at
            // projection time rather than by materializing it into the
            // normalized definition, which is what keeps those roots stable --
            // the `surfaceRole` precedent one line below does exactly the same.
            ...(compilerSemanticProfileVersion ===
            COMPILER_SEMANTIC_PROFILE_V2_VERSION
              ? {
                  disclosureTier:
                    slot.disclosureTier ?? DEFAULT_DISCLOSURE_TIER,
                }
              : {}),
            orderKey: slot.orderKey,
            slot: slot.slot,
            slotId: slot.slotId,
          })),
          statusRoles: surface.statusRoles,
          surfaceId: surface.surfaceId,
          ...(packageRevision.languageVersion === LANGUAGE_VERSION
            ? { surfaceRole: surface.surfaceRole ?? null }
            : {}),
        };
      }),
    },
    payloadSchemaVersion,
    // `minimumVersion` stays 1 when the tier is emitted, and that is honest on a
    // named condition rather than by omission. It declares what a reader must
    // support to consume the payload SAFELY. `navigation` bumped it to 2 because
    // a v0 reader silently reconstructs unreachable overflow -- a WRONG render.
    // A reader that drops the tier renders every slot expanded, which is exactly
    // what `always` means, so it under-defers rather than concealing. The
    // condition is that no tier value ever means "hide"; the moment one does,
    // this needs re-deriving. Recorded, not fixed (U5b review item 3).
    //
    // **`fields` ALLOCATES version 3 rather than arguing its way to staying at
    // 1, and that is a deliberate retreat from a claim this packet could not
    // hold.** The argument was available -- a reader that drops `fields` renders
    // bare text boxes, which is under-featured rather than wrong -- but it is
    // only true while both readers SUBMIT the same entries for the same user
    // action, and that is a claim about what a BROWSER does with rendered
    // markup. Two attempts to hold it failed: the first shipped a hidden
    // `value="false"` sibling that posted different bytes than the older reader,
    // and the second asserted equivalence through a regex over server HTML that
    // synthesised what it believed a browser would submit -- no successful-control
    // rules, no disabled-state behaviour, no form ownership. A control marked
    // `disabled`, which a real browser omits entirely, kept that gate green.
    //
    // A version number costs nothing and needs no instrument. The floor now says
    // what is true by construction: a reader that does not understand `fields`
    // must not serve this payload. Nothing downstream has to be trusted to
    // behave like a browser for that sentence to hold.
    requiredRuntimeCapability: {
      capabilityId: 'northstar.runtime:capability.surface-manifest',
      minimumVersion: composed ? 4 : emitsFieldKinds ? 3 : navigation ? 2 : 1,
    },
  };
}

interface SurfaceNavigationLeaf {
  readonly kind: 'navigationSurface';
  readonly surfaceId: string;
}

interface SurfaceNavigationGroup {
  readonly children: readonly (
    SurfaceNavigationGroup | SurfaceNavigationLeaf
  )[];
  readonly kind: 'navigationGroup';
  readonly label: string;
  readonly navigationId: string;
}

function surfaceNavigationTree(packageRevision: NormalizedApplicationPackage): {
  readonly entries: readonly SurfaceNavigationGroup[];
  readonly kind: 'navigationTree';
} | null {
  const navigationSurfaces = packageRevision.surfaces.filter(
    (surface) => surface.lifecycle === 'active' && isNavigationSurface(surface),
  );
  if (navigationSurfaces.length <= MAX_PRIMARY_NAVIGATION_ENTRIES) return null;

  const surfaceLeavesByModule = new Map<string, SurfaceNavigationLeaf[]>();
  for (const surface of navigationSurfaces) {
    const leaves = surfaceLeavesByModule.get(surface.module.targetId) ?? [];
    leaves.push({ kind: 'navigationSurface', surfaceId: surface.surfaceId });
    surfaceLeavesByModule.set(surface.module.targetId, leaves);
  }

  const moduleGroups = packageRevision.modules.flatMap((module) => {
    const children = surfaceLeavesByModule.get(module.moduleId);
    return children
      ? [
          {
            children,
            kind: 'navigationGroup' as const,
            label: module.label,
            navigationId: module.moduleId,
          },
        ]
      : [];
  });
  const entries =
    moduleGroups.length <= MAX_PRIMARY_NAVIGATION_ENTRIES
      ? moduleGroups
      : [
          ...moduleGroups.slice(0, MAX_PRIMARY_NAVIGATION_ENTRIES - 1),
          {
            children: moduleGroups.slice(MAX_PRIMARY_NAVIGATION_ENTRIES - 1),
            kind: 'navigationGroup' as const,
            label: 'More',
            navigationId: `${packageRevision.package.namespace}:navigation.more`,
          },
        ];
  return { entries, kind: 'navigationTree' };
}

function isNavigationSurface(
  surface: NormalizedApplicationPackage['surfaces'][number],
): boolean {
  return (
    surface.surfaceRole === 'list' ||
    (surface.surfaceRole === undefined &&
      (surface.archetype === 'list' ||
        surface.archetype === 'home' ||
        surface.archetype === 'task'))
  );
}

function reportingPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  const fieldsByEntity = new Map<string, typeof packageRevision.fields>();
  for (const field of packageRevision.fields) {
    const fields = fieldsByEntity.get(field.entity.targetId) ?? [];
    fields.push(field);
    fieldsByEntity.set(field.entity.targetId, fields);
  }
  return {
    entities: packageRevision.entities
      .filter((entity) => entity.lifecycle === 'active')
      .map((entity) => ({
        entityId: entity.entityId,
        fields: (fieldsByEntity.get(entity.entityId) ?? []).map((field) => ({
          fieldId: field.fieldId,
          lineage: {
            canonicalEntityId: entity.entityId,
            canonicalFieldId: field.fieldId,
          },
          reportable: field.reportable,
          searchable: field.searchable,
        })),
      })),
    kind: 'reportingPayload',
    schemaVersion: payloadSchemaVersions[PROJECTION_FAMILY_IDS.reporting],
  };
}

function policyReferencesPayload(
  packageRevision: NormalizedApplicationPackage,
): unknown {
  return {
    decisionDependency: 'liveCurrentDenyCapable',
    kind: 'policyReferencesPayload',
    permissions: packageRevision.permissions.map((permission) => ({
      action: permission.action,
      lifecycle: permission.lifecycle,
      permissionId: permission.permissionId,
      resourceId: permission.resource.targetId,
    })),
    policyModelVersion: POLICY_MODEL_VERSION,
    schemaVersion:
      payloadSchemaVersions[PROJECTION_FAMILY_IDS.policyReferences],
  };
}

function agentDiscoveryPayload(
  packageRevision: NormalizedApplicationPackage,
  original: VersionedNormalizedApplicationPackage,
): unknown {
  const declared = new Map(
    original.queries.map((query) => [String(query.queryId), query]),
  );
  return {
    kind: 'agentDiscoveryPayload',
    operations: packageRevision.operations.map((operation) => ({
      operationId: operation.operationId,
      readBackQueryId: operation.readBack.targetId,
    })),
    queries: packageRevision.queries.map((query) => ({
      fieldIds: [
        ...query.selections.map((selection) => selection.field.targetId),
        ...(() => {
          const source = declared.get(query.queryId);
          return source && 'readModel' in source && source.readModel
            ? Object.values(source.readModel.resultFields)
            : [];
        })(),
      ],
      queryId: query.queryId,
    })),
    schemaVersion: payloadSchemaVersions[PROJECTION_FAMILY_IDS.agentDiscovery],
    surfaces: packageRevision.surfaces.map((surface) => surface.surfaceId),
    toolIds: [...OPERATIONS_AGENT_TOOL_IDS],
  };
}

function verificationPlanPayload(
  packageRevision: VersionedNormalizedApplicationPackage,
): unknown {
  const scenarios: Array<Record<string, unknown>> = [];
  const addScenario = (scenario: Record<string, unknown>) => {
    const scenarioFingerprint = hashCanonical(
      HASH_DOMAINS.verificationScenario,
      scenario,
    ).digest;
    scenarios.push({
      ...scenario,
      scenarioFingerprint,
      scenarioId: `${packageRevision.package.namespace}:verification-scenario.${scenarioFingerprint}`,
      schemaVersion: VERIFICATION_SCENARIO_VERSION,
    });
  };
  for (const assertion of packageRevision.assertions.filter(
    (entry) => entry.lifecycle === 'active',
  )) {
    const entityId = verificationAssertionEntityId(packageRevision, assertion);
    if (!entityId) {
      throw new TypeError(
        `verification assertion invocation was not resolved before lowering: ${assertion.assertionId}`,
      );
    }
    for (const evidenceKind of assertion.evidenceKinds) {
      addScenario({
        assertionId: assertion.assertionId,
        entityId,
        evidenceKind,
        expectedDiagnosticCode: assertion.expectedDiagnosticCode,
        expectedOutcome: assertion.expectedOutcome,
        invocation: assertion.invocation,
        kind: 'declaredEvidence',
        probePolarity: 'declaredOutcome',
        provider: 'realPostgresql',
        subjectId: entityId,
      });
    }
  }
  const searchableEntityIds = new Set(
    packageRevision.queries
      .filter(
        (query) =>
          query.lifecycle === 'active' &&
          query.tier === 'q0' &&
          query.queryType === 'search',
      )
      .map((query) => query.sourceEntity.targetId),
  );
  // A materialized state field is not a caller input: the compiled contract
  // excludes it from create and update, it is seeded from `initialState`, and
  // only a transition moves it. Both scenarios below probe a field THROUGH the
  // create operation, so minting them here asks the provider to populate a
  // field it is structurally forbidden to populate -- which is how this
  // surfaced, as `VERIFICATION_EXCLUDED_FIELD_VALUE_MISSING`.
  //
  // This is the `legal_entity_id` shape from `5g3-mount`: compiler-derived
  // storage that no generic press can arrange. That column stays outside
  // `fields` and never reaches this loop; a materialized state field is
  // deliberately inside `fields` -- that is the whole point of the ruling, and
  // what makes it selectable and addressable -- so the exclusion is stated
  // here instead of being had for free.
  //
  // Not emitting differs from skipping, and ADR-0020:156 cares about the
  // difference: nothing is admitted unexecuted. The scenario is never planned,
  // because the contract it would probe does not exist.
  const materializedStateFieldIds = new Set(
    packageRevision.stateMachines.map((machine) => machine.stateField.fieldId),
  );
  for (const field of packageRevision.fields.filter(
    (entry) =>
      entry.lifecycle === 'active' &&
      !materializedStateFieldIds.has(entry.fieldId),
  )) {
    if (field.fieldType.kind === 'enumFieldType') {
      addScenario({
        entityId: field.entity.targetId,
        kind: 'enumReject',
        probePolarity: 'positiveAndNegative',
        provider: 'realPostgresql',
        subjectId: field.fieldId,
      });
    }
    if (!field.searchable && searchableEntityIds.has(field.entity.targetId)) {
      addScenario({
        entityId: field.entity.targetId,
        kind: 'searchableExclusion',
        probePolarity: 'positiveAndNegative',
        provider: 'realPostgresql',
        subjectId: field.fieldId,
      });
    }
    if (field.businessKey === 'tenantEnvironmentCaseInsensitiveUnique') {
      addScenario({
        entityId: field.entity.targetId,
        kind: 'uniquenessFold',
        nfkcPolicy: 'preserveCompatibilityDistinctions',
        probePolarity: 'positiveAndNegative',
        provider: 'realPostgresql',
        subjectId: field.fieldId,
      });
    }
  }
  for (const relation of packageRevision.relations.filter(
    (entry) =>
      entry.lifecycle === 'active' && entry.archiveBehavior === 'restrict',
  )) {
    addScenario({
      entityId: relation.sourceEntity.targetId,
      kind: 'archiveRestrict',
      probePolarity: 'positiveAndNegative',
      provider: 'realPostgresql',
      subjectId: relation.relationId,
      targetEntityId: relation.targetEntity.targetId,
    });
  }
  for (const query of packageRevision.queries.filter(
    (entry) => entry.lifecycle === 'active' && entry.queryType === 'resolve',
  )) {
    addScenario({
      entityId: query.sourceEntity.targetId,
      kind: 'resolverAuthority',
      probePolarity: 'positiveAndNegative',
      provider: 'realPostgresql',
      subjectId: query.queryId,
    });
  }
  for (const entity of packageRevision.entities.filter(
    (entry) => entry.lifecycle === 'active',
  )) {
    addScenario({
      entityId: entity.entityId,
      kind: 'typedErrorSurface',
      probePolarity: 'positiveAndNegative',
      provider: 'realPostgresql',
      subjectId: entity.entityId,
    });
  }
  scenarios.sort((left, right) =>
    compare(String(left.scenarioId), String(right.scenarioId)),
  );
  return {
    kind: 'verificationPlanPayload',
    scenarios,
    schemaVersion:
      payloadSchemaVersions[PROJECTION_FAMILY_IDS.verificationPlan],
  };
}

function operationInputContract(
  operation: NormalizedApplicationPackage['operations'][number],
  fields: NormalizedApplicationPackage['fields'],
  relations: NormalizedApplicationPackage['relations'],
  storageEntity: StorageTargetPayloadV1['entities'][number] | undefined,
  compilerSemanticProfileVersion: CompilerSemanticProfileVersion,
): unknown {
  const effectKind = operation.effect.kind;
  const capabilityRecordScope = effectKind === 'registeredCapabilityEffect';
  const writesFields =
    effectKind === 'createRecordEffect' || effectKind === 'updateRecordEffect';
  const systemInput =
    effectKind === 'createRecordEffect' && storageEntity?.legalEntity
      ? {
          argumentKey: 'legalEntityId' as const,
          classification: 'INTERNAL' as const,
          immutableAfterCreate: storageEntity.legalEntity.immutableAfterCreate,
          physicalColumn: storageEntity.legalEntity.column,
          required: !storageEntity.legalEntity.nullable,
          valueKind: storageEntity.legalEntity.postgresqlType,
        }
      : null;
  // Gated on the UNADOPTED v2, so this is readable and unemitted: no recorded
  // lineage entry compiles under v2, and every release root holds. ADR-0047 s1
  // makes the profile the projection evolution axis precisely so a shape change
  // like this one need not rewrite history. NOTE the key rides this gate, not
  // just the version -- gating the version alone still moves every root.
  const relationTargets =
    effectKind === 'createRecordEffect' &&
    relations.length > 0 &&
    compilerSemanticProfileVersion === COMPILER_SEMANTIC_PROFILE_V2_VERSION;
  const closedArgumentKeys =
    effectKind === 'createRecordEffect'
      ? [
          ...(systemInput ? [systemInput.argumentKey] : []),
          'recordId',
          'relations',
          'values',
        ]
      : effectKind === 'updateRecordEffect'
        ? ['expectedRevision', 'patch', 'recordId']
        : capabilityRecordScope
          ? // ADR-0038's O1 command carries only its record/revision pin;
            // business content is hydrated from the staged draft.
            ['expectedRevision', 'recordId']
          : ['expectedRevision', 'recordId'];
  return {
    closedArgumentKeys,
    fields: writesFields
      ? fields.map((field) => ({
          bounds: {
            maximumLength:
              field.fieldType.kind === 'textFieldType'
                ? field.fieldType.maximumLength
                : null,
            precision:
              'precision' in field.fieldType &&
              typeof field.fieldType.precision === 'number'
                ? field.fieldType.precision
                : null,
            scale: 'scale' in field.fieldType ? field.fieldType.scale : null,
          },
          classification:
            field.classification === 'public' ? 'PUBLIC' : 'INTERNAL',
          enumOptionIds:
            field.fieldType.kind === 'enumFieldType'
              ? field.fieldType.options.map((option) => option.optionId)
              : [],
          fieldId: field.fieldId,
          fieldKind: field.fieldType.kind,
          normalization:
            field.businessKey === 'tenantEnvironmentCaseInsensitiveUnique'
              ? 'unicodeCaseFoldNoCompatibilityNormalization'
              : 'none',
          required: field.presence === 'required',
          temporal:
            field.fieldType.kind === 'dateFieldType'
              ? {
                  precision: null,
                  timezoneSemantics: 'calendarDate',
                }
              : field.fieldType.kind === 'timeFieldType'
                ? {
                    precision: field.fieldType.precision,
                    timezoneSemantics: 'localWallTime',
                  }
                : field.fieldType.kind === 'dateTimeFieldType'
                  ? {
                      precision: field.fieldType.precision,
                      timezoneSemantics: field.fieldType.timezoneSemantics,
                    }
                  : { precision: null, timezoneSemantics: null },
          writable: true,
        }))
      : [],
    relationInputs:
      effectKind === 'createRecordEffect'
        ? relations.map((relation) => ({
            archiveBehavior: relation.archiveBehavior,
            relationId: relation.relationId,
            required: relation.required,
            ...(relationTargets
              ? { targetEntityId: relation.targetEntity.targetId }
              : {}),
          }))
        : [],
    // Two independent optional shapes, so the version is a 2x2 rather than a
    // generation counter: it names exactly what the artifact carries, and an
    // operation with no relations stays byte-identical to what it emitted
    // before this key existed.
    schemaVersion: relationTargets
      ? systemInput
        ? MODULE_INPUT_CONTRACT_V4_VERSION
        : MODULE_INPUT_CONTRACT_V3_VERSION
      : systemInput
        ? MODULE_INPUT_CONTRACT_V2_VERSION
        : MODULE_INPUT_CONTRACT_VERSION,
    ...(systemInput ? { systemInput } : {}),
    writableFieldIds: writesFields
      ? fields.map((field) => field.fieldId).sort(compare)
      : [],
  };
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const identity = key(value);
    const entries = grouped.get(identity) ?? [];
    entries.push(value);
    grouped.set(identity, entries);
  }
  return grouped;
}

function addFamily<T extends Record<string, unknown>>(
  constructs: Array<{
    constructKind: string;
    semanticFingerprint: string;
    subjectId: string;
  }>,
  values: T[],
  idKey: keyof T,
): void {
  for (const value of values) {
    const subjectId = value[idKey];
    const constructKind = value.kind;
    if (typeof subjectId !== 'string' || typeof constructKind !== 'string') {
      continue;
    }
    constructs.push({
      constructKind,
      semanticFingerprint: hashCanonical(HASH_DOMAINS.semanticConstruct, value)
        .digest,
      subjectId,
    });
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
