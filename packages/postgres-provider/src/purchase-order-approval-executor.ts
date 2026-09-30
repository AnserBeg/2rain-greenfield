import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import { PO_APPROVAL_CAPABILITY_ID } from '../../domain/src/purchasing/approvals.js';
import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  type RegisteredCapabilityOperationAuthorizationRequest as AuthorizationRequest,
  type RegisteredCapabilityOperationAuthorization,
  type RegisteredCapabilityOperationExecutionRequest as ExecutionRequest,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationResultEnvelope,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
} from '../../runtime/src/semantic-query-gateway.js';
import { POLICY_DECISION_EVIDENCE_VERSION } from '../../platform-runtime/src/trust/contracts.js';
import type {
  PostgresCapabilityOperationExecutorContext,
  PostgresCapabilityOperationExecutorFactory,
} from './capability-operation-executor-factory.js';
import {
  receiptBinding,
  receiptColumn,
  receiptRelation,
  receiptTable,
  receiptRow,
  receiptError,
  quoteReceiptIdentifier as q,
  type ReceiptBinding,
} from './goods-receipt.js';
import { amendOrderedQuantity } from './purchasing-order-lifecycle.js';
import {
  auditFieldId,
  withModuleRuntimeRole,
} from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';
import { purchaseOrderRevisionDigest } from './purchase-order-approval.js';

type Entity = StorageTargetPayloadV1['entities'][number];
type Row = Record<string, unknown>;
type Action = 'submit' | 'release' | 'amend' | 'approve' | 'reject';
interface Prepared {
  request: AuthorizationRequest;
  action: Action;
  entity: Entity;
  recordId: string;
  orderId: string;
  legalEntityId: string;
  expectedRevision: number;
}

function invalid(message: string): never {
  throw receiptError('INVENTORY_POSTING_INPUT_INVALID', message);
}
function conflict(message: string): never {
  throw receiptError('INVENTORY_TRANSACTION_STATE_CONFLICT', message);
}

export function purchaseOrderApprovalInput(
  value: unknown,
  action: Action,
): Record<string, unknown> & { recordId: string; expectedRevision: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Purchase-order approval input must be an object');
  const input = value as Record<string, unknown>;
  if (
    typeof input.recordId !== 'string' ||
    typeof input.expectedRevision !== 'number' ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    Object.keys(input).some(
      (key) => !['recordId', 'expectedRevision', 'arguments'].includes(key),
    )
  )
    invalid('Purchase-order approval requires an exact record and revision');
  const args = input.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args))
    invalid('Capability arguments must be an object');
  const allowed =
    action === 'release'
      ? ['supplierReference']
      : action === 'amend'
        ? ['quantity', 'reason']
        : action === 'approve' || action === 'reject'
          ? ['reason']
          : [];
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    invalid('Unsupported purchase-order approval argument');
  const parsed = {
    ...args,
    recordId: input.recordId,
    expectedRevision: input.expectedRevision,
  } as Record<string, unknown> & { recordId: string; expectedRevision: number };
  if (
    action === 'approve' ||
    action === 'reject' ||
    (action === 'amend' && 'quantity' in parsed)
  ) {
    if (
      typeof parsed.reason !== 'string' ||
      !parsed.reason.trim() ||
      parsed.reason.length > 1000
    )
      invalid('A reason of 1-1000 characters is required');
  }
  if (
    action === 'release' &&
    parsed.supplierReference !== undefined &&
    parsed.supplierReference !== null &&
    (typeof parsed.supplierReference !== 'string' ||
      parsed.supplierReference.length > 80)
  )
    invalid('Supplier reference must be at most 80 characters');
  if (
    action === 'amend' &&
    'quantity' in parsed &&
    (typeof parsed.quantity !== 'string' ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u.test(parsed.quantity))
  )
    invalid('Ordered quantity must be a non-negative exact decimal');
  return parsed;
}

class PurchaseOrderApprovalExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = PO_APPROVAL_CAPABILITY_ID;
  readonly #prepared = new WeakMap<object, Prepared>();
  readonly #binding: ReceiptBinding;
  readonly #approval: Entity;
  readonly #settings: Entity;
  readonly #amendment: Entity;
  constructor(
    private readonly context: PostgresCapabilityOperationExecutorContext,
    target: StorageTargetPayloadV1,
  ) {
    const binding = receiptBinding(target);
    if (!binding) invalid('Purchase-order receiving storage is missing');
    this.#binding = binding;
    const entity = (name: string) => {
      const matches = target.entities.filter((e) =>
        e.entityId.endsWith(`:entity.${name}`),
      );
      if (matches.length !== 1) invalid(`Missing ${name} storage`);
      return matches[0]!;
    };
    this.#approval = entity('purchase_order_approval');
    this.#settings = entity('purchasing_settings');
    this.#amendment = entity('purchase_order_amendment');
  }
  #field(entity: Entity, name: string) {
    return receiptColumn(
      entity,
      `${entity.entityId.split(':entity.')[1]}_${name}`,
    );
  }
  #state(state: string) {
    return `${this.#approval.entityId.split(':')[0]}:option.purchase_order_approval_state_${state}`;
  }
  async prepareAuthorization(
    request: AuthorizationRequest,
  ): Promise<RegisteredCapabilityOperationAuthorization> {
    const local = request.definition.operationId.split(':operation.')[1];
    const actions: Record<string, Action> = {
      purchase_order_submit: 'submit',
      purchase_order_release: 'release',
      purchase_order_line_amend: 'amend',
      purchase_order_approval_approve: 'approve',
      purchase_order_approval_reject: 'reject',
    };
    const action = actions[local ?? ''];
    const entity =
      action === 'amend'
        ? this.#binding.orderLine
        : action === 'approve' || action === 'reject'
          ? this.#approval
          : this.#binding.order;
    if (
      !action ||
      request.definition.effect.capability.targetId !== this.capabilityId ||
      request.readBackDefinition.sourceEntityId !== entity.entityId ||
      !request.readBackDefinition.legalEntityScope
    )
      invalid('Unsupported approval operation');
    const input = purchaseOrderApprovalInput(request.input, action);
    const row = await withTrustedRequestTransaction(
      this.context.pool,
      request.context,
      async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        return withModuleRuntimeRole(client, async () => {
          const result = await client.query<Row>(
            `SELECT * FROM ${receiptTable(entity)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL`,
            [
              request.context.tenantId,
              request.context.environmentId,
              input.recordId,
            ],
          );
          if (result.rows.length !== 1)
            invalid('Approval target is missing or archived');
          return result.rows[0]!;
        });
      },
    );
    const recordId = input.recordId,
      legalEntityId = String(row[entity.legalEntity!.column]);
    const orderId =
      entity === this.#binding.order
        ? recordId
        : String(
            row[
              receiptRelation(
                this.#binding,
                entity,
                entity === this.#approval
                  ? 'purchase_order_approval_order'
                  : 'purchase_order_line_order',
              )
            ],
          );
    const authorization = Object.freeze({
      decisionInput: Object.freeze({ legalEntityId }),
      legalEntityReadScopeIds: Object.freeze([legalEntityId]),
      readBackArguments: Object.freeze({
        recordId,
        [request.readBackDefinition.legalEntityScope.operand.parameterId]:
          legalEntityId,
      }),
    });
    this.#prepared.set(authorization, {
      request,
      action,
      entity,
      recordId,
      orderId,
      legalEntityId,
      expectedRevision: input.expectedRevision,
    });
    return authorization;
  }
  async #update(
    client: PoolClient,
    request: ExecutionRequest,
    entity: Entity,
    row: Row,
    values: Record<string, unknown>,
  ) {
    const entries = Object.entries(values);
    const updated = await client.query<Row>(
      `UPDATE ${receiptTable(entity)} SET ${entries.map(([name], i) => `${q(name)}=$${i + 5}`).join(',')},revision=revision+1 WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND revision=$4 RETURNING *`,
      [
        request.context.tenantId,
        request.context.environmentId,
        row.record_id,
        row.revision,
        ...entries.map(([, v]) => v),
      ],
    );
    if (updated.rows.length !== 1) conflict('Approval target changed');
    for (const [column, expected] of entries) {
      const observed = updated.rows[0]![column];
      if (
        (observed instanceof Date
          ? observed.toISOString()
          : String(observed)) !== String(expected)
      )
        conflict('Approval change failed read-back');
    }
    return updated.rows[0]!;
  }
  async #insert(
    client: PoolClient,
    request: ExecutionRequest,
    entity: Entity,
    legalEntityId: string,
    values: Record<string, unknown>,
  ) {
    const recordId = randomUUID(),
      entries = Object.entries(values);
    const result = await client.query<Row>(
      `INSERT INTO ${receiptTable(entity)} (tenant_id,environment_id,legal_entity_id,record_id,revision,${entries.map(([name]) => q(name)).join(',')}) VALUES ($1,$2,$3,$4,1,${entries.map((_, i) => `$${i + 5}`).join(',')}) RETURNING *`,
      [
        request.context.tenantId,
        request.context.environmentId,
        legalEntityId,
        recordId,
        ...entries.map(([, value]) => value),
      ],
    );
    if (result.rows.length !== 1) conflict('Approval request was not stored');
    return result.rows[0]!;
  }
  async #apply(client: PoolClient, request: ExecutionRequest, p: Prepared) {
    const b = this.#binding,
      input = purchaseOrderApprovalInput(request.input, p.action);
    // Same order -> sorted lines lock order as receiving. A decision never locks its request first.
    const order = await receiptRow(
      client,
      b.order,
      request.context,
      p.legalEntityId,
      p.orderId,
      true,
    );
    if (order.archived_at !== null) conflict('Purchase order was archived');
    const lines = await client.query<Row>(
      `SELECT * FROM ${receiptTable(b.orderLine)} WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3 AND ${q(receiptRelation(b, b.orderLine, 'purchase_order_line_order'))}=$4 AND archived_at IS NULL ORDER BY record_id FOR NO KEY UPDATE`,
      [
        request.context.tenantId,
        request.context.environmentId,
        p.legalEntityId,
        p.orderId,
      ],
    );
    const digest = purchaseOrderRevisionDigest(
      Number(order.revision),
      lines.rows.map((line) => ({
        recordId: String(line.record_id),
        revision: Number(line.revision),
      })),
    );
    const ns = b.order.entityId.split(':')[0]!,
      stateField = receiptColumn(
        b.order,
        'derived_state_field.machine.purchase_order_lifecycle',
      );
    const target =
      p.entity === b.order
        ? order
        : await receiptRow(
            client,
            p.entity,
            request.context,
            p.legalEntityId,
            p.recordId,
            true,
          );
    if (
      target.archived_at !== null ||
      Number(target.revision) !== p.expectedRevision
    )
      conflict('The requested revision changed');
    const settings = await client.query<Row>(
      `SELECT * FROM ${receiptTable(this.#settings)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(this.#field(this.#settings, 'key'))}=$3 AND archived_at IS NULL FOR SHARE`,
      [
        request.context.tenantId,
        request.context.environmentId,
        'purchase-orders',
      ],
    );
    const required = settings.rows.some(
      (row) => row[this.#field(this.#settings, 'require_approval')] === true,
    );
    const a = this.#approval,
      af = (name: string) => this.#field(a, name);
    const requests = await client.query<Row>(
      `SELECT * FROM ${receiptTable(a)} WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3 AND ${q(receiptRelation(b, a, 'purchase_order_approval_order'))}=$4 AND archived_at IS NULL ORDER BY record_id FOR NO KEY UPDATE`,
      [
        request.context.tenantId,
        request.context.environmentId,
        p.legalEntityId,
        p.orderId,
      ],
    );
    let approvalId: string | null = null;
    let after: Row = target;
    if (p.action === 'submit' || p.action === 'release') {
      if (order[stateField] !== `${ns}:state.purchase_order_draft`)
        conflict('Only a draft purchase order is submitted or placed');
      if (p.action === 'submit') {
        if (!required) invalid('Purchase orders do not require approval');
        if (
          requests.rows.some(
            (row) =>
              row[af('revision_digest')] === digest &&
              row[af('kind')] === 'order' &&
              [this.#state('pending'), this.#state('approved')].includes(
                String(row[af('state')]),
              ),
          )
        )
          conflict('This revision is already pending or approved');
        after = await this.#request(
          client,
          request,
          p,
          order,
          digest,
          'order',
          null,
          null,
        );
        approvalId = String(after.record_id);
      } else {
        const approved = requests.rows.find(
          (row) =>
            row[af('revision_digest')] === digest &&
            row[af('kind')] === 'order' &&
            row[af('state')] === this.#state('approved'),
        );
        if (required && !approved)
          conflict(
            'Place order requires approval of the current header and line revision',
          );
        after = await this.#update(client, request, b.order, order, {
          [stateField]: `${ns}:state.purchase_order_released`,
          [this.#field(b.order, 'supplier_reference')]:
            input.supplierReference ?? null,
        });
        if (approved) {
          approvalId = String(approved.record_id);
          await this.#update(client, request, a, approved, {
            [af('state')]: this.#state('consumed'),
          });
        }
      }
    } else if (p.action === 'amend') {
      if (order[stateField] !== `${ns}:state.purchase_order_released`)
        conflict('Reopen the order before requesting an amendment');
      if (
        requests.rows.some(
          (row) =>
            row[af('kind')] === 'amendment' &&
            row[af('state')] === this.#state('pending'),
        )
      )
        conflict('Decide the pending amendment before staging another');
      const proposal = this.#amendment,
        pf = (name: string) => this.#field(proposal, name);
      const proposals = await client.query<Row>(
        `SELECT * FROM ${receiptTable(proposal)} WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3 AND ${q(receiptRelation(b, proposal, 'purchase_order_amendment_order_line'))}=$4 AND ${q(pf('line_revision'))}=$5 AND archived_at IS NULL ORDER BY record_id FOR NO KEY UPDATE`,
        [
          request.context.tenantId,
          request.context.environmentId,
          p.legalEntityId,
          p.recordId,
          p.expectedRevision,
        ],
      );
      const closesOnly =
        proposals.rows.length > 0 &&
        proposals.rows.every((row) => row[pf('close_remainder')] === true);
      if (
        (proposals.rows.length > 1 && !closesOnly) ||
        ('quantity' in input && proposals.rows.length)
      )
        conflict('Archive competing staged amendment requests first');
      let staged = proposals.rows[0];
      if ('quantity' in input)
        staged = await this.#insert(
          client,
          request,
          proposal,
          p.legalEntityId,
          {
            [pf('number')]: randomUUID(),
            [pf('line_revision')]: String(p.expectedRevision),
            [pf('quantity')]: input.quantity,
            [pf('reason')]: input.reason,
            [pf('close_remainder')]: false,
            [receiptRelation(
              b,
              proposal,
              'purchase_order_amendment_order_line',
            )]: p.recordId,
          },
        );
      if (!staged) invalid('Stage an amendment request first');
      if (required) {
        after = await this.#request(
          client,
          request,
          p,
          order,
          digest,
          'amendment',
          String(staged.record_id),
          String(staged[pf('reason')]),
        );
        approvalId = String(after.record_id);
      } else {
        after = await this.#amend(client, request, p, staged);
      }
    } else {
      if (target[af('state')] !== this.#state('pending'))
        conflict('An approval request is decided only once');
      if (p.action === 'approve' && target[af('revision_digest')] !== digest)
        conflict('The purchase order changed; submit its current revision');
      approvalId = p.recordId;
      const amendmentId = target[af('amendment_id')];
      if (typeof amendmentId === 'string') {
        const staged = await receiptRow(
          client,
          this.#amendment,
          request.context,
          p.legalEntityId,
          amendmentId,
          true,
        );
        if (staged.archived_at !== null)
          conflict('The staged amendment was already consumed');
        if (p.action === 'approve')
          await this.#amend(client, request, p, staged);
        else
          await this.#update(client, request, this.#amendment, staged, {
            archived_at: this.context.currentInstant(),
          });
      }
      after = await this.#update(client, request, a, target, {
        [af('state')]: this.#state(
          p.action === 'approve'
            ? amendmentId
              ? 'consumed'
              : 'approved'
            : 'rejected',
        ),
        [af('decided_by')]: request.context.principalId,
        [af('decision_reason')]: input.reason,
      });
    }
    return {
      approvalId,
      entity: after.record_id === target.record_id ? p.entity : a,
      before: after.record_id === target.record_id ? target : null,
      after,
    };
  }
  async #request(
    client: PoolClient,
    request: ExecutionRequest,
    p: Prepared,
    order: Row,
    digest: string,
    kind: string,
    amendmentId: string | null,
    reason: string | null,
  ) {
    const a = this.#approval,
      f = (name: string) => this.#field(a, name);
    let orderedBeforeProposal: string | null = null,
      proposedQuantity: string | null = null;
    if (amendmentId) {
      const staged = await receiptRow(
        client,
        this.#amendment,
        request.context,
        p.legalEntityId,
        amendmentId,
      );
      const line = await receiptRow(
        client,
        this.#binding.orderLine,
        request.context,
        p.legalEntityId,
        p.recordId,
      );
      orderedBeforeProposal = String(
        line[this.#field(this.#binding.orderLine, 'ordered_quantity')],
      );
      proposedQuantity =
        staged[this.#field(this.#amendment, 'close_remainder')] === true
          ? 'Received quantity when approved'
          : String(staged[this.#field(this.#amendment, 'quantity')]);
    }
    return this.#insert(client, request, a, p.legalEntityId, {
      [f('number')]: randomUUID(),
      [f('order_number')]: order[this.#field(this.#binding.order, 'number')],
      [f('state')]: this.#state('pending'),
      [f('kind')]: kind,
      [f('revision_digest')]: digest,
      [f('requested_by')]: request.context.principalId,
      [f('decided_by')]: null,
      [f('reason')]: reason,
      [f('decision_reason')]: null,
      [f('amendment_id')]: amendmentId,
      [f('current_quantity')]: orderedBeforeProposal,
      [f('proposed_quantity')]: proposedQuantity,
      [receiptRelation(this.#binding, a, 'purchase_order_approval_order')]:
        p.orderId,
    });
  }
  async #amend(
    client: PoolClient,
    request: ExecutionRequest,
    p: Prepared,
    staged: Row,
  ) {
    const f = (name: string) => this.#field(this.#amendment, name);
    const lineId = String(
      staged[
        receiptRelation(
          this.#binding,
          this.#amendment,
          'purchase_order_amendment_order_line',
        )
      ],
    );
    await amendOrderedQuantity(
      client,
      this.#binding,
      request.context,
      p.legalEntityId,
      lineId,
      Number(staged[f('line_revision')]),
      staged[f('close_remainder')] === true
        ? 'received'
        : String(staged[f('quantity')]),
    );
    await this.#update(client, request, this.#amendment, staged, {
      archived_at: this.context.currentInstant(),
    });
    if (staged[f('close_remainder')] === true) {
      const others = await client.query<Row>(
        `SELECT * FROM ${receiptTable(this.#amendment)} WHERE tenant_id=$1 AND environment_id=$2 AND legal_entity_id=$3 AND ${q(receiptRelation(this.#binding, this.#amendment, 'purchase_order_amendment_order_line'))}=$4 AND ${q(f('line_revision'))}=$5 AND archived_at IS NULL ORDER BY record_id FOR NO KEY UPDATE`,
        [
          request.context.tenantId,
          request.context.environmentId,
          p.legalEntityId,
          lineId,
          staged[f('line_revision')],
        ],
      );
      if (others.rows.some((row) => row[f('close_remainder')] !== true))
        conflict('Competing amendment requests cannot be consumed together');
      for (const other of others.rows)
        await this.#update(client, request, this.#amendment, other, {
          archived_at: this.context.currentInstant(),
        });
    }
    return receiptRow(
      client,
      this.#binding.orderLine,
      request.context,
      p.legalEntityId,
      lineId,
    );
  }
  async execute(
    request: ExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    const p = this.#prepared.get(request.authorization);
    this.#prepared.delete(request.authorization);
    if (
      !p ||
      p.request.definition !== request.definition ||
      p.request.context !== request.context ||
      p.request.input !== request.input ||
      p.request.inputDigest !== request.inputDigest ||
      p.request.view !== request.view ||
      p.request.readBackDefinition !== request.readBackDefinition
    )
      invalid('Approval authorization is not bound to this execution');
    const trust = await new PostgresTrustService(
      this.context.pool,
    ).executeIdempotentAcceptedMutation(
      request.context,
      await this.context.actorIssuer.issue(request.context),
      {
        actionId: request.definition.operationId,
        idempotencyKey: request.idempotencyKey,
        inputDigest: request.inputDigest,
        releaseContentHash: request.view.release.contentHash,
        releaseId: request.view.release.releaseId,
      },
      (client) =>
        withModuleRuntimeRole(client, async () => {
          const changed = await this.#apply(client, request, p);
          const metadata = {
            operationId: {
              classification: 'INTERNAL' as const,
              value: request.definition.operationId,
            },
            orderId: { classification: 'INTERNAL' as const, value: p.orderId },
            approvalRequestId: {
              classification: 'INTERNAL' as const,
              value: changed.approvalId,
            },
          };
          return {
            mutationResult: { recordId: p.recordId },
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
                recordId: String(changed.after.record_id),
                recordType: changed.entity.entityId,
                revision: Number(changed.after.revision),
                changes: changed.entity.columns
                  .filter(
                    (column) =>
                      String(changed.before?.[column.physicalName] ?? null) !==
                      String(changed.after[column.physicalName] ?? null),
                  )
                  .map((column) => ({
                    classification: 'INTERNAL' as const,
                    fieldId: auditFieldId(column.canonicalFieldId),
                    oldState:
                      changed.before?.[column.physicalName] == null
                        ? { state: 'ABSENT' as const }
                        : {
                            state: 'VALUE' as const,
                            value: changed.before[column.physicalName] as
                              string | boolean,
                          },
                    newState:
                      changed.after[column.physicalName] == null
                        ? { state: 'ABSENT' as const }
                        : {
                            state: 'VALUE' as const,
                            value: changed.after[column.physicalName] as
                              string | boolean,
                          },
                  })),
              },
              event: {
                eventId: randomUUID(),
                eventSchemaVersion:
                  'northstar.purchase-order-approval-event/v1',
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
    let readBack: SemanticOperationResultEnvelope['readBack'] = null;
    try {
      const result = await this.context.queryGateway.invoke(request.view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: request.readBackDefinition.queryId,
        arguments: request.authorization.readBackArguments,
      });
      readBack =
        result.records.find((row) => row.recordId === p.recordId) ?? null;
      if (result.outcome !== 'exact' || !readBack)
        conflict('The approval target did not read back');
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    }
    return {
      kind: 'semanticOperationResult',
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      operationId: request.definition.operationId,
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
  }
}

export const PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY: PostgresCapabilityOperationExecutorFactory =
  Object.freeze({
    capabilityId: PO_APPROVAL_CAPABILITY_ID,
    verificationRefusal: {
      code: 'INVENTORY_POSTING_INPUT_INVALID',
      reason:
        'INVENTORY_POSTING_INPUT_INVALID: Only named purchase-order approval operations are admitted',
    },
    create(context: PostgresCapabilityOperationExecutorContext) {
      return new PurchaseOrderApprovalExecutor(
        context,
        context.projection(PROJECTION_FAMILY_IDS.storageTarget)
          .payload as StorageTargetPayloadV1,
      );
    },
  });
