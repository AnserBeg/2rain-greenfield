# LOOP-1 — charter: the purchase order → inventory → sales order loop completes and makes sense

You are the BUILD lane. Chartered 2026-11-17 by the orchestrator. Worktree `/home/rvham/2rain-greenfield-loop-1`, branch
`packet/LOOP-1`. Read `AGENTS.md`, `mission-cadence`, `git-workflow`, `ux-grammar`, then
[loop-ux-plan.md](../loop-ux-plan.md) (the rules and phase 1) and
[the evidence](../evidence/2026-11-17-loop-ux-audit.md) (the twelve problems with file and line). Verify every path, id and line
with `ls`/`grep` before relying on it: the evidence was read at `b82cdde2` and lines move.

## Outcome
An office person completes the loop in the web app without help: create and place a purchase order, receive it, see the stock, create
a priced sales order, confirm, reserve, ship, invoice, record payment. Nothing on the way shows a raw code, asks for an invented value,
or leaves them without a next action.

## Slices (merge each to `main` on CI green)
1. **The scorecard.** One browser journey (`test/browser/`, CI, scripted) that walks the loop and records per step: clicks, full page
   loads, typed fields, and raw codes on the page (`[A-Z]+_[A-Z_]+` tokens, "(UTC)", "SELECT A PRODUCT"). It writes a dated table
   under `docs/execution/evidence/`. Run it first, unchanged app, and commit that table as the baseline. It asserts the loop's end
   state only where the loop already completes; the invoice-and-pay assertion starts as an expected failure and flips in slice 2.
2. **The loop finishes** (evidence rows 1, 2, 9). `unit_price` required on a sales line; confirm refuses a missing total with a plain
   message; `invoice_shipped` and a record-payment action are next actions on the shipped order (reuse the counter-sale payment
   steps' operations); the raw Invoices "New" form is removed from the menu or trimmed to what a person fills.
3. **Fewer steps, fewer fields** (rows 4, 5-date, 6, 8). Reserve and ship as `rows` tasks over the lines, the way receive is; carrier
   and tracking optional; order date `defaultNow`; the PO and SO create screens show the fields the job needs, the rest on edit.
4. **Plain words and honest feedback** (rows 7, 10, 12). No message-catalog code or developer sentence in a page body; dates in the
   company time zone with no "(UTC)"; an error summary that links to each field, entries kept; one next-action button; the receive
   table at full width; the result view re-reads what it shows.
5. **Finding your way** (row 11). A task-shaped menu within the ux-grammar nav budget (group the 25 destinations; plain names such
   as "Stock", "Customers and suppliers"); a landing page that is not an empty list (the existing Home archetype with exception
   counts: to receive, to ship, to invoice, low stock, if the authored queries exist; otherwise the most useful worklist); real icons
   instead of first letters; the "Acting as" demo strip styled and unobtrusive.

Scorecard targets at the end: the loop completes; zero raw codes; zero invented values; create-and-place a PO in ≤ 8 clicks; the
sales side (create to shipped) in ≤ 16.

## Decided (do not reopen)
- Through the generator: definition, renderer or message catalog only. No hand-built screen, no branch on an operation or entity id
  in `apps/web/src`.
- No canonical language or schema change in this packet. The review stage of a task and row-derived input defaults are phase 3. If a
  row cannot be fixed without one, file it and move on.
- No new look: phase 2 chooses it with the owner. Fix structure, words and flow; do not restyle.
- No new distributor feature beyond exposing invoice and payment on the order (freeze R2).
- Pre-tenant mode (ADR-0066): a definition change re-baselines the release; rebuild lineage from base so an increment adds one entry.

## You decide alone (one line each in the record)
Menu grouping and names, which fields stay on the create screens, message wording, the landing page's content, icon set (inline SVG,
no dependency), the scorecard's file and table shape.

## STOP (five lines: what, two options, recommendation)
A Critical-set path (`AGENTS.md` §4); a migration; a language or schema version change; an ADR-0036 limit you would have to exceed; a
ux-grammar pin you would have to break (name the pin); a CI red you cannot fix honestly.

## Lease
`packages/domain/src/**`, `apps/web/src/**` (not `customize-screen.ts`, not the assistant panel), `test/browser/**`, the compiled
artifacts and pins your changes regenerate (`app.authored.json`, `app.compiled.json`, baselines, reachability, hygiene lists),
`docs/execution/packets/LOOP-1.md`, `docs/execution/evidence/**`. The AGENT-3 lane owns `packages/operations-agent/**`, `test/agent/**`
and its panel; its eval tasks read your surfaces and ids, so keep operation and query ids stable and merge `main` often. If an agent
task breaks because a field became required, tell the orchestrator; do not edit `test/agent/**`.

## Gates and conduct
- `format`, `typecheck`, `lint`, `check:app-release`, focused unit tests locally. CI on push is the matrix. Local PostgreSQL or browser
  suites only to reproduce a CI red, under `scripts/run-with-test-lock.mjs`, one at a time (`--workers=1`), `timeout 15 docker info`
  first. Long commands in the background; never a foreground wait over a few minutes.
- Never `pkill`, `killall` or pattern kills. Never restart Docker; tell the orchestrator.
- Commit WIP often with `Packet: LOOP-1`. Stage explicit paths. Integrate each slice yourself (`--no-ff`, ledger row, review-log row,
  push, CI green). Batch doc-only pushes with the merge: every push to `main` cancels its in-flight CI.
- Record `docs/execution/packets/LOOP-1.md`, at most 80 lines.

## Report (≤ 25 lines) after each slice, then stop at the end
`LANE: BUILD · PACKET: LOOP-1 · SHA · BASE`; per slice: merge SHA, CI run, the scorecard table before and after, "Test it yourself".
