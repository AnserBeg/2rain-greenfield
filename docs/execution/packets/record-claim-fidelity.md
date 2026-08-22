# record-claim-fidelity — the record layer gets its first gate

Date: 2026-08-21
Base: `ba4304d0477784142442093c6783b20ae2f09424`
Branch: `packet/record-claim-fidelity`
Tier: Behavioral — the diff adds a gate over narrative records and changes no
product logic.
Status: **frozen for review.** All gates green at the frozen tip; the packet's
last executable commit is `cf219813189e22d50dac143162632f3881410e60` and every
commit above it is narrative.

## Why this exists

Two failures, one harness.

**The record layer says things nothing checks.** Program review R1
([2026-08-20](../program-reviews/2026-08-20-first-office-worker-slice.md))
measured it: *"The program has gated process rules three times
(`check-review-record.sh`, `check-origin-sync.sh`, `check-parked-work.sh`, each
with a hook) and the record layer zero times."* Its disposition is
`scripts/check-records.sh`, and that disposition was itself never entered in the
queue — which is R1 happening to R1.

**A frozen commit can claim work it does not contain.** From
[`ux-picker`](ux-picker.md), the packet's own words:

> `56762ce` touched two files; `surface-contract.ts` was byte-identical at base
> and head. The derived type and the validated-value return had never been
> committed... a one-off drift probe mutated the same file, measured 9 reds, and
> reverted with `git checkout -- <path>`. That revert goes to HEAD, so it
> destroyed the round's work along with the mutation — and nothing went red
> afterwards, because the previous round's implementation passes the same
> suites. The commit message described work the commit did not contain, and the
> reviewer found it by reading `git show --stat` rather than the report.

A reviewer caught that by luck. Nothing in the repository could catch it at all.

## The design constraint that decided everything

`AGENTS.md` §6: *"A gate must observe the fact it asserts, never a proxy for it.
Parsing a tool's output, inferring from a declaration, and matching a string are
proxies; reading an execution counter, a produced artifact, or a persisted
effect is observation."*

So the gate does **not** parse packet prose to discover what a packet claims.
The record declares its claims in a machine-readable block; the gate observes
those declarations against the git tree. Concretely:

- **A claimed path** is observed with `git diff --quiet <base> <head> -- <path>`.
  The exit status *is* the observation — 0 means byte-identical, 1 means
  changed. No output is parsed.
- **A claimed symbol** is observed by reading the blob at the declared head with
  `git show`, parsing it into a TypeScript AST, and asking whether the module
  declares that name. **A name that appears only in a comment or a string
  literal declares nothing**, and a committed control proves the gate agrees. A
  regex over source text would pass that control; this is why the reader is a
  parser and not a pattern.
- **Everything reads the frozen commits, never the working tree.** That is not
  incidental: the failure being closed is precisely a working tree that
  disagrees with the commit.

## Owned paths

| Path | Note |
|---|---|
| `scripts/check-records.sh` | new — the operator-facing gate |
| `test/architecture/record-claim-fidelity.ts` | new — the checker and its CLI |
| `test/architecture/record-claim-fidelity-controls.ts` | new — the sixteen committed controls |
| `test/architecture/record-claim-fidelity.test.ts` | new — CI wiring, via the `test:architecture` glob |
| `test/architecture/record-claim-fidelity.manifest.json` | new — the pinned known-absence set |
| `test/architecture/record-claim-fidelity-negative-control.ts` | new — the `ux-picker` r3 reproduction, runnable |
| `test/architecture/repository-hygiene.test.ts` | one line — the add-only shared test inventory that `lanes.md` names |

Verified free before starting, by measurement rather than from the partition
table. `lanes.md` mandates `git diff --name-only main...<branch>` over every
`packet/*` branch; run at `cf21981` across all 22, **none touches
`scripts/check-records.sh` or any `record-claim-fidelity*` file**.
`packet/expected-red-gate` touches `scripts/check-expected-red.sh` — a different
script, and R2's disposition rather than R1's. `packet/ps-2` and `packet/pur-1`
touch `repository-hygiene.test.ts`; both are parked, and that file is the
add-only shared inventory `lanes.md` rules re-derivable rather than
hand-merged. The live `test/architecture` grants are scoped to
`tenant-completeness*`, `surface-grammar-conformance`, `module-press-law`,
`release-persistence-boundary`, `test-reachability` and
`canonical-contracts-purity`, none of which this lane touches.

Out of scope and not taken: `.agents/skills/**` (making the declaration block
mandatory in `mission-cadence` is the orchestrator's edit and lands after this
gate does), backfilling the block into the other 124 packet records, and every
other program-review finding.

## This packet's own declaration block

The block below is the gate's own subject. `base` is where the branch was cut
from; `head` is this packet's **last executable commit**. Narrative commits
above `head` change no executable path, which is `git-workflow`'s identical-tree
rule, and the gate's range is closed at `head` for exactly that reason.

`scripts/check-records.sh` is claimed by path only. Shell functions are not
resolvable by the TypeScript reader, and the block refuses a symbol claim over a
non-TypeScript file rather than guessing at one — a narrowing recorded here
because it is a real limit, not an oversight.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "record-claim-fidelity",
  "base": "ba4304d0477784142442093c6783b20ae2f09424",
  "head": "cf219813189e22d50dac143162632f3881410e60",
  "changedPaths": [
    "scripts/check-records.sh",
    "test/architecture/record-claim-fidelity.ts",
    "test/architecture/record-claim-fidelity-controls.ts",
    "test/architecture/record-claim-fidelity.test.ts",
    "test/architecture/record-claim-fidelity.manifest.json",
    "test/architecture/record-claim-fidelity-negative-control.ts",
    "test/architecture/repository-hygiene.test.ts"
  ],
  "symbols": [
    { "path": "test/architecture/record-claim-fidelity.ts", "name": "verifyRecordClaims" },
    { "path": "test/architecture/record-claim-fidelity.ts", "name": "declaredNames" },
    { "path": "test/architecture/record-claim-fidelity.ts", "name": "RECORD_CLAIM_CODES" },
    { "path": "test/architecture/record-claim-fidelity.ts", "name": "NON_EXECUTABLE_PATHSPEC" },
    { "path": "test/architecture/record-claim-fidelity.ts", "name": "createGitReader" },
    { "path": "test/architecture/record-claim-fidelity.ts", "name": "collectRepositoryInput" },
    { "path": "test/architecture/record-claim-fidelity-controls.ts", "name": "RECORD_CLAIM_CONTROLS" },
    { "path": "test/architecture/record-claim-fidelity-controls.ts", "name": "runRecordClaimControls" },
    { "path": "test/architecture/record-claim-fidelity-controls.ts", "name": "buildSyntheticWorld" },
    { "path": "test/architecture/record-claim-fidelity-controls.ts", "name": "greenInput" }
  ]
}
```

## The assertions

### Family A — claim fidelity. **Band A.**

Declared Band A, and the band is not self-assigned downward. The failure is
silent: `ux-picker` r3 shipped a commit missing its implementation and nothing
went red, because the previous round's code passes the same suites. Nobody meets
it on use; nobody reads it off the artifact. Full §6 applies — one recorded red
per vacuity vector, each varying exactly one property.

1. **Every declared path really differs from base in the frozen tree.** One
   `git diff --quiet` exit status per path. This is the `ux-picker` r3 detector.
2. **Every declared symbol really resolves in the frozen tree**, read from the
   AST at the declared head.
3. **No executable path changed that the block does not declare.** This also
   closes the lease-violation class — `matrix-unblock` round 1 crossed its lease
   at 18 files against 11 chartered and reported it afterwards. "Executable" is
   `git-workflow`'s identical-tree exclusion list verbatim: everything except
   `docs`, `.agents`, `CLAUDE.md`, `AGENTS.md` and `learnings.md`.

   **`--no-renames` is load-bearing here and was found by measurement, not by
   design.** Rename detection is on by default and reports a pure rename as the
   **destination path only** — measured, `a.ts -> b.ts` prints `b.ts` alone — so
   a packet that renamed an executable file away would leave the vacated path
   changed, undeclared and unreported, which is exactly the class this assertion
   exists to close. Deleting the flag reds the undeclared-path control and
   nothing else.

### Family B — record staleness. **Band C.**

Declared Band C. Docs and inventories; `review-tiers` is explicit that Band C
owes *"the deterministic gate plus a stated limit. No mutation control is
owed."* The gate is the check here. Controls ship anyway, because they were
cheap and because a gate never observed failing is not evidence.

4. **A conditional ratification whose packet is `accepted` fails.** An ADR whose
   *governing* status is `proposed` and which names a packet the ledger records
   as accepted is stale. Governing matters: ADR-0050 and ADR-0055 **quote** the
   stale wording they corrected, so a check keyed to the phrase rather than to
   the state would flag both.
5. **Duplicate ledger ids fail**, read from the packet table's ID column.
6. **Every routing target resolves** to a tracked row or to a document that
   exists. The scanner reads the backticked target of a routing phrase; note
   that it cannot tell a real routing from prose *describing* the pattern, so a
   document that spells the phrase out as an example fails loudly. Loud is the
   right failure here, and it is why this record does not spell it out.

## Sixteen diagnostics, sixteen controls, and each dies alone

`AGENTS.md` §6 requires one recorded red per vacuity vector, not one red
overall; the packet charter adds that *deleting each assertion must red exactly
one control*. Those two hold together only if each vacuity vector is its own
diagnostic, so that is how the gate is built.

| # | Diagnostic | The control | What a vacuous gate would do instead |
|---|---|---|---|
| 1 | `RECORD_CLAIM_PATH_UNCHANGED` | A claimed path byte-identical at base and head, **while the working tree really has changed that same file** | read the working tree and pass the `ux-picker` r3 commit |
| 2 | `RECORD_CLAIM_SYMBOL_ABSENT` | The claimed name occurs twice at head — once in a comment, once in a string literal — and is declared neither time | match the name as a string and count a mention as a declaration |
| 3 | `RECORD_CLAIM_PATH_UNDECLARED` | Two sub-cases: `scripts/probe.sh` changes and the block declares nothing over it; and a pure rename declares its destination but not its vacated origin | carry an exclusion list that swallows `scripts/`, or let default rename detection report only the destination |
| 4 | `RECORD_CLAIM_BLOCK_UNPARSABLE` | A block body that is not JSON | silently exempt the packet from every claim assertion |
| 5 | `RECORD_CLAIM_BLOCK_INVALID` | Ten malformed shapes, asserted one at a time: unknown key, wrong schema version, short SHA, empty `changedPaths`, repeated path, escaping path, empty packet name, symbol without a path, symbol whose name is not an identifier, symbol over a shell script | accept a shape the parser does not recognise as though it declared nothing |
| 6 | `RECORD_CLAIM_BLOCK_DUPLICATED` | Two blocks in one record | let a second block shadow the first |
| 7 | `RECORD_CLAIM_COMMIT_UNRESOLVABLE` | An absent base SHA, and a head that does not descend from the declared base | measure a rotten or wrong range and report success |
| 8 | `RECORD_CLAIM_NO_RECORDS` | Zero packet records discovered | let a glob that matches nothing report every claim upheld |
| 9 | `RECORD_CLAIM_NO_DECLARATIONS` | Records present, not one carrying a block | let deletion of the last block disable the family in silence |
| 10 | `RECORD_ADR_RATIFICATION_STALE` | A proposed ADR whose packet the ledger records as accepted | keep a status line the ledger has already contradicted |
| 11 | `RECORD_ADR_PACKET_UNRESOLVED` | A proposed ADR naming no resolvable packet, unpinned | skip an unparseable status, so the check quietly stops applying |
| 12 | `RECORD_ADR_NONE_SCANNED` | Zero decision records discovered | let a glob that matches nothing report every ratification current |
| 13 | `RECORD_MANIFEST_PIN_STALE` | A pin no longer observed unresolvable | let the pin become a permanent exemption nobody re-derives |
| 14 | `RECORD_LEDGER_ID_DUPLICATE` | One id on two rows | let two rows disagree about one packet |
| 15 | `RECORD_LEDGER_TABLE_ABSENT` | A ledger with no packet table | let a renamed table make uniqueness and every ratification lookup read zero rows |
| 16 | `RECORD_ROUTING_UNRESOLVED` | A routing naming neither a tracked row nor a document | leave a recorded finding with no owning row, which is a disposition with no executing gate |

Every control is one property away from a synthetic world in which **every**
assertion holds, and that green world is itself asserted green — otherwise a
control could red for a reason it does not name.

**Attribution is measured, not argued.** Each of the sixteen `findings.push`
sites was deleted in turn in a detached worktree and the control suite re-run:

```
OK    delete RECORD_CLAIM_PATH_UNCHANGED        -> controls that stopped reding: ['RECORD_CLAIM_PATH_UNCHANGED']
OK    delete RECORD_CLAIM_SYMBOL_ABSENT         -> controls that stopped reding: ['RECORD_CLAIM_SYMBOL_ABSENT']
...
die-alone: OK (16/16 assertions red exactly their own control)
```

**The subject repaired before it is measured** is discharged structurally rather
than by assertion alone: the controls build **dangling commits in the object
database** with a scratch `GIT_INDEX_FILE`, and write no file, move no ref and
touch no index. A test asserts `git status --porcelain` is byte-identical either
side of the whole control suite, so a checker that ever checked something out
would red.

## What the gate states that it cannot prove

Written here plainly rather than left implied, the way `check-review-record.sh`'s
own header says *"It proves a verdict was recorded... It cannot prove a review
happened."*

1. **It cannot prove the record claims ENOUGH.** The block is written by the
   packet author, so **a packet that declares nothing is checked against
   nothing.** This gate closes *"the commit does not contain what the record
   claims"*; it does not close *"the record claims too little."* Making the block
   mandatory is a `mission-cadence` edit and is deliberately out of scope here.
2. **Executable content added ABOVE the declared head is outside its range.**
   The block's range is closed at `head`, so a packet could in principle declare
   an early head and add executable work above it. What bounds this is the
   narrative-only rule for commits above the freeze plus `check-review-record.sh`
   covering the merge through its second parent; it is not bounded by this gate,
   and a reviewer should check it directly.
3. **A symbol claim proves a syntactic declaration, not a working one.** The AST
   reader observes that the module declares the name. It does not type-check it,
   does not prove it is exported from a package entry point, and does not prove
   it is reachable at runtime.
4. **Shell scripts carry no symbol claims at all** — only path claims.
5. **RECORD_ROUTING_UNRESOLVED has no zero-input control.** There are 13 routings
   today; a count ratchet over prose would be brittle, so a tree that stopped
   containing any routing would make assertion 6 vacuous without reding. Named
   here rather than controlled.
6. **The routing scanner cannot tell a routing from a description of one.** A
   document that spells the phrase out as an example is read as a real routing
   and fails. That failure is loud rather than silent, which is the right
   direction, but it is a limit.
7. **The ADR reader recognises a fixed set of five anchors** for the packet a
   proposed ADR names. A status phrased outside them lands in
   `RECORD_ADR_PACKET_UNRESOLVED` rather than being skipped, so the failure mode
   is a false alarm and not a silent miss — but the anchor set is a limit.

## Gate results

- `pnpm typecheck` — green.
- `pnpm lint` — green.
- `pnpm format` — green.
- `scripts/check-records.sh --self-test` — **OK, 16 controls, one per
  assertion.**
- `node --import tsx test/architecture/record-claim-fidelity-negative-control.ts`
  — reds by design with `RECORD_CLAIM_PATH_UNCHANGED`, exit 1.
- Die-alone deletion matrix — **16/16**.
- `pnpm test:architecture` — **149/149** on the corrected tree. On the tree
  before the ADR correction below it was 148/149, failing on exactly one
  assertion — `the record layer is clean at this tree` — and nothing else, which
  is the gate reporting a real defect rather than a suite regression.
- `scripts/check-records.sh` — `records: OK (126 record(s), 1 declaring: 7
  claimed path(s) and 10 claimed symbol(s) observed in their frozen trees; 57
  ADR(s) against 148 ledger row(s); 23 routing(s) resolved)`.

## The gate's first run found five stale ratifications the sweep missed

`scripts/check-records.sh` on the base tree reports **five**
`RECORD_ADR_RATIFICATION_STALE` findings that survived the orchestrator's
one-time sweep at `ba4304d`:

| ADR | Names packet | Ledger status |
|---|---|---|
| `ADR-0021-total-absent-value-semantics.md` | `Q1-P0` | accepted |
| `ADR-0022-query-level-aggregate-contract.md` | `Q1-P3a` | accepted |
| `ADR-0023-storageless-platform-capability-tier.md` | `1c-a` | accepted |
| `ADR-0024-exact-compatible-release-reversal.md` | `1g2` | accepted |
| `ADR-0034-terminal-state-operation-preconditions.md` | `G3-Pterm` | accepted |

Each was verified against the ledger row's own evidence column: every one of
those five packets cites the ADR it implements. The sweep corrected the six
ADRs phrased *"ratified when that packet is accepted"* (0026, 0027, 0028, 0029,
0030, 0033); these five are phrased *"pending packet acceptance"* or plain
*"proposed (packet ...)"* and are the same fact in different words.

Each was verified against the ledger row's own evidence column: every one of
those five packets cites the ADR it implements.

**The lane did not take this unasked.** `docs/decisions/**` is on `lanes.md`'s
high-conflict shared list except a packet's own new ADR, and R1's disposition
assigns the sweep to the orchestrator explicitly — *"The orchestrator performs
the one-time sweep so the gate lands green; the lane builds the gate."* The lane
stopped and issued a **bridge request**, and the orchestrator **granted it on
2026-08-21, scoped to status lines only.** The five were then corrected in that
scope, in the same wording the sweep used for the six it caught, each naming the
packet's reviewed and integrated SHAs from the ledger.

That the gate found on its first run what a careful manual sweep missed is the
best available evidence that it works. `check-review-record.sh` was found the
same way, firing on the very commit that introduced it.

**One thing was flagged and deliberately NOT corrected**, because the bridge
covers status lines only: ADR-0034's §*"What this ADR does not yet implement"*
still defers the enforcement half behind `G3-P5`, which the ledger also records
as accepted, and `inventory-form-anatomy`'s row records building on *"ADR-0034's
existing predicate carrier"*. That section reads stale, but confirming it is a
measurement against `module-runtime-interpreter.ts` rather than a status
correction. It is named in the ADR itself so it cannot rot quietly, and it is
**not** something this gate detects — the gate reads the governing status, not
the body.
