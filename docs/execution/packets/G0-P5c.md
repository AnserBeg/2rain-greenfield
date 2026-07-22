# G0-P5c — Dependency and secret scanning with retained CI evidence

Status: accepted
Tier: Mechanical
Frozen candidate: `b48cfc64d653d28b8fe7d13ef4f745869e588e68`

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

## Outcome

The CI workflow now has a dedicated security job. It performs a frozen install,
runs `pnpm audit` with a high-severity failure threshold, scans complete Git
history with the official Gitleaks image pinned by immutable digest, and uploads
all reports for seven days under `if: always()`.

The same runner creates a disposable Git repository, assembles and commits a
synthetic marker without storing a complete test secret in this repository,
and requires the real scanner to return exit 1 with the configured rule ID.
The normal repository scan and the negative proof share the same extended
Gitleaks policy. No package manifest, lockfile, runtime source, or G1-owned path
changed.

## Gate evidence

All final results below ran with the content frozen as
`b48cfc64d653d28b8fe7d13ef4f745869e588e68`:

| Gate | Result |
|---|---|
| `CI=1 corepack pnpm install --frozen-lockfile --reporter=append-only` | PASS; 12 workspace projects, lockfile unchanged |
| `.github/scripts/run-security-scans.sh` | PASS; five machine-readable/text evidence files produced |
| Dependency audit | PASS; exit 0, no advisories and zero high/critical vulnerabilities across 159 dependencies |
| Clean Git-history secret scan | PASS; exit 0, 62 commits scanned, no leaks found |
| Committed synthetic-secret negative scan | PASS as a negative gate; real Gitleaks process exited 1, returned the required rule ID, and redacted both match and secret |
| `corepack pnpm format` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm build` | PASS |
| `corepack pnpm test:integration` | PASS; 4 tests |
| `corepack pnpm test:architecture` | PASS; 11 tests |
| Workflow syntax and pins | PASS; PyYAML parsed the security job and all 13 third-party action references are immutable commit SHAs |
| `git diff --check origin/main...HEAD` | PASS; no output |
| Owned paths and clean worktree | PASS; only the seven declared paths changed; no manifest, lockfile, runtime, canonical-model, or G1-P1 path changed |

Pre-freeze red results were not hidden. A direct Prettier invocation over the
TOML and shell files returned red because this repository has no parser for
those explicitly named formats; the real repository `format` gate skips
unknown files and passed, while `bash -n` validated the runner. The first
branch-range `git diff --check` also found one trailing blank line in the open
packet record. That line was removed before the candidate was frozen, and the
complete declared gate set above was then rerun green at the frozen SHA.

## Test it yourself

This command runs the same dependency audit and clean-history secret scan as
CI, then creates a disposable Git repository, commits a synthetic marker, and
requires that second secret scan to return red:

```bash
cd /tmp/2rain-greenfield-g0-p5c
g0p5c_evidence_dir=$(mktemp -d /tmp/g0-p5c-evidence-XXXXXX)
SECURITY_EVIDENCE_DIR="$g0p5c_evidence_dir" \
  .github/scripts/run-security-scans.sh
sed -n '1,80p' "$g0p5c_evidence_dir/summary.json"
sed -n '1,80p' "$g0p5c_evidence_dir/dependency-audit.json"
sed -n '1,80p' "$g0p5c_evidence_dir/gitleaks-clean.json"
sed -n '1,120p' "$g0p5c_evidence_dir/gitleaks-negative.json"
```

Expect the runner itself to pass. The summary must show dependency audit 0,
clean secret scan 0, negative secret scan 1, and
`negativeRuleDetected: true`. The dependency report has no advisories, the
clean report is `[]`, and the negative report names
`north-star-synthetic-test-secret` while both `Match` and `Secret` are
`REDACTED`. That exit-1 scan is the planted-fixture red proof; the runner treats
it as a required negative test rather than a CI failure.

## Review evidence

Writer and verifier: Codex orchestrator, Mechanical tier. Per the review-tier
rule for deterministic configuration work, the review was orchestrator
verification against the live gates rather than a separate model pass.

Verdict: PASS on unchanged candidate
`b48cfc64d653d28b8fe7d13ef4f745869e588e68`. The dependency process status is
propagated to the final gate; any clean-history Gitleaks finding also makes the
runner nonzero; the temporary committed fixture produces a real exit-1 finding
with the expected rule ID; and the workflow's `if: always()` evidence upload
runs after either gate fails. The scanner image and every third-party action are
pinned immutably. No post-verification product or configuration change was
made.

Known limits match the charter: this packet does not generate an SBOM, attest
supply-chain provenance, enforce license policy, or attempt to defeat
adversarial obfuscation. Those concerns were neither implemented nor used to
expand the review.

The user ran the security scans, confirmed the synthetic committed secret was
detected with `negativeRuleDetected: true` and redacted evidence, and confirmed
both the dependency audit and clean-history scan returned 0. The packet was
accepted on 2026-07-21. A fetch found `origin/main` unchanged from the packet
base, so the required rebase was a no-op and preserved the frozen candidate
SHA. The complete declared gate set was rerun green before integration.
