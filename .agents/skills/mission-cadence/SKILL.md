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
2. Gate results, honest — a red gate is reported with output, never hidden
   or explained away.
3. **Test it yourself** — copy-paste commands and/or UI steps with expected
   observations. Must be executable by the user in under 10 minutes without
   reading the diff. If the packet has no runtime surface, say what to read
   instead (e.g. an ADR) and what to check for.
4. Review evidence summary (who reviewed, verdicts, final SHA).
5. Ledger row update.
6. Proposed next packets (return to step 1 of the loop).

## Stop conditions

Stop mid-packet and report when: the packet needs an out-of-scope change
(issue a bridge request); a gate cannot be made green honestly; a design
fork appears that the plan does not settle; or the work exceeds the size
budget. Never widen scope silently, never continue past the checkpoint.
