# ADR-0008: Semantic Query and Operation gateway ownership

Date: 2026-07-21
Status: proposed
Tier: Critical (review per `review-tiers`)

## Context

UI, API, agents, workflows, imports, reports, and future connectors must not
grow separate read/write architectures. Canonical definitions need one
policy-aware route to registered read models and invariant-preserving domain
handlers without exposing tables, routes, or physical action names.

## Decision

The `SemanticQueryGateway` is the sole ingress and mediation authority for
normal application business reads. It resolves a canonical `QueryDefinition`
from the request-pinned `TenantRelease`, validates typed arguments and limits,
applies current tenant/policy/field/classification rules, dispatches only to the
registered read model or protocol, and returns the common result envelope with
provenance, freshness, paging, truncation, and unsupported diagnostics.
Current authorization comes from the Identity and Policy gateways; the query
gateway enforces their decision but does not own policy.

The `SemanticOperationGateway` is the sole ingress and mediation authority for
business writes and effects. It resolves a canonical `OperationDefinition`
from the pinned release and mediates the plan/execute boundary: target
resolution, preconditions, predicted effects, risk, confirmation/approval
requirements, idempotency, concurrency, transaction selection, dispatch,
audit/outbox coupling, declared result, and read-back contract. It invokes the
Identity and Policy gateways for current authorization and validates exact
confirmation/approval grants; it never owns, mints, or broadens either.

The gateways mediate; they do not replace underlying authorities. Registered
read models own their derived semantics, and registered domain handlers own
business invariants. The pinned release owns query/operation contract identity,
ADR-0004 owns trusted context and current authorization, ADR-0007 owns
inventory quantity facts, and ADR-0010 owns cross-cutting evidence/lifecycle
contracts.

All first-party, generated, and tenant-authored modules use Q0-Q3 and O0-O3
through these gateways. A module may register a definition and binding but may
not add a platform route, top-level agent tool, private registry, direct table
read that drives business behavior, direct table write, generic state patch,
or caller-selected physical handler.

Provider migrations, backup restore, observability, and low-level health checks
are platform operations rather than normal business reads/writes. They remain
private administrative capabilities and cannot be exposed as bypasses to UI,
API, agent, workflow, import, report, or connector clients.

## Consequences

- Every supported business read and effect has one discoverable typed contract.
- Policy, limits, idempotency, concurrency, audit, and verification cannot vary
  by channel.
- New modules add catalog entries and registered bindings, not routes or tools.
- Unsupported semantics fail explicitly instead of falling through to SQL or a
  generic patch escape hatch.

## Evidence

- Plan sections 1, 3, 4, 5.7-5.10, 6.6-6.7, 9.2, 11.3, and 14.1 bind the two
  gateway model and distinguish gateway mediation from registered semantics.

## Enforcement

G0-P3 must reject forbidden imports, private action registries, direct
cross-domain table access, and new top-level ERP tools. G1 must implement empty
fail-closed gateways and pinned catalogs. Every later domain stage must run
gateway, policy, read-back, direct-access, and channel-parity tests.
