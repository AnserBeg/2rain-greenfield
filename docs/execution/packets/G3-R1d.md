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

`test/postgres/inventory-reconciliation.test.ts` — 24 subtests. **Every control
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

## The confirm arm, and what it found

**Codex `gpt-5.6-sol` xhigh returned PASS** at `a33d0616` — the first pass in
sixteen rounds. **Fable max, the confirm arm this tree had never had, REFUTED
it.** Both were right about different things, and the refutation is why a second
arm exists.

Fable confirmed C1–C3 without reservation — the verdict mechanism, the deleted
table, and all five `examined` placements — then refuted the claim that the
accumulated tree carries no remaining reachable false-consistent.

### F1 — refuted by execution, not by argument

Fable's finding: the movement-to-line pairing is keyed by `transactionLineId`
alone, and legal entity is used only as a **filter**, never projected or
compared. So in a scope naming two entities, a movement booked to the wrong
entity would pair with its line, agree on every column, and read consistent while
one entity is short and the other holds a phantom.

The reasoning is exact about the reconciler and about the writer. **The control
written to reproduce it refuted it instead:** the movement-to-line relation's
foreign key is entity-scoped (`compiler/src/storage.ts:1071,1077`), so a movement
cannot reference a line in another legal entity. PostgreSQL rejects the insert
with `23503`. The state is unrepresentable.

**So no comparison was added.** A comparison guarding an unrepresentable state is
an unexercised branch, which AGENTS.md §6 forbids as firmly as it forbids a
missing one. Subtest 24 observes the constraint instead — the cross-entity
movement is refused, the entity-consistent one is accepted, and the document then
reconciles clean in a genuine **two-entity scope**, which no prior test had ever
used. That absence is exactly why the question stayed open for sixteen rounds.

### F2 — a subject classified twice was counted twice

Real and fixed. `arm.unverifiable` does not return, so an anchor can be
classified twice — integrity unverifiable, then parameters unrecognised. The
accumulator counted classifications rather than distinct subjects, inflating
`subjectCount` and listing one cache key twice. `#unverifiable` is now a `Set`
and consistency excludes it. The authoritative axis verdicts were never affected;
this was report accounting.

### F3 — the ratchet's universe was undeclared, and is now enforced

Fable observed that `business_period` shares F1's blind spot: the completeness
ratchet walks `entity.columns`, and a movement's **infrastructure** columns —
`tenant_id`, `environment_id`, `record_id`, the legal-entity column and
`business_period` — are bound elsewhere on the entity and are structurally
invisible to it.

That boundary is no longer prose. `MOVEMENT_INFRASTRUCTURE_CLASSIFICATION` records
a decision for each, and `assertMovementColumnsClassified` now enforces it over
the infrastructure list too, so an unclassified infrastructure column fails
construction exactly as an unclassified field column does.

| # | Vacuity vector | Victim | Recorded red |
|---|---|---|---|
| 32 | a movement booked to another entity is representable | *storage itself* — insert the cross-entity movement | `23503` — `violates foreign key constraint` (the control's positive result) |
| 33 | the infrastructure ratchet stops seeing a column | drop `entity.recordIdentity.column` from the infrastructure list | `not ok 20` — `Missing expected exception.` |
| 34 | subjects are counted per classification, not per subject | inflate `subjectCount` by one | `not ok 1`; `not ok 8` |

## What was not touched

Read-only enforcement and its observed read-back, the scope-agreement rule, the
completeness ratchet, `recognizedAnchorParameters`, the digest derivation
exported from the read path, and every prior control. No migration — `0021`
remains the last.
