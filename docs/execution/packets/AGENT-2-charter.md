# AGENT-2 — charter: the agent stops guessing (date, currency, permissions) and the terminal stops switching releases

You are the BUILD lane. Chartered 2026-11-17 from `main` `e244abbd` by the orchestrator. Worktree
`/home/rvham/2rain-greenfield-agent-2`, branch `packet/AGENT-2`. Read `AGENTS.md`, `mission-cadence`,
`git-workflow`, the AGENT record (`docs/execution/packets/AGENT.md`, its Decisions and Filed sections) and plan §9.2.1.
Verify every path and symbol with `ls`/`grep` before relying on it.

## Outcome
The four lines the AGENT packet filed on 2026-11-17 (`current-plan-archive.md`, *Filed during the freeze*) are fixed. The
first matters most: in the terminal check the agent guessed USD and yesterday's date on a real purchase order.

## Slices (merge each to `main` on CI green)
1. **Context, no guessing.** `erp_discover` context carries the company's business date and its default currency.
   - The business date uses the tenant time zone and business-day boundary (ADR-0018); verify where they live first.
   - The default currency comes from where the domain already holds it.
   - When the request names neither and the operation's input needs a currency or date the model cannot get from context or a
     resolved record, the plan says so instead of inventing one.
   - Test: a scripted-model test proves that a currency absent from the request and context is never written.
2. **Permission-filtered discovery (plan §9.2.1).** Catalog search and contract loading return only queries and operations the acting
   person may use under current authorization. An unauthorized id loads as `denied`, not as a contract.
   - Test: two people with different roles get different catalogs.
3. **The terminal refuses a foreign release.** `corepack pnpm agent` compares its compiled release root with the dev database's
   active pointer and refuses with a plain message when they differ. It never installs or activates.
   - The CUSTOMIZE lane changes activation in parallel and was told the terminal must not switch the pointer. You own this fix.
4. **Harness hygiene.**
   - Name the result file by run timestamp, never overwriting.
   - Queue JSONL appends in call order.
   - Register a corrected task-3 rule for future runs, dated, with the 2026-11-17 result left as registered.
   - Then run the real-model eval once (cap USD 20) and add the new dated result.

## Decided (do not reopen)
No new tool. No migration. No projection growth. The model still never supplies tenant, release, principal, permission or
handler. Plan compensation for a failed last step is out of scope.

## You decide alone (one line each in the record)
Field names in the context envelope, the refusal wording, and how the date and currency are looked up.

## STOP (five lines: what, two options, recommendation)
A Critical-set path (`AGENTS.md` §4), a migration, a projection change, a sixth tool, or a CI red you cannot fix honestly.

## Lease
`packages/operations-agent/**`, `apps/api/src/**` (agent entry and wiring only), `test/agent/**`, `test/postgres/agent-*.test.ts`,
`docs/execution/packets/AGENT-2.md`, `docs/execution/evidence/**`, plus the pins your tests trip (`package.json` lists,
`reachability-producers.ts`, `repository-hygiene.test.ts`).
The CUSTOMIZE lane may import the provider adapter from `packages/operations-agent`; keep its exports stable.

## Gates and conduct
- `format`, `typecheck`, `lint` and focused tests locally; CI on push is the matrix.
- Run a local PostgreSQL suite only to reproduce a CI red, under `scripts/run-with-test-lock.mjs`, one container at a time,
  `timeout 15 docker info` first.
- Keys: the AGENT charter's rules hold verbatim. Read the file named by `NORTH_STAR_AGENT_KEY_FILE`; never print, log or commit a
  value.
- Commit WIP often with `Packet: AGENT-2`. Stage explicit paths. Integrate each slice yourself (`--no-ff`, ledger row, review-log
  row, push, CI green).
- Record `docs/execution/packets/AGENT-2.md`, at most 80 lines.

## Report (≤ 25 lines), then stop
`LANE: BUILD · PACKET: AGENT-2 · SHA · BASE`; per slice: merge SHA, CI run, "Test it yourself"; the new eval table, success
rate, cost per completed task.
