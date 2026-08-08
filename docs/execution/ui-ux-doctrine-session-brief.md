# Brief — the UI/UX doctrine-review session

**Written 2026-08-08 by the orchestrator session that commissioned the review.**
You are a **second, concurrent session**. Another session is running three build
lanes right now. §4 is the fence that keeps you from colliding with it — read it
before you write anything.

---

## 1. What you are here to do

A **doctrinal review** of the UI/UX plan has returned. Your job is to **adjudicate
its findings by reading the code and the documents yourself**, then land the
corrections that survive.

The review was not hunting code defects. It was hunting **rulings that read as
settled but rest on a premise narrower than the rule they justify.** Its
generative question:

> **Does a load-bearing term mean the same thing in the rule as it does in the
> evidence cited for the rule?**

**One instance was already found and corrected — treat it as the worked example,
not as a finding to re-report.** [ADR-0032](../decisions/ADR-0032-feedback-ladder-and-loading-states.md)
§1's ladder bands are about *what a person waits for*. The measurement quoted to
defer skeleton work was recorded at
`packages/postgres-provider/src/composed-application-runtime.ts:718`, around
**registered query execution against Postgres** — the innermost segment of the
wait. Same term, two referents, and the narrower silently stood in for the wider
inside a ruling that read as closed. The correction is **ADR-0032 §2b**, and the
consequences are chartered in [ui-ux-remaining.md](ui-ux-remaining.md) §2.

**Reviewers are sometimes wrong, and so are you.** Every finding gets checked
against the tree before it is acted on. Several findings in this program have been
refuted by reading the file the reviewer cited.

## 2. Where UI/UX actually stands

**Read [ui-ux-remaining.md](ui-ux-remaining.md) first — it is current, written
2026-08-08, and it is the single best summary.** In outline:

**Landed:** `U0` (hex ratchet), `U1` (feedback ladder and latency measurement),
`U2` + `U2-fix` + `U2-fix-b` (token layer, motion contract, focus rings), `U3`
(ruled as [ADR-0036](../decisions/ADR-0036-minimum-client-capability.md)), `U4`
(per-slot state machine and fault isolation), `U6a` (all 27 message codes resolve
through one catalog with a rendered-text gate).

**In flight, owned by the other session — do not touch:** `U5b` (compiled
disclosure tier, revision round 2).

**Open:** `U6b`, `U7`, `U8`, `U9`, `U2-num`, `msg-code-accuracy`, `op-latency`,
`shimmer-trajectory`, and the three new rows from the wait-model correction —
`wait-measure`, `skeleton-route`, `wait-escalate`.

**The governing documents** are `docs/execution/ux-strategy-proposal.md`, the
`ux-grammar` skill, and ADRs **0032**, **0035**, **0036**, **0037**, **0041**,
**0048**.

## 3. How this program works

Read `AGENTS.md`, then `.agents/skills/review-tiers/SKILL.md` and
`.agents/skills/git-workflow/SKILL.md`. Sections 1-3 and 5-8 of
[orchestrator-handoff.md](orchestrator-handoff.md) are durable; **§4 and its
2026-07-30 addendum are stale and carry a banner saying so.**

The parts that bite hardest:

- **You do not write product code.** You hand the user self-contained packet
  prompts, **pasted inline, never as a file path**, and each must reconstruct its
  state from disk.
- **Sweep the governing files before writing any prompt.** Grep the pins; do not
  predict them. Three packets have stalled on a predicted pin.
- **Two-REVISE cap.** A third round on the same *class* means the charter is
  mis-scoped, not the code. Route the class; do not correct a fourth time.
- **An accepted packet owes a row in `review-log.md`.** A `post-merge` hook runs
  `scripts/check-review-record.sh` and fails when executable work reaches `main`
  without a recorded verdict. A BLOCK is a valid record.
- **Doctrine-only commits** — ADRs, rulings, docs — go straight to `main` and must
  carry a `Doctrine-only: <reason>` trailer.
- **`main` is not auto-pushed on doctrine commits.** The origin-sync hook runs on
  `post-merge` only, so a direct commit can sit local and invisible. **Push
  explicitly.** This already cost one review, which read a stale tree because the
  correction it was told to judge against had not been pushed.

## 4. The fence — what you may and may not touch

Another session holds three lanes. **Editing a file it holds will corrupt a
frozen candidate or void a matrix.**

**Held elsewhere — do not touch:**

| Path | Held by |
|---|---|
| `packages/canonical-model/**`, `packages/compiler/**` | `U5b` |
| `scripts/**`, `test/architecture/test-lock-observability.test.ts`, `test/architecture/test-reachability.test.ts` | `lock-obs` |
| `packages/domain/**`, `apps/web/release/**` | `PUR-1` / `PS-0` |
| `package.json`, `test/architecture/repository-hygiene.test.ts` | **contended by two lanes** |
| `docs/execution/current-plan.md`, `ledger.md`, `review-log.md` | the other orchestrator |

**Yours:** `docs/decisions/ADR-0032`, `0035`, `0036`, `0037`, `0041`, `0048`;
`.agents/skills/ux-grammar/SKILL.md`; `docs/execution/ux-strategy-proposal.md`;
and **`docs/execution/ui-ux-remaining.md`**, which is where you record new rows.
The other orchestrator mirrors them into `current-plan.md`; **do not edit that
file yourself.**

**Two hard limits.**

- **Do not launch a build lane and do not take the matrix slot.** One full matrix
  runs at a time across the whole machine; a second concurrent run has already
  produced two false reds on one packet and an 876 s → 3275 s swing on identical
  trees. If a finding needs executable work, **write the queue row and the packet
  prompt and hand them to the user** — do not start them.
- **`learnings.md` is append-only and shared.** Append at the end; never edit
  another entry.

## 5. What a good outcome looks like

A finding is closed when the ADR or skill that carried the wrong premise says the
right thing, **with the evidence you checked cited by file and line**, and when
anything executable it implies is a filed row with a named trigger rather than a
sentence of prose. A rule with no executing gate is the shape AGENTS.md §6 exists
to close — and in this repository one such rule lapsed for eight days and 637
commits before anything noticed.

**Say plainly which findings you refuted.** A doctrinal review that is 100 %
upheld usually means nobody checked it.
