# RAIN-ORDER-ENTRY — normal metadata-defined order workspace

Status: evidence_ready; order-form usability correction complete at executable `736b512940d2e5a1cefc3c8366ae70cee87ffc4c` on the same PR #6 branch, from reviewed baseline `0566206d9ed41c2df301c2369d02446999f6063d`; sole LOCAL author; stacked draft PR handoff. F1/F2/F3 and Task P1/P2 closed and preserved; fresh CI / bounded ONLINE review of this delta / owner acceptance pending; no merge/deployment.
Tier: Behavioral. Actual AGENTS §4 Critical set untouched; no local arm.
Dependency/base: `3830f95b6ff05c8e2b80113f812d59359a67f448`, open draft PR #5.
Branch/worktree: `packet/RAIN-ORDER-ENTRY`, `/home/rvham/2rain-greenfield-rain-order-entry`; draft base `packet/RAIN-META-SALES`.

## Form-usability correction (2026-09-25)

Owner rejected the reviewed forms: generic text inputs, inadequate reference
pickers, no in-context creation of missing customers/vendors/products, and a
stacked line layout. Reference: disposable PaneFlow copy at `d057daff`, driven
in a real browser (customer combobox with "+ New customer", currency select,
one-row lines).

Claims of this delta:

1. Canonical editor metadata declares each control: `choice` (offered set,
   declared default) over a text field, `multiline`, `derived` (read from the
   sibling reference's exact get), and reference pickers (list query, exact get,
   label/detail fields, optional governed create flow). The compile-time
   validator checks every binding against the entity model; the schema is closed.
2. One reusable reference control serves Customer, Vendor and Product: server-side
   search and paging, selection only from offered results re-read through the
   declared get, keyboard search/selection, loading/no-results/error states, and
   "+ New X" quick create returning to the same document, line and field with
   focus. A form-changed carrier is accepted only after an authorized exact read.
3. Quick create chains existing governed creates (Party then an active customer or
   supplier PartyRole; Item), keeps every entered order value, works on an
   invalid order, mints stable keys and record ids once, reports denied, partial
   and read-back-withheld outcomes without selecting, and cancel writes nothing.
4. Lines render as one aligned row under shared headings (Product | Quantity |
   Unit | Unit price or Unit cost | Remove), stable line identity, compact cards
   at phone width, no dead Tax/Discount/Route/Bin/FX columns.
5. Exact decimals stay strings: canonical spelling, bounds from the pinned
   operation contract checked before any step commits, comparison by value so
   unchanged reopened lines plan no update. Save names each missing or invalid
   field beside its control and writes nothing.

Decisions of this delta:

- Currency is an editor choice (CAD/USD/EUR, default CAD) over the domain's text
  field. It is editor policy, not a domain rule: a stored value outside the set
  is shown as "(current value)" and kept on unrelated edits; a submitted value
  outside the set is refused.
- The Sales unit is derived from the selected product's base unit and never read
  from the form; Purchase has no unit field. No price, conversion or commercial
  default is invented.
- "+ New X" is offered when every step is a bound governed create without a
  human confirmation grant. This is availability, not authority: the operation
  gateway decides each step at invoke time and a refusal is reported without a
  write. Per-principal pre-authorization of the button is not claimed.
- ADR-0036 §2 gains a sixth behaviour (reference-control keyboard presentation)
  under its §2a test; the create dialog reuses behaviour 5's native dialog, with
  Escape activating the server-rendered Cancel. `ux-grammar` records the
  reference-control rule. No framework, router, store, tenant script, client
  fetch or client business rule.
- `CompiledSurfaceInputField` gains the pinned contract's `bounds`, read from the
  same admitted operation catalog; the provider still enforces them.
- The order-entry fixture gains `--distributor` (master volume only) and two
  verify-mode switches — revoke/restore one named permission, count stored
  masters by name — so browser proofs observe refusals and duplicates in
  PostgreSQL.
- F2/F3 integration witnesses now drive their provider refusal with a well-formed
  quantity the stub provider refuses (the editor refuses `'invalid'` before any
  commit), and use a line's own unit price as the child sentinel (unit is
  derived). Their subjects are unchanged.

## Claims

1. Typed workspace membership compiles operator navigation independently of capability existence; document/task context highlights the owning workspace.
2. Declared entry uses current authorized active companies: single auto-entry, scoped advisory preference or choice, useful no-access state, invalid explicit scope refusal.
3. Shared Record draft authoring binds readable party/product references, header and multiple lines to explicit company/parent through existing semantic gateways.
4. Sequential Save keeps stable identities and exact frozen retry inputs/keys, reports partial/withheld outcomes, handles stale revisions, and confirms governed persisted archive; Save remains distinct from Release.
5. Browser-created Sales and Purchase orders save/reopen exact two owned lines without draft stock effects; existing fulfillment/packing and receiving run in document context. Closed P1/P2 kernels are unchanged.

Owned: canonical schemas/validator/exports, compiler surface output/capability admission, domain workspace declarations, web entry/navigation/shared draft editor/transport, affected fixtures/tests/artifacts/inventory, approved ADR/UX/plan amendments, this packet and one-line queue/ledger/lanes records.
Boundary: no pricing/tax/FX expansion, target-order seeding, bespoke Sales renderer, prototype, inherited audit, retained process/data/lock replacement, PR #5 rewrite, merge or deployment.

## Decisions

- Owner approves ADR-0030 navigation membership, ADR-0037 authorized entry and ADR-0015 advisory-preference distinction; narrow UX/plan text aligns.
- ADR-0047 §7 admits additive optional declarations on adopted v6; workspace/editor requires capability 8; absent keys and historical floors/bytes remain reproducible.
- Existing Record slots/typed controls render both editors; a metadata-only Purchase label variant and unrelated canonical fixture exercise reuse.
- Purchase line has no writable unit field: picker displays product base unit. Receiving requires explicit unit plus actual cost/currency or an explicitly absent-cost action, with no order-price fallback.
- Buffers/preferences are process-local, scoped to trusted identity/release/company; buffers expire monotonically after 60 minutes. No durable autosave or atomic Save claim.
- Supporting masters retain existing setup/module destinations; contextual surfaces, queries, operations, raw deep links and agent discovery remain available.
- Bridges: Sales browser uses independent buffers for stale conflict and exact Line column; mixed-version test attributes paths to the actual mutated entities instead of assuming index zero.
- Inventory re-derived without instrument changes: 2,299 → 2,351 obligations, 554 → 601 observations; new decision identities, unchanged two unhonored join-eligibility entries, no per-obligation execution claim.
- Program review not due: unintegrated vertical, no stage boundary/new posting domain/imminent module fan-out; no autonomous review launched.
- New caller seam delegates pinned Task/draft continuations to their own checks; buffered persisted lines reauthorize before display/writes. Committed redacted replays retain HTTP 200, with no cached fields or retry controls. P1/P2 kernels unchanged.
- Draft recovery now records acknowledged gateway receipts separately from an immutable pending plan. A pending exact retry reaches receipt lookup with its original key/input/revision; fresh edits still compare current revision. Correctable replanning removes only acknowledged archives and keeps unexecuted removals governed by confirmation.
- After continuation identity/release/scope/document validation, initial header, workspace, pre-execution header/child and final render reads share one acknowledged-aware boundary. Read loss after an acknowledged partial save returns redacted HTTP 200; zero-ack, invalid/foreign and uncertain-only refusals retain ordinary behavior, while authorized retries remain usable.

## Slices and actual reference

- First working Sales list → New → three lines/edit/remove → Save → leave/reopen checkpoint shown at desktop and 390 px; continued to completion.
- Disposable PaneFlow 4301 at `d057daffd17a199309675a6b0a31c8bdbca05282`: actual Sales/Purchase lists, create, Add/remove, saved-draft editing and leave/reopen observed with synthetic SO-000002/PO-000001. Single organization selector visibly disabled.
- Reference JPEGs show actual disposable UI. Live 3000/original checkout, existing SO-000001 and retained Rain processes/data/locks untouched. Reference tax/payment/progression logic not imported.

## Gates

Form-usability correction (2026-09-25), executable `736b512940d2e5a1cefc3c8366ae70cee87ffc4c`:

- Full affected set against frozen `f2e818a3091513bc489681b577bf5edaf3618281` (tree equal to HEAD at start and end): format, lint, typecheck, build, schema, both release-freshness checks, boundaries (205 files), unit 166/166, compiler 175/175, integration 199/199, surface contracts 30/30, agent 3/3, architecture 195/195 including the new seam red control, language coverage (2,351 → 2,399 obligations, 601 → 631 observations, unhonored set unchanged). Browser 103/105 through the supported wrapper: the two failures were the receiving and SALE-FULFILLMENT journeys still choosing a counterparty from the retired full select. Their only change moves them onto the picker (test files only); both then pass at `736b512940d2e5a1cefc3c8366ae70cee87ffc4c`.
- The first full run, at `95fb6707`, found three real defects that the fix commit corrects: the client script was emitted on record pages that declare an editor without rendering one (meta-sales asserts script-free record pages); the new controls module was not registered in the SurfaceRuntime seam; the coverage decisions were stale for the new declarations.
- Order-entry browser 2/2 against PostgreSQL with the distributor master set: the lifecycle journey on pickers (drafts, reserve 8, ship 5, release remainder, packing 5 EA, receive 2 EA at 2.45 CAD, redaction after revocation); and the picker journey — 20 results plus More on the first page, server search finds a customer off that page, keyboard Enter searches and never saves, Escape cancel writes nothing, denied create writes nothing while selection still works, partial create stores one party and no role, then Retry completes it with one party and one customer role, duplicate create replay 409 with no second master, stale create return 422 with nothing written, read-back withheld is created but not selected, product created from line 1 returns to line 1 with its unit, Purchase "+ New vendor" stores a supplier role, and the no-JavaScript search/select/create-and-return stores one party with a customer role.
- A manual real-browser walk-through on the demo fixture also covered save with nothing selected (no write, problems named beside Customer and Line 1 product), a tampered currency refused, a 22-digit decimal refused before any write and kept exactly, four lines with a different line removed, save/leave/reopen, then an edit of quantity, price and notes plus a governed removal of a saved line, and an unchanged re-save that planned nothing.
- No CI polling, full local matrix, expected-red run, inherited audit or dependency installation. Fresh CI and the bounded ONLINE review are required and not claimed.

Earlier gates:

- Pass: typecheck, build, affected ESLint/Prettier, both artifact freshness checks, boundaries (204 files), language inventory (2,351 decision-covered obligations, zero execution receipts).
- Pass: affected canonical/compiler scope/adoption/normalization/determinism 27/27; workspace/catalog contracts 34/34; order-entry plus retained P1/P2 integration witnesses 12/12.
- Pass: composed Sales policy/lifecycle browser 1/1: denied update, stale draft, foreign scope, released-line refusal, unchanged stock; initial caller mismatches corrected with exact assertions.
- Pass: browser 3/3 (shared Sales/Purchase authoring with reopened editing and released guards, retained fulfillment JS on/off): exact two owned lines, unchanged draft movements/balances, 10/8/2 → 5/3/2 → 5/0/5, packing 5 EA, receiving 2 EA at entered 2.45 CAD.
- Final committed-source browser 1/1 at `20e5c1d4f389b1bcb887c6e71cf51d9e056cb731`: same complete journey, two-tab scope pin, Sales-read revocation after completion, HTTP 200 receipt with order data redacted, second persisted stock measurement unchanged. Initial diagnostic expectation used the wrong success case; corrected to existing Task-complete contract, no kernel change.
- CI attempt `35049655167` exposed one lint finding, three catalog codes without path drivers, stale Inventory composition equality, stale capability-7 expectations and a performance run indeterminate at 34.4% CPU idle. The correction removes the unused argument, drives all three messages through real requests, admits only the exact typed workspace addition while preserving every protected Inventory binding, and pins capability 8. Performance code, budget and timeouts are unchanged.
- Correction gates: complete message catalog 17/17 with 18/46 real path drivers; all seven affected PostgreSQL files 95/95, with Inventory posting independently 19/19; retained browser order-entry/meta-sales 3/3, Sales order 1/1, fulfillment 1/1 and receiving 1/1. Full lint, Prettier, both TypeScript checks, authored/release freshness and boundaries (204 files) pass. The final copy correction also passes workspace contracts 4/4 and the two affected architecture files 50/50 through the shared lock.
- CI run `35060214443` passed PostgreSQL, locale, catalog and the order-entry/meta-sales/Sales/fulfillment/receiving journeys, then exposed one ordinary-form script assertion, five obsolete composed-browser expectations and skipped quality-tail checks. The consolidated correction emits the CSP-pinned client enhancement only for a rendered eligible native Task dialog; ordinary native-picker pages are script-free. Browser expectations now prove owner navigation, contextual deep links, explicit company scope/continuity and the actual rail/raised-overlay focus grounds. Workspace-aware conformance preserves required owner/setup reachability while contextual surfaces remain reachable through their owner or deep links; the generic editor remains a typed SurfaceRuntime delegate and its value-import red control fails closed.
- Complete correction evidence: `surface-data-binding.test.ts` 58/58; integration 174/174; browser 104/104 through the unfiltered supported wrapper with every project/dependency; architecture 194/194; agent 3/3; surface contracts 30/30; expected-red 139/139 plus 38 self-controls; format, lint, typecheck, build, demo/app release freshness and language coverage pass. The prior CI PostgreSQL/locale pass was retained. The CPU-idle performance result was not retried and no budget, threshold, timeout or compiler code changed, as directed.
- Remaining F3 reproduced on reviewed candidate `8f88a279fa967bf2908f92919e9502284de5b1b4`: a first submission rendered the normal partial-failure editor after an acknowledged header update and later line failure; only then, header/child policy denial or provider failure made the same current continuation return generic 422 in all four cleared/retained-plan variants.
- Recovery evidence at executable `484a0da85f1aedcd77233ed4ec9ff953412257fc`: focused F1/F2/F3 14/14; complete `surface-data-binding.test.ts` 72/72; integration 188/188; surface contracts 30/30; browser 104/104 through the exact unfiltered wrapper; architecture 194/194; records OK; format, lint, typecheck, build and boundaries (204 files) pass. The new controls prove redacted HTTP 200, no protected values/forms/retry controls, no further invocation, safe repeats, refused invalid/foreign and zero-ack/uncertain-only continuations, and successful authorized retry. These are deterministic controlled-executor observations through real gateways and SurfaceRuntime; no new PostgreSQL execution or hosted qualification is claimed.
- Fresh candidate CI starts through the same stacked draft PR after push. No full local matrix, inherited audit, dependency installation or CI polling; CI/ONLINE verdict required and not claimed green.

## Test it yourself

In the Ubuntu worktree: `node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor`, then open the printed URL. Masters only: 45 parties, ~140 products, no orders.

1. Sales → New. Currency is a select (CAD default, USD, EUR); Notes is multiline. Enter an order number and a note first.
2. Customer: press Search with an empty box — 20 results and "More results"; Whitecourt Forestry is not among them. Type "Whitecourt" and Search (or press Enter): the server finds it. Arrow keys move through results; Enter selects; focus lands on "Change".
3. Change, type a customer that does not exist, then "+ New customer". The name carries over; add a number and contact, "Create and use". The order number, currency and notes are still there, and the new customer is selected. Escape or Cancel instead writes nothing and returns to the search box.
4. Line 1: search "notebook" and select — Unit shows EA. Add line; on the new line type a product that does not exist, "+ New product", give SKU and base unit: the line returns with that product and its unit. Quantities and prices accept exact decimals ("12.50" saves as 12.5).
5. Remove a different line, Save draft, leave, reopen and Edit: values are exact; change a quantity, a price and the notes, remove a saved line (confirm), save and reopen again.
6. Purchasing → New: the same editor with "+ New vendor" (creates a supplier role) and "Unit cost".
7. Save with the customer empty, or a quantity with 19+ decimals: nothing is saved and each problem is named beside its field.
8. At 390 px each line becomes a card. With JavaScript disabled the same search, select and create-and-return work as ordinary buttons.

Release, reservation, shipment, packing and receiving are unchanged from the steps recorded before this correction. Ctrl-C closes only this disposable fixture.

## Filed limits

- Production sign-in integration absent from loopback demo: trusted entry/current policy exist, while `composition-root.ts` explicitly selects `localDemoIdentity: true`. No fake login or production-authentication claim.
- Process loss/expiry loses unsaved buffers/preferences; reopen persisted records before retrying work. Neither durable drafts nor an atomic batch-save capability is added.
- PaneFlow commercial taxes/payment/FX, Purchase approval/supplier-invoice states and promised-date availability are outside existing Rain capabilities and this change.
- Form-usability limits (2026-09-25): the customer and vendor pickers search all parties — `party_list` has no role predicate and order save does not enforce the role, so a supplier-only party is selectable as a customer; search runs on submit or Enter, with no type-ahead (ADR-0036 §7); "+ New X" reflects declared availability, not a per-principal pre-check; no likely-duplicate warning before a quick create; composition Task reference inputs (for example Stock location) still render a full select; the textarea focus ring is the browser default because the focus-ring gate's exact selector set was not widened; no line or order totals, tax, discount, price list, payment terms or FX, because Rain has none of them.
- PR #5 alone remains unqualified for the selective Task client contract; the corrected PR #5 + PR #6 stack is the intended integration candidate, subject to fresh CI, ONLINE review and owner approval.

## Bounded ONLINE handoff

Review only the order-form usability correction on PR #6: from reviewed
`0566206d9ed41c2df301c2369d02446999f6063d` to executable `736b512940d2e5a1cefc3c8366ae70cee87ffc4c`. Read the
diff of `packages/canonical-model/src/{schemas,surface-workspace}.ts`,
`packages/domain/src/app/order-entry.ts`, `apps/web/src/{editor-controls,document-editor,surface-contract,workspace-entry,surface-client,surface-runtime}.ts`,
`packages/dev-tooling/src/surface-runtime-seam.ts`, ADR-0036 §2 and the affected
tests. Assess server authority over selection and quick create (offered-only
selection, verified carriers, stable keys, frozen retries, denied/partial/withheld/
stale outcomes, cancel), exact decimals, choice-as-editor-policy, the ADR-0036
boundary of the script, and whether the F2/F3 witness changes keep their subjects.
F1/F2/F3 and Task P1/P2 are closed; do not reopen them. Same ONLINE reviewer; no
merge/deployment.

Captures: `C:/Users/rvham/.codex/visualizations/2026/09/25/rain-order-entry-usability/` — `reference-paneflow/` (actual disposable PaneFlow `d057daff` composer, customer search, "+ New customer" dialog, one-row lines, compact), `rain-before/` (reviewed baseline editor), `rain-after/` (this correction at desktop and phone width, including the create dialogs, field problems and reopened editing) and `rain-proof/` (the picker browser proof's own captures).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "RAIN-ORDER-ENTRY",
  "base": "3830f95b6ff05c8e2b80113f812d59359a67f448",
  "head": "736b512940d2e5a1cefc3c8366ae70cee87ffc4c",
  "changedPaths": [
    ".agents/skills/ux-grammar/SKILL.md",
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/src/app-server.ts",
    "apps/web/src/component-registry.ts",
    "apps/web/src/document-editor.ts",
    "apps/web/src/editor-controls.ts",
    "apps/web/src/message-catalog.ts",
    "apps/web/src/surface-client.ts",
    "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/src/workspace-entry.ts",
    "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/message-catalog.spec.ts",
    "apps/web/test/browser/meta-sales.spec.ts",
    "apps/web/test/browser/order-entry.spec.ts",
    "apps/web/test/browser/receiving.composed-application.spec.ts",
    "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts",
    "apps/web/test/browser/sales-order.composed-application.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "docs/decisions/ADR-0015-legal-entity-business-dimension.md",
    "docs/decisions/ADR-0030-compiled-navigation-grouping.md",
    "docs/decisions/ADR-0036-minimum-client-capability.md",
    "docs/decisions/ADR-0037-workspace-context-bar.md",
    "docs/execution/current-plan.md",
    "docs/execution/lanes.md",
    "docs/execution/ledger.md",
    "docs/execution/packets/RAIN-ORDER-ENTRY.md",
    "docs/greenfield-north-star-erp-platform-plan.md",
    "packages/canonical-model/src/index.ts",
    "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-workspace.ts",
    "packages/compiler/src/projections.ts",
    "packages/dev-tooling/src/surface-grammar-conformance/index.ts",
    "packages/dev-tooling/src/surface-runtime-seam.ts",
    "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/purchasing/workspace.ts",
    "packages/domain/src/sales/workspace.ts",
    "packages/runtime/src/request-runtime-view.ts",
    "test/architecture/surface-grammar-conformance.baseline.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/architecture/surface-runtime-seam.test.ts",
    "test/compiler/adopted-language-shape.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/assert-composed-inventory.ts",
    "test/helpers/order-entry-fixture.ts",
    "test/integration/surface-data-binding.test.ts",
    "test/postgres/inventory-posting.test.ts",
    "test/postgres/inventory-stock-count.test.ts",
    "test/postgres/inventory-terminal-state.test.ts",
    "test/postgres/module-runtime.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/request-runtime-view.test.ts",
    "test/postgres/stock-serializer.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/src/document-editor.ts",
      "name": "documentEditor"
    },
    {
      "path": "packages/canonical-model/src/surface-workspace.ts",
      "name": "validateSurfaceWorkspaces"
    },
    {
      "path": "apps/web/src/editor-controls.ts",
      "name": "renderReferenceControl"
    },
    {
      "path": "apps/web/src/editor-controls.ts",
      "name": "canonicalDecimal"
    },
    {
      "path": "apps/web/src/surface-client.ts",
      "name": "SURFACE_CLIENT_SCRIPT"
    }
  ]
}
```
