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

## Test it yourself

Run `scripts/check-records.sh` and expect `records: OK`. Trace these cases in ADR-0082 before the executable slices.

- Hold today’s date-only room slot after opening. The agreement starts at the local boundary. Capacity starts at the decision instant. Another company sees the room busy and cannot see the meeting label.
- Six units of ten are booked 09:00–10:00 and six at 10:00–11:00. Four fit through both hours. If a hold expires while confirmation waits, the post-lock decision gives expiry priority at equality.
- Return two of six pool units, then correct a pause from yesterday. Under the published owner-usage contract the legs show six then four, the cursor advances, and the old pause remains auditable.
- Swap onto an occupied unit or fail the last kit slot. The transaction preserves every original claim. A scheduled room appointment completes without creating a possession leg.
