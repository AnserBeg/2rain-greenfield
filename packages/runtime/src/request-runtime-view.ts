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
export const LEGAL_ENTITY_READ_SCOPE_PERMISSION_ID =
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
 * `maximumSupportedVersion` is the HIGHEST floor this runtime can honour. A
 * projection demanding more is refused; one demanding less is served, because a
 * floor is a minimum and support is cumulative.
 *
 * **KEYED BY FAMILY, AND THE PAIR IS THE UNIT — corrected on round-2 review.**
 * The first version of this table keyed on `capabilityId` alone, and the
 * comparison never saw the family. That let a projection **borrow another
 * family's capability**: a surface manifest declaring
 * `northstar.runtime:capability.semantic-model` at floor 1 is self-consistent,
 * survives admission (which only checks the reference and manifest agree with
 * *each other*), finds a known id in this table, and is served -- while the
 * surface floor it actually owed was never compared. A future surface shape
 * needing floor 4 could reach a floor-3 reader that way.
 *
 * The compiler already binds the pair (`runtimeCapabilities` in
 * `packages/compiler/src/projections.ts`). Nothing downstream did. **A
 * capability id is meaningless without the family that must carry it**, so the
 * two are declared together here and compared together below.
 */
export const SUPPORTED_RUNTIME_CAPABILITIES: Readonly<
  Record<
    string,
    { readonly capabilityId: string; readonly maximumSupportedVersion: number }
  >
> = Object.freeze({
  [REQUEST_RUNTIME_PROJECTION_FAMILIES.agent]: {
    capabilityId: 'northstar.runtime:capability.agent-discovery',
    maximumSupportedVersion: 1,
  },
  [REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog]: {
    capabilityId: 'northstar.runtime:capability.semantic-model',
    maximumSupportedVersion: 1,
  },
  [REQUEST_RUNTIME_PROJECTION_FAMILIES.operation]: {
    capabilityId: 'northstar.runtime:capability.operation-catalog',
    maximumSupportedVersion: 1,
  },
  [REQUEST_RUNTIME_PROJECTION_FAMILIES.query]: {
    capabilityId: 'northstar.runtime:capability.query-catalog',
    maximumSupportedVersion: 2,
  },
  [REQUEST_RUNTIME_PROJECTION_FAMILIES.surface]: {
    capabilityId: 'northstar.runtime:capability.surface-manifest',
    // 8 adds declared workspaces and the shared scoped draft document editor.
    // 9 adds picker eligibility and typed Task input presentation.
    // 10 adds declared Lists: columns, saved views, filters, sort and export.
    // 11 adds editor defaults and scoped pickers.
    // 12 adds List progress, open and before-today views and overdue dates.
    // 13 adds List row actions and supplementary (omitted-when-denied) progress.
    // 14 adds record alerts and progression, multi-row Tasks and record
    // columns and links that name a relation of their record.
    // 15 adds composition datasets scoped by a field of their own entity.
    // 16 adds a draft editor's create values.
    // 17 adds List figures, views keeping a band, and Record form references.
    // 18 is WAREHOUSE-MODE's, taken in parallel.
    // 19 adds a Record form's omitted fields and a figure's parent reached
    // through a reference field (LOCATIONS).
    // 20 adds searches through children, figure choices, band cases by an
    // enumeration or against a figure, and Task inputs leaving the record out
    // (CATALOG-EXTRAS).
    // 21 adds a List progress's supply and the views and row actions that
    // keep covered or short rows (SUPPLY-WARNINGS).
    maximumSupportedVersion: 21,
  },
});

/**
 * `null` when this runtime may serve the projection; otherwise a reason naming
 * the family, the capability and BOTH versions, so an operator learns what is
 * missing rather than only that something is wrong.
 *
 * **Takes the FAMILY, not just the requirement — corrected on round-2 review.**
 * Three refusals, in the order they can be established:
 *
 *   1. the family is unknown to this runtime;
 *   2. the family is known but the projection declares a DIFFERENT family's
 *      capability id -- the borrowed-capability bypass;
 *   3. the family and capability match and the demanded floor is too high.
 *
 * (2) is the one the first version could not see. It fails closed in every
 * direction: an unknown family, a mismatched pair, and a non-integer floor are
 * all refusals, because treating any of them as permitted is how a projection
 * serves itself into a reader that cannot honour it.
 */
export function unsupportedRuntimeCapability(
  familyId: string,
  requirement: RuntimeCapabilityRequirement,
  // A SEAM, taking the registry as a parameter rather than closing over it, and
  // the repository has already paid for this lesson: `adoption-selector-seam`
  // records five rounds establishing that "only a seam that takes the choice as
  // a parameter can observe the CHOICE." A comparison that could only ever be
  // called against the live table would be untestable in the one direction that
  // matters -- a supported version LOWER than the demanded floor -- because the
  // live table is, by construction, high enough to serve what ships.
  supported: Readonly<
    Record<
      string,
      {
        readonly capabilityId: string;
        readonly maximumSupportedVersion: number;
      }
    >
  > = SUPPORTED_RUNTIME_CAPABILITIES,
): string | null {
  const entry = Object.hasOwn(supported, familyId)
    ? supported[familyId]
    : undefined;
  if (entry === undefined) {
    return `projection family is unknown to this runtime: ${familyId}`;
  }
  if (requirement.capabilityId !== entry.capabilityId) {
    return `projection family ${familyId} must declare ${entry.capabilityId} and declares ${requirement.capabilityId}`;
  }
  if (!Number.isSafeInteger(requirement.minimumVersion)) {
    return `runtime capability floor is not a safe integer: ${requirement.capabilityId}`;
  }
  if (requirement.minimumVersion > entry.maximumSupportedVersion) {
    return `runtime capability ${requirement.capabilityId} requires version ${String(requirement.minimumVersion)} and this runtime supports ${String(entry.maximumSupportedVersion)}`;
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

/**
 * Provider load refusals that the runtime entry boundary can preserve for its
 * transport consumers. The runtime owns this vocabulary: consumers must not
 * import a concrete persistence provider merely to distinguish an identified
 * refusal from an unavailable loader.
 */
export const REQUEST_RUNTIME_VIEW_REFUSAL_CODES = Object.freeze({
  ACTIVE_POINTER_MISSING: true,
  ACTIVE_RELEASE_NOT_ADMITTED: true,
  ACTIVE_RELEASE_NOT_VISIBLE: true,
  INVALIDATION_AHEAD_OF_AUTHORITY: true,
  INVALIDATION_CONTEXT_MISMATCH: true,
  MALFORMED_RELEASE: true,
  MALFORMED_REQUIRED_PROJECTION: true,
  NULL_ACTIVE_RELEASE: true,
  PIN_CONTEXT_MISMATCH: true,
  POINTER_CHANGED_DURING_LOAD: true,
  POINTER_IDENTITY_CHANGED: true,
  REQUEST_CONTEXT_MISMATCH: true,
  REQUIRED_PROJECTION_DUPLICATE: true,
  REQUIRED_PROJECTION_MISSING: true,
  UNSUPPORTED_RUNTIME_CAPABILITY: true,
} as const);

export type RequestRuntimeViewRefusalCode =
  keyof typeof REQUEST_RUNTIME_VIEW_REFUSAL_CODES;

/** The provider-neutral refusal exposed by authenticated runtime entry. */
export class RequestRuntimeViewRefusalError extends Error {
  override readonly name = 'RequestRuntimeViewRefusalError';

  constructor(readonly code: RequestRuntimeViewRefusalCode) {
    super(`request runtime view load refused: ${code}`);
  }
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
const issuedPolicySubjects = new WeakMap<object, TrustedRequestContext>();
const issuedPolicyDecisionRequests = new WeakMap<
  object,
  TrustedRequestContext
>();
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
  readonly policyVersion: string;

  override readonly name = 'LegalEntityReadScopePolicyDeniedError';

  constructor(legalEntityId: string, policyVersion: string) {
    super(`current policy denied legal-entity read scope ${legalEntityId}`);
    this.legalEntityId = legalEntityId;
    this.policyVersion = policyVersion;
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
    const definitionLoad = startRuntimeDefinitionLoad(this.loader, context);
    const policyRead = this.currentPolicy.readCurrentVersion(subject);
    const [definition, policyEvidence] = await joinRuntimeDefinitionAndPolicy(
      definitionLoad,
      policyRead,
    );
    const view = constructRequestRuntimeView(
      context,
      definition,
      policyEvidence,
    );
    return unitOfWork(view);
  }
}

function startRuntimeDefinitionLoad(
  loader: RequestRuntimeDefinitionLoader,
  context: TrustedRequestContext,
): Promise<LoadedRequestRuntimeDefinition> {
  try {
    return loader.load(context);
  } catch (error) {
    throw runtimeDefinitionFailure(error);
  }
}

/**
 * A two-input join with loader-only rejection translation.
 *
 * Contract controls observe five timing classes: a synchronous loader throw
 * before policy; a synchronous policy throw after loader return but before the
 * join; loader-first handling when both original promises are already rejected;
 * no-wait settlement when either pending promise rejects while its sibling stays
 * pending; and synchronous or asynchronous unit-of-work failure after this join
 * remaining outside loader translation.
 *
 * They do not establish policy-first identity when two pending promises reject
 * in one turn through a post-invocation policy-promise wrapper. That same-turn
 * case is routed as `runtime-refusal-same-turn-precedence` and becomes required
 * before any production-reachable policy-side branch participating in this join
 * can fail, whether caller-supplied or derived here. Fallibility includes a
 * gateway, version read, validation, normalization, adapter, or promise wrapper.
 */
function joinRuntimeDefinitionAndPolicy(
  definitionLoad: Promise<LoadedRequestRuntimeDefinition>,
  policyRead: Promise<CurrentPolicyVersionEvidence>,
): Promise<
  readonly [LoadedRequestRuntimeDefinition, CurrentPolicyVersionEvidence]
> {
  return new Promise((resolve, reject) => {
    let definition!: LoadedRequestRuntimeDefinition;
    let policyEvidence!: CurrentPolicyVersionEvidence;
    let remaining = 2;
    const resolveWhenComplete = (): void => {
      remaining -= 1;
      if (remaining === 0) {
        resolve([definition, policyEvidence]);
      }
    };
    void definitionLoad.then(
      (loaded) => {
        definition = loaded;
        resolveWhenComplete();
      },
      (error: unknown) => {
        reject(runtimeDefinitionFailure(error));
      },
    );
    void policyRead.then(
      (evidence) => {
        policyEvidence = evidence;
        resolveWhenComplete();
      },
      (error: unknown) => {
        reject(error);
      },
    );
  });
}

function runtimeDefinitionFailure(error: unknown): unknown {
  const code = requestRuntimeViewRefusalCode(error);
  if (code !== null) {
    return new RequestRuntimeViewRefusalError(code);
  }
  return error;
}

function requestRuntimeViewRefusalCode(
  error: unknown,
): RequestRuntimeViewRefusalCode | null {
  if (
    !(error instanceof Error) ||
    error.name !== 'RequestRuntimeViewLoadError' ||
    !('code' in error) ||
    typeof error.code !== 'string' ||
    !Object.hasOwn(REQUEST_RUNTIME_VIEW_REFUSAL_CODES, error.code)
  ) {
    return null;
  }
  return error.code as RequestRuntimeViewRefusalCode;
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
  const context = issuedViewContexts.get(view);
  if (!context) {
    throw new RequestRuntimeViewIntegrityError(
      'current policy decision requires an issued request context',
    );
  }
  issuedPolicyDecisionRequests.set(request, context);
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
      throw new LegalEntityReadScopePolicyDeniedError(
        legalEntityId,
        decision.policyVersion,
      );
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
      throw new LegalEntityReadScopePolicyDeniedError(
        legalEntityId,
        decision.policyVersion,
      );
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

export function trustedContextForCurrentPolicySubject(
  subject: CurrentPolicySubject,
): TrustedRequestContext {
  const context = issuedPolicySubjects.get(subject);
  if (!context) {
    throw new RequestRuntimeViewIntegrityError(
      'current policy subject was not issued from trusted request context',
    );
  }
  return context;
}

export function trustedContextForCurrentPolicyDecision(
  request: CurrentPolicyDecisionRequest,
): TrustedRequestContext {
  const context = issuedPolicyDecisionRequests.get(request);
  if (!context) {
    throw new RequestRuntimeViewIntegrityError(
      'current policy decision was not issued from a request runtime view',
    );
  }
  return context;
}

function policySubject(context: CurrentPolicySubject): CurrentPolicySubject {
  const subject = Object.freeze({
    environmentId: context.environmentId,
    principalId: context.principalId,
    tenantId: context.tenantId,
  });
  const trustedContext = isTrustedRequestContext(context)
    ? context
    : issuedViewContexts.get(context);
  if (!trustedContext) {
    throw new RequestRuntimeViewIntegrityError(
      'current policy subject requires trusted request context',
    );
  }
  issuedPolicySubjects.set(subject, trustedContext);
  return subject;
}

function isTrustedRequestContext(
  value: CurrentPolicySubject,
): value is TrustedRequestContext {
  try {
    assertTrustedRequestContext(value);
    return true;
  } catch {
    return false;
  }
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
