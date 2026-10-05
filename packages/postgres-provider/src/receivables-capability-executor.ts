import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
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
import { POLICY_DECISION_EVIDENCE_VERSION } from '../../platform-runtime/src/trust/contracts.js';
import type {
  PostgresCapabilityOperationExecutorContext,
  PostgresCapabilityOperationExecutorFactory,
} from './capability-operation-executor-factory.js';
import {
  chargeAmounts,
  formatCents,
  lineAmounts,
  parseExact,
  type LineAmounts,
} from './commercial-amounts.js';
import {
  InventoryPostingError,
  type InventoryPostingErrorCode,
} from './inventory-posting-error.js';
import {
  auditFieldId,
  withModuleRuntimeRole,
} from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';

/**
 * Receivables (owner ruling C): an internal invoice (INV-) for an order's
 * shipped and not yet invoiced quantities, a recorded payment (PAY-) and a
 * credit (CM-) against one invoice, and a balance per invoice. Every figure is
 * frozen when its document posts; an invoice is void only while nothing is
 * paid or credited on it, and an order with a live invoice is not reopened
 * (ruling F). No ledger, no provider, no other currency.
 */
export const RECEIVABLES_CAPABILITY_ID =
  'northstar.sales:capability.receivables' as const;
export const RECEIVABLES_CAPABILITY_VERSION = 1 as const;

type Entity = StorageTargetPayloadV1['entities'][number];
type Row = Record<string, unknown>;
type Action = 'post' | 'void' | 'pay' | 'credit' | 'reopen';

interface Binding {
  readonly target: StorageTargetPayloadV1;
  readonly invoice: Entity;
  readonly invoiceLine: Entity;
  readonly payment: Entity;
  readonly credit: Entity;
  readonly order: Entity;
  readonly orderLine: Entity;
  readonly shipped: Entity;
}

interface Prepared {
  readonly request: RegisteredCapabilityOperationAuthorizationRequest;
  readonly action: Action;
  readonly entity: Entity;
  readonly legalEntityId: string;
  readonly recordId: string;
  readonly expectedRevision: number;
}

interface Change {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
}

interface Changed {
  readonly revision: number;
  readonly changes: readonly Change[];
  readonly metadata: Readonly<Record<string, string | readonly string[]>>;
}

/** Days from the invoice date to its due date, by payment-terms option. */
const TERMS_DAYS: Readonly<Record<string, number>> = Object.freeze({
  due_on_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_45: 45,
  net_60: 60,
});

const ACTIONS: readonly (readonly [string, Action, keyof Binding])[] = [
  ['customer_invoice_post', 'post', 'invoice'],
  ['customer_invoice_void', 'void', 'invoice'],
  ['customer_payment_post', 'pay', 'payment'],
  ['customer_credit_post', 'credit', 'credit'],
  ['sales_order_reopen', 'reopen', 'order'],
];

const refusalReason =
  'Only named receivables operations are admitted by this route';

function refused(
  code: InventoryPostingErrorCode,
  message: string,
): InventoryPostingError {
  return new InventoryPostingError(code, message);
}

function quote(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error('Invalid storage identifier');
  return `"${value}"`;
}

const table = (entity: Entity) =>
  `north_star_module.${quote(entity.physicalTableName)}`;

function column(entity: Entity, suffix: string): string {
  // A field, or a machine's derived state field (`:derived_state_field.…`).
  const found = entity.columns.filter(
    (entry) =>
      entry.canonicalFieldId.endsWith(`:field.${suffix}`) ||
      entry.canonicalFieldId.endsWith(`:${suffix}`),
  );
  if (found.length !== 1)
    throw refused(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing field ${suffix}`,
    );
  return quote(found[0]!.physicalName);
}

function relation(binding: Binding, entity: Entity, suffix: string): string {
  const found = binding.target.relations.find((entry) =>
    entry.relationId.endsWith(`:relation.${suffix}`),
  );
  if (!found || found.sourceEntityId !== entity.entityId)
    throw refused(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing relation ${suffix}`,
    );
  return quote(found.relationColumn.physicalName);
}

function option(entity: Entity, suffix: string, value: string): string {
  const found = entity.columns
    .find((entry) => entry.canonicalFieldId.endsWith(`:field.${suffix}`))
    ?.fieldContract.enumOptionIds.find((entry) =>
      entry.endsWith(`:option.${suffix}_${value}`),
    );
  if (!found)
    throw refused(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing option ${suffix}/${value}`,
    );
  return found;
}

function bindingFor(target: StorageTargetPayloadV1): Binding {
  const entity = (local: string): Entity => {
    const matches = target.entities.filter((entry) =>
      entry.entityId.endsWith(`:entity.${local}`),
    );
    if (matches.length !== 1)
      throw refused(
        'INVENTORY_POSTING_STORAGE_INVALID',
        `Expected one ${local} entity`,
      );
    return matches[0]!;
  };
  return {
    target,
    invoice: entity('customer_invoice'),
    invoiceLine: entity('customer_invoice_line'),
    payment: entity('customer_payment'),
    credit: entity('customer_credit'),
    order: entity('sales_order'),
    orderLine: entity('sales_order_line'),
    shipped: entity('sales_order_shipped'),
  };
}

/**
 * A money amount in cents: a non-negative exact decimal in whole cents. A
 * sub-cent amount is refused rather than rounded; the store returns trailing
 * zeros to its column scale, which are whole cents.
 */
function cents(value: unknown): bigint | null {
  const parsed = parseExact(value);
  if (!parsed || parsed.units < 0n) return null;
  if (parsed.scale <= 2) return parsed.units * 10n ** BigInt(2 - parsed.scale);
  const divisor = 10n ** BigInt(parsed.scale - 2);
  return parsed.units % divisor === 0n ? parsed.units / divisor : null;
}

/** The exact quantity as units at scale 18. */
const QUANTITY_SCALE = 18;
function quantity(value: unknown): bigint {
  const parsed = parseExact(value);
  if (!parsed || parsed.scale > QUANTITY_SCALE)
    throw refused(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'A stored quantity is not an exact decimal',
    );
  return parsed.units * 10n ** BigInt(QUANTITY_SCALE - parsed.scale);
}
function quantityText(units: bigint): string {
  const scale = 10n ** BigInt(QUANTITY_SCALE);
  const fraction = (units % scale)
    .toString()
    .padStart(QUANTITY_SCALE, '0')
    .replace(/0+$/u, '');
  return `${String(units / scale)}${fraction ? `.${fraction}` : ''}`;
}

/** A line's or charge's frozen rate: `undefined` untaxed, `null` unknown. */
function frozenRate(
  taxCodeId: unknown,
  rate: unknown,
): string | null | undefined {
  if (typeof taxCodeId !== 'string' || taxCodeId === '') return undefined;
  return typeof rate === 'string' && rate !== '' ? rate : null;
}

function instantText(value: unknown): string {
  const instant = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(instant.getTime()))
    throw refused(
      'INVENTORY_POSTING_STORAGE_INVALID',
      'A stored instant is not readable',
    );
  return instant.toISOString();
}

class ReceivablesCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = RECEIVABLES_CAPABILITY_ID;
  readonly #binding: Binding;
  readonly #prepared = new WeakMap<object, Prepared>();

  constructor(
    private readonly context: PostgresCapabilityOperationExecutorContext,
    storage: StorageTargetPayloadV1,
  ) {
    this.#binding = bindingFor(storage);
  }

  async prepareAuthorization(
    request: RegisteredCapabilityOperationAuthorizationRequest,
  ): Promise<RegisteredCapabilityOperationAuthorization> {
    const named = ACTIONS.find(([local]) =>
      request.definition.operationId.endsWith(`:operation.${local}`),
    );
    const entity = named
      ? (this.#binding[named[2]] as Entity | undefined)
      : undefined;
    const input = request.input;
    const scope = request.readBackDefinition.legalEntityScope;
    if (
      !named ||
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
      throw refused('INVENTORY_POSTING_INPUT_INVALID', refusalReason);
    const recordId = input.recordId;
    const target = await withTrustedRequestTransaction(
      this.context.pool,
      request.context,
      async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        return withModuleRuntimeRole(client, async () => {
          const result = await client.query<Row>(
            `SELECT * FROM ${table(entity)}
              WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3
                AND archived_at IS NULL`,
            [request.context.tenantId, request.context.environmentId, recordId],
          );
          if (result.rows.length !== 1)
            throw refused(
              'INVENTORY_POSTING_INPUT_INVALID',
              'Receivables target is missing or archived',
            );
          return result.rows[0]!;
        });
      },
    );
    const legalEntityId = String(target[entity.legalEntity!.column]);
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
        action: named[1],
        entity,
        legalEntityId,
        recordId,
        expectedRevision: input.expectedRevision,
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
      throw refused(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Receivables authorization is not bound to this execution',
      );
    const trust = await new PostgresTrustService(
      this.context.pool,
    ).executeIdempotentAcceptedMutation<{
      recordId: string;
      legalEntityId: string;
      revision: number;
    }>(
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
          const changed = await this.#apply(client, request, prepared);
          const metadata = {
            legalEntityId: {
              classification: 'INTERNAL' as const,
              value: prepared.legalEntityId,
            },
            operationId: {
              classification: 'INTERNAL' as const,
              value: request.definition.operationId,
            },
            ...Object.fromEntries(
              Object.entries(changed.metadata).map(([key, value]) => [
                key,
                {
                  classification: 'INTERNAL' as const,
                  value: typeof value === 'string' ? value : [...value],
                },
              ]),
            ),
          };
          return {
            mutationResult: {
              recordId: prepared.recordId,
              legalEntityId: prepared.legalEntityId,
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
                changes: changed.changes.map((change) => ({
                  classification: 'INTERNAL' as const,
                  fieldId: auditFieldId(change.field),
                  oldState:
                    change.before === null
                      ? { state: 'ABSENT' as const }
                      : { state: 'VALUE' as const, value: change.before },
                  newState:
                    change.after === null
                      ? { state: 'ABSENT' as const }
                      : { state: 'VALUE' as const, value: change.after },
                })),
              },
              event: {
                eventId: randomUUID(),
                eventSchemaVersion: 'northstar.receivables-event/v1',
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
        throw refused(
          'INVENTORY_POSTING_STORAGE_REJECTED',
          'Receivables change did not read back exactly',
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

  #scope(request: RegisteredCapabilityOperationExecutionRequest) {
    return [request.context.tenantId, request.context.environmentId] as const;
  }

  async #row(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    entity: Entity,
    legalEntityId: string,
    recordId: string,
  ): Promise<Row> {
    const result = await client.query<Row>(
      `SELECT * FROM ${table(entity)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(entity.legalEntity!.column)}=$3 AND record_id=$4
        FOR NO KEY UPDATE`,
      [...this.#scope(request), legalEntityId, recordId],
    );
    if (result.rows.length !== 1)
      throw refused(
        'INVENTORY_POSTING_INPUT_INVALID',
        'Record is absent from the requested entity and scope',
      );
    return result.rows[0]!;
  }

  /** The target, locked, at exactly the revision the caller last read. */
  async #target(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Row> {
    const row = await this.#row(
      client,
      request,
      prepared.entity,
      prepared.legalEntityId,
      prepared.recordId,
    );
    if (
      row.archived_at !== null ||
      Number(row.revision) !== prepared.expectedRevision
    )
      throw refused(
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
        'Receivables target changed after authorization',
      );
    return row;
  }

  async #update(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    entity: Entity,
    legalEntityId: string,
    recordId: string,
    revision: number,
    values: readonly (readonly [string, unknown])[],
  ): Promise<number> {
    const updated = await client.query<{ revision: number }>(
      `UPDATE ${table(entity)}
          SET ${values.map(([name], index) => `${name}=$${String(index + 6)}`).join(',')},
              revision=revision+1
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(entity.legalEntity!.column)}=$3
          AND record_id=$4 AND revision=$5
        RETURNING revision`,
      [
        ...this.#scope(request),
        legalEntityId,
        recordId,
        revision,
        ...values.map(([, value]) => value),
      ],
    );
    if (updated.rows.length !== 1)
      throw refused(
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
        'A receivables record changed during the operation',
      );
    return Number(updated.rows[0]!.revision);
  }

  async #apply(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    switch (prepared.action) {
      case 'post':
        return this.#postInvoice(client, request, prepared);
      case 'void':
        return this.#voidInvoice(client, request, prepared);
      case 'pay':
      case 'credit':
        return this.#settle(client, request, prepared);
      case 'reopen':
        return this.#reopen(client, request, prepared);
    }
  }

  /** The order's invoices other than void and draft: the ones that count. */
  async #liveInvoices(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    legalEntityId: string,
    orderId: string,
  ): Promise<Row[]> {
    const b = this.#binding;
    const state = column(b.invoice, 'customer_invoice_state');
    const result = await client.query<Row>(
      `SELECT * FROM ${table(b.invoice)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(b.invoice.legalEntity!.column)}=$3
          AND ${relation(b, b.invoice, 'customer_invoice_order')}=$4
          AND archived_at IS NULL AND ${state} IN ($5,$6,$7)`,
      [
        ...this.#scope(request),
        legalEntityId,
        orderId,
        option(b.invoice, 'customer_invoice_state', 'open'),
        option(b.invoice, 'customer_invoice_state', 'partially_paid'),
        option(b.invoice, 'customer_invoice_state', 'paid'),
      ],
    );
    return result.rows;
  }

  async #postInvoice(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    const b = this.#binding;
    const le = prepared.legalEntityId;
    const scope = this.#scope(request);
    const invoice = await this.#target(client, request, prepared);
    const invoiceField = (name: string) =>
      column(b.invoice, `customer_invoice_${name}`);
    const draft = option(b.invoice, 'customer_invoice_state', 'draft');
    if (invoice[unquote(invoiceField('state'))] !== draft)
      throw refused(
        'RECEIVABLES_INVOICE_STATE_CONFLICT',
        'Only a draft invoice posts',
      );
    const orderId = String(
      invoice[unquote(relation(b, b.invoice, 'customer_invoice_order'))],
    );
    // The order is locked first by every writer of its invoices, so two
    // invoices of one order cannot both take the same shipped quantity.
    const order = await this.#row(client, request, b.order, le, orderId);
    const orderState = String(
      order[
        unquote(
          column(b.order, 'derived_state_field.machine.sales_order_lifecycle'),
        )
      ],
    );
    if (
      order.archived_at !== null ||
      !(
        orderState.endsWith(':state.sales_order_released') ||
        orderState.endsWith(':state.sales_order_closed')
      )
    )
      throw refused(
        'RECEIVABLES_ORDER_NOT_INVOICEABLE',
        'Only a confirmed or closed order is invoiced',
      );
    const existingLines = await client.query(
      `SELECT 1 FROM ${table(b.invoiceLine)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(b.invoiceLine.legalEntity!.column)}=$3
          AND ${relation(b, b.invoiceLine, 'customer_invoice_line_invoice')}=$4
        LIMIT 1`,
      [...scope, le, prepared.recordId],
    );
    if (existingLines.rows.length > 0)
      throw refused(
        'RECEIVABLES_INVOICE_STATE_CONFLICT',
        "An invoice's lines are written when it posts",
      );
    const lineField = (name: string) =>
      unquote(column(b.orderLine, `sales_order_line_${name}`));
    const orderLines = await client.query<Row>(
      `SELECT * FROM ${table(b.orderLine)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(b.orderLine.legalEntity!.column)}=$3
          AND ${relation(b, b.orderLine, 'sales_order_line_order')}=$4
          AND archived_at IS NULL
        ORDER BY ${quote(lineField('line_number'))}, record_id`,
      [...scope, le, orderId],
    );
    const shippedRows = await client.query<{ line: string; quantity: string }>(
      `SELECT ${relation(b, b.shipped, 'sales_order_shipped_order_line')}::text AS line,
              sum(${column(b.shipped, 'sales_order_shipped_shipped_quantity')})::text AS quantity
         FROM ${table(b.shipped)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(b.shipped.legalEntity!.column)}=$3 AND archived_at IS NULL
        GROUP BY 1`,
      [...scope, le],
    );
    const shipped = new Map(
      shippedRows.rows.map((row) => [row.line, quantity(row.quantity)]),
    );
    const live = await this.#liveInvoices(client, request, le, orderId);
    const invoicedRows = live.length
      ? await client.query<{ line: string; quantity: string }>(
          `SELECT ${relation(b, b.invoiceLine, 'customer_invoice_line_order_line')}::text AS line,
                  sum(${column(b.invoiceLine, 'customer_invoice_line_quantity')})::text AS quantity
             FROM ${table(b.invoiceLine)}
            WHERE tenant_id=$1 AND environment_id=$2
              AND ${quote(b.invoiceLine.legalEntity!.column)}=$3 AND archived_at IS NULL
              AND ${relation(b, b.invoiceLine, 'customer_invoice_line_invoice')} = ANY($4::uuid[])
            GROUP BY 1`,
          [...scope, le, live.map((row) => String(row.record_id))],
        )
      : { rows: [] };
    const invoiced = new Map(
      invoicedRows.rows.map((row) => [row.line, quantity(row.quantity)]),
    );
    const lines: {
      readonly orderLine: Row;
      readonly quantity: bigint;
      readonly amounts: LineAmounts;
    }[] = [];
    for (const line of orderLines.rows) {
      const id = String(line.record_id);
      const eligible = (shipped.get(id) ?? 0n) - (invoiced.get(id) ?? 0n);
      if (eligible <= 0n) continue;
      const amounts = lineAmounts({
        quantity: quantityText(eligible),
        unitPrice: line[lineField('unit_price')],
        discountPercent: line[lineField('discount_percent')],
        taxRatePercent: frozenRate(
          line[lineField('tax_code_id')],
          line[lineField('tax_rate_percent')],
        ),
      });
      if (!amounts)
        throw refused(
          'RECEIVABLES_LINE_UNPRICED',
          'Every shipped line needs a price, a discount of 0-100% and a stated tax rate before it is invoiced',
        );
      lines.push({ orderLine: line, quantity: eligible, amounts });
    }
    if (lines.length === 0)
      throw refused(
        'RECEIVABLES_NOTHING_TO_INVOICE',
        'Every shipped quantity of this order is already invoiced',
      );
    // The order's charges go on its first invoice that is not void.
    const chargesField = unquote(invoiceField('charges'));
    const charged = live.some((row) => (cents(row[chargesField]) ?? 0n) > 0n);
    const orderField = (name: string) =>
      order[unquote(column(b.order, `sales_order_${name}`))];
    const charges = charged
      ? [
          { amountCents: 0n, taxCents: 0n },
          { amountCents: 0n, taxCents: 0n },
        ]
      : [
          chargeAmounts(
            orderField('freight_amount'),
            frozenRate(
              orderField('freight_tax_code_id'),
              orderField('freight_tax_rate_percent'),
            ),
          ),
          chargeAmounts(
            orderField('other_fee_amount'),
            frozenRate(
              orderField('other_fee_tax_code_id'),
              orderField('other_fee_tax_rate_percent'),
            ),
          ),
        ];
    if (charges.some((charge) => charge === null))
      throw refused(
        'RECEIVABLES_LINE_UNPRICED',
        "The order's freight and other fee each need a stated tax rate before they are invoiced",
      );
    const sum = (values: readonly bigint[]) =>
      values.reduce((total, value) => total + value, 0n);
    const subtotal = sum(lines.map((line) => line.amounts.amountCents));
    const chargeTotal = sum(charges.map((charge) => charge!.amountCents));
    const tax = sum([
      ...lines.map((line) => line.amounts.taxCents),
      ...charges.map((charge) => charge!.taxCents),
    ]);
    const total = subtotal + chargeTotal + tax;
    // Line records, written with the invoice they belong to.
    const invoiceLineField = (name: string) =>
      column(b.invoiceLine, `customer_invoice_line_${name}`);
    for (const [index, line] of lines.entries())
      await client.query(
        `INSERT INTO ${table(b.invoiceLine)}
          (tenant_id,environment_id,${quote(b.invoiceLine.legalEntity!.column)},record_id,revision,archived_at,
           ${relation(b, b.invoiceLine, 'customer_invoice_line_invoice')},
           ${relation(b, b.invoiceLine, 'customer_invoice_line_order_line')},
           ${invoiceLineField('line_number')},${invoiceLineField('item_id')},
           ${invoiceLineField('unit_id')},${invoiceLineField('quantity')},
           ${invoiceLineField('unit_price')},${invoiceLineField('discount_percent')},
           ${invoiceLineField('tax_rate_percent')},${invoiceLineField('amount')},
           ${invoiceLineField('tax')})
         VALUES ($1,$2,$3,$4,1,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          ...scope,
          le,
          randomUUID(),
          prepared.recordId,
          String(line.orderLine.record_id),
          index + 1,
          line.orderLine[lineField('item_id')],
          line.orderLine[lineField('unit_id')],
          quantityText(line.quantity),
          line.orderLine[lineField('unit_price')],
          line.orderLine[lineField('discount_percent')] ?? null,
          frozenRate(
            line.orderLine[lineField('tax_code_id')],
            line.orderLine[lineField('tax_rate_percent')],
          ) ?? null,
          formatCents(line.amounts.amountCents),
          formatCents(line.amounts.taxCents),
        ],
      );
    const terms = orderField('payment_terms');
    const termsLocal =
      typeof terms === 'string'
        ? (Object.keys(TERMS_DAYS).find((local) =>
            terms.endsWith(`:option.sales_order_payment_terms_${local}`),
          ) ?? null)
        : null;
    const invoiceDate = instantText(
      invoice[unquote(invoiceField('invoice_date'))],
    );
    const due = new Date(
      Date.parse(invoiceDate) +
        (TERMS_DAYS[termsLocal ?? 'due_on_receipt'] ?? 0) * 86_400_000,
    ).toISOString();
    const state = option(
      b.invoice,
      'customer_invoice_state',
      total > 0n ? 'open' : 'paid',
    );
    const values: (readonly [string, unknown])[] = [
      [invoiceField('state'), state],
      [invoiceField('customer_party_id'), orderField('customer_party_id')],
      [invoiceField('currency'), orderField('currency')],
      [
        invoiceField('payment_terms'),
        termsLocal
          ? option(b.invoice, 'customer_invoice_payment_terms', termsLocal)
          : null,
      ],
      [invoiceField('due_date'), due],
      [invoiceField('subtotal'), formatCents(subtotal)],
      [invoiceField('charges'), formatCents(chargeTotal)],
      [invoiceField('tax'), formatCents(tax)],
      [invoiceField('total'), formatCents(total)],
      [invoiceField('paid_amount'), '0.00'],
      [invoiceField('credited_amount'), '0.00'],
      [invoiceField('balance'), formatCents(total)],
    ];
    const revision = await this.#update(
      client,
      request,
      b.invoice,
      le,
      prepared.recordId,
      prepared.expectedRevision,
      values,
    );
    return {
      revision,
      changes: [
        { field: `${b.invoice.entityId}.state`, before: draft, after: state },
        {
          field: `${b.invoice.entityId}.total`,
          before: null,
          after: formatCents(total),
        },
      ],
      metadata: {
        orderId,
        invoicedOrderLineIds: lines.map((line) =>
          String(line.orderLine.record_id),
        ),
      },
    };
  }

  async #voidInvoice(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    const b = this.#binding;
    const invoice = await this.#target(client, request, prepared);
    const field = (name: string) =>
      column(b.invoice, `customer_invoice_${name}`);
    const state = String(invoice[unquote(field('state'))]);
    // Open: posted with nothing settled; a zero-total invoice posts as paid.
    if (
      state !== option(b.invoice, 'customer_invoice_state', 'open') &&
      state !== option(b.invoice, 'customer_invoice_state', 'paid')
    )
      throw refused(
        'RECEIVABLES_INVOICE_STATE_CONFLICT',
        'Only a posted invoice with nothing settled on it is voided',
      );
    if (
      (cents(invoice[unquote(field('paid_amount'))]) ?? 0n) !== 0n ||
      (cents(invoice[unquote(field('credited_amount'))]) ?? 0n) !== 0n
    )
      throw refused(
        'RECEIVABLES_INVOICE_SETTLED',
        'An invoice with a payment or a credit is not voided; credit it instead',
      );
    const after = option(b.invoice, 'customer_invoice_state', 'void');
    const revision = await this.#update(
      client,
      request,
      b.invoice,
      prepared.legalEntityId,
      prepared.recordId,
      prepared.expectedRevision,
      [
        [field('state'), after],
        [field('balance'), '0.00'],
      ],
    );
    return {
      revision,
      changes: [{ field: `${b.invoice.entityId}.state`, before: state, after }],
      metadata: {},
    };
  }

  /** A payment or a credit posts against one open invoice's balance. */
  async #settle(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    const b = this.#binding;
    const le = prepared.legalEntityId;
    const kind = prepared.action === 'pay' ? 'payment' : 'credit';
    const local = `customer_${kind}`;
    const entity = prepared.entity;
    const document = await this.#target(client, request, prepared);
    const field = (name: string) => column(entity, `${local}_${name}`);
    const draft = option(entity, `${local}_state`, 'draft');
    if (document[unquote(field('state'))] !== draft)
      throw refused(
        'RECEIVABLES_INVOICE_STATE_CONFLICT',
        `Only a draft ${kind} posts`,
      );
    const amount = cents(document[unquote(field('amount'))]);
    if (amount === null || amount <= 0n)
      throw refused(
        'RECEIVABLES_AMOUNT_INVALID',
        'An amount is a positive figure in whole cents',
      );
    const invoiceId = String(
      document[unquote(relation(b, entity, `${local}_invoice`))],
    );
    const invoice = await this.#row(client, request, b.invoice, le, invoiceId);
    const invoiceField = (name: string) =>
      column(b.invoice, `customer_invoice_${name}`);
    const invoiceState = invoice[unquote(invoiceField('state'))];
    if (
      invoice.archived_at !== null ||
      (invoiceState !== option(b.invoice, 'customer_invoice_state', 'open') &&
        invoiceState !==
          option(b.invoice, 'customer_invoice_state', 'partially_paid'))
    )
      throw refused(
        'RECEIVABLES_INVOICE_STATE_CONFLICT',
        `A ${kind} posts only against an invoice with a balance`,
      );
    const balance = cents(invoice[unquote(invoiceField('balance'))]) ?? 0n;
    if (amount > balance)
      throw refused(
        'RECEIVABLES_AMOUNT_EXCEEDS_BALANCE',
        `The ${kind} exceeds the invoice balance`,
      );
    const settled = kind === 'payment' ? 'paid_amount' : 'credited_amount';
    const before = cents(invoice[unquote(invoiceField(settled))]) ?? 0n;
    const remaining = balance - amount;
    await this.#update(
      client,
      request,
      b.invoice,
      le,
      invoiceId,
      Number(invoice.revision),
      [
        [invoiceField(settled), formatCents(before + amount)],
        [invoiceField('balance'), formatCents(remaining)],
        [
          invoiceField('state'),
          option(
            b.invoice,
            'customer_invoice_state',
            remaining === 0n ? 'paid' : 'partially_paid',
          ),
        ],
      ],
    );
    const posted = option(entity, `${local}_state`, 'posted');
    const revision = await this.#update(
      client,
      request,
      entity,
      le,
      prepared.recordId,
      prepared.expectedRevision,
      [[field('state'), posted]],
    );
    return {
      revision,
      changes: [
        { field: `${entity.entityId}.state`, before: draft, after: posted },
        {
          field: `${b.invoice.entityId}.balance`,
          before: formatCents(balance),
          after: formatCents(remaining),
        },
      ],
      metadata: { invoiceId },
    };
  }

  /** Ruling F: a closed order reopens while no invoice of it counts. */
  async #reopen(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    const b = this.#binding;
    const order = await this.#target(client, request, prepared);
    const stateColumn = column(
      b.order,
      'derived_state_field.machine.sales_order_lifecycle',
    );
    const before = String(order[unquote(stateColumn)]);
    if (!before.endsWith(':state.sales_order_closed'))
      throw refused(
        'RECEIVABLES_ORDER_NOT_REOPENABLE',
        'Only a closed order reopens',
      );
    if (
      (
        await this.#liveInvoices(
          client,
          request,
          prepared.legalEntityId,
          prepared.recordId,
        )
      ).length > 0
    )
      throw refused(
        'RECEIVABLES_ORDER_NOT_REOPENABLE',
        'An invoiced order is not reopened; void its invoices first',
      );
    const after = before.replace(
      /:state\.sales_order_closed$/u,
      ':state.sales_order_released',
    );
    const revision = await this.#update(
      client,
      request,
      b.order,
      prepared.legalEntityId,
      prepared.recordId,
      prepared.expectedRevision,
      [[stateColumn, after]],
    );
    return {
      revision,
      changes: [{ field: `${b.order.entityId}.lifecycle`, before, after }],
      metadata: {},
    };
  }
}

function unquote(identifier: string): string {
  return identifier.slice(1, -1);
}

export const RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY = Object.freeze({
  capabilityId: RECEIVABLES_CAPABILITY_ID,
  verificationRefusal: {
    code: 'INVENTORY_POSTING_INPUT_INVALID',
    reason: `INVENTORY_POSTING_INPUT_INVALID: ${refusalReason}`,
  },
  create(context) {
    const projection = context.projection(PROJECTION_FAMILY_IDS.storageTarget);
    const storage = projection.payload as StorageTargetPayloadV1;
    if (storage.kind !== 'storageTargetPayload')
      throw refused(
        'INVENTORY_POSTING_STORAGE_INVALID',
        'Expected active storage target',
      );
    return new ReceivablesCapabilityExecutor(context, storage);
  },
} satisfies PostgresCapabilityOperationExecutorFactory);
