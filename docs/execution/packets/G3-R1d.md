# G3-R1d — derive the verdict from what actually ran

Lane: BUILD · Base: `packet/g3-r1` at `0d9156c2` · Tier: Critical.

Implements the last section of
[`g3-completion.md`](../rulings/g3-completion.md) — *"Final ruling on
reconciliation, 2026-08-03 — observation, not a table; and a hard stop"*.

## Why four charters failed

Each specified a **hand-maintained artifact**: first a field list, then a
22-entry axis classification table. **Adversarial review does not converge on a
hand-maintained artifact.** `G3-R1c` round 2 audited all 22 entries specifically
to end this and still missed two — not carelessness, but because **a static
table cannot express "unaffected, unless nothing ran."** Both missed entries were
correct for the common path and wrong for a degenerate one: a superseded anchor,
an empty movement set.

## The fix — the table is deleted

`FINDING_AXIS_EFFECTS` and its `AxisEffect` type are **gone**. In their place:

- Each arm calls **`arm.examined(subjectId, axis)`** from the site that performs
  a check, recording that something on that axis actually executed.
- Each finding declares **only its own `axis` and `severity`**, at the site that
  emits it. There is deliberately no value meaning *"and the other axis is
  fine"* — that was `unaffected`, and it is what every missed entry got wrong.
- The verdict derives from both:

> A subject is `consistent` on an axis **only if something on that axis ran and
> found nothing.** A subject nothing examined is `unverifiable`.

**This is not the table under another name.** The table was a static map from
code to effect, maintained apart from the code that emits it, and it could — and
did — drift. A finding declaring its own axis is the emitting code stating what
it just did, at the point it did it, and it can make no claim about the other
axis at all. The `consistent` determination no longer comes from findings; it
comes from the execution record. **AGENTS.md §6 applied to the reconciler's own
verdict: a table of intentions is a declaration, a record of what executed is an
observation.**

## The three open findings are now structurally impossible

Each is shown, not asserted — every one has a victim control that reintroduces
it.

| Finding | Why it cannot happen |
|---|---|
| A superseded anchor read balance-consistent | Its branch (`:927-944`) never reaches the ledger comparison — *"there is nothing to re-derive"* — so `examined(cacheKey, 'balance')` is never called, and consistent requires it. |
| A line with zero movements read integrity-consistent | `examined(subjectId, 'integrity')` is called **inside the per-movement loop**. Zero movements, zero iterations, nothing examined. |
| A balance failure contaminated integrity | Integrity runs first and records its own success. A balance finding carries `axis: 'balance'` and can say nothing about integrity. |

A consequence worth naming: the third case now reports **more**, not less. An
anchor whose balance is out of contract used to force integrity to
`indeterminate`; its digest derives perfectly, so it is now integrity-**verified**
and balance-unverifiable — examined on one axis, honestly reported on both.

## Controls and recorded reds

`test/postgres/inventory-reconciliation.test.ts` — 23 subtests. **Every control
from `G3-R1`, `G3-R1b` and `G3-R1c` passes unchanged.**

| # | Vacuity vector | Victim | Recorded red |
|---|---|---|---|
| 28 | **the mechanism itself** — the "did anything run" record stops gating consistency | drop `\|\| !examined.has(subjectId)` from `axisVerdict` | `not ok 2` — `The expression evaluated to a falsy value`; also `not ok 23` |
| 29 | a superseded anchor claims a balance check it never ran | add `examined(cacheKey, 'balance')` to the superseded branch | `not ok 23` — `the superseded branch re-derives nothing, so no balance check ran` / `true !== false` |
| 30 | integrity is recorded per line instead of per movement | hoist `examined(subjectId, 'integrity')` out of the comparison loop | `not ok 23` — `no movement means no integrity comparison executed` / `true !== false` |
| 31 | integrity that ran does not record itself | drop the `if (integrity)` record | `not ok 1`; `not ok 19` — `a wrong balance with an intact digest must leave the integrity verdict clean` |

Victim 28 is the important one: it is the control for the **mechanism**, not for
any single finding. Removing the execution requirement makes subjects falsely
consistent across two independent subtests at once.

Subtest 23 also proves the axes independent in **both** directions from real
subjects rather than by construction: a live overflowing anchor is examined on
integrity only (integrity-consistent, balance-unverifiable), and a posted line
with no movements is examined on balance only (balance-discrepant,
integrity-unverifiable). A live unplaceable anchor is examined on **neither** and
is unverifiable on both.

The controls plant **live** anchors inside the subtest rather than reusing
earlier fixtures: by that point every earlier planted anchor is superseded, and a
superseded anchor is excluded rather than examined, which would have made the
assertions vacuous.

## What was not touched

Read-only enforcement and its observed read-back, the scope-agreement rule, the
completeness ratchet, `recognizedAnchorParameters`, the digest derivation
exported from the read path, and every prior control. No migration — `0021`
remains the last.
