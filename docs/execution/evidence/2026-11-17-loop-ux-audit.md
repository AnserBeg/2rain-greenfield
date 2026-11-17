# 2026-11-17 — the purchase order → inventory → sales order loop, walked by hand

The owner tried the app on 2026-11-17 and called its UI/UX "horrifying". This is what a scripted office-person walk found at `main`
`b82cdde2` (Playwright, 1440×900, persona Buyer, fresh `distributor` seed), and where each problem comes from in the code.
The plan that answers it: [loop-ux-plan.md](../loop-ux-plan.md).

## Baseline (the numbers the plan must beat)

| step | clicks | full page loads | typed fields | result |
|---|---|---|---|---|
| Create and place a purchase order (1 line) | ~14 | 7 | 6 | done; order date has no default, unit cost not prefilled |
| Receive in full | ~5 | 4 | 1 | done; quantity and cost empty until asked |
| Find the stock | 3 | 2 | 1 | done; 119 rows, 11 columns, search needs Apply |
| Sales order: create, confirm, reserve, ship | ~30 | ~14 | 7 | done; **saved, confirmed and shipped with no price**; "N/A" typed for carrier and tracking |
| Invoice and record payment | — | — | — | **not possible**: no action on the shipped order |

## The twelve problems, ranked, with cause

Class: DEFINITION = edit the authored definition in `packages/domain/src`; RENDERER = fix in `apps/web/src`; LANGUAGE = new
concept in `packages/canonical-model/src/schemas.ts` plus compiler and renderer. None needs client behaviour beyond ADR-0036.

| # | problem | class | where | fix |
|---|---|---|---|---|
| 1 | No way to invoice or take payment from a shipped order; the Invoices "New" form is a raw field dump | DEFINITION | `sales/workspace.ts:1174-1196` offers `invoice_shipped` only while `order_total` is positive; counter-sale payment steps at `:442-473` | Require a price (2); add an order-level payment action; drop or trim the raw Invoices form |
| 2 | An order saves, confirms and ships with no unit price | DEFINITION | `app/order-entry.ts:530` (`unit_price` not required) | Require it; refuse confirm on a missing total |
| 3 | Every action is input → Review → Confirm, a full page load each | LANGUAGE | `schemas.ts:884-891` (confirmation mandatory); `surface-composition.ts:1633`, `:2053`, `:2332` | Authored opt-out of the review stage for low-consequence tasks; stage changes as in-place fragments |
| 4 | Reserve and ship need two "Select" row clicks before the button appears | DEFINITION | `sales/workspace.ts:211-220` (selection placement); receive already uses a `rows` task (`purchasing/workspace.ts:333-350`) | Re-author reserve and ship as `rows` tasks over the lines |
| 5 | Nothing is defaulted: quantity, location, cost, order date | LANGUAGE (date: DEFINITION) | `schemas.ts:783`, `:1331` (`defaultFrom` only for references and choices); `schemas.ts:1365` (`defaultNow` exists) | `defaultNow` on order date now; a selected-row column default for task inputs |
| 6 | Ship demands a carrier and a tracking number | DEFINITION | `sales/workspace.ts:1067`, `:1101` | Optional; carrier as a choice |
| 7 | Raw text: `COMPOSITION_CHILD_EMPTY`, "SELECT A PRODUCT", "(UTC)", "Save commits the header and each line in sequence" | RENDERER (+1 DEFINITION) | `message-catalog.ts:130-136`; `surface-composition.ts:917`, `:1103`, `:2281`; `editor-controls.ts:211`; `document-editor.ts:2778`; `order-entry.ts:357`, `:636` | Plain wording; dates in the company time zone without the suffix |
| 8 | The PO form shows ~18 fields when 4 are needed | DEFINITION | `order-entry.ts:370-470` | Cut the first-screen field list; the rest on edit (true disclosure is LANGUAGE, later) |
| 9 | "Needs attention: Invoicing" with no reason and no action | DEFINITION | `sales/workspace.ts:549-555`, `:1181-1196` | Falls out of (2); a reason per step is LANGUAGE, later |
| 10 | Validation is the browser's "Please fill out this field" | RENDERER | `editor-controls.ts:193`, `:409`; `surface-composition.ts:2332`; `document-editor.ts:2550` | Error summary with links to the fields; per-field messages |
| 11 | Home is an empty "Counter sales" list; 25 menu entries with single-letter icons and internal names; a raw "Acting as" strip | DEFINITION (+RENDERER) | `list-declarations.ts:1405`, `:1783`; `inventory/definition.ts:210-217`, `:1016`; `party/definition.ts:172`, `:217`; `surface-runtime.ts:98`, `:2211`, `:2247` | A task-shaped menu and landing page; real icons; the demo strip styled and out of the way |
| 12 | Receive table clipped; "done" still shows RECEIVED 0; duplicate buttons | RENDERER | `surface-composition.ts:915`, `:~740`; `component-registry.ts:960-985` | Full-width table; re-read after the result; one next-action button |

Count: DEFINITION 7, RENDERER 3, LANGUAGE 2, CLIENT 0.

## What already works

Pickers search by name and never show an id. Choosing a customer fills terms, tax, salesperson and ship-to. The progress strip and
the "Next action" panel exist and are authored (`schemas.ts:1074-1085`). Posting is correct: stock went 0 → 10 on receipt and the
shipment carries its cost.

## What the reference app (PaneFlow) does that makes the loop feel good, ranked

1. A progress stepper with one next-action button on every order.
2. A before → after impact preview in every posting dialog.
3. Defaults: full open quantity, preferred bin, last cost or contract price, the partner's terms and ship-to.
4. Keyboard pickers that show price and availability, with inline quick-create.
5. Landing on the new record after creating it; cross-links that navigate, filter and select in one step.
6. Stage tabs with counts, pre-filtered queues, and a home page of exception tiles.
7. A validation summary that jumps to the field; entries kept on error; a discard guard.
8. Inapplicable actions hidden, blocked ones explained, buttons that carry the quantity.
9. Speed from caching and prefetch.
10. Connected documents with one-click PDF and email.

## Why the earlier UX work did not catch this

The 2026-08 "visual phase" was tokens, colour, type and density (`ui-ux-remaining.md` §1); no gate compared the app with the
mockup, which is not in the repository. Forms (U7), empty states (U6b) and observation gates (U9) were planned and not built. The
three-stage task and the client-script limits are our own rules (ADR-0036 §2.5, §7; ux-grammar "Task presentation").
