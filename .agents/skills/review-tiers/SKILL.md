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

## A read count is not a proof — added 2026-08-06

AGENTS.md section 6 requires a negative control per way a gate could pass
vacuously, and the standard instrument for the commonest vector — *the subject
was never there* — is a read-count guard: `assert.ok(subjectsRead > 0)`.

**A read count closes "nothing was there". It does not close "the thing there was
hollow."** Those are different vectors and the guard only looks like it covers
both.

`U2` shipped four gates, each with a read-count guard, and the online review
blocked all four on the same shape:

- Status chips were counted and their colours measured, but nothing checked they
  were **visible**. `display:none` still yields a computed colour, so every
  colour gate stayed green against a page showing no status at all.
- The expected coverage set was `[...builder.statusRoles]` — read from the same
  compiled fixture that rendered the page. Shrink the fixture and **both sides
  shrink together**. The comment above it claimed this stopped the subject
  shrinking.
- Three colour gates each proved a real fact — literals are in one block, tokens
  have contrast, rendered elements have contrast — and **nothing joined them**,
  so hardcoded `rgb()` in the status selectors satisfied all three while the
  doctrine those gates exist to enforce ("status colour resolves only from role
  tokens") was violated.
- `assert.notDeepEqual(darkPairs, lightPairs)` passed on **one** differing
  element, so three of four roles could carry light values into dark mode.

The generative question is not *did the gate read its subject?* It is:

> **What is the cheapest broken tree that keeps this gate green?**

Write that tree down. If you can describe it in a sentence, the gate is not yet a
gate. Then make the negative control **be** that tree, and prove it isolates —
`U2`'s round-2 routing control substitutes a contrast-safe, off-brand `hsl()` and
asserts contrast, separability and encoding all stay green while routing alone
reds. A control that reds several gates at once has not shown which one is
load-bearing.

Two corollaries worth carrying:

- **A gate that derives its expectation from its subject proves nothing.** Pin
  the expectation to something the subject cannot move — for `U2` that was the
  canonical `STATUS_ROLES`, already bound by the grammar pin.
- **A measurement that cannot fail is worse than no measurement.** `U2`'s
  `rgbToHex` discarded alpha, so an element with no background computed
  `rgba(0,0,0,0)` and was measured as **pure black** — a confident number for a
  colour that was not there. Refuse the input rather than truncating it.

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

## How to write a review prompt — measured 2026-08-06

Six online reviews ran that day: **five BLOCK, one PASS**. Tallying where each
finding actually came from is the whole basis for what follows.

**The orchestrator's question lists produced confirmations and one overturn.**
Asking whether the hex ratchet was blind to `rgb()` — it was. Asking whether the
focus ring blocked — the reviewer said yes and overturned the orchestrator,
correctly. Real value, but all of it was already suspected.

**Open reading produced every genuinely new structural defect:**

- `--truncate-invalid-lineage` broken by a signature change, in a file the prompt
  never mentioned.
- `readRenderedFocusRing` deleted and replaced with declaration inference — the
  orchestrator had audited what the packet *added* and never opened the 149
  deleted lines the diffstat showed.
- A focus ring at 2.08:1 and 2.92:1 on two real grounds, found by reading the
  **stylesheet** rather than the gate that claimed to cover it.

**And some questions were worse than useless:** `@media` recursion (nothing
there), test-timing variance (unanswerable without executing), a constructed
lineage (the orchestrator could settle it alone).

So the efficiency lever is **not shorter reviews — it is shorter question
lists.** The review pays for itself every time; the hypotheses are the waste.

### The rules that follow

1. **Point at the contract, not at your prompt.** *"Judge against ADR-00NN and
   AGENTS.md section 6, not against what I asked for."* This matters concretely:
   twice a lane corrected a wrong orchestrator instruction because the reviewer
   was anchored to the ADR instead of the prompt.
2. **Cap hypotheses at three, and say they are guesses.** Then add the sentence
   that would have saved two rounds: *"the most valuable finding is usually not
   on this list."* A long list consumes the budget that open reading needs.
3. **Always ask what was deleted.** *"What did this remove, and was it
   load-bearing?"* A packet that replaces an observation with a proxy shows up as
   a deletion count and nothing else. This is a standing question, not a
   per-packet one.
4. **Always ask the vacuity question.** *"For each gate, name the cheapest broken
   tree that keeps it green."* Highest hit rate of anything tried — it found the
   `display:none` chip, the fixture compared against itself, the `notDeepEqual`
   hole, and the emitted-but-never-red branch.
5. **Fence narrowly, and only what is settled.** "The approved palette is not open"
   is a good fence. Fencing a whole file is how the truncation defect would have
   been missed.
6. **Never ask what the reviewer cannot do, or what you can settle yourself.**
   They cannot execute; a timing question invites speculation dressed as a
   finding.
7. **Read the diff yourself before writing the list.** Writing questions first is
   how "media-query recursion" got in. Ask only what your own reading left open.

### Sizing

Full review when a candidate freezes. **Narrow confirm on the fix delta**, with
the prior round's CLOSED claims explicitly not reopened — the 61-line confirm that
closed `U2-fix-b` returned PASS quickly because it was not asked to re-read the
packet. Do not pay twice for the same reading.

### The shape

    Read <exact diff range>. <What the prior round closed, if any — not reopened.>
    Judge against <the ADR> and AGENTS.md section 6, not against this prompt.

    Three things I suspect, which are guesses rather than scope:
      1. … 2. … 3. …
    The most valuable finding is usually not on this list.

    Standing, every time:
      - What did this delete, and was it load-bearing?
      - For each gate, the cheapest broken tree that keeps it green.

    Settled, do not spend effort on: <narrow list, with the reason>.

    Report: CLOSED / STILL OPEN per claim with file and line; any new defect;
    one verdict. A clean review is a real outcome — say so plainly if you find
    nothing, and name the one thing you would most want executed.

## Verify why a red fired, not just that it fired — added 2026-08-06

A negative control that never reds is not a control. **A control that reds for the
wrong reason is not a control either** — and it is more dangerous, because it
looks like evidence.

`proj-disc-impl` caught three of these in one packet, each time by asking why the
failure happened rather than accepting it:

- A red that was a `ReferenceError` in the test, not the mutation.
- A red that was `git checkout -- <path>` destroying uncommitted source fixes, so
  the observed failures had nothing to do with the control. (`git-workflow` line
  192 already requires stashing or committing before any history-losing command;
  the rule lapsed twice in that packet.)
- A red that was PostgreSQL `42P18 could not determine data type of parameter $3`
  — a type error in the relaxed predicate, not the cardinality assertion it was
  meant to prove. Fixed with an explicit `::text` cast and re-run.

`U1` hit the mirror image in the same week: a hand-built aggregate fixture that
was **malformed**, so the refusal assertion passed for the wrong reason. Adding an
assertion on the error *message* — not just its class — exposed it, because
`MalformedPinnedQueryCatalogError` is also what a bad catalog raises.

So, when recording a red:

- **Read the failure text.** If it does not name the assertion you expected to
  break, the control proved nothing and the mutation may be untested.
- **Assert the message, not only the error class**, wherever one class covers
  several causes.
- **A red arriving faster or louder than expected is a reason to look, not to
  celebrate.** All three of the above looked like success at a glance.

## An uncommitted harness is not evidence — added 2026-08-08

`U5b` round 3 reported *"eleven mutations, no survivors,"* from a harness that
printed `*** SURVIVOR — NO RED ***` when a mutation produced nothing, and reported
that it never printed. **The harness was not in the committed tree.** The reviewer
could not reproduce the claim from the SHA, wrote its own eleven-mutation replay
against the same source predicates, and found **four survivors** — a required input
and an action button added without a watched token, a field read through
`record.values[...]`, and a confirmed capability command bound through the
read-back query.

**A mutation table is a claim about the committed controls. If the thing that
produced it is not committed, the claim cannot be checked and does not count.**
This is the same rule as *"a read count is not a proof"*, one level up: the lane's
own tooling is part of the evidence, not scaffolding around it.

Two consequences, both cheap:

- **Commit the harness** with the packet, wired into an executed suite, so the
  table can be re-derived rather than believed.
- **Prove the marker can fire.** Absence of a `SURVIVOR` line is the evidence, so
  a harness that can never print it produces a perfect table for free. The
  reviewer checked this explicitly and it is now a standing question.

**The generative form:** *if the tool that produced this evidence is not in the
tree, what would a reviewer have to take on trust?*

## Re-tier when the diff outgrows the row — measured 2026-08-08

Tier follows the final diff, which this file already says. **What it did not say is
that nothing triggers a re-check**, so a row tiered when it was a sentence of scope
keeps that tier after the packet becomes something else.

`lock-owner` and `matrix-contention` were filed **Mechanical** on a one-line
scope — *write the holder's pid into the lock file so the next starvation names its
cause.* The packet that implemented them shipped a 175-line lock wrapper, a
365-line registry, a new suite runner, changed acquisition modes on every test
entry point, and a **new invariant**: an inherited claim authorizes work only if
path, pid, start ticks, liveness, holding state and mode all validate. By this
file's own rule — *"these stay Critical wherever they live: new or changed
invariants"* — that is Critical, and it was reviewed as Critical for four rounds.

**The four rounds were not over-spend, and the orchestrator's first reading that
they were is the error being recorded here.** Round 1 found gates constructing the
records they then read; round 2 found the lock bypassable through an inherited
environment variable; round 3 found a reachable path that deletes a previous run's
evidence before failing to acquire; round 4 found a valid shared request refused
under a diagnostic naming an exclusive gate. **Three of the four would have
defeated the packet's stated purpose.**

**The rule:** before writing a review prompt, re-derive the tier **from the frozen
diff**, and correct the queue row when it disagrees. A row's tier is a forecast; the
diff is the fact.

**And the cheap self-check the orchestrator skipped:** before concluding a review
was too expensive, list what it found and ask whether shipping each finding would
have mattered. If the answer is yes, the cost was the price, not the waste. Round
4's finding was a **regression introduced by round 3's fix** — which is an argument
for reviewing corrections, not against.

## A fenced claim without a control is never checked again — added 2026-08-08

Review prompts fence settled ground so rounds do not re-litigate it. That is
correct and it has a cost nobody had named: **fencing removes a claim from review,
so a claim fenced without a control is a claim no one will ever check.**

`U5b` shipped `parseSlot`'s unknown-tier refusal in round 1. The orchestrator wrote
*"settled — do not spend effort: `parseSlot`'s round trip and unknown-tier
refusal"* into **three consecutive review prompts**. On round 4, an ad-hoc mutation
removing that refusal entirely **went green across every suite** — it had never had
a control, and three reviewers had been instructed not to look.

**The rule:** before fencing a claim as settled, name the control that holds it.
If you cannot name one, it is not settled — it is unexamined, and fencing it makes
that permanent. A `CLOSED` row in a claim ledger is a report of a control, not a
substitute for one.

**The generative question when writing a fence:** *what would go red if this
were deleted?*

**And say what you are deleting the evidence for — added 2026-08-08, the lane's
own sharpening.** `U5b` ended by deleting the gate its mutation harness served, so
the harness went with it and the tree now contains **no committed mutation
harness at all** — every mutation result in its final report rests on shell
commands run and discarded. That is the same state that produced two overstated
tables; the only difference is that it is labelled. **A packet removing a harness
owes a sentence naming which claims lose their executable evidence**, so the next
reader knows which rows in the claim ledger are now reports rather than controls.

**Report mutation results as `N committed, M ad-hoc`, and count only the committed
ones as evidence.** `U5b` reported *"fifteen"* when four were in the tree, and
*"eleven"* of that fifteen were thrown away. The wording is the fix.

## A probe's results must be reproducible from its branch — added 2026-08-08

Third instance in one session. `U5b` reported fifteen mutations with four in the
tree, then reported no committed harness at all. `PS-1` reported companion
creation, a second-capability posting, a correction and a measured lock order —
and its first `post()` is **admission-refused before reaching any of them**,
because the source aggregate's family is not admitted by the registration the
probe uses first. The same report also said *"I did not run any suite."*

**The rule:** a probe reports **observed** or **expected**, never both under one
heading, and an observed result must be reproducible by checking out the branch
and running the named test. If the branch cannot produce it, it is a prediction —
say so, and say what blocked the run.

**Why this is worse in a probe than in a packet.** A probe's whole product is
evidence; there is no shipped behaviour to fall back on. An unreproducible probe
result is not weak evidence, it is **no** evidence, and it costs a full review
round to discover — as it did here, where a reviewer found the contradiction
inside the same test body that asserted the pairing must be refused.

**Cheap and sufficient:** run the named test, paste the failure text or the pass
line, and push the branch. `PS-1` pushed; the reviewer read the source and found
what execution would have found first.

## Verify the target is on `origin` before writing the prompt — added 2026-08-08

Three review arms in one session hit a target the reviewer could not fetch. Two
returned findings weighed against *recorded* results rather than verified ones; the
third returned **BLOCK — REVIEW TARGET UNAVAILABLE** and could judge nothing.

**The orchestrator caused this by instructing rather than checking.** "Push the
branch" appeared in three prompts; none was followed by
`git ls-remote origin <branch>`. **A review prompt naming an unfetchable SHA is a
wasted arm**, and the arm is the scarcest thing in this loop.

**The rule, one command, before every review prompt:**

    git ls-remote origin <branch>   # must print the exact SHA in the prompt

**Quote the output in the prompt — sharpened 2026-08-09, after a fourth instance.**
The rule as written said *verify*, and the orchestrator kept verifying sometimes.
A reviewer then returned **BLOCKED — requested Git objects are unavailable** on a
range whose branch tip was two revisions stale on `origin`, and could confirm
nothing.

**So make the evidence part of the artifact:** the prompt carries the
`ls-remote` line for the SHA it names. A prompt that cannot be written without
pasting the verified tip cannot be written without running the command. This is
the same move as appending a matrix exit code *inside* the log rather than beside
it — bind the check to the thing it certifies.

If it is absent and the object exists locally, **push it yourself** — it is
non-destructive, it backs up the reviewed candidate off-machine as `git-workflow`
already requires, and it removes a dependency on the lane being awake.

**The unavailable arm was not worthless, which is the reason to record this rather
than just fix it.** Denied the candidate, the reviewer read `main` for the *class*
of defect the prompt described and found a real one in the unreadable candidate: a
hand-written `schemaVersion: 'v4'` that makes any `v5` package carrying a
legal-entity scope operand fail `CANON_VERSION_MIXED`. **A reviewer told what to
look for can find it without the diff. That is not a substitute for the diff.**

## Self-chosen mutations are worth less than an independent replay — added 2026-08-08

`U5b`'s lane observed it about its own evidence: *"my ad-hoc mutations were chosen
by me against gaps I already knew about, and are worth strictly less than an
independent replay for that reason."*

That is correct, and it is the same argument this file already makes for **fresh
naive** reviewers, one level down. A lane mutates where it suspects weakness, so
its table measures the gaps it already found. An independent replay mutates where
the *source* is weak. On this packet the difference was measured: the lane's own
table reported no survivors while an independent replay of the same tree found
**four**.

**So report who chose the mutations, not only how many ran.** `N committed, M
ad-hoc` gains a third term: **whether the set was chosen by the author or by
someone else.** A self-chosen table is evidence about the author's model, and
should be read as such.

**And a named survivor with a reason beats a table claiming none.** `U5b` closed by
reporting that a lowering mutation ignoring the authored value **survives**, because
`?? DEFAULT_DISCLOSURE_TIER` makes explicit `always` and absent identical — the
exact mutation its round trip cannot catch. **A gap you can name is closed
knowledge; a table with no survivors is usually an unexamined one.**


## An ADR that packets will build against gets an external arm — added 2026-08-08

The line above — *"for documents, the primary review is the human read"* — was
read by the orchestrator as *no external arm needed*. **The record refutes that for
any ruling downstream packets implement.**

- **ADR-0049 received two external arms and both returned BLOCK.** The second found
  that a receipt was posting as an **adjustment** in every load-bearing semantic —
  role, companion type, reason and approval, and an `adjustment_posted` event —
  while the test read the type column and never asserted on it.
- **ADR-0050 received none.** It was ratified on the orchestrator's own
  verification, and **item 4 was later withdrawn as a misattribution** — a
  wall-clock timing gate under load, reported as a per-entity field budget — found
  by the implementing lane rather than at ruling time.

**The rule:** a design pass whose output is a ruling that other packets implement
owes **one external arm against the ruling itself**, before ratification. Judge the
ADR, not the probe: *does the evidence support the ruling, and is any load-bearing
claim unmeasured?*

**Two things make this cheap.** It costs no machine, so it runs in parallel with
whatever holds the slot. And a design pass owes **no full matrix** (see
`mission-cadence`), so the arm is the only gate it has — which is exactly why
skipping it leaves a ruling with nothing behind it.

**The tell that an arm was owed and skipped:** the implementing packet spends its
first round correcting the ADR. That has now happened twice — `5g3-sm-impl`
withdrawing ADR-0050 item 4, and `PS-1` rebuilding on refuted ADR-0049 rulings.

## A refusal control needs its admission twin — added 2026-08-08

**A control that proves a bad input is refused is satisfiable by refusing
everything.** Only the paired control — that the *good* input is still admitted —
distinguishes a guard from a wall.

Three instances in one session:

- **`U5b`'s reader round trip** proved a present tier is *carried* but not that an
  absent one stays *absent*; a `parseSlot` inventing `always` survived until the
  absence twin was added.
- **ADR-0050 §7's permission equality** was ruled *with* the twin named — a
  mismatch must refuse, **and** the matched case must still compile — and the lane
  built both.
- **`5g3-sm-impl`'s state-carrier collision** proves a counterfeit field fails by
  name, and nothing proves the *exact* derived field is admitted. Replacing the
  deep comparison with unconditional refusal on any ID collision keeps the
  counterfeit test green **and** the PostgreSQL vertical green, because that
  fixture never contains the derived field already.

**The middle case is the tell:** the lane built both directions where the twin was
named in the ruling, and one direction where it was not. **So name it as a
standing requirement rather than per-instance** — every refusal control ships with
the admission that proves the refusal is discriminating.

**Generative question when writing a red:** *what implementation refuses
everything, and would this control notice?*

## A negative control must vary one property — added 2026-08-08

`5g3-sm-impl`'s canonical-reference control forged a specimen with **both** a wrong
`kind` **and** an invalid `schemaVersion`. It was refused, so the control passed —
and **deleting the production `kind` check kept it green**, because the version
condition still refused the same specimen. The control proved the specimen was bad;
it never proved which check refused it.

**This is distinct from "verify why a red fired."** There, the red is real and the
question is whether it fired for the stated reason. Here the specimen is
**confounded at the source**, so even a correctly-observed red cannot attribute
itself. No amount of reading the failure text recovers the attribution.

**The rule:** a negative control changes **one** property and leaves every other
property of the specimen valid — including ones that feel incidental, like a
version that has to be *some* value. **The tell is a broken tree with two reasons
to fail.**

**And a specimen installed at one call site does not control the others.**
`5g3-sm-impl` forged only `effect.entity` in one fixture while its comment claimed
three arms; restoring the shallow check in the capability arm, or passing the wrong
expected kind for `effect.transition`, kept it green. **Exercise every call site the
claim covers, or narrow the claim to the site exercised.**

**Generative question:** *for each check this control is supposed to hold, delete
that check alone — does the control still pass?*

**Ask it of each CHECK, not of the control — sharpened 2026-08-08.** A lane applied
this rule to its own rebuilt control and found a **third** confound neither the
reviewer nor the orchestrator had named: deleting the version-*membership* check
alone left all twelve cases green, because an invented version **cannot equal** a
real effect version, so the version-*equality* check was refusing every membership
specimen. Isolating membership required moving the enclosing effect's version and
its references **together**, so equality is satisfied and membership is the only
check left that can refuse.

**Asked of the control, it passed while a third of it was decorative.** Per-check
attribution is the measurement: `kind` 4 reds, equality 4 reds, membership 4 reds,
one per position. **A control that cannot say which check refused each specimen is
a control that will survive the deletion of one of them.**

**And a forgery table owes its own admission twin:** every position's *unforged*
specimen must be admitted. Without it, a position refused for an unrelated reason
contributes purely decorative cases — the same defect one level up.

## A red count is not attribution — and after two rounds, narrow the claim

**Counting failures does not tell you which specimen failed.** `5g3-sm-impl`'s
forged-reference table reported *"membership: 4 reds, one per position"*. Two of
those names were **the same specimen counted twice** — both transition positions
built an identical mutated catalog, so either reference's refusal passed both
subtests. Deleting the check at one transition call site and leaving it at the
other would have kept both green. **Four names, three specimens.**

The lane found an earlier confound by re-running each deletion individually
because a number disagreed with the code. That was right, and it was not enough:
**the count was correct and the attribution was still false.**

**So: attribute by specimen identity, not by red name.** Two subtests that
construct the same payload are one control with two labels.

### After two rounds of a claim exceeding its proof, narrow the claim

Rounds three, four and five of that packet were all one control, while the
production parser had been confirmed sound since round three. **Each round tried to
make the control prove more; each round the claim still outran the specimens.**

**The close is to shrink the claim to what the specimens support.** Where a routing
claim is already proven by other cases — there, `kind` and equality each install at
four distinct positions and so prove all four call sites reach the shared parser —
a third check does **not** need its own per-position table. One mutation against the
shared parser is sufficient, and saying so is more honest than a table whose fourth
column is a duplicate.

**The tell that you are strengthening when you should be narrowing:** the control
grows, the production code has not changed in two rounds, and each review finds the
same shape one layer in.

## Write the claim from the measurement, and prefer unrepresentable to detectable

**Measured 2026-08-08, across five packets in one session.** Rounds one and two of a
review find production defects. **Rounds three and beyond find control defects while
the production code sits unchanged and confirmed.** That transition is the signal
that the loop has stopped being about the code.

Two writing habits cause it.

**Controls are written claim-first.** The comment states the aspiration — *"all
three arms controlled"*, *"four positions, one red each"*, *"every entry point is
leased"* — and the specimens implement a subset. Each review finds the gap, the
control is strengthened, and the strengthened control makes a **new** slightly
broad claim. Three rounds on one table is that loop, not three defects.

> **Build the specimens, run the per-check deletion, then write the comment from
> what actually died.** A lane that did this unprompted found a confound no reviewer
> had named. Two review rounds would not have existed had it been standard.

**And detection is chosen where impossibility was available.** A source scan
narrowed from *"no id on the wire"* to *"every read of the posted id is the
membership lookup"* is still a source scan, and a ternary reading a different
submission field walks through it. The repository already ruled the better move:
[ADR-0048](../../../docs/decisions/ADR-0048-the-message-catalog-is-platform-vocabulary-held-in-code.md)
§2 chose `keyof typeof` because an unregistered code is **inexpressible**, *"strictly
stronger than"* detectable.

> **Before writing a detector, ask whether the consumer can be built so the wrong
> input is unavailable to it.** Pass the resolved value, not the raw one. A guard
> that cannot be evaded needs no control proving it wasn't.

**What does not change:** control-quality findings are still worth the round. The
worst defects this programme has carried were fenced claims with **no** control —
one refusal shipped four rounds fenced as settled with nothing holding it, and a
press-law guard is evaded on `main` to this day by a spliced literal.

## For a merge, revert each parent's half alone — added 2026-08-09

The deletion table asks *what happens if this check is removed*. A **merge** needs
its own form, because the thing under test is the *resolution* and neither parent
alone produces it:

> **Revert the merged function to each parent's side in turn. Does the control
> notice?**

`pur1-intent-limit`'s payoff test asserted that two transition operations bind as
two addressable commands — and **survived both reverts.** Restoring one parent kept
operation-id addressing while rendering the wrong explanation for both transitions;
restoring the other kept the explanation while posting a shared `intent=command`.
The test proved the **premise** — that transitions arrive with `capabilityId: null`
— and stopped one layer before the payoff.

**A merge control that only reads the data both parents already produced is testing
the premise, not the resolution.** Push it to the artifact the resolution actually
changes: render the output, inspect it, and assert the properties each parent would
have got wrong.

**The orchestrator's share of this one:** the merge was argued as "the payoff, not
the tax," and a test was requested to prove it. **Asking for the claim is not the
same as specifying the observation**, and the lane built exactly what was asked.
