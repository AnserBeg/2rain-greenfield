# Learnings

## Verify generated freeze metadata before tagging
Date: 2026-07-21
Why: G0-P6a found trailing blank lines in generated metadata after its first tag, requiring a corrected immutable commit.
How to apply: run `git diff --check` and the artifact verifier before tagging; if metadata changes, regenerate all inventories and manifest facts before the final tag. See `docs/execution/packets/G0-P6a.md`.

## Represent empty evidence directories explicitly
Date: 2026-07-21
Why: G0-P6b proved that an empty historical result directory vanished when the X-01 baseline was checked out from Git, breaking its integrity gate.
How to apply: record required empty directories in a manifest or add a non-sensitive sentinel before freezing evidence; verify in a fresh checkout, not only the capture worktree. See `docs/execution/packets/G0-P6b.md`.

## Invoke the pinned package manager inside package scripts
Date: 2026-07-21
Why: G0-P1a's first clean checkout resolved a host pnpm 10.33.2 from a nested bare `pnpm` command instead of the workspace's pinned pnpm 11.9.0.
How to apply: use `corepack pnpm` for recursive package-manager script calls and prove them in a clean checkout. See `docs/execution/packets/G0-P1a.md`.

## Make structural gates fail closed
Date: 2026-07-21
Why: G0-P3 review found that denylisted names, optional package metadata, and source-only scans allowed equivalent forbidden dependencies and authorities to evade the gate.
How to apply: require classified package identity, explicit protected-layer dependency policy, generated-artifact scans, sole-authority ownership/uniqueness checks, and negative fixtures for aliases and ordinary bypass forms; see `docs/execution/packets/G0-P3.md`.

## Bound reviews to the packet threat model
Date: 2026-07-21
Supersedes: Make structural gates fail closed.
Why: G0-P3 review expanded from accidental scaffold violations into unbounded obfuscation defense, growing the checker without product evidence.
How to apply: every packet and review prompt names in-scope failures and deferred adversarial cases; findings outside that boundary are future-hardening notes, not blockers. Graduated into `review-tiers` in G0-P3.
