# CUSTOMIZE-6 · Tenant decimal, money, quantity and long-text fields

## Slice 1 · The in-app AI adds exact numbers, amounts, measures and notes — record
Status: Fable review FIX applied in the fix round, the targeted checks' N1/N2 and then N3 (production) with P2/P3a in later rounds (rule 14); packet tip ready for review on `packet/CUSTOMIZE-6-s1`. Base `origin/main` d8aad66b3 (TRAIN-L) merged once and the release files were checked rather than hand-merged (`check:app-release` and `check:demo-release` both green: first-party bytes are unchanged). Surface rung LOGICAL_FIELD_READER = 49, assigned at TRAIN-O (TEMPLATE-1 holds 48). No migration. One Critical path is touched: `release-verification-service.ts` (3 lines: a field with declared allowed values is probed with one of them). Stops taken: none.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45561787239
(The cited run is the green exact full on bc06dcf46, before the final round; the final tip's exact full run is in `CUSTOMIZE-6-s1b.result.txt`, since this line cannot name a run on its own commit.)

**Claims.**
1. `addRecordType` and `addField` gain five field types, each stored as an existing canonical scalar:
   - `decimal`: `exactDecimalFieldType`, precision 18 with the declared scale.
   - `money`: an exact decimal whose scale is the currency's minor unit, plus an entry in the record type's REPORTS-1 `reportSource.amounts` binding. The currency is either fixed (CAD or USD) or stored in a sibling `currency` field (CAD, USD or EUR), named by its ID or its label.
   - `quantity`: `quantityFieldType`, with `baseUnit` pointing to one `capability.unit_<label>` per namespace and one spelling per unit.
   - `longText`: text up to 4000 characters.
   - `currency`: text(3), binary collation, searchable. Its codes are an `allowedValues` list on its own `logicalFields` declaration (general: any text-backed logical kind may declare one, and a plain `text` kind exists for it). The list is projected into the field's create and update write contract (`allowedTexts`) and the interpreter refuses anything else by name (`MODULE_FIELD_VALUE_NOT_ALLOWED`, "Choose CAD, USD or EUR."), so `GBP` and `cad` are refused. It is not a formula rule, so it never enters the joint witness proof (a type with a currency field and two validated numbers compiles), and a rule on the field draws its verification witnesses from the declared codes only, so it approves; a refused code comes back as the form with the field's message; release verification probes the field with an allowed value (`release-verification-service.ts`, a 3-line Critical change).
2. An optional v6 root key, `logicalFields`, declares each field's logical kind. Without it nothing is emitted: no key, no binding, no floor.
3. The compiler admits every declaration through `deriveLogicalFieldBindings` and projects the active bindings (scale, currency, unit) as `logicalFieldBindings` into the surface manifest. Any declaration, including one on a retired field, raises the surface floor to rung 49.
4. Serving recomputes the bindings from the pinned revision and refuses a disagreement, a binding without a declaration, and an understated or unexplained floor. Activation refuses the same disagreement (`LOGICAL_FIELD_PROJECTION_CONTRACT_MISMATCH`) and a floor that disagrees with the declaration either way (`LOGICAL_FIELD_READER_MISMATCH`).
5. The web shows:
   - money with its currency, for example `1,250.00 CAD`, or the record's stored code only when the binding lists it (otherwise `(no listed currency)`);
   - a quantity with its unit, for example `12.5 kg`;
   - number inputs that step by scale with a currency or unit suffix; a form post is canonicalised (`1250.00` saves as 1250);
   - long text in a text area with a 4000 maxlength that keeps paragraphs and a leading blank line; CRLF posts as one break;
   - currency as a select of the codes its binding carries (its money fields' codes, else all stored codes). A code outside that list is flagged unavailable, never re-posted.
8. The approval text names each field's currency, unit and scale ("Deposit (money in CAD)", "Weight (quantity in kg, 3 decimals)").
6. Formula validation and calculated displays type tenant money in its fixed currency, so CAD never compares with USD. Stored-currency money is refused because it has no single currency to compare in. Tenant decimals join calculated displays as unitless values.
7. Built-in record types and line tables refuse the new kinds by name, in both the patch apply and the compiler.

**Rule 12.** The drafter's tool schema carries the `scale`, `currency` and `unit` rules through `.describe()`, generated from the member schema. The guidance names the kinds. AI-BUILD-1 adds four cases: L01 rentals (CAD deposit, 4-decimal rate), L02 shipments (weight in kg), L03 clinic visits (USD fee plus notes, held out), L04 orders (total in a stored currency, held out).

The scorer checks the served binding's kind, currency, unit and scale; a scripted L01 run in `test/postgres/build-eval.test.ts` passes a correct draft and fails a USD, two-place draft by name. No new patch kind. No live AI spend.

**Rule 17.**
- (a) Most general form: a declared logical value kind over an existing stored scalar, which carries its display facts (scale, currency source, unit) to lists, forms, record pages, reports, formulas, calculated displays and the approval text (the assistant's catalog and the manual Customize builder do not read the bindings yet). Money is "an exact amount whose currency is fixed or read from a sibling field". That is the REPORTS-1 currency binding, so the same amount is summed per currency by reports and will serve BILLING s3 advance and arrears amounts and ACCOUNTING without rental-specific code.
- (b) Used unchanged by:
  - every tenant record type, with lists, record pages, forms, reports, tone rules, validation rules and calculated displays;
  - rentals (deposit, rate), logistics (weight, volume), clinics (fee, notes), distribution (order total in the customer's currency), field service (hours in h) and hotels (nightly rate).
- (c) Deliberately narrower, and why:
  - Built-in record types: their amounts are bound by first-party report sources and storage, including the Invoice binding.
  - Line tables: line fields follow the line-table work. BILLING s3 and ACCOUNTING will hit this gap first.
  - Stored currency codes are limited to CAD, USD and EUR, the REPORTS-1 code list.
  - Stored-currency money is not comparable in formulas.
  - Fixed money is CAD or USD only (the minor-unit registry); EUR is stored-currency only.
  - Unit labels are ASCII letters, digits, spaces, dots, slashes and hyphens.
  - Plain tenant decimals cannot be summed in reports (declared reports sum amounts only).

**Controls** (`test/evidence/CUSTOMIZE-6.expected-red.json`, reproduced with `check-expected-red.sh --run`): fifteen reds, each with its own message (reds 11 and 12 share one activation test): serving comparator; serving floor; currency collation; compiler tenant check; money currency typing; long-text preservation; allowed values unprojected; allowed values unenforced (Postgres); currency declaration ignored; editor text area unbounded; unlisted code shown; retired amount validated; approval text generic; activation bindings unchecked; activation floor unchecked. The serving loader's call has no red: both admission entries refuse every disagreeing specimen, and `request-runtime-view.test.ts` seeds through admission; reaching the loader needs stored rows rewritten with a consistent chunk, manifest, release-root and attestation hash chain, which no suite helper builds (its corruption helper breaks the hash by design). A test gap, kept as defence in depth. The N1 compile test discriminates by the targeted check's own reproduction of the generated rule; an old-tree run here could not start the sandbox.
The unit-spelling refusal and every forged-declaration refusal are pinned in `test/unit/logical-field.test.ts`.

**Rule 10 proof.** Money, its currency field, the money reading it and a quantity retire in the base; adding a field and relabelling the list AFTER the retirement still compile. The retired amounts stay in `reportSource.amounts`: report-source validation skips a retired amount field (fix round), and reports offer only live fields. The slice that adds field retirement owns dropping the amount.

**Rule 13 proof.** `test/postgres/logical-fields.test.ts` runs the archived production loader at the preceding main 5902f0f4 (TRAIN-N, reader 48):
- It answers a query before the change, reproduces a feature-absent recorded chain byte for byte, and refuses the declaring release by name: "requires version 49 and this runtime supports 48".

The same test proves:
- With two companies in one tenant, North's list shows `1,250.00 CAD`, `100.10 CAD` and `12.5 kg` and never South's row, also when the narrowed North principal asks for South's list. `GBP` and `cad` writes are refused by the code rule. A typed form post of `1250.00`, `12.500` and `19.90` saves canonical values and keeps a note's leading blank line.
- A company-scoped principal sums stored-currency freight per currency as decimal text (CAD `101.00`, USD `59.90`); South returns `{kind: 'unavailable'}`.

**Follow-ups.** Tenant logical fields on line tables (BILLING s3); the release-verification search-exclusion probe misfires for tenant text of max length about 3 or less (`release-verification-service.ts`, Critical); retire `catalogCurrencyByField` in favour of declared money; teach the assistant catalog and the manual Customize builder the new kinds. Customize does not yet offer the plain `text` allowed-values kind. Owed (Fable check 2, P3): `normalize.ts` skips the currency check for any retired field with no same-record-type test; the plain `text` kind, once exposed, needs the search-exclusion and uniqueness probes to vary their value, since every probe record holds `allowedTexts[0]`; admission does not compare the write contract's `allowedTexts` with the declaration.

**Test it yourself (under ten minutes).** `corepack pnpm dev`, sign in as manager, open **Customize**, and ask the assistant: *"Track shipments with a name, gross weight in kg to three decimals, the currency the customer pays in, the freight in that currency, a CAD deposit and delivery notes."*
1. Approve and activate the change.
2. Add a shipment: Weight `12.5` shows `kg` and steps by 0.001; Currency is a CAD, USD or EUR select; Notes is a text area (enter two lines).
3. Save. The list reads `12.5 kg`, `1,250.00 CAD`, and the freight in the chosen currency.
4. Reopen the record. Both lines of the notes are still there.

## Slice 2 · The same kinds on line tables, with line money in the header currency — record
Status: built to the approved design note (option i, `CUSTOMIZE-6-s2.result.txt`); awaiting its independent review. Branch `packet/CUSTOMIZE-6-s2`, cut from `origin/main` 54e8ef7c2 (TRAIN-O). Surface rung LINE_LOGICAL_FIELD_READER = 50 is PROVISIONAL: REPORTS-1 s2 takes 50 and 51 and WORKFLOW-2 takes 52 in TRAIN-Q, so the integrator assigns the final number (likely 53). No migration. No Critical path touched. Stops taken: one named narrowing, adding these kinds to an EXISTING line table (below), reported to the orchestrator.

CI tier: full RUN_URL

**Claims.**
1. `addLineTable` admits decimal, money, quantity, long-text and currency line fields on a tenant record type, declared through the same `logicalFields` key as slice 1. The compiler no longer refuses a tenant line table; first-party record types are still refused by name.
2. Line money reads its currency from one of three places: fixed (CAD or USD); a currency field on the same line (slice 1's stored binding, unchanged); or a currency field on the line's header. The patch keeps `{kind: 'stored', fieldId | fieldLabel}`: a label resolves on the line first, then on its header, and a label on both refuses ("name the one to read by its field ID"). No new patch kind, no patch-schema change.
3. The general form is one optional key on the existing binding: `ReportCurrencyBinding.stored.via: relationId[]`, "the currency field is reached by this to-one path from the amount's record". It is REPORTS-1 slice 2's `ReportViaSchema` encoding byte for byte (one or two relation IDs, absent for the record itself, read in the same source-to-target direction), so a line-grain report resolves the code through the parent link it already requires. Absent `via` is slice 1, and every existing release keeps its bytes.
4. Admitted path: exactly the line's own active `parentScopedChild` relation, whose target field is a declared `currencyCode`. A reference link, a retired link, a link from another record type, a two-hop path, or a path on an undeclared amount is refused by name (normalize and `deriveLogicalFieldBindings`).
5. Floor: any `logicalFields` declaration on a line table (retired included), or any amount read through a path, raises the surface floor to the line rung. Serving and activation refuse an understated floor and an unexplained line rung (`LOGICAL_FIELD_READER_MISMATCH`).
6. Admission (slice-1 follow-up, rule 14): activation and serving compare every write contract's `allowedTexts` with the field's declared allowed values (`LOGICAL_FIELD_PROJECTION_CONTRACT_MISMATCH`).
7. Display and input reuse the shared control: line cells step by scale with a currency or unit suffix; line long text is a text area (slice 1's leading-newline, maxlength and CRLF fixes); a line amount's suffix reads its header's code, on the record page's line table and in the document editor; the header currency joins the editor's line sources, so changing the code before saving re-renders the lines; a line shown without its header says "(header currency)" rather than guessing a code. The design note's wording was "(currency on the <header label>)"; the binding does not carry the header's label, so the shorter text stands.
8. No cross-currency arithmetic: formulas and calculated displays type header-read money as null and refuse it, like stored money; there are no editor footers; a v1 report refuses any path-read currency (line grain is REPORTS-1 s2's, slice 2b here).
9. The approval text names the header: "Rate (money in the Work order's Currency (CAD, USD, EUR))".
10. The witness synthesizer already keys allowed values by field ID, so a validation rule on a line currency field draws its witnesses from CAD, USD and EUR only.

**Rule 16 and 17.**
- (a) Most general form: "an amount's currency is a field at a declared to-one path from the amount's record". Slice 1 is the empty path; a line's header is the first admitted path. The editor's `sourceByHeader`/`lineSourceIds` chooses a price by header currency but declares no currency for the line amount; this binding is that declaration and reuses its refresh.
- (b) Used unchanged by work-order, invoice, quote, purchase, booking and shipment lines (field service, distribution, rentals, hotels, logistics, clinics), BILLING s3 charge lines and ACCOUNTING's "sum of one stored line field" with one currency source for all legs. No platform code names a module or entity.
- (c) Deliberately narrower: the parent path only, not arbitrary links (a link can be repointed and would silently re-currency stored amounts, while a line's header is fixed for its life); first-party lines (Invoice lines) are not rebound; the slice-1 code lists are unchanged; line-grain reports wait for REPORTS-1 s2 (slice 2b adds the per-currency line witness and v2's `add({fieldId, via})`). Adding one of these kinds to an EXISTING line table stays a named refusal: `addField` on a line type never reaches the document editor's line cells for any field kind today (only `addLineTable` writes `lineFields`), so the general line-table `addField` is missing and is not built here.

**Rule 12.** The drafter's tool schema says, through the generated `.describe()` on the stored currency, that a line field's label is looked up on the line first and then on its header; the `addLineTable`, `addRecordType` and `addField` guidance names the kinds. AI-BUILD-1 adds L05 (work orders: hours in h, a rate in the work order's currency, line notes; dev) and L06 (invoice lines: whole-number quantity, CAD amount, 2-decimal discount; test). The IDs are free in BUILD_CASES, RECORD_TEMPLATE_CASES and every set the runner loads, on main and every packet branch. The scorer reads a path-read currency as "header"; a scripted L05 pair passes the header draft and fails a line-stored draft by name. The fail-closed kinds test is unchanged (no new patch kind). No live AI spend.

**Controls** (`test/evidence/CUSTOMIZE-6-s2.expected-red.json`, each with its own test and message, reproduced with `check-expected-red.sh --run`): REDS_LIST. The slice-1 manifest's two activation entries now name their own test, so a slice-2 test in the same file is not an undeclared kill. No red for the serving loader's allowed-values call, for the reason slice 1 gives for its loader call.

**Rule 10 proof.** On a line type, with line money active; with the header currency retired while the line rate reading it stays live; with the line currency retired while the line duty stays live; and with money, both currencies and a quantity retired: adding a header field and arranging both the header and line lists still compile. A label-only base change (the header currency and the line rate relabelled) replays those changes clean through the upgrade path, active and retired. Retired declarations keep the line rung.

**Rule 13 proof.** `test/postgres/line-logical-fields.test.ts` runs the archived production loader at the preceding main 54e8ef7c2 (TRAIN-O, reader 49). It answers a query before the change and after a slice-1 header-only change, reproduces a feature-absent recorded chain byte for byte, and, fed the line change as recorded and activated through the customization service, refuses it by name: "requires version 50 and this runtime supports 49".

**Company isolation.** Two companies in one tenant and environment. North's work order (USD) has two lines; South's order has a sentinel line. With every principal narrowed to North: North still adds a line to its own order; a line under South's order is refused whichever company it names; North's record page shows `1,250.00 USD`, `95.50 USD`, `10.00 CAD` and `1.5 h` and never South's line; South's order asked in South's own scope shows nothing. `GBP` and `usd` line codes are refused on write.

**Follow-ups.** Slice 2b, after REPORTS-1 s2 is on main: the per-currency line-grain report witness and v2's `add({fieldId, via})`. The general `addField` on an existing line table (editor line cells and line columns) for every field kind. Still owed from slice 1: the plain `text` kind, once exposed, needs the search-exclusion and uniqueness probes to vary their value (`release-verification-service.ts`, Critical); retire `catalogCurrencyByField`; teach the assistant catalog and the manual Customize builder the kinds.

**Test it yourself (under ten minutes).** `corepack pnpm dev`, sign in as manager, open **Customize**, and ask the assistant: *"Track work orders with a name and the currency the customer is billed in. Each work order has lines: the task, hours to two decimals, an hourly rate in the work order's currency, and notes."*
1. Approve and activate the change.
2. Add a work order, choose USD, and add a line: Hours steps by 0.01 and shows `h`; Rate shows `USD`; Notes is a text area.
3. Change the work order's currency to CAD before saving: the line's rate suffix changes to `CAD`.
4. Save and open the record: the line table reads `1.5 h` and the rate in the order's currency.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CUSTOMIZE-6",
  "base": "d8aad66b3e6ee6231b0580f2702c26d116f5a68c",
  "head": "cf78b2dd1e1651eadad83fd9284d48b624faed59",
  "changedPaths": ["apps/web/src/component-registry.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-contract.ts", "package.json", "packages/canonical-model/src/calculated-display-bindings.ts", "packages/canonical-model/src/formula-validation-bindings.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/logical-field-bindings.ts", "packages/canonical-model/src/logical-field.ts", "packages/canonical-model/src/normalize.ts", "packages/canonical-model/src/schemas.ts", "packages/canonical-model/src/surface-presentation.ts", "packages/compiler/src/compiler.ts", "packages/compiler/src/logical-fields.ts", "packages/compiler/src/projections.ts", "packages/customization/src/ai-draft-kinds.ts", "packages/customization/src/apply.ts", "packages/customization/src/patch.ts", "packages/customization/src/targets.ts", "packages/postgres-provider/src/logical-field-admission.ts", "packages/postgres-provider/src/release-repository.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/runtime/src/request-runtime-view.ts", "test/agent/build-eval-cases.ts", "test/agent/build-eval.ts", "test/architecture/repository-hygiene.test.ts", "test/evidence/CUSTOMIZE-6.expected-red.json", "test/helpers/reachability-producers.ts", "test/postgres/logical-fields.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/logical-field.test.ts"],
  "symbols": [
    {"path": "packages/canonical-model/src/logical-field-bindings.ts", "name": "deriveLogicalFieldBindings"},
    {"path": "packages/compiler/src/logical-fields.ts", "name": "compileLogicalFields"},
    {"path": "packages/postgres-provider/src/logical-field-admission.ts", "name": "logicalFieldBindingsProblem"}
  ]
}
```
