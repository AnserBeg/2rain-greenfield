# STOCK-COUNTS — count a location, review it against the ledger, post, correct and reverse

Status: slices 1 (count, review, post, correct, reverse) and 2 (count types, blind counts, cancel, return to counting)
executable on draft PR #23 (base `packet/INVENTORY-PARITY`; includes #15 RETURNS); no merge, no deployment. BUILD
under the owner's standing instruction (2026-10-05): rulings taken as recommended, recorded here.
Tier: **Critical** — the posting kernel (`inventory-posting-service.ts`, `inventory-posting-error.ts`); context it is
reached from: `stock-count-route.ts`, `inventory-posting-capability-executor.ts`, `inventory-count-read-model.ts`, the
stock count's guard and companion relations in `inventory/definition.ts`. One ONLINE arm is owed:
`STOCK-COUNTS-review-prompt.md`.
Base: `packet/INVENTORY-PARITY` at `8b4c8290`; `3e89d9aa` (compact authored JSON), then `packet/RETURNS` (#15, frozen
code `9c310635`, head `09484975`) merged at `f148416c`, the record's base. Design: §C STOCK-COUNT-POST of the parity
notes' `design-critical-small.md` (outside the repository).

## Owner rulings (2026-10-05, given with the charter)

- SC-1 One location per count. SC-2 Expected is read as of the count's instant. SC-3 A correction supersedes
  exactly one posted count. SC-4 Blind counting is optional. SC-5 Per-line approval waits for `APPROVAL-INVENTORY`.

## Claims

The posting kernel (controls in `test/evidence/STOCK-COUNTS.expected-red.json`):
1. C1. An initial count or a correction posts only if each line's expected equals the sum of live movements for its
   item at the count's location and legal entity, effective at or before the count's instant
   (`assertCountExpectedIsLedger`, under the stock locks taken at BEGIN); otherwise `INVENTORY_COUNT_EXPECTED_STALE`
   with the line, item, location, expected and posted quantities, and nothing is written. Each item once
   (`validateStockCountCommand`); a reversal stays an exact inverse, outside both rules.
2. C2. A movement effective after the count's instant never makes it stale; one at the same instant counts before it.
3. C3. A correction or a reversal supersedes exactly one posted count at the same location (a correction posts what
   is counted less the ledger as of its instant); a posted count takes one posted compensation.
4. C4. A reviewed, posted or cancelled count and its lines take no generic create, update, archive or restore; both
   companion relations are in no generic input or form; the stock documents List reads adjustments and transfers.
5. C5. A reviewed count already naming a companion transaction is refused by name before anything is written.
6. C6. A count's Post changes nothing on the count or its lines beyond its transition: a line's physical count and
   the count's type and counting mode, which no posting writes, are proved identical to the bytes the evidence lock
   froze (`declaredColumns`, inside PUR-2a's coverage equality).

Outside the Critical set:
7. A count is entered like a document (one location, reason, narrative, count type, counting mode; CNT- numbers):
   Start counting lists every product posted above zero there (or a corrected count's products; none for a quick
   correction or opening count), Review (counted at = now; expected the ledger then), Post (`postStockCount`, v4),
   Return to counting, Cancel count; Correct and Reverse on a posted count. New grammar: `lineCreateValues` (floor 17).
8. A count line read model shows expected and variance: live while counting (none while blind), frozen once reviewed.

## Decisions

- The commands live on the posting capability's route: Post through `postStockCount` with the count exactly as
  stored; Start counting, Review, Return to counting and Cancel count through the trust service's idempotent
  accepted mutation. Review refuses a line not counted, a negative count, an item counted twice and a stock
  already below zero; Post and Cancel count ask for confirmation.
- Count type is a label (Cycle count, Annual stocktake, Quick correction, Opening inventory): it decides only
  whether Start counting lists products. A blind count stores no expectation before Review.
- Both companion relations are `lifecycle: 'retired'`: removed from relation inputs, forms and verification's
  archive restriction; storage keeps the columns the kernel writes. The kernel's must-be-null fence stays.
- No type precondition on a generic `inventory_transaction` create (the design's third closure): release
  verification samples the type's first option (a goods receipt), so it needs a verification change. Filed.
- The Inventory transactions List reads `inventory_document_list`, a q1 copy of the entity list filtered to
  adjustments and transfers (ADR-0049 condition 3, proven by a query in `inventory-stock-counts.test.ts`).
- `legacy-reviewed-counts` is moot: decoded, all seven lineage entries carry both companion relations optional
  (ADR-0066's re-baseline), and no tenant holds released data. ADR-0063 amended: version 4 is frozen.
- One lineage entry (7) rebuilt from INVENTORY-PARITY's envelope covers RETURNS and STOCK-COUNTS. `3e89d9aa` writes
  `app.authored.json` compact (1,376,025 canonical bytes, 2,108,609 pretty-printed); the 2 MiB limit is unchanged.
- Fixes the runs found, each measured before it was made: `8c1a878a` the kernel's and Review's ledger reads compare
  the item column as text (a uuid column has no `uuid = text`, 42883 on every count posting); `79bb3fda` slice 2's
  three columns join those PUR-2a's read-back proves unchanged, by explicit local id where the release declares them
  (every Post was refused "carries persisted columns no read-back compares"); `f86bc65e` (shared runtime)
  `listReferencePlan` joins a text field stored as a uuid -- a pinned inventory reference, the count's location -- as
  a uuid (the Stock counts List was QUERY_UNAVAILABLE, 42883).
- Tests only: RETURNS' tests seed stock with a stock document of their own (`8f0a3a6b`); the route test finds six at
  Vancouver first, which the demo seed leaves empty (`12ae25b8`); a movement's Role reads `count`, as the item page's
  read `adjustment` (`1a7e067d`); the composed scoped-create specimen is now the count line form, whose workspace
  entry refuses two or a malformed company (`WORKSPACE_COMPANY_UNAVAILABLE`), none by the create
  (`OPERATION_INPUT_INVALID`), and the List's entry operand is `inventory_document_list`'s (`b5b3bf45`).

## Slices and controls

1. Kernel `a1b4e5e9`; count, review, post, correct, reverse `d8eba818`; coverage `5341f76d`. Test it yourself §1-§3, §5.
2. Types, blind, cancel, return to counting `d9764324`; controls `2ec6fc77`, `b64a81d7`; snapshot `bc6b537e`; the fixes
   above; frozen executable head `f86bc65e`. Test it yourself §4.

Controls: `count-expected-unchecked`, `count-repeats-an-item` C1; `count-expected-current-balance` C2;
`correction-location-unchecked` C3; `reviewed-count-still-updatable` C4; `count-companion-fence-removed` C5 (PUR-2a's
mutation); `count-physical-quantity-overwritten` C6.

## Gates

- CI 37320021606 at `11da1dfa` (the frozen executable tree of `f86bc65e` plus docs): every job green, executed-file
  reachability included. https://github.com/AnserBeg/2rain-greenfield/actions/runs/37320021606
- Expected-red controls on CI: https://github.com/AnserBeg/2rain-greenfield/actions/runs/37311683695 (evidence.yml,
  head `1a7e067d`; named by the PR body's `controls:` line). Each at 1a7e067dc533 was killed with the declared reason
  (1 declared kill failed as declared) and restored green (1 passing): `count-expected-unchecked`,
  `count-repeats-an-item`, `count-expected-current-balance`, `correction-location-unchecked`,
  `reviewed-count-still-updatable`, `count-companion-fence-removed`, `count-physical-quantity-overwritten`, and
  PUR-2a's four over the rewritten three-value fixtures and the projection test (`posted-balance-verification-removed-
  at-the-binding`, `-accumulation-replaced-by-assignment`, `-revision-advances-by-two`,
  `-identity-drops-the-location-dimension`). `f86bc65e` differs from `1a7e067d` only in the list reference join and
  the route test, neither of which a control mutates or runs.
- Local, under the lock, ≥1.2 GB free checked first: kernel stock-count and PUR-2b tests 13/13, route test 1/1
  (122 s), backup-restore 1/1, static `check-expected-red` (185 entries), `check-records`. The operations spec hit its
  480 s bound locally in fixture start-up (laptop), so it is CI's.
- Earlier CI: 37304368777, 37307052199 red (42883, composed journeys); 37309497791 red (route test, role label);
  37311650041 (`1a7e067d`) green but the operations runner (the counts List). The focus-ring red in 37307052199 (one
  extra `tr` ground) passed unchanged in the next two runs.
- Pins from the compile: 113 surfaces, 634 verification scenarios (557 executed); release entry 7 `--check` PASS;
  language coverage 2676 obligations, 840 observed. Snapshot regenerated on CI (37304368663), identical at `228416ac`.

## Test it yourself

`STOCK-COUNTS-test-it-yourself.md`: §1 count a location, §2 a stale count, §3 correct and reverse, §4 blind counts,
quick corrections and cancelling, §5 the Lists.

## Filed

- A generic create can still store a DRAFT inventory transaction typed as a companion, or take a derived companion
  id as its record id (the kernel then refuses that source's posting with a duplicate key, never adopting it).
- A new count opens in the editor with one blank line, removed (or filled) before Save.
- A count reviewed on one tenant day and posted the next is refused by the 0-day backdate window; Return to
  counting and Review again re-date it.
- PaneFlow parity left: per-line approval and "Post ready lines" (`APPROVAL-INVENTORY`), counting by bin within a
  location (`LOCATIONS`), unit cost on opening inventory (valuation), scan, search and Uncounted/Variances filters
  on the count's lines, and a count's own effective date (here the review's instant).

Review: owed — `STOCK-COUNTS-review-prompt.md` (round 1, ONLINE, user-run).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "STOCK-COUNTS",
  "base": "f148416c5c8d9ee8dd4a1faff48f333090950890",
  "head": "f86bc65ed2d5d61df3880d5744bd756300f8120c",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/release/current-policy-bindings.json", "apps/web/src/document-editor.ts", "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/inventory-stock-counts.spec.ts", "apps/web/test/surface-runtime-contract.test.ts", "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/conformance.ts",
    "packages/compiler/src/projections.ts", "packages/dev-tooling/src/predicate-dispatch-tripwire/index.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts", "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/inventory/definition.ts", "packages/domain/src/inventory/workspace.ts", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/inventory-count-read-model.ts", "packages/postgres-provider/src/inventory-posting-capability-executor.ts",
    "packages/postgres-provider/src/inventory-posting-error.ts", "packages/postgres-provider/src/inventory-posting-service.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/stock-count-route.ts", "packages/runtime/src/request-runtime-view.ts",
    "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts", "test/compiler/inventory-contract.cases.ts", "test/evidence/STOCK-COUNTS.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/assert-composed-inventory.ts", "test/postgres/composed-application.test.ts", "test/postgres/customer-return.test.ts", "test/postgres/document-numbering.test.ts", "test/postgres/fresh-tenant-full-replay-schema.snapshot.json",
    "test/postgres/inventory-stock-count.test.ts", "test/postgres/inventory-stock-counts.test.ts", "test/postgres/inventory-terminal-state.test.ts", "test/postgres/request-runtime-view.test.ts", "test/postgres/vendor-return.test.ts",
    "test/unit/canonical-model/field-numbering.test.ts", "test/unit/canonical-model/surface-list.test.ts", "test/unit/inventory-definition.test.ts", "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "assertCountExpectedIsLedger"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "validateStockCountCommand"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "declaredColumns"},
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "assertCompanionIdentitiesPersisted"}, {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listReferencePlan"}, {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "stockCountBinding"},
    {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "stockCountPostingCommand"}, {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "executeStockCountChange"}, {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "reviewCountedLines"},
    {"path": "packages/postgres-provider/src/inventory-count-read-model.ts", "name": "inventoryCountReadModel"}, {"path": "packages/domain/src/inventory/definition.ts", "name": "countOperations"}, {"path": "packages/domain/src/inventory/definition.ts", "name": "stockDocumentListQuery"},
    {"path": "packages/domain/src/inventory/workspace.ts", "name": "stockCountWorkspaceQueries"}, {"path": "packages/domain/src/app/list-declarations.ts", "name": "stockCountList"}
  ]
}
```
