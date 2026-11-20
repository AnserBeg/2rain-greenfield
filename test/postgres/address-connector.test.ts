import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { openCustomizeService, startComposedApplication } from '../../apps/api/src/composition-root.js';
import { ADDRESS_FIELD_READER, AddressProjectionSchema, SavedAddressSchema } from '@north-star/canonical-model';
import { OperationsAgentSession } from '../../packages/operations-agent/src/session.js';
import { COMPANY, worldOver } from '../agent/agent-world.js';
import { archivedRuntimeRead, assertArchivedTenantEnvelope, withArchivedCustomizationRuntime } from '../helpers/archived-customization-runtime.js';
import { LINEAGE_INSTALL_VOLUME, withEphemeralPostgres } from '../helpers/postgres.js';

const previousReader = '2042780b';
const address = {kind:'addAddressField',schemaVersion:'v6',entity:'northstar.app:entity.item',fieldId:'northstar.app:field.custom_item_site',label:'Site',required:false} as const;

test('Address publication preserves the old envelope, stops the prior reader, and serves governed user text without a provider', {timeout:600000}, async () => {
  await withEphemeralPostgres('address-connector',async ({connection})=>{
    const databaseUrl=`postgresql://${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
    const options={databaseUrl, tenantSlug:'address-connector'};
    const app=await startComposedApplication({...options,port:0});
    const opened=await openCustomizeService(options);
    try {
      const draft=await opened.service.draft(address,'visualBuilder');
      assert.ok(draft.status==='drafted',JSON.stringify(draft));
      await opened.service.approve(draft.patchId);
      await withArchivedCustomizationRuntime(previousReader,async run=>{
        await assertArchivedTenantEnvelope(run);
        const parse=await run(`import {readFileSync} from 'node:fs';import {parseCustomizationPatch} from './packages/customization/src/patch.ts';console.log(JSON.stringify(parseCustomizationPatch(JSON.parse(readFileSync(process.argv[2],'utf8')))));`,address) as {status:string};
        assert.equal(parse.status,'unsupported');
        const read=()=>archivedRuntimeRead(run,{databaseUrl,identity:app.runtime.identity});
        assert.equal((await read()).outcome,'loaded');
        await opened.service.activate(draft.patchId);
        const refusal=await read();
        assert.equal(refusal.code,'UNSUPPORTED_RUNTIME_CAPABILITY');
        assert.match(refusal.message??'',new RegExp(`surface-manifest requires version ${ADDRESS_FIELD_READER}`));
      });
      const headers={cookie:'northstar-demo-actor=manager'};
      const world=worldOver(app.runtime,String(connection.database));
      const recordId=randomUUID();
      const result=await world.invoke('item_create',{recordId,relations:{},values:{'northstar.app:field.item_sku':'ADDRESS-SITE','northstar.app:field.item_name':'Site','northstar.app:field.item_base_unit':'EA',[address.fieldId]:{schemaVersion:'northstar.address-value/v1',text:'15 Jasper Street'}}},{actor:'manager'});
      assert.equal(SavedAddressSchema.parse(result.readBack?.values[address.fieldId]).text,'15 Jasper Street');
      const session=new OperationsAgentSession({runtime:app.runtime,companyId:COMPANY,personHeaders:headers,approve:()=>Promise.resolve(true)});
      const response=await session.call('erp_query',{queryId:'northstar.app:query.item_get',arguments:{recordId},selection:[address.fieldId]});
      assert.equal(response.isError,false,JSON.stringify(response.content));
      assert.match(JSON.stringify(response.content),/15 Jasper Street/u);
      await app.runtime.entry.run({headers},async view=>{
        const b=AddressProjectionSchema.parse(view.projections.connector?.payload).bindings[0]!;
        const t={fieldId:b.fieldId,recordId,companyId:COMPANY};
        assert.deepEqual(await app.runtime.addresses.pin(view,t,b.mapQueryId),{status:'unavailable'});
      });
    }finally{await opened.close();await app.close();}
  },LINEAGE_INSTALL_VOLUME);
});
