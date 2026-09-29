# PURCHASING-PARITY — Rain's purchase orders at PaneFlow parity through metadata

Status: slice 1 (priced purchase orders, RCV numbers) executable and pushed (draft PR on `packet/SALES-PARITY`); slices 2-4 chartered; no merge, no deployment. Sole LOCAL BUILD, chartered by the owner on 2026-09-29 ("continue to what is left ... the other components ... without me"; recommendations accepted, decisions reported at the end).
Tier: outside the Critical set so far — storage columns are added through the existing `addColumn` path (SALES-PARITY claims 10-11); no posting-kernel, verification, trust, migration or grant change.
Base: `packet/SALES-PARITY` at `f0a38e76` (stacked on draft PR #7). Reference: PaneFlow `d057daff` read from source; audit in `PURCHASING-PARITY-inventory.md`.

## Owner rulings (recommended, taken under the owner's standing instruction)

- PA: ruling B extends to purchase orders. A PO carries payment terms, a tax code that new lines start from, a line discount %, a tax rate frozen per line and per charge, freight and an other fee each with a code, exact half-up per-line amounts and totals, one currency (no FX). The v1 plan's "no tax on orders" boundary (`purchasing-sales-v1-plan.md` §6, §7.3) moves for POs as ruling B moved it for sales orders. No accounting, payable or ledger posting follows.
- PB: a supplier's defaults are its Party defaults (currency, terms, tax code), as PaneFlow keeps one set per business partner; the expected date starts 14 days out, PaneFlow's default.
- PC: a unit cost is typed; defaulting it from a last cost or a standard cost waits for an item cost field (inventory packet).

## Slices

1. Priced purchase orders (P3, P4, P23) and RCV receipt numbers (P1): terms, tax, discount, charges, totals, printed totals.
2. Receiving paperwork (P13, P14): received-on date within the kernel's backdate bound, packing slip, notes, a default receiving location.
3. What is still to arrive (P10, P11, P26): received/open quantities and a total on the PO List, an Expected receipts List of open lines, late marking — a read model, no kernel change.
4. Short-close and a cancel guard (P8, P9): close the open remainder with a reason; Cancel refused once anything is received. Check the Critical set first (the received projection is kernel-verified).
Deferred to their own packets: approvals and "place order" (P5-P7), vendor bills (P21), vendor returns and drop ship (P19-P20), inventory (transfers, count and opening posting routes, availability, reorder rules, lot/serial, valuation, units).

## Claims

1. A purchase order in the product application declares payment terms (the Party's labels), a tax code, freight and other fee with codes and frozen rates; each line a discount % and a tax code with a frozen rate. All optional; a purchasing-only compile declares none of them (`commercialTerms` factory option), since they read Catalog tax codes.
2. Choosing the supplier resets currency, terms and tax code to its Party defaults; each new line's tax code starts from the order's; a rate is frozen from its code when chosen; a never-saved order's expected date starts 14 days out.
3. The commercial read model states a purchase order's line amounts and tax, subtotal, charges, tax and total exactly as a sales order's (half up per line, one currency; an unstated figure is null and nulls every total it feeds), under two purchase bindings of the same capability; a purchase line states no price basis. Totals re-enter current authority over the lines.
4. The purchase order page reads its record through `commercial_purchase_order_get`: facts show terms and the total; Priced lines show unit cost, discount, tax code, tax and amount; money reads with two decimals; the printed order carries the priced lines and totals (Subtotal, Freight, Other fee, Tax, Total). Receiving is unchanged.
5. A goods receipt takes a server-assigned `RCV-000001` number on its first save, through the numbering SALES-PARITY built (claims 7-9, 21 there); the receive task no longer binds a generated id, and the receiving kernel reads the stored number as before.

## Decisions

- The purchase bindings live on Sales' `commercial` capability (one executor, parameterized by document), and the purchase commercial queries are added by `salesWorkspaceQueries` only when purchasing is composed.
- A separate "Priced lines" section, as on the sales order: the existing "Order lines" section keeps driving receiving selection unchanged.
- P8 is not a quick fix: Cancel after receipts is today the only way to end a partly received order, because Close requires nothing open. Slice 4 adds short-close first, then refuses Cancel after receipts.

## Controls

None owed: nothing in the Critical set changes.

## Gates

- `3fbb78d1` (own worktree, AC, host paging under 1 GB free): release `--check` PASS (lineage entry 23); unit `purchasing-definition` 37/37, `workspace-contract` + `sales-definition` + `surface-list` 25/25; integration receiving 3/3; surface grammar and hygiene 36/36; compiler 175/175; typecheck clean; coverage re-derived (739 -> 738 observed).
- `9500dea2`: the full-replay schema snapshot regenerated over the lineage; it differs only by eleven nullable columns, their UPDATE grants and the NOT VALID payment-terms check. PostgreSQL commercial-totals 2/2, document-numbering 1/1 (RCV-000001, every numbered entity's scenarios executed), composed-application 18 pass, 0 fail, 2 cancelled (parts 8 and 9 each stopped by their 300 s bound before any assertion, under 1 GB free).
- `13f35063`..`3cbb2de7`: running them found test drift this slice caused, fixed there: the receiving tests typed a now-assigned receipt number; the receiving journey and the receipt posting test addressed the order page by the plain get's company parameter (the page reads its totals query) and the posting test's gateway had no commercial read model; the pricing journey expected zero seconds and a secondary column in its own cell. Then receiving-authorization 7/7, browser purchase-pricing 1/1 and the composed receiving journey 1/1 (a filtered browser run exits 1 by the reachability reporter's own rule).
- `ba21d043` (rebased onto SALES-PARITY `f0a38e76`, whose slot order puts a document's lines first; this slice becomes lineage entry 24): release `--check` PASS; typecheck clean; unit `purchasing-definition` + `workspace-contract` 48/48; coverage unchanged (738). The PostgreSQL and browser runs above are at the pre-rebase heads; CI on the PR is the gate for the rebased head (see Filed).

## Test it yourself

`PURCHASING-PARITY-test-it-yourself.md` §1 priced purchase order.

## Filed

- `apps/web/release/app.compiled.json` grows about 3 MB per lineage entry (72 MB at 24 entries; GitHub refuses files over 100 MB): an ADR-0066 re-baseline (recommended: nothing is in production) or LFS is the owner's decision.
- GitHub Actions did not start on the draft PRs: the account's billing refused the jobs (2026-09-29). Until it is fixed, the gates above are the local ones.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "PURCHASING-PARITY",
  "base": "f0a38e76ee6d265f2cfc04aa3e9520b1f04af462",
  "head": "ba21d043379800b72ab24ec72d17d9c49b8b1a85",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/test/browser/purchase-pricing.spec.ts", "apps/web/test/browser/receiving.composed-application.spec.ts",
    "packages/domain/src/app/builder.ts", "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/purchasing/definition.ts", "packages/domain/src/purchasing/workspace.ts",
    "packages/domain/src/sales/workspace.ts", "packages/postgres-provider/src/commercial-read-model.ts",
    "test/architecture/surface-grammar-conformance.test.ts", "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/integration/surface-data-binding.test.ts", "test/postgres/commercial-totals.test.ts",
    "test/postgres/composed-application.test.ts", "test/postgres/document-numbering.test.ts",
    "test/postgres/fresh-tenant-full-replay-schema.snapshot.json", "test/postgres/inventory-posting.test.ts",
    "test/postgres/receiving-authorization.test.ts", "test/unit/purchasing-definition.test.ts"
  ],
  "symbols": [
    {"path": "packages/domain/src/purchasing/definition.ts", "name": "purchasingModuleDefinition"},
    {"path": "packages/domain/src/purchasing/workspace.ts", "name": "purchasingWorkspace"},
    {"path": "packages/postgres-provider/src/commercial-read-model.ts", "name": "commercialReadModel"}
  ]
}
```

Review: not owed — outside the Critical set (slice 1).
