# ADR-0054: A record form declares the anatomy that renders it

Date: 2026-08-17
Status: accepted
Tier: Behavioral (review per `review-tiers`)

## Context

**No Inventory form could render or be saved, and this was recorded five times
without an owning row.** The G2-composition program review named it on
2026-07-27 as its sharpest finding — *slot dispatch and data rendering are two
disconnected mechanisms* — and coined the standing lesson **"a recorded finding
with no owning row is a disposition with no executing gate."** This ADR is the
executing gate.

### The defect, measured at `39fef80`

`apps/web/src/component-registry.ts` holds two closed registries. The
`componentRegistry` maps three shell-owned `contentReferenceId`s. The
`surfaceSlotRegistry` maps **eleven** `(archetype, slot)` pairs — three `list`,
three `task`, and a **record family of exactly five**: `record:breadcrumb`,
`record:commandBar`, `record:keyFacts`, `record:sections`,
`record:titleStatus`. **There is no `record:activity` and no
`record:childTables`.** `surfaceComponentRenderer` is a closed lookup with no
register/override escape hatch, and `surfaceHasUnsupportedComponent` refuses
**the whole surface** when any one declared slot misses.

`packages/domain/src/inventory/definition.ts` authored its form anatomy as
`['breadcrumb', 'titleStatus', 'activity']`. Decoded from the shipped
`app.compiled.json`, the split across all nine form surfaces was exact:

| declares `sections` — renders | declares `activity` — does not |
|---|---|
| `item_form`, `location_form`, `party_form`, `party_role_form` | `inventory_transaction_form`, `inventory_transaction_line_form`, `legal_entity_form`, `stock_count_form`, `stock_count_line_form` |

Every broken surface is authored by one `surfaces()` factory in the Inventory
module, and `legal_entity` is authored there too — which is why the platform's
own legal-entity form sat in the broken set.

### Why `sections` is not one slot among five

`record:sections` is **the only registration in the repository carrying
`mutationIntents: { form: ['create', 'update'] }`**. `surfaceSupportsRuntimeIntent`
returns false for any surface with no slot registered for the requested intent,
so a form without `sections` is **inert by construction**, before any renderer
runs. `renderSections` is also the only renderer that emits the field controls
and the `<form id="surface-record-form">` element they post through. A record
form that omits `sections` has not merely lost a panel; it has no form.

### The consequence on the inventory path

Of the four form surfaces carrying a required create relation, three could not
render — `inventory_transaction_line_form`, `stock_count_form`,
`stock_count_line_form` — and those three are exactly the legal-entity-scoped
specimens. The only one that rendered was `party_role_form`, the single
unscoped case. `relation-scoped-enumeration` stopped here and was right to.

## Decision

**1. Every first-party surface with `surfaceRole: 'form'` declares exactly the
five registered record slots, in focus order:**

    ['breadcrumb', 'titleStatus', 'commandBar', 'keyFacts', 'sections']

This is now uniform across all nine form surfaces in the composed application.
`commandBar` is included rather than left to `renderSections`' fallback Save
button, for two reasons: the UX grammar makes the command bar the home of the
primary action, and `surfaceSupportsRuntimeIntent`'s `record` branch requires a
**related form that supports create or update**, so a working form is also what
re-admits archive and restore on the paired `detail` surface.

**2. `activity` is not declared by any first-party module.** A slot declared
with no registered renderer is forbidden — it is ADR-0041's accepted-and-ignored
state, *indistinguishable from success at every point where anyone would look*.

The G2-composition review recorded that **the language cannot express "declared,
intentionally unregistered."** That is still true, and it is decisive here: a
declared-unregistered slot is indistinguishable from the defect this ADR fixes,
so shipping one re-arms it. Registering a renderer instead is out of reach at
this size — the activity rail renders trust-substrate change documents, which is
a second data binding on the surface, and `ux-grammar` makes a surface gaining a
second binding the explicit trigger to re-rule which unit resolves.

**3. The residual absence is expressed by name, not silently.**
`SURFACE_SLOTS.record` in `packages/canonical-model/src/constants.ts` is *exact
anatomy* — all seven slots are required — and the conformance checker observes
that floor. So omitting `activity` and `childTables` is reported as
`SG003_REQUIRED_SLOT` and `SG009_COMPACT_SLOT` **naming the missing slot and the
surface**, counted in the reviewed debt baseline that cannot move without a
same-commit edit. That is the mechanism which makes the absence declared and
observable, and it is why removal is honest where declaration is not.

**4. This ADR does not create a default.** No slot is materialized for a surface
that declares none; the change is to the authored definition, which is the only
place surface anatomy is stated.

## Consequences

- **Five Inventory form surfaces render and carry a save control**, and
  `legal_entity_form` **creates a record end to end from the browser**. It is
  the specimen because it is the only repaired surface with neither a required
  relation nor a legal-entity system input, so the anatomy was the only thing
  between the operator and the record.
- **The other four still refuse, and they refuse LATER than they did** — at the
  provider, on the content of the write, rather than at composition with
  `UNSUPPORTED_COMPONENT`. Two distinct causes, and the second was **measured
  during this packet rather than predicted**:
  - `inventory_transaction_line_form`, `stock_count_form` and
    `stock_count_line_form` carry required create relations with no rendered
    control — `MODULE_REQUIRED_RELATION_MISSING`, which is exactly what
    `relation-scoped-enumeration` is chartered to close.
  - **All four are legal-entity-scoped, and a scoped create additionally
    refuses `MODULE_REQUIRED_SYSTEM_INPUT_MISSING` on `legalEntityId`.**
    `operationInput` returns `{recordId, relations, values}` for a create and
    never carries the selected legal entity, while every scoped create contract
    declares it in `closedArgumentKeys`. **This is a separate defect from the
    anatomy, and it is not fixed here.** It is the same shape as
    `required-relation-uncreatable`, one argument key over.

  **An earlier draft of this ADR claimed `inventory_transaction_form` was
  creatable end to end. That was wrong and the browser control refuted it**;
  the claim now rests on the surface that actually creates a record.
- **The Inventory conformance debt falls** and the baseline moves with it in the
  same commit, per the ratchet's own rule.
- **`record:activity` and `record:childTables` remain unregistered
  platform-wide** — party, catalog and location carry the identical two-slot
  gap. This ADR does not close it and does not widen it.

## Evidence

- Registry census and the nine-surface compiled split, above, both read from
  `apps/web/release/app.compiled.json` at `39fef80` rather than predicted.
- Relation census from the compiled operation catalog: four create operations
  carry relation inputs — `inventory_transaction_line_create`,
  `party_role_create`, `stock_count_create`, `stock_count_line_create`.
  `inventory_transaction_create` and `legal_entity_create` carry none.
- A browser control observes each repaired surface's five slots, its posting
  form, its field controls and a Save bound to that form by id — not merely the
  absence of `UNSUPPORTED_COMPONENT`, which a useless surface would also
  satisfy. `party_form` runs through the identical helper as the untouched twin.
  `test:browser` 90/90; `test:postgres` 203/203; `test:architecture` 141/141.
- **Negative control, with its red attributed.** Reverting the authored anatomy
  to `origin/main`'s and re-running turns both controls red **on their own
  subjects**: `UNSUPPORTED_COMPONENT` returns to 1 where 0 is required, and the
  `New` link returns to 0 where 1 is required. 75 sibling tests stay green.

  **A first attempt at this control was discarded because its red was not the
  control firing.** Reverting the source and regenerating *appended* a lineage
  entry carrying the older definition, which the runtime refused as a rollback
  without a verified forward activation (`ReleaseReverseTransitionRefusal`), so
  the application never started and both tests failed in 2 ms for a reason
  unrelated to anatomy. The valid form of the control restores the release to a
  legitimate forward head rather than appending a backwards one.
- **A prior measurement is corrected.** `relation-scoped-enumeration`'s stop
  record tabulates `party_role_form` as `breadcrumb, titleStatus, activity`. It
  is not, and was not at that branch's base: `party_role_form` carries the full
  five and renders. Its conclusion — that the scoped Inventory forms are the
  blocker — is unaffected and correct.

## Enforcement

- **Observed, per surface:** the committed browser controls render each repaired
  form against the real composed application and submit it. AGENTS.md §6 prefers
  an observation to a proxy; a rendered input and a persisted record are the
  fact itself.
- **Ratcheted:** `test/architecture/surface-grammar-conformance.test.ts` compares
  every product module's measured violation count against
  `surface-grammar-conformance.baseline.ts` and fails on a change in **either**
  direction, so re-introducing `activity` on a form moves a count and must move
  the reviewed artifact with it.
- **Refused at render:** `surfaceHasUnsupportedComponent` still refuses any
  surface declaring an unregistered slot, by name, with the component id as a
  declared subject.

**The honest limit.** There is **no static gate binding "every declared slot has
a registered renderer."** The conformance checker reads compiled definitions and
has no view of the web registry; the registry's slot keys are not exported. Such
a gate would need `apps/web/src/component-registry.ts`, which is outside this
packet's lease and is deliberately read here as authority rather than edited.
**This is the residual, and it is the shape of the original defect:** what this
ADR fixes is observed per surface, and what would prevent the next instance is
not yet mechanized. It is filed as future work rather than left implicit.
