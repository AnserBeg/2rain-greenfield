# G2-P3b — Party walking slice and reusable module template

Status: active
Tier: Critical
Execution mode: SERIAL-TEMPLATE
Freeze established on acceptance: Freeze G
Frozen candidate: pending

## Goal and scope

Deliver Party as the first real end-to-end module through the ratified press:
one canonical definition compiles into typed dedicated storage and additive
transition DDL, Q0/O0 catalogs, list/detail/form surfaces, agent discovery,
reporting, policy, verification, and trust-wrapped runtime behavior. Party role
is a parent-scoped child with supplier/customer semantics; there is no Vendor
master and no delete operation.

This packet composes ratified G1 and Freezes E/F plus accepted G2-P3a. It opens
no design space and required no debate.

Owned paths:

- `packages/domain/src/party/**`
- `test/fixtures/g2/party/**`
- `test/unit/party*.test.ts`
- `test/integration/party*.test.ts`
- `test/postgres/party*.test.ts`
- `apps/web/test/browser/party*.spec.ts`
- `test/agent/party*.test.ts`
- `docs/decisions/salvage/g2-p3-text-match.md`
- this packet record and `docs/execution/ledger.md`

Named foreseeable bridge: `packages/runtime/src/resolve-by-name.ts`, the
generic deterministic resolver primitive admitted through the salvage record.
It contains no module literal and is reusable unchanged by Catalog/Location.
No other out-of-lease path is used.

Out of scope: orders, communications, balances, imports, private Party routes,
actions, tools, registries or screens, hard delete, rich table behavior (G2-P5),
and the full grammar-conformance suite (G2-P4).

## Freeze G candidate

Freeze G is ratified only when this packet is reviewed and accepted. Its
candidate template is:

1. `packages/domain/src/<module>/definition.ts` plus an `index.ts` export is
   the only product code owned by a real module.
2. A module declares entities, fields, relations, Q0/O0, permissions,
   list/detail/form surfaces, storage mappings, capability requirements, and
   generated conformance assertions as canonical data.
3. The compiler supplies storage/query/operation/surface/agent/reporting/
   verification artifacts; provider, gateways, and SurfaceRuntime remain
   generic and contain no module literal.
4. Parent-scoped children use a required tenant/environment composite relation
   with restrictive foreign-key actions.
5. Resolver composition uses compiled tenant-scoped queries, explicit
   identifier/name field declarations, and the frozen result envelope. Only
   exact identifiers select; names/fuzzy candidates clarify.
6. One `test/fixtures/g2/<module>` harness compiles and materializes the
   definition, issues pinned views, serves Q0/O0, and is reused by provider,
   browser, resolver, agent, lifecycle, audit, and tenant-isolation tests.
7. UI, query, agent, and operation read-back carry the same
   `SemanticRecordDto` field identity.
8. Archive/restore is the only removal lifecycle; failed mutations roll back
   both business rows and trust evidence.

Catalog and Location may consume this template only after acceptance and the
triggered program review.

## Decisive review charter

Threat model: honest-code defects—cross-tenant leakage, weak auto-resolution,
per-module glue, DTO drift, and hard-delete leakage. Hostile input, rich table
behavior, full grammar conformance, other modules, and performance are out of
scope.

The Critical review answers only:

1. Is Party definition-only with zero hand-written SQL, handlers, routes,
   registries, screens, or agent tools, and is the resolver bridge generic?
2. Do exact/ambiguous/not-found semantics forbid weak auto-pick and existence
   leakage?
3. Is cross-tenant `party_role -> party` rejection proved through the service
   and independently at policy/RLS/provider enforcement?
4. Is one DTO identity preserved across UI, query, agent, and operation
   read-back?
5. Are archive/restore the only lifecycle removal operations, with no hard
   delete and atomic audit/outbox behavior?
6. Is the salvage record complete and honest, including exact provenance and
   rejection of weak fuzzy auto-selection?
7. Could Catalog and Location use Freeze G without editing the shared press or
   introducing module glue?

Review chain: fresh naive Codex `gpt-5.6-sol` xhigh to PASS, then Fable max on
the identical SHA. Any code change invalidates review; maximum two REVISE
rounds before surfacing.

## Evidence

Candidate SHA and final gate/review results are recorded when frozen. Current
focused evidence:

- Party and Party role compile cleanly with all required projections and an
  additive storage-transition envelope.
- The real PostgreSQL journey proves tenant-number uniqueness, Q0/O0,
  supplier/customer role linkage, exact/duplicate/fuzzy/missing/cross-tenant
  resolver behavior, archive visibility/restore conflicts, linked/redacted
  trust facts, rollback without audit residue, and service plus direct-provider
  cross-tenant relation rejection.
- The real Chromium journey renders Party and role rows, archives/restores,
  creates through the generic form, shows linked trust feedback, and runs its
  resolver plus agent/query DTO proof against the same migrated database.
- Named Mechanical bridge: the accepted P2c generic service-path expectation
  now asserts `MODULE_RELATION_TARGET_NOT_FOUND`, the expected ripple of the
  generic pre-insert relation guard. Its no-trust-residue assertion is
  unchanged, and Party's separate raw-provider composite-FK rejection remains
  the independent storage backstop.

Required packet gates are green. The accepted G2-P2b case-fold corrective also
resolved the inherited stale v0/v1 canonical-diagnostic unit expectation on
the corrected base; the full baseline `test:unit` suite is now 18/18. G2-P3b
does not alter that out-of-lease canonical-model source or evidence.

## Test it yourself

Final copy-paste commands and the screenshot-able browser walkthrough are
recorded after the candidate SHA is frozen.

## Program-review trigger

This packet creates the first real end-to-end module immediately before the
Catalog/Location fan-out. Per the program-review doctrine, acceptance triggers
a proposed read-only whole-app program review on clean integrated `main`. It is
not run autonomously or against this active branch.
