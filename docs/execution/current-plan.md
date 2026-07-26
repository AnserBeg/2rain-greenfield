# Current plan — active execution state

**Read this after AGENTS.md and before proposing or running any packet.** It is the
narrative companion to `ledger.md`: the ledger records what each packet *was*, this
records what we are doing *next* and *why*. Update it whenever the queue changes;
delete rows once they are accepted and recorded in the ledger.

Last updated: 2026-07-26, at `main` = `70df4b8`.

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

**`G2-P7` Location is accepted — also ZERO press changes.** Two consecutive modules
authored against an already-built platform with no press edit. The fan-out's second data
point is honestly the weaker one: the typed-unsupported hierarchy seam and its only
natural relation were descoped after the factory test found a real press limit, so
Location proves per-tenant code uniqueness and exact-code resolution but not relation
access.

**`G2-EK1` Expression kernel is accepted** — ADR-0012 ratifies the ceiling (total, terminating, no loops, no operation invocation, depth ≤ 24), position profiles across five execution targets, SQL admissibility as cost classes, and one owned evaluator per target. The triplicated trivial-predicate fence is converged onto one strict version-dispatched canonical-model entry point. Two rulings land downstream: a **formula/rule projection family IS required**, so queue row 3 now carries two families on one v3 bump; and search input is **literal text**, not a wildcard pattern, which unblocks and specifies row 2.

**Not yet started:** G2-P8 import, and everything after.

## Active queue

Ordered. Each row names its source and why it holds its slot.

| # | Packet | Tier | Why here |
|---|---|---|---|
| 1 | **Materializer — data-affecting DDL on existing tables** | Critical | PR-6 proved `createIndex` on a pre-existing table classifies as `deferredOnlineFamily`, which the materializer never processes; there is no `CONCURRENTLY` path in the repository. **Not a fan-out blocker** — new modules are born with their indexes and folded columns (`samePlan` → `preApprovalInert`), and every test materializes from scratch. It blocks only in-place upgrade of a *pre-existing deployment*, of which there are none, so it is a pre-launch concern rather than a G2 one. Orchestrator ruling: build the plain locking DDL path with the blocking window recorded and a numeric promotion trigger — `CONCURRENTLY` does not help the `ADD COLUMN … GENERATED … STORED` rewrite anyway, and carving a non-transactional exception into a runner whose transaction ownership is gated is a cost to pay when a customer cannot take a window. Absorbs the two findings already routed here: `indisvalid` in declared shape, and step-receipt in the same transaction as its DDL. **Also absorbs two residuals dispositioned out of PR-6b at its E4 terminus:** (a) in `executeApprovedAttempt()` the claim DML runs before the fold-function body check, so `ATTEMPT_CLAIM_MISMATCH` can surface before `CASE_FOLD_FUNCTION_DEFINITION_MISMATCH` — materialization still fails, so this is error specificity and negative-control coverage, not a false green; (b) an out-of-band `CREATE OR REPLACE` between materializations is detected at the next one but not prevented in the interim, which the superuser-owned DDL event-trigger witness above closes. Independent of the expression work; holds this slot because it is unblocked and pre-launch. |
| 2 | **Prefix search semantics + range lowering** | Critical | Descoped from PR-6b by orchestrator ruling after its round-2 review. Verdict R3's leakproof range lowering measured 89.7 ms → 0.31 ms and is still wanted, but it surfaced a semantic-preservation question that is a design decision, not an index optimization: substring mode concatenates the parameter **unescaped** (`module-runtime-interpreter.ts:929`), so `%` and `_` are wildcards today, while literal range lowering treats them as characters. Shipping both would leave two search modes with divergent escaping and silently change prefix behaviour on a compiled query contract. Needs PR-2-style semantic-preservation evidence. **Jurisdiction split by the slot-4 ratification rider:** the *semantic* ruling — whether search input is literal text or a user-visible pattern — is an expression-surface decision and belongs to the expression-kernel ADR, not here. This slot retains the range-lowering implementation and its semantic-preservation evidence, executed **against** that ruling rather than deciding it. If slot 2 is taken before slot 4, it must stop at the semantic question and surface it. |
| 3 | **v3 canonical language evolution — capability disclosure family + kernel structure** | Critical | **Created 2026-07-26 by the G2-P7a stop.** The former row 1 (capability support-status) decided seam (b) — a distinct canonical disclosure object, so `capabilityRequirements` stays fail-closed runtime authority — then proved with evidence that this is a **language/profile version event**, and stopped without changing a file. Measured on unchanged input: `vertical-v1.authored.json` normalized bytes 5460 → 5487, definition digest `82cb27f8…` → `2b5c6375…`, and the current reader rejects the new bytes with `CANON_SCHEMA_INVALID`. Packages declaring **zero** disclosures still move: canonical fixture `00444e2e…` → `24a10122…`, bootstrap `20ad5c1b…` → `54e0c173…`, vertical v2 `c35ec43a…` → `c24a48b1…`, and vertical v1's release root `70c310f5…` → `39543c8a…`. Root cause: `normalizedShape` (`schemas.ts:733`) is wrapped by `z.strictObject` (`:756`), so a new family collection is a closed-set change, and language contract T10 fixes family/collection bounds per version. Scope: v2→v3 language and normalization-profile dispatch retaining v0/v1/v2 readers; the v3-only disclosure family with its bounded `STRUCTURAL_LIMITS_V0` entry; normalization ordering, duplicate detection and authored round-trip; semantic-model and release-manifest output; provider validation and persisted round-trip; hardcoded v2 module definitions and fixture harnesses; canonical, G1/G2, structural-release, determinism and demo-shell artifacts; and the §5.1-versus-§5.5 plan-tension disposition. **Row 1 answered: it does.** ADR-0012 rules that existing query and operation catalogs cannot represent the cross-position contract plan §5.8 requires, so this packet grows by **one formula/rule projection family** carrying binding-position profile, phase, purity, target and absent/error behaviour — riding the same bump rather than buying a second. This packet therefore carries **two** families now, and its prompt must be written against both. **One shape requirement to carry in:** boolean binding positions (guards, visibility) need a **reason channel** alongside the boolean so an explanation exists and a future escape body must supply one — validation profiles already get this free via pass/fail-plus-message. A sentence here; a canonical change later. Do not cut it until row 1 is accepted. |
| 4 | G2-P4 — surface-grammar conformance | Behavioral | Roadmap resumes. Narrowed by G2-P3a to the pure conformance suite. |
| 5 | G2-P5 — shared table behavior + Q0 envelope | Critical | Paging/truncation/cursor, saved filters, shape-specialized SQL. **Re-cut required at admission**, per the accepted G2-EK1 expression kernel: persisted saved-filter criteria are canonical predicate envelopes versioned per node and validated against the pinned release at read, failing closed with typed per-position codes; the ADR-0008 write-path jurisdiction must be ruled explicitly (its carve-out covers migrations/backup/observability/health, not user-initiated preference writes) rather than decided ad hoc by the writer; and the owned migration `0008_saved_master_filters.sql` collides with the shipped `0008_module_runtime_role_assumption.sql` (stream runs through 0010), so it needs a fresh number. Note its pinned salvage REFERENCE `server/user-view-preferences/**` persists a bespoke `{field: enum(["search"]), value}` format — the second expression language slot 4 exists to prevent. |
| 6 | `adding-a-module` skill | Mechanical | Written against the proven Freeze G template; the fan-out consumes it. |
| 7 | **Q1 compositional query tier** | Critical | **G3-blocking**, per verdict S2: G3's correctness contract is `SUM(posted movement.quantity_delta)`, so without Q1 the inventory stage hand-rolls aggregation against ADR-0011's grain. The plan already specifies the tier (§5.1, §5.9, §9.2.2) — filters, traversal, joins, grouping, aggregates, reports, exports over semantic entities. Today the gateway rejects every tier above Q0 and every filter other than literal `true`. Placed after the fan-out so it is designed against three real modules. Also the answer to "can the agent analyse data" — see verdict R8/R9. **Depends on the accepted G2-EK1 expression kernel:** Q1 is the first tier to compile and SQL-lower non-trivial filters, so the expression ceiling, position profiles and cost classes must be ratified before it is designed. **Owns the precondition field-locality defect** surfaced by the expression-kernel debate: query filters enforce source-entity locality (`normalize.ts:1050-1064`) but operation preconditions validate scalar type only and can reference a field from any entity in the package (`:1074-1083`). Latent solely because the runtime fence rejects non-trivial preconditions — this row opens that door, so it closes the hole or explicitly re-routes it. **Also the trigger for L2-L4** (see "LLM-assisted verification" below): the first non-trivial SQL lowering makes the parity corpus, the model-assisted dispatch tripwire, and the scenarios-as-specification prototype all due here — one body of work, not three. Scope them at admission; if they do not fit, cut them as a paired follow-on rather than deferring past G3. |
| 8 | PR-7 — provider hot path | Behavioral | Release-load cache (flagged by two independent reviews), relation N+1, round-trip reduction, advisory-lock namespacing. Before G3. |
| 9 | Policy/identity kernel | Critical | The one kernel seam with **no owner** — see decisions below. After fan-out, before G3. **Bound by the accepted G2-EK1 expression kernel:** `PolicyDefinition` carries "narrowing conditions" (plan line 643) and §12.2 line 2338 claims policy narrowing for the Formula family, so the kernel's jurisdiction ruling applies here — otherwise a second condition format is born in the trust layer, the most expensive place to unify later. Narrowing may only restrict a live ALLOW and must fail closed; it can never grant, nor override the mandatory kernel predicates (archive exclusion, tenant/environment RLS, record identity, optimistic revision, authorization). |
| 10 | G2-P8 import → G2-P9 stage gate | — | Completes G2. |
| 11 | Capability cycle-time baseline | Mechanical | **[Lever 4](coverage-strategy-levers.md) Half A, and the only part with a real cost of delay.** §15.7 measures module-building effort from *existing* capabilities — the wrong axis. Record, for each capability we add, the decision latency (gap identified → admitted) and implementation latency (admitted → shipped supported across all ten cells). **Startable now, before any tenant:** PR-6's `relation` index kind and row 3's two canonical families are capability additions whose cycle time is measurable today, and a baseline not started cannot be reconstructed. Small and order-independent — **take it any time; it does not displace Critical work.** |

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

## Settled by debate (2026-07-26)

The [expression-kernel debate](debates/expression-kernel-verdict.md) is CLOSED, converged,
and **RATIFIED** — binding on packet writers, who follow it and do not relitigate it.
Ratified: `PredicateExpression` becomes the Formula IR's
wire-compatible v0 by declaration, never by rename; the language is total and terminating
(term sorting in `normalize.ts` already bakes in evaluation-order-independence, so
short-circuit semantics are inexpressible by construction); one language with per-position
profiles across five execution targets; SQL admissibility as cost classes with paired
execution-observed probes; the kernel lives inside `canonical-model`, exposing a
wire-shaped `parse(unknown) -> IR` keyed on each node's own `schemaVersion` because
pinned releases must be read forward forever; workflow mutation steps invoke **whole
Semantic Operations**, never `EffectGraph` nodes, and compensation is a named correcting
operation. Rejected: G6 as the deadline; a hybrid client evaluator now (deferred behind a
seven-point admission bar, with the server evaluator environment-neutral from birth so the
client lowering stays a compile-target decision); an ADR-only packet (a declared rule with
no executing gate, and Mechanical by tier); a new `expression-kernel` package; relocating
the existing fence unchanged.

**The governing lesson is from our own quarry.** `/home/rvham/2rain_erp` already had ONE
unified `RuntimeConditionAst` with six declared consumers — guard, validation, filter,
automation, metric, surface — and it still forked, because the metric service
re-implemented the same AST with strict `===` against the canonical evaluator's coercing
`scalarEqual`, compiled it separately to SQL strings, and diverged again on
`localeCompare`. **One language is necessary but not sufficient; the invariant is one
owned evaluator per execution target**, and the out-of-kernel dispatch tripwire must cover
the server, not only the browser.

Two defects surfaced and are routed: the current trivial-predicate fence is **not
fail-closed** (`assertQueryDefinition` requires only that `filter` be an object, so
unknown-version and unknown-property predicates execute as `true`), and operation
preconditions have **no field-locality check** where query filters do
(`normalize.ts:1050-1064` vs `:1074-1083`) — latent only while the fence rejects
non-trivial preconditions, a cross-entity leak the day it opens.

## LLM-assisted verification of the expression kernel — what lands when

**Status: proposed by the orchestrator, not ratified.** Each row becomes real work
only when its trigger fires and a packet is selected. Recorded here so the sequencing
is not rediscovered, and because two of the three are cheapest to build for our own
evaluator before they ever face a tenant.

The governing constraint is the ratified verdict's own boundary: an LLM may author at
compile time, operate at runtime only by selecting registered operations, and critique
offline — **it may never evaluate a business rule at runtime.** Everything below is
CI-time or authoring-time and produces artifacts a deterministic check then judges.

| # | Item | Trigger — not a date | Owning row/stage | Why exactly then |
|---|---|---|---|---|
| L1 | **Obligations named, nothing built** | now | row 1 (ADR-0012) | The ADR already requires per-evaluation explanation and a static out-of-kernel dispatch scan recorded honestly as a proxy. It builds no corpus and no model-assisted gate. Correct: today the fence admits only literal `true`, so there is nothing to diverge and nothing to fork. |
| L2 | **Differential parity corpus, v1** | first non-trivial SQL lowering | row 8 (Q1) | Q1 is the first tier to compile and SQL-lower real filters. From that moment IR semantics and PostgreSQL semantics can disagree — absent values against three-valued logic, exact-decimal ordering against `numeric`, case-fold parity against the database-owned `nsm_unicode_case_fold_v1`. The verdict calls this drift **invisible**, which is why it needs a corpus rather than review. LLM generates adversarial cases; **the differential judges them, never the model**. Unbounded to enumerate by hand, bounded to check by machine. |
| L3 | **Model-assisted dispatch tripwire** | same trigger as L2 | row 8 (Q1) | Worth having only once the evaluator has behavior worth re-implementing. Strengthens, never replaces, the execution receipts. Justified by our own history: the quarry's second evaluator was a `switch` on `condition.kind` inside a metrics function (`runtime-metric-service.ts:478`) — semantically a fork, syntactically invisible to a pattern scan. Remains a proxy; its limits stay recorded per AGENTS.md §6. |
| L4 | **Scenarios-as-specification prototype** | alongside L2 | row 8 (Q1) | Expressions are total, terminating and small, which makes the kernel the safest possible first consumer: generate scenarios, verify deterministically, have a human approve *behavior* rather than *implementation*. Build it for our own evaluator, where a mistake costs a red build. |
| L5 | **Corpus becomes bidirectional and production-critical** | server-side production evaluation exists | G6 | G6 adds validation, guards, defaults and visibility evaluated on the server for real. Only then do both targets run in production and the parity corpus guards live behaviour in both directions rather than one compiled direction. |
| L6 | **Scenarios-as-specification becomes tenant-facing** | first customer-authored customization | G6 | Promotes L4 into the customization publication lifecycle (plan §10.1). This is the scheduled answer to the prior-art audit's **E1** finding — a tenant author writing both the customization and the assertions that verify it reproduces Salesforce's 75%-coverage ritual. Compiler-derived assertions gate the candidate; author-supplied scenarios are additive only, never the whole gate. See [prior-art-failure-modes.md](prior-art-failure-modes.md). |

Reading of the schedule: **L1 is the only item inside the current packet, and it builds
none of this.** L2-L4 all fire on the same trigger — the first non-trivial SQL lowering,
which is Q1 (row 8, G3-blocking) — so they are one body of work, not three. L5-L6 are
G6 promotions of that same machinery, not new inventions. Building it once for our own
evaluator is how the tenant-facing version is de-risked before it faces tenants.

**The authoring counterpart is tracked separately.** L1-L6 are all *verification*. The
highest-value authoring play — the builder **negotiating the requirement** against the
existing vocabulary before declaring a gap — is recorded as `prose-only` in
[`doctrine-coverage.md`](doctrine-coverage.md). It reduces the primitives a requirement
consumes from the *demand* side rather than the supply side, which is the one direction
consolidation cannot reach, and it carries no safety surface because its output is still a
semantic patch the compiler validates. Its failure mode — an over-eager negotiator talking a
user into a near-miss — is caught by L4/L6: the user approves *scenarios*, so an alternative
that does not meet the real need fails them.

What LLMs do **not** address here, stated so it is not re-litigated: the evaluator
itself (roughly two hundred lines — writing it was never the bottleneck; nobody writing
a *second* one is the point), and the semantic rulings on absent values, decimal
ordering, fold parity and literal-versus-pattern search input. Those are frozen into an
immutable language, so a model may enumerate options and consequences but ratification
is human.

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
