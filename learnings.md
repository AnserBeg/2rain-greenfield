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
