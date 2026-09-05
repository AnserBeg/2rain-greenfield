---
name: git-workflow
description: Branches, commits, the frozen SHA, integration, pushing, worktrees
  and the shared stash. Read before any git operation in this repository.
---

# Git workflow (rewritten 2026-09-04)

## Branches

- `main` holds accepted work only and always matches `origin/main`.
- A vertical lives on `packet/<id>` cut from current `main`, in its own
  `git worktree add ../<repo>-<id> packet/<id>`; remove the worktree on
  integration. Two lanes at most (`AGENTS.md` §3).
- Direct commits to `main` are for doctrine and record housekeeping only, and
  carry a `Doctrine-only: <reason>` trailer when they touch anything outside
  `docs/`, `.agents/`, `AGENTS.md`, `CLAUDE.md`, `learnings.md`.

## Commits

- Conventional commits `type(scope): summary`; a `Packet: <id>` trailer on every
  packet commit (the record's `record-claim` `head` must carry it).
- Stage by explicit path. **Never `git add -A`** — other lanes' files can be in
  the shared directory.
- No secrets, `.env*`, `node_modules/`, build output or dev databases.
- Honest messages: a red gate or a limit is stated, never hidden.

## The frozen SHA

- The vertical freezes at its branch tip once CI is green there. Any later
  change is a new commit and a new SHA; never amend or rebase to hide it.
- **Tag a reviewed candidate before any rebase**:
  `git tag -a <id>-reviewed-r<n> <sha> -m "..." && git push origin <tag>`.
  `--force-with-lease` is allowed only on a branch not yet pushed or reviewed.

## Integration

1. `git fetch`; if `main` moved, merge `main` into the packet branch (or rebase
   if unreviewed), push, let CI run.
2. Integrate with **`git merge --no-ff packet/<id>` into `main`** — the packet
   tip is the SECOND parent; `scripts/check-review-record.sh` covers the merge
   through it. Never fast-forward, never squash, never reset `main`.
3. **CI green at the merged SHA is the acceptance gate.** Push `main`; the
   `post-merge` hook checks origin sync and the review record.
4. Record: one ledger row, one lane row, one review-log row (a verdict, or
   `no arm owed — outside the Critical set`).
5. A conflict in a **derived artifact** (compiled release, coverage decisions,
   lockfile, schema snapshot) is re-derived from the merged inputs, never picked.

## Pushing and tags

- Push `main` after every integration (`scripts/check-origin-sync.sh` fails
  otherwise). Push any tag whose SHA a record cites.
- Never force-push `main` or any shared branch.
- Annotated tags for stage completions and preserved probes only.

## Worktrees and the stash

- **Each live lane in its own worktree.** A shared checkout leaks one lane's
  edits into the other's `git status` and index.
- **The stash is repo-global.** Never bare `git stash`/`git stash pop`. If you
  must: `git stash push -u -m "<tag>"`, capture its SHA from
  `git stash list --format='%H %gs'`, `git stash apply <sha>`, then drop it by
  tag. Anything worth keeping gets a ref (`preserved/<name>` tag), not a stash
  slot.
- Remove stale worktrees; `git worktree list` should show the two lanes and the
  orchestrator's `main`.

## Pre-tenant re-baseline (ADR-0066)

When the storage planner refuses a transition on the first-party application:
`corepack pnpm --filter @north-star/api dev:reset`, delete
`apps/web/release/app.compiled.json`, rebuild with `build:app-release`, and
commit the one-entry lineage with the change that needed it. Tests that pinned
historical entry counts or positions are updated in the same commit. Say
`Re-baseline: <reason>` in the commit body.

## Safety

- Before `reset --hard`, `checkout -- <path>`, `clean` or a branch delete, run
  `git status` and commit anything you need.
- All git runs in Ubuntu/WSL against `/home/rvham/...` paths.
