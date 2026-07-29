# ADR-0023: Storage-less platform capability tier

Date: 2026-07-28
Status: proposed by packet 1c-a; pending packet acceptance
Tier: Critical (review per `review-tiers`)

## Context

ADR-0011 ratifies one press for ordinary modules: the canonical release owns
managed-module desired state, the compiler emits dedicated typed storage, and one generic
interpreter serves the complete Q0/O0 contract. Its storage-topology verdict made those
constraints inseparable:

- checked-in migrations exclusively own the kernel plane;
- canonical release artifacts exclusively own the managed-module plane;
- ordinary modules do not add private SQL, handlers, routes, tools, branches, or registries;
  and
- every active managed entity supplies storage plus the complete get/list/search/resolve and
  create/update/archive/restore contracts.

The saved-filter package was accepted as though it were such an entity, but it is not. Its
real table is `platform.saved_master_filters`, created by checked-in migration 0012 and scoped
by tenant, environment, and `owner_principal_id`. The package's `dedicatedTable` declaration
does not own that table, and the compiler-emitted storage target is never materialized. Reads
and writes go through a 1,176-line platform provider adapter containing bespoke SQL. That
adapter serves `get` and `list` plus the four lifecycle operations, while `resolve` and
`search` return `unsupported`.

The mismatch now has three independently observed costs:

1. the declared storage mapping is decorative while a kernel migration owns the real table;
2. Q1-P1 found that the bespoke executor silently discarded policy filter plans until a
   fail-closed `SAVED_FILTER_QUERY_INADMISSIBLE` guard was added; and
3. packet 1b's genuine verification path reaches the compelled `resolverAuthority` scenario,
   observes `VERIFICATION_RESOLVER_POSITIVE_FAILED`, persists no evidence, and admits no
   release.

ADR-0011 is ratified authority. The G2-P5b ledger wording that called the platform package a
third zero-press-change module cannot amend it. The package is non-releasable until this
contradiction is ruled and encoded.

The canonical language already represents an absent or null storage class at v2. The legacy
normalizer's rejection of that shape is limited to `v0-experimental`. The current refusal is
compiler policy: `COMPILER_STORAGE_CLASS_REQUIRED` plus storage lowering that accepts only
`dedicatedTable`. No language-version event is needed to express a storage-less package.

The opposite branch is not comparably small. Making saved filters an ordinary generic entity
would require per-principal row ownership as a canonical, compiled, materialized primitive.
The existing relation `ownership` vocabulary describes `reference` and `parentScopedChild`; it
does not describe ownership of a row by the current principal. Neither storage lowering nor
the materializer carries `principal_id`. Provenance cannot discriminate the platform package:
all current first-party definitions use `firstParty`. A namespace check for
`northstar.platform` inside the press would itself be the module-specific kernel branch
ADR-0011 forbids.

## Candidates considered

### Make saved filters an ordinary managed entity

This would move the table and its complete semantics into the managed-module plane, add a
canonical per-principal ownership concept, compile its column and forced-RLS contract, teach
the generic interpreter to enforce it, and then restore the full Q0 quartet.

It preserves a single execution mechanism, but it does not preserve the current contract:
principal ownership becomes a new cross-layer language primitive. It also arrives before the
policy/identity kernel. That kernel is explicitly deferred past G3 and currently returns ALLOW
for every principal. A generic ownership primitive would therefore need its mandatory
principal predicate to remain non-overridable while later policy contributes only additional
narrowing. Treating today's allow-all policy as the ownership decision would expose every
principal's saved filters.

This branch is rejected for saved filters. A future need for generic per-principal business
rows may justify that primitive on its own merits, but it does not establish a second saved-
filter path. Moving saved filters later would require a superseding ADR, migration and removal
of the platform adapter; the platform and managed implementations may not coexist.

### Classify saved filters as a storage-less platform capability

The saved-filter rows are platform metadata, not managed business records. Their persistence
is already in the kernel plane, their invariant is principal/release/predicate-envelope
integrity, and their provider adapter already sits behind the semantic gateways and trust
path. The package can describe its supported surfaces without claiming that the press owns
its storage or implements capabilities the provider does not have.

This branch restores exclusive desired-state ownership and makes the declaration truthful
without inventing a canonical concept. Selected.

## Decision

### 1. Select branch (b) and amend ADR-0011 narrowly

ADR-0011 remains ratified with this amendment:

- its non-null `dedicatedTable` and complete Q0/O0 requirements apply to **Tier-A managed
  entities** whose storage projection is required;
- its generic interpreter remains the only Q0/O0 executor that may touch
  `north_star_module` managed tables; and
- a **Tier-B platform capability projection** may instead declare no compiled storage class
  when checked-in kernel migrations exclusively own its platform-plane persistence.

The final sentence of ADR-0011's conformance section is therefore read as prohibiting
module-specific execution for Tier-A managed entities. A Tier-B platform capability may have
one versioned provider adapter for its specialized platform-plane invariant, but that adapter
must remain behind the ordinary semantic Query/Operation gateways. It may not create a direct
HTTP route, top-level agent tool, policy bypass, release bypass, private desired-state
registry, or generic-press branch.

This does not weaken the storage-topology verdict. R1's generic executor remains exclusive for
module tables; the saved-filter adapter touches a `platform` table. R2's ownership split is
restored: migration 0012 owns the table, while the canonical release owns only the capability
declaration and its presentation/execution contracts. R3's dedicated typed tables remain the
launch rule for managed master data. Party, Catalog, Location, application-builder entities,
and future ordinary modules receive no exception.

“Tier-B” here classifies the capability's realization and ownership envelope. It does not
silently promote simple saved-filter reads and lifecycle effects into new Q2/O2 language
shapes: the declared get/list queries remain Q0-shaped and the four operations remain
O0-shaped. Their exceptional implementation is justified only by platform-plane persistence;
ordinary Q0/O0 over managed tables remains generic.

### 2. Storage absence is structural classification, not self-authorization

Neither package provenance nor a namespace string selects the tier. The structural Tier-B
classification is the conjunction of:

1. the active capability requirement does **not** require the storage projection;
2. every entity covered by that capability references an active storage mapping whose
   `storageClass` is absent or null;
3. storage lowering emits no managed entity, table, transition, materialization, or storage
   verification obligation for it; and
4. a versioned provider capability registration, checked against the pinned release,
   enumerates and executes the exact declared Query/Operation surface.

The first version is package-wide: every active entity in a Tier-B platform capability package
must be storage-less, and a package may not mix Tier-A managed entities with Tier-B platform
entities. A later mixed-package composition contract would need a separate decision; it is not
inferred here.

The first three conditions let the compiler represent a candidate. They do not make it
releasable. Missing registration, registration/declaration mismatch, an empty executable
surface, missing evidence, or an `unsupported` result for anything declared as supported must
fail release verification and admission.

This is deliberately two-sided. Dropping `storageClass` from a Tier-A entity while its
capability still requires storage continues to produce `COMPILER_STORAGE_CLASS_REQUIRED`.
Dropping both declarations cannot manufacture an executor: without a registered capability
and exact real verification, the candidate remains non-releasable. Absence is not an
`allowBespoke` flag.

### 3. The platform tier is a capability envelope, not a general module escape

A Tier-B platform capability may:

- use platform-plane persistence exclusively owned by checked-in migrations;
- publish a versioned, typed provider registration and a closed or typed configuration
  contract;
- declare only the queries, operations, surfaces, agent affordances and reporting behavior it
  actually supports; and
- implement its specialized invariant in a provider adapter behind release pinning, semantic
  gateways, trusted request context, forced RLS, trust/audit and verification.

It may not:

- claim managed storage, emit managed DDL, or use the materializer;
- use a platform table as a second desired-state authority for a managed entity;
- accept tenant-authored executable code or an arbitrary handler body;
- infer registration from provenance, namespace, labels, or mutable names;
- bypass or silently discard tenant, environment, principal, archive, policy, permission,
  release, optimistic-concurrency, trust, or verification obligations;
- advertise an undeclared or unverified capability as supported; or
- provide an alternate path for a Tier-A entity that the generic press can represent.

The saved-filter capability is the sole capability admitted by this ADR. A later platform
capability needs its own accepted ADR, versioned protocol, explicit kernel-plane ownership,
provider registration and real verification evidence. The compiler does not learn a general
"platform namespace" allowlist.

This is the envelope audit B5 says must precede deadline pressure. It is not Tier C: no tenant
or module author supplies code. The executable implementation is platform-maintained, typed,
release-bound, resource-bounded and revocable through ordinary release control. The unit of
admission is the entire capability protocol and evidence set, never the existence of an
adapter class.

### 4. Saved filters declare only the contracts they serve

The versioned capability identity is `northstar.platform:capability.saved_filters` version 1.
Its configuration contract is explicitly closed: there are no tenant-selectable algorithmic
dials. Its authoritative dependency set is:

- trusted tenant, environment and principal identity;
- the request-pinned release and its query/field catalog;
- the canonical saved-filter predicate envelope and position profile; and
- the saved-filter row itself, including lifecycle and optimistic revision.

It produces no authoritative business fact and grants no permission. Its platform table is
metadata containing tenant-authored views, consistent with plan section 10.6's classification
of saved filters as tenant-owned.

The release declaration contains exactly:

- queries: `get` and `list`;
- operations: `create`, `update`, `archive`, and `restore`; and
- the list, record and form surfaces backed by those queries and operations.

`resolve` and `search` are removed from the declaration. Their canonical IDs may remain
reserved internally, but an undeclared ID is unreachable through the pinned query catalog and
does not count as supported behavior. The capability does not inherit Tier-A's four-query
completeness rule.

The discriminator is therefore not "any null storage mapping has fewer obligations." It is
"a non-storage capability has only its versioned, explicitly declared obligations, and every
one must execute." Tier-A completeness remains unchanged.

### 5. The press still guarantees the cross-cutting contract

For a storage-less platform capability, the press guarantees:

- canonical normalization, content addressing and immutable release identity;
- exact capability version and required-projection disclosure;
- pinned Query/Operation definitions, permissions and surface/agent projections;
- gateway, policy, trusted-context, trust/audit and release-pinning boundaries;
- a verification plan derived from the contracts actually declared; and
- exact plan/result conformance before release admission.

It does not claim managed storage ownership, generated DDL, transition compatibility,
generic CRUD/search/resolve, or recovery of a managed table. Kernel migration replay and
schema drift own platform-table recovery evidence; capability verification owns provider
behavior.

Verification must not make absence vacuous. For saved filters it executes positive and
negative evidence for `get`, `list`, all four operations, tenant/environment/principal RLS,
release/predicate validation, archive/restore and optimistic revision. It does not emit a
`resolverAuthority` scenario when no resolve query is declared, and it does not emit
search-dependent `searchableExclusion` scenarios when no search query is declared. If a
declared provider contract returns `unsupported`, evidence persistence and release admission
fail exactly as packet 1b proves today.

### 6. Policy is additive and never weaker than principal ownership

Migration 0012's tenant/environment/principal RLS predicates remain mandatory platform scope.
The future policy kernel may add a narrowing predicate or deny the request; it may not remove
or replace owner-principal scope. A Tier-B adapter that cannot honor a non-empty policy
obligation must return an explicit typed refusal before SQL, as the current saved-filter guard
does. Silently ignoring the obligation is forbidden.

Current-plan row 1e still owns the stronger executor contract that makes a dropped obligation
impossible rather than merely detectable. Current-plan row 7 still owns real authorization,
query-side denial evidence and the policy predicate kernel. This ADR does not reinterpret
today's allow-all policy as authorization.

### 7. Releasability and downstream sequencing

The saved-filter package remains non-releasable in the current tree. The packet-1b refusal is
the correct gate until the follow-on encoding:

1. removes the decorative storage projection/class;
2. narrows the declared query set to `get` and `list`;
3. derives conformance and verification from the storage-less capability contract;
4. executes the complete real provider plan; and
5. persists exact evidence and admits the release.

After that evidence is green, saved filters are releasable under the program's current
internal-team-only authorization posture. They are not safe for external user access until
row 7 replaces allow-all policy, the same restriction that already applies to the composed
application.

This ruling unblocks three named consumers:

- current-plan row 1 may implement `savedViews` against the releasable get/list capability;
- row 1e hardens the executor contract so future adapters cannot drop gateway obligations;
  and
- row 7 contributes real policy narrowing/denial without weakening principal RLS.

## Consequences

- The platform saved-filter package is no longer claimed as a Tier-A or zero-press-change
  module data point. It is a Tier-B platform capability projection.
- Exclusive desired-state ownership becomes truthful: migration 0012 owns the platform table;
  the compiler does not emit a decorative managed table.
- Ordinary modules retain dedicated typed launch storage, full Q0/O0 completeness and the
  generic interpreter without exception.
- Saved filters regain a reachable release path after the encoding packet, without waiting for
  a new canonical language version or the policy-kernel implementation.
- The price of the exception is explicit capability governance and a provider adapter. It may
  not spread by precedent; every additional platform-plane capability requires a separately
  ratified envelope and evidence.
- A future generic per-principal ownership primitive does not create a parallel saved-filter
  implementation. Changing branches requires superseding this ADR and removing the old path.

## Evidence

- `packages/canonical-model/src/schemas.ts:947-950` permits absent/null
  `storageClass`; `normalize.ts:743,773-779` limits the contrary representation rule to the
  legacy language.
- `packages/compiler/src/conformance.ts:169-177` and
  `packages/compiler/src/storage.ts:433-436` are the compiler refusals.
- `packages/compiler/src/conformance.ts:287-349` compels Tier-A entity completeness;
  `packages/compiler/src/projections.ts:626-635` emits the positive-and-negative resolver
  scenario.
- `packages/domain/src/platform/definition.ts:17-22,150-164` declares four queries and a
  decorative dedicated table; `packages/postgres-provider/src/saved-filter-executor.ts:170-191`
  serves only get/list and returns unsupported otherwise.
- `db/migrations/0012_saved_master_filters.sql:1-104` owns the real platform table and applies
  principal-scoped forced RLS. Storage lowering and the module materializer contain no
  `principal_id` concept; canonical relation ownership is only `reference | parentScopedChild`.
- `test/postgres/saved-filter.test.ts:83-98` observes real verification refusal, zero durable
  evidence and zero admissions.
- Q1-P1 recorded the pre-fix policy-plan bypass and the current explicit
  `SAVED_FILTER_QUERY_INADMISSIBLE` refusal; row 1e owns structural prevention.
- The authored composed application contains Party, Catalog and Location only, so the current
  product startup path does not depend on the refused platform package.

## Enforcement

The follow-on encoding must add deterministic negative controls for:

1. a storage-required Tier-A entity with null/absent `storageClass` still failing
   `COMPILER_STORAGE_CLASS_REQUIRED`;
2. a storage-less capability emitting any managed table/transition failing;
3. an empty or unregistered storage-less capability remaining non-releasable;
4. a registration/declaration mismatch failing before admission;
5. a declared query or operation returning `unsupported` failing verification;
6. resolve/search verification not being silently retained after those queries are removed;
7. removal of any real get/list/operation/RLS/release-validation scenario making exact
   plan/result conformance fail; and
8. non-empty policy narrowing being either executed or explicitly refused before provider SQL.

Architecture enforcement must continue to forbid SQL or handlers in domain packages, direct
routes/tools, namespace branches in the generic press, and module-table access by Tier-B
adapters. Migration replay and schema drift continue to prove kernel-plane ownership.

## Limits

This ADR encodes nothing. It does not edit ADR-0011 in place, change canonical bytes, relax a
compiler diagnostic, alter a definition, move a table, change an executor, or make saved
filters releasable. The implementation is deliberately deferred until the FIX and KERNEL lane
leases on compiler storage/projections and the platform definition are released.

It also does not design generic per-principal row ownership, implement policy, close the
archived-filter write/read reachability defect, add search/resolve, or claim that the bespoke
provider adapter is a pattern for ordinary modules.
