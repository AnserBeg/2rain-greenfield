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

| Lane | Current packet | Status |
|---|---|---|
| **FIX** | `Q1-P4` — issued legal-entity read scope | **matrix-green at `29ba2ae`, both review arms PASS.** Owes a merge of main and a re-run before integration: main advanced 26 files / 3,967 insertions with `G3-P4a` and `G3-P6c`, so the docs-only exception does not apply. |
| **BUILD** | `G3-P6a` — mount inventory, read-only views | **active.** Has found five structural defects, all real: three fixture double-mounts, provisioning ordered after materialization, `abiFunctionChecks` omitted from the additive strip list, preparation filtering on kind instead of classification, and generic fixture generation ignoring compiled constraints. |
| **CANON** *(Opus)* | `Q1-P5` — the legal-entity query operand, canonical v4 | **active, added 2026-07-30.** First non-Codex writer lane. Same review chain: Codex for everything, Fable on Critical. Holding its frozen candidate while `Q1-P4` takes the slot; authoring the deferred gateway binding meanwhile. |
| **KERNEL** | — | idle since `G3-P2b-4` (2026-07-29). |
| **DEPLOY** | — | idle since `1g2` (2026-07-29). |

**Lane identity is per packet, not per theme.** The earlier model assigned
standing themes (KERNEL owns canonical, FIX owns correctness). That broke on
2026-07-30: `CANON` took canonical work while `KERNEL` sat idle, and `FIX` ran a
query-tier packet. Themes rot as the queue reorders; the packet is the real unit.


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

## Disjointness is VERIFIED, not predicted — corrected 2026-07-30

**Before granting any path, run the check. Do not consult the table below as
authority.**

```bash
for b in $(git branch --list 'packet/*' --format='%(refname:short)'); do
  printf '%s: ' "$b"; git diff --name-only main...$b | tr '\n' ' '; echo
done
```

**Why this replaced the table as the binding mechanism.** The table is a
hand-maintained *prediction* of ownership. It rots on every acceptance, and on
2026-07-30 it was stale in every row — it still listed
`packages/runtime/src/semantic-query-gateway.ts` as KERNEL's while KERNEL was
idle, `FIX` actually held it through `Q1-P4`, and the orchestrator granted it to
a third lane. Three errors in one row.

The empirical check was correct every time it was run that day, including when it
refuted a lane's own good-faith claim that a file was unheld — `G3-P4b` did hold
`repository-hygiene.test.ts`.

**The table below is now a LOG OF GRANTED CLAIMS AND THEIR REASONS, not a
forecast.** Its reasoning is worth keeping; its ownership column is not
authoritative. When a grant is made, append the reason; never trust a row older
than the packet it names.

## BRIDGES ARE THE NORMAL CASE, not the exception — recorded 2026-07-30

Roughly ten lane stops occurred on 2026-07-30 and **every one was correct**.
Nearly all were "I need a path you did not grant." Three were caused by
orchestrator prompts omitting paths the work obviously needed —
`packages/domain/src/app/builder.ts`, `docs/decisions/**`, and a gateway granted
twice.

Owned paths **cannot be fully predicted** before a packet discovers what it
needs. So every packet prompt should say plainly: *this lease is incomplete by
construction; stop and ask when you need more.* A lane that stops is doing the
protocol correctly, not failing it.

## Keep active lanes at THREE or fewer — recorded 2026-07-30

The full matrix is serial, so lane count beyond about three buys queue depth
rather than throughput. Four-plus lanes on 2026-07-30 all waited on one gate
while adding rebase cost.

**Avoid stacking branches.** `G3-P4b` and `G3-P6a` were both branched from
`packet/g3-p4` rather than main; both needed rebasing when it merged. Branch from
main and accept a later merge, or serialize.

## Path partition — historical claims log

Recorded grants and their reasons. **Not authoritative for current ownership** —
run the empirical check above. `packages/compiler/src/` in particular is **split**, because F7 and
the query tier both live there.

| Path | Lane |
|---|---|
| `packages/canonical-model/src/**` | KERNEL |
| `packages/compiler/src/predicate-lowering.ts` | KERNEL |
| `test/compiler/{predicate-lowering,g2-module-conformance}.test.ts` | **KERNEL** *(granted 2026-07-29 for `Q1-P3b` — observe the extended lowering table and emitted aggregate plan. Verified FIX touches neither.)* |
| `packages/compiler/src/compiler.ts` | **KERNEL (4c) and FIX (G3-P1b) — split by concern, granted 2026-07-28.** KERNEL owns language/profile dispatch **and (granted 2026-07-29 for `Q1-P3b`) the v3 aggregate catalog decoration**; FIX owns **storage-target payload v1/v2 family recognition only**. Re-verified 2026-07-29 against FIX's frozen `0b84594`: its only hunks are line 56 (an import) and 1803-1816 (`parseStorageTarget`), disjoint from the aggregate-catalog region. Verified disjoint before granting: 4c's hunks sit at ~1-11, 73-109, 789-836 and 990-1022, and 4c touches `STORAGE_TARGET_PAYLOAD_VERSION` **zero** times. 4c integrates first, so FIX merges and takes main's side on dispatch. *(Supersedes the 4a-era note "FIX is on a test-only packet" — no longer true.)* |
| `packages/runtime/src/semantic-query-gateway.ts` | KERNEL |
| `packages/compiler/src/storage.ts` | **FIX** |
| `packages/compiler/src/projections.ts` | **FIX** |
| `packages/compiler/src/protocol.ts` | **FIX** *(granted 2026-07-28 for `G3-P1b` — declare `northstar.storage-target-payload/v2` only. This is a ratified **Freeze F** artifact, but [ADR-0015](../decisions/ADR-0015-legal-entity-business-dimension.md):79 and :116 explicitly authorize this bump "under that ADR's own evolution rule" and name it as an accepted cost, so it is anticipated evolution rather than a freeze violation. Tenant-shared targets stay v1 and byte-identical.)* |
| `packages/compiler/src/protocol.ts` — **family export** · `packages/compiler/src/index.ts` | **KERNEL** *(granted 2026-07-29 for `G3-P2b-4` — export `SUPPORTED_STORAGE_TARGET_PAYLOAD_VERSIONS` and re-export it, NOTHING ELSE. Split by concern with FIX, which owns the individual version constants in the same file for `G3-P2b-1`. `index.ts` is untouched by FIX. The family must be **one compiler-owned authority**; a local interpreter array would be the version-hardcode defect's sixth instance.)* |
| `packages/postgres-provider/src/module-storage-materializer.ts` | FIX |
| `apps/api/**` | DEPLOY |
| `packages/postgres-provider/src/composed-application-runtime.ts` | **DEPLOY** *(returned 2026-07-29 on 4c's acceptance — the KERNEL grant was for 4c only, and Q1-P3b does not need it. For `1g2`.)* |
| `packages/postgres-provider/src/release-*.ts` | **DEPLOY** *(returned 2026-07-29 on 4c's acceptance. For `1g2`.)* |
| `packages/compiler/src/verification.ts` | DEPLOY *(assigned 2026-07-28 for packet 1b)* |
| `db/schema.snapshot.json` | DEPLOY *(granted 2026-07-28 for 1b — migration 0013 moves it)* |
| `test/architecture/release-persistence-boundary.test.ts` | DEPLOY *(granted for 1b — hardcodes the migration inventory through 0012)* |
| `test/fixtures/g2/*/runtime-harness.ts` | **KERNEL** *(released from DEPLOY 2026-07-28 on 1b's integration, for 4c's version-stamp fix)* |
| `db/migrations/**` · `packages/postgres-provider/src/migrations.ts` | **FIX** *(reverted from DEPLOY 2026-07-28 on 1b's integration; `0013` is taken, so 1d's migration is `0014`)* |
| `packages/postgres-provider/src/module-runtime-interpreter.ts` | KERNEL |
| `test/postgres/{module-runtime,release-activation,release-approval,releases,request-runtime-view}.test.ts` | **KERNEL** *(granted 2026-07-28 for 4c — artifact-owned revision-envelope versions ONLY; the version-hardcode sweep's fourth-instance batch)* |
| `test/postgres/module-storage-transition.test.ts` | **FIX (1d) and KERNEL (4c) — split by concern, granted 2026-07-28.** FIX owns the archive-excluding unique-index assertions (migration `0014`, index predicates, drift acceptance); KERNEL owns the version-stamping paths only. Verified disjoint before granting: 1d's diff to this file contains **zero** `LANGUAGE_VERSION`/`NORMALIZATION_PROFILE_VERSION` references. Neither lane may touch the other's concern. |
| `packages/postgres-provider/src/stock-serializer*.ts` · `test/postgres/stock-serializer*.test.ts` | **BUILD** *(granted 2026-07-29 for `G3-P2b-2` — new files only, pre-authorized so the packet does not stop on a foreseeable lease. FIX's `G3-P2b-1` adds different `test/postgres` files; neither lane touches the other's.)* |
| `test/postgres/**` (rest) | unassigned — bridge before touching, EXCEPT the version-derivation class below |
| **Hardcoded-v2-node derivation — CLASS GRANT to KERNEL, 2026-07-28, for 4c** | **KERNEL**, for **version derivation only**. The earlier profile-selection class grant covered compilers choosing a profile; this is the same defect one layer down — tests that *construct* canonical nodes with a literal `'v2'` or `LANGUAGE_VERSION` and insert them into a now-v3 definition, producing `CANON_VERSION_MIXED`/`CANON_SCHEMA_INVALID`. Covers every file under `test/**` and `apps/web/test/**` still doing so, including the two 4c requested (`test/postgres/{predicate-parity-corpus,query-filter-lowering}.test.ts`) and `test/postgres/predicate-absent-semantics.test.ts`, `test/integration/{module-runtime,table-behavior}.test.ts`, `test/unit/canonical-model/*`, `test/unit/location-definition.test.ts`. **Granted as a class after a red matrix** (PostgreSQL 90/94) rather than file by file, because enumerating found 23 candidates and one-at-a-time bridging would cost a stop each. **Bounded: derive the version from the artifact and change nothing else** — no assertion, expectation or behavior change. `test/compiler/g2-module-storage.test.ts` stays split with FIX per its own row. |
| `test/compiler/inventory-contract.{cases.ts,release.golden.json}` | **FIX** *(granted 2026-07-28 for `G3-P1b`)* |
| `test/compiler/g2-module-storage.test.ts` | **KERNEL (4c) and FIX (G3-P1b) — split by concern, granted 2026-07-28.** KERNEL owns version stamping (`LANGUAGE_VERSION` → `LATEST_LANGUAGE_VERSION`) only; FIX owns `legal_entity_id` emission and uniqueness-participation assertions. Verified disjoint. 4c integrates first, so FIX merges and takes main's side on version stamps. |
| `packages/postgres-provider/src/saved-filter-executor.ts` | **KERNEL** *(granted 2026-07-28 for 4c — swap the legacy-only `NormalizedApplicationPackageSchema` persisted reader at `:5,:918` for the versioned one; it rejects a valid v3 Platform definition as corrupt. Unheld; `1c-b` will later strip or rewrite this file per ADR-0023, and supersedes rather than conflicts.)* |
| `test/postgres/query-filter-lowering.test.ts` — **stats-flush extension** | **KERNEL** *(granted 2026-07-28 for 4c, BEYOND the version-derivation class: force a PostgreSQL statistics flush before reading the baseline counters. v3 verification now runs five Q1 probes ahead of the measured probe and their pending stats understate the baseline, so the observed delta reads `6n`. **The `=== 1n` assertion at `:239` MUST NOT change** — this corrects the measurement, not the bar. Relaxing the delta would be exactly the "raise a bound to make a run pass" failure the lane protocol forbids.)* |
| `test/architecture/tenant-completeness.test.ts` | **FIX** *(granted 2026-07-29 for `G3-P2b-1` — the hardcoded expected counts at `:33-35` and `:344` ONLY. BUILD is idle since G3-P2a's acceptance. The exact-count assertion is a deliberate ratchet: it must be UPDATED to the true new values, never relaxed to a range or removed.)* |
| `test/architecture/surface-grammar-conformance.{test,baseline}.ts` | **FIX (G3-P2b-1) — KERNEL's half is spent, 2026-07-29.** KERNEL's `G2-P5d-b` integrated first and took only the **violationCount values of the four existing entries**; the baseline on `main` now reads **catalog 13, location 13, party 23, platform 33** and `.test.ts` was never touched. FIX owns **adding the new inventory entry and bumping the module count 4 to 5** — and nothing else. **FIX must NOT reset the four counts to their old values when it merges `main`**; take main's side on every existing entry and add only its own. FIX's inventory count must be **measured by compiling inventory, never guessed**. |
| `test/architecture/module-press-law.test.ts` | **FIX** *(granted 2026-07-29 for `G3-P2b-3` — the recorded LINE NUMBER of the existing inventory debt entry only, 1317 → 1441. Verified before granting: line 1441 is the same `'northstar.inventory:capability.posting'` literal, the violation count is unchanged at 3, and the count of inventory-namespace literals in `conformance.ts` is **8 on both main and the branch** — the debt did not grow. The two-way ratchet fired correctly; only the observation's location moved.)* |
| `packages/dev-tooling/src/module-press-law.ts` | **FIX** *(granted 2026-07-29 for `G3-P2b-1` — NAMESPACE-BOUNDARY DEFINITION ONLY. BUILD is on serializer files and does not touch dev-tooling. The ratchet at `module-press-law.test.ts:14-33` must still deep-equal exactly the two routed saved-filter entries; a third violation is a finding to report, never an entry to add.)* |
| `test/postgres/trust-substrate.test.ts` · `test/architecture/release-persistence-boundary.test.ts` | **FIX** *(granted 2026-07-29 for `G3-P2b-1` — the migration `0015` inventory entries ONLY; both hardcode the migration list. DEPLOY is idle and its `1b` claim on the latter is spent.)* |
| `packages/dev-tooling/src/**` · rest of `test/architecture/tenant-completeness*` | BUILD *(taken 2026-07-28 by G3-P2a; recorded here retroactively — the partition table had no `dev-tooling` row at all, the second such gap found today)* |
| `packages/compiler/src/conformance.ts` | **FIX** *(granted 2026-07-28 for `G3-P1b` — the legal-entity family map and relation-entity rules extend the existing 298-line inventory contract enforcement here; previously unassigned)*. Prior note: **unassigned — bridge before touching** *(gap found 2026-07-28 by the 1c scoping pass: G3-P1a edited this file under its own lease and it now holds the inventory contract constants alongside the four-query completeness rule, so BUILD and any 1c branch both have a live claim on it. It is in no lane's column. Do not let a lane take it silently.)* |
| `docs/execution/packets/**` · `docs/execution/stage-cut-inputs.md` | FIX *(granted 2026-07-28 for G3-P0; each lane still owns its own packet doc)* |
| `packages/domain/src/app/builder.ts` | **held by BUILD for `G3-P6a`, granted 2026-07-30**, scoped to mounting `inventoryModuleDefinition(APPLICATION_NAMESPACE)` and the composition metadata/ids that mounting requires — nothing else in the file. The lane's stop was correct and the omission was the orchestrator's: `builder.ts:32-34` mounts party, catalog and location, so there is nowhere else inventory can be mounted, and implementing composition only in `generate-app-authored.ts` would create a second desired-state authority. Verified free before granting: the row below records it as **released** on `G2-P5d-b`'s acceptance. |
| `packages/domain/src/{party,catalog,location,platform}/definition.ts` · `app/builder.ts` | **released 2026-07-29 on `G2-P5d-b`'s acceptance.** Held by KERNEL for 4c (version/profile strings and the empty `impactAnalyses` root only) and then, for `G2-P5d-b`, for **surface-slot declarations** — `bulkActions` on List, `sections` on Record detail, `keyFacts` on Record form, in `entitySurfaces()` on party/catalog/location. That second use was **definition semantics, which the 4c grant explicitly excluded**, and it too was never written into this table. Platform was deliberately left alone: its anatomy belongs to row `1c-b`. |
| `packages/domain/src/inventory/**` | **FIX** *(reassigned from BUILD 2026-07-28 for `G3-P1b`; BUILD is on `G3-P2a`, which touches dev-tooling only, and its next inventory packet `G3-P2b` depends on G3-P1b anyway)* — KERNEL may still migrate its **version strings only**, split by concern, and only if it exists at 4c's integration time |
| `test/helpers/postgres.ts` | DEPLOY *(granted 2026-07-28 for 1b — readiness-race fix only; a 1f regression blocking its gate)* |
| `test/helpers/node-reporter-core.mjs` · `test/architecture/test-reachability.test.ts` | DEPLOY *(granted 2026-07-28 for 1b — admit `--test-concurrency=<positive int>` to PR-4b's closed argv grammar; filtering arguments must still be rejected)* |
| `apps/web/release/**` (generated artifacts) | FIX *(granted 2026-07-28 for 1d — regenerate stale lineage after storage roots moved; re-derived at integration, so concurrent regeneration by 4c is expected)* |
| `learnings.md` | FIX *(granted 2026-07-28 for 1d — add-only, one entry, appended at the end of file)* · **KERNEL also granted 2026-07-28 for 4c — the `Derive persisted envelope versions from canonical authority` block ONLY (currently lines 114-117), to supersede it. The two grants are provably disjoint: 1d appends past line 215, 4c edits 114-117. Neither may touch the other's region.** |
| `apps/web/scripts/compile-app-release.ts` | **DEPLOY** *(returned 2026-07-29 on 4c's acceptance; 4c's per-artifact profile selection is now on main. For `1g2`.)* |
| `apps/web/scripts/compile-demo-release.ts` | KERNEL *(granted 2026-07-28 for 4c — **caught by the orchestrator, not requested**: the lane was editing it under the `compile-app-release.ts` grant, which names a different file. Granted because it is a direct consequence of the orchestrator's own ruling that the demo shell stays `v0-experimental` while the app moves to v3, so the demo compile path must select its profile per artifact. No other lane holds it.)* |
| **Per-artifact compiler-profile selection — CLASS GRANT to KERNEL, 2026-07-28, for 4c** | **KERNEL**, for **profile selection only**. Covers every consumer of `DEFAULT_COMPILER_PROFILE` / `MODULE_COMPILER_PROFILE` outside `packages/compiler/src/` that compiles a fixture whose declared language version differs from the constant: `apps/web/test/browser/{surface-grammar,surface-data-binding}.spec.ts`, `test/fixtures/g2/{party,catalog,location}/compiler.ts`, `test/fixtures/g2/surface-grammar/compiled.ts`, `test/compiler/subprocess-compile.ts`, `test/architecture/surface-grammar-conformance.test.ts`. **Granted as a class after the third individual request** — the lane had already been granted `compile-app-release.ts` and `compile-demo-release.ts` for the identical defect, and enumerating showed eight more consumers, so one-at-a-time bridging would have cost a stop per file. **Verified no other lane holds any of them** (BUILD's `test/architecture` claim is limited to `tenant-completeness*` and shared `repository-hygiene`). **Strictly bounded: derive the profile from the artifact's own declared version and change nothing else** — no assertion, expectation, fixture content, or behavior change. Anything beyond profile derivation is a fresh stop-and-report. |
| `apps/web/src/{component-registry,surface-runtime}.ts` · `apps/web/scripts/generate-app-authored.ts` · `apps/web/release/**` · `apps/web/test/browser/{composed-application,surface-grammar}.spec.ts` | **released 2026-07-29 on `G2-P5d-b`'s acceptance.** KERNEL held these for the surface-anatomy burn-down and they are now free. **Recorded retroactively — the partition table never carried them while the packet ran, the THIRD such gap** (after `dev-tooling` and `conformance.ts`). The lease was real and uncontested — no other lane touches `apps/web` — but an uncontested lease that exists only in a prompt is invisible to the next lane that wants the path. When a packet's whole subject is a path the table calls frozen, add the row when the prompt is written, not at acceptance. |
| `apps/web/**` (rest) · rest of `packages/domain/**` | **none — frozen while lanes run** |

A lane needing a path outside its column files a **bridge request naming its
lane**. The orchestrator either grants it (if no other lane holds it) or
serializes the two packets.

## Orchestrator-only — no lane may touch these

  docs/execution/ledger.md
  docs/execution/current-plan.md
  docs/execution/lanes.md
  docs/decisions/**        (except a packet's own new ADR file)
  docs/greenfield-north-star-erp-platform-plan.md
  .agents/skills/ux-grammar/SKILL.md

These are the highest-conflict files in the repository and they are all
narrative. Removing them from every lease removes most merge risk outright.

**The plan and `ux-grammar` were added 2026-07-31**, on the reasoning this list
already states: both are narrative, both are program-level authority, and both
were in no partition row at all. Six queued UX rows each proposed amending plan
§8.5-8.6 *and* the skill, which would have been six lanes editing two
high-conflict narrative files.

**They carry a complication the other entries do not, and a lane must know it.**
`checkUxGrammarPin` binds the skill and the plan together with four source files
— `apps/web/src/app-server.ts`, `component-registry.ts`, `surface-contract.ts`,
`surface-runtime.ts` — plus `packages/canonical-model/src/constants.ts`
(`test/architecture/ux-grammar-skill.test.ts`). A vocabulary change therefore
cannot be made from either side alone: the skill is orchestrator-owned, the code
is lane-owned, and `UX003_VOCABULARY_DRIFT` fails if they disagree.

So the rule is **the orchestrator owns the vocabulary, and a lane never
introduces new vocabulary.** A lane that needs a term the grammar does not have
issues a **stop-and-bridge-request** — the standing procedure for an out-of-lease
need — and the orchestrator lands the vocabulary first. A lane may still make
changes that keep the pinned set consistent without inventing terms.

## Shared files — add-only, re-derive on conflict

Any lane may need these. They are **add-only** and a conflict in them is never
resolved by hand-merging:

  test/architecture/repository-hygiene.test.ts   (test inventory)
  test/architecture/test-reachability.test.ts    (script recognition)
  test/architecture/release-persistence-boundary.test.ts  (migration inventory)
  pnpm-lock.yaml                                  (generated)
  package.json (root)                             (scripts)
  .github/workflows/ci.yml                        (steps)

**Added 2026-07-30: the migration inventory.** Three packets needed it in one day —
`G3-P4a` for 0016, `G3-P4b` for 0017, `G3-P7a` for 0019 — and the third stopped on it
as an owned-path collision. It is an exact `assert.deepEqual` over migration
filenames, so every migration-adding packet must register in it. That makes it
add-only shared, not a lease.

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
one; if one is, wait.

### The "only the full matrix serializes" carve-out was too generous — corrected 2026-07-30

This section used to end: *"A lane may keep authoring and running focused suites
throughout — only the full matrix serializes."* **That is wrong, and the
orchestrator fell through the loophole three times in one evening.**

  - Started the running app during a matrix → a 120 s `testTimeoutFailure`. The
    same SHA passed clean and quiet.
  - Committed to a worktree and merged `main` into it **while that worktree's
    own matrix was executing**, so the run was testing a tree that moved under
    it.
  - Launched a **read-only Fable review** — no builds, no Docker, just reads and
    greps — during a matrix, and
    `test/compiler/performance-budget.test.ts` failed at **17,672 ms against a
    5,000 ms budget**. That test is a wall-clock `process.hrtime` assertion over
    a synthetic maximum-field fixture, so it measures the machine, not the
    product.

**The corrected rule: while a full matrix is running, nothing else runs.** Not a
review, not an authoring lane, not the app, not a focused suite, and no git
operation in the worktree under test. A reviewer process is not "just reading" —
it is a model doing sustained tool calls on a WSL VM capped at 8 GB and 8
processors, and it competes for exactly the resource the timing gates measure.

**"Nothing else" INCLUDES THE ORCHESTRATOR'S OWN TOOL CALLS.** This was written
once exempting the orchestrator by omission, and the omission immediately cost
two wasted matrix runs. Measured at the same SHA on the same machine:

| Run | What the orchestrator was doing | Unit suite (46 tests) | Budget test |
|---|---|---|---|
| 1 | blocked on a watcher, idle | 2,991 ms | **ok**, 4,333 ms |
| 2 | launched a review, edited docs, committed | 13,246 ms | fail, 17,672 ms |
| 3 | read files, edited, committed, grepped | (same order) | fail, 17,073 ms |
| isolated, idle | nothing | 2,714 ms | **ok**, 3,025 ms |

**A 4.4× systemic slowdown across an entire unrelated suite**, tracking nothing
but orchestrator activity. `ps` confirms why: the agent runtime sits at ~12 %
CPU sustained while working, on 8 processors, alongside its own tool
subprocesses.

The trap is that the failure looks like a code regression at the integrated
SHA — a compile budget blown by 3.5× is exactly what a genuine performance
regression looks like, and the tempting "fix" is to raise the budget. It took
three runs and two wrong diagnoses (first "load from a concurrent reviewer",
then "the machine is degrading") before measuring the test in isolation, where
it passed in 3,025 ms against a 5,000 ms budget.

**So: start the matrix, then stop. Do not read, grep, edit, commit, or launch
anything until it returns.** Block on the verdict and do nothing else. If work
must happen during a matrix, the matrix is not ready to run yet.

**Why this matters more than it looks:** a loaded run does not fail honestly. It
produces a *wrong verdict* — either a red on a timing-sensitive gate that would
pass quiet, or the far worse case of an environmental red that gets mistaken for
a product defect and "fixed". The standing prohibition on raising a bound to
make a loaded run pass exists precisely because that is the tempting move here.
**Re-run quiet; never widen the budget.**

**A killed matrix does not clean up after itself.** Killing one left an orphaned
`north-star-*` ephemeral container, which then prevented the *next* run's
ephemeral PostgreSQL from becoming ready within 30 s — an environmental red that
looked nothing like its cause. After killing a matrix, check `docker ps` and
remove orphaned `north-star-*` containers before the next run. Never touch the
user's `2rain-*` containers.

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
  4. Every other lane then **merges current `main` into its branch**. Whether
     that integrated SHA needs its own matrix run is decided by whether the
     tree's **executable content** moved, not by the SHA changing — use the
     `git diff --name-only … ':!docs' ':!.agents'` check in `git-workflow`,
     which is authoritative here. Never rebase `main`, never reset it, never
     squash away the reviewed candidate.

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

    LANE: <FIX|BUILD|CANON|KERNEL|DEPLOY> · PACKET: <id> · SHA: <frozen sha> · BASE: <base sha>

Bridge requests open with the same line. The orchestrator adjudicates several
streams; an unlabelled SHA is the single easiest way to mis-grant a lease.

## What does not change

Everything in `AGENTS.md`, `mission-cadence`, and `review-tiers` applies
unchanged per lane: one frozen candidate, honest gates at the integrated SHA,
negative controls with recorded reds, the two-REVISE cap, fresh naive reviewers,
and no self-certification. Parallelism buys throughput, not a lower bar.
