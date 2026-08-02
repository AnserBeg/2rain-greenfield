import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import type { ImmutableJsonValue } from '@north-star/runtime/request-runtime-view';

import {
  evaluateRegisteredOperationPrecondition,
  SEMANTIC_OPERATION_RESULT_VERSION,
  type RegisteredCapabilityOperationExecutionRequest,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationResultEnvelope,
} from '../../runtime/src/semantic-operation-gateway.js';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../runtime/src/semantic-query-gateway.js';
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
} from './inventory-posting-service.js';
import { withModuleRuntimeRole } from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;
type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];
type StorageColumnTarget = StorageEntityTarget['columns'][number];

interface InventoryDraftBinding {
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

class InventoryPostingCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId = INVENTORY_POSTING_CAPABILITY_ID;
  readonly #binding: InventoryDraftBinding;
  readonly #posting: PostgresInventoryPostingService;

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

  async execute(
    request: RegisteredCapabilityOperationExecutionRequest,
  ): Promise<SemanticOperationResultEnvelope> {
    assertPostingOperation(request, this.#binding);
    const input = postingInput(request.input);
    const draft = await hydrateAdjustmentDraft(
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
    const command = adjustmentCommand(request, input, draft);
    const actor = await this.context.actorIssuer.issue(request.context);
    const posted = await this.#posting.postAdjustment(
      request.context,
      actor,
      command,
    );
    const scope = request.readBackDefinition.legalEntityScope;
    if (!scope || scope.cardinality !== 'exactlyOne') {
      throw inputError('the posting read-back lacks exact legal-entity scope');
    }
    const readBack = await this.context.queryGateway.invoke(request.view, {
      arguments: {
        [scope.operand.parameterId]: draft.legalEntityId,
        recordId: input.recordId,
      },
      queryId: request.readBackDefinition.queryId,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    });
    const record = readBack.records.find(
      (candidate) => candidate.recordId === input.recordId,
    );
    if (readBack.outcome !== 'exact' || !record) {
      throw inputError('the posted transaction did not read back exactly');
    }
    return Object.freeze({
      kind: 'semanticOperationResult',
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: record,
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
}

/** Inventory owns the sole adapter from its registered capability to posting. */
export const INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY = Object.freeze({
  capabilityId: INVENTORY_POSTING_CAPABILITY_ID,
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
  request: RegisteredCapabilityOperationExecutionRequest,
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

function adjustmentCommand(
  request: RegisteredCapabilityOperationExecutionRequest,
  input: { readonly expectedRevision: number; readonly recordId: string },
  draft: HydratedAdjustmentDraft,
): InventoryAdjustmentPostingCommandV1 {
  return Object.freeze({
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
    reason: Object.freeze({
      code:
        nullableText(
          draft.values[
            fieldId(draft.values, 'inventory_transaction_reason_code')
          ],
        ) ?? '',
      narrative: nullableText(
        draft.values[
          fieldId(draft.values, 'inventory_transaction_reason_narrative')
        ],
      ),
    }),
    sourceId: requiredText(
      draft.values[fieldId(draft.values, 'inventory_transaction_source_id')],
      'sourceId',
    ),
    sourceRevision: input.expectedRevision,
    sourceType: requiredText(
      draft.values[fieldId(draft.values, 'inventory_transaction_source_type')],
      'sourceType',
    ),
    stockDimensionSetVersion: 'v1',
    transactionId: input.recordId,
  });
}

async function hydrateAdjustmentDraft(
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
      if (
        typeof typeValue !== 'string' ||
        !typeValue.endsWith(':option.inventory_transaction_type_adjustment')
      ) {
        throw inputError('only adjustment drafts are admitted by this route');
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
