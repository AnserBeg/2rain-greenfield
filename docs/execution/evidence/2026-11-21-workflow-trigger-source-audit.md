# WORKFLOW-2 triggers — source audit and build checkpoint

The source audit uses main at `af255bf7`. The owner authorized the writer change in ADR-0073 A1 on 2026-11-21. The merge-line gate is a full run on the packet tip.
This checkpoint covers workflow review, scheduled worker registration and run admission. These platform blocks support distribution, clinics and schools.

## Completed slices

1. R1. The compiler examines parsed token trivia and refuses SDK v2 event waits by method name. A string containing a directive still compiles. SDK v1 retains its wait.
2. R2. Every direct SDK call rejects spread arguments, including an approval whose operation and inputs would otherwise be hidden from the call-site review.
3. R3. SDK v2 rejects control characters and line separators in an approval summary. The review prints a JSON string on one line, including when rendering a historical sample.
4. Booking registers its own bounded due sweep at application startup. The incoming Comms inbox sweep also registers its own handler. The scheduler runs it on the worker connection and still polls workflows when a booking pass fails.

## Slice 4a — workflow run admission

A single database policy limits starts per tenant/environment and workflow per rolling hour, counts runnable and open runs separately, and bounds deferred starts. Admission uses the event and workflow identities. The same policy can cover a distributor, a clinic or a school as their triggers become available. The platform operator configures the limits. Creating a new trigger member remains a separate release capability.

Each verified event keeps a distinct admission decision per matching workflow. The worker retries due starts on the original verified fence. Sleeping runs and pending approvals retain an open slot, and a ready run waits for runnable capacity. A verified activation records each discarded start against its new fence. Customize shows the current discard count before activation.

The Approvals worklist shows waiting starts and flags queue overflow. On the operator database connection, run `SELECT north_star_internal.workflow_manage_start(tenant, environment, instance, 'release')` or use `'dismiss'`. Supply the three UUIDs for the waiting start. Release rechecks the normal budgets, and an overflow can rejoin when the queue has room.

The packet uses provisional migration 0067 after TRAIN-D. Allocate its final number in the merge window. ADR-0073 A8 lands slice 4a before the first trigger member. The source declaration, per-record writer change and the three general triggers follow this checkpoint.

## Source audit

- The form, operations assistant and workflow gateway invoke the semantic operation gateway. The generic interpreter executes the create or transition and returns its trust command in the same transaction. A create records the type, ID and revision 1. A transition records the compiled old and new states. The release's operation definition identifies the effect. No separate tenant-record import writer was found on this base. [Form](../../../apps/web/src/surface-runtime.ts) · [Assistant](../../../packages/operations-agent/src/session.ts) · [Workflow gateway](../../../packages/postgres-provider/src/workflow-gateway.ts) · [Writer](../../../packages/postgres-provider/src/module-runtime-interpreter.ts)
- The generic event metadata supplies the operation ID and request kind. The stored company's source is the owning column of the pinned storage entity, scoped by tenant and environment. The workflow gateway already supplies the run ID to the interpreter for its write fence, but the successful invocation's causation ID is null. ADR-0073 A1 already specifies this causation change.
- **Missing committed fact.** Starting a full stock count inserts one company-owned count-line record per eligible item. Each gets a new UUID and revision 1. The sole change document identifies the parent count and the event contains the line count. Neither identifies those new records. A subscriber to count-line creation cannot determine which lines it missed from that event. [Count writer](../../../packages/postgres-provider/src/stock-count-route.ts) · [Stock-count journey](../../../test/postgres/inventory-stock-counts.test.ts)
- The trust schema makes each change document, domain event and outbox row unique by scoped invocation. A second ordinary event for a child needs a change to that storage contract or an admitted per-record fact linked to the parent event. The owner authorized transactional evidence for each affected record with a stable identity for each occurrence. This preserves coverage of first-party and tenant types. [Trust substrate](../../../db/migrations/0006_trust_substrate.sql) · [Owner-decision stop](../../decisions/ADR-0073-workflow-isolate-and-authority.md#a1-triggers-on-customer-built-record-types)
- At the audited base the consumer started all matching definitions immediately. Slice 4a supplies the durable queue and overflow disposition. [Consumer](../../../packages/postgres-provider/src/workflow-consumer.ts) · [Slice order](../../decisions/ADR-0073-workflow-isolate-and-authority.md#a8-order-and-gates)
- Receipt, appointment-created, absence-transition and scheduled-trigger acceptance, Customize, reader rungs, persisted bytes and replay proofs remain open. The **2026-11-21 AI-BUILD-1 exception** covers the module-building eval registry, which is absent on this base. AI-BUILD-1 owns the registry. The trigger lane owes the member cases when it is available.

## Controls and test it yourself

- After commit, independently disabled the parsed-trivia check, named wait check, spread check, control-character check and JSON quoting. Each focused regression failed at its assertion. Removing the registered jobs from scheduler startup also failed the Booking test.
- Run `node --import tsx --test --test-name-pattern='parsed trivia|SDK call sites refuse|approval summaries reject|v2 drops' test/integration/workflow-host.test.ts`. Expect four passes, including the v1 compatibility fixture.
- Run `node --import tsx --test --test-name-pattern='Booking registers|workflow scheduling' test/integration/workflow-host.test.ts`. Expect both passes, including workflow polling after a simulated booking error.
- On an operator connection to a migrated database, run `TABLE north_star_internal.workflow_start_limits;`. The defaults are 600 starts per hour per tenant/environment, 120 per workflow, 200 runnable, 10,000 open and 10,000 deferred. In the Approvals worklist, a release operator sees waiting starts and an alert for overflow.
- After activation, `SELECT tenant_id, environment_id, pointer_id, discarded_at_fence, count(*) FROM platform.workflow_deferred_starts WHERE disposition = 'activation-discarded' GROUP BY 1,2,3,4;` reports exactly which verification fences discarded starts.
- PostgreSQL 16 admitted the scoped receipt and accounted for all 5,000 test events. Removing the wake, open-run, deferred-queue, per-workflow and per-environment limits separately failed the respective assertions. The repository journey exercises restart, same-event fan-out and verified rollback. [Database test](../../../test/postgres/workflow-consumer.test.ts) · [Import and capacity checks](../../../test/helpers/workflow-start-limits.ts)
- Other lanes occupied Docker. The local database proofs used private native PostgreSQL instances. The per-record writer finding comes from source inspection.
