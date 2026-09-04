# ADR-0065: Received quantity is a rebuildable ledger sum, and over-receipt is refused inside the posting transaction

Date: 2026-09-01
Status: accepted (packet `received-quantity-ruling`, merge `4fe5589`, 2026-09-01; a
document packet, so the human read is the review — the lane recorded acceptance
itself; the orchestrator's full read against the tree is recorded as a
`local-confirm` in `docs/execution/program-reviews/2026-09-01-inventory-ledger.md` §6)
Tier: Behavioral (the packet ships one ADR and its record and touches no
executable path; the packets that BUILD against it are Critical)

Rules, for `PUR-2` and `SAL-2` together, how `received_quantity` and its mirror
`shipped_quantity` persist, where over-receipt (and over-shipment) is refused,
and how the stored value is rebuilt and reconciled. ADR-0064 is reserved to
`enum-widen` and is not this decision.

## Context

### What the plan already binds

- `docs/greenfield-north-star-erp-platform-plan.md` §6.2, the launch entity
  catalog, lists `purchase_order_line` with a *"received quantity read model"*
  and the note *"received quantity derived from posted receipts"*.
  `purchasing-sales-v1-plan.md` §7.12 cites the same sentence as *plan §1276*.
- §6.3 of the same plan: *"A cached or materialized balance is a registered
  read-model projection only. It must be recomputable from
  movements/reservations, marked system/read-only, and covered by drift and
  reconciliation tests."*
- [ADR-0007](ADR-0007-append-only-inventory-posting-truth.md): posted movements
  are the sole on-hand authority; *"materialized balances, cached totals, UI
  fields, reports, source-document progress, and search indexes are rebuildable
  read-model projections. They are never independently writable and never become
  reconciliation authority."* Received quantity is source-document progress by
  that sentence's own words.
- `purchasing-sales-v1-plan.md` §7.12 ruled that `PUR-1` drops the field and
  `PUR-2` adds it *"with the posting protocol that decides it"*. `PUR-1` did:
  `packages/domain/src/purchasing/definition.ts` authors `ordered_quantity` and
  a comment where the field would be, and
  `test/unit/purchasing-definition.test.ts` asserts `/received/` matches nothing
  in the definition. That assertion is the open door this ADR closes.
- §7.16 upheld, from the capped design phase, *"the ruling that received
  quantity is ledger-derived primary truth"*, and refuted *"that lock-and-sum is
  the settled physical implementation, since movement-to-order-line lineage is
  unruled, the universal-writer lock protocol is unrepresented, and throughput is
  unmeasured."*
- §7.17: an amended ordered quantity never rewrites received quantity, and what an
  amendment changes is the derived open-to-receive.

### The stop condition, measured first, and it does NOT fire

`docs/execution/packets/pur-2c.md` §3 deferred this decision because *"the
posting protocol, locking rule, lineage, and concurrency evidence needed to
choose a persistence model do not yet exist."* That sentence was written from the
plan's withdrawn evidence (next section) and is measured here against what is on
`main` today.

| fact `PUR-2c` §3 says does not exist | what `main` holds | verdict |
|---|---|---|
| the posting protocol | `PostgresInventoryPostingService` has ONE `#post` for every family. Execution is selected by the compiled family binding keyed by `(capabilityId, familyId)` ([ADR-0060](ADR-0060-a-posting-family-declares-whether-the-kernel-writes-its-companion.md)); a `companion`-origin family hands the kernel a SOURCE document and the kernel writes the inventory transaction itself, inside the posting transaction. A goods receipt is a companion-origin source by ADR-0049 §3, already ruled. | **exists** |
| the locking rule | `#post` calls `acquireStockIdentityLocks` immediately after `BEGIN`, before any other work (the stock serializer's *"load-bearing placement"* contract), then `acquirePostingRequestKeyLock`, then row locks on the source it posts (`lockInventoryTransactionHeader` for an authored draft, `lockAndAssertStockCountEvidence` for a count) and `FOR NO KEY UPDATE` on the period lock in `enforcePeriodLock`. A transaction-local `lock_timeout` bounds every wait. | **exists** |
| the concurrency evidence for an invariant evaluated under that lock | `enforceNegativeStock` merges every persisted movement of the stock identity with the planned ones, sorts by `compareInventoryMovementOrderEntries`, and walks the running total, refusing `INVENTORY_STOCK_NEGATIVE` inside the transaction against serialized state. `packages/domain/src/inventory/contracts.ts` declares the evaluation as `insidePostingTransactionAgainstSerializedState`. The raced-replay branch and the natural-effect reservation ([ADR-0062](ADR-0062-the-writer-inventory-is-derived-from-the-compiled-target.md)) close the duplicate-effect race. | **exists** |
| a persisted, rebuildable read model maintained inside the posting transaction and proven against the ledger | [ADR-0057](ADR-0057-posted-stock-is-a-rebuildable-ledger-sum.md): `posted_stock_balance` is a `providerWritten` entity with a pinned `maintainerId`, written by the `nsm_posted_stock_balance_v1` `AFTER INSERT` trigger the materializer installs on the movement table, rebuilt by the materializer from the ledger without DELETE, and reconciled by `PostgresInventoryReconciliationService` in a read-only transaction that refuses to be writable. Since `PUR-2a` round 8, `#post` itself snapshots the row (`capturePostedStockBalances`) and refuses to commit unless the trigger's result equals `sum(quantity_delta)` recomputed from the movement rows (`assertPostedStockBalancesReconcile`). | **exists** |
| movement-to-order-line lineage | ADR-0049 §3 ruled the companion internal transaction and that the movement's `sourceType`/`sourceId` name the receipt, not the companion. The relation from a receipt LINE to an order line, and therefore the attribution of a movement to an order line, is not ruled. | **does not exist — and is not needed to choose the persistence shape.** Every candidate below needs the same attribution: a counter must know which line to advance, a sum must know which movements to sum, a projection must know which row to maintain. Attribution is an input to all three and discriminates none. It stays `PUR-2c`'s (§"What this ADR does not decide"), under one constraint stated there. |
| throughput | unmeasured | **not a persistence-shape fact.** Every candidate takes the same locks; the shapes differ by one row write and one aggregate per affected line. Stated as a cost below, not as a discriminator. |

So the deciding facts exist by precedent, on `main`, in accepted or built code.
The ruling below rests on those precedents, not on `PS-0`.

### The evidence base, corrected — what `PS-0` did and did not show

`purchasing-sales-v1-plan.md` §7.12 still says the four-arm race *"closed
over-receipt with compare-and-swap on a stored received quantity"* and that
*"the lock-only arm closed the same race, and that one works against a derived
sum under lock. Both are supported by the measurement."* §7.15 withdrew the
second half: *"A4's 'lock-and-sum' arm reads and updates a stored counter — no
arm sums movements … §7.12 must no longer say the lock-only arm supported derived
lock-and-sum — it supported a lock around a stored counter."*

The corrected base this ADR inherits is therefore:

1. `PS-0` evidenced that **a lock around a stored counter closes the over-receipt
   race**. It evidenced nothing about a derived sum, and nothing about a stored
   value being verified against the ledger.
2. `main` since evidenced, in the accepted posting kernel, that **an invariant
   walked over the serialized ledger inside the posting transaction closes a
   quantity race** (`enforceNegativeStock`), and, in ADR-0057 plus `PUR-2a`
   round 8, that **a provider-written projection maintained inside the posting
   transaction and refused unless it equals the ledger sum** is a working, gated
   shape.

Nothing below cites `PS-0`'s withdrawn arm. `PS-0`'s surviving finding — that
the over-receipt check must run under the same lock as the posting — is upheld
and is what all three candidates share.

## The three candidates, weighed

| | 1. stored counter on `purchase_order_line`, advanced by compare-and-swap inside the posting transaction | 2. derived sum over posted movements under the posting lock, no stored value | 3. the ADR-0057 shape: a provider-written, rebuildable read model maintained inside the posting transaction, over-receipt refused against serialized state exactly as negative stock is, non-healing reconciliation proving stored value = ledger sum |
|---|---|---|---|
| what is the AUTHORITY for the refusal | the counter. `UPDATE … SET received = received + q WHERE received = expected AND received + q <= ordered` decides; the ledger is consulted by nobody | the ledger, summed under the lock | the ledger, walked under the lock; the stored row is verified equal to it before commit |
| honours ADR-0007 *"never independently writable, never reconciliation authority"* | **no.** The counter IS the authority the refusal reads; nothing compares it to the ledger; drift is silent until an operator notices a line that will not receive. This is the *writable balance column* ADR-0007's first sentence forbids, made kernel-only rather than user-writable, and kernel-only is not the same as verified | yes, trivially — there is nothing stored to drift | **yes.** The row is provider-written, refused unless equal to the ledger sum in the same transaction, rebuildable from the ledger, and reconciled read-only |
| honours plan §6.2 / §7.12 *"a read model derived from posted receipts"* | no — a counter advanced by the writer is not derived from anything | yes | yes |
| can an office worker SEE it in a list | yes | **no.** ADR-0057 measured the constraint: the language admits grouped aggregates only at `maximumResultCount: 1` and *"declares grouping unsupported"*, so a browsable per-line sum needs a stored projection. This is the exact constraint that produced ADR-0057, and it applies unchanged to a per-line sum | yes, as `posted_stock_balance` is browsed today |
| what `PS-0` evidenced | this arm, under a lock | nothing | the refusal half is `enforceNegativeStock`'s evidenced pattern; the projection half is ADR-0057's |
| cost to `SAL-2` (shipped quantity, open-to-ship) | a second CAS counter on `sales_order_line`, and a standing temptation to add a third for reserved quantity — the mutable `reservedQuantity` field §7.4 forbids | over-shipment is refusable, but shipped quantity is not browsable, so open-to-ship cannot be shown on an order line list | one shape, two families; reservation later attaches as its own active-fact family (ADR-0007) with `inventory.availability` already ruled as the sole available-quantity calculation |
| rebuild after loss | only if attribution lineage exists anyway — and then the rebuilt value is a fresh authority with no reconciler | nothing to rebuild | the materializer's ADR-0057 rebuild, per line |
| failure band when wrong | Band A, unobserved — a wrong counter is not discovered by looking at it | none stored | Band A, observed twice: in-transaction refusal, then reconciliation |

**The deciding argument is not aesthetic.** Candidate 1 fails ADR-0007 on the
word *authority*: a value the refusal reads and nothing verifies is a second
truth, whatever role wrote it. Candidate 2 satisfies every doctrine and fails the
office worker, on a language constraint already measured and already routed
around once. Candidate 3 is candidate 2's refusal with candidate 1's visibility,
and the only one of the three that has a gated precedent on `main` for BOTH
halves. **Ruled: candidate 3.**

## Decision — persistence shape

**Received quantity is a provider-written, rebuildable read model in the
ADR-0057 shape: one operationless entity, one row per purchase order line, whose
stored `receivedQuantity` is exactly the sum of the posted movements attributed
to that line.**

- **One row per order line**, identified deterministically from
  `(tenantId, environmentId, legalEntityId, purchaseOrderLineId)` the way
  ADR-0057 derives the balance row's identity from its stock tuple, so provider
  maintenance and rebuild produce the same identity and the generic record
  runtime accepts it. The row carries a required reference relation to the
  order line, `receivedQuantity` as exact `numeric(38,18)`, and the base unit,
  checked but not part of the key (ADR-0016 makes the unit immutable once stock
  exists).
- **`receivedQuantity` is the sum of `quantityDelta` over every non-archived
  posted movement attributed to the line**, receipts positive, corrections and
  reversals negative. Zero is retained when movements net to zero, because the
  row witnesses posted history. A line with no posted movement has no row, and
  the absence means *nothing received*; the surface says so rather than
  inventing a zero the ledger never wrote.
- **The entity is `providerWritten` with a pinned `maintainerId`**, resolved by
  compiler conformance exactly as `packages/compiler/src/conformance.ts` resolves
  `posted_stock_balance` against the pinned Inventory contract, earning generic
  CRUD and Form omission only when its ABI matches the maintainer's pinned
  descriptor. The family registration is a two-place edit (plan §7.7:
  `LEGAL_ENTITY_FAMILY_RULES` and the domain family map). Ordinary module-runtime
  writes cannot reach the row: its mutation policies are usable only at trigger
  depth or under the posting kernel's role, as the projection's are today. **No
  authored operation may write it, and ADR-0007's G0-P3 rule that a writable
  balance field is refused is the gate that says so.**
- **It is maintained INSIDE the posting transaction** — by the kernel's write,
  under the locks §"Where over-receipt is refused" names — and the posting refuses
  to commit unless the row equals the ledger sum recomputed from the movement
  rows in that same transaction, the `assertPostedStockBalancesReconcile`
  pattern. Whether the write is an `AFTER INSERT` trigger keyed on movement
  columns or a direct kernel `UPDATE` is `PUR-2c`'s construction choice, under
  two constraints: either way it is a writer ADR-0062's derivation must declare
  and its `pg_stat_xact_user_tables` observation must see, and either way the
  in-transaction verification must recompute from the movement FACTS and not from
  what the posting expected to add. *Recommendation, not ruling:* a direct kernel
  write, because attribution to an order line runs through the receipt line
  (below) and a movement-table trigger does not see that join, and because
  ADR-0062 measured trigger edges as *convention, not declaration*.

**Why a separate entity and not a column on `purchase_order_line`.** Plan §6.2
places the read model on the line, and a column would let the line list show it
inline. It was measured and rejected on cost, not on doctrine:

- The only caller-writability exclusion the compiler has is keyed on a state
  machine's `stateField` (`stateFieldIds` in `packages/compiler/src/projections.ts`);
  every other active field enters `writableFieldIds` of every record-effect
  operation. A *declared field that no operation may write* has no spelling in
  the language today. Giving it one is a language-version event (ADR-0047 §4,
  the same class as the *declared, intentionally unregistered* gap the G2
  composition review named), and this ADR will not spend one on a projection.
- ADR-0057's shape needed no language change: *"Compiler lowering, projection
  shape, aggregate contracts, and the language schema are unchanged."* The
  second instance of a class is what the Dial B ruling in `current-plan.md`
  says the platform should reuse rather than rebuild.
- The database-side fence is stronger on a separate entity: trigger-depth-only
  mutation policies and CRUD omission are per entity, and cannot be applied to
  one column of a table an operator edits in draft.

**The cost, stated:** under the current surface grammar the read model renders
as its own list and record, as *Posted stock* does, and the purchase order line
list does not show received quantity inline. Whether a surface may present a
related row's fact, and the derived open-to-receive beside it, is a surface
question `PUR-2`'s remainder owns under its R4 acceptance criteria. Until it is
answered, the office worker sees ordered quantity on the line and received
quantity on the progress list, which is honest and browsable. If a
kernel-maintained-field spelling ever lands, folding the row into the line is a
projection evolution under ADR-0047, not a reversal of this decision.

## Decision — where, and against what state, over-receipt is refused

**Over-receipt is refused inside `#post`, after the locks and before any
movement is inserted, against serialized state — exactly where and how
`enforceNegativeStock` refuses negative stock — never by the counter, never by a
preflight, never by a compiled precondition.**

- **The serialization unit is the order line**, not the stock identity. Two
  receipts of one line into two locations share no stock identity lock, so the
  stock locks alone cannot serialize the line's bound. The posting locks the
  order line rows it attributes movements to (`FOR NO KEY UPDATE`, the period
  lock's mode), **in ascending order-line record id, after the stock identity
  locks and the request-key lock and alongside the source-document locks**. That
  keeps the global lock order total: advisory stock keys ascending, then row
  locks ascending; two postings cannot cycle, and an amendment on the generic
  path holds one line row and waits on no stock lock, so it cannot cycle
  either. The transaction-local `lock_timeout` already set in `#post` bounds the
  wait.
- **The bound is evaluated on the ledger under those locks.** For each affected
  line the kernel sums the persisted movements attributed to that line, adds the
  planned ones, reads `ordered_quantity` from the locked line row, and refuses
  unless `0 ≤ received ≤ ordered` holds for the resulting sum. It is a sum, not
  an effective-time walk: the bound (`ordered_quantity`) is not a ledger quantity
  and has no effective time, so *at any point in effective time* has no meaning
  for it, and a correction backdated before its receipt must not be refused for a
  transient negative the ledger never asserts. Negative stock keeps its walk;
  this is a different invariant and says so.
- **The lower bound is real.** A correction or reversal that would take a
  line's received sum below zero is refused, because it un-receives goods that
  were never received against that line.
- **The refusal is a named posting error carrying the order line id, its
  ordered quantity, the received sum before this posting, and the quantity this
  posting attempted.** The code's spelling is `PUR-2c`'s; the payload is ruled,
  because an operator meets it on the first over-receipt (Band B) and must be
  able to act on it without a query.
- **The stored row is written only after the bound passes, and the posting then
  refuses to commit unless the row equals the recomputed sum.** The refusal
  reads the ledger; the row is an output the ledger verifies. That ordering is
  what makes the row a projection rather than an authority, and it is not
  negotiable in construction.

## Decision — the rebuild and reconciliation obligation

- **Rebuild.** The materializer exposes a trusted-scope rebuild and runs it when
  the projection is first materialized, in ADR-0057's four steps: take the
  posting-generation advisory lock exclusively; refuse a line whose attributed
  movements carry more than one base unit; soft-retire only active rows for the
  tenant and environment; insert or reactivate one deterministic row per line
  from the append-only movement ledger, overwriting derived fields with exact
  arithmetic. It holds no DELETE privilege and never updates, deletes, or
  reinterprets a movement, a receipt, or an order line. **Destroying the
  projection and rebuilding it must reproduce every row.**
- **Reconciliation.** `PostgresInventoryReconciliationService` gains an arm for
  this read model, registered by identities as its other arms are, that
  independently groups the movement table by attributed order line, compares the
  union of ledger and projection identities under the shared posting-generation
  lock, and reports missing, unexpected, duplicate, unit-divergent, malformed,
  and quantity-divergent rows. It runs inside the existing read-only transaction
  and repairs nothing; the `SET LOCAL transaction_read_only = on` refusal already
  makes *repairs nothing* a property of the transaction. **The verifier shares
  no code path with the writer or the rebuild** (`AGENTS.md` §6, the fifth
  vacuity vector).
- **Attribution must be recoverable from persisted, post-immutable facts
  without the read model.** Rebuild and reconciliation both re-derive the sum
  from the ledger; both are impossible if the only place that says which line a
  movement belongs to is the row being rebuilt. So whatever lineage `PUR-2c`
  chooses, the function *movement → order line* must be computable from the
  movement's `sourceType`/`sourceId`/`sourceLine` (ADR-0049 §3 condition 4) and
  relations that do not change after the receipt posts. A posted receipt line
  must never re-point to a different order line.

## Decision — the amendment interaction

§7.17 is restated here as binding, and the shape adds one consequence:

- **An amended ordered quantity never rewrites received quantity.** The amend
  operation's `writableFieldIds` is the ordered quantity alone (ADR-0051, §7.17);
  the read model is a different entity no authored operation can write; the two
  cannot touch. This is now structural, not a rule to remember.
- **Open-to-receive is derived and never stored.** It is `ordered_quantity −
  receivedQuantity` computed at read time from the locked line and the verified
  row. Storing it would create a second value an amendment must rewrite and a
  reconciler must chase. Whether the surface grammar can present a computed
  difference is `PUR-2` remainder's; until it can, the two operands are shown.
- **The floor — refusing an amendment below what has been received — cannot be
  a compiled precondition today, and this is measured rather than assumed.**
  `fieldComparisonPredicate` in `packages/canonical-model/src/predicate-kernel.ts`
  admits a `fieldReference` on the left and a `VersionedCanonicalScalar` on the
  right: a field compares against a literal, never against another field, and
  `PUR-1` measured separately that a line precondition cannot read another
  record. So `ordered ≥ received` is not expressible as an ADR-0034 predicate on
  the projected image. §7.17 leaves `PUR-2` the choice *refuse, or admit and
  disclose as over-received*. **This ADR rules the invariant, not the operator's
  experience:** `0 ≤ received ≤ ordered` holds at every commit, so an amendment
  that would break it is refused, and the refusal must be evaluated against the
  same serialized state the posting uses — the amend path locks the line row and
  reads the verified projection row under it. Where that evaluation lives (a
  registered operation handler for the amend, since the generic path cannot
  express it) is `PUR-2` remainder's construction. Admit-and-disclose is not
  taken, because a derived open-to-receive that can go negative makes *open* a
  lie, and `SAL-2`'s open-to-ship would inherit the same lie.

## Decision — the `SAL-2` mirror

**Shipped quantity is the same shape, one row per sales order line, and the
mirror is exact:**

- `shippedQuantity` is the sum of the posted movements attributed to the sales
  order line, sign-normalised so that a shipment counts positive and a shipment
  correction or reversal counts negative, maintained inside the posting
  transaction and verified against the ledger before commit.
- **Over-shipment is refused inside `#post` against serialized state**, on the
  order line as the serialization unit, with the same bound
  `0 ≤ shipped ≤ ordered` on the sum. **Negative stock is a second, independent
  invariant on the stock identity** and keeps `enforceNegativeStock`'s
  effective-time walk; a shipment posting evaluates both, under both lock
  families, in the order named above. A shipment refused for stock is refused
  before any row is written, exactly as a receipt is.
- **Open-to-ship is derived and never stored.** §7.4's four conditions stand:
  `confirmed` means accepted, nothing is called *reserved*, available-to-promise
  is unsupported, and a shipment refused for changed availability is an expected
  outcome.
- **Reservation, when it comes, is a separate active-fact family** (ADR-0007),
  attached to the same sales-order-line identity §7.4 requires shipment lines to
  keep stable. It is never a counter on the order line and never a third column
  on this row; `inventory.availability` stays the sole calculation of available
  quantity from the two authorities.

What the shape costs `SAL-2`: one more provider-written family registration, one
more reconciliation arm, and one more rebuild path — each the second instance of
a class `PUR-2c` builds first. What it saves `SAL-2`: the riskiest packet as
charted inherits a decided, gated persistence shape and adds only the outbound
sign and the second invariant.

## What resumed `PUR-2c` must prove — one discriminating red per claim

`PUR-2c` (goods receipt and its posting) builds the receipt half; `PUR-2`'s
remainder builds the read-model surfaces and the amend floor; `SAL-2` mirrors.
Each claim below names the red that must be recorded for it, and each control
must die alone when its subject is deleted (`review-tiers`, the rules that do not
relax at any band).

| # | claim | the discriminating red | band |
|---|---|---|---|
| 1 | a receipt whose line would exceed `ordered_quantity` is refused inside the posting transaction, with no movement, no companion, no row and no receipt written | post `ordered + 1` against a line with nothing received; assert the named refusal AND zero rows in every relation the writer inventory lists for that posting | B — the operator meets it on use |
| 2 | the refusal payload names the line, ordered, received-before and attempted | delete one payload member in the kernel; the control that reads the payload reds on that member alone | B |
| 3 | two concurrent receipts of one line into two DIFFERENT locations cannot together exceed the bound | two genuinely concurrent postings sharing no stock identity lock (the ADR-0062 two-posting harness shape), each within bound alone, together over it; exactly one commits | A — a silent over-receipt is a stored wrong value |
| 4 | the stored `receivedQuantity` equals the ledger sum at every commit | mutate the kernel's write to add the planned quantity twice; the posting refuses before commit, not reconciliation later | A |
| 5 | a correction below zero received is refused | correct a 4 with a −5; named refusal | B |
| 6 | no authored operation can write the row | the provider-written refusing twin (ADR-0057's compiler control) reds on a direct `o0`, `o1`, or transition-authored operation against the entity | C — visible on read of the compile diagnostics |
| 7 | destroy and rebuild reproduces every row with the same identity | soft-retire every row, rebuild, compare identities and sums to the pre-destroy capture | A |
| 8 | reconciliation reports a corrupted row and repairs nothing | corrupt one stored quantity under a trusted role; the new arm reports `…LEDGER_DIVERGED` for that subject; `repairedSubjectCount` is 0 and the row is unchanged after the sweep | A |
| 9 | an amendment of ordered quantity leaves the row byte-identical | amend on a line with received 4; the row's bytes and revision are unchanged | B |
| 10 | attribution is recoverable without the read model | rebuild with the projection table empty; the sums reappear from movements and receipt lines alone | A |

**A note on band, so the charter cannot self-assign downward.** The charter that
commissioned this ADR asked for one discriminating red per claim at Band B. That
is right for the refusals (1, 2, 5, 9) and the compile-time fence (6). Claims 3,
4, 7, 8 and 10 are *stored values and balances*, which `review-tiers` places in
Band A by definition: *"a wrong balance is not discovered by looking at it."*
The rows above are the minimum, not the ceiling, and `PUR-2c`'s charter owes
those five the full `AGENTS.md` §6 treatment through an expected-red manifest
under ADR-0058.

## What this ADR does NOT decide

- **The lineage from a movement to an order line.** ADR-0049 §3 ruled the
  companion transaction and that `sourceType`/`sourceId` name the receipt. The
  relation from a receipt line to an order line, its requiredness, and how the
  kernel reads it are `PUR-2c`'s, under the single constraint above: attribution
  is a pure function of persisted facts that do not change after posting.
- **The entity's name, its labels, and the refusal code's spelling.**
  Recommended: an entity per document family, labelled with the word the plan
  uses (*Received quantity*, *Shipped quantity*), never *open* or *available*.
- **Trigger versus direct kernel write** for the row's maintenance, beyond the
  two constraints stated.
- **What closes a purchase order**, receipt correction's operator guidance, the
  receive-100 / ship-80 / found-60 routes, and `allowWithFlag` for corrections —
  all §7.17's and downstream of the receipt existing.
- **Any surface.** How received quantity and open-to-receive reach the purchase
  order line list is `PUR-2` remainder's R4 acceptance criterion.
- **Reservation.** Deferred by §7.4; this ADR only forbids it from becoming a
  counter on the line.

## Consequences

- **Easier.** `PUR-2c` builds against a decided shape with two gated precedents
  (`enforceNegativeStock` for the refusal, ADR-0057 for the projection) and
  copies rather than designs. `SAL-2` inherits both. The `/received/` absence
  assertion in `test/unit/purchasing-definition.test.ts` is retired by `PUR-2c`
  the way `PUR-1` said it would be — *"the absence IS the decision being left
  open"* — and the definition file's placeholder comment goes with it.
- **Harder.** One more `providerWritten` family per document family, each a
  two-place registration plus a pinned ABI, plus a reconciliation arm and a
  rebuild path; the read model is not inline on the line list under the current
  grammar; the amend floor needs a registered handler because the predicate
  language cannot compare two fields. Every one of these is the second instance
  of a class already built, which is the narrowed factory claim working as
  stated.
- **Forbidden.** A received or shipped quantity column on an authored document
  line; a CAS counter as refusal authority; a stored open-to-receive or
  open-to-ship; a `reservedQuantity` field; a preflight-then-post over-receipt
  check; healing reconciliation.
- **Lineage.** Adding a `providerWritten` entity to the purchasing module changes
  compiled output and mints a lineage entry (ADR-0047 §5), which `PUR-2c` already
  pays for the goods receipt itself.

## Evidence

Every claim in the stop-condition table was read at the symbol named, on `main`
at `4218a66068041eb04e45e6fff4883c8aa8dfaebf`, in this packet; none is recalled
from a prior record. The corrected evidence base quotes §7.12 and §7.15 of
`purchasing-sales-v1-plan.md` verbatim. The compiler facts (the state-field
exclusion in `projections.ts`; `fieldComparisonPredicate`'s scalar right-hand
side in `predicate-kernel.ts`; the language's grouped-aggregate limit as recorded
in ADR-0057) were read in this packet. No probe was run and no executable path
was touched; a document packet's evidence is the sources it names.

## Enforcement

- **Compile time:** the provider-written refusing twin and the pinned-ABI
  conformance ADR-0057 already installs, applied to the new family; ADR-0007's
  G0-P3 refusal of a writable balance field.
- **Posting time:** the in-transaction ledger recomputation before commit, and
  ADR-0062's derived-and-observed writer inventory, which refuses a posting that
  writes a relation no read-back covers.
- **Reconciliation:** the read-only arm, run by the same instrument as the other
  three.
- **Review:** claims 1–10 above, by name, in `PUR-2c`'s charter and record.
- **This packet:** `scripts/check-records.sh` and `test:architecture`, which
  read `docs/**`; the human read is the review.

## References

- [ADR-0007](ADR-0007-append-only-inventory-posting-truth.md)
- [ADR-0016](ADR-0016-stock-identity-dimension-set.md)
- [ADR-0034](ADR-0034-terminal-state-operation-preconditions.md)
- [ADR-0047 §4–5](ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md)
- [ADR-0049 §3](ADR-0049-document-transition-and-inventory-effect-seam.md)
- [ADR-0051](ADR-0051-the-write-path-addresses-an-operation.md)
- [ADR-0057](ADR-0057-posted-stock-is-a-rebuildable-ledger-sum.md)
- [ADR-0058](ADR-0058-an-expected-red-is-identified-by-what-it-kills.md)
- [ADR-0060](ADR-0060-a-posting-family-declares-whether-the-kernel-writes-its-companion.md)
- [ADR-0062](ADR-0062-the-writer-inventory-is-derived-from-the-compiled-target.md)
- `docs/execution/purchasing-sales-v1-plan.md` §7.4, §7.12, §7.15, §7.16, §7.17
- `docs/execution/packets/pur-2c.md` §3
