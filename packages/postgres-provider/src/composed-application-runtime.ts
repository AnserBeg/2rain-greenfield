import { createHash, randomUUID } from 'node:crypto';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  canonicalizeAndHash,
} from '@north-star/canonical-model';
import type {
  CompileSuccess,
  ContentAddressedArtifact,
  StorageTransitionEnvelope,
} from '@north-star/compiler';
import {
  PROJECTION_FAMILY_IDS,
  STORAGE_TRANSITION_ENVELOPE_VERSION,
} from '@north-star/compiler';
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
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '@north-star/runtime';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
} from '@north-star/runtime/request-runtime-view';
import pg from 'pg';

import {
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
} from '../../runtime/src/semantic-operation-gateway.js';
import { SemanticQueryGateway } from '../../runtime/src/semantic-query-gateway.js';
import { loadMigrations, runMigrations } from './migrations.js';
import { PostgresModuleRuntimeInterpreter } from './module-runtime-interpreter.js';
import { PostgresModuleStorageMaterializer } from './module-storage-materializer.js';
import { PostgresReleaseActivationService } from './release-activation-service.js';
import { PostgresReleaseApprovalService } from './release-approval-service.js';
import { PostgresImmutableReleaseRepository } from './release-repository.js';
import { PostgresReleaseVerificationService } from './release-verification-service.js';
import { PostgresRequestRuntimeViewService } from './request-runtime-view-service.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';

const compiledApplicationVersion =
  'northstar.web:compiled-application-release/v1' as const;
const compiledApplicationLineageVersion =
  'northstar.web:compiled-application-release/v2' as const;
const capabilitySupportVersion = 'northstar.capability-support/v1' as const;
const rendererVersion = 'northstar.release-diff-renderer/v1' as const;
const viewSchemaVersion = 'northstar.release-diff-view/v1' as const;

export interface ComposedApplicationRuntimeOptions {
  readonly compiledApplication: unknown;
  readonly databaseUrl: string;
  readonly environmentSlug?: string;
  readonly migrationsDirectory: string;
  readonly tenantSlug: string;
}

export interface ComposedApplicationRuntime {
  readonly activeReleaseId: MintedUuid;
  readonly entry: AuthenticatedRequestRuntimeEntryAdapter;
  readonly identity: AuthenticatedIdentity;
  readonly operationGateway: SemanticOperationGateway;
  readonly operationMediation: SemanticOperationMediationAuthority;
  readonly queryGateway: SemanticQueryGateway;
  readonly releaseRoot: string;
  readonly triggerEnabledDuringActivation: true;
  close(): Promise<void>;
}

interface ParsedApplicationRelease {
  readonly application: ParsedRelease;
  readonly applications: readonly ParsedRelease[];
  readonly bootstrap: ParsedRelease;
}

interface ParsedRelease {
  readonly compiled: CompileSuccess;
  readonly normalizedDefinitionBytes: Uint8Array;
}

interface PersistedReleaseIdentity {
  readonly evidenceId: MintedUuid;
  readonly releaseId: MintedUuid;
  readonly revisionId: MintedUuid;
}

interface ScopeIdentities {
  readonly approver: AuthenticatedIdentity;
  readonly authorityOperatorId: string;
  readonly runtime: AuthenticatedIdentity;
  readonly system: AuthenticatedIdentity;
}

interface PointerState {
  readonly fence: number;
  readonly pointerId: MintedUuid;
  readonly releaseId: MintedUuid | null;
}

/**
 * Provider-owned assembly for the local composed product. Serving code passes
 * a checked-in compiler result; it never compiles, mutates a release pointer,
 * or executes module SQL itself.
 */
export async function createComposedApplicationRuntime(
  options: ComposedApplicationRuntimeOptions,
): Promise<ComposedApplicationRuntime> {
  if (options.tenantSlug.trim() === '') {
    throw new TypeError('tenantSlug must not be blank');
  }
  const releases = parseCompiledApplication(options.compiledApplication);
  const releaseLineage = releasesForLineage(releases);
  for (let index = 1; index < releaseLineage.length; index += 1) {
    assertExactCompiledTransition(
      releaseLineage[index - 1]!,
      releaseLineage[index]!,
    );
  }
  const adminPool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 2,
  });
  adminPool.on('error', () => undefined);

  let runtimePool: pg.Pool | undefined;
  let materializerPool: pg.Pool | undefined;
  let modulePool: pg.Pool | undefined;
  try {
    await migrate(adminPool, options.migrationsDirectory);
    const identities = await ensureScope(
      adminPool,
      options.tenantSlug,
      options.environmentSlug ?? 'production',
    );
    await ensureAuthority(adminPool, identities);

    runtimePool = rolePool(options.databaseUrl, 'north_star_runtime', 6);
    materializerPool = rolePool(
      options.databaseUrl,
      'north_star_module_materializer',
      2,
    );
    modulePool = rolePool(options.databaseUrl, 'north_star_module_runtime', 2);

    const runtimeContext = await trustedContext(identities.runtime);
    const approverContext = await trustedContext(identities.approver);
    const systemContext = await trustedContext(identities.system);
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
    let pointer = await readPointer(runtimePool, runtimeContext);
    if (pointer.releaseId === null) {
      await ensureReleaseAdmitted(
        runtimePool,
        runtimeContext,
        bootstrapIdentity,
        releases.bootstrap,
      );
      await assertExactSwapTriggerEnabled(adminPool);
      const attemptId = await approveInitialRelease(
        runtimePool,
        runtimeContext,
        approverContext,
        pointer,
        bootstrapIdentity,
        releases.bootstrap.compiled,
      );
      const activated = await activateWithExactSwapTrigger(
        adminPool,
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
    }

    const lineage = [bootstrapIdentity, ...applicationIdentities];
    const activeLineageIndex = lineage.findIndex(
      (identity) => identity.releaseId === pointer.releaseId,
    );
    if (activeLineageIndex < 0) {
      throw new Error(
        'the active pointer names a release outside this composed application lineage',
      );
    }
    await ensureReleaseAdmitted(
      runtimePool,
      runtimeContext,
      lineage[activeLineageIndex]!,
      releaseLineage[activeLineageIndex]!,
    );
    const materializer = new PostgresModuleStorageMaterializer(
      materializerPool,
      modulePool,
    );
    for (
      let targetIndex = activeLineageIndex + 1;
      targetIndex < lineage.length;
      targetIndex += 1
    ) {
      const source = releaseLineage[targetIndex - 1]!;
      const target = releaseLineage[targetIndex]!;
      const targetIdentity = lineage[targetIndex]!;
      const transition = assertExactCompiledTransition(source, target);
      await assertExactSwapTriggerEnabled(adminPool);
      const generationId = minted(randomUUID());
      const preparationId = minted(randomUUID());
      let attemptId: MintedUuid;
      if (transition.elements.length === 0) {
        await ensureReleaseAdmitted(
          runtimePool,
          runtimeContext,
          targetIdentity,
          target,
        );
        attemptId = await approveReleaseWithoutStorageTransition(
          runtimePool,
          runtimeContext,
          approverContext,
          pointer,
          source,
          targetIdentity,
          target.compiled,
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
        await ensureReleaseAdmitted(
          runtimePool,
          runtimeContext,
          targetIdentity,
          target,
        );
        attemptId = await approveModuleRelease(
          runtimePool,
          runtimeContext,
          approverContext,
          pointer,
          targetIdentity,
          target.compiled,
          prepared,
          preparationId,
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
        adminPool,
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
      if (pointer.releaseId !== targetIdentity.releaseId) {
        throw new Error(
          'composed release activation selected the wrong target',
        );
      }
    }
    await assertExactSwapTriggerEnabled(adminPool);
    const applicationIdentity = applicationIdentities.at(-1)!;

    const policy = new AllowAllLocalPolicy();
    const interpreter = new PostgresModuleRuntimeInterpreter(
      runtimePool,
      humanActorIssuer(),
    );
    const queryGateway = new SemanticQueryGateway(policy, interpreter);
    const operationMediation = new SemanticOperationMediationAuthority();
    const operationGateway = new SemanticOperationGateway(
      policy,
      interpreter,
      operationMediation,
    );
    const entry = new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(async () => identities.runtime),
      new PostgresRequestRuntimeViewService(runtimePool),
      policy,
    );
    const pools = [runtimePool, materializerPool, modulePool, adminPool];
    let closed = false;

    return Object.freeze({
      activeReleaseId: applicationIdentity.releaseId,
      async close() {
        if (closed) return;
        closed = true;
        await Promise.all(pools.map((pool) => pool.end()));
      },
      entry,
      identity: identities.runtime,
      operationGateway,
      operationMediation,
      queryGateway,
      releaseRoot: releases.application.compiled.releaseRoot,
      triggerEnabledDuringActivation: true as const,
    });
  } catch (error) {
    await Promise.all(
      [runtimePool, materializerPool, modulePool, adminPool]
        .filter((pool): pool is pg.Pool => pool !== undefined)
        .map((pool) => pool.end().catch(() => undefined)),
    );
    throw error;
  }
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

class AllowAllLocalPolicy implements CurrentPolicyGateway {
  async authorize(_request: CurrentPolicyDecisionRequest) {
    void _request;
    return Object.freeze({
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'northstar.local-composed-policy/v1',
    });
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return Object.freeze({
      policyVersion: 'northstar.local-composed-policy/v1',
    });
  }
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

function releasesForLineage(
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
  return JSON.parse(new TextDecoder().decode(chunk.canonicalBytes)) as unknown;
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

async function migrate(pool: pg.Pool, directory: string): Promise<void> {
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

async function ensureScope(
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
    system: Object.freeze({
      environmentId,
      principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
      tenantId,
    }),
  });
}

async function ensureAuthority(
  pool: pg.Pool,
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

async function ensurePersistedRelease(
  pool: pg.Pool,
  context: TrustedRequestContext,
  release: ParsedRelease,
  parentRevisionId: MintedUuid | null,
): Promise<PersistedReleaseIdentity> {
  const digest = canonicalizeAndHash(
    JSON.parse(
      new TextDecoder().decode(release.normalizedDefinitionBytes),
    ) as unknown,
  );
  const existingRevision = await withTrustedRequestTransaction(
    pool,
    context,
    async (client) =>
      client.query<{ revision_id: MintedUuid }>(
        `SELECT revision_id
           FROM platform.app_package_revisions
          WHERE tenant_id = $1 AND content_hash = $2
          ORDER BY created_at LIMIT 1`,
        [context.tenantId, digest.contentHash],
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
      languageVersion: LANGUAGE_VERSION,
      normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
      parentRevisionId,
      provenance: 'firstParty',
      revisionId,
      schemaVersion: LANGUAGE_VERSION,
      tenantId: context.tenantId,
    });
  }
  const existingRelease = await withTrustedRequestTransaction(
    pool,
    context,
    async (client) =>
      client.query<{
        release_id: MintedUuid;
        verification_evidence_id: MintedUuid;
      }>(
        `SELECT release_id, verification_evidence_id
           FROM platform.tenant_releases
          WHERE tenant_id = $1 AND environment_id = $2 AND content_hash = $3
          ORDER BY created_at LIMIT 1`,
        [context.tenantId, context.environmentId, release.compiled.releaseRoot],
      ),
  );
  let releaseId = existingRelease.rows[0]?.release_id;
  let evidenceId = existingRelease.rows[0]?.verification_evidence_id;
  if (!releaseId || !evidenceId) {
    releaseId = minted(randomUUID());
    const staged = await repository.stageTenantReleaseCandidate(context, {
      appPackageRevisionId: revisionId,
      compiledRelease: release.compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId,
      tenantId: context.tenantId,
    });
    evidenceId = staged.verificationEvidenceId;
  }
  return Object.freeze({ evidenceId, releaseId, revisionId });
}

async function ensureReleaseAdmitted(
  pool: pg.Pool,
  context: TrustedRequestContext,
  identity: PersistedReleaseIdentity,
  release: ParsedRelease,
): Promise<void> {
  const repository = new PostgresImmutableReleaseRepository(pool);
  if (await repository.getTenantRelease(context, identity.releaseId)) return;
  await new PostgresReleaseVerificationService(
    pool,
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

async function approveInitialRelease(
  pool: pg.Pool,
  context: TrustedRequestContext,
  approverContext: TrustedRequestContext,
  pointer: PointerState,
  target: PersistedReleaseIdentity,
  compiled: CompileSuccess,
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

async function approveModuleRelease(
  pool: pg.Pool,
  context: TrustedRequestContext,
  approverContext: TrustedRequestContext,
  pointer: PointerState,
  target: PersistedReleaseIdentity,
  compiled: CompileSuccess,
  prepared: Awaited<ReturnType<PostgresModuleStorageMaterializer['prepare']>>,
  preparationId: MintedUuid,
): Promise<MintedUuid> {
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
      evidenceId: target.evidenceId,
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
  );
}

async function approveReleaseWithoutStorageTransition(
  pool: pg.Pool,
  context: TrustedRequestContext,
  approverContext: TrustedRequestContext,
  pointer: PointerState,
  source: ParsedRelease,
  target: PersistedReleaseIdentity,
  compiled: CompileSuccess,
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
        digest(
          'no-storage-compiler-facts',
          source.compiled.releaseRoot,
          compiled.releaseRoot,
        ),
        EXECUTOR_APPLIED_STATE_EVIDENCE_VERSION,
        digest(
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
      evidenceId: target.evidenceId,
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
  );
}

async function insertReleasePreparation(
  client: pg.PoolClient,
  input: {
    readonly bindingKind: 'INITIAL_ACTIVATION' | 'RELEASE_DIFF';
    readonly bindingVersion: string;
    readonly compiled: CompileSuccess;
    readonly context: TrustedRequestContext;
    readonly evidenceId: MintedUuid;
    readonly pointer: PointerState;
    readonly preparationId: MintedUuid;
    readonly receiptId: MintedUuid;
    readonly sourceRoot: Buffer | null;
    readonly targetReleaseId: MintedUuid;
    readonly transitionPlanDigest: Buffer | null;
  },
): Promise<void> {
  const targetRoot = Buffer.from(input.compiled.releaseRoot, 'hex');
  const evidence = await client.query<{
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
  const verified = evidence.rows[0];
  if (!verified) {
    throw new Error(
      'canonical release preparation requires durable verification evidence',
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
       transition_preparation_receipt_id
     ) VALUES (
       $1,$2,$3,'northstar.release-activation-preparation/v1',$4,$5,$6,$7,$8,$9,
       $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
       'SUPPORTED',$25,$26,$27,$28
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
      digest(
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
      digest('rendered-diff', input.compiled.releaseRoot),
      input.receiptId,
    ],
  );
}

async function createApproval(
  pool: pg.Pool,
  initiatingContext: TrustedRequestContext,
  approverContext: TrustedRequestContext,
  preparationId: MintedUuid,
  targetReleaseId: MintedUuid,
): Promise<MintedUuid> {
  const activationAttemptId = minted(randomUUID());
  const created = await new PostgresReleaseApprovalService(pool).createApproval(
    approverContext,
    {
      activationAttemptId,
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

async function readPointer(
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

async function activateWithExactSwapTrigger(
  adminPool: pg.Pool,
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

async function assertExactSwapTriggerEnabled(pool: pg.Pool): Promise<void> {
  const result = await pool.query<{ enabled: string }>(
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

function rolePool(databaseUrl: string, user: string, max: number): pg.Pool {
  const connection = new URL(databaseUrl);
  connection.username = user;
  connection.password = '';
  const pool = new pg.Pool({ connectionString: connection.href, max });
  pool.on('error', () => undefined);
  return pool;
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

async function trustedContext(
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
