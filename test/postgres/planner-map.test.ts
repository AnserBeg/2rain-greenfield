import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  startComposedApplication,
  openCustomizeService,
} from '../../apps/api/src/composition-root.js';
import {
  activateMapFixtureChange,
  fixtureMapRevision,
  stopAddress as address,
  stopName as name,
  stopScope as scope,
  stopSetup as setup,
} from '../helpers/planner-map-fixture.js';
import { MAP_VIEW_READER } from '../../packages/canonical-model/src/map-view.js';
import { parseServerTiming } from '../../packages/postgres-provider/src/request-work-meter.js';
import { catalogParseCount } from '../../packages/runtime/src/catalog-parse-count.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import {
  withArchivedCustomizationRuntime,
  archivedRuntimeRead,
  assertArchivedTenantEnvelope,
} from '../helpers/archived-customization-runtime.js';
import {
  withEphemeralPostgres,
  LINEAGE_INSTALL_VOLUME,
} from '../helpers/postgres.js';

// This is the serving binary at the preceding main tip. Refresh it when assigning the merge rungs.
const predecessor = '630e2aa690906af9256c5964c398ba90585515d2';
test(
  'serve a published Map through the dispatcher’s collection, connector and preceding reader',
  { timeout: 900_000 },
  async () => {
    await withEphemeralPostgres(
      'planner-map',
      async ({ connection, pool }) => {
        const databaseUrl = `postgresql://${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
        const options = { databaseUrl, tenantSlug: 'planner-map' };
        const app = await startComposedApplication({ ...options, port: 0 });
        const customize = await openCustomizeService(options);
        const activate = (change: unknown) =>
          activateMapFixtureChange(customize.service, change);
        try {
          await activate(setup);
          const revision = await fixtureMapRevision(customize.service);
          const world = worldOver(app.runtime, String(connection.database)),
            other = randomUUID();
          const created = await world.invoke('legal_entity_create', {
            recordId: other,
            values: {
              'northstar.app:field.legal_entity_code': 'MAP-B',
              'northstar.app:field.legal_entity_name': 'Map company B',
            },
          });
          assert.equal(created.outcome, 'succeeded');
          async function stop(
            company: string,
            label: string,
            latitude: string,
          ) {
            const recordId = randomUUID(),
              saved = await world.invoke('custom_stop_create', {
                recordId,
                legalEntityId: company,
                values: {
                  [name]: label,
                  [address]: {
                    schemaVersion: 'northstar.address-value/v1',
                    text: label,
                    pin: { kind: 'user', latitude, longitude: '-113.5' },
                  },
                },
              });
            assert.equal(saved.outcome, 'succeeded');
            return recordId;
          }
          const alpha = await stop(COMPANY, 'North warehouse', '53.52'),
            beta = await stop(other, 'South private yard', '47.20');
          const manager = { cookie: 'northstar-demo-actor=manager' };
          for (const id of [COMPANY, other])
            await app.runtime.entry.run({ headers: manager }, async (view) =>
              assert.ok(
                await app.runtime.addresses.configure(view, id, {
                  provider: 'fake',
                  account: 'dispatch',
                  enrichment: true,
                  enabled: true,
                  calls: 50,
                  budgetMicros: 0,
                }),
              ),
            );
          await withArchivedCustomizationRuntime(predecessor, async (run) => {
            await assertArchivedTenantEnvelope(run);
            const historical = (await run(
              `
          import { readFile } from 'node:fs/promises';
          import { parseCompiledApplication } from './packages/postgres-provider/src/composed-application-runtime.ts';
          import { compileInSandbox,serializeRelease } from './packages/customization/src/index.ts';
          import { readUnboundPermissionAcknowledgementFor } from './apps/web/scripts/unbound-permission-acknowledgement.ts';
          const file='apps/web/release/app.authored.json';
          const compiled=parseCompiledApplication(JSON.parse(await readFile('apps/web/release/app.compiled.json','utf8')));
          const tip=serializeRelease(compiled.application);
          const setup=JSON.parse(await readFile(process.argv[2],'utf8'));
          const out=await compileInSandbox({base:JSON.parse(await readFile(file,'utf8')),chain:[setup],tip,
            acknowledgement:readUnboundPermissionAcknowledgementFor(file,'northstar.app:package.application')});
          if(out.status!=='compiled') throw Error(JSON.stringify(out));
          console.log(JSON.stringify([tip,out.steps[0].release]));
        `,
              setup,
            )) as {
              releaseRoot: string;
              normalizedDefinitionBytesBase64: string;
              releaseManifestBytesBase64: string;
              artifacts: {
                contentHash: string;
                canonicalBytesBase64: string;
              }[];
            }[];
            for (const envelope of historical) {
              const row = await pool.query(
                `SELECT r.release_id,p.desired_state FROM platform.tenant_releases r
            JOIN platform.app_package_revisions p ON (r.tenant_id,r.app_package_revision_id)=(p.tenant_id,p.revision_id)
            WHERE r.content_hash=$1 AND r.tenant_id=$2`,
                [envelope.releaseRoot, app.runtime.identity.tenantId],
              );
              assert.equal(row.rowCount, 1, envelope.releaseRoot);
              assert.equal(
                row.rows[0].desired_state.toString('base64'),
                envelope.normalizedDefinitionBytesBase64,
              );
              const artifacts = await pool.query(
                `SELECT b.content_hash,b.canonical_bytes FROM platform.tenant_release_artifact_links l
            JOIN platform.release_artifact_blobs b USING(content_hash) WHERE l.release_id=$1`,
                [row.rows[0].release_id],
              );
              const bytes = new Map(
                artifacts.rows.map((r) => [
                  r.content_hash,
                  r.canonical_bytes.toString('base64'),
                ]),
              );
              for (const a of envelope.artifacts)
                assert.equal(
                  bytes.get(a.contentHash),
                  a.canonicalBytesBase64,
                  a.contentHash,
                );
              const manifest = await pool.query(
                'SELECT canonical_bytes FROM platform.release_artifact_blobs WHERE content_hash=$1',
                [envelope.releaseRoot],
              );
              assert.equal(
                manifest.rows[0].canonical_bytes.toString('base64'),
                envelope.releaseManifestBytesBase64,
              );
            }
            const oldAnswer = await run(
              `
          import { readFile } from 'node:fs/promises';
          import { openComposedApplicationRuntime } from './apps/api/src/composition-root.ts';
          import { SEMANTIC_QUERY_REQUEST_VERSION } from './packages/runtime/src/semantic-query-gateway.ts';
          const {options,queryId,scope,company,recordId}=JSON.parse(await readFile(process.argv[2],'utf8'));
          const runtime=await openComposedApplicationRuntime(options);
          try {
            const r=await runtime.entry.run({headers:{}},v=>runtime.queryGateway.invoke(v,{
              schemaVersion:SEMANTIC_QUERY_REQUEST_VERSION,queryId,arguments:{[scope]:company}}));
            console.log(JSON.stringify({outcome:r.outcome,hasStop:r.records.some(row=>row.recordId===recordId)}));
          } finally {await runtime.close();}
        `,
              {
                options,
                queryId: revision.body.listQueryId,
                scope,
                company: COMPANY,
                recordId: alpha,
              },
            );
            assert.deepEqual(oldAnswer, { outcome: 'exact', hasStop: true });
            await activate(revision);
            const refused = await archivedRuntimeRead(run, {
              databaseUrl,
              identity: app.runtime.identity,
            });
            assert.equal(refused.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
            assert.match(
              refused.message ?? '',
              new RegExp(
                'surface-manifest requires version ' + MAP_VIEW_READER,
              ),
            );
          });
          const url = new URL('/', app.baseUrl);
          url.searchParams.set('surface', revision.surfaceId);
          url.searchParams.set(scope, COMPANY);
          const serve = () => fetch(url, { headers: manager });
          await (await serve()).arrayBuffer();
          await (await serve()).arrayBuffer();
          const before = catalogParseCount(),
            response = await serve(),
            html = await response.text(),
            after = catalogParseCount();
          assert.equal(response.status, 200, html.slice(-1200));
          assert.match(html, /data-map-drag/u);
          assert.match(html, /North warehouse/u);
          assert.ok(html.includes(alpha));
          assert.ok(!html.includes(beta));
          assert.doesNotMatch(html, /South private yard/u);
          const counts = parseServerTiming(
            response.headers.get('server-timing'),
          );
          assert.ok(counts);
          assert.ok(
            counts.transactions <= 2 &&
              counts.statements <= 40 &&
              counts.authorization <= 3,
            JSON.stringify(counts),
          );
          assert.equal(counts.repeats, 0);
          for (const key of [
            'operationCatalog',
            'queryCatalog',
            'surfaceManifest',
          ] as const)
            assert.equal(after[key], before[key], key);
          const src = html
            .match(/href="(\/map\/image\?[^"]+)"/u)?.[1]
            ?.replaceAll('&amp;', '&');
          assert.ok(src);
          const image = new URL(src, app.baseUrl);
          assert.equal((await fetch(image, { headers: manager })).status, 200);
          image.searchParams.set('company', other);
          assert.equal((await fetch(image, { headers: manager })).status, 404);
          const bUrl = new URL(url);
          bUrl.searchParams.set(scope, other);
          const bHtml = await (await fetch(bUrl, { headers: manager })).text();
          assert.ok(bHtml.includes(beta) && !bHtml.includes(alpha));
          // A viewer with a valid role in A has no query scope in B.
          const { tenantId, environmentId, principalId } = app.runtime.identity;
          const membership = await pool.query(
            'UPDATE platform.current_policy_memberships SET legal_entity_id=$4 WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND revoked_at IS NULL',
            [tenantId, environmentId, principalId, COMPANY],
          );
          assert.ok(membership.rowCount);
          assert.ok((await (await fetch(url)).text()).includes(alpha));
          const denied = await (await fetch(bUrl)).text();
          assert.ok(
            !denied.includes(beta) && !denied.includes('South private yard'),
          );
        } finally {
          await customize.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
