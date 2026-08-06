# ADR-0035: The token layer, brand ramp, and motion contract

Date: 2026-07-31
Status: accepted — user rulings and approved visual direction 2026-07-30,
recorded 2026-07-31. Nothing implements it yet; the implementing packet is `U2`,
with the `U0` hex ratchet landing first as its hedge.
Tier: Critical (it moves every surface at once)

Rationale, full evidence base and the approved mockup:
[ux-strategy-proposal.md](../execution/ux-strategy-proposal.md) Part II.

## Context

There is no token layer. Colour is a literal-hex CSS blob inside
`apps/web/src/surface-runtime.ts` — **69 hex literals**, and no `.css` file
anywhere under `apps/web/src`. Measured 2026-07-31.

Three consequences follow, and each is a defect rather than a matter of taste:

- **A restyle is a hand-edit of every surface.** There is no indirection to swap.
  Every packet that renders a new surface during G3 grows the blob, which is why
  the ratchet (`U0`) is scheduled ahead of this work rather than alongside it.
- **Dark mode is impossible.** `color-scheme` is hardcoded to `light`. Without
  tokens there is nothing to redefine under a media query.
- **Numeric columns are literally ragged.** `font-variant-numeric: tabular-nums`
  has **zero occurrences** in the repository, so digits in a table do not align.

The brand direction was chosen and approved by the user: **baby blue `#89CFF0`**.
That choice carries one structural consequence that drives the entire system,
and it is the reason this is an ADR rather than a stylesheet.

## Decision

### 1. The brand colour cannot carry text, and the ramp is therefore load-bearing

`#89CFF0` measures **1.71:1 on white** — far below the 4.5:1 floor. It **cannot**
be used for text, a primary action, or a link.

This is not a limitation to work around. It is the fact that makes a ramp
necessary: the brand stays the *identity* colour, and a deeper sibling on the
same hue does the *working* jobs. Same family, so the interface reads as one
identity rather than two competing colours.

Any proposal that puts `#89CFF0` on a button label or a link is rejected by this
ADR without further discussion.

### 2. The brand ramp — hue 199°, anchored on the brand colour

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--b50` | `#F1F9FE` | Page tint, hover ground | — |
| `--b100` | `#DCF0FB` | Selected-row ground | — |
| `--b200` | `#BAE3F8` | Borders on tinted surfaces | — |
| **`--b300`** | **`#89CFF0`** | **Brand.** Mark, active-nav edge, selection edge | — |
| `--b400` | `#4FB4E3` | Primary action **on dark ground** | — |
| **`--b500`** | **`#2196CF`** | Hover on 600; **focus ring** *(amended 2026-08-06, §2.1)* | **3.12–3.61:1** on every ground it lands on |
| **`--b600`** | **`#1478AE`** | **Primary action, links on light ground** | **4.85:1 AA** |
| `--b700` | `#0F5F8C` | Pressed; body-weight link text | **6.92:1 AA** |
| `--b900` | `#0B3A55` | Rail ground, deep surfaces | 12.00:1 AAA |

`--b300` is the colour actually *seen*. `--b600` does the work.

**Ratios recomputed 2026-07-31** against WCAG 2.x relative luminance, all versus
`#FFFFFF`. Three figures inherited from the proposal document were wrong, and one
was wrong in a way that mattered:

| Token | Was recorded | Actually | Effect |
|---|---|---|---|
| `#89CFF0` | 1.9:1 | **1.71:1** | None — the conclusion is unchanged and in fact stronger |
| `--b600` | 4.9:1 | **4.85:1** | None — comfortably AA either way |
| `--b700` | 7.0:1 **AAA** | **6.92:1 AA** | **Real.** 7.0 is the AAA threshold; this token misses it |

`--b700` clears the 4.5:1 AA floor comfortably and is fine for its stated roles.
Only the **AAA label** was false. If AAA is wanted for body-weight link text the
token must move roughly 2% darker, which is a change to an approved visual
direction and therefore the user's call, not this ADR's.

Where the proposal document's Part II gives different figures, **this ADR
governs**.

### 2.1 The focus ring moves to `--b500` — amended 2026-08-06

**This ADR originally assigned the focus ring to `--b300`, and that was a defect
in this document.** `#89CFF0` measures **1.71:1** against a white panel and
**1.61:1** against the page ground. WCAG 2.2 **SC 1.4.11 Non-text Contrast**
requires **3:1** for a focus indicator against adjacent colours, and plan §8.4
claims WCAG 2.2 AA without qualification. The assignment therefore contradicted a
conformance level the platform states elsewhere.

Found by `U2`'s independent review, 2026-08-06. The lane implemented the ring
literally, measured it, and refused to change an approved visual direction on its
own authority — which is the correct behaviour and the reason this was caught
before it set.

The ring is now **`--b500` (`#2196CF`)**, ruled by the user 2026-08-06:

| Ground | `--b300` (was) | `--b500` (now) | `--b600` |
|---|---|---|---|
| Panel `#FFFFFF` | 1.71:1 ✗ | **3.32:1 ✓** | 4.85:1 ✓ |
| Page `#F6F8FA` | 1.61:1 ✗ | **3.12:1 ✓** | 4.56:1 ✓ |
| Rail `#0B3A55` | 7.00:1 ✓ | **3.61:1 ✓** | **2.47:1 ✗** |

**`--b500` is the only step on the ramp that clears 3:1 everywhere the ring
lands**, which is the whole reason it is the answer rather than simply "go
darker". The obvious fix is wrong: `--b600` fails on the dark rail at 2.47:1,
because a ring that gains contrast against light surfaces loses it against the
sidebar. A ring used on both light panels and a deep rail must sit in the middle
of the ramp, not at either end.

`--b300` keeps the brand mark, the active-nav edge and the selection edge — the
identity jobs, none of which are focus indicators and none of which carry the 3:1
floor. The visual direction the user approved on 2026-07-30 is otherwise
unchanged.

This also consumes `--b500`, which `U2` had defined as `--accent-tone` and
deliberately left unconsumed after finding that white on `--b500` measures
3.32:1 — below the 4.5:1 text floor — so it could not serve as a filled-button
hover. It is fine as a **ring**, because a focus indicator is non-text and its
floor is 3:1, not 4.5:1. The step was never redundant; it was mis-assigned.

**A ring must be gated against every ground it lands on, not against white.**
`--b300` would have passed a naive white-background check on the rail and failed
in the two places it is used most.

### 3. Neutrals are chosen, not inherited

A slight blue bias — not pure grey — so neutrals sit with the brand rather than
against it:

`#FFFFFF` · `#F6F8FA` · `#EDF1F5` · `#DFE5EC` · `#C6D0DA` · `#94A3B2` ·
`#6B7A89` · `#4E5C6A` · `#37444F` · `#232E37` · `#141C23`

### 4. Status roles, and the brand/status separability rule

| Role | Foreground | Ground |
|---|---|---|
| `success` | `#0A5C43` | `#E3F5EE` |
| `attention` | `#8A5200` | `#FEF3E2` |
| `blocked` | `#912018` | `#FEE9E7` |
| `inProgress` | `#3730A3` | `#EEF0FE` (**indigo, shifted off the brand hue**) |

The `ux-grammar` skill's prose binds `inProgress` to *blue*, and the brand is now
blue — the most information-dense colour on screen competing with the identity.
Shifting `inProgress` to indigo separates them.

**This is not a change to the pinned contract.** The pin block records role
**names** only (`["success","attention","blocked","inProgress"]`), which are
unchanged, and plan §8.5 names roles without binding hues. Only the skill's prose
binds a hue, and indigo is a blue. The correction is a one-paragraph skill
amendment, not a grammar change. *(An earlier framing of this collision as
ADR-scale was an overstatement and is corrected here.)*

What genuinely needs adding is a standing rule:

> **Brand and status hues must remain separable.** The brand hue is reserved. No
> status role may resolve to a token within it. Status is the most
> information-dense colour on screen and must never compete with identity.

### 5. Redundant encoding is non-negotiable

Every status renders **colour + dot + word on a tinted ground**. Never colour
alone.

Three independent reasons, any one sufficient: the Von Restorff literature warns
explicitly against colour-only contrast for colour-vision deficiency and low
vision; it is the WCAG floor plan §8.4 already claims; and it is what keeps a row
readable at arm's length on a warehouse tablet.

### 6. Typography — one typeface, six sizes, two weights per region

- One sans across the whole application. `ui-monospace` **only** for identifiers,
  codes and hashes. Georgia is retired.
- **Six sizes, nothing outside the scale:** 10.5 (uppercase micro-label) · 11.5
  (code) · 12.5 (body and table) · 13.5 (base) · 15–16 (section heading) · 19–20
  (page title).
- Page title **~19–20 px**, not 77. A title is wayfinding, not content.
- **Two visible weights per region:** 520–560 body, 640–660 emphasis. No 800s.
- **`font-variant-numeric: tabular-nums` on every number in a table.** Four lines
  of CSS, and the highest-return single change available.
- Numbers right-aligned, text left-aligned. Nothing else.

### 7. Density — a 4 px grid, with rhythm rather than cramming

4 px spacing grid, every dimension a multiple. Table rows **34 px**, header
28 px, page padding 18 px. Tight vertical measure with *generous* horizontal
padding inside cells; hairline dividers rather than full borders. Ruthless
left-edge alignment onto a small number of vertical rulers.

### 8. Surface treatment — one signal per boundary

Today every panel carries a border *and* a `0 18px 55px` shadow *and* a 20 px
radius: three signals for one boundary. Group by proximity and whitespace, and
use one hairline where a boundary genuinely matters. **Shadow means elevation
only** — real overlays, popovers, modals — never decoration. **Two radii:** 6 px
controls, 8 px containers; full round for avatars only. No ambient gradients, no
`backdrop-filter`.

### 9. Motion — colour and opacity only, and shimmer is exact

- Transitions on **colour and opacity only**, 120–160 ms. **Never on layout** — a
  moving row is a row you cannot click.
- Hover shifts the ground 2–3 %, never jumps.
- **Shimmer, exactly:** the sheen begins fully left of the element and travels
  past the right edge; **2000 ms `linear`**. Linear is what "steady" means —
  easing reads as faster and more urgent. Low contrast between base and sheen so
  it never reads as flashing.

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

**The reduced-motion fallback is mandatory, not optional.** A skeleton shipped
without it does not satisfy this ADR.

### 10. Dark mode — designed, never inverted

Both themes are designed. Tokens redefine under `prefers-color-scheme: dark`.
The accent moves **up** the ramp on dark ground (`--b400` rather than `--b600`),
because a dark surface needs a lighter accent to hold contrast. Status grounds
become deep tints with light foregrounds.

Naive inversion is rejected: it would put `--b600` on a dark ground, below the
contrast floor, reintroducing the exact defect §1 exists to prevent.

## What this ADR does not decide

- **Which concrete typeface** is licensed and loaded. §6 binds "one sans" and the
  scale; it does not pick a family.
- **The hex ratchet's mechanism** — that is packet `U0`, deliberately landing
  first so this work remains a token swap rather than a hand-edit.
- **The minimum client capability** (`U3` debate, reserved as ADR-0036). Nothing
  in this ADR requires client JavaScript; the shimmer is pure CSS by design.
- **Surface-definition changes that look like styling but are not** — e.g. the
  mockup's `Min` column beside `Available`, which is what makes "Below minimum"
  self-evident. That is a compiled-definition change and belongs to the surface
  packets, not to the token layer.
- **The feedback semantics** the tokens dress: bands, optimistic eligibility and
  success weighting are ADR-0032.

## Consequences

- **This moves every surface at once**, which is why it is Critical and why the
  ratchet precedes it. There is no incremental path: a token layer that half the
  surfaces ignore is worse than none, because it hides which surfaces are
  unconverted.
- **`U2`'s test blast radius is measured, not estimated.** Across 2,157 lines in
  `apps/web/test/browser/` there are **13 style assertions** that break — 11
  `toHaveCSS`, one `getComputedStyle`, one `backgroundColor` — and **14 class
  selectors** that are structural landmarks (`.app-shell`, `.sidebar`,
  `.skip-link`) which survive a restyle. Hours of repair, not a rewrite.
- **Extracting the blob from `surface-runtime.ts` should follow that file's
  split.** It is 746 lines doing four jobs; splitting it first stops the visual
  work from contending with the surface packets.
- **`tabular-nums` is the cheapest item here and the most visible.** It should
  not wait for the rest of the token layer if a smaller slice becomes available.
- **The contrast figures are claims a gate can check, and the check already
  earned its keep.** Recomputing them by hand on 2026-07-31 found `--b700`
  labelled AAA at 7.0:1 when it is 6.92:1 — below the AAA threshold. That figure
  had been carried unchallenged through the proposal and into the first draft of
  this ADR. Every ratio in §2 and §4 is an assertion about a shipped token, so
  `U2` must ship a test that **computes** contrast from the token values, with
  a negative control that a token moved below its floor fails. A number in a
  table is exactly the proxy AGENTS.md §6 warns about; the computation is the
  observation.

  The status roles were audited at the same time and all pass:
  `success` 7.07:1, `attention` 5.82:1, `blocked` 7.44:1, `inProgress` 8.77:1,
  each foreground on its own ground.
