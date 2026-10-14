import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import type { ImmutableJsonValue } from '@north-star/runtime/request-runtime-view';

import {
  evaluateRegisteredOperationPrecondition,
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
  INVENTORY_POSTING_CAPABILITY_ID,
  INVENTORY_POSTING_CAPABILITY_VERSION,
  INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
  InventoryPostingError,
  PostgresInventoryPostingService,
  type InventoryAdjustmentPostingCommandV1,
  type InventoryTransferPostingCommandV1,
} from './inventory-posting-service.js';
import { withModuleRuntimeRole } from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;
const INVENTORY_POSTING_VERIFICATION_REFUSAL = Object.freeze({
  code: 'INVENTORY_POSTING_INPUT_INVALID',
  reason:
    'INVENTORY_POSTING_INPUT_INVALID: only adjustment and transfer drafts are admitted by this route',
});
/**
 * A stock document posts as its own natural source: the editor stores this
 * pair at first save and the posting command carries the same, so the
 * kernel's draft match and its natural idempotency key both name the document.
 */
const DOCUMENT_SOURCE_TYPE = 'inventoryTransaction';
/** Opening stock is an adjustment with this reason (owner ruling R3). */
const OPENING_REASON = 'OPENING';
type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];
type StorageColumnTarget = StorageEntityTarget['columns'][number];

interface InventoryDraftBinding {
  readonly balance: Readonly<{
    entity: StorageEntityTarget;
    itemId: string;
    legalEntityColumn: string;
    locationId: string;
    postedQuantity: string;
  }>;
  readonly legalEntityColumn: string;
  readonly line: StorageEntityTarget;
  readonly lineFields: Readonly<{
    fromLocationId: string;
    itemId: string;
    lineNumber: string;
    quantity: string;
    toLocationId: string;
    unitId: string;
  }>;
  readonly lineTransactionColumn: string;
  readonly transaction: StorageEntityTarget;
}

interface HydratedAdjustmentDraft {
  readonly currentRevision: number;
  /** The stored type: the two this route posts. */
  readonly kind: 'adjustment' | 'transfer';
  readonly legalEntityId: string;
  readonly lines: readonly Readonly<{
    readonly fromLocationId: string | null;
    readonly itemId: string;
    readonly lineNumber: string;
    readonly quantity: string;
    readonly toLocationId: string | null;
    readonly transactionLineId: string;
    readonly unitId: string;
  }>[];
  readonly values: Readonly<Record<string, ImmutableJsonValue>>;
}

interface PreparedInventoryPosting {
  readonly definition: RegisteredCapabilityOperationAuthorizationRequest['definition'];
  readonly draft: HydratedAdjustmentDraft;
  readonly input: {
    readonly expectedRevision: number;
    readonly recordId: string;
  };
  readonly inputDigest: string;
  readonly readBackDefinition: RegisteredCapabilityOperationAuthorizationRequest['readBackDefinition'];
  readonly view: RegisteredCapabilityOperationAuthorizationRequest['view'];
}

class InventoryPostingCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = INVENTORY_POSTING_CAPABILITY_ID;
  readonly #binding: InventoryDraftBinding;
  readonly #posting: PostgresInventoryPostingService;
  readonly #prepared = new WeakMap<object, PreparedInventoryPosting>();

  constructor(
    private readonly context: PostgresCapabilityOperationExecutorContext,
    storage: StorageTargetPayloadV1,
    storageContentHash: string,
  ) {
    this.#binding = inventoryDraftBinding(storage);
    this.#posting = new PostgresInventoryPostingService(
      context.pool,
      Object.freeze({
        capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
        capabilityVersion: INVENTORY_POSTING_CAPABILITY_VERSION,
        dependencySetRoot: INVENTORY_POSTING_DEPENDENCY_SET_ROOT,
        releaseContentHash: context.releaseContentHash,
        releaseId: context.releaseId,
        storageTarget: storage,
        storageTargetContentHash: storageContentHash,
      }),
      Object.freeze({ currentInstant: context.currentInstant }),
    );
  }

  async prepareAuthorization(
    request: RegisteredCapabilityOperationAuthorizationRequest,
  ): Promise<RegisteredCapabilityOperationAuthorization> {
    assertPostingOperation(request, this.#binding);
    const input = postingInput(request.input);
    const draft = await hydrateInventoryDraft(
      this.context,
      this.#binding,
      request.context,
      input.recordId,
    );
    const replay = draft.currentRevision === input.expectedRevision + 1;
    if (!replay && draft.currentRevision !== input.expectedRevision) {
      throw inputError('the rendered command revision is no longer current');
    }
    if (!replay) {
      const precondition = evaluateRegisteredOperationPrecondition(
        request.definition.precondition,
        draft.values,
      );
      if (precondition.outcome !== 'holds') {
        throw inputError(
          precondition.outcome === 'unsupported'
            ? 'the posting precondition is not executable'
            : 'the posting precondition does not hold',
        );
      }
    }
    // What the document asks of the kernel is judged here, so a refusal names
    // the document's own mistake before policy and trust work begin.
    assertDocumentSource(draft, input.recordId);
    assertDocumentLines(draft);
    // Advisory: another posting may still land between this read and the
    // kernel's stock lock (owner ruling R3). A replay of a posted opening is
    // not judged again -- it would see its own stock.
    if (!replay && isOpening(draft))
      await assertOpeningIntoEmptyStock(
        this.context,
        this.#binding,
        request.context,
        draft,
      );
    const scope = request.readBackDefinition.legalEntityScope;
    if (!scope || scope.cardinality !== 'exactlyOne') {
      throw inputError('the posting read-back lacks exact legal-entity scope');
    }
    const authorization = Object.freeze({
      decisionInput: Object.freeze({ legalEntityId: draft.legalEntityId }),
      legalEntityReadScopeIds: Object.freeze([draft.legalEntityId]),
      readBackArguments: Object.freeze({
        [scope.operand.parameterId]: draft.legalEntityId,
        recordId: input.recordId,
      }),
    });
    this.#prepared.set(
      authorization,
      Object.freeze({
        definition: request.definition,
        draft,
        input,
        inputDigest: request.inputDigest,
        readBackDefinition: request.readBackDefinition,
        view: request.view,
      }),
    );
    return authorization;
  }

  async execute(
    request: RegisteredCapabilityOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    assertPostingOperation(request, this.#binding);
    const prepared = this.#prepared.get(request.authorization);
    this.#prepared.delete(request.authorization);
    if (
      !prepared ||
      prepared.definition !== request.definition ||
      prepared.inputDigest !== request.inputDigest ||
      prepared.readBackDefinition !== request.readBackDefinition ||
      prepared.view !== request.view
    ) {
      throw inputError(
        'the posting authorization is not bound to this execution',
      );
    }
    const { draft, input } = prepared;
    // One route, two kernel commands: the stored type decides which (ADR-0027
    // amendment 2026-09-30). The kernel keeps every transfer rule.
    const command =
      draft.kind === 'transfer'
        ? ({
            kind: 'transfer',
            command: transferCommand(request, input, draft),
          } as const)
        : ({
            kind: 'adjustment',
            command: adjustmentCommand(request, input, draft),
          } as const);
    const actor = await this.context.actorIssuer.issue(request.context);
    const posted =
      command.kind === 'transfer'
        ? await this.#posting.postTransfer(
            request.context,
            actor,
            command.command,
          )
        : await this.#posting.postAdjustment(
            request.context,
            actor,
            command.command,
          );
    let readBack;
    try {
      readBack = await this.context.queryGateway.invoke(request.view, {
        arguments: request.authorization.readBackArguments,
        queryId: request.readBackDefinition.queryId,
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      });
    } catch (error) {
      if (error instanceof SemanticQueryPolicyDeniedError) {
        return postingResult(request, posted, null);
      }
      throw error;
    }
    const record = readBack.records.find(
      (candidate) => candidate.recordId === input.recordId,
    );
    if (readBack.outcome !== 'exact' || !record) {
      throw inputError('the posted transaction did not read back exactly');
    }
    return postingResult(request, posted, record);
  }
}

function postingResult(
  request: RegisteredCapabilityOperationExecutionRequest,
  posted:
    | Awaited<ReturnType<PostgresInventoryPostingService['postAdjustment']>>
    | Awaited<ReturnType<PostgresInventoryPostingService['postTransfer']>>,
  readBack: SemanticOperationResultEnvelope['readBack'],
): SemanticOperationResultEnvelope {
  return Object.freeze({
    kind: 'semanticOperationResult',
    operationId: request.definition.operationId,
    outcome: 'succeeded',
    readBack,
    schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
    trust: Object.freeze({
      changeDocumentId: posted.trust.changeDocumentId,
      domainEventId: posted.trust.domainEventId,
      invocationId: posted.trust.invocationId,
      outboxId: posted.trust.outboxId,
    }),
    unsupportedReason: null,
  });
}

/** Inventory owns the sole adapter from its registered capability to posting. */
export const INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY = Object.freeze({
  capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
  verificationRefusal: INVENTORY_POSTING_VERIFICATION_REFUSAL,
  create(context) {
    const projection = context.projection(PROJECTION_FAMILY_IDS.storageTarget);
    return new InventoryPostingCapabilityExecutor(
      context,
      storageTarget(projection.payload),
      projection.contentHash,
    );
  },
} satisfies PostgresCapabilityOperationExecutorFactory);

function assertPostingOperation(
  request:
    | RegisteredCapabilityOperationAuthorizationRequest
    | RegisteredCapabilityOperationExecutionRequest,
  binding: InventoryDraftBinding,
): void {
  if (
    request.definition.effect.capability.targetId !==
      INVENTORY_POSTING_CAPABILITY_ID ||
    request.readBackDefinition.sourceEntityId !== binding.transaction.entityId
  ) {
    throw inputError(
      'the posting capability route is not the admitted operation',
    );
  }
}

/**
 * What an adjustment and a transfer command share: the admitted decision, the
 * stored effective time and reason, and the document itself as the posting
 * source -- the pair the editor stored at first save and the source check
 * compared -- so a replay derives the identical command.
 */
function commandEnvelope(
  request: RegisteredCapabilityOperationExecutionRequest,
  input: { readonly expectedRevision: number; readonly recordId: string },
  draft: HydratedAdjustmentDraft,
) {
  return {
    authorization: Object.freeze({
      decision: 'ALLOW' as const,
      evaluatorVersion: request.policyEvaluatorVersion,
      policyVersion: request.policyVersion,
    }),
    channel: request.channel,
    effectiveAt: requiredInstant(
      draft.values[fieldId(draft.values, 'inventory_transaction_effective_at')],
      'effectiveAt',
    ),
    idempotencyKey: request.idempotencyKey,
    legalEntityId: draft.legalEntityId,
    reason: Object.freeze({
      code: reasonCode(draft) ?? '',
      narrative: nullableText(
        draft.values[
          fieldId(draft.values, 'inventory_transaction_reason_narrative')
        ],
      ),
    }),
    sourceId: input.recordId,
    sourceRevision: input.expectedRevision,
    sourceType: DOCUMENT_SOURCE_TYPE,
    stockDimensionSetVersion: 'v1' as const,
    transactionId: input.recordId,
  };
}

function adjustmentCommand(
  request: RegisteredCapabilityOperationExecutionRequest,
  input: { readonly expectedRevision: number; readonly recordId: string },
  draft: HydratedAdjustmentDraft,
): InventoryAdjustmentPostingCommandV1 {
  return Object.freeze({
    ...commandEnvelope(request, input, draft),
    lines: Object.freeze(
      draft.lines.map((line) => {
        const negative = line.quantity.startsWith('-');
        const locationId = negative ? line.fromLocationId : line.toLocationId;
        if (!locationId) {
          throw inputError(
            'an adjustment line does not name the location implied by its sign',
          );
        }
        return Object.freeze({
          itemId: line.itemId,
          locationId,
          quantityDelta: line.quantity,
          sourceLine: line.lineNumber,
          transactionLineId: line.transactionLineId,
          unitId: line.unitId,
        });
      }),
    ),
  });
}

/** Each line moves its quantity out of From and into To, in one posting. */
function transferCommand(
  request: RegisteredCapabilityOperationExecutionRequest,
  input: { readonly expectedRevision: number; readonly recordId: string },
  draft: HydratedAdjustmentDraft,
): InventoryTransferPostingCommandV1 {
  return Object.freeze({
    ...commandEnvelope(request, input, draft),
    lines: Object.freeze(
      draft.lines.map((line) => {
        if (!line.fromLocationId || !line.toLocationId) {
          throw inputError('a transfer line does not name both locations');
        }
        return Object.freeze({
          fromLocationId: line.fromLocationId,
          itemId: line.itemId,
          quantity: line.quantity,
          sourceLine: line.lineNumber,
          toLocationId: line.toLocationId,
          transactionLineId: line.transactionLineId,
          unitId: line.unitId,
        });
      }),
    ),
  });
}

function reasonCode(draft: HydratedAdjustmentDraft): string | null {
  return nullableText(
    draft.values[fieldId(draft.values, 'inventory_transaction_reason_code')],
  );
}

function isOpening(draft: HydratedAdjustmentDraft): boolean {
  return reasonCode(draft) === OPENING_REASON;
}

/**
 * A stock document posts only as itself. The kernel matches the stored source
 * pair to the command's, so a draft naming another source could never post;
 * it is refused here by name instead of as a state conflict.
 */
function assertDocumentSource(
  draft: HydratedAdjustmentDraft,
  recordId: string,
): void {
  const type =
    draft.values[fieldId(draft.values, 'inventory_transaction_source_type')];
  const id =
    draft.values[fieldId(draft.values, 'inventory_transaction_source_id')];
  if (
    type !== DOCUMENT_SOURCE_TYPE ||
    typeof id !== 'string' ||
    id.toLowerCase() !== recordId
  ) {
    throw inputError('the draft does not name itself as its posting source');
  }
}

/**
 * The kernel pins each line's columns to what it does, so a wrong column is
 * named here: a negative adjustment takes stock from its From location, a
 * positive one adds it at its To location, and a transfer names two distinct
 * locations and moves a quantity above zero. Opening stock (ruling R3) is an
 * adjustment that only adds.
 */
function assertDocumentLines(draft: HydratedAdjustmentDraft): void {
  const opening = isOpening(draft);
  if (opening && draft.kind !== 'adjustment') {
    throw inputError('opening stock is recorded as an adjustment');
  }
  for (const line of draft.lines) {
    const label = `line ${line.lineNumber}`;
    const negative = line.quantity.startsWith('-');
    const positive = !negative && line.quantity !== '0';
    if (draft.kind === 'transfer') {
      if (
        !line.fromLocationId ||
        !line.toLocationId ||
        line.fromLocationId === line.toLocationId
      ) {
        throw inputError(
          `${label}: a transfer takes stock from its From location to a different To location`,
        );
      }
      if (!positive) {
        throw inputError(`${label}: a transfer moves a quantity above zero`);
      }
      continue;
    }
    if (opening && !positive) {
      throw inputError(`${label}: opening stock only adds stock`);
    }
    if (negative && (!line.fromLocationId || line.toLocationId)) {
      throw inputError(
        `${label}: a negative adjustment takes stock from its From location and names no To location`,
      );
    }
    if (!negative && (!line.toLocationId || line.fromLocationId)) {
      throw inputError(
        `${label}: a positive adjustment adds stock at its To location and names no From location`,
      );
    }
  }
}

/**
 * Opening stock goes only where the item has none yet at that location in
 * this company. Read before the kernel's stock lock, so it is advisory: a
 * posting landing in between is not seen (the guarantee is a later Critical
 * packet's). Reserved stock needs on-hand, so an empty balance is unreserved.
 */
async function assertOpeningIntoEmptyStock(
  context: PostgresCapabilityOperationExecutorContext,
  binding: InventoryDraftBinding,
  requestContext: RegisteredCapabilityOperationExecutionRequest['context'],
  draft: HydratedAdjustmentDraft,
): Promise<void> {
  const balance = binding.balance;
  await withTrustedRequestTransaction(context.pool, requestContext, (client) =>
    withModuleRuntimeRole(client, async () => {
      for (const line of draft.lines) {
        const stored = await client.query<{ quantity: unknown }>(
          `SELECT ${quoted(balance.postedQuantity)}::text AS quantity
             FROM ${table(balance.entity)}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${quoted(balance.legalEntityColumn)} = $3
              AND ${quoted(balance.itemId)}::text = $4
              AND ${quoted(balance.locationId)}::text = $5
              AND ${quoted(balance.entity.archive.archivedAtColumn)} IS NULL`,
          [
            requestContext.tenantId,
            requestContext.environmentId,
            draft.legalEntityId,
            line.itemId,
            line.toLocationId,
          ],
        );
        if (
          stored.rows.some(
            (row) => canonicalDecimal(row.quantity, 'posted quantity') !== '0',
          )
        ) {
          throw inputError(
            `line ${line.lineNumber}: opening stock goes only where the item has none yet`,
          );
        }
      }
    }),
  );
}

async function hydrateInventoryDraft(
  context: PostgresCapabilityOperationExecutorContext,
  binding: InventoryDraftBinding,
  requestContext: RegisteredCapabilityOperationExecutionRequest['context'],
  recordId: string,
): Promise<HydratedAdjustmentDraft> {
  return withTrustedRequestTransaction(context.pool, requestContext, (client) =>
    withModuleRuntimeRole(client, async () => {
      const fields = binding.transaction.columns;
      const header = await client.query<Record<string, unknown>>(
        `SELECT ${quoted(binding.transaction.recordIdentity.column)}::text AS "recordId",
              ${quoted(binding.transaction.optimisticRevision.column)}::integer AS "revision",
              ${quoted(binding.legalEntityColumn)}::text AS "legalEntityId",
              ${fields.map((column, index) => `${quoted(column.physicalName)} AS ${quoted(`field_${String(index)}`)}`).join(',\n              ')}
         FROM ${table(binding.transaction)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND ${quoted(binding.transaction.recordIdentity.column)} = $3
          AND ${quoted(binding.transaction.archive.archivedAtColumn)} IS NULL`,
        [requestContext.tenantId, requestContext.environmentId, recordId],
      );
      const row = header.rows[0];
      if (!row || header.rows.length !== 1) {
        throw inputError(
          'the staged inventory transaction is missing or archived',
        );
      }
      const values: Record<string, ImmutableJsonValue> = {};
      fields.forEach((column, index) => {
        values[column.canonicalFieldId] = immutableDatabaseValue(
          row[`field_${String(index)}`],
        );
      });
      const typeValue =
        values[canonicalFieldId(fields, 'inventory_transaction_type')];
      const kind =
        typeof typeValue !== 'string'
          ? null
          : typeValue.endsWith(':option.inventory_transaction_type_adjustment')
            ? ('adjustment' as const)
            : typeValue.endsWith(':option.inventory_transaction_type_transfer')
              ? ('transfer' as const)
              : null;
      // The first refusal release verification's probe meets, byte for byte
      // the factory's declaration (its probe draft is a goods receipt).
      if (!kind) {
        throw inputError(
          'only adjustment and transfer drafts are admitted by this route',
        );
      }
      const lineResult = await client.query<Record<string, unknown>>(
        `SELECT ${quoted(binding.line.recordIdentity.column)}::text AS "recordId",
              ${quoted(binding.lineFields.fromLocationId)}::text AS "fromLocationId",
              ${quoted(binding.lineFields.itemId)}::text AS "itemId",
              ${quoted(binding.lineFields.lineNumber)}::text AS "lineNumber",
              ${quoted(binding.lineFields.quantity)}::text AS "quantity",
              ${quoted(binding.lineFields.toLocationId)}::text AS "toLocationId",
              ${quoted(binding.lineFields.unitId)} AS "unitId"
         FROM ${table(binding.line)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND ${quoted(binding.legalEntityColumn)} = $3
          AND ${quoted(binding.lineTransactionColumn)} = $4
          AND ${quoted(binding.line.archive.archivedAtColumn)} IS NULL
        ORDER BY ${quoted(binding.lineFields.lineNumber)},
                 ${quoted(binding.line.recordIdentity.column)}`,
        [
          requestContext.tenantId,
          requestContext.environmentId,
          String(row.legalEntityId),
          recordId,
        ],
      );
      const revision = Number(row.revision);
      if (!Number.isSafeInteger(revision) || revision <= 0) {
        throw inputError(
          'the staged inventory transaction revision is invalid',
        );
      }
      return Object.freeze({
        currentRevision: revision,
        kind,
        legalEntityId: requiredUuid(row.legalEntityId, 'legalEntityId'),
        lines: Object.freeze(
          lineResult.rows.map((line) =>
            Object.freeze({
              fromLocationId: nullableUuid(line.fromLocationId),
              itemId: requiredUuid(line.itemId, 'line.itemId'),
              lineNumber: requiredText(line.lineNumber, 'line.lineNumber'),
              quantity: canonicalDecimal(line.quantity, 'line.quantity'),
              toLocationId: nullableUuid(line.toLocationId),
              transactionLineId: requiredUuid(
                line.recordId,
                'line.transactionLineId',
              ),
              unitId: requiredText(line.unitId, 'line.unitId'),
            }),
          ),
        ),
        values: Object.freeze(values),
      });
    }),
  );
}

function inventoryDraftBinding(
  storage: StorageTargetPayloadV1,
): InventoryDraftBinding {
  const transaction = requiredEntity(storage, 'inventory_transaction');
  const line = requiredEntity(storage, 'inventory_transaction_line');
  if (!transaction.legalEntity || !line.legalEntity) {
    throw inputError('inventory draft storage lacks legal-entity ownership');
  }
  if (transaction.legalEntity.column !== line.legalEntity.column) {
    throw inputError('inventory draft storage legal-entity columns disagree');
  }
  const relation = storage.relations.filter(
    (candidate) =>
      candidate.sourceEntityId === line.entityId &&
      candidate.targetEntityId === transaction.entityId,
  );
  if (relation.length !== 1) {
    throw inputError('inventory transaction lines lack one parent relation');
  }
  const balance = requiredEntity(storage, 'posted_stock_balance');
  if (!balance.legalEntity) {
    throw inputError('posted stock storage lacks legal-entity ownership');
  }
  for (const suffix of [
    'inventory_transaction_effective_at',
    'inventory_transaction_reason_code',
    'inventory_transaction_reason_narrative',
    'inventory_transaction_source_id',
    'inventory_transaction_source_type',
    'inventory_transaction_state',
    'inventory_transaction_type',
  ]) {
    physicalField(transaction, suffix);
  }
  return Object.freeze({
    balance: Object.freeze({
      entity: balance,
      itemId: physicalField(balance, 'posted_stock_balance_item_id'),
      legalEntityColumn: safeIdentifier(balance.legalEntity.column),
      locationId: physicalField(balance, 'posted_stock_balance_location_id'),
      postedQuantity: physicalField(
        balance,
        'posted_stock_balance_posted_quantity',
      ),
    }),
    legalEntityColumn: safeIdentifier(transaction.legalEntity.column),
    line,
    lineFields: Object.freeze({
      fromLocationId: physicalField(
        line,
        'inventory_transaction_line_from_location_id',
      ),
      itemId: physicalField(line, 'inventory_transaction_line_item_id'),
      lineNumber: physicalField(line, 'inventory_transaction_line_line_number'),
      quantity: physicalField(line, 'inventory_transaction_line_quantity'),
      toLocationId: physicalField(
        line,
        'inventory_transaction_line_to_location_id',
      ),
      unitId: physicalField(line, 'inventory_transaction_line_unit_id'),
    }),
    lineTransactionColumn: safeIdentifier(
      relation[0]!.relationColumn.physicalName,
    ),
    transaction,
  });
}

function storageTarget(value: unknown): StorageTargetPayloadV1 {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('kind' in value) ||
    value.kind !== 'storageTargetPayload'
  ) {
    throw inputError('the posting capability lacks its storage projection');
  }
  return value as StorageTargetPayloadV1;
}

function requiredEntity(
  storage: StorageTargetPayloadV1,
  suffix: string,
): StorageEntityTarget {
  const matches = storage.entities.filter((entity) =>
    entity.entityId.endsWith(`:entity.${suffix}`),
  );
  if (matches.length !== 1) {
    throw inputError(`inventory storage lacks exactly one ${suffix} entity`);
  }
  return matches[0]!;
}

function physicalField(entity: StorageEntityTarget, suffix: string): string {
  return safeIdentifier(requiredColumn(entity.columns, suffix).physicalName);
}

function canonicalFieldId(
  columns: readonly StorageColumnTarget[],
  suffix: string,
): string {
  return requiredColumn(columns, suffix).canonicalFieldId;
}

function requiredColumn(
  columns: readonly StorageColumnTarget[],
  suffix: string,
): StorageColumnTarget {
  const matches = columns.filter((column) =>
    column.canonicalFieldId.endsWith(`:field.${suffix}`),
  );
  if (matches.length !== 1) {
    throw inputError(`inventory storage lacks exactly one ${suffix} field`);
  }
  return matches[0]!;
}

function postingInput(value: ImmutableJsonValue): {
  readonly expectedRevision: number;
  readonly recordId: string;
} {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    Number(value.expectedRevision) <= 0
  ) {
    throw inputError('the posting command record scope is invalid');
  }
  return Object.freeze({
    expectedRevision: Number(value.expectedRevision),
    recordId: requiredUuid(value.recordId, 'recordId'),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function immutableDatabaseValue(value: unknown): ImmutableJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (value instanceof Date) return value.toISOString();
  throw inputError('inventory draft storage returned a non-canonical value');
}

function fieldId(
  values: Readonly<Record<string, ImmutableJsonValue>>,
  suffix: string,
): string {
  const matches = Object.keys(values).filter((id) =>
    id.endsWith(`:field.${suffix}`),
  );
  if (matches.length !== 1) {
    throw inputError(`inventory draft lacks exactly one ${suffix} value`);
  }
  return matches[0]!;
}

function nullableText(value: ImmutableJsonValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value, 'text');
}

function requiredInstant(
  value: ImmutableJsonValue | undefined,
  name: string,
): string {
  const text = requiredText(value, name);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf())) throw inputError(`${name} is invalid`);
  return parsed.toISOString();
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw inputError(`${name} must be nonempty text`);
  }
  return value;
}

function canonicalDecimal(value: unknown, name: string): string {
  const text = requiredText(value, name);
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(text);
  if (!match) throw inputError(`${name} must be a decimal`);
  const fraction = (match[3] ?? '').replace(/0+$/u, '');
  const magnitude = fraction ? `${match[2]}.${fraction}` : match[2]!;
  return match[1] === '-' && magnitude !== '0' ? `-${magnitude}` : magnitude;
}

function requiredUuid(value: unknown, name: string): string {
  const text = requiredText(value, name).toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      text,
    )
  ) {
    throw inputError(`${name} must be a UUID`);
  }
  return text;
}

function nullableUuid(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : requiredUuid(value, 'nullable UUID');
}

function table(entity: StorageEntityTarget): string {
  return `north_star_module.${quoted(entity.physicalTableName)}`;
}

function quoted(value: string): string {
  return `"${safeIdentifier(value)}"`;
}

function safeIdentifier(value: string): string {
  if (!identifierPattern.test(value)) {
    throw inputError('compiled storage contains an unsafe identifier');
  }
  return value;
}

function inputError(message: string): InventoryPostingError {
  return new InventoryPostingError('INVENTORY_POSTING_INPUT_INVALID', message);
}
