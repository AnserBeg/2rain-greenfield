# UI/UX — what is left, and the wait model that governs it

**Status: open charter. Written 2026-08-08 so the work can be picked up cold.**

Read `AGENTS.md`, then the plan, then the ADRs cited here — this document
charters work and records corrections; it does not override a ruling. Where it
corrects a ruling, that ruling has been amended and is cited by section.

**§6 carries the adjudicated 2026-08-08 doctrine review** — nine findings upheld,
two refuted, each with where it landed. Read it before re-opening anything in §2
or §5.

Companion rows live in [current-plan.md](current-plan.md) (U0–U9 and the
follow-ups). This file exists because those rows are spread across a queue built
for a different question, and a session picking this up in a week should not have
to reassemble them.

---

## 1. State of play

**The visual phase is banked.** Phase 1's stated outcome — *"the app looks like the
mockup"* — landed. Accepted: `U0` (hex-literal ratchet), `U1` (feedback ladder and
latency measurement), `U2` plus its two corrective packets (token layer, motion
contract, focus rings), `U3` (ruled as ADR-0036), `U4` (per-slot state machine and
fault isolation), `U6a` (all 27 message codes resolve through one catalog),
`proj-disc` / `proj-disc-impl` (the projection discriminator, which unblocked the
compiler half of the UX set).

**In flight at the time of writing:** `U5b` (compiled disclosure tier — revision
round 1 complete, matrix running) and `lock-obs` (test-lock observability —
revision round 2 complete, review arm pending). Neither is UI-visible; both should
finish rather than be abandoned, because their review arms are already spent.

**What remains is not how the app looks when things work.** It is what it says
when there is nothing to show, when something succeeds, when someone fills in a
form — and, per §2 below, what it shows while a person is waiting.

---

## 2. The correction: the wait is not the server's work

**This section is the reason the document exists. Everything in §3 is ordinary
queue; this is a fact that was wrong on disk.**

[ADR-0032](../decisions/ADR-0032-feedback-ladder-and-loading-states.md) §1 defines
a six-band ladder whose bands are **about what a person waits for**. §2a then
deferred skeleton geometry as *"not chartered"* on two legs. Both legs assume the
wait *is* the server's compute time, and both fail once the rest of the wait is
counted.

**Leg 1 — "a server-rendered response has no moment in which a skeleton
exists."** True of server compute. False of the whole wait. Between the click and
the painted page sit DNS and TLS on a first visit, request transit, server render,
**response transit**, parse and paint. On a slow or congested link the response
transit dominates every other term, and during it the person is looking at the old
page or at nothing. That is a moment, it exists on every navigation, and it is
precisely the 1–3 s band.

**Leg 2 — "`U1` measured 20 of 20 reads in `under_100ms`."** That counter is
recorded at `packages/postgres-provider/src/composed-application-runtime.ts:718`,
around **registered query execution against Postgres**. It is the innermost
segment of the wait. It is strong evidence that the database is fast and no
evidence at all about the ladder's bands.

**So the app can be fast and the wait can still be two and a half seconds.** The
ladder must be driven by an estimate of the *user's* wait, and escalated by the
*actual* elapsed time — never by server timing alone. ADR-0032 now carries this as
**§2b**.

### 2.1 A wait is slow for six reasons, and we measure one

1. The registered query is slow. — **measured**
2. Server render of the composed surface is slow. — unmeasured
3. The response payload is large. — unmeasured
4. **The user's connection is slow, congested, or high-latency.** — unmeasured,
   and in the field the most common cause by a wide margin
5. The user's device is slow to parse and paint. — unmeasured
6. Cold start: first visit, no cache, DNS and TLS handshakes. — unmeasured

A treatment chosen from (1) alone is chosen from the smallest term in the sum. Any
design that reasons about "our app being slow" and stops there will show nothing to
exactly the users who wait longest.

### 2.2 The treatment escalates with the actual wait — it is not chosen once

ADR-0032 §1 reads as a lookup table: predict a duration, pick a treatment. That is
not sufficient, and the ruling is now explicit — **a single wait may pass through
several treatments, and it moves in one direction only.**

Within one wait:

| Elapsed | Treatment |
|---|---|
| 0 – 400 ms | Nothing. Render. |
| 400 ms – 1 s | Inline pending state on the pressed control only. |
| 1 s – 3 s | **Skeleton** — page or slot. Inline loader for a small local task. |
| 3 s – 10 s | Indeterminate indicator **with context**: name what is running. No progress bar. |
| > 10 s | **Switch to a loader**: determinate progress where the total is knowable, indeterminate with step and elapsed text where it is not. **Plus cancel or background-handoff.** |

**Never de-escalate.** Skeleton → indicator → progress is a story the user can
follow. The reverse is a flicker, and it reads as a fault.

**The `> 10 s` row is the ladder, not the buildable scope.** Every treatment in it
is a fact about an operation nothing in this repository produces — units
completed, a step name, cancellation, a destination for a handed-off operation.
`wait-escalate` therefore implements up to `3 s – 10 s` and declares the shortfall;
`op-handoff-substrate` (§3c) carries the rest with a trigger that can actually
fire. Ruled in ADR-0032 §3a, 2026-08-08.

**The escalation half needs no prediction.** It runs on a clock against the actual
elapsed time. Prediction only buys the *entry* treatment — whether to open at
"nothing" or open directly at a skeleton. So the cheapest correct implementation
predicts nothing at all and escalates on elapsed time; prediction is a refinement
layered on afterwards, not a prerequisite. **Build it in that order.**

### 2.3 Anti-flicker is part of the contract, not polish

A skeleton painted for 80 ms is worse than no skeleton — it reads as a glitch. Two
rules, both of which need measuring rather than guessing:

- **Do not paint before a floor** of actual waiting (start from ~200–300 ms).
- **Once painted, hold for a minimum** (start from ~300–500 ms) so a response
  arriving just after the floor does not produce a flash.

These numbers are starting points from the general literature. Measure them
against a real slow path before pinning them in an ADR.

### 2.4 Where an entry-treatment estimate could come from

Named here so a later session does not invent a mechanism from scratch. None is
authoritative alone:

- **Server-side whole-response time**, p50 and p95, per surface path — the honest
  extension of `U1`'s counter, which today stops at query execution.
- **Time to first byte of this client's previous navigation** — the only signal
  that reflects the user's actual link.
- **Client hints**: `Save-Data`, and `Downlink` / `ECT` via the Network
  Information API or `Sec-CH-*` headers. Advisory; support is uneven and values
  are coarse.
- **Compiled payload size** for the surface, which the compiler already knows.

Treat client hints as advisory input to the entry treatment only. The reliable
half is the clock.

### 2.5 The mechanism question ADR-0032 §2a left open, and the recommendation

§2a named the choice and did not make it: **streamed SSR versus a widened client
script.** Both are still live, and the honest position is that neither covers
every cause in §2.1.

**Streamed SSR** — flush the document shell with skeletons immediately, then
stream each slot as its data resolves. Needs no client script, so **no ADR-0036
amendment**, and it degrades correctly with JavaScript disabled (ADR-0036 §4).
**Covers causes (1), (2), (3).**

> **Corrected 2026-08-08 — it does *not* fit `U4`'s state machine "exactly", and
> the correction is not cosmetic.** This paragraph said a streamed slot is
> `pending` until its chunk arrives. `U4`'s `pending` is
> `data.status === 'UNBOUND'` (`apps/web/src/component-registry.ts:298`) — *no
> binding exists* — which ADR-0032 §2a ruled is a structural fact, and which the
> `ux-grammar` skill says explicitly *"does not authorize a default loading
> treatment"*. A streamed slot is the opposite on all three counts: bound,
> temporal, and painting a skeleton. Reusing the spelling would make
> `data-slot-state="pending"` mean two incompatible things in one document and
> would silently repeal the skill's own guard. **A streamed slot is a new member
> of `U4`'s closed set, and naming it is part of `skeleton-route`'s output.**

**Widened client script** — intercept navigation and paint a skeleton before the
new document arrives. Requires an **ADR-0036 amendment**: its four authorised
behaviours are pending-state toggling, polling one operation-status resource,
compiled optimistic transitions, and advisory inline validation. A skeleton swap
is none of them, and §7 lists script-created interactive elements as unauthorised.
**Covers causes (4) and (6)** — the ones streaming cannot touch, because if the
link is slow the shell arrives slowly too.

**Recommendation: streamed SSR first**, because it needs no capability amendment,
it puts the skeleton where composition already lives, and it is reversible. Then
measure whether the transit-bound cases still hurt; if they do, the client-script
amendment is argued against real numbers rather than in advance, which is what
ADR-0032 §2a asked for in the first place.

### 2.6 What this replaces in the queue

`ladder-trigger` — the open row noting that the skeleton deferral *"has no way to
end"* — is **absorbed by `wait-measure` below for the server-caused half of the
wait, and only that half.**

**Corrected 2026-08-08, and this is the same defect this document was written to
close, one step out.** §2 says the ladder is about the interval from the person's
action to the painted result. `wait-measure` observes the **whole server
response** — wider than query execution, still not that interval. It omits request
transit, body transfer, parse and paint; time to first byte stops before the same
three; and a streamed shell cannot start a user-visible clock during the interval
before the shell arrives. So the trigger fires on its own evidence for causes
(1)–(3) and **cannot** fire for (4) the user's connection or (6) cold start — the
two §2.1 calls the largest in the field.

Two consequences, both binding:

- **`wait-measure` states what it cannot observe** (AGENTS.md §6), so its counter
  is never read as coverage of the wait. A row of six causes with four unmeasured
  is the honest report.
- **Client-observed timing is an ADR-0036 question, not instrumentation.** First
  byte, parse and paint reach the browser only through the Navigation Timing API,
  which needs script; ADR-0036 §2's four behaviours do not include measurement,
  and §7 now names client-side timing collection as unauthorised. Wanting the real
  number is a good reason to amend that ADR under its §2a test — and not a reason
  to slip a beacon in as tooling.

Ruled in ADR-0032 §2c.

---

## 3. The remaining work

### 3a. New rows from §2

| Row | What it adds | Size |
|---|---|---|
| **`wait-measure`** | Extend `U1`'s classifier from query execution to the **whole server response**, per surface path, measured server-side. Reuse `U1`'s shape — the closed twelve-series counter and the *graded total equals invocation count* gate that earned its acceptance. **Must declare what it cannot observe** (§2.6): request transit, body transfer, parse, paint, DNS/TLS — i.e. causes (4) and (6) stay unmeasured, and the packet record says so in those words. **No client-side timing**; that is an ADR-0036 §2a amendment, not instrumentation. **Absorbs `ladder-trigger` for causes (1)–(3) only.** | ~1 day |
| **`skeleton-route`** | Design pass settling streamed SSR versus the client-script amendment, against `wait-measure`'s numbers *and* against what those numbers cannot see. Output is an ADR, and it owes two things beyond the route: **(a)** the name and semantics of the new `U4` slot state for a bound-but-in-flight slot — `pending` may not be reused (§2.5); **(b)** whether the unmeasured transit-bound half justifies an ADR-0036 amendment for client-observed timing, argued under that ADR's §2a test. **Do not implement skeletons before this row rules.** | ~half day |
| **`wait-escalate`** | The escalation ladder of §2.2 in the runtime, driven by elapsed time with no prediction: pending → skeleton → indicator-with-context, one direction only, with the §2.3 floor and hold. **Stops at the `3 s – 10 s` band and declares the shortfall** — the `> 10 s` treatments need units-completed, a step name, cancellation and a handoff destination, none of which exists (`op-handoff-substrate`, §3c). Above 10 s it renders the 3–10 s treatment and records that as a declared limit, per ADR-0032 §3a. **Depends on the §2.5 route being chosen.** | ~1–2 days |

### 3b. A person notices

| Row | What it adds | Size |
|---|---|---|
| **`U6b`** | Today there is **one sentence** for every empty screen in the application and **one template** for every success message. A search that matched nothing, a filter that excluded everything, and a brand-new tenant with no records all read identically. `U6b` gives each its own, registers `page` and `slot` placement, refuses `toast` and `modal` by name with a diagnostic, and wires slot placement to `U4`'s existing `slotResolutionState()`. **Charter correction on record: it is *not* covered by `U6a`'s gate "by construction"** — `feedbackHtml()` and `emptyDataPanel()` never call `messageAttributes()`, so it owes real-path observations of the actual success and empty renderers. | ~1 day |
| **`U2-num`** | Numeric right-alignment in tables. Small; in an ERP it is the difference between a column you can scan and one you cannot. | ~half day |
| **`U7`** | Forms: chunk fields above ~10 (authority is Hick, not Miller), validate inline on blur, and make the submit control visually de-emphasised but **focusable and operable**, moving focus to the first incomplete field — a hard-`disabled` button would violate the plan's own WCAG 2.2 AA claim. Plus Postel input normalisation for phone, quantity, dates and scanner affixes, and declared-source pre-fill. Unblocked by `U6a`. **Two dependencies added 2026-08-08, both stop-and-bridge rather than blocking.** *(i)* **Message placement has no field anchor.** `MessagePlacement` is `page \| slot` (`apps/web/src/message-catalog.ts:42`) and a validation message anchored to one input is neither — it differs on focus movement and error association. `U7` owns the ruling (ADR-0048 §4a): add a field/control anchor, split placement from anchor, or rule validation a separate grammar. Do **not** route a field message through `slot` or around the catalog. *(ii)* **Pre-fill from "the principal's default legal entity" names a mechanism that does not exist** — ADR-0037 §4 records the declared-default mechanism as absent and ADR-0015:38 as its only admission. Either narrow the source list to sources that exist, or stop for a bridge request. Pre-filling a field is not the context bar selecting a scope, and neither may invent the mechanism. | ~1.5 days |
| **`msg-code-accuracy`** | Six gateway error mappings carry the wrong code and one code is reachable from no path under its own name. Mostly invisible, but it changes what a few failures say. Separate packet because fixing it moves `data-diagnostic-code` values that existing browser assertions pin. | ~half day |

### 3c. Only a gate notices

| Row | What it adds | Size |
|---|---|---|
| **`U9`** | **The largest remaining row, and the one that costs most to defer.** The accumulated "proved by proxy, not by observation" list from three packets: gates that read declared or computed CSS instead of painted pixels; a dark-mode predicate that passes on a white ground with dark ink; a colour parser that fabricates RGB from `oklch()`; a focus-ring check that survives `opacity:0`; a reachable hidden state that is logged and never asserted. Carries a **binding acceptance criterion — every `FOCUS_RING_*` branch ships an executed red**, four of five still outstanding. Also carries `U6a`'s perceptibility residue, where several cases the reviewer called impossible are in fact directly inspectable. Changes no pixel. It is the difference between the visual system being correct and being *believed* correct. | ~2 days |
| **`shimmer-trajectory`** | The sheen must begin fully left and travel past the right edge; the current gate reads only animation name, duration and timing function, so a `-20% → 20%` keyframe passes. Observable **today** without any skeleton rendering — pause via `getAnimations()` and read the `::after` transform at t=0 and t=duration. | small |
| **`op-latency`** | Instrument `SemanticOperationGateway` against the ladder's upper bands. Becomes urgent the moment `wait-escalate` lands, because that is what consumes the measurement. **It is also the trigger source for `op-handoff-substrate` below.** | ~half day |
| **`slot-fault-scope`** | Make the actual scope of `U4`'s fault isolation observable instead of implied. Today one `SurfaceDataRenderState` is computed per request (`apps/web/src/surface-runtime.ts:193-214`) and handed to every slot (`:339-349`), so all `ownsDataResolution` slots share a fate, while the isolation gate asserts only *one* failed data slot beside three non-data siblings (`apps/web/test/browser/surface-data-binding.spec.ts:259-283`). The cheapest broken tree that keeps that gate green is one where `record:sections` carries `data-slot-state="failed"` and renders blank or stale content inside it — the attribute is set by `slotResolutionState()`, not by the renderer, so the state can be right while the content is not. Assert both data-owning slots fail together **and** the non-data siblings render, so the doctrine's real claim is pinned by observation. Docs half is the `ux-grammar` ruling, already landed. | small |
| **`op-handoff-substrate`** | **BLOCKED, and now with a firing trigger instead of "when it exists".** ADR-0032 §1's `> 10 s` band requires units-completed, a step name, cancellation, and a durable destination for a handed-off operation; ADR-0036 §6 orders determinate progress last for exactly that reason and declines to design the substrate; `packages/runtime/src` contains no job concept at all. `wait-escalate` therefore ships the ladder up to `3 s – 10 s` with a declared shortfall. **Trigger: the first operation `op-latency` grades into `3s_10s` or `over_10s`.** That is an event a counter raises, not a memory someone has to keep. Output is a design pass and an ADR, not a UI packet — the substrate is platform work and is sized there. | blocked |
| **`rollback-release-edge`** | ADR-0047 §6's negative direction, declared-unobserved. Compiler plumbing. | small |
| **`lock-owner`, `matrix-contention`** | Both being closed by the in-flight `lock-obs` packet. | in flight |

### 3d. Chartered but blocked, or explicitly not its own slot

- **`U8`** — conventions register and citation corrections. **Rides any packet
  already amending the grammar; never takes a slot alone.**
- **`U6c`** — compiled per-surface copy. **Not chartered**, and the trigger is
  **corrected 2026-08-08**: it was *"until a module actually authors a message"*,
  which is an event the language cannot produce — `schemas.ts` has no message
  field, so there is no spelling in which a module could author one, and the
  deferral was waiting for something it had itself made impossible. The same shape
  as `ladder-trigger`. **What fires it: a chartered module needs entity-specific
  copy, finds it inexpressible, and stops with a bridge request** rather than
  hard-coding a sentence in a renderer or overloading a platform code. The carrier
  ADR-0048 §1 reserves is what that request is granted. ADR-0041 §3's refusal to
  ship a spelling ahead of its meaning is unchanged.
- **`U5b`'s v2 adoption obligation** — the compiler-semantic profile `v2` is cut
  and deliberately unadopted. Fields accumulate on it for free; adoption is a
  separate, schedulable event that mints exactly one lineage entry no matter how
  many fields accumulated first. The adoption packet owes the deferred
  `disclosureTier` declaration on a real slot (ADR-0047 §4a).

---

## 4. Recommended order

1. **Finish what is in flight** — `U5b`, `lock-obs`. Review arms are already spent.
2. **`U6b` + `U2-num`** — about a day and a half, and it closes the last two things
   a user encounters that are visibly unfinished.
3. **`wait-measure`** — cheap, and everything in §2 is guesswork without it. It
   retires the server-caused half of `ladder-trigger`, which is currently a
   permanent decision wearing a temporary label; the transit-bound half stays open
   by declaration rather than by oversight (§2.6).
4. **`skeleton-route`** design pass, then **`wait-escalate`**.
5. **`U7`**, which pairs naturally with inventory form work.
6. **`U9`**, whenever there is a slot that is not competing with inventory. It does
   not block anything; it only accumulates.

`op-latency` follows `wait-escalate`. `shimmer-trajectory` rides `U9` or takes a
small slot. `U8` rides whatever is already amending the grammar.

---

## 5. For the next session

**Settled — do not re-litigate:** the ladder's six bands and their lower-inclusive
boundaries (ADR-0032 §1); loading treatments as an exception path rather than a
default (§2); the closed optimistic allow-list (§4); success states weighted with
full-page almost always wrong (§5); the 400 ms query budget (§7); ADR-0036's four
authorised client behaviours as a set closed over **this script's domain**
(ADR-0036 §2a — the platform-wide reading did not survive; camera scanning and the
PWA service worker are separate domains with their own decisions); the message
catalog living in code rather than a compiled projection (ADR-0048 §1); `toast` and
`modal` refused by name with what would admit each recorded (§4), and the
"semantics-preserving fallback" alternative considered and refused (ADR-0048 §4).

**Open, and yours to decide with evidence:** the §2.5 route; the name of the new
slot state a streamed slot needs; the §2.3 floor and hold values; whether client
hints earn a place in the entry estimate; whether the transit-bound causes justify
an ADR-0036 §2a amendment for client-observed timing; and `U7`'s two bridge
questions (field placement anchor, declared-default pre-fill).

**The standing trap this document exists to close:** a measurement that covers one
segment of a wait, quoted as though it covered the wait. It survived on disk for
two days inside a ruling that read as settled — and §2.6 shows the first
replacement for it reproduced the same shape one step wider.

---

## 6. The 2026-08-08 doctrine review, adjudicated

A second session reviewed the whole UI/UX authority set for one defect shape:
**a ruling whose load-bearing term means something narrower in its evidence than
in the rule it justifies.** Eleven findings, adjudicated against the tree. Nine
upheld in whole or in part, two refuted. Recorded here so neither the upheld ones
are re-derived nor the refuted ones re-raised.

| # | Term | Verdict | Where it landed |
|---|---|---|---|
| F1 | `pending` | **Upheld** — structural (`UNBOUND`), temporal (in flight), and interaction-pending are three facts under one spelling; §2.5 claimed streamed SSR "fits exactly" | ADR-0032 §2c; `ux-grammar` slot states; §2.5 above; `skeleton-route` owes the name |
| F2 | "the whole wait" | **Upheld, and it was our own correction that reproduced it** — `wait-measure` measures the whole *server response*, not action-to-paint | ADR-0032 §2c; §2.6 and the `wait-measure` row above |
| F3 | `slot` | **Upheld with different evidence** — one `SurfaceDataRenderState` per request is shared by every slot, so the resolution unit is the data binding and the slot is where the state renders | `ux-grammar` slot states; proposal M2 correction; new `slot-fault-scope` row |
| F4 | `onDemand` | **Split: doctrine upheld, code refuted** — the skill described a tier nothing can honour, but `U5b` already refuses `onDemand` by name at normalization, including on forcing slots. The skill now says so, and the hard rule is restated over every tier ≠ `always` | `ux-grammar` disclosure tiers |
| F5 | "minimum client capability" | **Upheld** — the four behaviours were enumerated from the live residue while the ADR concedes camera scanning and the PWA need client JS at launch (plan lines 1690, 1711) | ADR-0036 §2a: scoped to this script's domain, plus an amendment test |
| F6 | `placement` | **Upheld** — `page \| slot` cannot express field-anchored validation, which §3.8, ADR-0036 §2.4 and `U7` all already require | ADR-0048 §4a; `ux-grammar` message vocabulary; `U7` row. No `field` spelling coined |
| F7 | "once a substrate exists" | **Upheld** — nothing in the plan creates the async job substrate the `> 10 s` band displays | ADR-0032 §3a; `wait-escalate` stops at 10 s and declares it; new `op-handoff-substrate` row with a counter-raised trigger |
| F8 | "honoured / refused" | **Refuted** — see below | ADR-0048 §4, recorded as considered-and-refused |
| F9 | "geometry" | **Upheld** — structural fidelity is compiler-provable, rendered fidelity is sampled, and one paragraph claimed both | ADR-0032 §2c and Consequences; proposal M1 correction |
| F10 | "selection" / "default" | **Upheld in part** — the legal-entity ruling survives; the universal "never selects" reason does not, and `U7`'s pre-fill depends on the mechanism ADR-0037 §4 records as absent | ADR-0037 §4; `ux-grammar` shell contract; `U7` row |
| F11 | "authors" | **Upheld** — `U6c` waited on an event the language cannot produce | ADR-0048 §1; §3d above |

**F8 is the one to read if you are tempted to re-open it.** It argued that
ADR-0041's binary comes from a storage example — a `oneToOne` silently lowered as
an ordinary foreign key — and that presentation has a third state the storage case
lacks: an explicit, observable, semantics-preserving fallback, such as admitting
`toast` and rendering a durable inline notice. Refused on three checks: the
user-facing meaning of every refused code is *already* honoured page- or
slot-level, so the refusal costs the user nothing; the proposed fallback needs the
same absent durable-record substrate that blocks `toast` in the first place; and
retaining a declaration while changing its effect is the accepted-and-ignored shape
one indirection further out. What the finding did earn is a sharper statement of
what "honoured" means — the promised **user-visible effect**, not a byte-for-byte
modality — and that is now in ADR-0048 §4.

**The second refutation is inside F4.** The reviewer read the skill and concluded
`onDemand` was admitted with no mechanism and no refusal. Half right: the in-flight
`U5b` lane refuses it at normalization with that exact reason in the diagnostic,
and refuses it on forcing slots too, which closes the "escapes the hard rule" half
of the finding outright. Reading the branch, not just the doctrine, is what
separated the two halves.
