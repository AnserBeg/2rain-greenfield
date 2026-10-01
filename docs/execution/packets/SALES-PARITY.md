# SALES-PARITY — Rain's Sales workflows and shared List at PaneFlow parity through metadata

Status: vertical checkpoint (2026-09-29) — slices 1-4, 5a, 6, 7, 8 and five review rounds' fixes executable and pushed; returns, List row actions and exceptions not built; draft PR #7 open (Gates); no merge, no deployment. Sole LOCAL BUILD.
Tier: Critical-touching — `release-verification-service.ts` (claims 9, 20, 21) and materializer grant SQL (claims 10-11); the ONLINE confirm arm is owed (`SALES-PARITY-review-prompt.md`).
Base: `994a7dc969694c8077630eaa536fcd385f7e030c` (tip of `packet/RAIN-ORDER-ENTRY`, PR #6, which contains PR #5 `3830f95b` and main `fe97b63b`).
Dependencies are building blocks, not qualifications: PR #5 and PR #6 owner acceptance and fresh CI are pending; nothing here closes either.
Reference: PaneFlow `d057daff`, own disposable copy on 127.0.0.1:3311 (distributor seed); audit and gallery in `SALES-PARITY-inventory.md`.

## Owner rulings (2026-09-28, "go with all recommended")

- A numbering: server-assigned `SO-000001` per tenant at first draft save; not editable; never reused; gaps possible; `PO-` and `SHP-` the same way.
- B commercial: item price per currency with a marked manual override, line % discount, fixed-rate tax codes on top and frozen on the line, freight + other fee each with its own tax code, half-up per-line rounding, one currency per order (no FX), terms Due on receipt/Net 15/30/45/60 (invoice due = invoice date + terms).
- C receivables: internal invoice (INV-), credit note (CM-), recorded payment (PAY-), balance per invoice, void only while unpaid and uncredited; no ledger, no provider.
- D returns against a shipped line into a chosen location as a posted movement; credit separate (Critical arm owed).
- E salesperson = Party with a salesperson role, optional; customer default currency/terms/salesperson; ship-to address book with the order's own copy; complete ship-to before shipping.
- F "Release" reads "Confirm"; Reopen a closed order while nothing on it is invoiced.
- G printable server-rendered order page, printed or saved as PDF by the browser.
- Deferred: credit hold/limits, price lists, drop-ship, counter sale, email/QuickBooks/Helcim/cloud storage (REMAINDER).

## Claims

1. Declared List (slice 1): optional v6 `surface.list` (columns, one title, status roles, date format, sort, saved views, choice filters, page size, CSV export); 14 named refusals; unknown keys fail the closed schema.
2. Every view, filter, search, sort, page and count is a query-gateway argument re-authorized per request; tab counts are server counts; a page past the end answers the last page.
3. A reference label is read through the target's declared unscoped list under current read authority; PostgreSQL joins on the record id, so search and sort by label are complete (customer, salesperson).
4. Export is one statement bounded by the list query's `exportMaximumResultCount`; larger sets are refused (`LIST_EXPORT_OVER_LIMIT`), never truncated; `= + - @` cells are neutralized.
5. The agent projection publishes each export limit and each List's views/filters/sort/labels as query presets answered by the same gateway.
6. A metadata-only List variation is served by the unchanged runtime; Posted stock and Purchase orders use the same mechanism.
7. Numbering (slice 2): a `numbering` field leaves every writable input set; a typed number is refused before any business write (stored numbers unchanged); the validator refuses non-text, optional, non-unique, duplicated, editor-offered or composition-bound numbers, a field too short for its first number (start included) or under 18 characters (room for 64-bit verification sentinels), and the prefix `V`.
8. Allocation runs inside the create transaction under a per-tenant, per-sequence lock: one past the highest `PREFIX-digits` among every record of the tenant (archived, every company), any digit count, read through the business key's stored fold (its folded companion; the fold function only on a legacy target); a next number that no longer fits refuses as `MODULE_DOCUMENT_SEQUENCE_EXHAUSTED`; ten concurrent creates take ten consecutive numbers; a replay keeps its number. The unique key is the backstop among live records of its scope.
9. **Critical.** Release verification's arranged records take `V-` sentinel numbers (`documentNumbers: 'verificationSentinel'`); no sequence may use the prefix `V`, so a sentinel never reads as, advances or collides with a business number. A sentinel keeps at least 64 bits: arranged records collide only with negligible probability, not provably never.
10. **Critical.** A column a later release adds to a company-scoped table (not fact, not period-lock) gets the column UPDATE grant the table's creation gives its mutable columns (`case 'addColumn'`).
11. **Critical.** Replaying a company-scoped table's creation for another tenant revokes UPDATE at table level only when a table-level grant exists, so a later release's column grants survive (`createManagedTable`).
12. Slice 5a/6: the release command reads "Confirm"; a closed order reopens (confirmed); the ship task requires carrier and tracking or BOL, kept on the shipment; Sales and Purchase orders print as a server-rendered document.
13. Slice 3 vocabulary (optional v6 keys; surface floor 11): editor `defaultFrom` (an editable default reset whenever a sibling picker's selection changes), scoped pickers `reference.within`, Task input `eligibility`, and record `blocks`; the validator refuses incompatible, derived-target, cyclic, unscoped or header-duplicated declarations.
14. Defaults are planned first and applied in one synchronous step while their reference holds the planned selection; a carrier change keeps the values the same submission set; a scoped picker selects only records its relation ties to the sibling, checked on every route.
15. Ruling E: salespeople are parties with an active salesperson role (the only ones offered); the customer workspace sets order defaults and an address book; Confirm and every initial shipment (any caller) require a complete ship-to, which the shipment keeps.
16. Ruling B (slice 4): choosing a product prices the line in the order currency (`defaultFrom.sourceByHeader`), keeps its list price and freezes the order tax code's rate; a currency change re-prices lines still at list price; a price set by hand reads "Manual price". Line % discount; freight and other fee each with a frozen-rate code.
17. The commercial read model states each line's amount and tax and the order's subtotal, charges, tax and total: exact decimals, half up per line, one currency; an unstated figure is null and nulls every total it feeds. The draft editor reads through the header form's plain get, never the read model.
18. Ruling C (slice 7): the receivables capability invoices an order's shipped, not yet invoiced quantity per line at the line's frozen price, discount and rate (charges on the order's first live invoice; due = invoice date + terms), under the order's row lock; payments and credits post in whole cents up to the balance under the invoice's row lock; void only while nothing is settled; Reopen is refused while an invoice counts (ruling F). INV-/PAY-/CM- numbers; generic writes only on drafts.
19. Commands are offered only where they apply: capability commands declare preconditions (Close and Cancel on a confirmed order, Reopen on a closed one, post on a draft, void on an open invoice), and "Invoice shipped quantities" is offered only while the commercial read model states uninvoiced shipped quantity and a stated total.
20. **Critical.** Release verification reads its probe records through each entity's plain query of a type that its gateway executes (active, Q0, a filter the gateway's fence accepts: `gatewayExecutesQ0`), never a read-model query of the same type, whose executor its gateway does not register (`#queryForEntity`). Cleanup skips only a record a probe archived; a record it cannot read is refused by name (`VERIFICATION_PROBE_RECORD_UNREADABLE`) once every readable record is archived (round 5, P2b).
21. **Critical.** Verification counts a create's assigned numbers as written by the create, so a numbered entity executes its scenarios (125 of 485 had derived); arranged records carry their assigned values, read back from the create; a number's uniqueness-fold scenario probes what a caller can observe (two creates store fold-distinct values; a supplied case variant is refused as input, naming the field). The compiler's plan is unchanged (ADR-0047). A create's read-back is a projection: an assigned number it omits is read through a plain get that selects it and that the gateway executes, else taken as its deterministic sentinel, and every create is registered for cleanup before its numbers are read (round 4, R1; round 5, P2a).
22. Slice 8 (optional v6 keys): a List or record column declared `money` shows an exact decimal grouped with at least two decimals, never rounded, beside its document's currency (CSV keeps stored values); an editor UTC date-time field declared `defaultDaysFromToday` starts a never-saved draft that many days out at midnight UTC (the order's requested date: 21).

## Decisions

- ADR-0047 §7: every new key is optional and non-materialized on adopted v6; two released bounds widen compatibly (choice values 64 → 180, editor header fields 20 → 30); no language version.
- Party and Catalog gain Sales data behind factory options (`salesMasterData`, `sellingPrices`) that only the product application passes; the standalone harnesses compile what they always did.
- The Party default currency is an enumeration (CAD/USD/EUR): a new searchable text column on an existing table has a deferred folded column that verification reads before it exists, and a 3-character text value is not distinguishable in search.
- Confirm requires the complete ship-to (stricter than "before shipping"): a confirmed header is no longer editable, so a later address could never be added; street, city, postal code and country are required.
- Choosing a customer resets currency, terms, salesperson, tax code and ship-to to its defaults (or the field default); the address list is contextual to Party, not navigation.
- The customer is still a text field joined by label (the posting kernel reads it directly); enum labels and UTC dates come from the compiled field kinds.
- Export limits are declared by each module's list query (5,000); column choosers and bulk actions are not in the reference and are not built.
- Numbering is a declared field property (protected max+1 under a transaction lock and the unique key), not a counter table: no migration, no RLS change.
- One lineage entry per pushed increment, rebuilt from the previous pushed envelope (entries 15 → 16 → 17 → 18 → 19).
- The state label stays "Released": a relabel is a storage retype (ADR-0059); renaming it needs an ADR-0066 re-baseline the owner has not authorized.
- Tax codes are Catalog master data (a no-Sales application still compiles the Party workspace that names a default code); rates freeze on the line and on each charge, so a later rate change leaves posted figures alone.
- Receivables live in Sales under `northstar.sales:capability.receivables` (`recordMutation`): the existing company-scoped INSERT and column UPDATE grants suffice, so no role, migration or RLS change.
- One invoice takes all of an order's shipped, not yet invoiced quantity; figures are frozen as stored exact decimals. States draft, open, partially paid, paid, void. Payment and credit dates are the posting instant (no back-dating).
- Reopen moved from a generic transition to the receivables capability, the only reader of an order's invoices under its lock. `print.totals` widens 6 -> 8 (this packet's own optional key).
- Returns (ruling D) are not built: a correction must restore into the shipment's own location and a task cannot name the movement it compensates, so a return into a chosen location needs a customer-return posting family in the Critical kernel (bounded by shipped minus returned per line, with admission-map coverage). That is its own Critical packet.
- The full-replay schema generator runs on a 1 GB data volume (nineteen entries overflowed 256 MB); every test keeps 256 MB.
- CI's PostgreSQL work is split by file into two jobs, the composed application (it replays every lineage entry, 11-14 minutes) and the rest, each with the unchanged 30-minute bound, assertions and unfiltered evidence (`--test-shard` stays refused).

## Slices

1. List `4d188d1c`. 2. Numbering `3e718be9`. 5a/6. Confirm, Reopen, carrier/tracking, print `7084b983`, `6a6bc7c1`. Grants (Critical) `c74ea33e`, `7947dba9`. 3. Master data `bed8809a`, `cb5f7e9f`, `49b2ccf7`; generator `28461658`; oracle `7a265fe1`.
4. Pricing `f129a7a5`; fixes `1cb20847`, `51948df8` (Critical), `852ac8d6`, `8779b1a8`. 7. Receivables `d199c49a` (lineage entry 21). Review fixes `53ca49f4`, `427d4a50`, `40ca820a`, `a1a8a051` (Critical), `f98fb641`, `b829d633`. 8. Money and requested date `d05feab2` (lineage entry 22), coverage `efd40452`. CI drift `e13d7b59`..`1a3e1c55`, `728e05ff`; product fixes `98e8f32e`, `450d4be3` (entry 23); CI split `d00f8bba`. R1 `6317a1a4`, `d5f11b84`; harness `42ff4df0`; advisory pin `44280f01`. Round 5's P2a/P2b `f339e83c`, tests and controls `45b4733c`.

## Controls

- `verification-takes-sentinel-document-numbers` and `numbering-reserves-the-sentinel-prefix` → claim 9; `added-company-column-carries-its-update-grant` → 10; `replayed-create-keeps-later-column-grants` → 11; `verification-reads-records-through-a-plain-get`, `verification-refuses-unreadable-probe-records` → 20; `numbering-first-number-fits-its-field`, `numbering-sentinels-have-room` → 7; `numbering-scan-reads-every-digit-count`, `numbering-scan-folds-like-the-business-key`, `numbering-exhaustion-refuses-by-name` → 8; `verification-constructs-assigned-numbers`, `verification-probes-assigned-uniqueness`, `verification-reads-back-assigned-values`, `verification-searches-by-an-assigned-number`, `verification-reads-numbers-the-read-back-omits`, `verification-witness-reads-through-executed-gets` → 21.
- The first three reproduced at `bed8809a`; the others at `4e2e018a`/`7f3c31f1` and, for numbering, again at `427d4a50`/`40ca820a` (`--run`: each mutation killed with its declared reason, each restored run green). At `b829d633` the two re-pointed numbering controls reproduced; `verification-constructs-assigned-numbers` killed with its declared message but its restored run timed out (host paging, under 1 GB free); the other three claim-21 controls are not yet run. At `bf24b925` the R1 control and `verification-takes-sentinel-document-numbers` (its kill point now the sentinel check) each killed with the declared reason and restored green (2m53s). At `28ecce28` the `--run` of the two round-5 controls and the R1 control is owed: host memory stayed under 1.2 GB free.

## Gates

- `d199c49a` content (own worktree, on battery): unit 184/184; integration 228/228; compiler 175/175; language coverage PASS (2487 obligations); surface grammar 25/25; PostgreSQL and browser `receivables` 1/1; release `--check` PASS. `7a265fe1`: PostgreSQL composed-application 16 pass, 4 lost to 300 s battery timeouts (no assertion reached); browser meta-sales 2/2; order-entry's own selector fixed `1cb20847`. `51948df8`: commercial-totals' fixture prices fixed `852ac8d6`. `de0e8a03`/`bed8809a` (slices 1-3): contracts 30/30, agent 3/3.
- `f98fb641`/`b829d633` (detached worktree, AC): PostgreSQL document-numbering 1/1 (124 s), reading the admitted release's evidence; that release measured 408 executed and 77 derived, every derivation `VERIFICATION_NO_GENERIC_CREATE_OPERATION` (the composed pins). Unit field-numbering 4/4. `d05feab2`/`efd40452` (detached worktree, AC, host paging under 1 GB free): release `--check` PASS; integration 228/228; compiler 175/175; surface grammar and hygiene 36/36; unit 184/187, the three failures `dev-environment` container-lifecycle tests whose 30 s spawn waits the paging host exceeds (13/14 on a lone rerun); coverage re-derived (2487 -> 2498), its check owes a green unit run; browser and PostgreSQL not run (host memory).
- `e13d7b59`..`1a3e1c55` (own worktree, one container at a time): running what the head had not run found test drift from the later slices (declared Lists and nav groups in the composed checks, the party page's composition, focus-ring states, an unordered salesperson set, the press-law and predicate-tripwire pins) and two product defects, fixed: a quick create reloads the order only when it re-prices a line (`98e8f32e`); a document's lines lead its page (`450d4be3`, lineage entry 23). Architecture 195/195; composed browser checks 5/5, party journey 1/1.
- CI (GitHub Actions) at `1a3e1c55`: quality (unit, compiler, integration, agent, architecture, release, contracts, whitespace), browser, performance and scans passed; PostgreSQL 247/254, seven stale expectations (surface floor 9 -> 11; Party's harness counting the Sales-only address book; a packing test seeding a shipment without ruling E's ship-to), fixed at `728e05ff` (locally packing 1/1, Party 2/2, runtime view 15/15). That job used 27.5 of its 30 minutes: `d00f8bba` runs the composed application's file in its own job under the same bound (Decisions). The fourth control's `--run` is still owed. R1 (`6317a1a4`/`d5f11b84`, merged `bf24b925`): document-numbering 2/2 (115 s; the new read-back-omission test 1/1: 25 scenarios executed, none derived, no probe record left live, a real-numbering run refused as a mismatch and still archived); unit/integration touching the changed modules 129/129; typecheck clean; expected-red static OK (154). Harness `42ff4df0`: observability-health 1/1 locally; advisory pin `44280f01`: `pnpm audit --audit-level=high` clean.
- Round 5 fix (`f339e83c`/`45b4733c`, merged `28ecce28`; own worktree, one container at a time, host under 2 GB free): typecheck clean; prettier and eslint clean; PostgreSQL document-numbering 3/3 (130 s: the numbering test 112 s, R1's 8 s, the new test 9 s: every scenario executed and none derived, every number its record's sentinel, no probe record left live, and the run whose executor cannot read `party_get` refused as `VERIFICATION_PROBE_RECORD_UNREADABLE` naming each record it left live, every role archived); integration semantic-gateways 51/51 (the one unit or integration file that loads the service, through `composed-application-runtime`); expected-red static OK (156); records OK.

## Test it yourself

Steps (under ten minutes each): `SALES-PARITY-test-it-yourself.md` — §1 List, §2 Numbering, §3 Confirm/Reopen/carrier/print, §4 customers, salespeople and ship-to, §5 prices and totals, §6 invoices, payments and credits, §7 money and the requested date.
Serve: `node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor` from `/home/rvham/2rain-greenfield-sales-parity`; Ctrl-C stops it and removes its container.

## Filed

- Global search (Ctrl K) is outside the List contract (SUP-01). The List has no row actions ("Post shipment"); exceptions (shortage marker) are not built. An invoice links back to its order only when opened from it: it stores its order as a relation, which no link can read.
- A refused post leaves its numbered draft (payment, credit, invoice), shown as Draft, as a refused shipment does. Round 4, filed: E1 the assigned-number probe shows distinct values and input ownership, not a stored fold or compatibility distinction (and a number no get selects is recorded as its computed sentinel); E2 document-numbering's executed-id set is scoped by release root (a union across activations), not by one activation; W1 "keep distinct numbers" overclaims a 64-bit hash. Noted with round 5's fix: E3 `#declaredEvidence` records a query assertion's answer, `unsupported` included, without comparing it with the assertion's expected outcome (no product assertion targets a query the gateway does not execute). Latent (no admitted declaration reaches them): `#declaredEvidence` and the refused create in `#assignedUniqueness` do not register records they would create; `archiveProbeRecords` stops at its first failed archive (a record it cannot read no longer stops it) and, from `finally`, can mask the original error.
- `apps/web/release/app.compiled.json` is 69 MB (23 entries): GitHub warns above 50 MB and refuses above 100 MB (about 3 MB per lineage entry); each entry also lengthens the composed PostgreSQL job. An ADR-0066 re-baseline (nothing is in production) is recommended; it is the owner's decision.
- Returns (ruling D): see Decisions; its Critical arm moves with that packet. PR #6's served demo lost its database when Docker restarted (2026-09-28); that lane owns its restart.

Review: round 1 (ONLINE, `974ae755`) found three production defects, all in numbering (sentinel prefix `V`, an 18-digit scan, a start wider than its field), fixed at `53ca49f4`; none in the grants or the plain read. Round 2 (`7f3c31f1`) closed those with no regression and found two older ones (sentinels in a narrow field; a scan not using the key's case fold), fixed at `427d4a50`. Round 3 (`40ca820a`) closed those with no regression and found one older defect, verification treating an assigned number as a caller input (claim 21), fixed at `a1a8a051`; the scan cost it flagged is removed at `f98fb641`. Round 4 (`b829d633`) found one production defect it introduced (R1: verification required every assigned number in the create's read-back and registered cleanup after that check), fixed at `6317a1a4`; E1, E2, W1 filed. Round 5 (`bf24b925`) found R1 not closed for every admitted declaration: P2a `#assignedWitness` read through a get without the gateway's executable-filter admission (a compiler-admitted `booleanPredicate false` get answers `unsupported`, so a stored number read as missing); P2b, pre-existing, cleanup's `#queryForEntity` could pick such a get and `archiveProbeRecords` then skipped the record, leaving it live. Both fixed at `f339e83c` (tests and controls `45b4733c`, merged `28ecce28`); round 6 (confirm) is owed: `SALES-PARITY-review-prompt.md`.
```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SALES-PARITY",
  "base": "994a7dc969694c8077630eaa536fcd385f7e030c",
  "head": "28ecce2822e249a84ef628582cec07f99c7d2b43",
  "changedPaths": [
    ".github/workflows/ci.yml", "apps/api/src/composition-root.ts", "apps/web/playwright.config.ts", "apps/web/playwright.operations.config.ts", "apps/web/playwright.shared.ts", "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json", "apps/web/src/app-server.ts", "apps/web/src/component-registry.ts",
    "apps/web/src/control-semantics.ts", "apps/web/src/document-editor.ts", "apps/web/src/editor-controls.ts", "apps/web/src/list-declaration.ts",
    "apps/web/src/message-catalog.ts", "apps/web/src/surface-client.ts", "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-contract.ts", "apps/web/src/surface-runtime.ts", "apps/web/src/workspace-entry.ts",
    "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/customer-defaults.spec.ts", "apps/web/test/browser/declared-list.spec.ts", "apps/web/test/browser/message-catalog.spec.ts",
    "apps/web/test/browser/meta-sales.spec.ts", "apps/web/test/browser/order-entry.spec.ts", "apps/web/test/browser/order-pricing.spec.ts",
    "apps/web/test/browser/receivables.spec.ts", "apps/web/test/browser/receiving.composed-application.spec.ts", "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts",
    "apps/web/test/browser/sales-order.composed-application.spec.ts", "apps/web/test/surface-runtime-contract.test.ts", "package.json",
    "packages/canonical-model/src/field-numbering.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/normalize.ts", "packages/dev-tooling/src/predicate-dispatch-tripwire/index.ts",
    "packages/canonical-model/src/picker-eligibility.ts", "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-composition.ts",
    "packages/canonical-model/src/surface-list.ts", "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/compiler.ts",
    "packages/compiler/src/conformance.ts", "packages/compiler/src/projections.ts", "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/list-declarations.ts", "packages/domain/src/app/order-entry.ts", "packages/domain/src/app/seed.ts",
    "packages/domain/src/catalog/definition.ts", "packages/domain/src/inventory/contracts.ts", "packages/domain/src/inventory/definition.ts",
    "packages/domain/src/party/definition.ts", "packages/domain/src/party/workspace.ts", "packages/domain/src/purchasing/definition.ts",
    "packages/domain/src/purchasing/workspace.ts", "packages/domain/src/sales/definition.ts", "packages/domain/src/sales/index.ts",
    "packages/domain/src/sales/workspace.ts", "packages/postgres-provider/package.json", "packages/postgres-provider/src/commercial-amounts.ts",
    "packages/postgres-provider/src/commercial-read-model.ts", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/inventory-posting-error.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/module-storage-materializer.ts", "packages/postgres-provider/src/receivables-capability-executor.ts",
    "packages/postgres-provider/src/release-verification-service.ts", "packages/runtime/src/list-behavior/contract.ts", "packages/runtime/src/list-behavior/cursor.ts",
    "packages/runtime/src/list-behavior/index.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-operation-gateway.ts", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "packages/runtime/src/semantic-query-gateway.ts", "scripts/run-matrix.sh", "scripts/run-suite.sh", "test/architecture/dependency-boundaries.test.ts", "test/architecture/module-press-law.test.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.baseline.ts",
    "test/architecture/surface-grammar-conformance.test.ts", "test/architecture/test-reachability.test.ts", "test/compiler/g2-module-conformance.test.ts", "test/compiler/inventory-contract.release.golden.json",
    "test/evidence/SALES-PARITY.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/assert-composed-inventory.ts", "test/helpers/generate-fresh-tenant-full-replay-schema.ts",
    "test/helpers/governed-storage-target.ts", "test/helpers/meta-sales-fixture.ts", "test/helpers/normalize-playwright-evidence.ts", "test/helpers/playwright-unfiltered-reporter.ts", "test/helpers/order-entry-fixture.ts", "test/helpers/postgres.ts",
    "test/helpers/reachability-producers.ts", "test/integration/surface-data-binding.test.ts", "test/postgres/commercial-totals.test.ts",
    "test/postgres/composed-application.test.ts", "test/postgres/declared-list.test.ts", "test/postgres/document-numbering.test.ts",
    "test/postgres/fresh-tenant-full-replay-schema.snapshot.json", "test/postgres/fulfillment.test.ts", "test/postgres/packing-retrieval.test.ts", "test/postgres/party-runtime.test.ts", "test/postgres/receivables.test.ts",
    "test/postgres/receiving-authorization.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/canonical-model/field-numbering.test.ts", "test/unit/canonical-model/surface-list.test.ts",
    "test/unit/commercial-amounts.test.ts", "test/unit/purchasing-definition.test.ts", "test/unit/sales-definition.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "packages/canonical-model/src/surface-list.ts", "name": "validateSurfaceLists"},
    {"path": "packages/canonical-model/src/field-numbering.ts", "name": "validateFieldNumbering"},
    {"path": "packages/canonical-model/src/picker-eligibility.ts", "name": "pickerEligibilityProblem"},
    {"path": "packages/domain/src/app/list-declarations.ts", "name": "declareLists"},
    {"path": "packages/domain/src/party/workspace.ts", "name": "partyWorkspace"},
    {"path": "apps/web/src/list-declaration.ts", "name": "declaredListArguments"},
    {"path": "apps/web/src/workspace-entry.ts", "name": "workspaceWithin"},
    {"path": "packages/postgres-provider/src/commercial-amounts.ts", "name": "lineAmounts"},
    {"path": "packages/postgres-provider/src/commercial-read-model.ts", "name": "commercialReadModel"},
    {"path": "packages/postgres-provider/src/receivables-capability-executor.ts", "name": "RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY"},
    {"path": "packages/domain/src/sales/workspace.ts", "name": "invoiceWorkspace"}
  ]
}
```
