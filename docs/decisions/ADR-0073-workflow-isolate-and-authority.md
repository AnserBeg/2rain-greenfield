# ADR-0073. Workflow isolation, replay and authority

Date 2026-11-18. Fable 5.2 approved the amended WORKFLOW-1 design to build in
slices. The owner ruled on 2026-11-18 that Gate N2 v1 uses same-pin retry or
cancel. The plan records this in §12.5.

## Authority boundaries

The attackers in scope are tenant-authored guest code and a compromised
`north_star_workflow_worker` role. Worker-authored state is untrusted as proof
of human authority, verified code, or the scope of a source event. Receipt scope
comes from the posting event and its linked change document. The workflow
verifier's evidence, frozen at release approval, pins the executable. The
Semantic gateways enforce the automation actor's current grants and the
approver's authority. Release activation owns the pointer and fence.

Until sign-in exists, the platform trusts the application runtime's principal
assertion and the runtime's existing writes of release approvals and activation
verification receipts under the release activation contracts introduced in 0004.
Customize approval uses this same mechanism.
`PostgresCustomizationService.approve` obtains the trusted approver context and
calls the normal release helpers, which use
`PostgresReleaseApprovalService.createApproval`. The release activation service
writes the verification receipt under the same trusted request context.
[Customize approval](../../packages/postgres-provider/src/customization-service.ts#L1219) ·
[Release approval helper](../../packages/postgres-provider/src/composed-application-runtime.ts#L3011) ·
[Principal assertion](../../packages/postgres-provider/src/request-context.ts#L611) ·
[Verification receipt](../../packages/postgres-provider/src/release-activation-service.ts#L427) ·
[0004 approval grant](../../db/migrations/0004_release_activation_contracts.sql#L1112) ·
[0005 verification receipt grant](../../db/migrations/0005_release_activation_kernel.sql#L1025)

- **R1.** A Tier B or unknown-dependency write requires a recorded human decision bound
  to the exact plan and execution fence.
- **R2.** Only workflow code verified at approval may run.
- **R3.** Every workflow effect stays within the automation actor's tenant and
  company grants.
- **R4.** Workflows never block activation or rollback. Release changes can
  proceed while a workflow waits or runs guest code. The platform serializes
  bounded claim and effect transactions against the active fence.

The runtime's ability to fabricate a human decision or to fabricate activation
evidence is filed under sign-in packet item 1. The workflow scheduler defaults
to off. Enable it only in the local demo until sign-in closes item 1.
[Filed findings](../execution/current-plan-archive.md#filed-during-the-freeze)

## Host and SDK

Use exactly `quickjs-emscripten@0.32.0`. Each execution attempt gets a fresh
synchronous WebAssembly instance in a dedicated Node worker thread with fixed
host-owned linear memory, QuickJS heap and stack limits, and a monotonic deadline.
QuickJS's interrupt is cooperative. A watchdog on the supervising thread
terminates the worker at the deadline even if the guest never checks the
interrupt. The supervisor discards an incomplete worker response. Only the
supervisor can authorize and commit effects. Release the worker before waiting.

The guest has a single dispatch entry point for bounded canonical JSON. An
attempt replays its recorded prefix and can yield at most one new host request,
then the supervisor releases the isolate. The supervisor validates requests
against the pinned release's callable catalog, input contract, declared grants,
and current policy. It mediates live business
calls through the Semantic Query and Semantic Operation gateways. The typed SDK
is generated from the pinned `TenantRelease` and exposes those calls plus
`now`, `sleep`, `waitForEvent` and `requestApproval`. Remove module loading,
filesystem and network access, the real clock, randomness and nondeterministic
garbage-collection APIs before guest code runs. Constrained pure compute in
§10.4 rung 9 can reuse this host with zero host grants. Workflows have only
durable process authority. Validations, guards, formulas and operation effects
stay in the existing declarative or capability contracts.

### Computed inputs to Tier B

Require exact human confirmation for every Tier B operation and every operation
whose admitted inputs or reachable write effects intersect a published Tier B
dependency, including through relations, child rows or indirect effects. An
incomplete dependency or write-effect set is confirmation-class. The rule treats
literals, copied query results and computed values alike. Apply any stricter
operation or current policy requirement. Tier B facts can be produced only by
the owning capability's whole Semantic Operation. Before N5, every
confirmation-class call waits for explicit human approval of the exact plan.

[ADR-0088 R1](ADR-0088-governed-communications-and-reminders.md#amendments-from-the-2026-11-20-fable-read) rules that communication prepare and notify take only stable IDs, accept no body-computed content and write only an inert draft or inbox row, so they are not confirmation-class. The send proof is the exact-values decision.

## Package content and authoring

Use a typed `saveWorkflow` patch under CUSTOMIZE-4's bounded identifier check.
The patch carries workflow identity, trigger, grants, and a digest reference to
the body bundle. Keep the 64 KiB patch and upgrade payload limits. Store source
and verification fixtures in the new immutable, tenant- and environment-scoped
`platform.workflow_body_blobs` table, keyed by the SHA-256 of the canonical
bundle bytes. Admission checks the digest and bundle size, with a 1 MiB cap for
the source and fixtures together. The body is package-revision content by
digest. The immutable revision binds the digest, and the compiled release
artifact closure includes the executable and SDK binding. Source and fixtures
are retained for replay of the authoring intent, audit and recompilation.
A missing or mismatched blob fails closed at draft replay and candidate admission.

UPGRADE-1 re-applies the original patch and body digest against the new base,
regenerates SDK bindings, and reports missing or incompatible targets before
activation. Release rollback uses existing revision and release identities and
digests. It can reverse activation without parsing the patch it reverses.
Customize shows the read-only source, trigger, grants and a plain-language
summary derived from declared grants and callable targets. `customize ask`
drafts, type-checks, lints and tests a proposed body. The ordinary diff,
approval and activation path governs publication. The assistant worklist uses
the existing five tools and the same pending-plan authority as the Approvals
screen.

## Event consumer and activation watermark

Posting already writes the versioned receipt-posted event in
`platform.trust_domain_events` and the linked `platform.trust_outbox` row in the
posting transaction. The consumer joins those rows and the change document by
their scoped identities and validates event type, version, company and receipt
identity. An authorized query through the pinned SDK resolves the item
condition from the posted movements. The worker enumerates provisioned tenant/environment IDs from
`platform.environments` through a scheduler-only, read-only ID enumeration
function. Work for each pair runs in a separate trusted transaction with
tenant/environment context and forced RLS. Event payloads cannot supply that
context. No posting writer or posting-side hook changes.

Each verified activation gets a watermark keyed by tenant, environment, pointer
ID and fence in `platform.workflow_activation_watermarks`. Capture it with an
insert hook on a `SWAPPED_VERIFIED` receipt in
`platform.release_activation_verification_receipts`, in the same transaction
and under the verification path's pointer lock. This hook is a Critical touch of
the 0005 receipts table. Return without capturing a watermark or seeding
occurrences if neither the incoming nor outgoing release declares workflows.
The capture statement's MVCC snapshot defines the boundary. Seed in one
set-based statement filtered to the union of the incoming and outgoing
subscriptions' event types. Give each matching unresolved outbox ID visible at
capture a pre-activation disposition. Previously consumed IDs already have a
disposition. The activation test must compare latency and persisted bytes for
a no-workflow tenant against the pre-hook path and establish that both stay
unchanged.
The boundary uses committed row membership. UUIDs and posting timestamps
cannot serve as a high-water mark because they can be observed out of order.
A receipt becoming visible after capture is eligible only if its source release
ID and root match the verified active release at consumption. A fence with no
verified watermark, including a fence from before installation, cannot start
runs. Verified activation of a workflow-bearing release establishes its first
watermark.

`platform.workflow_event_occurrences` is the durable consumer cursor. Poll in
bounded batches for visible source IDs without a disposition, with no advancing
timestamp cursor. Index the eligible lookup and measure the polling bound against
an accumulated outbox. Lock the pointer for the claim transaction, require its
current fence and verify the matching watermark, and atomically commit the event
disposition and all matching run starts. Claimed starts become visible to
execution only after that transaction commits. A unique start key binds tenant,
environment, source event and stable workflow identity across releases.
An event committed before a rollback and still pending when the rollback is
verified is recorded as pre-activation. It starts zero runs.
If the start committed first, the existing run retains its original pin and
moves to suspension on the release change. A late commit from a superseded
release is recorded as ineligible by the source release check.

## Run pinning, replay and approval

The instance is the logical occurrence. It binds the tenant, environment,
company scope, source event, stable workflow identity, and trigger attribution.
An execution run binds that instance and its immutable release ID/root, initial
activation fence, body and SDK artifact digests, exact engine build and host/SDK
versions, automation principal, author and activation approver. Retain the
matching artifacts and runtime implementations or suspend with a named
unavailable-version reason. An upgraded binary must never select its defaults
for a pinned run. The automation actor's effective authority is bounded by
declared grants and the activation approver's authority at activation. Recheck
current policy for the automation actor and relevant human authority on every
call.

Each journal cursor has an append-only canonical request and, once complete,
an append-only result. Replay returns recorded results for exactly matching
requests. A different request, a skipped cursor, or a body exit before all
recorded calls are consumed atomically quarantines the run with a diagnostic.
Quarantined runs leave the runnable queue and retain evidence for human
inspection. An outbox row and its effect request commit together. The dispatcher
invokes a whole Semantic Operation with a stable idempotency key derived from
the logical occurrence and effect cursor. It recovers a committed result from
the exact durable receipt across an operation-commit/journal-commit crash.
Compensation uses declared correcting operations.

Before scheduling or resuming live work, compare the run's release and current
execution fence with the verified active pointer. A stale run enters
`SUSPENDED` and stops taking effects, even on timer wake. Recheck at dispatch.
Admit fresh Tier A writes transactionally against the active fence. Capability
calls remain subject to their own writer fences. An
`INVENTORY_POSTING_RELEASE_MISMATCH` caused by a stale pin racing the precheck
suspends the run. Record the suspension as control evidence outside the replay
results. A mismatch
while the ID and root are still active raises a named integrity failure and
requires investigation. Reconcile any in-flight effect to its durable receipt
before remedying the run.

Approvals bind the exact canonical arguments, effect occurrence, release ID and
root, activation fence, operation and company scope. Persist the approving
human's identity. Derive authority from the pinned operation's target. For
existing records, use the stored owner company. For creates, use the governed
company operand. Shared targets require a tenant-wide grant. Check the active
binding and current authority both when a
person approves and before dispatch. Stale pending approvals and stale approvals
whose effects have not committed become permanently ineligible. Keep their
history visible and report the reason in the worklist and assistant. Returning
to the same digest under a later fence cannot revive a prior approval.

An operator can cancel or retry suspended runs in bulk. Evaluate each run
individually and audit each result. A retry is admitted only when the original
release is verified active again and the run retains its original release, body,
SDK and runtime pins. Reconcile in-flight effects and admit the new execution
fence before resuming. Outstanding confirmation needs a fresh plan and human
decision. Cancellation preserves completed effects and evidence. Successor
retry against a different release is deferred.

The Gate N2 v1 proof starts a run before an upgrade, shows it suspending while
stale, then restores the original release and demonstrates that a person's
same-pin retry finishes the run. While a different release is active, the
operator can cancel the suspended run.

## Timers, signals and external delivery

`now` journals a trusted instant. `sleep` persists the computed UTC deadline
and commits its wake result once. Restart reloads due timers. In-process elapsed
time and budget checks use a monotonic source, and time tests inject their clocks.
**Deferred by the WORKFLOW-2 amendment A4: `waitForEvent` is removed from the
SDK for now and this description is a named gap, not current behaviour.**
`waitForEvent` registers a durable wait for a pinned event contract and exact
authorized correlation in the run's tenant, environment and company. Register
the request and its visible-event baseline in one transaction, using source
IDs to exclude events already visible at registration. Under the wait lock,
choose the first eligible visible match ordered by source recorded time and ID.
Claim and journal its identity and payload atomically at the wait cursor. Poll
the durable source after restart, including when the start subscription has
already consumed that event. Recheck the run's release and authority at wake. A duplicate delivery cannot wake a
wait twice.

Connector calls, when admitted in a later packet, use typed registered
connector contracts through the same journal and transactional outbox.
WORKFLOW-1 exposes zero connector calls. Outbound delivery binds a stable
occurrence key to connector, destination and canonical payload. Provider retry
reuses that key and reconciles a committed receipt before any resend. If a
provider cannot deduplicate or prove the prior attempt did not commit, park the
ambiguous delivery for reconciliation. Inbound provider deliveries are
authenticated and deduplicated on tenant, environment, connector endpoint and
provider message ID before starting or waking a workflow. The N2 communication
proof must observe one external delivery across a crash after provider acceptance
and before local acknowledgement.

## Release admission and verifier scope

Carry workflows as an optional authored addition under ADR-0047 §7. A release
with workflows includes a workflow projection and raises the runtime floor on
the existing required surface manifest that serving readers already check via
`unsupportedRuntimeCapability`. Emit workflow facts only when declared. Refuse
a missing, inconsistent or unsupported workflow projection for a
workflow-bearing candidate. Allocate the next free surface-reader rung from
`origin/main` at integration. Re-allocate if the trunk's floor advances before
the merge is pushed.

The proposed Critical verifier change is limited to
`PostgresReleaseVerificationService` candidate verification and evidence
read-back. `releaseVerificationBinding` binds each declared workflow to its
verified projection, body, executable, SDK, runtime versions and test fixture
digests under the staged candidate root. The service runs the workflow gates
before accepting or persisting verification evidence. Persist the exact
workflow evidence alongside the existing evidence under the same evidence ID
and transaction. On read-back, require a complete passing workflow evidence set
bound to the same candidate and digests. Missing, stale or mismatched evidence
refuses the candidate. Existing query/operation execution, capability factories,
activation authority and posting remain governed by their existing contracts.

Type-check against the generated SDK and lint before emitting executable code. Refuse
`Date.now`, `Math.random`, other ambient clock, random and I/O APIs, and module
imports outside the SDK. Require at least one verification fixture for each
workflow. For each fixture, execute the compiled body once with deterministic
inputs and mocked host integrations and a second time in a fresh isolate
replaying the first run's journal. Require the same ordered
requests and outcome, full journal consumption, and zero new effects during
replay. An unmocked call or any divergence fails candidate admission. Tests must
observe both refusals. A checked-in before/after control compiles the same
no-workflow input on both sides of the extension and compares canonical package
bytes, release manifest and artifact bytes and roots, and persisted verification
evidence bytes under identical fixture identities. The extension emits no
workflow projection, evidence or added floor for these releases.

## Migration

Follow the migration numbering rule. At merge time, fetch `origin/main` and
assign the single forward migration the next free number after its highest
migration. Regenerate the schema snapshot and migration-list tests and rerun CI.
Fetch again immediately before pushing `main` and repeat if another migration
landed. Coordinate with other lanes so only one migration merge proceeds at a
time. The
migration declares these relations in `platform`:

| Table | Responsibility |
| --- | --- |
| `workflow_body_blobs` | Immutable source and fixture bundles by digest |
| `workflow_definitions` | Immutable, release-scoped workflow bindings and grants |
| `workflow_verification_evidence` | Candidate-bound run-twice evidence, linked to release verification |
| `workflow_activation_watermarks` | Verified activation fence and source boundary |
| `workflow_event_occurrences` | Per-source consumption disposition and start deduplication |
| `workflow_instances`, `workflow_runs` | Logical occurrence, immutable execution pins and durable run state |
| `workflow_journal` | Append-only requests, results and control evidence |
| `workflow_timers`, `workflow_event_waits` | Durable deadline and correlation registrations |
| `workflow_effect_outbox` | Transactional effect dispatch, claims and receipt recovery |
| `workflow_pending_approvals` | Exact pending plans, decisions and stale status |

Use tenant/environment keys and forced RLS as in 0029. Grant only scoped reads,
inserts and the narrow state transitions each role needs. Keep the body,
definition, watermark, occurrence, verification and journal evidence immutable.
The migration adds the verified-activation receipt hook and read-only scheduler
enumeration function. Use a dedicated `north_star_workflow_worker` role. A Codex read is required
before any tenant activates a workflow-bearing release.

## Deploy rule

Never roll back code below the newest patch parser or release reader floor a
tenant has used.

## WORKFLOW-2 amendments (2026-11-20, accepted with amendments (Fable 2026-11-20))

**Status: accepted with amendments (Fable 2026-11-20).** Nothing here is code yet.
Fable's design read (verdict ACCEPT WITH AMENDMENTS) is applied below as edits
E1 to E14 and notes N1 to N7. E15 is an orchestrator ruling on the owner's behalf
(see A1, "Dates already past"). Slices 1 to 4 may start when this merges; slices
5 to 7 start after E1 to E7 are in this ADR, which they now are. The packet record is
[WORKFLOW-2](../execution/packets/WORKFLOW-2.md). Source of the scope:
Fable's workflow-script ruling of 2026-11-20 (read at main `5d315668`, kept in
the orchestrator's missions folder as `workflow-scripts-ruling.fable.md`). Line
references below were re-checked at `55543d77`.

### A0. What this amendment keeps

Scripts stay for workflow logic. There is no block interpreter. Waiting and
approval stay fixed platform calls. Reminders and notify-only rules stay the
declared rules of [ADR-0088](ADR-0088-governed-communications-and-reminders.md).
Status changes stay in the declarative lifecycle. A script is only the glue:
if, loop, compute, which call next. Nothing below widens what a script can do.
The gateway, the grants intersection, approvals, run pinning and the limits in
this ADR are unchanged.

### A1. Triggers on customer-built record types

**Today.** `WorkflowDefinitionSchema.trigger` is `z.literal('goodsReceiptPosted')`
([schemas.ts:2892](../../packages/canonical-model/src/schemas.ts#L2892)), the
fixture event is receipt-only
([workflow-draft.ts:6](../../packages/customization/src/workflow-draft.ts#L6)),
and unattended links must equal the receipt
([workflow-gateway.ts:309](../../packages/postgres-provider/src/workflow-gateway.ts#L309)).
No customer module can start a workflow.

**A versioned discriminated trigger union.** `trigger` becomes the union of:

- the bare string `'goodsReceiptPosted'`, kept as a member and **byte-for-byte
  unchanged**. Reshaping it would reinterpret stored patches, which
  ADR-0085 would then require a forward converter and a Manual activation, for
  no gain;
- three new object members, each with its own `kind` and `schemaVersion`
  (`'v1'`), strict objects, add-only. A later schema version of a member is a
  new version of that member, never an edit of `v1`.

| Member | Persisted fields (stable IDs only, rule 10) | Fires when |
| --- | --- | --- |
| `recordCreated` | `recordTypeId` | A record of that tenant record type is committed for the first time. |
| `recordTransitioned` | `recordTypeId`, `toStateId`, optional `fromStateId` | A committed lifecycle transition ends in `toStateId` (and began in `fromStateId`, if given). A create into the initial state is not a transition. |
| `scheduledOnField` | `recordTypeId`, `fieldId`, `fieldContract` (logical type `date` or `dateTime`, the field's own contract version and zone-source kind), `offset` `{direction: before \| at \| after, amount, unit}` | The resolved instant for the record's date or date-time value, moved by the offset, arrives. |

Persist the author's CHOICES by ID, never a re-derived body (MIGRATION-RULE
rule 10). The member stores the type ID, the state IDs and the field ID with the
contract it expected. The digest of the workflow definition covers those IDs and
contracts only. Labels, the transition's own ID and the type's state list render
from the release and are not part of the member. Retired revisions are not
validated. Admission checks, against the pinned release: the type exists and has
one owning company per record (a type without a single owning company cannot
trigger a workflow in v1, because the run needs a company scope); for
`recordTransitioned` that at least one declared transition connects the states
(`fromStateId` and `toStateId` differ); for `scheduledOnField` that the field's
current contract equals `fieldContract`.

Bounds on `offset`: `amount` is a whole number from 0 to 366 for `civilDays`, or
0 to 8,784 for `hours` and `minutes` (`dateTime` fields only). Units: `civilDays`,
`hours`, `minutes`. **Working days are a named gap**, as in ADR-0088: they need
a governed, versioned working-date list, which does not exist. An interval
field is also a named gap (ADR-0087 names intervals; a later member version may
bind an interval's end).

**Date rules for `scheduledOnField`** (ADR-0087 and ADR-0083 A1). A `date` value
is a civil date. Subtract or add `civilDays` in the field's captured business
calendar, then resolve the result to an instant at the captured business-day
boundary, or at local midnight for a per-record zone. A `dateTime` value keeps
its captured zone and local time for a `civilDays` offset, and uses elapsed time
for `hours` and `minutes`. Every derived boundary uses ADR-0083 A1: a time in a
DST gap resolves to the first valid instant after it, and a repeated time
resolves to the earlier offset. The registration records the zone, the tzdb
version, the boundary-rule version, the anchor value and the resolved UTC
instant. Unless the slice 7 audit shows a plain `date` field already has an ADR-0087
capture, its zone and day boundary come from the owning company's business
calendar, resolved and recorded when the registration is armed. A missing zone or
calendar never refuses the record write; the registration is recorded as unarmed
with the reason and shown in the worklist. ADR-0087's consumer table gains a
"Workflow schedule anchor" row.
The stored instant stays authoritative after a later tzdb change.

**The event the script receives.** The fixture and the SDK type take the shape
of the member: `{type, eventId, recordTypeId, recordId, legalEntityId}`, plus
`fromStateId`, `toStateId` for a transition and `fieldId`, `anchor` (the civil
date or instant) and `occurrenceKey` for a schedule. Record text and field values
never ride in the event. The body reads them through a granted query like any
other data. The SDK's `ReceiptEvent` type is replaced by a type generated from
the declared member.

**Where firing comes from.** Created and transitioned events come only from the
committed change document and domain event that the same transaction already
writes for a governed operation
([module-runtime-interpreter.ts:1337](../../packages/postgres-provider/src/module-runtime-interpreter.ts#L1337)),
read by the same scoped consumer and watermark as the receipt trigger. Worker
state is never evidence of a source event (the trust model at the top of this
ADR). **Source audit first (in slice 5, before any code):** confirm from the change document alone
that a create and a lifecycle transition can be told apart by record type,
record ID and change kind. If the transition writer does not record the derived
state change durably in the same transaction, the slice names the writer change.
That change is a Critical touch of a tenant-record writer and a migration, taken
under MIGRATION-RULE, and it stops the slice for an owner decision rather than
being added quietly. The audit also covers the causation write, the source of
company, and every path that creates or transitions a tenant record (form, API,
assistant, import, workflow). The owner-decision stop applies to `recordCreated`
as well as `recordTransitioned`.

**Exactly-once firing, and the occurrence key.** The existing unique start key
(tenant, environment, source event, stable workflow identity) stays the
mechanism. What changes is what the "source event" is for each member:

- `recordCreated`: the create's domain event ID. A record has one create event.
- `recordTransitioned`: the individual transition's domain event ID, not
  (record, from, to). Records cycle through states, and each real transition
  must be a separate occurrence.
- `scheduledOnField`: the occurrence key (tenant, environment, company, stable
  workflow ID, record ID, field ID, **anchor generation**). It excludes the
  record revision, timer ID, resolved deadline and release fence, with the same key
  shape as [ADR-0088](ADR-0088-governed-communications-and-reminders.md); unlike
  ADR-0088 R9, a moved anchor does not re-fire in v1. Anchor generation is the stored cycle ID of a genuinely
  recurring source, and is `0` for everything in v1. So v1 fires once per
  record per field, even if the date is edited after it fired. Re-firing on a
  new anchor generation is a named gap.

A claim transaction commits the disposition and every matching run start
together, as the consumer does today. A duplicate delivery, a polling retry or a
restart cannot start a second run.

**A scheduled trigger has two phases.**

1. *Registration, before it fires.* It is a platform-owned registration derived
   from the active release plus stored facts, not a pinned run (the same shape as
   ADR-0088 R2). It is created when a record gains an eligible value, rescheduled
   when the date, offset or calendar changes, and closed when the record is
   archived or deleted, loses its value, or the release no longer declares the
   trigger. Registrations are derived by the scoped consumer from committed change
   events and by a bounded, resumable sweep after activation; nothing is added to
   a record writer or to the activation hook. The firing claim takes locks in the
   one global order, registration before record. A fence change re-derives it under the same occurrence key and does
   not suspend anything. The firing claim re-reads the stored value and revision
   under lock and fires only if the resolved instant still matches. Otherwise it
   reschedules.
2. *The run, after it fires.* From the start-key commit onward it is an ordinary
   pinned run with ADR-0073's pins, suspension and Retry rules.

**Dates already past.** A registration whose resolved instant is at or before
the activation's watermark capture, or at or before the moment a record's value
is entered or edited, starts zero runs and is recorded as pre-activation or
already-past with the anchor and instant. Activating a trigger on an existing
module never fires a burst for old records. The activation evidence counts the
registrations it will arm, re-arm, close and skip as already past. A skip does
not consume the occurrence key: a later edit to a future instant arms the
registration. An armed registration whose instant passes while the worker is down
fires once, late, on the next claim. When a person's entry or edit leaves the
resolved instant past but the anchor itself still ahead, the registration fires
once at once; activation and roll-forward never do. (Orchestrator ruling on the
owner's behalf, 2026-11-20; owner may overturn. If overturned, replace with: a
late entry starts nothing, and the review screen and the drafter text say so.)

**Rollback and upgrade** (consistent with ADR-0088 R2 and ADR-0085).

- Any release that adds, changes or removes a trigger is workflow-bearing and is
  **always Manual** (ADR-0085 "Workflow authority"). Its activation evidence
  adds the pending-registration counts above to the in-flight run and pending
  approval counts it already shows.
- The watermark capture seeds pre-activation dispositions from the union of the
  incoming and outgoing releases' subscriptions. The union is now keyed by
  (event type, record type) for the new members, with the same bounded,
  set-based statement. This is a Critical touch of the activation hook and
  carries the same no-workflow byte-identity proof as the receipt hook.
- Rolling back to a release without the trigger closes its registrations and
  starts no runs for events committed before the rollback verified (they are
  pre-activation, as for receipts). Rolling forward again re-derives unfired
  registrations under the same key. A consumed occurrence stays consumed. An
  instant that passed during the gap fires nothing.
- A run already started keeps its pin. On the release change it suspends, takes
  only cancel while another release serves, and takes a same-pin recorded human
  Retry after an exact rollback (migration 0054). Nothing about triggers changes
  that.
- Each member takes **its own reader rung**, allocated at the merge of the slice
  that introduces it, never reserved (the surface-floor rule). A binary below the
  rung refuses the release by name through the archived production loader, and
  the deploy rule applies: never roll code below a floor a tenant has used.

**Replay and conflicts** (ADR-0085's closed diagnostic table; no new public code).
A retired record type, state or field is `RETIRED_TARGET` naming the trigger and
the missing ID. A field whose logical type or zone source changed is
`INCOMPATIBLE_TYPE`. A type that lost its single owning company is
`INCOMPATIBLE_SCOPE`. A label rename or an added field on the type replays clean.
Each member gets a named replay test with one compatible base move and one real
conflict, and the fail-closed vocabulary check descends into the union.

**Unattended links may point at the triggering record.** Today only the receipt
is allowed
([workflow-gateway.ts:309-316](../../packages/postgres-provider/src/workflow-gateway.ts#L309)).
The run row stores the triggering record ID and company from the verified event's
or registration's record ID and the stored record's owning company, read under
the claim (the generic event payload carries no company), never from script
input; a record that is gone or has no single owning company starts nothing. The
link's declared target type must be the trigger's record type. The gateway generalises "links equal
the receipt" to "links equal the run's stored trigger record ID", and the
operation's company still equals the run's company. Everything else about
unattended writes is unchanged: a proven create-only operation with no Tier B
reach and an exact digest proof. A link to any other record is refused as it is
today. The proof needs two companies in the same tenant, so the company check is
the only thing that refuses, and an attempt to link a record the trigger did not
name.

**Loops.** An operation committed by a workflow run carries its run as the
change document's causation. An event whose causation is a run of the **same
workflow** starts nothing (disposition `self-caused`). An event caused by another
workflow starts a run at causation depth one more than its cause, and a depth
above 3 starts nothing (disposition `depth-exceeded`). Both dispositions are
audited. A cycle is therefore bounded, and a person's edit always starts at
depth 0. Today no writer records causation
(module-runtime-interpreter.ts:1340 writes null). The workflow gateway sets the
change document's causation to the run, taken from the run row and never from
script input; this writer change is named in the source audit and lands in slice
5 with a test that reds when it is removed. A scheduled registration stores the
workflow ID and causation depth of the write that set its anchor value;
self-caused and depth-exceeded are judged at firing from those stored values, so
a schedule never resets depth to 0.

**Boundary with ADR-0088 reminders.** "Two days before X, tell the owner" and
"prepare the customer email" are declared reminder rules, run by the platform,
and not scripts. A `scheduledOnField` workflow is for logic: create a record,
branch on the record's current values, sleep, ask for approval. The SDK has no
notify call and gains none here. A workflow that needs to notify binds the
governed event to ADR-0088's internal notify operation under its pinned grant, as
ADR-0088 already allows. The drafter must answer a notify-only request with a
reminder rule (or "unsupported"), never a script. The eval has this redirect as
a case. The verifier does not try to prove intent. It refuses nothing on this
basis.

**Rule 12 (drafter support and eval).** The drafter's description of each
trigger member is generated from the union's schema plus the release's record
types, states and date fields by stable ID, replacing the hand-written line at
[ai-draft.ts:454](../../packages/customization/src/ai-draft.ts#L454). The
fixture event schema is generated per member the same way. A fail-closed test
enumerates the trigger members (they all sit inside the one `saveWorkflow` patch
kind, so the patch-kind check alone would miss them) and fails unless each has
generated drafter coverage and an AI-BUILD-1 eval case, or a dated, named
exception. Eval cases: created creates a linked record; transitioned requests
approval; scheduled creates a task before a date; notify-only is redirected to a
reminder; a wait-for-reply request is refused as the A4 gap; and a hostile
record-type label does not change the drafted calls.

### A2. The repair loop

A failed draft goes back to the model, not to the user. When type-check, lint or
the run-twice replay rejects a `saveWorkflow` draft, the drafter gets at most
**two repair turns**. This is separate from, and keeps, the existing repair of a
malformed tool call
([ai-draft.ts:479-499](../../packages/customization/src/ai-draft.ts#L479)).

- *What the model receives.* Structured diagnostics, not logs: kind (type-check,
  lint, replay divergence, fixture failure), the line and column in its own body,
  the message, and for replay the first diverging request and the expected one.
  At most 20 diagnostics, each cut at 300 characters, 8 KiB in total, no stack
  traces, paths or tenant data beyond identifiers it already received.
- *What is not repaired.* A request outside the user's authority, an unsupported
  request, an over-wide grant and a verification timeout go to the user as today.
  Repair never relaxes a gate. Each repaired draft is a fresh `saveWorkflow`
  draft that passes the same verification in the A6 sandbox.
- *Cost and evidence.* Each repair turn is one drafting call under the existing
  per-tenant cost cap and attribution. The draft record keeps the turn count and
  the diagnostic kinds per turn, and whether a repair turn changed the fixtures,
so AI-BUILD-1 can report "verified on first
  draft" and "verified after at most two repairs" separately. If the second
  repair fails, the user sees the last diagnostics in plain words and the turn
  count, not only "did not pass verification"
  ([customization-service.ts:1177](../../packages/postgres-provider/src/customization-service.ts#L1177)).

### A3. Review before approval

The pending draft shows what a person is approving, before approval. Today the
source appears only after activation, and the pre-approval summary is built from
declared grants alone
([render.ts:99](../../packages/customization/src/render.ts#L99),
[customize-screen.ts:513](../../apps/web/src/customize-screen.ts#L513)).

1. **The source**, read-only, the exact bytes the body digest names.
2. **A plain-words sample run**, rendered by a deterministic function (not a
   model) from the ordered calls in every fixture run the verifier makes, up to 5: "Creates an
   Inspection linked to the receipt. Waits 2 days. Asks a person to approve
   'Escalate the inspection'." It names operations and queries by their release
   labels, resolved by stable ID. It is labelled "from the test the drafter wrote,
   with made-up values; it shows what the script does in that case, not every
   case." Each step says whether it happens without asking or asks a person
   first, and a call site no fixture exercises is marked "not shown in any test" The fixtures are the model's own (the ruling's "model writes its own
   test" gap), and the label says so. Independent expectations belong to
   AI-BUILD-1.
3. **A summary derived from the actual call sites.** A TypeScript AST pass over
   the compiled body lists each SDK call site, the target, whether it sits under
   a branch or a loop, and its input field names. It is cross-checked with the
   fixture journal. A grant that no call site uses is shown as "declared but never
   called". The summary says what the script will do, and the grants list says
   what it may. The lint refuses any use of an SDK function other than a direct
   call, so the call-site list is complete.
4. **The approval binds what was shown.** The reviewed diff the release approval
   proof freezes (ADR-0081, SIGNIN-1) includes the body digest and the digest of
   the rendered review model, which is a pure function of the body bundle and the
   release. A test renders twice and compares bytes. The review digest carries the renderer
   version, exists only in the approval proof, is compared once at the approval
   gesture, and is never stored in the workflow member or re-validated on
   normalisation, replay or upgrade (rule 10).

### A4. `waitForEvent` is removed from the SDK, for now

**A named gap: durable external-event waits.** The paragraph under "Timers,
signals and external delivery" that describes a durable `waitForEvent` is
**deferred, not implemented**. Today the SDK offers the call
([workflow-sdk.ts:109](../../packages/postgres-provider/src/workflow-sdk.ts#L109)),
a fixture can mock it, and the live runtime then suspends the run with
`durable-call-unavailable`
([workflow-execution.ts:373-381](../../packages/postgres-provider/src/workflow-execution.ts#L373)).
A verified draft can therefore stall live.

- The next SDK version drops `waitForEvent` from the generated declarations and
  from the `admitCall` call kinds. A body that calls it fails type-check. A
  fixture that mocks it is refused. The drafter's SDK text omits it and a
  wait-for-event request gets "unsupported (named gap)".
- The SDK digest and SDK version change, so they are new pins. A run and a
  retained revision keep the digest and implementation they were pinned to. The
  old host path that suspends a legacy `waitForEvent` call stays so a legacy pin
  behaves as it did. It is not revived, and such a run can only be cancelled.
- On upgrade or replay, a retained workflow whose body calls `waitForEvent`
  conflicts as `REMOVED_ACTION`, naming the workflow binding and the absent call.
  The slice scans the existing proofs and fixtures for the call before removing
  it.
- Reopening the gap needs its own ADR: a wait-registration table, the visible-event
  baseline and first-match rule already described here, a reader rung, and
  replay tests.

### A5. Engine patch policy

Written as an operations note,
[engine-patch-policy.md](../operations/engine-patch-policy.md): named owner,
advisory watch, severity deadlines, and the rule for moving in-flight runs. Its
one load-bearing rule for this ADR: a run is never re-pinned to a patched engine
by the worker. It moves only through a new recorded human decision kind,
engine-move Retry, which migration 0054 does not admit today (it accepts only
'stale-release-pin' with every pin unchanged). It needs a migration and an
exception in "Run pinning, replay and approval": the engine build is the only pin
that may change, and only after the journal replays identically on the new build.

### A6. Isolation of unapproved scripts and of live runs

**Draft time (decided).** A draft's type-check, lint and run-twice replay move
out of the serving process into the existing forked sandbox
([sandbox.ts:204](../../packages/customization/src/sandbox.ts#L204)), with a wall
clock bound. Today they run in the serving process that holds database
credentials, with no time bound
([workflow-compile.ts:124](../../packages/postgres-provider/src/workflow-compile.ts#L124),
[customization-service.ts:1163](../../packages/postgres-provider/src/customization-service.ts#L1163)).

- A new request kind, `verifyWorkflowDraft`, with a new protocol version. The
  parent sends the draft, the SDK declarations serialised from the pinned release
  and the fixtures. The child returns data only: pass or fail, diagnostics and the
  canonical journal. The parent validates the result against a schema and never
  executes anything the child returns.
- **The child's environment must be an allowlist.** The launcher today passes
  `{...process.env, ...}`
  ([sandbox.ts:110](../../packages/customization/src/sandbox.ts#L110)), so the
  child inherits every credential in the serving process. The slice replaces it for every request kind, including today's compile, with
  the few variables the child needs, and a test asserts the child sees no database
  or provider variable and opens no database connection. A child holding no
  credentials is the point of the move. Credential-free means: an allowlisted
  environment; no database connection; and, before the first real tenant, an
  operating-system boundary: the child runs as a separate user or in a container
  that cannot read the connector key file or any other secret and has no network
  route. Node's permission flags may be added but are not the boundary. A test
  proves the child sees no credential variable and cannot read the key file.
- Bounds, proposed: 30 s wall clock for the whole verification, 512 MB heap, one
  fresh child per verification and none reused, output capped at 1 MiB. Expiry
  kills the child. A timeout is a draft refusal with the repair loop's "not
  repaired" rule and a plain message, not a public upgrade code.
- **Open: candidate admission.** `workflow-admission.ts:114` runs the same replay
  again at release verification. The ruling did not trace that process boundary.
  Slice 1 traces it. If it already runs in the isolated activation verifier, the
  slice records that. If not, candidate admission moves to the same child. Either
  way, no unapproved or unactivated source runs in the credential-holding
  process.

**Live runs (decided).** The live guest runs in
a worker thread of the serving process
([workflow-isolate.ts:51](../../packages/postgres-provider/src/workflow-isolate.ts#L51)),
a fresh thread and WASM instance for every step. A WASM-layer escape would land
in a process that holds database credentials. Two options:

- **Option A (chosen): a separate OS process for the guest.** A credential-free child
  runs each step. Its only exit is the existing single `dispatch`, carried over
  IPC to the serving process, which still runs the gateway, grants and approvals.
  Cost: one process start per step (the isolate is already per step), an IPC
  protocol, and more operating surface. Gain: an engine escape lands in a process
  with nothing to steal.
- **Option B (rejected): accept the WASM layer.** Keep the worker thread. Rely on the fixed
  16 MiB memory, the removed ambient globals, the single exit, A5's patch policy
  and the A7 rate limits. An engine-level escape lands in the credentialed
  process, and the decision records that as accepted risk.

**Choice: Option A (Fable, 2026-11-20). Option B is rejected:** the process that
hosts the guest holds database credentials for every tenant. One child per step,
never reused after it receives run data. It is a hard gate before the first real
tenant activates a workflow, together with a named owner and deputy in the
[engine patch policy](../operations/engine-patch-policy.md). Neither option
blocked slices 1 to 6; the local demo is the only place workflows run today.

### A7. Nice-to-haves

- **Retry before quarantine on a CPU overrun.** An overrun today quarantines the
  run as `permanent-guest-failure`
  ([workflow-execution.ts:698](../../packages/postgres-provider/src/workflow-execution.ts#L698)),
  so a stalled host can quarantine a healthy run. A step is pure until its one
  host exit, so it is safe to retry once in a fresh isolate. A second overrun
  quarantines with a distinct reason, `cpu-limit-exceeded`. Both attempts go to
  control evidence, not the replay journal. A watchdog kill of a stalled host is
  recorded apart from a guest overrun.
- **Per-tenant run-rate limits.** Proposed defaults, set by the platform
  operator and not by a tenant: 600 run starts per tenant and environment per
  rolling hour, 120 per workflow per hour, 200 runs runnable or executing at once
  (sleeping and awaiting-approval runs do not count), and 10,000 open runs per
  tenant and environment. Over the limit the claim records a deferred start per
  (event, workflow) with a not-before time, so other workflows on the same event
  still start. Deferred starts are not dropped by age. They are bounded at 10,000
  per tenant and environment; above that a new start gets the audited disposition
  `rate-limit-overflow`, the worklist raises an alert, and an operator can
  release or dismiss waiting starts. Scheduled registrations defer the same way.
  Activation evidence counts the deferred starts it will discard.
- **A sleep-length cap.** Refuse `sleep` above 90 days (7,776,000,000 ms) in
  `admitCall` ([workflow-sdk.ts:298](../../packages/postgres-provider/src/workflow-sdk.ts#L298)),
  by the same refusal path as any call outside its contract. The SDK text states
  the cap. Today there is none. Enforced for the new SDK version only. A run older
  than 400 days in total is suspended for a human decision.
- **Named gaps, not built here:** an instruction or fuel budget instead of
  wall-clock CPU; a soak test of long and suspended runs across an engine
  upgrade (it joins A5's first engine bump); hostile-text probes (they are eval
  cases under A1 and belong to AI-BUILD-1); a separate time bound for the
  type-check beyond A6's sandbox bound.

### A8. Order and gates

Slices and their tests are in the packet record. Every trigger member and the
activation hook are Critical. A migration takes the next free number and a rung
takes the next free rung at merge, never a number named here. An independent read
follows each Critical merge, from Fable or Codex sol, never from the writer's
model. The rate limiter (A7) is its own Critical slice and
lands before slice 5; it is part of the loop bound.

## Bakeoff

The 2026-11-18 probe ran on Node 22.22.2 against Emscripten 0.32.0 and Vercel's QuickJS-WASI 3.6.3, released 2026-10-19. Both passed one narrow JSON dispatch, absence of the filesystem and network entry points and the removed clock and random globals, an 8 MiB allocation refusal at a 4 MiB heap limit, and interruption of a busy loop with a 25 ms budget. Emscripten accepted an imported 16 MiB fixed-size memory and rejected a request to grow it. The WASI binary had no memory import, so its stock API did not supply that independent host ceiling. Emscripten gives us the hard ceiling while keeping the dependency count to one direct pin. npm's audit found zero advisories in the temporary two-candidate install. The repository scans are still due for the actual dependency change. [Emscripten API](https://github.com/justjake/quickjs-emscripten/blob/main/packages/quickjs-emscripten-core/src/module.ts) · [QuickJS-WASI API](https://github.com/vercel-labs/quickjs-wasi) · [npm release metadata](https://registry.npmjs.org/quickjs-emscripten)

## Reproduce the bakeoff

In a temporary directory, install the two candidate pins and save the JavaScript block as `probe.mjs`. Run `node probe.mjs`. Both candidates should print a passing result.

```bash
npm --cache ./cache install --ignore-scripts --no-audit --no-fund --save-exact quickjs-emscripten@0.32.0 quickjs-wasi@3.6.3
npm --cache ./cache audit --audit-level high --omit dev
```

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { RELEASE_SYNC, newQuickJSWASMModule, newVariant } from 'quickjs-emscripten';
import { QuickJS } from 'quickjs-wasi';

const pageCount = 256;
const budget = 4 * 1024 * 1024;
const start = performance.now();
const memory = new WebAssembly.Memory({ initial: pageCount, maximum: pageCount });
const quick = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
assert.equal(quick.getWasmMemory(), memory);
assert.throws(() => memory.grow(1), RangeError);
const runtime = quick.newRuntime();
runtime.setMemoryLimit(budget);
runtime.setMaxStackSize(256 * 1024);
let deadline = Infinity;
runtime.setInterruptHandler(() => performance.now() >= deadline);
const guest = runtime.newContext();
let calls = 0;
const hostCall = guest.newFunction('dispatch', (input) => {
  assert.equal(guest.typeof(input), 'string');
  assert.equal(guest.getString(input), '{"kind":"now"}');
  ++calls;
  return guest.newNumber(7);
});
guest.setProp(guest.global, 'dispatch', hostCall);
hostCall.dispose();
const emEval = (source) => {
  const result = guest.evalCode(source);
  if (result.error) {
    const error = guest.dump(result.error);
    result.error.dispose();
    throw new Error(error.message);
  }
  const value = guest.dump(result.value);
  result.value.dispose();
  return value;
};
const bootstrap = `delete globalThis.Date; delete Math.random; delete globalThis.WeakRef; delete globalThis.FinalizationRegistry;`;
const absent = `JSON.stringify([typeof fetch, typeof process, typeof require, typeof Date, typeof Math.random, typeof crypto])`;
const absentValues = JSON.stringify(Array(6).fill('undefined'));
emEval(bootstrap);
assert.equal(emEval(absent), absentValues);
assert.equal(emEval(`dispatch('{"kind":"now"}')`), 7);
assert.equal(calls, 1);
assert.throws(() => emEval('new ArrayBuffer(8 * 1024 * 1024)'), /memory/i);
deadline = performance.now() + 25;
assert.throws(() => emEval('while (true) {}'), /interrupt/i);
guest.dispose();
runtime.dispose();
console.log(`Emscripten: hard WASM cap, heap limit, interrupt, ambient isolation and one dispatch passed in ${Math.round(performance.now() - start)} ms`);

const wasiBytes = await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm')));
const wasiModule = await WebAssembly.compile(wasiBytes);
assert.equal(WebAssembly.Module.imports(wasiModule).some(({ kind }) => kind === 'memory'), false);
const started = performance.now();
deadline = Infinity;
const wasi = await QuickJS.create({ wasm: wasiModule, memoryLimit: budget, interruptHandler: () => performance.now() >= deadline, timezoneOffset: 0 });
const wasiEval = (source) => wasi.evalCode(source).consume((value) => wasi.dump(value));
calls = 0;
const wasiDispatch = wasi.newFunction('dispatch', (input) => {
  assert.equal(input.toString(), '{"kind":"now"}');
  ++calls;
  return wasi.newNumber(7);
});
wasi.setProp(wasi.global, 'dispatch', wasiDispatch);
wasiDispatch.dispose();
wasiEval(bootstrap);
assert.equal(wasiEval(absent), absentValues);
assert.equal(wasiEval(`dispatch('{"kind":"now"}')`), 7);
assert.equal(calls, 1);
assert.throws(() => wasiEval('new ArrayBuffer(8 * 1024 * 1024)'), /memory/i);
deadline = performance.now() + 25;
assert.throws(() => wasiEval('while (true) {}'), /interrupt/i);
wasi.dispose();
console.log(`WASI: heap limit, interrupt, ambient isolation and one dispatch passed in ${Math.round(performance.now() - started)} ms. The module does not import host-capped memory.`);
```
