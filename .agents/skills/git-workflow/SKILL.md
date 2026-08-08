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

**Tag a reviewed candidate before rebasing it — added 2026-08-06.** When a
review returns findings and the orchestrator instructs a rebase onto moved
`main`, the rebase rewrites the branch and the force-push that follows leaves the
**reviewed** SHA on no ref at all. It survives only in a local reflog, and the
remote will collect it.

    git tag -a <packet>-reviewed-r<n> <reviewed-sha> -m "<packet> round-<n> candidate as reviewed"
    git push origin <packet>-reviewed-r<n>

**Why a rejected candidate still needs to be retrievable:** a review's findings
cite file and line at the SHA they were written against. Once that tree is gone
the findings cannot be checked, and the record of *why* a packet was revised
becomes unverifiable. This is the same evidence-link reasoning that forbids
squashing accepted work — it simply applies one round earlier.

Caught on `U2` (2026-08-06), where the orchestrator instructed the rebase and did
not preserve `8feabfa` first; the lane force-pushed as instructed and reported it
plainly, and the tag was added at acceptance rather than before the rewrite. The
rule below permits `--force-with-lease` only on a branch not yet pushed or
reviewed; `U2`'s branch was both, so **an orchestrator-instructed rebase of a
reviewed candidate is the one case that overrides it — and it does so only once
the tag exists.**

## Integrating an accepted packet

**First, check whether `main` moved while the packet was in flight**
(`git log --oneline <base>..main`). A packet prompt names the base it was cut
from; that base is a starting point, never a claim that `main` will still be
there at integration. Orchestrator doc commits — ledger, current-plan,
doctrine-coverage, debate verdicts, ADRs — land on `main` between packets by
design (see "Branch model"), so a packet of any length should expect this.

- **`main` unmoved (fast-forward possible):** fast-forward `main` to the
  accepted branch tip. This preserves the exact reviewed SHA on `main` and
  keeps history linear — one readable stretch per packet.
- **`main` moved:** rebase the packet branch onto current `main`, or merge it
  with `git merge --no-ff`. Record both SHAs in the ledger row — the reviewed
  candidate and the integrated result. Prefer `--no-ff` when the reviewed
  candidate must remain literally retrievable as an ancestor; the ledger's
  existing rows record exactly this ("accepted by non-squash integration with
  the reviewed candidate preserved as an ancestor").

**Whether the integrated SHA needs its own matrix run is decided by the TREE's
EXECUTABLE CONTENT, not by the SHA** — corrected 2026-07-31.

    git diff --name-only <reviewed-sha> <integrated-sha> -- . \
      ':!docs' ':!.agents' ':!CLAUDE.md' ':!AGENTS.md' ':!learnings.md'

- **Empty output** — the integrated tree differs from the reviewed tree only in
  non-executable narrative, or not at all: the reviewed matrix **is** the
  acceptance matrix. Do not re-run. Record the reviewed run against the
  integrated SHA, with the command's empty output as the evidence.
- **Any output** — product code, test, config, migration, lockfile or generated
  artifact differs: re-run the full CI matrix at the integrated SHA before
  acceptance.

**ONE FULL MATRIX PER PACKET, AT THE FROZEN SHA — added 2026-08-03.** A lane runs
the full matrix when it freezes its candidate, not after every intermediate fix.
Measured on 2026-08-03: a full matrix is 11-18 minutes, and two packets that day
each ran three — `5g3-langgate` spent 34 minutes of matrix on one packet, and
`G3-R2` ran three before review even started. That cost bought no information,
because **only the final SHA is ever accepted**; a green matrix on a superseded
candidate proves nothing about the one that lands.

AGENTS.md section 6 requires the matrix green **at the integrated SHA**. It has
never required a run per revision round. Between rounds, run the targeted suites
that could possibly be affected — `test:unit`, `test:compiler`, the one
`test:postgres` file you touched — and freeze only when you believe you are done.

Re-run the full matrix when, and only when:

- you are freezing a candidate for review;
- a review finding changed executable content after that freeze; or
- the integrated tree's executable content differs from the reviewed tree, by the
  `git diff --name-only` rule above.

The failure this prevents is not a wrong acceptance — it is a lane spending an
hour proving three times over what it will have to prove once more anyway.

**`learnings.md` was added to the list on 2026-08-08**, after `lock-obs`'s integration
tripped on it: it sits at the repository root, outside all four original exclusions,
while being pure doctrine. Verified before adding — `grep -rln 'learnings.md'` over
`test/`, `packages/`, `scripts/` and `apps/` returns nothing, so no gate reads it.

The exclusions are exactly the paths the docs-only exception already names, and
for the same stated reason: those files are never executed, so a matrix cannot
observe them. Do not widen the exclusion list — a generated artifact under any
path voids it, and so does a lockfile.

This was previously written as *"either way the integrated tip is a new SHA, so
re-run"*, which under the standing `--no-ff` policy meant **every** packet paid
for a second 10-25 minute matrix — including packets whose integrated tree was
byte-identical to the reviewed one. AGENTS.md §6 requires the matrix to be green
at the integrated SHA; it does not require the *run* to have happened after the
merge commit existed. A run over an identical tree observes nothing new, which is
the same reasoning `lanes.md` already uses for the docs-only exception and the
same reasoning behind fast-forward integration ("the matrix already covers it").

**The identical-tree claim is verified, never assumed.** Run the `git diff
--quiet` above and record the result. A merge that silently resolved a conflict
changes the tree even when every incoming commit looked like documentation.
- Parallel packets: use a real merge commit (`git merge --no-ff`), never a
  squash. Squashing an accepted packet detaches `main` from the reviewed SHA
  and breaks the evidence link. Do not squash accepted work.
- After integrating, delete the fully merged packet branch and
  `git worktree remove` its worktree if one was used.

**Never `reset --hard` `main` to a packet's base or branch tip.** If a
fast-forward is refused, that refusal is information — `main` has commits the
packet does not. Forcing it discards them silently. This has cost three
recoveries in this repository (2026-07-26), twice leaving documents referencing
files that no longer existed. Rebase or merge; do not reset. The same applies to
re-running a writer: rebuild on current `main`, never re-reset to the original
base.

## Pushing

- Push `main` to `origin` after every accepted packet — each checkpoint the
  user approves also becomes an off-machine backup.
- **This rule is now executable.** `scripts/check-origin-sync.sh` fails when
  `main` holds commits that are not on `origin`, and a `post-merge` hook runs it
  after every integration. It needs no network: it compares against the local
  remote-tracking ref, which is the honest question. Pass `--fetch` to refresh
  first. **Why it exists:** on 2026-08-02 this rule was found to have lapsed for
  eight days and **637 commits**. Merging kept working perfectly — 90 accepted
  ledger rows — but pushing stopped, so a week of work existed on exactly one
  laptop. A declared rule with no executing gate is the pattern AGENTS.md
  section 6 exists to close.
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

## A live lane works in its own worktree — added 2026-08-06

**Path leases separate what a lane may edit. They do not separate the directory
it edits in.** Two lanes sharing one checkout share one working tree, so one
lane's in-progress file is simply present in the other's `git status`.

`U1` hit this: `apps/web/scripts/compile-app-release.ts` — a `proj-disc-impl`
file `U1` was explicitly told to stay out of — appeared in the shared checkout
mid-packet, and a `git add -A` swept it into `U1`'s first commit. The lane caught
it, restored the path from its base, amended, and its frozen SHA contains none of
it. **Nothing shipped. But nothing prevented it either.**

Two rules, and the second is the one that would have made the first unnecessary:

- **Never `git add -A` while any other lane is live.** Stage an explicit path
  list. This was already written above; `U1` is the case that shows what it costs
  when it lapses.
- **A build lane runs in its own `git worktree`.** Not only for the matrix — for
  the whole packet. `git worktree add ../<repo>-<packet> packet/<id>`, and
  `git worktree remove` on integration.

**A worktree is necessary but not sufficient**, which is the non-obvious part:
`proj-disc-impl` *did* have its own worktree and its edit still reached the shared
directory. So both rules stand together — isolation for the tree, explicit paths
for the index.

**A full matrix run in a shared checkout cannot be trusted to measure the
packet's own tree.** When `U1` ran one, the shared directory did not typecheck,
on a symbol belonging to the other lane.

Remove stale trees. On 2026-08-06 `git worktree list` showed thirteen, twelve of
them from packets accepted days earlier.

## The stash is repo-global, not worktree-local — added 2026-08-08

**`git stash` is shared lane state in exactly the way the working directory is**,
and this repository has been running four to five worktrees at once.

`PS-2` measured a baseline by running `git stash push` on an **already-clean**
tree. It saved nothing, so the `git stash pop` that followed applied
**`stash@{0}` — `packet/g3-term`'s preserved work** — into an unrelated worktree,
producing four `UU` conflicts in files that packet never touched. Nothing was lost:
the pop failed on conflict so the entry survived, and `git reset --hard HEAD`
restored the tree because the lane's own work was already committed. **Both of
those conditions were luck.**

Two stashes hold preserved work right now — `packet/g3-term`'s and
`packet/g2-p3b`'s — and they were **one careless `pop` from being consumed by any
lane in any worktree.**

- **Never `git stash pop`.** Use `git stash apply stash@{n}` with an explicit
  index, then drop it deliberately once you have confirmed what you applied.
- **`git stash push` on a clean tree saves nothing**, so the paired `pop` reaches
  for someone else's entry. Check `git status --porcelain` first, and skip the
  stash entirely when it is empty.
- **Read `git stash list` before either command.** An entry labelled
  `On packet/<other-lane>` is not yours.
- **Preserved work does not live in a stash.** It has been tagged —
  `preserved/g3-term-stash` and `preserved/g2-p3b-stash`, pushed to `origin` — so
  the commits survive even if the stash entries are dropped. **Anything worth
  keeping gets a ref, not a stash slot.**
