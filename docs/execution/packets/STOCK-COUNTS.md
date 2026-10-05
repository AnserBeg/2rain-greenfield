# STOCK-COUNTS — count a location, review it against the ledger, post, correct and reverse

Status: slices 1 (count, review, post, correct, reverse) and 2 (types, blind counts, cancel, return to counting)
executable on draft PR #23 (base `packet/INVENTORY-PARITY`; includes #15 RETURNS); no merge, no deployment. Round 1
(owner-run, `f148416c..f86bc65e`) found three count-route defects, fixed here; round 2 owed. BUILD under the owner's
standing instruction (2026-10-05): rulings taken as recommended, recorded here.
Tier: **Critical** — the posting kernel (`inventory-posting-service.ts`, `inventory-posting-error.ts`); reached from
`stock-count-route.ts`, `inventory-posting-capability-executor.ts`, `inventory-count-read-model.ts` and the count's
guard, commands and companion relations in `inventory/definition.ts`. ONLINE arm: `STOCK-COUNTS-review-prompt.md`.
Base: `packet/INVENTORY-PARITY` `8b4c8290`; `3e89d9aa` (compact authored JSON); `packet/RETURNS` (#15, code `9c310635`)
merged at `f148416c`, the record's base; its fix `1420350b` at `6b6d7a6e`, docs `2603fc00` at `706db951`. Design: §C
STOCK-COUNT-POST of the parity notes' `design-critical-small.md` (outside the repository).

## Owner rulings (2026-10-05, given with the charter)

- SC-1 One location per count. SC-2 Expected is read as of the count's instant. SC-3 A correction supersedes
  exactly one posted count. SC-4 Blind counting is optional. SC-5 Per-line approval waits for `APPROVAL-INVENTORY`.

## Claims

The posting kernel (controls in `test/evidence/STOCK-COUNTS.expected-red.json`):
1. C1. An initial count or a correction posts only if each line's expected equals the sum of live movements for its
   item at the count's location and legal entity, effective at or before the count's instant
   (`assertCountExpectedIsLedger`, under the stock locks taken at BEGIN); otherwise `INVENTORY_COUNT_EXPECTED_STALE`
   with the line, item, location, expected and posted quantities, and the posting rolls back (no movement, transition
   or accepted receipt commits). Each item once (`validateStockCountCommand`). A reversal is outside both rules; the
   kernel checks each of its lines against the one movement it names (per line, not a proof of the whole set).
2. C2. A movement effective after the count's instant never makes it stale; one at the same instant is in the sum (a
   statement about the inclusive sum, not about the kernel's full movement order).
3. C3. A correction or a reversal supersedes exactly one posted count at the same location (a correction posts what
   is counted less the ledger as of its instant); a posted count takes one posted compensation.
4. C4. A reviewed, posted or cancelled count and its lines take no generic create, update, archive or restore; both
   companion relations are in no generic input or form; the stock documents List reads adjustments and transfers.
5. C5. A reviewed count already naming a companion transaction is refused by name before the posting writes.
6. C6. A count's Post changes nothing on the count or its lines beyond its transition: a line's physical count and
   the count's type and counting mode, which no posting writes, are compared as each column's exact jsonb text with
   what the evidence lock read (`exactRowSql`, `declaredColumns`, inside PUR-2a's coverage equality); the proof runs
   after the provisional writes, and a mismatch rolls them back.
7. C7. A version-4 receipt is digested with the authorization evidence of the invocation it records, on replay and
   when a new-key natural replay stores its receipt (`digestCoversAuthorization`): an unchanged Post retried after a
   policy-version change replays. The v4 preimage is unchanged and no receipt is rewritten.

Outside the Critical set:
8. A count is entered like a document (one location, reason, narrative, count type, counting mode; CNT- numbers):
   Start counting lists every product posted above zero there (or a corrected count's products; none for a quick
   correction or opening count), Review (counted at = now; expected the ledger then), Post (`postStockCount`, v4),
   Return to counting (never a reversal), Cancel count; Correct and Reverse on a posted count. New grammar:
   `lineCreateValues` (floor 17).
9. A count command that committed replays under its key after any later transition (the receipt decides); a new
   execution is held to the shown revision, the reversal rule and the declared precondition under the count's row
   lock (`executeStockCountChange`), or by the kernel for Post.
10. A count line read model shows expected and variance: live while counting (none while blind), frozen once reviewed.

## Decisions

- The commands live on the posting capability's route: Post through `postStockCount` with the count exactly as
  stored; Start counting, Review, Return to counting and Cancel count through the trust service's idempotent
  accepted mutation. Review refuses a line not counted, a negative count, an item counted twice and a stock
  already below zero; Post and Cancel count ask for confirmation.
- Count type is a label (Cycle count, Annual stocktake, Quick correction, Opening inventory): it decides only
  whether Start counting lists products. A blind count stores no expectation before Review.
- Both companion relations are `lifecycle: 'retired'`, meaning unexposed: no relation input, form or verification
  archive restriction names them; storage keeps the columns the kernel writes. The must-be-null fence stays.
- No type precondition on a generic `inventory_transaction` create (the design's third closure): release
  verification samples the type's first option (a goods receipt), so it needs a verification change. Filed.
- The Inventory transactions List reads `inventory_document_list`, a q1 copy of the entity list filtered to
  adjustments and transfers (ADR-0049 condition 3, proven by a query in `inventory-stock-counts.test.ts`).
- `legacy-reviewed-counts` is moot: decoded, all seven lineage entries carry both companion relations optional
  (ADR-0066's re-baseline), and no tenant holds released data. ADR-0063 amended: version 4 is frozen.
- One lineage entry (7), rebuilt from INVENTORY-PARITY's envelope, covers RETURNS and STOCK-COUNTS (rebuilt again at
  `88b39c6a` for Return to counting's reversal term). `3e89d9aa` writes `app.authored.json` compact.
- Fixes the runs found, each measured first: `8c1a878a` ledger reads compare the item as text (42883); `79bb3fda`
  slice 2's columns join PUR-2a's read-back by local id; `f86bc65e` `listReferencePlan` joins a uuid-stored text
  field as a uuid (Stock counts List, 42883). Tests only: `8f0a3a6b`, `12ae25b8`, `1a7e067d`, `b5b3bf45`.
- SC-6 (review round 1, the recommended choice): a reversal is never returned to counting. Return to counting's
  precondition is `all(reviewed, not(reversal))`, and the route refuses it by name ahead of that precondition; a
  reviewed reversal is posted or cancelled. Not taken: re-deriving a reopened reversal's lines (they are not counted).
- Round 1 replay (defect 1): `#prepareCount` refuses only a revision the count never had. Post alone still judges its
  precondition there when shown the current revision: a committed Post moved the count on, so that Post is new.
- A reversal is a count kind; it posts under the family's `correction` posting role. Two concepts, one shared role.

## Slices and controls

1. Kernel `a1b4e5e9`; count, review, post, correct, reverse `d8eba818`; coverage `5341f76d`. Test it yourself §1-§3, §5.
2. Types, blind, cancel, return to counting `d9764324`; controls `2ec6fc77`, `b64a81d7`; snapshot `bc6b537e`; the fixes
   above; round-1 frozen head `f86bc65e`. Test it yourself §4.
3. Round-1 fixes, each reproduced red first (`1aa6b9ca`, `1999f565`): replay `2d8f8026`, `59a681d0`; reversal reopen
   `4667990e`, `59a681d0`; C6 `0c85bde9`; release `88b39c6a`; v4 `e138a486`; wording `217d8e65`, `a83f4391`,
   `550c723e`; controls `291ddcbf`, `88694c09`, `e138a486`. Frozen executable head `e138a486`.

Controls: `count-expected-unchecked`, `count-repeats-an-item` C1; `count-expected-current-balance` C2;
`correction-location-unchecked` C3; `reviewed-count-still-updatable` C4; `count-companion-fence-removed` C5 (PUR-2a's
mutation); `count-physical-quantity-overwritten`, `count-physical-quantity-last-decimal` C6;
`count-replay-digest-uses-current-policy` C7; `count-replay-gated-on-next-revision` claim 9;
`reversal-reopen-route-check-removed`, `reversal-reopen-precondition-dropped` SC-6.

## Gates

- CI 37346368119 at `550c723e` (frozen executable `e138a486` plus docs): every job green, executed-file reachability
  included. https://github.com/AnserBeg/2rain-greenfield/actions/runs/37346368119
- Controls: https://github.com/AnserBeg/2rain-greenfield/actions/runs/37346368418 (evidence.yml, `controls:` line): at
  550c723ec050 each killed with the declared reason (1 of 1) and restored green (1 passing): the four new ones,
  `count-physical-quantity-last-decimal`, `-overwritten` and `count-companion-fence-removed` (their read-back now
  uses `exactRowSql`). Round 1: CI 37320021606 (`11da1dfa`), controls 37311683695 (11 of 11 at `1a7e067d`).
- Local, under the lock, ≥1.2 GB free first: route 2/2 (178 s, 204 s), kernel last-decimal and three-value 2/2 at
  `88694c09`; red first: defect 3 at `1999f565` (IDEMPOTENCY_CONFLICT on the retry), C6 gap (pre-fix read-back let the
  last-decimal mutation pass). v4 fix green on CI only (Docker paused). Unit 213/213; compiler 175/175 (one label regex
  reds only under FORCE_COLOR=3); `check-expected-red` 192; release `--check`; pins unchanged (634/557, 840 of 2676).

## Test it yourself

`STOCK-COUNTS-test-it-yourself.md`: §1 count a location, §2 a stale count, §3 correct and reverse, §4 blind counts,
quick corrections and cancelling, §5 the Lists.

## Filed

- A generic create can still store a DRAFT inventory transaction typed as a companion, or take a derived companion
  id as its record id (the kernel then refuses that source's posting with a duplicate key, never adopting it).
- A new count opens in the editor with one blank line, removed (or filled) before Save.
- A count reviewed on one tenant day and posted the next is refused by the 0-day backdate window; Return to
  counting and Review again re-date it. A reversal, never returned to counting (SC-6), is cancelled and redone.
- PaneFlow parity left: per-line approval and "Post ready lines" (`APPROVAL-INVENTORY`), counting by bin within a
  location (`LOCATIONS`), unit cost on opening inventory (valuation), scan, search and Uncounted/Variances filters
  on the count's lines, and a count's own effective date (here the review's instant).

Review: round 1 received 2026-10-05 (three route defects, fixed above); round 2 owed —
`STOCK-COUNTS-review-prompt.md` (ONLINE, user-run).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "STOCK-COUNTS",
  "base": "f148416c5c8d9ee8dd4a1faff48f333090950890",
  "head": "e138a4861669d3f5b46d52fa0bbb882ba6735301",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/release/current-policy-bindings.json", "apps/web/src/document-editor.ts", "apps/web/test/browser/composed-application.spec.ts", "apps/web/test/browser/inventory-stock-counts.spec.ts", "apps/web/test/surface-runtime-contract.test.ts", "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/conformance.ts", "packages/compiler/src/projections.ts", "packages/dev-tooling/src/predicate-dispatch-tripwire/index.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts", "packages/domain/src/app/order-entry.ts", "packages/domain/src/inventory/definition.ts",
    "packages/domain/src/inventory/workspace.ts", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/inventory-count-read-model.ts", "packages/postgres-provider/src/inventory-posting-capability-executor.ts", "packages/postgres-provider/src/inventory-posting-error.ts", "packages/postgres-provider/src/inventory-posting-service.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/stock-count-route.ts",
    "packages/runtime/src/request-runtime-view.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts", "test/compiler/inventory-contract.cases.ts", "test/evidence/RETURNS.expected-red.json", "test/evidence/STOCK-COUNTS.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/assert-composed-inventory.ts",
    "test/postgres/composed-application.test.ts", "test/postgres/customer-return.test.ts", "test/postgres/document-numbering.test.ts", "test/postgres/fresh-tenant-full-replay-schema.snapshot.json", "test/postgres/inventory-posting.test.ts", "test/postgres/inventory-stock-count.test.ts", "test/postgres/inventory-stock-counts.test.ts", "test/postgres/inventory-terminal-state.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/postgres/vendor-return.test.ts", "test/unit/canonical-model/field-numbering.test.ts", "test/unit/canonical-model/surface-list.test.ts", "test/unit/inventory-definition.test.ts", "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "assertCountExpectedIsLedger"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "validateStockCountCommand"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "declaredColumns"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "assertCompanionIdentitiesPersisted"}, {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "listReferencePlan"},
    {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "stockCountBinding"}, {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "stockCountPostingCommand"}, {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "executeStockCountChange"}, {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "reviewCountedLines"}, {"path": "packages/postgres-provider/src/inventory-count-read-model.ts", "name": "inventoryCountReadModel"},
    {"path": "packages/domain/src/inventory/definition.ts", "name": "countOperations"}, {"path": "packages/domain/src/inventory/definition.ts", "name": "stockDocumentListQuery"}, {"path": "packages/domain/src/inventory/workspace.ts", "name": "stockCountWorkspaceQueries"}, {"path": "packages/domain/src/app/list-declarations.ts", "name": "stockCountList"}, {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "digestCoversAuthorization"},
    {"path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "exactRowSql"}, {"path": "packages/postgres-provider/src/stock-count-route.ts", "name": "deriveReversalLines"}
  ]
}
```
