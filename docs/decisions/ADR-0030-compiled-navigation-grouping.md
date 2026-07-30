# ADR-0030: Compiler-derived navigation grouping

Date: 2026-07-30
Status: proposed by packet G3-P6c; ratified when that packet is accepted
Tier: Critical (review per `review-tiers`)

## Context

Inventory exposes five entity List surfaces. The composed application already
exposes four List surfaces from Party, Catalog, and Location. Compiler
conformance requires every Inventory entity to retain its active List surface,
while the surface-grammar projector currently treats every active List as a
top-level navigation entry. Mounting Inventory therefore produces nine
top-level entries, exceeding both the desktop maximum of seven and the compact
maximum of five.

Those maxima are physical UX constraints, not debt ratchets. The compact limit
is paired with a fixed bottom bar at 390 pixels and a no-horizontal-scroll
requirement. Hiding links with CSS leaves the compiled projection over budget
and can make a surface unreachable, so presentation-only truncation is not an
admissible fix.

The canonical model already provides all grouping inputs: every Module has a
stable ID, label, lifecycle, and order key, and every Surface has a stable
module reference. The plan explicitly requires Module definitions to project
navigation and permits navigation grouping as customizable content. No new
authored spelling is required.

## Decision

Navigation grouping is a compiled surface-manifest concept, not a web-only
presentation heuristic.

For a package whose active navigable surfaces fit within the compact maximum,
the compiler preserves the existing flat manifest. When the flat set exceeds
five, the compiler emits an explicit `navigationTree` in the surface payload:

- one stable group per module that owns at least one active navigable surface;
- one leaf for every active List-role surface, plus the legacy role-less List
  and Home surfaces already admitted by the runtime;
- module groups ordered by Module `orderKey` and stable ID;
- surface leaves ordered by stable Surface ID; and
- at most five top-level entries. If more than five module groups exist, the
  first four remain top-level and a compiler-owned `More` group contains every
  remaining module group.

The fixed top-level maximum is five for the single compiled tree. It therefore
satisfies both compact five-entry and desktop seven-entry limits without
emitting two breakpoint-specific navigation authorities. Desktop retains the
same tree and gains no separate overflow policy.

The web runtime renders the compiled tree directly. A module with one leaf is
a direct link labelled by the module; a module with multiple leaves is a
disclosure whose children are the compiled List links. `More` is a disclosure
of the remaining module groups. Nested children remain keyboard reachable and
the compact disclosure scrolls vertically when needed.

The surface-grammar gate counts the compiled tree's top-level entries. It also
independently requires the tree's leaves to cover every active navigable
surface exactly once and requires the compact projection to retain every
compiled top-level entry. Thus grouping cannot pass the budget by dropping,
duplicating, or CSS-hiding a List.

This is a surface **output payload-version** event. Flat manifests retain
`northstar.surface-manifest-payload/v0-provisional` and require surface runtime
capability 1. A grouped manifest emits
`northstar.surface-manifest-payload/v1` and requires capability 2. V1 requires
the tree; v0 forbids it. The compiler exports the exact supported-version set,
and the production loader reads the selected version from the persisted
projection manifest, verifies that the release reference, projection manifest,
and payload agree, and propagates that observed version into RequestRuntimeView.
An unknown or mismatched version fails visibly.

No canonical language-version event is created. The compiler derives this
projection solely from already-normalized Module and Surface structure. This
follows the existing compiler-contract pattern used by Inventory's
legal-entity family classification: projection semantics may be ruled by the
pinned compiler without adding redundant canonical spelling.

## Consequences

Mounting Inventory changes the composed application's top-level navigation
count from nine flat List entries to four module entries: Party, Catalog,
Location, and Inventory. Inventory movement, Inventory period lock, Inventory
transaction, Inventory transaction line, and Legal entity are all children of
the Inventory disclosure.

A later sixth mounted module requires no mechanism change. With six module
groups the compiler emits four direct groups plus `More`; the fifth and sixth
modules remain reachable through that disclosure while the top level stays at
five.

The current three-module composed application has only four navigable
surfaces, so it retains the existing flat payload and checked-in release bytes.
Old flat v0 payloads remain readable. The first over-budget composed release
will move its release artifacts because its compiled surface payload becomes v1
and gains the tree. An old v0-only reader refuses v1 by version instead of
silently ignoring the tree and reconstructing unreachable flat overflow.

Module labels become top-level navigation labels when grouping activates.
Entity List labels remain visible as children. This is a generated default,
not a module-specific menu or an Inventory branch.

## Evidence

The G3-P6a investigation established the forcing contradiction:

- `packages/compiler/src/conformance.ts:1074-1091` requires active List roles;
- `projectCompactSurfaces` in
  `packages/dev-tooling/src/surface-grammar-conformance/index.ts` projected the
  flat active navigation set into compact navigation; and
- `isNavigationSurface` in that contract defined every active List as
  navigation.

G3-P6c compiles a composed Party, Catalog, Location, and Inventory definition
without changing those entities or List surfaces. Its architecture control
must observe 25 surfaces, nine navigable leaves, four compiled top-level
groups, and exact reachability of all nine leaves.

## Enforcement

- The compiler surface projection emits the tree generically from module
  ownership and never names a product module.
- The surface runtime rejects malformed trees, unknown leaves, duplicate
  leaves, incomplete reachability, and a grouped tree mislabeled as v0.
- The production projection loader imports the compiler-owned supported surface
  versions, propagates the artifact-declared version, and rejects unknown or
  cross-layer-mismatched versions.
- Surface-grammar conformance measures compiled top-level entries and exact
  leaf coverage; executed reds remove a leaf, duplicate a leaf, omit the tree,
  and exceed the top-level budget.
- Browser controls exercise disclosure, keyboard focus, compact target size,
  no horizontal scroll, and navigation to every child List.
