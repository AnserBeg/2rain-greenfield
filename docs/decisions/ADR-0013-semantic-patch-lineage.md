# ADR-0013: Tenant customization persists its semantic patch lineage

Date: 2026-07-26
Status: accepted (orchestrator ruling, user-authorized 2026-07-26; implementing packet is
the G6 customization stage cut)
Tier: Critical (review per `review-tiers` when implemented)

## Context

Plan §5.6 states that every authoring channel — first-party package authoring, the
visual/form/table builder, conversational AI customization, import/template authoring, and
the advanced declarative editor — emits **the same typed semantic patches**, and that
"patches normalize into a complete desired-state revision before compilation."

A customization therefore begins life as *declared intent*. Nothing currently retains it.
§10.1 treats the patch as a pipeline step; G6 item 4 specifies a "draft service with
**revision history**," which is outcome history. Intent cannot be reconstructed from the
revision it produced, after the fact, at scale.

This matters because of the base-upgrade problem ([prior-art audit
B7](../execution/prior-art-failure-modes.md)). If intent is retained, upgrading a tenant
across a first-party package version is **re-applying their patch to the new base and
normalizing** — not diffing outcomes. The only failure mode is a patch whose target moved
or vanished, which is enumerable and reportable. If intent is discarded, the same upgrade
degrades to three-way merge of outcomes, which is the mechanism Dynamics AX and SAP
abandoned after paying for it at every release.

Extension-points-only was considered and **rejected**: it is the correct answer for
asymmetric platforms whose vendor modules are a different kind of object than a customer's,
and adopting it here would manufacture the two-tier world doctrine #2 forbids.

## Decision

**1. The semantic patch lineage is persisted, append-only, alongside the revision it
produced.** Both are retained. Neither substitutes for the other: the patch carries intent,
the revision carries desired state.

**2. Patch records are data-plane, not canonical language.** They are NOT a family
collection in `normalizedShape`, are not part of a compiled release, and never appear in a
release manifest. Rationale: §5.6 already forbids the active system from executing "an
unordered patch pile," so the patch must never be runtime authority; and adding a canonical
family is a language/profile version event, as G2-P7a measured. This decision therefore
costs no version bump and does not need to ride the row-4 packet.

**3. Each patch record binds, at minimum:** the typed patch payload; trusted tenant and
environment; the authoring actor and channel (§5.6's five channels are distinguishable);
the **base package versions it was authored against**; the parent revision; the resulting
revision identity; the language and normalization profile versions under which it was
interpreted; and creation time from the trusted request context.

**4. The payload is a typed semantic patch, never free text and never a serialized diff of
outcomes.** It is expressed in the same canonical vocabulary the compiler already
understands, so re-application is deterministic interpretation rather than parsing.

**5. Patch lineage is append-only and immutable.** A superseding patch is a new record. No
edit path, no hard delete; physical purge only through the administrative retention process
(plan §7.4, AGENTS.md §7).

**6. Patch payloads inherit data classification.** A patch can carry business-meaningful
strings — labels, default values, filter literals. It is not automatically safe to log,
export, or place in model context.

**7. Scope is tenant-authored customization.** First-party package definitions live in
source and their authoring history is git. This is a difference of persistence substrate
for *authoring history*, not a difference in the object model: doctrine #2's symmetry is
about what a package *is*, and is unaffected.

## Consequences

**Easier.** Upgrade across a first-party package version becomes patch re-application with
enumerable failures, rather than semantic merge. Release diffs can be explained in terms of
what the user asked for rather than what the bytes became. An LLM-assisted migration
proposer has a well-formed input — declared intent plus a changed base — instead of being
asked to infer intent from an outcome.

**Harder.** Every authoring channel must emit a recordable patch rather than mutating a
draft in place, which constrains builder implementation. Storage grows with authoring
activity, and retention is now a real policy question rather than an implicit one.

**Forbidden.** Discarding the patch once the revision compiles. Reconstructing a patch from
a revision diff and treating it as intent. Executing a patch as runtime authority.

**Rollback.** The lineage is additive; a tenant with no patches has an empty lineage and
behaves exactly as today. Retrofitting is the case this ADR exists to prevent — once
revisions exist without their patches, the intent for those revisions is unrecoverable.

## Evidence

- Plan §5.6 (all channels emit typed semantic patches; never an executed patch pile),
  §10.1 (publication lifecycle), G6 item 4 (revision history only).
- `doctrine-coverage.md` already schedules "full package composition/merge and tenant
  three-way rebase" against the G6 stage cut; this ADR fixes its primary mechanism as
  patch re-application, with three-way rebase as the fallback for patches that no longer
  resolve.
- G2-P7a measured that adding a canonical family moves normalized bytes and release roots
  even for packages that declare none of the new family — the basis for decision 2.
- Prior art: Dynamics AX layer overlay and SAP modification both shipped conflict
  adjudication as a core upgrade step and were retired in favour of extension models;
  Odoo's load-time inheritance breaks when base structure shifts beneath it.

## Enforcement

Not executable today; the G6 customization stage cut owns the implementing packet. The
gates it must carry:

- **Determinism gate (the load-bearing one):** re-applying a persisted patch to the exact
  base versions it was authored against reproduces the recorded revision identity, byte for
  byte. Observed by comparing recomputed identity to the stored one — not by asserting the
  re-application code ran. If this holds, re-application against a *different* base is
  trustworthy machinery; if it does not, the lineage is decorative.
- Negative controls, one recorded red per vacuity vector: empty lineage reads zero input
  and says so; a tampered payload fails closed; a patch whose target no longer exists
  reports an enumerated unresolved-target diagnostic rather than silently dropping;
  re-application against a mismatched base version is refused rather than attempted.
- Two-tenant isolation on the lineage store, per plan §7.2.
- A check that no patch record participates in release manifest content or runtime
  authority resolution.

Until that packet lands this is tracked as `prose-only` in
[`doctrine-coverage.md`](../execution/doctrine-coverage.md) — binding, with no instrument
yet.
