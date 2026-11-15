# ADR-0036: Minimum client capability — one owned script, five behaviours, no framework

Date: 2026-08-02
Status: accepted — ruled by the orchestrator reconciling the `U3` two-arm debate. The
row reserved this number for U3's output; it is now cut.
Tier: Critical (it settles whether this platform ships a client runtime)

## Context

Plan §8.1 assumed React. ADR-0005 dropped `@agent-native/core` — an **agent** framework,
not a UI framework — so nothing ever actually resolved the question. What ADR-0005 binds
is its enforcement clause against **framework-owned application state**, which is a
constraint on any answer rather than an answer itself.

[ADR-0032](ADR-0032-feedback-ladder-and-loading-states.md) §2 narrowed the question
decisively: the application is server-rendered and **reads need no client capability at
all**. A page answering inside 400 ms needs no loading state. So the live question is only
the residue: determinate progress above 10 s, optimistic transitions on the closed
allow-list, and inline validation.

Two independent arms answered the charter. **Both ruled Tier B** — a single
repository-owned, dependency-free progressive-enhancement module — and both rejected a
framework, a hypermedia library as the default, and a component runtime. Where they
differed, the narrower reading is adopted, and one arm established a sequencing fact the
other missed.

## Decision

### 1. One repository-owned, dependency-free script

The platform's minimum client capability is a **single** script, owned in this repository,
with no third-party dependency. It is inlined into the served document and
**content-hash-pinned in the CSP** that today blocks all script
(`apps/web/src/app-server.ts:38`).

Pinning matters: the CSP currently blocks everything, and admitting script must be a
deliberate, hash-bound exception rather than a relaxation that later admits anything.

### 2. Exactly seven behaviours — a closed set (amended 2026-09-15, 2026-09-25, 2026-09-26)

1. Pending-state toggling.
2. Polling **one** operation-status resource to drive server-rendered determinate progress.
3. Applying compiled optimistic transitions read from definition-derived data attributes,
   with rollback.
4. Advisory inline validation, requested from the server.
5. Native Task-dialog presentation: promote one server-rendered Task container
   inside its originating Record, close/reopen that same container, and manage
   focus. A typed compiled policy must explicitly declare `fallback: page`.
   Forms, preparation, confirmation, execution, outcomes and fresh Record reads
   remain server-owned. Closing dispatches nothing and never implies rollback.
   No fetching, replay, retry, routing, business rendering or client task state.
6. Reference-control keyboard presentation in the draft document editor: Enter
   in a picker's search box activates that field's own server-rendered Search
   submit instead of the form's default action; arrow keys and Escape move focus
   between the search box and the server-rendered result buttons; a pending
   control is marked busy. The editor's in-context create uses behaviour 5's
   native dialog, where Escape activates the create form's own server-rendered
   Cancel submit and Hide dispatches nothing. Every search, page, selection,
   create and cancel remains a server-rendered submit; the script fetches
   nothing, creates no element, holds no selection and decides nothing.
   *Superseded for the draft editor's reference fields by behaviour 7 where the
   script runs; unchanged as the no-JavaScript path.*
7. In-place reference fields in the draft document editor (server-rendered
   fragments). Focus, typing (debounced), More, selection, clear and the
   governed create flow of one declared reference field send that field's own
   server-rendered action as a same-origin `POST` to the page's own URL, marked
   by the `x-rain-fragment` header, carrying the draft session, the field's
   lookup request number and its selection generation. The server answers with
   escaped server HTML naming the one element each part replaces — the field's
   lookup region, the field, a declared dependent in the same row, or the create
   slot — or asks for the ordinary submit instead (`x-rain-fragment-fallback`).
   The script replaces only those elements, keeps focus and the highlighted
   option, drops any answer older than the field's newest request, and holds
   the order's own submit while a selection or create is in flight. Enter
   chooses and never submits the order; Escape closes the popup first. It holds
   no result cache, filters nothing, renders no business value and decides
   nothing: every read is authorized per request on the server, every choice is
   admitted there against the field's newest offered set and generation, and
   search mutates no business data.

The owner approved this bounded amendment for RAIN-META-SALES on 2026-09-15:
document context is essential while reserving and partially shipping. Native HTML
and server navigation deliver the full-page fallback, but do not deliver the
contained modal focus and in-context dismissal of a native `showModal()` dialog.
The same Task/action flow remains one Task archetype; there is no sixth archetype.
This is **Task presentation**, not `modal` MESSAGE placement: ADR-0048's named
refusal remains in force. No notification, access-request or toast system enters.

The owner authorized the sixth behaviour for the RAIN-ORDER-ENTRY form-usability
correction on 2026-09-25, under §2a's test. It is this script's domain. Native HTML
cannot deliver it: Enter in a text box submits the enclosing form's default
button, so without script Enter refreshes the whole draft rather than searching
the focused field, and focus cannot move through a result list by arrow key. The
capability it depends on exists: server-side search, paging, selection and
governed create, each already a complete no-JavaScript path. It ships with the gate
that observes it: the order-entry browser proof drives keyboard search and
selection with script and the same search, select and create-and-return with
JavaScript disabled. Type-ahead fetching, a client result cache and client
filtering stay refused under §7.

The owner authorized the seventh behaviour for RAIN WORKSPACE INTERACTION
COMPLETION on 2026-09-26, as the bounded server-rendered-fragment enhancement the
product-parity assessment recommended, under §2a's test. It is this script's
domain. Native HTML cannot deliver it: a submit re-renders the whole document,
so options cannot open on focus or narrow while typing, and every search and
selection reloads the page around fields the user is still completing. The
capability it depends on exists: behaviour 6's server-side search, paging,
selection and governed create, which remain the no-JavaScript path with the same
authority and outcomes. It ships with the gates that observe it: controlled-
executor tests of late, replayed, two-field and withdrawn-read answers and the
HTTP transport guards, and the order-entry browser proof with scripted delays
and JavaScript disabled. The CSP admits `connect-src 'self'` and nothing else
changes: `script-src` stays one hash, no inline handler or `unsafe-inline`
script is admitted, the server never redirects a fragment, and the fragment
transport is the page's own submit, not a parallel write API. §8's audited
hypermedia library is not adopted: the evidence is one bounded behaviour, not an
accidental component framework.

Closed, not illustrative. This programme governs by closed vocabularies and exact
partitions everywhere else; an open licence to "progressively enhance" is how one script
becomes a framework.

#### 2a. What the set is closed *over* — scoped 2026-08-08 after a doctrine review

**The four were enumerated from the live residue, not from the platform's known
commitments, and the ADR then wrote them as a platform-wide minimum.** §2's list is
exactly what remained after ADR-0032 §2 removed reads from the question: progress,
optimistic transitions, and validation, plus pending toggling. Meanwhile "What this ADR
does not decide" concedes that **camera scanning and the installable PWA already require
client JavaScript at launch** — plan lines 1690 and 1711 commit to both — and names them
as the reason Tier A was rejected. A set that excludes the capabilities whose existence
justified choosing this tier is not closed over the platform; §2b of ADR-0032 adds a
fifth candidate the enumeration never saw, a navigation-time skeleton swap.

Read at its own evidence, this decision is closed over **one thing**: the
progressive-enhancement behaviours of the single inlined document script that serves
grammar-owned surfaces. That is still the load-bearing ruling — it is what keeps one
script from becoming a framework — and it is what §3 and §7 police.

**Other client-capability domains are neither authorized nor foreclosed here.** Camera
and keyboard-wedge scanning, and the service worker an installable PWA requires, are
separate domains with their own delivery, their own CSP consequences, and their own
one-way doors. Each needs its own decision, and §3's "no second script" is a rule about
*this* script's domain, not a veto the plan's launch commitments must be argued around.

**The amendment test, so the set can close without freezing.** A further behaviour is
admitted to §2 only when all four hold: it belongs to this script's domain; the
required interaction cannot be delivered by server navigation or native HTML alone
(an explicit, usable full-page fallback does not disqualify an in-context Task dialog); the
capability it depends on already exists (per §6's ordering); and it ships with the gate
that observes it. Anything failing one of those is refused by name with what would admit
it — the pattern ADR-0048 §4 uses for `toast` and `modal`.

### 3. No second script

Structural, and mechanically enforceable — a gate can count scripts and check the CSP hash.
The failure mode this forecloses is not a bad decision but an accumulation of small
reasonable ones. *Scoped by §2a:* the count is over scripts in this domain — the served
document's own inlined script — and the packet that first ships one owes the gate. Today
the count is zero and the CSP admits none (`apps/web/src/app-server.ts:36-39` sets
`default-src 'none'` with no `script-src`), so there is nothing yet for a counter to
observe.

### 4. Reads, navigation and forms work with JavaScript disabled

Proven by an **executed browser gate**, not by a promise. This is the property that keeps
the SSR architecture real rather than nominal, and it is exactly the kind of claim this
programme requires be observed rather than asserted.

### 5. The script holds no durable or business-authoritative state

Server-authoritative throughout. ADR-0005's enforcement clause against framework-owned
application state is **inherited as a standing constraint**, not an obstacle to route
around. ADR-0005 is not superseded and does not need to be.

### 6. Build order — determinate progress comes LAST

1. **Native HTML constraint validation** — no script at all.
2. **Native Task-dialog presentation**, carrying the script-count/CSP and JS-on/off
   browser gates, keyboard containment, close/reopen and prepared-confirmation checks.
   This ships first; it has no pending-state or async substrate dependency.
3. **The pending-state behaviour**, carrying the same gate harness.
4. **Determinate progress**, and only once a real async job substrate exists.

Step 4 is deliberately last because **no job substrate exists in `packages/runtime`
today**, and ADR-0032 §3a already forbids a progress bar without real data. Building the
bar first would mean animating a fiction. This ordering is not a preference; it is an
existing rule applied to a fact one arm went and checked.

### 7. Not authorized

Frameworks; hypermedia libraries as the default; hydration; client routing or stores;
client rendering of business data; executable client validation; tenant-authored client
code; component-emitting compiler output; script-created interactive elements (behaviour
7 inserts elements the server rendered, never elements the script composes); any second
script; client result caches or client filtering; fetching beyond behaviour 7's
same-origin fragment POSTs; **client-side timing collection or beaconing** — added 2026-08-08, because
measurement is not one of the five behaviours and
[ADR-0032](ADR-0032-feedback-ladder-and-loading-states.md) §2c records the standing
temptation to admit it as instrumentation rather than as capability. Wanting to observe
the user's real wait is a good reason to amend this ADR under §2a's test, and not a
reason to route around it.

### 8. The named escalation

An **audited hypermedia library** is the reserved escalation tier, on measured evidence —
specifically, evidence that the owned script has become an accidental component or state
framework. Code volume alone does not qualify; it requires browser-journey failure data and
maintenance cost, plus proof that the alternative preserves the same compiler and
tenant-customization boundary.

## What makes this a one-way door

Recorded so the boundary is visible rather than discovered. This decision becomes
substantially less reversible if any of these land:

- client-side routing or mandatory initial data fetching
- DOM selectors or library directives in compiler output
- tenant customizations emitting client code
- Formula IR gaining an independent browser evaluator
- a persistent client cache or store becoming authoritative
- offline queues or service-worker state entering this layer

All are outside this ADR. Each would need its own decision, and each should be read as a
re-founding of the compiled-surface seam rather than an amendment to it.

## What this ADR does not decide

- **The async job substrate.** §6 conditions determinate progress on it; it does not design
  it.
- **The camera-scanning and PWA commitments** in plan §8.5. They are why Tier A (no script
  at all) was rejected — the plan already commits to client JavaScript at launch, and Tier
  A's only live-progress mechanism is WCAG failure F41 — but their own scope is untouched.
- **Plan §8.1 and §8.6's React phrasing**, which must be reworded framework-neutrally.
  Neither is a pinned anchor and the `ux-grammar` pin suffers zero mechanical breakage.
  Orchestrator work, recorded as owed.

## Consequences

- **U5, U6 and U7 unblock.** They were held on this row.
- **The compiler and `SurfaceDefinition` seam are untouched**, and G6 tenant customization
  inherits nothing from this decision — which is the property that made Tier B preferable
  to a component runtime.
- **A plan assumption is retired.** §8.1 assumed React for long enough that it read as
  settled. It was never decided, and the answer turns out to be far smaller than the
  assumption.
