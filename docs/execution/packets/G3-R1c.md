# G3-R1c — split the verdict, close the integrity half

Lane: BUILD · Base: `packet/g3-r1` at `bc0bc84a` · Tier: Critical.

Built on the ruling in
[`g3-completion.md`](../rulings/g3-completion.md) — *"REVERSED, 2026-08-03, by an
independent scope review"* — which overruled both the orchestrator's diagnosis
and its proposed fix after this packet reached the cap twice.

## Why nine rounds happened, and what actually fixes it

**One verdict word spanned two instruments.** `consistent` asserted a
conjunction over balances, provenance *and* cache integrity. An unbounded
conjunction has no completion condition, so every round could extend it — and
nine did. The distribution is the evidence: every balance-affecting finding
landed in **rounds 1–2 and was stable for seven rounds after**. Everything later
was provenance or integrity wearing the balance verdict's name.

**The derivation rule was not built, deliberately.** It was reversed as
unimplementable: `StorageFactTarget.fieldColumns` (`storage.ts:296-307`) is a
name map over nine keys carrying no field-level provenance, and it omits
`quantityDelta`, `effectiveAt`, `reasonCode`, `reasonNarrative`, `actorId` and
`reversalOfMovementId` — most of the fields in dispute. Parsing
`insertMovement`'s field list would be a **proxy** under AGENTS.md §6.

## 1. The verdict is split

The report carries `balances` and `integrity` as separate
`InventoryReconciliationVerdictV1` values, each with its own
`consistent`/`discrepant`/`indeterminate`, subject lists and counts. **Neither
can mask the other**, and that independence is asserted in both directions.

`FINDING_AXIS_EFFECTS` maps every finding code to its effect on each axis and is
exhaustive over the code union by construction, so a new code cannot be added
without deciding which instrument owns it. The load-bearing value is
`unaffected`: a provenance defect leaves the balance verdict clean.

`report.outcome` is retained as the worse of the two — a convenience for
alerting, explicitly **not** the authority. Keeping it is also what lets every
prior control stand unchanged.

**A consequence worth naming:** because the anchor digest is verifiable without
recognizing the query or its parameters, anchors that were wholly `unverifiable`
before are now integrity-verified. Splitting the verdict *increased* coverage.

## 2. The balance set is declared closed

**Compared, and complete for the balance verdict:** quantity by location,
movement count per line, item, unit, effective date, orphan movements (a
movement with no posted source document), and anchor-versus-ledger.

**One declared limit inside the balance set, corrected in review round 1.**
`recorded_at` is **balance-relevant** — it bounds ledger inclusion at the
recorded-time horizon (`sumMovementLedger`) — and it is **not compared**, because
the document carries no counterpart instant: the header's `recorded_at` is set at
draft creation and the movement's at posting, so they legitimately differ. The
classification originally called this "excluded: the posting instant", which
answered a different question (is it document-derived?) and thereby implied it
was balance-irrelevant. It is not. It is a **declared limit**, which is exactly
what ADR-0044 permits and exactly what it must be called. A comparison against
the posting receipt's recorded instant is the plausible way to close it and is
recorded as a follow-up, not built here.

Stable since round 2. **A reviewer counting uncompared provenance fields is
answering a question the balance verdict does not ask.**
[ADR-0044](../decisions/ADR-0044-search-capability-is-derived-and-never-silently-empty.md)
forbids *undeclared inability* — a search returning `[]` indistinguishably from
no-matches — and explicitly blesses **declared structural absence**. This is the
declaration. Applying the ADR to every uncompared field regardless of
declaration converts a rule about honesty into a rule about totality, and
totality has no terminus; that conversion cost six of the nine rounds.

## 3. The integrity half is closed

**a. `anchor_digest`** — the only remaining genuine reachable false-`consistent`,
and three rounds of specification debate never reached it. The sweep now
verifies each anchor's stored digest against the digest its own stored content
implies, **through the read path's own derivation**:
`expectedAggregateAnchorIntegrity` is exported from
`module-runtime-interpreter.ts` and wraps the existing `aggregateAnchorDigest`
and `aggregateResultFromAnchor`. There is no second digest rule — a sweep whose
digest derivation could drift from the read path's would verify nothing, which
is the failure the sweep exists to catch reproduced inside the thing catching it.

**b. Recorded discrepancies surface on every branch** — closed *structurally*
rather than per-branch: the integrity block now runs **before** any balance
early return. The correction is recorded honestly: those early returns were
never false-`consistent`. Every one calls `arm.unverifiable(...)` or
`arm.discrepant(...)` first, so the subject was always flagged; what was lost was
detail on an already-flagged anchor, and it is fixed as the milder thing it is.

**c. Provenance under the integrity verdict** — `reason_code`,
`reason_narrative` and the movement's own transaction foreign key disagreeing
with its line's. None changes a balance: the on-hand query filters on item,
location and the two temporal horizons and **never joins the transaction**.

## 4. The completeness ratchet

`assertMovementColumnsClassified` requires the movement entity's compiled column
list and `MOVEMENT_COLUMN_CLASSIFICATION` to agree exactly, or construction
throws `INVENTORY_RECONCILIATION_STORAGE_INVALID`. It reads the **produced
artifact**, not source text, so it observes rather than proxies. All sixteen
columns are classified `balance`, `integrity`, or `excluded` with a stated
reason — `recorded_at` (posting instant), `actor_id` (posting actor),
`source_revision` (the header revision advances on the draft-to-posted
transition, so equality is false by construction),
`stock_dimension_set_version` (a command input with no header counterpart).
Two entries are **declared limits rather than exclusions**, corrected in review
round 1 because the original wording conceded the provenance and then excluded it
anyway: `recorded_at` (balance-relevant, no document counterpart) and
`reversal_of_movement_id` (integrity-relevant, declared by the stock-count line,
which this arm does not read).

It does not derive semantics. It makes silent omission impossible, which is the
part that was actually costing review rounds.

## Controls and recorded reds

`test/postgres/inventory-reconciliation.test.ts` — 21 subtests. **Every control
from `G3-R1` and `G3-R1b` still passes**, with one assertion corrected rather
than weakened (below).

| # | Vacuity vector | Victim | Recorded red |
|---|---|---|---|
| 20 | a corrupt anchor digest reads consistent | disable the digest comparison | `not ok 19` — `expected exactly one AGGREGATE_ANCHOR_DIGEST_DIVERGED for 6a6a…6a6a` / `0 !== 1` |
| 21 | an unclassified movement column ships silently | remove `assertMovementColumnsClassified` | `not ok 20` — `Missing expected exception.` |
| 22 | an integrity defect contaminates the balance verdict | classify `AGGREGATE_ANCHOR_DIGEST_DIVERGED` as `balance: 'discrepant'` | `not ok 19` — `a corrupt digest over a correct balance must leave the balance verdict clean` |
| 23 | a movement keyed to the wrong transaction reads consistent | disable the transaction-link comparison | `not ok 21` — `expected exactly one SOURCE_DOCUMENT_TRANSACTION_LINK_DIVERGED for <lineId>` / `0 !== 1` |
| 24 | a movement contradicting its document's reason reads consistent | disable the reason comparison | `not ok 21` — `expected exactly one SOURCE_DOCUMENT_REASON_DIVERGED for <lineId>` / `0 !== 1` |
| 25 | an anchor whose digest was never checked reads integrity-consistent | drop the `!integrity` branch | `not ok 14` — `expected exactly one AGGREGATE_ANCHOR_INTEGRITY_UNVERIFIABLE for 4e4e…4e4e` / `0 !== 1` |
| 26 | an arm that observed nothing disappears from the authoritative verdicts | drop `blindArms` from the outcome | `not ok 22` — `balance must not read clean while an arm observed nothing` |

**Two of those five had no red on the first attempt.** The reason and
transaction-link comparisons were live and producing findings against existing
fixtures, but no assertion mentioned them — so deleting either left the suite
green. They are unexercised branches under AGENTS.md §6 until something observes
them, and subtest 21 now does.

**Verdict independence is proven in both directions** (subtest 19), which is why
`plantAnchor` now derives a **self-consistent digest** for every anchor it
writes: a fixture that plants integrity-corrupt anchors cannot demonstrate that a
balance divergence leaves integrity clean. A control that wants a corrupt digest
asks for one explicitly.

**One prior assertion corrected, not weakened.** Subtest 6 asserted that the
recorded-discrepancy finding's `observedValue` was the current ledger sum. That
conflated the two instruments this packet separates: *that a discrepancy was
recorded* is an integrity fact; *what the ledger says now* is a balance fact,
already reported by `AGGREGATE_ANCHOR_LEDGER_DIVERGED`. The assertion now pins
the separation — `observedValue` is `null`, and the ledger value is asserted on
the balance finding instead.

## Review history

**Round 1** (Codex `gpt-5.6-sol` xhigh, candidate `689edea9`) returned
**REVISE**. It confirmed the split structurally real for emitted findings,
`unaffected` genuinely isolating, the read-path refactor behaviour-preserving
(`definition.queryId` produces the identical cached envelope), the ratchet
observing rather than proxying, the new provenance comparisons holding on every
legitimate posting path, and subtest 6's change a correction rather than a
weakening. Four findings, all confirmed and all fixed:

- **An unchecked digest read as integrity-consistent.** When `anchorIntegrity`
  returned `null` — a malformed stored scope is not an identity — nothing was
  emitted, so the integrity verdict counted the anchor clean while never having
  checked it. That is ADR-0044's undeclared inability **on the axis this packet
  created to prevent it**, and it is the most serious of the four.
- **An arm that observed nothing vanished from the authoritative verdicts.** The
  `SCOPE_OBSERVED_NO_SUBJECTS` sentinel is not a real subject, so `axisVerdict`
  ignored it: one clean line in the other arm could report both axes clean while
  the anchor sweep had seen no anchors at all.
- **`recorded_at` and `reversal_of_movement_id` were misclassified** — see the
  declared limits above. Both classifications stated a reason that answered a
  different question than the one the map asks.

## Deliberately not built

- **The cache-key integrity check.** The cache key is itself a digest over the
  stored identity, so recomputing it would catch a rewritten identity that the
  result digest alone does not. It was built, then removed: it is scope beyond
  what the charter asked, and it flags every anchor whose key was not produced by
  the real compute path. **Recorded as a recommended follow-up**, not smuggled in.
- Anything deriving the comparison set from the compiled contract — reversed by
  ruling, see above.
