# G3-P6c — Navigation grouping for mounted modules

Status: evidence ready; frozen candidate reported in the writer handoff

Tier: Critical

Branch: `packet/g3-p6c`

Base: `0e148958050573a291053252a2904165dcf2cc36`

Frozen candidate: reported in the writer handoff because a commit cannot contain
its own SHA

## Goal

Derive a bounded, fully reachable navigation tree from canonical module and
surface ownership so modules may retain every compiler-required List surface
without exceeding the physical shell budgets.

## Outcome

ADR-0030 selects a compiler-derived navigation tree. Presentation-only folding
is rejected because the architecture gate reads the compiled projection and
because hiding links is not reachability.

The compiler emits grouping only when the flat active navigation set exceeds
five. Each module contributes one parent regardless of entity count. More than
five module parents become four direct parents plus one `More` parent. The web
runtime renders that exact tree, and conformance independently verifies that
every active navigable surface occurs exactly once.

This is an output derivation from existing Module and Surface fields. It adds
no canonical property and requires no language-version event. It does require a
surface output payload-version event: flat manifests stay v0/capability 1;
grouped manifests are v1/capability 2.

The current three-module application remains byte-for-byte unchanged: its four
List entries fit the compact budget, so the optional tree is absent. The
P6a-shaped application with Inventory compiles 25 surfaces and nine List leaves
into four top-level entries: Party, Catalog, Location, and Inventory. Inventory
movement, Inventory period lock, Inventory transaction line, Inventory
transaction, and Legal entity are children of Inventory. A separate six-module
compiler fixture produces Module 1 through Module 4 plus `More`; Module 5 and
Module 6 are children of `More`.

## Why grouping is compiled

A presentation-only fold would leave the architecture input at nine navigation
entries. The compiler now emits the parent/leaf tree in the surface manifest,
the compact projector consumes those parent IDs, and the architecture gate
counts those exact compiled parents. CSS no longer truncates the sixth rendered
link. Runtime parsing rejects an over-budget flat manifest and rejects a tree
that loses or repeats an active List.

The tree is required in surface payload v1 and forbidden in v0. Both are derived
from existing normalized Module and Surface data. No canonical spelling or v4
event is needed. The precedent is the compiler-owned legal-entity family map:
pinned compiler semantics may derive projection structure without creating a
redundant authored property.

The first Critical review found that emitting the tree under unchanged v0 would
let the parent reader ignore it, reconstruct nine flat entries, and hide compact
overflow. The finding was accepted as material. The bridge adds the production
projection loader and its PostgreSQL control: one compiler-owned supported set,
artifact-selected version propagation, and exact reference/manifest/payload
agreement.

## Navigation observations

| Definition | Before | After | Reachability |
|---|---:|---:|---|
| current Party/Catalog/Location application | 4 flat | 4 flat | unchanged |
| application plus Inventory | 9 flat | 4 module parents | all 9 List leaves exactly once |
| six one-List modules | 6 flat | 5 parents (`1-4 + More`) | all 6 List leaves exactly once |

Both desktop and compact projections consume the same tree. The top-level count
is therefore at most five, below the unchanged desktop maximum of seven and at
the unchanged compact maximum of five.

## Owned paths

- `packages/dev-tooling/src/surface-grammar-conformance/**`
- `packages/compiler/src/**` for the surface projection only
- `apps/web/src/**` for navigation rendering
- `test/architecture/surface-grammar-conformance.test.ts`
- `apps/web/test/browser/**`
- `packages/postgres-provider/src/request-runtime-view-service.ts` (granted
  compatibility bridge)
- `test/postgres/request-runtime-view.test.ts` (granted persistent-loader
  control)
- `docs/decisions/ADR-0030-compiled-navigation-grouping.md`
- `docs/execution/packets/G3-P6c.md`

## Out of scope

Canonical-model changes, Inventory declarations, compiler entity-projection
requirements, navigation-cap increases, exemptions, posting, and migrations
remain out of scope.

## Executed controls

| Vacuity vector | Control | Observed result |
|---|---|---|
| grouping could be presentation-only | compile the application plus Inventory and read the surface artifact | four compiled module parents and nine exact leaves |
| grouped output could be mislabeled as v0 | present a v0 envelope containing the tree to SurfaceRuntime | `INVALID_SURFACE_NAVIGATION`; no flat fallback |
| a persisted version could come from a loader constant | activate and load a grouped release | RequestRuntimeView propagates surface payload v1 from the artifact |
| an unknown persisted version could be accepted | activate a fully rehashed release whose surface reference/manifest/payload agree on an unknown version | `MALFORMED_REQUIRED_PROJECTION` at manifest support validation |
| cross-layer version mismatch could be hidden | activate a fully rehashed release whose manifest says v1 and payload says v0 | `MALFORMED_REQUIRED_PROJECTION` at payload agreement validation |
| grouping could drop a List | remove one Inventory leaf | `SG012_NAVIGATION_REACHABILITY` |
| grouping could count a List twice | duplicate one Inventory leaf | `SG012_NAVIGATION_REACHABILITY` |
| compact could silently omit a parent | remove one compiled parent from the compact projection | `SG012_NAVIGATION_REACHABILITY` |
| an over-budget release could omit grouping | remove the tree from nine Lists in conformance and six Lists in the runtime fixture | unchanged budget reds plus runtime `INVALID_SURFACE_NAVIGATION` |
| a sixth module could require mechanism code | compile six synthetic modules | five parents, with modules 5 and 6 reachable under `More` |
| rendered disclosure could hide the leaves | keyboard-open `More` at 390x844 and follow all six links | six distinct List headings observed; 44px targets and no horizontal scroll |

The surface-grammar baseline did not move. Catalog remains 13, Inventory 71,
Location 13, Party 23, and Platform 33. No checked-in release artifact, digest,
or golden moved; `check:app-release` accepted the existing bytes.

## Focused evidence

The final focused development run before freezing observed:

- compiler: 97 / 97;
- integration: 59 / 59;
- architecture: 100 / 100;
- grouped-navigation browser file: 8 / 8; and
- persistent RequestRuntimeView loader: 9 / 9; and
- checked-in application release: unchanged and green.

The first required formatting attempt was honestly red on five touched
TypeScript files. Prettier was applied to those files, then the required gate
was rerun from the beginning:

```bash
corepack pnpm format && corepack pnpm typecheck && corepack pnpm lint
```

After the candidate passes Critical review, obtain the serialized matrix lease
before running:

```bash
~/2rain-missions/run-matrix.sh
```

## Test it yourself

Run the compiled-projection and compact-browser controls:

```bash
corepack pnpm test:architecture
corepack pnpm exec playwright test apps/web/test/browser/surface-grammar.spec.ts --grep "compiled groups|version boundary red"
```

You should see architecture 100 / 100 and browser 2 / 2. The architecture test
observes the mounted-Inventory shape as four parents and nine leaves. The browser
opens a five-item bottom bar at 390x844; `More` reveals Module 5 and Module 6,
and every one of the six links loads its own List heading. The red control labels
a grouped tree as v0 and observes `INVALID_SURFACE_NAVIGATION` instead of a flat
fallback.

## Recorded limits

- This packet provides the generic grouping mechanism; it does not mount
  Inventory. G3-P6a owns that composition and its release-artifact movement.
- The standalone production-module surface debt is unchanged. This packet does
  not alter List requirements or Inventory surface declarations.
- Module labels are the generated parent labels. Tenant-authored grouping and
  search remain future compiled customization, not browser heuristics.
- The full matrix and both Critical review seats are reported against the exact
  frozen SHA in the writer handoff so review metadata does not recursively
  change that candidate.
