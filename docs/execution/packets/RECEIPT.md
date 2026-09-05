# RECEIPT — receive goods against purchase orders through the product

Status: active implementation; governed release awaits the published AUTH dependency, not review-ready. Tier: Critical. Stops: 1. Base: `8af63acfd8eb4f95b5af8ceff1b6ce7c117b9def`.
Owner's execution prompt is the charter; final review and acceptance remain external.

## Claims (isolated verification; governed release and authorization pending)

1. Reconciliation runs read-only; rebuild preserves discrepancies before repair.
2. Receipt posting atomically writes source, companions, movements, received projection and trust/idempotency effects.
3. Persisted immutable attribution and actual cost or explicit absence survive correction and rebuild.
4. ADR-0065 claims 1–10: bounded quantity, actionable refusal, concurrent locations, verified projection, correction floor, authored-write refusal, deterministic rebuild, non-healing reconciliation, amendment isolation and recoverable attribution.
5. Product receiving shows server-derived ordered, received and remaining quantities and supports posting, correction, reversal, amendment, explicit close and reopen.

## Decisions

- Scope includes purchasing definitions, registered capability/UI code, the shared posting kernel, materializer/reconciler, append-only migrations, release artifacts and necessary tests/pins; AUTH implementation stays separate.
- Plan §5.11 records the owner's narrow RECEIPT exception in this branch.
- Forward-date default is zero tenant business days; close requires every active line fully received; reopen precedes receiving, amendment or correction of closed orders.
- Isolated worktree: `/home/rvham/2rain-greenfield-receipt`; development container: `dev-receipt-postgres`; server port: `4317` (availability checked before launch).
- Persisted facts and boundaries are Band A; operator refusals/forms Band B; records Band C. Critical claims receive executed discriminating expected-red controls.

## Slices

- Reconciliation CLI and pre-rebuild discrepancy persistence committed in `4f0fc4b`; CLI exercised against isolated empty development ledger: INDETERMINATE, subjects=0, repaired=0, transactionReadOnly=on, exit 3. Populated/corruption coverage followed at `af14f0e`.
- Receipt metadata, companion family, shared transaction, correction, received projection/rebuild and order lifecycle code are implemented under isolated fixture tests. The governed production release and authorized product walkthrough still await the published AUTH dependency.
- Isolated tests: purchasing definition 36/36; reconciliation 26/26 (corrupted CLI exit 2, no repair, pre-rebuild discrepancy and unchanged facts); receipt lifecycle 1/1 (atomic over-receipt refusal, retry, conflicting key, concurrent distinct locations, late received corruption rollback, gateway correction/reversal/amendment/close/reopen, rendered Record progress and reconstruction). Fixture artifacts stay in memory, never in the serving release; the fixture policy is not production authorization evidence.
- Amendment intent is a small ordinary `purchase_order_amendment` record: number, target order line, expected line revision, quantity and reason. The existing line-amend O1 hydrates exactly one matching request and consumes it atomically; the gateway input remains record/revision. Adds five exact permissions `northstar.app:permission.purchase_order_amendment_{create,read,update,archive,restore}`, resource `northstar.app:entity.purchase_order_amendment`, corresponding CRUD actions. Register through AUTH once delivered.

## Controls

All 11 entries in `test/evidence/RECEIPT.expected-red.json` actually reproduced their declared red and restored green: six at `ee595dae5bab5d4f41c5997625d846a74d47cfaf` (pre-rebuild capture, ordered ceiling, refusal payload, common order lock, received floor, received verifier); authored-write fence at `ec03a1163aa74a01e66aedda80e3069a0a986393`; rebuild identity, corruption reporting, amendment isolation and projection-independent reconstruction at `ad52434d87f57ab7e46a780f112b782a6a72fa2d`. The latter commits only refine tests/controls; the production tree is unchanged. Two initial controls caught the intended defect at an earlier assertion; their named assertions were corrected and rerun, never counted as successful runner executions before that.

Six inherited controls also reproduced red/restored green at `ad52434`: `coverage-comparison-absent`, `version-four-digest-covers-the-derived-role`, `active-release-fact-checked-after-the-receipt-lookup`, `recorded-at-floor-absent`, `comparator-drops-the-movement-id-tie-break`, `negative-stock-stops-sorting-persisted-with-planned`. Seventeen executed controls total; manifest validation/self-test is not substituted. Final combined AUTH/RECEIPT candidate controls remain owed.

## Gates

Draft PR: https://github.com/AnserBeg/2rain-greenfield/pull/1. No acceptance or review claimed; not at review readiness.

CI https://github.com/AnserBeg/2rain-greenfield/actions/runs/33946463972 at `810d5b7a7940577a351c7d7e1cdd3e75f4bc6cd2`: unit 156/156, browser/security/performance green; compiler 169/173, with four failures at governed permission/release cases; PostgreSQL still running at this record update. Earlier schema drift and startup failures are repaired (shared error extraction preserves its public export); the new empty receiving reconciliation arm explicitly remains indeterminate. No checks weakened. New checkpoint CI will run on the PR push; no full-matrix green claimed.

At blocked `a58cfb4`, governed compilation refused exactly 13 `COMPILER_PERMISSION_EVALUATOR_UNBOUND` declarations: goods_receipt {archive,create,post,read,restore,update}; goods_receipt_line {archive,create,read,restore,update}; purchase_order_line_amend; purchase_order_received_read. All IDs use `northstar.app:permission.`. The five later amendment-request permissions above also require real bindings; acknowledgement remains unchanged.

## Test it yourself

The receipt product walkthrough is not yet runnable. No owner test claimed.

Fixture checkpoint: `node --import tsx --test --test-name-pattern='RECEIPT posts' test/postgres/inventory-posting.test.ts`; `node --import tsx --test test/postgres/inventory-reconciliation.test.ts`. Both use disposable isolated test databases; neither starts or repairs the development server. The receipt test renders the real Record surface and invokes posting, amendment, close and reopen through the application gateway, using an isolated test policy, not production authorization evidence.

From this worktree, start the isolated existing-release server with `PORT=4317 NORTH_STAR_DATABASE_PORT=55437 NORTH_STAR_DEV_DATABASE_CONTAINER=dev-receipt-postgres NORTH_STAR_TENANT_SLUG=receipt-development corepack pnpm dev` (do not start a second instance if already running).

Run `DATABASE_URL=postgresql://north_star_runtime@127.0.0.1:55437/postgres node --import tsx scripts/reconcile-inventory.ts 6d303f40-9453-4148-a47f-6388f8405213 cdbe1c45-efc1-485a-b44b-77acbfcc108a 40000000-0000-4000-8000-000000000001 74000000-0000-4000-8000-000000000001` against the isolated trust-authenticated local database. Empty inventory must say INDETERMINATE with repaired=0; the command never starts/rebuilds the application.

## Stop / requested bridge

The checked-in `apps/web/release/unbound-permission-acknowledgement.json` says "THIS LIST MAY ONLY SHRINK". New receipt declarations cannot compile under that policy; AUTH owns the evaluator and this lane may not absorb it. The register and AUTH implementation remain unchanged.

Owner ruling: https://github.com/AnserBeg/2rain-greenfield/pull/1#issuecomment-5549264574. AUTH supplies a real evaluator/binding dependency first; no temporary acknowledgements. Isolated fixture compilation/testing may continue, never feeding production release/serving artifacts. Only an explicitly published dependency SHA may be history-preservingly merged; none incorporated yet. AUTH migrations go first, followed by renumbering only RECEIPT's unaccepted migrations and regenerating combined snapshots.

## Filed

None.

## Review prompt

Pending final candidate (at most 40 lines). No independent review run by this lane.
