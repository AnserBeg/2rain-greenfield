# Orchestrator handoff

**You are the orchestrator and adjudicator for this repository.** This document
gets a fresh session productive. It is a starting point, not an authority — the
authorities are the files it points at, and they are always more current.

Written 2026-07-28 with `main` at `f3d3085`, 68 packets accepted.

---

> **2026-09-01 — THE QUEUE IS FROZEN.** Read `current-plan.md` from its top
> (*QUEUE FREEZE*, *DIAL B*, *The critical path*). The TRIAGE and the 190-row
> queue this file and the 2026-08-13 handoff tell you to read moved verbatim to
> `current-plan-archive.md` and are dormant. Review convergence changed the same
> day: a round with zero production defects converges (`review-tiers`).

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

> **STALE — DO NOT ACT ON THIS SECTION OR THE 2026-07-30 ADDENDUM BELOW.**
> The lanes named here are G3-era and long finished. **Start at**
> **[session-handoff-2026-08-13.md](session-handoff-2026-08-13.md)** — the live
> entry point: current lanes, the goal and its ONE remaining blocker, the
> queue triage, orchestrator behaviour, the errors that session made, and the
> traps waiting for you. **Read `current-plan.md` starting at its TRIAGE
> section — 134 rows, and about 115 of them are dormant.**
> ([session-handoff-2026-08-08.md](session-handoff-2026-08-08.md) is accurate
> for its own date but stale on lanes, the queue, and two pieces of doctrine.)
> Then [current-plan.md](current-plan.md),
> [purchasing-sales-v1-plan.md](purchasing-sales-v1-plan.md) and
> [ui-ux-remaining.md](ui-ux-remaining.md).
>
> **This banner has been lost once already**, to two sessions pushing to
> `main` concurrently. If it is missing again, the section below is still
> stale — check the dates before believing it.


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

---

# Session addendum — 2026-07-30, autonomous orchestration run

Written at handback. `main` at the commit this section lands on. The user ran an
overnight session in which the orchestrator drove Codex writers directly instead
of relaying prompts. This section records the live state and the traps found, so
the next session does not rediscover them.

## What landed

**`G3-P3` — inventory adjustment posting — is ACCEPTED and on `main`** (merge
`c3a926b`, reviewed SHA `3e813e3`). A movement can be posted atomically:
serialized per stock identity, bound to the frozen contract, idempotent on the
natural effect key. Thirteen rounds, full Critical chain, 32 observed controls.

## What is in flight, and where

Four worktrees hold uncommitted-or-unreviewed work. **None is on `main`.**

| Branch | Worktree | State |
|---|---|---|
| `packet/g3-p4` (G3-P4a, transfer) | `/home/rvham/2rain-greenfield-g3p4` | matrix-green at `41ceb638`; Fable **CONFIRM**, Codex **REVISE**×2; round 4 fixes authored |
| `packet/q1-p4` | `/home/rvham/2rain-greenfield-q1p4` | format/typecheck/lint clean at `c726634`; **matrix not yet re-run**; no review yet |
| `packet/g3-p4b` (stock count) | `/home/rvham/2rain-greenfield-g3p4b` | **PARTIAL, interrupted** at `f9e53b2` — writer died on a network failure, no report, ungated |
| `packet/g3-p6a` | `/home/rvham/2rain-greenfield-g3p6a` | **not started**; prompt staged, both bridges granted |

Prompts, launchers and every review artifact are in `~/2rain-missions/`.
`~/2rain-missions/run-matrix.sh` is a flock-serialized full-matrix runner —
matrices must never overlap.

## The two review findings G3-P4a still owes

Both verified by the orchestrator before ruling. Round 4 addressed them; **the
round-4 work has not been re-reviewed and the matrix has not been re-run.**

1. **A persisted artifact's input shape changed without versioning.**
   `digestCommand` on `main` is `canonicalize(semanticInput)`; on the branch it is
   `canonicalize({postingRole, ...semanticInput})`. That value persists as
   `input_digest` and is read back to decide replay versus conflict. Folding the
   role in is *correct*; leaving it unversioned is the defect. This is the
   **version-from-artifact rule**, now found violated in **six** layers.
2. **A monetary-absence gate that cannot see a monetary field held as a value.**
   `objectKeys` collects only property *names*, so a persisted
   `{fieldId: 'unitCost', newState: {value: '1.00'}}` is invisible to it.

## Blocking discoveries — these are structural, not scheduling

- **`G3-P5` cannot be built yet.** `onHand` must scope by the stock tuple
  `(legalEntityId, itemId, locationId)`, but `module-runtime-interpreter.ts`
  contains **zero** occurrences of legal entity. A registered aggregate would sum
  across legal entities and return a confidently wrong balance. Row `q1-p4` exists
  to fix it. Root cause: **`G3-P1` was chartered by `G3-P0.md:94` to freeze the
  "operation/query shape" for legal entity and froze only the storage half** — the
  frozen contract has families, relation semantics and diagnostics, no query shape.
- **A canonical language-version event was proposed and DECLINED.** The lane wanted
  new canonical spellings plus language v4. Precedent says otherwise:
  `LEGAL_ENTITY_FAMILY_RULES` lives in `conformance.ts:433` and appears **zero**
  times in `packages/canonical-model/` — this program adds legal-entity semantics
  with no canonical spelling. On re-analysis the lane agreed.
- **`G3-P6a` is serial behind `G3-P4a`, not parked by choice.** Mounting inventory
  duplicates the manual composition in `loadInventoryDefinition()`
  (`inventory-posting.test.ts`), which would break the fixture's compile and
  **silently bypass G3-P3's 32 controls**. The mount and the fixture repair are one
  atomic change, and there is no gateable subset because the nav assertion stays red
  until inventory mounts.

## Traps that cost real time — do not rediscover

- **`ADR-0027` is claimed TWICE** — by `G3-P4a` (transfer) and by `q1-p4`
  (issued legal-entity read scope). Concurrent packets, same next free number.
  Renumber `q1-p4`'s to `ADR-0028` at integration; `G3-P4b` was pointed at
  `ADR-0029`.
- **Spawned writers cannot run the gates they claim.** No Docker socket, no
  `pnpm exec`, and a fresh worktree has no `node_modules` at all. Three separate
  matrix slots were burned on Prettier and typecheck failures a writer could not
  have caught. **Run format + typecheck locally before ever launching a matrix** —
  they cost forty seconds and catch most failures.
- **Never infer a launcher failed from output-file size.** `claude -p … > file`
  truncates at launch and writes at exit; a mid-run size check reads zero bytes.
  Ledger row `1d` was wrong for two days because of this. Wait for process exit;
  the launchers now write a `.done` marker.
- **Load corrupts matrices.** A composed-application test timed out at 120 s while
  the orchestrator ran an app server, a database container, migrations and seeding
  concurrently; the identical SHA passed clean on a quiet machine. **Never raise a
  bound to make a loaded run pass** — re-measure quiescent instead.
- **A single green run of a nondeterministic test proves nothing.** `G3-P3`'s
  twelfth control was reported verified from one isolated green run; it was a coin
  flip, because the fixture freezes `recordedAt` so a random UUID decided the
  binding movement.
- **The derived-key fixture trap.** `defaultFieldValue` builds required text from
  `recordId.slice(0, 8)` and `seedDraft` builds the transaction business key from
  `transactionId.slice(0, 12)`. Fixture ids share long prefixes, so two records
  collide on a case-insensitive unique business key. Mint ids; override unique
  fields explicitly.

## Standing lesson from this run

**Every one of the six lane stops was correct**, and four were caused by the
orchestrator's own prompts omitting paths the work obviously needed
(`app/builder.ts`, `docs/decisions/**`). Two produced better plans than either
option offered — the `G3-P4`/`G3-P4b` split, and the refusal of language v4.
Verify a stop by reading before overriding it.


## `G3-P4b` was interrupted — read this before trusting its branch

Its writer **died on a network failure** (`failed to lookup address information`
on the websocket to the Codex backend), not on anything in the code. It exited
with status 1, wrote **no report**, and left seven partially-edited files.

Those are committed at `f9e53b2` purely so they survive. **The commit is
incomplete and ungated**: never formatted, typechecked, linted, tested or
reviewed, and the dependency-set v4 before/after roots the packet owes are not
recorded. There is no account of what the writer intended or checked.

Re-running from `~/2rain-missions/g3-p4b.prompt.md` on a fresh branch is probably
cheaper than auditing a half-finished edit. If you do keep it, **its migration is
numbered `0018` and must become `0017`** — `G3-P4a`'s was renumbered to `0016`, and
`migrations.ts:248` requires a contiguous stream.

**`G3-P4b` cuts dependency-set v4** — a governed protocol version event that
`G3-P0` item 7 permits, provided before/after roots are recorded. Check that its
report records them.

## Immediate next steps, in order

1. **`G3-P4a` is one matrix away from re-review.** It is at `ebea719` with round-4
   fixes committed and format/typecheck/lint green. Run
   `~/2rain-missions/run-matrix.sh g3p4a /home/rvham/2rain-greenfield-g3p4`.
   Its migration was renumbered `0017` → `0016` because
   `migrations.ts:248` requires a contiguous stream and `main` is at `0015`.
   On green it needs a **re-review of the round-4 delta only** — Fable already
   CONFIRMed at `41ceb638`, Codex REVISEd twice and both findings are addressed.
2. **Then `G3-P6a` immediately.** Prompt at `~/2rain-missions/g3-p6a-r2.prompt.md`,
   both bridges already granted, worktree exists. It must be refreshed from `main`
   first, because it edits the fixture `G3-P4a` just changed. Verify its fixture
   rewrite against `/tmp/p3-accepted-controls.txt` — the 32 control labels observed
   in `G3-P3`'s accepted matrix — so no control is silently dropped.
3. **`Q1-P4` needs its matrix re-run** at `c726634` (the first attempt failed on
   Prettier only, now fixed) and has had **no review at all**. It is the hard
   prerequisite of `G3-P5`.
4. **Renumber `Q1-P4`'s ADR to `0028`** before integrating it — it currently
   collides with `G3-P4a`'s `ADR-0027`.
