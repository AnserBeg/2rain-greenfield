import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import ts from 'typescript';

export const LANGUAGE_COVERAGE_LEDGER_VERSION =
  'northstar.language-coverage-ledger/v1' as const;
export const LANGUAGE_COVERAGE_RECEIPT_VERSION =
  'northstar.language-coverage-receipt/v1' as const;

export type ClosedValue = boolean | number | string | null;
export type LanguageSpecification = 'authoredLanguage' | 'loweredStorage';

export interface LanguageCoverageAxis {
  readonly axis: string;
  readonly specification: LanguageSpecification;
  readonly values: readonly ClosedValue[];
}

export interface LanguageCoverageObligation {
  readonly axis: string;
  readonly id: string;
  readonly specification: LanguageSpecification;
  readonly value: ClosedValue;
}

export interface LanguageCoverageLedger {
  readonly axes: readonly LanguageCoverageAxis[];
  readonly digest: string;
  readonly obligations: readonly LanguageCoverageObligation[];
  readonly roots: Readonly<{
    authoredLanguage: Readonly<{
      exportName: 'VersionedAuthoredApplicationPackage';
      sourcePath: 'packages/canonical-model/src/schemas.ts';
    }>;
    loweredStorage: Readonly<{
      exportName: 'StorageTargetPayloadV1';
      sourcePath: 'packages/compiler/src/storage.ts';
    }>;
  }>;
  readonly version: typeof LANGUAGE_COVERAGE_LEDGER_VERSION;
}

export type LanguageCoverageOutcome = 'executed' | 'typedRefusal' | 'unhonored';

export interface LanguageCoverageReceiptBody {
  readonly obligationId: string;
  readonly observedFact: Readonly<Record<string, unknown>>;
  readonly outcome: LanguageCoverageOutcome;
  readonly producer: Readonly<{
    suiteId: string;
    testFile: string;
  }>;
  readonly receiptId: string;
  readonly refusalDiagnostic?: string;
  readonly runId: string;
  readonly version: typeof LANGUAGE_COVERAGE_RECEIPT_VERSION;
  readonly witnessId: string;
}

export interface LanguageCoverageReceipt extends LanguageCoverageReceiptBody {
  readonly integrityDigest: string;
}

export interface LanguageCoverageReceiptClaim {
  readonly expectedOutcome: LanguageCoverageOutcome;
  readonly obligationId: string;
  readonly receiptId: string;
}

export type LanguageCoverageDecisionCategory =
  'observedRelationScope' | 'observedOutsideRelationScope' | 'unobserved';

export interface LanguageCoverageDecision {
  readonly acceptedButUnhonoredSetDigest: string;
  readonly category: LanguageCoverageDecisionCategory;
  readonly decisionId: string;
  readonly ledgerDigest: string;
  readonly obligationSetDigest: string;
  readonly rationale: string;
  readonly revisitCondition: string;
}

export type LanguageCoverageDecisionBody = Omit<
  LanguageCoverageDecision,
  'decisionId'
>;

export interface EvaluateLanguageCoverageInput {
  readonly acceptedButUnhonoredObligationIds: ReadonlySet<string>;
  readonly creditedProducerFiles: ReadonlySet<string>;
  readonly decisionObservedObligationIds: ReadonlySet<string>;
  readonly decisions: readonly LanguageCoverageDecision[];
  readonly ledger: LanguageCoverageLedger;
  readonly observedObligationIds: ReadonlySet<string>;
  readonly receiptClaims: readonly LanguageCoverageReceiptClaim[];
  readonly receipts: readonly LanguageCoverageReceipt[];
  readonly runId: string;
}

export interface LanguageCoverageResult {
  readonly acceptedButUnhonoredCount: number;
  readonly decisionCount: number;
  readonly obligationCount: number;
  readonly receiptCount: number;
  readonly relationObligationCount: number;
  readonly supportedAndExercisedCount: number;
  readonly supportedButUnexercisedCount: number;
}

export interface LanguageCoverageObservationSnapshot {
  readonly bitmapEncoding: 'sorted-obligation-bitset-msb0-hex/v1';
  readonly ledgerDigest: string;
  readonly obligationCount: number;
  readonly observedBitmap: string;
  readonly observedCount: number;
}

interface MutableAxis {
  readonly forced: boolean;
  readonly values: Set<ClosedValue>;
}

const authoredLanguageRoot = {
  exportName: 'VersionedAuthoredApplicationPackage',
  sourcePath: 'packages/canonical-model/src/schemas.ts',
} as const;
const loweredStorageRoot = {
  exportName: 'StorageTargetPayloadV1',
  sourcePath: 'packages/compiler/src/storage.ts',
} as const;

const relationTopologyValues = [
  'chain',
  'directedCycle',
  'disconnectedComponents',
  'distinctEdge',
  'equalDepthDiamond',
  'fanIn',
  'fanOut',
  'noEdge',
  'parallelEdges',
  'selfEdge',
] as const;

const relationLineageLengths = [1, 2, 80] as const;

export function deriveLanguageCoverageLedger(
  repositoryRoot = resolve('.'),
): LanguageCoverageLedger {
  const configurationPath = resolve(repositoryRoot, 'tsconfig.json');
  const configuration = ts.readConfigFile(configurationPath, ts.sys.readFile);
  if (configuration.error) {
    throw new Error(formatDiagnostic(configuration.error));
  }
  const parsed = ts.parseJsonConfigFileContent(
    configuration.config,
    ts.sys,
    repositoryRoot,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(formatDiagnostic).join('\n'));
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const authoredAxes = deriveClosedAxes(
    checker,
    exportedType(program, checker, repositoryRoot, authoredLanguageRoot),
    'authoredLanguage',
    false,
  );
  const loweredAxes = deriveClosedAxes(
    checker,
    exportedType(program, checker, repositoryRoot, loweredStorageRoot),
    'loweredStorage',
    true,
  );
  if (authoredAxes.length === 0) {
    throw new Error('LANGUAGE_COVERAGE_AUTHORED_LEDGER_SUBJECT_EMPTY');
  }
  if (loweredAxes.length === 0) {
    throw new Error('LANGUAGE_COVERAGE_LOWERED_LEDGER_SUBJECT_EMPTY');
  }
  const axes = [
    ...authoredAxes,
    {
      axis: '$relationGraph.topology',
      specification: 'authoredLanguage' as const,
      values: relationTopologyValues,
    },
    {
      axis: '$relationGraph.lineageLength',
      specification: 'authoredLanguage' as const,
      values: relationLineageLengths,
    },
    ...loweredAxes,
  ].sort(compareAxis);
  const obligations = axes
    .flatMap((axis) =>
      axis.values.map((value) => ({
        axis: axis.axis,
        id: obligationId(axis.specification, axis.axis, value),
        specification: axis.specification,
        value,
      })),
    )
    .sort((left, right) => compareCodePoints(left.id, right.id));
  const body = {
    axes,
    obligations,
    roots: {
      authoredLanguage: authoredLanguageRoot,
      loweredStorage: loweredStorageRoot,
    },
    version: LANGUAGE_COVERAGE_LEDGER_VERSION,
  };
  return { ...body, digest: sha256(stableStringify(body)) };
}

export function observeLanguageCoverage(
  ledger: LanguageCoverageLedger,
  input: Readonly<{
    applicationPackages: readonly unknown[];
    storageTargets: readonly unknown[];
  }>,
): ReadonlySet<string> {
  if (input.applicationPackages.length === 0) {
    throw new Error('LANGUAGE_COVERAGE_AUTHORED_OBSERVATION_SUBJECT_EMPTY');
  }
  if (input.storageTargets.length === 0) {
    throw new Error('LANGUAGE_COVERAGE_LOWERED_OBSERVATION_SUBJECT_EMPTY');
  }
  const observed = new Set<string>();
  for (const obligation of ledger.obligations) {
    const roots =
      obligation.specification === 'authoredLanguage'
        ? input.applicationPackages
        : input.storageTargets;
    if (obligation.axis === '$relationGraph.topology') {
      if (
        roots.some((root) =>
          observedRelationTopologies(root).has(String(obligation.value)),
        )
      ) {
        observed.add(obligation.id);
      }
      continue;
    }
    if (obligation.axis === '$relationGraph.lineageLength') continue;
    if (
      roots.some((root) =>
        readValuesAtAxis(root, obligation.axis).some((value) =>
          Object.is(value, obligation.value),
        ),
      )
    ) {
      observed.add(obligation.id);
    }
  }
  if (observed.size === 0) {
    throw new Error('LANGUAGE_COVERAGE_CURRENT_OBSERVATION_EMPTY');
  }
  return observed;
}

export function makeLanguageCoverageReceipt(
  body: LanguageCoverageReceiptBody,
): LanguageCoverageReceipt {
  assertReceiptBody(body);
  return Object.freeze({
    ...body,
    integrityDigest: sha256(stableStringify(body)),
  });
}

export function deriveLanguageCoverageDecisionId(
  decisionName: string,
  body: LanguageCoverageDecisionBody,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(decisionName)) {
    throw new Error(`LANGUAGE_COVERAGE_DECISION_NAME_INVALID: ${decisionName}`);
  }
  return `${decisionName}@${sha256(stableStringify(body))}`;
}

export function evaluateLanguageCoverage(
  input: EvaluateLanguageCoverageInput,
): LanguageCoverageResult {
  const obligations = new Map(
    input.ledger.obligations.map((obligation) => [obligation.id, obligation]),
  );
  const receiptClaims = uniqueBy(
    input.receiptClaims,
    (claim) => claim.obligationId,
    'LANGUAGE_COVERAGE_DUPLICATE_RECEIPT_CLAIM',
  );
  const receipts = uniqueBy(
    input.receipts,
    (receipt) => receipt.receiptId,
    'LANGUAGE_COVERAGE_DUPLICATE_RECEIPT',
  );

  for (const obligationId of input.acceptedButUnhonoredObligationIds) {
    const obligation = obligations.get(obligationId);
    if (!obligation) {
      throw new Error(
        `LANGUAGE_COVERAGE_PHANTOM_DEFECT_INVENTORY_ENTRY: ${obligationId}`,
      );
    }
    if (!isRelationScopeObligation(obligation)) {
      throw new Error(
        `LANGUAGE_COVERAGE_DEFECT_INVENTORY_OUTSIDE_PHASE1: ${obligationId}`,
      );
    }
  }
  const acceptedButUnhonoredSetDigest = deriveObligationSetDigest(
    input.acceptedButUnhonoredObligationIds,
  );

  for (const claim of input.receiptClaims) {
    if (!isLanguageCoverageOutcome(claim.expectedOutcome)) {
      throw new Error(
        `LANGUAGE_COVERAGE_CLAIM_OUTCOME_INVALID: ${String(claim.expectedOutcome)}`,
      );
    }
    if (!obligations.has(claim.obligationId)) {
      throw new Error(
        `LANGUAGE_COVERAGE_PHANTOM_OBLIGATION: ${claim.obligationId}`,
      );
    }
  }
  for (const receipt of input.receipts) {
    if (!obligations.has(receipt.obligationId)) {
      throw new Error(
        `LANGUAGE_COVERAGE_PHANTOM_OBLIGATION: ${receipt.obligationId}`,
      );
    }
    validateReceipt(receipt, input.runId, input.creditedProducerFiles);
  }

  const validDecisions = new Map<
    LanguageCoverageDecisionCategory,
    LanguageCoverageDecision
  >();
  const expectedDecisionSetDigests = new Map(
    (
      [
        'observedRelationScope',
        'observedOutsideRelationScope',
        'unobserved',
      ] as const
    ).map((category) => [
      category,
      deriveDecisionSetDigest(
        input.ledger,
        input.decisionObservedObligationIds,
        category,
      ),
    ]),
  );
  for (const decision of input.decisions) {
    if (decision.ledgerDigest !== input.ledger.digest) {
      throw new Error(
        `LANGUAGE_COVERAGE_STALE_DECISION: ${decision.decisionId} names ${decision.ledgerDigest}, current ledger is ${input.ledger.digest}`,
      );
    }
    if (validDecisions.has(decision.category)) {
      throw new Error(
        `LANGUAGE_COVERAGE_DUPLICATE_DECISION_CATEGORY: ${decision.category}`,
      );
    }
    if (!decision.rationale.trim() || !decision.revisitCondition.trim()) {
      throw new Error(
        `LANGUAGE_COVERAGE_EMPTY_DECISION: ${decision.decisionId}`,
      );
    }
    if (
      decision.acceptedButUnhonoredSetDigest !== acceptedButUnhonoredSetDigest
    ) {
      throw new Error(
        `LANGUAGE_COVERAGE_STALE_DEFECT_INVENTORY_SET: ${decision.decisionId} no longer binds the exact accepted-but-unhonored obligation set`,
      );
    }
    if (
      decision.obligationSetDigest !==
      expectedDecisionSetDigests.get(decision.category)
    ) {
      throw new Error(
        `LANGUAGE_COVERAGE_STALE_DECISION_SET: ${decision.decisionId} no longer names the exact ${decision.category} obligation set`,
      );
    }
    const separator = decision.decisionId.lastIndexOf('@');
    const decisionName = decision.decisionId.slice(0, separator);
    const decisionBody: LanguageCoverageDecisionBody = {
      acceptedButUnhonoredSetDigest: decision.acceptedButUnhonoredSetDigest,
      category: decision.category,
      ledgerDigest: decision.ledgerDigest,
      obligationSetDigest: decision.obligationSetDigest,
      rationale: decision.rationale,
      revisitCondition: decision.revisitCondition,
    };
    if (
      separator < 1 ||
      decision.decisionId !==
        deriveLanguageCoverageDecisionId(decisionName, decisionBody)
    ) {
      throw new Error(
        `LANGUAGE_COVERAGE_STALE_DECISION_IDENTITY: ${decision.decisionId} must change when its exact decision record changes`,
      );
    }
    validDecisions.set(decision.category, decision);
  }

  let decisionCount = 0;
  let receiptCount = 0;
  let supportedAndExercisedCount = 0;
  let supportedButUnexercisedCount = 0;
  let acceptedButUnhonoredCount = 0;
  const unclaimed: string[] = [];
  for (const obligation of input.ledger.obligations) {
    const claim = receiptClaims.get(obligation.id);
    if (claim) {
      const receipt = receipts.get(claim.receiptId);
      if (!receipt || receipt.obligationId !== obligation.id) {
        unclaimed.push(obligation.id);
        continue;
      }
      if (receipt.outcome !== claim.expectedOutcome) {
        throw new Error(
          `LANGUAGE_COVERAGE_OUTCOME_MISMATCH: ${obligation.id} expected ${claim.expectedOutcome}, receipt observed ${receipt.outcome}`,
        );
      }
      const acceptedButUnhonored = input.acceptedButUnhonoredObligationIds.has(
        obligation.id,
      );
      if (acceptedButUnhonored !== (receipt.outcome === 'unhonored')) {
        throw new Error(
          `LANGUAGE_COVERAGE_DISPOSITION_MISMATCH: ${obligation.id} is classified ${acceptedButUnhonored ? 'accepted-but-unhonored' : 'supported'} but receipt observed ${receipt.outcome}`,
        );
      }
      receiptCount += 1;
      if (isRelationScopeObligation(obligation)) {
        if (acceptedButUnhonored) acceptedButUnhonoredCount += 1;
        else supportedAndExercisedCount += 1;
      }
      continue;
    }

    if (isRelationScopeObligation(obligation)) {
      if (input.acceptedButUnhonoredObligationIds.has(obligation.id)) {
        acceptedButUnhonoredCount += 1;
      } else {
        supportedButUnexercisedCount += 1;
      }
    }

    const decisionCategoryAtSnapshot = decisionCategory(
      obligation,
      input.decisionObservedObligationIds.has(obligation.id),
    );
    const currentCategory = decisionCategory(
      obligation,
      input.observedObligationIds.has(obligation.id),
    );
    if (currentCategory !== decisionCategoryAtSnapshot) {
      throw new Error(
        `LANGUAGE_COVERAGE_OBSERVATION_CHANGED: ${obligation.id} moved from ${decisionCategoryAtSnapshot} to ${currentCategory}; add an execution/refusal receipt or record a new explicit decision`,
      );
    }
    if (!validDecisions.has(decisionCategoryAtSnapshot)) {
      unclaimed.push(obligation.id);
      continue;
    }
    decisionCount += 1;
  }
  if (unclaimed.length > 0) {
    throw new Error(
      `LANGUAGE_COVERAGE_UNCLAIMED_ENTRY: ${unclaimed.join(', ')}`,
    );
  }
  const relationObligationCount = input.ledger.obligations.filter(
    isRelationScopeObligation,
  ).length;
  if (
    supportedAndExercisedCount +
      supportedButUnexercisedCount +
      acceptedButUnhonoredCount !==
    relationObligationCount
  ) {
    throw new Error('LANGUAGE_COVERAGE_RELATION_PARTITION_INEXACT');
  }
  return {
    acceptedButUnhonoredCount,
    decisionCount,
    obligationCount: input.ledger.obligations.length,
    receiptCount,
    relationObligationCount,
    supportedAndExercisedCount,
    supportedButUnexercisedCount,
  };
}

export function decodeLanguageCoverageObservationSnapshot(
  ledger: LanguageCoverageLedger,
  value: unknown,
): ReadonlySet<string> {
  if (value === undefined || value === null) {
    throw new Error('LANGUAGE_COVERAGE_OBSERVATION_SNAPSHOT_MISSING');
  }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error('LANGUAGE_COVERAGE_OBSERVATION_SNAPSHOT_EMPTY');
  }
  const snapshot = value as Partial<LanguageCoverageObservationSnapshot>;
  if (snapshot.bitmapEncoding !== 'sorted-obligation-bitset-msb0-hex/v1') {
    throw new Error('LANGUAGE_COVERAGE_OBSERVATION_BITMAP_ENCODING_INVALID');
  }
  if (snapshot.ledgerDigest !== ledger.digest) {
    throw new Error(
      `LANGUAGE_COVERAGE_STALE_OBSERVATION_SNAPSHOT: snapshot names ${snapshot.ledgerDigest}, current ledger is ${ledger.digest}`,
    );
  }
  if (snapshot.obligationCount !== ledger.obligations.length) {
    throw new Error(
      `LANGUAGE_COVERAGE_OBSERVATION_COUNT_MISMATCH: snapshot names ${String(snapshot.obligationCount)}, ledger has ${String(ledger.obligations.length)}`,
    );
  }
  if (
    typeof snapshot.observedBitmap !== 'string' ||
    !/^(?:[0-9a-f]{2})*$/u.test(snapshot.observedBitmap)
  ) {
    throw new Error('LANGUAGE_COVERAGE_OBSERVATION_BITMAP_INVALID');
  }
  const bytes = Buffer.from(snapshot.observedBitmap, 'hex');
  if (bytes.length !== Math.ceil(ledger.obligations.length / 8)) {
    throw new Error('LANGUAGE_COVERAGE_OBSERVATION_BITMAP_LENGTH_MISMATCH');
  }
  const observed = new Set<string>();
  for (const [index, obligation] of ledger.obligations.entries()) {
    const byte = bytes[Math.floor(index / 8)]!;
    if ((byte & (1 << (7 - (index % 8)))) !== 0) {
      observed.add(obligation.id);
    }
  }
  if (
    typeof snapshot.observedCount !== 'number' ||
    observed.size !== snapshot.observedCount
  ) {
    throw new Error(
      `LANGUAGE_COVERAGE_OBSERVATION_BITMAP_COUNT_MISMATCH: snapshot names ${String(snapshot.observedCount)}, bitmap contains ${String(observed.size)}`,
    );
  }
  if (observed.size === 0) {
    throw new Error('LANGUAGE_COVERAGE_OBSERVATION_SNAPSHOT_ZERO_OBSERVATIONS');
  }
  const unusedBits = bytes.length * 8 - ledger.obligations.length;
  if (unusedBits > 0) {
    const finalByte = bytes.at(-1)!;
    const unusedMask = (1 << unusedBits) - 1;
    if ((finalByte & unusedMask) !== 0) {
      throw new Error('LANGUAGE_COVERAGE_OBSERVATION_BITMAP_PADDING_SET');
    }
  }
  return observed;
}

export function encodeLanguageCoverageObservationSnapshot(
  ledger: LanguageCoverageLedger,
  observedObligationIds: ReadonlySet<string>,
): LanguageCoverageObservationSnapshot {
  const known = new Set(ledger.obligations.map((obligation) => obligation.id));
  for (const obligationId of observedObligationIds) {
    if (!known.has(obligationId)) {
      throw new Error(`LANGUAGE_COVERAGE_PHANTOM_OBSERVATION: ${obligationId}`);
    }
  }
  const bytes = Buffer.alloc(Math.ceil(ledger.obligations.length / 8));
  for (const [index, obligation] of ledger.obligations.entries()) {
    if (observedObligationIds.has(obligation.id)) {
      bytes[Math.floor(index / 8)]! |= 1 << (7 - (index % 8));
    }
  }
  return {
    bitmapEncoding: 'sorted-obligation-bitset-msb0-hex/v1',
    ledgerDigest: ledger.digest,
    obligationCount: ledger.obligations.length,
    observedBitmap: bytes.toString('hex'),
    observedCount: observedObligationIds.size,
  };
}

export function deriveDecisionSetDigest(
  ledger: LanguageCoverageLedger,
  observedObligationIds: ReadonlySet<string>,
  category: LanguageCoverageDecisionCategory,
): string {
  return sha256(
    stableStringify(
      ledger.obligations
        .filter(
          (obligation) =>
            decisionCategory(
              obligation,
              observedObligationIds.has(obligation.id),
            ) === category,
        )
        .map((obligation) => obligation.id)
        .sort(compareCodePoints),
    ),
  );
}

export function deriveObligationSetDigest(
  obligationIds: ReadonlySet<string>,
): string {
  return sha256(stableStringify([...obligationIds].sort(compareCodePoints)));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function deriveClosedAxes(
  checker: ts.TypeChecker,
  root: ts.Type,
  specification: LanguageSpecification,
  includeSingletons: boolean,
): LanguageCoverageAxis[] {
  const candidates = new Map<string, MutableAxis>();

  function add(axis: string, value: ClosedValue, forced = false): void {
    const current = candidates.get(axis);
    if (current) {
      current.values.add(value);
      if (forced && !current.forced) {
        candidates.set(axis, { forced: true, values: current.values });
      }
      return;
    }
    candidates.set(axis, { forced, values: new Set([value]) });
  }

  function walk(
    type: ts.Type,
    axis: string,
    ancestry: ReadonlySet<ts.Type>,
  ): void {
    if (type.isUnion()) {
      const finiteMembers = type.types.map(finiteValue);
      const actualFinite = finiteMembers.filter(
        (
          entry,
        ): entry is { readonly finite: true; readonly value: ClosedValue } =>
          entry.finite,
      );
      for (const entry of actualFinite) add(axis, entry.value, true);
      for (const member of type.types) {
        if (!finiteValue(member).finite) walk(member, axis, ancestry);
      }
      return;
    }

    const finite = finiteValue(type);
    if (finite.finite) {
      add(axis, finite.value);
      return;
    }
    if (type.flags & ts.TypeFlags.Boolean) {
      add(axis, false, true);
      add(axis, true, true);
      return;
    }
    if (!(type.flags & ts.TypeFlags.Object) || ancestry.has(type)) return;
    const nextAncestry = new Set(ancestry).add(type);
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      if (element) walk(element, `${axis}[]`, nextAncestry);
      return;
    }

    for (const property of checker.getPropertiesOfType(type)) {
      const declaration =
        property.valueDeclaration ?? property.declarations?.at(0);
      if (!declaration) continue;
      const propertyAxis = `${axis}.${property.name}`;
      if (property.flags & ts.SymbolFlags.Optional) {
        add(`${propertyAxis}.$presence`, 'absent', true);
        add(`${propertyAxis}.$presence`, 'present', true);
      }
      walk(
        checker.getTypeOfSymbolAtLocation(property, declaration),
        propertyAxis,
        nextAncestry,
      );
    }
  }

  walk(root, '$', new Set());
  return [...candidates]
    .filter(([, candidate]) =>
      includeSingletons
        ? candidate.values.size > 0
        : candidate.forced || candidate.values.size > 1,
    )
    .map(([axis, candidate]) => ({
      axis,
      specification,
      values: [...candidate.values].sort(compareValue),
    }))
    .sort(compareAxis);
}

function exportedType(
  program: ts.Program,
  checker: ts.TypeChecker,
  repositoryRoot: string,
  root: Readonly<{ exportName: string; sourcePath: string }>,
): ts.Type {
  const source = program.getSourceFile(
    resolve(repositoryRoot, root.sourcePath),
  );
  if (!source) throw new Error(`Missing ledger source: ${root.sourcePath}`);
  const module = checker.getSymbolAtLocation(source);
  const symbol = module
    ? checker
        .getExportsOfModule(module)
        .find((candidate) => candidate.name === root.exportName)
    : undefined;
  if (!symbol) {
    throw new Error(
      `Missing ledger root ${root.exportName} in ${root.sourcePath}`,
    );
  }
  return checker.getDeclaredTypeOfSymbol(symbol);
}

function finiteValue(
  type: ts.Type,
):
  | { readonly finite: false }
  | { readonly finite: true; readonly value: ClosedValue } {
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return { finite: true, value: (type as ts.StringLiteralType).value };
  }
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return { finite: true, value: (type as ts.NumberLiteralType).value };
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return {
      finite: true,
      value: (type as { intrinsicName?: string }).intrinsicName === 'true',
    };
  }
  if (type.flags & ts.TypeFlags.Null) return { finite: true, value: null };
  return { finite: false };
}

function readValuesAtAxis(root: unknown, axis: string): ClosedValue[] {
  const presence = /^(.*)\.([^.[\]]+)\.\$presence$/u.exec(axis);
  if (presence) {
    return readRawValues(root, tokens(presence[1]!)).flatMap((parent) => {
      if (!isRecord(parent)) return [];
      return Object.hasOwn(parent, presence[2]!) ? ['present'] : ['absent'];
    });
  }
  return readRawValues(root, tokens(axis)).filter(isClosedValue);
}

function readRawValues(root: unknown, path: readonly string[]): unknown[] {
  let current = [root];
  for (const token of path) {
    current = current.flatMap((value) => {
      if (token === '[]') return Array.isArray(value) ? value : [];
      return isRecord(value) && Object.hasOwn(value, token)
        ? [value[token]]
        : [];
    });
  }
  return current;
}

function tokens(axis: string): string[] {
  const result: string[] = [];
  for (const match of axis.matchAll(/\.([^.[\]]+)|(\[\])/gu)) {
    result.push(match[1] ?? '[]');
  }
  return result;
}

function observedRelationTopologies(root: unknown): ReadonlySet<string> {
  if (!isRecord(root) || !Array.isArray(root.relations)) return new Set();
  const edges = root.relations.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const source = referenceTarget(candidate.sourceEntity);
    const target = referenceTarget(candidate.targetEntity);
    return source && target ? [{ source, target }] : [];
  });
  const observed = new Set<string>();
  if (edges.length === 0) observed.add('noEdge');
  if (edges.some((edge) => edge.source !== edge.target)) {
    observed.add('distinctEdge');
  }
  if (edges.some((edge) => edge.source === edge.target))
    observed.add('selfEdge');

  const pairCounts = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const edge of edges) {
    const pair = `${edge.source}\u0000${edge.target}`;
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
    mapSet(outgoing, edge.source).add(edge.target);
    mapSet(incoming, edge.target).add(edge.source);
  }
  if ([...pairCounts.values()].some((count) => count > 1)) {
    observed.add('parallelEdges');
  }
  if ([...outgoing.values()].some((targets) => targets.size > 1)) {
    observed.add('fanOut');
  }
  if ([...incoming.values()].some((sources) => sources.size > 1)) {
    observed.add('fanIn');
  }
  if (
    edges.some((left) =>
      edges.some(
        (right) => left.target === right.source && left.source !== right.target,
      ),
    )
  ) {
    observed.add('chain');
  }
  if (hasDirectedCycle(outgoing)) observed.add('directedCycle');
  if (hasEqualDepthDiamond(outgoing)) observed.add('equalDepthDiamond');
  if (hasDisconnectedComponents(edges)) observed.add('disconnectedComponents');
  return observed;
}

function hasDirectedCycle(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) {
      if (visit(target)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }
  return [...graph.keys()].some(visit);
}

function hasEqualDepthDiamond(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  for (const [root, firstSteps] of graph) {
    const reached = new Map<string, string>();
    for (const first of firstSteps) {
      for (const second of graph.get(first) ?? []) {
        const prior = reached.get(second);
        if (prior && prior !== first && second !== root) return true;
        reached.set(second, first);
      }
    }
  }
  return false;
}

function hasDisconnectedComponents(
  edges: readonly Readonly<{ source: string; target: string }>[],
): boolean {
  const nodes = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const first = nodes.values().next().value as string | undefined;
  if (!first) return false;
  const adjacent = new Map<string, Set<string>>();
  for (const edge of edges) {
    mapSet(adjacent, edge.source).add(edge.target);
    mapSet(adjacent, edge.target).add(edge.source);
  }
  const reached = new Set([first]);
  const pending = [first];
  while (pending.length > 0) {
    for (const next of adjacent.get(pending.pop()!) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        pending.push(next);
      }
    }
  }
  return reached.size !== nodes.size;
}

function validateReceipt(
  receipt: LanguageCoverageReceipt,
  runId: string,
  creditedProducerFiles: ReadonlySet<string>,
): void {
  const { integrityDigest, ...body } = receipt;
  assertReceiptBody(body);
  if (integrityDigest !== sha256(stableStringify(body))) {
    throw new Error(`LANGUAGE_COVERAGE_RECEIPT_TAMPERED: ${receipt.receiptId}`);
  }
  if (receipt.runId !== runId) {
    throw new Error(
      `LANGUAGE_COVERAGE_RECEIPT_WRONG_RUN: ${receipt.receiptId}`,
    );
  }
  if (
    !creditedProducerFiles.has(
      languageCoverageProducerFileKey(receipt.producer),
    )
  ) {
    throw new Error(
      `LANGUAGE_COVERAGE_RECEIPT_UNCREDITED_PRODUCER: ${receipt.producer.suiteId}:${receipt.producer.testFile}`,
    );
  }
}

export function languageCoverageProducerFileKey(
  producer: Readonly<{ readonly suiteId: string; readonly testFile: string }>,
): string {
  return stableStringify([producer.suiteId, producer.testFile]);
}

function assertReceiptBody(body: LanguageCoverageReceiptBody): void {
  if (
    !body.obligationId ||
    !body.receiptId ||
    !body.runId ||
    !body.witnessId ||
    !body.producer.suiteId ||
    !body.producer.testFile
  ) {
    throw new Error('LANGUAGE_COVERAGE_RECEIPT_INCOMPLETE');
  }
  if (body.version !== LANGUAGE_COVERAGE_RECEIPT_VERSION) {
    throw new Error(
      `LANGUAGE_COVERAGE_RECEIPT_VERSION_INVALID: ${String(body.version)}`,
    );
  }
  if (
    !isRecord(body.observedFact) ||
    Object.keys(body.observedFact).length === 0
  ) {
    throw new Error(
      `LANGUAGE_COVERAGE_RECEIPT_OBSERVED_FACT_EMPTY: ${body.receiptId}`,
    );
  }
  if (!isLanguageCoverageOutcome(body.outcome)) {
    throw new Error(
      `LANGUAGE_COVERAGE_RECEIPT_OUTCOME_INVALID: ${String(body.outcome)}`,
    );
  }
  if (body.outcome === 'executed') {
    assertExecutedObservedFact(body.receiptId, body.observedFact);
  }
  if (
    body.outcome === 'typedRefusal' &&
    (typeof body.refusalDiagnostic !== 'string' ||
      body.refusalDiagnostic.trim().length === 0)
  ) {
    throw new Error(
      `LANGUAGE_COVERAGE_REFUSAL_WITHOUT_DIAGNOSTIC: ${body.receiptId}`,
    );
  }
  if (
    body.outcome === 'typedRefusal' &&
    (body.observedFact.kind !== 'typedRefusal' ||
      typeof body.observedFact.diagnostic !== 'string' ||
      body.observedFact.diagnostic.trim().length === 0 ||
      body.observedFact.diagnostic !== body.refusalDiagnostic)
  ) {
    throw new Error(
      `LANGUAGE_COVERAGE_REFUSAL_FACT_MISMATCH: ${body.receiptId}`,
    );
  }
  if (body.outcome === 'executed' && body.refusalDiagnostic !== undefined) {
    throw new Error(
      `LANGUAGE_COVERAGE_EXECUTION_WITH_REFUSAL: ${body.receiptId}`,
    );
  }
  if (body.outcome === 'unhonored' && body.refusalDiagnostic !== undefined) {
    throw new Error(
      `LANGUAGE_COVERAGE_UNHONORED_WITH_REFUSAL: ${body.receiptId}`,
    );
  }
  if (
    body.outcome === 'unhonored' &&
    (body.observedFact.kind !== 'unhonored' ||
      body.observedFact.accepted !== true ||
      body.observedFact.honored !== false)
  ) {
    throw new Error(
      `LANGUAGE_COVERAGE_UNHONORED_FACT_INVALID: ${body.receiptId}`,
    );
  }
}

function assertExecutedObservedFact(
  receiptId: string,
  observedFact: Readonly<Record<string, unknown>>,
): void {
  const subject = observedFact.subject;
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    throw new Error(`LANGUAGE_COVERAGE_EXECUTION_FACT_INVALID: ${receiptId}`);
  }
  if (observedFact.kind === 'persistedEffect') {
    if (
      !Object.hasOwn(observedFact, 'expectedValue') ||
      !Object.hasOwn(observedFact, 'observedValue') ||
      observedFact.expectedValue === undefined ||
      observedFact.observedValue === undefined ||
      stableStringify(observedFact.expectedValue) !==
        stableStringify(observedFact.observedValue)
    ) {
      throw new Error(`LANGUAGE_COVERAGE_EXECUTION_FACT_INVALID: ${receiptId}`);
    }
    return;
  }
  if (observedFact.kind === 'executionCounter') {
    if (
      !Number.isSafeInteger(observedFact.minimumCount) ||
      Number(observedFact.minimumCount) < 1 ||
      !Number.isSafeInteger(observedFact.observedCount) ||
      Number(observedFact.observedCount) < Number(observedFact.minimumCount)
    ) {
      throw new Error(`LANGUAGE_COVERAGE_EXECUTION_FACT_INVALID: ${receiptId}`);
    }
    return;
  }
  if (observedFact.kind === 'producedArtifact') {
    if (
      typeof observedFact.expectedDigest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(observedFact.expectedDigest) ||
      observedFact.observedDigest !== observedFact.expectedDigest
    ) {
      throw new Error(`LANGUAGE_COVERAGE_EXECUTION_FACT_INVALID: ${receiptId}`);
    }
    return;
  }
  throw new Error(`LANGUAGE_COVERAGE_EXECUTION_FACT_INVALID: ${receiptId}`);
}

function isLanguageCoverageOutcome(
  value: unknown,
): value is LanguageCoverageOutcome {
  return (
    value === 'executed' || value === 'typedRefusal' || value === 'unhonored'
  );
}

function isRelationScopeObligation(
  obligation: LanguageCoverageObligation,
): boolean {
  return (
    obligation.axis.startsWith('$.relations') ||
    obligation.axis.startsWith('$relationGraph')
  );
}

function decisionCategory(
  obligation: LanguageCoverageObligation,
  observed: boolean,
): LanguageCoverageDecisionCategory {
  if (!observed) return 'unobserved';
  return obligation.axis.startsWith('$.relations') ||
    obligation.axis.startsWith('$relationGraph')
    ? 'observedRelationScope'
    : 'observedOutsideRelationScope';
}

function obligationId(
  specification: LanguageSpecification,
  axis: string,
  value: ClosedValue,
): string {
  return `${specification}:${axis}=${stableStringify(value)}`;
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  diagnostic: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) throw new Error(`${diagnostic}: ${id}`);
    result.set(id, value);
  }
  return result;
}

function referenceTarget(value: unknown): string | undefined {
  return isRecord(value) && typeof value.targetId === 'string'
    ? value.targetId
    : undefined;
}

function mapSet(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Set<string>();
  map.set(key, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClosedValue(value: unknown): value is ClosedValue {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  );
}

function compareAxis(
  left: Pick<LanguageCoverageAxis, 'axis' | 'specification'>,
  right: Pick<LanguageCoverageAxis, 'axis' | 'specification'>,
): number {
  return (
    compareCodePoints(left.specification, right.specification) ||
    compareCodePoints(left.axis, right.axis)
  );
}

function compareValue(left: ClosedValue, right: ClosedValue): number {
  return compareCodePoints(stableStringify(left), stableStringify(right));
}

export function compareCodePoints(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightCodePoints = Array.from(right, (value) => value.codePointAt(0)!);
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftCodePoints[index]! - rightCodePoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}
