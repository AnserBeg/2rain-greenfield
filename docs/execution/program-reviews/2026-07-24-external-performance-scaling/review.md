# External performance / scaling review — F1–F12

Provenance: independent external AI review with repository access, 2026-07-24, against
`main` around `d1ab76b`. Reproduced verbatim from the session transcript by the orchestrator.
The orchestrator independently verified F1, F2, F4, F5, F11, and F12 against the code
(7 of 7 checked claims accurate); F3 follows from the same two-kind index union; F6–F10 were
not individually re-verified but follow the same code patterns.

---

## Tier 1 — real scaling landmines

### F1. No index on relation (foreign-key) columns — the worst one

`storage.ts:511–570` builds the `indexes` array inside a loop over columns, with exactly two
triggers: `businessKey === 'tenantEnvironmentCaseInsensitiveUnique'` and
`searchMapping === 'normalizedTextIndex'`. Relations are planned separately at
`storage.ts:626–671` — they get a column and a foreign key, and no index.

PostgreSQL does not auto-index FK columns. Consequences today:

- `module-runtime-interpreter.ts:583` runs `WHERE relation_col = $1 AND archived_at IS NULL`
  against the child table on every archive → seq scan.
- FK `ON DELETE/UPDATE RESTRICT` enforcement scans the referencing table on every parent
  write → seq scan, while holding the parent row lock.
- Every parent → children read does the same.

Party's parent-scoped child (G2-P3b) is exactly this shape, and Catalog/Location fan-out
multiplies it. Fix: emit a btree on `(tenant_id, environment_id, relation_column)` for every
relation. Additive, no contract risk.

### F2. The declared search index cannot serve the search query

The compiler plans `indexKind: 'search'` over `['tenant_id','environment_id',col]`
(`storage.ts:552`). The materializer renders it as a plain btree on the raw columns —
`module-storage-materializer.ts:2578` returns `index.columnNames.map(quoted)` for anything
that isn't `caseInsensitiveUnique`, and `module-storage-materializer.ts:2568` pins
`USING btree`. The runtime predicate is (`interpreter:772`):

```
unicode_case_fold(col::text) LIKE ('%' || unicode_case_fold($1::text) || '%')
```

A btree on the raw column cannot serve a function-wrapped leading-wildcard LIKE. The index is
pure write amplification — it costs INSERT/UPDATE time and disk and returns nothing. Every
search is a seq scan evaluating a SQL function per row per column.

Fix: `pg_trgm` GIN index on `unicode_case_fold(col)`. Trigram is the only PG index kind that
accelerates `LIKE '%x%'`. The function is already `IMMUTABLE STRICT PARALLEL SAFE`
(`materializer:2630`), so it's indexable today — this is one new `indexKind` plus
`CREATE EXTENSION pg_trgm`.

### F3. Advisory resolve keys — the agent's hot path — have the worst index coverage

`module-runtime-interpreter.ts:882` uses `fold(col::text) = fold($1::text)`, which is
index-servable. But the folded expression index only exists for fields declaring
`tenantEnvironmentCaseInsensitiveUnique`. A field declared as an advisory resolve match key —
the name-like keys that are the entire point of the Problem 6 design — gets only the F2 btree,
which doesn't match the expression. Seq scan.

Fix: emit a non-unique expression index on `(tenant_id, environment_id, fold(col))` for every
declared resolve match key, not just unique business keys.

### F4. Every query and every operation re-reads and re-verifies the whole release

`module-runtime-interpreter.ts:1016`, called per query (`:161`) and per operation (`:193`):

1. `SELECT ... FROM platform.read_tenant_release_artifacts($1)` — the entire artifact set
2. `verifyArtifact` on every row — SHA-256 over all bytes (`:1101`)
3. `decodeCanonical` on every row — `JSON.parse` plus a full `canonicalize()` re-serialization
   and string compare (`:1116`)

No cache. O(release bytes) of network, hashing, and re-serialization per request. Meanwhile
`request-runtime-view-service.ts:244` does cache the same class of work — so you have two
release-load paths with opposite caching behavior, and the uncached one is the hot one.
Release content hashes are immutable by construction, so a verified-once content-addressed
cache needs no invalidation logic beyond the fence machinery you already built.

### F5. N+1 across relations on archive/restore

`module-runtime-interpreter.ts:583` and `module-runtime-interpreter.ts:613` both loop over
relations issuing one serially-awaited query each, inside the write transaction. Combined with
F1 (each of those queries is a seq scan) this is the sharpest edge in the write path. Both
collapse to one query with `UNION ALL` or a lateral over the relation set.

### F6. `matchResolveRecords` costs two round trips

`interpreter:855` and `:862` — identifier matches then advisory matches, awaited serially. One
query with a tagged `UNION ALL` returns both sets and both counts in one trip.

## Tier 2 — fixed per-transaction overhead, all of it ceremony

### F7. Seven round trips per trusted transaction; one does work

`request-context.ts:10`: `connect` → `BEGIN` → `SELECT ... FROM pg_catalog.pg_roles` →
`set_config ×4` → work → `COMMIT` → `RESET ROLE` → `RESET ALL`. node-postgres does not
pipeline; each is a full round trip. On a network-attached Postgres that's 3.5–7 ms of overhead
before any work.

Three are removable with no weakened invariant:

- The role check is per-connection-invariant. The pool logs in as `north_star_runtime`, and the
  only `SET ROLE` anywhere is `SET LOCAL ROLE` (`interpreter:1144`), which is
  transaction-scoped. Verify once in a `pool.on('connect')` handler; keep the assertion, lose
  the per-transaction round trip.
- `RESET ALL` is provably redundant — every `set_config` passes `is_local = true`, so
  COMMIT/ROLLBACK already discards them.
- `RESET ROLE` after COMMIT is redundant for the same reason. If you want it as
  belt-and-braces, `'RESET ROLE; RESET ALL'` as one simple-query string is 1 round trip instead
  of 2.

### F8. `load()` costs a full transaction even on a cache hit

`request-runtime-view-service.ts:257` calls `#readPointerAuthority` — a complete F7 transaction
— before consulting the cache. You already have push-based invalidation (`consumeInvalidation`,
`ReleaseInvalidationFenceState`). Either the fence is authoritative, in which case the
per-request pointer read is redundant, or it isn't, in which case the fence machinery is dead
weight. Currently you pay for both.

### F9. Five round trips of role ceremony per operation

`module-runtime-interpreter.ts:1130`: `roleFacts` → `SET LOCAL ROLE` → `roleFacts` → work →
`RESET ROLE` → `roleFacts`. Three of the five are the same `pg_roles` catalog query. Stacked on
F7, one write costs ~12 round trips before touching a business row. The assertions are worth
keeping; `SET LOCAL ROLE ...; SELECT current_user, session_user, ...` folds two into one, and
the post-reset check can ride along with the next statement.

### F10. The idempotency advisory lock is redundant with its own primary key

`trust/postgres-trust-service.ts:344` takes an advisory lock, then SELECTs (`:359`), then
INSERTs (`:393`) — three round trips. But `platform.semantic_operation_receipts` (`0009`)
already has a PRIMARY KEY over the identical identity tuple. The PK already serializes
concurrent duplicates correctly. `INSERT ... ON CONFLICT DO NOTHING RETURNING` is one round trip
in the common case, with the SELECT only on the conflict path.

## Tier 3 — correctness problems I hit while looking at speed

### F11. Idempotency is scoped to principal and release, so a retry across activation double-executes

The PK is `(tenant, environment, principal_id, release_id, release_content_hash, action_id,
idempotency_key)`.

- Different principal, same key → executes twice. A background retry worker, a different session
  token, or a delegated agent is a different principal. The SELECT policy (`0009:66`) also gates
  on `principal_id`, so a retry from another principal cannot even see the prior receipt.
- Different release, same key → executes twice. A retry right after an activation is the common
  case: activate → transient error → client retries.

For the inventory ledger in the next stage this is precisely the fatal double-post. Fix: dedupe
on `(tenant, environment, action_id, idempotency_key)`; keep principal and release in the row as
evidence, and treat a mismatch on replay as a conflict, not a fresh execution. That also makes
the stored `input_digest` check meaningful.

### F12. One global advisory-lock namespace shared by six subsystems

All use the single-argument 64-bit form over a text hash: `migrations.ts:112` (`hashtext`, int4
— only 2³² of the space), trust service `:349` (highest frequency), `materializer:3228`,
approval service `:467`, plus 0003/0004/0005. A collision between a hot idempotency key and the
kernel migration lock blocks a migration behind a business write with no diagnostic. Fix: the
two-argument form `pg_advisory_xact_lock(classid, objid)` with a per-subsystem `classid`.
Structurally eliminates cross-subsystem collision and makes `pg_locks` readable during an
incident.

## What's already right — don't touch it

- SQL is shape-specialized per query definition (`module-runtime-interpreter.ts:931`), not
  universal-with-optional-predicates. That's the thing most interpreter designs get wrong.
- Pagination is keyset, not OFFSET (`module-runtime-interpreter.ts:747`). Correct at any table
  size.
- The case-fold function is `IMMUTABLE STRICT PARALLEL SAFE` with a pinned `search_path` —
  indexable and safe.
- RLS tenant predicates use STABLE functions (`0007:11`), so the planner can use them as index
  scan keys against a `(tenant_id, environment_id, …)` prefix.
- The request-runtime snapshot loads in one statement with an explicit READ COMMITTED rationale
  (`:437`) — avoids both N+1 and a torn read.

## The gap in the docs

`compiler-slos.md` covers compile, preparation, approval, and activation timing, with a hard
numeric gate (5,000 ms at 4,096 fields) enforced by `test/compiler/performance-budget.test.ts`.
There is no request-path SLO family at all — no query p95, no release-load budget, no
search-latency budget, no index-coverage assertion. The compiler, which runs once per release,
is gated; the runtime, where the customer actually waits, is not.

The cheapest thing that would have caught F1, F2, and F3 automatically: a conformance probe that
runs `EXPLAIN` on every compiled query shape against a seeded table and fails if the plan
contains a Seq Scan on a module table. It's the same structural-assertion spirit as the rest of
the conformance work, roughly thirty lines, and it converts "did we index the right expression?"
from a review question into a gate that survives fan-out.

## Suggested order

1. F1, F2, F3 (index planning) — before Catalog/Location fan-out, because every new module
   inherits the missing indexes and the useless one.
2. F11 (idempotency scoping) — before the inventory ledger, per your own "must be solved before
   this stage."
3. F4 (release-load cache) — fan-out multiplies release size, and this cost is per-request ×
   per-artifact.
4. F7, F9, F10, F5, F6 (round trips) — mechanical, no contract change.
5. F12 (advisory namespace) — cheap, and it prevents a very confusing incident.

F1–F3 and F11 are contract-touching (compiler storage planner and a migration), so they want
packets. F4–F10 and F12 are internal to the provider.
