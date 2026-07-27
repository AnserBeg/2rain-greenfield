# PR-6d — Prefix-search semantics and range lowering

Status: evidence ready; frozen candidate reported in the writer handoff
Tier: Critical
Branch: `packet/pr-6d`
Base: `a8fee056ba2ee3be436c43a764c6c3bc0d1afb1f`
Frozen candidate: reported in the writer handoff (a commit cannot contain its own SHA)

## Authority and outcome

PR-6d implements R3 of the closed RLS index-access verdict under ADR-0012's
already-ratified semantic ruling: search input is literal text, never an
implicit PostgreSQL pattern. R4 remains unchanged. The generic PostgreSQL
interpreter now supports two modes on the existing compiled Q0 search query:

- omitted `matchMode`, or `matchMode: 'substring'`, performs an unanchored
  literal substring search over stored folds and remains a bounded tenant scan;
- `matchMode: 'prefix'` emits explicit C-collated range predicates and uses the
  declared folded indexes through forced RLS.

The intentional behavior change is narrow and observable. Before PR-6d, a
substring search for `50%` also matched `500`, `a_b` also matched `axb`, and a
backslash participated in PostgreSQL's implicit pattern escaping. After PR-6d,
all of those inputs are literal in both modes. A three-term corpus containing no
special characters produces byte-identical canonical semantic-query records
before and after the substring change.

## Established baseline

The branch was cut in an isolated worktree from exact requested base
`a8fee056ba2ee3be436c43a764c6c3bc0d1afb1f`. The tree was clean before the first
test edit. This matrix was observed rather than copied from PR-6c:

| Gate | Baseline observation |
|---|---:|
| frozen install | pnpm 11.9.0; 13 workspace projects |
| `format`, `lint`, `typecheck`, `build`, `check:demo-release` | green |
| `check:boundaries` | 103 files |
| `check:schema` | 11 applied / 11 verified |
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
| `check:reachability` | 60 / 60 files; 9 producer artifacts |
| dependency and secret scans | green; real negative fixture detected its one intended leak |

The fresh baseline reachability token was
`1c8fb9ea-982a-423a-a4a0-2f3d6298410e`. No baseline gate needed a retry.

## Literal substring strategy

Substring mode keeps PostgreSQL `LIKE` because R4 explicitly retains this
bounded scan. It chooses `!` as an explicit escape character and transforms the
already-folded parameter in this order:

1. `!` becomes `!!`;
2. `%` becomes `!%`;
3. `_` becomes `!_`;
4. the predicate appends `ESCAPE '!'`.

Backslash consequently has no pattern role and is ordinary literal text. The
ordering is significant: an input such as `!%` becomes `!!!%`, which PostgreSQL
reads as a literal `!` followed by a literal `%`. The row side remains the
stored generated fold, so PR-6b's removal of per-row fold computation is
preserved.

## Prefix bounds and declared storage shape

Prefix mode applies the same pinned full Unicode case fold to the input, then
computes the exclusive successor of the folded Unicode-scalar sequence. The
range is:

```text
folded_column COLLATE "C" >= folded_parameter COLLATE "C"
AND folded_column COLLATE "C" < exclusive_successor COLLATE "C"
```

If every remaining scalar is U+10FFFF, there is no finite upper bound and only
the lower predicate is emitted. Successor computation skips the surrogate gap;
the permanent controls pin U+D7FF → U+E000, a trailing U+10FFFF carry, the
all-U+10FFFF open range, and expansion folding such as `Straße` → `strasse`.
The database lower bound and the JavaScript upper bound share the same
version-pinned fold tables: the materializer builds
`nsm_unicode_case_fold_v1` from `@north-star/canonical-model`'s tables, and the
interpreter imports that package's owned evaluator.

`packages/compiler/src/storage.ts` changes for one reason only: a searchable
text field that is neither a resolve key nor a case-insensitive unique key
previously had a stored C-collated fold but no btree. Generic prefix lowering
could not promise declared index access for that legal shape. Every searchable
non-unique fold now receives the existing `foldedAccess` index shape
`(tenant_id, environment_id, folded_column)`; unique fields continue using
their existing unique folded indexes. The compiler control constructs exactly
the formerly uncovered search-only field and observes its index.

No kernel migration is needed. PR-6b already created the required generated
C-collated columns, and PR-6c executes a newly declared index on an existing
module table as `deferredOnlineFamily` locking DDL. The change moves no current
golden because every checked-in real searchable field already had resolve or
unique coverage; no `*.golden.bytes` or `*.golden.sha256` file changed.

## Semantic-preservation evidence

The real Party provider journey inserts deterministic literal/wildcard pairs
and executes the actual gateway under the `NOBYPASSRLS` runtime role:

| Input | Pre-fix unescaped observation | Literal observation in both modes |
|---|---|---|
| `50%` | `50% literal`, `500 wildcard` | `50% literal` only |
| `a_b` | `a_b literal`, `axb wildcard` | `a_b literal` only |
| `slash\mark` | `slashmark wildcard`; the literal slash row is missed | `slash\mark literal` only |
| `bang!mark` | not applicable to the former implicit escape | `bang!mark literal` only; `bangmark` is excluded |

The permanent test executes the former unescaped predicate directly for the
first three rows rather than inferring its behavior from source. For ordinary
terms `ordinary`, `alpha`, and `middle token`, it canonicalizes the complete
semantic records returned by the former predicate and the new substring path
and requires the bytes to be equal.

## Controls and observations

### Executed reds

| Vacuity vector | Deliberately introduced red | Observed failure |
|---|---|---|
| `%` remains a wildcard | Run the new literal assertion before changing the interpreter. | The `50%` subtest returned both deterministic rows and failed with the extra `500` record ID. |
| `_` remains a wildcard | The same pre-fix run used an independent nested subtest. | The `a_b` subtest returned both deterministic rows and failed with the extra `axb` record ID. |
| Prefix gate credits another index or a post-filter | Drop only the exact compiled name-folded index after seeding and `ANALYZE`. | The production-shaped probe fails: `prefix predicate removed 9999 rows by post-filter`, while naming the remaining expected indexes. |
| Multi-column prefix oracle checks only one branch | Feed the oracle a number-index delta of 1 and a name-index delta of 0. | Its permanent canary rejects the missing exact name-index increment. |
| Missing search input passes without a subject | Invoke the actual compiled search query with no `text`. | Production rejects with `MODULE_INPUT_MALFORMED: text must be non-blank` and the test prints `PR-6d search terms lowered: 0 (missing term rejected)`. |

The first two reds ran independently against the requested base. The dropped
index runs inside a disposable PostgreSQL container and leaves no persistent
database or repository state.

### Positive anti-vacuity observations

| Fact | Observation |
|---|---|
| Literal special characters | Both gateway modes return the literal row and exclude the wildcard-shaped competitor for `%`, `_`, `\`, and `!`. |
| C-bound semantics | Real PostgreSQL results equal the owned fold evaluator for expansion folding, the surrogate boundary, and U+10FFFF. |
| Exact prefix index access | At every milestone from the first planner flip through 10,000 rows, each compiled folded index records an `idx_scan` increase and the entire plan tree records zero filter removals. |
| Substring stays bounded | Former and escaped substring predicates have byte-identical node-type/index-name plan trees; both use the exact tenant-leading primary index. The escaped probe observes delta 1, 9,999 post-filter removals, and zero folded-index deltas. |
| Nothing else moved | Complete ordinary-term semantic records are canonical-byte-identical; exact resolve and uniqueness keep their existing predicate and index controls. |
| Generic search-only shape | Compiler lowering observes a `foldedAccess` btree for a searchable field that is neither unique nor a resolve key. |

## Before/after measurement

The local comparison uses the complete compiled Party search shape, 10,000
analyzed rows for one tenant, the actual forced-RLS runtime role, and
`EXPLAIN (ANALYZE, FORMAT JSON)` on both predicates in the same disposable
PostgreSQL 16.14 container. PostgreSQL root `Actual Total Time` is recorded; no
JavaScript wall clock or planner forcing is involved.

```text
PR-6d prefix measurement rows=10000 legacy_like_ms=4.474 range_ms=0.569
```

This is one warm local observation, not a percentile or a pass/fail latency
budget. The binding verdict's larger experiment remains the primary design
measurement: **89.7 ms → 0.31 ms**. The executable fact is plan access, not the
ratio: the PR-6b execution oracle now covers prefix and requires exact compiled
index counter deltas plus zero tree-wide `Rows Removed by Filter`, neither
alone.

## Known limits and what the gates cannot prove

- One PostgreSQL version and local data distribution do not prove fleet
  p50/p95/p99 latency or every future planner choice. The milestone sweep and
  exact execution counters make a silent regression red on the pinned image.
- Prefix mode is an optional argument of the existing Q0 search request. This
  packet adds no typeahead UI, saved filter, Q1 expression, or new canonical
  query-definition field.
- The semantic corpus covers all three former pattern mechanisms, Unicode fold
  expansion, the surrogate boundary, and the maximum scalar; it cannot
  enumerate every Unicode string. Both bounds use the owned version-pinned fold
  tables rather than ambient locale behavior.
- Unanchored substring remains `O(rows in the tenant partition)`. The 10,000-row
  plan comparison proves the current bound and shape, while the verdict's
  500,000-row measurements remain the scale reference. PR-6d does not index
  substring or change R4.
- Search-only indexes on populated pre-existing module tables use PR-6c's
  locking deferred-family path. This packet does not make that path online or
  alter PR-6c's 2,000 ms promotion trigger.
- Exact index counters and zero filter removals prove the intended indexes
  executed for this query; they do not by themselves establish a fleet error
  budget or guarantee the same plan under untested PostgreSQL releases.

## Gate evidence

The complete matrix passed on the final working tree and is repeated after this
record is committed. The writer handoff records that exact candidate SHA and
the fresh frozen-SHA reachability token. The successful pre-freeze run used
reachability token `2e74c7a4-8652-447d-b75a-d645d004ec26`; every suite passed
on its first attempt after the scoped stale-contract correction described
below.

| Gate | Pre-freeze result |
|---|---:|
| frozen install | pnpm 11.9.0; 13 workspace projects |
| `format`, `lint`, `typecheck`, `build` | green |
| `check:boundaries` | 103 files |
| `check:schema` | 11 applied / 11 verified |
| `check:demo-release` | green; canonical release root unchanged |
| `test:unit` | 36 / 36 |
| `test:compiler` | 52 / 52 |
| `test:integration` | 55 / 55 |
| `test:agent` | 3 / 3 |
| `test:architecture` | 52 / 52 |
| `test:contracts` | 6 / 6 |
| `test:postgres` | 80 / 80, first attempt after correction |
| `test:locale` | 1 / 1 |
| `test:browser` | 7 / 7 |
| observability producer | 5 / 5 |
| `check:reachability` | 60 / 60 files; 9 / 9 producer artifacts |
| dependency and secret scans | green; 297 commits clean and the real negative fixture detected its one intended leak |

No new test file was added. Executed-file evidence names all six compiler and
all fourteen PostgreSQL files, including both changed files:
`g2-module-storage.test.ts`, `module-index-conformance.test.ts`, and
`module-storage-transition.test.ts`. The compiler suite observes the new
search-only index shape; the provider suite observes literal semantics, range
access, and bounded substring behavior; and the transition suite observes both
the new generated fold and its dependent deferred-family index persisting on a
pre-existing table.

### Retained development red

The first full pre-freeze run exposed one stale PR-6c expectation in
`a pre-existing generated fold records its measured locking window`. It
expected a search-only fold to have no btree, so `test:postgres` stopped at
79/80 after the compiler intentionally began declaring that index. This was a
real cross-layer contract red, not a retry or environment flake. The scoped
correction makes the test require the `foldedAccess` index, its dependency on
the generated column, two deferred-family elements, and absence-before /
presence-after database observations. Its focused rerun passed, followed by
the fresh full run above at 80/80. No successful gate needed a retry.

## Test it yourself (under ten minutes)

From the isolated packet worktree or a checkout containing the frozen candidate:

```sh
cd /home/rvham/2rain-greenfield-pr6d

# Genuine red: drop only the compiled name-folded prefix index.
PR6D_DEMONSTRATE_MISSING_PREFIX_INDEX=prefix \
  node --import tsx --test --test-name-pattern='forced-RLS relation' \
  test/postgres/module-index-conformance.test.ts

# Green: literal semantics, preservation corpus, both plan modes, and timing.
node --import tsx --test test/postgres/module-index-conformance.test.ts

# Green: the formerly uncovered generic search-only storage shape.
node --import tsx --test --test-name-pattern='search-only fields' \
  test/compiler/g2-module-storage.test.ts
```

The first command exits nonzero with 9,999 rows removed by post-filter after the
exact name-folded index is dropped. The second reports 11/11, both planner modes,
zero lowered terms for the rejected missing input, the prefix before/after
measurement, and the bounded substring observation. The compiler command
reports 1/1. Every PostgreSQL command uses a disposable container.

## Draft ledger row

The writer does not edit `docs/execution/ledger.md`, which is outside the packet
lease and requires the future integrated SHA. The orchestrator can admit this
row after the Critical review chain and integration:

```markdown
| PR-6d | Prefix-search semantics and range lowering | G2 corrective | Critical | evidence_ready | <integrated-sha> | [packet](packets/PR-6d.md); ADR-0012 literal search semantics implemented for substring and prefix, forced-RLS prefix ranges use exact declared indexes with execution-observed negative control, substring remains tenant-bounded, ordinary results are byte-identical, and the full matrix is green at the frozen/integrated SHA recorded during acceptance. |
```
