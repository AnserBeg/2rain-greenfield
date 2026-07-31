# ADR-0032: The feedback ladder, and loading states as an exception path

Date: 2026-07-31
Status: accepted — user rulings 2026-07-30, recorded 2026-07-31. Nothing
implements it yet; the implementing packets are `U1`, `U4`, `U5` and `U7` in
[current-plan.md](../execution/current-plan.md).
Tier: Behavioral (the ladder), Critical (the optimistic allow-list)

Rationale, evidence tables and sources:
[ux-strategy-proposal.md](../execution/ux-strategy-proposal.md) Part I.

## Context

The obvious way to add UI feedback to this application is to put a spinner on
everything slow and a skeleton on everything slower. That is decoration chosen
per component by whoever writes the component, and it produces a different
dialect on every surface.

Two facts make a different answer available here.

**The application is server-rendered with no client JavaScript at all.**
`apps/web/package.json` declares no framework, and there is no `<script>`,
`fetch()` or event listener anywhere in `apps/web/src`. A server-rendered page
that answers inside the Doherty threshold needs no loading state — there is no
interval during which the user is looking at an empty frame.

**The operations that will genuinely exceed the threshold are known and few:**
posting, release publication, import, bulk operations, long verification.
Everything else is a registered query with a latency budget.

So the design question is not "which spinner" but "which operations have earned
a loading state at all."

The evidence is settled and partly cautionary. Doherty & Thadani (IBM Systems
Journal, 1982) put the productivity cliff at **400 ms**, replacing the earlier
2-second standard. Nielsen (1993, citing Miller 1968 and Card et al. 1991) gives
**0.1 s** instantaneous, **1.0 s** the limit of uninterrupted thought, **10 s**
the limit of attention. NN/g's skeleton guidance says show nothing under 1 s.
And the skeleton-versus-spinner perceived-duration literature is **genuinely
mixed** — Viget 2017 against Wroblewski 2013 and later replications — with
skeletons winning consistently only on *emotional* response, not on perceived
speed. That last point is why this ADR does not simply mandate skeletons.

## Decision

### 1. The ladder

| Band | Treatment | Authority |
|---|---|---|
| < 100 ms | Nothing. Render. | Nielsen instantaneous |
| 100–400 ms | Nothing. Render. **Target band for every registered query.** | Doherty |
| 400 ms – 1 s | Inline pending state on the pressed control only. No skeleton. | Nielsen flow limit |
| 1 s – 3 s | **Skeleton** for a page or a slot; **inline loader** for a small local task | User ruling |
| 3 s – 10 s | **Indeterminate indicator with context** — a spinner or inline loader that says what is running. **No progress bar.** | NN/g; Nielsen |
| > 10 s | **Determinate progress** where the total is knowable; indeterminate with step and elapsed text where it is not. **Plus cancel or background-handoff.** | Nielsen 10 s attention limit; NN/g; Goal-Gradient |

### 2. Loading states are an exception path, not a default

> A loading treatment is admitted only where a **measured** operation exceeds the
> Doherty threshold. It is never a default decoration, and never a component
> author's choice.

The corollary is the part that does work: list and record reads get **a budget
and a gate**, not a skeleton. A surface that needs a skeleton for an ordinary
read is reporting a performance defect, and the skeleton would hide it.

### 3. The 1–3 s skeleton band diverges from NN/g deliberately

NN/g places skeletons at 2–10 s. This ADR places them at 1–3 s.

NN/g addresses consumer web, where a visitor performs a task once and abandonment
is the failure mode. ERP users are **repeat professionals** performing the same
task hundreds of times in a shift, so tolerance is far lower, and Doherty's frame
is *productivity* rather than satisfaction. Past 3 seconds a skeleton stops
reassuring and starts lying: it implies an imminence it cannot deliver, which is
why the band ends rather than extending to 10 s.

This divergence is recorded rather than silently adopted so that a future reader
finds the reason instead of assuming the source was misread.

### 3a. Above 3 s there are two axes, not one — refined 2026-07-31

The first draft of this ADR collapsed everything past 3 s into a single band and
made *determinacy* the only axis. That was wrong, and the correction restores
the sources rather than departing from them.

**Duration decides whether progress is owed at all.** Between 3 and 10 seconds a
spinner that says what is running is the right answer. Ten seconds is Nielsen's
**limit of attention** — the point at which a user stops waiting and starts doing
something else — and NN/g independently puts "determinate progress plus cancel"
at *over* 10 s, not over 3 s. So the 3–10 s band gets an informative
indeterminate indicator, and only past 10 s is progress owed.

**Knowability decides whether that progress can be determinate.** Many ERP
operations know their total — posting 200 lines, importing 5,000 rows — and can
fill a real bar. Others genuinely cannot, such as a long verification. Those get
step and elapsed text instead.

> **Never render a determinate progress bar without real progress data.** A bar
> that animates on a timer rather than on work completed is a fabricated claim
> about how far along the operation is. It is the same class of defect as an
> optimistic transition on a posting: showing the user an outcome the system
> does not actually know.

**Cancel or background-handoff belongs at the 10 s boundary,** not at 3 s. Past
the attention limit the user should be able to leave — that is what the limit
means. Below it, offering to cancel a 4-second operation invites a decision the
user did not need to make.

The proposal document's Part I carries the earlier single-band table. Where they
differ, **this ADR governs**.

### 4. Optimistic UI is a closed, compiled allow-list

This is the ruling that collides hardest with existing doctrine, and the
collision is real: plan §8.5 binds *weight matches consequence* — postings and
corrections preview predicted effects and require a deliberate confirm.
Optimistic UI is the opposite gesture.

It is therefore admissible **only inside a declared, closed class compiled into
the definition**, never decided by a component author.

**Eligible** — reversible, no external effect, high success probability, trivial
to reconcile: saved-view switching · column sort and filter · section
expand/collapse · draft field autosave · marking a notification read ·
favouriting · navigation highlight.

**Never eligible** — anything that posts a movement, reserves or allocates stock,
receives or ships, publishes a release, corrects a posted fact, touches an
external system, or **crosses a legal-entity boundary**.

The never-eligible list is not a style preference. Each entry names an operation
whose optimistic rendering would show a user an outcome the ledger may refuse,
and this platform's entire posting design exists to make that refusal
authoritative.

Plan §8.4 already names the substrate in one unelaborated line — *"mutations use
pending/accepted/failed states and converge through event invalidation with
polling fallback."* Optimistic UI is **one privileged transition within that
state machine**, not a parallel mechanism.

### 5. Success states are weighted, and full-page is almost always wrong

- **Default: in-place.** The status chip changes, the row appears, the activity
  rail gains an entry. That is the confirmation.
- **Toast:** a completed background or bulk operation, when the user has probably
  navigated away from its origin.
- **Full-page:** reserved for **rare, terminal, high-consequence** events only —
  first-run setup complete, a release activation, a period close.

A warehouse operator posting two hundred receipts in a shift must not receive two
hundred celebrations. Peak-End says design the peaks; it does not say manufacture
them.

### 6. "Did you mean" applies to names, never to codes

Fuzzy near-match suggestions are admitted on **name-like** fields only. They are
**forbidden on codes, SKUs, part numbers, and any identifier**.

A wrong near-match on a part number picks the wrong part, and the user has no
cue that a substitution occurred — the field looks like the one they typed. On a
name, a wrong suggestion is visible as a wrong name.

### 7. The query budget tightens to 400 ms, and gains a citation

Plan §15.1 currently sets "common registered queries p95 under 500 ms," a number
chosen without a source. It moves to **400 ms**, which makes it evidence-backed
(Doherty) rather than arbitrary, and aligns the budget with the band in which no
loading state is needed.

## What this ADR does not decide

- **The minimum client capability.** The ladder's upper bands — determinate
  progress, optimistic transitions, inline validation — imply *some* client
  capability, and this repository has none today. Plan §8.1 assumes React;
  ADR-0005 dropped the framework; nothing has resolved it. That is the `U3`
  debate, and its output is reserved as **ADR-0036**. Until it lands, no packet
  may introduce a client runtime to satisfy this ADR.
- **The visual spelling** of skeletons, pending states and status colour — the
  token layer, ramp and motion contract are **ADR-0035**.
- **The message catalog spelling** for error and empty-state copy (`M3`, packet
  `U6`).
- **Where the compiled feedback projection stores its per-slot data** (`M1`,
  packet `U5`); this ADR fixes the semantics, not the projection shape.

## Consequences

- **The ladder is falsifiable, which is the point.** Every band names an
  observable treatment, so a surface can be checked against it rather than
  reviewed for taste.
- **Skeleton fidelity becomes a compile-time property, not a visual bug.** M1
  derives skeleton geometry from the same `SurfaceDefinition` as the layout, so
  drift between them fails the build. Its gate must **observe** geometry — render
  both and compare box geometry at every breakpoint (AGENTS.md §6) — with
  negative controls for a slot present in one and absent in the other, and for a
  column-priority change reflected in one and not the other.
- **The 500 ms → 400 ms change tightens a shipped budget.** It is a tightening,
  not a relaxation, so it cannot be satisfied by widening anything.
- **`prefers-reduced-motion` support is mandatory** for every treatment this ADR
  admits, per the WCAG 2.2 AA claim in plan §8.4. A skeleton without a
  reduced-motion fallback is not compliant with this ADR.
- **An operation that needs a loading state is making a claim about its own
  latency.** Adding one to dodge a budget inverts the rule in §2 and is a defect,
  not an implementation detail.
