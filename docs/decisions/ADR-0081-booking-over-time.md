# ADR-0081. Book a resource over time

Proposed on 2026-11-20 for the orchestrator’s Fable read. The four build slices require its ruling.

A dispatcher assigning a truck, a receptionist reserving a room and a planner reserving 12 units
from a pool need the same promise. Once a booking commits, another caller cannot claim the same
capacity for the same time. A versioned Tier B pack owns that promise. A customer chooses which
records to book and which business documents own the bookings. This is a rung 6 domain pack with
Q2 Semantic Queries and O2 Semantic Operations. It supplies N3 availability and the resource
allocation part of N4 scheduling. Workflow can arrange the visit. Parts issued on the visit still
go through Inventory. Booking a unit has zero stock, valuation or financial effect.
[Plan §§10.4, 10.6, 12.3, 12.6–7 and 12.12–13](../greenfield-north-star-erp-platform-plan.md)

## Which resource and whose booking

Any first-party or tenant record type, including a line type, can supply a resource. A declaration
binds its stable entity ID to **one unit** (capacity one) or **pool** (an exact count in a declared
unit and scale). A room, technician and vehicle each use the first mode. The compiler checks
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
[ADR-0015](ADR-0015-legal-entity-business-dimension.md) · [ADR-0072](ADR-0072-tenant-document-editing-and-links.md)

The pack publishes its typed configuration and exhaustive input/output dependency set. Mode and
quantity unit/scale are fixed after first use. Pool capacity starts at zero. An authorized steward
sets a nonnegative representable capacity through a reviewed O2 operation, effective on commit.
A decrease must cover every outstanding commitment and quantity in use. A tenant field edit cannot
change the total. The declaration supplies a positive, bounded hold lifetime with a pack default
of 15 minutes and a maximum of 24 hours. A new configuration applies to new holds. Each fact
retains its capability version and configuration identity.

Dependencies include endpoint identity, scope and liveness, calendar, resource mode/unit/capacity,
the owner binding, booking revisions, allocations, actual use and expiry. The compiler resolves
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

A booking carries its stable ID and revision, typed owner reference (any persisted business record
or line), resource key, positive exact quantity (one for a unit), scheduled start and end, state,
and an absolute deadline while held. Every allocation occupies **[start, end)**. Both instants
must be finite and start must precede end. A booking ending at 11:00 leaves 11:00 available.
New holds start at or after the writer’s decision instant. A “start now” request resolves there.
Cap the hold deadline at the scheduled end so a wholly elapsed reservation cannot be confirmed.
Persist the instants with the entered civil values, IANA zone, resolved offsets and the tenant
business calendar settings used. A date-only range runs from the first business date’s local day
boundary to the exclusive end date’s local boundary. Resolve each boundary separately. A calendar
day can span 23 or 25 hours. Timed inputs in a repeated hour require an explicit matching offset.
Reject a nonexistent time, an unresolved calendar boundary or a missing calendar with an actionable
error. Preserve the resolved interval when calendars change. The business calendar defines dates
and boundaries. Opening hours and blackout rules require explicit declarations.

Keep the **agreed interval** and the **actual use interval** separately. Start records possession,
and return ends it at the writer’s observed time. A late return keeps the observed time even if
the next booking was due. It leaves the next commitment visible for the operator to resolve.
Start must fit the planned interval and the resource’s *current* physical capacity. An overdue
unit stays busy for new requests until returned. For a pool, subtract overdue quantity from
future availability until it comes back. Count each in-use quantity only once. A pause/resume pair annotates actual
use while possession and capacity consumption continue. Return closes an open pause.

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
| Hold | Create a hold against a saved owner and allocate the full requested interval until the deadline. | `reversible`. Its inverse cancels exactly that still-held revision. Show the deadline and the cancellation action. |
| Confirm | A live hold becomes confirmed and keeps its allocation. | `needsYes`. It commits the resource beyond the hold deadline. |
| Start (out) | Confirmed → in use. Record the actual start after checking scheduled and physical capacity. | `needsYes`. Someone takes possession. |
| Return | In use → returned. Record actual return, release any remaining allocation immediately and preserve the agreed end. | `needsYes`, including early return. Others can take the released capacity. |
| Extend / shorten | Replace the end on a live hold, confirmed or in-use booking with a future end. A hold expires at the earlier of its existing deadline and its new end. | `needsYes`. Show the old and new ends and affected quantity. A refused extension preserves the old end. |
| Cancel | Hold or confirmed → cancelled. An in-use booking requires return. | `needsYes`. Capacity may be taken immediately. Choosing Undo on a hold authorizes cancellation of that exact revision. |
| Swap unit | Replace one serialized unit with a compatible unit admitted by the owner binding. For in-use swaps, transfer possession and the remaining allocation at the same instant within the agreed interval. | `needsYes`. Show both units. Either both sides commit or the original booking stands. |
| Pause / resume | Open or close one pause on an in-use booking at the observed time. | `needsYes`. A later consumer may rely on the recorded duration. |
| Set pool capacity | Set the steward-entered total under the resource lock. Record the prior total and reason. | `needsYes`. It changes the quantity people can promise. |

Returned and cancelled bookings are terminal. Expiry is a system cancellation with reason
**hold expired**, effective at the stored deadline. At equality expiry wins. Cancel or expiry
cannot undo a subsequent confirmation. Independent retries use the original request key.

Use the Semantic Operation gateway for a person, assistant or workflow. Bind a required yes to the
exact arguments, booking revision, parties/resources, quantity, times, operation, release, scope
and active fence. Recheck current authority and locked state on execution. A changed plan needs a
new yes. The hold’s inverse describes its business risk. The current assistant asks before creates,
O2 calls and multi-step plans. A workflow needs a recorded human decision for **every** Tier B
write, including a hold or its cancellation. System expiry carries only the authority to apply a
deadline already established by the hold operation.
[Plan §9.4](../greenfield-north-star-erp-platform-plan.md) · [ADR-0073](ADR-0073-workflow-isolate-and-authority.md#computed-inputs-to-tier-b)

## How PostgreSQL prevents double booking

1. Resolve durable resource keys. Lock the resource registry rows in ascending key order,
   including both ends of a swap and every member of an explicitly grouped request. Next lock
   the request key and affected records in stable order, verify stored scope and recheck that the
   keys/revisions still match. At READ COMMITTED, read the protected data in a **new statement
   after obtaining the locks**, so it includes a preceding holder’s commit. Require this
   isolation contract in the database writer. The application and worker roles have no direct
   table writes. Only the scoped database routines can change allocations or capacity.
2. Sample the trusted decision instant after waiting. Use a per-resource persisted time floor to
   prevent a backward clock step from reviving a hold or reversing actual-use events. Expiry,
   confirm and new admissions serialize on the same key. Retire due holds with their history
   before checking conflicts. A bounded sweeper uses the same internal transition and a stable
   expiry key. It derives expiry authority from the original hold, including when another company
   triggers cleanup of a shared resource. Cleanup discloses no owner data. Use absolute instants
   for durable deadlines and a monotonic source for elapsed waits. Queries apply the same deadline
   at their read instant even if the sweeper is late.
   The exclusion index depends only on stored occupation. A hold’s TTL does not shorten its
   scheduled interval. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html)
3. For serialized units the current allocations have non-null resource keys and nonempty
   `tstzrange` intervals. Install a GiST exclusion constraint equivalent to
   `EXCLUDE USING gist (resource_key WITH =, occupied_interval WITH &&)` using `btree_gist`.
   Bind unit/pool storage to the registry’s immutable mode. The database also admits at most
   one open actual-use leg per unit. Release ends occupation and retains the evidence in history.
   Translate a conflict to “no longer available” without disclosing its owner.
   [PostgreSQL range constraints](https://www.postgresql.org/docs/16/rangetypes.html#RANGETYPES-CONSTRAINT)
4. For a pool the database routine sweeps endpoints of overlapping allocations under that
   pool’s lock. Include demand already present at the window start, group all changes at each
   instant, and compute simultaneous demand on each half-open segment. Apply proposed rows
   together and exclude only the revisions being replaced. Reject any segment over capacity.
   Check open possession under the same lock on start, swap or capacity change. Existing
   commitments stay visible if a late return reduces what can now be fulfilled. Refuse any new
   commitment that cannot fit. For example, in a pool of ten, six used 09:00–10:00 and six
   used 10:00–11:00 leave four available throughout 09:00–11:00.
5. A kit can request a bounded group of ordinary allocations. A hold or other group operation
   checks all affected members in one transaction. A busy attachment leaves every member as it
   was. Bind a unique live allocation to each owner line and declared allocation slot so that a
   repeated hold under a fresh key cannot silently reserve the same demand twice. At retry,
   authenticate and scope first, then match the receipt’s actor, operation and canonical input
   digest. An exact retry returns the original receipt, even after a later revision. A changed
   payload under the key refuses. Only fresh work must match the expected current revision.

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

The provider uses the writer’s interval and capacity calculation, a single database snapshot and
the same expiry floor. Bound horizon, page size, scanned candidates and returned segments. Return
a named limit or continuation on exhaustion so a partial search cannot claim there is no slot.
Require permission to see both the resource and its availability. Compute occupancy over **all**
its bookings, including another company’s use of a shared resource. Expose only permitted labels
and availability. Reading an owner, booking details or history requires separate scope and record
checks. A workflow journals the authorized result. Dispatch checks again at write time.

## How a business user composes it

In **Customize**, choose a record type, choose **Make bookable**, then choose **One unit** or
**Pool**. For a pool specify its unit and precision. On the owning document, choose **Add booking
line**, select its resource type and name the line. These are two typed, add-only patch members
in the existing ordered change set. The first binds bookability to an entity. The second binds an
owner (document, line or ordinary record), resource type, allocation slot, picker queries, actions
and their declared arguments. Newly created types precede their bindings. Reject unresolved or
duplicate bindings, illicit scope combinations and attempts to assign risk or a booking status.

The generated form places the availability picker in the declared input or line slot. Enter dates
and quantity, select a free resource, save the owner and invoke Hold. Searching, selecting and
ordinary document save leave capacity untouched. If a concurrent hold wins, keep the person’s
entries, show the conflict at the picker and refresh its alternatives. A line that saved before
a failed hold can retry with its persisted identity. Review and confirm from the same form. The
record page and assistant show the same status, actions and receipts.
[CUSTOMIZE-4](../execution/packets/CUSTOMIZE-4.md) · [CUSTOMIZE-3](../execution/packets/CUSTOMIZE-3.md) · [Surface composition](ADR-0079-form-and-record-composition.md)

“Equipment rental with units and daily rates” produces one draft containing the unit type, contract,
owned lines, typed rate field and booking bindings. A room request produces a room and meeting
record through the same members. The visual builder and AI drafter show the same plain diff,
compile and verify one candidate, and require an authorized approval before activation. The rate
is ordinary business data. A charge requires a future billing operation.

Emit optional declarations only when used. Verify the exact protocol bindings and minimum reader
on every consuming catalog in both directions. Each new capability that older readers must refuse
takes the next scalar surface rung on fetched main **when its executable slice merges**. Regenerate
artifacts and tests, run CI and re-fetch before push. Renumber if main moved first. Exercise a
real preceding reader’s refusal and byte-identical omitted-feature release replay through the
tenant runners. A deployment must support the newest parser and reader floors already used by any
tenant, including after pointer rollback. Replaying a patch whose target changed incompatibly
refuses with the offending member and keeps the serving release.

Rollback restores the earlier release’s controls. Bookings, expiry deadlines, endpoint protections
and history survive. If the target lacks the binding, show outstanding commitments in the rollback
impact diff. The platform keeps expiry running. For further user changes, reactivate a verified
release with the same binding and reauthorize at the new fence. Prove that a reintroduced resource
cannot acquire a second diary or silently lose an in-use booking.

## Build slices after the design ruling

1. **Book and return a resource.** Ship the registry, history, database constraints, scoped O2
   writer and operation receipts. Race independent PostgreSQL connections at a synchronization
   barrier for the same unit and the last pool quantity. Assert committed rows, quantities and
   receipts. Cover adjacent intervals, capacity decrease versus hold, confirm at expiry with a
   delayed sweeper, extension versus a new hold, and opposing swaps. Fail the last leg of a group
   and inspect the original state. Exercise a retry after a lost reply, late and early returns,
   and an attempted second start. Use an injected clock. Include a shared room booked by two
   companies and a forged owner at the writer. Each silent-harm control must expose the bad fact.
2. **Find a slot on a form.** Ship the four Q2 queries and the picker. Compare reads with writer
   admission from the same initial state, including hidden owner details, DST boundaries, overdue
   use, disjoint pool demand, bounded search and a pick lost to a concurrent hold.
3. **Compose in Customize or by asking.** Ship the two patch members, grouped draft, plain diff,
   candidate verification, approval, activation and rollback. Test a first-party type and a tenant
   type, a failed rule binding, old-reader refusal, historical replay and live bookings at rollback.
4. **Generate two working modules.** From clean tenant configurations, publish an equipment
   contract with booking lines and a room reservation using only customization. Book, find a
   conflict, change and return in both through the ordinary UI and assistant. Inspect the compiled
   bindings and exercise workflow query/approval. Outside the pack and its registered generic
   bindings, the compiler, renderer, gateways and assistant dispatch by declaration alone. Verify
   there are no booking- or example-specific branches there.

Period and usage billing can read agreed and actual intervals, unit-assignment legs, pauses and
event revisions through authorized projections. The billing pack will own rating and charges.
UI-COMPOSE can bind calendar and timeline views to released queries. A dispatch/routing plug-in
can read commitments and propose a change through a booking operation. Each consumer inherits
the caller’s scope and the operation’s confirmation requirement.
