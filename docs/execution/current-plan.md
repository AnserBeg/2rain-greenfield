# Current plan — active execution state

## OPERATING MODEL — rewritten 2026-09-04 by user ruling. Read this and stop reading.

`AGENTS.md` is the doctrine and it is now short. The rules that matter for this file:

1. **The BUILD agent owns a vertical end to end and integrates it itself on CI
   green when no review arm is owed** (corrected 2026-09-05); the user tests at each
   slice's "Test it yourself"; stops only on the STOP list (`AGENTS.md` §3).
   Verticals are never split for review size; parallelism is by dependency, not
   by file lease.
2. **CI green at the pushed SHA is the acceptance matrix.** No local matrix, no lock.
3. **One review arm, only when the Critical set is touched, production defects
   only.** Everything else ships on tests and the user's click-through.
4. **Pre-tenant mode** (ADR-0066): a refused storage transition is a re-baseline,
   not an enabler packet.
5. **Records are one page; rows are one line; the doctrine is frozen until
   2026-10-04.** A finding that blocks nothing is one line in
   [current-plan-archive.md](current-plan-archive.md), *Filed during the freeze*.
6. **Nobody is a relay.** The orchestrator is opened for three jobs — charter, the
   one Critical adjudication, stage-boundary review — and edits directly when open.
   The user pastes only a Critical review prompt and its verdict. Writers and
   reviewers read `docs/architecture/posting-kernel-guarantees.md`, not the records.

The 2026-09-01 QUEUE FREEZE and the previous operating model are in the archive; their
substance survives in the rules above.

**Selected 2026-09-15: RAIN-ORDER-ENTRY** — workspace interaction completion (owner charter after the product-parity audit) at executable `4f13c15508f51568e4e124ad1fd2e3a431dc4dae` on `packet/RAIN-ORDER-ENTRY` (PR #6), stacked on PR #5 at `3830f95`, over audited `35e3eaa1`: working Inventory destinations, role-eligible pickers and policy-aware quick create; pickers answer in place (ADR-0036 behaviour 7) without reloading the order; declared choice/derived/decimal controls in Tasks, receiving included; [draft handoff and test-it-yourself](packets/RAIN-ORDER-ENTRY.md). FORM-1..4/PAGING, editor F1/F2/F3 and Task P1/P2 preserved; fresh CI / same ONLINE reviewer / owner acceptance pending. BUILD stops at draft PR, no integration or deployment. PR #5 and its closed P1/P2 and retained demos remain the dependency.

## Where we are — 2026-09-04

| stage | state |
|---|---|
| G0, G1 | complete |
| G2 | complete in substance (party, catalog, location, composed app, forms, pickers) |
| G3 | inventory alpha: 14 of 17 gate criteria met (`rulings/g3-completion.md`); posting kernel hardened by `posting-kernel-admission` and `enum-widen` on 2026-09-04 |
| G4 | purchase order accepted; RECEIPT and scoped AUTH landed through PR #1 at `c30e951`; SALE order intent landed through PR #3 at `4c058aa`; SALE-FULFILLMENT landed through PR #4 at `44bef7a`, Critical arm closed and all seven CI jobs green. No production-authentication claim |
| G5–G8, N1–N7 | not started; no agent package, no customization engine |

Plan §13: 21 of 38 work packages done. The office-worker loop — receive and ship — is
the near-term end. Everything below is ordered toward it.

## The critical path — 2026-09-04

**RECEIPT/AUTH bridge result (2026-09-05):** RECEIPT and the scoped AUTH evaluator/bindings landed together through PR #1 at `c30e951` by owner-authorized integration. No final independent approval was reissued, and local-demo authorization is not a claim of production authentication. The former pending wording is therefore not a dependency blocker for SALE. [Owner coordination](https://github.com/AnserBeg/2rain-greenfield/pull/1#issuecomment-5549264574).

The landed tree includes exact AUTH correction `9d70c749752006ab21d1b9df9516b1cb7b491df3`; accepted-through-0024, AUTH 0025 and RECEIPT 0026/0027 remain stable. This records the actual integration baseline, not an independent approval or production-authentication claim.

| step | vertical | lane | contents | review |
|---|---|---|---|---|
| 1 | **RECEIPT** | BUILD | landed through PR #1 at `c30e951` with scoped AUTH by owner-authorized integration; limitations above remain explicit | no new approval inferred |
| 2 | **SALE-FULFILLMENT** | — | **integrated at `44bef7a` (PR #4)**, reviewed candidate `d8f8d64`: exact reserve/release, partial shipment posting, correction/reversal, safe cancellation/closure, derived stock/order progress and exact-parent packing document | done — Critical arm closed; hosted run `34643875446` attempt 2 passed all seven jobs |
| 3 | **AUTH** | BUILD | scoped evaluator/bindings landed at `c30e951`; production authentication and remaining hardening stay separate future scope, not a SALE dependency | one arm only if trust substrate changes |
| 4 | **AGENT** | BUILD | plan §13 A-01..A-03 over the loop above | one arm if it writes through the posting kernel |
| ∥ | SUPPORT | SUPPORT | program reviews at stage boundaries; rulings; the `first-tenant` ruling when it comes; small correctives on paths BUILD does not hold | — |

Rows that still decide whether a CI result can be trusted stay visible below:
`container-pressure-forges-outcomes` (moot under CI runners),
`review-record-gate-covered-by-any-later-record`. Owned-by-step rows:
`purchasing-requires-inventory`, `posting-writer-coverage-is-declared-not-observed`
(closed by `posting-kernel-admission`; row retained one cycle), `7` (step 3).

**Retired from the path on 2026-09-04:** `posted-stock-honesty` as a separate packet (folded
into RECEIPT); `PUR-2 remainder` as a separate packet (folded into RECEIPT); `SAL-1`/`SAL-2`
as two packets (one SALE vertical); the PUR-2c re-charter (its scope is RECEIPT's first
half; its record and stop remain the source for the enum measurement).

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
| R7 | Every production policy gateway returns ALLOW | the SALE dependency is satisfied by the scoped evaluator/bindings landed at `c30e951`; production authentication remains outside this claim | **dependency closed for SALE through PR #1; no production-authentication claim** |
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
| posting-capability-version-has-three-encodings | **CLOSED 2026-09-04 by `posting-kernel-admission`** (merge `ab2c569`): each verifier now mints a coverage token from the `tableoid` of a row it actually read, and before commit the executed set is compared EXACTLY with the observed write set in both directions, through no code the verifiers share. The survivor this row named — delete a verifier CALL with its registration intact — is the packet's first control and reds naming the relation. **Its declared limit, unchanged:** a token proves a row was READ, not that the verifier's comparisons ran. **The posting capability version is encoded three times and nothing reconciles them** | Critical | **FIX-NOW per `5g3-prog` R1 (2026-09-01, verified by the orchestrator: provider 2, three encodings at 1, `hasValidCapabilityFacts` checks only `>= 1`); owned by `posting-kernel-admission`.** **OPEN 2026-08-31, measured by `PUR-2b` while bumping the constant it was chartered to bump.** `INVENTORY_POSTING_CAPABILITY_VERSION` is now **2** in `packages/postgres-provider/src/inventory-posting-service.ts`. `INVENTORY_CONTRACT_V1.capabilityVersion` in `packages/domain/src/inventory/contracts.ts` is **1**, and `packages/compiler/src/conformance.ts` pins it to that LITERAL through `expectInventoryLiteral(..., ['capabilityVersion'], 1)`. The inventory module definition's `capabilityRequirement.capabilityVersion` on `postingCapabilityId` is **1**, and `buildCapabilityFacts` is what carries it into a release manifest's `capabilityFacts`. **`hasValidCapabilityFacts` in `release-repository.ts` checks only `Number(fact.capabilityVersion) >= 1`, so a release that DECLARES it requires posting v1 while the provider IMPLEMENTS v2 passes every gate in the matrix.** **Measured in the shipped artifact, not inferred:** all ten releases in `apps/web/release/app.compiled.json` that declare the posting capability declare it at `capabilityVersion: 1`, the head release (`releaseRoot` `8476ba3f...`) included — so after `PUR-2b` the release the runtime loads says 1 while the provider implements 2. Nothing compares the declared requirement against the registered implementation at any layer: `validateRegistration` compares the registration to the provider constant, and the executor builds the registration FROM that constant, so the check is self-referential by construction. **The charter said the constant "is not persisted in any migration CHECK", which is true and was verified, but the charter's premise that all `capabilityVersion: 1` literals belong to other capabilities is FALSE** — a grep returns fourteen hits, three of which bind the posting capability. **A second question the round-1 reviewer raised, and it is prior to the first:** the three values may be serving more than one MEANING — an exact negotiated protocol version, a MINIMUM-compatible capability version, or a provider implementation/result-format version. `hasValidCapabilityFacts` treats the fact as a LOWER BOUND (`>= 1`) while `validateRegistration` compares for EXACT equality, so two of the encodings are already read under different rules. A future consumer could compare as exact what validation treats as a bound. Owed: decide what these values MEAN before deciding which is authoritative, then make the other two derive from it or be observed against it. `packages/domain/**` and `packages/compiler/**` were both outside `PUR-2b`'s lease, so this is filed rather than taken. |
| review-record-gate-covered-by-any-later-record | **CLOSED 2026-09-04 by `posting-kernel-admission`** (merge `ab2c569`): `INVENTORY_CONTRACT_V1.capabilityVersion` is the one authority — the module definition reads it, the provider imports it, and the compiler cell no longer spells a second number; a release whose declared capability fact differs from the registered provider version is refused on entry to `#post`, ahead of the stored-receipt lookup, so no path returns without the check. The MEANING question this row raised is answered: exact, because ADR-0063 decision 3 makes it a major version with no minor axis. `hasValidCapabilityFacts` stays a shape check, with the measured reason recorded at the site. **`check-review-record.sh` reports a merge covered when NO record names its packet tip — any later packet's record closes it** | Critical | **OPEN 2026-09-01, measured by the orchestrator while integrating `PUR-2b`, and it is the exact vacuity the script's own comments claim to have removed.** `covered_by_record` covers a merge `M` when `M^2` — the packet tip the review read — is an ancestor of ANY recorded SHA. Every later packet's record sits on `main`, which contains `M`, which contains `M^2`. **So every record retroactively covers every earlier merge, forever.** **Measured, not reasoned:** `a69e1af` (`posting-error-shape`) has second parent `ee8dc0c27edb041969b91294c56c192d9155ef30`, and that SHA appears **nowhere** in `docs/execution/review-log.md` — `grep -F` returns nothing — yet the gate reports all 60 executable commits covered. It is covered by `ec76617` (PUR-2a's record) and now also by `b2575349` (PUR-2b's), neither of which reviewed it. **This is why `lanes.md`'s note that the gate 'already FAILS on `main` for three merges' no longer reproduces:** the claim was true when the `posting-writer-inventory` lane measured it, and it was closed not by anyone reviewing those merges but by the next packet writing its own row. **The script anticipated this shape and missed this path.** Its comments retire two earlier models, the first being *'does ANY record contain this commit'*, which *"main being linear, made one late record cover all history"*. The merge branch reintroduces exactly that through second-parent ancestry, and the self-test does not catch it because its controls assert only that records load and resolve. **THE FIX IS SMALL AND EXACT.** For a merge, the legitimate record is on the packet's own branch line: a SHA that both descends from `M^2` and is an ancestor of `M`. The only commits satisfying both are `M^2` and `M` themselves — so the condition collapses to **the recorded SHA must BE the second parent (or the merge)**, not merely have it as an ancestor. That still admits the `relation-requiredness-relaxation` case this file records, where writing the row produced `55e1f28` which then became the tip and the second parent. **Needs a negative control that would have failed here:** a merge whose tip is recorded nowhere must RED. `scripts/**` and `test/architecture/**`; not held by any live lane. |
| migration-range-encoded-in-a-test-title | **A test's own TITLE encodes the migration range, so every migration goes stale in two files at once** | Behavioral | **OPEN 2026-09-01, filed by the ORCHESTRATOR when DENYING `PUR-2b`'s bridge request.** `test/postgres/trust-substrate.test.ts:63` is titled *"migrations 0006-0022 upgrade accepted G1 and converge with the checked-in snapshot"* while its body asserts `0023`. **Advancing the digit is not a one-file edit**, and that is the whole point: `test/evidence/relation-requiredness-relaxation.expected-red.json` — an ACCEPTED packet's manifest — names that test by title TWICE, in `test.namePattern` and `kills[0].name`, and `measurePhase` asserts the pattern selects at least one test, so renaming the title alone reds `evidence:expected-red` with *the pattern or file selects nothing*. `check:expected-red` stays green either way, because validate mode reads the mutation SUBJECT and that entry's subject is migration `0022`, untouched — **so the two gates disagree, and only the one the lane was not running catches it.** **The bridge was DENIED, not deferred.** Verified by reading before ruling: the title does encode the range, the manifest does name it twice, and `grep -rn '0006-0022'` returns exactly those two sites outside `docs/`. Crossing into an accepted packet's manifest to advance one digit would have un-frozen a matrix-green candidate for a string that executes nothing, and Docker was down so the re-run could not have been paid anyway. **The durable fix is to DELETE the range from the title rather than advance it**, and to repoint both manifest strings at the range-free name — one crossing that ends the recurrence instead of one crossing per migration. **Same class as `press-law-splice-control-pinned-by-line-number`**: a coordinate that goes stale on every unrelated addition, and this is already its second occurrence. **Owner: whoever cuts migration `0024`**, which is the next packet that would otherwise pay the same toll. |

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
