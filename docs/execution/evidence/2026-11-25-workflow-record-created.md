# WORKFLOW-2 slice 4b — per-record creation occurrences and `recordCreated`

Branch `packet/WORKFLOW-2-s4b` from main `20762dbc`. Pre-tenant. Provisional migration `0070` and surface reader rung `51`; the integrator renumbers both at merge. [ADR-0073 A1](../../decisions/ADR-0073-workflow-isolate-and-authority.md#a1-triggers-on-customer-built-record-types)

## Claims

1. **Owner ruling 2026-11-21, built.** A governed writer names each company-owned record it inserts through one definer function, `north_star_internal.record_creations`, which reads the company from the stored row and refuses a claim for a record its scope does not store. It records only while the trust service or the posting kernel holds the transaction's creation action. The writer's own outbox insert seals the occurrences into one batch linked to its domain event; a deferred key refuses an unsealed occurrence at commit. The generic interpreter create (every form, API, assistant and workflow create of a first-party or tenant type) and the stock-count start (one occurrence per line, all on the count's one event) emit today. The first design put an `AFTER INSERT` trigger on every company-owned managed table; full CI 45608668180 showed the preceding binary refusing that catalog (`CATALOG_DRIFT`), so the managed catalog is now unchanged.
2. **`recordCreated` is one typed declaration end to end.** The trigger union keeps the bare `'goodsReceiptPosted'` string byte for byte and adds `{kind: 'recordCreated', triggerVersion: 'v1', recordTypeId}`. Compile admits it only on a stored, active record type with exactly one owning company and raises the surface floor to rung 51. Admission persists `record_type` and covers it in the definition digest (a receipt definition hashes the same bytes as before). The approval binding and the activation watermark carry it; creations committed before activation are sealed out as `PRE_ACTIVATION`.
3. **Exactly once, per record, in its own company.** The scoped consumer reads a definer page of unresolved occurrences for subscribed types. The start key is (occurrence, workflow), so N records from one command start N runs; the receipt keeps (event, workflow). Company and record come from the occurrence's stored row, never from the script. A run re-derives that scope from the occurrence chain on every load.
4. **Loops are bounded.** A write a run commits names the run as its causation. A creation caused by the same workflow is skipped as `self-caused`; a chain deeper than 3 as `depth-exceeded`. Both are audited rows.
5. **Generated SDK event and drafter text.** `WORKFLOW_TRIGGER_EVENT_FIELDS` generates the SDK `TriggerEvent` (record type as a literal), the fixture schema and the drafter's member lines. The receipt declaration text is unchanged, so retained SDK pins are unchanged. Unattended links may name the run's trigger record, which generalises "links equal the receipt".
6. **Replay and evals.** Retiring the record type replays as `RETIRED_TARGET` naming it; a label rename replays clean. Four dated eval cases (clinic, school, distributor, hostile label) cover the member; a fail-closed test enumerates the trigger members inside `saveWorkflow`.

## Rule 16 and rule 17

- (a) Most general form: a durable, transaction-bound fact "a record of type T was created in company C by command E", for every company-owned record type, first-party or tenant; `recordCreated` is one consumer of it. (b) Unchanged users: clinics (appointments), schools (absences), distributors (deliveries, stock-count lines, receipts), field service (jobs), rentals (contracts). Any later consumer (reminders, audit feeds, integrations) can read the same occurrences. (c) Narrower on purpose: only governed writers record occurrences, because a creation without a trust event is not an ADR-0073 source; shared masters without one owning company cannot trigger, because a run needs a company scope.

## Controls (each after a commit, each restored)

- Restoring the unconditional (event, workflow) start key reds the start-key test alone.
- Dropping `record_type` from the definition digest reds its digest assertion alone.
- Removing the deferred seal key lets an unsealed occurrence commit: the "missing expected rejection" red.
- Emptying `WORKFLOW_TRIGGER_CASES` reds the fail-closed member coverage test.
- Removing the stock-count `recordCreations` call reds the writer census.
- The clinic journey passed in CI 45608668180 (shard postgres-3) on the trigger design; it has not run on the writer design. Locally, seeding the composed application alone exceeded 12 minutes.

## Stays narrow, and owed

- `recordTransitioned` and `scheduledOnField` (prompt names: lifecycleTransitioned, dueOnDate) and the school-absence status-change proof are the next slice.
- Rule 13 (built): in the clinic journey the preceding binary at `20762dbc` answers a governed query on the Appointment release, whose persisted bytes equal its own compile of the recorded change, then refuses the workflow release by name (surface-manifest requires 51, supports 48). The integrator re-pins the predecessor at merge.
- Staff Retry after a rollback joins the receipt event chain only; a `recordCreated` run that suspends on a release switch is cancel-only until the retry terms read occurrences. It fails closed.
- Writer census (`test/architecture/record-creation-writers.test.ts`): posting-kernel movements and companion documents, settlement lines and the receipt a purchase-order approval opens do not emit yet (owed, slice 5). Seeds and projection rows are not record creations. SQL definer functions only read managed tables.
- The stock-count fixture this proof uses starts a count with one stocked item, so N>1 on one event rests on the start-key schema test and the per-line writer call.
- Failure codes keep their receipt names (`WORKFLOW_OPERATION_RECEIPT_LINK_REFUSED`, `unavailable-receipt-source`) as persisted vocabulary.

## Test it yourself

- `node --import tsx --test test/unit/workflow-triggers.test.ts` — member coverage, receipt bytes, rung 51, replay and eval bases.
- `node --import tsx --test test/postgres/workflow-record-created.test.ts` — two appointments in two companies start two runs, an earlier one starts none, and a second poll starts nothing.
- `node --import tsx --test test/architecture/record-creation-writers.test.ts` — every managed-table insert is classified.
