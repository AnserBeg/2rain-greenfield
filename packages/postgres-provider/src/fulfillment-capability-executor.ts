import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import {
  assertNoDeliveredOrder,
  assertStockRoutes,
} from './drop-ship-support.js';
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
  FULFILLMENT_CAPABILITY_ID,
  FULFILLMENT_CAPABILITY_VERSION,
  fulfillmentBinding,
  fulfillmentColumn,
  fulfillmentError,
  fulfillmentOption,
  fulfillmentRelation,
  fulfillmentTable,
  quoteFulfillmentIdentifier as q,
  type FulfillmentBinding,
  type ShipmentCommand,
} from './fulfillment.js';
import {
  executeFulfillmentLifecycle,
  type PreparedFulfillmentTarget,
} from './fulfillment-lifecycle.js';
import {
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  PostgresInventoryPostingService,
} from './inventory-posting-service.js';
import { withModuleRuntimeRole } from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';

interface PreparedFulfillment extends PreparedFulfillmentTarget {
  readonly request: RegisteredCapabilityOperationAuthorizationRequest;
}

class FulfillmentCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = FULFILLMENT_CAPABILITY_ID;
  readonly #binding: FulfillmentBinding;
  readonly #posting: PostgresInventoryPostingService;
  readonly #prepared = new WeakMap<object, PreparedFulfillment>();

  constructor(
    private readonly context: PostgresCapabilityOperationExecutorContext,
    storage: StorageTargetPayloadV1,
    storageContentHash: string,
  ) {
    const binding = fulfillmentBinding(storage);
    if (!binding)
      throw fulfillmentError(
        'INVENTORY_POSTING_STORAGE_INVALID',
        'Fulfillment storage is absent',
      );
    this.#binding = binding;
    this.#posting = new PostgresInventoryPostingService(
      context.pool,
      {
        capabilityId: FULFILLMENT_CAPABILITY_ID,
        capabilityVersion: FULFILLMENT_CAPABILITY_VERSION,
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
    const operation = request.definition.operationId;
    const entity =
      operation.endsWith(':operation.reservation_reserve') ||
      operation.endsWith(':operation.reservation_release')
        ? binding.reservation
        : operation.endsWith(':operation.shipment_post')
          ? binding.shipment
          : operation.endsWith(':operation.sales_order_close') ||
              operation.endsWith(':operation.sales_order_cancel')
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
    )
      throw fulfillmentError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Fulfillment requires its registered target, exact scope and record revision',
      );
    const inputRecord = input as Record<string, unknown>;
    const recordId = inputRecord.recordId as string;
    const expectedRevision = inputRecord.expectedRevision as number;
    const target = await withTrustedRequestTransaction(
      this.context.pool,
      request.context,
      async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        return withModuleRuntimeRole(client, async () => {
          const result = await client.query<Record<string, unknown>>(
            `SELECT * FROM ${fulfillmentTable(entity)}
              WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3
                AND archived_at IS NULL`,
            [request.context.tenantId, request.context.environmentId, recordId],
          );
          if (result.rows.length !== 1)
            throw fulfillmentError(
              'INVENTORY_POSTING_INPUT_INVALID',
              'Fulfillment target is missing or archived',
            );
          return result.rows[0]!;
        });
      },
    );
    const legalEntityId = String(target[entity.legalEntity!.column]);
    const currentRevision = Number(target.revision);
    // Lifecycle commands defer their exact revision check until the
    // idempotency transaction knows whether this is a fresh command or a
    // matching committed replay. A replay may legitimately arrive after
    // shipment consequences have advanced the target several revisions; it
    // still passes current policy and scope authorization above, then the
    // stored receipt binds principal, release, action and input digest. Fresh
    // commands remain exact in `assertCurrent`.
    if (
      operation.endsWith(':operation.shipment_post') &&
      currentRevision !== expectedRevision &&
      currentRevision !== expectedRevision + 1
    )
      throw fulfillmentError(
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
        'Fulfillment target revision is no longer current',
      );
    const itemId =
      entity === binding.reservation
        ? String(
            target[
              fulfillmentColumn(binding.reservation, 'reservation_item_id')
            ],
          )
        : null;
    const locationId =
      entity === binding.reservation
        ? String(
            target[
              fulfillmentColumn(binding.reservation, 'reservation_location_id')
            ],
          )
        : null;
    const authorization = Object.freeze({
      decisionInput: Object.freeze({ legalEntityId }),
      legalEntityReadScopeIds: Object.freeze([legalEntityId]),
      readBackArguments: Object.freeze({
        [scope.operand.parameterId]: legalEntityId,
        recordId,
      }),
    });
    this.#prepared.set(
      authorization,
      Object.freeze({
        request,
        legalEntityId,
        currentRevision,
        recordId,
        expectedRevision,
        itemId,
        locationId,
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
    )
      throw fulfillmentError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Fulfillment authorization is not bound to this execution',
      );
    const operation = request.definition.operationId;
    if (operation.endsWith(':operation.reservation_reserve')) {
      await withTrustedRequestTransaction(
        this.context.pool,
        request.context,
        (client) =>
          withModuleRuntimeRole(client, async () => {
            const row = await client.query<Record<string, unknown>>(
              `SELECT * FROM ${fulfillmentTable(this.#binding.reservation)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL`,
              [
                request.context.tenantId,
                request.context.environmentId,
                prepared.recordId,
              ],
            );
            await assertStockRoutes(
              client,
              this.#binding.target,
              { ...request.context, legalEntityId: prepared.legalEntityId },
              'sales',
              row.rows.map((row) =>
                String(
                  row[
                    fulfillmentRelation(
                      this.#binding,
                      this.#binding.reservation,
                      'reservation_order_line',
                    )
                  ],
                ),
              ),
            );
          }),
      );
      return executeFulfillmentLifecycle(
        this.context,
        this.#binding,
        request,
        prepared,
        'reserve',
      );
    }
    if (operation.endsWith(':operation.reservation_release'))
      return executeFulfillmentLifecycle(
        this.context,
        this.#binding,
        request,
        prepared,
        'release',
      );
    if (operation.endsWith(':operation.sales_order_close'))
      return executeFulfillmentLifecycle(
        this.context,
        this.#binding,
        request,
        prepared,
        'close',
      );
    if (operation.endsWith(':operation.sales_order_cancel')) {
      await withTrustedRequestTransaction(
        this.context.pool,
        request.context,
        (client) =>
          withModuleRuntimeRole(client, () =>
            assertNoDeliveredOrder(
              client,
              this.#binding.target,
              { ...request.context, legalEntityId: prepared.legalEntityId },
              'sales',
              prepared.recordId,
            ),
          ),
      );
      return executeFulfillmentLifecycle(
        this.context,
        this.#binding,
        request,
        prepared,
        'cancel',
      );
    }
    if (!operation.endsWith(':operation.shipment_post'))
      throw fulfillmentError(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Only named fulfillment operations are admitted by this route',
      );
    const command = await this.#shipmentCommand(request, prepared);
    const result = await this.#posting.postShipment(
      request.context,
      await this.context.actorIssuer.issue(request.context),
      command,
    );
    let record: SemanticOperationResultEnvelope['readBack'] = null;
    try {
      const readBack = await this.context.queryGateway.invoke(request.view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: request.readBackDefinition.queryId,
        arguments: request.authorization.readBackArguments,
      });
      record =
        readBack.records.find(
          (candidate) => candidate.recordId === prepared.recordId,
        ) ?? null;
      if (readBack.outcome !== 'exact' || !record)
        throw fulfillmentError(
          'INVENTORY_POSTING_STORAGE_REJECTED',
          'Posted shipment did not read back exactly',
        );
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    }
    return {
      kind: 'semanticOperationResult',
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      operationId: operation,
      outcome: 'succeeded',
      readBack: record,
      trust: result.trust,
      unsupportedReason: null,
    };
  }

  async #shipmentCommand(
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: PreparedFulfillment,
  ): Promise<ShipmentCommand> {
    const binding = this.#binding;
    return withTrustedRequestTransaction(
      this.context.pool,
      request.context,
      (client) =>
        withModuleRuntimeRole(client, async () => {
          const headerResult = await client.query<Record<string, unknown>>(
            `SELECT * FROM ${fulfillmentTable(binding.shipment)}
              WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3
                AND archived_at IS NULL`,
            [
              request.context.tenantId,
              request.context.environmentId,
              prepared.recordId,
            ],
          );
          const header = headerResult.rows[0];
          if (!header || headerResult.rows.length !== 1)
            throw fulfillmentError(
              'FULFILLMENT_SHIPMENT_INVALID',
              'Shipment is missing or archived',
            );
          const field = (name: string) =>
            header[fulfillmentColumn(binding.shipment, `shipment_${name}`)];
          const kind = (['initial', 'correction', 'reversal'] as const).find(
            (candidate) =>
              field('kind') ===
              fulfillmentOption(binding.shipment, 'shipment_kind', candidate),
          );
          if (!kind)
            throw fulfillmentError(
              'FULFILLMENT_SHIPMENT_INVALID',
              'Shipment kind is unsupported',
            );
          const legalEntityId = String(
            header[binding.shipment.legalEntity!.column],
          );
          if (
            legalEntityId !== prepared.legalEntityId ||
            Number(header.revision) !== prepared.currentRevision
          )
            throw fulfillmentError(
              'INVENTORY_TRANSACTION_STATE_CONFLICT',
              'Shipment scope or revision changed after authorization',
            );
          const rows = await client.query<Record<string, unknown>>(
            `SELECT * FROM ${fulfillmentTable(binding.shipmentLine)}
              WHERE tenant_id=$1 AND environment_id=$2
                AND ${q(binding.shipmentLine.legalEntity!.column)}=$3
                AND ${q(fulfillmentRelation(binding, binding.shipmentLine, 'shipment_line_shipment'))}=$4
                AND archived_at IS NULL ORDER BY record_id`,
            [
              request.context.tenantId,
              request.context.environmentId,
              legalEntityId,
              prepared.recordId,
            ],
          );
          const effectiveAt = field('effective_at');
          await assertStockRoutes(
            client,
            binding.target,
            { ...request.context, legalEntityId },
            'sales',
            rows.rows.map((row) =>
              String(
                row[
                  fulfillmentRelation(
                    binding,
                    binding.shipmentLine,
                    'shipment_line_order_line',
                  )
                ],
              ),
            ),
          );
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
            sourceId: prepared.recordId,
            sourceRevision: prepared.expectedRevision,
            sourceType: 'shipment',
            stockDimensionSetVersion: 'v1',
            kind,
            shipmentNumber: String(field('number')),
            locationId: String(field('location_id')),
            orderId: String(
              header[
                fulfillmentRelation(binding, binding.shipment, 'shipment_order')
              ],
            ),
            supersedesShipmentId: header[
              fulfillmentRelation(
                binding,
                binding.shipment,
                'shipment_supersedes',
              )
            ] as string | null,
            reason: {
              code: String(field('reason_code')),
              narrative: field('reason_narrative') as string | null,
            },
            lines: rows.rows.map((row) => {
              const value = (name: string) =>
                row[
                  fulfillmentColumn(
                    binding.shipmentLine,
                    `shipment_line_${name}`,
                  )
                ];
              const quantity = String(value('quantity'));
              return {
                shipmentLineId: String(row.record_id),
                orderLineId: String(
                  row[
                    fulfillmentRelation(
                      binding,
                      binding.shipmentLine,
                      'shipment_line_order_line',
                    )
                  ],
                ),
                reservationId: String(
                  row[
                    fulfillmentRelation(
                      binding,
                      binding.shipmentLine,
                      'shipment_line_reservation',
                    )
                  ],
                ),
                sourceLine: String(value('line_number')),
                itemId: String(value('item_id')),
                unitId: String(value('unit_id')),
                quantityDelta: kind === 'initial' ? `-${quantity}` : quantity,
                reversalOfMovementId: value('reversal_of_movement_id') as
                  string | null,
              };
            }),
          };
        }),
    );
  }
}

export const FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY = Object.freeze({
  capabilityId: FULFILLMENT_CAPABILITY_ID,
  verificationRefusal: {
    code: 'INVENTORY_POSTING_INPUT_INVALID',
    reason:
      'INVENTORY_POSTING_INPUT_INVALID: Only named fulfillment operations are admitted by this route',
  },
  create(context) {
    const projection = context.projection(PROJECTION_FAMILY_IDS.storageTarget);
    const storage = projection.payload as StorageTargetPayloadV1;
    if (storage.kind !== 'storageTargetPayload')
      throw fulfillmentError(
        'INVENTORY_POSTING_STORAGE_INVALID',
        'Expected active storage target',
      );
    return new FulfillmentCapabilityExecutor(
      context,
      storage,
      projection.contentHash,
    );
  },
} satisfies PostgresCapabilityOperationExecutorFactory);
