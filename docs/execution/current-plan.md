# Current plan — active execution state

**Read this after AGENTS.md and before proposing or running any packet.** It is the
narrative companion to `ledger.md`: the ledger records what each packet *was*, this
records what we are doing *next* and *why*. Update it whenever the queue changes;
delete rows once they are accepted and recorded in the ledger.

Last updated: 2026-07-25, at `main` = `79d38be`.

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

`PR-6` (**relation index coverage** — additive `relation` index kind, forced-RLS `EXPLAIN` probe requiring the index by name, and `runtime-slos.md`) is accepted, as is `PR-6b` (**folded-column index mechanics** — stored C-collated generated folds make forced-RLS resolve and unique lookup use their declared indexes; the useless raw-column `search` btree is retired; the fold function refuses replacement rather than healing before measurement).

Two gate-completeness correctives followed, both accepted: `PR-4` (quoted globs, the
two orphaned compiled-shell guards wired, doctrine/debt coverage, external reviews
archived) · `PR-4b` (**executed-file reachability** — every test file must be observed
running in the current run, evidence bound to one run token and the reporter's observed
argv; static CI-selection inference is gone) · `PR-5` (**idempotency scope** — durable
receipt identity narrowed across primary key, lookup, advisory lock, and RLS; a retry
after an activation, a recompile, or from another principal no longer re-executes, and
migration 0010 refuses rather than rewriting immutable receipts).

**`G2-P6` Catalog is accepted — and it was authored with ZERO press changes.** One
377-line declarative definition plus test scaffolding produced a complete module: no
file under `packages/compiler`, `canonical-model`, `postgres-provider`, `runtime`,
`platform-runtime`, `dev-tooling`, `apps/web/src`, or `db/migrations` was touched.
This is the first module authored against an already-built platform, and it validates
the north-star claim that a module is data, not code.

**Not yet started:** Location (G2-P7), and everything after.

## Active queue

Ordered. Each row names its source and why it holds its slot.

| # | Packet | Tier | Why here |
|---|---|---|---|
| 1 | **Prefix search semantics + range lowering** | Critical | Descoped from PR-6b by orchestrator ruling after its round-2 review. Verdict R3's leakproof range lowering measured 89.7 ms → 0.31 ms and is still wanted, but it surfaced a semantic-preservation question that is a design decision, not an index optimization: substring mode concatenates the parameter **unescaped** (`module-runtime-interpreter.ts:929`), so `%` and `_` are wildcards today, while literal range lowering treats them as characters. Shipping both would leave two search modes with divergent escaping and silently change prefix behaviour on a compiled query contract. Needs PR-2-style semantic-preservation evidence and an explicit decision on whether search input is literal text or a user-visible pattern. |
| 2 | **Materializer — data-affecting DDL on existing tables** | Critical | PR-6 proved `createIndex` on a pre-existing table classifies as `deferredOnlineFamily`, which the materializer never processes; there is no `CONCURRENTLY` path in the repository. **Not a fan-out blocker** — new modules are born with their indexes and folded columns (`samePlan` → `preApprovalInert`), and every test materializes from scratch. It blocks only in-place upgrade of a *pre-existing deployment*, of which there are none, so it is a pre-launch concern rather than a G2 one. Orchestrator ruling: build the plain locking DDL path with the blocking window recorded and a numeric promotion trigger — `CONCURRENTLY` does not help the `ADD COLUMN … GENERATED … STORED` rewrite anyway, and carving a non-transactional exception into a runner whose transaction ownership is gated is a cost to pay when a customer cannot take a window. Absorbs the two findings already routed here: `indisvalid` in declared shape, and step-receipt in the same transaction as its DDL. **Also absorbs two residuals dispositioned out of PR-6b at its E4 terminus:** (a) in `executeApprovedAttempt()` the claim DML runs before the fold-function body check, so `ATTEMPT_CLAIM_MISMATCH` can surface before `CASE_FOLD_FUNCTION_DEFINITION_MISMATCH` — materialization still fails, so this is error specificity and negative-control coverage, not a false green; (b) an out-of-band `CREATE OR REPLACE` between materializations is detected at the next one but not prevented in the interim, which the superuser-owned DDL event-trigger witness above closes. |
| 3 | G2-P4 — surface-grammar conformance | Behavioral | Roadmap resumes. Narrowed by G2-P3a to the pure conformance suite. |
| 4 | G2-P5 — shared table behavior + Q0 envelope | Critical | Paging/truncation/cursor, saved filters, shape-specialized SQL. |
| 5 | `adding-a-module` skill | Mechanical | Written against the proven Freeze G template; the fan-out consumes it. |
| 6 | **Q1 compositional query tier** | Critical | **G3-blocking**, per verdict S2: G3's correctness contract is `SUM(posted movement.quantity_delta)`, so without Q1 the inventory stage hand-rolls aggregation against ADR-0011's grain. The plan already specifies the tier (§5.1, §5.9, §9.2.2) — filters, traversal, joins, grouping, aggregates, reports, exports over semantic entities. Today the gateway rejects every tier above Q0 and every filter other than literal `true`. Placed after the fan-out so it is designed against three real modules. Also the answer to "can the agent analyse data" — see verdict R8/R9. |
| 7 | PR-7 — provider hot path | Behavioral | Release-load cache (flagged by two independent reviews), relation N+1, round-trip reduction, advisory-lock namespacing. Before G3. |
| 8 | Policy/identity kernel | Critical | The one kernel seam with **no owner** — see decisions below. After fan-out, before G3. |
| 9 | G2-P8 import → G2-P9 stage gate | — | Completes G2. |

## Settled by debate (2026-07-25)

The [RLS index-access debate](debates/pr6-rls-index-access-verdict.md) is CLOSED and
binding. Ratified: stored generated folded columns as the index mechanism; advisory
resolve keys covered, not just unique business keys; prefix search lowered to
leakproof range quals; unanchored substring stays a bounded partition scan whose cost
is invariant in tenant count. Rejected: `LEAKPROOF` marking (superuser + silent
`CREATE OR REPLACE` reversion), schema-per-tenant (measured to die at 1,000-2,000
tenants), agent-written SQL and SQL-over-emitted-views (ADR-0009 stands). End-state
topology is pooled pods with whale tenants tiered — **no decision needed now, shard
count of one is today**. Aggregation is **Q1**, already specified by plan §5.1/§5.9/
§9.2.2, and it **must exist before G3** because G3's on-hand is itself an aggregate.

## Plan-level decisions pending before G3

These are **not code work**. They change the storage model or the launch scope, so they
are cheapest to decide before inventory exists. Recommended as one focused debate
(they are entangled), run by the orchestrator.

1. **Erasure / data-subject rights.** No-hard-delete + additive-only + append-only trust
   facts + one shared database currently has **no erasure path**. Raised independently by
   two external reviews. Crypto-shredding (per-subject key, delete the key) is the standard
   answer and changes the storage model. The debate removed the `DROP SCHEMA` escape:
   schema-per-tenant relocates only module tables, leaving release, trust, audit,
   outbox and receipt rows shared. Potential launch blocker in EU jurisdictions.
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
permissive base, plus restoring the `principal_id` `WITH CHECK` that PR-5's migration 0010
dropped from the receipt INSERT policy where only SELECT needed widening (policy kernel packet) · movements table partitioned by `(tenant, period)`
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
  (PR-1), executed-file reachability (PR-4b), `EXPLAIN` coverage (PR-6).
- Reviews are excellent at what their charter points them at and **structurally blind to
  everything else**. Four max-effort passes missed all twelve performance findings because
  no charter ever asked about plan quality. Vary the charter, not just the reviewer.
- Latent defects in accepted packets surface when a *later* packet exercises them
  (manifest version, monotonic clock, case-fold uniqueness, resolver authority). This is the
  one-real-module-before-fan-out discipline working as designed.
