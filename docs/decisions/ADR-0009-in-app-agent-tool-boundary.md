# ADR-0009: In-app agent tool boundary

Date: 2026-07-21
Status: accepted
Tier: Critical (review per `review-tiers`)

## Context

An in-app agent must operate the ERP through the same governed semantics a
human uses. Giving the model raw database, shell, source, action-registry, or
activation tools would bypass release pinning, policy, domain invariants,
confirmation, audit, and verification.

## Decision

The compiled `OperationsAgentToolProfile` is the sole authority for ERP
business tools exposed to the operations model. It contains exactly five
stable host tools:

1. `erp_discover` for bounded, policy-filtered catalog/context discovery;
2. `erp_query` for authorized registered Semantic Queries;
3. `erp_plan` for non-mutating typed operation plans and predicted effects;
4. `erp_execute` for approved Semantic Operation plan execution; and
5. `erp_verify` for declared read-back, job status, and reconciliation.

The profile is derived from the pinned `TenantRelease` and filtered by current
authorization. `TenantRelease` remains the authority for the profile's compiled
identity and content; the profile is the exclusive exposure contract at the
model boundary, not a peer application-definition authority. It grants no
business authority of its own: `erp_query` enters `SemanticQueryGateway`; plan
execution enters `SemanticOperationGateway`; and verification reads the same
registered models shown to users. Final-answer production and UI navigation
are host capabilities, not additional ERP business tools.

The operations model never receives raw database or SQL tools, shell/process
tools, source-editing or repository tools, arbitrary HTTP, package installation,
physical module actions, storage names, compiler primitives, overlay/revision
internals, free-form business writes, administrative activation, physical
purge, support-only actions, or dangerous unplanned operations. It never
selects tenant, environment, release, principal, permission, handler, table,
transaction boundary, risk class, or verification implementation.

Reporting and customization are separate governed lanes. The customization
lane may propose semantic patches and candidates but cannot approve or
activate them. Adding a module changes bounded discovery/catalog content; it
does not add a sixth operations-agent tool. Agent SDKs and model providers stay
behind adapters and cannot expand this profile.

This decision governs product-embedded agents. Repository development agents
remain governed by repository doctrine and are not runtime ERP principals.

## Consequences

- Tool-schema size stays constant as modules grow.
- The agent cannot acquire a capability unavailable through compiled contracts
  and current human-visible policy.
- Capability gaps are explicit results and route to the customization lane;
  the model does not improvise a bypass.
- Every accepted agent mutation is attributable, confirmed when required, and
  verified through ordinary product semantics.

## Evidence

- Plan sections 3, 5.7-5.10, 9.1-9.5, 10.1, and 11.3 bind the five-tool
  protocol, separate lanes, and prohibited paths.
- ADR-0005 already drops the prior framework and broad action-registry model.

## Enforcement

G0-P3 must scan manifests, source, compiled catalogs, and model-facing schemas
for forbidden tools and a sixth ERP business tool. G1 must emit a fail-closed
profile from the pinned release. Agent contract tests and real-model
evaluations must prove no raw access, caller-selected authority, self-activation,
or success without declared verification.
