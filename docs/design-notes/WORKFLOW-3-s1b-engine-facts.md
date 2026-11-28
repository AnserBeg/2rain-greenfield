# WORKFLOW-3 s1b — engine facts as workflow triggers (design note)

Design only, at origin/main `32139da`. WORKFLOW-3 s1 (`packet/WORKFLOW-3-s1`, unmerged) is cited as **s1**; its
claims are UNVERIFIED on main. One owner ruling is owed before BUILD (§9).

## 1. The gap, from source
- A trigger member is the bare receipt string or `recordCreated` (`packages/canonical-model/src/schemas.ts:3266-3278`);
  s1 adds `recordTransitioned` only for machines generic operations alone move (s1 ADR-0073 "Limit, Q3").
- Rental states are `platform.booking_commitments.state` (`db/migrations/0050_booking_commitments.sql:59`, widened
  `0059_booking_fulfilment.sql:3`), moved by definer SQL: confirm/cancel `0059:1007-1017`, kits `0059:816-819`,
  start/return `0059:432-436`, timer completed/noShow `0059:385-417`, hold expiry `0053_booking_authority.sql:344-354`.
- Every single move ends in `booking_record_change` (`0050:345-364`), every kit move in `booking_record_kit`
  (`0059:326-350`): one `platform.booking_history` row per (booking, revision) (PK `0050:109`) with before/after facts,
  then one trust chain via `booking_evidence` (`0059:14-91`; causation = `actor.cause`, `0059:44`).
- Booking runs in `withTrustedRequestTransaction` (`booking-capability-executor.ts:113,230`). `north_star.creation_action`
  is set only by the trust service and posting kernel (`postgres-trust-service.ts:155,228`, `inventory-posting-service.ts:1511`),
  so 0070's seal (`0070:74-90`) never fires for booking, and a sweep commits many receipts in one transaction
  (`0059:103-120`), which the one-shot "sealed" marker (`0070:46-47,86`) would refuse. Engine facts need their own seal.

## 2. Declaration — the engine owns its catalog
- Generic `packages/canonical-model/src/engine-facts.ts`: strict `EngineFactDeclaration` = `{factId, subject, owner,
  values:[valueId], moves:[[from,to]]}`, canonical IDs only. It names no engine.
- Booking declares in its own contract `packages/canonical-model/src/booking.ts` (booking row of
  `test/architecture/engines.manifest.json`): `northstar.booking:fact.commitment-state`, owner = the binding's
  `ownerEntity` (`booking.ts:27`), values `hold confirmed in-use returned completed no-show cancelled` (lower-kebab: the
  occurrence ID check `^[a-z][a-z0-9_.:-]{0,190}$`, `0070:48`, refuses `inUse`/`noShow`), moves = the edges above.
- Generic code gets facts as release data, never by import: booking already contributes compiled catalog terms
  (`bookingCatalogTerms`, `booking.ts:324`; read at `compiler.ts:2447`, `release-repository.ts:966`). The facts ride
  in those terms per active binding (UNVERIFIED that the term payload takes an added key without a reader change).
- Name guard: PRESS014 (`packages/dev-tooling/src/module-press-law.ts:1433-1442`). Generic migration, consumer, compiler
  and SDK name no engine; booking's emission is a separate migration added to the booking row; the baseline does not grow.

## 3. Occurrence shape and keys
- Reuse 0070's occurrence (s1 adds `kind`, `from_state`, `to_state`, s1 `0074:21-37`). Add kind `engineFact` and
  columns `fact_id`, `subject_id`, `subject_revision`, `invocation_id`; for this kind only, `writer_xid/request_id/
  action_id` are NULL (CHECK by kind), so the batch FK (`0070:22-23`, MATCH SIMPLE) is inert. Its seal is an FK
  `(tenant, env, invocation_id) → trust_action_invocations` (PK `0006_trust_substrate.sql:63`) `DEFERRABLE INITIALLY
  DEFERRED`: a fact whose receipt was never written refuses commit; a rollback removes both.
- `record_type/record_id/company_id` = the owning record, so dispositions (`0070:142`), the start key
  `workflow_instances_occurrence_start_key` (`0070:232-234`), page, capture, approval and Retry are reused as is.
- Exactly once: UNIQUE `(tenant, env, fact_id, subject_id, subject_revision)`. A real move bumps the revision and writes
  one history row; an idempotent replay returns the stored receipt and writes nothing (`0059:929`).
- Generic definer `north_star_internal.engine_facts(fact_id, invocation, physical_table, identity_column, record_type,
  record_id, subject_id, subject_revision, from_value, to_value)` reads company from the stored module row in the trusted
  scope as `record_creations` does (`0070:52-66`); refuses non-canonical IDs, row count ≠ 1, `from = to`. Booking calls
  it in `booking_record_change` and per kit member when a previous fact exists and its state differs (A1: a create is
  not a transition), and asserts the company equals `booking_owner_cursors.company_id`. A shared owner (company NULL,
  `0050:355`) emits nothing; §6 refuses a trigger on such a type, so no admitted subscription misses a fact.
## 4. Consumer, capture, non-matches
- Page (`0070:238-295`, keyed by subscribed record type, s1 B5) adds `kind, fact_id, subject_id`; the chain check
  (invocation SUCCEEDED → event → outbox → change document, `0070:265-292`) starts from `invocation_id`.
- Match (`workflow-consumer.ts:301-399`): engine-fact event type, same `record_type`, `fact_id`, `to_state`, and
  `from_state` NULL or equal. Eligible but unmatched resolves INELIGIBLE as s1 does (B5); the release/root check
  (`workflow-consumer.ts:335-343`) and loop rule `recordStartSkip` (`:409-422`, cause from `0059:44`) are unchanged.
- Trigger scope (`0070:300-330`, s1 B7) also joins `c.fact_id = d.fact_id` and the states: loadRun, approval, Retry
  re-derive from the occurrence, never the instance.
- Capture: `workflow_capture_watermark` seeds PRE_ACTIVATION by subscribed record type (`0070:415-419`); the binding
  carries `recordType`, so pre-activation facts start zero runs with no activation-hook edit.
- Named gap: timer moves record the original command's release (`0059:417`, `0053:354`), so after a release change they
  resolve INELIGIBLE (`workflow-consumer.ts:336`). Timer moves are outside the thin slice.
## 5. Trigger member, SDK event, rung
- `{kind:'engineFactChanged', triggerVersion:'v1', factId, recordTypeId, toValueId, fromValueId?}`, event type
  `northstar.runtime:event.engine-fact-changed`; definition row adds `fact_id`, appended to the digest (`0070:105-115`)
  and approval binding only when present, so earlier members keep their bytes (s1 B4).
- Event (table `workflow-trigger-events.ts:16-24`): `{type, eventId, factId, recordTypeId, recordId, legalEntityId,
  subjectId, fromValueId, toValueId}`; factId, recordTypeId, toValueId are literals as recordTypeId is (`:36-46`). No
  engine text or amounts. `workflow-execution.ts:717-730` and `runTrigger` (`:887-896`) gain the branch.
- Own reader rung at merge, never reserved (A1); provisional 55 after s1's provisional 54. Manual activation (A1).
## 6. Admission (compile, pinned release)
- Today `workflowTriggerRecordTypes` admits dedicated-table, non-null-company, created types (`compiler/src/workflows.ts:76-87`).
- Admit `engineFactChanged` only if an active engine binding in the release declares `factId` with owner `recordTypeId`,
  that type passes the company test, both values are declared, a declared move connects them, `from ≠ to`. Else
  `WorkflowTriggerBindingError` naming the fact (`workflows.ts:103-104`).
- Links stay "equal the run's trigger record" via a relation targeting its type (`workflow-gateway.ts:318-319,433-445`);
  the company check stays (`workflow-execution.ts:822-823`). The task links to the owner record, not the commitment.
## 7. Rule 12 — Customize drafting
- `workflowTriggerDrafterLines` (`workflow-trigger-events.ts:79-100`, used `ai-draft.ts:517`) gains a line generated
  from declared facts: "runs once each time fact F of a type-T record changes to V, once per subject (a kit of three
  commitments starts three runs); IDs only". Fixture schema per member (`:50-63`).
- Member coverage test (A1 rule 12) and evals beside `test/agent/build-eval-cases.ts:1781-1845`: rental "booking
  confirmed → prep task"; clinic "no-show → follow-up"; notify-only → reminder redirect; "invoice paid" with no declared
  fact → unsupported, never an invented transition; a hostile owner-type label does not change the calls.
## 8. Rule 8 reds (rule text not in repo, UNVERIFIED; used as at `ADR-0093:361`)
1 Fact without receipt → commit refused (drop FK: commits). 2 Rolled-back confirm → 0 occurrences. 3 Caller company ≠
stored → refused. 4 Duplicate (fact, subject, revision) → refused (drop UNIQUE: two runs). 5 `changeInterval`/pause
emit nothing (drop the state guard: occurrence). 6 Census `test/architecture/engine-fact-writers.test.ts`, shaped like
`record-creation-writers.test.ts`: each `INSERT INTO platform.booking_history` is followed by `engine_facts`. 7 Undeclared
fact/value/move or shared owner → compile refusal. 8 Scope with mismatched `fact_id` → no row. 9 Pre-activation fact →
PRE_ACTIVATION. 10 Generic file naming `booking` → PRESS014. 11 Companies A and B: one run each, own company; linking
B's owner from A's run refused. 12 Self-caused confirm → `self-caused` (UNVERIFIED that the gateway sets the booking
actor's `cause` to the run; if not, BUILD names that writer change).
## 9. Thin first slice and the stop
Generic migration (kind, FK, definer, digest/binding/page/scope), booking migration (emit in both history writers),
facts schema + booking declaration, member, SDK, admission, drafter, evals, reds 1-11. Proof
`test/postgres/workflow-engine-fact.test.ts`: one tenant, companies A and B, a rental owner type and a Task type
linking to it; a workflow on `commitment-state → confirmed` creates one linked task per confirm; hold, cancel and a
replayed confirm create none. Test it yourself: confirm a booking in A, see one task in A and none in B.
- **STOP before BUILD (A1 source audit; STOP (a)):** emitting from an engine writer is a Critical touch of a state
  writer that s1's O1 does not cover (s1 Q3 reserves capability writers to the owner). Needs an owner ruling.
- Ledger/invoice engines (ADR-0093, `0071_ledger_journal_core.sql`) later reuse §2-§3 with their own declarations.
