# COMPANY-SCOPED-MEMBERSHIP — open company Lists and Records within live grants

Status: Fable returned REVISE on the first candidate. The revised candidate awaits full CI and a targeted credit check.

## Claims

1. The registered company list exposes only the companies covered by live grants. A tenant-wide grant returns every company.
2. Plain and paged scoped company lists carry a restriction marker. The customer and order credit reads withhold all credit figures when that marker is set.
3. The demo Address settings require the company’s connector configure grant. The installation lookup uses PostgreSQL’s membership-filtered read policy.

## Controls

- `credit-rejects-restricted-company-list` drops the credit guard. The customer read then reports 5,000.00 open against 85,000.00 across both companies.
- The Address settings regression checks a scoped buyer’s 403 and the effect of revoking the manager’s configure grant. The installation read checks the stored accounts in two companies.
- The earlier company-list controls remove eligibility and the company primary-key predicate separately. The revised test also exercises two of three companies and a mix of tenant-wide and scoped grants.

## Gates

The targeted credit control reproduced 5,000.00 open and 45,000.00 available without the guard, then passed with the guard restored.

The first candidate’s dispatch, reviewed by Fable at `906e21b8` while CI was queued, is recorded below. The revised integration’s run is recorded at handoff.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44845710098

## Try it yourself

Run `node --import tsx --test --test-name-pattern='tenant-wide customer read' test/postgres/customer-credit.test.ts` with Docker available. The unrestricted read shows 85,000.00 open. The same customer and order reads with a restricted company list leave all five credit fields unstated.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "company-scoped-membership",
  "base": "67e4efce31eb663f12d6f161aa91c0ce1220dffc",
  "head": "938d480da26657a9f081caa8359eb417d3c383f4",
  "changedPaths": [
    "apps/web/src/address-settings.ts",
    "packages/postgres-provider/src/address-geocodes.ts",
    "packages/postgres-provider/src/composed-application-runtime.ts",
    "packages/postgres-provider/src/credit-read-model.ts",
    "packages/postgres-provider/src/current-policy.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/postgres-provider/src/serving-gateways.ts",
    "packages/runtime/src/address-gateway.ts",
    "packages/runtime/src/request-runtime-view.ts",
    "packages/runtime/src/semantic-query-gateway.ts",
    "test/evidence/company-scoped-membership.expected-red.json",
    "test/postgres/customer-credit.test.ts",
    "test/postgres/inventory-documents.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/runtime/src/semantic-query-gateway.ts",
      "name": "SemanticQueryResultEnvelope"
    },
    {
      "path": "packages/postgres-provider/src/credit-read-model.ts",
      "name": "readCreditPosition"
    },
    {
      "path": "packages/postgres-provider/src/address-geocodes.ts",
      "name": "PostgresAddresses"
    }
  ]
}
```
