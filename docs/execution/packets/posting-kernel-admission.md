# posting-kernel-admission — the cross-layer admission map for the posting kernel

Cut from `3b7b6dab2ddb790b33b7b641c68773c62db18e9a` (`main`) on branch
`packet/posting-kernel-admission`, worked in the detached worktree
`../2rain-greenfield-pka` because the shared checkout is `ENUM-WIDEN`'s.
Tier: **Critical.** Evidence band: **Band A, declared** — a wrong digest or an
unrun verifier is silent until a replay or a reconciliation exposes it, so full
`AGENTS.md` §6 applies: one recorded red per vacuity vector.

Owns `5g3-prog` **R1, R2, R3, A2, A3 and A6's production comment**. The packet
was chartered on R1-R3 from arm 1; `main` widened the row at convergence
(`c5a6e53`) with A2 and A3, and the round-2 reviewer was right that the branch
was working a stale scope. All six are now done in one freeze, which the queue
row permits ("the writer may stop and split if it outgrows one freeze" — it did
not).

**Evidence band, declared PER FAMILY** as `mission-cadence` has required since
2026-09-01. Every family here is **Band A**, and the reason is the same in each
case — the failure is invisible until something else reconciles it:

| family | band | why it is silent |
|---|---|---|
| R1 capability-version admission | A | a release served by the wrong provider version produces results that look ordinary until a replay or an audit compares them |
| R2 version-4 digest input | A | a digest that stops matching is invisible until a caller replays, and then reports the wrong reason |
| R3 executed-verifier coverage | A | an unrun verifier commits a wrong row that only reconciliation finds |
| A3 `recordedAt` monotonic floor (append path) | A | the negative balance appears only to an as-of read at a horizon between two postings |
| A2 ordering controls | A | the subject is the global movement order, whose divergence changes an admission decision silently |

No family here is Band B or C, so nothing is relaxed. Stating it per family is
the point: a future packet in this file that adds, say, a refusal message would
be Band B and should say so rather than inheriting this one. Closes
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

## A3 — a monotonic `recordedAt` floor per stock identity

**The defect, as the converged review states it and as I re-measured it.**
`recordedAt` is sampled once per posting from a wall clock, and `AGENTS.md` §7
records that this machine steps its clock backward ~2s under CPU load.
`compareInventoryMovementOrderEntries` orders by `effectiveAt` FIRST and only
then by `recordedAt`, so a backward step is invisible to `enforceNegativeStock`:
a +10 recorded at 13:00:05 with an earlier effective time and a -5 recorded at
13:00:03 with a later effective time sort as (+10, -5), never project a negative
prefix, and are admitted under `negativeStock: 'reject'`. An as-of read whose
recorded-time horizon falls between the two instants then sees only the -5 and
returns a negative balance the kernel never admitted.

**The fix, stated at exactly the width it holds** (narrowed on round-3 review —
the first wording said "any posting", which was broader than the path the check
runs on). **Before a posting APPENDS movements**, per stock identity, under the
locks it already holds: the sampled instant must be **≥** the newest
`recordedAt` already persisted for that identity, or the posting is refused with
the new typed code `INVENTORY_RECORDED_AT_REGRESSION` naming both instants. No
extra query — the persisted rows are the ones already read for the negative
check. Both sides are fixed-width canonical UTC, so lexicographic order is
chronological order, which is the property the comparator already relies on.

**The one path the floor does NOT run on, and why that is correct rather than a
hole.** `findNaturalReplay` returns above `enforceNegativeStock`, so a request
whose natural effect was already accepted — a retry under a fresh idempotency
key — is not floored even under a regressed clock. Three facts, each verified
against the tree, make that harmless: it appends no movement;
`persistAdditionalReceipt` stores the REPLAYED result, and `insertReceipt`
writes `result.recordedAt`, which is the instant the ORIGINAL posting recorded,
so the regressed sample reaches no row; and the `23505` raced-replay branch sits
BELOW the floor and does pass it. So exactly one return path skips the check and
it persists no timestamp of its own. **The reviewer's alternative — sampling the
clock below natural-replay detection so a replay has no sample at all — is a
broader refactor than the evidence requires and is not taken.** What is taken is
the narrowing: the claim now says "before appending", which is what the code
does.

**Refused rather than clamped, and the alternative was genuinely open** — the
review sanctioned either. Clamping the sample up to the floor also closes the
window and keeps the posting alive, but it stores an instant the clock never
produced: a falsified fact in the trust substrate and in every receipt derived
from it. This platform refuses rather than rewrites business data, and a clock
that ran backward is an environment fault an operator should see. **The cost is
real and is stated rather than hidden:** on a machine whose clock regresses, a
second posting on the same stock identity inside the regression window now
fails. That is a deliberate availability-for-integrity trade, and if the
orchestrator prefers the clamp the control and the ADR text move with it.

**Equality is admitted, and that is load-bearing.** Two postings inside one
clock tick, and every fixed-clock test in the suite, record the same instant.
Only a strictly earlier instant refuses; the remaining tuple fields order the
tie. The control asserts both halves — the regression refuses, the equal instant
posts — so a mutation that simply refused everything would not survive it.

## A2 — the ordering kills were prose; they are now controls

The review found that ADR-0027's table and the tests' own assertion messages
named the two discriminating mutations, and **no manifest ran either**. Both are
now entries. The second one needed a test of its own: pointed at the composite
one-way-doors test where the assertion already lived, removing the combined sort
reds through an EARLIER spurious refusal, so the red could not be attributed to
the property. `assertPersistedPlannedOrderIsDecisive` therefore also runs as its
own test, and the entry kills that one.

## A6 — a production comment that was false

The comment beside `assertObservedWriteSetIsDerived` said there is no
`CREATE CONSTRAINT TRIGGER` anywhere in the repository.
`db/migrations/0005_release_activation_kernel.sql` creates **four**. They are
platform-plane, on release-activation tables this query filters out by schema,
so the deferred-trigger vector stays dormant — **but for the reason the plane
gives, not because they are absent.** Corrected in place.

Two further comments were corrected for the same class of reason, both found by
the round-2 reviewer and both mine: the provider header and the
`hasValidCapabilityFacts` comment still attributed the exact version check to
`assertActiveRelease` and called it active-release validation on every posting,
which the round-1 hoist had made false in two ways at once.

## Controls — fifteen entries, each dying alone, plus bridged

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

## Round 2 — BLOCK on scope, and it was right

Reviewed `c257a99cdab4d5083dd181427d8adc32e19faea4`. **BLOCK**, with C2 PASS and
C3 accepted at the narrow read-coverage level it declares.

**The decisive finding was not in the code — it was that the code was answering
a stale charter.** `main` advanced to `c5a6e53` after this packet was chartered:
the `5g3-prog` program review converged (two arms, both ADJUST) and its queue row
for this packet was widened from R1-R3 to **R1 + R2 + R3 + A2 + A3**, with A6's
production comment routed here as well. The branch was still working R1-R3, and
its record said so, which is exactly the "record outliving its truth" class the
review's own R1 is about. **Verified before acting:** `main`'s row and the
converged record both name A2 and A3 as this packet's, and A6's disposition says
the production comment "goes to `posting-kernel-admission`". All three are now
done.

**A3 was a live production defect**, not a documentation gap — see its section
above. The reviewer's reproduction was correct in every step.

**Four further corrections it found, all mine:** the two stale
`assertActiveRelease` attributions in comments; the false
`CREATE CONSTRAINT TRIGGER` sentence (A6); and this record's own bridge count,
which said four-in-three above a list of five-in-four.

**One judgement the reviewer offered and this packet keeps.** It read
`hasValidCapabilityFacts` as defensibly a shape check and the stored-receipt /
active-release split as defensible for this packet, while insisting the source
and record stop calling the result "active-release validation on every posting".
That wording is gone; the two halves are stated separately in the code, in
ADR-0063 and here.

**What it correctly declined to let pass:** that a green matrix at `dd93462`
could discharge controls that were never written. It could not, and the matrix
below is a fresh one at a tree that contains them.

## Round 3 — REVISE, and no production defect

Reviewed `f5987d3e0db09a838ccb339521c10f9cc1d6118f`. **REVISE** with one
material finding; **R1, R2, A2 and A6 PASS**, and R3 passes at its declared
limit after the reviewer independently inspected every registered verifier for
a read-then-return-before-comparing path and found none.

**The finding was that A3's CLAIM exceeded the path its check runs on**, not
that the check is wrong. `findNaturalReplay` returns above
`enforceNegativeStock`, so a retry of an already-accepted natural effect under a
fresh idempotency key is not floored. Verified before acting, and the reviewer's
reading of the consequence was right in every step: no movement is appended, and
the receipt written on that path carries the replayed result's `recordedAt` —
the original posting's instant — so nothing regressed is persisted. The
correction is therefore to narrow the sentence, and the reviewer said so
explicitly: *"Do not make a harmless natural-effect replay fail merely to
preserve the original universal sentence."*

**What changed:** the production comment beside the floor, the test's name
(`a posting` → `a posting that appends movements`), its doc comment, the
manifest entry's claim, and this record. **Production behaviour is
byte-identical to the reviewed candidate** — the executable delta is a comment,
a test name and a manifest claim string.

**It also confirmed the scope is now drawn right**, transcribing `main`'s queue
row and the converged review independently, which is what round 2 blocked on.

**On this round's own steering:** the reviewer flagged *"Assume a third thing
exists"* in the prompt as steering and recorded that it treated the line as a
search hypothesis rather than a requirement to produce a finding. That is the
right call and the phrasing does not survive into any further prompt.

## Bridges taken — five edits in four accepted artifacts, all the orchestrator's to revoke

**The count was wrong in this record until round 2 caught it** — the heading
said four in three while the list below enumerated five in four. Corrected;
the list was right.

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
4. `test/evidence/pur-2a.expected-red.json`, entry
   `posted-balance-verification-removed-at-the-binding`: **found by the complete
   `evidence:expected-red` run at round 2**, not predicted. Its declared red was
   an ABSENT refusal — null the projection binding and the balance verification
   is skipped, so the posting commits and the test fails for a missing rejection.
   It now reds earlier and more specifically: the balance relation is still
   written by its trigger, so with the verifier gone no token covers it and the
   coverage comparison refuses, naming the relation. Expected and claim updated.

**The general consequence, stated once rather than as a run of coincidences.**
Two accepted controls (this one and the undeclared-writer backstop above) had
declared reds of the form *"remove this verifier and the posting commits
silently"*. **That sentence is no longer true of any relation whose write this
transaction can observe, which is the whole point of R3** — the coverage
comparison subsumes the "verifier not reached" vector generically, so those
mutations now red on coverage instead of on a missing refusal. Both entries are
correspondingly NARROWER than they were: each still proves its subject is
load-bearing, and neither still proves that skipping it would otherwise commit
unnoticed. What each verifier actually COMPARES is still proved by its own
column-level entries, which are untouched. **A reviewer should expect this shape
again in any future packet that adds a verifier here, and should check the claim
texts rather than only the reds.**

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

**The full matrix and the complete expected-red set are both green at the
frozen head `663bc292e41a48023cdea26448b1a06dd41d72de`.**

`scripts/run-matrix.sh` reported **`FULL_MATRIX_PASS_SHA=663bc292e41a48023cdea26448b1a06dd41d72de`**
and **zero `not ok` lines across every suite**.

| suite | result | gate | result |
|---|---|---|---|
| `test:unit` | 155 | `format` / `lint` / `typecheck` / `build` | PASS |
| `test:compiler` | 157 | `check:boundaries` | PASS (164 files) |
| `test:integration` | 149 | `check:schema` | drift PASS |
| `test:architecture` | 189 | `check:demo-release` / `check:app-release` | PASS |
| **`test:postgres`** (REQUIRED) | **230** | `check:expected-red` | OK — 77 entries in 7 manifests |
| `test:contracts` | 29 | `check:expected-red-controls` | OK — 38 controls |
| **`test:browser`** | **93** | `check:language-coverage` | PASS (2050 obligations) |
| `test:agent` / `test:locale` / `test:performance` | 3 / 1 / 5 | `check:reachability` | 106/106; 10 producer artifacts |

`test:postgres` grew 227 → 228 → **230** across the three rounds: the
cross-release replay control, then A3's clock-regression control and A2's
isolated ordering test.

**`evidence:expected-red`: OK — all 77 entries reproduced and restored**, the
whole repository's set. The packet's own and bridged entries were additionally
run individually, the round-1 discriminating pair first and alone:

```
active-release-fact-checked-after-the-receipt-lookup  1 passing -> 1 killed  (placement; kills the REPLAY test)
active-release-fact-never-read                        1 passing -> 1 killed  (absence;  kills the FRESH-POST test)
recorded-at-floor-absent                              1 passing -> 1 killed  (A3)
comparator-drops-the-movement-id-tie-break            1 passing -> 1 killed  (A2)
negative-stock-stops-sorting-persisted-with-planned   1 passing -> 1 killed  (A2)
verifier-call-deleted-registration-intact             1 passing -> 1 killed
verifier-returns-without-observing                    1 passing -> 1 killed
coverage-comparison-absent                            1 passing -> 1 killed
coverage-read-from-the-registry-not-the-tokens        1 passing -> 1 killed
token-minted-for-an-unwritten-relation                1 passing -> 1 killed
token-minted-by-an-unregistered-verifier              1 passing -> 1 killed
version-four-digest-covers-the-derived-role           1 passing -> 1 killed
active-release-fact-compared-as-a-floor               1 passing -> 1 killed
active-release-fact-lookup-finds-nothing              1 passing -> 1 killed
definition-detached-from-the-contract                 1 passing -> 1 killed
pur-2b/capability-version-not-bumped                             1 passing -> 1 killed  (bridged)
posting-writer-inventory/effect-reservation-never-observed       1 passing -> 1 killed  (bridged)
posting-writer-inventory/the-observed-write-set-is-never-checked 1 passing -> 1 killed  (bridged)
pur-2a/posted-balance-verification-removed-at-the-binding        1 passing -> 1 killed  (bridged)
```

**One flake across three rounds, disclosed rather than smoothed.** A round-2
matrix at `0ca1330` failed `migrations.test.ts`, *"a failed stream rolls back
schema and migration history together"*, with
`ephemeral PostgreSQL is ready inside its container but its published endpoint
is unavailable: ECONNREFUSED` — the container-endpoint class already on the
queue as `container-pressure-forges-outcomes`, in a migrations test this packet
has no migration in. Re-run alone it passed, and the two matrices since have
zero failures.

**`main` moved and was merged, docs-only.** `main` advanced to `c5a6e53` while
this packet was in flight. Measured: the executable delta from this packet's
base to `main` is **empty** (`docs/**` and `.agents/**` only), so no executable
suite is invalidated. `main` was merged into the branch and the two conflicting
record files — `current-plan.md` and `lanes.md` — were resolved onto **`main`'s**
authoritative rows with this packet's status layered on, never the other way
round. `pnpm format` and `test:architecture` re-run above that merge, because
both read narrative.

## The declared range

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "posting-kernel-admission",
  "base": "3b7b6dab2ddb790b33b7b641c68773c62db18e9a",
  "head": "675b94fb243861b3abdbe720d056e92a3bd7048c",
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
    "test/evidence/pur-2a.expected-red.json",
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
      "name": "assertRegisteredCapabilityVersionIsDeclared"
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

## Where the review stands, and what is owed

**Three arms, three verdicts: BLOCK, BLOCK, REVISE — and the trend is the
point.** Round 1 found a production defect in this packet's own new code. Round
2 found that the charter had moved and A3 was a live defect. **Round 3 found no
production defect at all**: one claim/evidence mismatch, four PASSes, and R3
upheld at its declared limit after an independent sweep of every verifier for
the read-then-return survivor.

`review-tiers`' convergence rule is *zero production defects → CONVERGED*. Round
3 is that round. The correction it did produce changed a comment, a test name
and a manifest claim; **production behaviour is byte-identical to the reviewed
candidate**, and the executable diff between them is:

```
packages/postgres-provider/src/inventory-posting-service.ts   (one comment block)
test/postgres/inventory-posting.test.ts                       (one test name, one doc comment)
test/evidence/posting-kernel-admission.expected-red.json      (one claim string, one kill name)
```

**The lane's read, offered as a recommendation the orchestrator rules on:** a
fourth fresh-naive arm is not worth its cost. It would review a tree whose
behaviour no arm has found fault with, and `review-tiers` warns that a review
which keeps finding the same class is a mis-scoped charter rather than broken
code — here the classes were different each time and have now been closed in
turn. **What the lane cannot do is certify its own work**, so if the
orchestrator wants the byte-identity claim checked by someone other than its
author, the proportionate instrument is a NARROW CONFIRM on that one question —
the precedent is `PUR-2b` round 2 — and the prompt is below. It is not a fresh
naive arm and must not be run as one.

## Pasteable narrow-confirm prompt, if the orchestrator wants one

```text
You are a NARROW CONFIRM reviewer for Critical packet posting-kernel-admission
in /home/rvham/2rain-greenfield. This is not a fresh-naive arm and its scope is
one question.

Round 3 reviewed <ROUND_3_SHA> and returned REVISE on a single claim/evidence
mismatch: A3's wording claimed every posting is floored, while the floor runs on
the path that appends movements and `findNaturalReplay` returns above it. The
correction was to narrow the claim rather than change behaviour.

Confirm exactly this: that the correction is wording only, and that the narrowed
statement is true of the code.

Review <FROZEN_SHA> against <ROUND_3_SHA>; verify the supplied git ls-remote
line first. Work read-only; do not run the matrix or invoke another reviewer.

THE TWO QUESTIONS:

1. Is production BEHAVIOUR byte-identical between the two trees? The lane claims
   the executable delta is one comment block in inventory-posting-service.ts,
   one test name plus one doc comment in inventory-posting.test.ts, and one
   claim string plus one kill name in the packet's expected-red manifest. Check
   the diff yourself and say plainly if anything else moved.

2. Is the narrowed claim TRUE? It now reads: before a posting appends
   inventory movements, its sampled `recordedAt` is at least the newest
   persisted `recordedAt` for every affected stock identity. The lane also
   asserts three supporting facts -- a natural-effect replay appends no
   movement; `insertReceipt` writes the replayed result's `recordedAt`, which is
   the original posting's instant; and the 23505 raced-replay branch is below
   the floor and does pass it. Test each.

Return PASS or REVISE. You are NOT asked to re-review R1, R2, R3, A2 or A6 --
three arms have. If you nonetheless see something material in them, say so; the
lane has fenced nothing and this narrowing is the orchestrator's scope, not a
limit you may not question.
```
