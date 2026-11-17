# AGENT-3 — the office assistant in the web app: fast, screen-aware, act-then-undo, measured honestly

Status: slice 1 integrating; slices 2-6 built · Tier: Mechanical (no Critical path) · Stops taken: none
Charter: [AGENT-3-charter.md](AGENT-3-charter.md) from `main` `f1abcb3a`. Branch `packet/AGENT-3`, base `5c25acdb`.

## Pre-registered measures (written 2026-11-17, before any real-model run of this packet)

- **Discovery calls** = every `erp_discover` call, any mode; reported per task by tool and mode. Baseline (run 16:52): 5 / 4 / 5 / 6 / 11 /
  9 / 13 / 10 / 12 / 2, **median 7.5**; slice-1 target ≤ 3.75. **Seconds** = the run on a monotonic clock, arrangement excluded; the
  baseline's from its JSONL stamps: **median 34.8**. Pass rate must not fall below 9 of 10; one attempt per task is noisy, reported as run.
- Development set (tasks 11-34, `test/agent/dev-tasks.ts`, rules registered in its header before any real-model run of them):
  write, multi-step and customized tasks run 3 attempts; reported pass-every-time and pass-at-least-once.

## Claims

1. The session starts with a business map generated from the pinned release (record types, states, operations with writable fields,
   queries with views, screen recipes), cached unfiltered by release root (a customized release has its own) and filtered per person,
   on every call, through the routed eligibility previews; the filtered text is never cached or shared (`business-map.ts`).
2. A short name resolves to exactly one id of the pinned contract or to none (`matchId`).
3. The panel's screen is a claim: the surface is named only when the release declares it, and its record is read fresh as the person
   through the query gateway (`turnContext`); a conversation belongs to the principal that started it; requests are same-origin JSON.
4. A plan that needs a yes waits for one bound to its id and digest; Stop ends a run before the next model or tool call; a conversation
   is capped at USD 1.50 and says so plainly (`assistant-endpoint.ts`, `test/agent/assistant-endpoint.test.ts`).
5. Risk class from contract facts only (`risk.ts`): tier o0 create (inverse: archive) or update with a patch (inverse: prior values),
   confirmation none, no confirmed operation writing the same fields, no write advancing the record's `_state` past its first option ->
   reversible; anything else or unknown -> needs a yes. A reversible plan runs at once, recorded `by: 'riskClass'`, never as the person.
6. Undo is the latest change only, itself planned, executed and verified; it refuses, saying why, when a record changed after the
   agent's write (`test/postgres/agent-tasks.test.ts`).
7. `erp_plan` refuses, naming the value, a record id no lookup in the session returned and a currency that is neither the company
   default, a returned record's, nor named by the person. Dates, amounts and quantities stay with the prompt.
8. A request to change the application is answered with a handoff line; the panel drafts the person's words through CUSTOMIZE's
   `draftFromRequest` and shows the plain diff; it has no approve or activate path.
9. The model still supplies no tenant, release, principal, permission, handler or risk class; five tools; no migration.

## Decisions

- Map: one block per record type, local names, fields without their type's prefix, `!` = needs confirmation, bound 60,000 characters
  (about 33,600) degrading to no fields, then ids only. Caching: an explicit breakpoint on prompt + map; per-turn context in the user turn.
- Panel: `apps/web/src/assistant-panel.ts` (static script pinned by CSP hash, text nodes only), endpoint `apps/api/src/assistant-endpoint.ts`
  at `/?assistant=ask|decide|stop|undo`, NDJSON stream; step labels: Thinking, Looking up "…", Reading <query>, Preparing the change,
  Making the change, Checking the result. Spend cap USD 1.50 per conversation at Opus 5.5 list prices (read 2026-11-17).
- Seam exception line in `ux-grammar` and the seam scanner's allow-list, as the Customize screen's; local demo identity only.
- Handoff is a final-answer line (`HANDOFF customize: …`), a host capability, not a tool; the person's own words are drafted.
- Slices 2-5 integrate as one merge: they share the session, loop and endpoint files (as AGENT-2's slices 1-3 did).

## Results (each dated result file stands as registered)

| run | pass | median discovery calls | median s | median calls | USD total | USD / completed task |
|---|---|---|---|---|---|---|
| baseline 2026-11-17 16:52 (AGENT-2, no map) | 9/10 | 7.5 | 34.8 (JSONL stamps) | 13.5 | 1.5282 | 0.1698 |
| slice 1 17:54 at `7c604fda` ([result](../evidence/2026-11-17T17-54-02-978Z-agent-eval.md)) | 10/10 | 2 | 18.6 | 7 | 0.8869 | 0.0887 |
| slice 3 18:25 at `47bc6c82` ([result](../evidence/2026-11-17T18-25-11-573Z-agent-eval.md)) | 10/10 | 2 | 18.3 | 6.5 | 0.8482 | 0.0848 |

## Slices

1. Context instead of discovery. 2. The panel. 3. Act-then-undo. 4. Narrow host refusals. 5. One chat, three lanes. 6. The guarding eval.

## Gates

## Test it yourself

1. `node --import tsx --test test/agent/business-map.test.ts test/agent/assistant-endpoint.test.ts` passes.
2. Start `NORTH_STAR_AGENT_KEY_FILE=/mnt/c/Users/rvham/rent_soft/.env corepack pnpm dev`, open the URL, click **Assistant** (bottom right).
   Ask "How many Field notebooks are on hand at Calgary warehouse?": a step label and timer run, then the answer with a link.
3. On a customer's page ask "Set this customer's payment terms to Net 45": it runs at once, shows "Did: changed party …" and **Undo**;
   click Undo and the page (reloaded) shows the old terms. Ask to "ship" something: a plan card waits for **Yes, do it**.
4. Ask "Add a serial number field to items": a plain diff appears with a link to the Customize screen; nothing is live.

## Filed
