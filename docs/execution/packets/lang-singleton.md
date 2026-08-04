# lang-singleton — the coverage ledger must not hide singletons

Status: candidate

Tier: Critical

Base: `30f50e8d63a482925f5840bc711e620275de090e`

Authorities:
[ADR-0041](../../decisions/ADR-0041-declared-shapes-must-be-honoured-or-refused.md),
AGENTS.md section 6 (a gate observes the fact it asserts, and ships a negative
control for each way it could pass vacuously).

## Outcome

An axis reachable in the authored surface now stays represented at size 1. The
derived ledger admits every path carrying at least one closed value, in both
specifications, so a shape's obligation no longer depends on how many siblings
it happens to have.

The consequence the packet exists to produce: **narrowing an axis from two
values to one moves the ledger digest.** Before this change it did not — it
produced the *same* digest as deleting the member from the language.

## Why `forced` did not fire for cardinality

The `forced` mechanism was not bypassed. It was **structurally unreachable**,
and the cause is classification rather than the flag.

`forced` was raised from exactly three branches of the walker: finite members of
a union (`:663`), the two boolean literals (`:676`), and the `$presence` pair for
an optional property (`:694`). The fourth and only remaining `add` site — a bare
finite type at `:672` — did not raise it. So `forced` did not mean "this axis is
a real choice." It meant "this axis was produced by one of three specific
syntactic branches."

**A single-member union is not a union in TypeScript.** `z.enum(['none','query'])`
gives the type `'none' | 'query'`, a `UnionType`; `z.literal('manyToOne')` gives
the type `'manyToOne'`, a bare `StringLiteral`. Narrowing an enum to a literal
therefore does not narrow a union — it changes the type's *kind*, and the walker
dispatches on kind. The axis stops entering the union branch entirely and falls
through to `:672`, unforced. `forced || values.size > 1` then drops it.

Verified rather than believed, by probing the checker at the real root
`VersionedAuthoredApplicationPackage`:

```text
$.relations[].cardinality:     type="manyToOne"          isUnion=false  flags=128 (StringLiteral)
$.relations[].joinEligibility: type="query"|"none"|undef isUnion=true   flags=1048576 (Union)
$.relations[].ownership:       type="reference"|"parentScopedChild"     isUnion=true
$.relations[].kind:            type="relationDefinition" isUnion=false  flags=128 (StringLiteral)
```

The same probe showed the authored derivation carried **42 candidate axes that
were unforced singletons**, every one of them produced solely by `:672`, and
**every dropped axis was one of those 42** — the filter's two clauses had no
other effect on the authored surface.

### So flipping `includeSingletons` would have been the wrong description of the fix

Because the cause is classification, `includeSingletons` and `forced` were two
spellings of one filter that could never distinguish what it claimed to. `:672`
is the only unforced `add` site, so forcing it would have made `forced`
universally true, which makes `forced || size > 1` universally true, which is
exactly `size > 0` — the lowered branch. The two candidate fixes are the same
fix, and both leave behind a flag and a parameter that read as if they were
deciding something.

Both were therefore removed rather than flipped. The rule is now structural: an
axis exists iff at least one closed value was observed at its path.

## Before and after

| Measure | Before | After |
| --- | --- | --- |
| obligations | 1,896 | **1,938** (+42) |
| ledger axes | 398 | 440 (+42) |
| relation-scope obligations | 91 | **95** (+4) |
| relation partition | `91 = 0 + 89 + 2` | **`95 = 0 + 93 + 2`** |
| first-party observations | 395 | 426 (+31) |
| obligations that DEPARTED | — | **0** |
| pre-existing axes whose value set moved | — | **0** |
| pre-existing obligations whose observation moved | — | **0** |

The count changed, and it changed upward. Both halves were checked: nothing left
the ledger, and no obligation that already existed changed either its values or
its observed/unobserved partition. The entire delta is 42 additions.

Both ledgers were derived by executing the real derivation — the base helper was
materialized from `30f50e8d` and run against the same tree in the same process
as the fixed one, so the comparison is two derivations, not a derivation against
a remembered number.

### The 42 newly visible obligations, each classified

The four in relation scope are the ones that matter, because
`LANGUAGE_COVERAGE_DEFECT_INVENTORY_OUTSIDE_PHASE1` restricts the defect
inventory to relation scope — nothing outside it can be recorded as
accepted-but-unhonored at all.

| Newly visible relation obligation | Machinery that implements it | Verdict |
| --- | --- | --- |
| `$.relations[].cardinality="manyToOne"` | lowered to a nullable FK column; witnessed by `5g3-langnarrow`'s lowering assertion and 19/19 real-PostgreSQL execution. This is the obligation langnarrow recorded departing as **HIDDEN**; it is restored. | **HONEST — supported** |
| `$.relations[].foreignKeyActions.onDelete="restrict"` | `module-storage-materializer.ts:1222` refuses any value other than `restrict`, and `:1252`, `:1321`, `:1601` emit `ON DELETE RESTRICT ON UPDATE RESTRICT` into real DDL. | **HONEST — supported** |
| `$.relations[].foreignKeyActions.onUpdate="restrict"` | same guard and same emitted DDL. | **HONEST — supported** |
| `$.relations[].kind="relationDefinition"` | the node's identity tag; `z.literal` refuses any other spelling at authoring. | **HONEST — supported** |

**No newly visible obligation is accepted-but-unhonored, and the tripwire did
not fire.** That is a per-obligation finding, not an inference from the total.
The structural reason it came out this way is worth stating plainly: the filter
admitted exactly the axes whose type is a bare literal, and a bare literal admits
exactly one value — so none of the 42 is a spelling an author could choose and
have the platform discard. What was hidden was the language's inventory of
declared constants, not a hidden defect field. The relation four were each
checked against ADR-0041's actual test — *does the machinery implement what the
declaration says* — rather than against that structural argument alone, because
a singleton **can** be unhonored (`cardinality` would have been, had the lowerer
implemented nothing).

The remaining 38 are outside relation scope and are listed here so the growth is
named rather than summarized:

- **29 further node-identity tags** (`kind` / `valueKind` discriminants):
  `$.kind`, `$.assertions[].kind`, `$.capabilityRequirements[].kind`,
  `$.entities[].kind`, `$.fields[].kind`, `$.fields[].fieldType.options[].kind`,
  `$.fields[].storageEvolution.kind`, `$.modules[].kind`,
  `$.modules[].composition.kind`, `$.operations[].kind`, `$.package.kind`,
  `$.permissions[].kind`, `$.queries[].kind`, `$.queries[].aggregate.kind`,
  `$.queries[].legalEntityScope.kind`,
  `$.queries[].legalEntityScope.operand.kind`, `$.queries[].parameters[].kind`,
  `$.queries[].resolveMatchKeys[].kind`, `$.queries[].selections[].kind`,
  `$.stateMachines[].kind`, `$.stateMachines[].stateField.kind`,
  `$.stateMachines[].stateField.valueKind`, `$.stateMachines[].states[].kind`,
  `$.stateMachines[].transitions[].kind`, `$.storageMappings[].kind`,
  `$.storageMappings[].promotion.kind`, `$.surfaces[].kind`,
  `$.surfaces[].renderer.kind`, `$.surfaces[].slots[].kind`.
- **9 declared constants**: `$.fields[].fieldType.calendar="iso8601"`,
  `$.fields[].fieldType.representation="canonicalString"`,
  `$.modules[].composition.status="unsupported"`,
  `$.queries[].aggregate.operator="sum"` (consumed at `compiler.ts:1226` and
  `predicate-lowering.ts:69`), `$.queries[].maximumResultCount=1` (consumed at
  `resolve-by-name.ts:41` as the query limit),
  `$.queries[].legalEntityScope.schemaVersion="v4"`,
  `$.queries[].legalEntityScope.operand.schemaVersion="v4"`,
  `$.storageMappings[].promotion.capabilityId=…`,
  `$.storageMappings[].promotion.invariantVersion=…`.

The 42 are 30 node-identity tags and 12 declared constants. One tag
(`$.relations[].kind`) and three constants (`cardinality`,
`foreignKeyActions.onDelete`, `foreignKeyActions.onUpdate`) sit in relation scope
and are tabled above, leaving the 29 tags and 9 constants listed here.

**One of these deserves naming rather than filing.**
`$.modules[].composition.status="unsupported"` has **no consumer anywhere** —
repository-wide search finds it declared in `schemas.ts:502` and written by
module definitions, and read by nothing. It is not an ADR-0041 violation, because
its single admitted value *declares a non-capability*: there is no semantics for
the platform to fail to implement, and no alternative spelling to discard
silently. It is recorded here because it is exactly the kind of member that
`lang-retire` will have to reason about, and because it was invisible until now.

The five `$.stateMachines[]` tags are likewise named deliberately. ADR-0041's
Context calls `stateMachines` the **first** confirmed instance of the
declared-but-unenforced class and its "What this ADR does not decide" section
routes it to its own debate. Nothing here changes that: the five newly visible
obligations are the state machine's node tags, not the transition semantics the
open question is about, all five are unobserved (no first-party module declares
a state machine), and relation-scope restriction means they could not be
recorded in the defect inventory even if they were.

## Controls, and the recorded reds

Both controls were written **before** the fix and run against the unmodified
instrument. The reds below are verbatim from that run.

### Replay control — a narrowed axis keeps its obligation

`singleton-narrowing control keeps the obligation of an axis narrowed to one
unhonored value` derives the real ledger from a temporary root, using the same
machinery as the existing `derived-subject` control, in two states:
`joinEligibility: 'none' | 'query'` and `joinEligibility: 'query'` — the exact
scenario langnarrow hit, where the survivor is a value still accepted with zero
consumers. Recorded red against the pre-fix instrument:

```text
not ok 1 - singleton-narrowing control keeps the obligation of an axis narrowed to one unhonored value
  error: |-
    an axis narrowed to a single value must stay represented at size 1
    + actual - expected

    + undefined
    - [
    -   'query'
    - ]
  operator: 'deepStrictEqual'
```

The axis did not shrink. It was **gone**, and `authoredLanguage:$.joinEligibility="query"`
went with it.

The control also asserts the same rule on the **real** language rather than only
a synthetic one: `$.relations[].cardinality` must be present with values
`['manyToOne']`. That is the obligation langnarrow had to record as HIDDEN.

### Removal control — the fix does not pin everything forever

`removal control distinguishes an axis retired from the language from one
narrowed to a singleton` adds a third state in which the member is absent
entirely, keeping a companion axis so the authored surface is not empty. Recorded
red against the pre-fix instrument:

```text
not ok 2 - removal control distinguishes an axis retired from the language from one narrowed to a singleton
  error: 'removed-from-the-language and narrowed-to-an-unhonored-singleton are different facts and must not share a digest'
  expected: '94f1efc571481c84d8cf906b60b29d59b1ac26b58b21825b26b5e23e01c042a7'
  actual:   '94f1efc571481c84d8cf906b60b29d59b1ac26b58b21825b26b5e23e01c042a7'
  operator: 'notStrictEqual'
```

That is langnarrow's `b4cf5f06…` measurement reproduced as an executable
control: **byte-identical digests for two facts with opposite meanings.**

After the fix the three states separate, and the separation is one-sided in
exactly the right direction:

| Synthetic state | Digest before | Digest after |
| --- | --- | --- |
| admits `'none' \| 'query'` | (distinct) | `b0322a8636dcb9f6ac676b7bfa7ef9ca9ac698d2494168caf127ae96319b2051` |
| narrowed to `'query'` | `94f1efc571481c84d8cf906b60b29d59b1ac26b58b21825b26b5e23e01c042a7` | `66edb268adb0997b107a30f4befabe82eea6a91ea55b81f627d8fd9114fccabf` |
| member removed | `94f1efc571481c84d8cf906b60b29d59b1ac26b58b21825b26b5e23e01c042a7` | `94f1efc571481c84d8cf906b60b29d59b1ac26b58b21825b26b5e23e01c042a7` |

The removed state's digest is **unchanged** by the fix; only the narrowed state
moved. The collision was the narrowed state being silently rewritten into the
removed one, and that is what was corrected.

The removal control also asserts the companion axis `$.ownership` still carries
both its values, so "the axis left" is scoped rather than a collapse of the whole
derivation.

## Coverage decisions — re-derived, digests recorded

The gate refused the untouched document first, before any re-derivation, exactly
as its revisit condition requires:

```text
language coverage: FAIL
LANGUAGE_COVERAGE_STALE_DECISION_DOCUMENT: test/fixtures/g2/language-conformance/coverage-decisions.json names cb0d163e90718282991f8886e3d4a0c2301de095e8d699da8f749564ae7c906b, current ledger is 2be4b4de6461339aff6663e78b7e989eda0003d02d8caf6a44b9f437567cc6dd
```

| Value | Before | After |
| --- | --- | --- |
| `coverage-decisions.json` file digest | `76764cf74cc6120059b94ae37b09462119874482f8828b238cdaf5fa28d36a4b` | `4b3908d1e7447ee88eb2e9411a40a9ebf85fcd9b4850f69c0df5cf1643f4293b` |
| ledger digest | `cb0d163e90718282991f8886e3d4a0c2301de095e8d699da8f749564ae7c906b` | `2be4b4de6461339aff6663e78b7e989eda0003d02d8caf6a44b9f437567cc6dd` |
| obligation count | 1,896 | 1,938 |
| observed count | 395 | 426 |
| observation bitmap | 237 bytes | 243 bytes |
| defect inventory | 2 entries (join eligibility) | 2 entries (join eligibility) |
| `acceptedButUnhonoredSetDigest` | `1182b596eb701e61cb8de3d7fd072da933de7785001c04934916b6c3776b7d0f` | `1182b596eb701e61cb8de3d7fd072da933de7785001c04934916b6c3776b7d0f` |

**The `acceptedButUnhonoredSetDigest` does not move, and that is correct rather
than a stale carry-forward.** `deriveObligationSetDigest` binds the exact set of
obligation *ids* in the defect inventory. That set did not change: no newly
visible obligation is accepted-but-unhonored, and the two join-eligibility
entries are untouched. It is recomputed by execution on every run, so an
unchanged input necessarily yields an unchanged digest — and had a newcomer been
absorbed into that inventory, this row would have moved and said so.

Every other digest and identity moved, and all three decision identities were
minted fresh — retaining an old one is refused with
`LANGUAGE_COVERAGE_STALE_DECISION_IDENTITY`:

| Category | Decision identity | Obligation set digest |
| --- | --- | --- |
| `observedRelationScope` | `lang-singleton-relation-corpus-boundary@5c063258388d219514b642d7be01886f516e1358098758c845df94c985e33b79` | `e220b1233fedb4fac6f57f47d43b3d01f0e62f3a249f0e3fa30f3833f147354d` |
| `observedOutsideRelationScope` | `lang-singleton-whole-language-execution-boundary@efa86203a75b96f07aff0178949a301f5eb74ee64ef6d49ceaf12071d95c3e30` | `b58907e72e717deb3b941551a5d1c15fb1d81f9cb89ea1355775e717449d42f9` |
| `unobserved` | `lang-singleton-unused-shape-standing-exemption@49316035fe2374cefbcc963012194eba125adcbcaacffc00980186be1226cadb` | `dcc1992e8f8f2c14a38ef57d1757272df0f7473c9440a3e9eaa24aa8299766c1` |

Every digest, the observation bitmap, and all three decision identities were
produced by executing the ledger's own exported derivations
(`deriveLanguageCoverageLedger`, `observeLanguageCoverage`,
`encodeLanguageCoverageObservationSnapshot`, `deriveDecisionSetDigest`,
`deriveObligationSetDigest`, `deriveLanguageCoverageDecisionId`). No digest was
written by hand and no decision identity was carried forward.

The `observedRelationScope` rationale carried a sentence that this packet makes
false — *"the cardinality axis is no longer a choice and leaves the derived
ledger"* — and it is corrected in the re-derived document rather than left to
drift. The `observedOutsideRelationScope` rationale now records that its set
carries the previously dropped single-valued authored axes and that admitting
them is an inventory correction, not a claim that any of them executes.

## Scope

No language source changed: `packages/canonical-model/**` is untouched, because
changing the language to make the gate agree is backwards. The gate reports; the
language decides. `apps/web/scripts/compile-app-release.ts` is untouched — row
`lang-retire` owns it. No budget, timeout, baseline or structural floor was
raised or lowered. The open ADR-0041 violation on `joinEligibility: 'query'`
remains open and remains visible in the defect inventory; this packet corrects
the instrument that hid it, not the violation itself.

Two orchestrator-owned records now describe the mechanism in terms this packet
retires — `docs/execution/ledger.md:138`, `:142` and
`docs/execution/current-plan.md:259` cite `language-conformance-ledger.ts:710`,
`forced || values.size > 1` and the `includeSingletons` asymmetry, and
`docs/execution/packets/5g3-langnarrow.md:117,138` cites the same. They are
accurate as history and stale as description. Left untouched: all three are
outside this packet's owned paths, and `current-plan.md`'s prediction that "the
fix is the `forced` flag the code already has and does not use here" is one this
packet's investigation contradicts, which is the orchestrator's to record.

## Gates — one full matrix at the frozen SHA

`bash ./scripts/run-matrix.sh SINGLETON /home/rvham/2rain-greenfield-singleton`
at `8df2195602e33a4a0086a424055d955133de2682`. The runner recorded both
`PERFORMANCE_GATE_PASS_SHA=8df2195602e33a4a0086a424055d955133de2682` and
`FULL_MATRIX_PASS_SHA=8df2195602e33a4a0086a424055d955133de2682`. Zero `not ok`
lines across the whole run. Raw log: `/tmp/matrix-SINGLETON-8df21956.log`.

| Gate | Result |
| --- | --- |
| performance | 5/5; best-of-five CPU 1,716.7 ms and wall 1,356.9 ms against an unchanged 5,000 ms budget; 98.3% CPU idle admission |
| unit | 82/82 |
| compiler | 117/117 |
| integration | 74/74 |
| agent | 3/3 |
| architecture | 116/116 |
| web contracts | 7/7 |
| PostgreSQL | 160/160 |
| locale | 1/1 |
| browser | 27/27 |
| observability | 5/5 |
| schema drift | PASS |
| language coverage | 1,938 obligations; 426 observations; relation `95 = 0 + 93 + 2` |
| reachability | 90/90 test files; 10 producer artifacts |
| format, lint, typecheck, build, demo/app release, security | PASS |

Unit moves 80/80 to 82/82: exactly the two controls this packet adds. No other
suite's count moved, and no derived artifact moved — this packet changes only the
instrument that measures the language, not the language or anything compiled
from it.

The security scan's `WRN leaks found: 1` line is its own negative control — a
synthetic one-commit, 56-byte scan that must find a planted leak. The real
856-commit scan reports `no leaks found` and the gate reports
`Security scans passed`.

## Critical review

*(pending)*
