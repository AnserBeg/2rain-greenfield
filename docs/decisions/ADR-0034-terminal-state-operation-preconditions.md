# ADR-0034: Terminal-state operation preconditions

Date: 2026-07-30
Status: **ratified** 2026-08-21 — packet `G3-Pterm` (queue row `5g3-term`) is accepted
(ledger; matrix-green `10b96c8b`, integrated `db3035e`), completing the condition this ADR
set for itself. (Status corrected by the orchestrator's bridge to
`record-claim-fidelity`, 2026-08-21. This one was phrased as a bare *"proposed"* rather
than as a conditional and was missed by the 2026-08-21 record sweep alongside the four
*"pending packet acceptance"* lines; R1's own gate found all five on its first run.)
**Not corrected here, and flagged rather than claimed:** §"What this ADR does not yet
implement" still defers the enforcement half behind `G3-P5`, which the ledger also
records as accepted, and `inventory-form-anatomy` records building on *"ADR-0034's
existing predicate carrier"*. That section reads stale, but confirming it is a
measurement against the interpreter rather than a status correction, and the bridge that
authorized this edit covers status lines only.
Tier: Critical (review per `review-tiers`)

## Context

`stock_count.state` is an ordinary enumeration over `draft | counting | reviewed |
posted`, and `stock_count` sits in `standardEntities`, so the generic `operations()`
helper emits create/update/archive/restore for it.

`posted` is **terminal evidence**. Under [ADR-0017](ADR-0017-cost-capture-without-valuation.md)
and [ADR-0029](ADR-0029-inventory-stock-count-correction-posting.md) a posted session and
its lines are the persisted inputs justifying already-posted immutable movements;
corrections **append** a superseding session and never mutate. The generic press
therefore admits an UPDATE that rewrites that evidence or flips `state` from `posted`
back to `draft`, and an ARCHIVE that removes a line from read-backs requiring
`archived_at IS NULL`.

It is unreachable only because Inventory is unmounted — which is exactly what `G3-P6a`
changes.

The design was ruled by a read-only design lane and adopted by the orchestrator:
`docs/execution/debates/g3-terminal-state-design-ruling.md`. **This ADR records that
ruling and the one mechanism it needs; it does not re-open the choice.**

## Decision

### 1. The guard is a declared precondition, not a new mechanism

Each of `stock_count`'s four generic operations declares

```text
precondition = not( stock_count.state equals "<namespace>:option.stock_count_state_posted" )
```

The precondition must hold on **every record image the effect consumes or produces** —
the candidate image for create, the prior **and** projected images for update, the prior
image for archive/restore. That single declared predicate closes mutation of posted
records, un-posting, forging `posted` through the press, and archiving posted evidence.

The posting capability's own `reviewed → posted` transition is untouched: it is direct
SQL inside `#post` and remains the sole sanctioned writer per ADR-0026/0029.

A generic **parent-aggregate rule** closes `stock_count_line` with zero line-level
declarations: a mutating operation on the source of an active `parentScopedChild`
relation must also satisfy the parent entity's update precondition against the parent's
current image. `reference`-ownership relations are deliberately exempt, because a
correction session **must** be able to reference a posted prior.

### 2. This is not a canonical language event, and the diff shows it

The test [ADR-0029](ADR-0029-inventory-stock-count-correction-posting.md) itself applied:
a language event is **changing grammar or normalization rules**. This changes neither.

- **The spelling already exists.** `operationDefinition.precondition` is a typed v3
  `PredicateExpression` in `schemas.ts`, normalized with a literal-`true` default and
  type-checked against the target field.
- **The semantics are already ruled.** `predicate-kernel.ts` fixes
  `operationPrecondition: profile('operationPrecondition', 'reject-operation')` with
  ADR-0021-total absence semantics.
- **The data already reaches the runtime.** The compiler emits `precondition` into the
  `operationCatalogPayload`, the view service loads it, and
  `RegisteredOperationDefinition.precondition` reaches the gateway.
- **Only evaluation was missing.** The gateway called the kernel in one-argument mode —
  the v0 fence admitting only literal `true`.

What changes is runtime behaviour: widening a v0 execution **fence** to the evaluation
mode the kernel already ships. That is `Q1-P1`'s exact precedent, where the query-filter
fence admitted only literal `true` until lowering existed and widening it was ruled a
runtime capability event.

**`packages/canonical-model/src/schemas.ts` and `normalize.ts` have zero changes in this
packet. That is the no-language-event invariant made visible in the diff rather than
asserted in prose.**

The counter-precedent worth naming, because this program got it wrong once: `Q1-P3a`
found that stock identity and `atTime` **did** need new grammar, since they are
per-request inputs needing a typed request slot that did not exist. That axis does not
apply here — **there is no per-request operand.** A precondition is release-static
declared data whose typed channel already runs end to end.

### 3. Admission and evaluation are different questions, asked by different components

A caller that will evaluate a predicate later, against a record image it does not hold,
still has to refuse an **unreadable** predicate before anything runs. So the kernel gains
one parse-only entry, `admitPredicateForExecution`, answering only *can this platform
execute this predicate at all*.

`admitted` is deliberately **not** `accepted`. `accepted` means the v0 literal-`true`
fence was satisfied and no evaluation is owed. Every pre-existing caller tests
`outcome !== 'accepted'` and therefore treats an admitted receipt as a refusal — so
opening a fence is an explicit opt-in and forgetting to opt in fails closed.

The division of authority:

| Component | Question | Failure |
|---|---|---|
| Semantic operation gateway | can this predicate be executed at all? | `SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED` |
| Generic interpreter (`prepareMutation`) | does it hold on this record image? | `MODULE_OPERATION_PRECONDITION_REFUSED` |
| Compiler conformance pin | is the guard declared at all? | `INVENTORY_TERMINAL_GUARD_MISSING` |

The interpreter is the authority; the conformance pin is a ratchet, not a second
authority. **No database constraint or trigger** — it would bind the sanctioned
capability writer and would ride a storage payload version event for no added authority.

### 4. `stateMachines` is neither extended nor adopted

Its `stateField` is derived by normalization from the machineId, so binding it to
G3-P4b's authored `state` field requires a normalization change — precisely the
language-event line. It stays compiled-and-unenforced with zero declarations, and is
routed to its own row (`5g3-sm`) as a member of this program's worst defect class:
compiled but never enforced.

## What this ADR does not yet implement

The enforcement half is **deferred behind `G3-P5`**, which owns
`module-runtime-interpreter.ts` where `prepareMutation` lives. Deferred: the precondition
declaration in `definition.ts`, interpreter evaluation and the parent-aggregate rule, the
conformance pin, and the PostgreSQL controls C1–C7.

**Until the interpreter evaluates, the widened fence is a fail-open window and must not
merge.** The ruling's commit order forbids gateway-widened-before-interpreter-evaluates,
and that ordering is a correctness constraint, not a preference.

## Consequences

- The second module with terminal evidence authors one predicate and one conformance
  pin. Zero new mechanism. The same lever expresses any record-state guard — "no edits
  once approved" — not just terminality.
- Enforcement follows declared data through compiled projections into one generic
  interpreter, which is ADR-0011's shape.
- **What this forfeits:** the press remains a legitimate writer for pre-posted phases, so
  pre-posting tampering is bounded by permissions plus the capability's
  validate-against-persisted digest rather than eliminated. Refusal correctness now rests
  on the evaluation wiring, which is why the controls are mutation-keyed rather than
  happy-path.
- One observable change for already-green paths: a literal-`true` precondition now yields
  an `admitted` receipt where it previously yielded `accepted`. Refusal behaviour is
  unchanged; the observation record is not.
