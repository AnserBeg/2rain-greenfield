# DROP-SHIP — supplier delivery directly to the customer

Status: unfinished BUILD on `packet/DROP-SHIP`, PAYABLES `b91c5284` and RELATION-INSTALL `66cf178a` merged. Bridge draft [PR #20](https://github.com/AnserBeg/2rain-greenfield/pull/20) has full green CI; its controls and owner review remain owed. DROP-SHIP draft [PR #19](https://github.com/AnserBeg/2rain-greenfield/pull/19) awaits post-bridge validation. No main merge or deployment; own Critical set unchanged.

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

## Gates

- Implemented: route/supplier entry, linked PO creation/reuse and customer ship-to, bounded numbered delivery/reversal, physical-vs-delivered read models/settlement/closure, declared Lists, both order sections and delivery Record/Tasks. These are code/declaration claims, not successful PostgreSQL/browser execution claims.
- Changed unit, integration and web-contract files: 119/119 pass. Canonical route/bounds checks 2/2 and full tsc pass again after removing the alternative link-record experiment. Focused inventory-contract golden 1/1 and test registration 2/2 pass; surface grammar 25/25 pass.
- Combined hygiene/grammar run: 35/36; one lock-control test was refused by its live-container contamination guard during this packet's exclusive schema replay. Registration checks independently pass. Lint has no errors; formatting and diff whitespace checked.
- Exact-base release rebuild/check passes: five inherited entries plus one; 104 surfaces, 16 navigation leaves, 604 scenarios, 527 constructible candidates / 77 without a create operation. PostgreSQL has NOT observed those execution pins yet. Both numbering pin lists include DSD: 11 fields, 11 uniqueness probes, measured from compiled assigned fields.
- Coverage declaration inventory re-derived: 2658 obligations / 824 observed declarations. Local coverage gate refused missing reachability receipts; no execution receipts were invented.
- Prior full-replay generation and CI failed with `ELEMENT_TARGET_MISSING` on `purchase_order_line_sales_line`; the failed generator cleaned its container and did not rewrite the snapshot. RELATION-INSTALL is now merged; post-bridge regeneration remains pending.
- New commercial PostgreSQL journey is registered in package scripts, reachability and hygiene; its first local attempt never started (lock busy). New `purchase-drop-ship.spec.ts` is operations-browser reachable; browser not run. Full DROP-SHIP CI acceptance remains unmet.
- Post-bridge correction: two existing unit files now account for DSD numbering, the exact sales-line/order relation and the fourth registered sales-order operation. Focused 14/14 PASS; formatting, typecheck and release `--check` PASS. Coverage re-derived again from unchanged declarations.
- Hosted run `37271614092` is red: compiler input/fixture pins, browser backend-loader failure and opaque generic guard refusal. Corrected at `e9751adc`: Sales command module, retained references, typed refusal, scoped browser loader and fixture closure. Four changed compiler/unit files PASS 93/93; lint/format/typecheck PASS. Full new CI remains pending.
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
  "base": "b91c5284e163d19a834802479dd2dc1e3a1201d1",
  "head": "e9751adcc60e42e8ea23dc71092fc8c504796c28",
  "changedPaths": [
    "apps/api/src/composition-root.ts",
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json",
    "apps/web/src/component-registry.ts",
    "apps/web/src/list-declaration.ts",
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
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/compiler/inventory-contract.release.golden.json",
    "test/compiler/g2-module-conformance.test.ts",
    "test/evidence/RELATION-INSTALL.expected-red.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/generate-fresh-tenant-full-replay-schema.ts",
    "test/helpers/reachability-producers.ts",
    "test/helpers/rederive-language-coverage.ts",
    "test/integration/table-behavior.test.ts",
    "test/postgres/composed-application.test.ts",
    "test/postgres/document-numbering.test.ts",
    "test/postgres/drop-ship.test.ts",
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
    { "path": "packages/postgres-provider/src/list-progress-read-model.ts", "name": "additionalListProgressSql" }
  ]
}
```
