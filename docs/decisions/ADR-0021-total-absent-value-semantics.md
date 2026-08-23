# ADR-0021: Total absent-value semantics

Date: 2026-07-28
Status: **ratified** 2026-08-21 — Q1-P0 is accepted (ledger; reviewed
`185d78bbe2bc00b1142b535cde9774234d4e63ab`, integrated `1a8a165`), completing the
condition this ADR set for itself. (Status corrected by the orchestrator's bridge to
`record-claim-fidelity`, 2026-08-21. The 2026-08-21 record sweep corrected the six ADRs
phrased *"ratified when that packet is accepted"* and missed the five phrased *"pending
packet acceptance"*; R1's own gate found them on its first run.)
Tier: Critical (review per `review-tiers`)

## Context

Optional is the canonical default field presence. `PredicateExpression` already permits a
field comparison inside `notPredicate`, but no evaluator or SQL lowerer has ruled what happens
when the field is absent. PostgreSQL comparison with `NULL` produces `UNKNOWN`; JavaScript-like
two-valued evaluation commonly turns the atomic comparison into `false`. The disagreement is
silent at a query boundary:

```text
                         absent field
raw PostgreSQL:          NOT (NULL < 5)       -> NULL / row excluded
two-valued predicate:    NOT (false)          -> true / row included
```

Plan §5.12 F1 requires a ruling before Q1 lowers the first non-trivial filter. F3 requires the
ruling to decide whether `>=` and `<=` are real primitives, because negation is no longer a
valid substitute once absence exists. The same section calls out `SUM(optional)` because
PostgreSQL silently omits null inputs.

ADR-0012 remains binding: Formula IR is total and terminating; every binding position owns a
profile; every node is version-dispatched; and each execution target owns one evaluator rather
than re-dispatching syntax in consumers. This ADR supplies the previously deferred F1 rule. It
does not lower SQL.

## Candidates considered

### PostgreSQL/Kleene three-valued propagation

An atomic comparison involving absence yields `UNKNOWN`; Boolean composition propagates it.
This matches raw PostgreSQL syntax but does not produce the Boolean result type declared by the
current predicate positions. Collapsing `UNKNOWN` only at the outer position hides a second
semantic rule, and makes both `NOT(a < b)` and `a >= b` collapse to false when `a` is absent,
which erases the F3 distinction the plan explicitly requires. Rejected.

### Runtime error on absence

An absent operand could raise an evaluation error. That makes otherwise accepted expressions
data-dependent partial functions and fails ADR-0012 totality. Rejected. A malformed or
unsupported expression may still be rejected before evaluation; absence in valid row data is
not malformed syntax.

### Compile-time rejection of every optional-field comparison

This is total, but optional fields are the default and ordinary saved filters and visibility
conditions must be able to mention them. Rejecting the head case would technically avoid the
semantic question while leaving Q1 unable to serve the use case that made F1 urgent. Rejected.

### Total false-on-absence comparisons

Every comparison with at least one absent operand yields `false`; Boolean nodes then use
ordinary two-valued algebra. This is total, gives every position its declared Boolean result,
preserves absence as distinct from every scalar value, and makes the F3 distinction explicit.
Selected.

## Decision

### 1. Presence is tagged; it is never a scalar sentinel

An evaluator resolves a field dependency as either `present(CanonicalScalar)` or `absent`.
Absence is not `null`, an empty string, zero, `false`, a magic date, or an enum option. It is not
serialized as a new `CanonicalScalar` kind by this packet.

For each admitted field comparison operator:

```text
compare(absent, literal) = false
compare(present(value), literal) = the target-owned present-value comparison
```

The rule applies equally to `equals`, `notEquals`, `lessThan`, and `greaterThan`. In
particular, absence is **not** "not equal": both `a equals x` and `a notEquals x` are false
when `a` is absent. Authors who intend to include absent rows must express that intent through
a future typed presence primitive; no such primitive is added here.

`booleanPredicate`, `allPredicate`, `anyPredicate`, and `notPredicate` use ordinary Boolean
algebra. Every term is evaluated; canonical term ordering cannot be used to hide an error
behind short-circuit order.

### 2. Every current binding position owns the result disposition

The absent comparison rule is common, but the meaning of the resulting Boolean is not global:

| Binding position | Result type | Meaning of `false` |
| --- | --- | --- |
| Query filter | Boolean | Exclude the row. Mandatory provider-owned tenant, environment, archive, and policy predicates remain separate conjunctions. |
| Operation precondition | Boolean | Reject the operation; stored dependencies are re-read through the transaction-bound target. |
| Guard | Boolean | Disable the guarded transition, action, or route. |
| Visibility condition | Boolean | Hide the presentation element. This result never grants authorization. |
| Validation | Boolean | Reject the value with the position's typed validation diagnostic. |
| Derivation | Boolean for PredicateExpression v0 | Derive `false`. Scalar derivation nodes do not exist in v0 and remain compile-time unsupported; when introduced, an absent scalar result must be a defined tagged result usable only by an optional target, or the expression is rejected at compile time. |

The executable profiles are versioned as
`northstar.predicate-position-profile/v1`. Unsupported positions and invalid target comparison
resolutions reject with a kernel receipt rather than producing no value.

### 3. SQL targets totalize each atomic comparison before composition

Q1's future PostgreSQL lowerer must preserve the atomic rule before applying Boolean
composition. The illustrative shape is:

```sql
COALESCE(field < parameter, FALSE)
```

or an equivalent typed predicate such as `field IS NOT NULL AND field < parameter`. Applying
`COALESCE` only to the final `WHERE` expression is wrong: it would make
`NOT(field < parameter)` false on absence instead of true. Q1 owns the concrete versioned
lowering table and provider parity corpus; this ADR owns the result it must reproduce.

### 4. F3 operators are required but remain unadmitted in this packet

Under F1:

```text
a absent: NOT(a < b) = true
a absent:     a >= b = false
```

Therefore `>=` and `<=` are required primitives and may not be rewritten as negated `<` or
`>`. Q1-P0 does **not** add their serialized node spellings: doing so under `v2` would
retroactively widen an immutable language version, while advancing the complete canonical
language/profile and every compiled release is larger than this ruling packet. The current
canonical compiler rejects `greaterThanOrEqual` and `lessThanOrEqual`.

Q1 must admit the two operators through an explicit language/profile version before claiming
ordering completeness. Until that happens, using either spelling is a compile-time error, not
a silent rewrite.

### 5. Optional `SUM` is inadmissible; required `SUM` is total

Q1 may admit `SUM(field)` only when the aggregand field is canonically `required`. An optional
field is rejected at compile time. The platform does not copy PostgreSQL's silent null-skipping
into the IR because doing so would make a missing movement quantity indistinguishable from a
movement that did not contribute. This is the safer polarity for inventory correctness.

For a required aggregand, an empty input has the additive identity zero. PostgreSQL lowering
must therefore use the exact typed equivalent of `COALESCE(SUM(field), 0)`. Q1 owns its
precision, scale, quantity-unit, currency, grouping, visibility, lifecycle, and snapshot
contracts. This ADR decides only the absent-element and empty-input cross-term needed before
that design begins.

Today the canonical query grammar admits no aggregate selection at all, so every aggregate —
including the executed optional-field probe — rejects at the canonical compile boundary. Q1
may narrow that rejection only as stated above.

## Canonical kernel encoding

`packages/canonical-model/src/predicate-kernel.ts` remains the strict wire-shaped dispatch
owner. Its existing one-argument mode still admits only exact literal `true`, so this packet
does not make a non-trivial predicate executable through a runtime gateway.

The same entry point now has a target-evaluation mode which:

- parses the complete current predicate wire shape with exact keys;
- dispatches every node's own v0-experimental, v1, or v2 version;
- enforces the existing expression-depth ceiling;
- receives only a target-owned present-comparison truth or an `absent` tag;
- owns absence conversion and all Boolean composition; and
- returns a typed, position-stamped evaluated or rejected receipt.

The target callback does not decide absence semantics: returning `absent` always becomes the
kernel's `false`. Present-value equality, numeric, temporal, collation, and case-fold parity
remain Q1/G6 target work and are not silently ruled here.

## Consequences

- Q1 can lower non-trivial filters only by totalizing every atomic comparison before Boolean
  composition.
- Optional fields remain filterable; their absence is neither an error nor a scalar sentinel.
- F3 is no longer a convenience request. Q1 must add `>=` and `<=` as versioned primitives or
  remain explicitly incomplete.
- Inventory's required `quantity_delta` can be summed with zero for an empty input. An optional
  quantity cannot be summed and silently skipped.
- Runtime query and operation gateways still admit literal `true` only. No provider, gateway,
  or compiler lowering changes in this packet.
- The precondition field-locality defect remains latent but becomes newly reachable when Q1
  wires non-trivial transaction-bound preconditions. Q1 must close it before widening that
  route.

## Evidence

The Q1-P0 PostgreSQL probe executed the same absent case through the canonical kernel and an
ephemeral PostgreSQL instance:

```text
Q1-P0 absent probe: kernel_not_less=true raw_sql_not_less=NULL
total_sql_not_less=true total_sql_greater_or_equal=false
sum_optional=5 rows=3 present=2 empty_sum=NULL
```

This observes four facts rather than inferring them: raw PostgreSQL disagrees with the total
kernel under negation; atomic totalization restores agreement; negation is not a substitute
for `>=`; and PostgreSQL both skips an absent aggregate element and returns `NULL` on empty
input.

Canonical unit evidence executes every position profile over an absent comparison, executes
negation, and forces an invalid comparison resolution to a typed rejection. Separate canonical
compile negatives reject both F3 spellings and an optional-field aggregate shape.

Sources: plan §5.12 F1/F3 and the aggregation cross-term; ADR-0012's totality, position-profile,
wire-version, and one-evaluator-per-target rules; and the ratified
`docs/execution/debates/expression-kernel-verdict.md` V2, V3, V5, V6, and additional obligation
4.

## Enforcement

- `inspectPredicateForExecution(value, evaluation)` is the canonical structural evaluator and
  position receipt owner. Consumers do not re-dispatch Boolean predicate kinds.
- The one-argument runtime fence remains byte-compatible and literal-true-only.
- Q1's SQL lowering table must cite this profile version and add differential PostgreSQL
  evidence before a non-trivial filter is admitted.
- Q1's compiler must reject optional `SUM`, and its required-field `SUM` provider probe must
  cover empty input as zero.
- A future scalar derivation grammar cannot use raw `null` or an ambient host-language
  `undefined`; it must encode a defined absent result or reject the expression statically.

## Limits

This ADR does not decide field-to-field comparison (F2), traversal (F4), Formula aggregation
as a capability (F5), decimal arithmetic (F6), present-value cross-target comparison parity,
policy predicate injection, SQL cost classes, or the Q1 aggregate contract beyond absent and
empty inputs. It also cannot prove a future lowerer calls the kernel; Q1's differential corpus
and provider execution receipts own that observation.
