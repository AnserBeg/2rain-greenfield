import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import type { SerializedRelease } from '../../packages/customization/src/index.js';
import {
  assertArchivedTenantEnvelopeForChange,
  withArchivedCustomizationRuntime,
} from './archived-customization-runtime.js';
import {
  RECORD_TEMPLATE_OPERATION_READER,
  RECORD_TEMPLATE_READER,
} from '../../packages/canonical-model/src/record-template.js';

// Update to the actual immediately preceding serving tip when the train is integrated.
const preceding = '7046abc74feacc8943874f1ced6d4674ddcb7548';

async function assertPersisted(
  pool: pg.Pool,
  releaseId: string,
  archived: SerializedRelease,
) {
  const {
    rows: [row],
  } = await pool.query<{
    root: string;
    definition: Buffer;
    artifacts: Record<string, string>;
  }>(
    `
   SELECT r.content_hash AS root, d.desired_state AS definition, (
      SELECT jsonb_object_agg(b.content_hash,encode(b.canonical_bytes,'base64'))
      FROM platform.release_artifact_blobs b WHERE b.content_hash=r.content_hash OR EXISTS (
        SELECT FROM platform.tenant_release_artifact_links l WHERE
          (l.tenant_id,l.environment_id,l.release_id,l.content_hash,l.artifact_kind)=
          (r.tenant_id,r.environment_id,r.release_id,b.content_hash,b.artifact_kind))
   ) AS artifacts FROM platform.tenant_releases r JOIN platform.app_package_revisions d
     ON (r.tenant_id,r.app_package_revision_id)=(d.tenant_id,d.revision_id) WHERE r.release_id=$1`,
    [releaseId],
  );
  assert.ok(row);
  assert.equal(row.root, archived.releaseRoot);
  assert.equal(
    row.definition.toString('base64'),
    archived.normalizedDefinitionBytesBase64,
  );
  // Compare identities first to keep a failing assertion from printing megabytes.
  assert.deepEqual(
    Object.keys(row.artifacts).sort(),
    archived.artifacts.map((a) => String(a.contentHash)).sort(),
  );
  for (const a of archived.artifacts) {
    assert.ok(
      Buffer.from(row.artifacts[String(a.contentHash)]!, 'base64').equals(
        Buffer.from(String(a.canonicalBytesBase64), 'base64'),
      ),
      String(a.contentHash),
    );
  }
}

const probe = `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ObservabilityMetrics} from './packages/observability/src/index.ts';
import {rolePool,trustedContext} from './packages/postgres-provider/src/composed-application-runtime.ts';
import {PostgresRequestRuntimeViewService} from './packages/postgres-provider/src/request-runtime-view-service.ts';
import {composeServingGateways,readVerifiedServing,loadServingRelease} from './packages/postgres-provider/src/serving-gateways.ts';
import {AuthenticatedRequestRuntimeEntryAdapter} from './packages/runtime/src/request-runtime-view.ts';
import {AuthenticatedRequestEntryAdapter} from './packages/runtime/src/request-context.ts';
import {SEMANTIC_QUERY_REQUEST_VERSION} from './packages/runtime/src/semantic-query-gateway.ts';
import {parseCustomizationPatch} from './packages/customization/src/patch.ts';
const i=JSON.parse(await readFile(process.argv[2],'utf8'));
const pool=rolePool(i.databaseUrl,'north_star_runtime',2), ctx=await trustedContext(i.identity);
let loaderRefusal;
const boot=async()=>{
 const p=await readVerifiedServing(pool,ctx);
 const serving=await loadServingRelease(pool,ctx,p.releaseId);
 const gates=composeServingGateways(pool,pool,ctx,serving,new ObservabilityMetrics(),{providerErrorMappings:[]});
 const loader=new PostgresRequestRuntimeViewService(pool);
 // Request entry redacts detailed loader diagnostics. Observe and rethrow the same error.
 const observedLoader={load:async context=>{
    try{return await loader.load(context);}catch(error){
      loaderRefusal={code:error.code,message:error.message,releaseId:(await readVerifiedServing(pool,context)).releaseId};
      throw error;
    }
 }};
 const entry=new AuthenticatedRequestRuntimeEntryAdapter(new AuthenticatedRequestEntryAdapter(async()=>i.identity),observedLoader,gates.policy);
 return ()=>entry.run({headers:{}},v=>gates.queryGateway.invoke(v,{schemaVersion:SEMANTIC_QUERY_REQUEST_VERSION,queryId:i.queryId,arguments:i.args}));
};
const rawParse=JSON.parse, hits=new Set();
let observed=new Set(i.hashes);
JSON.parse=function(text,...rest){
 if(typeof text==='string'){
   const hash=createHash('sha256').update(text).digest('hex');
   if(observed.has(hash)) hits.add(hash);
 }
 return rawParse.call(this,text,...rest);
};
try {
 const oldPatch=parseCustomizationPatch(i.patch);
 const query=await boot();
 const rows=(await query()).records.map(r=>r.recordId);
 assert.deepEqual(rows,[i.recordId]);
 assert.ok(hits.size>0,'compatible request actually decoded release bytes');
 const moved=await (await fetch(i.signal,{method:'POST'})).json();
 if(moved.error) throw Error(moved.error);
 observed=new Set(moved.hashes);
 async function refused(path){
   hits.clear();
   try {await path();return {outcome:'served'};} catch(e){
     return {outcome:'refused',code:e.code,message:e.message,decoded:hits.size};
   }
 }
 console.log(JSON.stringify({oldPatch,rows,hot:await refused(query),cold:await refused(boot),loaderRefusal,releaseId:moved.releaseId}));
}finally {JSON.parse=rawParse;await pool.end();}
`;

export async function exercisePrecedingReader(input: {
  pool: pg.Pool;
  databaseUrl: string;
  identity: unknown;
  firstPartyId: string;
  compatibleId: string;
  compatiblePatch: unknown;
  patch: unknown;
  queryId: string;
  args: Record<string, string>;
  recordId: string;
  declare: () => Promise<string>;
}) {
  const { pool } = input;
  async function fingerprints(id: string) {
    const result = await pool.query<{ hash: string }>(
      `SELECT encode(sha256(desired_state),'hex') hash FROM platform.app_package_revisions d
    JOIN platform.tenant_releases r ON (d.tenant_id,d.revision_id)=(r.tenant_id,r.app_package_revision_id) WHERE r.release_id=$1
    UNION SELECT encode(sha256(b.canonical_bytes),'hex') FROM platform.tenant_release_artifact_links l
    JOIN platform.release_artifact_blobs b USING(content_hash,artifact_kind) WHERE l.release_id=$1 AND l.artifact_kind='projectionChunk'`,
      [id],
    );
    assert.ok(result.rows.length > 3);
    return result.rows.map((r) => r.hash);
  }
  await withArchivedCustomizationRuntime(preceding, async (run) => {
    const base = (await run(
      `import {readFile} from 'node:fs/promises';const file=JSON.parse(await readFile('apps/web/release/app.compiled.json','utf8'));console.log(JSON.stringify(file.applications.at(-1)??file.bootstrap));`,
      null,
    )) as SerializedRelease;
    await assertPersisted(pool, input.firstPartyId, base);
    await assertPersisted(
      pool,
      input.compatibleId,
      await assertArchivedTenantEnvelopeForChange(run, input.compatiblePatch),
    );
    const hashes = await fingerprints(input.compatibleId);
    let activated: string | undefined;
    const moved = createServer((_request, response) => {
      void (async () => {
        activated = await input.declare();
        return { releaseId: activated, hashes: await fingerprints(activated) };
      })().then(
        (body) => response.end(JSON.stringify(body)),
        (err: unknown) => response.end(JSON.stringify({ error: String(err) })),
      );
    });
    moved.listen(0, '127.0.0.1');
    await once(moved, 'listening');
    try {
      const result = (await run(probe, {
        databaseUrl: input.databaseUrl,
        identity: input.identity,
        hashes,
        patch: input.patch,
        queryId: input.queryId,
        args: input.args,
        recordId: input.recordId,
        signal:
          'http://127.0.0.1:' + String((moved.address() as AddressInfo).port),
      })) as {
        oldPatch: { status: string; missingCapability: string };
        hot: { code: string; message: string; decoded: number };
        loaderRefusal: { code: string; message: string; releaseId: string };
        cold: { code: string; message: string; decoded: number };
        releaseId: string;
        rows: string[];
      };
      assert.deepEqual(result.rows, [input.recordId]);
      assert.equal(result.oldPatch.status, 'unsupported');
      assert.equal(
        result.oldPatch.missingCapability,
        'addRecordTemplateBindingRevision',
      );
      assert.ok(activated);
      assert.equal(result.releaseId, activated);
      assert.equal(result.hot.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
      assert.equal(result.hot.decoded, 0);
      assert.equal(result.cold.decoded, 0);
      assert.equal(result.loaderRefusal.releaseId, activated);
      for (const refusal of [result.loaderRefusal, result.cold]) {
        assert.equal(refusal.code, 'UNSUPPORTED_RUNTIME_CAPABILITY');
        assert.match(
          refusal.message,
          new RegExp(
            'capability\\.(operation-catalog requires version ' +
              String(RECORD_TEMPLATE_OPERATION_READER) +
              '|surface-manifest requires version ' +
              String(RECORD_TEMPLATE_READER) +
              ')',
          ),
        );
      }
      assert.ok(result.cold.message.includes(activated));
    } finally {
      moved.close();
      await once(moved, 'close');
    }
  });
}
