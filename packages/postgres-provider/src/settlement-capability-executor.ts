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
  creditLimitCents,
  formatCents,
  lineAmounts,
  orderTotalCents,
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
 * One settlement document family, driven by a spec: a document (an invoice or
 * a bill) for an order's progressed and not yet settled quantities -- what was
 * shipped, or what was received -- a recorded payment and a credit against
 * one document, and a balance per document. Every figure is frozen when its
 * document posts; a document is void only while nothing is paid or credited
 * on it. No ledger, no provider, no other currency.
 *
 * The spec names every entity, field, relation, code and message; this file
 * names no module. Each module's spec file owns its identity.
 */
export type SettlementAction =
  'post' | 'void' | 'pay' | 'credit' | 'reopen' | 'confirm';

/** Which bound entity a named operation acts on. */
type SettlementRole = 'document' | 'payment' | 'credit' | 'order';

type SettlementCode = InventoryPostingErrorCode;

export interface SettlementSpec {
  readonly capabilityId: string;
  /** The schema version of the events every operation emits. */
  readonly eventSchemaVersion: string;
  /** The refusal of anything but the named operations, and of verification. */
  readonly refusalReason: string;
  /** Entity local ids. */
  readonly entities: Readonly<{
    document: string;
    line: string;
    payment: string;
    credit: string;
    order: string;
    orderLine: string;
    /** The provider-written projection of what each order line progressed. */
    progress: string;
  }>;
  /** Relation local ids. */
  readonly relations: Readonly<{
    documentOrder: string;
    lineDocument: string;
    lineOrderLine: string;
    paymentDocument: string;
    creditDocument: string;
    orderLineOrder: string;
    progressOrderLine: string;
  }>;
  /** Field names that differ between families, each local to its entity. */
  readonly fields: Readonly<{
    /** The document's date, from which its due date is counted. */
    documentDate: string;
    /** The order's party, copied onto the document under the same name. */
    counterparty: string;
    /** The progress projection's quantity. */
    progressQuantity: string;
    /**
     * Where a document line's unit comes from: the order line's own unit, or
     * the progress projection's (an order line that carries none).
     */
    unitFrom: 'orderLine' | 'progress';
    /**
     * A document field the counterparty's live documents may not share, such
     * as the supplier's own invoice number; absent when there is none.
     */
    uniqueReference?: string;
  }>;
  /** The named operations, by operation local id. */
  readonly actions: readonly (readonly [
    operation: string,
    action: SettlementAction,
    role: SettlementRole,
  ])[];
  /** A posted document is dated when it posts, whatever its draft said. */
  readonly datedAtPost: boolean;
  readonly codes: Readonly<{
    documentState: SettlementCode;
    orderNotReady: SettlementCode;
    lineUnpriced: SettlementCode;
    nothingToSettle: SettlementCode;
    settled: SettlementCode;
    amountInvalid: SettlementCode;
    amountExceedsBalance: SettlementCode;
    orderNotReopenable?: SettlementCode;
    duplicateReference?: SettlementCode;
    orderNotConfirmable?: SettlementCode;
    customerOnHold?: SettlementCode;
    creditLimitExceeded?: SettlementCode;
    creditCurrencyMismatch?: SettlementCode;
    creditUnstated?: SettlementCode;
  }>;
  readonly messages: Readonly<{
    targetMissing: string;
    authorizationUnbound: string;
    readBackInexact: string;
    targetChanged: string;
    recordChanged: string;
    draftPosts: string;
    orderNotReady: string;
    linesWritten: string;
    lineUnpriced: string;
    nothingToSettle: string;
    chargesUnpriced: string;
    voidState: string;
    voidSettled: string;
    settleDraft: (kind: 'payment' | 'credit') => string;
    amountInvalid: string;
    settleState: (kind: 'payment' | 'credit') => string;
    exceedsBalance: (kind: 'payment' | 'credit') => string;
    reopenState?: string;
    reopenSettled?: string;
    duplicateReference?: string;
    orderChanged?: string;
    confirmState?: string;
    confirmRequired?: string;
    customerOnHold?: string;
    creditLimitExceeded?: (overBy: string, currency: string) => string;
    creditCurrencyMismatch?: (limitCurrency: string | null) => string;
    creditUnstated?: string;
  }>;
  /** The event metadata keys for the lines a post settled and the document. */
  readonly metadataKeys: Readonly<{ lines: string; document: string }>;
  /**
   * Confirming a draft order (SALES-EXTRAS): the order fields it requires,
   * none blank, and the counterparty's credit -- its hold, its limit and the
   * limit's currency -- each local to the counterparty's master entity.
   * Absent: the family confirms nothing.
   */
  readonly confirm?: Readonly<{
    party: string;
    limit: string;
    hold: string;
    currency: string;
    required: readonly string[];
  }>;
}

type Entity = StorageTargetPayloadV1['entities'][number];
type Row = Record<string, unknown>;

interface Binding {
  readonly target: StorageTargetPayloadV1;
  readonly document: Entity;
  readonly line: Entity;
  readonly payment: Entity;
  readonly credit: Entity;
  readonly order: Entity;
  readonly orderLine: Entity;
  readonly progress: Entity;
  /** The counterparty's master, when the family confirms orders. */
  readonly party: Entity | null;
}

interface Prepared {
  readonly request: RegisteredCapabilityOperationAuthorizationRequest;
  readonly action: SettlementAction;
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

/** Days from the document date to its due date, by payment-terms option. */
const TERMS_DAYS: Readonly<Record<string, number>> = Object.freeze({
  due_on_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_45: 45,
  net_60: 60,
});

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

/** The spec's entities in one active storage target, each exactly once. */
export function settlementBinding(
  spec: SettlementSpec,
  target: StorageTargetPayloadV1,
): Binding {
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
    document: entity(spec.entities.document),
    line: entity(spec.entities.line),
    payment: entity(spec.entities.payment),
    credit: entity(spec.entities.credit),
    order: entity(spec.entities.order),
    orderLine: entity(spec.entities.orderLine),
    progress: entity(spec.entities.progress),
    party: spec.confirm ? entity(spec.confirm.party) : null,
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

function unquote(identifier: string): string {
  return identifier.slice(1, -1);
}

/** What one order line has progressed, and in which unit. */
export interface LineProgress {
  readonly quantity: bigint;
  /** The projection's unit; `null` when the spec reads the order line's. */
  readonly unit: string | null;
}

/**
 * What each of the given order lines has progressed -- shipped or received --
 * read from the progress projection for exactly those lines, never for the
 * rest of the company's history.
 */
export async function progressByOrderLine(
  client: Pick<PoolClient, 'query'>,
  spec: SettlementSpec,
  binding: Binding,
  scope: Readonly<{
    tenantId: string;
    environmentId: string;
    legalEntityId: string;
  }>,
  orderLineIds: readonly string[],
): Promise<ReadonlyMap<string, LineProgress>> {
  const progress = binding.progress;
  const fromProjection = spec.fields.unitFrom === 'progress';
  const unit = fromProjection
    ? column(progress, `${spec.entities.progress}_unit_id`)
    : null;
  const rows = await client.query<{
    line: string;
    quantity: string;
    unit?: string | null;
    units?: number;
  }>(
    `SELECT ${relation(binding, progress, spec.relations.progressOrderLine)}::text AS line,
            sum(${column(progress, `${spec.entities.progress}_${spec.fields.progressQuantity}`)})::text AS quantity${
              unit
                ? `,
            min(${unit})::text AS unit,
            count(DISTINCT ${unit})::int AS units`
                : ''
            }
       FROM ${table(progress)}
      WHERE tenant_id=$1 AND environment_id=$2
        AND ${quote(progress.legalEntity!.column)}=$3 AND archived_at IS NULL
        AND ${relation(binding, progress, spec.relations.progressOrderLine)} = ANY($4::uuid[])
      GROUP BY 1`,
    [scope.tenantId, scope.environmentId, scope.legalEntityId, orderLineIds],
  );
  return new Map(
    rows.rows.map((row) => {
      if (unit && (row.units !== 1 || typeof row.unit !== 'string'))
        throw refused(
          'INVENTORY_POSTING_STORAGE_INVALID',
          "A line's progress is not in exactly one unit",
        );
      return [
        row.line,
        {
          quantity: quantity(row.quantity),
          unit: unit ? (row.unit as string) : null,
        },
      ];
    }),
  );
}

class SettlementCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId: string;
  readonly #spec: SettlementSpec;
  readonly #binding: Binding;
  readonly #prepared = new WeakMap<object, Prepared>();

  constructor(
    private readonly context: PostgresCapabilityOperationExecutorContext,
    storage: StorageTargetPayloadV1,
    spec: SettlementSpec,
  ) {
    this.capabilityId = spec.capabilityId;
    this.#spec = spec;
    this.#binding = settlementBinding(spec, storage);
  }

  async prepareAuthorization(
    request: RegisteredCapabilityOperationAuthorizationRequest,
  ): Promise<RegisteredCapabilityOperationAuthorization> {
    const spec = this.#spec;
    const named = spec.actions.find(([local]) =>
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
      throw refused('INVENTORY_POSTING_INPUT_INVALID', spec.refusalReason);
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
              spec.messages.targetMissing,
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
    const spec = this.#spec;
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
        spec.messages.authorizationUnbound,
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
                eventSchemaVersion: spec.eventSchemaVersion,
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
          spec.messages.readBackInexact,
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
        this.#spec.messages.targetChanged,
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
        this.#spec.messages.recordChanged,
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
        return this.#post(client, request, prepared);
      case 'void':
        return this.#void(client, request, prepared);
      case 'pay':
      case 'credit':
        return this.#settle(client, request, prepared);
      case 'reopen':
        return this.#reopen(client, request, prepared);
      case 'confirm':
        return this.#confirm(client, request, prepared);
    }
  }

  /** The document's own field `name`. */
  #documentField(name: string): string {
    return column(
      this.#binding.document,
      `${this.#spec.entities.document}_${name}`,
    );
  }

  /** The document state option `value`. */
  #documentState(value: string): string {
    return option(
      this.#binding.document,
      `${this.#spec.entities.document}_state`,
      value,
    );
  }

  /** The order's documents other than void and draft: the ones that count. */
  async #liveDocuments(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    legalEntityId: string,
    orderId: string,
  ): Promise<Row[]> {
    const b = this.#binding;
    const result = await client.query<Row>(
      `SELECT * FROM ${table(b.document)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(b.document.legalEntity!.column)}=$3
          AND ${relation(b, b.document, this.#spec.relations.documentOrder)}=$4
          AND archived_at IS NULL AND ${this.#documentField('state')} IN ($5,$6,$7)`,
      [
        ...this.#scope(request),
        legalEntityId,
        orderId,
        this.#documentState('open'),
        this.#documentState('partially_paid'),
        this.#documentState('paid'),
      ],
    );
    return result.rows;
  }

  /**
   * A reference the counterparty's live documents may not share (the
   * supplier's own invoice number) is checked under a transaction lock on
   * the counterparty, taken before the order row: two posts naming one
   * reference for one counterparty serialize here, and no other writer of
   * the order takes this lock.
   */
  async #lockReference(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    legalEntityId: string,
    document: Row,
    orderId: string,
  ): Promise<{ counterparty: string; reference: string } | null> {
    const spec = this.#spec;
    const b = this.#binding;
    if (!spec.fields.uniqueReference) return null;
    const reference =
      document[unquote(this.#documentField(spec.fields.uniqueReference))];
    if (typeof reference !== 'string' || reference.trim() === '') return null;
    const counterpartyColumn = column(
      b.order,
      `${spec.entities.order}_${spec.fields.counterparty}`,
    );
    const order = await client.query<{ counterparty: string | null }>(
      `SELECT ${counterpartyColumn}::text AS counterparty FROM ${table(b.order)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(b.order.legalEntity!.column)}=$3 AND record_id=$4`,
      [...this.#scope(request), legalEntityId, orderId],
    );
    const counterparty = order.rows[0]?.counterparty;
    if (typeof counterparty !== 'string') return null;
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         $1::text || ':' || $2::text || ':' || $3::text || ':' ||
         $4::text || ':' || $5::text, 0))`,
      [...this.#scope(request), spec.capabilityId, legalEntityId, counterparty],
    );
    return { counterparty, reference };
  }

  async #post(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    const spec = this.#spec;
    const b = this.#binding;
    const le = prepared.legalEntityId;
    const scope = this.#scope(request);
    const document = await this.#target(client, request, prepared);
    const documentField = (name: string) => this.#documentField(name);
    const draft = this.#documentState('draft');
    if (document[unquote(documentField('state'))] !== draft)
      throw refused(spec.codes.documentState, spec.messages.draftPosts);
    const orderId = String(
      document[unquote(relation(b, b.document, spec.relations.documentOrder))],
    );
    const referenced = await this.#lockReference(
      client,
      request,
      le,
      document,
      orderId,
    );
    // The order is locked first by every writer of its documents, so two
    // documents of one order cannot both take the same progressed quantity.
    const order = await this.#row(client, request, b.order, le, orderId);
    const orderState = String(
      order[
        unquote(
          column(
            b.order,
            `derived_state_field.machine.${spec.entities.order}_lifecycle`,
          ),
        )
      ],
    );
    if (
      order.archived_at !== null ||
      !(
        orderState.endsWith(`:state.${spec.entities.order}_released`) ||
        orderState.endsWith(`:state.${spec.entities.order}_closed`)
      )
    )
      throw refused(spec.codes.orderNotReady, spec.messages.orderNotReady);
    const orderField = (name: string) =>
      order[unquote(column(b.order, `${spec.entities.order}_${name}`))];
    if (referenced) {
      // The counterparty the lock was taken for is still the order's.
      if (orderField(spec.fields.counterparty) !== referenced.counterparty)
        throw refused(
          'INVENTORY_TRANSACTION_STATE_CONFLICT',
          spec.messages.orderChanged ?? spec.messages.recordChanged,
        );
      const duplicate = await client.query(
        `SELECT 1 FROM ${table(b.document)}
          WHERE tenant_id=$1 AND environment_id=$2
            AND ${quote(b.document.legalEntity!.column)}=$3
            AND ${documentField(spec.fields.counterparty)}=$4
            AND archived_at IS NULL AND ${documentField('state')} IN ($5,$6,$7)
            AND lower(btrim(${documentField(spec.fields.uniqueReference!)})) = lower(btrim($8))
            AND record_id <> $9
          LIMIT 1`,
        [
          ...scope,
          le,
          referenced.counterparty,
          this.#documentState('open'),
          this.#documentState('partially_paid'),
          this.#documentState('paid'),
          referenced.reference,
          prepared.recordId,
        ],
      );
      if (duplicate.rows.length > 0)
        throw refused(
          spec.codes.duplicateReference ?? spec.codes.documentState,
          spec.messages.duplicateReference ?? spec.messages.draftPosts,
        );
    }
    const existingLines = await client.query(
      `SELECT 1 FROM ${table(b.line)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(b.line.legalEntity!.column)}=$3
          AND ${relation(b, b.line, spec.relations.lineDocument)}=$4
        LIMIT 1`,
      [...scope, le, prepared.recordId],
    );
    if (existingLines.rows.length > 0)
      throw refused(spec.codes.documentState, spec.messages.linesWritten);
    const lineField = (name: string) =>
      unquote(column(b.orderLine, `${spec.entities.orderLine}_${name}`));
    const orderLines = await client.query<Row>(
      `SELECT * FROM ${table(b.orderLine)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(b.orderLine.legalEntity!.column)}=$3
          AND ${relation(b, b.orderLine, spec.relations.orderLineOrder)}=$4
          AND archived_at IS NULL
        ORDER BY ${quote(lineField('line_number'))}, record_id`,
      [...scope, le, orderId],
    );
    // What this order's lines progressed, read for those lines only.
    const progressed = await progressByOrderLine(
      client,
      spec,
      b,
      {
        tenantId: request.context.tenantId,
        environmentId: request.context.environmentId,
        legalEntityId: le,
      },
      orderLines.rows.map((row) => String(row.record_id)),
    );
    const live = await this.#liveDocuments(client, request, le, orderId);
    const settledRows = live.length
      ? await client.query<{ line: string; quantity: string }>(
          `SELECT ${relation(b, b.line, spec.relations.lineOrderLine)}::text AS line,
                  sum(${column(b.line, `${spec.entities.line}_quantity`)})::text AS quantity
             FROM ${table(b.line)}
            WHERE tenant_id=$1 AND environment_id=$2
              AND ${quote(b.line.legalEntity!.column)}=$3 AND archived_at IS NULL
              AND ${relation(b, b.line, spec.relations.lineDocument)} = ANY($4::uuid[])
            GROUP BY 1`,
          [...scope, le, live.map((row) => String(row.record_id))],
        )
      : { rows: [] };
    const settled = new Map(
      settledRows.rows.map((row) => [row.line, quantity(row.quantity)]),
    );
    const lines: {
      readonly orderLine: Row;
      readonly quantity: bigint;
      readonly unit: unknown;
      readonly amounts: LineAmounts;
    }[] = [];
    for (const line of orderLines.rows) {
      const id = String(line.record_id);
      const progress = progressed.get(id);
      const eligible = (progress?.quantity ?? 0n) - (settled.get(id) ?? 0n);
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
        throw refused(spec.codes.lineUnpriced, spec.messages.lineUnpriced);
      lines.push({
        orderLine: line,
        quantity: eligible,
        unit:
          spec.fields.unitFrom === 'progress'
            ? progress!.unit
            : line[lineField('unit_id')],
        amounts,
      });
    }
    if (lines.length === 0)
      throw refused(spec.codes.nothingToSettle, spec.messages.nothingToSettle);
    // The order's charges go on its first document that is not void.
    const chargesField = unquote(documentField('charges'));
    const charged = live.some((row) => (cents(row[chargesField]) ?? 0n) > 0n);
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
      throw refused(spec.codes.lineUnpriced, spec.messages.chargesUnpriced);
    const sum = (values: readonly bigint[]) =>
      values.reduce((total, value) => total + value, 0n);
    const subtotal = sum(lines.map((line) => line.amounts.amountCents));
    const chargeTotal = sum(charges.map((charge) => charge!.amountCents));
    const tax = sum([
      ...lines.map((line) => line.amounts.taxCents),
      ...charges.map((charge) => charge!.taxCents),
    ]);
    const total = subtotal + chargeTotal + tax;
    // Line records, written with the document they belong to.
    const documentLineField = (name: string) =>
      column(b.line, `${spec.entities.line}_${name}`);
    for (const [index, line] of lines.entries())
      await client.query(
        `INSERT INTO ${table(b.line)}
          (tenant_id,environment_id,${quote(b.line.legalEntity!.column)},record_id,revision,archived_at,
           ${relation(b, b.line, spec.relations.lineDocument)},
           ${relation(b, b.line, spec.relations.lineOrderLine)},
           ${documentLineField('line_number')},${documentLineField('item_id')},
           ${documentLineField('unit_id')},${documentLineField('quantity')},
           ${documentLineField('unit_price')},${documentLineField('discount_percent')},
           ${documentLineField('tax_rate_percent')},${documentLineField('amount')},
           ${documentLineField('tax')})
         VALUES ($1,$2,$3,$4,1,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          ...scope,
          le,
          randomUUID(),
          prepared.recordId,
          String(line.orderLine.record_id),
          index + 1,
          line.orderLine[lineField('item_id')],
          line.unit,
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
            terms.endsWith(
              `:option.${spec.entities.order}_payment_terms_${local}`,
            ),
          ) ?? null)
        : null;
    // The document date is the posting instant when the family says so;
    // otherwise the draft's own date.
    const documentDate = instantText(
      spec.datedAtPost
        ? this.context.currentInstant()
        : document[unquote(documentField(spec.fields.documentDate))],
    );
    const due = new Date(
      Date.parse(documentDate) +
        (TERMS_DAYS[termsLocal ?? 'due_on_receipt'] ?? 0) * 86_400_000,
    ).toISOString();
    const state = this.#documentState(total > 0n ? 'open' : 'paid');
    const values: (readonly [string, unknown])[] = [
      [documentField('state'), state],
      [
        documentField(spec.fields.counterparty),
        orderField(spec.fields.counterparty),
      ],
      [documentField('currency'), orderField('currency')],
      [
        documentField('payment_terms'),
        termsLocal
          ? option(
              b.document,
              `${spec.entities.document}_payment_terms`,
              termsLocal,
            )
          : null,
      ],
      ...(spec.datedAtPost
        ? [[documentField(spec.fields.documentDate), documentDate] as const]
        : []),
      [documentField('due_date'), due],
      [documentField('subtotal'), formatCents(subtotal)],
      [documentField('charges'), formatCents(chargeTotal)],
      [documentField('tax'), formatCents(tax)],
      [documentField('total'), formatCents(total)],
      [documentField('paid_amount'), '0.00'],
      [documentField('credited_amount'), '0.00'],
      [documentField('balance'), formatCents(total)],
    ];
    const revision = await this.#update(
      client,
      request,
      b.document,
      le,
      prepared.recordId,
      prepared.expectedRevision,
      values,
    );
    return {
      revision,
      changes: [
        { field: `${b.document.entityId}.state`, before: draft, after: state },
        {
          field: `${b.document.entityId}.total`,
          before: null,
          after: formatCents(total),
        },
      ],
      metadata: {
        orderId,
        [spec.metadataKeys.lines]: lines.map((line) =>
          String(line.orderLine.record_id),
        ),
      },
    };
  }

  async #void(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    const spec = this.#spec;
    const b = this.#binding;
    const document = await this.#target(client, request, prepared);
    const field = (name: string) => this.#documentField(name);
    const state = String(document[unquote(field('state'))]);
    // Open: posted with nothing settled; a zero-total document posts as paid.
    if (
      state !== this.#documentState('open') &&
      state !== this.#documentState('paid')
    )
      throw refused(spec.codes.documentState, spec.messages.voidState);
    if (
      (cents(document[unquote(field('paid_amount'))]) ?? 0n) !== 0n ||
      (cents(document[unquote(field('credited_amount'))]) ?? 0n) !== 0n
    )
      throw refused(spec.codes.settled, spec.messages.voidSettled);
    const after = this.#documentState('void');
    const revision = await this.#update(
      client,
      request,
      b.document,
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
      changes: [
        { field: `${b.document.entityId}.state`, before: state, after },
      ],
      metadata: {},
    };
  }

  /** A payment or a credit posts against one open document's balance. */
  async #settle(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    const spec = this.#spec;
    const b = this.#binding;
    const le = prepared.legalEntityId;
    const kind = prepared.action === 'pay' ? 'payment' : 'credit';
    const local =
      kind === 'payment' ? spec.entities.payment : spec.entities.credit;
    const entity = prepared.entity;
    const settlement = await this.#target(client, request, prepared);
    const field = (name: string) => column(entity, `${local}_${name}`);
    const draft = option(entity, `${local}_state`, 'draft');
    if (settlement[unquote(field('state'))] !== draft)
      throw refused(spec.codes.documentState, spec.messages.settleDraft(kind));
    const amount = cents(settlement[unquote(field('amount'))]);
    if (amount === null || amount <= 0n)
      throw refused(spec.codes.amountInvalid, spec.messages.amountInvalid);
    const documentId = String(
      settlement[
        unquote(
          relation(
            b,
            entity,
            kind === 'payment'
              ? spec.relations.paymentDocument
              : spec.relations.creditDocument,
          ),
        )
      ],
    );
    const document = await this.#row(
      client,
      request,
      b.document,
      le,
      documentId,
    );
    const documentField = (name: string) => this.#documentField(name);
    const documentState = document[unquote(documentField('state'))];
    if (
      document.archived_at !== null ||
      (documentState !== this.#documentState('open') &&
        documentState !== this.#documentState('partially_paid'))
    )
      throw refused(spec.codes.documentState, spec.messages.settleState(kind));
    const balance = cents(document[unquote(documentField('balance'))]) ?? 0n;
    if (amount > balance)
      throw refused(
        spec.codes.amountExceedsBalance,
        spec.messages.exceedsBalance(kind),
      );
    const settledField = kind === 'payment' ? 'paid_amount' : 'credited_amount';
    const before = cents(document[unquote(documentField(settledField))]) ?? 0n;
    const remaining = balance - amount;
    await this.#update(
      client,
      request,
      b.document,
      le,
      documentId,
      Number(document.revision),
      [
        [documentField(settledField), formatCents(before + amount)],
        [documentField('balance'), formatCents(remaining)],
        [
          documentField('state'),
          this.#documentState(remaining === 0n ? 'paid' : 'partially_paid'),
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
          field: `${b.document.entityId}.balance`,
          before: formatCents(balance),
          after: formatCents(remaining),
        },
      ],
      metadata: { [spec.metadataKeys.document]: documentId },
    };
  }

  /**
   * The cents an order totals -- its live lines' amounts and taxes, and its
   * charges with theirs -- or `null` when any of them cannot be stated.
   */
  async #orderTotals(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    orders: readonly Row[],
  ): Promise<ReadonlyMap<string, bigint | null>> {
    const spec = this.#spec;
    const b = this.#binding;
    const totals = new Map<string, bigint | null>();
    if (!orders.length) return totals;
    const lineField = (name: string) =>
      unquote(column(b.orderLine, `${spec.entities.orderLine}_${name}`));
    const orderRelation = relation(
      b,
      b.orderLine,
      spec.relations.orderLineOrder,
    );
    const lines = await client.query<Row & { order_id: string }>(
      `SELECT *, ${orderRelation}::text AS order_id FROM ${table(b.orderLine)}
        WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL
          AND ${orderRelation} = ANY($3::uuid[])`,
      [...this.#scope(request), orders.map((order) => String(order.record_id))],
    );
    const byOrder = new Map<string, Row[]>();
    for (const line of lines.rows)
      byOrder.set(line.order_id, [...(byOrder.get(line.order_id) ?? []), line]);
    for (const order of orders) {
      const orderField = (name: string) =>
        order[unquote(column(b.order, `${spec.entities.order}_${name}`))];
      totals.set(
        String(order.record_id),
        orderTotalCents(
          (byOrder.get(String(order.record_id)) ?? []).map((line) => ({
            quantity: line[lineField('ordered_quantity')],
            unitPrice: line[lineField('unit_price')],
            discountPercent: line[lineField('discount_percent')],
            taxRatePercent: frozenRate(
              line[lineField('tax_code_id')],
              line[lineField('tax_rate_percent')],
            ),
          })),
          (['freight', 'other_fee'] as const).map((charge) => ({
            amount: orderField(`${charge}_amount`),
            taxRatePercent: frozenRate(
              orderField(`${charge}_tax_code_id`),
              orderField(`${charge}_tax_rate_percent`),
            ),
          })),
        ),
      );
    }
    return totals;
  }

  /**
   * What a customer owes and will owe in one currency, across every company
   * of the tenant (SALES-EXTRAS): its open and partially paid invoices'
   * balances, plus each of its confirmed orders' total not yet on a live
   * invoice (never below zero). `null` when a confirmed order's total cannot
   * be stated. The order being confirmed is not among them.
   */
  async #exposure(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    customer: string,
    currency: string,
    exceptOrderId: string,
  ): Promise<bigint | null> {
    const spec = this.#spec;
    const b = this.#binding;
    const scope = this.#scope(request);
    const documentField = (name: string) => this.#documentField(name);
    const open = await client.query<{ balance: string | null }>(
      `SELECT ${documentField('balance')}::text AS balance FROM ${table(b.document)}
        WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL
          AND ${documentField(spec.fields.counterparty)}=$3
          AND ${documentField('currency')}=$4
          AND ${documentField('state')} IN ($5,$6)`,
      [
        ...scope,
        customer,
        currency,
        this.#documentState('open'),
        this.#documentState('partially_paid'),
      ],
    );
    let exposure = 0n;
    for (const row of open.rows) exposure += cents(row.balance) ?? 0n;
    const orderField = (name: string) =>
      column(b.order, `${spec.entities.order}_${name}`);
    const stateColumn = column(
      b.order,
      `derived_state_field.machine.${spec.entities.order}_lifecycle`,
    );
    const released = `${b.order.entityId.split(':')[0]!}:state.${spec.entities.order}_released`;
    const orders = await client.query<Row>(
      `SELECT * FROM ${table(b.order)}
        WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL
          AND ${orderField(spec.fields.counterparty)}=$3
          AND ${orderField('currency')}=$4
          AND ${stateColumn}=$5 AND record_id <> $6::uuid`,
      [...scope, customer, currency, released, exceptOrderId],
    );
    if (!orders.rows.length) return exposure;
    const totals = await this.#orderTotals(client, request, orders.rows);
    const documentOrder = relation(b, b.document, spec.relations.documentOrder);
    const invoiced = await client.query<{ order_id: string; total: string }>(
      `SELECT ${documentOrder}::text AS order_id,
              sum(${documentField('total')})::text AS total
         FROM ${table(b.document)}
        WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL
          AND ${documentOrder} = ANY($3::uuid[])
          AND ${documentField('state')} IN ($4,$5,$6)
        GROUP BY 1`,
      [
        ...scope,
        orders.rows.map((order) => String(order.record_id)),
        this.#documentState('open'),
        this.#documentState('partially_paid'),
        this.#documentState('paid'),
      ],
    );
    const invoicedByOrder = new Map(
      invoiced.rows.map((row) => [row.order_id, cents(row.total) ?? 0n]),
    );
    for (const order of orders.rows) {
      const total = totals.get(String(order.record_id));
      if (total === null || total === undefined) return null;
      const remaining =
        total - (invoicedByOrder.get(String(order.record_id)) ?? 0n);
      if (remaining > 0n) exposure += remaining;
    }
    return exposure;
  }

  /**
   * A draft order is confirmed (SALES-EXTRAS) when it states every field a
   * confirmed order needs and its customer's credit allows it: the customer
   * is not on credit hold, and -- when it has a limit -- what it already owes
   * on open invoices and confirmed orders not yet invoiced, plus this
   * order's total, stays within the limit, all in the limit's currency (the
   * customer's own; nothing is converted). Every confirmation of one
   * customer's orders takes one transaction lock on that customer before the
   * order's row, so two orders cannot both fit under the same headroom.
   */
  async #confirm(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    const spec = this.#spec;
    const b = this.#binding;
    const confirm = spec.confirm;
    const codes = spec.codes;
    const messages = spec.messages;
    const party = b.party;
    if (
      !confirm ||
      !party ||
      !codes.orderNotConfirmable ||
      !codes.customerOnHold ||
      !codes.creditLimitExceeded ||
      !codes.creditCurrencyMismatch ||
      !codes.creditUnstated ||
      !messages.confirmState ||
      !messages.confirmRequired ||
      !messages.customerOnHold ||
      !messages.creditLimitExceeded ||
      !messages.creditCurrencyMismatch ||
      !messages.creditUnstated
    )
      throw refused('INVENTORY_POSTING_INPUT_INVALID', spec.refusalReason);
    const counterpartyColumn = column(
      b.order,
      `${spec.entities.order}_${spec.fields.counterparty}`,
    );
    const peek = await client.query<{ counterparty: string | null }>(
      `SELECT ${counterpartyColumn}::text AS counterparty FROM ${table(b.order)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(b.order.legalEntity!.column)}=$3 AND record_id=$4`,
      [...this.#scope(request), prepared.legalEntityId, prepared.recordId],
    );
    const customer = peek.rows[0]?.counterparty ?? null;
    if (typeof customer === 'string' && customer !== '')
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(
           $1::text || ':' || $2::text || ':' || $3::text || ':credit:' ||
           $4::text, 0))`,
        [...this.#scope(request), spec.capabilityId, customer],
      );
    const order = await this.#target(client, request, prepared);
    const orderField = (name: string) =>
      order[unquote(column(b.order, `${spec.entities.order}_${name}`))];
    if ((orderField(spec.fields.counterparty) ?? null) !== customer)
      throw refused(
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
        messages.orderChanged ?? messages.recordChanged,
      );
    const stateColumn = column(
      b.order,
      `derived_state_field.machine.${spec.entities.order}_lifecycle`,
    );
    const before = String(order[unquote(stateColumn)]);
    if (!before.endsWith(`:state.${spec.entities.order}_draft`))
      throw refused(codes.orderNotConfirmable, messages.confirmState);
    // As the declared precondition reads them: present and not empty.
    if (
      confirm.required.some((name) => {
        const value = orderField(name);
        return typeof value !== 'string' || value === '';
      })
    )
      throw refused(codes.orderNotConfirmable, messages.confirmRequired);
    if (typeof customer === 'string' && customer !== '') {
      const partyField = (name: string) => unquote(column(party, name));
      // Read whatever the customer's state: an archived customer's hold
      // and limit still stand.
      const master = (
        await client.query<Row>(
          `SELECT * FROM ${table(party)}
            WHERE tenant_id=$1 AND environment_id=$2 AND record_id::text=$3`,
          [...this.#scope(request), customer],
        )
      ).rows[0];
      if (master?.[partyField(confirm.hold)] === true)
        throw refused(codes.customerOnHold, messages.customerOnHold);
      const limit = creditLimitCents(master?.[partyField(confirm.limit)]);
      if (master && limit !== null) {
        const currency = String(orderField('currency') ?? '');
        const stored = master[partyField(confirm.currency)];
        const marker = `:option.${confirm.currency}_`;
        const limitCurrency =
          typeof stored === 'string' && stored.includes(marker)
            ? stored.slice(stored.indexOf(marker) + marker.length).toUpperCase()
            : null;
        if (limitCurrency === null || limitCurrency !== currency.toUpperCase())
          throw refused(
            codes.creditCurrencyMismatch,
            messages.creditCurrencyMismatch(limitCurrency),
          );
        const total = (await this.#orderTotals(client, request, [order])).get(
          prepared.recordId,
        );
        const exposure = await this.#exposure(
          client,
          request,
          customer,
          currency,
          prepared.recordId,
        );
        if (total === null || total === undefined || exposure === null)
          throw refused(codes.creditUnstated, messages.creditUnstated);
        if (exposure + total > limit)
          throw refused(
            codes.creditLimitExceeded,
            messages.creditLimitExceeded(
              formatCents(exposure + total - limit),
              currency,
            ),
          );
      }
    }
    const after = `${before.slice(0, -`${spec.entities.order}_draft`.length)}${spec.entities.order}_released`;
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

  /** A closed order reopens while no document of it counts. */
  async #reopen(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    const spec = this.#spec;
    const b = this.#binding;
    const code = spec.codes.orderNotReopenable;
    if (!code || !spec.messages.reopenState || !spec.messages.reopenSettled)
      throw refused('INVENTORY_POSTING_INPUT_INVALID', spec.refusalReason);
    const order = await this.#target(client, request, prepared);
    const stateColumn = column(
      b.order,
      `derived_state_field.machine.${spec.entities.order}_lifecycle`,
    );
    const before = String(order[unquote(stateColumn)]);
    if (!before.endsWith(`:state.${spec.entities.order}_closed`))
      throw refused(code, spec.messages.reopenState);
    if (
      (
        await this.#liveDocuments(
          client,
          request,
          prepared.legalEntityId,
          prepared.recordId,
        )
      ).length > 0
    )
      throw refused(code, spec.messages.reopenSettled);
    const after = `${before.slice(0, -`${spec.entities.order}_closed`.length)}${spec.entities.order}_released`;
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

/** The capability executor factory for one settlement family. */
export function settlementCapabilityExecutorFactory(
  spec: SettlementSpec,
): PostgresCapabilityOperationExecutorFactory {
  return Object.freeze({
    capabilityId: spec.capabilityId,
    verificationRefusal: {
      code: 'INVENTORY_POSTING_INPUT_INVALID',
      reason: `INVENTORY_POSTING_INPUT_INVALID: ${spec.refusalReason}`,
    },
    create(context: PostgresCapabilityOperationExecutorContext) {
      const projection = context.projection(
        PROJECTION_FAMILY_IDS.storageTarget,
      );
      const storage = projection.payload as StorageTargetPayloadV1;
      if (storage.kind !== 'storageTargetPayload')
        throw refused(
          'INVENTORY_POSTING_STORAGE_INVALID',
          'Expected active storage target',
        );
      return new SettlementCapabilityExecutor(context, storage, spec);
    },
  } satisfies PostgresCapabilityOperationExecutorFactory);
}
