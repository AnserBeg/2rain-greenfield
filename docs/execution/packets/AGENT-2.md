# AGENT-2 — the agent stops guessing (date, currency, permissions) and the terminal stops switching releases

Status: slices 1-3 integrated (merge `18ec624a`, CI run 44087242803, PR #47); slice 4 harness code integrated; real-model eval 2026-11-17: 7 of 10 at 15:33, re-measured 9 of 10 at 16:52 (bar 8) · Tier: Mechanical (no Critical path) · Stops taken: none
Charter: [AGENT-2-charter.md](AGENT-2-charter.md) from `main` `e244abbd`. Branch `packet/AGENT-2`, base `08224859`.

## Claims

1. `erp_discover` context carries the company's business date (tenant zone and business-day boundary, ADR-0018) and the default currency (`business-context.ts`; `test/agent/operations-agent.test.ts`).
2. With no currency declared, context says so and carries none; a plan that names no currency writes none (`test/postgres/agent-tasks.test.ts`, scripted model).
3. Search, contracts and resolve return only operations and queries the acting person may use now; an unauthorized id loads as `denied`; the buyer and the manager see different catalogs (`agent-tasks.test.ts`).
4. `corepack pnpm agent` compares its compiled release root with the dev database's active pointer before opening any runtime and refuses on a difference; it reads, never installs or activates (`agent-release-guard.ts`, `agent-tasks.test.ts`).
5. The eval result file is named by run timestamp and created exclusively; JSONL lines are appended in call order (`test/agent/eval-harness.ts`).
6. The model still supplies no tenant, release, principal, permission or handler; no new tool, migration or projection.

## Decisions

- Context envelope: `today {date, asDateTime, timeZone, businessDayBoundary, use}` and `currency {default, offered, use}`; the business date is read from `COMPOSED_APPLICATION_INVENTORY_SCOPE` (the values provisioned into the database), passed as the session's required `businessCalendar`; a `clock` option lets a test fix "now".
- Default currency: the domain holds no company-level setting. It is read from the pinned surface projection's declared editor default for `*_currency` fields (CAD today); a customer's or supplier's own default currency takes precedence and is read from its record. More than one distinct default, or none, reports `null`.
- When neither the request, context nor a record gives a currency or date, the system prompt tells the model to leave an optional field out and, for a required one, plan nothing and ask in its answer.
- Eligibility: the operation gateway's existing `previewTaskEligibility` (plans are confirmed) and a new `SemanticQueryGateway.previewEligibility` (a disclosed small bridge in `packages/runtime`; no read, no denial row), cached per principal, policy version and release; a failed preview withholds the id.
- Release guard: a tenantAuthored descendant of this checkout's release matches (same parent-chain walk as `tenantDescendantOfLineageTip`); a descendant of another base says a customization of a different application version is active. New read-only `readActiveRelease` in `packages/postgres-provider` (a disclosed bridge; apps/api has no `pg`), plain refusal text; slices 1-3 merged together because their edits share files.
- Task 3 rule v2 (`task3AnswerFailures`, registered 2026-11-17, applies from the next run): the paid invoice may be named when called paid. The 2026-11-17 result stands as registered.

## Slices

1. Context. 2. Permission-filtered discovery. 3. Terminal release guard. 4. Harness hygiene, task-3 rule, new eval. Test it yourself below.

## Result (run 2026-11-17, [result file](../evidence/2026-11-17T15-33-32-358Z-agent-eval.md), JSONL beside it)

`claude-opus-5-5`, effort high, prices read 2026-11-17 (4 / 20 / 0.20 / 5 USD per MTok), task-3 rule v2. **7 of 10 passed; USD 1.2911 total; USD 0.1844 per completed task.** Tasks 1-5, 9, 10 pass (task 3 now passes). Failures: 6 (confirm refused: no ship-to on the order), 7 (shipment refused INVENTORY_STOCK_NEGATIVE), 8 (no payment: asked the person for a method). Task 7 traced to this packet: the context told the model to write dates as midnight UTC, so it posted `shipment_effective_at` at 00:00Z, before stock that arrived later that day. Fixed after the run: context now also carries `today.now` and says to use it for moments (postings, shipments, receipts); not re-measured. 6 and 8 read as model behavior (ship-to, payment method not named in the request), not tooling. The 7-of-10 stands as run; the next dated run owes a re-measure.

## Re-measure after the prompt fix (2026-11-17)

Tasks 6 and 8 had passed at 06:22 and failed at 15:33, so the "do not invent" prompt over-refused: a value held by a resolved record (the customer's default ship-to address) or a declared screen default must be used, and only a value that exists nowhere is asked for. Evidence that a default payment method exists: `invoice_method` is pre-selected to EFT in `packages/domain/src/sales/workspace.ts` (checked `sales/definition.ts`, `sales/workspace.ts`, `party/definition.ts`, `app/seed.ts`; no per-customer or per-invoice default exists). So task 8's request is unchanged (a "v3" naming the method was drafted and reverted); context now carries `formDefaults` (read from the surface projection) and the prompt points at them and at resolved records. Test: scripted plan fills ship-to from the customer's address record (`agent-tasks.test.ts`). The 06:22 (9/10) and 15:33 (7/10) results stand as run.

### Re-measure (run 2026-11-17 16:52, [result file](../evidence/2026-11-17T16-52-54-374Z-agent-eval.md), after merge `386731d3`)

Same model, prices and cap. **9 of 10 passed; USD 1.5282 total; USD 0.1698 per completed task.** Tool calls per task 6 / 7 / 6 / 12 / 21 / 15 / 26 / 28 / 17 / 2. Tasks 7 and 8 now pass (shipment at `now`; payment method from the declared EFT default). Task 6 failed: the model read availability, found no stock for the notebook and stopped without creating the order (the existing availability rule, not a missing address: it quoted the customer's ship-to). That rule predates this packet, and task 6 passed under it at 06:22 and failed at 15:33 for the ship-to reason, so task 6 is flaky across runs on a single attempt; not changed. All three results (9, 7, 9) stand as run.

## Gates

CI: run 44087242803 green (14/14); earlier reds were fixed in-slice (a unit test importing the container-bearing task file; a required-currency assumption; `release root` parse of the lineage envelope; main's `customization-world.test.ts` constructing the session and `worldOver`, so `businessCalendar` is optional and says the date is unknown without it). Local: prettier, typecheck, eslint on changed files, `test/agent/operations-agent.test.ts` 9/9.

## Test it yourself

Start `corepack pnpm dev`. Then `NORTH_STAR_AGENT_KEY_FILE=/mnt/c/Users/rvham/rent_soft/.env corepack pnpm agent "Create and place a purchase order: 10 Field notebook from Cascade Fastener Works at 5.00"`: the plan shows CAD and today's Calgary date, not USD or yesterday. Run the same command from a checkout with a different release: it stops with "The dev database is serving release ... but this checkout is release ...".

## Filed

- CUSTOMIZE (harness): under a scope mismatch the receive task's scripted run answered with no refused tool call while posting nothing; only its end-state check caught it.
- A plan whose last step fails still leaves earlier creates as drafts (no compensation; out of scope).
