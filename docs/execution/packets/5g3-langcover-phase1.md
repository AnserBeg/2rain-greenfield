# 5g3-langcover phase 1 — relation and graph shape coverage

Status: phase-1 analysis candidate; no fixture, test, or product change

Base: `6ecc851`

Derived artifact: [`5g3-langcover-phase1-shape-space.json`](../baselines/5g3-langcover-phase1-shape-space.json)

Artifact SHA-256:
`21923652234127d8c7de8090875be7564cadbe2cc3094b74f6b4682b2ae4976d`

## Ruling

The schema-derived artifact is the authority for **which finite language axes
exist**. A sibling semantic corpus must be the authority for **whether each
supported shape works at the layer where its meaning becomes observable**. A
shape is covered only when a discriminating value reaches that layer and a
negative arm proves the observation can fail. Declaration, lowering, and
materialization alone are not coverage: the blank optional-link defect passed
all three.

The phase-2 gate must use an exact partition of schema-derived obligations:
supported-and-exercised, supported-but-unexercised, or accepted-but-unhonored.
The last category is a defect inventory, never an expected-output baseline.

## 1. Derived shape space

### Finite relation axes

`normalizedRelationDefinition` admits these semantic axes
(`packages/canonical-model/src/schemas.ts:581-601`):

| Axis | Admitted shapes | Authored default or restriction |
|---|---|---|
| `archiveBehavior` | `restrict`, `retainReference` | required |
| `cardinality` | `oneToOne`, `manyToOne`, `oneToMany` | required |
| `foreignKeyActions` | absent, or exactly `onDelete: restrict` + `onUpdate: restrict` | optional; no other action exists |
| `joinEligibility` | `none`, `query` | optional in authored form; `none` at normalization |
| `lifecycle` | `active`, `retired` | optional in authored form; `active` at normalization |
| `ownership` | `reference`, `parentScopedChild` | required |
| `required` | `false`, `true` | optional in authored form; `false` at normalization |
| endpoints | any resolved source-entity and target-entity references | both required |

The three authored defaults are applied at
`packages/canonical-model/src/normalize.ts:327-333`. Their omission is an
authored spelling of the normalized value, not a fourth semantic value.
`relationId`, `orderKey`, `schemaVersion`, and `kind` are identity, ordering,
version, and discriminator coordinates; they do not multiply the semantic
behavioral matrix.

The Cartesian product is not the admitted behavioral space.
`parentScopedChild` is narrowed at authoring time to exactly one required,
`manyToOne`, `restrict` link to a distinct top-level entity in the same module,
and a child may have only one such owner
(`packages/canonical-model/src/normalize.ts:1383-1389,1442-1490`). Therefore:

- the only admitted parent-scope behavioral tuple is
  `{ parentScopedChild, manyToOne, required: true, restrict }`;
- invalid parent-scope cardinality, optionality, archive behavior, self-edge,
  nested-parent, cross-module, and duplicate-owner shapes are authoring-time
  refusal obligations, not runtime cases;
- `reference` relations retain the full cardinality, archive, required, and
  graph topology space.

### Graph axes

The schema does not declare a graph-size bound. Arrays of entities and relations
plus independently resolved source and target references induce a directed
multigraph. The semantic topology classes are:

- no edge and one distinct-node edge;
- self-edge;
- parallel edges between the same nodes;
- path/chain;
- directed cycle;
- fan-out and fan-in;
- converging diamond, including equal-depth convergence;
- disconnected components; and
- a sequence of package revisions, whose transition graph is a lineage chain.

Arbitrary node and edge counts make exhaustive graph enumeration impossible.
These classes are the stopping boundary because each changes traversal,
identity, optionality, or transition behavior. Varying the number of isomorphic
leaves after the relevant class has executed adds volume, not a new semantic
shape. Lineage length remains a separate boundary axis: `1`, `2`, and a long
case such as `80` distinguish bootstrap, one transition, and growth behavior.

Parent-scope restrictions reject its self-edge, nested chain, cycle, and
multiple-owner variants. Reference relations admit those topologies; the schema
performs reference resolution only
(`packages/canonical-model/src/normalize.ts:1094-1107`) and places no further
topology restriction on them.

### Operation-effect evolution axis

The artifact also records all nine `operationEffect` variants so a future
effect kind is mechanically visible: create, update, archive, restore, delete,
purge, destroy, transition-state, and registered-capability
(`packages/canonical-model/src/schemas.ts:894-940`). This is an evolution
sentinel, not permission to claim every effect is in the relation-only phase-2
corpus.

## 2. Three-way coverage classification

“Exercised” below means a discriminating observation, not merely a declaration
or matching projection. Safe typed refusal is exercised behavior when refusal
is the platform's explicit contract.

### (a) Supported and exercised

| Shape | Evidence |
|---|---|
| Parent-scoped required `manyToOne` + `restrict` | The ordinary fixture declares exactly this tuple (`test/fixtures/g2/module-conformance/definitions.ts:229-247`), real PostgreSQL create/update/archive/restore executes it (`test/postgres/module-runtime.test.ts:1120-1185,2382-2477`), and invalid parent-scope shapes have typed canonical negatives (`test/unit/canonical-model/negative-contracts.test.ts:880-943`). |
| `archiveBehavior: restrict` | Verification emits `archiveRestrict` only for an active restrict relation (`packages/compiler/src/projections.ts:751-762`) and the real provider observes both the refused parent archive and accepted child archive (`packages/postgres-provider/src/release-verification-service.ts:1480-1511`). |
| `ownership: reference` versus parent ownership | Inventory's real terminal-state control observes that a reference does not inherit aggregate-parent preconditions while a parent-scoped child does (`test/postgres/inventory-terminal-state.test.ts:352-395`). This is post-Inventory evidence, so calibration still asks whether the sibling corpus would have caught it earlier. |
| Active lifecycle, including authored omission | The fixture omits relation lifecycle, normalization supplies `active`, and its relation reaches compiler, materializer, operations, runtime, and verification. |
| Explicit restrict/restrict foreign-key actions | The fixture authors the only admitted pair (`definitions.ts:233-237`); storage emits the pair on the compiled foreign key (`packages/compiler/src/storage.ts:1084-1103`), and wrong/missing relation targets are refused by the real database/runtime path. |
| Resolved endpoints and unresolved-reference negative | Normalization resolves both endpoints (`normalize.ts:1094-1107`); canonical negative controls refuse invalid relation topology and unresolved references before lowering. |
| Record effects: create, update, archive, restore | The fixture declares all four (`definitions.ts:514-541`) and the PostgreSQL fixture journey executes all four. |
| `deleteRecordEffect` | Its supported platform behavior is fail-closed. The compiler emits `COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED` (`packages/compiler/src/conformance.ts:1226-1240`), and the delete negative is observed at `test/compiler/g2-module-conformance.test.ts:1100-1119`. |

### (b) Supported but unexercised

These are coverage obligations. They may not be entered as “expected current
behavior”; phase 2 must execute their distinguishing value.

| Shape | What is present, and what is missing |
|---|---|
| `archiveBehavior: retainReference` | It is carried into `StorageRelationTarget` and the runtime branches on it, and compiler transition tests construct it (`test/compiler/g2-module-storage.test.ts:873-898,1193-1210`). No real runtime control proves that an active reference survives target archive/restore without acquiring restrict semantics. |
| `required: false`, including authored omission | Nullability reaches storage (`packages/compiler/src/storage.ts:1178-1193`) and create input validation, but verification currently populates every relation input recursively (`release-verification-service.ts:1535-1571`). No pre-Inventory fixture left the link blank; the resulting restore failure is defect 3. Optional-self arrangement and blank-link restore are known red cases, not a green baseline. |
| Retired relation lifecycle | Active relations are excluded from operation inputs (`packages/compiler/src/projections.ts:431-435`) while additive storage retains historical structure. There is no end-to-end relation retirement case proving both sides of that contract. |
| Omitted `foreignKeyActions` | The only possible physical behavior is still restrict/restrict, but the current fixture always authors the object. The omission spelling lacks a discriminating transition/materialization control. |
| Single reference edge independent of Inventory | The machinery supports it, but the established synthetic fixture has only a parent-scoped edge. Its current strongest differentiating observation comes from Inventory, too late for the stated purpose. |
| Reference self-edge and optional self-edge | The language admits both. The latter exposed recursive arrangement and blank-link restore defects. A sibling corpus must separately prove unset and populated cases so fixing recursion cannot mask restore again. |
| Reference chain, cycle, parallel edges, fan-out, fan-in, equal-depth diamond, and disconnected components | The schema admits them, but the fixture's graph has two nodes and one edge. The equal-depth diamond is defect 4's exact missed shape. Required cycles also need a constructibility decision: a test cannot call an impossible sequential create “covered.” |
| Long revision lineage | Current fresh-tenant work proves the serving release is verified once and transitions remain exact, but the language-conformance fixture does not carry a `1/2/80` lineage calibration corridor. |
| `purgeRecordEffect` and `destroyRecordEffect` refusal | Both share the compiler's destructive-effect refusal with delete, but neither has its own recorded negative arm. The exact partition must exercise each enum member independently rather than infer them from one shared branch. |

### (c) Accepted and then unhonored — defects, never baselines

| Shape | Evidence and required disposition |
|---|---|
| Reference `cardinality`: `oneToOne`, `manyToOne`, `oneToMany` | All three are accepted, but `StorageRelationTarget` carries no cardinality (`packages/compiler/src/storage.ts:497-516`) and relation lowering never reads it (`storage.ts:1156-1194`). All three produce the same source-side UUID foreign key. `oneToOne` has no uniqueness; `oneToMany` has no collection-side representation; `manyToOne` merely coincides with today's physical layout. Cardinality therefore needs a remediation packet or an authoring-time rejection decision for unsupported values. The accidental `manyToOne` coincidence must not be baselined as implementation. |
| `joinEligibility`: `none`, `query`, including omitted=`none` | Normalization supplies the value and authored projection strips the default (`packages/canonical-model/src/normalize.ts:327-333,465-468`), but no compiler storage, query, or runtime consumer uses it. Both values are behaviorally identical. It needs implementation or authoring-time rejection before a conformance gate may call either covered. |
| State-machine/`transitionStateEffect` semantics (wider axis) | State machines are accepted and lowered to derived storage columns (`packages/compiler/src/storage.ts:750-773`), but no runtime enforces transitions. Row `5g3-sm` already owns the enforce-or-retire decision. This is outside relation phase 2 and must remain a red/unclassified obligation until that ruling lands. |
| `registeredCapabilityEffect` at this base (wider axis) | The schema and ADR-0038 admit it, but the pinned operation gateway accepts only four record effects and requires `effect.entity` (`packages/runtime/src/semantic-operation-gateway.ts:819-830`). The separately owned capability-operation work must close it; this instrument must not bless the runtime refusal as implementation of the authorized effect. |

The relation-scope category (c) is therefore small: two declaration axes,
cardinality and join eligibility. It is more consequential than the larger
category (b), because category (b) says “machinery exists but evidence is
missing,” while category (c) says the authored contract is false.

## 3. Calibration against the six escaped defects

| Defect | Would the proposed full instrument catch it before Inventory? | Mechanism |
|---|---|---|
| 1. Fresh install replayed verification for every historical release | **Yes, but not from the schema artifact alone.** | The sibling evolution corridor must run lineage lengths `1`, `2`, and `80`, observe exactly `N-1` transition applications and exactly one serving-release verification, and include a negative arm that observes the old `N` verification count. This tests growth class, not elapsed time. |
| 2. Verification recursively arranged an optional self-reference | **Yes.** | An optional self-edge case invokes real verification arrangement with the edge unset and observes a bounded record count. The negative arm restores unconditional relation recursion and must exceed/refuse the bound before disk or stack exhaustion. |
| 3. Blank optional link archived but could not restore | **Yes.** | A distinct runtime case creates with the optional link absent, archives, and restores. It observes restored persisted state. It must not share arrangement with defect 2, because auto-populating the link repairs the subject before measurement. The pre-fix inner join at `module-runtime-interpreter.ts:1081-1090` makes this red. |
| 4. Equal-depth converging paths collided on one UUID | **Yes.** | A diamond case arranges both paths, observes distinct identities for both path instances and a complete exact scenario partition. The negative arm restores depth-only `${token}-parent` identity (`release-verification-service.ts:1565-1569`) and observes the uniqueness collision. |
| 5. CI gate measured its own one-minute load-average echo | **No.** | This is measurement-instrument validity, not a canonical language or graph shape. It belongs to the performance-gate contract: quiet-machine qualification and direct work observation. Claiming it here would add no mechanism. |
| 6. 4,739 redundant artifact loads where 17 sufficed | **No.** | This is provider cost and cache-key behavior. A conformance corpus could amplify it but would not detect it without a load counter and explicit cost invariant. `5g3-activation-cost` owns that measurement; duplicating it here would turn language coverage into a performance suite. |

The honest score is four of six for the complete proposed instrument, and zero
of six for the derived artifact by itself. The artifact prevents obligation
staleness; semantic cases catch defects.

## 4. Fixture ruling — add a sibling

Do **not** extend `test/fixtures/g2/module-conformance/definitions.ts` into the
shape corpus.

Evidence:

- it is a 648-line, deliberately v3-pinned ordinary-module corridor; tracking
  current language previously re-authored it and reddened 32 unrelated compiler
  tests (`definitions.ts:6-17`);
- it has exactly one relation and no state machine (`definitions.ts:229-250`);
- ten test files consume it directly, indirectly through `v3-definition.ts` and
  `v4-definition.ts`, or structurally through the architecture pin;
- its release and transition structures are frozen by
  `v1-v2.release.structural.golden.json` and
  `v1-v2.transition.structural.golden.json`
  (`test/compiler/g2-module-conformance.test.ts:115-134` and
  `test/compiler/g2-module-storage.test.ts:90-109`).

Adding combinatorial relations there would move ordinary regression roots and
two goldens every time coverage grows. That would make reviewers distinguish
intentional corpus expansion from collateral fixture churn and would encourage
freezing category (c) behavior simply to keep the corridor green.

Phase 2 should add a sibling language-shape corpus with one minimal definition
per semantic case and explicit expected disposition. It may reuse stable public
compiler/test helpers, but must not mutate the ordinary fixture in place. The
existing fixture remains the broad ordinary-module regression and metamorphic
runtime seed; the sibling becomes the small, discriminating conformance
instrument. A new test file must be registered in all three reachability
inventories.

`packages/compiler/src/conformance.ts` is not a precedent for deriving this
corpus. It is an Inventory-specific pinned contract checker (for example
`inventory` relation rules at `:1015-1071`), useful as a precedent for typed
fail-closed diagnostics but a warning against hand-listing a supposedly general
language inventory.

## 5. Phase-2 packet size and order

Six packets is the honest size. The first two close false language promises;
the next three build the relation instrument; the sixth follows the separate
state-machine ruling needed by purchasing and sales.

| Order | Packet outcome | Tier | Why it precedes the next module |
|---|---|---|---|
| 1 | Resolve reference cardinality: implement discriminating `manyToOne`/`oneToOne`/`oneToMany` semantics, or reject unsupported values at authoring time. | Critical | Purchasing and sales introduce multi-party links and document-to-line graphs. Cardinality cannot remain decorative when those models are authored. |
| 2 | Resolve `joinEligibility`: make `none` and `query` enforceably different, or reject the unsupported spelling. | Critical | Multi-party purchasing/sales reads are likely to need declared joins. A query must not infer permission from a flag the compiler ignores. |
| 3 | Build the schema-derived exact-partition gate over the accepted artifact: every derived obligation must be exercised, explicitly refused, or recorded as an unresolved defect; category (c) cannot be admitted as expected. | Critical | This is the anti-staleness mechanism. Its negative controls add a relation flag, enum member, and effect kind and require an uncovered-obligation failure. The pending instrument-scope verdict may refine its storage shape. |
| 4 | Add the sibling compiler/storage corpus for relation value pairs and topology classes, including typed parent-scope refusals and transition evolution. | Behavioral | It gives the next module a cheap authoring/lowering check before PostgreSQL and avoids moving the established fixture's two goldens. Use pairwise value coverage plus every topology class, not the full Cartesian product. |
| 5 | Add real PostgreSQL/runtime/verification cases for the discriminating shapes: absent/populated optional reference, retain-reference archive/restore, self-edge, cycle policy, fan-in/out, diamond identity, and the `1/2/80` lineage observation. | Critical | This is where defects 1-4 become observable. Separate cases prevent verification arrangement from repairing the blank-link subject. |
| 6 | After row `5g3-sm` rules enforce-versus-retire, extend the derived obligations and sibling corpus to state-machine transitions and approval-chain graph cases. | Critical if enforced; Behavioral if rejected at authoring | Purchasing and sales depend on state machines and approvals. Building green state-machine fixtures before the ruling would baseline an unenforced concept. |

The stopping rule is pairwise coverage across supported finite relation values,
plus every behaviorally distinct graph topology class, plus targeted three-way
interactions where code branches on three axes (notably optional + self-edge +
restore, and ownership + archive behavior + lifecycle). The corpus knowingly
does not enumerate isomorphic graph sizes, all entity counts, all order keys, or
all finite-axis Cartesian products. New schema values reopen the exact partition
automatically; new semantic interactions require a recorded risk argument and a
discriminating case, not a larger blind matrix.

## Verification performed in phase 1

No fixture, test, compiler, runtime, migration, or product file changed. No test
suite or matrix ran, as chartered. The accepted baseline was independently
re-derived byte-identically and its sensitivity was already observed: adding a
relation field, cardinality value, or effect kind changes the artifact digest.
