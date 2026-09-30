# VALUATION — design seed (read-only research, 2026-09-30)

Written by the orchestrator's research agents against `packet/PURCHASING-PARITY` at `3769ed9e`; a seed, not a full design: the lane writes the full design first. File:line refs are hints (`icon` packages/domain/src/inventory/contracts.ts, `plan` docs/greenfield-north-star-erp-platform-plan.md; PaneFlow `adv` lib/server/advanced-domain.ts, `dom` lib/server/inventory-domain.ts, `schema` db/schema.ts). Owner rulings are taken (the owner's standing instruction: take the recommended choice).

## 0. Three facts that gate the whole program

1. **Lineage headroom.** `apps/web/release/app.compiled.json` is 74.4 MB at 25 entries, about +3 MB per entry. GitHub refuses files over 100 MB,
   so about 8 compiles remain, fewer than the packets below. The ADR-0066 re-baseline is the owner's call (PURCHASING-PARITY.md:61); rule on it first.
2. **Only one person exists.** LOCAL_DEMO runs every web request as one fixed human (`rt:710-713`, `rt:1036-1044`, `root:108`). `local-approver` serves only release activation.
   Nobody can approve anyone else's work until a second identity exists.
3. **Reserved seams.** "Only a stage that consumes one of these may implement it" (`plan:487-492`) covers unit conversion, valuation and dimension extension.
   Units, lot and valuation need plan amendments. Most other gaps are N2, N3 or N6 rows (`plan:3560-3569`), pulled forward by owner ruling, as SALES-PARITY rulings B and C were.


**Valuation and landed cost (I18)** · XL, then L · Critical **Yes** (money boundary, kernel layers) plus a one-way door
- **PaneFlow:** FIFO/average/standard per product, with layers, value entries and landed cost (`schema:1297-1374`; `adv:1704-1803`; `dom:1248-1250`).
- **Rain:** no money on movements; valuation `unsupported` (`icon:837-843`; `conformance.ts:3646-3653`). Receipts keep a cost or an explicit absence (ADR-0017).
- **Plan: OUT.** Landed cost excluded (`plan:271`); valuation reserved (`plan:488`). N3: "landed-cost inputs and valuation interfaces, without claiming a general ledger exists" (`plan:3189-3190`).
- **Ruling:** → Moving average per item and legal entity, as a derived read model, never stored on movements. Non-receipt inflows capture a cost or read "unvalued". Landed cost after payables.


## Scope for this lane (orchestrator, 2026-09-30)

Owner rulings taken (recommended choices): moving-average cost per item, legal entity and currency, computed by a DERIVED read model from posted movements and receipt costs — never stored on movements, never a kernel layer; a receipt line with an explicit absence of cost, and any non-receipt inflow without a captured cost, makes the affected quantity "unvalued" rather than guessed; outbound movements relieve at the average current at their effective time; no FX (one currency per document, SALES-PARITY ruling B), so each currency averages separately; landed cost comes after payables, allocating a bill's freight and other fee onto the receipts it bills; the plan's reserved seam (plan:487-492) and ADR-0017's money boundary are amended by a new ADR the lane writes, recording these rulings.

Slices (one lineage entry each at most):
1. The ADR, then the item-cost read model and an "Inventory value" List (per item and company: on hand, average cost, value, unvalued quantity), plus average cost and value on the item page.
2. Cost of goods shipped: each shipment line's relieved value, derived; shown on the shipment and summed per sales order and invoice (a margin figure beside the invoice, read only).
3. Landed cost from vendor bills (PAYABLES): allocate freight and other fee onto the billed receipt lines by value, and re-derive the averages.

Critical set: the design intends NO Critical-set change (AGENTS.md §4). If any slice turns out to need one (e.g. a kernel column), stop, split it into its own Critical packet with expected-red controls and a review prompt for the owner.
