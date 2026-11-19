# CRITFIX-F — Stored-owner authorization in the PostgreSQL writer

Update, transition, archive and restore require an explicit owner authorizer for company-owned storage. The writer holds the row lock through authorization, idempotency lookup and mutation. Seed and administrative callers use the same contract.

On baseline `37c80f93`, the direct call succeeded and advanced the foreign row. The inventory fixture observes creation on the real interpreter so its later period-lock update carries gateway authority.

## Test it yourself

Run `node --import tsx --test --test-name-pattern='company-owned tenant record mutations' test/postgres/customization.test.ts`. The plain executor must decline the foreign-company buyer's update with `MODULE_RECORD_COMPANY_AUTHORIZATION_REQUIRED`. The manager's later edit must still find revision one.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1","packet":"CRITFIX-F","base":"61c8afb1dd760c854bc5bc33890f1e85fc2a0e99","head":"ec110995843c71da8c0cec17174bb5e32e36e960",
  "changedPaths":["packages/postgres-provider/src/module-runtime-interpreter.ts","test/postgres/customization.test.ts","test/postgres/module-runtime.test.ts"],
  "symbols":[{"path":"packages/postgres-provider/src/module-runtime-interpreter.ts","name":"readRecordCompany"}]
}
```
