# G0-P4a salvage admission — ephemeral database test pattern

Date: 2026-07-21
Mode: PORT
Target: G0-P4a ephemeral PostgreSQL and migration/schema-drift harness

## Source

Prior repository `/home/rvham/2rain_erp`, branch `chess`, commit
`668a60bb3912a2df0b66f098b4c47ff8fe1396a6`:

- `tests/helpers/test-db.ts`

The source was read from the commit object rather than the quarry working tree,
which contains unrelated user changes. No prior-repository file was modified.

## Verified evidence

The source demonstrates one helper owning database creation, initialization,
callback execution, and cleanup in a `try/finally`; unique test identity; and
test state kept outside watched repository paths. It targets SQLite, mutates
global `DATABASE_URL`, imports the old persistence implementation, and deletes
database files directly. It was inspected but not executed because the
accepted G0-P6b replay records that the quarry does not clean-install under the
supported toolchain.

The greenfield port independently proves its PostgreSQL expression with a
pinned disposable container, transaction-owned migrations, empty/prior-state
tests, concurrent runner calls, negative drift fixtures, and cleanup.

## KEEP

| Technique | Reason |
|---|---|
| One helper owns setup, callback, and `finally` cleanup | Prevents test resources escaping their scope |
| Unique per-run resource identity | Allows isolated and concurrent test execution |
| Initialize before handing control to the test | Tests never observe a half-created database |
| Keep disposable database state outside the repository | Avoids watched files and accidental evidence commits |

## REWRITE

| Prior technique | Greenfield expression |
|---|---|
| Temporary SQLite file | Pinned PostgreSQL 16.14 container with tmpfs data |
| Global `DATABASE_URL` mutation | Explicit `pg` connection configuration passed to the callback |
| Import old application migration plugin | Provider-owned ordered SQL migration runner |
| File deletion | Container removal in `finally` |
| Successful initialization as sufficient evidence | Empty/prior-state, concurrency, rollback, history-drift, and physical-schema checks |

## REJECT

| Prior material | Reason |
|---|---|
| SQLite provider and WAL/file cleanup details | ADR-0003 selects PostgreSQL only |
| Old Drizzle schema and persistence imports | Persistence implementation is not admitted by the G0 salvage map |
| Process-global database selection | Creates ambient state and conflicts with trusted-context doctrine |
| Preserved test database escape hatch | G0-P4a evidence is deterministic and containers must not linger |
| Old identity helpers | Trusted tenant/request context belongs to G0-P4b and must be designed from accepted ADR-0004 |

## Invariants that must survive

1. Each ephemeral database has a collision-resistant identity and explicit
   lifetime.
2. Initialization completes before test code receives the connection.
3. Cleanup runs after success or failure and does not depend on repository
   file deletion.
4. No credential, provider fallback, or default tenant enters source or
   fixtures.
5. The prior repository remains a read-only quarry, never a runtime or test
   dependency.

## Known defects that must not carry

- SQLite behavior presented as PostgreSQL evidence;
- mutation of process-global database configuration;
- application imports that hide migration ownership;
- test databases under repository-watched paths;
- initialization outside the source helper's `try/finally`, which can leak a
  database file when initialization itself fails;
- tenant identity helpers treated as authenticated request context.

## Admission gates

- `corepack pnpm check:schema`
- `corepack pnpm test:postgres`
- `corepack pnpm check:boundaries`
- `corepack pnpm typecheck`
- `corepack pnpm lint`
- `corepack pnpm build`
- `corepack pnpm test`
- clean owned-path and whitespace checks

## Rollback

Before integration, remove the PostgreSQL provider package, checked-in
migration/snapshot, ephemeral helper and tests, root scripts/dependencies,
admission and packet records, ledger split, and doctrine-map routing updates.
No persistent database, prior-repository file, or external service requires
rollback; each test container is disposable.
