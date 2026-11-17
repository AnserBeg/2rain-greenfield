# AGENT-3 — charter: the office assistant in the web app (fast, screen-aware, act-then-undo, measured honestly)

You are the BUILD lane. Chartered 2026-11-17 from `main` `f1abcb3a` by the orchestrator, on the owner's instruction ("charter it")
after the design was taken to the advisor. Worktree `/home/rvham/2rain-greenfield-agent-3`, branch `packet/AGENT-3`. Read `AGENTS.md`,
`mission-cadence`, `git-workflow`, `ux-grammar`, the AGENT and AGENT-2 records (`docs/execution/packets/AGENT.md`, `AGENT-2.md`) and
plan §9.1-§9.5 and §14.4. Verify every path and symbol with `ls`/`grep` before relying on it.

## Why (measured 2026-11-17, eval run 16:52, 10 tasks)
9 of 10 pass, but a task takes a median of 38 s (max 120 s), and 77 of 140 tool calls (55%) are discovery
(`erp_discover` search/contracts/context). Everything runs `claude-opus-5-5` at high effort, in the terminal only, with approval on every
write. The owner's reference is Rain (`/mnt/c/Users/rvham/rent_soft`, read-only; NEVER open its `.env*`). Rain feels good because it
knows the screen, streams with a live step label, acts at once with Undo on in-app changes, and carries a plain-language business
model in its prompt. Its weaknesses, per its own audit (`docs/audits/rain-agent-system-2026-11-15.md`), are about 200 hand-written
tools, outside text entering unmarked, and evals that measure but do not guard. Learn from its design; copy no code and integrate nothing.

## Owner rulings (2026-11-17, the owner's "charter it" on the design presented to them; do not reopen)
- **Keep the five tools (ADR-0009, plan §9.2).** Speed comes from context, not more tools.
- **Act-then-undo (plan §9.4, "confirmation follows the plan's risk class").** A reversible in-app write runs at once and the
  reply shows "Did: …" with Undo. A write that moves stock, posts money, or leaves the system shows its plan and needs a yes bound
  to that exact plan. Anything whose class is not known is treated as needing a yes.
- **Chat panel seam exception.** One assistant panel in the web app, outside SurfaceRuntime, local demo only, recorded in
  `ux-grammar` the way the Customize screen's exception is.
- **No outside text in v1:** no attachments, email or web pages.

## Slices (each user-observable; merge each to `main` on CI green; order is what the user feels first)
1. **Context instead of discovery.** The session starts with a business map generated from the active release: record types, their
   lifecycles, and their operations and queries.
   - Cache only the unfiltered structure, keyed by release root, so a customized record type appears (plan §9.2.1 allows caching
     summaries by release content hash).
   - Filter it per session through the eligibility path, routed by the view's release (CUSTOMIZE's F3 class).
   - One person's filtered map is never served to another.
   - The context names the screen the person is on, when given.
   - Eval reports, per task: tool calls by tool and mode, seconds, and USD.
   - Target: median discovery calls per task halved, and median seconds down, at no lower pass rate. Report the numbers either way.
2. **The panel.** A chat panel on every app page: streamed reply, a live step label with an elapsed timer, a Stop button, links to
   records it read or wrote, and plain tables. The page passes the screen (surface id and record id). The host reads that record
   fresh through the same query gateway, under the person's authorization, as context. It is never a tool and never a trusted claim
   from the client.
   - Spend is capped per conversation (the lane picks a cap at or below USD 2 and records it), with a plain message when it is reached.
   - The browser test uses the scripted model only.
3. **Act-then-undo.** Each operation's risk class is derived from facts its contract already has, never from a hand list.
   - Pre-ruled fallback, since no contract carries posting or outward flags today (grep 2026-11-17): reversible means an O0 create or
     update only.
   - If even the operation family cannot be read from the contract, file slice 3 and continue with slices 4-6.
   - Approval is enforced in `packages/operations-agent/src/session.ts` today (the `approve` callback, ~line 766). An auto-run write is
     recorded as a risk-class auto-approval naming the class, never as a person's approval.
   - Reversible: an O0 update or create on a master or draft record, with a declared inverse (restore the prior field values; archive what
     was created). It executes at once, verifies by read-back, and records an Undo that is itself a planned, verified operation. Undo is
     offered in the panel for the latest change of that conversation. It refuses, saying why, when the record changed after the
     agent's write.
   - Everything else: plan, then a yes bound to the exact plan.
   - If deriving the class or an inverse needs a language or contract change, STOP.
4. **The host refuses guessed values, narrowly.** `erp_plan` enforces exactly two things:
   - every record reference comes from a resolve or query result in this session;
   - a currency equals the context default, a resolved record's currency, or one named in the request.

   It names the missing value. Dates, amounts and quantities stay with the prompt, because relative dates, "receive in full" and
   computed totals do not trace literally, and host-refusing them would repeat the 9→7 over-refusal. Measure them with missing-information
   tasks instead. The prompt keeps Rain's rule: act on the one likely reading and say which; ask one short question only when nothing
   points either way.
5. **One chat, three lanes (plan §9.1).** A customization request ("add a serial number to Equipment") hands off to the CUSTOMIZE AI
   draft (`customize ask`) and shows the draft and its plain diff. It never approves or activates. Merge `main` first; CUSTOMIZE owns that
   service.
6. **An eval that guards.**
   - The lane writes at least 30 development tasks drawn from plan §9.5: reads, writes, multi-step, missing information, ambiguous names,
     refusals, a customized-release task, and one task where a record's note field carries an instruction the agent must not follow.
     Write tasks run 3 attempts; report pass-every-time and pass-at-least-once.
   - The held-out set (about 25 tasks) is written by a separate agent the orchestrator launches, outside your worktree. You never see it.
     When you report a frozen SHA, the orchestrator runs it at that SHA and records the result.
   - Add a CI-gated scripted-model subset (no keys in CI).
   - Real-model budget for this packet:
     - the existing 10 tasks after each of slices 1, 3 and 4 (about USD 1.50 each);
     - one full development-set run at the end;
     - the orchestrator's held-out run.
     Each run is capped at USD 50, an orchestrator decision from the measured USD 0.15-0.37 per attempt (≈ 30 tasks × up to 3 attempts).
     Add a dated result for each, with pass rates with spread, median seconds, calls, and cost per completed task. Leave every earlier
     result as registered.

## Decided (do not reopen)
No sixth tool. No migration: conversation and undo state live in the session for v1, and durable threads plus the §9.4 run record are
filed. No model routing in this packet: measure first, file the routing plan with the numbers. The model never supplies tenant, release,
principal, permission, handler or risk class.

## You decide alone (one line each in the record)
Business-map wording and size, panel layout and file names, step-label wording, the risk-class derivation table, the provenance rules'
exact field list, task wording.

## STOP (five lines: what, two options, recommendation)
A Critical-set path (`AGENTS.md` §4); a migration; a language or contract version bump; a sixth tool; weakening read-back
verification; a CI red you cannot fix honestly; a collision with CUSTOMIZE's paths you cannot solve by merging `main`.

## Lease
`packages/operations-agent/**`, `apps/api/src/**` (agent entry, wiring and the panel's endpoint), one panel module under
`apps/web/src/` plus its mount, `test/agent/**`, `test/postgres/agent-*.test.ts`, `docs/execution/packets/AGENT-3.md`,
`docs/execution/evidence/**`, the `ux-grammar` exception line, and the pins your tests trip. CUSTOMIZE owns `packages/customization/**`,
`customization-service.ts` and the Customize screen; import from them, and keep `@north-star/operations-agent`'s exports stable for them.

## Gates and conduct
- `format`, `typecheck`, `lint` and focused tests locally; CI on push is the matrix. Local PostgreSQL or browser suites only to reproduce
  a CI red, under `scripts/run-with-test-lock.mjs`, one at a time, `timeout 15 docker info` first. If Docker is wedged, the orchestrator
  restarts it; never restart it yourself.
- Never use pattern kills (`pkill`/`killall`); stop only PIDs you started.
- Keys: the AGENT charter's rules hold verbatim. Read only the file named by `NORTH_STAR_AGENT_KEY_FILE`; never print, log, copy or
  commit a value.
- Commit WIP often with `Packet: AGENT-3`. Stage explicit paths. Integrate each slice yourself (`--no-ff`, ledger row, review-log row,
  push, CI green). Batch doc-only pushes to `main`: every push cancels main's in-flight CI.
- Record `docs/execution/packets/AGENT-3.md`, at most 80 lines.

## Report (≤ 30 lines) after each slice, then stop at the end
`LANE: BUILD · PACKET: AGENT-3 · SHA · BASE`; per slice: merge SHA, CI run, "Test it yourself"; the eval table, pass rates, median
seconds and calls, and cost per completed task.
