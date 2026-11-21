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
- Shell branding and pop-up actions can land in either order. DOCS-1 issues PDFs with the Ledger defaults and records `platform-default` until this slice supplies approved company revisions through the company-brand resolver.

## Gates and test it yourself

Slice 1a compared complete layout-free compiler envelopes and exercised the reader floor, protected blocks, calculated display values and Files. The four fix-round regressions failed on `552b13d8`. [Fix CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44703111463)

- Archive and restore render the saved item description from the operation’s field ID. The contract test checks the escaped value in the renamed section on both read-backs.
- Supplier reference has no purchase-order editor input. The compiler refuses its move with `CUSTOMIZE_LAYOUT_CONFLICT`. Customize offers moves for the editor’s bound inputs.
- Dock note compiles before or after a layout, retains its binding and accepts a further revision. On an active layout it follows the current placement of its base-order predecessor. The archived tenant runner checks layout-free purchase-order field additions byte for byte.
- Moving Expected date past Currency alone is refused. Move down places Expected date after Payment terms under More details, matching the approval order.
- The browser saves a purchase order through the Vendor picker in Delivery, moves Tables and totals above Progress, then reopens the saved order and checks the supplier, total and next action. The [first browser run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44699236478/job/136163306228) found a zero-width total at 390 px. The composed body now spans the sheet, and the test checks both widths.

**Try it yourself.** In Customize, arrange the purchase-order create form. Create **Delivery**, move **Vendor** there, and approve and activate each change. Add an optional text field. Under **Purchase orders → New**, select a vendor, enter the date and one line, then save the draft. Reopen the order and check the vendor.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "UI-COMPOSE-1",
  "base": "b64cd6aa2e829eac1b0a4610cfcd5f56a8b67d34",
  "head": "f0af2074f56b1c8e7d6b32e611920785e91f32f1",
  "changedPaths": [
    "apps/web/src/component-registry.ts",
    "apps/web/src/customize-screen.ts",
    "apps/web/src/ledger-styles.ts",
    "apps/web/test/browser/customize.composed-application.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "docs/decisions/ADR-0079-form-and-record-composition.md",
    "packages/customization/src/apply.ts",
    "packages/customization/src/layout-revision.ts",
    "packages/customization/src/render.ts",
    "test/helpers/archived-customization-runtime.ts",
    "test/postgres/customization-validation.test.ts",
    "test/unit/customization.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/component-registry.ts", "name": "renderLayoutDetailSection"},
    {"path": "packages/customization/src/layout-revision.ts", "name": "placeAddedLayoutField"},
    {"path": "packages/customization/src/layout-revision.ts", "name": "arrangeableLayoutFields"}
  ]
}
```
