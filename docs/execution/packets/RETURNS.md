# RETURNS — goods back from customers and back to suppliers, through the posting kernel

Status: slices 1 (customer returns) and 2 (vendor returns) executable on draft PR #15 (base `packet/PAYABLES`); no merge, no deployment. Sole LOCAL BUILD under the owner's standing instruction (2026-09-30); four pauses taken on the coordinator's word (network, owner, shutdown, battery).
Tier: **Critical** — the posting kernel (`inventory-posting-service.ts`) and `db/migrations/0029_returns_posting.sql`; context it calls: `goods-receipt.ts`, `received-quantity-projection.ts` (the received rebuild the materializer runs), `fulfillment.ts`. One ONLINE arm is owed: `RETURNS-review-prompt.md`.
Base: `packet/PAYABLES` at `b91c5284` (merged at `0aa4f9a1`; `681f4675` before it, at `d1488446`); design `RETURNS-design.md` (`8780e8e9`).

## Owner rulings (2026-09-30, the recommended choice taken)

- Returns are allowed on confirmed and closed sales orders; invoicing is unaffected (credit stays a separate step).
- Location statuses (quarantine, damaged) come later; any active location is a valid source or destination (R-C).
- A vendor return is net of received; a refund is the return plus the existing "Close open remainder" (R-A).
- One RETURNS packet with one Critical review arm (R-B).

## Claims

Customer returns (`customer_return` family of `northstar.sales:capability.fulfillment`, digest version 7):
1. B1. Per sales order line, net returned plus what a return attempts stays between zero and net shipped, read from the ledger (`returnedLedger`, `shippedLedger`) inside the posting; an over-return is refused (`FULFILLMENT_RETURN_QUANTITY_OUT_OF_BOUNDS`) with the order line, shipped, returned-before and attempted quantities.
2. B2. A return lands in its chosen location and leaves shipped, the shipped row and the reservations untouched: what may still come back is net shipped less net returned.
3. B3. A shipment correction or reversal may not take a line's net shipped below its net returned (`FULFILLMENT_SHIPMENT_BELOW_RETURNED`).
4. B4. Returns and shipment corrections of one order serialize on the order row, then its line rows (FOR NO KEY UPDATE), taken before either ledger is read, so two returns into two locations cannot together exceed what shipped.
5. B5. A correction or reversal names a posted return of the same order and takes back only that return's own movements, each once, from where they went, never more than a movement still adds; a reversal takes back all.
6. B6. The return, its companion transaction and lines are read back column for column before commit (`verifyCustomerReturnPosting`), and the executed verifiers cover the observed write set.
7. B7. Digest version 7 covers every header field and line: the same key with a changed return conflicts; a duplicate delivery replays without posting again; a retry under a later policy revision is digested with the recorded invocation's policy evidence and replays (as a receipt's version 5 does).

Vendor returns (`vendor_return` family of `northstar.purchasing:capability.receiving`, digest version 8):
8. V1. Per purchase order line, a vendor return never takes net received below zero, read from the ledger inside the posting; refused (`VENDOR_RETURN_QUANTITY_OUT_OF_BOUNDS`) with the order line, received-before and attempted.
9. V2. Received is net of vendor returns (`receivedLedger` adds each return line's negative movement): the posted received row falls by the quantity sent back, the line reopens to receive, and a receipt correction cannot take back returned units.
10. V3. The independent received sweep (`receivedFacts`) counts each posted vendor-return movement through its own lineage, so reconciliation reports no discrepancy after a return.
11. V4. Destroying and rebuilding the received rows (`reconstructedReceivedFacts`) reproduces each line net of its vendor returns, verified by the sweep.
12. V5. Vendor returns of one order serialize on the order row and its line rows before the received ledger is read.
13. V6. The vendor return, its companion transaction and lines, and each line's received row are read back before commit (`verifyVendorReturnPosting`), the received rows against the ledger recomputed after the write.
14. V7. Digest version 8 covers every header field and line, and a retry replays under a later policy revision, as B7.

Outside the Critical set:
15. Sales declares `customer_return` (RMA- numbers) and its lines, written only as drafts and posted through `customer_return_post`; Purchasing declares `vendor_return` (VRT-) and its lines behind a `vendorReturns` option the product application passes, posted through `vendor_return_post`. Migration 0029 admits digest versions 7 and 8.
16. Through metadata: a Returned column and "Receive return" on a confirmed or closed order's shipped line, offered while the read model states something returnable; the order's Returns, a selected return's lines with what each still adds, and "Reverse return" (a reversal draft naming each movement, the ORDER-PARITY mechanism); a return page and a Returns List. "Return to vendor" on a released order's received line, and its Vendor returns. Both tasks require their notes: the composed tenant's posting configuration requires a reason narrative.

## Decisions

- Returned lives in the fulfillment read model beside Shipped (the design named the commercial one); it sums the posted customer-return movements of the line's return lines under current policy, and a withheld read states nothing.
- Reverse return is the declared multi-row reversal over a read model naming each line's movement (ORDER-PARITY's Reverse receipt), not a new executor command; the kernel's compensation check is the rule.
- A vendor return needs a released purchase order, as a receipt does (PaneFlow: an approved order): it reopens the line to receive, which a closed order cannot carry; reopen first. The owner's "confirmed and closed" is read as the Sales ruling.
- A vendor return has no correction or reversal document: a mistaken one is undone by receiving again (the line reopened). Any active location may be the source; negative stock and live reservations still refuse.
- Customer and vendor returns are two families with their own digest versions (7, 8) and one migration.
- Both new PostgreSQL files take order-pages' 600 s bound: seven claims each over one composed application.
- The two slices went out as one first increment with one lineage entry (6, rebuilt from the PAYABLES envelope): slice 1 was not yet pushed when its first run found the notes defect, whose fix moved its release.
- POSTING-FORWARD-DATE (PR #9, not in this base) refuses postings dated after the tenant's today for every family; once both land, returns must fall under it. Until then a return is refused after today exactly as a shipment is.
- Composed-application's advancement and ADR-0047 rollback-edge parents run on a 1 GB data volume, as the full-replay generator does (`28461658`): with lineage entry 6 both filled the default 256 MB (sqlstate 53100, CI run 37258323455). No assertion, timeout or readiness bound changed; every other test keeps 256 MB.

## Slices

1. Customer returns: `a1c7a702` (kernel family, migration 0029, Sales entities and surfaces). Test it yourself §1-§3.
2. Vendor returns and the slice-1 fixes: `4e2efed2`; controls `f67610a3`, `16b6730c`; B5's last step `e918a78c`; snapshot `fc13a15f`; CI pins `e63f17dd`; PAYABLES `b91c5284` merged `0aa4f9a1`. Test it yourself §4.

## Controls

`test/evidence/RETURNS.expected-red.json`, one or two per claim, each `--run` under the lock on AC power with at least 2 GB free:
- `return-bound-removed` B1 (kills B1, B4): reproduced at `e63f17dd`: restored 8 passing, 2 killed.
- `returns-counted-as-unshipped` B2 (kills B2): reproduced at `0aa4f9a1`: restored 8 passing, 1 killed.
- `shipment-guard-removed` B3 (kills B3): reproduced at `0aa4f9a1`: restored 8 passing, 1 killed.
- `return-order-lock-dropped` B4 (kills B4): owed: not run.
- `return-correction-accepts-foreign-movement` B5 (kills B5): owed: not run.
- `return-verifier-call-deleted` B6 (kills B2, B3, B4, B5, B6, B7): owed: not run.
- `return-digest-drops-quantities` B7 (kills B7): owed: not run.
- `return-replay-hashes-current-policy` B7 (kills B7): owed: not run.
- `vendor-return-bound-removed` V1 (kills V1, V5): owed: not run.
- `received-ledger-ignores-vendor-returns` V2 (kills V2, V3, V5): owed: not run.
- `received-sweep-ignores-vendor-returns` V3 (kills V3, V4): owed: not run.
- `received-rebuild-ignores-vendor-returns` V4 (kills V4): owed: not run.
- `vendor-return-order-lock-dropped` V5 (kills V5): owed: not run.
- `vendor-return-verifier-call-deleted` V6 (kills V2, V3, V4, V5, V6, V7): owed: not run.
- `vendor-return-digest-drops-quantities` V7 (kills V7): owed: not run.
- `vendor-return-replay-hashes-current-policy` V7 (kills V7): owed: not run.

## Gates

(paused for a restart; filled at freeze)

## Test it yourself

`RETURNS-test-it-yourself.md`: §1 take goods back from a customer, §2 reverse a return, §3 the Returns List, §4 send goods back to the supplier.

## Filed

- Lines of posted documents (shipment, receipt and return lines) carry no update guard of their own, so a generic update could re-point a posted line and shift a ledger that attributes through it; a class older than this packet.
- Source-document reconciliation reports a return's companion transaction as an unrecognized type (unverifiable), as it does a shipment's.
- Credits for returns stay separate steps (customer credit, vendor credit); a return does not propose one.

Review: owed — `RETURNS-review-prompt.md` (round 1, ONLINE, user-run).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "RETURNS",
  "base": "b91c5284e163d19a834802479dd2dc1e3a1201d1",
  "head": "0aa4f9a14ae50745184f1592d612c17e28a7cd87",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/release/current-policy-bindings.json", "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/returns-receiving.spec.ts", "db/migrations/0029_returns_posting.sql", "db/schema.snapshot.json", "package.json",
    "packages/compiler/src/conformance.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts", "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/inventory/contracts.ts", "packages/domain/src/inventory/definition.ts", "packages/domain/src/purchasing/definition.ts", "packages/domain/src/purchasing/workspace.ts",
    "packages/domain/src/sales/definition.ts", "packages/domain/src/sales/workspace.ts", "packages/postgres-provider/src/fulfillment-capability-executor.ts", "packages/postgres-provider/src/fulfillment-read-model.ts",
    "packages/postgres-provider/src/fulfillment.ts", "packages/postgres-provider/src/goods-receipt.ts", "packages/postgres-provider/src/inventory-posting-error.ts", "packages/postgres-provider/src/inventory-posting-service.ts",
    "packages/postgres-provider/src/received-quantity-projection.ts", "packages/postgres-provider/src/receiving-capability-executor.ts", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.baseline.ts", "test/architecture/surface-grammar-conformance.test.ts", "test/compiler/inventory-contract.release.golden.json", "test/evidence/RETURNS.expected-red.json",
    "test/helpers/order-entry-fixture.ts", "test/helpers/reachability-producers.ts", "test/postgres/composed-application.test.ts", "test/postgres/customer-return.test.ts",
    "test/postgres/document-numbering.test.ts", "test/postgres/fresh-tenant-full-replay-schema.snapshot.json", "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/trust-substrate.test.ts", "test/postgres/vendor-return.test.ts", "test/unit/canonical-model/field-numbering.test.ts",
    "test/unit/canonical-model/surface-list.test.ts", "test/unit/purchasing-definition.test.ts", "test/unit/sales-definition.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "returnedLedger"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "lockCustomerReturn"},
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "assertCustomerReturnBounds"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "assertCustomerReturnCompensation"},
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "assertShipmentKeepsReturnedUnits"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "writeCustomerReturnConsequences"},
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "verifyCustomerReturnPosting"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "lockVendorReturn"},
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "assertVendorReturnBounds"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "writeVendorReturnConsequences"},
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "verifyVendorReturnPosting"}, {"path": "packages/postgres-provider/src/goods-receipt.ts", "name": "receivedLedger"},
    {"path": "packages/postgres-provider/src/goods-receipt.ts", "name": "VendorReturnCommand"}, {"path": "packages/postgres-provider/src/received-quantity-projection.ts", "name": "receivedFacts"},
    {"path": "packages/postgres-provider/src/received-quantity-projection.ts", "name": "reconstructedReceivedFacts"}, {"path": "packages/postgres-provider/src/fulfillment.ts", "name": "CustomerReturnCommand"},
    {"path": "packages/domain/src/sales/workspace.ts", "name": "returnWorkspace"}, {"path": "packages/domain/src/app/list-declarations.ts", "name": "returnList"},
    {"path": "packages/domain/src/purchasing/definition.ts", "name": "vendorReturnOperations"}
  ]
}
```
