# 5g3-sm-impl — honour `transitionStateEffect`, and cut the language it owes

Status: re-frozen after review BLOCK. A prior freeze at `b83b810a` was green end
to end; review then found the transition permission unenforced, and this record
carries the tree that fixes it.

Tier: Critical

Base: `origin/main` including `U5b` (`8c36c05`), merged at `b83b810`

Authorities:
[ADR-0050](../../decisions/ADR-0050-the-record-transition-carrier.md) (ratified,
§7.11 of the purchasing plan),
[ADR-0047](../../decisions/ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md)
§2 and §7,
[ADR-0041](../../decisions/ADR-0041-declared-shapes-must-be-honoured-or-refused.md),
[ADR-0046](../../decisions/ADR-0046-rollback-activates-history-and-defects-refuse-by-name.md).

## Outcome

`transitionStateEffect` executes. A state machine materializes its state field
as an ordinary enumeration field on its entity, so a document has exactly one
state — addressable by a predicate, selectable by a query, and written only by a
transition whose target is declared by the release rather than supplied by the
caller.

Language `v5` and `northstar.normalization/v5` are cut and **not adopted**. The
gate is what keeps the cut free: a v4 package normalizes byte-identically, so no
recorded release root moves and `check:app-release` reproduces the whole lineage.

---

## The finding this packet is actually worth: a version written by hand

**Seven defects, one shape.** Every one was a language version chosen by a human
and written as a literal, where the correct value was derivable from something
the code already had. The cut did not *create* these; it revealed them, because
a version literal is invisible until a version exists that it excludes.

**Two of the seven were found by review, after this packet had named the class
and swept for it.** That is the most useful fact in this record: naming a defect
class and grepping for its most obvious spelling is not the same as closing it.
Rows 6 and 7 are mine by my own definition and I did not find them.

| # | Site | What the literal did |
|---|---|---|
| 1 | `languageHasV2Features`, `languageUsesModuleProjectionShape` | a v5 package silently lost a released v2 rule — `CANON_RESOLVE_MATCH_AUTHORITY_VERSION_UNSUPPORTED` |
| 2 | the predicate kernel's two node-version switches | a v5 node fell to `unsupported-node-version`, which made the **default `true`** precondition unexecutable, which declined **every operation in the release** as `operation-precondition-unsupported` |
| 3 | conformance and storage lowering reading the dispatch alias | the alias rewrites `languageVersion` to the legacy literal, so both gates asked "what version is this?" and were always answered "v2" — `COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE` |
| 4 | `normalize.ts` minting the legal-entity parameter type at `'v4'` | a v5 package carrying a scope operand is refused `CANON_VERSION_MIXED`, because the node it mints disagrees with its own envelope |
| 5 | the runtime and verification copies of that node's shape | `semantic-query-gateway.ts:1343` fails `=== 'v4'`, falls through to field-type parsing, and refuses a **v5 scope operand as an unadmitted parameter type** — a package that normalized and compiled cleanly, rejected under a name describing the wrong cause |
| 6 | **three more** `!== 'v4'` in the same gateway's scope parser — *found by review* | a legal v5 scoped query normalizes, compiles, and is then refused as a malformed pinned catalog. My sweep matched `=== 'v4'` and missed the negated spelling, and my control stopped at normalization so it could never reach this reader |
| 7 | `languageHasMaterializedStateFields` testing an **exact** feature level — *found by review* | its own comment claimed a v6 cut could not drop the rule. False: a v6 package would silently stop materializing. The gate this cut added was itself an instance of the class it was added for |

**It takes exactly two forms, and they fail in opposite directions.**

- An **emitter** writes a literal into a node it mints (4). It fails **closed and
  loudly**, but the refusal names the mixed version rather than the hand-written
  emitter, so the reader hunts the wrong file.
- An **admitter** compares against a literal (1, 2, 3, 5, 6, 7). It fails **closed
  at a distance**: the refusal surfaces far from the literal and describes the
  symptom. #2 is the sharpest — a version omission in a predicate kernel
  presented as *every create operation in the release is unsupported*.

**And derivation is not automatically correct.** Fixing row 6 by deriving from
`SUPPORTED_LANGUAGE_VERSIONS` admitted `v3` — a version that never declared the
legal-entity operand — and an existing forgery control refused it. The admitted
set is *"versions whose language declares this node"*, not *"versions that
exist"*. I derived from the nearest list rather than the governing property.
The fence is now pinned from both sides, each with its own recorded red: widen
it and the forgery control fires; narrow it back to the literal and the v5
control fires.

**A grep is not a sweep.** Row 6 survived because I searched for `=== 'v4'` and
the code said `!== 'v4'`; row 7 survived because I was looking for literals in
comparisons and this one was a *predicate I had just written*. The durable form
of the sweep is not a pattern, it is the question **"what does this compare
against, and where did that value come from?"** asked of every version-bearing
line.

**Why three predicates' worth of testing missed #4 and #5.** A v5 package
*without* a legal-entity scope operand normalizes perfectly. The shape must be
present for the defect to exist, and no generic version fixture carries it. A
version-cut checklist that only compiles a plain package at the new version
proves nothing about the shapes the new version cannot express.

**The rule this yields, and it is reusable beyond this cut:** a language version
is derived or it is a defect waiting for the next cut. Derive it from the
package (`authored.languageVersion`), from the supported list
(`SUPPORTED_LANGUAGE_VERSIONS`), or from the feature level — never from a
literal. Where a literal is genuinely unavoidable, it owes a control that reds
when it goes stale, and the control must carry the shape, not just the version.

The code says this in its own voice already, one line above the first defect:

> Feature levels are cumulative. Leaving a newly cut version out of a
> predecessor's check is how a version cut silently drops a released rule.

That comment was correct, present, and did not prevent four more instances of
what it describes. **A warning is not a control.**

### Where each is closed

All seven by derivation. The emitter takes `authored.languageVersion`; the
kernel's switches and all four gateway admitters derive from
`SUPPORTED_LANGUAGE_VERSIONS` through one `isSupportedNodeVersion`; the
dispatch-alias readers are *told* the authored version rather than deriving it
from an alias that cannot know it; and the materialization gate now asks the
**ordered** supported list — "at or after the version that introduced the rule" —
so a v6 cut inherits it with nothing to remember. Its siblings enumerate their
levels, which is why each had to be edited by this cut and why one was missed.

R2 and R3 below add the controls for the values that remain legitimately pinned.

---

## The blocker review found: two permissions, one honoured

The language declares `transitionDefinition.permission` (`schemas.ts:634`) and
the operation's permission. The gateway authorizes `definition.permissionId` —
the operation's — and the compiled effect carries no permission at all. **A
transition declared `release_restricted` under an operation declared
`edit_basic` executes on `edit_basic`.**

This is §1's defect class, one field down, re-introduced by the packet that
closed it. **The vertical could not observe it**: it declares one permission id
in both positions, so its policy cannot tell the two declarations apart. A
control that reuses an identity cannot witness a rule about two identities
agreeing — which is a sharper lesson than the fix.

Closed by [ADR-0050 §7](../../decisions/ADR-0050-the-record-transition-carrier.md):
equality, refused by name at compile time
(`COMPILER_TRANSITION_PERMISSION_MISMATCH`), with **both** controls — mismatch
refused, and the matched case still compiling. Without the second, the first is
satisfiable by refusing every transition.

## The six items ADR-0050 owed

| # | Item | Closed at |
|---|---|---|
| 1 | **the read path** — load-bearing for `PUR-1` | materialization puts the field in `packageRevision.fields`, so a query selects it; asserted on the transition's own read-back **and** through `master_list` |
| 2 | release verification probing a field no caller may write | `projections.ts` no longer *plans* `enumReject`/`searchableExclusion` for it. Not emitting is not skipping — ADR-0020:156 admits nothing unexecuted |
| 3 | which layer owns the closed contract | the gateway, for transitions as well as capabilities; the interpreter keeps the inner of two |
| 4 | ~~the per-entity field budget~~ | **withdrawn as a misattribution** — a wall-clock gate under load, whose fixture is v3 with zero machines. The real consequence is narrower: `families.fields` is package-wide and counted after normalization, so N machines cost N |
| 5 | `apps/web`'s `operationIntent` returning `null` | binds to the `command` intent; tier follows the effect, not the intent. The one-operation-per-intent limit is now **declared**, and is owed before a document with both a release and a cancel reaches a surface |
| 6 | the misnamed refusal | closed twice — `COMPILER_TRANSITION_EFFECT_UNSUPPORTED` makes the release unbuildable below v5 by name and subject, and every catalog refusal now names its operation and effect |

## The four review requirements

Two already held. Both were proved by breaking them, not by reading them.

| # | Requirement | Verdict | Recorded red |
|---|---|---|---|
| R1 | append-only survives rename / value change / reorder | **already held** | rename `v3` → `v3legacy`: **9** reds; reorder the supported list: **1** red |
| R2 | ratchet stays green while a default selects LATEST | **added** | pointing `DEFAULT_COMPILER_PROFILE` at LATEST reds `the newest readable version is reported, never selected` |
| R3 | envelope-only probe ≠ nested refusal | **added** | widening `nodeVersion` reds the pair, and it fires *before* the pre-existing probe |
| R4 | counts stay green if the validator invocation is deleted | **already held** | deleting it from the chain reds `the language gate is wired into local, matrix, and hosted acceptance paths` |

R2 closes the selector gap structurally *and* behaviourally: production source may
**report** the newest readable version (interpolated into operator text) but never
**select** it, and every default is asserted to follow `ADOPTED` across the gap.

## Coverage decisions — re-derived, digests recorded

Re-derived **twice** — once for the cut, then again over the ledger that already
carried `U5b`'s disclosure tier, because the merge conflicted here and choosing
either side would have produced a green gate over a digest neither packet
reviewed.

| | before the cut | after `U5b` | merged |
|---|---|---|---|
| obligations | 1938 | 1943 | **2050** |
| observed | 426 | 427 | **427** |
| ledger digest | `2be4b4de…` | `b004419f…` | `29b4dc6c05687d8ff7c8fab91c70e4877b8e7a8d062b1c76e4dd486cc9509b1f` |

All 107 additions are one node-version value per version-bearing authored axis,
plus `$.languageVersion="v5"` and the paired profile. Every one is unobserved for
a structural reason: node-version purity is uniform within a package revision, so
no module can be authored at v5 until every module is. Both *observed* decisions
are therefore **unchanged in membership** — verified byte-for-byte against
`U5b`'s own `obligationSetDigest`s, not merely against the pre-cut ones — and are
re-recorded only because a decision is bound to the ledger it was reviewed
against. Each carries a new identity.

**The expiry is executable, not prose.** The validator compares a decision's
recorded category against the current observation and throws
`LANGUAGE_COVERAGE_OBSERVATION_CHANGED` before a stale decision can cover an
obligation whose partition moved. Adoption will trip it, which is the intent.

## Adoption

Not measured, by ruling. The structural answer is what `PUR-1` needs: purity
forces every first-party module to v5 together, and `DEFAULT_COMPILER_PROFILE`
keys on `ADOPTED_LANGUAGE_VERSION`, so adoption moves every release root and
mints a lineage entry. **It cannot be free.** The number belongs to the packet
that pays it.

## Scope

No purchasing entity, module, mount, posting role or dependency-set change.
ADR-0049's unresolved items are untouched. The cut is made and **not adopted**.

## Additional controls from the review BLOCK

| Control | Proves |
|---|---|
| transition permission mismatch refused | `COMPILER_TRANSITION_PERMISSION_MISMATCH` names the operation |
| matched permissions still compile | the rule is not satisfied by refusing everything |
| a compiled v5 scoped query reaches the **runtime** catalog reader | the gap row 6 lived in; the earlier control stopped at normalization |
| an authored field wearing the derived state identity | `CANON_STATE_FIELD_COLLISION` — a bare id match no longer suppresses and counterfeits the carrier |

The collision guard and the field generator now share **one** definition of the
derived field. Two copies would drift, and a guard that drifts from what it
guards is worse than none.

## Gates — one full matrix at the frozen SHA

`FULL_MATRIX_PASS_SHA=40b40291`, tree clean, typecheck clean.

| Step | Result |
|---|---|
| demo-release, app-release | pass |
| unit / compiler / performance | green |
| integration / agent / architecture | green |
| contracts / postgres / locale | green |
| browser | 67 passed (2.7m) |
| `check:language-coverage` | **PASS** — 2050 obligations, 2050 decision-covered, 427 first-party observations |
| `check:reachability` | **PASS** — 99/99 test files, 10 producer artifacts |

694 assertions passed, 0 failed, `MATRIX_EXIT=0` read from inside the log.

**The compile-budget gate measured**: `cpu_idle_pct=97.9` against the 90.0 floor,
best-of-5 wall 1371.4 ms against 5000 ms. Pre-flight at launch: registry empty,
99.1% idle, loadavg 0.98, no worktree busy, **2 `ccd-cli` runtimes**.

### What the failed runs cost, and what changed

Four matrices failed before this one. Two found real defects — an over-wide
version fence that an existing forgery control refused, and the transition
permission itself. **Two were residue of my own**: a prohibited word in a
comment, and a pinned line number the permission rule had moved.

After the third, verification moved before the matrix rather than after it: the
gateway vocabulary sweep, full integration and full architecture run locally
first. That pass immediately caught the pinned line and a lock-contention red —
two more failed matrices that never happened. **Roughly fifty minutes of machine
time was spent learning that three minutes of local checks come first.**
