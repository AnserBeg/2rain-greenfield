# RECEIPT — receive goods against purchase orders through the product

Status: active combined candidate; not accepted or review-ready. Tier: Critical. Stops: 1.
Base: `8af63acfd8eb4f95b5af8ceff1b6ce7c117b9def`. Owner's execution prompt is the charter.
Draft PR: https://github.com/AnserBeg/2rain-greenfield/pull/1. Review and acceptance remain external.

## Claims

1. Reconciliation runs read-only; rebuild preserves discrepancies before repair.
2. Receipt posting atomically writes source, companions, movements, received projection and trust/idempotency effects.
3. Immutable movement → receipt line → order line attribution and actual cost or explicit absence survive correction and rebuild.
4. ADR-0065 claims 1–10: bounded quantity, refusal payload, concurrent locations, verified projection, correction floor, authored-write refusal, deterministic rebuild, non-healing reconciliation, amendment isolation and recoverable attribution.
5. Product receiving uses the installed AUTH evaluator, explicit local grants, human-confirmed posting and server-derived ordered/received/remaining quantities.

## Decisions

- Preserve checkpoint `58dbec7d33df6181176e4c039678e937963e46b6`. Exact published AUTH `b17a64a3d4695b24907301be645cc6702ca71966` incorporated by history-preserving merge `b1164729fd537265bec2c0df9f43d88e00f386af`; no arbitrary later AUTH work imported.
- Accepted migrations through 0024 unchanged; AUTH 0025; RECEIPT 0026/0027. Kernel snapshot regenerated from all 27.
- ADR-0066 re-baseline resets only disposable `dev-receipt-postgres`; no retained/customer or other lane data touched. Currency search required a second re-baseline after its attempted transition omitted a derived search column; earlier demonstration records are disposable and the walkthrough is recreated.
- Scope: purchasing definitions, registered receiving capability/UI code, shared posting kernel, projection/reconciliation, migrations, release inputs and relevant tests. AUTH evaluator implementation remains inherited and unchanged.
- Plan §5.11 records the owner's narrow RECEIPT exception in this branch; no second metadata authority or doctrine rewrite.
- Forward-date default: zero tenant business days. Explicit close requires all active lines fully received; explicit reopen precedes further receiving, amendment or correction.
- Original 13 receipt permission bindings are now active; five exact amendment CRUD bindings added through AUTH's contract. Acknowledgements stay empty; no wildcard or allow-all production policy.
- Amendment intent is an ordinary `purchase_order_amendment` record: number, target line, expected revision, quantity, reason. Existing line-amend O1 consumes one matching request atomically.
- Isolated worktree `/home/rvham/2rain-greenfield-receipt`; database port 55437; server port 4317.
- Persisted facts/boundaries: Band A. Operator refusals/forms: Band B. Records: Band C.

## Integration

- Governed release builds with real evaluator bindings; application assembly installs AUTH and both posting executor factories. New runtime identity/grants are local-demo only and loopback-bound.
- Browser-created order and receipt exercise the real HTTP/forms/gateway/posting path: ordered 5, receipt 3, remaining 2. Revocation after rendering refuses Post; restoring the exact grant permits confirmed Post. Fresh-database browser test additionally asserts persisted DENY audit evidence.
- Fixed two product defects exposed by the journey: forms no longer submit server-owned lifecycle fields; commands/confirmation preserve selected legal-entity scope and record identity.
- Currency codes are searchable on receipt lines as on purchase orders. A three-character excluded-currency probe collided with another verifier value; the field now follows its ordinary business search semantics, not an excluded-field exception.
- Historical profile/reproduction checks use synthetic in-memory lineages after ADR-0066; their artifacts never enter the production path. The obsolete 168→163 historical scenario census is retired; current per-entity coverage and the independent executed/derived partition oracle remain.
- Final release plan has 257 scenarios: prior 198 plus 59 across receipt, receipt line, amendment request and received projection. Ten new operationless received-projection scenarios are derived, not represented as executed.
- Full-replay module snapshot regenerated from combined governed inputs; accepted kernel history is not rewritten.

## Controls

Eleven RECEIPT controls previously reproduced red/restored green: six at `ee595dae5bab5d4f41c5997625d846a74d47cfaf` (pre-rebuild capture, ordered ceiling, refusal payload, common order lock, received floor, received verifier); authored-write fence at `ec03a1163aa74a01e66aedda80e3069a0a986393`; rebuild identity, corruption reporting, amendment isolation and projection-independent reconstruction at `ad52434d87f57ab7e46a780f112b782a6a72fa2d`. Two initially mis-targeted kill assertions were corrected and actually rerun.

Six inherited controls reproduced red/restored green at `ad52434`: `coverage-comparison-absent`, `version-four-digest-covers-the-derived-role`, `active-release-fact-checked-after-the-receipt-lookup`, `recorded-at-floor-absent`, `comparator-drops-the-movement-id-tie-break`, `negative-stock-stops-sorting-persisted-with-planned`.

These 17 executions precede AUTH integration, not final-candidate control evidence. Combined controls remain owed. AUTH's binding-drift mutation is updated for active rather than reserved receipt bindings; no evaluator code changes.

## Gates

Local combined checks executed: governed build/check; schema regeneration (27 migrations); typecheck; compiler binding census 14/14; compiler profile tests 10/10; real fresh-database authorized/denied browser journey 1/1; policy + reconciliation 27/27; receipt atomic/lifecycle fixture 1/1; historical-invalid-head and synthetic intermediate refusal 2/2; synthetic profile/source rollback 1/1. These are focused results, not full CI.

The first browser run used the CI reachability reporter, which correctly returned nonzero for a filtered run despite the test passing. The explicit focused rerun used the list reporter and passed; no filtered run is claimed as CI reachability evidence.

Current-candidate CI and remaining combined checks are pending. Previous pre-AUTH CI is not reused as combined green. No independent review, owner test, acceptance, deployment or main merge claimed.

## Test it yourself

Server: http://127.0.0.1:4317 (already running; do not start a second instance).
If stopped, from this worktree run:
`PORT=4317 NORTH_STAR_DATABASE_PORT=55437 NORTH_STAR_DEV_DATABASE_CONTAINER=dev-receipt-postgres NORTH_STAR_TENANT_SLUG=receipt-development corepack pnpm dev`.

1. Open Purchasing → Purchase orders, select DEFAULT legal entity, then `RECEIPT-PO-*`. The posted example shows 5 ordered, 3 received, 2 remaining.
2. On the order, use **Create goods receipt**. Select the released order; enter a unique number, draft/initial, current Received at, location `71000000-0000-4000-8000-000000000021`, reason code and reason. Save.
3. Open that receipt → **Add receipt line**. Select the receipt and matching order line; item `71000000-0000-4000-8000-000000000011`, quantity at most remaining, unit `EA`. Choose actual cost known with canonical decimal `12.5` and `CAD`, or explicit absent. Save, return to receipt, **Post → Confirm Post**.
4. **View order progress** returns to the order list. Reopen the order record to see server-derived progress. Close is explicit and refuses while any active line has remaining quantity.
5. For amendment, open its order line → **Request quantity amendment**; enter the line's current revision, new quantity and reason, save, return to the line and **Amend → Confirm Amend**. Quantity cannot fall below received.
6. Corrections/reversals are new receipts linked to the posted original and immutable movement identities; reopen closed orders first. Posted history is never edited. Existing period and negative-stock safeguards still apply.

Reproducible fresh, isolated AUTH/product proof:
`corepack pnpm exec playwright test --config apps/web/playwright.config.ts receiving.composed-application.spec.ts --project=composed-application --no-deps --workers=1 --reporter=list`.
To run against this lane instead, prefix `COMPOSED_APPLICATION_BASE_URL=http://127.0.0.1:4317 RECEIVING_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55437/postgres`. This creates new demo documents and restores the one revoked test grant in `finally`.

Read-only/corruption proof: `node --import tsx --test test/postgres/inventory-reconciliation.test.ts`.
Atomic/lifecycle proof: `node --import tsx --test --test-name-pattern='RECEIPT posts' test/postgres/inventory-posting.test.ts` (fixture policy; not the production AUTH proof).

## Remaining / review

Combined CI/control evidence and the final external Critical review remain. Corrections/amendment/close/reopen have gateway/fixture coverage; the browser proof currently covers initial receiving and grant revocation. Decimal entry retains the existing canonical-input requirement (no trailing fractional zeroes). Local-demo grants are development-only, not an external login facility.

Final fresh-review prompt (≤40 lines) and frozen record-claim follow at review readiness. No independent review run by this lane.
