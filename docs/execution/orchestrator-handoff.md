# Orchestrator handoff

**You are the orchestrator and adjudicator for this repository.** This document
gets a fresh session productive. It is a starting point, not an authority — the
authorities are the files it points at, and they are always more current.

Written 2026-07-28 with `main` at `f3d3085`, 68 packets accepted.

---

## 1. Read these first, in this order

  1. `AGENTS.md` — the single operating doctrine. Section 6 (gates) is the one
     you will apply most.
  2. `docs/execution/lanes.md` — **four parallel lanes are active.** The binding
     path partition, the serial-integration rule, the serial-matrix rule.
  3. `docs/execution/current-plan.md` — the queue and why each row holds its slot.
  4. `docs/execution/ledger.md` — what every accepted packet did. Dense, and the
     rows carry findings you will need.
  5. `.agents/skills/mission-cadence/SKILL.md` and `review-tiers/SKILL.md` — the
     packet contract and the review tiers.

Everything you need is on disk. If your context is summarized mid-session,
re-read those five and you have lost nothing structural.

## 2. What your role is, and is not

From `current-plan.md`'s operating model:

> The assistant is **orchestrator + adjudicator**: it hands the user
> self-contained packet prompts, adjudicates review findings and lease-bridge
> requests by reading the code, and runs multi-model debates directly
> **(it does not write product code)**.

You are the only party who can see all four lanes. The writers cannot see each
other. That is why the path partition and the lane board exist, and why keeping
them accurate is a real duty rather than bookkeeping.

**You do not write product code.** You read it, constantly, to adjudicate. The
one exception this session was a small probe to test a claim, run out-of-tree and
reverted.

## 3. The loop

**Input: a lane report.** Opens with
`LANE: <KERNEL|DEPLOY|FIX|BUILD> · PACKET: <id> · SHA: <frozen> · BASE: <base>`.
Either evidence-ready with gates and reviews, or a **stop** — a bridge request or
a blocking finding.

**Your output, in order:**

  1. **Verify the load-bearing claims yourself by reading code.** Not optional
     and not a formality — see §6.
  2. If a stop: **rule.** Grant, deny, or redirect. Say which, and why, in the
     ruling itself.
  3. If evidence-ready: check the review chain matches the tier, check the
     integrated-SHA rule (§5), integrate, and write the ledger row.
  4. **Route every finding to an owning row.** Never let one terminate in prose.
  5. Hand the user the next prompt, or a ruling to paste back.

Rulings and prompts are pasted by the user into Codex sessions. Write them as
self-contained blocks — the writer has no context but the repository.

## 4. Where things stand right now

| Lane | Packet | State |
|---|---|---|
| KERNEL | `4c` — packages adopt v3 | active; merged main, three bridges cleared |
| FIX | `1d` — the unique-index emitter | active; merged main, migration is `0014` |
| BUILD | `G3-P2a` — tenant-completeness manifest | active |
| DEPLOY | — | **idle**; `1c` recommended |

**The goal is a working inventory pilot.** The chain:

```
4c  →  Q1-P3b  →  G3-P5        (the balance read)
1d  →  G3-P1b  →  G3-P2b  →  G3-P3   (post a movement)
```

`G3-P1a` froze the irreversible contracts; the one-way-door debate settled their
inputs. **No movement can be posted yet.** First inventory code landed today.

**DEPLOY is free.** `1c` (platform classification) is recommended: 1b's gate now
refuses the platform package, so saved filters are non-releasable, and it is a
red test rather than an argument. It needs a scoping pass first — the Tier-B
branch likely needs a canonical concept, which would collide with KERNEL.

## 5. Rules that are easy to get wrong

**The integrated-SHA rule.** The full matrix must be green at the *exact*
integrated SHA (PR-1). If `main` moved with product code, the lane merges and
re-runs. Check by computing the merge-base — not by diffing candidate against
main, which shows both directions and misleads. This caught me twice:

    MB=$(git merge-base HEAD <candidate>)
    git diff --name-only $MB HEAD | grep -v '^docs/'

**The docs-only exception.** If `main`'s advance is entirely under `docs/` or
`.agents/`, no re-merge or re-run. **You verify this, not the lane.** A lane
claimed it once and was wrong.

**Full matrices do not overlap.** Authoring is parallel; matrix runs are not.
Concurrent matrices produced a SIGTERM and a phantom `false !== true` that passed
in isolation. `test:postgres` is now pinned serial.

**Artifact-moving packets may run concurrently.** Generated artifacts are
deterministic functions of source; re-derive at integration. The only exception
was a packet whose *proof* was that artifacts did not move, and that has ended.

## 6. The lesson that cost the most today

**Verify before ruling. Every time.**

Roughly six lanes stopped on constraints I had not checked before writing a
prompt or a ruling. The pattern is always the same: I reasoned about the artifact
in front of me and missed the rule that constrained it.

Concrete instances, so you can recognise the shape:

  - Ruled modules should reference `northstar.shell:component.*` — forbidden by
    `normalize.ts:492`, a fence I had personally probed hours earlier.
  - Told a packet to encode an aggregate — encoding a new node shape is a
    language-version event, stated plainly in an ADR I had accepted two turns
    before.
  - Scoped F7 as an isolated bug fix — plan §5.12 says three decisions converge
    on one emitter and the shape is "decided once".
  - Wrote 4c's prompt asserting 4b defined every family, then accepted 4b
    deferring two.
  - Granted an export from a file I had not confirmed existed.

**Three times the writer's stop produced a better answer than either option they
offered.** Treat a stop as information, not friction.

Also: when you update a file with string replacement, **assert the match**.
Silent no-ops left the lane board wrong for hours.

## 7. Standing rules earned this session

- **A recorded finding with no owning row is a disposition with no executing
  gate.** Every finding names an existing row or creates one.
- **A gate whose verdict depends on machine load observes the scheduler, not the
  fact.** Do not raise a bound to make a loaded run pass.
- **Any component reading or writing persisted artifacts across a version
  boundary must take the version from the artifact, not a compile-time
  constant.** Three instances in one packet; sweep rather than spot-fix.
- **When every writer's manual workaround is identical, it belongs in the tool.**
  Three packets independently passed `--test-concurrency=1` before anyone put it
  in the script.
- **Every gate built for one situation needs widening the first time a second
  appears.** Readiness helper, argv grammar, version constants, conformance rule
  — none wrong, all written against a world with one case.

## 8. Practical

- Reviews: `~/2rain-missions/run-*.sh` launch Codex (`codex exec --model
  gpt-5.6-sol -c model_reasoning_effort=xhigh --sandbox read-only`) and Fable
  (`claude -p --model fable --effort max`). Results land in `*.result.txt`.
- Critical tier: fresh naive Codex xhigh to PASS, then Fable max on the identical
  SHA. Behavioral: one Codex review. Documents: the human read is the review.
- Two-REVISE cap. On the third, freeze the best candidate, triage, surface to the
  user. Adjudicate the findings yourself rather than looping.
- Integrate with `git merge --no-ff` preserving the reviewed SHA as an ancestor.
  Never rebase or reset `main`.
- Paste rulings into a lane that has **stopped and asked**. Never interrupt a
  lane mid-task.
