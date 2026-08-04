# 5g3-langnarrow — relation declarations are honoured or refused

Status: revision 1 written under the granted bridge; stopped again before
freezing — the checked-in release lineage cannot be produced under the new rule,
and one departing ledger axis is HIDDEN rather than HONEST

Tier: Critical

Base: `011cd6a5a1afb9b314beedf58d8d161fe301dc21` (fetched as
`origin/main`; merged at `37293552e56b095c7c15541886ceff7368aa6046`)

Original cut point: `5679cd2186a06864070a21563cace39df62877da`.
Every matrix result recorded before the current-main merge is void.

Authorities:
[ADR-0021](../../decisions/ADR-0021-total-absent-value-semantics.md),
[ADR-0039](../../decisions/ADR-0039-experimental-output-protocol-and-lineage-regeneration.md),
[ADR-0041](../../decisions/ADR-0041-declared-shapes-must-be-honoured-or-refused.md),
[ADR-0042](../../decisions/ADR-0042-resolve-is-required-where-a-text-key-exists.md),
and
[ADR-0043](../../decisions/ADR-0043-lineage-truncation-and-attributed-count-changes.md).

## Outcome

The matrix-green candidate narrowed the relation grammar to
`cardinality: 'manyToOne'` and `joinEligibility: 'query'`. The cardinality
spellings `oneToOne` and `oneToMany`, the join-eligibility spelling `none`, and
an omitted join eligibility all fail at the canonical authoring boundary. None
is rewritten to the supported declaration.

Critical review rejected the candidate's claim that the surviving
`joinEligibility: 'query'` declaration is implemented. Repository-wide consumer
inspection confirms that it survives normalization but no compiler, query, or
runtime path reads it. ADR-0041 explicitly requires consumerless join eligibility
to be removed from the admitted surface. Consequently the candidate's zero
accepted-but-unhonored partition is not admissible evidence: it launders the
surviving `query` defect through the gate's singleton-axis blind spot. The
cardinality narrowing remains sound, but the packet cannot land in this state.

ADR-0021's pattern applies directly. It keeps required but unimplemented
comparison spellings outside the admitted language and makes their use a
compile-time error rather than a silent rewrite. This packet does the same for
relations: it rules the semantics, declines the spellings that have no
executing semantics, and leaves a future capability to arrive with its own
enforcement.

A repository-wide search found no authored use of `oneToOne`, `oneToMany`, or
`joinEligibility: 'none'`. Party, Inventory, the composed application artifact,
and the module fixtures declare `manyToOne` plus `query`. The representative
canonical fixture was the only omission; it relied on the old implicit `none`
default and was made explicit rather than treated as evidence of a needed
semantic.

The existing parent-scoped-child semantic guard remains in
`normalize.ts:1450-1467`. With the supported literals present, changing the
fixture relation's `required` member to `false` still reaches that guard and
returns `CANON_RELATION_PARENT_SCOPE_INVALID`. The narrowing therefore does not
turn the existing guard into dead evidence.

## Current-main merge and language-gate attribution

Merging BASE added the `5g3-langgate` instrument without a source conflict. Its
first run against the untouched decisions document failed before any
re-derivation, exactly as the decision's revisit condition required:

```text
language coverage: FAIL
LANGUAGE_COVERAGE_STALE_DECISION_DOCUMENT: test/fixtures/g2/language-conformance/coverage-decisions.json names f32d5fa17f1e5ddaf0f0a28d61d3eb5447af0235e8301bc2952231624d52f5cb, current ledger is b4cf5f064a30b1ac07382e006e5b9f91fd9fa7fd33b5cbcd414790fa3a4e6d41
[ELIFECYCLE] Command failed with exit code 1.
```

The exact relation partition moved as follows. There are still no current-run
receipts, so the supported-and-exercised bucket remains zero rather than being
inferred from declarations or older tests.

| Tree | Relation partition | Whole ledger | First-party observations |
| --- | --- | --- | --- |
| BASE | `94 = 0 supported-and-exercised + 89 supported-but-unexercised + 5 accepted-but-unhonored` | 1,899 | 396 |
| merged candidate (mechanical output; rejected by review) | `87 = 0 supported-and-exercised + 87 supported-but-unexercised + 0 accepted-but-unhonored` | 1,892 | 393 |

Exactly seven relation obligations left the ledger; none was added and none
moved into accepted-but-unhonored:

- `authoredLanguage:$.relations[].cardinality="manyToOne"` —
  accepted-but-unhonored → removed from the derived ledger because it is now
  the sole admitted cardinality and
  the same real Inventory movement relation positively normalizes and lowers
  to its one source-side UUID foreign key.
- `authoredLanguage:$.relations[].cardinality="oneToMany"` —
  accepted-but-unhonored → removed from the derived ledger because the spelling
  is now refused by name with
  `CANON_RELATION_CARDINALITY_UNSUPPORTED`.
- `authoredLanguage:$.relations[].cardinality="oneToOne"` —
  accepted-but-unhonored → removed from the derived ledger for the same ruled
  refusal; no uniqueness semantics were invented.
- `authoredLanguage:$.relations[].joinEligibility="none"` —
  accepted-but-unhonored → removed from the derived ledger because the spelling
  is refused by name with
  `CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED`.
- `authoredLanguage:$.relations[].joinEligibility="query"` —
  accepted-but-unhonored → mechanically removed because it became a singleton.
  Critical review rejected the candidate attribution: carrying the value through
  normalization beside a relation that lowers does not honour join-eligibility
  semantics, because the lowerer never reads the value. This is still a defect,
  hidden rather than closed.
- `authoredLanguage:$.relations[].joinEligibility.$presence="absent"` —
  supported-but-unexercised → removed from the derived ledger because omission
  is no longer an admitted spelling and is refused with the join-eligibility
  diagnostic.
- `authoredLanguage:$.relations[].joinEligibility.$presence="present"` —
  supported-but-unexercised → removed from the derived ledger because presence
  is now mandatory rather than a finite optionality choice.

The non-relation observed-set digest remains exactly
`d32619080727fdb3cf64c91d43b85c14db7a7bc205dbc2841a9e23399e72847e`;
the seven lines above are therefore the complete partition delta, not a fitted
subset.

The gate caught the genuine language change at its stale ledger binding and
also rejected a deliberately wrong retargeting that carried the old five-entry
defect inventory forward:

```text
LANGUAGE_COVERAGE_PHANTOM_DEFECT_INVENTORY_ENTRY: authoredLanguage:$.relations[].cardinality="manyToOne"
```

It missed one important future-drift class: the derivation excludes singleton
authored choices. Consequently neither the surviving `manyToOne` nor `query`
literal remains an obligation, and a future singleton-for-singleton
substitution would not move this ledger digest. The named authoring tests and
positive lowering witness protect today's exact values, but the gate itself
does not. The reusable rule is recorded in `learnings.md`; correcting the
instrument remains outside this packet's owned paths.

## Controls and victim evidence

| Control | Observed fact | Victim and recorded red |
| --- | --- | --- |
| `oneToOne` refusal | The real composed-app relation `northstar.app:relation.inventory_movement_transaction_line` carrying `oneToOne` returns `CANON_RELATION_CARDINALITY_UNSUPPORTED`, with its ID and `$.relations[3].cardinality`. It is already a `reference`, so the parent-scope guard cannot mask the authoring result. | `schemas.ts:583`. Temporarily restoring the three-value enum made this test fail with exact text `error: 'Missing expected exception.'`; the literal was restored and the test passed. |
| `oneToMany` refusal | The same independent observation from the same relation and source entity for `oneToMany`. | `schemas.ts:583`. The independently filtered victim also failed with exact text `error: 'Missing expected exception.'`, then passed after restoration. |
| `none` refusal | The same real relation carrying `joinEligibility: 'none'` returns `CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED`, with its ID and `$.relations[3].joinEligibility`. | `schemas.ts:591`. Temporarily restoring the two-value enum made the test fail with exact text `error: 'Missing expected exception.'`; the literal was restored and the test passed. |
| omission refusal | Removing `joinEligibility` from that relation returns the same named diagnostic instead of recreating the former implicit `none`. | The absence of an optional override at `schemas.ts:602-605` and the absence of a default at `normalize.ts:327-331`. Temporarily restoring the two-value normalized enum, the optional authored member, and the old `none` default made the test fail with exact text `error: 'Missing expected exception.'`; all were removed again and the test passed. |
| supported relation | The same `northstar.app:entity.inventory_movement` relation with `manyToOne + query` normalizes and lowers; its lowered relation remains `reference` with a `uuid` relation column. | `negative-contracts.test.ts:1125-1143`; green in the focused file and 82/82 unit suite. An initial attempt using the representative canonical fixture correctly failed with `error: 'v1 storage lowering requires validated dedicated storage'`; the witness was rebound to the real compiler-admitted relation without changing product code. |
| parent-scoped-child regression | With allowed relation literals, `required: false` still returns `CANON_RELATION_PARENT_SCOPE_INVALID`. | `normalize.ts:1449-1455`. This is the pre-existing control at `negative-contracts.test.ts:880-887`; it passed alongside all four new refusal controls. |

The named author diagnostics are selected at `normalize.ts:534-541`, and their
accepted alternatives are owned at `normalize.ts:2237-2243`.

## Artifact event

The canonical fixture previously omitted `joinEligibility`, which normalized
to the now-declined implicit value `none`. Making the authored declaration
explicitly `query` necessarily moved its canonical bytes. The values below were
produced by executing `normalizeApplicationPackage` and
`canonicalizeAndHash`; no digest was invented or edited independently of that
result.

| Artifact/profile | Before | After |
| --- | --- | --- |
| `representative.normalized.golden.sha256` / v3 | `bda130f1ac2bcbd57c7a7be906897ae09a67268467f1c7880b4a3d6c3f0f511c` | `51fa3abbc4e256b4d96223022c3ab2fa3ab1f0ec70e3e5798127e469a024fc02` |
| normalization v0-experimental | `00444e2e40aedea745ea23cc89ac5f2f01f9234dcae2473481b39134f3f036ba` | `6eb27fb2b977d50288e3f141b16330c63e381ec05d638295d406ba7a6992af27` |
| normalization v1 | `7126210813d43a1b8097f8500c8d3ece3ef5966dfdbe27bbfe988f035bcd0231` | `5c77f2c3b273e4704c17118c65eb0a1576316c21ac1c67d958ec455acb5c7d58` |
| normalization v2 | `538ed9deca0fed3f2c2340ce05ce65213fbacb02f153544b1d58cc9844d5048a` | `dbabd07e6e946eabbb93136cbbd48d46ed35dd646a9b4c83440c32287f5a8cb8` |

Authored-token telemetry moves from 3,651 to 3,661 because the fixture now
states its join behavior; normalized telemetry remains 2,567.

After the BASE merge, the golden was independently re-derived again. Its file
value before the merged-tree derivation and the produced value were both
`51fa3abbc4e256b4d96223022c3ab2fa3ab1f0ec70e3e5798127e469a024fc02`;
the derived file therefore needed no edit.

Current main has advanced the application lineage since the earlier candidate.
Running
`node --import tsx apps/web/scripts/compile-app-release.ts --check` under the
narrowed canonical reader recompiled and accepted the bootstrap plus all seven
current entries. The check is read-only and moved no artifact. This current
event supersedes the stale five-entry event previously recorded here:

| Artifact | Before | After |
| --- | --- | --- |
| `apps/web/release/app.compiled.json` SHA-256 | `a7282d06141017fea1a24fcb9fec33a508162abef6644ada7d2951c046122b49` | `a7282d06141017fea1a24fcb9fec33a508162abef6644ada7d2951c046122b49` |
| bootstrap root | `7619e59cba92a3cc786eae11c0d9f83a6bb344e3d613a3039b53a1d05cfa1a55` | `7619e59cba92a3cc786eae11c0d9f83a6bb344e3d613a3039b53a1d05cfa1a55` |
| entry 0 | `a9c37c7784e726977cd32cd106ea441cfa5442568726bf04c60a0ec4e261e486` | `a9c37c7784e726977cd32cd106ea441cfa5442568726bf04c60a0ec4e261e486` |
| entry 1 | `ba87d2155d9d8fcc2d7c12a058ccc44094857310f6bb2cf4c095955711e7aa05` | `ba87d2155d9d8fcc2d7c12a058ccc44094857310f6bb2cf4c095955711e7aa05` |
| entry 2 | `bf932f8a4a69edc23c7a62c4191e1e9cf92c9482d38fc8bcef90945461615783` | `bf932f8a4a69edc23c7a62c4191e1e9cf92c9482d38fc8bcef90945461615783` |
| entry 3 | `a8f6e2c14510a687a0eaa1e244d025dedc3062114d42d14861b26417e36e9420` | `a8f6e2c14510a687a0eaa1e244d025dedc3062114d42d14861b26417e36e9420` |
| entry 4 | `ee5d474d50eb5243856fd11c7a3160f915b2fe6e1f85b57f2c443f6792e7e843` | `ee5d474d50eb5243856fd11c7a3160f915b2fe6e1f85b57f2c443f6792e7e843` |
| entry 5 | `4b254f50b2f558e96b98325467ae339a4bd6492d9691ccb464eb88d1b53f3bb1` | `4b254f50b2f558e96b98325467ae339a4bd6492d9691ccb464eb88d1b53f3bb1` |
| entry 6 | `d726ad313780bc595c97a0ecb30c9eaec84984e4a19fa28c2e8f5361e7edf12e` | `d726ad313780bc595c97a0ecb30c9eaec84984e4a19fa28c2e8f5361e7edf12e` |

Zero movement is expected for a substantive reason rather than assumed: every
stored lineage input already states the only supported relation values
explicitly, while the canonical fixture was the sole omission and is outside
the application lineage. The bootstrap and every application entry retain
`northstar.compiler-output/v0-experimental`.

## Scope

No compiler conformance source was changed, no relation semantics were
implemented on speculation, and no language-coverage instrument was changed.
Future one-to-one or one-to-many support must arrive with executing storage
semantics and its own negative controls.

## Critical review round 1 — REVISE; finding upheld

Fresh naive Codex `gpt-5.6-sol` at `xhigh` reviewed frozen SHA
`a2af1634547b2456da8dac56d00f47dd4062cc40` against BASE
`011cd6a5a1afb9b314beedf58d8d161fe301dc21`. It returned `VERDICT: REVISE`:

> `joinEligibility: 'query'` remains an authored declaration even though no
> compiler, query, or runtime consumer observes it. The positive witness proves
> only that the value survives normalization and that an ordinary foreign key
> lowers. Clearing the former defect inventory therefore launders the existing
> defect and conflicts with ADR-0041.

The finding is upheld. `packages/compiler/src/storage.ts` never reads
`joinEligibility`; repository-wide search finds production references only in
canonical parsing and authored domain declarations. Fable confirmation was not
launched because the Critical-tier sequence permits confirmation only after the
primary reviewer passes. No revision round has yet been attempted.

The smallest compliant revision removes `joinEligibility` from authored and
normalized relation shapes, accepts omission, rejects every explicit spelling by
name, removes the explicit declarations from all first-party authored inputs, and
re-derives canonical and application artifacts plus coverage evidence. That
revision crosses this packet's declared lease. A bridge or lease expansion is
required for:

- `packages/domain/src/inventory/definition.ts`
- `packages/domain/src/party/definition.ts`
- `test/compiler/g2-module-conformance.test.ts`
- `test/compiler/g2-module-storage.test.ts`
- `test/fixtures/g2/module-conformance/definitions.ts`
- `test/postgres/module-runtime.test.ts`
- `apps/web/release/app.authored.json` and deterministic dependent release output

No file in that bridge set was edited. Raw review evidence is
`/home/rvham/2rain-missions/langnarrow-codex-review-a2af163.result.txt`.

## Gates

All pre-merge matrices are void. Current-main focused evidence before the one
frozen matrix:

- `corepack pnpm test:unit` — PASS, 82/82. This includes all four named
  refusals, the same-relation normalization/lowering witness, the unchanged
  parent-scope guard, and the language-gate's own controls.
- `corepack pnpm check:language-coverage` — PASS, 1,892 obligations, zero
  receipts, 1,892 decision-covered obligations, 393 first-party observations;
  relation partition `87 = 0 + 87 + 0`.
- focused `negative-contracts.test.ts` — PASS, 27/27 after the witness was
  rebound to the compiler-admitted composed relation.
- `node --import tsx apps/web/scripts/compile-app-release.ts --check` — PASS;
  current bootstrap and seven-entry lineage recompile byte-identically.
- golden derivation through `normalizeApplicationPackage` and
  `canonicalizeAndHash` — PASS; produced and recorded digest both `51fa3abb…`.
- targeted Prettier and `git diff --check` — PASS.

Two invocations waited the runner's bounded 300 seconds and exited 75 before
any matrix phase ran, both with exact text:

```text
TEST_GATE_LOCK_BUSY: exclusive access to /tmp/north-star-matrix.lock was unavailable for 300s
```

The lock was not bypassed. The next normal retry acquired it and ran the one
authoritative full matrix at frozen executable SHA
`e446353d6e055ffcca6d12c4f195e2bfe4025702`:

| Gate | Result |
| --- | --- |
| performance | 5/5; best-of-five CPU 1,514.8 ms and wall 1,220.6 ms against unchanged 5,000 ms budget; 97.5% CPU idle admission |
| unit | 82/82 |
| compiler | 117/117 |
| integration | 74/74 |
| agent | 3/3 |
| architecture | 116/116; boundaries 149 files |
| web contracts | 7/7 |
| PostgreSQL | 159/159 |
| locale | 1/1 |
| browser | 27/27 |
| observability | 5/5 |
| migrations/schema | 21/21, schema drift PASS |
| language coverage | 1,892 obligations; 393 observations; relation `87 = 0 + 87 + 0` |
| reachability | 90/90 test files; 10 producer artifacts |
| format, lint, typecheck, build, releases, security | PASS |

The runner recorded both
`PERFORMANCE_GATE_PASS_SHA=e446353d6e055ffcca6d12c4f195e2bfe4025702`
and
`FULL_MATRIX_PASS_SHA=e446353d6e055ffcca6d12c4f195e2bfe4025702`.
Raw log: `/tmp/matrix-LANGNARROW-e446353d.log`.

## Revision 1 under the bridge — the removal, and where it stopped

Base `011cd6a5`; revision commit `a4d445c`. The bridge granted for this packet
only was used exactly as scoped, with one addition named under "Bridge still
required" below.

`joinEligibility` is gone from `normalizedRelationDefinition`, so it is absent
from both the authored and normalized relation shapes. `authoredRelationDefinition`
extends the normalized one and adds nothing back. No query-join semantics were
implemented; nothing was coerced.

Because the relation schema is a closed `z.strictObject`, a declared
`joinEligibility` now arrives as a zod `unrecognized_keys` issue whose `path`
names the relation (`['relations', 3]`) and whose `keys` name the member. The
issue path alone therefore cannot name the declaration back to the author, and
the previous `finalPart === 'joinEligibility'` selector could never fire again.
`schemaError` now reads the key list: a declined key becomes its own diagnostic
at `$.relations[i].joinEligibility` with
`CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED` and accepted alternative
`omit joinEligibility until join semantics exist to honour it`. Every other
unrecognized key keeps the generic `CANON_SCHEMA_INVALID` at the relation path.

Authored declarations were removed from `packages/domain/src/{party,inventory}/
definition.ts`, `test/fixtures/g2/module-conformance/definitions.ts`,
`test/compiler/g2-module-{conformance,storage}.test.ts` (one each),
`test/postgres/module-runtime.test.ts` (two), and
`test/fixtures/canonical-model/representative.authored.json`.
`apps/web/release/app.authored.json` was re-derived, never edited.

### Controls and recorded reds

| Control | Observed fact | Victim and recorded red |
| --- | --- | --- |
| `query` refusal | `northstar.app:relation.inventory_movement_transaction_line` carrying `joinEligibility: 'query'` returns `CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED` at `$.relations[3].joinEligibility` with that relation id. The formerly accepted spelling is now refused by name. | Restoring `joinEligibility: z.enum(['none','query'])` on the normalized shape, `.optional()` on the authored shape, and the `?? 'none'` normalization default made the test fail with exact text `error: 'Missing expected exception.'`; all three were removed again and it passed. |
| `none` refusal | The same relation carrying `joinEligibility: 'none'` returns the same named diagnostic at the same path. | The same victim, exact text `error: 'Missing expected exception.'`. |
| declined member is named, not swallowed | A relation carrying an unrelated unknown member `joinHint` still returns `CANON_SCHEMA_INVALID` at `$.relations[3]`. | Widening the declined-key filter from `key === 'joinEligibility'` to every unrecognized key made the test fail with exact text `error: 'expected CANON_SCHEMA_INVALID: [{"acceptedAlternative":"omit joinEligibility until join semantics exist to honour it","code":"CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED","objectId":"northstar.app:relation.inventory_movement_transaction_line","occurrenceIndex":0,"path":"$.relations[3].joinHint","phase":"canonicalModel","rule":"value must satisfy a closed supported schema through v4"}]'`. |
| both refusals coexist | A relation carrying `joinEligibility` **and** `joinHint` returns both diagnostics, each at its own path. | The re-admission victim above, exact text `error: 'expected CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED: [{"acceptedAlternative":"use the exported authored schema and canonical example","code":"CANON_SCHEMA_INVALID","objectId":"northstar.app:relation.inventory_movement_transaction_line","occurrenceIndex":0,"path":"$.relations[3]","phase":"canonicalModel","rule":"value must satisfy a closed supported schema through v4"}]'`. |
| omission is admitted, not defaulted | The same real relation, declaring no join eligibility, normalizes; the normalized relation has no `joinEligibility` own-property. | The re-admission victim restored the `?? 'none'` default and the test failed with `expected: false` / `actual: true` on `Object.hasOwn(normalizedRelation, 'joinEligibility')`. |
| positive witness — normalizes, lowers | The same relation lowers to `ownership: 'reference'` with a `uuid` relation column. | `negative-contracts.test.ts`, 29/29 green. Uses the compiler-admitted composed relation, not the representative canonical fixture — the earlier attempt on that fixture correctly failed with `error: 'v1 storage lowering requires validated dedicated storage'` and is not repeated. |
| positive witness — executes | `test/postgres/module-runtime.test.ts` 19/19 against real PostgreSQL, with the fixture's `joinEligibility` removed. | Stored-effect execution, not a declaration. |
| parent-scoped-child regression | Unchanged; `required: false` still returns `CANON_RELATION_PARENT_SCOPE_INVALID`. | Pre-existing control, green in the same 29/29 file. |

### Per-axis HONEST vs HIDDEN — one axis is HIDDEN

Seven obligations left the derived ledger relative to BASE. Their classification:

| Departing obligation | Mechanism | Verdict |
| --- | --- | --- |
| `authoredLanguage:$.relations[].joinEligibility="none"` | the member no longer exists in `VersionedAuthoredApplicationPackage`; the spelling is refused by name | **HONEST** |
| `authoredLanguage:$.relations[].joinEligibility="query"` | same; the previously accepted spelling is refused by name with its own recorded red | **HONEST** |
| `authoredLanguage:$.relations[].joinEligibility.$presence="absent"` | the presence axis existed only because the member was optional; there is no member and therefore no presence choice | **HONEST** |
| `authoredLanguage:$.relations[].joinEligibility.$presence="present"` | same | **HONEST** |
| `authoredLanguage:$.relations[].cardinality="oneToOne"` | the value is no longer admitted and is refused by name with `CANON_RELATION_CARDINALITY_UNSUPPORTED` | **HONEST** |
| `authoredLanguage:$.relations[].cardinality="oneToMany"` | same | **HONEST** |
| `authoredLanguage:$.relations[].cardinality="manyToOne"` | the value is **still authorable**. Its obligation left only because narrowing collapsed the axis to a single value and the authored derivation admits an axis only when `forced \|\| values.size > 1` (`language-conformance-ledger.ts:708`) | **HIDDEN** |

The HIDDEN row is reported, not shipped. It is not the laundering this packet
already caught once — `manyToOne` **is** honoured, witnessed by the lowering
assertion and by 19/19 real-PostgreSQL execution above, so no defect entry
disappeared with it. But the value is still authorable and the gate no longer
carries its obligation, which is the literal definition of HIDDEN, and ADR-0041
§1 makes that state unavoidable here: it rules cardinality **restricted** to the
honoured value while join eligibility is **removed**. The singleton is therefore
the ADR-mandated end state and the fix belongs to row `lang-singleton`.

### The blind spot, measured

The derived ledger digest is **`b4cf5f064a30b1ac07382e006e5b9f91fd9fa7fd33b5cbcd414790fa3a4e6d41`
both before and after removing the member** — byte-identical, and the same digest
`coverage-decisions.json` already binds. `check:language-coverage` passes
unchanged: 1,892 obligations, 0 receipts, 393 first-party observations, relation
partition `87 = 0 + 87 + 0`. No decision document needed re-deriving.

That is the blind spot stated as a measurement rather than an argument: the gate
returns the identical digest for "narrowed to an unhonoured singleton" and for
"removed from the language entirely." The two states differ by the whole content
of ADR-0041 and the instrument cannot see between them. The asymmetry is
one-sided and mechanical — the lowered derivation passes `includeSingletons: true`
and keeps its own singleton axes (`$.relations[].relationColumn.origin = "field"`,
`postgresqlType = "uuid"`), while the authored derivation passes `false`.

### Artifact event — canonical goldens re-derived

Produced by executing `normalizeApplicationPackage` and `canonicalizeAndHash`;
no digest was written independently of that result.

| Artifact/profile | Before | After |
| --- | --- | --- |
| `representative.normalized.golden.sha256` / v3 | `51fa3abbc4e256b4d96223022c3ab2fa3ab1f0ec70e3e5798127e469a024fc02` | `2a65c466480d00d363d7d01349cdf7f898706639cfc6e11c02239478515481a5` |
| normalization v0-experimental | `6eb27fb2b977d50288e3f141b16330c63e381ec05d638295d406ba7a6992af27` | `e17662627361d92ed35be27b3b9aa3d76347944b88e64f8c813c0060344e12d3` |
| normalization v1 | `5c77f2c3b273e4704c17118c65eb0a1576316c21ac1c67d958ec455acb5c7d58` | `775a83edb684142b3d9a5a3b6ca0df755029e04a262ce52ae07f8d9a3d2666f8` |
| normalization v2 | `dbabd07e6e946eabbb93136cbbd48d46ed35dd646a9b4c83440c32287f5a8cb8` | `389e563ff7e5c523d10baa5b3b0bd7265dfc61475f2d6ff1f4067eff1931582e` |
| `apps/web/release/app.authored.json` | `0217868f16700ea8c770f5d569e3796594885d391185ada3d810c7807b066f37` | `2f0c94ee317c864ad5d39fb3526183d79932ea714945761d22f0fe2127af10b3` |
| `v1-v2.release.structural.golden.json` v1 root | `bac8376eacf14945e2be9fcd798f63cadeb90ff90203e4601a8047e25063495e` | `920babc9b48fc1148674f74e5f7d049457435cbd0efdbe556cf5e63d0528ff6f` |
| `v1-v2.release.structural.golden.json` v2 root | `e87185a6dcc34eaf8311b1cb77386bdf63cfde531c3107343f8b60cf2ddad171` | `b3b0e672d484304b48ce38ace17e5ae4cd47857ed23190a020e565e7042eaab5` |

Authored-token telemetry returns to BASE's 3,651 because the canonical fixture no
longer states join behavior. Normalized telemetry moves 2,567 to 2,560, attributed
exactly: one relation, one `"joinEligibility":"none"` member no longer written
into normalized output.

### THE BLOCKER — the checked-in lineage cannot be produced

`apps/web/release/app.compiled.json` did not move. It **cannot** be produced under
this rule, and this is the recurrence ADR-0043 predicted by name:

> Every conformance packet tightens a rule, and every tightened rule can invalidate
> history authored under the looser one. `5g3-langnarrow` escaped it only because
> every production relation already declared the surviving values.

Removing the member ends that escape. `verifyExistingLineage` recompiles every
historical entry from its stored `normalizedDefinitionBytes`, and **all seven
application entries carry `joinEligibility`** — entries 0-3 carry one relation
each, entries 4-6 carry eight. The build fails on entry 0:

```text
CanonicalModelError: CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED
      acceptedAlternative: 'omit joinEligibility until join semantics exist to honour it',
      code: 'CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED',
      objectId: 'northstar.app:relation.party_role_party',
      path: '$.relations[0].joinEligibility',
```

ADR-0043 §1 authorizes cutting back to the longest valid prefix and appending a
new head. **The longest valid prefix here is empty**, and three separate things
block every route out. None is a judgement call; each was executed.

1. **The truncation instrument cannot classify this failure at all.**
   `--truncate-invalid-lineage` crashes rather than truncating, because
   `compileNormalizedDefinition` (`compile-app-release.ts:433`) lets
   `parseNormalizedApplicationPackageJson`'s `CanonicalModelError` escape instead
   of returning a failed `CompileResult`. The `result.status !== 'compiled'`
   branch at `:135` is therefore unreachable for a canonically-invalid entry —
   exactly the class ADR-0043 exists for. Stack:
   `longestValidExperimentalLineagePrefix (:131) -> compileNormalizedDefinition (:433)`.
2. **Even repaired, it would refuse.** With zero valid application entries,
   `:153` throws `compiled application lineage has no valid application prefix to
   retain`.
3. **A from-scratch rebuild is the wrong artifact and breaks three ratchets.**
   Deleting the file and letting `initialLineage` run does succeed — measured in a
   scratch path — but it produces envelope
   `northstar.web:compiled-application-release/**v1**` with a single `application`
   key, one entry, and a moved bootstrap root
   (`7619e59cba92a3cc786eae11c0d9f83a6bb344e3d613a3039b53a1d05cfa1a55` to
   `8edda7bc5531a6ef691a7fb62f5543ad88bc8be7a9bf357a7c574aa6963c9458`).
   That artifact cannot satisfy
   `test/postgres/composed-application.test.ts:99`
   (`assert.ok(compiledApplication.applications.length >= 6)`), `:194`
   (`applications.length > 3`, then swaps entries 1 and 2), or `:3862`
   (constructs a `.../v2` envelope). These are structural preconditions, not
   counts: they would have to be rewritten, and lowering a depth floor to fit an
   observation is precisely what ADR-0043 §3 refuses. That file is not in this
   packet's lease.

No matrix was run and no review was launched. A matrix at this SHA is guaranteed
red at `check:app-release`, and freezing a candidate that cannot build would spend
the packet's one remaining review round on a tree that cannot land.

### Bridge still required

- `apps/web/scripts/compile-app-release.ts` — to repair the truncation classifier
  and admit an empty valid prefix, **if** the orchestrator rules that route.
- `test/postgres/composed-application.test.ts` — the three lineage-shape
  preconditions above, under an explicit ADR-0043 §3 attribution.
- `test/compiler/legal-entity-query-scope.test.ts:457` — one pinned v3 release
  manifest digest, `921ee2781fabdf5fd93f93cf07db9b27e6f41e8ad6163dbbd714da58dd9e6290`
  to `b8d5afbee2aa97c807c550120779b7957863b6bc8f2f7c691cd88a0e2447771f`. It moves
  because `v3AggregateModule()` derives from `ordinaryModuleV2()` in the
  module-conformance fixture this packet owns. Not edited; it is the one remaining
  red in `test:compiler` (116/117).
- `test/fixtures/g2/module-conformance/v1-v2.release.structural.golden.json` —
  **taken** as the deterministic dependent of the granted
  `module-conformance/definitions.ts`; only the two release roots moved. Named
  here rather than left silent, per the lanes.md rule that an uncontested lease
  existing only in a prompt is invisible to the next lane.

### Focused gates at `a4d445c`

- `corepack pnpm typecheck` — PASS
- `corepack pnpm test:unit` — PASS, 84/84
- `corepack pnpm test:compiler` — **116/117**; the single red is the out-of-lease
  pin named above
- `corepack pnpm test:integration` — PASS, 74/74
- `corepack pnpm test:agent` — PASS, 3/3
- `corepack pnpm test:architecture` — PASS, 116/116
- `corepack pnpm test:contracts` — PASS, 7/7
- `corepack pnpm test:locale` — PASS, 1/1
- focused `test/postgres/module-runtime.test.ts` — PASS, 19/19
- focused `test/unit/canonical-model/negative-contracts.test.ts` — PASS, 29/29
- `corepack pnpm check:language-coverage` — PASS, unchanged digest and partition
- `corepack pnpm check:app-release` — **RED**, the blocker above
- `corepack pnpm format`, `corepack pnpm lint`, `git diff --check` — PASS
