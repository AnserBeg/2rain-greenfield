# Parallel lanes — coordination protocol

**Read this before starting or resuming any packet while more than one lane is
active.** `mission-cadence` permits parallel packets only when the user
explicitly selects them and their owned paths are disjoint. The user selected
three lanes on 2026-07-28 to compress the inventory timeline, and a fourth
(BUILD) once G3-P1a proved startable without the artifact window.

The writers cannot see each other. Every session reconstructs state from disk,
so the shared state lives here. If this file says a lane is active, assume a
writer is holding those paths right now.

## The lanes

| Lane | Theme | Current packet | Status |
|---|---|---|---|
| **KERNEL** | Canonical language and the query tier | `4c` **accepted** 2026-07-28 — **`Q1-P3b` is next and now unblocked** | **idle** |
| **DEPLOY** | Release lifecycle and runtime infrastructure | `9` **accepted** 2026-07-28 (breadth-envelope curve) — *awaiting selection; `1c-b` when compiler/domain leases release* | **idle** |
| **FIX** | Correctness defects → stage cutting → inventory build | `G3-P1b` — legal-entity family map and key participation | **active** |
| **BUILD** | Inventory contracts | `G3-P2a` — tenant-completeness manifest | **active** |

Lane identity is stable across packets. When a lane's packet is accepted, the
next packet inherits the lane and its partition.

## DEPLOY stays idle until 4c lands — decided 2026-07-28

Both candidate packets for the free DEPLOY lane currently collide with KERNEL's
`4c` leases:

  - **`1c`** (platform classification) needs
    `packages/domain/src/platform/definition.ts` — held by KERNEL for 4c's
    version migration.
  - **`1g2`** (reverse-transition policy) needs
    `packages/postgres-provider/src/release-*.ts` and
    `composed-application-runtime.ts` — both released to KERNEL for 4c.

**Leaving a lane idle is a legitimate decision.** Starting a fourth packet that
must serialize against 4c creates exactly the contention this file exists to
prevent, and 4c is the inventory critical path. Three lanes on it is already the
most the dependency graph allows.

Reconsider the moment 4c integrates: `1c` is the stronger candidate — 1b's gate
now refuses the platform package, so saved filters are non-releasable and the
row is a red test rather than an argument.

**The scoping pass is already done, and it inverted the prediction.** An earlier
draft of this section said the Tier-B branch likely needs a canonical concept
that does not exist. **It does not** — `schemas.ts:947-950` declares
`storageClass` as `.nullable().optional()`, so an entity carrying no compiled
storage class is expressible at v2 today; the `normalize.ts:773-779` rule that
would refuse it is gated on `LEGACY_LANGUAGE_VERSION` and binds v0-experimental
packages only. What refuses the shape is two **compiler** rules outside
`canonical-model`: `conformance.ts:169-177` and `storage.ts:433`. **Branch (a) is
the one needing a canonical concept** — migration 0012 scopes saved-filter RLS on
`owner_principal_id`, and no per-principal row-ownership primitive exists
anywhere in the compiled path. Full finding, with the discriminator answer, is in
`current-plan.md` row 1c. **Do not re-derive it from this file; read that row.**

## Path partition — binding

Disjointness is enforced at prompt time by the orchestrator, not discovered at
merge time. `packages/compiler/src/` in particular is **split**, because F7 and
the query tier both live there.

| Path | Lane |
|---|---|
| `packages/canonical-model/src/**` | KERNEL |
| `packages/compiler/src/predicate-lowering.ts` | KERNEL |
| `packages/compiler/src/compiler.ts` | **KERNEL (4c) and FIX (G3-P1b) — split by concern, granted 2026-07-28.** KERNEL owns language/profile dispatch; FIX owns **storage-target payload v1/v2 family recognition only** (the import near line 54 and the guard near line 1764). Verified disjoint before granting: 4c's hunks sit at ~1-11, 73-109, 789-836 and 990-1022, and 4c touches `STORAGE_TARGET_PAYLOAD_VERSION` **zero** times. 4c integrates first, so FIX merges and takes main's side on dispatch. *(Supersedes the 4a-era note "FIX is on a test-only packet" — no longer true.)* |
| `packages/runtime/src/semantic-query-gateway.ts` | KERNEL |
| `packages/compiler/src/storage.ts` | **FIX** |
| `packages/compiler/src/projections.ts` | **FIX** |
| `packages/compiler/src/protocol.ts` | **FIX** *(granted 2026-07-28 for `G3-P1b` — declare `northstar.storage-target-payload/v2` only. This is a ratified **Freeze F** artifact, but [ADR-0015](../decisions/ADR-0015-legal-entity-business-dimension.md):79 and :116 explicitly authorize this bump "under that ADR's own evolution rule" and name it as an accepted cost, so it is anticipated evolution rather than a freeze violation. Tenant-shared targets stay v1 and byte-identical.)* |
| `packages/postgres-provider/src/module-storage-materializer.ts` | FIX |
| `apps/api/**` | DEPLOY |
| `packages/postgres-provider/src/composed-application-runtime.ts` | **KERNEL** *(released from DEPLOY 2026-07-28 on 1b's integration, for 4c)* |
| `packages/postgres-provider/src/release-*.ts` | **KERNEL** *(released from DEPLOY 2026-07-28 on 1b's integration, for 4c)* |
| `packages/compiler/src/verification.ts` | DEPLOY *(assigned 2026-07-28 for packet 1b)* |
| `db/schema.snapshot.json` | DEPLOY *(granted 2026-07-28 for 1b — migration 0013 moves it)* |
| `test/architecture/release-persistence-boundary.test.ts` | DEPLOY *(granted for 1b — hardcodes the migration inventory through 0012)* |
| `test/fixtures/g2/*/runtime-harness.ts` | **KERNEL** *(released from DEPLOY 2026-07-28 on 1b's integration, for 4c's version-stamp fix)* |
| `db/migrations/**` · `packages/postgres-provider/src/migrations.ts` | **FIX** *(reverted from DEPLOY 2026-07-28 on 1b's integration; `0013` is taken, so 1d's migration is `0014`)* |
| `packages/postgres-provider/src/module-runtime-interpreter.ts` | KERNEL |
| `test/postgres/{module-runtime,release-activation,release-approval,releases,request-runtime-view}.test.ts` | **KERNEL** *(granted 2026-07-28 for 4c — artifact-owned revision-envelope versions ONLY; the version-hardcode sweep's fourth-instance batch)* |
| `test/postgres/module-storage-transition.test.ts` | **FIX (1d) and KERNEL (4c) — split by concern, granted 2026-07-28.** FIX owns the archive-excluding unique-index assertions (migration `0014`, index predicates, drift acceptance); KERNEL owns the version-stamping paths only. Verified disjoint before granting: 1d's diff to this file contains **zero** `LANGUAGE_VERSION`/`NORMALIZATION_PROFILE_VERSION` references. Neither lane may touch the other's concern. |
| `test/postgres/**` (rest) | unassigned — bridge before touching, EXCEPT the version-derivation class below |
| **Hardcoded-v2-node derivation — CLASS GRANT to KERNEL, 2026-07-28, for 4c** | **KERNEL**, for **version derivation only**. The earlier profile-selection class grant covered compilers choosing a profile; this is the same defect one layer down — tests that *construct* canonical nodes with a literal `'v2'` or `LANGUAGE_VERSION` and insert them into a now-v3 definition, producing `CANON_VERSION_MIXED`/`CANON_SCHEMA_INVALID`. Covers every file under `test/**` and `apps/web/test/**` still doing so, including the two 4c requested (`test/postgres/{predicate-parity-corpus,query-filter-lowering}.test.ts`) and `test/postgres/predicate-absent-semantics.test.ts`, `test/integration/{module-runtime,table-behavior}.test.ts`, `test/unit/canonical-model/*`, `test/unit/location-definition.test.ts`. **Granted as a class after a red matrix** (PostgreSQL 90/94) rather than file by file, because enumerating found 23 candidates and one-at-a-time bridging would cost a stop each. **Bounded: derive the version from the artifact and change nothing else** — no assertion, expectation or behavior change. `test/compiler/g2-module-storage.test.ts` stays split with FIX per its own row. |
| `test/compiler/inventory-contract.{cases.ts,release.golden.json}` | **FIX** *(granted 2026-07-28 for `G3-P1b`)* |
| `test/compiler/g2-module-storage.test.ts` | **KERNEL (4c) and FIX (G3-P1b) — split by concern, granted 2026-07-28.** KERNEL owns version stamping (`LANGUAGE_VERSION` → `LATEST_LANGUAGE_VERSION`) only; FIX owns `legal_entity_id` emission and uniqueness-participation assertions. Verified disjoint. 4c integrates first, so FIX merges and takes main's side on version stamps. |
| `packages/postgres-provider/src/saved-filter-executor.ts` | **KERNEL** *(granted 2026-07-28 for 4c — swap the legacy-only `NormalizedApplicationPackageSchema` persisted reader at `:5,:918` for the versioned one; it rejects a valid v3 Platform definition as corrupt. Unheld; `1c-b` will later strip or rewrite this file per ADR-0023, and supersedes rather than conflicts.)* |
| `test/postgres/query-filter-lowering.test.ts` — **stats-flush extension** | **KERNEL** *(granted 2026-07-28 for 4c, BEYOND the version-derivation class: force a PostgreSQL statistics flush before reading the baseline counters. v3 verification now runs five Q1 probes ahead of the measured probe and their pending stats understate the baseline, so the observed delta reads `6n`. **The `=== 1n` assertion at `:239` MUST NOT change** — this corrects the measurement, not the bar. Relaxing the delta would be exactly the "raise a bound to make a run pass" failure the lane protocol forbids.)* |
| `packages/dev-tooling/src/**` · `test/architecture/tenant-completeness*` | BUILD *(taken 2026-07-28 by G3-P2a; recorded here retroactively — the partition table had no `dev-tooling` row at all, the second such gap found today)* |
| `packages/compiler/src/conformance.ts` | **FIX** *(granted 2026-07-28 for `G3-P1b` — the legal-entity family map and relation-entity rules extend the existing 298-line inventory contract enforcement here; previously unassigned)*. Prior note: **unassigned — bridge before touching** *(gap found 2026-07-28 by the 1c scoping pass: G3-P1a edited this file under its own lease and it now holds the inventory contract constants alongside the four-query completeness rule, so BUILD and any 1c branch both have a live claim on it. It is in no lane's column. Do not let a lane take it silently.)* |
| `docs/execution/packets/**` · `docs/execution/stage-cut-inputs.md` | FIX *(granted 2026-07-28 for G3-P0; each lane still owns its own packet doc)* |
| `packages/domain/src/{party,catalog,location,platform}/definition.ts` · `app/builder.ts` | KERNEL *(granted 2026-07-28 for 4c — **version/profile strings and the empty `impactAnalyses` root only**; no definition semantics)* |
| `packages/domain/src/inventory/**` | **FIX** *(reassigned from BUILD 2026-07-28 for `G3-P1b`; BUILD is on `G3-P2a`, which touches dev-tooling only, and its next inventory packet `G3-P2b` depends on G3-P1b anyway)* — KERNEL may still migrate its **version strings only**, split by concern, and only if it exists at 4c's integration time |
| `test/helpers/postgres.ts` | DEPLOY *(granted 2026-07-28 for 1b — readiness-race fix only; a 1f regression blocking its gate)* |
| `test/helpers/node-reporter-core.mjs` · `test/architecture/test-reachability.test.ts` | DEPLOY *(granted 2026-07-28 for 1b — admit `--test-concurrency=<positive int>` to PR-4b's closed argv grammar; filtering arguments must still be rejected)* |
| `apps/web/release/**` (generated artifacts) | FIX *(granted 2026-07-28 for 1d — regenerate stale lineage after storage roots moved; re-derived at integration, so concurrent regeneration by 4c is expected)* |
| `learnings.md` | FIX *(granted 2026-07-28 for 1d — add-only, one entry, appended at the end of file)* · **KERNEL also granted 2026-07-28 for 4c — the `Derive persisted envelope versions from canonical authority` block ONLY (currently lines 114-117), to supersede it. The two grants are provably disjoint: 1d appends past line 215, 4c edits 114-117. Neither may touch the other's region.** |
| `apps/web/scripts/compile-app-release.ts` | KERNEL *(granted 2026-07-28 for 4c — per-artifact compiler-profile selection when verifying persisted lineage)* |
| `apps/web/scripts/compile-demo-release.ts` | KERNEL *(granted 2026-07-28 for 4c — **caught by the orchestrator, not requested**: the lane was editing it under the `compile-app-release.ts` grant, which names a different file. Granted because it is a direct consequence of the orchestrator's own ruling that the demo shell stays `v0-experimental` while the app moves to v3, so the demo compile path must select its profile per artifact. No other lane holds it.)* |
| **Per-artifact compiler-profile selection — CLASS GRANT to KERNEL, 2026-07-28, for 4c** | **KERNEL**, for **profile selection only**. Covers every consumer of `DEFAULT_COMPILER_PROFILE` / `MODULE_COMPILER_PROFILE` outside `packages/compiler/src/` that compiles a fixture whose declared language version differs from the constant: `apps/web/test/browser/{surface-grammar,surface-data-binding}.spec.ts`, `test/fixtures/g2/{party,catalog,location}/compiler.ts`, `test/fixtures/g2/surface-grammar/compiled.ts`, `test/compiler/subprocess-compile.ts`, `test/architecture/surface-grammar-conformance.test.ts`. **Granted as a class after the third individual request** — the lane had already been granted `compile-app-release.ts` and `compile-demo-release.ts` for the identical defect, and enumerating showed eight more consumers, so one-at-a-time bridging would have cost a stop per file. **Verified no other lane holds any of them** (BUILD's `test/architecture` claim is limited to `tenant-completeness*` and shared `repository-hygiene`). **Strictly bounded: derive the profile from the artifact's own declared version and change nothing else** — no assertion, expectation, fixture content, or behavior change. Anything beyond profile derivation is a fresh stop-and-report. |
| `apps/web/**` (rest) · rest of `packages/domain/**` | **none — frozen while lanes run** |

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

**The one exception has ENDED.** `4a` and `4b` proved artifacts did not move and
both are accepted, so no packet now depends on artifact stillness. `4c`, `1d`
and the G3 packets may move release roots concurrently, re-deriving generated
files at integration.

The orchestrator enforced the stronger constraint until 2026-07-28 and it cost
sequencing that was never required.

## The PostgreSQL suite runs serially — found 2026-07-28 by packet 1b

`test:postgres` carried no `--test-concurrency` flag, so Node defaulted to
CPU-count concurrency across **21 files**, each spinning Docker containers. The
heaviest test (`composed product activates through the kernel`) blew its 120 s
bound under sibling load while passing in **45.2 s** alone.

**A gate whose verdict depends on machine load is not observing the fact it
asserts** — it is observing the fact plus the scheduler. The script now pins
`--test-concurrency=1`, which is what every writer had already been doing by
hand: 1f's, G3-P1a's and 1b's own test-it-yourself commands all pass it.

This class of phantom failure cost three packets real time before it was
diagnosed. **Do not raise a timeout to make a loaded run pass** — that widens
what starvation is allowed to look like instead of removing it.

## Full-matrix runs must NOT overlap — found 2026-07-28 by packet 1f

Authoring runs in parallel. **Matrix runs do not.** Packet 1f recorded two
concurrent-lane corruptions of its own gate evidence:

  - `Superseded PostgreSQL run: 89/90 after another worktree's concurrent
    matrix sent SIGTERM.`
  - `First final-candidate matrix during a later 4b lane collision: 90/92;
    release-activation.test.ts:611 reported false !== true. The isolated rerun
    was 92/92 and the serial final matrix was fully green.`

Container names are unique per process (`north-star-<label>-<pid>-<uuid>`), so
this is not a naming collision. It is CPU/IO contention, and the second failure
is the serious one: `release-activation` is **timing-sensitive**, not
readiness-sensitive, so a loaded machine produces a *wrong verdict* rather than
an obvious timeout.

**A green matrix produced while another lane's matrix was running is not
evidence.** Before running the full matrix, check that no other lane is running
one; if one is, wait. A lane may keep authoring and running focused suites
throughout — only the full matrix serializes.

This is a real cost of parallelism and it caps useful lane count: past roughly
four lanes, matrix queueing dominates and additional lanes buy nothing.

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
under `docs/`, `.agents/`, or the root narrative files `CLAUDE.md` and
`AGENTS.md`, the lane does NOT re-merge and does NOT re-run.**
The orchestrator merges those at acceptance. The tested code and the integrated
code are byte-identical, so a re-run would observe nothing new.

This exists because the orchestrator commits rulings, ledger rows and queue
updates continuously while lanes work — without this rule a lane chases doc
commits indefinitely and never reaches a stable integrated SHA. Added 2026-07-28
after exactly that happened to KERNEL twice in one packet.

**The exception is narrow and the orchestrator verifies it, not the lane.** Any
file outside those paths — product code, test, config, migration, lockfile,
generated artifact — voids it and the full merge-and-re-run applies.

**Widened 2026-07-28 to name `CLAUDE.md` and `AGENTS.md`.** The original wording
listed only `docs/` and `.agents/`, and 4c's second bridge hit the gap: `main`
had gained exactly one line in `CLAUDE.md` — a pointer to the orchestrator
handoff — which by the letter voided the exception and would have forced a full
matrix re-run to observe a documentation sentence. Those two root files are
narrative in the same class as `docs/`: not code, not test, not config, not a
generated artifact, and never executed. The exception's stated purpose is that
"the tested code and the integrated code are byte-identical", and that holds
exactly. This is the standing lesson applied to the rule itself — *every gate
built for one situation needs widening the first time a second appears* — and
widening it explicitly is the alternative to stretching it silently each time.
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
