# Current plan — active execution state

## QUEUE FREEZE — ruled 2026-09-01. Read this first; it governs everything below.

**The queue is frozen to the critical path of one goal: *an office worker can receive
inventory and send it out.*** Measured reason: this file held 190 queue rows, 93 marked
OPEN, in 495KB that every lane and every reviewer re-read per session, while the ten days
after `PUR-1` produced five merges of enabler work and zero goods-receipt code. The rows
are not wrong; they are not competing for a slot.

**What moved.** Every section and row that is not on the critical path is in
[current-plan-archive.md](current-plan-archive.md), **verbatim and unchanged** — TRIAGE,
the old queue, the parked UX programme, the debate verdicts, the G2-era "where we are".
A record elsewhere that says *"see row X in current-plan.md"* resolves there. Nothing was
deleted and no disposition was altered.

**The rules while the freeze holds.**

1. **Only a row in this file may hold a slot.** Chartering anything not on the critical
   path table needs a user ruling written into that table first.
2. **A finding made during a packet is filed by one test: does it block a critical-path
   step?** If yes, it gets a row here naming the step it blocks. If no, it gets **one
   line** in the archive's *Filed during the freeze* table — packet, date, one sentence —
   and the packet record carries the detail. No prose disposition anywhere else, and no
   packet is chartered from it.
3. **Promotion is explicit.** A dormant row is promoted by moving its line into this file
   with the reason it now blocks, dated. Surfacing during an unrelated packet is not a
   reason; that is how the queue reached 190.
4. **The record layer stops growing per packet.** A packet record, its ledger row, its
   lane row and its review-log rows are the whole record. Findings inventories,
   dispositioned overlays and "corrected twice" narratives are archive material.
5. **The freeze lifts at `SAL-2` acceptance, or earlier by user ruling recorded here.**
6. **Enabler WIP cap — adopted 2026-09-01 from `5g3-prog` arm 1.** After `ENUM-WIDEN`
   and `posting-kernel-admission` land, **the next accepted merge to `main` contains
   goods-receipt production code.** A further enabler between them needs a user ruling
   written into the critical-path table naming what it blocks.

## DIAL B — the factory tripwire tripped, and it is answered here (2026-09-01)

The 2026-08-20 program review armed a falsifiable test at `PUR-1` + `SAL-1`: count platform
packets beyond the chartered posting-family work — **≤2 supports the factory claim, >4
reopens the goal question.** Counted on `main` on 2026-09-01, before `SAL-1` is even
chartered, with `PUR-2a` as the chartered posting-family work:

| # | platform packet since `PUR-1` | why it was needed |
|---|---|---|
| 1 | `posting-error-shape` | review corrective R8 |
| 2 | `record-claim-fidelity` | review corrective R1 |
| 3 | `relation-requiredness-relaxation` | v1 storage planner could not widen a released relation |
| 4 | `posting-writer-inventory` | verification seam PUR-2a's ninth round found |
| 5 | `PUR-2b` | version an already-released posting contract |
| 6 | `ENUM-WIDEN` (in flight) | v1 storage planner cannot widen a released enum |

**Six. The tripwire is tripped, and the question is answered now rather than carried to
`SAL-1` as an open debate.**

**RULING — the GOAL is kept; the CLAIM is narrowed to the review's own fallback.**

> Ordinary modules are data: Catalog, Location and `PUR-1` were authored with zero
> press changes and that stands. **Specialized code — posting families, storage
> transitions, release verification, authorization — is governed, compiler-visible
> platform work that is extended once as a reusable capability.** The factory claim is
> made for ordinary module variation only, and it is not re-tested against the cost
> of building the platform's first instance of each specialized class.

**Consequences, so the ruling executes rather than sits:**

- Platform packets on the purchasing path are **expected, not evidence of failure**, and
  are not counted against the goal again. Rows 3, 5 and 6 above are each the first
  instance of a storage-transition class the planner will reuse; that is the narrowed
  claim working as stated.
- `5g3-prog` (the inventory-ledger program review) inherits this as its Dial B starting
  position. It asks the **APPROACH** question only — is the packet-and-review method the
  right way to reach the narrowed claim at the measured cost — and does not re-open the
  goal.
- The tripwire is **re-armed at `SAL-1` + `SAL-2` acceptance** with the narrowed claim as
  its subject: platform packets that are a *second* instance of an already-built class
  count; first instances do not.

**Addendum 2026-09-01 — `5g3-prog` arm 1 (Codex) took the narrowed claim as given and
returned ADJUST on approach:** keep the method, add a cross-layer admission map before
each specialized family, stop after the second BLOCK in one defect class, and cap
enablers so the next merge after the current two is receipt code. Actions 1 and 3 are
adopted (the `posting-kernel-admission` packet and freeze rule 6); action 2 is proposed
to the user. Record: [2026-09-01-inventory-ledger.md](program-reviews/2026-09-01-inventory-ledger.md).
**Converged the same day: the Fable arm, independently, also returned ADJUST** — the method's cost came from its own rules not executing — and added three corrections: declare the band per family in the charter (adopted), archive `review-tiers`' dated sections (applied), and gate the round-three continuation criterion (proposed with arm 1's two-BLOCK stop). Six corrections reconciled in the record, §C.3.

## Where we are — 2026-09-01

| Stage | State |
|---|---|
| G0, G1 | COMPLETE |
| G2 | walking slice, composed app, forms and pickers all accepted; stage never formally closed |
| G3 | posting engine (adjust, transfer, count), stock balance read model accepted; `5g3-prog` review open |
| G4 | `PUR-1` accepted 2026-08-22. `PUR-2` split into `2a` (accepted), `2b` (accepted), `2c` (STOPPED on the enum-widening refusal; record on `main`) |

Accepted packets: 146 in six weeks. Since `PUR-1`: five merges, all enablers, no
goods-receipt code. The critical path below is what remains.

## The critical path — frozen 2026-09-01

Serial unless marked parallel. Every module mount touches the same builder tuple,
release lineage and migration chain, so the mounts cannot overlap.

| step | packet | state | notes |
|---|---|---|---|
| 1 | `ENUM-WIDEN` | **IN FLIGHT**, cut from `main` at `8c41752` | Critical, Band A. Three groups per `PUR-2c` §2.5; cuts migration `0024`; ADR-0064 reserved to it |
| 2 | `PUR-2c` (resume) | blocked on 1, `posting-kernel-admission` and `posted-stock-honesty` | goods receipt + posting through PUR-2a's binding; consumer census; §7.16 catalog obligation; **builds the ADR-0065 received-quantity read model and owes its ten named claims**; **its charter RULES forward dating** (`5g3-prog` A4: a `maximumForwardDateDays` dial with a fail-closed default, or an explicit allow carried on the Posted stock surface) and **opens with the admission map** (B1) and **declared bands per family** (B2) |
| 3 | `PUR-2` remainder | after 2 | receipt correction, received/open-to-receive read models, what closes an order (§7.5: not viable without these) |
| 4 | `SAL-1` | after 2 and the R7 small | sales order, mirror of `PUR-1` |
| 5 | `SAL-2` | after 4 | shipment, negative posting, correction, read models, packing document |
| ∥ | `received-quantity-ruling` | **ACCEPTED 2026-09-01**, merge `4fe5589` | ADR-0065: a provider-written rebuildable read model in the ADR-0057 shape, over-receipt refused inside the posting transaction on the order line as the serialization unit. The lane self-integrated; the orchestrator's read is recorded as a `local-confirm` in the `5g3-prog` record §6 — **the user's read is still owed** |
| ∥ | `posting-kernel-admission` | **parallel, now** (against ENUM-WIDEN; serial against `policy-unbound-refusal` on `conformance.ts`) | `5g3-prog` R1 + R2 + R3 + A2 (two ordering manifest entries) + A3 (a monotonic floor on `recordedAt` in `enforceNegativeStock`, one control), one packet — the writer may stop and split if it outgrows one freeze: ONE capability-version authority that release validation checks exactly; digest v4 excludes the derived `postingRole` (no persisted v4 receipt exists, measured); executed verifier tokens compared with the observed write set before commit. Owns `inventory-posting-service.ts`, `contracts.ts`, `definition.ts` (the version literal), the `conformance.ts` version cell, `release-repository.ts`'s capability-fact check, its tests and manifest. This IS arm 1's admission map for the posting kernel |
| ∥ | `policy-unbound-refusal` | **parallel, now** | R7 small (a): a declared permission with no evaluator binding announces itself at compile time. R7 small (b), RLS on `module_storage_backfill_checkpoints`, needs a migration and is serialized behind `0024` |
| 3a | `posted-stock-honesty` | **after ENUM-WIDEN lands, before step 2** (it edits `module-storage-materializer.ts`, ENUM-WIDEN's) | `5g3-prog` A1, the converged review's top finding: `reconcile` and the rebuild have no production caller while `ensurePostedStockBalanceProjection` heals the projection on EVERY transition without naming drift. Deliverables: a `scripts/` reconciliation runner the team can run (no route while row `7` is deferred); the rebuild compares each stored quantity to its recomputed sum and writes a discrepancy row in the `semantic_aggregate_anchor_discrepancies` shape before overwriting; a control for the posting-during-preparation refusal (A9). ADR-0057's sentences already corrected. Admitted under freeze rule 6's ruling clause on A1's ground |
| ∥ | `5g3-prog` | **CONVERGED 2026-09-01**, two arms at `4218a66` | inventory-ledger program review; thirteen ranked findings, six fix-now across `posted-stock-honesty` and `posting-kernel-admission`, one charter decision for step 2, record fixes done, the rest filed; Dial B ADJUST both arms. [Record](program-reviews/2026-09-01-inventory-ledger.md) |

Gate-integrity rows kept visible because they decide whether a matrix result can be
trusted: `review-record-gate-covered-by-any-later-record`,
`container-pressure-forges-outcomes`. Owned-by-step rows:
`migration-range-encoded-in-a-test-title` (step 1), `purchasing-requires-inventory` and
`posting-capability-version-has-three-encodings` (step 2), `7` (step 4).

## PROGRAM REVIEW — 2026-08-20, DONE. Read this before assuming one is due.

**The first-office-worker-slice program review is COMPLETE**, two arms converged, recorded
at [`program-reviews/2026-08-20-first-office-worker-slice.md`](program-reviews/2026-08-20-first-office-worker-slice.md)
against `7e1c815`, with a ledger pointer row. **Do not treat the fan-out trigger as
pending — it fired and was discharged.**

**A DIFFERENT program review is still open and is not this one:** row `5g3-prog`, the
major-correctness-domain review for the inventory ledger. **A lane reading only the queue
mistook that row for the fan-out trigger on 2026-08-20**, which is exactly the failure
this section now prevents.

**Recorded as an orchestrator error:** the review was written, committed and pushed, and
**the queue was never told.** That is finding **R1 of the review itself** — a record
outliving its truth — committed two hours after writing the finding. **The instrument that
would have caught it is R1's own `check-records.sh`, which is not built yet.**

## R-ROW SEQUENCING — ruled 2026-08-22. The R rows ARE the work before purchasing.

**The TRIAGE (now in [current-plan-archive.md](current-plan-archive.md)) is dated 2026-08-13 and predates the program review by a week.** It is
still correct about Tier 1 (all eight rows accepted) but it is NOT the current work list.
**The 2026-08-20 review's R1–R13 are.** Seven of them had no queue row at all until this
section existed — which is R1's own failure class, and the review predicted it: *"The
lesson recurred as an instance of itself."*

**Kept deliberately compact per R12.** Detail lives in the review; this is the sequencing
ruling and the status, nothing else.

| R | what | ruling | status 2026-08-22 |
|---|---|---|---|
| R1 | Record layer ungated (R12 folded in) | **CLAIM HALF DONE; the staleness half is re-chartered** | `record-claim-fidelity` **accepted 2026-08-23** — five REVISE rounds, then SPLIT. Ships the `ux-picker` r3 detector (a record's claims observed against its frozen tree) plus ledger id uniqueness. **ADR ratification staleness, routing resolution and owning-table identity were RETIRED, not shipped** — each tried to observe facts that live in prose and each was defeated by an unwritten spelling; they are routed to `record-marker-schema`. Orchestrator sweep done `ba4304d`. **The declaration block is MANDATORY from 2026-08-24** — `mission-cadence`, "The declaration block" — so the gate now covers every packet whose diff touches executable content rather than only the one author who opted in. Its live coverage was one record until that line landed. **The `git-workflow` docs-are-executed correction landed the same day**, splitting the exclusion list into the two questions it had been answering with one command: which paths a packet must declare (unchanged), and whether a reviewed suite may be carried forward past a narrative commit (no, for `test:architecture` and `pnpm format`, which read narrative). `AGENTS.md` §6's restatement is corrected to match, so the two copies cannot drift. **Both were the orchestrator's obligations and both are now closed.** |
| R2 | Control verification missing | **running, not a PUR gate** — but PUR-1's charter must REQUIRE the gate; the measured convergence is 2 rounds with it vs 4–7 without | `expected-red-gate` at `b4c2767` |
| R3 | Two armed traps the template copies | — | **DONE**, `web-refusal-taxonomy` merge `0c08412` |
| R4 | Gate-invisible scope evaporates | **RULED 2026-08-22 by the user: sequencing devolves to THIS FILE.** The plan §1.1 now claims scope, architecture and completion only. Stage-gate evidence documents are NOT revived, so **every packet charter must name gate-invisible deliverables as explicit acceptance criteria** — that is now the only thing between declared scope and silent evaporation | **CLOSED.** Plan amended; `PUR-2`'s charter owes its read models as named acceptance criteria |
| R5 | Press-law gate makes a false claim | **BEFORE `PUR-2`.** §7.16 requires PUR-2 to prove the catalog is the exact active-release artifact; a fail-open press-law gate cannot hold that | `press-law-splice` **ACCEPTED on main at `c6418b6`; matrix `1ef547c`** |
| R6 | Browsable balance mispriced | — | **DONE**, `stock-balance-read-model` accepted |
| R7 | Every production policy gateway returns ALLOW | **smalls BEFORE `SAL-1`** (the review's own trigger, upheld). Noted: PUR-1 WILL declare purchasing permissions born unbound, so small (a) gets cheaper the earlier it lands | not started |
| R8 | Posting-error classification sniffs any `code` | **HARD PREREQUISITE OF `PUR-2`** — now satisfied | **DONE**, `posting-error-shape` accepted: integrated `a69e1af`, `FULL_MATRIX_PASS_SHA=107f6803`. The guard admits only `/^[0-9A-Z]{5}$/u`, so a foreign `code` keeps its own identity instead of becoming `INVENTORY_POSTING_STORAGE_REJECTED`. **The residue is routed, not closed:** a SQLSTATE-SHAPED foreign code (realistically `EPIPE`) is still admitted, shape cannot exclude it, and closure is provenance-based — owned by `posting-error-provenance` (`c6cce1c`), ruled not to block `PUR-2`. |
| R9 | Container pressure forges outcomes | **cheap half before any acceptance matrix we intend to trust.** Wrong outcomes, not slow ones. Currently moot — Docker does not start on this machine | not started |
| R10 | Version-cut hygiene + false comments | **comments: opportunistic, zero byte risk. Predicates: before a v6 cut, which PUR does not make** — delay | not started — **verified still live** at `protocol.ts:15`, `compiler.ts:1232`, `normalize.ts:2236` |
| R11 | Trust substrate is write-only | **delay to G4 chartering** (review's own ruling) | deferred |
| R13 | Batched smalls | **delay.** The lifecycle-precondition item is archive/restore-only (`component-registry.ts:1142` hardcodes the intent); PUR-1's release/cancel take the operation path ADR-0051 already settled. **Name it in PUR-1's charter as a trap not to copy** | not started | **UPDATED 2026-08-22 by `PUR-1`, and the delay ruling still holds but its premise has moved.** The lifecycle-precondition item is no longer only latent: `renderLifecycleForm` picks `record.archived ? 'restore' : 'archive'` and never consults the operation's precondition, so a RELEASED, CLOSED or CANCELLED purchase order renders "More actions -> Archive" and the press fails with `MODULE_OPERATION_PRECONDITION_REFUSED`. `PUR-1` did not fix it and did not inherit the pattern -- its four transitions take the ADR-0051 operation path and the command bar evaluates each precondition -- but mounting a guarded document is what makes this row OPERATOR-VISIBLE rather than structural. `Edit` is unaffected; `operationAvailableForRecord` does evaluate. The same defect already applies to `stock_count`, so this is a new instance rather than a new defect.

**Net: nothing hard-gates `PUR-1`.** `R8` and `R5` gate `PUR-2`; `R4` gates PUR-2's
chartering; `R7` gates `SAL-1`. Everything else delays with a reason stated above.

**R1's gate is built, SPLIT, and ACCEPTED — `record-claim-fidelity`, integrated `bcb8c40` on
2026-08-23.** `scripts/check-records.sh` plus
`test/architecture/record-claim-fidelity.test.ts` observe a packet record's claims against
its frozen tree — the declared head owned by that packet's own `Packet:` commit trailer,
every claimed path really different between base and head, every claimed symbol really
declared there, no undeclared executable path — plus ledger id uniqueness. Fifteen
diagnostics, fifteen controls, 16/16 per report site. See the
[packet record](packets/record-claim-fidelity.md) and the [ledger row](ledger.md).

**Rounds 1-5 all returned REVISE, and the fifth ruled the split.** ADR ratification
staleness, routing resolution and owning-table identity are **retired, not shipped**. Each
tried to observe facts that live in prose, and across four rounds each produced the same
finding shape: a reader walking past a spelling nobody had written a case for. Measured in
round 5 — `will be ratified after X is accepted` bound the wrong packet silently, and a
soft-wrapped `routed to` never entered the scanner at all. **A gate whose terminal state is
reached only by matching another finite list of English is not terminal**, which is round
4's convergence argument withdrawn under measurement.

**NEW ROW — `record-marker-schema`. Tier 1 for the record layer, and it owns what was
retired.** Give ADRs a machine-readable governing status and ratification packet
(frontmatter), and owning tables an explicit marker; then re-express the three retired
assertions against that schema rather than against English. Needs `docs/decisions/**`
across 58 files plus the inventories, so it is its own lease and its own packet.
**Filed here because R1's own lesson is that a recorded finding with no owning row is a
disposition with no executing gate** — and the cost of not doing it is explicit: **R1's
headline stale-ratification finding is ungated again.** The eleven live instances were
corrected under the orchestrator's bridge, so the tree is clean today; nothing stops the
twelfth.

**OWED TO THE ORCHESTRATOR, and neither is a lane decision.**

1. **`docs/**` is an executed gate input while `git-workflow` still excludes it as never
   executed.** Measured: a docs-only commit repointing the declared head to forty zeroes
   leaves the identical-tree command EMPTY while `test:architecture` REDS. The lane removed
   the false claim from its source and re-runs `test:architecture` rather than claiming
   carry-forward, but the general rule is doctrine and `.agents/skills/**` is fenced out of
   the charter. **Round 5 ruled that acceptance must not precede this correction.**
2. **Tier.** Chartered Behavioral; all four review arms rule Critical. Round 5 also ruled
   the out-of-sequence Fable arm the wrong process call — it counts as additional review,
   and a fresh Codex arm is owed before any confirm.

**One thing is flagged and not corrected**, because the bridge covers status lines only:
ADR-0034's *"What this ADR does not yet implement"* still defers the enforcement half
behind `G3-P5`, which the ledger also records as accepted, and `inventory-form-anatomy`
records building on *"ADR-0034's existing predicate carrier"*. Confirming that is a
measurement against `module-runtime-interpreter.ts`, and this gate reads the governing
status rather than the body.

**Still not built, and named so it does not rot:** the declaration block is **optional**.
Making it mandatory is a `mission-cadence` edit that belongs to the orchestrator and lands
after this gate, and until it does, a packet that declares nothing is checked against
nothing.

## Active queue — frozen rows only

Verbatim rows from the pre-freeze queue that sit on the critical path. Their history is
unchanged; every other row is in [current-plan-archive.md](current-plan-archive.md).
| # | Packet | Tier | Why here |
|---|---|---|---|
| 5g3-prog | **Major-correctness-domain program review for the inventory ledger** | Program review | **CONVERGED 2026-09-01 — two arms, both ADJUST; see [the record](program-reviews/2026-09-01-inventory-ledger.md).** **Created 2026-07-30. `G3-P3`'s re-review flagged this as now due; the orchestrator read the deferral text and rules it due after `G3-P5`, not now.** `G3-P2b-2.md:332-335` defers the major-new-correctness-domain trigger with a precise condition: it fires once *"the serializer, negative-stock evaluation, immutable fact, **and read reconstruction** compose."* Three of those four exist on main after `G3-P3` — the per-stock-identity serializer, negative-stock evaluated inside the posting transaction against serialized state, and the append-only movement fact. **The fourth does not**: read reconstruction is `onHand`, which is `G3-P5`. Firing the review now would examine a correctness domain with a write path and no read path, and the composition question — whether a balance reconstructed from posted movements agrees with what the ledger serialized — is the most valuable thing such a review can ask. **Scheduled after `G3-P5` is accepted and before `G3-P6b`'s agent journeys**, so the review's findings can still shape the write surfaces rather than arriving after them. Two-arm, both arms reading the composed path. **Seed questions, from what this program already learned the hard way:** does a balance computed as of an effective instant agree with the frozen same-instant tuple, given that `5g3-ord` records the tuple's final `movementId` branch as unobserved; can any cache serve a balance that never existed at any instant; and does the ledger's one-way-door set still hold once a read model can be rebuilt, since a rebuildable projection is the classic place a supposedly immutable fact gets quietly corrected. |
| 7 | Policy/identity kernel | Critical | **ALSO OWNS, routed 2026-07-29 from Q1-P3b's third review round:** policy narrowing plans are not validated against the selected query's **declared parameter IDs and types** before executor entry, so a plan could reference an undeclared parameter or relabel a declared one's type (admitting e.g. PostgreSQL `infinity`). **Adjudicated not material today and latent by construction:** the only production `CurrentPolicyGateway` implementations are `AllowAllLocalPolicy` (`composed-application-runtime.ts:402`) and `VerificationAllowPolicy` (`release-verification-service.ts:782`), both allow-all, so nothing in production contributes a narrowing plan and `parsePolicyNarrowing` sees only test input. Same shape as the recorded precondition field-locality defect — latent solely because the path that would reach it is closed. **It becomes reachable the moment this row lands**, which is why it lands here: the packet that first produces a real narrowing plan must ship the parameter-binding validation with it, not after. | **DEFERRED PAST G3 BY USER RULING 2026-07-28 — and this is a LAUNCH BLOCKER, not a backlog item.** Both program-review arms hard-gated this before G3; the user has consciously overridden that to compress the inventory timeline. **What the deferral means concretely:** inventory will work, and every principal in a tenant will hold every declared permission. The pilot is demonstrable *only when driven by the team* — **no login may be issued to anyone outside it until this lands**, because there is no such thing as a restricted user. Storage isolation (forced RLS, unprivileged runtime role) still holds between tenants; what is absent is authorization *within* one. **Re-evaluate the moment either of these becomes true:** a person outside the team needs access, or real business data enters the system. **Both program-review arms confirmed this is the whole security posture's missing half, and both hard-gated it before G3.** Storage isolation is strong and verified — forced RLS with tenant/environment predicates, an unprivileged runtime role that rejects smuggled identity, no destructive grants, no SQL-injection surface. Against that: every `CurrentPolicyGateway` in the tree returns ALLOW, and permission IDs compile into reference data that nothing ever evaluates, so within a tenant every principal currently holds every declared permission. RLS is defense in depth; it is not authorization. **Fold in three sub-items the review surfaced:** `module_storage_backfill_checkpoints` carries tenant columns but has no RLS while writable by the module role; migration 0010's principal check was dropped from the receipt INSERT policy and is compensated only in app code; and all policies are PERMISSIVE with no RESTRICTIVE kernel base, which was the team's own stated target. Also owns query-side denial evidence — `semantic-query-gateway.ts` has no `recordNonAccepted`, so a denied read leaves no persisted trace. **Demonstrate a real DENY through the composed app**, not a harness. The one kernel seam with **no owner** — see decisions below. After fan-out, before G3. **Bound by the accepted G2-EK1 expression kernel:** `PolicyDefinition` carries "narrowing conditions" (plan line 643) and §12.2 line 2338 claims policy narrowing for the Formula family, so the kernel's jurisdiction ruling applies here — otherwise a second condition format is born in the trust layer, the most expensive place to unify later. Narrowing may only restrict a live ALLOW and must fail closed; it can never grant, nor override the mandatory kernel predicates (archive exclusion, tenant/environment RLS, record identity, optimistic revision, authorization). **Consumes row 5's policy-predicate seam (competitive review D3):** narrowing lowers into the compiled `WHERE` clause through that seam and is never applied as a post-fetch filter, because post-filtering breaks pagination — the reason prior art rejected the same design. **Also owns the compile-time permission obligation (competitive review D4).** Today a module declares `permissionId`s that compile into reference data nothing evaluates; that state was reachable because our instruments **detect** missing enforcement rather than **prevent** it. Prior art's stronger pattern is to generate a hole that must be filled: an endpoint that ships without an authorization check does not compile. Our equivalent is a compiler rule — a declared permission with no evaluator binding fails the candidate, in the same shape as `validateModuleConformance`. Cheapest at four modules; a migration at forty. Land it with this packet so the rule and its first satisfier arrive together. |
| container-pressure-forges-outcomes | **Docker volume pressure produces a WRONG release-activation outcome, not a timeout** | Critical | **OPEN 2026-08-13, measured by `ux-picker` with a three-run discriminator.** `composed product activates through the kernel` failed with `composed release activation did not verify: NO_SWAP_TERMINAL` **on `ux-picker`'s merge AND on `main` alone at `b289911`** in a worktree carrying none of the packet — so it was pre-existing and not the merge. **Then it passed 16/16 on the same merged tree after reclaiming 27 leaked anonymous volumes and one orphaned `north-star-release-activation` container whose owner pid was dead.** Same code, same test, different Docker state. **This is a worse manifestation than the one `matrix-machine-decay` records.** That row's symptom is slowness and a 30-second container-readiness timeout — loud, and obviously environmental. This one produces a **definite, plausible-looking outcome code**: the kernel reports the release did not swap, which reads as a release-kernel defect rather than as machine state. **A lane hitting it will debug the activation path.** **Owed:** find why activation returns `NO_SWAP_TERMINAL` under container pressure rather than failing loudly, and whether any other gate can be pushed into a wrong-but-plausible verdict the same way. **`main` was red on this at `b289911` and nothing recorded it**, which is how it reached a second lane. Pairs with `leak-guard-orphan` — the orphaned container here had a dead owner, which is that row's exact claim. **THIRD RECURRENCE 2026-08-25, in `PUR-2a` round 6, and this one is the READINESS manifestation rather than the wrong-outcome one.** `release verification leaves an optional self-reference unset and terminates` failed in `test/postgres/module-runtime.test.ts` with `ephemeral PostgreSQL is ready inside its container but its published endpoint is unavailable: ECONNREFUSED 127.0.0.1:57556` — the container reports ready INSIDE itself while its published port refuses. Re-run in isolation under the same lock: **1/1 pass, same code, same tree.** It appeared as the 51st test of a whole-suite run and passed as the first of a scoped one, which is the same position-dependence `postgres-mutation-entries-need-an-isolable-subject` records. **Worth noting for whoever owns this row: the readiness form is the benign one** — it names the transport plainly instead of forging a plausible domain verdict — so the two manifestations differ in cost by a lot, and a fix that only addresses readiness would leave the expensive half open. **RECURRENCE 2026-08-14 in `form-wire-semantics` round 6:** the first browser blast-radius run returned the same `NO_SWAP_TERMINAL` immediately after another lane's PostgreSQL suite released the exclusive lock, while all 28 form-wire tests passed. Post-failure inspection found zero active containers, eight local volumes totalling 904.5 MB, 937 GB disk free and 6.5 GiB memory available; one exclusive retry from that quiet state passed 89/89. This is corroboration of the wrong-outcome class, not proof that volume count alone caused this recurrence. |
| purchasing-requires-inventory | **A release carrying Purchasing must carry Inventory, and nothing says so** | Behavioral | **OPEN 2026-08-22, found by `PUR-1` when `test:postgres` failed an unrelated ABI fixture.** `createManagedTable` calls `requiredLegalEntityMaster` for any `entityOwned` table and refuses with `LEGAL_ENTITY_MASTER_TARGET_INVALID: expected one compiled legal-entity master, received 0` when none is compiled -- and `legal_entity` is declared by the **Inventory** module. `PUR-1` classified both purchasing families `entityOwned` per the charter, so **Purchasing is now coupled to Inventory at the STORAGE layer**, not merely at the file layer where `LEGAL_ENTITY_FAMILY_MAP_V1` happens to live. Two fixtures that build "the composed application without Inventory" -- one in `surface-grammar-conformance.test.ts`, one in `module-storage-transition.test.ts` -- now strip Purchasing to stay valid, and **a third will appear.** Before `PUR-1` the without-Inventory composition had no entity-owned entity at all, so the check was never reached. The refusal is correct and fails closed; what is missing is that the coupling is nowhere declared, so each fixture discovers it as a red. Owed: either state the dependency where a reader will meet it, or move the legal-entity master out of the Inventory module -- the second is the same question the charter fenced when it forbade moving the family map, and it should be answered once rather than per module. |
| enum-option-widening-unplannable | **The v1 storage planner cannot add an option to an enum on an already-released field, and relaxing the fence alone diverges the contract from the database — OBSERVED** | Critical | **OPEN 2026-09-01, found by `PUR-2c` by testing its charter's stop condition before designing anything. Record: [packets/pur-2c.md](packets/pur-2c.md). Scope corrected at review rounds 2 and 3.** `lowerColumn` hashes `shapeFingerprint` over a record including `fieldType` **wholesale**, and an enum's `fieldType` carries its `options`, so any option-list change — a pure widening included — trips `COMPILER_STORAGE_RETYPE_UNSUPPORTED`. Measured on BOTH enums a goods-receipt family needs; the second sits behind an earlier `INVENTORY_CONTRACT_INVALID` from the compiler's conformance pins. **The diagnostic is misnamed — the physical type is `text` either way — but the obstacle is real and the obvious fix is unsafe. NOW OBSERVED END TO END against live PostgreSQL:** with only the retype fence bypassed, the widened release **compiles, prepares and ACTIVATES**, creates **no storage generation**, leaves the enum CHECK **unchanged at five options** (its physical name derives from the field id alone, so the planner's check loop skips it), and the newly compiled option is then **REJECTED by the live constraint** while an old option is accepted. **A proposed limit was tested and does not hold:** an option sorting FIRST — making it candidate verification's `enumOptionIds[0]` witness — **also activated**, and a post-activation census found one table with one five-option CHECK. **Why candidate verification does not catch this is UNDETERMINED and is part of the owed work.** **NOT yet Band A complete:** the probe is uncommitted, depends on a reverted compiler bypass, and of nine required assertions four are met, three partial and two unmet — the decisive gap being the **repair-before-measure** control. **OWED, as three GROUPS:** (1) **compiler and protocol semantics** — a monotonic-superset predicate, an explicit transition element, and PRESERVED refusals for narrowing, option removal, option-ID rebinding, physical-type changes and unrelated retypes (all four already pass against the throwaway predicate); (2) **provider, live-target, catalog, CANDIDATE RELEASE VERIFICATION and activation semantics** — idempotent same-name CHECK replacement, retry/recovery, catalog comparison that understands an intentional definition change, activation that cannot report conformance before the widened definition is physically present, and a determination of whether the verification miss is a gap or a scope limit; (3) **Band A PostgreSQL evidence** to the record's §2.4b assertion table, from a real previous release WITH EXISTING ROWS. **Consumer/adoption boundary:** `INVENTORY_POSTING_ROLES` is separately pinned in domain contracts and compiler conformance, so the packet must either prove a generic mechanism on a fixture and leave the real-consumer census to resumed `PUR-2c` (**the lane's recommendation**) or own those consumers end to end. **Its own charter, not a bridge**, on the `relation-requiredness-relaxation` precedent. **Blocks `PUR-2c` completely.** |
| posting-writer-coverage-is-declared-not-observed | **The writer-inventory gate proves a verifier EXISTS for each relation, never that it RAN** | Critical | **PROMOTED to the live queue 2026-09-01: `5g3-prog` R3, confirmed by the orchestrator — `validateWriterInventory` reads only `verifier.name` and its own comment says the run is unproven; blocks critical-path step 2; owned by `posting-kernel-admission`.** **OPEN 2026-08-26, found by `posting-writer-inventory`'s first review arm (F2).** The construction check compares a derived relation set against a registered relation set. It never resolves, invokes, or observes the verifier. **The original registrations carried arbitrary strings and one of them named `assertDraftTransaction`, a function that does not exist anywhere in the file** — shipped, and accepted by construction, which is what proved the strings decorative. Registrations now pass the verifier FUNCTION and read the id off the function object, so naming an absent verifier is a compile error; **that closes half of it.** What remains open is the Band-A "proxy satisfied while the fact does not hold" vector: a relation whose registered verifier is real but never executes on the path a given posting takes is still accepted. `AGENTS.md` §6 — *a gate must OBSERVE the fact it asserts, never a proxy; inferring from a declaration is a proxy.* **Owed:** per-posting runtime coverage — each read-back records the relations it actually observed, and before commit the posting compares that set against the relations this transaction actually wrote. **The strong form is measurable rather than declared:** every module-schema relation carrying a row with `xmin = txid_current()` was written by this transaction, so scanning them and requiring each to have been observed would close BOTH this row and the edge row above, without any compiler change. **It is a design change beyond that packet's charter and beyond one lane's judgement — cost per posting is the open question — so it is filed for a ruling rather than taken.**  **HALF CLOSED 2026-08-26, and the cost question is now MEASURED rather than open.** What a posting WRITES is now observed rather than declared: `pg_stat_xact_user_tables` gives the module-plane write set, and every relation in it must be in the derived inventory. **Measured: 4.5ms per snapshot on 20 relations one carrying 200k rows, FLAT in table size** because the counters are in memory; the `xmin = txid_current()` scan agreed exactly and cost **11x more at that trivial scale**, growing with the data — which is why the cheap one was taken. **A trap that would have made it wrong: those counters do NOT reset at transaction boundaries**, and this service borrows pooled connections, so the write set is a DELTA against a baseline taken inside the transaction. **An empty observation is a refusal**, because an observer that sees nothing passes everything. **STILL OPEN:** that a registered verifier actually RAN for the relation it is registered against. Observation proves the relation was written and is derived; it does not prove a read-back compared its columns. Owed: per-verifier coverage tokens compared against the observed write set. |
| posting-capability-version-has-three-encodings | **The posting capability version is encoded three times and nothing reconciles them** | Critical | **FIX-NOW per `5g3-prog` R1 (2026-09-01, verified by the orchestrator: provider 2, three encodings at 1, `hasValidCapabilityFacts` checks only `>= 1`); owned by `posting-kernel-admission`.** **OPEN 2026-08-31, measured by `PUR-2b` while bumping the constant it was chartered to bump.** `INVENTORY_POSTING_CAPABILITY_VERSION` is now **2** in `packages/postgres-provider/src/inventory-posting-service.ts`. `INVENTORY_CONTRACT_V1.capabilityVersion` in `packages/domain/src/inventory/contracts.ts` is **1**, and `packages/compiler/src/conformance.ts` pins it to that LITERAL through `expectInventoryLiteral(..., ['capabilityVersion'], 1)`. The inventory module definition's `capabilityRequirement.capabilityVersion` on `postingCapabilityId` is **1**, and `buildCapabilityFacts` is what carries it into a release manifest's `capabilityFacts`. **`hasValidCapabilityFacts` in `release-repository.ts` checks only `Number(fact.capabilityVersion) >= 1`, so a release that DECLARES it requires posting v1 while the provider IMPLEMENTS v2 passes every gate in the matrix.** **Measured in the shipped artifact, not inferred:** all ten releases in `apps/web/release/app.compiled.json` that declare the posting capability declare it at `capabilityVersion: 1`, the head release (`releaseRoot` `8476ba3f...`) included — so after `PUR-2b` the release the runtime loads says 1 while the provider implements 2. Nothing compares the declared requirement against the registered implementation at any layer: `validateRegistration` compares the registration to the provider constant, and the executor builds the registration FROM that constant, so the check is self-referential by construction. **The charter said the constant "is not persisted in any migration CHECK", which is true and was verified, but the charter's premise that all `capabilityVersion: 1` literals belong to other capabilities is FALSE** — a grep returns fourteen hits, three of which bind the posting capability. **A second question the round-1 reviewer raised, and it is prior to the first:** the three values may be serving more than one MEANING — an exact negotiated protocol version, a MINIMUM-compatible capability version, or a provider implementation/result-format version. `hasValidCapabilityFacts` treats the fact as a LOWER BOUND (`>= 1`) while `validateRegistration` compares for EXACT equality, so two of the encodings are already read under different rules. A future consumer could compare as exact what validation treats as a bound. Owed: decide what these values MEAN before deciding which is authoritative, then make the other two derive from it or be observed against it. `packages/domain/**` and `packages/compiler/**` were both outside `PUR-2b`'s lease, so this is filed rather than taken. |
| review-record-gate-covered-by-any-later-record | **`check-review-record.sh` reports a merge covered when NO record names its packet tip — any later packet's record closes it** | Critical | **OPEN 2026-09-01, measured by the orchestrator while integrating `PUR-2b`, and it is the exact vacuity the script's own comments claim to have removed.** `covered_by_record` covers a merge `M` when `M^2` — the packet tip the review read — is an ancestor of ANY recorded SHA. Every later packet's record sits on `main`, which contains `M`, which contains `M^2`. **So every record retroactively covers every earlier merge, forever.** **Measured, not reasoned:** `a69e1af` (`posting-error-shape`) has second parent `ee8dc0c27edb041969b91294c56c192d9155ef30`, and that SHA appears **nowhere** in `docs/execution/review-log.md` — `grep -F` returns nothing — yet the gate reports all 60 executable commits covered. It is covered by `ec76617` (PUR-2a's record) and now also by `b2575349` (PUR-2b's), neither of which reviewed it. **This is why `lanes.md`'s note that the gate 'already FAILS on `main` for three merges' no longer reproduces:** the claim was true when the `posting-writer-inventory` lane measured it, and it was closed not by anyone reviewing those merges but by the next packet writing its own row. **The script anticipated this shape and missed this path.** Its comments retire two earlier models, the first being *'does ANY record contain this commit'*, which *"main being linear, made one late record cover all history"*. The merge branch reintroduces exactly that through second-parent ancestry, and the self-test does not catch it because its controls assert only that records load and resolve. **THE FIX IS SMALL AND EXACT.** For a merge, the legitimate record is on the packet's own branch line: a SHA that both descends from `M^2` and is an ancestor of `M`. The only commits satisfying both are `M^2` and `M` themselves — so the condition collapses to **the recorded SHA must BE the second parent (or the merge)**, not merely have it as an ancestor. That still admits the `relation-requiredness-relaxation` case this file records, where writing the row produced `55e1f28` which then became the tip and the second parent. **Needs a negative control that would have failed here:** a merge whose tip is recorded nowhere must RED. `scripts/**` and `test/architecture/**`; not held by any live lane. |
| migration-range-encoded-in-a-test-title | **A test's own TITLE encodes the migration range, so every migration goes stale in two files at once** | Behavioral | **OPEN 2026-09-01, filed by the ORCHESTRATOR when DENYING `PUR-2b`'s bridge request.** `test/postgres/trust-substrate.test.ts:63` is titled *"migrations 0006-0022 upgrade accepted G1 and converge with the checked-in snapshot"* while its body asserts `0023`. **Advancing the digit is not a one-file edit**, and that is the whole point: `test/evidence/relation-requiredness-relaxation.expected-red.json` — an ACCEPTED packet's manifest — names that test by title TWICE, in `test.namePattern` and `kills[0].name`, and `measurePhase` asserts the pattern selects at least one test, so renaming the title alone reds `evidence:expected-red` with *the pattern or file selects nothing*. `check:expected-red` stays green either way, because validate mode reads the mutation SUBJECT and that entry's subject is migration `0022`, untouched — **so the two gates disagree, and only the one the lane was not running catches it.** **The bridge was DENIED, not deferred.** Verified by reading before ruling: the title does encode the range, the manifest does name it twice, and `grep -rn '0006-0022'` returns exactly those two sites outside `docs/`. Crossing into an accepted packet's manifest to advance one digit would have un-frozen a matrix-green candidate for a string that executes nothing, and Docker was down so the re-run could not have been paid anyway. **The durable fix is to DELETE the range from the title rather than advance it**, and to repoint both manifest strings at the range-free name — one crossing that ends the recurrence instead of one crossing per migration. **Same class as `press-law-splice-control-pinned-by-line-number`**: a coordinate that goes stale on every unrelated addition, and this is already its second occurrence. **Owner: whoever cuts migration `0024`**, which is the next packet that would otherwise pay the same toll. |

## Operating model

**THREE PARALLEL LANES ARE ACTIVE (2026-07-28).** See [lanes.md](lanes.md) for the binding path partition, the shared-file protocol, the serial-integration rule, and the mandatory report header. Writers cannot see each other, so that file is the only shared state — read it before starting or resuming any packet.

- The user drives Codex `gpt-5.6-sol` sessions and pastes their reports back.
- The assistant is **orchestrator + adjudicator**: it hands the user self-contained
  packet prompts, adjudicates review findings and lease-bridge requests by reading the
  code, and runs multi-model **debates** directly (it does not write product code).
- One packet at a time, user-selected, per `mission-cadence`. New Codex session per
  packet — every prompt reconstructs state from disk.
- Reviews follow `review-tiers` (fresh naive spawns, mandatory charter; **a round with zero production defects converges the review** — ruled 2026-09-01).
- Acceptance requires the **full CI matrix green at the integrated SHA** (not a
  packet-chosen subset) — the rule PR-1 put in force.

### Standing prioritization rule — user directive 2026-07-28 (binding)

**A working inventory module is the goal, as soon as possible.** Every packet
selection passes this filter, in order:

  1. **Does it help get inventory running?** If yes, it is a candidate.
  2. **If no — does it COST inventory?** This is the real test, and it is
     narrower than "is it inventory work". A packet costs inventory if it does
     any of:
       - **holds or contends for a lease** on a file an inventory-path packet
         needs;
       - **takes the full-matrix slot** ahead of an inventory lane;
       - **adds weight to the shared gates** every lane's matrix runs — a slow
         or flaky new test taxes the inventory lanes on every run, which is the
         subtle one; or
       - **consumes adjudication attention** while an inventory lane is stopped
         waiting on a ruling.
  3. **If it costs nothing on all four, run it concurrently.** An idle lane is
     waste, not safety.

**Two standing priorities make concurrency safe**, and they are what replace
idling: inventory lanes get the **matrix slot** first — a non-inventory lane
waits — and inventory-lane reports get **adjudicated** first, always.

**Corrected 2026-07-28, same day it was written.** The first draft said
non-inventory work should be *deferred* unless it faced a closing window. That
was over-corrected, as the user pointed out: the constraint is opportunity cost,
not subject matter, and where opportunity cost is genuinely zero, an idle lane
buys nothing. Authoring is fully parallel and only the matrix serializes, so a
fourth lane on disjoint paths is net positive. What the original draft got right
and is retained: an idle lane is **not itself a reason** to start something, so
the answer to "what can we run" is still a real cost check and not a scramble
for filler.

Applied the same day it was issued, retracting three orchestrator
recommendations: **row 9** (publish-path breadth envelope) and **row 8**
(capability cycle-time baseline) both fail step 1, and row 9's
baseline-cannot-be-reconstructed argument does not reach step 3 — the curve can
begin at any N. **Row 1c-a** (rule the platform tier) also fails: 1c is in
neither inventory chain, its own row records that no product path is affected,
and deciding it later is *better*, because a real posting-service case would
ground the Tier-B question that a hypothetical cannot.

The inventory chains are `4c → Q1-P3b → G3-P5` and
`1d → G3-P1b → G3-P2b → G3-P3`. When every downstream link is gated on a packet
in flight, the highest-value orchestrator action is **landing that packet and
pre-scoping its successor**, not opening a fourth lane.

## Standing lessons (why the queue looks like this)

- Every escaped defect so far was **a declared rule with no executing gate**. The fix is
  always the gate, not the instance: executable verification (PR-2), full-matrix acceptance
  (PR-1), executed-file reachability (PR-4b), `EXPLAIN` coverage (PR-6).
- Reviews are excellent at what their charter points them at and **structurally blind to
  everything else**. Four max-effort passes missed all twelve performance findings because
  no charter ever asked about plan quality. Vary the charter, not just the reviewer.
- Latent defects in accepted packets surface when a *later* packet exercises them
  (manifest version, monotonic clock, case-fold uniqueness, resolver authority). This is the
  one-real-module-before-fan-out discipline working as designed.
