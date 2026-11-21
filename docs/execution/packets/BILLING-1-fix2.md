# BILLING-1-fix2 — pin billing terms at first allocation

Critical migration and Fable follow-up for Billing slice 1. Exact integration CI and a reserved merge window gate the main push.

## Claims

1. The archived reader at `67e4efce^1` answers a stored item query and refuses the bound interval release with `UNSUPPORTED_RUNTIME_CAPABILITY` naming floor 36.
2. Effective dates are evaluated at opening. First allocation keeps the selected table and assignment. The saved selection protects later allocations from backdated successors.
3. Publication compares receipt xmin with the native xid cast. The upgrade preserves rate and assignment bodies and recovers publication timestamps and invocation IDs from the original audit.
4. Direct SQL refuses publication in a second company with a valid same-transaction receipt. Giving the same principal the company grant admits the identical SQL.
5. The proposal fixture requires a dedicated text field for the body. Notes can hold conflicting prices without supplying terms.

## Decisions

- Calculation v2 consumes exact allocation pins. Saved calculation v1 quotes replay with their original publication fence.
- The fixture uses the existing terms field binding and reader floor 36.

## Gates

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44843557065

- Hosted packet CI found fixture typing errors, corrected in the executable tip. The exact integration branch is `candidate/BILLING-1-fix2`.
- Focused calculator, archived reader, populated upgrade, and transaction wraparound tests passed.
- Restoring the opening fence, bypassing term pins, and restoring the text cast each failed its targeted test.

## Test it yourself

Run `node --import tsx --test test/integration/billing-quote.test.ts` and look for the opening, same-day override and first-allocation tests. Run `node --import tsx --test test/postgres/billing-terms.test.ts` for the database proofs.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "BILLING-1-fix2",
  "base": "67e4efce31eb663f12d6f161aa91c0ce1220dffc",
  "head": "9fe843626879d5914a03a2ffb38d982730e5ca54",
  "changedPaths": [
    "db/migrations/0058_billing_publication_xid.sql",
    "db/schema.snapshot.json",
    "docs/decisions/ADR-0083-period-and-usage-billing.md",
    "learnings.md",
    "packages/canonical-model/src/billing-evidence.ts",
    "packages/canonical-model/src/billing.ts",
    "packages/domain/src/billing/quote.ts",
    "packages/domain/src/billing/terms.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/evidence/BILLING-1.expected-red.json",
    "test/helpers/archived-billing-probes.ts",
    "test/integration/billing-quote.test.ts",
    "test/postgres/billing-terms.test.ts",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/domain/src/billing/quote.ts",
      "name": "quoteBillingService"
    },
    {
      "path": "packages/domain/src/billing/quote.ts",
      "name": "replayBillingQuote"
    }
  ]
}
```
