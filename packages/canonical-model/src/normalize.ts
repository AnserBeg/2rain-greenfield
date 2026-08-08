import { ZodError } from 'zod';

import { canonicalize } from './canonicalize.js';
import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  IMMUTABLE_DEFAULTS_V0,
  LATEST_LANGUAGE_VERSION,
  LEGACY_LANGUAGE_VERSION,
  LANGUAGE_VERSION,
  STRUCTURAL_LIMITS_V0,
  SURFACE_SLOTS,
  canonicalLanguageProfileFor,
  languageHasLegalEntityQueryScope,
  languageHasMaterializedStateFields,
  languageHasV3Features,
  type CanonicalLanguageVersion,
  type CanonicalNormalizationProfileVersion,
} from './constants.js';
import {
  CanonicalModelError,
  compareCodeUnits,
  diagnostic,
  type CanonicalDiagnostic,
} from './diagnostics.js';
import {
  MIXED_NODE_VERSION_ISSUE,
  VersionedAuthoredApplicationPackageSchema,
  VersionedNormalizedApplicationPackageSchema,
  type AuthoredApplicationPackage,
  type CanonicalScalar,
  type NormalizedApplicationPackage,
  type QueryParameterReference,
  type V3AuthoredApplicationPackage,
  type V3NormalizedApplicationPackage,
  type V4AuthoredApplicationPackage,
  type V5AuthoredApplicationPackage,
  type V4NormalizedApplicationPackage,
  type VersionedAuthoredApplicationPackage,
  type VersionedNormalizedApplicationPackage,
  type VersionedPredicateExpression,
} from './schemas.js';
import { parseStrictJson } from './strict-json.js';
import { inspectPredicateForExecution } from './predicate-kernel.js';

type CanonicalReference = {
  kind: string;
  schemaVersion: CanonicalLanguageVersion;
  targetId: string;
};

type FieldType =
  VersionedAuthoredApplicationPackage['fields'][number]['fieldType'];
type AggregateNormalizedQuery = Extract<
  VersionedNormalizedApplicationPackage['queries'][number],
  { queryType: 'aggregate' }
>;
/**
 * Narrows the package union, which a predicate on `languageVersion` alone
 * cannot do. v4 carries every v3 family, so both versions answer yes.
 */
function authoredHasV3Families(
  authored: VersionedAuthoredApplicationPackage,
): authored is
  | V3AuthoredApplicationPackage
  | V4AuthoredApplicationPackage
  | V5AuthoredApplicationPackage {
  return languageHasV3Features(authored.languageVersion);
}

/**
 * DERIVED from the package's own version, never written by hand. This node is
 * minted by normalization rather than authored, so a literal here is a node
 * version the package did not choose -- and `CANON_VERSION_MIXED` refuses any
 * node whose version disagrees with the envelope. Pinning it to a literal
 * therefore makes every package at a LATER version unnormalizable the moment
 * it carries a legal-entity scope, silently and only for that shape.
 */
type LegalEntityReferenceParameterType = {
  kind: 'legalEntityReferenceParameterType';
  schemaVersion: CanonicalLanguageVersion;
};
type QueryParameterType = FieldType | LegalEntityReferenceParameterType;
type QueryContract = {
  parameterTypes: Map<string, QueryParameterType>;
  resultType?: AggregateNormalizedQuery['aggregate']['resultType'];
};

export function parseAuthoredApplicationPackageJson(
  input: string | Uint8Array,
): VersionedAuthoredApplicationPackage {
  const parsed = parseAuthoredJsonInput(input);
  return parseAuthoredValue(parsed.value);
}

export function parseVersionedAuthoredApplicationPackageJson(
  input: string | Uint8Array,
): VersionedAuthoredApplicationPackage {
  const parsed = parseAuthoredJsonInput(input);
  return parseAuthoredValue(parsed.value);
}

function parseAuthoredJsonInput(input: string | Uint8Array): {
  byteLength: number;
  value: unknown;
} {
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
  return parsed;
}

export function parseNormalizedApplicationPackageJson(
  input: string | Uint8Array,
): VersionedNormalizedApplicationPackage {
  const parsed = parseStrictJson(input);
  if (parsed.byteLength > STRUCTURAL_LIMITS_V0.maximumNormalizedBytes) {
    throw new CanonicalModelError([
      diagnostic(
        'CANON_LIMIT_NORMALIZED_BYTES',
        '$',
        `normalized package bytes must not exceed ${STRUCTURAL_LIMITS_V0.maximumNormalizedBytes}`,
        'split the package or reduce canonical definitions',
      ),
    ]);
  }
  let normalized: VersionedNormalizedApplicationPackage;
  try {
    normalized = VersionedNormalizedApplicationPackageSchema.parse(
      parsed.value,
    );
  } catch (error) {
    if (error instanceof ZodError) throw schemaError(error, parsed.value);
    throw error;
  }
  enforceFamilyBounds(normalized);
  validateSemantics(normalized);
  enforceValueBounds(normalized);
  validateNormalizedDerivation(normalized);
  return deepFreeze(normalized);
}

export function normalizeApplicationPackage(
  input: V3AuthoredApplicationPackage,
): V3NormalizedApplicationPackage;
export function normalizeApplicationPackage(
  input: unknown,
): NormalizedApplicationPackage;
export function normalizeApplicationPackage(
  input: unknown,
): VersionedNormalizedApplicationPackage {
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
  validateAuthoredDerivedStateFields(authored);
  const fieldTypes = new Map(
    authored.fields.map((field) => [field.fieldId, field.fieldType] as const),
  );
  const queryContracts = deriveQueryContracts(authored);

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
    ...(authoredHasV3Families(authored)
      ? {
          impactAnalyses: authored.impactAnalyses,
        }
      : {}),
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
    normalizationProfileVersion: normalizationProfileFor(
      authored.languageVersion,
    ),
    operations: authored.operations.map((entry) =>
      languageHasV3Features(authored.languageVersion)
        ? {
            ...entry,
            lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
            precondition: normalizePredicate(
              (entry as V3AuthoredApplicationPackage['operations'][number])
                .precondition ?? defaultPredicate(authored.languageVersion),
              1,
              fieldTypes,
            ),
          }
        : {
            ...entry,
            lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
            precondition: normalizePredicate(
              (entry as AuthoredApplicationPackage['operations'][number])
                .precondition ?? defaultPredicate(authored.languageVersion),
              1,
              fieldTypes,
            ),
          },
    ),
    package: {
      ...authored.package,
      lifecycle: authored.package.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
    },
    permissions: authored.permissions.map((entry) => ({
      ...entry,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
    })),
    queries: authored.queries.map((entry) => {
      if (entry.queryType === 'aggregate') {
        const contract = queryContracts.get(entry.queryId)!;
        return {
          ...entry,
          aggregate: {
            ...entry.aggregate,
            resultType: contract.resultType,
          },
          filter: normalizePredicate(
            entry.filter ?? defaultPredicate(authored.languageVersion),
            1,
            fieldTypes,
          ),
          lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
          parameters: sortByOrderAndId(
            entry.parameters.map((parameter) => ({
              ...parameter,
              parameterType: contract.parameterTypes.get(
                parameter.parameterId,
              )!,
            })),
            'parameterId',
          ),
        };
      }
      if (languageHasV3Features(authored.languageVersion)) {
        const v3Entry = entry as Extract<
          V3AuthoredApplicationPackage['queries'][number],
          { queryType: 'get' | 'list' | 'resolve' | 'search' }
        >;
        const rowContract = queryContracts.get(v3Entry.queryId);
        return {
          ...v3Entry,
          filter: normalizePredicate(
            v3Entry.filter ?? defaultPredicate(authored.languageVersion),
            1,
            fieldTypes,
          ),
          lifecycle: v3Entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
          // v4 row queries always carry the collection, empty when the query
          // declares no operand, so the normalized shape is closed rather than
          // conditionally present.
          ...(languageHasLegalEntityQueryScope(authored.languageVersion)
            ? {
                parameters: sortByOrderAndId(
                  authoredRowParameters(v3Entry).map((parameter) => ({
                    ...parameter,
                    parameterType: rowContract!.parameterTypes.get(
                      parameter.parameterId,
                    )!,
                  })),
                  'parameterId',
                ),
              }
            : {}),
          resolveMatchKeys: sortByOrderAndId(
            v3Entry.resolveMatchKeys ?? [],
            'matchKeyId',
          ),
          selections: sortByOrderAndId(v3Entry.selections, 'selectionId'),
        };
      }
      return {
        ...entry,
        filter: normalizePredicate(
          entry.filter ?? defaultPredicate(authored.languageVersion),
          1,
          fieldTypes,
        ),
        lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
        ...(entry.resolveMatchKeys !== undefined ||
        languageHasV2Features(authored.languageVersion)
          ? {
              resolveMatchKeys: sortByOrderAndId(
                entry.resolveMatchKeys ?? [],
                'matchKeyId',
              ),
            }
          : {}),
        selections: sortByOrderAndId(entry.selections, 'selectionId'),
      };
    }),
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
      stateField: derivedStateField(entry.machineId, authored.languageVersion),
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
      ...(authored.languageVersion !== LEGACY_LANGUAGE_VERSION
        ? { storageClass: entry.storageClass ?? null }
        : {}),
    })),
    surfaces: authored.surfaces.map((entry) => ({
      ...entry,
      lifecycle: entry.lifecycle ?? IMMUTABLE_DEFAULTS_V0.lifecycle,
      slots: sortByOrderAndId(entry.slots, 'slotId'),
      statusRoles: sortedStrings(entry.statusRoles),
    })),
  };

  /**
   * A state machine MATERIALIZES its state field as an ordinary enumeration
   * field on its entity, whose options are the machine's states
   * ([ADR-0050](../../../docs/decisions/ADR-0050-the-record-transition-carrier.md)).
   * A document therefore has exactly ONE state, addressable by a predicate,
   * selectable by a query, and written only by a transition.
   *
   * **The placement is forced, not chosen.** Three compiler guards refuse every
   * alternative, each for its own reason: deriving it in a projection fails
   * `COMPILER_PROJECTION_INVARIANT_FAILED`, because every projection must agree
   * with the normalized model; emitting it alongside the retired
   * `derivedStateField` fails `COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE`; and
   * leaving the machine a second owner of the identity fails
   * `COMPILER_SYMBOL_DUPLICATE`.
   *
   * **Gated at v5, and that gate is what keeps the cut free.** Materializing
   * changes normalized bytes, which ADR-0047 §7 names as the boundary that owes
   * a language cut. Below v5 the machine keeps its parallel `derivedStateField`
   * and normalizes byte-for-byte as before, so every recorded release root
   * still reproduces.
   *
   * The `alreadyMaterialized` guard is load-bearing rather than defensive:
   * normalization is applied to already-normalized packages on the canonical
   * round-trip, and without it the second pass mints a duplicate identity.
   */
  const materializedStateFields = languageHasMaterializedStateFields(
    authored.languageVersion,
  )
    ? materializeStateFields(normalizedCandidate)
    : [];

  const sortedCandidate = {
    ...normalizedCandidate,
    assertions: sortById(normalizedCandidate.assertions, 'assertionId'),
    capabilityRequirements: sortById(
      normalizedCandidate.capabilityRequirements,
      'capabilityId',
    ),
    ...(languageHasV3Features(authored.languageVersion)
      ? {
          impactAnalyses: normalizedCandidate.impactAnalyses,
        }
      : {}),
    entities: sortByOwnerOrderAndId(
      normalizedCandidate.entities,
      (entry) => entry.module.targetId,
      'entityId',
    ),
    fields: sortByOwnerOrderAndId(
      [...normalizedCandidate.fields, ...materializedStateFields],
      (entry) => entry.entity.targetId,
      'fieldId',
    ),
    modules: sortByOrderAndId(normalizedCandidate.modules, 'moduleId'),
    operations: sortById(normalizedCandidate.operations, 'operationId'),
    permissions: sortById(normalizedCandidate.permissions, 'permissionId'),
    queries: sortById(normalizedCandidate.queries, 'queryId'),
    relations: sortByOwnerOrderAndId(
      normalizedCandidate.relations,
      (entry) => entry.sourceEntity.targetId,
      'relationId',
    ),
    stateMachines: sortById(normalizedCandidate.stateMachines, 'machineId'),
    storageMappings: sortById(
      normalizedCandidate.storageMappings,
      'storageMappingId',
    ),
    surfaces: sortById(normalizedCandidate.surfaces, 'surfaceId'),
  };

  let normalized: VersionedNormalizedApplicationPackage;
  try {
    normalized =
      VersionedNormalizedApplicationPackageSchema.parse(sortedCandidate);
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
  normalized: V3NormalizedApplicationPackage,
): V3AuthoredApplicationPackage;
export function canonicalAuthoredProjection(
  normalized: V4NormalizedApplicationPackage,
): V4AuthoredApplicationPackage;
export function canonicalAuthoredProjection(
  normalized: NormalizedApplicationPackage,
): AuthoredApplicationPackage;
// Callers holding an unnarrowed package need an overload of their own, or they
// are forced into a dead `languageVersion === 'v3' ? x : x` ternary that breaks
// the moment a version is appended. Two call sites had exactly that.
export function canonicalAuthoredProjection(
  normalized: VersionedNormalizedApplicationPackage,
): VersionedAuthoredApplicationPackage;
export function canonicalAuthoredProjection(
  normalized: VersionedNormalizedApplicationPackage,
): VersionedAuthoredApplicationPackage {
  VersionedNormalizedApplicationPackageSchema.parse(normalized);
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
    if (object.kind === 'stateMachineDefinition') {
      delete object.stateField;
    }
    if (
      object.kind === 'queryDefinition' &&
      inspectPredicateForExecution(object.filter).outcome === 'accepted'
    ) {
      delete object.filter;
    }
    if (object.kind === 'queryParameterDefinition') {
      delete object.parameterType;
    }
    if (object.kind === 'queryAggregateSelection') {
      delete object.resultType;
    }
    if (
      object.kind === 'operationDefinition' &&
      inspectPredicateForExecution(object.precondition).outcome === 'accepted'
    ) {
      delete object.precondition;
    }
  });
  return parseAuthoredValue(projected);
}

function validateNormalizedDerivation(
  normalized: VersionedNormalizedApplicationPackage,
): void {
  const renormalized = normalizeApplicationPackage(
    canonicalAuthoredProjection(normalized),
  );
  if (canonicalize(renormalized) === canonicalize(normalized)) return;
  throw new CanonicalModelError([
    diagnostic(
      'CANON_NORMALIZED_DERIVED_MISMATCH',
      '$',
      'normalized authority must equal the deterministic normalization of its canonical authored projection',
      'derive normalized metadata through normalizeApplicationPackage',
      normalized.package.packageId,
    ),
  ]);
}

function parseAuthoredValue(
  input: unknown,
): VersionedAuthoredApplicationPackage {
  try {
    // Purity is enforced by the exported schema itself, so every consumer of
    // it -- these parsers and any direct caller -- gets the same rule.
    return VersionedAuthoredApplicationPackageSchema.parse(input);
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
      issue.message === MIXED_NODE_VERSION_ISSUE
        ? 'CANON_VERSION_MIXED'
        : pathParts.includes('relations') && finalPart === 'cardinality'
          ? 'CANON_RELATION_CARDINALITY_UNSUPPORTED'
          : finalPart === 'kind'
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
      `value must satisfy a closed supported schema through ${LATEST_LANGUAGE_VERSION}`,
      acceptedAlternativeFor(code),
      findObjectId(input, issue.path),
    );
  });
  return new CanonicalModelError(diagnostics);
}

function deriveQueryContracts(
  authored: VersionedAuthoredApplicationPackage,
): Map<string, QueryContract> {
  const contracts = new Map<string, QueryContract>();
  if (!languageHasV3Features(authored.languageVersion)) return contracts;
  const diagnostics: CanonicalDiagnostic[] = [];
  const fields = new Map(
    authored.fields.map((field) => [field.fieldId, field] as const),
  );
  for (const query of authored.queries) {
    if (query.queryType !== 'aggregate') {
      const rowContract = deriveRowQueryContract(
        authored,
        query,
        fields,
        diagnostics,
      );
      if (rowContract) contracts.set(query.queryId, rowContract);
      continue;
    }
    const source = fields.get(query.aggregate.field.targetId);
    if (!source) {
      diagnostics.push(
        diagnostic(
          'CANON_REFERENCE_UNRESOLVED',
          '$.queries.aggregate.field',
          'aggregate source fields resolve inside the complete package',
          'reference a declared field',
          query.queryId,
        ),
      );
      continue;
    }
    if (source.entity.targetId !== query.sourceEntity.targetId) {
      diagnostics.push(
        diagnostic(
          'CANON_QUERY_AGGREGATE_FIELD_LOCALITY',
          '$.queries.aggregate.field',
          'aggregate selections belong to the query source entity',
          'reference a field owned by the source entity',
          query.queryId,
        ),
      );
    }
    if (source.presence !== 'required') {
      diagnostics.push(
        diagnostic(
          'CANON_QUERY_AGGREGATE_OPTIONAL_UNSUPPORTED',
          '$.queries.aggregate.field',
          'query aggregate profile v1 rejects optional source fields',
          'make the exact-numeric source field required',
          query.queryId,
        ),
      );
    }
    if (
      source.fieldType.kind !== 'exactDecimalFieldType' &&
      source.fieldType.kind !== 'quantityFieldType'
    ) {
      diagnostics.push(
        diagnostic(
          'CANON_QUERY_AGGREGATE_TYPE_UNSUPPORTED',
          '$.queries.aggregate.field',
          'query aggregate profile v1 admits required exact-decimal and quantity sources only',
          'use a required exactDecimalFieldType or quantityFieldType source',
          query.queryId,
        ),
      );
      continue;
    }

    const parameterTypes = deriveQueryParameterTypes(
      authored,
      query,
      query.parameters,
      fields,
      diagnostics,
    );
    if (
      parameterTypes.size !== query.parameters.length ||
      diagnostics.some((entry) => entry.objectId === query.queryId)
    ) {
      continue;
    }
    const resultType: QueryContract['resultType'] =
      source.fieldType.kind === 'quantityFieldType'
        ? {
            baseUnit: source.fieldType.baseUnit,
            kind: 'quantityAggregateResultType',
            precision: 38,
            scale: source.fieldType.scale,
            schemaVersion: authored.languageVersion,
          }
        : {
            kind: 'exactDecimalAggregateResultType',
            precision: 38,
            scale: source.fieldType.scale,
            schemaVersion: authored.languageVersion,
          };
    contracts.set(query.queryId, { parameterTypes, resultType });
  }
  if (diagnostics.length > 0) throw new CanonicalModelError(diagnostics);
  return contracts;
}

type AuthoredQuery = VersionedAuthoredApplicationPackage['queries'][number];

function authoredRowParameters(
  query: AuthoredQuery,
): readonly AuthoredParameterDefinition[] {
  return 'parameters' in query && Array.isArray(query.parameters)
    ? (query.parameters as AuthoredParameterDefinition[])
    : [];
}
type AuthoredParameterDefinition = Extract<
  AuthoredQuery,
  { queryType: 'aggregate' }
>['parameters'][number];

/**
 * v4 row queries carry parameters so they can carry a legal-entity operand.
 * Earlier versions have no `parameters` collection, so they contribute nothing.
 */
function deriveRowQueryContract(
  authored: VersionedAuthoredApplicationPackage,
  query: AuthoredQuery,
  fields: ReadonlyMap<
    string,
    VersionedAuthoredApplicationPackage['fields'][number]
  >,
  diagnostics: CanonicalDiagnostic[],
): QueryContract | null {
  if (!languageHasLegalEntityQueryScope(authored.languageVersion)) return null;
  const declared = authoredRowParameters(query);
  if (declared.length === 0 && !('legalEntityScope' in query)) return null;
  const parameterTypes = deriveQueryParameterTypes(
    authored,
    query,
    declared,
    fields,
    diagnostics,
  );
  return { parameterTypes };
}

/**
 * One derivation for every query branch. A parameter's type comes from exactly
 * one binding position — the field it is compared against, or the legal-entity
 * scope operand that names it. A parameter bound in both positions is refused
 * rather than given a winner, because a silent winner is a second authority on
 * what the caller's argument means.
 */
function deriveQueryParameterTypes(
  authored: VersionedAuthoredApplicationPackage,
  query: AuthoredQuery,
  declared: readonly AuthoredParameterDefinition[],
  fields: ReadonlyMap<
    string,
    VersionedAuthoredApplicationPackage['fields'][number]
  >,
  diagnostics: CanonicalDiagnostic[],
): Map<string, QueryParameterType> {
  const parameters = new Map(
    declared.map((parameter) => [parameter.parameterId, parameter] as const),
  );
  const parameterTypes = new Map<string, QueryParameterType>();
  const scope =
    languageHasLegalEntityQueryScope(authored.languageVersion) &&
    'legalEntityScope' in query
      ? query.legalEntityScope
      : undefined;
  if (scope) {
    if (!parameters.has(scope.operand.parameterId)) {
      diagnostics.push(
        diagnostic(
          'CANON_QUERY_PARAMETER_UNRESOLVED',
          '$.queries.legalEntityScope.operand.parameterId',
          'query parameter references resolve within their own query',
          'declare the referenced queryParameterDefinition',
          query.queryId,
        ),
      );
    } else {
      parameterTypes.set(scope.operand.parameterId, {
        kind: 'legalEntityReferenceParameterType',
        schemaVersion: authored.languageVersion,
      });
    }
  }
  visitQueryParameterReferences(
    query.filter ?? defaultPredicate(authored.languageVersion),
    (reference, comparison) => {
      const parameter = parameters.get(reference.parameterId);
      if (!parameter) {
        diagnostics.push(
          diagnostic(
            'CANON_QUERY_PARAMETER_UNRESOLVED',
            '$.queries.filter.value.parameterId',
            'query parameter references resolve within their own query',
            'declare the referenced queryParameterDefinition',
            query.queryId,
          ),
        );
        return;
      }
      if (scope && reference.parameterId === scope.operand.parameterId) {
        diagnostics.push(
          diagnostic(
            'CANON_QUERY_LEGAL_ENTITY_SCOPE_PARAMETER_CONFLICT',
            '$.queries.filter.value.parameterId',
            'the legal-entity scope operand is not also an ordinary filter operand',
            'declare a separate queryParameterDefinition for the filter comparison',
            query.queryId,
          ),
        );
        return;
      }
      const comparedField = fields.get(comparison.field.targetId);
      if (!comparedField) return;
      const prior = parameterTypes.get(reference.parameterId);
      if (
        prior !== undefined &&
        canonicalize(prior) !== canonicalize(comparedField.fieldType)
      ) {
        diagnostics.push(
          diagnostic(
            'CANON_QUERY_PARAMETER_TYPE_MISMATCH',
            '$.queries.filter.value',
            'one query parameter has one scalar type across every use',
            'use distinct parameters for incompatible field types',
            query.queryId,
          ),
        );
        return;
      }
      parameterTypes.set(reference.parameterId, comparedField.fieldType);
    },
  );
  for (const parameter of declared) {
    if (!parameterTypes.has(parameter.parameterId)) {
      diagnostics.push(
        diagnostic(
          'CANON_QUERY_PARAMETER_UNUSED',
          '$.queries.parameters',
          'every declared query parameter has exactly one binding position',
          'remove the parameter, reference it from the filter, or name it as the legal-entity scope operand',
          query.queryId,
        ),
      );
    }
  }
  return parameterTypes;
}

function validateSemantics(
  packageRevision: VersionedNormalizedApplicationPackage,
): void {
  const diagnostics: CanonicalDiagnostic[] = [];
  const namespace = packageRevision.package.namespace;
  visitObjects(packageRevision, (object) => {
    if (
      typeof object.schemaVersion === 'string' &&
      object.schemaVersion !== packageRevision.languageVersion
    ) {
      diagnostics.push(
        diagnostic(
          'CANON_VERSION_MIXED',
          '$',
          'one package uses one language version for its envelope and every nested canonical node',
          `use ${packageRevision.languageVersion} for every schemaVersion`,
          findObjectId(object, []),
        ),
      );
    }
  });
  if (
    packageRevision.normalizationProfileVersion !==
    normalizationProfileFor(packageRevision.languageVersion)
  ) {
    diagnostics.push(
      diagnostic(
        'CANON_VERSION_PROFILE_MISMATCH',
        '$.normalizationProfileVersion',
        'the normalization profile is selected by the package language version',
        `use ${normalizationProfileFor(packageRevision.languageVersion)}`,
        packageRevision.package.packageId,
      ),
    );
  }
  if (
    packageRevision.languageVersion === LEGACY_LANGUAGE_VERSION &&
    packageRevision.queries.some((query) => query.queryType === 'search')
  ) {
    diagnostics.push(
      diagnostic(
        'CANON_QUERY_TYPE_VERSION_UNSUPPORTED',
        '$.queries.queryType',
        'search is introduced by canonical language v1 and does not widen v0-experimental',
        `upgrade the complete package to ${LANGUAGE_VERSION}`,
        packageRevision.queries.find((query) => query.queryType === 'search')
          ?.queryId ?? packageRevision.package.packageId,
      ),
    );
  }
  for (const query of packageRevision.queries) {
    if (
      query.queryType !== 'resolve' &&
      (query.resolveMatchKeys?.length ?? 0) > 0
    ) {
      diagnostics.push(
        diagnostic(
          'CANON_RESOLVE_MATCH_KEYS_QUERY_TYPE_MISMATCH',
          '$.queries.resolveMatchKeys',
          'resolve match authority belongs only to resolve queries',
          'remove resolveMatchKeys or change the queryType to resolve',
          query.queryId,
        ),
      );
    }
    if (
      !languageHasV2Features(packageRevision.languageVersion) &&
      (query.resolveMatchKeys?.length ?? 0) > 0
    ) {
      diagnostics.push(
        diagnostic(
          'CANON_RESOLVE_MATCH_AUTHORITY_VERSION_UNSUPPORTED',
          '$.queries.resolveMatchKeys',
          'explicit resolve match authority is introduced by canonical language v2 and does not widen prior language versions',
          `upgrade the complete package to ${LANGUAGE_VERSION}`,
          query.queryId,
        ),
      );
    }
  }
  if (packageRevision.languageVersion === LEGACY_LANGUAGE_VERSION) {
    const v1OnlyObjectIds = [
      ...packageRevision.fields
        .filter(
          (field) =>
            field.businessKey !== undefined ||
            field.collation !== undefined ||
            field.defaultSemantics !== undefined ||
            field.defaultValue !== undefined ||
            field.storageEvolution !== undefined,
        )
        .map((field) => field.fieldId),
      ...packageRevision.relations
        .filter((relation) => relation.foreignKeyActions !== undefined)
        .map((relation) => relation.relationId),
      ...packageRevision.operations
        .filter((operation) =>
          [
            'deleteRecordEffect',
            'destroyRecordEffect',
            'purgeRecordEffect',
          ].includes(operation.effect.kind),
        )
        .map((operation) => operation.operationId),
      ...packageRevision.surfaces
        .filter(
          (surface) =>
            surface.renderer !== undefined || surface.surfaceRole !== undefined,
        )
        .map((surface) => surface.surfaceId),
      ...packageRevision.storageMappings
        .filter(
          (mapping) =>
            mapping.storageClass === null ||
            mapping.storageClass === undefined ||
            mapping.promotion !== undefined,
        )
        .map((mapping) => mapping.storageMappingId),
    ].sort(compareCodeUnits);
    for (const objectId of v1OnlyObjectIds) {
      diagnostics.push(
        diagnostic(
          'CANON_CONSTRUCT_VERSION_UNSUPPORTED',
          '$',
          'v1 storage, surface-role, renderer-reserve, and destructive-operation representations do not widen v0-experimental',
          `upgrade the complete package to ${LANGUAGE_VERSION}`,
          objectId,
        ),
      );
    }
  }
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
      // Capability requirements name provider-owned contracts. ADR-0026's
      // posting identity is intentionally independent of the consuming package
      // namespace; treating it as an owned ID would force an alias and defeat
      // exact registration. Every actual package-owned construct stays local.
      if (
        family !== 'capabilityRequirements' &&
        namespaceOf(id) !== namespace
      ) {
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
  packageRevision: VersionedNormalizedApplicationPackage,
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
    if (
      expectedKind !== 'capabilityReference' &&
      namespaceOf(reference.targetId) !== namespace
    ) {
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
    if (field.defaultValue?.kind === 'quantityValue') {
      check(
        field.defaultValue.baseUnit,
        'unitReference',
        '$.fields.defaultValue.baseUnit',
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
    if (query.queryType === 'aggregate') {
      check(
        query.aggregate.field,
        'fieldReference',
        '$.queries.aggregate.field',
        query.queryId,
      );
      if (query.aggregate.resultType.kind === 'quantityAggregateResultType') {
        check(
          query.aggregate.resultType.baseUnit,
          'unitReference',
          '$.queries.aggregate.resultType.baseUnit',
          query.queryId,
        );
      }
      for (const parameter of query.parameters) {
        if (parameter.parameterType.kind === 'quantityFieldType') {
          check(
            parameter.parameterType.baseUnit,
            'unitReference',
            '$.queries.parameters.parameterType.baseUnit',
            query.queryId,
          );
        }
      }
    } else {
      for (const selection of query.selections) {
        check(
          selection.field,
          'fieldReference',
          '$.queries.selections.field',
          query.queryId,
        );
      }
    }
    for (const matchKey of query.resolveMatchKeys ?? []) {
      check(
        matchKey.field,
        'fieldReference',
        '$.queries.resolveMatchKeys.field',
        query.queryId,
      );
    }
    visitPredicate(query.filter, (reference, path, expectedKind) =>
      check(reference, expectedKind, `$.queries.filter${path}`, query.queryId),
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
    visitPredicate(operation.precondition, (reference, path, expectedKind) =>
      check(
        reference,
        expectedKind,
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
  packageRevision: VersionedNormalizedApplicationPackage,
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
  packageRevision: VersionedNormalizedApplicationPackage,
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
  const fieldDefinitions = new Map(
    packageRevision.fields.map((entry) => [entry.fieldId, entry] as const),
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
  const parentScopes = packageRevision.relations.filter(
    (relation) => relation.ownership === 'parentScopedChild',
  );
  const childEntities = new Set(
    parentScopes.map((relation) => relation.sourceEntity.targetId),
  );
  const parentScopeCount = new Map<string, number>();

  for (const field of packageRevision.fields) {
    const requiresDefault =
      field.defaultSemantics === 'declaredDefault' ||
      field.defaultSemantics === 'coalesceAtRead';
    if (requiresDefault !== (field.defaultValue !== undefined)) {
      diagnostics.push(
        diagnostic(
          'CANON_FIELD_DEFAULT_INVALID',
          '$.fields.defaultValue',
          'declared-default and coalesce-at-read semantics carry one typed canonical default value and other modes carry none',
          requiresDefault
            ? 'provide a defaultValue matching the field type'
            : 'remove defaultValue or declare default/coalesce semantics',
          field.fieldId,
        ),
      );
    }
    if (field.defaultValue !== undefined) {
      validateComparisonValue(
        {
          field: {
            kind: 'fieldReference',
            schemaVersion: packageRevision.languageVersion,
            targetId: field.fieldId,
          },
          kind: 'fieldComparisonPredicate',
          operator: 'equals',
          schemaVersion: packageRevision.languageVersion,
          value: field.defaultValue,
        },
        field,
        '$.fields.defaultValue',
        field.fieldId,
        diagnostics,
      );
    }
  }

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
  for (const relation of parentScopes) {
    const childId = relation.sourceEntity.targetId;
    const parentId = relation.targetEntity.targetId;
    parentScopeCount.set(childId, (parentScopeCount.get(childId) ?? 0) + 1);
    if (
      relation.cardinality !== 'manyToOne' ||
      !relation.required ||
      relation.archiveBehavior !== 'restrict'
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
    if (
      childId === parentId ||
      childEntities.has(parentId) ||
      (entityModule.has(childId) &&
        entityModule.has(parentId) &&
        entityModule.get(childId) !== entityModule.get(parentId))
    ) {
      diagnostics.push(
        diagnostic(
          'CANON_RELATION_PARENT_TOPOLOGY_INVALID',
          '$.relations',
          'a v0 parent-scoped child has one distinct top-level parent in the same module',
          'reference a distinct non-child entity owned by the child module',
          relation.relationId,
        ),
      );
    }
  }
  for (const [childId, count] of parentScopeCount) {
    if (count > 1) {
      diagnostics.push(
        diagnostic(
          'CANON_RELATION_PARENT_OWNER_DUPLICATE',
          '$.relations',
          'a v0 child entity has exactly one parent-scope authority',
          'keep one parentScopedChild relation for the child entity',
          childId,
        ),
      );
    }
  }
  for (const machine of packageRevision.stateMachines) {
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
    if (query.queryType === 'aggregate') {
      const aggregateField = fieldDefinitions.get(
        query.aggregate.field.targetId,
      );
      if (aggregateField?.entity.targetId !== query.sourceEntity.targetId) {
        diagnostics.push(
          diagnostic(
            'CANON_QUERY_AGGREGATE_FIELD_LOCALITY',
            '$.queries.aggregate.field',
            'aggregate selections belong to the query source entity',
            'reference a field owned by the source entity',
            query.queryId,
          ),
        );
      }
    } else {
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
    visitFieldComparisons(query.filter, (comparison, path) => {
      if (
        fieldEntity.get(comparison.field.targetId) !==
        query.sourceEntity.targetId
      ) {
        diagnostics.push(
          diagnostic(
            'CANON_QUERY_FILTER_FIELD_LOCALITY',
            `$.queries.filter${path}.field`,
            'v0 query filter fields belong to the source entity',
            'use a field owned by the query source entity',
            query.queryId,
          ),
        );
      }
      validateComparisonValue(
        comparison,
        fieldDefinitions.get(comparison.field.targetId),
        `$.queries.filter${path}.value`,
        query.queryId,
        diagnostics,
      );
    });
    if (query.queryType !== 'aggregate') {
      visitQueryParameterReferences(query.filter, () => {
        diagnostics.push(
          diagnostic(
            'CANON_QUERY_PARAMETER_SCOPE_INVALID',
            '$.queries.filter.value',
            'query parameter references belong only to the aggregate query that declares them',
            'use a canonical scalar or declare an aggregate query parameter',
            query.queryId,
          ),
        );
      });
    }
  }
  for (const operation of packageRevision.operations) {
    visitFieldComparisons(operation.precondition, (comparison, path) => {
      validateComparisonValue(
        comparison,
        fieldDefinitions.get(comparison.field.targetId),
        `$.operations.precondition${path}.value`,
        operation.operationId,
        diagnostics,
      );
    });
    visitQueryParameterReferences(operation.precondition, () => {
      diagnostics.push(
        diagnostic(
          'CANON_QUERY_PARAMETER_SCOPE_INVALID',
          '$.operations.precondition.value',
          'query parameter references cannot escape their aggregate query',
          'use a canonical scalar operation precondition',
          operation.operationId,
        ),
      );
    });
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
  packageRevision: VersionedNormalizedApplicationPackage,
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
  for (const query of packageRevision.queries) {
    rejectDuplicateStrings(
      (query.resolveMatchKeys ?? []).map((matchKey) => matchKey.field.targetId),
      '$.queries.resolveMatchKeys.field',
      query.queryId,
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
  packageRevision: VersionedNormalizedApplicationPackage,
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
    ...orderCollectionsByOwner(
      packageRevision.entities,
      (entry) => entry.module.targetId,
      '$.entities',
    ),
    ...orderCollectionsByOwner(
      packageRevision.fields,
      (entry) => entry.entity.targetId,
      '$.fields',
    ),
    ...orderCollectionsByOwner(
      packageRevision.relations,
      (entry) => entry.sourceEntity.targetId,
      '$.relations',
    ),
    ...packageRevision.fields.flatMap((field) =>
      field.fieldType.kind === 'enumFieldType'
        ? [
            {
              entries: field.fieldType.options,
              objectId: field.fieldId,
              path: '$.fields.fieldType.options',
            },
          ]
        : [],
    ),
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
      entries:
        query.queryType === 'aggregate' ? query.parameters : query.selections,
      objectId: query.queryId,
      path:
        query.queryType === 'aggregate'
          ? '$.queries.parameters'
          : '$.queries.selections',
    })),
    ...packageRevision.queries.map((query) => ({
      entries: query.resolveMatchKeys ?? [],
      objectId: query.queryId,
      path: '$.queries.resolveMatchKeys',
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

function validateAuthoredDerivedStateFields(
  authored: VersionedAuthoredApplicationPackage,
): void {
  const diagnostics: CanonicalDiagnostic[] = [];
  for (const machine of authored.stateMachines) {
    if (
      machine.stateField !== undefined &&
      canonicalize(machine.stateField) !==
        canonicalize(
          derivedStateField(machine.machineId, authored.languageVersion),
        )
    ) {
      diagnostics.push(
        diagnostic(
          'CANON_DERIVED_STATE_FIELD_INVALID',
          '$.stateMachines.stateField',
          'the state field is compiler-derived from machine identity and stores only canonical stateId values',
          'omit stateField in authored form or use the exact normalized derived field',
          machine.machineId,
        ),
      );
    }
  }
  if (diagnostics.length > 0) throw new CanonicalModelError(diagnostics);
}

/**
 * The materialized form of a machine's state field. Every property is derived
 * from the machine, so the authored surface gains nothing and the field cannot
 * disagree with the states it admits:
 *
 * - `options` ARE the machine's states, so `stateId` and `optionId` are one
 *   identity rather than two that must be kept in step. This is why the state
 *   ids move out of the `stateMachines` id family in `collectIds`.
 * - `declaredDefault` carries `initialState`, so a generic create seeds the
 *   state without the caller naming it -- a caller that could choose the
 *   initial state could forge one.
 * - `presence: 'required'` with that default is what makes the column
 *   non-null without making it caller-constructible; the compiled input
 *   contract excludes it, exactly as `systemInput` excludes `legalEntityId`.
 * - `orderKey: 0` places state ahead of every authored field, which start at
 *   10 by convention, and is stable because a machine owns exactly one.
 */
function materializeStateFields(packageRevision: {
  readonly fields: readonly { readonly fieldId: string }[];
  readonly stateMachines: readonly {
    readonly entity: unknown;
    readonly lifecycle: string;
    readonly initialState: { readonly targetId: string };
    readonly schemaVersion: string;
    readonly stateField: { readonly fieldId: string };
    readonly states: readonly {
      readonly label: string;
      readonly orderKey: number;
      readonly stateId: string;
    }[];
  }[];
}): VersionedNormalizedApplicationPackage['fields'] {
  const alreadyMaterialized = new Set(
    packageRevision.fields.map((field) => field.fieldId),
  );
  return packageRevision.stateMachines
    .filter((machine) => !alreadyMaterialized.has(machine.stateField.fieldId))
    .map(
      (machine) =>
        ({
          classification: 'internal',
          collation: 'binary',
          defaultSemantics: 'declaredDefault',
          defaultValue: {
            kind: 'textValue',
            schemaVersion: machine.schemaVersion,
            value: machine.initialState.targetId,
          },
          entity: machine.entity,
          fieldId: machine.stateField.fieldId,
          fieldType: {
            kind: 'enumFieldType',
            options: machine.states.map((state) => ({
              kind: 'enumOption',
              label: state.label,
              optionId: state.stateId,
              orderKey: state.orderKey,
              schemaVersion: machine.schemaVersion,
            })),
            schemaVersion: machine.schemaVersion,
          },
          kind: 'fieldDefinition',
          label: 'State',
          lifecycle: machine.lifecycle,
          orderKey: 0,
          presence: 'required',
          reportable: true,
          schemaVersion: machine.schemaVersion,
          searchable: false,
        }) as unknown as VersionedNormalizedApplicationPackage['fields'][number],
    );
}

function derivedStateField(
  machineId: string,
  schemaVersion: CanonicalLanguageVersion,
): {
  fieldId: string;
  kind: 'derivedStateField';
  schemaVersion: CanonicalLanguageVersion;
  valueKind: 'stateId';
} {
  const separator = machineId.indexOf(':');
  const namespace = machineId.slice(0, separator);
  const localIdentity = machineId.slice(separator + 1);
  return {
    fieldId: `${namespace}:derived_state_field.${localIdentity}`,
    kind: 'derivedStateField',
    schemaVersion,
    valueKind: 'stateId',
  };
}

function orderCollectionsByOwner<T extends { orderKey: number }>(
  entries: readonly T[],
  ownerId: (entry: T) => string,
  path: string,
): Array<{ entries: T[]; objectId: string; path: string }> {
  const grouped = new Map<string, T[]>();
  for (const entry of entries) {
    const owner = ownerId(entry);
    const siblings = grouped.get(owner) ?? [];
    siblings.push(entry);
    grouped.set(owner, siblings);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([objectId, siblings]) => ({ entries: siblings, objectId, path }));
}

function normalizePredicate(
  predicate: VersionedPredicateExpression,
  depth: number,
  fieldTypes: ReadonlyMap<string, FieldType>,
): VersionedPredicateExpression {
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
      term: normalizePredicate(predicate.term, depth + 1, fieldTypes),
    } as VersionedPredicateExpression;
  }
  if (predicate.kind === 'allPredicate' || predicate.kind === 'anyPredicate') {
    const terms = predicate.terms
      .map((term) => normalizePredicate(term, depth + 1, fieldTypes))
      .sort((left, right) =>
        compareCodeUnits(canonicalize(left), canonicalize(right)),
      );
    return { ...predicate, terms } as VersionedPredicateExpression;
  }
  if (predicate.kind === 'fieldComparisonPredicate') {
    return {
      ...predicate,
      value:
        predicate.value.kind === 'queryParameterReference'
          ? predicate.value
          : normalizeScalarForField(
              predicate.value,
              fieldTypes.get(predicate.field.targetId),
            ),
    } as VersionedPredicateExpression;
  }
  return predicate;
}

function normalizeScalarForField(
  value: CanonicalScalar,
  fieldType: FieldType | undefined,
): CanonicalScalar {
  if (value.kind === 'timeValue' && fieldType?.kind === 'timeFieldType') {
    const [whole, fraction] = value.value.split('.');
    return {
      ...value,
      value:
        fieldType.precision === 'millisecond'
          ? `${whole}.${fraction ?? '000'}`
          : fraction === undefined || fraction === '000'
            ? whole!
            : value.value,
    };
  }
  if (
    value.kind === 'dateTimeValue' &&
    fieldType?.kind === 'dateTimeFieldType'
  ) {
    return {
      ...value,
      value: canonicalDateTime(
        value.value,
        fieldType.precision,
        fieldType.timezoneSemantics,
      ),
    };
  }
  return value;
}

function canonicalDateTime(
  value: string,
  precision: 'second' | 'millisecond',
  timezoneSemantics: 'utcInstant' | 'offsetDateTime',
): string {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return value;
  const fraction = match[2] ?? '000';
  if (precision === 'second' && fraction !== '000') return value;
  if (timezoneSemantics === 'offsetDateTime') {
    const offset = match[3] === 'Z' ? '+00:00' : match[3];
    return `${match[1]}${precision === 'millisecond' ? `.${fraction}` : ''}${offset}`;
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return value;
  const iso = instant.toISOString();
  if (!/^\d{4}-/.test(iso)) return value;
  return precision === 'millisecond' ? iso : `${iso.slice(0, 19)}Z`;
}

function defaultPredicate(
  schemaVersion: CanonicalLanguageVersion,
): VersionedPredicateExpression {
  return {
    kind: 'booleanPredicate',
    schemaVersion,
    value: true,
  };
}

function normalizationProfileFor(
  languageVersion: CanonicalLanguageVersion,
): CanonicalNormalizationProfileVersion {
  return canonicalLanguageProfileFor(languageVersion)
    .normalizationProfileVersion;
}

function languageHasV2Features(
  languageVersion: CanonicalLanguageVersion,
): boolean {
  const featureLevel =
    canonicalLanguageProfileFor(languageVersion).featureLevel;
  // Feature levels are cumulative. Leaving a newly cut version out of a
  // predecessor's check is how a version cut silently drops a released rule.
  return (
    featureLevel === 'v2' ||
    featureLevel === 'v3' ||
    featureLevel === 'v4' ||
    featureLevel === 'v5'
  );
}

function enforceFamilyBounds(
  authored:
    VersionedAuthoredApplicationPackage | VersionedNormalizedApplicationPackage,
): void {
  const diagnostics: CanonicalDiagnostic[] = [];
  for (const [family, maximum] of Object.entries(
    STRUCTURAL_LIMITS_V0.families,
  )) {
    const entries = (authored as unknown as Record<string, unknown>)[family];
    if (!Array.isArray(entries)) continue;
    const count = entries.length;
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
  packageRevision: VersionedNormalizedApplicationPackage,
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
  packageRevision: VersionedNormalizedApplicationPackage,
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
    // One identity, one owner. From v5 the state field and the state ids are
    // owned by the `fields` family, because normalization materializes them
    // there as a field and its enum options; claiming them here as well is
    // what `CANON_ID_DUPLICATE` exists to catch. Below v5 the machine remains
    // their only owner and nothing moves.
    stateMachines: packageRevision.stateMachines.flatMap((entry) =>
      languageHasMaterializedStateFields(packageRevision.languageVersion)
        ? [
            entry.machineId,
            ...entry.transitions.map((transition) => transition.transitionId),
          ]
        : [
            entry.machineId,
            entry.stateField.fieldId,
            ...entry.states.map((state) => state.stateId),
            ...entry.transitions.map((transition) => transition.transitionId),
          ],
    ),
    surfaces: packageRevision.surfaces.flatMap((entry) => [
      entry.surfaceId,
      ...(entry.renderer ? [entry.renderer.rendererId] : []),
      ...entry.slots.map((slot) => slot.slotId),
    ]),
    queries: packageRevision.queries.flatMap((entry) => [
      entry.queryId,
      ...(entry.resolveMatchKeys ?? []).map((matchKey) => matchKey.matchKeyId),
      ...(entry.queryType === 'aggregate'
        ? [
            entry.aggregate.selectionId,
            ...entry.parameters.map((parameter) => parameter.parameterId),
          ]
        : entry.selections.map((selection) => selection.selectionId)),
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
    ...('impactAnalyses' in packageRevision ? { impactAnalyses: [] } : {}),
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

function sortByOwnerOrderAndId<
  T extends { orderKey: number } & Record<K, string>,
  K extends keyof T,
>(entries: readonly T[], ownerId: (entry: T) => string, idKey: K): T[] {
  return [...entries].sort(
    (left, right) =>
      compareCodeUnits(ownerId(left), ownerId(right)) ||
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
    CANON_RELATION_CARDINALITY_UNSUPPORTED:
      'use cardinality manyToOne until another cardinality has executing semantics',
    CANON_SCHEMA_INVALID:
      'use the exported authored schema and canonical example',
    CANON_SURFACE_ARCHETYPE_UNSUPPORTED:
      'use home, list, record, task, or builder',
    CANON_SURFACE_SLOT_UNSUPPORTED:
      'use a named slot declared by the selected archetype',
    CANON_SURFACE_STATUS_ROLE_UNSUPPORTED:
      'use success, attention, blocked, or inProgress',
    CANON_VERSION_UNSUPPORTED: `use a supported version through ${LATEST_LANGUAGE_VERSION}`,
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
    const object = candidate as Record<string, unknown>;
    const kind = typeof object.kind === 'string' ? object.kind : null;
    const identityKey = kind === null ? null : IDENTITY_KEY_BY_KIND[kind];
    if (identityKey && typeof object[identityKey] === 'string') {
      return object[identityKey];
    }
    for (const key of OWNED_IDENTITY_KEYS) {
      if (typeof object[key] === 'string') return object[key];
    }
  }
  return null;
}

const IDENTITY_KEY_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  applicationPackageRevision: 'packageId',
  assertionDefinition: 'assertionId',
  capabilityRequirement: 'capabilityId',
  derivedStateField: 'fieldId',
  entityDefinition: 'entityId',
  enumOption: 'optionId',
  fieldDefinition: 'fieldId',
  moduleDefinition: 'moduleId',
  operationDefinition: 'operationId',
  packageDefinition: 'packageId',
  permissionDefinition: 'permissionId',
  queryDefinition: 'queryId',
  queryAggregateSelection: 'selectionId',
  queryParameterDefinition: 'parameterId',
  querySelection: 'selectionId',
  resolveMatchKey: 'matchKeyId',
  relationDefinition: 'relationId',
  rendererForm: 'rendererId',
  stateDefinition: 'stateId',
  stateMachineDefinition: 'machineId',
  storageMappingDefinition: 'storageMappingId',
  surfaceDefinition: 'surfaceId',
  surfaceSlot: 'slotId',
  transitionDefinition: 'transitionId',
});

const OWNED_IDENTITY_KEYS = Object.freeze([
  'assertionId',
  'capabilityId',
  'entityId',
  'fieldId',
  'matchKeyId',
  'machineId',
  'moduleId',
  'operationId',
  'optionId',
  'packageId',
  'permissionId',
  'parameterId',
  'queryId',
  'relationId',
  'rendererId',
  'selectionId',
  'slotId',
  'stateId',
  'storageMappingId',
  'surfaceId',
  'transitionId',
] as const);

function visitPredicate(
  predicate: VersionedPredicateExpression,
  visit: (
    reference: CanonicalReference,
    path: string,
    expectedKind: 'fieldReference' | 'unitReference',
  ) => void,
  path = '',
): void {
  if (predicate.kind === 'fieldComparisonPredicate') {
    visit(predicate.field, `${path}.field`, 'fieldReference');
    if (predicate.value.kind === 'quantityValue') {
      visit(
        predicate.value.baseUnit,
        `${path}.value.baseUnit`,
        'unitReference',
      );
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

type FieldComparison = Extract<
  VersionedPredicateExpression,
  { kind: 'fieldComparisonPredicate' }
>;
type NormalizedFieldDefinition =
  VersionedNormalizedApplicationPackage['fields'][number];

function visitFieldComparisons(
  predicate: VersionedPredicateExpression,
  visit: (comparison: FieldComparison, path: string) => void,
  path = '',
): void {
  if (predicate.kind === 'fieldComparisonPredicate') {
    visit(predicate, path);
  } else if (predicate.kind === 'notPredicate') {
    visitFieldComparisons(predicate.term, visit, `${path}.term`);
  } else if (
    predicate.kind === 'allPredicate' ||
    predicate.kind === 'anyPredicate'
  ) {
    predicate.terms.forEach((term, index) =>
      visitFieldComparisons(term, visit, `${path}.terms[${index}]`),
    );
  }
}

function validateComparisonValue(
  comparison: FieldComparison,
  field: NormalizedFieldDefinition | undefined,
  path: string,
  objectId: string,
  diagnostics: CanonicalDiagnostic[],
): void {
  if (!field) return;
  const value = comparison.value;
  if (value.kind === 'queryParameterReference') return;
  const expectedKind: Record<FieldType['kind'], CanonicalScalar['kind']> = {
    booleanFieldType: 'booleanValue',
    dateFieldType: 'dateValue',
    dateTimeFieldType: 'dateTimeValue',
    enumFieldType: 'textValue',
    exactDecimalFieldType: 'exactDecimalValue',
    integerFieldType: 'integerValue',
    moneyFieldType: 'moneyValue',
    quantityFieldType: 'quantityValue',
    textFieldType: 'textValue',
    timeFieldType: 'timeValue',
  };
  let valid = value.kind === expectedKind[field.fieldType.kind];
  if (valid) {
    switch (field.fieldType.kind) {
      case 'textFieldType':
        valid =
          value.kind === 'textValue' &&
          [...value.value].length <= field.fieldType.maximumLength;
        break;
      case 'exactDecimalFieldType':
        valid =
          value.kind === 'exactDecimalValue' &&
          decimalFits(
            value.value,
            field.fieldType.precision,
            field.fieldType.scale,
          );
        break;
      case 'moneyFieldType':
        valid =
          value.kind === 'moneyValue' &&
          value.currencyCode === field.fieldType.currencyCode &&
          value.minorUnit === field.fieldType.minorUnit &&
          decimalFits(
            value.value,
            field.fieldType.precision,
            field.fieldType.scale,
          );
        break;
      case 'quantityFieldType':
        valid =
          value.kind === 'quantityValue' &&
          value.baseUnit.kind === 'unitReference' &&
          value.baseUnit.targetId === field.fieldType.baseUnit.targetId &&
          decimalFits(
            value.value,
            field.fieldType.precision,
            field.fieldType.scale,
          );
        break;
      case 'timeFieldType':
        valid =
          value.kind === 'timeValue' &&
          (field.fieldType.precision === 'millisecond'
            ? /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(value.value)
            : /^\d{2}:\d{2}:\d{2}$/.test(value.value));
        break;
      case 'dateTimeFieldType':
        valid =
          value.kind === 'dateTimeValue' &&
          canonicalDateTimePattern(
            field.fieldType.precision,
            field.fieldType.timezoneSemantics,
          ).test(value.value);
        break;
      case 'enumFieldType':
        valid =
          value.kind === 'textValue' &&
          field.fieldType.options.some(
            (option) => option.optionId === value.value,
          );
        break;
      default:
        break;
    }
  }
  if (!valid) {
    diagnostics.push(
      diagnostic(
        'CANON_PREDICATE_VALUE_INVALID',
        path,
        'a field comparison value matches the field type, precision, scale, currency, timezone, or base-unit contract',
        `use ${expectedKind[field.fieldType.kind]} encoded for field ${field.fieldId}`,
        objectId,
      ),
    );
  }
}

function visitQueryParameterReferences(
  predicate: VersionedPredicateExpression,
  visit: (
    reference: QueryParameterReference,
    comparison: FieldComparison,
  ) => void,
): void {
  visitFieldComparisons(predicate, (comparison) => {
    if (comparison.value.kind === 'queryParameterReference') {
      visit(comparison.value, comparison);
    }
  });
}

function decimalFits(value: string, precision: number, scale: number): boolean {
  const unsigned = value.startsWith('-') ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  const integerDigits = integer === '0' ? 0 : integer!.length;
  const totalDigits = Math.max(1, integerDigits + fraction.length);
  return (
    fraction.length <= scale &&
    integerDigits <= precision - scale &&
    totalDigits <= precision
  );
}

function canonicalDateTimePattern(
  precision: 'second' | 'millisecond',
  timezoneSemantics: 'utcInstant' | 'offsetDateTime',
): RegExp {
  const fraction = precision === 'millisecond' ? '\\.\\d{3}' : '';
  const zone = timezoneSemantics === 'utcInstant' ? 'Z' : '[+-]\\d{2}:\\d{2}';
  return new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}${fraction}${zone}$`,
  );
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
