# PANEL-2 — Keep the assistant beside the page

## Claims

1. Opening another page restores the conversation, its pending decision, its latest undoable change and the current step. An explicit Stop still interrupts the run.
2. History is a same-origin POST. It returns 204 and an empty body for another person's conversation and checks the current page's company before returning the transcript.
3. At 960 px and wider the panel reserves space beside the Ledger page. Drag or use the arrow keys to resize it. At 390 px it fills the screen.
4. The tab remembers only the conversation ID, open state and preferred width. The server keeps the transcript and owns the run.

5. Today, the PO list and detail, New PO, Receive, Stock by item, SO detail and a custom record share centered gutters. Numeric columns and totals use their sheet’s right inset.

## Decisions

A reconnected page reads new rendered events by position. A pending card keeps its original conversation, plan ID and digest. The panel uses its existing script and CSP hash computation.
The desktop dock uses the remaining width to select the Ledger layout. The top bar spans both columns.

The content centers in the workspace beside the sidebar. The sidebar company name fits on one line and its tooltip gives the full name.

## Gates

The history unit test returned 404 on the base. The focused endpoint suite passed all 23 cases after the AGENT-4 merge.
Slice 1 passed [CI 44422752230](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44422752230) at `1c4fdf6dbd`. The scripted browser journey holds a model reply until the new PO is open, checks the Send and Save controls, and captures four views.

Slice 2 passed [CI 44428702963](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44428702963) at `5a0020332f`. The browser checks the declared edges within 1 px at 1440 and 390 and checks PO gutters at 1280 and 1920. The [Ledger views](../evidence/look-1/) and [assistant views](../evidence/panel-2/) come from that run.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "PANEL-2",
  "base": "c31f17df1ebc3bfca7819ef34e60e0fb43160cba",
  "head": "5a0020332f80d7d885ba00ba3f3ca6c064d5c8c5",
  "changedPaths": [
    "apps/api/src/assistant-endpoint.ts",
    "apps/web/src/assistant-panel.ts",
    "apps/web/src/document-editor.ts",
    "apps/web/src/ledger-styles.ts",
    "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/assistant-panel.composed-application.spec.ts",
    "apps/web/test/browser/look.composed-application.spec.ts",
    "test/agent/assistant-endpoint.test.ts"
  ],
  "symbols": [
    {"path": "apps/api/src/assistant-endpoint.ts", "name": "createAssistantEndpoint"},
    {"path": "apps/web/src/assistant-panel.ts", "name": "withAssistantPanel"},
    {"path": "apps/web/test/browser/look.composed-application.spec.ts", "name": "requireAlignment"}
  ]
}
```

## Test it yourself

1. At desktop width, open Assistant and ask a question. Drag its left edge, then focus the handle and press an arrow key. Open Purchase orders and choose New. The conversation and width follow you and Save draft is clickable.
2. Navigate during a reply or while a plan is waiting. The next page shows the live step or the plan. After completion it shows the answer.
3. At phone width the panel fills the screen. Close it and open Today. Reopen it and choose New conversation to clear the exchange.
4. On a purchase order, compare the section labels, first cells, Amount column and total. At phone width, open Receive and scroll to its footer.
