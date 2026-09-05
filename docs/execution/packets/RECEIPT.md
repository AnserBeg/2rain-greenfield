# RECEIPT — receive goods against purchase orders through the product

Status: active implementation; governed release awaits the published AUTH dependency, not review-ready. Tier: Critical. Stops: 1. Base: `8af63acfd8eb4f95b5af8ceff1b6ce7c117b9def`.
Owner's execution prompt is the charter; final review and acceptance remain external.

## Claims (implementation and verification pending)

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
- Resumed isolated tests: purchasing definition 36/36; reconciliation 26/26 (corrupted CLI exit 2, no repair, pre-rebuild discrepancy and unchanged facts); receipt kernel 1/1 (atomic over-receipt refusal, retry, conflicting key, concurrent distinct locations observed at common order lock, correction through real gateway, late received corruption rollback, amendment floor and reconstruction). Fixture artifacts stay in memory, never in the serving release. New Record-section/gateway lifecycle checks are being added, not yet acceptance evidence.
- Amendment intent is a small ordinary `purchase_order_amendment` record: number, target order line, expected line revision, quantity and reason. The existing line-amend O1 hydrates exactly one matching request and consumes it atomically; the gateway input remains record/revision. Adds five exact permissions `northstar.app:permission.purchase_order_amendment_{create,read,update,archive,restore}`, resource `northstar.app:entity.purchase_order_amendment`, corresponding CRUD actions. Register through AUTH once delivered.

## Controls

At `af14f0e`, actually executed `receipt-rebuild-discrepancy-capture-absent` and `receipt-ordered-ceiling-absent`: each reproduced its expected red and restored green. Additional payload, common-lock, received-floor and non-vacuous verifier controls are added; current candidate rerun remains owed. Manifest validation is not execution.

## Gates

Draft PR: https://github.com/AnserBeg/2rain-greenfield/pull/1. No acceptance or review claimed; not at review readiness.

Latest completed CI https://github.com/AnserBeg/2rain-greenfield/actions/runs/33945875219 tested `4b79d5e7a45d6a46fdf241f44c66c148db496caa`: schema drift and security green; unit/browser/provider startup exposed a receipt import cycle, now fixed by extracting the shared error type without changing its public export. Reconciliation's new empty arm is explicitly indeterminate. Focused reconciliation 26/26, dev lifecycle 14/14, receipt lifecycle/product Record 1/1 pass locally. Performance indeterminate (CPU idle 46.7%, required 90%); governed release/history still await AUTH. No checks weakened.

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
