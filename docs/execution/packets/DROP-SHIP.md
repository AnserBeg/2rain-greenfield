# DROP-SHIP — supplier delivery directly to the customer

Status: unfinished BUILD on `packet/DROP-SHIP`, PAYABLES `96ac2341` and RELATION-INSTALL checkpoint `f3330e98` merged. Bridge draft [PR #20](https://github.com/AnserBeg/2rain-greenfield/pull/20) has three hosted red/green controls and [all 11 CI jobs green at `f3330e98`](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37286524398); owner review remains owed. DROP-SHIP draft [PR #19](https://github.com/AnserBeg/2rain-greenfield/pull/19) awaits refreshed full CI. No main merge or deployment; own Critical set unchanged.

## Design (written before implementation)

- D-A: drop ship is in scope now. A sales line declares Stock (default) or Drop ship and its supplier. Only Stock lines may reserve or ship internally; routing and links are frozen once the order is confirmed.
- D-B: supplier delivery is a company-scoped commercial fact, not a stock movement. A numbered `DSD-` draft posts against its linked released purchase line and confirmed sales line; exact-decimal quantities are bounded by both lines' open quantities under their order locks. A reversal preserves the original document and is refused when live invoices/bills would exceed the remaining eligible quantity.
- D-C: Create drop-ship PO creates or extends a draft PO for one supplier, customer ship-to and currency, with one symmetric purchase/sales line link per demand line. Existing links are reused rather than duplicated. The purchase order keeps the customer's ship-to snapshot.
- Canonical fields, relations, queries, declared Lists and Record/Task compositions carry route selection, link creation, delivery entry/reversal, both orders' Deliveries sections and linked-order navigation. No bespoke screen or endpoint.
- One registered record-mutation capability owns link creation and delivery decisions, using existing current-policy, legal-entity, idempotency and transactional trust contracts. Generic delivery edits apply only to drafts; supplier/route/link consistency is checked again at execution.
- Delivered remains a distinct figure. The shared settlement executor and governed commercial/fulfillment read models add net delivered to physical progress for invoicing, billing, match, open quantities and closure. No shipped/received projection or posting-kernel write changes.
- Closure/cancellation bridges stay in settlement/capability paths, preserving the stock-only lifecycle and its reservation cleanup. Receiving/amending a linked drop-ship line as ordinary warehouse supply is refused before entering the kernel.
- `special_order` is filed as the next increment: the same demand/supply link is useful, but its receipt-into-stock and later reservation path is not a small off-ledger addition.
- PaneFlow export `paneflow-sales-parity-d057daff` is a read-only behavioral REFERENCE (`inventory-records.ts`, `advanced-domain.ts`, `db/schema.ts`); no code/database architecture is ported. The export has no Git metadata.
- RETURNS reconciliation: when #15 lands, reconcile net shipped/returned eligibility in settlement and read models, reversal floors against live invoices/bills, and closure/Cancel routing. Do not change its shipped-quantity neighbours here.
- Demand/supply line references use `retainReference` for historical document identity; confirmed-line and linked-purchase mutation guards retain edit control. Delivery-document links remain `restrict`; scoped FKs are unchanged.
- Create drop-ship PO is a selected-line Task on confirmed drop-ship demand; it still creates/reuses links for all eligible lines of that order. Linked-order navigation uses declared selection actions.
- Composed PostgreSQL tests checkpoint within their unchanged 256 MB fixture. Full recorded-lineage replay remains; focused transition fixtures use the exact head source rather than unrelated history. No capacity, timeout or readiness increase.

## Gates

- Implemented: route/supplier entry, linked PO creation/reuse and customer ship-to, bounded numbered delivery/reversal, physical-vs-delivered read models/settlement/closure, declared Lists, both order sections and delivery Record/Tasks. These are code/declaration claims, not successful PostgreSQL/browser execution claims.
- Changed unit, integration and web-contract files: 119/119 pass. Canonical route/bounds checks 2/2 and full tsc pass again after removing the alternative link-record experiment. Focused inventory-contract golden 1/1 and test registration 2/2 pass; surface grammar 25/25 pass.
- Combined hygiene/grammar run: 35/36; one lock-control test was refused by its live-container contamination guard during this packet's exclusive schema replay. Registration checks independently pass. Lint has no errors; formatting and diff whitespace checked.
- Exact-base release rebuild/check passes: five inherited entries plus one; 104 surfaces, 16 navigation leaves, 604 scenarios, 527 constructible candidates / 77 without a create operation. Hosted composed fresh-tenant replay observed these pins; its later successor test timed out. Both numbering pin lists include DSD: 11 fields, 11 uniqueness probes, measured from compiled assigned fields.
- Coverage declaration inventory re-derived: 2658 obligations / 824 observed declarations. Local coverage gate refused missing reachability receipts; no execution receipts were invented.
- Prior full-replay generation failed with `ELEMENT_TARGET_MISSING`; its container was cleaned and snapshot untouched. With RELATION-INSTALL merged, [hosted regeneration](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37279897119) at `5d2d9027` PASS. The generated full-replay snapshot is committed at `88ce5ce6`; release bytes are unchanged since generation.
- New commercial PostgreSQL journey is registered in package scripts, reachability and hygiene; two local exclusive runs failed at the governed revision boundary and then at order-List Delivered counts. Both containers were removed. New `purchase-drop-ship.spec.ts` is operations-browser reachable; local browser not run. Full DROP-SHIP CI acceptance remains unmet.
- Post-bridge correction: two existing unit files now account for DSD numbering, the exact sales-line/order relation and the fourth registered sales-order operation. Focused 14/14 PASS; formatting, typecheck and release `--check` PASS. Coverage re-derived again from unchanged declarations.
- Hosted run `37271614092` is red: compiler input/fixture pins, browser backend-loader failure and opaque generic guard refusal. Corrected at `e9751adc`: Sales command module, retained references, typed refusal, scoped browser loader and fixture closure. Four changed compiler/unit files PASS 93/93; lint/format/typecheck PASS. Full new CI remains pending.
- [Hosted run `37274390870`](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37274390870) is red: padded stored quantities rejected by governed PO creation, undeclared navigation placement, stale progress/CSV/fixture pins, stale schema snapshot and repeated-install WAL capacity. `14116111` canonicalizes copied quantity/date inputs, declares contextual actions, fixes browser selection and affected fixtures/pins, and checkpoints the composed test. Snapshot regeneration and fresh full CI remain pending.
- After those fixes: typecheck, focused lint/format, exact-base compile/check and coverage re-derivation PASS; commercial decimal unit tests 6/6 PASS; the two affected surface-binding cases 2/2 PASS. Static expected-red validates 165 entries / 14 manifests after upstream merge; no empty filtered test is counted.
- Local exclusive PostgreSQL run at `5d2d9027` reached Create drop-ship PO but failed with an opaque operation error; its container was removed. The stored revision is SQL `bigint`, the actual driver returns a string, and trust requires a number. `d9f40670` normalizes and validates this boundary outside trust; focused unit tests 7/7, lint/format and typecheck PASS. Fresh PostgreSQL/browser/full CI remain owed; schema/release bytes are unchanged.
- [Hosted run `37282097610`](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37282097610) is red. `ee982127` binds canonical delivery-state values rather than formatted labels, derives guard fields from storage metadata, registers its unit file, closes the removed-module fixture, defers test CHECKPOINT connections, pins measured Sales scenarios at 48, and reads browser dialog diagnostics before confirmation closes it. Focused guard unit 3/3 and architecture 3/3, lint/format/typecheck PASS; persisted/browser outcomes remain owed.
- [Hosted run `37287028810`](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37287028810) attempt 1 is red: collapsed Release control, the Reserve rejection fixture's unused draft at final Close, successor-test timeout, and `COMPILE_BUDGET_INDETERMINATE`. `178d6946` opens Record actions, observes Released and archives that unused draft through the gateway; `6f4cbfd5` isolates only the successor fixture. Focused lint/format/typecheck and exact normalized-source check PASS. One whole-workflow retry started; its performance gate PASS. Fresh full CI remains owed.
- Local container work checks Windows free memory before locking, uses one container at a time; no timeout, readiness or budget change. Static expected-red validation and record fidelity run on the frozen tree before push.

## Test it yourself

[DROP-SHIP-test-it-yourself.md](DROP-SHIP-test-it-yourself.md) gives the draft workflow; PostgreSQL/browser validation is still pending, not claimed as successful evidence.

## Filed

- Dedicated `special_order` supply is the next increment, not a silently accepted route.
- Owner selected the separate Critical relation-column bridge; it is merged here under authorized step 6, with its materializer change, test and controls declared below. Owner review remains on PR #20. The rejected intermediary link-record experiment left no runtime artifacts.
- Program review: not run; this unfinished, non-integrated tree meets the mid-packet anti-trigger, not a stable whole-app checkpoint.

Review: no separate DROP-SHIP arm; inherited Critical bridge owner-run review is owed on PR #20. Draft PRs against PAYABLES only; no integration or deployment.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "DROP-SHIP",
  "base": "96ac234122322b2cbe18349299664f56c8f5190a",
  "head": "6f4cbfd5376b6197e3d7453fc70fcc85c195f91f",
  "changedPaths": [
    "apps/api/src/composition-root.ts",
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json",
    "apps/web/src/component-registry.ts",
    "apps/web/src/list-declaration.ts",
    "apps/web/test/browser/declared-list.spec.ts",
    "apps/web/test/browser/expected-receipts.spec.ts",
    "apps/web/test/browser/purchase-drop-ship.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "package.json",
    "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts",
    "packages/canonical-model/src/surface-list.ts",
    "packages/compiler/src/conformance.ts",
    "packages/compiler/src/projections.ts",
    "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/drop-ship.ts",
    "packages/domain/src/app/list-declarations.ts",
    "packages/domain/src/inventory/contracts.ts",
    "packages/postgres-provider/package.json",
    "packages/postgres-provider/src/commercial-link-read-model.ts",
    "packages/postgres-provider/src/commercial-read-model.ts",
    "packages/postgres-provider/src/drop-ship-executor.ts",
    "packages/postgres-provider/src/drop-ship-mutation-guards.ts",
    "packages/postgres-provider/src/drop-ship-support.ts",
    "packages/postgres-provider/src/fulfillment-capability-executor.ts",
    "packages/postgres-provider/src/fulfillment-read-model.ts",
    "packages/postgres-provider/src/list-progress-read-model.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/postgres-provider/src/module-storage-materializer.ts",
    "packages/postgres-provider/src/payables-capability-executor.ts",
    "packages/postgres-provider/src/receivables-capability-executor.ts",
    "packages/postgres-provider/src/receiving-capability-executor.ts",
    "packages/postgres-provider/src/settlement-capability-executor.ts",
    "packages/runtime/src/list-behavior/index.ts",
    "packages/runtime/src/request-runtime-view.ts",
    "packages/runtime/src/semantic-query-gateway.ts",
    "test/architecture/module-press-law.test.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/compiler/inventory-contract.release.golden.json",
    "test/compiler/g2-module-conformance.test.ts",
    "test/evidence/RELATION-INSTALL.expected-red.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/generate-fresh-tenant-full-replay-schema.ts",
    "test/helpers/reachability-producers.ts",
    "test/helpers/rederive-language-coverage.ts",
    "test/integration/surface-data-binding.test.ts",
    "test/integration/table-behavior.test.ts",
    "test/postgres/composed-application.test.ts",
    "test/postgres/declared-list.test.ts",
    "test/postgres/document-numbering.test.ts",
    "test/postgres/drop-ship.test.ts",
    "test/postgres/expected-receipts.test.ts",
    "test/postgres/fresh-tenant-full-replay-schema.snapshot.json",
    "test/postgres/inventory-posting.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/order-lists.test.ts",
    "test/postgres/request-runtime-view.test.ts",
    "test/unit/canonical-model/surface-composition.test.ts",
    "test/unit/canonical-model/field-numbering.test.ts",
    "test/unit/canonical-model/surface-list.test.ts",
    "test/unit/commercial-amounts.test.ts",
    "test/unit/drop-ship-mutation-guards.test.ts",
    "test/unit/purchasing-definition.test.ts",
    "test/unit/sales-definition.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    { "path": "packages/domain/src/app/drop-ship.ts", "name": "withDropShip" },
    { "path": "packages/postgres-provider/src/drop-ship-executor.ts", "name": "DROP_SHIP_CAPABILITY_EXECUTOR_FACTORY" },
    { "path": "packages/postgres-provider/src/drop-ship-support.ts", "name": "dropShipBound" },
    { "path": "packages/postgres-provider/src/drop-ship-support.ts", "name": "dropShipRevision" },
    { "path": "packages/postgres-provider/src/list-progress-read-model.ts", "name": "additionalListProgressSql" }
  ]
}
```
