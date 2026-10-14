# INVENTORY-PARITY — stock on the item page, and stock documents entered like documents

Status: S1 (the item page's stock by location and movements) and the stock-documents slice (adjustments entered in the shared document editor, transfers and opening stock through the same Post, STK- numbers, an Effective date of now) executable on draft PR #13 against `packet/PAYABLES` (stacked on #11 <- #10 <- #8 <- #7); no merge, no deployment. Sole LOCAL BUILD under the owner's standing instruction (2026-09-30: "go with recommended choice").
Tier: outside the Critical set — canonical grammar keys, the web runtime, domain metadata, the fulfillment read model and the Inventory posting route (`inventory-posting-capability-executor.ts`, the adapter, not the kernel); no posting-kernel, serializer, materializer, activation, verification, trust, migration or RLS change.
Base: `packet/PAYABLES` at `681f4675` (merged at `a3b104db` in `72c96e1b`, then its numbering-pin fix in `92de9d6e`). Reference: PaneFlow `d057daff`; designs `inventory-s1-design.md`, `design-inventory-documents.md`, `design-critical-small.md` (R3-R5); audit `inventory-parity-audit.md` (I1, I3, I8, I11, I12, I15).

## Owner rulings (2026-09-30, the recommended choice taken)

- S1-A: a composition dataset may be scoped by a field of its own entity (`fieldScope`), since stock and movements hold the item as plain text, not a relation.
- S1-B: the item page picks its company like an entry — an explicit offered company, else the only authorized one, else the last one chosen — with the company bar shown; with none chosen its company sections say one is required.
- S1-C: Incoming, open demand and projected stock are deferred to replenishment (audit S4).
- R3: opening stock is an adjustment with the reason OPENING: it only adds, and only where the item has no stock yet.
- R4: ADR-0027 is amended — transfers reach the posting route: `inventory_transaction_post` dispatches an adjustment to `postAdjustment` and a transfer to `postTransfer`; every other type gets the route's declared refusal (ADR-0063 §4 noted).
- R5': the four transaction fields (source type and id, recorded at, actor) stay required — the storage planner cannot relax a released field's NOT NULL — and the editor's first save writes them through `createValues`: the draft state, `inventoryTransaction`, the document's own id, the save's instant and the saving principal.
- Lines carry From location and To location, not one Location: the kernel pins the column to the sign.
- Numbers `STK-000001` (six digits): unlike the kernel's companion numbers `GR-`/`SH-`/`SC-<uuid>` in the same column, and every other sequence.
- The opening check is best-effort: an advisory read before posting, skipped on replay; a guarantee under the stock lock is a later Critical row.
- INV-A (2026-09-30): a new stock document's Effective date defaults to the instant the draft opens, not midnight UTC, so a same-day negative adjustment or transfer of stock received earlier that day is not refused as `INVENTORY_STOCK_NEGATIVE`.

## Claims

1. The item page is a declared composition over Catalog's item: its facts, then Stock by location (On hand, Reserved, Available; highest first) through the fulfillment read model's `stock` binding over `item_stock_positions`, and Recent movements (newest first). Both datasets declare `fieldScope` (optional v6 key): the runtime sends the record id as an exact field filter, re-authorized per request, and refuses an answer that does not echo it; the validator refuses both or neither scope, a scope field that is not a long-enough selected text field of the dataset's entity, and a company dataset on a shared record without an entry.
2. A stock document is entered in the shared draft document editor: header Type (Adjustment or Transfer only, a `choice` over the enumeration's option ids), Reason (Damaged, Found, Lost, Count error, Scrap, Opening stock, Relocation), Narrative, Effective date; lines Product (never created here), From location, To location, Quantity and the product's Unit (derived). The server numbers it on first save.
3. `createValues` (optional v6 key on a draft editor, 1-8 entries: a literal, the record id, the save's instant, the saving principal) is written on the header's first create only, never an update, a removal or a line; the validator holds each to a header field no editor field offers, with a value it admits, and the numbering validator refuses a numbered one. Surface floor 16 (`fieldScope` 15).
4. `defaultNow` (optional v6 key on an editor UTC date-time field): a never-saved document starts at the request clock's instant, to the second; the validator refuses it on any other field kind or beside another default. It raises no floor, like `defaultDaysFromToday`: a reader that dropped it shows an empty required date.
5. The posting route derives the document's own source and refuses a draft naming another (`the draft does not name itself as its posting source`); names a line whose From/To does not follow its sign; dispatches transfers to `postTransfer` (two distinct locations, quantity > 0; reserved stock stays, `FULFILLMENT_RESERVATION_SHORTAGE`); refuses a negative OPENING line, an OPENING transfer, and an OPENING line into a non-empty balance (advisory, not on replay). The declared verification refusal changed with the gate, byte for byte: "only adjustment and transfer drafts are admitted by this route".
6. Inventory transactions get a declared List (Number, Type, Reason, Effective, State; All, Drafts, Adjustments, Transfers) as an operational destination; a document's posted movements show Reason and Recorded.

## Decisions

- `documentEntry` is an option of `inventoryModuleDefinition` that only the product passes; the standalone kernel harness is byte-identical. Seeds that typed a transaction number, or posted a draft under another source, now make a stock document.
- The item page is authorized by the Posted stock List's query and has no action; the draft editor reads the request clock once for all its declared defaults.
- The editor list label map names "Inventory transactions" (the old two-way fallback labelled any other editor list "Purchase orders").
- Merge onto PAYABLES: its record alerts took floor 14, so `fieldScope` is 15 and `createValues` 16.
- Without Sales (the compiler's Sales-free fixture) or Inventory (the storage transition's), the item page is Catalog's plain record page and its stock query goes with Sales, as the grammar fixture already had it.

## Gates

- Pre-merge (`e23ad7b2`): prettier and eslint on every file the documents slice and INV-A touch; tsc clean; unit 21/21; web contract 35/35; integration INVENTORY-PARITY 3/3. INV-A's integration test reds with the midnight default (`00:00:00` for `14:03:27`).
- Merge `72c96e1b` (13 conflicts resolved) and release `341a8f8b`: tsc and eslint clean; release entry 6 (28,924,518 B) rebuilt from PAYABLES's five-entry envelope, `--check` PASS; demo release `--check` PASS; coverage 2654 -> 2673 obligations, 811 -> 831 observed, PASS. The second PAYABLES merge (`92de9d6e`) is test-only: the envelope stands.
- Pins from the compile: surface floor 16 (was 14); surfaces 101 and navigation leaves 16 unchanged; verification plan 573 scenarios, identical to PAYABLES's by kind, entity and subject (496 executed, 77 derived unchanged); eleven numbered fields, each uniqueness probe executed (PAYABLES ten). The storage target differs only by the item page query among the posted stock balance's reader ids, so the full-replay schema snapshot is not regenerated; CI's composed job, which checks it, is green.
- Local, one file at a time: architecture (grammar, hygiene, reachability, purity) 51/52, the lock control refused over another lane's live container (the gate working, lanes.md 2026-08-22); unit and compiler files over the composed app 143 -> two pins fixed, then 208/208; integration file 125/125; web contract 38/38; PostgreSQL `inventory-documents` 1/1; browser `inventory-documents` run through its Posts and refusals (INV-A observed: the -2 of stock received that day posts, effective 22:57:11). A local rerun of the composed journeys stopped in the dependency project when Docker refused to start containers on a memory-starved host; CI judged them.
- CI on PR #13: run 1 (`55dc465f`) green on the composed, commercial and Sales/platform browser jobs; red on four pins (declared Lists, the Sales-free compiler fixture, numbered fields, the Inventory-free transition fixture) and the journeys' header read, fixed in `cccac6a1`, `54260c2e`. Run 2 (`54260c2e`) green but the operations browser (movements read from a command's result page), fixed in `cee752ae`, `54284759`. Run 3 (`54284759`) green on every test job but two composed browser tests, fixed in `d3142109` (a heading read; a draft's empty Posted movements is the one expected message); the compile budget read COMPILE_BUDGET_INDETERMINATE (runner idle 89.9%).

## Test it yourself

`INVENTORY-PARITY-test-it-yourself.md`.

## Deferred

- Replenishment (audit S4): Incoming, open demand and Projected on the item page, reorder points, Stock by item and a buying worklist.
- Stock counts through Post (audit S5, Critical: STOCK-COUNTS), locations with status and bins (S6: LOCATIONS), approvals (APPROVAL-INVENTORY), lot/serial, valuation, unit conversions and the posting-date window: their own packets.
- An opening-stock guarantee under the stock lock (Critical, with the backdate packet); a period-lock form; warehouse mode.

## Filed

- Every route refusal is `INVENTORY_POSTING_INPUT_INVALID` and the page shows only the code: the user cannot tell "wrong column" from "opening into stock".
- A missing reason or narrative is refused at Post by the kernel's reason dials, not flagged by the editor.
- After Post a document answers with the command's result page (its fields, not its sections), and a refused Post with a diagnostic page that has no menu: the user reopens the document to see its movements.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "INVENTORY-PARITY",
  "base": "681f46751b2a4c3cc9027956534b741c35dd4a03",
  "head": "d3142109a5ab8694e793ed0330b3b2330fdbc646",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/control-semantics.ts",
    "apps/web/src/document-editor.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/src/workspace-entry.ts", "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/inventory-documents.spec.ts",
    "apps/web/test/browser/item-stock.spec.ts", "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts", "apps/web/test/surface-runtime-contract.test.ts",
    "docs/decisions/ADR-0027-inventory-transfer-command-family.md", "docs/decisions/ADR-0063-a-receipt-digest-covers-the-callers-input.md", "docs/execution/lanes.md",
    "docs/execution/packets/INVENTORY-PARITY-test-it-yourself.md", "docs/execution/packets/INVENTORY-PARITY.md", "package.json",
    "packages/canonical-model/src/field-numbering.ts", "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-composition.ts",
    "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/projections.ts", "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/list-declarations.ts", "packages/domain/src/app/order-entry.ts", "packages/domain/src/inventory/definition.ts",
    "packages/domain/src/inventory/item-stock-workspace.ts", "packages/domain/src/inventory/workspace.ts", "packages/domain/src/sales/workspace.ts",
    "packages/postgres-provider/src/fulfillment-read-model.ts", "packages/postgres-provider/src/inventory-posting-capability-executor.ts", "packages/runtime/src/request-runtime-view.ts",
    "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts", "test/compiler/g2-module-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/assert-composed-inventory.ts", "test/helpers/meta-sales-fixture.ts",
    "test/helpers/order-entry-fixture.ts", "test/helpers/reachability-producers.ts", "test/integration/surface-data-binding.test.ts",
    "test/postgres/composed-application.test.ts", "test/postgres/document-numbering.test.ts", "test/postgres/fulfillment.test.ts",
    "test/postgres/inventory-documents.test.ts", "test/postgres/inventory-posting.test.ts", "test/postgres/inventory-stock-count.test.ts",
    "test/postgres/inventory-terminal-state.test.ts", "test/postgres/item-stock.test.ts", "test/postgres/module-runtime.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/request-runtime-view.test.ts", "test/postgres/stock-serializer.test.ts",
    "test/unit/canonical-model/field-numbering.test.ts", "test/unit/canonical-model/surface-list.test.ts", "test/unit/inventory-definition.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/control-semantics.ts", "name": "declaredDefault"},
    {"path": "apps/web/src/document-editor.ts", "name": "createValuesFor"},
    {"path": "apps/web/src/workspace-entry.ts", "name": "entryCompanyChoice"},
    {"path": "packages/canonical-model/src/schemas.ts", "name": "SurfaceDocumentEditorSchema"},
    {"path": "packages/domain/src/inventory/definition.ts", "name": "inventoryModuleDefinition"},
    {"path": "packages/domain/src/inventory/item-stock-workspace.ts", "name": "itemStockWorkspace"},
    {"path": "packages/postgres-provider/src/inventory-posting-capability-executor.ts", "name": "transferCommand"},
    {"path": "packages/postgres-provider/src/inventory-posting-capability-executor.ts", "name": "assertDocumentSource"},
    {"path": "packages/postgres-provider/src/inventory-posting-capability-executor.ts", "name": "assertOpeningIntoEmptyStock"}
  ]
}
```

Review: not owed — outside the Critical set.
