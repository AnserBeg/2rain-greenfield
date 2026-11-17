# AGENT — the five tools over existing operations, and ten real-model tasks

Status: slices 1-2 built, CI pending; slice 3 harness built, real-model run pending · Tier: Mechanical (no Critical path) · Stops taken: none
Charter: [AGENT-charter.md](AGENT-charter.md) from `main` `dd0a071d` (key source `ed48300b`). Branch `packet/AGENT`, base `ed48300b`.

## Claims

1. The model sees exactly the compiled five tools (`OPERATIONS_AGENT_TOOL_IDS`); final answers are plain text; no sixth tool of any name (`test/agent/operations-agent.test.ts`, `check:boundaries`).
2. Reads enter `SemanticQueryGateway`; writes enter `SemanticOperationGateway.invoke` on channel `AGENT` with the acting person's authorization, a per-step idempotency key derived from (plan, execution key, step), and a grant issued only for a plan the person approved.
3. The model never supplies tenant, release, principal, permission, handler, table, company, create record id, expected revision, idempotency key or grant; a plan naming one is refused (`agent-tasks.test.ts` guards).
4. `erp_plan` writes nothing; a declined or changed plan cannot run; an executed plan replays only under its own key.
5. `erp_verify` reads every executed step back through the operation's declared read-back query and reports per step.
6. All ten tasks pass with the scripted reference solutions, judged by the harness's end-state checks (`test/postgres/agent-tasks.test.ts`).
7. No key value is printed, logged, committed or carried in an error (planted-key tests: file parsing, redaction, a provider 401 echoing the key).

## Pre-registered pass rules (written before the first real-model run; code: `test/agent/tasks.ts`)

Every task: the watched document lists (orders, lines, receipts, reservations, shipments, invoices, payments, movements, inventory transactions) change only by what the task's own operations write; read and refusal tasks change none. 1: the answer states Calgary's on-hand 6 (Vancouver holds 9). 2: the answer names both placed POs and not the draft. 3: names both unpaid Lethbridge invoices, not the paid one, and states the total balance 52.5. 4/6: exactly one new order, placed/confirmed, one line as asked. 5: Calgary on hand +8 through one posted receipt. 7: Calgary on hand 10 -> 6 through one posted shipment. 8: one new invoice, balance 0, one posted payment. 9 and 10: nothing written; the named order's revision unchanged.

## Decisions

- Layout: `packages/operations-agent` (`catalog`, `session`, `tools`, `model`, `loop`, `keys`, `anthropic-model`); it is kind `other` in the boundary tool, so the SDK is allowed there and nowhere else.
- Default model `claude-opus-5-5`, effort `high`, adaptive thinking, top-level prompt caching; official `@anthropic-ai/sdk` 1.8. Server-side refusal fallbacks are not enabled: the eval measures one model at one price, and a refusal counts as a fail.
- OpenAI: the key name is parsed (charter) but no OpenAI adapter is built; Anthropic is the only provider wired.
- Envelopes per plan §9.2: `erp_discover(mode: context|search|contracts|resolve, ...)`; `erp_query` builds the shared-list envelope from `search`, a preset `view`, exact `filters` and `parent`; `erp_plan` intents `{operationId, target?, values?, patch?, relations?, arguments?}` with `{"fromStep": n}` bindings; `erp_execute(planId, executionIdempotencyKey)`; `erp_verify(operationSessionId)`.
- Approval is a host port, asked once per plan inside `erp_plan`; the terminal asks y/N on a TTY and approves nothing otherwise; the harness approves and writes an `approval` line.
- Exact decimals are written canonically (`12.50` -> `12.5`): the gateway refuses trailing zeros, and reads return 18-place strings.
- Discovery is not policy-filtered: denial happens at the gateway on use (filed).
- The terminal opens its own runtime on the `pnpm dev` database (`openComposedApplicationRuntime`, split out of `startComposedApplication`): a grant is signed by the process that issues it.
- The harness installs the release once into a base database and gives each task a `CREATE DATABASE ... TEMPLATE` copy (about 4 s, against about 3 min per install).
- Turn limit 40; no sleeps and no retries beyond the SDK's two; the spend cap is checked before every model call.
- Slices 1 and 2 merged together: the write tools were finished before slice 1's CI ran.

## Slices

1. Read — `erp_discover`, `erp_query`, terminal. Test it yourself below.
2. Write — `erp_plan`, `erp_execute`, `erp_verify`. Test it yourself below.
3. Measure — `corepack pnpm agent:eval` (prices required as arguments), result file and per-task JSONL run records under `docs/execution/evidence/`.

## Gates

CI and merge SHAs: see the ledger row. Local: format, typecheck, lint, `check:boundaries` PASS, audit (high) clean, `test/agent/operations-agent.test.ts` 5/5, `test/postgres/agent-tasks.test.ts` green.

## Test it yourself

Start `corepack pnpm dev` and wait for the URL. In a second terminal:
`NORTH_STAR_AGENT_KEY_FILE=/mnt/c/Users/rvham/rent_soft/.env corepack pnpm agent "How many Field notebooks are on hand at Calgary warehouse?"` — compare with Stock by item. Then
`... corepack pnpm agent "Create and place a purchase order: 10 Field notebook from Cascade Fastener Works at 5.00"`, answer `y` to the plan, then
`... corepack pnpm agent "Receive purchase order PO-000001 in full into Calgary warehouse"`; the UI shows the order received and Stock by item +10.

## Filed

- Discovery results are not filtered by the person's permissions before use (plan §9.2.1); the gateway refuses on use.
- A plan whose last step fails leaves its earlier creates committed as drafts (no compensation; no hard delete exists).
