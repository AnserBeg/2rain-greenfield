# ADR-0005: Drop `@agent-native/core`

Date: 2026-07-21
Status: accepted
Tier: Critical (review per `review-tiers`)

## Context

The prior repository uses `@agent-native/core` for identity, action registry,
and application state. Plan section 1.2 requires an explicit keep-or-drop
decision because that choice controls whether identity and action plumbing are
ported. The accepted G0-P1a scaffold is framework-free and already omits the
package, so leaving the decision implicit would create an architectural trap.

## Decision

Drop `@agent-native/core` from the greenfield product.

- Do not add it as a runtime, development, peer, optional, transitive, or
  patched dependency.
- Do not create a compatibility adapter, facade, or mirrored registry for its
  identity, application-state, or action contracts.
- Trusted identity and current authorization belong to the adapters and
  gateways governed by ADR-0004.
- Desired state, compiled releases, and active-version selection belong to the
  authorities governed by ADR-0001.
- Business reads and effects will enter through the Semantic Query and
  Semantic Operation gateways decided in the later constitutional tranche;
  no broad physical-action registry is substituted here.
- Agent orchestration will live behind the repository-owned agent-runtime seam
  and consume compiler projections; a model framework will not become business
  or application authority.

The prior package may be consulted only as the plan's declared framework
context. No code or runtime contract from it is admitted by this ADR. Any later
proposal to adopt it or an equivalent framework requires a superseding ADR and
must prove that it does not duplicate the canonical, release, identity,
gateway, or policy authorities.

## Consequences

- Identity and action plumbing needed by the greenfield product is implemented
  against repository-owned contracts rather than ported wholesale.
- The scaffold and lockfile accurately express the architectural decision.
- Useful behavior from the prior repository must be separately admitted as
  PORT, RE-EXPRESS, or REFERENCE under plan section 1.2.
- Adopting an agent SDK later remains possible at the adapter boundary, but it
  cannot own application state, identity, policy, or business operations.

## Evidence

- Plan sections 0, 1.2, 3, 4.2-4.4, and 11.3 forbid competing authorities and
  require the framework decision.
- G0-P1a candidate `856f90c` contains no `@agent-native/core` dependency and
  uses a repository-owned workspace graph.
- G0-P6b recorded that relaxed replay of the old repository removed the prior
  `@agent-native/core` lockfile patch; that replay limitation is context, not a
  reason to import the framework.

## Enforcement

The lockfile and all package manifests must remain free of
`@agent-native/core`. G0-P3 must add dependency and model-facing scans that
reject the package, compatibility shims, framework-owned application state,
and broad physical-action registries. Reviewers reject any new dependency that
would become a peer authority.
