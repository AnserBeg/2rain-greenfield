import { PostgresAddresses } from './address-geocodes.js';
import { BILLING_QUOTE_CAPABILITY } from '../../canonical-model/src/billing.js';
import { billingQuoteReadModel } from './billing-quote.js';
import type { DocumentScanner } from './document-content.js';
import {
  PostgresDocumentGateway,
  documentPermissionBindings,
} from './document-attachments.js';
import { PostgresDocumentPublication } from './document-publication.js';
import type pg from 'pg';
import { parseNormalizedApplicationPackageJson } from '@north-star/canonical-model';
import {
  SUPPORTED_STORAGE_TARGET_PAYLOAD_VERSIONS,
  type StorageTargetPayloadV1,
  PROJECTION_FAMILY_IDS,
  type CompileSuccess,
} from '@north-star/compiler';
import type { ObservabilityMetrics } from '@north-star/observability';
import { monotonicMilliseconds } from '@north-star/observability';
import type { MintedUuid } from '@north-star/platform-runtime';
import type { TrustedRequestContext } from '@north-star/runtime';
import {
  SemanticOperationGateway,
  parsePinnedOperationCatalog,
  type SemanticOperationMediationAuthority,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SemanticQueryGateway,
  type RegisteredQueryLatencyInstrumentation,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  capabilityMediationAuthority,
  createRegisteredCapabilityExecutors,
  registeredCapabilityIdsFromOperationCatalog,
  type PinnedCapabilityProjection,
  type PostgresCapabilityOperationExecutorFactory,
} from './capability-operation-executor-factory.js';
import {
  PostgresModuleRuntimeInterpreter,
  type ModuleProviderErrorMapping,
} from './module-runtime-interpreter.js';
import {
  ADDRESS_CONNECTOR_CONFIGURE_BINDING,
  PostgresCurrentPolicyGateway,
  PostgresSemanticQueryDenialRecorder,
  currentPolicyBindingsFromPermissions,
} from './current-policy.js';
import { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';
import { PostgresImmutableReleaseRepository } from './release-repository.js';
import {
  detachedFromReadSnapshot,
  withoutReadSnapshot,
  withTrustedRequestTransaction,
} from './request-context.js';
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
import { inventoryCountReadModel } from './inventory-count-read-model.js';
import { INVENTORY_POSTING_CAPABILITY_ID } from './inventory-posting-service.js';
import { RECEIVING_CAPABILITY_ID } from './goods-receipt.js';
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function composeServingGateways(
  runtimePool: pg.Pool,
  evidencePool: pg.Pool,
  runtimeContext: TrustedRequestContext,
  serving: ServingRelease,
  metrics: ObservabilityMetrics,
  options: {
    readonly providerErrorMappings: readonly ModuleProviderErrorMapping[];
    readonly capabilityOperationExecutorFactories?: readonly PostgresCapabilityOperationExecutorFactory[];
    readonly approvalPool?: pg.Pool;
    readonly localDemoIdentity?: true;
    readonly monotonicMilliseconds?: () => number;
  },
  documentOptions?: {
    scanner?: DocumentScanner | undefined;
    scannerPool?: pg.Pool | undefined;
  },
) {
  const actorIssuer = humanActorIssuer();
  const interpreter: PostgresModuleRuntimeInterpreter =
    new PostgresModuleRuntimeInterpreter(
      runtimePool,
      actorIssuer,
      options.providerErrorMappings,
      undefined,
      undefined,
      {
        validationReadPolicy: async (releaseId) =>
          (await servingFor(releaseId)).policy,
      },
    );
  const operationMediation = capabilityMediationAuthority(
    options.capabilityOperationExecutorFactories ?? [],
  );
  const documentPublication = new PostgresDocumentPublication();
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
    [BILLING_QUOTE_CAPABILITY]: billingQuoteReadModel(runtimePool),
    [FULFILLMENT_CAPABILITY_ID]: fulfillmentReadModel,
    [COMMERCIAL_CAPABILITY_ID]: commercialReadModelWithInventoryCost,
    [VALUATION_CAPABILITY_ID]: inventoryValuationReadModel,
    // A receipt's lines with what each can still reverse (ORDER-PARITY).
    [RECEIVING_CAPABILITY_ID]: receivingReadModel,
    [INVENTORY_POSTING_CAPABILITY_ID]: inventoryCountReadModel,
  };
  // Release-scoped state -- the policy bindings of a release's permissions
  // and the capability executors pinned to its id, root and projections --
  // is built per release and chosen per request by the release the request's
  // view was issued against. An activation by another process (the
  // customize command, the Customize screen) is served by the next request
  // without a restart (CUSTOMIZE).
  const policyFor = (release: ServingRelease) =>
    new PostgresCurrentPolicyGateway(
      runtimePool,
      [
        ...releasePolicyBindings(
          release.normalizedDefinitionBytes,
          documentOptions !== undefined,
        ),
        ADDRESS_CONNECTOR_CONFIGURE_BINDING,
      ],
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
        pool: runtimePool,
        verifyConfirmation:
          operationMediation.assertConfirmationGrant.bind(operationMediation),
        ...(options.approvalPool ? { approvalPool: options.approvalPool } : {}),
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
        documentOptions
          ? [...capabilityExecutors, documentPublication]
          : capabilityExecutors,
      ),
      policy,
      queryGateway,
      storage: (() => {
        if (!documentOptions) return null;
        const payload = release.projection(
          PROJECTION_FAMILY_IDS.storageTarget,
        ).payload;
        return typeof payload === 'object' &&
          payload !== null &&
          'schemaVersion' in payload &&
          SUPPORTED_STORAGE_TARGET_PAYLOAD_VERSIONS.some(
            (version) => version === payload.schemaVersion,
          )
          ? (payload as unknown as StorageTargetPayloadV1)
          : null;
      })(),
    });
  };
  const servingFor = releaseServingRoute(
    (releaseId) =>
      loadServingRelease(runtimePool, runtimeContext, releaseId as MintedUuid),
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
  const addresses = new PostgresAddresses(
    runtimePool,
    queryGateway,
    servingFor,
    options.localDemoIdentity === true,
  );
  const documents = documentOptions
    ? new PostgresDocumentGateway(
        runtimePool,
        queryGateway,
        servingFor,
        documentOptions.scanner,
        documentOptions.scannerPool,
        documentPublication,
        operationGateway,
        operationMediation,
      )
    : null;
  return {
    policy,
    operationGateway,
    queryGateway,
    operationMediation,
    addresses,
    documents,
  };
}
/** One release as the serving runtime needs it, from the lineage or the database. */
export interface ServingRelease {
  readonly normalizedDefinitionBytes: Uint8Array;
  readonly projection: (familyId: string) => PinnedCapabilityProjection;
  readonly releaseId: MintedUuid;
  readonly releaseRoot: string;
}

interface ReleaseServing {
  readonly storage: StorageTargetPayloadV1 | null;
  readonly operationGateway: SemanticOperationGateway;
  readonly policy: PostgresCurrentPolicyGateway;
  readonly queryGateway: SemanticQueryGateway;
}

/** A registered release read back from its immutable rows. */
export async function loadServingRelease(
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

export function projectionBinding(
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

export function requiredProjection(compiled: CompileSuccess, familyId: string) {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (projection) => projection.familyId === familyId,
  );
  if (!reference) {
    throw new Error(`compiled release is missing ${familyId}`);
  }
  return reference;
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

export function releasePolicyBindings(
  definitionBytes: Uint8Array,
  documents: boolean,
) {
  const definition = parseNormalizedApplicationPackageJson(definitionBytes);
  return [
    ...currentPolicyBindingsFromPermissions(definition.permissions),
    ...(documents ? documentPermissionBindings(definition.entities) : []),
  ];
}
