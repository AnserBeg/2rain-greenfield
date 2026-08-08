# Purchasing and sales — the v1 charter, and what it rests on

**Status: REVIEWED 2026-08-08 — verdict "build it, but revise the charter before `PUR-1`". §7 records the
rulings and supersedes §2's packet table. Read §7 first.**

The goal in the user's words: *an office worker can receive inventory and send it
out.* This document charters that as four packets and records what each one rests
on, so the plan can be judged before it is built rather than after.

**It is deliberately written to be refutable.** §5 lists the assumptions that would
sink it.

---

## 1. What the program plan already specifies

`docs/greenfield-north-star-erp-platform-plan.md` gives a matched inbound/outbound
pair and nothing else:

- **In:** purchase order + lines → goods receipt + lines → positive movements
- **Out:** sales order + lines → reservation → shipment + lines → negative movements

Entity shapes at **§1276–1282**, lifecycles at **§1372–1378**
(`draft → released → closed`, `cancelled` from draft), operations at
**§1418–1427**.

**Two gaps in the source material, both verified:**

- The plan references `docs/purchasing-inventory-plan.md` at line 2650 as the
  detailed specification. **That file does not exist.** The sections above are the
  whole specification.
- **"Invoice" appears exactly once in the plan, and it is a negative** — line 1355:
  goods receipts *"record facts only; they do not create invoices, tax, or ledger
  postings."* [ADR-0017](../decisions/ADR-0017-cost-capture-without-valuation.md)
  reinforces it: receipt lines capture actual cost or an explicit absence,
  movements carry no amount, `inventory.value` is `unsupported`.

**User ruling 2026-08-08:** the outbound document is a **shipment document** — a
packing-slip listing what shipped, no amounts, no tax. This keeps v1 inside
ADR-0017 and requires no new ruling. A priced document or a real AR invoice were
both offered and declined for v1.

---

## 2. The four packets

| Packet | Deliverable | Depends on |
|---|---|---|
| **`PUR-1`** | `purchase_order` + `purchase_order_line`. Create, edit while draft, release, browse. **No inventory movement.** | current `main` |
| **`PUR-2`** | `goods_receipt` + `goods_receipt_line`. Receive against a released PO, partial and full, posting positive movements. | `PUR-1` |
| **`SAL-1`** | `sales_order` + `sales_order_line`. Mirror of `PUR-1`. | `PUR-1` reviewed |
| **`SAL-2`** | `shipment` + `shipment_line`, negative movements, and the printable shipment document. | `SAL-1` |

**They are serial, and the reason is mechanical rather than stylistic.** Every
module mount touches three shared *sequential* things: `builder.ts` destructures a
fixed tuple with a hard-coded count and error string; `apps/web/release/app.compiled.json`
is a content-addressed lineage (8 entries, last root `b0177bf4…`) to which each
mount appends the next entry; and the migration number. Two lanes mounting
concurrently do not merely conflict — the second lane's appended entry is invalid
once the first lands, so it must regenerate, **voiding its reviewed artifact and
the matrix that was green at it.**

Work that authors no definition — UI packets under `apps/web/src/` — is genuinely
parallel-safe against this chain.

---

## 3. What the platform already provides

The reason this is small rather than large:

- **Parent-scoped lines are exercised.** `party/definition.ts:221` uses
  `ownership: 'parentScopedChild'`.
- **Generic create/update/archive/restore operations and form surfaces are
  auto-emitted** per entity. Mounting an entity gets screens without per-module
  platform code.
- **Terminal-state protection is built and hardened.**
  [ADR-0034](../decisions/ADR-0034-terminal-state-operation-preconditions.md)
  evaluates `operationDefinition.precondition` at `prepareMutation` against every
  image an effect consumes or produces, **plus a generic parent-aggregate rule**:
  a mutating operation on the parent of an active `parentScopedChild` relation must
  satisfy the parent's precondition. **So a not-released predicate on the header
  covers every line with zero line-level declarations.** It shipped with ten
  controls and two rounds of fail-open defects already found and fixed.
- **A posting service exists** —
  `packages/postgres-provider/src/inventory-posting-service.ts`, one private
  `#post` for every command family, with lock ordering proven under a real `40P01`.

## 4. Decisions taken, with their reasons

**Do not use `stateMachines`.** The canonical language declares it, the compiler
materializes it into a `derivedStateFields` column — and `packages/runtime/`
contains **zero** references to it. Every first-party module declares
`stateMachines: []`. The concept has never executed; queue row `5g3-sm` owns its
fate. Author `state` as an ordinary enumeration and guard it with ADR-0034
preconditions, exactly as `stock_count` does over `draft | counting | reviewed | posted`.

**Classify every new family.** `LEGAL_ENTITY_FAMILY_MAP_V1` in
`packages/domain/src/inventory/contracts.ts` — an undeclared family is a compile
failure with no default. All eight new entities are `entityOwned`.

**Mount only in `packages/domain/src/app/builder.ts`.** Composing in
`generate-app-authored.ts` instead would create a second desired-state authority.

**Accept a lineage entry per mount.** Routine — `G3-P4b` did it for two entities —
but measured rather than assumed, with before and after roots reported.

---

## 5. Assumptions that would sink this plan

Listed so a reviewer can attack them directly.

1. **That receiving and shipping can reuse the posting service by adding a role.**
   `INVENTORY_POSTING_ROLES` is `adjustment | transfer | count | correction | reBaseline`
   and it exists **twice** — `packages/domain/src/inventory/contracts.ts:12` and
   `packages/compiler/src/conformance.ts:198` — byte-identical, with **no test
   referencing either constant and nothing binding them.** `conformance.ts:3115`
   gates on `hasExactKeys`. If adding a role is not cheap, `PUR-2` and `SAL-2` are
   much larger than charted.
2. **That the composition model scales.** `builder.ts` destructures a fixed
   four-tuple and throws `'the composed application requires four modules'`. Eight
   more entities across four modules means editing that load-bearing line four
   more times. Whether this is fine or a smell is a real question.
3. **That the lineage cost per module stays flat.** Each mount appends an entry and
   re-derives pinned expectations. If that cost grows with lineage length, the
   fourth module is not the price of the first.
4. **That reservations are needed at all for v1.** The plan puts reservation
   between sales order and shipment. A v1 that ships directly from a confirmed
   order, refusing when stock is short, may be adequate — or may be a rework trap.
5. **That an ERP with no money is usable.** No valuation, no invoice, no AR. The
   office worker sees quantities and documents. This is the plan's deliberate
   boundary, not an oversight — but whether it clears the bar for *usable v1* is a
   product judgement, not a code one.
6. **That enum-plus-precondition is a durable lifecycle pattern.** It works and is
   proven once, on `stock_count`. Four more documents with richer lifecycles is a
   different load.

---

## 6. What v1 explicitly does not include

Supplier pricing and cost capture beyond what ADR-0017 already permits; any
valuation; invoicing, tax or ledger postings; back-orders; drop-ship;
multi-currency; approval workflows; and any agent journey beyond what the existing
fixed-tool set already covers.

---

## 7. Review verdict and the revised plan — ruled 2026-08-08

**Viability: confirmed.** The inventory ledger is a foundation, not a prototype.
The append-only movement fact, quantity-only semantics, source/effect idempotency,
the stock-identity serializer with deterministic lock order, serialized
negative-stock evaluation, base-unit enforcement, period locking, and the atomic
trust/event/outbox/receipt transaction are the correct substrate. **Do not
redesign the ledger, the serializer, or the derived on-hand model.** ADR-0029 is
the evidence: stock-count posting added a materially different source aggregate
without replacing any of them.

**The packet boundary was wrong.** §2 cut packets at entity mounts. The
load-bearing boundary is (1) generic draft CRUD, (2) **named O1 document
transitions**, (3) **cross-domain posting and correction**. `main` provides (1)
and one inventory-specific instance of (3). It provides no generic (2).

### 7.1 The three confirmed refutations

- **"Add a posting role" is refuted.** The role vocabulary is duplicated in five
  places, not two — `contracts.ts:11`, `conformance.ts:198`, the persisted
  movement enum at `definition.ts:580`, the provider's command/result/binding
  types, and `migrations.ts:44` with one physical configuration column per role.
  `hasExactKeys` makes domain/compiler drift a conformance failure, but the
  contract-to-provider gap is unguarded: `reBaseline` is in the contract and
  **not** in the provider's implemented union. More decisively, the posting
  **dependency authority union is `catalog | location | party | inventory |
  trust`** (`contracts.ts:200-207`) — receiving cannot read or lock a purchase
  order at all. `PUR-2`/`SAL-2` are governed command-family and
  transaction-protocol extensions, on the ADR-0029 precedent.
- **"Enum plus precondition is a lifecycle" is refuted.** ADR-0034 decides whether
  a caller's mutation is *allowed*; it cannot decide what the next state *must be*.
  The generic O0 contract makes every active field writable
  (`projections.ts:899`, `:914`) and the interpreter applies the caller's patch.
  **Every business transition — release, confirm, cancel, post, correct — needs a
  named O1 handler**, exactly as plan §1418–1427 classifies them.
- **"Lineage cost is flat" is refuted literally.** `composed-application-runtime.ts:225-286`
  traverses every adjacent release pair and visits every application release, so
  handling is at least linear. Eight entries to twelve is not a cliff, and the
  serial-mount conclusion stands — but the premise was false.

### 7.2 Confirmed, and not blocking

`builder.ts`'s fixed tuple is a smell, not a defect: after it, composition is
generic array merging. **Refactor it once to an ordered definition registry in the
first packet that mounts anything.**

### 7.3 The money boundary was drawn wrong, and this is a correction

Excluding valuation, invoicing, tax, AR and ledger postings is sound. **Excluding
monetary facts is not.** ADR-0017 line 103 is a *gate*: posting a goods receipt
**records actual unit cost or an explicit absence**. Order lines carry currency
and optional unit price by the plan's own catalog. Movements stay quantity-only.

**The correct boundary: no accounting, invoicing, tax or AR; retain optional
commercial order data and mandatory receipt cost-or-explicit-absence evidence.** A
packing slip with no amounts is a presentation choice and does not license
discarding the source facts. Discarding receipt cost creates precisely the
spreadsheet shadow system ADR-0017 exists to prevent.

### 7.4 Reservation — deferred, with conditions

Ship directly from a confirmed order: lock stock identities, lock and validate the
order and shipment lines, compute open-to-ship, evaluate on-hand under the
serialized transaction, refuse if short, append negative movements atomically.

**Permitted only if all four hold, and they must be recorded as product
limitations before `SAL-1`:** `confirmed` means *accepted*, not *allocated*; no UI
or report calls any quantity "reserved"; available-to-promise is unsupported; and
shipment failure from changed availability is an expected business outcome.

**Not a rework trap** provided shipment lines keep a stable sales-order-line
reference, no mutable `reservedQuantity` field is introduced, and a future
reservation fact can attach to the same line identity. **Reverse this ruling** if
the first customer picks before posting, promises allocated stock, or leaves orders
open for days.

### 7.5 The revised packet plan

| Packet | Deliverable |
|---|---|
| **`PS-0`** *(new, first)* | **Design pass with a thin executable contract.** Freezes: exact O1 transition semantics (server-selected target state, expected revision, no arbitrary companion patch); the source-document posting ownership model — one transaction locking and transitioning PO/receipt or SO/shipment aggregates while appending movements; the **movement-lineage decision** (companion `inventory_transaction` versus direct receipt/shipment lineage); the provider ownership shape (separate Purchasing/Sales capability IDs over one cross-domain kernel, versus command routes under the inventory posting capability); and the §7.3/§7.4 product rulings. **Proof: a thin inbound vertical** — one released-PO-shaped aggregate posts one receipt-shaped effect, appends one positive movement, updates open quantity atomically, and is corrected by a compensating effect. No finished UI. |
| **`PUR-1`** | Purchase order + lines, generic draft CRUD, **plus the named O1 release/cancel handlers** against `PS-0`'s seam. Includes the `builder.ts` registry refactor. |
| **`PUR-2`** | Goods receipt + lines, cross-domain posting, **and receipt correction** — the lifecycle is `draft → posted → corrected` and a v1 that can post but not correct is not operationally viable. **Plus the derived read models**: PO-line received quantity and open-to-receive, without which partial receiving is unusable. **This is the architectural gate.** |
| **`SAL-1`** | Sales order + lines, O1 confirm/cancel, and the §7.4 limitations recorded. |
| **`SAL-2`** | Shipment + lines, negative posting, **shipment correction**, shipped-quantity and open-to-ship read models, and the packing document. **Riskiest packet as charted** — first outbound aggregate, negative stock, partial fulfilment, correction and an external document at once. |

### 7.6 Two decisions `PS-0` must not leave implicit

**Movement lineage.** Every movement is structurally tied to an
`inventory_transaction` and `inventory_transaction_line` — the service command
requires `transactionId`, each line requires `transactionLineId`, and the canonical
relations are required. But the plan's catalog describes `inventory_transaction` as
the human-facing document for opening, adjustment, transfer and count correction —
**not** receipt or shipment. Either posting a receipt creates a companion internal
transaction (smaller, but hidden duplicate documents must never become competing
user-facing truth), or movement lineage references receipt/shipment lines directly
(redesigns the required relations and posting bindings).

**Atomicity.** `inventory-posting-capability-executor.ts` hydrates an
`inventory_transaction`, checks it is an adjustment, and calls `postAdjustment`. It
is not a generic source-document adapter. Preflight-then-post-then-mark is
**unsafe** — another receipt races between steps, or inventory commits while the
document update fails — and ADR-0026 rules out a nested transaction. The adapter
must enter the same top-level transaction that takes stock locks after `BEGIN`.
**This is the central viability issue, and it is an extension of the transaction
coordinator rather than a replacement of the ledger.**

### 7.7 Three corrections from `PUR-1`'s stopped lane — 2026-08-08

**There is no migration, and none should be written.** Module tables are created by
`module-storage-materializer.ts:1347` (`CREATE TABLE IF NOT EXISTS
north_star_module.<physicalTableName>`) from the compiled storage-transition
projection at release activation. `db/migrations/*.sql` is platform and kernel
only. **§4's "accept a migration" bridge was wrong**; an empty migration would be a
second authority for physical shape, which is the hazard §4's mount ruling names.

**Family classification is a two-place edit.** `contracts.ts`'s
`LEGAL_ENTITY_FAMILY_MAP_V1` is not the enforcement point —
`packages/compiler/src/conformance.ts:35` holds `LEGAL_ENTITY_FAMILY_RULES`, and
with only the domain rows the new entities compiled `legalEntity = undefined`
(tenant-shared, no `legal_entity_id`) and `compileInventoryContract` raised three
`INVENTORY_CONTRACT_INVALID` diagnostics. **It fails loudly**, because
`inventory-contract.cases.ts:920` deep-equals the compiled contract against the
domain map — materially better than `INVENTORY_POSTING_ROLES`, whose
contract-to-provider gap has no gate at all. Edit both, and expect the compile
failure if you forget.

**`PS-0`'s ruling 1 is now constrained from two directions, not one.** Beyond the
writability argument (`projections.ts:899`), `prepareMutation` evaluates an
update's precondition against the **projected** image, so a `not(released)`
predicate refuses the very update that performs the release. And
`RegisteredCapabilityOperationDefinition` binds `kind: 'registeredCapabilityEffect'`
to `tier: 'o1'` structurally, with the parser refusing a capability effect at any
other tier. **`PS-0` must pin the exact tier rules for record effects before
designing the transition carrier** — that is its first act, and it is cheap.
