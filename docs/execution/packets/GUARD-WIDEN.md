# GUARD-WIDEN: generic code never names a declared application's vocabulary

Base `e112d58ff799912d7b743d5eb7fbd79f796c5318` (main, TRAIN-P). Tier: Critical (a CI gate, MIGRATION-RULE rule 18), so a Fable review comes before merge. No product code changed: this packet converts nothing. It freezes today's hand-built surface so it can only shrink.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45663465164

(The line above is main's run at the measured base; this packet's own full run is in the result file and replaces it here at merge.)

## What changed

- `packages/dev-tooling/src/module-press-law.ts` is widened, not copied (PRESS008 still refuses a second guard). PRESS001-009 and their routed debt are unchanged. New rules: PRESS010 bad or missing input, PRESS011 first-party name, PRESS012 first-party field, PRESS013 import from `packages/domain`, PRESS014 engine name, PRESS015 a count above its baseline.
- **Vocabulary** comes from `apps/web/release/app.authored.json` (entity, module, operation, query, field and capability local IDs: 718 names), so template-built IDs such as `purchase_order`, `sales_order`, `shipment`, `stock_count`, `customer_invoice` and `vendor_bill` are known; the guard refuses (PRESS010) if any of those six is missing. Plus four module words: receiving, fulfillment, payables, receivables.
- **Matching:** the longest known name wins, in snake, camel, Pascal and kebab spelling (a token continues across `-`, in text and in file and directory names), with a plural last word, in identifiers, strings, SQL and file paths. A static string construction (`'purchase' + '_order'`, a template with literal parts) is matched by its value. `endsWith(':operation.x')` and column names are strings, so they count. Comments do not. Words that are ordinary English (`item`, `party`, `location`, `reservation`, `sales`, `inventory`, `catalog`, `commercial`, `posting`, `valuation`, `ledger`) count only in ID position: after `northstar.` or `:<kind>.`, or inside a longer known ID (`item_base_unit`).
- **Scope fails closed:** `packages/{postgres-provider,runtime,platform-runtime,compiler,canonical-model,customization,operations-agent,observability}/src`, `apps/web/src`, `apps/api/src`, `db/migrations`. An empty scope or a missing scope root is PRESS010, and so is any `packages/*/src` or `apps/*/src` in neither the scope nor the reasoned `excluded` list (`packages/domain/src`, the declarations; `packages/dev-tooling/src`, the guards). A new package is **refused until classified**, not included automatically. `apps/worker` has no `src` today, so it will be refused the day one appears. Policy data: `test/architecture/first-party-names.policy.json`.
- **Engines manifest** `test/architecture/engines.manifest.json`: booking, billing, stock posting, settlement, workflow, ledger, each with its ADR (settlement has none; recorded), three or more businesses, and the files it owns. An engine's name is always allowed in its own files and never in another engine's files.
- **Domain imports** are counted per imported binding (namespace, `export *`, default, side-effect, `import()`/`require()`, quoted or backtick), so widening a baselined import is a new row.
- **Baseline** `test/architecture/first-party-names.baseline.json`: per file and per name a count, with an owner packet, the audit cluster and an expiry. A rise, a new file or a new name fails. A fall passes and the guard prints which rows to lower. `corepack pnpm guard:lower-baseline` is the only rewrite: it refuses while any name-law rule is red, refuses when a baselined file vanished while a file of the same name still exists (a move), and otherwise only lowers counts and drops empty rows.
- **Critical:** the baseline, the policy and the engines manifest are in AGENTS.md's critical pathspecs, so a hand edit to the ratchet is a reviewed Critical change.
- Wired where module-press-law already runs: `test/architecture/module-press-law.test.ts`, in every CI tier.

## Baseline measured on the base: 4,379 uses in 89 files

The fix round re-measured from `e112d58ff` with the new matchers: **4,270 uses in 84 files became 4,379 in 89** (names 3,026 -> 3,108; fields 915 -> 917; engine names 304 -> 314; imports 25 statements -> 40 bindings). The five new files are `apps/api/src`. Four existing files are kebab-named for a first-party name (`goods-receipt.ts`, `purchase-order-approval.ts`, `purchase-order-approval-executor.ts`, `stock-count-route.ts`), and kebab names sit on 50 non-comment lines in 17 scoped files.

| Owner | Files | Uses | Names | Fields | Engine | Imports |
|---|---:|---:|---:|---:|---:|---:|
| STOCK-POSTING-RULES (B3 routes, C1/C2 posting) | 13 | 2,169 | 1,657 | 507 | 1 | 4 |
| DOMAIN-PROFILE (C8 conformance/storage/materializer; A2 composition root) | 5 | 562 | 440 | 109 | 9 | 4 |
| GENERALIZE-1 (C8 other layers; C12 engine naming engine) | 23 | 316 | 34 | 8 | 264 | 10 |
| LIFECYCLE-GUARDS (C1/C2) | 2 | 306 | 237 | 69 | 0 | 0 |
| SECTION-BLOCKS (C11) | 5 | 219 | 171 | 48 | 0 | 0 |
| PROGRESS-QTY (C1/C2 projections) | 2 | 182 | 117 | 65 | 0 | 0 |
| COSTING (C7) | 3 | 157 | 133 | 19 | 0 | 5 |
| OPEN-ITEM-1 (C4) | 4 | 148 | 110 | 13 | 24 | 1 |
| COUNT-SNAPSHOT (C6) | 3 | 131 | 73 | 57 | 0 | 1 |
| LINE-TOTALS (C5) | 1 | 57 | 37 | 19 | 0 | 1 |
| APPROVAL-ROUTING (C3) | 2 | 55 | 48 | 2 | 0 | 5 |
| HISTORY (append-only migrations) | 13 | 46 | 30 | 0 | 16 | 0 |
| UNASSIGNED (incl. `apps/api` main.ts, measure-page.ts) | 6 | 12 | 10 | 1 | 0 | 1 |
| WORKFLOW-2 (C9) | 5 | 11 | 8 | 0 | 0 | 3 |
| AGENT-CATALOG (C10, incl. `apps/api` agent-cli.ts) | 2 | 8 | 3 | 0 | 0 | 5 |

## Rule 8: one control per layer (`test/evidence/GUARD-WIDEN.expected-red.json`)

Each control runs the `^GUARD-WIDEN` tests of the press-law file (ten reds and the real-tree test) and must kill exactly its own red with its own text: name layer off, field layer off, relative domain import off, the cross-engine branch off, the rise comparison off, and from the fix round kebab paths off (F1), kebab text off (F1), static constructions off (F2), per-binding imports off (F3), the unclassified-root refusal off (F4). The name-layer control kills all four name-layer reds (plain, kebab path, kebab text, constructed) and none in another layer; every other control kills exactly one. Locally the first round's five and the kebab-path control reproduced; the four others ran on CI by evidence dispatch, because the shared lock was reserved for TRAIN-R. The other name-law tests (spellings, ID position, comments, file names, platform-owned names, lowering, the `guard:lower-baseline` CLI, inputs) are outside that set, because most of them also depend on the name layer. Results: see "Rule 8 reds" in the result file.

## Rule 16 and 17

(a) The general form: **generic code never names a declared application's vocabulary**, and no engine names another. (b) It serves every future app unchanged: a second application adds its compiled release to `vocabularySources`, and its names are then refused in generic code the same way; rentals, clinics and distribution apps all compile to the same release shape. (c) What stays narrow, and why:

- Only booking and billing are refused everywhere outside their own files (`exclusive`). Stock posting, settlement, workflow and ledger are `engines-only`: their names are platform vocabulary in generic code (workflows are a customization kind under rule 16; the stock ledger and `ledger-styles` are ordinary words), so only the cross-engine rule applies to them. The ledger counts only as `northstar.ledger`.
- `legal_entity` is platform-owned (ADR-0015, the company dimension) and is not counted. One external name is exempt: the geocoder's `location_type` in `address-provider.ts`.
- Expiry is carried and shape-checked but not enforced, and a fall passes: the lane prompt lists only rises and new rows as failures, and a date-triggered red would hit every lane at once. Expired rows are printed. The audit asked for both to fail; that needs a ruling.
- Every owned row expires 2027-03-31; migration rows are HISTORY with no expiry, because migrations are append-only and those rows can never fall. There is no source for the date: **it needs a ruling.**
- File-level owners. A file with debt from two packets (for example `canonical-model/schemas.ts`: the C9 trigger and the engine registry) has one owner.

## Ride-alongs left out of the fix round (Fable, not blocking)

- Two-word IDs made of everyday words (`item_name`, `price_list`, `tax_code`, `party_role`) match inside any identifier (`itemName`, `priceList`).
- Not scanned inside the scope: `src/**/test/**`, `*.test.ts`, `release`/`build`/`dist`/`coverage` directories, and `.json` files.
- Expiry is not enforced and a fall passes, so slack can be refilled.
- A computed import specifier, `${p}_order` with a dynamic part and `['purchase','order'].join('_')` pass: inherent to a text guard.

## Follow-ups (not done here)

- CI-8 preflight: add `module-press-law` there once CI-8 merges.
- The audit's charter line for rule 16 (a packet that raises the baseline is refused; a packet that converts a cluster lowers it in the same commit) lives in `2rain-missions/charters`, outside this repository.
- If main gains first-party names before this merges, the integrator re-measures: `guard:lower-baseline` cannot raise a row.
- Four UNASSIGNED rows need an owner.
- A regenerated release can add a name that already appears in generic text (as `location_type` did) and red an unrelated lane. The fix is a reviewed policy entry or a re-measure, not `guard:lower-baseline`.
- `pnpm` in this lane clone asks to purge `node_modules`, so the local checks ran their underlying commands directly (prettier, tsc, eslint, node --test, check-expected-red.sh).
