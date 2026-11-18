# AGENT-3 — the office assistant in the web app: fast, screen-aware, act-then-undo, measured honestly

Status: slice 1 `39463ffb` (PR #57); slices 2-6 `c6a156b4` (PR #58); end-review fixes (a) `2cfb6fc2` (#81), (b) `1d3a7c35` (#83), (c) `043ac9f2` (#84) · Mechanical (no Critical path) · Stops: none · Charter:
[AGENT-3-charter.md](AGENT-3-charter.md) from `main` `f1abcb3a`; branch `packet/AGENT-3`, base `5c25acdb`.

## Pre-registered measures (2026-11-17, before any real-model run of this packet)
Discovery calls = every `erp_discover` call, by tool and mode; baseline (16:52) median **7.5**, slice-1 target ≤ 3.75. Seconds = the
run on a monotonic clock, arrangement excluded; baseline median **34.8** (from JSONL stamps). Pass rate must not fall below 9 of 10. The
development set's rules (tasks 11-34) are registered in `test/agent/dev-tasks.ts`; write tasks run 3 attempts.

## Claims
1. The session starts with a business map generated from the pinned release, cached unfiltered by release root (a customized release
   has its own) and filtered per person through the routed eligibility previews on every call; filtered text is never shared.
2. A short name resolves to exactly one id of the pinned contract or to none (`matchId`).
3. A plan is bound to the release it was made on (id and content hash, in the approval digest); execute refuses before any step and
   before each step, in that step's view, with a typed `replan` naming what committed. Verify compares values and patched fields. A replayed
   execute returns the receipt; its values come only from a read authorized now (security review).
4. The panel's screen is a claim, its record read fresh as the person; requests are same-origin JSON naming this server's loopback
   Host (X10); a conversation is its starter's, in the company the page's workspace entry proves (X9, in both digests and on the card),
   bounded (30 min idle, 5 per person, 200 per process: X13); a card answers only for its own plan and digest, and only a whole plain
   yes typed approves (X2, X3); Stop is checked before each write and the host verifies what was written on every exit (X7).
5. Risk class from contract facts (`risk.ts`, `writeRisk`): an O0 create whose archive the person may run, or an update with a patch,
   is reversible and runs at once where the host offers Undo (X6); a state or status change off the first option, a settings
   update, or anything else needs a yes (X5). Undo is pinned to the agent's revision, refused after a later write or when an active
   record names a created one, and resumable (X8). A capability's child lines are bound to the yes and re-read before it runs (X4).
6. `erp_plan` refuses a reference no lookup returned (target, relation, an `_id` field naming a record type, any value carrying an
   id), nested arguments, and a currency not canonical or not default, read or named in this request (X12).
7. Record and tool data reach the model inside `<record-data>` / `<tool-data>`, called data (X11). A change to the application is
   the typed whole answer `{"handoff":"customize","change":…}`; the panel drafts the person's words through CUSTOMIZE, metered
   against the same cap and Stop (X13). Each model call gets only the output the cap leaves. Five tools; no migration.

## Decisions
- Map: local names, `!` = needs confirmation, bound 60,000 characters; cache breakpoint on prompt + map. Panel `assistant-panel.ts`
  (script CSP-hash-pinned, text nodes only) + `assistant-endpoint.ts` (`/?assistant=ask|decide|stop|undo|latest`); seam line in `ux-grammar`.

## Results (each dated result file stands as registered)
| run | pass | median discovery | median s | median calls | USD | USD / completed |
|---|---|---|---|---|---|---|
| baseline 16:52 (no map) | 9/10 | 7.5 | 34.8 | 13.5 | 1.5282 | 0.1698 |
| slice 1 17:54 `7c604fda` ([r](../evidence/2026-11-17T17-54-02-978Z-agent-eval.md)) | 10/10 | 2 | 18.6 | 7 | 0.8869 | 0.0887 |
| slice 3 18:25 `47bc6c82` ([r](../evidence/2026-11-17T18-25-11-573Z-agent-eval.md)) | 10/10 | 2 | 18.3 | 6.5 | 0.8482 | 0.0848 |
| slice 4 18:35 `ae5c4443` ([r](../evidence/2026-11-17T18-35-50-111Z-agent-eval.md)) | 10/10 | 2 | 20.9 | 7 | 0.9030 | 0.0903 |
| dev set 19:49 `281b5cf2` ([r](../evidence/2026-11-17T19-49-59-349Z-agent-eval.md)), 34 tasks, 66 runs | 61/66; every time 31/34, once 32/34; by attempt 31/34, 15/16, 15/16 | 2 | 17.0 | 7.5 | 5.8596 | 0.0961 |
| after LOOP-1, 11-18 03:08 `8e3d4a21` ([r](../evidence/2026-11-18T03-08-05-680Z-agent-eval.md)) | 10/10 | 2 | 19.9 | 5.5 | 0.8145 | 0.0815 |
| after SPEED-1, 03:33 `f5414386` ([r](../evidence/2026-11-18T03-33-36-579Z-agent-eval.md)) | 10/10 | 2 | 11.9 | 5.5 | 0.6837 | 0.0684 |
| after the end-review fixes, 20:26 `d33ca17f` ([r](../evidence/2026-11-18T20-26-22-512Z-agent-eval.md)) | 10/10 | 2 | 15.0 | 5.5 | 0.8149 | 0.0815 |

Dev-set failures as registered: task 18 x3 (my rule's option id was wrong; rule v2), task 22 attempt 1 (a slice-1 defect, fixed),
task 29 (the agent picked the only "Millwork" with a customer role and said so; the rule wanted no write).

## End-review fix round (2026-11-18): each item's test was red on the prior code
X1-X3, X6 `f55efebe`; X12 `ae5a17dd`+`a3105ef8`; X14 `723afdb9`; X5 `c58c273f`; X4 `55244f56`; X7-X8 `4bc9b303`; X10, X15
`9c710fbd`; X11 `59c8459d`; X13 `23784d5c`; X9 `637c3f21`+`e90ed6fb`; X16 `c5908191`. Tests: X-named cases, dev task 35, panel spec.
Gates — slice 1: CI 44166005372, main 44171233909. Fix round: (a) 44358468254 att. 4, (b) 44375822997, (c) 44385801368 (`043ac9f2`).

## Test it yourself
1. `node --import tsx --test test/agent/business-map.test.ts test/agent/assistant-endpoint.test.ts` passes.
2. `NORTH_STAR_AGENT_KEY_FILE=/mnt/c/Users/rvham/rent_soft/.env corepack pnpm dev`, open the URL, click **Assistant**. Ask "How many
   Field notebooks are on hand at Calgary warehouse?": a step label and timer, then the answer with a link.
3. On a customer's page: "Set this customer's payment terms to Net 45" runs at once ("Did: changed customer …", **Undo**). Shipping
   an order waits for **Yes, do it** ("In <company>."). "Add a serial number field to items": a plain diff, nothing live.

## Filed
- Durable conversations and the §9.4 run record; model routing; `source_id`/`actor_id` on a manual adjustment (task 22); cached link
  labels after a read revocation (end review, Astra 20).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "AGENT-3",
  "base": "62d34bd6328ae24524151547d527bd1162e5e8a2", "head": "3189562a337638a04a5e492d084cf2c21fbb9071",
  "changedPaths": [
    "apps/api/src/agent-cli.ts", "apps/api/src/assistant-endpoint.ts", "apps/api/src/composition-root.ts", "apps/api/src/draft-budget.ts", "apps/api/src/posix-quote.ts", "apps/web/src/app-server.ts",
    "apps/web/src/assistant-panel.ts", "apps/web/src/surface-runtime.ts", "apps/web/test/browser/assistant-panel.composed-application.spec.ts", "packages/operations-agent/src/anthropic-model.ts", "packages/operations-agent/src/business-words.ts",
    "packages/operations-agent/src/index.ts", "packages/operations-agent/src/loop.ts", "packages/operations-agent/src/model.ts", "packages/operations-agent/src/risk.ts", "packages/operations-agent/src/session.ts", "packages/operations-agent/src/tools.ts",
    "test/agent/assistant-endpoint.test.ts", "test/agent/business-map.test.ts", "test/agent/dev-tasks.ts", "test/agent/eval-harness.ts", "test/postgres/agent-dev-tasks.test.ts", "test/postgres/agent-tasks.test.ts"
  ],
  "symbols": [{"path": "packages/operations-agent/src/business-words.ts", "name": "businessWords"}, {"path": "packages/operations-agent/src/loop.ts", "name": "meteredNext"}, {"path": "apps/api/src/draft-budget.ts", "name": "budgetedDraftingModel"}, {"path": "apps/web/src/surface-runtime.ts", "name": "assistantCompany"}, {"path": "packages/operations-agent/src/tools.ts", "name": "customizeHandoff"}]
}
```
