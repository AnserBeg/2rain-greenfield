# LOOP-1 — the purchase order → inventory → sales order loop completes and makes sense

Status: slice 1 (the scorecard) integrated at `02725446`. Tier: Mechanical (no Critical path). Base: `main` `689b0117`. Stops: none.
Charter: [LOOP-1-charter.md](LOOP-1-charter.md). Plan: [loop-ux-plan.md](../loop-ux-plan.md).

## Claims

1. The scorecard journey (`apps/web/test/browser/loop-scorecard.composed-application.spec.ts`, composed CI job) walks the loop on a
   fresh `distributor` seed and asserts each finished step's end state: the order released, 10 received, 10 on hand, the sales
   order released, 4 reserved, 4 shipped, the invoice's balance 0.00.
2. Every count in the table is the journey's own (`LoopScorecard`): clicks, full page loads, typed fields, invented values, raw
   codes (the charter's three patterns) and the plan's developer sentences, per step.
3. Slice 1 asserts the payment is NOT the order's next action (today it is recorded on the invoice page); slice 2 flips it.

## Decisions (one line each)

- The scorecard lives in `apps/web/test/browser/` (where every browser spec is; the charter's `test/browser/` does not exist).
- Journey rule: start where the last step left off; use the menu and the page's own controls; type only what a required field or
  the job needs; accept every default. The item is a distributor catalogue item (it has a list price, so the order is priced).
- Database work per request is counted at the app's `pg` client in the test process (statements; a statement outside
  BEGIN…COMMIT is its own transaction) and cross-checked per step against `pg_stat_database` after an 11 s settle (they agree
  within 1%). The SHP / "Needs attention" tile is Invoicing's (`order_to_invoice` > 0), not Fulfillment's: a real state.
- A step's first page is counted at the end of the step before, not twice. "Back to order" after a Task is counted (the next
  step is offered only on the record, not in the Task's result).
- The table is printed in the log (`LOOP_SCORECARD`) and written only where `LOOP_SCORECARD_OUT` points; the committed baseline
  is the CI run's.
- Developer sentences ("Save commits the header", "Draft staged.", "No child records", "required parent selection") are a
  separate column, so "zero raw codes" means the charter's three patterns.
- Not built: the plan's rule 2 repeat of receive-and-list on a tenant-added record type (charter slice 1 omits it); the
  orchestrator rules.

## Slices

1. The scorecard — baseline [2026-11-17-loop-scorecard.md](../evidence/2026-11-17-loop-scorecard.md) (CI run 44179517091): PO
   create-and-place 11 clicks; sales side create → shipped 18; invoice and payment 9 through the invoice page; PO detail ~405
   database transactions per load. The audit's row 1 and baseline row corrected; the plan's targets restated (≤ 8, ≤ 11).

## Gates

- Slice 1: CI run 44179517091 green at `7cf5f580` (the scorecard 3.7 min in the composed browser job). Local: format,
  typecheck, lint; the journey run against a local dev server (`distributor` seed).

## Test it yourself

`corepack pnpm dev`, open <http://127.0.0.1:4174/>: Purchasing → Purchase orders → New; pick Cascade Fastener Works, Calgary
warehouse, FST-0120 (10 at 12.00), Save draft, Place order. Receive lines with actual cost → Fill open quantities, cost 12.00 →
Review → Confirm. Inventory → Stock by item, search FST-0120 → On hand 10. Sales → Sales orders → New: Lethbridge Millwork,
FST-0120 × 4 (priced 27.50 by default), Save draft, Confirm; select the line, Reserve stock (4, Calgary warehouse); select the
reservation, Ship reserved stock (you must type a carrier and a tracking number); Invoice shipped quantities; then open the
invoice and Record payment (amount and a reference typed). The counts are in the scorecard.

## Filed
