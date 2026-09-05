# RECEIPT — receive goods against purchase orders through the product

Status: blocked on authorization/release-policy bridge, not review-ready. Tier: Critical. Stops: 1. Base: `8af63acfd8eb4f95b5af8ceff1b6ce7c117b9def`.
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

- Reconciliation CLI and pre-rebuild discrepancy persistence committed in `4f0fc4b`; CLI exercised against isolated empty development ledger: INDETERMINATE, subjects=0, repaired=0, transactionReadOnly=on, exit 3. Populated/corruption controls remain owed.
- Receipt metadata, companion family, shared transaction changes, correction checks, received writer role and registered gateway adapter are staged implementation, not runtime-verified. Lifecycle/amendment execution, received rebuild/reconciliation and product receiving remain incomplete.

## Controls

Pending implementation and actual execution; manifest validation is not execution.

## Gates

Draft PR: https://github.com/AnserBeg/2rain-greenfield/pull/1. No acceptance or review claimed. Critical expected-red controls executed: none; not at review readiness.

Local checkpoint: `pnpm format`, `pnpm typecheck`, `git diff --check` passed. Earlier slice CI https://github.com/AnserBeg/2rain-greenfield/actions/runs/33943109657 tested `4f0fc4b7e63a83ebb854a791d82bd5232179317e`: failed architecture/hygiene and schema drift; PostgreSQL suite not reached. This is not evidence for the later kernel work; migration snapshot/pins and full verification remain owed.

Candidate definition compile against the unchanged acknowledgement register refuses ONLY 13 `COMPILER_PERMISSION_EVALUATOR_UNBOUND` declarations: goods_receipt {archive,create,post,read,restore,update}; goods_receipt_line {archive,create,read,restore,update}; purchase_order_line_amend; purchase_order_received_read. All IDs use `northstar.app:permission.`.

## Test it yourself

The receipt product walkthrough is not yet runnable. No owner test claimed.

From this worktree, start the isolated existing-release server with `PORT=4317 NORTH_STAR_DATABASE_PORT=55437 NORTH_STAR_DEV_DATABASE_CONTAINER=dev-receipt-postgres NORTH_STAR_TENANT_SLUG=receipt-development corepack pnpm dev` (do not start a second instance if already running).

Run `DATABASE_URL=postgresql://north_star_runtime@127.0.0.1:55437/postgres node --import tsx scripts/reconcile-inventory.ts 6d303f40-9453-4148-a47f-6388f8405213 cdbe1c45-efc1-485a-b44b-77acbfcc108a 40000000-0000-4000-8000-000000000001 74000000-0000-4000-8000-000000000001` against the isolated trust-authenticated local database. Empty inventory must say INDETERMINATE with repaired=0; the command never starts/rebuilds the application.

## Stop / requested bridge

The checked-in `apps/web/release/unbound-permission-acknowledgement.json` says "THIS LIST MAY ONLY SHRINK". New receipt declarations cannot compile under that policy; AUTH owns the evaluator and this lane may not absorb it. The register and AUTH implementation remain unchanged.

Options: AUTH supplies evaluator bindings for these receipt resources (recommended); or owner explicitly authorizes a narrow temporary receipt-only acknowledgement under the existing team-only policy. The §5.11 exception does not grant that authorization. Request sent to owner; no selection assumed.

## Filed

None.

## Review prompt

Pending final candidate (at most 40 lines). No independent review run by this lane.
