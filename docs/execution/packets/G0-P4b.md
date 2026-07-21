# G0-P4b — Trusted request context and tenant isolation

Status: active
Tier: Critical

## Goal and scope

Establish one authenticated request-entry adapter as the only constructor of
trusted tenant, environment, and principal identity. Bind that immutable
context transaction-locally in PostgreSQL, enforce a tenant/environment RLS
fixture, and prove that a reused pooled connection cannot retain identity from
the prior request.

Owned paths:

- `packages/runtime/package.json`
- `packages/runtime/src/request-context.ts`
- `packages/postgres-provider/package.json`
- `packages/postgres-provider/src/migrations.ts`
- `packages/postgres-provider/src/request-context.ts`
- `pnpm-lock.yaml`
- `db/migrations/0002_trusted_request_context.sql`
- `db/schema.snapshot.json`
- `test/postgres/migrations.test.ts`
- `test/postgres/tenant-isolation.test.ts`
- `docs/execution/doctrine-coverage.md`
- `docs/execution/packets/G0-P4b.md`
- `docs/execution/ledger.md`

Out of scope: `RequestRuntimeView`, release lookup or pinning, active-release
pointers, current policy decisions, production authentication-provider
integration, jobs/deferred execution, business-domain tables, adversarial
obfuscation/evasion, and any G0 stage-gate claim.

## Threat model and review charter

- Gates must be green before review.
- Threat model: accidental cross-tenant leakage and pooled-connection context
  contamination introduced by honest developers or AI writers. These are real,
  reachable failures, so the scoped isolation and cleanup paths require
  thorough review.
- In scope: tenant A cannot read tenant B's fixture; tenant, environment, and
  principal identity comes only from the authenticated request-entry adapter,
  never caller-supplied headers or arguments; PostgreSQL context is
  transaction-local and fails closed when absent; successful and failed
  requests reset a reused pooled connection before the next request.
- Out of scope: adversarial obfuscation/evasion and `RequestRuntimeView` or
  release pinning, which begin in G1. P4b builds only the trusted context those
  later components consume.
- Decisive questions: can an ordinary request or direct query observe or write
  another tenant/environment's fixture; can plain caller-supplied identity
  replace authenticated identity; and can success, rollback, or sequential
  pool reuse expose the prior request's tenant, environment, or principal?

## Required gates

- `corepack pnpm install --frozen-lockfile`
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
- owned-path and authority review

## Salvage disposition

No prior-repository identity helper is reused. G0-P4a already rejected those
helpers as authentication authority; this packet is implemented independently
from the accepted plan and ADR-0004.

## Runnable exit

The PostgreSQL suite creates two tenants and environments, enters requests
through authenticated identity, proves RLS isolation, reuses one physical
connection across tenant success and failure paths, and leaves the connection
with no tenant, environment, principal, role, or transaction context.

## Test it yourself

```bash
cd /home/rvham/2rain-greenfield
corepack pnpm check:schema
corepack pnpm test:postgres
```

Expect schema migration and drift checks to pass. The PostgreSQL suite must
show passing trusted-entry, two-tenant read/write isolation, missing-context,
and successful/failed single-connection pool-reuse tests.
