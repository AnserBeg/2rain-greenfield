# RAIN-META-SALES — approved Task-dialog visual checkpoint

Status: superseded by the [context correction](RAIN-META-SALES-task-context-visual.md); owner rejected reference equivalence for this earlier arrangement. Sole LOCAL author; same draft PR #5. No new reviewer, full matrix, merge or deployment.
Base: `42237a7f1e6cb3d0e3ad2943abbb08891b8b7555`; executable head: `0ea80ab581aaade82074455ce758e9a4d125db9d`; branch `packet/RAIN-META-SALES`.
Owner approval: attachment `7262c645-b069-4beb-81f7-36946161f90b`, explicitly authorizing the narrow ADR-0036/UX/plan amendment and native Task-dialog implementation.

## Result and limits

1. Optional typed v6 Record presentation declares `task: { mode: 'nativeDialog', fallback: 'page' }`. One server-rendered Task container/form flow retains input → review → confirm → result within the freshly governed Record; JS-off/unsupported clients retain the page flow. No sixth archetype, new message modality or workflow engine.
2. One repository-owned script only opens/dismisses the native dialog and manages focus; served CSP pins its exact content hash. Visible close, initial focus, containment, Escape, return focus and compact scrolling are exercised. Closing says it does not cancel submitted work; reopening retains the same flow and recovery receipt.
3. Task dispatch/preparation logic is unchanged: immutable reviewed inputs, preparedId/task identity, per-step retry keys, current revision/policy and committed-withheld HTTP 200 remain authoritative. Refresh loads current governed data; denied reads disclose no cached Record context. Sequential operations and process-local recovery remain limitations; inspect persisted records after process/response loss, never silently restart with new keys.
4. Sales metadata selects compact document identity/status/date, one fulfillment context with primary/secondary actions, ascending line numbers, item/SKU/unit secondary values, right-aligned quantities and local horizontal tables at compact width. Reservations and shipment/packing remain governed related records. Supporting facts use existing progressive disclosure; assistant/customization space and the single application model remain intact.
5. Optional sort/compact/Task presentation requires surface capability 6; absence preserves older presentation floor 5 and composition floor 4. No canonical-version cut. Bootstrap and all three baseline application entries are retained; current bundle has five entries. Actual query/operation/agent-discovery manifest and referenced chunk bytes are unchanged from closed P1/P2 `f10c502`.
6. Missing invoice/payment/tax, promised-date forecast, ship-to/carrier/tracking fields are business scope, not empty presentation panels. No incompatible unit/currency totals, client stock arithmetic or copied reference state/permission logic.

ADR-0036 now admits this fifth closed behavior for preserving document context while retaining usable page fallback. Directly conflicting plan/UX guidance and conformance were amended under explicit owner approval. ADR-0048 modal MESSAGE placement remains refused.

## Actual serving identity and comparable state

- Inspect final Rain on [41269](http://127.0.0.1:41269/?surface=northstar.app%3Asurface.sales_order_detail&record=838cb04f-f13f-48b2-a33f-8841f7a2e1c3&northstar.app%3Aparameter.sales_order_get_legal_entity_scope=74000000-0000-4000-8000-000000000001). Node PID 26734, wrapper/process group 26716; source head above, release `c8d4f738-c0d5-4fba-9c23-552822b350dd`, pointer fence 6, root `89f540af973dea16e98bf45d8f18bc1680ee061be3f1f1d8d96de36c67934d49`, observed in served DOM.
- SO-VISUAL-001, synthetic Alpine Office Supply: Desk tray 6 EA, Field notebook 10 EA, Mailing tube 4 EA. Notebook reserve 8 then ship 5: remaining reservation 3 EA, on hand/reserved/available 5/3/2, open to ship 5 EA; posted SHP-VISUAL-001 packs notebook 5 EA at Calgary warehouse. Captured subsequent ship quantity 2 at entry/review only; no Confirm dispatched. The retained tab's Continue task reopens that same prepared review.
- Reference [4301](http://127.0.0.1:4301/?view=sales-orders), disposable archive pinned `d057daffd17a199309675a6b0a31c8bdbca05282`, SO-000001: same synthetic items/quantities and stock state, Confirmed/PartiallyShipped/NotInvoiced. Captured Post shipment quantity 2 without posting. Source-derived business behavior is never described as an inspected screenshot.
- Earlier retained Rain 33571 (one line) and 41983 (three-line baseline) serve `42237a7f`/root `62cc2431…6adc`, not this candidate. Intermediate candidate fixtures 39563/46599 remain preserved and are not the final target. Owner PaneFlow 3000 has unverified serving identity and was not modified. Unrelated processes, records and locks are preserved.

## Evidence and owner click-through

Actual PNG copies, capture URLs/state, concise region comparison and annotated supported structure are together in the Windows folder:
`C:\Users\rvham\.codex\visualizations\2026\09\14\01a0a194-4517-7fb2-8464-da81032ae8a4\rain-presentation\approved-dialog`.
Open `README.md`, `captures-current.json`, `Rain-order-desktop.png`/`Rain-order-390.png`, `Rain-reserve-entry-*`, `Rain-reserve-review-*`, `Rain-partial-ship-entry-*`, `Rain-partial-ship-review-*`, `Rain-packing-*` and matching `PaneFlow-*` files. Reserve quantity 2 at Calgary is also captured at entry/review without confirmation; reference Reserve shows actual availability 2 and automatic location selection. All captured data is synthetic; no sensitive real records require redaction.
DOM viewports are 1280×800 and 390×844. CUA native frames are usually 1265×791 and 375×811; packing desktop is 1280×800. PNG export only changes encoding, never dimensions/pixels. Supplemental real-gateway browser PNGs have exact requested pixel sizes, their own one-line fixture URLs/releases and explicit JS-on/off prefixes; they are not relabelled matched three-line captures.

Focused local checks pass: typecheck; compiled app freshness; exact owned-script/CSP tests (including extra/external/tampered script refusals); UX/compiled-grammar conformance; metadata-only/non-Sales Task and query-sort reuse; retained stale/forged/missing/retry/withheld/current-read Task controls; capability compatibility pins.
Final browser command: `node scripts/run-with-test-lock.mjs shared -- corepack pnpm exec playwright test meta-sales.spec.ts --config apps/web/playwright.config.ts --project=browser --workers=1 --reporter=list` — 2 passed, exit 0, JS on and off. Exercises reserve 8, partial ship 5, release 3, exact packing 5; keyboard/focus, close/reopen, stale/forged confirmation with no effects, result receipt, compact controls and overflow.
An earlier filtered run also completed both cases but the inherited CI reporter refused incomplete reachability coverage. No filtered run is a full-CI claim; hosted CI is not declared green here. No program review due: this unintegrated presentation checkpoint is not a stage boundary.

At 41269 select Field notebook, then Calgary warehouse; Ship reserved stock is primary and release is under More actions. Review displays frozen quantity before explicit Confirm; close/reopen dismisses/resumes without posting. Open packing returns exact 5 EA and Back to order preserves selection. JS-off runs the same server form flow on the page.
Owner decision: accept this actual Record/Task arrangement, or identify the region to change. Do not continue implementation before that decision.

The [main RAIN-META-SALES record claim](RAIN-META-SALES.md) covers the combined executable footprint through this head; this supplemental visual record is narrative evidence for that same packet.
