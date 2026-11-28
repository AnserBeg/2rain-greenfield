# Build mode (BUILD-MODE-1)

Owner ruling: build mode until the first customer. Five pre-tenant gates are
lighter while `build-mode.json` (repository root) has `"enabled": true`. Nothing
that protects money, authority or tenant isolation is relaxed. The hardening
pass before the first tenant turns the switches off.

| Switch                               | Gate in build mode                                                                                                       | Strict (off)                                                 | Code                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `migrationListByGlob`                | Tests take the migration list from `db/migrations/*.sql`; still contiguous, and the pin must be an unchanged prefix      | Tests expect exactly `test/helpers/migration-pin.json`       | `test/helpers/migration-list.ts`                                                                        |
| `recordChecksReportOnly`             | CI-tier and record-claim findings print `WARNING`, exit 0                                                                | Any finding fails                                            | `scripts/check-record-ci-tier.mjs`, `test/architecture/record-claim-fidelity.ts`                        |
| `languageCoverageDigestRegeneration` | Preflight rewrites the coverage digests and decision IDs (never the rationale); a NEW obligation kind still fails        | Preflight reports stale digests                              | `test/helpers/language-coverage-regenerate.ts`, `test/helpers/preflight-language-coverage.ts`           |
| `nameGuardReportOnly`                | PRESS011-PRESS015 are warnings; PRESS010 still fails; the baseline still only lowers                                     | Every name-law rule fails                                    | `packages/dev-tooling/src/module-press-law.ts`                                                          |
| `trainCapLifted`                     | A train may hold any number of two-parent `--no-ff` merges (exact full green, open window, chain on origin/main all kept) | At most three merges                                         | `scripts/check-merge-window.mjs`                                                                        |

Always on, in every mode: the ratified engine IDs listed under
`ratifiedEngineIds` in `test/architecture/first-party-names.policy.json` are not
counted by the name law.

## Turning it off

- Everything: set `"enabled": false` in `build-mode.json` (or delete the file;
  a tree without it is strict).
- One gate: set that switch to `false`.
- One run: `NORTH_STAR_BUILD_MODE=off <command>`. The environment can only force
  strict, never relax.

Before flipping `migrationListByGlob` off, refresh `test/helpers/migration-pin.json`
to the full list. Before flipping `nameGuardReportOnly` off, convert or
baseline-review every warning the guard prints. Before flipping
`recordChecksReportOnly` off, run `bash scripts/check-records.sh` and fix what it
reports.

Rungs (one shared pre-tenant rung per catalog family) were left alone: rung
numbers are read by production code in `packages/canonical-model` and
`packages/postgres-provider`, which this packet does not touch.
