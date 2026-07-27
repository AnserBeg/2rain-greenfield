# G2-P5a — Shared List behavior

Status: evidence ready; frozen candidate reported in the writer handoff
Tier: Critical
Branch: `packet/g2-p5a`
Base: `efeb35ec75abe860e9e314ac8e80168827341220`
Frozen candidate: reported in the writer handoff because a commit cannot contain its own SHA

## Outcome and packet split

G2-P5 was split at admission under AGENTS.md §3.5. This packet delivers one
provider-neutral shared List contract and its real PostgreSQL, gateway, agent,
and compiled-surface consumers:

- bounded pages with coverage, maximum-result truncation, and an opaque cursor
  bound to query identity plus archive/search/sort/relation-label arguments;
- stable multi-key sorting with ascending record ID as the final tie-breaker;
- literal search over every authorized server-projected display value before
  paging, including formatted enum values and independently authorized relation
  labels;
- archived records hidden by default and explicitly includable;
- one `SemanticQueryResultEnvelope` whose `listCoverage` and records are
  consumed unchanged by Semantic Query, agent discovery, and the UI adapter;
- rendering through the existing literal component-registry path, with closed
  status-role tokens and a measured 44px paging target.

G2-P5b follows with saved filters, the first-party platform package, Semantic
Operation write, canonical predicate envelopes, runtime input bounds, migration,
snapshot, and stale-reference behavior. P5a contains no saved-filter write,
migration, or platform package. ADR-0012 already settles P5b's ADR-0008 question:
a user-initiated saved-filter write is a business write and must use a Semantic
Operation; it is not covered by the administrative carve-out.

The active queue is re-cut into explicit P5a and P5b rows. G2-P0's stale
`0008_saved_master_filters.sql` lease is carried to P5b as “use the next free
number”; P5a creates no migration.

## Established baseline

The branch was cut in an isolated worktree from exact requested base
`efeb35ec75abe860e9e314ac8e80168827341220`. The packet branch was renamed from
`packet/g2-p5` to `packet/g2-p5a` after the split; shared `main` was not reset,
rebased, or modified. The baseline matrix was observed on the requested base,
not copied from another packet:

| Gate | Baseline observation |
|---|---:|
| `format`, `build`, `lint`, `typecheck`, `check:demo-release` | green |
| `check:boundaries` | 105 files |
| `check:schema` | 11 applied / 11 verified |
| `test:unit` | 36 / 36 |
| `test:compiler` | 52 / 52 |
| `test:integration` | 55 / 55 |
| `test:agent` | 3 / 3 |
| `test:architecture` | 68 / 68 |
| `test:contracts` | 6 / 6 |
| `test:postgres` | 80 / 80, first attempt |
| `test:locale` | 1 / 1 |
| `test:browser` | 13 / 13 |
| observability producer | 5 / 5 |
| `check:reachability` | 62 / 62 files from 9 producer artifacts |

The baseline reachability token was
`d0aac7dc-ecba-4cbd-bc87-e8a7fbe3fd6b`. No baseline gate needed a retry.

## Contract and execution shape

The untrusted wire envelope uses the ratified archetype vocabulary:
`northstar.shared-list-query/v1`, `SharedList...`, `listCoverage`, and
`listCursor`. Bridge 3 rejected weakening the semantic-gateway vocabulary guard;
renaming the provisional `SharedTable` vocabulary made the unchanged guard green.
The request remains cloned as immutable JSON before parsing and has a closed
shape with bounded page size, search text, sort keys, and relation-label entries.

The gateway authorizes sort fields only when they are selected source fields or
requested relations. Each relation label independently resolves to an active
pinned Q0 list query, requires the label field to be selected by that query, and
performs a fresh current-policy decision before provider execution. The
PostgreSQL provider then validates that the relation and target entity match the
compiled storage projection. There is no trusted relation or field identity from
browser input alone.

The provider applies archive and literal-search predicates before `ORDER BY`,
`LIMIT`, and `OFFSET`. Text fields with PR-6d stored folds reuse them; authorized
visible text without a declared fold uses the same version-pinned fold function
as an expression. Non-text display values use their formatted text, then the
same PR-6d literal lowerer. No second escaping implementation was added.
Substring mode therefore retains R4's bounded tenant-partition scan while `%`,
`_`, and `!` retain PR-6d literal semantics.

The complete result is preserved by `SurfaceRuntime`; the markup-free list
adapter shapes rows and the existing closed component registry renders them.
No component ID, computed registry key, compiler shape, canonical-model shape,
or surface-contract field was added.

## G2-P4 antibody: first production catch

The first implementation put list markup in `apps/web/src/list-runtime.ts`.
G2-P4's new production scan immediately failed:

```text
SURF001_RUNTIME_BYPASS apps/web/src/list-runtime.ts
```

This was not suppressed or allowlisted. The adapter was reduced to a markup-free
view model; compiled list arguments moved into `SurfaceRuntime`, and rendering
moved into the existing literal component registry. The unchanged seam suite
then passed 4/4. This is the bespoke-screen antibody's first real production
catch one packet after it landed, stronger evidence than G2-P4's synthetic red.

## Salvage disposition

The prior repository's `server/user-view-preferences/**` and shared table code
were read through the salvage contract as counterexamples and ownership input,
not copied.

- Retained for P5b consideration: tenant/principal ownership, lifecycle, and the
  need to resolve stale references explicitly.
- Rejected: bespoke `{ field: "search", value }` criteria, in-memory filtering
  over a capped source window, and silently dropping a stale criterion. The
  first would create a second expression language; the second filters after
  truncation; the third can return unfiltered rows and is a data-exposure bug.

## Round 1 review revision

The first Critical review returned REVISE and voided candidate `745a5a5`. It
found that relation-label target Lists did not enter the same predicate kernel
as directly invoked queries, and that source-field search exclusion was only
structurally apparent. The revision routes every authorized label target
through `inspectPredicateForExecution` before provider execution and adds the
two-sided real-PostgreSQL source-field control below. No other reviewed behavior
was changed.

## Executed reds

These are deliberately invalid requests/results asserted inside passing tests;
they are not claims that CI was left red.

| Vacuity vector | Deliberately executed case | Observed red |
|---|---|---|
| unauthorized source sort field | sort the Party-role list by Party `name`, which is neither a selected role field nor an authorized relation ID | `LIST_FIELD_NOT_AUTHORIZED`, with the exact field ID; provider execution does not occur |
| unselected source-field search | place `source-only-sentinel` only in Party `contactSummary`, issue a List projection that excludes that field, and search for it | coverage is `0` and records are empty; after one update removes the sentinel from `contactSummary` and puts it in selected `name`, the identical search returns exactly that record |
| denied relation-label field | current policy denies the pinned Party label query while the role list requests its relation label | `SemanticQueryPolicyDeniedError` names `party_list`; executor count remains zero |
| rejected relation-label target predicate | reach an active Q0 Party label List with `filter: false` through the Party-role source List | source result is `query-filter-unsupported`, predicate receipts are `accepted` then `rejected`, and executor count remains zero |
| cursor detached from its query | reuse page one's cursor after changing the search term | `LIST_CURSOR_INVALID` |
| result coverage absent | executor returns an exact list result but omits `listCoverage` | `LIST_RESULT_MALFORMED` |
| G2-P4 bypass | place rendering markup in the list adapter outside the compiled component path | `SURF001_RUNTIME_BYPASS` |
| old fake envelope | run existing integration/browser fakes after `SurfaceRuntime` starts sending List arguments but before they return coverage | two integration and two browser assertions observe `QUERY_UNAVAILABLE`/missing data; the granted mechanical reconciliation restores valid coverage rather than weakening assertions |

The pre-reconciliation honest suite counts were architecture 67/68,
integration 55/58, and browser 12/14. The semantic vocabulary guard improved
without an edit after `table` was renamed to `list`.

## Positive anti-vacuity observations

| Claim | Direct observation |
|---|---|
| page boundary and tie sort | six equal role-kind rows traverse three two-row pages; concatenated IDs equal the stable ascending ID order and contain six unique IDs |
| search before paging | the first unfiltered page explicitly contains no `Page Three Needle`; the search returns that former third-page record at offset zero |
| every authorized visible value | relation label `Page Three Needle`, formatted enum `Customer`, and the selected non-indexed contact summary `not-visible-3` each return the expected record |
| no unrequested target leakage | searching role rows for the target Party contact summary returns coverage `0` and no records; only the requested Party name label participates |
| relation-label rendering | the actual component registry emits `Authorized relation label` and `data-list-coverage="1–1 of 1"` from the same gateway object |
| archive visibility | one archived role is absent by default and present with `includeArchived`, carrying `archived: true` |
| coverage and truncation | a requested size of 500 is clamped to the compiled maximum 100 and reports both values plus `truncatedByMaximum: true` |
| zero search input | an empty search reports `projectedSearchValueCount: 0` rather than silently crediting a search branch |
| channel parity | UI view, Semantic Query result, and agent-discovered query share the identical result object and record array; executor count is exactly one |
| compiled browser path | Chromium follows page 1 → page 2, observes exact coverage, finds a page-two match as a one-row first search page, toggles archive inclusion, sees formatted enums, and measures the Next target at least 44px high |

## Known limits and what the gates cannot prove

- The cursor is a checksummed, query-bound offset cursor, not a database
  snapshot or keyset cursor. Stable ordering and exactly-once page boundaries
  are proven for an unchanged result set. Concurrent inserts, archives, or
  deletes between requests can shift offsets; this packet does not promise
  snapshot-consistent multi-request pagination.
- Coverage count and page selection are two statements inside one trusted
  transaction. Under PostgreSQL's current read-committed isolation, concurrent
  writes can change the snapshot between those statements. The gates prove
  exact coverage for a stable fixture, not a concurrent-write snapshot.
- Relation labels are opt-in List arguments and are independently authorized.
  Existing compiled surfaces have no relation-label declaration field, so
  `SurfaceRuntime` issues an empty relation-label set by default. The registry,
  gateway, policy, and provider path is exercised with an authorized relation
  result; adding a compiled declaration would be a later canonical/surface
  contract decision, not an implicit grammar change here.
- SurfaceRuntime currently uses record-ID default order and exposes Next-page
  navigation. Multi-key sort is available through the shared Semantic Query
  arguments and proven in PostgreSQL; this packet adds no interactive sort
  control or new component vocabulary.
- The real PostgreSQL fixture proves one many-to-one relation and text/enum
  formatting. It cannot enumerate every future field type, collation, relation
  cardinality, policy implementation, or planner choice.
- RLS and tenant/environment scope remain owned by the existing runtime role
  and provider transaction. These tests add no cross-tenant bypass and do not
  replace the existing isolation suite.
- Agent discovery supplies the query ID used for the parity journey, but
  `agentResult` is a direct alias of the Semantic Query result. The identity
  assertions prove one shared object and avoid a second filtering path; they do
  not independently exercise an agent transport.
- Saved filters, stale-reference diagnostics, predicate resource bounds, and
  durable preference scope belong to G2-P5b and are intentionally absent.

## Reproducible evidence

Focused development commands:

```bash
cd /home/rvham/2rain-greenfield-g2p5
node --import tsx --test test/integration/table-behavior.test.ts
node --import tsx --test test/postgres/table-behavior.test.ts
corepack pnpm test:architecture
corepack pnpm test:browser
```

Expected focused results are 4/4 shared-result integration checks, 1/1 real
PostgreSQL journey, 68/68 architecture checks, and 14/14 unfiltered Chromium
journeys. A filename-filtered Playwright run executes during development but is
correctly rejected as evidence by the reachability reporter; use the unfiltered
command above for recorded evidence.

## Full-matrix evidence

The round-1 replacement matrix passed before its freeze commit with reachability
run token `1806ca82-6fc9-4ef3-aab0-9fff4dfa5f6f`. The identical matrix is rerun
at the resulting frozen SHA and reported in the writer handoff; a commit cannot
contain evidence produced after its own SHA is created.

| Gate | Pre-freeze observation |
|---|---:|
| `format`, `build`, `lint`, `typecheck` | green |
| `check:boundaries` | 108 files |
| `check:schema` | 11 applied / 11 verified |
| `check:demo-release` | green; canonical release root unchanged |
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

Canonical `*.golden.bytes` and `*.golden.sha256` files and
`apps/web/release/shell.compiled.json` remained byte-unchanged. The observed demo
release root remained
`0a5362906943d62c7397db835958153a85457356224eb227a05d53c4e143259f`.

## Test it yourself

From the packet worktree, these copy-paste commands run in under ten minutes:

```bash
cd /home/rvham/2rain-greenfield-g2p5
node --import tsx --test test/integration/table-behavior.test.ts
node --import tsx --test test/postgres/table-behavior.test.ts
corepack pnpm test:browser
```

Expect 4/4, 1/1, and 14/14. In the browser output, the
`table-behavior.spec.ts` journey observes `1–100 of 102`, clicks **Next page**,
finds **Page Two Needle**, searches it back onto a one-row first page, confirms
archived-default-hidden/explicitly-included behavior, and renders **Supplier**
and **Customer** rather than raw canonical option IDs.

For a visible walkthrough:

```bash
cd /home/rvham/2rain-greenfield-g2p5
PWDEBUG=1 corepack pnpm test:browser
```

In the Playwright inspector, resume to `table-behavior.spec.ts`; inspect the
coverage pill, Next target, search result, archived status role, and formatted
role cells.

## Program-review trigger assessment

No program review runs mid-packet or on this unintegrated working tree. P5a
extends the already-reviewed G2 master-data walking slice rather than stabilizing
a major new correctness domain comparable to G3's concurrent ledger. The last
whole-app review preceded the G2 fan-out, and the remaining G2 packets are
P5b, P8, and P9. Re-evaluate and propose the next program review at the clean,
integrated G2 stage boundary, where the stage-gate/new-capability-tier trigger
can be assessed against the complete system.

## Handoff

This packet stops at its frozen candidate. It does not integrate, update the
accepted ledger, launch its Critical review, or begin G2-P5b. Those are the
orchestrator and acceptance steps.
