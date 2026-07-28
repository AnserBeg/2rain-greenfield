# G2-P5d-nav — Entity navigation, record identity, and archive discovery

Status: evidence ready; frozen candidate reported in the writer handoff

Tier: Behavioral

Branch: `packet/g2-p5d-nav`

Base: `003d657735f77b7668bb8cdc17c2649f9484e83c`

Frozen candidate: reported in the writer handoff because a commit cannot contain
its own SHA

## Outcome

The composed application now presents one navigation entry per entity instead of
one entry per surface. Party, Party role, Item, and Location Lists are the four
sidebar entries; their Record and form siblings remain reachable through row,
New, Edit, and breadcrumb links.

The product and conformance checker use the same rule. An active surface is a
navigation entry when its compiled `surfaceRole` is `list`. Legacy role-less List
and Home surfaces remain navigation entries, preserving the diagnostic shell and
providing a safe compatibility rule for pinned releases. Record and form surfaces
are never sidebar entries. The checker therefore observes four navigation items
for the real twelve-surface composed application and applies the existing seven
desktop / five compact budgets to actual navigation entries rather than to every
surface.

Record detail headings now derive identity from the compiled entity's active Q0
resolve query. The renderer selects an advisory resolve-match field before an
identifier field and only when the bound query selects it. There are no Party,
Catalog, or Location branches. If no selected display field resolves, the heading
falls back to the existing shortened record ID instead of a module name.

List title chrome now exposes **Show archived** and **Hide archived**. The control
uses the existing `archived=yes` URL view state and the returned
`listCoverage.includeArchived` observation; it preserves literal search text and
intentionally clears the paging cursor when the result set changes. The default
remains archive-exclusive.

No domain definition, compiler, canonical-model, runtime, provider, platform
runtime, release artifact, or diagnostic shell changed.

## Established baseline

The branch was cut in an isolated worktree from exact SHA
`003d657735f77b7668bb8cdc17c2649f9484e83c`. The unchanged aggregate passed on its
first attempt:

| Gate | Baseline observation |
|---|---:|
| `check:demo-release`, `check:app-release` | green |
| `test:unit` | 36 / 36 |
| `test:compiler` | 52 / 52 |
| `test:integration` | 59 / 59 |
| `test:agent` | 3 / 3 |
| `test:architecture` | 73 / 73 |
| `test:contracts` | 6 / 6 |
| `test:postgres` | 86 / 86, first attempt |
| `test:locale` | 1 / 1 |
| `test:browser` | 16 / 16, first attempt |
| observability producer | 5 / 5 |
| `check:reachability` | 68 / 68 files from 9 producer artifacts |

The unchanged product conformance ratchet read four real compiled modules at
Catalog 19, Location 19, Party 36, and Platform 33.

## One navigation authority

`projectCompactSurfaces` and SurfaceRuntime both interpret the compiled
`surfaceRole`; neither infers module names or maintains an ID list. The shell also
marks the List entry current while a same-entity Record or form sibling is open by
comparing their pinned query source entity IDs. A failed or malformed data binding
does not make an unrelated navigation item current.

The diagnostic shell has four role-less Home surfaces. They remain navigable, so
its `c_unsupported` and `d_error` surfaces continue to exercise
`UNSUPPORTED_COMPONENT` and “Component unavailable”. The load-bearing
`(archetype, slot)` component dispatcher remains unchanged.

## Conformance observation

The architecture suite compiles `composedApplicationDefinition()` through the
unchanged production compiler. It observes twelve active surfaces, exactly four
compiled List roles, and exactly those four IDs in the compact navigation
projection. Adding four synthetic List siblings produces eight navigation entries
and both budget violations:

```text
G2-P5d-nav composed navigation: 4/7; synthetic navigation: 8/7 -> SG007_DESKTOP_NAVIGATION_BUDGET,SG008_COMPACT_NAVIGATION_BUDGET
```

Changing navigation projection removed Party's former compact-budget violation,
so the real ratchet baseline moves deliberately from 36 to 35. Catalog remains 19,
Location 19, and Platform 33. The standalone-product total is therefore 106.

## Executed negative controls

Every mutation below was temporary and restored before the candidate was
committed.

| Vacuity vector | Executed control | Observed red |
|---|---|---|
| the real composed product could still be absent from navigation evidence | run the new composed-product observation against the pre-fix projection | expected the four compiled List IDs; observed all twelve detail, form, and List IDs, so the architecture test failed |
| the sidebar could still render every surface | run the composed browser journey before the shell nav fix | expected `Item, Location, Party, Party role`; observed twelve entries including every `detail`, `form`, and `list`, so Playwright failed |
| a record title could still be the entity name | require the created Party's compiled display value before the title fix | Playwright could not find heading `Browser-persisted Party`; the old page heading was `Party` |
| fallback behavior could be unobserved | temporarily replace the short-ID fallback with the entity label | Playwright could not find the expected `<first 8>…<last 4>` UUID heading for the record with no display value |
| archive visibility could still require a hand-authored URL | temporarily suppress the archive toggle renderer | Playwright failed at the required visible `Show archived` link: `element(s) not found` |
| a conformance decrease could be an edited claim rather than compiler output | run the real ratchet before changing Party's baseline | `FAIL (4 compiled product modules read; catalog=19/19, location=19/19, party=35/36, platform=33/33; 1 ratchet violations)` |

## Positive observations

- The composed DOM contains exactly four sidebar labels. Its `record` and `form`
  surface labels are absent while the four List siblings are present.
- A synthetic eight-entity navigation fails both the desktop and compact budgets;
  the four-entry composed application fails neither.
- Party, Catalog, and Location Record headings render their compiled display
  values. A compiler-valid fixture whose record omits that value renders the
  shortened UUID and does not render the entity name as its H1.
- The ordinary Party List contains no archived row. **Show archived** makes the
  row and **Hide archived** control visible; **Hide archived** removes the row and
  restores **Show archived**. The existing archived Record link and Restore
  journey then continue to pass.
- The diagnostic shell still renders all four Home navigation entries and both
  intentional failure surfaces.

## Evidence and reproducible commands

Focused development evidence:

```bash
corepack pnpm typecheck
corepack pnpm test:architecture
corepack pnpm test:browser
```

The full candidate evidence uses:

```bash
corepack pnpm format
corepack pnpm build
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm check:boundaries
corepack pnpm check:schema
corepack pnpm check:demo-release
corepack pnpm check:app-release
corepack pnpm test
corepack pnpm check:reachability
```

Final counts at the frozen candidate are reported in the writer handoff.

## Test it yourself

With Docker running, start the composed application against an isolated
persistent database:

```bash
NORTH_STAR_DATABASE_CONTAINER=north-star-g2-p5dnav-check NORTH_STAR_DATABASE_PORT=55435 PORT=4177 corepack pnpm --filter @north-star/api dev
```

Open <http://127.0.0.1:4177>. The sidebar shows **Item**, **Location**, **Party**,
and **Party role**—not twelve surface names. Open **Party**, choose any populated
row, and the Record heading names that party. Archive it through **More actions**,
return to Party, and choose **Show archived**. The archived row appears. Choose
**Hide archived** and it disappears again.

What remains intentionally incomplete: 106 standalone conformance violations,
the composed-package conformance discovery gap, responsive anatomy, Platform,
and authorization. Current policy is allow-all, so use only local demo data.

## Recorded limits and what the gates cannot prove

- The composed application is observed by the new navigation-budget test but is
  still not a full input to the product conformance ratchet. Discovery requires a
  `definition.ts` and its parser assumes one module; changing that is explicitly
  deferred.
- The standalone ratchet remains at 106 rather than zero. Catalog and Location
  remain 19, Party is 35, and Platform intentionally remains 33.
- Resolve-query selection is generic and compiler-derived. Current Record DTOs do
  not carry formatted display values, so a non-text advisory value may render its
  canonical raw value until the read contract grows that projection. Missing
  values safely use the short identity.
- The browser evidence covers the present four-entity application and a synthetic
  eight-item budget red; it is not a grouping design for a future eighth entity.
- This automated evidence does not replace the deferred compact/responsive work or
  the later manual accessibility audit.
- Authorization remains allow-all and the inherited composition root still cannot
  advance an existing persistent volume to a new release.

## Review evidence

A fresh naive Codex xhigh review runs against the frozen candidate with the
Behavioral charter. Its exact SHA, verdict, and any disposition are reported in
the writer handoff so review metadata does not recursively change the reviewed
commit.
