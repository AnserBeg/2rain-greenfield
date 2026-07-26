# Expression kernel debate — converged verdict (2026-07-26)

Pipeline: `position-v1` -> two independent naive round-1 reviews (Codex `gpt-5.6-sol`
xhigh; Fable max) -> orchestrator adjudication with eight repository verifications ->
`position-v2` -> two independent naive round-2 reviews (fresh spawns, no round-1 context).
Round 2 **converged**: both reviewers independently reached the same verdict on all three
open splits, recommended the same next step, and rejected the same alternatives. The
debate is **CLOSED and RATIFIED** (user ratification 2026-07-26). This is binding input to
the expression/rule work, to G2-P5, to Q1, to the prefix-search semantics packet, and to
the policy kernel; packet writers follow it and do not relitigate it.

**Ratification rider — prefix-search jurisdiction.** Queue slot 2 (prefix-search
literal-versus-pattern semantics) is an expression-surface semantics decision, not an index
optimization. Its **semantic ruling** — whether search input is literal text or a
user-visible pattern — is absorbed into this verdict's jurisdiction and is decided by the
expression-kernel ADR. Slot 2 retains only the range-lowering implementation and its
semantic-preservation evidence, executed against the ruling rather than deciding it.

Working files: `/home/rvham/debate-lever1-expression-kernel/` (`position-v1.md`,
`position-v2.md`, `r1-codex-reply.md`, `r1-fable-reply.md`, `r2-codex-reply.md`,
`r2-fable-reply.md`).

## The question

Validation, action guard, relation filter, permission narrowing, metric filter,
visibility, default value, query filter, operation precondition, read-back filter,
state-transition guard, saved filter, workflow routing guard — are these one mechanism or
many? If built as N mechanisms, tenants hit N ceilings and the product's effective ceiling
is the lowest one; every improvement must be made N times, so none are made. The strategic
frame is coverage multiplicativity: a requirement needing `k` primitives ships at roughly
`p^k`, which is why prior platforms deliver 80% fast and the last 20% never.

## The decisive evidence: the prior repository already ran this experiment

`/home/rvham/2rain_erp` (the quarry) has ONE unified `RuntimeConditionAst` with six
declared consumers — `RuntimeConditionConsumer = "guard" | "validation" | "filter" |
"automation" | "metric" | "surface"` (`condition-evaluator.ts:36`), nearly this debate's
position list. **It still forked.** The canonical evaluator's `scalarEqual` coerces (loose
null handling, `fileComparableStrings` includes-matching, `condition-evaluator.ts:346`);
the metric service re-implemented the identical AST kinds with strict `===`
(`runtime-metric-service.ts:478,504`), separately compiled the same AST to SQL WHERE
strings (`:591,628`), and diverged again on `localeCompare` ordering (`:818`).

**One language is necessary but not sufficient.** The failure was the evaluator, not the
language. The ratified invariant is **one owned evaluator per execution target**, and the
out-of-kernel dispatch tripwire must cover the **server**, not only the browser.

## Verdicts

**V1. `PredicateExpression` is the Formula IR's wire-compatible v0.** Plan line 413 gives
"filters" to Semantic Query and line 415 gives "filters" to Formula/rule; line 662
resolves the overlap with a singular "server evaluator". Subsumption is a **declaratory**
act — an ADR fixing jurisdiction and growth rules. Renaming serialized kinds is rejected:
catalogs embed predicates verbatim (`projections.ts:328,388`), releases are immutable, and
a rename breaks canonical bytes and release roots.

**V2. The growth governor is plan §5.11 step 3.** The language is **total and
terminating**: no loops, no operation invocation, bounded depth. Depth ≤ 24 is ratified
from the existing `CANON_LIMIT_EXPRESSION_DEPTH`. Totality is not optional — `normalize.ts`
canonically **sorts** `allPredicate`/`anyPredicate` terms, which bakes
evaluation-order-independence into the language, so short-circuit-dependent semantics
(`b ≠ 0 && a/b > 2`) are inexpressible by construction.

**V3. One language, per-position profiles, N execution targets.** A profile declares
context, result type, phase, purity, allowed dependencies, absent-value/error behavior,
and execution target. Not merely an operator allowlist. Five targets exist or are
foreseen: PostgreSQL row evaluation, pure server evaluation, transaction-bound server
evaluation, static validation at normalize time (already shipped), and a possible
client-safe target. **Transaction-bound is not optional:** an operation precondition
depending on stored state must be rechecked inside the write transaction against locked
state, or it is a TOCTOU defect.

**V4. SQL admissibility is a cost class, not an indexability test.** PR-6 R4 ratifies
unanchored substring search as a bounded partition scan whose cost is invariant in tenant
count. The compiler admits an expression into a SQL-target position via a versioned
lowering table whose rows carry a declared cost class (`indexedEquality`,
`indexedFoldedEquality`, `indexedPrefixRange`, `tenantBoundedScan`), deny-by-default on
unknown shapes. The hermetic compiler cannot prove PostgreSQL will choose a plan; each
table row pairs with one PR-6b-style execution-observed provider probe, and a sync gate
reads the emitted lowering-table artifact and fails closed when a row has no probe.

**V5. The kernel lives inside `packages/canonical-model`.** `architecture-boundaries.ts:214`
hardcodes the contracts layer as `canonical-model` or `contracts`; a new package would be
kind `other` and unimportable by the compiler. More decisively, the authority already
lives there: the predicate schema, the depth ceiling, the comparison-typing table
(`normalize.ts:1813-1902`), filter field-locality (`:1057`), and the default-predicate
authority (`isDefaultPredicate`, `normalize.ts:1451`; `IMMUTABLE_DEFAULTS_V0`,
`constants.ts:51-60`). The enforced invariant is that the kernel imports nothing.

**V6. The runtime-facing surface is wire-shaped and version-dispatched.** Collapsing the
fences creates the first `packages/runtime` -> `canonical-model` edge. It is legal
(`workspaceDependencyAllowed`, `architecture-boundaries.ts:623`), but the gateways
deliberately interpret pinned wire JSON as untrusted, not authoring types. The kernel must
expose `parse(unknown) -> IR` keyed on the node's own `schemaVersion`, never the current
zod authoring types — runtime evaluates bytes compiled under possibly older language
versions. Pinned releases live forever, so the evaluator carries a permanent multi-version
obligation; `compiler-output-protocol-v0.md` currently says nothing about predicates and
needs the versioning clause.

**V7. Workflow mutation steps invoke whole Semantic Operations.** Not `EffectGraph` nodes.
Node semantics are defined *inside* the §7.3 single-transaction envelope; lifting the
vocabulary across durable steps preserves the names and deletes the guarantee, and creates
a second write ingress that ADR-0008 forbids. Compensation is a named correcting operation
(§7.4, ADR-0010), never an auto-inverted effect. Workflow branch/routing guards are
Formula-family expressions, which §12.2 line 2338 already implies via "routing,
eligibility".

**V8. "Cap evaluation engines at ~4" is not observable and is rejected.** Replaced by:
per-position routing receipts from a kernel execution counter; a differential parity corpus
per lowering target; per-evaluation **explanation** artifacts stamped with kernel version
and IR hash (plan lines 640, 2338, 2639 make explanation a required family output, not an
optional receipt — a bespoke engine cannot mint the artifact); and an honestly-labelled
proxy scan for out-of-kernel predicate dispatch **covering the server**, with its limits
recorded per AGENTS.md §6.

## The three splits, resolved

**S1 — Deadline: before G2-P5 is admitted. G6 is indefensible.** Saved filters are a plan
§11.5 G2 obligation (line 1831); only their representation is open. Plan line 413 puts
saved views inside the **Q1** subset, and Q1 is queued at slot 7 ratified **G3-blocking**;
the policy kernel (slot 9) evaluates `PolicyDefinition` narrowing conditions (plan line
643). **Three expression consumers are queued inside G2, before G3** — so the kernel is
pre-G3 infrastructure, not G6 infrastructure.

Round 1's sequencing citations were stale and are corrected here: G2-P6 and G2-P7 are
**accepted** out of stage-cut order (`ledger.md:72,74`), so the P6/P7 -> P5 dependency is
dead and Freeze I is now a retrofit onto three shipped modules; G2-P5 sits at **slot 5**
of the active queue behind three Criticals and Behavioral G2-P4; and P5's owned migration
`0008_saved_master_filters.sql` collides with the shipped `0008_module_runtime_role_assumption.sql`
(stream runs through 0010), forcing a re-cut at admission — which is the cheap moment to
bind the representation clause.

That runtime-authored saved filters are tenant *data* rather than release content
**strengthens** the deadline: release content can be recompiled under a new language
version; persisted tenant rows must be read forward forever under no-hard-delete and
validated against whatever release is pinned at read time. The bespoke-format risk is not
hypothetical — G2-P0's salvage map REFERENCEs the prior repo's `server/user-view-preferences/**`
into P5, and that store persists exactly a bespoke format:
`userViewFilterSchema = { field: enum(["search"]), value: string }`
(`shared/user-view-preferences.ts:10,27-32`). **The packet's own mandated prior-art input
is the second language.**

**S2 — Client evaluation target: defer.** Plan line 1518 ("server evaluates it and exposes
the same result everywhere"), line 2087 ("**Server** Formula IR evaluator shared by UI"),
and §8.1 line 1080 (React displays server-derived state and does not recalculate business
truth) all state server evaluation. There is zero predicate, visibility, or
conditional-display code in `apps/web`. A third lowering target bought now is a declared
artifact with no executing gate — the program's own recorded top failure mode — and its
price is known: PR-6b took eight review rounds across three oracle designs to build one
honest execution oracle for one target.

Admission bar, ratified now so it is never relitigated, per position rather than as a
blanket declaration: (1) a real compiled form/visibility consumer with browser journeys
exercising dependent-field recompute; (2) measured p50/p95 interaction latency recorded in
`docs/operations/runtime-slos.md` breaching a budget **pre-ratified in the ADR** (the
generic p95-under-500ms query objective is not evidence either way); (3) the server
evaluator's parity corpus already green, as the diff baseline; (4) a
confidentiality/dependency-closure proof — no hidden field, classification, policy fact,
secret, or stored-state lookup may cross, and "pure and deterministic" is insufficient;
(5) a release-pinned versioned client artifact emitted from the same IR, never a
browser-authored AST; (6) differential parity over the full scalar/absent/error corpus
with version-skew and stale-release negatives; (7) bundle, startup, cache-invalidation and
permanent parity costs measured and accepted. The client result is presentation-only and
can never authorize a write.

One costless provision adopted now: the server evaluator must be **environment-neutral
from birth** (total, no I/O, no Node or DOM APIs) and wire-versioned, preserving the client
lowering as a later compile-target decision rather than a rewrite.

**S3 — Next step: one Critical packet, ADR plus fence collapse.** An ADR-only packet is a
declared rule with no executing gate; it is also **Mechanical** by tier rules, since tier
follows the final diff. Mixed doc-plus-code Critical packets are established house style
(G2-P2 owned ADR-0011 alongside compiler and provider code). The code half is convergence
on an authority that already exists, not new machinery.

## Corrections to the round-1 baseline

**C2 was wrong twice, conclusion intact.** First, the fence is **not fail-closed**:
`assertQueryDefinition` requires only `isRecord(value.filter)`
(`semantic-query-gateway.ts:331`) and the helper checks only `kind` and `value`, so
`{kind:'booleanPredicate', value:true, schemaVersion:'unknown'}` and predicates carrying
unknown properties both execute as `true`. Relocating it unchanged would centralize a
bypass — strict shape-and-version admission is part of the first code step, not later
hardening. Second, the inventory was wrong: it is **two byte-identical implementations at
three call sites** (`semantic-query-gateway.ts:283`, `semantic-operation-gateway.ts:607`,
called at `:184`, `:505`, `:532`), plus a **third spelling in a different package** —
canonical-model's `isDefaultPredicate`/`IMMUTABLE_DEFAULTS_V0`. The fix is convergence on
the canonical-model authority, which also disposes of the "shared util inside runtime"
alternative for free.

**C6 was aimed too narrowly.** The browser is the hypothetical fork; the demonstrated fork
in prior art is server-side. The tripwire covers both.

## Additional obligations surfaced by the debate

1. **Saved filters need a versioned data-plane envelope**, with the canonical predicate as
   payload — tenant/environment/principal ownership, query identity, expression and profile
   version, created-against release identity, lifecycle, and typed stale-reference
   behavior. `doctrine-coverage.md:125` already distinguishes release definitions from
   release-pinned preferences. Persisting a naked `PredicateExpression` confuses release
   language syntax with a user-preference record.
2. **Runtime-authored ASTs have no self-contained resource bounds.**
   `PredicateExpressionSchema` (`schemas.ts:204`) has recursively unbounded term arrays;
   depth and collection budgets are enforced only by full package normalization
   (`normalize.ts:1331`), which a saved-filter API bypasses entirely. The kernel entry must
   enforce byte, node, depth, and collection budgets on runtime-supplied data.
3. **Operation precondition context is under-validated.** Query filters enforce
   source-entity locality (`normalize.ts:1050-1064`); preconditions validate scalar type
   only and can reference a field from any entity in the package (`:1074-1083`). Latent
   today because the fence rejects non-trivial preconditions; a live cross-entity leak the
   day it opens.
4. **Cross-target semantic parity is unpinned.** Absent-value comparison (SQL three-valued
   logic versus server evaluation over DTOs — `CanonicalScalar` has no null kind),
   exact-decimal/money/quantity ordering versus PostgreSQL `numeric`, and case-fold parity
   (the fold function is database-owned, `nsm_unicode_case_fold_v1`) are where one language
   quietly becomes two-languages-with-one-syntax. Invisible failure, worse than two honest
   languages.
5. **Volatile context bindings arrive on day one of saved filters.** "Mine, created this
   week" needs a principal and a relative date; `CanonicalScalar` has no relative-date kind
   and evaluation-time wall clock collides with AGENTS.md §6's monotonic/controlled-clock
   doctrine and with replay determinism. Profiles bind an evaluation instant captured once
   per request and a principal from ADR-0004 trusted context — never from payload.
6. **The saved-filter write path is an unruled ADR-0008 question.** ADR-0008 makes the
   operation gateway sole write ingress; its carve-out (`ADR-0008:47-50`) lists
   migrations, backup, observability and health — not user-initiated preference writes.
   Either extend the carve-out explicitly or make saved-filter writes a semantic operation,
   which buys contract validation for free. Unruled, the packet writer decides jurisdiction
   ad hoc.
7. **Mandatory kernel predicates are not tenant-authorable.** Archive exclusion, tenant and
   environment RLS, record identity, optimistic revision, and policy authorization must
   never become overridable Formula expressions. The provider conjoins archive filtering
   independently (`module-runtime-interpreter.ts:997`). Policy expressions may only narrow a
   live ALLOW and must fail closed.
8. **Plan-mandated salvage inputs were never read.** Plan lines 2123-2126 REFERENCE
   `m0c-cel-spike-report.md` — a Formula-IR spike whose recorded verdict is "structured
   builder only for v1" — and `docs/selfserve-split-map.md` as "the dormant predicate
   checklist". Under the salvage-admission skill these are mandated inputs to this ADR.
9. **Expression assertions have no home.** `FormulaRuleDefinition` promises "deterministic
   test cases" (plan line 640) but per-position admissibility rejections and evaluation
   verdicts have no assertion family. Cheap to reserve the seam now.
10. **Ledger hygiene.** G2-P6 and G2-P7 each carry a stale `planned` row from the original
    cut (`ledger.md:71,73`) alongside their accepted rows (`:72,:74`). This is what made
    the round-1 sequencing error possible.

## The next packet

**Expression kernel: ratify the ceiling, converge the fence.** Critical. Admitted any time
before G2-P4/G2-P5, without displacing the three queued Criticals.

1. **ADR-0012**, trimmed to the binding core — subsumption and jurisdiction over the
   413/415 overlap; the §5.11-step-3 growth governor with depth ≤ 24 ratified from existing
   code; position profiles with the five execution targets named; SQL admissibility as cost
   classes; canonical-model ownership plus the wire-version rule for the new runtime edge;
   one-owned-evaluator-per-target with a server-inclusive dispatch tripwire; per-evaluation
   explanation; the G2-P5 clause (persisted saved-filter criteria are canonical predicate
   envelopes, versioned per node, validated against the pinned release at read, failing
   closed with typed per-position codes) plus the write-path ruling; Q1 and prefix-semantics
   governance; the client-target admission bar. Consult the plan-mandated
   `m0c-cel-spike-report.md` REFERENCE. Defer detailed profile schemas, CI receipt formats,
   and further plan-class enumeration to G6-era ADRs — a nine-topic constitution invites a
   two-REVISE-cap blowout.
2. **Collapse both runtime fences** onto one wire-shaped, version-dispatched
   canonical-model entry point unified with `isDefaultPredicate`. Three call sites routed;
   per-site outcome codes preserved byte-for-byte (`query-filter-unsupported`,
   `SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED`,
   `SEMANTIC_OPERATION_READ_BACK_UNSUPPORTED`) with `#recordNonAccepted` behavior intact.
   Strict malformed and unknown-version rejection proven. Execution receipts prove all
   three routes used the entry point. One negative control per vacuity vector. Full CI
   matrix at the frozen SHA.
3. **Amend `current-plan.md` and the G2-P0 cut for G2-P5:** the serialization clause and a
   fresh migration number.

Explicitly **not** in this packet: saved-filter storage, non-trivial evaluation, SQL
lowering, the full Formula IR, workflow implementation, or any client execution target.

## Alternatives rejected, independently, by both round-2 reviewers

- **ADR-only packet** — a declared rule with no executing gate; also Mechanical, not
  Critical.
- **G6 as the deadline** — fictional given plan line 1831, plan line 413, and queue slots
  5, 7 and 9.
- **Hybrid client target now** — no consumer, no plan warrant, permanent parity budget
  bought blind.
- **Moving the existing helper unchanged** — preserves malformed and unknown-version
  acceptance; centralizes a bypass.
- **Persisting naked `PredicateExpression`** — confuses release-language syntax with a
  user-preference record.
- **A new `expression-kernel` package** (or exploiting the `contracts` package-name
  loophole) — churn away from where the authority already lives.
- **Permanent Predicate/Formula coexistence with jurisdiction prose** — institutionalizes
  the drift the plan already resolved.
- **Folding the fence collapse into G2-P5 itself** — P5's owned paths exclude
  canonical-model and both gateways; the entry point must pre-exist P5.
- **Server-side post-filtering to dodge SQL lowering** — breaks filter-before-paging,
  result bounds, and turns a bounded partition scan into an unbounded fetch.
- **Workflow `EffectGraph` nodes on durable steps** — second write ingress; vocabulary
  reuse that silently drops the atomicity the vocabulary means.
- **Trusting the G2-P5 writer to reuse `PredicateExpression` unprompted** — the pinned
  salvage REFERENCE for P5 is itself a bespoke format.
