# CUSTOMIZE-6 · Tenant decimal, money, quantity and long-text fields

## Slice 1 · The in-app AI adds exact numbers, amounts, measures and notes — record
Status: packet tip ready for review on `packet/CUSTOMIZE-6-s1`. Base `origin/main` d8aad66b3 (TRAIN-L) merged once and the release files were checked rather than hand-merged (`check:app-release` and `check:demo-release` both green: first-party bytes are unchanged). Surface rung LOGICAL_FIELD_READER = 48 is **provisional**. TEMPLATE-1 also holds a provisional 48, so the integrator renumbers. No Critical path or migration is touched. Stops taken: none.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45263789868

**Claims.**
1. `addRecordType` and `addField` gain five field types, each stored as an existing canonical scalar:
   - `decimal`: `exactDecimalFieldType`, precision 18 with the declared scale.
   - `money`: an exact decimal whose scale is the currency's minor unit, plus an entry in the record type's REPORTS-1 `reportSource.amounts` binding. The currency is either fixed (CAD or USD) or stored in a sibling `currency` field (CAD, USD or EUR), named by its ID or its label.
   - `quantity`: `quantityFieldType`, with `baseUnit` pointing to one `capability.unit_<label>` per namespace and one spelling per unit.
   - `longText`: text up to 4000 characters.
   - `currency`: text(3) with binary collation, searchable (release verification cannot hold a 3-character value out of search; finding records by currency is wanted).
2. An optional v6 root key, `logicalFields`, declares each field's logical kind. Without it nothing is emitted: no key, no binding, no floor.
3. The compiler admits every declaration through `deriveLogicalFieldBindings` and projects the active bindings (scale, currency, unit) as `logicalFieldBindings` into the surface manifest. Any declaration, including one on a retired field, raises the surface floor to rung 48.
4. Serving recomputes the bindings from the pinned revision and refuses in three cases: a disagreement, a binding without a declaration, and a floor that is understated or unexplained. Activation refuses a floor that disagrees with the declaration (`LOGICAL_FIELD_READER_MISMATCH`).
5. The web shows:
   - money with its currency, for example `1,250.00 CAD`, or the record's own stored code;
   - a quantity with its unit, for example `12.5 kg`;
   - number inputs that step by scale and carry a currency or unit suffix;
   - long text in a text area that keeps paragraphs intact;
   - currency as a select of the codes its money fields accept. A code outside that list is flagged as unavailable and is never posted as a different value.
6. Formula validation and calculated displays type tenant money in its fixed currency, so CAD never compares with USD. Stored-currency money is refused because it has no single currency to compare in. Tenant decimals join calculated displays as unitless values.
7. Built-in record types and line tables refuse the new kinds by name, in both the patch apply and the compiler.

**Rule 12.** The drafter's tool schema carries the `scale`, `currency` and `unit` rules through `.describe()`, generated from the member schema. The guidance names the kinds. AI-BUILD-1 adds four cases: L01 rentals (CAD deposit, 4-decimal rate), L02 shipments (weight in kg), L03 clinic visits (USD fee plus notes, held out), L04 orders (total in a stored currency, held out).

The scorer checks the served logical binding, its currency and its unit, not the scalar alone. No new patch kind, so the drafter-coverage gate is unchanged. No live AI spend.

**Rule 17.**
- (a) Most general form: a declared logical value kind over an existing stored scalar, which carries its display facts (scale, currency source, unit) to every reader. Money is "an exact amount whose currency is fixed or read from a sibling field". That is the REPORTS-1 currency binding, so the same amount is summed per currency by reports and will serve BILLING s3 advance and arrears amounts and ACCOUNTING without rental-specific code.
- (b) Used unchanged by:
  - every tenant record type, with lists, record pages, forms, reports, tone rules, validation rules and calculated displays;
  - rentals (deposit, rate), logistics (weight, volume), clinics (fee, notes), distribution (order total in the customer's currency), field service (hours in h) and hotels (nightly rate).
- (c) Deliberately narrower, and why:
  - Built-in record types: their amounts are bound by first-party report sources and storage, including the Invoice binding.
  - Line tables: line fields follow the line-table work. BILLING s3 and ACCOUNTING will hit this gap first.
  - Stored currency codes are limited to CAD, USD and EUR, the REPORTS-1 code list.
  - Stored-currency money is not comparable in formulas.
  - An API write of an unlisted code is not refused on write. It reports as "No currency", which is visible, and the form never offers such a code.

**Controls** (`test/evidence/CUSTOMIZE-6.expected-red.json`). All six were reproduced locally with `check-expected-red.sh --run`, and each reds its own assertion: serving comparator; serving floor; currency collation; compiler tenant check; money currency typing; long-text preservation.
The unit-spelling refusal and every forged-declaration refusal are pinned in `test/unit/logical-field.test.ts`.

**Rule 10 proof.** With the fields active, and again after deposit (money) and weight (quantity) retire, adding a field and relabelling the list both still compile. REPORTS-1 drops a retired amount from the report source, and the logical declaration stays.

**Rule 13 proof.** `test/postgres/logical-fields.test.ts` runs the archived production loader at d8aad66b3 (reader 47):
- It answers a query before the change.
- It reproduces a feature-absent recorded chain byte for byte.
- It refuses the declaring release by name: "requires version 48 and this runtime supports 47".

The same test proves:
- With two companies in one tenant, North's list shows `1,250.00 CAD`, `100.10 CAD` and `12.5 kg` and never South's row.
- A company-scoped principal sums stored-currency freight per currency (CAD 101, USD 40), and the company check refuses South.

**Test it yourself (under ten minutes).** `corepack pnpm dev`, sign in as manager, open **Customize**, and ask the assistant: *"Track shipments with a name, gross weight in kg to three decimals, the currency the customer pays in, the freight in that currency, a CAD deposit and delivery notes."*
1. Approve and activate the change.
2. Add a shipment:
   - Weight `12.5` shows `kg` beside the input, which steps by 0.001.
   - Currency is a CAD, USD or EUR select.
   - Notes is a text area. Enter two lines.
3. Save. The list reads `12.5 kg`, `1,250.00 CAD`, and the freight in the chosen currency.
4. Reopen the record. Both lines of the notes are still there.

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
