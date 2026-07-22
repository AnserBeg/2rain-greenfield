# G0-P1b — CI jobs and repository hygiene gates

Status: evidence_ready
Tier: Mechanical
Frozen candidate: `9c2a837edc4a074a6591d26b296795cf7ebff6a3`

## Goal and scope

Make the accepted scaffold run its existing deterministic gates in GitHub
Actions from a frozen install, retain the compiled output as evidence, and add
a repository-hygiene test that rejects accidental local/build artifacts,
alternate package-manager lockfiles, and mutable third-party action refs.

Owned paths:

- `.github/workflows/ci.yml`
- `test/architecture/repository-hygiene.test.ts`
- `docs/execution/packets/G0-P1b.md`
- the `G0-P1b` row in `docs/execution/ledger.md`

Out of scope: `package.json` scripts, application or kernel behavior, database
schemas and migrations, shared contracts, security and dependency scanning,
observability, deployment, branch-protection configuration, and any G0 stage
gate claim. Security/dependency scanning and observability remain scheduled for
G0-P5.

## Threat model and review charter

- Gates must be green at the frozen candidate.
- Threat model: accidental scaffold or workflow drift introduced by ordinary
  contributors or AI writers, not malicious workflow authors or sophisticated
  CI/supply-chain evasion.
- In scope: the workflow installs from the committed lockfile; runs formatting,
  lint, typecheck, build, unit, integration, architecture/hygiene, PostgreSQL,
  and browser commands; uploads the build output; grants read-only repository
  permission; pins third-party actions by immutable commit SHA; and rejects
  tracked local/build artifacts and alternate package-manager lockfiles.
- Out of scope: active secret exfiltration, dependency vulnerability policy,
  hostile action internals, branch protection, deployment, and future product
  test coverage.
- Decisive questions: does a normal pull request or main-branch push run every
  existing scaffold gate from a frozen install; can a plain tracked artifact,
  second lockfile, or mutable action tag pass the hygiene test; and does the
  workflow retain the compiled artifact without granting write permission?

## Required gates

- `CI=1 corepack pnpm install --frozen-lockfile --reporter=append-only`
- `corepack pnpm format`
- `corepack pnpm lint`
- `corepack pnpm typecheck`
- `corepack pnpm build`
- `corepack pnpm test:unit`
- `corepack pnpm test:integration`
- `corepack pnpm test:architecture`
- `corepack pnpm test:postgres`
- `corepack pnpm test:browser`
- workflow syntax/contract inspection
- `git diff --check origin/main...HEAD`
- owned-path verification

## Runnable exit

The repository remains locally buildable and testable with the existing root
commands, while pushes to `main` and pull requests gain deterministic scaffold,
database, browser, hygiene, and artifact jobs.

## Outcome

GitHub Actions now runs three bounded jobs on pull requests, pushes to `main`,
and manual dispatch: clean install/quality/build, Docker-backed PostgreSQL
schema and isolation, and the browser runner. Every job uses the pinned Node
file and frozen pnpm lockfile. The quality job retains `dist/` for seven days.
All external actions are pinned to resolved commit SHAs and the workflow grants
only read access to repository contents.

The architecture suite now rejects tracked build/local artifacts, ignored
files force-added to Git, alternate package-manager lockfiles, missing scaffold
commands, mutable action refs, missing read-only permission, and missing build
artifact retention. No root package script changed.

## Gate evidence

All results below ran in the packet worktree with the candidate content that
became `9c2a837edc4a074a6591d26b296795cf7ebff6a3`:

| Gate | Result |
|---|---|
| `CI=1 corepack pnpm install --frozen-lockfile --reporter=append-only` | PASS; all 11 workspace projects, lockfile unchanged |
| `corepack pnpm format` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm build` | PASS |
| `corepack pnpm test:unit` | PASS; 1 test |
| `corepack pnpm test:integration` | PASS; 1 test |
| `corepack pnpm test:architecture` | PASS; 11 tests, including 4 repository/CI hygiene checks |
| `corepack pnpm test:postgres` | PASS; 8 migration, drift, and tenant-isolation tests |
| `corepack pnpm test:browser` | PASS; runner executed, 1 scaffold test intentionally skipped |
| Workflow syntax/contract | PASS; Prettier and PyYAML parsed the workflow, executable contract checks passed |
| `git diff --check origin/main...HEAD` | PASS; no output |
| Owned paths | PASS; exactly the workflow, hygiene test, packet record, and G0-P1b ledger row; `package.json` unchanged |

Pre-freeze note: the first lint run found four countable-space regular
expressions in the new workflow-shape assertions. They were changed to explicit
quantifiers, then the complete declared gate set was rerun green before the
candidate was committed and reviewed.

## Test it yourself

```bash
cd /tmp/2rain-greenfield-g0-p1b
CI=1 corepack pnpm install --frozen-lockfile --reporter=append-only
corepack pnpm format && corepack pnpm lint && corepack pnpm typecheck
corepack pnpm build
corepack pnpm test:unit && corepack pnpm test:integration
corepack pnpm test:architecture
corepack pnpm test:postgres && corepack pnpm test:browser
```

Expect every command to pass. The suites report 1 unit, 1 integration, 11
architecture/hygiene, and 8 PostgreSQL tests passing; the browser runner reports
its one scaffold test as intentionally skipped. The hosted GitHub jobs cannot
run until the workflow reaches a pull request or `main`.

## Review evidence

Writer: Codex orchestrator, Mechanical tier.

Review: orchestrator deterministic verification, permitted for Mechanical
configuration/test work. Against unchanged candidate
`9c2a837edc4a074a6591d26b296795cf7ebff6a3`, the bounded charter checked only
ordinary scaffold drift: frozen install, complete existing command coverage,
read-only workflow permissions, immutable external action refs, artifact
retention, tracked local/generated artifacts, alternate lockfiles, workflow
syntax, and owned paths. Verdict: PASS with no findings. The deterministic gate
set above fully exercises the repository contract; no additional model review
was warranted by the Mechanical tier.

Known limits: the browser surface remains the accepted scaffold skip; hosted
runner execution awaits a pull request or integration; secret and dependency
scanning plus observability/evidence wiring remain explicitly deferred to
G0-P5.
