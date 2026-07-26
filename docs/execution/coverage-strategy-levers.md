# Closing the last 20%: the coverage levers

Status: strategy analysis, not authority. Nothing here overrides the plan or an accepted
ADR. Obligations extracted from it are tracked in
[`doctrine-coverage.md`](doctrine-coverage.md); this document holds the reasoning those
rows are too small to carry.

Date: 2026-07-26
Companion to [`prior-art-failure-modes.md`](prior-art-failure-modes.md), which enumerates
what previous generations got wrong. This document is the forward half: what we do about
the one failure mode none of them solved.

## The arithmetic that makes the wall a wall

Requirements do not consume primitives one at a time. A single real requirement needs a
field type, a validation, a guard, a permission narrowing, a state transition, a surface
slot, a query filter, and a report projection — call it `k` primitives. It ships only if
**all `k`** are supported.

So requirement coverage is `p^k`, not `p`. At 95% primitive coverage and `k`=10, roughly
60% of requirements ship. Reaching 99% of requirements at `k`=10 needs **99.9%** primitive
coverage, which no amount of primitive-building achieves: remaining demand is Zipfian, each
request unlocking a fraction of a percent, while cost per primitive rises with the support
matrix (doctrine #10 requires ten dimensions to agree). Two curves cross, and the crossing
*is* the wall. Nobody decides to stop; the roadmap silently reprioritises forever.

That equation has exactly four exploitable weak points.

| Lever | Attacks | Status |
|---|---|---|
| **1 — one expression kernel, many binding positions** | `k` (supply side) | **Done and ratified.** See the [expression-kernel verdict](debates/expression-kernel-verdict.md), ADR-0012, and queue rows 1/3/4/6/8/10 |
| **1b — the builder negotiates the requirement** | `k` (demand side) | Recorded `prose-only`; G6 builder |
| **2 — a typed escape at every position** | `p` on the tail | **This document.** `prose-only` |
| **3 — the realization ladder** (the gap report becomes a downgrade offer) | binary failure | **Written.** `prose-only` |
| **4 — gap latency as the headline metric** | time, not coverage | Named, not yet written |

---

## Lever 2 — a typed escape at every position

### What it is

Levers 1 and 1b attack `k`. Lever 2 attacks `p`, and specifically **tail-p**: the
primitives that will never be worth building because each unlocks a fraction of a percent
of demand.

You cannot raise tail-p by adding primitives — that is the losing side of the arithmetic
above. You raise it by changing **who supplies the missing behaviour and how fast**. If a
tenant can supply it themselves, inside a shape the platform already validates, tail-p
approaches 1 wherever the escape exists.

### The core idea: the escape is a body, never a contract

Salesforce is the counterexample that teaches this. A validation rule is declarative; when
it is insufficient you write a before-save Apex trigger. But the trigger is not *shaped
like a validation* — it can query, call out, perform DML, enqueue jobs. The escape's blast
radius is enormous relative to the need. That is why Apex metastasised, and why governor
limits had to be retrofitted as runtime containment after the fact.

What we want instead: when a validation cannot be expressed declaratively, the tenant
supplies a **validation body** — same signature, same inputs, same return type, same
purity, same sandbox, same release pinning, same audit. It cannot do anything a validation
could not do. It computes differently.

The contract already exists. The escape substitutes an opaque computation for a
declarative one *inside* it.

### Why this is nearly free here

ADR-0012 defines **position profiles**: context, result type, phase, purity, allowed
dependencies, absent/error behaviour, execution target. It states plainly that "an operator
allowlist alone is not a position profile."

That is precisely the contract an escape body must satisfy. There is no second artifact to
invent.

**Lever 1 does not merely precede Lever 2 — it produces the thing Lever 2 needs**, as a
byproduct, for unrelated reasons. Without position profiles there is no shape for an escape
to be shaped like, and you are back to a general hatch. This materially lowers the cost
estimate that [prior-art audit B5](prior-art-failure-modes.md) assumed.

ADR-0012 does not mention escapes. The connection is unrecorded, which is what the
coverage-map row exists to fix.

### The ladder: which positions, in what order

Ordered by blast radius ascending, which aligns with plan §10.4's expansion ladder.

| Position | Blast radius | Note |
|---|---|---|
| Derived display field | Lowest — pure, read-only | The natural first |
| Validation | Pure; pass/fail plus message | Very safe |
| Visibility / action guard | Pure; boolean | Safe |
| Relation filter, option narrowing | Pure predicate | Must respect SQL-lowerability or paginate |
| Default value | Pure, but writes into stored data | Slightly higher |
| Permission narrowing | Pure but security-relevant | May only narrow; fails closed |
| Operation precondition | Transaction-bound, TOCTOU-relevant | Higher |
| Effect / operation body | Writes | Genuine Tier C territory |

The first three are pure functions returning scalars — the cheapest possible sandbox
target — and cover a surprising share of real blocked-customer demand.

### The argument that matters more than coverage

If a model can write the body, why not keep raising the expression language's ceiling until
the need is expressible declaratively?

**Because adding expressiveness costs analyzability everywhere, while adding an escape
costs analyzability at one position.** ADR-0012's ceiling — total, terminating, no loops,
no operation invocation, bounded depth — is what makes expressions statically checkable,
SQL-lowerable, and explainable. Ratcheting the language to absorb the tail destroys that
property for every expression in the system.

That is [audit finding B4](prior-art-failure-modes.md), the expressiveness ratchet: how
Salesforce got Flow and ServiceNow got script includes.

So **the escape exists precisely to protect the language's ceiling.** Without it, pressure
ratchets the language. With it, the language stays small and the pressure routes somewhere
contained. This is a stronger argument than the coverage one, and it is the reason to build
escapes even if tail coverage were not a concern.

### The honest costs

- **The sandbox is real engineering.** WASM or an isolated realm with fuel metering,
  enforced purity, no ambient clock or randomness, declared dependencies only. Plan §5.2
  reserves "server WASM and isolated UI extensions" as a seam — identity and serialisation
  are reserved; the **runtime envelope is not**.
- **Each escape position becomes a permanent API.** Profiles-as-contract is a forever
  commitment.
- **Debuggability regresses.** An opaque body is harder to explain than a compiled
  expression, which makes [audit D2](prior-art-failure-modes.md) harder exactly where it
  matters most.
- **Review does not scale.** Nobody can human-review every tenant-authored body.

### How LLMs fit — the strongest fit of any lever

**1. Author the body.** The tenant describes intent; the model writes a few lines inside a
fixed signature. Bounded: types machine-checked both ways, sandbox enforces purity and
termination, blast radius provably the position's.

This inverts the usual intuition. Model-authored code here is *safer* than hand-written
code — not because the model is good, but because **the contract is narrow**. A human
writing an Apex trigger has the whole platform available; a model writing a validation body
has a signature and a sandbox.

**2. Generate the verification, and let the human approve *that*.** The model produces the
body **and** concrete scenarios. The human — a warehouse manager, not a developer —
approves the *scenarios*, which are business statements they can adjudicate. The body must
satisfy them or it does not compile.

This dissolves the review-at-scale cost above: **nobody reviews the code; a human reviews
behaviour, and the machine enforces correspondence.** It is the same machinery as L4/L6 in
`current-plan.md`, pointed at a second target.

**3. Adversarial critique before activation.** A fresh model, no authoring context, asked
for cases where this body does something the author probably did not intend. Cheap when
wrong, valuable when right — and never the model that wrote it.

**What LLMs do not fix:** the sandbox (a weak sandbox makes generated code exactly as
dangerous as any code — no model quality substitutes for enforced limits), the permanent
compatibility surface, and explanation quality, since a model narrating an opaque body is
weaker evidence than a compiled expression's explanation artifact.

### Verifying a body: the residual risk and what actually reduces it

The honest weakness is that **a body can satisfy every approved scenario and still be
wrong in a case nobody imagined.**

First, size it correctly: this is a **specification-by-example** problem, not an
escape-body problem. A declarative formula has it too — a formula can pass every scenario
and be wrong on the case nobody wrote. Every customization the platform ever accepts
inherits it.

There is exactly **one** real asymmetry. A formula is *analyzable*; a body is only
*samplable*. You can statically determine what a formula reads, that it is total, and how
it behaves across ranges, and for small domains you can exhaust it. An opaque body you can
only probe. That asymmetry is the argument for keeping escapes narrow and rare — it is not
an argument against having them.

Mitigations, strongest first:

1. **Shadow the body over historical data before activation.** Report the delta in business
   terms: "this rule would have blocked 1,247 of your last 5,000 purchase orders." A human
   judges that instantly, no scenario-writing and no imagination required — and it surfaces
   precisely the unimagined cases, because reality already contains them. Plan §10.1
   already promises shadow verification and G6 item 8 has shadow-browser checks; this
   points existing machinery at a new question rather than inventing any.
2. **Property-based generation over the declared domain.** The position profile declares
   input types, so it *is* a generator. Fuzz across the domain and check invariants that
   hold regardless of intended semantics — determinism, totality, no order dependence. Plan
   §14.3's inventory property suite already establishes the culture and the generator
   discipline.
3. **Differential against the declarative attempt.** Body-specific, and the cheapest real
   win. Someone escaping to a body almost always tried a formula first that was ~90% right.
   **Retain that formula**, then diff body against formula: every disagreement is either
   the intended fix or an unintended regression, and there should be very few. This
   converts an unanswerable question ("is this body correct?") into an answerable one ("are
   these three differences what you meant?") that a business user can actually adjudicate.
   Same trick as L2's parity corpus, pointed at a different pair.
4. **Staged activation.** Free today — per-(tenant, environment) pointers already allow
   activate-in-one-environment, watch, promote.
5. **Adversarial critique.** A fresh model, no authoring context, hunting for cases the
   author probably did not intend. Weakest of the five because it is model judgement rather
   than evidence; useful, never load-bearing.

**Do we need more than this?** Mostly no, and the reason matters: items 1, 2 and 4 are
needed anyway for *declarative* customization, so they are not an escape-body tax — they
are what §10.1's "assertions + policy + migration + shadow verification" is supposed to
mean. Only item 3 is body-specific, and it is small.

Severity is additionally controlled by **sequencing, not only verification**. A wrong
validation body accepts or rejects things it should not — annoying, visible, reversible in
one pointer move. A wrong *effect* body would be genuinely bad, which is exactly why the
ladder above puts effects last and starts with pure scalar-returning positions. Formal
verification or exhaustive checking would be disproportionate for pure functions with
bounded blast radius inside a reversible release.

### Bodies must drain back into the language

An escape body should be **retirable to declarative**. When the expression language later
gains the primitive that was missing, the tenant is told "this can now be expressed as a
formula — swap it?" and offered the migration.

Without that, opaque bodies accumulate permanently and the analyzability given up is never
recovered. That is [audit B6](prior-art-failure-modes.md) — customization sprawl with no
retirement path — in a more damaging form, because these are not unused fields but
unanalyzable logic.

It also gives the escape a **ratchet in the right direction**: the platform grows more
expressive over time and bodies drain back into the language, rather than the language
being ratcheted to chase them.

Both this and the differential check need the same thing: an escape body must carry its
**declarative provenance** — the formula that was attempted, and which missing primitive it
substitutes for. Cheap to require when bodies are first defined; unrecoverable afterwards,
exactly like [ADR-0013](../decisions/ADR-0013-semantic-patch-lineage.md)'s patch lineage.

### Explanation on boolean positions

Partly solved by profile shape already: a validation body returns pass/fail **plus a
message**, and that message *is* the explanation, authored by the tenant. "Why did this
fail?" is answered by construction.

It is weaker for boolean-only positions — guards, visibility — where the body returns
true/false with no room for a reason. The fix is small and time-sensitive: those profiles
should carry a **reason channel** alongside the boolean, so an escape body must supply one.
ADR-0012 defines position profiles but the formula/rule projection family that carries them
is queue row 4, unbuilt. Requiring it now costs a sentence; retrofitting it after the family
ships costs a canonical change.

### Timing

- **Free, already true:** ADR-0012's position profiles are the escape contracts. Nothing to
  do but record the connection.
- **Design well before use (~N2):** the envelope — grants, resource limits, review path,
  release pinning, rollback, kill switch, revocation. The plan schedules Tier C at N7;
  history says the first blocked customer arrives far earlier, and an envelope that does
  not yet exist becomes a customer-specific fork ([audit A4](prior-art-failure-modes.md)).
- **First implementation, G6-era:** derived display field and validation only. Pure,
  scalar-returning, smallest possible sandbox.

---

## Lever 3 — the realization ladder

### What it is

Today a requirement is binary: it compiles, or it produces a gap report. Plan §12.13's four
outcomes are directly composable, pack-composable, extension-composable, or *not yet
supported*.

But most of the last 20% is not "the system cannot store this" — it is "the system cannot
**automate** this." Goods receipt inspection compiles entirely except one rule: *if the
supplier is on probation, require two signatures unless the PO is under $500 and the buyer
is the plant manager.* Ninety-five percent expressible, zero percent shipped.

Lever 3 says ship it at 95%, with the remainder degrading **honestly** — visible, audited,
attributed, and flagged for automatic upgrade when the capability lands. Unlike new
primitives, each of which unlocks a fraction of a percent, this works on every blocked
requirement at once.

### The ladder — Levers 2 and 3 are rungs of one thing

| # | Realization | Deterministic? | Requires |
|---|---|---|---|
| 1 | Compiles declaratively | Yes | — |
| 2 | **Escape body, agent-authored** | Yes — a sandbox runs it | Sandbox ([Lever 2](#lever-2--a-typed-escape-at-every-position)) |
| 3 | **Agent-assisted manual step** | Human decides; agent surfaces, pre-fills, routes, batches | Nothing new — ADR-0009 already permits it |
| 4 | Bare manual attestation | Human decides unaided | Nothing new |
| 5 | Blocked | — | Today's only non-success outcome |

**The platform has rungs 1 and 5. Everything between is unbuilt.**

Rung 2 is the answer to "automate it instead of making it manual": the tenant describes the
rule, the agent **authors** the escape body at compile time, scenarios verify it, a human
approves the scenarios, and thereafter a deterministic sandbox evaluates it on every
request. The agent's involvement ends before activation; nothing model-shaped is in the
request path.

**Rung 3 is the cheapest and should probably be built first.** It needs no sandbox and no
new canonical structure. The step remains a compiled, audited operation requiring human
confirmation — PR-3 already shipped server-issued fully bound confirmation — while the
agent surfaces the case, attaches the evidence ("supplier X is on probation, PO is $640,
buyer is not the plant manager"), routes it to the second approver, and works the queue.
"Someone remembers to tick a box" becomes "the system asks a specific question with the
reasoning attached." That is legitimate under ADR-0009 today.

### The forbidden rung, stated so it is not reinvented

**The agent must never evaluate the rule at runtime.** This looks like the obvious
shortcut and it is ruled out by the [expression-kernel verdict](debates/expression-kernel-verdict.md):
a model may author at compile time, operate by selecting registered operations, and
critique offline — never evaluate a business rule at request time. Concretely it breaks
four things: determinism (§14.3 requires replay to yield the same result), auditability
("why was this blocked?" answered by "the model decided"), release pinning (every request
pins one release; a model is not pinned, so a provider update silently changes business
behaviour with no approval and no rollback), and §15.5 ("a slow or unavailable model cannot
prevent authorized users from operating normal paths").

The generalized line, which Lever 3 makes load-bearing:

> The agent may evaluate anything whose output **has no authority** — triage,
> prioritisation, suggestion, drafting, explanation. It may never evaluate anything whose
> output **is the decision** — blocking, posting, authorising, or computing a stored value.

Flagging receipts that look unusual is safe: miss one and nothing is wrong, a human still
decides. Deciding whether a receipt posts is not.

### The §10.2 boundary, exactly

Plan §10.2 says "partial support is reported as a capability gap, **not approximated**."
Lever 3 must not become the hole that rule exists to close.

- **Forbidden:** the platform advertises a capability as supported when it is 70%
  supported. That is the *vendor* misrepresenting capability.
- **Allowed:** the *tenant* knowingly ships a module whose remainder is manual, and the
  system records it **as** manual.

The test is whether the platform's own capability claim moved. Under Lever 3 it does not —
the support matrix still says unsupported and the gap report is still exact. What changes
is that a tenant may proceed with a declared, visible remainder instead of being blocked.

Different actor, different knowledge, different artifact. Framed this way it *strengthens*
§10.2, because the alternative to an honest recorded remainder is not purity — it is the
customer doing that step in a spreadsheet where nobody can see it, which is
[audit E4](prior-art-failure-modes.md) and strictly worse.

### The floor — non-negotiable

Not everything is downgradeable. **Never degrade** anything protecting inventory truth,
tenant isolation, authorization, or audit completeness. Those fail closed, always, with no
offer presented.

Without a written floor, "ship it with a manual step" drifts toward "post the movement
manually and reconcile later," and doctrine #4 is gone.

### Mechanism, and a pattern worth noticing

A manual attestation needs no new execution machinery — it is an ordinary
confirmation-with-note operation. The only new thing is a **provenance link**: *this step
exists because capability X is unsupported.*

That is the third appearance of the same primitive:

- [ADR-0013](../decisions/ADR-0013-semantic-patch-lineage.md) patch lineage — what the
  tenant *meant*
- Lever 2 escape-body provenance — which formula this body replaced
- Lever 3 remainder link — which capability this manual step substitutes for

All three are *a link from a substitute back to the thing it substitutes for*; all three
are cheap at creation and unrecoverable afterwards; all three enable the same upgrade
ratchet. They may be one mechanism rather than three, and that is worth deciding before the
second one is built.

### Where LLMs fit

**Propose the downgrade** — given a machine-readable gap, what is the honest degraded
realization? Model proposes, compiler validates expressibility, human accepts.
**Explain the trade in business terms** — "this becomes a checkbox someone ticks about
twelve times a month, based on your last quarter," which is Lever 2's shadow-over-history
reused. **Detect upgrade eligibility** — finding now-automatable remainders is mechanical;
judging whether the new capability truly covers the original intent is judgement, so the
model proposes and the tenant confirms through scenarios.

### Risks

Accumulation: it becomes easy to ship half-built modules and never finish them. Mitigated
by remainders being first-class, visible and counted — which is exactly what Lever 4's
instrumentation measures. And by the upgrade ratchet, without which remainders become
permanent, which is [audit B6](prior-art-failure-modes.md) in yet another form.

## Lever 4 — named, not yet written

**Lever 4 — gap latency as the headline metric.** The felt height of the wall is not
coverage, it is *how long you wait*. 90% coverage with a three-day gap-closing loop beats
98% with a nine-month roadmap. §15.7 measures module-building cost, which is the wrong
number. The ambitious half is **self-hosting**: making capability definitions canonical
objects compiled into their own support-cell projections, the same way module definitions
compile into storage, CRUD, surfaces and tests. That is what collapses gap latency from
quarters to days, and it is where the AI-native bet actually pays. It is also where
"platform before product" returns through the window, so it must be earned incrementally —
add three or four capabilities by hand, notice which projections were purely mechanical,
generate only those.

Both are unwritten here and unscheduled in the coverage map.
