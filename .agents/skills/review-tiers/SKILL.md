---
name: review-tiers
description: Seat and model matrix for writing and reviewing by tier
  (Mechanical / Behavioral / Critical), fresh-naive reviewer mechanics, SHA
  freezing, and Fable confirm rules. Read before launching any writer or
  reviewer.
---

# Review tiers — seats and mechanics

## Classify by the final diff

- **Mechanical** — docs, config, renames, test-only; no behavior change.
- **Behavioral** — product behavior outside the spine.
- **Critical** — release kernel, compiler, semantic gateways, inventory
  ledger/posting, tenant isolation/policy, trust substrate, migrations.

When in doubt between two tiers, take the higher. The tier is set by what
the diff actually touched, not what the packet intended.

## Seat matrix

| Tier | Writer | Review chain |
|---|---|---|
| Mechanical | codex `gpt-5.6-sol` high, or orchestrator for trivial diffs | one fresh reviewer or orchestrator verification with recorded evidence |
| Behavioral | codex `gpt-5.6-sol` high | fresh naive codex xhigh review -> writer fix loop -> fresh re-review until PASS |
| Critical | codex `gpt-5.6-sol` xhigh | fresh naive codex xhigh to PASS, then Fable max confirm on the identical unchanged SHA |

- Codex maximum reasoning effort is `xhigh` (there is no valid "ultra").
- Fable: `claude -p --model fable --effort max` via the WSL binary; `high`
  for lower-risk confirms. If Fable is unavailable, a Critical result stays
  `evidence_ready`, never `accepted`.
- Launcher templates: `~/2rain-missions`.

## Fresh-naive mechanics (binding)

- Every review and every re-review is a NEW spawn with zero planning
  context. The review prompt contains only: the frozen diff or SHA, the
  owned paths, the invariants at stake, the packet's threat-model/scope
  boundary, and the decisive questions.
- Every packet record and review prompt must state what failures are in scope
  and what adversarial or future-hardening cases are explicitly out of scope.
  Reviewers test correctness inside that boundary; they do not turn a
  foundation packet into an unbounded evasion exercise. An out-of-scope
  observation may be recorded for later hardening, but is not a blocking
  finding unless it disproves an in-scope claim.
- If the packet has no explicit threat-model/scope boundary, the orchestrator
  adds one before freezing the SHA or launching review.
- Never resume, extend, or SendMessage a prior reviewer — anchoring bias.
- Verdicts: PASS / REVISE (findings, fixable in loop) / BLOCK (design-level
  problem; back to the user).
- Reviewer findings are adjudicated by the orchestrator reading the code —
  severity disagreements are settled by evidence, not by rank of the seat.

## SHA discipline

1. Writer finishes -> freeze candidate SHA.
2. Review runs against that SHA only.
3. Any fix -> new SHA -> prior review evidence is void -> fresh review.
4. The accepted SHA is recorded in the ledger row and the packet record.

## Evidence record (per packet)

Writer seat + effort; each review spawn, verdict, and findings disposition;
final SHA; gate outputs. Keep it in the packet record, not scattered in
chat history.
