# 5g3-langnarrow — relation declarations are honoured or refused

Status: merged current-main targeted-green candidate; frozen matrix pending

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

The relation grammar now admits only the declaration the platform implements:
`cardinality: 'manyToOne'` and `joinEligibility: 'query'`. The cardinality
spellings `oneToOne` and `oneToMany`, the join-eligibility spelling `none`, and
an omitted join eligibility all fail at the canonical authoring boundary. None
is rewritten to the supported declaration.

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
| merged candidate | `87 = 0 supported-and-exercised + 87 supported-but-unexercised + 0 accepted-but-unhonored` | 1,892 | 393 |

Exactly seven relation obligations left the ledger; none was added and none
moved into accepted-but-unhonored:

- `authoredLanguage:$.relations[].cardinality="manyToOne"` — left
  accepted-but-unhonored because it is now the sole admitted cardinality and
  the same real Inventory movement relation positively normalizes and lowers
  to its one source-side UUID foreign key.
- `authoredLanguage:$.relations[].cardinality="oneToMany"` — left
  accepted-but-unhonored because the spelling is now refused by name with
  `CANON_RELATION_CARDINALITY_UNSUPPORTED`.
- `authoredLanguage:$.relations[].cardinality="oneToOne"` — left
  accepted-but-unhonored for the same ruled refusal; no uniqueness semantics
  were invented.
- `authoredLanguage:$.relations[].joinEligibility="none"` — left
  accepted-but-unhonored because the spelling is refused by name with
  `CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED`.
- `authoredLanguage:$.relations[].joinEligibility="query"` — left
  accepted-but-unhonored because it is now the sole admitted join declaration;
  the positive witness carries it through normalization into the relation that
  lowers successfully.
- `authoredLanguage:$.relations[].joinEligibility.$presence="absent"` — left
  supported-but-unexercised because omission is no longer an admitted spelling
  and is refused with the join-eligibility diagnostic.
- `authoredLanguage:$.relations[].joinEligibility.$presence="present"` — left
  supported-but-unexercised because presence is now mandatory rather than a
  finite optionality choice.

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

The full repository matrix remains pending at the frozen candidate SHA. Per the
2026-08-03 matrix rule, it will run once only after the candidate is committed.
