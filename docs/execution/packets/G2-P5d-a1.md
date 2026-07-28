# G2-P5d-a1 — Reopen archived records

Status: evidence ready; frozen candidate reported in the writer handoff

Tier: Behavioral

Branch: `packet/g2-p5d-a1`

Base: `5a0a7a71810770026d346fbd38db7d7e23d3440b`

Frozen candidate: reported in the writer handoff because a commit cannot contain
its own SHA

## Outcome

Archived rows in a compiled List now carry their view intent into the derived
Record link. An archived row links to the existing Record surface with
`archived=yes`; an active row does not. SurfaceRuntime already translates that
URL value into the accepted `includeArchived` query argument, so the shared List
contract, canonical model, compiler, and compiled release remain unchanged.

The composed browser journey now executes the whole formerly dead path: create a
Party, update it, archive it, verify that an ordinary Record request excludes it,
find it in the archive-inclusive List, open its Record page, Restore it, and read
it back through a new ordinary Record request as active.

The diagnostic demo shell is unchanged. The `(archetype, slot)` dispatcher and
its intentional `UNSUPPORTED_COMPONENT` controls are unchanged.

## Established baseline

The branch was cut in an isolated worktree from exact SHA
`5a0a7a71810770026d346fbd38db7d7e23d3440b`. The observed baseline was:

| Gate | Baseline observation |
|---|---:|
| `format`, `build`, `lint`, `typecheck`, `check:demo-release`, `check:app-release` | green |
| `check:boundaries` | 122 files |
| `check:schema` | 12 applied / 12 verified |
| `test:unit` | 36 / 36 |
| `test:compiler` | 52 / 52 |
| `test:integration` | 59 / 59 |
| `test:agent` | 3 / 3 |
| `test:architecture` | 73 / 73 |
| `test:contracts` | 6 / 6 |
| `test:postgres` | 86 / 86, first attempt |
| `test:locale` | 1 / 1 |
| `test:browser` | 16 / 16 after installing the pinned Chromium binary |
| observability producer | 5 / 5 |
| `check:reachability` | 68 / 68 files from 9 producer artifacts |

The first baseline browser invocation was honestly red at 0 / 16 before any
test body because the fresh worktree did not have Playwright's pinned Chromium
binary installed. After `corepack pnpm exec playwright install chromium`, the
unchanged base passed 16 / 16. This was environment preparation, not a product
retry.

## Narrow implementation

`surfaceHref` accepts an archive-visibility flag and emits `archived=yes` only
when it is true. Both List render paths pass the row's observed lifecycle value:
the shared-list path used by the composed application and the pinned fallback
path used by older query envelopes.

SurfaceRuntime's existing `argumentsForSurface` remains the sole query
translation point. For a Record query it reads `archived=yes` and supplies
`{ includeArchived, recordId }`; an ordinary URL continues to supply
`includeArchived: false`. No page unconditionally includes archived records.

## Executed negative controls

Each mutation below was temporary and restored before the candidate was
committed.

| Vacuity vector | Executed control | Observed red |
|---|---|---|
| the journey could pass without the archived row carrying view intent | add the complete browser journey while leaving the pre-fix link builder unchanged | after clicking the archived row, `toHaveURL(/archived=yes/)` failed; the observed URL contained only `surface=northstar.app%3Asurface.party_detail&record=<uuid>` |
| the fix could weaken every Record request to include archived rows | temporarily force the Record `get` arguments to `includeArchived: true` | the ordinary `detailUrl` request failed its required `[data-diagnostic-code="QUERY_NOT_FOUND"]` observation: `element(s) not found` |
| clicking Restore could be mistaken for persisted restoration | temporarily suppress the Restore submission while retaining the independent read-back | the new ordinary Record request failed at `getByText(/Active · revision 4/)`: `element(s) not found` |

The restored journey also provides three positive observations: the archive List
labels the row `Archived`; its derived link opens a Record URL containing
`archived=yes` and renders `Archived · revision 3`; and after Restore a separate
ordinary request renders `Active · revision 4` plus the previously updated
contact value.

## Evidence and reproducible commands

The focused journey can be observed with the CI-invoked browser command:

```bash
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
corepack pnpm test
```

Final counts at the frozen candidate are recorded in the writer handoff.

## Test it yourself

With Docker running, start the composed application against an isolated
persistent database:

```bash
NORTH_STAR_DATABASE_CONTAINER=north-star-g2-p5da1-check NORTH_STAR_DATABASE_PORT=55434 PORT=4176 corepack pnpm --filter @north-star/api dev
```

Open <http://127.0.0.1:4176>. In **Party list**, create a Party, open it, choose
**More actions → Archive**, and confirm. Return to **Party list**, add
`&archived=yes` to the URL, and reload. The archived Party appears with an
**Archived** status. Open its record link; the Record page now loads and offers
**More actions → Restore**. Restore it, then remove `&archived=yes` from any URL
and reopen the record. It appears **Active**.

The remaining incomplete anatomy, allow-all authorization, Platform surfaces,
and release advancement are unchanged and remain owned by their existing queue
rows.

## Recorded limits and what the gates cannot prove

- Archive visibility is a deliberate URL-scoped view concern. Copying an
  archived Record URL without `archived=yes` still returns not found by design.
- This packet closes only archived List-to-Record reachability. It does not alter
  the remaining 107 conformance violations, responsive behavior, Platform, or
  authorization.
- Browser evidence covers the composed Party path through the generic renderer
  and gateway. Catalog and Location inherit the same renderer and remain covered
  by their existing archive/restore browser journeys, but this packet does not
  duplicate the new navigation journey for each module.

## Review evidence

A fresh naive Codex xhigh review runs against the frozen candidate with the
Behavioral charter. Its exact SHA, verdict, and any disposition are reported in
the writer handoff so review metadata does not recursively change the reviewed
commit.
