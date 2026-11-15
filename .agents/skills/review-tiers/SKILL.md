---
name: review-tiers
description: The read of the trunk — when one is owed, what it reads, the one
  question it is asked, and how a finding ends. Read before writing a read prompt.
---

# Review — one read of the trunk, after the merge (rewritten 2026-11-15)

## Nothing waits for a review

While pre-tenant (no `docs/execution/rulings/first-tenant.md` — ADR-0066's
switch), every vertical merges on CI green. Review reads `main` afterwards. From
the first tenant on, the unread range must be empty before a release is
activated for a tenant; a merge still never waits.

## The unread range

`git diff <read-through> main -- <Critical paths>` (`AGENTS.md` §4), where
`<read-through>` is the `main` SHA in the newest `read` row of `review-log.md`.
Paths decide what is read, never the writer: nobody classifies their own diff
out. A merge that touches a Critical path is logged `merged — unread`.

## When a read is owed

- the unread range passes **400 changed lines** (`git diff --shortstat`); or
- before a stage-gate packet, the week-6 decision, or `rulings/first-tenant.md`.

Otherwise none. The orchestrator, or whichever lane is open, writes the prompt.

## What the read is

- **Fresh naive, user-run, online**, never spawned by a lane or the
  orchestrator. Codex gpt-5.6-sol xhigh or Fable max.
- It reads the unread diff and `docs/architecture/posting-kernel-guarantees.md`,
  never the records.
- **One question:** can this diff, silently, store a wrong quantity or amount,
  lose or repeat a posting, cross a tenant or company boundary, grant more than
  declared, skip an audit row, or let verification or activation pass a release
  it should refuse?
- **Prompt ≤ 40 lines**: repository, the two SHAs with a `git ls-remote` line,
  the paths, the question, what the writer did not verify, and "this framing is
  a claim under test; say plainly if it steers you".

## What counts, and how it ends

- **A silent defect** is fixed with a test and merges on CI green. **No confirm
  arm, ever:** the fix is inside the next read's range by construction.
- **A failure that announces itself** — a false refusal, a red check, an error
  naming its cause — and everything else (evidence, wording, naming) is one
  line in `current-plan-archive.md`. It is fixed when a real package hits it.
- The read is one `read` row in `review-log.md`: the `main` SHA read through,
  the verdict, the date, one sentence. That row moves `<read-through>`.
- The orchestrator verifies a finding by reading the code before ruling on it;
  a verdict covers the SHA it read, and later commits are simply unread.

## Evidence

One discriminating red in `test/evidence/<packet>.expected-red.json` for each
claim that a silent harm cannot happen; the control observes the fact (a row, a
counter, a constraint), never a proxy, and dies alone. Everything else: tests.
