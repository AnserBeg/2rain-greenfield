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

- Codex max effort is `xhigh` (there is no valid "ultra"). Fable runs via the
  WSL binary. Both reviewer commands acquire the repository's shared test lock:
  `node scripts/run-with-test-lock.mjs shared -- claude -p --model fable
  --effort max`.
- The Fable confirm is for Critical **logic**. For document/config packets it
  is optional — the human read or the deterministic gate is the real review.
- If Fable is unavailable, a Critical-logic result stays `evidence_ready`.

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

- At most **two** REVISE rounds. On reaching a third, or on any round that
  produces only out-of-scope or immaterial findings, STOP: freeze the best
  candidate, triage the open findings, and surface to the user. Do not keep
  looping.
- A review that keeps finding "more of the same class" is a signal the charter
  is mis-scoped, not that the code is wrong. Re-scope or escalate; do not chase.
- Each new round addresses only the in-scope, material findings from the prior
  round — never newly invented broader scrutiny.

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

**So: after a packet reaches the two-REVISE cap for a second time, the
orchestrator may commission the second arm as an INDEPENDENT SCOPE REVIEW rather
than a confirm.** Its charter asks *"is this packet being asked the right
question?"* — not *"is this code correct?"* It reviews the ruling, the charter
and the packet record, and it may conclude the orchestrator is wrong.

This does not replace the confirm arm; the packet still needs one before it
lands. It buys a second perspective at the point where one reviewer and one
orchestrator have demonstrably converged on the wrong frame.


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
