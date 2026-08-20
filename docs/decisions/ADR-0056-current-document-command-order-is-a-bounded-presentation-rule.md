# ADR-0056: Current document command order is a bounded presentation rule

Date: 2026-08-19
Status: **ratified** — `inventory-surface-legibility` was accepted 2026-08-20
(ledger; reviewed `58e5ac14243a5ae597d9554c486baca5551b4ebc`, integrated
`f2096b754fcb4f1b00298c262dac3419f3a79934` by required packet-into-main `--no-ff`).
Ratified by the orchestrator at acceptance rather than left to be discovered: this
is the **fourth** ADR this month whose status line would otherwise have outlived its
own review (ADR-0049, ADR-0050, ADR-0055 preceded it). **Ratification is a step
nothing enforces, and that is now a pattern rather than an accident.**
Tier: Behavioral (presentation order changes; reachability and operation
admission do not)

## Context

ADR-0051 made every admitted command separately addressable and deliberately
left ordering undecided. The compiled binding has no `orderKey`, primary marker,
or authored presentation role. Its deterministic operation-id order puts Cancel
before Release on the current document command bar, contradicting
`ux-grammar` §3's primary-action-first rule.

Adding a general ordering field would change canonical authoring, compiler
output, and every downstream release consumer. That is not proportionate to the
one concrete pair currently shipped, and it would turn a presentation repair
into a contract migration before a second ordering case exists. Sorting every
unknown command from label text would be worse: it would invent business
semantics from copy.

## Decision

Until a second distinct multi-command workflow requires a general carrier, the
web renderer owns one closed presentation precedence for the current document
verbs:

1. an operation id whose final underscore-delimited verb is `release` comes
   first;
2. commands with any other verb retain their compiled binding order; and
3. an operation id whose final verb is `cancel` comes last.

The renderer applies this rule to a copy of the already-admitted command list.
It does not change which commands render, the posted operation id, confirmation,
policy, record preconditions, form admission, or execution. Stable sort behavior
preserves the existing order among commands with equal precedence.

This is the carrier decision for the present case: the carrier is a
renderer-owned, closed mapping of the two known operation verbs. It is not a
general claim that operation ids encode presentation semantics. Unknown verbs
are intentionally unordered rather than guessed.

## Consequences

- Release appears before Cancel, satisfying the existing `ux-grammar` rule on
  the only current multi-command document surface.
- The compiled artifact and all release lineage remain unchanged.
- A second multi-command pair whose primary action is not Release triggers a
  new decision. At that point the packet must choose an explicit authored or
  compiled presentation carrier and replace this bounded fallback; extending
  the renderer's verb list case by case is not admitted.
- Tests must observe rendered order and independently prove both controls still
  post their own admitted operation. A test of binding order alone is not UI
  evidence and must continue to expect the compiler's deterministic order.

## Rejected alternatives

**Alphabetical labels or ids.** Deterministic but semantically backwards in the
known case and language-dependent when labels change.

**Infer primary from effect kind.** Release and Cancel are both record
transitions, so the compiled effect kind cannot distinguish them.

**Add `orderKey` now.** A valid future design, but it moves authoring and release
contracts for one measured pair. The named replacement trigger prevents the
bounded rule from becoming a silent general convention.
