# AGENTS.md — greenfield ERP operating doctrine

Single operating doctrine for every agent in this repository. CLAUDE.md points
here. **Rewritten 2026-09-04 by user ruling** to remove the overhead the first six
weeks accumulated; the previous doctrine is preserved verbatim under
`.agents/skills/*/ARCHIVE.md` and in git history. If anything here conflicts
with the plan or an accepted ADR, say so and stop — do not improvise.

## 1. What this repository is

- The greenfield north-star ERP. Program authority:
  `docs/greenfield-north-star-erp-platform-plan.md`. Authority order:
  plan > accepted ADRs (`docs/decisions/`) > skills (`.agents/skills/`) > this file.
- Execution state: `docs/execution/ledger.md` (what landed),
  `docs/execution/current-plan.md` (what is next; read its top section first),
  `docs/execution/lanes.md` (who holds which paths right now).
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
chartered once, worked continuously, reviewed once at the end on its Critical
paths (§4). **A vertical is never split by review size or lease convenience.** It
splits only at a user-observable boundary, and only by the orchestrator.

**Partition by dependency, not by file.** The serialization in this codebase is
the mount chain — `builder.ts`, the release lineage, the migration number — plus
the posting kernel and the three record files. Two verticals that both mount a
module or both enter the posting kernel run **one after the other**; leases
between them are pointless. Two verticals that share none of that run in
parallel with no lease at all. Today: RECEIPT then SALE are serial; AUTH runs
beside either.

**Topology — the human is not the message bus.**

- **The BUILD agent owns the vertical end to end**: reads the charter, builds
  every slice, pushes, and **integrates its own vertical on CI green when no
  review arm is owed** (`git-workflow`, Integration). It writes the record and
  the three one-line rows itself.
- **The orchestrator is a session opened for three jobs only**: charter the next
  vertical (≤ 60 lines); adjudicate the one Critical arm by reading the code and
  integrate that vertical; keep the plan honest at stage boundaries. It is not a
  relay and it does not stand between the writer and `main`.
- **The user does two things**: tests the product at each slice's "Test it
  yourself", and pastes exactly one Critical review prompt and its verdict when
  a vertical touches the Critical set. Nothing else passes through the user.
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

## 4. Review — one arm, on the Critical set only

- **Critical set:** `packages/postgres-provider/src/inventory-posting-service.ts`,
  `stock-serializer.ts`, the posting trigger and rebuild in
  `module-storage-materializer.ts`, `release-activation.ts`,
  `release-verification-service.ts`, the trust substrate under
  `platform-runtime/src/trust/`, `db/migrations/**`, and RLS/grant SQL.
- A vertical that touches the Critical set gets **one fresh-naive arm**, user-run,
  on the diff to those paths and the claims the writer lists. **Production
  defects are fixed; everything else — evidence, controls, records, wording — is
  filed as one line and never earns a round.** A second arm is owed only when
  the first found a production defect.
- Everything outside the Critical set ships on typecheck, tests, CI and the
  user clicking through it. No arm.
- Mechanics: `review-tiers` skill (≤ 100 lines).

## 5. Gates

- **CI green at the pushed SHA is the acceptance matrix.** `.github/workflows/ci.yml`
  runs the same suites the local matrix did. `scripts/run-matrix.sh` is a
  local convenience, not a requirement. No local slot, no lock, no
  `FULL_MATRIX_PASS_SHA`.
- Integration is a `--no-ff` merge of the packet into `main`; the reviewed tip is
  the second parent (`check-review-record.sh` reads it). A merge outside the
  Critical set records a one-line `no arm owed` row.
- **Evidence depth is proportionate.** In the Critical set: one discriminating
  red per claim in the expected-red manifest. Elsewhere: tests. Nothing else is
  owed.
- Docs-only commits re-run `scripts/check-records.sh` only; CI covers the rest
  on push.
- Standing rules that do not relax: no hard-delete paths for business data;
  elapsed-time logic uses a monotonic source and timing tests inject a clock;
  a gate observes the fact it asserts, never a proxy.

## 6. Records — one page, and the doctrine is frozen

- **A packet record is at most 150 lines**, in the template in
  `mission-cadence`: claims, gates, controls (Critical only), test-it-yourself,
  the `record-claim` block, decisions taken in one line each.
- A ledger row, a lane row and a review-log row are **one line each**.
- **No new queue row without the step it blocks.** Non-blocking findings are one
  line in `current-plan-archive.md`, table *Filed during the freeze*.
- **Doctrine freeze until 2026-10-04.** No new rule in this file or any skill.
  After that, a rule is added only by deleting one of equal or greater length.
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

`mission-cadence` (the vertical and its checkpoints) · `review-tiers` (the one
arm) · `git-workflow` (branches, freeze, merge, push, worktrees) ·
`program-review` (stage-boundary whole-app review, unchanged) ·
`salvage-admission` · `ux-grammar` · `capture-learnings`.

## 10. What was retired on 2026-09-04

One user-selected packet at a time; the tier matrix and the Fable confirm; the
two-REVISE cap and the convergence questions; Band A negative controls outside
the Critical set; the local full matrix as the acceptance gate; four parallel
lanes; the orchestrator-never-edits rule; unbounded packet records. Each is
preserved verbatim in the skills' `ARCHIVE.md` files with the date it was
retired, and every incident that earned it is still cited there.
