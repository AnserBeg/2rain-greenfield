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
import { formatCents, parseExact } from './commercial-amounts.js';
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
 * Returnable assets (RETURNABLE-ASSETS): pallets, kegs and crates out with a
 * customer or held from a supplier against a refundable deposit, kept OFF the
 * stock ledger -- nothing here writes an inventory movement or a balance.
 *
 * One command, `returnable_event_post`, posts a draft event of a custody
 * record under the custody's row lock: an Issue (more assets handed over and
 * the deposit taken on them at the custody's unit deposit), a Return, a
 * Forfeit (the deposit on assets that will not come back is kept) or a
 * deposit Refund. The custody's figures are restated from its posted events,
 * which only this command posts, so return plus forfeit never exceeds what was
 * issued and a refund never exceeds the deposit taken on what came back. A
 * deposit taken or refunded is a receivables fact recorded on its event with
 * the method entered by hand -- cash, cheque or bank transfer -- in the
 * custody's currency: no ledger, no provider, no other currency.
 */
export const RETURNABLES_CAPABILITY_ID =
  'northstar.party:capability.returnables' as const;
export const RETURNABLES_CAPABILITY_VERSION = 1 as const;

const REFUSAL_REASON =
  'Only the named returnables operation is admitted by this route';

type Entity = StorageTargetPayloadV1['entities'][number];
type Row = Record<string, unknown>;

export type ReturnableEventKind = 'issue' | 'return' | 'forfeit' | 'refund';

/** The custody figures, as whole assets and cents, before and after a post. */
export interface CustodyFigures {
  readonly issued: bigint;
  readonly returned: bigint;
  readonly forfeited: bigint;
  /** Deposit taken on issues, refunded, and kept on forfeits, in cents. */
  readonly taken: bigint;
  readonly refunded: bigint;
  readonly kept: bigint;
}

export type CustodyState = 'new' | 'open' | 'awaiting_refund' | 'closed';

/** What the custody states from its figures and frozen unit deposit. */
export function custodyStatement(
  figures: CustodyFigures,
  unitCents: bigint | null,
): {
  readonly outstanding: bigint;
  readonly held: bigint;
  readonly refundable: bigint;
  readonly state: CustodyState;
} {
  const outstanding = figures.issued - figures.returned - figures.forfeited;
  const held = figures.taken - figures.refunded - figures.kept;
  // The deposit on what came back, less what was paid back of it.
  const refundable =
    unitCents === null ? 0n : figures.returned * unitCents - figures.refunded;
  return {
    outstanding,
    held,
    refundable,
    state:
      figures.issued === 0n
        ? 'new'
        : outstanding > 0n
          ? 'open'
          : refundable > 0n
            ? 'awaiting_refund'
            : 'closed',
  };
}

/**
 * One event applied to a custody's figures, or the refusal it earns. Pure:
 * the executor reads the figures under the custody's row lock, applies the
 * event here and writes what this returns. `quantity` is in whole assets and
 * `amount` (a refund's) in cents.
 */
export function applyReturnableEvent(
  figures: CustodyFigures,
  unitCents: bigint,
  event: Readonly<{
    kind: ReturnableEventKind;
    quantity: bigint | null;
    amount: bigint | null;
  }>,
):
  | { readonly figures: CustodyFigures; readonly amount: bigint | null }
  | { readonly refused: InventoryPostingErrorCode; readonly message: string } {
  const outstanding = figures.issued - figures.returned - figures.forfeited;
  if (event.kind === 'refund') {
    if (event.quantity !== null)
      return {
        refused: 'RETURNABLES_QUANTITY_INVALID',
        message: 'A deposit refund names an amount, not a quantity',
      };
    if (event.amount === null || event.amount <= 0n)
      return {
        refused: 'RETURNABLES_AMOUNT_INVALID',
        message: 'An amount is a positive figure in whole cents',
      };
    const refundable = figures.returned * unitCents - figures.refunded;
    if (event.amount > refundable)
      return {
        refused: 'RETURNABLES_REFUND_EXCEEDS_DEPOSIT',
        message:
          'A refund may not exceed the deposit taken on the assets that came back, less what was refunded',
      };
    return {
      figures: { ...figures, refunded: figures.refunded + event.amount },
      amount: event.amount,
    };
  }
  if (event.quantity === null || event.quantity <= 0n)
    return {
      refused: 'RETURNABLES_QUANTITY_INVALID',
      message: 'A quantity is a positive whole number of assets',
    };
  if (event.kind === 'issue') {
    const amount = event.quantity * unitCents;
    return {
      figures: {
        ...figures,
        issued: figures.issued + event.quantity,
        taken: figures.taken + amount,
      },
      amount,
    };
  }
  if (event.quantity > outstanding)
    return {
      refused: 'RETURNABLES_QUANTITY_EXCEEDS_OUTSTANDING',
      message:
        'Returned and forfeited assets together may not exceed what was issued',
    };
  if (event.kind === 'return')
    return {
      figures: { ...figures, returned: figures.returned + event.quantity },
      amount: null,
    };
  const kept = event.quantity * unitCents;
  return {
    figures: {
      ...figures,
      forfeited: figures.forfeited + event.quantity,
      kept: figures.kept + kept,
    },
    amount: kept,
  };
}

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
  const found = entity.columns.filter((entry) =>
    entry.canonicalFieldId.endsWith(`:field.${suffix}`),
  );
  if (found.length !== 1)
    throw refused(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing field ${suffix}`,
    );
  return quote(found[0]!.physicalName);
}

const unquote = (identifier: string) => identifier.slice(1, -1);

function option(entity: Entity, field: string, suffix: string): string {
  const found = entity.columns
    .find((entry) => entry.canonicalFieldId.endsWith(`:field.${field}`))
    ?.fieldContract.enumOptionIds.find((entry) =>
      entry.endsWith(`:option.${suffix}`),
    );
  if (!found)
    throw refused(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing option ${field}/${suffix}`,
    );
  return found;
}

interface Binding {
  readonly target: StorageTargetPayloadV1;
  readonly assetType: Entity;
  readonly custody: Entity;
  readonly event: Entity;
  readonly role: Entity;
}

/** The returnables entities in one active storage target, each exactly once. */
export function returnablesBinding(target: StorageTargetPayloadV1): Binding {
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
    assetType: entity('returnable_asset_type'),
    custody: entity('returnable_custody'),
    event: entity('returnable_event'),
    role: entity('party_role'),
  };
}

function relationColumn(binding: Binding, entity: Entity, local: string) {
  const found = binding.target.relations.find((entry) =>
    entry.relationId.endsWith(`:relation.${local}`),
  );
  if (!found || found.sourceEntityId !== entity.entityId)
    throw refused(
      'INVENTORY_POSTING_STORAGE_INVALID',
      `Missing relation ${local}`,
    );
  return quote(found.relationColumn.physicalName);
}

/** A non-negative exact decimal in whole cents, else `null`. */
function cents(value: unknown): bigint | null {
  const parsed = parseExact(value);
  if (!parsed || parsed.units < 0n) return null;
  if (parsed.scale <= 2) return parsed.units * 10n ** BigInt(2 - parsed.scale);
  const divisor = 10n ** BigInt(parsed.scale - 2);
  return parsed.units % divisor === 0n ? parsed.units / divisor : null;
}

/** A whole number of assets, `null` when absent; refused when fractional. */
function wholeQuantity(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  const parsed = parseExact(value);
  const divisor = parsed ? 10n ** BigInt(parsed.scale) : 1n;
  if (!parsed || parsed.units % divisor !== 0n)
    throw refused(
      'RETURNABLES_QUANTITY_INVALID',
      'A quantity is a positive whole number of assets',
    );
  return parsed.units / divisor;
}

interface Prepared {
  readonly request: RegisteredCapabilityOperationAuthorizationRequest;
  readonly legalEntityId: string;
  readonly recordId: string;
  readonly expectedRevision: number;
}

interface Changed {
  readonly revision: number;
  readonly changes: readonly {
    readonly field: string;
    readonly before: string | null;
    readonly after: string | null;
  }[];
  readonly metadata: Readonly<Record<string, string>>;
}

class ReturnablesCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = RETURNABLES_CAPABILITY_ID;
  readonly #binding: Binding;
  readonly #prepared = new WeakMap<object, Prepared>();

  constructor(
    private readonly context: PostgresCapabilityOperationExecutorContext,
    storage: StorageTargetPayloadV1,
  ) {
    this.#binding = returnablesBinding(storage);
  }

  async prepareAuthorization(
    request: RegisteredCapabilityOperationAuthorizationRequest,
  ): Promise<RegisteredCapabilityOperationAuthorization> {
    const entity = this.#binding.event;
    const input = request.input;
    const scope = request.readBackDefinition.legalEntityScope;
    if (
      !request.definition.operationId.endsWith(
        ':operation.returnable_event_post',
      ) ||
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
      throw refused('INVENTORY_POSTING_INPUT_INVALID', REFUSAL_REASON);
    const recordId = input.recordId;
    const target = await withTrustedRequestTransaction(
      this.context.pool,
      request.context,
      async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        return withModuleRuntimeRole(client, async () => {
          const result = await client.query<Row>(
            `SELECT * FROM ${table(entity)}
              WHERE tenant_id=$1 AND environment_id=$2 AND record_id::text=$3
                AND archived_at IS NULL`,
            [request.context.tenantId, request.context.environmentId, recordId],
          );
          if (result.rows.length !== 1)
            throw refused(
              'INVENTORY_POSTING_INPUT_INVALID',
              'Returnable event is missing or archived',
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
        'Returnables authorization is not bound to this execution',
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
          const changed = await this.#post(client, request, prepared);
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
                { classification: 'INTERNAL' as const, value },
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
                recordType: this.#binding.event.entityId,
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
                eventSchemaVersion: 'northstar.returnables-event/v1',
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
          'Returnables change did not read back exactly',
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

  /** One company-owned row, locked; `null` when it is not there. */
  async #locked(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    entity: Entity,
    legalEntityId: string,
    recordId: string,
  ): Promise<Row | null> {
    const result = await client.query<Row>(
      `SELECT * FROM ${table(entity)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(entity.legalEntity!.column)}=$3 AND record_id::text=$4
        FOR NO KEY UPDATE`,
      [
        request.context.tenantId,
        request.context.environmentId,
        legalEntityId,
        recordId,
      ],
    );
    return result.rows[0] ?? null;
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
        request.context.tenantId,
        request.context.environmentId,
        legalEntityId,
        recordId,
        revision,
        ...values.map(([, value]) => value),
      ],
    );
    if (updated.rows.length !== 1)
      throw refused(
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
        'A returnables record changed during the operation',
      );
    return Number(updated.rows[0]!.revision);
  }

  async #post(
    client: PoolClient,
    request: RegisteredCapabilityOperationExecutionRequest,
    prepared: Prepared,
  ): Promise<Changed> {
    const b = this.#binding;
    const le = prepared.legalEntityId;
    const scope = [request.context.tenantId, request.context.environmentId];
    const eventField = (name: string) =>
      column(b.event, `returnable_event_${name}`);
    const custodyField = (name: string) =>
      column(b.custody, `returnable_custody_${name}`);
    const typeField = (name: string) =>
      column(b.assetType, `returnable_asset_type_${name}`);
    const eventOption = (name: string, value: string) =>
      option(
        b.event,
        `returnable_event_${name}`,
        `returnable_event_${name}_${value}`,
      );
    const custodyOption = (name: string, value: string) =>
      option(
        b.custody,
        `returnable_custody_${name}`,
        `returnable_custody_${name}_${value}`,
      );

    // The event, at exactly the revision the caller last read, still a draft.
    const event = await this.#locked(
      client,
      request,
      b.event,
      le,
      prepared.recordId,
    );
    if (
      !event ||
      event.archived_at !== null ||
      Number(event.revision) !== prepared.expectedRevision
    )
      throw refused(
        'INVENTORY_TRANSACTION_STATE_CONFLICT',
        'Returnable event changed after authorization',
      );
    const draft = eventOption('state', 'draft');
    if (event[unquote(eventField('state'))] !== draft)
      throw refused(
        'RETURNABLES_EVENT_STATE_CONFLICT',
        'Only a draft event posts',
      );
    const kinds: readonly ReturnableEventKind[] = [
      'issue',
      'return',
      'forfeit',
      'refund',
    ];
    const kind = kinds.find(
      (value) =>
        event[unquote(eventField('kind'))] === eventOption('kind', value),
    );
    if (!kind)
      throw refused('INVENTORY_POSTING_STORAGE_INVALID', 'Unknown event kind');

    // The custody record, locked: every post of it serializes here, so two
    // events can never both take the same outstanding quantity or deposit.
    const custodyId = String(
      event[unquote(relationColumn(b, b.event, 'returnable_event_custody'))],
    );
    const custody = await this.#locked(
      client,
      request,
      b.custody,
      le,
      custodyId,
    );
    if (!custody || custody.archived_at !== null)
      throw refused(
        'RETURNABLES_CUSTODY_UNAVAILABLE',
        'The custody record is missing or archived',
      );
    const custodyValue = (name: string) => custody[unquote(custodyField(name))];
    const partyId = String(custodyValue('party_id'));
    const link = (local: string) =>
      String(custody[unquote(relationColumn(b, b.custody, local))]);
    if (link('returnable_custody_party') !== partyId)
      throw refused(
        'RETURNABLES_CUSTODY_INVALID',
        "The custody record's party and its party link differ",
      );
    // The type link is what keeps the type from being archived under a live
    // custody; the field is what the Lists label and the key reads.
    if (
      link('returnable_custody_asset_type') !==
      String(custodyValue('asset_type_id'))
    )
      throw refused(
        'RETURNABLES_CUSTODY_INVALID',
        "The custody record's returnable type and its type link differ",
      );
    const direction = ['out', 'held'].find(
      (value) =>
        custodyValue('direction') === custodyOption('direction', value),
    );
    const currency = ['cad', 'usd', 'eur'].find(
      (value) => custodyValue('currency') === custodyOption('currency', value),
    );
    if (!direction || !currency)
      throw refused(
        'INVENTORY_POSTING_STORAGE_INVALID',
        'Unknown custody direction or currency',
      );

    // The figures so far, from the custody's posted events: only this
    // command posts one, so nothing written elsewhere can move a bound.
    const posted = await client.query<{
      kind: string;
      quantity: string | null;
      amount: string | null;
    }>(
      `SELECT ${eventField('kind')} AS kind,
              sum(${eventField('quantity')})::text AS quantity,
              sum(${eventField('amount')})::text AS amount
         FROM ${table(b.event)}
        WHERE tenant_id=$1 AND environment_id=$2
          AND ${quote(b.event.legalEntity!.column)}=$3
          AND ${relationColumn(b, b.event, 'returnable_event_custody')}=$4
          AND archived_at IS NULL AND ${eventField('state')}=$5
        GROUP BY 1`,
      [...scope, le, custodyId, eventOption('state', 'posted')],
    );
    const sums = (value: ReturnableEventKind) =>
      posted.rows.find((row) => row.kind === eventOption('kind', value));
    const storedQuantity = (value: ReturnableEventKind) =>
      wholeQuantity(sums(value)?.quantity ?? null) ?? 0n;
    const storedCents = (value: ReturnableEventKind) => {
      const raw = sums(value)?.amount ?? null;
      if (raw === null) return 0n;
      const amount = cents(raw);
      if (amount === null)
        throw refused(
          'INVENTORY_POSTING_STORAGE_INVALID',
          'A posted deposit is not in whole cents',
        );
      return amount;
    };
    const before: CustodyFigures = {
      issued: storedQuantity('issue'),
      returned: storedQuantity('return'),
      forfeited: storedQuantity('forfeit'),
      taken: storedCents('issue'),
      refunded: storedCents('refund'),
      kept: storedCents('forfeit'),
    };

    // The unit deposit is frozen at the first Issue from the returnable type
    // in the custody's currency; every later event uses that figure.
    let unitCents: bigint | null =
      before.issued > 0n ? cents(custodyValue('unit_deposit')) : null;
    if (before.issued > 0n && unitCents === null)
      throw refused(
        'INVENTORY_POSTING_STORAGE_INVALID',
        "The custody's unit deposit is not stated",
      );
    if (kind === 'issue') {
      const role = await client.query(
        `SELECT 1 FROM ${table(b.role)}
          WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL
            AND ${relationColumn(b, b.role, 'party_role_party')}::text=$3
            AND ${column(b.role, 'party_role_kind')}=$4
            AND ${column(b.role, 'party_role_status')}=$5
          LIMIT 1`,
        [
          ...scope,
          partyId,
          option(
            b.role,
            'party_role_kind',
            direction === 'out' ? 'customer' : 'supplier',
          ),
          option(b.role, 'party_role_status', 'active'),
        ],
      );
      if (role.rows.length === 0)
        throw refused(
          'RETURNABLES_PARTY_ROLE_MISSING',
          direction === 'out'
            ? 'Only a party with an active customer role holds our returnables'
            : 'We hold returnables only of a party with an active supplier role',
        );
      if (before.issued === 0n) {
        const type = await client.query<Row>(
          `SELECT * FROM ${table(b.assetType)}
            WHERE tenant_id=$1 AND environment_id=$2 AND archived_at IS NULL
              AND record_id::text=$3`,
          [...scope, String(custodyValue('asset_type_id'))],
        );
        if (type.rows.length !== 1)
          throw refused(
            'RETURNABLES_TYPE_UNAVAILABLE',
            'The returnable type is missing or archived',
          );
        const stated = type.rows[0]![unquote(typeField(`deposit_${currency}`))];
        if (stated === null || stated === undefined)
          throw refused(
            'RETURNABLES_DEPOSIT_UNSTATED',
            `State the returnable type's ${currency.toUpperCase()} deposit (0 for none) before issuing it in ${currency.toUpperCase()}`,
          );
        unitCents = cents(stated);
        if (unitCents === null)
          throw refused(
            'RETURNABLES_AMOUNT_INVALID',
            "The returnable type's deposit is not a figure in whole cents",
          );
        // One custody record per party, type, direction and currency: two
        // first Issues naming the same four serialize on this lock, held to
        // commit, and the second finds the first.
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended(
             $1::text || ':' || $2::text || ':' || $3::text || ':' || $4::text
             || ':' || $5::text || ':' || $6::text || ':' || $7::text || ':' || $8::text, 0))`,
          [
            ...scope,
            RETURNABLES_CAPABILITY_ID,
            le,
            partyId,
            String(custodyValue('asset_type_id')),
            direction,
            currency,
          ],
        );
        const duplicate = await client.query<{ number: string }>(
          `SELECT ${custodyField('number')}::text AS number
             FROM ${table(b.custody)}
            WHERE tenant_id=$1 AND environment_id=$2
              AND ${quote(b.custody.legalEntity!.column)}=$3
              AND archived_at IS NULL AND record_id::text <> $4
              AND ${custodyField('party_id')}=$5
              AND ${custodyField('asset_type_id')}=$6
              AND ${custodyField('direction')}=$7
              AND ${custodyField('currency')}=$8
              AND ${custodyField('state')} <> $9
            LIMIT 1`,
          [
            ...scope,
            le,
            custodyId,
            partyId,
            String(custodyValue('asset_type_id')),
            custodyValue('direction'),
            custodyValue('currency'),
            custodyOption('state', 'new'),
          ],
        );
        if (duplicate.rows.length > 0)
          throw refused(
            'RETURNABLES_CUSTODY_DUPLICATE',
            `This party already holds this returnable type this way in this currency on ${duplicate.rows[0]!.number}; issue there`,
          );
      }
    }
    if (unitCents === null)
      throw refused(
        'RETURNABLES_NOTHING_ISSUED',
        'Nothing has been issued on this custody record yet',
      );
    const quantity = wholeQuantity(event[unquote(eventField('quantity'))]);
    const given = event[unquote(eventField('amount'))];
    const applied = applyReturnableEvent(before, unitCents, {
      kind,
      quantity,
      amount:
        kind === 'refund'
          ? given === null || given === undefined
            ? null
            : (cents(given) ?? -1n)
          : null,
    });
    if ('refused' in applied) throw refused(applied.refused, applied.message);
    // A deposit taken or paid back names how: entered by hand, no provider.
    const method = event[unquote(eventField('method'))];
    if (
      (kind === 'issue' || kind === 'refund') &&
      applied.amount !== null &&
      applied.amount > 0n &&
      (typeof method !== 'string' || method === '')
    )
      throw refused(
        'RETURNABLES_METHOD_REQUIRED',
        'A deposit taken or refunded names its method: cash, cheque or bank transfer',
      );
    const after = applied.figures;
    const was = custodyStatement(before, before.issued > 0n ? unitCents : null);
    const now = custodyStatement(after, unitCents);
    const quantityText = (value: bigint) => value.toString();
    const postedState = eventOption('state', 'posted');
    const revision = await this.#update(
      client,
      request,
      b.event,
      le,
      prepared.recordId,
      prepared.expectedRevision,
      [
        [eventField('state'), postedState],
        [eventField('event_date'), this.context.currentInstant()],
        [
          eventField('amount'),
          applied.amount === null ? null : formatCents(applied.amount),
        ],
        [eventField('recorded_by'), request.context.principalId],
      ],
    );
    await this.#update(
      client,
      request,
      b.custody,
      le,
      custodyId,
      Number(custody.revision),
      [
        [custodyField('state'), custodyOption('state', now.state)],
        [custodyField('unit_deposit'), formatCents(unitCents)],
        [custodyField('issued_quantity'), quantityText(after.issued)],
        [custodyField('returned_quantity'), quantityText(after.returned)],
        [custodyField('forfeited_quantity'), quantityText(after.forfeited)],
        [custodyField('outstanding_quantity'), quantityText(now.outstanding)],
        [custodyField('deposit_taken'), formatCents(after.taken)],
        [custodyField('deposit_refunded'), formatCents(after.refunded)],
        [custodyField('deposit_forfeited'), formatCents(after.kept)],
        [custodyField('deposit_held'), formatCents(now.held)],
        [custodyField('deposit_refundable'), formatCents(now.refundable)],
      ],
    );
    return {
      revision,
      changes: [
        {
          field: `${b.event.entityId}.state`,
          before: draft,
          after: postedState,
        },
        {
          field: `${b.custody.entityId}.outstanding_quantity`,
          before: quantityText(was.outstanding),
          after: quantityText(now.outstanding),
        },
        {
          field: `${b.custody.entityId}.deposit_held`,
          before: formatCents(was.held),
          after: formatCents(now.held),
        },
      ],
      metadata: {
        custodyId,
        kind,
        ...(quantity === null ? {} : { quantity: quantityText(quantity) }),
        ...(applied.amount === null
          ? {}
          : { amount: formatCents(applied.amount) }),
      },
    };
  }
}

/** The returnables capability executor factory. */
export const RETURNABLES_CAPABILITY_EXECUTOR_FACTORY: PostgresCapabilityOperationExecutorFactory =
  Object.freeze({
    capabilityId: RETURNABLES_CAPABILITY_ID,
    verificationRefusal: {
      code: 'INVENTORY_POSTING_INPUT_INVALID',
      reason: `INVENTORY_POSTING_INPUT_INVALID: ${REFUSAL_REASON}`,
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
      return new ReturnablesCapabilityExecutor(context, storage);
    },
  });
