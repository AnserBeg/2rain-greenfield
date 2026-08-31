# pur-2b — version the stock-count posting contract and carry its released data

Cut from `5e02d09526654b7dcdb36e15de360ef42b5f769f` (`main`) on branch
`packet/pur-2b`. Tier: **Critical.** Evidence band: **Band A, declared** — a
receipt digest that silently stops matching is invisible until a caller replays,
and the replay reports the WRONG reason, so the failure is silent in
`review-tiers`' sense and full `AGENTS.md` §6 applies: one recorded red per
vacuity vector.

Decision record: [ADR-0063](../../decisions/ADR-0063-a-receipt-digest-covers-the-callers-input.md).

Closes `stock-count-companion-released-contract-transition`.

## The defect, measured rather than restated

`PUR-2a` changed an already-released posting contract with no transition, and
argued an exemption on the grounds that the digest SHAPE was unchanged. The rule
in migration `0016`'s own header is about the digest INPUT:

> other receipt writers retain the v1 default until their own digest input
> changes under a versioned migration

The input did change, and the mechanism was measured on this tree before
anything was designed:

| | before `PUR-2a` (`0a1e26a`) | after |
|---|---|---|
| `command.transactionId` | `parsed.transactionId.toLowerCase()` — the CALLER's | `deriveInventoryPostingCompanionId(...)` — the KERNEL's |
| `line.transactionLineId` | `line.transactionLineId.toLowerCase()` — the CALLER's | `deriveInventoryPostingCompanionId(...)` — the KERNEL's |
| the digest | `{ postingRole, ...semanticInput }` over the derived command | unchanged expression |

`digestCommand` destructures `const { idempotencyKey, ...semanticInput } =
command` where `command` is the DERIVED command, so both values are spread into
the digest either way. Same key set, same JSON shape, **different provenance and
a different value for any receipt written before the change** — which is why the
shape argument is superficially persuasive and wrong.

## Ruling 1 — version 4 covers the caller's semantic input

Argued in full in ADR-0063 section "Decision 1". The short form: the derived ids
carry **no information**, because each is a pure function of a value the digest
already covers — `transactionId = f(stockCountId)`,
`transactionLineId = f(stockCountLineId)`. Two commands cannot differ in a derived
id without differing in the source id that produced it, so excluding them removes
no case the digest could discriminate. What they do add is a coupling between
every stored digest and the derivation function, which is the failure mode this
packet is repairing; keeping them re-arms it.

The digest input is typed `Omit<InventoryStockCountPostingCommandV2,
'idempotencyKey'>` — the caller's own command type — so the exclusion is stated
in a type rather than a hand-maintained field list.

## Ruling 2 — released data: three cases proven impossible, one real

**Named because "production is empty" is not a proof.** What was queried:

1. **The compiled artifact, decoded.** `apps/api/src/composition-root.ts` loads
   `apps/web/release/app.compiled.json`; its head release (index 14 of 15,
   `releaseRoot` `8476ba3f…`) carries eight `stock_count` / `stock_count_line`
   operations in its normalized definition, **all of them generic record effects
   with `capability: null`**, and exactly ONE operation naming
   `northstar.inventory:capability.posting` —
   `northstar.app:operation.inventory_transaction_post`. `app.authored.json`
   agrees. **No released operation routes to the posting capability for the
   stock-count entity.**
2. `apps/api/src/composition-root.ts` — exactly one factory is registered for
   `northstar.inventory:capability.posting`.
3. That executor calls `hydrateAdjustmentDraft` + `postAdjustment`, requires the
   read-back's `sourceEntityId` to be the TRANSACTION entity, and declares
   `verificationRefusal` = *"only adjustment drafts are admitted by this route"*.
4. `grep -rn postStockCount` — three files: its definition and two test files.
   **No production caller.**
5. `postStockCount` is the sole producer of `postingRole` `count`/`correction`,
   and `currentCommandDigest` selects the stock-count version iff
   `isStockCountPosting`. **Version 3 is written only by `postStockCount`.**

| the finding's four cases | verdict |
|---|---|
| existing version-3 receipt replays as an idempotency conflict | **cannot exist** — (4)+(5) |
| existing posted count fails the projection read-back | **cannot exist** — a posted count needs a posting |
| an old caller cannot resend the old shape | **cannot exist as a release caller** — (4) |
| existing reviewed count refused by the must-be-null fence | **REAL** |

**The real one, and this packet cannot carry it.** Decoding every release in
`app.compiled.json` counts the exposure rather than estimating it: releases 0–3
have no `stock_count` entity, **releases 4–13 carry both companion relations as
`required: true`** — the column is NOT NULL, so every count created under them
necessarily names a caller-chosen companion — and release 14 is where `PUR-2a`
relaxed them. `stock_count_create`/`_update` are live generic operations and the
form still renders the Transaction picker.

It cannot be carried here: `stock_count` is MODULE storage in per-tenant
`north_star_module` schemas, and a `db/migrations/**` migration is a PLATFORM
migration that may not issue module DDL or DML — pinned by
`test/postgres/migrations.test.ts`. Nulling the column is a hard delete of
business data, which the platform forbids anywhere, ever.

**The charter's stop condition did not fire.** It names *a posted count whose
caller-chosen companion ids are unreachable from the derivation*. No posted count
can exist. The reviewed-count case is a different shape and its HARM is currently
unreachable — the fence lives inside `postStockCount`, which no release calls. It
becomes reachable when a packet wires a stock-count posting operation, and is
filed as `legacy-reviewed-counts-carry-a-caller-chosen-companion` for that packet
with the constraint written in.

## Corrections to the charter, all measured

| charter said | measured |
|---|---|
| "A grep for `capabilityVersion: 1` returns five hits … all five belong to other capabilities" | **Fourteen hits.** Three DO bind the posting capability: `packages/domain/src/inventory/contracts.ts` (the type at `capabilityVersion: 1` and its value, siblings of `capabilityId: 'northstar.inventory:capability.posting'`) and `packages/domain/src/inventory/definition.ts`'s `capabilityRequirement` on `postingCapabilityId`. All three are outside the lease; see the limit below. |
| "imported symbolically by `inventory-posting-capability-executor.ts` and `composed-application.spec.ts`" | Also by five `test/postgres` files — `inventory-posting`, `inventory-stock-count`, `inventory-backup-restore`, `inventory-backdate-policy`, `inventory-reconciliation`. All symbolic, so none needed an edit. The count of 21 is correct. |
| "Nine filename pins across five files" plus one COUNT pin | **Nine SITES**, of which seven are filename literals, one is a migration range in a test's own TITLE, and one is the COUNT. The title is not updated — see the bridge request. |
| the pin surface is those five files | **A tenth site exists outside the lease**: `test/evidence/relation-requiredness-relaxation.expected-red.json` names the trust-substrate test by its title in two places. See the bridge request. |
| the pre-authorized executor bridge | **Measured and NOT taken.** `inventory-posting-capability-executor.ts` builds its registration from the constant symbolically, so the bump reaches it with no edit. |

## Bridge request — the migration range in a test title

`test/postgres/trust-substrate.test.ts:63` is titled *"migrations 0006-0022
upgrade accepted G1 and converge with the checked-in snapshot"*. Its body is
updated to 0023; **its title is not**, and the title is now stale by one digit.

The reason is measured, not a preference.
`test/evidence/relation-requiredness-relaxation.expected-red.json` names that
test by title twice — `test.namePattern` and `kills[0].name`. Renaming the title
leaves `check:expected-red` green (validate mode checks the mutation SUBJECT's
text, and that entry's subject is migration `0022`, untouched here) but fails
`evidence:expected-red`, whose `measurePhase` asserts
`measured.results.length > 0` with the message *"the pattern or file selects
nothing"*. That manifest belongs to an accepted packet and is outside this lease.

**Requested:** two string edits in
`test/evidence/relation-requiredness-relaxation.expected-red.json`, `0006-0022`
→ `0006-0023` in both places, applied together with the title. It is mechanical
and re-derivable. The alternative worth considering instead is that a migration
RANGE in a test title is the same class as
`press-law-splice-control-pinned-by-line-number` — a coordinate that goes stale
on every unrelated addition — and the durable fix is to delete the range from the
title rather than to keep advancing it in two files at once.

## Declared limits

- **The capability version has three unreconciled encodings.** The provider
  constant is 2; `INVENTORY_CONTRACT_V1.capabilityVersion` is 1, pinned to that
  literal by `packages/compiler/src/conformance.ts`; and the module's
  `capabilityRequirement.capabilityVersion` is 1 and is what reaches a release
  manifest's `capabilityFacts`. `hasValidCapabilityFacts` checks only `>= 1`, so
  **a release that declares posting v1 while the provider implements v2 passes
  every gate.** Both other encodings are in `packages/domain/**` and the pin is
  in `packages/compiler/**`, which the charter puts out of scope. Filed as
  `posting-capability-version-has-three-encodings`.
- **The version-4 exclusion is type-forced in one direction only.** A field added
  to `InventoryStockCountPostingCommandV2` flows into the digest automatically,
  which is the safe direction. A new KERNEL output added to
  `DerivedStockCountCommand` would flow through the spread and silently enter the
  digest. The observing test computes its expected digest from the caller's
  command independently, so such an addition reds — but by a test, not by a type.
- **`test:browser` was not run** (`apps/web/test/browser/composed-application.spec.ts`
  imports the bumped constant symbolically, so no edit was needed, and the
  charter's gate list does not include it).

## Gates

See the packet-completion block in the session report. `check:app-release` was
green on `main` and is unchanged here: no tracked release artifact moved.

## The declared range

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "pur-2b",
  "base": "5e02d09526654b7dcdb36e15de360ef42b5f769f",
  "head": "fbfc2955166f531387f3b353364fe6d66be42609",
  "changedPaths": [
    "db/migrations/0023_inventory_stock_count_companion_digest_version.sql",
    "db/schema.snapshot.json",
    "packages/postgres-provider/src/inventory-posting-service.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/evidence/pur-2b.expected-red.json",
    "test/postgres/inventory-stock-count.test.ts",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "INVENTORY_POSTING_CAPABILITY_VERSION"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "callerStockCountInput"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "unreconstructibleReceiptVersion"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "isStockCountReceiptVersion"
    }
  ]
}
```
