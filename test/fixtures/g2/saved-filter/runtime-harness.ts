import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  canonicalize,
  canonicalizeAndHash,
  parseNormalizedApplicationPackageJson,
} from '../../../../packages/canonical-model/src/index.js';
import { PLATFORM_IDS } from '../../../../packages/domain/src/platform/index.js';
import type { MintedUuid } from '../../../../packages/platform-runtime/src/index.js';
import {
  loadMigrations,
  runMigrations,
} from '../../../../packages/postgres-provider/src/migrations.js';
import { PostgresImmutableReleaseRepository } from '../../../../packages/postgres-provider/src/release-repository.js';
import {
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
} from '../../../../packages/postgres-provider/src/release-verification-service.js';
import { PostgresSavedFilterExecutor } from '../../../../packages/postgres-provider/src/saved-filter-executor.js';
import { TrustedActorEnvelopeIssuer } from '../../../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  AuthenticatedRequestEntryAdapter,
  type TrustedRequestContext,
} from '../../../../packages/runtime/src/request-context.js';
import type {
  SemanticOperationExecutionRequest,
  SemanticOperationExecutor,
  SemanticOperationNonAcceptedRequest,
  SemanticOperationResultEnvelope,
} from '../../../../packages/runtime/src/semantic-operation-gateway.js';
import type {
  SemanticQueryExecutionRequest,
  SemanticQueryExecutor,
  SemanticQueryResultEnvelope,
} from '../../../../packages/runtime/src/semantic-query-gateway.js';
import { withEphemeralPostgres } from '../../../helpers/postgres.js';

import { compilePlatformFixture, platformDefinitionBytes } from './compiler.js';

const migrations = resolve('db/migrations');

const savedFilterVerificationScope = Object.freeze({
  environmentId: 'd1100000-0000-4000-8000-000000000091',
  principalId: 'd1200000-0000-4000-8000-000000000092',
  tenantId: 'd1300000-0000-4000-8000-000000000093',
});

export interface SavedFilterAdmissionRefusal {
  readonly admissionCount: number;
  readonly admissionErrorCode: string;
  readonly evidenceCount: number;
  readonly executionErrorCode: string;
  readonly executionErrorMessage: string;
  readonly releaseRoot: string;
  readonly scenarioKinds: readonly string[];
}

/**
 * The platform definition currently claims a complete Tier-A query surface,
 * while its bespoke executor implements only get/list. Execute the compiled
 * verification plan against that executor and prove admission stays closed.
 */
export async function observeSavedFilterAdmissionRefusal(
  label: string,
): Promise<SavedFilterAdmissionRefusal> {
  const fixture = compilePlatformFixture();
  const binding = releaseVerificationBinding(fixture.compiled);
  return withEphemeralPostgres(label, async ({ connection, pool }) => {
    await migrateAndSeed(pool);
    const runtimePool = new pg.Pool({
      ...connection,
      max: 4,
      user: 'north_star_runtime',
    });
    runtimePool.on('error', () => undefined);
    try {
      const context = await trustedContext();
      await pool.query(
        'SELECT platform.set_release_executor_authority($1,$2,true,$2,$3)',
        [context.tenantId, context.principalId, randomUUID()],
      );
      const repository = new PostgresImmutableReleaseRepository(runtimePool);
      const revisionId = minted(randomUUID());
      const releaseId = minted(randomUUID());
      const desiredState = platformDefinitionBytes(fixture.definition);
      const normalizedDefinition =
        parseNormalizedApplicationPackageJson(desiredState);
      const definitionDigest = canonicalizeAndHash(normalizedDefinition);
      await repository.storeAppPackageRevision(context, {
        canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
        contentHash: definitionDigest.contentHash,
        createdBy: context.principalId,
        desiredState,
        hashAlgorithm: CONTENT_HASH_ALGORITHM,
        languageVersion: normalizedDefinition.languageVersion,
        normalizationProfileVersion:
          normalizedDefinition.normalizationProfileVersion,
        parentRevisionId: null,
        provenance: 'firstParty',
        revisionId,
        schemaVersion: normalizedDefinition.schemaVersion,
        tenantId: context.tenantId,
      });
      const staged = await repository.stageTenantReleaseCandidate(context, {
        appPackageRevisionId: revisionId,
        compiledRelease: fixture.compiled,
        createdBy: context.principalId,
        environmentId: context.environmentId,
        releaseId,
        tenantId: context.tenantId,
      });
      const command = {
        appPackageRevisionId: revisionId,
        compiledRelease: fixture.compiled,
        createdBy: context.principalId,
        environmentId: context.environmentId,
        releaseId,
        tenantId: context.tenantId,
        verificationEvidenceId: staged.verificationEvidenceId,
      };
      const executor = new SavedFilterVerificationExecutor(
        new PostgresSavedFilterExecutor(
          runtimePool,
          humanActorIssuer(),
          PLATFORM_IDS,
        ),
      );
      const executionError = await capturedFailure(
        new PostgresReleaseVerificationService(
          runtimePool,
        ).executeSemanticCandidateWithExecutor(
          context,
          {
            compiledRelease: fixture.compiled,
            evidenceId: staged.verificationEvidenceId,
            releaseId,
          },
          executor,
        ),
      );
      const admissionError = await capturedFailure(
        repository.registerTenantRelease(context, command),
      );
      const evidence = await pool.query<{ count: string }>(
        `SELECT count(*) AS count
           FROM platform.release_verification_evidence
          WHERE tenant_id = $1 AND environment_id = $2`,
        [context.tenantId, context.environmentId],
      );
      const admissions = await pool.query<{ count: string }>(
        `SELECT count(*) AS count
           FROM platform.tenant_release_admissions
          WHERE tenant_id = $1 AND environment_id = $2`,
        [context.tenantId, context.environmentId],
      );
      return Object.freeze({
        admissionCount: Number(admissions.rows[0]?.count),
        admissionErrorCode: requiredErrorCode(admissionError),
        evidenceCount: Number(evidence.rows[0]?.count),
        executionErrorCode: requiredErrorCode(executionError),
        executionErrorMessage:
          executionError instanceof Error
            ? executionError.message
            : String(executionError),
        releaseRoot: fixture.compiled.releaseRoot,
        scenarioKinds: Object.freeze(
          binding.plan.scenarios.map((scenario) => scenario.kind),
        ),
      });
    } finally {
      await runtimePool.end();
    }
  });
}

class SavedFilterVerificationExecutor
  implements SemanticOperationExecutor, SemanticQueryExecutor
{
  constructor(private readonly executor: PostgresSavedFilterExecutor) {}

  execute(
    request: SemanticOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope>;
  execute(
    request: SemanticQueryExecutionRequest,
  ): Promise<SemanticQueryResultEnvelope>;
  execute(
    request: SemanticOperationExecutionRequest | SemanticQueryExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope | SemanticQueryResultEnvelope> {
    if ('idempotencyKey' in request) {
      if (request.definition.effect.kind !== 'createRecordEffect') {
        return this.executor.execute(request);
      }
      const input = request.input as Readonly<{
        recordId: string;
        relations: Readonly<Record<string, string>>;
      }>;
      return this.executor.execute({
        ...request,
        input: {
          recordId: input.recordId,
          relations: input.relations,
          values: {
            [PLATFORM_IDS.fieldIds.criteria]: canonicalize({
              kind: 'booleanPredicate',
              schemaVersion: request.definition.effect.schemaVersion,
              value: true,
            }),
            [PLATFORM_IDS.fieldIds.name]: `Verification ${input.recordId}`,
            [PLATFORM_IDS.fieldIds.queryId]: PLATFORM_IDS.queryIds.list,
          },
        },
      });
    }
    if (request.definition.queryType === 'get') {
      const arguments_ = request.arguments as Readonly<{
        recordId?: string;
      }>;
      const recordId = arguments_.recordId;
      if (typeof recordId !== 'string') {
        throw new Error('verification get query is missing its recordId probe');
      }
      return this.executor.execute({
        ...request,
        arguments: { filterId: recordId },
      });
    }
    if (request.definition.queryType === 'list') {
      return this.executor.execute({
        ...request,
        arguments: { queryId: PLATFORM_IDS.queryIds.list },
      });
    }
    return this.executor.execute(request);
  }

  recordNonAccepted(
    request: SemanticOperationNonAcceptedRequest,
  ): Promise<void> {
    return this.executor.recordNonAccepted(request);
  }
}

async function migrateAndSeed(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const loaded = await loadMigrations(migrations);
    const result = await runMigrations(client, loaded);
    assert.equal(result.applied.length, loaded.length);
    assert.equal(result.verified.length, loaded.length);
    await client.query(
      'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
      [savedFilterVerificationScope.tenantId, 'saved-filter-verification'],
    );
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'verification')`,
      [
        savedFilterVerificationScope.tenantId,
        savedFilterVerificationScope.environmentId,
      ],
    );
  } finally {
    client.release();
  }
}

async function trustedContext(): Promise<TrustedRequestContext> {
  return new AuthenticatedRequestEntryAdapter(
    async () => savedFilterVerificationScope,
  ).enter({});
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

async function capturedFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('expected operation to fail closed');
}

function requiredErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  throw error;
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}
