# AGENTS.md — greenfield ERP operating doctrine

Single operating doctrine for every agent working in this repository (Codex
writers/reviewers, Claude orchestrator and reviewers, humans). CLAUDE.md
points here. If anything below conflicts with the plan or an accepted ADR,
stop and surface it — do not improvise.

## 1. What this repository is

- The greenfield north-star ERP. The single program authority is
  `docs/greenfield-north-star-erp-platform-plan.md`: architecture doctrine,
  stages G0-G8 and N1-N7, gates, the UX grammar (sections 8.5-8.6), and the
  prior-repository salvage contract (section 1.2).
- Authority order: plan > accepted ADRs (`docs/decisions/`) > skills
  (`.agents/skills/`) > this file's operational detail.
- Execution state lives in `docs/execution/ledger.md`. Statuses:
  `planned -> admitted -> active -> evidence_ready -> accepted`; `blocked`
  only for an explicit dependency or user decision.

## 2. The prior repository (the quarry)

- Location: `/home/rvham/2rain_erp`, branch `chess`; frozen inventory
  candidate `codex/p02-inventory-core@33ca8bb`.
- "The v1 corpus" means its `docs/canonical-erp-platform-replatform-plan.md`.
- It is a design-and-evidence quarry, never a runtime dependency. No blind
  copying. All reuse goes through the `salvage-admission` skill
  (PORT / RE-EXPRESS / REFERENCE). Do not modify the prior repository except
  the explicitly selected X-01 baseline-freeze packet.

## 3. Execution cadence — step packets (binding)

Day-scale autonomous campaigns are retired in this repository. The user
tests at every step.

1. One packet at a time, selected by the user. Never continue to another
   packet autonomously — even when the next step is obvious. Propose, stop,
   wait.
2. A packet is one coherent outcome sized for one sitting (roughly 1-4
   hours of agent work) that leaves the repository runnable.
3. Every packet ends with, in order: a frozen candidate SHA; gates run with
   honest results (a red gate is reported, never hidden); a "Test it
   yourself" section (exact copy-paste commands, what to click, what you
   should see, under 10 minutes); a ledger update; and a proposal of 1-3
   candidate next packets. Then STOP.
4. Prefer thin vertical slices over broad horizontal layers so every step
   produces something the user can observe.
5. If a packet grows beyond its scope, stop at a safe boundary and report
   rather than pushing on.

Details and the packet template: `.agents/skills/mission-cadence/SKILL.md`.

## 4. Seats, models, and review tiers

Classify every packet by its final diff:

- **Mechanical** — docs, config, renames, test-only work; no behavior
  change.
- **Behavioral** — product behavior, but not the spine.
- **Critical** — release kernel, compiler, semantic gateways, inventory
  ledger/posting, tenant isolation and policy, trust substrate, migrations.

The tier sets review INTENSITY only (how strong a reviewer, how many). Review
SCOPE is bounded by a mandatory charter, review is proportionate to what the
deterministic gates already prove, findings are triaged (in-scope + material
only), and rounds converge (max two REVISE rounds, then surface). A high tier
never means infinite scrutiny. The `review-tiers` skill is binding on all of
this; read it before launching any review.

| Tier | Writer | Review chain |
|---|---|---|
| Mechanical | codex `gpt-5.6-sol` high, or the orchestrator directly for trivial diffs | one fresh reviewer, or orchestrator verification with evidence |
| Behavioral | codex `gpt-5.6-sol` high | one fresh naive codex xhigh review + writer fix loop; every re-review is a fresh spawn |
| Critical | codex `gpt-5.6-sol` xhigh | fresh naive codex xhigh review to PASS, then Fable max confirm on the identical unchanged SHA. If Fable is unavailable, the result remains unaccepted evidence |

Rules:

- Reviewers are always fresh, naive spawns: no planning context, only the
  frozen diff, owned paths, and the charter (gates-green, in-scope,
  out-of-scope, threat model, bounded decisive questions). A review prompt
  with no explicit charter is invalid. Never resume a prior reviewer.
- Never frame a review as "find any way this could fail/be evaded" — that is
  the unbounded hunt that caused the P3 spiral. Ask specific, bounded
  questions and stop.
- A finding is actionable only if in-scope, material, and proportionate;
  valid-but-out-of-scope findings are recorded as future work, not chased. A
  fix that would balloon the packet is a stop-and-surface, never a silent
  scope expansion.
- Any code change after a review invalidates it: new SHA, fresh review.
- Fable runs via the WSL claude binary: `claude -p --model fable --effort
  max` (use `high` for lower-risk confirms).
- Codex launcher templates live in `~/2rain-missions`; model policy is
  `gpt-5.6-sol`, effort per the table (codex maximum effort is xhigh).

Packet review is not the only review. A **program review** is a separate,
trigger-gated whole-app instrument that packet reviews cannot substitute for:
it checks the whole built system for coherence and ADR-vs-code drift, and it
returns a direct verdict on the two strategic questions — is the north star
still the right GOAL, and is our APPROACH the right way to reach it. At every
checkpoint and stage boundary, evaluate its triggers (first end-to-end slice
before a fan-out, a new correctness domain, before the first zero-dev-code
module, or accumulated drift) and propose one when due. The `program-review`
skill is binding on when and how it runs; it is user-selected, never
autonomous, and its strategic recommendations are surfaced, never acted on
silently.

## 5. Serialization and ownership

- Serial, never concurrent: database schema and migrations, generated
  registries, shared contracts, heavy suites, dev servers, real-model
  evaluations.
- Each packet declares its owned paths; writers stay inside them. A needed
  out-of-scope change is a stop-and-bridge-request, not a lease violation.

## 6. Gates

- Every packet: typecheck plus the packet's focused tests.
- When touched: dependency-boundary tests, PostgreSQL provider tests,
  surface-grammar conformance (exists from G2), agent evaluations (once the
  harness exists).
- Stage gates belong to the plan; a packet never claims a stage gate by
  itself.

## 7. Conduct and environment

- No secrets in source, fixtures, package revisions, or model prompts.
- No hard-delete paths for business data, anywhere, ever (plan doctrine).
- All repository commands run in Ubuntu/WSL against `/home/rvham/...`
  paths.
- WSL2 on this machine steps its wall clock backward ~2s under CPU load:
  any test with ordering assumptions uses monotonic time.
- Record adjudicated lessons via the `capture-learnings` skill.

## 8. Skills

- `mission-cadence` — the packet contract; read before orchestrating.
- `review-tiers` — seat matrix mechanics and review prompts (one packet).
- `program-review` — the trigger-gated whole-app review: coherence plus the
  north-star goal / approach questions. Evaluate its triggers each checkpoint.
- `salvage-admission` — reuse from the prior repository.
- `git-workflow` — branching, commit, push, and tag discipline.
- `ux-grammar` — binding UI/UX grammar (its CI pinning test lands at G1).
- `capture-learnings` — how lessons are recorded.
