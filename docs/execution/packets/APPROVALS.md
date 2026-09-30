# APPROVALS — purchase-order approval, placement and staged amendments

Status: draft checkpoint; not integrated or deployed. Critical paths touched: none. Inventory approvals (A6) are excluded.

## Claims

1. LOCAL_DEMO seeds Buyer and Manager, exposes a shared-shell acting-as switch and records the selected trusted principal; non-demo ingress neither offers nor honors the switch.
2. The tenant setting **Purchase orders require approval** is off when absent and on in the approval fixture. A declared Approvals List exposes one-step requests; Approve and Reject require the new approve permission and a reason.
3. **Place order** replaces the Release label, accepts an optional supplier reference and retains Released state. When required, placement consumes approval of the current header and active-line revision image; intervening header/line changes invalidate it.
4. When approval is required, a released order's amendment remains staged until approval, while receiving continues against current quantities. Approval binds the proposal revision and rechecks the received floor; rejection archives only the proposal and changes no ordered quantity.
5. Product declarations, the compiler and shared List/Record/Task runtimes carry the flow. Request records have no generic write operations; semantic capability execution supplies idempotent decisions and persisted read-back.

## Decisions

- Owner rulings A1–A5, taken 2026-09-30, are used as written in [the design](APPROVALS-design.md); A2's inventory maker-checker clause and A6 belong to the separate Critical inventory-approval packet after RETURNS.
- PO approval is permission-gated, not maker-checker: a Manager may approve their own request. Buyer lacks the approve permission; real sign-in stays with AUTH.
- Revision identity includes the header revision and sorted active line IDs/revisions; amendments also bind their proposal ID/revision, so generic edits cannot retarget a pending approval. Receiving projections do not change that image; an approval cannot apply a proposal below quantities received meanwhile.
- One pending amendment per PO prevents competing proposed quantities. A stale request may be rejected to clear its intent; rejection never restores old data.
- A read-only, capability-owned entity may omit generic CRUD/forms only when its declared record-mutation capability and read-back match; partial generic families still fail compiler conformance.
- ADR-0066 lineage is rebuilt from `origin/packet/PAYABLES`: five base entries plus exactly one APPROVALS entry. No storage transition or Critical substrate change was introduced.
- Compile-derived pins: 106 surfaces, 18 navigation leaves, 605 verification scenarios (507 constructible, 98 derived). Language coverage and the fresh-tenant schema snapshot are re-derived, not guessed.

## Slices

- Submit, reject, approve and place: [walkthrough](APPROVALS-test-it-yourself.md).
- Stage and decide an amendment while receiving: [walkthrough](APPROVALS-test-it-yourself.md).

## Gates

- Local gates: format, lint, typecheck and release `--check`; purchasing/workspace 61/61, canonical 7/7, coverage 24/24, repaired integration cases 5/5, approval/inbox/demo contracts 3/3 and full web contracts 37/37. Full-lineage schema generation passed.
- The approval PostgreSQL business test initially failed at the now-corrected indexed-reference replay; its corrected run and the browser journey remain pending an exclusive slot/CI. A queued retry exited lock-busy without starting either test.
- The new PostgreSQL test is registered in `test:postgres:commercial` and repository hygiene; `purchase-approvals.spec.ts` is included in the operations browser job.
- CI at the pushed PR SHA is the acceptance matrix. This draft is not accepted, merged or deployed; the owner requested a draft PR against PAYABLES only.
- No timeout, threshold, existing action limit or PostgreSQL readiness bound has been raised. PostgreSQL/schema commands use the exclusive lock and browsers use one worker.
- Local dependency-boundary tests passed 47/47 but their Docker cleanup controls briefly overlapped the locked replay in an incorrectly direct invocation; they completed and cleaned up. Subsequent runs must be exclusive.

## Test it yourself

Follow [APPROVALS-test-it-yourself.md](APPROVALS-test-it-yourself.md): Buyer submits, Manager rejects with a reason, Buyer resubmits, Manager approves, Buyer places with a supplier reference, then stages an amendment without changing received/ordered quantities.

## Filed

- Full multi-step workflow/timers belong to N2; real authentication belongs to AUTH; inventory approval changes the kernel/trust and follows RETURNS.
- Supplier reference is displayed, not indexed for text search. The indexed declaration failed replay's column check; any necessary Critical substrate change is deferred outside this packet.

Review: not owed — outside the Critical set. No stage boundary is integrated by this draft; no autonomous program review or integration is performed.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "APPROVALS",
  "base": "a3b104db44b58382db48ad67687ec159d8c31bba",
  "head": "8523e84a0333fb052c7aac195206424898ce7358",
  "changedPaths": [
    "apps/api/src/composition-root.ts",
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json",
    "apps/web/src/app-server.ts",
    "apps/web/src/component-registry.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/order-entry.spec.ts",
    "apps/web/test/browser/purchase-approvals.spec.ts",
    "apps/web/test/browser/purchase-pricing.spec.ts",
    "apps/web/test/browser/receiving.composed-application.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "package.json",
    "packages/canonical-model/src/surface-composition.ts",
    "packages/compiler/src/conformance.ts",
    "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/list-declarations.ts",
    "packages/domain/src/app/order-entry.ts",
    "packages/domain/src/inventory/contracts.ts",
    "packages/domain/src/purchasing/approval-workspace.ts",
    "packages/domain/src/purchasing/approvals.ts",
    "packages/postgres-provider/package.json",
    "packages/postgres-provider/src/commercial-read-model.ts",
    "packages/postgres-provider/src/composed-application-runtime.ts",
    "packages/postgres-provider/src/purchase-order-approval-executor.ts",
    "packages/postgres-provider/src/purchase-order-approval.ts",
    "packages/runtime/src/local-demo-actor.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/compiler/inventory-contract.release.golden.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/generate-fresh-tenant-full-replay-schema.ts",
    "test/helpers/order-entry-fixture.ts",
    "test/helpers/reachability-producers.ts",
    "test/integration/surface-data-binding.test.ts",
    "test/postgres/composed-application.test.ts",
    "test/postgres/fresh-tenant-full-replay-schema.snapshot.json",
    "test/postgres/purchase-approvals.test.ts",
    "test/unit/canonical-model/surface-composition.test.ts",
    "test/unit/purchasing-definition.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    { "path": "packages/domain/src/purchasing/approvals.ts", "name": "withPurchaseOrderApprovals" },
    { "path": "packages/domain/src/purchasing/approval-workspace.ts", "name": "approvalWorkspace" },
    { "path": "packages/postgres-provider/src/purchase-order-approval-executor.ts", "name": "PURCHASE_ORDER_APPROVAL_EXECUTOR_FACTORY" },
    { "path": "packages/postgres-provider/src/purchase-order-approval.ts", "name": "purchaseOrderRevisionDigest" },
    { "path": "packages/runtime/src/local-demo-actor.ts", "name": "localDemoActor" }
  ]
}
```
