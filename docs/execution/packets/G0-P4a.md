# G0-P4a — PostgreSQL migration and schema-drift harness

Status: accepted
Tier: Critical
Frozen candidate: `399e6098e1b06dd68d20b7280f904b6baa131858`

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

- Gates are green at the frozen candidate.
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

## Outcome

The repository now owns a digest-pinned disposable PostgreSQL 16.14 harness,
an ordered transaction-owned migration runner, immutable migration-history
verification, and a checked-in physical-schema snapshot. Empty, prior-state,
concurrent, failed, edited, missing, gapped, self-transactional, and physically
drifted cases are covered without introducing tenant context ahead of G0-P4b.

## Gate evidence

| Gate | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | PASS; all 11 workspaces already up to date |
| `corepack pnpm check:schema` | PASS; 1 migration applied, 1 verified, schema drift check passed |
| `corepack pnpm test:postgres` | PASS; 6 tests |
| `corepack pnpm check:boundaries` | PASS; 19 files scanned |
| `corepack pnpm test:architecture` | PASS; 7 tests |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS |
| `corepack pnpm build` | PASS |
| `corepack pnpm test` | PASS; unit 1, integration 1, architecture 7, PostgreSQL 6, browser 1 intentional skip |
| `git diff --check main...HEAD` | PASS; no output |
| Owned paths and salvage admission | PASS; exactly the 14 declared paths and a complete PORT record |

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

## Review and adjudication evidence

Writer: Codex orchestrator, Critical tier.

- The review charter was limited to accidental cross-tenant leakage and
  migration drift by honest code. Adversarial obfuscation and evasion were out
  of scope.
- Fresh Codex `gpt-5.6-sol` xhigh reviews found the plain `END`, `ABORT`, and
  `START TRANSACTION` aliases and an inaccurate salvage description. The SQL
  aliases were fixed and covered by negative fixtures before candidate
  `755defb` was frozen.
- The bounded convergence review of `755defb` found one remaining
  documentation-only contradiction: the salvage record said initialization
  was inside the quarry helper's `try/finally`, while its known-defect section
  correctly said initialization preceded it.
- On 2026-07-21 the user adjudicated that finding as valid, authorized only the
  corrective salvage-record sentence, and substituted orchestrator
  verification for another review round. Candidate `399e609` contains exactly
  that sentence correction relative to `755defb`; `git diff` reports no code,
  configuration, test, or other documentation change.
- The complete gate set was re-run and passed on `399e609`. Acceptance follows
  the user's explicit adjudication; no unrecorded review exception is implied.
