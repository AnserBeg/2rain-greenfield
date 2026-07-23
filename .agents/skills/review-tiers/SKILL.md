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

Tier is set by what the diff touched; when in doubt take the higher. But a
higher tier raises reviewer strength, not scope — the charter still bounds it.

| Tier | Writer | Review |
|---|---|---|
| Mechanical | codex `gpt-5.6-sol` high, or orchestrator for trivial diffs | orchestrator verification against the deterministic gates; add one scoped pass only if the gates do not fully prove correctness |
| Behavioral | codex `gpt-5.6-sol` high | one fresh naive codex xhigh review against the charter -> bounded fix loop |
| Critical | codex `gpt-5.6-sol` xhigh | fresh naive codex xhigh against the charter to PASS, then Fable max confirm on the identical SHA |

- Codex max effort is `xhigh` (there is no valid "ultra"). Fable:
  `claude -p --model fable --effort max` via the WSL binary.
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
- Launch reviews with the `codex exec ... -s read-only --output-last-message`
  subprocess method (it returns a captured verdict); do not use unbounded
  background-agent polling.
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
