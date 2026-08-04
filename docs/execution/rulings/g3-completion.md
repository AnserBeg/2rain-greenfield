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
| **Reconciliation job** (§11.6 build 11) | **STAYS IN G3** | Criterion 1 is the platform's core inventory claim. `G3-P5` introduced an aggregate anchor, so there are now two things that can disagree about a balance, and posting-time invalidation is the only thing keeping them honest. Nothing periodically re-derives from movements and compares. The plan is explicit that reconciliation must *emit discrepancies without silently repairing them* — that is a distinct property from invalidation and it is unproven. |
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
