# G2-P3b — Party walking slice and reusable module template

Status: evidence_ready
Tier: Critical
Execution mode: SERIAL-TEMPLATE
Freeze established at reviewed checkpoint: Freeze G
Frozen candidate: `aa5226a8dfc155f6dd421fea4fbb81636e262a0e`

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
It contains no module literal, validates its declaration against compiled
resolver authority, preserves authoritative gateway outcomes, and is reusable
unchanged by Catalog/Location.

Authorized generic relation-validation bridge:
`packages/postgres-provider/src/module-runtime-interpreter.ts` validates every
compiled relation target through the tenant/environment-scoped module role
before insertion. The accepted P2c assertion in
`test/postgres/module-runtime.test.ts` has the named Mechanical expected-ripple
bridge from a raw foreign-key error to the typed
`MODULE_RELATION_TARGET_NOT_FOUND` service failure. Party independently keeps
the raw-provider composite-FK rejection proof as the storage backstop.

Out of scope: orders, communications, balances, imports, private Party routes,
actions, tools, registries or screens, hard delete, rich table behavior (G2-P5),
and the full grammar-conformance suite (G2-P4).

## Freeze G established

Freeze G is established on the independently reviewed candidate
`aa5226a8dfc155f6dd421fea4fbb81636e262a0e`. User acceptance and integration
remain pending at this checkpoint. The reusable template is:

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
   identifier/advisory authority, and the frozen result envelope. Only a
   unique exact identifier with no advisory collision selects; one or many
   advisory matches, identifier/advisory collisions, and fuzzy candidates
   clarify as ambiguous.
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

Frozen product candidate:
`aa5226a8dfc155f6dd421fea4fbb81636e262a0e`.

Focused evidence:

- Party and Party role compile cleanly with all required projections and an
  additive storage-transition envelope.
- The real PostgreSQL journey proves tenant-number uniqueness, Q0/O0,
  supplier/customer role linkage, identifier exact selection, single and
  duplicate advisory ambiguity, identifier/advisory collision ambiguity,
  fuzzy clarification, missing/cross-tenant not-found behavior, archive
  visibility/restore conflicts, linked/redacted trust facts, rollback without
  audit residue, and service plus direct-provider cross-tenant relation
  rejection.
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

### Review trail

- The first fresh Codex `gpt-5.6-sol` xhigh review returned REVISE on
  `370c90c3a53ff14904e177d669ce8514f5376b1b`: the generic resolver bridge could
  replace an authoritative ambiguous outcome with exact, did not validate its
  field declarations against compiled authority, and was bypassed by the
  Party resolver harness.
- REVISE round 1 produced `aa5226a8dfc155f6dd421fea4fbb81636e262a0e`.
  The bridge now preserves every authoritative non-not-found result, validates
  identifier/advisory sets against compiled `resolveMatchKeys`, and permits
  fuzzy matching only as ambiguous clarification. Party now exercises that
  bridge through the real gateway and adds identifier/advisory collision plus
  fuzzy-name proofs in integration, PostgreSQL, and browser fixtures.
- A fresh naive Codex `gpt-5.6-sol` xhigh reviewer returned PASS on all seven
  charter questions for the frozen replacement SHA.
- Fable max independently returned PASS on all seven questions on the
  identical unchanged SHA, with particular confirmation of definition-only
  generation, resolver authority, independent service/storage tenant
  defenses, and Freeze G reuse without shared-press module branches.
- Fable recorded three non-actionable observations rather than packet
  findings: runtime interpretation of the reserved `archiveBehavior: restrict`
  seam belongs to future lifecycle work; the agent test currently uses a
  focused invocation rather than an aggregate script; and its sandbox could
  not reread the quarry while the Codex reviewer independently verified the
  pinned quarry hashes.

### Gate evidence on the frozen candidate

| Gate | Result |
|---|---|
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm check:boundaries` | PASS — 92 production files |
| `corepack pnpm format` | PASS |
| `corepack pnpm test:compiler` | PASS — 46/46 |
| `corepack pnpm test:unit` | PASS — 18/18 |
| `node --import tsx --test test/unit/party-definition.test.ts` | PASS — 4/4 |
| `corepack pnpm test:integration` | PASS — 40/40, including Party 2/2 |
| `node --import tsx --test test/agent/party-discovery.test.ts` | PASS — 1/1 |
| `node --import tsx --test test/postgres/party-runtime.test.ts` | PASS — 1/1 |
| `corepack pnpm test:postgres` | PASS — 59/59 |
| `corepack pnpm test:architecture` | PASS — 41/41 |
| `corepack pnpm check:schema` | PASS — 8/8, clean drift |
| Party Playwright browser journey | PASS — 1/1 against real PostgreSQL |
| `git diff --check` | PASS |

## Test it yourself

From `/home/rvham/2rain-greenfield`:

```bash
node --import tsx --test test/unit/party-definition.test.ts
node --import tsx --test test/integration/party-runtime.test.ts
node --import tsx --test test/postgres/party-runtime.test.ts
node --import tsx --test test/agent/party-discovery.test.ts
corepack pnpm exec playwright test --config apps/web/playwright.config.ts apps/web/test/browser/party-runtime.spec.ts
```

Expected: 4/4 unit, 2/2 integration, 1/1 PostgreSQL, 1/1 agent, and 1/1
browser. Resolver evidence includes number `P-001` as exact; a single advisory
name and duplicate advisory names as ambiguous; an identifier/advisory
collision (`P-004`) as ambiguous; the fuzzy typo `Maxmium Constructon` as
ambiguous clarification; and missing/cross-tenant text as not-found. The
PostgreSQL test also proves typed pre-insert relation rejection without trust
residue and a separate raw composite-FK rejection.

For a screenshot-able browser walkthrough, run:

```bash
PWDEBUG=1 corepack pnpm exec playwright test --config apps/web/playwright.config.ts apps/web/test/browser/party-runtime.spec.ts --headed
```

Step through the Playwright inspector. You should see supplier and customer
role rows; Party `P-WEB-001` archive to revision 2 and restore to revision 3;
the form create `P-WEB-004` / `Browser-created Party`; the linked-trust status;
and the created real-PostgreSQL row in the Party list. The page must never show
`north_star_module` or `storageClass`.

## Program-review trigger

This packet creates the first real end-to-end module immediately before the
Catalog/Location fan-out. The program-review milestone trigger is DUE. Per the
program-review doctrine, the orchestrator must propose a read-only whole-app
program review on clean integrated `main` after acceptance and before fan-out.
It is not run autonomously or against this evidence-ready branch.
