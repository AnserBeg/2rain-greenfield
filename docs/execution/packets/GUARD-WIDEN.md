# GUARD-WIDEN: generic code never names a declared application's vocabulary

Base `e112d58ff799912d7b743d5eb7fbd79f796c5318` (main, TRAIN-P). Tier: Critical (a CI gate, MIGRATION-RULE rule 18), so a Fable review comes before merge. No product code changed: this packet converts nothing. It freezes today's hand-built surface so it can only shrink.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45663465164

(The line above is main's run at the measured base; this packet's own full run is in the result file and replaces it here at merge.)

## What changed

- `packages/dev-tooling/src/module-press-law.ts` is widened, not copied (PRESS008 still refuses a second guard). PRESS001-009 and their routed debt are unchanged. New rules: PRESS010 bad or missing input, PRESS011 first-party name, PRESS012 first-party field, PRESS013 import from `packages/domain`, PRESS014 engine name, PRESS015 a count above its baseline.
- **Vocabulary** comes from `apps/web/release/app.authored.json` (entity, module, operation, query, field and capability local IDs: 718 names), so template-built IDs such as `purchase_order`, `sales_order`, `shipment`, `stock_count`, `customer_invoice` and `vendor_bill` are known; the guard refuses (PRESS010) if any of those six is missing. Plus four module words: receiving, fulfillment, payables, receivables.
- **Matching:** the longest known name wins, in snake, camel, Pascal and kebab spelling, with a plural last word, in identifiers, strings, SQL and file paths. `endsWith(':operation.x')` and column names are strings, so they count. Comments do not. Words that are ordinary English (`item`, `party`, `location`, `reservation`, `sales`, `inventory`, `catalog`, `commercial`, `posting`, `valuation`, `ledger`) count only in ID position: after `northstar.` or `:<kind>.`, or inside a longer known ID (`item_base_unit`).
- **Scope:** `packages/{postgres-provider,runtime,platform-runtime,compiler,canonical-model,customization,operations-agent}/src`, `apps/web/src`, `db/migrations`, as the audit set it. Policy data: `test/architecture/first-party-names.policy.json`.
- **Engines manifest** `test/architecture/engines.manifest.json`: booking, billing, stock posting, settlement, workflow, ledger, each with its ADR (settlement has none; recorded), three or more businesses, and the files it owns. An engine's name is always allowed in its own files and never in another engine's files.
- **Baseline** `test/architecture/first-party-names.baseline.json`: per file and per name a count, with an owner packet, the audit cluster and an expiry. A rise, a new file or a new name fails. A fall passes and the guard prints which rows to lower. `corepack pnpm guard:lower-baseline` is the only rewrite: it refuses while any name-law rule is red and otherwise only lowers counts and drops empty rows.
- Wired where module-press-law already runs: `test/architecture/module-press-law.test.ts`, in every CI tier.

## Baseline measured on the base: 4,270 uses in 84 files

By layer: names 3,026; fields 915; engine names 304; domain imports 25 (17 files, as the audit counted).

| Cluster | Owner | Files | Uses | Names | Fields | Engine | Imports |
|---|---|---:|---:|---:|---:|---:|---:|
| B3 stock posting routes | STOCK-POSTING-RULES | 5 | 1,737 | 1,301 | 434 | 1 | 1 |
| C1 fulfilment / C2 receiving posting | STOCK-POSTING-RULES | 8 | 409 | 334 | 73 | 0 | 2 |
| C1/C2 projections | PROGRESS-QTY | 2 | 181 | 116 | 65 | 0 | 0 |
| C1/C2 lifecycle | LIFECYCLE-GUARDS | 2 | 305 | 236 | 69 | 0 | 0 |
| C3 approvals | APPROVAL-ROUTING | 2 | 42 | 37 | 2 | 0 | 3 |
| C4 receivables, payables, settlement | OPEN-ITEM-1 | 4 | 147 | 110 | 13 | 23 | 1 |
| C5 order totals | LINE-TOTALS | 1 | 53 | 33 | 19 | 0 | 1 |
| C6 stock count | COUNT-SNAPSHOT | 3 | 128 | 70 | 57 | 0 | 1 |
| C7 costs | COSTING | 3 | 154 | 133 | 19 | 0 | 2 |
| C8 conformance, storage, materializer | DOMAIN-PROFILE | 3 | 518 | 411 | 107 | 0 | 0 |
| C8 other generic layers | GENERALIZE-1 | 17 | 236 | 27 | 8 | 199 | 2 |
| C9 workflow trigger | WORKFLOW-2 | 5 | 11 | 8 | 0 | 0 | 3 |
| C10 assistant | AGENT-CATALOG | 1 | 7 | 3 | 0 | 0 | 4 |
| C11 web sections | SECTION-BLOCKS | 5 | 216 | 168 | 48 | 0 | 0 |
| C12 engine naming engine | GENERALIZE-1 | 6 | 76 | 6 | 0 | 65 | 5 |
| Migrations (append-only) | HISTORY | 13 | 46 | 30 | 0 | 16 | 0 |
| Not in an audit cluster | UNASSIGNED | 4 | 4 | 3 | 1 | 0 | 0 |

## Rule 8: one control per layer (`test/evidence/GUARD-WIDEN.expected-red.json`)

Each control runs the `^GUARD-WIDEN` tests of the press-law file (the five layer reds and the real-tree test) and must kill exactly its own red with its own text: name layer off, field layer off, domain-import observation off, the cross-engine branch off, the rise comparison off. The other name-law tests (spellings, ID position, comments, file names, platform-owned names, lowering, the `guard:lower-baseline` CLI, inputs) are outside that set, because most of them also depend on the name layer. Results: see "Rule 8 reds" in the result file.

## Rule 16 and 17

(a) The general form: **generic code never names a declared application's vocabulary**, and no engine names another. (b) It serves every future app unchanged: a second application adds its compiled release to `vocabularySources`, and its names are then refused in generic code the same way; rentals, clinics and distribution apps all compile to the same release shape. (c) What stays narrow, and why:

- Only booking and billing are refused everywhere outside their own files (`exclusive`). Stock posting, settlement, workflow and ledger are `engines-only`: their names are platform vocabulary in generic code (workflows are a customization kind under rule 16; the stock ledger and `ledger-styles` are ordinary words), so only the cross-engine rule applies to them. The ledger counts only as `northstar.ledger`.
- `legal_entity` is platform-owned (ADR-0015, the company dimension) and is not counted. One external name is exempt: the geocoder's `location_type` in `address-provider.ts`.
- Expiry is carried and shape-checked but not enforced, and a fall passes: the lane prompt lists only rises and new rows as failures, and a date-triggered red would hit every lane at once. Expired rows are printed. The audit asked for both to fail; that needs a ruling.
- Every owned row expires 2027-03-31; migration rows are HISTORY with no expiry, because migrations are append-only and those rows can never fall. There is no source for the date: **it needs a ruling.**
- File-level owners. A file with debt from two packets (for example `canonical-model/schemas.ts`: the C9 trigger and the engine registry) has one owner.

## Follow-ups (not done here)

- CI-8 preflight: add `module-press-law` there once CI-8 merges.
- The audit's charter line for rule 16 (a packet that raises the baseline is refused; a packet that converts a cluster lowers it in the same commit) lives in `2rain-missions/charters`, outside this repository.
- If main gains first-party names before this merges, the integrator re-measures: `guard:lower-baseline` cannot raise a row.
- Four UNASSIGNED rows need an owner.
- A regenerated release can add a name that already appears in generic text (as `location_type` did) and red an unrelated lane. The fix is a reviewed policy entry or a re-measure, not `guard:lower-baseline`.
- `pnpm` in this lane clone asks to purge `node_modules`, so the local checks ran their underlying commands directly (prettier, tsc, eslint, node --test, check-expected-red.sh).
