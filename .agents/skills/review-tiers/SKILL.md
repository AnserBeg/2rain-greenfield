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
