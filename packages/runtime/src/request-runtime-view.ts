import {
  assertTrustedRequestContext,
  type AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
  type UntrustedRequestInput,
} from './request-context.js';

export const REQUEST_RUNTIME_VIEW_VERSION =
  'northstar.request-runtime-view/v1' as const;
export const PINNED_RUNTIME_CONTEXT_VERSION =
  'northstar.pinned-runtime-context/v1' as const;
export const PIN_VALIDATION_RESULT_VERSION =
  'northstar.pin-validation-result/v1' as const;
export const CURRENT_POLICY_DECISION_VERSION =
  'northstar.current-policy-decision/v1' as const;
export const LEGAL_ENTITY_READ_SCOPE_VERSION =
  'northstar.legal-entity-read-scope/v1' as const;

const LEGAL_ENTITY_READ_SCOPE_POLICY_INPUT_VERSION =
  'northstar.legal-entity-read-scope-policy-input/v1' as const;
const LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID =
  'northstar.runtime:permission.legal-entity-read-scope' as const;

export const REQUEST_RUNTIME_PROJECTION_FAMILIES = Object.freeze({
  agent: 'northstar.compiler:projection-family.agent-discovery',
  catalog: 'northstar.compiler:projection-family.semantic-model',
  operation: 'northstar.compiler:projection-family.operation-catalog',
  query: 'northstar.compiler:projection-family.query-catalog',
  surface: 'northstar.compiler:projection-family.surface-manifest',
} as const);

export type RequestRuntimeProjectionFamily =
  (typeof REQUEST_RUNTIME_PROJECTION_FAMILIES)[keyof typeof REQUEST_RUNTIME_PROJECTION_FAMILIES];

export type ImmutableJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly ImmutableJsonValue[]
  | { readonly [key: string]: ImmutableJsonValue };

/**
 * What a compiled projection DEMANDS of the reader that serves it.
 *
 * Declared structurally here rather than imported from the compiler: this
 * package depends on `@north-star/canonical-model` alone, and a runtime that
 * imported the compiler to learn what it must support would be deriving its own
 * capability from the thing making the demand.
 */
export interface RuntimeCapabilityRequirement {
  readonly capabilityId: string;
  readonly minimumVersion: number;
}

export interface RuntimeProjection<
  TFamily extends RequestRuntimeProjectionFamily =
    RequestRuntimeProjectionFamily,
> {
  readonly artifactRoot: string;
  readonly familyId: TFamily;
  readonly instanceId: string;
  readonly payload: ImmutableJsonValue;
  readonly payloadSchemaVersion: string;
  /**
   * RETAINED, and it was previously DROPPED. Found by `profile-v2-adoption`'s
   * round-1 review: the compiler emits a capability floor on every projection
   * reference, and this interface omitted it, so the demand was erased from the
   * runtime representation before any consumer could honour or refuse it --
   * ADR-0041's accepted-and-ignored state, reached by omission rather than by
   * coercion.
   *
   * **OPTIONAL, and the optionality is a declared limitation rather than a
   * design preference.** The real serving path -- `PostgresRequestRuntimeViewService`
   * -- always populates it, and the refusal that closes the defect runs there
   * unconditionally, before the payload is decoded. Optionality therefore costs
   * nothing on the path that serves a tenant.
   *
   * It is optional because making it REQUIRED fails to typecheck in **16 files**,
   * two of which (`apps/web/test/browser/surface-data-binding.spec.ts` and
   * `test/integration/surface-data-binding.test.ts`) are held by the live
   * `form-wire-semantics` lane, and one of which
   * (`packages/postgres-provider/src/release-verification-service.ts`) sits
   * outside this packet's granted bridge. Those are hand-built fixtures and a
   * verification path that never serves a request.
   *
   * **What this leaves open:** a future constructor can omit the field and no
   * type error says so. Closing that is a mechanical sweep of the 16 sites and
   * belongs in its own packet -- see `runtime-capability-floor-unenforced`.
   * **What it does NOT leave open:** a projection reaching a tenant without its
   * floor being compared, which is the defect the review found.
   */
  readonly requiredRuntimeCapability?: RuntimeCapabilityRequirement;
  readonly semanticDigest: string;
}

/**
 * What THIS runtime can actually serve, per capability.
 *
 * **INDEPENDENT OF PAYLOAD-SCHEMA SUPPORT BY CONSTRUCTION, and that independence
 * is the whole point of the table.** A registry derived from the supported
 * payload-schema versions would restate what the parser already accepts: green
 * forever, unable to refuse anything, which is precisely the failure the version
 * floor exists to avoid. The two answer different questions -- the payload
 * schema asks *can I parse these bytes*, the capability asks *may I serve what
 * they mean*.
 *
 * **What would have to change for the two to disagree, written down so a later
 * reader can check it rather than trust it.** They disagree whenever a
 * projection changes meaning without changing payload shape, or changes shape in
 * a way an older parser still accepts. Both have already happened on the surface
 * family:
 *
 *   - floor 1 -> 2: `navigation` is ADDITIVE, so a v0 payload parser still
 *     parsed the bytes -- and silently reconstructed unreachable overflow, a
 *     WRONG render rather than a parse failure.
 *   - floor 2 -> 3: `fields` is likewise additive and parses fine when ignored,
 *     but a reader that drops it renders declared enums, dates and booleans as
 *     bare text boxes.
 *
 * In both cases payload-schema support said yes while capability support had to
 * say no. That is why this table is AUTHORED, not derived.
 *
 * Each value is the HIGHEST floor this runtime can honour. A projection
 * demanding more is refused; one demanding less is served, because a floor is a
 * minimum and support is cumulative.
 */
export const SUPPORTED_RUNTIME_CAPABILITIES: Readonly<Record<string, number>> =
  Object.freeze({
    'northstar.runtime:capability.agent-discovery': 1,
    'northstar.runtime:capability.operation-catalog': 1,
    'northstar.runtime:capability.query-catalog': 1,
    'northstar.runtime:capability.semantic-model': 1,
    // 3 because this runtime understands `fields` (per-field kinds) and renders
    // a control per declared kind. Raised from 2 by `profile-v2-adoption`, the
    // packet that made the compiler start emitting them.
    'northstar.runtime:capability.surface-manifest': 3,
  });

/**
 * `null` when this runtime may serve the projection; otherwise a reason naming
 * the capability and BOTH versions, so an operator learns what is missing rather
 * than only that something is wrong.
 *
 * Fails closed on an UNKNOWN capability id. A capability this runtime has never
 * heard of is not one it supports, and treating unknown as permitted is exactly
 * how a new projection family would serve itself into an unaware reader.
 */
export function unsupportedRuntimeCapability(
  requirement: RuntimeCapabilityRequirement,
  // A SEAM, taking the registry as a parameter rather than closing over it, and
  // the repository has already paid for this lesson: `adoption-selector-seam`
  // records five rounds establishing that "only a seam that takes the choice as
  // a parameter can observe the CHOICE." A comparison that could only ever be
  // called against the live table would be untestable in the one direction that
  // matters -- a supported version LOWER than the demanded floor -- because the
  // live table is, by construction, high enough to serve what ships.
  supported: Readonly<Record<string, number>> = SUPPORTED_RUNTIME_CAPABILITIES,
): string | null {
  const supportedVersion = Object.hasOwn(supported, requirement.capabilityId)
    ? supported[requirement.capabilityId]
    : undefined;
  if (supportedVersion === undefined) {
    return `runtime capability is unknown to this runtime: ${requirement.capabilityId}`;
  }
  if (!Number.isSafeInteger(requirement.minimumVersion)) {
    return `runtime capability floor is not a safe integer: ${requirement.capabilityId}`;
  }
  if (requirement.minimumVersion > supportedVersion) {
    return `runtime capability ${requirement.capabilityId} requires version ${String(requirement.minimumVersion)} and this runtime supports ${String(supportedVersion)}`;
  }
  return null;
}

export interface LoadedRequestRuntimeDefinition {
  readonly environmentId: string;
  readonly pointer: {
    readonly fence: number;
    readonly pointerId: string;
  };
  readonly projections: {
    readonly agent: RuntimeProjection<
      typeof REQUEST_RUNTIME_PROJECTION_FAMILIES.agent
    >;
    readonly catalog: RuntimeProjection<
      typeof REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog
    >;
    readonly operation: RuntimeProjection<
      typeof REQUEST_RUNTIME_PROJECTION_FAMILIES.operation
    >;
    readonly query: RuntimeProjection<
      typeof REQUEST_RUNTIME_PROJECTION_FAMILIES.query
    >;
    readonly surface: RuntimeProjection<
      typeof REQUEST_RUNTIME_PROJECTION_FAMILIES.surface
    >;
  };
  readonly release: {
    readonly contentHash: string;
    readonly releaseId: string;
  };
  readonly tenantId: string;
}

/** The provider port accepts only an issued trusted request context. */
export interface RequestRuntimeDefinitionLoader {
  load(context: TrustedRequestContext): Promise<LoadedRequestRuntimeDefinition>;
}

export interface CurrentPolicySubject {
  readonly environmentId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface CurrentPolicyVersionEvidence {
  readonly policyVersion: string;
}

export interface CurrentPolicyDecisionRequest extends CurrentPolicySubject {
  readonly decisionInput: ImmutableJsonValue;
  readonly entryPolicyVersion: string;
  readonly permissionId: string;
  readonly pinnedReleaseContentHash: string;
  readonly pinnedReleaseId: string;
  readonly pointerFence: number;
  readonly pointerId: string;
}

export interface CurrentPolicyDecision {
  readonly decision: 'ALLOW' | 'DENY';
  readonly decisionVersion: typeof CURRENT_POLICY_DECISION_VERSION;
  readonly policyVersion: string;
}

/**
 * Temporary T-01/G2 seam. It owns current deny-capable application policy;
 * release approval/executor epochs are deliberately not reused here.
 */
export interface CurrentPolicyGateway {
  authorize(
    request: CurrentPolicyDecisionRequest,
  ): Promise<CurrentPolicyDecision>;
  readCurrentVersion(
    subject: CurrentPolicySubject,
  ): Promise<CurrentPolicyVersionEvidence>;
}

export interface RequestRuntimeView {
  readonly entryPolicyVersion: string;
  readonly environmentId: string;
  readonly pointer: {
    readonly fence: number;
    readonly pointerId: string;
  };
  readonly principalId: string;
  readonly projections: LoadedRequestRuntimeDefinition['projections'];
  readonly release: {
    readonly contentHash: string;
    readonly releaseId: string;
  };
  readonly requestId: string;
  readonly schemaVersion: typeof REQUEST_RUNTIME_VIEW_VERSION;
  readonly tenantId: string;
}

/**
 * An immutable, policy-approved business scope for one issued request view.
 * Runtime object identity, not these copyable fields, is the capability seal.
 */
export interface LegalEntityReadScope {
  readonly legalEntityIds: readonly string[];
  readonly policyVersion: string;
  readonly requestId: string;
  readonly schemaVersion: typeof LEGAL_ENTITY_READ_SCOPE_VERSION;
}

export interface PinnedRuntimeContextEnvelope {
  readonly entryPolicyVersion: string;
  readonly environmentId: string;
  readonly pointerFence: number;
  readonly pointerId: string;
  readonly principalId: string;
  readonly releaseContentHash: string;
  readonly releaseId: string;
  readonly schemaVersion: typeof PINNED_RUNTIME_CONTEXT_VERSION;
  readonly tenantId: string;
}

export type PinValidationResult =
  | {
      readonly resultVersion: typeof PIN_VALIDATION_RESULT_VERSION;
      readonly status: 'CURRENT';
    }
  | {
      readonly reason: 'POINTER_GENERATION_CHANGED';
      readonly resultVersion: typeof PIN_VALIDATION_RESULT_VERSION;
      readonly status: 'STALE_RELEASE_REPLAN';
    };

const issuedViews = new WeakSet<object>();
const issuedViewContexts = new WeakMap<object, TrustedRequestContext>();
const issuedLegalEntityReadScopes = new WeakMap<object, RequestRuntimeView>();
const sha256Pattern = /^[0-9a-f]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RequestRuntimeViewIntegrityError extends Error {
  override readonly name = 'RequestRuntimeViewIntegrityError';
}

export class InvalidLegalEntityReadScopeSelectionError extends Error {
  readonly code = 'LEGAL_ENTITY_READ_SCOPE_SELECTION_INVALID' as const;
  override readonly name = 'InvalidLegalEntityReadScopeSelectionError';
}

export class LegalEntityReadScopeIntegrityError extends Error {
  readonly code = 'LEGAL_ENTITY_READ_SCOPE_INTEGRITY_INVALID' as const;
  override readonly name = 'LegalEntityReadScopeIntegrityError';

  constructor(
    message: string,
    readonly subjectId: string | null = null,
  ) {
    super(message);
  }
}

export class LegalEntityReadScopePolicyDeniedError extends Error {
  readonly code = 'LEGAL_ENTITY_READ_SCOPE_POLICY_DENIED' as const;
  readonly legalEntityId: string;

  override readonly name = 'LegalEntityReadScopePolicyDeniedError';

  constructor(legalEntityId: string) {
    super(`current policy denied legal-entity read scope ${legalEntityId}`);
    this.legalEntityId = legalEntityId;
  }
}

/**
 * Authenticated entry composition. One invocation constructs exactly one view
 * and passes it explicitly to exactly one unit of work.
 */
export class AuthenticatedRequestRuntimeEntryAdapter {
  constructor(
    private readonly requestEntry: AuthenticatedRequestEntryAdapter,
    private readonly loader: RequestRuntimeDefinitionLoader,
    private readonly currentPolicy: CurrentPolicyGateway,
  ) {}

  async run<T>(
    request: UntrustedRequestInput,
    unitOfWork: (view: RequestRuntimeView) => Promise<T> | T,
  ): Promise<T> {
    const context = await this.requestEntry.enter(request);
    assertTrustedRequestContext(context);
    const subject = policySubject(context);
    const [definition, policyEvidence] = await Promise.all([
      this.loader.load(context),
      this.currentPolicy.readCurrentVersion(subject),
    ]);
    const view = constructRequestRuntimeView(
      context,
      definition,
      policyEvidence,
    );
    return unitOfWork(view);
  }
}

/** Every call reaches the live gateway again; no ALLOW is stored in the view. */
export async function authorizeCurrentPolicy(
  gateway: CurrentPolicyGateway,
  view: RequestRuntimeView,
  permissionId: string,
  decisionInput: ImmutableJsonValue,
): Promise<CurrentPolicyDecision> {
  assertRequestRuntimeView(view);
  assertNonBlank(permissionId, 'permissionId');
  const request = Object.freeze({
    decisionInput: cloneImmutableJson(decisionInput, '$.decisionInput'),
    entryPolicyVersion: view.entryPolicyVersion,
    environmentId: view.environmentId,
    permissionId,
    pinnedReleaseContentHash: view.release.contentHash,
    pinnedReleaseId: view.release.releaseId,
    pointerFence: view.pointer.fence,
    pointerId: view.pointer.pointerId,
    principalId: view.principalId,
    tenantId: view.tenantId,
  });
  const decision = await gateway.authorize(request);
  if (
    decision.decisionVersion !== CURRENT_POLICY_DECISION_VERSION ||
    (decision.decision !== 'ALLOW' && decision.decision !== 'DENY')
  ) {
    throw new RequestRuntimeViewIntegrityError(
      'current policy gateway returned an invalid decision contract',
    );
  }
  assertNonBlank(decision.policyVersion, 'policyVersion');
  return Object.freeze({ ...decision });
}

/**
 * Issues one nonempty authorized set. Each member receives its own live policy
 * decision so a future restrictive policy kernel can deny individual entities.
 */
export async function issueLegalEntityReadScope(
  gateway: CurrentPolicyGateway,
  view: RequestRuntimeView,
  requestedLegalEntityIds: readonly string[],
): Promise<LegalEntityReadScope> {
  assertRequestRuntimeView(view);
  if (!Array.isArray(requestedLegalEntityIds)) {
    throw new InvalidLegalEntityReadScopeSelectionError(
      'legal-entity read scope must be requested as an array',
    );
  }
  if (
    requestedLegalEntityIds.length === 0 ||
    requestedLegalEntityIds.some(
      (legalEntityId) =>
        typeof legalEntityId !== 'string' || !uuidPattern.test(legalEntityId),
    )
  ) {
    throw new InvalidLegalEntityReadScopeSelectionError(
      'legal-entity read scope must contain one or more UUIDs',
    );
  }
  const legalEntityIds = [
    ...new Set(
      requestedLegalEntityIds.map((legalEntityId) =>
        legalEntityId.toLowerCase(),
      ),
    ),
  ].sort();

  let policyVersion: string | undefined;
  for (const legalEntityId of legalEntityIds) {
    const decision = await authorizeCurrentPolicy(
      gateway,
      view,
      LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID,
      legalEntityReadScopePolicyInput(view, legalEntityId),
    );
    if (decision.decision === 'DENY') {
      throw new LegalEntityReadScopePolicyDeniedError(legalEntityId);
    }
    if (
      policyVersion !== undefined &&
      policyVersion !== decision.policyVersion
    ) {
      throw new LegalEntityReadScopeIntegrityError(
        'current policy version changed while legal-entity scope was issued',
      );
    }
    policyVersion = decision.policyVersion;
  }

  if (policyVersion === undefined) {
    throw new LegalEntityReadScopeIntegrityError(
      'legal-entity read scope was not backed by a policy decision',
    );
  }
  const scope: LegalEntityReadScope = Object.freeze({
    legalEntityIds: Object.freeze(legalEntityIds),
    policyVersion,
    requestId: view.requestId,
    schemaVersion: LEGAL_ENTITY_READ_SCOPE_VERSION,
  });
  issuedLegalEntityReadScopes.set(scope, view);
  return scope;
}

/** Copying the visible fields never copies the issued capability. */
export function legalEntityIdsFromIssuedReadScope(
  value: unknown,
  view: RequestRuntimeView,
): readonly string[] {
  assertRequestRuntimeView(view);
  if (
    typeof value !== 'object' ||
    value === null ||
    issuedLegalEntityReadScopes.get(value) !== view
  ) {
    throw new LegalEntityReadScopeIntegrityError(
      'legal-entity read scope must be issued for this request runtime view',
    );
  }
  const scope = value as LegalEntityReadScope;
  if (
    scope.schemaVersion !== LEGAL_ENTITY_READ_SCOPE_VERSION ||
    scope.requestId !== view.requestId ||
    !Array.isArray(scope.legalEntityIds) ||
    scope.legalEntityIds.length === 0 ||
    scope.legalEntityIds.some(
      (legalEntityId) =>
        typeof legalEntityId !== 'string' || !uuidPattern.test(legalEntityId),
    )
  ) {
    throw new LegalEntityReadScopeIntegrityError(
      'issued legal-entity read scope has an invalid version or shape',
    );
  }
  return scope.legalEntityIds;
}

/** Issuance is evidence only; every execution rechecks every member live. */
export async function verifyLegalEntityReadScope(
  gateway: CurrentPolicyGateway,
  value: unknown,
  view: RequestRuntimeView,
  subjectId: string,
): Promise<LegalEntityReadScope> {
  let legalEntityIds: readonly string[];
  try {
    legalEntityIds = legalEntityIdsFromIssuedReadScope(value, view);
  } catch (error) {
    if (error instanceof LegalEntityReadScopeIntegrityError) {
      throw new LegalEntityReadScopeIntegrityError(error.message, subjectId);
    }
    throw error;
  }
  const scope = value as LegalEntityReadScope;
  assertNonBlank(scope.policyVersion, 'policyVersion');

  let decisionPolicyVersion: string | undefined;
  for (const legalEntityId of legalEntityIds) {
    const decision = await authorizeCurrentPolicy(
      gateway,
      view,
      LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID,
      legalEntityReadScopePolicyInput(view, legalEntityId),
    );
    if (decision.decision === 'DENY') {
      throw new LegalEntityReadScopePolicyDeniedError(legalEntityId);
    }
    if (
      decisionPolicyVersion !== undefined &&
      decisionPolicyVersion !== decision.policyVersion
    ) {
      throw new LegalEntityReadScopeIntegrityError(
        'current policy version changed while legal-entity scope was verified',
        subjectId,
      );
    }
    decisionPolicyVersion = decision.policyVersion;
  }

  const currentPolicy = await gateway.readCurrentVersion(policySubject(view));
  assertNonBlank(currentPolicy.policyVersion, 'policyVersion');
  if (decisionPolicyVersion !== currentPolicy.policyVersion) {
    throw new LegalEntityReadScopeIntegrityError(
      'current policy version changed while legal-entity scope was verified',
      subjectId,
    );
  }
  if (currentPolicy.policyVersion !== scope.policyVersion) {
    throw new LegalEntityReadScopeIntegrityError(
      'issued legal-entity read scope policy is no longer current',
      subjectId,
    );
  }
  return scope;
}

export function createPinnedRuntimeContextEnvelope(
  view: RequestRuntimeView,
): PinnedRuntimeContextEnvelope {
  assertRequestRuntimeView(view);
  return Object.freeze({
    entryPolicyVersion: view.entryPolicyVersion,
    environmentId: view.environmentId,
    pointerFence: view.pointer.fence,
    pointerId: view.pointer.pointerId,
    principalId: view.principalId,
    releaseContentHash: view.release.contentHash,
    releaseId: view.release.releaseId,
    schemaVersion: PINNED_RUNTIME_CONTEXT_VERSION,
    tenantId: view.tenantId,
  });
}

export function parsePinnedRuntimeContextEnvelope(
  serialized: string,
): PinnedRuntimeContextEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new RequestRuntimeViewIntegrityError(
      'pinned runtime context is not valid JSON',
    );
  }
  if (!isRecord(value)) {
    throw new RequestRuntimeViewIntegrityError(
      'pinned runtime context must be an object',
    );
  }
  const exactKeys = [
    'entryPolicyVersion',
    'environmentId',
    'pointerFence',
    'pointerId',
    'principalId',
    'releaseContentHash',
    'releaseId',
    'schemaVersion',
    'tenantId',
  ];
  if (
    Object.keys(value).sort().join('\0') !== exactKeys.sort().join('\0') ||
    value.schemaVersion !== PINNED_RUNTIME_CONTEXT_VERSION ||
    !Number.isSafeInteger(value.pointerFence) ||
    Number(value.pointerFence) < 0
  ) {
    throw new RequestRuntimeViewIntegrityError(
      'pinned runtime context has an invalid version or shape',
    );
  }
  for (const key of exactKeys.filter(
    (key) => key !== 'pointerFence' && key !== 'schemaVersion',
  )) {
    assertNonBlank(value[key], key);
  }
  if (!sha256Pattern.test(String(value.releaseContentHash))) {
    throw new RequestRuntimeViewIntegrityError(
      'releaseContentHash must be a lowercase SHA-256 digest',
    );
  }
  return Object.freeze({
    entryPolicyVersion: String(value.entryPolicyVersion),
    environmentId: String(value.environmentId),
    pointerFence: Number(value.pointerFence),
    pointerId: String(value.pointerId),
    principalId: String(value.principalId),
    releaseContentHash: String(value.releaseContentHash),
    releaseId: String(value.releaseId),
    schemaVersion: PINNED_RUNTIME_CONTEXT_VERSION,
    tenantId: String(value.tenantId),
  });
}

export function assertRequestRuntimeView(
  value: unknown,
): asserts value is RequestRuntimeView {
  if (typeof value !== 'object' || value === null || !issuedViews.has(value)) {
    throw new TypeError(
      'request runtime view must be issued by AuthenticatedRequestRuntimeEntryAdapter',
    );
  }
}

/**
 * Supplies the original issued context only to the semantic gateways' generic
 * executor port. Identity is never reconstructed from operation or query input.
 */
export function trustedContextForRequestRuntimeView(
  view: RequestRuntimeView,
): TrustedRequestContext {
  assertRequestRuntimeView(view);
  const context = issuedViewContexts.get(view);
  if (!context) {
    throw new RequestRuntimeViewIntegrityError(
      'issued request runtime view is missing its trusted context binding',
    );
  }
  assertTrustedRequestContext(context);
  return context;
}

function constructRequestRuntimeView(
  context: TrustedRequestContext,
  definition: LoadedRequestRuntimeDefinition,
  policyEvidence: CurrentPolicyVersionEvidence,
): RequestRuntimeView {
  assertDefinitionIdentity(context, definition);
  assertNonBlank(policyEvidence.policyVersion, 'policyVersion');
  const projections = Object.freeze({
    agent: cloneProjection(
      definition.projections.agent,
      REQUEST_RUNTIME_PROJECTION_FAMILIES.agent,
    ),
    catalog: cloneProjection(
      definition.projections.catalog,
      REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog,
    ),
    operation: cloneProjection(
      definition.projections.operation,
      REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
    ),
    query: cloneProjection(
      definition.projections.query,
      REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
    ),
    surface: cloneProjection(
      definition.projections.surface,
      REQUEST_RUNTIME_PROJECTION_FAMILIES.surface,
    ),
  });
  const view: RequestRuntimeView = Object.freeze({
    entryPolicyVersion: policyEvidence.policyVersion,
    environmentId: context.environmentId,
    pointer: Object.freeze({ ...definition.pointer }),
    principalId: context.principalId,
    projections,
    release: Object.freeze({ ...definition.release }),
    requestId: context.requestId,
    schemaVersion: REQUEST_RUNTIME_VIEW_VERSION,
    tenantId: context.tenantId,
  });
  issuedViews.add(view);
  issuedViewContexts.set(view, context);
  return view;
}

function assertDefinitionIdentity(
  context: TrustedRequestContext,
  definition: LoadedRequestRuntimeDefinition,
): void {
  if (
    definition.tenantId !== context.tenantId ||
    definition.environmentId !== context.environmentId
  ) {
    throw new RequestRuntimeViewIntegrityError(
      'loaded definition identity does not match trusted request context',
    );
  }
  if (
    !Number.isSafeInteger(definition.pointer.fence) ||
    definition.pointer.fence < 0
  ) {
    throw new RequestRuntimeViewIntegrityError(
      'loaded pointer fence must be a nonnegative safe integer',
    );
  }
  for (const [name, value] of Object.entries({
    pointerId: definition.pointer.pointerId,
    releaseId: definition.release.releaseId,
  })) {
    assertNonBlank(value, name);
  }
  if (!sha256Pattern.test(definition.release.contentHash)) {
    throw new RequestRuntimeViewIntegrityError(
      'loaded release content hash must be a lowercase SHA-256 digest',
    );
  }
}

function cloneProjection<TFamily extends RequestRuntimeProjectionFamily>(
  projection: RuntimeProjection<TFamily>,
  expectedFamily: TFamily,
): RuntimeProjection<TFamily> {
  if (projection.familyId !== expectedFamily) {
    throw new RequestRuntimeViewIntegrityError(
      `loaded projection family mismatch: expected ${expectedFamily}`,
    );
  }
  for (const [name, value] of Object.entries({
    artifactRoot: projection.artifactRoot,
    instanceId: projection.instanceId,
    payloadSchemaVersion: projection.payloadSchemaVersion,
    semanticDigest: projection.semanticDigest,
  })) {
    assertNonBlank(value, name);
  }
  if (
    !sha256Pattern.test(projection.artifactRoot) ||
    !sha256Pattern.test(projection.semanticDigest)
  ) {
    throw new RequestRuntimeViewIntegrityError(
      'projection digests must be lowercase SHA-256 values',
    );
  }
  return Object.freeze({
    artifactRoot: projection.artifactRoot,
    familyId: expectedFamily,
    instanceId: projection.instanceId,
    payload: cloneImmutableJson(projection.payload, '$.projection.payload'),
    payloadSchemaVersion: projection.payloadSchemaVersion,
    // Carried through the clone, not re-derived. This function is the copy that
    // strips everything not named here, so omitting the requirement would
    // re-introduce the exact drop the field was retained to close -- one layer
    // further in, and invisible to the provider's own check.
    //
    // The spread is conditional so an absent requirement stays ABSENT rather
    // than becoming a materialized `undefined` key: a hand-built fixture that
    // never had a floor must not acquire one here, and a reader must be able to
    // tell "no floor was carried" from "a floor of nothing".
    ...(projection.requiredRuntimeCapability === undefined
      ? {}
      : {
          requiredRuntimeCapability: Object.freeze({
            capabilityId: projection.requiredRuntimeCapability.capabilityId,
            minimumVersion: projection.requiredRuntimeCapability.minimumVersion,
          }),
        }),
    semanticDigest: projection.semanticDigest,
  });
}

function cloneImmutableJson(value: unknown, path: string): ImmutableJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry, index) =>
        cloneImmutableJson(entry, `${path}[${index}]`),
      ),
    );
  }
  if (isRecord(value)) {
    const clone: Record<string, ImmutableJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = cloneImmutableJson(entry, `${path}.${key}`);
    }
    return Object.freeze(clone);
  }
  throw new RequestRuntimeViewIntegrityError(
    `${path} must contain only immutable JSON values`,
  );
}

function policySubject(context: CurrentPolicySubject): CurrentPolicySubject {
  return Object.freeze({
    environmentId: context.environmentId,
    principalId: context.principalId,
    tenantId: context.tenantId,
  });
}

function legalEntityReadScopePolicyInput(
  view: RequestRuntimeView,
  legalEntityId: string,
): ImmutableJsonValue {
  return Object.freeze({
    kind: 'legalEntityReadScopePolicyInput',
    legalEntityId,
    requestId: view.requestId,
    schemaVersion: LEGAL_ENTITY_READ_SCOPE_POLICY_INPUT_VERSION,
  });
}

function assertNonBlank(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestRuntimeViewIntegrityError(`${name} must not be blank`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
