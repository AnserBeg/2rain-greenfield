# ADR-0003: PostgreSQL launch provider

Date: 2026-07-21
Status: accepted
Tier: Critical (review per `review-tiers`)

## Context

The launch needs typed relational storage, transactions, constraints,
concurrency control, tenant isolation, and durable outbox behavior. Pretending
to support several databases before one provider passes those obligations
would weaken the product and create abstractions without evidence.

## Decision

PostgreSQL is the only supported launch storage provider. Its registered
adapter is the sole physical persistence authority for launch. Physical schema
changes enter that provider only through one ordered migration stream composed
from checked-in platform migrations and compiler-emitted release migration
artifacts.

The canonical package model, semantic query/operation contracts, and logical
domain identifiers remain provider-neutral. They must not expose PostgreSQL
table names, SQL, ORM types, or provider-specific error shapes. Provider code
implements declared storage ports; it does not redefine domain meaning.

Launch storage uses typed relational tables, explicit indexes and constraints,
additive migrations, append-only trust tables, and rebuildable derived read
models. Generated extension storage retains declared types. Loose JSON/EAV,
tenant-authored DDL, and runtime provider switching are not fallback paths.

Additional providers are unsupported until a later capability cell names their
adapter, migration, isolation, recovery, performance, and conformance evidence.

## Consequences

- PostgreSQL-specific correctness and operations can be tested directly.
- Portability lives at stable contracts and ports, not a lowest-common-
  denominator runtime abstraction.
- Schema changes require the ordered migration stream and empty/prior-state
  provider tests; ORM push/sync and hand-applied DDL are forbidden.
- A second provider requires an explicit stage/packet and cannot be claimed by
  interface shape alone.

## Evidence

- Plan sections 2.3, 4.2, 7.1, and 11.3 select PostgreSQL and exclude
  multi-provider launch abstraction.
- G0's salvage map admits only the ephemeral-database test pattern, adapted to
  PostgreSQL; it does not admit the prior persistence implementation.

## Enforcement

G0-P4 must provide ephemeral PostgreSQL and migration tests against empty and
previously migrated databases. G0-P3 must prevent provider imports into
canonical contracts, the compiler, and domain packages. Provider support stays
`unsupported` until its complete capability cell passes the required gates.
