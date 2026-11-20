# BOOKING-1 — book a resource over time

Fable approved [ADR-0082](../../decisions/ADR-0082-booking-over-time.md) with changes and rejected the original consumer contract. This docs-only amendment publishes the billing and event contracts.

Fable’s narrow re-read accepted ADR-0082 with amendments. A1–A3 gate 1a, A4–A7 and A9–A10 gate 1b, A8 gates slice 2 and CALENDAR-1, and A9–A10 gate BILLING-1 slice 2.

## Design decisions

1. Each resource has one diary. Pool totals are effective-dated. A reserved class claim draws on its member units. Assign-unit ships later.
2. The fact retains the requested target, assignment, group and slot, agreed and occupied intervals and fulfilment mode. A timed appointment can complete without possession.
3. Actual-use legs carry quantities. Bounded corrections preserve both effective and recorded time. An onboarding operation admits existing work under the same capacity checks.
4. PostgreSQL serializes writers and archive on registry rows. The exclusion constraint protects unit commitments. Open-leg uniqueness and the locked pool check protect physical handover.
5. Each owner has a versioned usage projection and transactional cursor. A correction to a previously read pause reaches the next incremental read. Billing owns the monetary interpretation.
6. Customize versions and retires both bindings. The Operation catalog gates entity declarations and the Surface manifest gates the picker. Dates and quantities on an owner line come from its booking.
7. A hold is reversible. Workflows need recorded human approval even for a hold. No rung or migration is assigned by this amendment.

## Checkpoints

| Slice | Outcome and gate |
| --- | --- |
| 0 | Proposal passed [CI 44669525076](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44669525076). Amendment uses the docs-only merge ruling and record check. |
| 1a | Hold, confirm, cancel, expiry and Change interval. Race the same unit, pool capacity and expiry deadline. |
| 1b | Possession, scheduled completion, pool quantity changes, swaps, pauses, groups, corrections and onboarding. Check actual legs and incremental billing evidence. |
| 2 | Availability picker and seven scheduling queries, including group fit, type count and a scoped calendar window. |
| 3 | Compose or draft both bindings. Exercise activation, retirement, rollback, old readers and projected line terms. |
| 4 | Generate a unit/pool/kit contract and a timed room appointment owned by a non-line record across companies. Exercise both through generic bindings. |

## Slice 1a

- The released booking operation binds its owner, resource, permissions and approval. Its Operation catalog reader floor is 5. A hold returns its booking ID, revision and deadline.
- Unit holds from two companies contend on the same occupied interval. Adjacent claims fit. Pools combine simultaneous demand and dated capacity changes. A failed reschedule keeps the original claim.
- PostgreSQL checks the release fence, actor, company and endpoint revision, serializes archive, and commits history, owner cursor, typed event, trust rows and receipt together. The worker expires due holds using their original authority.
- Date-only holds and changes preserve the agreement and clamp occupation at the post-lock instant. At equality expiry wins. A backward clock cannot reopen capacity early.
- Regression controls remove unit exclusion for holds, allow a pool deficit, move occupation to the day boundary, and let a waiting confirmation run at its deadline.

Migration 0050 replayed to the checked-in snapshot. [Packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44729321788) · [Four restored regression controls](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44729321814).

## Test it yourself

Run `node --import tsx --test test/postgres/booking-commitments.test.ts` with Docker running. The test creates and removes its own PostgreSQL instance. The compiler proof is `node --import tsx --test test/compiler/booking-commitments.test.ts`.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "BOOKING-1",
  "base": "47594bc60c4349d9a8b76dcdefe81503119aeaf8", "head": "f87dc25b814129f7d654a19531878fb783e361b8",
  "changedPaths": [
    "apps/api/src/erp-capabilities.ts", "db/migrations/0050_booking_commitments.sql", "db/schema.snapshot.json", "package.json",
    "packages/canonical-model/src/booking.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/schemas.ts", "packages/compiler/src/compiler.ts",
    "packages/compiler/src/projections.ts", "packages/postgres-provider/package.json", "packages/postgres-provider/src/booking-capability-executor.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/postgres-provider/src/module-storage-materializer.ts", "packages/postgres-provider/src/release-repository.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/postgres-provider/src/workflow-worker.ts",
    "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-operation-gateway.ts", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/repository-hygiene.test.ts",
    "test/architecture/tenant-completeness.manifest.json", "test/architecture/tenant-completeness.test.ts", "test/compiler/booking-commitments.test.ts", "test/evidence/BOOKING-1.expected-red.json",
    "test/fixtures/booking-commitments.sql", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/reachability-producers.ts", "test/postgres/booking-commitments.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts", "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [{"path":"packages/canonical-model/src/booking.ts","name":"BookingOperationBinding"},{"path":"packages/postgres-provider/src/booking-capability-executor.ts","name":"BookingCapabilityExecutor"}]
}
```
