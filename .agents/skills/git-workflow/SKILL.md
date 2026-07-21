---
name: git-workflow
description: Branching, commit, push, and tag discipline for this repository.
  Read before creating a branch, committing packet work, integrating an
  accepted packet, or pushing. Keeps main accepted-only and every reviewed
  SHA permanently retrievable.
---

# Git workflow

## Branch model

- `main` holds accepted work only. It must always build to the last accepted
  packet's state and must always match `origin/main`.
- Every packet is done on its own branch cut from current `main`, named
  `packet/<packet-id-lowercase>` (e.g. `packet/g0-p1a`). A codex writer seat
  may use a `codex/<packet-id>` prefix, but the packet id must be in the name.
- Never commit packet or product work directly to `main`. The only commits
  allowed straight to `main` are repository setup and agent-doctrine/docs
  housekeeping (this file, `AGENTS.md`, skills, ledger scaffolding) done
  outside any packet.
- Use an isolated worktree (`git worktree add`) when a writer or reviewer
  runs while the main working tree must stay clean, or when packets run in
  parallel. Remove it (`git worktree remove`) once the packet is integrated;
  never leave stale `-wt` trees lying around.

## Commit discipline

- Conventional commits: `type(scope): summary`. Types: `feat`, `fix`,
  `docs`, `chore`, `test`, `refactor`, `style`, `build`, `ci`. Scope is the
  area (`feat(inventory):`, `docs(execution):`).
- Put the packet id in the body: a `Packet: <ID>` line.
- One logical change per commit; keep each reviewable. Prefer several small
  commits over one giant one.
- Stage by owned path, not blindly: `git add -- <owned paths>`, then
  `git status` to confirm nothing stray crept in (build output, dev
  databases, secrets, `node_modules`). Never `git add -A` without reading
  the result.
- Never commit secrets, `.env*` values, `node_modules/`, build artifacts, or
  dev databases. If `.gitignore` let one through, fix `.gitignore` first.
- Keep messages honest — no "successfully", no inflated claims. A red gate
  or known limitation is stated in the body, never hidden.

## The frozen SHA (ties to review-tiers)

- A packet's candidate is frozen at an exact SHA on its branch; review runs
  against that SHA.
- Any fix after review is a new commit, a new SHA, and a fresh review — the
  prior review is void (review-tiers rule). Do not `amend`/`rebase` to hide a
  post-review change; make a new commit so the SHA moves visibly.
- The accepted SHA is recorded in the ledger row and must stay retrievable
  forever (see integration).

## Integrating an accepted packet

- Serial packet (the normal case): fast-forward `main` to the accepted branch
  tip. This preserves the exact reviewed SHA on `main` and keeps history
  linear — one readable stretch per packet.
- Parallel packets: use a real merge commit (`git merge --no-ff`), never a
  squash. Squashing an accepted packet detaches `main` from the reviewed SHA
  and breaks the evidence link. Do not squash accepted work.
- After integrating, delete the fully merged packet branch and
  `git worktree remove` its worktree if one was used.

## Pushing

- Push `main` to `origin` after every accepted packet — each checkpoint the
  user approves also becomes an off-machine backup.
- Also push any tag or packet branch whose exact reviewed SHA should be
  backed up off-machine.
- Never force-push `main` or any pushed/shared branch, and never rewrite
  published history. `--force-with-lease` is allowed only on a packet branch
  that has not yet been pushed or reviewed.

## Tags

- Tag immutable evidence artifacts and stage completions, not ordinary
  packets — e.g. `x01-baseline-v1`, `g0-complete`. Use annotated tags
  (`git tag -a`) with a one-line reason and push them explicitly
  (`git push origin <tag>`).

## Safety

- Before any history-losing command (`reset --hard`, `checkout -- <path>`,
  `clean`, branch delete), run `git status` and stash (`git stash -u`) or
  commit anything uncommitted first.
- All git commands run in Ubuntu/WSL against `/home/rvham/...` paths, never
  through a Windows path hop.
