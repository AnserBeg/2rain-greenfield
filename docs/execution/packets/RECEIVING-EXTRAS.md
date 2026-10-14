# RECEIVING-EXTRAS — receipts dated the day goods arrived, corrected line by line, and shortage net of what is on order

Status: executable on [draft PR #33](https://github.com/AnserBeg/2rain-greenfield/pull/33) against `packet/INTEGRATION`; no merge, no deployment. Sole BUILD lane under the owner's standing instruction (recommended choices taken, recorded here, reported at the end).
Tier: outside the Critical set — canonical v6 keys, the compiler's surface floor and agent presets, the shared List contract and gateway, the list statement, the fulfillment read model, the web runtime and domain metadata. No posting-kernel, serializer, materializer, activation, verification, trust, migration or grant change: the date window and corrections are the kernel's existing rules (POSTING-FORWARD-DATE; `assertReceiptCompensation`). Stops: none.
Base: `origin/packet/INTEGRATION` at `8c8cfab1`. Reference: PaneFlow `d057daff` (`app/inventory-app.tsx` "Received on"; `lib/server/inventory-domain.ts` `reverseReceipt`, `salesBlockedSupply`; `lib/domain/sales-availability.ts`). Closes PURCHASING-PARITY P13's date, ORDER-PARITY OE's correction and SUPPLY-WARNINGS' deferred incoming purchase orders.

## Claims

1. Both receive Tasks (one line; a truck of lines) ask **Received on** — an instant input that starts at the request clock's now, in the explicit-UTC picker, to the second — and write it as the receipt's `effective_at`; an entered value is kept. The kernel admits it up to seven business days back, never after the company's today and never in a closed period; a refused date writes no movement.
2. `compositionInput.defaultNow` (optional v6 key): only on an `instant` input asked once; anything else is refused by name.
3. The goods receipt page is a composition: number, purchase order (opened by **Open purchase order**), state, kind, received at, location, packing slip, the receipt it corrects; **Receipt lines** with Reversible from the receiving read model; **Corrections and reversals** (receipts superseding it); the receiving links stay below.
4. **Correct receipt** (on a posted initial receipt): rows are the lines with something reversible, each with "Quantity to take back" (filled from Reversible), a required reason; it creates a draft receipt of kind `correction` superseding the receipt, at its location and order, one line per entered row compensating that line's movement at the negative of the entered quantity with the line's item, unit and cost, then posts it through `goods_receipt_post`. A line left empty is untouched. The kernel refuses taking back more than the order line received (`RECEIPT_QUANTITY_OUT_OF_BOUNDS`, checked first), more than the receipt's line still adds (`RECEIPT_CORRECTION_INVALID`) and a closed order; two racing corrections admit one.
5. A step binding may take back an input (`{source:'input', negated:true}`, optional v6 key): only a quantity input, only into `values`/`patch`; the web writes the admitted positive decimal's negative. A step may write a relation of its record only when the page names it (a column or a link), so the record's get states it.
6. `surface.list.progress.supply.incoming` (optional v6 key, 1-4 supply sums) with `outputs.incoming`, declared together: per item, what free stock leaves uncovered is next covered by incoming supply, never below zero; `short` is what neither covers and `incoming` what it covers, both in `shortIn` states, before the count, the page and the export; the gateway authorizes the incoming queries per request like every supply read; agent presets publish them.
7. The Sales orders List sums as incoming each active line of a **released** purchase order (Place order keeps an order released) at ordered less its received projection, never below zero; an **On order** column follows Short (12 of 12 columns); **Blocked by supply** keeps a confirmed order only if it is still short after that.
8. The order page's Fulfillment lines state **On order** beside Short from the same queries (released orders by an exact filter on their stored state), allocated in line order after free stock, one formula with the List; a denied incoming read states neither (the List withholds its supply whole, "Short and On order are withheld…").
9. The posting kernel's `RECEIPT_FORWARD_DATE_REFUSED`/`INVENTORY_FORWARD_DATE_REFUSED`, `INVENTORY_BACKDATE_LIMIT_EXCEEDED`, `INVENTORY_PERIOD_CLOSED`, `RECEIPT_CORRECTION_INVALID`, `RECEIPT_QUANTITY_OUT_OF_BOUNDS` and `RECEIPT_ORDER_NOT_RELEASED` read as six catalog messages ("Date is after today", "Date is too far back", "Period is closed", "Correction exceeds the receipt", "Quantity is beyond what was ordered or received", "Order is not released"), each naming the kernel's code as its subject; any other code keeps `OPERATION_REFUSED`.
10. Surface floor 26 when any surface declares claims 2, 5 or 6 (22-25 are held for leaves INTEGRATION has not folded in); runtime support 21 -> 26.

## Decisions

- Received on is an instant, not a calendar date: Rain renders every instant in UTC and the web never reads the tenant calendar, so a date-only input could not name the company's business day; the UTC picker WAREHOUSE-MODE built does, and the kernel judges the day in Calgary (design-critical-small §A recommended "an instant input defaulting to now").
- `defaultNow` is a new key rather than a widened `defaultFrom`: that key means a record field everywhere it is read.
- Correct receipt lives on the receipt page: the purchase order page is at 12 of 12 actions. Reverse receipt stays on the order page; PaneFlow's "Reverse incorrect receipt" is itself partial, so both now exist.
- A correction is dated now and is offered on a receipt of a closed order too (the page cannot read its order's state); the kernel refuses that, in plain language.
- Incoming counts every placed purchase order whatever its expected date, as the prompt defines it; PaneFlow counts only orders due by the sales order's requested date (Filed). Each order sees the whole free stock and all incoming, as R1 and PaneFlow judge each order alone.
- A principal who cannot read purchase orders loses the whole supply (Short "—"), never a Short that ignores what is on order.
- Readable refusals map kernel codes in `operationMessageRef` and keep the code as subject, so existing journeys that read the subject (`INVENTORY_PERIOD_CLOSED`, `RECEIPT_ORDER_NOT_RELEASED`) are unchanged; "Task stopped … Retry" still follows a Task refusal (WAREHOUSE-MODE's filed line).
- The receiving application extension now runs for composed record pages too; the generic order page's receiving section is skipped on a composed page.
- order_pages' short order asks 25 and 9 (was 12 and 9) so it stays short beyond the notebooks on order; its oracle counts incoming, and after the reversal the order is no shorter with the 7 on order again.
- Release: one lineage entry over INTEGRATION's one (6,237,235 -> 12,158,028 B); storage target, verification plan, operation catalog unchanged, so no schema snapshot and no scenario pin moves.
- CI red at `69c83ea4` (run 37480976597), order page On order: a code defect. The page judged an order released by its relation label, which carries the state's display text ("Purchase Order Released"), so the page never counted anything on order while the List did; released orders are now read by an exact filter on the stored state.
- CI red, correction past its order line: the test expected the wrong code. The kernel checks the order line's received bounds before the correction rule, so taking back more than the line received is `RECEIPT_QUANTITY_OUT_OF_BOUNDS`; both refusals are now exercised (a later delivery keeps the line above nothing for `RECEIPT_CORRECTION_INVALID`), and the bounds refusal reads in plain language instead of "Operation refused" (the common case on Correct receipt).
- CI red, runtime refusal text "supports 21": moved with claim 10 (26).
- CI red at `01e43ffa` (run 38488558026), List without purchase order line read: a code defect. The web counted only the coverage and free-stock queries as supply, so a denied on-order read refused the whole List instead of serving it without Short and On order; the incoming sums' queries are now supply reads too.
- Controls run 38488558159 at `01e43ffa`: the two On order controls named a subtest, which Node's name pattern never reaches through a parent that does not match ("executed no test"); both now name the parent test.
- CI red, composed receiving journey: the receipt page is now a composed document (claim 3), so Post sits under Record actions and the revision in Technical details; the journey reads both there (state posted, Active, revision 2).
- CI red, received-at text: the spec expected an ISO date, but every instant reads like "Oct 5, 2026, 2:53 PM UTC"; it now expects that exact text.
- Time zone (checked): Received at shows UTC, as every instant in Rain does, and so does POSTING-FORWARD-DATE (its filed line); only the kernel's "today" uses the tenant calendar (America/Edmonton). Kept; showing instants in the tenant's zone touches every instant, the picker and list dates, so it is filed as its own packet.

## Slices

1. Received on (`RECEIVING-EXTRAS-test-it-yourself.md` §1). 2. Correct receipt (§2). 3. On order (§3, §4).

## Pins moved (measured)

Surface floor grouped 21 -> 26 (flat 20, surfaces 113, navigation leaves unchanged); runtime support 21 -> 26; message catalog 50 -> 56; Purchasing grammar debt 55 -> 53 (the receipt page's childTables); Sales orders List columns 11 -> 12; language coverage 2805 -> 2854 obligations, 946 -> 972 observed; expected-red 168 -> 177 entries in 15 -> 16 manifests; commercial PostgreSQL files 12 -> 13; lineage entries 1 -> 2.

## Controls (`test/evidence/RECEIVING-EXTRAS.expected-red.json`)

`receiving-instant-default-on-any-input` -> 2; `receiving-negated-any-input`, `receiving-record-relation-unnamed` -> 5; `receiving-incoming-without-output` -> 6; `receiving-received-date-starts-empty` -> 1; `receiving-correction-adds-what-was-entered` -> 4; `receiving-refusals-unreadable` -> 9 (now six codes); `receiving-list-short-ignores-incoming` -> 7; `receiving-page-short-ignores-incoming` -> 8.

## Gates

- Local (no container): typecheck, prettier, eslint clean; release `--check` and demo `--check` PASS; unit 249/249; compiler 175/175; web contracts 47/47; architecture without its three Docker-backed files 150 (after the debt baseline move); expected-red static OK (177 in 16); `receiving-instant-default-on-any-input` killed and restored locally (`--run`).
- PostgreSQL and browser: owed to CI (another lane held the exclusive lock; Windows free memory under 1.2 GB at times).

## Test it yourself

`RECEIVING-EXTRAS-test-it-yourself.md`: §1 the day goods arrived, §2 correct part of a receipt, §3 short unless on order, §4 without purchase order read.

## Filed

- A refused receive or correction leaves its draft receipt (created by the Task's earlier steps); it moves no stock and can be edited and posted or left. A pre-check before the first step would need the window in the web.
- Incoming ignores expected dates; PaneFlow's "due by the requested date" needs a correlated date rule in the supply grammar.
- Received on is a UTC date and time (POSTING-FORWARD-DATE's filed line): at 7 pm in Edmonton the picker's default reads tomorrow's UTC date; left alone it books today, but "fixing" it to today's date books yesterday. Proposed packet: show instants in the tenant's zone.
- The order page reads at most 1,000 purchase order lines of an item and 1,000 released orders; beyond that its Fulfillment lines fail rather than guess (as its stock reads already do).
- `parseSharedListSupply`'s incoming pairing is covered by the canonical validator and the gateway path, not by its own unit test.

Review: not owed — outside the Critical set.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "RECEIVING-EXTRAS",
  "base": "8c8cfab1c54ac1b51b4617e45f8e2f0ddd1dfa1b",
  "head": "69c83ea4908b2eac6a03b54210bac8cd7e9382e2",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts",
    "apps/web/src/gateway-error-codes.ts", "apps/web/src/list-declaration.ts", "apps/web/src/message-catalog.ts",
    "apps/web/src/receiving-section.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/declared-list.spec.ts", "apps/web/test/browser/message-catalog.spec.ts", "apps/web/test/browser/receiving-extras.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts", "package.json", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts", "packages/canonical-model/src/surface-list.ts", "packages/compiler/src/projections.ts",
    "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts", "packages/domain/src/purchasing/workspace.ts",
    "packages/domain/src/sales/workspace.ts", "packages/postgres-provider/src/fulfillment-read-model.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/runtime/src/list-behavior/index.ts", "packages/runtime/src/list-behavior/supply.ts", "packages/runtime/src/request-runtime-view.ts",
    "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.baseline.ts", "test/architecture/surface-grammar-conformance.test.ts",
    "test/evidence/RECEIVING-EXTRAS.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/order-entry-fixture.ts",
    "test/helpers/reachability-producers.ts", "test/integration/surface-data-binding.test.ts", "test/postgres/declared-list.test.ts",
    "test/postgres/order-lists-supply.test.ts", "test/postgres/order-lists.test.ts", "test/postgres/order-pages.test.ts",
    "test/postgres/receiving-extras.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/canonical-model/surface-composition.test.ts",
    "test/unit/canonical-model/surface-list.test.ts"
  ],
  "symbols": [
    {"path": "packages/domain/src/purchasing/workspace.ts", "name": "receiptWorkspace"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "salesSupply"},
    {"path": "packages/canonical-model/src/surface-composition.ts", "name": "validateSurfaceCompositions"},
    {"path": "packages/canonical-model/src/surface-list.ts", "name": "validateSurfaceLists"},
    {"path": "packages/runtime/src/list-behavior/supply.ts", "name": "parseSharedListSupply"},
    {"path": "packages/runtime/src/list-behavior/supply.ts", "name": "sharedListSupplyReads"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listSupplyPlan"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listSupplyFromSql"},
    {"path": "packages/postgres-provider/src/fulfillment-read-model.ts", "name": "fulfillmentReadModel"},
    {"path": "packages/compiler/src/projections.ts", "name": "agentSupply"},
    {"path": "apps/web/src/gateway-error-codes.ts", "name": "operationMessageRef"},
    {"path": "apps/web/src/message-catalog.ts", "name": "SURFACE_MESSAGE_CATALOG"},
    {"path": "packages/runtime/src/request-runtime-view.ts", "name": "SUPPORTED_RUNTIME_CAPABILITIES"}
  ]
}
```
