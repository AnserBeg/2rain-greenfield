# 5g3-txtitle — Deliberate Inventory resolve authorities

Lane: KERNEL · Tier: Behavioral · Branch: `packet/txtitle` · Initial base: `40bf00d`

Status: blocked on a compiler-owned storage-transition bridge.

Stop count: 1. The implementation attempt was discarded; this record preserves
the accepted design and the platform dependency for a fresh relaunch after
`5g3-resolveidx` lands.

## Deliberate resolve fields

The relaunched packet must make every standard Inventory entity declare its
resolve authority with a named field id rather than inheriting the first entry
of `fieldsForEntity`. Field order must remain unchanged.

| Entity | Resolve field | Reason |
|---|---|---|
| `legal_entity` | `legal_entity_code` | The code is its stable, concise business key; the name remains descriptive content. |
| `inventory_transaction` | `inventory_transaction_number` | The transaction number is the operator-facing document identity, such as `ADJ-BROWSER-001`. |
| `inventory_transaction_line` | `inventory_transaction_line_line_number` | A line is identified within its parent transaction; its line number is recognizable in that context, while the available item field is a raw UUID and is also non-unique globally. |
| `inventory_period_lock` | `inventory_period_lock_closed_through` | The locked-through period is the only authored field and states what the record controls. |
| `stock_count` | `stock_count_number` | The count number is the declared business key and operator-facing document identity. |
| `stock_count_line` | `stock_count_line_line_number` | A count line is identified within its parent count; the line number communicates that identity better than a repeated raw item UUID. |

## Controls from the discarded attempt

- A compiler control decoded the query-catalog projection and pinned all six
  resolve query ids to the exact named field ids above. It also requires one
  `resolverAuthority` verification scenario for each resolve query.
- Replacing the explicit field ids with `entityFields[0]` is the negative arm:
  it changed transaction, transaction-line, stock-count, and stock-count-line
  authorities and made the compiler control red during the attempt.
- The composed browser journey followed the seeded transaction row to its real
  record page and required the level-one title `ADJ-BROWSER-001`; it passed
  before the implementation was discarded.
- The attempted compiler artifact contained one `resolverAuthority` scenario
  for every standard entity. End-to-end release-verification execution was not
  observable because staged PostgreSQL activation refused at storage
  preparation before verification began.

## Observed artifact event

The authored and compiled application release artifacts moved during the
discarded attempt. They were generated from `composedApplicationDefinition()` through
`generate-app-authored.ts` and `compile-app-release.ts`; neither file is edited
by hand. The attempted lineage advanced from entry 8 at release root
`9e3f36df340bc3db500929ca90f14a93238e0027799bcf782a9da6abda27d58d` to entry
9 at release root
`1ea8715cef2983df0b81ee8b67b29623b3a060db0e57302b4229c952e11ea16c`.
`check:app-release` independently recompiled and accepted the result. Both
artifact changes were reverted with the implementation and are not candidates
for integration.

This is not only a query-catalog event. Storage lowering derives generated
folds and `resolveAccess` indexes from resolve match fields
(`packages/compiler/src/storage.ts:679-723,822-874`). The storage-target root
therefore moved from
`30e58794eee1d8c61c432d3629e61b3bcc393091c5e8b08ec2ac8454b98ad7d9`
to
`ba3bd8c895b8b0b7edc52df11cf7d5a10244da927d306c470432bc41d98fd5e7`.

## Stop — resolve-authority storage evolution is not representable

The recompiled transition correctly binds the old and new storage-target roots
but contains `elements: []`. The target has these real changes:

- transaction and stock-count no longer require their former actor-id folded
  columns and folded-access indexes; their chosen number fields already have
  business-key folds and unique indexes;
- transaction-line no longer requires its former from-location fold and
  folded-access index, while stock-count-line no longer requires its former
  count-quantity `resolveAccess` index; both instead require `resolveAccess`
  indexes for the selected integer line-number fields.

Transition lowering only visits newly added folded columns and creates indexes
attached to those additions (`packages/compiler/src/storage.ts:1970-2006`). It
does not emit a newly required non-folded `resolveAccess` index, and it neither
represents nor refuses retirement of old resolve-derived folds and indexes.
The staged composed-product PostgreSQL control consequently fails closed with
`CATALOG_DRIFT` at
`packages/postgres-provider/src/module-storage-materializer.ts:370-390` before
release verification is invoked.

Fixing that would require a compiler-owned decision and controls for the
storage-transition contract: either an additive retention rule for former
resolve-derived objects or an explicit retirement protocol, plus transition
emission for newly required non-folded resolve indexes. Making old UUID fields
searchable merely to preserve their physical folds would change authored search
semantics to hide the transition gap, so this packet does not do that. It also
does not hand-edit the compiled transition, weaken catalog attribution, or
claim that emitted verification scenarios executed.

## Scope

No field order, posting behavior, migration, privilege, budget, client-side
JavaScript, hex literal, or UX vocabulary changes. No new test file is added.
