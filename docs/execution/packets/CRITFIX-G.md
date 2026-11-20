# CRITFIX-G — Tenant validation and release verification

3. The compiler rejects to-one validation through company-owned storage. The live interpreter treats an older binding to that storage as unreadable.
4. The saved-filter adapter refuses a bound operation before opening a mutation transaction.
5. Live validation reads the tenant business period at the PostgreSQL transaction timestamp through the granted function.
7–8. Verification checks the pinned examples against every bound operation and rule. Every formula scenario must execute, including when a sibling create has a constructibility finding.
9. The compiler lowers the existing typed witness values to proposed, prior and related fixture inputs. Verification uses these overrides even when a generated value would satisfy the rule.
10. Formula refusals require a complete stored-row comparison. A refused create leaves no row and a refused update preserves every column, including revision.

The regressions failed on `cfbe24f0`. No migration or new surface capability was needed.

## Test it yourself

Run `node --import tsx --test --test-concurrency=1 --test-name-pattern='a validation path refuses|saved-filter adapter refuses|live date validation|verification requires the projected|unconstructible sibling|compiled fixture overrides|changed its target' test/unit/field-validation.test.ts test/postgres/{saved-filter,releases,customization-validation}.test.ts`. Expect eight passes.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1","packet":"CRITFIX-G","base":"cfbe24f0ea74b71b62924125c060137f12d467d6","head":"1cc301c788d6a33c2e17454d491d75898f997698",
  "changedPaths":["packages/compiler/src/conformance.ts","packages/compiler/src/formula-validation-plan.ts","packages/compiler/src/formula-validation-witness.ts","packages/compiler/src/verification.ts","packages/platform-runtime/src/saved-filter-contracts.ts","packages/postgres-provider/src/module-runtime-interpreter.ts","packages/postgres-provider/src/release-verification-service.ts","packages/postgres-provider/src/saved-filter-executor.ts","test/fixtures/g2/party/compiler.ts","test/fixtures/g2/party/runtime-harness.ts","test/fixtures/g2/party/validation.ts","test/fixtures/g2/saved-filter/compiler.ts","test/fixtures/g2/saved-filter/runtime-harness.ts","test/postgres/customization-validation.test.ts","test/postgres/releases.test.ts","test/postgres/saved-filter.test.ts","test/unit/field-validation.test.ts"],
  "symbols":[{"path":"packages/postgres-provider/src/release-verification-service.ts","name":"assertFormulaScenarioCoverage"}]
}
```
