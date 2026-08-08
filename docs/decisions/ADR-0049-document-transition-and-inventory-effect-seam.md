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

---

# Amendment 1 — the companion writer and the capability/kernel boundary

Date: 2026-08-08
Packet: `PS-1`
Status: proposed; supersedes rulings 3 and 4 of the body above, which
`docs/execution/purchasing-sales-v1-plan.md` §7.10 refuted
Probe: `packet/ps-1` at `26eb455`, extending `packet/ps-0` at `452c839`

`packet/ps-0` is now on `origin`. §7.10's reviewer could resolve neither the
branch nor the commit and had to weigh the probe's executions as recorded rather
than verified; both are fetchable, and so is this amendment's probe.

---

## A1. Who creates the companion, and how it stays congruent

**Ruled: the kernel creates it, inside the posting transaction, from a
derivation the source port computes off rows it has already locked.**

### The finding that decides it: there is no writer today, for either class

ADR-0049 §3 said `stock_count` "already carries" a companion, and read that as
precedent. It is not precedent — it is the same hole, one packet earlier.

`#post` contains exactly one `INSERT` into a business relation, and it is the
movement (`inventory-posting-service.ts:2148`). It never writes
`inventory_transaction`. Nor does the capability executor: `hydrateAdjustmentDraft`
only reads, and `adjustmentCommand` takes `transactionId: input.recordId`
(`inventory-posting-capability-executor.ts:254`) — the record being posted **is**
the `inventory_transaction`, and its `sourceType`/`sourceId` are read back out of
its own columns at `:244-252`.

So the shipped writer of every `inventory_transaction` — including every
stock-count companion — is **the generic `o0` create, driven by a user**. That is
why stock-count companions appear in `inventory_transaction_list`: they are not
leaking through a filter, they are ordinary user-authored rows that a user made.

This settles the branch. "Stage it before posting" is not an alternative design
to be priced against the other; it is a description of what ships today, and its
only existing stager is the generic authoring path that condition (2) must close.
Both branches therefore require a new internal writer. The question is only where
it runs, and inside the transaction wins on four counts:

| | inside `#post` | staged first |
|---|---|---|
| Congruence to the source | by construction — derived under the same lock | by refusal — `assertInventoryDraftHeader` catches drift and the receipt becomes unpostable |
| Repair policy for a later source edit | none owed | owed |
| Partial creation | impossible — the companion only exists in the transaction that posts it | orphan companions, reaper owed |
| Writers of `inventory_transaction` | one, the kernel | two, kernel and stager |

**The cost is real and is accepted:** the port as ADR-0049 drew it is incomplete,
and the dependency estimate omits authoritative appends of `inventory_transaction`
and `inventory_transaction_line`. Both are paid in A3 — two entries, in
Purchasing's extension rather than the kernel baseline, because Inventory's own
adjustment posting creates no companion.

### The three conditions ADR-0049 omitted

**(1) Deterministic one-to-one identity, protected by the database.** The
companion id is a v5-shaped digest of (tenant, environment, legal entity, source
type, source id) — `companionIdentity`, measured in the probe. Determinism is
what makes partial creation self-repairing: a retry derives the same id, so
`ON CONFLICT DO NOTHING` converges rather than minting a second companion. The
guarantor is a `UNIQUE (tenant_id, environment_id, source_type, source_id)`
index, which `PUR-2` owes as a migration; the probe asserts the invariant that
index will enforce.

**A correction mints its own companion; it does not reuse one.** ADR-0049 left
this open. It is not a preference — `inventory_movement` is `appendOnly`
(`contracts.ts:66`), so a compensating movement needs its own
`inventory_transaction_line` to hang from, and appending a line to the corrected
companion would silently invalidate the line-set digest that
`transitionTransactionToPosted` has already compare-and-swapped that row against
(`:2876`). One companion per **source document**; a compensating receipt is a
different source document.

**(2) Semantic reachability — and this condition is NOT met, deliberately.** See
A4. It is the gate, and it is recorded red.

**(3) An origin-bearing header — partly already enforced, and violated by
`PS-0`'s own fixture.** `assertInventoryDraftHeader` already pins the companion
header's `source_type` and `source_id` against the command
(`inventory-posting-service.ts:2185-2250`), and `insertMovement` writes the
movement's from the same command values. Header and movement cannot disagree on
origin.

What was unenforced is the pair (`type`, `source_type`). `PS-0`'s fixture staged
a header typed `adjustment` whose `source_type` said `goodsReceipt`
(`ps0-inbound-seam.test.ts`, `seedCompanionTransaction`) and nothing refused it —
a transaction claiming to be an adjustment, sourced from a goods receipt. The
amendment closes it structurally rather than with a new check:
`InventoryCompanionDerivationV1` carries **no `type` and no `state`**. Both are
server-selected by the kernel from the posting role and the compiled binding,
exactly as `transitionTransactionToPosted` selects the posted state. A port that
cannot name its companion's type cannot mint a mislabelled one.

---

## A2. Invocation-capability identity versus the posting-kernel contract

**Ruled: three identities, held apart, with admission bound to declaration.**

§7.10's refutation is confirmed in source. `capabilityId` was typed
`typeof INVENTORY_POSTING_CAPABILITY_ID` and `dependencySetRoot` likewise
(`inventory-posting-service.ts:64-75`); `validateRegistration` rejected anything
else (`:861-873`). The first Purchasing registration could not even be *written*,
let alone fail at runtime.

The gateway layer was never the problem: `createRegisteredCapabilityExecutors`
keys on `capabilityId: string` and rejects duplicates with a `TypeError`
(`capability-operation-executor-factory.ts:41-58`). The pin is entirely in the
kernel registration, which localizes the fix.

**1. Invocation capability identity** — `capabilityId`, now a **closed union**
(`InventoryPostingCapabilityIdV1`), not `string`. It namespaces the request-key
advisory lock (`planInventoryPostingRequestLock:838-859`), receipt lookup and
persistence (`findReceipt`, `insertReceipt`), the returned result identity, and
accepted invocation, change-document, event and outbox evidence. Answers *who may
invoke*. A closed union keeps an unadmitted ID a type error at assembly and a
refusal at registration; `string` would keep neither.

**2. Shared posting-kernel contract identity** — `capabilityVersion` and the
kernel dependency baseline. One constant for every registration, still checked by
equality. Answers *what the kernel is*. This is what ADR-0049 was reaching for
and attached to the wrong field.

**3. Per-capability dependency extension and command-family admission** —
`dependencyExtensionRoot` and `admittedFamilies`. Answers *what this capability
adds, and which families it may execute*.

**The naive widening, named and refused.** Widening `capabilityId` alone gives
each ID its own request-key lock, receipt, result and trust identity while
handing all of them the same union authority — separate names, no separate
admission. `#post` now refuses an unadmitted family before `pool.connect()`, with
`INVENTORY_POSTING_COMMAND_FAMILY_NOT_ADMITTED`. Measured both directions:
Inventory holds the kernel and is refused `goodsReceipt`; Purchasing is refused
`adjustment`. Admission is **not** nested — neither is a superset of the other.

**Extension and admission are declared together so they cannot drift.** A
registration claiming families beyond its admission is refused at construction
(measured). This binds (3) to (1): a capability that has not declared purchasing
reads cannot admit the `goodsReceipt` family. Without that binding this becomes a
third instance of the drift class already recorded twice in this codebase — the
authority literal duplicated at `contracts.ts:200-207` and
`conformance.ts:3215-3222`, and `reBaseline` present in
`INVENTORY_POSTING_ROLES` but absent from `InventoryPostingRoleV1` with nothing
failing.

**ADR-0049's architecture-test proposal stands, and is not sufficient.**
Single-writer has two layers: the capability contract is the authorization
boundary, `#post` the implementation boundary. One `INSERT` protects only the
second. The amendment adds a second such structural claim, and it now covers two
tables rather than one: `#post` is the sole writer of the movement **and** of the
companion. The port returns values; it never holds an `INSERT`.

---

## A3. The dependency contract's shape

**Ruled: a frozen kernel baseline plus per-capability extensions. Not separately
derived roots.**

The deciding argument is duplication, not elegance. Separately derived roots make
every capability re-declare the kernel's 35 entries. That is the same drift class
as the two instances above, at larger scale, adopted to fix a root-stability
problem that baseline-plus-extension fixes without duplicating anything.

**The shape already exists and the conformance rule is what collapses it.**
`INVENTORY_CONTRACT_V1.authoritativeDependencies` carries **two** arrays,
`dependencies` and `accessPlan` (`contracts.ts:212-219`), with the right
semantics latent — declared superset versus what is actually touched — and
`conformance.ts:2664-2675` already refuses an `accessPlan` entry absent from
`dependencies`. What forbids the split is `:2624-2643`, which requires **both**
arrays to hash to the same single constant. Today they are literally the same
array (`:534`), so the check is vacuous. Baseline-plus-extension is the shape the
contract was built for and the root check has been holding shut.

**Measured, and the point of the ruling:**

- Kernel baseline: **unchanged**, 35 entries, root
  `ffd4e9f6103b5c6053c39b62fe64e69dd255cb0c86cfd349ae465ab25179b3d3`. The probe
  does not touch `contracts.ts` at all — verified on the diff. Adding Sales later
  will not move it, and will not change Inventory's or Purchasing's admission
  contract when their behaviour has not changed. That is precisely §7.10's
  objection 4, and it is what this shape buys.
- Inventory's extension: empty, root
  `d2e2dc9629b39ace33240bb329a1975deb8f58fca1e90201b1b1d962426af63f`.
- Purchasing's extension: **8 entries**, root
  `f38a3dd470c8cabe1cb2e1d90ee889439ae4d1c21821f1c9c2aff466df44d80f` — the six
  purchasing reads and transitions `PS-0` estimated, **plus** the two companion
  appends A1 makes explicit (`northstar.inventory:transaction` and
  `:transaction_line`).

**The two companion appends belong in the extension, not the baseline**, and this
is the clearest illustration of the shape being right: the same kernel code
touches different relations depending on which capability invoked it. Inventory's
adjustment posting creates no companion — the user authored the transaction — so
the append is capability-conditional. The extension is exactly that delta.

**`PS-0`'s 41-entry candidate root
`f8a689762e6238bddd407ba35d0f3836d6eb2eb8cd9275d43f1f39a5989ba82e` is
withdrawn.** It was a single union root over 35 + 6, and it is wrong twice: it
omits the companion appends, and its shape is the one this ruling refuses.

**Priced.** The baseline literal is pinned at four executable sites —
`contracts.ts:8`, `conformance.ts:33`, `inventory-posting-service.ts:39`, and
`test/compiler/inventory-contract.release.golden.json:106` — plus two documents
(`ADR-0029:81`, `G3-P4b.md:26`) and seven test files consuming the exported
symbol. **None of those move.** What `PUR-2` changes is narrower: the
`dependencySetRoot` type on the registration widens to carry an extension
alongside the baseline, `conformance.ts:2624-2643` stops requiring both arrays to
hash to one constant and starts verifying baseline and extension separately, and
a `purchasing` member joins the authority union in its two unlinked places
(`contracts.ts:200-207`, `conformance.ts:3215-3222`). An undeclared authority
still surfaces as `INVENTORY_POSTING_DEPENDENCY_UNDECLARED`.

---

## A4. `received_quantity` — ruled

**Ruled: lock-and-sum on a derived quantity. `PUR-2` adds a read model, not a
stored column.**

`PS-0` measured both closing the race and chose neither. Three things break the
tie, and none is a preference:

1. **The stored column is a second truth about a fact the ledger already owns.**
   Received quantity is a function of posted movements. A stored column is a
   cache of a derivation, and ADR-0049's own §3 refused a ledger redesign on the
   grounds that the ledger is the foundation. Storing a derived total re-creates
   in Purchasing exactly the competing-truth problem the companion ruling spends
   A1 avoiding in Inventory.
2. **Compare-and-swap's guarantee is narrower than the lock's, and the
   correction here is the same one §7.10 made about the lock.** CAS closed the
   *measured single-line* race with a complete predicate. It does not extend to
   a receipt spanning several order lines, to constraints spanning several
   orders, or to insertion phantoms — a new line arriving between validation and
   swap is not observed by a predicate over the rows already seen. Lock-and-sum
   over the order aggregate serializes all of those, because it takes the lock on
   the shared parent rather than on each moving value.
3. **Repair.** A drifted cache needs a reconciler; a derived sum cannot drift.

**The cost, stated plainly:** lock-and-sum reads the movement history per posting
and holds the purchase-order lock across it. `PS-0`'s lock-only arm measured this
closing the race with one success of two, and the lock converts a late abort into
an early wait — the throughput cost is real and is the price of not keeping a
second truth. If a later packet measures that cost as prohibitive, the stored
column returns as an **optimization with a reconciler**, not as the primary.

**`PUR-2` adds** a read model deriving received quantity from posted movements
scoped to the order line, and the open-quantity check reads it under the
purchase-order lock. **`SAL-2` inherits the same answer** for shipped quantity
and open-to-ship. **`PUR-1` dropping the field is correct** and needs no revision.

---

## A5. The correction ADR-0049 owes on its own wording

ADR-0049's probe section concluded that "the pessimistic lock is an
optimization." **That is withdrawn.** It is proven only for the measured
single-aggregate invariant with a complete compare-and-swap predicate. It is not
proven for multi-line write skew, constraints spanning several orders or
receipts, insertion or archival phantoms, incomplete digest predicates,
correction racing cancellation, or lock ordering across several foreign
aggregates.

**The generalization the rollback vertical actually supports, and the one carried
forward: movement append and source transition must share a transaction.** That
is what the fourth race arm demonstrates — preflight-then-post-then-mark
over-receives — and it is what control 6 demonstrates from the other side: a
failure after the movements exist leaves zero movements, the receipt `draft`, and
the quantity unchanged.

The protocol retains **both** source locking and a complete compare-and-swap
until broader controls prove one redundant. A4 chooses the lock as primary for
`received_quantity` on the reasoning above, which is an application of this rule,
not an exception to it.

---

## A6. The gate — recorded red, and binding on `PUR-2`

Condition (2), semantic reachability, is **not met**, and the amendment does not
pretend otherwise. The compiled release emits, for `inventory_transaction`
alone, four generic `o0` operations (create, update, archive, restore), four
queries (get, list, search, resolve) and three surfaces (list, detail, form) —
and the same again for `inventory_transaction_line`. Twenty-two paths. Filtering
`inventory_transaction_list` closes one.

The probe carries `PS-1 CONTROL (expected red): the companion is unreachable
generically`, which enumerates those paths and reports every one that reaches the
companion. **It fails, by name, on purpose.** `get` by id bypasses any list
filter by construction, and nothing in the compiled release distinguishes a
kernel-authored companion from a user-authored document — which is exactly why
the rule must be semantic rather than presentational.

**`PUR-2` may not add a receipt companion until this control is green for
stock-count companions and receipt companions together, in one gate.** ADR-0049
recorded conditions 1–3 as debt owed for stock counts. Recording debt twice is
not closing it, and a second class of hidden document behind a rule that holds
for neither class is strictly worse than one. This also forces the answer to
ADR-0038's open question — whether the generic `o0` create on
`inventory_transaction` should be retired — which ADR-0049 deferred to `PUR-2`
without noticing that the same question is what makes the *existing* leak
possible.

---

## A7. What the probe settled, and what it cost

`packet/ps-1` at `26eb455`, extending `packet/ps-0`'s vertical rather than
restarting it. Sections 1–7 run unchanged except that the test no longer stages
the companion — the kernel does. Three files, 822 insertions, all marked probe
only. Zero new type errors against an unmodified `packet/ps-0` baseline, with
workspace types fully resolved.

| What | Result |
|---|---|
| Companion created by the kernel inside the transaction | authored; header and lines derived from the locked source |
| Companion identity deterministic and one-to-one | asserted against `companionIdentity`, one row per source document |
| Correction mints its own companion, source unmutated | both companions reach posted; received returns to 0 |
| Second capability registration posts a receipt | result identity and receipt row namespaced to Purchasing |
| Inventory refused `goodsReceipt`; Purchasing refused `adjustment` | both refuse with `INVENTORY_POSTING_COMMAND_FAMILY_NOT_ADMITTED` |
| A registration widening its own `admittedFamilies` | refused at construction |
| ADR-0026 lock order survives the new call | asserted on the query trace, source lock now precedes the companion header lock |
| Generic reachability | **RED — 13 paths open.** A6 |

**The lock order is widened, never reordered.** `lockAndValidate` moves ahead of
the companion header lock so the source is locked before anything is derived from
it. The order is now: stock identities immediately after `BEGIN`, request key,
source aggregate, companion header. `PS-0` measured its race with the source lock
one position later, so moving it earlier strictly lengthens the serialized region
and preserves that result rather than reopening it.

**One thing the extension weakens, stated rather than hidden.**
`assertInventoryLineSet` was a defence against a user-authored companion drifting
from the command. With the kernel deriving the companion in the same transaction
there is no drift window, so that check becomes a structural self-assertion on
the kernel's own write. It is kept — it still catches a kernel defect — but it is
no longer load-bearing against the hazard it was written for, and `PUR-2` should
not cite it as one.

---

## A8. What §7.10 still gets wrong

Two items, both minor against a section that was right on all five of its main
points and on both refutations.

1. **§7.10's item 5 says the stock-count precedent is "evidence the risk is
   already live and unclosed."** True, and it understates. The risk is not that a
   companion-creating mechanism leaks; it is that **no companion-creating
   mechanism exists** — the shipped writer is the user, through the generic
   create. Stock-count companions are not hidden documents that escaped, they are
   ordinary documents nobody ever hid. That changes what `PUR-2` must build: not
   a filter over an existing internal writer, but the internal writer itself,
   plus the retirement of the generic authoring path.
2. **§7.10 treats the 41-entry root as "conditional" — pending the companion
   protocol.** It is not conditional, it is the wrong shape, and no companion
   ruling would have made a single union root correct. A3 withdraws it rather
   than completing it.

**Not wrong, and worth recording as confirmed:** §7.10's ruling that the
capability contract and `#post` are two distinct boundaries is exactly right, and
A2 is its implementation. Its correction to the pessimistic-lock wording is
adopted verbatim in A5.

---

## Amendment boundaries

Unchanged from the body: no purchase-order or sales entity, module, mount,
migration, HTTP route, agent tool, UI binding, valuation, or reservation writer.
This amendment additionally does **not** authorize the receipt companion itself —
A6 gates it — does not move the kernel dependency baseline, does not add a
posting role, and does not merge either probe. The `5g3-sm-impl` transition
carrier is untouched; ADR-0050 stands, and release and cancel run at `tier: 'o0'`
through the generic press with no capability executor owed.
