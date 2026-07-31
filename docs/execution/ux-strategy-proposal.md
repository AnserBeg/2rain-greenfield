# UX strategy — evidence, behaviour, visual system, and implementation

**STATUS: PROPOSED — not accepted, not binding.** Nothing here amends the plan,
the `ux-grammar` skill, or any ADR until a packet does so. Created 2026-07-30
from a review of [Laws of UX](https://lawsofux.com/), the response-time
literature it cites, a user requirements pass, and a visual-direction review.

Owning queue rows: **U0–U8** in [current-plan.md](current-plan.md).
Visual direction, live: **[UI direction mockup](https://claude.ai/code/artifact/db130305-e9b1-4dba-b195-bb0f24d8dd5f)**.

---

## 0. The three headlines

**One — the plan got the geometry right and left the tempo out.** Of the thirty
laws surveyed, roughly two thirds are already encoded in plan §8.5–8.6 and the
`ux-grammar` skill: the archetype grammar, the navigation budget, 44 px targets,
the closed component registry, weight-matches-consequence. They were adopted on
architectural instinct and happen to be well supported. That half needs
**citation, not construction** (Part IV). The missing third is about **time,
feedback, and emotional weighting** — Doherty, Flow, Goal-Gradient, Zeigarnik,
Peak-End, Aesthetic-Usability. The plan contains none of it.

**Two — the hardest requirement is the one this architecture already answers.**
"Skeletons must reflect where the data will land, on every page, including
customised ones" is normally intractable, because a hand-drawn skeleton drifts
from the layout the moment anyone edits either one. Here it is not hand-drawn.
Every screen is already a compiled `SurfaceDefinition` declaring its archetype,
slots, column priority and field semantics. **The skeleton is a compiler output
derived from the same source as the layout**, so it cannot drift, and a tenant
who adds a column gets a correct skeleton for free.

**Three — the current UI is prettier than most ERPs and less usable than it
should be, and those two facts have the same cause.** It is designed like a
marketing page: 77 px Georgia display type, up to 72 px of page padding, an
ambient gradient, a large soft shadow on every panel. Real taste, wrong genre.
Part II is the correction.

---

# Part I — Behaviour

## 1. The feedback ladder

### Evidence

| Source | Finding |
|---|---|
| Doherty & Thadani, *IBM Systems Journal*, 1982 | Productivity rises sharply below **400 ms**; replaced the prior 2-second standard |
| Nielsen, *Usability Engineering*, 1993 (citing Miller 1968, Card et al. 1991) | **0.1 s** instantaneous · **1.0 s** limit of uninterrupted thought · **10 s** limit of attention |
| NN/g, *Skeleton Screens 101* | Under 1 s show **nothing**. 2–10 s: spinner for one module, skeleton for a full page. Over 10 s: determinate progress plus cancel |
| Viget 2017 vs. Wroblewski 2013 and later replications | Skeleton-vs-spinner perceived-duration evidence is **genuinely mixed**; skeletons win consistently only on *emotional* response |

### Ratified ladder

| Band | Treatment | Authority |
|---|---|---|
| < 100 ms | Nothing. Render. | Nielsen instantaneous |
| 100–400 ms | Nothing. Render. **Target band for every registered query.** | Doherty |
| 400 ms – 1 s | Inline pending state on the pressed control only. No skeleton. | Nielsen flow limit |
| 1 s – 3 s | **Skeleton** for a page or a slot; **inline loader** for a small local task | User ruling, below |
| > 3 s | **Determinate progress bar** where duration is knowable; indeterminate with step and elapsed text where it is not. Plus cancel or background-handoff | User ruling; Nielsen; Goal-Gradient |

**The 1–3 s skeleton band is a deliberate divergence from NN/g's 2–10 s**, ruled
by the user and justified: NN/g addresses consumer web, where a visitor performs
a task once. ERP users are repeat professionals performing the same task hundreds
of times a day, so tolerance is far lower, and Doherty's frame is *productivity*
rather than satisfaction. Past 3 s a skeleton stops reassuring and starts lying —
it implies an imminence it cannot deliver.

### Why the ladder reframes the work

The app is server-rendered with **no client JavaScript at all**
([apps/web/package.json](../../apps/web/package.json) has no framework; there is
no `<script>`, `fetch()` or event listener anywhere in `apps/web/src`). A
server-rendered page that answers under 400 ms **needs no loading state**.

> **Loading states are an exception path, admitted only where a measured
> operation exceeds the Doherty threshold — never a default decoration.**

The operations that will genuinely exceed 400 ms here are known and few: posting,
release publication, import, bulk operations, long verification. Those get real
feedback. List and record reads get a **budget and a gate** instead.

This also tightens an existing number honestly: §15.1 already sets "common
registered queries p95 under 500 ms," chosen without a citation. Moving it to
**400 ms** makes it evidence-backed rather than arbitrary.

## 2. Four mechanisms carry almost all of it

Nineteen requirements resolve into four mechanisms. Nineteen features would
produce nineteen dialects; four mechanisms produce a system, and each lands on a
seam this architecture already has.

### M1 — Compiled feedback projection

The compiler emits, per slot, alongside the existing render manifest: a
**skeleton geometry**, a **disclosure tier**, a **latency class**, and an
**optimistic-eligibility flag**.

Delivers: skeleton fidelity on customised pages · progressive disclosure ·
optimistic-UI safety · per-slot loading. Because it derives from the same
`SurfaceDefinition` as the layout, skeleton-vs-layout drift is a **compile-time
failure**, not a visual bug.

**Gate (must observe, not proxy — AGENTS.md §6):** render skeleton and loaded
surface in the shadow browser at every breakpoint and compare box geometry within
tolerance. Negative controls: a slot present in one and absent in the other; a
column-priority change reflected in one and not the other.

### M2 — Per-slot state machine and fault isolation

Every slot resolves independently into exactly one of
`pending | ready | empty | failed`.

Delivers: **graceful degradation** (a failed slot renders an inline error card
while siblings render normally) · skeletons · empty states · inline errors ·
success states.

The slot is already the grammar's unit of composition, so it is the correct unit
of fault isolation. Today a single data failure yields a whole-page diagnostic
([surface-runtime.ts:514](../../apps/web/src/surface-runtime.ts:514)) — the page
is all-or-nothing. **Most architecturally significant item in this document.**

### M3 — Compiled message catalog

Every typed error code, empty state, and success confirmation maps to a
registered entry carrying **human sentence · next action · severity ·
placement**. An unregistered code **fails compilation**.

Delivers: friendly errors · no backend leakage · toast/modal/inline routing ·
empty-state copy · success confirmations. Converts "write good error messages"
from a writing-quality aspiration into **compiled closed vocabulary** — the
fail-closed pattern used everywhere else here. Today the user-facing text of a
failure is the machine code itself
([surface-runtime.ts:334](../../apps/web/src/surface-runtime.ts:334)).

### M4 — Token layer, visual system, and motion contract

Design tokens replacing the ~5 KB literal-hex CSS blob at
[surface-runtime.ts:616](../../apps/web/src/surface-runtime.ts:616); status roles
resolve from tokens only; the visual system in Part II; the shimmer specification
and reduced-motion behaviour.

Delivers: the entire visual direction · shimmer · Von Restorff redundancy · the
"tenants may change theme tokens" promise that is currently unimplementable.

## 3. Decision rules

### 3.1 Optimistic UI — a closed allow-list, and it must be

This collides hardest with accepted doctrine. §8.5 binds *weight matches
consequence*: postings and corrections always preview predicted effects and
require a deliberate confirm. Optimistic UI is the opposite gesture. It is
admissible only inside a **declared, closed class**, compiled into the definition
— never decided by a component author.

**Eligible** — reversible, no external effect, high success probability, trivial
to reconcile: saved-view switching · column sort and filter · section
expand/collapse · draft field autosave · marking a notification read ·
favouriting · navigation highlight.

**Never eligible** — anything that posts a movement, reserves or allocates stock,
receives or ships, publishes a release, corrects a posted fact, touches an
external system, or crosses a legal-entity boundary.

§8.4 already names the substrate in one unelaborated line — *"mutations use
pending/accepted/failed states and converge through event invalidation with
polling fallback."* M2 is that line implemented; optimistic UI is one privileged
transition within it, not a parallel mechanism.

### 3.2 Progressive disclosure — three tiers, one hard rule

The requirement contains its own tension: show only what is needed now, but never
hide what the user should have. Resolve by distinguishing **deferred** from
**hidden**, declared per field and section:

| Tier | Meaning |
|---|---|
| `always` | Rendered on arrival. Key facts, status, required inputs, anything blocking |
| `progressive` | Present and announced but collapsed — one interaction away, and counted in the summary so its existence is never concealed |
| `onDemand` | Fetched on expand. Genuinely large or expensive content only |

**Hard rule, compiler-enforced:** anything required, anything resolving to
`blocked` or `attention`, and anything the user must act on is `always`.
Declaring such a field `progressive` fails compilation. `ux-grammar` already
forbids tenants from changing "required-content visibility" — this gives that
clause a mechanism.

### 3.3 Choice reduction and form chunking

Group inputs into steps of **5–7**; above **10 fields** a form must declare
grouping or fail compilation. Broad category then sub-category rather than one
flat list.

The intent is right and the usual citation is wrong. Miller's own page cautions
against using 7±2 to justify design constraints, and a visible form is
recognition, not recall. The authority is **Hick's Law** (Hick & Hyman, 1952)
plus chunking. Same rule, defensible reason.

### 3.4 Validation, required fields, and the disabled-button refinement

- **Inline validation on blur, not on every keystroke.** Validating mid-typing
  flags an incomplete email as wrong before the user has finished.
- **Required fields marked at rest**, not only after a failed submit: asterisk
  plus a text label, never colour alone.
- **The submit control stays focusable and operable.** A deliberate refinement of
  the requirement as stated. A hard-`disabled` button is not focusable, announces
  nothing to a screen reader, and gives no route to discover *why* it is dead —
  which would violate the WCAG 2.2 AA claim §8.4 already makes. Instead: render
  it visually de-emphasised exactly as asked, keep it operable, and on activation
  move focus to the first incomplete field and announce the remaining count. The
  stated intent — *make it obvious what is still needed* — is better served,
  because it names the blocker rather than leaving the user to hunt.

### 3.5 Input normalisation — Postel's Law

*Be liberal in what you accept, conservative in what you send.* The core is
correctly conservative already: typed errors, fail-closed compilation, PR-6d's
ruling that search input is literal text with `%`, `_` and `!` escaped. What no
layer owns is **liberal acceptance at the edge**.

Each field type declares a normaliser applied *before* typed validation, with the
resolved canonical value echoed back:

- phone — dashes, parentheses, spaces, country prefixes, or none;
- quantity — thousands separators, leading zeros;
- codes and scans — trim, case-fold, strip known scanner affixes and terminators;
- dates — the locale's common spellings.

The warehouse case is load-bearing: a scan gun emits a code with a terminator,
sometimes trailing whitespace. `Item 001`, `item-001` and `ITEM001 ` must all
resolve, and the resolved value must be shown back for confirmation.

### 3.6 Pre-fill

From a **declared source**, never a hardcoded default: current principal's
default location and legal entity · today's business date · last-used
counterparty on the same document type · sequence-generated codes · the parent's
values on a child line. A pre-filled value is visually distinguishable from a
user-entered one and always editable.

### 3.7 Success states — and where full-page is wrong

- **Default: in-place.** The status chip changes, the row appears, the activity
  rail gains an entry. That is the confirmation.
- **Toast:** a completed background or bulk operation, when the user has probably
  navigated away from its origin.
- **Full-page:** reserved for **rare, terminal, high-consequence** events only —
  first-run setup complete, a release activation, a period close.

A warehouse operator posting two hundred receipts in a shift must not receive two
hundred celebrations. Peak-End says design the peaks; it does not say manufacture
them.

### 3.8 Error routing by severity

| Severity | Placement | Requirement |
|---|---|---|
| Field-level | **Inline**, adjacent to the input | The common case. Never a toast |
| Slot-level | **Inline card in the failed slot** | Siblings keep working (M2) |
| Non-critical, transient | **Toast** | Must *also* be recorded durably |
| Important, blocking | **Modal** carrying a specific rectifying action | e.g. no access → "Request access" |

**Toasts disappear; ERP failures must not.** A toast notifies about an event that
is also written to the activity rail or operation history — never the sole record
of a failure. `ux-grammar` already forbids a parallel "history" widget, so the
durable record has exactly one home.

**No backend text ever reaches the user.** Under M3 the human sentence is the
headline and the typed code is a small support reference beside it. Stack traces,
SQL and provider messages are observability output, never UI copy.

### 3.9 Empty states

- **First run** teaches the next action. §8.5 already mandates the setup checklist
  with three doors (direct UI, dry-run import, assistant). Add a progress
  indicator — Goal-Gradient (Hull 1932) and Zeigarnik together make this the one
  place an *artificial* progress indicator is well supported, and the component
  already exists (`northstar.shell:component.setup_checklist`).
- **Filtered-to-empty** is not first-run empty. Name the filter that excluded
  everything and offer to clear it.
- **Zero search results** offers near-matches — but **only for name-like fields**.
  On codes and SKUs "did you mean" is dangerous: a warehouse operator accepting a
  near-match on a part number picks the wrong part. Codes fail exactly and suggest
  nothing. Name near-match can reuse the existing C-collated folded columns via a
  shortened-prefix retry — no new infrastructure.

---

# Part II — Visual system

## 4. The diagnosis

The current styling is a single ~5 KB CSS string at
[surface-runtime.ts:616](../../apps/web/src/surface-runtime.ts:616). It has a
genuine point of view — deep forest green, lime accent, Georgia display type,
soft shadows, generous radii. The problem is genre, not taste: those are the
choices of a marketing page, applied to a tool someone operates for eight hours.

| Observed | Consequence |
|---|---|
| `clamp(2.6rem, 5vw, 4.8rem)` page titles — up to **77 px** Georgia | Editorial pages do this because the headline *is* the content. Here the data is the content. On a list, the title eats a third of the viewport before a row appears |
| Georgia headings + Inter body — **two typeface families** | The eye switches faces on every glance between a label and its value |
| Up to **72 px** page padding, ~50 px rows, 20 px panel radii, 1.2 rem gaps | Roughly half the density an operational list needs. Twelve rows visible where twenty should be |
| Ambient `radial-gradient` on `body`; `backdrop-filter: blur(14px)`; **16** shadow references, all `0 18px 55px` | Decoration with a running cost — visual noise on the 400th viewing, GPU cost on warehouse tablets |
| **Zero** `font-variant-numeric` occurrences | Proportional digits: `18,600` and `1,284` do not align, so quantity columns are genuinely harder to compare |
| **Zero** `prefers-color-scheme`; `color-scheme` hardcoded to `light` | Dark mode is impossible today |
| Brand hue is green; `success` is also green | The strongest signal on screen competes with decoration — the Von Restorff problem exactly |

The direction that fixes this is not softer or more colourful. It is **more
disciplined**: dense, quiet, confident. Reference points are Linear, Airtable and
Stripe's dashboard rather than a SaaS landing page.

## 5. Colour

**Brand: baby blue, `#89CFF0`.** One structural consequence drives everything
else — at 1.9:1 on white it is far under the 4.5:1 floor, so baby blue **cannot
carry text, a primary action, or a link**. It stays the identity colour; a deeper
sibling on the same hue does the work.

### 5.1 Brand ramp — hue 199°, anchored on the brand colour

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--b50` | `#F1F9FE` | Page tint, hover ground | — |
| `--b100` | `#DCF0FB` | Selected-row ground | — |
| `--b200` | `#BAE3F8` | Borders on tinted surfaces | — |
| **`--b300`** | **`#89CFF0`** | **Brand.** Mark, active-nav edge, selection edge, focus ring | — |
| `--b400` | `#4FB4E3` | Primary action **on dark ground** | — |
| `--b500` | `#2196CF` | Hover on 600 | — |
| **`--b600`** | **`#1478AE`** | **Primary action, links on light ground** | **4.9:1 AA** |
| `--b700` | `#0F5F8C` | Pressed; body-weight link text | **7.0:1 AAA** |
| `--b900` | `#0B3A55` | Rail ground, deep surfaces | — |

`--b300` is the colour actually seen — brand mark, active-nav edge, selected row,
focus ring. `--b600` does the working jobs. Same family, so it reads as one
identity rather than two colours.

### 5.2 Neutrals — chosen, not inherited

A slight blue bias (not pure grey) so neutrals sit with the brand rather than
against it: `#FFFFFF` · `#F6F8FA` · `#EDF1F5` · `#DFE5EC` · `#C6D0DA` ·
`#94A3B2` · `#6B7A89` · `#4E5C6A` · `#37444F` · `#232E37` · `#141C23`.

### 5.3 Status roles — and the brand collision

| Role | Foreground | Ground | Note |
|---|---|---|---|
| `success` | `#0A5C43` | `#E3F5EE` | |
| `attention` | `#8A5200` | `#FEF3E2` | |
| `blocked` | `#912018` | `#FEE9E7` | |
| `inProgress` | `#3730A3` | `#EEF0FE` | **Indigo, shifted off the brand hue** |

**The collision, and its correct size.** `ux-grammar` binds `inProgress` to
*blue*, and the brand is now blue — the strongest signal competing with the
identity. Shifting `inProgress` to indigo separates them.

Correcting an overstatement made when this was first raised: this is **not** a
change to the pinned contract. The pin block records role **names** only
(`["success","attention","blocked","inProgress"]`), which are unchanged, and plan
§8.5 names roles without binding hues. Only the skill's prose binds hues — and
indigo is a blue, so the shift is arguably already compliant. What genuinely
needs adding is a new rule:

> **Brand and status hues must remain separable.** The brand hue is reserved;
> no status role may resolve to a token within it. Status is the most
> information-dense colour on screen and must never compete with identity.

That is a one-paragraph skill amendment, not an ADR-scale grammar change.

### 5.4 Redundant encoding — non-negotiable

Every status renders **colour + dot + word on a tinted ground**. Never colour
alone: the Von Restorff research warns explicitly against colour-only contrast
for colour-vision deficiency and low vision, it is the WCAG floor §8.4 already
claims, and it is what makes a row readable at arm's length on a warehouse
tablet.

## 6. Typography

One typeface. Weight and size carry hierarchy.

- **Family:** one sans across the whole app. `ui-monospace` reserved for
  identifiers, codes and hashes only. Georgia is retired.
- **Page title: ~19–20 px**, not 77. The title is wayfinding, not content.
- **Type scale — six sizes total:** 10.5 (uppercase micro-label) · 11.5 (code) ·
  12.5 (body and table) · 13.5 (base) · 15–16 (section heading) · 19–20 (page
  title). Nothing outside the scale.
- **Weights: two visible per region.** 520–560 body, 640–660 emphasis. No 800s.
- **`font-variant-numeric: tabular-nums` on every number in a table.** Currently
  zero occurrences. Four lines of CSS, and the highest-return single change
  available: without it, digit columns are literally ragged.
- **Numbers right-aligned, text left-aligned.** Nothing else.
- **Uppercase micro-labels** get `.055–.12em` tracking; nothing else gets
  tracking above `-.01em` at body size.

## 7. Density and space

- **4 px spacing grid.** Every dimension a multiple.
- **Table rows 34 px**, header 28 px, page padding 18 px.
- **Density with rhythm, not cramming:** tight vertical measure, *generous*
  horizontal padding inside cells, hairline dividers instead of full borders.
- **Ruthless left-edge alignment.** Everything on a small number of vertical
  rulers — ragged left edges are the most common thing that makes an app feel
  amateur.

**Information design counts as density.** The mockup adds a **Min** column beside
**Available**, which is what makes "Below minimum" self-evident rather than
something the user takes on faith. That is a surface-definition change, not a
styling one — and the kind of thing the compiled definition should emit by
default.

## 8. Surface treatment

- **One border, not three signals.** Today every panel carries a border *and* a
  `0 18px 55px` shadow *and* a 20 px radius. Group by proximity and whitespace
  (Gestalt); use one hairline where a boundary genuinely matters.
- **Shadow means elevation only** — real overlays, popovers, modals. Never
  decoration.
- **Two radii:** 6 px controls, 8 px containers. Full round for avatars only.
- **No ambient gradients, no `backdrop-filter`.**

## 9. Motion

- Transitions on **colour and opacity only**, 120–160 ms. Never on layout — a
  moving row is a row you cannot click.
- Hover shifts the ground 2–3 %, never jumps.
- **Shimmer, exactly:** sheen begins fully left of the element and travels past
  the right edge; **2000 ms `linear`** — linear is what "steady" means, easing
  reads as faster and more urgent; low contrast between base and sheen so it never
  reads as flashing.

```css
.skeleton { position:relative; overflow:hidden; background:var(--skeleton-base); }
.skeleton::after {
  content:""; position:absolute; inset:0;
  background:linear-gradient(90deg,
    transparent 0%, var(--skeleton-sheen) 50%, transparent 100%);
  transform:translateX(-100%);
  animation:skeleton-sweep 2000ms linear infinite;
}
@keyframes skeleton-sweep { to { transform:translateX(100%); } }

@media (prefers-reduced-motion: reduce) {
  .skeleton::after { animation:none; display:none; }
}
```

**Reduced motion is mandatory, not optional** — the WCAG 2.2 AA claim in §8.4 and
the Von Restorff motion-sensitivity caveat both require it.

## 10. Dark mode

Both themes designed, never naively inverted. Tokens redefine under
`prefers-color-scheme: dark`; the accent moves **up** the ramp on dark ground
(`--b400` rather than `--b600`) because a dark surface needs a lighter accent to
hold contrast. Status grounds become deep tints with light foregrounds. Today
`color-scheme` is hardcoded to `light`, so this is impossible until M4 lands.

---

# Part III — The conventions register

Jakob's Law: users arrive with expectations from software they already use, and
violating them spends attention on relearning. The ERP translation matters more
than the literal e-commerce one. Decided once, recorded so it is not relitigated:

| Element | Desktop | Compact | Status |
|---|---|---|---|
| Primary navigation | Left rail | Bottom tab bar, ≤5, scan centred | **already correct** |
| Tenant / environment / principal | Top right | Collapsed into overflow | **already correct** |
| Global search / command palette | Top centre | Full-screen sheet | §8.5, not built |
| Primary action | Command bar, **leftmost** | Sticky bottom, thumb-reachable | **already correct** |
| Destructive action | Behind overflow, never a lone icon | Same | **already correct** |
| Breadcrumb | Above record title | Back affordance | **already correct** |
| Saved views | Page tabs | Horizontal chips | §8.5 |
| Assistant | Docked right rail | Full-screen sheet | §8.5 |

Primary-action-**left** is the ERP convention (SAP, Dynamics, NetSuite), not the
consumer-web convention of primary-right. The current shell already matches on
every settled row — recorded precisely so a future reviewer does not "fix" it
toward e-commerce habit.

---

# Part IV — Evidence base

## 11. Aesthetic-Usability is a hazard before it is an opportunity

Kurosu & Kashimura (1995), Hitachi Design Center: 26 ATM variants, 252
participants. Aesthetic appeal correlated more strongly with **perceived** than
with **actual** usability. The site's own takeaway is the warning this program
needs: *beautiful aesthetics can mask functional problems and hide issues during
usability testing.*

This repository's method is executable evidence over reported impression, and
AGENTS.md §6 requires a gate to **observe** the fact it asserts rather than a
proxy. "It feels fine" is a proxy, and this effect predicts that proxy degrades
**precisely when the visual work lands**. The 2026-07-27 finding — 130
real-module conformance violations while the architecture suite reported 68/68
green — is that failure mode arriving early, before there was any aesthetics to
blame. **So U2 must strengthen the conformance suite in the same packet that
makes the app attractive.**

## 12. Peak-End — where the design budget goes

Kahneman, Fredrickson, Schreiber & Redelmeier (1993): experiences are judged by
their most intense moment and their ending; negatives weigh heavier. Here the
peaks and endings are posting, publishing, **failing**, the receipt, and **the
error screen** — the two currently rendered as a bare machine code.

The highest-return investment is therefore **not** the home dashboard. It is
confirmation and error surfaces. §8.4's single line — *"empty and failure states
tell the user the safe next action"* — is the most valuable sentence in the
section and the only one with no owning gate.

## 13. Tesler's Law — the governing principle, already the plan's

*"Simplify for the user; more complexity on our end is acceptable"* is Tesler's
Law in the user's own words: irreducible complexity is **moved, not removed**,
and the only question is who carries it. An ERP's complexity — inventory truth,
legal entities, posting immutability — is irreducible. The north star's central
bet is exactly this shift: the platform owns the grammar so tenants own only
content.

It also sets the trade: **complexity is admitted onto the platform when it is
compiled once and consumed everywhere** — M1 through M4 all qualify. It is
refused when it is per-module or per-tenant hand-work, the same line §8.6 already
draws. Worth surfacing at the next program review, which keeps asking whether the
north star is still the right goal.

## 14. Laws already satisfied — validation, not work

| Law | Already encoded as |
|---|---|
| Jakob's Law, Mental Model | The five archetypes. §8.5's *"a user who learns the five shapes once has learned every future module"* is Jakob's Law turned inward |
| Hick's Law, Choice Overload | ~7 navigation entries then search; primary first, destructive behind overflow; saved views as tabs |
| Fitts's Law | 44 px minimum targets; sticky thumb-reachable primary action; Task archetype large targets |
| Common Region, Proximity, Similarity, Uniform Connectedness | Panels, key-fact grids, sections, child tables |
| Serial Position | Command bar orders primary first |
| Chunking, Cognitive Load, Working Memory | Record sections; accordions on compact; key facts |
| Occam's Razor | "Never build a sixth archetype"; closed registry; unknown vocabulary fails compilation |
| Paradox of the Active User | Setup checklist's three doors; contextual guidance over documentation |
| Pareto Principle | The standing "inventory first" prioritisation directive |
| Von Restorff | Status pills already carry colour **and** text **and** border — correct by accident; §5.4 makes it a rule |
| Tesler's Law | The north star's central bet (§13) |

**One correction:** §8.5 justifies the navigation budget via Miller. The correct
authority is Hick (§3.3). Keep the rule, fix the citation — a rule defended by
the wrong reason gets relitigated by the first person who notices.

---

# Part V — How this lands in the plan and the code

## 15. The binding constraint

The skill-guidance pinning test binds **plan §8.5–8.6 ↔
`.agents/skills/ux-grammar/SKILL.md` ↔ code**. CI fails on drift. **Every
amendment below that touches the grammar moves all three in one packet.** This is
why none of this can be done as incremental CSS tidying.

## 16. File-by-file destination map

| Destination | Receives |
|---|---|
| `docs/decisions/ADR-0028-*` (new) | Feedback ladder; loading states as an exception path; the 400 ms objective |
| `docs/decisions/ADR-0029-*` (new) | Token layer and visual system; the brand/status separation rule; motion contract |
| `docs/decisions/ADR-0030-*` (new, after the U3 debate) | Minimum client capability tier |
| Plan **§8.3** | Component registry gains `skeleton`, `progress`, `toast`, `inline-error` as declared components |
| Plan **§8.4** | The ladder; Postel input doctrine; error routing; success weighting; empty-state rules |
| Plan **§8.5** | Disclosure tiers; conventions register; Miller→Hick correction; brand/status separation |
| Plan **§8.6** | New enforcement layers: skeleton-geometry gate, message-catalog completeness, hex-literal ratchet |
| Plan **§15.1** | "Agreed Core Web Vitals" → the ratified ladder; 500 ms → 400 ms |
| `.agents/skills/ux-grammar/SKILL.md` | Mirror of every §8.4–8.6 change; pin block gains slot states, disclosure tiers, latency classes |
| `docs/operations/runtime-slos.md` | **First UI family** — today 128 lines, zero UI rows |
| `packages/canonical-model` | Slot-state, disclosure-tier, latency-class, optimistic-eligibility vocabulary |
| `packages/compiler` | Skeleton-geometry projection; message-catalog validation; disclosure and chunking rules |
| `packages/dev-tooling/src/surface-grammar-conformance/` | Geometry-comparison gate; message-catalog gate; hex-literal ratchet |
| `apps/web/src/surface-runtime.ts` | Token extraction; per-slot state machine; the whole visual system |
| `apps/web/test/browser/` | Skeleton/loaded geometry journeys; per-slot failure isolation; reduced-motion |

## 17. Phasing

Sized against this program's measured throughput: **84 packets accepted in the
ten days 2026-07-21 → 07-30** (56 Critical, 14 Mechanical, 13 Behavioral).

Nine rows become **11–15 actual packets** once the Critical ones split, which
this program routinely does (`G3-P2b` → two, `G3-P4` → P4a/P4b, row 4 → 4a/4b/4c/4d).

**The constraint is serialisation, not throughput.** Every row touches the same
three pinned artefacts — plan §8.5–8.6, the skill, and `surface-runtime.ts` — so
[lanes.md](lanes.md)'s disjoint-path requirement makes this **one lane, largely
serial**. It cannot fan out the way inventory did.

| Phase | When | Rows | Packets | Lane time | Outcome |
|---|---|---|---|---|---|
| **0** | **Now, during G3** | U0 | 1 | <1 day | Hex-literal ratchet. Holds the debt flat so Phase 1 stays a token swap |
| **1** | Immediately after G3 | U1, U2 | 3–4 | 1.5–2 days | **The app looks like the mockup.** Budget becomes a gate |
| **2** | Next | U3 → U4 | 2–3 | 1–2 days | Client-capability ruling, then per-slot fault isolation |
| **3** | Next | U5, U6 | 3–4 | 1.5–2 days | Skeletons correct on customised pages; errors become sentences |
| **4** | Last | U7, U8 | 2 | ~1 day | Forms, input normalisation, conventions, citations |

**Total ≈ 5–7 lane-days** — roughly a week of focused work, beginning after G3.
The visible payoff lands in the first two days of it.

Three things would move that number: a REVISE spiral (this program has hit the
two-REVISE cap before, and AGENTS.md cautions about the P3 spiral); **U4 is the
least-scoped item** and the most likely to split further; and any phase that
starts competing with an inventory lane for the matrix slot yields by the
standing rule.

**Why U2 (visual) precedes U4/U5 (structural) despite being less important:** the
token layer is a precondition for both, every later packet consumes it, and it is
the only item whose cost grows while it waits.

## 18. Risks to carry into the packets

1. **U2's test blast radius — measured, and smaller than first warned.** Across
   2,157 lines in `apps/web/test/browser/` there are **13 style assertions**
   (11 `toHaveCSS`, one `getComputedStyle`, one `backgroundColor`) that will
   break, and **14 class selectors** which are structural landmarks
   (`.app-shell`, `.sidebar`, `.skip-link`, `.navigation-tree`) that survive a
   restyle. Against 14 distinct restyle-safe `data-*` selectors. So the repair is
   hours, not a rewrite — U2 is a smaller packet than initially sized.
2. **U2 must strengthen the conformance suite in the same packet** — §11. An
   attractive app suppresses the human defect reports the suite is meant to
   replace.
3. **U5 depends on the compiler emitting geometry the runtime honours.** If the
   two drift the gate catches it, but the gate must exist before the feature, not
   after — otherwise the first skeleton ships unverified.
4. **The ladder is only meaningful if latency is measured.** U1 must ship the
   measurement, not just the number, or it becomes another unratified aspiration
   like §15.1's current Core Web Vitals row.
5. **Nothing here is inventory-blocking.** If a phase starts competing with an
   inventory lane for the matrix slot, the phase yields — the standing
   prioritisation rule already decides this.

---

## 19. Sources

- [Laws of UX](https://lawsofux.com/) — Jon Yablonski. All thirty laws reviewed.
- [Nielsen, *Response Times: The 3 Important Limits*](https://www.nngroup.com/articles/response-times-3-important-limits/)
  (from *Usability Engineering*, 1993; cites Miller 1968, Card et al. 1991).
- [NN/g, *Skeleton Screens 101*](https://www.nngroup.com/articles/skeleton-screens/).
- [Bill Chung, *Everything you need to know about skeleton screens*](https://uxdesign.cc/what-you-should-know-about-skeleton-screens-a820c45a571a)
  — the Viget-vs-Wroblewski conflict and the emotional-response result.
- Doherty & Thadani, "The Economic Value of Rapid Response Time", *IBM Systems
  Journal*, 1982.
- Kurosu & Kashimura, "Apparent usability vs. inherent usability", CHI 1995.
- Kahneman, Fredrickson, Schreiber & Redelmeier, "When More Pain Is Preferred to
  Less", *Psychological Science*, 1993.
- Hick (1952), Hyman (1953); Fitts (1954); Miller (1956); Hull (1932);
  Zeigarnik (1920s); von Restorff (1933) — via the Laws of UX pages above.
- **[UI direction mockup](https://claude.ai/code/artifact/db130305-e9b1-4dba-b195-bb0f24d8dd5f)**
  — the visual system rendered against the current styling, same data.
</content>
