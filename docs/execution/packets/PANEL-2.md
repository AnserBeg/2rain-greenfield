# PANEL-2 — Keep the assistant beside the page

## Claims

1. Opening another page restores the conversation, its pending decision, its latest undoable change and the current step. An explicit Stop still interrupts the run.
2. History is a same-origin POST. It returns 204 and an empty body for another person's conversation and checks the current page's company before returning the transcript.
3. At 960 px and wider the panel reserves space beside the Ledger page. Drag or use the arrow keys to resize it. At 390 px it fills the screen.
4. The tab remembers only the conversation ID, open state and preferred width. The server keeps the transcript and owns the run.

## Decisions

A reconnected page reads new rendered events by position. A pending card keeps its original conversation, plan ID and digest. The panel uses its existing script and CSP hash computation.
The desktop dock uses the remaining width to select the Ledger layout. The top bar spans both columns.

## Gates

The history unit test returned 404 on the base. The focused endpoint suite passed all 19 cases.
The scripted browser journey holds a model reply until the new PO is open, checks the Send and Save controls, and captures four views.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "PANEL-2",
  "base": "8ba38fb9af241dc2ed3a82dc928b873b3c44e067", "head": "48f369ca574fcdb07837e892b2ad8d8339034d3c",
  "changedPaths": [
    "apps/api/src/assistant-endpoint.ts", "apps/web/src/assistant-panel.ts", "apps/web/src/ledger-styles.ts",
    "apps/web/test/browser/assistant-panel.composed-application.spec.ts", "test/agent/assistant-endpoint.test.ts"
  ],
  "symbols": [{"path":"apps/api/src/assistant-endpoint.ts","name":"createAssistantEndpoint"},{"path":"apps/web/src/assistant-panel.ts","name":"withAssistantPanel"}]
}
```

## Test it yourself

1. At desktop width, open Assistant and ask a question. Drag its left edge, then focus the handle and press an arrow key. Open Purchase orders and choose New. The conversation and width follow you and Save draft is clickable.
2. Navigate during a reply or while a plan is waiting. The next page shows the live step or the plan. After completion it shows the answer.
3. At phone width the panel fills the screen. Close it and open Today. Reopen it and choose New conversation to clear the exchange.
