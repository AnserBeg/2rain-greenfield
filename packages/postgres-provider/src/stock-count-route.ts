import { randomUUID } from 'node:crypto';

import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import type { PoolClient } from 'pg';
import type { ImmutableJsonValue } from '@north-star/runtime/request-runtime-view';

import type { RegisteredCapabilityOperationExecutionRequest } from '../../runtime/src/semantic-operation-gateway.js';
import { POLICY_DECISION_EVIDENCE_VERSION } from '../../platform-runtime/src/trust/contracts.js';
import type { PostgresCapabilityOperationExecutorContext } from './capability-operation-executor-factory.js';
import {
  InventoryPostingError,
  type InventoryStockCountPostingCommandV2,
} from './inventory-posting-service.js';
import { loadInventoryPostingConfiguration } from './migrations.js';
import {
  auditFieldId,
  withModuleRuntimeRole,
} from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';

/**
 * STOCK-COUNTS: the stock count's route on the posting capability. A count
 * is started (its lines filled from posted stock at its location), counted
 * (the counter enters what was found, in the document editor), reviewed (the
 * server freezes the evidence the posting kernel will check) and posted (the
 * kernel). Start and Review are accepted mutations with their own trust
 * evidence; Post is the kernel's `postStockCount`.
 *
 * Nothing here is the rule. The kernel decides what posts -- its expected is
 * the ledger at the count's location as of the count's instant, read again
 * under the stock locks -- so a count reviewed before a posting it does not
 * know about is refused at Post, and is reviewed again.
 */
type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];
type StorageColumnTarget = StorageEntityTarget['columns'][number];

export type StockCountCommand = 'start' | 'review' | 'post';

export interface StockCountBinding {
  readonly count: StorageEntityTarget;
  readonly countFields: Readonly<{
    countedAt: string;
    kind: string;
    locationId: string;
    reasonCode: string;
    reasonNarrative: string;
    state: string;
  }>;
  readonly kinds: Readonly<
    Record<'correction' | 'initial' | 'reversal', string>
  >;
  readonly legalEntityColumn: string;
  readonly line: StorageEntityTarget;
  readonly lineFields: Readonly<{
    counted: string;
    expected: string;
    itemId: string;
    lineNumber: string;
    physical: string;
    reversal: string;
    unitId: string;
    variance: string;
  }>;
  readonly lineSessionColumn: string;
  readonly movement: StorageEntityTarget;
  readonly movementFields: Readonly<{
    effectiveAt: string;
    itemId: string;
    locationId: string;
    quantity: string;
    sourceId: string;
    sourceLine: string;
    sourceType: string;
    unitId: string;
  }>;
  readonly states: Readonly<
    Record<'counting' | 'draft' | 'posted' | 'reviewed', string>
  >;
  readonly supersedesColumn: string;
}

export interface HydratedStockCount {
  readonly countedAt: string;
  readonly currentRevision: number;
  readonly kind: 'correction' | 'initial' | 'reversal';
  readonly legalEntityId: string;
  readonly lines: readonly Readonly<{
    countedQuantity: string;
    expectedQuantity: string;
    itemId: string;
    lineNumber: string;
    physicalQuantity: string | null;
    reversalOfMovementId: string | null;
    revision: number;
    stockCountLineId: string;
    unitId: string;
    varianceQuantity: string;
  }>[];
  readonly locationId: string;
  readonly reasonCode: string | null;
  readonly reasonNarrative: string | null;
  readonly recordId: string;
  readonly state: string;
  readonly supersedesStockCountId: string | null;
  readonly values: Readonly<Record<string, ImmutableJsonValue>>;
}

/** The count's commands, by operation id; any other operation is not one. */
export function stockCountCommandOf(
  operationId: string,
): StockCountCommand | null {
  const match = /:operation\.stock_count_(start|review|post)$/u.exec(
    operationId,
  );
  return match ? (match[1] as StockCountCommand) : null;
}

/** The count's storage, resolved once from the compiled target. */
export function stockCountBinding(
  storage: StorageTargetPayloadV1,
): StockCountBinding | null {
  const entity = (suffix: string) =>
    storage.entities.filter((candidate) =>
      candidate.entityId.endsWith(`:entity.${suffix}`),
    );
  const [count] = entity('stock_count');
  const [line] = entity('stock_count_line');
  const [movement] = entity('inventory_movement');
  if (!count || !line || !movement) return null;
  if (
    !count.legalEntity ||
    !line.legalEntity ||
    !movement.legalEntity ||
    count.legalEntity.column !== line.legalEntity.column ||
    count.legalEntity.column !== movement.legalEntity.column
  ) {
    throw inputError('stock count storage lacks one legal-entity ownership');
  }
  const relationColumn = (source: string, target: string) => {
    const relations = storage.relations.filter(
      (relation) =>
        relation.sourceEntityId === source &&
        relation.targetEntityId === target &&
        relation.relationColumn.origin !== 'field',
    );
    if (relations.length !== 1) {
      throw inputError('stock count storage lacks a unique relation');
    }
    return safeIdentifier(relations[0]!.relationColumn.physicalName);
  };
  const state = requiredColumn(count.columns, 'stock_count_state');
  const kind = requiredColumn(count.columns, 'stock_count_kind');
  return Object.freeze({
    count,
    countFields: Object.freeze({
      countedAt: physicalField(count, 'stock_count_counted_at'),
      kind: safeIdentifier(kind.physicalName),
      locationId: physicalField(count, 'stock_count_location_id'),
      reasonCode: physicalField(count, 'stock_count_reason_code'),
      reasonNarrative: physicalField(count, 'stock_count_reason_narrative'),
      state: safeIdentifier(state.physicalName),
    }),
    kinds: Object.freeze({
      correction: requiredOption(kind, 'stock_count_kind_correction'),
      initial: requiredOption(kind, 'stock_count_kind_initial'),
      reversal: requiredOption(kind, 'stock_count_kind_reversal'),
    }),
    legalEntityColumn: safeIdentifier(count.legalEntity.column),
    line,
    lineFields: Object.freeze({
      counted: physicalField(line, 'stock_count_line_counted_quantity'),
      expected: physicalField(line, 'stock_count_line_expected_quantity'),
      itemId: physicalField(line, 'stock_count_line_item_id'),
      lineNumber: physicalField(line, 'stock_count_line_line_number'),
      physical: physicalField(line, 'stock_count_line_physical_quantity'),
      reversal: physicalField(line, 'stock_count_line_reversal_of_movement_id'),
      unitId: physicalField(line, 'stock_count_line_unit_id'),
      variance: physicalField(line, 'stock_count_line_variance_quantity'),
    }),
    lineSessionColumn: relationColumn(line.entityId, count.entityId),
    movement,
    movementFields: Object.freeze({
      effectiveAt: physicalField(movement, 'inventory_movement_effective_at'),
      itemId: physicalField(movement, 'inventory_movement_item_id'),
      locationId: physicalField(movement, 'inventory_movement_location_id'),
      quantity: physicalField(movement, 'inventory_movement_quantity_delta'),
      sourceId: physicalField(movement, 'inventory_movement_source_id'),
      sourceLine: physicalField(movement, 'inventory_movement_source_line'),
      sourceType: physicalField(movement, 'inventory_movement_source_type'),
      unitId: physicalField(movement, 'inventory_movement_unit_id'),
    }),
    states: Object.freeze({
      counting: requiredOption(state, 'stock_count_state_counting'),
      draft: requiredOption(state, 'stock_count_state_draft'),
      posted: requiredOption(state, 'stock_count_state_posted'),
      reviewed: requiredOption(state, 'stock_count_state_reviewed'),
    }),
    supersedesColumn: relationColumn(count.entityId, count.entityId),
  });
}

/** The count and its live lines, read as a proposal for the command. */
export async function hydrateStockCount(
  context: PostgresCapabilityOperationExecutorContext,
  binding: StockCountBinding,
  requestContext: RegisteredCapabilityOperationExecutionRequest['context'],
  recordId: string,
): Promise<HydratedStockCount> {
  return withTrustedRequestTransaction(context.pool, requestContext, (client) =>
    withModuleRuntimeRole(client, () =>
      readStockCount(client, binding, requestContext, recordId, false),
    ),
  );
}

/**
 * The kernel command for a reviewed count: the stored evidence as it is, the
 * count itself as its source, its counted instant as the posting's.
 */
export function stockCountPostingCommand(
  request: RegisteredCapabilityOperationExecutionRequest,
  input: { readonly expectedRevision: number; readonly recordId: string },
  count: HydratedStockCount,
): InventoryStockCountPostingCommandV2 {
  return Object.freeze({
    authorization: Object.freeze({
      decision: 'ALLOW' as const,
      evaluatorVersion: request.policyEvaluatorVersion,
      policyVersion: request.policyVersion,
    }),
    channel: request.channel,
    effectiveAt: count.countedAt,
    idempotencyKey: request.idempotencyKey,
    kind: count.kind,
    legalEntityId: count.legalEntityId,
    lines: Object.freeze(
      count.lines.map((line) =>
        Object.freeze({
          countedQuantity: line.countedQuantity,
          expectedQuantity: line.expectedQuantity,
          itemId: line.itemId,
          reversalOfMovementId: line.reversalOfMovementId,
          sourceLine: line.lineNumber,
          stockCountLineId: line.stockCountLineId,
          unitId: line.unitId,
          varianceQuantity: line.varianceQuantity,
        }),
      ),
    ),
    locationId: count.locationId,
    reason: Object.freeze({
      code: count.reasonCode ?? '',
      narrative: count.reasonNarrative,
    }),
    sourceId: input.recordId,
    sourceRevision: input.expectedRevision,
    sourceType: 'stockCount' as const,
    stockCountId: input.recordId,
    stockDimensionSetVersion: 'v1' as const,
    supersedesStockCountId: count.supersedesStockCountId,
  });
}

/**
 * Start counting (draft -> counting): a line for every product the ledger
 * holds above zero at the count's location now, or -- for a correction -- for
 * every product the corrected count named, each not counted yet. Expected,
 * counted and variance start at zero for Review to replace.
 *
 * Review (counting -> reviewed): the counted instant is now; each line's
 * expected is the ledger at the location as of it, its counted quantity the
 * physical count entered and its variance their difference. A reversal's
 * lines are derived instead, each the exact inverse of a movement the count
 * it reverses posted.
 */
export async function executeStockCountChange(
  context: PostgresCapabilityOperationExecutorContext,
  binding: StockCountBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  command: 'review' | 'start',
  input: { readonly expectedRevision: number; readonly recordId: string },
  authorizedLegalEntityId: string,
): Promise<{
  readonly changeDocumentId: string;
  readonly domainEventId: string;
  readonly invocationId: string;
  readonly outboxId: string;
}> {
  const now = canonicalInstant(context.currentInstant());
  return new PostgresTrustService(
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
    async (client) => {
      // Read before the module role is assumed: the configuration is the
      // platform's, the count the module's.
      const configuration =
        command === 'review'
          ? await loadInventoryPostingConfiguration(client, {
              environmentId: request.context.environmentId,
              legalEntityId: authorizedLegalEntityId,
              tenantId: request.context.tenantId,
            })
          : null;
      return withModuleRuntimeRole(client, async () => {
        const count = await readStockCount(
          client,
          binding,
          request.context,
          input.recordId,
          true,
        );
        if (count.legalEntityId !== authorizedLegalEntityId) {
          throw inputError('the count scope changed after authorization');
        }
        const from = command === 'start' ? 'draft' : 'counting';
        const to = command === 'start' ? 'counting' : 'reviewed';
        if (
          count.currentRevision !== input.expectedRevision ||
          count.state !== binding.states[from]
        ) {
          throw new InventoryPostingError(
            'INVENTORY_TRANSACTION_STATE_CONFLICT',
            'the count changed since it was shown',
          );
        }
        let lineCount: number;
        if (command === 'start') {
          lineCount = await startCount(client, binding, request, count, now);
        } else {
          const role = count.kind === 'initial' ? 'count' : 'correction';
          const narrative = count.reasonNarrative?.trim() ?? '';
          if (
            !count.reasonCode?.trim() ||
            (configuration!.reasonRequirements[role] === 'codeAndNarrative' &&
              narrative.length === 0)
          ) {
            throw new InventoryPostingError(
              'INVENTORY_COUNT_REASON_REQUIRED',
              `a ${role} requires ${configuration!.reasonRequirements[role]} before it is reviewed`,
            );
          }
          lineCount =
            count.kind === 'reversal'
              ? await deriveReversalLines(client, binding, request, count)
              : await reviewCountedLines(client, binding, request, count, now);
        }
        const updated = await client.query<{ revision: number }>(
          `UPDATE ${table(binding.count)}
              SET ${quoted(binding.countFields.state)} = $5,
                  ${command === 'review' ? `${quoted(binding.countFields.countedAt)} = $7::timestamptz,` : ''}
                  ${quoted(binding.count.optimisticRevision.column)} = ${quoted(binding.count.optimisticRevision.column)} + 1
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${quoted(binding.legalEntityColumn)} = $3
              AND ${quoted(binding.count.recordIdentity.column)} = $4
              AND ${quoted(binding.count.optimisticRevision.column)} = $6
              AND ${quoted(binding.count.archive.archivedAtColumn)} IS NULL
          RETURNING ${quoted(binding.count.optimisticRevision.column)}::integer AS revision`,
          [
            request.context.tenantId,
            request.context.environmentId,
            count.legalEntityId,
            input.recordId,
            binding.states[to],
            input.expectedRevision,
            ...(command === 'review' ? [now] : []),
          ],
        );
        if (
          updated.rowCount !== 1 ||
          updated.rows[0]!.revision !== input.expectedRevision + 1
        ) {
          throw new InventoryPostingError(
            'INVENTORY_TRANSACTION_STATE_CONFLICT',
            'the count changed while it was being updated',
          );
        }
        const metadata = {
          lines: { classification: 'INTERNAL' as const, value: lineCount },
          operationId: {
            classification: 'INTERNAL' as const,
            value: request.definition.operationId,
          },
        };
        return {
          mutationResult: {
            legalEntityId: count.legalEntityId,
            recordId: input.recordId,
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
              recordId: input.recordId,
              recordType: binding.count.entityId,
              revision: input.expectedRevision + 1,
              changes: [
                {
                  classification: 'INTERNAL' as const,
                  fieldId: auditFieldId(
                    canonicalFieldId(binding.count, 'stock_count_state'),
                  ),
                  oldState: {
                    state: 'VALUE' as const,
                    value: binding.states[from],
                  },
                  newState: {
                    state: 'VALUE' as const,
                    value: binding.states[to],
                  },
                },
                ...(command === 'review'
                  ? [
                      {
                        classification: 'INTERNAL' as const,
                        fieldId: auditFieldId(
                          canonicalFieldId(
                            binding.count,
                            'stock_count_counted_at',
                          ),
                        ),
                        oldState: {
                          state: 'VALUE' as const,
                          value: count.countedAt,
                        },
                        newState: { state: 'VALUE' as const, value: now },
                      },
                    ]
                  : []),
              ],
            },
            event: {
              eventId: randomUUID(),
              eventSchemaVersion: 'northstar.inventory-stock-count-event/v1',
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
      });
    },
  );
}

async function startCount(
  client: PoolClient,
  binding: StockCountBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  count: HydratedStockCount,
  now: string,
): Promise<number> {
  if (count.kind === 'reversal') {
    throw inputError(
      'a reversal is not counted: its lines come from the count it reverses',
    );
  }
  const m = binding.movementFields;
  const products =
    count.kind === 'initial'
      ? await client.query<{ itemId: string; unitId: string }>(
          `SELECT ${quoted(m.itemId)}::text AS "itemId", ${quoted(m.unitId)} AS "unitId"
             FROM ${table(binding.movement)}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${quoted(binding.legalEntityColumn)} = $3
              AND ${quoted(m.locationId)} = $4
              AND ${quoted(m.effectiveAt)} <= $5::timestamptz
              AND ${quoted(binding.movement.archive.archivedAtColumn)} IS NULL
            GROUP BY ${quoted(m.itemId)}, ${quoted(m.unitId)}
           HAVING sum(${quoted(m.quantity)}) > 0
            ORDER BY ${quoted(m.itemId)}`,
          [
            request.context.tenantId,
            request.context.environmentId,
            count.legalEntityId,
            count.locationId,
            now,
          ],
        )
      : await client.query<{ itemId: string; unitId: string }>(
          `SELECT ${quoted(binding.lineFields.itemId)}::text AS "itemId",
                  ${quoted(binding.lineFields.unitId)} AS "unitId"
             FROM ${table(binding.line)}
            WHERE tenant_id = $1 AND environment_id = $2
              AND ${quoted(binding.legalEntityColumn)} = $3
              AND ${quoted(binding.lineSessionColumn)} = $4
              AND ${quoted(binding.line.archive.archivedAtColumn)} IS NULL
            ORDER BY ${quoted(binding.lineFields.lineNumber)},
                     ${quoted(binding.line.recordIdentity.column)}`,
          [
            request.context.tenantId,
            request.context.environmentId,
            count.legalEntityId,
            count.supersedesStockCountId ??
              invalid('a correction names the count it corrects'),
          ],
        );
  const counted = new Set(count.lines.map((line) => line.itemId));
  let lineNumber = Math.max(
    0,
    ...count.lines.map((line) => Number(line.lineNumber)),
  );
  let added = 0;
  for (const product of products.rows) {
    const itemId = String(product.itemId).toLowerCase();
    if (counted.has(itemId)) continue;
    counted.add(itemId);
    lineNumber += 1;
    await insertLine(client, binding, request, count, {
      counted: '0',
      expected: '0',
      itemId,
      lineNumber: String(lineNumber),
      physical: null,
      reversal: null,
      unitId: String(product.unitId),
      variance: '0',
    });
    added += 1;
  }
  return added;
}

async function reviewCountedLines(
  client: PoolClient,
  binding: StockCountBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  count: HydratedStockCount,
  now: string,
): Promise<number> {
  if (count.lines.length === 0) {
    throw inputError('add at least one product before the count is reviewed');
  }
  const uncounted = count.lines.filter(
    (line) => line.physicalQuantity === null,
  );
  if (uncounted.length > 0) {
    throw inputError(
      `${String(uncounted.length)} line(s) are not counted yet: line ${uncounted.map((line) => line.lineNumber).join(', ')}`,
    );
  }
  const items = new Set<string>();
  for (const line of count.lines) {
    if (items.has(line.itemId)) {
      throw inputError(
        `line ${line.lineNumber} counts a product another line already counts`,
      );
    }
    items.add(line.itemId);
    if (line.physicalQuantity!.startsWith('-')) {
      throw inputError(
        `line ${line.lineNumber}: a physical count is never negative`,
      );
    }
  }
  const m = binding.movementFields;
  const ledger = await client.query<{ itemId: string; quantity: string }>(
    `SELECT ${quoted(m.itemId)}::text AS "itemId",
            COALESCE(sum(${quoted(m.quantity)}), 0)::text AS quantity
       FROM ${table(binding.movement)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.legalEntityColumn)} = $3
        AND ${quoted(m.locationId)} = $4
        AND ${quoted(m.itemId)} = ANY($5::text[])
        AND ${quoted(m.effectiveAt)} <= $6::timestamptz
        AND ${quoted(binding.movement.archive.archivedAtColumn)} IS NULL
      GROUP BY ${quoted(m.itemId)}`,
    [
      request.context.tenantId,
      request.context.environmentId,
      count.legalEntityId,
      count.locationId,
      [...items],
      now,
    ],
  );
  const posted = new Map(
    ledger.rows.map((row) => [
      String(row.itemId).toLowerCase(),
      scaled(String(row.quantity)),
    ]),
  );
  for (const line of count.lines) {
    const expected = posted.get(line.itemId) ?? 0n;
    if (expected < 0n) {
      throw inputError(
        `line ${line.lineNumber}: posted stock of this product is below zero here, so it cannot be counted`,
      );
    }
    const countedQuantity = scaled(line.physicalQuantity!);
    await updateLine(client, binding, request, count, line, {
      counted: decimal(countedQuantity),
      expected: decimal(expected),
      variance: decimal(countedQuantity - expected),
    });
  }
  return count.lines.length;
}

/**
 * A reversal's lines: one for each movement the count it reverses posted,
 * each its exact inverse at the same location, so the kernel's compensation
 * check admits exactly them.
 */
async function deriveReversalLines(
  client: PoolClient,
  binding: StockCountBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  count: HydratedStockCount,
): Promise<number> {
  if (count.lines.length > 0) {
    throw inputError(
      'a reversal derives its lines from the count it reverses; it has its own',
    );
  }
  const reversed =
    count.supersedesStockCountId ??
    invalid('a reversal names the count it reverses');
  const original = await readStockCount(
    client,
    binding,
    request.context,
    reversed,
    false,
  );
  if (
    original.state !== binding.states.posted ||
    original.locationId !== count.locationId ||
    original.legalEntityId !== count.legalEntityId
  ) {
    throw inputError(
      'a reversal reverses one posted count at the same location',
    );
  }
  const m = binding.movementFields;
  const movements = await client.query<{
    movementId: string;
    quantity: string;
    sourceLine: string;
  }>(
    `SELECT ${quoted(binding.movement.recordIdentity.column)}::text AS "movementId",
            ${quoted(m.quantity)}::text AS quantity,
            ${quoted(m.sourceLine)} AS "sourceLine"
       FROM ${table(binding.movement)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.legalEntityColumn)} = $3
        AND ${quoted(m.sourceType)} = 'stockCount'
        AND ${quoted(m.sourceId)} = $4
        AND ${quoted(binding.movement.archive.archivedAtColumn)} IS NULL`,
    [
      request.context.tenantId,
      request.context.environmentId,
      count.legalEntityId,
      reversed,
    ],
  );
  const bySourceLine = new Map(
    movements.rows.map((row) => [String(row.sourceLine), row]),
  );
  if (movements.rows.length !== original.lines.length) {
    throw inputError('the reversed count does not read back as it posted');
  }
  for (const line of original.lines) {
    const movement = bySourceLine.get(line.lineNumber);
    if (!movement) {
      throw inputError('the reversed count does not read back as it posted');
    }
    await insertLine(client, binding, request, count, {
      // Back from what was counted to what was expected.
      counted: line.expectedQuantity,
      expected: line.countedQuantity,
      itemId: line.itemId,
      lineNumber: line.lineNumber,
      physical: line.expectedQuantity,
      reversal: String(movement.movementId).toLowerCase(),
      unitId: line.unitId,
      variance: decimal(-scaled(String(movement.quantity))),
    });
  }
  return original.lines.length;
}

async function readStockCount(
  client: PoolClient,
  binding: StockCountBinding,
  requestContext: RegisteredCapabilityOperationExecutionRequest['context'],
  recordId: string,
  lock: boolean,
): Promise<HydratedStockCount> {
  const count = binding.count;
  const f = binding.countFields;
  const header = await client.query<Record<string, unknown>>(
    `SELECT ${quoted(count.recordIdentity.column)}::text AS "recordId",
            ${quoted(count.optimisticRevision.column)}::integer AS revision,
            ${quoted(binding.legalEntityColumn)}::text AS "legalEntityId",
            ${quoted(f.state)} AS state,
            ${quoted(f.kind)} AS kind,
            ${quoted(f.locationId)}::text AS "locationId",
            to_char(${quoted(f.countedAt)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "countedAt",
            ${quoted(f.reasonCode)} AS "reasonCode",
            ${quoted(f.reasonNarrative)} AS "reasonNarrative",
            ${quoted(binding.supersedesColumn)}::text AS "supersedesStockCountId",
            ${count.columns.map((column, index) => `${quoted(column.physicalName)} AS ${quoted(`field_${String(index)}`)}`).join(',\n            ')}
       FROM ${table(count)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(count.recordIdentity.column)} = $3
        AND ${quoted(count.archive.archivedAtColumn)} IS NULL
      ${lock ? 'FOR NO KEY UPDATE' : ''}`,
    [requestContext.tenantId, requestContext.environmentId, recordId],
  );
  const row = header.rows[0];
  if (!row || header.rows.length !== 1) {
    throw inputError('the stock count is missing or archived');
  }
  const values: Record<string, ImmutableJsonValue> = {};
  count.columns.forEach((column, index) => {
    values[column.canonicalFieldId] = immutableDatabaseValue(
      row[`field_${String(index)}`],
    );
  });
  const kind =
    row.kind === binding.kinds.initial
      ? ('initial' as const)
      : row.kind === binding.kinds.correction
        ? ('correction' as const)
        : row.kind === binding.kinds.reversal
          ? ('reversal' as const)
          : invalid('the stock count kind is not supported');
  const l = binding.lineFields;
  const lines = await client.query<Record<string, unknown>>(
    `SELECT ${quoted(binding.line.recordIdentity.column)}::text AS "stockCountLineId",
            ${quoted(binding.line.optimisticRevision.column)}::integer AS revision,
            ${quoted(l.lineNumber)}::text AS "lineNumber",
            ${quoted(l.itemId)}::text AS "itemId",
            ${quoted(l.unitId)} AS "unitId",
            ${quoted(l.expected)}::text AS "expectedQuantity",
            ${quoted(l.counted)}::text AS "countedQuantity",
            ${quoted(l.variance)}::text AS "varianceQuantity",
            ${quoted(l.physical)}::text AS "physicalQuantity",
            ${quoted(l.reversal)}::text AS "reversalOfMovementId"
       FROM ${table(binding.line)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.legalEntityColumn)} = $3
        AND ${quoted(binding.lineSessionColumn)} = $4
        AND ${quoted(binding.line.archive.archivedAtColumn)} IS NULL
      ORDER BY ${quoted(l.lineNumber)}, ${quoted(binding.line.recordIdentity.column)}
      ${lock ? 'FOR NO KEY UPDATE' : ''}`,
    [
      requestContext.tenantId,
      requestContext.environmentId,
      String(row.legalEntityId),
      recordId,
    ],
  );
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw inputError('the stock count revision is invalid');
  }
  return Object.freeze({
    countedAt: requiredText(row.countedAt, 'countedAt'),
    currentRevision: revision,
    kind,
    legalEntityId: requiredUuid(row.legalEntityId, 'legalEntityId'),
    lines: Object.freeze(
      lines.rows.map((line) =>
        Object.freeze({
          countedQuantity: canonicalDecimal(line.countedQuantity),
          expectedQuantity: canonicalDecimal(line.expectedQuantity),
          itemId: requiredUuid(line.itemId, 'line.itemId'),
          lineNumber: requiredText(line.lineNumber, 'line.lineNumber'),
          physicalQuantity:
            line.physicalQuantity === null
              ? null
              : canonicalDecimal(line.physicalQuantity),
          reversalOfMovementId:
            line.reversalOfMovementId === null
              ? null
              : requiredUuid(line.reversalOfMovementId, 'line.reversal'),
          revision: Number(line.revision),
          stockCountLineId: requiredUuid(
            line.stockCountLineId,
            'line.stockCountLineId',
          ),
          unitId: requiredText(line.unitId, 'line.unitId'),
          varianceQuantity: canonicalDecimal(line.varianceQuantity),
        }),
      ),
    ),
    locationId: requiredUuid(row.locationId, 'locationId'),
    reasonCode: nullableText(row.reasonCode),
    reasonNarrative: nullableText(row.reasonNarrative),
    recordId: requiredUuid(row.recordId, 'recordId'),
    state: requiredText(row.state, 'state'),
    supersedesStockCountId:
      row.supersedesStockCountId === null
        ? null
        : requiredUuid(row.supersedesStockCountId, 'supersedesStockCountId'),
    values: Object.freeze(values),
  });
}

async function insertLine(
  client: PoolClient,
  binding: StockCountBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  count: HydratedStockCount,
  line: {
    readonly counted: string;
    readonly expected: string;
    readonly itemId: string;
    readonly lineNumber: string;
    readonly physical: string | null;
    readonly reversal: string | null;
    readonly unitId: string;
    readonly variance: string;
  },
): Promise<void> {
  const l = binding.lineFields;
  const columns = [
    'tenant_id',
    'environment_id',
    binding.legalEntityColumn,
    binding.line.recordIdentity.column,
    binding.line.optimisticRevision.column,
    l.lineNumber,
    l.itemId,
    l.unitId,
    l.expected,
    l.counted,
    l.variance,
    l.physical,
    l.reversal,
    binding.lineSessionColumn,
  ];
  const values = [
    request.context.tenantId,
    request.context.environmentId,
    count.legalEntityId,
    randomUUID(),
    1,
    Number(line.lineNumber),
    line.itemId,
    line.unitId,
    line.expected,
    line.counted,
    line.variance,
    line.physical,
    line.reversal,
    count.recordId,
  ];
  const inserted = await client.query(
    `INSERT INTO ${table(binding.line)} (${columns.map(quoted).join(', ')})
     VALUES (${values.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    values,
  );
  if (inserted.rowCount !== 1) {
    throw inputError('a count line was not written');
  }
}

async function updateLine(
  client: PoolClient,
  binding: StockCountBinding,
  request: RegisteredCapabilityOperationExecutionRequest,
  count: HydratedStockCount,
  line: HydratedStockCount['lines'][number],
  figures: {
    readonly counted: string;
    readonly expected: string;
    readonly variance: string;
  },
): Promise<void> {
  const l = binding.lineFields;
  const revision = quoted(binding.line.optimisticRevision.column);
  const updated = await client.query(
    `UPDATE ${table(binding.line)}
        SET ${quoted(l.expected)} = $5,
            ${quoted(l.counted)} = $6,
            ${quoted(l.variance)} = $7,
            ${revision} = ${revision} + 1
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(binding.legalEntityColumn)} = $3
        AND ${quoted(binding.line.recordIdentity.column)} = $4
        AND ${revision} = $8`,
    [
      request.context.tenantId,
      request.context.environmentId,
      count.legalEntityId,
      line.stockCountLineId,
      figures.expected,
      figures.counted,
      figures.variance,
      line.revision,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new InventoryPostingError(
      'INVENTORY_TRANSACTION_STATE_CONFLICT',
      `count line ${line.lineNumber} changed while the count was reviewed`,
    );
  }
}

function canonicalInstant(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw inputError('the request clock is not an instant');
  }
  return parsed.toISOString();
}

function scaled(value: string): bigint {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(value);
  if (!match) throw inputError('a quantity must be a decimal');
  const fraction = (match[3] ?? '').padEnd(18, '0');
  if (fraction.length > 18) throw inputError('a quantity has too many digits');
  const magnitude = BigInt(`${match[2]!}${fraction}`);
  return match[1] === '-' ? -magnitude : magnitude;
}

function decimal(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(19, '0');
  const whole = digits.slice(0, -18).replace(/^0+(?=\d)/u, '');
  const fraction = digits.slice(-18).replace(/0+$/u, '');
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative && text !== '0' ? `-${text}` : text;
}

function canonicalDecimal(value: unknown): string {
  return decimal(scaled(requiredText(value, 'quantity')));
}

function requiredOption(column: StorageColumnTarget, suffix: string): string {
  const option = column.fieldContract.enumOptionIds.find((value) =>
    value.endsWith(`:option.${suffix}`),
  );
  if (!option) throw inputError(`stock count storage lacks ${suffix}`);
  return option;
}

function requiredColumn(
  columns: readonly StorageColumnTarget[],
  suffix: string,
): StorageColumnTarget {
  const matches = columns.filter((column) =>
    column.canonicalFieldId.endsWith(`:field.${suffix}`),
  );
  if (matches.length !== 1) {
    throw inputError(`stock count storage lacks exactly one ${suffix} field`);
  }
  return matches[0]!;
}

function physicalField(entity: StorageEntityTarget, suffix: string): string {
  return safeIdentifier(requiredColumn(entity.columns, suffix).physicalName);
}

function canonicalFieldId(entity: StorageEntityTarget, suffix: string): string {
  return requiredColumn(entity.columns, suffix).canonicalFieldId;
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
  throw inputError('stock count storage returned a non-canonical value');
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw inputError(`${name} must be nonempty text`);
  }
  return value;
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

function table(entity: StorageEntityTarget): string {
  return `north_star_module.${quoted(entity.physicalTableName)}`;
}

function quoted(value: string): string {
  return `"${safeIdentifier(value)}"`;
}

function safeIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw inputError('compiled storage contains an unsafe identifier');
  }
  return value;
}

function invalid(message: string): never {
  throw inputError(message);
}

function inputError(message: string): InventoryPostingError {
  return new InventoryPostingError('INVENTORY_POSTING_INPUT_INVALID', message);
}
