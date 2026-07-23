---
name: program-review
description: Whole-app (program-level) review instrument, distinct from the
  per-packet review-tiers. Read at every packet checkpoint and stage boundary
  to decide whether a whole-app review is DUE, then run it. Covers the trigger
  conditions, the two dials (internal coherence + the strategic north-star /
  approach questions), how to run it cost-aware and finite, and its output
  record.
---

# Program review — the whole app, and whether we are building the right thing

## What this is, and why it is separate from `review-tiers`

`review-tiers` reviews ONE packet's diff against a bounded charter. It cannot
see the forest: emergent contradictions between packages, drift between the
ADRs/plan and the code, accumulated seams that individually passed but do not
compose, or the possibility that the whole endeavour is aimed at the wrong
target.

A **program review** is the periodic whole-app instrument that answers what no
packet review can. It has two dials, and BOTH are mandatory when it runs:

- **Dial A — internal coherence:** is the app, as built so far, sound and
  self-consistent?
- **Dial B — strategic direction:** is the north star still the right GOAL,
  and is our APPROACH the right way to reach it?

This is the most expensive single review the program runs. That cost is the
reason it is trigger-gated, not run every packet — and the reason its timing
matters. Spend it where it changes decisions.

## When it triggers (evaluate at every checkpoint)

At each packet checkpoint and stage boundary, the orchestrator checks these.
If any fires, PROPOSE a program review to the user before proceeding (the user
still selects — this skill never runs a program review autonomously).

**Milestone triggers (strong):**

- The **first end-to-end vertical slice** exists AND a **fan-out is imminent**
  — e.g. the first complete walking slice (Party at G2-P3) just before Catalog
  and Location replicate its template. This is the single highest-ROI point: a
  real path exists to trace through every layer, and findings here prevent a
  flaw from being copied into every module built on the template.
- A **major new correctness domain** has stabilized — e.g. the append-only
  inventory ledger under concurrency (G3). New, dangerous invariants deserve a
  whole-app pass once they settle.
- **Before the first zero-dev-code module** (N1) — the moment the factory
  claim is first tested for real.
- A stage gate where a **new capability tier** lands and much will build on it.

**Judgment triggers (as needed):**

- Roughly a **full stage** has passed since the last program review.
- **ADR-vs-code drift** has been noticed across more than one packet.
- A defect or near-miss looked **systemic**, not local.
- **Reserved/deferred seams** have accumulated enough that their coherence is
  no longer obvious.
- The orchestrator senses the build is **bending away from the plan** or the
  north star, for any reason.

**Anti-triggers (do NOT run one):**

- Mid-packet, or against a working tree that is not clean and integrated —
  the app is unstable and unrepresentative.
- A freshly frozen CONTRACT with nothing running through it yet — it re-plows
  ground a recent packet review or debate already covered.
- Stable ground with no fan-out and no new correctness domain — the spend
  buys nothing.

## Dial A — internal coherence (what to examine)

- **Trace a real request** end to end through every layer (definition ->
  compiler -> release -> pinning -> gateway -> storage -> surface -> agent ->
  trust/audit). Does it compose cleanly, or only in the diagrams?
- **ADR-vs-code drift:** do the ratified ADRs and the north-star plan match
  what the code actually does? Name every divergence.
- **Cross-package contract mismatches**, dead or half-wired reserved seams,
  and duplicated authority (the predecessor's dual-lineage disease).
- **Security & tenant-isolation posture** consistency across the whole surface,
  not one packet.
- **Determinism, trust, and no-hard-delete invariants** holding system-wide.
- **The press law** (one definition -> all projections, no shortcuts) actually
  enforced everywhere, not just where a packet asserted it.

## Dial B — is the goal and the approach right (mandatory, the point of it)

The program review must return a direct verdict on two questions, with
reasoning grounded in what building the thing has actually taught us — not a
restatement of the plan's own optimism:

1. **Is the north star still the right GOAL?** Given the evidence so far, is a
   compiler-backed, zero-dev-code, custom-module ERP "factory" still the right
   target — or has something emerged (cost, complexity, a wrong market read, a
   simpler sufficient design) that says the goal itself should change?
2. **Is our APPROACH the right way to reach it?** Sequencing (foundations ->
   release kernel -> master data -> inventory -> ...), the modular-monolith /
   deterministic-compiler / release-pointer bet, the step-packet cadence, and
   the launch-scope boundaries — are these getting us there, or should the path
   change?

Dial B produces a VERDICT plus reasoning, not open-ended speculation. It may
recommend course corrections up to and including "reconsider the goal" or
"change the approach." Those are surfaced to the user as decisions to make —
never acted on autonomously, and never quietly dropped because they are
uncomfortable.

## How to run it — broad in coverage, still finite

- **Read-only**, on the clean integrated app (typically `main` at the
  triggering checkpoint), never mid-packet.
- **Both models, independent:** codex `gpt-5.6-sol` xhigh and Fable max, each a
  fresh naive spawn with the whole-app charter (Dial A + Dial B), no shared
  context. The orchestrator reconciles them the way it adjudicates a debate.
- **Broad coverage is NOT an unbounded hunt.** The `review-tiers` anti-spiral
  principle still holds: this review is wide (whole codebase, strategic
  questions) but finite in depth — it produces a RANKED findings ledger by
  materiality and two Dial-B verdicts, never an exotic-hypothetical enumeration.
  Wide in scope does not mean infinite in paranoia.
- **Effort/cost:** this is the program's largest review spend. Gate it to the
  triggers above; do not run it per packet.

## Output (record it)

Write `docs/execution/program-reviews/<yyyy-mm-dd>-<milestone>.md`:

1. Scope reviewed (SHA, stages/packages covered).
2. Dial A findings — ranked, each with disposition (fix-now packet / recorded
   future-work / dismissed-with-reason).
3. Dial B — the two strategic verdicts with reasoning, and any recommended
   course corrections surfaced to the user.
4. Reviewer evidence (both models' verdicts, the reconciliation).

Add a pointer row to the execution ledger. A program review complements — never
replaces — packet `review-tiers` and the plan's stage gates.
