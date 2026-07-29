import { createHash, randomUUID } from 'node:crypto';

import { canonicalize } from '@north-star/canonical-model';
import {
  PROJECTION_FAMILY_IDS,
  executeVerificationPlan,
  validateExecutedVerificationPlan,
  type CompileSuccess,
  type ExecutedVerificationResult,
  type ProjectionManifestEnvelope,
  type VerificationPlanPayloadV1,
  type VerificationScenario,
  type VerificationScenarioExecutor,
} from '@north-star/compiler';
import type { ExecutedVerificationResultSet } from '../../compiler/src/verification.js';
import type { MintedUuid } from '@north-star/platform-runtime';
import {
  AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
} from '@north-star/runtime';
import type { RequestRuntimeView as IssuedRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeDefinitionLoader,
  type RequestRuntimeProjectionFamily,
  type RuntimeProjection,
} from '@north-star/runtime/request-runtime-view';
import type { Pool, PoolClient } from 'pg';

import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  type SemanticOperationExecutor,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
  type SemanticQueryExecutor,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  ModuleRuntimeInterpreterError,
  PostgresModuleRuntimeInterpreter,
} from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { TrustedActorEnvelopeIssuer } from './trust/trusted-actor-envelope.js';

type ResultSetVersion = 'northstar.verification-result-set/v1';
const sha256Pattern = /^[0-9a-f]{64}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ReleaseVerificationBinding {
  readonly artifactClosureDigest: string;
  readonly plan: VerificationPlanPayloadV1;
  readonly releaseRoot: string;
  readonly verificationPlanArtifactRoot: string;
  readonly verificationPlanSemanticDigest: string;
}

export interface DurableReleaseVerificationEvidence {
  readonly artifactClosureDigest: string;
  readonly evidenceId: MintedUuid;
  readonly executedEnvironmentId: string;
  readonly executedEvidenceId: MintedUuid;
  readonly executedTenantId: string;
  readonly provider: 'realPostgresql';
  readonly providerRunId: string;
  readonly releaseRoot: string;
  readonly resultSetDigest: string;
  readonly results: readonly ExecutedVerificationResult[];
  readonly schemaVersion: ResultSetVersion;
  readonly verificationPlanArtifactRoot: string;
  readonly verificationPlanDigest: string;
  readonly verificationPlanSemanticDigest: string;
}

export interface ExecuteReleaseVerificationCommand {
  readonly compiledRelease: CompileSuccess;
  readonly evidenceId: MintedUuid;
  readonly releaseId: MintedUuid;
}

interface EvidenceRow {
  artifact_closure_digest: string;
  evidence_version: ResultSetVersion;
  executed_environment_id: string;
  executed_evidence_id: MintedUuid;
  executed_tenant_id: string;
  provider: 'realPostgresql';
  provider_run_id: string;
  release_root: string;
  result_count: number;
  result_set_digest: string;
  verification_evidence_id: MintedUuid;
  verification_plan_artifact_root: string;
  verification_plan_digest: string;
  verification_plan_semantic_digest: string;
}

interface CandidateArtifactRow {
  artifact_kind: string;
  canonical_bytes: Uint8Array;
  content_hash: string;
  domain_tag: string;
  media_type: string;
}

export interface FederateReleaseVerificationCommand {
  readonly compiledRelease: CompileSuccess;
  readonly sourceEnvironmentId: string;
  readonly sourceEvidenceId: MintedUuid;
  readonly sourceTenantId: string;
  readonly targetContext: TrustedRequestContext;
  readonly targetEvidenceId: MintedUuid;
  readonly targetReleaseId: MintedUuid;
}

interface ResultRow {
  negative_probe_digest: string | null;
  positive_probe_digest: string;
  provider: 'realPostgresql';
  provider_run_id: string;
  result_version: ExecutedVerificationResult['schemaVersion'];
  scenario_fingerprint: string;
  scenario_id: string;
}

export class ReleaseVerificationIntegrityError extends Error {
  override readonly name = 'ReleaseVerificationIntegrityError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class PostgresReleaseVerificationService {
  constructor(private readonly pool: Pool) {}

  async #executeAndPersist(
    context: TrustedRequestContext,
    command: ExecuteReleaseVerificationCommand,
    executor: VerificationScenarioExecutor,
  ): Promise<DurableReleaseVerificationEvidence> {
    assertClosedCommand(command);
    assertUuid(command.evidenceId, 'evidenceId');
    assertUuid(command.releaseId, 'releaseId');
    const binding = releaseVerificationBinding(command.compiledRelease);
    await this.assertStagedCandidate(context, command, binding);
    const existing = await this.read(
      context,
      command.evidenceId,
      command.compiledRelease,
    );
    if (existing) return existing;

    const executed = await executeVerificationPlan(
      binding.plan,
      {
        artifactClosureDigest: binding.artifactClosureDigest,
        providerRunId: providerRunId(),
        releaseRoot: binding.releaseRoot,
        verificationPlanArtifactRoot: binding.verificationPlanArtifactRoot,
        verificationPlanSemanticDigest: binding.verificationPlanSemanticDigest,
      },
      executor,
    );
    const conformance = validateExecutedVerificationPlan(
      binding.plan,
      executed,
      binding,
    );
    if (conformance.status !== 'passed') {
      throw failure(
        'VERIFICATION_EXECUTED_RESULTS_INVALID',
        `executed verification results do not conform: ${JSON.stringify(conformance.diagnostics)}`,
      );
    }

    await withTrustedRequestTransaction(this.pool, context, async (client) => {
      const candidate = await client.query<{ content_hash: string }>(
        `SELECT content_hash
           FROM platform.tenant_releases
          WHERE tenant_id = $1
            AND environment_id = $2
            AND release_id = $3
            AND verification_evidence_id = $4`,
        [
          context.tenantId,
          context.environmentId,
          command.releaseId,
          command.evidenceId,
        ],
      );
      if (candidate.rows[0]?.content_hash !== binding.releaseRoot) {
        throw failure(
          'VERIFICATION_CANDIDATE_NOT_STAGED',
          'verification execution requires the exact staged candidate root',
        );
      }
      await insertEvidence(client, context, command.evidenceId, executed);
    });

    const stored = await this.read(
      context,
      command.evidenceId,
      command.compiledRelease,
    );
    if (!stored) {
      throw failure(
        'VERIFICATION_EVIDENCE_NOT_VISIBLE',
        'persisted verification evidence did not read back',
      );
    }
    return stored;
  }

  async executeSemanticCandidateAndPersist(
    context: TrustedRequestContext,
    command: ExecuteReleaseVerificationCommand,
  ): Promise<DurableReleaseVerificationEvidence> {
    const snapshot = snapshotExecutionCommand(command);
    const interpreter = new PostgresModuleRuntimeInterpreter(
      this.pool,
      verificationActorIssuer(),
    );
    return this.#executeSemanticCandidateWithExecutorAndPersist(
      context,
      snapshot,
      interpreter,
    );
  }

  async executeSemanticCandidateWithExecutor(
    context: TrustedRequestContext,
    command: ExecuteReleaseVerificationCommand,
    executorProvider: SemanticOperationExecutor & SemanticQueryExecutor,
  ): Promise<ExecutedVerificationResultSet> {
    const snapshot = snapshotExecutionCommand(command);
    const binding = releaseVerificationBinding(snapshot.compiledRelease);
    await this.assertStagedCandidate(context, snapshot, binding);
    if (binding.plan.scenarios.length === 0) {
      return executeVerificationPlan(
        binding.plan,
        executionBinding(binding),
        () => ({ positiveProbe: { emptyPlanExecuted: true } }),
      );
    }
    return this.#executeSemanticCandidateWithExecutor(
      context,
      snapshot,
      binding,
      executorProvider,
      (executor) =>
        executeVerificationPlan(
          binding.plan,
          executionBinding(binding),
          (scenario) => executor.execute(scenario),
        ),
    );
  }

  async #executeSemanticCandidateWithExecutorAndPersist(
    context: TrustedRequestContext,
    command: ExecuteReleaseVerificationCommand,
    executorProvider: SemanticOperationExecutor & SemanticQueryExecutor,
  ): Promise<DurableReleaseVerificationEvidence> {
    const binding = releaseVerificationBinding(command.compiledRelease);
    if (binding.plan.scenarios.length === 0) {
      return this.#executeAndPersist(context, command, () => ({
        positiveProbe: { emptyPlanExecuted: true },
      }));
    }
    return this.#executeSemanticCandidateWithExecutor(
      context,
      command,
      binding,
      executorProvider,
      (executor) =>
        this.#executeAndPersist(context, command, (scenario) =>
          executor.execute(scenario),
        ),
    );
  }

  async #executeSemanticCandidateWithExecutor<TResult>(
    context: TrustedRequestContext,
    command: ExecuteReleaseVerificationCommand,
    binding: ReleaseVerificationBinding,
    executorProvider: SemanticOperationExecutor & SemanticQueryExecutor,
    execute: (executor: SemanticVerificationExecutor) => Promise<TResult>,
  ): Promise<TResult> {
    const policy = new VerificationAllowPolicy();
    const mediation = new SemanticOperationMediationAuthority();
    const operationGateway = new SemanticOperationGateway(
      policy,
      executorProvider,
      mediation,
    );
    const queryGateway = new SemanticQueryGateway(policy, executorProvider);
    const entry = new AuthenticatedRequestRuntimeEntryAdapter(
      new AuthenticatedRequestEntryAdapter(async () => ({
        environmentId: context.environmentId,
        principalId: context.principalId,
        tenantId: context.tenantId,
      })),
      new CandidateDefinitionLoader(
        this.pool,
        command.compiledRelease,
        command.releaseId,
      ),
      policy,
    );
    return entry.run({}, (view) => {
      const executor = new SemanticVerificationExecutor(
        view,
        command.compiledRelease,
        binding.plan,
        operationGateway,
        mediation,
        queryGateway,
      );
      return (async () => {
        try {
          return await execute(executor);
        } finally {
          await executor.archiveProbeRecords();
        }
      })();
    });
  }

  async read(
    context: TrustedRequestContext,
    evidenceId: MintedUuid,
    compiledRelease: CompileSuccess,
  ): Promise<DurableReleaseVerificationEvidence | null> {
    assertUuid(evidenceId, 'evidenceId');
    const binding = releaseVerificationBinding(compiledRelease);
    return withTrustedRequestTransaction(this.pool, context, (client) =>
      readDurableVerificationEvidence(client, context, evidenceId, binding),
    );
  }

  private async assertStagedCandidate(
    context: TrustedRequestContext,
    command: ExecuteReleaseVerificationCommand,
    binding: ReleaseVerificationBinding,
  ): Promise<void> {
    await withTrustedRequestTransaction(this.pool, context, async (client) => {
      const candidate = await client.query<{ content_hash: string }>(
        `SELECT content_hash
           FROM platform.tenant_releases
          WHERE tenant_id = $1
            AND environment_id = $2
            AND release_id = $3
            AND verification_evidence_id = $4`,
        [
          context.tenantId,
          context.environmentId,
          command.releaseId,
          command.evidenceId,
        ],
      );
      if (candidate.rows[0]?.content_hash !== binding.releaseRoot) {
        throw failure(
          'VERIFICATION_CANDIDATE_NOT_STAGED',
          'verification execution requires the exact staged candidate identity and root',
        );
      }
      const persistedArtifacts = await client.query<CandidateArtifactRow>(
        `SELECT artifact_kind, content_hash, domain_tag, media_type,
                canonical_bytes
           FROM platform.read_tenant_release_artifacts($1)`,
        [command.releaseId],
      );
      assertExactCandidateArtifacts(
        command.compiledRelease,
        binding.releaseRoot,
        persistedArtifacts.rows,
      );
    });
  }
}

export class PostgresReleaseVerificationFederationService {
  constructor(private readonly administrativePool: Pool) {}

  async federate(
    command: FederateReleaseVerificationCommand,
  ): Promise<DurableReleaseVerificationEvidence> {
    const binding = releaseVerificationBinding(command.compiledRelease);
    const client = await this.administrativePool.connect();
    let federated: DurableReleaseVerificationEvidence | null = null;
    try {
      await client.query('BEGIN');
      const source = await readDurableVerificationEvidence(
        client,
        {
          environmentId: command.sourceEnvironmentId,
          tenantId: command.sourceTenantId,
        },
        command.sourceEvidenceId,
        binding,
      );
      if (!source) {
        throw failure(
          'VERIFICATION_FEDERATION_SOURCE_NOT_FOUND',
          'federation requires durable source verification evidence',
        );
      }
      const candidate = await client.query<{ content_hash: string }>(
        `SELECT content_hash
           FROM platform.tenant_releases
          WHERE tenant_id = $1
            AND environment_id = $2
            AND release_id = $3
            AND verification_evidence_id = $4`,
        [
          command.targetContext.tenantId,
          command.targetContext.environmentId,
          command.targetReleaseId,
          command.targetEvidenceId,
        ],
      );
      if (candidate.rows[0]?.content_hash !== binding.releaseRoot) {
        throw failure(
          'VERIFICATION_CANDIDATE_NOT_STAGED',
          'federation target must be the exact staged candidate root',
        );
      }
      const existing = await readDurableVerificationEvidence(
        client,
        command.targetContext,
        command.targetEvidenceId,
        binding,
      );
      if (!existing) {
        await insertEvidence(
          client,
          command.targetContext,
          command.targetEvidenceId,
          source,
          {
            environmentId: source.executedEnvironmentId,
            evidenceId: source.executedEvidenceId,
            tenantId: source.executedTenantId,
          },
        );
      }
      federated = await readDurableVerificationEvidence(
        client,
        command.targetContext,
        command.targetEvidenceId,
        binding,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (!federated) {
      throw failure(
        'VERIFICATION_FEDERATION_NOT_VISIBLE',
        'federated verification evidence did not read back',
      );
    }
    return federated;
  }
}

export function verificationEvidenceIdForCandidate(
  context: Pick<TrustedRequestContext, 'environmentId' | 'tenantId'>,
  releaseId: string,
  releaseRoot: string,
): MintedUuid {
  assertUuid(releaseId, 'releaseId');
  if (!sha256Pattern.test(releaseRoot)) {
    throw new TypeError('releaseRoot must be a SHA-256 digest');
  }
  const bytes = createHash('sha256')
    .update('northstar.release-verification-evidence-identity/v1', 'utf8')
    .update(Uint8Array.of(0))
    .update(context.tenantId, 'utf8')
    .update(Uint8Array.of(0))
    .update(context.environmentId, 'utf8')
    .update(Uint8Array.of(0))
    .update(releaseId, 'utf8')
    .update(Uint8Array.of(0))
    .update(releaseRoot, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as MintedUuid;
}

export function releaseVerificationBinding(
  compiledRelease: CompileSuccess,
): ReleaseVerificationBinding {
  const reference = compiledRelease.bundle.releaseManifest.projections.find(
    (projection) =>
      projection.familyId === PROJECTION_FAMILY_IDS.verificationPlan,
  );
  if (!reference) {
    throw failure(
      'VERIFICATION_PLAN_MISSING',
      'compiled candidate has no verification-plan projection',
    );
  }
  const manifestArtifact = compiledRelease.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  if (!manifestArtifact) {
    throw failure(
      'VERIFICATION_PLAN_MANIFEST_MISSING',
      'verification-plan manifest artifact is missing',
    );
  }
  const manifest = decode(
    manifestArtifact.canonicalBytes,
  ) as unknown as ProjectionManifestEnvelope;
  if (manifest.chunks.length !== 1) {
    throw failure(
      'VERIFICATION_PLAN_CHUNK_COUNT_INVALID',
      'verification plan must resolve to exactly one chunk',
    );
  }
  const chunk = compiledRelease.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]!.contentHash,
  );
  if (!chunk) {
    throw failure(
      'VERIFICATION_PLAN_CHUNK_MISSING',
      'verification-plan payload artifact is missing',
    );
  }
  const plan = decode(
    chunk.canonicalBytes,
  ) as unknown as VerificationPlanPayloadV1;
  if (
    plan.kind !== 'verificationPlanPayload' ||
    !Array.isArray(plan.scenarios)
  ) {
    throw failure(
      'VERIFICATION_PLAN_INVALID',
      'verification-plan payload is malformed',
    );
  }
  return Object.freeze({
    artifactClosureDigest: digestCanonical(
      'northstar.release-artifact-closure/v1',
      [...compiledRelease.bundle.releaseManifest.artifactClosure].toSorted(),
    ),
    plan,
    releaseRoot: compiledRelease.releaseRoot,
    verificationPlanArtifactRoot: reference.artifactRoot,
    verificationPlanSemanticDigest: reference.semanticDigest,
  });
}

export async function readDurableVerificationEvidence(
  client: PoolClient,
  context: Pick<TrustedRequestContext, 'environmentId' | 'tenantId'>,
  evidenceId: MintedUuid,
  binding: ReleaseVerificationBinding,
): Promise<DurableReleaseVerificationEvidence | null> {
  const evidenceResult = await client.query<EvidenceRow>(
    `SELECT verification_evidence_id, evidence_version, release_root,
            artifact_closure_digest, verification_plan_artifact_root,
            verification_plan_semantic_digest, verification_plan_digest,
            result_set_digest, result_count, provider, provider_run_id,
            executed_tenant_id, executed_environment_id,
            executed_evidence_id
       FROM platform.release_verification_evidence
      WHERE tenant_id = $1
        AND environment_id = $2
        AND verification_evidence_id = $3`,
    [context.tenantId, context.environmentId, evidenceId],
  );
  const row = evidenceResult.rows[0];
  if (!row) return null;
  const resultRows = await client.query<ResultRow>(
    `SELECT scenario_id, scenario_fingerprint, result_version,
            positive_probe_digest, negative_probe_digest, provider,
            provider_run_id
       FROM platform.release_verification_results
      WHERE tenant_id = $1
        AND environment_id = $2
        AND verification_evidence_id = $3
      ORDER BY scenario_id`,
    [context.tenantId, context.environmentId, evidenceId],
  );
  if (Number(row.result_count) !== resultRows.rows.length) {
    throw failure(
      'VERIFICATION_RESULT_COUNT_MISMATCH',
      'verification evidence header and result count differ',
    );
  }
  const resultSet = Object.freeze({
    artifactClosureDigest: row.artifact_closure_digest,
    provider: row.provider,
    providerRunId: row.provider_run_id,
    releaseRoot: row.release_root,
    resultSetDigest: row.result_set_digest,
    results: Object.freeze(
      resultRows.rows.map((result) =>
        Object.freeze({
          negativeProbeDigest: result.negative_probe_digest,
          positiveProbeDigest: result.positive_probe_digest,
          provider: result.provider,
          providerRunId: result.provider_run_id,
          scenarioFingerprint: result.scenario_fingerprint,
          scenarioId: result.scenario_id,
          schemaVersion: result.result_version,
        }),
      ),
    ),
    schemaVersion: row.evidence_version,
    verificationPlanArtifactRoot: row.verification_plan_artifact_root,
    verificationPlanDigest: row.verification_plan_digest,
    verificationPlanSemanticDigest: row.verification_plan_semantic_digest,
  });
  const validation = validateExecutedVerificationPlan(
    binding.plan,
    resultSet,
    binding,
  );
  if (validation.status !== 'passed') {
    throw failure(
      'VERIFICATION_EVIDENCE_CONFORMANCE_FAILED',
      `durable verification evidence does not match the candidate: ${JSON.stringify(validation.diagnostics)}`,
    );
  }
  return Object.freeze({
    ...resultSet,
    evidenceId,
    executedEnvironmentId: row.executed_environment_id,
    executedEvidenceId: row.executed_evidence_id,
    executedTenantId: row.executed_tenant_id,
  });
}

interface VerificationFieldContract {
  readonly bounds: {
    readonly maximumLength: number | null;
    readonly precision: number | null;
    readonly scale: number | null;
  };
  readonly enumOptionIds: readonly string[];
  readonly fieldId: string;
  readonly fieldKind: string;
  readonly normalization: string;
  readonly required: boolean;
  readonly temporal: {
    readonly precision: number | null;
    readonly timezoneSemantics: string | null;
  };
  readonly writable: boolean;
}

interface VerificationOperationContract {
  readonly confirmation: string;
  readonly effect: {
    readonly entity: { readonly targetId: string };
    readonly kind: string;
  };
  readonly inputContract: {
    readonly fields: readonly VerificationFieldContract[];
    readonly relationInputs: readonly {
      readonly relationId: string;
      readonly required: boolean;
    }[];
  };
  readonly operationId: string;
}

interface VerificationQueryContract {
  readonly queryId: string;
  readonly queryType: 'get' | 'list' | 'resolve' | 'search';
  readonly resolveMatchKeys: readonly {
    readonly authority: string;
    readonly fieldId: string;
  }[];
  readonly selections: readonly { readonly fieldId: string }[];
  readonly sourceEntityId: string;
}

interface VerificationRelationContract {
  readonly archiveBehavior: string;
  readonly relationId: string;
  readonly sourceEntityId: string;
  readonly targetEntityId: string;
}

interface VerificationRecord {
  readonly recordId: string;
  readonly relations: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, unknown>>;
}

class CandidateDefinitionLoader implements RequestRuntimeDefinitionLoader {
  constructor(
    private readonly pool: Pool,
    private readonly compiled: CompileSuccess,
    private readonly releaseId: MintedUuid,
  ) {}

  async load(
    context: TrustedRequestContext,
  ): Promise<LoadedRequestRuntimeDefinition> {
    const pointer = await withTrustedRequestTransaction(
      this.pool,
      context,
      async (client) => {
        const result = await client.query<{
          fence: string;
          pointer_id: string;
        }>(
          `SELECT pointer_id, fence
             FROM platform.active_release_pointers
            WHERE tenant_id = $1 AND environment_id = $2`,
          [context.tenantId, context.environmentId],
        );
        const row = result.rows[0];
        if (!row) {
          throw failure(
            'VERIFICATION_POINTER_MISSING',
            'candidate verification requires an initialized release pointer',
          );
        }
        return { fence: Number(row.fence), pointerId: row.pointer_id };
      },
    );
    return Object.freeze({
      environmentId: context.environmentId,
      pointer,
      projections: {
        agent: runtimeProjection(
          this.compiled,
          REQUEST_RUNTIME_PROJECTION_FAMILIES.agent,
        ),
        catalog: runtimeProjection(
          this.compiled,
          REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog,
        ),
        operation: runtimeProjection(
          this.compiled,
          REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
        ),
        query: runtimeProjection(
          this.compiled,
          REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
        ),
        surface: runtimeProjection(
          this.compiled,
          REQUEST_RUNTIME_PROJECTION_FAMILIES.surface,
        ),
      },
      release: {
        contentHash: this.compiled.releaseRoot,
        releaseId: this.releaseId,
      },
      tenantId: context.tenantId,
    });
  }
}

class VerificationAllowPolicy implements CurrentPolicyGateway {
  async authorize(_request: CurrentPolicyDecisionRequest) {
    void _request;
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'northstar.release-verification-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'northstar.release-verification-policy/v1' };
  }
}

class SemanticVerificationExecutor {
  readonly #createdRecords: Array<{
    readonly entityId: string;
    readonly recordId: string;
  }> = [];
  readonly #excludedFieldsByEntity = new Map<string, Set<string>>();
  readonly #operations: readonly VerificationOperationContract[];
  readonly #queries: readonly VerificationQueryContract[];
  readonly #relations: readonly VerificationRelationContract[];
  #ordinal = 0;

  constructor(
    private readonly view: IssuedRequestRuntimeView,
    compiled: CompileSuccess,
    plan: VerificationPlanPayloadV1,
    private readonly operationGateway: SemanticOperationGateway,
    private readonly mediation: SemanticOperationMediationAuthority,
    private readonly queryGateway: SemanticQueryGateway,
  ) {
    this.#operations = (
      view.projections.operation.payload as unknown as {
        operations: readonly VerificationOperationContract[];
      }
    ).operations;
    this.#queries = (
      view.projections.query.payload as unknown as {
        queries: readonly VerificationQueryContract[];
      }
    ).queries;
    this.#relations = compiledProjectionPayload<{
      relations: readonly VerificationRelationContract[];
    }>(compiled, PROJECTION_FAMILY_IDS.storageTarget).relations;
    for (const scenario of plan.scenarios) {
      if (scenario.kind !== 'searchableExclusion') continue;
      const excluded = this.#excludedFieldsByEntity.get(scenario.entityId);
      if (excluded) excluded.add(scenario.subjectId);
      else {
        this.#excludedFieldsByEntity.set(
          scenario.entityId,
          new Set([scenario.subjectId]),
        );
      }
    }
  }

  async execute(scenario: VerificationScenario) {
    const token = this.#token(scenario.kind);
    switch (scenario.kind) {
      case 'declaredEvidence':
        return this.#declaredEvidence(scenario, token);
      case 'enumReject':
        return this.#enumReject(scenario, token);
      case 'resolverAuthority':
        return this.#resolverAuthority(scenario, token);
      case 'searchableExclusion':
        return this.#searchableExclusion(scenario, token);
      case 'typedErrorSurface':
        return this.#typedErrorSurface(scenario, token);
      case 'uniquenessFold':
        return this.#uniquenessFold(scenario, token);
      case 'archiveRestrict':
        return this.#archiveRestrict(scenario, token);
    }
  }

  async archiveProbeRecords(): Promise<void> {
    for (const record of [...this.#createdRecords].reverse()) {
      const get = this.#queryForEntity(record.entityId, 'get');
      const current = await this.#invokeQuery(get, {
        recordId: record.recordId,
      });
      const row =
        isRecord(current) && Array.isArray(current.records)
          ? current.records.find(
              (candidate) =>
                isRecord(candidate) && candidate.recordId === record.recordId,
            )
          : null;
      if (!isRecord(row) || !Number.isSafeInteger(row.revision)) continue;
      await this.#invokeEffect(record.entityId, 'archiveRecordEffect', {
        expectedRevision: row.revision,
        recordId: record.recordId,
      });
    }
  }

  async #declaredEvidence(scenario: VerificationScenario, token: string) {
    const record = await this.#create(scenario.entityId, token);
    if (scenario.evidenceKind === 'recovery') {
      const archived = await this.#invokeEffect(
        scenario.entityId,
        'archiveRecordEffect',
        { expectedRevision: 1, recordId: record.recordId },
      );
      const restored = await this.#invokeEffect(
        scenario.entityId,
        'restoreRecordEffect',
        { expectedRevision: 2, recordId: record.recordId },
      );
      return { positiveProbe: { archived, restored } };
    }
    const invocation = scenario.invocation as
      { operation?: { targetId?: string } } | { query?: { targetId?: string } };
    const queryId = 'query' in invocation ? invocation.query?.targetId : null;
    if (queryId) {
      return {
        positiveProbe: await this.#invokeQueryById(queryId, record, token),
      };
    }
    const operationId =
      'operation' in invocation ? invocation.operation?.targetId : null;
    if (operationId) {
      const operation = this.#requiredOperation(operationId);
      return {
        positiveProbe: await this.#invokeOperation(
          operation,
          operation.effect.kind === 'createRecordEffect'
            ? await this.#createInput(scenario.entityId, token)
            : { expectedRevision: 1, recordId: record.recordId },
        ),
      };
    }
    throw failure(
      'VERIFICATION_DECLARED_INVOCATION_INVALID',
      'declared verification scenario has no executable invocation',
    );
  }

  async #enumReject(scenario: VerificationScenario, token: string) {
    const record = await this.#create(scenario.entityId, token);
    const field = this.#requiredField(scenario.entityId, scenario.subjectId);
    const rejected = await this.#captureRejection(
      this.#invokeEffect(scenario.entityId, 'updateRecordEffect', {
        expectedRevision: 1,
        patch: { [scenario.subjectId]: `${scenario.subjectId}.not-declared` },
        recordId: record.recordId,
      }),
      ['MODULE_ENUM_VALUE_INVALID'],
    );
    const accepted = await this.#invokeEffect(
      scenario.entityId,
      'updateRecordEffect',
      {
        expectedRevision: 1,
        patch: { [scenario.subjectId]: field.enumOptionIds[0] },
        recordId: record.recordId,
      },
    );
    return { negativeProbe: rejected, positiveProbe: accepted };
  }

  async #resolverAuthority(scenario: VerificationScenario, token: string) {
    const record = await this.#create(scenario.entityId, token);
    const query = this.#requiredQuery(scenario.subjectId);
    const match = query.resolveMatchKeys[0];
    if (!match) {
      throw failure(
        'VERIFICATION_RESOLVER_KEY_MISSING',
        'resolver verification scenario has no compiled match key',
      );
    }
    const resolved = await this.#invokeQuery(query, {
      text: String(record.values[match.fieldId]),
    });
    if (
      !isRecord(resolved) ||
      (resolved.outcome !== 'exact' && resolved.outcome !== 'ambiguous')
    ) {
      throw failure(
        'VERIFICATION_RESOLVER_POSITIVE_FAILED',
        `resolver ${scenario.subjectId} did not return an authoritative positive outcome for ${String(record.values[match.fieldId])}: ${canonicalize(resolved)}`,
      );
    }
    const missing = await this.#invokeQuery(query, {
      text: `missing-${token}`,
    });
    if (!isRecord(missing) || missing.outcome !== 'not-found') {
      throw failure(
        'VERIFICATION_RESOLVER_NEGATIVE_FAILED',
        'resolver did not return not-found for the negative probe',
      );
    }
    return { negativeProbe: missing, positiveProbe: resolved };
  }

  async #searchableExclusion(scenario: VerificationScenario, token: string) {
    const record = await this.#create(scenario.entityId, token);
    const search = this.#queryForEntity(scenario.entityId, 'search');
    const excludedValue = record.values[scenario.subjectId];
    if (excludedValue === undefined) {
      throw failure(
        'VERIFICATION_EXCLUDED_FIELD_VALUE_MISSING',
        'search exclusion probe could not populate its subject field',
      );
    }
    const excluded = await this.#invokeQuery(search, {
      text: String(excludedValue),
    });
    if (!hasNoRecords(excluded)) {
      throw failure(
        'VERIFICATION_SEARCH_EXCLUSION_FAILED',
        `excluded field value was searchable: ${scenario.subjectId}`,
      );
    }
    const positiveCandidate = this.#queries
      .filter((query) => query.queryType === 'search')
      .flatMap((query) =>
        query.selections.map((selection) => ({
          entityId: query.sourceEntityId,
          field: this.#createOperation(
            query.sourceEntityId,
          ).inputContract.fields.find(
            (field) =>
              field.fieldId === selection.fieldId &&
              field.fieldKind === 'textFieldType' &&
              !this.#excludedFieldsByEntity
                .get(query.sourceEntityId)
                ?.has(field.fieldId),
          ),
        })),
      )
      .find((candidate) => candidate.field);
    if (!positiveCandidate?.field) {
      throw failure(
        'VERIFICATION_SEARCHABLE_FIELD_MISSING',
        'search exclusion probe has no positive searchable field',
      );
    }
    const positiveRecord =
      positiveCandidate.entityId === scenario.entityId
        ? record
        : await this.#create(
            positiveCandidate.entityId,
            `${token}-search-positive`,
          );
    const positiveSearch = this.#queryForEntity(
      positiveCandidate.entityId,
      'search',
    );
    const included = await this.#invokeQuery(positiveSearch, {
      text: String(positiveRecord.values[positiveCandidate.field.fieldId]),
    });
    if (!hasRecord(included, positiveRecord.recordId)) {
      throw failure(
        'VERIFICATION_SEARCH_POSITIVE_FAILED',
        `searchable field ${positiveCandidate.field.fieldId} did not return record ${positiveRecord.recordId}: ${canonicalize(included)}`,
      );
    }
    return { negativeProbe: excluded, positiveProbe: included };
  }

  async #typedErrorSurface(scenario: VerificationScenario, token: string) {
    const record = await this.#create(scenario.entityId, token);
    const get = await this.#invokeQuery(
      this.#queryForEntity(scenario.entityId, 'get'),
      { recordId: record.recordId },
    );
    const unique = this.#createOperation(
      scenario.entityId,
    ).inputContract.fields.find((field) => field.normalization !== 'none');
    const rejection = unique
      ? await this.#captureRejection(
          this.#create(scenario.entityId, `${token}-duplicate`, {
            [unique.fieldId]: record.values[unique.fieldId],
          }),
          ['MODULE_UNIQUE_VIOLATION'],
        )
      : await this.#captureRejection(
          this.#invokeEffect(scenario.entityId, 'updateRecordEffect', {
            expectedRevision: 1,
            patch: { unexpectedField: true },
            recordId: record.recordId,
          }),
        );
    return { negativeProbe: rejection, positiveProbe: get };
  }

  async #uniquenessFold(scenario: VerificationScenario, token: string) {
    const field = this.#createOperation(
      scenario.entityId,
    ).inputContract.fields.find(
      (candidate) => candidate.fieldId === scenario.subjectId,
    );
    if (!field || field.fieldKind !== 'textFieldType') {
      throw failure(
        'VERIFICATION_UNIQUENESS_FIELD_INVALID',
        'uniqueness-fold scenario does not name a text input field',
      );
    }
    const upper = String(verificationFieldValue(field, token)).toUpperCase();
    const accepted = await this.#create(scenario.entityId, `${token}-upper`, {
      [scenario.subjectId]: upper,
    });
    const rejected = await this.#captureRejection(
      this.#create(scenario.entityId, `${token}-lower`, {
        [scenario.subjectId]: upper.toLowerCase(),
      }),
      ['MODULE_UNIQUE_VIOLATION'],
    );
    return { negativeProbe: rejected, positiveProbe: accepted };
  }

  async #archiveRestrict(scenario: VerificationScenario, token: string) {
    const relation = this.#relations.find(
      (candidate) => candidate.relationId === scenario.subjectId,
    );
    if (!relation || relation.archiveBehavior !== 'restrict') {
      throw failure(
        'VERIFICATION_ARCHIVE_RELATION_INVALID',
        'archive restriction scenario does not name a compiled restrict relation',
      );
    }
    const parent = await this.#create(relation.targetEntityId, `${token}-p`);
    const child = await this.#create(
      relation.sourceEntityId,
      `${token}-c`,
      {},
      {
        [relation.relationId]: parent.recordId,
      },
    );
    const rejected = await this.#captureRejection(
      this.#invokeEffect(relation.targetEntityId, 'archiveRecordEffect', {
        expectedRevision: 1,
        recordId: parent.recordId,
      }),
      ['MODULE_ARCHIVE_RESTRICTED'],
    );
    const accepted = await this.#invokeEffect(
      relation.sourceEntityId,
      'archiveRecordEffect',
      { expectedRevision: 1, recordId: child.recordId },
    );
    return { negativeProbe: rejected, positiveProbe: accepted };
  }

  async #create(
    entityId: string,
    token: string,
    overrides: Readonly<Record<string, unknown>> = {},
    relationOverrides: Readonly<Record<string, string>> = {},
  ): Promise<VerificationRecord> {
    const input = await this.#createInput(
      entityId,
      token,
      overrides,
      relationOverrides,
    );
    await this.#invokeOperation(this.#createOperation(entityId), input);
    this.#createdRecords.push({ entityId, recordId: String(input.recordId) });
    return Object.freeze({
      recordId: String(input.recordId),
      relations: input.relations as Readonly<Record<string, string>>,
      values: input.values as Readonly<Record<string, unknown>>,
    });
  }

  async #createInput(
    entityId: string,
    token: string,
    overrides: Readonly<Record<string, unknown>> = {},
    relationOverrides: Readonly<Record<string, string>> = {},
  ): Promise<Record<string, unknown>> {
    const operation = this.#createOperation(entityId);
    const values = Object.fromEntries(
      operation.inputContract.fields
        .filter((field) => field.writable)
        .map((field) => [
          field.fieldId,
          Object.hasOwn(overrides, field.fieldId)
            ? overrides[field.fieldId]
            : verificationFieldValue(field, token),
        ]),
    );
    const relations: Record<string, string> = { ...relationOverrides };
    for (const relationInput of operation.inputContract.relationInputs) {
      if (relations[relationInput.relationId]) continue;
      const relation = this.#relations.find(
        (candidate) => candidate.relationId === relationInput.relationId,
      );
      if (!relation) {
        throw failure(
          'VERIFICATION_RELATION_CONTRACT_MISSING',
          'operation relation input has no storage relation contract',
        );
      }
      const target = await this.#create(
        relation.targetEntityId,
        `${token}-parent`,
      );
      relations[relationInput.relationId] = target.recordId;
    }
    return { recordId: stableUuid(`verification:${token}`), relations, values };
  }

  #invokeEffect(
    entityId: string,
    effectKind: string,
    input: Record<string, unknown>,
  ) {
    const operation = this.#operations.find(
      (candidate) =>
        candidate.effect.entity.targetId === entityId &&
        candidate.effect.kind === effectKind,
    );
    if (!operation) {
      throw failure(
        'VERIFICATION_OPERATION_MISSING',
        `compiled operation is missing for ${entityId} ${effectKind}`,
      );
    }
    return this.#invokeOperation(operation, input);
  }

  async #invokeOperation(
    operation: VerificationOperationContract,
    input: Record<string, unknown>,
  ) {
    const result = await this.operationGateway.invoke(
      this.view,
      {
        confirmationGrant:
          operation.confirmation === 'humanRequired'
            ? this.mediation.issueConfirmationGrant(
                this.view,
                operation.operationId,
                input as ImmutableJsonValue,
              )
            : null,
        idempotencyKey: stableUuid(
          `verification:idempotency:${this.#token(operation.operationId)}`,
        ),
        input,
        operationId: operation.operationId,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      this.mediation.issueInvocation(this.view, 'API'),
    );
    if (result.outcome !== 'succeeded') {
      throw failure(
        'VERIFICATION_OPERATION_FAILED',
        `verification operation ${operation.operationId} did not succeed`,
      );
    }
    return result;
  }

  #invokeQueryById(queryId: string, record: VerificationRecord, token: string) {
    const query = this.#requiredQuery(queryId);
    if (query.queryType === 'get') {
      return this.#invokeQuery(query, { recordId: record.recordId });
    }
    if (query.queryType === 'resolve') {
      const key = query.resolveMatchKeys[0];
      return this.#invokeQuery(query, {
        text: key ? String(record.values[key.fieldId]) : token,
      });
    }
    if (query.queryType === 'search') {
      const selected = query.selections[0];
      return this.#invokeQuery(query, {
        text: selected ? String(record.values[selected.fieldId]) : token,
      });
    }
    return this.#invokeQuery(query, {});
  }

  #invokeQuery(
    query: VerificationQueryContract,
    arguments_: Record<string, unknown>,
  ) {
    return this.queryGateway.invoke(this.view, {
      arguments: arguments_,
      queryId: query.queryId,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    });
  }

  async #captureRejection(
    operation: Promise<unknown>,
    expectedCodes: readonly string[] = [],
  ) {
    try {
      await operation;
    } catch (error) {
      const code =
        error instanceof ModuleRuntimeInterpreterError
          ? error.code
          : isRecord(error) && typeof error.code === 'string'
            ? error.code
            : null;
      if (
        !code ||
        (expectedCodes.length > 0 && !expectedCodes.includes(code))
      ) {
        throw error;
      }
      return {
        code,
        subjectId:
          error instanceof ModuleRuntimeInterpreterError
            ? error.subjectId
            : isRecord(error) && typeof error.subjectId === 'string'
              ? error.subjectId
              : null,
      };
    }
    throw failure(
      'VERIFICATION_NEGATIVE_PROBE_DID_NOT_FAIL',
      'verification negative probe unexpectedly succeeded',
    );
  }

  #createOperation(entityId: string): VerificationOperationContract {
    const operation = this.#operations.find(
      (candidate) =>
        candidate.effect.entity.targetId === entityId &&
        candidate.effect.kind === 'createRecordEffect',
    );
    if (!operation) {
      throw failure(
        'VERIFICATION_CREATE_OPERATION_MISSING',
        `compiled create operation is missing for ${entityId}`,
      );
    }
    return operation;
  }

  #requiredOperation(operationId: string): VerificationOperationContract {
    const operation = this.#operations.find(
      (candidate) => candidate.operationId === operationId,
    );
    if (!operation) {
      throw failure(
        'VERIFICATION_OPERATION_MISSING',
        `compiled verification operation is missing: ${operationId}`,
      );
    }
    return operation;
  }

  #requiredField(entityId: string, fieldId: string): VerificationFieldContract {
    const field = this.#createOperation(entityId).inputContract.fields.find(
      (candidate) => candidate.fieldId === fieldId,
    );
    if (!field) {
      throw failure(
        'VERIFICATION_FIELD_MISSING',
        `compiled verification field is missing: ${fieldId}`,
      );
    }
    return field;
  }

  #requiredQuery(queryId: string): VerificationQueryContract {
    const query = this.#queries.find(
      (candidate) => candidate.queryId === queryId,
    );
    if (!query) {
      throw failure(
        'VERIFICATION_QUERY_MISSING',
        `compiled verification query is missing: ${queryId}`,
      );
    }
    return query;
  }

  #queryForEntity(
    entityId: string,
    queryType: VerificationQueryContract['queryType'],
  ): VerificationQueryContract {
    const query = this.#queries.find(
      (candidate) =>
        candidate.sourceEntityId === entityId &&
        candidate.queryType === queryType,
    );
    if (!query) {
      throw failure(
        'VERIFICATION_QUERY_MISSING',
        `compiled ${queryType} query is missing for ${entityId}`,
      );
    }
    return query;
  }

  #token(label: string): string {
    this.#ordinal += 1;
    return createHash('sha256')
      .update('northstar.semantic-verification-probe/v1', 'utf8')
      .update(Uint8Array.of(0))
      .update(this.view.release.contentHash, 'utf8')
      .update(Uint8Array.of(0))
      .update(this.view.release.releaseId, 'utf8')
      .update(Uint8Array.of(0))
      .update(label, 'utf8')
      .update(Uint8Array.of(0))
      .update(String(this.#ordinal), 'utf8')
      .digest('hex')
      .slice(0, 12);
  }
}

function runtimeProjection<TFamily extends RequestRuntimeProjectionFamily>(
  compiled: CompileSuccess,
  familyId: TFamily,
): RuntimeProjection<TFamily> {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (candidate) => candidate.familyId === familyId,
  );
  if (!reference) {
    throw failure(
      'VERIFICATION_RUNTIME_PROJECTION_MISSING',
      `candidate runtime projection is missing: ${familyId}`,
    );
  }
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  if (!manifestArtifact) {
    throw failure(
      'VERIFICATION_RUNTIME_PROJECTION_MANIFEST_MISSING',
      `candidate runtime projection manifest is missing: ${familyId}`,
    );
  }
  const manifest = decode(
    manifestArtifact.canonicalBytes,
  ) as unknown as ProjectionManifestEnvelope;
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  if (!chunk || manifest.chunks.length !== 1) {
    throw failure(
      'VERIFICATION_RUNTIME_PROJECTION_CHUNK_MISSING',
      `candidate runtime projection chunk is missing: ${familyId}`,
    );
  }
  return Object.freeze({
    artifactRoot: reference.artifactRoot,
    familyId,
    instanceId: reference.instanceId,
    payload: decode(chunk.canonicalBytes) as ImmutableJsonValue,
    payloadSchemaVersion: reference.payloadSchemaVersion,
    semanticDigest: reference.semanticDigest,
  });
}

function compiledProjectionPayload<T>(
  compiled: CompileSuccess,
  familyId: string,
): T {
  const reference = compiled.bundle.releaseManifest.projections.find(
    (projection) => projection.familyId === familyId,
  );
  if (!reference) {
    throw failure(
      'VERIFICATION_RUNTIME_PROJECTION_UNAVAILABLE',
      `candidate release does not carry projection ${familyId}`,
    );
  }
  const manifestArtifact = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === reference.artifactRoot,
  );
  if (!manifestArtifact) {
    throw failure(
      'VERIFICATION_RUNTIME_PROJECTION_MANIFEST_MISSING',
      `candidate release lacks projection manifest ${familyId}`,
    );
  }
  const manifest = decode(
    manifestArtifact.canonicalBytes,
  ) as unknown as ProjectionManifestEnvelope;
  const chunk = compiled.bundle.artifacts.find(
    (artifact) => artifact.contentHash === manifest.chunks[0]?.contentHash,
  );
  if (!chunk || manifest.chunks.length !== 1) {
    throw failure(
      'VERIFICATION_RUNTIME_PROJECTION_CHUNK_MISSING',
      `candidate release lacks projection payload ${familyId}`,
    );
  }
  return decode(chunk.canonicalBytes) as T;
}

function verificationFieldValue(
  field: VerificationFieldContract,
  token: string,
): unknown {
  switch (field.fieldKind) {
    case 'booleanFieldType':
      return true;
    case 'enumFieldType':
      if (!field.enumOptionIds[0]) {
        throw failure(
          'VERIFICATION_ENUM_OPTION_MISSING',
          `enum verification field has no option: ${field.fieldId}`,
        );
      }
      return field.enumOptionIds[0];
    case 'integerFieldType':
      return verificationNumericValue(field.fieldId, token);
    case 'exactDecimalFieldType':
    case 'moneyFieldType':
    case 'quantityFieldType':
      return verificationDecimalValue(field, token);
    case 'dateFieldType':
      return '2026-01-01';
    case 'timeFieldType':
      return '12:34:56';
    case 'dateTimeFieldType':
      return field.temporal.timezoneSemantics === 'utcInstant'
        ? '2026-01-01T12:34:56.000Z'
        : '2026-01-01T12:34:56.000';
    case 'textFieldType': {
      const value = `V-${createHash('sha256')
        .update(token, 'utf8')
        .update(Uint8Array.of(0))
        .update(field.fieldId, 'utf8')
        .digest('hex')}`;
      return field.bounds.maximumLength === null
        ? value
        : [...value].slice(0, field.bounds.maximumLength).join('');
    }
    default:
      throw failure(
        'VERIFICATION_FIELD_KIND_UNSUPPORTED',
        `verification field kind is unsupported: ${field.fieldKind}`,
      );
  }
}

function verificationNumericValue(fieldId: string, token: string): string {
  const hex = createHash('sha256')
    .update(token, 'utf8')
    .update(Uint8Array.of(0))
    .update(fieldId, 'utf8')
    .digest('hex')
    .slice(0, 12);
  return BigInt(`0x${hex}`).toString(10);
}

function verificationDecimalValue(
  field: VerificationFieldContract,
  token: string,
): string {
  const precision = field.bounds.precision ?? 12;
  const scale = field.bounds.scale ?? 0;
  const raw = BigInt(
    `0x${createHash('sha256')
      .update(token, 'utf8')
      .update(Uint8Array.of(0))
      .update(field.fieldId, 'utf8')
      .digest('hex')
      .slice(0, 12)}`,
  );
  const integerCapacity = Math.max(0, precision - scale);
  if (scale === 0) {
    const modulus = 10n ** BigInt(Math.max(1, Math.min(precision, 12)));
    return ((raw % (modulus - 1n)) + 1n).toString(10);
  }
  const integer =
    integerCapacity === 0
      ? '0'
      : (
          raw %
          10n ** BigInt(Math.max(1, Math.min(integerCapacity, 9)))
        ).toString(10);
  const fraction = (((raw / 10n) % 9n) + 1n).toString(10);
  return `${integer}.${fraction}`;
}

function hasNoRecords(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.records) &&
    value.records.length === 0
  );
}

function hasRecord(value: unknown, recordId: string): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.records) &&
    value.records.some(
      (record) => isRecord(record) && record.recordId === recordId,
    )
  );
}

function verificationActorIssuer(): TrustedActorEnvelopeIssuer {
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

function stableUuid(label: string): string {
  const bytes = createHash('sha256')
    .update('northstar.release-verification-runtime-identity/v1', 'utf8')
    .update(Uint8Array.of(0))
    .update(label, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function executionBinding(binding: ReleaseVerificationBinding) {
  return {
    artifactClosureDigest: binding.artifactClosureDigest,
    providerRunId: providerRunId(),
    releaseRoot: binding.releaseRoot,
    verificationPlanArtifactRoot: binding.verificationPlanArtifactRoot,
    verificationPlanSemanticDigest: binding.verificationPlanSemanticDigest,
  };
}

function providerRunId(): string {
  return `postgres-verification:${randomUUID()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function insertEvidence(
  client: PoolClient,
  context: TrustedRequestContext,
  evidenceId: MintedUuid,
  resultSet: Awaited<ReturnType<typeof executeVerificationPlan>>,
  executionSource: Readonly<{
    environmentId: string;
    evidenceId: MintedUuid;
    tenantId: string;
  }> = {
    environmentId: context.environmentId,
    evidenceId,
    tenantId: context.tenantId,
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.release_verification_evidence (
       tenant_id, environment_id, verification_evidence_id, evidence_version,
       release_root, artifact_closure_digest,
       verification_plan_artifact_root, verification_plan_semantic_digest,
       verification_plan_digest, result_set_digest, result_count, provider,
       provider_run_id, executed_tenant_id, executed_environment_id,
       executed_evidence_id, execution_scope, skipped_scenario_ids,
       impact_analysis_derivation, created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
       'FULL','[]'::jsonb,NULL,$17
     )`,
    [
      context.tenantId,
      context.environmentId,
      evidenceId,
      resultSet.schemaVersion,
      resultSet.releaseRoot,
      resultSet.artifactClosureDigest,
      resultSet.verificationPlanArtifactRoot,
      resultSet.verificationPlanSemanticDigest,
      resultSet.verificationPlanDigest,
      resultSet.resultSetDigest,
      resultSet.results.length,
      resultSet.provider,
      resultSet.providerRunId,
      executionSource.tenantId,
      executionSource.environmentId,
      executionSource.evidenceId,
      context.principalId,
    ],
  );
  for (const result of resultSet.results) {
    await client.query(
      `INSERT INTO platform.release_verification_results (
         tenant_id, environment_id, verification_evidence_id, scenario_id,
         scenario_fingerprint, result_version, positive_probe_digest,
         negative_probe_digest, provider, provider_run_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        context.tenantId,
        context.environmentId,
        evidenceId,
        result.scenarioId,
        result.scenarioFingerprint,
        result.schemaVersion,
        result.positiveProbeDigest,
        result.negativeProbeDigest,
        result.provider,
        result.providerRunId,
      ],
    );
  }
}

function assertClosedCommand(command: ExecuteReleaseVerificationCommand): void {
  const expected = ['compiledRelease', 'evidenceId', 'releaseId'];
  const actual = Object.keys(command).sort(compare);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(
      'release verification command is closed; skip, sampling, time-box, and unknown parameters are forbidden',
    );
  }
}

function snapshotExecutionCommand(
  command: ExecuteReleaseVerificationCommand,
): ExecuteReleaseVerificationCommand {
  assertClosedCommand(command);
  assertUuid(command.evidenceId, 'evidenceId');
  assertUuid(command.releaseId, 'releaseId');
  return Object.freeze({
    compiledRelease: structuredClone(command.compiledRelease),
    evidenceId: command.evidenceId,
    releaseId: command.releaseId,
  });
}

function assertExactCandidateArtifacts(
  compiledRelease: CompileSuccess,
  releaseRoot: string,
  persistedArtifacts: readonly CandidateArtifactRow[],
): void {
  const suppliedArtifacts = [...compiledRelease.bundle.artifacts].sort(
    (left, right) => compare(left.contentHash, right.contentHash),
  );
  const suppliedStagedArtifacts = [...compiledRelease.stagedArtifacts].sort(
    (left, right) => compare(left.contentHash, right.contentHash),
  );
  const persisted = [...persistedArtifacts].sort((left, right) =>
    compare(left.content_hash, right.content_hash),
  );
  const exactArtifacts = (supplied: typeof suppliedArtifacts): boolean =>
    supplied.length === persisted.length &&
    supplied.every((artifact, index) => {
      const stored = persisted[index];
      return (
        stored !== undefined &&
        artifact.contentHash === stored.content_hash &&
        artifact.artifactKind === stored.artifact_kind &&
        artifact.domainTag === stored.domain_tag &&
        artifact.mediaType === stored.media_type &&
        equalBytes(artifact.canonicalBytes, stored.canonical_bytes)
      );
    });
  const persistedRoot = persisted.find(
    (artifact) => artifact.content_hash === releaseRoot,
  );
  const manifestObjectBytes = new TextEncoder().encode(
    canonicalize(compiledRelease.bundle.releaseManifest),
  );
  if (
    !exactArtifacts(suppliedArtifacts) ||
    !exactArtifacts(suppliedStagedArtifacts) ||
    !persistedRoot ||
    !equalBytes(
      compiledRelease.bundle.releaseManifestBytes,
      persistedRoot.canonical_bytes,
    ) ||
    !equalBytes(manifestObjectBytes, persistedRoot.canonical_bytes)
  ) {
    throw failure(
      'VERIFICATION_CANDIDATE_ARTIFACT_MISMATCH',
      'verification execution requires the exact persisted candidate artifact bundle',
    );
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function decode(bytes: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw failure(
      'VERIFICATION_ARTIFACT_INVALID',
      'verification artifact must be a canonical object',
    );
  }
  return value as Record<string, unknown>;
}

function digestCanonical(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(Uint8Array.of(0))
    .update(canonicalize(value), 'utf8')
    .digest('hex');
}

function assertUuid(value: string, name: string): void {
  if (!uuidPattern.test(value)) throw new TypeError(`${name} must be a UUID`);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(
  code: string,
  message: string,
): ReleaseVerificationIntegrityError {
  return new ReleaseVerificationIntegrityError(code, message);
}
