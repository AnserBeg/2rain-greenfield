# BOOKING-1 — book a resource over time

Fable accepted amended [ADR-0082](../../decisions/ADR-0082-booking-over-time.md). A1–A3 gate 1a, A4–A7 and A9–A10 gate 1b, A8 gates slice 2 and CALENDAR-1, and A9–A10 gate BILLING-1 slice 2.

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

## Slice 1a review fixes

1. A booking command requires an active update or transition permission on its owner.
2. A separate approval issuer attests a verified grant to the exact command. SQL consumes it once and records the approving human. Archive checks limit company visibility to current grants on the endpoint.
3. Signed approvals and database grants bind the active fence. Reactivating a release requires a fresh approval.
4. Both archive routines require READ COMMITTED. Archive rechecks allocation after locking the record.
5. Expiry has its own receipt and outbox namespace. Each worker expiry rolls back independently on a unique conflict.
6. After locking the diary, foreground writers lock both endpoints and all ancestors in order, then owner cursors in order. Workers skip locked diaries and busy owner cursors.
7. With an 08:00 day boundary, a date-only hold entered at 06:00 retains the 08:00 agreement and occupies from 06:00.
8. Company authority is exercised against the correct owner. Committed event cursors remain contiguous across a competing diary write that fails.
9. Both tenant runners compare the complete v6 release envelope to the pre-booking compiler at `47594bc6`.

The staff server accepts the issuer login through `STAFF_APPROVAL_DATABASE_URL`. A missing issuer connection refuses operations requiring approval.

## Test it yourself

Run `node --import tsx --test test/postgres/booking-commitments.test.ts` with Docker for the isolated database proofs. Run `CI=1 node --import tsx --test test/compiler/booking-commitments.test.ts` for compiler admission and both tenant runners.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "BOOKING-1",
  "base": "17618776dd058bbb8efec032eae13a00a5d5398b", "head": "78735418fdb9ef9648b78b30e2af92babf054800",
  "changedPaths": [
    "apps/api/src/pilot-composition-root.ts", "apps/api/src/staff-main.ts", "db/migrations/0051_booking_authority.sql",
    "db/schema.snapshot.json", "packages/canonical-model/src/booking.ts", "packages/postgres-provider/src/booking-capability-executor.ts",
    "packages/postgres-provider/src/capability-operation-executor-factory.ts", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/serving-gateways.ts",
    "packages/runtime/src/semantic-operation-gateway.ts", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/tenant-completeness.manifest.json",
    "test/architecture/tenant-completeness.test.ts", "test/compiler/booking-commitments.test.ts", "test/evidence/BOOKING-1.expected-red.json",
    "test/fixtures/booking-commitments.sql", "test/integration/module-runtime.test.ts", "test/postgres/booking-commitments.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts",
    "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [{"path":"packages/canonical-model/src/booking.ts","name":"bookingDeclarationProblem"},{"path":"packages/postgres-provider/src/booking-capability-executor.ts","name":"BookingCapabilityExecutor"}]
}
```
