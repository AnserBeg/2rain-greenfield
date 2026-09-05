import { randomUUID } from 'node:crypto';
import type {
  RegisteredCapabilityOperationExecutionRequest,
  SemanticOperationResultEnvelope,
} from '../../runtime/src/semantic-operation-gateway.js';
import { SEMANTIC_OPERATION_RESULT_VERSION } from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
} from '../../runtime/src/semantic-query-gateway.js';
import { POLICY_DECISION_EVIDENCE_VERSION } from '../../platform-runtime/src/trust/contracts.js';
import type { PostgresCapabilityOperationExecutorContext } from './capability-operation-executor-factory.js';
import {
  receiptError,
  receiptColumn,
  receiptRelation,
  quoteReceiptIdentifier as q,
  receiptTable,
  type ReceiptBinding,
} from './goods-receipt.js';
import {
  amendOrderedQuantity,
  changePurchaseOrderState,
} from './purchasing-order-lifecycle.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';
import {
  auditFieldId,
  withModuleRuntimeRole,
} from './module-runtime-interpreter.js';

export async function executeReceivingOrderState(
  context: PostgresCapabilityOperationExecutorContext,
  binding: ReceiptBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  action: 'close' | 'reopen' | 'amend',
  authorizedLegalEntityId: string,
): Promise<SemanticOperationResultEnvelope> {
  const entity = action === 'amend' ? binding.orderLine : binding.order;
  const input = request.input as Record<string, unknown>;
  if (
    request.readBackDefinition.sourceEntityId !== entity.entityId ||
    typeof input.recordId !== 'string' ||
    typeof input.expectedRevision !== 'number' ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    Object.keys(input).some(
      (key) => !['recordId', 'expectedRevision'].includes(key),
    )
  )
    throw receiptError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'Order transition requires its record and revision',
    );
  const recordId = input.recordId,
    expectedRevision = input.expectedRevision;
  const trust = await new PostgresTrustService(
    context.pool,
  ).executeIdempotentAcceptedMutation(
    request.context,
    await context.actorIssuer.issue(request.context),
    {
      actionId: request.definition.operationId,
      idempotencyKey: request.idempotencyKey,
      inputDigest: request.inputDigest,
      releaseContentHash: request.view.release.contentHash,
      releaseId: request.view.release.releaseId,
    },
    (client) =>
      withModuleRuntimeRole(client, async () => {
        const lookup = await client.query(
          `SELECT legal_entity_id FROM ${receiptTable(entity)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL`,
          [request.context.tenantId, request.context.environmentId, recordId],
        );
        if (lookup.rows.length !== 1)
          throw receiptError(
            'INVENTORY_POSTING_INPUT_INVALID',
            'Order is missing or outside the requested scope',
          );
        const legalEntityId = String(lookup.rows[0]!.legal_entity_id);
        if (legalEntityId !== authorizedLegalEntityId)
          throw receiptError(
            'INVENTORY_POSTING_INPUT_INVALID',
            'Order scope changed after authorization preparation',
          );
        let amendmentId: string | null = null;
        const changed =
          action === 'amend'
            ? await (async () => {
                const proposal = binding.target.entities.find(
                  (row) =>
                    row.entityId ===
                    entity.entityId.replace(
                      ':entity.purchase_order_line',
                      ':entity.purchase_order_amendment',
                    ),
                );
                if (!proposal)
                  throw receiptError(
                    'INVENTORY_POSTING_STORAGE_INVALID',
                    'Amendment intent storage is missing',
                  );
                const proposals = await client.query(
                  `SELECT * FROM ${receiptTable(proposal)} WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3 AND ${q(receiptRelation(binding, proposal, 'purchase_order_amendment_order_line'))}=$4 AND ${q(receiptColumn(proposal, 'purchase_order_amendment_line_revision'))}=$5 AND archived_at IS NULL ORDER BY record_id FOR NO KEY UPDATE`,
                  [
                    request.context.tenantId,
                    request.context.environmentId,
                    legalEntityId,
                    recordId,
                    expectedRevision,
                  ],
                );
                if (proposals.rows.length !== 1)
                  throw receiptError(
                    'INVENTORY_POSTING_INPUT_INVALID',
                    'Create exactly one active amendment request for this order line revision; archive competing requests',
                  );
                const candidate = proposals.rows[0]!;
                amendmentId = String(candidate.record_id);
                const result = await amendOrderedQuantity(
                  client,
                  binding,
                  request.context,
                  legalEntityId,
                  recordId,
                  expectedRevision,
                  String(
                    candidate[
                      receiptColumn(
                        proposal,
                        'purchase_order_amendment_quantity',
                      )
                    ],
                  ),
                );
                // The immutable trust event below identifies the consumed request. The
                // request remains persisted and restoring it cannot bypass line revision.
                const consumed = await client.query(
                  `UPDATE ${receiptTable(proposal)} SET archived_at=transaction_timestamp(),revision=revision+1 WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3 AND record_id=$4 RETURNING archived_at,revision`,
                  [
                    request.context.tenantId,
                    request.context.environmentId,
                    legalEntityId,
                    amendmentId,
                  ],
                );
                if (
                  consumed.rows.length !== 1 ||
                  consumed.rows[0]!.archived_at === null ||
                  Number(consumed.rows[0]!.revision) !==
                    Number(candidate.revision) + 1
                )
                  throw receiptError(
                    'RECEIPT_PROJECTION_DIVERGED',
                    'Amendment intent was not consumed',
                  );
                return result;
              })()
            : await changePurchaseOrderState(
                client,
                binding,
                request.context,
                legalEntityId,
                recordId,
                expectedRevision,
                action,
              );
        const metadata = {
          ...(amendmentId
            ? {
                amendmentRequestId: {
                  classification: 'INTERNAL' as const,
                  value: amendmentId,
                },
              }
            : {}),
          operationId: {
            classification: 'INTERNAL' as const,
            value: request.definition.operationId,
          },
        };
        return {
          mutationResult: { recordId, legalEntityId },
          command: {
            actionId: request.definition.operationId,
            causationId: null,
            channel: request.channel,
            correlationId: randomUUID(),
            invocationId: randomUUID(),
            metadata,
            releaseContentHash: request.view.release.contentHash,
            releaseId: request.view.release.releaseId,
            policy: {
              decision: 'ALLOW' as const,
              evaluatorVersion: request.policyEvaluatorVersion,
              policyVersion: request.policyVersion,
              relevantInputs: metadata,
              schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
            },
            change: {
              changeDocumentId: randomUUID(),
              recordId,
              recordType: entity.entityId,
              revision: changed.revision,
              changes: [
                {
                  classification: 'INTERNAL' as const,
                  fieldId: auditFieldId(changed.fieldId),
                  oldState: { state: 'VALUE' as const, value: changed.before },
                  newState: { state: 'VALUE' as const, value: changed.after },
                },
              ],
            },
            event: {
              eventId: randomUUID(),
              eventSchemaVersion: 'northstar.purchasing-order-event/v1',
              eventType: request.definition.operationId.replace(
                ':operation.',
                ':event.',
              ),
              payload: metadata,
            },
            outbox: {
              outboxId: randomUUID(),
              deduplicationKey: `${request.definition.operationId}:${request.context.principalId}:${request.idempotencyKey}`,
            },
          },
        };
      }),
  );
  const scope = request.readBackDefinition.legalEntityScope;
  if (!scope || scope.cardinality !== 'exactlyOne')
    throw receiptError(
      'INVENTORY_POSTING_INPUT_INVALID',
      'Order read-back requires exact scope',
    );
  let record: SemanticOperationResultEnvelope['readBack'] = null;
  try {
    const result = await context.queryGateway.invoke(request.view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: request.readBackDefinition.queryId,
      arguments: request.authorization.readBackArguments,
    });
    record = result.records.find((row) => row.recordId === recordId) ?? null;
    if (result.outcome !== 'exact' || !record)
      throw receiptError(
        'RECEIPT_PROJECTION_DIVERGED',
        'Order did not read back after its transition',
      );
  } catch (error) {
    if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
  }
  return {
    kind: 'semanticOperationResult',
    schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
    operationId: request.definition.operationId,
    outcome: 'succeeded',
    readBack: record,
    trust: {
      changeDocumentId: trust.changeDocumentId,
      domainEventId: trust.domainEventId,
      invocationId: trust.invocationId,
      outboxId: trust.outboxId,
    },
    unsupportedReason: null,
  };
}
