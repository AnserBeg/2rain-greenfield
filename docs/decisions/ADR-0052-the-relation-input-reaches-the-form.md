# ADR-0052: A relation input reaches the form, and is create-only by declaration

Date: 2026-08-10
Status: accepted — ruled by the orchestrator before `ux-reference-picker`, then
amended 2026-08-19 by `relation-scoped-enumeration` after the first two attempts
proved that unscoped enumeration did not close the first-party case. The
create-only limit and its UI disclosure were ruled on 2026-08-09 in
`current-plan.md` row `relation-update-fork`; this ADR records the wire and the
scoped enumeration that make the create half reachable.
Tier: Critical (it changes compiled operation-contract output)

> **SATISFIED — updated 2026-08-19 by `relation-scoped-enumeration`, which also
> absorbs the blocked `relation-contract-integrity` remainder.**
>
> **Settled by packet 1 (§1, §2, §3, §4's enforcement):** the contract carries
> the target; one EFFECT-AWARE parser owns every relation rule and both the
> gateway and the browser call it; relation identities are unique; create-only
> is enforced as an artifact invariant at both boundaries; and entity relation
> authority is enforced agreement over the whole entry, with the absence of any
> authority reported explicitly rather than collapsed into an empty list. Each
> is backed by a negative control verified to red alone.
>
> **Settled by the final packet (§5-§7):** the current legal-entity selection is
> carried into each target list under that list's own declared operand; the
> target query therefore offers same-scope records only. `hasMore` is the
> completeness boundary, `truncatedByMaximum` is not an independent refusal,
> optional targetless relations render nothing, and every named enumeration
> refusal carries the relation id. The form uses a native `<select>`, and update
> forms disclose the create-only freeze.
>
> The packet also closes the remaining catalog-authority split: both the browser
> and operation gateway now admit the complete catalog through one parser before
> selecting an entity or operation. Extra root keys and cross-entity operation-id
> collisions therefore receive the same decision for the same reason.

## Context

A module with a required relation could not be created from any web surface.

The wire existed at every layer except the last one:

- the compiler emitted `relationInputs` for `createRecordEffect`
  (`packages/compiler/src/projections.ts`);
- the operation gateway declared the shape
  (`packages/runtime/src/semantic-operation-gateway.ts:177`) and named
  `relationInputs` in its closed key set (`:1266`);
- the provider validated it (`module-runtime-interpreter.ts:3423`, `:3436`) and
  refused a missing non-nullable relation with
  `MODULE_REQUIRED_RELATION_MISSING` (`:816`, `:3442`);
- and `operationInput` in `apps/web/src/surface-runtime.ts` **never built a
  `relations` key at all.**

So every required relation was unsatisfiable from a form, and the refusal was
correct at the moment it fired — the browser simply had no way to say what the
provider required.

**This was already live on `main`, not a future problem.** The row that opened
this work recorded that it "has never fired only because no first-party module
declares a required relation yet." **That premise is false and this ADR corrects
it.** The shipped `apps/web/release/app.compiled.json` contains five required
relations — `party_role_party`, `inventory_transaction_line_transaction`,
`stock_count_transaction`, `stock_count_line_session` and
`stock_count_line_transaction_line` — and four of their entities carry a form
surface (`party_role_form`, `inventory_transaction_line_form`, `stock_count_form`,
`stock_count_line_form`). `party_role` in particular is a plain first-party
entity whose create form has never been able to succeed.

### The renderer already existed; only one input was missing

`surface-runtime.ts` already shipped a working server-rendered record picker for
legal entity: it located a list surface by `sourceEntityId`, re-invoked the query
gateway inside the same request, derived labels from `displayFieldId`, and
rendered a `<select>`. Nothing about it was legal-entity-specific except the
entity id it was given.

**The only missing input was the target entity id**, and nothing in the
request-pinned view carried it. Verified by exhaustion over all five pinned
projections:

| Projection | Carries a relation's target entity? |
|---|---|
| `surface` (surface manifest) | No — surfaces carry `fieldIds`, no relations |
| `operation` (operation catalog) | No — `relationInputs` carried `relationId`, `required`, `archiveBehavior` |
| `catalog` (semantic model) | No — emits `{constructKind, semanticFingerprint, subjectId}` fingerprints, not content |
| `query` (query catalog) | No — `relationLabels` are caller-supplied, and the gateway resolves the target from a query the *caller* names |
| `agent` (agent discovery) | No |

## Decision

### 1. The relation input carries its target entity

`relationInputs[].targetEntityId` is emitted from `relation.targetEntity.targetId`.
The relation input contract is the right home: the target entity is a property of
the relation itself, and it is what makes the input fillable. Splitting it into
the surface manifest would let a renderer offer a relation the bound operation
does not accept.

### 2. The version is a 2x2, not a generation counter

The contract has two independent optional shapes, and the existing `v1`/`v2`
pair already bound one of them biconditionally — `systemInput` is present **iff**
the version is `v2` (`semantic-operation-gateway.ts:1276`). That is ADR-0041
made unrepresentable rather than merely detected, and collapsing it would have
been a regression.

So both axes are named:

| | no `systemInput` | `systemInput` |
|---|---|---|
| **no relation TARGETS** (no relations, or relations without targets) | `v1` | `v2` |
| **relation inputs carrying targets** | `v3` | `v4` |

The left column is deliberately not "no relation inputs" — that wording was
wrong and is corrected here. A generation-1 `v1` contract may carry relation
inputs; what it may not carry is `targetEntityId`.

Both biconditionals are enforced: `systemInput` present iff `v2` or `v4`, and
**`targetEntityId` carried on every relation input iff `v3` or `v4`.** A contract
that carries a shape it did not declare is refused, in either direction.

**CORRECTED 2026-08-10 after review.** This section first said *"`relationInputs`
non-empty iff `v3` or `v4`"*, which is wrong and would have been a defect if the
code had obeyed it: a generation-1 artifact may legitimately declare relations
**without** targets, and binding relation-input *presence* to the version refuses
every historical contract that does. The reviewer caught the ADR and the code
disagreeing, and ruled for the code. The version binds the **key**, not the
presence of the list. The only additional version-level rule is that `v3`/`v4`
cannot be minted vacuously: a contract claiming to carry targets must have at
least one relation input to carry them on.

**One parser, not two — and it is EFFECT-AWARE, because a relation contract's
legality is not a property of the contract alone.**
`parsePinnedOperationInputContract(inputContract, effectKind, fail)` owns every
relation rule: entry shape, the version axes, relation identity uniqueness,
relations-are-create-only, v3/v4-are-create-only, the `systemInput` create-only
rule, and the `relations` closed-key biconditional. Both the gateway and the
browser's surface contract call it and consume its result.

**The complete catalog has one authority too.**
`parsePinnedOperationCatalog(payload)` owns the closed root, validates every
definition, and enforces operation-id uniqueness over the whole payload before
any consumer selects an entity. The browser no longer keeps a second envelope
check or a post-filter identity set. This ordering matters: an extra root key or
an operation-id collision on another entity makes the whole pinned artifact
malformed even though neither changes the selected surface's apparent slice.

**Two earlier shapes were wrong, and the second is the subtler one.** The first
exported a parser that validated a strict SUBSET of the gateway's checks while
leaving the gateway's own loop in place, so the browser accepted five
single-property forgeries the gateway refused. The second — corrected here —
exported the relation *entry* parser as though it were the authority, but kept
the effect-aware rules inside the gateway's definition assertion, which only the
gateway calls. An update contract declaring relations, or a create contract
omitting the `relations` key, was then **bindable at the surface boundary and
malformed at the execution boundary**: one artifact, two interpretations. A
shared parser that does not own the whole rule is not an authority either.

**Relation identities are unique.** The web wire builds `relations` as a record
keyed by relation id and the provider builds a Map keyed by the same id, so two
entries sharing an identity are unrepresentable downstream — one submitted value
cannot satisfy two declarations, and a picker cannot tell which target the
identity names.

**An earlier attempt got this wrong in a way worth recording.** It exported a
shared function that validated a strict SUBSET of what the gateway checked and
left the gateway's own loop in place. The browser then accepted five
single-property forgeries the gateway refused — a missing `archiveBehavior`, an
unknown key, an invented `archiveBehavior`, a noncanonical `relationId`, a blank
`targetEntityId` — and deleting the shared call removed no gateway check
whatsoever. A shared parser that is not the only parser is not an authority.

An operation with no relations is therefore **byte-identical** to what it emitted
before this ADR, which is what keeps the change scoped to definitions that
actually declare a relation.

### 3. Emission is gated on the unadopted compiler-semantic profile v2

ADR-0047 §1 makes the compiler-semantic profile the axis on which projections
evolve, precisely so a shape change does not have to rewrite history. This change
is gated on `COMPILER_SEMANTIC_PROFILE_V2_VERSION`, which is cut and **not
adopted**.

The consequence is stated plainly rather than buried: **no recorded lineage entry
moves, every release root holds, and `check:app-release` verifies clean.**

**What does NOT follow, and was overclaimed once:** that the shipped application
is unchanged. Compiled bytes are unchanged, but browser behaviour is not
necessarily so — the reader now surfaces entity relation inputs that no earlier
binding exposed. "The artifact is byte-identical" and "the application behaves
identically" are different claims, and only the first is gated by the profile.

This is not a workaround. It is the same discipline row `U5b` recorded for the
disclosure tier ("cut `v2`, gate the field on it, leave adoption on `v1`… adoption
is a separate, schedulable event once fields have accumulated"), and this ADR
accumulates the second field onto it.

**Measured, not assumed:** gating only `schemaVersion` while emitting the key
unconditionally moved `applications[0]`'s release root and failed historical
reproduction with `COMPILER_HISTORICAL_REPRODUCTION_MISMATCH`. The key rides the
same gate as its version, and the check was run to observe it.

### 4. Relations are create-only, and the freeze is DECLARED in the UI

Relation metadata is read from the **entity**, not from the active create
binding. A release whose create effect has been retired still has an update form
and still has frozen relations; sourcing the disclosure from an active create
operation would drop it exactly where an operator is most likely to be surprised.
**Corrected 2026-08-10 after review.**

**Enforced at the catalog parser as of `relation-contract-integrity`, not merely
honoured by the compiler.** Relation inputs, and the `v3`/`v4` versions, are
admitted only on `createRecordEffect`, and the `relations` argument key must
agree with the effect in both directions. Before that, a fully shaped contract
declaring a REQUIRED relation on an update effect was admitted — and the
provider, which hardcodes `relations: {}` on its update branch, then validated
that empty object against the declaration, leaving **no representable input that
could satisfy any update of that entity**. An optional one was admitted and
silently ignored. Both are ADR-0041's accepted-and-ignored state, reachable by a
one-property mutation, so the artifact is refused rather than the failure
discovered at execution.

Relations are create-only all the way down: emitted only for
`createRecordEffect`, absent from `updateRecordEffect`'s closed argument keys,
and hardcoded to `relations: Object.freeze({})` on the provider's update branch
(`module-runtime-interpreter.ts:3369`). Changing a supplier on a draft is rare and
the workaround — cancel and re-create — exists, so an operation-contract change
is **not** bought here.

**But an operator must not discover the freeze by editing a draft and finding no
control.** The update form states it: the relation is named, and the sentence says
it is set at creation and cannot be changed there. A limit that is declared is a
product decision; a limit you find by failing is a defect.

**CORRECTED 2026-08-19 after the first `relation-scoped-enumeration` review.**
The disclosure is resolved before the update operation's current-record
precondition gates editable content. If that predicate does not hold, the
sections slot still renders the relation freeze (or the relation-authority
refusal), while the form, relation controls, Save action and operation submission
remain absent. The first candidate evaluated the predicate first and returned an
empty sections slot, so a directly addressed posted record hid exactly the
restriction this section requires it to declare.

### 5. A form that cannot be satisfied refuses, and does not render

If a required relation's target entity cannot be enumerated — no pinned list
query for it, or more than one, so the runtime would have to guess — the create
form refuses instead of rendering controls whose submission the provider is
certain to reject. This is ADR-0041's "honoured or refused" at the surface.

**A target that cannot be enumerated COMPLETELY is treated the same way.** The
shared list contract reports whether more records exist; a picker that renders
page one while further valid foreign-key targets sit behind a cursor makes those
targets unselectable while looking complete. That is not a usability wrinkle, it
is the silent wrongness this ADR's own §5 forbids, so `hasMore` refuses the
picker. **Corrected 2026-08-10 after review**, which rejected the original
routing of this to `ux-list-usability` as future UX work; it is a correctness
defect in the write path and belongs here.

`hasMore` is the boundary because it observes an omitted candidate.
`truncatedByMaximum` describes how the requested page size was bounded and does
not independently prove an omission, so a result with `hasMore: false` remains
complete when that flag is true. A complete empty list is complete too: the
required picker renders its unselected “Choose…” state and the optional picker
renders `None`; neither is misreported as an enumeration failure.

**An OPTIONAL relation with no resolvable target renders nothing**, rather than a
`<select>` whose only choice is `None`. Generation-1 historical artifacts may
still carry that shape; rendering an inert control for them would reintroduce
exactly the defect this ADR removes. The current profile-v2 first-party required
relations all carry targets.

Named enumeration failures use the dedicated blocking message
`RELATION_ENUMERATION_UNAVAILABLE`, whose subject is the relation id. An
operator therefore sees which relation prevents the form from rendering rather
than an unattributed “Save unavailable.” A wholly unavailable entity relation
authority is still not read as a known empty list; the surface refuses instead.

**CORRECTED 2026-08-19 after the second `relation-scoped-enumeration` review.**
The command bar and sections are independently rendered slots, but they consume
one form-admission decision. A relation refusal suppresses both the sections
form and the command-bar Save action; an admitted twin renders both. The prior
control used a compiler-valid sections-only form, so it proved that the form
disappeared without observing the separate Save path used by the shipped
five-slot Inventory anatomy. A blocking diagnostic beside a detached, dead Save
button is still a write control offered for an unsatisfiable form and does not
satisfy this section.

### 6. No scripted control

ADR-0036 §2 authorises exactly four client behaviours and a server-rendered
`<select>` needs none of them — it carries no script at all. If option count ever
makes a bare `<select>` unusable, that is a finding for `ux-list-usability`, not
a licence to add a combobox.

### 7. One picker, generalised — not a second one

`pickerListSurfaceFor` and `recordPickerOptions` are extracted from the existing
legal-entity context bar and serve both callers.

**AMENDED 2026-08-19: the former scoped-list exclusion was false.** The caller
already has the current legal-entity selection. For a scoped target list it
reissues that selection under the TARGET query's declared operand parameter id,
which need not be the form query's parameter id. The query gateway then applies
the existing sealed Q1-P5 read scope. This means a scoped child may select only a
parent visible in the same legal entity. It does **not** make the selected legal
entity a sealed write capability: on create it remains ADR-0055's untrusted,
permission-authorized system operand.

If the form itself requires legal-entity scope and none is selected, its existing
`QUERY_LEGAL_ENTITY_SCOPE_REQUIRED` refusal runs before picker enumeration. If a
scoped target is reached without exactly one selection (including a future
unscoped form targeting a scoped entity), that relation refuses by id; the
runtime never guesses a scope.

Requiring **exactly one** candidate list surface also generalises: two lists over
one entity is an authoring ambiguity the runtime must not resolve by picking.

For a target set beyond the declared list maximum, this generation stops at the
observed `hasMore` refusal; it does not chase cursors invisibly or present a
prefix. The bounded follow-on path belongs to `ux-list-usability`: a
server-rendered, non-operation relation-search submission carries the current
validated form strings and relation selections, invokes one target-list page at
its declared maximum, and returns the form with opaque previous/next cursors.
Search and paging never invoke Save, never manufacture list arguments, and add
no scripted control. Until that path exists, refusing an incomplete set is the
only honest behaviour.

## Consequences

- A module with a required relation is creatable from the web on the current
  profile-v2 release, including the four first-party scoped cases.
- The compiled operation contract gains two version constants and one key.
- Historical lineage before profile-v2 adoption remains untouched.
- `updateRecordEffect` still cannot change a relation, and now says so on screen.
- A relation refusal suppresses both form content and the separately rendered
  command-bar Save action.

## What this ADR does not decide

- **The form-wire representation.** ADR-0053 has since ruled validated strings
  with explicit empty intent. Relation ids already travel natively as strings
  and need no coercion.
- **Whether a relation should ever be updatable.** §4 declines to buy it now; it
  does not rule it out.
