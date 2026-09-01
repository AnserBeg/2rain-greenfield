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

| gate | result |
|---|---|
| `typecheck` | PASS |
| `lint` | PASS |
| `format` | PASS |
| `test:unit` | 155/155 |
| `test:compiler` | 157/157 |
| `test:integration` | 149/149 |
| `test:architecture` | 189/189 |
| **`test:postgres`** (REQUIRED) | **221/221** |
| `check:schema` | PASS — 23 applied, 23 verified; schema-drift PASS |
| `check:app-release` | PASS — green on `main` and unchanged here; no tracked release artifact moved |
| `check:expected-red` | OK — 61 entries in 6 manifests still name live production text |
| `evidence:expected-red` | OK — **all 61 reproduced and restored**, this packet's six included |
| `check:expected-red-controls` | OK — 38 controls |
| `scripts/check-records.sh` | OK — 136 records, 5 declaring, 42 claimed paths and 68 claimed symbols observed |
| `test:browser` | **NOT RUN** — see the declared limits |

**Each of this packet's four controls died ALONE.** Every entry reports
`1 killed` against `1 passing`, so no control takes a bystander with it:

```
migration-does-not-admit-version-four            1 passing -> 1 killed
version-four-digest-keeps-the-derived-identities 1 passing -> 1 killed
legacy-version-three-recomputes-a-fresh-digest   1 passing -> 1 killed
capability-version-not-bumped                    1 passing -> 1 killed
stock-count-decoder-drops-version-three          1 passing -> 1 killed
natural-replay-reconstructs-a-digest             1 passing -> 1 killed
```

**One architecture run failed and is recorded rather than quietly re-run.** The
first re-run at the freeze returned **188/189**, failing *matrix lock and
legacy-process waits fail busy at their bounded deadline* with
`POSTGRES_CONTAINER_CONTAMINATION: refusing to start with north-star-* containers
present after exclusive lock acquisition`, naming
`north-star-companion-derivation-41471-7f034a09` at `age_seconds=1678`.

**The cause was this lane's own tooling, not the packet.** An earlier
`evidence:expected-red` invocation was run in the FOREGROUND, hit a 10-minute
harness cap and was SIGTERM'd mid-entry; that killed run had
`test/postgres/inventory-stock-count.test.ts` in flight and its ephemeral
container outlived the process. The container's creation timestamp matches the
minute of the kill. The guard behaved exactly as designed — it refused to start
on a contaminated host and printed its own remediation — so this is the control
working, not a flake to retry past. After `docker rm --force` of that single
orphan the suite returned **189/189**. The subsequent `evidence:expected-red` run
was backgrounded and completed cleanly, restoring the tree.

**Sequencing, round 2.** The round-1 REVISE changed the executable tree, so
**nothing carried forward**: every suite above re-ran from scratch at `6081ecb`.
The last executable commit is `9a28824`; narrative commits sit above it, and per
`AGENTS.md` §6 `test:architecture` and `format` read `docs/**` and re-run at the
freeze while the rest carry forward on an identical executable tree.

**The round-1 contamination red did not recur.** `evidence:expected-red` was
backgrounded from the start this time rather than run in the foreground, so
nothing was SIGTERM'd mid-entry and no container leaked; the host was verified
free of `north-star-*` containers before and after.

## Round 1 — REVISE, and the finding was real

Reviewed `dae3bede502a871dfeeb91da1850ccb811df7a03`. The reviewer found **no**
released route to `postStockCount`, no other production writer of version 3, no
incorrect version-4 construction, and no explicit-key path that fabricates a
version-3 digest — so C1 through C5 survived. It returned REVISE on evidence,
and the gap it named was genuine.

**The gap.** The implementation deliberately splits the two replay routes:
`validateReceiptReplay` reaches `digestCommand` and refuses a version-3
stock-count receipt; `findNaturalReplay` proves replay from the persisted effects
and the recorded principal and calls `recordedResultForReplay` **without**
recomputing a digest, and `isStockCountReceiptVersion` keeps admitting version 3
there. That split is the whole transition — refuse what cannot be proven equal,
keep decoding what can.

**The packet's first four controls protected only the refusal half.** The
reviewer named the exact survivor: drop `3` from `isStockCountReceiptVersion` and
all four stay green while a legitimate version-3 receipt stops decoding through
natural replay. **Measured, and it is exactly right** — the mutation dies at
`findNaturalReplay -> recordedResultForReplay -> requiredRecordedPostingRole`
with *persisted posting receipt has no valid posting role*, and none of the four
original entries moves.

**What was added.** One test and two controls:

| control | mutation | measured red |
|---|---|---|
| `stock-count-decoder-drops-version-three` | `isStockCountReceiptVersion` stops admitting 3 | `persisted posting receipt has no valid posting role` |
| `natural-replay-reconstructs-a-digest` | the `findNaturalReplay` handoff routes through `validateReceiptReplay` | `...input digest version 3, whose caller-supplied companion identities cannot be reconstructed...` |

**The second one holds an ABSENCE, which is why it is worth having.**
`findNaturalReplay` must NOT reconstruct a digest. Nothing observes an absence
unless something restores it, so the mutation restores it — and a version-3
receipt then meets the unreconstructible refusal on the one route that had
independent evidence for replaying it.

**The specimen's shape is forced, not chosen.** Migration `0009` rejects UPDATE
and DELETE on receipts by RULE, so a version-3 row cannot be made by rewriting
the accepted one. It is added BESIDE it with an earlier `recorded_at`, which is
what `findNaturalReplay`'s `ORDER BY receipt.recorded_at LIMIT 1` selects. Two
receipts sharing one `outbox_id` is a real shape rather than a contrivance —
`persistAdditionalReceipt` writes exactly that on every natural replay.

**Two reviewer observations recorded rather than actioned here.** The
capability-version encodings may be serving more than one MEANING — an exact
negotiated protocol version, a minimum-compatible version, or a provider
result-format version — and a consumer could compare as exact what validation
treats as a lower bound; that is added to
`posting-capability-version-has-three-encodings`. And the packet must not
describe browser behaviour as freshly observed: `test:browser` is recorded as NOT
RUN, and the carry-forward argument covers the executable tree, not a fresh
browser observation.

## The declared range

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "pur-2b",
  "base": "5e02d09526654b7dcdb36e15de360ef42b5f769f",
  "head": "9a28824fcb7ad26f5e274dd2e7be462ca2bd4c60",
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

## Pasteable review prompt — arm 1, fresh naive Codex `gpt-5.6-sol` xhigh

The prompt uses `<FROZEN_SHA>` because a commit cannot contain its own identity.
Replace it with the exact remote SHA in the session report's `git ls-remote` line.

```text
You are the fresh-naive round-1 reviewer for Critical packet pur-2b in
/home/rvham/2rain-greenfield.

Review exact remote candidate <FROZEN_SHA> against base
5e02d09526654b7dcdb36e15de360ef42b5f769f. The remote branch is packet/pur-2b;
verify the supplied git ls-remote line before reading. Work read-only. Do not
edit, commit, run the full matrix, invoke another reviewer, or rely on line
numbers — re-locate every symbol by name.

Return PASS, REVISE, or BLOCK with file/symbol evidence for every material
finding.

This prompt was written by the lane whose work you are reviewing. **The lane has
fenced nothing.** Any scope stated here is the orchestrator's, and it stands as a
claim under test rather than a limit you may not question. Read whatever you
judge relevant to the decisive questions, say plainly if you think the scope is
drawn wrongly, and say plainly if the prompt itself is steering you.

TIER: Critical. It changes an idempotency digest and a stored version on an
already-released contract, and a wrong answer is invisible until a caller
replays. Evidence band A, declared.

READ FIRST: AGENTS.md sections 5 and 6; .agents/skills/review-tiers/SKILL.md;
docs/decisions/ADR-0063-a-receipt-digest-covers-the-callers-input.md in full;
docs/execution/packets/pur-2b.md; the
stock-count-companion-released-contract-transition row in
docs/execution/current-plan.md; db/migrations/0016 and 0017 (six lines each).
Then inspect, by name, in
packages/postgres-provider/src/inventory-posting-service.ts:
digestCommand, currentCommandDigest, callerStockCountInput,
unreconstructibleReceiptVersion, unsupportedReceiptVersion,
isStockCountReceiptVersion, recordedResultForReplay, requiredRecordedPostingRole,
validateReceiptReplay, findNaturalReplay, validateStockCountCommand,
INVENTORY_POSTING_CAPABILITY_VERSION. Then the two tests named PUR-2b in
test/postgres/inventory-stock-count.test.ts and the four entries in
test/evidence/pur-2b.expected-red.json.

GATES ALREADY GREEN at <FROZEN_SHA>, so do not re-derive what they prove:
typecheck, lint, format; test:unit 155/155; test:compiler 157/157;
test:integration 149/149; test:architecture 189/189; test:postgres 220/220
(REQUIRED for this packet); check:schema PASS with 23 applied and 23 verified
plus schema-drift PASS; check:app-release PASS; check:expected-red-controls OK
with 38 controls; scripts/check-records.sh OK; evidence:expected-red reproduced
every committed entry across all six manifests. test:browser was NOT run.

WHAT THE PACKET CLAIMS. Each of these is a CLAIM UNDER TEST, and each is stated
with the derivation that produced it so you can attack the derivation rather
than the number:

C1. The rule PUR-2a broke is about the digest INPUT, not its shape. Derived by
    reading migration 0016's header against the pre- and post-PUR-2a bodies of
    validateStockCountCommand: at 0a1e26a the parsed command's transactionId was
    parsed.transactionId.toLowerCase() and each line's transactionLineId was
    line.transactionLineId.toLowerCase(); both are now
    deriveInventoryPostingCompanionId. digestCommand spreads the DERIVED command
    either way, so the key set never moved while the provenance and value did.

C2. Version 4 should EXCLUDE the kernel-derived companion identities, and the
    decisive reason is that they carry no information. Derived from the purity of
    deriveInventoryPostingCompanionId: transactionId is a function of
    stockCountId and transactionLineId of stockCountLineId, both already in the
    digest, so no two commands can differ in a derived id without differing in
    the source id that produced it. If that reasoning is wrong, the ruling is
    wrong. Attack it directly.

C3. A stored version-3 stock-count receipt must be refused rather than compared
    against a freshly computed version-3 digest, and refusing without verifying
    the input is safer than replaying the stored result. Derived from the fact
    that a caller cannot resend the old identities (exactKeys refuses both keys)
    and the receipt stores input_digest and mutation_result but never the input.

C4. Three of the finding's four released-data cases CANNOT EXIST. Derived by
    reachability, measured in the compiled artifact apps/api loads rather than
    the authored source: decoding the head release of
    apps/web/release/app.compiled.json (index 14 of 15, releaseRoot 8476ba3f...)
    gives eight stock_count operations, all generic record effects with
    capability: null, and exactly one operation naming
    northstar.inventory:capability.posting — inventory_transaction_post.
    apps/api/src/composition-root.ts registers one factory for that capability;
    that executor calls postAdjustment only. postStockCount has no production
    caller and is the sole writer of a version-3 receipt. THIS IS THE CLAIM MOST
    WORTH BREAKING: one reachable route to postStockCount, or one other writer of
    digest version 3, refutes the whole disposition.

C5. The fourth case is real, is confined to app releases 4 through 13, and this
    packet structurally cannot carry it. Derived by decoding EVERY release in
    app.compiled.json for the requiredness of both companion relations: 0-3 have
    no stock_count entity, 4-13 are required: true, 14 relaxed them. The
    structural half is that stock_count is module storage and db/migrations/** are
    platform migrations forbidden module DDL.

WHAT THE LANE DID NOT VERIFY, could not verify, or verified only by its own
construction — read this before deciding how much of the above to trust:

N1. test:browser did not run. apps/web/test/browser/composed-application.spec.ts
    imports INVENTORY_POSTING_CAPABILITY_VERSION symbolically, so the lane
    believes the bump needs no edit there, but that belief is unobserved.
N2. The version-4 exclusion is type-forced in ONE direction only. A field added
    to InventoryStockCountPostingCommandV2 enters the digest automatically; a new
    KERNEL output added to DerivedStockCountCommand would pass through the spread
    in callerStockCountInput and silently enter the digest. Only a test catches
    that, not a type.
N3. The four expected-red entries are self-chosen. review-tiers is explicit that
    a self-chosen mutation table measures its author's model. The lane measured
    each red rather than predicting it, but it chose which four to measure.
N4. The reachability proof in C4 is a static argument over one repository at one
    SHA. It does not observe a running deployment, and the lane has no access to
    one. If you think a static proof cannot settle a question about released
    data, say so — that is exactly the kind of objection this packet needs.
N5. The lane asserts no released stock count has been POSTED. It does not assert
    no stock_count ROWS exist; C5 says the opposite.
N6. The capability version bump's only observation is the packet's own test. The
    lane wrote both the bump and the thing that watches it.

KNOWN AND DELIBERATE, so you can rule on whether each is acceptable rather than
rediscover it:

K1. test/postgres/trust-substrate.test.ts's TITLE still says "migrations
    0006-0022" while its body asserts 0023. Changing it fails
    evidence:expected-red, because
    test/evidence/relation-requiredness-relaxation.expected-red.json — an
    accepted packet's manifest, outside this lease — names that test by title in
    test.namePattern and kills[0].name, and measurePhase asserts the pattern
    selects at least one test. The lane left the title stale rather than cross
    the lease and filed a bridge request. Rule on whether that was right.
K2. INVENTORY_POSTING_CAPABILITY_VERSION is now 2 while the head compiled
    release declares the posting capability at capabilityVersion: 1, and
    hasValidCapabilityFacts checks only >= 1. Filed as
    posting-capability-version-has-three-encodings; both other encodings are
    outside the lease. Rule on whether shipping that divergence is acceptable or
    whether the bump should have been withheld until it could be reconciled.

OUT OF SCOPE per the charter: goods receipt and receipt correction; the
received-quantity read model (PUR-2c); closing the generic companion writers;
posting-platform-plane-writes-not-row-complete; packages/compiler/** and
packages/postgres-provider/src/module-storage-materializer.ts.

THREAT MODEL: accidental and plain violations by honest developers or AI
writers, not active obfuscation. The realistic adversary is a future packet that
changes the companion derivation, adds a field to the stock-count command, or
wires a stock-count posting operation, without noticing what it breaks.

DECISIVE QUESTIONS:

A. Is C4 sound? Find a reachable route from a released application to
   postStockCount, or any other writer of input_digest_version 3. If one exists,
   the released-data disposition fails and this is a BLOCK.
B. Is C2's ruling right, and does ADR-0063 argue it rather than assert it? If
   keeping the derived identities in the digest would have been better, say why
   the no-information argument fails.
C. Does the version-3 refusal in C3 leave any path that still computes a fresh
   version-3 digest for a stock count, or any path where a version-3 receipt
   stops decoding? Check findNaturalReplay and recordedResultForReplay
   specifically — they reach recordedResultForReplay without a digest
   recomputation, and the lane claims that is correct rather than a leak.
D. Do the two new tests observe what they claim? In particular, does the
   version-4 test discriminate between the two candidate rulings rather than
   merely hash something, and is the legacy-receipt specimen faithful to a real
   pre-PUR-2a receipt?
E. Do the four expected-red entries each die ALONE and for the assertion that
   carries their claim? Name the cheapest one-property survivor that would leave
   all four green.
F. Is migration 0023 correct and complete, and is the pin surface fully updated?
   The lane found nine sites and one outside its lease; find a tenth it missed.

OPEN QUESTION — answer this in your own terms rather than choosing from options:
this packet decided that a version-3 stock-count receipt should be REFUSED with a
new reason rather than replayed, migrated, or left to fail as before. Given that
the lane also argues no such receipt can exist in released data, what is the right
relationship between a transition's code and data it has proven absent — and does
this packet get that relationship right?
```

## Arm 2 — Fable max confirm

Runs on the IDENTICAL SHA only after arm 1 returns PASS, per the `review-tiers`
Critical row. Its charter is the same, narrowed to the two rulings and the
reachability proof: whether ADR-0063's arguments hold, whether C4 is sound, and
whether K1 and K2 were disposed of correctly.
