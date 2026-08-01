# ADR-0039: The output protocol is experimental, and lineage may be regenerated until it is not

Date: 2026-08-01
Status: accepted — ruled by the orchestrator on a stop-and-report from
`5g3-write-scope`, which refused to choose between two options rather than
picking one silently.
Tier: Critical (it governs when a compiled artifact's history may change)

## Context

`apps/web/scripts/compile-app-release.ts` does not store-and-trust the compiled
application lineage. `verifyExistingLineage` **recompiles every historical entry
from its stored `normalizedDefinitionBytes`** and compares the whole
re-serialized payload against the checked-in file, refusing with *"compiled
application lineage is invalid"* on any difference.

That design gives a strong property — the artifact is reproducible from its
inputs, so a hand edit cannot survive — and it carries an assumption that has now
been violated for the first time: **that the compiler's output is stable for a
given input.**

`5g3-write-scope` gives entity-owned create operations a derived legal-entity
input, because without it no draft record can be created through any user path.
That changes the emitted input contract. Historical lineage entries whose stored
definitions contain entity-owned creates therefore recompile differently, and a
full recompile rewrote **entries 4–7** rather than only the active one.

The writer correctly refused to proceed, naming two candidate resolutions —
versioned compiler semantics that reproduce historical output, or explicit
authorization to regenerate history — and noting that `G3-P5`'s precedent
regenerated only the active entry.

**That precedent does not govern this case, and the distinction is the whole
ruling.** `G3-P5` changed a module *definition*: a new lineage entry appeared and
historical entries recompiled identically because the compiler was unchanged.
`5g3-write-scope` changes the *compiler*: the same historical inputs now produce
different output. Changing the input adds history; changing the function rewrites
it.

The program has avoided this twice rather than settling it. `lang-adopt` cut
canonical language **v4 without adoption** precisely so that "every checked-in
root, golden and release artifact is byte-identical across this change"
(ADR-0031). `ver-agg` changed the compiler but moved nothing, because no
checked-in package carries an aggregate assertion. Write-scope cannot dodge:
entity-owned creates are exactly what the checked-in application contains.

## The fact that decides it

Every lineage entry in `apps/web/release/app.compiled.json` records:

    "outputProtocolVersion": "northstar.compiler-output/v0-experimental"

Two things follow, and they point the same way.

**The versioning hook already exists.** `outputProtocolVersion` is a per-entry
field, carried through to `packages/platform-runtime/src/release-records.ts:42`.
Whatever mechanism eventually reproduces historical output has somewhere to key
on.

**The compiler declares its own output shape experimental.** Treating historical
entries as immutable while the producing protocol is named `v0-experimental` is
not a conservative position — it is two incompatible claims held at once. The
artifact says which one is intended.

## Decision

### 1. While `outputProtocolVersion` is `v0-experimental`, historical lineage regeneration is AUTHORIZED

A compiler change that alters output for unchanged inputs may regenerate the
whole checked-in lineage, including historical entries. `verifyExistingLineage`
keeps doing exactly what it does; the regenerated artifact is the new truth.

This is safe **today and only today** because nothing durable depends on those
historical roots. Persisted release provenance comes from real activations in a
running system; there is no production, and test databases are ephemeral. That is
the actual content of "experimental" and it is why the window exists.

### 2. Regeneration is NAMED, never silent

Every packet that regenerates historical entries must record it as an **artifact
event** in its packet record: which entries moved, the before and after roots,
and why the compiler change made it unavoidable. A regenerated lineage that
appears in a diff without an accompanying statement is a defect, not a detail.

The reviewer must be told to check it. "Nothing moved" and "history was rewritten
and here is why" are both acceptable answers; silence is not.

### 3. Regeneration comes from a real recompile, never a hand edit

Unchanged, and worth restating because this ADR widens what may move:
`verifyExistingLineage` exists to make hand-edited artifacts impossible. Nothing
here relaxes that. If an artifact cannot be reproduced by running the repository's
compile scripts, that is a defect regardless of this ADR.

### 4. When the output protocol leaves experimental, this authorization ENDS

Declaring a stable `outputProtocolVersion` is the moment historical entries
become immutable in fact rather than by convention. From then on, a compiler
change that would alter historical output requires **versioned compiler
semantics** — reproducing each entry at the protocol version it records — and the
per-entry field in §"The fact that decides it" is the hook for it.

That transition is not free and must not be discovered late. Record it as owed
work now, so the cost is chosen rather than met.

## What this ADR does not decide

- **When the output protocol should leave experimental.** That is a program-level
  judgement tied to a real deployment, and it belongs to a stage cut.
- **How versioned compiler semantics would work.** Named as the successor
  mechanism; not designed here.
- **Whether persisted release provenance needs migrating** if history is
  regenerated after a real system exists. Out of scope precisely because §1's
  authorization is conditioned on that not being the case yet.
- **The storage-transition gap** (`5g3-resolveidx`) and ADR-0024's retention
  requirement. Different mechanism, separately recorded.

## Consequences

- **`5g3-write-scope` is unblocked** and may regenerate the lineage, naming the
  event.
- **The window is explicitly finite.** This ADR authorizes something it also
  schedules the end of, and the end condition is a field the artifact already
  carries rather than a judgement call.
- **A property is temporarily weaker than it looks.** Until the protocol
  stabilizes, "the checked-in lineage is immutable" is not true, and anyone
  reasoning from it is reasoning from convention rather than from a rule. Saying
  so plainly is the point of writing this down.
- **The avoidance pattern ends.** Twice the program has arranged for a compiler
  change to move nothing — v4 cut without adoption, `ver-agg` touching no
  checked-in aggregate. Those were good tactics that postponed a decision. The
  decision is now made, so the next compiler change can be judged on its merits
  rather than on whether it happens to dodge.
