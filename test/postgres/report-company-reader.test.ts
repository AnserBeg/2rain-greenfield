import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  openCustomizeService,
  startComposedApplication,
} from '../../apps/api/src/composition-root.js';
import { readUnboundPermissionAcknowledgementFor } from '../../apps/web/scripts/unbound-permission-acknowledgement.js';
import {
  COMPANY_ACCESS_INDEX,
  COMPANY_ACCESS_INDEX_READER,
} from '../../packages/canonical-model/src/index.js';
import {
  compileInSandbox,
  CustomizationPatchSchema,
  serializeRelease,
  type SerializedRelease,
} from '../../packages/customization/src/index.js';
import { parseCompiledApplication } from '../../packages/postgres-provider/src/composed-application-runtime.js';
import { recordedPatch } from '../helpers/customization-patch-record.js';
import { withArchivedCustomizationRuntime } from '../helpers/archived-runtime-process.js';
import {
  LINEAGE_INSTALL_VOLUME,
  withEphemeralPostgres,
} from '../helpers/postgres.js';

import {
  reportsPredecessor,
  readReportsPredecessor,
} from '../helpers/reports-preceding-release.js';

const archivedQuery = `
import { readFile } from 'node:fs/promises';
import { CAPABILITY_EXECUTOR_FACTORIES } from './apps/api/src/erp-capabilities.ts';
import { ObservabilityMetrics } from './packages/observability/src/index.ts';
import { rolePool, trustedContext } from './packages/postgres-provider/src/composed-application-runtime.ts';
import { composeServingGateways, loadServingRelease } from './packages/postgres-provider/src/serving-gateways.ts';
import { PostgresRequestRuntimeViewService } from './packages/postgres-provider/src/request-runtime-view-service.ts';
import { AuthenticatedRequestEntryAdapter } from './packages/runtime/src/request-context.ts';
import { AuthenticatedRequestRuntimeEntryAdapter } from './packages/runtime/src/request-runtime-view.ts';
import { SEMANTIC_QUERY_REQUEST_VERSION } from './packages/runtime/src/semantic-query-gateway.ts';
const {databaseUrl,identity}=JSON.parse(await readFile(process.argv[2],'utf8'));
const pool=rolePool(databaseUrl,'north_star_runtime',4);
let phase='load';
try {
  const loader=new PostgresRequestRuntimeViewService(pool);
  const context=await trustedContext(identity);
  const {release}=await loader.load(context);
  phase='query';
  const serving=await loadServingRelease(pool,context,release.releaseId);
  const {policy,queryGateway}=composeServingGateways(pool,pool,context,serving,new ObservabilityMetrics(),{
    providerErrorMappings:[],capabilityOperationExecutorFactories:CAPABILITY_EXECUTOR_FACTORIES,localDemoIdentity:true,
  });
  const entry=new AuthenticatedRequestRuntimeEntryAdapter(new AuthenticatedRequestEntryAdapter(async()=>identity),loader,policy);
  const result=await entry.run({},view=>queryGateway.invoke(view,{schemaVersion:SEMANTIC_QUERY_REQUEST_VERSION,queryId:'northstar.app:query.legal_entity_list',arguments:{}}));
  console.log(JSON.stringify({outcome:'answered', ids:result.records.map(r=>r.recordId)}));
} catch(error) {
  console.log(JSON.stringify({outcome:'refused',phase,code:error.code,message:error.message}));
} finally { await pool.end(); }
`;

async function assertStoredBytes(
  pool: Pool,
  releaseId: string,
  expected: SerializedRelease,
) {
  const revision = await pool.query<{
    content_hash: string;
    desired_state: Buffer;
  }>(
    `SELECT r.content_hash, p.desired_state FROM platform.tenant_releases r
     JOIN platform.app_package_revisions p ON p.tenant_id=r.tenant_id AND p.revision_id=r.app_package_revision_id
     WHERE r.release_id=$1`,
    [releaseId],
  );
  assert.equal(revision.rows[0]?.content_hash, expected.releaseRoot);
  assert.equal(
    revision.rows[0]?.desired_state.toString('base64'),
    expected.normalizedDefinitionBytesBase64,
  );
  const blobs = await pool.query<{
    content_hash: string;
    canonical_bytes: Buffer;
  }>(
    `SELECT l.content_hash, b.canonical_bytes FROM platform.tenant_release_artifact_links l
     JOIN platform.release_artifact_blobs b USING (content_hash) WHERE l.release_id=$1
     UNION ALL
     SELECT r.content_hash, b.canonical_bytes FROM platform.tenant_releases r
     JOIN platform.release_artifact_blobs b USING (content_hash) WHERE r.release_id=$1`,
    [releaseId],
  );
  assert.deepEqual(
    new Map(
      blobs.rows.map((b) => [
        b.content_hash,
        b.canonical_bytes.toString('base64'),
      ]),
    ),
    new Map(
      expected.artifacts.map((a) => [
        String(a.contentHash),
        String(a.canonicalBytesBase64),
      ]),
    ),
  );
}

test(
  'persisted first-party and pre-key company bytes agree, and the preceding reader answers a query before refusing a newly indexed company type',
  { timeout: 900_000 },
  async () => {
    const path = 'apps/web/release/app.authored.json';
    const compiledApplication = readReportsPredecessor(
      'apps/web/release/app.compiled.json',
    );
    const tip = serializeRelease(
      parseCompiledApplication(compiledApplication).application,
    );
    await withEphemeralPostgres(
      'report-company-reader',
      async ({ pool, connection }) => {
        const options = {
          databaseUrl: `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${String(connection.database)}`,
          tenantSlug: 'report-company-reader',
          compiledApplication,
        };
        const app = await startComposedApplication({ ...options, port: 0 });
        const opened = await openCustomizeService(options);
        try {
          const readInput = {
            identity: app.runtime.identity,
            databaseUrl: options.databaseUrl,
          };
          await withArchivedCustomizationRuntime(
            reportsPredecessor,
            async (run) => {
              await assertStoredBytes(pool, app.runtime.activeReleaseId, tip);
              const control = (await run(archivedQuery, readInput)) as {
                outcome: string;
                ids: string[];
              };
              assert.equal(
                control.outcome,
                'answered',
                JSON.stringify(control),
              );
              assert.ok(
                control.ids.length > 0,
                'the scoped company list actually returned a company',
              );
              const change = CustomizationPatchSchema.parse({
                kind: 'addRecordType',
                companyOwnership: 'entityOwned',
                label: 'Historical inspection',
                fields: [{ type: 'text', label: 'Name' }],
              });
              const historical = (await run(
                `
          import {readFile} from 'node:fs/promises';
          import {openCustomizeService} from './apps/api/src/composition-root.ts';
          const {options,change}=JSON.parse(await readFile(process.argv[2],'utf8'));
          const opened=await openCustomizeService(options);
          try {
            const draft=await opened.service.draft(change,'visualBuilder');
            if(draft.status!=='drafted')throw new Error(JSON.stringify(draft));
            console.log(JSON.stringify(draft.patchId));
          } finally {await opened.close();}
        `,
                {
                  options: {
                    databaseUrl: options.databaseUrl,
                    tenantSlug: options.tenantSlug,
                  },
                  change,
                },
              )) as string;
              const old = await recordedPatch(pool, historical);
              assert.deepEqual(JSON.parse(old.payload.toString()), change);
              const reproduced = await compileInSandbox({
                base: readReportsPredecessor(path),
                chain: [change],
                tip,
                acknowledgement: readUnboundPermissionAcknowledgementFor(
                  path,
                  'northstar.app:package.application',
                ),
              });
              assert.ok(reproduced.status === 'compiled');
              await assertStoredBytes(
                pool,
                old.resulting_release_id,
                reproduced.steps[0]!.release,
              );
              const draft = await opened.service.draft(
                { ...change, label: 'Inspection' },
                'visualBuilder',
              );
              assert.ok(draft.status === 'drafted', JSON.stringify(draft));
              const fresh = await recordedPatch(pool, draft.patchId);
              assert.equal(
                JSON.parse(fresh.payload.toString()).companyAccessIndex,
                COMPANY_ACCESS_INDEX,
              );
              await opened.service.approve(draft.patchId);
              await opened.service.activate(draft.patchId);
              const index =
                'nsm_i_57kahsinwt3fo73cpq5mduuaqnwmyh6a7jjowaafqx5jvwtbwnsa';
              const ready = await pool.query(
                'SELECT indisready AND indisvalid AS ready FROM pg_catalog.pg_index WHERE indexrelid=pg_catalog.to_regclass($1)',
                ['north_star_module.' + index],
              );
              assert.equal(ready.rows[0]?.ready, true);
              const requireRefusal = async () =>
                assert.deepEqual(await run(archivedQuery, readInput), {
                  outcome: 'refused',
                  phase: 'load',
                  code: 'UNSUPPORTED_RUNTIME_CAPABILITY',
                  message:
                    'runtime capability northstar.runtime:capability.surface-manifest requires version ' +
                    COMPANY_ACCESS_INDEX_READER +
                    ' and this runtime supports 37',
                });
              await requireRefusal();
              // Mutate only the extracted production loader in this disposable archive.
              await run(
                `
                import assert from 'node:assert/strict';
                import {readFile, writeFile} from 'node:fs/promises';
                const file='packages/runtime/src/request-runtime-view.ts';
                const source=await readFile(file,'utf8');
                const guard='if (requirement.minimumVersion > entry.maximumSupportedVersion)';
                assert.equal(source.split(guard).length,2);
                await writeFile(file,source.replace(guard,'if (false)'));
                console.log('null');
              `,
                {},
              );
              await assert.rejects(requireRefusal, { name: 'AssertionError' });
              const mutant = (await run(archivedQuery, readInput)) as {
                phase?: string;
                outcome: string;
              };
              assert.ok(
                mutant.phase === 'query' || mutant.outcome === 'answered',
                'without the floor check the preceding loader admitted the indexed release',
              );

              await assertStoredBytes(
                pool,
                old.resulting_release_id,
                reproduced.steps[0]!.release,
              );
            },
          );
        } finally {
          await opened.close();
          await app.close();
        }
      },
      LINEAGE_INSTALL_VOLUME,
    );
  },
);
