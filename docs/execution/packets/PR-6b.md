# PR-6b — Folded-column index mechanics

Status: active — round-1 findings fixed; replacement matrix and Critical review pending
Tier: Critical
Branch: `packet/pr-6b`
Requested base: `28aaf3c`; actual accepted branch point: `3d394a536668519f1eb978065d63f38eee10674e`
Frozen reviewed candidate: pending
Review: pending

## Authority and outcome

PR-6b implements the closed R1-R3 decisions in
[`pr6-rls-index-access-verdict.md`](../debates/pr6-rls-index-access-verdict.md).
For every searchable, case-insensitive-unique, or declared resolve-match text
field, the compiler emits one deterministic companion column:

```text
text COLLATE "C"
GENERATED ALWAYS AS (north_star_module.nsm_unicode_case_fold_v1(source)) STORED
```

Non-unique folded access uses a btree over
`(tenant_id, environment_id, folded_column)`. The two pre-existing physical
unique-index classes now use the same stored column. Resolve and unique
predicates compare the stored column with `fold($1)`. Prefix search computes the
exclusive successor of the already-folded input and emits explicit C-collated
`>= lower AND < upper` range qualifications. Unanchored substring search reads
the stored fold but deliberately remains a tenant-partition scan, as verdict R4
requires.

The requested base `28aaf3c` remained an ancestor, but accepted `main` and
`origin/main` were both `3d394a5` when work began. The sole intervening commit
only reordered the active documentation queue. Per repository branch doctrine,
the packet was cut from that current accepted main rather than discarding the
accepted documentation update.

## Freeze F contract evolution

Freeze F ratification recorded historical byte identity, not a permanent lock.
PR-6b deliberately evolves that contract in two directions:

- it adds versioned stored-fold column metadata and the `foldedAccess` index
  kind; and
- it retires the raw-column `search` btree kind.

The retirement is intentionally non-additive. Repository search finds no
interpreter predicate that consumes the old raw btree: search and resolve both
folded the row value, while the materializer merely rendered every declared
non-unique index generically. The raw index therefore served no issued predicate
under forced RLS and was pure write amplification. The field-level
`searchMapping: normalizedTextIndex` declaration remains the compiler input for
searchable columns; only the unusable physical index kind is gone.

The stored-fold physical name contains the fold-version identity. Transition
comparison uses that physical name, not merely the canonical field ID, so a
future fold function/version must mint a new column and an accounted rewrite.

## R1/R2 compiler, catalog, and uniqueness evidence

The compiler derives the folded set from three independent declaration paths:
case-insensitive business keys, searchable fields, and active resolve match
keys. A permanent compiler test switches an advisory resolve field to
`searchable: false` and still requires its generated column and non-unique
folded index. Unique fields use their two existing unique physical index classes
rather than receiving a redundant third folded-access index.

Fresh-table materialization creates the generated column before its indexes.
Catalog conformance pins all of the following rather than checking existence
alone:

- `attgenerated = 's'`;
- collation `C`;
- the normalized `nsm_unicode_case_fold_v1(source)` generation expression;
- both unique physical indexes over the stored folded column; and
- zero rows where the generated value is distinct from a fresh fold of its
  source.

The uniqueness contract remains unchanged. The provider scenarios still prove
that case-fold-equivalent values conflict across exact/case variants while NFKC
compatibility-distinct strings remain distinct. PostgreSQL may report either of
the two existing unique index names; error translation now maps the entire
case-insensitive unique constraint class to the same canonical field and typed
`MODULE_UNIQUE_VIOLATION`, independent of which index fires first.

The populated-table refusal probe inserts `Straße-001` and `STRASSE-001`, adds
the generated column, and then attempts the narrowed stored-column unique index.
PostgreSQL returns `23505`; both original rows remain, and the failed index is
absent. The constraint is the guard. No row is deleted or rewritten to conceal
the conflict.

## R3 prefix-bound correctness

The prefix lower bound is the canonical Unicode case fold of the input. The
exclusive upper bound increments the last Unicode scalar that can advance and
truncates the suffix, skipping the surrogate interval. An all-maximum-scalar
prefix has no finite upper bound and therefore uses only `>= lower`. Both the
stored column and comparisons are C-collated, making code-point-derived UTF-8
bounds byte-ordered and independent of database locale.

Permanent provider journeys compare actual returned rows against canonical
`unicodeCaseFold(...).startsWith(...)` expectations for case expansion
(`Straße`/`STRASSE`), the U+D7FF to U+E000 surrogate boundary, and U+10FFFF.
They also prove the public default remains substring matching: an infix is found
without `matchMode`, while the same input in prefix mode is not.

## Plan-shape gate and red/green demonstration

`test/postgres/module-index-conformance.test.ts` exercises the real compiled
Party module as the forced-RLS `NOBYPASSRLS` runtime role. It covers relation,
advisory resolve, case-insensitive unique lookup, and prefix range predicates.
The folded probes use the interpreter's complete query shape: selected record
columns, archive predicate, `ORDER BY record_id`, runtime limit, and—for Party
prefix search—the OR across both searchable fields. The prefix value selects a
real row at the largest milestone without turning the predicate into a broad
11%-of-table request for which the ordering index is legitimately cheaper.

The table grows through 10, 100, 500, 1,000, 5,000, and 10,000-row milestones,
with `ANALYZE` and a plan assertion at every milestone. Once a predicate first
uses its intended index, any later milestone that stops doing so is red. On the
pinned image all four predicates first choose their intended indexes at **100
rows** and retain them through 10,000 rows.

The gate walks `EXPLAIN (FORMAT JSON)` structurally, fails closed on unknown
envelopes, node types, child collections, index names, and index-condition
shapes, never disables sequential scans, and requires both an accepted exact
physical index name and the intended folded column in `Index Cond`. Permanent
canaries reject a sequential scan, a wrong index, a missing folded condition,
and an unknown node.

The disposable negative-control command was:

```sh
set +e
PR6B_DEMONSTRATE_MISSING_INDEX=resolve \
  node --import tsx --test test/postgres/module-index-conformance.test.ts \
  > /tmp/pr6b-plan-red.txt 2>&1
status=$?
cat /tmp/pr6b-plan-red.txt
printf 'red_exit=%s\n' "$status"
```

It dropped the declared advisory-resolve index only inside the ephemeral
database and produced:

```text
# PR-6b prefix planner flip rows=100; analyzed rows=10000
# PR-6b relation planner flip rows=100; analyzed rows=10000
# PR-6b resolve planner flip rows=100; analyzed rows=10000
# PR-6b unique planner flip rows=100; analyzed rows=10000
not ok 2 - forced-RLS relation, resolve, unique, and prefix predicates use their declared indexes
error: 'resolve predicate did not use expected folded index nsm_i_swxw5hidgwkk4fgmyjyzplq3zpetzcnyqwaivlkdhx7v634tffra; used nsm_k_jbe7q7wxb6o3hmshj2wokbak4dxkhmm2cnzohhhdg7nztdodmf3a'
# tests 2
# pass 1
# fail 1
red_exit=1
```

The immediate normal rerun returned 2/2, repeated all four 100-row flip lines,
and reported 10,000 analyzed rows. Each run provisions and destroys its own
PostgreSQL container, so the dropped index left no database or repository
residue.

## Pre-existing-table boundary

New modules are born with generated columns and folded indexes through same-plan
`preApprovalInert` creation. Catalog and Location therefore inherit the working
shape before fan-out.

Party's pre-existing table is not upgraded. Adding a stored generated column to
a populated table rewrites it, while the materializer still does not execute
`deferredOnlineFamily`. The compiler nevertheless declares the required
`addColumn` as `rowMutation / onlineStrategyRequired / deferredOnlineFamily`
and makes the dependent `createIndex` wait on it. A real legacy-to-current
journey preserves that declaration and records the current provider boundary:

```text
PR-6b pre-existing folded-column boundary:
error: managed catalog is not attributable: altered managed index nsm_t_q2idry55gyj6w3h6hjz5fn7b5teeheszzmttoq3o2uhxh57lm6ja.nsm_i_z2crxha3ixencdf4xz753yscppphjhhxmpfv6vcrgfrg4hpyrdqq; altered managed index nsm_t_q2idry55gyj6w3h6hjz5fn7b5teeheszzmttoq3o2uhxh57lm6ja.nsm_k_jqz26xpjqy2fojx34ao4xfc6hoayrxcvoqzqdfm7vwqlwst4n3xa; missing managed column nsm_t_pji4fz5nbbiyt3xvxifnbq3v2ngu35nhi7gunecqoufavybkhh3q.nsm_c_dnq6ceewitgydzi5um3yfx6ukenvfascrpcubebbrgpt3voa2elq; missing managed column nsm_t_q2idry55gyj6w3h6hjz5fn7b5teeheszzmttoq3o2uhxh57lm6ja.nsm_c_tdeswsiohutk3lt25y23m5dx35eteccqq2pvjcvfblkbbuop734q; missing managed column nsm_t_q2idry55gyj6w3h6hjz5fn7b5teeheszzmttoq3o2uhxh57lm6ja.nsm_c_uugjhxcb724g54o2hkkgiiar6xw3us7c77x4vhrp2tuoszeykhlq; missing managed index nsm_t_pji4fz5nbbiyt3xvxifnbq3v2ngu35nhi7gunecqoufavybkhh3q.nsm_i_njb3fztsqmp2is7oekuirflnl7vjpmuzxjao44yj3ei6g7hd36sa; missing managed index nsm_t_q2idry55gyj6w3h6hjz5fn7b5teeheszzmttoq3o2uhxh57lm6ja.nsm_i_svipg7odxiqory57mzdt4a5tjkqoeyqbzac5cvjcgwiti2pgnc7q
code: CATALOG_DRIFT
```

The test also proves the generated column remains absent. The next materializer
packet owns a resumable rewrite/online-DDL execution path; PR-6b does not smuggle
one in.

## Compiler-output blast radius

The module-conformance structural golden changed only its two content-addressed
release roots:

```text
v1ReleaseRoot: 29d86260f807bbdd13903be84b4794d260ac9ccd7fac0389fe7d694a39472e8d
            -> b50bf3f196143e73c51a13d82c6402df677b179c0c74948261f4868425370457
v2ReleaseRoot: 5ffb4e7e4d5d582a057ed894568022bbf513156a9a5b5aa3aee35c3306d92a80
            -> 55ad2a56f54579b695207ba6bcfb74bf1038c6fca7516d69407cba7cf50c4e41
```

Its language version, normalization/transition versions, and nine listed
projection families are byte-identical. The storage-target chunks gained only
the ruled folded-column/index shape and lost only the retired raw search index;
the manifests and release roots consequently moved.

The other compiler goldens legitimately did not move. The bootstrap fixture has
no materialized entities. The G1 vertical fixtures use the older
`generatedTyped` storage representation, not the dedicated-table
`StorageEntityTarget` lowered here, so their storage targets contain zero folded
companions and indexes even though one authored field is searchable. The
negative diagnostic is pre-lowering. `test:compiler` therefore changes only the
reviewed G2 structural roots.

`corepack pnpm check:demo-release` remained green before regeneration, proving
the parsed compiled shell already matches fresh compiler output. Neither
`apps/web/release/shell.compiled.json` nor `shell.authored.json` changed. No
migration was needed; `check:schema` remains 10 applied / 10 verified.

## Runtime SLO update

`docs/operations/runtime-slos.md` now marks stored-column equality and explicit
prefix ranges as current for newly materialized tables. Latency numbers are not
new measurements: they are cited from the binding pinned-image verdict. Resolve
moved from the measured 4,472 ms row-folding plan to about 0.33 ms (0.24 ms
forced-generic), and prefix moved from 89.7 ms leaky `LIKE` to 0.31 ms range
lowering. The local executable evidence is plan shape, not latency.

Unanchored substring search is still stated honestly as a partition scan. It no
longer folds each row; the verdict measured 123 ms for a 20-match exit and 188 ms
for a zero-match 500,000-row scan. These single-host figures are not fleet
percentiles or error budgets.

## Retained development reds

- The first compiler suite after lowering was red at 49/50 because the reviewed
  G2 structural release roots still described the pre-PR-6b storage projection.
  Refreshing exactly those two authorized fields returned the suite to 51/51.
- The first catalog-conformance journey allowed its row-drift SQL to run after a
  deliberate structural column/permission drift. PostgreSQL then reported the
  missing object instead of the intended `CATALOG_DRIFT`. The content probe now
  runs only after structural catalog equality is established, preserving the
  original fail-closed diagnostic while still checking every conforming table.
- The first `corepack pnpm format` run was red on five changed source/test files.
  Formatting only the owned files returned format, lint, and typecheck green.
- The first round-1 probe fix used the complete ordered query and correctly
  failed closed on the newly observed `Sort` plan node. Admitting that known
  structural node made the plan readable without weakening any scan or index
  assertion.
- A broad prefix (`Ordinary party 7`) matched roughly 11% of the 10,000-row
  fixture. Its real `ORDER BY record_id LIMIT 100` plan correctly moved from the
  folded bitmap indexes to the ordering index at 10,000 rows, producing:
  `prefix predicate stopped using its declared index at 10000 analyzed rows
  after first using it at 100`. The conformance probe now uses the selective,
  real-row prefix `Ordinary party 7000`; it exercises the identical runtime SQL
  shape and requires both searchable-field indexes through every milestone.
- The exact-name missing-index demonstration above remains retained as the
  required genuine negative control.

## Full-matrix evidence

Pending the frozen candidate run.

## Review evidence

Round 1 reviewed `b4a0960639824e3ca386b6bd293884ab03b648a2`. Codex returned
`REVISE` with two in-scope findings:

1. The prefix probe simplified the interpreter query to one column and omitted
   its selected columns, second searchable field, ordering, and runtime limit.
   Disposition: fixed. The probe now explains the real Party search shape and
   requires both folded index classes.
2. The milestone loop stopped as soon as all predicates first flipped at 100
   rows, so the advertised larger milestones were never evaluated.
   Disposition: fixed. Every milestone now runs, is analyzed, and must retain
   its intended plan after the first flip.

The first finding is the packet's first hard-tripwire-class finding. The one
authorized bounded fix has therefore been consumed. Any further finding that an
emitted index does not serve its intended predicate or that the plan gate cannot
fail is a hard stop. The fresh replacement Codex review and identical-SHA Fable
confirmation remain pending.

## Test it yourself

From the repository root, these commands finish in under ten minutes on the
pinned local environment:

```sh
# Genuine red: remove the folded resolve index only in a disposable database.
PR6B_DEMONSTRATE_MISSING_INDEX=resolve \
  node --import tsx --test test/postgres/module-index-conformance.test.ts

# Green: the same real forced-RLS plan journey with all declared indexes present.
node --import tsx --test test/postgres/module-index-conformance.test.ts

# Functional uniqueness, catalog, transition-refusal, and legacy-boundary proof.
node --import tsx --test \
  test/postgres/module-storage-transition.test.ts \
  test/postgres/party-runtime.test.ts
```

The first command exits 1 and names the missing expected folded index. The next
commands are green; the plan run reports all four planner flips at 100 rows, the
transition suite retains the `23505` duplicate refusal and exact
`CATALOG_DRIFT`, and all databases are disposable containers.

## Draft ledger row

Do not commit this row before acceptance; the merge SHA does not yet exist:

```text
| PR-6b | Folded-column index mechanics | Critical | accepted | <merge-sha> | Stored C-collated generated folds make forced-RLS resolve, unique lookup, and prefix ranges use their declared indexes; raw search btree retired; plan/collation/uniqueness/drift proofs green; full matrix and Critical review chain recorded in docs/execution/packets/PR-6b.md. |
```
