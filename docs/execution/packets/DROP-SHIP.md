# DROP-SHIP — supplier delivery directly to the customer

Status: BUILD complete, evidence-ready on `packet/DROP-SHIP`; [draft PR #19](https://github.com/AnserBeg/2rain-greenfield/pull/19), all 11 CI jobs green at `39c721ae`, executable freeze `9c349098`. PAYABLES `96ac2341` and RELATION-INSTALL checkpoint `f3330e98` are merged. Bridge [draft PR #20](https://github.com/AnserBeg/2rain-greenfield/pull/20) is fully green with three hosted red/green controls; its owner review remains owed. No main merge or deployment; own Critical set unchanged.

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

- [Full CI at `39c721ae`](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37292271053) PASS: all 11 jobs, including quality/build, three PostgreSQL jobs, three browser jobs, performance, security, observability and executed-file reachability. This observes executable freeze `9c349098`; this final record update is narrative only.
- `test/postgres/drop-ship.test.ts` PASS in the commercial job: linked PO reuse, ship-to, supplier/permission/bounds refusals, idempotent delivery, no stock movement, delivered vs physical figures, invoice/bill totals, reversal floors, preserved reversed facts, open views and closure. Its unused Reserve-stock rejection draft is archived through the gateway before final Close; the stock close rule is unchanged.
- `purchase-drop-ship.spec.ts` PASS in operations: declared selection/actions, linked order, placed PO, no stock actions, numbered delivery on both pages and reasoned reversal. Unit, compiler, integration, architecture and web-contract tests, typecheck, lint and formatting PASS in CI.
- Exact-base release rebuild/check PASS: five inherited entries plus one; 104 surfaces, 16 navigation leaves, 604 scenarios / 527 executed / 77 derived. Composed PostgreSQL observes these pins and full recorded-lineage replay. Sales constrained scenarios are 48; both numbering lists contain 11 fields and 11 uniqueness probes, measured from compiled assigned fields.
- Coverage re-derived: 2658 obligations / 824 observed declarations; hosted coverage and whole-repository executed-file reachability PASS. The new PostgreSQL file is registered in commercial scripts, exclusion glob, producers and hygiene; its browser name selects the operations job.
- [Hosted full-replay schema regeneration](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37279897119) at `5d2d9027` PASS; snapshot committed at `88ce5ce6` and matched by the green composed test. Release/schema definition bytes are unchanged since generation; no product re-baseline.
- Earlier local PostgreSQL attempts failed at string revisions and canonical delivery filters; both containers were removed. The actual driver `bigint` boundary is now normalized outside trust. Local browser was not run below the Windows memory minimum; no local green or execution receipt is invented.
- Earlier hosted reds corrected copied quantity/date inputs, declared navigation, fixtures/pins, progressive Release access and the successor/empty-selector fixture pairing. Test CHECKPOINTs recycle WAL; exact head-source transition fixtures retain all assertions. No timeout, readiness, capacity or performance threshold changed. One indeterminate run received one whole-workflow retry; its performance passed before the superseding push cancelled that run.
- Static expected-red validation PASS (165 entries / 14 manifests) after upstream merge. Critical relation-install controls and their red/restore-green evidence are in [RELATION-INSTALL](RELATION-INSTALL.md); no additional Critical production change is in this slice. Record fidelity and whitespace checks PASS before push.

## Test it yourself

[DROP-SHIP-test-it-yourself.md](DROP-SHIP-test-it-yourself.md) gives the validated workflow and the shared-machine memory/lock instructions.

## Filed

- Dedicated `special_order` supply is the next increment, not a silently accepted route.
- Owner selected the separate Critical relation-column bridge; it is merged here under authorized step 6, with its materializer change, test and controls declared below. Owner review remains on PR #20. The rejected intermediary link-record experiment left no runtime artifacts.
- Program review: not run; this clean but non-integrated draft checkpoint meets the non-integrated-tree anti-trigger. Re-evaluate at integration; no autonomous review.

Review: no separate DROP-SHIP arm; inherited Critical bridge owner-run review is owed on PR #20. Draft PRs against PAYABLES only; no integration or deployment.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "DROP-SHIP",
  "base": "96ac234122322b2cbe18349299664f56c8f5190a",
  "head": "9c349098f62c25e627570315533b08d85677d4ce",
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
