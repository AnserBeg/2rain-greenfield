# G2-P5b — Saved filters

Status: evidence ready; frozen candidate reported in the writer handoff
Tier: Critical
Branch: `packet/g2-p5b`
Base: `82a9ae6770478c3b970e6e0028cc1da409c3bd16`
Frozen candidate: reported in the writer handoff because a commit cannot contain its own SHA

## Outcome

G2-P5b adds durable, tenant/environment/principal/release-scoped saved-filter
criteria for the shared List contract delivered by G2-P5a:

- a first-party `northstar.platform` package authors the saved-filter entity,
  registered Q0 read contracts, registered O0 create/update/archive/restore
  contracts, policy declarations, storage mapping, and ordinary compiled
  surfaces;
- criteria are canonical `PredicateExpression` bytes whose root and nested
  nodes all carry the request-pinned language version;
- the persisted envelope binds trusted tenant, environment, owning principal,
  target List query, language version, normalization profile, position profile,
  release identity and content hash, and lifecycle;
- create and update enter only through the registered Semantic Operation
  executor and commit the row with the existing trust invocation, change
  document, domain event, and outbox transaction;
- get and list enter through registered Semantic Queries and revalidate stored
  criteria against the request-pinned release before returning a row;
- migration `0012_saved_master_filters.sql` owns RLS, runtime privileges,
  immutable-release references, scoped lookup, and a no-hard-delete rule; and
- shared List numeric sorting now orders integer, decimal, money, quantity, and
  other non-text physical values by their raw PostgreSQL type rather than their
  display text.

Saved-filter criteria remain data-plane state. No canonical family, projection
family, language version, compiler shape, runtime gateway contract, or golden
release output changed.

## Established baseline

The branch was cut in an isolated worktree from the exact reviewed G2-P5a
candidate `82a9ae6770478c3b970e6e0028cc1da409c3bd16`, not from `main`. The shared
checkout and `main` were not moved. This complete baseline was observed on that
SHA and needed no retry:

| Gate | Baseline observation |
|---|---:|
| `format`, `build`, `lint`, `typecheck`, `check:demo-release` | green |
| `check:boundaries` | 108 files |
| `check:schema` | 11 applied / 11 verified |
| `test:unit` | 36 / 36 |
| `test:compiler` | 52 / 52 |
| `test:integration` | 59 / 59 |
| `test:agent` | 3 / 3 |
| `test:architecture` | 68 / 68 |
| `test:contracts` | 6 / 6 |
| `test:locale` | 1 / 1 |
| `test:postgres` | 81 / 81, first attempt |
| `test:browser` | 14 / 14 |
| observability producer | 5 / 5 |
| `check:reachability` | 65 / 65 files from 9 producer artifacts |

The baseline reachability run was
`cbf78c29-5a62-4bc2-8754-fe93d94d5a22`.

## Migration re-cut and schema evidence

G2-P0's proposed `0008_saved_master_filters.sql` number was stale. The branch
inventory ended at `0011_module_fold_function_ddl_witness.sql`, so this packet
uses the next free number: `0012_saved_master_filters.sql`.

The migration creates one RLS-forced `platform.saved_master_filters` relation.
Its composite identity and every policy include tenant, environment, principal,
and filter identity. The runtime role receives only `SELECT`, `INSERT`, and
`UPDATE`; `DELETE` is replaced by an immutable-guard write and is never a
business lifecycle path. Archive and restore change the explicit lifecycle and
revision instead.

The schema snapshot was regenerated with the repository tooling, never edited
by hand. Its diff contains 456 insertions and no removals: the 16 columns, four
constraints, primary and scoped indexes, three policies, relation, privileges,
and no-delete rule introduced by migration 0012. No unrelated object moved.
The exact migration and PostgreSQL-test inventories remain pinned. Migration
0012 was admitted by all five existing human-review pins: the architecture
migration list, the module-transition applied array, the trust-substrate title,
the trust-substrate final-name assertion, and its separate upgraded-applied
array. The repository-hygiene inventory separately admits the new PostgreSQL
test. None was softened to a count, subset, prefix, or glob.

The first focused migration attempt used a PL/pgSQL trigger body containing a
lexical `BEGIN`, and the migration runner correctly rejected it as prohibited
transaction-control text. The final migration uses the repository's established
immutable-rule pattern instead; `check:schema` then observed 12 applied and 12
verified migrations.

The first unfiltered pre-freeze matrix reached PostgreSQL 73/75 and stopped on
the module-transition and trust-substrate exact pins. After the first granted
reconciliation, PostgreSQL reached 82/83 and exposed the second independent
trust-substrate array. After all five pins agreed, the first unchanged focused
rerun again reached 82/83 because
`a pre-existing relation index executes as atomic locking DDL and rejects invalid declared shape`
missed its disposable container's 30-second host-port readiness deadline, even
though the container log reported PostgreSQL ready. One honest unchanged-tree
retry passed PostgreSQL 83/83. The intermittent is recorded here rather than
being erased by the retry.

## Platform package factory result

`packages/domain/src/platform` is ordinary first-party definition data beside
Catalog, Location, and Party. It passes through unchanged
`normalizeApplicationPackage` and `compileApplication`, producing all nine
projection families. It required **zero press changes**: no compiler,
canonical-model, runtime, platform-runtime gateway, projection, or materializer
shape was added for the package.

The platform's persistence adapter is deliberately special only where the
trusted ownership metadata is special. Canonical operations declare the three
user-authored values (`name`, `queryId`, and canonical criteria); the provider
derives tenant, environment, principal, release, profiles, and lifecycle from
the issued request view and trusted transaction. Callers cannot supply those
authority fields.

The ordinary press requires search and resolve registrations for a complete
entity. This packet implements saved-filter get/list reads. Search and resolve
return the explicit `saved-filter-query-unsupported` result; they never claim
an exact empty result. Adding a saved-filter search UI or a second text-search
lowering is not hidden inside this packet.

## Canonical criteria and validation

The runtime entry-point budgets are numeric and apply before recursive schema
parsing:

| Budget | Limit |
|---|---:|
| UTF-8 criteria bytes | 4,000 |
| predicate/reference/scalar object nodes | 60 |
| expression depth | 24 |
| collections | 64 |
| members in one collection | 128 |

After those bounds, validation dispatches on every node's `schemaVersion`,
parses the canonical `PredicateExpression`, and requires byte-for-byte canonical
JSON. The target must be an active Q0 List in the pinned query catalog. Every
field comparison must reference a field present in the pinned semantic catalog
and selected by that target List. The provider loads the immutable normalized
package definition bound to the pinned release, projects its canonical authored
form, installs the tenant predicate into the target query, and delegates field
scalar compatibility plus predicate ordering/scalar normalization back to
`normalizeApplicationPackage`. It accepts only when the resulting normalized
predicate bytes equal the submitted bytes. Read revalidation repeats all of
these checks and additionally requires exact authored release ID/hash,
language, normalization profile, position profile, trusted scope, and active
lifecycle.

Failures are typed and position-specific. In particular, a stale field raises
`SAVED_FILTER_FIELD_STALE` at `$.criteria.field.targetId`; the criterion is
never dropped and the provider never returns an unfiltered List result.

ADR-0012 already settles the write-path decision: a user-initiated saved-filter
write is a business write and therefore uses a Semantic Operation. ADR-0008's
administrative carve-out is not extended. The provider exports only its
Semantic Query/Operation executor, not a repository create/update function. A
raw runtime-role insert outside a trusted request transaction is rejected by
PostgreSQL RLS; an accepted operation produces the existing trust records in
the same transaction as the saved-filter row.

## Salvage disposition

The pinned prior implementation at
`/home/rvham/2rain_erp/server/user-view-preferences/**` was read through the
salvage-admission contract as a reference and counterexample, not copied.

- Retained: tenant/user ownership, explicit lifecycle, and the idea that a
  stored preference must be scoped to the thing it configures.
- Rejected: bespoke `{ field: "search", value }` criteria, filtering in memory
  after a capped source read, and silently dropping a stale reference.

The bespoke object would be a second expression language. Post-window filtering
would miss matches before paging. A stale criterion that silently becomes no
criterion can expose unfiltered rows, so this implementation fails closed.

## Executed reds

These invalid cases execute inside the passing real-PostgreSQL test. They are
not claims that the final suite remains red.

| Vacuity vector | Deliberately executed case | Observed red |
|---|---|---|
| numeric sorting still uses display text | order physical numeric values `9`, `10`, `-3`, `-10` through the former `value::text` expression | observed `-10, -3, 10, 9`; comparison with numeric order throws before the production List returns `-10, -3, 9, 10` |
| direct durable write bypass | issue a raw `INSERT` through the runtime pool without a trusted request transaction | PostgreSQL `42501`, row-level-security rejection; no row persists |
| byte budget absent | author 4,001 bytes | `SAVED_FILTER_CRITERIA_BYTES_EXCEEDED` at `$.criteria` |
| depth budget absent | author a 25-level nested predicate | `SAVED_FILTER_DEPTH_LIMIT_EXCEEDED` |
| node budget absent | author an `anyPredicate` with 60 child nodes, exceeding the 60-node total | `SAVED_FILTER_NODE_LIMIT_EXCEEDED` before schema parsing |
| collection budget absent | place 65 collections in one untrusted JSON object | `SAVED_FILTER_COLLECTION_LIMIT_EXCEEDED` before schema parsing |
| only root version is checked | keep the predicate root at v2 but set the nested field-reference node to v999 | `SAVED_FILTER_NODE_VERSION_UNSUPPORTED` at `$.criteria.field.schemaVersion` |
| unknown root version | author a v999 boolean node | `SAVED_FILTER_NODE_VERSION_UNSUPPORTED` at `$.criteria.schemaVersion` |
| wrong scalar kind is structurally accepted | compare the pinned text `name` field with a `booleanValue` | canonical-model validation is mapped to `SAVED_FILTER_FIELD_INADMISSIBLE` at `$.criteria.value` |
| JSON canonicalization masks semantic order | submit canonical JSON whose `anyPredicate` terms are `true, false` rather than canonical `false, true` order | `SAVED_FILTER_CRITERIA_NOT_CANONICAL` at `$.criteria` |
| inadmissible target | bind criteria to the registered get query instead of an active Q0 List | `SAVED_FILTER_QUERY_INADMISSIBLE` at `$.queryId` |
| stale field silently disappears | corrupt the persisted criterion to reference a field absent from the pinned release, then read it | `SAVED_FILTER_FIELD_STALE` at the exact field-reference position; no row result |
| corrupt criterion heals on read | replace stored criteria with valid JSON carrying an unknown predicate kind | `SAVED_FILTER_CRITERIA_CORRUPT`; no row result |
| revoked filter remains readable | archive the row through its Semantic Operation, then get it | `SAVED_FILTER_LIFECYCLE_REVOKED` at `$.lifecycle` |
| principal scope leaks | principal B in tenant A gets principal A's filter ID | `SAVED_FILTER_NOT_VISIBLE`; executor reads zero visible rows |
| environment scope leaks | principal A uses a second environment in tenant A to get the production filter ID | `SAVED_FILTER_NOT_VISIBLE`; executor reads zero visible rows |
| tenant scope leaks | tenant B gets tenant A's filter ID | `SAVED_FILTER_NOT_VISIBLE`; executor reads zero visible rows |
| superseded release is accepted | activate a new release ID for the same tenant/environment, then read the old filter | `SAVED_FILTER_RELEASE_MISMATCH`; criteria are not returned |

## Positive anti-vacuity observations

| Claim | Direct observation |
|---|---|
| zero input | a registered List read before creation reports exactly zero saved-filter rows |
| operation ingress | create succeeds through `SemanticOperationGateway`; one successful trust invocation names the registered platform operation |
| durable round-trip | canonical criteria bytes returned by create and subsequent get are byte-identical to the authored bytes |
| registered update/list | update advances revision 1 to 2 through its Semantic Operation; the registered List then returns exactly that row with unchanged criteria bytes |
| trusted envelope | the persisted tenant, environment, principal, release ID/hash, language, normalization profile, and position profile exactly match the issued request view |
| pinned semantic authority | a valid text comparison survives canonical-model renormalization against the immutable release definition, while incompatible scalar and noncanonical-order controls fail |
| lifecycle recovery | restore revalidates the stored envelope under the current pinned release before returning it to active state |
| factory generality | the new first-party platform definition compiles to nine projections without a press edit or new canonical family |
| honest unsupported surface | the factory-required saved-filter search query returns `unsupported` with `saved-filter-query-unsupported`, not a false exact-empty success |
| no failed-write residue | after all deliberately rejected creates, exactly the one accepted filter row exists |

## Known limits and what the gates cannot prove

- ADR-0012 and the ratified expression-kernel verdict defer non-trivial
  predicate evaluation and SQL lowering to Q1. This packet stores and validates
  canonical criteria against a P5a List identity; it does not execute those
  criteria, create a second evaluator, or return unfiltered rows as a fallback.
- Saved-filter search and resolve are explicitly unsupported. Get/list,
  persistence, scope, lifecycle, and validation are the delivered read surface.
- The provider proves that its public saved-filter module exposes no direct
  repository function and that an ordinary raw runtime-pool insert fails RLS.
  It cannot make deliberately malicious trusted provider code harmless if that
  code imports the request-context authority and writes SQL itself; repository
  boundaries and review remain part of the sole-ingress invariant.
- The 128-member per-collection limit is enforced, but the 4,000-byte ceiling
  makes a syntactically valid 129-term predicate exceed the byte gate first.
  The independent collection-count red proves the collection walker itself;
  it does not directly reach the redundant per-array member branch.
- The real PostgreSQL fixture covers one language/profile pair (`v2`), one
  saved-filter entity, two tenants, three environments, and three principals. It does not enumerate
  future predicate versions, every field/scalar compatibility pair, every
  PostgreSQL release, or malicious superuser action.
- The schema snapshot proves the migration's declared database shape, not that
  every future operational restore or backup workflow preserves tenant state.
- No saved view becomes a navigation node. Page-tab UX and application of a
  saved criterion await the admitted execution and surface work rather than
  widening the ratified grammar here.

## Reproducible evidence

Focused development commands:

```bash
cd /home/rvham/2rain-greenfield-g2p5b
node --import tsx --test test/postgres/saved-filter.test.ts
corepack pnpm check:schema
corepack pnpm test:architecture
```

Expected observations are 2/2 focused PostgreSQL tests, 12/12 migrations, and
68/68 architecture tests. The first focused test prints the numeric-order
journey through its assertions; the second executes every saved-filter red and
then observes exactly one accepted durable row.

## Full-matrix evidence

The complete matrix is run after this record is committed so every gate names
the exact frozen SHA. The writer handoff records all observed counts and the
fresh reachability token. No pre-commit subset is substituted for that run.

Canonical `*.golden.bytes`, `*.golden.sha256`, and the compiled demo release
root are tripwires. They must remain unchanged for this packet.

## Test it yourself

These copy-paste checks finish in under ten minutes:

```bash
cd /home/rvham/2rain-greenfield-g2p5b
node --import tsx --test test/postgres/saved-filter.test.ts
corepack pnpm check:schema
```

Expect 2/2 and 12 applied / 12 verified. The test creates a filter only through
the registered operation, rereads byte-identical criteria, observes the trust
record, rejects cross-principal/cross-tenant/stale-release reads, rejects stale
and corrupt criteria, and leaves exactly one accepted row. It also proves that
the same production List sorts `-10, -3, 9, 10` numerically while the former
text expression demonstrably yields `-10, -3, 10, 9`.

## Program-review trigger assessment

No mid-packet program review is run. This packet adds durable preference state
but does not land a new execution tier or complete the G2 stage; the existing
whole-app review already preceded the master-data fan-out. Re-evaluate the
strong stage/capability trigger on the clean integrated G2-P9 stage gate.
