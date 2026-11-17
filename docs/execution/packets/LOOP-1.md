# LOOP-1 — the purchase order → inventory → sales order loop completes and makes sense

Status: slice 1 integrated at `02725446`; slice 2 at `0cad5e5f`. Tier: Mechanical (no Critical path). Base: `main` `689b0117`. Stops: none.
Charter: [LOOP-1-charter.md](LOOP-1-charter.md). Plan: [loop-ux-plan.md](../loop-ux-plan.md).

## Claims

1. The scorecard journey (`apps/web/test/browser/loop-scorecard.composed-application.spec.ts`, composed CI job) walks the loop on a
   fresh `distributor` seed and asserts each finished step's end state: the order released, 10 received, 10 on hand, the sales
   order released, 4 reserved, 4 shipped, the invoice's balance 0.00.
2. Every count in the table is the journey's own (`LoopScorecard`): clicks, full page loads, typed fields, invented values, raw
   codes (the charter's three patterns) and the plan's developer sentences, per step.
3. Slice 2: a sales line is never saved without a unit price (field presence required; refused at save, any channel); once
   invoiced, the order's next action pays each open invoice's whole balance through the invoice's own payment operations; the
   payment reference is optional; the invoice form declares no `sections` slot, so the Invoices List offers no raw "New" and an
   invoice no "Edit" (ruled). The scorecard asserts the payment is the order's next action.

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
- Slice 2 re-baseline (ADR-0066): the required price retypes a column (v1 transitions refuse); one-entry release; `dev:reset`
  for any dev database (the 4174 demo too). The full-replay snapshot was regenerated on GitHub (evidence run 44182814394).
- Slice 2 test bridges (ruled): unpriced sales lines priced in `test/postgres/fulfillment.test.ts`, `order-lists.test.ts`,
  `packing-retrieval.test.ts` and `test/helpers/order-entry-fixture.ts`; `customer-credit.test.ts` keeps its unstated-total case
  through an unstated tax rate (`CREDIT_EXPOSURE_UNSTATED` unchanged); pins moved: `g2-module-conformance` (price input required),
  the surface-grammar debt baseline (95 → 97, the invoice form's missing sections slot) and the reader-22 floor test.
- A draft invoice is corrected on its own page (Record actions → Post or Void, as before); a posted one is voided and re-invoiced
  from the order. The invoice form never offers a hand-made invoice.
- Not built: the plan's rule 2 repeat of receive-and-list on a tenant-added record type (charter slice 1 omits it); the
  orchestrator rules.

## Slices

1. The scorecard — baseline [2026-11-17-loop-scorecard.md](../evidence/2026-11-17-loop-scorecard.md) (CI run 44179517091): PO
   create-and-place 11 clicks; sales side create → shipped 18; invoice and payment 9 through the invoice page; PO detail ~405
   database transactions per load. The audit's row 1 and baseline row corrected; the plan's targets restated (≤ 8, ≤ 11).
2. The loop finishes — [after](../evidence/2026-11-17-loop-scorecard-slice-2.md) (CI run 44187720302): invoice and payment 8
   clicks, 8 loads, 0 typed, 0 invented (was 9, 9, 2, 1), all from the order.

## Gates

- Slice 2: CI run 44187720302 green at `da4aefa8`. Slice 1: CI run 44179517091 green at `7cf5f580` (the scorecard 3.7 min in the composed browser job). Local: format,
  typecheck, lint; the journey run against a local dev server (`distributor` seed).

## Test it yourself

`corepack pnpm dev`, open <http://127.0.0.1:4174/>: Purchasing → Purchase orders → New; pick Cascade Fastener Works, Calgary
warehouse, FST-0120 (10 at 12.00), Save draft, Place order. Receive lines with actual cost → Fill open quantities, cost 12.00 →
Review → Confirm. Inventory → Stock by item, search FST-0120 → On hand 10. Sales → Sales orders → New: Lethbridge Millwork,
FST-0120 × 4 (priced 27.50 by default), Save draft, Confirm; select the line, Reserve stock (4, Calgary warehouse); select the
reservation, Ship reserved stock (you must type a carrier and a tracking number); Invoice shipped quantities; then open the
invoice and Record payment (amount and a reference typed). The counts are in the scorecard.

## Filed

- Confirm refusing a missing total for every customer (the provider's confirm reads the total only under a credit limit): ruled
  option 2, filed for the provider; the required price closes the observed harm.
- Part payment and an amount defaulting to the balance on the order's payment: phase 3 (row-derived defaults).
