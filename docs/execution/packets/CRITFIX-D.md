# CRITFIX-D — Recover a failed activation and resume posting

1. Re-verification runs the kernel checks for the current attempt, release, pointer and fence. A success appends a receipt. A persistent fault leaves the predecessor serving.
2. Explicit revert binds a fresh approval to the failed swap and its exact verified predecessor. The kernel verifies the restored release at the next fence. Both outcomes reconcile inventory before reporting success.
3. The Customize screen submits the attempt and fence it displayed. The CLI defaults to re-verification and accepts `recover --revert` for restoration.

## Test it yourself

With a failed activation, clear its cause and run `corepack pnpm customize recover`. Expect the candidate release at the same fence. On a separate failed attempt, run `corepack pnpm customize recover --revert`. Expect the previous release at the next fence. Both allow fresh receiving and shipping.
Run `node --import tsx --test test/unit/customize-screen.test.ts` to exercise both recovery buttons and their generation binding.

## Evidence

Both recovery cases reproduced the terminal failure on the baseline. [Baseline regression run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44495431861). The PostgreSQL cases exercise serving, receipts, fences, scopes and fresh postings. [Silent-harm controls](../../../test/evidence/CRITFIX-D.expected-red.json) cover the submitted fence and predecessor proof. [Hosted controls passed](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44498490631). The first candidate exposed two stale migration filename assertions, corrected before synchronization. The schema snapshot was regenerated after the workflow migration landed.
Decision — reuse the failed swap’s approved root and canonical diff so revert can proceed while the candidate manifest is unreadable. Release reader and parser floors still apply.
Filed — legacy null acknowledgement pins can refuse replay when a base removes a permission. Pre-tenant remedy is `dev:reset`.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1","packet":"CRITFIX-D","base":"1d64f6977728c4829a68780a1308a3da2323c555","head":"49a940ea7c2398ada4205d85339c60e6afa7b017",
  "changedPaths":["apps/api/scripts/customize-cli.ts", "apps/web/src/customize-screen.ts", "db/migrations/0039_activation_recovery.sql", "db/schema.snapshot.json", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/release-activation-service.ts", "packages/postgres-provider/src/release-approval-service.ts", "packages/postgres-provider/src/release-reverse-transition-policy.ts", "test/architecture/release-persistence-boundary.test.ts", "test/evidence/CRITFIX-D.expected-red.json", "test/postgres/customization-world.test.ts", "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts", "test/postgres/trust-substrate.test.ts", "test/unit/customize-screen.test.ts"],
  "symbols":[{"path":"packages/postgres-provider/src/release-activation-service.ts","name":"PostgresReleaseActivationService"}]
}
```
