import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Session } from 'node:inspector/promises';
import test from 'node:test';
import type pg from 'pg';
import {
  openComposedApplicationRuntime,
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import {
  defaultBoardChoices,
  draftBoardRevision,
} from '../../packages/customization/src/board-revision.js';
import {
  REQUEST_RUNTIME_PROJECTION_FAMILIES,
  SUPPORTED_RUNTIME_CAPABILITIES,
} from '../../packages/runtime/src/request-runtime-view.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../packages/runtime/src/semantic-query-gateway.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

const tenantSlug = 'boot-capabilities';
const deal = 'northstar.app:entity.custom_deal';

test(
  'Board queries work at the supported floor and refuse before policy parsing above it',
  { timeout: 600_000 },
  async () => {
    await withEphemeralPostgres(
      tenantSlug,
      async ({ connection, pool }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug,
        };
        using coverage = policyCoverage();
        const initial = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const activate = async (change: unknown) => {
            const drafted = await opened.service.draft(change, 'visualBuilder');
            assert.ok(drafted.status === 'drafted', JSON.stringify(drafted));
            await opened.service.approve(drafted.patchId);
            await opened.service.activate(drafted.patchId);
          };
          await activate({
            kind: 'changeSet',
            patches: [
              {
                kind: 'addRecordType',
                label: 'Deal',
                companyOwnership: 'entityOwned',
                fields: [{ label: 'Name', type: 'text', required: true }],
              },
              {
                kind: 'declareLifecycle',
                entity: deal,
                initial: 'Open',
                states: [{ label: 'Open' }, { label: 'Won' }],
                transitions: [{ from: 'Open', to: 'Won', label: 'Mark won' }],
              },
            ],
          });
          const recordId = randomUUID();
          const world = worldOver(initial.runtime, String(connection.database));
          const dealCreated = await world.invoke('custom_deal_create', {
            legalEntityId: COMPANY,
            recordId,
            values: { 'northstar.app:field.custom_deal_name': 'Known deal' },
          });
          assert.equal(dealCreated.outcome, 'succeeded');
          const compatibleRelease = await initial.runtime.entry.run(
            { headers: {} },
            (view) => view.release.releaseId,
          );

          const target = (await opened.service.targets()).boards?.find(
            ({ frame }) => frame.entityId === deal,
          );
          assert.ok(target);
          const choices = defaultBoardChoices(target);
          const board = draftBoardRevision(target, 'Deals', choices);
          await activate(board);
          const query = {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: board.body.listQuery.queryId,
            arguments: {
              'northstar.app:parameter.custom_deal_list_legal_entity_scope':
                COMPANY,
              boardPage: {
                surfaceId: board.surfaceId,
                revisionId: board.revisionId,
                stages: board.body.grouping.stages.map(
                  ({ stateId }) => stateId,
                ),
                filters: [],
              },
            },
          };

          await coverage.start();
          const capable = await openComposedApplicationRuntime(options);
          const boardView = await capable.entry
            .run({ headers: {} }, async (view) => {
              assert.notEqual(view.release.releaseId, compatibleRelease);
              const result = await capable.queryGateway.invoke(view, query);
              assert.deepEqual(
                result.records.map(({ recordId }) => recordId),
                [recordId],
              );
              return view;
            })
            .finally(() => capable.close());
          assert.ok((await coverage.take()).releasePolicyBindings > 0);

          const surfaceReader = SUPPORTED_RUNTIME_CAPABILITIES[
            REQUEST_RUNTIME_PROJECTION_FAMILIES.surface
          ]! as {
            maximumSupportedVersion: number;
          };
          const supportedVersion = surfaceReader.maximumSupportedVersion;
          const requirement =
            boardView.projections.surface.requiredRuntimeCapability;
          assert.ok(requirement);
          const olderVersion = requirement.minimumVersion - 1;
          const releaseId = boardView.release.releaseId;
          const original = await pool.query<{
            revision_id: string;
            desired_state: Buffer;
          }>(
            `SELECT revision.revision_id, revision.desired_state
               FROM platform.tenant_releases AS release
               JOIN platform.app_package_revisions AS revision
                 ON revision.tenant_id = release.tenant_id
                AND revision.revision_id = release.app_package_revision_id
              WHERE release.release_id = $1`,
            [releaseId],
          );
          const row = original.rows[0];
          assert.ok(row);
          const definition = JSON.parse(row.desired_state.toString('utf8')) as {
            surfaces: { board?: Record<string, unknown> }[];
          };
          const declaredBoard = definition.surfaces.find(
            (surface) => surface.board,
          )?.board;
          assert.ok(declaredBoard);
          // Model a later Board shape with its own reader rung. The persisted
          // projection requirements come from the real Board activation.
          declaredBoard.futureBoardOption = true;
          await replaceDefinition(
            pool,
            row.revision_id,
            Buffer.from(JSON.stringify(definition)),
          );
          surfaceReader.maximumSupportedVersion = olderVersion;
          const refusal = {
            code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
            message: `release ${releaseId}: runtime capability ${requirement.capabilityId} requires version ${String(requirement.minimumVersion)} and this runtime supports ${String(olderVersion)}`,
          };
          try {
            await assert.rejects(
              openComposedApplicationRuntime(options).then(async (runtime) => {
                await runtime.close();
                assert.fail('boot must refuse');
              }),
              refusal,
            );
            assert.deepEqual(
              await coverage.take(),
              {
                loadServingRelease: 1,
                releasePolicyBindings: 0,
              },
              'boot stops before policy and does not re-open the release through fallback',
            );

            // The top-level request loader already refuses a higher floor.
            await assert.rejects(
              initial.runtime.entry.run({ headers: {} }, () =>
                assert.fail('request must refuse'),
              ),
              {
                code: refusal.code,
              },
            );
            // Use an authentic Board view to reach the lazy serving route
            // independently of the request-view loader's existing gate.
            await assert.rejects(
              initial.runtime.queryGateway.invoke(boardView, query),
              refusal,
            );
            assert.deepEqual(await coverage.take(), {
              loadServingRelease: 1,
              releasePolicyBindings: 0,
            });
          } finally {
            surfaceReader.maximumSupportedVersion = supportedVersion;
            await replaceDefinition(pool, row.revision_id, row.desired_state);
          }

          await opened.service.rollback(releaseId);
          const recovered = await initial.runtime.entry.run(
            { headers: {} },
            (view) => {
              assert.equal(view.release.releaseId, compatibleRelease);
              return initial.runtime.queryGateway.invoke(view, {
                ...query,
                arguments: {
                  'northstar.app:parameter.custom_deal_list_legal_entity_scope':
                    COMPANY,
                },
              });
            },
          );
          assert.deepEqual(
            recovered.records.map(({ recordId }) => recordId),
            [recordId],
          );
        } finally {
          await opened.close();
          await initial.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);

function policyCoverage() {
  const session = new Session();
  session.connect();
  return {
    async start() {
      await session.post('Profiler.enable');
      await session.post('Profiler.startPreciseCoverage', {
        callCount: true,
        detailed: false,
      });
    },
    async take() {
      const { result } = await session.post('Profiler.takePreciseCoverage');
      const script = result.find(({ url }) =>
        url.endsWith('/serving-gateways.ts'),
      );
      const calls = (name: string) =>
        script?.functions.find(({ functionName }) => functionName === name)
          ?.ranges[0]?.count ?? 0;
      return {
        loadServingRelease: calls('loadServingRelease'),
        releasePolicyBindings: calls('releasePolicyBindings'),
      };
    },
    [Symbol.dispose]() {
      session.disconnect();
    },
  };
}

async function replaceDefinition(
  pool: pg.Pool,
  revisionId: string,
  bytes: Buffer,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'ALTER TABLE platform.app_package_revisions DISABLE RULE app_package_revisions_reject_update',
    );
    const updated = await client.query(
      'UPDATE platform.app_package_revisions SET desired_state = $2 WHERE revision_id = $1',
      [revisionId, bytes],
    );
    assert.equal(updated.rowCount, 1);
    await client.query(
      'ALTER TABLE platform.app_package_revisions ENABLE RULE app_package_revisions_reject_update',
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
