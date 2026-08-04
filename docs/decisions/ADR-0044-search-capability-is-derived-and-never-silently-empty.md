# ADR-0044: Search capability is derived from lowered storage, and an unusable search refuses rather than returns empty

Date: 2026-08-02
Status: accepted — ruled by the orchestrator from a read-only diagnostic, after
`5g3-write-scope` surfaced the defect while answering a different question.
Tier: Critical (its failure mode is a silently wrong answer)

## Context

A search query works only where three things coincide: a field authored
`searchable: true`; a lowered column carrying `searchMapping: 'normalizedTextIndex'`
(`packages/compiler/src/storage.ts:2420`, folded column at `:688`); and a search query
selecting that field. At execution, `matchRecords` intersects the query's selections with
those mappings and, **when the intersection is empty, returns `[]` without issuing any
SQL** (`packages/postgres-provider/src/module-runtime-interpreter.ts:2307`).

Six first-party search queries have an empty intersection. Five are in the composed
application — `inventory_movement`, `inventory_period_lock`, `inventory_transaction_line`,
`party_role`, `stock_count_line` — and a repository-wide sweep found a sixth,
`northstar.platform:query.saved_filter_search`, whose `name` column even *has* a folded
column because resolve uses it.

Only one is structurally impossible: `inventory_period_lock` has a single field,
`closed_through`, physically a timestamp. **The other five are definition oversights.**
Inventory's helper defaults every unannotated field to `searchable: false`
(`packages/domain/src/inventory/definition.ts:1032`), and Party explicitly marks both role
enums false (`packages/domain/src/party/definition.ts:304`), so capable columns exist and
none was ever selected.

## Why this is worse than the resolve defect it resembles

ADR-0042 ruled the same shape for resolve: required only where structurally possible,
refused otherwise. Resolve at least **failed** — loudly, with a typed refusal.

**An unusable search returns a plausible answer.** The diagnostic established that empty
is indistinguishable from no-matches at every layer:

- **Runtime** — zero mapped columns produces `'exact', records: [], unsupportedReason: null`,
  byte-identical to a legitimate no-match (`module-runtime-interpreter.ts:1218`, `:3001`).
- **The conformance gate** — it requires only that a search declaration *exists*
  (`packages/compiler/src/conformance.ts:1352`).
- **The screen** — an exact empty result renders the ordinary "No records yet" state
  (`apps/web/src/surface-runtime.ts:665`).

A caller cannot tell "this search is broken" from "nothing matched." That is a silently
wrong answer, which `review-tiers` names as staying Critical wherever it lives.

**One honest limit on the blast radius, established rather than assumed.** First-party
list screens bind the *list* query, not the semantic search query; their `q` parameter
uses the shared-list path, which folds every selected display value
(`module-runtime-interpreter.ts:1944`). A PostgreSQL control proves `party_role_list`
finds "Customer" despite `party_role_search` being empty-only
(`test/postgres/table-behavior.test.ts:137`). So **today's screens are not returning wrong
results.** What is silently wrong is the direct semantic-search contract — the one agents
and API consumers use, and which this program has committed to serving identically.

`get` and `list` carry no equivalent defect: 12/12 have record-identity columns, complete
storage selections, and working infrastructure. ADR-0042 recorded them as unmeasured; they
are now measured and clean.

## Decision

### 1. Search capability is derived from LOWERED storage

A column is search-capable when its supported field kind and its **physical text storage**
say so — not its canonical type, and not merely the authored `searchable` flag.

This is the same observe-the-fact correction ADR-0042 made for resolve, and for the same
reason: execution consumes the lowered column, so the check must read what execution reads.

### 2. Required if and only if structurally possible

Where an entity has at least one search-capable column, a search query is required **and at
least one of its selections must actually carry a `normalizedTextIndex` mapping.** A
declaration that selects nothing usable is refused at compile time.

Where an entity has no search-capable column, no search query is required, and a declared
one is refused. `inventory_period_lock` loses its search query; nothing is lost, because it
could never return a result.

Which capable field becomes searchable remains the author's choice. Party's deliberate
`searchable: false` on its role enums is a legitimate decision; what is not legitimate is
every capable field being unmarked while a search query is declared anyway.

### 3. The runtime refuses instead of returning a plausible empty

**This is the part that does not follow ADR-0042, and it is the point of this ADR.**

A registered search that resolves to zero usable columns must produce a **named refusal**,
not `[]`. Compile-time enforcement alone would leave the runtime still capable of answering
a broken query with a confident, empty, wrong answer.

Defence in depth is normally optional. Here it is required, because §"Why this is worse"
establishes that the failure is invisible to every observer — and a gate cannot be the only
protection against a fault whose symptom is indistinguishable from success.

### 4. The existing exclusion control is vacuous and must be repaired

`searchableExclusion` accepts the empty response as its negative result and may obtain its
positive witness **from another entity**
(`packages/postgres-provider/src/release-verification-service.ts:1414`). A control that can
draw its positive evidence from a different entity than its negative one does not prove
that this entity's search works.

It must obtain both witnesses from the same entity, or it is not observing the fact it
asserts (AGENTS.md §6).

### 5. The correction is repository-wide

All six queries are in scope, including `saved_filter_search` in the platform package. A
rule applied only to the composed application would leave the same defect live in the first
first-party platform module.

## What this ADR does not decide

- **Whether the shared-list path has an analogous defect.** It folds every selected display
  value and demonstrably works, but it was examined only far enough to establish that
  screens are unaffected. Unmeasured is not clean — recorded as owed.
- **Whether `searchable` should default to true.** Inventory's helper defaulting to false is
  what produced five of six instances. Changing a default has wide blast radius and belongs
  to a packet that can measure it.
- **Agent-facing search semantics** beyond refusing the broken case.

## Consequences

- **A silently wrong answer becomes a named refusal**, at compile time and again at runtime.
- **Five definitions gain a deliberate search authority**, each one already the entity's
  resolve key or a supported enum — so the corrections are small and already justified.
- **A third instance of this class is closed.** ADR-0041 ruled shapes the language admits
  and nothing honours; ADR-0042 ruled a required query that could not execute; this rules a
  required query that executes and lies. All three were found by asking what the
  specifications permit that nothing exercises, which is now a standing instrument rather
  than a series of accidents.
