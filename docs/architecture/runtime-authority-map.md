# Runtime authority map

Status: G0-P2a and G0-P2b accepted
Date: 2026-07-21

This map assigns every concern in the two constitutional ADR tranches to one
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
| Permission to attempt release activation | `ReleaseApproval` | ADR-0006 | Authors, builders, compilers, verification workers, release executor |
| On-hand inventory quantity | Posted `InventoryMovement` facts | ADR-0007 | Source documents, balances, caches, reports, UI fields |
| Reserved inventory quantity | Active `Reservation` facts | ADR-0007 | Sales-order progress, availability caches, reports, UI fields |
| Available inventory quantity | Registered `inventory.availability` read model | ADR-0007 | UI, reports, agent answers, search and cache projections |
| Normal business-read ingress and mediation | `SemanticQueryGateway` | ADR-0008 | UI, API, agents, workflows, reports, imports, connectors |
| Business-write/effect ingress and mediation | `SemanticOperationGateway` | ADR-0008 | UI, API, agents, workflows, imports, connectors, registered handlers |
| In-app operations-agent ERP tool surface | Compiled `OperationsAgentToolProfile` | ADR-0009 | Model provider, agent SDK, module catalog entries, conversation host |
| Cross-channel invocation evidence | `ActionInvocation` | ADR-0010 | Domain events, agent traces, HTTP logs, operation evidence |
| Cross-cutting accepted-mutation audit | `BusinessChangeDocument` | ADR-0010 | Domain events, specialist ledgers, activity views, reports |
| Generic archive/restore execution | Shared `LifecycleService` | ADR-0010 | Entity handlers, UI, agents, query defaults |
| Cross-cutting correction lineage | Immutable domain `CorrectionLink` | ADR-0010 | Change documents, activity views, reconciliation reports |
| Recovery orchestration | Shared `RecoveryService` | ADR-0010 | Backup provider, rebuilders, outbox reconciler, release service, runbooks |

## Explicit non-authority decision

| Concern | Decision | Owning decision | Consequence |
|---|---|---|---|
| Greenfield framework disposition | DROP `@agent-native/core` | ADR-0005 | No replacement framework authority; responsibilities remain with ADR-0001, ADR-0004, and ADR-0008 |
| Direct in-app agent access to database, shell, source, activation, purge, or free-form writes | FORBIDDEN | ADR-0009 | All supported agent reads and effects use the five-tool profile and semantic gateways |
| Ordinary physical deletion of business data | FORBIDDEN | ADR-0010 | Archive/restore or named correction/reversal applies; purge remains unsupported |

## Document ownership boundaries

| Document | Owns | Must not claim |
|---|---|---|
| ADR-0001 | Desired state, deployable definition, active-version selection | Request identity, current policy, storage schema, package dependency direction |
| ADR-0002 | Deployment topology, composition roots, package dependency direction | Domain data, release selection, request identity, storage schema |
| ADR-0003 | Launch provider and physical schema authority | Domain semantics, tenant identity, release selection, authorization |
| ADR-0004 | Trusted request identity, current authorization, request-view construction | Desired state, active-version selection, compiled projections, physical schema, business operations |
| ADR-0005 | The framework DROP decision; no replacement runtime authority | Replacement ownership already assigned to ADR-0001, ADR-0004, or ADR-0008 |
| ADR-0006 | Human approval that permits an exact activation attempt | Active-version truth, current authorization, release content, autonomous approval |
| ADR-0007 | Inventory quantity facts, availability derivation, posting and inventory-correction invariants | Source-document lifecycle, gateway mediation, cross-cutting audit/recovery |
| ADR-0008 | Normal business read/write gateway ingress, validation, policy mediation, and dispatch | Business facts, domain invariants, trusted identity, agent tool policy |
| ADR-0009 | In-app operations-agent tool exposure and prohibited tool paths | Business data/effects, policy, activation approval, domain invariants |
| ADR-0010 | Invocation/change evidence, generic lifecycle, correction lineage, recovery orchestration | Domain ledger semantics, inventory math, active-version truth, current identity/policy |

References between these documents describe handoffs only. A consumer may
carry, render, cache, or enforce information from an authority; that does not
make the consumer a second source of truth.

## Constitutional coverage

ADR-0001 through ADR-0010 are accepted and cover both constitutional tranches.
The north-star plan remains supreme over every refinement in this map.

## Review checklist

For each row in the one-owner map, verify that:

1. there is exactly one concern and one named authority;
2. the owning ADR makes that authority exclusive and detectable;
3. every other named component is only a producer, adapter, or consumer; and
4. no ADR assigns the concern to another authority.

Then verify that the framework-disposition row creates no new authority.

For the G0-P2b extension, also verify that:

1. `ReleaseApproval` is atomically claimed for one exact, idempotently resumable
   attempt and never competes with `ActiveReleasePointer` for active-version
   truth;
2. movement/reservation facts own quantities while availability and all other
   balances remain registered, rebuildable projections;
3. semantic gateways own ingress and mediation but not business facts,
   derived semantics, domain invariants, or trusted identity;
4. the five-tool agent profile exposes governed capabilities but grants no
   peer application-definition authority and no direct data, effect,
   activation, purge, shell, or source authority;
5. `BusinessChangeDocument` is cross-cutting audit evidence, not a replacement
   for inventory movements, domain events, release history, or agent evidence;
6. generic lifecycle, domain correction, and recovery remain distinct;
7. correction preserves the original fact and an immutable lineage link; and
8. no ordinary hard-delete or silent recovery path exists, and recovery cannot
   restore an active pointer without ADR-0006 approval, current-policy recheck,
   compare-and-swap, and read-back.
