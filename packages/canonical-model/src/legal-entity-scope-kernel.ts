export const LEGAL_ENTITY_SCOPE_PROFILE_VERSION =
  'northstar.query-legal-entity-scope-profile/v1' as const;

export const LEGAL_ENTITY_SCOPE_KERNEL_RECEIPT_VERSION =
  'northstar.query-legal-entity-scope-kernel-receipt/v1' as const;

/**
 * The wire contract for the v4 legal-entity query operand. Every clause is a
 * refusal rather than a repair: an operand this kernel cannot read never
 * becomes a narrower scope, a wider scope, or tenant-wide execution.
 */
export const LEGAL_ENTITY_SCOPE_CONTRACT_V1 = Object.freeze({
  admittedCardinalities: Object.freeze(['exactlyOne', 'nonEmptySet'] as const),
  duplicateMembers: 'rejected' as const,
  emptySelection: 'rejected' as const,
  maximumMembers: 64 as const,
  // Lowercase only. A case-insensitive reader would admit two spellings of one
  // entity, and the duplicate rule would then pass a two-member set that names
  // one company — the same class of wrong answer this operand exists to stop.
  memberForm: 'lowercaseCanonicalUuid' as const,
  omittedSelection: 'rejected' as const,
  resultOrdering: 'ascendingCodeUnit' as const,
  schemaVersion: LEGAL_ENTITY_SCOPE_PROFILE_VERSION,
  scalarForm: 'exactlyOneOnly' as const,
  setForm: 'nonEmptySetOnly' as const,
});

export type LegalEntityScopeCardinality =
  (typeof LEGAL_ENTITY_SCOPE_CONTRACT_V1.admittedCardinalities)[number];

export interface LegalEntityScopeSelectionRequest {
  readonly cardinality: LegalEntityScopeCardinality;
  readonly profileVersion: typeof LEGAL_ENTITY_SCOPE_PROFILE_VERSION;
  /** The untrusted caller-supplied query argument, exactly as received. */
  readonly selection: unknown;
}

export type LegalEntityScopeSelectionReceipt =
  | Readonly<{
      cardinality: LegalEntityScopeCardinality;
      kind: 'legalEntityScopeSelectionReceipt';
      members: readonly string[];
      outcome: 'accepted';
      schemaVersion: typeof LEGAL_ENTITY_SCOPE_KERNEL_RECEIPT_VERSION;
    }>
  | Readonly<{
      kind: 'legalEntityScopeSelectionReceipt';
      outcome: 'rejected';
      reason:
        | 'duplicate-member'
        | 'empty-selection'
        | 'invalid-member'
        | 'invalid-request-shape'
        | 'scalar-selection-for-non-empty-set'
        | 'selection-limit-exceeded'
        | 'selection-omitted'
        | 'set-selection-for-exactly-one'
        | 'unsupported-cardinality'
        | 'unsupported-profile-version';
      schemaVersion: typeof LEGAL_ENTITY_SCOPE_KERNEL_RECEIPT_VERSION;
    }>;

const lowercaseUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Pure reference evaluator for the v4 legal-entity operand, in the same class
 * as `inspectPredicateForExecution` and `evaluateQueryAggregateSemantics`: one
 * authority for what a selection means, which every execution target proves
 * parity against instead of re-deciding. It authorizes nothing — issuing a
 * capability from an accepted receipt is the runtime's separate decision.
 */
export function evaluateLegalEntityScopeSelection(
  value: unknown,
): LegalEntityScopeSelectionReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['cardinality', 'profileVersion', 'selection'])
  ) {
    return rejected('invalid-request-shape');
  }
  if (value.profileVersion !== LEGAL_ENTITY_SCOPE_PROFILE_VERSION) {
    return rejected('unsupported-profile-version');
  }
  const cardinality = value.cardinality;
  if (cardinality !== 'exactlyOne' && cardinality !== 'nonEmptySet') {
    return rejected('unsupported-cardinality');
  }
  const { selection } = value;
  // Omission is never "all". It is not even a narrower scope; it is a refusal.
  if (selection === undefined || selection === null) {
    return rejected('selection-omitted');
  }

  if (cardinality === 'exactlyOne') {
    if (Array.isArray(selection)) {
      return rejected('set-selection-for-exactly-one');
    }
    if (!isAdmittedMember(selection)) return rejected('invalid-member');
    return accepted(cardinality, [selection]);
  }

  if (!Array.isArray(selection)) {
    return rejected('scalar-selection-for-non-empty-set');
  }
  if (selection.length === 0) return rejected('empty-selection');
  if (selection.length > LEGAL_ENTITY_SCOPE_CONTRACT_V1.maximumMembers) {
    return rejected('selection-limit-exceeded');
  }
  const seen = new Set<string>();
  for (const member of selection) {
    if (!isAdmittedMember(member)) return rejected('invalid-member');
    // Collapsing a duplicate would silently rewrite the caller's request into
    // a different one; refusing keeps the asked question and the answered
    // question identical.
    if (seen.has(member)) return rejected('duplicate-member');
    seen.add(member);
  }
  return accepted(cardinality, [...seen]);
}

function isAdmittedMember(value: unknown): value is string {
  return typeof value === 'string' && lowercaseUuidPattern.test(value);
}

function accepted(
  cardinality: LegalEntityScopeCardinality,
  members: readonly string[],
): LegalEntityScopeSelectionReceipt {
  return Object.freeze({
    cardinality,
    kind: 'legalEntityScopeSelectionReceipt' as const,
    members: Object.freeze([...members].sort(compareCodeUnits)),
    outcome: 'accepted' as const,
    schemaVersion: LEGAL_ENTITY_SCOPE_KERNEL_RECEIPT_VERSION,
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejected(
  reason: Extract<
    LegalEntityScopeSelectionReceipt,
    { outcome: 'rejected' }
  >['reason'],
): LegalEntityScopeSelectionReceipt {
  return Object.freeze({
    kind: 'legalEntityScopeSelectionReceipt' as const,
    outcome: 'rejected' as const,
    reason,
    schemaVersion: LEGAL_ENTITY_SCOPE_KERNEL_RECEIPT_VERSION,
  });
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
