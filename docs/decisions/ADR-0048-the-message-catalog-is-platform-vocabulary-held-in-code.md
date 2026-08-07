# ADR-0048: The message catalog is platform vocabulary held in code, not a compiled projection

Date: 2026-08-06
Status: accepted — ruled by the orchestrator on `U6-design`'s read-only design pass,
whose central findings were verified against `main` at `018f03d` before ruling.
Tier: Behavioral (it decides where user-facing copy lives and what proves it reached the user)

## Context

**The premise this packet was chartered on was out of date, and correcting it
reorganises everything else.** `current-plan.md` said *"today the user-facing text
of a failure is the machine code itself."* It is not. Two hand-written copy tables
already exist on `main` — `component-registry.ts:866-904` for seven `QUERY_*`
codes and `surface-runtime.ts:720-753` for five `OPERATION_*` codes — and both
already use the exact `const copy = {...} as const` shape M3 asks for. **12 of 27
user-facing codes are registered.** U6 is not building a mechanism from nothing;
it is finishing a half-built one, and the missing half is everything outside those
two tables.

Two opposite failure shapes are live:

- **Six codes, one sentence.** The whole `SurfaceProjectionError` family renders
  a single shared string.
- **One code, two sentences.** `QUERY_UNSUPPORTED` is registered at
  `component-registry.ts:897` as *"Capability unavailable / The pinned release
  does not provide this semantic data capability"* and rendered at
  `surface-runtime.ts:112` as *"Compiled surface unavailable / The selected
  surface does not have a valid pinned semantic binding."* Both ship. Verified.

## Decision

### 1. The catalog is held in code and pinned, not compiled into a projection

**Every one of the 27 codes is platform-raised and application-independent.** Not
one is derivable from a `NormalizedApplicationPackage`; `schemas.ts` has no field
for a message; `emptyDataPanel()` and `feedbackHtml()` each carry one global
sentence for the entire application.

[ADR-0041](ADR-0041-declared-shapes-must-be-honoured-or-refused.md) §3 governs
this directly — *"a refusal to ship a spelling ahead of its meaning."* Compiling a
constant into a content-addressed artifact buys a moved release root and nothing
else, and [ADR-0047](ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md)'s
Consequences record that the profile axis is consumed **one version per adoption**
(corrected 2026-08-06 by `U5-design`'s measurement; this ADR's conclusion is
unaffected, since its load-bearing reason is that no message code is derivable
from a `NormalizedApplicationPackage`). Spending a semantic-profile version and a lineage entry on a projection
no authored package populates is the worst available use of a scarce append-only
axis.

The precedent is already in this repository: `COMPILER_DIAGNOSTIC_COPY`
(`packages/compiler/src/diagnostics.ts:7`) holds 39 codes as a frozen constant
with `CompilerDiagnosticCode = keyof typeof …` at `:205`, and is never projected.

**A sixth request-runtime projection family is rejected on measured cost**, not on
permission: it costs a Freeze F protocol change, two artifacts per release, a
`freeze-b.test.ts` pin move from 19 to 21 artifacts, runtime and provider reader
changes, and nine test files that construct the five-family view — to deliver a
payload the same reader loads for the same consumer at the same moment.

**The reserved carrier is recorded so the next packet does not relitigate it.**
When a module first authors entity-specific copy, it rides `surfaceManifestPayload`
at a new payload version gated on `compilerSemanticProfileVersion`. The precedent
is `navigation`, an application-wide fact already riding that payload as a sibling
of `surfaces` — [ADR-0030](ADR-0030-compiled-navigation-grouping.md) ruled it a
compiled surface-manifest concept rather than a web-only heuristic and put it
exactly there.

**Consequence, and the practical payoff: `U6` never touches the projection axis,
so it is independent of `U5-design`'s `v2` measurement under either outcome.**

### 2. The catalog is the authority; the code type derives from it

*"Derived from the diagnostics the runtime actually raises"* is not mechanically
available: `packages/runtime` has no codes, only 26 exported `Error` subclasses,
and the class-to-code translation happens entirely in `apps/web`. The ERP compiler
never sees `surface-runtime.ts`, so *"an unregistered code fails compilation"*
means `tsc`.

    export type SurfaceMessageCode = keyof typeof SURFACE_MESSAGE_CATALOG;

Under `keyof typeof` an unregistered code is not a compile error — it is
**inexpressible**, which is strictly stronger than the current `copy[code]` shape.

**The two directions are not symmetric, and only one is closed by construction.**

- *Raised but not registered* — closed for codes, **open for error classes.**
  `surface-runtime.ts:212-214` ends in an untyped `: 'QUERY_UNAVAILABLE'`, into
  which four of seven exported query-gateway error classes plus
  `SharedListContractError` and `InvalidResolveByNameContractError` silently
  collapse. **Make the error-class → code mapping exhaustive over a declared
  union**, so a new gateway error is a compile error rather than a silent
  demotion to "Data unavailable."
- *Registered but never raised* — closed by neither. This is AGENTS.md §6's
  subject-absent vector, and the catalog owes a **reachability observation**: every
  entry must be produced by at least one code path, the same obligation
  `test/architecture/test-reachability.test.ts` already discharges for test files.

### 3. There is no `severity` field

§3.8's column is not a severity vocabulary. Its four rows are *Field-level ·
Slot-level · Non-critical, transient · Important, blocking* — the first two name a
**scope**, the last two a **consequence**. Registering it verbatim would coin a
word that collides with `statusRoles` while not naming a single fact.

- **`consequence`: `advisory` | `blocking`** — does the user's work stop? Two
  values, because that is what remains once scope is removed.
- **`statusRole`** — the existing pinned four, reused verbatim. `blocking` →
  `blocked`, `advisory` → `attention`, success confirmation → `success`. **No new
  hue, no change to the pinned `statusRoles` array.**

This follows the rule the `ux-grammar` skill already set for U4's slot states:
*"Resolution state is not status… where a resolution state renders colour it
resolves through the existing status roles."* A message severity stands in the
identical relation. **`U5`'s latency class is the structurally identical question
and must receive the same answer shape** — name the fact by what it is and let
colour resolve through the pinned four. Two authorities on one word is the failure
mode both packets are avoiding.

### 4. Placement is `page | slot`, derived from the raise site, and `toast`/`modal` are refused by name

**Placement is a property of the pair, not the message.** `QUERY_UNSUPPORTED`
renders page-level at `surface-runtime.ts:113` and slot-level through
`dataDiagnostic` at `component-registry.ts:99` — one code, two placements, both
correct. It is not a property of the surface either, since one surface renders
both in a single request.

It is a fact of **where the fault arose relative to slot composition**, and the
`ux-grammar` skill already names the discriminator: faults arising *before* slot
composition stay whole-page. So a catalog entry declares which placements are
**admissible** for it; the runtime picks by where the fault occurred. Slot
placement anchors on U4's existing `slotResolutionState()`
(`component-registry.ts:294`), which already computes and emits the fact.

**`toast` and `modal` are refused by name with a diagnostic**, per ADR-0041 §2's
never-coerced rule, and what each would need is recorded here so the refusal is a
declared limit rather than an omission:

| Spelling | Why refused | What would admit it |
|---|---|---|
| `toast` | Zero occurrences outside prose. [ADR-0036](ADR-0036-minimum-client-capability.md) §2 authorises exactly four client behaviours and a toast is none; §7 lists script-created interactive elements as unauthorised. §3.8 also requires a toast be recorded durably, and no durable UI-failure record exists. | An ADR-0036 amendment **and** a durable-record substrate |
| `modal` | §3.8 requires it carry a specific rectifying action; no request-access capability exists. Without script it is a navigation, and the page-level refusal already is the blocking treatment. | A rectifying-action capability |

Registering either now would be **accepted-and-ignored** — ADR-0041's named worst
state, *"indistinguishable from success at every point where anyone would look."*

### 5. The gate observes rendered text, and its code census comes from the catalog

The missing gate is not hypothetical. On `main` at `018f03d`: compilation passes,
`QUERY_UNSUPPORTED` is registered with one sentence and rendered with another, and
`apps/web/test/browser/surface-data-binding.spec.ts:364` drives that exact path in
a live browser and asserts only
`[data-diagnostic-code="QUERY_UNSUPPORTED"]` **is visible** — never the text. Six
more codes share one sentence through the same hole. Nothing catches it:
`checkUxGrammarPin` compares archetypes, roles, slots and components;
`surface-grammar-conformance` covers geometry, contrast and target size; and
`determinism.test.ts:100` has the right shape but reads the compiler's source.

**The gate:** in the shadow browser, for every code the catalog can produce, read
the rendered `textContent` and assert it equals the catalog's sentence. The DOM
text is the produced effect; the attribute is the declaration.

**The census must come from `keyof typeof SURFACE_MESSAGE_CATALOG`, never from the
pages a fixture happened to render.** That is ADR-0035 §2.2's generative error
stated as a rule: *a conformance claim must be derived from the consumers,
enumerated from source, not from the list the test happens to check.*

One recorded red per vacuity vector, not one overall: no diagnostic rendered → red
on zero observed; catalog stubbed empty → red; **the live tree above** — correct
attribute, wrong sentence; diagnostic rendered without the attribute → red rather
than silently skipped; a registered entry no path can produce → red; and the gate
must obtain its expected string independently, never by calling the renderer under
test.

A cheap structural companion: no diagnostic-rendering function accepts a string
literal — they take a `SurfaceMessageCode` and nothing else.

## What this ADR does not decide

- **Whether an entry is a fixed sentence or a parameterised template.** §3.9's
  filtered-to-empty case forces the question and the runtime has the filter
  values, but whether a template with holes is still "a registered sentence" is a
  copy-architecture judgement, not a fact in the code. `U6-design` proposed closed
  per-code parameter sets so an unfilled hole is a compile error; that is a
  proposal and the implementing packet must settle it.
- **Whether all 27 codes are reachable from a shadow-browser fixture.** Six
  page-level codes are raised from paths the design pass could read but not
  exercise. `U6a` must measure this and **declare a shortfall if the gate cannot
  be 27-of-27.**
- **`expectedDiagnosticCode`** (`schemas.ts:1015`), a second unregistered code
  space checked against no registry. Named here so it is not lost; out of U6's
  scope.
