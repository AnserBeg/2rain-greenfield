# G0-P1b — CI jobs and repository hygiene gates

Status: active
Tier: Mechanical
Frozen candidate: pending

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
