# Ruling — what "G3 complete" means, and what is still owed

Ruled 2026-08-03 by the orchestrator, at `main` = the ledger-backfill commit.

**Why this ruling exists.** `U1`–`U8` — the entire UX program — are parked on the
trigger *"G3 complete."* Nobody had defined it. Four items from plan §11.6's build
list are unbuilt and the gate's seventeen criteria had not been checked against the
code since the work landed. A trigger nobody can evaluate is the same defect as a
declared rule with no executing gate (AGENTS.md §6), so it is ruled here.

**Method.** Each criterion was checked against the code and the executed tests, not
against `current-plan.md` or the ledger. That is deliberate: on 2026-08-03 both
documents were found stale — the queue reported defects as open that three packets
had closed, and the ledger was missing fifteen accepted packets. Two of the
orchestrator's own conclusions from reading those documents were wrong. Where a
capability exists under a name different from the plan's wording, the code wins.

## The seventeen gate criteria (plan §11.6, lines 2584-2606)

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | on-hand reconstructs entirely from movements | **MET** | No stored balance exists — `grep on_hand db/migrations/*.sql` is empty. On-hand is a `sum` aggregate over `inventory_movement.quantity_delta`. `inventory-onhand.test.ts` carries an independent ledger oracle asserted against the served result. |
| 2 | duplicate command delivery cannot double-post | **MET** | Idempotency identity on the movement contract, exercised in `inventory-posting.test.ts`, `inventory-stock-count.test.ts` and `inventory-terminal-state.test.ts`. |
| 3 | simultaneous adjustments/transfers preserve invariants | **MET** | `stock-serializer.test.ts` — "stock lock plan is canonical, total, stable, and duplicate-free"; `5g3-ord` closed the two order-decisive gaps with deletion reds. |
| 4 | transfer quantities and units balance | **MET** | `G3-P4a`; 107 transfer references in `inventory-posting.test.ts` including atomicity across source and destination. |
| 5 | negative-stock policy enforced at posting time | **MET** | `inventory-posting-service.ts`, exercised in `inventory-posting.test.ts` and `inventory-storage.test.ts`. |
| 6 | count corrections preserve counted, expected, variance | **MET** | `G3-P4b`; `inventory-stock-count.test.ts` — "preserves three-value evidence and appends correction and exact reversal through the shared protocol". |
| 7 | backdated behavior explicit and tested | **PARTIAL** | Handling exists in `inventory-posting-service.ts` and the compiler conformance set; no test asserts the *policy* as such. Closeable inside an existing packet, not a stage blocker. |
| 8 | closed-period posting rejected inside the transaction, with a negative control | **MET** | `inventory_period_lock` entity with its own operations and permissions; exercised in `inventory-posting.test.ts`. |
| 9 | prior balance reproducible at a recorded-time horizon, with a negative control | **MET** | `onHandAtTime` + `onHandRecordedAtHorizon` parameters on the on-hand query (`definition.ts:920`); `temporal_horizons` assertions and same-key anchor invalidation after append in `inventory-onhand.test.ts`. |
| 10 | balances entity-keyed; two-entity fixture beside the two-tenant fixture | **MET** | `Q1-P4` scopes every read builder and joined alias; `G3-P6b-2`'s journey asserts 5 → 0 → 5 across a legal-entity switch. Legal-entity fixtures appear in eleven test files. |
| 11 | adding a dimension and replaying reproduces byte-identical prior balances | **NOT MET** | No such test exists. `stock_dimension_set_version` is carried on the movement, but nothing replays a history across a dimension-set change. |
| 12 | base-unit change after any movement fails closed | **MET** | `5g3-berr`; `contracts.ts` and the provider error mappings. |
| 13 | no compiled artifact derives a monetary amount from a movement | **MET** | Compiler-level control: `conformance.ts:2503-2504` marks `monetaryBoundary.countEvidenceMonetaryFields` and `monetaryBoundary.movementAmountFields` **forbidden**. Stronger than a test — the compiler refuses. |
| 14 | UI, agent, export and reporting return the same balances | **NOT MET** | UI is done (`G3-P6b-2`). There is no agent package and no export machinery; `erp_query` appears only in `protocol.ts` and the architecture boundary list. |
| 15 | every mutation has actor, reason, release, source, verification evidence | **MET** | The movement contract carries actor, reason code and narrative, source type/id/line/revision; release verification evidence in `releases.test.ts`. |
| 16 | restoring a backup and rebuilding read models reproduces the balances | **NOT MET** | Nothing exists. |
| 17 | no direct balance-update path in source, API, UI, import or agent tooling | **MET BY CONSTRUCTION** | There is no balance to update: no `on_hand` column exists in any migration. The only derived store is the `north_star_internal` aggregate anchor, which `G3-P5` made posting invalidate atomically (`5g3-stale`). |

**Twelve met, one met by construction, one partial, three not met.**

## Ruling on the four unbuilt build-list items

**`G3` is not complete, and it is three packets away — not a stage of work.**

| Item | Ruling | Reason |
|---|---|---|
| **Reconciliation job** (§11.6 build 11) | **STAYS IN G3 — scope corrected 2026-08-03** | ~~Nothing periodically re-derives from movements and compares.~~ **That was wrong, and reading `G3-P5`'s code before writing the packet prompt found it.** The read path already does most of this: every aggregate read verifies the anchor against an expected digest (`module-runtime-interpreter.ts:1277-1280`), and on mismatch it recomputes from the ledger, persists a row in `north_star_internal.semantic_aggregate_anchor_discrepancies`, emits an `anchor-discrepancy` observation, **returns the recomputed value rather than the cached one, and deliberately preserves the bad anchor rather than repairing it** (`:1315-1319`). That is "emits discrepancies without silently repairing them" already satisfied — **for keys someone reads**. **What genuinely remains is narrower and is what `G3-R1` owns:** (a) **the source-document arm** — §11.6 build 11 requires comparing movement sums, materialized read models **and source documents**, and nothing compares `inventory_transaction` / `inventory_transaction_line` against the movements they produced, so a posting that wrote a correct header and wrong movements is invisible; (b) **sweep coverage** — the check fires only on read, so a balance nobody looks at is never verified, and build 11 describes a job rather than a read-path guard; (c) **operator visibility** — discrepancies reach a table and a metric, and nothing surfaces them to a human. |

### Correction, 2026-08-03 — this ruling named ARMS and not COMPLETENESS

**The three arms above are not a specification, and treating them as one cost nine
review rounds across three charters.** They say *where* to look and never say *what
makes a comparison set complete rather than merely long*. Every reviewer therefore
instantiated it differently and each round found one more uncompared field —
effective date, then source line and posting role, then reason code and the
movement's transaction FK. That regress does not terminate, because there is
always one more column.

**The rule, adopted from `G3-R1`'s own diagnosis and now binding:** a
reconciliation's comparison set is **DERIVED FROM THE COMPILED CONTRACT, NOT
ENUMERATED BY HAND.** Every column the posting service copies from a source
document to a movement is document-derived by construction, so the obligation can
be generated from the storage contract or asserted against the writer's field
list. Under-enumeration then fails a gate instead of waiting for a reviewer to
notice.

### REVERSED, 2026-08-03, by an independent scope review — the derivation rule does not stand

**Fable max, commissioned as an independent scope review after this packet's
second trip to the cap, overruled the correction below. It is right, and it was
right about the diagnosis too.** Recorded in full because the orchestrator was
wrong three times running and the reasoning matters more than the verdict.

**The cause is not under-specification. It is that ONE VERDICT WORD SPANS TWO
INSTRUMENTS.** `consistent` currently asserts a conjunction over balances,
provenance *and* cache integrity, and an unbounded conjunction has no completion
condition. The evidence is the distribution, not the argument: every
balance-affecting finding — quantity by location, movement count, item, unit,
effective date, orphan movements, anchor-vs-ledger — landed in **rounds 1-2 and
has been stable for seven rounds since**. Everything after was provenance or
integrity wearing the balance verdict's name.

**The derivation rule is unimplementable here.** `StorageFactTarget.fieldColumns`
(`storage.ts:296-307`) is a *name map* over nine keys — it records that a fact has
these columns and nothing about which document field any is copied from — and it
**omits `quantityDelta`, `effectiveAt`, `reasonCode`, `reasonNarrative`,
`actorId` and `reversalOfMovementId`**, most of the fields actually in dispute.
Asserting against `insertMovement`'s field list means parsing source text, which
AGENTS.md §6 names as a **proxy**, not observation.

**And it would not terminate.** `location_id` and `quantity_delta` are not
*copied* — they are computed by a sign-and-side rule — so the rule as worded
**excludes the arm's two most important comparisons**. It would still need
exceptions for computed fields, transitively-derived ones (`business_period`,
`posting_role`), cross-document ones (`reversal_of_movement_id`), and
revision skew (`source_revision` advances on draft→posted, so equality is false
by construction). A rule needing a hand-maintained exception list is the
enumerated list under a better name.

**A correction to the orchestrator's use of ADR-0044.** The ADR forbids
*undeclared inability* — a search returning `[]` indistinguishably from
no-matches. It explicitly blesses **declared structural absence**. A
reconciliation that says *"I verify balances; provenance is instrument X"* is
compliant. Applying the ADR to every uncompared field regardless of declaration
converts a rule about honesty into a rule about **totality**, and totality has no
terminus. That conversion cost six of the nine rounds.

**A materiality correction both the reviewer and the lane got wrong:** the
current-generation early returns are **not** false-consistents. Every one calls
`arm.unverifiable(...)` or `arm.discrepant(...)` before returning — five sites,
verified — so the subject is always flagged and the scope can never read
`consistent` because of it. What is lost is detail on an already-flagged anchor.

**THE ADOPTED RULE — split the verdict, then ratchet the classification.**
Reconciliation reports a **balance verdict** and an **integrity/provenance
verdict** as separate outcomes, each with its own
`consistent`/`discrepant`/`indeterminate`. The balance instrument is **declared
complete and closed today**. The integrity instrument owns `anchor_digest`,
provenance fields and recorded-discrepancy surfacing. Underneath both, a
**construction-time completeness ratchet**: every column in the movement entity's
compiled column list must appear in a declared classification map — compared, or
excluded with a stated reason — or construction throws. That reads the produced
artifact rather than parsing source, fails closed, needs no compiler change, and
makes silent omission impossible **without pretending semantics can be derived**.

**The finding nobody centred:** `anchor_digest` is unverified by the sweep and is
**the only remaining genuine reachable false-consistent**. It is not a document
field, so neither the derivation ruling nor the partial-set alternative reaches
it — three rounds of specification debate were spent on the class that does not
contain it.

---

*Superseded reasoning retained below.* This is the same move `5g3-langcover` made for the canonical language — derive the
obligations from the schema rather than listing them — and it is the factory
thesis applied to its own verification. A hand-written list of fields to compare
is exactly the per-module bespoke code this platform exists to abolish.
| **Dimension-set replay** (criterion 11) | **STAYS IN G3** | This is a one-way door. ADR-0016 versions the stock-dimension set precisely so it can grow; if growing it silently changes historical balances, the damage is unrecoverable and undetectable. It must be proven before the dimension set has a history worth protecting, which is now. |
| **Backup restore + read-model rebuild** (criterion 16) | **STAYS IN G3** | Cheap, and it is a trust claim rather than a feature. Since on-hand is derived, "rebuild reproduces the same balances" is close to already true; proving it costs little and closes the criterion honestly. |
| **Low-stock read model** (§11.6 build 6) | **DEFERRED TO G4** | A query declaration over movement data that already works. It exercises no new platform property. Cheap whenever it is wanted. |
| **Export and recount jobs** (§11.6 build 10) | **DEFERRED TO G4** | Same reasoning. Durable job machinery is genuinely new work, but it is not what makes inventory *trustworthy*, which is what this gate is for. |
| **Agent tool surface** (§11.6 build 9) | **DEFERRED TO G4 — and this AMENDS the gate** | Recorded explicitly rather than quietly: criterion 14 says *"UI, agent, export and reporting return the same balances."* Deferring the agent surface changes what the gate asserts, which is a gate change and not a scheduling choice. **Criterion 14 is narrowed to UI and reporting for G3**, and the agent and export arms move to G4 as an explicit, non-optional inheritance. G4 may not close without them. |

## What "G3 complete" now means

G3 is complete when the three retained packets are accepted and criterion 7's
backdating policy has an asserting test. Concretely:

  - `G3-R1` reconciliation — re-derive from movements, compare against served
    balances and anchors, emit discrepancies, **repair nothing**
  - `G3-R2` dimension-set replay — add a dimension to a fixture set, replay the
    same event history, assert byte-identical prior balances
  - `G3-R3` backup restore and read-model rebuild reproduce the same balances
  - criterion 7's backdating assertion, closeable inside any of the three

This is an **executable** definition: each is a packet with a ledger row, so
"G3 complete" becomes a question about the ledger rather than a judgement call.

## Consequence for the parked UX program

`U1`–`U8`'s trigger now has a meaning. It does **not** fire yet. `U0`, whose note
already places it before `G3-P6b`, is unaffected and remains takeable at any time.

## Recorded limits of this ruling

- It is a **desk ruling from code reading**, not a program review. `5g3-prog` — the
  major-correctness-domain review of the inventory ledger — is still owed, and it
  is the thing that can find what neither the tests nor this reading covers. This
  ruling scopes that review; it does not replace it.
- Criteria 2, 3, 8 and 15 were confirmed present and exercised, but not read
  assertion-by-assertion. If `5g3-prog` disputes any of them, the review wins.
- The `5g3-langgate` coverage gate is in flight and reports **zero of 94 relation
  shapes with execution evidence**. That is a language-coverage claim rather than
  an inventory-correctness claim, so it does not move any verdict above — but if
  it survives review, it means several of the MET verdicts rest on shapes the
  platform accepts without proof that it honours them.

### Final ruling on reconciliation, 2026-08-03 — observation, not a table; and a hard stop

**Fifteen Codex rounds across four charters. The Fable confirm has never run.**
Each charter was closer and each was still hand-maintained: first a field list,
then an axis classification table. **Adversarial review does not converge on a
hand-maintained artifact**, which is the lesson, and it took four tries to see it.

**Adopted, from the lane's own diagnosis:** the reconciler records **what each arm
actually examined**, per subject per axis, and derives the verdict from that. A
subject is `consistent` on an axis **only if something on that axis ran and found
nothing**. The 22-entry `FINDING_AXIS_EFFECTS` table of intentions is deleted.

That makes all three open findings structurally impossible rather than
individually fixed: a superseded anchor runs no balance check so it cannot be
balance-consistent; a line with zero observed movements runs no integrity
comparison so it cannot be integrity-consistent; and integrity that ran and
succeeded reports itself verified, so it cannot be contaminated by an unrelated
balance failure. **This is AGENTS.md §6 — observe, do not proxy — applied to the
reconciler's own verdict.** A table of intentions is a declaration; a record of
what executed is an observation.

**THIS IS THE LAST CHARTER FOR THIS PACKET.** If a third round blocks again on
the same class, the disposition is fixed in advance and is not open to another
re-scope: **ship the balance verdict alone**, which the independent scope review
found *"converged at round 2 and stable for seven rounds — specifiable, finite,
done"*, and which satisfies plan §11.6 build item 11 (movement sums, read models,
source documents, discrepancies without repair). **Integrity becomes its own
packet** with `anchor_digest` as its subject. Recorded now, before the outcome is
known, so it cannot be re-litigated afterwards.

**And the standing hole closes here regardless.** A Critical packet with fifteen
review rounds and **no second arm on any of them** is a gate failure, not a
scheduling detail. Whatever the outcome, Fable reviews this tree.
