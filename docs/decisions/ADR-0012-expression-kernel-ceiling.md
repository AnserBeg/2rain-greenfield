# ADR-0012: Expression kernel ceiling and execution ownership

Date: 2026-07-26
Status: ratified 2026-07-27 — G2-EK1 is accepted, completing the condition this
ADR set for itself. (Status corrected by the 2026-07-27 G2-composition program
review, which found the condition met and the text stale.)
Tier: Critical (review per `review-tiers`)

## Context

The canonical language already carries `PredicateExpression` nodes in query and
operation definitions. Compiler projections embed those nodes verbatim in pinned
query and operation catalogs, but the runtime admitted literal `true` through
three independent, lax checks. All three ignored `schemaVersion` and unknown
properties. The platform plan also names a broader `FormulaRuleDefinition` with
typed IR, dependency, evaluator, explanation, and deterministic-evidence
obligations. Without one jurisdiction and one growth rule, each consumer can
quietly acquire its own expression language or evaluator.

The converged expression-kernel verdict is binding. This ADR ratifies its ceiling
and ownership without changing canonical bytes, compiler output, or the currently
executable subset. `PredicateExpression` remains the serialized v0 vocabulary in
immutable releases.

## Decision

### PredicateExpression is Formula IR v0

`PredicateExpression` is the Formula IR's wire-compatible v0. This is a
jurisdiction decision, not a serialized rename. Query and operation catalogs
embed predicate nodes verbatim, so renaming kinds would change canonical release
bytes and reinterpret immutable releases.

The runtime-facing kernel surface lives in `packages/canonical-model`. It accepts
`unknown`, validates a closed wire shape, and dispatches on each node's own
`schemaVersion`. It does not accept current Zod authoring types as proof that
release bytes are safe. Old pinned releases remain readable under their own node
versions; unknown versions and unknown properties fail closed.

G2-EK1 keeps the executable subset exactly literal `true`. It centralizes and
strengthens the existing fence; it does not admit comparisons, Boolean
composition, formulas, or SQL lowering.

### Growth governor and authoring surface

Formula IR is total and terminating. It has no loops, recursion, operation
invocation, ambient I/O, or unbounded collection traversal. Expression depth is
at most 24, reusing `STRUCTURAL_LIMITS_V0.maximumExpressionDepth` and the existing
`CANON_LIMIT_EXPRESSION_DEPTH` gate rather than inventing a second ceiling. Any
additional node must follow plan §5.11 step 3: design the versioned contract for
the concept's full semantic space before implementing a supported slice.

Totality is structural, not stylistic. Normalization sorts `allPredicate` and
`anyPredicate` terms canonically, so evaluation-order-dependent semantics cannot
be represented honestly. A term may not depend on short-circuit order to avoid
an error or side effect.

The launch authoring surface is a structured builder over the owned typed AST,
not a textual expression language. Text that resembles CEL would imply numeric,
collection, macro, timestamp, presence, and function semantics the owned IR does
not admit. A future textual surface requires its own versioned parser and
round-trip proof; it never becomes the stored or executed authority.

### Position profiles and execution targets

Every expression binding position declares all of:

1. available context;
2. result type;
3. evaluation phase;
4. purity contract;
5. allowed dependencies;
6. absent-value and error behavior; and
7. execution target.

An operator allowlist alone is not a position profile. Five execution targets are
recognized:

| Target | Binding constraint |
|---|---|
| PostgreSQL row evaluation | The compiler lowers only admitted shapes and assigns an observed cost class. Tenant, environment, archive, and policy predicates remain mandatory provider-owned conjunctions. |
| Pure server | Total, environment-neutral evaluation with no I/O and no Node or DOM APIs. |
| Transaction-bound server | Stored-state dependencies are re-read inside the write transaction against locked state. A preflight-only check is a TOCTOU defect. |
| Static normalization | Canonical type, locality, bounds, and dependency checks run without runtime state; this target already exists. |
| Possible client-safe | Deferred unless the admission bar below is satisfied for a concrete position. A client result is presentation-only and never authorizes a write. |

Mandatory kernel predicates — tenant/environment isolation, archive exclusion,
record identity, optimistic revision, and current policy — are not
tenant-authorable Formula expressions. Policy expressions may narrow a live
allow decision and fail closed; they may never broaden authority.

### SQL admissibility is a cost class

SQL admissibility is not a binary claim that an expression is "indexable". A
versioned lowering table assigns one of `indexedEquality`,
`indexedFoldedEquality`, `indexedPrefixRange`, or `tenantBoundedScan`, and rejects
unknown shapes. Each admitted lowering row requires an execution-observed provider
probe; hermetic compilation cannot prove the PostgreSQL planner used the intended
access path. PR-6's ratified R4 is the precedent: unanchored substring search is a
valid bounded tenant-partition scan even though forced RLS prevents an index qual.

### Evaluator ownership, receipts, and explanations

There is one owned evaluator per execution target. Consumers invoke it; they do
not re-dispatch Formula IR node kinds. The architectural tripwire covers server
code as well as browser code. Its source scan is an honestly labelled proxy: it
detects the known duplicate-dispatch spelling but cannot prove semantic parity by
itself.

Each real evaluation eventually emits a per-position routing receipt and an
explanation stamped with kernel version and canonical IR hash. A target-specific
lowering has a differential parity corpus against the owned semantics. Detailed
receipt and explanation schemas are deferred, but a bespoke evaluator cannot mint
them and therefore cannot become invisible authority.

### Workflow operations

A durable workflow mutation step invokes a whole registered Semantic Operation,
never an `EffectGraph` node. Effect nodes are defined inside the operation's
single-transaction envelope; lifting them into workflow steps would create a
second write ingress and discard that guarantee. Compensation is a named
correcting operation, never automatic inversion of an effect.

### Saved-filter clauses for G2-P5

Persisted saved-filter criteria are tenant data containing a canonical predicate
envelope, with every node versioned. They bind the release identity/profile needed
to interpret them, are validated against the request-pinned release when read, and
fail closed with typed, position-specific codes for unknown, corrupt, revoked, or
inadmissible content. Runtime-authored criteria receive their own byte, node,
depth, and collection bounds; package-normalization limits are not assumed to have
run over tenant rows.

A user-initiated saved-filter write is a business write and goes through a
Semantic Operation. ADR-0008's administrative carve-out covers migrations,
backup/restore, observability, and health; it does not cover user preference
writes. Reading saved filters remains a registered Semantic Query concern.

### Prefix-search semantics

Search input is **literal text**, not a user-visible wildcard pattern. `%` and `_`
are characters unless a future typed operator explicitly introduces pattern
semantics. The current substring implementation concatenates the input unescaped,
so those characters act as PostgreSQL wildcards today. The prefix-search packet
must remove that divergence with PR-2-style semantic-preservation evidence across
substring and prefix modes before range lowering is admitted. G2-EK1 changes no
query behavior.

### Client-target admission bar

A client-safe target is admitted per position only after all seven conditions
hold:

1. a real compiled form or visibility consumer has browser journeys covering
   dependent-field recomputation;
2. measured p50/p95 interaction latency breaches a budget ratified before the
   measurement;
3. the server evaluator's parity corpus is already green as the baseline;
4. dependency closure proves no hidden field, classification, policy fact,
   secret, or stored-state lookup crosses to the client;
5. the compiler emits a release-pinned versioned client artifact from the same
   IR, never a browser-authored AST;
6. differential parity covers the complete scalar, absent-value, error,
   version-skew, and stale-release corpus; and
7. bundle, startup, cache invalidation, and permanent parity costs are measured
   and accepted.

The costless provision adopted now is that pure server evaluation is
environment-neutral from birth. This preserves a future client lowering as a
target decision rather than an evaluator rewrite.

### Formula/rule projection-family answer

**Yes: a canonical `FormulaRuleDefinition` requires a dedicated compiled
formula/rule projection family.** Existing query and operation catalogs can
continue to own their embedded v0 predicates, but they cannot represent the
cross-position contract plan §5.8 requires for first-class formulas and rules.

The new family must carry, at minimum:

- stable formula/rule identity and each node's language version;
- canonical typed IR and result type;
- binding-position profile, phase, purity, target, and absent/error behavior;
- resolved dependency graph and classification/permission closure;
- admitted lowering and cost-class references, with provider-probe identity;
- allowed UI/query/report sinks;
- explanation contract, kernel version, and canonical IR hash; and
- deterministic assertion references.

The family is authoritative for first-class `FormulaRuleDefinition` objects;
existing inline query/operation predicates are not copied into it as a second
authority. Adding the family changes the closed projection-family set and release
output, so it is deliberately deferred to the queued v3 canonical-language packet.
That packet carries this family and the capability-disclosure family in one
language/profile bump. G2-EK1 adds neither.

### Explicit deferrals

G6-era ADRs own detailed position-profile schemas, CI receipt formats, further
plan/cost-class enumeration, cross-target semantic pinning (including null/SQL
three-valued logic, decimal ordering, and fold parity), the expression-verdict
assertion family, and volatile context bindings such as principal and captured
evaluation instant.

## Consequences

- One strict canonical-model fence replaces three lax spellings without widening
  executable behavior or changing release bytes.
- `@north-star/runtime` gains its first dependency on
  `@north-star/canonical-model`; the imported surface remains `unknown`-in and
  wire-shaped, not an authoring-type dependency.
- Pinned predicates have a permanent multi-version interpretation obligation.
- G2-P5 cannot invent a saved-filter expression format or bypass the operation
  gateway for user writes.
- The prefix-search packet has a literal-input semantic target and must evidence
  the intentional change from today's wildcard leakage.
- The v3 packet grows by one formula/rule projection family, avoiding a second
  canonical language/profile bump.
- Building evaluators, SQL lowerings, saved filters, workflows, client execution,
  or the new projection family remains out of scope here.

## Evidence

- The ratified source is
  `docs/execution/debates/expression-kernel-verdict.md`, especially V1-V8 and the
  client-target admission bar.
- Plan §5.8 requires rules/formulas to lower to typed IR, a server evaluator, a
  dependency graph, applicable UI/query/report projections, and deterministic
  assertions. Plan §5.11 supplies the full-space-before-slice growth rule.
- `packages/canonical-model/src/normalize.ts` sorts Boolean set terms and enforces
  `CANON_LIMIT_EXPRESSION_DEPTH`; `packages/canonical-model/src/constants.ts`
  supplies the existing depth ceiling of 24.
- Salvage REFERENCE `/home/rvham/2rain_erp/m0c-cel-spike-report.md:32-53,478-515`
  rejects CEL as runtime/persistence authority and records "structured builder
  only for v1" because textual CEL implies excluded semantics and creates a second
  parser. This ADR agrees; no divergence is taken.
- Salvage REFERENCE
  `/home/rvham/2rain_erp/docs/selfserve-split-map.md:144-167` supplies the dormant
  predicate checklist: threat model/types/null/error/time, canonical AST,
  dependency/cycle graph, evaluator, bounded aggregate planning, resource
  metering, read-model/UI/report parity, validation/default/pricing positions,
  historical versions, fuzz/security/provider, and release evidence. The position
  profile and deferrals above account for each category without building them.
- The quarry's unified `RuntimeConditionAst` named six consumers at
  `/home/rvham/2rain_erp/server/runtime-manifest/condition-evaluator.ts:36-42`,
  yet the metric service reimplemented the AST at
  `runtime-metric-service.ts:478-515` using strict `===` while the canonical
  evaluator used coercing `scalarEqual` at `condition-evaluator.ts:346-359`.
  One syntax did not prevent evaluator fork; one owned evaluator per target is
  therefore an evidence-backed rule, not an industry analogy.
- PR-6's forced-RLS measurements established `tenantBoundedScan` as a legitimate
  cost class and demonstrated why planner behavior needs execution observation.

Both quarry documents were consulted in `salvage-admission` REFERENCE mode. No
prior-repository artifact, code, dependency, or runtime authority enters this
repository.

## Enforcement

- `packages/canonical-model/src/predicate-kernel.ts` owns strict, per-node-version
  admission of the current literal-true runtime subset.
- Canonical unit tests reject unknown versions, unknown properties, and every
  non-true literal while accepting each supported historical node version.
- Integration tests execute the kernel through query-filter, operation-
  precondition, and operation-read-back routes; they pin the exact unsupported
  outcomes and non-accepted operation evidence.
- The architecture test scans canonical-model and server runtime sources for the
  known duplicate literal-true dispatch spelling and contains an induced canary.
  It is a proxy, not proof that arbitrary future code is semantically equivalent.
- Existing canonical negative tests enforce depth 24 and fail closed on schema,
  version, and expression-depth violations.
- Compiler golden, determinism, PostgreSQL consumer, demo-release, and
  executed-file-reachability gates prove this runtime/doc packet did not move
  compiler output or orphan its tests.
- Unbuilt clauses above become enforceable only in their owning packets: v3 owns
  the formula/rule family, G2-P5 owns saved-filter storage/read/write evidence,
  the prefix packet owns literal-search preservation, and G6 owns the deferred
  schemas and parity matrices. Until then they confer no executable capability.
