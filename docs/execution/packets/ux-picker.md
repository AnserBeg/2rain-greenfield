# ux-picker — the compiled surface tells the renderer what a field is

Date: 2026-08-10
Tier: Critical
Status: evidence_ready
Base: `eb02adf` · Reviewed candidate: `7f42380` (tag `ux-picker-reviewed-r5`)
Integrated: `0c5fa8df305373c31fa17abeb23608ad86142202` (the conflict-producing
merge; parents `7f42380` and `194871f`)
Re-merged onto moved `main`: `eb37fc6` · Closure: `d9c9196`

## Why this record exists in this shape

**Four review arms ran. The orchestrator wrote review-log lines for the two it
adjudicated against source and refused to invent the other two, so rounds 3 and
4 existed nowhere on disk.** This record carries all four — SHA reviewed,
verdict, each finding, and how each was closed — and that gap is what held the
packet at `evidence_ready`.

Read the arm sections as the packet's actual history: three of the four rounds
found the same class, and the last section of this record is the part that
outlives the packet.

## Goal

`component-registry.ts:721` rendered every field as
`<label><span>{label}</span><input name="value:{fieldId}" autocomplete="off"></label>`.
A date, a quantity, an enum and a status were the same bare text box — not
because the renderer was lazy but because it was blind: the compiled surface
carried `fieldIds: readonly string[]` and nothing else, while the canonical
model has ten field kinds and `enumFieldType` already carries its `options`. The
information existed and was discarded at the projection boundary.

Everything new rides compiler-semantic profile **v2**, which is cut and
deliberately unadopted, so nothing reaches a recorded release and every root
holds. `ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION` did not move.

## What shipped

- **Projection.** `surfaceManifestField` carries `kind`, `required`, `options`
  for enums, and `temporal: {precision, timezoneSemantics}` for the three
  temporal kinds — the last mirroring the operation input contract's ratified
  shape value for value.
- **Reader.** `CompiledSurfaceField` is discriminated on kind; the temporal
  branches and the accepted vocabulary both derive from
  `timezoneSemanticsByKind`, so type and runtime cannot separate. Unrecognised
  kinds, mismatched pairings and malformed payloads are refused by name through
  `INVALID_SURFACE_FIELD`.
- **Renderer.** Enum ≤5 options → `<select>`, >5 → `<input list>` + `<datalist>`
  (native typeahead, zero script, ADR-0036 §2). `date` → `type="date"`; `time` →
  `type="time"` with `step` from the declared precision; `dateTime` → a
  **lossless text carrier** with `data-refused-control="datetime-local"`, because
  no native control can express a UTC instant's `Z` or a real offset. Numeric
  kinds → `type="number"` with an `inputmode`. Boolean → a three-option
  `<select>`, not a checkbox.
- **Capability floor.** A manifest carrying `fields` requires surface-manifest
  capability **version 3**.

## Review arms

### Arm 1 — `3dd8f10` — BLOCK

Three findings, all verified by the orchestrator against source.

1. **Temporal fields lost the discriminants the control needs.**
   `surfaceManifestField` carried kind and options only, and its comment claimed
   nothing else changes the control. False for both temporal kinds:
   `timeFieldType.precision`, `dateTimeFieldType.precision` and
   `dateTimeFieldType.timezoneSemantics` are canonically declared, both temporal
   inputs default to a 60-second step, and `datetime-local` is local time
   *without* timezone information.
   **Closed** by projecting `temporal`, deriving the time control's `step` from
   precision, and refusing `datetime-local` by name in favour of a lossless text
   carrier.

2. **The boolean branch broke the packet's own `minimumVersion` reasoning.** The
   floor was justified on the posted key and posted string being identical
   either way — and the hidden-`value="false"` sibling beside the checkbox made
   the old reader submit `""` where the new one submits `"false"`. The comment
   named its own invalidating condition one line above the violation.
   **Closed** by removing the submission difference rather than raising the
   floor; later superseded when the floor was allocated outright (arm 2).

3. **Nullable booleans collapsed three states into two.** `null`, absent and
   `false` all rendered unchecked and the hidden sibling always posted `"false"`,
   so an unrelated edit silently wrote `null → false` — information destroyed
   upstream of anywhere `U7` could recover it.
   **Closed** by rendering a three-option `<select>` whose blank is the unset
   state.

**Framing kept, and it is the ruling that shaped the rest of the packet:**
*projecting temporal precision and nullable-boolean shape is not implementing
U7's form behaviour; it is ensuring U7 has a lossless compiled contract to build
on.* The lane had routed too much of the cause away, not the symptom.

### Arm 2 — `5892e99` — REVISE

Two of three findings verified directly in source; the third accepted on the
reviewer's reading because its fix is subsumed by the first.

1. **`parseFieldTemporal` bound one discriminant and not the other.** Precision
   was bound to kind; `timezoneSemantics` was checked only for membership in the
   union of all four spellings — *the same function doing the right thing for one
   and not the other*. So `dateFieldType`+`utcInstant`,
   `timeFieldType`+`calendarDate` and `dateTimeFieldType`+`localWallTime` were
   all admitted, and the renderer then chose its control from `kind`: the
   compiled contract claiming one temporal domain while the control implemented
   another, silently.
   **Closed** by a discriminated temporal shape rather than a compatibility
   table, per *prefer unrepresentable to detectable*.

2. **The double turned production's refusal into a success.**
   `#askTheProvider` asked the real `parseMutationInput` at three stages and
   recorded each verdict — which is how the lane learned production refuses the
   form as submitted — but returned `void`, and `execute()` discarded the
   verdict, merged the *as-submitted* values and returned `outcome: 'succeeded'`
   with an authoritative reread. **The stand-in read back precisely what
   production had rejected, and that reread was cited as provider evidence.**
   **Closed** for this packet's own executor; the class filed as
   `double-must-honour-refusal`.

3. **The equivalence gate measured a proxy.** `submittedEntries()` regex-parsed
   server HTML and synthesised what it believed a browser submits — no
   successful-control rules, no disabled-state behaviour, no form ownership.
   **Measured:** marking one v2-only control `disabled`, which a real browser
   omits from submission entirely, kept that gate **and the whole integration
   suite** green.
   **Closed** by deleting the gate and allocating capability version 3 — a
   version number needs no instrument.

Findings 1 and 3 are one class — *an instrument that proxies for the fact* — and
the orchestrator declared this the last correction, with a third instance to
route rather than fix.

### Arm 3 — `56762ce` — REVISE

1. **Claim 1's implementation was absent from the frozen tree.** `56762ce`
   touched two files; `surface-contract.ts` was byte-identical at base and head.
   The derived type and the validated-value return had never been committed.
   **Cause, and it is the packet's most expensive lesson:** the implementation
   was written and verified, then a one-off drift probe mutated the same file,
   measured 9 reds, and reverted with `git checkout -- <path>`. That revert goes
   to HEAD, so it destroyed the round's work along with the mutation — and
   **nothing went red afterwards**, because the previous round's implementation
   passes the same suites. The commit message described work the commit did not
   contain, and the reviewer found it by reading `git show --stat` rather than
   the report.
   **Closed** at `89e2f1c` by restoring the implementation and verifying the
   commit contains it before reporting.

2. **The claim that the double honours refusals was false as written.** With the
   flag defaulting to `false`, `execute()` still merged rejected values and
   returned success.
   **Closed** by removing the default so no construction site can be silent, and
   narrowing the claim to the one executor that honours.

### Arm 4 — `89e2f1c` — REVISE

1. **The single-authority claim was not established.** The four timezone
   spellings still had independent representations: the broad `timezoneSemantics`
   list and `timezoneSemanticsByKind`. The derived type read the table, but the
   parser checked the broad list first and nothing tied them. Adding
   `zonedDateTime` to one kind's entry and missing the list would make the type
   statically admit a value the parser refuses one check earlier — not silent
   coercion, but the type-versus-runtime contradiction the claim denies.
   **Closed** at `7f42380` by deriving the broad vocabulary from the table by
   spread and pinning the table's keys with `satisfies`.

2. **`KNOWN_FALSE_GREEN` labelled configuration as evidence.** It sat on five
   construction sites while only two assert a manufactured success; the
   failed-data-slot, empty-data-slot and invalid-binding fixtures never reach the
   operation branch at all. False in one direction, and a sweep for the marker
   missed the real cases in the other.
   **Closed** by renaming the constructor arguments to
   `HONOURS_PROVIDER_REFUSALS` / `IGNORES_PROVIDER_REFUSALS` and moving
   `KNOWN_FALSE_GREEN` to the two assertions that observe it.

**Both findings were the same class as arms 2 and 3** — prose claiming more than
code — which is why both were fixed *in code* rather than by writing a smaller
sentence.

## Convergence record — which criterion licensed each round

`review-tiers`' convergence section was superseded on 2026-08-10, after these
rounds ran, and its backstop requires the licensing criterion to be named in the
packet record from round three onward. Named here, against the new rule, and the
last row is the one that matters.

| round | criterion | licensed? |
|---|---|---|
| Arm 1 `3dd8f10` | defect **in production** | yes — three production defects |
| Arm 2 `5892e99` | defect **in production** | yes — one production defect plus the double |
| Arm 3 `56762ce` | **regression introduced by the previous round's fix** | yes, and it is an override that beats the three questions: a probe's `git checkout --` destroyed the round's own implementation |
| Arm 4 `89e2f1c` | same class, and the fixes **subsumed** rather than sat beside | yes — each correction moved up a level: bind one discriminant → derive the branch from the table → derive the vocabulary from the table too |
| Merge arm (resolution `0c5fa8d`, reviewed at `eb37fc6`) | **new class**, merge-only | yes — see below |

**The lane's earlier self-assessment was wrong and the arm corrected it.** I had
written that rounds 4 and 5 were "both prose overstating code", which under the
new rule licenses exactly one narrowing round. The reviewer refused that framing:
one candidate did not contain the production implementation its claim described,
and the next retained independent temporal vocabularies capable of making the
static type admit a value the runtime parser refused. **Those are code-state
defects.** The record says so rather than my summary of it.

## The merge-only selector-control class — Critical, write path

**A new class, not a continuation of `ux-picker`'s.**

**Provenance, corrected by the merge arm after this record got it wrong.** The
conflict-producing resolution is **`0c5fa8d`**, whose parents are `7f42380`
(`name="intent"` with `renderFormFields`) and `194871f` (`name="operationId"`
with the inline bare-input map) — the two opposing halves. `pur1-intent-limit`
(ADR-0051) had replaced `name="intent"` with `name="operationId"`, and
`ux-picker` had replaced the bare-input map with `renderFormFields(...)`, both
inside the same template literal in `renderSections`.

**`eb37fc6` did not create that resolution; it INHERITED it.** Its parents
`b8949f9` and `a38a97e` carry the identical `component-registry.ts` blob
`abb270ee`, and their merge base is `0c5fa8d`. This record originally named
`eb37fc6` as the resolving merge and the review prompt repeated that, which
steered the arm — the arm caught it and said so. The union of the two halves is
an artifact no arm had seen until this one; the merge that made it is `0c5fa8d`.

**Blast radius is Critical and it is on the write path.** The merge control
asserted the first four posted keys **by position** — never the value, never the
cardinality, never the absence of the retired vocabulary. Append a second
`operationId` after `expectedRevision` and every assertion stayed green, while
`readFormSubmission` builds its record with `Object.fromEntries`, so the LAST
duplicate wins. **An update form would have addressed the create operation.**

Closed with both arms on the same rendered field-bearing form: exactly one
rendered `operationId` control carrying the update operation and zero rendered
`intent` controls; and the submitted multiset asserted by value and cardinality
rather than by prefix. Leading-key order is kept as a separate, weaker statement,
because order remains load-bearing for last-value-wins.

**Verified with the doctrine's own instrument — revert each parent's half alone.**
The halves are `0c5fa8d`'s, not `eb37fc6`'s: `eb37fc6`'s parents both already
contain the union, so a literal revert of either proves nothing. Reverting
`194871f`'s half (`intent` rendered alongside `operationId`) reds; reverting
`7f42380`'s half (bare inputs, no typed controls) reds; the duplicate
-`operationId` scenario reds. Baseline 2 passed, which is what proves the probe
found its subject at all.

**And the resolution's two halves are guarded by two different tests.** Reverting
to bare inputs does NOT red `CLAIM 1`, because that test asserts encoding — a
bare input still carries `value="…"`, `checkValidity()` on plain text is always
true, and the posted entries are unchanged. The typed-control half is held by
`compiled field kinds render as real browser controls`. **Anyone re-running the
revert instrument must grep both tests**, or they will read a survivor that is an
artifact of their own scope. That cost this lane one probe cycle.

## Gates

Full CI matrix green at the integrated SHA `0c5fa8d`, tree pinned before and
after the run: unit 106 · compiler 141 · performance 5 · integration 127 · agent
3 · architecture 141 · contracts 16 · postgres 196 · locale 1 · observability 11,
all 0 fail 0 cancelled; `check:app-release` and `check:demo-release` clean;
`check:reachability` PASS 101/101. `pnpm lint` carries 7 errors byte-identical on
`main`, predating this branch; the matrix runs neither lint nor typecheck.

Integration `0c5fa8d` is a `--no-ff` merge with `main` at `194871f`, so the
reviewed candidate `7f42380` remains an ancestor. One semantic conflict, resolved
as the union of both packets: `pur1-intent-limit`'s `name="operationId"`
addressing (ADR-0051) with this packet's `renderFormFields`. **That resolution
was reviewed by the merge arm and its selector-control defect is closed** — see
the class section above.

**Closure gates, separate from the integration gates above.** `main` moved 63
commits, so `eb37fc6` re-merged onto `a38a97e` and `d9c9196` carries the
selector-control closure. Full matrix green at **`d9c9196`**, tree pinned before
and after, 25m48s: unit 106 · compiler 145 · performance 5 · integration 127 ·
agent 3 · architecture 141 · contracts 16 · postgres 197 · locale 1 ·
observability 11, all 0 fail 0 cancelled; browser 77 passed;
`check:reachability` PASS 102/102. An earlier run at `eb37fc6` went red on
`table-behavior.spec.ts` with `ephemeral PostgreSQL was not ready within
30000ms`; reclaiming 111 leaked Docker volumes (119 → 8) turned the same tree
green, which is a data point for `matrix-machine-decay` rather than for this
packet.

## Known limitations, declared

- **Everything here is dark until v2 adoption.** No recorded release carries
  `fields`, so no shipped surface renders a typed control yet.
- **`CLAIM 4` of the round trip is a stand-in**, seeded from the normalised
  stage. No browser submission of this surface is acceptable to production, and
  nothing here shows a browser submission producing stored values.
- **Two `KNOWN_FALSE_GREEN` assertions remain green** while production refuses
  the create they assert. Routed to `double-must-honour-refusal`.
- **37 mutations, 0 committed, all author-chosen**, and the lane's own failure
  detection had a blind spot for most of the packet (below).
- **`data-refused-control` is read only by this packet's tests.**
- **The projection's `flatMap` drop has no control** and cannot have one while
  normalization refuses unresolved references first.

## Transferable output

These outlive the packet and are the reason to keep this record.

### Three inventories pin one test-file list, and the one that runs last is the one nothing checks

Registering one compiler test requires it in **three** places: `package.json`'s
script, `repository-hygiene`'s reviewed inventory, and
`test/helpers/reachability-producers.ts`. This lane updated two.
`repository-hygiene` compares `package.json` against the filesystem and **passed
while `reachability-producers.ts` disagreed with both** — and
`check:language-coverage`, which reads the third, runs **last, after
`test:postgres`**. A one-line omission therefore costs a full twenty-minute
matrix to discover. Integration was unaffected only because it is registered
there as a **glob**, which is why exactly one file broke and the failure looked
specific rather than structural.

Same class as `adopt-constant-illusion` and `5g3-sm-impl`'s five version
omissions — a fact stated in one place and enforced from another — with the
added cost that the enforcing gate is the slowest in the matrix. **Owed and
cheap: derive one inventory from another, or deep-equal them in the architecture
suite, which runs in the first five minutes. Do not add a fourth place to
remember.** Filed as `test-inventory-third-copy`.

### A runner that printed the SHA it was testing, and ran anyway

Lanes share `/home/rvham/2rain-greenfield`; every other lane has a detached
worktree and this one did not. Its gate poller waited nineteen minutes for a
genuinely quiet machine, took the window at 07:41:18 — and by then another lane
had switched the shared checkout to `packet/ux-reference-picker`. **The matrix
ran `f378114` with a foreign lane's uncommitted work in it** and died in five
seconds at `check:app-release` with `COMPILER_HISTORICAL_REPRODUCTION_MISMATCH`
on lineage entry 0.

**The runner wrote the SHA into its own log header and proceeded.** It recorded
the evidence of its own vacuity and did not act on it. *A gate that observes
without refusing is not a gate.* The fix is two `rev-parse` calls — one before
the run, one after — with a mismatch as a refusal rather than a note. Both
independently written pollers on this machine gated on the lock and the machine
but not on the tree, so this is a property of the convention, not of one lane.
Filed as `matrix-must-pin-its-tree`.

**A second, cheaper instance of the same shape, found later the same day:** the
poller counted holder *files* rather than live holders, so a stale record left by
a refused suite read exactly like a running matrix and blocked an idle machine
for eight minutes. The registry already prints `STALE record, NOT the current
holder`; the consumer did not ask it.

### A lock-out reads as silence

A targeted run under `run-with-test-lock.mjs` while another lane holds the lock
exits `TEST_GATE_LOCK_BUSY` **with no test output at all**, and a `grep -E '^not
ok'` over that returns empty — indistinguishable from a clean run. This lane hit
the adjacent form twice: once with a matrix piped through `tail -60`, which
destroyed the failing detail and left a completion notification carrying the
*pipeline's* exit code rather than the run's; and once with a failure grep whose
`^not ok` anchor missed indented subtest failures and reported zero reds against
a run that had nine.

**The general rule: any harness that greps for failures must first prove the
payload ran.** An empty result set is not evidence until non-emptiness of the
input is established. Read the counts, not the pattern; capture full output to a
file and read the file. Filed as `lockout-reads-as-silence` and
`matrix-evidence-truncated`.

### `KNOWN_FALSE_GREEN` — naming a manufactured green at the point of use

Two assertions in `apps/web/test/browser/surface-data-binding.spec.ts` observe
"Create complete" for an operation the real parser refuses: `ordinaryModuleV1`
declares `master_number` required while the form's bound query selects only
`master_name`, so the browser cannot submit it and `parseMutationInput` returns
`MODULE_REQUIRED_FIELD_MISSING`.

The template, and the correction that produced it:

- **Configuration and evidence are different things and need different names.**
  The constructor takes `HONOURS_PROVIDER_REFUSALS` / `IGNORES_PROVIDER_REFUSALS`
  — what the double *does* with a recorded refusal. That claims nothing about
  whether a given test reaches the branch where it matters.
- **The evidence marker sits on the ASSERTION**, not the construction site. The
  first attempt put it on five constructors while only two assert a manufactured
  success; three were read-only fixtures that never call the provider. False in
  one direction, and a sweep missed the real cases in the other.
- **The marker names the refusal, the missing input and the row it is routed
  to**, so a reader hitting it needs no archaeology.

Naming a false green does not make it valid evidence — it makes it findable.
Routed to `double-must-honour-refusal`, whose first specimens these are.

## Relation measurement — the deliverable that chartered the next packet

Measured, not built, and it refuted the queue row's framing twice.

- **No projection carries relation data.** The semantic-model projection carries
  relations only as `{constructKind, semanticFingerprint, subjectId}` — a hash,
  not a definition. `targetEntity` appears nowhere, so a picker cannot learn what
  to offer.
- **A working server-side record picker already ships** for legal entity
  (`surface-runtime.ts:555-634`): it locates a list surface by `sourceEntityId`,
  re-invokes the query gateway inside the same request, derives labels from
  `displayFieldId` with a `shortIdentity` fallback, sorts, and renders a
  `<select>`. **The gap is the wire, not the renderer.**
- **Relations are create-only, all the way down.** `relationInputs` is emitted
  only for `createRecordEffect`; `updateRecordEffect`'s `closedArgumentKeys` omit
  relations; and the provider hardcodes `relations: Object.freeze({})` on the
  update branch. A supplier set at create can never be changed.
- **A module with a required relation cannot be created from any web surface**,
  because `operationInput` never posts relations and the provider refuses with
  `MODULE_REQUIRED_RELATION_MISSING`. It has never fired only because no
  first-party module declares one yet.

Filed as `required-relation-uncreatable` and `relation-update-fork`.
