# ADR-0082. Book a resource over time

Amended 2026-11-20 after Fable approved the design with changes and rejected the original
consumer contract. Fable’s narrow re-read accepted the design with amendments A1–A10, incorporated below.

A dispatcher assigning a truck, a receptionist reserving a room and a planner reserving 12 units
from a pool need the same promise. Once a booking commits, another caller cannot claim the same
capacity for the same time. A versioned Tier B pack owns that promise. A customer chooses which
records to book and which business documents own the bookings. On the plan’s expansion ladder
the reusable pack is rung 6 and its protocol-dispatched Q2 Semantic Queries and O2 Semantic
Operations are rung 7. It supplies N3 availability and the resource allocation part of N4 scheduling. Workflow can arrange the visit. Parts issued on the visit still
go through Inventory. Booking a unit has zero stock, valuation or financial effect.
[Plan §§10.4, 10.6, 12.3, 12.6–7 and 12.12–13](../greenfield-north-star-erp-platform-plan.md)

## Which resource and whose booking

Any first-party or tenant record type, including a line type, can supply a resource. A declaration
binds its stable entity ID to a resource kind. **Unit** has capacity one. **Pool** measures
an exact quantity in a declared unit and scale. **Class** reserves demand for an eligible
member unit to be named later, such as any technician on a team. The registry and booking
fact distinguish the requested target from its assigned unit. A class derives its capacity
from its member units’ diaries. Direct unit bookings and unassigned class claims compete for
those same members. Before enabling class writes, prove a feasible distinct member assignment
for the entire interval of each outstanding claim, including on direct writes and membership
changes. Assign-unit converts the existing claim to one of those units atomically. Slice 1
reserves the class discriminator, membership references and optional assignment. Class
declarations, holds and Assign-unit refuse until that protocol ships. The compiler checks
record identity, ownership, liveness, read access and archive bindings for the selected type.
An adapter resolves the actual record under the pinned release. A caller cannot manufacture a
resource by sending a type name and UUID.

The pack gives each record one durable resource key under a unique constraint over tenant,
environment, entity, stored ownership scope and record ID. Use disjoint shared and company-owned
keys so a nullable company cannot admit duplicates. Releasing a new package, adding a second
booking form or rolling back resolves to the same key. A tenant-shared room has one diary across
the tenant, including when two companies book it. The company on the **owning business record**
controls access to the booking detail. Company-owned owners can use their own or shared resources.
Shared owners can use shared resources. The writer verifies both persisted endpoints and any line’s
parent in the transaction. Typed references retain referential and archive protection across release
changes. An active allocation prevents archiving either endpoint. Closed bookings retain their links.
The archive guard is integrity, not disclosure: it refuses whatever the archiving caller can see,
because that caller is already authorized for the record. Direct invocation of
`require_record_archivable` by the module runtime role reveals one bit within its tenant and
environment: whether an active allocation protects the named record.
[ADR-0015](ADR-0015-legal-entity-business-dimension.md) · [ADR-0072](ADR-0072-tenant-document-editing-and-links.md)

The pack publishes its typed configuration and exhaustive input/output dependency set. Mode and
quantity unit/scale are fixed after first use. Pool capacity is an effective-dated schedule.
Each row identifies its pool, half-open validity period, nonnegative exact total, revision and
authorizing receipt. An uncovered instant has capacity zero. The initial Set pool capacity
writes one open-ended row from the decision instant. A replacement closes the preceding
validity period in the current schedule and appends its successor, preserving both revisions.
V1 writes changes effective now. The row shape also supports future-dated changes. Effective periods for one pool cannot overlap.
Check commitments across every affected capacity boundary and outstanding possession before
accepting a decrease. Only the pack writes these rows. The declaration supplies a positive hold
lifetime with a pack default of 15 minutes and a maximum of 24 hours. A new configuration applies to new holds. Each fact
retains its capability version and configuration identity. A maintenance record blocks a unit
or pool using an ordinary booking. Opening hours and shifts are deferred. Availability reserves
the typed reason `outsideWorkingTime` (“outside working time”) for that future declaration.

Dependencies include endpoint identity, scope and liveness, calendar, resource mode/unit/capacity,
the owner binding and slot, group and assignment, booking revisions, allocations, actual-use legs,
pauses, expiry and the owner event cursor. The compiler resolves
these to facts, including indirect reads/writes through lines and relations. The domain package
can access storage only through a facade generated from the published set. The PostgreSQL
provider owns the SQL. Verify that undeclared access fails, and check minimality so a booking
cannot claim, for instance, the rate on its owning line. A business user may enter operation
arguments. Rules may narrow an operation with typed validations or guards and compute display
values. Generic CRUD, defaults, formulas, workflow code and imports have no write path to the
published booking facts. Use the ordinary rule truth tables, watched values, operand permissions
and locks. Admit an O2 rule binding with its own satisfying and refusing witnesses. Authorized
recovery makes tenant narrowing report-only under §10.6 and records its outcome. Capacity,
isolation, authority and audit checks still apply.
[Rule admission](ADR-0074-formula-rule-and-workflow-projection-admission.md) · [Literal validation](ADR-0075-literal-validation-and-ordered-comparison.md) · [Related operands](ADR-0076-cross-field-and-to-one-validation.md)

## Time, state and evidence

A booking revision identifies the booking, persisted owner (any record or line), requested
target kind and key, assigned unit when applicable, positive exact agreed quantity (one for a unit), quantity unit, fulfilment
mode, state and hold deadline. Persist the declared allocation slot on every fact. A grouped
fact also carries a stable group ID and typed group kind (initially `kit`). Both are absent
for a standalone booking. Preserve these identities across rescheduling, swaps and return.
A future series can add a group kind under a new protocol version.

Store the **agreed interval** and **occupied interval** separately. The agreement is what the
owner requested. Occupation is the finite planned claim on capacity. Both use **[start, end)**,
so a booking ending at 11:00 leaves 11:00 available. Initially they coincide for a future hold.
Agreed intervals of different bookings on one unit may overlap. Only occupied intervals are exclusive.
An early return releases remaining occupation and preserves the agreement. Store the entered
civil dates or times, IANA zone, offsets, calendar identity and boundary settings with the
resolved instants. Resolve each date-only boundary independently, including the exclusive end.
A calendar day can span 23 or 25 hours. Require a matching explicit offset in a repeated hour.
Refuse a missing calendar, nonexistent civil time, unresolved boundary or empty interval.

A date-only hold starting **today** keeps the agreed local day boundary and occupies capacity
from the writer’s decision instant through the agreed end. Refuse an already elapsed end.
Evaluate “today” as the entered civil date in the booking’s own calendar at the post-lock
decision instant. A hold that waits past local midnight refuses. Change interval moving a
date-only start onto today, or re-resolving one already past, clamps occupation the same way.
Other new holds require a future start or an explicit “start now”. Cap the hold deadline at
the occupied end. An existing booking keeps its resolved instants through calendar changes.

The owner binding declares one of two fulfilment modes and each booking pins it at creation.

- **Tracked possession.** Start opens a quantity-bearing actual-use leg. Return closes it.
  On partial return, close the previous pool leg and open one for the remaining quantity.
  Swap splits use and unit assignment at the transfer. Past the agreed end, open possession
  blocks a new start until recorded return. Existing later commitments remain visible if
  fulfilment is blocked. Count each quantity once across planned and physical occupation.
- **Elapses on schedule.** A confirmed appointment ends in `completed` at the agreed end.
  Confirmation authorizes that exact system transition through the same locked, idempotent
  mechanism as expiry. The attendance outcome records that the scheduled time elapsed. Evidence of physical presence or possession requires a separate observation. An authorized No-show records absence and releases
  remaining occupation. A tracked confirmation still unstarted at its end becomes `noShow`
  under the end condition accepted at confirmation. A late Start reopens that tracked booking
  under the normal locks and capacity check. Recovery checks historical occupation after the occupied end through the decision and voids the timed absence in the same transaction as the new use. Refuse with the stable diagnostic
  `booking.capacityTaken` if its capacity was taken meanwhile. For both modes, system work matches the
  current revision, mode and due end. A rescheduled booking cannot close on its old timer.

Start, Return, partial return, Swap, Pause and Resume accept an optional effective instant.
Default to the locked decision instant. Require finite effective time at or before recorded
time. The owner slot declaration carries `maxBackdateDays` (default one, selectable from zero
to 31) and each booking pins it. Count civil days in the owner’s calendar. N admits effective
instants from the start of the civil day N days before the recorded day. Zero means the same civil day. A reason is required for backdating. Check the
resulting timeline, unit assignments and quantities for consistency, including other recorded
use of that resource. For an effective time before this booking’s own occupied start, also
check other bookings’ historical occupied intervals on the resource, including completed
scheduled appointments without a leg. Refuse an impossible overlap. Live capacity changes at the recorded
decision, visible on commit. A return reported Tuesday as effective Monday never makes Monday’s
capacity available retroactively.

Correct-actuals appends a reasoned revision of a named leg, pause or attendance outcome,
including after closure. It identifies the superseded revision and the changed effective
boundaries. Require steward-level permission, a reason and a separately configured correction
age independent of `maxBackdateDays`, with no 31-day ceiling. Apply the timeline and overlap
checks and preserve the original
evidence and receipt. Correcting historical evidence grants no capacity and changes no live
assignment. A change to current possession requires the corresponding operational transition.
Record existing booking admits an already confirmed or in-use service at onboarding. A steward
presents the saved owner, a stable source key, evidence, original agreement and known actuals.
A reviewed import has an explicit finite earliest evidence date. Validate its historical legs
against existing evidence and admit all still-live occupation under the normal resource locks,
including an overdue open leg. Refuse conflicting evidence or capacity and retain the source
identity for retries. The pack’s operation is the sole import writer.

Every change appends a numbered event with its before/after values, effective and recorded times,
reason, actor, owner, release, capability/configuration identity and operation receipt. Splitting a
unit assignment on swap preserves both legs. Current booking, occupancy, event, change document,
outbox and idempotency receipt commit together. History can reconstruct the state at any revision.
Protect history against updates, deletion and truncation. Apply ADR-0062’s writer pattern.
Declare module write roots, derive reached relations from the compiled target and compare actual
writes to the executed row verifiers. Check the trust documents and receipt separately.
[Writer inventory](ADR-0062-the-writer-inventory-is-derived-from-the-compiled-target.md) · [Posting service](../../packages/postgres-provider/src/inventory-posting-service.ts)

## What each operation changes

| O2 operation | Admitted change | Risk and reason |
| --- | --- | --- |
| Hold | Allocate the occupied interval against a saved owner until the hold deadline. | `reversible`. Its inverse cancels exactly that still-held revision. Show the deadline and the cancellation action. |
| Confirm | A live hold becomes confirmed and keeps its allocation. | `needsYes`. It commits the resource beyond the hold deadline. |
| Start (out) | Tracked confirmation → in use. Admit effective start within the agreement and check physical capacity at the decision. | `needsYes`. Someone takes possession. |
| Return | Close tracked possession, release remaining allocation and preserve the agreed end. A partial pool return releases exactly the returned quantity and keeps the balance in use. | `needsYes`, including early return. Others can take the released capacity. |
| Change interval (reschedule, extend, shorten) | Move the start, end or both for a live hold or confirmation. For in-use work, revise the remaining term and keep the actual legs. Recheck the full replacement and cap an existing hold deadline at the new end. | `needsYes`. Show both intervals. A conflict leaves the original claim intact. |
| Change quantity | Replace a pool hold or confirmed quantity after checking every affected segment. During possession use partial return to reduce the amount actually out. | `needsYes`. Show old and new quantities. |
| Cancel | Hold or confirmed → cancelled. An in-use booking requires return. | `needsYes`. Capacity may be taken immediately. Choosing Undo on a hold authorizes cancellation of that exact revision. |
| Swap unit | Replace one serialized unit with a compatible unit admitted by the owner binding. For an in-use swap, split the effective legs at the transfer time and move the remaining live claim at the recorded decision. Check both unit diaries. | `needsYes`. Show both units. Either both sides commit or the original booking stands. |
| Pause / resume | Open or close a pause on an in-use booking at its effective time. Possession continues. Final return closes any open pause. | `needsYes`. A later consumer may rely on the recorded duration. |
| Set pool capacity | Append an effective-dated total under the pool lock. Record the prior total and reason. | `needsYes`. It changes the quantity people can promise. |
| No-show | Record absence on an unstarted confirmation at or after the scheduled start. Release its remaining occupation. An absence reported after scheduled completion uses Correct-actuals and retains the completion event. | `needsYes`. It changes the service evidence. |
| Correct-actuals | Append a correction to the identified revision of effective evidence, with reason. | `needsYes`. Previously consumed evidence can change. |
| Record existing booking | Admit a documented existing agreement or possession through the onboarding writer. | `needsYes`. Bind the source, historical evidence and occupied remainder to the review. |
| Assign-unit (reserved) | Select an eligible member for a class claim while preserving booking identity and total demand. | `needsYes` when admitted. It commits a named member. |

Returned, completed, no-show and cancelled bookings are closed to new allocations except for the late Start recovery above. Expiry is a system cancellation with reason
**hold expired**, effective at the stored deadline. At equality expiry wins. Cancel or expiry
cannot undo a subsequent confirmation. Independent retries use the original request key.

Use the Semantic Operation gateway for a person, assistant or workflow. Bind a required yes to the
exact arguments, booking revision, parties/resources, quantity, times, operation, release, scope
and active fence. Recheck current authority and locked state on execution. A changed plan needs a
new yes. The hold’s inverse describes its business risk. The current assistant asks before creates,
O2 calls and multi-step plans. A workflow needs a recorded human decision for **every** Tier B
write, including a hold or its cancellation. We accept that self-service and recurring workflow
holds require that human decision until N5 grants are admitted. Expiry, scheduled completion
and timed no-show derive only the authority to apply their recorded deadline and condition.
Scope exception: `platform.attest_booking_approval` is SECURITY DEFINER and records the issuer's
tenant, environment and principal arguments without trusted-context or company scoping. This is
safe because scope is enforced at consumption: the booking writer matches the grant on the trusted
tenant, environment and principal, then authorizes the owner's company.
[Plan §9.4](../greenfield-north-star-erp-platform-plan.md) · [ADR-0073](ADR-0073-workflow-isolate-and-authority.md#computed-inputs-to-tier-b)

## How PostgreSQL prevents double booking

**Planned commitments** cannot overlap on a unit or
exceed the effective capacity of a pool on any segment. **Actual possession** permits at most one
open leg per unit and at most the current capacity in open pool quantity. A unit due at 10:00
may still be out at 10:05. Its finite planned interval cannot protect the next physical handover.

1. Every database writer, including archive of an owner or resource, takes registry row locks
   (`SELECT ... FOR UPDATE`). One persistent row already identifies each diary and stores its
   time floor. Using it avoids a second advisory-key identity. Resolve all affected resources
   (including swap, group and due members), lock in ascending durable key order, then lock the
   request identity, then endpoint records and their ownership paths in this order: descendants before
   ancestors (longest ownership path to a root, descending), then entity and record ID. The generic
   module writer also locks a child before its parent. Its reads of non-ownership relation targets
   can take share locks in a different order. An idempotent request retries SQLSTATE 40P01 once. Recheck the discovered
   set, liveness, scope and revisions. Restart discovery if another resource lock would be
   needed. Owner-row locking also serializes a first booking with archive of an untouched owner.
   The database routine checks `current_setting('transaction_isolation') = 'read committed'`
   on entry and raises on any other setting. In a fresh SQL statement **after** the last lock
   it reads committed allocations and capacity, including the previous holder’s work. Runtime
   and worker roles can only invoke scoped routines. [PostgreSQL isolation](https://www.postgresql.org/docs/16/transaction-iso.html)
2. Sample PostgreSQL `clock_timestamp()` after lock waits and take the greatest of that sample
   and the affected resources’ persisted time floors. Advance the floors on commit. Keep a hold’s full occupied interval in the
   index until confirmation, release or expiry. Its deadline governs how long the claim lives.
   Transaction
   start time and an application clock can both precede a lock wait. Expiry wins at equality.
   Retire due holds with their own history and receipt before admitting new claims. A bounded
   sweeper uses the same transition and stable expiry key under the original hold’s authority.
   A caller triggering cleanup sees only its own outcome. Use a monotonic source for elapsed
   waits. Availability readers apply the same time-floor and deadline rule even when the sweeper is late.
   [PostgreSQL clocks](https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)
3. Use an **unpartitioned** current allocation table so one GiST exclusion constraint covers
   every unit claim. With a non-null, globally unique registry key, enforce
   `EXCLUDE USING gist (resource_key WITH =, occupied_interval WITH &&) WHERE (kind = 'unit')`.
   Constrain the kind to match the referenced registry row. Require `occupied_interval tstzrange
   NOT NULL` and the following database check. Apply the same finite half-open rule to agreements.
   Retain released claims in history. A conflict reports “no longer available” to the caller.

   ```sql
   CHECK (NOT isempty(occupied_interval)
          AND lower_inc(occupied_interval) AND NOT upper_inc(occupied_interval)
          AND NOT lower_inf(occupied_interval) AND NOT upper_inf(occupied_interval)
          AND isfinite(lower(occupied_interval)) AND isfinite(upper(occupied_interval)))
   ```

   Slice 1a provisions `btree_gist` for UUID equality alongside range overlap. In dev and CI,
   the database bootstrap/migration owner installs it with database CREATE privilege. In a
   managed environment, the database administrator enables the extension in the target
   database before the migration. Verify the required operator classes and constraint during
   migration and refuse if unavailable. Tenant, runtime, worker and materializer roles receive
   no extension-installation grant. [PostgreSQL btree_gist](https://www.postgresql.org/docs/16/btree-gist.html) · [Range constraints](https://www.postgresql.org/docs/16/rangetypes.html#RANGETYPES-CONSTRAINT)
4. Under a pool’s row lock, sweep allocation **and capacity** boundaries, starting with
   demand and capacity at the window start. Combine equal-time deltas and test each [start, end)
   segment. Apply all proposed rows together, excluding only the revisions they replace.
   Six units at 09:00–10:00 and six at 10:00–11:00 leave four throughout in a pool of ten.
   For physical possession, additionally enforce a unique partial index on unit key for current
   open legs. The locked writer checks total open pool quantity at each handover. Carry overdue
   open quantity forward for new admissions and queries until its recorded release. Count any
   quantity still covered by its own planned claim once. Preserve later admitted commitments
   during an overrun, show the shortfall and refuse a start that would exceed physical capacity.
5. A bounded group claims every slot in one transaction. A busy attachment leaves every member
   as it was. Members share an owner scope and group ID and carry distinct owner/slot identities.
   A unique live booking per (persisted owner, allocation slot) prevents a second hold for the
   same demand under a fresh key. A group hold has one deadline and confirms, cancels or expires as a group. For retries,
   authenticate and scope first, then compare actor, operation and canonical input with the stored
   receipt. An exact retry returns the original receipt even after later revisions. A reused key
   with different input refuses. Only a fresh mutation checks the expected current revision.

## What the picker, assistant and workflows may read

The released Q2 catalog declares the following bounded contracts. Forms, the assistant and the
release SDK call the same Semantic Query gateway. Each response carries its read instant, zone
and scope. It reports a snapshot. Only an admitted hold or confirmation promises capacity.

| Query | Inputs and result |
| --- | --- |
| Free or busy | One resource, window and requested quantity. Return free/busy segments and whether the quantity fits throughout. |
| Next available slot | One resource, earliest start, positive duration, quantity and search horizon. Return the earliest contiguous fit or “none within this horizon”. Distinguish elapsed duration from a count of business-calendar days. |
| Free units of a type | Declared unit type and window. Return only authorized units free throughout, in stable record-key order with a bounded page and continuation. |
| Pool remaining capacity | Pool and window. Return the minimum remaining quantity across the window in its unit, plus the segments and their remaining quantities. An overdue shortfall yields zero available with a conflict indication. |
| `booking.resourceWindow/v1` | Bounded resource keys and [start, end). Select busy by occupied-or-overdue span. For hidden commitments return coalesced anonymous busy spans. Select permitted bars by agreed-or-occupied intersection. In stable resource/time/key order return booking ID, current revision, state, fulfilment mode, separate agreed and occupied intervals, quantity and permitted owner links and labels. |
| Group availability | Bounded slots with eligible resources, quantities and one window. Return whether the entire group fits together, including combined demand on a repeated pool and distinct assignments for simultaneous unit slots. A bounded search that cannot decide returns a limit. |
| Count free by type | Unit type and window. Count authorized distinct units free for the entire window, across all matching pages. An incomplete scan returns a limit instead of a partial count. |

The provider uses the writer’s interval and capacity calculation and the same expiry floor.
Each answer uses one SQL statement or a read-only REPEATABLE READ transaction, with one
captured decision instant. Continuations identify the same snapshot or require a restart.
Bound horizon, page size, scanned candidates and returned segments. Return
a named limit or continuation on exhaustion so a partial search cannot claim there is no slot.
Require permission to see both the resource and its availability. Compute occupancy over **all**
its bookings, including another company’s use of a shared resource. Expose only permitted labels
and availability. Reading an owner, booking details or history requires separate scope and record
checks. A workflow journals the authorized result. Dispatch checks again at write time.

## Published read and event contracts

**`booking.ownerUsage/v1`** is the Q2 source for period and usage billing. Key it by tenant,
environment, stored owner scope, owner entity and record ID (the line’s ID when it owns the
booking). The contract also works for a standalone appointment. Require owner-detail and
complete service-evidence permission. Read one consistent snapshot, including closed and
corrected bookings. Return its as-of instant and owner cursor. At that cursor the following
fields are reconstructible, including when the change concerns an already billed period.
Report persisted state only. A due expiry, scheduled completion or timed no-show appears
when its transition commits and advances the cursor. The same cursor always names the same evidence.

| Projection field | Meaning |
| --- | --- |
| Bookings | Stable booking/service and slot IDs, group ID/kind, state, fulfilment mode, requested target, agreed interval with its calendar, separate occupied interval, and agreed exact quantity/unit. Include dated revisions of agreed terms and quantities. A swap preserves the service ID. Only occupied intervals are exclusive on a unit. No consumer may infer exclusivity from agreed intervals. |
| Actual-use legs | Leg ID and revision, booking ID, target, effective start and optional end, exact quantity and unit, recorded time and superseded revision. A partial return splits the legs so each quantity applies to a known interval. A scheduled completion has no possession leg. |
| Unit-assignment legs | Stable leg ID and revision, booking ID, assigned unit key and effective bounds. A swap ends one assignment and starts the next at the same instant. |
| Pauses | First-class, booking-scoped rows with pause ID, revision, booking ID, effective start and nullable end, typed neutral reason (v1 `operatorRequested` or `serviceInterrupted`), effective-at and recorded-at instants. Resume closes the open pause. Correct-actuals supersedes or voids an identified pause revision with an audit reason. Preserve each previous version. |
| Attendance outcomes (`attendance`) | Stable evidence ID and revision, booking ID, outcome in `reason` (`completed` or `noShow`), effective and recorded times, superseded revision and `voided`. A steward corrects an outcome by its evidence ID. Recovering a timed absence removes it from the current snapshot and delivers its voided revision with the new use on the same incremental cursor. |

The projection returns complete evidence for the requested owner and horizon, or a typed
refusal for insufficient permission or size. An open end is explicit. Billing may clip at
the snapshot’s as-of instant. For incremental reads, `afterCursor` returns the ordered changes
for that owner through a pinned high-water cursor, including old and new effective bounds
and superseded or voided IDs. Paginate changes without advancing beyond the last delivered cursor.
Advance the durable owner cursor under the owner lock **in the transaction** for every change to
its bookings or child evidence. A group transaction advances each affected owner once, listing
all its changes. A rolled-back writer cannot publish a cursor. A late correction therefore appears
after the consumer’s checkpoint even when both effective dates precede it. The published dependency set includes the pack routine `booking.ownerCursorFence/v1`.
Through the generated facade it locks the listed owners in stable owner order, returns their
current cursors and holds the locks to commit. Pass every owner needed by the transaction in one fence call. Acquire any owner or resource record locks before calling the fence. Billing compares each cursor before consuming its snapshot. A mismatch needs a
fresh read. Booking gives pauses, quantities and intervals no money meaning. BILLING-1 owns the
choice of basis, rates, accrual and financial corrections. [BILLING-1 source contract](ADR-0083-period-and-usage-billing.md#which-service-is-billable)

Every `/v1` contract here is closed. Fields, states, pause reasons, group kinds and target
kinds are fixed. Any addition requires a new version. Serve v1 while any active tenant release pins it.

**Outbox v1.** Use the trust outbox envelope and its linked immutable domain event. One accepted
booking operation emits `eventType = booking.changed`, `eventSchemaVersion = booking.changed/v1`.
The envelope supplies identity and provenance. The linked payload has these required fields,
encoded with the trust substrate’s field classifications. Deliver it only to a subscriber
authorized for every referenced owner.

| Field | Type and meaning |
| --- | --- |
| Envelope | Stable event ID and deduplication key, tenant/environment, release, invocation/receipt and change-document references, recorded-at UTC instant. Exact retries identify the same event. |
| `operation`, `effectiveAt`, `ownerScope` | Stable released operation ID or system transition (`expireHold`, `completeScheduled`, `markNoShow`), UTC timestamp, and a tagged shared or company scope with company ID when applicable. |
| `owners[]` | Each entry has `ownerRef` (entity ID and record ID), `previousCursor`, `cursor` (nonnegative integers encoded as decimal strings, starting at zero before first use), and `bookings[]` (booking ID and positive integer revision). Each affected owner appears once. Resolve corrected legs and effective windows through the projection. |

Set pool capacity emits `booking.capacityChanged` with schema `booking.capacityChanged/v1`,
the same envelope, `resourceKey`, `capacityRevision`, `validFrom` and nullable `validTo`. It does not advance a service cursor.
The outbox, evidence and cursors commit together. Delivery can repeat or arrive out of order.
Consumers deduplicate by event ID, refetch from the last applied owner cursor on gaps, and advance
their checkpoint with the consumed result. An event grants no right to read a booking. UI-COMPOSE
can render the resource-window query. A dispatch plug-in can use that query and propose a change
through a governed operation. [Trust event and outbox contracts](../../packages/platform-runtime/src/trust/contracts.ts)

## How a business user composes it

In **Customize**, choose a record type, choose **Make bookable**, then choose **One unit** or
**Pool**. For a pool specify its unit and precision. On the owning document, choose **Add booking
line**, name the slot, choose its allowed targets and fulfilment mode. An ordinary record
can own the same slot without a line. Two add-only patch members record those choices.

| Member | Versioned declaration |
| --- | --- |
| `addBookableResourceRevision` | Stable declaration ID, entity ID, resource kind, quantity unit/scale where applicable and typed configuration. |
| `addBookingSlotRevision` | Stable binding and allocation slot IDs, typed owner, fulfilment mode, `maxBackdateDays`, allowed target alternatives, picker queries, O2 actions and their typed arguments. Each alternative pins a target declaration and contract revision in `booking.slotTarget/v1`. Its alternatives are unit type (select a unit), pool (select a pool and quantity), or class (defer member selection until assigned). |

**Both** members carry their own `schemaVersion`, stable revision ID, predecessor (null only
on creation) and status (`active` or `retired`). Append revisions against the current head.
Retirement prevents new claims through the retired binding. Existing bookings keep their
pinned declarations and an authorized path to fulfil or close them. Retain IDs and predecessor
chains for replay. Order types before declarations and declarations before slots. Refuse stale
predecessors, unresolved targets, incompatible units, cross-scope bindings, class alternatives
before admission, or attempts to assign risk or state. A slot can offer a unit or a bulk pool
on the same form.

The generated picker collects dates and quantity as **operation arguments**. Save the owner,
then invoke Hold with those arguments and the selected target. From that point on the line,
form, assistant and document templates read dates and quantity through read-only booking
projections. A booking slot supplies no tenant storage fields or writable copies for those
values. After Change interval, the line and its next document render show the revised term.
Searching, selecting and ordinary save leave capacity untouched. If a concurrent hold wins, keep the person’s
entries, show the conflict at the picker and refresh its alternatives. A line that saved before
a failed hold can retry with its persisted identity. Review and confirm from the same form. The
record page and assistant show the same status, actions and receipts.
[CUSTOMIZE-4](../execution/packets/CUSTOMIZE-4.md) · [CUSTOMIZE-3](../execution/packets/CUSTOMIZE-3.md) · [Surface composition](ADR-0079-form-and-record-composition.md)

“Equipment rental with units and daily rates” produces one draft containing the unit type, contract,
owned lines, typed rate field and booking bindings. A room request produces a room and meeting
record through the same members. The visual builder and AI drafter show the same plain diff,
compile and verify one candidate, and require an authorized approval before activation. The rate
is ordinary business data. A charge requires a future billing operation.

The plan’s domain ladder describes what can be composed. The release **reader floor**
describes which binary can safely serve it. Make bookable raises the mandatory **Operation
catalog reader floor**, even for an entity declaration with no picker or Surface. The writer
and archive protection must be understood before that release can serve any request. The
picker/slot presentation also raises the mandatory **Surface manifest reader floor**. Gate
the patch vocabulary in the parser and check that each declaration emits exactly its required floors and Q2/O2 bindings, and that
each emitted floor or binding has a declaration that requires it. A release advertises the maximum required on each mandatory
catalog. Each declaring capability takes the next free rung for its reader on fetched main
**at executable merge**. Regenerate artifacts and tests, run CI and re-fetch before push.
Renumber if someone lands first. This amendment allocates no reader rung or migration.

Prove actual preceding-reader refusal separately for an entity-only release, the picker and a
mixed release. Missing bindings and understated floors refuse. Omitted features reproduce the
prior release bytes and root through the tenant runners. An incompatible target on patch
replay identifies the offending member and keeps the serving release. Deployments support the
highest patch-parser and reader floors already used by any tenant, including after rollback.

Rollback restores the earlier release’s controls. Bookings, expiry deadlines, endpoint protections
and history survive. If the target lacks the binding, show outstanding commitments in the rollback
impact diff. The platform keeps authorized deadline transitions running. For further user changes,
reactivate a verified release with the same binding and reauthorize at the new fence. Prove that a reintroduced resource
cannot acquire a second diary or silently lose an in-use booking.

## Build slices after the design ruling

- **1a — Hold and change a commitment.** Ship the unit/pool registry, dated capacity, fact,
  history, writer, receipts and committed event cursors for hold, confirm, cancel, expiry
  and Change interval. Emit `booking.changed/v1` exactly as published from owner cursor zero. Race independent PostgreSQL sessions at a barrier on the same shared
  unit across companies, the last pool quantity, capacity decrease versus hold, and reschedule
  versus a competing hold. Test adjacent ranges, forbidden range bounds, non-READ-COMMITTED
  refusal, a forged owner, a lost reply and confirmation that waited past expiry. Inspect
  actual committed rows, receipts and events on both connections. Inject a database clock in
  the test harness for expiry equality and backward steps.
- **1b — Fulfil and account for use.** Ship start, full and partial return, Change quantity,
  swap, pause/resume, groups, scheduled completion, no-show, onboarding and Correct-actuals.
  Deliver the owner-usage projection and cursor fence over the event shape shipped in 1a. Race overdue and second starts,
  opposing swaps, archive versus hold and return versus reschedule. Fail the last group member
  and verify all original revisions. Check late and early returns, historical overlap refusal,
  corrected pauses after billing has checkpointed, and one grouped transaction advancing two
  owners’ cursors. Prove a stale timer cannot complete a moved appointment. Class assignment
  is reserved for a later capability.
- **2 — Find a slot on a form.** Ship the seven scheduling Q2 contracts and picker. Compare
  the read with admission from the same state. Cover DST, today’s date-only start, overlapping
  pool and kit demand, count across pages, hidden owners, overdue possession and a pick lost
  to a concurrent hold.
- **3 — Compose in Customize or by asking.** Ship the two revisable patch members, grouped
  draft, plain diff, candidate verification, approval, activation and rollback. Test first-party
  and tenant types, failed rule bindings, entity-only reader refusal, retirement and replay,
  and the projection of a revised booking term into its owning line.
- **4 — Generate two working modules from empty tenant configurations.** Proof A builds a
  rental contract with a serialized unit line, a bulk pool line and a kit group. Through the
  normal UI and assistant, hold the kit atomically, confirm, swap its unit and partially return
  the bulk quantity. Verify both actual quantities and the group’s unchanged identity. Proof B
  builds a room appointment owned by a standalone meeting record, shared room, timed slots
  and scheduled fulfilment. Book from company A, see busy without the meeting label from
  company B, reschedule and let the meeting complete without possession. Exercise the same
  query/approval gateway from a workflow. Inspect the generated bindings and check for any
  booking- or example-specific branches outside the pack and its registered generic bindings.
