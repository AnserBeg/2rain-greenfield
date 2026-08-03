# ADR-0046: Rollback may activate a historical release; its defects refuse by name

Date: 2026-08-02
Status: accepted — ruled by the orchestrator on a stop-and-report from `5g3-searchcap`,
which reached the question ADR-0045 explicitly declined to answer and cited the line.
Tier: Critical (it governs whether the release safety valve stays available)

## Context

ADR-0044 requires a registered search with no usable lowered column to produce a **named
refusal** rather than a plausible empty result. ADR-0045 ruled that historical lineage
entries are verified for reproducibility while **the serving release must satisfy current
rules in full**, and recorded as undecided whether a historical, currently non-conformant
release may serve after rollback.

`5g3-searchcap` reached it. The rollback control selects `applications.at(-2)`
(`test/postgres/composed-application.test.ts:2481`), a historical release whose
`stock_count_line_search` has no usable lowered search column. When that release becomes
serving, the runtime correctly raises
`MODULE_SEARCH_CAPABILITY_UNAVAILABLE`.

Everything else in that packet works: historical entries reproduce, the fresh head compiles
strictly, fresh-tenant activation verifies the head completely, five searches reach real
results, and the partition is an exact 126 executed / 36 derived over 162.

## The distinction that decides it

ADR-0045 §2 says the serving release must satisfy current rules. Read literally, rollback
to any release older than the most recent rule tightening becomes impossible.

That reading is wrong, and the error is conflating two different acts.

**Compiling a release is authoring.** Current rules bind it completely, because the author
is producing something new and can comply.

**Rollback is activating an already-compiled release.** Nothing is authored. The release
was compiled under the rules in force at the time, and no amount of refusal now makes it
conformant retroactively.

Refusing rollback would also disable the safety valve **precisely when it is most needed** —
immediately after a change, which is the only moment anyone rolls back. A release mechanism
whose reverse gear disengages after every rule tightening is not a safety valve.

And it would misread what happened. `stock_count_line_search` was broken in that release
before ADR-0044 existed; it silently returned an empty result. ADR-0044 did not break
rollback. **It converted a pre-existing lie into an honest refusal**, and the refusal is now
visible where the lie was not.

## Decision

### 1. Rollback may activate a historical release

Permitted. A release that was validly compiled remains activatable, whatever rules have been
introduced since.

### 2. Defects in that release manifest as named refusals, never as silent wrong answers

ADR-0044's runtime protection applies to whatever is serving, including a rolled-back
release. `MODULE_SEARCH_CAPABILITY_UNAVAILABLE` firing after rollback is the mechanism
working, not failing.

This is the whole safety property: rolling back may restore old defects, and the operator
learns about them by name instead of receiving confident wrong answers.

### 3. The control asserts the refusal rather than treating it as failure

The rollback control must expect and observe the named refusal for a target release known to
carry the defect. A control that fails on correct behaviour is asserting the wrong fact.

### 4. ADR-0045 §2 is refined, not overturned

Current conformance rules bind **compilation**. They do not bind **activation** of a release
compiled earlier. ADR-0045's §2 stands for everything it was written about — a freshly
compiled head gets no leniency whatsoever — and this ADR states the boundary it did not.

### 5. Versioned historical runtime semantics remains deferred

The alternative — the runtime applying the rules in force when each release was authored —
is the same successor mechanism ADR-0039 §4 and ADR-0045 both defer. It is not built here,
and §2 makes it unnecessary for now: a named refusal is an acceptable outcome where a silent
wrong answer was not.

## What this ADR does not decide

- **Operator visibility into what a rollback target fails.** An operator choosing a rollback
  target should be able to see which current rules it does not satisfy, rather than
  discovering it from a refusal in production. That is a real property and real work.
  Recorded as owed; deliberately not required of `5g3-searchcap`, which is already carrying
  three rulings.
- **Whether a release should ever be marked unrollable.** A future defect might be severe
  enough — data corruption rather than a refused query — that activating the release is worse
  than being unable to reverse. No such case exists; when one does, it needs its own decision
  and a way to mark it.
- **Versioned historical runtime semantics**, per §5.

## Consequences

- **`5g3-searchcap` unblocks** on a control change rather than a mechanism change, which is
  the cheapest possible resolution of the three that were on the table.
- **The safety valve stays available.** Rollback does not degrade with each rule tightening,
  and the conformance programme can keep tightening without quietly disabling reverse gear.
- **A property is stated that was previously assumed.** "The serving release satisfies current
  rules" was true of every release we had compiled, and untrue the moment history and current
  rules diverged. Which act the rule binds — authoring, not activating — is now written down.
