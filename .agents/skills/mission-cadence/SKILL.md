---
name: mission-cadence
description: Binding step-packet execution contract. Read before orchestrating
  or launching any work in this repository. One user-selected packet at a
  time; every packet ends with a user-testable checkpoint; no autonomous
  continuation.
---

# Mission cadence — step packets

## Why this exists

The prior repository ran day-scale autonomous campaigns: many missions,
parallel writers, results reviewed a day later. That mode is retired here.
The user tests at every step. Small, verified, user-observed increments beat
large batches — even when the next step seems obvious.

## The loop

1. **Propose** — present 1-3 candidate next packets as a short table: ID,
   outcome, tier, owned paths, gates, and exactly what the user will be able
   to test at the end. Recommend one.
2. **Select** — the user picks. No selection, no work. Parallel packets only
   when the user explicitly selects more than one and their owned paths are
   disjoint.
3. **Execute** — run the seats per the `review-tiers` skill inside the
   packet's owned paths.
4. **Checkpoint** — deliver the packet-completion block (below), update
   `docs/execution/ledger.md`, evaluate the `program-review` triggers (a
   whole-app review may be due at a fan-out point, a new correctness domain,
   or accumulated drift — propose one if a trigger fires), then STOP and wait.

## Packet definition

A packet must have all of:

- **Goal** — one coherent outcome, sized 1-4 hours of agent work.
- **Tier** — Mechanical / Behavioral / Critical (per `review-tiers`).
- **Owned paths** — exact; nothing outside them may change.
- **Out of scope** — named explicitly, so drift is detectable.
- **Gates** — the exact commands that must pass.
- **Runnable exit** — the repo builds and runs when the packet ends, even if
  the feature is partial. Stop at a safe boundary rather than overrun.
- **Foreseeable bridges named up front** — when a packet will predictably need
  edits outside its owned paths (e.g. a kernel-wiring packet whose own ratified
  design requires touching shared migration/activation machinery), the packet
  prompt names those bridges as pre-authorized with guardrails, so the writer
  does not stop mid-flight at a boundary that was known in advance. An
  UNforeseen out-of-lease need is still a stop-and-bridge-request.

## Packet-completion block (mandatory, in this order)

1. Frozen candidate SHA (any later fix produces a new SHA and fresh review).
   The base named in the packet prompt is where the branch was **cut from**, not
   a promise `main` still points there — orchestrator doc commits land on `main`
   between packets by design. If `main` moved, integration rebases or merges the
   branch onto current `main` and the matrix re-runs at that integrated SHA; it
   never resets `main` back to the packet's base. See `git-workflow`.
2. Gate results, honest — the **full CI matrix** must be green at the exact
   integrated SHA, never only a packet-selected subset. A red gate is reported
   with output, never hidden or explained away, and the ledger row records the
   integrated SHA plus the full-matrix run. Deadline, expiry, and elapsed-time
   logic never compares raw wall-clock samples: production uses a monotonic
   source, and timing tests inject a controlled clock rather than
   sleep-and-measure.
3. **Test it yourself** — copy-paste commands and/or UI steps with expected
   observations. Must be executable by the user in under 10 minutes without
   reading the diff. If the packet has no runtime surface, say what to read
   instead (e.g. an ADR) and what to check for.
4. Review evidence summary (who reviewed, verdicts, final SHA).
5. Ledger row update.
6. Proposed next packets (return to step 1 of the loop).

## Parked work must stay VISIBLE — added 2026-08-02

A packet parked mid-flight is legitimate: the standing prioritisation rule tells
a lane to drop lower-priority work for an inventory-path packet. What is NOT
legitimate is parked work that nobody can see.

`current-plan.md` tracks what to START. It does not track what was left
half-done, so a parked packet falls out of tracking entirely and survives only
as a branch nobody is looking at.

On 2026-08-02 five packets were found parked this way over eight days. Four had
been silently superseded by work done another route; one (`rowparam`) held a
real unshipped runtime fix that nearly rotted past cheap rescue. One was
literally titled "PARTIAL stock-count authoring, interrupted mid-run" and sat
253 commits behind.

**The gate:** `scripts/check-parked-work.sh` lists every branch holding
unintegrated work with its age, and fails when any has been parked beyond the
staleness threshold. Run it at every checkpoint. For each branch it names:
integrate it, rebase and finish it, or delete it deliberately — but decide.
A branch 250 commits behind costs more to rescue than to rewrite.

## Stop conditions

Stop mid-packet and report when: the packet needs an out-of-scope change
(issue a bridge request); a gate cannot be made green honestly; a design
fork appears that the plan does not settle; or the work exceeds the size
budget. Never widen scope silently, never continue past the checkpoint.

## Stop convergence — at most two, then RE-SCOPE (binding)

A correct stop is good work. A *third* stop on one packet is not a fourth
continuation waiting to be written — it is the charter telling you it was
mis-scoped.

**On the third stop, the orchestrator does not issue another continuation.** It
splits the packet: land what is already green as its own reviewable increment,
and move the unfinished seam into a charter of its own with the discovered
constraints written in from the start.

This mirrors the two-REVISE cap in `review-tiers`, and for the same reason —
"a review that keeps finding more of the same class is a signal the charter is
mis-scoped, not that the code is wrong." Stops carry that signal even more
clearly, because each one is a constraint the charter's author did not know
existed.

**Recorded 2026-07-31 by `G3-P6a`.** It stopped four times: once on
unconstructible verification input, then three times on successive
implementation holes in one accepted ADR — a closed shared-list root contract,
a verification call site, and an unbound row-query parameter path. Every stop
was correct and every one found a real defect, so the stops were not the
failure. The failure was that nothing in this skill said "three means
re-scope," so the packet absorbed an ADR-completion workstream that deserved
its own charter, and each stop cost a full orchestrator round trip.

Count stops per packet, in the packet record. The cap is on stops that reveal
NEW scope; a lane pausing for a ruling on work already inside its charter is
not a stop for this purpose.
