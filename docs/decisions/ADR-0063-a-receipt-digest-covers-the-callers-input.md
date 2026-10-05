# ADR-0063: A receipt digest covers the caller's input, and versions when that input changes

Date: 2026-08-31
Status: accepted (packet `PUR-2b`, merge `2e85696`, 2026-09-01; status line swept the same day on `5g3-prog` R6). **Amended 2026-09-01 by `posting-kernel-admission`** (see the amendment section at the end): the version-4 input is corrected to exclude the derived `postingRole`, and decision 3's three encodings are reduced to one authority. **Amended 2026-10-05 by `STOCK-COUNTS`**: decision 4's premise ends and version 4 is frozen (last section).
Tier: Critical (review per `review-tiers`)

Extends [ADR-0060](ADR-0060-a-posting-family-declares-whether-the-kernel-writes-its-companion.md),
which made the posting kernel the writer of a stock count's companion
identities. Nothing in ADR-0060 is repealed. This decides what the change
ADR-0060 made means for a receipt digest, and what it owes released data.

## Context

Migration `0016` wrote the rule in its own header:

> Inventory posting writes v2 explicitly; other receipt writers retain the v1
> default until their own digest input changes under a versioned migration.

`PUR-2a` changed a stock count's digest input and shipped no migration. It
argued an exemption on the grounds that the digest SHAPE was unchanged. **That
distinction is not in the rule, and the argument is withdrawn.**

The input really did change, and the mechanism is worth stating exactly because
the shape argument is superficially persuasive. `digestCommand` destructures
`const { idempotencyKey, ...semanticInput } = command`, and `command` is the
DERIVED command — the one `validateStockCountCommand` returns. Before `PUR-2a`
that command's `transactionId` was `parsed.transactionId.toLowerCase()`, a value
the CALLER sent, and each line's `transactionLineId` was
`line.transactionLineId.toLowerCase()`, likewise the caller's. After `PUR-2a`
both are `deriveInventoryPostingCompanionId(...)` — values the KERNEL computes.
Same key set, same JSON shape, different provenance, and a different value for
any receipt written before the change.

The consequence is mechanical: an existing version-3 receipt recomputes its
digest from derived ids, does not match the digest it stored, and replays as
`INVENTORY_POSTING_IDEMPOTENCY_CONFLICT`. Migration `0016`'s rule is about the
input, and the input moved.

## Decision 1 — version 4 covers the caller's semantic input, and excludes the
## identities the kernel derives

The alternative was to keep the derived identities in the digest and version the
change anyway. Both options satisfy the migration rule. This one is chosen, and
the argument is not that outputs are aesthetically out of place in an input
digest.

**The decisive argument is that they carry no information.** Each derived id is
a pure function of a value the digest already covers:
`transactionId = f(stockCountId)` and `transactionLineId = f(stockCountLineId)`,
where `f` is `deriveInventoryPostingCompanionId` over a fixed namespace,
capability, family and companion family. Two commands therefore cannot differ in
a derived id without already differing in the source id that produced it.
Excluding them removes no case the digest could previously discriminate — and a
digest exists to discriminate. Anything that cannot change the answer is
decoration, and decoration in a stored digest is a liability rather than a
neutral cost.

**The liability is specific, and it is the defect this ADR is repairing.**
Covering an output couples every stored digest to the derivation function. Change
the derivation namespace, either family id, or the capability id, and every
stored stock-count digest silently becomes unrecomputable — a mass idempotency
conflict that no migration can repair, because `semantic_operation_receipts`
stores `input_digest` and `mutation_result` and never the input. There is nothing
to compute a corrected digest FROM. Keeping the derived ids re-arms exactly the
failure `PUR-2a` fired, and the second occurrence would be worse than the first,
because a derivation change is a code change nobody would think to call a
contract change.

**A third argument, weaker but real: it makes the rule statable.** Version 4's
digest input is `Omit<InventoryStockCountPostingCommandV2, 'idempotencyKey'>` —
the caller's own command type, minus the key. That is a type, not a
hand-maintained field list, so the exclusion is written once and cannot drift
into a subset that omits a member. `sameRelationShape` is the cautionary case:
its hand-maintained comparison subset omitted `archiveBehavior` and admitted a
release the materializer then refused. `idempotencyKey` was already excluded
because it is the KEY rather than the input; the derived identities are excluded
for the mirror-image reason.

**What this costs, stated rather than omitted.** The digest no longer witnesses
which companion rows a posting wrote. It never did: the witness is the projection
read-back in `readBackStockCountEvidence` and `assertPersistedRowVerified`, both
of which compare persisted identities against a fresh derivation from the source.
No observation is lost, and the observation that exists is stronger than a hash
would have been.

## Decision 2 — a stored version-3 receipt keeps decoding, and refuses a fresh
## digest with the real reason

Nothing is rewritten and nothing is removed. Versions 1, 2 and 3 stay admitted by
the `CHECK`, `recordedResultForReplay` still decodes a version-3 receipt's stored
evidence under version 3, and the natural-effect replay path still returns it.
A stored receipt must keep decoding under the version it was written with.

What a version-3 stock-count receipt may NOT do is have a fresh version-3 digest
computed for it. The caller-supplied identities that digest covered are
unreachable from a command the kernel now derives, and a caller cannot resend
them — `exactKeys` refuses both keys outright. So the comparison is structurally
false, and the untreated code reports `idempotency key X already names another
posting`: an accusation that the caller reused a key for DIFFERENT input, when
the input is identical and the kernel changed underneath it. That message sends
an operator to audit a caller that did nothing wrong.

`unreconstructibleReceiptVersion` refuses with the real reason instead. Replaying
the stored result WITHOUT verifying the input was rejected: that is precisely the
protection a digest exists to give, and dropping it would let a different command
reuse a key and receive someone else's result.

## Decision 3 — the capability version is 2

`PUR-2a` changed the PUBLIC command: `transactionId` and every line's
`transactionLineId` left the key set entirely, and `exactKeys` refuses a caller
that still sends them rather than tolerating the extra key. A caller written
against the previous contract is refused, which is what a major version means.

**A measured limit that this decision does NOT close.** The posting capability
version has three encodings and nothing reconciles them:

| encoding | value | who reads it |
|---|---|---|
| `INVENTORY_POSTING_CAPABILITY_VERSION` (provider) | 2 after this packet | `validateRegistration`, the posting result, trust metadata |
| `INVENTORY_CONTRACT_V1.capabilityVersion` (domain) | 1, pinned to the literal by `packages/compiler/src/conformance.ts` | inventory contract conformance |
| `capabilityRequirement.capabilityVersion` (domain definition) | 1 | `buildCapabilityFacts` → the release manifest's `capabilityFacts` |

**Measured in the shipped artifact, not inferred:** every one of the ten releases
in `app.compiled.json` that declares the posting capability declares it at
`capabilityVersion: 1`, the head release included. After this packet the provider
implements 2 and the release the runtime loads still says 1.

`hasValidCapabilityFacts` checks only `capabilityVersion >= 1`, so a release that
DECLARES it requires posting v1 while the provider IMPLEMENTS v2 passes every
gate in the matrix. Both other encodings are outside this packet's lease, and the
compiler is explicitly out of its scope. Filed as
`posting-capability-version-has-three-encodings`.

## Decision 4 — the disposition of released data

The finding named four cases. **Three are proven impossible; one is real and this
packet cannot carry it.** The proof is reachability from a released application,
and what was queried is named so it can be attacked.

**What was observed.**

1. **The compiled artifact the runtime actually loads**, not merely the authored
   source. `apps/api/src/composition-root.ts` reads
   `apps/web/release/app.compiled.json`; its head release (index 14 of 15,
   `releaseRoot` `8476ba3f…`) carries its own normalized definition, and decoding
   `normalizedDefinitionBytesBase64` gives eight `stock_count` /
   `stock_count_line` operations — `_create`, `_update`, `_archive`, `_restore`
   and the four line equivalents — **every one of them a generic record effect
   with `capability: null`.** Exactly ONE operation in that release names
   `northstar.inventory:capability.posting`:
   `northstar.app:operation.inventory_transaction_post`, the transaction route.
   `apps/web/release/app.authored.json` agrees, and the compiled artifact is the
   one that binds.
2. `apps/api/src/composition-root.ts` registers exactly one factory for that
   capability, `INVENTORY_POSTING_CAPABILITY_EXECUTOR_FACTORY`.
3. That executor's `execute` hydrates an adjustment draft and calls
   `postAdjustment`; `assertPostingOperation` additionally requires the
   read-back's `sourceEntityId` to be the TRANSACTION entity; and the factory
   declares `verificationRefusal` = *"only adjustment drafts are admitted by this
   route"*.

   > **Note 2026-09-30 (INVENTORY-PARITY, owner ruling R4).** The executor now
   > also dispatches `transfer` drafts, to `postTransfer`, and declares
   > `verificationRefusal` = *"only adjustment and transfer drafts are admitted
   > by this route"* (ADR-0027, *Amendment 2026-09-30*). Items 4-5 are
   > unchanged -- no route reaches `postStockCount` -- so every verdict below
   > still stands.
4. `grep -rn postStockCount` over the repository returns three files: its own
   definition, `test/postgres/inventory-stock-count.test.ts` and
   `test/postgres/inventory-backup-restore.test.ts`. **There is no production
   caller.**
5. `postStockCount` is the only producer of `postingRole` `count` or
   `correction`, and `currentCommandDigest` selects the stock-count version iff
   `isStockCountPosting`. **Version 3 is written only by `postStockCount`.**

**Case-by-case.**

| case | verdict |
|---|---|
| an existing version-3 receipt replays as an idempotency conflict | **Cannot exist.** By (4) and (5): no released route reaches the only writer of a version-3 receipt. |
| an existing posted count fails the projection read-back | **Cannot exist.** A posted count requires a posting; same proof. |
| an old caller cannot resend the old shape, because `exactKeys` refuses it | **Cannot exist as a release caller.** Same proof. The in-repository callers are tests, and this packet updates them. |
| an existing reviewed count is refused by the must-be-null fence | **REAL.** |

**Why the fourth is real, with the affected releases counted rather than
estimated.** `stock_count_create` and `stock_count_update` are live generic
operations and `stock_count_form` still renders the Transaction picker
(`stock-count-form-offers-a-dead-transaction-picker`). Decoding every release in
`app.compiled.json` gives the requiredness of both companion relations per
release:

| releases | `stock_count_transaction` / `stock_count_line_transaction_line` |
|---|---|
| 0–3 | the `stock_count` entity does not exist yet |
| **4–13** | **`required: true` — the column is NOT NULL** |
| 14 (head) | `required: false`, relaxed by `PUR-2a` |

**So a stock count created under any of releases 4 through 13 necessarily carries
a caller-chosen companion transaction**, the column having been NOT NULL. That is
ten releases, not the whole lineage, and not merely the one before the change.

**Why this packet cannot carry it, and why that is not the charter's stop.**
`stock_count` is MODULE storage, in per-tenant `north_star_module` schemas. A
`db/migrations/**` migration is a PLATFORM migration and may not issue module
DDL or DML — pinned by `test/postgres/migrations.test.ts`, which asserts the
inventory migration matches no `north_star_module.` statement. Nor may the
transition null the column: an operator authored that value and it is business
data, which the platform forbids hard-deleting anywhere, ever.

The charter's stop condition is *a posted count whose caller-chosen companion ids
are unreachable from the derivation, so no migration can reconcile it*. **It does
not fire**: no posted count can exist. The reviewed-count case is a different
shape, and its HARM is currently unreachable — the must-be-null fence lives
inside `postStockCount`, which no released route calls. It becomes reachable
exactly when a packet wires a stock-count posting operation into a release. That
is the packet that must carry it, and it is filed as
`legacy-reviewed-counts-carry-a-caller-chosen-companion` with this constraint
written in.

## Consequences

- Migration `0023` widens the receipt digest `CHECK` to `IN (1, 2, 3, 4)`. It is
  `0017`'s exact shape and adds no column.
- Stock-count postings write version 4; adjustments and transfers are untouched
  at version 2, and version 1 legacy adjustments are untouched.
- `INVENTORY_POSTING_CAPABILITY_VERSION` is 2. Every one of its 21 references is
  symbolic, so the bump required a test that asserts the literal on the posting
  result and in the persisted trust metadata — otherwise it is invisible to the
  whole matrix.
- Nine sites across five files pin the migration tail, and one of them is a COUNT
  (`migrated.verified.length`, 22 → 23). There is still no registry;
  `migration-addition-has-no-registry` stays open.
- The schema snapshot is regenerated by `test/helpers/regenerate-schema-snapshot.ts`
  and moves by exactly one line.

## Amendment 2026-09-01 — `posting-kernel-admission` (`5g3-prog` R1 and R2)

**Decision 1, corrected: version 4 covers exactly the caller's input, and
`postingRole` is not in it.** As shipped by `PUR-2b`, `digestCommand`'s
version-4 branch hashed `{ postingRole, ...callerStockCountInput(command) }`.
`postStockCount` sets the role to `count` for kind `initial` and `correction`
otherwise — a pure function of `kind`, which the caller's input already covers
— so by this ADR's own decisive argument it carried no information, and it was
the one kernel-derived value still inside the input. The version-4 input is now
`Omit<InventoryStockCountPostingCommandV2, 'idempotencyKey'>` and nothing else.

**Corrected in place at version 4, not cut as version 5.** Section 4's proof
was re-verified on the packet's base: `postStockCount` still has no production
caller (the only callers are its two test files), the only released route to
the posting capability is `inventory_transaction_post` through the adjustment
executor, and version 4 is written only by `postStockCount`. No version-4
receipt exists in released data, so correcting the input rewrites no persisted
receipt. Had one been able to exist, the correction would have been version 5
under migration `0016`'s rule. The standard version 2 keeps its role, because
version-2 receipts are released data.

**Decision 3, closed: ONE authority for the capability version.** The three
encodings in decision 3's table are reduced to one:

| encoding | now |
|---|---|
| `INVENTORY_CONTRACT_V1.capabilityVersion` (`packages/domain/src/inventory/contracts.ts`) | **the authority — 2** |
| `capabilityRequirement.capabilityVersion` in the inventory module definition | reads the contract; `buildCapabilityFacts` carries it into the release manifest |
| `INVENTORY_POSTING_CAPABILITY_VERSION` (provider) | imports the contract |
| the `capabilityVersion` cell in `packages/compiler/src/conformance.ts` | no longer a second spelling: the compiler cannot import the domain, and the cell's only input is the contract itself, so it admits the version the contract carries as a positive integer |

**The rule is EXACT, and where each half of it is checked was corrected on
review.** A capability
fact a release declares is satisfied by the provider only when the provider's
version equals it. This number is a major version by this ADR's own decision 3
— a caller written against one version is refused by the next — and there is
no minor axis to be compatible along, so a floor (`>= 1`, which
`hasValidCapabilityFacts` still checks as a shape) would let a release declaring
1 be served by a provider implementing 2, which is precisely the state `PUR-2b`
left the shipped head release in. The comparison reads the fact from the
persisted release manifest — the artifact whose content hash is the release
root — because that is what the release kernel verified and stored. Two earlier
placements were measured and rejected: staging cannot be exact (the runtime
stages every lineage entry on every boot, and eleven shipped entries
legitimately declare 1), and admission cannot see it (the head release was
admitted declaring 1 and the provider moved underneath it; a rollback target is
admitted already).

**The check runs on entry to `#post`, before the stored-receipt lookup, and the
first candidate of `posting-kernel-admission` had it in the wrong place.** That
candidate put it inside `assertActiveRelease`, which a stored receipt never
reaches: `findReceipt` keys on tenant, environment, capability and idempotency
key only — never on the release a receipt was recorded under — and
`validateReceiptReplay` compares the principal and the digest before returning
the recorded result. So a replay under a release declaring 1 was served a
result recorded under 2, unannounced, which is the mismatch this rule exists to
refuse. The round-1 reviewer found it and the candidate was BLOCKed. **The
claim "checked on every posting" was false as written and is now true because
the check was moved, not because the sentence was softened.**

**The two halves, stated separately so neither is over-claimed:**

- **Every posting, replay included:** the release this provider is REGISTERED
  against declares exactly the version the provider implements.
- **Every posting that writes:** that registration is additionally the ACTIVE
  release pointer, and its storage target is the exact persisted artifact —
  `assertActiveRelease`, which a stored-receipt replay still returns before.
  Moving THAT binding earlier would re-adjudicate `PUR-2a`'s replay design and
  is deliberately not done here.

The shipped artifact is also pinned deterministically: a test reds the matrix
when the head release's fact differs from the provider's version.

## Amendment 2026-10-05 — `STOCK-COUNTS`

**Decision 4's premise ends.** A stock count is now started, reviewed and posted
through its own commands on the posting capability's route, and its Post calls
`postStockCount`: the first production caller. From the first tenant, version-4
receipts are released data.

- **Version 4 is frozen.** Any change to what a stock-count digest covers is a
  version 5 with its own `CHECK` migration, as receipts (v5), shipments (v6) and
  returns (v7, v8) did. The command's shape and the version-4 digest input did
  not change in `STOCK-COUNTS`; the kernel gained a refusal
  (`INVENTORY_COUNT_EXPECTED_STALE`) and a validation rule (each item once).
- **The real case of decision 4 is moot.** `legacy-reviewed-counts-carry-a-caller-chosen-companion`
  rested on releases 4-13 requiring both companion relations. ADR-0066's
  re-baseline removed them: every entry of the current lineage (decoded at
  `STOCK-COUNTS`, seven entries) carries both relations as optional, and no
  tenant holds released data. `STOCK-COUNTS` also retires both relations from
  every generic input and form, so no generic writer can name a companion; the
  kernel's must-be-null fence stays as the backstop.
