# G3-R1b — anchor scope attribution

Lane: BUILD · Base: `packet/g3-r1` at `bbe5382a` · Tier: Critical.

Owns the one question `G3-R1`'s charter never named, and which all three of its
review rounds circled: **how does a sweep attribute an anchor whose stored scope
may itself be wrong?** `G3-R1` holds at `bbe5382a`; both packets integrate
together.

## The defect

`recognizedAnchorParameters` is all-or-nothing by design — it gates whether a
balance can be **re-derived**, and a malformed horizon makes that impossible.
Attribution went through the same function, so it inherited that verdict: a
recognized query with a valid legal-entity operand `A` but any malformed sibling
parameter returned `null`, the operand was discarded, and an anchor whose corrupt
stored scope named `B` fell out of `A`'s reconciliation entirely. `A` then
reported **`consistent`**.

Reachable because migration `0020` constrains `parameter_values` only to
`jsonb_typeof(...) = 'object'`. Disqualifying for this packet specifically:
reconciliation exists to tell the truth about balances, and *couldn't check*
rendered as *clean* is [ADR-0044](../decisions/ADR-0044-search-capability-is-derived-and-never-silently-empty.md)'s
failure one level up.

## The design, and why it closes the hole

**Attribution takes the union of every authority the anchor carries, each read
independently of the others.** Two authorities exist: the stored
`legal_entity_ids` column, and the query's own legal-entity operand. The operand
is now read by `anchorScopeOperand`, which parses that one parameter and nothing
else, so a malformed sibling cannot discard it.

| Authority | Read by | Independent of |
|---|---|---|
| stored scope column | `anchor.legalEntityIds` | the operand |
| legal-entity operand | `anchorScopeOperand` | every sibling parameter, and whole-parameter recognition |

An anchor is a subject of a scope when **either** authority names it. It is
excluded only when **neither** does.

Why this closes the hole: the exact scenario has a readable operand naming `A`,
so `A` now admits the anchor as a subject; `recognizedAnchorParameters` still
returns `null`, so it is reported `AGGREGATE_ANCHOR_PARAMETERS_UNRECOGNIZED` and
**unverifiable**, and the arm — and the scope — become `indeterminate`. The
value can still not be checked. What changed is that the scope no longer calls
itself clean while holding it.

**This does not replace round 2's membership rule; it feeds it.** The
scope-agreement comparison inside `#reconcileOneAnchor` — stored scope must equal
the operand, or `AGGREGATE_ANCHOR_SCOPE_DIVERGED` and discrepant — is untouched.
This packet decides *whether the anchor is examined at all*, upstream of it.

### The attribution contract, stated exactly

> An anchor is attributed to every legal entity named by any authority it
> carries, each authority read independently. A scope's verdict covers exactly
> the anchors attributable to it. Because the stored scope column is `NOT NULL`
> with cardinality at least one, **every live anchor is attributable to at least
> one scope**, so no anchor is invisible to every reconciliation. What a scope's
> report never does is call itself clean while holding an anchor it could not
> check.

**The residual, stated rather than hidden.** An anchor whose operand is
unreadable *and* whose stored scope names a different entity is excluded from
this scope — its every surviving authority points elsewhere. It is not lost: the
scope its stored column names admits it and reports it unverifiable. The
alternative — admitting every doubtful anchor into every scope — was considered
and rejected: one unattributable row would make every scope in the tenant
permanently `indeterminate`, which trains operators to ignore the verdict, and
the threat model ranks that second-worst.

## Exclusion is accounted for by name

`excludedSubjectCount: number` became
`excludedSubjects: readonly { subjectId, reason }[]`, with reasons
`supersededGeneration` and `outOfScope`, and the rendered report prints
`excluded <cacheKey> (<reason>)`. An anchor that leaves a scope now says which
one it was and why. The rendered listing scales the same way `G3-R1`'s
consistent-subject listing does — one line per subject — which is a deliberate
property of a reconciliation report, not an oversight.

## Controls and recorded reds

`test/postgres/inventory-reconciliation.test.ts` — 13 subtests. All ten of
`G3-R1`'s vacuity controls still pass unchanged; two assertions moved from
`excludedSubjectCount` to `excludedSubjects` and became stronger, not weaker.

**The headline red is the charter's exact scenario, executed against the pre-fix
code.** The named-exclusion accounting was landed first so the control could
compile, leaving attribution untouched — so this red isolates the attribution
defect and nothing else:

| # | Vacuity vector | Victim | Recorded red |
|---|---|---|---|
| 11 | a partly corrupt anchor hides from the scope its operand names | *pre-fix code* — stored scope `B`, valid operand `A`, malformed `atTime`, otherwise-consistent `A` subjects | `not ok 13` — `an anchor the sweep could not check must never leave the scope reading clean` / `+ 'consistent'  - 'indeterminate'` |
| 11b | attribution routed back through all-or-nothing recognition | `const operand = parameters ? parameters.legalEntityId : null` | `not ok 13` — `2c2c…2c2c must be reported, not excluded` |
| 12 | exclusion stops naming what it dropped | `ArmAccumulator.excluded` records nothing | `not ok 3` — `the read anchor is superseded by the planted movements and is named as excluded`; `not ok 8` — `the anchors this scope excludes are counted, not silently dropped`; also `not ok 13` |

Subtest 13 carries all four charter controls in one run, on a legal entity of its
own so the pre-fix verdict is genuinely `consistent` rather than masked by the
divergences planted earlier:

- **the exact scenario** — stored `B`, operand `A`, malformed sibling → reported
  unverifiable, scope `indeterminate`;
- **fully corrupt** — operand unreadable, stored scope the only authority left →
  still reported, never silently excluded;
- **positive witness** — a real posting through `PostgresInventoryPostingService`
  and a real aggregate read produce one consistent line and one consistent
  anchor in the same report, so the fix is not "mark everything indeterminate";
- **exclusion names what it dropped** — every entry carries a subject id and a
  reason, and the rendered report prints both.

## What was not touched

`SET LOCAL transaction_read_only = on` and its observed read-back; the
scope-agreement comparison from `G3-R1` round 2; the single-statement
source-document snapshot; the shared aggregate-generation guard; the
superseded-generation exclusion; ADR-0044's three outcomes. No migration — `0021`
remains the last. Nothing was "fixed" by widening what counts as a recognized
parameter: `recognizedAnchorParameters` is byte-for-byte unchanged.
