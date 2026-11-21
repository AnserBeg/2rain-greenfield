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
Slice 1b merged at `d48c870bdf7cae3858a84e1dde6ea8125750e28d` on [exact full CI 44879121890](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44879121890). Migration 0059 and the Operation Catalog (6) and Query Catalog (5) reader floors kept their numbers. The regenerated schema snapshot was byte-identical, and the history scan passed with the two approved Gitleaks fingerprints.

## Slice 1b fix round · 2026-11-21

- **B1 reproduced** on merged 0059. The timer closed rental A at 11:00. Appointment B was booked at 11:05 and completed at 12:00. At 12:15 the unfixed writer admitted A’s 10:30 Start as `inUse`, revision 4. The fix returns `booking.capacityTaken`; A stays `noShow`, revision 3.
- **R1.** A successful recovery appends a void revision of the attendance outcome and opens use at one owner cursor. The old snapshot retains the absence; the next incremental page retracts it. Active attendance IDs remain available for outcome corrections.
- **R12.** Independent controls remove each company-scoped read permission, the swap destination company check, the stored correction-age check and the kit member company check. The age test voids an old closed pause without proposing new dates.
- **R3.** Historical occupation uses a resource index and the next booking revision, including a swap away. Kit expiry finds the original receipt through member booking IDs.
- **R4.** Kit expiry uses the caller’s decision and the highest locked member floor. Sweeping preserves any higher floor set while expiring the kit.
- **R5.** ADR-0082 requires a single fence call for all owners and places record locks before the fence.
- **R6.** Kit writers order new owner identities by entity and UUID. The insert-order test uses mixed-case input.
- **R7.** The booking facade maps SQLSTATE 40001 with `booking.endpointChanged` to `booking.tryAgain`. Other serialization failures propagate.
- **R9.** The first sweep or diary touch after 0059 closes overdue slice 1a confirmations under `acceptedBookingEnd`. Those confirmations predate that authority field. No production tenant existed at migration.
- **R11.** Slice 1b’s last executable commit was `30a0c46e`. Fable read packet tip `89e39a42` on [green tip CI 44871414335](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44871414335).

All seven new mutations failed at their named assertions on PostgreSQL 16; the restored writer tests passed. [Expected-red manifest](../../../test/evidence/BOOKING-1.expected-red.json) · [Full packet CI for the SQL at `a9c50c69`](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44883389027). Migration 0060 is provisional until the merge line assigns the number.
CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44883389027

## Test it yourself

With Docker running, execute `node --import tsx --test test/postgres/booking-commitments.test.ts`. The late Start in the gap must refuse; the owner snapshot and incremental page must agree on the recovered absence.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "BOOKING-1",
  "base": "630e2aa690906af9256c5964c398ba90585515d2", "head": "1953e6cab60a7595e24c3d4a7ff4b7f5be26e70e",
  "changedPaths": [
    "db/migrations/0060_booking_recovery.sql", "db/schema.snapshot.json",
    "test/architecture/release-persistence-boundary.test.ts", "test/evidence/BOOKING-1.expected-red.json",
    "test/fixtures/booking-commitments.sql", "test/postgres/booking-commitments.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": []
}
```
