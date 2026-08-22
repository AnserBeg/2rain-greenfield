# record-claim-fidelity — the record layer gets its first gate

Date: 2026-08-21
Base: `ba4304d0477784142442093c6783b20ae2f09424`
Branch: `packet/record-claim-fidelity`
Tier: Behavioral — the diff adds a gate over narrative records and changes no
product logic.
Status: **round 4, frozen for review.** Rounds 1, 2 and 3 each returned
**REVISE**;
every finding in all three was reproduced against the frozen candidate before
anything was changed. Round 3's three open findings and its new narrative defect
are closed below. The packet's last executable commit is
`0b343d2b9e0a0c81bfaba014b3fbbc8f8b420b41`.

**Round 4 argued that the rounds were converging because its corrections were
fail-closed rather than pattern-widening. Round 5 refuted that by measurement,
and the refutation is correct.** The fail-closed branch is entered only after an
open-ended spelling detector recognises that a ratification clause exists, so
`will be ratified after X is accepted` never reaches it and binds the planned
provenance packet instead. **A gate whose terminal state is reached only by
matching another finite list of English is not terminal.** The argument is
withdrawn; it was the lane defending its own instrument, and the prompt that
carried it was steering, which the round-5 reviewer said plainly.

**`pnpm test:architecture` is 151/151 green**, measured in this lane's own
worktree with the SHA re-read after the run. It was OWED for one round; see
"Gate results" for why, because the reason is a live hazard rather than a
footnote.

**Tier is under an owed orchestrator ruling.** The charter set Behavioral; the
round-1 reviewer rules it Critical, because the packet introduces an acceptance
gate whose own Family A is declared silent. The lane does not rule its own tier.
If Critical stands, a Fable max confirm on the identical SHA is owed after this
arm reaches PASS.

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
- **The claimed paths and symbols are read from the frozen commits, never the
  working tree.** That is not incidental: the failure being closed is precisely
  a working tree that disagrees with the commit.
- **The declarations themselves, and every Family B input, are read from the
  checkout** — deliberately, because the subject is the *current* record layer.
  Round 1 was right that the earlier blanket phrasing *"nothing reads the
  working tree"* was false, and it has consequences beyond wording. See
  "The scope finding" below.

## Owned paths

| Path | Note |
|---|---|
| `scripts/check-records.sh` | new — the operator-facing gate |
| `test/architecture/record-claim-fidelity.ts` | new — the checker and its CLI |
| `test/architecture/record-claim-fidelity-controls.ts` | new — the committed controls, one per diagnostic (22) |
| `test/architecture/record-claim-fidelity.test.ts` | new — CI wiring, via the `test:architecture` glob |
| `test/architecture/record-claim-fidelity.manifest.json` | new — the pinned known-absence set |
| `test/architecture/record-claim-fidelity-negative-control.ts` | new — the `ux-picker` r3 reproduction, runnable |
| `test/architecture/repository-hygiene.test.ts` | one line — the add-only shared test inventory that `lanes.md` names |

Verified free before starting, by measurement rather than from the partition
table. `lanes.md` mandates `git diff --name-only main...<branch>` over every
`packet/*` branch; run at `0b343d2` across all 22, **none touches
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
  "head": "0b343d2b9e0a0c81bfaba014b3fbbc8f8b420b41",
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

## Twenty-two diagnostics, twenty-two controls, and each dies alone

`AGENTS.md` §6 requires one recorded red per vacuity vector, not one red
overall; the packet charter adds that *deleting each assertion must red exactly
one control*. Those two hold together only if each vacuity vector is its own
diagnostic, so that is how the gate is built.

**Round 1 found the earlier 16/16 measurement was taken at the wrong
granularity, and it was right.** That matrix deleted every `findings.push` site
*of a code* at once, so a code with two independent branches looked controlled
when only one branch was. Measured: `RECORD_CLAIM_SYMBOL_ABSENT` had a
missing-blob branch and a missing-declaration branch, and deleting the
missing-blob branch alone reded **nothing** — a claim over a file the head
DELETED passed the path assertion (deletion is a real change) and the
undeclared-path assertion (the path was declared). The branch is now its own
diagnostic with its own control, and the matrix is per-site.

| # | Diagnostic | The control | What a vacuous gate would do instead |
|---|---|---|---|
| 1 | `RECORD_CLAIM_PATH_UNCHANGED` | A claimed path byte-identical at base and head, **while the working tree really has changed that same file** | read the working tree and pass the `ux-picker` r3 commit |
| 2 | `RECORD_CLAIM_SYMBOL_ABSENT` | The claimed name occurs twice at head — once in a comment, once in a string literal — and is declared neither time | match the name as a string and count a mention as a declaration |
| 2b | `RECORD_CLAIM_SYMBOL_FILE_ABSENT` | The head **deletes** the claimed file, while the path claim and the undeclared-path claim both still hold | fold both symbol-absence branches into one code, so the deleted-file branch is never observed failing |
| 3 | `RECORD_CLAIM_PATH_UNDECLARED` | Two sub-cases: `scripts/probe.sh` changes and the block declares nothing over it; and a pure rename declares its destination but not its vacated origin | carry an exclusion list that swallows `scripts/`, or let default rename detection report only the destination |
| 3a | `RECORD_CLAIM_RANGE_UNOWNED` | A block copied into another record with **only the packet label edited** — the ordinary copy/paste, not a verbatim one — whose declared head carries another packet's `Packet:` trailer | accept filename equality as provenance, which proves only that a record agrees with itself since one edit moves both halves |
| 3b | `RECORD_CLAIM_PACKET_MISMATCH` | A valid block copied verbatim into a **different** packet record, where all its claims resolve against the original's commits | treat `packet` as a label, so copy/paste certifies the original packet twice and the copying packet for free |
| 3c | `RECORD_CLAIM_PACKET_DUPLICATED` | Two records declaring one packet | let two records each read as the authority for one packet |
| 4 | `RECORD_CLAIM_BLOCK_UNPARSABLE` | A block body that is not JSON | silently exempt the packet from every claim assertion |
| 5 | `RECORD_CLAIM_BLOCK_INVALID` | Ten malformed shapes, asserted one at a time: unknown key, wrong schema version, short SHA, empty `changedPaths`, repeated path, escaping path, empty packet name, symbol without a path, symbol whose name is not an identifier, symbol over a shell script | accept a shape the parser does not recognise as though it declared nothing |
| 6 | `RECORD_CLAIM_BLOCK_DUPLICATED` | Two blocks in one record | let a second block shadow the first |
| 7 | `RECORD_CLAIM_COMMIT_UNRESOLVABLE` | An absent base SHA, and a head that does not descend from the declared base | measure a rotten or wrong range and report success |
| 8 | `RECORD_CLAIM_NO_RECORDS` | Zero packet records discovered | let a glob that matches nothing report every claim upheld |
| 9 | `RECORD_CLAIM_NO_DECLARATIONS` | Records present, not one carrying a block | let deletion of the last block disable the family in silence |
| 10 | `RECORD_ADR_RATIFICATION_STALE` | Five sub-cases: a proposed ADR whose packet the ledger records as accepted; the ratification packet named **second** behind a planned provenance packet; an **escaped pipe** shifting the Status column; an **inserted column** moving Status to a different index; and an **escaped backslash** (`\\|`), which is an escaped backslash followed by a *real* delimiter | keep a status line the ledger has contradicted; bind to the first anchor tried and never test the condition the ADR states; read Status at a fixed index; or treat every `\|` pair as a literal pipe and merge two cells |
| 11 | `RECORD_ADR_PACKET_UNRESOLVED` | Two sub-cases: a proposed ADR naming no resolvable packet, unpinned; and an explicit ratification target that does not resolve — a **typo** — behind valid provenance | skip an unparseable status; or fall through to provenance and substitute a different packet for the condition the ADR states |
| 12 | `RECORD_ADR_NONE_SCANNED` | Zero decision records discovered | let a glob that matches nothing report every ratification current |
| 13 | `RECORD_MANIFEST_PIN_STALE` | A pin no longer observed unresolvable | let the pin become a permanent exemption nobody re-derives |
| 14 | `RECORD_LEDGER_ID_DUPLICATE` | One id on two rows | let two rows disagree about one packet |
| 15 | `RECORD_LEDGER_TABLE_ABSENT` | A ledger with no packet table, and a recognised table carrying no rows | let a renamed table make uniqueness and every ratification lookup read zero rows |
| 13b | `RECORD_MANIFEST_OWNING_TABLE_STALE` | A declared owning-table signature matching no table in the tree | let the declared set rot into a permanent allowlist nobody re-derives |
| 15b | `RECORD_LEDGER_COLUMN_ABSENT` | A packet table whose header carries no Status column | read some other cell as the status and report every ratification current |
| 16 | `RECORD_ROUTING_UNRESOLVED` | Four sub-cases: an unknown id; the ledger's own table **header** (`ID`); a **directory**; and a row in an **ordinary non-owning data table** (a colour swatch list supplying `blue`) | leave a recorded finding with no owning row, which is a disposition with no executing gate |

Every control is one property away from a synthetic world in which **every**
assertion holds, and that green world is itself asserted green — otherwise a
control could red for a reason it does not name.

**Attribution is measured, not argued, and it is measured twice.** Both matrices
run in a detached worktree.

**Per report site.** Each of the twenty-three individual `findings.push` sites is
deleted in turn — not each code, which is the granularity that hid the symbol
branch:

```
OK    site 11  RECORD_CLAIM_SYMBOL_FILE_ABSENT      -> ['RECORD_CLAIM_SYMBOL_FILE_ABSENT']
OK    site 12  RECORD_CLAIM_SYMBOL_ABSENT           -> ['RECORD_CLAIM_SYMBOL_ABSENT']
...
per-branch die-alone: OK (23/23 push sites red exactly their own control)
```

**Per behavioural guard.** A report site is not the only thing that can be
deleted. Twelve guards decide what the gate *sees* rather than what it *says*,
and each is mutated separately:

```
OK    --no-renames flag                   -> ['RECORD_CLAIM_PATH_UNDECLARED']
OK    escaped-pipe handling               -> ['RECORD_ADR_RATIFICATION_STALE']
OK    backslash parity                    -> ['RECORD_ADR_RATIFICATION_STALE']
OK    Status index located in header      -> ['RECORD_ADR_RATIFICATION_STALE']
OK    header row is not a tracked row     -> ['RECORD_ROUTING_UNRESOLVED']
OK    directory is not a document         -> ['RECORD_ROUTING_UNRESOLVED']
OK    owning-table gating                 -> ['RECORD_ROUTING_UNRESOLVED']
OK    ratification clause detected at all -> ['RECORD_ADR_PACKET_UNRESOLVED', 'RECORD_ADR_RATIFICATION_STALE']
OK    unrecognised clause fails closed    -> ['RECORD_ADR_PACKET_UNRESOLVED']
OK    back-reference defers to provenance -> ['RECORD_ADR_RATIFICATION_STALE']
OK    exactly one Packet: trailer         -> ['RECORD_CLAIM_RANGE_UNOWNED']
OK    Packet: trailer ownership           -> ['RECORD_CLAIM_RANGE_UNOWNED']

behavioural guards: OK (12/12 red at least one control)
```

**The guard matrix earned its place immediately.** Its first run found the
Status-index derivation uncontrolled — reverting it to a hardcoded index reded
nothing, because Status sat at index 4 in every control ledger. The
inserted-column sub-case closes it. A gate's readers need controls as much as
its reporters do.

**Neither matrix is completeness evidence, and round 2 was right to say so.**
Both prove that the sites and guards *that exist* are load-bearing. Neither can
reveal a semantic path for which no input was supplied — which is exactly how
round 2's five findings survived round 1's green matrices. Every one of them was
a branch nobody had written a case for: a copy-and-*edit* rather than a verbatim
copy, an escaped backslash rather than an escaped pipe, an *unresolved* explicit
ratification rather than a resolved one, and an ordinary data table rather than
a header row. **The claim these matrices support is "the selected sites and
guards are load-bearing", and nothing wider.**

**One diagnostic was drafted and removed rather than shipped.**
`RECORD_ADR_PACKET_AMBIGUOUS` was going to fire when two anchors resolved to
different ledger rows. With the ratification anchor given precedence — which is
the actual fix for round 1's finding — no realistic status reaches it, and an
assertion controllable only by a contrived input is worse than no assertion.
Removed, and recorded here so the reasoning is not re-derived.

**The subject repaired before it is measured** is discharged structurally rather
than by assertion alone: the controls build **dangling commits in the object
database** with a scratch `GIT_INDEX_FILE`, and write no file, move no ref and
touch no index. A test asserts `git status --porcelain` is byte-identical either
side of the whole control suite, so a checker that ever checked something out
would red.


## Round 2 findings and their disposition

Round 2 returned REVISE. F1 and F3 were CLOSED and F6 was closed as conduct;
five remained open and all five were reproduced against `b8d1c31` before
anything was changed.

| # | Finding | Reproduced | Closed by |
|---|---|---|---|
| F2 | Filename equality is not provenance: copy the block, edit **only** the packet label, and it certifies another packet's commits | Copied this packet's block into `packet-b.md`, changed one field → **green, "2 declaring"** | `RECORD_CLAIM_RANGE_UNOWNED`. The declared head must carry a `Packet:` trailer naming the declared packet. |
| F4A | `splitRow` treats `\\|` as an escaped pipe when it is an escaped **backslash** plus a real delimiter | Stale ratification **not reported**; the merged cells moved Status off its index | Parity-aware backslash scan. |
| F4B | An unresolved explicit ratification target falls back to provenance | Typo in the explicit target + `planned` provenance packet → **nothing reported** | Present-but-unresolved now stays unresolved. |
| F4C | Any id-shaped first cell anywhere counts as an owning row | `\| Colour \| Value \|` supplied `blue`, and the routing resolved | Row ids come only from declared owning tables. |
| F4D | The delimiter matcher required both outer pipes; GFM makes them optional | A loose-delimiter table went unrecognised | GFM-tolerant `isSeparatorRow`. |
| F5 | The ledger row still asserted round-1 figures in present tense beside their own correction | Read directly from `ledger.md` | The superseded sentences are **deleted**, not appended to. |

**Why the `Packet:` trailer is an authority and not another self-report.** A
record and the block inside it are one file: a single edit moves both, which is
why filename equality proved nothing. The trailer is written into the commit
object at commit time and **cannot be changed without moving the SHA the block
names**. `check-review-record.sh` already reads this same trailer for the same
reason. **What it proves is exactly this and no more: the declared HEAD attests
one packet name, and that head fixes the ancestry.** It does not observe who
authored the intermediate commits, and it does not prove the packet was entitled
to the range. An earlier draft of this paragraph said "the range was authored
under that packet's name" — round 4 corrected that wording in the disposition
table below and left it standing here, which is the same stale-record class this
packet exists to catch, occurring for the third time inside the packet itself.

**The owning-table set was measured, not chosen.** Every routing target that
resolves in the tree today sits under one of exactly three headers — the ledger
packet table, `current-plan.md`'s active queue, and `ui-ux-remaining.md`'s
inventory. All three are declared in the manifest with their reasons, and
`RECORD_MANIFEST_OWNING_TABLE_STALE` ratchets the other way so the list cannot
become a permanent allowlist. A routing to a table not on the list fails loudly
and gets a measured entry rather than a silent one.

**F4D got an admission twin rather than a negative control, deliberately.** Its
failure mode is a false RED — an owning table goes unrecognised and its real rows
stop resolving — so the discriminating evidence is a positive case that dies when
the fix is reverted. Measured: making the matcher strict again fails exactly
`a GFM table with inconsistent outer pipes is still read correctly`, and nothing
else.

**That twin then caught round 4's own change, which is the best thing it has
done.** Binding ownership to `{path, header}` made the suite red at
`70dc99c`: the twin's loose-delimiter specimen sat at `docs/execution/loose.md`,
an undeclared path, so it stopped conferring ownership for a reason that had
nothing to do with separators. **The twin was right and the twin was wrong at
once** — right that something had changed under it, wrong that it was still
isolating the property it names. The specimen moved to a declared owning path so
the missing outer pipe is again the only variable, and the strict-matcher
revert still fails it and nothing else.


## Round 3 findings and their disposition

Round 3 CLOSED F4A, F4D and F5, and left three open plus one new narrative
defect. All four were reproduced against `bbae7c9` before anything changed.

| # | Finding | Reproduced | Closed by |
|---|---|---|---|
| F2 | The claim said "authored"; the observation is one head trailer, and `packetTrailer` took the **first match**, so a head carrying two contradictory `Packet:` lines passed as whichever came first | A two-trailer message extracted `claimed-packet` and ignored the contradiction | Exactly one distinct trailer required, and **the claim narrowed to match**: the head *attests* the range under one name and fixes the ancestry. It does **not** observe authorship of every commit in the range. |
| F4B | Clause presence was inferred from one spelling, so natural variation fell through to provenance | `ratified when **packet** X is accepted`, `ratified **once** X is accepted`, `ratified when X **has been** accepted` — all three reported **nothing** | Clause existence detected independently of target extraction; an unrecognised clause **fails closed** into the pinned set. |
| F4C | Ownership was header text alone, so a lookalike table anywhere conferred it | A queue-shaped table pasted into a packet record made `ghost-owner` resolve | Owning tables declared as `{path, header}` and matched at that path only. |
| new | The record still stated 21/21 and "Six guards"/6/6 in present tense, contradicted by its own Gate Results | Read directly from the frozen record | The superseded block is **replaced**, not appended to. |

**Two costs were measured before committing to the fail-closed design**, because
a fail-closed reader that parks half the tree is a worse instrument than a leaky
one:

- **Exactly two ADRs** on the whole tree carry a `proposed` governing status, and
  **both are already pinned**. Failing closed parks nothing new.
- **All three declared owning tables already live in exactly one file each**, so
  binding ownership to a path costs nothing.

**One clause legitimately defers to provenance, and it is declared rather than
guessed:** the back-reference *"ratified when **that packet** is accepted"*,
where the same sentence has already named the packet. That is a reading of
English and it is a **stated limit** — the recognised vocabulary is two forms,
and every other wording is unresolved and visible in the pinned set. Round 3's
own control ADRs use the back-reference form, which is how the first fail-closed
attempt was caught: it turned five green controls red.

## The scope finding — `docs/**` is now an executed gate input

**This is round 1's first finding, it is correct, and the lane cannot fix it.**

`git-workflow`'s identical-tree rule excludes `docs`, `.agents`, `CLAUDE.md`,
`AGENTS.md` and `learnings.md` on the stated premise that those paths *"are
never executed"*, so a commit touching only them observes nothing new and the
reviewed matrix carries forward. **This gate reads all of them.** It reads the
ledger, every packet record, every ADR and every Markdown file under `docs/**`,
and `test/architecture/record-claim-fidelity.test.ts` executes that reader.

**Measured, at the reviewer's request, rather than argued:**

```
$ git diff --name-only HEAD~1 HEAD -- . ':!docs' ':!.agents' ':!CLAUDE.md' ':!AGENTS.md' ':!learnings.md'
                                    # empty — git-workflow calls these trees identical

$ node --import tsx test/architecture/record-claim-fidelity.ts
records: FAIL
  RECORD_CLAIM_COMMIT_UNRESOLVABLE  docs/execution/packets/record-claim-fidelity.md
      declared head 000...000 does not resolve to a commit in this repository
```

A docs-only commit that repoints the declared head to forty zeroes is
*identical* under the rule and *red* under the gate. The premise is false, and
this packet is what made it false.

**This packet's own history demonstrates it in the ordinary case too.** The five
ADR status corrections were docs-only and moved `test:architecture` from 148/149
to 149/149; the docs-only head repoint changed which executable range the gate
certifies. Neither is inert narrative from this gate's point of view.

**What the lane did, which is bounded and honest:**

1. The false claim is removed from the checker's own header comment and from the
   `NON_EXECUTABLE_PATHSPEC` doc comment, which now says plainly that the
   premise is false of this gate and why.
2. **This packet's integration does not claim the identical-tree carry-forward.**
   `test:architecture` re-runs at the integrated SHA regardless of whether the
   executable diff is empty. That costs one suite run and needs no doctrine
   change.

**What the lane did NOT do, and will not:** change `git-workflow`, `AGENTS.md`
§6, or any skill. `.agents/skills/**` is fenced out of this charter by the
orchestrator, and the general rule — *when may a reviewed matrix be carried
forward past a narrative commit?* — is a doctrine question that outlives this
packet. **The charter was drawn too narrowly to settle it, and settling it is
the orchestrator's edit.** Recorded here rather than worked around.

**The narrowest correct rule, offered as input and not as a decision:** the
exclusion list is about *which paths a packet must declare*, and it is right for
that. What it may no longer do is imply that a suite reading those paths need
not re-run. Those are two different claims that happen to share one command.

## What the gate states that it cannot prove

Written here plainly rather than left implied, the way `check-review-record.sh`'s
own header says *"It proves a verdict was recorded... It cannot prove a review
happened."*

1. **It cannot prove the record claims ENOUGH.** The block is written by the
   packet author, so **a packet that declares nothing is checked against
   nothing.** This gate closes *"the commit does not contain what the record
   claims"*; it does not close *"the record claims too little."* Making the block
   mandatory is a `mission-cadence` edit and is deliberately out of scope here.

   **Round 1 was right that this was stated too broadly.** Three structural
   facts inside it were cheap and are now enforced: the block's `packet` must
   equal the record's filename stem, no two records may declare one packet, and
   a range whose base is not an ancestor of its head is refused. What remains
   unprovable is *semantic* completeness — whether the claims a packet chose to
   make are the ones worth making.
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
5. **A row's Status is not checked against that row's own evidence prose.** This
   packet shipped exactly that defect in round 1 and the gate stayed green.
   Closing it means reading narrative, which the charter forbids.
6. **RECORD_ROUTING_UNRESOLVED has no zero-input control.** There are 13 routings
   today; a count ratchet over prose would be brittle, so a tree that stopped
   containing any routing would make assertion 6 vacuous without reding. Named
   here rather than controlled.
7. **The routing scanner cannot tell a routing from a description of one.** A
   document that spells the phrase out as an example is read as a real routing
   and fails. That failure is loud rather than silent, which is the right
   direction, but it is a limit.
8. **The ADR reader recognises a fixed set of anchors** for the packet a
   proposed ADR names. A status phrased outside them lands in
   `RECORD_ADR_PACKET_UNRESOLVED` rather than being skipped, so the failure mode
   is a false alarm and not a silent miss — but the anchor set is a limit.

## Round 1 findings and their disposition

| # | Finding | Disposition |
|---|---|---|
| 1 | `docs/**` is an executed gate input while doctrine calls it non-executable | **Reproduced.** Not fixable in this lease — see "The scope finding". Bounded response: the false claim removed from the source, and this packet's integration re-runs `test:architecture` rather than claiming carry-forward. |
| 2 | `packet` identity decorative; the range not bound to its record | **Reproduced** by copying this packet's block into a second record, where it read green and reported "2 declaring". Closed by `RECORD_CLAIM_PACKET_MISMATCH` and `RECORD_CLAIM_PACKET_DUPLICATED`. |
| 3 | `RECORD_CLAIM_SYMBOL_ABSENT` had an uncontrolled Band-A branch | **Reproduced** — deleting the missing-blob branch reded nothing. Split into `RECORD_CLAIM_SYMBOL_FILE_ABSENT` with its own control, and the die-alone matrix is now per-site plus a second matrix over behavioural guards. |
| 4 | Three Family-B fail-open trees: escaped pipe, anchor order, header/directory routing | **All three reproduced.** Escape-aware cell split with the Status index located in the header; the explicit ratification anchor now outranks provenance; header rows excluded exactly and `pathKind` replaces `pathExists` so a directory is refused inside the checked logic. |
| 5 | The candidate's own ledger row was stale at the frozen SHA | **Confirmed** — it read `blocked` on a sweep that had landed, with a `<pending>` tip. Corrected. Filed as its own lesson below. |
| 6 | Tier should be Critical, not Behavioral | **Surfaced, not self-ruled.** The lane does not set its own tier; the orchestrator's ruling is owed. |

**The most valuable finding was not the one the lane suspected.** Round 1's
prompt listed three guesses; two (anchor order, ledger column index) were real,
and the finding that mattered most — the doctrine contradiction — was on nobody's
list and came from reading the gate against `git-workflow` rather than against
the prompt.

## The stale row this packet shipped, which is its own subject

**The record-staleness packet shipped a stale record.** The ledger row read
`evidence_ready; blocked on a five-line orchestrator ADR sweep` and
`frozen packet tip <pending>` in the same row whose evidence said the bridge was
granted, the five corrections had landed, and architecture was 149/149.

**The gate does not detect this and could not have.** It reads the ledger's ID
and Status columns for uniqueness and ratification lookups; it does not read a
row's Status against that row's own evidence prose, and doing so would be exactly
the prose-parsing the charter forbids. Recorded as a limit rather than chased.

## Gate results

- `pnpm typecheck` — green.
- `pnpm lint` — green.
- `pnpm format` — green.
- `scripts/check-records.sh --self-test` — **OK, 22 controls, one per
  assertion.**
- `node --import tsx test/architecture/record-claim-fidelity-negative-control.ts`
  — reds by design with `RECORD_CLAIM_PATH_UNCHANGED`, exit 1.
- Per-report-site die-alone matrix — **23/23**.
- Behavioural-guard matrix — **12/12**.
- Two admission twins, each measured by reverting its subject. The
  GFM-separator twin fails when the delimiter matcher is made strict again.
  **The working-tree twin is narrower than an earlier draft of this line
  claimed:** it constructs a synthetic `RecordClaimInput` and calls
  `verifyRecordClaims` directly, over a REAL git reader and real dangling
  commits — so it does prove the frozen tree beats a disagreeing working tree,
  but it does **not** drive the production `collectRepositoryInput` adapter. A
  separate test drives that adapter and asserts the repository is unwritten; it
  never constructs the frozen-versus-working disagreement. Neither test is an
  end-to-end adapter twin, and the earlier line said one was.
- `pnpm test:architecture` — **151/151 green at `4fe6c7d`**, which is 141
  baseline plus this packet's 10. Run in `/home/rvham/2rain-greenfield-rcf`,
  this lane's own worktree with its own install, and **`git rev-parse HEAD` was
  re-read after the run** and matched.

  **It was OWED for one round, and the reason belongs in the record.** A run
  launched in the shared working directory returned **141/141 green** — on
  `packet/pur-1-v2`, because another session checked out its branch while the
  suite was running. This packet's test file was not in that tree at all, so its
  absence read as a clean pass. **A suite resolves its files from the working
  directory at read time, not from the SHA it started on, and nothing in its
  output names the tree it measured.** A green number is not evidence until the
  tree it measured is confirmed. The first substitute tried — a detached
  worktree with a symlinked `node_modules` — cannot run this suite either: pnpm
  workspace resolution fails and `test-lock-observability` shells out to
  `pnpm install`, which aborts without a TTY. The fix was to adopt the house
  convention this program already uses for every other lane: a sibling worktree
  with a real install.
- `node --import tsx --test test/architecture/record-claim-fidelity.test.ts` —
  **10/10** at `0b343d2`, run in an isolated worktree. This file needs no pnpm
  workspace resolution, so the worktree result is sound for it alone.
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
