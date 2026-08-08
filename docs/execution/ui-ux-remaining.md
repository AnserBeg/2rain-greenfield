# UI/UX — what is left, and the wait model that governs it

**Status: open charter. Written 2026-08-08 so the work can be picked up cold.**

Read `AGENTS.md`, then the plan, then the ADRs cited here — this document
charters work and records one correction; it does not override a ruling. Where it
corrects a ruling, that ruling has been amended and is cited by section.

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
amendment**, and it degrades correctly with JavaScript disabled (ADR-0036 §4). It
fits `U4`'s per-slot state machine exactly: a slot is `pending` until its chunk
arrives, which is what streaming already means. **Covers causes (1), (2), (3).**

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
end"* — is **absorbed by `wait-measure` below.** Once the whole-response wait is
measured rather than the query, the trigger fires on its own evidence instead of
waiting for someone to remember to look.

---

## 3. The remaining work

### 3a. New rows from §2

| Row | What it adds | Size |
|---|---|---|
| **`wait-measure`** | Extend `U1`'s classifier from query execution to the **whole server response**, per surface path, and record time to first byte where the client can report it. Reuse `U1`'s shape — the closed twelve-series counter and the *graded total equals invocation count* gate that earned its acceptance. **Absorbs `ladder-trigger`.** | ~1 day |
| **`wait-escalate`** | The escalation ladder of §2.2 in the runtime, driven by elapsed time with no prediction: pending → skeleton → indicator-with-context → determinate-or-handoff, one direction only, with the §2.3 floor and hold. **Depends on the §2.5 route being chosen.** | ~1–2 days |
| **`skeleton-route`** | Design pass settling streamed SSR versus the client-script amendment, against `wait-measure`'s numbers. Output is an ADR. **Do not implement skeletons before this row rules.** | ~half day |

### 3b. A person notices

| Row | What it adds | Size |
|---|---|---|
| **`U6b`** | Today there is **one sentence** for every empty screen in the application and **one template** for every success message. A search that matched nothing, a filter that excluded everything, and a brand-new tenant with no records all read identically. `U6b` gives each its own, registers `page` and `slot` placement, refuses `toast` and `modal` by name with a diagnostic, and wires slot placement to `U4`'s existing `slotResolutionState()`. **Charter correction on record: it is *not* covered by `U6a`'s gate "by construction"** — `feedbackHtml()` and `emptyDataPanel()` never call `messageAttributes()`, so it owes real-path observations of the actual success and empty renderers. | ~1 day |
| **`U2-num`** | Numeric right-alignment in tables. Small; in an ERP it is the difference between a column you can scan and one you cannot. | ~half day |
| **`U7`** | Forms: chunk fields above ~10 (authority is Hick, not Miller), validate inline on blur, and make the submit control visually de-emphasised but **focusable and operable**, moving focus to the first incomplete field — a hard-`disabled` button would violate the plan's own WCAG 2.2 AA claim. Plus Postel input normalisation for phone, quantity, dates and scanner affixes, and declared-source pre-fill. Unblocked by `U6a`. | ~1.5 days |
| **`msg-code-accuracy`** | Six gateway error mappings carry the wrong code and one code is reachable from no path under its own name. Mostly invisible, but it changes what a few failures say. Separate packet because fixing it moves `data-diagnostic-code` values that existing browser assertions pin. | ~half day |

### 3c. Only a gate notices

| Row | What it adds | Size |
|---|---|---|
| **`U9`** | **The largest remaining row, and the one that costs most to defer.** The accumulated "proved by proxy, not by observation" list from three packets: gates that read declared or computed CSS instead of painted pixels; a dark-mode predicate that passes on a white ground with dark ink; a colour parser that fabricates RGB from `oklch()`; a focus-ring check that survives `opacity:0`; a reachable hidden state that is logged and never asserted. Carries a **binding acceptance criterion — every `FOCUS_RING_*` branch ships an executed red**, four of five still outstanding. Also carries `U6a`'s perceptibility residue, where several cases the reviewer called impossible are in fact directly inspectable. Changes no pixel. It is the difference between the visual system being correct and being *believed* correct. | ~2 days |
| **`shimmer-trajectory`** | The sheen must begin fully left and travel past the right edge; the current gate reads only animation name, duration and timing function, so a `-20% → 20%` keyframe passes. Observable **today** without any skeleton rendering — pause via `getAnimations()` and read the `::after` transform at t=0 and t=duration. | small |
| **`op-latency`** | Instrument `SemanticOperationGateway` against the ladder's upper bands. Becomes urgent the moment `wait-escalate` lands, because that is what consumes the measurement. | ~half day |
| **`rollback-release-edge`** | ADR-0047 §6's negative direction, declared-unobserved. Compiler plumbing. | small |
| **`lock-owner`, `matrix-contention`** | Both being closed by the in-flight `lock-obs` packet. | in flight |

### 3d. Chartered but blocked, or explicitly not its own slot

- **`U8`** — conventions register and citation corrections. **Rides any packet
  already amending the grammar; never takes a slot alone.**
- **`U6c`** — compiled per-surface copy. **Not chartered** until a module actually
  authors a message (ADR-0048 §1, on ADR-0041 §3's refusal to ship a spelling
  ahead of its meaning).
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
   also retires `ladder-trigger`, which is currently a permanent decision wearing a
   temporary label.
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
authorised client behaviours as a **closed** set; the message catalog living in
code rather than a compiled projection (ADR-0048 §1); `toast` and `modal` refused
by name with what would admit each recorded (§4).

**Open, and yours to decide with evidence:** the §2.5 route; the §2.3 floor and
hold values; whether client hints earn a place in the entry estimate; and whether
the transit-bound causes justify an ADR-0036 amendment.

**The standing trap this document exists to close:** a measurement that covers one
segment of a wait, quoted as though it covered the wait. It survived on disk for
two days inside a ruling that read as settled.
