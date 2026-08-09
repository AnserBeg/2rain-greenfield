# ADR-0051: The write path addresses an operation, not an intent

Date: 2026-08-08
Status: accepted — ruled by the orchestrator on `pur1-intent-limit`'s measurement.
Tier: Critical (it changes what a browser may name, and every surface depends on it)

## Context

A surface's write path carried `name="intent"` and nothing else.
`surface-runtime.ts:228` stated the rule in its own header — *"Resolves a browser
intent to one pinned operation; no operation ID is accepted"* — `:244` implemented
it as `binding.operations.find((c) => c.intent === intent)`, and
`test/architecture/surface-data-binding.test.ts:32` pinned it executably with
`assert.doesNotMatch(joined, /submission\.operationId/)`.

`byIntent`'s one-per-intent uniqueness is what made `intent → operation` a
function. **So the constraint was dispatch, not rendering** — the rendering side is
real but secondary.

**And it is fatal rather than partial.** A binding carrying two `command`
operations throws, and `surface-runtime.ts:113` renders a page-level 422. A
purchase order declaring both a release and a cancel would have had **no record
screen at all**, not a screen missing a button. The queue row understated this.

## Decision

### 1. The addressing unit of the write path is the operation

The posted field names an operation id. **The reachable set is unchanged** — still
`binding.operations`, and an id outside it is refused. What moved is **selection
within an already-authorized set**, from the server's sort order to the pressed
control.

**The measured refutation of the obvious alternative.** Re-keying `byIntent` by
operation id *without* moving the wire leaves the runtime resolving by intent: two
buttons both post `intent=command`, `find` returns whichever sorts first, and
**pressing Cancel releases the order.** That was executed, not reasoned.

Distinct intents per transition were rejected on **derivability**, not cost:
`operationIntent()` maps effect kinds, release and cancel are the same kind, and
`SurfaceOperationIntent` is a closed platform vocabulary in four places. Growing it
per module-authored transition inverts the `ux-grammar` rule that platform
vocabularies are closed.

### 2. The property the old pin was protecting, stated for the first time

> **The compiled binding is the sole authority for what is reachable. The client
> selects within an already-authorized set and can never name anything outside it.**

That was never written down. `assert.doesNotMatch(/submission\.operationId/)`
asserted a **sufficient** condition — *no id on the wire* — for a **necessary**
property — *no unauthorized operation reachable*. It held the property by forbidding
the only mechanism anyone had tried.

**This is the `lease-derivation` shape, one gate over:** a guard asserting a
necessary condition where its name claims the sufficient one, or the reverse. A
sufficient condition that stops being necessary is invisible until something
legitimate needs the forbidden mechanism.

**So the pin narrows to the property:** every read of the posted id must be the
binding lookup, and the gateway receives the **resolved** id. That is checkable, it
is what actually matters, and it admits the legitimate case the old pin refused.

### 3. Only `command` admits many, and the refusal stays named

`create`/`update` render one Save button; `archive`/`restore` render one lifecycle
button chosen by `record.archived`. **Both still throw `INVALID_SURFACE_BINDING` on
a second operation.** Only `command` renders a named control per operation, so only
`command` may carry several. A limit that quietly becomes permissive is worse than
the limit.

## What this does not decide

**Ordering.** Commands now sort by operation id, which renders **Cancel before
Release** — backwards against `ux-grammar` §3's primary-first rule.
`operationDefinition` carries no `orderKey`, so there is no carrier to sort by.
That needs a carrier decision **and** a `ux-grammar` ruling, and inventing one
inside this packet is how a second authority gets created. Routed to
`surface-command-order`.
