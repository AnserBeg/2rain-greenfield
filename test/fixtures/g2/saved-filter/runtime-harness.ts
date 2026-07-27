import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  canonicalizeAndHash,
} from '../../../../packages/canonical-model/src/index.js';
import type { CompileSuccess } from '../../../../packages/compiler/src/index.js';
import { PLATFORM_IDS } from '../../../../packages/domain/src/platform/index.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../../../packages/platform-runtime/src/index.js';
import { PostgresSavedFilterExecutor } from '../../../../packages/postgres-provider/src/saved-filter-executor.js';
import {
  loadMigrations,
  runMigrations,
} from '../../../../packages/postgres-provider/src/migrations.js';
import { PostgresImmutableReleaseRepository } from '../../../../packages/postgres-provider/src/release-repository.js';
import { PostgresRequestRuntimeViewService } from '../../../../packages/postgres-provider/src/request-runtime-view-service.js';
import { TrustedActorEnvelopeIssuer } from '../../../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../../../packages/runtime/src/request-context.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  type SemanticOperationResultEnvelope,
} from '../../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
  type SemanticQueryResultEnvelope,
} from '../../../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type ImmutableJsonValue,
  type RequestRuntimeView,
} from '../../../../packages/runtime/src/request-runtime-view.js';
import { withEphemeralPostgres } from '../../../helpers/postgres.js';

import { compilePlatformFixture, platformDefinitionBytes } from './compiler.js';

const migrations = resolve('db/migrations');

export const SAVED_FILTER_TEST_SCOPE = Object.freeze({
  a: {
    environmentId: 'd1100000-0000-4000-8000-000000000001',
    principalId: 'd1200000-0000-4000-8000-000000000002',
    tenantId: 'd1300000-0000-4000-8000-000000000003',
  },
  alternatePrincipal: {
    environmentId: 'd1100000-0000-4000-8000-000000000001',
    principalId: 'd1200000-0000-4000-8000-000000000004',
    tenantId: 'd1300000-0000-4000-8000-000000000003',
  },
  alternateEnvironment: {
    environmentId: 'd1100000-0000-4000-8000-000000000005',
    principalId: 'd1200000-0000-4000-8000-000000000002',
    tenantId: 'd1300000-0000-4000-8000-000000000003',
  },
  b: {
    environmentId: 'd2100000-0000-4000-8000-000000000001',
    principalId: 'd2200000-0000-4000-8000-000000000002',
    tenantId: 'd2300000-0000-4000-8000-000000000003',
  },
});

export interface SavedFilterRuntime {
  readonly adminPool: pg.Pool;
  readonly contexts: Readonly<
    Record<
      'a' | 'alternateEnvironment' | 'alternatePrincipal' | 'b',
      TrustedRequestContext
    >
  >;
  readonly entry: AuthenticatedRequestRuntimeEntryAdapter;
  readonly operationGateway: SemanticOperationGateway;
  readonly operationMediation: SemanticOperationMediationAuthority;
  readonly queryGateway: SemanticQueryGateway;
  readonly runtimePool: pg.Pool;
  readonly supersedeA: () => Promise<RequestRuntimeView>;
  readonly views: Readonly<
    Record<
      'a' | 'alternateEnvironment' | 'alternatePrincipal' | 'b',
      RequestRuntimeView
    >
  >;
}

export async function withSavedFilterRuntime<T>(
  label: string,
  run: (runtime: SavedFilterRuntime) => Promise<T>,
): Promise<T> {
  const fixture = compilePlatformFixture();
  return withEphemeralPostgres(label, async ({ connection, pool }) => {
    await migrateAndSeed(pool);
    const runtimePool = new pg.Pool({
      ...connection,
      max: 4,
      user: 'north_star_runtime',
    });
    runtimePool.on('error', () => undefined);
    try {
      const contexts = await trustedContexts();
      const releaseA = await persistRelease(
        runtimePool,
        contexts.a,
        fixture.compiled,
        fixture.definition,
      );
      const releaseB = await persistRelease(
        runtimePool,
        contexts.b,
        fixture.compiled,
        fixture.definition,
      );
      const releaseAlternateEnvironment = await persistRelease(
        runtimePool,
        contexts.alternateEnvironment,
        fixture.compiled,
        fixture.definition,
      );
      await setPointer(
        pool,
        SAVED_FILTER_TEST_SCOPE.alternateEnvironment.tenantId,
        SAVED_FILTER_TEST_SCOPE.alternateEnvironment.environmentId,
        releaseAlternateEnvironment,
      );
      await setPointer(
        pool,
        SAVED_FILTER_TEST_SCOPE.a.tenantId,
        SAVED_FILTER_TEST_SCOPE.a.environmentId,
        releaseA,
      );
      await setPointer(
        pool,
        SAVED_FILTER_TEST_SCOPE.b.tenantId,
        SAVED_FILTER_TEST_SCOPE.b.environmentId,
        releaseB,
      );
      await grantExecutorAuthority(pool);

      const policy = new AllowPolicy();
      const executor = new PostgresSavedFilterExecutor(
        runtimePool,
        humanActorIssuer(),
        PLATFORM_IDS,
      );
      const queryGateway = new SemanticQueryGateway(policy, executor);
      const operationMediation = new SemanticOperationMediationAuthority();
      const operationGateway = new SemanticOperationGateway(
        policy,
        executor,
        operationMediation,
      );
      const entry = runtimeEntry(runtimePool, policy);
      const views = {
        a: await issuedView(entry, 'a'),
        alternateEnvironment: await issuedView(entry, 'alternateEnvironment'),
        alternatePrincipal: await issuedView(entry, 'alternatePrincipal'),
        b: await issuedView(entry, 'b'),
      };
      return await run({
        adminPool: pool,
        contexts,
        entry,
        operationGateway,
        operationMediation,
        queryGateway,
        runtimePool,
        supersedeA: async () => {
          const release = await persistRelease(
            runtimePool,
            contexts.a,
            fixture.compiled,
            fixture.definition,
          );
          await setPointer(
            pool,
            SAVED_FILTER_TEST_SCOPE.a.tenantId,
            SAVED_FILTER_TEST_SCOPE.a.environmentId,
            release,
          );
          return issuedView(entry, 'a');
        },
        views,
      });
    } finally {
      await runtimePool.end();
    }
  });
}

export function invokeSavedFilterOperation(
  runtime: SavedFilterRuntime,
  view: RequestRuntimeView,
  action: keyof typeof PLATFORM_IDS.operationIds,
  input: Record<string, unknown>,
): Promise<SemanticOperationResultEnvelope> {
  const operationId = PLATFORM_IDS.operationIds[action];
  const confirmationRequired = action === 'archive';
  return runtime.operationGateway.invoke(
    view,
    {
      confirmationGrant: confirmationRequired
        ? runtime.operationMediation.issueConfirmationGrant(
            view,
            operationId,
            input as ImmutableJsonValue,
          )
        : null,
      idempotencyKey: randomUUID(),
      input,
      operationId,
      schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
    },
    runtime.operationMediation.issueInvocation(view, 'UI'),
  );
}

export function invokeSavedFilterQuery(
  runtime: SavedFilterRuntime,
  view: RequestRuntimeView,
  query: keyof typeof PLATFORM_IDS.queryIds,
  arguments_: Record<string, unknown>,
): Promise<SemanticQueryResultEnvelope> {
  return runtime.queryGateway.invoke(view, {
    arguments: arguments_,
    queryId: PLATFORM_IDS.queryIds[query],
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
}

class AllowPolicy implements CurrentPolicyGateway {
  readonly calls: CurrentPolicyDecisionRequest[] = [];

  async authorize(request: CurrentPolicyDecisionRequest) {
    this.calls.push(request);
    return {
      decision: 'ALLOW' as const,
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'saved-filter-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'saved-filter-policy/v1' };
  }
}

function runtimeEntry(
  pool: pg.Pool,
  policy: CurrentPolicyGateway,
): AuthenticatedRequestRuntimeEntryAdapter {
  const identities: Record<string, AuthenticatedIdentity> = {
    a: SAVED_FILTER_TEST_SCOPE.a,
    alternateEnvironment: SAVED_FILTER_TEST_SCOPE.alternateEnvironment,
    alternatePrincipal: SAVED_FILTER_TEST_SCOPE.alternatePrincipal,
    b: SAVED_FILTER_TEST_SCOPE.b,
  };
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async (request) => {
      const token = request.headers?.authorization;
      return typeof token === 'string' ? (identities[token] ?? null) : null;
    }),
    new PostgresRequestRuntimeViewService(pool),
    policy,
  );
}

async function issuedView(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  token: string,
): Promise<RequestRuntimeView> {
  return entry.run({ headers: { authorization: token } }, (view) => view);
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

async function trustedContexts(): Promise<
  Record<
    'a' | 'alternateEnvironment' | 'alternatePrincipal' | 'b',
    TrustedRequestContext
  >
> {
  const identities: Record<string, AuthenticatedIdentity> = {
    a: SAVED_FILTER_TEST_SCOPE.a,
    alternateEnvironment: SAVED_FILTER_TEST_SCOPE.alternateEnvironment,
    alternatePrincipal: SAVED_FILTER_TEST_SCOPE.alternatePrincipal,
    b: SAVED_FILTER_TEST_SCOPE.b,
  };
  const entry = new AuthenticatedRequestEntryAdapter(async (request) => {
    const token = request.headers?.authorization;
    return typeof token === 'string' ? (identities[token] ?? null) : null;
  });
  return {
    a: await entry.enter({ headers: { authorization: 'a' } }),
    alternateEnvironment: await entry.enter({
      headers: { authorization: 'alternateEnvironment' },
    }),
    alternatePrincipal: await entry.enter({
      headers: { authorization: 'alternatePrincipal' },
    }),
    b: await entry.enter({ headers: { authorization: 'b' } }),
  };
}

async function migrateAndSeed(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const loaded = await loadMigrations(migrations);
    const result = await runMigrations(client, loaded);
    assert.equal(result.applied.length, loaded.length);
    assert.equal(result.verified.length, loaded.length);
    for (const [scope, slug] of [
      [SAVED_FILTER_TEST_SCOPE.a, 'saved-filter-a'],
      [SAVED_FILTER_TEST_SCOPE.b, 'saved-filter-b'],
    ] as const) {
      await client.query(
        'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
        [scope.tenantId, slug],
      );
    }
    for (const [scope, slug] of [
      [SAVED_FILTER_TEST_SCOPE.a, 'production'],
      [SAVED_FILTER_TEST_SCOPE.alternateEnvironment, 'preview'],
      [SAVED_FILTER_TEST_SCOPE.b, 'production'],
    ] as const) {
      await client.query(
        `INSERT INTO platform.environments (tenant_id, id, slug)
         VALUES ($1,$2,$3)`,
        [scope.tenantId, scope.environmentId, slug],
      );
    }
  } finally {
    client.release();
  }
}

async function persistRelease(
  runtimePool: pg.Pool,
  context: TrustedRequestContext,
  compiled: CompileSuccess,
  definition: Record<string, unknown>,
): Promise<MintedUuid> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const revisionId = minted(randomUUID());
  const releaseId = minted(randomUUID());
  const desiredState = platformDefinitionBytes(definition);
  await repository.storeAppPackageRevision(
    context,
    revisionCommand(context, revisionId, desiredState),
  );
  await repository.registerTenantRelease(
    context,
    releaseCommand(context, releaseId, revisionId, compiled),
  );
  return releaseId;
}

function revisionCommand(
  context: TrustedRequestContext,
  revisionId: MintedUuid,
  desiredState: Uint8Array,
): StoreAppPackageRevisionCommand {
  const digest = canonicalizeAndHash(
    JSON.parse(new TextDecoder().decode(desiredState)) as unknown,
  );
  return {
    canonicalizationProfileVersion: CANONICALIZATION_PROFILE_VERSION,
    contentHash: digest.contentHash,
    createdBy: context.principalId,
    desiredState,
    hashAlgorithm: CONTENT_HASH_ALGORITHM,
    languageVersion: LANGUAGE_VERSION,
    normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
    parentRevisionId: null,
    provenance: 'firstParty',
    revisionId,
    schemaVersion: LANGUAGE_VERSION,
    tenantId: context.tenantId,
  };
}

function releaseCommand(
  context: TrustedRequestContext,
  releaseId: MintedUuid,
  revisionId: MintedUuid,
  compiledRelease: CompileSuccess,
): RegisterTenantReleaseCommand<CompileSuccess> {
  return {
    appPackageRevisionId: revisionId,
    compiledRelease,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId: minted(randomUUID()),
  };
}

async function setPointer(
  pool: pg.Pool,
  tenantId: string,
  environmentId: string,
  releaseId: string,
): Promise<void> {
  await pool.query(
    'ALTER TABLE platform.active_release_pointers DISABLE TRIGGER active_release_pointer_exact_swap',
  );
  try {
    const result = await pool.query(
      `UPDATE platform.active_release_pointers
          SET release_id = $3, fence = fence + 1
        WHERE tenant_id = $1 AND environment_id = $2`,
      [tenantId, environmentId, releaseId],
    );
    assert.equal(result.rowCount, 1);
  } finally {
    await pool.query(
      'ALTER TABLE platform.active_release_pointers ENABLE TRIGGER active_release_pointer_exact_swap',
    );
  }
}

async function grantExecutorAuthority(pool: pg.Pool): Promise<void> {
  const granted = new Set<string>();
  for (const scope of Object.values(SAVED_FILTER_TEST_SCOPE)) {
    const key = `${scope.tenantId}:${scope.principalId}`;
    if (granted.has(key)) continue;
    granted.add(key);
    await pool.query(
      'SELECT platform.set_release_executor_authority($1,$2,true,$2,$3)',
      [scope.tenantId, scope.principalId, randomUUID()],
    );
  }
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}
