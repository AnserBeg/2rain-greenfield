# CRITFIX-F — Stored-owner authorization in the PostgreSQL writer

Update, transition, archive and restore require an explicit owner authorizer for company-owned storage. The writer holds the row lock through authorization, idempotency lookup and mutation. Seed and administrative callers use the same contract.

## Test it yourself

Run `node --import tsx --test --test-name-pattern='company-owned tenant record mutations' test/postgres/customization.test.ts`. The plain executor must decline the foreign-company buyer's update with `MODULE_RECORD_COMPANY_AUTHORIZATION_REQUIRED`. The manager's later edit must still find revision one.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1","packet":"CRITFIX-F","base":"37c80f93b1f5d46e0f191122ccb71de8aeae23e2","head":"d2ce5a7f7363c631f94c642cd0dcaf6b4d191335",
  "changedPaths":["packages/postgres-provider/src/module-runtime-interpreter.ts","test/postgres/customization.test.ts"],
  "symbols":[{"path":"packages/postgres-provider/src/module-runtime-interpreter.ts","name":"readRecordCompany"}]
}
```
