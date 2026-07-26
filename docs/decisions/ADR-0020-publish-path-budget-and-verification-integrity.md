# ADR-0020: Publish-path latency budget and verification integrity

Date: 2026-07-26
Status: accepted (orchestrator ruling, user-authorized 2026-07-26; the breadth envelope is
startable now, the end-to-end budget is owned by the G6 customization stage cut)
Tier: Critical (review per `review-tiers` when implemented)

## Context

Plan §15.5 correctly claims that request-time interpretation is designed away: compilation
happens before activation and requests consume immutable prepared artifacts. That closes the
prior art's *runtime* performance failure.

It does not close the *publish* one, which is the half that actually throttles a customization
product. Dynamics 365 F&O full builds run for hours. Salesforce deploys are gated by mandatory
synchronous compile and test execution, and the documented remedy for slow deploys is to
disable synchronous compile and accept runtime errors instead — which is the failure, not the
fix. Publish latency is not a comfort issue: the publish loop **is** the customization product,
and a slow one silently pushes tenants back to asking engineering.

This architecture carries the same mechanism. §5.6 normalizes every patch into a complete
desired-state revision, §5.3 compiles atomically and runs generated assertions plus provider
conformance before the candidate is admitted, and §10.1 verifies before activation. Cost
therefore scales with **total application size**, not with the size of the change.

Two measurement facts define the gap:

- [`compiler-slos.md`](../operations/compiler-slos.md) sets a real, gated **≤5,000 ms cold full
  compile** — but at the Freeze A maximum-field envelope under **one** module, entity and
  storage mapping. Incremental compile is "family reserved; v0 is cold-only," owned by a G6
  packet "triggered by measured need." Preview has no target.
- PR-6c established that a deferred-family element transaction holds the **platform-wide**
  materializer advisory key for the entire rewrite, so during a 1.3-3.5 s rewrite any other
  tenant's `prepare` or `executeApprovedAttempt` fails `MIGRATION_LOCK_TIMEOUT`
  ([`runtime-slos.md`](../operations/runtime-slos.md)).

The second fact means publish latency is not only the publisher's problem.

Recorded as **G7** in [`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md).

## Decision

### 1. The budgeted unit is the publish path, not the compiler

Define one named SLO family, `publishPath`, spanning:

```text
accepted draft bytes
  -> compile
  -> candidate verification (generated assertions + provider conformance)
  -> transition preparation
  -> approval-ready bound diff
  -> [human approval wait — measured, reported, never inside the budget]
  -> activation CAS + read-back
```

Machine-time segments are budgeted end to end and each is separately attributed. Human wait is
reported alongside and never counted, per the existing approval-family rule.

The compiler's own budget stays exactly as it is. It is a component bound, and this ADR's
point is that a component bound cannot be reported as the user-visible number — optimizing
compile to 5,000 ms while the publish path takes four minutes is precisely the prior art's
mistake.

### 2. A second axis: exclusion imposed on other tenants

`publishPath` has two independent budgets, because they have different remedies:

- **Publisher latency** — how long the publishing tenant waits. Remedied by incremental
  compile, memoization, and verification impact analysis.
- **Platform exclusion** — how long *other* tenants' preparations and kernel migration replay
  are blocked. Remedied by online DDL strategy and lock scoping, and never by making the
  publisher faster.

PR-6c's rehearsed **2,000 ms** writer-blocking promotion trigger is the current bound on the
second axis, and `runtime-slos.md` already records that the trigger is procedural rather than
coded. This ADR does not change that trigger; it establishes that the quantity it bounds is a
budgeted publish-path property with a named owner, not an incidental note in a packet record.

### 3. Measure on a breadth envelope, and start now

The single-maximal-module measurement stays — it bounds one family honestly. It is **not** the
publish-path envelope.

Add a **breadth envelope**: a declared realistic tenant application shape of N modules
totalling M fields, measured as a **curve across N** rather than a single point, recorded from
the current packet onward.

This is startable immediately and is the only part with a real cost of delay: "triggered by
measured need" requires a trend, and a baseline not started cannot be reconstructed. It is the
same argument, and should be the same instrument, as the tracked capability cycle-time
baseline — both record a curve now so a later decision has data instead of an argument.

### 4. Verification integrity — binding

**Verification scope may be narrowed only by a sound impact analysis derived from the compiled
diff, and the narrowing must itself produce evidence:** the skipped set is named, and the
derivation that justified skipping it is recorded with the candidate.

Never by sampling. Never by time-boxing. Never by author or tenant selection. Never by a
skip-verification flag. Never by moving verification after activation.

**A publish-path budget miss is never remedied by weakening verification.** The admissible
remedies are incremental compile, memoization, a sound impact analysis, better provider
conformance mechanics — or accepting and publishing a slower budget. Plan §17 already stops on
"a pinned test/ADR/gate is weakened to accommodate implementation"; this ADR names the specific
pressure that will produce that temptation, so it is recognized when it arrives rather than
argued about under a deadline.

This is the single most important line in this document. Salesforce's 75% coverage ritual
(audit **E1**) and its disable-synchronous-compile guidance are the same failure at two ends:
verification that exists to be satisfied rather than to be true. This program's answer to E1 is
compiler-derived assertions; its answer here is that their execution is not negotiable against
latency.

### 5. Incremental compile is bit-identical or it does not ship

Already stated in `compiler-slos.md` and restated here as binding, with a required negative
control: an incremental result that diverges from a cold compile by a single byte fails the
gate. A second compilation path that is *nearly* the same is a second compiler, and doctrine
#1 and §5.7 forbid that regardless of how much faster it is.

## Consequences

- The publish-path family gets a definition and an owner now, and a numeric objective at G6
  when a preview and a real authoring flow exist to measure.
- The breadth envelope is small, order-independent work that can be taken at any time and
  should be started before G6 rather than at it.
- PR-6c's platform-wide exclusion window is promoted from a recorded finding to a budgeted
  quantity, which is what turns the procedural 2,000 ms trigger into something an approval
  path can eventually consume.
- Verification integrity constrains the fastest available optimization. That is the point.
- No current gate changes. This ADR adds a family, an envelope, and a prohibition; it does not
  relax or restate the accepted ≤5,000 ms compiler budget.

## Evidence

- Plan §5.3 compiler pipeline and atomic compilation, §5.6 authoring normalization, §5.7 one
  consolidated kernel, §10.1 publication lifecycle, §15.1 service objectives, §15.5 performance
  architecture, §17 stop rules.
- [`compiler-slos.md`](../operations/compiler-slos.md): the gated 4,096-field single-module
  budget, the reserved incremental/preview families, and the existing bit-identical rule.
- [`runtime-slos.md`](../operations/runtime-slos.md): PR-6c's measured 1,317 ms / 3,503 ms
  blocking windows, the 2,000 ms promotion trigger, the platform-wide advisory-key finding from
  the Fable confirm, and the recorded fact that the trigger is procedural.
- ADR-0011 versioned two-class preparation, which is the segment between verification and
  activation.
- [`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md) **G7**, and **E1**
  for the shared root.

## Enforcement

- `compiler-slos.md` carries `publishPath` as a named family with both axes and its owner.
- The breadth envelope runs as a recorded measurement producing a curve artifact, not a
  pass/fail assertion, until G6 sets an objective against it.
- Structural test: no code path admits a candidate with an unexecuted verification set absent a
  recorded impact-analysis derivation; a skip flag, a sampling parameter, and a time-box
  parameter each fail closed, with recorded negative controls.
- Determinism gate: an incremental compile whose bytes differ from the cold compile fails,
  proven by a negative control that perturbs the incremental path.
