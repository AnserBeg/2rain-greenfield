# PUR-2c — the goods receipt and its posting

**STOPPED AT THE CHARTER'S STOP CONDITION, BEFORE ANY DESIGN.** The charter
required the stop condition to be tested first and named the outcome if it
fired: *"Do not build the receipt on top of it and do not fix the compiler
inside this packet. The enum-transition element is its own packet."* It fired.
Nothing was designed, no product edit was made, and the working tree carries no
executable delta.

- **Tier:** Critical. **Evidence band:** A (the subject is a released storage
  contract; a divergence between it and the database is silent until an INSERT
  fails).
- **Branch:** `packet/pur-2c`, cut from `main` at
  `8c417528db942f0a504c7744e56f816e770702c7`.
- **Stops:** 1 (this one). The cap is two before re-scope.
- **Diff:** narrative only. Per `mission-cadence`, *"a packet whose diff is
  narrative-only declares nothing and owes no block"* — there is no
  `record-claim` block below, and that absence is the declaration.

## 1. Two corrections to the charter, both measured

1. **The base SHA `8c417521` does not resolve.** `main` is
   `8c417528db942f0a504c7744e56f816e770702c7`; the charter's eighth digit is a
   typo for `8`. The branch was cut from the real commit, which is the one the
   charter's prose describes ("charter PUR-2c, and correct two lane rows stale
   by five weeks").
2. **A goods-receipt family needs new options on TWO enums, not three.** The
   charter names `inventory_transaction_type`, `inventory_posting_role` "and
   the movement kind" as three separate enums. There is no third.
   `resolvePostingFamilies` takes exactly two `FieldBinding` arguments —
   `movementPostingRoleField` and `transactionTypeField` — and a role's
   `movementOption` is resolved against the **same** `inventory_posting_role`
   field as its `postingRole`. `packages/domain/src/inventory/definition.ts`
   declares seven enumerations in total and only these two are in play. The
   correction does not change the outcome: both refuse identically.

## 2. The stop condition — MEASURED, and it FIRED

The charter asked what happens when an option is added to an enum on an
already-released inventory entity: a permitted widening, an unhandled
transition, or a silent no-op that diverges the compiled contract from the
database. **It is an unhandled transition. Both gates refuse, loudly.**

### 2.1 Probe 1 — `inventory_transaction_type`

One throwaway option (`throwawayProbeOption`) added to the enumeration,
`app.authored.json` regenerated, `build:app-release` run:

```
COMPILER_STORAGE_RETYPE_UNSUPPORTED
  phase:               postLoweringValidation
  path:                $.fields.fieldType
  subjectId:           northstar.app:field.inventory_transaction_type
  rule:                v1 storage transitions do not retype existing physical columns
  acceptedAlternative: preserve the existing field type or defer retyping to a
                       future governed evolution family
```

`check:app-release` then failed separately with *"compiled application release
is stale; run pnpm --filter @north-star/web build:app-release"* — so the
refusal is caught twice, on two different gates, and there is **no silent
divergence at the artifact layer**.

### 2.2 Probe 2 — `inventory_posting_role`

The same edit on the other enum hits an **earlier** guard first:
`INVENTORY_CONTRACT_INVALID` at `$.fields.inventory_movement_posting_role`,
raised by the compiler's inventory conformance cells. Those cells are inside
this packet's lease ("the pinned cells those widenings move"), so the probe
widened both of them — `INVENTORY_POSTING_ROLES` and the
`inventory_movement_posting_role` option list in
`packages/compiler/src/conformance.ts` — and re-ran. Underneath the conformance
guard sits the identical refusal:

```
COMPILER_STORAGE_RETYPE_UNSUPPORTED
  path:      $.fields.fieldType
  subjectId: northstar.app:field.inventory_movement_posting_role
  rule:      v1 storage transitions do not retype existing physical columns
```

**Both enums, one verdict.** The conformance pins are a second fence in front
of the first, not an alternative path around it.

### 2.3 Why it refuses, and why the refusal is a FALSE NAME for a REAL problem

`lowerColumn` computes `shapeFingerprint` over a record that includes
`fieldType` **wholesale**, and an enum's `fieldType` carries its `options`
array. The transition planner refuses when
`oldField.shapeFingerprint !== field.shapeFingerprint`. So any option-list
change — including a pure widening — presents as a retype.

Measured against the real released target and a real candidate target:

```
previous postgresqlType : text
candidate postgresqlType: text
postgresqlType identical: true          <-- NOT a retype in the SQL sense
fingerprint identical   : false         <-- but the fingerprint moved
prev enumOptionIds      : 5
cand enumOptionIds      : 6
```

The diagnostic's name is wrong for this case. **The underlying obstacle is
real anyway, and it is not the column type.**

### 2.4 The finding that matters most: relaxing the fence alone would be unsafe

**CLAIM NARROWED AT ROUND 2, and the narrowing is the honest correction rather
than a concession.** The round-1 record called this a completed Band A
measurement. It is not. What follows separates what was **observed** from what
is **inferred from exact source**, because a Band A claim about a released
storage contract may not rest on the second.

The obvious reading of §2.3 — "it is only a fingerprint artifact, loosen the
comparison for additive enum widening" — is wrong, and dangerously so.

**Read from source (not executed).** The enum option list is materialised into
a physical CHECK constraint. `enumCheckExpression` in
`packages/postgres-provider/src/module-storage-materializer.ts` renders
`"col" = ANY (ARRAY['opt1', 'opt2', ...])` — exact membership in the compiled
`enumOptionIds`. The constraint's physical name comes from
`physicalNameFor('constraint', `${field.fieldId}/enum-domain`)` — **from the
field id alone, never from the option list.** So a widened enum yields a
constraint with the *same* name and *different* contents.

**OBSERVED, by executing the real planner.** Both storage targets were lowered
from the real authored artifacts, the previous target's column fingerprint was
patched to match the candidate's — bypassing *only* the retype fence and
leaving both `checkConstraints` exactly as lowered — and
`buildStorageTransitionEnvelope` was called directly:

```
=== ENUM-DOMAIN CHECK CONSTRAINT ===
previous physicalName : nsm_k_pzh74vuhd34vzzizxtyfaptvkmgal53j45qg5kgxzjeacf53qn4a
candidate physicalName: nsm_k_pzh74vuhd34vzzizxtyfaptvkmgal53j45qg5kgxzjeacf53qn4a
physicalName identical: true
previous options      : 5
candidate options     : 6

=== PLANNER, RETYPE FENCE BYPASSED ===
elements emitted: 0
elements naming the enum-domain check or the field: 0
```

**Zero elements.** The planner's check loop is
`if (oldChecks.has(check.physicalName)) continue;`, keyed on a name that did
not move, so the widened constraint is skipped.

**The round-2 reviewer independently confirmed both the attribution and the
fidelity of the bypass from source**, and added the reason the bypass is
faithful rather than an artifact: the later planner path never consults the
column fingerprint again and never reconciles old against new
`fieldContract.enumOptionIds`, so a production special case admitting enum
supersets would reach the same name-only CHECK loop. The probe object is
internally inconsistent, but no downstream planner branch observes the
inconsistency.

**INFERRED FROM EXACT SOURCE, NOT OBSERVED — and this is the gap.** That a
release carrying a widened enum would *activate* and then be *rejected by the
old physical CHECK* is a chain this packet did not execute:

- the materializer's enum helper looks up an existing constraint by table and
  name and returns **without inspecting its definition**;
- a `NO_STORAGE_TRANSITION` preparation is accepted with executor state
  `NOT_REQUIRED`;
- activation verification treats module-schema conformance as satisfied when
  `module_transition` is false.

Each of those is read from source. **None was run.** No PostgreSQL was
reachable — Docker does not start on this machine — so the failing INSERT that
would make this a Band A observation was never produced.

**Stated at the strength the evidence actually supports:** *an additive enum
widening admitted past the retype fence produces no transition element
(observed), and the source path from there to an activated release whose
tenant still enforces the old exact-membership CHECK is exact and unbroken
(read, not executed).*

### 2.4b The observing probe this packet OWES, written out so it is not re-derived

The round-2 reviewer specified the minimum probe that would convert §2.4 from a
source-confirmed failure path into a Band A observation. It is recorded here in
full because the follow-on packet inherits it, and because a probe named
vaguely is a probe nobody runs:

1. Materialize the previous release in PostgreSQL.
2. Confirm the old CHECK definition from `pg_constraint`.
3. Compile the widened candidate with **only** the enum-retype guard bypassed.
4. Prepare and activate it through the real release path.
5. Confirm activation reports **no** module transition.
6. Confirm the physical CHECK definition is **unchanged**.
7. Insert an old option successfully, and the newly admitted option
   **unsuccessfully**.

**Its controls, which are the half that makes it evidence rather than a
demonstration:** a narrowing, an option removal or option-ID rebinding, and an
unrelated ordinary field retype. **The last two must remain refused** — a probe
that only shows the widening slipping through cannot distinguish "the fence has
a hole for supersets" from "the fence stopped working".

**Blocked on Docker, not on design.** Every step is expressible against
`test/postgres/**` today.

### 2.5 What is therefore OWED by the follow-on packet

**SCOPE CORRECTED AT ROUND 2.** The round-1 record named three deliverables —
a fingerprint predicate, a transition element, and materializer DDL with a
control. The reviewer ruled that underscoped, and the ruling is right: it
stopped at the planner and one DDL operation, and **said nothing about the
catalog-comparison and activation-verification contract**, which is where the
silent divergence in §2.4 actually becomes invisible. A packet built to the
round-1 list could ship a correct `ALTER TABLE` and still activate a release
before the widened definition was physically present.

The three deliverable **groups**, and shipping fewer than three is the unsafe
outcome:

1. **Compiler and protocol semantics.** Recognise **only a monotonic
   enum-option superset** as a widening; emit an explicit transition element
   for it; and **preserve the existing refusals** for narrowing, option
   removal, option-ID rebinding, physical-type changes, and unrelated retypes.
   The predicate is the deliverable, not merely a loosened comparison.
2. **Provider, live-target, catalog, and activation semantics.** Replace the
   same-named CHECK safely and idempotently; define retry and recovery
   behaviour; make expected-catalog comparison understand that this definition
   change is *intentional*; and ensure **activation cannot report conformance
   before the widened definition is physically present**. This group is the one
   the round-1 list missed entirely.
3. **Band A PostgreSQL evidence.** Start from a real previous release **with
   existing rows**; execute preparation and activation; inspect the catalog;
   prove old and new values both work afterwards; prove the narrowing and
   tampered-transition controls red; and exercise retry/recovery. §2.4b is the
   floor, not the ceiling.

This is the same shape as `relation-requiredness-relaxation`, which stood
between `PUR-2a` and its own gate, and it wants its own Critical charter for
the same reason: a wrongly-planned DDL against a live tenant is a Band A
failure. **The reviewer independently agreed the separate Critical charter is
proportionate and that the receipt lane must not take it as a bridge.** Routed
as `enum-option-widening-unplannable`.

### 2.6 Alternatives considered, and why each fails

Recorded at round 2 because the reviewer ruled the lane owed the orchestrator a
list — not to exhaust every redesign after an explicit stop fired, but so the
orchestrator can decide whether to charter a *different architecture* instead
of the enum transition. The reviewer's own analysis agreed with each rejection:

| Alternative | Why it fails |
|---|---|
| `--truncate-invalid-lineage` | Discards valid release history to bypass a **correct** compatibility refusal. `PUR-2a` already declined this use for the same reason. |
| Reuse an existing option (e.g. `adjustment`) for goods receipt | Aliases two semantically different posting families. Avoids the storage question by corrupting the contract vocabulary. |
| Add a distinct field rather than widen the enum | Technically additive, but defines a new physical **and semantic** contract. A design fork, not an enum-widening mechanism. |
| A separate entity, or changed movement lineage | Possibly a viable future architecture, but it reopens the posting-family decision `PUR-2a` settled. Cannot be smuggled in as a workaround. |
| An existing governed evolution family | None handles replacement of an existing enum CHECK. Checked. |

## 3. What was NOT done, and why each was left

- **No goods receipt.** `goods_receipt` remains absent from the codebase except
  as the negative assertion at `test/unit/purchasing-definition.test.ts:1172`.
  Verified unchanged.
- **No ruling on `received_quantity`. It is DEFERRED WITH A NAMED OWNER, not
  declined and not discharged.** The charter made it the point of the packet and
  allocated ADR-0064. Plan §7.12 does not merely assign the decision to a packet
  name — it names the two arms (a **stored** value for the compare-and-swap
  route, a **derived** read model for the lock-and-sum route) and expressly
  declines to choose between them without the posting mechanism in hand.
  `PUR-1` dropped the field for exactly that reason. The posting protocol is
  what is blocked, so ruling it now would choose a persistence model without the
  concurrency evidence the plan requires, and `SAL-2`'s shipped-quantity mirror
  would inherit that choice.

  **The disposition, stated so no later reader can mistake it for a discharge:**

  > *Deferred because its governing posting protocol is blocked. It must be
  > decided when `PUR-2c` resumes after the enum-transition prerequisite lands.*

  **It does NOT move into the enum-transition charter** — that packet is a
  compiler and provider packet and has no posting protocol to reason from.
  **ADR-0064 is left free** for whoever rules it. The absence assertion at
  `test/unit/purchasing-definition.test.ts:1169` is untouched, so the door is
  still visibly open, and the comment beside it still says the absence *is* the
  decision being left open. **The round-2 reviewer accepted this disposition
  conditionally — "provided the decision remains an explicit blocked deliverable
  of the resumed receipt packet" — and could not verify from the unreachable
  record whether the obligation was preserved or merely declined. This paragraph
  is what preserves it**, and it is mirrored in the ledger row and the lane row
  so it survives even if this record is not read.

- **The other three §7.17 rulings** (amend-below-received, the receive-100 /
  ship-80 / found-60 guidance, `allowWithFlag` for corrections, and what closes
  an order) are all downstream of the receipt existing. Left unruled.
- **No migration.** `0024` was never cut, so the nine migration-pin sites and
  `db/schema.snapshot.json` are untouched, and the inherited
  `migration-range-encoded-in-a-test-title` obligation **does not transfer** —
  it names "whoever cuts 0024" and nobody did. `trust-substrate.test.ts:63`'s
  title remains stale by one digit, still owned by the next packet to cut a
  migration.
- **No `test/postgres/goods-receipt.test.ts`** and **no
  `test/evidence/pur-2c.expected-red.json`**. A Band A evidence manifest with
  no subject would be a manifest of nothing.
- **The §7.16 carried obligation** — proving the posting catalog is the exact
  active-release artifact — is untouched and still owed by whichever packet
  lands the second family.

## 4. The working tree, and how the probes were reverted

Every probe was reverted and the tree verified clean by `git status
--porcelain` after each. The two probe artifacts that were *not* written into
the repository at all — the probe `app.authored.json` and the planner harness —
were generated into the session scratchpad via
`NORTH_STAR_APP_AUTHORED_PATH`, so `apps/web/release/**` was restored to its
committed bytes rather than regenerated.

`git stash` was used once, for probe 2, and dropped **by explicit ref**
(`git stash drop "stash@{0}"`) after its finding was recorded. Three other
lanes' stashes sit below it in the stack and were not touched.

**The measurement in §2.4 required no compiler source edit.** It patched a
lowered target in memory inside a throwaway script, which is why
`packages/compiler/src/storage.ts` — outside this lease — has no delta and
never did.

## 5. Gates

The tree is byte-identical to `main` except for narrative files — verify with
`git diff --stat main -- . ':(exclude)docs/**'`, which is empty — so the
executable gates are inherited. These were run:

| Gate | Result |
|---|---|
| `pnpm format` | **PASS** |
| `pnpm typecheck` | **PASS** |
| `check:app-release` | **PASS** on the restored tree (measured red under both probes, green before and after) |
| `scripts/check-records.sh` | **PASS** — `records: OK (137 records, 158 ledger rows, ids unique)` |
| `test:architecture` | **DID NOT REACH A VERDICT — see below. Not claimed.** |

### `test:architecture` — attempted, measured, and NOT dischargeable here

Round 1 ruled this the one suite a narrative diff perturbs, since it reads
`docs/**`, and required it at the head. **It was attempted under a 25-minute
bound and it did not finish.**

```
15 ok
 4 not ok   — all four Docker-dependent, in dependency-boundaries.test.ts:
   not ok 16 - ephemeral PostgreSQL is removed after harness kill -9
   not ok 17 - ephemeral PostgreSQL is removed after harness SIGINT
   not ok 18 - ephemeral PostgreSQL is removed after harness SIGTERM
   not ok 19 - ephemeral PostgreSQL is removed after an uncaught harness exception

last log write 11:09:08 · killed by the bound 11:33:59 · EXIT=124
```

The underlying cause is visible in the output: the harness shells out to
`docker run ... postgres@sha256:...` and gets *"The command 'docker' could not
be found in this WSL 2 distro."* Measured this round:
`/mnt/wsl/docker-desktop` does not exist and the `docker` binary is absent.

**It ran for roughly 35 seconds, emitted 19 results, then stalled for 24
minutes without producing a summary line.** `EXIT=124` is the bound killing it,
not a suite verdict.

**This refines a standing belief in this repository rather than confirming it.**
The recorded assumption is that the architecture suite *never fails and waits
forever* without Docker. Measured: it **does** fail — four tests, by name — and
*then* stalls. Both halves matter. A future lane that runs it bounded and sees
four named failures should not read that as a verdict, and one that sees no
summary should not read that as "it never started".

**The lane does not claim this gate**, and round 1's P2 finding stands open
against this record. It is owed at the reviewed head on a machine with Docker:

```bash
corepack pnpm test:architecture
```

**Docker also blocks `test:postgres`, `test:browser`, the full matrix, and
§2.4b — the one probe that would convert §2.4 into a Band A observation.** No
green was carried forward from any suite that was not run.

## 6. Acceptance criteria (R4 — gate-invisible deliverables named explicitly)

No gate can see any of these, which is why they are written as criteria:

1. The stop condition was tested **before** any design, and the measurement is
   reproducible by a reader from §2 alone.
2. The refusal is reported with its **real** cause (`shapeFingerprint` covers
   `fieldType` wholesale) rather than its diagnostic's name (`retype`).
3. **The unsafe shortcut is measured and named**: relaxing the fence alone
   emits zero elements and diverges the contract from the database. A follow-on
   packet that reads only the diagnostic would take exactly that shortcut.
4. The follow-on scope is stated as three concrete deliverables (§2.5), not as
   "fix the compiler".
5. Every ruling the charter asked for is either made or **explicitly declined
   with a reason** (§3) — none is silently dropped.
6. The two charter errors are corrected in writing (§1) so the next charter
   does not inherit them.

## 7. Test it yourself

Under ten minutes, no diff reading required. From the repository root on
`packet/pur-2c`:

**A. Confirm the tree is clean and the app still compiles (~1 min).**

```bash
git status --porcelain && corepack pnpm check:app-release && echo "CLEAN AND GREEN"
```

Expect no file listing and `CLEAN AND GREEN`.

**B. Reproduce the refusal yourself (~3 min).** Add one option to the released
enum, regenerate the authored artifact, and compile:

```bash
python3 - <<'EOF'
p = 'packages/domain/src/inventory/definition.ts'
s = open(p).read()
old = "          'countCorrection',\n          'reBaseline',\n        ]),"
new = "          'countCorrection',\n          'reBaseline',\n          'youJustAddedThis',\n        ]),"
assert s.count(old) == 1
open(p, 'w').write(s.replace(old, new))
print('option added')
EOF
```

```bash
node --import tsx apps/web/scripts/generate-app-authored.ts && corepack pnpm --filter @north-star/web build:app-release
```

Expect the second command to FAIL with `COMPILER_STORAGE_RETYPE_UNSUPPORTED` on
`northstar.app:field.inventory_transaction_type`. **That refusal is the entire
reason this packet stopped.**

**C. Put it back (~30 s).**

```bash
git checkout -- packages/domain/src/inventory/definition.ts apps/web/release/app.authored.json && git status --porcelain && echo "RESTORED"
```

Expect no file listing and `RESTORED`.

**D. Read, rather than run, the two things a gate cannot show you.** §2.4 above
— why the obvious fix is the dangerous one — and §3, the list of rulings
deliberately not made. If you disagree with declining the `received_quantity`
ruling, that is the one decision in this packet worth overturning, and §3 says
exactly why it was declined.

## 8. Round 2 — the REVISE verdict and what each finding changed

**Round 1 returned REVISE.** The reviewer did **not** refute the compiler
finding — it independently confirmed the causal diagnosis from source and
confirmed that the §2.4 fingerprint bypass is faithful rather than an artifact,
adding the reason: the later planner path never consults the column fingerprint
again and never reconciles old against new `enumOptionIds`, so a production
special case admitting enum supersets would reach the same name-only CHECK loop.

Four findings, and what each changed:

| # | Finding | Disposition |
|---|---|---|
| P1 | **The frozen candidate is unreachable** — `packet/pur-2c` is not on the connected GitHub repository, so nothing in the record could be verified | **FIXED.** The branch is pushed; the round-2 prompt quotes `git ls-remote`. Round 1 disclosed the branch was unpushed and left the push to the user; that was insufficient, because a review cannot open on an unfetchable target at all. |
| P1 | **§2.4 stops before the Band A boundary** — the database consequence is inferred from exact source, not observed | **CLAIM NARROWED, and the probe written out.** §2.4 now separates observed from read-not-executed and states the finding at the strength the evidence supports. §2.4b records the reviewer's seven-step observing probe **and its three controls** verbatim, so the follow-on packet inherits it rather than re-deriving it. **It cannot be run here — Docker does not start — and that is stated rather than worked around.** |
| P1 | **The follow-on scope is underscoped** — "element plus DDL" omits the catalog-comparison and activation-verification contract | **SCOPE CORRECTED.** §2.5 is rewritten as three deliverable *groups*. The round-1 list was genuinely narrower: it said nothing about expected-catalog comparison understanding an intentional definition change, nor about activation being unable to report conformance before the widened definition is physically present. That second group is exactly where the §2.4 divergence hides. |
| P2 | **`test:architecture` unrun**, and it is the one suite a narrative diff perturbs | **ATTEMPTED AND MEASURED; IT CANNOT BE DISCHARGED ON THIS MACHINE, and the finding therefore STANDS OPEN.** The suite was run under a 25-minute bound. It produced 19 results — 15 `ok`, 4 `not ok`, all four the Docker-dependent ephemeral-PostgreSQL leak-guard tests in `dependency-boundaries.test.ts` — and then **stalled for 24 minutes without reaching a verdict**, killed by the bound at `EXIT=124`. See §5. The lane is not claiming this gate. |

**Two steering defects in the round-1 prompt, both accepted and both fixed in
§10.** The reviewer found that the prompt (a) presented the §7B probe as already
verified and defined PASS around acceptance of the lane's causal chain, and
(b) made planner output look like the decisive endpoint when the decisive path
runs through transition classification, preparation receipts, the materializer,
live catalog comparison, activation verification, and a real PostgreSQL
constraint. **The second is the serious one: reading only the compiler would
have produced an unjustified PASS.** The round-2 prompt names the full path as
the subject and does not define what a PASS should conclude.

**Not changed, and why.** The reviewer agreed the stop was correct, agreed the
separate Critical charter is proportionate, agreed Mechanical is the right diff
tier while the *claim* crosses a Band A boundary, and accepted the
`received_quantity` deferral **conditionally** on the obligation remaining an
explicit blocked deliverable of the resumed receipt packet. §3 now states that
obligation in those terms, and it is mirrored into the ledger and lane rows so
it survives this record going unread.

**Stops: still 1.** Round 2 revises a record; it did not discover new scope.

## 9. Proposed next packets

Not started; the cadence forbids continuing. Presented for selection:

| ID | Outcome | Tier | Why it is or is not next |
|---|---|---|---|
| `enum-option-widening` | The missing storage-transition element for an additive enum widening: the fingerprint predicate, the CHECK-replacement element, its materializer DDL, and the control proving the constraint actually widened in a live database | Critical | **Recommended.** It is the strict prerequisite for `PUR-2c` and for every future family. It also closes a latent silent divergence that exists today independently of purchasing. Wants Docker for its Band A control. |
| `PUR-2c` (re-charter) | The goods receipt, unchanged in intent, re-cut once the element above lands | Critical | Blocked on the above. Its charter should carry §1's two corrections and drop the `received_quantity` ruling into its own decision step rather than making it the first product edit. |
| `received-quantity-ruling` | ADR-0064 alone: stored CAS column versus derived sum under lock, ruled for `PUR-2` and `SAL-2` together | Behavioral | Possible now and deliberately **not** recommended: plan §7.12 gives the decision to the posting protocol, which does not exist yet. Worth selecting only if the user wants the door shut early on other grounds. |

## 10. Online review prompt (round 2) — paste this

> *This prompt was written by the lane whose work you are reviewing. **The lane
> has fenced nothing.** Any scope stated here is the orchestrator's, and it
> stands as a claim under test rather than a limit you may not question. Read
> whatever you judge relevant to the decisive questions, say plainly if you think
> the scope is drawn wrongly, and say plainly if the prompt itself is steering
> you.*

**ROUND 2.** Round 1 returned REVISE with four findings. It did not refute the
compiler finding — it confirmed the causal diagnosis and the bypass fidelity
from source — and it required: a fetchable target, a narrowed §2.4 claim with
the observing probe written out, a corrected follow-on scope, and
`test:architecture` at the head. §8 of the record tracks each finding to its
disposition. **Round 1 also found the prompt itself steering in two ways; both
are corrected below and you should check whether the correction took.**

**Repository:** `github.com/AnserBeg/2rain-greenfield`. **Branch:**
`packet/pur-2c`. **Frozen SHA:** `4c68e4c21fbfa9ff4656aa30af4f7185d2498c7a`.
**Delta to read:** `8c417528db942f0a504c7744e56f816e770702c7..packet/pur-2c`.

```
$ git ls-remote origin refs/heads/packet/pur-2c
4c68e4c21fbfa9ff4656aa30af4f7185d2498c7a	refs/heads/packet/pur-2c
```

**Round 1 could not open the target at all** — the branch was unpushed. It is
pushed now, and the `git ls-remote` output above is quoted from this machine
after that push.

**About the head, so it is not a surprise.** `4c68e4c` is the commit carrying
this record complete. A prompt cannot name its own hash, so the branch head sits
**one commit above it**, and that commit's entire content is the SHA line, this
paragraph, and the `ls-remote` block. Both SHAs are on the remote.
`git log --oneline 4c68e4c..packet/pur-2c` shows exactly one narrative commit
and `git diff 4c68e4c..packet/pur-2c` shows only this section — **verify that
rather than take it.** Review the branch head. No executable byte differs
anywhere in this range, or between it and `main`.

**Tier: Mechanical by the diff — zero executable bytes change.** Verify with
`git diff --stat main -- . ':(exclude)docs/**'`, which should be empty. Round 1
agreed Mechanical is right for the diff while noting the *claim* crosses a
Band A boundary, so a Mechanical diff tier does not license planner-only
evidence. The lane has narrowed the claim accordingly; whether the narrowing is
now honest is question 1.

### The subject of this review is a chain, not a compiler function

**Round 1's most important scope finding, restated here because the lane got it
wrong the first time:** the decisive path is not the planner's output. It runs
through transition classification, preparation receipts, the materializer, live
catalog comparison, activation verification, and a real PostgreSQL constraint.
**Reading only the compiler would produce an unjustified PASS.** The lane has
executed exactly one link of that chain and reads the rest from source; §2.4
now says which is which.

### The decisive questions

1. **Is §2.4's narrowed claim now correctly bounded?** It separates *observed*
   (the planner emits zero elements, executed) from *inferred from exact source,
   not observed* (materializer constraint lookup by name, `NO_STORAGE_TRANSITION`
   preparation accepted as `NOT_REQUIRED`, activation treating conformance as
   satisfied when `module_transition` is false). Does the narrowed statement
   still overreach anywhere? Does it now *under*-claim — is some link actually
   observed that the record concedes as merely read?
2. **Is §2.4b the right probe, and are its controls sufficient?** It records
   round 1's seven-step observing probe and three controls (a narrowing, an
   option removal or option-ID rebinding, an unrelated ordinary field retype —
   the last two must remain refused). Would running exactly that convert this
   into a Band A observation, or does it still leave a hole?
3. **Is §2.5's corrected scope right?** Three groups now: compiler/protocol
   semantics with a monotonic-superset predicate and preserved refusals;
   provider/live-target/catalog/activation semantics; Band A PostgreSQL
   evidence. Round 1 ruled the previous "element plus DDL plus tests" list
   underscoped. Is the correction sufficient, or still missing a boundary?
4. **Is §2.6's alternatives table complete and are its rejections sound?** It
   rejects `--truncate-invalid-lineage`, option reuse, a distinct field, a
   separate entity or changed movement lineage, and existing governed evolution
   families. Is there an alternative architecture the orchestrator should be
   offered instead of chartering the enum transition?
5. **Is the `received_quantity` deferral preserved as a real obligation?** §3
   states it as *"deferred because its governing posting protocol is blocked;
   must be decided when `PUR-2c` resumes"*, keeps ADR-0064 free, and mirrors the
   obligation into the ledger and lane rows. Round 1 accepted the deferral
   conditionally on exactly this. Does the record now discharge that condition,
   or does it still read as a decline?
6. **Was stopping correct?** Round 1 said yes. It is restated as a question
   rather than dropped, because the lane should not carry a prior round's
   agreement forward as settled.

### What the lane did NOT verify — read this before trusting anything above

- **§2.4b was NOT run. Docker does not start on this machine** — measured this
  round: `/mnt/wsl/docker-desktop` does not exist and the `docker` binary is
  absent from the distro. So `test:postgres`, `test:browser` and the full matrix
  did not run, and **the failing INSERT that would make §2.4 a Band A
  observation was never produced.** This is the packet's weakest link and it is
  unfixable on this machine.
- **`test:architecture` STILL DOES NOT PASS, and round 1's P2 finding stands
  open.** It was attempted this round under a 25-minute bound: 19 results (15
  `ok`, 4 `not ok` — all four Docker-dependent leak-guard tests), then a
  24-minute stall and `EXIT=124` from the bound. **It never reached a verdict**,
  so the lane cannot and does not claim this gate. §5 carries the numbers.
- **The materializer, preparation, catalog-comparison and activation claims are
  read from source, never executed.** Round 1 verified them independently from
  source too — but two source readings are still not an execution.
- **The conformance widening in probe 2 was not reviewed for completeness.** The
  lane widened two cells to reach the storage layer; whether those are the only
  two a real goods-receipt family moves is unmeasured.
- **Whether any other artifact enumerates the option list** — a projection, a
  read model, an agent catalog — such that a widening would break it was **not
  investigated at all.** Round 1 raised it; the lane has not closed it.
- **The §7B copy-paste probe was executed by the lane on this machine** and is
  reported as such. Round 1 correctly objected that the round-1 prompt presented
  it as *verified* in a way that invited acceptance rather than checking. Treat
  it as a claim: run it yourself, or say it is unreproducible.

### Reading list

`AGENTS.md` §6 · `.agents/skills/review-tiers/SKILL.md`, starting at *"Does the
evidence prove the claim? — the checklist"*, opening a section only when a row
fires · `.agents/skills/mission-cadence/SKILL.md`, stop conditions and stop
convergence (this remains stop 1 of 2) ·
`docs/execution/current-plan.md`, row `relation-requiredness-relaxation-
unplannable`, the precedent this stop is modelled on ·
`docs/greenfield-north-star-erp-platform-plan.md` §§7.12, 7.16, 7.17.

### On the verdict

**The lane does not state what a PASS would mean.** Round 1 found that the
round-1 prompt defined PASS around acceptance of the lane's own causal chain,
which is the reviewed party steering its own verdict. The questions above are
the scope; the conclusion is yours.
