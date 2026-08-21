# stock-balance-read-model — honest posted-stock browsing

Status: active; Critical round-1 corrections implemented, replacement freeze pending

Base: `8136cfaa8caf23a73221cfa2b0feb5c90987556b`

Resumed from: `c963315f1ecebb7bb90f3ef73cd61191e72307ee`

Branch: `packet/stock-balance-read-model`
Tier: Critical — the packet changes what module conformance admits

## Outcome and semantic boundary

The packet adds the operationless `posted_stock_balance` entity with ordinary
List and Record surfaces. Its entity label says **Posted stock balance** and its
surface labels say **Posted stock**. It answers only:

> the sum of every inventory movement posted so far

It does not answer stock as of an effective or recorded instant. The existing
five-parameter `inventory_movement_on_hand` lookup is unchanged and remains the
precise bitemporal tool.

One row is one complete launch stock identity:

```text
(selected legal entity, item, location)
```

This adopts the prior lane's row ruling. Summing locations would answer a
different question and discard the location member fixed by ADR-0015 and
ADR-0016. The unit is stored and verified but is not a fourth key member because
an item's base unit becomes immutable after stock exists.

[ADR-0057](../../decisions/ADR-0057-posted-stock-is-a-rebuildable-ledger-sum.md)
records the semantic limit, row identity, maintenance, rebuild, reconciliation,
and lineage ruling.

## Re-scope history

The preserved branch was resumed from `c963315f1ecebb7bb90f3ef73cd61191e72307ee`;
it was not cut fresh. That commit contains the first re-chartered stop record.
The stop was correct: `posted_stock_balance` was absent from the pinned legal-
entity family in both domain and compiler, and the charter explicitly fenced
those paths.

The user then reset the stop count and pre-authorized the bounded family
registration in `packages/domain/src/inventory/contracts.ts` and
`packages/compiler/src/conformance.ts`. During implementation, generic module
conformance still required CRUD and Form for the new operationless entity. The
second stop was also correct: posted stock is neither append-only fact storage
nor period-lock storage, and borrowing either name would have been dishonest.

The final re-scope authorized one `providerWritten` read-model classification,
bounded to omitting CRUD/Form conformance. It imposed three conditions now met:

1. the classification is resolved from a pinned contract rather than authored;
2. its refusing twin rejects any authored entity operation; and
3. the contract names the maintainer,
   `northstar.postgresql-module-provider:posted-stock-balance/v1`.

No compiler lowering, projection shape, aggregate contract, language schema,
posting service, or web renderer changed.

Critical review round 1 then found two holes in how the classification was
earned. The refusing twin reused the narrower active-`o0` direct-effect set used
to prove ordinary CRUD, so an `o1` record effect or a transition effect could
enter the emitted operation catalog without the promised refusal. The family
resolver also granted CRUD/Form omission before proving the four fields the
named PostgreSQL maintainer requires. Both findings were accepted and corrected
inside the authorized classification: operation ownership now spans every
authored tier and lifecycle and resolves transition ownership through its state
machine, while the pinned rule remains only a candidate until the exact
provider field ABI and its movement companion validate.

## Maintenance, rebuild, and reconciliation

The PostgreSQL module materializer installs an `AFTER INSERT` movement trigger.
The trigger runs after the existing generation/reservation trigger, requires the
existing `semantic_aggregate_generations` row, and upserts exactly one
deterministic balance row in the posting transaction. The identity digest has
its version and variant nibbles pinned so the stable identifier is also a
canonical UUIDv4 accepted by the ordinary record runtime. Runtime mutation
policies are usable only at trigger depth, so an ordinary generic update changes
zero rows.

The public trusted-scope rebuild:

- takes the existing `aggregateGenerationLockKey` exclusively;
- refuses mixed units for one stock identity;
- soft-retires only active rows in the selected tenant/environment projection;
- re-groups the immutable movement ledger with exact `numeric(38,18)` arithmetic;
  and
- inserts or reactivates each deterministic ledger-derived row.

The materializer holds INSERT and UPDATE, but no DELETE, authority over the
projection. A rebuild therefore leaves no stale row active without creating a
hard-delete path for either business truth or derived rows.

Posting, aggregate reads, rebuild, and reconciliation therefore share the same
posting-linked generation/advisory-lock domain. There is no second cache and no
per-row generation that could falsely stamp unaffected identities.

Reconciliation independently reads the ledger and projection in one read-only
snapshot while holding the shared generation lock. It names missing,
unexpected, duplicate, malformed, unit-divergent, and quantity-divergent rows,
and never calls the trigger or rebuild path it verifies.

## Renderer ruling

The existing registered `List` and `Record` renderers consume the compiled
surfaces directly. No `apps/web/src/**` or component-registry change is present;
the renderer stop did not fire. The composed browser journey posts `5`, selects
`DEFAULT`, opens **Inventory → Posted stock**, and observes the item, location,
`5.000000000000000000`, and `EA` in the existing responsive List renderer.

## Controls and recorded reds

### Conformance classification

Removing only the resolved `providerWritten` CRUD/Form exemption made the
otherwise unchanged posted-stock definition fail with five exact
`COMPILER_ENTITY_PROJECTION_MISSING` diagnostics:

```text
$.conformance.operation.archive
$.conformance.operation.create
$.conformance.operation.restore
$.conformance.operation.update
$.conformance.surface.form
```

Restoring that condition returned the focused compiler case to green. This is
the required proof that the classification's absence changes the result.

Removing only the refusing twin made the one-operation mutation compile. The
committed control expected `failed` and observed `compiled`. Restoring the twin
returns exactly:

```text
COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED
$.operations.providerWritten
subject: northstar.inventory:entity.posted_stock_balance
```

Round 1 added three discriminating controls. Restoring the old active-`o0`
direct-effect filter admitted the direct `o1` probe as `compiled`. Removing only
the all-lifecycle arm separately admitted a retired `o0` probe as `compiled`.
Removing only transition-to-machine ownership erased the named provider-written
diagnostic from the transition probe. All are now refused at
`$.operations.providerWritten`, independent of whether another conformance rule
also rejects the specimen.

The provider rule earns CRUD/Form omission only after the active reserved
family carries exactly these required fields and types: item text(80), location
text(80), posted quantity exact decimal(38,18), and unit text(32), with exactly
one active movement companion. Renaming only the unit field while updating its
references records both the missing pinned slot and the unmaintained replacement
as `INVENTORY_CONTRACT_INVALID`, and records the returned
`$.conformance.operation.create` requirement. Awarding the exemption before ABI
qualification makes that last assertion red. Four one-property type mutations
independently cover each provider field.

The committed contract controls also vary only the posted-stock entity label,
family registration, or maintainer id and observe their exact diagnostic paths.
An unpinned family resolves to `null`.

### Real arithmetic and `5g3-stale` reaching sequence

The PostgreSQL stock-count control posts a real `+5` movement and reads the
stored posted quantity as `5`. It then posts a real `+2` correction against the
same item/location/legal-entity row and reads `7`.

The committed negative harness recorded three discriminating reds:

```text
initial-maintenance:    actual null, expected 5
correction-maintenance: actual 5,    expected 7
rebuild-arithmetic:     actual 8,    expected 7
```

The first two disable only the posted-stock trigger before the relevant post.
The third corrupts only the rebuilt quantity after the projection was destroyed
and rebuilt. Together they prove initial maintenance, the `5 -> +2 -> 7`
correction sequence, and independent ledger arithmetic are load-bearing.

The normal rebuild control deletes the selected projection row, observes it
absent, invokes the trusted rebuild, observes `{ movementCount: 2, rowCount: 1 }`,
and reads `7` again. It also proves that trigger maintenance and rebuild produce
the same deterministic canonical UUIDv4 record identity.

The browser gate caught a separate executed red that the privileged arithmetic
control could not see. The first deterministic identity used the raw MD5 bits;
PostgreSQL accepted them as type `uuid`, but the ordinary record runtime refused
the row with `recordId must be a UUID` because those bits did not carry the
canonical v4 version/variant. Pinning the two nibbles in both trigger and rebuild
made the direct gateway control and the rendered List green. This red is retained
because it proves that a provider row being queryable in SQL is not enough to
make it a valid module record.

### Reconciliation honesty

One administrative test mutation changes only the primary projected quantity
from `6` to `999`. Reconciliation returns
`POSTED_STOCK_BALANCE_LEDGER_DIVERGED`, records declared `999` versus observed
`6`, and leaves the corrupt row unchanged until the test restores it. A
reconciler that silently healed its own subject would fail this control.

## Release lineage

Regeneration appended one entry and rewrote no predecessor:

```text
applications: 12 -> 13
previous head: ee788f8c75c9857f6e85784089f2b794e376336afe513048ef7fec0491f27bc9
new head:      37057e242725b9604cdfb2c73d6e8aed25edf4f93e5cebd3f54e733100c11685
head profile:  northstar.compiler-semantic/v2
```

`check:app-release` recompiled all 12 predecessors under each entry's own
recorded profile (`v0-experimental`, `v1`, or `v2`) and reproduced every prior
root before accepting the new head, satisfying ADR-0047 §5.

The full-replay schema fixture is also regenerated rather than hand-edited. Its
helper is pinned to the first historical release whose registered search queries
remain serviceable under the current runtime. That first bounded install still
materializes every earlier physical transition; every successor is then
activated one-by-one through the new head before the schema snapshot is written.

## Gate record

Green before final freeze:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm format`
- `pnpm check:app-release`
- `pnpm check:demo-release`
- `pnpm test:compiler` — 151/151
- `pnpm test:architecture` — 141/141 with successful executed-file evidence
- focused stock-count, reconciliation, and complete module-storage-transition
  controls
- `pnpm test:browser` — 91/91, including the posted-stock List journey

The first full `test:postgres` run reached 196/197. Its only failure was a stale
historical test assumption and then the deliberately generated full-replay
schema fixture: the test compared a pinned 163-scenario language-adoption fact
to the current head, and the fixture predated the new physical projection. The
control now compares historical entries by pinned roots, separately pins the
new 174-scenario serving count, and the repository replay helper generated the
new snapshot. A subsequent full run passed 204/204 before the browser found the
UUID-version defect; the focused stock-count control and full-replay schema
regeneration pass with that fix. The superseded round-1 executable candidate
then passed
`pnpm test:postgres` at
`4b265c913bcda103c74f1320e249d20d810df1af`: 204/204, zero failures, in
742046 ms. Round 1 changed executable conformance and tests after that run, so
the SHA is retained as history but carries no evidence forward to the
replacement candidate. Replacement focused and required gate evidence follows
after the correction converges.

## User-observable checkpoint

The distributor seed supplies catalog items, locations, parties, and the default
legal-entity context, but it supplies zero Inventory transaction, line,
movement, stock-count, or posted-stock rows. A blank Posted stock list is
therefore honest.

To create the first visible row at `http://127.0.0.1:4174`:

1. select legal entity `DEFAULT` in the workspace context;
2. open **Inventory → Inventory transaction → New**, create an Adjustment draft,
   and save it;
3. open **Inventory → Inventory transaction line → New**, select that draft, an
   item, a location, its base unit, and a positive quantity, then save;
4. open the draft transaction detail and choose **Post**; and
5. open **Inventory → Posted stock list**. The row shows that item, that
   location, its unit, and the posted quantity.

The stock-count route is also valid: create and review a Stock count with a line,
then post its resulting correction before opening Posted stock. Merely creating
a draft does not create stock; a movement must be posted.

## Review state

Critical round 1 returned REVISE on frozen SHA
`c781aafa09d1841732d6307416051e0960f0f879`. Its two findings are accepted and
the corrections are implemented, but no independent review has read the
replacement candidate. After its required gates are green, freeze a new SHA and
restart arm 1 with fresh-naive Codex at xhigh. Only after PASS may independent
Fable max confirm the identical new SHA. The full CI matrix remains deliberately
deferred until both arms converge.

## Program-review trigger assessment

A whole-program review is not due at this checkpoint. The program review on
the packet base (`8136cfaa8caf23a73221cfa2b0feb5c90987556b`) produced R6, and
this packet is the bounded execution of that finding. It crosses no stage
boundary, precedes no new fan-out, and implements ADR-0007's already-sanctioned
read-model category rather than introducing another correctness domain. The
fresh Critical packet review remains the proportionate instrument for this
diff.
