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

### 2.4 The finding that matters most: relaxing the fence alone would be UNSAFE

The obvious reading of §2.3 — "it is only a fingerprint artifact, loosen the
comparison for additive enum widening" — was tested and is **wrong**.

The enum option list is materialised into a physical CHECK constraint.
`enumCheckExpression` in
`packages/postgres-provider/src/module-storage-materializer.ts` renders
`"col" = ANY (ARRAY['opt1', 'opt2', ...])`, and the constraint's physical name
is derived from `physicalNameFor('constraint', `${field.fieldId}/enum-domain`)`
— **from the field id alone, never from the option list.** So a widened enum
produces a constraint with the *same* name and *different* contents.

The planner's check loop is `if (oldChecks.has(check.physicalName)) continue;`,
keyed on that name. Prediction: it skips the widened constraint entirely.

**Measured, not predicted.** Both storage targets were lowered from the real
authored artifacts, the previous target's column fingerprint was patched to
match the candidate's — bypassing *only* the retype fence and leaving both
`checkConstraints` exactly as lowered — and `buildStorageTransitionEnvelope`
was called directly:

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

**Zero elements.** Had the fence been relaxed, the compiled contract would
advertise the new option while the database kept its old five-value CHECK. The
release would verify, the app would activate, and the *first goods receipt an
operator posted* would fail on a check-constraint violation the compiled
contract said could not happen.

**That is precisely the third arm of the charter's question — the silent
divergence — and it is latent one edit away.** The `COMPILER_STORAGE_RETYPE_-
UNSUPPORTED` fence is currently the only thing preventing it. It refuses for a
reason it states wrongly, but it refuses, and removing it without building the
missing element would convert a loud compile-time refusal into a silent
contract/database divergence.

**This is the packet's product.** Finding it cost one afternoon and no
authored document; meeting it after `goods_receipt`, `goods_receipt_line`, a
posting family, a migration and a receipt surface had been built would have
cost all of that plus the discovery.

### 2.5 What is therefore OWED by the follow-on packet

Three things, and shipping fewer than three is the unsafe outcome above:

1. A `shapeFingerprint` comparison (or an explicit predicate beside it) that
   distinguishes an **additive** enum-option widening from a genuine retype,
   in `packages/compiler/src/storage.ts`.
2. A **new storage transition element** that replaces an existing
   `enumDomain` CHECK constraint — the planner has `addNotValidConstraint` for
   constraints that are *absent*, and nothing for one whose contents moved.
3. Its **DDL in the materializer**, plus the negative control proving the
   element is emitted and the constraint actually widened in a live database.

This is the same shape as `relation-requiredness-relaxation`, which stood
between `PUR-2a` and its own gate, and it wants its own Critical charter for
the same reason: a wrongly-planned DDL against a live tenant is a Band A
failure. Routed as `enum-option-widening-unplannable`.

## 3. What was NOT done, and why each was left

- **No goods receipt.** `goods_receipt` remains absent from the codebase except
  as the negative assertion at `test/unit/purchasing-definition.test.ts:1172`.
  Verified unchanged.
- **No ruling on `received_quantity`, and this is a deliberate refusal rather
  than an omission.** The charter made it the point of the packet and allocated
  ADR-0064. Plan §7.12 says the *posting protocol* decides stored-versus-derived,
  and `PUR-1` dropped the field precisely so that protocol could decide it. The
  posting protocol is what is blocked. Ruling it now — with `SAL-2`'s
  shipped-quantity mirror inheriting the choice — would rule a one-way door with
  strictly less information than `PUR-1` already chose to wait for, and would
  produce an ADR no gate could test. **ADR-0064 is left free for whoever rules
  it.** The assertion at `test/unit/purchasing-definition.test.ts:1169` is
  untouched, so the decision is still visibly open.
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

The tree is byte-identical to `main` except for narrative files, so the
executable gates are inherited rather than re-run, with two exceptions run to
confirm the tree is genuinely clean:

| Gate | Result |
|---|---|
| `check:app-release` | **PASS** on the restored tree (it was measured red under both probes, and green before and after) |
| `pnpm format` | run on the final tree — see the freeze section |
| `scripts/check-records.sh` | run on the final tree — see the freeze section |

**Docker does not start on this machine**, so `test:postgres`,
`test:browser`, `test:architecture` and the full matrix were not run. For a
narrative-only diff this is not a suppressed gate: `test:architecture` reads
`docs/**` and is therefore the one suite whose input this packet actually
changes. **It is OWED and unrun**, and the exact command is:

```bash
corepack pnpm test:architecture
```

No green was carried forward from any suite that was not run.

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

## 8. Proposed next packets

Not started; the cadence forbids continuing. Presented for selection:

| ID | Outcome | Tier | Why it is or is not next |
|---|---|---|---|
| `enum-option-widening` | The missing storage-transition element for an additive enum widening: the fingerprint predicate, the CHECK-replacement element, its materializer DDL, and the control proving the constraint actually widened in a live database | Critical | **Recommended.** It is the strict prerequisite for `PUR-2c` and for every future family. It also closes a latent silent divergence that exists today independently of purchasing. Wants Docker for its Band A control. |
| `PUR-2c` (re-charter) | The goods receipt, unchanged in intent, re-cut once the element above lands | Critical | Blocked on the above. Its charter should carry §1's two corrections and drop the `received_quantity` ruling into its own decision step rather than making it the first product edit. |
| `received-quantity-ruling` | ADR-0064 alone: stored CAS column versus derived sum under lock, ruled for `PUR-2` and `SAL-2` together | Behavioral | Possible now and deliberately **not** recommended: plan §7.12 gives the decision to the posting protocol, which does not exist yet. Worth selecting only if the user wants the door shut early on other grounds. |
