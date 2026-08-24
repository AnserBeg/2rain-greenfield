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
- **`docs/execution/current-plan.md` is the active queue** — what runs next and
  why, the operating model, open plan-level decisions, and the dispositioned
  findings inventory. Read it after this file and before proposing or running
  any packet; the ledger says what happened, current-plan says what is next.
  Keep it current whenever the queue changes.

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

*Renumbered 2026-07-31 when the duplicated mechanics moved to
`mission-cadence`. Older records citing "§3.5" for the grow-beyond-scope rule
mean point 3 below.*

1. One packet at a time, selected by the user. Never continue to another
   packet autonomously — even when the next step is obvious. Propose, stop,
   wait.
2. Prefer thin vertical slices over broad horizontal layers, so every step
   produces something the user can observe rather than something they must
   take on trust.
3. If a packet grows beyond its scope, stop at a safe boundary and report
   rather than pushing on. A correct stop is good work — but three stops on
   one packet means the charter was mis-scoped, and the answer is to re-scope,
   not to write a fourth continuation.

**`.agents/skills/mission-cadence/SKILL.md` is binding on the mechanics** — the
propose/select/execute/checkpoint loop, what a packet must define, the
packet-completion block, stop conditions, and stop convergence. It is the only
place those are written down, for the same reason as §4: a second copy drifts
and reads authoritative while being subordinate.

## 4. Seats, models, and review tiers

Every packet carries a tier — Mechanical, Behavioral, or Critical — set by
what its final diff **does**, not by where the diff lives.

Two principles govern all review, and only these two live here:

- **Tier sets INTENSITY; the charter sets SCOPE.** A higher tier means a
  stronger reviewer applied to the same bounded charter. It never means
  unbounded scrutiny, and "find any way this could fail" is never a valid
  framing.
- **Review is proportionate to what the deterministic gates already prove.**
  Where a gate settles correctness, the review IS verification against that
  gate. Under-reviewing risky logic and over-reviewing settled mechanics are
  equally wrong; most of this program's pain has come from the second.
- **Any code change after a review invalidates it: new SHA, fresh review.**
  Never resume or extend a prior reviewer. (Kept here because other records
  cite this section for it; the surrounding procedure is in `review-tiers`.)

**The `review-tiers` skill is binding on every mechanic** — the seat/model
matrix, tier calibration, the mandatory charter's five elements, findings
triage, and round convergence. Read it before launching any review. It is
deliberately the only place those mechanics are written down: this section
used to restate them and the two copies drifted (2026-07-31 — they disagreed
on the Mechanical review default and on Fable's effort level). Per the
authority order in §1, the skill outranks this file's operational detail, so a
restatement here would read authoritative while being subordinate. Do not
reintroduce one.

Codex launcher templates and captured review results live in
`~/2rain-missions`.

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

- A packet is acceptable only when the **full CI matrix** is green at the
  exact integrated SHA — never from a packet-selected subset. Focused tests
  may shorten the development loop but cannot replace the full matrix. The
  packet's ledger row records the integrated SHA and that full-matrix run.
  The matrix must be green *for the integrated tree*; it does not have to be
  re-run after the merge commit exists. When the integrated tree's executable
  content is identical to the reviewed one — narrative paths excluded, per the
  check in `git-workflow` — the reviewed run is the acceptance run, because a
  second pass over the same bytes observes nothing. **Corrected 2026-08-24: that
  reason no longer holds for every suite.** `test:architecture` now reads
  `docs/**`, so a narrative commit changes its input and the bytes it observes
  are not the same bytes. It and `pnpm format` re-run past a narrative commit;
  the rest carry forward. `git-workflow`, "The exclusion list answers one
  question, not two", holds the split, and the exclusion list itself remains
  correct for the question it was written to answer — which paths a packet must
  declare.
- **Integration is a `--no-ff` merge of the PACKET into `main`, and the direction
  is a gate fact rather than a style preference.** `scripts/check-review-record.sh`
  walks `--first-parent` and covers a merge through its **second** parent. **Mechanism corrected
  2026-08-15 after a third occurrence** — the earlier wording here said the wrong
  direction puts the PACKET's commits off the first-parent chain. Measured, it does
  the opposite: absorbing `main` into the packet and fast-forwarding puts the
  packet's commits **on** the chain and pushes **`main`'s own history off it**
  (`bc28c2f` and `d5159dd` went off-chain exactly this way). The gate still passes,
  so the cost is not a missed record — it is that one `--no-ff` merge is covered by
  ONE record through its second parent, while a fast-forward requires every
  intermediate commit to be covered individually, and `git log --first-parent main`
  stops being a readable one-stretch-per-packet history. **A rule three capable
  lanes have now broken, written in two skills and here, will not be fixed by a
  fourth restatement — it needs a gate**, asserting that each accepted packet's
  reviewed SHA appears as a SECOND parent on `main`'s first-parent chain. **Promoted here
  from `git-workflow` on 2026-08-13 because two lanes produced the wrong shape
  independently, which makes it the default outcome rather than a slip**, and
  because one such merge carried a Critical write-path control onto `main`
  uncovered by any record. `git-workflow` keeps the mechanics; this is the reason.
- Every `*.test.ts` and `*.spec.ts` file must be proven reachable by executed-file evidence from successful CI-invoked suites.
- A gate must **observe** the fact it asserts, never a proxy for it. Parsing a
  tool's output, inferring from a declaration, and matching a string are proxies;
  reading an execution counter, a produced artifact, or a persisted effect is
  observation. Where only a proxy is available, the packet record states what the
  gate cannot prove.
- Every gate ships with a **negative control for each way it could pass
  vacuously** — one recorded red per vacuity vector, not one red overall. A gate
  never observed failing is not evidence. Vacuity vectors include: the subject
  absent entirely, the check reading zero input, a proxy satisfied while the fact
  does not hold, output shapes the parser does not recognize, and **the subject
  repaired before it is measured** — a verifier must never share a code path with
  the thing that heals what it verifies. **Calibrated 2026-08-21 — this is the
  BAND A standard and it is not universal.** `review-tiers`, "Evidence depth
  follows FAILURE OBSERVABILITY", sets what a packet actually owes: full
  per-vacuity-vector control where a failure is SILENT until something reconciles
  it; **one discriminating red per CLAIM** where the failure is visible the first
  time an operator uses the path; the deterministic gate plus a stated limit where
  it is visible on reading. **A committed control must die alone at every band, and
  the claim must never exceed the evidence.** An undeclared band is Band A.
- Deadline, expiry, and elapsed-time logic never compares raw wall-clock
  samples. Production elapsed-time decisions use a monotonic source; timing
  tests inject a controlled clock and never sleep-and-measure.
- When touched: dependency-boundary tests, PostgreSQL provider tests,
  surface-grammar conformance (exists from G2), agent evaluations (once the
  harness exists).
- If a packet changes compiler or release OUTPUT (release manifest/envelope,
  version stamps, canonical bytes, projection shapes), the downstream consumer
  suites that persist or read that output — `test:postgres` above all — are
  REQUIRED gates before acceptance, even when the provider is not in the
  packet's owned paths. A cross-layer inconsistency only surfaces where the
  layers meet, so a compiler-only gate set will pass it straight onto main.
- Stage gates belong to the plan; a packet never claims a stage gate by
  itself.

## 7. Conduct and environment

- No secrets in source, fixtures, package revisions, or model prompts.
- No hard-delete paths for business data, anywhere, ever (plan doctrine).
- All repository commands run in Ubuntu/WSL against `/home/rvham/...`
  paths.
- WSL2 on this machine steps its wall clock backward ~2s under CPU load; the
  binding monotonic-time and controlled-clock rule is in section 6.
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
