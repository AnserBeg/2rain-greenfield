# G2-P4 component salvage disposition

Status: no port admitted
Target: G2-P4 surface-grammar conformance
Mode: bounded PORT-candidate audit; all inspected implementation candidates rejected

## Source and audit boundary

The source is the prior repository `/home/rvham/2rain_erp`, branch `chess`, at
immutable commit `668a60bb3912a2df0b66f098b4c47ff8fe1396a6`. The working tree's
uncommitted files were not read as authority; every inspected component was read with
`git show <sha>:<path>`.

| Source path | SHA-256 of the exact source blob |
|---|---|
| `app/components/ui/button.tsx` | `e255b2d86dd0186ea9e21883235990ecf99ac40401db35b7fc4146c433a42b30` |
| `app/components/ui/badge.tsx` | `e3d596378d2db6fd77d5d5a8f060b0a1f4f125dfb09732c7c720e77e80efe4fa` |
| `app/components/ui/sidebar.tsx` | `43a31c81cdfa4db5d9d6fb21d575855021829e1f4a250401071af06ff1b93f2d` |
| `app/components/ui/breadcrumb.tsx` | `7304f2a5d79d1dff1580097016bdd1a99c6afdab85df029d3db966d706843c85` |
| `app/components/ui/tabs.tsx` | `b73b137c819c8f11bc38f09182a9ac275af88145d03eb84738d866e50d2ca2e9` |

These are the G2-relevant candidates for target size, status, navigation,
breadcrumb, and saved-view tab behavior. The remainder of the component directory was
inventoried by name but was not needed for this pure conformance packet.

## Verified evidence and gaps

- Exact source inspection found React 19, Radix, Tailwind, `class-variance-authority`,
  router-era aliases, client state, and in the sidebar a cookie-backed navigation state.
- The button's default and icon sizes are `h-10` (40px), its small size is `h-9`, and
  tabs use `h-10`; all are below the binding 44px compact-target floor. Only the large
  button happens to reach `h-11`.
- Badge variants are `default`, `secondary`, `destructive`, and `outline`, rather than
  the closed `success`, `attention`, `blocked`, and `inProgress` role vocabulary.
- The sidebar owns framework state, a mobile Sheet, a persistence cookie, and a
  keyboard shortcut. Those are not compiled `SurfaceDefinition` content and cannot
  cross the single SurfaceRuntime seam.
- `git grep` at the pinned commit found no directly named Node/Playwright test of these
  five primitives. The prior repository's full suite was not run: no implementation is
  admitted, and this packet does not claim its framework or app wiring works.

## KEEP / REWRITE / REJECT

| Disposition | Candidate | Reason |
|---|---|---|
| KEEP | none | No prior implementation is framework-neutral and conformant enough to enter unchanged. |
| REWRITE | none from source | G2-P4 implements the ratified plan grammar directly as a new checker and compiler-produced fixture; it does not use prior code or tests as a behavioral specification. |
| REJECT | `button.tsx` | Framework-coupled; default, small, and icon targets violate 44px. |
| REJECT | `badge.tsx` | Ad-hoc visual variants can bypass the closed status-role grammar. |
| REJECT | `sidebar.tsx` | Client/cookie/framework authority conflicts with compiled navigation and the single runtime seam. |
| REJECT | `breadcrumb.tsx` | React/Radix implementation is not needed to prove the compiled record slot. |
| REJECT | `tabs.tsx` | Framework-coupled and the 40px trigger height violates the compact floor. |

No source bytes, dependency, route wiring, CSS, tests, or runtime behavior crossed from
the prior repository.

## Invariants preserved by the no-port decision

1. `RequestRuntimeView.projections.surface` remains the only application-definition
   input to browser rendering.
2. The five archetypes and their slots come from the ratified canonical vocabulary;
   no sixth archetype or component escape hatch is introduced.
3. Status presentation accepts only the four role tokens.
4. Compact interactive targets are at least 44px in both dimensions.
5. Navigation is compiled, bounded, and contains no prior-repository cookie authority.

## Defects that must not carry

- 36px/40px compact targets;
- arbitrary badge/color variants;
- route- or module-owned screen composition;
- sidebar-owned persistence and mobile layout authority; and
- React/Radix/Tailwind as an implicit runtime dependency.

## Greenfield gates and rollback

The admitted result must pass compiler vocabulary reds, required-slot/focus/navigation
checks, actual SurfaceRuntime Chromium journeys, computed contrast and target
measurements, the bespoke-screen scan, dependency boundaries, typecheck, and the full
matrix. Because no port lands, rollback has no prior component to unwind: before
integration, removing the G2-P4 checker, fixture, tests, and these two packet records
returns to the exact prior product runtime with no migration or stored state.
