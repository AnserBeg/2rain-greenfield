import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import { DROP_SHIP_CAPABILITY_ID } from '../../domain/src/app/drop-ship.js';
import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_RESULT_VERSION,
  type RegisteredCapabilityOperationAuthorization,
  type RegisteredCapabilityOperationAuthorizationRequest,
  type RegisteredCapabilityOperationExecutionRequest,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationResultEnvelope,
  type RegisteredRecordOperationDefinition,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
} from '../../runtime/src/semantic-query-gateway.js';
import type { ImmutableJsonValue } from '../../runtime/src/request-runtime-view.js';
import { POLICY_DECISION_EVIDENCE_VERSION } from '../../platform-runtime/src/trust/contracts.js';
import type {
  PostgresCapabilityOperationExecutorContext,
  PostgresCapabilityOperationExecutorFactory,
} from './capability-operation-executor-factory.js';
import {
  assignDocumentNumbers,
  auditFieldId,
  insertRecord,
  parseMutationInput,
  withModuleRuntimeRole,
} from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';
import {
  assertDropShipSupplier,
  deliveredByLine,
  dropShipBound,
  dropShipColumn as column,
  dropShipEntity as entity,
  dropShipQuantity as quantity,
  dropShipQuantityText,
  dropShipQuote as q,
  dropShipRefused as refused,
  dropShipRelation as relation,
  dropShipTable as table,
  type DropShipEntity,
  type DropShipRow,
  type DropShipScope,
} from './drop-ship-support.js';

type Action =
  | 'sales_order_create_drop_ship_po'
  | 'purchase_order_record_delivery'
  | 'drop_ship_delivery_post'
  | 'drop_ship_delivery_reverse';
interface Prepared {
  request: RegisteredCapabilityOperationAuthorizationRequest;
  action: Action;
  entity: DropShipEntity;
  recordId: string;
  revision: number;
  scope: DropShipScope;
  arguments: Readonly<Record<string, ImmutableJsonValue>>;
}
type Changed = Readonly<{
  revision: number;
  before: string;
  after: string;
  linkedIds: readonly string[];
}>;
const actions = new Map<Action, string>([
  ['sales_order_create_drop_ship_po', 'sales_order'],
  ['purchase_order_record_delivery', 'purchase_order'],
  ['drop_ship_delivery_post', 'drop_ship_delivery'],
  ['drop_ship_delivery_reverse', 'drop_ship_delivery'],
]);
const isObject = (
  value: unknown,
): value is Record<string, ImmutableJsonValue> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

class DropShipExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = DROP_SHIP_CAPABILITY_ID;
  readonly #prepared = new WeakMap<object, Prepared>();
  constructor(
    private readonly context: PostgresCapabilityOperationExecutorContext,
    private readonly storage: StorageTargetPayloadV1,
  ) {}
  async prepareAuthorization(
    request: RegisteredCapabilityOperationAuthorizationRequest,
  ): Promise<RegisteredCapabilityOperationAuthorization> {
    const action = request.definition.operationId.split(
      ':operation.',
    )[1] as Action;
    const local = actions.get(action);
    const input = request.input;
    if (
      !local ||
      !isObject(input) ||
      typeof input.recordId !== 'string' ||
      typeof input.expectedRevision !== 'number' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      Object.keys(input).some(
        (key) => !['recordId', 'expectedRevision', 'arguments'].includes(key),
      ) ||
      request.definition.effect.capability.targetId !== this.capabilityId
    )
      refused('Invalid supplier delivery command');
    const arguments_ = input.arguments ?? {};
    if (!isObject(arguments_))
      refused('Supplier delivery arguments must be an object');
    const admitted =
      action === 'purchase_order_record_delivery'
        ? ['purchaseLineId', 'quantity', 'reference']
        : action === 'drop_ship_delivery_reverse'
          ? ['reason']
          : [];
    if (
      Object.keys(arguments_).some((key) => !admitted.includes(key)) ||
      Object.values(arguments_).some(
        (value) => value !== null && typeof value !== 'string',
      )
    )
      refused('Unknown or non-scalar supplier delivery argument');
    if (
      action === 'drop_ship_delivery_reverse' &&
      (typeof arguments_.reason !== 'string' ||
        !arguments_.reason.trim() ||
        arguments_.reason.length > 500)
    )
      refused('Reversal requires a reason (at most 500 characters)');
    if (
      action === 'purchase_order_record_delivery' &&
      (typeof arguments_.purchaseLineId !== 'string' ||
        typeof arguments_.quantity !== 'string' ||
        (arguments_.reference !== undefined &&
          arguments_.reference !== null &&
          (typeof arguments_.reference !== 'string' ||
            arguments_.reference.length > 120)))
    )
      refused(
        'Delivery requires a purchase line, quantity and optional supplier reference',
      );
    const target = entity(this.storage, local);
    if (
      request.readBackDefinition.sourceEntityId !== target.entityId ||
      request.readBackDefinition.legalEntityScope?.cardinality !== 'exactlyOne'
    )
      refused('Supplier delivery read-back must be company scoped');
    const row = await withTrustedRequestTransaction(
      this.context.pool,
      request.context,
      async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        return withModuleRuntimeRole(client, async () => {
          const found = await client.query<DropShipRow>(
            `SELECT * FROM ${table(target)} WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND archived_at IS NULL`,
            [
              request.context.tenantId,
              request.context.environmentId,
              input.recordId,
            ],
          );
          if (found.rows.length !== 1)
            refused('Supplier delivery target is missing or archived');
          return found.rows[0]!;
        });
      },
    );
    const legalEntityId = String(row[target.legalEntity!.column]);
    const authorization = Object.freeze({
      decisionInput: { legalEntityId },
      legalEntityReadScopeIds: [legalEntityId],
      readBackArguments: {
        recordId: input.recordId,
        [request.readBackDefinition.legalEntityScope!.operand.parameterId]:
          legalEntityId,
      },
    });
    this.#prepared.set(authorization, {
      request,
      action,
      entity: target,
      recordId: input.recordId,
      revision: input.expectedRevision,
      scope: {
        tenantId: request.context.tenantId,
        environmentId: request.context.environmentId,
        legalEntityId,
      },
      arguments: arguments_,
    });
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
      prepared.request.context !== request.context ||
      prepared.request.view !== request.view ||
      prepared.request.input !== request.input ||
      prepared.request.inputDigest !== request.inputDigest ||
      prepared.request.readBackDefinition !== request.readBackDefinition
    )
      refused('Supplier delivery authorization is not bound to execution');
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
          const changed = await this.#apply(client, prepared);
          const metadata = {
            legalEntityId: {
              classification: 'INTERNAL' as const,
              value: prepared.scope.legalEntityId,
            },
            operationId: {
              classification: 'INTERNAL' as const,
              value: request.definition.operationId,
            },
            linkedIds: {
              classification: 'INTERNAL' as const,
              value: [...changed.linkedIds],
            },
          };
          return {
            mutationResult: {
              recordId: prepared.recordId,
              revision: changed.revision,
            },
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
                recordId: prepared.recordId,
                recordType: prepared.entity.entityId,
                revision: changed.revision,
                changes: [
                  {
                    classification: 'INTERNAL' as const,
                    fieldId: auditFieldId(
                      `${prepared.entity.entityId}.drop_ship`,
                    ),
                    oldState: {
                      state: 'VALUE' as const,
                      value: changed.before,
                    },
                    newState: { state: 'VALUE' as const, value: changed.after },
                  },
                ],
              },
              event: {
                eventId: randomUUID(),
                eventSchemaVersion: 'northstar.drop-ship-event/v1',
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
    let record: SemanticOperationResultEnvelope['readBack'] = null;
    try {
      const result = await this.context.queryGateway.invoke(request.view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: request.readBackDefinition.queryId,
        arguments: request.authorization.readBackArguments,
      });
      record =
        result.records.find((row) => row.recordId === prepared.recordId) ??
        null;
      if (result.outcome !== 'exact' || !record)
        refused('Supplier delivery did not read back exactly');
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    }
    return {
      kind: 'semanticOperationResult',
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: record,
      unsupportedReason: null,
      trust: {
        changeDocumentId: trust.changeDocumentId,
        domainEventId: trust.domainEventId,
        invocationId: trust.invocationId,
        outboxId: trust.outboxId,
      },
    };
  }
  #scope(scope: DropShipScope) {
    return [scope.tenantId, scope.environmentId, scope.legalEntityId];
  }
  async #row(
    client: PoolClient,
    target: DropShipEntity,
    scope: DropShipScope,
    id: string,
    lock = true,
  ): Promise<DropShipRow> {
    const result = await client.query<DropShipRow>(
      `SELECT * FROM ${table(target)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(target.legalEntity!.column)}=$3 AND record_id=$4 AND archived_at IS NULL ${lock ? 'FOR NO KEY UPDATE' : ''}`,
      [...this.#scope(scope), id],
    );
    if (result.rows.length !== 1)
      refused(
        'Linked record is missing, archived or belongs to another company',
      );
    return result.rows[0]!;
  }
  async #update(
    client: PoolClient,
    target: DropShipEntity,
    scope: DropShipScope,
    row: DropShipRow,
    patch: Readonly<Record<string, unknown>> = {},
  ): Promise<number> {
    const keys = Object.keys(patch);
    const result = await client.query<{ revision: number }>(
      `UPDATE ${table(target)} SET revision=revision+1${keys.map((key, index) => `,${q(key)}=$${index + 6}`).join('')} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(target.legalEntity!.column)}=$3 AND record_id=$4 AND revision=$5 RETURNING revision`,
      [
        ...this.#scope(scope),
        row.record_id,
        row.revision,
        ...Object.values(patch),
      ],
    );
    if (result.rows.length !== 1)
      refused('Linked record changed during supplier delivery command');
    return result.rows[0]!.revision;
  }
  async #create(
    client: PoolClient,
    scope: DropShipScope,
    local: string,
    values: Record<string, ImmutableJsonValue>,
    relations: Record<string, string> = {},
  ): Promise<string> {
    const target = entity(this.storage, local);
    const definition = parsePinnedOperationCatalog(
      this.context.projection(PROJECTION_FAMILY_IDS.operationCatalog).payload,
    ).find((op) => op.operationId.endsWith(`:operation.${local}_create`));
    if (!definition || definition.effect.kind !== 'createRecordEffect')
      refused(`Missing declared create for ${local}`);
    const namespace = target.entityId.split(':entity.')[0];
    const recordId = randomUUID();
    const create = definition as RegisteredRecordOperationDefinition;
    const input = parseMutationInput(create, {
      recordId,
      legalEntityId: scope.legalEntityId,
      values: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          `${namespace}:field.${local}_${key}`,
          value,
        ]),
      ),
      relations: Object.fromEntries(
        Object.entries(relations).map(([key, value]) => [
          `${namespace}:relation.${local}_${key}`,
          value,
        ]),
      ),
    });
    await insertRecord(
      client,
      this.storage,
      target,
      await assignDocumentNumbers(client, target, create, input, 'sequence'),
      [],
    );
    return recordId;
  }
  #field(row: DropShipRow, local: string, name: string): unknown {
    const value = row[column(entity(this.storage, local), `${local}_${name}`)];
    return value instanceof Date ? value.toISOString() : value;
  }
  #state(row: DropShipRow, local: string): string {
    return String(
      row[
        column(
          entity(this.storage, local),
          `derived_state_field.machine.${local}_lifecycle`,
        )
      ],
    );
  }
  #assertRevision(row: DropShipRow, prepared: Prepared): void {
    if (Number(row.revision) !== prepared.revision)
      refused('Order or delivery revision is stale');
  }
  async #lines(
    client: PoolClient,
    scope: DropShipScope,
    local: 'sales' | 'purchase',
    orderId: string,
  ): Promise<DropShipRow[]> {
    const target = entity(this.storage, `${local}_order_line`);
    const result = await client.query<DropShipRow>(
      `SELECT * FROM ${table(target)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(target.legalEntity!.column)}=$3 AND ${q(relation(this.storage, `${local}_order_line_order`))}=$4 AND archived_at IS NULL ORDER BY record_id`,
      [...this.#scope(scope), orderId],
    );
    return result.rows;
  }
  async #apply(client: PoolClient, prepared: Prepared): Promise<Changed> {
    if (prepared.action === 'sales_order_create_drop_ship_po')
      return this.#purchase(client, prepared);
    if (prepared.action === 'drop_ship_delivery_reverse')
      return this.#reverse(client, prepared);
    return this.#deliver(client, prepared);
  }
  async #purchase(client: PoolClient, p: Prepared): Promise<Changed> {
    const sales = await this.#row(client, p.entity, p.scope, p.recordId);
    this.#assertRevision(sales, p);
    if (
      !this.#state(sales, 'sales_order').endsWith(':state.sales_order_released')
    )
      refused('Only confirmed sales orders create drop-ship purchase demand');
    const lines = await this.#lines(client, p.scope, 'sales', p.recordId);
    const linked: string[] = [];
    const purchase = entity(this.storage, 'purchase_order');
    for (const line of lines) {
      if (
        !String(
          this.#field(line, 'sales_order_line', 'fulfillment_route'),
        ).endsWith(':option.fulfillment_route_drop_ship')
      )
        continue;
      const link =
        line[relation(this.storage, 'sales_order_line_purchase_line')];
      if (link) {
        linked.push(String(link));
        continue;
      }
      const supplier = this.#field(
        line,
        'sales_order_line',
        'drop_ship_supplier_id',
      );
      if (typeof supplier !== 'string' || !supplier)
        refused('Every drop-ship line must name its supplier');
      await assertDropShipSupplier(client, this.storage, p.scope, supplier);
      const shipTo = Object.fromEntries(
        [
          'ship_to_address_id',
          'ship_to_name',
          'ship_to_street',
          'ship_to_city',
          'ship_to_region',
          'ship_to_postal_code',
          'ship_to_country',
        ].map((key) => [key, this.#field(sales, 'sales_order', key) ?? null]),
      );
      const currency = this.#field(sales, 'sales_order', 'currency');
      const headerValues = {
        ...shipTo,
        supplier_party_id: supplier,
        currency,
        order_date: this.context.currentInstant(),
        expected_date:
          this.#field(sales, 'sales_order', 'requested_date') ?? null,
      } as Record<string, ImmutableJsonValue>;
      const candidates = await client.query<DropShipRow>(
        `SELECT * FROM ${table(purchase)} WHERE tenant_id=$1 AND environment_id=$2 AND ${q(purchase.legalEntity!.column)}=$3 AND archived_at IS NULL AND ${q(column(purchase, 'purchase_order_supplier_party_id'))}=$4 AND ${q(column(purchase, 'derived_state_field.machine.purchase_order_lifecycle'))}=$5 ORDER BY record_id FOR NO KEY UPDATE`,
        [
          ...this.#scope(p.scope),
          supplier,
          `${purchase.entityId.split(':entity.')[0]}:state.purchase_order_draft`,
        ],
      );
      let header = candidates.rows.find(
        (row) =>
          this.#field(row, 'purchase_order', 'currency') === currency &&
          Object.entries(shipTo).every(
            ([key, value]) =>
              (this.#field(row, 'purchase_order', key) ?? null) === value,
          ),
      );
      if (!header)
        header = await this.#row(
          client,
          purchase,
          p.scope,
          await this.#create(client, p.scope, 'purchase_order', headerValues),
        );
      const existing = await this.#lines(
        client,
        p.scope,
        'purchase',
        String(header.record_id),
      );
      const next =
        existing.reduce(
          (maximum, row) =>
            Math.max(
              maximum,
              Number(this.#field(row, 'purchase_order_line', 'line_number')),
            ),
          0,
        ) + 1;
      const purchaseLineId = await this.#create(
        client,
        p.scope,
        'purchase_order_line',
        {
          line_number: String(next),
          item_id: this.#field(line, 'sales_order_line', 'item_id') as string,
          ordered_quantity: dropShipQuantityText(
            quantity(this.#field(line, 'sales_order_line', 'ordered_quantity')),
          ),
        },
        { order: String(header.record_id), sales_line: String(line.record_id) },
      );
      await this.#update(
        client,
        entity(this.storage, 'sales_order_line'),
        p.scope,
        line,
        {
          [relation(this.storage, 'sales_order_line_purchase_line')]:
            purchaseLineId,
        },
      );
      await this.#update(client, purchase, p.scope, header);
      linked.push(purchaseLineId);
    }
    if (linked.length === 0)
      refused('There are no drop-ship lines on this order');
    return {
      revision: await this.#update(client, p.entity, p.scope, sales),
      before: 'confirmed',
      after: 'linked purchase demand',
      linkedIds: linked,
    };
  }
  /** Consistent cross-order lock order: sales header/lines, then purchase header/lines, then delivery. */
  async #linked(client: PoolClient, p: Prepared, purchaseLineId: string) {
    const purchaseLineEntity = entity(this.storage, 'purchase_order_line');
    const hint = await this.#row(
      client,
      purchaseLineEntity,
      p.scope,
      purchaseLineId,
      false,
    );
    const salesLineId = String(
      hint[relation(this.storage, 'purchase_order_line_sales_line')] ?? '',
    );
    if (!salesLineId)
      refused(
        'Only a linked drop-ship purchase line records a supplier delivery',
      );
    const salesLineEntity = entity(this.storage, 'sales_order_line');
    const salesHint = await this.#row(
      client,
      salesLineEntity,
      p.scope,
      salesLineId,
      false,
    );
    const salesOrderId = String(
      salesHint[relation(this.storage, 'sales_order_line_order')],
    );
    const purchaseOrderId = String(
      hint[relation(this.storage, 'purchase_order_line_order')],
    );
    const salesOrder = await this.#row(
      client,
      entity(this.storage, 'sales_order'),
      p.scope,
      salesOrderId,
    );
    const salesLine = await this.#row(
      client,
      salesLineEntity,
      p.scope,
      salesLineId,
      false,
    );
    const purchaseOrder = await this.#row(
      client,
      entity(this.storage, 'purchase_order'),
      p.scope,
      purchaseOrderId,
    );
    const purchaseLine = await this.#row(
      client,
      purchaseLineEntity,
      p.scope,
      purchaseLineId,
      false,
    );
    if (
      salesLine[relation(this.storage, 'sales_order_line_purchase_line')] !==
        purchaseLineId ||
      purchaseLine[relation(this.storage, 'purchase_order_line_sales_line')] !==
        salesLineId ||
      purchaseLine[relation(this.storage, 'purchase_order_line_order')] !==
        purchaseOrderId ||
      salesLine[relation(this.storage, 'sales_order_line_order')] !==
        salesOrderId ||
      !String(
        this.#field(salesLine, 'sales_order_line', 'fulfillment_route'),
      ).endsWith(':option.fulfillment_route_drop_ship') ||
      this.#field(salesLine, 'sales_order_line', 'item_id') !==
        this.#field(purchaseLine, 'purchase_order_line', 'item_id') ||
      this.#field(salesLine, 'sales_order_line', 'drop_ship_supplier_id') !==
        this.#field(purchaseOrder, 'purchase_order', 'supplier_party_id')
    )
      refused('Drop-ship links, product, route or supplier do not agree');
    return {
      salesLine,
      purchaseLine,
      salesOrder,
      purchaseOrder,
      salesLineId,
      purchaseLineId,
      salesOrderId,
      purchaseOrderId,
    };
  }
  async #deliver(client: PoolClient, p: Prepared): Promise<Changed> {
    const draft =
      p.action === 'drop_ship_delivery_post'
        ? await this.#row(client, p.entity, p.scope, p.recordId, false)
        : null;
    const purchaseLineId = draft
      ? String(
          draft[relation(this.storage, 'drop_ship_delivery_purchase_line')],
        )
      : String(p.arguments.purchaseLineId);
    const linked = await this.#linked(client, p, purchaseLineId);
    const target = draft
      ? await this.#row(client, p.entity, p.scope, p.recordId)
      : linked.purchaseOrder;
    this.#assertRevision(target, p);
    if (!draft && linked.purchaseOrderId !== p.recordId)
      refused('Selected purchase line belongs to another order');
    if (
      !this.#state(linked.salesOrder, 'sales_order').endsWith(
        ':state.sales_order_released',
      ) ||
      !this.#state(linked.purchaseOrder, 'purchase_order').endsWith(
        ':state.purchase_order_released',
      )
    )
      refused(
        'Supplier delivery requires a confirmed sale and a placed purchase order',
      );
    if (
      draft &&
      (!String(this.#field(target, 'drop_ship_delivery', 'state')).endsWith(
        '_draft',
      ) ||
        target[relation(this.storage, 'drop_ship_delivery_sales_line')] !==
          linked.salesLineId ||
        target[relation(this.storage, 'drop_ship_delivery_sales_order')] !==
          linked.salesOrderId ||
        target[relation(this.storage, 'drop_ship_delivery_purchase_order')] !==
          linked.purchaseOrderId)
    )
      refused('Only an exactly linked draft delivery posts');
    const delivered = quantity(
      draft
        ? this.#field(target, 'drop_ship_delivery', 'quantity')
        : p.arguments.quantity,
    );
    const salesDone =
      (
        await deliveredByLine(client, this.storage, p.scope, 'sales', [
          linked.salesLineId,
        ])
      ).get(linked.salesLineId)?.quantity ?? 0n;
    const purchaseDone =
      (
        await deliveredByLine(client, this.storage, p.scope, 'purchase', [
          purchaseLineId,
        ])
      ).get(purchaseLineId)?.quantity ?? 0n;
    dropShipBound(
      delivered,
      quantity(
        this.#field(linked.salesLine, 'sales_order_line', 'ordered_quantity'),
      ) - salesDone,
      quantity(
        this.#field(
          linked.purchaseLine,
          'purchase_order_line',
          'ordered_quantity',
        ),
      ) - purchaseDone,
    );
    const delivery = entity(this.storage, 'drop_ship_delivery');
    const namespace = delivery.entityId.split(':entity.')[0];
    const unit = String(
      this.#field(linked.salesLine, 'sales_order_line', 'unit_id'),
    );
    if (!unit.trim()) refused('Supplier delivery requires a stated unit');
    let deliveryId = p.recordId;
    if (!draft)
      deliveryId = await this.#create(
        client,
        p.scope,
        'drop_ship_delivery',
        {
          state: `${namespace}:option.drop_ship_delivery_state_draft`,
          quantity: String(p.arguments.quantity),
          delivery_date: this.context.currentInstant(),
          external_reference: p.arguments.reference ?? null,
        },
        {
          sales_order: linked.salesOrderId,
          purchase_order: linked.purchaseOrderId,
          sales_line: linked.salesLineId,
          purchase_line: purchaseLineId,
        },
      );
    const record = draft
      ? target
      : await this.#row(client, delivery, p.scope, deliveryId);
    const revision = await this.#update(client, delivery, p.scope, record, {
      [column(delivery, 'drop_ship_delivery_state')]:
        `${namespace}:option.drop_ship_delivery_state_posted`,
      [column(delivery, 'drop_ship_delivery_unit_id')]: unit,
    });
    await this.#update(
      client,
      entity(this.storage, 'sales_order'),
      p.scope,
      linked.salesOrder,
    );
    const purchaseRevision = await this.#update(
      client,
      entity(this.storage, 'purchase_order'),
      p.scope,
      linked.purchaseOrder,
    );
    return {
      revision: draft ? revision : purchaseRevision,
      before: draft ? 'draft' : 'placed',
      after: 'supplier delivery recorded',
      linkedIds: [deliveryId],
    };
  }
  async #settled(
    client: PoolClient,
    scope: DropShipScope,
    side: 'sales' | 'purchase',
    lineId: string,
  ): Promise<bigint> {
    const local = side === 'sales' ? 'customer_invoice' : 'vendor_bill';
    const document = entity(this.storage, local);
    const line = entity(this.storage, `${local}_line`);
    const ns = document.entityId.split(':entity.')[0];
    const result = await client.query<{ quantity: string | null }>(
      `SELECT sum(l.${q(column(line, `${local}_line_quantity`))})::text AS quantity FROM ${table(line)} l JOIN ${table(document)} d ON d.record_id=l.${q(relation(this.storage, `${local}_line_${side === 'sales' ? 'invoice' : 'bill'}`))} AND d.tenant_id=l.tenant_id AND d.environment_id=l.environment_id AND d.${q(document.legalEntity!.column)}=l.${q(line.legalEntity!.column)} WHERE l.tenant_id=$1 AND l.environment_id=$2 AND l.${q(line.legalEntity!.column)}=$3 AND l.${q(relation(this.storage, `${local}_line_order_line`))}=$4 AND l.archived_at IS NULL AND d.archived_at IS NULL AND d.${q(column(document, `${local}_state`))}=ANY($5::text[])`,
      [
        ...this.#scope(scope),
        lineId,
        ['open', 'partially_paid', 'paid'].map(
          (state) => `${ns}:option.${local}_state_${state}`,
        ),
      ],
    );
    return quantity(result.rows[0]?.quantity ?? '0');
  }
  async #reverse(client: PoolClient, p: Prepared): Promise<Changed> {
    const hint = await this.#row(client, p.entity, p.scope, p.recordId, false);
    const linked = await this.#linked(
      client,
      p,
      String(hint[relation(this.storage, 'drop_ship_delivery_purchase_line')]),
    );
    const record = await this.#row(client, p.entity, p.scope, p.recordId);
    this.#assertRevision(record, p);
    if (
      !this.#state(linked.salesOrder, 'sales_order').endsWith(
        ':state.sales_order_released',
      ) ||
      !this.#state(linked.purchaseOrder, 'purchase_order').endsWith(
        ':state.purchase_order_released',
      )
    )
      refused('Reopen both orders before reversing a supplier delivery');
    if (
      !String(this.#field(record, 'drop_ship_delivery', 'state')).endsWith(
        '_posted',
      )
    )
      refused('Only a posted supplier delivery reverses');
    for (const [side, lineId] of [
      ['sales', linked.salesLineId],
      ['purchase', linked.purchaseLineId],
    ] as const) {
      const done =
        (
          await deliveredByLine(client, this.storage, p.scope, side, [lineId])
        ).get(lineId)?.quantity ?? 0n;
      if (
        done - quantity(this.#field(record, 'drop_ship_delivery', 'quantity')) <
        (await this.#settled(client, p.scope, side, lineId))
      )
        refused(
          'Void the live invoice or bill before reversing its supplier delivery',
        );
    }
    const before = String(this.#field(record, 'drop_ship_delivery', 'state'));
    const after = before.replace(/_posted$/u, '_reversed');
    const revision = await this.#update(client, p.entity, p.scope, record, {
      [column(p.entity, 'drop_ship_delivery_state')]: after,
      [column(p.entity, 'drop_ship_delivery_reversal_reason')]:
        p.arguments.reason,
    });
    await this.#update(
      client,
      entity(this.storage, 'sales_order'),
      p.scope,
      linked.salesOrder,
    );
    await this.#update(
      client,
      entity(this.storage, 'purchase_order'),
      p.scope,
      linked.purchaseOrder,
    );
    return {
      revision,
      before,
      after,
      linkedIds: [linked.salesOrderId, linked.purchaseOrderId],
    };
  }
}

export const DROP_SHIP_CAPABILITY_EXECUTOR_FACTORY: PostgresCapabilityOperationExecutorFactory =
  Object.freeze({
    capabilityId: DROP_SHIP_CAPABILITY_ID,
    verificationRefusal: {
      code: 'INVENTORY_POSTING_INPUT_INVALID',
      reason:
        'INVENTORY_POSTING_INPUT_INVALID: Supplier delivery authorization is not bound to execution',
    },
    create(context: PostgresCapabilityOperationExecutorContext) {
      return new DropShipExecutor(
        context,
        context.projection(PROJECTION_FAMILY_IDS.storageTarget)
          .payload as StorageTargetPayloadV1,
      );
    },
  });
