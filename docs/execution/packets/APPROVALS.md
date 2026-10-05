# APPROVALS — purchase-order approval, placement and staged amendments

Status: [draft PR #14](https://github.com/AnserBeg/2rain-greenfield/pull/14); not integrated or deployed. Critical paths touched: none. Inventory approvals (A6) are excluded.

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
- PAYABLES `681f4675` is merged. The compile still declares 10 assigned-number fields and 10 uniqueness probes; approval request IDs add no document-number assignment, so both numbering lists are retained unchanged.
- A capability argument envelope is emitted only when canonical Task bindings declare it. Historical record/revision-only command contracts remain byte-identical; each executor refuses unknown inner arguments.
- The shared Task runtime previews all declared steps against current boundary/operation permissions before offering or opening a Task; denied or unavailable policy withholds the offer, not the record. This read-only preview is not authority: execution still checks exact inputs, current policy and required confirmation.

## Slices

- Submit, reject, approve and place: [walkthrough](APPROVALS-test-it-yourself.md).
- Stage and decide an amendment while receiving: [walkthrough](APPROVALS-test-it-yourself.md).

## Gates

- Local gates: format, lint, typecheck and release `--check`; purchasing/workspace 61/61, canonical 7/7, coverage 24/24, repaired integration cases 5/5, approval/inbox/demo contracts 3/3 and full web contracts 37/37. Full-lineage schema generation passed.
- Initial local PostgreSQL failed at the corrected indexed-reference replay. Later focused retries exited lock-busy without starting. One browser run incorrectly overlapped release generation and pinned the PAYABLES base; it is not acceptance evidence. Release generation and consumers are now serialized.
- The [first CI run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/36787728753) exposed the demo request key, a Task contract refusal, two old fixture assumptions and stale List/PO pins; these are corrected. The composed rollback job also lost a PostgreSQL connection; the fresh matrix must settle it.
- Post-CI focused gates: units 68/68, an observed-red-then-green Place order Task round trip 1/1, web contracts 37/37, typecheck, lint, changed-path formatting and rebuilt release `--check` passed.
- The [second CI run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/36802117405) passed commercial PostgreSQL 20/20 (including APPROVAL-PO), schema/isolation, the main browser suite, performance and security. Quality's executable gates passed; its final diff check found an extra design EOF blank line, now removed. The inbox browser locator and an old unconfirmed Place order fixture are corrected; the next full matrix remains required.
- The rollback fixture lost a PostgreSQL connection twice with both synthetic tenants in one database. Its two discriminating claims now have separate database lifecycles, with unchanged 256 MiB capacity and 300 s bounds; this is a test isolation correction, not a change to release activation or verification.
- Pre-affordance local checks: typecheck, lint, changed-test formatting, base-envelope rebuild/check and coverage re-derivation passed (2,654 obligations, 814 declaration/lowering observations). The focused browser attempt was lock-busy and ran no test.
- The [third CI run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/36840959891) passed quality, all PostgreSQL jobs (composed 22/22, including both isolated rollback directions), the main browser suite, security and observability. Performance refused an indeterminate CPU-idle sample (73.3% < 90%); the operations journey exposed Buyer's incorrectly offered decision Tasks. The shared permission preview corrects that UI defect; the next full matrix is required. Docker is unavailable in the resumed WSL session; no new local container-backed test ran.
- The permission-offer regression was observed red then green. The broader container-free integration/web-contract run passed 213/213, including denied, restored and unavailable-policy offers plus forged Task entry and unchanged confirmation enforcement. Final lint, typecheck, changed-source formatting, rebuilt release checks and coverage re-derivation passed; measured pins and both 10-entry numbering lists are unchanged.
- The [fourth CI run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37255572539) passed quality, all PostgreSQL jobs, performance, security, the main browser suite and observability. The new approval browser journey passed; operations passed 29/31 and reachability was skipped. Its two stale tests now include the compiled approval/settings navigation leaves and use the declared amendment Task with approval off. Local formatting, typecheck, lint, base-envelope rebuild/check and coverage re-derivation passed; a fresh full matrix remains required.
- The new PostgreSQL test is registered in `test:postgres:commercial` and repository hygiene; `purchase-approvals.spec.ts` is included in the operations browser job.
- CI at the pushed PR SHA is the acceptance matrix. This draft is not accepted, merged or deployed; the owner requested a draft PR against PAYABLES only.
- No timeout, threshold, existing action limit or PostgreSQL readiness bound has been raised. Local PostgreSQL/schema commands use the exclusive lock and local browsers use one worker.
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
  "base": "681f46751b2a4c3cc9027956534b741c35dd4a03",
  "head": "8051246edd2a17719ea81dba9c7365430540a1e4",
  "changedPaths": [
    "apps/api/src/composition-root.ts",
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json",
    "apps/web/src/app-server.ts",
    "apps/web/src/component-registry.ts",
    "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/order-entry.spec.ts",
    "apps/web/test/browser/purchase-approvals.spec.ts",
    "apps/web/test/browser/purchase-pricing.spec.ts",
    "apps/web/test/browser/receiving.composed-application.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "package.json",
    "packages/canonical-model/src/surface-composition.ts",
    "packages/compiler/src/conformance.ts",
    "packages/compiler/src/projections.ts",
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
    "packages/runtime/src/semantic-operation-gateway.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/compiler/inventory-contract.release.golden.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/generate-fresh-tenant-full-replay-schema.ts",
    "test/helpers/order-entry-fixture.ts",
    "test/helpers/reachability-producers.ts",
    "test/integration/semantic-gateways.test.ts",
    "test/integration/surface-data-binding.test.ts",
    "test/postgres/composed-application.test.ts",
    "test/postgres/fresh-tenant-full-replay-schema.snapshot.json",
    "test/postgres/inventory-posting.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/purchase-approvals.test.ts",
    "test/unit/canonical-model/surface-composition.test.ts",
    "test/unit/canonical-model/surface-list.test.ts",
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
