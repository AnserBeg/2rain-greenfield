# Session handoff — 2026-08-08

**Written at the end of a long orchestration session. This is the live entry point;
`orchestrator-handoff.md` §§1–3 and 5–8 remain durable, but its §4 and its
2026-07-30 addendum are stale and banner-marked.**

Read in this order: `AGENTS.md` → this file → `docs/execution/current-plan.md` →
`docs/execution/purchasing-sales-v1-plan.md` §7 → `.agents/skills/review-tiers/SKILL.md`.

---

## 1. What you are

**Orchestrator and adjudicator. You never write product code.** You hand the user
self-contained packet prompts; the user pastes them into Codex lanes and pastes the
reports back. Reviews run in an online Codex arm that is read-only, cannot execute,
and cannot see GitHub check runs.

**The behaviours that are binding, and each has been paid for:**

- **Paste prompts inline, never a file path.** The user copies them into another
  tool.
- **Every prompt reconstructs state from disk.** A new Codex session knows nothing.
- **Sweep the governing files before writing a prompt.** Grep the pins; do not
  predict them. Three packets have stalled on a predicted pin.
- **Pre-authorize foreseeable out-of-lease bridges in the prompt**, so a lane does
  not stop to ask.
- **Adjudicate every review finding by reading the code yourself.** Reviewers are
  wrong sometimes and so are you — both happened today, in both directions.
- **Two-REVISE cap.** A third round on the same *class* means the charter is
  mis-scoped, not the code. Route the class; do not correct a fourth time.
- **The full CI matrix must be green at the integrated SHA**, by the executable-content
  rule in `git-workflow`, not by re-running reflexively.
- **Always end with a pasteable prompt or an explicit "nothing to do."** Never a
  summary that leaves the next move to inference.
- **Be direct. Recommend rather than survey. Flag your own misses plainly.**

**Two things you do NOT do, both learned the hard way today:**

- **You do not grant the matrix slot.** The lane reads
  `/tmp/north-star-matrix.lock.holders/*.json`, counts `ccd-cli` runtimes, and
  checks CPU idle itself. A verbal "the slot is free" is a measurement relayed
  across a turn boundary. See `lanes.md`.
- **You do not assert what only the tree can answer.** Every orchestrator error
  today was that shape — see §5.

---

## 2. The goal, in the user's words

> *An office worker can receive inventory and send it out.*

Four packets, serial by mechanical necessity (each module mount appends to a
content-addressed lineage and rewrites one fixed tuple in `builder.ts`):

**`PUR-1`** purchase order + lines, release and cancel → **`PUR-2`** goods receipt,
positive movements, correction, received-quantity read model → **`SAL-1`** sales
order → **`SAL-2`** shipment, negative movements, packing document.

Charter and every ruling: `docs/execution/purchasing-sales-v1-plan.md`. **Read §7
first — it supersedes §2's packet table and runs to §7.16.**

---

## 3. Where things are

### Landed today
`lock-obs` (the test lock names its holder; inherited claims validated against the
registry) and `U5b` (compiled disclosure tier — ships a **refusal**, and its rule
routed to `U5c`). Both in `ledger.md` with full rows.

### In flight — both in bounded revision, production confirmed sound in both

| Lane | Branch | State |
|---|---|---|
| `5g3-sm-impl` | `packet/5g3-sm` | Language `v5` cut; `transitionStateEffect` executes. **Round 3 on one forged-reference control** — narrow the claim, do not grow the table. |
| `pur1-intent-limit` | `packet/pur1-intent-limit` @ `b441aef` | Write path addresses an operation, not an intent (ADR-0051). Owes a **structural** gateway-request helper and a four-intent refusal table. |

### Closed as preserved probes — never merged
`packet/ps-0`, `packet/ps-2`, `packet/proj-disc`, `packet/u5-design`.
**`packet/ps-1` is do-not-reuse** — it carries a lock-order inversion its own report
described as a safety improvement.

### Parked
`packet/pur-1` at `2b6f7a3`. Owes one deletion (`received_quantity` — it belongs to
`PUR-2`, ruled in §7.12) and is blocked by the three items below.

### What blocks `PUR-1`
1. **`5g3-sm-impl` landing** — it makes release a compiled transition rather than a
   hand-written capability executor.
2. **`LANG-ADOPT-v5`** — chartered, unstarted. Adoption is **forced** (node-version
   purity moves every module together) and **cannot be free** (`DEFAULT_COMPILER_PROFILE`
   keys on the adopted version, so every release root moves and one lineage entry is
   minted).
3. **`pur1-intent-limit` landing.**

**`PUR-2` additionally inherits** the compiled posting-family profile, the companion
writer, and a first acceptance control that is **stock count, not goods receipt** —
three design passes ruled the mechanism settled having built only goods receipt, and
stock count refuted it every time (§7.16).

---

## 4. Doctrine written today, and where it lives

Thirty-one commits. The load-bearing set:

- **`review-tiers`** — a **checklist** at *"Does the evidence prove the claim?"* is
  the entry point; fourteen sections below it carry the measurements. **Start
  there.** Also: re-tier when the diff outgrows the row; an ADR that packets build
  against gets an external arm; verify the target is on `origin` before writing a
  prompt.
- **`git-workflow`** — a freeze SHA may sit above its matrix SHA when the delta is
  the record; a conflicted **derived** artifact is re-derived, never picked; the
  stash is repo-global and `pop` reaches for other lanes' entries; `learnings.md`
  is excluded from the executable-content diff.
- **`lanes.md`** — the orchestrator does not grant the slot; quiesced means CPU
  idle and idle worktrees, **not** session count; sample idle *after* the previous
  holder decays.
- **`mission-cadence`** — a preserved probe branch owes no matrix, and cannot reach
  matrix-green anyway because `repository-hygiene` requires every test file in a
  reviewed inventory.
- **ADRs 0049 (unratified), 0050 §7 (permission equality), 0051 §4 (structural, not
  scanned).**

---

## 5. Orchestrator errors from this session — do not repeat them

Every one is the same shape: **asserted where only the tree can answer.**

- **The local `main` ref sat 28 commits stale** because pushes went `HEAD:main` from
  a relay branch, which never moves the local ref. **Three lanes reported the plan
  was missing sections and all three were told they had stale checkouts.** They were
  right. Fixed; `main` tracks `origin/main` again.
- **Three lanes were told the slot was free** while a matrix was mid-run.
- **A review finding was relayed without verification** and the lane refuted it by
  measurement.
- **A function was named that does not exist** (`validateStateMachineMaterialization`).
- **A textual pin was ruled where a structural boundary was needed** (ADR-0051 §4).
- **A lane's claim was over-recorded as proven fact** — a lock-order inversion
  written into the plan as a demonstrated ABBA deadlock.
- **A control on a claim's *premise* was accepted as closing the claim.**
- **Conflict markers were committed to `main`** via `git add -A` after a conflicted
  cherry-pick, caught only by grepping the file.

---

## 6. Traps that will bite you

- **The main checkout cannot run anything.** `node_modules/@north-star/` has zero
  links and `zod` is absent, so `canonical-model` will not load. Row
  `main-worktree-install`. Repair with `pnpm install --frozen-lockfile`; never
  hardlink `node_modules` from another worktree.
- **A press-law guard is evaded on `main`** by a literal spliced as
  `` `${'northstar'}.${'inventory'}:capability.posting` ``. Row `press-law-evasion`.
- **`db/schema.snapshot.json` has no generator**, and four suites plus `check:schema`
  assert against it. Row `schema-snapshot-generator`.
- **Two preserved stashes hold real lane work.** They are tagged
  `preserved/g3-term-stash` and `preserved/g2-p3b-stash` and pushed, so a stray
  `pop` can no longer destroy them. **Never `git stash pop`; use `apply stash@{n}`.**
- **Twelve stale packet branches sit on `origin`.** Several are long accepted.
  `packet/ps-1` must be deleted rather than left.

---

## 7. Immediate next steps

1. **Send the two revision prompts** to `5g3-sm-impl` and `pur1-intent-limit` —
   both are written and both should apply the new *write-the-claim-from-the-measurement*
   rule before re-freezing.
2. **When either re-freezes**, verify the branch is on `origin`, then write a scoped
   confirm arm against the correction delta only.
3. **`LANG-ADOPT-v5` can be prompted at any time** — it needs no machine to author
   and it is the last unscoped item on the path to `PUR-1`. Its acceptance criterion
   is already written in the row: **two of five version omissions were unreachable by
   any generic version fixture**, so a checklist that compiles a plain package at the
   adopted version proves nothing.
