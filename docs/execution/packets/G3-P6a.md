# G3-P6a — Mount Inventory and expose read-only views

Status: candidate; frozen SHA and gate verdicts are reported in the writer handoff

Tier: Behavioral

Branch: `packet/g3-p6a-v2`

Base: `ebea719af56aeac692390a6f872dad5e9207825f`

## Outcome

`composedApplicationDefinition()` now instantiates Party, Catalog, Location, and
Inventory under `northstar.app`. Inventory contributes the same canonical
collections and module definition used by its standalone contract; the builder
owns only the composed module order and package ownership.

Inventory List and Record surfaces are visible through the existing compiled
`SurfaceRuntime`. The browser journey creates a draft fixture, posts it through
`PostgresInventoryPostingService`, then reads the resulting movement and posted
transaction through the semantic query gateway. The posting service is test
setup, not a browser operation or route.

## Read-only boundary and visible incompleteness

Only Inventory surface declarations changed in
`packages/domain/src/inventory/definition.ts`:

- List retains `title` and `dataGrid`.
- Record retains `breadcrumb`, `titleStatus`, and `keyFacts`; `commandBar` is
  absent, so archive and restore are not rendered or accepted.
- The compiler still structurally requires Form declarations for the three
  mutable Inventory entities. Those declarations retain only `breadcrumb` and
  `titleStatus`. The generic runtime treats such incomplete forms as
  `SURFACE_GRAMMAR_INCOMPLETE`, does not link them from Lists or Records, renders
  no inputs or buttons, and refuses direct operation submissions.
- Inventory movement and period-lock entities remain without Form declarations.

No Inventory operation, posting service, entity, field, relation, compiler, or
provider declaration changed. The incomplete anatomy is intentionally visible;
G3-P6b owns the later anatomy burn-down and agent journeys.

## Navigation

Desktop navigation now asserts these release-defined List labels exactly:

```text
Inventory movement
Inventory period lock
Inventory transaction
Inventory transaction line
Item
Legal entity
Location
Party
Party role
```

At 390x844 the same navigation DOM still undergoes the platform compact
transformation. The browser now measures rendered links and retains the binding
maximum of five visible bottom tabs; the numeric cap was not raised.

## Posting-fixture repair

`loadInventoryDefinition()` no longer appends Inventory to the composed
definition. It instantiates Inventory only as an expected-value oracle and
asserts that every Inventory assertion, entity, field, operation, permission,
query, relation, state machine, storage mapping, surface, and module occurs
exactly once in the composed fixture.

The G3-P3/G3-P4a controls still reach the same fixture because `buildFixture()`
continues to compile the return value of `loadInventoryDefinition()` and derive
its storage projection before every posting database setup. None of the posting
test body, control helpers, registrations, service calls, or assertions changed.
The new exact-once assertions fail before those controls if composition omits or
duplicates any Inventory construct, preventing the former manual merge from
silently bypassing them.

## Release artifact movement

| Artifact | Before SHA-256 | After SHA-256 |
|---|---|---|
| `apps/web/release/app.authored.json` | `0e5103391c451bb95dbf52355a31ab41307e546f8b89280c3bb49b01957b2519` | `391a9700aa5c5c6913a955ec4ac688170144cc6bce78d3af0a1636d848168c9d` |
| `apps/web/release/app.compiled.json` | `78e24a5cae0a2e6a73fc41e239d585727f2038459f3cc3e4fb66a4c00ab60c1a` | `0c4b9f802f7d8eb13eb2700e587bde2d3c51b51f5f04de7d17bfafa45b4e8c8c` |

The latest application release root moves from
`bf932f8a4a69edc23c7a62c4191e1e9cf92c9482d38fc8bcef90945461615783`
to
`19e8321d552a3d450d2f2bd53d406d215dd4f73b13c970d19264d9ae2455bc1e`.
Earlier application lineage remains present. The diagnostic shell artifacts did
not move.

## Gates and inherited limitation

The writer handoff records the requested `format`, `typecheck`, and `lint`
results. By orchestrator direction, this candidate does not run the full matrix:
its stacked G3-P4 base contains migration 0016 without the corresponding
`db/schema.snapshot.json` regeneration, so `check:schema` has a known inherited
`SchemaDriftError`. This packet neither edits nor regenerates that out-of-scope
snapshot.

## Test it yourself

After the schema-snapshot lane is merged, run the focused browser journey:

```bash
corepack pnpm test:browser
```

The composed journey should show the nine desktop navigation labels above, no
more than five visible mobile tabs, one real `browser-posted-adjustment`
movement, its `ADJ-BROWSER-001` posted transaction, no Inventory New/Edit or
lifecycle controls, and a visible `SURFACE_GRAMMAR_INCOMPLETE` diagnostic if the
inert transaction Form URL is requested directly.

## Recorded limits

- Inventory surface-anatomy violations remain visible and are not suppressed or
  allowlisted; G3-P6b owns their burn-down.
- The browser test invokes the admitted posting capability only to arrange real
  persisted read data. This packet adds no human or agent posting UI.
- The full matrix, PostgreSQL suite, and browser suite remain unverified at this
  stacked candidate until the inherited schema snapshot is repaired and the
  orchestrator grants the serialized matrix slot.
