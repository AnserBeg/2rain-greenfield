# PR-6b — Folded-column index mechanics

Status: active — final narrowed R1/R2 review chain authorized
Tier: Critical
Branch: `packet/pr-6b`
Requested base: `28aaf3c`; actual accepted branch point: `3d394a536668519f1eb978065d63f38eee10674e`
Prior frozen candidate: `01ff6c2811615eaebbf1a8d7de8d2006d7f116aa`
Final narrowed candidate: pending
Review: prior rounds retained below; final Codex/Fable chain pending

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

## Plan-shape gate and red/green demonstration

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

The gate walks `EXPLAIN (ANALYZE, FORMAT JSON)` structurally, fails closed on unknown
envelopes, node types, child collections, index names, and index-condition
shapes, never disables sequential scans, and requires three independent facts:
an accepted exact physical index name; the intended folded identifier followed
by an equality/range operator in `Index Cond`; and `Rows Removed by Filter`
absent or zero on the qualifying index node. The last fact is execution-observed
evidence that the one-row predicate was not demoted to a post-filter. It is more
trustworthy than trying to infer execution from a more elaborate string match.
Permanent canaries reject a sequential scan, a wrong index, a bare/literal
identifier mention, a non-zero post-filter removal count, malformed observed
counts, a missing folded condition, and an unknown node.

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
error: 'resolve predicate did not use expected folded index nsm_i_swxw5hidgwkk4fgmyjyzplq3zpetzcnyqwaivlkdhx7v634tffra; used nsm_k_jbe7q7wxb6o3hmshj2wokbak4dxkhmm2cnzohhhdg7nztdodmf3a'
# tests 2
# pass 1
# fail 1
red_exit=1
```

The immediate normal rerun returned 2/2, repeated all three 100-row flip lines,
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

## Full-matrix evidence

The full matrix ran from a clean tree at exactly
`01ff6c2811615eaebbf1a8d7de8d2006d7f116aa`:

| Gate | Result |
|---|---|
| frozen install | 13 workspace projects already current; pnpm 11.9.0 |
| format / lint / typecheck | green |
| architecture boundaries | 94 files scanned |
| build | green |
| reachability run | token `4edfa0f7-8911-4404-a98d-81bb7a207f18` |
| unit | 27/27 |
| compiler | 51/51 |
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
| security | 229 commits clean; one expected finding in the disposable negative fixture |
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
   surfaced. Final disposition: fixed only after the orchestrator's narrowed
   restart, using operator-bound qualification plus observed zero post-filter
   removals from `EXPLAIN ANALYZE`.
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
launched: Critical review requires Codex PASS first, and the hard-tripwire rule
forbids another writer fix round.

Both reviewers earned their findings. Round 1 forced the probe onto the complete
runtime SQL shape and every declared milestone; round 2 exposed both a false
credit oracle and a real escaping-contract decision. The orchestrator's final
design ruling restarted review only after narrowing the packet: R3 moved to its
own semantic-preservation packet, while the folded equality oracle now combines
exact index identity, operator-bound qualification, and observed zero
post-filter removals. This is the final allowance; any further in-class finding
stops the packet without another writer fix.

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
commands are green; the plan run reports all three planner flips at 100 rows, the
transition suite retains the `23505` duplicate refusal and exact
`CATALOG_DRIFT`, and all databases are disposable containers.

## Draft ledger row

Do not commit this row before acceptance; the merge SHA does not yet exist:

```text
| PR-6b | Folded-column index mechanics | Critical | accepted | <merge-sha> | Stored C-collated generated folds make forced-RLS resolve and unique lookup use their declared indexes; raw search and prefix-only btrees retired; EXPLAIN ANALYZE, catalog, uniqueness, and drift proofs green; R3 explicitly descoped; full matrix and Critical review chain recorded in docs/execution/packets/PR-6b.md. |
```
