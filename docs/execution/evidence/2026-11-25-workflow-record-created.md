# WORKFLOW-2 slice 4b — per-record creation occurrences and `recordCreated`

Branch `packet/WORKFLOW-2-s4b` from main `20762dbc`. Pre-tenant. Provisional migration `0070` and surface reader rung `51`; the integrator assigns both at merge (rungs 49 and 50 stay unclaimed here). [ADR-0073 A1](../../decisions/ADR-0073-workflow-isolate-and-authority.md#a1-triggers-on-customer-built-record-types)

**Apply condition (pre-tenant re-baseline).** 0070 validates the new `workflow_instances` source check over existing rows, and updates on that table are rule-blocked. It applies only to a database that stores no workflow instance yet; a database with instances is re-baselined (ADR-0066).

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45735183699

Run 45735183699 on `d66446fa` is red. Attempt 1: every PostgreSQL job passed. workflow-consumer took 458 s (900 s bound), and its approval subtests took 11 / 3 / 4 s. workflow-record-created's two journeys took 159 s and 284 s, and the retried-wait case passed. Shard 1 took 883 s and shard 3 took 29.6 minutes. One browser test failed when its fixture did not stop after SIGTERM (`table-behavior.spec.ts:174`), and executed-file reachability failed as a consequence. Attempt 2 (a whole rerun): shard 3 hit its 30-minute job timeout on a slower runner before reaching this file, so the run was cancelled.

## Claims

1. **Owner ruling 2026-11-21, built.** A governed writer names each company-owned record it inserts through `north_star_internal.record_creations`. The function matches the record in its own company (tenant, environment, company, ID), takes the company from the stored row and refuses, by name, a record its company does not store, a creation outside a governed write and a creation after the seal. The writer's own outbox insert seals the occurrences into one batch on its domain event; a deferred key refuses an unsealed occurrence at commit. Emitting writers: the generic interpreter create (every form, API, assistant and workflow create, first-party or tenant), stock-count lines, posting-kernel companion transactions and lines, settlement lines and purchase-order approval records. A first design with a trigger on every managed table was refused by the preceding binary (`CATALOG_DRIFT`, CI 45608668180); the managed catalog is unchanged.
2. **`recordCreated`, one typed declaration end to end.** The union keeps `'goodsReceiptPosted'` byte for byte and adds `{kind: 'recordCreated', triggerVersion: 'v1', recordTypeId}`. Compile admits a type only when it is stored, active, owned by exactly one company and created by an active `createRecordEffect` operation of the release; the drafter offers the same list. The floor rises to rung 51. The digest and the approval binding cover the record type; a receipt hashes its old bytes. Creations before activation are sealed `PRE_ACTIVATION`.
3. **Exactly once, per record, in its own company.** One disposition per occurrence; the start key is (occurrence, workflow). A run re-derives its scope from the occurrence chain on every load, and so do the approval worklist and the staff Retry terms, so a recordCreated run can ask for approval and be retried. The worklist resolves each pending approval's company once, at the run's current fence: a wait that a release switch suspended and staff Retry moved to a new fence keeps its old-fence PENDING row, is listed once, and only its fresh plan decides it (fix `aaa79a534`; the journey case that proves it has not run yet, see Controls).
4. **Links.** A general trigger's run links only its trigger record, through a relation whose declared target type is the trigger's record type (ADR-0073 A1). The receipt keeps its value-only check.
5. **Loops.** A write a run commits names the run as its causation. A creation the same workflow caused is skipped `self-caused`; a chain deeper than 3 is skipped `depth-exceeded`. Both are audited rows.
6. **Drafter and evals.** The SDK `TriggerEvent` and the drafter's member lines are generated from `WORKFLOW_TRIGGER_EVENT_FIELDS`; the fixture schema is hand-written and pinned to that table by test. Retiring the type replays `RETIRED_TARGET`; a label rename replays clean. Eval cases RC01-RC04 (clinic, school, distributor, hostile label) have not run: no live model spend in this slice (dated 2026-11-25, owner WORKFLOW-2 slice 5).

## Worklist cost

- The F2 rewrite (`6238a4211`) changed the approval worklist's join order: the planner scanned the permissions and storage entities first and re-parsed the operation catalog for each pair, 9,724 parses and about 85 s per call on the receipt consumer journey's data, which pushed that journey past its 900 s bound in CI (runs 45644072298 and 45652522652). The trigger-company CTE (`026a5e7fe`) costs 0.25 ms; it was not the cause.
- `e1ddc6eec` matches the operation first and the target and permission through it, each as its own subquery, so each catalog is parsed once per approval: 129 ms for the real function call on the journey's data, with the same rows as before.

## Rule 16 and rule 17

- (a) Most general form: a durable, transaction-bound fact "a record of type T was created in company C by governed command E". (b) Unchanged users: clinics, schools, distributors, field service and rentals, for every company-owned type their release creates through a create operation. (c) Narrower on purpose: only creations (no occurrence kind yet; the transition member adds one); the `resolved` flag on the occurrence is the workflow consumer's own progress, so a second consumer needs its own cursor table; only governed writers emit; types without a create operation (ledger rows, projections, provisioned locks) and shared masters cannot trigger; no managed-table trigger, so older binaries keep verifying the catalog.

## Controls (each after a commit, each restored)

- An unconditional (event, workflow) start key, a digest without `record_type`, and a non-deferred seal key each red their own schema test.
- Emptying `WORKFLOW_TRIGGER_CASES` reds member coverage; removing the stock-count `recordCreations` call reds the writer census.
- Owed, not yet run: removing only the worklist's fence predicate in its trigger-company set should list a staff-retried wait twice and red the approval journey alone (expected-red `workflow-worklist-retried-wait-fence`, committed in `71a0e9d71`). Neither the journey case nor this red has run, locally or in CI; the control is dispatched separately.
- Not run locally (composed seeding exceeds 12 minutes here): the clinic, approval, link and loop journeys. They run in CI.

## Stays narrow, and owed

- `recordTransitioned` and `scheduledOnField` (prompt names: lifecycleTransitioned, dueOnDate) and the school-absence proof are the next slice.
- Rule 13 (built): the preceding binary at `20762dbc` answers a governed query on the Appointment release, byte-identical to its own compile of the recorded change, then refuses the workflow release by name. The integrator re-pins the predecessor.
- N>1 on one event is proven at the schema level (three records, one batch, one event) and by the per-occurrence start key; no journey creates several records in one command yet.
- Failure codes keep their receipt names as persisted vocabulary.
- Pre-existing WORKFLOW-1 behaviour, not a defect of this slice: a narrowing after activation fails closed. The approval journey narrows the one principal that is both activation approver and decider to a company for the decision, then restores it before dispatch, as the receipt journey does. Dispatch caps the activation approver's live grants by the exact (permission, resource, company, role) tuples pinned at activation (`workflow-gateway.ts:144-155`, `current-policy.ts:312-320`, pinned at `0070:388`), so a membership changed after activation, narrowed or widened, refuses with `current-policy-refused` until a new activation re-pins. An approver already company-scoped at activation passes for its own company by code (`current-policy.ts:348-354`); no journey proves that yet.

## Test it yourself

- `node --import tsx --test test/unit/workflow-triggers.test.ts` — member coverage, receipt bytes, rung 51, admission, replay, eval ids and the loop guard.
- `node --import tsx --test test/postgres/workflow-record-created.test.ts` — schema proofs; the journeys need the composed application.
- `node --import tsx --test test/architecture/record-creation-writers.test.ts` — every managed-table and SQL insert is classified.
