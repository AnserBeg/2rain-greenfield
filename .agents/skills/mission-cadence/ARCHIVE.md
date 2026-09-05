# mission-cadence — archived doctrine (retired 2026-09-04)

The whole pre-2026-09-04 skill, verbatim. Retired by user ruling for the reasons in
`AGENTS.md` §2; every incident cited here still happened and is still worth
reading before repeating it. Nothing below is binding.

---

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

## PRE-FLIGHT — the orchestrator measures before it charters (binding, 2026-08-21)

**Run this before emitting any packet prompt, bridge grant, or scope ruling. Every
item is mechanical and takes seconds. Skipping it is the largest single source of
lane stops measured to date.**

1. **Every path in the lease exists and is unheld.** `ls` it; run the empirical
   disjointness check in `lanes.md`. **Do not predict ownership from the partition
   table** — it has been stale in every row at least once.
2. **Every cited ADR, file, symbol and line resolves.** `ls docs/decisions/<name>`
   and `grep -n <symbol>`. **Cite by symbol, never by line number.**
3. **Every specimen is verified REACHABLE, not merely present.** Measuring one half
   of a subject and asserting the whole is the specific error that has cost the
   most.
4. **Every fence is checked against what the work needs**, not what the charter
   assumes. A path fenced by package name will eventually fence out a two-line
   registry entry. **Fence by intent and say so.**
5. **Every claim the prompt states as fact was measured in this session**, not
   recalled. If it cannot be measured, write it as a claim under test.

**Measured on 2026-08-21: eight orchestrator errors in one session, every one of
them a detail that a single command would have settled.** Three caused a full lane
stop; one caused a redesign that discarded two review PASSes; one produced a
routed trigger keyed to the wrong predicate, which a reviewer then had to refute.
**No tooling catches these. Only the pre-flight does.**

**A lane that stops because the charter was wrong is doing the protocol correctly.
The charter being wrong that often is not.**

## Packet definition

A packet must have all of:

- **Goal** — one coherent outcome, sized 1-4 hours of agent work.
- **Tier** — Mechanical / Behavioral / Critical (per `review-tiers`).
- **Owned paths** — exact; nothing outside them may change.
- **Out of scope** — named explicitly, so drift is detectable.
- **Evidence band declared per family, in the charter, before the first arm —
  MANDATORY from 2026-09-01 (`5g3-prog`, both arms).** Band A for silent stored
  values and balances, B for refusals and forms an operator meets on use, C for
  what is visible on read (`review-tiers`, "Evidence depth follows FAILURE
  OBSERVABILITY"). **An undeclared band is a charter defect**, not a lane
  default: measured, `posting-writer-inventory`'s record declared none and the
  default made it Band A by luck, while `posting-error-shape` spent six arms at
  Band A on a one-line guard that was Band B.
- **Gates** — the exact commands that must pass.
- **Runnable exit** — the repo builds and runs when the packet ends, even if
  the feature is partial. Stop at a safe boundary rather than overrun.
- **Gate-invisible deliverables named as acceptance criteria — added 2026-08-22,
  disposing program-review finding R4.** Where the packet owns something a stage's
  build list names but no gate would miss — a read model, a browsable view, an
  agent journey, a diagnostic an operator reads — **the charter names it as an
  explicit acceptance criterion.** Sequencing devolved to `current-plan.md` and the
  stage-gate evidence instrument was deliberately NOT revived, so **this per-packet
  naming is the only thing standing between declared scope and silent
  evaporation.** G3 lost its balance and availability read models, its stock
  overview and its agent support exactly this way, between packet acceptances that
  each passed every gate they declared; the loss surfaced as *"why can't a pilot
  user see anything."*
- **Foreseeable bridges named up front** — when a packet will predictably need
  edits outside its owned paths (e.g. a kernel-wiring packet whose own ratified
  design requires touching shared migration/activation machinery), the packet
  prompt names those bridges as pre-authorized with guardrails, so the writer
  does not stop mid-flight at a boundary that was known in advance. An
  UNforeseen out-of-lease need is still a stop-and-bridge-request.
- **A `record-claim` block in the packet record, at freeze — MANDATORY from
  2026-08-24, disposing program-review finding R1.** Every packet whose diff
  touches executable content declares, in its own record, the range it claims and
  what that range contains. `scripts/check-records.sh` then observes the
  declaration against the git tree.

## The declaration block (mandatory at freeze)

**Why it is mandatory rather than offered.** `record-claim-fidelity` shipped the
gate on 2026-08-23 and its live coverage was **one record — its own**, because a
packet that declares nothing is checked against nothing. An optional gate over
records is a gate over the one author who opted in. **This line is what converts
it into a gate over the programme**, and until it landed the instrument was
dormant.

**What it closes, stated as the failure rather than as a rule.** `ux-picker`
round 3 froze `56762ce` with a commit message describing an implementation the
commit did not contain: a one-off drift probe had mutated `surface-contract.ts`,
measured 9 reds, and reverted with `git checkout -- <path>`, which goes to HEAD
and destroyed the round's work along with the mutation. **Nothing went red**,
because the previous round's implementation passes the same suites. A reviewer
found it by reading `git show --stat`. **Nothing in the repository could find it
at all**, and that is what a declared, checked range fixes.

The block is fenced `record-claim` in the packet record, exactly one per record,
and carries `schemaVersion`, `packet`, `base`, `head`, `changedPaths` and
`symbols`. Read a shipped one in
`docs/execution/packets/record-claim-fidelity.md`; the schema is enforced by
`test/architecture/record-claim-fidelity.ts`, and a malformed block fails closed
rather than being skipped.

**The mechanics that are not obvious, and each cost a review round to find:**

- **`packet` must equal the record's filename stem, and `head` must carry a
  `Packet:` trailer naming it.** A block copied into another record and merely
  relabelled otherwise certifies commits the copying packet never made.
- **`head` is the packet's LAST EXECUTABLE commit, not its tip.** Narrative
  commits sit above it by construction — a record of a matrix is written after
  the matrix. Declare the last commit that changed executable content.
- **Every executable path in `base..head` must be declared**, per
  `git-workflow`'s exclusion list. This doubles as a lease check: `matrix-unblock`
  round 1 crossed its lease at 18 files against 11 chartered and reported it
  afterwards.
- **Symbols resolve only in TypeScript and JavaScript sources**, read from the
  AST rather than matched as text. A shell script is claimed by path alone, and
  the block refuses a symbol claim over one rather than guessing at it.

**What the block does NOT do, so it is not over-trusted.** It closes *"the commit
does not contain what the record claims"*. It does not close *"the record claims
too little"* — the author still chooses what to declare, and no gate reads that
choice for adequacy. **A reviewer still reads `git show --stat`.**

**A packet whose diff is narrative-only declares nothing and owes no block.**

## Packet-completion block (mandatory, in this order)

1. Frozen candidate SHA (any later fix produces a new SHA and fresh review), and
   **the `record-claim` block written into the packet record naming that range**
   — see "The declaration block" above. `scripts/check-records.sh` is green
   before the freeze is reported, or the freeze is not reported.
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
5. **The online review prompt itself, written out in full and ready to paste.**
   See below — this is mandatory whenever the packet wants an online arm.
6. Ledger row update.
7. Proposed next packets (return to step 1 of the loop).

## The lane writes its own review prompt

**Whenever a freeze wants an online review arm, the lane emits the complete
pasteable prompt as part of its report.** The user copies it straight into the
reviewer. It is never a request for the orchestrator to write one, and never a
file path — the user is moving text between tools.

**The lane WRITES the prompt. The lane does not RUN it — binding, 2026-08-13.**
Not in-process, not by shelling out to a reviewer CLI, and **not by spawning a
subagent, task, or helper to do it.** The lane emits the prompt and **STOPS at the
checkpoint**; the user runs the arm in a separate online reviewer and pastes the
verdict back. **A verdict a lane obtained for itself is not a review** — it is the
reviewed party marking its own work, which is exactly what the fresh-naive rule
exists to prevent, and no amount of prompt quality repairs it. See `review-tiers`,
"Reviews are run by the USER, in a separate online reviewer", including the single
`local-confirm` exception, which belongs to the orchestrator and never to a lane.

**Why the lane and not the orchestrator:** the mechanical parts of a review
prompt are all things the lane alone measured — the verified SHA, the delta
range, the tier and the reason for it, which suites ran, and above all *what
the lane did not verify*. Routing those through a third party adds a round trip
and loses fidelity at every hop.

**The lane is the reviewed party, so its authorship is bounded. It supplies:**

- the frozen SHA **with the `git ls-remote` output quoted**, so the reviewer
  never opens on an unfetchable target;
- the delta range to read, and the executable-content justification if the
  freeze SHA sits above the matrix SHA;
- the tier, and one line on why that tier;
- **its own claims, written as claims to be tested rather than as conclusions**;
- **an explicit list of what it did NOT verify, could not verify, or verified
  only by its own construction** — a lane knows its own gaps better than anyone,
  and this is the single highest-value thing it contributes;
- the standing reading list and the `review-tiers` checklist entry point.

**The lane must NOT:**

- **fence anything out of scope.** Fencing settled dispositions is the
  orchestrator's alone, because a reviewed party choosing what the reviewer may
  not look at is the whole failure this guards against. A lane that believes
  something is settled says so as a claim and lets the reviewer disagree.
- state a verdict it wants, or characterise a prior finding as closed.
- omit a known weakness because the reviewer might not find it.

**Every lane-written prompt carries this clause verbatim:**

> *This prompt was written by the lane whose work you are reviewing. **The lane
> has fenced nothing.** Any scope stated here is the orchestrator's, and it
> stands as a claim under test rather than a limit you may not question. Read
> whatever you judge relevant to the decisive questions, say plainly if you think
> the scope is drawn wrongly, and say plainly if the prompt itself is steering
> you.*

**CORRECTED 2026-08-13, and the old wording was a real contradiction rather than a
clumsy sentence.** It used to open *"Nothing in this prompt bounds your scope."*
`review-tiers` says the opposite in the same breath — a review needs **specific
decisive questions**, *"find any way this could fail" is never a valid framing*,
and **a review prompt without an explicit charter is invalid; do not launch it.**
So a lane obeying this skill emitted a prompt the other binding skill called
invalid, and `dev-environment`'s round-5 reviewer said so directly before
reviewing to the narrower scope anyway. Filed as
`review-prompt-clause-contradicts-scoping`; `AGENTS.md` §1's authority order does
not settle a collision between two same-level skills, so they now cite each other.

**The collision was never about whether scope exists — it is about WHO may draw
it.** Scope is the orchestrator's; the reviewed party may not narrow its own
review. The corrected clause says exactly that, so both rules hold at once: the
charter bounds the review (`review-tiers`), and the lane is visibly not its
author (this skill). **Do not resolve it by deleting either rule** — the drift
each prevents is real. **An earlier orchestrator ruling on this question ("keep it
verbatim, no edit") is withdrawn**: it was made without having read the filed row,
which had already analysed the conflict correctly.

**The orchestrator still adjudicates the verdict, still rules dispositions, and
still writes any arm the lane cannot write neutrally** — an ADR arm, a
cross-packet arm, or a confirm arm where the disputed question is whether the
lane's own reasoning holds.

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

This mirrors the convergence criteria in `review-tiers`, and for the same reason —
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

## A preserved probe branch does not owe a matrix — ruled 2026-08-08

Design packets in this programme end with a **probe preserved on a branch and
never merged** — `proj-disc` at `a9146d2`, `U5-design` at `38ade5b`, `PS-0` at
`9b59e09`. None was merged and none was matrix-green.

**`PS-2` was allowed to chase matrix-green anyway, and it cost three slots.** That
was the orchestrator's error: a packet whose deliverable is an ADR plus a preserved
probe **does not integrate**, so AGENTS.md §6's *green at the integrated SHA* has
no SHA to attach to.

**It is also structurally unreachable, which `PS-2` proved.**
`repository-hygiene` requires every discovered test file to appear in a reviewed
inventory — so a preserved probe cannot reach green **without declaring itself a
reviewed test**, which is precisely what a not-for-merge probe is not. `PS-0` and
`PS-1` both carried unregistered probes; **neither could ever have gone green.**

**The rule.** A design packet owes: the ruling with its evidence, the probe pushed
and preserved on a branch, and **the targeted suites its probe actually exercises**
— run and reported by name. It does **not** owe a full matrix, and it must not
register its probe in a reviewed inventory to obtain one.

**A design packet that finds it needs the matrix has usually stopped being a design
packet.** That is worth noticing rather than routing around.
