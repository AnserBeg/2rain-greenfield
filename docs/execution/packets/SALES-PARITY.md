# SALES-PARITY — Rain's Sales workflows and shared List at PaneFlow parity through metadata

Status: in progress (draft PR stacked on PR #6); sole LOCAL BUILD; slices committed and pushed one by one.
Tier: Critical-touching — slice 2 adds one option at `release-verification-service.ts` (verification takes sentinel document numbers); one ONLINE arm is owed at the vertical checkpoint (prompt below).
Base: `994a7dc969694c8077630eaa536fcd385f7e030c` (tip of `packet/RAIN-ORDER-ENTRY`, PR #6, which contains PR #5 `3830f95b` and main `fe97b63b`).
Dependencies are building blocks, not qualifications: PR #5 owner acceptance pending (dialog layout not accepted as reference-equivalent); PR #6 fresh CI and owner acceptance pending. Nothing here closes either.
Reference: PaneFlow `d057daff` in an own disposable copy (`/home/rvham/paneflow-sales-parity-d057daff`, 127.0.0.1:3311, distributor seed; provider settings empty). Audit data and gallery: see the Evidence section.

## Owner rulings (2026-09-28, "go with all recommended")

- A numbering: server-assigned `SO-000001` per tenant at first draft save; not editable; never reused; gaps possible; `PO-` and `SHP-` the same way.
- B commercial: item default price per currency with marked manual override, line % discount, fixed-rate tax codes added on top and frozen on the line, freight + other fee with own tax code, half-up per-line rounding, one currency per order without FX, terms Due on receipt/Net 15/30/45/60 with invoice due = invoice date + terms.
- C receivables: internal invoice (INV-), credit note (CM-), recorded payment (PAY-), balance per invoice, void only while unpaid and uncredited; no ledger, no provider.
- D returns against a shipped line into a chosen location as a posted movement; credit separate (Critical arm owed).
- E salesperson = Party with a salesperson role, optional; customer default currency/terms/salesperson; ship-to address book with the order keeping its own copy; complete ship-to before shipping.
- F "Release" relabelled "Confirm"; Reopen a closed order while nothing on it is invoiced.
- G printable server-rendered order page, printed/saved as PDF by the browser.
- Deferred: credit hold/limits, price lists, drop-ship/special order, counter sale, email/QuickBooks/Helcim/cloud storage (REMAINDER).

## Claims

1. Declared List (slice 1): an optional v6 `surface.list` declares columns, one title, labels, status roles, date format, sortable columns, default sort, saved views, choice filters, page size and CSV export; the validator refuses every combination the runtime cannot honour (14 named refusals) and unknown keys fail the closed schema.
2. Every view, filter, search, sort, page and count is a query-gateway argument re-authorized per request; tab counts are server counts under the current search and filters; a page past the end answers the last page; nothing is filtered, sorted or counted in the browser.
3. A reference label names a field that stores another record's id through that record's declared unscoped list query; the gateway checks current read authority on the target, and PostgreSQL joins on the record id so search and sort by the label are complete facts. Without party read no customer name is disclosed.
4. Export is one statement bounded by the list query's declared `exportMaximumResultCount`; a larger set is refused with a page (`LIST_EXPORT_OVER_LIMIT`), never truncated; cells starting `= + - @` are neutralized.
5. The agent projection publishes each list query's export limit and each declared List's views/filters/sort/reference labels as query-argument presets; the same gateway answers them with the screen's counts.
6. Metadata-only variation: a recompiled variant with different views, order, page size and export limit is served by the unchanged runtime; Posted stock (a balance, not a document) and Purchase orders use the same mechanism.
7. Numbering (slice 2): an optional v6 field `numbering` (document sequence: prefix, minimum digits, start) removes the field from every writable input set and names it as a create assignment; a typed number is refused and writes nothing, an update cannot change it, and the validator refuses a non-text, optional, non-unique, too-short, duplicated-sequence, editor-offered or composition-bound number.
8. The executor allocates inside the create transaction under a per-tenant, per-sequence transaction lock: one past the highest existing number of that prefix among all the tenant's records (archived included, so never reused; all companies share the tenant sequence); ten concurrent creates take ten distinct consecutive numbers; a replayed idempotency key keeps its number; the change document records it.
9. Release verification's arranged records take `V-` sentinel numbers (`release-verification-service.ts` passes `documentNumbers: 'verificationSentinel'`), so an activation never consumes a tenant's sequence; before this, one activation took SO-000001…SO-000070.

## Decisions

- ADR-0047 §7: `surface.list`, the list column `format` and `exportMaximumResultCount` are optional keys on adopted v6, never materialized; runtime capability surface-manifest 10.
- The customer stays a text field: the posting kernel reads `customer_party_id` directly and relations are create-only while a draft's customer is editable, so a label join (no storage change) replaces a relation.
- Enum labels and dates come from the compiled per-field kinds (shared with compositions); a date column shows the UTC calendar date, as the editor labels its instants.
- Column selection and bulk actions are not in the reference for Sales orders and are not built; the existing selection bar stays.
- The export limit is declared by each module's own list query (5,000), not by the app layer.
- One lineage entry per increment, rebuilt from the previous pushed envelope; development compiles are discarded (entries 15 → 16 → 17).
- Numbering is a declared field property, not a counter table: no migration, no RLS change; allocation is protected max+1 (transaction lock + unique key), case-insensitive, so a typed legacy `so-000005` is continued, not collided with. Gaps are possible only through archived records; a rolled-back create returns its number.
- Sales orders `SO-`, Purchase orders `PO-` (non-Sales reuse), shipments `SHP-`; reservations and goods receipts keep their existing numbers (not in ruling A).

## Slices

1. Shared List — declared List on Sales orders, Purchase orders and Posted stock; executable `4d188d1c`. [Test it yourself §1]
2. Automatic numbering — SO-/PO-/SHP- assigned on create; executable `3e718be9`. [Test it yourself §2]

## Controls

- `verification-takes-sentinel-document-numbers` (removes the verification option) → claim 9; run by hand at `3e718be9` (the PR #6 demo holds a shared lock, so the exclusive `evidence:expected-red` run is left to the arm): red with "release verification must not consume real document numbers", restored by `git checkout --`, green again.

## Gates

- Local (shared lock; PR #6's demo holds a shared lock, so exclusive suites are left to CI): format, lint, typecheck, `check:app-release`; unit 171/171; compiler 175/175; integration 228/228; contracts 30/30; agent 3/3; container-free architecture files (131/134 then the three fixed); PostgreSQL `declared-list.test.ts` 2/2; browser `declared-list.spec.ts` 2/2 (keyboard journey and JavaScript off); `check:language-coverage` PASS; `check-records` OK. Executable `4d188d1c`.
- Not run locally: exclusive `test:architecture`, `test:postgres`, `test:browser`, performance, locale. `repository-hygiene` "matrix lock … bounded deadline" refuses while `north-star-*` containers exist (environment, not code).

## Test it yourself

§1 Shared List (under ten minutes). Serve: `node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor --order-volume=120` from `/home/rvham/2rain-greenfield-sales-parity`; open the printed `ORDER_ENTRY_URL`; Ctrl-C stops it and removes its container.
1. Sales orders shows tabs **All 120 · Draft 68 · Released 40 · Closed 0 · Cancelled 12**, "120 matching records", "Page 1 of 3", newest order date first, customer names (never ids).
2. Draft: "68 matching records", every status Draft. Tab with the keyboard and press Enter on a tab: same result.
3. Search `Chestermere` then Apply: only that customer's orders; every tab count now counts within the search.
4. Click the Customer header: A→Z (↑); click again: Z→A (↓).
5. All, Currency USD, Apply: "24 matching records". Clear.
6. Next, Last, then type 9 in the page box and Go: you land on Page 3 of 3, never an empty page.
7. Draft → Export CSV (68): the file has 68 rows plus a header; statuses read Draft, customers by name.
8. Narrow the window to phone width: the tabs scroll sideways inside their strip, orders become cards, the page never scrolls sideways.
9. Inventory → Posted stock: SKU, item name and location code, sortable, exportable. Purchasing → Purchase orders: the same tabs and filter (empty).
10. With JavaScript disabled, every tab, sort, filter, page and export still works (plain links and forms).

§2 Numbering. Serve the fixture without `--order-volume` (a fresh tenant).
1. Sales → New: there is no Order number field. Pick a customer, add a line, Save draft: the order opens as **SO-000001**; a second order is SO-000002.
2. Purchasing → New, save: **PO-000001** (its own sequence). Reserve and ship a released order: the shipment is **SHP-000001**.
3. Edit a draft: the number cannot be changed; Archive an order and create another: the archived number is not reused.

## Filed

- Global search (Ctrl K) is outside the List contract (SUP-01).
- Sales list row action "Post shipment" waits for slice 5.

Review: not owed yet — outside the Critical set (slice 1).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SALES-PARITY",
  "base": "994a7dc969694c8077630eaa536fcd385f7e030c",
  "head": "3e718be90049db97529b709818d3462b5f2e9908",
  "changedPaths": [
    "apps/api/src/composition-root.ts", "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json", "apps/web/src/app-server.ts",
    "apps/web/src/component-registry.ts", "apps/web/src/list-declaration.ts",
    "apps/web/src/message-catalog.ts", "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-contract.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/declared-list.spec.ts", "apps/web/test/browser/order-entry.spec.ts",
    "apps/web/test/browser/receiving.composed-application.spec.ts",
    "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts",
    "apps/web/test/browser/sales-order.composed-application.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts", "docs/execution/lanes.md",
    "docs/execution/packets/SALES-PARITY-inventory.md", "docs/execution/packets/SALES-PARITY.md",
    "package.json", "packages/canonical-model/src/field-numbering.ts",
    "packages/canonical-model/src/index.ts", "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-list.ts",
    "packages/compiler/src/compiler.ts", "packages/compiler/src/projections.ts",
    "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts",
    "packages/domain/src/app/order-entry.ts", "packages/domain/src/inventory/definition.ts",
    "packages/domain/src/purchasing/definition.ts", "packages/domain/src/sales/definition.ts",
    "packages/domain/src/sales/workspace.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/postgres-provider/src/release-verification-service.ts",
    "packages/runtime/src/list-behavior/contract.ts", "packages/runtime/src/list-behavior/cursor.ts",
    "packages/runtime/src/list-behavior/index.ts", "packages/runtime/src/request-runtime-view.ts",
    "packages/runtime/src/semantic-operation-gateway.ts",
    "packages/runtime/src/semantic-query-gateway.ts", "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.baseline.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/evidence/SALES-PARITY.expected-red.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/meta-sales-fixture.ts", "test/helpers/order-entry-fixture.ts",
    "test/helpers/reachability-producers.ts", "test/integration/surface-data-binding.test.ts",
    "test/postgres/composed-application.test.ts", "test/postgres/declared-list.test.ts",
    "test/postgres/document-numbering.test.ts", "test/postgres/fulfillment.test.ts",
    "test/postgres/receiving-authorization.test.ts",
    "test/unit/canonical-model/field-numbering.test.ts",
    "test/unit/canonical-model/surface-list.test.ts", "test/unit/purchasing-definition.test.ts"
  ],
  "symbols": [
    {"path": "packages/canonical-model/src/surface-list.ts", "name": "validateSurfaceLists"},
    {"path": "packages/canonical-model/src/schemas.ts", "name": "SurfaceListSchema"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "declareLists"},
    {"path": "apps/web/src/list-declaration.ts", "name": "declaredListArguments"},
    {"path": "apps/web/src/list-declaration.ts", "name": "declaredListCsv"},
    {"path": "packages/runtime/src/list-behavior/index.ts", "name": "parseSharedListArguments"},
    {"path": "packages/canonical-model/src/field-numbering.ts", "name": "validateFieldNumbering"},
    {"path": "packages/canonical-model/src/schemas.ts", "name": "FieldNumberingSchema"}
  ]
}
```
