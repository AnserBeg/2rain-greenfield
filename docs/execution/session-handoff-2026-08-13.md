# Session handoff — 2026-08-13

**This is the live entry point. It supersedes `session-handoff-2026-08-08.md`,
which remains accurate for its own date but is stale on lane state, the queue,
and two pieces of doctrine that changed today.**

Read in this order: `AGENTS.md` → this file → `docs/execution/current-plan.md`
**starting at the TRIAGE section at the top** → `.agents/skills/review-tiers/SKILL.md`
→ `.agents/skills/mission-cadence/SKILL.md`.

**`main` is at `9009876`.** Machine free at time of writing: 0 lock holders, load 0.20.

---

## 1. What you are

**Orchestrator and adjudicator. You never write product code.** You hand the user
self-contained packet prompts **pasted inline, never a file path**; the user pastes
them into Codex lanes and pastes the reports back.

**Binding behaviours, each paid for:**

- **Every prompt reconstructs state from disk.** A fresh lane knows nothing.
- **Sweep the governing files before writing a prompt.** Grep the pins; do not
  predict them. Line numbers drift — re-locate by symbol.
- **Pre-authorize foreseeable out-of-lease bridges** so a lane does not stop to ask.
- **Adjudicate every review finding by reading the code yourself.** Both you and
  the reviewers are wrong sometimes, and both happened today.
- **Always end with a pasteable prompt or an explicit "nothing to do."**
- **Be direct. Recommend rather than survey. Flag your own misses plainly.**

**Two you do NOT do:**

- **You do not grant the matrix slot.** The lane reads the registry and its own
  gate. A window someone tells you about is stale the moment it is spoken.
- **You do not assert what only the tree can answer.** Every orchestrator error
  today was that shape — see §5.

---

## 2. The goal, unchanged

> *An office worker can receive inventory and send it out.*

`PUR-1` purchase order + lines, release and cancel → `PUR-2` goods receipt and
positive movements → `SAL-1` sales order → `SAL-2` shipment and negative movements.
Charter: `docs/execution/purchasing-sales-v1-plan.md`, **§7 supersedes §2's packet
table**.

---

## 3. Where things are

### Landed today
`pur1-intent-limit` (accepted, `777fb61`) · `ux-picker` (accepted, merged at
`af3462c`) · `dev-environment` (accepted, `4f31ea9`) · **`LANG-ADOPT-v5`
(ACCEPTED — it is no longer a blocker).**

### `PUR-1` now has exactly ONE blocker
**`relation-scoped-enumeration`** — the record picker that makes a required
relation fillable. **Until it lands, a purchase order cannot be given a supplier
from any web surface.**

### The blocked predecessor, preserved and NOT to be resumed
`ux-reference-picker` returned **BLOCK at round 2** with an explicit instruction
not to run a third revision — three of round 1's classes recurred. Verified on
`origin`:

```
23fa4c7f3d5b65b02558bbf058729b542b9a304f  refs/tags/ux-reference-picker-reviewed-r2   (e9c9cd5)
baa6f6cd8548c6a066e5fbe254300ce725324d46  refs/tags/ux-reference-picker-blocked-head  (085c0f7)
```

**Do not merge it.** `main` has since replaced the intent-addressed write path with
an operation-addressed one (ADR-0051), so its browser half needs rewriting anyway.

**The measured blocker it died on, and the next packet must not inherit it:**
`pickerListSurfaceFor` rejected any target list declaring `legalEntityScope`, and
**every first-party inventory target list is scoped** — `inventory_transaction`,
`inventory_transaction_line`, `stock_count`, `stock_count_line` all scoped; only
`party`, `party_role`, `legal_entity` unscoped. **So three of the four surfaces
ADR-0052 cites as the live defect still refused, and only `party_role` was fixed.**
**ADR-0052 §7's justification is FALSE and must be amended, not inherited:** it
claims the caller cannot supply the scope, but `renderSurfaceRuntimeWithData`
already computes `legalEntitySelection` and hands it to the workspace context bar
— it was simply never passed to the picker.

### Carrying a stated limitation
**`relation-contract-integrity` is `evidence_ready`, not accepted.** Two arms both
REVISE; the fix after the second reached `main` unreviewed and the gate caught it.
The orchestrator performed the owed arm **locally** (`local-confirm` at
`c9656802122b63d53d73409f832a11ff5ce485b3`) and recorded its own limits: not
fresh-naive, and **the deletion question was never asked of its 226-line test
delta.** **An independent online arm on that delta is still worth running.**

---

## 4. The triage — read `current-plan.md`'s TRIAGE section, this is the summary

134 rows, classified against one question: **does this block an office worker
receiving inventory?**

**TIER 1 (6 rows).** `relation-picker-rechartered` · `required-relation-uncreatable`
· `relation-scoped-enumeration` · `form-empty-means-nothing` ·
`form-write-untyped-wire` · `relation-refusal-unnamed`.

**Five of the six are ONE investigation — can the web form write anything that is
not a text box.** Charter them together; they have been discovered four separate
times as four separate packets, which is a large part of why this has taken so long.

**TIER 2 (4).** `ux-list-usability` · `surface-command-order` ·
`relation-update-fork` · `ux-clutter`.

**TIER 3 (5).** `container-pressure-forges-outcomes` — **rank it first; Docker
volume pressure produces a WRONG release-activation outcome, not merely a slow one,
so a matrix result is not trustworthy without knowing the container state it ran
under. Everything else in this tier costs time; this one costs correctness.** Then
`merge-direction-hides-packet-work` · `gate-reads-a-different-thing-than-its-name`
· `unrun-quality-gates` · `leak-guard-orphan` + `matrix-machine-decay`.

**DORMANT: ~115 rows.** The G2/G3 backlog, the U-series UX programme, language and
coverage rows, most matrix ergonomics. **Not deleted, not wrong, not competing.**

**The rule this installs: a finding that surfaces during a packet is FILED AND
LEFT, not worked, unless it is Tier 1. Filing is not handling.**

---

## 5. Doctrine that changed today

**The two-REVISE count cap is GONE, replaced by convergence criteria**
(`review-tiers`, "Convergence"). Counting rounds stopped packets that were
converging and let spiralling packets run to six arms anyway. Ask instead: **where
does the defect live** (production → continue; the claim's prose → one narrowing
round then stop), **is the class new**, and decisively — **did the last fix SUBSUME
the previous one or sit BESIDE it?** Subsuming converges, continue. Enumerating
diverges, stop and route. **Two overrides beat all three:** a regression introduced
by the previous fix always continues, and blast radius raises the bar for stopping.
**From round three on, the orchestrator must name the licensing criterion in
writing** — the count is now a forcing function, not a wall.

**The lane writes its own review prompt** (`mission-cadence`). At freeze the lane
emits the complete pasteable arm — SHA with `ls-remote` quoted, delta, tier, its
claims **as claims**, and **what it did not verify**. **The lane may not fence
scope**; fencing stays with the orchestrator, and every lane-written prompt carries
the "nothing in this prompt bounds your scope" clause verbatim.

---

## 6. Orchestrator errors today — all one shape

**Said "the arm is out" when a prompt had been handed to the user and never
confirmed as run.** A lane polled thirty minutes against a fact that did not exist.
**A stated intention is not a completed fact.**

**Told the user a merged packet's form controls would be visible in `pnpm dev`.**
They were not — that server was hardcoded to a four-surface shell fixture. **Read
the names, not the code.**

**Recorded a 7-character SHA in `review-log.md`.** `check-review-record.sh:116`
reads `[0-9a-f]{40}` — the row was silently ignored and looked identical to no row.

**Cited `main-worktree-install` as live when its subject had moved to a lane
worktree.** A lane repeated it and predicted a doomed run that was not doomed.

**A scripted whole-file edit (`8cab25a`) silently dropped a record someone else had
to restore (`f8c583e`).** Second bulk-edit loss this session.

---

## 7. Traps

- **`check-review-record.sh` reads `review-log.md` from the WORKING TREE** while
  walking commits on the branch, so it can pass for one worktree and fail for
  another at the same instant. Verify from a tree checked out at `origin/main`.
- **Integration must be `--no-ff` of the packet INTO `main`.** Merging `main` into
  the packet and fast-forwarding puts the packet's commits on the first-parent
  chain where the gate cannot see them. **Two lanes produced that shape
  independently — it is the default outcome, not a slip.**
- **Never `git stash pop`** — the stash is repo-global. Use `apply stash@{n}`.
- **Never `git add -A`.** Lanes share `/home/rvham/2rain-greenfield`.
- **Run matrices in a detached worktree**, pinned before and after. A lane lost two
  windows to a branch switch hijacking its run.
- **Read `MATRIX_EXIT` from inside the log**, never from a pipeline's exit status,
  and make sure `LOCK_BUSY` cannot read as silence.
- **`pnpm dev` now really does run the app** (`apps/api`, port 4174, seeds a
  `distributor` profile, manages its own container). `dev:stop` **stops the
  container but leaves the node server listening** — kill it explicitly.

---

## 8. What can start next

**The machine is free and there is no lane work in flight.**

**START FIRST — `relation-scoped-enumeration`, chartered with the rest of Tier 1's
write-path rows as one packet.** It is `PUR-1`'s only blocker. It must own the
scoped-list fix, amend ADR-0052 §7 rather than inherit it, and close
`required-relation-uncreatable`, `relation-refusal-unnamed`,
`form-empty-means-nothing` and `form-write-untyped-wire` in the same investigation.

**CAN RUN IN PARALLEL — `container-pressure-forges-outcomes`.** Disjoint paths
(scripts and test harness, not `apps/web/src`), and it is the row that makes every
other matrix result trustworthy.

**CANNOT RUN IN PARALLEL WITH TIER 1 — the rest of Tier 1 and all of Tier 2.**
They all touch `apps/web/src`, and `web-form-lease-contention` records three
unintegrated branches already holding the same three files there. **Serialize
them.**

**ALSO READY, needs no machine — the independent online arm on
`relation-contract-integrity`'s 226-line test delta**, which the local confirm
explicitly did not discharge.
