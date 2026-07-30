# G3-P4b — Stock-count correction posting

Status: author-gated implementation candidate; matrix and Critical review
deferred by orchestration
Tier: Critical
Lane: FIX
Base: `ebea719` (`packet/g3-p4`)
Frozen candidate: the packet commit containing this record; exact SHA is in
the author handoff

## Outcome

This packet adds the missing `stock_count` and `stock_count_line` evidence
families and admits initial count, compensating correction, and exact reversal
as one additive command family in the existing Inventory posting service. It
does not add a second movement writer or restructure the private `#post`.

ADR-0029 supplies the authorization ADR-0026 and ADR-0027 require. Dependency
set v4 adds only the count-session read, count-line read, and count-state
transition needed by the implementation. The before/after dependency roots
are:

- v3 (32 entries):
  `35fc38eaca7fbe47d8da5030ceefce8211a2194a25d233c45282ef0450d553ad`;
- v4 (35 entries):
  `ffd4e9f6103b5c6053c39b62fe64e69dd255cb0c86cfd349ae465ab25179b3d3`.

The compiled release root changes from
`3a50e80ba684cef8049a70be7fff13b3da063df4a93f2a759c7ca6d63b40bf85`
to
`06d0477cfcb68096dbe41782183be3687cad7031665db0f9dd755d9c5ce3fac0`.
This is a governed domain/dependency protocol event, not a canonical-language
version event.

## Domain declarations owned and touched

Only the following declaration concern was changed in
`packages/domain/src/inventory/definition.ts`:

- entities: `stock_count`, `stock_count_line`;
- `stock_count` fields: number, kind, state, Location, counted-at,
  recorded-at, actor, reason code, and reason narrative;
- `stock_count_line` fields: line number, Item, expected quantity, counted
  quantity, variance quantity, unit, and reversed movement ID; and
- relations: count-to-transaction, count-to-superseded-count,
  line-to-count, and line-to-transaction-line.

No SurfaceDefinition declaration block was edited. The existing definition
helpers derive the ordinary generated storage/query/operation/surface
scaffolding from the entity list; this packet did not alter the surface
grammar or add a UI concern.

The reviewed surface-grammar debt increase is 33: 32 ordinary per-entity
violations (16 each for `stock_count` and `stock_count_line`) plus one new
`SG008_COMPACT_NAVIGATION_BUDGET` violation as Inventory grows from five to
seven compact-navigation lists. G3-P6c owns that SG008 debt and is expected to
remove it when navigation grouping lands; the two-way baseline ratchet will
then require Inventory's recorded count to move down again.

## Posting behavior

`postStockCount` validates one closed session and line set, then delegates to
the same private `#post` as adjustment and transfer. The shared order remains:

1. `BEGIN`;
2. transaction-local `lock_timeout = 15000ms` via
   `set_config(..., true)`;
3. all stock identity locks;
4. request-key lock;
5. release/configuration and business reads, with validation-only row locks
   using `FOR NO KEY UPDATE`;
6. serialized negative-stock, reason, approval, backdate, and period checks;
7. one savepoint containing movement append plus both state transitions; and
8. persisted read-back, trust/outbox/receipt append, and commit.

Every line requires `varianceQuantity = countedQuantity - expectedQuantity`.
The initial movement uses role `count`; correction and reversal movements use
role `correction`. A correction appends a new linked session. A reversal must
name the prior movement from the immediately superseded session and append its
exact quantity inverse. Original sessions, lines, movements, and trust facts
are retained.

Receipt digest/result version 3 is used only for stock count. Readers continue
to select v1, v2, or v3 from the persisted artifact version. Migration 0017
extends the existing constraint without rewriting old rows.

## Decisive controls and victims

The controls are in the new CI-discovered
`test/postgres/inventory-stock-count.test.ts` plus the compiler contract cases.
Line numbers below are frozen after formatting and identify the production or
test victim each control is intended to catch.

| Control | Exact victim whose deletion or mutation must turn it red |
|---|---|
| Three independently readable quantities | Production victims are the separate `countedQuantity`, `expectedQuantity`, and `varianceQuantity` read-back assignments at `inventory-posting-service.ts:2852`, `:2853`, and `:2861`; test victims are the three independent assertions at `inventory-stock-count.test.ts:409`, `:414`, and `:419`. Dropping expected loses what the system believed, dropping counted loses what was found, and dropping variance loses the exact posted delta. |
| Persisted count-to-movement evidence | Victims are the persisted transaction-line relation selected at `inventory-posting-service.ts:2819` and the resulting `movementId` assignment at `:2855`; deleting either breaks the observed linked correction. |
| Compensating correction | Victims are the `supersedesStockCountId` comparison at `inventory-posting-service.ts:2491` and the posted-prior check at `:2612`; deleting either permits an unlinked compensation. |
| Exact reversal | Victims are the negated exact-decimal comparison at `inventory-posting-service.ts:2680` and the movement reversal field binding used by `insertMovement` at `:2123`; deleting either makes the observed inverse/link assertions at `inventory-stock-count.test.ts:238-242` and `:284-286` fail. |
| No hard delete | The victim is the generated module-role denial exercised by both `DELETE` statements at `inventory-stock-count.test.ts:289-300`, followed by retained counts at `:306-308`; granting either count entity a hard-delete path or deleting earlier data changes the verdict. |
| Dependency v4 exhaustive-by-construction | Victims are the v4 version expectation at `conformance.ts:2505-2506` and the root recomputation of both arrays at `:2542-2547`; deleting a count dependency or adding an undeclared access fails the compiler cases. |
| Shared posting protocol | Victims are the count hook into `#post` at `inventory-posting-service.ts:610-617` and the one shared savepoint at `:675`; the real query assertions at `inventory-stock-count.test.ts:471-497` require stock lock then request lock before the first count read, transaction-local `true`, and exactly one savepoint. |
| No monetary count member | Victims are the recursive value check at `conformance.ts:1853` and key check at `:1870`; the negative control at `inventory-stock-count.test.ts:333-339` proves `{fieldId: 'unitCost', newState: {value: '1.00'}}` is observed. A property-name-only scan fails that red. |
| Version from persisted artifact | Victims are `digestCommand(posting, receipt.input_digest_version)` at `inventory-posting-service.ts:3183` and the stored-version branch beginning at `:3633`; replacing either with today's writer version breaks old v1/v2 compatibility or v3 evidence replay. |

## Verification state

Per the orchestrator's steering update, the author ran only:

```bash
corepack pnpm format && corepack pnpm typecheck && corepack pnpm lint
```

Then commit and stop. The full matrix, `check:schema`, focused PostgreSQL tests,
and Critical review chain are deliberately not author-run in this round.
`check:schema` is known to fail on the stacked base because migration 0016 was
landed without regenerating `db/schema.snapshot.json`; that file is outside
this packet's ownership and was not edited. The orchestrator will merge the
separate snapshot fix before authorizing the matrix.

Author-gate verdicts: format PASS; TypeScript typecheck PASS; ESLint PASS.

The program-review triggers were evaluated at this checkpoint. This packet
extends the already-established Inventory posting correctness domain; it is
not the first end-to-end slice before a fan-out, the first zero-dev-code
module, a stage boundary, or accumulated cross-program drift. No autonomous
program review is proposed.

## Test it yourself (after the inherited snapshot fix is merged)

```bash
cd /home/rvham/2rain-greenfield-p4b2
node --import tsx --test test/postgres/inventory-stock-count.test.ts
```

Expected in under 10 minutes: one PostgreSQL test passes. It posts `+5`, then a
linked `+2` correction, then an exact `-2` reversal; reads back all three
expected/counted/variance triples; observes three retained sessions, lines,
and movements; rejects hard delete; replays a persisted v3 receipt; verifies
the shared lock/savepoint trace; and proves the monetary scan catches a
semantic `fieldId` value.

Do not run the full matrix from this candidate until the orchestrator merges
the owned schema-snapshot repair and grants the serial matrix slot.
