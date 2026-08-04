import type { StorageTargetPayloadV1 } from '@north-star/compiler';
import {
  assertTrustedRequestContext,
  type TrustedRequestContext,
} from '@north-star/runtime';
import type { Pool, PoolClient } from 'pg';

import { withModuleRuntimeRole } from './module-runtime-interpreter.js';
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

export type InventoryReconciliationFindingCodeV1 =
  | 'AGGREGATE_ANCHOR_LEDGER_DIVERGED'
  | 'AGGREGATE_ANCHOR_PARAMETERS_UNRECOGNIZED'
  | 'AGGREGATE_ANCHOR_QUERY_UNRECOGNIZED'
  | 'RECORDED_ANCHOR_DISCREPANCY_PRESERVED'
  | 'SCOPE_OBSERVED_NO_SUBJECTS'
  | 'SOURCE_DOCUMENT_ITEM_DIVERGED'
  | 'SOURCE_DOCUMENT_LINE_SHAPE_UNRECOGNIZED'
  | 'SOURCE_DOCUMENT_MISSING_FOR_MOVEMENT'
  | 'SOURCE_DOCUMENT_MOVEMENT_COUNT_DIVERGED'
  | 'SOURCE_DOCUMENT_QUANTITY_DIVERGED'
  | 'SOURCE_DOCUMENT_SOURCE_IDENTITY_DIVERGED'
  | 'SOURCE_DOCUMENT_TYPE_UNRECOGNIZED'
  | 'SOURCE_DOCUMENT_UNIT_DIVERGED';

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

export interface InventoryReconciliationArmReportV1 {
  readonly armId: InventoryReconciliationArmIdV1;
  readonly consistentSubjectIds: readonly string[];
  readonly discrepantSubjectIds: readonly string[];
  readonly excludedSubjectCount: number;
  readonly findings: readonly InventoryReconciliationFindingV1[];
  readonly outcome: InventoryReconciliationOutcomeV1;
  readonly subjectCount: number;
  readonly unverifiableSubjectIds: readonly string[];
}

export interface InventoryReconciliationReportV1 {
  readonly arms: readonly InventoryReconciliationArmReportV1[];
  readonly environmentId: string;
  readonly findings: readonly InventoryReconciliationFindingV1[];
  readonly legalEntityIds: readonly string[];
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
  readonly movementQuantityColumn: string;
  readonly movementRelationToLineColumn: string;
  readonly schemaName: string;
  readonly transaction: EntityBinding;
  readonly transactionAdjustmentType: string;
  readonly transactionCountCorrectionType: string;
  readonly transactionLine: EntityBinding;
  readonly transactionLineFromLocationColumn: string;
  readonly transactionLineItemColumn: string;
  readonly transactionLineNumberColumn: string;
  readonly transactionLineQuantityColumn: string;
  readonly transactionLineRelationToTransactionColumn: string;
  readonly transactionLineToLocationColumn: string;
  readonly transactionLineUnitColumn: string;
  readonly transactionPostedState: string;
  readonly transactionSourceIdColumn: string;
  readonly transactionSourceTypeColumn: string;
  readonly transactionStateColumn: string;
  readonly transactionTransferType: string;
  readonly transactionTypeColumn: string;
}

interface SourceDocumentLineRow {
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
  readonly itemId: string;
  readonly locationId: string;
  readonly movementId: string;
  readonly quantityDelta: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly transactionLineId: string | null;
  readonly unitId: string;
}

interface AnchorRow {
  readonly balanceValue: string;
  readonly cacheKey: string;
  readonly legalEntityIds: string[];
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
        const report: InventoryReconciliationReportV1 = Object.freeze({
          arms: Object.freeze(arms),
          environmentId: context.environmentId,
          findings: Object.freeze(findings),
          legalEntityIds: Object.freeze(legalEntityIds),
          outcome: combinedOutcome(arms.map((arm) => arm.outcome)),
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
    const lines = await selectPostedSourceDocumentLines(
      client,
      binding,
      context,
      legalEntityIds,
    );
    const movements = await selectLinkedMovements(
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
        observedValue: canonicalDecimal(movement.quantityDelta),
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
    const declaredQuantity = canonicalDecimal(line.quantity);
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
          decimalToScaled(movement.quantityDelta),
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
      const declared = expected.byLocation.get(locationId) ?? 0n;
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
      if (!anchor.legalEntityIds.every((id) => legalEntityIds.includes(id))) {
        arm.excluded();
        continue;
      }
      if (anchor.movementGeneration !== generation) {
        // A superseded anchor cannot be served: the cache key and the identity
        // comparison both carry the generation, which only advances. It is
        // counted and named as excluded, never silently dropped.
        arm.excluded();
        continue;
      }
      await this.#reconcileOneAnchor(client, context, arm, anchor);
    }
    return arm.freeze();
  }

  async #reconcileOneAnchor(
    client: PoolClient,
    context: TrustedRequestContext,
    arm: ArmAccumulator,
    anchor: AnchorRow,
  ): Promise<void> {
    const subjectId = anchor.cacheKey;
    if (anchor.queryId !== this.registration.aggregateQueryId) {
      arm.unverifiable(subjectId, {
        code: 'AGGREGATE_ANCHOR_QUERY_UNRECOGNIZED',
        declaredValue: canonicalDecimal(anchor.balanceValue),
        detail: { cacheKey: subjectId, queryId: anchor.queryId },
        observedValue: null,
      });
      return;
    }
    const parameters = recognizedAnchorParameters(
      this.registration,
      anchor.parameterValues,
    );
    if (!parameters) {
      arm.unverifiable(subjectId, {
        code: 'AGGREGATE_ANCHOR_PARAMETERS_UNRECOGNIZED',
        declaredValue: canonicalDecimal(anchor.balanceValue),
        detail: { cacheKey: subjectId, queryId: anchor.queryId },
        observedValue: null,
      });
      return;
    }
    const declared = canonicalDecimal(anchor.balanceValue);
    const observed = await sumMovementLedger(
      client,
      this.#binding,
      context,
      anchor.legalEntityIds,
      parameters,
    );
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
          legalEntityIds: anchor.legalEntityIds.join(','),
          locationId: parameters.locationId,
          queryId: anchor.queryId,
          recordedAtHorizon: parameters.recordedAtHorizon,
        },
        observedValue: observed,
        subjectId,
      });
    }
    if (anchor.recordedDiscrepancyCount !== '0') {
      // R1-c: the read path already persists these and nothing has ever shown
      // them to anybody. Surfacing them is the whole point of reading here.
      divergent = true;
      arm.finding({
        code: 'RECORDED_ANCHOR_DISCREPANCY_PRESERVED',
        declaredValue: declared,
        detail: {
          cacheKey: subjectId,
          queryId: anchor.queryId,
          recordedDiscrepancyCount: anchor.recordedDiscrepancyCount,
        },
        observedValue: observed,
        subjectId,
      });
    }
    if (divergent) arm.markDiscrepant(subjectId);
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
    `  subjects=${String(report.subjectCount)} findings=${String(report.findings.length)} repaired=${String(report.repairedSubjectCount)} transactionReadOnly=${report.transactionReadOnly}`,
  ];
  for (const arm of report.arms) {
    lines.push(
      `  arm ${arm.armId}: ${arm.outcome.toUpperCase()} — ${String(arm.subjectCount)} subject(s), ${String(arm.consistentSubjectIds.length)} consistent, ${String(arm.discrepantSubjectIds.length)} discrepant, ${String(arm.unverifiableSubjectIds.length)} unverifiable, ${String(arm.excludedSubjectCount)} excluded`,
    );
    for (const subjectId of arm.consistentSubjectIds) {
      lines.push(`    consistent ${subjectId}`);
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
  #excluded = 0;

  constructor(private readonly armId: InventoryReconciliationArmIdV1) {}

  consistent(subjectId: string): void {
    this.#consistent.push(subjectId);
  }

  excluded(): void {
    this.#excluded += 1;
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
      excludedSubjectCount: this.#excluded,
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
      unverifiableSubjectIds: Object.freeze(this.#unverifiable.toSorted()),
    });
  }
}

function combinedOutcome(
  outcomes: readonly InventoryReconciliationOutcomeV1[],
): InventoryReconciliationOutcomeV1 {
  if (outcomes.includes('discrepant')) return 'discrepant';
  if (outcomes.includes('indeterminate')) return 'indeterminate';
  if (outcomes.length === 0) return 'indeterminate';
  return 'consistent';
}

interface ExpectedLineEffects {
  readonly byLocation: ReadonlyMap<string, bigint>;
  readonly movementCount: number;
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
  const quantity = decimalToScaled(line.quantity);
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
        [line.fromLocationId, -quantity],
        [line.toLocationId, quantity],
      ]),
      movementCount: 2,
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
    byLocation: new Map([[declaredLocations[0]!, quantity]]),
    movementCount: 1,
  };
}

interface RecognizedAnchorParameters {
  readonly atTime: string;
  readonly itemId: string;
  readonly locationId: string;
  readonly recordedAtHorizon: string;
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
  const locationId = parameterValues[ids.locationId];
  const atTime = parameterValues[ids.atTime];
  const recordedAtHorizon = parameterValues[ids.recordedAtHorizon];
  if (
    typeof itemId !== 'string' ||
    typeof locationId !== 'string' ||
    typeof atTime !== 'string' ||
    typeof recordedAtHorizon !== 'string' ||
    !uuidPattern.test(itemId) ||
    !uuidPattern.test(locationId) ||
    !instantPattern.test(atTime) ||
    !instantPattern.test(recordedAtHorizon)
  ) {
    return null;
  }
  return Object.freeze({ atTime, itemId, locationId, recordedAtHorizon });
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

async function selectAnchors(
  client: PoolClient,
  context: TrustedRequestContext,
): Promise<AnchorRow[]> {
  const result = await client.query<AnchorRow>(
    `SELECT anchor.cache_key AS "cacheKey",
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
  return result.rows;
}

async function sumMovementLedger(
  client: PoolClient,
  binding: ReconciliationStorageBinding,
  context: TrustedRequestContext,
  legalEntityIds: readonly string[],
  parameters: RecognizedAnchorParameters,
): Promise<string> {
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
  return canonicalDecimal(result.rows[0]?.balance ?? '0');
}

async function selectPostedSourceDocumentLines(
  client: PoolClient,
  binding: ReconciliationStorageBinding,
  context: TrustedRequestContext,
  legalEntityIds: readonly string[],
): Promise<SourceDocumentLineRow[]> {
  const line = binding.transactionLine;
  const header = binding.transaction;
  const result = await client.query<SourceDocumentLineRow>(
    `SELECT line.${quoted(line.recordIdColumn)}::text AS "transactionLineId",
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
            line.${quoted(binding.transactionLineUnitColumn)} AS "unitId",
            header.${quoted(binding.transactionTypeColumn)} AS "transactionType",
            header.${quoted(binding.transactionSourceTypeColumn)}
              AS "transactionSourceType",
            header.${quoted(binding.transactionSourceIdColumn)}
              AS "transactionSourceId"
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
      ORDER BY line.${quoted(line.recordIdColumn)}`,
    [
      context.tenantId,
      context.environmentId,
      [...legalEntityIds],
      binding.transactionPostedState,
    ],
  );
  return result.rows;
}

async function selectLinkedMovements(
  client: PoolClient,
  binding: ReconciliationStorageBinding,
  context: TrustedRequestContext,
  legalEntityIds: readonly string[],
): Promise<LedgerMovementRow[]> {
  const movement = binding.movement;
  const result = await client.query<LedgerMovementRow>(
    `SELECT ${quoted(movement.recordIdColumn)}::text AS "movementId",
            ${quoted(binding.movementRelationToLineColumn)}::text
              AS "transactionLineId",
            ${quoted(requiredColumn(movement, 'inventory_movement_item_id'))}::text
              AS "itemId",
            ${quoted(requiredColumn(movement, 'inventory_movement_location_id'))}::text
              AS "locationId",
            ${quoted(binding.movementQuantityColumn)}::text AS "quantityDelta",
            ${quoted(requiredColumn(movement, 'inventory_movement_unit_id'))}
              AS "unitId",
            ${quoted(requiredColumn(movement, 'inventory_movement_source_type'))}
              AS "sourceType",
            ${quoted(requiredColumn(movement, 'inventory_movement_source_id'))}
              AS "sourceId"
       FROM ${table(binding, movement)}
      WHERE tenant_id = $1 AND environment_id = $2
        AND ${quoted(movement.legalEntityColumn)} = ANY($3::uuid[])
        AND ${quoted(movement.archiveColumn)} IS NULL
      ORDER BY ${quoted(movement.recordIdColumn)}`,
    [context.tenantId, context.environmentId, [...legalEntityIds]],
  );
  return result.rows;
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
  const movement = bindEntity(movementEntity);
  const transaction = bindEntity(transactionEntity);
  const transactionLine = bindEntity(transactionLineEntity);
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
    movementQuantityColumn: requiredColumn(
      movement,
      'inventory_movement_quantity_delta',
    ),
    movementRelationToLineColumn: requiredRelationColumn(
      target,
      movementEntity,
      'inventory_transaction_line',
    ),
    schemaName: target.providerAbi.managedSchema,
    transaction,
    transactionAdjustmentType: uniqueEnumOption(transactionType, 'adjustment'),
    transactionCountCorrectionType: uniqueEnumOption(
      transactionType,
      'count_correction',
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

function decimalToScaled(value: string): bigint {
  if (!storedDecimalPattern.test(value)) {
    throw new InventoryReconciliationError(
      'INVENTORY_RECONCILIATION_STORAGE_INVALID',
      `stored quantity ${value} is not numeric(38,18)`,
    );
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const scaled =
    BigInt(whole) * scaleFactor + BigInt(fraction.padEnd(18, '0') || '0');
  return negative ? -scaled : scaled;
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

function canonicalDecimal(value: string): string {
  return scaledToDecimal(decimalToScaled(value));
}
