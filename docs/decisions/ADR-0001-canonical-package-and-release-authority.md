# ADR-0001: Canonical package and release authority

Date: 2026-07-21
Status: accepted
Tier: Critical (review per `review-tiers`)

## Context

The product needs one definition path for first-party packages, generated
packages, and tenant customization. The plan forbids the prior repository's
static-metadata-plus-overlay lineage and any deployment-global activation
pointer. Without a single authority, the UI, agent, compiler, and business
runtime could disagree about what application is active.

## Decision

The following authorities are exclusive:

- `AppPackageRevision` is the sole application desired-state authority. Each
  revision is complete, versioned, immutable after submission, and includes
  first-party and tenant-authored definitions in one canonical graph.
- `TenantRelease` is the sole deployable-application authority. It is an
  immutable compiler output for exactly one tenant and environment, with a
  minted release identity, content hash, artifact set, capability resolution,
  and verification evidence.
- `ActiveReleasePointer`, keyed by trusted tenant and environment, is the sole
  active-version authority. Activation changes it with compare-and-swap and
  records history; rollback selects a prior immutable release.

Compiled catalogs, caches, surfaces, agent projections, and
`RequestRuntimeView` are consumers of a pinned `TenantRelease`. They never
become peer authorities. Labels, routes, table names, physical action files,
content hashes, overlays, and process-global variables never select or identify
the active application.

## Consequences

- First-party and customized application definitions use the same compiler and
  release lifecycle.
- Identical content in different tenants still has distinct release,
  approval, activation, rollback, and evidence identities.
- Activation must use trusted tenant/environment context, compare-and-swap,
  read-back, cache invalidation, and active verification.
- A change observed after an operation is planned produces a recoverable stale
  release result and requires replanning.
- Compatibility overlays and independently active registries are forbidden.

## Evidence

- Plan sections 0, 1, 3, 4.1, and 11.3 bind the single-authority model.
- Plan section 1.2 rejects the prior repository's overlay lineage and
  deployment-global activation pointer.

## Enforcement

G1 must implement immutable revisions/releases, deterministic compilation,
tenant/environment-scoped compare-and-swap activation, request pinning, and
rollback tests. G0-P3 dependency tests must reject alternate manifest,
overlay, or activation authorities. Until those executable gates land, review
of the [runtime authority map](../architecture/runtime-authority-map.md) is the
G0 enforcement point.
