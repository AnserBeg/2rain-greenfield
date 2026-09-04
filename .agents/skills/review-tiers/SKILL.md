---
name: review-tiers
description: How much to review, and scoped to what actually reduces risk.
  Read before launching any writer or reviewer. Covers the seat/model matrix
  (intensity), the mandatory review charter (scope), proportionality, findings
  triage, and anti-spiral convergence, so review is never an open-ended hunt.
---

# Review — scoped, finite, proportionate

## What review is for

Review catches defects the deterministic gates (typecheck, tests, verifiers,
the boundary checker) cannot. It is a **scoped, finite check**, never an
open-ended adversarial hunt, and its cost must be proportionate to the risk it
actually reduces.

Two failure modes are equally wrong: under-reviewing genuinely risky logic,
and over-reviewing where deterministic gates or human judgment already settle
correctness. Most of this program's pain has come from the second.

Anti-principle — never frame a review as "find any way this could fail" or
"find any way this could be evaded." Any artifact can be broken by a
sufficiently exotic hypothetical, so an unbounded hunt never converges (it is
what produced the P3 gold-plating spiral). Review asks specific, bounded
questions and stops.

## Two independent dials

- **Tier** sets review INTENSITY — how many seats and which models.
- **Charter** sets review SCOPE — what the reviewer checks and, explicitly,
  what it does not.

A high tier does NOT mean infinite scrutiny. It means a stronger reviewer
applied to the same bounded charter.

## Tier — intensity (classify by the final diff)

- **Mechanical** — docs, config, renames, test-only, scaffolding, bulk
  artifacts; no product logic.
- **Behavioral** — product behavior outside the spine.
- **Critical** — novel, hard-to-test, high-consequence LOGIC: release kernel,
  compiler, semantic gateways, inventory posting, tenant isolation/policy,
  trust substrate, migrations.

Tier is set by what the diff **does**, not by where it lives; when genuinely in
doubt take the higher. A higher tier raises reviewer strength, not scope — the
charter still bounds it.

**Location is not tier — calibrated 2026-07-31.** Touching a Critical subsystem
is not the same as changing its logic. In a platform whose product *is* a
compiler, a release kernel and a posting engine, the subsystem list above covers
almost every file, so read it as naming where high-consequence logic tends to
live, not as an address filter.

Inside a Critical subsystem, these are **Behavioral**:

- registering a file, script, or test in an inventory;
- adding or repairing a test or control without changing the code under test;
- wiring an existing, already-reviewed mechanism into a new call site;
- renames, moves, and type-only changes with no behavioural delta;
- regenerating a compiled artifact from an unchanged generator.

These stay **Critical** wherever they live: new or changed invariants, privilege
and tenancy boundaries, migrations, anything altering what a gate proves, and
anything whose failure mode is a silently wrong answer rather than a crash.

**Why this needed saying.** A ledger count on 2026-07-31 read **59 Critical, 18
Mechanical, 13 Behavioral** — Critical was 66% of all tiered work. A tier
carrying two-thirds of the load is the default, not a tier, and Critical is the
expensive one: two sequential model reviews on a frozen SHA. The cost of
mis-tiering upward is not zero, and spending Critical review everywhere spends
it nowhere in particular.

| Tier | Writer | Review |
|---|---|---|
| Mechanical | codex `gpt-5.6-sol` high, or orchestrator for trivial diffs | orchestrator verification against the deterministic gates; add one scoped pass only if the gates do not fully prove correctness |
| Behavioral | codex `gpt-5.6-sol` high | one fresh naive codex xhigh review against the charter -> bounded fix loop |
| Critical | codex `gpt-5.6-sol` xhigh | fresh naive codex xhigh against the charter to PASS, then Fable max confirm on the identical SHA |

### Reviews are run by the USER, in a separate online reviewer — BINDING, 2026-08-13

**A lane never executes its own review arm.** Not in-process, not by shelling out
to a reviewer CLI, and **not by spawning a subagent, task, or helper of any kind.**
The same prohibition binds the orchestrator except for the narrow `local-confirm`
case below.

**The mechanism is always the same:** the lane freezes, writes the complete
pasteable prompt into its report, and **STOPS**. The user copies that prompt into
an online reviewer and pastes the verdict back. **A lane that reports a verdict it
obtained itself has not been reviewed** — it has marked its own work, which is the
entire failure the fresh-naive rule exists to prevent, and no amount of prompt
hygiene repairs it.

**This corrects earlier guidance in this skill**, which read *"Fable runs via the
WSL binary. Both reviewer commands acquire the repository's shared test lock:
`node scripts/run-with-test-lock.mjs shared -- claude -p --model fable --effort
max`."* **That line is withdrawn.** It described a local invocation and, sitting
directly under the tier table, read as an instruction to run the arm in the lane.
Reviewer effort still matters — codex max effort is `xhigh`, there is no valid
"ultra" — but **where the reviewer runs is not the lane's choice, and the answer
is: not here.**

**The one exception, and it is the orchestrator's alone.** When an owed arm cannot
be obtained, the orchestrator may perform a `local-confirm` — recorded under that
name in `review-log.md`, **with its limits written into the row**, always including
that it was not fresh-naive. A `local-confirm` never upgrades a packet past
`evidence_ready` on its own, and the independent arm stays owed. A lane may not
perform one.

- The Fable confirm is for Critical **logic**. For document/config packets it
  is optional — the human read or the deterministic gate is the real review.
- If the confirm arm cannot be obtained, a Critical-logic result stays
  `evidence_ready`. **Waiting is the correct outcome; self-review is not.**

## Evidence depth follows FAILURE OBSERVABILITY, not file location (binding, 2026-08-21)

**`AGENTS.md` §6 requires "a negative control for each way it could pass vacuously
— one recorded red per vacuity vector, not one red overall", and lists five
vectors.** That is a safety-critical standard. **It is correct for a posting
engine and wrong for a label renderer**, and applying it uniformly has been taxing
this program without buying safety where safety is absent.

**The calibrating question is not what tier the packet is, nor where the file
lives. It is: if this control were vacuous, when would anyone find out?**

### Band A — SILENT. The failure is invisible until something else reconciles it.

Stored values, balances, postings, lineage, tenancy and privilege boundaries,
idempotency, anything a later reader would take as true.

**Full §6 applies: one recorded red per vacuity vector, each varying exactly one
property, plus the admission twin.** No relaxation. **A wrong balance is not
discovered by looking at it.**

### Band B — VISIBLE ON USE. The failure appears to whoever next exercises the path.

Refusal messages, rendered controls, command order, labels, list behaviour,
diagnostics — anything an operator meets the first time they use it.

**One discriminating recorded red per CLAIM, not per vacuity vector.** The control
must still die when its subject dies, and the claim must still not exceed what the
control proves. **What is no longer owed is enumerating five vacuity vectors for a
label.** Name the vectors you did not individually control and why.

### Band C — VISIBLE ON READ. The failure is apparent from reading the artifact.

Docs, records, comments, narrative, inventories.

**The deterministic gate plus a stated limit. No mutation control is owed.**

### The rules that do NOT relax at any band

- **A committed control must die alone.** If you ship it, deleting its subject must
  red it. This is cheap and it is where most of this program's defects have lived.
- **The claim must never exceed the evidence.** Narrowing the claim is always an
  acceptable correction and is usually the cheaper one.
- **Band is declared by the packet and checked by the reviewer.** An undeclared band
  is Band A by default. **A packet may not quietly self-assign downward.**

### Why this exists

**Measured across 2026-08: every packet applied Band-A rigour.** A presentation
packet spent three review rounds on control attribution for a heading census and a
Save button — failures an operator meets on first sight. **The same month, Band-A
work found a posted-to-draft-to-re-post double-post and a guard that admitted its
own defect at a different line.** Those are the failures the standard exists for.

**Spending Band-A evidence everywhere spends it nowhere in particular** — the same
argument this skill already makes about Critical carrying 66% of tiered work.

## Proportionality — is a review even the right instrument?

Match the check to what the deterministic gates already cover:

- **A deterministic gate fully proves correctness** (mechanical freeze + a
  passing verifier, config + green build, generated artifact + shape check):
  the review IS orchestrator verification against that gate. Do not spawn an
  adversarial LLM review that can only invent scope.
- **Documents (ADRs, plans):** the primary review is the human read for
  one-owner, consistency, completeness, and whether the decision is right. One
  scoped AI consistency pass at most; no evasion hunt.
- **Bulk / mechanical artifacts (freezes, generated data, large diffs):**
  review the SHAPE, the deterministic verifier, and a bounded sample. Never
  enumerate every file — recursive enumeration is itself a review defect.
- **Novel logic:** this is where fresh multi-model review earns its cost.
  Spend it here, bounded by the charter.

## The review charter (mandatory in every review prompt)

Every review spawn receives, and acts only within:

1. **Gates already green** — the deterministic checks that passed, so the
   reviewer does not re-derive what tests prove.
2. **In scope** — the specific defect classes to check ("does this break
   invariant X"; "is the plain form of boundary Y rejected").
3. **Out of scope (explicit)** — named, so the reviewer does not chase it.
4. **Threat model** — for anything security/safety-adjacent, the realistic
   adversary and failure AT THIS STAGE. Foundation-stage default: accidental
   and plain violations by honest developers or AI writers, NOT active
   obfuscation. Adversarial-evasion robustness is deferred and recorded as
   future hardening until real product code and a concrete threat exist.
5. **Decisive questions** — specific and bounded. Never "find anything wrong."

A review prompt without an explicit charter is invalid; do not launch it.

**This does not conflict with `mission-cadence`'s lane-written prompts, and the
cross-reference is here because it read as a conflict for a week and a reviewer
had to adjudicate it mid-review.** That skill requires every lane-written prompt
to declare that **the lane** fenced nothing. **The charter is still mandatory and
still the orchestrator's.** A lane may state its claims and its gaps; it may not
narrow the review of its own work. A prompt whose scope was drawn by the reviewed
party is invalid under this section however well written, and a prompt asserting
that *nothing* bounds scope is invalid under it too — that wording is corrected.
See `mission-cadence`, "The lane writes its own review prompt". `AGENTS.md` §1's
authority order does not rank two same-level skills, so neither overrides the
other; they are one rule stated from opposite ends.

## Findings triage (binding)

A finding is actionable only if ALL of these hold:

- **in scope** per the charter;
- **material** — a real, reachable failure, not a theoretical or exotic one;
  and
- **proportionate** — the fix does not balloon the packet's scope.

Otherwise:

- valid but out of scope -> RECORD as a future-work / known-limitation row; do
  not fix now;
- theoretical or unreachable -> note and dismiss;
- a fix that would materially expand the packet -> STOP and surface to the
  user. The writer never expands a packet's scope to satisfy a finding without
  user sign-off. This is the anti-gold-plating rule.

## Convergence (anti-spiral)

**Superseded 2026-08-10. The old rule was "at most two REVISE rounds." Counting
rounds is the wrong instrument: it stopped packets that were converging and it
let packets that were spiralling run to five and six arms anyway. What predicts
a wasted round is not how many have happened — it is WHERE the defect sits,
WHETHER its class is new, and above all WHETHER the previous fix subsumed the
last one or merely sat beside it.**

Ask three questions of every round after the first.

### 1. Where does the defect live?

- **In production** → **CONTINUE.** A round that finds a production defect has
  paid for itself regardless of its number. `lock-obs` found a lock bypassable
  through a trusted inherited environment variable at round 2 and a *regression
  introduced by round 3's own fix* at round 4. `5g3-sm-impl` found a declared
  permission that reached nothing at round 1 and a sixth version omission at
  round 2. None of those should have been capped.
- **In the control** → go to question 2. This is where judgement is needed.
- **In the claim's prose, not the code** → **ONE narrowing round, then STOP.**
  When a lane's own summary is "my prose overstated my code", the fix is the
  sentence. Rewrite the claim from the measurement and ship. Do not re-open the
  implementation to make the old sentence true.

### 2. Is the class new, or the same one again?

- **New class** → **CONTINUE.** Independent failure modes are what more arms buy.
- **Same class, new instance** → go to question 3. **This is the decision.**

### 3. Did the last fix SUBSUME the previous one, or sit BESIDE it?

**This is the load-bearing test, and it is answerable by looking at the two
fixes side by side.**

- **Subsuming (converging) → CONTINUE.** Each fix is strictly more general than
  the one before, so the class is being closed rather than patched.
  `LANG-ADOPT-v5` is the worked example: a textual strip that deleted its own
  subject → parse the AST instead; a rename that changed the subject's name →
  resolve import bindings rather than identifier spellings; a glob that never
  reached the subject → pin the subject by name. **Three rounds, three erasure
  modes, and each fix moved up a level rather than adding a case.** That packet
  was right to run three rounds and the old cap would have stopped it at two.
- **Enumerating (diverging) → STOP and route the class.** Each fix sits beside
  the last: another specimen, another predicate, another entry in a list.
  `U5b` ruled a narrower predicate five times and each narrower predicate was
  escaped. `5g3-sm-impl` rounds 3–5 added specimens to one table when the
  correct move was to narrow the claim. **In both, the shape survived every
  correction, which is the definition of a mis-scoped charter.**

### Two overrides that beat all three questions

- **A regression introduced by the previous round's fix → ALWAYS CONTINUE**, and
  require a control for the fix itself. Corrections are being shipped without
  evidence, and stopping leaves a live regression in the tree. This is
  `lock-obs` round 4.
- **Blast radius raises the bar for stopping.** A permission that is declared and
  unreachable, a lock that can be bypassed, a write path that corrupts — keep
  going. Label ordering does not earn a fourth arm; route it. Tier the
  continuation by what being wrong costs, not by how interesting the finding is.

### Zero production defects → CONVERGED — binding 2026-09-01, user ruling

**A review round that finds no defect in production code converges the review.
No further arm of any kind is owed** — not round N+1, not the Fable confirm — and
the packet proceeds to integration once that round's findings are closed and the
gates that read what changed have been re-run at the new head.

**Production means** `packages/**`, `apps/**` (excluding the regenerated
`apps/web/release/**`) and `db/**`. Findings in tests, evidence manifests,
controls, records, prompts or prose are not production defects. Closing them is
still mandatory — STOP never means ship it broken — and where the finding is a
missing or vacuous control, the lane records the replacement control's **measured
kill** before reporting the round closed. No arm re-reads that closure.

**Why this is doctrine rather than an override.** It was applied by user ruling
to `posting-error-shape` (2026-08-23: five rounds, none on production),
`posting-writer-inventory` (2026-08-31: round 2 found zero production defects)
and `PUR-2b` (2026-09-01: two rounds, both evidence gaps). Each time the
orchestrator recommended another arm and was overruled, and each time the
overrule was right: the reviews had stopped finding defects and started finding
limits. Writing it here removes that negotiation from every remaining packet.

**Two overrides still beat it, unchanged from above:** a regression introduced by
the previous round's own fix → continue, with a control for the fix; and blast
radius — a Band A silent-failure claim whose only control the round found
vacuous is not converged until the replacement control's kill is observed, though
no new arm is owed for observing it.

**What this does not change.** The FIRST arm is still owed on every
non-Mechanical packet, still fresh-naive, still user-run. A round that finds a
production defect still continues per the three questions above. A packet whose
first arm finds nothing at all is converged at round one.

### What STOP means — it is never "ship it broken"

**Route the class to a queue row, narrow the claim to what was actually
measured, and declare the limit where a reader will hit it.** `U5b` is the model:
capped, routed to `U5c`, and it shipped a **refusal** as its feature rather than
a half-built rule. A stopped packet states what it does not know.

### The backstop, which is a forcing function and not a wall

**From round three onward, the orchestrator must write down which criterion
licenses continuing — in the packet record, naming it.** If no criterion fits,
that is the stop. The count no longer ends the review; it triggers the
justification. **An orchestrator who cannot name the criterion is chasing.**

### Still binding regardless of round

- Each new round addresses only the in-scope, material findings from the prior
  round — never newly invented broader scrutiny.
- **If successive rounds keep finding things the lane's own checklist would have
  caught — the deletion question, a one-property mutation, a presence/absence
  pair — the defect is in the lane's process, not the code.** Route it to
  doctrine and stop spending arms on it.

## Arm instruments — pick the narrowest that can carry the verdict (2026-08-21)

**A packet cannot be accepted without a PASS, because a REVISE accepts nothing.**
That much is fixed. **What is NOT fixed is how much the arm must re-derive**, and
choosing a fresh-naive re-read where a narrow confirm suffices is the
over-reviewing this skill already warns costs more than under-reviewing.

**Three instruments. Choose by what the correction changed, not by round number.**

| the correction changed | instrument | the arm re-derives |
|---|---|---|
| production behaviour | **fresh-naive arm** | everything; nothing is settled |
| controls or evidence | **narrow confirm** | only the changed control and its survivors |
| records, prose, or comments | **narrow confirm** | only whether it now says what is true |

**A narrow confirm is a real arm with a real verdict.** It differs from a
fresh-naive one in what it is TOLD: that production is byte-identical to a SHA a
prior arm endorsed, which decisive questions already closed, and that it should
not reopen them without concrete evidence from this candidate. **Prove the
byte-identity and quote the command** — the reviewer must not take it on trust.

**The confirm arm follows the identical-tree rule too.** If Fable already passed a
production tree and the only later change is records, prose or a control, **a fresh
Fable confirm re-reads bytes it has already cleared.** Re-run it when executable
behaviour moved; scope it to the delta otherwise. This mirrors `git-workflow`'s
matrix rule and rests on the same reasoning: a second pass over the same bytes
observes nothing.

### Pre-arm verification — the orchestrator checks what is mechanical

**Before an arm goes out, the orchestrator verifies by execution or by command
every claim in the prompt that a machine can settle** — SHA presence on `origin`,
byte-identity of production across the correction, whether a named survivor
actually survives, whether a cited symbol exists.

**Then it hands the results to the arm as established**, so the review spends
itself on judgement rather than re-derivation.

**Measured value:** every time this was done it either pre-answered a decisive
question or caught a defect before the round. On one packet the orchestrator ran
the reviewer's proposed survivor directly and found the control green under it,
turning a disputed claim into a settled one in two minutes. **On another it found
the survivor did NOT reproduce, which would otherwise have cost a full round.**

**It is not a substitute for the arm.** A `local-confirm` never upgrades a packet
past `evidence_ready` on its own, and pre-arm verification is weaker than that —
it is mechanical checking, not review.

## Fresh-naive mechanics (still binding)

- Every review and re-review is a NEW spawn with zero planning context: only
  the frozen SHA/diff, owned paths, and the charter. Never resume or extend a
  prior reviewer (anchoring bias).
- Verdicts: PASS / REVISE (in-scope material findings) / BLOCK (design-level;
  back to the user).
- The orchestrator adjudicates by reading the code; a finding's survival
  depends on the charter and materiality, not on the reviewer's confidence.
- Launch reviews with the `node scripts/run-with-test-lock.mjs shared -- codex
  exec ... -s read-only --output-last-message` subprocess method (it returns a
  captured verdict); do not use unbounded background-agent polling. The shared
  lease mechanically prevents a review from competing with a matrix or the
  exclusive performance gate.
- Binding design authority a review depends on (debate verdicts, ADRs) lives
  IN-REPO — debate outcomes under `docs/execution/debates/` — so a sandboxed
  reviewer reads the primary source, not a restatement. A charter may summarize
  it, but the charter's summary must never be the only place it exists.

## SHA discipline (still binding)

Writer freezes a candidate SHA -> review runs against that SHA only -> any fix
is a new SHA and a fresh, charter-scoped review -> the accepted SHA is recorded
in the ledger and packet record.

## Evidence record (per packet)

Writer seat; each review spawn with its charter, verdict, and findings
disposition (fixed / recorded-as-future / dismissed); final SHA; gate outputs.
Keep it in the packet record.

## When a packet stalls, the confirm arm is denied exactly when it is worth most

**Added 2026-08-03, from `G3-R1`.** Critical tier runs Codex first and the Fable
confirm only after Codex passes. That ordering is right for a healthy packet —
the confirm arm should review a stable tree, not a moving target.

It fails badly for a struggling one. `G3-R1` took **nine review rounds across
three charters and Fable never ran once**. Every round was Codex assessing
whether the *code* satisfied a charter, and nobody independently assessed
whether the *charter* was right. It was not: it named three arms and never
defined what makes a comparison set complete, so each round found one more
uncompared field and the regress could not terminate.

The orchestrator wrote that charter, corrected it twice, and was still wrong the
third time. A single reviewer looping on the same question cannot surface that;
it is not the question they were asked.

**So: whenever the convergence criteria say STOP because the fixes are
enumerating rather than subsuming, the orchestrator may commission the next arm
as an INDEPENDENT SCOPE REVIEW rather than a confirm.** Its charter asks *"is this packet being asked the right
question?"* — not *"is this code correct?"* It reviews the ruling, the charter
and the packet record, and it may conclude the orchestrator is wrong.

This does not replace the confirm arm; the packet still needs one before it
lands. It buys a second perspective at the point where one reviewer and one
orchestrator have demonstrably converged on the wrong frame.


## Does the evidence prove the claim? — the checklist, added 2026-08-08

**Every section from here down is one principle with a different face:** a control
can pass while the claim above it is false. They were written one at a time as each
was measured, and by 2026-08-08 there were fourteen of them. **Read this checklist;
open a section only when it fires.**

Run it against any control before submitting it for review, and against any claim
ledger while reviewing one:

| Ask | Fails when | Section |
|---|---|---|
| Is there a control at all? | A claim was **fenced as settled** with nothing behind it — one shipped four rounds that way | *A fenced claim without a control* |
| Does the control prove the claim, or its **premise**? | A failure message names a value the assertion never reads | *A control can guard the premise* |
| Does the specimen vary **one** property? | A forged case is wrong two ways, so deleting either check keeps it green | *A negative control must vary one property* |
| Does each **check** die alone? | Asked of the control it passes; asked per check, a third is decorative | *Ask the deletion question of each check* |
| Is the refusal **discriminating**? | A guard that refuses everything satisfies a refusal-only test | *A refusal control needs its admission twin* |
| Do the red **names** map to distinct specimens? | Two subtests build the same payload — four names, three specimens | *A red count is not attribution* |
| Did the red fire for the **stated** reason? | A red that reds for the wrong cause looks like evidence | *Verify why a red fired* |
| Is the harness **in the tree**? | A mutation table nobody can re-derive | *An uncommitted harness is not evidence* |
| Who **chose** the mutations? | Self-chosen tables measure the author's model | *Self-chosen mutations* |
| Was the result **observed** or expected? | A probe reports runs its branch cannot produce | *A probe's results must be reproducible* |
| Is the claim written **from** the measurement? | The comment states the aspiration; the specimens do less | *Write the claim from the measurement* |
| Could the wrong thing be **unrepresentable** instead? | A detector gets evaded; a value that cannot be passed cannot be misused | *prefer unrepresentable to detectable* |

**Two standing consequences.** After **two rounds** of a claim outrunning its
specimens, **narrow the claim** rather than grow the table — the tell is that the
control keeps growing while the production code has not changed. And **rounds one
and two find production defects; rounds three and beyond find control defects** —
when that transition happens, the loop has stopped being about the code.

**Why this file is long.** Each section below carries the measurement that earned
it, and those measurements are why the rules are credible rather than tasteful.
**The checklist is the entry point; the sections are the evidence.** If this list
grows past roughly fifteen rows, consolidate again rather than appending — doctrine
nobody reads to the bottom of is not doctrine.

## Acceptance requires a recorded verdict — executable since 2026-08-06

`scripts/check-review-record.sh` fails when executable work sits on `main`
newer than the newest verdict in `docs/execution/review-log.md`, and the
`post-merge` hook runs it at every integration. Record the verdict there —
SHA, packet, arm, verdict, date — as part of accepting, not afterwards.

**Why it is executable.** On 2026-08-06 `U2` and `U2-fix` were each integrated
with no review arm. Both times the orchestrator had verified the work personally
and both times that was insufficient for the same structural reason: the
orchestrator had written the revision specification, so the check was against its
own instructions rather than against the ADR. Both times the omission was caught
by the **user asking whether a review was owed**. When the reviews finally ran,
both returned BLOCK, and between them they found a focus ring below the WCAG
floor on two shipped states, an unreachable alignment path, and a gate that had
*deleted* a rendered observation and replaced it with declaration inference.

A declared rule the orchestrator must remember is the same shape as the push rule
that lapsed for eight days and 637 commits. This is the gate.

**Read the green honestly.** It proves a verdict was *recorded*, not that a
review happened and not that it was good — a BLOCK is a valid record. And it
measures against the newest record only, so if two packets land and only the
later is recorded, the earlier passes. Closing that needs per-packet grouping via
the `Packet:` trailer `git-workflow` already requires and which **no lane commit
since the baseline carries** — a gap the gate found on its first run.

**The gate shipped with a vacuity of its own, which is the part worth keeping.**
Its first formulation asked *"does any record contain this commit?"*. `main` is
linear, so every commit before any recorded SHA is an ancestor of one, and a
single late record silently covered all of history. It passed its unit controls
and it passed live. It was caught only by pushing a negative control until it
*should* have tripped and noticing it did not — then, when reaching backwards
could not trip it either, by building a scratch branch carrying an unrecorded
executable commit and proving the gate fired on it.

> **A negative control that never actually reds is not a control.** Run it until
> you have seen the failure, or you have written a test for a gate you have not
> tested.

## Archived sections — moved verbatim 2026-09-01 to [ARCHIVE.md](ARCHIVE.md)

Applied on `5g3-prog` (both arms): this file had grown to 1,069 lines against its
own consolidation bound and was the largest mandatory read for every lane and
reviewer. The sections below are the dated lessons of 2026-08-06 to 2026-08-09;
each remains binding where a record cites it, and a citation of the form
*`review-tiers`, "<section title>"* resolves to `ARCHIVE.md`. Nothing above this
line moved.

- A read count is not a proof — added 2026-08-06
- How to write a review prompt — measured 2026-08-06
- Verify why a red fired, not just that it fired — added 2026-08-06
- An uncommitted harness is not evidence — added 2026-08-08
- Re-tier when the diff outgrows the row — measured 2026-08-08
- A fenced claim without a control is never checked again — added 2026-08-08
- A probe's results must be reproducible from its branch — added 2026-08-08
- Verify the target is on `origin` before writing the prompt — added 2026-08-08
- Self-chosen mutations are worth less than an independent replay — added 2026-08-08
- An ADR that packets will build against gets an external arm — added 2026-08-08
- A refusal control needs its admission twin — added 2026-08-08
- A negative control must vary one property — added 2026-08-08
- A red count is not attribution — and after two rounds, narrow the claim
- Write the claim from the measurement, and prefer unrepresentable to detectable
- For a merge, revert each parent's half alone — added 2026-08-09
