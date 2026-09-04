# Program review — the inventory ledger as a correctness domain (`5g3-prog`)

**Status: CONVERGED 2026-09-01.** Two independent arms — Codex gpt-5.6-sol xhigh
(arm 1) and Fable max (arm 2), both user-run, fresh naive, neither able to see the
other — reviewed `main` at `4218a66068041eb04e45e6fff4883c8aa8dfaebf`. Arm 2 read
a `git archive` extraction of that exact tree without opening arm 1's record. The
orchestrator verified every load-bearing claim of both arms against the tree
before writing Part C; where the arms disagree, the tree decides and the finding
is named.

Charter: `~/2rain-missions/5g3-prog-charter.prompt.md` (arm 2's copy carries two
premise corrections). Each arm's full report is held by the user; the pasted
reports are what Parts A and B record.

**Headline, both arms:** Dial B **ADJUST** — keep the method, make its own rules
execute. Dial A: the ledger's arithmetic and one-way doors are coherent; the
defects are at the seams — a version authority split three ways, a digest that
covers one derived member, verifiers whose execution is unproven, an honesty
instrument nobody can run while a healer runs on every release, an ordering whose
kill evidence is prose, and a wall-clock `recordedAt` with no floor.

---

## Part A — arm 1 (Codex xhigh), as adjudicated on 2026-09-01

### A.1 Scope

- SHA `4218a66` (the queue-freeze head). ADR-0065 (`received-quantity-ruling`,
  merge `4fe5589`) landed AFTER this SHA and was not in the arm's tree; it is
  read below where it bears on R2 and R5.
- Read-only. The arm changed nothing; the orchestrator changed records only
  (§5).

### A.2 Dial A — the arm's ranked ledger, verified, dispositioned

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

### A.3 Dial B — arm 1's verdict, adjudicated

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

### A.4 Charter assessment — two premise errors, both the orchestrator's

- *Sixteen* ADRs: the list enumerates fourteen. Corrected in the Fable arm's
  charter.
- *Version 4 across both posting families*: `currentCommandDigest` selects
  `companionDerived…` (v4) only for stock counts; the authored family
  (adjustment, transfer) digests at the standard version 2. Corrected.

The arm judged the charter useful and not over-broad; its digest question is
what exposed R2.


---

## Part B — arm 2 (Fable max), verified

Arm 2 reported nine ranked findings, four dismissals with reason, four charter
corrections and a Dial B ADJUST with three course corrections. Every claim below
was checked by the orchestrator at the symbol or file named.

| # | finding | orchestrator verification | disposition |
|---|---|---|---|
| A1 | The honesty instrument cannot be run and the projection is healed silently on every release preparation: `reconcile` and `rebuildPostedStockBalances` have no production caller; `ensurePostedStockBalanceProjection` runs from the transition apply path on every prepared transition and `rebuildPostedStockBalanceOnClient` soft-retires and reinserts without comparison | **CONFIRMED.** No file under `apps/` references the reconciliation service or the rebuild; `ensurePostedStockBalanceProjection` is called at the transition apply site in `module-storage-materializer.ts` and calls `rebuildPostedStockBalanceOnClient` unconditionally. ADR-0057's *"first materialized"* and *"named rather than silently healed"* sentences are false of the system. | **FIX NOW, new packet `posted-stock-honesty`**, serial behind `ENUM-WIDEN` (it holds `module-storage-materializer.ts`) and before `PUR-2c` lands operator receipts: a `scripts/` reconciliation runner; the rebuild compares each stored quantity against its recomputed sum and writes a discrepancy row in the anchor-discrepancy shape before overwriting; ADR-0057's two sentences corrected (done here, §C.5). |
| A2 | The same-instant order's discriminating reds exist only as prose in ADR-0027's table; no manifest under `test/evidence/` names an ordering control | **CONFIRMED.** `grep -il "order\|tie"` over the six manifests matches nothing of the kind; the comparator and `assertPersistedPlannedOrderIsDecisive` exist in `inventory-posting.test.ts` with no expected-red entry. | **FIX NOW, folded into `posting-kernel-admission`:** two manifest entries (comparator branch deleted; persisted-plus-planned sort removed). Minutes. |
| A3 | `recordedAt` is a wall clock (`recordedAtAuthority.currentInstant()`) with no monotonic floor; a backward step between two postings on one identity lets an as-of read return a negative balance under `reject` that the kernel never admitted | **CONFIRMED.** Line-level: the instant is sampled once per posting from the authority; `enforceNegativeStock` has no comparison against the maximum persisted `recordedAt`; `AGENTS.md` §7 records this machine stepping its clock back. The as-of read is operator-reachable through the on-hand lookup surface. | **FIX NOW, folded into `posting-kernel-admission`:** in `enforceNegativeStock`, assert the sampled instant is ≥ the maximum persisted `recordedAt` for the affected identities — refuse with a typed error or clamp to equality and let the tuple order the tie — plus one control. Re-ranked out of R13's batch. |
| A4 | Forward-dated postings are unbounded (`enforceBackdate` is one-sided, pinned by `inventory-backdate-policy.test.ts`); `posted_stock_balance` sums future-effective movements while the as-of read at now excludes them, with nothing on the row saying so | **CONFIRMED** at the test's own comment (*"the policy is one-sided: it bounds backdating, never forward dating"*). Ledger safe; operator legibility not. | **DECISION for resumed `PUR-2c`'s charter:** a `maximumForwardDateDays` dial with a fail-closed default, or a written ruling that forward dating is allowed and the Posted stock surface carries it. Recorded on the critical-path row. |
| A5 | ADR-0018's launch invariant (a materialized balance records its `recordedAt` horizon) is not met by `posted_stock_balance`; the row's OWN horizon — the maximum `recordedAt` over its movements — is exact and cheap | **CONFIRMED, and it corrects the orchestrator's own amendment from Part A.** That amendment argued a stored horizon would be false under concurrent readers; that is true of a global generation, not of the row's own maximum, which arm 2 is right about. | **RECORD FIX NOW** — the ADR-0057 amendment is rewritten (§C.5). **Column with the next posted-stock change** (`SAL-2`'s read models). Filed. |
| A6 | Six ADR-vs-code contradictions: ADR-0026's pins (version 1, v3 root `35fc38…`, lock placement); ADR-0057's two sentences; ADR-0018 vs 0057; ADR-0062's and the production comment's *"no `CREATE CONSTRAINT TRIGGER` anywhere"*; ADR-0016's claimed fail-closed rule on a hardcoded `(item, location)` tuple; four `proposed` statuses | **CONFIRMED on every row.** `db/migrations/0005_*.sql` creates four constraint triggers (platform-plane, so the deferred vector stays dormant); `conformance.ts` has no hardcoded-tuple rule; ADR-0026 lines 50-52 pin version 1 and the v3 root; the statuses were swept in Part A. | **Sweeps done (§C.5):** ADR-0062's sentence, ADR-0016's enforcement bullet, ADR-0057's two sentences. **The production comment** beside `assertObservedWriteSetIsDerived` is executable-tree and goes to `posting-kernel-admission`. **ADR-0026's stale pins** are the `record-marker-schema` class (superseded-values convention), dormant; filed. |
| A7 | Digest version 2 (adjustment, transfer) covers `authorization` and `channel`, which the executor puts on the command and which are not the caller's semantic input; a retry after a policy-version bump is refused as *"already names another posting"* | **CONFIRMED.** `inventory-posting-capability-executor.ts` builds the command with `authorization` and `channel`; the v2 branch of `digestCommand` spreads the whole command minus the key. Unreachable at pilot (one allow-all policy version). | **RECORDED, no version cut for it:** fold into the next adjustment/transfer digest version event, which `SAL-2`'s shipment family needs. Filed. |
| A8 | Every scoped on-hand read takes the tenant-wide generation lock shared and every posting takes it exclusive — correct, and a throughput ceiling | **CONFIRMED** at `module-runtime-interpreter.ts` (`pg_advisory_xact_lock_shared`) and migration 0020 (`pg_advisory_xact_lock`). | **RECORDED; measure at `SAL-2`**, where pickers browsing stock meet shipments posting. Filed. |
| A9 | Smalls: a posting concurrent with a release preparation is refused fail-closed (no control); `allowWithFlag` marks the result, not the fact; the base-unit diagnostic uses its own `(recorded_at, record_id)` tie-break; `posting-writer-inventory`'s record declares no band | Read as stated; the first is a control gap on a correct refusal, the others legibility. | Filed as one line each; the first is noted in `posted-stock-honesty`'s charter; the band item is course correction B2. |

**Dismissed by arm 2, with reason, and upheld by the orchestrator:** a rebuildable
projection does not let an immutable fact be corrected (the `reject_inventory_fact_mutation`
trigger and revoked grants stand; the one-way-door set holds); negative stock is
not a preflight for any family, reversal included; the anchor cache cannot serve a
stale balance; the deferred-trigger gap is dormant; the effect reservation is bound
and observed. Seed question 1's ordering conflation was the charter's error, and arm
2 was right to say so: a balance is a sum, and the question that matters is A3.

**Arm 2's charter corrections, accepted:** seed question 1 conflated the diagnostic's
ordering with balance correctness; seed question 2's *"reconciled without healing"*
was half true; the accepted-packet count is method-dependent (the ledger's status
column gives a different number from the row count) and is no longer cited as a
fact; the re-rank of R13's small was declared, not smuggled.

---

## Part C — reconciliation and the converged review

### C.1 Where the arms overlap, agree, or disagree

| topic | arm 1 | arm 2 | tree decides |
|---|---|---|---|
| ADR-0018 vs ADR-0057 horizon | R5: distinguish snapshot from as-of; record fix | A5: the row's own max `recordedAt` is exact; column later | **Arm 2 is more right.** The orchestrator's Part A amendment reasoned from the global generation; rewritten to arm 2's distinction with the column deferred. |
| ADR statuses | R6: four stale | A6: the same four, plus five other contradictions | Both right; arm 2 wider. All swept or routed. |
| digest v4 | R2: includes derived `postingRole`, contrary to ADR-0063's exact-input claim | A7: v4 *"keeps `postingRole` — exactly the caller's input"*; the defect is in v2 (`authorization`, `channel`) | **Both partly right.** `postingRole` is `parsed.kind === 'initial' ? 'count' : 'correction'` — derived from the covered `kind`, so arm 1's precision finding stands, but it cannot misdiagnose a replay because the mapping is deterministic; its cost is coupling. Arm 2's v2 finding is the one that can refuse a legitimate retry. R2 stays in `posting-kernel-admission` (cheap, no persisted v4 receipt); A7 rides the next v2 version event. |
| writer verification | R3: executed verifiers are not compared to the write set | dismissal: every synchronous module-plane writer is observed by read-back and the `pg_stat` delta | **Not a contradiction.** Arm 2 verified that the observed write set is derived and that each registered verifier exists and runs today; arm 1 verified that nothing proves a future family's verifier RAN. The code's own comment says arm 1's half. R3 stands. |
| version authority | R1: live contradiction, floor vs exact | A6 row 0026: stale ADR pins | Same fact at two layers; arm 1's is the executable one. R1 stands. |
| honesty instrument | not raised | A1 | Arm 2's finding, the top of the converged ledger. |
| ordering evidence, `recordedAt` floor, forward dating, lock ceiling | not raised | A2, A3, A4, A8 | Arm 2's findings, all verified. |

### C.2 Converged Dial A — ranked

| rank | finding | owner |
|---|---|---|
| 1 | **A1** reconciliation unrunnable, rebuild heals silently on every transition | `posted-stock-honesty` (after ENUM-WIDEN, before receipts land) |
| 2 | **R1** capability-version authority split, floor vs exact | `posting-kernel-admission` |
| 3 | **R3** verifier execution unproven | `posting-kernel-admission` |
| 4 | **A3** no monotonic floor on `recordedAt` | `posting-kernel-admission` |
| 5 | **A2** ordering kill evidence is prose | `posting-kernel-admission` (two manifest entries) |
| 6 | **R2** v4 digest carries derived `postingRole` | `posting-kernel-admission` |
| 7 | **A4** forward dating unruled | resumed `PUR-2c` charter decision |
| 8 | **A5 / R5** horizon distinction; own-horizon column | record fixed here; column at `SAL-2` |
| 9 | **A6 / R6** six ADR contradictions | swept here except the code comment (admission packet) and ADR-0026's pins (`record-marker-schema`, dormant) |
| 10 | **A7** v2 digest members | next v2 version event (`SAL-2`) |
| 11 | **A8** generation-lock ceiling | measure at `SAL-2` |
| 12 | **R4** platform-plane read-back | dormant, as filed |
| 13 | **A9** smalls | filed |

### C.3 Converged Dial B — ADJUST, both arms

Both arms, unable to see each other, returned ADJUST on the same reasoning: the
method finds real defects and its enablers are first instances of reusable
classes (the narrowed claim working), but its own rules — the convergence
criterion, the band calibration, a terminal state for review — were declared
and did not execute until the user supplied the terminal state five times. The
2026-09-01 rulings (freeze, narrowed claim, zero-defect convergence) are the
first half of the adjustment.

**Course corrections, reconciled into one list:**

| # | correction | source | status |
|---|---|---|---|
| B1 | A cross-layer admission map before each specialized family | arm 1 (1) | **ADOPTED** — `posting-kernel-admission` is the posting kernel's; resumed `PUR-2c`'s charter carries the map as its first section |
| B2 | Declare the evidence band per family in the charter; an undeclared band is a charter defect | arm 2 (2) | **ADOPTED** — one bullet in `mission-cadence`'s packet definition, applied 2026-09-01 |
| B3 | Enabler WIP cap: after ENUM-WIDEN and the admission packet, the next merge carries goods-receipt code | arm 1 (3) | **ADOPTED** as freeze rule 6. `posted-stock-honesty` is admitted under the rule's user-ruling clause, on A1's ground: receipts must not be the first operator writes to a ledger nobody can audit |
| B4 | Archive `review-tiers`' dated correction sections the way the queue was archived | arm 2 (3) | **APPLIED 2026-09-01** — the fourteen dated sections moved verbatim to `.agents/skills/review-tiers/ARCHIVE.md` with an index in `SKILL.md`; nothing binding moved; no test pins the file |
| B5 | Stop after the second BLOCK in one defect class and present one class-level corrective | arm 1 (2) | **PROPOSED to the user** — one sentence in the convergence section |
| B6 | Gate the round-three continuation criterion: `check-records.sh` refuses a review-log row for round ≥ 3 without a `continuation-criterion` line in the packet record | arm 2 (1) | **PROPOSED to the user** as a small Behavioral packet (under the freeze it needs a ruling); **interim practice adopted now:** the orchestrator writes the criterion line by hand for every round ≥ 3 |

### C.4 The single thing to change first

**A1.** Before `PUR-2c` lands the first operator-driven receipts, the team must
be able to ask whether Posted stock equals the ledger, and the rebuild must name
what it overwrites. Then B5/B6, which are the method's own criterion, gated.

### C.5 What the orchestrator changed on the record for arm 2 (docs-only)

- ADR-0057: the two false sentences corrected in place; the Part A amendment
  rewritten to arm 2's distinction (own-horizon column deferred to `SAL-2`).
- ADR-0062: the *"no `CREATE CONSTRAINT TRIGGER`"* sentence corrected (four in
  migration 0005, platform-plane, vector still dormant).
- ADR-0016: the enforcement bullet now says the general hardcoded-tuple rule does
  not exist and the specific case is pinned by the posted-stock ABI conformance.
- `mission-cadence`: the band-declaration bullet (B2).
- `review-tiers`: dated sections archived (B4).
- `current-plan.md`: `posted-stock-honesty` on the critical path; the admission
  packet's scope widened to A2 and A3; A4 written into row 2; the Dial B addendum
  converged; freeze-table lines for A5, A6, A7, A8, A9.
- `lanes.md`, `ledger.md`: converged rows; HONESTY lane proposed.

### C.6 Gates on this record

`scripts/check-records.sh` green at every commit. `test:architecture` (reads
`docs/**`): 189/189 at `3b7b6da` (Part A head, run once the POLICY lane's
matrix released the lock); the run at this head is recorded in the commit that
follows it.

### C.7 Still owed

- **ADR-0065's human read** (Part A §6) — unchanged; the user confirms or
  overrules.
- **B5 and B6** — the user's call.
- **`ENUM-WIDEN`**, in flight, unaffected by any of this; all changes are docs.
