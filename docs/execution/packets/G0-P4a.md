# G0-P4a — PostgreSQL migration and schema-drift harness

Status: active
Tier: Critical

## Goal and scope

Provide a pinned, ephemeral PostgreSQL test harness and one ordered migration
runner that proves checked-in migrations apply to both empty and previously
migrated databases. Add deterministic migration-history and physical-schema
drift checks so honest migration mistakes fail locally and in the canonical
test suite.

Owned paths:

- `package.json`
- `pnpm-lock.yaml`
- `packages/postgres-provider/package.json`
- `packages/postgres-provider/src/*.ts`
- `db/migrations/*.sql`
- `db/schema.snapshot.json`
- `test/helpers/postgres.ts`
- `test/helpers/check-schema.ts`
- `test/postgres/migrations.test.ts`
- `docs/decisions/salvage/g0-p4a-ephemeral-postgres-pattern.md`
- `docs/execution/doctrine-coverage.md`
- `docs/execution/packets/G0-P4a.md`
- `docs/execution/ledger.md`

Out of scope: trusted request-context construction, tenant-selected queries,
row-level security, two-tenant and connection-pool reuse isolation (G0-P4b),
release pinning/activation (G1), business-domain tables, runtime gateways, CI
workflow files, backup/recovery, and any G0 stage-gate claim.

## Threat model and review charter

- Gates already green: to be frozen with the candidate before review.
- Threat model: accidental cross-tenant leakage and migration drift introduced
  by honest developers or AI writers. No hostile insider is assumed.
- In scope for this tranche: plain migration invariants — one ordered stream,
  transactional application, immutable applied files, empty/prior-state
  upgrades, deterministic physical-schema comparison, isolated ephemeral test
  databases, and reliable cleanup. P4a must not create an ambient/default
  tenant mechanism that would undermine P4b.
- Out of scope: adversarial obfuscation/evasion; application tenant context,
  RLS and pool-reuse isolation behavior assigned to G0-P4b; operational
  backup/restore and production deployment automation.
- Decisive questions: can an empty database and a previously migrated database
  reach the same checked-in schema; do edited, missing, out-of-order, or
  manually drifted schemas fail deterministically; and can parallel or failed
  test runs leak persistent containers or database state into another test?

## Required gates

- `corepack pnpm check:schema`
- `corepack pnpm test:postgres`
- `corepack pnpm check:boundaries`
- `corepack pnpm test:architecture`
- `corepack pnpm typecheck`
- `corepack pnpm lint`
- `corepack pnpm format`
- `corepack pnpm build`
- `corepack pnpm test`
- `git diff --check main...HEAD`
- owned-path and salvage-admission review

## Runnable exit

The canonical test command starts a disposable, pinned PostgreSQL container,
applies and verifies the checked-in migration stream, exercises negative drift
fixtures, and removes the container. The migration CLI requires an explicit
`DATABASE_URL`; it never invents credentials or a default database.

## Test it yourself

```bash
cd /home/rvham/2rain-greenfield
corepack pnpm check:schema
corepack pnpm test:postgres
```

Expect both commands to exit zero. The schema check should report the applied
migration count and `schema-drift: PASS`; the test command should prove empty
and prior-state upgrades plus plain migration-history and physical-schema drift
failures against disposable PostgreSQL.
