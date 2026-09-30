# PURCHASING-PARITY — Rain's purchase orders at PaneFlow parity through metadata

Status: slices 1-3 (priced purchase orders and RCV numbers; ending an order; receiving paperwork without the received-on date) executable and pushed (draft PR #8 on `packet/SALES-PARITY`); slice 4 chartered; no merge, no deployment. Sole LOCAL BUILD, chartered by the owner on 2026-09-29 ("continue to what is left ... the other components ... without me"; recommendations accepted, decisions reported at the end).
Tier: outside the Critical set — storage columns are added through the existing `addColumn` path (SALES-PARITY claims 10-11); slice 2 changes receiving's order lifecycle and amend path (`purchasing-order-lifecycle.ts`, `receiving-order-capability.ts`), not the posting kernel; no verification, trust, migration or grant change.
Base: `packet/SALES-PARITY` at `b1aefa05`, merged in (stacked on draft PR #7; slice 1 was cut at `f0a38e76`). Reference: PaneFlow `d057daff` read from source; audit in `PURCHASING-PARITY-inventory.md`.

## Owner rulings (recommended, taken under the owner's standing instruction)

- PA: ruling B extends to purchase orders. A PO carries payment terms, a tax code that new lines start from, a line discount %, a tax rate frozen per line and per charge, freight and an other fee each with a code, exact half-up per-line amounts and totals, one currency (no FX). The v1 plan's "no tax on orders" boundary (`purchasing-sales-v1-plan.md` §6, §7.3) moves for POs as ruling B moved it for sales orders. No accounting, payable or ledger posting follows.
- PB: a supplier's defaults are its Party defaults (currency, terms, tax code), as PaneFlow keeps one set per business partner; the expected date starts 14 days out, PaneFlow's default.
- PC: a unit cost is typed; defaulting it from a last cost or a standard cost waits for an item cost field (inventory packet).

## Slices

1. Priced purchase orders (P3, P4, P23) and RCV receipt numbers (P1): terms, tax, discount, charges, totals, printed totals.
2. Ending an order (P8, P9) and what is still open per line (P10 in part): Cancel refused once anything is received; a line's open remainder closed with a reason; Received and Open on each order line.
3. Receiving paperwork (P13 in part, P14): packing slip and notes on a receipt; a purchase order's "Receive into" location that receiving starts from. The received-on date waits for its kernel rule (Filed).
4. What is still to arrive (P11, P26; P10 in part): an Expected receipts List of released orders with Ordered, Received and Open summed in the list statement, To receive / Late / All released views and a days-late marker; Receive is no longer offered on a line with nothing open. The Purchase orders List's figures and Total move to ORDER-PARITY.
Deferred to their own packets: approvals and "place order" (P5-P7), vendor bills (P21), vendor returns and drop ship (P19-P20), inventory (transfers, count and opening posting routes, availability, reorder rules, lot/serial, valuation, units).

## Claims

1. A purchase order in the product application declares payment terms (the Party's labels), a tax code, freight and other fee with codes and frozen rates; each line a discount % and a tax code with a frozen rate. All optional; a purchasing-only compile declares none of them (`commercialTerms` factory option), since they read Catalog tax codes.
2. Choosing the supplier resets currency, terms and tax code to its Party defaults; each new line's tax code starts from the order's; a rate is frozen from its code when chosen; a never-saved order's expected date starts 14 days out.
3. The commercial read model states a purchase order's line amounts and tax, subtotal, charges, tax and total exactly as a sales order's (half up per line, one currency; an unstated figure is null and nulls every total it feeds), under two purchase bindings of the same capability; a purchase line states no price basis. Totals re-enter current authority over the lines.
4. The purchase order page reads its record through `commercial_purchase_order_get`: facts show terms and the total; Priced lines show unit cost, discount, tax code, tax and amount; money reads with two decimals; the printed order carries the priced lines and totals (Subtotal, Freight, Other fee, Tax, Total). Receiving is unchanged.
5. A goods receipt takes a server-assigned `RCV-000001` number on its first save, through the numbering SALES-PARITY built (claims 7-9, 21 there); the receive task no longer binds a generated id, and the receiving kernel reads the stored number as before.
6. The committed cancel runs through receiving, under the order's and its lines' locks, and is refused after any net receipt on any active line (`RECEIPT_QUANTITY_OUT_OF_BOUNDS`), as a sales order's is after any net shipment; the draft cancel stays a plain transition. Close, reopen and cancel each carry their state guard, so none is offered in another state.
7. Each order line states Received and Open, read from the receiving projection through its own get under current policy: a denied read states neither (and answers for every line of the call), an unanswered one is not a zero, and a release whose purchase lines declare no progress states none.
8. "Close open remainder" stages an amendment request marked `close_remainder` with a required reason and applies it through the receiving amend, which sets the ordered quantity to what is received when it runs, under the line's lock, and consumes every close request staged for that line revision together; a plain quantity request beside a close request is refused as two intents. The order then closes. A task binding a record revision into an integer field writes the field's canonical string.
9. A goods receipt carries an optional packing slip and notes, entered in both receive tasks and shown among the order's connected receipts; an empty optional task input reaches its operation as `null`.
10. A purchase order may name a "Receive into" location (a picker in the editor, a detail on the page); both receive tasks start their location from it. A reference task input may declare `defaultFrom` a record field (optional v6 key; refused on other inputs and on a field the record query does not select).
11. List progress (optional v6 `surface.list.progress`): a List may sum per row, in the PostgreSQL list statement, its document's active lines and the active done rows of those lines, before the count, the page and the export, pinned to the row's tenant, environment and company and the issued read scope; open = ordered − done, zero outside the declared states. The gateway authorizes both progress queries under current policy on every request (a denial refuses by name) and requires the executor to echo them; the figures are non-sortable values.
12. A view may keep rows with open quantity (`open`) or before today (`before`, anchor `startOfTodayUtc`): the release holds no date; the web runtime resolves the anchor per request from an injectable clock, the cursor binds it and SQL applies it before count and page; a date column's `overdue` marks "N days late" from the same anchor. Surface floor 11 -> 12; agent presets publish progress, open and before.
13. Purchasing -> Expected receipts lists released orders with open quantity: To receive (default), Late, All released, CSV; a user without receipt read has it refused by name while Purchase orders still serves.
14. A line with nothing open (`open_to_receive` exactly 0) offers no Receive action; a withheld Open keeps it offered, and the receiving kernel refuses over-receipt anyway.

## Decisions

- The purchase bindings live on Sales' `commercial` capability (one executor, parameterized by document), and the purchase commercial queries are added by `salesWorkspaceQueries` only when purchasing is composed.
- A separate "Priced lines" section, as on the sales order: the existing "Order lines" section keeps driving receiving selection unchanged.
- P8 is not a quick fix: Cancel after receipts was the only way to end a partly received order, because Close requires nothing open. Slice 2 therefore adds closing a line's open remainder with the refusal, and comes before the paperwork: it closes an integrity gap.
- A remainder is closed per line, as PaneFlow closes open units, through the existing amendment request (ADR-0038's staged intent) rather than a new order-level input. A close request is resolved when it applies, not when it is staged, after an in-lane check (a subagent reading the diff, not a review arm; none is owed outside the Critical set) showed a receipt posted in between could strand the line with requests that no retry could apply.
- Received and Open ride the commercial purchase-line read model rather than a new receiving read model: one executor, parameterized by document.
- The received-on date is split out: with the kernel's 0-day backdate window the only valid receipt date is today, which is already stamped; it follows POSTING-FORWARD-DATE (a 7-day window and one forward-date rule for every posting family).
- Expected receipts lists ORDERS, as PaneFlow does (a line List would need filters on the parent's state and more than one label per relation); its figures sum units across items, as PaneFlow's do. "Today" is the UTC day every List date is shown in; the release holds no date.
- The Purchase orders List is untouched here, so nobody without receipt read loses a screen; its figures and Total come with ORDER-PARITY's supplementary progress. Progress policy decisions name the listed companies; where two Lists read one entity, the List owning its record workspace stays the picker, breadcrumb and navigation authority.

## Controls

None owed: nothing in the Critical set changes.

## Gates

- `3fbb78d1` (own worktree, AC, host paging under 1 GB free): release `--check` PASS (lineage entry 23); unit `purchasing-definition` 37/37, `workspace-contract` + `sales-definition` + `surface-list` 25/25; integration receiving 3/3; surface grammar and hygiene 36/36; compiler 175/175; typecheck clean; coverage re-derived (739 -> 738 observed).
- `9500dea2`: the full-replay schema snapshot regenerated over the lineage; it differs only by eleven nullable columns, their UPDATE grants and the NOT VALID payment-terms check. PostgreSQL commercial-totals 2/2, document-numbering 1/1 (RCV-000001, every numbered entity's scenarios executed), composed-application 18 pass, 0 fail, 2 cancelled (parts 8 and 9 each stopped by their 300 s bound before any assertion, under 1 GB free).
- `13f35063`..`3cbb2de7`: running them found test drift this slice caused, fixed there: the receiving tests typed a now-assigned receipt number; the receiving journey and the receipt posting test addressed the order page by the plain get's company parameter (the page reads its totals query) and the posting test's gateway had no commercial read model; the pricing journey expected zero seconds and a secondary column in its own cell. Then receiving-authorization 7/7, browser purchase-pricing 1/1 and the composed receiving journey 1/1 (a filtered browser run exits 1 by the reachability reporter's own rule).
- `ba21d043` (rebased onto SALES-PARITY `f0a38e76`, whose slot order puts a document's lines first; this slice becomes lineage entry 24): release `--check` PASS; typecheck clean; unit `purchasing-definition` + `workspace-contract` 48/48; coverage unchanged (738). The PostgreSQL and browser runs above are at the pre-rebase heads; CI on the PR is the gate for the rebased head (see Filed).

- `4a68c916` (slices 2-3, lineage entry 25, merged with SALES-PARITY `b1aefa05`; one container at a time): release `--check` PASS; typecheck clean; unit `purchasing-definition`, `workspace-contract`, `sales-definition`, `surface-list`, `field-numbering` 69/69; integration `surface-data-binding` 112/112; reachability and hygiene 21/21; language coverage PASS (2498 -> 2501 obligations, 738 -> 742 observed); the full-replay snapshot differs only by four nullable columns and their UPDATE grants; PostgreSQL `purchase-order-ending` 1/1 after one stale expectation (a stored quantity reads at its column's scale). CI at `a2492db2` (slice 1): quality, browser and scans passed; PostgreSQL was cancelled at its 30-minute bound (hence SALES-PARITY `d00f8bba`) and the compile budget was indeterminate (CPU idle 73%, below the 90% it requires). CI on PR #8 is the gate for this head.
## Test it yourself

`PURCHASING-PARITY-test-it-yourself.md` §1 priced purchase order, §2 ending an order, §3 receiving paperwork.

## Filed

- `apps/web/release/app.compiled.json` grows about 3 MB per lineage entry (72 MB at 24 entries; GitHub refuses files over 100 MB): an ADR-0066 re-baseline (recommended: nothing is in production) or LFS is the owner's decision.
- Receipts and shipments already refuse a date after the tenant's today (`inventory-posting-service.ts`), but adjustments do not, and the backdate window is 0 days: POSTING-FORWARD-DATE (Critical, its own packet) adds one forward rule for every family and a 7-day window, after which a receipt date can be offered.
- Both line sections of the order page read the commercial purchase-line model, so received quantities are read twice per line per page; one section could carry both.
- A committed cancel's event now uses the purchasing order-event schema while a draft cancel's keeps the generic one (the event type is unchanged).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "PURCHASING-PARITY",
  "base": "b1aefa054af33b2734e8816eaca4897d1713b1b7",
  "head": "4a68c9164c7a84ec3454cfdef0c120cb1c0c676f",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/src/surface-composition.ts", "apps/web/test/browser/purchase-pricing.spec.ts",
    "apps/web/test/browser/receiving.composed-application.spec.ts", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts", "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/order-entry.ts", "packages/domain/src/purchasing/definition.ts",
    "packages/domain/src/purchasing/workspace.ts", "packages/domain/src/sales/workspace.ts",
    "packages/postgres-provider/src/commercial-read-model.ts", "packages/postgres-provider/src/purchasing-order-lifecycle.ts",
    "packages/postgres-provider/src/receiving-capability-executor.ts", "packages/postgres-provider/src/receiving-order-capability.ts",
    "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/integration/surface-data-binding.test.ts",
    "test/postgres/commercial-totals.test.ts", "test/postgres/composed-application.test.ts",
    "test/postgres/document-numbering.test.ts", "test/postgres/fresh-tenant-full-replay-schema.snapshot.json",
    "test/postgres/inventory-posting.test.ts", "test/postgres/purchase-order-ending.test.ts",
    "test/postgres/receiving-authorization.test.ts", "test/unit/canonical-model/field-numbering.test.ts",
    "test/unit/purchasing-definition.test.ts", "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "packages/domain/src/purchasing/definition.ts", "name": "purchasingModuleDefinition"},
    {"path": "packages/domain/src/purchasing/workspace.ts", "name": "purchasingWorkspace"},
    {"path": "packages/postgres-provider/src/commercial-read-model.ts", "name": "commercialReadModel"},
    {"path": "packages/postgres-provider/src/purchasing-order-lifecycle.ts", "name": "changePurchaseOrderState"},
    {"path": "packages/postgres-provider/src/purchasing-order-lifecycle.ts", "name": "amendOrderedQuantity"},
    {"path": "packages/postgres-provider/src/receiving-order-capability.ts", "name": "executeReceivingOrderState"}
  ]
}
```

Review: not owed — outside the Critical set (slices 1-3).
