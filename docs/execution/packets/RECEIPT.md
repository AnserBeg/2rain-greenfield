# RECEIPT — receive goods against purchase orders through the product

Status: active. Tier: Critical. Base: `8af63acfd8eb4f95b5af8ceff1b6ce7c117b9def`.
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

- Reconciliation; receipts and attribution; atomic posting; received quantities and amendments; correction/closing; product walkthrough. Pending.

## Controls

Pending implementation and actual execution; manifest validation is not execution.

## Gates

Pending. Required: format, typecheck, focused suites, actual candidate CI via PR, Critical expected-red execution and `scripts/check-records.sh`.

## Test it yourself

Product walkthrough will be recorded after the isolated server is runnable. No owner test claimed.

## Filed

None.

## Review prompt

Pending final candidate (at most 40 lines). No independent review run by this lane.
