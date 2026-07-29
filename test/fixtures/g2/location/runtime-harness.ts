import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { resolve } from 'node:path';

import pg from 'pg';

import { createSurfaceRuntimeServer } from '../../../../apps/web/src/app-server.js';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  canonicalizeAndHash,
} from '../../../../packages/canonical-model/src/index';
import type { CompileSuccess } from '../../../../packages/compiler/src/index';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../../../packages/platform-runtime/src/index';
import { PostgresModuleRuntimeInterpreter } from '../../../../packages/postgres-provider/src/module-runtime-interpreter';
import { PostgresModuleStorageMaterializer } from '../../../../packages/postgres-provider/src/module-storage-materializer';
import {
  loadMigrations,
  runMigrations,
} from '../../../../packages/postgres-provider/src/migrations';
import { PostgresImmutableReleaseRepository } from '../../../../packages/postgres-provider/src/release-repository';
import {
  PostgresReleaseVerificationFederationService,
  PostgresReleaseVerificationService,
  releaseVerificationBinding,
} from '../../../../packages/postgres-provider/src/release-verification-service';
import { PostgresRequestRuntimeViewService } from '../../../../packages/postgres-provider/src/request-runtime-view-service';
import { TrustedActorEnvelopeIssuer } from '../../../../packages/postgres-provider/src/trust/trusted-actor-envelope';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../../../packages/runtime/src/request-context';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
  type SemanticOperationResultEnvelope,
} from '../../../../packages/runtime/src/semantic-operation-gateway';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
  type SemanticQueryResultEnvelope,
} from '../../../../packages/runtime/src/semantic-query-gateway';
import { resolveByName } from '../../../../packages/runtime/src/resolve-by-name.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type ImmutableJsonValue,
  type RequestRuntimeView,
} from '../../../../packages/runtime/src/request-runtime-view';
import { withEphemeralPostgres } from '../../../helpers/postgres';

import { LOCATION_IDS } from '../../../../packages/domain/src/location/index';
import {
  compileLocationFixture,
  locationDefinitionBytes,
  locationStorageTarget,
} from './compiler';

const migrations = resolve('db/migrations');
const warehouseType = `${LOCATION_IDS.namespace}:option.warehouse`;

export const LOCATION_TEST_SCOPE = Object.freeze({
  a: {
    environmentId: '91100000-0000-4000-8000-000000000001',
    principalId: '91200000-0000-4000-8000-000000000002',
    tenantId: '91300000-0000-4000-8000-000000000003',
  },
  b: {
    environmentId: '92100000-0000-4000-8000-000000000001',
    principalId: '92200000-0000-4000-8000-000000000002',
    tenantId: '92300000-0000-4000-8000-000000000003',
  },
});

const locationVerificationScope = Object.freeze({
  environmentId: '91100000-0000-4000-8000-000000000099',
  principalId: LOCATION_TEST_SCOPE.a.principalId,
  tenantId: LOCATION_TEST_SCOPE.a.tenantId,
});

export interface RealLocationRuntime {
  readonly adminPool: pg.Pool;
  readonly compiled: CompileSuccess;
  readonly contexts: Readonly<Record<'a' | 'b', TrustedRequestContext>>;
  readonly entry: AuthenticatedRequestRuntimeEntryAdapter;
  readonly operationGateway: SemanticOperationGateway;
  readonly operationMediation: SemanticOperationMediationAuthority;
  readonly queryGateway: SemanticQueryGateway;
  readonly runtimePool: pg.Pool;
  readonly storage: ReturnType<typeof locationStorageTarget>;
  readonly views: Readonly<Record<'a' | 'b', RequestRuntimeView>>;
}

export async function withRealLocationRuntime<T>(
  label: string,
  run: (runtime: RealLocationRuntime) => Promise<T>,
): Promise<T> {
  const fixture = compileLocationFixture();
  return withEphemeralPostgres(label, async ({ connection, pool }) => {
    await migrateAndSeed(pool);
    const runtimePool = new pg.Pool({
      ...connection,
      max: 4,
      user: 'north_star_runtime',
    });
    const materializerPool = new pg.Pool({
      ...connection,
      max: 2,
      user: 'north_star_module_materializer',
    });
    const modulePool = new pg.Pool({
      ...connection,
      max: 2,
      user: 'north_star_module_runtime',
    });
    materializerPool.on('error', () => undefined);
    modulePool.on('error', () => undefined);
    try {
      const contexts = await trustedContexts();
      const releasesA = await persistSequence(runtimePool, contexts.a, [
        [fixture.empty, fixture.emptyDefinition],
        [fixture.compiled, fixture.definition],
      ]);
      const releasesB = await persistSequence(runtimePool, contexts.b, [
        [fixture.empty, fixture.emptyDefinition],
        [fixture.compiled, fixture.definition],
      ]);
      const verificationReleases = await persistSequence(
        runtimePool,
        contexts.verification,
        [
          [fixture.empty, fixture.emptyDefinition],
          [fixture.compiled, fixture.definition],
        ],
      );
      await setPointer(
        pool,
        LOCATION_TEST_SCOPE.a.tenantId,
        LOCATION_TEST_SCOPE.a.environmentId,
        releasesA[0]!.releaseId,
      );
      await setPointer(
        pool,
        LOCATION_TEST_SCOPE.b.tenantId,
        LOCATION_TEST_SCOPE.b.environmentId,
        releasesB[0]!.releaseId,
      );
      await setPointer(
        pool,
        locationVerificationScope.tenantId,
        locationVerificationScope.environmentId,
        verificationReleases[0]!.releaseId,
      );
      await grantExecutorAuthority(pool);
      const materializer = new PostgresModuleStorageMaterializer(
        materializerPool,
        modulePool,
      );
      await prepare(
        materializer,
        contexts.verification,
        verificationReleases[1]!.releaseId,
      );
      await admitCandidate(
        runtimePool,
        contexts.verification,
        verificationReleases[1]!,
      );
      await federateCandidate(
        pool,
        runtimePool,
        contexts.verification,
        verificationReleases[1]!,
        contexts.a,
        releasesA[1]!,
      );
      await federateCandidate(
        pool,
        runtimePool,
        contexts.verification,
        verificationReleases[1]!,
        contexts.b,
        releasesB[1]!,
      );
      await prepare(materializer, contexts.a, releasesA[1]!.releaseId);
      await prepare(materializer, contexts.b, releasesB[1]!.releaseId);
      await setPointer(
        pool,
        LOCATION_TEST_SCOPE.a.tenantId,
        LOCATION_TEST_SCOPE.a.environmentId,
        releasesA[1]!.releaseId,
      );
      await setPointer(
        pool,
        LOCATION_TEST_SCOPE.b.tenantId,
        LOCATION_TEST_SCOPE.b.environmentId,
        releasesB[1]!.releaseId,
      );

      const policy = new AllowPolicy();
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
      const entry = runtimeEntry(runtimePool, policy);
      const views = {
        a: await issuedView(entry, 'a'),
        b: await issuedView(entry, 'b'),
      };
      return await run({
        adminPool: pool,
        compiled: fixture.compiled,
        contexts,
        entry,
        operationGateway,
        operationMediation,
        queryGateway,
        runtimePool,
        storage: locationStorageTarget(fixture.compiled),
        views,
      });
    } finally {
      await Promise.all([
        runtimePool.end(),
        materializerPool.end(),
        modulePool.end(),
      ]);
    }
  });
}

export function invokeLocationOperation(
  runtime: RealLocationRuntime,
  view: RequestRuntimeView,
  localId: string,
  input: Record<string, unknown>,
): Promise<SemanticOperationResultEnvelope> {
  const operationId = `${LOCATION_IDS.namespace}:operation.${localId}`;
  const confirmationRequired = (
    view.projections.operation.payload as {
      operations: Array<{ confirmation: string; operationId: string }>;
    }
  ).operations.some(
    (operation) =>
      operation.operationId === operationId &&
      operation.confirmation === 'humanRequired',
  );
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
    runtime.operationMediation.issueInvocation(view, 'API'),
  );
}

export function invokeLocationQuery(
  runtime: RealLocationRuntime,
  view: RequestRuntimeView,
  localId: string,
  arguments_: Record<string, unknown>,
): Promise<SemanticQueryResultEnvelope> {
  return runtime.queryGateway.invoke(view, {
    arguments: arguments_,
    queryId: `${LOCATION_IDS.namespace}:query.${localId}`,
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
      policyVersion: 'location-runtime-policy/v1',
    };
  }

  async readCurrentVersion(_subject: CurrentPolicySubject) {
    void _subject;
    return { policyVersion: 'location-runtime-policy/v1' };
  }
}

function runtimeEntry(
  pool: pg.Pool,
  policy: CurrentPolicyGateway,
): AuthenticatedRequestRuntimeEntryAdapter {
  const identities: Record<string, AuthenticatedIdentity> = {
    a: LOCATION_TEST_SCOPE.a,
    b: LOCATION_TEST_SCOPE.b,
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
  Record<'a' | 'b' | 'verification', TrustedRequestContext>
> {
  const entry = new AuthenticatedRequestEntryAdapter(async (request) => {
    const token = request.headers?.authorization;
    return token === 'a'
      ? LOCATION_TEST_SCOPE.a
      : token === 'b'
        ? LOCATION_TEST_SCOPE.b
        : token === 'verification'
          ? locationVerificationScope
          : null;
  });
  return {
    a: await entry.enter({ headers: { authorization: 'a' } }),
    b: await entry.enter({ headers: { authorization: 'b' } }),
    verification: await entry.enter({
      headers: { authorization: 'verification' },
    }),
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
      [LOCATION_TEST_SCOPE.a, 'location-a'],
      [LOCATION_TEST_SCOPE.b, 'location-b'],
    ] as const) {
      await client.query(
        'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
        [scope.tenantId, slug],
      );
      await client.query(
        `INSERT INTO platform.environments (tenant_id, id, slug)
         VALUES ($1,$2,'production')`,
        [scope.tenantId, scope.environmentId],
      );
    }
    await client.query(
      `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1,$2,'verification')`,
      [
        locationVerificationScope.tenantId,
        locationVerificationScope.environmentId,
      ],
    );
  } finally {
    client.release();
  }
}

async function persistSequence(
  runtimePool: pg.Pool,
  context: TrustedRequestContext,
  entries: ReadonlyArray<readonly [CompileSuccess, Record<string, unknown>]>,
): Promise<StagedRelease[]> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const verification = new PostgresReleaseVerificationService(runtimePool);
  const releases: StagedRelease[] = [];
  for (const [compiled, definition] of entries) {
    const revisionId = minted(randomUUID());
    const releaseId = minted(randomUUID());
    const desiredState = locationDefinitionBytes(definition);
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, revisionId, desiredState),
    );
    const stageCommand = {
      appPackageRevisionId: revisionId,
      compiledRelease: compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId,
      tenantId: context.tenantId,
    };
    const staged = await repository.stageTenantReleaseCandidate(
      context,
      stageCommand,
    );
    const command = releaseCommand(
      context,
      releaseId,
      revisionId,
      compiled,
      staged.verificationEvidenceId,
    );
    const release = Object.freeze({ command, compiled, releaseId });
    releases.push(release);
    if (releaseVerificationBinding(compiled).plan.scenarios.length === 0) {
      await verification.executeSemanticCandidateAndPersist(context, {
        compiledRelease: compiled,
        evidenceId: staged.verificationEvidenceId,
        releaseId,
      });
      await repository.registerTenantRelease(context, command);
    }
  }
  return releases;
}

interface StagedRelease {
  readonly command: RegisterTenantReleaseCommand<CompileSuccess>;
  readonly compiled: CompileSuccess;
  readonly releaseId: MintedUuid;
}

async function admitCandidate(
  runtimePool: pg.Pool,
  context: TrustedRequestContext,
  release: StagedRelease,
): Promise<void> {
  await new PostgresReleaseVerificationService(
    runtimePool,
  ).executeSemanticCandidateAndPersist(context, {
    compiledRelease: release.compiled,
    evidenceId: release.command.verificationEvidenceId,
    releaseId: release.releaseId,
  });
  await new PostgresImmutableReleaseRepository(
    runtimePool,
  ).registerTenantRelease(context, release.command);
}

async function federateCandidate(
  adminPool: pg.Pool,
  runtimePool: pg.Pool,
  sourceContext: TrustedRequestContext,
  source: StagedRelease,
  targetContext: TrustedRequestContext,
  target: StagedRelease,
): Promise<void> {
  await new PostgresReleaseVerificationFederationService(adminPool).federate({
    compiledRelease: target.compiled,
    sourceEnvironmentId: sourceContext.environmentId,
    sourceEvidenceId: source.command.verificationEvidenceId,
    sourceTenantId: sourceContext.tenantId,
    targetContext,
    targetEvidenceId: target.command.verificationEvidenceId,
    targetReleaseId: target.releaseId,
  });
  await new PostgresImmutableReleaseRepository(
    runtimePool,
  ).registerTenantRelease(targetContext, target.command);
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
  verificationEvidenceId: MintedUuid,
): RegisterTenantReleaseCommand<CompileSuccess> {
  return {
    appPackageRevisionId: revisionId,
    compiledRelease,
    createdBy: context.principalId,
    environmentId: context.environmentId,
    releaseId,
    tenantId: context.tenantId,
    verificationEvidenceId,
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
  for (const scope of [LOCATION_TEST_SCOPE.a, LOCATION_TEST_SCOPE.b]) {
    await pool.query(
      'SELECT platform.set_release_executor_authority($1,$2,true,$2,$3)',
      [scope.tenantId, scope.principalId, randomUUID()],
    );
  }
}

async function prepare(
  materializer: PostgresModuleStorageMaterializer,
  context: TrustedRequestContext,
  releaseId: MintedUuid,
): Promise<void> {
  const prepared = await materializer.prepare({
    context,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    generationId: randomUUID(),
    initiatedBy: context.principalId,
    preparationId: randomUUID(),
    targetReleaseId: releaseId,
  });
  assert.equal(prepared.schemaState, 'APPLIED');
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}

if (
  process.argv[1]?.endsWith('/test/fixtures/g2/location/runtime-harness.ts')
) {
  void runLocationBrowserFixture().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function runLocationBrowserFixture(): Promise<void> {
  await withRealLocationRuntime('location-browser', async (runtime) => {
    const before = await invokeLocationQuery(
      runtime,
      runtime.views.a,
      'location_list',
      { limit: 100 },
    );
    assert.deepEqual(
      before.records,
      [],
      'browser negative control requires an empty Location pre-state',
    );
    const locationId = randomUUID();
    const created = await invokeLocationOperation(
      runtime,
      runtime.views.a,
      'location_create',
      {
        recordId: locationId,
        values: locationValues(
          'LOC-WEB-001',
          'Browser Location',
          warehouseType,
        ),
      },
    );
    assert.equal(created.outcome, 'succeeded');
    assert.ok(created.trust);
    assert.equal(
      (
        await resolveByName(
          runtime.queryGateway,
          runtime.views.a,
          {
            exactIdentifierFieldIds: [LOCATION_IDS.fieldIds.code],
            listQueryId: `${LOCATION_IDS.namespace}:query.location_list`,
            nameFieldIds: [LOCATION_IDS.fieldIds.name],
            resolveQueryId: `${LOCATION_IDS.namespace}:query.location_resolve`,
          },
          'LOC-WEB-001',
        )
      ).outcome,
      'exact',
    );
    const server = createSurfaceRuntimeServer(runtime.entry, {
      operationGateway: runtime.operationGateway,
      operationMediation: runtime.operationMediation,
      queryGateway: runtime.queryGateway,
    });
    const baseUrl = await listen(server);
    process.stdout.write(
      `LOCATION_BROWSER_READY ${JSON.stringify({ baseUrl, locationId })}\n`,
    );
    await shutdownSignal();
    await close(server);
  });
}

function locationValues(
  code: string,
  name: string,
  locationType: string,
): Record<string, string> {
  return {
    [LOCATION_IDS.fieldIds.locationType]: locationType,
    [LOCATION_IDS.fieldIds.name]: name,
    [LOCATION_IDS.fieldIds.code]: code,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function shutdownSignal(): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    process.once('SIGINT', resolveShutdown);
    process.once('SIGTERM', resolveShutdown);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
