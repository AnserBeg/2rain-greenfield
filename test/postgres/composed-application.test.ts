import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  APPLICATION_IDS,
  composedApplicationDefinition,
} from '../../packages/domain/src/app/builder.js';
import type { MintedUuid } from '../../packages/platform-runtime/src/index.js';
import { SYSTEM_EXECUTION_PRINCIPAL } from '../../packages/platform-runtime/src/index.js';
import {
  createComposedApplicationRuntime,
  parseCompiledApplication,
  type ComposedApplicationRuntime,
} from '../../packages/postgres-provider/src/composed-application-runtime.js';
import {
  PostgresReleaseActivationService,
  ReleaseActivationError,
} from '../../packages/postgres-provider/src/release-activation-service.js';
import { PostgresImmutableReleaseRepository } from '../../packages/postgres-provider/src/release-repository.js';
import { AuthenticatedRequestEntryAdapter } from '../../packages/runtime/src/request-context.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import { SEMANTIC_OPERATION_REQUEST_VERSION } from '../../packages/runtime/src/semantic-operation-gateway.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import type { RequestRuntimeView } from '../../packages/runtime/src/request-runtime-view.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const compiledArtifactPath = resolve('apps/web/release/app.compiled.json');
const authoredArtifactPath = resolve('apps/web/release/app.authored.json');
const migrationsDirectory = resolve('db/migrations');

test(
  'composed product activates through the kernel and persists tenant-scoped gateway data',
  { timeout: 120_000 },
  async () => {
    await withEphemeralPostgres(
      'g2-p5e-composed-application',
      async ({ connection, pool }) => {
        const compiledApplication = JSON.parse(
          await readFile(compiledArtifactPath, 'utf8'),
        ) as unknown;
        const authoredApplication = JSON.parse(
          await readFile(authoredArtifactPath, 'utf8'),
        ) as unknown;
        assert.deepEqual(
          authoredApplication,
          composedApplicationDefinition(),
          'the checked-in authored artifact is generated from the shared module factories',
        );
        const databaseUrl = connectionUrl(connection);
        let tenantA = await createRuntime(
          compiledApplication,
          databaseUrl,
          'composed-tenant-a',
        );
        let tenantB: ComposedApplicationRuntime | undefined;
        try {
          assert.equal(tenantA.triggerEnabledDuringActivation, true);
          await assertExactSwapTriggerEnabled(pool);
          await assertRealProductDefinition(tenantA);
          await assertUnapprovedReleaseCannotActivate(
            tenantA,
            compiledApplication,
            connection,
            pool,
          );

          const recordId = randomUUID();
          const created = await tenantA.entry.run(
            { headers: { authorization: 'local' } },
            (view) =>
              tenantA.operationGateway.invoke(
                view,
                {
                  confirmationGrant: null,
                  idempotencyKey: randomUUID(),
                  input: {
                    recordId,
                    values: {
                      [APPLICATION_IDS.party.fieldIds.contactSummary]:
                        'persisted@example.test',
                      [APPLICATION_IDS.party.fieldIds.name]:
                        'Persistent Browser Party',
                      [APPLICATION_IDS.party.fieldIds.number]: 'P-REAL-001',
                    },
                  },
                  operationId: APPLICATION_IDS.party.createOperationId,
                  schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
                },
                tenantA.operationMediation.issueInvocation(view, 'UI'),
              ),
          );
          assert.equal(created.outcome, 'succeeded');

          const separateRequest = await listParty(tenantA);
          assert.deepEqual(
            separateRequest.records.map((record) => record.recordId),
            [recordId],
            'a separate gateway request reads the committed PostgreSQL row',
          );

          await tenantA.close();
          tenantA = await createRuntime(
            compiledApplication,
            databaseUrl,
            'composed-tenant-a',
          );
          const afterRestart = await listParty(tenantA);
          assert.deepEqual(
            afterRestart.records.map((record) => record.recordId),
            [recordId],
            'the row survives composition-root reconstruction',
          );

          tenantB = await createRuntime(
            compiledApplication,
            databaseUrl,
            'composed-tenant-b',
          );
          const isolated = await listParty(tenantB);
          assert.equal(isolated.listCoverage?.totalCount, 0);
          assert.deepEqual(isolated.records, []);
          await assertExactSwapTriggerEnabled(pool);
        } finally {
          await Promise.all([
            tenantA.close(),
            tenantB?.close() ?? Promise.resolve(),
          ]);
        }
      },
    );
  },
);

async function assertRealProductDefinition(
  runtime: ComposedApplicationRuntime,
): Promise<void> {
  await runtime.entry.run({ headers: { authorization: 'local' } }, (view) => {
    const surfaces = (
      view.projections.surface.payload as {
        surfaces: readonly { surfaceId: string }[];
      }
    ).surfaces.map((surface) => surface.surfaceId);
    assert.equal(surfaces.length, 12);
    assert.ok(surfaces.includes(APPLICATION_IDS.party.listSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.catalog.listSurfaceId));
    assert.ok(surfaces.includes(APPLICATION_IDS.location.listSurfaceId));
  });
}

async function assertUnapprovedReleaseCannotActivate(
  runtime: ComposedApplicationRuntime,
  compiledApplication: unknown,
  connection: pg.PoolConfig,
  adminPool: pg.Pool,
): Promise<void> {
  const runtimePool = new pg.Pool({
    ...connection,
    max: 2,
    user: 'north_star_runtime',
  });
  runtimePool.on('error', () => undefined);
  try {
    const context = await new AuthenticatedRequestEntryAdapter(
      async () => runtime.identity,
    ).enter({});
    const revision = await adminPool.query<{ revision_id: MintedUuid }>(
      `SELECT app_package_revision_id AS revision_id
         FROM platform.tenant_releases
        WHERE release_id = $1`,
      [runtime.activeReleaseId],
    );
    const revisionId = revision.rows[0]?.revision_id;
    assert.ok(revisionId);
    const candidateReleaseId = randomUUID() as MintedUuid;
    const candidateEvidenceId = randomUUID() as MintedUuid;
    const candidateActivationAttemptId = randomUUID() as MintedUuid;
    const application =
      parseCompiledApplication(compiledApplication).application;
    await new PostgresImmutableReleaseRepository(
      runtimePool,
    ).registerTenantRelease(context, {
      appPackageRevisionId: revisionId,
      compiledRelease: application.compiled,
      createdBy: context.principalId,
      environmentId: context.environmentId,
      releaseId: candidateReleaseId,
      tenantId: context.tenantId,
      verificationEvidenceId: candidateEvidenceId,
    });
    const admissionCount = await adminPool.query<{
      approvals: string;
      attempts: string;
    }>(
      `SELECT count(*)::text AS approvals,
              count(attempt.activation_attempt_id)::text AS attempts
         FROM platform.release_approvals AS approval
         LEFT JOIN platform.release_activation_attempts AS attempt
           ON attempt.tenant_id = approval.tenant_id
          AND attempt.environment_id = approval.environment_id
          AND attempt.approval_id = approval.approval_id
        WHERE approval.target_release_id = $1`,
      [candidateReleaseId],
    );
    assert.deepEqual(admissionCount.rows[0], {
      approvals: '0',
      attempts: '0',
    });
    await assertExactSwapTriggerEnabled(adminPool);

    const systemContext = await new AuthenticatedRequestEntryAdapter(
      async () => ({
        environmentId: runtime.identity.environmentId,
        principalId: SYSTEM_EXECUTION_PRINCIPAL.principalId,
        tenantId: runtime.identity.tenantId,
      }),
    ).enter({});
    await assert.rejects(
      new PostgresReleaseActivationService(runtimePool).activate(
        systemContext,
        {
          activationAttemptId: candidateActivationAttemptId,
        },
      ),
      (error: unknown) =>
        error instanceof ReleaseActivationError &&
        error.code === 'CANONICAL_RECORD_NOT_FOUND',
    );
    const pointer = await adminPool.query<{ release_id: MintedUuid }>(
      `SELECT release_id
         FROM platform.active_release_pointers
        WHERE tenant_id = $1 AND environment_id = $2`,
      [runtime.identity.tenantId, runtime.identity.environmentId],
    );
    assert.equal(pointer.rows[0]?.release_id, runtime.activeReleaseId);
    assert.notEqual(pointer.rows[0]?.release_id, candidateReleaseId);
    await assertExactSwapTriggerEnabled(adminPool);
  } finally {
    await runtimePool.end();
  }
}

function listParty(runtime: ComposedApplicationRuntime) {
  return runtime.entry.run(
    { headers: { authorization: 'local' } },
    (view: RequestRuntimeView) =>
      runtime.queryGateway.invoke(view, {
        arguments: {
          includeArchived: false,
          list: {
            cursor: null,
            matchMode: 'substring',
            pageSize: 100,
            relationLabels: [],
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            search: '',
            sort: [],
          },
        },
        queryId: APPLICATION_IDS.party.listQueryId,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      }),
  );
}

async function assertExactSwapTriggerEnabled(pool: pg.Pool): Promise<void> {
  const trigger = await pool.query<{ enabled: string }>(
    `SELECT tgenabled AS enabled
       FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'platform.active_release_pointers'::regclass
        AND tgname = 'active_release_pointer_exact_swap'
        AND NOT tgisinternal`,
  );
  assert.equal(trigger.rows[0]?.enabled, 'O');
}

function createRuntime(
  compiledApplication: unknown,
  databaseUrl: string,
  tenantSlug: string,
) {
  return createComposedApplicationRuntime({
    compiledApplication,
    databaseUrl,
    migrationsDirectory,
    tenantSlug,
  });
}

function connectionUrl(connection: pg.PoolConfig): string {
  return `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`;
}
