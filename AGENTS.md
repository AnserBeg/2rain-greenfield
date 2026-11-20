# AGENTS.md — greenfield ERP operating doctrine

Single operating doctrine for every agent in this repository. CLAUDE.md points
here. **Rewritten 2026-09-04 by user ruling** to remove the overhead the first six
weeks accumulated; **§3-§6 amended 2026-11-15** (one trunk; review after the
merge). Earlier doctrine is verbatim under `.agents/skills/*/ARCHIVE.md`. If anything here conflicts
with the plan or an accepted ADR, say so and stop — do not improvise.

## 1. What this repository is

- The greenfield north-star ERP. Program authority:
  `docs/greenfield-north-star-erp-platform-plan.md`. Authority order:
  plan > accepted ADRs (`docs/decisions/`) > skills (`.agents/skills/`) > this file.
- Execution state: `docs/execution/ledger.md` (what landed),
  `docs/execution/current-plan.md` (what is next; read its top section first).
- The prior repository `/home/rvham/2rain_erp` is a read-only quarry
  (`salvage-admission` skill).

## 2. The rule that governs the rest — proportion

Six weeks of measurement (`docs/execution/program-reviews/2026-09-01-inventory-ledger.md`)
showed the method finding real defects and costing four to six review rounds, an
800-line record and a serialized local matrix per packet, with half the
platform work protecting released data that does not exist. This doctrine keeps
what found the defects and removes what only produced rounds.

**Pre-tenant development mode is in force** ([ADR-0066](docs/decisions/ADR-0066-pre-tenant-development-re-baselines-the-release-lineage.md)).
There is no production tenant. Until the first one, a storage change the planner
refuses is resolved by re-baselining the release lineage, not by building a
transition. The kernel's immutability mechanics stay in code and in tests.

## 3. Unit, partition, topology — corrected 2026-09-05

**The unit is a vertical**: everything an office worker needs for one
user-visible capability (the goods receipt end to end, then the sale). It is
chartered once, worked continuously and merged on CI green. **A vertical is never split by review size or lease convenience.** It
splits only at a user-observable boundary, and only by the orchestrator.

**Partition by dependency, not by file.** The serialization in this codebase is
the mount chain — `builder.ts`, the release lineage, the migration number — plus
the posting kernel and the three record files. Two verticals that both mount a
module or both enter the posting kernel run **one after the other**; leases
between them are pointless; two that share none of that run in parallel with no
lease. **One trunk:** a branch is cut from `main`, never stacked on another, and
merges within two days or is dropped.

**Topology — the human is not the message bus.**

- **The BUILD agent owns the vertical end to end**: reads the charter, builds
  every slice, pushes, and **integrates its own vertical on CI green**
  (`git-workflow`, Integration). It writes the record and its two rows itself.
- **The orchestrator drives the program** (owner, 2026-11-17): it charters the
  next vertical (≤ 60 lines), launches BUILD lanes itself as Claude subagents
  (Opus for Critical or design-heavy work, Sonnet for mechanical work), launches
  and adjudicates the read of the trunk itself (§4), and keeps the plan honest.
  It does not stand between a writer and `main`.
- **The user tests when they choose** at a slice's "Test it yourself" and owns
  one-way doors and the week-6 decision. No review passes through the user.
- **Reviewers and writers read the kernel note, not the records.**
  `docs/architecture/posting-kernel-guarantees.md` states what the posting
  kernel guarantees, at which symbol, and why, in under sixty lines. The
  records and archives exist for the day something breaks.

**Checkpoints, not stops.** Every slice ends with a "Test it yourself" block
runnable in under ten minutes. **Stop only on the STOP list:** (a) a one-way
door — a canonical language version, a ruling on money, time or identity,
anything that survives a lineage reset; (b) a real dependency collision with a
parallel vertical; (c) a CI red the writer cannot make green honestly inside
the slice; (d) a design fork with product-visible consequences the plan does
not settle. Everything else the writer decides, notes in one line, and
continues. Mechanics: `mission-cadence`.

## 4. Review — one read of the trunk, after the merge

- **Nothing waits for a review.** While pre-tenant (no `rulings/first-tenant.md`,
  ADR-0066's switch) a vertical merges on CI green; review reads `main` afterwards.
- **Critical set.** Git pathspecs below include the posting-trigger/rebuild container. RLS/grant SQL is also Critical, including SQL embedded in executable files.

<!-- critical-pathspecs -->
`packages/postgres-provider/src/inventory-posting-service.ts`
`packages/postgres-provider/src/stock-serializer.ts`
`packages/postgres-provider/src/module-storage-materializer.ts`
`packages/platform-runtime/src/release-activation.ts`
`packages/postgres-provider/src/release-verification-service.ts`
`packages/platform-runtime/src/trust/**`
`db/migrations/**`
<!-- end-critical-pathspecs -->

- **A read is owed** — one fresh-naive Codex arm the orchestrator launches over
  the Critical diff on `main` since the last read — when that diff passes 400
  changed lines, and before a stage gate, the week-6 decision or the first tenant.
- **It asks whether the diff can do silent harm**: a wrong quantity or amount, a
  lost or repeated posting, a crossed tenant or company boundary, a wider grant,
  a missing audit row, a release passed that should be refused. Silent defects
  are fixed with a test. A failure that announces itself is filed as one line.
- **No confirm arms.** A fix merges on CI green and is in the next read's range.
  Mechanics: `review-tiers`.

## 5. Gates

- [Tiered CI](docs/execution/evidence-on-demand.md#packet-and-main-ci) selects packet coverage and runs full on every main push, in parallel. Before pushing main run `node scripts/check-merge-window.mjs <id> <integration-SHA>`. Run focused tests locally. CI owns the heavy suites.
- Integration is a `--no-ff` merge of the packet into `main`; the packet tip is
  the second parent (`check-review-record.sh` reads it). Every merge records one
  review-log row: `merged — no Critical path` or `merged — unread`.
- **Evidence depth is proportionate.** One discriminating red per claim that a
  silent harm cannot happen. Elsewhere: tests. Nothing else is owed.
- Docs-only commits re-run `scripts/check-records.sh` only; CI covers the rest
  on push.
- Standing rules that do not relax: no hard-delete paths for business data;
  elapsed-time logic uses a monotonic source and timing tests inject a clock;
  a gate observes the fact it asserts, never a proxy.

## 6. Records — one page, and the doctrine is frozen

- **A packet record is at most 80 lines**, in the template in
  `mission-cadence`: claims, gates, controls (silent-harm claims only),
  test-it-yourself, the `record-claim` block, decisions in one line each.
- A ledger row and a review-log row are **one line each**. `lanes.md` is retired:
  with one trunk, `gh pr list` shows what is open.
- **No new queue row without the step it blocks.** Non-blocking findings are one
  line in `current-plan-archive.md`, table *Filed during the freeze*.
- **Doctrine is delete-to-add.** A rule is added to this file or a skill only by
  deleting one of equal or greater length.
  Skill sizes are capped: `mission-cadence` 120, `review-tiers` 100,
  `git-workflow` 150 lines; `program-review`, `ux-grammar`, `salvage-admission`
  and `capture-learnings` unchanged.

## 7. Who edits what

The BUILD agent edits everything inside its vertical, including pins, manifests,
records and rows, and small bridges into accepted artifacts that its gates
demand — disclosed in one line, never stopped for. The orchestrator, when open,
makes the same mechanical edits on `main` directly. Nobody stops a lane for an
edit of a few lines.

## 8. Conduct and environment

- No secrets in source, fixtures, package revisions or prompts.
- All commands run in Ubuntu/WSL against `/home/rvham/...` paths. WSL2 steps its
  wall clock backward ~2s under load (see §5).
- A lane works in its own `git worktree`; never `git add -A`; never bare
  `git stash`/`pop` (`git-workflow`).
- Adjudicated lessons go to `learnings.md` via `capture-learnings`.

## 9. Skills

`mission-cadence` (the vertical and its checkpoints) · `review-tiers` (the read
of the trunk) · `git-workflow` (branches, freeze, merge, push, worktrees) ·
`program-review` (stage-boundary whole-app review, unchanged) ·
`salvage-admission` · `ux-grammar` · `capture-learnings`.

## 10. What was retired

**2026-11-15:** the arm before a merge; the second arm on a fix; stacked
branches; lane rows; the 150-line record. **2026-09-04:** one user-selected
packet at a time; the tier matrix and the Fable confirm; the two-REVISE cap and
the convergence questions; Band A negative controls outside the Critical set;
the local full matrix as the acceptance gate; four parallel lanes; the
orchestrator-never-edits rule; unbounded packet records. Each is preserved
verbatim in the skills' `ARCHIVE.md` files with its date and its incidents.
