# ADR-0002: Modular monolith and dependency direction

Date: 2026-07-21
Status: proposed
Tier: Critical (review per `review-tiers`)

## Context

The launch product needs rapid cross-domain change and atomic business
transactions while preserving seams that can be tested and, if evidence later
requires it, deployed separately. Premature services or framework-owned module
registries would add distributed authority before the inventory loop exists.

## Decision

Launch as one repository and one deployable modular monolith:

- the web/API process and worker are composition roots;
- contracts define stable schemas, identifiers, DTOs, ports, and errors;
- compiler, domain, platform runtime, surface runtime, agent runtime, and
  customization runtime are logical package seams;
- domain packages own business invariants and depend inward on contracts and
  declared ports;
- applications assemble packages and adapters but never own business rules;
  and
- cross-domain effects pass through declared application/domain ports and the
  transactional outbox, not direct table writes.

The dependency direction is:

```text
contracts <- compiler
contracts <- domain packages
contracts <- platform runtimes
packages <- application composition roots
```

Compiler and domain packages must not import React, model SDKs,
ORM/PostgreSQL implementations, route files, or physical action names. A
package boundary is not a network boundary. A seam may become a separate
deployment only after measured scale, isolation, security, ownership, or
availability evidence and a superseding ADR.

## Consequences

- Launch operations can remain transactional without distributed coordination.
- Provider and framework choices stay at adapters and composition roots.
- Package APIs and dependency checks are required even though deployment is
  consolidated.
- Teams cannot create a service, route, registry, or framework for each module.

## Evidence

- Plan sections 3, 4.2-4.4, and 11.3 require a modular monolith with explicit
  deployable seams.
- The G0 salvage map admits the prior repository's structural-test technique,
  but requires new rules for this package graph.

## Enforcement

G0-P3 will make forbidden dependency edges fail CI. Before that checker lands,
the repository topology and imports are reviewed against this ADR and the
[runtime authority map](../architecture/runtime-authority-map.md). Any new
deployment boundary requires a superseding ADR with the evidence named above.
