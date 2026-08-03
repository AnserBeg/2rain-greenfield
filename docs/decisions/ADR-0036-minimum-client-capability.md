# ADR-0036: Minimum client capability — one owned script, four behaviours, no framework

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

### 2. Exactly four behaviours — a closed set

1. Pending-state toggling.
2. Polling **one** operation-status resource to drive server-rendered determinate progress.
3. Applying compiled optimistic transitions read from definition-derived data attributes,
   with rollback.
4. Advisory inline validation, requested from the server.

Closed, not illustrative. This programme governs by closed vocabularies and exact
partitions everywhere else; an open licence to "progressively enhance" is how one script
becomes a framework.

### 3. No second script

Structural, and mechanically enforceable — a gate can count scripts and check the CSP hash.
The failure mode this forecloses is not a bad decision but an accumulation of small
reasonable ones.

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
2. **The pending-state script**, carrying the full gate harness from §3 and §4.
3. **Determinate progress**, and only once a real async job substrate exists.

Step 3 is deliberately last because **no job substrate exists in `packages/runtime`
today**, and ADR-0032 §3a already forbids a progress bar without real data. Building the
bar first would mean animating a fiction. This ordering is not a preference; it is an
existing rule applied to a fact one arm went and checked.

### 7. Not authorized

Frameworks; hypermedia libraries as the default; hydration; client routing or stores;
client rendering of business data; executable client validation; tenant-authored client
code; component-emitting compiler output; script-created interactive elements; any second
script.

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
