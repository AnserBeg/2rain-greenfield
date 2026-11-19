# UI-COMPOSE-1 — Arrange forms and record pages, add pop-up actions and brand the app

Slice 0 is a docs-only proposal. Implementation awaits the orchestrator’s Fable ruling.

## Decisions for the read

1. First-party and tenant record types publish the same section and field inventory. Check required inputs and protected business blocks through the whole layout.
2. A custom button opens one native Task with a full-page fallback. Its bound target supplies its rules, confirmation and approval requirements.
3. A company brand revision supplies the Ledger palette, display name and governed logo for both the shell and DOCS-1 generation.
4. Append versioned patches with stable IDs and source expectations. A moved field can break an upgrade even when its ID still exists.
5. Layout takes the next implemented surface rung at merge, 29 if workflow and file fields land at 27 and 28. This follows the DOCS-1 Fable ruling at `6b2d28da`. Predecessor-reader refusal and release reproduction gate implementation.

## Slices

0. [Design and Fable read](../../decisions/ADR-0079-form-and-record-composition.md).
1. Layout, including existing sections, disclosure and assistant discovery.
2. Pop-up actions with governed execution.
3. Branding across the app and generated documents.

## Gates

The docs-only gate is `scripts/check-records.sh`. The Fable ruling gates Slice 1.

## Test it yourself

Run `scripts/check-records.sh` from the repository root. Expect exit status zero.
In the ADR, trace these cases before approving the design.

- Move a required supplier input into Delivery and then collapse Delivery. The move succeeds in an expanded section. The collapse must be refused.
- After an upgrade moves a field, replay the owner’s old move. The source-section mismatch must identify the field and preserve the live release.
- Open a stock action and close the dialog before confirming. Nothing posts.
- Change the company palette and generate a successor PDF. The earlier signed version keeps its bytes.
