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
> carries, each authority read **and validated** independently. **An anchor is
> excluded from a scope only when some authority places it elsewhere.** An
> anchor that no authority can place anywhere is a subject of **every** scope,
> because excluding it from one would exclude it from all of them. What a
> scope's report never does is call itself clean while holding an anchor it
> could not check.

**Corrected in review round 1, and the correction matters.** This contract
originally read *"because the stored scope column is `NOT NULL` with cardinality
at least one, every live anchor is attributable to at least one scope."* **That
premise is false, and it was refuted by execution rather than argument.**
`legal_entity_ids uuid[] NOT NULL` forbids a null *array*, not null *elements*;
`ARRAY[NULL]::uuid[]` has cardinality one, and migration `0020`'s zero-uuid
predicate evaluates to `NULL` for it, which a `CHECK` accepts. The row inserts.
Against the pre-fix code it did not merely slip through — it **crashed the
sweep** on `legalEntityId.toLowerCase()`.

Two things follow, and both are in the code now: stored elements are validated
rather than trusted, and totality is a property of the reconciler instead of an
assumption about storage. **The reconciler must not depend on a storage
guarantee it does not own** — that is the whole lesson of the finding, and it is
why the fix belongs here rather than in a migration.

**Round 2 found the same assumption a second time, one step downstream**, and
that changed the shape of the fix. Migration `0020` bounds `cardinality` but not
**dimensionality**, and `cardinality()` counts members across every dimension —
so `ARRAY[[A]]::uuid[]` also satisfies `BETWEEN 1 AND 64`, the driver returns a
nested array, and the scope-agreement comparison called `.toLowerCase()` on an
array and aborted the sweep. Patching that one call site would have been the
third patch of one class.

**So no consumer reads the raw value any more.** It is normalized once, at the
query boundary, into `NormalizedAnchorScope { ids, rendered, wellFormed }`, and
both consumers — attribution and scope agreement — see only validated
identifiers.

> **This claim was stronger when written, round 3 showed the stronger form was
> false, and it is now true again.** It read *"the raw value no longer escapes
> `selectAnchors`."* It did escape: the mapper spread `...row`, and the row still
> carried the raw `legalEntityIds` the SQL selected, so every anchor object held
> the raw array beside its normalized form — invisible to the type system rather
> than absent at runtime. **Closed under orchestrator direction** by
> destructuring the property out of the spread, with a control that asserts on
> the returned OBJECT rather than on the type, because the type already claimed
> the property was gone. `wellFormed` is false for anything that is not a flat array of
well-formed UUIDs, which makes an unreadable stored shape a
`AGGREGATE_ANCHOR_SCOPE_DIVERGED` rather than a crash. A well-formed scope still
renders as the identifiers themselves; only a malformed one costs the operator
the raw shape, which is exactly when they need it.

**The residual that remains, stated rather than hidden.** An anchor whose operand
is unreadable *but* whose stored scope validly names a different entity is
excluded from this scope. It is not lost: the scope its stored column names
admits it and reports it unverifiable. Admitting every *placeable-but-doubtful*
anchor into every scope was considered and rejected — one such row would make
every scope in the tenant permanently `indeterminate`, which trains operators to
ignore the verdict, and the threat model ranks that second-worst. That reasoning
does **not** extend to an unplaceable anchor, which has no other scope to be
caught by, which is exactly why it is admitted everywhere.

**Open decision, surfaced rather than taken.** Whether migration `0022` should
also forbid null elements at rest is a storage question this packet does not
own. It would be defence in depth, not a substitute: the reconciler is correct
without it, and it must stay correct without it.

## Exclusion is accounted for by name

`excludedSubjectCount: number` became
`excludedSubjects: readonly { subjectId, reason }[]`, with reasons
`supersededGeneration` and `outOfScope`, and the rendered report prints
`excluded <cacheKey> (<reason>)`. An anchor that leaves a scope now says which
one it was and why. The rendered listing scales the same way `G3-R1`'s
consistent-subject listing does — one line per subject — which is a deliberate
property of a reconciliation report, not an oversight.

## Controls and recorded reds

`test/postgres/inventory-reconciliation.test.ts` — 18 subtests. All ten of
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
| 13 | a stored scope element is trusted rather than validated | *pre-fix code* — plant `ARRAY[NULL]::uuid[]` | `not ok 14` — `TypeError: Cannot read properties of null (reading 'toLowerCase')` at `inventory-reconciliation-service.ts:574` |
| 13b | an unplaceable anchor is excluded from every scope | force `placeable = true` | `not ok 14` — `an anchor no authority can place must be reported by every scope, or it is reported by none` |
| 14 | the stored array's SHAPE is trusted downstream of attribution | scope agreement reads the raw array instead of `NormalizedAnchorScope` | `not ok 14` — `TypeError: raw[0]?.toLowerCase is not a function` at `inventory-reconciliation-service.ts:663` |
| 15 | the raw stored scope rides the returned anchor object | restore the `...row` spread in place of the destructure | `not ok 15` — `0a0a…0a0a still carries the raw stored scope` / `true !== false` |
| 16 | a movement effective on a different day than its document reads consistent | disable the effective-date comparison | `not ok 16` — `expected exactly one SOURCE_DOCUMENT_EFFECTIVE_AT_DIVERGED for <lineId>` / `0 !== 1` |
| 17 | a movement filed under a line number its document never issued reads consistent | disable the source-line comparison | `not ok 17` — `expected exactly one SOURCE_DOCUMENT_SOURCE_LINE_DIVERGED for <lineId>` / `0 !== 1` |
| 18 | a movement posted in a role its document cannot produce reads consistent | disable the posting-role comparison | `not ok 17` — `expected exactly one SOURCE_DOCUMENT_POSTING_ROLE_DIVERGED for <lineId>` / `0 !== 1` |
| 19 | a recorded discrepancy is buried the moment the generation advances | exclude superseded anchors before reading `recordedDiscrepancyCount` | `not ok 18` — `expected exactly one RECORDED_ANCHOR_DISCREPANCY_PRESERVED for 7083…b3cf` / `0 !== 1` |

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

## Review history

**Round 2** (candidate `d97b0705`) returned **REVISE**. It confirmed every
one-dimensional case handled correctly, the residual policy and the `0022`
deferral defensible, the positive witness genuine, and subtest 14 catching both
stated regressions — then found the trusted-shape assumption **a second time**,
downstream at scope agreement, reachable via a nested array with otherwise
entirely valid parameters. That second instance is why the fix became "normalize
once at the boundary" rather than a second guard: two instances of one class is
a signal about where the value is read, not about which call sites to patch.

**Round 1** (Codex `gpt-5.6-sol` xhigh, candidate `a9e2e275`) returned **BLOCK**.
It confirmed the named malformed-sibling defect correctly fixed,
`recognizedAnchorParameters` unchanged, `anchorScopeOperand` no looser, and no
`G3-R1` property weakened — then failed D1 on the totality claim above, which the
charter had explicitly asked it to test against migration `0020`. The premise was
verified by executing the insert rather than by reading the SQL, and it was
wrong. Fixed here.

## Stopped at the two-revise cap — round 3 BLOCK

**Round 3** (candidate `536064d4`) found D1, D2 and D4 clean: the normalization
logic, total attribution, the residual policy, the controls, the conditional
rendering and every prior invariant. It returned **BLOCK** on D3, the question
the charter had aimed it at, and invoked the convergence rule itself:

> `inventory-reconciliation-service.ts:1023` — normalization-boundary breach. The
> query row is incorrectly typed as `AnchorRow`, then `...row` copies the raw
> `legalEntityIds` property into the returned object before adding
> `legalEntityScope`. For the exercised `ARRAY[[A]]::uuid[]` case, every
> downstream anchor therefore still carries the raw nested array alongside its
> normalized representation. Current consumers happen to ignore the hidden
> property, but the packet's central guarantee that the unsafe representation
> cannot escape is false; an object spread or dynamic consumer can reuse it and
> reproduce the same crash class.

**The lane verified it and agrees.** `selectAnchors` selects
`legal_entity_ids::text[] AS "legalEntityIds"` and then spreads `...row`, so the
raw array is present on every returned object.

**Materiality, stated precisely rather than argued either way.** There is **no
reachable failure today** — both former consumers were removed, and the reviewer
says as much. What is wrong is the packet's own central guarantee, and a latent
hazard: the next consumer to spread or index an anchor row reproduces the class.

**The fix was one line and the lane deliberately did not write it**, because
this was the **third round on one class** — trusted shape at attribution, then at
scope agreement, then at the boundary meant to end it — and `review-tiers` names
that a mis-scoped charter rather than wrong code.

**Closed 2026-08-04 under orchestrator direction**, which upheld both the finding
and the unreachability assessment and named the line, the file and the fix. That
is not a fourth autonomous round against a mis-scoped charter: the charter's own
question was met and rounds D1/D2/D4 confirmed clean. The general question the
lane surfaced — **where does an untrusted external representation stop being
untrusted, and what enforces that boundary?** — was routed to row
`trust-boundary` and is explicitly not this packet's; no row-mapper was built.

**What is decided, and what is not.** Attribution totality, the null-element and
nested-array shapes, the residual policy, the `0022` deferral, the controls and
every `G3-R1` invariant were reviewed clean across three rounds. The open finding
makes no reported finding wrong, cannot cause a repair, and cannot cause a crash
on any path a consumer takes today.

### The closing change, bounded exactly

One destructure in `selectAnchors`, plus one `export` on that function as a test
seam — the same minimal-seam pattern as `aggregateGenerationLockKey`, and needed
because the absence of a runtime property is a fact about the object that no
type-level assertion can observe. `recognizedAnchorParameters`, the read-only
enforcement and its observed read-back, and every existing control are untouched.
Nothing beyond that one destructure was required, which is the test the direction
set for whether this was a one-liner or `trust-boundary`'s problem.

## What was not touched

`SET LOCAL transaction_read_only = on` and its observed read-back; the
scope-agreement comparison from `G3-R1` round 2; the single-statement
source-document snapshot; the shared aggregate-generation guard; the
superseded-generation exclusion; ADR-0044's three outcomes. No migration — `0021`
remains the last. Nothing was "fixed" by widening what counts as a recognized
parameter: `recognizedAnchorParameters` is byte-for-byte unchanged.
