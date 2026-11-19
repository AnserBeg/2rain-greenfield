# DEPS-1 — patch minimatch in the lint toolchain

## Claim and decision

The workspace override pins minimatch requests in the affected range to 11.0.1 for GHSA-g3hv-75wg-m249. The only affected dependency was 10.2.5 under `@typescript-eslint/typescript-estree`, reached through the root `typescript-eslint` dev dependency. ESLint's 3.1.5 is outside the advisory range.

## Test it yourself

- Run `corepack pnpm why minimatch`. Expect typescript-estree to use 11.0.1 and ESLint to use 3.1.5.
- Run `corepack pnpm -r why --prod minimatch`. Expect no dependency paths.
- Run `corepack pnpm audit --audit-level=high` to check the lockfile against current advisories.

## Gates

The repository CI runs on the pull request and integration. This dependency change touches no Critical path.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "DEPS-1",
  "base": "129cb3019b86a0de06511c05c08978c8ee50a34e",
  "head": "69a957c8822c672563ed542cfb86c045ebb5feac",
  "changedPaths": ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
  "symbols": []
}
```
