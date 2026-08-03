# 5g3-searchcap — search capability is executable or refused

Status: candidate

Tier: Critical

Base: `f3fdf0d`

## Outcome

Search capability is now derived from the lowered storage contract. A search
declaration is admitted only when its source entity has a supported field kind
backed by physical text storage and at least one selected field carries a
`normalizedTextIndex` mapping. An entity with no such column may omit search;
declaring search for it is refused.

The PostgreSQL interpreter independently refuses a registered search that
resolves to zero usable columns with
`MODULE_SEARCH_CAPABILITY_UNAVAILABLE` and the exact query ID. It no longer
returns a plausible empty result for a capability it cannot execute. This
runtime check applies to historical releases as well as current ones.

The following first-party definitions changed:

- Inventory movement searches `source_id`.
- Inventory transaction line searches `unit_id`.
- Inventory stock-count line searches `unit_id`.
- Party role searches `role_kind`.
- Platform saved filter searches `name`.
- Inventory period lock declares no search because it has no capable lowered
  column.

The `searchable` default remains unchanged. Shared-list behavior, the relation
corpus, budgets, timeouts, tmpfs capacity, and performance baselines are out of
scope and unchanged.

## ADR-0045 historical integrity boundary

Existing lineage entries are reproduced from their recorded normalized bytes
and bound to their exact recorded release roots. Structural compilation,
transition validation, artifact closure, and byte-for-byte serialization still
fail closed. Current conformance rules are not retroactively imposed on those
historical authored inputs.

A freshly authored head has no access to that path: the append path invokes
strict `compileApplication` directly. The control first reproduces the real
recorded lineage, then submits a newly authored head whose
`stock_count_line_unit_id` is not searchable. It observes
`COMPILER_SEARCH_SELECTION_STORAGE_UNUSABLE`. The initial control incorrectly
fed normalized bytes to the authored parser and therefore failed before the
intended authority; it was repaired to use a real authored definition.

After the split, every retained historical entry reproduces its recorded root,
the checked-in head compiles under current rules, and
`compile-app-release.ts --check` passes.

## ADR-0046 rollback behavior

The immediate historical rollback target remains eligible for activation; no
current-conformance precheck was added to rollback. Admission verification of
that target reaches its pre-existing broken
`northstar.app:query.stock_count_line_search` and now refuses with
`MODULE_SEARCH_CAPABILITY_UNAVAILABLE` and that exact query ID. The rollback
control asserts this named refusal instead of treating the conversion from a
silent empty answer as a regression. No versioned historical runtime semantics
were introduced.

## Controls and negative directions

- **Lowered capability requirement.** Removing the capable-column check admits
  an entity with no executable search selection; the compiler control then
  fails because it requires
  `COMPILER_SEARCH_SELECTION_STORAGE_UNUSABLE`.
- **Structurally impossible search.** Period lock compiles without search and a
  mutated declaration of its old search is refused with
  `COMPILER_SEARCH_QUERY_STORAGE_UNSUPPORTED`.
- **Required capability.** Removing Item's search while its lowered storage has
  capable text columns is refused with `COMPILER_SEARCH_QUERY_REQUIRED`.
- **Runtime backstop.** A forged issued candidate view registers a search whose
  only selected field has no normalized-text mapping. The real interpreter
  refuses with `MODULE_SEARCH_CAPABILITY_UNAVAILABLE` and the query ID. Without
  the check, the same request returns the plausible empty result.
- **First-party positive witnesses.** Real PostgreSQL searches return an
  Inventory movement by source ID, a Party role by role kind, and a saved filter
  by name. The composed verification run executes transaction-line and
  stock-count-line searches through their same-entity witnesses.
- **Non-vacuous searchable exclusion.** Positive and negative witnesses now
  come from the same entity and query. The former cross-entity fallback is
  absent; the repaired control fails against the old empty-only behavior.
- **Strict new head.** A real newly authored non-conformant head is refused
  after the existing historical entries reproduce, proving leniency cannot be
  selected for fresh compilation through the repository script.
- **Historical defect is named.** The rollback control pins the exact runtime
  refusal and subject instead of accepting any failure.

## Exact verification partition attribution

The branch baseline is 167 scenarios: 129 executed and 38 derived. The new
head contains 162 scenarios: 126 executed and 36 derived. The five-scenario
delta is derived from the ruled definition changes, not fitted to the observed
totals:

| Prior partition | Removed scenario | Ruled reason |
| --- | --- | --- |
| derived | `inventory_movement_source_id` searchable exclusion | `source_id` became the movement search authority; movement still has no generic create |
| executed | `stock_count_line_unit_id` searchable exclusion | `unit_id` became the stock-count-line search authority |
| executed | `party_role_kind` searchable exclusion | `role_kind` became the party-role search authority |
| executed | `inventory_transaction_line_unit_id` searchable exclusion | `unit_id` became the transaction-line search authority |
| derived | `inventory_period_lock_closed_through` searchable exclusion | the structurally impossible period-lock search declaration was removed; period lock has no generic create |

The control reads both the prior compiled plan and the new head. It finds each
old scenario by exact kind, entity, and subject, checks its prior executed or
derived disposition, requires all five identities to be absent from the new
plan, and requires that no new scenario ID replaced them. It also proves these
are every removed ID. Thus the totals reconcile exactly as `-3` executed and
`-2` derived; no scenario moved from executed to derived.

## Artifact event — ADR-0039 §2

The artifact was regenerated only through the repository scripts. Historical
application entries 0–4 retain these roots unchanged:

1. `a9c37c7784e726977cd32cd106ea441cfa5442568726bf04c60a0ec4e261e486`
2. `ba87d2155d9d8fcc2d7c12a058ccc44094857310f6bb2cf4c095955711e7aa05`
3. `bf932f8a4a69edc23c7a62c4191e1e9cf92c9482d38fc8bcef90945461615783`
4. `a8f6e2c14510a687a0eaa1e244d025dedc3062114d42d14861b26417e36e9420`
5. `ee5d474d50eb5243856fd11c7a3160f915b2fe6e1f85b57f2c443f6792e7e843`

One current head was appended with release root
`1eb9dcb3be5d1f62d1b4d91cb4ebc00723e16d63e694bf6c8e518621b66975c6`.
The compiled artifact SHA-256 moved from
`431f15d6a7e76c37641caacdd063f263567eb4079e6785a77c4c57af2e8bcd36`
to
`fcf695b14fc148b322289815f39e5d72a1cf87764476cc2d2230a3c1ef32fdcf`;
the authored artifact moved from
`8c2e03e667ca6e0a1361bdf7165ddede57ddda59f7c8266a638959a4479b379b`
to
`a2639d49f5da84d565a49bbf9bc551c958ef401347cf103f14023f0e546e2800`.

The event is unavoidable because the six ruled first-party search declarations
change current normalized input and lowered query/storage output. No historical
bytes, protocol version, or recorded root were hand-edited.

## Gate evidence

Typecheck passes. The repaired strict-head control passes in isolation. The
complete composed activation parent passes in 166.2 seconds with the named
rollback refusal and the exact 162 / 126 / 36 partition. Focused compiler,
module-runtime, Inventory, Party, and saved-filter controls passed during
authoring. The frozen full-matrix verdict is recorded in the writer handoff.
