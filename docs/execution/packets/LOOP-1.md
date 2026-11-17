# LOOP-1 — the purchase order → inventory → sales order loop completes and makes sense

Status: slice 1 (the scorecard) in integration. Tier: Mechanical (no Critical path). Base: `main` `689b0117`. Stops: none.
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
- A step's first page is counted at the end of the step before, not twice. "Back to order" after a Task is counted (the next
  step is offered only on the record, not in the Task's result).
- The table is printed in the log (`LOOP_SCORECARD`) and written only where `LOOP_SCORECARD_OUT` points; the committed baseline
  is the CI run's.
- Developer sentences ("Save commits the header", "Draft staged.", "No child records", "required parent selection") are a
  separate column, so "zero raw codes" means the charter's three patterns.
- Not built: the plan's rule 2 repeat of receive-and-list on a tenant-added record type (charter slice 1 omits it); the
  orchestrator rules.

## Slices

1. The scorecard — baseline [2026-11-17-loop-scorecard.md](../evidence/2026-11-17-loop-scorecard.md); the audit's row 1 and
   baseline row corrected (invoice and payment are reachable on a priced order).

## Gates

- Local: format, typecheck, lint on the new files; the journey run against a local dev server (`distributor` seed). CI is the
  matrix; the composed browser job runs the scorecard.

## Test it yourself

`corepack pnpm dev`, open <http://127.0.0.1:4174/>: Purchasing → Purchase orders → New; pick Cascade Fastener Works, Calgary
warehouse, FST-0120 (10 at 12.00), Save draft, Place order. Receive lines with actual cost → Fill open quantities, cost 12.00 →
Review → Confirm. Inventory → Stock by item, search FST-0120 → On hand 10. Sales → Sales orders → New: Lethbridge Millwork,
FST-0120 × 4 (priced 27.50 by default), Save draft, Confirm; select the line, Reserve stock (4, Calgary warehouse); select the
reservation, Ship reserved stock (you must type a carrier and a tracking number); Invoice shipped quantities; then open the
invoice and Record payment (amount and a reference typed). The counts are in the scorecard.

## Filed
