# ADR-0049: The document-transition and inventory-effect seam

Date: 2026-08-08
Status: proposed by packet `PS-0`; ratified when that packet is accepted
Tier: Critical (it decides how every business document reaches the ledger)

## Context

`docs/execution/purchasing-sales-v1-plan.md` §7.5 charters `PS-0` to freeze five
things before `PUR-1` is written, and §7.6 names two of them as decisions that
must not be left implicit. This ADR records those five rulings and the evidence
each was checked against, on `main` at `d86c4b9`.

It decides a seam. It does not build purchasing: no purchase-order entity, no
module, no mount, no migration, and no compiled release change is authorized
here. §7.3's money boundary and §7.4's reservation deferral are carried
**unchanged**; nothing below reopens them.

Everything asserted here was read in source or measured by the `PS-0` probe
preserved at `packet/ps-0` and never merged, in the manner `proj-disc` set.

---

## 1. O1 transition semantics

**The mechanism exists, is implemented, and is live in the active release.** §7.1
concluded that `main` "provides no generic" named-transition tier. That is wrong,
and the correction is load-bearing: `PUR-1` inherits a working seam rather than
inventing one.

What carries a named transition is four things together:

1. **`tier: 'o1'` with `effect.kind: 'registeredCapabilityEffect'`.**
   `packages/domain/src/inventory/definition.ts:1261-1287` authors
   `inventory_transaction_post` exactly so, with
   `confirmation: 'humanRequired'` and a precondition pinning
   `state == draft`. It is in the shipped release: of the 39 operations in
   `apps/web/release/app.authored.json`, exactly one is `o1` and exactly one
   carries a capability effect — the same one.
2. **A closed, patch-free input contract.** `packages/compiler/src/projections.ts:848-852`
   emits `closedArgumentKeys = ['expectedRevision', 'recordId']` for a capability
   effect, with the comment that business content is hydrated from the staged
   draft. The contrast with O0 is the whole reason the tier exists: `:899` marks
   every field `writable: true` unconditionally and `:914` lists every field in
   `writableFieldIds`, so an update operation is an arbitrary caller patch by
   construction.
3. **A server-selected target state.** `transitionTransactionToPosted`
   (`packages/postgres-provider/src/inventory-posting-service.ts:2876`) writes
   `binding.transactionPostedState` — a constant resolved from compiled storage,
   never an operation input — in a compare-and-swap `UPDATE` whose `WHERE` pins
   the prior state, the transaction type, the expected revision, every business
   field, and the line-set digest, then requires `rowCount === 1` **and**
   `revision === sourceRevision + 1`.
4. **An expected revision checked before anything runs.**
   `inventory-posting-capability-executor.ts:106-108` refuses a stale rendered
   command and treats `expectedRevision + 1` as a replay rather than a conflict.

**Ruled: those four are the transition protocol, and `PUR-1` implements them
rather than designing them.** Two consequences it must accept up front:

- **`tier: 'o1'` and `registeredCapabilityEffect` are equivalent, enforced both
  ways.** `semantic-operation-gateway.ts:999-1006` refuses a capability effect
  that is not `o1`, and dispatch at `:745` keys on the effect kind alone. There
  is no record-transition effect. **So `purchase_order.release`, `sales_order.confirm`
  and every cancel — none of which write a movement — still need a registered
  capability.** Inventing a new effect kind instead is a canonical-language
  event, and ADR-0038 explicitly forbids a packet from inventing the command
  input contract silently. `PUR-1` uses a capability.
- **The gateway records only non-accepted outcomes** (`#recordNonAccepted`, four
  call sites). Accepted trust evidence is the executor's own, exactly as
  ADR-0026 permits for posting. Every O1 handler owns its trust writes.

---

## 2. The posting ownership model

This was the charter's central viability question. The answer changes the shape
of the fix.

**An adapter cannot enter the posting transaction, and does not need to.**
`#post` calls `this.pool.connect()` itself (`inventory-posting-service.ts:518`)
and never accepts a client. There is no outside position from which to join it,
so §7.6's "the adapter must enter the same top-level transaction that takes stock
locks after `BEGIN`" is not achievable as written. What ADR-0026's contract does
support is the transaction **carrying** a foreign aggregate, by handing it the
client at the two points that contract already names.

**ADR-0029 did precisely this once already.** Stock-count posting is a second,
materially different source aggregate, and it entered through two hard-coded
branches inside the existing transaction: `lockAndAssertStockCountEvidence` at
step 4/5 (`:610-617`) and `transitionStockCountToPosted` inside the single
post-lock savepoint (`:696-706`). No nested transaction, no second savepoint, no
change to `#post`'s structure.

**Ruled: generalize those branches into one injected port.** A foreign source
document implements two operations invoked at fixed positions:

- `lockAndValidate(client, context, command)` — at step 4/5, after every stock
  identity is locked and the module role is assumed. It row-locks the foreign
  aggregate in a deterministic order, validates it against persisted state, and
  returns a digest of everything it validated.
- `transition(client, context, command, digest, recordedAt)` — at step 7, inside
  the same savepoint, as a compare-and-swap against that digest.

ADR-0026's lock ordering is unchanged and remains binding: stock identities
immediately after `BEGIN`, before the request-key lock, before any business read,
before any savepoint. The probe asserts this survives the extension by observing
the query trace, not by asserting it in prose.

### The correction §7.6 needs

**The shipped executor already preflights, and that is not the defect.**
`hydrateAdjustmentDraft` runs in its own transaction
(`inventory-posting-capability-executor.ts:264`) and returns before `#post` opens
another. It is safe because the hydrated draft is treated as an untrusted
*proposal*: `assertInventoryDraftHeader` re-pins every business field under the
header lock, `assertInventoryLineSet` re-reads the complete line set, and the
transition rechecks the line-set digest.

So the rule to freeze is narrower and more useful than "no preflight":

> **Hydrate as a proposal; decide under lock.** A read outside the posting
> transaction may shape a command. It may never be the authority for one.

That is what makes preflight-then-post-then-mark unsafe when it is unsafe: not
the preflight, but a *mark* that happens in a different transaction from the
effect. The probe measured exactly this, below.

---

## 3. Movement lineage — companion internal transaction

The constraint is structural, not stylistic. `inventory_movement → inventory_transaction`
is `parentScopedChild` and **required**; `inventory_movement → inventory_transaction_line`
is `reference` and **required** (`definition.ts:826-836`, `relation()` at `:1341`
defaulting `required = true`). `insertMovement` writes both columns on every path
(`:2144-2145`), and the required-relation lowering is what
`INVENTORY_STORAGE_REFERENCES_V1` and `LEGAL_ENTITY_RELATION_SEMANTICS_V1` pin in
`packages/domain/src/inventory/contracts.ts`.

Direct receipt-line lineage therefore means making both relations nullable or
polymorphic. That changes the append-only fact table's shape, the ADR-0007
lineage contract every posted row already relies on, `readBackMovements`, the
on-hand derivation's joins, and the storage-reference declarations — a ledger
redesign, which §7 forbids on the evidence that the ledger is a foundation.

**Ruled: a companion internal `inventory_transaction`**, exactly as `stock_count`
already carries one (`stockCountTransaction`, `definition.ts:838-844`).

### Preventing a hidden duplicate from becoming competing truth

**This is not a hypothetical risk. It is an existing condition.**
`northstar.app:surface.inventory_transaction_list` is a mounted, user-facing
surface in the active release, and stock-count companion transactions appear in
it today alongside their own `stock_count` surfaces. `PUR-2` inherits the problem
unless it is closed, so four conditions bind:

1. **The companion names its origin.** Transaction `type` gains `goodsReceipt`
   and `shipment` — a compiled enum addition to the five that exist today
   (`opening | adjustment | transfer | countCorrection | reBaseline`,
   `definition.ts:290-296`), which moves the release root.
2. **The receipt is the only document a user can author.** The companion must
   have no user-reachable create or update. This requires resolving ADR-0038's
   own open question — whether the generic `o0` create on `inventory_transaction`
   should be retired — and `PUR-2` must state its answer rather than inherit it.
3. **No user-facing surface lists companion transactions.** Either the
   transaction list filters them out, or it is retired in favour of per-document
   lists. **`PUR-2` states which, and proves it with a query, not a claim.**
4. **The movement's `source_type` and `source_id` name the receipt, not the
   companion.** This is what makes the companion an implementation detail rather
   than a second truth, and it is free: both are `text(80)` on the movement
   (`definition.ts:632-664`) and already carried through the command envelope.
   The probe posts with `sourceType: 'goodsReceipt'` and
   `sourceId: <goodsReceiptId>` while the required relations still bind the
   companion, and asserts both on the returned movement.

**Recorded as debt:** conditions 1–3 are owed for stock-count companions today
and are not in place.

---

## 4. Provider ownership

**Ruled: separate Purchasing and Sales capability IDs over one shared
cross-domain posting kernel.** Not command routes under
`northstar.inventory:capability.posting`.

- **Separate IDs are the mechanism's existing grain.** Executors are registered
  and dispatched by exact capability ID (`semantic-operation-gateway.ts:745`,
  `capability-operation-executor-factory.ts:41-58`), and the set of load-bearing
  IDs is read from the compiled operation catalog
  (`registeredCapabilityIdsFromOperationCatalog`). A second capability needs no
  new mechanism; a duplicate ID is already a `TypeError` at assembly.
- **ADR-0026 admits its capability as "the sole writer of an Inventory
  movement" and warns that similarity is not authorization.** Routing receipt
  commands under it would make Purchasing's authority a subset of Inventory's
  declaration and put purchasing entities inside Inventory's declared reads.
- **Against the second-writer risk this ruling is meant to avoid:** the
  single-writer guarantee was never the capability ID. It is `#post`. Keep
  `PostgresInventoryPostingService` the only class that inserts a movement and
  let Purchasing and Sales *consume* it through §2's port. **Enforce it
  structurally** — an architecture test asserting exactly one `INSERT` into the
  movement table across the provider — so the guarantee is a gate rather than a
  convention.
- **The dependency set belongs to the kernel, not to the capability ID.** The
  reads a receipt posting performs are performed by `#post`, which is admitted
  under Inventory's capability, so they are declared in Inventory's set (§5) and
  the Purchasing and Sales registrations carry that same root. A capability ID
  says *who may invoke*; the dependency set says *what the kernel touches*.

**This is the one ruling the probe does not measure.** It is reasoned from
registration and dispatch code, not exercised — the probe drove the kernel
directly and never registered a second capability. `PUR-2` must land the second
registration and record what it cost.

---

## 5. The posting dependency contract — what the extension costs

Measured rather than estimated.

- **The root is reproducible and the extension is mechanical.** Hashing the
  35-entry `dependencies` array with `canonicalizeAndHash` reproduces the
  recorded v4 root
  `ffd4e9f6103b5c6053c39b62fe64e69dd255cb0c86cfd349ae465ab25179b3d3` exactly.
  Appending six purchasing entries — reads of `purchase_order`,
  `purchase_order_line`, `goods_receipt`, `goods_receipt_line`, and transitions
  of `goods_receipt.state` and `purchase_order_line.received_quantity` — gives 41
  entries and root
  `f8a689762e6238bddd407ba35d0f3836d6eb2eb8cd9275d43f1f39a5989ba82e`. That
  candidate is recorded for comparison; the authoritative v5 root is whatever
  `PUR-2`'s final entry list produces, and it must be re-derived, not copied.
- **A new `purchasing` authority member is required in two places, and nothing
  binds them to each other:** `contracts.ts:200-207` and the duplicate literal at
  `conformance.ts:3215-3222`. An undeclared authority makes
  `inventoryDependencyKey` return `null`, which surfaces as
  `INVENTORY_POSTING_DEPENDENCY_UNDECLARED`. This is the same drift class as the
  posting roles, one layer down.
- **The root is pinned at four executable sites** — `contracts.ts:8`,
  `conformance.ts:32`, `inventory-posting-service.ts:38`, and
  `test/compiler/inventory-contract.release.golden.json:106` — plus two documents.
- **Release roots move.** The compiled Inventory release root changes with the
  contract and with the enum additions of §3. `PUR-2` records before and after,
  on the ADR-0029 precedent.
- **Receipt digest version 4 is a six-line migration.** Migration 0017 is the
  template: drop and re-add the `CHECK (input_digest_version IN (...))`
  constraint. `digestCommand` and `recordedResultForReplay`
  (`inventory-posting-service.ts:3611-3690` (`digestCommand`, `recordedResultForReplay`)) gain a v4 arm. Existing v1–v3
  receipts continue to decode from their **stored** version and are not
  rewritten — the rule ADR-0029 established and this ADR does not relax.
- **A `receipt` posting role costs eight code sites plus a migration.**
  `contracts.ts:12`, `conformance.ts:198` and its label table at `:319`,
  `definition.ts:677` (the movement enum) and `:295` (the transaction type enum),
  `migrations.ts:54` and `:144`, and the provider union
  `InventoryPostingRoleV1` at `inventory-posting-service.ts:176-177` — plus a
  migration adding `receipt_reason_requirement` and `receipt_approval_threshold`
  columns and widening `provision_inventory_scope`, whose signature already
  carries one column pair per role. **§5's assumption 1 is refuted with a count,
  not an argument.**
- **The contract-to-provider gap §7.1 named is still open.** `reBaseline` is in
  `INVENTORY_POSTING_ROLES` and in the compiled movement enum, and is absent from
  `InventoryPostingRoleV1`. Nothing fails. Adding `receipt` in one place and not
  the other would fail the same silent way.

---

## The probe, and what it settled

`packet/ps-0` at `452c839`, preserved and never merged. One test file, one probe
port, and a 20-line seam in `#post` — all marked `PS-0 PROBE ONLY — NOT FOR
MERGE`. It runs the **real** `PostgresInventoryPostingService` against real
PostgreSQL.

The vertical: a released purchase-order-shaped aggregate (ordered 10) posts a
receipt-shaped effect for 4, appending one positive movement whose
`sourceType`/`sourceId` name the receipt, advancing the line's received quantity
to 4, and transitioning the receipt `draft → posted` — all in one transaction.
A compensating receipt superseding it then appends `-4`, returning received to 0
and on-hand to 0 **without mutating the corrected receipt**, which stays
`posted`.

Six controls, each switchable so it reds for its own reason:

| Control | Result |
|---|---|
| Over-receipt (11 against 10 ordered) | typed refusal, nothing written |
| ADR-0017 G4 — a line with neither cost nor declared absence | typed refusal |
| Stale expected receipt revision | typed refusal |
| Failure after the movements exist | zero movements, receipt still `draft`, quantity unchanged |
| Stock lock precedes the first purchasing read | asserted on the query trace |
| One savepoint, not two | asserted on the query trace |

**The race, measured in four arms.** Two receipts for the full open quantity at
*different* locations — so they take different stock identities and the stock
serializer does **not** serialize them. Only the purchasing side can.

| Arms | Successes | Received of 10 ordered |
|---|---|---|
| purchase-order lock + compare-and-swap | 1 | 10 |
| pessimistic lock only | 1 | 10 |
| compare-and-swap only | 1 | 10 |
| **neither — the recorded red** | **2** | **20** |

**The finding is sharper than the charter's framing.** Either mechanism closes
the race, provided it is inside the posting transaction; the lock converts a late
abort into an early wait, and the compare-and-swap lets the loser do the work and
discard it. What is not optional is that the purchasing mutation shares the
transaction with the movement append. **Preflight-then-post-then-mark over-receives,
and the fourth arm is what that looks like.**

### A real defect found on `main`

`postgresCode` (`inventory-posting-service.ts:3877`) reads any `error.code`
string without checking its shape, so `translateInventoryPostingError` relabels
**any** error carrying a string `code` as `INVENTORY_POSTING_STORAGE_REJECTED`
and discards its cause. Observed directly: a source-aggregate refusal surfaced as
`INVENTORY_POSTING_STORAGE_REJECTED: PostgreSQL rejected inventory posting
(PS0_RECEIPT_OPEN_QUANTITY_EXCEEDED)`. Node's `ERR_*` errors have the same shape.
The probe carries a one-line SQLSTATE shape check; the fix belongs to its own row
because it changes an error contract callers may depend on.

---

## What §7 got wrong

1. **"`main` provides no generic O1 tier."** It provides one, built and mounted.
   ADR-0038 authorized the route and it shipped: one `o1` operation, one
   capability effect, a closed two-argument input contract, and a
   server-selected target state. `PUR-1` extends a seam rather than cutting one.
2. **"The adapter must enter the same top-level transaction."** It cannot —
   `#post` owns its own connection — and it does not need to. The transaction
   carries the aggregate through a port.
3. **"Preflight-then-post-then-mark is unsafe."** True of the *mark*, not of the
   preflight. The shipped executor already preflights safely because hydration
   carries no authority. Stating the rule as "no preflight" would forbid the
   working design.

None of the three changes the packet order in §7.5. `PUR-2` remains the
architectural gate.

## Boundaries

This decision does not authorize a purchase-order or sales entity, a module, a
mount, a migration, a dependency-set change, a release-root move, a posting role,
an HTTP route, an agent tool, a UI binding, valuation, or a reservation writer.
It does not merge the probe. Each of those is `PUR-1`'s or `PUR-2`'s to land,
against the rulings above.
