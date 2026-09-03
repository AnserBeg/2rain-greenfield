# posting-kernel-admission — the cross-layer admission map for the posting kernel

Cut from `3b7b6dab2ddb790b33b7b641c68773c62db18e9a` (`main`) on branch
`packet/posting-kernel-admission`, worked in the detached worktree
`../2rain-greenfield-pka` because the shared checkout is `ENUM-WIDEN`'s.
Tier: **Critical.** Evidence band: **Band A, declared** — a wrong digest or an
unrun verifier is silent until a replay or a reconciliation exposes it, so full
`AGENTS.md` §6 applies: one recorded red per vacuity vector.

Owns `5g3-prog` R1, R2 and R3 (three fix-now findings of the inventory-ledger
program review, each verified against the tree by the orchestrator). Closes
`posting-capability-version-has-three-encodings` and
`posting-writer-coverage-is-declared-not-observed`. Amends
[ADR-0063](../../decisions/ADR-0063-a-receipt-digest-covers-the-callers-input.md).

`policy-unbound-refusal` was checked before the one `conformance.ts` cell was
touched: it is **frozen for review** at `87878a6` (its own lanes row), so the
charter's "wait for POLICY's freeze" condition holds. Its four hunks in that
file sit at the import block and around lines 212, 1532 and 1549; this packet's
one cell is at the `capabilityVersion` pin near line 2373, with no import
change, so the two do not overlap.

## R1 — one capability-version authority, checked exactly where the provider meets the release

**What was measured before anything was designed.**

| question | measured |
|---|---|
| can the provider import the contract? | **Yes.** `packages/dev-tooling/src/architecture-boundaries.ts` classifies `postgres-provider` as kind `other`, which may import any workspace package; `compiler` may import only `canonical-model`. So the provider imports `packages/domain/src/inventory/contracts.ts` by relative path, exactly as it already imports `platform-runtime`, and the compiler cannot. |
| is the definition literal "twice"? | **Once for the posting capability.** `definition.ts` carries two `capabilityVersion: 1` literals; the first binds `standard_surface_content`, which every module declares at 1 and which is not this packet's. Only the `postingCapabilityId` literal moved. |
| does moving the definition literal change `app.compiled.json`? | **Yes, measured in the scratchpad first.** One authored line moves (`capabilityVersion` 1 → 2), and the compiler mints lineage entry 16: head root `8476ba3f…` → `20cf341749847f8f2860f197f4ebd5b3d6bfcf401fc7528866c9e667b7a8b44e`, declaring the posting fact at 2, with no storage transition. Regenerated under `check:app-release`. This makes the packet serial with any other packet that regenerates the artifact; `policy-unbound-refusal`'s frozen diff touches no release file. |
| where can an EXACT check live? | **Not at stage time:** `createComposedApplicationRuntime` stages every lineage entry through `verifyCompiledRelease` on every boot, and eleven of the shipped sixteen entries declare the posting capability at 1 — history, correct when compiled. **Not at admission:** `ensureReleaseAdmitted` returns early for an already-admitted release, and the actual R1 scenario is an admitted head release whose provider moved underneath it (PUR-2b did exactly that); a rollback target is admitted already. **And the generic repository knows capability IDs only**, never which provider version is registered (`capability-operation-executor-factory.ts`: "generic code knows IDs only"). So the check lives where the provider binds to the ACTIVE release, on every posting. |
| does the compiled contract release move? | **Yes:** `compileInventoryContract` hashes the contract, so its release root moved `8da1a94b…` → `92085807…`. It is pinned by the compiler test golden (see bridges). |
| is the dependency-set root affected? | **No.** `inventoryCanonicalRoot` hashes the `authoritativeDependencies` entries only. |

**The rule is exact, and why.** ADR-0063 decision 3 defines the number as a
MAJOR version: PUR-2a changed the public stock-count command's key set and
`exactKeys` refuses a caller written against the previous shape. There is no
minor axis to be compatible along, so a release declaring 1 is not served by a
provider implementing 2, nor the reverse. A floor (`>= 1`) is what let the
shipped head release declare 1 while the provider implemented 2 with every
gate green.

**What changed.**

- `INVENTORY_CONTRACT_V1.capabilityVersion` is **2** and is the authority.
  **Precisely** (the round-1 reviewer was right that the first draft overstated
  this): the number is spelled twice inside `contracts.ts`, once in the
  `InventoryContractDefinitionV1` type and once in the frozen value. They are
  compile-time coupled in one artifact and fail closed together, so they are one
  authority rather than two that can drift; "nothing else spells the number" was
  literally wrong and is corrected here.
- `definition.ts` reads it: `capabilityVersion: INVENTORY_CONTRACT_V1.capabilityVersion`.
- `INVENTORY_POSTING_CAPABILITY_VERSION = INVENTORY_CONTRACT_V1.capabilityVersion`
  in the provider. `validateRegistration` stays exact against it.
- `assertRegisteredCapabilityVersionIsDeclared` runs on entry to `#post`,
  **before the stored-receipt lookup** (corrected on round-1 review — see below):
  it reads the registered release's persisted manifest
  (`read_tenant_release_artifacts`, kind `releaseManifest`, content hash = the
  release root), requires exactly one fact for the posting capability, and
  refuses `INVENTORY_POSTING_CAPABILITY_MISMATCH` unless
  `fact.capabilityVersion === registration.capabilityVersion`. No fact, more
  than one, or an unreadable manifest refuses too. `assertActiveRelease` keeps
  the pointer and storage-artifact binding it already had, still after the
  receipt lookup, because moving that would re-adjudicate `PUR-2a`'s replay
  design.
- The compiler cell: the literal `1` is gone. The cell's only input IS the
  contract, and the compiler cannot import the domain, so what it checks is that
  the contract carries a positive integer. The record says plainly that this
  removes the compiler's opinion on the NUMBER; the encoding a release carries
  derives from the same contract through the definition.
- `hasValidCapabilityFacts` is unchanged in code and documented at the site as a
  shape check, with the measured reasons above and a pointer to the exact check.
- A deterministic artifact pin: `test/postgres/inventory-posting.test.ts` reads
  the head release of `app.compiled.json` and asserts its posting fact equals
  the provider's version, so a stale artifact reds the matrix before deployment.

**Both directions controlled.** Declared 1 / provider 2 REDS: a release compiled
from a definition patched to declare 1 — consistent with itself, so the compiler
admits it — is staged, pointed to, and refused on the first posting with the
mismatch naming both numbers, nothing committed. Declared 2 / provider 2 admits:
every other posting test, and the admission twin explicitly.

## R2 — version 4 covers exactly the caller's input

**Stop condition re-verified on the base before editing.** `grep -rn postStockCount`
over the tree returns its definition and two test files; the head release's
only operation naming the posting capability is `inventory_transaction_post`,
routed to an executor that hydrates an adjustment draft and calls
`postAdjustment`; version 4 is written only by `postStockCount`. No version-4
receipt exists in released data, so the input is corrected **in place at
version 4**. Had one been able to exist the fix would have been version 5.

`digestCommand`'s version-4 branch hashes `callerStockCountInput(command)` and
nothing else. `postingRole` was `parsed.kind === 'initial' ? 'count' : 'correction'`,
a pure function of the covered `kind`, so it carried no information — ADR-0063's
own exclusion argument, applied to the one kernel-derived value PUR-2b left in.
Version 2 (adjustment, transfer) keeps its role: those receipts are released
data. The version-3 decode path is untouched; PUR-2b's seven controls, including
the three natural-replay kinds, run unchanged in the same manifest gate.

The existing version-4 test computes the caller digest without the role, and
asserts the role twin FIRST — the digest with the role restored must differ from
the caller digest and must not be what was stored — so the mutation that re-adds
the role produces its own red rather than PUR-2b's identities red.

## R3 — executed verifiers compared exactly with the observed write set

**The gap, as the code stated it.** `assertPostingWriterInventoryRegistered`
proves at construction that a verifier is REGISTERED for every derived relation;
`assertObservedWriteSetIsDerived` proves that every written relation is DERIVED.
Neither proves a verifier RAN. A family can omit one verifier call and satisfy
both, which is the survivor the review named.

**Design.** `ExecutedVerifierCoverage` is a per-posting ledger created in `#post`
beside the write baseline and threaded into every verifier. Each verifier mints
a token only from a row it actually read: every read-back query now selects the
row's relation name through `pg_class` from its `tableoid`, resolved by
PostgreSQL rather than chosen by the verifier. `readBackMovements` therefore
mints the PARTITION each movement came back from; `assertMovementEffectReservations`
the companion; `assertPostedStockBalancesReconcile` the balance;
`readBackStockCountEvidence` the session and its lines;
`assertCompanionIdentitiesPersisted` the companion transaction and its lines (the
source it joins is the evidence read-back's to cover); `assertAuthoredTransactionPersisted`
the header. Before any trust document or receipt is written,
`assertExecutedVerifiersCoverWriteSet` takes a FRESH counter snapshot (the same
`pg_stat_xact_user_tables` delta the existing backstop uses, taken again after
the last verifier ran) and refuses on four conditions: an empty write set; a
token from a verifier the registry does not bind to that relation; a written
relation with no token; a token for a relation not written. It calls no
verifier and no verifier calls it.

**Measured, not assumed:** an insert routed through the partitioned movement
parent counts on the leaf partition only (`n_tup_ins` 0 on the parent, 1 on the
partition), and a row read through the parent carries the partition's
`tableoid`. So the parent never appears on either side; its registration is
construction-time only. This is what makes the exact two-way comparison sound.

**The registry is now carried on the binding** (`writerVerifiers`, relation →
verifier names) so the runtime ledger is checked against the same registry
construction proved complete; `assertPostingWriterInventoryRegistered` returns
it.

## Controls — eleven entries, each dying alone, plus two bridged

`test/evidence/posting-kernel-admission.expected-red.json`. Kill targets are the
four new posting tests (T0 the admission twin, T1 the unverified-path refusal,
T4 the declared-1 refusal) and the PUR-2b version-4 digest test.

| entry | vector | kills | red |
|---|---|---|---|
| `verifier-call-deleted-registration-intact` — **run first, alone** | subject absent (the review's survivor) | T0 | `…no executed verifier observed: <reservation>` |
| `verifier-returns-without-observing` | proxy: the call ran, the observation did not | T0 | `…no executed verifier observed: <balance>` |
| `coverage-comparison-absent` | subject absent | T1 | must refuse before commit |
| `coverage-read-from-the-registry-not-the-tokens` | proxy: registration read as execution | T1 | must refuse before commit |
| `token-minted-for-an-unwritten-relation` | the second direction | T0 | `…did not write: <movement parent>` |
| `token-minted-by-an-unregistered-verifier` | wrong verifier claims a relation | T0 | `…not registered against: <reservation> by readBackMovements` |
| `version-four-digest-covers-the-derived-role` | R2 subject | v4 test | must not cover the posting role |
| `active-release-fact-never-read` | R1 subject absent | T4 | must be refused |
| `active-release-fact-compared-as-a-floor` | proxy: the floor restored | T4 | must be refused |
| `active-release-fact-lookup-finds-nothing` | zero input refuses | T0 | manifest could not be read |
| `definition-detached-from-the-contract` | the authority stops being read | T0 | declares 1 while the provider implements 2 |

Bridged (see below): `pur-2b/capability-version-not-bumped` now kills the
version-4 test with the provider's mismatch refusal;
`posting-writer-inventory/effect-reservation-never-observed` keeps its kill.

**Every one of the thirteen reds reproduced and restored** (`check-expected-red.sh --run`, the survivor first and alone, then the other twelve; the last executable commit is `10eebfb42570cfc01edd72b888ab13f3dd8f5fcd`). Each entry: 1 passing → 1 killed, with the declared message.

```
verifier-call-deleted-registration-intact       1 passing -> 1 killed   (run first, alone)
verifier-returns-without-observing              1 passing -> 1 killed
coverage-comparison-absent                      1 passing -> 1 killed
coverage-read-from-the-registry-not-the-tokens  1 passing -> 1 killed
token-minted-for-an-unwritten-relation          1 passing -> 1 killed
token-minted-by-an-unregistered-verifier        1 passing -> 1 killed
version-four-digest-covers-the-derived-role     1 passing -> 1 killed
active-release-fact-never-read                  1 passing -> 1 killed
active-release-fact-compared-as-a-floor         1 passing -> 1 killed
active-release-fact-lookup-finds-nothing        1 passing -> 1 killed
definition-detached-from-the-contract           1 passing -> 1 killed
pur-2b/capability-version-not-bumped            1 passing -> 1 killed   (bridged)
posting-writer-inventory/effect-reservation-never-observed
                                                1 passing -> 1 killed   (bridged, kill unchanged)
```

**Two things the first run taught, both corrected before any red was accepted.**
The admission twin's assertion serialised the refusal with `JSON.stringify`,
which drops an Error's message, so the runner could not see the declared text
even though the posting was refused with the right code and the right observed
set; the message is now spelled out. And the declared-1 control could not
observe a commit with the fact check deleted, because the scope configuration's
release-root comparison refused the posting one step later for a different
reason; the test now points the configuration at the declared-1 release, so the
fact check is the only guard between that posting and a commit — which is what
the control claims.

## Round 1 — BLOCK, and the finding was a real production defect

Reviewed `b25d4844175dd7c5cee4e60f84629958dc50c5cc` (fresh naive, read-only on
the pushed branch). **Verdict BLOCK on C1**, PASS on C2, and C3 accepted as the
narrow read-coverage claim it declares.

**The finding, confirmed in the tree before anything was changed.** `#post`
looks the stored receipt up BEFORE `assertActiveRelease`, and returns from it:
`findReceipt` keys on tenant, environment, capability and idempotency key only
— never on the release the receipt was recorded under — and
`validateReceiptReplay` compares the principal and the recomputed digest, then
commits and returns the recorded result. The capability-fact check sat inside
`assertActiveRelease`, which that path never reaches. So an operator on a
release declaring version 1 could replay a key recorded under version 2 and be
served the version-2 result with no mismatch announced. **The packet's own
claim — and ADR-0063's amended text — said the check runs on every posting. On
that path it did not.** The declared-version-1 test used a fresh key, so it
missed the gap entirely.

**The correction.** `assertRegisteredCapabilityVersionIsDeclared` is hoisted to
run immediately after the request-key lock and **before** `findReceipt`, so no
path returns without it. `assertActiveRelease` keeps the pointer and
storage-artifact binding exactly where it was. The reviewer's suggested
alternative — moving all of `assertActiveRelease` ahead of the receipt lookup —
was considered and not taken: it would change when `PUR-2a`'s release-mismatch
and storage-artifact refusals fire on the replay path, which is a design this
packet was not chartered to re-open. The rule is now stated as two halves in
ADR-0063 rather than as one over-broad sentence.

**The control the reviewer asked for, and its discriminating twin.** New test
*"a stored receipt is not replayed across a release that declares a different
capability version"*: post successfully under the release declaring 2, then
replay the same command and key through a provider registered against a release
declaring 1. It must refuse `INVENTORY_POSTING_CAPABILITY_MISMATCH`, and the
recorded receipt and its movement must both survive untouched. New manifest
entry `active-release-fact-checked-after-the-receipt-lookup` restores the
reviewed candidate's PLACEMENT exactly — nothing deleted, the check moved back
below the replay return — so it kills the replay test while
`active-release-fact-never-read` (the same call deleted) kills the fresh-posting
test instead. **That pair is the point: one proves the check exists, the other
proves it runs before anything can return.**

**The reviewer's other dispositions, recorded rather than argued with.** The
duplicate `2` inside `contracts.ts` is corrected above as wording. Removing the
compiler's pinned number was judged not a material loss, and
`hasValidCapabilityFacts` was judged correct to leave as a generic shape check —
both matching what this record already claimed, so nothing changed. The
verifier that reads a row and then compares nothing is confirmed as a real
one-property survivor of the token mechanism and NOT a current production
defect; it stays declared as a limit, and C3 continues to be described as
relation-read coverage rather than proof that every predicate inside every
verifier held. The reviewer also judged this prompt to be steering; the next
one drops the placement rationale and the pre-adjudications.

## Bridges taken — four edits in three accepted artifacts, all mechanical, all the orchestrator's to revoke

Each is an accepted packet's artifact that pins the exact production text or
digest this packet was chartered to move. None was named in the charter; each
was found by a gate, and leaving any one of them would have left that gate red.
Stopping for a one-line pin update would have cost a round trip for no
information (`mission-cadence`, stop convergence), so they were taken and are
disclosed here rather than folded in silently.

1. `test/evidence/pur-2b.expected-red.json`, entry `capability-version-not-bumped`:
   its `original` was the literal constant line this packet replaces with the
   contract import; its `replacement` becomes `= 1 as const`; its `expected`
   moves to the provider's mismatch refusal, because the provider now refuses a
   release declaring 2 before any result exists — the same claim, observed one
   layer earlier. The claim text records the update.
2. `test/evidence/posting-writer-inventory.expected-red.json`, two entries.
   `effect-reservation-never-observed`: its `original` is the reservation call,
   which gains one argument; kill unchanged. `the-observed-write-set-is-never-checked`:
   **found by the full `evidence:expected-red` run at the first frozen
   candidate, not predicted.** With the derived-write-set backstop deleted, the
   undeclared-writer test no longer commits silently — the executed-verifier
   comparison refuses it one step later, for the weaker reason (no executed
   verifier observed `nsm_t_pwi_undeclared_writer`) rather than the derivation
   reason. An undeclared relation is by construction also unobserved, so the
   backstop's refusal is subsumed at posting time; what it still supplies is
   the derivation diagnosis. The entry's `expected` moves to the new message
   and its claim says so; the silent commit it originally described is no
   longer reachable. The backstop stays, because it names the cause.
3. `test/compiler/inventory-contract.release.golden.json`: the compiled
   contract release root moved with the contract's version. Re-derived, not
   picked — the root was recomputed from `compileInventoryContract`, exactly one
   field moved, and the test's deep-equal over the whole summary is what verifies
   nothing else did.

## Declared limits

- **The compiler no longer pins the NUMBER.** It cannot import the domain and
  has no production caller for `compileInventoryContract`, so the cell admits
  what the contract carries. A control for that shape check would live in
  `test/compiler`, outside this lease; it is Band C (visible on reading) and is
  stated rather than controlled.
- **The runtime check costs one manifest read per posting** (one query on the
  artifact function already used for the storage target, plus a JSON parse of
  the manifest). Not measured against a budget; the posting already does two
  artifact reads and a dozen read-backs.
- **`hasValidCapabilityFacts` is unchanged in code.** The lease named it; the
  measurement says the floor is correct as a shape check at stage time. If the
  orchestrator wants an admission-time refusal as well, it needs the factory
  interface to carry a version, which is outside this lease.
- **Coverage tokens prove a row was READ from the relation, not that the
  comparison inside the verifier held** — that half is `assertPersistedRowVerified`
  and the existing column controls, which are unchanged.
- **The deferred-trigger vector** (`posting-write-observation-misses-deferred-triggers`)
  applies to the fresh snapshot exactly as to the first; nothing here closes it.
- **`test:browser` and the rest of the matrix** ran only in the full matrix
  below, not during development.

## Gates

**Two full matrices ran, both green, and the record of the second is partial —
stated rather than smoothed over.**

**Matrix 1, at `5350ae32aa0da6806e869a40127115176d08b9f5`** (the first frozen
candidate, whose executable tree differs from the final one by one manifest
entry's `expected` and `claim` strings in `posting-writer-inventory.expected-red.json`):
`scripts/run-matrix.sh` reported **`FULL_MATRIX_PASS_SHA=5350ae32aa0da6806e869a40127115176d08b9f5`**,
zero `not ok` lines.

| suite | result | gate | result |
|---|---|---|---|
| `test:unit` | 155 | `format` / `lint` / `typecheck` / `build` | PASS |
| `test:compiler` | 157 | `check:boundaries` | PASS (164 files) |
| `test:integration` | 149 | `check:schema` | drift PASS |
| `test:architecture` | 189 | `check:demo-release` / `check:app-release` | PASS |
| **`test:postgres`** (REQUIRED) | **227** | `check:expected-red` | OK — 73 entries in 7 manifests |
| `test:contracts` | 29 | `check:expected-red-controls` | OK — 38 controls |
| **`test:browser`** | **93** | `check:language-coverage` | PASS (2050 obligations) |
| `test:agent` / `test:locale` / `test:performance` | 3 / 1 / 5 | `check:reachability` | 106/106; 10 producer artifacts |

The security scan's `leaks found: 1` is the planted negative control passing;
`gitleaks-clean.json` is `[]` across 1,773 commits.

**Matrix 2, at the frozen head `f968775d5c79106c88c002afb4cdb4557ac8a420`**,
run after the fourth bridge edit. Its console log lived in `/tmp` and a
session restart wiped `/tmp` before the lane read it, so **the
`FULL_MATRIX_PASS_SHA` line for this run is lost.** What survives is the
per-suite evidence the matrix writes into the worktree: every suite's
`test-results/reachability/<suite>.json` for `runId: admission2-f968775d`
records `suiteSucceeded: true` — unit, compiler, integration, agent,
architecture, contracts, postgres, browser, performance and observability —
timestamped 18:03–18:34 on 2026-09-01, and the security evidence at 18:35 shows
the run reached its final step. The `check:*` gates print only to the console
and have no surviving evidence for this run beyond the first matrix, where
each passed on a tree whose only difference is the manifest strings above.
**The lane does not claim `FULL_MATRIX_PASS_SHA` for `f968775`.** The
suite-evidence files are what it claims, and it says so in the ledger.

**`evidence:expected-red`, in full:** the first full run at `5350ae3`
reproduced 24 entries and stopped at `the-observed-write-set-is-never-checked`
— the real finding recorded under bridges. After the correction, that entry was
reproduced alone at `10eebfb`. The second full run at `f968775` completed (its
journal was cleared on exit), but its verdict was in the same wiped log.
**The lane claims: all thirteen owned or bridged entries plus the corrected
backstop entry reproduced individually at their SHAs, and 24 of 73 reproduced
in one full run at `5350ae3`; it does not claim a full 73-entry run at the
frozen head.**

**Owed when Docker returns** (down after the restart; no suite that needs a
container can run, and `test:architecture` hangs without one): one
`scripts/run-matrix.sh` at `f968775` to retain the pass line, and one full
`evidence:expected-red`. Both are re-runs of what the evidence files say
already passed, at the same tree; neither changes the candidate.

**At the final head** (this record commit, narrative-only above `10eebfb`):
`format` PASS, `scripts/check-records.sh` OK; `test:architecture` reads
`docs/**` and is owed at this head with the re-run above.

## The declared range

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "posting-kernel-admission",
  "base": "3b7b6dab2ddb790b33b7b641c68773c62db18e9a",
  "head": "10eebfb42570cfc01edd72b888ab13f3dd8f5fcd",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "packages/compiler/src/conformance.ts",
    "packages/domain/src/inventory/contracts.ts",
    "packages/domain/src/inventory/definition.ts",
    "packages/postgres-provider/src/inventory-posting-service.ts",
    "packages/postgres-provider/src/release-repository.ts",
    "test/compiler/inventory-contract.release.golden.json",
    "test/evidence/posting-kernel-admission.expected-red.json",
    "test/evidence/posting-writer-inventory.expected-red.json",
    "test/evidence/pur-2b.expected-red.json",
    "test/postgres/inventory-posting.test.ts",
    "test/postgres/inventory-stock-count.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/domain/src/inventory/contracts.ts",
      "name": "INVENTORY_CONTRACT_V1"
    },
    {
      "path": "packages/domain/src/inventory/definition.ts",
      "name": "inventoryModuleDefinition"
    },
    {
      "path": "packages/compiler/src/conformance.ts",
      "name": "validateInventoryContractDefinition"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "INVENTORY_POSTING_CAPABILITY_VERSION"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "assertActiveReleaseDeclaresRegisteredCapabilityVersion"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "digestCommand"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "ExecutedVerifierCoverage"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "assertExecutedVerifiersCoverWriteSet"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "assertPostingWriterInventoryRegistered"
    },
    {
      "path": "packages/postgres-provider/src/release-repository.ts",
      "name": "hasValidCapabilityFacts"
    }
  ]
}
```

## Test it yourself (under ten minutes)

1. Open `packages/postgres-provider/src/inventory-posting-service.ts` and find
   the call `await assertMovementEffectReservations(` inside `#post`. Comment
   out the whole call (eight lines, ending `);`). Registration is untouched.
2. Run the focused posting test:

```bash
node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test --test-name-pattern='the unchanged kernel admits' test/postgres/inventory-posting.test.ts
```

3. Watch it refuse. The `not ok` carries
   `INVENTORY_POSTING_STORAGE_REJECTED: this posting wrote module relations no executed verifier observed: nsm_t_ipzadmib…` —
   the effect-reservation companion, named. Nothing committed.
4. Restore the call (`git checkout -- packages/postgres-provider/src/inventory-posting-service.ts`)
   and run the same command: `ok`.

Optional, R1 in one look: `git show HEAD:apps/web/release/app.authored.json | grep -n '"capabilityVersion": 2'`
shows the posting requirement at 2; the provider constant is
`INVENTORY_CONTRACT_V1.capabilityVersion`.

## Pasteable review prompt — arm 1, fresh naive Codex, xhigh

The prompt uses `<FROZEN_SHA>` because a commit cannot contain its own
identity. Replace it with the exact remote SHA in the session report's
`git ls-remote` line.

```text
You are the fresh-naive round-1 reviewer for Critical packet
posting-kernel-admission in /home/rvham/2rain-greenfield.

Review exact remote candidate <FROZEN_SHA> against base
3b7b6dab2ddb790b33b7b641c68773c62db18e9a. The remote branch is
packet/posting-kernel-admission; verify the supplied git ls-remote line before
reading. The last EXECUTABLE commit is 10eebfb42570cfc01edd72b888ab13f3dd8f5fcd;
everything above it is narrative (the packet record, ledger, lanes, archive,
current-plan, and the ADR-0063 amendment). Work read-only. Do not edit, commit,
run the full matrix, invoke another reviewer, or rely on line numbers --
re-locate every symbol by name.

Return PASS, REVISE, or BLOCK with file/symbol evidence for every material
finding.

This prompt was written by the lane whose work you are reviewing. **The lane has
fenced nothing.** Any scope stated here is the orchestrator's, and it stands as a
claim under test rather than a limit you may not question. Read whatever you
judge relevant to the decisive questions, say plainly if you think the scope is
drawn wrongly, and say plainly if the prompt itself is steering you.

TIER: Critical, because it changes an idempotency digest on a released posting
protocol, the version admission between a release and the provider that serves
it, and the pre-commit verification of every inventory posting. Evidence band A,
declared: a wrong digest or an unrun verifier is silent until a replay or a
reconciliation exposes it.

READ FIRST: docs/execution/packets/posting-kernel-admission.md (the record),
docs/decisions/ADR-0063-*.md (the amendment at the end), and
docs/execution/program-reviews/2026-09-01-inventory-ledger.md (R1, R2, R3 --
this packet is their disposition). Then .agents/skills/review-tiers/SKILL.md
and AGENTS.md section 6.

THE THREE CLAIMS, written as claims to be tested:

C1 (R1, one authority). INVENTORY_CONTRACT_V1.capabilityVersion in
packages/domain/src/inventory/contracts.ts is the only spelling of the posting
capability version. The inventory module definition reads it; the provider's
INVENTORY_POSTING_CAPABILITY_VERSION imports it; the compiler's conformance
cell no longer holds a literal. assertActiveReleaseDeclaresRegisteredCapabilityVersion
(called from assertActiveRelease, on every posting) reads the ACTIVE release's
persisted manifest and refuses INVENTORY_POSTING_CAPABILITY_MISMATCH unless the
posting fact equals the registered version, EXACTLY. The lane claims exact is
the only correct rule because ADR-0063 decision 3 defines the number as a major
version with no minor axis, and claims that stage-time and admission-time
placements were measured and rejected (the record's R1 table). Test whether the
placement is right, whether the read of the manifest is the artifact the release
kernel verified, and whether any path serves a release without passing through
assertActiveRelease.

C2 (R2, the digest). digestCommand's version-4 branch hashes
callerStockCountInput(command) and nothing else; the derived postingRole is
gone from the input. The lane claims this is correct in place at version 4
because no version-4 receipt exists in released data (ADR-0063 section 4,
re-verified on the base: postStockCount has no production caller). Test the
re-verification, and test that the version-3 decode path and PUR-2b's seven
controls are untouched.

C3 (R3, executed verifiers). ExecutedVerifierCoverage is a per-posting ledger;
each verifier mints a token from the tableoid of a row it read;
assertExecutedVerifiersCoverWriteSet compares the ledger EXACTLY with a fresh
pg_stat_xact_user_tables delta before commit, in both directions, and checks
each token against the construction-time registry. The lane claims the
comparison shares no code path with the verifiers and repairs nothing.

THE SURVIVOR THE REVIEW PREDICTED, and the first mutation the lane ran: delete
one verifier CALL from #post with its registration intact. The manifest entry
verifier-call-deleted-registration-intact reproduces the refusal naming the
effect-reservation companion. Decide whether the twelve other entries close the
remaining vacuity vectors, and look for the one-property survivor the lane did
not think of -- in particular a verifier that reads a row from its relation and
then compares nothing, which the token would still cover (the lane declares
that limit).

WHAT THE LANE DID NOT VERIFY, COULD NOT VERIFY, OR VERIFIED ONLY BY ITS OWN
CONSTRUCTION:

- The compiler no longer pins the NUMBER. compileInventoryContract has no
  production caller (measured: only tests call it), the compiler may not import
  the domain package, and the cell's only input is the contract itself. The
  lane replaced the literal with a positive-integer check and added no control
  for it (test/compiler is outside its lease). Decide whether removing the
  compiler's opinion on the number is a loss.
- hasValidCapabilityFacts is unchanged in code; the lane documented at the site
  why the floor stays a shape check. The lease named it for change. Decide
  whether an admission-time refusal is also owed, and whether that needs the
  executor-factory interface to carry a version (outside the lease).
- Three bridges into accepted artifacts, taken rather than stopped for, all
  disclosed in the record: pur-2b's manifest entry capability-version-not-bumped
  (original, replacement and expected all changed), posting-writer-inventory's
  effect-reservation-never-observed (original gains one argument), and the
  compiler golden test/compiler/inventory-contract.release.golden.json (one
  field, re-derived). The lane believes each is mechanical and inside the
  charter's intent; the orchestrator may revoke any of them.
- The tokens prove a row was READ from a relation, not that the verifier's
  comparison held; that half is assertPersistedRowVerified, unchanged.
- The deferred-trigger vector is unclosed for the fresh snapshot exactly as for
  the first.
- The runtime cost of the manifest read per posting was not measured against a
  budget.
- The artifact regeneration mints lineage entry 16; the lane did not run the
  browser suite outside the full matrix.
- The lane's test for the declared-1 refusal re-points the scope configuration
  at the declared-1 release by an admin UPDATE, so that the fact check is the
  only guard between that posting and a commit. Decide whether that fixture
  proves what the control claims.

DELTA TO READ: git diff 3b7b6dab2ddb790b33b7b641c68773c62db18e9a..<FROZEN_SHA>.
The four new tests are in test/postgres/inventory-posting.test.ts under the
prefix "posting kernel admission:"; the corrected digest test is PUR-2b's
version-4 test in test/postgres/inventory-stock-count.test.ts.
```
