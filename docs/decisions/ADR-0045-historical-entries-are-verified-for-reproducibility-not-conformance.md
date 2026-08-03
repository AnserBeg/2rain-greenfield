# ADR-0045: Historical lineage entries are verified for reproducibility; only the serving release must satisfy current rules

Date: 2026-08-02
Status: accepted — ruled by the orchestrator after `5g3-searchcap`'s mandated lineage
feasibility check failed on every entry, including the first.
Tier: Critical (it changes what recompiling the lineage proves)

## Context

ADR-0043 authorized truncating the lineage to its valid prefix when a tightened compiler
rule made later entries uncompilable, and made it an explicit obligation that a
rule-tightening packet check the lineage **before** freezing. That obligation worked
exactly as intended: `5g3-searchcap` ran the check first and stopped.

It found that ADR-0044's rule fails **every** application entry, including entry 0:
`party_role_search` has capable columns and no usable mapped selection, and Party has been
in the lineage from the beginning.

**There is no valid prefix.** ADR-0043's suffix truncation keeps a good prefix and appends a
fresh head; it has nothing to keep. The mechanism does not apply.

That is not bad luck, it is the shape of the problem. Truncation only works when a defect
is recent. A rule tightened against something present since the first release will always
invalidate the whole lineage, and the conformance programme exists precisely to keep
tightening rules. **Truncation was a solution to one case, not a mechanism.**

Reaching for it again would also cost more each time: it already replaced three separate
Inventory transitions with one consolidated transition, and a head-only lineage would leave
nothing to exercise transitions, advancement, rollback or fresh-tenant install at all —
gutting the evidence the lineage exists to produce.

## The distinction that decides it

`verifyExistingLineage` recompiles every historical entry from its stored
`normalizedDefinitionBytes` and compares the result against the checked-in artifact. Ask
what that is *for*.

**It exists so a hand-edited artifact cannot survive.** The property is that each entry is
reproducible from its recorded inputs — an **integrity** property.

Applying today's conformance policy to yesterday's releases is a different claim, and it was
never the point. It asserts that every release ever made would be authored the same way
today, which is false by construction the moment any rule tightens, and which nothing
depends on.

Conflating the two means every rule tightening retroactively invalidates history that was
correct when written.

**The programme already made this exact distinction once.** ADR-0040 ruled that a fresh
tenant applies every transition but runs full semantic verification only for **the release
that will serve**, on the reasoning that correctness must be asserted of what actually runs.
This ADR applies the same principle one layer up.

## Decision

### 1. Historical entries are verified for reproducibility, not for current conformance

Recompiling a stored entry must continue to prove that its recorded bytes produce its
recorded output. It must no longer require that the entry satisfy conformance rules
introduced after it was authored.

Structural failures — a transition that cannot apply, bytes that do not reproduce their
recorded root — still fail. Nothing about integrity is relaxed.

### 2. The serving release must satisfy current rules in full

The head is compiled fresh from current source and gets no leniency whatsoever. Every
conformance rule, including every rule this programme tightens in future, applies to it
completely.

### 3. The lenient path is structurally unreachable for new work

Leniency applies **only** to entries already present in the checked-in artifact. A newly
compiled head can never take that path, and this must be enforced by construction rather
than by convention.

**A control must prove a non-conformant head is still refused.** This ADR creates exactly
one way to weaken a gate, and an unproven claim that the weakening is scoped is worth
nothing. This is the vacuity vector; ship its negative control.

### 4. This supersedes truncation as the response to a tightened rule

ADR-0043's truncation stands as executed and its record remains accurate. It is no longer
the mechanism reached for when a rule tightening invalidates history — §1 is. ADR-0043 §2's
naming obligation survives unchanged for any artifact event that does move entries.

In hindsight the Inventory truncation would not have been necessary under this rule. Saying
so plainly is the point: it cost three separate transitions, and the mechanism that replaced
it is the one that should have existed.

## What this ADR does not decide

- **Versioned compiler semantics.** Still ADR-0039 §4's named successor for when
  `outputProtocolVersion` leaves `v0-experimental`, at which point historical entries become
  immutable in fact and this leniency ends.
- **Whether a historical release may be activated as a serving release.** Rollback targets an
  earlier entry, and under §2 that entry would then be serving without satisfying current
  rules. It always would have been — the rules did not exist when it was authored — but this
  ADR makes the situation explicit rather than resolving it. Recorded as owed against the
  rollback control.
- **Whether the lineage should be rebuilt from a generator.** No generator exists; building
  one is real work and would offer a third option worth considering when someone has a reason
  beyond this.

## Consequences

- **`5g3-searchcap` unblocks**, and so does every future rule-tightening packet, without
  spending lineage entries each time.
- **A property is honestly narrower than it looked.** "Every entry in the lineage satisfies
  current rules" was never true after any tightening; it was maintained by deleting the
  entries that disagreed. It is now stated rather than enforced by attrition.
- **The obligation ADR-0043 created keeps earning its keep.** The check ran first, found this
  before an artifact was touched, and cost one stop of two minutes instead of two stops and a
  truncation. That is the obligation working exactly as written.
