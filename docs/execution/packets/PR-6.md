# PR-6 — Relation index coverage + EXPLAIN conformance + runtime SLOs

Status: active — implementation and focused evidence complete; full matrix and Critical reviews pending
Tier: Critical
Branch: `packet/pr-6`
Base: `11947885138a8abe5b86bc19930ee13c5ba9951b`
Frozen reviewed candidate: pending
Review: pending — fresh naive Codex `gpt-5.6-sol` xhigh, then Fable max on the identical SHA

## Authority and outcome

PR-6 additively evolves the ratified Freeze F storage contract so every
compiled relation declares a btree over
`(tenant_id, environment_id, relation_column)`. New module tables receive the
index during same-plan materialization, before the Catalog/Location fan-out can
multiply the previous omission. A real forced-RLS PostgreSQL probe requires the
relation predicate to use that exact physical index by name.

The packet also establishes `docs/operations/runtime-slos.md` as the honest v0
request-path measurement contract. It records current partition-scan bounds,
the primary-source measured figures, and PR-6b's ratified future shapes without
claiming future work as current capability.

Freeze F ratification recorded that `protocol.ts` and `storage.ts` were
byte-identical across the completing G2-P2 candidates. It was historical
identity evidence, not a permanent file lock. PR-6's change is strictly
additive: the existing `caseInsensitiveUnique` and `search` kinds retain their
meaning; the new `relation` index kind and one index entry per relation are the
only storage-contract additions.

## Descoped F2/F3 and binding debate

The original packet included a trigram search index and folded resolve-key
index. Early real-provider probing showed those recommendations do not become
index quals through forced RLS. Work stopped before shipping write
amplification. The user descoped F2/F3, and the subsequent in-repo
[RLS index-access debate](../debates/pr6-rls-index-access-verdict.md) converged
and closed the design:

- stored generated folded columns are the future equality-index mechanism;
- advisory resolve keys join unique keys in that coverage;
- the useless raw-column `search` index is retired;
- prefix search lowers to leakproof range predicates; and
- unanchored substring search remains a tenant-partition scan.

All of that work belongs to queued PR-6b. PR-6 contains no `pg_trgm`
extension, migration 0011, folded-column emission, resolve-index change,
search-index retirement, or interpreter predicate change. Schema remains
10 applied / 10 verified.

### Retained investigation evidence

The early `pg_trgm` availability probe passed on the pinned PostgreSQL image at
version 1.6. That fact is recorded so PR-6b does not confuse availability with
usability. Catalog inspection found all four relevant built-ins non-leakproof:

| Function/operator implementation | `proleakproof` |
|---|---|
| `textlike` | `false` |
| `texticlike` | `false` |
| `lower` | `false` |
| `like_escape` | `false` |

The initial minimal-table experiments produced these plan observations:

| Probe | Observed plan |
|---|---|
| A — folded leading-wildcard `LIKE`, no RLS | trigram GIN index |
| B — folded equality, no RLS | folded-expression btree |
| C — folded leading-wildcard `LIKE`, forced RLS restricted role | scan with the folded predicate as a filter |
| D — folded equality, forced RLS restricted role | scan with the folded predicate as a filter |
| E — marking a SET-less experimental fold wrapper `LEAKPROOF` | misleading improvement because the experiment did not match the shipped function |

The converged verdict corrects the initial explanation: the shipped fold has a
non-null `proconfig` from `SET search_path = pg_catalog` and is not inlined, and
RLS tenant/environment quals can remain primary-key index conditions. At the
real target shape, the current resolve/search plan is a tenant-partition scan
with fold-per-row filtering—not necessarily a whole-table sequential scan.
Those corrections supersede the early probe's broader “Seq Scan” framing while
preserving its decisive finding that neither proposed folded predicate used its
intended index under forced RLS.

## Relation index planning and materialization

Every lowered relation adds a deterministic physical mapping and a non-unique
`relation` index on the source entity. New tables already emit their complete
index set as same-plan `preApprovalInert` DDL. Existing relation shapes whose
prior storage target lacks the index emit a `createIndex` transition element
classified `dataScan / onlineStrategyRequired / deferredOnlineFamily`.

That second declaration is deliberately ahead of executor support. Party is
the one pre-existing module and **does not receive the relation index in
PR-6**. The materializer currently processes only `preApprovalInert` and
`inAttemptOnly`; it has no non-transactional resumable `CREATE INDEX
CONCURRENTLY` mode. The next materializer packet owns deferred-online execution,
failed-attempt `indisvalid` reconciliation, and durable step receipts.

The real pre-existing-table journey first materialized a coherent legacy
storage target with the relation index absent, then attempted the PR-6 target.
The compiler emitted the correct deferred element, and the provider failed at
its current boundary with this retained output:

```text
error: managed catalog is not attributable: missing managed index nsm_t_pji4fz5nbbiyt3xvxifnbq3v2ngu35nhi7gunecqoufavybkhh3q.nsm_i_2oly5z7agfzcr5fgwh7jaxktfma2wmdovmsclh5iw73emrigtrla
code: CATALOG_DRIFT
```

The accepted design ruling treats that as an executable known limitation, not
a PR-6 defect. The permanent provider test now proves both sides: fresh module
materialization creates the index, while a legacy-table upgrade declares the
deferred element, fails with exact `CATALOG_DRIFT`, and leaves the index absent.
Plain non-concurrent index creation can block writes on a populated table, so
PR-6 does not weaken the transition classification to force it through.

## EXPLAIN conformance gate

`test/postgres/module-index-conformance.test.ts` materializes the real Party
module, inserts parent/child rows at 10, 100, 500, 1,000, 5,000, and 10,000-row
milestones, and runs `ANALYZE` before each forced-RLS plan. On the pinned image,
the planner first chooses the compiled relation index at **100 rows**.

The probe parses `EXPLAIN (FORMAT JSON)` structurally. It fails closed on an
unknown envelope, child collection, node type, or index-name shape; explicitly
rejects a sequential scan; and requires the exact declared physical relation
index. An unrelated primary-key index therefore cannot false-green the gate.
It never uses `enable_seqscan = off`.

The permanent canaries reject a sequential scan, a wrong named index, and an
unknown future node. The real red demonstration used the ephemeral-only
`PR6_DEMONSTRATE_MISSING_INDEX=relation` switch to drop the compiled relation
index after seeding:

```text
red_exit=1
# PR-6 relation planner flip rows=100; analyzed rows=100
not ok 2 - the forced-RLS relation predicate uses its declared relation index
error: 'relation predicate did not use expected relation index nsm_i_o64oga6vn2c5pqkym6tm7g6g3hj55vca5you42l7va6ibvt3jakq; used nsm_k_4oor5zbzcy76nptfiuluhqlx6vfsevh5t4hscpzzyd5qkkyn4s7q'
# tests 2
# pass 1
# fail 1
```

The immediate normal rerun returned 2/2 with the same 100-row flip. Each run
uses a disposable PostgreSQL container, so the dropped index left no repository
or database residue.

## Compiler-output blast radius

The authorized structural golden changed only:

```text
v1ReleaseRoot: 738b984276548df76d461b66e1390abeb9cad9e2f7be3471b5a8fa3b98496640
            -> 29d86260f807bbdd13903be84b4794d260ac9ccd7fac0389fe7d694a39472e8d
v2ReleaseRoot: 62434b54969db9ff983cf1f0498345b8871374c44eab03ccfc7dc6e1b073cae8
            -> 5ffb4e7e4d5d582a057ed894568022bbf513156a9a5b5aa3aee35c3306d92a80
```

Its language version, normalization/transition versions, and nine projection
family IDs are unchanged. The storage-target chunk gained only the relation
index, so the content-addressed release roots moved as expected.

The other six G1 compiler goldens legitimately did not move. Their bootstrap
and vertical authored fixtures declare no relations; the bootstrap storage
chunk contains zero `relation`, `foreignKey`, or `indexes` occurrences. They
therefore cannot gain a relation index. `test:compiler` is green at 50/50, and
`check:demo-release` remains green without changing
`apps/web/release/shell.compiled.json` or its authored input.

## Retained development reds

The initial broad F1-F3 provider probe proved that the proposed folded search
and resolve indexes were unused under forced RLS. Work stopped for the descoping
ruling; no pg_trgm migration or unused index remains.

The first compiler run after F1 was red at exactly 49/50 because the
module-conformance v1/v2 release roots were stale. The authorized two-field
refresh returned the suite to 50/50; no other golden moved.

The first real pre-existing-table coexistence journey failed 8/9 with the exact
`CATALOG_DRIFT` above. That surfaced the compiler/materializer capability
boundary and triggered a second stop. The design ruling kept compiler emission,
routed execution to the next materializer packet, and required the permanent
current-boundary assertion. The replacement journey is green at 9/9.

The first lint pass found one unused destructuring binding in the test-only
artifact rehasher. Replacing it with an explicit copied body and deleted digest
field preserved the intended attestation calculation and returned lint green.

## Full-matrix evidence

Pending at the frozen candidate.

## Review evidence

Pending at the frozen candidate.

## Test it yourself

Pending final SHA. The checkpoint will include the one-command red/green
EXPLAIN demonstration and the focused new-versus-pre-existing materialization
proof.

## Draft ledger row (do not commit to `ledger.md`)

Pending final SHA and review evidence.
