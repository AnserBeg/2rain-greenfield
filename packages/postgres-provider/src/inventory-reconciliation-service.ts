import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import {
  assertTrustedRequestContext,
  type TrustedRequestContext,
} from '@north-star/runtime';
import type { Pool, PoolClient } from 'pg';

import {
  aggregateGenerationLockKey,
  expectedAggregateAnchorIntegrity,
  withModuleRuntimeRole,
} from './module-runtime-interpreter.js';
import { withTrustedRequestTransaction } from './request-context.js';

export const INVENTORY_RECONCILIATION_REPORT_VERSION =
  'northstar.inventory-reconciliation-report/v1' as const;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const storedDecimalPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/u;
const instantPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const decimalScale = 18n;
const scaleFactor = 10n ** decimalScale;
const maximumScaledMagnitude = 10n ** 38n;

export type InventoryReconciliationArmIdV1 =
  'aggregateAnchors' | 'sourceDocuments';

/**
 * Three outcomes, never two. ADR-0044's rule applied to reconciliation:
 * finding nothing wrong and being unable to look are different answers and
 * must never render the same way. A scope with no subjects is `indeterminate`,
 * so an empty sweep can never be read as a clean one.
 */
export type InventoryReconciliationOutcomeV1 =
  'consistent' | 'discrepant' | 'indeterminate';

/**
 * Two instruments, two verdicts. One word spanning both is what let nine review
 * rounds keep extending an unbounded conjunction: `consistent` meant "balances
 * agree AND provenance agrees AND the cache is intact", which has no completion
 * condition. Each verdict now has its own, and neither can mask the other.
 */
export type InventoryReconciliationAxisV1 = 'balance' | 'integrity';

export type InventoryReconciliationFindingCodeV1 =
  | 'AGGREGATE_ANCHOR_BALANCE_UNRECOGNIZED'
  | 'AGGREGATE_ANCHOR_DIGEST_DIVERGED'
  | 'AGGREGATE_ANCHOR_INTEGRITY_UNVERIFIABLE'
  | 'AGGREGATE_ANCHOR_LEDGER_DIVERGED'
  | 'AGGREGATE_ANCHOR_PARAMETERS_UNRECOGNIZED'
  | 'AGGREGATE_ANCHOR_QUERY_UNRECOGNIZED'
  | 'AGGREGATE_ANCHOR_SCOPE_DIVERGED'
  | 'RECORDED_ANCHOR_DISCREPANCY_PRESERVED'
  | 'SCOPE_OBSERVED_NO_SUBJECTS'
  | 'SOURCE_DOCUMENT_EFFECTIVE_AT_DIVERGED'
  | 'SOURCE_DOCUMENT_ITEM_DIVERGED'
  | 'SOURCE_DOCUMENT_LINE_SHAPE_UNRECOGNIZED'
  | 'SOURCE_DOCUMENT_MISSING_FOR_MOVEMENT'
  | 'SOURCE_DOCUMENT_MOVEMENT_COUNT_DIVERGED'
  | 'SOURCE_DOCUMENT_POSTING_ROLE_DIVERGED'
  | 'SOURCE_DOCUMENT_QUANTITY_DIVERGED'
  | 'SOURCE_DOCUMENT_REASON_DIVERGED'
  | 'SOURCE_DOCUMENT_SOURCE_IDENTITY_DIVERGED'
  | 'SOURCE_DOCUMENT_SOURCE_LINE_DIVERGED'
  | 'SOURCE_DOCUMENT_TRANSACTION_LINK_DIVERGED'
  | 'SOURCE_DOCUMENT_TYPE_UNRECOGNIZED'
  | 'SOURCE_DOCUMENT_UNIT_DIVERGED';

/**
 * Every column the movement contract carries, and what this reconciler does
 * with it. The ratchet in `resolveReconciliationStorage` requires this map and
 * the compiled column list to agree exactly, so a column added to the contract
 * fails construction until somebody decides which instrument owns it.
 *
 * This does NOT derive semantics -- that was tried and reversed, because the
 * compiled contract carries no field-level provenance. It makes silent omission
 * impossible, which is the part that was actually costing review rounds.
 */
const MOVEMENT_COLUMN_CLASSIFICATION: Readonly<Record<string, string>> =
  Object.freeze({
    inventory_movement_actor_id:
      'excluded: the posting actor, not a property of the document',
    inventory_movement_effective_at: 'balance',
    inventory_movement_item_id: 'balance',
    inventory_movement_location_id: 'balance',
    inventory_movement_posting_role: 'integrity',
    inventory_movement_quantity_delta: 'balance',
    inventory_movement_reason_code: 'integrity',
    inventory_movement_reason_narrative: 'integrity',
    // Balance-relevant -- it bounds ledger inclusion at the recorded-time
    // horizon -- but the document carries no counterpart instant to compare it
    // against: the header's recorded_at is set at draft creation and the
    // movement's at posting, so they legitimately differ. Uncompared, and that
    // is a DECLARED LIMIT of the balance set rather than an irrelevance.
    inventory_movement_recorded_at:
      'balance: declared limit, no document counterpart exists to compare against',
    // Document-derived, but by the stock-count line rather than the transaction
    // line, and this arm reads transactions. A declared limit, not an
    // irrelevance: the earlier wording conceded the provenance and then
    // excluded it anyway.
    inventory_movement_reversal_of_movement_id:
      'integrity: declared limit, declared by the stock-count line which this arm does not read',
    inventory_movement_source_id: 'integrity',
    inventory_movement_source_line: 'integrity',
    inventory_movement_source_revision:
      'excluded: the header revision advances on the draft-to-posted transition, so equality is false by construction',
    inventory_movement_source_type: 'integrity',
    inventory_movement_stock_dimension_set_version:
      'excluded: a command input with no header counterpart',
    inventory_movement_unit_id: 'balance',
  });

type AxisEffect = 'discrepant' | 'unaffected' | 'unverifiable';

/**
 * What each finding says about each verdict. Exhaustive over the code union by
 * construction, so a new code cannot be added without deciding which
 * instrument it belongs to.
 *
 * `unaffected` is the load-bearing value: a provenance defect leaves the
 * BALANCE verdict untouched, which is the whole point of splitting them.
 */
const FINDING_AXIS_EFFECTS: Readonly<
  Record<
    InventoryReconciliationFindingCodeV1,
    Readonly<Record<InventoryReconciliationAxisV1, AxisEffect>>
  >
> = Object.freeze({
  // A balance outside numeric(38,18) blocks both: it cannot be summed against,
  // and the integrity digest is taken over that same unusable value.
  AGGREGATE_ANCHOR_BALANCE_UNRECOGNIZED: {
    balance: 'unverifiable',
    integrity: 'unverifiable',
  },
  AGGREGATE_ANCHOR_DIGEST_DIVERGED: {
    balance: 'unaffected',
    integrity: 'discrepant',
  },
  AGGREGATE_ANCHOR_INTEGRITY_UNVERIFIABLE: {
    balance: 'unaffected',
    integrity: 'unverifiable',
  },
  AGGREGATE_ANCHOR_LEDGER_DIVERGED: {
    balance: 'discrepant',
    integrity: 'unaffected',
  },
  // The digest is checkable without recognizing the query or its parameters,
  // so an anchor the balance arm cannot read is still integrity-verified.
  AGGREGATE_ANCHOR_PARAMETERS_UNRECOGNIZED: {
    balance: 'unverifiable',
    integrity: 'unaffected',
  },
  AGGREGATE_ANCHOR_QUERY_UNRECOGNIZED: {
    balance: 'unverifiable',
    integrity: 'unaffected',
  },
  AGGREGATE_ANCHOR_SCOPE_DIVERGED: {
    balance: 'unverifiable',
    integrity: 'discrepant',
  },
  RECORDED_ANCHOR_DISCREPANCY_PRESERVED: {
    balance: 'unaffected',
    integrity: 'discrepant',
  },
  SCOPE_OBSERVED_NO_SUBJECTS: {
    balance: 'unverifiable',
    integrity: 'unverifiable',
  },
  SOURCE_DOCUMENT_EFFECTIVE_AT_DIVERGED: {
    balance: 'discrepant',
    integrity: 'unaffected',
  },
  SOURCE_DOCUMENT_ITEM_DIVERGED: {
    balance: 'discrepant',
    integrity: 'unaffected',
  },
  SOURCE_DOCUMENT_LINE_SHAPE_UNRECOGNIZED: {
    balance: 'unverifiable',
    integrity: 'unverifiable',
  },
  SOURCE_DOCUMENT_MISSING_FOR_MOVEMENT: {
    balance: 'discrepant',
    integrity: 'unaffected',
  },
  SOURCE_DOCUMENT_MOVEMENT_COUNT_DIVERGED: {
    balance: 'discrepant',
    integrity: 'unaffected',
  },
  SOURCE_DOCUMENT_POSTING_ROLE_DIVERGED: {
    balance: 'unaffected',
    integrity: 'discrepant',
  },
  SOURCE_DOCUMENT_QUANTITY_DIVERGED: {
    balance: 'discrepant',
    integrity: 'unaffected',
  },
  SOURCE_DOCUMENT_REASON_DIVERGED: {
    balance: 'unaffected',
    integrity: 'discrepant',
  },
  SOURCE_DOCUMENT_SOURCE_IDENTITY_DIVERGED: {
    balance: 'unaffected',
    integrity: 'discrepant',
  },
  SOURCE_DOCUMENT_SOURCE_LINE_DIVERGED: {
    balance: 'unaffected',
    integrity: 'discrepant',
  },
  SOURCE_DOCUMENT_TRANSACTION_LINK_DIVERGED: {
    balance: 'unaffected',
    integrity: 'discrepant',
  },
  SOURCE_DOCUMENT_TYPE_UNRECOGNIZED: {
    balance: 'unverifiable',
    integrity: 'unverifiable',
  },
  SOURCE_DOCUMENT_UNIT_DIVERGED: {
    balance: 'discrepant',
    integrity: 'unaffected',
  },
});

export type InventoryReconciliationErrorCodeV1 =
  | 'INVENTORY_RECONCILIATION_SCOPE_INVALID'
  | 'INVENTORY_RECONCILIATION_STORAGE_INVALID'
  | 'INVENTORY_RECONCILIATION_TRANSACTION_NOT_READ_ONLY';

export class InventoryReconciliationError extends Error {
  override readonly name = 'InventoryReconciliationError';

  constructor(
    readonly code: InventoryReconciliationErrorCodeV1,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/**
 * The reconciler is generic press: every module identity it needs is supplied
 * by the declaring package through this registration, exactly as the posting
 * capability supplies its own.
 */
export interface InventoryReconciliationRegistrationV1 {
  readonly aggregateParameterIds: {
    readonly atTime: string;
    readonly itemId: string;
    readonly legalEntityId: string;
    readonly locationId: string;
    readonly recordedAtHorizon: string;
  };
  readonly aggregateQueryId: string;
  readonly storageTarget: StorageTargetPayloadV1;
}

export interface InventoryReconciliationScopeV1 {
  readonly legalEntityIds: readonly string[];
  readonly scopeId: string;
}

export interface InventoryReconciliationFindingV1 {
  readonly armId: InventoryReconciliationArmIdV1 | null;
  readonly code: InventoryReconciliationFindingCodeV1;
  /** What the source document or the cached anchor claims. */
  readonly declaredValue: string | null;
  readonly detail: Readonly<Record<string, string>>;
  /** What re-deriving from the movement ledger observes. */
  readonly observedValue: string | null;
  readonly subjectId: string;
}

export type InventoryReconciliationExclusionReasonV1 =
  'outOfScope' | 'supersededGeneration';

/** Exclusion is accounted for by name and reason, never as a bare count. */
export interface InventoryReconciliationExclusionV1 {
  readonly reason: InventoryReconciliationExclusionReasonV1;
  readonly subjectId: string;
}

export interface InventoryReconciliationVerdictV1 {
  readonly axis: InventoryReconciliationAxisV1;
  readonly consistentSubjectIds: readonly string[];
  readonly discrepantSubjectIds: readonly string[];
  readonly outcome: InventoryReconciliationOutcomeV1;
  readonly subjectCount: number;
  readonly unverifiableSubjectIds: readonly string[];
}

export interface InventoryReconciliationArmReportV1 {
  readonly armId: InventoryReconciliationArmIdV1;
  readonly consistentSubjectIds: readonly string[];
  readonly discrepantSubjectIds: readonly string[];
  readonly excludedSubjects: readonly InventoryReconciliationExclusionV1[];
  readonly findings: readonly InventoryReconciliationFindingV1[];
  readonly outcome: InventoryReconciliationOutcomeV1;
  readonly subjectCount: number;
  readonly subjectIds: readonly string[];
  readonly unverifiableSubjectIds: readonly string[];
}

export interface InventoryReconciliationReportV1 {
  readonly arms: readonly InventoryReconciliationArmReportV1[];
  /** Movement sums, anchors and the quantities documents declare. Closed set. */
  readonly balances: InventoryReconciliationVerdictV1;
  readonly environmentId: string;
  readonly findings: readonly InventoryReconciliationFindingV1[];
  /** Provenance and cache integrity. Open instrument, separately scoped. */
  readonly integrity: InventoryReconciliationVerdictV1;
  readonly legalEntityIds: readonly string[];
  /**
   * The worse of the two verdicts, a convenience for alerting. **The two
   * verdicts are the authority** — this exists so an operator has one line to
   * decide whether to look, not so anything can be judged by it.
   */
  readonly outcome: InventoryReconciliationOutcomeV1;
  readonly repairedSubjectCount: 0;
  readonly schemaVersion: typeof INVENTORY_RECONCILIATION_REPORT_VERSION;
  readonly scopeId: string;
  readonly subjectCount: number;
  readonly tenantId: string;
  /** Observed, not assumed: `current_setting('transaction_read_only')`. */
  readonly transactionReadOnly: string;
}

export interface InventoryReconciliationObservationV1 {
  readonly armId: InventoryReconciliationArmIdV1 | null;
  readonly code: InventoryReconciliationFindingCodeV1 | null;
  readonly kind: 'finding' | 'reconciled';
  readonly outcome: InventoryReconciliationOutcomeV1 | null;
  readonly scopeId: string;
  readonly subjectId: string | null;
}

interface EntityBinding {
  readonly archiveColumn: string;
  readonly columns: ReadonlyMap<string, string>;
  readonly legalEntityColumn: string;
  readonly recordIdColumn: string;
  readonly tableName: string;
}

interface ReconciliationStorageBinding {
  readonly movement: EntityBinding;
  readonly movementPostingRoleAdjustment: string;
  readonly movementPostingRoleCorrection: string;
  readonly movementPostingRoleCount: string;
  readonly movementPostingRoleTransfer: string;
  readonly movementQuantityColumn: string;
  readonly movementRelationToLineColumn: string;
  readonly movementRelationToTransactionColumn: string;
  readonly schemaName: string;
  readonly transaction: EntityBinding;
  readonly transactionAdjustmentType: string;
  readonly transactionCountCorrectionType: string;
  readonly transactionEffectiveAtColumn: string;
  readonly transactionLine: EntityBinding;
  readonly transactionLineFromLocationColumn: string;
  readonly transactionLineItemColumn: string;
  readonly transactionLineNumberColumn: string;
  readonly transactionLineQuantityColumn: string;
  readonly transactionLineRelationToTransactionColumn: string;
  readonly transactionLineToLocationColumn: string;
  readonly transactionLineUnitColumn: string;
  readonly transactionPostedState: string;
  readonly transactionReasonCodeColumn: string;
  readonly transactionReasonNarrativeColumn: string;
  readonly transactionSourceIdColumn: string;
  readonly transactionSourceTypeColumn: string;
  readonly transactionStateColumn: string;
  readonly transactionTransferType: string;
  readonly transactionTypeColumn: string;
}

interface SourceDocumentLineRow {
  readonly effectiveAt: string;
  readonly reasonCode: string | null;
  readonly reasonNarrative: string | null;
  readonly fromLocationId: string | null;
  readonly itemId: string;
  readonly lineNumber: string;
  readonly quantity: string;
  readonly toLocationId: string | null;
  readonly transactionId: string;
  readonly transactionLineId: string;
  readonly transactionSourceId: string;
  readonly transactionSourceType: string;
  readonly transactionType: string;
  readonly unitId: string;
}

interface LedgerMovementRow {
  readonly effectiveAt: string;
  readonly reasonCode: string | null;
  readonly reasonNarrative: string | null;
  readonly transactionId: string | null;
  readonly itemId: string;
  readonly postingRole: string;
  readonly locationId: string;
  readonly movementId: string;
  readonly quantityDelta: string;
  readonly sourceId: string;
  readonly sourceLine: string;
  readonly sourceType: string;
  readonly transactionLineId: string | null;
  readonly unitId: string;
}

interface SourceDocumentSnapshot {
  readonly lines: readonly SourceDocumentLineRow[];
  readonly movements: readonly LedgerMovementRow[];
}

/**
 * The stored scope after normalization. The raw driver value never escapes
 * `selectAnchors`: migration 0020 bounds `cardinality` but neither element
 * nullability nor DIMENSIONALITY, so what comes back is `unknown` in practice
 * and every consumer that treated it as `string[]` was one corrupt row from
 * aborting the sweep. Normalizing once, at the boundary, is what makes that a
 * closed class rather than a list of patched call sites.
 */
interface NormalizedAnchorScope {
  /** Only well-formed, lowercased UUID members. */
  readonly ids: readonly string[];
  /** The raw shape, rendered for an operator, whatever it turned out to be. */
  readonly rendered: string;
  /** True only for a flat array whose every member is a well-formed UUID. */
  readonly wellFormed: boolean;
}

interface AnchorRow {
  readonly anchorDigest: string;
  readonly balanceValue: string;
  readonly baseUnitId: string | null;
  readonly cacheKey: string;
  readonly environmentId: string;
  readonly filterPlanDigest: string;
  readonly principalId: string;
  readonly releaseContentHash: string;
  readonly resultKind: 'exactDecimalResult' | 'quantityResult';
  readonly resultPrecision: number;
  readonly resultScale: number;
  readonly selectionId: string;
  readonly temporalHorizons: Record<string, unknown>;
  readonly tenantId: string;
  readonly legalEntityScope: NormalizedAnchorScope;
  readonly movementGeneration: string;
  readonly parameterValues: Record<string, unknown>;
  readonly queryId: string;
  readonly recordedDiscrepancyCount: string;
}

/**
 * Invocable reconciliation over a named scope, admitted by plan §11.6 build 11.
 *
 * It compares movement sums, the materialized aggregate anchors, and the source
 * documents that produced the movements, and it **emits discrepancies without
 * repairing them**. That property is structural rather than merely intended:
 * the whole sweep runs inside one read-only transaction, so a repair is
 * refused by PostgreSQL rather than avoided by discipline.
 *
 * The arithmetic and the ledger re-derivation are deliberately re-expressed
 * here instead of reusing the posting service's helpers. A verifier that shares
 * a code path with the thing it verifies cannot observe that path being wrong
 * (AGENTS.md section 6).
 *
 * The sweep holds the shared aggregate-generation guard for its whole
 * transaction, because ordinary `READ COMMITTED` statement snapshots would let a
 * posting commit between the document read and the movement read and produce a
 * **false** discrepancy. The operational cost is real and deliberate: while a
 * scope reconciles, movement appends in that tenant and environment wait.
 */
export class PostgresInventoryReconciliationService {
  readonly #binding: ReconciliationStorageBinding;

  constructor(
    private readonly pool: Pool,
    private readonly registration: InventoryReconciliationRegistrationV1,
    private readonly observe?: (
      observation: InventoryReconciliationObservationV1,
    ) => void,
  ) {
    this.#binding = resolveReconciliationStorage(registration.storageTarget);
    validateRegistration(registration);
  }

  async reconcile(
    context: TrustedRequestContext,
    scope: InventoryReconciliationScopeV1,
  ): Promise<InventoryReconciliationReportV1> {
    assertTrustedRequestContext(context);
    const legalEntityIds = validatedScope(scope);
    return withTrustedRequestTransaction(this.pool, context, (client) =>
      withModuleRuntimeRole(client, async () => {
        // Load-bearing: this is what makes "repairs nothing" a property of the
        // transaction rather than a promise about the statements below.
        await client.query('SET LOCAL transaction_read_only = on');
        const transactionReadOnly = await readTransactionReadOnly(client);
        if (transactionReadOnly !== 'on') {
          throw new InventoryReconciliationError(
            'INVENTORY_RECONCILIATION_TRANSACTION_NOT_READ_ONLY',
            'reconciliation refuses to run in a writable transaction',
          );
        }
        // Snapshot coherence. Every movement append advances the generation
        // inside its own transaction and therefore takes this key exclusively,
        // so holding it shared pins the ledger for the whole sweep. Without it
        // a posting committing between the two reads below makes a correct
        // movement look like it has no source document.
        await client.query(
          'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
          [aggregateGenerationLockKey(context.tenantId, context.environmentId)],
        );
        const sourceDocuments = await this.#reconcileSourceDocuments(
          client,
          context,
          legalEntityIds,
        );
        const aggregateAnchors = await this.#reconcileAggregateAnchors(
          client,
          context,
          legalEntityIds,
        );
        const arms = [aggregateAnchors, sourceDocuments];
        const findings = arms.flatMap((arm) => arm.findings);
        const subjectCount = arms.reduce(
          (total, arm) => total + arm.subjectCount,
          0,
        );
        const balances = axisVerdict('balance', arms, findings);
        const integrity = axisVerdict('integrity', arms, findings);
        const report: InventoryReconciliationReportV1 = Object.freeze({
          arms: Object.freeze(arms),
          balances,
          environmentId: context.environmentId,
          integrity,
          findings: Object.freeze(findings),
          legalEntityIds: Object.freeze(legalEntityIds),
          outcome: combinedOutcome([
            ...arms.map((arm) => arm.outcome),
            balances.outcome,
            integrity.outcome,
          ]),
          repairedSubjectCount: 0,
          schemaVersion: INVENTORY_RECONCILIATION_REPORT_VERSION,
          scopeId: scope.scopeId,
          subjectCount,
          tenantId: context.tenantId,
          transactionReadOnly,
        });
        for (const finding of findings) {
          this.#observeSafely({
            armId: finding.armId,
            code: finding.code,
            kind: 'finding',
            outcome: null,
            scopeId: report.scopeId,
            subjectId: finding.subjectId,
          });
        }
        this.#observeSafely({
          armId: null,
          code: null,
          kind: 'reconciled',
          outcome: report.outcome,
          scopeId: report.scopeId,
          subjectId: null,
        });
        return report;
      }),
    );
  }

  /**
   * R1-a. The posting path checks its command against the persisted draft
   * lines; nothing has ever re-read the movements it wrote and asked whether
   * they still say what the document says. A posting that wrote a correct
   * header and wrong movements is invisible until this runs.
   */
  async #reconcileSourceDocuments(
    client: PoolClient,
    context: TrustedRequestContext,
    legalEntityIds: readonly string[],
  ): Promise<InventoryReconciliationArmReportV1> {
    const binding = this.#binding;
    const { lines, movements } = await selectSourceDocumentSnapshot(
      client,
      binding,
      context,
      legalEntityIds,
    );
    const byLine = new Map<string, LedgerMovementRow[]>();
    for (const movement of movements) {
      const key = movement.transactionLineId ?? '';
      const bucket = byLine.get(key);
      if (bucket) bucket.push(movement);
      else byLine.set(key, [movement]);
    }
    const arm = new ArmAccumulator('sourceDocuments');
    for (const line of lines) {
      const observed = byLine.get(line.transactionLineId) ?? [];
      this.#reconcileOneSourceDocumentLine(arm, line, observed);
    }
    const declaredLineIds = new Set(
      lines.map((line) => line.transactionLineId),
    );
    for (const movement of movements) {
      if (
        movement.transactionLineId !== null &&
        declaredLineIds.has(movement.transactionLineId)
      ) {
        continue;
      }
      arm.discrepant(movement.movementId, {
        code: 'SOURCE_DOCUMENT_MISSING_FOR_MOVEMENT',
        declaredValue: null,
        detail: {
          itemId: movement.itemId,
          locationId: movement.locationId,
          movementId: movement.movementId,
          transactionLineId: movement.transactionLineId ?? '',
        },
        observedValue: renderedStoredDecimal(movement.quantityDelta),
      });
    }
    return arm.freeze();
  }

  #reconcileOneSourceDocumentLine(
    arm: ArmAccumulator,
    line: SourceDocumentLineRow,
    observed: readonly LedgerMovementRow[],
  ): void {
    const binding = this.#binding;
    const subjectId = line.transactionLineId;
    const declaredQuantity = renderedStoredDecimal(line.quantity);
    const uncomparable =
      parseStoredDecimal(line.quantity) === null ||
      observed.some(
        (movement) => parseStoredDecimal(movement.quantityDelta) === null,
      );
    if (uncomparable) {
      // Out of the declared storage contract, so no comparison this arm could
      // make would mean anything. Named, never counted as consistent.
      arm.unverifiable(subjectId, {
        code: 'SOURCE_DOCUMENT_LINE_SHAPE_UNRECOGNIZED',
        declaredValue: declaredQuantity,
        detail: {
          lineNumber: line.lineNumber,
          transactionId: line.transactionId,
          transactionLineId: subjectId,
          transactionType: line.transactionType,
        },
        observedValue: null,
      });
      return;
    }
    const expected = expectedLineEffects(binding, line);
    if (!expected) {
      arm.unverifiable(subjectId, {
        code:
          line.transactionType === binding.transactionAdjustmentType ||
          line.transactionType === binding.transactionCountCorrectionType ||
          line.transactionType === binding.transactionTransferType
            ? 'SOURCE_DOCUMENT_LINE_SHAPE_UNRECOGNIZED'
            : 'SOURCE_DOCUMENT_TYPE_UNRECOGNIZED',
        declaredValue: declaredQuantity,
        detail: {
          fromLocationId: line.fromLocationId ?? '',
          lineNumber: line.lineNumber,
          toLocationId: line.toLocationId ?? '',
          transactionId: line.transactionId,
          transactionLineId: subjectId,
          transactionType: line.transactionType,
        },
        observedValue: null,
      });
      return;
    }
    let divergent = false;
    if (observed.length !== expected.movementCount) {
      divergent = true;
      arm.finding({
        code: 'SOURCE_DOCUMENT_MOVEMENT_COUNT_DIVERGED',
        declaredValue: String(expected.movementCount),
        detail: {
          lineNumber: line.lineNumber,
          transactionId: line.transactionId,
          transactionLineId: subjectId,
          transactionType: line.transactionType,
        },
        observedValue: String(observed.length),
        subjectId,
      });
    }
    const observedByLocation = new Map<string, bigint>();
    for (const movement of observed) {
      observedByLocation.set(
        movement.locationId,
        (observedByLocation.get(movement.locationId) ?? 0n) +
          (parseStoredDecimal(movement.quantityDelta) ?? 0n),
      );
      if (movement.itemId !== line.itemId) {
        divergent = true;
        arm.finding({
          code: 'SOURCE_DOCUMENT_ITEM_DIVERGED',
          declaredValue: line.itemId,
          detail: {
            movementId: movement.movementId,
            transactionId: line.transactionId,
            transactionLineId: subjectId,
          },
          observedValue: movement.itemId,
          subjectId,
        });
      }
      if (movement.unitId !== line.unitId) {
        divergent = true;
        arm.finding({
          code: 'SOURCE_DOCUMENT_UNIT_DIVERGED',
          declaredValue: line.unitId,
          detail: {
            movementId: movement.movementId,
            transactionId: line.transactionId,
            transactionLineId: subjectId,
          },
          observedValue: movement.unitId,
          subjectId,
        });
      }
      const expectedAtLocation = expected.byLocation.get(movement.locationId);
      if (
        expectedAtLocation !== undefined &&
        movement.sourceLine !== expectedAtLocation.sourceLine
      ) {
        // The natural-effect identity: source line is part of the movement's
        // immutable provenance and of the uniqueness key that makes a posting
        // non-duplicable, so a movement filed under a line number its document
        // never issued is corrupt even when every quantity agrees.
        divergent = true;
        arm.finding({
          code: 'SOURCE_DOCUMENT_SOURCE_LINE_DIVERGED',
          declaredValue: expectedAtLocation.sourceLine,
          detail: {
            movementId: movement.movementId,
            transactionId: line.transactionId,
            transactionLineId: subjectId,
          },
          observedValue: movement.sourceLine,
          subjectId,
        });
      }
      if (!expected.postingRoles.has(movement.postingRole)) {
        divergent = true;
        arm.finding({
          code: 'SOURCE_DOCUMENT_POSTING_ROLE_DIVERGED',
          declaredValue: [...expected.postingRoles].toSorted().join('|'),
          detail: {
            movementId: movement.movementId,
            transactionId: line.transactionId,
            transactionLineId: subjectId,
            transactionType: line.transactionType,
          },
          observedValue: movement.postingRole,
          subjectId,
        });
      }
      if (movement.transactionId !== line.transactionId) {
        // The movement carries its own foreign key to a transaction as well as
        // to a line. They can disagree, and nothing else notices. No balance
        // moves -- the on-hand query never joins the transaction -- so this is
        // an integrity fact, reported as one.
        divergent = true;
        arm.finding({
          code: 'SOURCE_DOCUMENT_TRANSACTION_LINK_DIVERGED',
          declaredValue: line.transactionId,
          detail: {
            movementId: movement.movementId,
            transactionLineId: subjectId,
          },
          observedValue: movement.transactionId,
          subjectId,
        });
      }
      if (
        movement.reasonCode !== line.reasonCode ||
        movement.reasonNarrative !== line.reasonNarrative
      ) {
        divergent = true;
        arm.finding({
          code: 'SOURCE_DOCUMENT_REASON_DIVERGED',
          declaredValue: `${line.reasonCode ?? ''}/${line.reasonNarrative ?? ''}`,
          detail: {
            movementId: movement.movementId,
            transactionId: line.transactionId,
            transactionLineId: subjectId,
          },
          observedValue: `${movement.reasonCode ?? ''}/${movement.reasonNarrative ?? ''}`,
          subjectId,
        });
      }
      if (movement.effectiveAt !== line.effectiveAt) {
        // The date a movement takes effect decides which period it lands in and
        // which as-of balance contains it, so a movement effective on a
        // different day than the document that produced it is a balance-
        // significant divergence even when every quantity agrees.
        divergent = true;
        arm.finding({
          code: 'SOURCE_DOCUMENT_EFFECTIVE_AT_DIVERGED',
          declaredValue: line.effectiveAt,
          detail: {
            movementId: movement.movementId,
            transactionId: line.transactionId,
            transactionLineId: subjectId,
          },
          observedValue: movement.effectiveAt,
          subjectId,
        });
      }
      if (
        movement.sourceType !== line.transactionSourceType ||
        movement.sourceId !== line.transactionSourceId
      ) {
        divergent = true;
        arm.finding({
          code: 'SOURCE_DOCUMENT_SOURCE_IDENTITY_DIVERGED',
          declaredValue: `${line.transactionSourceType}/${line.transactionSourceId}`,
          detail: {
            movementId: movement.movementId,
            transactionId: line.transactionId,
            transactionLineId: subjectId,
          },
          observedValue: `${movement.sourceType}/${movement.sourceId}`,
          subjectId,
        });
      }
    }
    const locations = new Set([
      ...expected.byLocation.keys(),
      ...observedByLocation.keys(),
    ]);
    for (const locationId of [...locations].sort()) {
      const declared = expected.byLocation.get(locationId)?.quantity ?? 0n;
      const summed = observedByLocation.get(locationId) ?? 0n;
      if (declared === summed) continue;
      divergent = true;
      arm.finding({
        code: 'SOURCE_DOCUMENT_QUANTITY_DIVERGED',
        declaredValue: scaledToDecimal(declared),
        detail: {
          itemId: line.itemId,
          lineNumber: line.lineNumber,
          locationId,
          transactionId: line.transactionId,
          transactionLineId: subjectId,
          transactionType: line.transactionType,
          unitId: line.unitId,
        },
        observedValue: scaledToDecimal(summed),
        subjectId,
      });
    }
    if (divergent) arm.markDiscrepant(subjectId);
    else arm.consistent(subjectId);
  }

  /**
   * R1-b. The read path verifies an anchor only when somebody reads it, so a
   * balance nobody looks at is never verified at all. This re-derives every
   * live anchor in the scope straight from the movement ledger, with no read
   * of the aggregate query involved.
   */
  async #reconcileAggregateAnchors(
    client: PoolClient,
    context: TrustedRequestContext,
    legalEntityIds: readonly string[],
  ): Promise<InventoryReconciliationArmReportV1> {
    const generation = await readMovementGeneration(client, context);
    const anchors = await selectAnchors(client, context);
    const arm = new ArmAccumulator('aggregateAnchors');
    for (const anchor of anchors) {
      const registered = anchor.queryId === this.registration.aggregateQueryId;
      const parameters = registered
        ? recognizedAnchorParameters(this.registration, anchor.parameterValues)
        : null;
      // Attribution takes the UNION of every authority the anchor carries, each
      // read independently of the others: the stored scope column, and the
      // query's own legal-entity operand read on its own. Trusting the stored
      // column alone lets a corrupt anchor -- operand A, stored scope B -- be
      // excluded from A as out of scope. Taking the operand only from
      // whole-parameter recognition is the same hole one step in, because that
      // recognition is all-or-nothing: a malformed SIBLING parameter would
      // discard a perfectly readable scope authority and make the anchor
      // unattributable to A as well.
      const attributedTo = new Set(anchor.legalEntityScope.ids);
      const operand = registered
        ? anchorScopeOperand(this.registration, anchor.parameterValues)
        : null;
      if (operand) attributedTo.add(operand);
      // No authority can place this anchor anywhere. Excluding it from this
      // scope would exclude it from EVERY scope, so it is a subject of all of
      // them until someone repairs it: the alternative is a live anchor no
      // report ever mentions.
      const placeable = attributedTo.size > 0;
      if (
        placeable &&
        ![...attributedTo].some((legalEntityId) =>
          legalEntityIds.includes(legalEntityId),
        )
      ) {
        arm.excluded(anchor.cacheKey, 'outOfScope');
        continue;
      }
      if (anchor.movementGeneration !== generation) {
        // A superseded anchor cannot be served, so there is nothing to
        // re-derive. A discrepancy RECORDED against it is a different fact and
        // still the only trace that the read path once caught something --
        // and excluding it would bury every recorded discrepancy the moment the
        // next posting advances the generation, which is to say almost always.
        if (anchor.recordedDiscrepancyCount !== '0') {
          arm.discrepant(anchor.cacheKey, {
            code: 'RECORDED_ANCHOR_DISCREPANCY_PRESERVED',
            declaredValue: renderedStoredDecimal(anchor.balanceValue),
            detail: {
              cacheKey: anchor.cacheKey,
              movementGeneration: anchor.movementGeneration,
              queryId: anchor.queryId,
              recordedDiscrepancyCount: anchor.recordedDiscrepancyCount,
              supersededBy: generation,
            },
            observedValue: null,
          });
          continue;
        }
        arm.excluded(anchor.cacheKey, 'supersededGeneration');
        continue;
      }
      await this.#reconcileOneAnchor(client, context, arm, anchor, parameters);
    }
    return arm.freeze();
  }

  async #reconcileOneAnchor(
    client: PoolClient,
    context: TrustedRequestContext,
    arm: ArmAccumulator,
    anchor: AnchorRow,
    parameters: RecognizedAnchorParameters | null,
  ): Promise<void> {
    const subjectId = anchor.cacheKey;
    const declaredScaled = parseStoredDecimal(anchor.balanceValue);
    const declared =
      declaredScaled === null ? null : scaledToDecimal(declaredScaled);

    // INTEGRITY FIRST, deliberately. Every balance branch below can return
    // early, and when integrity ran after them a recorded discrepancy or a
    // corrupt digest on an anchor the balance arm could not read was simply
    // never reported. Ordering is what closes that, not a guard per branch.
    let integrityDivergent = false;
    if (anchor.recordedDiscrepancyCount !== '0') {
      // The read path already caught something here and preserved the evidence.
      // Nothing else in the system has ever shown it to anybody.
      integrityDivergent = true;
      arm.finding({
        code: 'RECORDED_ANCHOR_DISCREPANCY_PRESERVED',
        declaredValue: declared ?? anchor.balanceValue,
        detail: {
          cacheKey: subjectId,
          queryId: anchor.queryId,
          recordedDiscrepancyCount: anchor.recordedDiscrepancyCount,
        },
        observedValue: null,
        subjectId,
      });
    }
    const integrity = anchorIntegrity(anchor);
    if (!integrity) {
      // The digest was NOT checked. Saying nothing here let the integrity
      // verdict count this anchor as consistent -- ADR-0044's undeclared
      // inability, on the axis this packet created to prevent it.
      arm.unverifiable(subjectId, {
        code: 'AGGREGATE_ANCHOR_INTEGRITY_UNVERIFIABLE',
        declaredValue: anchor.anchorDigest,
        detail: {
          cacheKey: subjectId,
          queryId: anchor.queryId,
          storedScope: anchor.legalEntityScope.rendered,
        },
        observedValue: null,
      });
    }
    if (integrity) {
      if (integrity.anchorDigest !== anchor.anchorDigest) {
        // The read path verifies this on every read; until now the sweep
        // verified only the balance, so a restored or defectively computed
        // anchor with a correct value and a wrong digest read as consistent.
        integrityDivergent = true;
        arm.finding({
          code: 'AGGREGATE_ANCHOR_DIGEST_DIVERGED',
          declaredValue: anchor.anchorDigest,
          detail: { cacheKey: subjectId, queryId: anchor.queryId },
          observedValue: integrity.anchorDigest,
          subjectId,
        });
      }
    }
    if (integrityDivergent) arm.markDiscrepant(subjectId);

    if (anchor.queryId !== this.registration.aggregateQueryId) {
      arm.unverifiable(subjectId, {
        code: 'AGGREGATE_ANCHOR_QUERY_UNRECOGNIZED',
        declaredValue: declared,
        detail: { cacheKey: subjectId, queryId: anchor.queryId },
        observedValue: null,
      });
      return;
    }
    if (declared === null) {
      // A stored balance outside numeric(38,18) is not comparable. Refusing to
      // compare it is the only honest answer; treating it as zero would report
      // a corrupt anchor as clean.
      arm.unverifiable(subjectId, {
        code: 'AGGREGATE_ANCHOR_BALANCE_UNRECOGNIZED',
        declaredValue: anchor.balanceValue,
        detail: { cacheKey: subjectId, queryId: anchor.queryId },
        observedValue: null,
      });
      return;
    }
    if (!parameters) {
      arm.unverifiable(subjectId, {
        code: 'AGGREGATE_ANCHOR_PARAMETERS_UNRECOGNIZED',
        declaredValue: declared,
        detail: { cacheKey: subjectId, queryId: anchor.queryId },
        observedValue: null,
      });
      return;
    }
    // The registered query scopes itself with exactly one legal entity taken
    // from its own operand, so a stored scope that disagrees with that operand
    // is an anchor whose cached value answers a different question than its key
    // claims. Summing over either side would launder the defect.
    const storedScope = anchor.legalEntityScope;
    if (
      !storedScope.wellFormed ||
      storedScope.ids.length !== 1 ||
      storedScope.ids[0] !== parameters.legalEntityId
    ) {
      arm.discrepant(subjectId, {
        code: 'AGGREGATE_ANCHOR_SCOPE_DIVERGED',
        declaredValue: storedScope.rendered,
        detail: {
          cacheKey: subjectId,
          queryId: anchor.queryId,
        },
        observedValue: parameters.legalEntityId,
      });
      return;
    }
    const observed = await sumMovementLedger(
      client,
      this.#binding,
      context,
      [parameters.legalEntityId],
      parameters,
    );
    if (observed === null) {
      arm.unverifiable(subjectId, {
        code: 'AGGREGATE_ANCHOR_BALANCE_UNRECOGNIZED',
        declaredValue: declared,
        detail: { cacheKey: subjectId, queryId: anchor.queryId },
        observedValue: null,
      });
      return;
    }
    let divergent = false;
    if (declared !== observed) {
      divergent = true;
      arm.finding({
        code: 'AGGREGATE_ANCHOR_LEDGER_DIVERGED',
        declaredValue: declared,
        detail: {
          atTime: parameters.atTime,
          cacheKey: subjectId,
          itemId: parameters.itemId,
          legalEntityIds: parameters.legalEntityId,
          locationId: parameters.locationId,
          queryId: anchor.queryId,
          recordedAtHorizon: parameters.recordedAtHorizon,
        },
        observedValue: observed,
        subjectId,
      });
    }
    if (divergent || integrityDivergent) arm.markDiscrepant(subjectId);
    else arm.consistent(subjectId);
  }

  #observeSafely(observation: InventoryReconciliationObservationV1): void {
    try {
      this.observe?.(Object.freeze(observation));
    } catch {
      // Instrumentation is evidence, never reconciliation authority.
    }
  }
}

/**
 * R1-c. A discrepancy nobody can read is a discrepancy nobody acts on, so the
 * report has one deterministic human-readable rendering and the counts are
 * stated even when they are zero.
 */
export function renderInventoryReconciliationReport(
  report: InventoryReconciliationReportV1,
): readonly string[] {
  const lines = [
    `inventory reconciliation ${report.scopeId}: ${report.outcome.toUpperCase()}`,
    `  tenant=${report.tenantId} environment=${report.environmentId} legalEntities=${report.legalEntityIds.join(',')}`,
    `  balances=${report.balances.outcome.toUpperCase()} integrity=${report.integrity.outcome.toUpperCase()}`,
    `  subjects=${String(report.subjectCount)} findings=${String(report.findings.length)} repaired=${String(report.repairedSubjectCount)} transactionReadOnly=${report.transactionReadOnly}`,
  ];
  for (const arm of report.arms) {
    lines.push(
      `  arm ${arm.armId}: ${arm.outcome.toUpperCase()} — ${String(arm.subjectCount)} subject(s), ${String(arm.consistentSubjectIds.length)} consistent, ${String(arm.discrepantSubjectIds.length)} discrepant, ${String(arm.unverifiableSubjectIds.length)} unverifiable, ${String(arm.excludedSubjects.length)} excluded`,
    );
    for (const subjectId of arm.consistentSubjectIds) {
      lines.push(`    consistent ${subjectId}`);
    }
    for (const excluded of arm.excludedSubjects) {
      lines.push(`    excluded ${excluded.subjectId} (${excluded.reason})`);
    }
    for (const finding of arm.findings) {
      lines.push(`    ${renderFinding(finding)}`);
    }
  }
  return Object.freeze(lines);
}

function renderFinding(finding: InventoryReconciliationFindingV1): string {
  const detail = Object.keys(finding.detail)
    .sort()
    .map((key) => `${key}=${finding.detail[key] ?? ''}`)
    .join(' ');
  return `[${finding.code}] ${finding.subjectId}: document declares ${finding.declaredValue ?? '(none)'}, movement ledger observes ${finding.observedValue ?? '(unchecked)'} — ${detail}`;
}

class ArmAccumulator {
  readonly #consistent: string[] = [];
  readonly #discrepant = new Set<string>();
  readonly #findings: InventoryReconciliationFindingV1[] = [];
  readonly #unverifiable: string[] = [];
  readonly #excluded: InventoryReconciliationExclusionV1[] = [];
  readonly #subjects = new Set<string>();

  constructor(private readonly armId: InventoryReconciliationArmIdV1) {}

  consistent(subjectId: string): void {
    this.#consistent.push(subjectId);
    this.#subjects.add(subjectId);
  }

  excluded(
    subjectId: string,
    reason: InventoryReconciliationExclusionReasonV1,
  ): void {
    this.#excluded.push(Object.freeze({ reason, subjectId }));
  }

  finding(finding: Omit<InventoryReconciliationFindingV1, 'armId'>): void {
    this.#findings.push(
      Object.freeze({
        ...finding,
        armId: this.armId,
        detail: Object.freeze({ ...finding.detail }),
      }),
    );
  }

  markDiscrepant(subjectId: string): void {
    this.#discrepant.add(subjectId);
    this.#subjects.add(subjectId);
  }

  discrepant(
    subjectId: string,
    finding: Omit<InventoryReconciliationFindingV1, 'armId' | 'subjectId'>,
  ): void {
    this.finding({ ...finding, subjectId });
    this.markDiscrepant(subjectId);
  }

  unverifiable(
    subjectId: string,
    finding: Omit<InventoryReconciliationFindingV1, 'armId' | 'subjectId'>,
  ): void {
    this.finding({ ...finding, subjectId });
    this.#unverifiable.push(subjectId);
    this.#subjects.add(subjectId);
  }

  freeze(): InventoryReconciliationArmReportV1 {
    const consistent = this.#consistent.filter(
      (subjectId) => !this.#discrepant.has(subjectId),
    );
    const subjectCount =
      consistent.length + this.#discrepant.size + this.#unverifiable.length;
    if (subjectCount === 0) {
      this.finding({
        code: 'SCOPE_OBSERVED_NO_SUBJECTS',
        declaredValue: null,
        detail: { armId: this.armId },
        observedValue: null,
        subjectId: this.armId,
      });
    }
    return Object.freeze({
      armId: this.armId,
      consistentSubjectIds: Object.freeze(consistent.toSorted()),
      discrepantSubjectIds: Object.freeze([...this.#discrepant].toSorted()),
      excludedSubjects: Object.freeze([...this.#excluded]),
      findings: Object.freeze([...this.#findings]),
      outcome:
        subjectCount === 0
          ? 'indeterminate'
          : this.#discrepant.size > 0
            ? 'discrepant'
            : this.#unverifiable.length > 0
              ? 'indeterminate'
              : 'consistent',
      subjectCount,
      subjectIds: Object.freeze([...this.#subjects].toSorted()),
      unverifiableSubjectIds: Object.freeze(this.#unverifiable.toSorted()),
    });
  }
}

/**
 * One verdict over one axis. A subject is consistent on an axis when nothing
 * found against it says otherwise ON THAT AXIS — so a provenance defect leaves
 * the balance verdict clean, and a wrong balance leaves provenance clean.
 */
function axisVerdict(
  axis: InventoryReconciliationAxisV1,
  arms: readonly InventoryReconciliationArmReportV1[],
  findings: readonly InventoryReconciliationFindingV1[],
): InventoryReconciliationVerdictV1 {
  const subjects = new Set(arms.flatMap((arm) => [...arm.subjectIds]));
  // An arm that observed nothing is indeterminate, and that has to reach the
  // authoritative verdicts. Reading it off `subjects` alone silently dropped
  // it, so one clean line in the other arm could report both axes clean while
  // the anchor sweep had seen no anchors at all.
  const blindArms = arms.filter((arm) => arm.subjectCount === 0);
  const discrepant = new Set<string>();
  const unverifiable = new Set<string>();
  for (const finding of findings) {
    const effect = FINDING_AXIS_EFFECTS[finding.code][axis];
    if (effect === 'unaffected') continue;
    if (!subjects.has(finding.subjectId)) continue;
    if (effect === 'discrepant') discrepant.add(finding.subjectId);
    else unverifiable.add(finding.subjectId);
  }
  const consistent = [...subjects].filter(
    (subjectId) => !discrepant.has(subjectId) && !unverifiable.has(subjectId),
  );
  return Object.freeze({
    axis,
    consistentSubjectIds: Object.freeze(consistent.toSorted()),
    discrepantSubjectIds: Object.freeze([...discrepant].toSorted()),
    outcome:
      subjects.size === 0
        ? 'indeterminate'
        : discrepant.size > 0
          ? 'discrepant'
          : unverifiable.size > 0 || blindArms.length > 0
            ? 'indeterminate'
            : 'consistent',
    subjectCount: subjects.size,
    unverifiableSubjectIds: Object.freeze([...unverifiable].toSorted()),
  });
}

function combinedOutcome(
  outcomes: readonly InventoryReconciliationOutcomeV1[],
): InventoryReconciliationOutcomeV1 {
  if (outcomes.includes('discrepant')) return 'discrepant';
  if (outcomes.includes('indeterminate')) return 'indeterminate';
  if (outcomes.length === 0) return 'indeterminate';
  return 'consistent';
}

interface ExpectedLocationEffect {
  readonly quantity: bigint;
  readonly sourceLine: string;
}

/**
 * The complete set of movement facts this arm derives from the document.
 * Enumerated deliberately: two review rounds each found "one more field nobody
 * compares", which is a signal that the comparison set was never written down
 * rather than that any single field mattered most.
 */
interface ExpectedLineEffects {
  readonly byLocation: ReadonlyMap<string, ExpectedLocationEffect>;
  readonly movementCount: number;
  readonly postingRoles: ReadonlySet<string>;
}

/**
 * The document's own statement of what the ledger must contain, derived from
 * the persisted line and its transaction type — never from the posting command
 * that produced them, which no longer exists by the time this runs.
 */
function expectedLineEffects(
  binding: ReconciliationStorageBinding,
  line: SourceDocumentLineRow,
): ExpectedLineEffects | null {
  const quantity = parseStoredDecimal(line.quantity);
  if (quantity === null) return null;
  if (line.transactionType === binding.transactionTransferType) {
    if (
      line.fromLocationId === null ||
      line.toLocationId === null ||
      line.fromLocationId === line.toLocationId
    ) {
      return null;
    }
    return {
      byLocation: new Map([
        [
          line.fromLocationId,
          {
            quantity: -quantity,
            sourceLine: `${line.lineNumber}:out`,
          },
        ],
        [line.toLocationId, { quantity, sourceLine: `${line.lineNumber}:in` }],
      ]),
      movementCount: 2,
      postingRoles: new Set([binding.movementPostingRoleTransfer]),
    };
  }
  if (
    line.transactionType !== binding.transactionAdjustmentType &&
    line.transactionType !== binding.transactionCountCorrectionType
  ) {
    return null;
  }
  const declaredLocations = [line.fromLocationId, line.toLocationId].filter(
    (locationId): locationId is string => locationId !== null,
  );
  if (declaredLocations.length !== 1) return null;
  const negative = quantity < 0n;
  if (negative !== (line.fromLocationId !== null)) return null;
  return {
    byLocation: new Map([
      [declaredLocations[0]!, { quantity, sourceLine: line.lineNumber }],
    ]),
    movementCount: 1,
    // A count correction posts as either an initial count or a correction, and
    // which one is a fact about the stock-count session rather than about the
    // transaction, so both are admissible from the document alone.
    postingRoles:
      line.transactionType === binding.transactionAdjustmentType
        ? new Set([binding.movementPostingRoleAdjustment])
        : new Set([
            binding.movementPostingRoleCount,
            binding.movementPostingRoleCorrection,
          ]),
  };
}

interface RecognizedAnchorParameters {
  readonly atTime: string;
  readonly itemId: string;
  /** The query's own legal-entity operand, which is the scope authority. */
  readonly legalEntityId: string;
  readonly locationId: string;
  readonly recordedAtHorizon: string;
}

/**
 * The integrity digests this anchor's own stored content implies, or `null`
 * when the stored content cannot be read at all. Routed through the read
 * path's exported derivation so the sweep cannot drift from the check it
 * extends.
 */
function anchorIntegrity(
  anchor: AnchorRow,
): { readonly anchorDigest: string; readonly cacheKey: string } | null {
  // The digest is taken over the stored identity, and a malformed stored scope
  // is not an identity. Such an anchor is already reported by the scope rule;
  // deriving a digest from a repaired reading of it would compare nothing.
  if (!anchor.legalEntityScope.wellFormed) return null;
  try {
    return expectedAggregateAnchorIntegrity({
      anchorDigest: anchor.anchorDigest,
      balanceValue: anchor.balanceValue,
      baseUnitId: anchor.baseUnitId,
      cacheKey: anchor.cacheKey,
      environmentId: anchor.environmentId,
      filterPlanDigest: anchor.filterPlanDigest,
      legalEntityIds: anchor.legalEntityScope.ids,
      movementGeneration: anchor.movementGeneration,
      parameterValues: anchor.parameterValues as Parameters<
        typeof expectedAggregateAnchorIntegrity
      >[0]['parameterValues'],
      principalId: anchor.principalId,
      queryId: anchor.queryId,
      releaseContentHash: anchor.releaseContentHash,
      resultKind: anchor.resultKind,
      resultPrecision: anchor.resultPrecision,
      resultScale: anchor.resultScale,
      selectionId: anchor.selectionId,
      temporalHorizons: anchor.temporalHorizons as Parameters<
        typeof expectedAggregateAnchorIntegrity
      >[0]['temporalHorizons'],
      tenantId: anchor.tenantId,
    });
  } catch {
    // An anchor whose stored content the read path itself cannot decode is
    // reported by the balance arm as unrecognized; there is no digest to check.
    return null;
  }
}

/**
 * The scope authority alone, read independently of every sibling parameter and
 * of whole-parameter recognition.
 *
 * `recognizedAnchorParameters` is deliberately all-or-nothing: it gates whether
 * a balance can be RE-DERIVED, and a malformed horizon makes that impossible.
 * Attribution is a different question and must not inherit that verdict. An
 * anchor whose stored scope is wrong and whose horizon is corrupt still names a
 * legal entity here, and that is the one authority that can put it in front of
 * the scope it actually concerns.
 */
function anchorScopeOperand(
  registration: InventoryReconciliationRegistrationV1,
  parameterValues: Record<string, unknown>,
): string | null {
  const value =
    parameterValues[registration.aggregateParameterIds.legalEntityId];
  return typeof value === 'string' && uuidPattern.test(value)
    ? value.toLowerCase()
    : null;
}

function recognizedAnchorParameters(
  registration: InventoryReconciliationRegistrationV1,
  parameterValues: Record<string, unknown>,
): RecognizedAnchorParameters | null {
  const ids = registration.aggregateParameterIds;
  const expectedIds = [
    ids.atTime,
    ids.itemId,
    ids.legalEntityId,
    ids.locationId,
    ids.recordedAtHorizon,
  ].toSorted();
  const presentIds = Object.keys(parameterValues).toSorted();
  if (
    presentIds.length !== expectedIds.length ||
    presentIds.some((id, index) => id !== expectedIds[index])
  ) {
    return null;
  }
  const itemId = parameterValues[ids.itemId];
  const legalEntityId = parameterValues[ids.legalEntityId];
  const locationId = parameterValues[ids.locationId];
  const atTime = parameterValues[ids.atTime];
  const recordedAtHorizon = parameterValues[ids.recordedAtHorizon];
  if (
    typeof itemId !== 'string' ||
    typeof legalEntityId !== 'string' ||
    typeof locationId !== 'string' ||
    typeof atTime !== 'string' ||
    typeof recordedAtHorizon !== 'string' ||
    !uuidPattern.test(itemId) ||
    !uuidPattern.test(legalEntityId) ||
    !uuidPattern.test(locationId) ||
    !instantPattern.test(atTime) ||
    !instantPattern.test(recordedAtHorizon)
  ) {
    return null;
  }
  return Object.freeze({
    atTime,
    itemId,
    legalEntityId: legalEntityId.toLowerCase(),
    locationId,
    recordedAtHorizon,
  });
}

async function readTransactionReadOnly(client: PoolClient): Promise<string> {
  const result = await client.query<{ readOnly: string }>(
    `SELECT current_setting('transaction_read_only') AS "readOnly"`,
  );
  return String(result.rows[0]?.readOnly ?? '');
}

async function readMovementGeneration(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<string> {
  const result = await client.query<{ movementGeneration: string }>(
    `SELECT movement_generation::text AS "movementGeneration"
       FROM north_star_internal.semantic_aggregate_generations
      WHERE tenant_id = $1 AND environment_id = $2`,
    [context.tenantId, context.environmentId],
  );
  return result.rows[0]?.movementGeneration ?? '0';
}

/**
 * Exported only as a test seam: the raw-property absence is a fact about the
 * returned OBJECT, and the type already claims the property is gone, so a
 * control has to observe the object itself.
 */
export async function selectAnchors(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<AnchorRow[]> {
  const result = await client.query<AnchorRow>(
    `SELECT anchor.cache_key AS "cacheKey",
            anchor.tenant_id::text AS "tenantId",
            anchor.environment_id::text AS "environmentId",
            anchor.principal_id::text AS "principalId",
            anchor.release_content_hash AS "releaseContentHash",
            anchor.filter_plan_digest AS "filterPlanDigest",
            anchor.temporal_horizons AS "temporalHorizons",
            anchor.result_kind AS "resultKind",
            anchor.result_precision AS "resultPrecision",
            anchor.result_scale AS "resultScale",
            anchor.selection_id AS "selectionId",
            anchor.base_unit_id AS "baseUnitId",
            anchor.anchor_digest AS "anchorDigest",
            anchor.movement_generation::text AS "movementGeneration",
            anchor.query_id AS "queryId",
            anchor.legal_entity_ids::text[] AS "legalEntityIds",
            anchor.parameter_values AS "parameterValues",
            anchor.balance_value AS "balanceValue",
            (
              SELECT count(*)::text
                FROM north_star_internal.semantic_aggregate_anchor_discrepancies
                       AS recorded
               WHERE recorded.tenant_id = anchor.tenant_id
                 AND recorded.environment_id = anchor.environment_id
                 AND recorded.cache_key = anchor.cache_key
            ) AS "recordedDiscrepancyCount"
       FROM north_star_internal.semantic_aggregate_anchors AS anchor
      WHERE anchor.tenant_id = $1 AND anchor.environment_id = $2
      ORDER BY anchor.cache_key`,
    [context.tenantId, context.environmentId],
  );
  return result.rows.map((row) => {
    // Destructured out, not merely undeclared. Spreading the row carried the
    // raw array onto every anchor object beside its normalized form: invisible
    // to the type, present at runtime, and reusable by the next consumer.
    const { legalEntityIds, ...rest } = row as unknown as Omit<
      AnchorRow,
      'legalEntityScope'
    > & { legalEntityIds: unknown };
    return Object.freeze({
      ...rest,
      legalEntityScope: normalizeAnchorScope(legalEntityIds),
    });
  });
}

function normalizeAnchorScope(value: unknown): NormalizedAnchorScope {
  if (!Array.isArray(value) || value.length === 0) {
    return Object.freeze({
      ids: Object.freeze([]),
      rendered: renderStoredScope(value),
      wellFormed: false,
    });
  }
  const ids: string[] = [];
  let wellFormed = true;
  for (const member of value) {
    if (typeof member === 'string' && uuidPattern.test(member)) {
      ids.push(member.toLowerCase());
    } else {
      wellFormed = false;
    }
  }
  // A well-formed scope reads as the identifiers themselves; only a malformed
  // one costs the operator the raw shape, which is exactly when they need it.
  return Object.freeze({
    ids: Object.freeze(ids),
    rendered: wellFormed ? ids.join(',') : renderStoredScope(value),
    wellFormed,
  });
}

function renderStoredScope(value: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = '(unrenderable)';
  }
  return rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered;
}

async function sumMovementLedger(
  client: PoolClient,
  binding: ReconciliationStorageBinding,
  context: TrustedRequestContext,
  legalEntityIds: readonly string[],
  parameters: RecognizedAnchorParameters,
): Promise<string | null> {
  const movement = binding.movement;
  const result = await client.query<{ balance: string }>(
    `SELECT COALESCE(SUM(${quoted(binding.movementQuantityColumn)}), 0)::text
              AS balance
       FROM ${table(binding, movement)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(movement.legalEntityColumn)} = ANY($3::uuid[])
        AND ${quoted(requiredColumn(movement, 'inventory_movement_item_id'))} = $4
        AND ${quoted(requiredColumn(movement, 'inventory_movement_location_id'))} = $5
        AND ${quoted(requiredColumn(movement, 'inventory_movement_effective_at'))} <= $6::timestamptz
        AND ${quoted(requiredColumn(movement, 'inventory_movement_recorded_at'))} <= $7::timestamptz
        AND ${quoted(movement.archiveColumn)} IS NULL`,
    [
      context.tenantId,
      context.environmentId,
      [...legalEntityIds],
      parameters.itemId,
      parameters.locationId,
      parameters.atTime,
      parameters.recordedAtHorizon,
    ],
  );
  const scaled = parseStoredDecimal(result.rows[0]?.balance ?? '0');
  return scaled === null ? null : scaledToDecimal(scaled);
}

/**
 * Both sides in ONE statement, deliberately.
 *
 * Two statements would be two `READ COMMITTED` snapshots, and any writer that
 * commits between them splits the comparison: a transaction line is an ordinary
 * updatable entity whose updates do not advance the aggregate generation, so the
 * generation guard alone cannot make the pair coherent. Reading the documents
 * and the movements they produced in a single statement removes the race for
 * every writer rather than for the one this module happens to know about.
 */
async function selectSourceDocumentSnapshot(
  client: PoolClient,
  binding: ReconciliationStorageBinding,
  context: TrustedRequestContext,
  legalEntityIds: readonly string[],
): Promise<SourceDocumentSnapshot> {
  const line = binding.transactionLine;
  const header = binding.transaction;
  const movement = binding.movement;
  const result = await client.query<{
    lines: SourceDocumentLineRow[];
    movements: LedgerMovementRow[];
  }>(
    `WITH document_line AS (
       SELECT line.${quoted(line.recordIdColumn)}::text AS "transactionLineId",
              header.${quoted(header.recordIdColumn)}::text AS "transactionId",
              line.${quoted(binding.transactionLineItemColumn)}::text AS "itemId",
              line.${quoted(binding.transactionLineFromLocationColumn)}::text
                AS "fromLocationId",
              line.${quoted(binding.transactionLineToLocationColumn)}::text
                AS "toLocationId",
              line.${quoted(binding.transactionLineQuantityColumn)}::text
                AS "quantity",
              line.${quoted(binding.transactionLineNumberColumn)}::text
                AS "lineNumber",
              line.${quoted(binding.transactionLineUnitColumn)}::text AS "unitId",
              header.${quoted(binding.transactionTypeColumn)}::text
                AS "transactionType",
              header.${quoted(binding.transactionSourceTypeColumn)}::text
                AS "transactionSourceType",
              header.${quoted(binding.transactionSourceIdColumn)}::text
                AS "transactionSourceId",
              header.${quoted(binding.transactionReasonCodeColumn)}::text
                AS "reasonCode",
              header.${quoted(binding.transactionReasonNarrativeColumn)}::text
                AS "reasonNarrative",
              to_char(
                header.${quoted(binding.transactionEffectiveAtColumn)}
                  AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS "effectiveAt"
         FROM ${table(binding, line)} AS line
         JOIN ${table(binding, header)} AS header
           ON header.tenant_id = line.tenant_id
          AND header.environment_id = line.environment_id
          AND header.${quoted(header.recordIdColumn)} =
              line.${quoted(binding.transactionLineRelationToTransactionColumn)}
        WHERE line.tenant_id = $1 AND line.environment_id = $2
          AND line.${quoted(line.legalEntityColumn)} = ANY($3::uuid[])
          AND line.${quoted(line.archiveColumn)} IS NULL
          AND header.${quoted(header.archiveColumn)} IS NULL
          AND header.${quoted(binding.transactionStateColumn)} = $4
     ), linked_movement AS (
       SELECT ${quoted(movement.recordIdColumn)}::text AS "movementId",
              ${quoted(binding.movementRelationToLineColumn)}::text
                AS "transactionLineId",
              ${quoted(requiredColumn(movement, 'inventory_movement_item_id'))}::text
                AS "itemId",
              ${quoted(requiredColumn(movement, 'inventory_movement_location_id'))}::text
                AS "locationId",
              ${quoted(binding.movementQuantityColumn)}::text AS "quantityDelta",
              ${quoted(requiredColumn(movement, 'inventory_movement_unit_id'))}::text
                AS "unitId",
              ${quoted(requiredColumn(movement, 'inventory_movement_source_type'))}::text
                AS "sourceType",
              ${quoted(requiredColumn(movement, 'inventory_movement_source_id'))}::text
                AS "sourceId",
              ${quoted(requiredColumn(movement, 'inventory_movement_source_line'))}::text
                AS "sourceLine",
              ${quoted(requiredColumn(movement, 'inventory_movement_posting_role'))}::text
                AS "postingRole",
              ${quoted(requiredColumn(movement, 'inventory_movement_reason_code'))}::text
                AS "reasonCode",
              ${quoted(requiredColumn(movement, 'inventory_movement_reason_narrative'))}::text
                AS "reasonNarrative",
              ${quoted(binding.movementRelationToTransactionColumn)}::text
                AS "transactionId",
              to_char(
                ${quoted(requiredColumn(movement, 'inventory_movement_effective_at'))}
                  AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS "effectiveAt"
         FROM ${table(binding, movement)}
        WHERE tenant_id = $1 AND environment_id = $2
          AND ${quoted(movement.legalEntityColumn)} = ANY($3::uuid[])
          AND ${quoted(movement.archiveColumn)} IS NULL
     )
     SELECT
       COALESCE(
         (
           SELECT jsonb_agg(
                    to_jsonb(document_line)
                    ORDER BY document_line."transactionLineId"
                  )
             FROM document_line
         ),
         '[]'::jsonb
       ) AS lines,
       COALESCE(
         (
           SELECT jsonb_agg(
                    to_jsonb(linked_movement)
                    ORDER BY linked_movement."movementId"
                  )
             FROM linked_movement
         ),
         '[]'::jsonb
       ) AS movements`,
    [
      context.tenantId,
      context.environmentId,
      [...legalEntityIds],
      binding.transactionPostedState,
    ],
  );
  const snapshot = result.rows[0];
  if (!snapshot) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      'source-document snapshot returned no row',
    );
  }
  return Object.freeze({
    lines: snapshot.lines,
    movements: snapshot.movements,
  });
}

function validatedScope(scope: InventoryReconciliationScopeV1): string[] {
  if (typeof scope.scopeId !== 'string' || scope.scopeId.trim() === '') {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_SCOPE_INVALID',
      'a reconciliation scope must be named',
    );
  }
  if (
    !Array.isArray(scope.legalEntityIds) ||
    scope.legalEntityIds.length === 0
  ) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_SCOPE_INVALID',
      'a reconciliation scope must name at least one legal entity',
    );
  }
  const legalEntityIds = scope.legalEntityIds.map((legalEntityId) => {
    if (typeof legalEntityId !== 'string' || !uuidPattern.test(legalEntityId)) {
      throw new InventoryReconciliationError(
        'INVENTORY_RECONCILIATION_SCOPE_INVALID',
        'a reconciliation scope legal entity must be a UUID',
      );
    }
    return legalEntityId.toLowerCase();
  });
  if (new Set(legalEntityIds).size !== legalEntityIds.length) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_SCOPE_INVALID',
      'a reconciliation scope repeats a legal entity',
    );
  }
  return legalEntityIds;
}

function validateRegistration(
  registration: InventoryReconciliationRegistrationV1,
): void {
  const ids = registration.aggregateParameterIds;
  const declared = [
    registration.aggregateQueryId,
    ids.atTime,
    ids.itemId,
    ids.legalEntityId,
    ids.locationId,
    ids.recordedAtHorizon,
  ];
  if (declared.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      'reconciliation requires the declaring package aggregate identities',
    );
  }
  if (new Set(declared).size !== declared.length) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      'reconciliation aggregate identities must be distinct',
    );
  }
  if (
    registration.storageTarget.providerAbi.managedSchema !==
      'north_star_module' ||
    registration.storageTarget.providerAbi.runtimeRole !==
      'north_star_module_runtime'
  ) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      'reconciliation requires the admitted managed storage ABI',
    );
  }
}

type StorageEntityTarget = StorageTargetPayloadV1['entities'][number];

function resolveReconciliationStorage(
  target: StorageTargetPayloadV1,
): ReconciliationStorageBinding {
  const entity = (suffix: string): StorageEntityTarget => {
    const matches = target.entities.filter((candidate) =>
      candidate.entityId.endsWith(`:entity.${suffix}`),
    );
    if (matches.length !== 1) {
      throw new InventoryReconciliationError(
        'INVENTORY_RECONCILIATION_STORAGE_INVALID',
        `storage target must contain exactly one ${suffix} entity`,
      );
    }
    return matches[0]!;
  };
  const movementEntity = entity('inventory_movement');
  const transactionEntity = entity('inventory_transaction');
  const transactionLineEntity = entity('inventory_transaction_line');
  if (
    !movementEntity.factStorage ||
    movementEntity.factStorage.mutability !== 'appendOnly'
  ) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      'storage target lacks the frozen append-only movement contract',
    );
  }
  assertMovementColumnsClassified(movementEntity);
  const movement = bindEntity(movementEntity);
  const transaction = bindEntity(transactionEntity);
  const transactionLine = bindEntity(transactionLineEntity);
  const movementPostingRole = enumOptions(
    movementEntity,
    'inventory_movement_posting_role',
  );
  const transactionState = enumOptions(
    transactionEntity,
    'inventory_transaction_state',
  );
  const transactionType = enumOptions(
    transactionEntity,
    'inventory_transaction_type',
  );
  return Object.freeze({
    movement,
    movementPostingRoleAdjustment: uniqueEnumOption(
      movementPostingRole,
      'adjustment',
    ),
    movementPostingRoleCorrection: uniqueEnumOption(
      movementPostingRole,
      'correction',
    ),
    movementPostingRoleCount: uniqueEnumOption(movementPostingRole, 'count'),
    movementPostingRoleTransfer: uniqueEnumOption(
      movementPostingRole,
      'transfer',
    ),
    movementQuantityColumn: requiredColumn(
      movement,
      'inventory_movement_quantity_delta',
    ),
    movementRelationToLineColumn: requiredRelationColumn(
      target,
      movementEntity,
      'inventory_transaction_line',
    ),
    movementRelationToTransactionColumn: requiredRelationColumn(
      target,
      movementEntity,
      'inventory_transaction',
    ),
    schemaName: target.providerAbi.managedSchema,
    transaction,
    transactionAdjustmentType: uniqueEnumOption(transactionType, 'adjustment'),
    transactionCountCorrectionType: uniqueEnumOption(
      transactionType,
      'count_correction',
    ),
    transactionEffectiveAtColumn: requiredColumn(
      transaction,
      'inventory_transaction_effective_at',
    ),
    transactionLine,
    transactionLineFromLocationColumn: requiredColumn(
      transactionLine,
      'inventory_transaction_line_from_location_id',
    ),
    transactionLineItemColumn: requiredColumn(
      transactionLine,
      'inventory_transaction_line_item_id',
    ),
    transactionLineNumberColumn: requiredColumn(
      transactionLine,
      'inventory_transaction_line_line_number',
    ),
    transactionLineQuantityColumn: requiredColumn(
      transactionLine,
      'inventory_transaction_line_quantity',
    ),
    transactionLineRelationToTransactionColumn: requiredRelationColumn(
      target,
      transactionLineEntity,
      'inventory_transaction',
    ),
    transactionLineToLocationColumn: requiredColumn(
      transactionLine,
      'inventory_transaction_line_to_location_id',
    ),
    transactionLineUnitColumn: requiredColumn(
      transactionLine,
      'inventory_transaction_line_unit_id',
    ),
    transactionPostedState: uniqueEnumOption(transactionState, 'posted'),
    transactionReasonCodeColumn: requiredColumn(
      transaction,
      'inventory_transaction_reason_code',
    ),
    transactionReasonNarrativeColumn: requiredColumn(
      transaction,
      'inventory_transaction_reason_narrative',
    ),
    transactionSourceIdColumn: requiredColumn(
      transaction,
      'inventory_transaction_source_id',
    ),
    transactionSourceTypeColumn: requiredColumn(
      transaction,
      'inventory_transaction_source_type',
    ),
    transactionStateColumn: requiredColumn(
      transaction,
      'inventory_transaction_state',
    ),
    transactionTransferType: uniqueEnumOption(transactionType, 'transfer'),
    transactionTypeColumn: requiredColumn(
      transaction,
      'inventory_transaction_type',
    ),
  });
}

/**
 * The completeness ratchet. Reads the produced artifact -- the compiled column
 * list -- rather than parsing source, so it observes rather than proxies
 * (AGENTS.md section 6).
 */
function assertMovementColumnsClassified(entity: StorageEntityTarget): void {
  const columns = entity.columns
    .map((column) => column.canonicalFieldId.split(':field.').at(-1))
    .filter((local): local is string => local !== undefined)
    .toSorted();
  const classified = Object.keys(MOVEMENT_COLUMN_CLASSIFICATION).toSorted();
  const unclassified = columns.filter(
    (local) => !Object.hasOwn(MOVEMENT_COLUMN_CLASSIFICATION, local),
  );
  if (unclassified.length > 0) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      `movement columns are unclassified: ${unclassified.join(', ')}`,
    );
  }
  const absent = classified.filter((local) => !columns.includes(local));
  if (absent.length > 0) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      `classified movement columns no longer exist: ${absent.join(', ')}`,
    );
  }
}

function bindEntity(entity: StorageEntityTarget): EntityBinding {
  if (!entity.legalEntity) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      `entity ${entity.entityId} is not legal-entity scoped`,
    );
  }
  const columns = new Map<string, string>();
  for (const column of entity.columns) {
    const local = column.canonicalFieldId.split(':field.').at(-1);
    if (!local || columns.has(local)) {
      throw new InventoryReconciliationError(
        'INVENTORY_RECONCILIATION_STORAGE_INVALID',
        `entity ${entity.entityId} contains ambiguous field metadata`,
      );
    }
    columns.set(local, safeIdentifier(column.physicalName));
  }
  return Object.freeze({
    archiveColumn: safeIdentifier(entity.archive.archivedAtColumn),
    columns,
    legalEntityColumn: safeIdentifier(entity.legalEntity.column),
    recordIdColumn: safeIdentifier(entity.recordIdentity.column),
    tableName: safeIdentifier(entity.physicalTableName),
  });
}

function requiredColumn(entity: EntityBinding, localId: string): string {
  const column = entity.columns.get(localId);
  if (!column) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      `storage target lacks field ${localId}`,
    );
  }
  return column;
}

function enumOptions(
  entity: StorageEntityTarget,
  localId: string,
): readonly string[] {
  const column = entity.columns.find(
    (candidate) =>
      candidate.canonicalFieldId.split(':field.').at(-1) === localId,
  );
  if (!column) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      `storage target lacks field ${localId}`,
    );
  }
  return column.fieldContract.enumOptionIds;
}

function uniqueEnumOption(
  optionIds: readonly string[],
  suffix: string,
): string {
  const matches = optionIds.filter((option) => option.endsWith(`_${suffix}`));
  if (matches.length !== 1) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      `storage target lacks unique enum option ${suffix}`,
    );
  }
  return matches[0]!;
}

function requiredRelationColumn(
  target: StorageTargetPayloadV1,
  source: StorageEntityTarget,
  targetSuffix: string,
): string {
  const relations = target.relations.filter(
    (relation) =>
      relation.sourceEntityId === source.entityId &&
      relation.targetEntityId.endsWith(`:entity.${targetSuffix}`) &&
      relation.relationColumn.origin !== 'field',
  );
  if (relations.length !== 1) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      `${source.entityId} lacks unique relation to ${targetSuffix}`,
    );
  }
  return safeIdentifier(relations[0]!.relationColumn.physicalName);
}

function safeIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(identifier)) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      `storage identifier ${identifier} is not a safe lowercase identifier`,
    );
  }
  return identifier;
}

function table(
  binding: ReconciliationStorageBinding,
  entity: EntityBinding,
): string {
  return `${quoted(binding.schemaName)}.${quoted(entity.tableName)}`;
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Returns `null` rather than throwing, and rather than coercing, for anything
 * outside `numeric(38,18)`. The declared column bound is 38 significant digits;
 * an unbounded sum of two maximal movements exceeds it, and the compiled query
 * would raise on the same value. Silently comparing such a value would let a
 * corrupt anchor reconcile as consistent, so the caller reports it unverifiable.
 */
function parseStoredDecimal(value: string): bigint | null {
  if (!storedDecimalPattern.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  if (fraction.length > 18) return null;
  const scaled =
    BigInt(whole) * scaleFactor + BigInt(fraction.padEnd(18, '0') || '0');
  // The bound is on the SCALED magnitude, not on the digits written. A
  // twenty-one digit integer carries no fraction yet still needs thirty-nine
  // digits once scaled, so a "total digits" test would admit a value the column
  // cannot hold.
  if (scaled >= maximumScaledMagnitude) return null;
  return negative ? -scaled : scaled;
}

/** The canonical form when the value is in contract, the raw text when not. */
function renderedStoredDecimal(value: string): string {
  const scaled = parseStoredDecimal(value);
  return scaled === null ? value : scaledToDecimal(scaled);
}

function scaledToDecimal(value: bigint): string {
  const negative = value < 0n;
  const absoluteValue = negative ? -value : value;
  const whole = absoluteValue / scaleFactor;
  const fraction = String(absoluteValue % scaleFactor)
    .padStart(18, '0')
    .replace(/0+$/u, '');
  const rendered =
    fraction.length === 0 ? String(whole) : `${String(whole)}.${fraction}`;
  return negative && absoluteValue !== 0n ? `-${rendered}` : rendered;
}
