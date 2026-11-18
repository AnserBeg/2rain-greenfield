# AGENT-3 — the office assistant in the web app: fast, screen-aware, act-then-undo, measured honestly

Status: slice 1 integrated (`39463ffb`, PR #57, audit A1/A2); slices 2-6 PR #58 · Mechanical (no Critical path) · Stops: none · Charter:
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
4. The panel's screen is a claim: named only when declared, its record read fresh as the person; a conversation is its starter's;
   requests are same-origin JSON; a plan waits for a yes bound to its id and digest; Stop ends a run; USD 1.50 per conversation.
5. Risk class from contract facts only (`risk.ts`): o0 create (inverse archive) or update with a patch (inverse prior values),
   confirmation none, no confirmed operation writing those fields, no write of `<type>_state` past its first option -> reversible,
   runs at once, recorded `by: 'riskClass'`; anything else or unknown needs a yes. Undo: latest change only, planned, executed,
   verified; refuses when a record changed after the agent's write.
6. `erp_plan` refuses, naming it, a record id (target, relation or `_id` field) no lookup returned, and a currency that is neither the
   company default, a returned record's, nor named by the person. Dates, amounts and quantities stay with the prompt.
7. A change to the application is answered with a handoff line; the panel drafts the person's words through CUSTOMIZE's
   `draftFromRequest` and shows the plain diff, with no approve or activate path. Five tools; no migration; no gateway change.

## Decisions
- Map: local names, fields without their type's prefix, `!` = needs confirmation, bound 60,000 characters (about 33,600); explicit
  cache breakpoint on prompt + map, per-turn context in the user turn. Panel `assistant-panel.ts` (script CSP-hash-pinned, text nodes only; styles a content-hash stylesheet)
  + `assistant-endpoint.ts` at `/?assistant=ask|decide|stop|undo`; Customize screen's lazily opened service shared for the handoff.
- Seam exception line in `ux-grammar` and the seam allow-list, as the Customize screen's. Slices 2-6 merge as one: shared files.
  Pin tripped: `meta-sales.spec.ts` counts the page's own scripts; the panel's is marked `data-assistant-script` and excluded.

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

Dev-set failures as registered: task 18 x3 (my rule's option id was wrong, `option.store`; agent correct; rule v2), task 22 attempt 1
(contracts by short name read `denied`, a slice-1 defect fixed after), task 29 (the agent picked the only "Millwork" with a customer
role and said so; the rule wanted no write). Slice 4's run found an over-refusal (a minted uuid in a free text field) and a 0-based
`fromStep`; both fixed after it. Not in the dev run: A1/A2, the contracts fix.

## Gates
Slice 1: branch CI 44166005372, main CI 44171233909 green. Local: format, typecheck, lint, unit 192/192, agent 32, and the PG agent
tests run once locally (they found masters are not company-scoped, an archive's read-back needs archived rows, and a full volume).

## Test it yourself
1. `node --import tsx --test test/agent/business-map.test.ts test/agent/assistant-endpoint.test.ts` passes.
2. `NORTH_STAR_AGENT_KEY_FILE=/mnt/c/Users/rvham/rent_soft/.env corepack pnpm dev`, open the URL, click **Assistant**. Ask "How many
   Field notebooks are on hand at Calgary warehouse?": a step label and timer, then the answer with a link.
3. On a customer's page: "Set this customer's payment terms to Net 45" runs at once with "Did: …" and **Undo**; Undo puts it back.
   Ask to ship an order: a plan card waits for **Yes, do it**. "Add a serial number field to items": a plain diff, nothing live.

## Filed
- Durable conversations and the §9.4 run record (charter: filed). Model routing: measure first; the dev set's numbers are above.
- The agent asks for `source_id`/`actor_id` on a manual adjustment (task 22): the screens have no adjustment recipe to copy.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "AGENT-3",
  "base": "b7b8ba86520fa9294f6dfcdead2d4ab563f468e3", "head": "6f083d201dae35dc864ee1cbb95f211abf234c9e",
  "changedPaths": [
    ".agents/skills/ux-grammar/SKILL.md", "apps/api/src/agent-cli.ts", "apps/api/src/assistant-endpoint.ts", "apps/api/src/composition-root.ts", "apps/web/src/app-server.ts", "apps/web/src/assistant-panel.ts",
    "apps/web/test/browser/assistant-panel.composed-application.spec.ts", "apps/web/test/browser/meta-sales.spec.ts", "docs/execution/packets/AGENT-3.md", "package.json", "packages/dev-tooling/src/surface-runtime-seam.ts",
    "packages/operations-agent/src/anthropic-model.ts", "packages/operations-agent/src/index.ts", "packages/operations-agent/src/loop.ts", "packages/operations-agent/src/model.ts", "packages/operations-agent/src/risk.ts",
    "packages/operations-agent/src/session.ts", "packages/operations-agent/src/tools.ts", "test/agent/agent-world.ts", "test/agent/assistant-endpoint.test.ts", "test/agent/business-map.test.ts", "test/agent/dev-tasks.ts",
    "test/agent/eval-harness.ts", "test/architecture/repository-hygiene.test.ts", "test/helpers/reachability-producers.ts", "test/postgres/agent-dev-tasks.test.ts", "test/postgres/agent-tasks.test.ts"
  ],
  "symbols": [{"path": "packages/operations-agent/src/risk.ts", "name": "operationRisk"}, {"path": "packages/operations-agent/src/session.ts", "name": "OperationsAgentSession"}, {"path": "apps/api/src/assistant-endpoint.ts", "name": "createAssistantEndpoint"}, {"path": "apps/web/src/assistant-panel.ts", "name": "withAssistantPanel"}]
}
```
