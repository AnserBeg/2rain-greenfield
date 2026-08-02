# ADR-0043: A tightened rule may truncate the lineage, and an exact count may move only by attribution

Date: 2026-08-02
Status: accepted — ruled by the orchestrator after `5g3-write-scope` stopped twice at
the artifact boundary, on a problem created by ADR-0042 rather than exposed by it.
Tier: Critical (it governs the checked-in release lineage and an exact acceptance count)

## Context

ADR-0042 made the compiler refuse a resolve key whose lowered column is not
text-backed. `verifyExistingLineage` (`apps/web/scripts/compile-app-release.ts:118`)
recompiles **every** historical entry from its stored `normalizedDefinitionBytes`.
Entries 4–7 declare three such keys, so the artifact can no longer be produced at all.

There is no generator for historical entries. The bytes exist only inside the
artifact, so "regenerate the inputs from source" is not an available move, and editing
them is exactly the hand-edit ADR-0039 §3 exists to prevent.

ADR-0039 authorized regenerating compiler **output** from unchanged **inputs**. It did
not consider inputs that become invalid, and the writer correctly refused to assume
the authorization stretched.

**This will recur.** Every conformance packet tightens a rule, and every tightened rule
can invalidate history authored under the looser one. `5g3-langnarrow` escaped it only
because every production relation already declared the surviving values. ADR-0039 §4
warned that the transition to versioned compiler semantics "must not be discovered
late"; this ADR is that warning arriving.

## Decision

### 1. While the output protocol is experimental, the lineage may be truncated

The lineage may be cut back to the longest prefix that satisfies current rules, with a
new head appended from a real compile of current source.

This is materially different from rewriting history. Nothing is made to say what it did
not say; states the platform no longer considers valid are simply not carried forward.
It rests on the premise ADR-0039 §1 already established and this ADR does not re-argue:
there is no production, and test databases are ephemeral.

Verified before this ruling: entries 0–3 compile unchanged under current rules with
their roots preserved, and entry 3 → the new head is a valid exact pairwise transition
of 58 elements with all identity fields matching.

### 2. Truncation is named, in full

ADR-0039 §2's obligation extends to it. Record which entries were dropped and their
roots, the new head's root, the artifact SHA before and after, why truncation was
unavoidable, and — most importantly — **what the lineage no longer proves.**

Here that is: the three separate Inventory transitions formerly represented by entries
4–7 are replaced by one consolidated transition. Those transitions were exercised in CI
when each was the head. What is lost is ongoing proof that those specific incremental
steps still apply, which is a backward-compatibility property the experimental protocol
does not guarantee anyway.

### 3. An exact count may move ONLY by attribution

The composed application asserts an exact scenario count
(`test/postgres/composed-application.test.ts:2170`). ADR-0042 honestly removes
`inventory_period_lock_resolve`, taking resolver-authority scenarios from 11 to 10 and
the total from 168 to 167.

Updating that assertion is legitimate **only because the delta is exactly attributable
to a named, ruled change**: one query removed, one scenario fewer. The new number must
be *derived from the change*, never fitted to the observed result.

If the observed count is anything other than the attributed number, that discrepancy is
a defect and the packet stops. A count that is adjusted until it matches has stopped
being a control.

This is the boundary between registration and exemption. Recording that the release
genuinely contains one fewer scenario is registration. Loosening the assertion so it
tolerates whatever appears would be exemption, and is refused.

### 4. The executed/derived partition must be observed, never assumed

The removed scenario must be **gone**, not reclassified from executed to derived.
ADR-0033 and ADR-0020:156 are exact and a derivation is never a skip.

Whichever side of the partition loses one, it must be shown to have lost it because the
scenario no longer exists. A partition that still sums correctly while a scenario has
silently migrated between buckets is the precise failure this rule exists to catch.

### 5. This authorization ends with the experimental protocol

When `outputProtocolVersion` leaves `v0-experimental`, truncation stops being
available and versioned compiler semantics becomes required, per ADR-0039 §4.

## What this ADR does not decide

- **How versioned compiler semantics would work.** Still the named successor, still
  undesigned.
- **Whether the conformance programme should tighten rules more slowly.** It should not;
  the rules are correct. What must change is that a rule-tightening packet checks the
  existing lineage against its new rule *before* freezing, rather than discovering it at
  the artifact boundary.
- **The five required search queries that can only return empty.** A third instance of
  the same class, found while answering this one. Recorded, not decided.

## Consequences

- **`5g3-write-scope` unblocks on its eighth finding.**
- **The lineage gets shorter and every entry in it is valid.** It proves less about
  incremental history and remains honest about what it proves.
- **A recurring cost is now visible instead of latent.** Every future conformance packet
  inherits an obligation: check the lineage against the new rule before freezing. That
  obligation is cheap when anticipated and expensive when discovered, which is the whole
  content of this ADR.
- **An exact control survives being changed.** The count moves, and it moves under a
  rule that makes fitting it a defect rather than a convenience.
