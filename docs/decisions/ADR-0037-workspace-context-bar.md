# ADR-0037: The workspace context bar

**Owner-approved amendment, 2026-09-15 — RAIN-ORDER-ENTRY.** A declared browser
workspace-entry policy evaluates current authorized active companies over trusted
identity. One company enters automatically; several reuse a currently valid
principal/tenant/environment preference or offer a choice; none show access/setup
guidance. Preference is advisory and never authority. Entry materializes explicit
scope in the URL before reads/forms/navigation. Explicit invalid scope refuses.
Existing document URLs, draft buffers, prepared tasks and retries stay pinned;
switching company opens the owning List and cannot retarget another tab's work.
The never-remember/never-select passages below describe the former policy and
continue only as the fallback for surfaces without a declared entry policy.
Raw unscoped semantic calls and jobs/agents still require explicit operands.

Date: 2026-07-31
Status: accepted — ruled by the orchestrator on a bridge request from
`G3-P6b-1`, which stopped before authoring rather than inventing vocabulary.
Tier: Behavioral (a shell-grammar addition; the pinned contract block is
untouched)

## Context

Inventory is on screen but is not usable. Every entity-owned Inventory read
requires a legal-entity operand
([ADR-0031](ADR-0031-legal-entity-query-operand.md)), and the only way to supply
one today is to hand-edit a UUID into the URL.

The control that fixes that has **nowhere to live**. The shell contract names
exactly three parts — left navigation, main canvas, one contextual right rail
(plan §8.5; `ux-grammar` "Shell contract"). None of them fits:

- **Navigation** is role-shaped and task-named. A business-dimension selector is
  neither a role nor a task, and putting it there would also consume budget
  against the seven-entry maximum ADR-0030 rules as a physical constraint.
- **The right rail** holds exactly one tenant at a time — assistant dock in
  operate mode, properties drawer in customize mode. A scope selector is a third
  thing, and the grammar says "never both, never a second sidebar."
- **Archetype slots** are per-surface. A scope selection persists *across*
  surfaces; expressing it as a slot would mean repeating it in every archetype
  and would make each surface a separate authority over one value.

Meanwhile the rendered shell already has a `.topbar` carrying a context region
and a principal display (`apps/web/src/surface-runtime.ts`). **Neither the plan
nor the skill describes it.** It arrived without grammar authority, which is
drift — and it is the reason this ADR ratifies a region rather than inventing
one.

The `G3-P6b-1` writer stopped in under two minutes and issued a
stop-and-bridge-request instead of stretching an existing slot to mean something
new. That is the behaviour the orchestrator-only lease on plan §8.5 and
`ux-grammar` exists to produce, and it worked on its first real test.

## Decision

### 1. The shell gains a named region: the workspace context bar

A platform-owned bar at the top of the main workspace, above the canvas.

**It is not a fourth shell part.** The three parts are unchanged. The context bar
is chrome *within* the workspace, in the same class as the global command palette
and the New button — named shell furniture, not a structural division. A reader
who counts four parts has misread it.

### 2. Its sole purpose is explicit, URL-backed business-dimension selection

The context bar exists to answer *"which slice of the business am I looking
at?"* — nothing else. Legal entity is the first and only dimension it carries
today. The pattern generalises to others (fiscal period, site), but **each
addition requires its own justification**; a region that accepts anything
becomes a toolbar, and a toolbar is what this ADR exists to prevent.

### 3. It holds no state and carries no authority

Every selection is **written to the URL and read back from it**. The bar renders
the current selection *from* the URL; it never remembers one.

This is [ADR-0015](ADR-0015-legal-entity-business-dimension.md):38 applied
literally — the legal entity is resolved from operation input or a declared
default, *"never from ambient session state."* No cookie, no session, no
server-side sticky selection. If the URL does not say it, it is not selected.

### 4. It never selects on the user's behalf

No implicit default, **even when exactly one option exists**.

ADR-0031 §3 is binding: *"Omission is never 'all.' It is not even a narrower
scope — it is a refusal."* ADR-0015:38 does admit a *declared* default, but no
declared-default mechanism exists in this repository, and inventing one is a new
mechanism requiring its own decision. Until one exists, absence of a selection
keeps its typed refusal and the bar simply offers the choice.

The tempting shortcut — auto-selecting when a tenant has one legal entity —
is refused. It trains a user to believe a scope was chosen for them, and it
silently changes behaviour the day a second entity is created.

**How far this generalises — narrowed 2026-08-08.** The evidence above is
legal-entity evidence. ADR-0031 §3 is a ruling about the legal-entity query
operand; "omission is a refusal" is a property of *that* dimension, and §2 already
requires every further dimension to justify itself. A fiscal period or a site may
turn out to have a legitimate declared default and a safe omission semantics, and
this section is not evidence against it.

So the rule splits:

- **For legal entity:** absolute. No implicit default, even with one option.
- **For any dimension:** **no implicit default.** A default may arrive only through
  the declared-default mechanism ADR-0015:38 admits and this ADR records as absent
  — never as a convenience coded into the bar. Whether omission is *also* a typed
  refusal is answered by the dimension's own justification, not inherited from here.

**A workspace scope is not a document-field pre-fill, and the distinction is
load-bearing.** `ux-strategy-proposal.md` §3.6 lists *"current principal's default
legal entity"* among the declared sources a form may pre-fill from, and `U7` is
chartered to build declared-source pre-fill. That source is the same absent
mechanism named above. Pre-filling a field is not the bar selecting a scope, and
the two must not be conflated in either direction — but `U7` cannot invent the
mechanism either. Recorded against `U7` in
[ui-ux-remaining.md](../execution/ui-ux-remaining.md) §3b, which owes either a
narrowed source list or a bridge request.

### 5. It is platform-owned, not tenant-customizable

The context bar is not an archetype slot, not a customization surface, and not
extensible by a module. Modules declare *dimensions*; they do not decorate the
bar.

### 6. What it must never become

A place for actions, a second command surface, a notification host, a breadcrumb,
or a home for anything that is not a business dimension. Each of those has a home
already, and every one of them is how a context bar turns into a toolbar.

## What this ADR does not decide

- **How the selector is rendered.** Server-rendered markup is required — this
  application ships zero client JavaScript and the minimum client capability is
  an open debate (`U3`, reserved as ADR-0036). A form or a set of links suffices,
  because selection is a URL change. Nothing here authorises a client runtime.
- **The visual treatment.** That is
  [ADR-0035](ADR-0035-token-layer-and-motion-contract.md), and until `U2` lands
  the `U0` ratchet forbids new hex literals, so the bar must style itself from
  what exists.
- **Which further dimensions qualify.** Legal entity only, today.
- **The declared-default mechanism.** Named as absent in §4; it needs its own
  decision if the program ever wants one.
- **Whether the existing `.topbar` markup is the right implementation.** This ADR
  ratifies the *region*; the packet chooses the markup.

## Consequences

- **The pinned contract block is untouched.** It records archetypes, slots,
  components and status roles — it carries no shell-region vocabulary, so this
  addition is prose in plan §8.5 and `ux-grammar` and cannot raise
  `UX003_VOCABULARY_DRIFT`. Verified before writing.
- **A pre-existing drift is closed.** The `.topbar` shipped without appearing in
  either authority. It now has one. That the drift was found by a writer refusing
  to proceed, rather than by a gate, is worth noting: no gate observes
  shell-region drift, and none is proposed here.
- **The seven-entry navigation budget is unaffected**, because the selector never
  enters navigation. That was one of the reasons for placing it outside.
- **A scope selection is now shareable and bookmarkable**, which follows from §3
  rather than being designed for. A URL that names its scope reproduces exactly
  what the sender saw — which matters for a system whose whole point is that two
  companies' numbers never mix.
