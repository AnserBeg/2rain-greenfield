# AGENT-2 — the agent stops guessing (date, currency, permissions) and the terminal stops switching releases

Status: slices 1-3 integrated (merge `18ec624a`, CI run 44087242803, PR #47); slice 4 harness code integrated; real-model eval run 2026-11-17: 7 of 10 (bar 8) · Tier: Mechanical (no Critical path) · Stops taken: none
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

## Gates

CI: run 44087242803 green (14/14); earlier reds were fixed in-slice (a unit test importing the container-bearing task file; a required-currency assumption; `release root` parse of the lineage envelope; main's `customization-world.test.ts` constructing the session and `worldOver`, so `businessCalendar` is optional and says the date is unknown without it). Local: prettier, typecheck, eslint on changed files, `test/agent/operations-agent.test.ts` 9/9.

## Test it yourself

Start `corepack pnpm dev`. Then `NORTH_STAR_AGENT_KEY_FILE=/mnt/c/Users/rvham/rent_soft/.env corepack pnpm agent "Create and place a purchase order: 10 Field notebook from Cascade Fastener Works at 5.00"`: the plan shows CAD and today's Calgary date, not USD or yesterday. Run the same command from a checkout with a different release: it stops with "The dev database is serving release ... but this checkout is release ...".

## Filed

- CUSTOMIZE (harness): under a scope mismatch the receive task's scripted run answered with no refused tool call while posting nothing; only its end-state check caught it.
- A plan whose last step fails still leaves earlier creates as drafts (no compensation; out of scope).
