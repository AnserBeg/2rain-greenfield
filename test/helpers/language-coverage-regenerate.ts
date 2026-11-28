import {
  deriveDecisionSetDigest,
  deriveLanguageCoverageDecisionId,
  deriveObligationSetDigest,
  encodeLanguageCoverageObservationSnapshot,
  type LanguageCoverageDecision,
  type LanguageCoverageLedger,
  type LanguageCoverageObservationSnapshot,
} from './language-conformance-ledger.js';

/**
 * BUILD-MODE-1, switch `languageCoverageDigestRegeneration`.
 *
 * When the language gains a VALUE on an axis it already has, or the first-party
 * packages observe a different set of obligations, every exact-set digest in
 * coverage-decisions.json goes stale and check:language-coverage fails with
 * STALE_DECISION_SET / STALE_DECISION_DOCUMENT. In build mode preflight
 * recomputes those digests and decision identities instead of failing. The
 * reviewed text (rationale, revisitCondition, the category, the decision name
 * and the accepted-but-unhonored list) is never touched.
 *
 * A NEW obligation KIND -- an axis (`specification:axis`) that is not in the
 * document's reviewed `obligationKinds` list -- is refused: someone has to read
 * what the new kind means and add it to the list by hand. A kind that vanished
 * is dropped from the list (fewer obligations cannot hide one).
 */
export interface CoverageDecisionsDocument {
  readonly acceptedButUnhonoredObligationIds: readonly string[];
  readonly decisions: readonly LanguageCoverageDecision[];
  readonly ledgerDigest: string;
  readonly obligationKinds?: readonly string[];
  readonly observationSnapshot: LanguageCoverageObservationSnapshot;
  readonly version: string;
  readonly [key: string]: unknown;
}

export type CoverageRegeneration =
  | Readonly<{
      changed: boolean;
      document: CoverageDecisionsDocument;
      ok: true;
    }>
  | Readonly<{ newKinds: readonly string[]; ok: false; reason: string }>;

export function languageCoverageObligationKinds(
  ledger: LanguageCoverageLedger,
): string[] {
  return [
    ...new Set(ledger.axes.map((axis) => `${axis.specification}:${axis.axis}`)),
  ].sort();
}

export function regenerateCoverageDecisions(
  document: CoverageDecisionsDocument,
  ledger: LanguageCoverageLedger,
  observedObligationIds: ReadonlySet<string>,
): CoverageRegeneration {
  const current = languageCoverageObligationKinds(ledger);
  if (document.obligationKinds === undefined) {
    return {
      newKinds: current,
      ok: false,
      reason:
        'coverage-decisions.json has no reviewed obligationKinds list; add it (the kinds printed below) by hand once',
    };
  }
  const reviewed = new Set(document.obligationKinds);
  const newKinds = current.filter((kind) => !reviewed.has(kind));
  if (newKinds.length > 0) {
    return {
      newKinds,
      ok: false,
      reason:
        'the language gained a new obligation kind; decide how it is covered and add it to obligationKinds by hand (build mode regenerates digests for new values only)',
    };
  }
  const accepted = new Set(document.acceptedButUnhonoredObligationIds);
  const acceptedButUnhonoredSetDigest = deriveObligationSetDigest(accepted);
  const decisions = document.decisions.map((decision) => {
    const separator = decision.decisionId.lastIndexOf('@');
    if (separator < 1) {
      throw new Error(
        `LANGUAGE_COVERAGE_DECISION_ID_INVALID: ${decision.decisionId}`,
      );
    }
    const body = {
      acceptedButUnhonoredSetDigest,
      category: decision.category,
      ledgerDigest: ledger.digest,
      obligationSetDigest: deriveDecisionSetDigest(
        ledger,
        observedObligationIds,
        decision.category,
      ),
      rationale: decision.rationale,
      revisitCondition: decision.revisitCondition,
    };
    return {
      ...decision,
      ...body,
      decisionId: deriveLanguageCoverageDecisionId(
        decision.decisionId.slice(0, separator),
        body,
      ),
    };
  });
  const regenerated: CoverageDecisionsDocument = {
    ...document,
    decisions,
    ledgerDigest: ledger.digest,
    obligationKinds: current,
    observationSnapshot: encodeLanguageCoverageObservationSnapshot(
      ledger,
      observedObligationIds,
    ),
  };
  return {
    changed: JSON.stringify(regenerated) !== JSON.stringify(document),
    document: regenerated,
    ok: true,
  };
}
