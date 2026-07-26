# ADR-0014: One provenance substrate, two record kinds

Date: 2026-07-26
Status: accepted (orchestrator ruling, user-authorized 2026-07-26; implementing packets are
the G6 customization stage cut and, for substitution records, whichever rung of the
realization ladder ships first)
Tier: Critical (review per `review-tiers` when implemented)

## Context

Three independently-derived obligations turned out to need the same thing:

- **[ADR-0013](ADR-0013-semantic-patch-lineage.md) patch lineage** — what the tenant *meant*,
  retained so a base upgrade re-applies declared intent rather than merging outcomes.
- **[Lever 2](../execution/coverage-strategy-levers.md) escape-body provenance** — which
  formula this opaque body replaced, and which missing primitive it substitutes for.
  Enables the differential check and retirement back to declarative.
- **[Lever 3](../execution/coverage-strategy-levers.md) remainder link** — which unsupported
  capability this manual step or agent-assisted step stands in for. Enables the upgrade
  ratchet when the capability lands.

All three are cheap to require at creation and unrecoverable afterwards. Deciding whether
they are one mechanism is therefore cheapest before the second one is built.

## Decision

**One substrate, two kinds.** They share storage, lifecycle and query surface; they do not
share semantics, and collapsing them into a single record type would be wrong.

**1. The substrate.** A tenant-scoped, **data-plane**, append-only provenance record
carrying: kind discriminator; trusted tenant and environment; the release identity it was
created against; the authoring actor and channel; creation time from trusted request
context; and a typed payload. Data-plane, not canonical, for ADR-0013's reasons — plan §5.6
forbids the active system executing a patch pile, and G2-P7a measured that a new canonical
family is a language/profile version event. Provenance never becomes runtime authority.

**2. Kind `intent` — patch lineage.** ADR-0013 unchanged. Records what was asked for, so it
can be **re-applied** to a new base. Not a substitution: nothing is standing in for
anything.

**3. Kind `substitution` — a link from a substitute to what it substitutes for.** Binds the
substitute artifact, the substituted-for reference (a capability ID, or the declarative
expression that was attempted), the reason, and the ladder rung in use. Covers escape
bodies and manual/agent-assisted remainders alike, because they differ only in which rung
of the realization ladder produced them.

**4. Substitution records drive one upgrade scan, not three.** When a capability is admitted
or the expression language gains a primitive, one pass over substitution records answers
"what can now be promoted?" — for escape bodies and manual remainders together.

**5. One tenant-facing surface.** "Here are the N places your application is working around
a limitation, what each is waiting for, and which can be upgraded now." That is one feature
built once, not three built separately. It is also the tenant-level view of Lever 4's
disposition mix.

**6. Provenance payloads inherit data classification.** They carry labels, defaults, filter
literals and business reasoning. Not automatically safe to log, export, or place in model
context.

## Consequences

**Easier.** One storage shape, one retention policy, one isolation test, one upgrade scan,
one report. Lever 2's retirement-to-declarative and Lever 3's upgrade ratchet become the
same code path. Lever 4 gets tenant-level instrumentation for free.

**Harder.** The kind discriminator must be got right early; a substitution record that
should have been an intent record (or vice versa) is a migration. The two kinds must not
drift into a shared-payload compromise that serves neither.

**Forbidden.** Treating provenance as runtime authority. Reconstructing a substitution
record from a diff after the fact and presenting it as authored provenance. Three separate
stores.

**Rollback.** Additive; a tenant with no customization has an empty provenance store.

## Evidence

- ADR-0013's data-plane reasoning and its determinism gate.
- G2-P7a measured that adding a canonical family moves normalized bytes and release roots
  even for packages declaring none of it — the basis for keeping this off the canonical
  language.
- The three obligations were derived independently, on different days, from different
  problems (base upgrade, tail coverage, binary failure) and converged on the same shape.
  That convergence is the argument for one substrate.

## Enforcement

Not executable today. Gates the implementing packets must carry:

- ADR-0013's determinism gate for `intent` records is unchanged and remains load-bearing.
- For `substitution` records: the upgrade scan must be **observed** finding a promotable
  record after a capability is admitted, not asserted. Negative controls — empty store reads
  zero and says so; a substitution whose referenced capability never lands is reported, not
  silently retained forever; a tampered reference fails closed.
- Two-tenant isolation on the provenance store, per plan §7.2.
- A check that no provenance record participates in release manifest content or runtime
  authority resolution.

Tracked in [`doctrine-coverage.md`](../execution/doctrine-coverage.md) until the owning
packets land.
