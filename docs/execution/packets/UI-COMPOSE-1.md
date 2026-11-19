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
- 1a covers the slot inventory, persistent IDs and create/move/rename/reorder.
- 1b adds disclosure, upgrade refusals and assistant discovery.
- Shell branding and pop-up actions can land in either order. Document branding follows DOCS-1 templates.

## Gates and test it yourself

Run `scripts/check-records.sh` from the repository root. Expect exit status zero.
In ADR-0079, trace a required supplier input moved into Delivery, a legacy form arrangement followed by a layout revision, and a governed action whose displayed input came from the record.
