# Parallel lanes — coordination protocol

**Read this before starting or resuming any packet while more than one lane is
active.** `mission-cadence` permits parallel packets only when the user
explicitly selects them and their owned paths are disjoint. The user selected
three lanes on 2026-07-28 to compress the inventory timeline.

The writers cannot see each other. Every session reconstructs state from disk,
so the shared state lives here. If this file says a lane is active, assume a
writer is holding those paths right now.

## The lanes

| Lane | Theme | Current packet | Base | Status |
|---|---|---|---|---|
| **KERNEL** | Canonical language and the query tier | *awaiting selection — `4b` is next and moves no artifacts* | — | **idle** |
| **DEPLOY** | Release lifecycle and runtime infrastructure | `1b` — release-admission verification integrity | `07ce6de` | active |
| **FIX** | Correctness defects → stage cutting → **inventory build** | *awaiting selection — `G3-P1` is unblocked and needs no aggregate lowering* | — | **idle** |

Lane identity is stable across packets. When a lane's packet is accepted, the
next packet inherits the lane and its partition.

## Path partition — binding

Disjointness is enforced at prompt time by the orchestrator, not discovered at
merge time. `packages/compiler/src/` in particular is **split**, because F7 and
the query tier both live there.

| Path | Lane |
|---|---|
| `packages/canonical-model/src/**` | KERNEL |
| `packages/compiler/src/predicate-lowering.ts` | KERNEL |
| `packages/compiler/src/compiler.ts` | KERNEL *(granted 2026-07-28 for packet 4a — profile dispatch only; FIX is on a test-only packet)* |
| `packages/runtime/src/semantic-query-gateway.ts` | KERNEL |
| `packages/compiler/src/storage.ts` | **FIX** |
| `packages/compiler/src/projections.ts` | **FIX** |
| `packages/postgres-provider/src/module-storage-materializer.ts` | FIX |
| `apps/api/**` | DEPLOY |
| `packages/postgres-provider/src/composed-application-runtime.ts` | DEPLOY |
| `packages/postgres-provider/src/release-*.ts` | DEPLOY |
| `packages/compiler/src/verification.ts` | DEPLOY *(assigned 2026-07-28 for packet 1b)* |
| `db/schema.snapshot.json` | DEPLOY *(granted 2026-07-28 for 1b — migration 0013 moves it)* |
| `test/architecture/release-persistence-boundary.test.ts` | DEPLOY *(granted for 1b — hardcodes the migration inventory through 0012)* |
| `test/fixtures/g2/*/runtime-harness.ts` | DEPLOY *(granted for 1b — all four mint `randomUUID()` evidence and must produce genuine evidence instead; **no test-only bypass**)* |
| `db/migrations/**` · `packages/postgres-provider/src/migrations.ts` | **DEPLOY while 1b runs** — reassigned from FIX, whose current packet (1e press guards) needs no migration. Reverts to FIX when 1b lands. |
| `packages/postgres-provider/src/module-runtime-interpreter.ts` | KERNEL |
| `docs/execution/packets/**` · `docs/execution/stage-cut-inputs.md` | FIX *(granted 2026-07-28 for G3-P0; each lane still owns its own packet doc)* |
| `apps/web/**` · `packages/domain/**` | **none — frozen while three lanes run** |

A lane needing a path outside its column files a **bridge request naming its
lane**. The orchestrator either grants it (if no other lane holds it) or
serializes the two packets.

## Orchestrator-only — no lane may touch these

  docs/execution/ledger.md
  docs/execution/current-plan.md
  docs/execution/lanes.md
  docs/decisions/**        (except a packet's own new ADR file)

These are the highest-conflict files in the repository and they are all
narrative. Removing them from every lease removes most merge risk outright.

## Shared files — add-only, re-derive on conflict

Any lane may need these. They are **add-only** and a conflict in them is never
resolved by hand-merging:

  test/architecture/repository-hygiene.test.ts   (test inventory)
  test/architecture/test-reachability.test.ts    (script recognition)
  pnpm-lock.yaml                                  (generated)
  package.json (root)                             (scripts)
  .github/workflows/ci.yml                        (steps)

**On rebase conflict: discard your side, take main's, and re-derive your entry.**
The inventories are mechanical — re-run discovery and re-insert alphabetically.
Never hand-merge an inventory; that is how a silently-missing entry gets shipped.

Never add to an exemption or allowlist under any circumstances without a bridge —
`rootScriptCiAllowlist` is the live example.

## Artifact-moving packets may run concurrently — corrected 2026-07-28

Release artifacts (`*.golden.sha256`, `app.compiled.json`, `shell.compiled.json`,
release roots) are **generated** — deterministic functions of source. Two lanes
changing different definitions each regenerate; at integration the merged source
regenerates once more and the result is correct.

**So "this packet moves release roots" does NOT mean it must run alone.** Source
disjointness is the requirement; generated-artifact conflicts are re-derived, per
the shared-files rule below.

**The one exception:** a packet whose *proof* is that artifacts did not move —
`4a` and `4b` — cannot run beside one that moves them, because its baseline
would shift under it. That exception ends when `4b` lands.

The orchestrator enforced the stronger constraint until 2026-07-28 and it cost
sequencing that was never required.

## Integration is serial even though work is parallel

Work in parallel; integrate one at a time. This is forced by PR-1's rule that
the **full CI matrix must be green at the exact integrated SHA**.

  1. A lane freezes a candidate and reports.
  2. The orchestrator adjudicates and reviews.
  3. **First lane ready integrates first.** If `main` has not moved, fast-forward
     — the reviewed SHA and the integrated SHA are then identical and the
     matrix already covers it.
  4. Every other lane then **merges current `main` into its branch and re-runs
     the full matrix at the resulting integrated SHA**. Never rebase `main`,
     never reset it, never squash away the reviewed candidate.

A lane that reports a candidate built on a base `main` has since passed is not
rejected — it merges and re-runs. Q1-P1 did exactly this and it cost one matrix
run.

### Exception: an orchestrator docs-only advance does not force a re-run

**If the only difference between the lane's merge base and current `main` is
under `docs/` or `.agents/`, the lane does NOT re-merge and does NOT re-run.**
The orchestrator merges those at acceptance. The tested code and the integrated
code are byte-identical, so a re-run would observe nothing new.

This exists because the orchestrator commits rulings, ledger rows and queue
updates continuously while lanes work — without this rule a lane chases doc
commits indefinitely and never reaches a stable integrated SHA. Added 2026-07-28
after exactly that happened to KERNEL twice in one packet.

**The exception is narrow and the orchestrator verifies it, not the lane.** Any
file outside `docs/` or `.agents/` — product code, test, config, migration,
lockfile, generated artifact — voids it and the full merge-and-re-run applies.
When in doubt, re-run: a wasted matrix costs minutes, an untested integration
costs the rule PR-1 exists to enforce.

## Report header — mandatory

Every report back to the orchestrator opens with one line, so a paste is
unambiguous without context:

    LANE: <KERNEL|DEPLOY|FIX> · PACKET: <id> · SHA: <frozen sha> · BASE: <base sha>

Bridge requests open with the same line. The orchestrator adjudicates three
streams; an unlabelled SHA is the single easiest way to mis-grant a lease.

## What does not change

Everything in `AGENTS.md`, `mission-cadence`, and `review-tiers` applies
unchanged per lane: one frozen candidate, honest gates at the integrated SHA,
negative controls with recorded reds, the two-REVISE cap, fresh naive reviewers,
and no self-certification. Parallelism buys throughput, not a lower bar.
