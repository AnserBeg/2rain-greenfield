# 5g3-langnarrow — relation cardinality is honoured or refused

Status: revision 2 candidate — the cardinality half only. The join-eligibility
half was ruled out of this packet and routed to `lang-retire`.

Tier: Critical

Base: `011cd6a5a1afb9b314beedf58d8d161fe301dc21`

Original cut point: `5679cd2186a06864070a21563cace39df62877da`. Every matrix
result recorded before this revision is void.

Authorities:
[ADR-0021](../../decisions/ADR-0021-total-absent-value-semantics.md),
[ADR-0039](../../decisions/ADR-0039-experimental-output-protocol-and-lineage-regeneration.md),
[ADR-0041](../../decisions/ADR-0041-declared-shapes-must-be-honoured-or-refused.md),
and
[ADR-0043](../../decisions/ADR-0043-lineage-truncation-and-attributed-count-changes.md).

## Outcome

Relation cardinality is narrowed to `manyToOne`, the one value the storage
lowerer implements. `oneToOne` and `oneToMany` are refused at the canonical
authoring boundary with `CANON_RELATION_CARDINALITY_UNSUPPORTED`, naming the
relation and the exact path. Neither is rewritten to the supported value —
ADR-0041 §2 rules that a silent coercion is the same defect wearing the costume
of a fix.

Nothing was implemented on speculation. `oneToOne` has real semantics — a
uniqueness constraint — and ADR-0041 §3 defers it until a module needs it and it
arrives with its own enforcement.

The executable diff against BASE is four hunks: one schema literal, one
diagnostic selector branch, one accepted-alternative entry, and the controls.
Every checked-in definition, fixture, golden and release artifact already
declared `manyToOne`, so no byte of any derived artifact moved — verified by
re-derivation below, not assumed.

## The join-eligibility half is NOT in this packet — a known open ADR-0041 violation

**`joinEligibility` is still admitted, and `joinEligibility: 'query'` is still
accepted with zero consumers. That is a live ADR-0041 violation and it is left
open deliberately.** Naming it is the point of this section; a deferred defect
that is not written down is a hidden defect.

The facts, verified in code:

- Nothing reads the value. `packages/compiler/src/storage.ts` never mentions it,
  `StorageRelationTarget` does not carry it, and repository-wide search finds
  production references only in canonical parsing and authored declarations.
- ADR-0041 §1 therefore requires it **removed** from the admitted surface, not
  narrowed. Narrowing it to the single spelling `query` was this packet's
  revision-1 candidate and Critical review correctly returned REVISE: the
  surviving value is still accepted-and-ignored, and its defect entry vanished
  from the coverage ledger only because that ledger drops single-valued authored
  axes.
- Removing it is **not currently possible**. All seven checked-in application
  lineage entries carry `joinEligibility` in their stored
  `normalizedDefinitionBytes`. `verifyExistingLineage` recompiles every historical
  entry, so removal makes `apps/web/release/app.compiled.json` unproducible:

  ```text
  CanonicalModelError: CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED
        objectId: 'northstar.app:relation.party_role_party',
        path: '$.relations[0].joinEligibility',
  ```

  ADR-0043 §1's truncation cannot rescue it. The longest valid prefix is empty,
  `compile-app-release.ts:153` refuses that, and the truncation path cannot even
  classify the failure: `compileNormalizedDefinition` (`:433`) lets
  `parseNormalizedApplicationPackageJson`'s error escape, so the status branch at
  `:135` is unreachable for canonically-invalid bytes. A from-scratch rebuild
  produces a one-entry `.../v1` envelope that cannot satisfy
  `test/postgres/composed-application.test.ts:99` (`applications.length >= 6`),
  `:194` (`> 3`), or `:3862` (a `.../v2` envelope) — and lowering a floor to fit
  an observation is what ADR-0043 §3 refuses.

The orchestrator ruled this architectural and routed it to row **`lang-retire`**:
how this platform retires a language member once releases have serialized it.
Until that lands, both join-eligibility obligations stay in the coverage gate's
`acceptedButUnhonoredObligationIds` inventory, so the violation is visible in the
gate itself rather than only in prose.

## The relation partition, and HONEST vs HIDDEN

`check:language-coverage` at the frozen tree:

```text
language coverage: PASS (1896 obligations; 0 receipts; 1896 decision-covered obligations; 395 first-party observations)
language coverage relation partition: 91 = 0 supported-and-exercised + 89 supported-but-unexercised + 2 accepted-but-unhonored
```

BASE was `1,899` obligations, relation `94 = 0 + 89 + 5`, 396 first-party
observations. Exactly three obligations left; none was added and none moved into
accepted-but-unhonored. The two surviving defect-inventory entries are the
join-eligibility pair named above.

| Departing obligation | Mechanism | Verdict |
| --- | --- | --- |
| `authoredLanguage:$.relations[].cardinality="oneToOne"` | the value is no longer admitted anywhere in the language and is refused by name at authoring | **HONEST** |
| `authoredLanguage:$.relations[].cardinality="oneToMany"` | same | **HONEST** |
| `authoredLanguage:$.relations[].cardinality="manyToOne"` | the value is **still authorable**. Its obligation left only because narrowing collapsed the axis to one value, and the authored derivation admits an axis only when `forced \|\| values.size > 1` (`language-conformance-ledger.ts:708`) | **HIDDEN** |

The HIDDEN row is stated, not glossed. It is not the laundering that revision 1
was rejected for: `manyToOne` **is** honoured, witnessed below by the lowering
assertion and by 19/19 real-PostgreSQL execution, so no defect entry left with
it. ADR-0041 §1 makes the singleton the mandated end state — it rules cardinality
*restricted*, not removed — and the orchestrator accepted the classification on
that basis. Correcting the instrument so a singleton axis keeps its obligation is
row **`lang-singleton`**, whose file this packet does not touch.

First-party observations move 396 to 395 for one attributed reason: the composed
application declares `cardinality: 'manyToOne'`, and that obligation no longer
exists to be observed.

### The blind spot, measured rather than argued

While revision 1 existed, removing `joinEligibility` from the language entirely
produced the **byte-identical ledger digest**
`b4cf5f064a30b1ac07382e006e5b9f91fd9fa7fd33b5cbcd414790fa3a4e6d41` as narrowing
it to the unhonoured singleton `query`. Two states differing by the whole content
of ADR-0041, and the instrument cannot see between them. The asymmetry is
mechanical and one-sided: the lowered derivation passes `includeSingletons: true`
and keeps its own singleton axes (`$.relations[].relationColumn.origin = "field"`,
`postgresqlType = "uuid"`), while the authored derivation passes `false`.

## Controls and victim evidence

| Control | Observed fact | Victim and recorded red |
| --- | --- | --- |
| `oneToOne` refusal | The real composed-app relation `northstar.app:relation.inventory_movement_transaction_line` carrying `oneToOne` returns `CANON_RELATION_CARDINALITY_UNSUPPORTED` at `$.relations[3].cardinality`, with its relation id and the accepted alternative `use cardinality manyToOne until another cardinality has executing semantics`. | `schemas.ts:583`. Restoring `z.enum(['oneToOne','manyToOne','oneToMany'])` made the test fail with exact text `error: 'Missing expected exception.'`; the literal was restored and it passed. |
| `oneToMany` refusal | The same independent observation from the same relation. | The same victim, exact text `error: 'Missing expected exception.'`. |
| the refusal is not the parent-scope guard in disguise | The witness relation is `ownership: 'reference'`, so `CANON_RELATION_PARENT_SCOPE_INVALID` cannot stand in for the authoring result. | Repointing `relationWitnessId` at the `parentScopedChild` relation `northstar.app:relation.party_role_party` made the witness fail with `expected: 'reference'` / `actual: 'parentScopedChild'`; the id was restored and it passed. |
| positive witness — normalizes and lowers | The same relation normalizes with `cardinality: 'manyToOne'` and lowers to `ownership: 'reference'` with a `uuid` relation column. | `negative-contracts.test.ts`, 25/25 green in the focused file. It uses the compiler-admitted composed relation, not the representative canonical fixture: an earlier attempt on that fixture correctly failed with `error: 'v1 storage lowering requires validated dedicated storage'`, and that mistake is recorded here so it is not repeated. |
| positive witness — executes | `test/postgres/module-runtime.test.ts` 19/19 against real PostgreSQL. A stored effect, not a declaration. | — |
| parent-scoped-child regression | With the allowed literal present, setting the fixture relation's `required` to `false` still returns `CANON_RELATION_PARENT_SCOPE_INVALID`. The narrowing does not turn the existing guard into dead evidence. | Pre-existing control at `negative-contracts.test.ts:964`, green alongside both new refusals. |

## Artifact event — nothing moved, and that was verified

Every derived artifact was re-derived by executing its real producer. None was
hand-edited and none moved, because every checked-in relation already declared
`manyToOne`.

| Artifact / profile | Before | After |
| --- | --- | --- |
| `representative.normalized.golden.sha256` / v3 | `bda130f1ac2bcbd57c7a7be906897ae09a67268467f1c7880b4a3d6c3f0f511c` | `bda130f1ac2bcbd57c7a7be906897ae09a67268467f1c7880b4a3d6c3f0f511c` |
| normalization v0-experimental | `00444e2e40aedea745ea23cc89ac5f2f01f9234dcae2473481b39134f3f036ba` | `00444e2e40aedea745ea23cc89ac5f2f01f9234dcae2473481b39134f3f036ba` |
| normalization v1 | `7126210813d43a1b8097f8500c8d3ece3ef5966dfdbe27bbfe988f035bcd0231` | `7126210813d43a1b8097f8500c8d3ece3ef5966dfdbe27bbfe988f035bcd0231` |
| normalization v2 | `538ed9deca0fed3f2c2340ce05ce65213fbacb02f153544b1d58cc9844d5048a` | `538ed9deca0fed3f2c2340ce05ce65213fbacb02f153544b1d58cc9844d5048a` |
| `apps/web/release/app.authored.json` | `0217868f16700ea8c770f5d569e3796594885d391185ada3d810c7807b066f37` | `0217868f16700ea8c770f5d569e3796594885d391185ada3d810c7807b066f37` |
| `apps/web/release/app.compiled.json` | `a7282d06141017fea1a24fcb9fec33a508162abef6644ada7d2951c046122b49` | `a7282d06141017fea1a24fcb9fec33a508162abef6644ada7d2951c046122b49` |
| `apps/web/release/shell.authored.json` | `9584ff11af5fcdb4fc786b626a4f061b2d470d3d82c09f427011820bf0aeb2eb` | `9584ff11af5fcdb4fc786b626a4f061b2d470d3d82c09f427011820bf0aeb2eb` |
| `apps/web/release/shell.compiled.json` | `b7e98e880b4f10f00bfa67defc9e657b417b39093c52221a3b610135d07e9692` | `b7e98e880b4f10f00bfa67defc9e657b417b39093c52221a3b610135d07e9692` |
| `v1-v2.release.structural.golden.json` | `92c319b4df213c10cb5044763f1709432b9c6187677fc684e3d357140f99b26c` | `92c319b4df213c10cb5044763f1709432b9c6187677fc684e3d357140f99b26c` |
| `legal-entity-query-scope.test.ts:457` v3 manifest digest | `921ee2781fabdf5fd93f93cf07db9b27e6f41e8ad6163dbbd714da58dd9e6290` | unchanged; `test:compiler` is 117/117 without touching that file |

Authored-token telemetry stays at 3,651 and normalized at 2,567; the fixture is
byte-identical to BASE.

Zero movement is expected for a substantive reason rather than assumed: every
stored input already states the only supported cardinality, so narrowing removes
alternatives nobody had written. The bootstrap and all seven application entries
retain `northstar.compiler-output/v0-experimental` and their exact roots. The
canonical golden was independently derived by executing
`normalizeApplicationPackage` and `canonicalizeAndHash`; the release artifacts by
running `generate-app-authored.ts` and `compile-app-release.ts` as writers, not
with `--check`.

## Coverage decisions — re-derived, digests recorded

The gate refused the untouched document first, before any re-derivation, exactly
as its revisit condition requires:

```text
language coverage: FAIL
LANGUAGE_COVERAGE_STALE_DECISION_DOCUMENT: test/fixtures/g2/language-conformance/coverage-decisions.json names f32d5fa17f1e5ddaf0f0a28d61d3eb5447af0235e8301bc2952231624d52f5cb, current ledger is cb0d163e90718282991f8886e3d4a0c2301de095e8d699da8f749564ae7c906b
```

| Value | Before | After |
| --- | --- | --- |
| `coverage-decisions.json` file digest | `eb49d9d3f2f9db55756bd6c69efc5837de4c5c40a30e11500d90336f349af8bc` | `76764cf74cc6120059b94ae37b09462119874482f8828b238cdaf5fa28d36a4b` |
| ledger digest | `f32d5fa17f1e5ddaf0f0a28d61d3eb5447af0235e8301bc2952231624d52f5cb` | `cb0d163e90718282991f8886e3d4a0c2301de095e8d699da8f749564ae7c906b` |
| obligation count | 1,899 | 1,896 |
| observed count | 396 | 395 |
| defect inventory | 5 entries (3 cardinality + 2 join eligibility) | 2 entries (join eligibility only) |
| `acceptedButUnhonoredSetDigest` | `fe4d7cf40755d45a65b980e779e35ad715ff5b57a9dde6b6ee96d1687cdc4d87` | `1182b596eb701e61cb8de3d7fd072da933de7785001c04934916b6c3776b7d0f` |

Every digest, the observation bitmap, and all three decision identities were
produced by executing the ledger's own exported derivations
(`deriveLanguageCoverageLedger`, `observeLanguageCoverage`,
`encodeLanguageCoverageObservationSnapshot`, `deriveDecisionSetDigest`,
`deriveObligationSetDigest`, `deriveLanguageCoverageDecisionId`). No digest was
written by hand and no decision identity was carried forward — retaining an old
identity is refused with `LANGUAGE_COVERAGE_STALE_DECISION_IDENTITY`.

The relation-scope decision's rationale and revisit condition now state the
open join-eligibility violation and name `lang-retire` as its owner, so the
deferral is bound into the digest rather than living only in this document.

## Scope

No compiler conformance source changed. No relation semantics were implemented on
speculation. No language-coverage instrument was changed —
`test/helpers/language-conformance-ledger.ts` belongs to `lang-singleton` and
`apps/web/scripts/compile-app-release.ts` to `lang-retire`. No floor in
`composed-application.test.ts` was lowered. Future one-to-one or one-to-many
support must arrive with executing storage semantics and its own negative
controls.

## Review history

**Critical review round 1 — REVISE, upheld, then removed from the charter.**
Fresh naive Codex `gpt-5.6-sol` xhigh reviewed frozen SHA
`a2af1634547b2456da8dac56d00f47dd4062cc40` and found that `joinEligibility:
'query'` remained accepted with no consumer, so clearing the defect inventory
laundered an existing defect against ADR-0041. The finding was upheld. Raw
evidence: `/home/rvham/2rain-missions/langnarrow-codex-review-a2af163.result.txt`.

The attempted revision removed the member, which made the checked-in release
lineage unproducible. The orchestrator ruled that blocker architectural, routed
it to `lang-retire`, scoped this packet to the cardinality half, and **reset the
revise count to zero** because the finding was removed from this packet's
charter rather than answered by it.
