# GENERALIZE-1 · Generic code resolves first-party behaviour through declarations

**Slice 1 · record.** Status: built on `packet/GENERALIZE-1-s1` from main `5710c05a`; the full run covers executable tip `4baa5460` (this record is docs-only after it); every required job succeeded, but the run is red on reachability bookkeeping and needs a rerun of all jobs (see Gates) before review, then a train. Tier: **Critical** (`release-verification-service.ts` is in the Critical set; the writer invariant guards evidence state). Critical paths touched: `packages/postgres-provider/src/release-verification-service.ts` (constructor plumbing only). Rung: none. Migration: none. Stops taken: item 2 (document kinds), see Decisions.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44992333448

## Claims
1. The generic record writer (`module-runtime-interpreter.ts`) names no module, entity or field for the stock count; it enforces whatever `StateDependentWriteInvariant` a capability declares, on every ordinary update, against the stored image.
2. Inventory declares the counting invariant (`inventory-write-invariants.ts`): while a count is counting, its counting mode and its state are frozen; the refusal code (`MODULE_OPERATION_PRECONDITION_REFUSED`), both messages, their order (mode first), the any-namespace match and the older-definition exemption (no mode column) are exactly the writer's previous behaviour.
3. A second application (a field-service inspection visit: in-progress state, frozen method, crew and state, different namespace and IDs) gets the same writer behaviour from a declaration alone; an entity named `stock_count` in that app gets no rule it did not declare.
4. Every production record writer receives the declared invariants from product assembly: request serving, the workflow worker's gateway, release verification (`ensureReleaseAdmitted`) and customization. A source scan refuses a production construction that omits them.
5. Compiled and persisted shapes are unchanged: `check:app-release` and `check:demo-release` pass byte-identical, so no reader rung is owed (rule 13).

## General blocks (rule 16)
- **State-dependent write invariant** (`module-write-invariants.ts`): "while in state S, fields F are fixed and S is left only by the owner's command". Serves stock counts (distribution, rentals), a field-service visit in progress (method and crew fixed), a clinic encounter once checked in (practitioner fixed), a hotel stay once checked in (room rate plan fixed).
  Delivered as a capability-supplied writer contribution (a provider registry at the composition root, like provider error mappings), so each of those capabilities binds its own invariant against the pinned storage target without a platform edit.

## Decisions
- Declaration lives with the capability and is supplied at product assembly, not compiled into the storage target: a compiled key would raise the floor for every first-party release (rule 13); this stays internal.
- Inventory's binding keeps suffix matching (as `stockCountBinding` does), because it is Inventory's own code; the generic writer matches by exact entity ID only.
- The interpreter and verification-service parameters default to `[]` so the 75 direct test constructions keep compiling; production is held by the source-scan test instead. That check is textual, not type-enforced. Serving, workflow, customization and composed-runtime options are required.
- Workflow files touched only for constructor plumbing (`workflow-gateway.ts`, `workflow-worker.ts`); no active branch edits either file.
- **Item 2 stopped (document kinds).** `documentKind` is a strict enum inside the stored v6 definition and the documents projection, both parsed by older readers, so a declared kind needs a reader rung and an archived-loader refusal proof (rules 9, 13). The first-party app cannot carry a declared kind without changing its bytes, so the proof needs a second-app release served by the archived loader. The pieces exist (G1-P5 in `request-runtime-view.test.ts` activates compiled fixture releases into tenants; `archivedRuntimeRead` reads a tenant's active release) but have never been combined, and that PostgreSQL proof could not be run locally on this slice's one-full-run budget. This is a scope call, not a collision with an in-flight packet. Design for the next slice: kinds declared only in the app definition (`documentKinds: [{kindId, label}]`); revision `documentKind` = the five legacy literals (unchanged bytes) or a declared kind ID; compiler refuses an undeclared kind; surface floor rises to a merge-assigned rung only when a declared kind is used; Customize form and diff read labels from the release; no new Customize member (rule 12 unchanged). First task of the next slice: combine G1-P5 activation with `archivedRuntimeRead` and prove the archived loader serves a fixture-activated tenant.
- Existing controls re-pointed: `STOCK-COUNTS-fixes` mode/state now mutate Inventory's declaration; `SALES-PARITY` sentinel-number control follows the reformatted options.

## Slice 1 (item 1)
Writer invariant declared by Inventory and enforced generically · `test/integration/module-write-invariants.test.ts`.

## Controls
`test/evidence/GENERALIZE-1.expected-red.json`, all four reproduced locally with `check-expected-red.sh --run`: frozen-field check removed (kills first-party and second-app tests), update path stops enforcing, Inventory drops the mode entry, workflow writer omits invariants. The re-pointed `STOCK-COUNTS-fixes` controls run on PostgreSQL (CI only).

## Gates
Local: typecheck, eslint and prettier on changed files, `test:unit`, `test:compiler`, `test:integration`, `test:architecture` (after the two fixes), `check:app-release`, `check:demo-release`, `check-expected-red.sh`. PostgreSQL and browser suites run only in the full CI run.
**Red, stated:** run 44992333448 attempt 1 cancelled PostgreSQL shard 3 at its 30-minute limit (no failure line); attempt 2 reran the failed jobs, shard 3 passed and "all required jobs succeeded", but executed-file reachability refused attempt-1 evidence (`Stale reachability evidence for unit: expected run 44992333448-2, received 44992333448-1`; the run ID includes the attempt), so its file comparison never ran on `4baa5460`. Needed: `gh run rerun 44992333448` (all jobs).
**What the gates cannot prove:** that a tenant or AI-built module can declare an invariant (it cannot yet: declarations come only from capability code at assembly); that a future writer outside the five scanned constructions picks them up (the scan is textual); the end-to-end first-party refusal through the real writer is proved only by the PostgreSQL test `STOCK-COUNTS: counting mode is fixed after Start even through a state reset`, which runs in CI.

## Test it yourself
`node --import tsx --test test/integration/module-write-invariants.test.ts`: six passing, covering the first-party refusals and the field-service visit. In the app: `corepack pnpm dev`, open a stock count, choose Blind, Start counting, change the mode to Open and save: refused, "counting mode is fixed after Start counting"; edit the reason narrative: saves. The reset-to-draft refusal is exercised by the PostgreSQL test named under Gates.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "GENERALIZE-1",
  "base": "5710c05ae2529b742bf15f8f484c75c0b3930180",
  "head": "4baa546017bf479460d9cb1c8ce00286a0009d09",
  "changedPaths": [
    "apps/api/src/composition-root.ts", "apps/api/src/pilot-composition-root.ts", "apps/web/test/browser/customize-inspection.composed-application.spec.ts", "packages/postgres-provider/package.json", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/inventory-write-invariants.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/module-write-invariants.ts", "packages/postgres-provider/src/release-verification-service.ts", "packages/postgres-provider/src/serving-gateways.ts", "packages/postgres-provider/src/workflow-gateway.ts", "packages/postgres-provider/src/workflow-worker.ts",
    "test/architecture/repository-hygiene.test.ts", "test/evidence/GENERALIZE-1.expected-red.json", "test/evidence/SALES-PARITY.expected-red.json", "test/evidence/STOCK-COUNTS-fixes.expected-red.json", "test/helpers/archived-billing-probes.ts", "test/helpers/archived-runtime-process.ts", "test/helpers/customization-fixture.ts", "test/helpers/generate-fresh-tenant-full-replay-schema.ts", "test/helpers/staff-browser-fixture.ts", "test/integration/module-write-invariants.test.ts", "test/integration/workflow-host.test.ts",
    "test/postgres/booking-serving.test.ts", "test/postgres/composed-application.test.ts", "test/postgres/customization-live.test.ts", "test/postgres/customization-world.test.ts", "test/postgres/customization.test.ts", "test/postgres/document-attachments.test.ts", "test/postgres/release-approval.test.ts", "test/postgres/staff-signin.test.ts", "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/module-write-invariants.ts", "name": "stateWriteInvariantRefusal"},
    {"path": "packages/postgres-provider/src/module-write-invariants.ts", "name": "bindWriteInvariants"},
    {"path": "packages/postgres-provider/src/inventory-write-invariants.ts", "name": "STOCK_COUNT_COUNTING_INVARIANT"}
  ]
}
```
