# WORKFLOW-2 triggers — source audit and build checkpoint

The source audit uses main at `af255bf7`. The build checkpoint at `7493b900` awaits the writer decision in ADR-0073 A1. Full packet CI is pending.
The completed changes cover workflow review and worker registration. Both blocks serve distribution, clinics and schools.

## Completed slices

1. R1. The compiler examines parsed token trivia and refuses SDK v2 event waits by method name. A string containing a directive still compiles. SDK v1 retains its wait.
2. R2. Every direct SDK call rejects spread arguments, including an approval whose operation and inputs would otherwise be hidden from the call-site review.
3. R3. SDK v2 rejects control characters and line separators in an approval summary. The review prints a JSON string on one line, including when rendering a historical sample.
4. Booking registers its own bounded due sweep at application startup. The scheduler runs it on the worker connection and still polls workflows when a booking pass fails.

## Source audit

- The form, operations assistant and workflow gateway invoke the semantic operation gateway. The generic interpreter executes the create or transition and returns its trust command in the same transaction. A create records the type, ID and revision 1. A transition records the compiled old and new states. The release's operation definition identifies the effect. No separate tenant-record import writer was found on this base. [Form](../../../apps/web/src/surface-runtime.ts) · [Assistant](../../../packages/operations-agent/src/session.ts) · [Workflow gateway](../../../packages/postgres-provider/src/workflow-gateway.ts) · [Writer](../../../packages/postgres-provider/src/module-runtime-interpreter.ts)
- The generic event metadata supplies the operation ID and request kind. The stored company's source is the owning column of the pinned storage entity, scoped by tenant and environment. The workflow gateway already supplies the run ID to the interpreter for its write fence, but the successful invocation's causation ID is null. ADR-0073 A1 already specifies this causation change.
- **Missing committed fact.** Starting a full stock count inserts one company-owned count-line record per eligible item. Each gets a new UUID and revision 1. The sole change document identifies the parent count and the event contains the line count. Neither identifies those new records. A subscriber to count-line creation cannot determine which lines it missed from that event. [Count writer](../../../packages/postgres-provider/src/stock-count-route.ts) · [Stock-count journey](../../../test/postgres/inventory-stock-counts.test.ts)
- The trust schema makes each change document, domain event and outbox row unique by scoped invocation. A second ordinary event for a child needs a change to that storage contract or an admitted per-record fact linked to the parent event. I recommend authorizing transactional evidence for each affected record with a stable identity for each occurrence. This preserves coverage of first-party and tenant types. [Trust substrate](../../../db/migrations/0006_trust_substrate.sql) · [Owner-decision stop](../../decisions/ADR-0073-workflow-isolate-and-authority.md#a1-triggers-on-customer-built-record-types)
- Slice 4a is a separate Critical prerequisite in ADR-0073 A8. At this base the consumer starts all matching definitions immediately, with no deferred-start or rate-limit-overflow storage. [Consumer](../../../packages/postgres-provider/src/workflow-consumer.ts) · [Slice order](../../decisions/ADR-0073-workflow-isolate-and-authority.md#a8-order-and-gates)
- Receipt, appointment-created, absence-transition and scheduled-trigger acceptance, Customize, reader rungs, persisted bytes and replay proofs remain open. The **2026-11-21 AI-BUILD-1 exception** covers the module-building eval registry, which is absent on this base. AI-BUILD-1 owns the registry. The trigger lane owes the member cases when it is available.

## Controls and test it yourself

- After commit, independently disabled the parsed-trivia check, named wait check, spread check, control-character check and JSON quoting. Each focused regression failed at its assertion. Removing the registered jobs from scheduler startup also failed the Booking test.
- Run `node --import tsx --test --test-name-pattern='parsed trivia|SDK call sites refuse|approval summaries reject|v2 drops' test/integration/workflow-host.test.ts`. Expect four passes, including the v1 compatibility fixture.
- Run `node --import tsx --test --test-name-pattern='Booking registers|workflow scheduling' test/integration/workflow-host.test.ts`. Expect both passes, including workflow polling after a simulated booking error.
- Other lanes occupied Docker. This checkpoint used no database container. The writer finding comes from source inspection.
