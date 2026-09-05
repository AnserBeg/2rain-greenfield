import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import {
  PostgresCurrentPolicyGateway,
  RECEIPT_AUTHORIZATION_DEPENDENCY_BINDINGS,
} from '../../packages/postgres-provider/src/current-policy.js';
import {
  loadMigrations,
  runMigrations,
} from '../../packages/postgres-provider/src/migrations.js';
import { withTrustedRequestTransaction } from '../../packages/postgres-provider/src/request-context.js';
import {
  AuthenticatedRequestEntryAdapter,
  type AuthenticatedIdentity,
} from '../../packages/runtime/src/request-context.js';
import {
  AuthenticatedRequestRuntimeEntryAdapter,
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  authorizeCurrentPolicy,
  type ImmutableJsonValue,
  type LoadedRequestRuntimeDefinition,
  type RequestRuntimeProjectionFamily,
  type RuntimeProjection,
} from '../../packages/runtime/src/request-runtime-view.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

const migrations = resolve('db/migrations');
const tenantId = 'a1000000-0000-4000-8000-000000000001';
const environmentId = 'a2000000-0000-4000-8000-000000000002';
const principalId = 'a3000000-0000-4000-8000-000000000003';
const ungrantedPrincipalId = 'a3000000-0000-4000-8000-000000000004';
const roleId = 'a4000000-0000-4000-8000-000000000004';
const membershipId = 'a5000000-0000-4000-8000-000000000005';
const legalEntityId = 'a6000000-0000-4000-8000-000000000006';
const foreignLegalEntityId = 'a6000000-0000-4000-8000-000000000007';
const binding = RECEIPT_AUTHORIZATION_DEPENDENCY_BINDINGS.find(
  (candidate) =>
    candidate.permissionId === 'northstar.app:permission.goods_receipt_create',
)!;
const permissionId = binding.permissionId;
const resourceId = binding.resourceId;

test('current policy evaluates live grants and scope under the non-admin runtime role', async () => {
  await withEphemeralPostgres(
    'current-policy',
    async ({ connection, pool }) => {
      const migrationClient = await pool.connect();
      try {
        await runMigrations(migrationClient, await loadMigrations(migrations));
      } finally {
        migrationClient.release();
      }
      await pool.query(
        `INSERT INTO platform.tenants (id, slug) VALUES ($1, 'current-policy')`,
        [tenantId],
      );
      await pool.query(
        `INSERT INTO platform.environments (tenant_id, id, slug)
       VALUES ($1, $2, 'production')`,
        [tenantId, environmentId],
      );
      await pool.query(
        `INSERT INTO platform.current_policy_roles (
         tenant_id, environment_id, role_id, role_key
       ) VALUES ($1,$2,$3,'reader')`,
        [tenantId, environmentId, roleId],
      );
      await pool.query(
        `INSERT INTO platform.current_policy_permission_grants (
         tenant_id, environment_id, role_id, permission_id, resource_id
       ) VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, environmentId, roleId, permissionId, resourceId],
      );
      await pool.query(
        `INSERT INTO platform.current_policy_memberships (
         tenant_id, environment_id, membership_id, principal_id, role_id
       ) VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, environmentId, membershipId, principalId, roleId],
      );

      const runtimePool = new pg.Pool({
        ...connection,
        max: 2,
        user: 'north_star_runtime',
      });
      runtimePool.on('error', () => undefined);
      try {
        const identity = Object.freeze({
          environmentId,
          principalId,
          tenantId,
        });
        const policy = new PostgresCurrentPolicyGateway(
          runtimePool,
          RECEIPT_AUTHORIZATION_DEPENDENCY_BINDINGS,
        );
        const entry = requestEntry(identity, policy);
        await entry.run({}, async (view) => {
          const admitted = await authorizeCurrentPolicy(
            policy,
            view,
            permissionId,
            Object.freeze({}),
          );
          assert.equal(admitted.decision, 'ALLOW');

          const unknown = await authorizeCurrentPolicy(
            policy,
            view,
            'northstar.test:permission.unknown',
            Object.freeze({}),
          );
          assert.equal(unknown.decision, 'DENY');

          await pool.query(
            `UPDATE platform.current_policy_permission_grants
              SET revoked_at = clock_timestamp()
            WHERE tenant_id = $1 AND environment_id = $2
              AND role_id = $3 AND permission_id = $4`,
            [tenantId, environmentId, roleId, permissionId],
          );
          const revoked = await authorizeCurrentPolicy(
            policy,
            view,
            permissionId,
            Object.freeze({}),
          );
          assert.equal(revoked.decision, 'DENY');
          assert.notEqual(revoked.policyVersion, admitted.policyVersion);

          await pool.query(
            `UPDATE platform.current_policy_permission_grants
              SET revoked_at = NULL
            WHERE tenant_id = $1 AND environment_id = $2
              AND role_id = $3 AND permission_id = $4`,
            [tenantId, environmentId, roleId, permissionId],
          );
          await pool.query(
            `UPDATE platform.current_policy_memberships
              SET legal_entity_id = $4
            WHERE tenant_id = $1 AND environment_id = $2
              AND membership_id = $3`,
            [tenantId, environmentId, membershipId, legalEntityId],
          );
          assert.equal(
            (
              await authorizeCurrentPolicy(
                policy,
                view,
                permissionId,
                Object.freeze({ legalEntityId }),
              )
            ).decision,
            'ALLOW',
          );
          for (const decisionInput of [
            Object.freeze({}),
            Object.freeze({ legalEntityId: foreignLegalEntityId }),
            Object.freeze({ legalEntityId: 'not-a-uuid' }),
          ]) {
            assert.equal(
              (
                await authorizeCurrentPolicy(
                  policy,
                  view,
                  permissionId,
                  decisionInput,
                )
              ).decision,
              'DENY',
            );
          }
        });

        const ungrantedPolicy = new PostgresCurrentPolicyGateway(
          runtimePool,
          RECEIPT_AUTHORIZATION_DEPENDENCY_BINDINGS,
        );
        await requestEntry(
          { environmentId, principalId: ungrantedPrincipalId, tenantId },
          ungrantedPolicy,
        ).run({}, async (view) => {
          assert.equal(
            (
              await authorizeCurrentPolicy(
                ungrantedPolicy,
                view,
                permissionId,
                Object.freeze({}),
              )
            ).decision,
            'DENY',
          );
        });

        const trusted = await new AuthenticatedRequestEntryAdapter(
          async () => identity,
        ).enter({});
        const directlyVisible = await withTrustedRequestTransaction(
          runtimePool,
          trusted,
          (client) =>
            client.query<{ principal_id: string }>(
              `SELECT principal_id::text AS principal_id
               FROM platform.current_policy_memberships`,
            ),
        );
        assert.deepEqual(directlyVisible.rows, [{ principal_id: principalId }]);
      } finally {
        await runtimePool.end();
      }
    },
  );
});

function requestEntry(
  identity: AuthenticatedIdentity,
  policy: PostgresCurrentPolicyGateway,
): AuthenticatedRequestRuntimeEntryAdapter {
  return new AuthenticatedRequestRuntimeEntryAdapter(
    new AuthenticatedRequestEntryAdapter(async () => identity),
    Object.freeze({
      async load(): Promise<LoadedRequestRuntimeDefinition> {
        return loadedDefinition(identity);
      },
    }),
    policy,
  );
}

function loadedDefinition(
  identity: AuthenticatedIdentity,
): LoadedRequestRuntimeDefinition {
  const empty = Object.freeze([]) as readonly ImmutableJsonValue[];
  return {
    environmentId: identity.environmentId,
    pointer: {
      fence: 1,
      pointerId: 'a7000000-0000-4000-8000-000000000007',
    },
    projections: {
      agent: projection(
        REQUEST_RUNTIME_PROJECTION_FAMILIES.agent,
        'northstar.agent-discovery-payload/v0-provisional',
        {
          kind: 'agentDiscoveryPayload',
          operations: empty,
          queries: empty,
          schemaVersion: 'northstar.agent-discovery-payload/v0-provisional',
          surfaces: empty,
          toolIds: empty,
        },
      ),
      catalog: projection(
        REQUEST_RUNTIME_PROJECTION_FAMILIES.catalog,
        'northstar.semantic-model-payload/v0-provisional',
        {
          constructs: empty,
          kind: 'semanticModelPayload',
          schemaVersion: 'northstar.semantic-model-payload/v0-provisional',
        },
      ),
      operation: projection(
        REQUEST_RUNTIME_PROJECTION_FAMILIES.operation,
        'northstar.operation-catalog-payload/v0-provisional',
        {
          kind: 'operationCatalogPayload',
          operations: empty,
          schemaVersion: 'northstar.operation-catalog-payload/v0-provisional',
        },
      ),
      query: projection(
        REQUEST_RUNTIME_PROJECTION_FAMILIES.query,
        'northstar.query-catalog-payload/v0-provisional',
        {
          kind: 'queryCatalogPayload',
          queries: empty,
          schemaVersion: 'northstar.query-catalog-payload/v0-provisional',
        },
      ),
      surface: projection(
        REQUEST_RUNTIME_PROJECTION_FAMILIES.surface,
        'northstar.surface-manifest-payload/v0-provisional',
        {
          kind: 'surfaceManifestPayload',
          schemaVersion: 'northstar.surface-manifest-payload/v0-provisional',
          surfaces: empty,
        },
      ),
    },
    release: {
      contentHash: 'b'.repeat(64),
      releaseId: 'a8000000-0000-4000-8000-000000000008',
    },
    tenantId: identity.tenantId,
  };
}

function projection<TFamily extends RequestRuntimeProjectionFamily>(
  familyId: TFamily,
  payloadSchemaVersion: string,
  payload: ImmutableJsonValue,
): RuntimeProjection<TFamily> {
  return {
    artifactRoot: 'c'.repeat(64),
    familyId,
    instanceId: `northstar.test:projection.${familyId.split('.').at(-1)}`,
    payload,
    payloadSchemaVersion,
    semanticDigest: 'd'.repeat(64),
  };
}
