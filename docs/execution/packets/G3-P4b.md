# G3-P4b — Stock-count correction posting

Status: revision candidate; post-posting evidence immutability accepted as an
unmounted-product sequencing condition
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

Revision review found that retained count evidence is not yet immutable:
`stock_count` and `stock_count_line` still receive generic update, archive, and
restore operations. The posting capability does not own draft authoring; it
accepts only an already-persisted reviewed session and complete line set. The
generic semantic-operation API is therefore the only declared business path
for draft mutation, while the PostgreSQL fixture seeds those rows directly.
Removing the generic operations would close the post-posting hole by also
removing the declared draft/counting writer. Inventory is not mounted in the
composed application, so neither that authoring path nor the post-posting
mutation hole is reachable by a user of the running product today.

**Hard sequencing dependency, owned by queue row `5g3-ui` (`G3-P6a`):
`G3-P6a` MUST NOT INTEGRATE BEFORE the terminal-state mechanism lands.** The
moment Inventory mounts, the ordinary semantic-operation API makes posted
count sessions and lines rewritable and archivable. The `5g3-ui` integration
gate must therefore remain closed until the orchestrator-routed mechanism has
its own owning row and enforces terminal-state immutability; this is a binding
prerequisite, not deferred advice. No partial inventory-specific runtime guard
is admitted.

That routed work also owns the separate completeness ruling exposed here:
G3-P4b supplies a posting path that consumes pre-existing reviewed evidence,
but the running product has no path that authors a count session or its lines.
Freeze M requires that evidence, so the mechanism packet must decide whether
draft authoring remains a lifecycle-restricted generic operation or moves into
a capability-owned lifecycle before `5g3-ui` can integrate. This packet does
not claim a usable count-authoring path.

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
| Three independently readable quantities | Production victims are the separate `countedQuantity`, `expectedQuantity`, and `varianceQuantity` read-back assignments at `inventory-posting-service.ts:2852`, `:2853`, and `:2861`; test victims are the three independent assertions at `inventory-stock-count.test.ts:426`, `:431`, and `:436`. Dropping expected loses what the system believed, dropping counted loses what was found, and dropping variance loses the exact posted delta. |
| Persisted count-to-movement evidence | Victims are the persisted transaction-line relation selected at `inventory-posting-service.ts:2819` and the resulting `movementId` assignment at `:2855`; deleting either breaks the observed linked correction. |
| Counted-minus-expected validation | The inconsistent command at `inventory-stock-count.test.ts:454-468` pins `INVENTORY_POSTING_INPUT_INVALID` and its exact variance message. Deleting the comparison at `inventory-posting-service.ts:1407` makes the fully seeded command post instead. |
| Compensating correction | The command at `inventory-stock-count.test.ts:490-508` deliberately disagrees with its persisted session and pins the evidence-conflict message, so deleting the `supersedesStockCountId` comparison at `inventory-posting-service.ts:2491` moves it past that refusal. The command at test lines `:510-533` supersedes a reviewed-but-unposted session, so deleting the posted-prior check at service line `:2612` makes it post. |
| Exact reversal | The fully seeded reversal at `inventory-stock-count.test.ts:559-574` names the prior movement but supplies `-1` against a prior `+2`; it pins `INVENTORY_COUNT_COMPENSATION_CONFLICT`. Deleting the negated exact-decimal comparison at `inventory-posting-service.ts:2680` makes it post. The successful path still observes the movement reversal field binding used by `insertMovement` at `:2123`. |
| Posting role | The assertion at `inventory-stock-count.test.ts:201-205` requires the initial count result to expose `postingRole: 'count'`; hardcoding the branch at `inventory-posting-service.ts:500` to `correction` fails there. |
| Count reason and approval | The command at `inventory-stock-count.test.ts:576-593` has no required narrative and pins `INVENTORY_COUNT_REASON_REQUIRED`. Lines `:595-638` use distinct thresholds (`count = 10`, `correction = 1`): `+5` count succeeds while an unapproved `-2` correction pins `INVENTORY_COUNT_APPROVAL_REQUIRED`, so changing the role lookup at `inventory-posting-service.ts:1917` or deleting `absolute` at `:1934` turns the control red. |
| No hard delete | The victim is the generated module-role denial exercised by both `DELETE` statements at `inventory-stock-count.test.ts:296-306`, followed by retained counts at `:313-315`; granting either count entity a hard-delete path or deleting earlier data changes the verdict. |
| Dependency v4 exhaustive-by-construction | Victims are the v4 version expectation at `conformance.ts:2505-2506` and the root recomputation of both arrays at `:2542-2547`; deleting a count dependency or adding an undeclared access fails the compiler cases. |
| Shared posting protocol | Victims are the count hook into `#post` at `inventory-posting-service.ts:610-617` and the one shared savepoint at `:675`. The trace at `inventory-stock-count.test.ts:702-730` proves transaction-local `true`, two advisory-lock acquisitions after the timeout and before the first count read, and exactly one savepoint. Both locks use identical SQL and the trace inspects neither lock values nor attribution, so this control cannot prove which acquisition is the stock lock and which is the request lock. |
| No monetary count member | Victims are the recursive value check at `conformance.ts:1853` and key check at `:1870`; the negative control at `inventory-stock-count.test.ts:339-346` proves `{fieldId: 'unitCost', newState: {value: '1.00'}}` is observed. A property-name-only scan fails that red. |
| Version from persisted artifact | Victims are `digestCommand(posting, receipt.input_digest_version)` at `inventory-posting-service.ts:3183` and the stored-version branch beginning at `:3633`; replacing either with today's writer version breaks old v1/v2 compatibility or v3 evidence replay. |

## Verification state

After merging main at `e96316a`, the revision author ran:

```bash
corepack pnpm format && corepack pnpm typecheck && corepack pnpm lint
node --import tsx --test test/postgres/inventory-stock-count.test.ts
```

Author-gate verdicts: format PASS; TypeScript typecheck PASS; ESLint PASS;
focused PostgreSQL stock-count control PASS. The author also executed and
restored eight mutations: initial role hardcoded to correction; variance
comparison deleted; persisted supersedes comparison deleted; posted-prior
state comparison deleted; exact-inverse comparison deleted; count reason code
misclassified; approval threshold hardcoded to the count role; and absolute
variance removed. Every mutation turned the focused control red at its intended
assertion, and the unmutated control passed again afterward.

No full matrix or review rerun is claimed in this pre-matrix record. The
Critical immutability finding is accepted only under the hard `5g3-ui`
sequencing dependency above; the exact descendant SHA containing this record
must pass the serialized matrix before review reruns.

The program-review triggers were evaluated at this checkpoint. This packet
extends the already-established Inventory posting correctness domain; it is
not the first end-to-end slice before a fan-out, the first zero-dev-code
module, a stage boundary, or accumulated cross-program drift. No autonomous
program review is proposed.

## Test it yourself

```bash
cd /home/rvham/2rain-greenfield-p4b2
node --import tsx --test test/postgres/inventory-stock-count.test.ts
```

Expected in under 10 minutes: one PostgreSQL test passes. It posts `+5`, then a
linked `+2` correction, then an exact `-2` reversal; reads back all three
expected/counted/variance triples; observes retained sessions, lines, and
movements; rejects hard delete; replays a persisted v3 receipt; verifies the
bounded shared lock/savepoint trace; rejects mismatched and unposted
compensations, an inexact reversal, inconsistent variance, a missing count
reason, and unapproved absolute variance; and proves the monetary scan catches a
semantic `fieldId` value.

The lifecycle disposition and serial matrix slot were granted after the
focused run recorded above.
