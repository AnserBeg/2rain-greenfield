# CRITFIX-F — Stored-owner authorization in the PostgreSQL writer

Update, transition, archive and restore require an explicit owner authorizer for company-owned storage. The writer holds the row lock through authorization, idempotency lookup and mutation. Seed and administrative callers use the same contract.

On baseline `37c80f93`, the direct call succeeded and advanced the foreign row. The inventory fixture observes creation on the real interpreter so its later period-lock update carries gateway authority.

## Test it yourself

Run `node --import tsx --test --test-name-pattern='company-owned tenant record mutations' test/postgres/customization.test.ts`. The plain executor must decline the foreign-company buyer's update with `MODULE_RECORD_COMPANY_AUTHORIZATION_REQUIRED`. The manager's later edit must still find revision one.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1","packet":"CRITFIX-F","base":"e0bb8e9582cb9a7eca95f520fb2d4fabe47a7803","head":"54e7d2477648d0bfc82835f5efbe293663f233e0",
  "changedPaths":["packages/postgres-provider/src/module-runtime-interpreter.ts","test/postgres/customization.test.ts","test/postgres/module-runtime.test.ts"],
  "symbols":[{"path":"packages/postgres-provider/src/module-runtime-interpreter.ts","name":"readRecordCompany"}]
}
```
