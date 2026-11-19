# WORKFLOW-1 — goods receipt inspection workflow

Status — stopped at release admission on base `8b61740a17c18a6201f01c4345c0e6c215ee91d3`. No executable slice or merge. No Critical paths changed.

## Findings

1. The receipt posting transaction already emits the first-party event and outbox row. The event identifies the receipt, company and posted movements. The worker can consume that evidence without editing posting.
2. CUSTOMIZE-4 at `c8110053` supplies the Inspection target, create-time relations and lifecycle. Its 0034 widens the patch-kind check. Main ended at 0032 at the checkpoint.
3. The required projection reader ignores an extra workflow family unless an existing required projection carries a changed compatibility floor. The release verifier currently observes semantic query and operation scenarios.
4. A run can retain its pinned code after a release change. Inventory posting still requires the active release and returns `INVENTORY_POSTING_RELEASE_MISMATCH` on a stale pin.

## Decisions

- [Proposed ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md) selects QuickJS–Emscripten with host-capped WASM memory and an append-only replay journal.
- Exact human confirmation applies to Tier B operations, any reachable published Tier B dependency and unknown dependency intersections.
- A direct receipt-to-inspection proof can use the Tier A create operation and the committed receipt event. The pending escalation approval must use the same exact-plan confirmation path.

## STOP

The full vertical needs an authorized runtime capability floor and a Critical change to `PostgresReleaseVerificationService` for candidate-bound workflow replay evidence. The proposed path preserves v6 and the posting kernel. An alternative charter can limit the packet to a host-only probe and leave tenant activation for the release-admission packet.

## Gates

- The temporary bakeoff exercised both installed candidates, including a Wasm memory-ceiling check for Emscripten. The temporary npm audit reported zero vulnerabilities.
- Hosted CI, repository security scans, restart, effect-boundary and browser journeys await the implementation.
- The rest of N2 includes documents and templates, communication and consent, email delivery, and the connector contract.

## Test it yourself

Run `scripts/check-records.sh` for the packet record. Run the [bakeoff](../../decisions/ADR-0073-workflow-isolate-and-authority.md#reproduce-the-bakeoff) in a temporary directory and expect two passing results. In `request-runtime-view-service.ts`, trace the five calls to `projectionFor` and the call to `unsupportedRuntimeCapability`. In `release-verification-service.ts`, trace `releaseVerificationBinding` to `executeSemanticCandidateAndPersist`. The checkpoints show where the workflow floor and replay evidence need to enter before there can be an approvals or receipt browser journey.
