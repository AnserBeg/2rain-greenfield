# G0-P3 salvage admission — structural-test technique

Date: 2026-07-21
Mode: PORT
Target: G0-P3 dependency-boundary checker and architecture tests

## Source

Prior repository `/home/rvham/2rain_erp`, branch `chess`, commit
`668a60bb3912a2df0b66f098b4c47ff8fe1396a6`:

- `tests/architecture-metadata-layer-contracts.test.ts`
- `tests/business-behavior-layer-contracts.test.ts`
- `tests/operation-runtime-layer-contracts.test.ts`
- `tests/surface-ui-layer-contracts.test.ts`
- `tests/repo-hygiene.test.ts`
- `tests/helpers/module-fixture.ts`
- `tests/helpers/model-facing-scan.ts`
- transitive helper inspected for the last item:
  `shared/runtime-manifest/model-facing-scan.ts`

The listed working-tree files were verified byte-identical to that commit. No
prior-repository file was modified.

## Verified evidence

The sources demonstrate deterministic repository walking, aggregated contract
violations, shared fixtures, fail-closed string/key scans, and structural tests
that compare declared metadata with source and generated artifacts. The old
tests were inspected but not executed: the accepted G0-P6b replay records that
the quarry does not clean-install under the supported toolchain, so this
admission claims technique evidence only, not a green prior gate.

The ported result is independently exercised in this repository with synthetic
negative fixtures and a CLI non-zero-exit test. It does not import or execute
the prior repository.

## KEEP

| Technique | Reason |
|---|---|
| Deterministic recursive source/manifest discovery | Makes boundary coverage repeatable and reviewable |
| Aggregated, sorted violations with file context | One run exposes the complete actionable failure set |
| Shared fixture builder | Negative cases prove rules fail, rather than only proving the current tree passes |
| Model-facing token/key scanning | Useful fail-closed mechanism for prohibited agent/tool authority leakage |
| Root test-script integration | A local structural violation becomes a canonical CI-gate failure |

## REWRITE

| Prior technique | Greenfield expression |
|---|---|
| Live imports of old schema/module metadata | Temporary synthetic workspace fixtures with no database/runtime imports |
| Old module/action/permission registries | Accepted ADR-0001 through ADR-0010 authority signatures and package graph |
| Generated action-registry comparison | Fixed five-tool protocol and private-registry rejection |
| Old app/server/actions/shared directory walk | Greenfield `apps/`, `packages/`, and `db/` production roots plus emitted model-facing catalogs |
| Ad hoc assertion messages | Stable rule IDs plus normalized file and line evidence |

## REJECT

| Prior material | Reason |
|---|---|
| Static metadata plus runtime-overlay lineage | Forbidden dual application authority |
| Deployment-global manifest provider | Forbidden active-release authority |
| One physical action file per model tool and generated action registry | Replaced by semantic gateways and five stable host tools |
| `@agent-native/core` framework IDs and allowlists | ADR-0005 drops the framework without a compatibility authority |
| Drizzle/SQLite schema reflection and old module DTOs/routes | Provider/module-specific implementation, not the portable technique |
| Old many-tool and dangerous-action exposure model | Contradicts ADR-0009's exact five-tool profile |

## Invariants that must survive

1. The checker is deterministic, local, network-free, and database-free.
2. Rules derive from the accepted greenfield package graph and ADR authorities.
3. Every violation has a stable rule ID, normalized path, line, and message.
4. The real repository passes while synthetic forbidden imports and authorities
   produce a non-zero CLI exit.
5. No legacy overlay, manifest, framework, action registry, schema, route, or
   module contract becomes runtime or test authority.
6. Static enforcement is reported honestly as partial where later semantic or
   provider evidence remains scheduled.

## Known defects that must not carry

- tests coupled to live application imports and database schema initialization;
- old-directory assumptions and hard-coded module/action allowlists;
- positive-only checks that never prove the gate rejects a bad fixture;
- re-exported scanner dependencies that hide the actual source of a rule;
- permissive overlay/custom-value status checks that legitimize dual lineage;
- claims of prior green gates despite the recorded replay/toolchain failures.

## Admission gates

- `corepack pnpm check:boundaries`
- `corepack pnpm test:architecture`
- `corepack pnpm typecheck`
- `corepack pnpm lint`
- `corepack pnpm build`
- `corepack pnpm test`
- clean owned-path and whitespace checks

## Rollback

Before integration, remove the checker/CLI, architecture fixture/tests, root
scripts, admission record, packet record, ledger transition, and doctrine-map
updates. No schema, data, runtime package, or prior repository requires
rollback.
