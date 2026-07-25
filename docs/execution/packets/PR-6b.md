# PR-6b — Folded-column index mechanics

Status: active — E4 catalog ruling implemented; fresh Critical review pending
Tier: Critical
Branch: `packet/pr-6b`
Requested base: `28aaf3c`; actual accepted branch point: `3d394a536668519f1eb978065d63f38eee10674e`
Prior frozen candidates: `b4a0960`, `01ff6c2`, `aefa288`
Prior execution-oracle candidate: `d03c0f6dbb2a2e213ab296856dab878b3ab3647a`
Review: prior Codex REVISE; replacement Codex and Fable pending

## Authority and outcome

PR-6b implements the closed R1-R2 decisions in
[`pr6-rls-index-access-verdict.md`](../debates/pr6-rls-index-access-verdict.md).
For every searchable, case-insensitive-unique, or declared resolve-match text
field, the compiler emits one deterministic companion column:

```text
text COLLATE "C"
GENERATED ALWAYS AS (north_star_module.nsm_unicode_case_fold_v1(source)) STORED
```

Declared resolve keys receive a non-unique btree over
`(tenant_id, environment_id, folded_column)`. The two pre-existing physical
unique-index classes now use the same stored column. Resolve and unique
predicates compare the stored column with `fold($1)`. Unanchored substring
search reads the stored fold but deliberately remains a tenant-partition scan,
as verdict R4 requires; searchable-only fields do not receive a btree that no
current predicate can use.

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
folded index. A second test makes a non-resolve field searchable and requires
its stored fold while rejecting an unused prefix-only btree. Unique fields use
their two existing unique physical index classes rather than receiving a
redundant third folded-access index.

Fresh-table materialization creates the generated column before its indexes.
Catalog conformance pins all of the following rather than checking existence
alone:

- `attgenerated = 's'`;
- collation `C`;
- the exact normalized `nsm_unicode_case_fold_v1(source)` generation expression;
- SHA-256
  `64f811a35df63f8ea9c2974c998e181d34b3813cc0d0373c60f2a7ace041323c`
  over the referenced function's raw `pg_proc.prosrc`;
- both unique physical indexes over the stored folded column; and
- in the provider suite, as `north_star_module_runtime` under a known trusted
  tenant context, a nonzero visible row set with zero rows where the generated
  value is distinct from a fresh fold of its source.

The production catalog verifier intentionally performs no business-row scan.
The E4 ruling and negative controls below explain why.

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

## E4 ruling — prevent fold drift in the catalog, observe rows in tests

The packet rebased onto accepted `main` at `c8bc021`, which added the binding
rules that a gate observes the fact it claims and demonstrates every way it
could pass vacuously. The `learnings.md` rebase conflict retained both appended
entries before this packet's own adjudicated learning was refined.

The prior production row query was vacuous. Migration 0007 makes
`north_star_module_materializer` the managed schema/table owner; managed tables
use `FORCE ROW LEVEL SECURITY`; and their policies and DML grants name only
`north_star_module_runtime`. The materializer is `NOBYPASSRLS`, so its
`count(*) ... WHERE folded IS DISTINCT FROM fold(source)` query saw zero rows.
Both the input count and mismatch count were therefore zero, regardless of
persisted content.

The fix does not widen the materializer's data access and does not add a table
scan to activation. A stored generated column rejects direct writes and
PostgreSQL computes its value from its declared expression. Once
`attgenerated = 's'` and that exact expression are pinned, the reachable drift
vector is replacing the same-named fold function underneath already stored
rows. The production verifier now hashes the actual catalog
`pg_proc.prosrc` and compares it with the pinned v1 digest above. A future fold
body must therefore mint a new function and folded-column version with an
accounted rewrite; `CREATE OR REPLACE FUNCTION` under the old name fails the
catalog gate before any row can silently diverge.

The row assertion remains as independent end-to-end evidence in
`test/postgres/module-index-conformance.test.ts`. It runs under
`north_star_module_runtime` in a trusted-context transaction, requires at least
one visible row per folded subject, and then requires zero mismatches. The
production catalog path is O(1) in table size; the test path proves the emitted
shape over actual tenant rows.

### E4 negative controls — one red per vacuity vector

All controls ran against disposable PostgreSQL containers after the rebase.
Each command exited 1, and a normal run afterward was 3/3 green with relation,
resolve, and unique planner flips at 100 rows.

1. **Subject absent / zero folded columns**

   ```sh
   PR6B_DEMONSTRATE_FOLD_CONFORMANCE=subject-absent \
     node --import tsx --test test/postgres/module-index-conformance.test.ts
   ```

   ```text
   not ok 3 - forced-RLS relation, resolve, and unique predicates use their declared indexes
   error: 'fold catalog conformance observed zero folded columns'
   # tests 3
   # pass 2
   # fail 1
   ```

2. **Same function name, changed body**

   ```sh
   PR6B_DEMONSTRATE_FOLD_CONFORMANCE=function-source \
     node --import tsx --test test/postgres/module-index-conformance.test.ts
   ```

   ```text
   not ok 3 - forced-RLS relation, resolve, and unique predicates use their declared indexes
   error: |-
     fold function source digest changed: nsm_t_jzr3rnshvgk5ddy3mfqsfxdbwt2wekn5tclqqzhbscjttwrvlzza.nsm_c_frwqqfk6miakviqx5sqfxbyvqqceshj6umszcx5cev5q4ly2xuma
     + actual - expected

     + 'ff8d75ca7cb4a82182e6b375ff217b74d8f04cbcde43b3c2dc9853901c597e25'
     - '64f811a35df63f8ea9c2974c998e181d34b3813cc0d0373c60f2a7ace041323c'
   # tests 3
   # pass 2
   # fail 1
   ```

   The production `verifyLiveCatalog()` path has a permanent same-name body
   replacement canary and reports
   `managed function source digest nsm_unicode_case_fold_v1(value text)`.

3. **Unexpected generation expression**

   ```sh
   PR6B_DEMONSTRATE_FOLD_CONFORMANCE=generation-expression \
     node --import tsx --test test/postgres/module-index-conformance.test.ts
   ```

   ```text
   not ok 3 - forced-RLS relation, resolve, and unique predicates use their declared indexes
   error: |-
     fold generation expression changed: nsm_t_jzr3rnshvgk5ddy3mfqsfxdbwt2wekn5tclqqzhbscjttwrvlzza.nsm_c_vzbun2j3bnoe276ocuuudz43limqmjypmydgxmrkfx6w3rdnylpa
     + actual - expected

     + 'nsm_c_on6zjh4vcpvtjitxbmhyvfdfkn4w3xvvnpvm3wuulpnaunajnqjq::text'
     - 'north_star_module.nsm_unicode_case_fold_v1(nsm_c_on6zjh4vcpvtjitxbmhyvfdfkn4w3xvvnpvm3wuulpnaunajnqjq::text)'
   # tests 3
   # pass 2
   # fail 1
   ```

   A permanent in-suite canary independently rejects an unexpected
   `attgenerated` value.

4. **Row check sees zero RLS-visible input**

   ```sh
   PR6B_DEMONSTRATE_FOLD_CONFORMANCE=zero-visible-rows \
     node --import tsx --test test/postgres/module-index-conformance.test.ts
   ```

   ```text
   not ok 3 - forced-RLS relation, resolve, and unique predicates use their declared indexes
   error: 'fold row conformance observed zero visible rows for nsm_t_jzr3rnshvgk5ddy3mfqsfxdbwt2wekn5tclqqzhbscjttwrvlzza.nsm_c_frwqqfk6miakviqx5sqfxbyvqqceshj6umszcx5cev5q4ly2xuma'
   expected: '0'
   actual: '0'
   operator: 'notStrictEqual'
   # tests 3
   # pass 2
   # fail 1
   ```

The relocated row oracle itself also has a real negative control. The catalog
shape is first verified, the same-name function body is then replaced, and all
10,000 visible rows disagree with their stored value:

```sh
PR6B_DEMONSTRATE_FOLD_CONFORMANCE=row-drift \
  node --import tsx --test test/postgres/module-index-conformance.test.ts
```

```text
not ok 3 - forced-RLS relation, resolve, and unique predicates use their declared indexes
error: |-
  fold row conformance observed generated-value drift for nsm_t_jzr3rnshvgk5ddy3mfqsfxdbwt2wekn5tclqqzhbscjttwrvlzza.nsm_c_frwqqfk6miakviqx5sqfxbyvqqceshj6umszcx5cev5q4ly2xuma

  '10000' !== '0'
expected: '0'
actual: '10000'
operator: 'strictEqual'
# tests 3
# pass 2
# fail 1
```

## R3 descope — search semantics before range lowering

The final design ruling removes R3 from PR-6b. The prototype made prefix input
literal text: `%`, `_`, and `\` were ordinary characters passed to
`foldedPrefixUpperBound()`. The existing substring path concatenates the same
input unescaped into `LIKE`, where `%` and `_` are wildcards and `\` participates
in pattern escaping. For example, prefix `%` became the literal C-collated
range `['%', '&')`, while the existing substring pattern `LIKE '%%'` matches
every value. Shipping both would silently give one compiled query contract two
incompatible escaping rules.

The prefix lowerer, public `matchMode`, prefix-only indexes, and prefix plan and
semantic assertions are therefore absent from the narrowed packet. Stored folds
still remove per-row normalization from substring scans, and resolve/unique
equality indexes remain R1/R2. The active queue now owns a separate Critical
packet with PR-2-style semantic-preservation evidence to decide whether search
input is literal text or a user-visible pattern before any range lowering is
reintroduced.

## Execution-observed conformance gate and red/green demonstration

`test/postgres/module-index-conformance.test.ts` exercises the real compiled
Party module as the forced-RLS `NOBYPASSRLS` runtime role. It covers relation,
advisory resolve, and case-insensitive unique lookup predicates. The folded
probes use the interpreter's complete equality-query shape: selected record
columns, archive predicate, `ORDER BY record_id`, runtime limit, and a value
that selects exactly one seeded row.

The table grows through 10, 100, 500, 1,000, 5,000, and 10,000-row milestones,
with `ANALYZE` and a plan assertion at every milestone. Once a predicate first
uses its intended index, any later milestone that stops doing so is red. On the
pinned image all three predicates first choose their intended indexes at **100
rows** and retain them through 10,000 rows.

The relation assertion retains PR-6's exact-name structural plan check. Folded
equality no longer receives credit from `Index Cond` text or from any node-local
association. It requires two independent execution observations:

1. sum `Rows Removed by Filter` across every node in the validated plan tree and
   require zero; and
2. read `pg_stat_user_indexes.idx_scan` for every accepted physical index
   immediately before and after the probe, call `pg_stat_force_next_flush()`
   after execution, and require at least one accepted index to increase by one
   or more.

The counter proves which exact index executed; the tree-wide sum proves the
folded equality was not demoted to a post-filter, including bitmap plans that
split the counter onto a heap-scan parent. Neither fact can substitute for the
other. Before/after counters are read outside the trusted query transaction so
the forced backend flush is visible after commit; no database-wide statistics
reset or elevated privilege is used.

The gate still walks `EXPLAIN (ANALYZE, FORMAT JSON)` structurally, fails closed
on unknown envelopes, node types, child collections, index names, and malformed
filter counters, and never disables sequential scans. Permanent canaries model
the exact bitmap parent/child form from review round 3 and a filter-free plan
with zero index-counter delta; both are red. The original sequential-scan,
wrong-index, malformed-counter, and unknown-node canaries remain.

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
database. The decisive verbatim lines were:

```text
# PR-6b relation planner flip rows=100; analyzed rows=10000
# PR-6b resolve planner flip rows=100; analyzed rows=10000
# PR-6b unique planner flip rows=100; analyzed rows=10000
# Subtest: forced-RLS relation, resolve, and unique predicates use their declared indexes
not ok 2 - forced-RLS relation, resolve, and unique predicates use their declared indexes
error: |-
  resolve predicate removed 9999 rows by post-filter across the plan tree while expecting index nsm_i_swxw5hidgwkk4fgmyjyzplq3zpetzcnyqwaivlkdhx7v634tffra

  9999 !== 0
# tests 2
# pass 1
# fail 1
red_exit=1
```

The immediate normal debug run returned 2/2. At 10 rows, resolve and unique each
reported non-zero tree filters and counter delta 0. At every milestone from 100
through 10,000, both reported tree filters 0 and exactly one accepted physical
index delta 1; the unused alternate unique index stayed 0. Each run provisions
and destroys its own PostgreSQL container, so the dropped index left no database
or repository residue.

The orchestrator independently measured the same mechanism at 50,000 rows on
the pinned image: dropping the folded index yielded **49,999 rows removed**;
with the index present, its `idx_scan` delta was **1** while the primary-key
delta was **0**. Those figures specify signal strength; the checked-in journey's
10,000-row sweep is the executable gate.

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

`docs/operations/runtime-slos.md` marks stored-column equality as current for
newly materialized tables. Latency numbers are not new measurements: they are
cited from the binding pinned-image verdict. Resolve moved from the measured
4,472 ms row-folding plan to about 0.33 ms (0.24 ms forced-generic). The local
executable evidence is plan shape and observed filter behavior, not latency.

Prefix/typeahead remains non-current. The verdict's 89.7 ms leaky `LIKE` and
0.31 ms range measurements remain design evidence, but the semantic decision
described above owns whether and how the range form can become a compiled query
contract.

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
  after first using it at 100`. The round-1 fix used the selective real-row
  prefix `Ordinary party 7000`; the final design ruling then removed R3 and all
  prefix assertions from this packet rather than shipping divergent semantics.
- The exact-name missing-index demonstration above remains retained as the
  required genuine negative control.
- The first narrowed typecheck rejected `resolveMatchFieldIds.has(...)` because
  inference gave the set its branded canonical-ID type while the stored column
  exposes a plain string ID. Declaring the comparison set as `Set<string>`
  returned typecheck and both focused suites green without changing identity
  semantics.
- The first counter-delta implementation read both snapshots inside the still
  open trusted transaction. Plans showed the correct filter transition (9 at 10
  rows, then 0), but every `idx_scan` delta remained 0 because the backend had
  not returned to idle to publish its forced flush. Moving both counter reads
  outside the transaction while leaving `pg_stat_force_next_flush()` between
  query execution and commit/read produced the expected delta 1 from 100 rows
  onward.
- The first relocated row-evidence run queried the right runtime-visible rows
  but read PostgreSQL's `observed_rows` result as the camel-case
  `observedRows`; it also issued parallel queries on one `pg` client. The run
  failed closed with
  `fold row conformance returned an invalid row count for <table>.<column>`.
  Mapping the observed SQL field explicitly and reading each folded subject
  sequentially returned the focused journey to 3/3 green.

## Full-matrix evidence

The final full matrix ran from a clean tree at exactly
`d03c0f6dbb2a2e213ab296856dab878b3ab3647a`:

| Gate | Result |
|---|---|
| frozen install | 13 workspace projects already current; pnpm 11.9.0 |
| format / lint / typecheck | green |
| architecture boundaries | 94 files scanned |
| build | green |
| reachability run | token `6ef2d5a0-9e46-4bab-915c-278aa2cfa543` |
| unit | 27/27 |
| compiler | 52/52 |
| integration | 42/42 |
| agent | 1/1 |
| architecture | 51/51 |
| demo release | parse-normalized check green; artifact unchanged |
| contracts | 6/6 |
| schema | 10 applied / 10 verified; no drift |
| PostgreSQL | 67/67 on the first attempt; no WSL retry |
| locale | 1/1 |
| browser | 5/5 |
| observability inline producer | 5/5 |
| executed-file reachability | 50/50 files from 9 producer artifacts |
| security | 234 commits clean; one expected finding in the disposable negative fixture |
| diff / worktree | `git diff --check main...HEAD`, worktree diff, and complete status all clean |

## Review evidence

Round 1 reviewed `b4a0960639824e3ca386b6bd293884ab03b648a2`. Codex returned
`REVISE` with two in-scope findings:

1. The prefix probe simplified the interpreter query to one column and omitted
   its selected columns, second searchable field, ordering, and runtime limit.
   Disposition at round 1: fixed against the complete Party search shape. Final
   disposition: removed with R3 under the later design ruling.
2. The milestone loop stopped as soon as all predicates first flipped at 100
   rows, so the advertised larger milestones were never evaluated.
   Disposition: fixed. Every milestone now runs, is analyzed, and must retain
   its intended plan after the first flip.

The first finding is the packet's first hard-tripwire-class finding. The one
authorized bounded fix has therefore been consumed. Any further finding that an
emitted index does not serve its intended predicate or that the plan gate cannot
fail is a hard stop.

Round 2 reviewed the unchanged replacement candidate
`01ff6c2811615eaebbf1a8d7de8d2006d7f116aa` after the full matrix above. Codex
returned `REVISE` with two in-scope findings:

1. **HARD TRIPWIRE — the plan gate can false-green.** The accepted input is
   PostgreSQL's unparsed `Index Cond` string. Both the milestone predicate at
   `test/postgres/module-index-conformance.test.ts:700` and the final assertion
   at `:744` use `condition.includes(expectedFoldedColumnName)`. An unrelated
   expression or literal containing that physical name can therefore satisfy
   the folded-column check even when the name is not an index-qualified
   identifier. The falsely credited fact is “the intended folded column occurs
   in the index qualification.” This is the second review round to find that the
   plan-shape gate can report success without proving the interpreter's intended
   index path, so the binding hard stop fired. Disposition at round 2: frozen and
   surfaced. The orchestrator's first replacement tightened the string and added
   node-local filter observation; review round 3 then proved that replacement
   incomplete. Final disposition: superseded by the tree-wide filter sum plus
   exact index-counter delta specified after round 3.
2. **Prefix pattern-character semantics diverge.** The reachable inputs `%`,
   `_`, and `\` are literal characters to `foldedPrefixUpperBound()` at
   `packages/postgres-provider/src/module-runtime-interpreter.ts:917`, while
   PostgreSQL `LIKE` treats them as pattern/escape syntax. For example, `%`
   lowers to the literal range `['%', '&')`, whereas the former pattern `LIKE
   '%%'` matches every string. The provider oracle at
   `test/postgres/module-index-conformance.test.ts:561` compares with JavaScript
   `startsWith()` and therefore does not adjudicate whether prefix input is a
   literal prefix or a SQL-LIKE pattern. Disposition at round 2: surfaced.
   Final disposition: R3 and every prefix implementation/probe artifact were
   descoped to the queued semantic-preservation packet.

No other in-scope material findings were reported. Fable was deliberately not
launched for that candidate: Critical review requires Codex PASS first, and the
then-current hard-tripwire rule forbade another writer fix round.

All three reviewers earned their findings. Round 1 forced the probe onto the
complete runtime SQL shape and every declared milestone; round 2 exposed both a
false-credit oracle and a real escaping-contract decision. The orchestrator's
first narrowed restart moved R3 to its own semantic-preservation packet and
replaced bare containment with operator-bound, node-local observation. Round 3
then proved that oracle incomplete for bitmap parent/child plans. The current
execution-observed replacement is recorded below rather than attributed to the
already-reviewed candidate.

The fresh narrowed review ran against
`aefa288f174c0fca05a8744de9b578c0d8fbb5c9` after the full matrix above. Codex
returned `REVISE — HARD STOP` with one in-scope material finding:

1. **Question 2 / HARD TRIPWIRE — bitmap plans detach the observed filter count
   from the credited index node.** PostgreSQL places `Index Name` and
   `Index Cond` on a `Bitmap Index Scan` child, but places
   `Rows Removed by Filter` on the `Bitmap Heap Scan` parent. `inspectPlan()` at
   `test/postgres/module-index-conformance.test.ts:613` records removals only on
   nodes that also carry an index name and defaults the child observation to
   zero. The assertion at `:691` therefore falsely accepts this plan form:

   ```text
   Bitmap Heap Scan — Rows Removed by Filter: 3
     Bitmap Index Scan
       Index Name: nsm_i_swxw5hidgwkk4fgmyjyzplq3zpetzcnyqwaivlkdhx7v634tffra
       Index Cond: (<folded-name-column> = fold($1))
   ```

   The falsely credited fact is that the advisory-resolve predicate reached its
   qualifying index with no post-filter loss; the same accepted form applies to
   case-insensitive unique equality. Disposition: **not fixed**. This is another
   instance of the unchanged class “the plan-shape gate cannot fail,” so the
   explicit final hard stop applies. The reviewer reported no other in-scope
   material finding for questions 1 and 3–6. Disposition at review: not fixed;
   the writer stopped exactly as required. Final disposition: the orchestrator
   accepted the finding, identified the node-local specification as its own
   design error, and authorized the tree-wide/counter-delta replacement now in
   the candidate.

Fable was not launched for `aefa288`. The Critical chain requires Codex PASS
first. The user then reset the design ladder on the orchestrator side because
the writer had correctly hard-stopped without autonomous patches after every
finding.

## Oracle lineage and terminus

The two failed folded-index oracles were orchestrator-specified:

1. exact index name plus folded-column text in PostgreSQL's `Index Cond` failed
   because bare substring occurrence is not structural proof that the column is
   an index qualification; and
2. exact index name/operator plus node-local `Rows Removed by Filter = 0` failed
   because bitmap plans put the filter counter on the heap-scan parent and the
   index condition on its child.

The replacement observes execution without associating open-ended plan nodes:
tree-wide filter sum zero plus an exact expected-index counter delta. The
reviewers earned every finding, and the writer's three hard stops prevented all
three incomplete designs from being accepted silently.

The terminus is binding: if the fresh review finds another in-class failure in
this oracle, PR-6b splits. R1/R2 ship only with the plan gate explicitly deferred
as a limitation, and the gate design moves to its own debate before any new
packet prompt. No further writer iteration is authorized in that case.

## Fresh execution-oracle review

The fresh naive Codex `gpt-5.6-sol` xhigh review ran read-only against exactly
`d03c0f6dbb2a2e213ab296856dab878b3ab3647a` after the full matrix above. It
returned `REVISE` with one in-scope material finding:

1. **Question 5 — the production row-drift probe cannot observe business
   rows.** `verifyCatalogOnClient()` runs as the `NOBYPASSRLS` materializer,
   while module tables force RLS and their policies name only
   `north_star_module_runtime`. The query at
   `packages/postgres-provider/src/module-storage-materializer.ts:1499`
   therefore sees an empty RLS-visible set and returns zero even if persisted
   generated folds diverge—for example, after a same-named fold function is
   replaced while existing stored values remain stale. The admin-only provider
   test does not make the production verifier fail closed.

The reviewer explicitly classified this as **not** a hard-tripwire finding and
reported no other in-scope material findings for questions 1–4 or 6–7. In
particular, the tree-wide filter sum plus exact index-counter delta satisfied
the narrowed charter. Disposition: **not fixed**. The prior final-allowance
ruling says that a narrowed packet which does not reach Codex PASS plus Fable
confirmation is split or shelved by the orchestrator, not given another
autonomous writer round.

Fable was not launched. Critical review requires Codex PASS first. The frozen
candidate and its green evidence remain intact for a design disposition of the
RLS boundary around the production drift check.

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

The first command exits 1, names the expected folded index, and reports 9,999
rows removed across the plan tree. The next commands are green; the plan run
reports all three planner flips at 100 rows, the transition suite retains the
`23505` duplicate refusal and exact `CATALOG_DRIFT`, and all databases are
disposable containers.

## Draft ledger row — suspended

Do not commit this row. The packet is not acceptance-ready because the fresh
Codex review did not reach PASS, Fable therefore did not run, and the merge SHA
does not exist. Retain the text only for a later split or resumed packet that
completes a valid Critical chain:

```text
| PR-6b | Folded-column index mechanics | Critical | accepted | <merge-sha> | Stored C-collated generated folds make forced-RLS resolve and unique lookup use their declared indexes; raw search and prefix-only btrees retired; execution-observed index, catalog-shape, uniqueness, and <resolved-E4-drift-evidence> proofs green; R3 explicitly descoped; full matrix and Critical review chain recorded in docs/execution/packets/PR-6b.md. |
```
