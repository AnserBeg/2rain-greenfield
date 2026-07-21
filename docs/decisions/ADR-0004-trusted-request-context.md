# ADR-0004: Trusted tenant and request context

Date: 2026-07-21
Status: accepted
Tier: Critical (review per `review-tiers`)

## Context

Tenant isolation, current authorization, and release consistency fail if a
caller, model, form, query argument, or process-global default can choose
tenant or application context. Every request and deferred unit of work needs a
single trustworthy context that separates pinned application definition from
current deny-capable policy.

## Decision

The authenticated request-entry adapter is the sole source of trusted
`tenantId`, `environmentId`, and principal identity. The current Identity and
Policy gateways are the sole current-authorization authority.

At entry, the runtime uses the trusted tenant/environment key to read the
`ActiveReleasePointer` governed by ADR-0001, then constructs one immutable
`RequestRuntimeView` containing:

- trusted tenant and environment identity;
- pinned release identity and content hash;
- current principal and policy version; and
- the release's catalog, query, operation, surface, and agent projections.

The view pins application definition for the request; it does not own or
select the active release. Authorization remains current and may deny an
operation even when its application definition is pinned. Jobs, workers,
agent runs, operation plans, caches, and report snapshots carry equivalent
explicit context and may not fall back to ambient process state.

Tenant, environment, release, principal, or policy identity supplied by a
browser field, model output, semantic-query arguments, operation input,
tenant-authored code, or model prompt is untrusted and ignored or rejected.
PostgreSQL transaction-local context and row-level security are defense in
depth, not the source of tenant identity.

## Consequences

- A request cannot observe two application releases.
- Connection-pool reuse and deferred execution need explicit context-reset and
  leakage tests.
- Release changes force stale plans to replan; policy changes can deny current
  execution immediately.
- There is no default tenant, default environment, or global release fallback.

## Evidence

- Plan sections 1, 3, 5.4, 7.2, and 11.3 define request pinning and trusted
  current context.
- The plan's G0 and G1 gates require two-tenant evidence and an explanation of
  request pinning without future work.

## Enforcement

G0-P4 must establish a two-tenant fixture. G1 must test request pinning,
compare-and-swap release changes, current-policy denial, and lack of ambient
fallback. Later provider and gateway suites must include cross-tenant inputs,
connection reuse, jobs, caches, and agent execution.
