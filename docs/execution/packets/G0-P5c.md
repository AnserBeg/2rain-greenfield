# G0-P5c — Dependency and secret scanning with retained CI evidence

Status: active
Tier: Mechanical
Frozen candidate: pending

## Goal and scope

Add deterministic CI gates for known-vulnerable dependencies and accidentally
committed secrets. Retain machine-readable evidence from every run, including
failure runs, and prove the secret gate with a runtime-created negative Git
fixture so no test secret is committed to this repository.

Owned paths:

- `.github/workflows/ci.yml`
- `.github/security/gitleaks.toml`
- `.github/scripts/run-security-scans.sh`
- `test/integration/security-scan-contract.test.ts`
- `docs/execution/packets/G0-P5c.md`
- the `G0-P5c` row in `docs/execution/ledger.md`
- the dependency/secret scanning rows in
  `docs/execution/doctrine-coverage.md`

No package manifest, lockfile, runtime source, canonical-model path, schema,
contract, or G1-P1-owned path is in scope.

## Threat model and review charter

- Gates must be green at the frozen candidate.
- Threat model: accidental committed secrets and dependencies with known high
  or critical vulnerabilities, introduced by honest developers. Adversarial
  evasion is not in scope.
- In scope: dependency audit and Git-history secret scan run in CI and fail the
  job on a real finding; machine-readable reports are retained even when a gate
  fails; a temporary committed synthetic secret is detected and makes its scan
  red; the clean repository scan stays green.
- Out of scope: SBOM and supply-chain provenance, license policy, malicious
  dependency behavior without a published advisory, and adversarial secret
  obfuscation or scanner evasion.
- Decisive questions: can a high-or-critical dependency advisory leave the CI
  job green; can a committed matching secret leave the scan green; can either
  scan fail without its evidence upload still running; and does the negative
  fixture prove a real scanner exit rather than a text/config assertion?

## Required gates

- `CI=1 corepack pnpm install --frozen-lockfile --reporter=append-only`
- `.github/scripts/run-security-scans.sh`
- `node --import tsx --test test/integration/security-scan-contract.test.ts`
- `corepack pnpm format`
- `corepack pnpm lint`
- `corepack pnpm typecheck`
- `corepack pnpm build`
- `corepack pnpm test:integration`
- `corepack pnpm test:architecture`
- workflow syntax and pinned-reference review
- `git diff --check origin/main...HEAD`
- owned-path and doctrine-row review

## Runnable exit

One script produces a dependency audit report, a clean-tree secret report, a
negative-fixture secret report, and a summary. The clean repository passes; a
temporary Git repository containing the synthetic fixture is required to fail
with the configured rule identifier. CI retains the complete evidence directory
with an `always()` upload step.

