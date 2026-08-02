# ADR-0042: Resolve is required where a text key exists, and refused where it does not

Date: 2026-08-02
Status: accepted — ruled by the orchestrator after `5g3-write-scope` stopped a seventh
time, under a stop condition the previous packet set deliberately.
Tier: Critical (it changes what a conformance gate requires)

## Context

`REQUIRED_QUERY_TYPES` (`packages/compiler/src/conformance.ts:13`) requires `get`,
`list`, `resolve` and `search` on **every** entity.

A resolve query is a lookup by typed business key: a person types a code or a name and
the system returns the record. The runtime executes it only against a text-backed
storage column (`packages/postgres-provider/src/module-runtime-interpreter.ts:2361`).

Not every entity has such a key. `inventory_period_lock` has exactly one field,
`closed_through`, a `timestamp(3) with time zone`. There is no text column, and no other
field to choose. **The requirement is unsatisfiable for that entity.**

Inventory satisfied it formally rather than actually: `definition.ts:770` hands
`entityFields[0]!` to every entity as its resolve key. Whatever field happens to be
first becomes the declared lookup key. That produced three declared resolve queries
that cannot execute:

- `inventory_transaction_line_resolve` — `from_location_id`, canonically text but
  lowered to `uuid`
- `stock_count_line_resolve` — `counted_quantity`, `numeric(38,18)`
- `inventory_period_lock_resolve` — `closed_through`, `timestamp(3) with time zone`

None of this surfaced until `5g3-write-scope` made entity-owned scenarios executable.
Until then the queries were declared, compiled, and never run.

This is ADR-0041's defect class one level up. That ADR ruled on shapes the *language*
admits and the machinery ignores. This is a shape the *conformance gate* demands and
the runtime cannot execute — and the gate was satisfied by a declaration that does
nothing, which is the outcome ADR-0041 exists to forbid.

## The distinction that decides it

A universal requirement is only meaningful if it is universally satisfiable. Requiring
resolve on an entity with no text key does not produce a lookup; it produces a
placeholder, because the author has no way to comply honestly.

The gate was not observing "this entity is resolvable." It was observing "this entity
declared something in the resolve slot." That is a proxy, and AGENTS.md §6 forbids
proxies precisely because they pass when the fact is absent.

The fact worth asserting is: **an entity that CAN be resolved by typed text MUST expose
that lookup.** That is real, checkable, and cannot be satisfied by a placeholder.

## Decision

### 1. Resolve is required if and only if the entity has a text-backed resolvable column

The condition is **structural, derived from the entity's lowered storage**, never a
choice the author makes. An author cannot elect to skip resolve on an entity that has a
text key, and cannot be forced to invent one on an entity that does not.

### 2. The compiler refuses a resolve key whose lowered column is not text-backed

The check must observe the **lowered** storage column type, not the canonical field
type. `from_location_id` is canonically text and physically `uuid`; a canonical-type
check would admit it and prove nothing. This is the observe-the-fact rule applied to the
exact place it was previously violated.

### 3. Entities with no text-backed column declare no resolve query

`inventory_period_lock` loses a resolve query. **No capability is lost, because that
query could never execute.** What changes is that the absence is now honest and visible
rather than disguised by a declaration.

### 4. Typed and non-text resolve execution is NOT implemented here

Resolving a period lock by date is a coherent idea and may eventually be worth
building. It is not built now, because nothing needs it and ADR-0041 §3 already ruled
the general case: a spelling arrives together with its enforcement, never ahead of it.

Recorded as a deferred capability. When an entity genuinely needs lookup by a non-text
key, that capability arrives with the execution path and the control that proves it.

### 5. Blind key selection ends

`entityFields[0]` is not a business key. It is whatever the author listed first. A
resolve key must be chosen deliberately and must be resolvable; the compiler refusal in
§2 makes an undeliberate choice fail loudly instead of silently.

## The negative control this ADR stands or falls on

**An entity that HAS a text-backed column and omits its resolve query must still be
refused.**

Without that, §1's conditionality degrades into optionality, and an author could quietly
drop a lookup that users need. The gate must fail in both directions: refusing an
unresolvable key, and refusing a missing resolve where one is possible. A packet
implementing this ADR without that second control has not implemented it.

## What this ADR does not decide

- **Whether `get`, `list` and `search` carry the same defect.** They are required by the
  same list and were not examined. Unmeasured is not the same as clean, and this is
  recorded as owed.
- **How non-text resolve would work.** §4 defers the capability, not the question.
- **The `#inventory-reference` press-boundary debt** (recorded 1e-2): named domain policy
  duplicated as module knowledge inside the generic compiler. Different mechanism,
  separately recorded, belongs to the language-coverage work.

## Consequences

- **`5g3-write-scope` unblocks on its seventh finding**, which is again a real platform
  defect it merely exposed rather than caused.
- **A conformance requirement gets smaller and truer.** It will assert something it can
  observe, on the entities where it means something.
- **One more instance of the program's worst defect class is closed** — and it is the
  second found in two days by asking "what does the language permit that nothing
  exercises?" That question is now earning its keep, and the instrument that asks it
  systematically is already designed.
