# BOOKING-1 — book a resource over time

Fable accepted [ADR-0082](../../decisions/ADR-0082-booking-over-time.md) with amendments A1–A10. A1–A3 govern commitment, A4–A7 and A9–A10 govern fulfilment. Availability and CALENDAR-1 depend on A8. Billing depends on A9–A10. ADR-0087 A3 leaves a follow-up to reconcile unresolved date-only booking boundaries with ADR-0083 A1 for system-derived boundaries.

## Checkpoints

| Slice | Outcome |
| --- | --- |
| 0 | The design passed [CI 44669525076](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44669525076). |
| 1a | Released unit and pool holds, confirmation, cancellation, expiry, rescheduling, typed events and owner cursors. |
| 1b | Tracked possession, pool quantity changes, swaps, pauses, groups, scheduled completion, no-show, corrections and reviewed import. Owner usage and its transaction fence support Billing. |
| 2 | Seven scheduling queries and the availability picker. The calendar follow-ups cover collection windows, complete occupancy, typed bars, continuation, member rescheduling and batched pools. |
| 3 | Customize and the drafter compose both bindings. Exercise activation, retirement, rollback and projected line terms. |
| 4 | Generate a rental contract and standalone appointment across two companies through the generic bindings. |

## Slice 1a

Unit exclusion, effective-dated pool capacity, date-only clamping and deadline equality passed [packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773309215). The shared-resource race and a rejected reschedule preserve the winning claim.
Approval checks bind the principal, input and active fence. Workflow holds need an attested human grant. Expiry uses its own system receipt keyspace. Both tenant runners reproduce the pre-booking application release.
The follow-up checks authorized archive against every active allocation and locks ownership descendants before ancestors. [Follow-up CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44814536083)

## Slice 1b

1. Tracked starts, full and partial returns, swaps, pauses and resumes append dated evidence. Pool admissions account for outstanding possession after the agreed end.
2. Manual absence, scheduled completion and timed tracked absence use the stored booking state. The timer matches the current revision and due end. Reporting changes only after commit.
3. Correct-actuals requires a distinct steward permission, reason and correction age. A revision after billing has checkpointed preserves the original evidence and reaches the next incremental page.
4. Reviewed onboarding validates a stable source key, finite earliest evidence time, historical legs and live capacity under the diary locks.
5. A kit shares a deadline, confirms, cancels and expires together. One event identifies every changed booking and advances each affected owner once.
6. The Q2 owner-usage query requires owner detail and service-evidence access. Historical reads name a high-water cursor. Billing can lock a zero or existing owner cursor through its own commit.
7. The request path retries one rolled-back SQLSTATE 40P01. The lock-order claim covers ownership paths. The authorized archive check can disclose one allocation bit to the module runtime role. [Archived finding](../current-plan-archive.md)

## Controls and gate

Kit-member rescheduling is a slice 2 decision in the pending-items charter. Slice 1b accepts kit holds, confirmation, cancellation and expiry.
The [mutation manifest](../../../test/evidence/BOOKING-1.expected-red.json) names the guard and the observable change in its regression.
The preceding production reader answered a baseline item query and refused the released Operation and Query catalog floors independently by name. This slice introduces released bindings. The two Customize members and their drafter evals belong to slice 3.
Slice 1b merged at `d48c870bdf7cae3858a84e1dde6ea8125750e28d` on exact full CI. Migration 0059 and the Operation Catalog (6) and Query Catalog (5) reader floors kept their numbers. The regenerated schema snapshot was byte-identical, and the history scan passed with the two approved Gitleaks fingerprints.
CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44879121890

## Test it yourself

Run `node --import tsx --test test/postgres/booking-commitments.test.ts` with Docker. Inspect the kit rollback, late correction and zero-cursor cases. Run `CI=1 node --import tsx --test test/postgres/booking-serving.test.ts` for the production query and archived reader.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "BOOKING-1",
  "base": "0a9f7ca52304969c65092893f50375c90f8c2265", "head": "30a0c46e81b6887bc6febafe0d054dcc3d6654c7",
  "changedPaths": [
    ".gitleaksignore", "db/migrations/0059_booking_fulfilment.sql", "db/schema.snapshot.json", "packages/canonical-model/src/booking.ts",
    "packages/canonical-model/src/schemas.ts", "packages/compiler/src/compiler.ts", "packages/compiler/src/projections.ts", "packages/postgres-provider/package.json",
    "packages/postgres-provider/src/booking-capability-executor.ts", "packages/postgres-provider/src/booking-owner-usage.ts", "packages/postgres-provider/src/release-repository.ts", "packages/postgres-provider/src/release-verification-service.ts",
    "packages/postgres-provider/src/request-context.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/postgres-provider/src/serving-gateways.ts", "packages/postgres-provider/src/trust/postgres-trust-service.ts",
    "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-query-gateway.ts", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/repository-hygiene.test.ts",
    "test/architecture/tenant-completeness.manifest.json", "test/architecture/tenant-completeness.test.ts", "test/evidence/BOOKING-1.expected-red.json", "test/fixtures/booking-commitments.sql",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/postgres/booking-commitments.test.ts", "test/postgres/booking-serving.test.ts", "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts", "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [{"path":"packages/canonical-model/src/booking.ts","name":"bookingDeclarationProblem"},{"path":"packages/postgres-provider/src/booking-owner-usage.ts","name":"bookingOwnerCursorFence"}]
}
```
