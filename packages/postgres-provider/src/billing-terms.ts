import {randomUUID} from 'node:crypto';
import {PROJECTION_FAMILY_IDS,type StorageTargetPayloadV1} from '@north-star/compiler';
import {BILLING_TERMS_CAPABILITY,BillingListAssignmentSchema} from '../../canonical-model/src/billing.js';
import {canonicalize} from '../../canonical-model/src/canonicalize.js';
import {compileRatePlan,publishRateTable,digest as contentDigest} from '../../domain/src/billing/terms.js';
import {POLICY_DECISION_EVIDENCE_VERSION} from '../../platform-runtime/src/trust/contracts.js';
import {type RegisteredCapabilityOperationExecutor,SEMANTIC_OPERATION_RESULT_VERSION} from '../../runtime/src/semantic-operation-gateway.js';
import {SEMANTIC_QUERY_REQUEST_VERSION} from '../../runtime/src/semantic-query-gateway.js';
import type {PostgresCapabilityOperationExecutorFactory,PostgresCapabilityOperationExecutorContext} from './capability-operation-executor-factory.js';
import {billingPlansIn} from './billing-quote.js';
import {fulfillmentTable,quoteFulfillmentIdentifier as identifier} from './fulfillment.js';
import {withModuleRuntimeRole,auditFieldId} from './module-runtime-interpreter.js';
import {withTrustedRequestTransaction} from './request-context.js';
import {PostgresTrustService} from './trust/postgres-trust-service.js';

const refuse=()=>Object.assign(new Error('Billing requires a bound price proposal and its exact revision'),{code:'BILLING_TERMS_INVALID'});
function termsExecutor(ctx:PostgresCapabilityOperationExecutorContext):RegisteredCapabilityOperationExecutor {
 const plans=billingPlansIn(ctx.projection(PROJECTION_FAMILY_IDS.surfaceManifest).payload);
 const storage=ctx.projection(PROJECTION_FAMILY_IDS.storageTarget).payload as StorageTargetPayloadV1;
 const bind=(op:string,read:string,entityId:string)=>{
   const plan=plans.find(p=>p.bindings && [p.bindings.publishOperationId,p.bindings.overrideOperationId,p.bindings.assignmentOperationId].includes(op));
   const entity=storage.entities.find(e=>e.entityId===entityId);
   if(!plan?.bindings || plan.bindings.termsQueryId!==read || !entity?.legalEntity)throw refuse();
   return {plan,b:plan.bindings,entity,scopeColumn:identifier(entity.legalEntity.column)};
 };
 return {capabilityId:BILLING_TERMS_CAPABILITY,
   async prepareAuthorization(r){
     const i=r.input,q=r.readBackDefinition;
     if(!i || typeof i!=='object' || !('recordId' in i) || typeof i.recordId!=='string' || !('expectedRevision' in i) ||
       !Number.isSafeInteger(i.expectedRevision) || Object.keys(i).length!==2 ||
       q.queryType!=='get' || q.legalEntityScope?.cardinality!=='exactlyOne')throw refuse();
     const {entity,scopeColumn}=bind(r.definition.operationId,q.queryId,q.sourceEntityId);
     const result=await withTrustedRequestTransaction(ctx.pool,r.context,client=>withModuleRuntimeRole(client,()=>client.query<{company:string}>(
       `SELECT ${scopeColumn} AS company FROM ${fulfillmentTable(entity)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL`,[r.context.tenantId,r.context.environmentId,i.recordId]
     )));
     const company=result.rows[0]?.company;if(!company)throw refuse();
     return {decisionInput:{legalEntityId:company},legalEntityReadScopeIds:[company],readBackArguments:{recordId:i.recordId,[q.legalEntityScope.operand.parameterId]:company}};
   },
   async execute(r){
     const {plan,b,entity,scopeColumn}=bind(r.definition.operationId,r.readBackDefinition.queryId,r.readBackDefinition.sourceEntityId);
     const company=r.authorization.legalEntityReadScopeIds[0],i=r.input;
     if(!company || !i || typeof i!=='object' || !('recordId' in i) || typeof i.recordId!=='string' || !('expectedRevision' in i))throw refuse();
     const recordId=i.recordId;
     const read=await ctx.queryGateway.invoke(r.view,{schemaVersion:SEMANTIC_QUERY_REQUEST_VERSION,queryId:b.termsQueryId,arguments:r.authorization.readBackArguments});
     const proposal=read.records[0];
     if(read.outcome!=='exact' || read.records.length!==1 || proposal?.recordId!==recordId || proposal.archived)throw refuse();
     const trust=await new PostgresTrustService(ctx.pool).executeIdempotentAcceptedMutation(r.context,await ctx.actorIssuer.issue(r.context),{
       actionId:r.definition.operationId,idempotencyKey:r.idempotencyKey,inputDigest:r.inputDigest,releaseContentHash:r.view.release.contentHash,releaseId:r.view.release.releaseId,
     },async client=>{
       if(proposal.revision!==i.expectedRevision)throw refuse();
       const text=proposal.values[b.termsFieldId];
       if(typeof text!=='string' || Buffer.byteLength(text)>131072)throw refuse();
       const planDigest=compileRatePlan(plan).digest;
       const input:unknown=JSON.parse(text);
       const scope=[r.context.tenantId,r.context.environmentId];
       const pointer=await client.query('SELECT 1 FROM platform.active_release_pointers WHERE tenant_id=$1 AND environment_id=$2 AND pointer_id=$3 AND release_id=$4 AND fence=$5 FOR SHARE',[...scope,r.view.pointer.pointerId,r.view.release.releaseId,r.view.pointer.fence]);
       if(pointer.rowCount!==1)throw refuse();
       const locked=await withModuleRuntimeRole(client,()=>client.query(`SELECT 1 FROM ${fulfillmentTable(entity)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND ${scopeColumn}=$4 AND revision=$5 AND archived_at IS NULL FOR SHARE`,[...scope,recordId,company,proposal.revision]));
       if(locked.rowCount!==1)throw refuse();
       let stored, digest:string, body:unknown;
       if(r.definition.operationId===b.assignmentOperationId){
         const a=BillingListAssignmentSchema.parse(input);
         digest=contentDigest(a);body=a;
         const key=[...scope,company,planDigest,a.customerId,a.listId,a.revision];
         await client.query(`INSERT INTO platform.billing_list_assignments
           (tenant_id,environment_id,company_id,plan_digest,customer_id,list_id,revision_id,effective_from,content_digest,body,release_id,actor_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[...key,a.effectiveFrom,digest,JSON.stringify(a),r.view.release.releaseId,r.context.principalId]);
         stored=await client.query<{body:unknown;digest:string}>('SELECT body,content_digest AS digest FROM platform.billing_list_assignments WHERE tenant_id=$1 AND environment_id=$2 AND company_id=$3 AND plan_digest=$4 AND customer_id=$5 AND list_id=$6 AND revision_id=$7',key);
       } else {
         const published=publishRateTable(compileRatePlan(plan).plan,input),table=published.table;
         if((r.definition.operationId===b.publishOperationId)!==(table.selector.kind==='base'))throw refuse();
         digest=published.digest;body=table;
         const key=[...scope,company,table.planDigest,table.version];
         await client.query(`INSERT INTO platform.billing_rate_tables
          (tenant_id,environment_id,company_id,plan_digest,version_id,selector,effective_from,content_digest,body,release_id,actor_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[...key,JSON.stringify(table.selector),table.effectiveFrom,digest,JSON.stringify(table),r.view.release.releaseId,r.context.principalId]);
         stored=await client.query<{body:unknown;digest:string}>('SELECT body,content_digest AS digest FROM platform.billing_rate_tables WHERE tenant_id=$1 AND environment_id=$2 AND company_id=$3 AND plan_digest=$4 AND version_id=$5',key);
       }
       if(stored.rows.length!==1 || stored.rows[0]!.digest!==digest || canonicalize(stored.rows[0]!.body)!==canonicalize(body))throw refuse();
       const metadata={tableDigest:{classification:'INTERNAL' as const,value:digest},companyId:{classification:'INTERNAL' as const,value:company}};
       return {mutationResult:{recordId},command:{actionId:r.definition.operationId,causationId:null,channel:r.channel,correlationId:randomUUID(),invocationId:randomUUID(),metadata,releaseContentHash:r.view.release.contentHash,releaseId:r.view.release.releaseId,
         policy:{decision:'ALLOW' as const,evaluatorVersion:r.policyEvaluatorVersion,policyVersion:r.policyVersion,relevantInputs:metadata,schemaVersion:POLICY_DECISION_EVIDENCE_VERSION},
         change:{changeDocumentId:randomUUID(),recordId,recordType:entity.entityId,revision:proposal.revision,changes:[{classification:'INTERNAL' as const,fieldId:auditFieldId('billing_rate_table_digest'),oldState:{state:'ABSENT' as const},newState:{state:'VALUE' as const,value:digest}}]},
         event:{eventId:randomUUID(),eventSchemaVersion:'northstar.billing-rate-event/v1',eventType:r.definition.operationId===b.assignmentOperationId?'northstar.billing:event.list_assigned':'northstar.billing:event.rate_table_published',payload:metadata},outbox:{outboxId:randomUUID(),deduplicationKey:r.definition.operationId+':'+r.context.principalId+':'+r.idempotencyKey}}};
     });
     return {kind:'semanticOperationResult',schemaVersion:SEMANTIC_OPERATION_RESULT_VERSION,operationId:r.definition.operationId,outcome:'succeeded',readBack:proposal,trust:{changeDocumentId:trust.changeDocumentId,domainEventId:trust.domainEventId,invocationId:trust.invocationId,outboxId:trust.outboxId},unsupportedReason:null};
   }};
}
export const BILLING_TERMS_FACTORY:PostgresCapabilityOperationExecutorFactory=Object.freeze({
 capabilityId:BILLING_TERMS_CAPABILITY,verificationRefusal:{code:'BILLING_TERMS_INVALID',reason:'Billing requires a bound price proposal and its exact revision'},create:termsExecutor
});
