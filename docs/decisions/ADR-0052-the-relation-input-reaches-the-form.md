# ADR-0052: A relation input reaches the form, and is create-only by declaration

Date: 2026-08-10
Status: accepted — ruled by the orchestrator before `ux-reference-picker`, which
implements it. The create-only limit and its UI disclosure were ruled on
2026-08-09 in `current-plan.md` row `relation-update-fork`; this ADR records the
wire that makes the create half reachable and carries that ruling into a
decision record.
Tier: Critical (it changes compiled operation-contract output)

> **PARTIALLY SATISFIED — updated 2026-08-12 by `relation-contract-integrity`,
> packet 1 of 3 from the `ux-reference-picker` re-charter.**
>
> **Settled by packet 1 (§1, §2, §3, §4's enforcement):** the contract carries
> the target; one EFFECT-AWARE parser owns every relation rule and both the
> gateway and the browser call it; relation identities are unique; create-only
> is enforced as an artifact invariant at both boundaries; and entity relation
> authority is enforced agreement over the whole entry, with the absence of any
> authority reported explicitly rather than collapsed into an empty list. Each
> is backed by a negative control verified to red alone.
>
> **NOT yet satisfied, and owed by `relation-scoped-enumeration` (packet 2):**
>
> - **§7's claim that a picker caller cannot supply a legal-entity scope is
>   FALSE**, and until packet 2 lands, **no picker is rendered at all**. Every
>   first-party inventory target list is legal-entity-scoped, so a picker that
>   excludes scoped lists leaves `inventory_transaction_line_form`,
>   `stock_count_form` and `stock_count_line_form` uncreatable. Packet 1
>   deliberately ships **no renderer**, so the ADR's consequence — that a module
>   with a required relation becomes web-creatable — is **not yet true**.
> - §5's refusal behaviour and §6's control shape are packet 2's to implement.
>
> Tracked as `relation-picker-rechartered` in `docs/execution/current-plan.md`.
> The blocked first attempt is preserved at tag `ux-reference-picker-reviewed-r2`.

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

**An OPTIONAL relation with no resolvable target renders nothing**, rather than a
`<select>` whose only choice is `None`. Under the adopted profile no relation
carries a target, so that is the normal case until v2 adoption, and rendering an
inert control there would reintroduce exactly the defect this ADR removes.

The refusal reuses `QUERY_UNSUPPORTED`, because the missing thing genuinely is a
semantic data capability. **The reuse is declared, not silent:** that sentence
does not name *which* capability is absent, which is worse for an operator than a
dedicated code would be. Routed as `relation-refusal-unnamed` rather than fixed
here, to keep this ADR's diff on the wire.

### 6. No scripted control

ADR-0036 §2 authorises exactly four client behaviours and a server-rendered
`<select>` needs none of them — it carries no script at all. If option count ever
makes a bare `<select>` unusable, that is a finding for `ux-list-usability`, not
a licence to add a combobox.

### 7. One picker, generalised — not a second one

`pickerListSurfaceFor` and `recordPickerOptions` are extracted from the existing
legal-entity context bar and serve both callers. The legal-entity control's
exclusion of legal-entity-scoped target lists generalises unchanged: such a list
refuses without a scope argument the picker cannot supply, so admitting it would
render an empty control rather than a working one.

Requiring **exactly one** candidate list surface also generalises: two lists over
one entity is an authoring ambiguity the runtime must not resolve by picking.

## Consequences

- A module with a required relation is creatable from the web at profile v2.
- The compiled operation contract gains two version constants and one key.
- Historical lineage is untouched; the shipped app is unchanged until v2 adoption.
- The v2 adoption packet now carries two accumulated fields, not one.
- `updateRecordEffect` still cannot change a relation, and now says so on screen.

## What this ADR does not decide

- **Whether the form wire should carry typed JSON or validated strings.** Relation
  ids travel fine as strings because `parseMutationInput` reads them through
  `uuidRecord`. Field values do not — `validateFieldValue` demands a native
  boolean for `booleanFieldType` alone, and an empty control posts `""` which
  every non-text kind refuses. Both are filed as `form-write-untyped-wire` and
  `form-empty-means-nothing` and neither is touched here.
- **When profile v2 is adopted.** That is a separate packet, per ADR-0047 §2.
- **Whether a relation should ever be updatable.** §4 declines to buy it now; it
  does not rule it out.
