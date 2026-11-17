# AGENT — the five tools over existing operations, and ten real-model tasks

Status: all three slices built; CI green; real-model eval 9 of 10 (week-6 bar 8 of 10) · Tier: Mechanical (no Critical path) · Stops taken: none
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
- Envelopes per plan §9.2: `erp_discover(mode: context|search|contracts|resolve, ...)`; `erp_query` builds the shared-list envelope from `search`, a preset `view`, exact `filters` and `parent`; `erp_plan` intents `{operationId, target?, values?, patch?, relations?, arguments?}` with `{"fromStep": n}` bindings; `erp_execute(planId, executionIdempotencyKey)`; `erp_verify(operationSessionId)`.
- Approval is a host port, asked once per plan inside `erp_plan`; the terminal asks y/N on a TTY and approves nothing otherwise; the harness approves and writes an `approval` line.
- Exact decimals are written canonically (`12.50` -> `12.5`): the gateway refuses trailing zeros, and reads return 18-place strings.
- The terminal opens its own runtime on the `pnpm dev` database (`openComposedApplicationRuntime`, split out of `startComposedApplication`): a grant is signed by the process that issues it.
- The harness installs the release once into a base database and gives each task a `CREATE DATABASE ... TEMPLATE` copy (about 4 s, against about 3 min per install).
- OpenAI: the key name is parsed but no adapter is built. Slices 1 and 2 merged together (the write tools were done before slice 1's CI ran). Turn limit 40; no sleeps and no retries beyond the SDK's two; the harness checks its USD cap before every model call; the terminal has only the turn limit.

## Result (slice 3, run 2026-11-17; [result file](../evidence/2026-11-17-agent-eval.md), JSONL per task beside it)

`claude-opus-5-5`, effort high; prices from platform.claude.com/docs/en/about-claude/pricing read 2026-11-17 (USD/MTok: input 4, output 20, cache write 5, cache read 0.20). **9 of 10 passed; total USD 1.6310; cost per completed task USD 0.1812.** Tool calls per task 6 / 8 / 6 / 17 / 25 / 28 / 26 / 31 / 16 / 2. Task 3 failed its pre-registered rule: the answer named both unpaid invoices and the 52.50 total correctly, and also mentioned the paid INV-000001 as "fully paid"; the rule ("does not name the paid invoice") is stricter than the question. The result stands as registered; a reworded rule applies only to a later, separately dated run. The eval ran at `f0eb507f`. The system prompt's availability and only-what-was-asked rules and the delete note in discovery were written knowing the ten tasks; no real-model run preceded this one. The three terminal checks below were further real-model runs (about 300k tokens in, mostly cached, 8.6k out; at most about USD 0.4) outside this total and its cap.

## Slices

1. Read (`erp_discover`, `erp_query`, terminal) and 2. Write (`erp_plan`, `erp_execute`, `erp_verify`): Test it yourself below. 3. Measure: `corepack pnpm agent:eval` (prices required as arguments), result file and per-task JSONL run records under `docs/execution/evidence/`.

## Gates

CI at `f0eb507f` (PR #42, [run 44030692398](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44030692398)): 14 of 14 jobs green. Merge SHA: the ledger row. Local: format, typecheck, lint, `check:boundaries` PASS, audit (high) clean, `test/agent/operations-agent.test.ts` 5/5, `test/postgres/agent-tasks.test.ts` green.

## Test it yourself (observed 2026-11-17 on a fresh dev container `dev-agent-check`, stopped with SIGINT)

Observed: the read answered 0 on hand (fresh seed, correct; 11 tool calls). The write showed a 3-step plan, `y` placed PO-000001 (10 x Field notebook at 5.00, verified). The receive showed a 3-step plan, `y` posted RCV-000001; the PO list read ordered 10, received 10, open 0, and the stock balance page read Field notebook CAL-WH 10 EA. The model chose USD and yesterday's date for the PO (filed).

Start `corepack pnpm dev` and wait for the URL. In a second terminal: `NORTH_STAR_AGENT_KEY_FILE=/mnt/c/Users/rvham/rent_soft/.env corepack pnpm agent "How many Field notebooks are on hand at Calgary warehouse?"` — compare with Stock by item. Then
`... corepack pnpm agent "Create and place a purchase order: 10 Field notebook from Cascade Fastener Works at 5.00"`, answer `y` to the plan, then `... corepack pnpm agent "Receive purchase order PO-000001 in full into Calgary warehouse"`; the UI shows the order received and Stock by item +10.

## Filed

- Discovery results are not filtered by the person's permissions before use (plan §9.2.1); the gateway refuses on use. A plan whose last step fails leaves its earlier creates committed as drafts (no compensation; no hard delete exists).
- The agent is not told today's date or the company's default currency; in the terminal check it guessed USD and yesterday's date for a PO. `erp_discover` context could carry both. Task 3's pass rule fails a correct answer that names the paid invoice as paid; reword before the next dated run.
- Harness: a same-day rerun (even `--tasks 3`) overwrites `<date>-agent-eval.md` (name it by run timestamp); JSONL appends are not awaited in order, so some lines are out of call order (sort by `at`; queue them).
- The terminal opened from a checkout whose compiled release differs from the dev database's installs and activates that release there, as `pnpm dev` from that checkout would; compare release roots and refuse.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "AGENT",
  "base": "ed48300b3dbe7cab742f173624b49966d1dc59ec",
  "head": "fc0baa74d53edc684f1dce4843d07d108737b9f5",
  "changedPaths": [
    "apps/api/package.json", "apps/api/src/agent-cli.ts", "apps/api/src/composition-root.ts", "docs/execution/packets/AGENT.md", "package.json",
    "packages/operations-agent/package.json", "packages/operations-agent/src/anthropic-model.ts", "packages/operations-agent/src/catalog.ts",
    "packages/operations-agent/src/index.ts", "packages/operations-agent/src/keys.ts", "packages/operations-agent/src/loop.ts",
    "packages/operations-agent/src/model.ts", "packages/operations-agent/src/session.ts", "packages/operations-agent/src/tools.ts", "pnpm-lock.yaml",
    "test/agent/agent-world.ts", "test/agent/arrange.ts", "test/agent/eval-harness.ts", "test/agent/operations-agent.test.ts",
    "test/agent/reference-scripts.ts", "test/agent/tasks.ts", "test/architecture/repository-hygiene.test.ts", "test/helpers/reachability-producers.ts",
    "test/postgres/agent-tasks.test.ts"
  ],
  "symbols": [
    {"path": "packages/operations-agent/src/session.ts", "name": "OperationsAgentSession"},
    {"path": "packages/operations-agent/src/loop.ts", "name": "runOperationsAgent"},
    {"path": "packages/operations-agent/src/keys.ts", "name": "loadModelKey"},
    {"path": "packages/operations-agent/src/anthropic-model.ts", "name": "anthropicModel"},
    {"path": "apps/api/src/composition-root.ts", "name": "openComposedApplicationRuntime"}
  ]
}
```
