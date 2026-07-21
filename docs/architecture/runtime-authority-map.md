# Runtime authority map

Status: proposed by G0-P2a
Date: 2026-07-21

This map assigns every concern in the first constitutional ADR tranche to one
named authority and one owning decision. It refines, but cannot override, the
program authority in `docs/greenfield-north-star-erp-platform-plan.md`.

## One-owner map

| Concern | Sole named authority | Owning decision | Consumers that are not authorities |
|---|---|---|---|
| Application desired state | `AppPackageRevision` | ADR-0001 | Builder drafts, package editors, compiler input loaders |
| Deployable application definition | `TenantRelease` | ADR-0001 | Compiled catalogs, surfaces, agent projections, caches |
| Active application version per tenant/environment | `ActiveReleasePointer` | ADR-0001 | `RequestRuntimeView`, activation UI, cache invalidators |
| Package dependency direction | ADR-0002 dependency graph | ADR-0002 | Workspace layout, package manifests, application imports |
| Deployable assembly | Web/API and worker composition roots | ADR-0002 | Domain packages, runtime packages, route adapters |
| Launch storage provider | Registered PostgreSQL adapter | ADR-0003 | Domain storage ports, query/operation handlers |
| Launch physical schema changes | Ordered PostgreSQL migration stream | ADR-0003 | Checked-in platform migrations, compiler-emitted release migration artifacts, ORM mappings, provider tests |
| Tenant/environment/principal identity at request entry | Authenticated request-entry adapter | ADR-0004 | Browser fields, model output, request arguments, database session context |
| Current authorization | Identity and Policy gateways | ADR-0004 | Pinned releases, request views, domain handlers, UI and agent projections |
| Request-scoped trusted context envelope | `RequestRuntimeView` | ADR-0004 | UI, query, operation, agent, report, and cache consumers; all application projections remain owned by the pinned `TenantRelease` |

## Explicit non-authority decision

| Concern | Decision | Owning decision | Consequence |
|---|---|---|---|
| Greenfield framework disposition | DROP `@agent-native/core` | ADR-0005 | No replacement framework authority; responsibilities remain with ADR-0001, ADR-0004, and the later gateway ADR |

## Document ownership boundaries

| Document | Owns | Must not claim |
|---|---|---|
| ADR-0001 | Desired state, deployable definition, active-version selection | Request identity, current policy, storage schema, package dependency direction |
| ADR-0002 | Deployment topology, composition roots, package dependency direction | Domain data, release selection, request identity, storage schema |
| ADR-0003 | Launch provider and physical schema authority | Domain semantics, tenant identity, release selection, authorization |
| ADR-0004 | Trusted request identity, current authorization, request-view construction | Desired state, active-version selection, compiled projections, physical schema, business operations |
| ADR-0005 | The framework DROP decision; no replacement runtime authority | Replacement ownership already assigned to ADR-0001/0004 or the later gateway ADR |

References between these documents describe handoffs only. A consumer may
carry, render, cache, or enforce information from an authority; that does not
make the consumer a second source of truth.

## Reserved for the next constitutional tranche

G0-P2a does not decide inventory posting truth, Semantic Query/Operation
gateway ownership, human release-activation governance, agent tool
prohibitions, or lifecycle/audit/correction/recovery doctrine. The north-star
plan remains the sole authority for those concerns until their proposed ADRs
are reviewed and accepted in G0-P2b.

## Review checklist

For each row in the one-owner map, verify that:

1. there is exactly one concern and one named authority;
2. the owning ADR makes that authority exclusive and detectable;
3. every other named component is only a producer, adapter, or consumer; and
4. no ADR assigns the concern to another authority.

Then verify that the framework-disposition row creates no new authority.
