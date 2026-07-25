# Current plan — active execution state

**Read this after AGENTS.md and before proposing or running any packet.** It is the
narrative companion to `ledger.md`: the ledger records what each packet *was*, this
records what we are doing *next* and *why*. Update it whenever the queue changes;
delete rows once they are accepted and recorded in the ledger.

Last updated: 2026-07-24, at `main` = `d1ab76b`.

## Operating model

- The user drives Codex `gpt-5.6-sol` sessions and pastes their reports back.
- The assistant is **orchestrator + adjudicator**: it hands the user self-contained
  packet prompts, adjudicates review findings and lease-bridge requests by reading the
  code, and runs multi-model **debates** directly (it does not write product code).
- One packet at a time, user-selected, per `mission-cadence`. New Codex session per
  packet — every prompt reconstructs state from disk.
- Reviews follow `review-tiers` (fresh naive spawns, mandatory charter, two-REVISE cap).
- Acceptance requires the **full CI matrix green at the integrated SHA** (not a
  packet-chosen subset) — the rule PR-1 put in force.

## Where we are

| Stage | State |
|---|---|
| G0 | COMPLETE (no stage-gate evidence doc — tracked debt) |
| G1 | COMPLETE — release kernel, compiler, pinning, gateways, surface shell |
| G2 | IN PROGRESS |

Accepted in G2: `G2-P0` (stage cut) · `G2-P1` (trust substrate) · `G2-P2a/b/c`
(**Freeze F ratified** — compiled module storage, materializer, generic Q0/O0 runtime) ·
`G2-P3a` (generic surface↔gateway data binding) · `G2-P3c` (resolver authority,
language v2) · `G2-P3b` **Party — first real walking slice, Freeze G established**.

Then a whole-app **program review** (2026-07-24, dual max-effort) produced three
correctives, all accepted: `PR-1` (gate integrity) · `PR-2` (semantic preservation —
executable verification, archive-restrict, enum contracts, typed errors) · `PR-3`
(operation mediation — confirmation grants, classification, invocation evidence,
idempotency).

**Not yet started:** the Catalog/Location fan-out, and everything after.

## Active queue

Ordered. Each row names its source and why it holds its slot.

| # | Packet | Tier | Why here |
|---|---|---|---|
| 1 | **PR-4 — gate completeness round 2 + coverage audit** | Mechanical | Four `test:*` scripts still carry the unquoted-glob bug PR-1 fixed in one place; two compiler-artifact staleness guards run in no CI job. Must precede PR-5/PR-6 so their "full matrix" is honest. Adds the structural gate: **every test file must be reachable from a CI command.** |
| 2 | **PR-5 — idempotency scope** | Critical | Correctness defect in accepted PR-3: receipt PK includes `principal_id`/`release_id`, so a retry from another principal or after an activation **re-executes**. Recoverable today; **fatal at G3** (double-post). |
| 3 | **PR-6 — index coverage + request-path SLOs** | Critical | Relations get no index; the search index is a raw btree that cannot serve `fold(col) LIKE '%x%'`; advisory resolve keys have no folded index. Every fan-out module inherits these. Adds an **`EXPLAIN` conformance probe** (fail on Seq Scan over a module table) and `runtime-slos.md`. |
| 4 | G2-P4 — surface-grammar conformance | Behavioral | Roadmap resumes. Narrowed by G2-P3a to the pure conformance suite. |
| 5 | G2-P5 — shared table behavior + Q0 envelope | Critical | Paging/truncation/cursor, saved filters, shape-specialized SQL. |
| 6 | `adding-a-module` skill | Mechanical | Written against the proven Freeze G template; the fan-out consumes it. |
| 7 | Catalog (G2-P6) → Location (G2-P7) | Critical | **Catalog is the factory test: acceptance requires ZERO press changes.** If it needs one, stop and harden before Location. |
| 8 | PR-7 — provider hot path | Behavioral | Release-load cache (flagged by two independent reviews), relation N+1, round-trip reduction, advisory-lock namespacing. Before G3. |
| 9 | Policy/identity kernel | Critical | The one kernel seam with **no owner** — see decisions below. After fan-out, before G3. |
| 10 | G2-P8 import → G2-P9 stage gate | — | Completes G2. |

## Plan-level decisions pending before G3

These are **not code work**. They change the storage model or the launch scope, so they
are cheapest to decide before inventory exists. Recommended as one focused debate
(they are entangled), run by the orchestrator.

1. **Erasure / data-subject rights.** No-hard-delete + additive-only + append-only trust
   facts + one shared database currently has **no erasure path**. Raised independently by
   two external reviews. Crypto-shredding (per-subject key, delete the key) is the standard
   answer and changes the storage model. Potential launch blocker in EU jurisdictions.
2. **Temporal semantics.** Bitemporality/effective-dating (prices, costs, FX, BOM versions,
   as-of reporting) *and* timezone/business-day authority (what "a day" means for a tenant).
   One topic, not two. G3 designs backdated postings and as-of balances against whatever is
   decided; deciding late means rewriting inventory read models.
3. **Inventory valuation + accounting handoff.** "What is my stock worth" is currently
   unanswerable until N3. Adjacent to accounting, not identical. Pairs with defining the
   accounting export/handoff contract before pilots.
4. **Identity/policy kernel ownership.** `CurrentPolicyGateway` and `AuthenticateRequest`
   are well-designed deny-capable ports whose only implementations are allow-all stubs.
   Every module declares `permissionId`s that nothing evaluates. Plan §13 has no work-package
   ID for identity/roles/policy, and it had no `doctrine-coverage.md` row until PR-4.

## Review sources feeding this queue

| Review | Where | Status |
|---|---|---|
| Whole-app program review (dual max-effort, converged) | `docs/execution/program-reviews/2026-07-24-g2-p3-party/` | Archived; produced PR-1/2/3 |
| External design review — 7 derived-decision problems | [request](program-reviews/2026-07-24-external-design-review/request.md); [review](program-reviews/2026-07-24-external-design-review/review.md) | Archived |
| External performance/scaling review — F1–F12 | [review](program-reviews/2026-07-24-external-performance-scaling/review.md) | Archived |
| External architecture review — 7 findings | [review](program-reviews/2026-07-24-external-architecture/review.md) | Archived |

### Findings inventory (dispositioned)

**Acted on / queued** — idempotency scope (PR-5) · index coverage F1–F3 (PR-6) ·
release-load cache F4 + relation N+1 F5 + round trips F6–F10 + advisory-lock namespace
F12 (PR-7) · glob/CI blind spots (PR-4) · identity-policy coverage row (PR-4).

**Routed to owning packets** — RLS policies must be `RESTRICTIVE` with one kernel-owned
permissive base (policy kernel packet) · movements table partitioned by `(tenant, period)`
**from creation**, TigerBeetle-shaped two-phase reservation, anchor row as *derived cache
with a proof obligation*, natural-key idempotency `(source_type, source_id, source_line,
revision, posting_role)` (G3) · coexistence horizon / release lease to make tightening debt
collectible (cleanup family) · signed approval→root, superuser-owned DDL event-trigger
witness, unknown-kind blocks *activation* not *serving*, `indisvalid` in declared shape,
step-receipt in the same transaction as its DDL (next materializer packet) · mutation
testing, concurrent probes, canary tokens for absence invariants (conformance suite) ·
opaque resolver handles + gateway-enforced confirmation binding, or the agent re-creates
auto-select one layer up (agent packet) · approval-diff renderer treated as a security
control (G6) · PITR restore must replay materialization to the union of live roots ·
rollback conformance scenario (the pointer-swap rollback story is currently untold).

**Tracked debt (documentation)** — see the owned
[documentation-debt register](documentation-debt.md) for the missing artifact, why it
matters, and the condition that closes each obligation.

## Standing lessons (why the queue looks like this)

- Every escaped defect so far was **a declared rule with no executing gate**. The fix is
  always the gate, not the instance: executable verification (PR-2), full-matrix acceptance
  (PR-1), every-test-reachable (PR-4), `EXPLAIN` coverage (PR-6).
- Reviews are excellent at what their charter points them at and **structurally blind to
  everything else**. Four max-effort passes missed all twelve performance findings because
  no charter ever asked about plan quality. Vary the charter, not just the reviewer.
- Latent defects in accepted packets surface when a *later* packet exercises them
  (manifest version, monotonic clock, case-fold uniqueness, resolver authority). This is the
  one-real-module-before-fan-out discipline working as designed.
