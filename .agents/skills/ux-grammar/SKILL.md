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

**Task presentation, amended 2026-09-15 (ADR-0036 §2.5).** A compiled Record
composition may select `{ mode: nativeDialog, fallback: page }` for its existing
Task/action flow. This preserves the originating document during input, review,
explicit confirmation and result; it adds no archetype or slot. One SSR Task
container is promoted with native `showModal()` by the single CSP-hash-pinned
owned script. With JS disabled or unavailable it stays a usable full-page Task.
Close/Escape dispatch nothing; reopening retains the same preparation/outcome.
After submission, closing never implies rollback. Fresh governed Record data is
served with every Task response; denied reads must never reveal cached context.
Visible close, sensible initial focus, native focus containment, focus return
to the Record's continuation control, and scrollable compact controls are required.
`modal` MESSAGE placement remains refused under ADR-0048.

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
- **The workspace context bar** sits above the canvas and answers one question:
  *which slice of the business am I looking at?* Legal entity today; further
  dimensions need their own justification.
  ([ADR-0037](../../../docs/decisions/ADR-0037-workspace-context-bar.md).)

  It is **shell furniture, not a fourth part** — same class as the command
  palette and the New button. It is platform-owned, never an archetype slot and
  never tenant-customizable. **Amended by the owner 2026-09-15:** declared browser
  entry resolves current authorized active companies. One enters automatically;
  several reuse a currently authorized advisory preference scoped to the trusted
  principal/tenant/environment, or ask once; none show access/setup guidance.
  Entry writes explicit scope into the URL. Preference never grants permission or
  supplies an operation operand. Invalid explicit scope refuses, and open documents,
  draft buffers and prepared tasks retain their original scope across tabs/switches.
  Raw APIs/background callers retain explicit pinned context. Without a declaration,
  no implicit default is available. See amended ADR-0037 and ADR-0015.

  **A workspace scope is not a field pre-fill.** The bar selects the slice of the
  business being looked at; a form pre-filling a legal-entity field from a
  declared source is a different act on a different object. Neither is authorized
  to invent the missing declared-default mechanism (see `U7` in
  [ui-ux-remaining.md](../../../docs/execution/ui-ux-remaining.md) §3b).

  Never a place for actions, a second command surface, a notification host, or a
  breadcrumb. Each has a home already, and each is how a context bar becomes a
  toolbar.
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

## Slot resolution states

Granted 2026-08-02 on a bridge request from `5g3-u4`, which stopped rather than
inventing vocabulary. Sourced from `ux-strategy-proposal.md` M2.

Every slot resolves into **exactly one** of a closed, mutually exclusive set:

`pending` · `ready` · `empty` · `failed`

- **`failed`** renders an inline `role="alert"` card **inside the slot**, while
  sibling slots continue rendering their real content. A data failure is no
  longer the whole page's fate.
- **`empty`** is a distinct non-error treatment. **`empty` is never `failed`.**
  This is [ADR-0044](../../../docs/decisions/ADR-0044-search-capability-is-derived-and-never-silently-empty.md)
  at the UI layer: "nothing matched" and "this broke" are different facts, and a
  screen that renders them identically reproduces the silently-wrong-answer
  defect that ADR forbids.
- **`pending` does not authorize a default loading treatment.**
  [ADR-0032](../../../docs/decisions/ADR-0032-feedback-ladder-and-loading-states.md)
  still governs: feedback appears only where a *measured* operation exceeds the
  threshold. A page answering inside 400 ms shows nothing. The state exists so a
  slot can be described, not so every slot can spin.

**`pending` is structural, and the spelling is now fenced — 2026-08-08.** In code
it is `data.status === 'UNBOUND'` (`apps/web/src/component-registry.ts:298`):
*this slot has no binding.* It is **not** "this slot's data is in flight", and it
is **not** the ladder's pressed-control pending (ADR-0032 §1's 400 ms – 1 s row)
or ADR-0036 §2's "pending-state toggling" — neither of those is a slot state at
all. Three facts, one spelling, and only one of them belongs to this partition.

So **a temporal loading state may not reuse `pending`.** A slot whose bound data
is in flight transitions when work completes, participates in the ladder's
elapsed-time escalation, and authorizes a treatment — three things `pending` is
defined not to do. It is therefore a *new* member of this closed set and needs
its own name and its own ruling, which `skeleton-route` owes
([ui-ux-remaining.md](../../../docs/execution/ui-ux-remaining.md) §2.5).

**The unit that resolves is the surface's data binding, not the slot — corrected
2026-08-08.** Every slot *carries* a resolution state; they do not resolve
independently. One `SurfaceDataRenderState` is computed per request
(`apps/web/src/surface-runtime.ts:193-214`) and handed to every slot
(`:339-349`), and `slotResolutionState()` (`component-registry.ts:293-307`)
returns `ready` for any slot that does not own data resolution and otherwise
grades that one shared value. Every real Record surface declares `keyFacts` and
`sections` together (`packages/domain/src/party/definition.ts:446`, and the same
line in `location` and `catalog`), both are `ownsDataResolution: true`
(`apps/web/src/component-registry.ts:159-170`), and both therefore always share a
fate. **That is already visible in the gates rather than inferred:**
`apps/web/test/browser/composed-application.spec.ts:1461-1465` asserts **two**
`record:` slots failed with one diagnostic code while breadcrumb, titleStatus and
commandBar are `ready`.

The isolation this bought is real and it is what the doctrine claims against the
old all-or-nothing page. But **"the slot is the unit of fault isolation" is a
claim about where a failure is *rendered*, not about what independently
*resolves*.** The two coincide only because a surface has exactly one data
binding today. **A surface gaining a second binding is the trigger for this
section to rule which unit resolves**, and until then "a failed slot renders an
inline card while siblings render normally" must be read as *siblings that do not
own data resolution* — the others fail with it.

**Resolution state is not status.** The status grammar above describes business
facts; these describe whether a slot has data. They may not be conflated — a
`failed` slot is not `blocked`. Where a resolution state renders colour it
resolves through the existing status roles (`failed` through `blocked`), because
the one-colour-grammar rule is unchanged and these add no new hues.

**Page-level diagnostics survive, and must.** Faults arising *before* slot
composition stay whole-page: invalid surface projection, no active surface,
unknown surface, and release-level faults. Making every failure slot-local would
replace an over-broad failure with an under-broad one and lose the signal that the
page itself is unserviceable.

**No client capability is implied.** These are server-rendered states.
[ADR-0036](../../../docs/decisions/ADR-0036-minimum-client-capability.md)
authorizes exactly one script with five closed behaviours, and none of them is
this.

## Disclosure tiers

Granted 2026-08-06 for `U5b`, ruled from `ux-strategy-proposal.md` §3.2 after
`U5-design` reported the hard rule unimplementable as written.

Every field and section declares one of a closed set:

`always` · `progressive` · `onDemand`

- **`always`** — rendered on arrival. Key facts, status, required inputs, anything
  blocking.
- **`progressive`** — present and announced but collapsed. One interaction away,
  and **counted in the summary so its existence is never concealed**.
- **`onDemand`** — fetched on expand. Genuinely large or expensive content only.

The tier distinguishes **deferred** from **hidden**. Nothing a user should have is
ever hidden; `progressive` and `onDemand` defer, and both remain discoverable.

**`onDemand` is refused by name until a fetch-on-expand mechanism exists —
2026-08-08.** It is spelled here because the vocabulary is closed and an unspelled
tier cannot be refused *by name*; it is not a working tier. Nothing honours it:
native `<details>` expansion reveals content already in the document and cannot
fetch, ADR-0036 §2's five behaviours contain no fetch-on-expand, and §7 forbids
client rendering of business data. Admitting it as workable would be precisely the
accepted-and-ignored state this skill refuses `toast` and `modal` for
(ADR-0041 §3, a refusal to ship a spelling ahead of its meaning). `U5b` — in
flight when this was written — implements the refusal at normalization, before
deferrability is consulted, with this same reason in its diagnostic.

**The hard rule below applies to every tier that is not `always`** — not to
`progressive` alone. A required, action-demanding, `blocked` or `attention` field
is deferred *further* by `onDemand` than by `progressive`, so a refusal naming
only `progressive` would leave the stronger deferral admissible. This is moot
while `onDemand` refuses unconditionally, and it is stated so that admitting
`onDemand` later cannot silently reopen the hole.

**The hard rule splits across two enforcers, because one of its three clauses is
not compile-time knowable.** §3.2 states that anything required, anything
resolving to `blocked` or `attention`, and anything the user must act on is
`always`. The middle clause asks the compiler to predict a runtime value, which it
cannot: whether a field resolves to `blocked` depends on data.

So:

- **The compiler enforces what is declarable** — required fields, and fields
  declared as demanding action. Declaring one `progressive` fails compilation.
- **The runtime refuses what is not** — a field that resolves to `blocked` or
  `attention` while declared `progressive` is refused by name at render, not
  silently promoted and not silently collapsed.

**"Refused by name" does not mean "withheld" — stated 2026-08-08.** The hard rule
exists so that a person *sees* blocking content. A runtime refusal that rendered a
diagnostic in place of the field would enforce the rule by committing the harm the
rule prevents. The refusal **reveals the content and names the defect** — the
non-silent promotion the wording above already admits, made explicit so the
implementing packet does not have to guess which way to read it.

That split is [ADR-0041](../../../docs/decisions/ADR-0041-declared-shapes-must-be-honoured-or-refused.md)'s
rule applied one layer down: a declared shape is honoured or refused, never
quietly coerced. **Which fields are declarable is `U5b`'s to determine** — this
grants the vocabulary and the shape of the answer, not the field inventory.

**The carrier is not yet granted.** §3.2 wants the tier per field *and* per
section; the canonical model has neither today. `U5b` determines the carrier and
**stops for a bridge request before adding it to the G1 pin block** — the pin binds
compiler-enforced vocabulary, and this is compiler-enforced, so it will likely need
to move. The orchestrator lands the pin once the carrier is known.

## Message vocabulary

Granted 2026-08-06 on `U6-design`'s report, which stopped rather than inventing
these. Ruled by [ADR-0048](../../../docs/decisions/ADR-0048-the-message-catalog-is-platform-vocabulary-held-in-code.md).

Every user-facing error, empty state and success confirmation resolves to a
**registered** entry. The catalog is platform vocabulary held in code and pinned
by contract test — not a compiled projection — because every code is
platform-raised and no module authors a message. `SurfaceMessageCode` derives from
the catalog by `keyof typeof`, so an unregistered code is **inexpressible**, not
merely a compile error.

**`consequence`** — `advisory` · `blocking`. Does the user's work stop?

**There is deliberately no `severity`.** The proposal's severity column stacked two
orthogonal facts — a *scope* (field-level, slot-level) and a *consequence*
(transient, blocking) — under one header naming neither. Registering it verbatim
would have coined a word colliding with the status roles while not naming a single
fact.

**Message consequence is not status**, in exactly the way resolution state is not
status. The status grammar describes a business fact about a record; consequence
describes what a message does to the user's work. Where a message renders colour
it resolves through the existing roles — `blocking` through `blocked`, `advisory`
through `attention`, a success confirmation through `success` — so **no new hue is
added and the pinned `statusRoles` array does not move.**

**`placement`** — `page` · `slot`, and it is **derived, never authored**. A catalog
entry declares which placements are *admissible*; the runtime picks by where the
fault arose relative to slot composition, which the page-level-diagnostics rule
above already discriminates. Slot placement anchors on the per-slot resolution
state, which already computes and emits that fact rather than deriving a parallel
one.

**`page | slot` is closed over messages placed relative to slot composition, and
field-level validation is a known open case — recorded 2026-08-08.** ADR-0048 §3
decomposed the proposal's severity column into a *scope* and a *consequence*,
kept the consequence, and dropped the scope rather than moving it here. But
field-level was already on the queue when the vocabulary closed:
`ux-strategy-proposal.md` §3.8 requires validation adjacent to the input,
ADR-0036 §2.4 authorises server-requested advisory inline validation, and `U7` is
chartered to build it. A slot card is not a message anchored to one input — they
differ on focus movement and error association, which the WCAG 2.2 AA claim in
plan §8.4 makes an obligation rather than a preference.

**No `field` placement is coined here**, because coining one before `U7` knows
what it anchors to is the same defect as coining `onDemand` did. **`U7` owns the
decision and must stop with a bridge request** rather than routing a validation
message through `slot` or around the catalog. Three admissible answers: placement
gains a field or control anchor; placement and anchor become separate axes; or
validation messages are ruled a grammar of their own, with the reason recorded.

**`toast` and `modal` are refused by name, with a diagnostic.** Neither is among
the five client behaviours [ADR-0036](../../../docs/decisions/ADR-0036-minimum-client-capability.md)
authorises; a toast additionally needs a durable record substrate that does not
exist, and a modal needs a rectifying-action capability that does not exist.
Registering a spelling nothing can honour is ADR-0041's accepted-and-ignored
state — *indistinguishable from success at every point where anyone would look*.
Refusing by name makes the absence declared and observable instead.

**These are runtime vocabularies and do not widen the G1 pin block**, which binds
what the compiler enforces. They follow the slot-resolution-state precedent:
skill prose, a frozen constant, and a deep-equal contract test.

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
