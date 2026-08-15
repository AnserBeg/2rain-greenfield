# profile-v2-adoption — adopt compiler-semantic profile v2

Tier: Critical

Base: `origin/main` at `23e7ba3`. The prompt named `5ce4b7b`; `main` had advanced
two documentation commits (`dea42f7`, `23e7ba3`) by the time the branch was cut,
which the prompt anticipated. Cut from `23e7ba3`.

Authorities:
[ADR-0047](../../decisions/ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md)
§1/§4/§4a/§5/§6/§7/§8,
[ADR-0052](../../decisions/ADR-0052-the-relation-input-reaches-the-form.md) §1/§5,
[ADR-0041](../../decisions/ADR-0041-declared-shapes-must-be-honoured-or-refused.md).
Precedent: `LANG-ADOPT-v5` (the other axis), `proj-disc-impl` (the v1 adoption).

## Outcome

`ADOPTED_COMPILER_SEMANTIC_PROFILE_VERSION` is v2. `U5b`'s deferred
`disclosureTier: 'always'` declaration lands on `party_detail`'s keyFacts slot.
One lineage entry minted, 9 → 10. Every recorded entry before it still
reproduces under the profile its own attestation records.

---

## 1. The accumulation window held THREE shapes, not two

The queue row and the session handoff both name two — `targetEntityId` and
`disclosureTier`. There are three, and the third is the largest:

| shape | where | landed by |
|---|---|---|
| `disclosureTier` | surface slots | `3241bde` (`U5b`) |
| `targetEntityId` | `relationInputs`, plus module-input-contract v3/v4 | `87c667a` (`relation-contract-integrity`) |
| `fields` | per-field kinds on every surface | `e29935d` |

`fields` is unmentioned anywhere in the queue and it is the only one of the three
that moves a compatibility floor. Adoption ships all three together, which is the
accumulation window working exactly as `U5-design` designed it — and it means the
blast radius was under-priced by every document that described this packet.

## 2. §3 — the adoption edge is an ORDINARY SOURCE EDGE

Measured in both arms rather than reasoned about.

**Arm (a), adoption alone** — move the constant, touch nothing else, rebuild:

| | |
|---|---|
| lineage | 9 → 10 |
| entry 8 release root | `3ef28127…` preserved byte-identically |
| entry 9 normalized bytes | `57e52370…` — **identical to entry 8** |
| entry 9 release root | `43e12735…` |
| `app.authored.json` | **unchanged** |

So adoption by itself is genuinely source-identical: a profile-only sibling of the
kind ADR-0047 §4 describes, which would share one package revision, make
`exact_forward_lineage` ask whether a revision is its own parent, and refuse
rollback under `ROLLBACK_ACROSS_PROFILE_ONLY_EDGE`.

**Arm (b), what this packet actually ships** — adoption plus §4a's obligation:

| | |
|---|---|
| entry 8 release root | `3ef28127…` preserved byte-identically |
| entry 9 normalized bytes | `7061077d…` — **differs from entry 8's `57e52370…`** |
| entry 9 release root | `57f0837e…` (≠ arm (a)'s `43e12735…`) |

`U5b`'s declaration edits `packages/domain/src/party/definition.ts`, so the
normalized definition moves, the two entries hold **different package revisions**,
`parent_revision_id` lineage holds, and rollback across this edge behaves
ordinarily. **An operator rolling back across it sees nothing unusual.**

`rollback-release-edge` was not touched and its defect was **not reproduced on
this edge**. The refusal does not misname itself here because it never fires here.

**The non-obvious consequence, and it is a second reason ADR-0047 was right to
bundle the declaration with the adoption:** the §4a obligation is *what keeps this
edge ordinary*. Adoption alone would have produced exactly the profile-only edge
`rollback-release-edge` describes. Nothing in ADR-0047 says this, and it is worth
saying — a future profile adoption carrying no authored change WILL land on that
defect.

**A trap worth recording.** `compile-app-release.ts` reads `app.authored.json` as
*input*; it does not regenerate it from `packages/domain/src`. Running
`build:app-release` after editing a domain definition silently compiles the STALE
authored artifact and produces a confidently wrong measurement — arm (b) initially
reproduced arm (a)'s root exactly for this reason. `generate-app-authored.ts` must
run first, and it has no `package.json` alias (already routed to row `1f`). The
drift itself IS gated, by `composed-application.test.ts`'s deep-equal against
`composedApplicationDefinition()` — so the gate exists; the footgun is in the
ergonomics.

## 3. §4 — the declaration, and the `U5c` interaction

`disclosureTier: 'always'` on `party_detail`'s keyFacts slot, restoring `U5b`'s
`27aaa53` verbatim in placement and rationale. The slot's query selects
`party_number` and `party_name` — an identifying business key and a required
field — so `ux-grammar`'s hard rule already FORCES `always` there. The
declaration states what the compiler enforces; it is not a gate-satisfying
gesture.

**`U5c` interaction, verified rather than assumed.** `validateDisclosureTiers`
(`normalize.ts`) `continue`s on `undefined || 'always'` in one condition, and
refuses `onDemand` and `progressive` by name below it. `always` is admitted on
the same line as an absent tier, so the declaration trips neither `U5b`'s refusal
nor its gate. **No predicate was added to the emptied allow-list.**

**Language coverage, re-derived rather than regenerated:**

| | |
|---|---|
| ledger digest | **UNCHANGED** — this is the profile axis, and the ledger tracks no profile version |
| obligations | 2050, unchanged |
| first-party observations | **427 → 429** |
| decisions with new identity | 2 of 3 |

Exactly two obligations left the standing exemption — `disclosureTier.$presence="present"`
and `="always"`. `="onDemand"` and `="progressive"` remain exempt, unchanged in
membership and reason, and they are `U5c`'s. The `observedRelationScope` decision
**held its identity**, which is the check that the two that moved were the only two.

## 4. §5 — the assertions, and which ones were re-pointed rather than weakened

12 `test:compiler` failures across 6 files, plus 1 `test:integration` and 3
`test:architecture` sites. ADR-0047 estimated "7 across 5 files"; the growth is
explicable — field-kind and relation-target both landed after that estimate.

**The adoption ratchets.** Three projection tests pinned `ADOPTED !== v2`
deliberately, so that whoever adopted would be forced to come and look. They were
**re-pointed at an explicit v1, not deleted**, because the property they protect —
an earlier profile carries the key not-at-all — is still true and still guards
entries 0–8.

**Re-pointing was not cosmetic.** Read through the adopted constant, three of them
would have compared a compilation *with itself*:

- `field-kind-projection`'s "v2 release root differs from the adopted one" would
  have compiled v2 twice.
- `relation-target-projection`'s two `deepEqual` blocks would both have described
  the four-key shape.

That is the exact tautology review caught in `relation-target-projection` on
2026-08-10, mirrored. **The general hazard: an assertion whose two sides are the
adopted constant and a literal version is one adoption away from becoming a
tautology, and it goes GREEN rather than red when it does.** Pin both sides to
literals whenever the property is about the difference between two versions.

**The language-axis pin gained a committed arm.** `legal-entity-query-scope`'s
"cutting v4 leaves v3 output byte-identical" moved `aac9f52d…` → `e91ef814…`. Its
previous re-derivation justified itself in a COMMENT claiming the language output
had not moved. That claim is now an assertion: recompiling the identical v3 bytes
at an explicit compiler-semantic v1 reproduces `aac9f52d…` exactly, so the pin
moved only because `DEFAULT_COMPILER_PROFILE` moved. A comment claiming that
cannot fail; an assertion can.

**And `proj-disc-impl`'s "exactly three keys move" does NOT carry over.** Five
top-level release-manifest keys move v1 → v2: the three profile-derived ones
(`compilerSemanticProfileVersion`, `semanticProfileDigest`, `cacheInputDigest`)
plus `projections` and `artifactClosure`. v1 adoption added no projection payload;
v2 has three real emissions. Do not copy that claim forward again.

**Goldens: 4 re-derived, 4 held.** Every `storage-target.manifest.*` and
`storage-target.chunk.*` golden held **byte-identically**, exactly as ADR-0047
predicted. Only the three release roots and the diff digest moved. The
`v1ProjectionFamilies` list also held — no new projection family was added.

**One assertion is genuinely weaker and it is recorded, not absorbed.**
`requiredRuntimeCapability.minimumVersion` is `emitsFieldKinds ? 3 : navigation ? 2 : 1`,
so adoption moves it 1 → 3 on every manifest and 3 outranks the grouping bump.
All three arms of `surface-grammar-conformance` now read 3 where they previously
discriminated flat (1) from grouped (2). The grouping behaviour is still gated by
`payloadSchemaVersion` and `navigationSurfaceIds`, so nothing is unguarded — but
the assertion is weaker than it reads, and the loss is stated at the call site.

## 5. §5's degeneracy question — it persists, and this packet made it worse

The ratchet's comment said its own assertion is DEGENERATE because adopted and
latest-readable are both v1. **After adoption both are v2, so the degeneracy does
not resolve. It deepens.**

The compiler-semantic axis was **the one place left in the tree where "take the
adopted version" and "take the newest readable" could disagree**: readable
`[v0, v1, v2]` with adoption on v1, so substituting
`SUPPORTED_COMPILER_SEMANTIC_PROFILE_VERSIONS.at(-1)` moved `DEFAULT_COMPILER_PROFILE`
from v1 to v2 and would have moved every recorded release root — a loud red,
available for free.

**Adoption consumed it.** Measured at `f664a8f`: compiler-semantic is
`[v0, v1, v2]` with **v2** adopted; language is `[v0-experimental, v1..v5]` with
**v5** adopted. Both axes now have adopted == last-readable, so
`adoption-selector-seam`'s own owed red — the `.at(-1)!` mutation — **cannot be
made to fire against production anywhere in the tree.**

Does the separate selector proof still carry the weight the comment assigns it?
**Exactly that weight and no more.** `selectAdoptedProfileVersion` is genuinely
proven on a constructed readable set whose adopted member is not its last, and
adoption does not touch that proof. What it does not establish, and never did, is
that production is *built by* that function rather than by an inlined rule that
happens to agree — "the default profile is the selector applied to the live axes"
is an equality between two expressions that cannot disagree while adoption is
last. That was already true; it is now true on both axes at once.

Routed to `adoption-selector-seam`, which owns it. Not repaired here.

## 6. Evidence

**Committed control, new:** *the adopted entry carries the gated fields in
ARTIFACTS, not only in digests* (`compiler-semantic-profile.test.ts`). Decodes
each entry's artifact bytes and counts the field itself, because `U5b` reported
eight artifacts differing while the tier appeared in **zero** artifacts of either
entry — all digest churn.

| | v1 entry (−2) | v2 entry (−1) |
|---|---|---|
| relation inputs carrying `targetEntityId` | **0 of 6** | **6 of 6** |
| artifacts carrying `disclosureTier` | **0** | **1** (106 slots) |

Counted per relation input, not per artifact — "some artifact mentions the key" is
satisfied by one relation of six. Paired across the adoption, because a
presence-only assertion is satisfied by a projection emitting under every profile,
which is the change that would have moved the recorded roots. The digest-churn
twin is asserted too, so the distinction the control rests on is itself observed.

**Committed control, pre-existing and now more armed:** *historical reproduction
reads the profile from the entry, not the constant* — the §5 invariant inverted,
with its admission twin. Its gap widened from v0-vs-v1 to v0-vs-v2.

**Mutations: 0 committed harness, 5 ad-hoc, all self-chosen.** Reported as such
per `review-tiers`; a self-chosen table measures the author's model.

| mutation | result | assertion that fired |
|---|---|---|
| adopted constant → v1 (artifacts untouched) | red | *consecutive lineage entries may share a normalized definition* — a **pre-existing** control, not mine |
| strip `targetEntityId` from head artifacts (6 sites) | red | every v2 relation input carries its target |
| strip `disclosureTier` from head artifacts (106 sites) | red | the v2 entry must carry the tier in a real artifact |
| plant `targetEntityId` in the v1 entry (6 sites) | red | no v1 relation input may carry a target |
| plant `disclosureTier` in the v1 entry (106 sites) | red | the v1 entry must carry the tier in no artifact |

Four distinct checks, four distinct messages — per-check attribution, presence and
absence for both fields. The first mutation's honest reading is that it does **not**
red my control, because my control reads the recorded artifact rather than the
constant; it reds a different, pre-existing one.

**A red I initially mis-read, recorded because the doctrine exists for it.** The
first run of mutation 1 produced `pass 0 fail 1` — a module-level `ReferenceError`
from an import I had removed, not the control firing. Re-run with the import
restored, it red for the stated reason.

## 7. Findings filed, not fixed

- `runtime-capability-floor-unenforced` (**new**) — the floor moved 1 → 3 and
  **nothing enforces it**. The only `minimumVersion` comparison in the tree is the
  compiler's dependency-validity check; the provider persists it and the web
  reader passes it through. `component-registry.ts`'s own comment says a reader
  without field support "must refuse it rather than fall back". No such refusal
  exists.
- `demo-shell-profile-untracked` (**new**) — "the demo shell stays on
  `v0-experimental`" is true of the **language** axis only.
  `compile-demo-release.ts` spreads `DEFAULT_COMPILER_PROFILE` and overrides
  language but not `compilerSemanticProfileVersion`, so the shell's semantic
  profile silently tracks the adopted constant. Regeneration was correct and
  ADR-0047 prescribed it; the guidance is what is misleading.
- `adoption-selector-seam` (**amended**) — see §5 above.

## 8. Cross-lane: path-disjoint is not effect-disjoint

`form-wire-semantics` and this packet share no file. Adoption nonetheless changes
what that lane's files DO: `component-registry.ts:1116` reads `surface.fields ?? []`,
a branch that was **dead against the shipped application** under v1 because no
manifest carried the key. Adoption makes `fields` present on all 12 surfaces, so
typed form controls render against the real app for the first time — in a file the
other lane is concurrently rewriting.

Neither diff shows this. It is visible only by reading the compiled artifact
against the other lane's reader. **Whoever lands second owes a full matrix at the
integrated SHA including `test:browser`**, which is the suite that can observe it.

## 9. The user-visible surface is NOT thin, and a browser test is the proof

The packet charter says *"adoption's user-visible surface is thin by design, so
say honestly what a person can and cannot observe."* **That is false for this
adoption, and the honest answer is the opposite of the one the charter expected.**

It was true of the v1 adoption, which carried no projection payload. v2 carries
per-field kinds, and `renderFormControl` (`apps/web/src/component-registry.ts`)
branches on exactly that:

```
if (!field) return `<input name="${name}" …>`;   // the v1 path — a bare text box
switch (field.kind) { case 'enumFieldType': …<select>…  case 'booleanFieldType': …checkbox…
                      case 'dateFieldType': …type="date"…  case 'timeFieldType': …type="time" step=… }
```

Under v1 the `fields` key was absent from every shipped manifest, so **every form
field in the running application fell through to the bare-input branch**. Counted
in the artifact this packet mints:

| field kind | count | control before | control now |
|---|---|---|---|
| `textFieldType` | 107 | `<input>` | `<input>` (unchanged) |
| `enumFieldType` | 28 | `<input>` | `<select>` |
| `dateTimeFieldType` | 18 | `<input>` | date-time control |
| `exactDecimalFieldType` | 14 | `<input>` | numeric control |
| `integerFieldType` | 8 | `<input>` | numeric control |
| `booleanFieldType` | 3 | `<input>` | checkbox |

across nine first-party form surfaces. **A user typing `northstar.location:option.store`
into a text box now picks "Store" from a dropdown.**

This was not predicted by the lane and was not found by reading — it was found by
`location-runtime.spec.ts` failing, which is the better outcome. The spec did
`getByLabel('Location Type').fill(…)`; Playwright refused, naming the element:
*"Element is not an `<input>` … locator resolved to `<select
data-field-kind="enumFieldType">`"*. Corrected to `selectOption`, which preserves
the assertion's meaning and changes only its shape.

**The first matrix at `c843c0f` was RED and is reported as measured.** Three
browser specs failed; the three did not share a cause:

- **catalog-runtime, party-runtime — machine pressure, not this packet.** Both
  pass on a quiet re-run. Both harnesses print their READY line immediately when
  started standalone. Load average was 5.14 during the browser phase and docker
  volumes grew 35 → 38 across the run. `container-pressure-forges-outcomes`'
  subject; container state recorded rather than re-run blind, per the charter.
- **location-runtime — real, and this packet's doing.** It reds on a quiet
  machine too, with the `<select>` diagnostic above.

Reading all three as one cause would have been wrong in both directions: it would
have blamed the packet for two failures it did not cause, and excused the one it
did.

## 10. Gates under the changed doctrine, and a second reproduction of the forged outcome

**Doctrine moved mid-packet.** `git-workflow` `bc28c2f` (2026-08-14) ruled *"the
matrix runs AFTER review converges, not before it"* and cites this packet's own
red at `c843c0f` as part of its evidence. A freeze now means **cheap gates plus
the packet's blast-radius suites green**, and the full matrix runs once at the
SHA that will integrate. `mission-cadence` `d5159dd` separately binds a lane to
**write** its review prompt and never **run** it.

This packet's blast-radius set, per the new rule's own naming (a packet changing
compiler or release output runs `test:postgres` and `check:app-release`), plus
`test:browser` because §9 established the adoption reaches rendered controls.

| gate | result |
|---|---|
| `typecheck` | exit 0 |
| `lint` | exit 0 |
| `format` | exit 0 |
| `check:app-release` | exit 0 |
| `test:browser` | **77 passed**, exit 0 |
| `test:postgres` | **197/197**, exit 0 (after the volume reclaim below) |

`test:browser` at 77 passed is itself the evidence that §9's correction was right:
the earlier quiet re-run was 62 passed / 1 failed / 14 did not run, and all 77 now
execute and pass.

### `test:postgres` reproduced `container-pressure-forges-outcomes` exactly

The first run of the pair failed 189/1:

```
not ok 8 - composed product activates through the kernel and persists tenant-scoped gateway data
  error: 'composed release activation did not verify: NO_SWAP_TERMINAL'
```

**That is the queue row's signature verbatim** — same test name, same outcome
code, same string. The row records it measured *"on `main` alone at `b289911` in
a worktree carrying none of the packet — so it was pre-existing and not the
merge"*, and passing *"16/16 on the same merged tree after reclaiming 27 leaked
anonymous volumes."*

**The discriminator, and it is decisive rather than suggestive.** The only
executable change between the SHA where this suite ran **197/197 green**
(`c843c0f`) and the SHA where it failed (`f6ca221`) is
`apps/web/test/browser/location-runtime.spec.ts` — a Playwright spec the
PostgreSQL suite neither loads nor executes:

```
git diff --name-only c843c0f f6ca221 -- . ':!docs' ':!.agents' ':!CLAUDE.md' ':!AGENTS.md' ':!learnings.md'
  apps/web/test/browser/location-runtime.spec.ts
```

So the packet delta **cannot** be causal. Re-running the same file in isolation
gave **16/16**, matching the row's own recorded number.

**Container state, recorded rather than re-run blind, as the charter instructs:**
volumes stood at 35 at session start, 38 after the first matrix, and **44** when
this failure occurred; load average 2.20. Remediation was the row's own — 36
dangling anonymous volumes reclaimed (44 → 8 total), every named volume left
intact, no orphaned `release-activation` container present. The suite was then re-run in full and returned **197/197, exit 0**, with the
volume count stable at 8 -- the same 197 it returned at `c843c0f` before the
pressure built. Three observations now agree: 197/197 clean, 189/1 under
pressure, 16/16 isolated.

**This is a second independent reproduction with a clean discriminator**, which
is what that row most needs: the first was measured by `ux-picker`, this one by a
packet touching neither the release kernel nor the provider. **Do not read the
first red as evidence about this packet's code.**
