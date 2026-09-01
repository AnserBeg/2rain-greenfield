# Program review — the inventory ledger as a correctness domain (`5g3-prog`)

**Status: ARM 1 RECORDED, NOT CONVERGED.** One arm (Codex gpt-5.6-sol xhigh,
user-run, fresh naive) reviewed `main` at
`4218a66068041eb04e45e6fff4883c8aa8dfaebf` on 2026-09-01. The independent Fable
max arm is OWED on the same charter with two premise corrections (below) and
must review the SAME SHA without reading this file. The orchestrator reconciles
the two; until then the dispositions here are the orchestrator's adjudication of
one arm, each verified against the tree before it was written.

Charter: `~/2rain-missions/5g3-prog-charter.prompt.md`. The arm's full report is
held by the user; the summary it pasted is what this record adjudicates.

## 1. Scope

- SHA `4218a66` (the queue-freeze head). ADR-0065 (`received-quantity-ruling`,
  merge `4fe5589`) landed AFTER this SHA and was not in the arm's tree; it is
  read below where it bears on R2 and R5.
- Read-only. The arm changed nothing; the orchestrator changed records only
  (§5).

## 2. Dial A — the arm's ranked ledger, verified, dispositioned

Coherent, per the arm and confirmed by the orchestrator's reading of `#post`,
`enforceNegativeStock`, `assertPostedStockBalancesReconcile` and the
reconciliation service: as-of reconstruction through both horizons; the
projection as a committed-snapshot sum; corrections and reversals append;
negative stock refused inside the transaction after deterministic locking for
every family.

| # | finding | orchestrator verification | disposition |
|---|---|---|---|
| R1 | Capability-version authority is split: provider 2, contract/definition/conformance 1; release validation is a floor, provider registration is exact | **CONFIRMED.** `INVENTORY_POSTING_CAPABILITY_VERSION = 2` in `inventory-posting-service.ts`; `capabilityVersion: 1` in `contracts.ts`, `definition.ts` (twice) and pinned literal `1` in `conformance.ts`; `hasValidCapabilityFacts` (`release-repository.ts`) checks only `>= 1`; `validateRegistration` checks `!==`. The service's own header comment records the limit. | **FIX NOW, before the next family.** Owned by new packet `posting-kernel-admission` (critical path, parallel to ENUM-WIDEN). Existing row `posting-capability-version-has-three-encodings` is the owning row and is re-labelled. |
| R2 | Digest v4 does not cover exactly the caller's input: `callerStockCountInput` strips the derived companion ids but `digestCommand` adds derived `postingRole` back | **CONFIRMED.** `digestCommand`, version `companionDerived…`: `{ postingRole: posting.postingRole, ...callerStockCountInput(posting.command) }`; `postingRole` is `parsed.kind === 'initial' ? 'count' : 'correction'`, a pure function of the covered `kind`. ADR-0063's own argument for excluding derived identities ("carry no information") applies to it. **Consequence bounded:** no v4 receipt exists in released data — `PUR-2b` measured that `postStockCount` has no production caller — so correcting the input in place at version 4 rewrites no persisted receipt. | **FIX NOW, same packet.** Exclude `postingRole` from the v4 input; one control (a receipt digested with and without the role differs only when the role is included); ADR-0063 amended to say so. If any v4 receipt is ever found persisted outside tests, the fix is version 5 instead — the packet measures before choosing. |
| R3 | The writer inventory proves a verifier is REGISTERED, not that it RAN; a future family can omit the call and satisfy both checks | **CONFIRMED.** `validateWriterInventory` (the loop over `registration.verifiedBy`) reads only `verifier.name`; its own comment says *"WHAT THIS STILL DOES NOT PROVE … that the named verifier RUNS"*. The verifiers are invoked individually in `#post` (`readBackMovements`, `assertMovementEffectReservations`, `assertPostedStockBalancesReconcile`, `readBackStockCountEvidence`, `assertCompanionIdentitiesPersisted`); nothing compares an executed set to the `pg_stat_xact_user_tables` write set. Archived row `posting-writer-coverage-is-declared-not-observed` is this finding. | **FIX NOW, same packet.** Executed verifier tokens compared exactly with the observed write set before commit; the archived row is PROMOTED to the live queue. |
| R4 | Row-complete read-back stops at the module plane (trust documents, semantic receipt, outbox, generation state) | **CONFIRMED as already recorded** — row `posting-platform-plane-writes-not-row-complete`, honestly scoped in ADR-0060/0062. | **Recorded, dormant.** One line in the archive's freeze table. Not restated as closed. |
| R5 | ADR-0018 requires a materialized balance to state its `recordedAt` horizon; `posted_stock_balance` has none because ADR-0057 defines it as the committed posted-fact sum | **CONFIRMED.** ADR-0018 line *"a materialized balance records the `recordedAt` horizon it was computed at"*; ADR-0057 consequences: *"current posted-ledger stock with an explicit temporal limit; historical/as-of questions continue through the bitemporal aggregate lookup."* Code coherent; record ambiguous. ADR-0065 inherits ADR-0057's shape and the same ambiguity. | **RECORD FIX, done by the orchestrator (§5):** ADR-0057 amended with the distinction — a transaction-snapshot projection versus an as-of balance — and ADR-0018's clause read as binding as-of materializations. |
| R6 | ADR-0060..0063 still say *proposed* while their packets are accepted | **CONFIRMED, and one more:** ADR-0065 says *proposed* while its ledger row says accepted — the same class, a fresh instance, minutes old. Precedent: the eleven stale status lines corrected under the orchestrator's bridge during `record-claim-fidelity`. | **RECORD FIX, done (§5):** five status lines swept to accepted with packet and merge SHA. The gate that would catch this class is `record-marker-schema` (archive, dormant) — the freeze does not promote it. |

**Seed-question dispositions, verified.** (1) The `5g3-ord` disagreement is
still present: migration `0015`'s binding-movement pick orders by
`movement_recorded_at_column, record id`, not the frozen seven-field tuple; it
reaches only the typed `bindingMovementId` in a base-unit refusal and cannot
change a balance or a refusal decision. Dismissed as a ledger-correctness defect;
stays dormant. (2) The projection cannot serve an invented balance under its
stated contract — upheld, and R5 is the record's half. (3) Legacy version-3
evidence decodes only from persisted effects; the digest-recomputation path
refuses (`unreconstructibleReceiptVersion`) — upheld. (4) The deferred-trigger
gap stays dormant — upheld.

## 3. Dial B — arm 1's verdict, adjudicated

**Arm 1: ADJUST.** Keep user-selected packets, fresh-naive review for
specialized classes, Band A controls and the record layer. Strongest reason:
specialized work discovers one member of a defect class per review round after
construction — nine `PUR-2a` BLOCKs, then five enablers and no receipt code —
which is late discovery, not caution. The 2026-09-01 convergence rule is the
right correction.

Three actions, each adjudicated:

1. **A cross-layer admission map before each specialized family** (version
   authority, public command and digest, every module and platform writer,
   required executed verifiers, storage transitions, old-data reachability).
   **ADOPTED.** `posting-kernel-admission` IS that map for the posting kernel,
   built once and reused by `PUR-2c` and `SAL-2`; the resumed `PUR-2c` charter
   will carry the map as its first section.
2. **Stop after the second BLOCK in the same defect class and present one
   class-level corrective.** `review-tiers` already says enumerating → STOP; the
   arm adds a hard count. **PROPOSED to the user, not applied** — one sentence in
   the convergence section. The orchestrator recommends adopting it.
3. **An enabler WIP cap: after the current hard blocker and the fix-now
   correction, the next accepted merge contains goods-receipt production code.**
   **ADOPTED** as freeze rule 6 in `current-plan.md`.

## 4. Charter assessment — two premise errors, both the orchestrator's

- *Sixteen* ADRs: the list enumerates fourteen. Corrected in the Fable arm's
  charter.
- *Version 4 across both posting families*: `currentCommandDigest` selects
  `companionDerived…` (v4) only for stock counts; the authored family
  (adjustment, transfer) digests at the standard version 2. Corrected.

The arm judged the charter useful and not over-broad; its digest question is
what exposed R2.

## 5. What the orchestrator changed on the record, docs-only, this session

- ADR-0060, 0061, 0062, 0063, 0065: status lines swept to accepted (R6).
- ADR-0057: amendment section distinguishing a transaction-snapshot projection
  from an as-of balance (R5).
- `current-plan.md`: freeze rule 6; the Dial B addendum; the critical path
  gains `posting-kernel-admission`; `received-quantity-ruling` marked accepted;
  `posting-writer-coverage-is-declared-not-observed` promoted.
- `current-plan-archive.md`: freeze-table lines for R4, the `5g3-ord`
  dismissal, and the record fixes.
- `lanes.md`: REVIEW row (arm 1 recorded); ADMISSION lane proposed.
- `ledger.md`: pointer row for this review.

## 6. Owed

- **The Fable max arm**, same charter, corrected premises, same SHA
  `4218a66`, without reading this file. Then reconciliation and a converged
  record, with a second Dial B verdict.
- **ADR-0065's human read.** The RULING lane integrated and accepted itself
  (*"the human read was the review"*). The orchestrator read the ADR in full
  against `#post`, `enforceNegativeStock`, `assertPostedStockBalancesReconcile`
  and ADR-0057 and found it consistent with the tree and with R2/R5; that read
  is recorded here as a `local-confirm` with its limit stated — it is not the
  user's read. The user confirms or overrules.
