---
name: mission-cadence
description: How a vertical is chartered, worked continuously, checkpointed for
  the user, frozen and recorded. Read before starting or orchestrating work.
---

# Mission cadence — verticals with checkpoints (rewritten 2026-09-04)

## The unit of work

A **vertical** is one user-visible capability end to end — the goods receipt
from document to posted movement to visible received quantity, or the sale from
order to shipment. It is chartered once, worked by one writer lane
continuously, checkpointed per slice, reviewed once at the end (`review-tiers`),
integrated once.

## The charter (the orchestrator writes it, ≤ 60 lines)

1. Outcome in the user's words, and the slices in order (each user-observable).
2. Lease: the paths the writer owns. Bridges the writer will foreseeably need
   are granted in advance. `ls` every path; check `lanes.md` for the other lane.
3. Which paths are in the Critical set (`AGENTS.md` §4) and therefore reviewed.
4. Decisions already made (with the ADR or plan section) and decisions the
   writer may take alone. Anything on the STOP list is named here.
5. Gates: CI on push; `scripts/check-records.sh` before freeze.

## Working

- **Continue.** Finish a slice, write its "Test it yourself", commit, push,
  start the next. Do not wait for a ruling between slices.
- **Stop only on the STOP list** (`AGENTS.md` §3): one-way door; lease
  collision; a CI red you cannot make green honestly; a design fork the plan
  does not settle with product-visible consequences. A stop is a five-line
  report: what, the two options, your recommendation.
- **Decide the rest yourself** and write one line per decision in the record.
- Pre-tenant mode (ADR-0066): a refused storage transition is a re-baseline,
  not a transition element. Say so in the record.
- Run `format` and `typecheck` before anything expensive. Commit before any
  mutation test; controls revert with `git checkout --`.

## Checkpoint — every slice

A **"Test it yourself"** block: copy-paste commands or UI steps with expected
observations, runnable by the user in under ten minutes without reading the
diff. The user tests when they choose; the writer does not wait.

## Freeze — once, at the end of the vertical

1. Push the branch. The frozen SHA is the tip; CI is green there.
2. The **`record-claim` block** in the packet record: `schemaVersion`,
   `packet` (= the record's filename stem), `base`, `head` (the last executable
   commit, which carries a `Packet:` trailer), `changedPaths`, `symbols`.
   `scripts/check-records.sh` must be green. A narrative-only packet declares
   nothing and owes no block.
3. If the Critical set was touched: the review prompt (≤ 40 lines, per
   `review-tiers`) at the bottom of the record. Otherwise write
   `Review: not owed — outside the Critical set`.
4. Stop and report: frozen SHA, CI run, the record, the test-it-yourself list.

## The packet record — at most 150 lines

```
# <packet> — <outcome in one sentence>
Status / tier / Critical paths touched / stops taken
## Claims        (numbered; one line each; the review tests these)
## Decisions     (one line each: what, why, where it is written down)
## Slices        (one line each with its test-it-yourself anchor)
## Controls      (Critical set only: manifest entry -> claim it kills)
## Gates         (CI run URL/SHA; check-records; anything red, stated)
## Test it yourself
## Filed         (non-blocking findings, one line each -> archive table)
## Review prompt (if owed)
record-claim block
```

Ledger row, lane row and review-log row: **one line each**. No prose history in
rows; history is `git log`.

## Two lanes

BUILD holds the critical path. SUPPORT holds rulings, reviews, docs and small
correctives on paths BUILD does not own. A third lane is not started. Each lane
runs in its own worktree.

## Program review

Evaluate `program-review` triggers at stage boundaries only; the user selects it.
