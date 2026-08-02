# ADR-0040: Fresh-tenant install applies every transition and verifies only what will serve

Date: 2026-08-01
Status: accepted — ruled by the orchestrator after `5g3-write-scope` stopped four
times, the last on a database-capacity wall rather than a defect.
Tier: Critical (it changes what a fresh install proves)

## Context

A fresh tenant starts with a null release pointer, admits the bootstrap, and then
iterates **every** application successor
(`packages/postgres-provider/src/composed-application-runtime.ts:229`, `:348`).
For each step it applies the pairwise transition and runs **full semantic
verification**.

Nothing selects only changed entries. An already-active tenant restarting is
free — its active index is the lineage head, so the loop is empty — which is why
this stayed invisible: it costs nothing until someone onboards.

**Lineage is append-only, so fresh-tenant install is unbounded in lineage
length.** At eight releases it is minutes. At eighty it is unusable. Nobody can
onboard a customer into a mature system.

It has now stopped work three times in one day, each time looking like a
different problem:

- The composed activation test measured 296 s against a 300 s budget — main
  passing a gate with 1.3% headroom, which nobody noticed because a pass is a
  pass.
- `5g3-write-scope` made 73 previously-derived scenarios genuinely executable —
  the packet succeeding — and both composed parents exceeded 300 s.
- The same packet then filled the ephemeral PostgreSQL **256 MiB tmpfs**
  (SQLSTATE 53100) after ~181 s. The wall was never really time; it was
  *releases × tenants × scenarios* of arranged probe data.

`5g3-activation-cost` already removed the largest coefficient — 4,739 redundant
artifact reloads became 17 — and correctly reported that this reduced the
constant while leaving the complexity untouched.

## The distinction that decides it

The install loop does two things per step, and they are not the same kind of
thing.

**Applying the transition is cumulative and cannot be skipped.** Transitions are
defined pairwise (`assertExactCompiledTransition(source, target)`) and each
assumes the schema is at `source`. The head's schema exists only as the result of
applying them in order. Skipping a step would require a *cumulative head-install*
mechanism that does not exist.

**Running full semantic verification at every step is redundant.** Verification
**arranges its own probe records** — it creates what it needs, probes it, and
archives it. It never reads tenant business data. So verifying release 3 in
tenant A proves precisely what verifying release 3 in tenant B proves, and both
prove what CI proved. The work is repeated per tenant to reach an answer that
does not vary per tenant.

## Decision

### 1. Every transition is still applied, in order, unchanged

No transition is skipped, reordered, or synthesised. `assertExactCompiledTransition`
keeps asserting each pairwise step. The schema is still built by replay, and a
transition that fails still fails the install.

### 2. Full semantic verification runs for the release that will SERVE

The head — the release the tenant will actually run — is verified exactly as
today. Nothing about the serving release's proof changes.

### 3. Intermediate releases are installed without re-running their scenarios

A release the tenant passes *through* on the way to the head has its transition
applied and asserted, but its scenario set is not re-executed.

**This is a bounded-install property, not a skip, and it must be recorded as
such.** ADR-0020:156 governs derivations at scenario level and is untouched — no
scenario is being marked derived. What changes is which releases a fresh install
verifies, and that is an install-path decision that must be visible in the
install's own evidence.

### 4. The install records what it did and did not verify

Fresh install must emit evidence naming the releases whose transitions were
applied without scenario execution. An install that quietly proves less than
before is the defect this ADR would otherwise create.

## The revisit condition — this is load-bearing

§3 rests on one premise: **a release proves the same thing in every tenant,
because verification arranges its own data and tenants do not diverge.**

**G6 customization breaks that premise.** Once tenants carry their own patches
and their compiled releases differ, "verified once" no longer implies "verified
here," and per-tenant verification becomes meaningful again.

So: **when tenant-specific release divergence ships, this ADR must be revisited.**
Record it as owed against the G6 stage cut rather than discovering it when a
customized tenant installs against a proof that was never about it.

## What this ADR does not decide

- **A cumulative head-install mechanism.** Building the head's schema directly,
  without replaying transitions, would remove the remaining O(lineage) cost
  entirely. It is not designed here and is the natural successor if applying
  transitions alone becomes the wall.
- **The composed test's budgets.** Those are re-derived from measurement once
  this lands, not assumed.
- **The ephemeral PostgreSQL tmpfs size.** If capacity is still exceeded after
  this, that is new information and a separate decision — deliberately not
  pre-authorised, because raising it was the easy move this ADR exists to avoid.
- **Whether historical releases should be verified at all, anywhere.** They are:
  in CI, when they were the head. This changes only the per-tenant repetition.

## Consequences

- **Fresh install becomes O(lineage) in transitions and O(1) in verification.**
  The remaining growth is DDL application, which is far cheaper than arranging
  and probing scenario data — and it is bounded by schema shape rather than by
  scenario count, so it does not grow when a module adds coverage.
- **`5g3-write-scope` unblocks.** Its 73 newly executable scenarios run once, for
  the serving release, instead of once per historical entry per tenant.
- **A gate's meaning narrows, deliberately and visibly.** Fresh install used to
  prove "every release in this lineage verifies in this tenant." It will prove
  "every transition applies, and the serving release verifies." That is less, it
  is written down, and §4 requires the install to say so in its own evidence.
- **The 1.3%-headroom incident becomes explicable.** That gate was not marginal
  by bad luck; it was carrying a cost that grows with every release, and it would
  have failed on whichever packet happened to arrive next.
