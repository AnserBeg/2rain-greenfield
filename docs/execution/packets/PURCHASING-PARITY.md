# PURCHASING-PARITY — Rain's purchase orders at PaneFlow parity through metadata

Status: slice 1 (priced purchase orders) executable; slices 2-4 chartered; no merge, no deployment. Sole LOCAL BUILD, chartered by the owner on 2026-09-29 ("continue to what is left ... the other components ... without me"; recommendations accepted, decisions reported at the end).
Tier: outside the Critical set so far — storage columns are added through the existing `addColumn` path (SALES-PARITY claims 10-11); no posting-kernel, verification, trust, migration or grant change.
Base: `packet/SALES-PARITY` (stacked; its draft PR is not yet opened). Reference: PaneFlow `d057daff` read from source; audit in `PURCHASING-PARITY-inventory.md`.

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

- `3fbb78d1` (own worktree, AC, host paging under 1 GB free): release `--check` PASS (lineage entry 23); unit `purchasing-definition` 37/37, `workspace-contract` + `sales-definition` + `surface-list` 25/25; integration receiving 3/3 (the witness states null figures and seeds unset fields as the provider returns them), the whole `surface-data-binding` file stopped by my own 2-hour wrapper with no result; surface grammar and hygiene 36/36 (the flat-navigation fixture strips Purchasing as the product composes it); compiler 175/175; typecheck clean; coverage re-derived (739 -> 738 observed).
- NOT run (host memory; a database container does not start within its 30 s bound): the regenerated full-replay schema snapshot (owed: this slice adds columns), PostgreSQL commercial-totals and document-numbering, browser `purchase-pricing`, composed-application. Not pushed until the snapshot is regenerated.

## Test it yourself

`PURCHASING-PARITY-test-it-yourself.md` §1 priced purchase order.

## Filed

- `apps/web/release/app.compiled.json` keeps growing about 3 MB per lineage entry (65 MB at 22 entries): an LFS or ADR-0066 re-baseline decision is the owner's.

Review: not owed — outside the Critical set (slice 1).
