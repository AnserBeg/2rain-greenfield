import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  type RegisteredCapabilityOperationAuthorization,
  type RegisteredCapabilityOperationAuthorizationRequest,
  type RegisteredCapabilityOperationExecutionRequest,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationResultEnvelope,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
} from '../../runtime/src/semantic-query-gateway.js';
import type {
  PostgresCapabilityOperationExecutorContext,
  PostgresCapabilityOperationExecutorFactory,
} from './capability-operation-executor-factory.js';
import {
  RECEIVING_CAPABILITY_ID,
  RECEIVING_CAPABILITY_VERSION,
  receiptBinding,
  receiptColumn,
  receiptError,
  receiptOption,
  receiptRelation,
  receiptTable,
  quoteReceiptIdentifier as q,
  type GoodsReceiptCommand,
  type ReceiptBinding,
} from './goods-receipt.js';
import {
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  PostgresInventoryPostingService,
} from './inventory-posting-service.js';
import { withModuleRuntimeRole } from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { executeReceivingOrderState } from './receiving-order-capability.js';
import { assertStockRoutes } from './drop-ship-support.js';

interface PreparedReceiving {
  readonly request: RegisteredCapabilityOperationAuthorizationRequest;
  readonly legalEntityId: string;
  readonly currentRevision: number;
  readonly recordId: string;
  readonly expectedRevision: number;
}

class ReceivingCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = RECEIVING_CAPABILITY_ID;
  readonly #binding: ReceiptBinding;
  readonly #posting: PostgresInventoryPostingService;
  readonly #prepared = new WeakMap<object, PreparedReceiving>();
  constructor(
    private readonly context: PostgresCapabilityOperationExecutorContext,
    storage: StorageTargetPayloadV1,
    storageContentHash: string,
  ) {
    const binding = receiptBinding(storage);
    if (!binding)
      throw receiptError(
        'INVENTORY_POSTING_STORAGE_INVALID',
        'Receiving storage is absent',
      );
    this.#binding = binding;
    this.#posting = new PostgresInventoryPostingService(
      context.pool,
      {
        capabilityId: RECEIVING_CAPABILITY_ID,
        capabilityVersion: RECEIVING_CAPABILITY_VERSION,
        dependencySetRoot: INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
        releaseContentHash: context.releaseContentHash,
        releaseId: context.releaseId,
        storageTarget: storage,
        storageTargetContentHash: storageContentHash,
      },
      { currentInstant: context.currentInstant },
    );
  }
  async prepareAuthorization(
    request: RegisteredCapabilityOperationAuthorizationRequest,
  ): Promise<RegisteredCapabilityOperationAuthorization> {
    const binding = this.#binding;
    const entity =
      request.definition.operationId ===
      `${binding.receipt.entityId.split(':')[0]}:operation.goods_receipt_post`
        ? binding.receipt
        : request.definition.operationId ===
            `${binding.orderLine.entityId.split(':')[0]}:operation.purchase_order_line_amend`
          ? binding.orderLine
          : ['close', 'reopen', 'cancel'].some(
                (action) =>
                  request.definition.operationId ===
                  `${binding.order.entityId.split(':')[0]}:operation.purchase_order_${action}`,
              )
            ? binding.order
            : null;
    const input = request.input;
    const scope = request.readBackDefinition.legalEntityScope;
    if (
      !entity ||
      request.definition.effect.capability.targetId !== this.capabilityId ||
      request.readBackDefinition.sourceEntityId !== entity.entityId ||
      !scope ||
      scope.cardinality !== 'exactlyOne' ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !('recordId' in input) ||
      !('expectedRevision' in input) ||
      typeof input.recordId !== 'string' ||
      typeof input.expectedRevision !== 'number' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      Object.keys(input).some(
        (key) => !['recordId', 'expectedRevision'].includes(key),
      )
    ) {
      throw receiptError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Receiving requires its registered target, exact scope and record revision',
      );
    }
    const { recordId, expectedRevision } = input;
    // Trusted SELECT-only preparation resolves scope from persisted facts, never
    // from a caller assertion. The mutation transaction still owns all locks,
    // revision/state checks, quantity guards and idempotency decisions.
    const target = await withTrustedRequestTransaction(
      this.context.pool,
      request.context,
      async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        return withModuleRuntimeRole(client, async () => {
          const result = await client.query<{
            legal_entity_id: string;
            revision: number;
          }>(
            `SELECT ${q(entity.legalEntity!.column)} AS legal_entity_id, revision FROM ${receiptTable(entity)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL`,
            [request.context.tenantId, request.context.environmentId, recordId],
          );
          if (result.rows.length !== 1)
            throw receiptError(
              'INVENTORY_POSTING_INPUT_INVALID',
              'Receiving target is missing or archived',
            );
          return result.rows[0]!;
        });
      },
    );
    const currentRevision = Number(target.revision);
    if (
      currentRevision !== expectedRevision &&
      currentRevision !== expectedRevision + 1
    ) {
      throw receiptError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Receiving target revision is no longer current',
      );
    }
    const authorization = Object.freeze({
      decisionInput: Object.freeze({ legalEntityId: target.legal_entity_id }),
      legalEntityReadScopeIds: Object.freeze([target.legal_entity_id]),
      readBackArguments: Object.freeze({
        [scope.operand.parameterId]: target.legal_entity_id,
        recordId,
      }),
    });
    this.#prepared.set(
      authorization,
      Object.freeze({
        request,
        legalEntityId: target.legal_entity_id,
        currentRevision,
        recordId,
        expectedRevision,
      }),
    );
    return authorization;
  }

  async execute(
    request: RegisteredCapabilityOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    const prepared = this.#prepared.get(request.authorization);
    this.#prepared.delete(request.authorization);
    if (
      !prepared ||
      prepared.request.definition !== request.definition ||
      prepared.request.inputDigest !== request.inputDigest ||
      prepared.request.input !== request.input ||
      prepared.request.context !== request.context ||
      prepared.request.readBackDefinition !== request.readBackDefinition ||
      prepared.request.view !== request.view
    ) {
      throw receiptError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Receiving authorization is not bound to this execution',
      );
    }
    if (
      request.definition.operationId.endsWith(
        ':operation.purchase_order_line_amend',
      )
    )
      return executeReceivingOrderState(
        this.context,
        this.#binding,
        request,
        'amend',
        prepared.legalEntityId,
      );
    if (
      request.definition.operationId.endsWith(':operation.purchase_order_close')
    )
      return executeReceivingOrderState(
        this.context,
        this.#binding,
        request,
        'close',
        prepared.legalEntityId,
      );
    if (
      request.definition.operationId.endsWith(
        ':operation.purchase_order_reopen',
      )
    )
      return executeReceivingOrderState(
        this.context,
        this.#binding,
        request,
        'reopen',
        prepared.legalEntityId,
      );
    // A released order is cancelled here rather than by a generic transition,
    // so its receipts can refuse the cancel (PURCHASING-PARITY).
    if (
      request.definition.operationId.endsWith(
        ':operation.purchase_order_cancel',
      )
    )
      return executeReceivingOrderState(
        this.context,
        this.#binding,
        request,
        'cancel',
        prepared.legalEntityId,
      );
    if (
      !request.definition.operationId.endsWith(
        ':operation.goods_receipt_post',
      ) ||
      request.readBackDefinition.sourceEntityId !==
        this.#binding.receipt.entityId
    ) {
      throw receiptError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Only receipt posting is admitted by this route',
      );
    }
    const input = request.input as Record<string, unknown>;
    if (
      typeof input.recordId !== 'string' ||
      typeof input.expectedRevision !== 'number' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      Object.keys(input).some(
        (key) => !['recordId', 'expectedRevision'].includes(key),
      )
    ) {
      throw receiptError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Receipt posting requires recordId and expectedRevision',
      );
    }
    const recordId = input.recordId,
      revision = input.expectedRevision;
    const binding = this.#binding;
    const command = await withTrustedRequestTransaction(
      this.context.pool,
      request.context,
      (client) =>
        withModuleRuntimeRole(
          client,
          async (): Promise<GoodsReceiptCommand> => {
            const headerResult = await client.query(
              `SELECT * FROM ${receiptTable(binding.receipt)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL`,
              [
                request.context.tenantId,
                request.context.environmentId,
                recordId,
              ],
            );
            const header = headerResult.rows[0] as
              Record<string, unknown> | undefined;
            if (!header || headerResult.rows.length !== 1)
              throw receiptError(
                'INVENTORY_POSTING_INPUT_INVALID',
                'Receipt is missing or outside the current scope',
              );
            const field = (name: string) =>
              header[receiptColumn(binding.receipt, `goods_receipt_${name}`)];
            const kind = (['initial', 'correction', 'reversal'] as const).find(
              (candidate) =>
                field('kind') ===
                receiptOption(binding.receipt, 'goods_receipt_kind', candidate),
            );
            if (!kind)
              throw receiptError(
                'INVENTORY_POSTING_INPUT_INVALID',
                'Receipt kind is not supported',
              );
            const legalEntityId = String(
              header[binding.receipt.legalEntity!.column],
            );
            if (
              legalEntityId !== prepared.legalEntityId ||
              Number(header.revision) !== prepared.currentRevision
            ) {
              throw receiptError(
                'INVENTORY_POSTING_INPUT_INVALID',
                'Receipt scope or revision changed after authorization preparation',
              );
            }
            const rows = await client.query(
              `SELECT * FROM ${receiptTable(binding.line)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(binding.line.legalEntity!.column)}=$3 AND ${q(receiptRelation(binding, binding.line, 'goods_receipt_line_receipt'))}=$4 AND archived_at IS NULL ORDER BY record_id`,
              [
                request.context.tenantId,
                request.context.environmentId,
                legalEntityId,
                recordId,
              ],
            );
            const effectiveAt = field('effective_at');
            await assertStockRoutes(client, binding.target, { ...request.context, legalEntityId }, 'purchase', rows.rows.map((row: Record<string, unknown>) => String(row[receiptRelation(binding, binding.line, 'goods_receipt_line_order_line')])));
            return {
              authorization: {
                decision: 'ALLOW',
                evaluatorVersion: request.policyEvaluatorVersion,
                policyVersion: request.policyVersion,
              },
              channel: request.channel,
              idempotencyKey: request.idempotencyKey,
              effectiveAt: (effectiveAt instanceof Date
                ? effectiveAt
                : new Date(String(effectiveAt))
              ).toISOString(),
              legalEntityId,
              sourceId: recordId,
              sourceRevision: revision,
              sourceType: 'goodsReceipt',
              stockDimensionSetVersion: 'v1',
              kind,
              receiptNumber: String(field('number')),
              locationId: String(field('location_id')),
              orderId: String(
                header[
                  receiptRelation(
                    binding,
                    binding.receipt,
                    'goods_receipt_order',
                  )
                ],
              ),
              supersedesReceiptId: header[
                receiptRelation(
                  binding,
                  binding.receipt,
                  'goods_receipt_supersedes',
                )
              ] as string | null,
              reason: {
                code: String(field('reason_code')),
                narrative: field('reason_narrative') as string | null,
              },
              lines: rows.rows.map((row: Record<string, unknown>) => {
                const value = (name: string) =>
                  row[
                    receiptColumn(binding.line, `goods_receipt_line_${name}`)
                  ];
                const costStatus = (['known', 'absent'] as const).find(
                  (candidate) =>
                    value('cost_status') ===
                    receiptOption(
                      binding.line,
                      'goods_receipt_line_cost_status',
                      candidate,
                    ),
                );
                if (!costStatus)
                  throw receiptError(
                    'RECEIPT_COST_REQUIRED',
                    'Select actual cost or explicitly absent cost',
                  );
                return {
                  receiptLineId: String(row.record_id),
                  orderLineId: String(
                    row[
                      receiptRelation(
                        binding,
                        binding.line,
                        'goods_receipt_line_order_line',
                      )
                    ],
                  ),
                  sourceLine: String(value('line_number')),
                  itemId: String(value('item_id')),
                  unitId: String(value('unit_id')),
                  quantityDelta: String(value('quantity')),
                  costStatus,
                  unitCost: value('unit_cost') as string | null,
                  currency: value('currency') as string | null,
                  reversalOfMovementId: value('reversal_of_movement_id') as
                    string | null,
                };
              }),
            };
          },
        ),
    );
    const result = await this.#posting.postGoodsReceipt(
      request.context,
      await this.context.actorIssuer.issue(request.context),
      command,
    );
    const scope = request.readBackDefinition.legalEntityScope;
    if (!scope || scope.cardinality !== 'exactlyOne')
      throw receiptError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Receipt read-back requires exact legal entity scope',
      );
    let record: SemanticOperationResultEnvelope['readBack'] = null;
    try {
      const readBack = await this.context.queryGateway.invoke(request.view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: request.readBackDefinition.queryId,
        arguments: request.authorization.readBackArguments,
      });
      record =
        readBack.records.find((candidate) => candidate.recordId === recordId) ??
        null;
      if (readBack.outcome !== 'exact' || !record)
        throw receiptError(
          'INVENTORY_POSTING_INPUT_INVALID',
          'Posted receipt did not read back exactly',
        );
    } catch (error) {
      // Only a typed, current-policy read denial after the committed kernel
      // result withholds data. Other failures must not be disguised as success.
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    }
    return {
      kind: 'semanticOperationResult',
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: record,
      trust: {
        changeDocumentId: result.trust.changeDocumentId,
        domainEventId: result.trust.domainEventId,
        invocationId: result.trust.invocationId,
        outboxId: result.trust.outboxId,
      },
      unsupportedReason: null,
    };
  }
}
export const RECEIVING_CAPABILITY_EXECUTOR_FACTORY = Object.freeze({
  capabilityId: RECEIVING_CAPABILITY_ID,
  verificationRefusal: {
    code: 'INVENTORY_POSTING_INPUT_INVALID',
    reason:
      'INVENTORY_POSTING_INPUT_INVALID: Only receipt posting is admitted by this route',
  },
  create(context) {
    const projection = context.projection(PROJECTION_FAMILY_IDS.storageTarget);
    const storage = projection.payload as StorageTargetPayloadV1;
    if (storage.kind !== 'storageTargetPayload')
      throw receiptError(
        'INVENTORY_POSTING_STORAGE_INVALID',
        'Expected active storage target',
      );
    return new ReceivingCapabilityExecutor(
      context,
      storage,
      projection.contentHash,
    );
  },
} satisfies PostgresCapabilityOperationExecutorFactory);
