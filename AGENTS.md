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

## 3. Cadence — a writer works a vertical, the user tests at checkpoints

- **The unit of work is a vertical**: everything an office worker needs for one
  user-visible capability (the goods receipt end to end, then the sale end to
  end). It is chartered once, worked continuously by ONE writer lane, and
  reviewed once at the end on its Critical paths (§4).
- **Checkpoints, not stops.** Every slice inside the vertical ends with a
  "Test it yourself" block the user can run in under ten minutes. The writer
  does not wait for a ruling to continue to the next slice.
- **Stop only on the STOP list:** (a) a one-way door — a canonical language
  version, a ruling on money, time or identity, anything that would survive a
  lineage reset; (b) a lease collision with the other live lane; (c) a CI red
  the writer cannot make green honestly inside the slice; (d) a design fork
  with product-visible consequences the plan does not settle. Everything else
  the writer decides, notes in the record in one line, and continues.
- **Two lanes, never more:** BUILD (the critical path) and SUPPORT (rulings,
  reviews, docs, small correctives on paths BUILD does not hold).
- Mechanics: `mission-cadence` skill (≤ 120 lines).

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

## 7. The orchestrator edits

The orchestrator makes mechanical edits directly instead of stopping a lane:
pin updates, manifest repoints, status lines, records, lane rows, bridges of a
few lines into accepted artifacts, CI configuration. It still does not write
product features — the writer does — and it still verifies before ruling by
reading the code.

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
