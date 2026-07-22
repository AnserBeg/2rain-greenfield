import { ZodError } from 'zod';

import { canonicalize } from './canonicalize.js';
import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  IMMUTABLE_DEFAULTS_V0,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  STRUCTURAL_LIMITS_V0,
  SURFACE_SLOTS,
} from './constants.js';
import {
  CanonicalModelError,
  compareCodeUnits,
  diagnostic,
  type CanonicalDiagnostic,
} from './diagnostics.js';
import {
  AuthoredApplicationPackageSchema,
  NormalizedApplicationPackageSchema,
  type AuthoredApplicationPackage,
  type NormalizedApplicationPackage,
  type PredicateExpression,
} from './schemas.js';
import { parseStrictJson } from './strict-json.js';

type CanonicalReference = {
  kind: string;
  schemaVersion: typeof LANGUAGE_VERSION;
  targetId: string;
};

export function parseAuthoredApplicationPackageJson(
  input: string | Uint8Array,
): AuthoredApplicationPackage {
  const parsed = parseStrictJson(input);
  if (parsed.byteLength > STRUCTURAL_LIMITS_V0.maximumAuthoredBytes) {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_LIMIT_PACKAGE_BYTES',
        '$',
        `authored package bytes must not exceed ${STRUCTURAL_LIMITS_V0.maximumAuthoredBytes}`,
        'split non-language evidence from the package or reduce authored content',
      ),
    ]);
  }
  return parseAuthoredValue(parsed.value);
}

export function normalizeApplicationPackage(
  input: unknown,
): NormalizedApplicationPackage {
  const authored = parseAuthoredValue(input);
  const authoredBytes = new TextEncoder().encode(canonicalize(authored));
  if (authoredBytes.byteLength > STRUCTURAL_LIMITS_V0.maximumAuthoredBytes) {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_LIMIT_PACKAGE_BYTES',
        '$',
        `authored package bytes must not exceed ${STRUCTURAL_LIMITS_V0.maximumAuthoredBytes}`,
        'split non-language evidence from the package or reduce authored content',
        authored.package.packageId,
      ),
    ]);
  }
  enforceFamilyBounds(authored);

  const normalizedCandidate = {
    assertions: authored.assertions.map((entry) => ({
      ...entry,
      evidenceKinds: sortedStrings(entry.evidenceKinds),
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
    })),
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    capabilityRequirements: authored.capabilityRequirements.map((entry) => ({
      ...entry,
      declaredEffects: sortedStrings(entry.declaredEffects),
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
      requiredProjections: sortedStrings(entry.requiredProjections),
    })),
    entities: authored.entities.map((entry) => ({
      ...entry,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
    })),
    fields: authored.fields.map((entry) => ({
      ...entry,
      fieldType:
        entry.fieldType.kind === 'enumFieldType'
          ? {
              ...entry.fieldType,
              options: sortByOrderAndId(entry.fieldType.options, 'optionId'),
            }
          : entry.fieldType,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
      presence: entry.presence ?? IMMUTABLE_DEFAULTS_V0.presence,
      reportable: entry.reportable ?? IMMUTABLE_DEFAULTS_V0.reportable,
      searchable: entry.searchable ?? IMMUTABLE_DEFAULTS_V0.searchable,
    })),
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    kind: authored.kind,
    languageVersion: authored.languageVersion,
    modules: authored.modules.map((entry) => ({
      ...entry,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
    })),
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
    operations: authored.operations.map((entry) => ({
      ...entry,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
      precondition: normalizePredicate(
        entry.precondition ?? defaultPredicate(),
        1,
      ),
    })),
    package: {
      ...authored.package,
      lifecycle: authored.package.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
    },
    permissions: authored.permissions.map((entry) => ({
      ...entry,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
    })),
    queries: authored.queries.map((entry) => ({
      ...entry,
      filter: normalizePredicate(entry.filter ?? defaultPredicate(), 1),
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
      selections: sortByOrderAndId(entry.selections, 'selectionId'),
    })),
    relations: authored.relations.map((entry) => ({
      ...entry,
      joinEligibility:
        entry.joinEligibility ?? IMMUTABLE_DEFAULTS_V0.relationJoinEligibility,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
      required: entry.required ?? IMMUTABLE_DEFAULTS_V0.relationRequired,
    })),
    schemaVersion: authored.schemaVersion,
    stateMachines: authored.stateMachines.map((entry) => ({
      ...entry,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
      states: sortByOrderAndId(
        entry.states.map((state) => ({
          ...state,
          terminal: state.terminal ?? IMMUTABLE_DEFAULTS_V0.terminal,
        })),
        'stateId',
      ),
      transitions: sortByOrderAndId(entry.transitions, 'transitionId'),
    })),
    storageMappings: authored.storageMappings.map((entry) => ({
      ...entry,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
    })),
    surfaces: authored.surfaces.map((entry) => ({
      ...entry,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
      slots: sortByOrderAndId(entry.slots, 'slotId'),
      statusRoles: sortedStrings(entry.statusRoles),
    })),
  };

  const sortedCandidate = {
    ...normalizedCandidate,
    assertions: sortById(normalizedCandidate.assertions, 'assertionId'),
    capabilityRequirements: sortById(
      normalizedCandidate.capabilityRequirements,
      'capabilityId',
    ),
    entities: sortById(normalizedCandidate.entities, 'entityId'),
    fields: sortByOrderAndId(normalizedCandidate.fields, 'fieldId'),
    modules: sortByOrderAndId(normalizedCandidate.modules, 'moduleId'),
    operations: sortById(normalizedCandidate.operations, 'operationId'),
    permissions: sortById(normalizedCandidate.permissions, 'permissionId'),
    queries: sortById(normalizedCandidate.queries, 'queryId'),
    relations: sortByOrderAndId(normalizedCandidate.relations, 'relationId'),
    stateMachines: sortById(normalizedCandidate.stateMachines, 'machineId'),
    storageMappings: sortById(
      normalizedCandidate.storageMappings,
      'storageMappingId',
    ),
    surfaces: sortById(normalizedCandidate.surfaces, 'surfaceId'),
  };

  let normalized: NormalizedApplicationPackage;
  try {
    normalized = NormalizedApplicationPackageSchema.parse(sortedCandidate);
  } catch (error) {
    if (error instanceof ZodError) throw schemaError(error, sortedCandidate);
    throw error;
  }
  validateSemantics(normalized);
  enforceValueBounds(normalized);
  const normalizedBytes = new TextEncoder().encode(canonicalize(normalized));
  if (
    normalizedBytes.byteLength > STRUCTURAL_LIMITS_V0.maximumNormalizedBytes
  ) {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_LIMIT_NORMALIZED_BYTES',
        '$',
        `normalized package bytes must not exceed ${STRUCTURAL_LIMITS_V0.maximumNormalizedBytes}`,
        'split the package or reduce canonical definitions',
        normalized.package.packageId,
      ),
    ]);
  }
  return deepFreeze(normalized);
}

export function canonicalAuthoredProjection(
  normalized: NormalizedApplicationPackage,
): AuthoredApplicationPackage {
  NormalizedApplicationPackageSchema.parse(normalized);
  const projected = structuredClone(normalized) as unknown as Record<
    string,
    unknown
  >;
  delete projected.canonicalizationProfileVersion;
  delete projected.hashAlgorithm;
  delete projected.normalizationProfileVersion;
  visitObjects(projected, (object) => {
    if (object.lifecycle === IMMUTABLE_DEFAULTS_V0.lifecycle) {
      delete object.lifecycle;
    }
    if (object.kind === 'fieldDefinition') {
      if (object.presence === IMMUTABLE_DEFAULTS_V0.presence)
        delete object.presence;
      if (object.reportable === false) delete object.reportable;
      if (object.searchable === false) delete object.searchable;
    }
    if (object.kind === 'relationDefinition') {
      if (object.joinEligibility === 'none') delete object.joinEligibility;
      if (object.required === false) delete object.required;
    }
    if (object.kind === 'stateDefinition' && object.terminal === false) {
      delete object.terminal;
    }
    if (
      object.kind === 'queryDefinition' &&
      isDefaultPredicate(object.filter)
    ) {
      delete object.filter;
    }
    if (
      object.kind === 'operationDefinition' &&
      isDefaultPredicate(object.precondition)
    ) {
      delete object.precondition;
    }
  });
  return parseAuthoredValue(projected);
}

function parseAuthoredValue(input: unknown): AuthoredApplicationPackage {
  try {
    return AuthoredApplicationPackageSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) throw schemaError(error, input);
    throw error;
  }
}

function schemaError(error: ZodError, input: unknown): CanonicalModelError {
  const diagnostics = error.issues.map((issue) => {
    const path = `$${issue.path
      .map((part) =>
        typeof part === 'number' ? `[${part}]` : `.${String(part)}`,
      )
      .join('')}`;
    const pathParts = issue.path.map(String);
    const finalPart = pathParts.at(-1) ?? '';
    const code =
      finalPart === 'kind'
        ? 'CANON_KIND_UNSUPPORTED'
        : finalPart === 'schemaVersion' || finalPart.endsWith('Version')
          ? 'CANON_VERSION_UNSUPPORTED'
          : finalPart === 'archetype'
            ? 'CANON_SURFACE_ARCHETYPE_UNSUPPORTED'
            : finalPart === 'slot'
              ? 'CANON_SURFACE_SLOT_UNSUPPORTED'
              : pathParts.includes('statusRoles')
                ? 'CANON_SURFACE_STATUS_ROLE_UNSUPPORTED'
                : 'CANON_SCHEMA_INVALID';
    return diagnostic(
      code,
      path,
      `value must satisfy the closed ${LANGUAGE_VERSION} schema`,
      acceptedAlternativeFor(code),
      findObjectId(input, issue.path),
    );
  });
  return new CanonicalModelError(diagnostics);
}

function validateSemantics(
  packageRevision: NormalizedApplicationPackage,
): void {
  const diagnostics: CanonicalDiagnostic[] = [];
  const namespace = packageRevision.package.namespace;
  const allIds = collectIds(packageRevision);
  const idOwners = new Map<string, string>();
  for (const [family, ids] of Object.entries(allIds)) {
    for (const id of ids) {
      const prior = idOwners.get(id);
      if (prior) {
        diagnostics.push(
          diagnostic(
            'CANON_ID_DUPLICATE',
            '$',
            `canonical identity is unique across the package; already used by ${prior}`,
            'mint a new namespaced canonical ID',
            id,
          ),
        );
      } else {
        idOwners.set(id, family);
      }
      if (namespaceOf(id) !== namespace) {
        diagnostics.push(
          diagnostic(
            'CANON_ID_NAMESPACE_MISMATCH',
            '$',
            `owned IDs must be born in package namespace ${namespace}`,
            `use an ID beginning with ${namespace}:`,
            id,
          ),
        );
      }
    }
  }
  if (namespaceOf(packageRevision.package.packageId) !== namespace) {
    diagnostics.push(
      diagnostic(
        'CANON_ID_NAMESPACE_MISMATCH',
        '$.package.packageId',
        'package identity and namespace must agree',
        `use an ID beginning with ${namespace}:`,
        packageRevision.package.packageId,
      ),
    );
  }

  const index = referenceIndex(packageRevision);
  validateOwnedReferences(packageRevision, index, namespace, diagnostics);
  validateReferenceLocality(packageRevision, diagnostics);
  validateSurfaceVocabulary(packageRevision, diagnostics);
  validateSetCollections(packageRevision, diagnostics);
  validateOrderKeys(packageRevision, diagnostics);
  if (diagnostics.length > 0) throw new CanonicalModelError(diagnostics);
}

function validateOwnedReferences(
  packageRevision: NormalizedApplicationPackage,
  index: Map<string, Set<string>>,
  namespace: string,
  diagnostics: CanonicalDiagnostic[],
): void {
  const check = (
    reference: CanonicalReference,
    expectedKind: string,
    path: string,
    objectId: string,
  ): void => {
    if (reference.kind !== expectedKind) {
      diagnostics.push(
        diagnostic(
          'CANON_REFERENCE_KIND_MISMATCH',
          path,
          `reference kind must be ${expectedKind}`,
          `use {kind:"${expectedKind}",schemaVersion:"${LANGUAGE_VERSION}",targetId:"..."}`,
          objectId,
        ),
      );
      return;
    }
    if (namespaceOf(reference.targetId) !== namespace) {
      diagnostics.push(
        diagnostic(
          'CANON_REFERENCE_CROSS_PACKAGE_UNSUPPORTED',
          path,
          'v0-experimental parses namespaced cross-package references but composition is unsupported',
          'reference an object in this package or wait for the tracked composition packet',
          objectId,
        ),
      );
      return;
    }
    if (!index.get(expectedKind)?.has(reference.targetId)) {
      diagnostics.push(
        diagnostic(
          'CANON_REFERENCE_UNRESOLVED',
          path,
          'every reference must resolve inside the complete desired-state snapshot',
          'add the referenced definition or use an existing canonical ID',
          objectId,
        ),
      );
    }
  };

  for (const module of packageRevision.modules) {
    if (module.ownerPackageId !== packageRevision.package.packageId) {
      diagnostics.push(
        diagnostic(
          'CANON_OWNERSHIP_MISMATCH',
          '$.modules.ownerPackageId',
          'modules are owned by the package envelope',
          `use ${packageRevision.package.packageId}`,
          module.moduleId,
        ),
      );
    }
  }
  for (const entity of packageRevision.entities) {
    check(
      entity.module,
      'moduleReference',
      '$.entities.module',
      entity.entityId,
    );
    check(
      entity.storage,
      'storageMappingReference',
      '$.entities.storage',
      entity.entityId,
    );
  }
  for (const field of packageRevision.fields) {
    check(field.entity, 'entityReference', '$.fields.entity', field.fieldId);
    if (field.fieldType.kind === 'quantityFieldType') {
      check(
        field.fieldType.baseUnit,
        'unitReference',
        '$.fields.fieldType.baseUnit',
        field.fieldId,
      );
    }
  }
  for (const relation of packageRevision.relations) {
    check(
      relation.sourceEntity,
      'entityReference',
      '$.relations.sourceEntity',
      relation.relationId,
    );
    check(
      relation.targetEntity,
      'entityReference',
      '$.relations.targetEntity',
      relation.relationId,
    );
  }
  for (const machine of packageRevision.stateMachines) {
    check(
      machine.entity,
      'entityReference',
      '$.stateMachines.entity',
      machine.machineId,
    );
    check(
      machine.stateField,
      'fieldReference',
      '$.stateMachines.stateField',
      machine.machineId,
    );
    check(
      machine.initialState,
      'stateReference',
      '$.stateMachines.initialState',
      machine.machineId,
    );
    for (const transition of machine.transitions) {
      check(
        transition.fromState,
        'stateReference',
        '$.stateMachines.transitions.fromState',
        transition.transitionId,
      );
      check(
        transition.toState,
        'stateReference',
        '$.stateMachines.transitions.toState',
        transition.transitionId,
      );
      check(
        transition.permission,
        'permissionReference',
        '$.stateMachines.transitions.permission',
        transition.transitionId,
      );
    }
  }
  for (const surface of packageRevision.surfaces) {
    check(
      surface.module,
      'moduleReference',
      '$.surfaces.module',
      surface.surfaceId,
    );
    check(
      surface.dataSource,
      'queryReference',
      '$.surfaces.dataSource',
      surface.surfaceId,
    );
    for (const slot of surface.slots) {
      check(
        slot.content,
        'opaqueSurfaceContentReference',
        '$.surfaces.slots.content',
        surface.surfaceId,
      );
    }
  }
  for (const query of packageRevision.queries) {
    check(query.module, 'moduleReference', '$.queries.module', query.queryId);
    check(
      query.permission,
      'permissionReference',
      '$.queries.permission',
      query.queryId,
    );
    check(
      query.sourceEntity,
      'entityReference',
      '$.queries.sourceEntity',
      query.queryId,
    );
    for (const selection of query.selections) {
      check(
        selection.field,
        'fieldReference',
        '$.queries.selections.field',
        query.queryId,
      );
    }
    visitPredicate(query.filter, (reference, path) =>
      check(
        reference,
        'fieldReference',
        `$.queries.filter${path}`,
        query.queryId,
      ),
    );
  }
  for (const operation of packageRevision.operations) {
    check(
      operation.module,
      'moduleReference',
      '$.operations.module',
      operation.operationId,
    );
    check(
      operation.permission,
      'permissionReference',
      '$.operations.permission',
      operation.operationId,
    );
    check(
      operation.readBack,
      'queryReference',
      '$.operations.readBack',
      operation.operationId,
    );
    visitPredicate(operation.precondition, (reference, path) =>
      check(
        reference,
        'fieldReference',
        `$.operations.precondition${path}`,
        operation.operationId,
      ),
    );
    if ('entity' in operation.effect) {
      check(
        operation.effect.entity,
        'entityReference',
        '$.operations.effect.entity',
        operation.operationId,
      );
    } else if ('transition' in operation.effect) {
      check(
        operation.effect.transition,
        'transitionReference',
        '$.operations.effect.transition',
        operation.operationId,
      );
    } else {
      check(
        operation.effect.capability,
        'capabilityReference',
        '$.operations.effect.capability',
        operation.operationId,
      );
    }
  }
  for (const permission of packageRevision.permissions) {
    check(
      permission.resource,
      'entityReference',
      '$.permissions.resource',
      permission.permissionId,
    );
  }
  for (const assertion of packageRevision.assertions) {
    if (assertion.invocation.kind === 'queryInvocation') {
      check(
        assertion.invocation.query,
        'queryReference',
        '$.assertions.invocation.query',
        assertion.assertionId,
      );
    } else {
      check(
        assertion.invocation.operation,
        'operationReference',
        '$.assertions.invocation.operation',
        assertion.assertionId,
      );
    }
  }
  for (const storage of packageRevision.storageMappings) {
    check(
      storage.entity,
      'entityReference',
      '$.storageMappings.entity',
      storage.storageMappingId,
    );
  }
}

function validateSurfaceVocabulary(
  packageRevision: NormalizedApplicationPackage,
  diagnostics: CanonicalDiagnostic[],
): void {
  for (const surface of packageRevision.surfaces) {
    const allowed = new Set<string>(SURFACE_SLOTS[surface.archetype]);
    const seen = new Set<string>();
    for (const slot of surface.slots) {
      if (!allowed.has(slot.slot)) {
        diagnostics.push(
          diagnostic(
            'CANON_SURFACE_SLOT_UNSUPPORTED',
            '$.surfaces.slots.slot',
            `slot ${slot.slot} is not declared by ${surface.archetype}`,
            `use one of: ${[...allowed].join(', ')}`,
            surface.surfaceId,
          ),
        );
      }
      if (seen.has(slot.slot)) {
        diagnostics.push(
          diagnostic(
            'CANON_SURFACE_SLOT_DUPLICATE',
            '$.surfaces.slots.slot',
            'each named archetype slot has one content authority',
            'keep one surfaceSlot for the named slot',
            surface.surfaceId,
          ),
        );
      }
      seen.add(slot.slot);
    }
  }
}

function validateReferenceLocality(
  packageRevision: NormalizedApplicationPackage,
  diagnostics: CanonicalDiagnostic[],
): void {
  const entityModule = new Map(
    packageRevision.entities.map((entry) => [
      entry.entityId,
      entry.module.targetId,
    ]),
  );
  const fieldEntity = new Map(
    packageRevision.fields.map((entry) => [
      entry.fieldId,
      entry.entity.targetId,
    ]),
  );
  const queryModule = new Map(
    packageRevision.queries.map((entry) => [
      entry.queryId,
      entry.module.targetId,
    ]),
  );
  const stateOwner = new Map(
    packageRevision.stateMachines.flatMap((machine) =>
      machine.states.map(
        (state) => [state.stateId, machine.machineId] as const,
      ),
    ),
  );
  const storageEntity = new Map(
    packageRevision.storageMappings.map((entry) => [
      entry.storageMappingId,
      entry.entity.targetId,
    ]),
  );

  for (const entity of packageRevision.entities) {
    if (storageEntity.get(entity.storage.targetId) !== entity.entityId) {
      diagnostics.push(
        diagnostic(
          'CANON_STORAGE_ENTITY_MISMATCH',
          '$.entities.storage',
          'an entity and its storage mapping must reference each other',
          'use the storage mapping whose entity target is this entity ID',
          entity.entityId,
        ),
      );
    }
  }
  for (const relation of packageRevision.relations) {
    if (
      relation.ownership === 'parentScopedChild' &&
      (relation.cardinality !== 'manyToOne' ||
        !relation.required ||
        relation.archiveBehavior !== 'restrict')
    ) {
      diagnostics.push(
        diagnostic(
          'CANON_RELATION_PARENT_SCOPE_INVALID',
          '$.relations',
          'a parent-scoped child owns one required many-to-one parent link whose archive behavior is restrict',
          'use cardinality manyToOne, required true, and archiveBehavior restrict',
          relation.relationId,
        ),
      );
    }
  }
  for (const machine of packageRevision.stateMachines) {
    if (
      fieldEntity.get(machine.stateField.targetId) !== machine.entity.targetId
    ) {
      diagnostics.push(
        diagnostic(
          'CANON_STATE_FIELD_ENTITY_MISMATCH',
          '$.stateMachines.stateField',
          'the state field belongs to the state machine entity',
          'reference a field owned by the machine entity',
          machine.machineId,
        ),
      );
    }
    if (stateOwner.get(machine.initialState.targetId) !== machine.machineId) {
      diagnostics.push(
        diagnostic(
          'CANON_STATE_MACHINE_LOCALITY',
          '$.stateMachines.initialState',
          'initial state belongs to the same state machine',
          'reference one state declared by this machine',
          machine.machineId,
        ),
      );
    }
    for (const transition of machine.transitions) {
      if (
        stateOwner.get(transition.fromState.targetId) !== machine.machineId ||
        stateOwner.get(transition.toState.targetId) !== machine.machineId
      ) {
        diagnostics.push(
          diagnostic(
            'CANON_STATE_MACHINE_LOCALITY',
            '$.stateMachines.transitions',
            'transition endpoints belong to the same state machine',
            'reference states declared by this machine',
            transition.transitionId,
          ),
        );
      }
    }
  }
  for (const query of packageRevision.queries) {
    if (
      entityModule.get(query.sourceEntity.targetId) !== query.module.targetId
    ) {
      diagnostics.push(
        diagnostic(
          'CANON_QUERY_ENTITY_MODULE_MISMATCH',
          '$.queries.sourceEntity',
          'v0 queries source an entity owned by their module',
          'use a source entity from the query module',
          query.queryId,
        ),
      );
    }
    for (const selection of query.selections) {
      if (
        fieldEntity.get(selection.field.targetId) !==
        query.sourceEntity.targetId
      ) {
        diagnostics.push(
          diagnostic(
            'CANON_QUERY_FIELD_LOCALITY',
            '$.queries.selections.field',
            'v0 query selections belong to the source entity',
            'use a field owned by the source entity',
            query.queryId,
          ),
        );
      }
    }
  }
  for (const surface of packageRevision.surfaces) {
    if (
      queryModule.get(surface.dataSource.targetId) !== surface.module.targetId
    ) {
      diagnostics.push(
        diagnostic(
          'CANON_SURFACE_QUERY_MODULE_MISMATCH',
          '$.surfaces.dataSource',
          'a v0 surface and its data source belong to the same module',
          'use a query owned by the surface module',
          surface.surfaceId,
        ),
      );
    }
  }
  for (const assertion of packageRevision.assertions) {
    const expectsFailure = assertion.expectedOutcome === 'fails';
    if (expectsFailure !== (assertion.expectedDiagnosticCode !== null)) {
      diagnostics.push(
        diagnostic(
          'CANON_ASSERTION_DIAGNOSTIC_MISMATCH',
          '$.assertions.expectedDiagnosticCode',
          'failing assertions name one stable diagnostic code and successful assertions name none',
          expectsFailure ? 'provide the expected diagnostic code' : 'use null',
          assertion.assertionId,
        ),
      );
    }
  }
}

function validateSetCollections(
  packageRevision: NormalizedApplicationPackage,
  diagnostics: CanonicalDiagnostic[],
): void {
  for (const surface of packageRevision.surfaces) {
    rejectDuplicateStrings(
      surface.statusRoles,
      '$.surfaces.statusRoles',
      surface.surfaceId,
      diagnostics,
    );
  }
  for (const capability of packageRevision.capabilityRequirements) {
    rejectDuplicateStrings(
      capability.declaredEffects,
      '$.capabilityRequirements.declaredEffects',
      capability.capabilityId,
      diagnostics,
    );
    rejectDuplicateStrings(
      capability.requiredProjections,
      '$.capabilityRequirements.requiredProjections',
      capability.capabilityId,
      diagnostics,
    );
  }
  for (const assertion of packageRevision.assertions) {
    rejectDuplicateStrings(
      assertion.evidenceKinds,
      '$.assertions.evidenceKinds',
      assertion.assertionId,
      diagnostics,
    );
  }
}

function rejectDuplicateStrings(
  entries: readonly string[],
  path: string,
  objectId: string,
  diagnostics: CanonicalDiagnostic[],
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) {
      diagnostics.push(
        diagnostic(
          'CANON_SET_MEMBER_DUPLICATE',
          path,
          'set-like collections reject duplicate canonical members',
          'keep one occurrence of the member',
          objectId,
        ),
      );
    }
    seen.add(entry);
  }
}

function validateOrderKeys(
  packageRevision: NormalizedApplicationPackage,
  diagnostics: CanonicalDiagnostic[],
): void {
  const collections: Array<{
    entries: Array<{ orderKey: number }>;
    objectId: string;
    path: string;
  }> = [
    {
      entries: packageRevision.modules,
      objectId: packageRevision.package.packageId,
      path: '$.modules',
    },
    {
      entries: packageRevision.fields,
      objectId: packageRevision.package.packageId,
      path: '$.fields',
    },
    {
      entries: packageRevision.relations,
      objectId: packageRevision.package.packageId,
      path: '$.relations',
    },
    ...packageRevision.stateMachines.map((machine) => ({
      entries: machine.states,
      objectId: machine.machineId,
      path: '$.stateMachines.states',
    })),
    ...packageRevision.stateMachines.map((machine) => ({
      entries: machine.transitions,
      objectId: machine.machineId,
      path: '$.stateMachines.transitions',
    })),
    ...packageRevision.surfaces.map((surface) => ({
      entries: surface.slots,
      objectId: surface.surfaceId,
      path: '$.surfaces.slots',
    })),
    ...packageRevision.queries.map((query) => ({
      entries: query.selections,
      objectId: query.queryId,
      path: '$.queries.selections',
    })),
  ];
  for (const collection of collections) {
    const seen = new Set<number>();
    for (const entry of collection.entries) {
      if (seen.has(entry.orderKey)) {
        diagnostics.push(
          diagnostic(
            'CANON_ORDER_KEY_DUPLICATE',
            collection.path,
            'ordered siblings use unique explicit orderKey values',
            'assign a distinct integer orderKey; array position has no meaning',
            collection.objectId,
          ),
        );
      }
      seen.add(entry.orderKey);
    }
  }
}

function normalizePredicate(
  predicate: PredicateExpression,
  depth: number,
): PredicateExpression {
  if (depth > STRUCTURAL_LIMITS_V0.maximumExpressionDepth) {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_LIMIT_EXPRESSION_DEPTH',
        '$',
        `predicate depth must not exceed ${STRUCTURAL_LIMITS_V0.maximumExpressionDepth}`,
        'split the predicate into a registered typed capability',
      ),
    ]);
  }
  if (predicate.kind === 'notPredicate') {
    return {
      ...predicate,
      term: normalizePredicate(predicate.term, depth + 1),
    };
  }
  if (predicate.kind === 'allPredicate' || predicate.kind === 'anyPredicate') {
    const terms = predicate.terms
      .map((term) => normalizePredicate(term, depth + 1))
      .sort((left, right) =>
        compareCodeUnits(canonicalize(left), canonicalize(right)),
      );
    return { ...predicate, terms };
  }
  return predicate;
}

function defaultPredicate(): PredicateExpression {
  return {
    kind: 'booleanPredicate',
    schemaVersion: LANGUAGE_VERSION,
    value: true,
  };
}

function isDefaultPredicate(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'booleanPredicate' &&
    (value as { value?: unknown }).value === true
  );
}

function enforceFamilyBounds(authored: AuthoredApplicationPackage): void {
  const diagnostics: CanonicalDiagnostic[] = [];
  for (const [family, maximum] of Object.entries(
    STRUCTURAL_LIMITS_V0.families,
  )) {
    const count =
      authored[family as keyof typeof STRUCTURAL_LIMITS_V0.families].length;
    if (count > maximum) {
      diagnostics.push(
        diagnostic(
          'CANON_LIMIT_FAMILY_COUNT',
          `$.${family}`,
          `${family} count must not exceed ${maximum}`,
          'split the package before compilation',
          authored.package.packageId,
        ),
      );
    }
  }
  if (diagnostics.length > 0) throw new CanonicalModelError(diagnostics);
}

function enforceValueBounds(value: unknown): void {
  const diagnostics: CanonicalDiagnostic[] = [];
  const visit = (entry: unknown, path: string): void => {
    if (typeof entry === 'string') {
      if ([...entry].length > STRUCTURAL_LIMITS_V0.maximumStringScalars) {
        diagnostics.push(
          diagnostic(
            'CANON_LIMIT_STRING_SCALARS',
            path,
            `strings must not exceed ${STRUCTURAL_LIMITS_V0.maximumStringScalars} Unicode scalars`,
            'use bounded external documentation or a shorter label',
          ),
        );
      }
      return;
    }
    if (Array.isArray(entry)) {
      if (entry.length > STRUCTURAL_LIMITS_V0.maximumCollectionCount) {
        diagnostics.push(
          diagnostic(
            'CANON_LIMIT_COLLECTION_COUNT',
            path,
            `collections must not exceed ${STRUCTURAL_LIMITS_V0.maximumCollectionCount} members`,
            'split the package or collection',
          ),
        );
      }
      entry.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    if (typeof entry === 'object' && entry !== null) {
      for (const [key, child] of Object.entries(entry))
        visit(child, `${path}.${key}`);
    }
  };
  visit(value, '$');
  if (diagnostics.length > 0) throw new CanonicalModelError(diagnostics);
}

function referenceIndex(
  packageRevision: NormalizedApplicationPackage,
): Map<string, Set<string>> {
  const capabilities = new Set(
    packageRevision.capabilityRequirements.map((entry) => entry.capabilityId),
  );
  return new Map<string, Set<string>>([
    [
      'moduleReference',
      new Set(packageRevision.modules.map((entry) => entry.moduleId)),
    ],
    [
      'entityReference',
      new Set(packageRevision.entities.map((entry) => entry.entityId)),
    ],
    [
      'fieldReference',
      new Set(packageRevision.fields.map((entry) => entry.fieldId)),
    ],
    [
      'stateMachineReference',
      new Set(packageRevision.stateMachines.map((entry) => entry.machineId)),
    ],
    [
      'stateReference',
      new Set(
        packageRevision.stateMachines.flatMap((entry) =>
          entry.states.map((state) => state.stateId),
        ),
      ),
    ],
    [
      'transitionReference',
      new Set(
        packageRevision.stateMachines.flatMap((entry) =>
          entry.transitions.map((transition) => transition.transitionId),
        ),
      ),
    ],
    [
      'surfaceReference',
      new Set(packageRevision.surfaces.map((entry) => entry.surfaceId)),
    ],
    [
      'queryReference',
      new Set(packageRevision.queries.map((entry) => entry.queryId)),
    ],
    [
      'operationReference',
      new Set(packageRevision.operations.map((entry) => entry.operationId)),
    ],
    [
      'permissionReference',
      new Set(packageRevision.permissions.map((entry) => entry.permissionId)),
    ],
    [
      'storageMappingReference',
      new Set(
        packageRevision.storageMappings.map((entry) => entry.storageMappingId),
      ),
    ],
    ['capabilityReference', capabilities],
    ['opaqueSurfaceContentReference', capabilities],
    ['unitReference', capabilities],
  ]);
}

function collectIds(
  packageRevision: NormalizedApplicationPackage,
): Record<string, string[]> {
  return {
    package: [packageRevision.package.packageId],
    modules: packageRevision.modules.map((entry) => entry.moduleId),
    entities: packageRevision.entities.map((entry) => entry.entityId),
    fields: packageRevision.fields.flatMap((entry) => [
      entry.fieldId,
      ...(entry.fieldType.kind === 'enumFieldType'
        ? entry.fieldType.options.map((option) => option.optionId)
        : []),
    ]),
    relations: packageRevision.relations.map((entry) => entry.relationId),
    stateMachines: packageRevision.stateMachines.flatMap((entry) => [
      entry.machineId,
      ...entry.states.map((state) => state.stateId),
      ...entry.transitions.map((transition) => transition.transitionId),
    ]),
    surfaces: packageRevision.surfaces.flatMap((entry) => [
      entry.surfaceId,
      ...entry.slots.map((slot) => slot.slotId),
    ]),
    queries: packageRevision.queries.flatMap((entry) => [
      entry.queryId,
      ...entry.selections.map((selection) => selection.selectionId),
    ]),
    operations: packageRevision.operations.map((entry) => entry.operationId),
    permissions: packageRevision.permissions.map((entry) => entry.permissionId),
    assertions: packageRevision.assertions.map((entry) => entry.assertionId),
    storageMappings: packageRevision.storageMappings.map(
      (entry) => entry.storageMappingId,
    ),
    capabilityRequirements: packageRevision.capabilityRequirements.map(
      (entry) => entry.capabilityId,
    ),
  };
}

function sortById<T extends Record<K, string>, K extends keyof T>(
  entries: readonly T[],
  idKey: K,
): T[] {
  return [...entries].sort((left, right) =>
    compareCodeUnits(left[idKey], right[idKey]),
  );
}

function sortByOrderAndId<
  T extends { orderKey: number } & Record<K, string>,
  K extends keyof T,
>(entries: readonly T[], idKey: K): T[] {
  return [...entries].sort(
    (left, right) =>
      left.orderKey - right.orderKey ||
      compareCodeUnits(left[idKey], right[idKey]),
  );
}

function sortedStrings<T extends string>(entries: readonly T[]): T[] {
  return [...entries].sort(compareCodeUnits);
}

function namespaceOf(id: string): string {
  return id.slice(0, id.indexOf(':'));
}

function acceptedAlternativeFor(code: string): string {
  const alternatives: Record<string, string> = {
    CANON_KIND_UNSUPPORTED: 'use a documented kind discriminator',
    CANON_SCHEMA_INVALID:
      'use the exported authored schema and canonical example',
    CANON_SURFACE_ARCHETYPE_UNSUPPORTED:
      'use home, list, record, task, or builder',
    CANON_SURFACE_SLOT_UNSUPPORTED:
      'use a named slot declared by the selected archetype',
    CANON_SURFACE_STATUS_ROLE_UNSUPPORTED:
      'use success, attention, blocked, or inProgress',
    CANON_VERSION_UNSUPPORTED: `use ${LANGUAGE_VERSION}`,
  };
  return alternatives[code] ?? alternatives.CANON_SCHEMA_INVALID!;
}

function findObjectId(input: unknown, path: PropertyKey[]): string | null {
  let current = input;
  const candidates: unknown[] = [];
  for (const part of path) {
    if (typeof current !== 'object' || current === null) break;
    candidates.push(current);
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  candidates.push(current);
  for (const candidate of candidates.reverse()) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    for (const [key, value] of Object.entries(candidate)) {
      if (key.endsWith('Id') && typeof value === 'string') return value;
    }
  }
  return null;
}

function visitPredicate(
  predicate: PredicateExpression,
  visit: (reference: CanonicalReference, path: string) => void,
  path = '',
): void {
  if (predicate.kind === 'fieldComparisonPredicate') {
    visit(predicate.field, `${path}.field`);
    if (predicate.value.kind === 'quantityValue') {
      visit(predicate.value.baseUnit, `${path}.value.baseUnit`);
    }
  } else if (predicate.kind === 'notPredicate') {
    visitPredicate(predicate.term, visit, `${path}.term`);
  } else if (
    predicate.kind === 'allPredicate' ||
    predicate.kind === 'anyPredicate'
  ) {
    predicate.terms.forEach((term, index) =>
      visitPredicate(term, visit, `${path}.terms[${index}]`),
    );
  }
}

function visitObjects(
  value: unknown,
  visit: (object: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => visitObjects(entry, visit));
  } else if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    visit(object);
    Object.values(object).forEach((entry) => visitObjects(entry, visit));
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((entry) => deepFreeze(entry));
  }
  return value;
}
