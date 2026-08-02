# ADR-0041: A declared shape is honoured or refused, never silently ignored

Date: 2026-08-02
Status: accepted — ruled by the orchestrator after `5g3-langcover` phase 1 and an
independent two-arm debate each found the same defect without prompting.
Tier: Critical (it narrows the canonical language)

## Context

The canonical language admits three relation cardinalities
(`packages/canonical-model/src/schemas.ts:583`) and two join-eligibility values
(`:591`). Neither reaches storage.

`StorageRelationTarget` (`packages/compiler/src/storage.ts:497-516`) carries neither
field, and `storage.ts` never mentions either one. The only guard is
`packages/canonical-model/src/normalize.ts:1442-1460`, and it iterates `parentScopes`
only — so it constrains cardinality for `parentScopedChild` relations and says nothing
about `reference` relations. Nothing anywhere constrains `joinEligibility`;
`normalize.ts:466` strips the value `none` from authored form and no consumer exists.

So a module author may declare a `reference` relation as `oneToOne`. It is accepted,
normalized, compiled, and lowered as a plain nullable foreign key with no uniqueness
constraint. Two records may then point at the same target. Nothing refuses, nothing
warns, and the resulting data is silently wrong in a way no gate observes.

This is the defect class the program calls its worst — declared but unenforced. It is
the second confirmed instance. `stateMachines` is the first: compiled into
`derivedStateFields`, materialized, and enforced by nothing.

Three independent readings reached this conclusion without coordination: the phase-1
audit, and both arms of the language-coverage debate. Two of them found it while
answering a question about something else.

## The distinction that decides it

A language construct can be in exactly one of three states, and only two are
acceptable.

**Honoured.** The machinery implements the semantics the construct declares.

**Refused.** The construct is rejected at authoring time with a named diagnostic, so
the author learns immediately that the platform does not support it.

**Accepted and ignored.** The construct is admitted, carried through compilation, and
then dropped. The author is told, by the system's silence, that their declaration took
effect.

The third state is worse than either alternative, because it is indistinguishable from
success at every point where anyone would look. A missing feature announces itself. A
declaration that is quietly discarded does not.

## Decision

### 1. The language is narrowed to what the platform honours

Relation cardinality is restricted to the value the storage lowerer actually
implements. Join eligibility, having no consumer and no current need, is likewise
removed from the admitted surface.

### 2. Declined values are refused at authoring time, never coerced

A module declaring a declined value must be **rejected with a named diagnostic**.
Silently coercing it to the supported value would be the same defect wearing the
costume of a fix: the author still believes the declaration took effect.

### 3. Nothing is implemented on spec

`oneToOne` has real semantics — a uniqueness constraint — and implementing it is
tractable. It is not implemented here, because no module needs it and no consumer
exists. **When a module needs one-to-one, it arrives together with its enforcement**,
and the negative control proving the constraint refuses a duplicate.

This is not a judgement that the shape is undesirable. It is a refusal to ship a
spelling ahead of its meaning, which is how both instances of this defect class were
created.

### 4. The window is why this happens now

ADR-0039 authorizes regenerating compiled lineage only while `outputProtocolVersion`
is `northstar.compiler-output/v0-experimental`. Once the protocol stabilizes, altering
historical output requires versioned compiler semantics.

Narrowing the language will never be cheaper than it is today. That timing is part of
the ruling, not a coincidence. ADR-0039 §2's obligation applies in full: any
regeneration must be **named** — which entries moved, their before and after roots,
and why — and must come from a real recompile rather than a hand edit.

## What this ADR does not decide

- **The `stateMachines` question.** Same defect class, materially different stakes,
  and it has its own debate charter. The next planned modules are built from state
  machines, so declining that spelling is not symmetric with declining this one.
- **Whether one-to-one relations should eventually exist.** §3 defers the capability,
  not the question.
- **The language-coverage instrument.** Separately designed. This ADR closes one
  defect that instrument found; it does not build the instrument.
- **Whether other axes** — fields, formulas, surfaces — carry the same defect. Phase 1
  scoped its measurement to relations and graph shape. The others are unmeasured, and
  unmeasured is not the same as clean.

## Consequences

- **A silent data-integrity defect is closed.** A `reference` relation declared
  `oneToOne` can no longer be accepted and discarded.
- **Artifact and golden churn is expected and authorized.** That cost is what the
  experimental window exists to absorb, and naming it is required.
- **The language gets smaller, and says only what it means.** For a platform whose
  premise is that a module is data, the language is the product surface. A spelling
  that does nothing is a false promise made to every future module author.
- **A general rule now exists to apply to the next instance.** Honoured or refused.
  When the coverage instrument lands, "accepted and ignored" becomes a state the gate
  can name rather than a state that has to be stumbled upon — twice, by accident,
  while looking for something else.
