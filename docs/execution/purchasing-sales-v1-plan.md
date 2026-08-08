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

### 7.8 `PS-0` ruled the seam, and corrected §7 in three places — 2026-08-08

**Superseded by [ADR-0049](../decisions/ADR-0049-document-transition-and-inventory-effect-seam.md).**
Read that; this records only what §7 got wrong, so the errors are not re-inherited.

- **§7.1's "`main` provides no generic named-transition tier" is WRONG.** ADR-0038
  shipped one and it is in the active release: `inventory_transaction_post` is
  authored `tier: 'o1'` with a `registeredCapabilityEffect`
  (`definition.ts:1266`, `:1286`), its input contract is closed to
  `['expectedRevision','recordId']` with **no patch** (`projections.ts:848`), and
  the target state is a compiled binding constant written by a compare-and-swap
  `UPDATE`. Exactly one of 39 operations is `o1`. **The consequence for `PUR-1`:**
  `tier: 'o1'` and `registeredCapabilityEffect` are equivalent both ways at the
  gateway, so **PO release and SO confirm need a registered capability even though
  they write no movement.** There is no record-transition effect, and inventing
  one is a language event.
- **§7.6's "the adapter must enter the same top-level transaction" is not
  achievable, and is unnecessary.** `#post` calls `pool.connect()` itself, so
  there is no outside position to join from. What works is the transaction
  **carrying the foreign aggregate through a port** invoked at ADR-0026's steps
  4/5 and 7 — which is what ADR-0029 already did for stock count, with hard-coded
  branches instead of a port.
- **"Preflight-then-post-then-mark is unsafe" was imprecise — the *mark* is the
  unsafe part.** The shipped executor already preflights in its own transaction
  and is safe because hydration carries no authority and everything is
  re-validated under lock. **The rule to freeze is "hydrate as a proposal, decide
  under lock."**

**§5's assumption 1 is refuted with a count**, not an argument: a receipt posting
role costs **eight code sites plus a migration**, a new purchasing authority member
is needed in two unbound places (`contracts.ts:200-207`,
`conformance.ts:3215-3222`), the dependency root is pinned at four executable
sites, and a candidate v5 with six purchasing entries moves 35 entries to 41 with
root `f8a68976…`. `reBaseline` remains in the contract and absent from the provider
union, unguarded.

**Measured, and sharper than the charter assumed:** two receipts at different
locations are different stock identities, so the stock serializer does not
serialize them. Across four arms, lock-only, compare-and-swap-only and both each
admitted exactly one winner; **neither** admitted two and received 20 against an
order of 10. **Either mechanism closes the race provided it is inside the posting
transaction — the pessimistic lock is an optimization, not the requirement.**

**Ruling 4 (separate Purchasing/Sales capability IDs over one shared kernel) is the
one ruling the probe did not measure.** It is reasoned from registration code.
`PUR-2` must land the second registration and report the cost.

### 7.9 New row — `posting-error-classification`

**OPEN 2026-08-08, found by `PS-0`'s probe, on `main`.**
`inventory-posting-service.ts:3877`'s `postgresCode` delegates to
`postgresErrorProperty`, which checks only that the property exists — so **any
error carrying a string `code` is classified as a PostgreSQL rejection.** The probe
saw a domain refusal surface as
`INVENTORY_POSTING_STORAGE_REJECTED: PostgreSQL rejected inventory posting
(PS0_RECEIPT_OPEN_QUANTITY_EXCEEDED)`. Node's `ERR_*` errors have the same shape,
so an ordinary runtime fault is reported as a storage rejection. The probe carries
a one-line fix. **It needs its own row because it changes an error contract**, and
existing assertions pin those codes.

### 7.10 ADR-0049 is NOT ratified — review returned BLOCK 2026-08-08

**§7.8 above is wrong in five ways and is superseded by this section.** All five
errors are the orchestrator's.

1. **"A generic named-transition tier already ships" — false.** `o1` is generic
   *capability dispatch*. Server-selected target state, compare-and-swap,
   authoritative rehydration and accepted trust writes are
   `InventoryPostingCapabilityExecutor` behaviour, **not gateway-enforced**. Any
   executor may implement different semantics.
2. **"There is no record-transition effect, and inventing one is a language
   event" — false, and verified false.** `transitionStateEffect` exists at
   `schemas.ts:934`; `transitionDefinition` carries server-authored `fromState`
   (`:623`), `toState` (`:629`) and permission; the compiler transports the effect
   generically. **The gateway contains zero references to it.** This is an
   **enforce-or-retire** decision on shipped language, which is exactly what queue
   row `5g3-sm` was created to own. `U5b`'s round-3 review found the same fact
   independently through `parseOperationBinding`.
3. **"The pessimistic lock is an optimization" — overstated.** Proven for the
   measured single-aggregate invariant with a complete CAS predicate. Not proven
   for multi-line write skew, constraints spanning several orders or receipts,
   insertion or archival phantoms, incomplete digest predicates, correction racing
   cancellation, or lock ordering across several foreign aggregates. **Correct
   wording:** *for the measured one-order race, either source locking or a
   complete compare-and-swap independently prevents double receipt; the protocol
   retains both until broader controls prove one redundant.* **The rollback
   vertical proves something stronger and safer to generalize: movement append and
   source transition must share a transaction.**
4. **The 41-entry root is conditional, not final.** It omits whichever
   companion-creation protocol Ruling 3 settles, and preserves an unresolved
   contradiction — separate capability ownership versus one Inventory union root.
5. **The companion has no writer, and this is the highest-value finding.** Ruling 3
   requires an internal `inventory_transaction` and lines per receipt, but `#post`
   **requires the companion to already exist** — it plans movements with supplied
   `transactionId`/`transactionLineId`, row-locks the header, digests the line set
   and validates it before appending. Ruling 2's port exposes only
   `lockAndValidate` and `transition`. **Nothing creates the companion.** The
   stock-count precedent is not evidence the risk is controlled; it is evidence the
   risk is already live and unclosed.

**Also refuted: Ruling 4.** `InventoryPostingRegistrationV1.capabilityId` is typed
`typeof INVENTORY_POSTING_CAPABILITY_ID` and the dependency root likewise
(`inventory-posting-service.ts:64-75`), so a Purchasing registration cannot be
typed. Capability identity additionally namespaces the request-key advisory lock,
receipt lookup, result identity and trust evidence. **Single-writer has two layers**
— the capability contract is the *authorization* boundary, `#post` the
*implementation* boundary — and an architecture test finding one `INSERT` protects
only the second.

**Upheld:** Ruling 2's ownership model, narrowly — `#post` owns its connection and
transaction, an external adapter cannot join it, the source aggregate rides
provider-owned hooks, and preflight is safe only as an untrusted proposal
re-decided under lock. Ruling 3's *structural choice* of a companion is upheld; its
four conditions are not sufficient — it owes deterministic one-to-one identity, a
**semantic** rather than presentational reachability rule covering create, update,
archive, restore, get, list, resolve and agent exposure, and an origin-bearing
companion header.

**Sequencing changed: `5g3-sm` moves AHEAD of `PUR-1`.** Its own row warned that
"deciding the fate of a language concept as a side effect of an inventory packet is
how a second authority gets created by accident" — and `PUR-1` shipping a
capability executor for release would have retired `transitionStateEffect` by
accident. **`PUR-1` starts after that decision. `PUR-2` stays blocked** until the
companion-creation protocol and the invocation-capability-versus-kernel-contract
distinction are in ADR-0049.
### 7.11 ADR-0050 ratified — `transitionStateEffect` is honoured, 2026-08-08

**`5g3-sm` is settled and `PUR-1` is unblocked by it.** Two facts were verified
independently before ratifying.

**They are one construct, so the choice was never two-sided.**
`transitionStateEffect` carries exactly `kind`, `schemaVersion` and `transition`
(`schemas.ts:933`) — no entity, no field, no target — and `transitionDefinition`
is declared at `:622` and referenced exactly once, inside `stateMachineDefinition`'s
`transitions` array. *Honour one, retire the other* is not available.

**The current state is a trap, not neutral debt.** One declared
`transitionStateEffect` makes **every operation in the release** fail with
`MalformedPinnedOperationCatalogError` — an unrelated `master_create` dies with it —
and the refusal names neither the operation nor the effect. That is an ADR-0046
misnamed-cause defect layered on the ADR-0041 one. And the target it names is
unreachable: a precondition on the machine's state field fails
`CANON_REFERENCE_UNRESOLVED`, a query selecting it fails `CANON_QUERY_FIELD_LOCALITY`.
**Accepted and unimplementable**, not accepted and ignored.

**It is a canonical-language event and retirement is not cheaper.** ADR-0049 §1
already priced re-inventing a transition effect as a language event, so retiring
means paying twice *and* hand-writing a capability executor for every release,
confirm and cancel in between.

**Three corrections this makes to §7.10 and ADR-0049, all the orchestrator's:**
§7.1's *"every business transition needs a named O1 handler"* is half wrong —
refuting *enum plus precondition is a lifecycle* was right, concluding `o1` does
not follow; what was missing is a **compiled patch, not a tier**. ADR-0049 §1
attributed compare-and-swap, authoritative preconditions and trust writes to `o1`;
three of those four are ordinary generic-press behaviour and **only
server-selected target is new**. And the transition runs at `tier: 'o0'` through
the generic press, measured — so **`PUR-1` does not write capability executors for
release and cancel.**

**No ADR-0034 exception is needed:** the projected-image check is scoped to
`updateRecordEffect` because an update carries a caller patch; a transition carries
none, so the hazard is structurally absent. Measured — a `not(released)`-shaped
guard admits the release and refuses the second.

**Cost, and the one item that gates `PUR-1`:** the language cut, plus six probe
findings. **Load-bearing: the state field has no read path.** It is correctly
excluded from caller-writable contracts, but nothing admits it to query selections,
so a released purchase order cannot be listed by state. **`PUR-1` cannot ship
without that.** The rest: release verification cannot populate a field no caller may
write (`5g3-mount` class, `systemInput` is the precedent); the closed-argument
fence sits at the interpreter rather than the gateway for O0; the per-entity field
budget; `apps/web`'s `operationIntent` returns `null` for the effect kind; and the
misnamed refusal above.

### 7.12 `received_quantity` is `PUR-2`'s decision, not `PUR-1`'s — ruled 2026-08-08

`PUR-1` authored `receivedQuantity: field('purchase_order_line', 'received_quantity')`
(`packages/domain/src/purchasing/definition.ts:52`) — a **stored column**, and a
surface row displaying it. Plan §1276 calls it a *read model* **derived from posted
receipts**.

**It is not a simple defect, and that is why it must be routed rather than
corrected.** `PS-0`'s four-arm race closed over-receipt with **compare-and-swap on a
stored received quantity**, and CAS requires a stored value to swap on. The
lock-only arm closed the same race, and that one works against a derived sum under
lock. **Both are supported by the measurement; neither has been chosen.**

**Ruling: `PUR-1` drops the field.** It ships no receipts, so the value can only
ever be zero — a permanently-zero column and a surface row buy nothing while
pre-committing the open-quantity mechanism. **`PUR-2` adds it with the posting
protocol that decides it:** a stored column if it takes the CAS route, a derived
read model if it takes lock-and-sum. `SAL-1`/`SAL-2` inherit the same rule for
shipped quantity and open-to-ship.

**This is the `5g3-sm` shape a second time** — an inventory packet settling a
platform decision as a side effect of shipping. The charter caused it: the `PUR-1`
prompt listed *"line number, item, ordered quantity, received quantity, unit
price"* without the plan's *derived* qualifier.

### 7.13 `PS-1` corrects §7.10 item 5 — 2026-08-08

**Item 5 said the companion has no writer. The truth is larger: no companion
*mechanism* exists at all.** Verified: `#post` contains exactly **one** business
`INSERT` — the movement at `inventory-posting-service.ts:2148`; the other five
target `platform.*` receipts, trust invocations, change documents, domain events
and outbox. And `inventory-posting-capability-executor.ts:254` passes
`transactionId: input.recordId`, so **the record being posted *is* the
`inventory_transaction`.**

**Therefore the shipped writer of every companion — stock-count included — is the
generic `o0` create, driven by a user.** Stock-count companions are not documents
that escaped a filter; they are ordinary documents nobody ever hid.

**This changes what `PUR-2` builds** from *a visibility filter* to *the writer,
plus retiring the generic authoring path*. It also collapses ADR-0049's two
branches: "stage it before posting" is not an alternative, it is what ships, and
its only stager is the authoring path that must be closed. Both branches need a
new internal writer; **inside the posting transaction wins on
congruence-by-construction** — no repair policy, no orphans, one writer — at the
honest cost of two companion appends in the dependency contract.

**§7.10's other error: the 41-entry union root is not conditional, it is the wrong
shape**, and it is withdrawn rather than completed. No companion ruling would have
made a single union root correct.

**Ruled by `PS-1`, pending review** — ADR-0049 remains unratified and this
amendment supersedes two of its rulings.
