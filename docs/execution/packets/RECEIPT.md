# RECEIPT — receive goods against purchase orders through the product

Status: active combined candidate; not accepted. Tier: Critical. Stops: 1.
Base: `8af63acfd8eb4f95b5af8ceff1b6ce7c117b9def`. Owner's execution prompt is the charter.
Combined code/test checkpoint: `e3bac21bc007f24da359d5047d71518fd5e0af7d`; the subsequent record commit carries no production changes. New-head CI is reported on draft PR #1, not inferred from focused greens.
Draft PR: https://github.com/AnserBeg/2rain-greenfield/pull/1. Review and acceptance remain external.

## Claims

1. Reconciliation runs read-only; rebuild preserves discrepancies before repair.
2. Receipt posting atomically writes source, companions, movements, received projection and trust/idempotency effects.
3. Immutable movement → receipt line → order line attribution and actual cost or explicit absence survive correction and rebuild.
4. ADR-0065 claims 1–10: bounded quantity, refusal payload, concurrent locations, verified projection, correction floor, authored-write refusal, deterministic rebuild, non-healing reconciliation, amendment isolation and recoverable attribution.
5. Product receiving uses the installed AUTH evaluator, authoritative prepared scope, required-read preflight, explicit local grants, human-confirmed posting and server-derived quantities. A commit-time read denial withholds data while preserving truthful success/trust.

## Decisions

- Preserve completed RECEIPT `6b2385476a68f3b6f9495bfbdc039edfa349ee08`. Exact AUTH correction `9d70c749752006ab21d1b9df9516b1cb7b491df3` incorporated by history-preserving merge `866f697a501c0dc53024ad18389a982b6ba44a0a`; no arbitrary AUTH work imported.
- Accepted migrations through 0024 unchanged; AUTH 0025; RECEIPT 0026/0027. Kernel snapshot regenerated from all 27.
- AUTH added no migrations or release-output change. Accepted through 0024 / AUTH 0025 / RECEIPT 0026–0027 and governed root `ca42045403a26d263a4d46c3ee62ada93f55be2be99645fca06fa966ae8dbefb` remain unchanged; the preserved lane database was not reset.
- Scope: purchasing definitions, registered receiving capability/UI code, shared posting kernel, projection/reconciliation, migrations, release inputs and relevant tests. AUTH evaluator implementation remains inherited and unchanged.
- Plan §5.11 records the owner's narrow RECEIPT exception in this branch; no second metadata authority or doctrine rewrite.
- Forward-date default: zero tenant business days. Explicit close requires all active lines fully received; explicit reopen precedes further receiving, amendment or correction.
- Original 13 receipt permission bindings are now active; five exact amendment CRUD bindings added through AUTH's contract. Acknowledgements stay empty; no wildcard or allow-all production policy.
- Amendment intent is an ordinary `purchase_order_amendment` record: number, target line, expected revision, quantity, reason. Existing line-amend O1 consumes one matching request atomically.
- Isolated worktree `/home/rvham/2rain-greenfield-receipt`; database port 55437; server port 4317.
- Persisted facts/boundaries: Band A. Operator refusals/forms: Band B. Records: Band C.

## Integration

- Preparation resolves persisted target scope/revision read-only, binds its opaque token to the exact request/input digest/definitions/view, and the gateway preflights required read/scope permissions before execution. The mutation transaction retains revision/scope checks and idempotency.
- Real gateway tests cover initial/correction/reversal/amend/close/reopen: missing read and A→B/forged scope produce no business effects and one redacted denial. Commit-time read revocation returns success/null read-back/trust IDs; unrelated exceptions remain failures; restored same-key retry adds no effects.
- Browser HTTP submission covers the full lifecycle. Null read-back renders HTTP 200 registered guidance and trust IDs, with no record DTO/form/retry; exactly one semantic receipt and movement persist. Party lifecycle and stock replay stay green.
- Forms no longer submit server-owned lifecycle fields; commands/confirmation preserve selected legal-entity scope and record identity. Receiving refresh is restricted to receiving commands: ordinary archive read-back and stock replay remain intact.
- Currency codes are searchable on receipt lines as on purchase orders. A three-character excluded-currency probe collided with another verifier value; the field now follows its ordinary business search semantics, not an excluded-field exception.
- Historical profile/reproduction checks use synthetic in-memory lineages after ADR-0066; their artifacts never enter the production path. The obsolete 168→163 historical scenario census is retired; current per-entity coverage and the independent executed/derived partition oracle remain.
- Final release plan has 257 scenarios: prior 198 plus 59 across receipt, receipt line, amendment request and received projection. Ten new operationless received-projection scenarios are derived, not represented as executed.
- Full-replay module snapshot regenerated from governed root `ca42045403a26d263a4d46c3ee62ada93f55be2be99645fca06fa966ae8dbefb`; accepted kernel history is not rewritten.

## Controls

All eleven original RECEIPT entries reproduced red/restored green on `968942c7eecc0ed10b3499a217d393a64bbe4dce`: pre-rebuild capture, ordered ceiling, refusal payload, common order lock, received floor/verifier, authored-write fence, rebuild identity/corruption reporting, amendment isolation and projection-independent reconstruction.

Six inherited controls reproduced red/restored green at `d359688b834ff248d93e646142b34d5db0819c7e`: `coverage-comparison-absent`, `version-four-digest-covers-the-derived-role`, `active-release-fact-checked-after-the-receipt-lookup`, `recorded-at-floor-absent`, `comparator-drops-the-movement-id-tie-break`, `negative-stock-stops-sorting-persisted-with-planned`.

Three AUTH controls reproduced red/restored green at `18f2d91dba62cbda31a853621fdc3562fc6cb591`; `receipt-binding-action-drifted` did so at `d359688`. Ten affected controls executed against `8bf7213`: receipt post/order typed read denial, receipt historical retry, read preflight, authoritative scope, committed inventory read denial, denial recorder, legal-scope translation, active-release-before-replay and natural replay. Each killed only its declared tests and restored green. Total actual controls: 31; validation/self-tests are not counted.

## Gates

New correction checks at `8bf7213`: typecheck; governed release check; real-policy receiving 7/7; receipt atomic/lifecycle/binding 1/1; semantic gateway + surface contracts 80/80; formerly failing module-runtime scoped-member recheck 1/1; catalog/browser controls 17/17; Party lifecycle + stock replay 2/2; fresh and preserved-database full receiving browser journeys 1/1 each. At `e3bac21`: typecheck and the complete architecture suite 190/190 after re-deriving receipt-aware press-law, predicate, surface, test and tenant inventories; the gateway-authority scanner also has a named-type-import negative regression. Earlier receipt/reconciliation/compiler/schema checks remain recorded above. These are focused results, not full CI.

The first browser run used the CI reachability reporter, which correctly returned nonzero for a filtered run despite the test passing. The explicit focused rerun used the list reporter and passed; no filtered run is claimed as CI reachability evidence.

After the refresh repair, navigation/forms/stock replay/receiving passed 4/4; Party first timed out during governed restart, then at Restore in an isolated rerun. Its real-policy multi-form journey now has the existing 60-second multi-form allowance, plus the existing 180-second fixture-startup allowance for restart; no semantic assertions or performance gate were removed. Final isolated rerun passed 1/1 in 26.3 seconds at `b6f557e635c97b7e49e8368a453febeec5aa483b`. The shipped-head capability reader repair also passed 1/1. All five previously selected browser journeys now pass, not a claim of a full browser-suite run.

New-head CI remains required and is reported after push. No independent review, owner test, acceptance, deployment or main merge claimed.

Standalone `check-review-record.sh` reports pre-existing main doctrine commits `65d9222`/`8af63ac` without review records; accepted history/logs are untouched. A manifest validation attempted before committing correctly refused the dirty tree; it is not control execution evidence.

## Test it yourself

Server: http://127.0.0.1:4317 (already running; do not start a second instance).
Live corrected-candidate example: [order, amended 3 / received 0 / remaining 3](http://127.0.0.1:4317/?surface=northstar.app%3Asurface.purchase_order_detail&northstar.app%3Aparameter.purchase_order_get_legal_entity_scope=74000000-0000-4000-8000-000000000001&record=1c6f4e00-d344-456b-b4ce-1d93c0020791), [initial receipt](http://127.0.0.1:4317/?surface=northstar.app%3Asurface.goods_receipt_detail&northstar.app%3Aparameter.goods_receipt_get_legal_entity_scope=74000000-0000-4000-8000-000000000001&record=73604320-2d13-408d-a893-30c606f883cb), [correction](http://127.0.0.1:4317/?surface=northstar.app%3Asurface.goods_receipt_detail&northstar.app%3Aparameter.goods_receipt_get_legal_entity_scope=74000000-0000-4000-8000-000000000001&record=73adddaa-3063-4c02-baee-e06027451bc4), [reversal](http://127.0.0.1:4317/?surface=northstar.app%3Asurface.goods_receipt_detail&northstar.app%3Aparameter.goods_receipt_get_legal_entity_scope=74000000-0000-4000-8000-000000000001&record=e7aa0d1b-f747-4da0-a170-efc8b38b80a8).
If stopped, from this worktree run:
`PORT=4317 NORTH_STAR_DATABASE_PORT=55437 NORTH_STAR_DEV_DATABASE_CONTAINER=dev-receipt-postgres NORTH_STAR_TENANT_SLUG=receipt-development corepack pnpm dev`.

1. Open Purchasing → Purchase orders, select DEFAULT legal entity, then `RECEIPT-PO-*`. The posted example shows 5 ordered, 3 received, 2 remaining.
2. On the order, use **Create goods receipt**. Select the released order; enter a unique Number, draft State / initial Kind, current Effective at, Location `71000000-0000-4000-8000-000000000021`, Reason code and Reason narrative. Save.
3. Open that receipt → **Add receipt line**. Select the Receipt and matching Order line; Item `71000000-0000-4000-8000-000000000011`, Quantity at most remaining, Unit `EA`. Choose Cost status known with canonical Unit cost `12.5` and Currency `CAD`, or explicit absent. Save, return to receipt, **Post → Confirm Post**.
4. **View order progress** returns to the order list. Reopen the order record to see server-derived progress. Close is explicit and refuses while any active line has remaining quantity.
5. For amendment, open its order line → **Request quantity amendment**; enter the line's current revision, new quantity and reason, save, return to the line and **Amend → Confirm Amend**. Quantity cannot fall below received.
6. Corrections/reversals are new receipts linked to the posted original and immutable movement identities; reopen closed orders first. Posted history is never edited. Existing period and negative-stock safeguards still apply.

Reproducible fresh, isolated AUTH/product proof:
`corepack pnpm exec playwright test --config apps/web/playwright.config.ts receiving.composed-application.spec.ts --project=composed-application --no-deps --workers=1 --reporter=list`.
To run against this lane instead, prefix `COMPOSED_APPLICATION_BASE_URL=http://127.0.0.1:4317 RECEIVING_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55437/postgres`. This creates new demo documents and restores the one revoked test grant in `finally`.

Read-only/corruption proof: `node --import tsx --test test/postgres/inventory-reconciliation.test.ts`.
Atomic/lifecycle proof: `node --import tsx --test --test-name-pattern='RECEIPT posts' test/postgres/inventory-posting.test.ts` (fixture policy; not the production AUTH proof).

The operator CLI ran on the populated demo with runtime credentials and `default_transaction_read_only=on`: source, posted balance and received projection each consistent, repaired=0. Overall exit 3/INDETERMINATE is honest: the aggregate-anchor arm has zero subjects. Command: `DATABASE_URL=postgresql://north_star_runtime@127.0.0.1:55437/postgres node --import tsx scripts/reconcile-inventory.ts 8ba8f6e7-e289-4eeb-8572-1241746fd47a dc3de3a1-7cae-4a4b-ba7a-bbbbf78b5246 0cd9b9d0-8a98-41e7-a811-3f3f24d69f20 74000000-0000-4000-8000-000000000001`.

## Remaining / review

Full combined CI and the external Critical review remain. Decimal entry retains the existing canonical-input requirement (no trailing fractional zeroes). Local-demo grants are development-only, not an external login facility. Program-review anti-trigger: this unaccepted integration is not a stable stage boundary; no autonomous program review.

Fresh-review prompt prepared below (17 lines); do not launch until the candidate is frozen with full CI. Record-claim follows at that point. No independent review run by this lane.

```text
Review RECEIPT as a Critical end-to-end vertical; do not implement, merge or approve it.
Use PR #1's frozen candidate SHA and accepted base 8af63ac; verify full CI first.
Read AGENTS, active plan, review-tiers, kernel guarantees and ADRs 0017/0049/0059/0060/0062/0063/0065/0066.
Honor the owner's recorded narrow §5.11 exception and explicit closing/date defaults.
Review exact imported AUTH 9d70c74 at its RECEIPT callers, not arbitrary later AUTH work.
Trace purchasing/inventory definitions → governed release → composition root and actual policy bindings/grants.
Trace PO forms → operation gateway preparation/current policy → receiving executor → null-read-back HTTP acknowledgement.
Trace the executor through the shared posting transaction, including source/companions/movements/progress/trust.
Check all ten ADR-0065 claims against executed tests and discriminating mutation evidence.
Check same-line/different-location races, deterministic locks, exact quantities and retry-key conflicts.
Check immutable movement/receipt/order-line attribution, actual cost/absence, correction and reversal history.
Check received bounds, amendment floor, explicit close/reopen, tenant business-day and period/negative-stock guards.
Trace rebuild from persisted facts and discrepancy capture before overwrite; reconciliation must never repair.
Trace server-derived ordered/received/remaining quantities and real allow/deny/revocation/audit browser proof.
Check migrations: accepted through 0024 unchanged, AUTH 0025, RECEIPT 0026/0027; combined snapshots/release.
Include runtime bindings, UI callers and reconciliation/materializer consumers beyond the static Critical file list.
Report bounded findings with concrete failure evidence; distinguish missing evidence from proven defects.
```
