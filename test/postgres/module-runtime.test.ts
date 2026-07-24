import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  CANONICALIZATION_PROFILE_VERSION,
  CONTENT_HASH_ALGORITHM,
  LANGUAGE_VERSION,
  NORMALIZATION_PROFILE_VERSION,
  canonicalize,
  canonicalizeAndHash,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import {
  DEFAULT_COMPILER_LIMITS,
  MODULE_COMPILER_PROFILE,
  compileApplication,
  expectedActiveReleaseFrom,
  type CompileSuccess,
  type CompilerInput,
} from '../../packages/compiler/src/index.js';
import type {
  MintedUuid,
  RegisterTenantReleaseCommand,
  StoreAppPackageRevisionCommand,
} from '../../packages/platform-runtime/src/index.js';
import { PostgresModuleRuntimeInterpreter } from '../../packages/postgres-provider/src/module-runtime-interpreter.js';
import { PostgresModuleStorageMaterializer } from '../../packages/postgres-provider/src/module-storage-materializer.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { PostgresRequestRuntimeViewService } from '../../packages/postgres-provider/src/request-runtime-view-service.js';
import { TrustedActorEnvelopeIssuer } from '../../packages/postgres-provider/src/trust/trusted-actor-envelope.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
  type TrustedRequestContext,
} from '../../packages/runtime/src/request-context.js';
import {
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationGateway,
  type SemanticOperationResultEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryGateway,
  type SemanticQueryResultEnvelope,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  CURRENT_POLICY_DECISION_VERSION,
  type CurrentPolicyDecisionRequest,
  type CurrentPolicyGateway,
  type CurrentPolicySubject,
  type RequestRuntimeView,
} from '../../packages/runtime/src/request-runtime-view.js';
import {
  FIXTURE_IDS,
  ordinaryModuleV1,
  ordinaryModuleV1ForNamespace,
  ordinaryModuleV2,
} from '../fixtures/g2/module-conformance/definitions.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const migrations = resolve('db/migrations');
const tenantA = 'a1000000-0000-4000-8000-000000000001';
const environmentA = 'a2000000-0000-4000-8000-000000000002';
const principalA = 'a3000000-0000-4000-8000-000000000003';
const tenantB = 'b1000000-0000-4000-8000-000000000001';
const environmentB = 'b2000000-0000-4000-8000-000000000002';
const principalB = 'b3000000-0000-4000-8000-000000000003';

test('definition-only module is served generically through Q0/O0, trust, RLS, and pinned coexistence', async () => {
  const empty = mustCompile(moduleInput(emptyDefinition(ordinaryModuleV1())));
  const v1 = mustCompile(
    moduleInput(ordinaryModuleV1(), expectedActiveReleaseFrom(empty)),
  );
  const v2 = mustCompile(
    moduleInput(ordinaryModuleV2(), expectedActiveReleaseFrom(v1)),
  );

  await withEphemeralPostgres(
    'module-runtime',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [
        [tenantA, environmentA, 'runtime-a'],
        [tenantB, environmentB, 'runtime-b'],
      ]);
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
        const contexts = await contextsFor([
          ['a', tenantA, environmentA, principalA],
          ['b', tenantB, environmentB, principalB],
        ]);
        const releasesA = await persistSequence(runtimePool, contexts.a!, [
          [empty, emptyDefinition(ordinaryModuleV1())],
          [v1, ordinaryModuleV1()],
          [v2, ordinaryModuleV2()],
        ]);
        const releasesB = await persistSequence(runtimePool, contexts.b!, [
          [empty, emptyDefinition(ordinaryModuleV1())],
          [v1, ordinaryModuleV1()],
        ]);
        await setPointer(pool, tenantA, environmentA, releasesA[0]!);
        await setPointer(pool, tenantB, environmentB, releasesB[0]!);
        await grantExecutorAuthority(pool, [
          [tenantA, principalA],
          [tenantB, principalB],
        ]);

        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, contexts.a!, principalA, releasesA[1]!);
        await prepare(materializer, contexts.b!, principalB, releasesB[1]!);
        await setPointer(pool, tenantA, environmentA, releasesA[1]!);
        await setPointer(pool, tenantB, environmentB, releasesB[1]!);

        const policy = new AllowPolicy();
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtimePool,
          humanActorIssuer(),
        );
        const queryGateway = new SemanticQueryGateway(policy, interpreter);
        const operationGateway = new SemanticOperationGateway(
          policy,
          interpreter,
        );
        const entry = runtimeEntry(runtimePool, {
          a: identity(tenantA, environmentA, principalA),
          b: identity(tenantB, environmentB, principalB),
        });
        const viewA1 = await issuedView(entry, 'a');
        const viewB1 = await issuedView(entry, 'b');

        await assertRoleBridge(pool);

        const soloId = randomUUID();
        const acmeOneId = randomUUID();
        const acmeTwoId = randomUUID();
        const tenantBId = randomUUID();
        const created = await operation(
          operationGateway,
          viewA1,
          'master_create',
          {
            recordId: soloId,
            values: {
              [FIXTURE_IDS.fieldIds.parentName]: 'Solo',
              [FIXTURE_IDS.fieldIds.parentNumber]: 'A-001',
            },
          },
        );
        assert.equal(created.outcome, 'succeeded');
        assert.equal(created.readBack?.recordId, soloId);
        assert.deepEqual(created.readBack?.values, {
          [FIXTURE_IDS.fieldIds.parentName]: 'Solo',
        });
        assert.ok(created.trust);
        await assertLinkedTrustFacts(pool, created, tenantA, environmentA);

        for (const [recordId, number] of [
          [acmeOneId, 'A-002'],
          [acmeTwoId, 'A-003'],
        ]) {
          await operation(operationGateway, viewA1, 'master_create', {
            recordId,
            values: {
              [FIXTURE_IDS.fieldIds.parentName]: 'Acme',
              [FIXTURE_IDS.fieldIds.parentNumber]: number,
            },
          });
        }
        await operation(operationGateway, viewB1, 'master_create', {
          recordId: tenantBId,
          values: {
            [FIXTURE_IDS.fieldIds.parentName]: 'Tenant B',
            [FIXTURE_IDS.fieldIds.parentNumber]: 'B-001',
          },
        });

        const get = await query(queryGateway, viewA1, 'master_get', {
          recordId: soloId,
        });
        assert.equal(get.outcome, 'exact');
        assert.deepEqual(get.records[0]?.values, {
          [FIXTURE_IDS.fieldIds.parentName]: 'Solo',
        });
        assertNoPhysicalDetails(get);

        const list = await query(queryGateway, viewA1, 'master_list', {
          limit: 20,
        });
        assert.equal(list.outcome, 'exact');
        assert.equal(list.records.length, 3);
        assert.equal(
          list.records.some((record) => record.recordId === tenantBId),
          false,
        );

        const search = await query(queryGateway, viewA1, 'master_search', {
          text: 'acm',
        });
        assert.equal(search.outcome, 'exact');
        assert.equal(search.records.length, 2);
        assert.equal(
          (
            await query(queryGateway, viewA1, 'master_resolve', {
              text: 'a-001',
            })
          ).outcome,
          'exact',
        );
        const advisorySingle = await query(
          queryGateway,
          viewA1,
          'master_resolve',
          { text: 'Solo' },
        );
        assert.equal(advisorySingle.outcome, 'ambiguous');
        assert.equal(advisorySingle.records.length, 1);
        const advisoryMultiple = await query(
          queryGateway,
          viewA1,
          'master_resolve',
          { text: 'Acme' },
        );
        assert.equal(advisoryMultiple.outcome, 'ambiguous');
        assert.equal(advisoryMultiple.records.length, 2);
        assert.equal(
          (
            await query(queryGateway, viewA1, 'master_resolve', {
              text: 'Missing',
            })
          ).outcome,
          'not-found',
        );
        assert.equal(
          (
            await query(queryGateway, viewA1, 'master_resolve', {
              text: 'B-001',
            })
          ).outcome,
          'not-found',
        );

        const updated = await operation(
          operationGateway,
          viewA1,
          'master_update',
          {
            expectedRevision: 1,
            patch: { [FIXTURE_IDS.fieldIds.parentName]: 'Solo Updated' },
            recordId: soloId,
          },
        );
        assert.equal(updated.readBack?.revision, 2);
        const archived = await operation(
          operationGateway,
          viewA1,
          'master_archive',
          { expectedRevision: 2, recordId: soloId },
        );
        assert.equal(archived.readBack?.archived, true);
        assert.equal(
          (
            await query(queryGateway, viewA1, 'master_get', {
              recordId: soloId,
            })
          ).outcome,
          'not-found',
        );
        assert.equal(
          (
            await query(queryGateway, viewA1, 'master_get', {
              includeArchived: true,
              recordId: soloId,
            })
          ).outcome,
          'exact',
        );
        const restored = await operation(
          operationGateway,
          viewA1,
          'master_restore',
          { expectedRevision: 3, recordId: soloId },
        );
        assert.equal(restored.readBack?.archived, false);

        const childId = randomUUID();
        const childCreated = await operation(
          operationGateway,
          viewA1,
          'master_role_create',
          {
            recordId: childId,
            relations: {
              [`${FIXTURE_IDS.namespace}:relation.master_role_parent`]: soloId,
            },
            values: { [FIXTURE_IDS.fieldIds.childRole]: 'owner' },
          },
        );
        assert.equal(childCreated.readBack?.revision, 1);
        assert.equal(
          (
            await operation(operationGateway, viewA1, 'master_role_update', {
              expectedRevision: 1,
              patch: { [FIXTURE_IDS.fieldIds.childRole]: 'buyer' },
              recordId: childId,
            })
          ).readBack?.revision,
          2,
        );
        assert.equal(
          (
            await operation(operationGateway, viewA1, 'master_role_archive', {
              expectedRevision: 2,
              recordId: childId,
            })
          ).readBack?.archived,
          true,
        );
        assert.equal(
          (
            await operation(operationGateway, viewA1, 'master_role_restore', {
              expectedRevision: 3,
              recordId: childId,
            })
          ).readBack?.revision,
          4,
        );

        const factsBefore = await trustFactCount(pool, tenantA, environmentA);
        await assert.rejects(
          operation(operationGateway, viewA1, 'master_role_create', {
            recordId: randomUUID(),
            relations: {
              [`${FIXTURE_IDS.namespace}:relation.master_role_parent`]:
                tenantBId,
            },
            values: { [FIXTURE_IDS.fieldIds.childRole]: 'forbidden' },
          }),
          /foreign key constraint/,
        );
        assert.equal(
          await trustFactCount(pool, tenantA, environmentA),
          factsBefore,
        );

        await prepare(materializer, contexts.a!, principalA, releasesA[2]!);
        await setPointer(pool, tenantA, environmentA, releasesA[2]!);
        const viewA2 = await issuedView(entry, 'a');
        const v2Update = await operation(
          operationGateway,
          viewA2,
          'master_update',
          {
            expectedRevision: 4,
            patch: { [FIXTURE_IDS.fieldIds.parentNotes]: 'served by v2' },
            recordId: soloId,
          },
        );
        assert.equal(v2Update.readBack?.revision, 5);
        assert.deepEqual(v2Update.readBack?.values, {
          [FIXTURE_IDS.fieldIds.parentName]: 'Solo Updated',
          [FIXTURE_IDS.fieldIds.parentNotes]: 'served by v2',
        });
        const oldPinned = await query(queryGateway, viewA1, 'master_get', {
          recordId: soloId,
        });
        const newPinned = await query(queryGateway, viewA2, 'master_get', {
          recordId: soloId,
        });
        assert.deepEqual(Object.keys(oldPinned.records[0]!.values), [
          FIXTURE_IDS.fieldIds.parentName,
        ]);
        assert.deepEqual(Object.keys(newPinned.records[0]!.values), [
          FIXTURE_IDS.fieldIds.parentName,
          FIXTURE_IDS.fieldIds.parentNotes,
        ]);
        assert.equal(
          newPinned.records[0]?.values[FIXTURE_IDS.fieldIds.parentNotes],
          'served by v2',
        );
        assert.equal(
          (
            await query(queryGateway, viewA2, 'master_resolve', {
              text: 'served by v2',
            })
          ).outcome,
          'not-found',
        );
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
});

test('metamorphic random namespace compiles, materializes, serves, and records trust without module code', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const namespace = `northstar.metamorphic${suffix}`;
  const definition = ordinaryModuleV1ForNamespace(namespace);
  const empty = mustCompile(moduleInput(emptyDefinition(definition)));
  const compiled = mustCompile(
    moduleInput(definition, expectedActiveReleaseFrom(empty)),
  );
  const tenant = 'c1000000-0000-4000-8000-000000000001';
  const environment = 'c2000000-0000-4000-8000-000000000002';
  const principal = 'c3000000-0000-4000-8000-000000000003';

  await withEphemeralPostgres(
    'module-metamorphic',
    async ({ connection, pool }) => {
      await migrateAndSeed(pool, [[tenant, environment, 'metamorphic']]);
      const runtimePool = new pg.Pool({
        ...connection,
        max: 3,
        user: 'north_star_runtime',
      });
      const materializerPool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_module_materializer',
      });
      const modulePool = new pg.Pool({
        ...connection,
        max: 1,
        user: 'north_star_module_runtime',
      });
      try {
        const context = (
          await contextsFor([['m', tenant, environment, principal]])
        ).m!;
        const releases = await persistSequence(runtimePool, context, [
          [empty, emptyDefinition(definition)],
          [compiled, definition],
        ]);
        await setPointer(pool, tenant, environment, releases[0]!);
        await grantExecutorAuthority(pool, [[tenant, principal]]);
        const materializer = new PostgresModuleStorageMaterializer(
          materializerPool,
          modulePool,
        );
        await prepare(materializer, context, principal, releases[1]!);
        await setPointer(pool, tenant, environment, releases[1]!);

        const policy = new AllowPolicy();
        const interpreter = new PostgresModuleRuntimeInterpreter(
          runtimePool,
          humanActorIssuer(),
        );
        const operations = new SemanticOperationGateway(policy, interpreter);
        const queries = new SemanticQueryGateway(policy, interpreter);
        const entry = runtimeEntry(runtimePool, {
          m: identity(tenant, environment, principal),
        });
        const view = await issuedView(entry, 'm');
        const recordId = randomUUID();
        const result = await operation(
          operations,
          view,
          'master_create',
          {
            recordId,
            values: {
              [`${namespace}:field.master_name`]: 'Metamorphic',
              [`${namespace}:field.master_number`]: 'M-001',
            },
          },
          namespace,
        );
        assert.equal(result.outcome, 'succeeded');
        assert.ok(result.trust);
        const read = await query(
          queries,
          view,
          'master_get',
          { recordId },
          namespace,
        );
        assert.equal(read.outcome, 'exact');
        assert.equal(read.records[0]?.recordId, recordId);
        assertNoPhysicalDetails(read);
        await assertLinkedTrustFacts(pool, result, tenant, environment);
      } finally {
        await Promise.all([
          runtimePool.end(),
          materializerPool.end(),
          modulePool.end(),
        ]);
      }
    },
  );
});

class AllowPolicy implements CurrentPolicyGateway {
  readonly calls: CurrentPolicyDecisionRequest[] = [];

  async authorize(request: CurrentPolicyDecisionRequest): Promise<{
    decision: 'ALLOW';
    decisionVersion: typeof CURRENT_POLICY_DECISION_VERSION;
    policyVersion: string;
  }> {
    this.calls.push(request);
    return {
      decision: 'ALLOW',
      decisionVersion: CURRENT_POLICY_DECISION_VERSION,
      policyVersion: 'module-runtime-policy/v1',
    };
  }

  async readCurrentVersion(
    _subject: CurrentPolicySubject,
  ): Promise<{ policyVersion: string }> {
    return { policyVersion: 'module-runtime-policy/v1' };
  }
}

async function operation(
  gateway: SemanticOperationGateway,
  view: RequestRuntimeView,
  localId: string,
  input: Record<string, unknown>,
  namespace: string = FIXTURE_IDS.namespace,
): Promise<SemanticOperationResultEnvelope> {
  return gateway.invoke(view, {
    input,
    operationId: `${namespace}:operation.${localId}`,
    schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
  });
}

async function query(
  gateway: SemanticQueryGateway,
  view: RequestRuntimeView,
  localId: string,
  args: Record<string, unknown>,
  namespace: string = FIXTURE_IDS.namespace,
): Promise<SemanticQueryResultEnvelope> {
  return gateway.invoke(view, {
    arguments: args,
    queryId: `${namespace}:query.${localId}`,
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
  });
}

function runtimeEntry(
  pool: pg.Pool,
  identities: Readonly<Record<string, AuthenticatedIdentity>>,
): AuthenticatedRequestRuntimeEntryAdapter {
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async (request) => {
      const token = request.headers?.authorization;
      return typeof token === 'string' ? (identities[token] ?? null) : null;
    }),
    new PostgresRequestRuntimeViewService(pool),
    new AllowPolicy(),
  );
}

async function issuedView(
  entry: AuthenticatedRequestRuntimeEntryAdapter,
  token: string,
): Promise<RequestRuntimeView> {
  return entry.run({ headers: { authorization: token } }, async (view) => view);
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

async function contextsFor(
  facts: ReadonlyArray<readonly [string, string, string, string]>,
): Promise<Record<string, TrustedRequestContext>> {
  const identities = Object.fromEntries(
    facts.map(([token, tenantId, environmentId, principalId]) => [
      token,
      identity(tenantId, environmentId, principalId),
    ]),
  );
  const entry = new AuthenticatedRequestEntryAdapter(async (request) => {
    const token = request.headers?.authorization;
    return typeof token === 'string' ? (identities[token] ?? null) : null;
  });
  return Object.fromEntries(
    await Promise.all(
      facts.map(async ([token]) => [
        token,
        await entry.enter({ headers: { authorization: token } }),
      ]),
    ),
  );
}

function identity(
  tenantId: string,
  environmentId: string,
  principalId: string,
): AuthenticatedIdentity {
  return { environmentId, principalId, tenantId };
}

async function migrateAndSeed(
  pool: pg.Pool,
  scopes: ReadonlyArray<readonly [string, string, string]>,
): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await runMigrations(
      client,
      await loadMigrations(migrations),
    );
    assert.equal(result.applied.length, 8);
    assert.equal(result.verified.length, 8);
    for (const [tenantId, environmentId, slug] of scopes) {
      await client.query(
        'INSERT INTO platform.tenants (id, slug) VALUES ($1,$2)',
        [tenantId, slug],
      );
      await client.query(
        `INSERT INTO platform.environments (tenant_id, id, slug)
         VALUES ($1,$2,'production')`,
        [tenantId, environmentId],
      );
    }
  } finally {
    client.release();
  }
}

async function persistSequence(
  runtimePool: pg.Pool,
  context: TrustedRequestContext,
  entries: ReadonlyArray<readonly [CompileSuccess, Record<string, unknown>]>,
): Promise<MintedUuid[]> {
  const repository = new PostgresImmutableReleaseRepository(runtimePool);
  const releases: MintedUuid[] = [];
  for (const [compiled, definition] of entries) {
    const revisionId = minted(randomUUID());
    const releaseId = minted(randomUUID());
    const bytes = definitionBytes(definition);
    await repository.storeAppPackageRevision(
      context,
      revisionCommand(context, revisionId, bytes),
    );
    await repository.registerTenantRelease(
      context,
      releaseCommand(
        context,
        releaseId,
        revisionId,
        minted(randomUUID()),
        compiled,
      ),
    );
    releases.push(releaseId);
  }
  return releases;
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
  verificationEvidenceId: MintedUuid,
  compiledRelease: CompileSuccess,
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

async function grantExecutorAuthority(
  pool: pg.Pool,
  subjects: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  for (const [tenantId, principalId] of subjects) {
    await pool.query(
      'SELECT platform.set_release_executor_authority($1,$2,true,$2,$3)',
      [tenantId, principalId, randomUUID()],
    );
  }
}

async function prepare(
  materializer: PostgresModuleStorageMaterializer,
  context: TrustedRequestContext,
  principalId: string,
  releaseId: MintedUuid,
): Promise<void> {
  const result = await materializer.prepare({
    context,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    generationId: randomUUID(),
    initiatedBy: principalId,
    preparationId: randomUUID(),
    targetReleaseId: releaseId,
  });
  assert.equal(result.schemaState, 'APPLIED');
}

async function assertRoleBridge(pool: pg.Pool): Promise<void> {
  const membership = await pool.query<{
    admin_option: boolean;
    inherit_option: boolean;
    set_option: boolean;
  }>(
    `SELECT membership.admin_option,
            membership.inherit_option,
            membership.set_option
       FROM pg_auth_members AS membership
       JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
       JOIN pg_roles AS member_role ON member_role.oid = membership.member
      WHERE granted_role.rolname = 'north_star_module_runtime'
        AND member_role.rolname = 'north_star_runtime'`,
  );
  assert.deepEqual(membership.rows, [
    { admin_option: false, inherit_option: false, set_option: true },
  ]);
  const forbidden = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM pg_auth_members AS membership
       JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
       JOIN pg_roles AS member_role ON member_role.oid = membership.member
      WHERE (granted_role.rolname = 'north_star_runtime'
             AND member_role.rolname = 'north_star_module_runtime')
         OR (granted_role.rolname = 'north_star_module_materializer'
             AND member_role.rolname IN (
               'north_star_runtime', 'north_star_module_runtime'
             ))`,
  );
  assert.equal(forbidden.rows[0]?.count, '0');
  const trustPrivilege = await pool.query<{ can_insert_trust: boolean }>(
    `SELECT has_table_privilege(
       'north_star_module_runtime',
       'platform.trust_action_invocations',
       'INSERT'
     ) AS can_insert_trust`,
  );
  assert.equal(trustPrivilege.rows[0]?.can_insert_trust, false);
  const roles = await pool.query<{
    rolbypassrls: boolean;
    rolinherit: boolean;
    rolname: string;
    rolsuper: boolean;
  }>(
    `SELECT rolname, rolsuper, rolbypassrls, rolinherit
       FROM pg_roles
      WHERE rolname IN (
        'north_star_runtime',
        'north_star_module_runtime',
        'north_star_module_materializer'
      )
      ORDER BY rolname`,
  );
  assert.equal(
    roles.rows.every((role) => !role.rolsuper && !role.rolbypassrls),
    true,
  );
  assert.equal(
    roles.rows.find((role) => role.rolname === 'north_star_runtime')
      ?.rolinherit,
    false,
  );
  const ambient = new pg.Pool({
    ...(pool.options as pg.PoolConfig),
    max: 1,
    user: 'north_star_runtime',
  });
  try {
    const privilege = await ambient.query<{ module_usage: boolean }>(
      `SELECT has_schema_privilege(
        current_user, 'north_star_module', 'USAGE'
      ) AS module_usage`,
    );
    assert.equal(privilege.rows[0]?.module_usage, false);
  } finally {
    await ambient.end();
  }
}

async function assertLinkedTrustFacts(
  pool: pg.Pool,
  result: SemanticOperationResultEnvelope,
  tenantId: string,
  environmentId: string,
): Promise<void> {
  assert.ok(result.trust);
  const linked = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM platform.trust_action_invocations AS invocation
       JOIN platform.trust_business_change_documents AS change
         ON change.tenant_id = invocation.tenant_id
        AND change.environment_id = invocation.environment_id
        AND change.invocation_id = invocation.invocation_id
       JOIN platform.trust_domain_events AS event
         ON event.tenant_id = invocation.tenant_id
        AND event.environment_id = invocation.environment_id
        AND event.invocation_id = invocation.invocation_id
       JOIN platform.trust_outbox AS outbox
         ON outbox.tenant_id = invocation.tenant_id
        AND outbox.environment_id = invocation.environment_id
        AND outbox.invocation_id = invocation.invocation_id
      WHERE invocation.tenant_id = $1
        AND invocation.environment_id = $2
        AND invocation.invocation_id = $3
        AND invocation.change_document_id = $4
        AND invocation.domain_event_id = $5
        AND invocation.outbox_id = $6`,
    [
      tenantId,
      environmentId,
      result.trust.invocationId,
      result.trust.changeDocumentId,
      result.trust.domainEventId,
      result.trust.outboxId,
    ],
  );
  assert.equal(linked.rows[0]?.count, '1');
  const redacted = await pool.query<{ changes: unknown }>(
    `SELECT changes
       FROM platform.trust_business_change_documents
      WHERE tenant_id = $1
        AND environment_id = $2
        AND change_document_id = $3`,
    [tenantId, environmentId, result.trust.changeDocumentId],
  );
  const serializedChanges = JSON.stringify(redacted.rows[0]?.changes);
  assert.doesNotMatch(serializedChanges, /Solo|A-001/);
  assert.match(serializedChanges, /SENSITIVE/);
  assert.match(serializedChanges, /REDACTED/);
}

async function trustFactCount(
  pool: pg.Pool,
  tenantId: string,
  environmentId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
       FROM platform.trust_action_invocations
      WHERE tenant_id = $1 AND environment_id = $2`,
    [tenantId, environmentId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function assertNoPhysicalDetails(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /north_star_module|nsm_[ctik]_|storageClass/);
}

function emptyDefinition(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const definition = structuredClone(source);
  for (const family of [
    'assertions',
    'entities',
    'fields',
    'operations',
    'permissions',
    'queries',
    'relations',
    'stateMachines',
    'storageMappings',
    'surfaces',
  ]) {
    definition[family] = [];
  }
  return definition;
}

function definitionBytes(definition: unknown): Uint8Array {
  return new TextEncoder().encode(
    canonicalize(normalizeApplicationPackage(definition)),
  );
}

function moduleInput(
  definition: unknown,
  expectedActiveRelease: CompilerInput['expectedActiveRelease'] = null,
): CompilerInput {
  return {
    dependencies: [],
    expectedActiveRelease,
    kind: 'compilerInput',
    limits: { ...DEFAULT_COMPILER_LIMITS },
    normalizedDefinitionBytes: definitionBytes(definition),
    profile: { ...MODULE_COMPILER_PROFILE },
  };
}

function mustCompile(input: CompilerInput): CompileSuccess {
  const result = compileApplication(input);
  if (result.status !== 'compiled') {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result;
}

function minted(value: string): MintedUuid {
  return value as MintedUuid;
}
