import { randomUUID } from 'node:crypto';
import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import {
  BILLING_TERMS_CAPABILITY,
  BillingListAssignmentSchema,
} from '../../canonical-model/src/billing.js';
import { canonicalize } from '../../canonical-model/src/canonicalize.js';
import {
  compileRatePlan,
  publishRateTable,
  digest as contentDigest,
} from '../../domain/src/billing/terms.js';
import { POLICY_DECISION_EVIDENCE_VERSION } from '../../platform-runtime/src/trust/contracts.js';
import {
  type RegisteredCapabilityOperationExecutor,
  SEMANTIC_OPERATION_RESULT_VERSION,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SemanticQueryPolicyDeniedError,
  SEMANTIC_QUERY_REQUEST_VERSION,
} from '../../runtime/src/semantic-query-gateway.js';
import type {
  PostgresCapabilityOperationExecutorFactory,
  PostgresCapabilityOperationExecutorContext,
} from './capability-operation-executor-factory.js';
import { billingPlansIn } from './billing-quote.js';
import {
  fulfillmentTable,
  quoteFulfillmentIdentifier as identifier,
} from './fulfillment.js';
import {
  withModuleRuntimeRole,
  auditFieldId,
} from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';

const refuse = () =>
  Object.assign(
    new Error('Billing requires a bound price proposal and its exact revision'),
    { code: 'BILLING_TERMS_INVALID' },
  );
function termsExecutor(
  ctx: PostgresCapabilityOperationExecutorContext,
): RegisteredCapabilityOperationExecutor {
  const plans = billingPlansIn(
    ctx.projection(PROJECTION_FAMILY_IDS.surfaceManifest).payload,
  );
  const storage = ctx.projection(PROJECTION_FAMILY_IDS.storageTarget)
    .payload as StorageTargetPayloadV1;
  const bind = (op: string, read: string, entityId: string) => {
    const plan = plans.find(
      (p) =>
        p.bindings &&
        [
          p.bindings.publishOperationId,
          p.bindings.overrideOperationId,
          p.bindings.assignmentOperationId,
        ].includes(op),
    );
    const entity = storage.entities.find((e) => e.entityId === entityId);
    if (
      !plan?.bindings ||
      plan.bindings.termsQueryId !== read ||
      !entity?.legalEntity
    )
      throw refuse();
    return {
      plan,
      b: plan.bindings,
      entity,
      scopeColumn: identifier(entity.legalEntity.column),
    };
  };
  const replays = new WeakSet<object>();
  return {
    capabilityId: BILLING_TERMS_CAPABILITY,
    async prepareAuthorization(r) {
      const i = r.input,
        q = r.readBackDefinition;
      if (
        !i ||
        typeof i !== 'object' ||
        !('recordId' in i) ||
        typeof i.recordId !== 'string' ||
        !('expectedRevision' in i) ||
        !Number.isSafeInteger(i.expectedRevision) ||
        Object.keys(i).length !== 2 ||
        q.queryType !== 'get' ||
        q.legalEntityScope?.cardinality !== 'exactlyOne'
      )
        throw refuse();
      const { entity, scopeColumn } = bind(
        r.definition.operationId,
        q.queryId,
        q.sourceEntityId,
      );
      const scope = await withTrustedRequestTransaction(
        ctx.pool,
        r.context,
        async (client) => {
          const receipt = await client.query<{ company: string }>(
            `
          SELECT i.metadata->'companyId'->>'value' AS company FROM platform.semantic_operation_receipts r
          JOIN platform.trust_action_invocations i USING(tenant_id,environment_id,invocation_id)
          WHERE (r.tenant_id,r.environment_id,r.action_id,r.idempotency_key,r.principal_id,r.input_digest)=($1,$2,$3,$4,$5,$6)`,
            [
              r.context.tenantId,
              r.context.environmentId,
              r.definition.operationId,
              r.idempotencyKey,
              r.context.principalId,
              r.inputDigest,
            ],
          );
          if (receipt.rows[0])
            return { company: receipt.rows[0].company, replay: true };
          const result = await withModuleRuntimeRole(client, () =>
            client.query<{ company: string }>(
              `SELECT ${scopeColumn} AS company FROM ${fulfillmentTable(entity)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL`,
              [r.context.tenantId, r.context.environmentId, i.recordId],
            ),
          );
          return { company: result.rows[0]?.company, replay: false };
        },
      );
      const company = scope.company;
      if (!company) throw refuse();
      const authorization = {
        decisionInput: { legalEntityId: company },
        legalEntityReadScopeIds: [company],
        readBackArguments: {
          recordId: i.recordId,
          [q.legalEntityScope.operand.parameterId]: company,
        },
      };
      if (scope.replay) replays.add(authorization);
      return authorization;
    },
    async execute(r) {
      const { plan, b, entity, scopeColumn } = bind(
        r.definition.operationId,
        r.readBackDefinition.queryId,
        r.readBackDefinition.sourceEntityId,
      );
      const company = r.authorization.legalEntityReadScopeIds[0],
        i = r.input;
      if (
        !company ||
        !i ||
        typeof i !== 'object' ||
        !('recordId' in i) ||
        typeof i.recordId !== 'string' ||
        !('expectedRevision' in i)
      )
        throw refuse();
      const recordId = i.recordId;
      const read = replays.has(r.authorization)
        ? null
        : await ctx.queryGateway.invoke(r.view, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: b.termsQueryId,
            arguments: r.authorization.readBackArguments,
          });
      const trust = await new PostgresTrustService(
        ctx.pool,
      ).executeIdempotentAcceptedMutation(
        r.context,
        await ctx.actorIssuer.issue(r.context),
        {
          actionId: r.definition.operationId,
          idempotencyKey: r.idempotencyKey,
          inputDigest: r.inputDigest,
          releaseContentHash: r.view.release.contentHash,
          releaseId: r.view.release.releaseId,
        },
        async (client) => {
          const proposal = read?.records[0];
          if (
            read?.outcome !== 'exact' ||
            read.records.length !== 1 ||
            proposal?.recordId !== recordId ||
            proposal.archived ||
            proposal.revision !== i.expectedRevision
          )
            throw refuse();
          const text = proposal.values[b.termsFieldId];
          if (typeof text !== 'string' || Buffer.byteLength(text) > 131072)
            throw refuse();
          const compiled = compileRatePlan(plan);
          const planDigest = compiled.digest;
          const input: unknown = JSON.parse(text);
          const scope = [r.context.tenantId, r.context.environmentId];
          const pointer = await client.query(
            'SELECT 1 FROM platform.active_release_pointers WHERE tenant_id=$1 AND environment_id=$2 AND pointer_id=$3 AND release_id=$4 AND fence=$5 FOR SHARE',
            [
              ...scope,
              r.view.pointer.pointerId,
              r.view.release.releaseId,
              r.view.pointer.fence,
            ],
          );
          if (pointer.rowCount !== 1) throw refuse();
          const locked = await withModuleRuntimeRole(client, () =>
            client.query(
              `SELECT 1 FROM ${fulfillmentTable(entity)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND ${scopeColumn}=$4 AND revision=$5 AND archived_at IS NULL FOR SHARE`,
              [...scope, recordId, company, proposal.revision],
            ),
          );
          if (locked.rowCount !== 1) throw refuse();
          const body =
            r.definition.operationId === b.assignmentOperationId
              ? BillingListAssignmentSchema.parse(input)
              : publishRateTable(compiled.plan, input).table;
          if (
            'selector' in body &&
            (r.definition.operationId === b.publishOperationId) !==
              (body.selector.kind === 'base')
          )
            throw refuse();
          const digest = contentDigest(body);
          const metadata = {
            tableDigest: { classification: 'INTERNAL' as const, value: digest },
            companyId: { classification: 'INTERNAL' as const, value: company },
          };
          return {
            mutationResult: { recordId, planDigest },
            afterReceipt: async (transaction) => {
              await transaction.query(
                'SELECT platform.billing_publish($1,$2,$3,$4)',
                [
                  r.definition.operationId,
                  r.idempotencyKey,
                  canonicalize(body),
                  canonicalize(compiled.plan),
                ],
              );
            },
            command: {
              actionId: r.definition.operationId,
              causationId: null,
              channel: r.channel,
              correlationId: randomUUID(),
              invocationId: randomUUID(),
              metadata,
              releaseContentHash: r.view.release.contentHash,
              releaseId: r.view.release.releaseId,
              policy: {
                decision: 'ALLOW' as const,
                evaluatorVersion: r.policyEvaluatorVersion,
                policyVersion: r.policyVersion,
                relevantInputs: metadata,
                schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
              },
              change: {
                changeDocumentId: randomUUID(),
                recordId,
                recordType: entity.entityId,
                revision: proposal.revision,
                changes: [
                  {
                    classification: 'INTERNAL' as const,
                    fieldId: auditFieldId('billing_rate_table_digest'),
                    oldState: { state: 'ABSENT' as const },
                    newState: { state: 'VALUE' as const, value: digest },
                  },
                ],
              },
              event: {
                eventId: randomUUID(),
                eventSchemaVersion: 'northstar.billing-rate-event/v1',
                eventType:
                  r.definition.operationId === b.assignmentOperationId
                    ? 'northstar.billing:event.list_assigned'
                    : 'northstar.billing:event.rate_table_published',
                payload: metadata,
              },
              outbox: {
                outboxId: randomUUID(),
                deduplicationKey:
                  r.definition.operationId +
                  ':' +
                  r.context.principalId +
                  ':' +
                  r.idempotencyKey,
              },
            },
          };
        },
      );
      let readBack = null;
      try {
        const current = await ctx.queryGateway.invoke(r.view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: b.termsQueryId,
          arguments: r.authorization.readBackArguments,
        });
        if (current.outcome === 'exact') {
          readBack =
            current.records.find((row) => row.recordId === recordId) ?? null;
        }
      } catch (error) {
        if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
      }
      return {
        kind: 'semanticOperationResult',
        schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
        operationId: r.definition.operationId,
        outcome: 'succeeded',
        readBack,
        trust: {
          changeDocumentId: trust.changeDocumentId,
          domainEventId: trust.domainEventId,
          invocationId: trust.invocationId,
          outboxId: trust.outboxId,
        },
        unsupportedReason: null,
      };
    },
  };
}
export const BILLING_TERMS_FACTORY: PostgresCapabilityOperationExecutorFactory =
  Object.freeze({
    capabilityId: BILLING_TERMS_CAPABILITY,
    verificationRefusal: {
      code: 'BILLING_TERMS_INVALID',
      reason: 'Billing requires a bound price proposal and its exact revision',
    },
    create: termsExecutor,
  });
