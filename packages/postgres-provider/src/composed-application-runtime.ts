import { servingPointersSql } from './verified-release-generation.js';
import { VALUATION_CAPABILITY_ID } from '../../domain/src/inventory/valuation.js';
import {
  inventoryValuationReadModel,
  commercialReadModelWithInventoryCost,
} from './inventory-valuation-read-model.js';
import { FULFILLMENT_CAPABILITY_ID } from './fulfillment.js';
import { COMMERCIAL_CAPABILITY_ID } from '../../domain/src/sales/definition.js';
import { fulfillmentReadModel } from './fulfillment-read-model.js';
import { receivingReadModel } from './receiving-read-model.js';
import { RECEIVING_CAPABILITY_ID } from './goods-receipt.js';
import { createHash, randomUUID } from 'node:crypto';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  canonicalize,
  canonicalizeAndHash,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import type {
  CompileSuccess,
  ContentAddressedArtifact,
  StorageTransitionEnvelope,
} from '@north-star/compiler';
import {
  PROJECTION_FAMILY_IDS,
  STORAGE_TRANSITION_ENVELOPE_VERSION,
  diffCompiledReleases,
} from '@north-star/compiler';
import {
  renderCompiledDiff,
  type AcknowledgementInput,
} from '@north-star/customization';
import {
  CustomizationLineageError,
  readCustomizationLineage,
} from './customization-lineage.js';
import type { UpgradePreparation } from './customization-service.js';
import {
  COMPILER_TRANSITION_FACTS_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
  EXECUTOR_APPLIED_STATE_EVIDENCE_V2_VERSION,
  INITIAL_ACTIVATION_BINDING_VERSION,
  RELEASE_DIFF_BINDING_VERSION,
  SYSTEM_EXECUTION_PRINCIPAL,
  TRANSITION_COMPATIBILITY_POLICY_VERSION,
  TRANSITION_COMPATIBILITY_POLICY_V2_VERSION,
  TRANSITION_PREPARATION_RECEIPT_VERSION,
  TRANSITION_PREPARATION_RECEIPT_V2_VERSION,
  type MintedUuid,
} from '@north-star/platform-runtime';
import {
  ObservabilityMetrics,
  monotonicMilliseconds,
} from '@north-star/observability';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticateRequest,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '@north-star/runtime';
import { AuthenticatedRequestRuntimeEntryAdapter } from '@north-star/runtime/request-runtime-view';
import pg from 'pg';
import { meterPoolStatements } from './request-work-meter.js';

import {
  SemanticOperationGateway,
  parsePinnedOperationCatalog,
  SemanticOperationMediationAuthority,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SemanticQueryGateway,
  type RegisteredQueryLatencyInstrumentation,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  createRegisteredCapabilityExecutors,
  registeredCapabilityIdsFromOperationCatalog,
  type PinnedCapabilityProjection,
  type PostgresCapabilityOperationExecutorFactory,
} from './capability-operation-executor-factory.js';
import { loadMigrations, runMigrations } from './migrations.js';
import {
  PostgresModuleRuntimeInterpreter,
  type ModuleProviderErrorMapping,
} from './module-runtime-interpreter.js';
import { PostgresModuleStorageMaterializer } from './module-storage-materializer.js';
import { PostgresReleaseActivationService } from './release-activation-service.js';
import { PostgresReleaseApprovalService } from './release-approval-service.js';
import { PostgresImmutableReleaseRepository } from './release-repository.js';
import {
  authorizeReverseTransitionIfApplicable,
  refuseReverseTransition,
  type ReleaseReverseTransitionAuthorization,
} from './release-reverse-transition-policy.js';
import {
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
} from './release-verification-service.js';
import { PostgresRequestRuntimeViewService } from './request-runtime-view-service.js';
import {
  detachedFromReadSnapshot,
  withoutReadSnapshot,
  withReadSnapshot,
  withTrustedRequestTransaction,
} from './request-context.js';
import {
  CURRENT_POLICY_RUNTIME_BINDINGS,
  PostgresCurrentPolicyGateway,
  PostgresSemanticQueryDenialRecorder,
  currentPolicyBindingsFromPermissions,
  type CurrentPolicyPermissionBinding,
} from './current-policy.js';
import { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';
import { localDemoActor } from '../../runtime/src/local-demo-actor.js';

const compiledApplicationVersion =
  'northstar.web:compiled-application-release/v1' as const;
const compiledApplicationLineageVersion =
  'northstar.web:compiled-application-release/v2' as const;
const capabilitySupportVersion = 'northstar.capability-support/v1' as const;
const rendererVersion = 'northstar.release-diff-renderer/v1' as const;
const viewSchemaVersion = 'northstar.release-diff-view/v1' as const;
const freshTenantIntermediateAdmissionVersion =
  'northstar.fresh-tenant-intermediate-release-admission/v1' as const;
export const FRESH_TENANT_INSTALL_EVIDENCE_VERSION =
  'northstar.fresh-tenant-install-evidence/v1' as const;

export type ComposedApplicationRuntimeOptions = (
  | {
      readonly compiledApplication: unknown;
      readonly loadCompiledApplication?: never;
    }
  | {
      readonly compiledApplication?: never;
      readonly loadCompiledApplication: () => Promise<unknown>;
    }
) & {
  /** Deterministic observation seam for the non-serving active-pointer window. */
  readonly afterFreshTenantIntermediateActivation?: (
    observation: FreshTenantIntermediateActivationObservation,
  ) => Promise<void>;
  readonly customization?: {
    readonly acknowledgement: AcknowledgementInput;
    readonly firstPartyAuthored: Readonly<Record<string, unknown>>;
  };
  /** Verified non-demo identity integration. Absence fails request entry closed. */
  readonly authenticateRequest?: AuthenticateRequest;
  readonly capabilityOperationExecutorFactories?: readonly PostgresCapabilityOperationExecutorFactory[];
  readonly databaseUrl: string;
  readonly environmentSlug?: string;
  readonly inventoryScopeProvisioning?: InventoryScopeProvisioning;
  readonly metrics?: ObservabilityMetrics;
  /** Explicit local-only fixture identity and full-release grant provisioning. */
  readonly localDemoIdentity?: true;
  /**
   * The elapsed-time source the composed read ingress is timed from. It exists
   * so a test can drive a composition across a real ladder boundary without
   * sleeping (AGENTS.md §6). Production never passes it; the default is the
   * process monotonic clock, whose liveness is gated separately, because a
   * controlled clock here proves the wiring carries a duration and says
   * nothing about whether the real source moves.
   */
  readonly monotonicMilliseconds?: () => number;
  readonly migrationsDirectory: string;
  readonly providerErrorMappings: readonly ModuleProviderErrorMapping[];
  readonly releaseSelection?: Readonly<{
    readonly kind: 'rollback';
    readonly targetReleaseRoot: string;
  }>;
  readonly tenantSlug: string;
};

export interface FreshTenantIntermediateActivationObservation {
  readonly lineageOrdinal: number;
  readonly releaseId: MintedUuid;
  readonly releaseRoot: string;
  loadActiveRuntimeDefinition(): Promise<void>;
}

export interface InventoryScopeProvisioning {
  readonly adjustmentApprovalThreshold: string | null;
  readonly adjustmentReasonRequirement: 'codeOnly' | 'codeAndNarrative';
  readonly businessDayBoundary: string;
  readonly configurationVersion: number;
  readonly correctionApprovalThreshold: string | null;
  readonly correctionReasonRequirement: 'codeOnly' | 'codeAndNarrative';
  readonly countApprovalThreshold: string | null;
  readonly countReasonRequirement: 'codeOnly' | 'codeAndNarrative';
  readonly entityCode: string;
  readonly entityName: string;
  readonly legalEntityId: string;
  readonly maximumBackdateDays: number;
  readonly negativeStock: 'allow' | 'allowWithFlag' | 'reject';
  readonly rebaselineApprovalThreshold: string | null;
  readonly rebaselineReasonRequirement: 'codeOnly' | 'codeAndNarrative';
  readonly timeZone: string;
  readonly transferApprovalThreshold: string | null;
  readonly transferReasonRequirement: 'codeOnly' | 'codeAndNarrative';
}

export interface ComposedApplicationRuntime {
  readonly customizationUpgrade: UpgradePreparation | null;
  readonly activeReleaseId: MintedUuid;
  readonly entry: AuthenticatedRequestRuntimeEntryAdapter;
  readonly freshTenantInstallEvidence: FreshTenantInstallEvidence | null;
  readonly identity: AuthenticatedIdentity;
  readonly identityMode: 'FAIL_CLOSED' | 'LOCAL_DEMO' | 'VERIFIED_EXTERNAL';
  readonly localDemoActors:
    readonly { key: 'buyer' | 'manager'; label: string }[] | null;
  /** Registered-query ladder evidence for this runtime; see ADR-0032 §2. */
  readonly metrics: ObservabilityMetrics;
  readonly operationGateway: SemanticOperationGateway;
  readonly operationMediation: SemanticOperationMediationAuthority;
  readonly queryGateway: SemanticQueryGateway;
  readonly releaseRoot: string;
  readonly triggerEnabledDuringActivation: true;
  /**
   * SPEED-1: run one page's reads in one read-only snapshot on the runtime
   * pool (`withReadSnapshot`); writes never join it.
   */
  readSnapshot<T>(
    work: (finishReads: () => Promise<void>) => Promise<T>,
    options?: { readonly retry?: boolean },
  ): Promise<T>;
  close(): Promise<void>;
}

export interface FreshTenantInstallEvidence {
  readonly appliedTransitions: readonly Readonly<{
    readonly sourceReleaseRoot: string;
    readonly targetReleaseRoot: string;
  }>[];
  readonly nonServingReleasesWithoutScenarioExecution: readonly Readonly<{
    readonly releaseId: MintedUuid;
    readonly releaseRoot: string;
  }>[];
  readonly schemaVersion: typeof FRESH_TENANT_INSTALL_EVIDENCE_VERSION;
  readonly servingRelease: Readonly<{
    readonly releaseId: MintedUuid;
    readonly releaseRoot: string;
    readonly scenarioCount: number;
  }>;
}

interface ParsedApplicationRelease {
  readonly application: ParsedRelease;
  readonly applications: readonly ParsedRelease[];
  readonly bootstrap: ParsedRelease;
}

export interface ParsedRelease {
  readonly compiled: CompileSuccess;
  readonly normalizedDefinitionBytes: Uint8Array;
}

export interface PersistedReleaseIdentity {
  readonly evidenceId: MintedUuid;
  readonly releaseId: MintedUuid;
  readonly revisionId: MintedUuid;
}

export interface ScopeIdentities {
  readonly manager: AuthenticatedIdentity;
  readonly approver: AuthenticatedIdentity;
  readonly authorityOperatorId: string;
  readonly runtime: AuthenticatedIdentity;
  readonly system: AuthenticatedIdentity;
}

export interface PointerState {
  readonly fence: number;
  readonly pointerId: MintedUuid;
  readonly releaseId: MintedUuid | null;
}

interface FreshTenantPreparationBinding {
  readonly installId: MintedUuid;
  readonly lineageOrdinal: number;
}

/**
 * Provider-owned assembly for the local composed product. Serving code passes
 * a checked-in compiler result; it never compiles, mutates a release pointer,
 * or executes module SQL itself.
 */
export async function createComposedApplicationRuntime(
  options: ComposedApplicationRuntimeOptions,
): Promise<ComposedApplicationRuntime> {
  if (options.localDemoIdentity && options.authenticateRequest) {
    throw new TypeError(
      'local demo identity and verified request authentication are mutually exclusive',
    );
  }
  if (options.tenantSlug.trim() === '') {
    throw new TypeError('tenantSlug must not be blank');
  }
  const adminPool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 2,
  });
  adminPool.on('error', () => undefined);

  let runtimePool: pg.Pool | undefined;
  let materializerPool: pg.Pool | undefined;
  let modulePool: pg.Pool | undefined;
  let evidencePool: pg.Pool | undefined;
  try {
    await migrate(adminPool, options.migrationsDirectory);
    const identities = await ensureScope(
      adminPool,
      options.tenantSlug,
      options.environmentSlug ?? 'production',
    );

    runtimePool = rolePool(options.databaseUrl, 'north_star_runtime', 6);
    materializerPool = rolePool(
      options.databaseUrl,
      'north_star_module_materializer',
      2,
    );
    modulePool = rolePool(options.databaseUrl, 'north_star_module_runtime', 2);
    // Denial evidence is written on its own connections (SPEED-1).
    evidencePool = rolePool(options.databaseUrl, 'north_star_runtime', 2);

    const runtimeContext = await trustedContext(identities.runtime);
    const selected = await withReleaseScopeLock(
      adminPool,
      identities.runtime,
      (admin) =>
        selectBootRelease(
          options,
          identities,
          admin,
          runtimePool!,
          materializerPool!,
          modulePool!,
          runtimeContext,
        ),
    );
    const { serving, freshTenantInstallEvidence } = selected;
    const metrics = options.metrics ?? new ObservabilityMetrics();
    if (options.localDemoIdentity) {
      await provisionLocalDemoReleaseAuthorization(
        adminPool,
        identities,
        serving.normalizedDefinitionBytes,
      );
    }
    let customizationUpgrade: UpgradePreparation | null = selected.diagnostic;
    if (selected.prepareReplay) {
      const { PostgresCustomizationService, recordUpgradeRefusal } =
        await import('./customization-service.js');
      try {
        customizationUpgrade = options.customization
          ? await new PostgresCustomizationService(
              {
                adminPool,
                runtimePool,
                materializerPool,
                modulePool,
                identities,
              },
              {
                ...options.customization,
                compiledApplication: selected.compiledApplication,
                ...(options.localDemoIdentity
                  ? { localDemoIdentity: true as const }
                  : {}),
                providerErrorMappings: options.providerErrorMappings,
                capabilityOperationExecutorFactories:
                  options.capabilityOperationExecutorFactories ?? [],
              },
            ).prepareUpgrade()
          : await recordUpgradeRefusal(runtimePool, runtimeContext, {
              status: 'refused',
              code: 'CUSTOMIZE_UPGRADE_UNAVAILABLE',
              message: 'This runtime cannot prepare a platform upgrade.',
              sourceReleaseId: serving.releaseId,
              baseReleaseRoot: selected.baseReleaseRoot!,
            });
      } catch {
        const refusal = {
          status: 'refused' as const,
          code: 'CUSTOMIZE_UPGRADE_FAILED',
          message:
            'The upgrade could not be prepared. The verified release is still live.',
        };
        customizationUpgrade = await recordUpgradeRefusal(
          runtimePool,
          runtimeContext,
          {
            ...refusal,
            sourceReleaseId: serving.releaseId,
            baseReleaseRoot: selected.baseReleaseRoot!,
          },
        ).catch(() => refusal);
      }
    }

    const actorIssuer = humanActorIssuer();
    const interpreter = new PostgresModuleRuntimeInterpreter(
      runtimePool,
      actorIssuer,
      options.providerErrorMappings,
    );
    const operationMediation = new SemanticOperationMediationAuthority();
    const denialRecorder = new PostgresSemanticQueryDenialRecorder(
      runtimePool,
      actorIssuer,
      evidencePool,
    );
    // ADR-0032 §2 admits a loading treatment only above a *measured* threshold,
    // so the read ingress is composed with its measurement rather than gaining
    // one later: an uninstrumented composition would make the ladder an
    // assertion again.
    const latency = composedRegisteredQueryLatencyInstrumentation(
      metrics,
      options.monotonicMilliseconds,
    );
    const readModels = {
      [FULFILLMENT_CAPABILITY_ID]: fulfillmentReadModel,
      [COMMERCIAL_CAPABILITY_ID]: commercialReadModelWithInventoryCost,
      [VALUATION_CAPABILITY_ID]: inventoryValuationReadModel,
      // A receipt's lines with what each can still reverse (ORDER-PARITY).
      [RECEIVING_CAPABILITY_ID]: receivingReadModel,
    };
    // Release-scoped state -- the policy bindings of a release's permissions
    // and the capability executors pinned to its id, root and projections --
    // is built per release and chosen per request by the release the request's
    // view was issued against. An activation by another process (the
    // customize command, the Customize screen) is served by the next request
    // without a restart (CUSTOMIZE).
    const policyFor = (release: ServingRelease) =>
      new PostgresCurrentPolicyGateway(
        runtimePool!,
        currentPolicyBindingsFromPermissions(
          parseNormalizedApplicationPackageJson(
            release.normalizedDefinitionBytes,
          ).permissions,
        ),
        parsePinnedOperationCatalog(
          release.projection(PROJECTION_FAMILY_IDS.operationCatalog).payload,
        ),
      );
    const bootPolicy = policyFor(serving);
    // The runtime's one read ingress: a capability executor's read-back goes
    // through it like every other read, routed by its view's release.
    const routed: { queryGateway?: SemanticQueryGateway } = {};
    const buildServing = (
      release: ServingRelease,
      policy: PostgresCurrentPolicyGateway = policyFor(release),
    ): ReleaseServing => {
      const queryGateway = new SemanticQueryGateway(
        policy,
        interpreter,
        undefined,
        undefined,
        latency,
        denialRecorder,
        readModels,
      );
      const capabilityExecutors = createRegisteredCapabilityExecutors(
        options.capabilityOperationExecutorFactories ?? [],
        registeredCapabilityIdsFromOperationCatalog(
          release.projection(PROJECTION_FAMILY_IDS.operationCatalog).payload,
        ),
        Object.freeze({
          actorIssuer,
          currentInstant: () => new Date().toISOString(),
          pool: runtimePool!,
          projection: release.projection,
          queryGateway: routed.queryGateway ?? queryGateway,
          releaseContentHash: release.releaseRoot,
          releaseId: release.releaseId,
        }),
      );
      return Object.freeze({
        operationGateway: new SemanticOperationGateway(
          policy,
          interpreter,
          operationMediation,
          undefined,
          capabilityExecutors,
        ),
        policy,
        queryGateway,
      });
    };
    const servingFor = releaseServingRoute(
      (releaseId) =>
        loadServingRelease(
          runtimePool!,
          runtimeContext,
          releaseId as MintedUuid,
        ),
      (release) => buildServing(release),
    );
    const policy = bootPolicy;
    const queryGateway = new ReleaseRoutingQueryGateway(servingFor, policy);
    routed.queryGateway = queryGateway;
    servingFor.publish(serving.releaseId, buildServing(serving, bootPolicy));
    const operationGateway = new ReleaseRoutingOperationGateway(
      servingFor,
      policy,
      operationMediation,
    );
    const entry = new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(
        options.localDemoIdentity
          ? async (request) =>
              localDemoActor(request.headers?.cookie) === 'manager'
                ? identities.manager
                : identities.runtime
          : (options.authenticateRequest ?? (async () => null)),
      ),
      new PostgresRequestRuntimeViewService(runtimePool),
      policy,
    );
    const pools = [
      runtimePool,
      materializerPool,
      modulePool,
      evidencePool,
      adminPool,
    ];
    let closed = false;

    return Object.freeze({
      customizationUpgrade,
      activeReleaseId: serving.releaseId,
      async close() {
        if (closed) return;
        closed = true;
        await Promise.all(pools.map((pool) => pool.end()));
      },
      entry,
      freshTenantInstallEvidence,
      identity: identities.runtime,
      localDemoActors: options.localDemoIdentity
        ? Object.freeze([
            { key: 'buyer' as const, label: 'Buyer' },
            { key: 'manager' as const, label: 'Manager' },
          ])
        : null,
      identityMode: options.localDemoIdentity
        ? ('LOCAL_DEMO' as const)
        : options.authenticateRequest
          ? ('VERIFIED_EXTERNAL' as const)
          : ('FAIL_CLOSED' as const),
      metrics,
      operationGateway,
      operationMediation,
      queryGateway,
      readSnapshot: <T>(
        work: (finishReads: () => Promise<void>) => Promise<T>,
        snapshotOptions?: { readonly retry?: boolean },
      ) => withReadSnapshot(runtimePool!, work, snapshotOptions),
      releaseRoot: serving.releaseRoot,
      triggerEnabledDuringActivation: true as const,
    });
  } catch (error) {
    await Promise.all(
      [runtimePool, materializerPool, modulePool, evidencePool, adminPool]
        .filter((pool): pool is pg.Pool => pool !== undefined)
        .map((pool) => pool.end().catch(() => undefined)),
    );
    throw error;
  }
}

async function selectBootRelease(
  options: ComposedApplicationRuntimeOptions,
  identities: ScopeIdentities,
  admin: pg.PoolClient,
  runtimePool: pg.Pool,
  materializerPool: pg.Pool,
  modulePool: pg.Pool,
  runtimeContext: TrustedRequestContext,
) {
  const initialPointer = await readPointer(runtimePool, runtimeContext);
  const previous = await readVerifiedServing(runtimePool, runtimeContext);
  if (previous && options.inventoryScopeProvisioning)
    await provisionInventoryScopeOnClient(
      admin,
      identities.runtime,
      previous.releaseRoot,
      options.inventoryScopeProvisioning,
    );
  let baseReleaseRoot: string | null = null;
  try {
    if (
      initialPointer.releaseId &&
      previous &&
      previous.fence !== initialPointer.fence
    )
      throw new Error('the latest swap awaits activation recovery');
    await ensureAuthority(admin, identities);
    const compiledApplication = options.loadCompiledApplication
      ? await options.loadCompiledApplication()
      : options.compiledApplication;
    const releases = parseCompiledApplication(compiledApplication);
    baseReleaseRoot = releases.application.compiled.releaseRoot;
    const releaseLineage = releasesForLineage(releases);
    for (let index = 1; index < releaseLineage.length; index += 1) {
      assertExactCompiledTransition(
        releaseLineage[index - 1]!,
        releaseLineage[index]!,
      );
    }
    const approverContext = await trustedContext(identities.approver);
    const systemContext = await trustedContext(identities.system);
    if (!previous && options.inventoryScopeProvisioning)
      await provisionInventoryScopeOnClient(
        admin,
        identities.runtime,
        releases.application.compiled.releaseRoot,
        options.inventoryScopeProvisioning,
      );
    const bootstrapIdentity = await ensurePersistedRelease(
      runtimePool,
      runtimeContext,
      releases.bootstrap,
      null,
    );
    const applicationIdentities: PersistedReleaseIdentity[] = [];
    let parentRevisionId = bootstrapIdentity.revisionId;
    for (const application of releases.applications) {
      const identity = await ensurePersistedRelease(
        runtimePool,
        runtimeContext,
        application,
        parentRevisionId,
      );
      applicationIdentities.push(identity);
      parentRevisionId = identity.revisionId;
    }

    const activation = new PostgresReleaseActivationService(runtimePool);
    let pointer = initialPointer;
    const lineage = [bootstrapIdentity, ...applicationIdentities];
    const candidateInstallId = minted(
      stableUuid(
        `fresh-tenant-install:${runtimeContext.tenantId}:${runtimeContext.environmentId}:${releases.application.compiled.releaseRoot}`,
      ),
    );
    const freshInstall =
      pointer.releaseId === null ||
      (await freshTenantInstallIsIncomplete(
        runtimePool,
        runtimeContext,
        candidateInstallId,
        pointer.releaseId,
        lineage.at(-1)!.releaseId,
      ));
    const installId = freshInstall ? candidateInstallId : null;
    if (pointer.releaseId === null) {
      await ensureFreshTenantIntermediateReleaseAdmitted(
        runtimePool,
        runtimeContext,
        candidateInstallId,
        0,
        bootstrapIdentity,
        releaseLineage[0]!,
        null,
      );
      await assertExactSwapTriggerEnabled(admin);
      const attemptId = await approveInitialRelease(
        runtimePool,
        runtimeContext,
        approverContext,
        pointer,
        bootstrapIdentity,
        releases.bootstrap.compiled,
        { installId: candidateInstallId, lineageOrdinal: 0 },
      );
      const activated = await activateWithExactSwapTrigger(
        admin,
        activation,
        systemContext,
        attemptId,
      );
      if (activated.status !== 'SWAPPED_VERIFIED') {
        throw new Error(
          `bootstrap activation did not verify: ${activated.status}`,
        );
      }
      pointer = await readPointer(runtimePool, runtimeContext);
      if (
        pointer.releaseId !== bootstrapIdentity.releaseId ||
        pointer.pointerId !== activated.pointerId ||
        pointer.fence !== activated.fence
      )
        throw new Error('bootstrap generation changed before readback');
      await observeFreshTenantIntermediateActivation(
        options,
        runtimePool,
        runtimeContext,
        0,
        bootstrapIdentity,
        releases.bootstrap.compiled.releaseRoot,
      );
    }

    const pointerLineageIndex = lineage.findIndex(
      (identity) => identity.releaseId === pointer.releaseId,
    );
    // A tenant customization activated on the lineage tip is served as it is:
    // the first-party lineage has nothing to advance (CUSTOMIZE).
    const tenantServing =
      pointerLineageIndex < 0 && pointer.releaseId !== null
        ? await loadActiveTenantCustomization(
            runtimePool,
            runtimeContext,
            pointer.releaseId,
          )
        : null;
    if (pointerLineageIndex < 0 && !tenantServing) {
      throw new Error(
        'the active pointer names a release outside this composed application lineage',
      );
    }
    if (tenantServing && options.releaseSelection?.kind === 'rollback') {
      refuseReverseTransition(
        'ROLLBACK_TARGET_NOT_IMMEDIATE_PREDECESSOR',
        'the active release is a tenant customization; roll it back with corepack pnpm customize rollback',
      );
    }
    const activeLineageIndex = tenantServing
      ? lineage.length - 1
      : pointerLineageIndex;
    if (
      !tenantServing &&
      (!freshInstall || activeLineageIndex === lineage.length - 1)
    ) {
      await ensureReleaseAdmitted(
        runtimePool,
        runtimeContext,
        lineage[activeLineageIndex]!,
        releaseLineage[activeLineageIndex]!,
        options.providerErrorMappings,
        options.capabilityOperationExecutorFactories ?? [],
      );
    }
    const materializer = new PostgresModuleStorageMaterializer(
      materializerPool,
      modulePool,
    );
    let servingLineageIndex = activeLineageIndex;
    if (options.releaseSelection?.kind === 'rollback') {
      const targetIndex = releaseLineage.findIndex(
        (release) =>
          release.compiled.releaseRoot ===
          options.releaseSelection?.targetReleaseRoot,
      );
      if (targetIndex < 1 || targetIndex !== activeLineageIndex - 1) {
        refuseReverseTransition(
          'ROLLBACK_TARGET_NOT_IMMEDIATE_PREDECESSOR',
          'rollback target must be the immediate prior immutable application release',
        );
      }
      const source = releaseLineage[activeLineageIndex]!;
      const target = releaseLineage[targetIndex]!;
      const targetIdentity = lineage[targetIndex]!;
      await ensureReleaseAdmitted(
        runtimePool,
        runtimeContext,
        targetIdentity,
        target,
        options.providerErrorMappings,
        options.capabilityOperationExecutorFactories ?? [],
      );
      const reverseAuthorization = await withTrustedRequestTransaction(
        runtimePool,
        runtimeContext,
        async (client) =>
          authorizeReverseTransitionIfApplicable(client, runtimeContext, {
            expectedPointerId: pointer.pointerId,
            expectedFence: pointer.fence,
            sourceReleaseId: lineage[activeLineageIndex]!.releaseId,
            targetReleaseId: targetIdentity.releaseId,
          }),
      );
      if (reverseAuthorization === null) {
        // ADR-0047 §6. A profile-only edge: both releases compile the SAME
        // package revision under DIFFERENT compiler-semantic profiles, so
        // `ensurePersistedRelease` reused one revision row and the revision
        // graph has no edge to reverse even though the release lineage does.
        // The index check above already passed, so the target IS the immediate
        // predecessor -- borrowing that code here would misname the cause and
        // send an operator hunting the wrong fault (ADR-0046).
        //
        // BOTH facts are observed, because shared revision alone does not
        // establish the profile as the difference. Compilation identity also
        // folds in the expected active release, the dependency closure and the
        // limits, so a same-revision SAME-profile successor is constructible;
        // it has no revision-parent edge either, and naming it a profile-only
        // edge would be the same misnaming in a new place.
        const activeProfileVersion =
          source.compiled.bundle.releaseManifest.compilerSemanticProfileVersion;
        const targetProfileVersion =
          target.compiled.bundle.releaseManifest.compilerSemanticProfileVersion;
        if (
          targetIdentity.revisionId ===
            lineage[activeLineageIndex]!.revisionId &&
          targetProfileVersion !== activeProfileVersion
        ) {
          refuseReverseTransition(
            'ROLLBACK_ACROSS_PROFILE_ONLY_EDGE',
            `rollback target is the immediate predecessor and shares its package revision, but was compiled under a different compiler-semantic profile (${targetProfileVersion} to ${activeProfileVersion}): the release lineage advances across this edge while the revision lineage does not, so there is no reverse revision edge to authorize`,
          );
        }
        refuseReverseTransition(
          'ROLLBACK_TARGET_NOT_IMMEDIATE_PREDECESSOR',
          'rollback target does not reverse an exact compiled lineage edge',
        );
      }
      await assertExactSwapTriggerEnabled(admin);
      const attemptId = await approveReleaseWithoutStorageTransition(
        runtimePool,
        runtimeContext,
        approverContext,
        pointer,
        source,
        targetIdentity,
        target.compiled,
        releaseDiffBinding(source, target, 'reverse'),
        reverseAuthorization,
      );
      const activated = await activateWithExactSwapTrigger(
        admin,
        activation,
        systemContext,
        attemptId,
      );
      if (activated.status !== 'SWAPPED_VERIFIED') {
        throw new Error(
          `composed release rollback did not verify: ${activated.status}`,
        );
      }
      pointer = await readPointer(runtimePool, runtimeContext);
      if (
        pointer.releaseId !== targetIdentity.releaseId ||
        pointer.pointerId !== activated.pointerId ||
        pointer.fence !== activated.fence
      ) {
        throw new Error('composed release rollback selected the wrong target');
      }
      servingLineageIndex = targetIndex;
    } else {
      for (
        let targetIndex = activeLineageIndex + 1;
        targetIndex < lineage.length;
        targetIndex += 1
      ) {
        const source = releaseLineage[targetIndex - 1]!;
        const target = releaseLineage[targetIndex]!;
        const targetIdentity = lineage[targetIndex]!;
        const transition = assertExactCompiledTransition(source, target);
        await assertExactSwapTriggerEnabled(admin);
        const generationId = minted(randomUUID());
        const preparationId = minted(randomUUID());
        let attemptId: MintedUuid;
        const servingTarget = targetIndex === lineage.length - 1;
        if (transition.elements.length === 0) {
          if (!freshInstall || servingTarget) {
            await ensureReleaseAdmitted(
              runtimePool,
              runtimeContext,
              targetIdentity,
              target,
              options.providerErrorMappings,
              options.capabilityOperationExecutorFactories ?? [],
            );
          } else {
            await ensureFreshTenantIntermediateReleaseAdmitted(
              runtimePool,
              runtimeContext,
              candidateInstallId,
              targetIndex,
              targetIdentity,
              target,
              source.compiled.releaseRoot,
            );
          }
          attemptId = await approveReleaseWithoutStorageTransition(
            runtimePool,
            runtimeContext,
            approverContext,
            pointer,
            source,
            targetIdentity,
            target.compiled,
            releaseDiffBinding(source, target),
            undefined,
            freshInstall && !servingTarget
              ? { installId: candidateInstallId, lineageOrdinal: targetIndex }
              : undefined,
          );
        } else {
          const prepared = await materializer.prepare({
            context: runtimeContext,
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            generationId,
            initiatedBy: runtimeContext.principalId,
            preparationId,
            targetReleaseId: targetIdentity.releaseId,
          });
          if (!freshInstall || servingTarget) {
            await ensureReleaseAdmitted(
              runtimePool,
              runtimeContext,
              targetIdentity,
              target,
              options.providerErrorMappings,
              options.capabilityOperationExecutorFactories ?? [],
            );
          } else {
            await ensureFreshTenantIntermediateReleaseAdmitted(
              runtimePool,
              runtimeContext,
              candidateInstallId,
              targetIndex,
              targetIdentity,
              target,
              source.compiled.releaseRoot,
            );
          }
          attemptId = await approveModuleRelease(
            runtimePool,
            runtimeContext,
            approverContext,
            pointer,
            targetIdentity,
            target.compiled,
            prepared,
            preparationId,
            releaseDiffBinding(source, target),
            freshInstall && !servingTarget
              ? { installId: candidateInstallId, lineageOrdinal: targetIndex }
              : undefined,
          );
          const executed = await materializer.executeApprovedAttempt({
            activationAttemptId: attemptId,
            context: runtimeContext,
            coordinatorId: minted(randomUUID()),
            generationId,
          });
          if (executed.disposition !== 'READY_TO_SWAP') {
            throw new Error(
              `module materialization did not become ready: ${executed.disposition}`,
            );
          }
        }
        const activated = await activateWithExactSwapTrigger(
          admin,
          activation,
          systemContext,
          attemptId,
        );
        if (activated.status !== 'SWAPPED_VERIFIED') {
          throw new Error(
            `composed release activation did not verify: ${activated.status}`,
          );
        }
        pointer = await readPointer(runtimePool, runtimeContext);
        if (
          pointer.releaseId !== targetIdentity.releaseId ||
          pointer.pointerId !== activated.pointerId ||
          pointer.fence !== activated.fence
        ) {
          throw new Error(
            'composed release activation selected the wrong target',
          );
        }
        servingLineageIndex = targetIndex;
        if (freshInstall && !servingTarget) {
          await observeFreshTenantIntermediateActivation(
            options,
            runtimePool,
            runtimeContext,
            targetIndex,
            targetIdentity,
            target.compiled.releaseRoot,
          );
        }
      }
    }
    await assertExactSwapTriggerEnabled(admin);
    const applicationIdentity = lineage[servingLineageIndex]!;
    const applicationRelease = releaseLineage[servingLineageIndex]!;
    const freshTenantInstallEvidence = installId
      ? await persistFreshTenantInstallEvidence(
          runtimePool,
          runtimeContext,
          installId,
          lineage,
          releaseLineage,
          applicationIdentity,
          applicationRelease,
        )
      : null;

    const serving =
      tenantServing ??
      servingReleaseFromParsed(
        applicationIdentity.releaseId,
        applicationRelease,
      );
    const verified = await readVerifiedServing(runtimePool, runtimeContext);
    if (
      !verified ||
      verified.releaseId !== serving.releaseId ||
      verified.fence !== pointer.fence
    )
      throw new Error(
        'the selected release has no verified serving generation',
      );
    await reconcileInventoryScopeToPointer(admin, identities.runtime, verified);
    return {
      serving,
      freshTenantInstallEvidence,
      prepareReplay:
        !!tenantServing &&
        (!!options.customization ||
          tenantServing.baseReleaseId !== lineage.at(-1)!.releaseId),
      baseReleaseRoot: releases.application.compiled.releaseRoot,
      diagnostic: null,
      compiledApplication,
    };
  } catch (error) {
    if (!previous || options.releaseSelection?.kind === 'rollback') throw error;
    const verified = await readVerifiedServing(runtimePool, runtimeContext);
    if (!verified) throw error;
    const serving = await loadServingRelease(
      runtimePool,
      runtimeContext,
      verified.releaseId,
    );
    await reconcileInventoryScopeToPointer(admin, identities.runtime, verified);
    const refusal = {
      status: 'refused' as const,
      code: 'CUSTOMIZE_UPGRADE_FAILED',
      message:
        'The proposed platform release could not be activated. The verified release is still live.',
    };
    const { recordUpgradeRefusal } = await import('./customization-service.js');
    const diagnostic =
      baseReleaseRoot && /^[a-f0-9]{64}$/u.test(baseReleaseRoot)
        ? await recordUpgradeRefusal(runtimePool, runtimeContext, {
            ...refusal,
            baseReleaseRoot,
            sourceReleaseId: verified.releaseId,
          }).catch(() => refusal)
        : refusal;
    return {
      serving,
      prepareReplay: false,
      freshTenantInstallEvidence: null,
      diagnostic,
      compiledApplication: null,
      baseReleaseRoot,
    };
  }
}

/** One release as the serving runtime needs it, from the lineage or the database. */
interface ServingRelease {
  readonly normalizedDefinitionBytes: Uint8Array;
  readonly projection: (familyId: string) => PinnedCapabilityProjection;
  readonly releaseId: MintedUuid;
  readonly releaseRoot: string;
}

interface ReleaseServing {
  readonly operationGateway: SemanticOperationGateway;
  readonly policy: PostgresCurrentPolicyGateway;
  readonly queryGateway: SemanticQueryGateway;
}

function servingReleaseFromParsed(
  releaseId: MintedUuid,
  release: ParsedRelease,
): ServingRelease {
  return Object.freeze({
    normalizedDefinitionBytes: release.normalizedDefinitionBytes,
    projection: (familyId: string) =>
      projectionBinding(release.compiled, familyId),
    releaseId,
    releaseRoot: release.compiled.releaseRoot,
  });
}

/** A registered release read back from its immutable rows. */
async function loadServingRelease(
  pool: pg.Pool,
  context: TrustedRequestContext,
  releaseId: MintedUuid,
): Promise<ServingRelease> {
  const repository = new PostgresImmutableReleaseRepository(pool);
  const persisted = await repository.getTenantRelease(context, releaseId);
  if (!persisted) {
    throw new Error(`release ${releaseId} is not registered for serving`);
  }
  const revision = await repository.getAppPackageRevision(
    context,
    persisted.release.appPackageRevisionId,
  );
  if (!revision) {
    throw new Error(`release ${releaseId} has no visible package revision`);
  }
  const manifest = persisted.artifacts.find(
    (artifact) =>
      artifact.artifactKind === 'releaseManifest' &&
      artifact.contentHash === persisted.release.contentHash,
  );
  if (!manifest) {
    throw new Error(`release ${releaseId} has no release manifest artifact`);
  }
  const compiled = {
    bundle: {
      artifacts: persisted.artifacts.map((artifact) => ({
        ...artifact,
        kind: 'contentAddressedArtifact' as const,
      })),
      releaseManifest: JSON.parse(
        new TextDecoder().decode(manifest.canonicalBytes),
      ) as unknown,
    },
    releaseRoot: persisted.release.contentHash,
  } as unknown as CompileSuccess;
  return Object.freeze({
    normalizedDefinitionBytes: revision.desiredState,
    projection: (familyId: string) => projectionBinding(compiled, familyId),
    releaseId,
    releaseRoot: persisted.release.contentHash,
  });
}

/** Resolve the active tenant release before attempting any replay. */
async function loadActiveTenantCustomization(
  pool: pg.Pool,
  context: TrustedRequestContext,
  releaseId: MintedUuid,
): Promise<(ServingRelease & { baseReleaseId: MintedUuid | null }) | null> {
  const chain = await withTrustedRequestTransaction(pool, context, (client) =>
    readCustomizationLineage(client, { ...context, releaseId }),
  ).catch(async (error: unknown) => {
    if (
      !(error instanceof CustomizationLineageError) ||
      error.active?.provenance !== 'tenantAuthored' ||
      (await unprovenLivePointer(pool, context)) !== null
    )
      throw error;
    // The registered tenant release has its own serving artifacts. An invalid
    // upgrade edge refuses replay, independently of this verified pointer.
    return null;
  });
  if (chain && chain[0]?.provenance !== 'tenantAuthored') return null;
  return {
    ...(await loadServingRelease(pool, context, releaseId)),
    baseReleaseId: chain?.at(-1)?.release_id ?? null,
  };
}

/**
 * The local demo's grants for one release (CUSTOMIZE: a tenant release's new
 * permissions bind to the same full-release roles the first-party ones do).
 */
export async function provisionLocalDemoReleaseAuthorization(
  adminPool: AdminQueryable,
  identities: ScopeIdentities,
  normalizedDefinitionBytes: Uint8Array,
): Promise<void> {
  const bindings = [
    ...currentPolicyBindingsFromPermissions(
      parseNormalizedApplicationPackageJson(normalizedDefinitionBytes)
        .permissions,
    ),
    {
      action: 'author',
      permissionId: 'northstar.runtime:permission.customize_author',
      resourceId: 'northstar.runtime:customization.application',
    },
  ];
  await provisionLocalDemoAuthorization(
    adminPool,
    identities.runtime,
    bindings.filter(
      (binding) =>
        !binding.permissionId.endsWith(':permission.purchase_order_approve') &&
        !/:permission\.purchasing_settings_(?:create|update|archive|restore)$/u.test(
          binding.permissionId,
        ),
    ),
  );
  await provisionLocalDemoAuthorization(
    adminPool,
    identities.manager,
    bindings,
    'local-demo-manager',
  );
}

/**
 * Each release's serving gateways, built once: at once when loaded, else the
 * one pending load every request waits on. The load runs detached from any
 * page's read snapshot and turn (SPEED-1): it is shared, so it must never
 * queue behind one page's work.
 */
export function releaseServingRoute<TRelease, TServing>(
  load: (releaseId: string) => Promise<TRelease>,
  build: (release: TRelease) => TServing,
): ((releaseId: string) => TServing | Promise<TServing>) & {
  publish(releaseId: string, serving: TServing): void;
} {
  const pending = new Map<string, Promise<TServing>>();
  const loaded = new Map<string, TServing>();
  const route = (releaseId: string): TServing | Promise<TServing> => {
    const ready = loaded.get(releaseId);
    if (ready !== undefined) return ready;
    const known = pending.get(releaseId);
    if (known) return known;
    const loading = detachedFromReadSnapshot(() => load(releaseId)).then(
      (release) => {
        const serving = build(release);
        loaded.set(releaseId, serving);
        return serving;
      },
    );
    pending.set(releaseId, loading);
    loading.catch(() => pending.delete(releaseId));
    return loading;
  };
  return Object.assign(route, {
    publish(releaseId: string, serving: TServing) {
      loaded.set(releaseId, serving);
    },
  });
}

/** A release's serving gateways: at once when loaded, else a pending load. */
type RouteServing = (
  releaseId: string,
) => ReleaseServing | Promise<ReleaseServing>;

/**
 * Await a release that is still loading only outside the page's read
 * snapshot (SPEED-1 S9): its loader needs a connection, which a page holding
 * one while it waits could starve.
 */
async function routed(serving: ReleaseServing | Promise<ReleaseServing>) {
  return serving instanceof Promise
    ? withoutReadSnapshot(() => serving)
    : serving;
}

function viewReleaseId(view: unknown): string | null {
  const release = isRecord(view) ? view.release : null;
  return isRecord(release) && typeof release.releaseId === 'string'
    ? release.releaseId
    : null;
}

/**
 * The read ingress of the composed runtime: each request is answered by the
 * gateway built for the release its view was issued against.
 */
export class ReleaseRoutingQueryGateway extends SemanticQueryGateway {
  readonly #route: RouteServing;
  readonly #fallback: SemanticQueryGateway;

  constructor(route: RouteServing, policy: PostgresCurrentPolicyGateway) {
    super(policy);
    this.#route = route;
    this.#fallback = new SemanticQueryGateway(policy);
  }

  override async invoke(
    ...args: Parameters<SemanticQueryGateway['invoke']>
  ): ReturnType<SemanticQueryGateway['invoke']> {
    return (await this.#gateway(args[0])).invoke(...args);
  }

  override async invokeAggregate(
    ...args: Parameters<SemanticQueryGateway['invokeAggregate']>
  ): ReturnType<SemanticQueryGateway['invokeAggregate']> {
    return (await this.#gateway(args[0])).invokeAggregate(...args);
  }

  override async previewEligibility(
    ...args: Parameters<SemanticQueryGateway['previewEligibility']>
  ): ReturnType<SemanticQueryGateway['previewEligibility']> {
    return (await this.#gateway(args[0])).previewEligibility(...args);
  }

  async #gateway(view: unknown): Promise<SemanticQueryGateway> {
    const releaseId = viewReleaseId(view);
    // A malformed view is refused by the gateway's own view assertion.
    return releaseId
      ? (await routed(this.#route(releaseId))).queryGateway
      : this.#fallback;
  }
}

/** The write ingress, routed the same way. */
export class ReleaseRoutingOperationGateway extends SemanticOperationGateway {
  readonly #route: RouteServing;
  readonly #fallback: SemanticOperationGateway;

  constructor(
    route: RouteServing,
    policy: PostgresCurrentPolicyGateway,
    mediation: SemanticOperationMediationAuthority,
  ) {
    super(policy, undefined, mediation);
    this.#route = route;
    this.#fallback = new SemanticOperationGateway(policy, undefined, mediation);
  }

  override async previewEligibility(
    ...args: Parameters<SemanticOperationGateway['previewEligibility']>
  ): ReturnType<SemanticOperationGateway['previewEligibility']> {
    return (await this.#gateway(args[0])).previewEligibility(...args);
  }

  override async previewTaskEligibility(
    ...args: Parameters<SemanticOperationGateway['previewTaskEligibility']>
  ): ReturnType<SemanticOperationGateway['previewTaskEligibility']> {
    return (await this.#gateway(args[0])).previewTaskEligibility(...args);
  }

  /**
   * An invocation runs outside any page read snapshot (SPEED-1 S1, ADR-0071
   * rule 3): every decision it makes -- its own, a capability's preflight and
   * read-back -- is read live, and its writes and read-back never meet a
   * snapshot's epoch check.
   */
  override async invoke(
    ...args: Parameters<SemanticOperationGateway['invoke']>
  ): ReturnType<SemanticOperationGateway['invoke']> {
    // The release is routed first, outside the invocation's turn: a sibling
    // read may be loading it, and the turn must not wait on that load.
    const gateway = await this.#gateway(args[0]);
    return withoutReadSnapshot(() => gateway.invoke(...args));
  }

  async #gateway(view: unknown): Promise<SemanticOperationGateway> {
    const releaseId = viewReleaseId(view);
    return releaseId
      ? (await routed(this.#route(releaseId))).operationGateway
      : this.#fallback;
  }
}

/**
 * The instrumentation the composition installs on the read ingress — exported
 * so a gate can drive the real object across an ADR-0032 boundary instead of
 * re-implementing it and testing the copy.
 */
export function composedRegisteredQueryLatencyInstrumentation(
  metrics: ObservabilityMetrics,
  clock: (() => number) | undefined = undefined,
): RegisteredQueryLatencyInstrumentation {
  return Object.freeze({
    monotonicMilliseconds: clock ?? monotonicMilliseconds,
    observe: (observation) => {
      metrics.recordRegisteredQueryLatency(
        observation.outcome,
        observation.durationMilliseconds,
      );
    },
  } satisfies RegisteredQueryLatencyInstrumentation);
}

export function parseCompiledApplication(
  input: unknown,
): ParsedApplicationRelease {
  if (!isRecord(input)) {
    throw new TypeError('compiled application envelope is invalid');
  }
  if (input.schemaVersion === compiledApplicationVersion) {
    const application = parseRelease(input.application, 'application');
    return Object.freeze({
      application,
      applications: Object.freeze([application]),
      bootstrap: parseRelease(input.bootstrap, 'bootstrap'),
    });
  }
  if (
    input.schemaVersion !== compiledApplicationLineageVersion ||
    !Array.isArray(input.applications) ||
    input.applications.length === 0
  ) {
    throw new TypeError('compiled application envelope is invalid');
  }
  const applications = Object.freeze(
    input.applications.map((release, index) =>
      parseRelease(release, `applications[${String(index)}]`),
    ),
  );
  return Object.freeze({
    application: applications.at(-1)!,
    applications,
    bootstrap: parseRelease(input.bootstrap, 'bootstrap'),
  });
}

function parseRelease(value: unknown, label: string): ParsedRelease {
  if (
    !isRecord(value) ||
    !isRecord(value.attestation) ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.nodeContracts) ||
    !isRecord(value.releaseManifest) ||
    !Array.isArray(value.stagedArtifactHashes) ||
    typeof value.outputProtocolVersion !== 'string' ||
    typeof value.releaseRoot !== 'string'
  ) {
    throw new TypeError(`compiled ${label} release is invalid`);
  }
  const artifacts = value.artifacts.map((artifact, index) =>
    parseArtifact(artifact, `${label}.artifacts[${String(index)}]`),
  );
  const byHash = new Map(
    artifacts.map((artifact) => [artifact.contentHash, artifact]),
  );
  const stagedArtifacts = value.stagedArtifactHashes.map((hash) => {
    if (typeof hash !== 'string' || !byHash.has(hash)) {
      throw new TypeError(`compiled ${label} staged artifacts are invalid`);
    }
    return byHash.get(hash)!;
  });
  const releaseManifestBytes = decodeBase64(
    value.releaseManifestBytesBase64,
    `${label}.releaseManifestBytesBase64`,
  );
  const normalizedDefinitionBytes = decodeBase64(
    value.normalizedDefinitionBytesBase64,
    `${label}.normalizedDefinitionBytesBase64`,
  );
  const compiled = {
    attestation: value.attestation,
    bundle: {
      artifacts,
      kind: 'compiledReleaseBundle',
      nodeContracts: value.nodeContracts,
      outputProtocolVersion: value.outputProtocolVersion,
      releaseManifest: value.releaseManifest,
      releaseManifestBytes,
    },
    diagnostics: [],
    releaseRoot: value.releaseRoot,
    stagedArtifacts,
    status: 'compiled',
  } as unknown as CompileSuccess;
  return Object.freeze({ compiled, normalizedDefinitionBytes });
}

export function releasesForLineage(
  releases: ParsedApplicationRelease,
): readonly ParsedRelease[] {
  return Object.freeze([releases.bootstrap, ...releases.applications]);
}

function assertExactCompiledTransition(
  source: ParsedRelease,
  target: ParsedRelease,
): StorageTransitionEnvelope {
  const transition = projectionPayload(
    target.compiled,
    PROJECTION_FAMILY_IDS.storageTransition,
  );
  if (
    !isRecord(transition) ||
    transition.kind !== 'storageTransitionEnvelope' ||
    transition.schemaVersion !== STORAGE_TRANSITION_ENVELOPE_VERSION ||
    !Array.isArray(transition.elements)
  ) {
    throw new Error(
      'compiled application successor has no valid storage transition',
    );
  }
  const sourceStorage = requiredProjection(
    source.compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  const targetStorage = requiredProjection(
    target.compiled,
    PROJECTION_FAMILY_IDS.storageTarget,
  );
  if (
    transition.fromReleaseRoot !== source.compiled.releaseRoot ||
    transition.fromNormalizedDefinitionDigest !==
      source.compiled.bundle.releaseManifest.normalizedDefinitionDigest ||
    transition.fromStorageTargetArtifactRoot !== sourceStorage.artifactRoot ||
    transition.fromStorageTargetSemanticDigest !==
      sourceStorage.semanticDigest ||
    transition.toNormalizedDefinitionDigest !==
      target.compiled.bundle.releaseManifest.normalizedDefinitionDigest ||
    transition.toStorageTargetArtifactRoot !== targetStorage.artifactRoot ||
    transition.toStorageTargetSemanticDigest !== targetStorage.semanticDigest
  ) {
    throw new Error(
      'compiled application transition does not match its declared previous release',
    );
  }
  return transition as unknown as StorageTransitionEnvelope;
}

function projectionPayload(
  compiled: CompileSuccess,
  familyId: string,
): unknown {
  return projectionBinding(compiled, familyId).payload;
}

function projectionBinding(
  compiled: CompileSuccess,
  familyId: string,
): PinnedCapabilityProjection {
  const reference = requiredProjection(compiled, familyId);
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) =>
      artifact.artifactKind === 'projectionManifest' &&
      artifact.contentHash === reference.artifactRoot,
  );
  if (!manifestArtifact) {
    throw new Error(`compiled release is missing ${familyId} manifest bytes`);
  }
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestArtifact.canonicalBytes),
  ) as unknown;
  const chunks = isRecord(manifest) ? manifest.chunks : null;
  if (
    !Array.isArray(chunks) ||
    chunks.length !== 1 ||
    !isRecord(chunks[0]) ||
    typeof chunks[0].contentHash !== 'string'
  ) {
    throw new Error(`compiled release has invalid ${familyId} manifest bytes`);
  }
  const chunkHash = chunks[0].contentHash;
  const chunk = compiled.bundle.artifacts.find(
    (artifact) =>
      artifact.artifactKind === 'projectionChunk' &&
      artifact.contentHash === chunkHash,
  );
  if (!chunk) {
    throw new Error(`compiled release is missing ${familyId} payload bytes`);
  }
  return Object.freeze({
    contentHash: chunk.contentHash,
    payload: JSON.parse(
      new TextDecoder().decode(chunk.canonicalBytes),
    ) as unknown,
  });
}

function requiredProjection(compiled: CompileSuccess, familyId: string) {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (projection) => projection.familyId === familyId,
  );
  if (!reference) {
    throw new Error(`compiled release is missing ${familyId}`);
  }
  return reference;
}

function parseArtifact(value: unknown, path: string): ContentAddressedArtifact {
  if (
    !isRecord(value) ||
    !['projectionChunk', 'projectionManifest', 'releaseManifest'].includes(
      String(value.artifactKind),
    ) ||
    value.kind !== 'contentAddressedArtifact' ||
    value.mediaType !== 'application/vnd.northstar.canonical+json' ||
    typeof value.contentHash !== 'string' ||
    typeof value.domainTag !== 'string'
  ) {
    throw new TypeError(`${path} is invalid`);
  }
  return {
    artifactKind:
      value.artifactKind as ContentAddressedArtifact['artifactKind'],
    canonicalBytes: decodeBase64(
      value.canonicalBytesBase64,
      `${path}.canonicalBytesBase64`,
    ),
    contentHash: value.contentHash,
    domainTag: value.domainTag,
    kind: 'contentAddressedArtifact',
    mediaType: 'application/vnd.northstar.canonical+json',
  };
}

export async function migrate(pool: pg.Pool, directory: string): Promise<void> {
  const client = await pool.connect();
  try {
    const loaded = await loadMigrations(directory);
    const result = await runMigrations(client, loaded);
    if (
      result.verified.length !== loaded.length ||
      result.verified.some((name, index) => name !== loaded[index]?.name) ||
      result.applied.some(
        (name) => !loaded.some((migration) => migration.name === name),
      )
    ) {
      throw new Error('not every migration was applied and verified');
    }
  } finally {
    client.release();
  }
}

export async function ensureScope(
  pool: pg.Pool,
  tenantSlug: string,
  environmentSlug: string,
): Promise<ScopeIdentities> {
  const tenant = await pool.query<{ id: string }>(
    `INSERT INTO platform.tenants (id, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id`,
    [randomUUID(), tenantSlug],
  );
  const tenantId = required(tenant.rows[0]?.id, 'tenant identity');
  const environment = await pool.query<{ id: string }>(
    `INSERT INTO platform.environments (tenant_id, id, slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id`,
    [tenantId, randomUUID(), environmentSlug],
  );
  const environmentId = required(
    environment.rows[0]?.id,
    'environment identity',
  );
  const principalId = stableUuid(`${tenantId}:local-human`);
  return Object.freeze({
    approver: Object.freeze({
      environmentId,
      principalId: stableUuid(`${tenantId}:local-approver`),
      tenantId,
    }),
    authorityOperatorId: stableUuid(`${tenantId}:authority-operator`),
    runtime: Object.freeze({ environmentId, principalId, tenantId }),
    manager: Object.freeze({
      environmentId,
      principalId: stableUuid(`${tenantId}:local-manager`),
      tenantId,
    }),
    system: Object.freeze({
      environmentId,
      principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
      tenantId,
    }),
  });
}

export async function provisionLocalDemoAuthorization(
  pool: AdminQueryable,
  identity: AuthenticatedIdentity,
  applicationBindings: readonly CurrentPolicyPermissionBinding[],
  roleKey = 'local-demo-full-release',
): Promise<void> {
  const roleId = stableUuid(
    `${identity.tenantId}:${identity.environmentId}:${roleKey === 'local-demo-full-release' ? 'local-demo-role' : roleKey}`,
  );
  const membershipId = stableUuid(
    `${identity.tenantId}:${identity.environmentId}:${identity.principalId}:local-demo-membership`,
  );
  // A held client (the release-scope lock's) is used as is, never released.
  const held = pool instanceof pg.Pool ? null : pool;
  const client = held ?? (await (pool as pg.Pool).connect());
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO platform.current_policy_roles (
         tenant_id, environment_id, role_id, role_key, revoked_at
       ) VALUES ($1,$2,$3,$4,NULL)
       ON CONFLICT (tenant_id, environment_id, role_id)
       DO UPDATE SET role_key = EXCLUDED.role_key, revoked_at = NULL`,
      [identity.tenantId, identity.environmentId, roleId, roleKey],
    );
    for (const binding of [
      ...CURRENT_POLICY_RUNTIME_BINDINGS,
      ...applicationBindings,
    ]) {
      await client.query(
        `INSERT INTO platform.current_policy_permission_grants (
           tenant_id, environment_id, role_id, permission_id, resource_id,
           revoked_at
         ) VALUES ($1,$2,$3,$4,$5,NULL)
         ON CONFLICT (tenant_id, environment_id, role_id, permission_id)
         DO UPDATE SET resource_id = EXCLUDED.resource_id, revoked_at = NULL`,
        [
          identity.tenantId,
          identity.environmentId,
          roleId,
          binding.permissionId,
          binding.resourceId,
        ],
      );
    }
    await client.query(
      `INSERT INTO platform.current_policy_memberships (
         tenant_id, environment_id, membership_id, principal_id, role_id,
         legal_entity_id, revoked_at
       ) VALUES ($1,$2,$3,$4,$5,NULL,NULL)
       ON CONFLICT (tenant_id, environment_id, membership_id)
       DO UPDATE SET principal_id = EXCLUDED.principal_id,
                     role_id = EXCLUDED.role_id,
                     legal_entity_id = NULL,
                     revoked_at = NULL`,
      [
        identity.tenantId,
        identity.environmentId,
        membershipId,
        identity.principalId,
        roleId,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (!held) client.release();
  }
}

/**
 * One tenant environment's release-scope lock (CUSTOMIZE review F1): a
 * session advisory lock held on one admin connection across a pointer swap,
 * the pointer re-read and the inventory scope reconcile, so no swap can land
 * between another swap and its reconcile.
 */
export async function withReleaseScopeLock<T>(
  adminPool: pg.Pool,
  identity: AuthenticatedIdentity,
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await adminPool.connect();
  const key = `northstar.release-scope:${identity.tenantId}:${identity.environmentId}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
      key,
    ]);
    try {
      return await run(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        key,
      ]);
    }
  } finally {
    client.release();
  }
}

/**
 * Null when the activation that set the live pointer verified, or there is no
 * live release yet; otherwise what is unproven, in words (CUSTOMIZE review
 * R2). The kernel commits a pointer swap before it verifies it, so a cut
 * between the two leaves a live pointer nothing has proven: its swap receipt
 * at the current pointer and fence has no `SWAPPED_VERIFIED` receipt.
 */
export async function unprovenLivePointer(
  runtimePool: pg.Pool,
  context: TrustedRequestContext,
): Promise<string | null> {
  return withTrustedRequestTransaction(runtimePool, context, async (client) => {
    const result = await client.query(
      `SELECT 1 FROM ${servingPointersSql} AS pointer
        WHERE tenant_id=$1 AND environment_id=$2 AND physical_release_id IS NOT NULL
          AND (physical_release_id IS DISTINCT FROM release_id OR physical_fence IS DISTINCT FROM fence)`,
      [context.tenantId, context.environmentId],
    );
    return result.rowCount
      ? 'the current pointer generation has no verified swap receipt'
      : null;
  });
}

export async function readVerifiedServing(
  pool: pg.Pool,
  context: TrustedRequestContext,
) {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const result = await client.query<{
      pointer_id: MintedUuid;
      release_id: MintedUuid;
      fence: string;
      content_hash: string;
    }>(
      `SELECT pointer.pointer_id, pointer.release_id, pointer.fence, release.content_hash
         FROM ${servingPointersSql} AS pointer
         JOIN platform.tenant_releases AS release USING (tenant_id, environment_id, release_id)
         JOIN platform.tenant_release_admissions AS admission
           ON admission.tenant_id = release.tenant_id AND admission.environment_id = release.environment_id
          AND admission.release_id = release.release_id AND admission.verification_evidence_id = release.verification_evidence_id
        WHERE pointer.tenant_id=$1 AND pointer.environment_id=$2`,
      [context.tenantId, context.environmentId],
    );
    const row = result.rows[0];
    return row
      ? {
          pointerId: row.pointer_id,
          releaseId: row.release_id,
          releaseRoot: row.content_hash,
          fence: Number(row.fence),
        }
      : null;
  });
}

/**
 * Sets every inventory scope of one tenant environment to the root of the
 * release the active pointer names, read here -- never a root computed
 * earlier. `contract_release_root` is provenance the posting kernel requires
 * to equal the active release (`INVENTORY_POSTING_RELEASE_MISMATCH`). It
 * re-runs the provisioning function with each scope's own stored policy, so
 * policy stays assert-identical and only the root moves (migration 0019); the
 * entity code and name it validates as non-blank are not stored by it. Call it
 * holding `withReleaseScopeLock`. Returns the root, or null with no pointer.
 */
export async function reconcileInventoryScopeToPointer(
  client: pg.PoolClient,
  identity: AuthenticatedIdentity,
  expected: PointerState,
): Promise<string | null> {
  const pointer = await client.query<{ content_hash: string }>(
    `WITH generation AS MATERIALIZED (
       SELECT release.content_hash
         FROM ${servingPointersSql} AS pointer
         JOIN platform.tenant_releases AS release USING (tenant_id,environment_id,release_id)
         JOIN platform.active_release_pointers AS physical
           ON physical.tenant_id=pointer.tenant_id AND physical.environment_id=pointer.environment_id
          AND physical.pointer_id=pointer.pointer_id AND physical.fence=$5 AND physical.release_id=$4
        WHERE pointer.tenant_id=$1 AND pointer.environment_id=$2
          AND pointer.pointer_id=$3 AND pointer.release_id=$4 AND pointer.fence=$5
        FOR SHARE OF physical
     ), reconciled AS MATERIALIZED (
       SELECT platform.provision_inventory_scope(
       configuration.tenant_id, configuration.environment_id,
       configuration.legal_entity_id, 'scope', 'scope',
       calendar.time_zone, calendar.business_day_boundary, generation.content_hash,
       configuration.configuration_version, configuration.negative_stock,
       configuration.maximum_backdate_days,
       configuration.adjustment_reason_requirement,
       configuration.transfer_reason_requirement,
       configuration.count_reason_requirement,
       configuration.correction_reason_requirement,
       configuration.rebaseline_reason_requirement,
       configuration.adjustment_approval_threshold,
       configuration.transfer_approval_threshold,
       configuration.count_approval_threshold,
       configuration.correction_approval_threshold,
       configuration.rebaseline_approval_threshold)
       FROM generation CROSS JOIN platform.inventory_posting_configurations AS configuration
       JOIN platform.inventory_tenant_calendars AS calendar
         ON calendar.tenant_id = configuration.tenant_id
      WHERE configuration.tenant_id = $1
        AND configuration.environment_id = $2
        AND configuration.contract_release_root IS DISTINCT FROM generation.content_hash
     ) SELECT content_hash,(SELECT count(*) FROM reconciled) AS scope_count FROM generation`,
    [
      identity.tenantId,
      identity.environmentId,
      expected.pointerId,
      expected.releaseId,
      expected.fence,
    ],
  );
  return pointer.rows[0]?.content_hash ?? null;
}

export async function provisionInventoryScope(
  adminPool: pg.Pool,
  identity: AuthenticatedIdentity,
  contractReleaseRoot: string,
  provisioning: InventoryScopeProvisioning,
): Promise<void> {
  await withReleaseScopeLock(adminPool, identity, (client) =>
    provisionInventoryScopeOnClient(
      client,
      identity,
      contractReleaseRoot,
      provisioning,
    ),
  );
}

async function provisionInventoryScopeOnClient(
  client: pg.PoolClient,
  identity: AuthenticatedIdentity,
  contractReleaseRoot: string,
  provisioning: InventoryScopeProvisioning,
) {
  const existing = await client.query<{ contract_release_root: string }>(
    `SELECT contract_release_root
       FROM platform.inventory_posting_configurations
      WHERE tenant_id = $1 AND environment_id = $2 AND legal_entity_id = $3`,
    [identity.tenantId, identity.environmentId, provisioning.legalEntityId],
  );
  const releaseRoot =
    existing.rows[0]?.contract_release_root ?? contractReleaseRoot;
  await client.query(
    `SELECT platform.provision_inventory_scope(
       $1,$2,$3,$4,$5,$6,$7,$8,$9::smallint,$10,$11,
       $12,$13,$14,$15,$16,$17,$18,$19,$20,$21
     )`,
    [
      identity.tenantId,
      identity.environmentId,
      provisioning.legalEntityId,
      provisioning.entityCode,
      provisioning.entityName,
      provisioning.timeZone,
      provisioning.businessDayBoundary,
      releaseRoot,
      provisioning.configurationVersion,
      provisioning.negativeStock,
      provisioning.maximumBackdateDays,
      provisioning.adjustmentReasonRequirement,
      provisioning.transferReasonRequirement,
      provisioning.countReasonRequirement,
      provisioning.correctionReasonRequirement,
      provisioning.rebaselineReasonRequirement,
      provisioning.adjustmentApprovalThreshold,
      provisioning.transferApprovalThreshold,
      provisioning.countApprovalThreshold,
      provisioning.correctionApprovalThreshold,
      provisioning.rebaselineApprovalThreshold,
    ],
  );
}

async function ensureAuthority(
  pool: pg.PoolClient,
  identities: ScopeIdentities,
): Promise<void> {
  const tenantId = identities.runtime.tenantId;
  const approver = await pool.query<{ eligible: boolean }>(
    `SELECT eligible
       FROM platform.release_approver_eligibility_events
      WHERE tenant_id = $1 AND principal_id = $2
      ORDER BY policy_version DESC LIMIT 1`,
    [tenantId, identities.approver.principalId],
  );
  if (approver.rows[0]?.eligible !== true) {
    await pool.query(
      'SELECT platform.set_release_approver_eligibility($1,$2,true,$3,$4)',
      [
        tenantId,
        identities.approver.principalId,
        identities.authorityOperatorId,
        randomUUID(),
      ],
    );
  }
  for (const principalId of [
    identities.runtime.principalId,
    SYSTEM_EXECUTION_PRINCIPAL.principalId,
  ]) {
    const executor = await pool.query<{ authorized: boolean }>(
      `SELECT authorized
         FROM platform.release_executor_authority_events
        WHERE tenant_id = $1 AND principal_id = $2
        ORDER BY policy_version DESC LIMIT 1`,
      [tenantId, principalId],
    );
    if (executor.rows[0]?.authorized !== true) {
      await pool.query(
        'SELECT platform.set_release_executor_authority($1,$2,true,$3,$4)',
        [tenantId, principalId, identities.authorityOperatorId, randomUUID()],
      );
    }
  }
  const control = await pool.query<{
    live_policy_denied: boolean;
    rollout_paused: boolean;
  }>(
    `SELECT live_policy_denied, rollout_paused
       FROM platform.release_activation_control_events
      WHERE tenant_id = $1 AND environment_id = $2 AND rollout_id IS NULL
      ORDER BY policy_version DESC LIMIT 1`,
    [tenantId, identities.runtime.environmentId],
  );
  if (
    control.rows[0]?.live_policy_denied !== false ||
    control.rows[0]?.rollout_paused !== false
  ) {
    await pool.query(
      `SELECT platform.set_release_activation_control(
         $1,$2,NULL,false,false,$3,$4
       )`,
      [
        tenantId,
        identities.runtime.environmentId,
        identities.authorityOperatorId,
        randomUUID(),
      ],
    );
  }
}

/** A staged release already belongs to another parent or authorship. */
export class PersistedReleaseConflict extends Error {
  override readonly name = 'PersistedReleaseConflict';
  readonly code = 'CUSTOMIZE_RELEASE_REVISION_CONFLICT' as const;
}

export async function ensurePersistedRelease(
  pool: pg.Pool,
  context: TrustedRequestContext,
  release: ParsedRelease,
  parentRevisionId: MintedUuid | null,
  provenance: 'firstParty' | 'tenantAuthored' = 'firstParty',
): Promise<PersistedReleaseIdentity> {
  // A release already staged for this root carries its own revision: return
  // that one (CUSTOMIZE review F2). Two identical drafts racing could each mint
  // a revision; the release links one, and the patch must record the same.
  const existing = await withTrustedRequestTransaction(
    pool,
    context,
    async (client) =>
      client.query<{
        parent_revision_id: MintedUuid | null;
        provenance: string;
        release_id: MintedUuid;
        revision_id: MintedUuid;
        verification_evidence_id: MintedUuid;
      }>(
        `SELECT release.release_id, release.verification_evidence_id,
                revision.revision_id, revision.provenance,
                revision.parent_revision_id
           FROM platform.tenant_releases AS release
           JOIN platform.app_package_revisions AS revision
             ON revision.tenant_id = release.tenant_id
            AND revision.revision_id = release.app_package_revision_id
          WHERE release.tenant_id = $1 AND release.environment_id = $2
            AND release.content_hash = $3
          ORDER BY release.created_at LIMIT 1`,
        [context.tenantId, context.environmentId, release.compiled.releaseRoot],
      ),
  );
  const stagedRow = existing.rows[0];
  if (stagedRow) {
    if (
      provenance === 'tenantAuthored' &&
      (stagedRow.provenance !== 'tenantAuthored' ||
        stagedRow.parent_revision_id !== parentRevisionId)
    ) {
      throw new PersistedReleaseConflict(
        'this release is already recorded under a different parent or authorship; nothing was recorded',
      );
    }
    return Object.freeze({
      evidenceId: stagedRow.verification_evidence_id,
      releaseId: stagedRow.release_id,
      revisionId: stagedRow.revision_id,
    });
  }
  const normalizedDefinition = parseNormalizedApplicationPackageJson(
    release.normalizedDefinitionBytes,
  );
  const digest = canonicalizeAndHash(normalizedDefinition);
  const existingRevision = await withTrustedRequestTransaction(
    pool,
    context,
    async (client) =>
      client.query<{ revision_id: MintedUuid }>(
        // A tenant-authored revision is reused only under the same parent:
        // the rollback policy reads that edge (ADR-0013).
        `SELECT revision_id
           FROM platform.app_package_revisions
          WHERE tenant_id = $1 AND content_hash = $2
            AND ($3::text = 'firstParty'
                 OR (provenance = $3 AND parent_revision_id = $4))
          ORDER BY created_at LIMIT 1`,
        [context.tenantId, digest.contentHash, provenance, parentRevisionId],
      ),
  );
  let revisionId = existingRevision.rows[0]?.revision_id;
  const repository = new PostgresImmutableReleaseRepository(pool);
  if (!revisionId) {
    revisionId = minted(randomUUID());
    await repository.storeAppPackageRevision(context, {
      canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
      contentHash: digest.contentHash,
      createdBy: context.principalId,
      desiredState: release.normalizedDefinitionBytes,
      hashAlgorithm: CONTENT_HASH_ALGORITHM,
      languageVersion: normalizedDefinition.languageVersion,
      normalizationProfileVersion:
        normalizedDefinition.normalizationProfileVersion,
      parentRevisionId,
      provenance,
      revisionId,
      schemaVersion: normalizedDefinition.schemaVersion,
      tenantId: context.tenantId,
    });
  }
  // No release is staged for this root (the lookup above): stage one. Two
  // identical customization drafts are serialized by the release-scope lock,
  // so the second finds this one (CUSTOMIZE review R4).
  const releaseId = minted(randomUUID());
  const staged = await repository.stageTenantReleaseCandidate(context, {
    appPackageRevisionId: revisionId,
    compiledRelease: release.compiled,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
  });
  return Object.freeze({
    evidenceId: staged.verificationEvidenceId,
    releaseId,
    revisionId,
  });
}

export async function ensureReleaseAdmitted(
  pool: pg.Pool,
  context: TrustedRequestContext,
  identity: PersistedReleaseIdentity,
  release: ParsedRelease,
  providerErrorMappings: readonly ModuleProviderErrorMapping[],
  capabilityOperationExecutorFactories: readonly PostgresCapabilityOperationExecutorFactory[],
): Promise<void> {
  const repository = new PostgresImmutableReleaseRepository(pool);
  if (await repository.getTenantRelease(context, identity.releaseId)) return;
  await new PostgresReleaseVerificationService(
    pool,
    providerErrorMappings,
    capabilityOperationExecutorFactories,
  ).executeSemanticCandidateAndPersist(context, {
    compiledRelease: release.compiled,
    evidenceId: identity.evidenceId,
    releaseId: identity.releaseId,
  });
  await repository.registerTenantRelease(context, {
    appPackageRevisionId: identity.revisionId,
    compiledRelease: release.compiled,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId: identity.releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId: identity.evidenceId,
  });
}

async function observeFreshTenantIntermediateActivation(
  options: ComposedApplicationRuntimeOptions,
  pool: pg.Pool,
  context: TrustedRequestContext,
  lineageOrdinal: number,
  identity: PersistedReleaseIdentity,
  releaseRoot: string,
): Promise<void> {
  if (!options.afterFreshTenantIntermediateActivation) return;
  await options.afterFreshTenantIntermediateActivation(
    Object.freeze({
      lineageOrdinal,
      async loadActiveRuntimeDefinition() {
        await new PostgresRequestRuntimeViewService(pool).load(context);
      },
      releaseId: identity.releaseId,
      releaseRoot,
    }),
  );
}

async function freshTenantInstallIsIncomplete(
  pool: pg.Pool,
  context: TrustedRequestContext,
  installId: MintedUuid,
  activeReleaseId: MintedUuid | null,
  servingReleaseId: MintedUuid,
): Promise<boolean> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const result = await client.query<{
      completed: boolean;
      intermediate_count: number;
      resumes_from_intermediate: boolean;
    }>(
      `SELECT EXISTS (
                SELECT 1
                  FROM platform.fresh_tenant_install_evidence
                 WHERE tenant_id = $1
                   AND environment_id = $2
                   AND install_id = $3
              ) AS completed,
              (
                SELECT count(*)::integer
                  FROM platform.fresh_tenant_intermediate_release_admissions
                 WHERE tenant_id = $1
                   AND environment_id = $2
                   AND install_id = $3
              ) AS intermediate_count,
              EXISTS (
                SELECT 1
                  FROM platform.fresh_tenant_intermediate_release_admissions
                 WHERE tenant_id = $1
                   AND environment_id = $2
                   AND install_id = $3
                   AND release_id = $4
              ) AS resumes_from_intermediate`,
      [context.tenantId, context.environmentId, installId, activeReleaseId],
    );
    const state = result.rows[0];
    if (!state || state.completed || state.intermediate_count === 0)
      return false;
    if (
      state.resumes_from_intermediate ||
      activeReleaseId === servingReleaseId
    ) {
      return true;
    }
    throw new Error(
      'incomplete fresh-tenant install does not bind the active release',
    );
  });
}

async function ensureFreshTenantIntermediateReleaseAdmitted(
  pool: pg.Pool,
  context: TrustedRequestContext,
  installId: MintedUuid,
  lineageOrdinal: number,
  identity: PersistedReleaseIdentity,
  release: ParsedRelease,
  sourceReleaseRoot: string | null,
): Promise<void> {
  const evidenceDigest = digest(
    'fresh-tenant-intermediate-release-admission',
    installId,
    String(lineageOrdinal),
    identity.releaseId,
    release.compiled.releaseRoot,
    sourceReleaseRoot ?? 'INITIAL_ACTIVATION',
  ).toString('hex');
  await withTrustedRequestTransaction(pool, context, async (client) => {
    await client.query(
      `SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           format(
             'northstar.fresh-tenant-install/v1:%s:%s:%s',
             $1::uuid,
             $2::uuid,
             $3::uuid
           ),
           0
         )
       )`,
      [context.tenantId, context.environmentId, installId],
    );
    const candidate = await client.query<{
      content_hash: string;
      verification_evidence_id: MintedUuid;
    }>(
      `SELECT content_hash, verification_evidence_id
         FROM platform.tenant_releases
        WHERE tenant_id = $1
          AND environment_id = $2
          AND release_id = $3`,
      [context.tenantId, context.environmentId, identity.releaseId],
    );
    const candidateRow = candidate.rows[0];
    if (
      !candidateRow ||
      candidateRow.content_hash !== release.compiled.releaseRoot ||
      candidateRow.verification_evidence_id !== identity.evidenceId
    ) {
      throw new Error(
        'fresh-tenant intermediate admission does not bind the staged release',
      );
    }
    const verified = await client.query<{ present: boolean }>(
      `SELECT true AS present
         FROM platform.tenant_release_admissions
        WHERE tenant_id = $1
          AND environment_id = $2
          AND release_id = $3`,
      [context.tenantId, context.environmentId, identity.releaseId],
    );
    if (verified.rows[0]) {
      throw new Error(
        'fresh-tenant intermediate release already has semantic verification admission',
      );
    }
    await client.query(
      `INSERT INTO platform.fresh_tenant_intermediate_release_admissions (
         tenant_id, environment_id, release_id, release_evidence_id,
         install_id, lineage_ordinal, release_root, source_release_root,
         evidence_version, evidence_digest, admitted_by
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
        WHERE NOT EXISTS (
          SELECT 1
            FROM platform.fresh_tenant_intermediate_release_admissions
           WHERE tenant_id = $1
             AND environment_id = $2
             AND release_id = $3
        )`,
      [
        context.tenantId,
        context.environmentId,
        identity.releaseId,
        identity.evidenceId,
        installId,
        lineageOrdinal,
        release.compiled.releaseRoot,
        sourceReleaseRoot,
        freshTenantIntermediateAdmissionVersion,
        evidenceDigest,
        context.principalId,
      ],
    );
    const stored = await client.query<{
      admitted_by: string;
      evidence_digest: string;
      evidence_version: string;
      install_id: string;
      lineage_ordinal: number;
      release_evidence_id: string;
      release_root: string;
      source_release_root: string | null;
    }>(
      `SELECT admitted_by, evidence_digest, evidence_version, install_id,
              lineage_ordinal, release_evidence_id, release_root,
              source_release_root
         FROM platform.fresh_tenant_intermediate_release_admissions
        WHERE tenant_id = $1
          AND environment_id = $2
          AND release_id = $3`,
      [context.tenantId, context.environmentId, identity.releaseId],
    );
    const storedRow = stored.rows[0];
    if (
      !storedRow ||
      storedRow.admitted_by !== context.principalId ||
      storedRow.evidence_digest !== evidenceDigest ||
      storedRow.evidence_version !== freshTenantIntermediateAdmissionVersion ||
      storedRow.install_id !== installId ||
      storedRow.lineage_ordinal !== lineageOrdinal ||
      storedRow.release_evidence_id !== identity.evidenceId ||
      storedRow.release_root !== release.compiled.releaseRoot ||
      storedRow.source_release_root !== sourceReleaseRoot
    ) {
      throw new Error(
        'fresh-tenant intermediate admission differs from the exact install lineage',
      );
    }
  });
}

async function persistFreshTenantInstallEvidence(
  pool: pg.Pool,
  context: TrustedRequestContext,
  installId: MintedUuid,
  lineage: readonly PersistedReleaseIdentity[],
  releases: readonly ParsedRelease[],
  servingIdentity: PersistedReleaseIdentity,
  servingRelease: ParsedRelease,
): Promise<FreshTenantInstallEvidence> {
  if (
    lineage.length !== releases.length ||
    lineage.at(-1)?.releaseId !== servingIdentity.releaseId ||
    releases.at(-1)?.compiled.releaseRoot !==
      servingRelease.compiled.releaseRoot
  ) {
    throw new Error('fresh-tenant evidence does not bind the serving lineage');
  }
  const binding = releaseVerificationBinding(servingRelease.compiled);
  return withTrustedRequestTransaction(pool, context, async (client) => {
    await client.query(
      `SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended(
           format(
             'northstar.fresh-tenant-install/v1:%s:%s:%s',
             $1::uuid,
             $2::uuid,
             $3::uuid
           ),
           0
         )
       )`,
      [context.tenantId, context.environmentId, installId],
    );
    const verification = await client.query<{
      derived_count: number;
      release_root: string;
      result_count: number;
    }>(
      `SELECT evidence.release_root,
              evidence.result_count,
              CASE
                WHEN evidence.impact_analysis_derivation IS NULL THEN 0
                ELSE jsonb_array_length(
                  evidence.impact_analysis_derivation -> 'derivations'
                )
              END AS derived_count
         FROM platform.tenant_release_admissions AS admission
         JOIN platform.release_verification_evidence AS evidence
           ON evidence.tenant_id = admission.tenant_id
          AND evidence.environment_id = admission.environment_id
          AND evidence.verification_evidence_id =
              admission.verification_evidence_id
        WHERE admission.tenant_id = $1
          AND admission.environment_id = $2
          AND admission.release_id = $3`,
      [context.tenantId, context.environmentId, servingIdentity.releaseId],
    );
    const verified = verification.rows[0];
    if (
      !verified ||
      verified.release_root !== servingRelease.compiled.releaseRoot ||
      verified.result_count + verified.derived_count !==
        binding.plan.scenarios.length
    ) {
      throw new Error(
        'fresh-tenant serving release does not carry its complete scenario partition',
      );
    }

    const intermediate = await client.query<{
      lineage_ordinal: number;
      release_id: MintedUuid;
      release_root: string;
      semantic_admission: boolean;
      source_release_root: string | null;
    }>(
      `SELECT intermediate.lineage_ordinal,
              intermediate.release_id,
              intermediate.release_root,
              EXISTS (
                SELECT 1
                  FROM platform.tenant_release_admissions AS semantic
                 WHERE semantic.tenant_id = intermediate.tenant_id
                   AND semantic.environment_id = intermediate.environment_id
                   AND semantic.release_id = intermediate.release_id
              ) AS semantic_admission,
              intermediate.source_release_root
         FROM platform.fresh_tenant_intermediate_release_admissions
              AS intermediate
        WHERE intermediate.tenant_id = $1
          AND intermediate.environment_id = $2
          AND intermediate.install_id = $3
        ORDER BY intermediate.lineage_ordinal`,
      [context.tenantId, context.environmentId, installId],
    );
    const expectedIntermediate = lineage
      .slice(0, -1)
      .map((identity, index) => ({
        lineage_ordinal: index,
        release_id: identity.releaseId,
        release_root: releases[index]!.compiled.releaseRoot,
        semantic_admission: false,
        source_release_root:
          index === 0 ? null : releases[index - 1]!.compiled.releaseRoot,
      }));
    if (
      JSON.stringify(intermediate.rows) !== JSON.stringify(expectedIntermediate)
    ) {
      throw new Error(
        'fresh-tenant intermediate admission set does not match the exact lineage',
      );
    }

    const document: FreshTenantInstallEvidence = Object.freeze({
      appliedTransitions: Object.freeze(
        releases.slice(1).map((release, index) =>
          Object.freeze({
            sourceReleaseRoot: releases[index]!.compiled.releaseRoot,
            targetReleaseRoot: release.compiled.releaseRoot,
          }),
        ),
      ),
      nonServingReleasesWithoutScenarioExecution: Object.freeze(
        expectedIntermediate.map((release) =>
          Object.freeze({
            releaseId: release.release_id,
            releaseRoot: release.release_root,
          }),
        ),
      ),
      schemaVersion: FRESH_TENANT_INSTALL_EVIDENCE_VERSION,
      servingRelease: Object.freeze({
        releaseId: servingIdentity.releaseId,
        releaseRoot: servingRelease.compiled.releaseRoot,
        scenarioCount: binding.plan.scenarios.length,
      }),
    });
    const recorded = await client.query<{ evidence_digest: string }>(
      `SELECT platform.record_fresh_tenant_install_evidence(
         $1,$2,$3,$4,$5
       ) AS evidence_digest`,
      [
        installId,
        servingIdentity.releaseId,
        servingRelease.compiled.releaseRoot,
        binding.plan.scenarios.length,
        document,
      ],
    );
    const evidenceDigest = recorded.rows[0]?.evidence_digest;
    if (!evidenceDigest) {
      throw new Error('fresh-tenant evidence recorder returned no digest');
    }
    const stored = await client.query<{
      created_by: string;
      evidence_digest: string;
      evidence_document: unknown;
      evidence_version: string;
      serving_release_id: string;
      serving_release_root: string;
      serving_scenario_count: number;
    }>(
      `SELECT created_by, evidence_digest, evidence_document, evidence_version,
              serving_release_id, serving_release_root, serving_scenario_count
         FROM platform.fresh_tenant_install_evidence
        WHERE tenant_id = $1
          AND environment_id = $2
          AND install_id = $3`,
      [context.tenantId, context.environmentId, installId],
    );
    const storedRow = stored.rows[0];
    if (
      !storedRow ||
      storedRow.created_by !== context.principalId ||
      storedRow.evidence_digest !== evidenceDigest ||
      canonicalize(storedRow.evidence_document) !== canonicalize(document) ||
      storedRow.evidence_version !== FRESH_TENANT_INSTALL_EVIDENCE_VERSION ||
      storedRow.serving_release_id !== servingIdentity.releaseId ||
      storedRow.serving_release_root !== servingRelease.compiled.releaseRoot ||
      storedRow.serving_scenario_count !== binding.plan.scenarios.length
    ) {
      throw new Error(
        'fresh-tenant install evidence differs from the completed lineage',
      );
    }
    return document;
  });
}

/**
 * What the approver of one release edge is shown and what the approval binds:
 * the compiler's canonical diff digest and the digest of the plain-language
 * rendering of it (CUSTOMIZE). A reverse edge -- a rollback -- binds the
 * forward diff it undoes, read backwards.
 */
export interface ReleaseDiffBinding {
  readonly canonicalDiffDigest: string;
  readonly renderedDigest: string;
  readonly renderedText: string;
  readonly transitionPlanDigest: string | null;
}

export function releaseDiffBinding(
  source: ParsedRelease,
  target: ParsedRelease,
  direction: 'forward' | 'reverse' = 'forward',
): ReleaseDiffBinding {
  const [from, to] =
    direction === 'forward' ? [source, target] : [target, source];
  const diff = diffCompiledReleases(from.compiled, to.compiled);
  const rendered = renderCompiledDiff(from, to, diff, direction);
  return Object.freeze({
    canonicalDiffDigest: diff.canonicalDiffDigest,
    renderedDigest: rendered.renderedDigest,
    renderedText: rendered.text,
    transitionPlanDigest: diff.transitionPlanDigest,
  });
}

async function approveInitialRelease(
  pool: pg.Pool,
  context: TrustedRequestContext,
  approverContext: TrustedRequestContext,
  pointer: PointerState,
  target: PersistedReleaseIdentity,
  compiled: CompileSuccess,
  freshTenantBinding: FreshTenantPreparationBinding,
): Promise<MintedUuid> {
  const receiptId = minted(randomUUID());
  const preparationId = minted(randomUUID());
  const targetRoot = Buffer.from(compiled.releaseRoot, 'hex');
  await withTrustedRequestTransaction(pool, context, async (client) => {
    await client.query(
      `INSERT INTO platform.transition_preparation_receipts (
         tenant_id, environment_id, receipt_id, receipt_version,
         source_release_id, source_manifest_root, target_release_id,
         target_manifest_root, transition_scope, storage_domain_id,
         schema_generation, compiler_facts_version, compiler_facts_digest,
         compiler_transition_class, compiler_static_compatibility,
         compiler_exact_pair, executor_evidence_version,
         executor_evidence_digest, executor_applied_state, executor_exact_pair,
         compatibility_policy_version, compatibility_policy_verdict,
         recovery_mode
       ) VALUES (
         $1,$2,$3,$4,NULL,NULL,$5,$6,'tenantLocal','tenant-primary-storage',$7,
         $8,$9,'NO_STORAGE_TRANSITION','SATISFIED',true,$10,$11,
         'NOT_REQUIRED',true,$12,'ALLOW','NO_STORAGE_RECOVERY_REQUIRED'
       )`,
      [
        context.tenantId,
        context.environmentId,
        receiptId,
        TRANSITION_PREPARATION_RECEIPT_VERSION,
        target.releaseId,
        targetRoot,
        pointer.fence,
        COMPILER_TRANSITION_FACTS_VERSION,
        digest('initial-compiler-facts', compiled.releaseRoot),
        EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
        digest('initial-executor-evidence', compiled.releaseRoot),
        TRANSITION_COMPATIBILITY_POLICY_VERSION,
      ],
    );
    await insertReleasePreparation(client, {
      bindingKind: 'INITIAL_ACTIVATION',
      bindingVersion: INITIAL_ACTIVATION_BINDING_VERSION,
      compiled,
      context,
      evidenceId: target.evidenceId,
      ...(freshTenantBinding ? { freshTenantBinding } : {}),
      pointer,
      preparationId,
      receiptId,
      sourceRoot: null,
      targetReleaseId: target.releaseId,
      transitionPlanDigest: null,
    });
  });
  return createApproval(
    pool,
    context,
    approverContext,
    preparationId,
    target.releaseId,
  );
}

export async function approveModuleRelease(
  pool: pg.Pool,
  context: TrustedRequestContext,
  approverContext: TrustedRequestContext,
  pointer: PointerState,
  target: PersistedReleaseIdentity,
  compiled: CompileSuccess,
  prepared: Awaited<ReturnType<PostgresModuleStorageMaterializer['prepare']>>,
  preparationId: MintedUuid,
  diffBinding: ReleaseDiffBinding,
  freshTenantBinding?: FreshTenantPreparationBinding,
  customizationUpgradeId?: MintedUuid,
): Promise<MintedUuid> {
  // The approver's diff and the plan the executor prepared are one plan.
  if (
    diffBinding.transitionPlanDigest === null ||
    !Buffer.from(diffBinding.transitionPlanDigest, 'hex').equals(
      Buffer.from(prepared.transitionPlanDigest),
    )
  ) {
    throw new Error(
      'the release diff and the prepared storage transition name different plans',
    );
  }
  const receiptId = minted(randomUUID());
  await withTrustedRequestTransaction(pool, context, async (client) => {
    await client.query(
      `INSERT INTO platform.transition_preparation_receipts (
         tenant_id, environment_id, receipt_id, receipt_version,
         source_release_id, source_manifest_root, target_release_id,
         target_manifest_root, transition_scope, storage_domain_id,
         schema_generation, compiler_facts_version, compiler_facts_digest,
         compiler_transition_class, compiler_static_compatibility,
         compiler_exact_pair, executor_evidence_version,
         executor_evidence_digest, executor_applied_state, executor_exact_pair,
         compatibility_policy_version, compatibility_policy_verdict,
         recovery_mode, generation_id, prepared_subset_digest,
         remaining_plan_digest, executor_schema_state, executor_data_state
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'sharedDatabase','north_star_module',$9,
         $10,$11,'REVERSIBLE','SATISFIED',true,$12,$13,'APPLIED',true,
         $14,'ALLOW','REVERSIBLE',$15,$16,$17,'APPLIED',$18
       )`,
      [
        context.tenantId,
        context.environmentId,
        receiptId,
        TRANSITION_PREPARATION_RECEIPT_V2_VERSION,
        pointer.releaseId,
        Buffer.from(prepared.sourceManifestRoot),
        target.releaseId,
        Buffer.from(prepared.targetManifestRoot),
        prepared.generationNumber,
        COMPILER_TRANSITION_FACTS_VERSION,
        digest('module-compiler-facts', compiled.releaseRoot),
        EXECUTOR_APPLIED_STATE_EVIDENCE_V2_VERSION,
        digest('module-executor-evidence', compiled.releaseRoot),
        TRANSITION_COMPATIBILITY_POLICY_V2_VERSION,
        prepared.generationId,
        Buffer.from(prepared.preparedSubsetDigest),
        Buffer.from(prepared.remainingPlanDigest),
        prepared.dataState,
      ],
    );
    await insertReleasePreparation(client, {
      bindingKind: 'RELEASE_DIFF',
      bindingVersion: RELEASE_DIFF_BINDING_VERSION,
      compiled,
      context,
      diffBinding,
      evidenceId: target.evidenceId,
      ...(freshTenantBinding ? { freshTenantBinding } : {}),
      pointer,
      preparationId,
      receiptId,
      sourceRoot: Buffer.from(prepared.sourceManifestRoot),
      targetReleaseId: target.releaseId,
      transitionPlanDigest: Buffer.from(prepared.transitionPlanDigest),
    });
  });
  return createApproval(
    pool,
    context,
    approverContext,
    preparationId,
    target.releaseId,
    customizationUpgradeId,
  );
}

export async function approveReleaseWithoutStorageTransition(
  pool: pg.Pool,
  context: TrustedRequestContext,
  approverContext: TrustedRequestContext,
  pointer: PointerState,
  source: ParsedRelease,
  target: PersistedReleaseIdentity,
  compiled: CompileSuccess,
  diffBinding: ReleaseDiffBinding,
  reverseAuthorization?: ReleaseReverseTransitionAuthorization,
  freshTenantBinding?: FreshTenantPreparationBinding,
  customizationUpgradeId?: MintedUuid,
): Promise<MintedUuid> {
  if (pointer.releaseId === null) {
    throw new Error('release advancement requires an active source release');
  }
  const receiptId = minted(randomUUID());
  const preparationId = minted(randomUUID());
  const sourceRoot = Buffer.from(source.compiled.releaseRoot, 'hex');
  const targetRoot = Buffer.from(compiled.releaseRoot, 'hex');
  await withTrustedRequestTransaction(pool, context, async (client) => {
    await client.query(
      `INSERT INTO platform.transition_preparation_receipts (
         tenant_id, environment_id, receipt_id, receipt_version,
         source_release_id, source_manifest_root, target_release_id,
         target_manifest_root, transition_scope, storage_domain_id,
         schema_generation, compiler_facts_version, compiler_facts_digest,
         compiler_transition_class, compiler_static_compatibility,
         compiler_exact_pair, executor_evidence_version,
         executor_evidence_digest, executor_applied_state, executor_exact_pair,
         compatibility_policy_version, compatibility_policy_verdict,
         recovery_mode
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'tenantLocal','tenant-primary-storage',$9,
         $10,$11,'NO_STORAGE_TRANSITION','SATISFIED',true,$12,$13,
         'NOT_REQUIRED',true,$14,'ALLOW','NO_STORAGE_RECOVERY_REQUIRED'
       )`,
      [
        context.tenantId,
        context.environmentId,
        receiptId,
        TRANSITION_PREPARATION_RECEIPT_VERSION,
        pointer.releaseId,
        sourceRoot,
        target.releaseId,
        targetRoot,
        pointer.fence,
        COMPILER_TRANSITION_FACTS_VERSION,
        reverseAuthorization
          ? digest(
              'reverse-pointer-transition-facts',
              reverseAuthorization.policyVersion,
              reverseAuthorization.forwardReceiptId,
              reverseAuthorization.forwardTransitionClass,
              reverseAuthorization.forwardRecoveryMode,
              source.compiled.releaseRoot,
              compiled.releaseRoot,
            )
          : digest(
              'no-storage-compiler-facts',
              source.compiled.releaseRoot,
              compiled.releaseRoot,
            ),
        EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
        reverseAuthorization
          ? digest(
              'reverse-pointer-storage-preservation',
              reverseAuthorization.policyVersion,
              reverseAuthorization.forwardActivationAttemptId,
              reverseAuthorization.forwardReceiptId,
              source.compiled.releaseRoot,
              compiled.releaseRoot,
            )
          : digest(
              'no-storage-executor-evidence',
              source.compiled.releaseRoot,
              compiled.releaseRoot,
            ),
        TRANSITION_COMPATIBILITY_POLICY_VERSION,
      ],
    );
    await insertReleasePreparation(client, {
      bindingKind: 'RELEASE_DIFF',
      bindingVersion: RELEASE_DIFF_BINDING_VERSION,
      compiled,
      context,
      diffBinding,
      evidenceId: target.evidenceId,
      ...(freshTenantBinding ? { freshTenantBinding } : {}),
      pointer,
      preparationId,
      receiptId,
      sourceRoot,
      targetReleaseId: target.releaseId,
      transitionPlanDigest: null,
    });
  });
  return createApproval(
    pool,
    context,
    approverContext,
    preparationId,
    target.releaseId,
    customizationUpgradeId,
  );
}

async function insertReleasePreparation(
  client: pg.PoolClient,
  input: {
    readonly bindingKind: 'INITIAL_ACTIVATION' | 'RELEASE_DIFF';
    readonly bindingVersion: string;
    readonly compiled: CompileSuccess;
    readonly context: TrustedRequestContext;
    /** Absent only for the initial activation, which has no prior release. */
    readonly diffBinding?: ReleaseDiffBinding;
    readonly evidenceId: MintedUuid;
    readonly freshTenantBinding?: FreshTenantPreparationBinding;
    readonly pointer: PointerState;
    readonly preparationId: MintedUuid;
    readonly receiptId: MintedUuid;
    readonly sourceRoot: Buffer | null;
    readonly targetReleaseId: MintedUuid;
    readonly transitionPlanDigest: Buffer | null;
  },
): Promise<void> {
  if (input.bindingKind === 'RELEASE_DIFF' && !input.diffBinding) {
    throw new Error('a release-diff preparation requires the release diff');
  }
  const targetRoot = Buffer.from(input.compiled.releaseRoot, 'hex');
  const evidence = input.freshTenantBinding
    ? await client.query<{
        evidence_version: string;
        result_set_digest: string;
      }>(
        `SELECT evidence_version, evidence_digest AS result_set_digest
           FROM platform.fresh_tenant_intermediate_release_admissions
                AS intermediate
          WHERE intermediate.tenant_id = $1
            AND intermediate.environment_id = $2
            AND intermediate.release_evidence_id = $3
            AND intermediate.release_root = $4
            AND intermediate.release_id = $5
            AND intermediate.install_id = $6
            AND intermediate.lineage_ordinal = $7
            AND intermediate.source_release_root IS NOT DISTINCT FROM $8
            AND NOT EXISTS (
              SELECT 1
                FROM platform.fresh_tenant_install_evidence
               WHERE tenant_id = intermediate.tenant_id
                 AND environment_id = intermediate.environment_id
                 AND install_id = intermediate.install_id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM platform.release_verification_evidence
               WHERE tenant_id = $1
                 AND environment_id = $2
                 AND verification_evidence_id = $3
                 AND release_root = $4
            )`,
        [
          input.context.tenantId,
          input.context.environmentId,
          input.evidenceId,
          input.compiled.releaseRoot,
          input.targetReleaseId,
          input.freshTenantBinding.installId,
          input.freshTenantBinding.lineageOrdinal,
          input.sourceRoot?.toString('hex') ?? null,
        ],
      )
    : await client.query<{
        evidence_version: string;
        result_set_digest: string;
      }>(
        `SELECT evidence_version, result_set_digest
           FROM platform.release_verification_evidence
          WHERE tenant_id = $1
            AND environment_id = $2
            AND verification_evidence_id = $3
            AND release_root = $4`,
        [
          input.context.tenantId,
          input.context.environmentId,
          input.evidenceId,
          input.compiled.releaseRoot,
        ],
      );
  const verified = evidence.rows.length === 1 ? evidence.rows[0] : undefined;
  if (!verified) {
    throw new Error(
      'canonical release preparation requires one durable verification or intermediate-install evidence record',
    );
  }
  await client.query(
    `INSERT INTO platform.release_activation_preparations (
       tenant_id, environment_id, preparation_id, preparation_version,
       expected_pointer_id, expected_release_id, expected_fence,
       source_manifest_root, target_release_id, target_manifest_root,
       diff_binding_kind, diff_binding_version, release_diff_version,
       release_diff_algorithm_version, canonical_diff_digest,
       transition_plan_digest, compiler_attestation_digest, compiler_version,
       compiler_semantic_profile_version, compiler_output_protocol_version,
       verification_evidence_id, verification_evidence_version,
       verification_evidence_digest, capability_support_version,
       capability_support_digest, capability_support_result, renderer_version,
       view_schema_version, rendered_diff_evidence_digest,
       transition_preparation_receipt_id, fresh_tenant_install_id,
       fresh_tenant_lineage_ordinal
     ) VALUES (
       $1,$2,$3,'northstar.release-activation-preparation/v1',$4,$5,$6,$7,$8,$9,
       $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
       'SUPPORTED',$25,$26,$27,$28,$29,$30
     )`,
    [
      input.context.tenantId,
      input.context.environmentId,
      input.preparationId,
      input.pointer.pointerId,
      input.pointer.releaseId,
      input.pointer.fence,
      input.sourceRoot,
      input.targetReleaseId,
      targetRoot,
      input.bindingKind,
      input.bindingVersion,
      input.bindingKind === 'INITIAL_ACTIVATION'
        ? null
        : 'northstar.release-diff/v0-experimental',
      input.bindingKind === 'INITIAL_ACTIVATION'
        ? null
        : 'northstar.release-diff-algorithm/v1',
      input.diffBinding
        ? Buffer.from(input.diffBinding.canonicalDiffDigest, 'hex')
        : digest(
            'canonical-diff',
            input.pointer.pointerId,
            input.compiled.releaseRoot,
          ),
      input.transitionPlanDigest,
      Buffer.from(input.compiled.attestation.attestationDigest, 'hex'),
      input.compiled.bundle.releaseManifest.compilerVersion,
      input.compiled.bundle.releaseManifest.compilerSemanticProfileVersion,
      input.compiled.bundle.releaseManifest.outputProtocolVersion,
      input.evidenceId,
      verified.evidence_version,
      Buffer.from(verified.result_set_digest, 'hex'),
      capabilitySupportVersion,
      digest('capability-support', input.compiled.releaseRoot),
      rendererVersion,
      viewSchemaVersion,
      input.diffBinding
        ? Buffer.from(input.diffBinding.renderedDigest, 'hex')
        : digest('rendered-diff', input.compiled.releaseRoot),
      input.receiptId,
      input.freshTenantBinding?.installId ?? null,
      input.freshTenantBinding?.lineageOrdinal ?? null,
    ],
  );
}

async function createApproval(
  pool: pg.Pool,
  initiatingContext: TrustedRequestContext,
  approverContext: TrustedRequestContext,
  preparationId: MintedUuid,
  targetReleaseId: MintedUuid,
  customizationUpgradeId?: MintedUuid,
): Promise<MintedUuid> {
  const activationAttemptId = minted(randomUUID());
  const created = await new PostgresReleaseApprovalService(pool).createApproval(
    approverContext,
    {
      activationAttemptId,
      ...(customizationUpgradeId
        ? { customizationUpgradeId, sourceDecisionId: customizationUpgradeId }
        : {}),
      approvalId: minted(randomUUID()),
      approvingHumanId: approverContext.principalId,
      initiatingHumanId: initiatingContext.principalId,
      issuingActorId: approverContext.principalId,
      preparationId,
      targetReleaseId,
    },
  );
  return created.attempt.activationAttemptId;
}

export async function readPointer(
  pool: pg.Pool,
  context: TrustedRequestContext,
): Promise<PointerState> {
  return withTrustedRequestTransaction(pool, context, async (client) => {
    const result = await client.query<{
      fence: string;
      pointer_id: MintedUuid;
      release_id: MintedUuid | null;
    }>(
      `SELECT pointer_id, release_id, fence
         FROM platform.active_release_pointers
        WHERE tenant_id = $1 AND environment_id = $2`,
      [context.tenantId, context.environmentId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('active release pointer is missing');
    return Object.freeze({
      fence: Number.parseInt(row.fence, 10),
      pointerId: row.pointer_id,
      releaseId: row.release_id,
    });
  });
}

/**
 * An admin connection or pool. Holding `withReleaseScopeLock`, pass the held
 * client: a second pool connection can wait forever behind a caller queued on
 * the same lock (CUSTOMIZE review R1).
 */
export type AdminQueryable = pg.Pool | pg.PoolClient;

export async function activateWithExactSwapTrigger(
  adminPool: AdminQueryable,
  activation: PostgresReleaseActivationService,
  systemContext: TrustedRequestContext,
  activationAttemptId: MintedUuid,
) {
  await assertExactSwapTriggerEnabled(adminPool);
  try {
    return await activation.activate(systemContext, { activationAttemptId });
  } finally {
    await assertExactSwapTriggerEnabled(adminPool);
  }
}

export async function assertExactSwapTriggerEnabled(
  pool: AdminQueryable,
): Promise<void> {
  const result = await (pool as pg.PoolClient).query<{ enabled: string }>(
    `SELECT tgenabled AS enabled
       FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'platform.active_release_pointers'::regclass
        AND tgname = 'active_release_pointer_exact_swap'
        AND NOT tgisinternal`,
  );
  if (result.rows[0]?.enabled !== 'O') {
    throw new Error('active_release_pointer_exact_swap is not enabled');
  }
}

export function rolePool(
  databaseUrl: string,
  user: string,
  max: number,
): pg.Pool {
  const connection = new URL(databaseUrl);
  connection.username = user;
  connection.password = '';
  const pool = new pg.Pool({ connectionString: connection.href, max });
  pool.on('error', () => undefined);
  // Counting only: a request's statements reach its work meter (SPEED-1).
  return meterPoolStatements(pool);
}

function humanActorIssuer(): TrustedActorEnvelopeIssuer {
  return new TrustedActorEnvelopeIssuer({
    async resolve(context) {
      return {
        approvingHumanId: null,
        delegation: null,
        executionPrincipal: {
          kind: 'HUMAN',
          principalId: context.principalId,
        },
        initiatingHumanId: context.principalId,
        subject: null,
      };
    },
  });
}

export async function trustedContext(
  identity: AuthenticatedIdentity,
): Promise<TrustedRequestContext> {
  return new AuthenticatedRequestEntryAdapter(async () => identity).enter({});
}

function digest(label: string, ...values: string[]): Buffer {
  const hash = createHash('sha256').update(
    'northstar.composed-application-runtime/v1\0',
  );
  hash.update(label);
  for (const value of values) hash.update('\0').update(value);
  return hash.digest();
}

function stableUuid(label: string): string {
  const bytes = createHash('sha256')
    .update('northstar.local-composed-identity/v1\0')
    .update(label)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodeBase64(value: unknown, path: string): Uint8Array {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${path} is invalid`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new TypeError(`${path} is not canonical base64`);
  }
  return new Uint8Array(decoded);
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} was not persisted`);
  return value;
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
