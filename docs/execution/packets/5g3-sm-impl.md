# 5g3-sm-impl — honour `transitionStateEffect`, and cut the language it owes

Status: unfrozen at `52e1726a` — the performance gate recorded
`COMPILE_BUDGET_INDETERMINATE` on a loaded machine and `lanes.md` forbids
freezing on a measurement that did not happen. Held for the slot, in the
sequence `U5b` → this packet → `PS-2`.

Tier: Critical

Base: `46a588a` (`origin/main`), merged into the branch at `262e5f5`

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

**Five defects, one shape.** Every one was a language version chosen by a human
and written as a literal, where the correct value was derivable from something
the code already had. The cut did not *create* these; it revealed them, because
a version literal is invisible until a version exists that it excludes.

| # | Site | What the literal did |
|---|---|---|
| 1 | `languageHasV2Features`, `languageUsesModuleProjectionShape` | a v5 package silently lost a released v2 rule — `CANON_RESOLVE_MATCH_AUTHORITY_VERSION_UNSUPPORTED` |
| 2 | the predicate kernel's two node-version switches | a v5 node fell to `unsupported-node-version`, which made the **default `true`** precondition unexecutable, which declined **every operation in the release** as `operation-precondition-unsupported` |
| 3 | conformance and storage lowering reading the dispatch alias | the alias rewrites `languageVersion` to the legacy literal, so both gates asked "what version is this?" and were always answered "v2" — `COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE` |
| 4 | `normalize.ts` minting the legal-entity parameter type at `'v4'` | a v5 package carrying a scope operand is refused `CANON_VERSION_MIXED`, because the node it mints disagrees with its own envelope |
| 5 | the runtime and verification copies of that node's shape | `semantic-query-gateway.ts:1343` fails `=== 'v4'`, falls through to field-type parsing, and refuses a **v5 scope operand as an unadmitted parameter type** — a package that normalized and compiled cleanly, rejected under a name describing the wrong cause |

**It takes exactly two forms, and they fail in opposite directions.**

- An **emitter** writes a literal into a node it mints (4). It fails **closed and
  loudly**, but the refusal names the mixed version rather than the hand-written
  emitter, so the reader hunts the wrong file.
- An **admitter** compares against a literal (1, 2, 3, 5). It fails **closed at a
  distance**: the refusal surfaces far from the literal and describes the
  symptom. #2 is the sharpest — a version omission in a predicate kernel
  presented as *every create operation in the release is unsupported*.

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

Four by derivation: the emitter takes `authored.languageVersion`; the kernel's
switches and the runtime's admitter derive from `SUPPORTED_LANGUAGE_VERSIONS`;
the dispatch-alias readers are *told* the authored version rather than deriving
it from an alias that cannot know it. Two by control, because the value is
legitimately pinned: see R2 and R3 below.

---

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

| | before | after |
|---|---|---|
| obligations | 1938 | **2045** |
| observed | 426 | **426** |
| ledger digest | `2be4b4de…` | `c333e37ce0d2bf2c90026b505e964bcfd63135132a06eb41897efc09d34a218d` |

All 107 additions are one node-version value per version-bearing authored axis,
plus `$.languageVersion="v5"` and the paired profile. Every one is unobserved for
a structural reason: node-version purity is uniform within a package revision, so
no module can be authored at v5 until every module is. Both *observed* decisions
are therefore **unchanged in membership** — checked against their prior
`obligationSetDigest`s — and are re-recorded only because a decision is bound to
the ledger it was reviewed against. Each carries a new identity.

## Adoption

Not measured, by ruling. The structural answer is what `PUR-1` needs: purity
forces every first-party module to v5 together, and `DEFAULT_COMPILER_PROFILE`
keys on `ADOPTED_LANGUAGE_VERSION`, so adoption moves every release root and
mints a lineage entry. **It cannot be free.** The number belongs to the packet
that pays it.

## Scope

No purchasing entity, module, mount, posting role or dependency-set change.
ADR-0049's unresolved items are untouched. The cut is made and **not adopted**.

## Gates

`52e1726a`, tree clean, typecheck clean.

| Gate | Result |
|---|---|
| `test:unit` | 92 pass, 0 fail |
| `test:compiler` | 125 pass, 0 fail |
| `test:performance` | 4 pass, **1 indeterminate** |
| everything from `test:integration` onward | **did not run** |

```
COMPILE_BUDGET_INDETERMINATE: observed CPU idle 73.9% is below required 90.0%
```

**Live `ccd-cli` runtimes at the reading: 4** (three besides this lane), with
`2rain-greenfield-ps1` running `tsc` at 210% CPU and `2rain-greenfield-u5b`
running a compiler suite. Load average 4.40 on 8 processors.

Not retried, per `lanes.md`: *"Do not retry into a loaded machine… Retrying is a
coin flip on other people's turn boundaries, and each flip costs a full matrix."*
A prior run at `73ef105a` completed green end to end, but that SHA is void —
this packet changed source after it.
