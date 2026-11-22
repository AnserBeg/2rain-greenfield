# BILLING-1-fix2 — pin billing terms at first allocation

Critical migration and Fable follow-up for Billing slice 1. The next train owns integration.

## Claims

1. The preceding serving binary at `352e43b7` answers a stored item query on its own release and refuses first-allocation billing by name at surface-manifest floor 40. The declaration proof checks the same behavior at floor 30 against reader 29 at `f25df5af`. Both load their policy files from their own archive and check persisted release bytes.
2. Effective dates are evaluated at opening. First allocation pins the table and assignment, so backdated successors cannot change later allocations.
3. The archived writer compiles its own authored base and publishes real rates and assignments. The upgrade preserves the bodies and recovers publication timestamps and invocation IDs from the original audit. Migration 0067 compares receipt xmin with the native xid cast.
4. Direct SQL refuses publication in a second company with a valid same-transaction receipt. Giving the same principal the company grant admits the identical SQL.
5. Publication requires a dedicated proposal field. Notes can hold conflicting prices without supplying terms.

## Decisions

- Newly compiled bound plans carry the calculation v2 marker and reader floor 40. Historical interval releases retain floor 36, and saved v1 quotes replay with their original publication fence.
- Period billing and versioned rate selection apply to equipment hire, subscriptions, and field service contracts.
- The train integrator resolves the provisional migration `0067` collision with WORKFLOW-2 4a.

## Gates

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44843557065

- The tier line records the prior packet run. PostgreSQL shard 8 failed at `f87e3749` because the floor-30 fixture used current policy bindings. The corrected tip requires its own full dispatch. [Failed run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44961748200)
- Restoring the opening fence, bypassing term pins, and restoring the text cast each failed its targeted control in the original fix.

## Test it yourself

Run `node --import tsx --test test/integration/billing-quote.test.ts` for opening, same-day override, and first-allocation cases. Run `node --import tsx --test test/postgres/billing-terms.test.ts` for the archived query refusals and populated upgrade.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "BILLING-1-fix2",
  "base": "352e43b7e428ed1115fd9328db3a6427cf36a58f",
  "head": "7dadb087ac1718f7de565486bbb48462b62b9240",
  "changedPaths": [
    "db/migrations/0067_billing_publication_xid.sql",
    "db/schema.snapshot.json",
    "docs/decisions/ADR-0083-period-and-usage-billing.md",
    "learnings.md",
    "packages/canonical-model/src/billing-evidence.ts",
    "packages/canonical-model/src/billing.ts",
    "packages/compiler/src/projections.ts",
    "packages/domain/src/billing/quote.ts",
    "packages/domain/src/billing/terms.ts",
    "packages/postgres-provider/src/release-repository.ts",
    "packages/runtime/src/request-runtime-view.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/evidence/BILLING-1.expected-red.json",
    "test/helpers/archived-billing-probes.ts",
    "test/integration/billing-quote.test.ts",
    "test/postgres/billing-terms.test.ts",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/request-runtime-view.test.ts",
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
