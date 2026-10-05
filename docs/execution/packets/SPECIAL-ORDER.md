# SPECIAL-ORDER — dedicated purchase supply received into stock

Status: BUILD active on `packet/SPECIAL-ORDER`, based on DROP-SHIP `1b16c746`; [draft PR #28](https://github.com/AnserBeg/2rain-greenfield/pull/28), executable freeze `38e1e1c4`. No integration or deployment.

## Design (before implementation)

- Special order extends the existing fulfillment route and symmetric demand/supply line link. Create special-order PO creates or extends the supplier's draft PO with exactly one purchase line per sales line; repeated execution reuses the link.
- The existing supplier field is shared by Drop ship and Special order and labelled Supplier. Normal goods receipts enter stock; no delivery document, virtual location or new movement family is introduced.
- Reservation admission checks net linked receipts minus net shipped and live reservation coverage. Shipment admission checks resulting net shipped against net linked receipts. Named refusals distinguish missing supply from insufficient arrivals.
- Capability/lifecycle admission shares a company-scoped allocation mutex on the same connection used by the unchanged writer. It spans the guard and commit; it never replaces the kernel's stock locks. Receipt reductions cannot undercut shipped plus live reserved quantities; release and shipment corrections participate in the mutex.
- A declared selected-line Task, Reserve for the special order, uses the existing reservation create/reserve operations. Receiving never automatically reserves. Both orders expose route, linked line/order and Arrived through governed read models.
- Owned paths: application assembly metadata, capability/lifecycle executors and commercial/fulfillment read models, focused tests, generated release/coverage/schema artifacts, pins and packet records. Posting kernel, serializer, posting trigger/rebuild, activation/verification, trust, migrations and RLS/grants remain unchanged.
- PaneFlow's route/allocation behavior is a read-only reference; its receipt auto-reservation and multi-demand allocations are not copied.

## Rulings

- S-A: special-order goods arrive into ordinary stock (owner recommended choice).
- S-B: one purchase line per special-order sales line, using the existing link (owner recommended choice).
- S-C: explicit reservation Task only; no auto-reservation in receipt posting (owner recommended choice).

## Gates

Focused unit/integration/web contracts, typecheck, lint, compile/check and record fidelity pass. Full hosted CI, commercial PostgreSQL and operations browser are pending.

Review: not owed — intended diff is outside the Critical set.

## Checkpoint evidence

- Local focused tests PASS: special-order unit/integration, purchasing definition (47 tests); shared web contracts and new unit/integration tests (42 tests). Typecheck, focused lint, release `--check` and whitespace check PASS.
- Compile measurement: 7 release entries (6 inherited + 1), 104 surfaces, 16 navigation destinations, 604 verification scenarios and 11 numbered fields. Existing count/navigation pins remain unchanged; executed/derived split remains asserted by hosted composed PostgreSQL.
- Surface floor 16 is the next free value above base 15, for receipt-backed reservation figures. Language inventory re-derived: 2658 obligations / 823 observed declarations; no invented execution receipts.
- Local container tests were not run: Windows memory below 1.2 GB and another lane's container present. Commercial PostgreSQL, operations browser and full replay acceptance are pending on CI; hosted snapshot regeneration passed below.
- Shared supplier field retains its canonical ID; its label now covers both supplier routes. Special-order PO ship-to is not copied from the customer: goods use the ordinary receiving location.
- [Hosted snapshot regeneration](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37341036343) PASS at `6f9aa31a`; its downloaded artifact expands the route check and is committed at `5cc804d5`. Definition/storage bytes are unchanged since generation; label removed.
- Initial CI exposed two stale unit pins (five Sales order commands and Arrived declarations); corrected, with 31 focused tests PASS. Borrowed writer rejection now destroys its connection, with a focused cleanup test. No Critical path or readiness/timeout/budget change.
- Commercial PostgreSQL also asserts the named refusal for a shipment above linked arrivals and observes zero movements for its source. Focused lint/typecheck PASS; hosted execution pending.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SPECIAL-ORDER",
  "base": "1b16c74678f17950055b536478988c2ef7ad6141",
  "head": "38e1e1c4d01ebdbf36198ee1cae9213c268e534c",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json",
    "apps/web/test/browser/purchase-special-order.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "package.json",
    "packages/compiler/src/projections.ts",
    "packages/domain/src/app/builder.ts",
    "packages/domain/src/app/special-order.ts",
    "packages/postgres-provider/src/commercial-link-read-model.ts",
    "packages/postgres-provider/src/commercial-read-model.ts",
    "packages/postgres-provider/src/drop-ship-executor.ts",
    "packages/postgres-provider/src/drop-ship-mutation-guards.ts",
    "packages/postgres-provider/src/drop-ship-support.ts",
    "packages/postgres-provider/src/fulfillment-capability-executor.ts",
    "packages/postgres-provider/src/fulfillment-lifecycle.ts",
    "packages/postgres-provider/src/fulfillment-read-model.ts",
    "packages/postgres-provider/src/inventory-posting-error.ts",
    "packages/postgres-provider/src/receiving-capability-executor.ts",
    "packages/postgres-provider/src/special-order-support.ts",
    "packages/runtime/src/request-runtime-view.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/reachability-producers.ts",
    "test/integration/special-order.test.ts",
    "test/postgres/composed-application.test.ts",
    "test/postgres/fresh-tenant-full-replay-schema.snapshot.json",
    "test/postgres/request-runtime-view.test.ts",
    "test/postgres/special-order.test.ts",
    "test/unit/purchasing-definition.test.ts",
    "test/unit/sales-definition.test.ts",
    "test/unit/special-order.test.ts",
    "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/domain/src/app/special-order.ts",
      "name": "withSpecialOrder"
    },
    {
      "path": "packages/postgres-provider/src/special-order-support.ts",
      "name": "withSpecialOrderGate"
    },
    {
      "path": "packages/postgres-provider/src/special-order-support.ts",
      "name": "specialOrderFacts"
    },
    {
      "path": "packages/postgres-provider/src/special-order-support.ts",
      "name": "assertSpecialOrderPosting"
    }
  ]
}
```
