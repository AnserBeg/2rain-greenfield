# ADR-0018: Temporal authority — effective time, recorded time, business day, and period lock

Date: 2026-07-26
Status: accepted (orchestrator ruling, user-authorized 2026-07-26; the implementing packet is
the G3 stage cut, which designs backdated postings and as-of balances against this contract)
Tier: Critical (review per `review-tiers` when implemented)

## Context

Plan §6.3 requires that "effective and recorded timestamps remain distinct" and §11.6 item 7
requires "policies for negative stock, backdated postings, closed periods if enabled". Both
are one-line obligations with no contract behind them, and `current-plan.md` carries temporal
semantics as an open plan-level decision due before G3.

Four separate questions hide in there, and three of them are cheap now and expensive later:

- what a backdated posting is allowed to do;
- what "a day" means for a tenant whose warehouses span three time zones;
- whether a closed period can be reopened, and what enforces the close; and
- whether the system can ever reproduce what a report said last Tuesday.

The last one is the trap. If read models key only on effective time, then the moment a
backdated movement arrives, every prior report becomes unreproducible — not wrong, but
unexplainable, which for an auditor is worse. Recovering that ability later requires
information that was never stored.

Recorded as **G6** in [`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md).

## Decision

### Two instants, never conflated

Every posted business fact carries both:

- `effectiveAt` — when the event is deemed to have happened in the business. Author-supplied
  within policy.
- `recordedAt` — when the system accepted it. Sourced from trusted request context, never
  from client input, never from a client clock, and consistent across every row committed in
  one transaction.

Neither substitutes for the other in any query, report, index, or agent answer. `recordedAt`
is never editable, including by correction: a correction appends a new fact with its own
`recordedAt`.

Per AGENTS.md §6, elapsed-time and deadline decisions continue to use a monotonic source.
This ADR governs business-meaning timestamps, not interval measurement, and the two must not
be interchanged.

### The ledger is bitemporally complete; reads are not, yet

Because every movement carries both instants and is append-only, the balance for any pair
`(as-of effective, as-of recorded)` is reconstructible from the ledger alone.

**This is a launch invariant, and it is the whole cost-of-delay item.** Concretely:

- no read model, projection, index, export, or reconciliation may discard, truncate, or
  overwrite `recordedAt`;
- no rebuild may collapse the two instants into one; and
- a materialized balance records the `recordedAt` horizon it was computed at, so it can
  state what it does and does not include.

Exposing bitemporal reads through the query tier — "show me on-hand as of March 31 as it was
known on April 5" — is a **later capability**, sequenced with Q1 and the N-stage reporting
work. Launch ships as-of-effective reads only. What launch may not do is throw away the
ability to add the other axis.

### The tenant owns the business day

Each tenant declares an IANA time zone and a business-day boundary. Day bucketing, "today",
period boundaries, and every date-grained report derive from that declaration.

They are never derived from server locale, process environment, database session, browser
locale, or the requesting user's device. A tenant operating across zones has one declared
business day; per-location calendars are a later capability, not an improvisation.

### Period lock is an enforced posting precondition

A tenant declares a `closedThrough` effective instant, scoped per legal entity
([ADR-0015](ADR-0015-legal-entity-business-dimension.md)).

- Posting any fact with `effectiveAt` at or before `closedThrough` fails closed with a typed
  precondition error naming the lock. It is enforced at the posting handler, inside the
  transaction — not by UI, not by policy, not by convention.
- Advancing the lock is a named, permissioned, audited operation.
- Reopening a period is a **separate named operation** with its own permission and audit
  record. It is never a side effect of advancing, and never an ordinary update.
- Launch may ship with the lock open. The concept, the column, the precondition, and its
  enforcement point exist regardless, because a precondition retrofitted onto a posting
  handler after there are postings cannot be proven against history.

### Backdating is bounded, recorded, and visible

Backdating is permitted only within a declared tenant policy window and never across a
closed period. Every backdated posting is identifiable as such from the fact itself — the
`effectiveAt`/`recordedAt` divergence — and surfaces in read-back and in the activity rail,
not only in an audit table.

### What this ADR does not decide

It does not adopt general bitemporality for non-inventory records, effective-dated master
data, per-location calendars, or business-calendar arithmetic (working days, holidays).
Those remain later capabilities. It decides only the temporal contract the inventory ledger
is built on, which is the part that cannot be changed afterwards.

## Consequences

- G3 designs as-of balances and backdated posting against a written contract rather than
  discovering the questions during implementation.
- Bitemporal reporting stays available as a future capability at the cost of one retained
  column and one prohibition, instead of being permanently foreclosed.
- Tenant timezone becomes a required provisioning input. A tenant cannot be created without
  a declared zone and day boundary; there is no default that silently means UTC.
- Period lock adds one precondition to every posting handler and one operation pair
  (advance, reopen) with distinct permissions.
- The prohibition on discarding `recordedAt` binds read-model authors from G3 onward,
  including projections written for performance reasons. It is a real constraint on the
  materialization work and is stated so it is designed for, not discovered.

## Evidence

- Plan §6.3 movement posting requirements, §6.4 invariants, §11.6 G3 build item 7 and gate
  ("backdated behavior is explicit and tested"), §14.3 property suite (backdated dates).
- ADR-0004 trusted request context — the source of `recordedAt`.
- ADR-0007 append-only posting: why `recordedAt` can never be edited.
- AGENTS.md §6 monotonic-time rule and the recorded WSL2 wall-clock defect, which is why
  business timestamps and elapsed-time sources are separated explicitly here.
- [`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md) **G6**.

## Enforcement

- Compiler: a compiled read model or reporting projection over posted facts that drops
  `recordedAt` fails closed. Date-grained projections lower against the tenant's declared
  zone, never a literal or ambient zone.
- Provider: `effectiveAt` and `recordedAt` are both `NOT NULL` on every posted fact;
  `recordedAt` has no update path.
- Posting handler: the period-lock precondition is evaluated inside the posting transaction,
  with a recorded negative control proving a locked-period post is rejected.
- Structural test: no business timestamp is sourced from `Date.now()`, database `now()`, or
  a client-supplied field outside the declared `effectiveAt` input.
- G3 gate: backdated posting, period-lock rejection, and reconstruction of a prior balance
  at a stated `recordedAt` horizon are all proven, with negative controls.
