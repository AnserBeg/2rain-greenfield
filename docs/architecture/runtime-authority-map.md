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
| Business scoping within a tenant | Compiled `legalEntityId` on every business record | ADR-0015 | Query filters, reports, policy narrowing, UI selectors; it is a business dimension and never a tenancy/RLS axis |
| Stock identity (what a balance is keyed by) | The declared `northstar.stock-dimension-set` version stamped on each movement | ADR-0016 | Balance/availability read models, reports, agent answers, search projections |
| Item posting unit | The item's base unit, immutable once any movement references it | ADR-0016 | Document lines, conversions, UI displays |
| Business event time and system time | Distinct `effectiveAt` and `recordedAt` on every posted fact | ADR-0018 | Read models, exports, reconciliation, as-of queries; none may discard `recordedAt` |
| Whether a period accepts postings | The entity's `closedThrough` lock, evaluated inside the posting transaction | ADR-0018 | UI affordances, policy hints, agent plans |
| Cost at which stock entered | Immutable `goods_receipt_line` actual cost or explicit absence | ADR-0017 | Future valuation derivations; movements carry no amount and never become a subledger |
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
| Which rows belong to a tenant | The tenant completeness manifest and its fail-closed verifier | ADR-0019 | Export jobs, recovery tiers, retention/erasure processes, support tooling |
| How a live tenant's business rows change during recovery | `SemanticOperationGateway` compensating operations, under approval | ADR-0019 | Recovery service, operator scripts, support tools, migrations — none may issue live-tenant business DML |
| End-to-end publish cost and its two axes | The `publishPath` SLO family | ADR-0020 | Compiler budget, preparation, activation, approval UI; a component bound is never reported as the user-visible number |
| Whether a candidate's verification may be narrowed | A recorded impact analysis derived from the compiled diff | ADR-0020 | Latency budgets, schedules, authors, tenants — none may narrow verification |

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
| ADR-0015 | The legal-entity dimension's presence, immutability, and business-not-tenancy classification | Tenant/environment isolation, RLS or ABI key composition, policy evaluation, entity master lifecycle beyond its own module |
| ADR-0016 | Stock identity composition, dimension-set versioning and extension, base-unit immutability | Quantity authority (ADR-0007), storage mechanics (ADR-0011), which dimensions launch carries |
| ADR-0017 | Where received cost is captured, and that movements carry no amount | Valuation method, accounting truth, ledger posting, pricing |
| ADR-0018 | Effective/recorded separation, tenant business day, period-lock enforcement, bitemporal ledger completeness | Elapsed-time and deadline measurement (monotonic, AGENTS.md §6), effective-dated master data, business-calendar arithmetic |
| ADR-0019 | Tenancy classification of every table, the three recovery tiers, and the no-live-DML rule | Backup provider mechanics, retention policy, the erasure decision, the commercial recovery promise |
| ADR-0020 | The publish-path family, its two axes, the breadth envelope, and verification-integrity limits | Numeric objectives before G6, the compiler's own component budget, DDL online-strategy design |

References between these documents describe handoffs only. A consumer may
carry, render, cache, or enforce information from an authority; that does not
make the consumer a second source of truth.

## Constitutional coverage

ADR-0001 through ADR-0010 are accepted and cover both constitutional tranches.
The north-star plan remains supreme over every refinement in this map.

**Domain-model tranche (added 2026-07-26).** ADR-0015 through ADR-0018 close the four
one-way doors recorded as G1, G2, G3 and G6 in
[`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md). They are not
constitutional in the G0 sense — they refine domain semantics rather than runtime authority
— but they are listed here because each names an exclusive authority that G3 must honour
before the first movement is posted, after which none of them is implementable as written.

For these four rows, additionally verify that:

1. `legalEntityId` appears in no RLS policy and in no ABI-frozen key, so the
   business-versus-tenancy classification is executable rather than asserted;
2. no compiled projection keys a balance on a tuple other than the declared dimension set,
   and no posted movement lacks its dimension-set version;
3. no read model, projection, index, export, or reconciliation discards `recordedAt`; and
4. no compiled artifact derives a monetary amount from an `InventoryMovement`.

**Operational-envelope tranche (added 2026-07-26).** ADR-0019 and ADR-0020 close audit G4 and
G7. Their deadlines are softer than the domain-model tranche's — nothing becomes impossible on
a given day — but both carry one piece that decays: the tenant completeness manifest is cheap
at ten tables and an archaeology project at a hundred, and the publish-path breadth envelope is
a curve that cannot be reconstructed if it is never started.

For these two rows, additionally verify that:

1. every table in every non-system schema resolves to exactly one tenancy classification, and
   an unclassified table fails closed;
2. no recovery path holds the capability to issue business-row DML against a live tenant;
3. the publish-path family is reported end to end, with the compiler's component budget never
   substituted for it, and platform exclusion budgeted on its own axis; and
4. no path admits a candidate whose verification set was narrowed without a recorded impact
   analysis, and no incremental compile ships whose bytes differ from a cold compile.

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
