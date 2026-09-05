---
name: review-tiers
description: The one review arm — when it is owed, what it reads, what counts as
  a finding, and how it ends. Read before writing or running a review prompt.
---

# Review — one arm, Critical set only (rewritten 2026-09-04)

## When an arm is owed

Only when a vertical's diff touches the **Critical set** (`AGENTS.md` §4): the
posting kernel, the posting trigger and rebuild, release activation and
verification, the trust substrate, migrations, RLS and grants. Everything else
ships on typecheck, tests, CI and the user's click-through, and its record says
`Review: not owed`.

## What the arm is

- **Fresh naive, user-run, online**, never spawned by the lane or the
  orchestrator. Codex gpt-5.6-sol xhigh or Fable max; one of them, the
  orchestrator picks.
- It reads the **diff to the Critical paths** and the **numbered claims** in the
  packet record. It is asked one question: *is there a defect in production code
  under these claims?* It is not asked to find any way the packet could fail, to
  grade the record, or to review evidence depth.
- **Prompt ≤ 40 lines**: repository, branch, frozen SHA, the Critical paths, the
  claims, the reading list, "say plainly if this prompt steers you".

## What counts

- **A production defect** — wrong behaviour in `packages/**`, `apps/**` (not the
  regenerated release), `db/**` — is fixed, with a test, and the fix is a new
  SHA. **A second arm is owed only for that**, on the fix.
- **Anything else** — a control that could be stronger, a record sentence, an
  evidence gap, a naming — is **filed as one line** in the record's *Filed*
  section (and the archive table if it names future work). It never earns a
  round.
- A reviewer's own re-run of the gate is welcome and is recorded as such.

## How it ends

- First arm, no production defect → **converged**. Integrate.
- First arm, production defect → fix, second arm on the fix only → integrate.
- Second arm, another production defect of the **same class** → the charter was
  wrong; the orchestrator re-scopes rather than paying a third arm.
- The verdict is one row in `review-log.md`: SHA, packet, arm, verdict, date,
  one sentence.

## Evidence in the Critical set

One discriminating red per claim in `test/evidence/<packet>.expected-red.json`,
run through `evidence:expected-red`; each control must die alone. A stored value
or balance that is wrong silently (Band A) needs its control to observe the fact
(a row, a counter, a constraint), never a proxy. Outside the Critical set no
manifest is owed.

## Standing rules

- Any code change after a review is a new SHA; the prior verdict is void.
- Tag a reviewed candidate before any rebase (`git-workflow`).
- The orchestrator verifies a finding by reading the code before ruling on it.
