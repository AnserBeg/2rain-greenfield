import { randomUUID } from 'node:crypto';
import { withModuleRuntimeRole } from './module-runtime-interpreter.js';
import type { AddressGateway, AddressInstallation } from '../../runtime/src/address-gateway.js';
import type { Pool, PoolClient } from 'pg';
import { AddressProjectionSchema, CoordinatesSchema, SavedAddressSchema , } from '@north-star/canonical-model';
import type { RequestRuntimeView, CurrentPolicyGateway } from '../../runtime/src/request-runtime-view.js';
import { authorizeCurrentPolicy, issueLegalEntityReadScope, trustedContextForRequestRuntimeView } from '../../runtime/src/request-runtime-view.js';
import { parsePinnedOperationCatalog, OPERATION_BOUNDARY_PERMISSION_ID } from '../../runtime/src/semantic-operation-gateway.js';
import { registeredQueryFromPinnedView, SEMANTIC_QUERY_REQUEST_VERSION, type SemanticQueryGateway } from '../../runtime/src/semantic-query-gateway.js';
import { addressProvider, AddressProviderError, type AddressProvider, type InstallationIdentity } from './address-provider.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { currentPolicyVersionOf } from './current-policy.js';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';


type Entity=StorageTargetPayloadV1['entities'][number];
interface Install extends InstallationIdentity {provider:'fake'|'google'; enrichment:boolean; period_calls:number; period_budget_micros:string}
export interface AddressTarget { fieldId:string;recordId:string;companyId:string }
interface Job extends AddressTarget { installationId:string;revision:string;claim:string;releaseId:string;fence:string;outbox:string;attempts:number }
const key=(v:RequestRuntimeView,c:string)=>[v.tenantId,v.environmentId,c];
const denied=()=>new AddressProviderError('unconfigured');
const ident=(v:string)=>{if(!/^[a-z][a-z0-9_]{0,62}$/u.test(v)) throw denied();return '"'+v+'"';};
const isUuid=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(v);
const bindingFor=(view:RequestRuntimeView,id:string)=>{
  const definition=AddressProjectionSchema.safeParse(view.projections.connector?.payload);
  const binding=definition.data?.bindings.find(b=>b.fieldId===id);
  if(!binding) throw denied();
  return binding;
};
async function active(client:PoolClient,view:RequestRuntimeView) {
  const pointer=await client.query('SELECT 1 FROM platform.active_release_pointers WHERE tenant_id=$1 AND environment_id=$2 AND release_id=$3 AND fence=$4 AND pointer_id=$5 FOR SHARE',[view.tenantId,view.environmentId,view.release.releaseId,view.pointer.fence,view.pointer.pointerId]);
  const epoch=await client.query('SELECT platform.lock_current_policy_epoch($1,$2) AS v',[view.tenantId,view.environmentId]);
  if(!pointer.rowCount || currentPolicyVersionOf(epoch.rows[0].v)!==view.entryPolicyVersion) throw denied();
}
async function installation(client:PoolClient,view:RequestRuntimeView,company:string):Promise<Install|null>{
  const installed=await client.query<Install>(`SELECT tenant_id AS "tenantId", environment_id AS "environmentId",
   company_id AS "companyId", installation_id AS "installationId", account, provider,enrichment,period_calls,period_budget_micros
   FROM platform.address_installations WHERE tenant_id=$1 AND environment_id=$2 AND company_id=$3 AND enabled FOR SHARE`,key(view,company));
  return installed.rows[0]??null;
}
async function reserve(client:PoolClient,i:Install) {
  const cost=i.provider==='google'?100000:0;
  if(cost>Number(i.period_budget_micros)) throw new AddressProviderError('quota');
  const r=await client.query(`INSERT INTO platform.address_quota(tenant_id,environment_id,company_id,installation_id,period,calls,reserved_micros)
    VALUES($1,$2,$3,$4,date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,1,$5)
    ON CONFLICT(tenant_id,environment_id,company_id,installation_id,period) DO UPDATE SET calls=address_quota.calls+1,
    reserved_micros=address_quota.reserved_micros+excluded.reserved_micros
    WHERE address_quota.calls<$6 AND address_quota.reserved_micros+excluded.reserved_micros<=$7 RETURNING calls`,
    [i.tenantId,i.environmentId,i.companyId,i.installationId,cost,i.period_calls,i.period_budget_micros]);
  if(!r.rowCount) throw new AddressProviderError('quota');
}
// The caller has validated and committed the governed record's new field revision
// within this same transaction. The deferred FK resolves when trust writes the outbox.
export async function enqueueAddress(client:PoolClient,view:RequestRuntimeView,company:string,entityId:string,recordId:string,fieldId:string,revision:string,outbox:string,installationId:string) {
  await client.query(`INSERT INTO platform.address_geocodes(tenant_id,environment_id,company_id,installation_id,outbox_id,field_id,entity_id,record_id,address_revision,principal_id,release_id,release_root,fence)
    SELECT tenant_id,environment_id,company_id,installation_id,$4,$5,$6,$7,$8,$9,$10,$11,$12 FROM platform.address_installations
    WHERE tenant_id=$1 AND environment_id=$2 AND company_id=$3 AND enabled AND enrichment AND installation_id=$13`,
    [...key(view,company),outbox,fieldId,entityId,recordId,revision,view.principalId,view.release.releaseId,view.release.contentHash,view.pointer.fence,installationId]);
}

export class PostgresAddresses implements AddressGateway {
  constructor(private readonly pool:Pool,private readonly queries:SemanticQueryGateway,
    private readonly release:(id:string)=>Promise<{policy:CurrentPolicyGateway;storage:StorageTargetPayloadV1|null}>|{policy:CurrentPolicyGateway;storage:StorageTargetPayloadV1|null},
    private readonly demo:boolean, private readonly providerFor:(i:Install)=>AddressProvider = i=>addressProvider(i,i.provider,demo,process.env.NORTH_STAR_GOOGLE_MAPS_TERMS==='non-eea')){}
  private tx<T>(view:RequestRuntimeView,work:(client:PoolClient)=>Promise<T>) {
    return withTrustedRequestTransaction(this.pool,trustedContextForRequestRuntimeView(view),work);
  }
  async installations(view:RequestRuntimeView){
    return this.tx(view,async c=>(await c.query<AddressInstallation>(`SELECT company_id AS "companyId", installation_id AS "installationId", account,provider,enrichment
      FROM platform.address_installations WHERE tenant_id=$1 AND environment_id=$2 AND enabled ORDER BY account,company_id`,[view.tenantId,view.environmentId])).rows);
  }
  async configure(view:RequestRuntimeView,company:string,options:{provider:'fake'|'google';account:string;enrichment:boolean;calls:number;budgetMicros:number;enabled:boolean}) {
    if (!this.demo || !isUuid(company) || !['fake','google'].includes(options.provider) || !/^[\w.-]{1,120}$/u.test(options.account) ||
      !Number.isSafeInteger(options.calls)||!Number.isSafeInteger(options.budgetMicros)) throw denied();
    const {policy}=await this.release(view.release.releaseId);
    await issueLegalEntityReadScope(policy,view,[company]);
    return this.tx(view,async c=>{
      await active(c,view);
      const before=await installation(c,view,company);
      const same=before?.provider===options.provider && before.account===options.account;
      let id=before?.installationId;
      let change:'rotated'|'enabled'|'paused'='paused';
      if(before && (!same || !options.enabled)) await c.query('UPDATE platform.address_installations SET enabled=false WHERE tenant_id=$1 AND environment_id=$2 AND company_id=$3 AND enabled',key(view,company));
      if(options.enabled && same){
        await c.query('UPDATE platform.address_installations SET enrichment=$4,period_calls=$5,period_budget_micros=$6 WHERE tenant_id=$1 AND environment_id=$2 AND company_id=$3 AND enabled',[...key(view,company),options.enrichment,options.calls,options.budgetMicros]);
        change='rotated';
      }else if(options.enabled){
        id=randomUUID();
        await c.query('INSERT INTO platform.address_installations(tenant_id,environment_id,company_id,installation_id,account,provider,enabled,enrichment,period_calls,period_budget_micros) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9)',[...key(view,company),id,options.account,options.provider,options.enrichment,options.calls,options.budgetMicros]);
        change='enabled';
      }
      if(id) await c.query('INSERT INTO platform.address_installation_history(tenant_id,environment_id,company_id,installation_id,principal_id,change) VALUES($1,$2,$3,$4,$5,$6)',[...key(view,company),id,view.principalId,change]);
      return id;
    });
  }
  private async authorize(view:RequestRuntimeView,t:AddressTarget,editing:boolean) {
    if(!isUuid(t.companyId)||(!isUuid(t.recordId) && !(editing && t.recordId===''))) throw denied();
    const binding=bindingFor(view,t.fieldId);
    const {policy,storage}=await this.release(view.release.releaseId);
    const entity=storage?.entities.find(e=>e.entityId===binding.entityId);
    if(!entity) throw denied();
    await issueLegalEntityReadScope(policy,view,[t.companyId]);
    const q=registeredQueryFromPinnedView(view,binding.recordQueryId);
    if(!q || q.sourceEntityId!==entity.entityId) throw denied();
    const scope=q.legalEntityScope;
    if(t.recordId) {
    const result=await this.queries.invoke(view,{schemaVersion:SEMANTIC_QUERY_REQUEST_VERSION,queryId:q.queryId,
      arguments:{recordId:t.recordId,...(scope&&{[scope.operand.parameterId]:scope.cardinality==='exactlyOne'?t.companyId:[t.companyId]})}});
    const record=result.records[0];
    if(result.outcome!=='exact'||!record||record.archived||record.recordId!==t.recordId) throw denied();
    }
    if(editing){
      const op=parsePinnedOperationCatalog(view.projections.operation.payload).find(op=>binding.editOperationIds.includes(op.operationId)&&op.effect.kind===(t.recordId?'updateRecordEffect':'createRecordEffect'));
      if(!op) throw denied();
      for(const permission of [OPERATION_BOUNDARY_PERMISSION_ID,op.permissionId]){
        const decision=await authorizeCurrentPolicy(policy,view,permission,{kind:'registeredSemanticOperationPolicyInput',schemaVersion:'northstar.semantic-operation-policy-input/v1',requestId:view.requestId,operationId:op.operationId,input:{legalEntityId:t.companyId,recordId:t.recordId}});
        if(decision.decision!=='ALLOW'||decision.policyVersion!==view.entryPolicyVersion) throw denied();
      }
    }
    return {binding,entity};
  }
  // Lock the physical row from the pinned storage descriptor. An old response
  // cannot race a committed edit or carry a shared record's pin across companies.
  private async address(c:PoolClient,view:RequestRuntimeView,t:AddressTarget,entity:Entity) {
    const col=entity.columns.find(f=>f.canonicalFieldId===t.fieldId && f.fieldContract.fieldKind==='addressFieldType');
    if(!col)throw denied();
    const company=entity.legalEntity;
    const r=await withModuleRuntimeRole(c,()=>c.query(`SELECT ${ident(col.physicalName)} AS value FROM north_star_module.${ident(entity.physicalTableName)}
      WHERE tenant_id=$1 AND environment_id=$2 AND ${ident(entity.recordIdentity.column)}=$3 AND ${ident(entity.archive.archivedAtColumn)} IS NULL
      ${company?'AND '+ident(company.column)+'=$4':''} FOR SHARE`,[view.tenantId,view.environmentId,t.recordId,...(company?[t.companyId]:[])]));
    if(r.rows.length!==1) throw denied();
    return SavedAddressSchema.safeParse(r.rows[0].value).data;
  }
  async suggest(view:RequestRuntimeView,t:AddressTarget,queryId:string,text:string,session:string) {
    const {entity,binding}=await this.authorize(view,t,true);
    if(queryId!==binding.suggestQueryId||text.trim().length<3||text.length>512||!isUuid(session))throw denied();
    const i=await this.tx(view,async c=>{
      await active(c,view);if(t.recordId) await this.address(c,view,t,entity);
      const i=await installation(c,view,t.companyId);if(!i)throw denied();await reserve(c,i);return i;
    });
    const p=this.providerFor(i);
    return {suggestions:await p.suggest(text,session),attribution:p.attribution};
  }
  async pin(view:RequestRuntimeView,t:AddressTarget,queryId:string) {
    const {entity,binding}=await this.authorize(view,t,false);
    if(queryId!==binding.mapQueryId)throw denied();
    return this.tx(view,async c=>{
      await active(c,view);
      const address=await this.address(c,view,t,entity);
      if(!address) return {status:'absent'} as const;
      if(address.pin) return {status:'ready',pin:address.pin,attribution:'User pin'} as const;
      const i=await installation(c,view,t.companyId);
      if(!i) return {status:'unavailable'} as const;
      const r=await c.query(`SELECT state,latitude::text,longitude::text,expires_at>clock_timestamp() AS usable
        FROM platform.address_geocodes WHERE tenant_id=$1 AND environment_id=$2 AND company_id=$3 AND installation_id=$4 AND record_id=$5 AND field_id=$6 AND address_revision=$7 AND release_id=$8 AND fence=$9`,[...key(view,t.companyId),i.installationId,t.recordId,t.fieldId,address.revision,view.release.releaseId,view.pointer.fence]);
      const row=r.rows[0];
      if(row?.state==='ready'&&row.usable){
        const pin=CoordinatesSchema.parse({latitude:row.latitude,longitude:row.longitude});
        const p=this.providerFor(i);return {status:'ready',pin,attribution:p.attribution,image:p.staticMap(pin)} as const;
      }
      return {status:row&&['queued','working'].includes(row.state)?'locating':'unavailable'} as const;
    });
  }
  async workOne(view:RequestRuntimeView) {
    const job=await this.tx(view,async c=>{
      const claim=randomUUID();
      const r=await c.query<Job>(`WITH next AS (SELECT tenant_id,environment_id,company_id,installation_id,outbox_id,field_id FROM platform.address_geocodes
        WHERE tenant_id=$1 AND environment_id=$2 AND principal_id=$3 AND state IN ('queued','working') AND available_at<=clock_timestamp()
        ORDER BY available_at,outbox_id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE platform.address_geocodes g SET state='working',claim_id=$4,available_at=clock_timestamp()+interval '30 seconds'
        FROM next WHERE (g.tenant_id,g.environment_id,g.company_id,g.installation_id,g.outbox_id,g.field_id)=(next.tenant_id,next.environment_id,next.company_id,next.installation_id,next.outbox_id,next.field_id)
        RETURNING g.company_id AS "companyId",g.installation_id AS "installationId",g.address_revision AS revision,g.release_id AS "releaseId",g.fence,g.record_id AS "recordId",g.field_id AS "fieldId",g.outbox_id AS outbox,g.attempts,g.claim_id AS claim`,[view.tenantId,view.environmentId,view.principalId,claim]);return r.rows[0];
    });
    if(!job)return false;
    const jobKey=[...key(view,job.companyId),job.installationId,job.outbox,job.fieldId,job.claim];
    const condition='tenant_id=$1 AND environment_id=$2 AND company_id=$3 AND installation_id=$4 AND outbox_id=$5 AND field_id=$6 AND claim_id=$7';
    try {
      if(view.release.releaseId!==job.releaseId||view.pointer.fence!==Number(job.fence)||job.attempts>=4)throw denied();
      const {entity}=await this.authorize(view,job,true);
      const checked=async(c:PoolClient)=>{
        await active(c,view);const i=await installation(c,view,job.companyId);
        const address=await this.address(c,view,job,entity);
        if(i?.installationId!==job.installationId||!i.enrichment||address?.revision!==job.revision||address.pin)throw denied();
        return {i,address};
      };
      const {i,address}=await this.tx(view,async c=>{
        const checkedResult=await checked(c);
        const attempt=await c.query('UPDATE platform.address_geocodes SET attempts=attempts+1 WHERE '+condition+' AND attempts<4 RETURNING attempts',jobKey);
        if(!attempt.rowCount)throw denied();await reserve(c,checkedResult.i);return checkedResult;
      });
      const p=this.providerFor(i);
      const pin=await p.geocode(address.text,address.place?.namespace===(p.name==='google'?'google.places':'demo.places')?address.place.id:undefined);
      await this.authorize(view,job,true);
      await this.tx(view,async c=>{await checked(c);
        await c.query("UPDATE platform.address_geocodes SET state='ready',claim_id=NULL,reason=NULL,latitude=$8,longitude=$9,precision=$10,expires_at=created_at+interval '30 days' WHERE "+condition,[...jobKey,pin.latitude,pin.longitude,pin.precision]);
      });
    } catch(error){
      const reason=error instanceof AddressProviderError?error.reason:'unavailable';
      const retry=['unavailable','quota'].includes(reason)&&job.attempts<3;
      await this.tx(view,c=>c.query(`UPDATE platform.address_geocodes SET state=$8,reason=$9,claim_id=NULL,attempts=greatest(attempts,$10::smallint),available_at=clock_timestamp()+$11::integer*interval '1 second' WHERE `+condition,[...jobKey,retry?'queued':reason==='unconfigured'?'held':'failed',reason,Math.min(job.attempts+1,4),[5,30,120,120][Math.min(job.attempts,3)]]));
    }
    return true;
  }
}
