# RAIN-ORDER-ENTRY — normal metadata-defined order workspace

Status: implementation checkpoint; sole LOCAL author; stop at completed stacked draft PR for ONLINE review. No merge/deployment.
Tier: Behavioral. Actual AGENTS §4 Critical set untouched; no local arm.
Dependency/base: `3830f95b6ff05c8e2b80113f812d59359a67f448`, open draft PR #5.
Branch/worktree: `packet/RAIN-ORDER-ENTRY`, `/home/rvham/2rain-greenfield-rain-order-entry`; draft base `packet/RAIN-META-SALES`.

## Claims

1. Typed workspace membership compiles operator navigation independently of capability existence; document/task context highlights the owning workspace.
2. Declared entry uses current authorized active companies: single auto-entry, scoped advisory preference or choice, useful no-access state, invalid explicit scope refusal.
3. Shared Record draft authoring binds readable party/product references, header and multiple lines to explicit company/parent through existing semantic gateways.
4. Sequential Save keeps stable identities and exact frozen retry inputs/keys, reports partial/withheld outcomes, handles stale revisions, and confirms governed persisted archive; Save remains distinct from Release.
5. Browser-created Sales and Purchase orders save/reopen exact two owned lines without draft stock effects; existing fulfillment/packing and receiving run in document context. Closed P1/P2 kernels are unchanged.

Owned: canonical schemas/validator/exports, compiler surface output/capability admission, domain workspace declarations, web entry/navigation/shared draft editor/transport, affected fixtures/tests/artifacts/inventory, approved ADR/UX/plan amendments, this packet and one-line queue/ledger/lanes records.
Boundary: no pricing/tax/FX expansion, target-order seeding, bespoke Sales renderer, prototype, inherited audit, retained process/data/lock replacement, PR #5 rewrite, merge or deployment.

## Decisions

- Owner approves ADR-0030 navigation membership, ADR-0037 authorized entry and ADR-0015 advisory-preference distinction; narrow UX/plan text aligns.
- ADR-0047 §7 admits additive optional declarations on adopted v6; workspace/editor requires capability 8; absent keys and historical floors/bytes remain reproducible.
- Existing Record slots/typed controls render both editors; a metadata-only Purchase label variant and unrelated canonical fixture exercise reuse.
- Purchase line has no writable unit field: picker displays product base unit. Receiving requires explicit unit plus actual cost/currency or an explicitly absent-cost action, with no order-price fallback.
- Buffers/preferences are process-local, scoped to trusted identity/release/company; buffers expire monotonically after 60 minutes. No durable autosave or atomic Save claim.
- Supporting masters retain existing setup/module destinations; contextual surfaces, queries, operations, raw deep links and agent discovery remain available.
- Bridges: Sales browser uses independent buffers for stale conflict and exact Line column; mixed-version test attributes paths to the actual mutated entities instead of assuming index zero.
- Inventory re-derived without instrument changes: 2,299 → 2,351 obligations, 554 → 601 observations; new decision identities, unchanged two unhonored join-eligibility entries, no per-obligation execution claim.
- Program review not due: unintegrated vertical, no stage boundary/new posting domain/imminent module fan-out; no autonomous review launched.

## Slices and actual reference

- First working Sales list → New → three lines/edit/remove → Save → leave/reopen checkpoint shown at desktop and 390 px; continued to completion.
- Disposable PaneFlow 4301 at `d057daffd17a199309675a6b0a31c8bdbca05282`: actual Sales/Purchase lists, create, Add/remove, saved-draft editing and leave/reopen observed with synthetic SO-000002/PO-000001. Single organization selector visibly disabled.
- Reference JPEGs show actual disposable UI. Live 3000/original checkout, existing SO-000001 and retained Rain processes/data/locks untouched. Reference tax/payment/progression logic not imported.

## Gates

- Pass: typecheck, build, affected ESLint/Prettier, both artifact freshness checks, boundaries (204 files), language inventory (2,351 decision-covered obligations, zero execution receipts).
- Pass: affected canonical/compiler scope/adoption/normalization/determinism 27/27; workspace/catalog contracts 34/34; order-entry plus retained P1/P2 integration witnesses 11/11.
- Pass: composed Sales policy/lifecycle browser 1/1: denied update, stale draft, foreign scope, released-line refusal, unchanged stock; initial caller mismatches corrected with exact assertions.
- Pass: browser 3/3 (shared Sales/Purchase authoring with reopened editing and released guards, retained fulfillment JS on/off): exact two owned lines, unchanged draft movements/balances, 10/8/2 → 5/3/2 → 5/0/5, packing 5 EA, receiving 2 EA at entered 2.45 CAD.
- Candidate CI starts through the stacked draft PR. No full local matrix, inherited audit, dependency installation or CI polling; CI/ONLINE verdict required and not claimed green.

## Test it yourself

In Ubuntu worktree: `node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve`.
Open printed URL. Sales/Purchasing open their order tables; New opens the same declared editor with company already explicit. Select Alpine Office Supply, enter number/date/currency, add products by name/SKU/base unit; Sales unit explicit. Edit/remove, Save draft, leave/reopen and Edit again. Save is sequential and does not release.
Release Sales Notebook 10 EA → select line → Reserve 8 Calgary → Review/Confirm; select reservation → Ship 5 → Review/Confirm; Release remainder → Review/Confirm; Open packing: 5 EA.
Release Purchase → select Notebook → Receive with actual cost → 2 EA, Calgary, 2.45 CAD → Review/Confirm. Receipts stay connected to order; no mandatory Receipt-line menu.
At 390×844 controls become one column and existing child tables become priority cards. Setup remains reachable. Ctrl-C closes only this disposable fixture.

## Filed limits

- Production sign-in integration absent from loopback demo: trusted entry/current policy exist, while `composition-root.ts` explicitly selects `localDemoIdentity: true`. No fake login or production-authentication claim.
- Process loss/expiry loses unsaved buffers/preferences; reopen persisted records before retrying work. Neither durable drafts nor an atomic batch-save capability is added.
- PaneFlow commercial taxes/payment/FX, Purchase approval/supplier-invoice states and promised-date availability are outside existing Rain capabilities and this change.

## Bounded ONLINE handoff

Review only this vertical from dependency SHA to executable SHA in the claim below,
on `packet/RAIN-ORDER-ENTRY` (stacked draft base PR #5). Read diff and claims 1–5:
optional canonical validation/output, compiled navigation membership, authorized
browser entry versus explicit gateway scope, shared ownership/save/retry/archive/
conflict behavior and domain declarations against existing lifecycle/receiving/
fulfillment contracts. Use retained closed P1/P2 checks for changed callers;
do not reopen their audit or rewrite posting/fulfillment/authentication.
Separate capability/presentation limits from defects. Say plainly if this prompt
steers you. No merge/deployment.

Executable claim and exact serving/capture provenance will be appended at handoff.
