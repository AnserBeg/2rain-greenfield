# G0-P4b — Trusted request context and tenant isolation

Status: evidence_ready
Tier: Critical
Frozen candidate: `64458dc55199bc3c5277b62dd22d7cc666823c6a`

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

- Gates are green at the frozen candidate.
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

## Outcome

The runtime now issues immutable trusted context only through an authenticated
request-entry adapter. PostgreSQL accepts that context only on the exact
unprivileged runtime login, rejects unsafe role-capability drift, applies
tenant/environment/principal/request settings transaction-locally, and uses a
force-RLS two-tenant fixture to fail closed on absent or mismatched context.
The same physical pooled connection is proven clean after success and rollback.

## Gate evidence

| Gate | Result |
|---|---|
| `corepack pnpm install --frozen-lockfile` | PASS; all 11 workspaces already up to date |
| `corepack pnpm check:schema` | PASS; 2 migrations applied, 2 verified, schema drift check passed |
| `corepack pnpm test:postgres` | PASS; 8 tests |
| `corepack pnpm check:boundaries` | PASS; 22 files scanned |
| `corepack pnpm test:architecture` | PASS; 7 tests |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS |
| `corepack pnpm build` | PASS |
| `corepack pnpm test` | PASS; unit 1, integration 1, architecture 7, PostgreSQL 8, browser 1 intentional skip |
| `git diff --check main...HEAD` | PASS; no output |
| Owned paths and authority | PASS; exactly the 13 declared paths, ADR-0004 remains the sole identity authority, and no quarry identity code was reused |

Pre-freeze gate note: the first complete PostgreSQL run exposed an existing CLI
assertion hard-coded to one verified migration. It was changed to the loaded
migration-stream length, added to owned paths, and the complete gate set was
rerun green before review.

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

## Review evidence

Writer: Codex orchestrator, Critical tier.

- The mandatory charter bounded both reviewers to accidental, reachable
  cross-tenant leakage and pooled-context contamination by honest code.
  Adversarial evasion and all `RequestRuntimeView`/release-pinning work were
  explicitly out of scope.
- Fresh Codex `gpt-5.6-sol` xhigh round one returned REVISE on candidate
  `f5ce57d`: a correctly named runtime role altered to `BYPASSRLS` or
  `SUPERUSER` would pass a name-only check. The wrapper now verifies the full
  safe role-capability set inside every transaction, and a same-name
  `BYPASSRLS` negative test proves rejection.
- After all gates were rerun, fresh Codex `gpt-5.6-sol` xhigh round two returned
  PASS on unchanged candidate `64458dc`, with no findings or nonblocking notes.
- Fable max then returned PASS on the identical unchanged `64458dc`. Its
  nonblocking observations were triaged as fail-closed or later-stage work:
  swallowed-query false-success semantics belongs to the T-01 transaction
  substrate; production credential/auth integration and module-packaging
  concerns belong to later integration; and the argument-casing and
  same-environment-write test-polish notes cannot create trusted identity or a
  cross-tenant path in this packet.
- No code, configuration, migration, schema, or test changed after the passing
  Codex and Fable reviews.
