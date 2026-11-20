# BOOKING-1 — book a resource over time

Slice 0 proposes [ADR-0082](../../decisions/ADR-0082-booking-over-time.md).
The orchestrator’s Fable ruling gates implementation. This slice changes documentation only.

## Design decisions

1. Any first-party or tenant record can supply the resource or own a booking. A shared room has one schedule across companies. The booking owner determines access to its details.
2. The Tier B pack owns capacity and booking history. Unit intervals exclude overlap in PostgreSQL. Pool writers lock one resource and check demand at each change in the window.
3. Hold is reversible until confirmation or expiry. Confirm, change of term, transfer of possession and capacity changes need a yes. Workflows require exact human approval even for a hold.
4. The availability picker, assistant and workflow read the same four Q2 queries. A selected slot becomes a commitment only through a successful O2 write.
5. Customize and its AI drafter bind types, lines, queries and operations in one approved change set. Each executable capability takes its reader rung at merge. This proposal allocates no rung or migration.

## Checkpoints

| Slice | Outcome and gate |
| --- | --- |
| 0 | Docs-only proposal and record check. Stop for the orchestrator’s Fable read. |
| 1 | Resource, booking, operations and history. Inspect both transactions’ committed effects in database races. |
| 2 | Four availability queries and picker. Verify visible capacity, owner privacy and a pick lost to another caller. |
| 3 | Customize and AI drafting. Prove approval, activation, prior-reader refusal and rollback with live bookings. |
| 4 | Publish an equipment contract and a room reservation from customization alone. Exercise both through the same compiled bindings. |

## Test it yourself

Run `scripts/check-records.sh` from the repository root and expect `records: OK`. For the design read, open ADR-0082 and trace these cases.

- Companies A and B each try to hold the same shared room at 10:00. Only one hold can commit. The other company can see that the room is busy without learning who booked it.
- Six units of a ten-unit pool are booked 09:00–10:00, and six are booked 10:00–11:00. A request for four fits across both hours. A fifth unit would exceed capacity.
- A hold expires while confirmation waits on the resource lock. The writer checks the time after obtaining the lock. At the deadline the hold can no longer be confirmed.
- A swap finds the replacement occupied. The original assignment and booking revision survive. A later successful swap preserves the history of both units.
