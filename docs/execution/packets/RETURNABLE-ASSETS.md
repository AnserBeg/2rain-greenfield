# RETURNABLE-ASSETS — pallets, kegs and crates out with customers or held from suppliers, against a refundable deposit, off the stock ledger

Status: executable on draft PR #27 (stacked on #11, PAYABLES); no merge, no deployment. Round 1 (orchestrator-requested, owner-run) asked for changes; round 2 owed, ONLINE.
Tier: outside the Critical set — a Party capability (`northstar.party:capability.returnables`, `recordMutation`) with the existing grants; no posting-kernel, verification, trust, migration or RLS change; nothing writes a stock movement. Round 2 adds one optional v6 language key (`maintainedBy`, canonical-model and compiler, not Critical).
Base: `packet/PAYABLES` at `96ac2341`. Reference: PaneFlow `d057daff` (`db/schema.ts` returnable_asset_types/obligations/events, `lib/server/advanced-domain.ts` issue/updateReturnable, `operations-suite.tsx` Returnables).

## Owner rulings (recommended choices taken, 2026-10-05)

- RA-A off the stock ledger: no movement, no balance, nothing in the Critical set ("Sellable inventory unchanged").
- RA-B deposits are receivables facts in the custody's currency, no FX: each Issue and Refund records its amount, method entered by hand (cash, cheque, bank transfer), an optional reference, date and who; no provider.
- RA-C a forfeit converts the outstanding quantity into a charge covered by the kept deposit: recorded on the custody (Deposit kept), no invoice or bill fee (filed).
- RA-D custody records are numbered `RTN-000001` per tenant, as SO-/PO-/INV- are.

## Claims

1. Party declares, behind a `returnables` option only the product application passes (it requires the sales master data), `returnable_asset_type` (tenant-level: code, name, asset class, a deposit in CAD, USD and EUR), `returnable_custody` (company-owned, RTN-: party, direction out with a customer or held from a supplier, type, currency, frozen unit deposit, figures) and `returnable_event` (Issue, Return, Forfeit, Deposit refund; quantity, amount, method, optional reference, reason, date, recorded by).
2. `returnable_event_post` posts a draft event once under its custody's row lock and restates the custody's figures from its posted events (`applyReturnableEvent`, `custodyStatement`). Over the posted events: return plus forfeit never exceeds what was issued; a refund never exceeds the deposit on what came back less what was refunded; quantities are whole assets and amounts whole cents.
3. The unit deposit freezes at a custody's first Issue from the type in the custody's currency (an unstated deposit is refused, 0 is free); a deposit taken or refunded names its method; one activated custody (one whose first Issue posted) per company, party, type, direction and currency: a second's first Issue is refused, naming the first, under a transaction lock on that key; several New records may exist, and a Closed one still blocks. Issue out needs an active customer role, held an active supplier role; a custody whose party or type link differs from its party or type field is refused.
4. The custody figures (unit deposit, every quantity and deposit total) and an event's attribution are maintained by the capability (`maintainedBy`): no generic create or update names them, so a New custody is the canonical empty image (state New, every figure absent) until a posted event restates them. Generic writes change a custody only while New and an event only while a draft.
5. A custody names its type through a reference link that restricts the type's archive: a type is not archived while a live custody names it, and an archived type starts no custody.
6. Metadata: the custody page (figures, events; Issue always offered — it records more, it is not a preview; Return, Forfeit and Refund deposit only where the figures admit each); the party page's Returnables section with Open custody and Issue returnables; Party's Returnable type, Returnables out and Returnables held Lists (views Open, Awaiting refund, Closed, All, each keeping its direction; currency filter; CSV).
7. Shared runtime: a tenant-level record page whose workspace declares a company entry (the party page) enters a company for its company-owned children as a List does — the URL's choice validated against the caller's authorized companies, else the only or preferred one pinned by redirect — and shows it in the Company bar under the entry's parameter, each choice keeping the record. Entered in none, it displays no company-owned children (the section says "Legal entity required") and offers no Task that writes in a company; its own tasks still serve. Entry still probes the authorization List in each candidate company.
8. Shared runtime: a child row's label that its referenced record cannot give (withheld or gone) reads "—" in that cell; the section keeps its rows.
9. Shared runtime CSS: every `.data-table-wrap` is now the containing block of its absolutely positioned descendants (`position:relative`), so a List table wider than its panel scrolls inside it and no List widens the page (`59e16ff5`).
10. Language: an optional v6 field key `maintainedBy` names the registered capability that alone writes the field; the compiler leaves it out of every generic create's and update's writable inputs, and normalization refuses a declaration the runtime could not honour (`validateFieldMaintenance`).

## Decisions

- Returnables live in Party: a custody belongs to its party, whose page lists it through its relation; types are Party master data. Nav: Party gains three Lists (16 -> 19 navigation surfaces).
- The custody is company-owned (deposits are receivables facts); the party is the tenant's, hence the runtime entry for its page. The custody stores its party and its type both as a field (Lists label and search them, the key reads them) and as a link; the capability refuses a mismatch.
- An event names its custody by reference, not as an owned child: an owned child is written only while its parent's generic writes are admitted, and a custody stops admitting them at its first Issue (`5a0bcca1`).
- A deposit is recorded on its event, not as a PAY-/VPAY- row: a customer payment settles an invoice's balance and modules do not relate across each other (filed).
- A Return makes the deposit on it refundable; the refund is its own event. A refused post leaves its draft event, shown as Draft.
- The asset class keeps its six classes, rendered as a typed suggestion field (five-option select limit).
- Returnables out keeps its nine columns; wider than the panel at 1280 px it scrolls inside the panel (`59e16ff5`).
- F1 (round 1): the figures leave generic inputs through a language key, not a precondition: the language had no per-field write authority (a machine's state field and a numbered field were the only exclusions), release verification fills every writable field of the records it arranges, and the runtime admits no decimal comparison. `maintainedBy` rides v6 as `numbering` did (ADR-0047 §7); coverage decisions re-derived (2654 -> 2658 obligations, 811 -> 815 observed). An event's `recorded_by` is maintained too (same class: a caller could attribute a draft).
- F3 (round 1, recommended choice): archive of an in-use type is restricted through the custody's type link (`MODULE_ARCHIVE_RESTRICTED`, the platform's refusal), rather than showing archived labels; separately, one unreadable row label reads "—" instead of failing its section.
- F2 (round 1): the unentered section reuses the platform's `QUERY_LEGAL_ENTITY_SCOPE_REQUIRED` message (a List with no company says the same); the "no Task without a company" rule is generic (a Task binding `generated: scope`), and only Issue returnables binds it on a tenant-level page today.
- The lineage-advancing composed tests split as RETURNS split them, ported from INTEGRATION 3bcb1d25 with its `LINEAGE_INSTALL_VOLUME` preset; no bound changes.

## Gates

- Round 0 (`abbdfdd5`..`2a9db6d4`): tsc, eslint, prettier; unit, compiler, integration, architecture 200/200, web contract, agent; PostgreSQL `returnables` 2/2 (its first run found the owned-child defect, `5a0bcca1`); CI green at `aec64afe` (run https://github.com/AnserBeg/2rain-greenfield/actions/runs/37357481589), the browser spec's 1292 px page fixed in shared CSS (`59e16ff5`) and the composed split ported (`2a9db6d4`).
- Round 1 fixes: reproduced red first (`dfa12785`, integration, local): F1 the custody create's writable set named the ten figures; F2 no Company bar on a two-company party page; F3 one unreadable type label failed the whole Returnables section ('failed' !== 'ready'). Fixed `c8b4576a` (language key), `c547d2ad` (returnables), `275ef7e6` (web).
- Local after the fixes (tree `22802660`): tsc, eslint, prettier clean; unit 211/211; compiler 175/175 (the inventory-contract golden gains the custody-to-type rule); integration 242/242; agent 3/3; web contract 35/35; `check:app-release` (one entry on PAYABLES's five, rebuilt from base; authored 2,096,844 B, check at 2,097,152 B, no compact port needed); `check:language-coverage` PASS (2658 obligations, 815 observed); `check:expected-red` OK (171 entries in 14 manifests).
- Measured pins: verification scenarios 634 -> 635 (custody 27 -> 28: the type link's archive-restrict scenario), executed 557 -> 558, derived 77; surfaces 111, navigation 19, policy bindings 16 unchanged.
- PostgreSQL and browser not run locally (Windows free memory under the 1200 MB floor); GitHub runs them: PENDING.
- Controls (`test/evidence/RETURNABLE-ASSETS.expected-red.json`, nine entries, run on GitHub by label): PENDING.

## Test it yourself

`RETURNABLE-ASSETS-test-it-yourself.md`.

## Filed

- F4 (round 1, inherited shared runtime): generic edits through a company-owned surface are not bound to the URL's company — fixed separately by COMPANY-BOUND-WRITES (INTEGRATION). The integration test `RETURNABLE-ASSETS (F4, …)` documents today's behaviour (an archive posted through company A's custody URL acts on company B's record) and flips there.
- Isolation: `withTrustedRequestTransaction` opens with plain BEGIN, so the bounds and the cross-record duplicate proof assume Read Committed (a fresh snapshot per statement after a lock wait); Repeatable Read would break the duplicate check. Trust code (Critical) is unchanged.
- A forfeit beyond the kept deposit (a replacement charge) as an invoice or bill fee (RA-C).
- Deposit payments and refunds as PAY-/VPAY- rows (RA-B): needs a payment that settles no invoice.
- A refused first Issue from the party page leaves its New custody record (no figures) and draft event, archivable.
- At 1280 px Returnables out scrolls its last columns inside the panel; a column priority that hides some first is a List-grammar choice.
- `maintainedBy` exists now; receivables' and payables' document totals (paid, balance) could adopt it.

Review: no arm owed (outside the Critical set); round 1 requested by the orchestrator for the shared-runtime change; round 2 owed for its findings: `RETURNABLE-ASSETS-review-prompt.md`.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "RETURNABLE-ASSETS",
  "base": "96ac234122322b2cbe18349299664f56c8f5190a",
  "head": "2280266057e8643cf1ad50386d7514373d5a6764",
  "changedPaths": [
    "apps/api/src/composition-root.ts", "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json", "apps/web/src/surface-composition.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/src/workspace-entry.ts", "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/customer-defaults.spec.ts",
    "apps/web/test/browser/receivables-returnables.spec.ts", "package.json", "packages/canonical-model/src/field-maintenance.ts",
    "packages/canonical-model/src/index.ts", "packages/canonical-model/src/normalize.ts", "packages/canonical-model/src/schemas.ts",
    "packages/compiler/src/conformance.ts", "packages/compiler/src/projections.ts",
    "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts", "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/inventory/contracts.ts", "packages/domain/src/party/definition.ts", "packages/domain/src/party/index.ts",
    "packages/domain/src/party/returnables.ts", "packages/domain/src/party/workspace.ts", "packages/postgres-provider/package.json",
    "packages/postgres-provider/src/inventory-posting-error.ts", "packages/postgres-provider/src/returnables-capability-executor.ts", "test/architecture/module-press-law.test.ts",
    "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts", "test/compiler/inventory-contract.release.golden.json",
    "test/evidence/RETURNABLE-ASSETS.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json",
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
    {"path": "packages/canonical-model/src/field-maintenance.ts", "name": "validateFieldMaintenance"},
    {"path": "test/helpers/without-returnables.ts", "name": "withoutReturnables"}
  ]
}
```
