# UI-COMPOSE-1 — Arrange forms and record pages, add pop-up actions and brand the app

The orchestrator accepted ADR-0079 with Fable’s amendments on 2026-11-19.

## Decisions

1. Compose eligible first-party and tenant inputs inside declared slots. Keep each input bound once, protect required and Tier B inputs, and confine block moves to the existing sections/childTables region.
2. Start from the legacy arrangement. Only the layout revision can write the composed surface thereafter. Derive base IDs without changing historical release bytes.
3. Append versioned layout, action and brand revisions. Verify the layout result digest, source bindings and target contract when replaying.
4. Each declaring capability takes the next rung above the implemented maximum at merge. Admission requires refusal by the preceding reader and reproduction of feature-absent releases.
5. A secondary pop-up inherits its target’s grants, guards, review and approval. The company chooses a tested Ledger colour scheme and display name. Generated documents pin their brand revision.

## Slices

- [Design with Fable’s amendments](../../decisions/ADR-0079-form-and-record-composition.md).
- 1a derives slot and field inventories from the active package and stores a layout only when the owner adopts a revision. Layouts require Surface reader 28, above the attachment reader at 27. No database migration.
- UPGRADE-2 slice 1 owns addLayoutRevision replay admission and the moved, retired and changed-binding conflicts. UI-COMPOSE-1 slice 1b owns hide, collapse, concealment and reset-to-base after slice 1 merges. Disclosure and assistant discovery also belong to 1b.
- Record buttons open a Task for an existing operation or field update. Workflow start waits for a released manual-start contract. Branding follows the DOCS-1 brand resolver.

## Gates and test it yourself

Slice 1a compared full layout-free release envelopes and verified the purchase-order editor, stored field values, protected blocks and Files. [Slice 1a fix CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44703111463)

The pop-up regression uses a running server and HTML form posts. Opening two item Tasks creates no update receipt. Applying one changes the stored description once. Retry preserves the receipt count and the stale Task cannot replace the saved value.
The purchase-order button inherits the approval gate. Its review shows the fixed supplier reference. Editing invalidates the previous confirmation and the current confirmation invokes Place order.
Restricting Item update removes the offer from the record and the assistant, blocks a new binding and refuses a submitted action ID. A historical binary loads the original release and refuses the declaring release. The tenant compiler reproduces the complete envelope without the declaration.
The named addPopupActionRevision replay in customization.test.ts accepts a field label change on the new base and refuses a changed target Task contract. Admission also checks the operation binding and the advertised Surface floor.
Reader 34 serves the original release and refuses pop-ups at 35. The tenant Cabinet test reviews a record-sourced value and checks the exact gateway update. The UPGRADE-2 allowlist fixture replays a compatible base and identifies a retired tenant target.

**Try it yourself.** In Customize, choose **Add a record button**, select the item update, name it **Edit item note** and set Description to **Ask the person**. Draft, approve and activate it. Open an item, choose **Custom actions → Edit item note**, change the description and save. Refresh the item to see the saved text. The same steps work with JavaScript disabled.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "UI-COMPOSE-1",
  "base": "faf1b947c95c86403c838fcdbc0ff337d988c684",
  "head": "f7ce0c39d7dd432b3e254c69b55c064875a95aad",
  "changedPaths": [
    "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts", "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-contract.ts", "apps/web/src/surface-runtime.ts", "packages/canonical-model/src/popup-actions.ts",
    "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-workspace.ts", "packages/compiler/src/projections.ts",
    "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts", "packages/customization/src/patch.ts",
    "packages/customization/src/popup-revision.ts", "packages/customization/src/render.ts", "packages/customization/src/targets.ts",
    "packages/customization/src/upgrade-diagnostics.ts", "packages/customization/src/upgrade-replay.ts", "packages/operations-agent/src/session.ts",
    "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/popup-admission.ts", "packages/postgres-provider/src/release-repository.ts",
    "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/runtime/src/popup-actions.ts", "packages/runtime/src/request-runtime-view.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/integration/surface-data-binding.test.ts", "test/postgres/customization-validation.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/unit/customization-upgrade.test.ts", "test/unit/customization.test.ts"
  ],
  "symbols": [
    {"path":"packages/canonical-model/src/popup-actions.ts","name":"resolvePopup"},
    {"path":"packages/runtime/src/popup-actions.ts","name":"availablePopups"},
    {"path":"packages/customization/src/popup-revision.ts","name":"popupCommand"}
  ]
}
```
