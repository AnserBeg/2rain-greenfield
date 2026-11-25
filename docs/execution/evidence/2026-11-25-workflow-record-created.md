# WORKFLOW-2 slice 4b — per-record creation occurrences and `recordCreated`

Branch `packet/WORKFLOW-2-s4b` from main `20762dbc`. Pre-tenant. Provisional migration `0070` and surface reader rung `51`; the integrator renumbers both at merge. [ADR-0073 A1](../../decisions/ADR-0073-workflow-isolate-and-authority.md#a1-triggers-on-customer-built-record-types)

## Claims

1. **Owner ruling 2026-11-21, built.** Every company-owned managed table carries a `record_creation` trigger. While the trust service or the posting kernel holds a transaction's creation action, each inserted row writes one occurrence (record type, record, owning company). The writer's own outbox insert seals them into one batch linked to its domain event; a deferred key refuses an unsealed occurrence at commit. A stock-count start records one occurrence per line, all on the count's one event.
2. **`recordCreated` is one typed declaration end to end.** The trigger union keeps the bare `'goodsReceiptPosted'` string byte for byte and adds `{kind: 'recordCreated', triggerVersion: 'v1', recordTypeId}`. Compile admits it only on a stored, active record type with exactly one owning company and raises the surface floor to rung 51. Admission persists `record_type` and covers it in the definition digest (a receipt definition hashes the same bytes as before). The approval binding and the activation watermark carry it; creations committed before activation are sealed out as `PRE_ACTIVATION`.
3. **Exactly once, per record, in its own company.** The scoped consumer reads a definer page of unresolved occurrences for subscribed types. The start key is (occurrence, workflow), so N records from one command start N runs; the receipt keeps (event, workflow). Company and record come from the occurrence's stored row, never from the script. A run re-derives that scope from the occurrence chain on every load.
4. **Loops are bounded.** A write a run commits names the run as its causation. A creation caused by the same workflow is skipped as `self-caused`; a chain deeper than 3 as `depth-exceeded`. Both are audited rows.
5. **Generated SDK event and drafter text.** `WORKFLOW_TRIGGER_EVENT_FIELDS` generates the SDK `TriggerEvent` (record type as a literal), the fixture schema and the drafter's member lines. The receipt declaration text is unchanged, so retained SDK pins are unchanged. Unattended links may name the run's trigger record, which generalises "links equal the receipt".
6. **Replay and evals.** Retiring the record type replays as `RETIRED_TARGET` naming it; a label rename replays clean. Four dated eval cases (clinic, school, distributor, hostile label) cover the member; a fail-closed test enumerates the trigger members inside `saveWorkflow`.

## Rule 16 and rule 17

- (a) Most general form: a durable, transaction-bound fact "a record of type T was created in company C by command E", for every company-owned record type, first-party or tenant; `recordCreated` is one consumer of it. (b) Unchanged users: clinics (appointments), schools (absences), distributors (deliveries, stock-count lines, receipts), field service (jobs), rentals (contracts). Any later consumer (reminders, audit feeds, integrations) can read the same occurrences. (c) Narrower on purpose: only governed writers record occurrences, because a creation without a trust event is not an ADR-0073 source; shared masters without one owning company cannot trigger, because a run needs a company scope.

## Controls (run after commit `7ecb9af4`, each restored)

- Restoring the unconditional (event, workflow) start key reds the start-key test alone.
- Dropping `record_type` from the definition digest reds its digest assertion alone.
- Removing the deferred seal key lets an unsealed occurrence commit: the "missing expected rejection" red.
- Emptying `WORKFLOW_TRIGGER_CASES` reds the fail-closed member coverage test.
- Not run locally: the clinic journey (seeding the composed application alone exceeded 12 minutes on this laptop). It runs in CI shard postgres-3.

## Stays narrow, and owed

- `recordTransitioned` and `scheduledOnField` (prompt names: lifecycleTransitioned, dueOnDate) and the school-absence status-change proof are the next slice.
- The archived preceding-reader proof for rung 51 is owed at merge, against the actual preceding serving tip (rule 13).
- Staff Retry after a rollback joins the receipt event chain only; a `recordCreated` run that suspends on a release switch is cancel-only until the retry terms read occurrences. It fails closed.
- A census of module-table writers outside the trust service and posting kernel is owed; such a write records no occurrence and has no trust event.
- Failure codes keep their receipt names (`WORKFLOW_OPERATION_RECEIPT_LINK_REFUSED`, `unavailable-receipt-source`) as persisted vocabulary.

## Test it yourself

- `node --import tsx --test test/unit/workflow-triggers.test.ts` — member coverage, receipt bytes, rung 51, replay and eval bases.
- `node --import tsx --test test/postgres/workflow-record-created.test.ts` — two appointments in two companies start two runs, an earlier one starts none, and a second poll starts nothing.
