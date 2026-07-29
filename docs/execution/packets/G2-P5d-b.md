# G2-P5d-b — Surface-anatomy burn-down

Status: evidence ready; frozen candidate and review verdict reported in the
writer handoff

Tier: Behavioral

Branch: `packet/g2-p5d-b`

Base: `f82c629424311c2dd44a64fdc2c3d6f551885649`

Frozen candidate: reported in the writer handoff because a commit cannot contain
its own SHA

## Outcome

The real Party, Catalog, and Location definitions now declare the anatomy this
packet can honestly support: List surfaces add `bulkActions`; Record detail
surfaces add `sections`; and Record forms add `keyFacts`. Party's shared factory
applies the same declarations to Party role, so the composed product inherits all
four entity slices from the same definitions as the standalone packages.

The standalone-product conformance count moves from **106 to 82**:

| Product module | Before | After | Change |
|---|---:|---:|---:|
| Catalog | 19 | 13 | -6 |
| Location | 19 | 13 | -6 |
| Party, including Party role | 35 | 23 | -12 |
| Platform | 33 | 33 | 0 |
| **Total** | **106** | **82** | **-24** |

Platform deliberately does not move. Its classification and saved-view work
remain owned by row 1c-b; changing it here would pre-empt that ruling.

## One rendering path

The existing data renderer remains the single source for both desktop and compact
content. List data has exactly one table and one set of rows. At the compact
breakpoint those same rows become priority-ranked cards; there is no second hidden
table, second subscription, or separate mobile surface. The declared column order
is emitted as deterministic `data-column-priority` metadata and the browser
observes the same row as `table-row` on desktop and `grid` on compact.

The rest of the current-product D5 transformation follows the same one-DOM rule:

- navigation becomes a bottom tab bar with at most the already-budgeted five
  entries while the same navigation keeps all entries on desktop;
- the Record command bar becomes sticky above it;
- key facts stack;
- one Record section group becomes a keyboard-operable compact accordion; and
- a section collapsed on compact keeps its summary control when the viewport
  widens, so responsive state cannot strand its contents; and
- every selector and compact navigation target remains at least 44 pixels.

Task and Builder are still exercised by the existing grammar fixture. This packet
does not invent product Task or Builder surfaces.

## Record diagnostics belong to the surface

A diagnostic returned while resolving a Record is now rendered once at the
surface boundary. Record slots are not dispatched because none can render useful
record content. Failures thrown by an individual slot renderer are still caught
by `renderRegisteredSurfaceComponent` and stay inside that slot. No arbitrary slot
is designated as the page-error owner, so removing or reordering slots cannot
remove the diagnostic.

This distinction closed the orchestrator probe's concrete defect: adding
`sections` used to render two identical `QUERY_NOT_FOUND` panels, one from
`keyFacts` and one from `sections`.

## Anatomy that now has behavior

- **Key facts** are not another full field dump. Existing records show compiled
  display identity, short record identity, lifecycle state, and revision. New
  forms show create mode, declared field count, and Draft status. Complete field
  values remain in `sections`.
- **Sections** reuse the existing form renderer. Record detail uses the same
  declared field metadata in one semantic section group, which becomes an
  accordion on compact viewports.
- **Bulk actions** provide selection and a real Clear-selection action through
  the List slot. The bar says plainly that business mutations remain
  record-scoped; this packet does not fabricate a batch Semantic Operation that
  the compiled release has not declared.

All rendering stays generic. No Party, Catalog, or Location ID or field name was
added to the web binding path.

## Authored-release generator and artifact movement

`apps/web/scripts/generate-app-authored.ts` is the missing owned generator. It
serializes `composedApplicationDefinition()` directly and formats the result; the
authored artifact is no longer hand-copied from the builder. Running it twice
produced the same SHA-256:

```text
0e5103391c451bb95dbf52355a31ab41307e546f8b89280c3bb49b01957b2519
```

The release compiler then appended the new application revision. The diagnostic
shell was neither repointed nor regenerated.

| Artifact | Before SHA-256 | After SHA-256 |
|---|---|---|
| `app.authored.json` | `9fb2452c7a0e04595d72209304152c44a1745e195895dc3b0acb7c5e1cef1270` | `0e5103391c451bb95dbf52355a31ab41307e546f8b89280c3bb49b01957b2519` |
| `app.compiled.json` | `943fa59f9cf2286c621cd7a1d3488f64637dbd6d0e24d85500a2f4bc4855c6cd` | `78e24a5cae0a2e6a73fc41e239d585727f2038459f3cc3e4fb66a4c00ab60c1a` |

The latest application release root moves from
`ba87d2155d9d8fcc2d7c12a058ccc44094857310f6bb2cf4c095955711e7aa05`
to
`bf932f8a4a69edc23c7a62c4191e1e9cf92c9482d38fc8bcef90945461615783`.
Earlier lineage remains in the compiled artifact.

## Executed negative controls

Every source mutation below was temporary and restored before the candidate was
committed.

| Vacuity vector | Executed control | Observed red |
|---|---|---|
| a Record diagnostic could still be repeated by every data-bound slot | disable the surface-level Record guard and run the composed journey | expected one `QUERY_NOT_FOUND`; received two, with the locator resolving to two elements 13 times |
| “single responsive rendering” could still hide a duplicate table | render the same List body twice and run the journey | the unique `Alpine Office Supply` cell resolved to two elements and Playwright failed strict mode |
| the conformance decrease could be a hand-edited baseline | compile the real modules against the old baseline | `catalog=13/19, location=13/19, party=23/35, platform=33/33`; the ratchet failed with three unrecorded decreases |
| the new List slot could be decorative or omitted from a shared factory | remove `bulkActions` from the Party factory and run the real-product ratchet | Party changed from `23/23` to `27/23`; `SGR003_VIOLATION_INCREASE` failed the gate |
| key facts could remain an undifferentiated field dump | replace the compiled revision fact with an unrelated label and run the composed journey | expected `Revision`; observed `Record … State Active Version 1`, and Playwright failed at the `record:keyFacts` slot |
| capping compact grid columns could still leave more than five navigation targets mounted | remove the compact overflow rule from a synthetic six-List application | expected five visible compact links; received six, with the locator resolving to six elements 13 times; desktop still required all six |
| a compact-collapsed Record section could become unreachable after widening | restore the former desktop-hidden summary and run the close-then-widen journey | expected the existing `Party fields` summary to remain visible; it stayed hidden 14 times while the closed details also hid its fields |

The restored positive browser journey additionally selects a real row, observes
the bulk bar change state, clears selection, and observes the checkbox become
unchecked. It sees one List rendering at both breakpoints, activates the Record
accordion by keyboard, and observes the sticky command bar and bottom navigation.

## Evidence and reproducible commands

Authored and compiled release generation:

```bash
node --import tsx apps/web/scripts/generate-app-authored.ts
corepack pnpm --filter @north-star/web build:app-release
corepack pnpm check:app-release
corepack pnpm check:demo-release
```

Focused development evidence:

```bash
corepack pnpm typecheck
corepack pnpm test:architecture
corepack pnpm test:browser
```

The architecture suite observed:

```text
product surface grammar ratchet: PASS (4 compiled product modules read; catalog=13/13, location=13/13, party=23/23, platform=33/33)
98 tests, 98 passed, 0 failed
```

The exact full-matrix counts at the frozen candidate are reported in the writer
handoff.

## Test it yourself

With Docker running, generate the application release and start an isolated
persistent composed application:

```bash
node --import tsx apps/web/scripts/generate-app-authored.ts
corepack pnpm --filter @north-star/web build:app-release
NORTH_STAR_DATABASE_CONTAINER=north-star-g2-p5db-check NORTH_STAR_DATABASE_PORT=55436 PORT=4178 corepack pnpm --filter @north-star/api dev
```

Open <http://127.0.0.1:4178>. On **Party**, select a row and clear it through the
Bulk actions bar. Open the row: Key facts show identity, state, and revision;
Details carries the complete field list. Resize the browser below 800 pixels.
The same rows become cards, navigation moves to the bottom, the command bar is
sticky, and the Details summary opens and closes. Create or edit a record and
reload to confirm the PostgreSQL-backed behavior remains intact.

What remains incomplete: the final 82 conformance violations, Platform anatomy,
saved views, child tables, the activity rail, and allow-all authorization.

## Recorded limits and what the gates cannot prove

- **82 violations remain.** Catalog and Location each retain 13, Party retains
  23, and Platform retains 33. `savedViews` waits on row 1c-b; `childTables`
  waits on Q1's parent-filter argument; the activity rail waits on a trust read
  model. The count is not rounded down and the checker was not weakened.
- Bulk selection is real UI state, but no generic compiled batch mutation exists
  yet. The slot therefore offers Clear selection rather than inventing a second
  write ingress or replaying record operations as an undeclared batch.
- The composed application consumes the same module definitions and is exercised
  end to end, but the product conformance ratchet still discovers standalone
  module `definition.ts` files. Its parser does not admit a multi-module package;
  changing that remains out of scope.
- The single-DOM checks prevent duplicate mounted tables in the current product.
  They do not measure sustained event-update CPU because no live subscription
  transport exists yet.
- Automated contrast and 44-pixel checks remain the G2 evidence. They do not
  replace the later manual G7 WCAG audit.
- Authorization remains allow-all, and the inherited composition root's release
  advancement limitation remains unchanged.

## Review evidence

The first fresh naive Codex xhigh review of `bb8b343` returned `REVISE` with two
bounded responsive-state findings: a sixth compact navigation entry remained
visible, and a compact-collapsed Record section lost its only control on desktop.
Both former behaviors were then executed as the two reds above. The fixes keep
one navigation DOM with deterministic compact overflow, preserve every desktop
entry, and keep the same native section control operable across breakpoints.

The replacement frozen SHA receives a fresh naive Codex xhigh review with the
same bounded charter. Its exact verdict and non-empty artifact path are reported
in the writer handoff.
