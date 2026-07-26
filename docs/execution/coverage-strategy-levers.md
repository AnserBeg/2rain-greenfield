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
| **3 — the gap report becomes a downgrade offer** | binary failure | Named, not yet written |
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

## Levers 3 and 4 — named, not yet written

**Lever 3 — the gap report becomes a downgrade offer.** Today a requirement needing one
unsupported thing is blocked entirely. But most of the last 20% is not "the system cannot
store this," it is "the system cannot *automate* this." A module that is 95% expressible
could ship at 95% with the remainder degrading honestly to a required manual attestation,
audited, reported, and flagged for automatic upgrade when the capability lands. The
compiler already produces exact gap diagnostics; today they are a stop sign. Requires a
carefully drafted boundary against §10.2's rule that partial support is reported as a gap
and never approximated — the platform never claims a capability it lacks, but a tenant may
knowingly ship a requirement whose remainder is manual and recorded as manual.

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
