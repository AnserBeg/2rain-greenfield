# UNITS — enter document quantities in another unit without changing the ledger

Status: active setup BUILD; document slice stopped on UNITS-VERIFICATION. Branch `packet/UNITS`, based on INVENTORY-PARITY `e3da0a39`.
Review: not owed — the implemented diff excludes the Critical set. Draft PR only; no integration or deployment.

## Design before implementation

Unit masters use existing text codes, with a name and decimal precision (0–18).
Items retain their existing required `item_base_unit` text field and its posted-movement immutability.
Conversions belong to a company, optionally an item, and declare from/to codes and positive exact integer numerator/denominator.
Lookup prefers a direct item factor, then a direct company factor, then the corresponding reverse factors; duplicate matches refuse as ambiguous.
The selected destination must be the item's base unit. Identity conversions still check the base unit's declared precision.

Sales order, purchase order and stock document lines add optional entered quantity and entered unit fields.
Their existing quantity remains the base quantity and is the only quantity downstream operations consume.
Existing unit price/unit cost also remain per base unit; entering another quantity unit does not change the price basis.
Canonical metadata declares the normalization on ordinary create/update operations; the compiler carries that declaration to the shared document mutation runtime.
Normalization runs inside the existing accepted-mutation transaction, after idempotency lookup and before the base quantity is written.
Dependency reads use registered queries, current policy and the same transaction's existing row scope.
Exact rational arithmetic refuses a missing factor, ambiguous factor, unknown unit or a result not representable at the base unit precision by name; it never rounds.
A saved line freezes both entered and base quantities. Configuration edits do not recalculate it; replay returns the original accepted mutation.
Quantity edits either supply a complete entered pair or clear that pair and use base quantity. Unrelated edits keep the frozen pair.
Lists, document lines and printed documents display entered quantity/unit alongside the base quantity through shared metadata/renderers.

## Owner rulings

Keep today's base quantity fields; add the entered pair; exact factors only; code-keyed unit masters; never restate the ledger.
ADR-0068 selects UNITS as the consumer of the reserved document-boundary seam.
PaneFlow schema and product-quantities are read-only reference material: direct/item/company/reverse precedence is retained; its floating-point rounding is not reused.
No posting kernel, serializer, trust, activation/verification, migrations, RLS or grants change is authorized.

## Slices

1. Unit and conversion masters plus standalone exact arithmetic implemented; mutation declaration stopped.
2. Entered quantities and entry/display/print paths stopped on UNITS-VERIFICATION.
3. Persistence, browser and CI evidence; release and coverage re-derived from compilation.

## Critical dependency and safe boundary

The existing release-verification arranger synthesizes every writable field independently.
It cannot arrange a valid entered pair and conversion dependency; changing it belongs to the Critical set.
[UNITS-VERIFICATION](UNITS-VERIFICATION.md) splits that work with bounded claims and proposed expected-red controls.
No conversion descriptor or entered field is mounted, and no verification bypass is added.
The safe increment implements unit/conversion setup and standalone exact arithmetic only.
Decimals use nineteen numeric-labelled enum choices (0–18), so generic validation and verification can represent them.
Invalid factors are refused by the arithmetic helper; document-time factor validation remains in the stopped slice.

## Gates

Passed: typecheck; four changed-file unit/integration tests; unit setup web-contract; navigation and release checks.
Measured from compilation: 107 surfaces, 18 navigation leaves, 596 scenarios; 23 new setup scenarios have generic creates; executed/derived pins are 519/77.
No new grammar key is mounted; the surface reader floor remains 16. No numbered field is added.
Language coverage re-derived: 2673 obligations, 832 observed (previously 831). Local coverage checking requires CI reachability receipts; no local full suite was run.
Passed: exclusive fresh-tenant schema replay; its owned container removed; check-records.
Local PostgreSQL units test deferred before taking the lock: Windows free memory was 802132 KB, below 1.2 GB.
Local browser was cancelled while queued behind other lanes; it never acquired the lock or started a container.
Pending: full hosted CI, including the new PostgreSQL and operations browser tests.
Local container work requires at least 1.2 GB Windows free memory before taking the exclusive test lock; browser uses one worker.

## Test it yourself

See [UNITS-test-it-yourself.md](UNITS-test-it-yourself.md), completed with the implemented slices.

Program review: no stabilized new correctness domain or stage boundary at this setup checkpoint; none launched.

## Claims at the setup boundary

1. Code-keyed unit and company/item conversion setup compile to the existing storage, query, operation and surface contracts.
2. Standalone exact rational arithmetic preserves large integer quantities and refuses non-exact results by name.
3. Document fields, posting and the Critical set remain unchanged; the entered-document slice is explicitly stopped.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "UNITS",
  "base": "e3da0a3918620c5ce3e494eba3fdf1b3f8c91c4a",
  "head": "a748e116b29a584f591ddcbeecc1f7596845f21d",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json",
    "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/purchase-units.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "docs/decisions/ADR-0068-exact-unit-conversion-at-the-document-boundary.md",
    "docs/execution/lanes.md",
    "docs/execution/packets/UNITS-VERIFICATION.md",
    "docs/execution/packets/UNITS-test-it-yourself.md",
    "docs/execution/packets/UNITS.md",
    "package.json",
    "packages/compiler/src/conformance.ts",
    "packages/domain/src/app/builder.ts",
    "packages/domain/src/catalog/definition.ts",
    "packages/domain/src/inventory/contracts.ts",
    "packages/runtime/src/unit-conversion.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/integration/units.test.ts",
    "test/postgres/composed-application.test.ts",
    "test/postgres/fresh-tenant-full-replay-schema.snapshot.json",
    "test/postgres/units.test.ts",
    "test/unit/units.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/domain/src/catalog/definition.ts",
      "name": "withUnitMasters"
    },
    {
      "path": "packages/runtime/src/unit-conversion.ts",
      "name": "resolveUnitFactor"
    },
    {
      "path": "packages/runtime/src/unit-conversion.ts",
      "name": "convertUnitQuantity"
    }
  ]
}
```
