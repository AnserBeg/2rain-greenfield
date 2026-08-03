# 5g3-searchcap — search capability is executable or refused

Status: candidate

Tier: Critical

Base: `f3fdf0d`

Integration base: `422c3bc0f50e314424b411d1a18b43584a206dae`

## Premise audit against `98bb392`

**Answer before conflict resolution:** `98bb392` does not supersede or
invalidate this packet's premise. It adds the registered Inventory posting
capability, routes `inventory_transaction_post` through it, derives capability
assertion subjects from operation read-back, and adds one executed declared
refusal to the verification plan. It does not derive search admission from the
lowered storage contract, reject a search with no usable normalized-text
column, or add the PostgreSQL runtime refusal; those mechanisms remain absent
from main and remain this packet's work.

The overlap is nevertheless semantic rather than incidental. I checked the
commit's changes to `compiler.ts`, `projections.ts`, the Inventory definition,
the three shared compiler controls, `inventory-onhand.test.ts`, and the composed
application control. Its capability-effect branch must be preserved alongside
the search rules. Its extra verification scenario also supersedes the packet's
old numeric baseline, so the 167 / 129 / 38 to 162 / 126 / 36 attribution must
be re-derived after the merge rather than carried forward. No search-capability
implementation is redundant; only the old counts and generated release bytes
are stale.

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

The merged main baseline is 168 scenarios: 130 executed and 38 derived. The new
head contains 163 scenarios: 127 executed and 36 derived. Main's additional
executed scenario is the registered posting-capability refusal from `98bb392`.
The five-scenario search delta is derived from the ruled definition changes,
not fitted to the observed totals:

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
application entries 0–5 retain these roots unchanged:

1. `a9c37c7784e726977cd32cd106ea441cfa5442568726bf04c60a0ec4e261e486`
2. `ba87d2155d9d8fcc2d7c12a058ccc44094857310f6bb2cf4c095955711e7aa05`
3. `bf932f8a4a69edc23c7a62c4191e1e9cf92c9482d38fc8bcef90945461615783`
4. `a8f6e2c14510a687a0eaa1e244d025dedc3062114d42d14861b26417e36e9420`
5. `ee5d474d50eb5243856fd11c7a3160f915b2fe6e1f85b57f2c443f6792e7e843`
6. `4b254f50b2f558e96b98325467ae339a4bd6492d9691ccb464eb88d1b53f3bb1`

One current head was appended with release root
`d726ad313780bc595c97a0ecb30c9eaec84984e4a19fa28c2e8f5361e7edf12e`.
Immediately after taking main's conflicted compiled artifact, and again after
regenerating every authored/compiled release file through its repository
script, the SHA-256 digests were:

| Artifact | Before regeneration | After regeneration |
| --- | --- | --- |
| `app.authored.json` | `0217868f16700ea8c770f5d569e3796594885d391185ada3d810c7807b066f37` | `0217868f16700ea8c770f5d569e3796594885d391185ada3d810c7807b066f37` |
| `app.compiled.json` | `f316b52cf9a40ff935882a789323ff6e7b97c9a06ee0a9409abf0156a0396533` | `a7282d06141017fea1a24fcb9fec33a508162abef6644ada7d2951c046122b49` |
| `shell.authored.json` | `9584ff11af5fcdb4fc786b626a4f061b2d470d3d82c09f427011820bf0aeb2eb` | `9584ff11af5fcdb4fc786b626a4f061b2d470d3d82c09f427011820bf0aeb2eb` |
| `shell.compiled.json` | `b7e98e880b4f10f00bfa67defc9e657b417b39093c52221a3b610135d07e9692` | `b7e98e880b4f10f00bfa67defc9e657b417b39093c52221a3b610135d07e9692` |

`generate-app-authored.ts` overwrote the auto-merged authored file with
identical bytes before `compile-app-release.ts` ran. Thus no generated value
was accepted from a textual merge. `check:app-release` and
`check:demo-release` both pass over the regenerated bytes.

The event is unavoidable because the six ruled first-party search declarations
change current normalized input and lowered query/storage output. No historical
bytes, protocol version, or recorded root were hand-edited.

The independently checked shell demo release remains a compiler-output
consumer. It was regenerated through
`pnpm --filter @north-star/web build:demo-release` and then the repository
formatter. The raw generator emitted digest
`bf3385dd0b14bca8c916622962c784feb78266caa25c634477da2f5f2f7d5b5a`;
the formatter restored the table's checked-in digest without changing JSON
semantics. Its release root remains
`a2f88c9b681b323ee113cde5c2d06e92e4ff25744c7bb72cd5e3310d7a76ea4f`,
and the exact digest movement at integration is in the table above. The
shell's authored definition is unchanged. Its stable semantic root plus moved
serialized digest is verified by `check:demo-release`; no shell artifact value
was edited by hand.

## Merged-tree limit audit

The recorded boundaries remain accurate against integration base
`422c3bc0f50e314424b411d1a18b43584a206dae`. The `searchable` factory default
is still `false`; only the five ruled first-party fields opt in. Search uses the
existing folded-match machinery, and neither list paging nor shared-list
coverage changed. No relation-corpus input changed. Main did change generic
compile-budget instrumentation before this merge, but neither main nor this
packet added a search-specific budget, timeout, tmpfs allowance, capacity
limit, or performance baseline. Those items therefore remain open limits rather
than claims closed by the newer base.

The one limit that did change is verification-plan size: main added the posting
capability's executed declared refusal. The merged 168 / 130 / 38 baseline and
163 / 127 / 36 head above replace the stale branch counts.

## Gate evidence

Before freezing, typecheck passed twice around merge cleanup. Unit passed 77/77;
compiler passed 117/117; `inventory-onhand.test.ts` passed 4/4; and
`composed-application.test.ts` passed 11/11 in 253.5 seconds with the named
historical rollback refusal, the posting route, and the exact 163 / 127 / 36
partition. `check:app-release` and `check:demo-release` passed after scripted
regeneration. The frozen full-matrix verdict is recorded below after its single
integration run.

The first matrix attempt at `392d24d662e62d6c3e0e56c23575642d55bfdae3`
stopped at formatting after its isolated performance gate passed. Exact red:

```text
[warn] apps/web/release/shell.compiled.json
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
[ELIFECYCLE] Command failed with exit code 1.
FULL_MATRIX_FAILED rc=1 sha=392d24d662e62d6c3e0e56c23575642d55bfdae3
```

The correction ran Prettier only on that generated file; targeted Prettier and
`check:demo-release` checks then passed. The SHA moves visibly in the next
commit; the red SHA is not a candidate.
