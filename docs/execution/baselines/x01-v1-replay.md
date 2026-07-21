# X-01 v1 replay characterization

Date: 2026-07-21
Status: accepted characterization — the frozen artifact is locally
resurrectable, but not a faithful clean replay.

## Reconstruction result

A disposable detached worktree made from the local annotated tag
`x01-baseline-v1` resolved to
`68f748cde06ecc795b159be5ae507a9d973106ac`. Its non-baseline source paths
match frozen source commit `668a60bb3912a2df0b66f098b4c47ff8fe1396a6`
exactly. The tag was not advertised by the quarry's `origin` remote during
this replay, so this resurrection currently depends on the local quarry Git
object database rather than an off-machine tag.

## Replay gates

| Gate | Command | Result |
|---|---|---|
| Artifact integrity in a fresh detached checkout | `bash baselines/x01-v1/verify.sh --integrity` | RED: `result directory count mismatch` |
| Exact source comparison | `git diff --name-only 668a60b HEAD` excluding `baselines/x01-v1/` | PASS: zero paths |
| Strict legacy install | `CI=1 corepack pnpm install --frozen-lockfile --reporter=append-only` | RED: `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` for `patchedDependencies` |
| Relaxed diagnostic install | `CI=1 corepack pnpm install --no-frozen-lockfile --reporter=append-only` | Completed, but changed `pnpm-lock.yaml` (removed the `@agent-native/core` patch) and created `pnpm-workspace.yaml`; not a faithful replay |
| Legacy typecheck | `CI=1 corepack pnpm typecheck` after the relaxed diagnostic install | RED before TypeScript: `ERR_PNPM_IGNORED_BUILDS` for `better-sqlite3`, `esbuild`, `node-pty`, and `sharp` |

The integrity failure is precise: the captured source worktree had 177 result
directories and 348 result files; the fresh Git checkout has 176 directories
and the same 348 tracked files. The missing entry is the empty historical
directory `2026-07-03T15-28-58-568Z`, which Git cannot store without a file.

No live model evaluation was attempted: X-01 deliberately excludes credential
values, and this packet must not turn a reproducibility investigation into a
paid replay. No source or dependency-lock workaround was accepted into either
repository.

## Consequence for G7

Use X-01 v1 as immutable historical comparison evidence, not as a cleanly
re-executable runtime benchmark. Any later replay must report these three
limitations side by side: missing empty result directory, absent remote tag,
and pnpm 11.9 configuration/build-policy incompatibility.
