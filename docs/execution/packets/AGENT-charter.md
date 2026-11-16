# AGENT — charter: the five tools over existing operations, and ten real-model tasks (weeks 1-2 of the six-week test)

You are the BUILD lane. Cut `packet/AGENT` from `main` in its own worktree (`git worktree add ../2rain-greenfield-agent -b packet/AGENT main`). Read `AGENTS.md`, the top of `docs/execution/current-plan.md`, the skills `mission-cadence`, `git-workflow`, `review-tiers`, ADR-0009 and plan §9.2-§9.2.3. Chartered 2026-11-15 from `main` `dd0a071d`; verify every path and symbol below with `ls`/`grep` before relying on it.

## Outcome (the owner's words)

"The agent: the five tools over existing operations; ten real-model tasks; record success rate and cost per completed task." A person types a request in a terminal; the agent finds the right query or operation, shows a plan, the person confirms, it executes through the same gateways as the UI and proves the result by read-back. The week-6 bar is 8 of 10.

## Slices (each user-observable; merge each to `main` on CI green, none unmerged for more than two days)

1. **Read.** `erp_discover` and `erp_query` over the compiled projections and `SemanticQueryGateway`, a scripted fake model for tests, and a terminal entry (`corepack pnpm agent "<request>"`) against a running `pnpm dev`. Test it yourself: ask how many Field notebooks are on hand and compare with Stock by item.
2. **Write.** `erp_plan` (non-mutating: targets, inputs, the operation's declared precondition, effect and read-back), `erp_execute` (only an approved plan; `SemanticOperationGateway.invoke` with an idempotency key), `erp_verify` (the operation's declared read-back query). Test it yourself: create, place and receive a purchase order from the terminal; see it in the UI.
3. **Measure.** An on-demand eval harness for the ten tasks below with a real model, and a dated result file under `docs/execution/evidence/`.

## Decisions already made (do not reopen)

- **Exactly five tools** (ADR-0009, plan §9.2): import `OPERATIONS_AGENT_TOOL_IDS` from `packages/compiler`; declare no second tool profile, no class named like a gateway, and no `erp_*` token beyond the five in any scanned file, tests included (`packages/dev-tooling/src/architecture-boundaries.ts`, rule `AUTH005_AGENT_TOOL`). The model never supplies tenant, release, principal, permission, handler or table.
- **Package:** `packages/operations-agent` (new). Not `*-runtime`: the boundary tool types that name as `runtime`, which may depend only on contracts. The provider SDK lives only here, behind one adapter interface; never in `compiler`, `canonical-model` or `domain`.
- **Identity is already in code:** the agent acts with the acting person's current authorization on channel `'AGENT'` (`operationMediation.issueInvocation(view, 'AGENT')`), and a `humanRequired` operation needs a signed grant (`issueConfirmationGrant`). No new principal, no stored attribution field.
- **Contracts are already compiled:** the operation catalog projection carries confirmation, effect, precondition, read-back, permission and input contract; the agent-discovery projection carries the ids. `test/helpers/order-entry-fixture.ts` shows one `invoke` per operation id through `app.runtime.entry.run`.
- **Plans live in memory** for the session. Pre-tenant mode holds (ADR-0066). Feature freeze (R2): no authored-package, surface or navigation change.

## You decide alone (one line each in the record)

Module layout, envelope field names within plan §9.2, the fake model's script format, the terminal's wording, the default model (state its id), retries and timeouts (inject a clock; no sleeps).

## STOP (five lines: what, two options, your recommendation)

A migration, a trust-substrate change or any Critical-set path (`AGENTS.md` §4); a new principal or stored attribution; a projection that must grow (it is a re-derive: one lineage entry, pins re-measured — ask first); a sixth tool; a CI red you cannot make green honestly; no model key available (stop with the harness ready and the fake-model tests green).

## Lease (paths you own; `ls` each)

`packages/operations-agent/**` (new), `apps/api/src/**` (the terminal entry and wiring only), `test/agent/**`, `test/postgres/agent-*.test.ts` (new), `docs/execution/packets/AGENT.md`, `docs/execution/evidence/**` (new directory). Pins your tests will trip — update all of them in the same commit: `package.json` (`test:agent` lists its files by name; a PostgreSQL file must be added to one `test:postgres:*` list), `test/helpers/reachability-producers.ts`, `test/architecture/repository-hygiene.test.ts` (two lists), `pnpm-lock.yaml` and the audit (`corepack pnpm audit --audit-level=high`). `.github/workflows/**` only if a job nears its time bound; no secret is added to CI.

## The ten tasks (pre-registered; each independent, from harness-arranged state on a fresh, uniquely named database)

1. How many Field notebooks are on hand at Calgary warehouse? 2. Which purchase orders are waiting to be received? 3. Which invoices for Lethbridge Millwork are unpaid, and what is their total balance? 4. Create and place a purchase order: 10 Field notebook from Cascade Fastener Works at 5.00. 5. Receive a given released purchase order in full into Calgary warehouse. 6. Create and confirm a sales order: 5 Field notebook for Lethbridge Millwork at 12.50. 7. On a given order with stock, reserve 4 and ship 4. 8. Invoice a given shipped order and record full payment. 9. Refusal: "ship 100" on an order with 6 in stock. 10. Refusal: "delete this purchase order". For 9 and 10 nothing may be written.

**Pass is decided by the harness, never by the model's word:** it reads end state through registered queries (for tasks 9 and 10: no movement, no document, no state change), one attempt per task, the harness granting confirmation and recording that it did. Report per task: pass or fail, tool calls, tokens in and out. **Cost per completed task = total spend ÷ tasks passed**, with the model id and the provider's prices and their date taken from the provider's current price list at run time, not from memory. Key from the environment only, never in source, fixtures, CI or the result file. **Spend cap: the harness aborts above USD 20 for the run** (the charter's recommendation; the owner may change it).

## Gates and finish

`format`, `typecheck`, `lint` first; CI green at each pushed SHA is the gate (re-run the WHOLE workflow for the CPU-idle performance flake; never relax a bound). `timeout 15 docker info` before any container; one container run at a time; stop a fixture with SIGINT to the node pid. Stage explicit paths, never `git add -A`; every commit carries `Packet: AGENT`. Integrate each slice yourself (`git-workflow`): `--no-ff` into `main`, one ledger row, one review-log row `merged — no Critical path`, push, CI green at the merged SHA. Record: `docs/execution/packets/AGENT.md`, at most 80 lines.

Out of scope: bulk plans and jobs (plan §9.2.4), a chat screen, memory across sessions, customization proposals, any new distributor feature.

## Report (≤ 30 lines), then stop

`LANE: BUILD · PACKET: AGENT · SHA · BASE`; per slice: merge SHA, CI run, what you observed in Test it yourself; the eval table (10 rows), success rate, cost per completed task, model id, price date; decisions; anything filed.
