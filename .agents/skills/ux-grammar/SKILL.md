---
name: ux-grammar
description: Binding UI/UX grammar for the ERP. Read BEFORE writing or
  reviewing any surface, screen, component, navigation, or builder code, and
  before designing any compiled SurfaceDefinition output. Covers the five
  screen archetypes, the shell contract, status grammar, responsive/mobile
  transformations, and what customization may never change.
---

# ux-grammar

Adopted in the greenfield repository alongside the compiled SurfaceRuntime.
The executable G1 pin below binds this guidance to plan sections 8.5-8.6 and
the accepted canonical/runtime vocabulary. Changing the plan, skill, or code
requires changing all three deliberately; accidental drift fails CI.

## The one rule

Users customize content, never grammar. The platform owns a closed set of
screen archetypes; every module — first-party, generated, or tenant-authored —
is content rendered inside them. If you are about to build a screen that is
not one of the five archetypes, stop: you are either wrong about the screen,
or you are proposing a platform change that needs an ADR.

## G1 executable contract pin

This block is machine-read by the skill-guidance and SurfaceRuntime-seam
architecture tests. It records the exact G1 vocabulary, not the later G2
promise to render every archetype completely.

<!-- ux-grammar-contract:start -->
```json
{
  "archetypes": ["home", "list", "record", "task", "builder"],
  "componentPolicy": "closed-own-entry-only",
  "components": [
    "northstar.shell:component.error_probe",
    "northstar.shell:component.release_summary",
    "northstar.shell:component.setup_checklist"
  ],
  "definitionSource": "RequestRuntimeView.projections.surface",
  "planSections": ["8.5", "8.6"],
  "runtimeEntrypoint": "apps/web/src/surface-runtime.ts#renderSurfaceRuntime",
  "schemaVersion": "northstar.ux-grammar-pin/v1",
  "slots": {
    "home": ["exceptions", "setupChecklist"],
    "list": ["title", "savedViews", "dataGrid", "bulkActions"],
    "record": [
      "breadcrumb",
      "titleStatus",
      "commandBar",
      "keyFacts",
      "sections",
      "childTables",
      "activity"
    ],
    "task": ["decision", "scanInput", "primaryAction"],
    "builder": [
      "modeSwitch",
      "selection",
      "properties",
      "draftBanner",
      "publishDiff"
    ]
  },
  "statusRoles": ["success", "attention", "blocked", "inProgress"]
}
```
<!-- ux-grammar-contract:end -->

SurfaceRuntime dispatches grammar-owned content by the pair `(archetype, slot)`;
the closed component registry separately dispatches shell-owned opaque content by
its `contentReferenceId`. Module-local content references therefore remain legal
package data while the platform-owned slot vocabulary controls ordinary List and
Record rendering.

## The five archetypes

| Archetype | Fixed anatomy (slots) |
|---|---|
| Home | role-shaped exception cards; setup checklist until data exists; never an empty dashboard |
| List | title; saved-view tabs (chips); spreadsheet-grade grid — sort, filter, all-visible-value search, paging; bulk bar |
| Record | breadcrumb; title + status chip; command bar; key facts; sections and child tables; activity rail |
| Task | one decision per screen; scan-first input; large targets; sticky bottom primary action |
| Builder | operate/customize mode switch; edit-in-place selection; right properties drawer; draft banner; publish diff |

Rules that follow:

1. Every screen renders through SurfaceRuntime from a compiled
   `SurfaceDefinition` that names its archetype and fills only that
   archetype's declared slots. No bespoke route or React screen for ordinary
   reads/writes — ever.
2. Records are full pages (deep-linkable units of work). Drawers are for
   quick create and peek only. Masters allow inline grid editing; posted
   documents never do.
3. The command bar orders the primary action first; destructive actions live
   behind the overflow. Never a lone icon for a destructive act.
4. The activity rail renders trust-substrate change documents. Do not invent
   a parallel "history" widget.
5. Saved views are page tabs, never navigation entries.

## Shell contract

- Three parts: left navigation, main canvas, one contextual right rail.
- The right rail has exactly one tenant at a time: assistant dock (operate)
  or properties drawer (customize). Never both, never a second sidebar.
- Navigation is role-shaped, task-named ("Receiving", not "Procurement
  Module"), budgeted to **seven top-level entries on desktop, five in
  compact**. Beyond that: group, then search.

  **The budget counts top-level entries after grouping, not leaves.** Its
  authority is [ADR-0030](../../../docs/decisions/ADR-0030-compiler-derived-navigation-grouping.md):
  these are *physical* constraints — the compact limit is paired with a fixed
  bottom bar at 390 px and a no-horizontal-scroll requirement — not a cognitive
  rule of thumb and not a debt ratchet. Presentation-only truncation is
  inadmissible: hiding links with CSS leaves the compiled projection over budget
  and can make a surface unreachable.

  *Corrected 2026-07-31.* This number previously appeared in three places with
  **no citation at all** — here, in the decision log below, and in plan §8.5. A
  prior note claimed it cited Miller and should cite Hick; neither is right.
  Nothing cited Miller, and the governing constraint is spatial rather than
  cognitive. `G3-P6a` is the first real test: mounting Inventory took the
  composed application to **eleven leaves under four top-level groups** — within
  budget precisely because ADR-0030's grouping is doing the work.
- One global command palette (navigate + create + ask). One New button.
- Draft vs published state is always visible (banner in customize mode).

## Status grammar

One global color grammar: `success` (green), `attention` (amber), `blocked`
(red), and `inProgress` (**indigo**). Modules may add states, but every rendered
state must resolve to one of these closed semantic roles; they may never
recolor meanings. Status colors resolve only from role tokens — a hex literal
in surface code is a defect.

**Brand and status hues must remain separable.** The brand hue is reserved. No
status role may resolve to a token within it. Status is the most
information-dense colour on screen and must never compete with identity.

That rule is why `inProgress` reads *indigo* rather than *blue*: the brand is now
baby blue ([ADR-0035](../../../docs/decisions/ADR-0035-token-layer-and-motion-contract.md)),
so a blue `inProgress` would put the strongest signal on screen in direct
competition with the identity colour. **The pinned contract is unaffected** — it
records role *names* only, which are unchanged, and plan §8.5 names roles without
binding hues. Indigo is a blue, so this narrows the prose rather than
contradicting it.

**Every status renders colour + dot + word on a tinted ground. Never colour
alone.** Three independent reasons, any one sufficient: colour-vision deficiency
and low vision, the WCAG 2.2 AA floor plan §8.4 already claims, and legibility at
arm's length on a warehouse tablet.

## Weight matches consequence

- Drafts autosave and edit inline; feel light.
- Postings, corrections, and any externally meaningful effect always show
  predicted effects and require a deliberate confirm; feel heavy.
- Irreversible acts are corrected, never deleted; the UI never offers a
  hard delete.

## Responsive and mobile

One responsive web app serves every device. Mobile rendering is a
deterministic platform transformation per archetype — never a per-screen or
per-tenant design:

- shell → bottom tab bar (max five, scan/task centered); right rail →
  bottom sheet; command bar → sticky bottom action bar, primary action
  thumb-reachable;
- list → priority-ranked cards derived from declared column priority;
- record → stacked key facts, accordion sections, activity as a tab;
- task → already compact-first; desktop shows the same flow centered;
- builder → desktop editing only; compact gets preview, diff, approve,
  rollback.

Touch targets ≥ 44px. Camera and keyboard-wedge scanning. Offline is safe
failure + idempotent retry only — never a silent local queue.

## The assistant's four beats

Plan card (what, to which records, predicted effects) → confirmation when
consequential → receipt with links → verified state. Unsupported requests
render a capability-gap card with a handoff to the customization lane. The
agent never has UI powers a human lacks, and every agent effect is visible
in the same UI the human uses.

## Customization boundaries

Tenants change content inside declared slots: fields, sections, columns,
views, metric cards, labels, navigation grouping, enum options, guards,
theme tokens. Tenants never change: the shell, archetype skeletons, focus
order, status-color meanings, confirmation patterns, required-content
visibility, or anything via raw CSS/HTML/pixel placement. Generated defaults
must make every new field/entity usable with zero design work.

## Never build

- a sixth archetype or a bespoke screen outside SurfaceRuntime;
- module-specific UI dialects, routes, or navigation mega-menus;
- modal-in-modal; a separate builder application;
- recolored or hex-literal status colors;
- pixel/absolute layouts or tenant-authored CSS;
- a screen the operations agent cannot explain from compiled metadata;
- a mobile-only or desktop-only fork of a surface definition.

## Enforcement (where violations get caught)

1. Compiler: unknown archetype/slot/status vocabulary fails compilation;
   required-content, contrast, target-size, focus-order checks at every
   breakpoint; tokens-only theming.
2. Surface-grammar conformance suite: SurfaceRuntime-only rendering scan,
   role-token status check, navigation budget, compact-projection journeys
   in a mobile-viewport shadow browser. Gates every stage from G2.
3. This skill's pinning test: if plan sections 8.5-8.6, this skill, and the
   code disagree, CI fails.

## Decision log (do not relitigate without ADR + usability evidence)

- Three-part shell; operate/customize switch inside one app (edit-in-place).
- Full-page records; drawers for quick create/peek only.
- Saved views as page tabs; ~7-entry navigation budget.
- Inline grid editing for masters only.
- Vertical sentence workflow builder; no freeform canvas.
- Server-authoritative draft patches; no CRDTs.
- Responsive PWA at launch; native app is evidence-gated and later.
- Assistant docked right on desktop, full-screen sheet on mobile.

If a task genuinely cannot fit this grammar, do not work around it —
propose the ADR that amends plan section 8.5 and this skill together.
