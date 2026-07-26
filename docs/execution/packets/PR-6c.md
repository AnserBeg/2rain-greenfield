# PR-6c — Materializer data-affecting DDL on existing tables

Status: evidence_ready — full matrix green at the frozen candidate reported in the writer handoff
Tier: Critical
Branch: `packet/pr-6c`
Requested base: `085a041bff2f62428c6f03da411e9ba071a24eef`
Frozen candidate: reported in the writer handoff (a commit cannot contain its own SHA)

## Outcome and scope

PR-6c closes the execution hole left deliberately by PR-6 and PR-6b. A storage
transition element classified `deferredOnlineFamily` is now executed during an
approved attempt instead of being declared and then dropped. The path remains
inside the materializer's existing transaction ownership and uses ordinary
locking PostgreSQL DDL:

- a missing existing-table index uses `CREATE INDEX`;
- a missing stored fold uses `ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS
  AS (...) STORED`;
- preparation permits only those declared deferred targets to remain absent,
  while still rejecting a present object with the wrong shape; and
- the attempt result reports the number of deferred-family elements it
  processed. A fresh-table plan observes and prints zero rather than passing
  without reading the family.

This packet does not add `CREATE INDEX CONCURRENTLY`, a non-transactional
runner, or an online generated-column rewrite. It also does not change compiler
output. No `.golden.bytes` or `.golden.sha256` file changed, and the demo release
root remains a hard stop if a later gate reports otherwise.

Migration `0011_module_fold_function_ddl_witness.sql` adds a superuser-owned
`ddl_command_end` event trigger. The trigger records the first exact definition
of `north_star_module.nsm_unicode_case_fold_v1(value text)` and rejects a later
`CREATE OR REPLACE FUNCTION` whose `pg_get_functiondef` differs. The runtime and
materializer roles do not own the trigger or its evidence table. The schema
snapshot format advances to v4 and captures event triggers whose trigger
function belongs to a captured schema; dropping this witness is therefore
schema drift rather than an unwitnessed guard removal.

## Established baseline

The branch was cut from the requested `085a041` base and was clean before the
first edit. This baseline was re-run rather than copied from the prior packet.
The observed matrix was:

| Gate | Baseline observation |
|---|---:|
| `format`, `lint`, `typecheck`, `build`, `check:demo-release` | green |
| `check:boundaries` | 102 files |
| `check:schema` | 10 applied / 10 verified |
| `test:unit` | 36 / 36 |
| `test:compiler` | 52 / 52 |
| `test:integration` | 55 / 55 |
| `test:agent` | 3 / 3 |
| `test:architecture` | 52 / 52 |
| `test:contracts` | 6 / 6 |
| `test:postgres`, first attempt | **68 / 70; red** |
| `test:postgres`, immediate unfiltered retry | 70 / 70 |
| `test:locale` | 1 / 1 |
| `test:browser` | 7 / 7 |
| observability suite | 5 / 5 |
| `check:reachability` | 60 / 60 across 9 executed-file artifacts |

The PostgreSQL first attempt is intentionally not hidden by the retry. The two
failures were:

1. `persisted change-document ordering is byte-identical under a non-C locale`;
2. `Party executes the compiled declared-semantics contract on real PostgreSQL`
   (`expected 2`, `actual 3`).

The immediate complete retry passed 70/70. PR-6c does not diagnose either
intermittent; both names are retained here for flake tracking.

## Declared shape and atomic step evidence

The live catalog verifier now includes both `pg_index.indisready` and
`pg_index.indisvalid` in the declared index shape. Presence alone is not
success. The existing-table relation journey materializes a coherent legacy
release without its relation index, compiles the same definition against that
release, observes one `deferredOnlineFamily` `createIndex`, prepares with the
index still absent, and executes the approved attempt. It then reads the real
catalog and requires `{indisready: true, indisvalid: true}`.

Every locking-DDL step writes `STARTED`, executes the DDL, and writes `APPLIED`
in one transaction. Two independent rollback controls exercise both possible
one-sided false greens:

- changing the managed table owner makes the DDL fail with SQLSTATE `42501`
  after the `STARTED` insert; after rollback both the application rows and the
  index are absent; and
- a temporary check constraint rejects the `APPLIED` receipt with SQLSTATE
  `23514` after index construction; after rollback both the application rows
  and the index are absent.

The successful retry commits the index with exactly the `STARTED` and `APPLIED`
rows. Backfill checkpointing is unchanged; this atomicity rule concerns the DDL
step receipt that records a transactional catalog mutation.

## Negative controls and recorded reds

Each control below makes the asserted production check reject the deliberately
bad state. The surrounding test catches that expected rejection and then
observes the persisted state, so a successful test means the inner production
check went red for the named reason.

| Vacuity vector | Deliberately introduced red | Persisted observation |
|---|---|---|
| Deferred classification is dropped | Legacy relation index is absent at preparation, then one deferred element is executed. | Exact index appears in `pg_index`; attempt reports `1`; two step receipts commit. |
| Index exists but is invalid | Set the created index's `indisvalid` to false directly in `pg_index`. | `verifyLiveCatalog` rejects with `CATALOG_DRIFT` and names the altered managed index. |
| Receipt survives failed DDL | Force `CREATE INDEX` to fail with `42501` after `STARTED`. | Zero step rows and no index after rollback. |
| DDL survives failed receipt | Reject `APPLIED` with `23514` after DDL. | Zero step rows and no index after rollback. |
| Claim error masks fold drift | Plant a terminal `COMPLETED` claim, drift the fold body, then execute. | `CASE_FOLD_FUNCTION_DEFINITION_MISMATCH` surfaces; the terminal claim remains unchanged. |
| Out-of-band replacement is accepted | Attempt `CREATE OR REPLACE FUNCTION` with a different body while the witness is enabled. | SQLSTATE `55000`; the complete function catalog state remains unchanged. |
| Event-trigger guard is silently removed | Drop `module_fold_function_ddl_witness` after a clean snapshot comparison. | `assertSchemaMatchesSnapshot` rejects with `SchemaDriftError`. |
| Deferred-family check reads no subject | Execute a fresh-table attempt containing no deferred elements. | Result reports `0` and prints `PR-6c deferredOnlineFamily elements processed: 0 (fresh-table plan)`. |

The diagnostic-order change is error specificity and negative-control coverage,
not a false-green fix. Both the old and new order reject materialization; the
new order reports the specific immutable-fold mismatch before terminal claim
DML can replace it with `ATTEMPT_CLAIM_MISMATCH`.

## Blocking-window measurement and promotion trigger

The measurement uses the actual compiled module table and generated-fold DDL.
It seeds rows, observes the materializer queued for `AccessExclusiveLock`,
queues a real writer behind the DDL, releases the initial lock holder, and uses
the monotonic `performance.now()` source until the writer commits.

```sh
node --import tsx --test --test-name-pattern='pre-existing generated fold' \
  test/postgres/module-storage-transition.test.ts

PR6C_MEASUREMENT_ROWS=25000 \
  node --import tsx --test --test-name-pattern='pre-existing generated fold' \
  test/postgres/module-storage-transition.test.ts
```

Recorded focused results on the repository's pinned PostgreSQL 16.14 image:

```text
PR-6c locking DDL measurement rows=10000 writer_block_ms=1317.647
PR-6c locking DDL measurement rows=25000 writer_block_ms=3502.750
```

The numeric promotion trigger is **2,000 ms of rehearsed writer blocking on the
largest representative existing table**. At or above that value an online
strategy is required before an in-place upgrade can be approved without an
explicit maintenance window. The 25,000-row run crosses the threshold; that is
a finding, not a reason to silently add `CONCURRENTLY`. The current path is not
claimed to be online at that size.

An attempted 100,000-row run was red before it could measure a window:
PostgreSQL returned SQLSTATE `53100` (`could not extend file`) because
`withEphemeralPostgres` caps the disposable data directory at 256 MiB. No
100,000-row latency is inferred from that harness-capacity failure.

## Snapshot and migration admission

The checked-in snapshot was regenerated with the repository tooling after all
11 migrations applied and verified. Its reviewed diff contains only migration
0011's witness relation, constraint, index, privileges, event-trigger function,
event trigger, and the snapshot-version advance. No unrelated entry moved.

The architecture inventory retains an exact migration-name assertion and now
admits `0011_module_fold_function_ddl_witness.sql`. The Catalog, Location, and
Party fixture harnesses compare applied and verified counts with
`loaded.length`; the exact inventory still pins which files constitute that
set, while future migrations no longer require three incidental literal-count
edits.

## Retained development reds

- The first migration load rejected PL/pgSQL line-leading `BEGIN`/`END` as
  runner-owned transaction control. Migration 0011 now follows the existing
  migration style that keeps PL/pgSQL block terminators off line starts; the
  runner remains the sole transaction owner.
- The first one-off snapshot generator used top-level await under CommonJS and
  failed before touching the snapshot. Wrapping its entrypoint allowed the
  tooling to generate the file.
- The 100,000-row rehearsal failed with SQLSTATE `53100` under the 256 MiB
  disposable data-directory cap, as recorded above.
- The baseline PostgreSQL first-attempt failures and immediate retry are
  recorded in the baseline section rather than collapsed into green.

## Known limits and what the gates cannot prove

- These measurements are one-host observations, not p50/p95/p99 or a fleet
  error budget. Different row widths, indexes, storage, and hardware require a
  representative rehearsal.
- The locking path is transactional and recoverable, not online. It does not
  make a 25,000-row rewrite acceptable without a window; that sample crossed
  the promotion trigger.
- A 256 MiB disposable container cannot characterize the 100,000-row case.
- PostgreSQL superusers remain able to disable or alter database guards. The
  snapshot detects a dropped/disabled/repointed event trigger at the next
  schema check, but no in-database mechanism can defend against a malicious
  superuser who tampers with both the guard and its evidence and then restores
  the captured shape.
- The event trigger closes the scoped `CREATE OR REPLACE FUNCTION` interval.
  Other superuser DDL tags and host-level tampering are outside this packet.
- Snapshot conformance proves catalog shape, not that production continuously
  ran `check:schema` between two arbitrary operator actions.

## Gate evidence

The complete matrix passed on the final working tree and was repeated after
this document was committed. The writer handoff records that exact candidate
SHA. The frozen-SHA repetition used a fresh reachability run and PostgreSQL
passed on its first attempt.

| Gate | Frozen-candidate result |
|---|---:|
| frozen install, `format`, `lint`, `typecheck`, `build` | green |
| `check:boundaries` | 103 files |
| `check:schema` | 11 applied / 11 verified |
| `check:demo-release` | green; canonical release root unchanged |
| `test:unit` | 36 / 36 |
| `test:compiler` | 52 / 52 |
| `test:integration` | 55 / 55 |
| `test:agent` | 3 / 3 |
| `test:architecture` | 52 / 52 |
| `test:contracts` | 6 / 6 |
| `test:postgres` | 72 / 72, first attempt |
| `test:locale` | 1 / 1 |
| `test:browser` | 7 / 7 |
| observability producer | 5 / 5 |
| `check:reachability` | 60 / 60 files; 9 / 9 producer artifacts |
| dependency and secret scans | green, including the real negative fixture |

Executed-file evidence names all 14 PostgreSQL files, including the changed
`migrations.test.ts`, `module-runtime.test.ts`,
`module-storage-transition.test.ts`, and `trust-substrate.test.ts`. The focused
transition file was also 12/12, and its normal 10,000-row run printed an
observed blocking window. No gate required a retry in this pre-freeze run.

## Test it yourself (under ten minutes)

From `/home/rvham/2rain-greenfield` on the frozen candidate:

```sh
pnpm typecheck
pnpm check:schema
node --import tsx --test --test-name-pattern='fold-function drift surfaces|pre-existing relation index' \
  test/postgres/module-storage-transition.test.ts
node --import tsx --test test/postgres/migrations.test.ts
node --import tsx --test --test-name-pattern='pre-existing generated fold' \
  test/postgres/module-storage-transition.test.ts
```

You should see type checking green, 11 migrations verified, the diagnostic and
relation controls pass, the migration suite reject its deliberately dropped
event trigger internally, and a final line like:

```text
PR-6c locking DDL measurement rows=10000 writer_block_ms=<measured value>
```

The exact time varies; the test must observe a real queued writer and the
generated values must cover all 10,000 rows with zero mismatches.
