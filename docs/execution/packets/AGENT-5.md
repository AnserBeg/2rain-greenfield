# AGENT-5 — single-user assistant approvals and record references

BUILD · 2026-11-18 · No Critical path. Each numbered regression failed on `6b7b87a5`.

| Finding | What the focused test observes |
|---|---|
| 1 | A note imitating a freight edit occupies one quoted text row. A real freight edit adds a decimal row. |
| 2 | Place order binds an omitted supplier reference to null. The card shows “supplier reference clears”. |
| 7 | The pinned release requires confirmation for the company default, reorder percentage, tax rate and every purchasing settings field. Ordinary name edits stay reversible. |
| 8 | Reading a legacy preferred-location value supplies no type evidence. A listed ID or a stored reference needs a matching exact get. |
| 9 | Uppercase targets and references bind lowercase UUIDs. A name containing the same letters retains its case. |
| 10 | “A USD purchase order” admits offered USD for that turn. A supplier name or unsupported code supplies no currency. |

The release declares confirmation on entities and fields. Older releases without declarations require confirmation for edits to records in Setup.
CI caught a valid order-line reference in reserve-and-ship. The target get now verifies it during planning.
The assistant keeps its five tools. GitHub CI gates integration. The browser assertion checks the card’s rendered field rows.

## Test it yourself

Run `node --import tsx --test --test-name-pattern='AGENT-5' test/agent/{assistant-endpoint,business-map}.test.ts`. All six findings pass.
Open a draft PO with a supplier reference and ask the assistant to place it. Look for “supplier reference clears”, then click No.

## Filed for pilot

- Filed for pilot 3. Bind the amendment’s effective action if purchasing approval settings change before execution.
- Filed for pilot 4. Advance multi-step revision pins from the mutation transaction when another editor intervenes.
- Filed for pilot 5. Filter amendment snapshots to the line revision the executor consumes.
- Filed for pilot 6. Recheck a stock-count line’s draft parent under lock before an automatic edit.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "AGENT-5",
  "base": "c31f17df1ebc3bfca7819ef34e60e0fb43160cba",
  "head": "55afd3694fb5e7ec81df1d56791968d6e5841cdb",
  "changedPaths": ["apps/api/src/assistant-endpoint.ts","apps/web/release/app.authored.json","apps/web/release/app.compiled.json","apps/web/src/assistant-panel.ts","apps/web/test/browser/assistant-panel.composed-application.spec.ts","packages/canonical-model/src/schemas.ts","packages/compiler/src/projections.ts","packages/domain/src/catalog/definition.ts","packages/domain/src/inventory/definition.ts","packages/domain/src/purchasing/approval-arguments.ts","packages/domain/src/purchasing/approvals.ts","packages/operations-agent/src/catalog.ts","packages/operations-agent/src/risk.ts","packages/operations-agent/src/session.ts","packages/runtime/src/request-runtime-view.ts","test/agent/assistant-endpoint.test.ts","test/agent/business-map.test.ts","test/agent/compiled-view.ts","test/fixtures/g2/language-conformance/coverage-decisions.json"],
  "symbols": [{"path":"apps/api/src/assistant-endpoint.ts","name":"inputRows"},{"path":"packages/operations-agent/src/risk.ts","name":"operationRisk"},{"path":"packages/domain/src/purchasing/approval-arguments.ts","name":"effectiveApprovalArguments"}]
}
```
