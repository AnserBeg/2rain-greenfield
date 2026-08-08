# ADR-0049: The document-transition and inventory-effect seam

Date: 2026-08-08
Status: proposed by packet `PS-2`; ratified when that packet is accepted
Tier: Critical (it decides how every business document reaches the ledger)
Supersedes: the `PS-0` text of this ADR and its `PS-1` amendment, both in full

**This is one ruling. It has no amendment and no appendix.** The `PS-0` body and
the `PS-1` amendment were rewritten away rather than annotated, because four
implementation packets read this file and none of them should have to work out
which sentence still governs. Where an earlier version said something different,
the earlier version is gone; §9 of this document lists what it got wrong so the
mistakes are not re-derived from the execution log.

Everything asserted here was read in source or measured by a probe. §8 names
every suite that ran, with its result. Nothing in this document is described as
observed unless it was.

**Probe lineage, all preserved and none merged, in the manner `proj-disc` set:**
`packet/ps-0` at `452c839`, `packet/ps-1` at `a00e97f` (**do-not-reuse**, see
§1.2), `packet/ps-2` at `0d22ad9`.

---

## 1. Two refutations

These lead because they are the durable output. Both invalidate work that had
already been approved, and both were found by construction rather than by review.

### 1.1 The generic press cannot hold module identity by any route

**Refuted: a provider-owned posting-family catalog behind a parity gate.**

`PS-2` needed the posting-family declaration to reach `#post`. The provider does
not depend on `@north-star/domain` and must not — it is a generic storage
adapter and inverting that layering is worse than the alternative. So the
catalog was placed in the provider, with `test/unit/posting-family-catalog-parity.test.ts`
asserting it identical to the authored copy, and this was reasoned as *duplication
debt behind a gate, defensible for one packet*.

**That reasoning was wrong, and the architecture guard said so.** `ps2-r3` returned:

    PRESS006_MODULE_ID_IN_PRESS
    packages/postgres-provider/src/inventory-posting-service.ts:259
    'generic press references inventory identity northstar.inventory'

The catalog embeds `northstar.inventory:transaction`,
`northstar.purchasing:goods_receipt` and six more module identities inside the
generic press. **The defect was never duplication.** A single copy in the
provider would violate the same law. The compiled projection family is therefore
**the only admissible home**, not the tidy eventual one — which changes its
status from deferred cleanup to a precondition for this design being coherent
at all (§7.3).

`module-press-law.test.ts` carries an exact allowlist of known violations, and a
one-line entry there would have turned the matrix green. **No entry was added.**
The allowlist registers debt; using it here would have converted an
architectural refutation into a footnote, which is precisely the failure mode
§7.1 names.

**Filed separately: `press-law-evasion`.** The same file already carried a module
identity and evaded this guard. `inventory-posting-service.ts:36` writes

    export const INVENTORY_POSTING_CAPABILITY_ID =
      `${'northstar'}.${'inventory'}:capability.posting` as const;

The literal is spliced so the scanner cannot match it. `PS-2`'s eight dependency
ids could not be spliced without absurdity, so they tripped the guard honestly
and exposed the existing evasion beside them. **A guard that can be defeated by
string concatenation is a guard with a documented bypass**, and the bypass is in
the very file the guard exists to protect.

### 1.2 `PS-1`'s lock reorder was an ABBA hazard reported as a safety improvement

**`packet/ps-1` is marked do-not-reuse.**

`PS-1` moved the source-aggregate lock ahead of the companion header lock and
recorded it in this ADR as *"lock order is widened, never reordered … moving it
earlier strictly lengthens the serialized region."* Both halves of that sentence
are false.

It is a **reorder**: the `{companion header, source}` edge changed direction.
No edge was added, so nothing was widened.

And the reorder was **not uniform**. It applied only where a foreign source port
had been injected. `lockAndAssertStockCountEvidence` kept taking the companion
header first. So a goods-receipt posting would take `{source → companion header}`
while a concurrent stock-count posting took `{companion header → source}` — the
same two locks in opposite orders, which is a textbook ABBA deadlock between two
posting families.

**A reorder is sound only if it is uniform**, and that is the strongest argument
for the posting-family profile in this entire packet: the profile is what makes
the order a property of every family rather than of whichever call site happened
to be edited. `PS-2` enforces one order for all families — stock identities
immediately after `BEGIN`, request key, source aggregate, companion header.

The lesson generalizes past locks. `PS-1` did not measure this claim; it reasoned
it, in confident language, in a ruling. §8 exists because of that.

---

## 2. The compiled posting-family profile

**Ruled: a closed, compiled posting-family profile, consumed by `#post`.**

`PS-1` was blocked because three questions — who writes the companion, how
invocation identity separates from the kernel contract, what shape the dependency
contract takes — turned out to be three views of one missing concept. The
provider declared `readonly familyId: string`, an unrestricted string documented
as *a diagnostic name*, and selected authorization with
`if (service.sourceAggregateFamilyId === 'goods_receipt')`. **A magic string
decided who could post what**, and every ruling that wobbled traced to it.

One declaration per admitted family binds **eleven facts** that were previously
spread across a switch on posting role, a hard-coded companion branch, an
admission list, and a dependency-root literal that nothing tied to any of them:

| Fact | What it replaces |
|---|---|
| `capabilityId` | the magic-string comparison |
| `commandSchema` | a receipt borrowing the adjustment command type |
| `postingRole` | `transactionType()`'s switch on role |
| `companion.transactionTypeLocalId` | the same switch, one layer down |
| `companion.createdByKernel` | `if (this.sourceAggregate)` |
| `companion.sourceTypeLiteral` | caller-supplied provenance |
| `companion.identity.*` | half-derived, half-caller-supplied ids |
| `revisions.*` | one `sourceRevision` doing three jobs |
| `sourceStep` | `if (this.sourceAggregate)`, again |
| `dependencyExtension` | a hand-kept root literal |
| `reachability` | a presentational list filter |

It is pinned domain policy in the manner `INVENTORY_STORAGE_REFERENCES_V1`
already is: a closed declaration the compiler validates and the provider
consumes, carrying no storage schema and no handler. **It is not a canonical
language change.** Its compiled home is §7.3's projection.

**Authorization is capability ownership of a profile**, resolved from the
catalog by the family the entry point names — never inferred from an injected
port's diagnostic name, and never from the posting role, both of which a caller
controls. An unadmitted family refuses with
`INVENTORY_POSTING_COMMAND_FAMILY_NOT_ADMITTED` before `pool.connect()`, so it
never opens a transaction.

**Admission is derived, not declared beside the extension.** `admittedFamiliesFor`
and `dependencyExtensionFor` both read the same profiles, so the two cannot
drift. `PS-1` kept them as separate declarations and asserted they could not
drift; deriving one from the other is what makes that true instead of stated.

---

## 3. The companion, and who writes it

### 3.1 The kernel writes it, inside the posting transaction

**Ruled: `#post` creates the companion `inventory_transaction`, from a
derivation computed off rows already locked in the same transaction.**

The finding that decides it, verified in source: **no companion mechanism
exists today, for either class.** `#post` contains exactly one business `INSERT`
and it is the movement (`inventory-posting-service.ts:2148`); the other five
target `platform.*`. The capability executor only reads, and
`adjustmentCommand` passes `transactionId: input.recordId`
(`inventory-posting-capability-executor.ts:254`) — **the record being posted
*is* the `inventory_transaction`.**

So the shipped writer of every companion, stock-count included, is the generic
`o0` create driven by a user. Stock-count companions are not documents that
escaped a filter; they are ordinary documents nobody ever hid.

That collapses the two branches an earlier version of this ADR weighed.
*"Stage it before posting"* is not an alternative design — it is what ships, and
its only stager is the generic authoring path §4 must close. Both branches need
a new internal writer; inside the transaction wins on four counts:

| | inside `#post` | staged first |
|---|---|---|
| Congruence to the source | by construction, under one lock | by refusal; the source becomes unpostable |
| Repair policy for a later source edit | none owed | owed |
| Partial creation | impossible | orphans, reaper owed |
| Writers of `inventory_transaction` | one | two |

**The port returns values and never writes.** `#post` remains the sole writer of
the companion exactly as it is of the movement. This is the second structural
single-writer claim, and it now covers two tables rather than one.

### 3.2 Identity, provenance, and the revision split

**Deterministic one-to-one identity, both halves derived.** The companion header
id is a v5-shaped digest of (legal entity, source type, source id); each
companion line id is a digest of (header id, source line id). Determinism makes
partial creation self-repairing — a retry derives the same ids, so
`ON CONFLICT DO NOTHING` converges rather than minting a second companion. The
guarantor is a `UNIQUE (tenant_id, environment_id, source_type, source_id)`
index that `PUR-2` owes as a migration. `PS-1` derived the header's id and left
the line's caller-supplied, so a caller still chose half the identity.

**A correction mints its own companion.** Not a preference:
`inventory_movement` is `appendOnly` (`contracts.ts:66`), so a compensating
movement needs its own `inventory_transaction_line`, and appending one to the
corrected companion would silently invalidate the line-set digest
`transitionTransactionToPosted` already compare-and-swapped that row against.
One companion per **source document**; a compensating receipt is a different
source document.

**Provenance is immutable and server-selected.** `companion.sourceTypeLiteral`
and `companion.transactionTypeLocalId` come from the profile — never from the
command, never from the port. A port that returns a different origin is refused
rather than trusted.

This closes a hole `PS-0`'s own fixture had and `PS-1` reproduced: a header
typed `adjustment` whose `source_type` said `goodsReceipt`. `PS-1` claimed to
forbid that pair structurally while posting receipts through `postAdjustment`,
which handed them the adjustment role, the adjustment companion type, adjustment
reason and approval semantics, and a domain event named for an adjustment. Its
test read the type column and never asserted on it.

**The revision split.** `PS-1` had one `sourceRevision` doing three jobs: the
foreign document's expected revision, the companion's expected revision, and the
value stamped on every movement. **A kernel-minted companion's revision is
internal** — the kernel creates the row, so nothing outside can have observed a
revision to assert. `InventoryGoodsReceiptPostingCommandV1` carries
`sourceExpectedRevision` only; the companion's is not representable.

### 3.3 Both classes are profiles

**Ruled: `stockCount` and `goodsReceipt` are both companion-origin profiles.**

`PS-1` gated its companion writer on `if (this.sourceAggregate)`, so
`postStockCount` escaped it entirely. Two consequences it did not notice: it left
Inventory's dependency extension **empty**, and it made the one-gate reachability
requirement **unsatisfiable**, because only one of the two companion classes had
a kernel writer to govern.

Keying the writer on `profile.companion.createdByKernel` puts stock count on the
same path. **Measured consequence:** Inventory's extension is no longer empty —

    northstar.inventory:capability.posting
      admitted      = adjustment, stockCount, transfer
      extensionRoot = 7c2e1638f32b0443eb8948c44b4da0b13d911364eb84d6fb0ef395f4fa43a070
      entries       = append:northstar.inventory:transaction
                      append:northstar.inventory:transaction_line

---

## 4. Reachability: the origin axis makes it structural

**Ruled: a transaction's `origin` is `authored` or `companion`, and reachability
follows from it by validation, not by a separate test.**

`authored` means the user creates the `inventory_transaction` and it *is* the
business document — today's adjustment and transfer. `companion` means the
kernel mints it as an implementation detail of a foreign document.

`validateRegistration` refuses any profile whose declared reachability disagrees
with its origin, and refuses any profile that claims a kernel writer without
companion origin or vice versa. So the rule is a property of the declaration
rather than an assertion someone remembers to write.

**The positive half is load-bearing.** `authored` transactions must remain
reachable through every generic path. Without that half, deleting all generic
transaction operations and queries would satisfy *"companions are unreachable"*
while silently removing ordinary adjustment authoring — a rule that passes by
destroying the thing it was protecting. The compiled release emits four `o0`
operations, four queries and three surfaces for `inventory_transaction`, and the
same again for its lines: twenty-two paths. Filtering one list closes one door.

**A6 is proven for one class and declared for the other.** The gate is
parameterized over the compiled operation catalog rather than hard-coded labels,
and it reports both halves. But no stock-count posting runs in this packet's
vertical (§7.4), so the companion half is executed for `goodsReceipt` and
asserted only by declaration for `stockCount`. **The whole point of one gate for
both classes is that they cannot be closed separately**, so a declared-only half
is a real gap, not a rounding error. `PUR-2` closes it for both or adds neither.

---

## 5. The dependency contract, and the re-pricing of the old §5

**Ruled: a frozen kernel baseline plus per-capability extensions.** Not
separately derived roots, which would make every capability re-declare the
kernel's 35 entries — the same drift class this repository has already recorded
twice, at larger scale, to fix a problem the baseline-plus-extension shape fixes
without duplicating anything.

The two-array shape already exists: `INVENTORY_CONTRACT_V1.authoritativeDependencies`
carries `dependencies` and `accessPlan` (`contracts.ts:212-219`) with the right
semantics latent, and `conformance.ts:2664-2675` already refuses an `accessPlan`
entry absent from `dependencies`. What forbids the split is `:2624-2643`,
requiring **both** arrays to hash to one constant — and today they are literally
the same array, so the check is vacuous.

**Measured:**

- Kernel baseline **unchanged**, 35 entries, root
  `ffd4e9f6103b5c6053c39b62fe64e69dd255cb0c86cfd349ae465ab25179b3d3`. Adding
  Sales later will not move it, which was the whole objection.
- Inventory extension: `7c2e1638f32b0443eb8948c44b4da0b13d911364eb84d6fb0ef395f4fa43a070`
- Purchasing extension: `86aa19ec1d01f7313f1329873ed6a65056b28401be2a84af2b3e159bd0bceff3`

**Withdrawn: `PS-0`'s 41-entry union root
`f8a689762e6238bddd407ba35d0f3836d6eb2eb8cd9275d43f1f39a5989ba82e`** — wrong
shape, not merely incomplete. **Withdrawn: `PS-1`'s eight-entry Purchasing root
`f38a3dd470c8cabe1cb2e1d90ee889439ae4d1c21821f1c9c2aff466df44d80f`** — its
preimage contains a `purchase_order_line.received_quantity` transition, the
stored counter §6 withdraws.

### The old §5's estimates have now been refuted twice by measurement

The `PS-0` text of this ADR estimated costs from source-reading. Both estimates
that a probe later executed came back larger. **Do not re-derive a third
estimate from that section — it is superseded by these measurements.**

**"Receipt digest version 4 is a six-line migration."** Measured: **six sites**,
of which one is six lines.

1. `db/migrations/0022_…` — the CHECK constraint
2. the version constant
3. the `currentCommandDigest` selector
4. the `digestCommand` arm
5. the `VersionedInputDigest` union
6. `db/schema.snapshot.json`

Found by execution: `digestCommand` admits `adjustment`/`transfer` at v2 and
stock count at v3, so a `receipt` role has **no arm at any version** and the
*first* receipt posting refuses. It is a hard blocker, not a follow-on cost.

**"A `receipt` posting role costs eight code sites plus a migration."**
Measured: it additionally requires the compiler pin and the shipped definition to
move together and the release root to move (§7.2) — which the estimate did not
contain and which changes the packet that can land it.

**Two defects found while paying those prices**, both recorded as their own rows:

- `unsupportedReceiptVersion` reports *"persisted posting receipt uses
  unsupported input digest version N"* when reached from `digestCommand` on a
  fresh command where nothing is persisted. It names a storage condition for a
  command-family gap — an ADR-0046 misnamed-cause defect, the same family as the
  `postgresCode` duck-typing `PS-0` found.
- `db/schema.snapshot.json` is a required generated artefact with **no generator
  in the repository.** Four suites assert it and `check:schema` fails the matrix
  when it drifts, but nothing writes it, so any lane adding a migration hits a
  failure it cannot resolve locally without first building the tool.

## 6. `received_quantity` — derived, by lock-and-sum

**Ruled: `PUR-2` adds a read model derived from posted movements, not a stored
column.** `PUR-1` dropping the field is correct.

Three reasons, none a preference. A stored column is a **second truth** about a
fact the ledger already owns, re-creating in Purchasing the competing-truth
problem §3 spends its length avoiding in Inventory. Compare-and-swap's guarantee
is **narrower than the lock's** — it closed the measured single-line race with a
complete predicate, but a predicate over rows already seen cannot observe an
insertion phantom, so it does not extend to a receipt spanning several order
lines. And a drifted cache needs a reconciler; a derived sum cannot drift.

**The honest limit on the evidence.** `PS-0`'s four-arm race measured a **lock
around a stored counter**, not a sum over movement history. No arm summed
movements. So the lock-only arm supports *"a lock on the shared parent closes
the race"*; it does **not** by itself demonstrate the derived read model
performs acceptably. `PUR-2` owes that measurement. If it comes back
prohibitive, the stored column returns as an **optimization with a reconciler**,
never as the primary.

`SAL-2` inherits this for shipped quantity and open-to-ship.

---

---

## 7. Residues, each with an owner

These are sections, not footnotes, because a residue reported quietly is how the
next instance gets shipped.

### 7.1 `sourceStep` — declared and unenforced, this programme's worst defect class

**Corrected since the packet brief: it is now enforced.** For one commit,
`sourceStep` was a declared profile field that nothing read — `#post` still gated
the foreign port on `if (this.sourceAggregate)`. `PS-2` changed both call sites
to `profile.sourceStep === 'foreignPort'`, and a `foreignPort` family with no
registered port now refuses by name rather than silently skipping its source
step.

**The class is what matters, and this was its third instance this month:**

1. `stateMachines` / `transitionStateEffect` — a declared canonical shape the
   gateway contained zero references to (ADR-0050).
2. `familyId: string` — a declared port identity documented as diagnostic,
   actually selecting authorization (§2).
3. `sourceStep` — declared by the profile, unread by the kernel.

Enforcing it cost two lines. **What it cost to defer was the thing worth
recording:** enforcing it immediately broke `PS-0`'s sections 1–7, because every
one of them drove a receipt through `postAdjustment` while injecting a foreign
port — an `inventoryInternal` profile running a `foreignPort` step. The
enforcement did not create that defect; it revealed it. The sections moved to
`postGoodsReceipt`, and the four-arm race now runs under the family that owns it.

**Owner: closed in `PS-2`.** What `PUR-2` inherits is the rule — a declared field
that no code reads is a defect on the day it is written, not debt.

### 7.2 The receipt posting role and its enum members — `PUR-2`

`inventory_movement_posting_role` is pinned in the **compiler** at
`conformance.ts:302-323` and compared by `sameStringArray` at `:710-722` — exact
ordered equality, not subset. Measured by compiling each addition alone:

- Adding `receipt` to the shipped definition alone → the fixture compile fails.
- Adding it to the pin alone → **every existing compile fails.**
- `inventory_transaction_type` is **not** pinned; that addition is free.

So the shipped domain definition and the compiler pin must move together in one
commit, and **the compiled release root moves with them.** A probe fixture cannot
carry this: the fixture forks the definition, not the compiler's module-level
pin. `PS-2`'s scoping — *"two enum options in the probe's own fixture, the
shipped release does not move"* — is refuted.

**Owner: `PUR-2`**, as a priced release-moving event: definition option, pin
option, release-root move, golden regeneration.

### 7.3 The catalog projection — `PUR-2`, and load-bearing

§1.1 makes this a precondition rather than tidiness. The catalog must reach
`#post` as a compiled projection read through `context.projection(...)`, exactly
where `storageTarget` already arrives — the executor context is built from
`command.compiledRelease` in `release-verification-service.ts:436`.

Adding a projection family is a compiler event under ADR-0047 and is not
something a probe may invent. Until it lands, the values exist in two places
behind `test/unit/posting-family-catalog-parity.test.ts`, which asserts
profile-by-profile equality **and** equality of the derived per-capability
extension roots — the value that actually reaches the kernel. That gate is a
mitigation, not a defence: §1.1 is unmitigated until the projection exists.

**Owner: `PUR-2`.** Until then this design does not satisfy the module-press law.

### 7.4 Stock count has no runnable vertical here

Driving a real `postStockCount` needs the `stock_count` aggregate fixture —
entity, lines, states, evidence — which `PS-0`'s fixture never built and `PS-2`
did not build. The profile is declared, the parity test asserts it is
companion-origin with a kernel writer, and it shares the writer path in source.
**None of that is a run.** See §4 for why the gap is material.

**Owner: `PUR-2`.**

---

## 8. Evidence — what ran, by name and result

A design packet's evidence is its targeted suites. **No full matrix was owed**,
and `repository-hygiene` makes one structurally unreachable for a preserved
probe anyway (§9, item 7).

**Observed, on `packet/ps-2`:**

| Suite / check | Result |
|---|---|
| `test/unit/posting-family-catalog-parity.test.ts` | **3 pass, 0 fail** |
| `test/architecture/repository-hygiene.test.ts` + `release-persistence-boundary.test.ts` | **14 pass, 0 fail** |
| `check:schema` | migrations **PASS** (22 applied, 22 verified); schema-drift **PASS** |
| `test:unit`, `test:compiler`, `test:integration`, `test:agent` | **PASS** (in `ps2-r3`) |
| `test:performance` compile budget | **PASS**, `cpu_idle_pct=95.8`, `PERFORMANCE_GATE_PASS_SHA=1b19f12` |
| `prettier --check .`, `eslint .`, `tsc --noEmit` | clean |
| `test:architecture` | **3 failures**: two registration gaps, fixed; `PRESS006` left red by choice (§1.1) |
| `test/postgres/ps0-inbound-seam.test.ts` | **FAILS** at fixture compile, `INVENTORY_CONTRACT_INVALID` on `$.fields.inventory_movement_posting_role` (§7.2) |

**The parity gate failed on its first run and was right to**: the two
declarations ordered `dependencyExtension` differently. The extension is a set —
the root derivation sorts and dedupes before hashing — so the comparison was
wrong, not the data.

**Not observed, and therefore not claimed:** the receipt vertical does not pass.
Companion creation, the receipt companion type, the receipt posting role, the
correction chain and the reachability gate are all **authored and unrun**,
blocked at §7.2. No result in this document describes them as measured.

**Measured, and cited above:** the dependency roots in §3.3 and §5, the enum
admission experiment in §7.2, and the digest-arm sequence in §5.

---

## 9. What earlier versions of this ADR got wrong

Consolidated so no packet re-derives a superseded claim from the execution log.

1. **"`main` provides no generic O1 tier."** It provides one, built and mounted.
   Superseded further by ADR-0050: release and cancel run at `tier: 'o0'` through
   the generic press, so no capability executor is owed for a state-only
   transition.
2. **"The adapter must enter the same top-level transaction."** It cannot —
   `#post` owns its connection — and it does not need to. **Upheld narrowly:**
   the transaction *carries* the aggregate through a port, preflight is safe only
   as an untrusted proposal re-decided under lock.
3. **"Separate capability IDs need no new mechanism."** Refuted at the type
   level; `InventoryPostingRegistrationV1.capabilityId` was
   `typeof INVENTORY_POSTING_CAPABILITY_ID`, so a Purchasing registration could
   not be written. §2 replaces it.
4. **"The pessimistic lock is an optimization."** Withdrawn. Proven only for the
   measured single-aggregate invariant with a complete CAS predicate. **The
   generalization carried forward instead: movement append and source transition
   must share a transaction.**
5. **"Lock order is widened, never reordered."** False twice over — §1.2.
6. **"A companion has no writer."** Understated: no companion *mechanism* exists
   for either class, and the shipped writer is the generic `o0` create driven by
   a user — §3.1.
7. **Structural, and not previously recorded:** `repository-hygiene` requires
   every discovered test file to appear in a reviewed inventory, so a preserved
   not-for-merge probe branch **cannot reach matrix-green** without declaring its
   probe a reviewed test. `PS-0` and `PS-1` both carried unregistered probes;
   neither could ever have gone green. Any packet promising both *"preserve the
   probe, do not merge"* and *"matrix green at the integrated SHA"* is promising
   two incompatible things.

---

## Boundaries

This decision does not authorize a purchase-order or sales entity, a module, a
mount, an HTTP route, an agent tool, a UI binding, valuation, or a reservation
writer. It does not move the kernel dependency baseline. It does not add the
receipt posting role or its enum members (§7.2), the catalog projection (§7.3),
or the companion `UNIQUE` index (§3.2) — each is `PUR-2`'s, priced above. It
does not merge any probe. `5g3-sm-impl` owns the transition carrier and is
untouched; ADR-0050 stands.
