# RETURNABLE-ASSETS — pallets, kegs and crates out with customers or held from suppliers, against a refundable deposit, off the stock ledger

Status: executable on draft PR #27 (stacked on #11, PAYABLES); no merge, no deployment. Sole LOCAL BUILD under the owner's standing instruction.
Tier: outside the Critical set — a Party capability (`northstar.party:capability.returnables`, `recordMutation`) with the existing grants; no posting-kernel, verification, trust, migration or RLS change; nothing writes a stock movement.
Base: `packet/PAYABLES` at `96ac2341`. Reference: PaneFlow `d057daff` (`db/schema.ts` returnable_asset_types/obligations/events, `lib/server/advanced-domain.ts` issue/updateReturnable, `operations-suite.tsx` Returnables).

## Owner rulings (recommended choices taken, 2026-10-05)

- RA-A off the stock ledger: no movement, no balance, nothing in the Critical set ("Sellable inventory unchanged").
- RA-B deposits are receivables facts in the custody's currency, no FX: each Issue and Refund records its amount, method entered by hand (cash, cheque, bank transfer), reference, date and who; no provider.
- RA-C a forfeit converts the outstanding quantity into a charge covered by the kept deposit: recorded on the custody (Deposit kept), no invoice or bill fee (filed).
- RA-D custody records are numbered `RTN-000001` per tenant, as SO-/PO-/INV- are.

## Claims

1. Party declares, behind a `returnables` option only the product application passes (it requires the sales master data), `returnable_asset_type` (tenant-level: code, name, asset class, a deposit in CAD, USD and EUR), `returnable_custody` (company-owned, RTN-: party, direction out with a customer or held from a supplier, type, currency, frozen unit deposit, figures) and `returnable_event` (Issue, Return, Forfeit, Deposit refund; quantity, amount, method, reference, reason, date, recorded by).
2. `returnable_event_post` posts a draft event once under its custody's row lock and restates the custody's figures from its posted events (`applyReturnableEvent`, `custodyStatement`): return plus forfeit never exceeds what was issued; a refund never exceeds the deposit on what came back less what was refunded; quantities are whole assets and amounts whole cents.
3. The unit deposit freezes at a custody's first Issue from the type in the custody's currency (an unstated deposit is refused, 0 is free); a deposit taken or refunded names its method; one custody record per party, type, direction and currency (a second's first Issue is refused, naming the first, under a transaction lock); an Issue out needs an active customer role, held an active supplier role; a custody whose party link and party field differ is refused.
4. Generic writes change a custody only while New and an event only while a draft (create image included), so only the capability moves a figure.
5. Metadata: the custody page (figures, events, Issue, Return, Forfeit, Refund deposit, each offered only where its figures admit it); the party page's Returnables section with Open custody and Issue returnables; Party's Returnable type, Returnables out and Returnables held Lists (views Open, Awaiting refund, Closed, All, each keeping its direction; currency filter; CSV).
6. Shared runtime: a tenant-level record page whose workspace declares a company entry (the party page) enters a company for its company-owned children as a List does — the URL's choice validated against the caller's authorized companies, else the only or preferred one pinned by redirect — and reads none while it has no company, so its own tasks still serve (`workspaceEntryParameter`).
7. Shared runtime CSS: a List table wider than its panel scrolls inside its wrapper (`.data-table-wrap`, now the containing block of its hidden header hints), so no List widens the page (`59e16ff5`).

## Decisions

- Returnables live in Party: a custody belongs to its party, whose page lists it through its relation; types are Party master data. Nav: Party gains three Lists (16 -> 19 navigation surfaces).
- The custody is company-owned (deposits are receivables facts); the party is the tenant's, hence the runtime entry for its page. The custody stores its party both as a field (Lists label and search it) and as a relation (the party page reads it); the capability refuses a mismatch.
- An event names its custody by reference, not as an owned child: an owned child is written only while its parent's generic writes are admitted, and a custody stops admitting them at its first Issue (found by the PostgreSQL proof, fixed `5a0bcca1`).
- A deposit is recorded on its event, not as a PAY-/VPAY- row: a customer payment settles an invoice's balance (its invoice link is required and its post is bounded by that balance), and modules do not relate across each other (filed).
- A Return makes the deposit on it refundable; the refund is its own event (PaneFlow's "Deposit refund remains a separate financial action"). A refused post leaves its draft event, shown as Draft, as a refused payment does.
- The asset class keeps its six classes, which the grammar renders as a typed suggestion field (five-option select limit); the spec and the test-it-yourself enter it that way.
- Returnables out keeps its nine columns; wider than the panel at 1280 px, its table scrolls inside the panel (the shared CSS fix `59e16ff5`) rather than losing columns.
- The owner asked for a round-1 review although no arm is owed outside the Critical set; the prompt asks neutral questions only.
- The lineage-advancing composed tests split as RETURNS split them, ported byte-identical from INTEGRATION 3bcb1d25 with its `LINEAGE_INSTALL_VOLUME` preset in place of the per-test 1 GB literals; no bound changes.

## Gates

- `abbdfdd5`..`5e4427a5` (own worktree, on AC): full tsc clean; eslint and prettier clean; unit 196/196 (returnables 6/6; `dev-environment` not run, container lifecycle); compiler 180/180 (the performance budget passes alone; it runs alone on CI); integration 241/241; architecture 200/200; web contract 35/35; agent 3/3.
- Release entry 6 on PAYABLES's 5 (`--check` PASS). Pins from a compile: surfaces 101 -> 111, navigation surfaces 16 -> 19, verification scenarios 573 -> 634 (557 executed, 77 derived; returnable type 14, custody 27, event 20), RTN- numbered (11 uniqueness probes), 16 policy bindings, the inventory-contract golden (three families, two relation rules), the press-law debt. Coverage unchanged: 2654 obligations, 811 observed (no re-derivation owed). Surface floor unchanged (no new key).
- PostgreSQL `returnables` (local, one file under the lock, on AC): 2/2 in 336 s at `4bfc5779`; its first run found the owned-child defect fixed at `5a0bcca1`. Full-replay snapshot regenerated on GitHub (run 37338740492, additions only: 3 tables), committed `226c2c01`.
- CI at `8752aa3e`: quality, browser (3 jobs), PostgreSQL schema/isolation and commercial passed; composed failed only on the then-stale snapshot (fixed `226c2c01`).
- Architecture 200/200 locally at `ffc0dcf6` (rerun after the record-claim fill).
- CI at `ffc0dcf6` (run 37341436034): quality, browser, composed browser, PostgreSQL schema/isolation and commercial (`returnables` 2/2, first GitHub run) passed. Three reds, none a returnables fact: the performance budget `COMPILE_BUDGET_INDETERMINATE` (CPU idle 73.9% < 90%, the GitHub flake; not relaxed); PostgreSQL composed out of data disk at six lineage entries (the two lineage-advancing tests get 1 GB, as LOCATIONS `86b5537f`: `c233beda`); the browser spec's locators (Party group label, the six-class datalist, task selects by accessible name: `b7137ea6`, `059d008f`, `5babf180`).
- CI at `5babf180` (run 37344849073): the browser spec ran the whole custody journey, both refusals included, and stopped at the Returnables out capture: a 1292 px page at 1280 px. Measured on rendered List HTML in headless Chromium: a sortable header's `.sr-only` hint in a column past the panel escaped the table's scrolling wrapper. Fixed in the shared runtime CSS (`59e16ff5`, `.data-table-wrap{position:relative}`): page 1280 px, the table scrolls in its panel; 390 px unchanged.
- After `59e16ff5`: tsc, eslint, prettier, `check:app-release` clean; unit (returnables, workspace contract, hex ratchet) 26/26; web contract 35/35; integration 241/241. Local browser run stopped for the owner's Docker pause (no container left); CI runs the spec.
- CI at `8a9dcad4` (run 37347540167): quality, browser (3 jobs, the returnables spec included), PostgreSQL commercial and schema/isolation passed. Two reds: the performance budget `COMPILE_BUDGET_INDETERMINATE` again (CPU idle 76.5%); PostgreSQL composed timed out the advancement parent at its 300 s bound (the rollback-edge test beside it 275 s; base PAYABLES ran the parent in 147 s in a quiet hour). RETURNS met the same bound at lineage entry 6; its split, ported test-only with INTEGRATION's 1 GB preset (`2a9db6d4`, from 3bcb1d25), keeps every 300 s bound.
- CI at the docs head over `2a9db6d4`: running at this commit; the green run is added when it lands.

## Test it yourself

`RETURNABLE-ASSETS-test-it-yourself.md`.

## Filed

- A forfeit beyond the kept deposit (a replacement charge) as an invoice or bill fee (RA-C).
- Deposit payments and refunds as PAY-/VPAY- rows on the receivables and payables pages (RA-B): needs a payment that settles no invoice.
- A tenant with several companies and no company preference reaches a party's returnables after choosing a company on a List; the party page has no company switcher, and its Issue returnables refuses until one is entered.
- A refused first Issue from the party page leaves its New custody record and draft event (archivable), as a refused post leaves its draft elsewhere.
- At 1280 px Returnables out scrolls its last columns inside the panel (a 1054 px table in 922 px); a column priority that hides some first is a List-grammar choice.

Review: no arm owed (outside the Critical set); the owner asked for round 1 anyway: `RETURNABLE-ASSETS-review-prompt.md`.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "RETURNABLE-ASSETS",
  "base": "96ac234122322b2cbe18349299664f56c8f5190a",
  "head": "2a9db6d499d1eb0520fb368a0aea4ba6efee3c5b",
  "changedPaths": [
    "apps/api/src/composition-root.ts", "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json", "apps/web/src/surface-composition.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/src/workspace-entry.ts", "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/customer-defaults.spec.ts",
    "apps/web/test/browser/receivables-returnables.spec.ts", "package.json", "packages/compiler/src/conformance.ts",
    "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts", "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/inventory/contracts.ts", "packages/domain/src/party/definition.ts", "packages/domain/src/party/index.ts",
    "packages/domain/src/party/returnables.ts", "packages/domain/src/party/workspace.ts", "packages/postgres-provider/package.json",
    "packages/postgres-provider/src/inventory-posting-error.ts", "packages/postgres-provider/src/returnables-capability-executor.ts", "test/architecture/module-press-law.test.ts",
    "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts", "test/compiler/inventory-contract.release.golden.json",
    "test/helpers/generate-fresh-tenant-full-replay-schema.ts", "test/helpers/postgres.ts", "test/helpers/reachability-producers.ts",
    "test/helpers/without-returnables.ts",
    "test/integration/surface-data-binding.test.ts", "test/postgres/composed-application.test.ts", "test/postgres/document-numbering.test.ts",
    "test/postgres/fresh-tenant-full-replay-schema.snapshot.json", "test/postgres/module-storage-transition.test.ts", "test/postgres/returnables.test.ts",
    "test/unit/canonical-model/field-numbering.test.ts", "test/unit/canonical-model/surface-list.test.ts", "test/unit/returnables.test.ts"
  ],
  "symbols": [
    {"path": "packages/domain/src/party/returnables.ts", "name": "returnablesDeclarations"},
    {"path": "packages/domain/src/party/workspace.ts", "name": "returnableCustodyWorkspace"},
    {"path": "packages/postgres-provider/src/returnables-capability-executor.ts", "name": "applyReturnableEvent"},
    {"path": "packages/postgres-provider/src/returnables-capability-executor.ts", "name": "custodyStatement"},
    {"path": "packages/postgres-provider/src/returnables-capability-executor.ts", "name": "RETURNABLES_CAPABILITY_EXECUTOR_FACTORY"},
    {"path": "apps/web/src/workspace-entry.ts", "name": "workspaceEntryParameter"},
    {"path": "test/helpers/without-returnables.ts", "name": "withoutReturnables"}
  ]
}
```
