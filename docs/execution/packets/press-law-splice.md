# press-law-splice — make PRESS006 observe the identity it claims to govern

Date: 2026-08-20
Base: `8136cfaa8caf23a73221cfa2b0feb5c90987556b` (`origin/main`, fetched and
verified before cut)
Branch: `packet/press-law-splice`
Tier: Critical — the diff changes what an architecture gate proves
Status: active; candidates `318c0dd719a7d759d313ee45ca080017e5e36b44`,
`4f0d19e475977956f26e3e5238ef90bcc90936a5`, and
`358ba5fe7a66d530b1388979953a12bea81e2aae` returned REVISE; candidate
`e02c15c9dc772cb772ceb3c851c606a95eb209c6` received a fresh Codex PASS and
then a Fable REVISE on a newly found production false green. Candidate
`d82350103b362ae20448822c122057c53d5ef41e` returned REVISE on an unknown-left
boundary production defect and a plural partial-run control gap. Candidate
`c5fb4e14df0edaabfd26c014e17ffae7934de5fd` returned REVISE because the raw
source observer still mistook literal-token punctuation for runtime adjacency.
Candidate `ebbb65ecf8d93e4a3742e1c0eb7c0d2b3e950dc1` returned REVISE because
construction ownership included type-literal descendants that do not contribute
to the runtime value. Candidate
`a58d3e7356b32d1e9d839fcfbd00318e40d6c94a` returned REVISE with production
correct and one shared transparent-wrapper-grammar control survivor. The
round-9 test-only correction pinned all five wrapper forms. Candidate
`93a0f37715378bf227dcdee17e5558afd1301456` returned REVISE because a
literal-only TypeScript template-literal type fell outside the runtime-expression
observer. Candidate `0bba84397f190ba7c3d8e09022dfa22c006d0ce3` returned REVISE
because that first type-space channel was skipped beneath completed runtime
constructions and left unresolved outer template types to the raw source
observer's punctuation boundaries. Candidate
`76d328d417201dfd355fb4c0dcbf650a4f3b95f4` returned REVISE because partial
template-type diagnostics used interpolation-token positions, while nested exact
composition, `false`, and plural partial type runs were not load-bearing under
the controls. Candidate `2a8f19e7f1432e941ace733a7d4d68313abbb73b`
returned REVISE with production correct and two control survivors: count-preserving
first-value reuse at one node, and whole-node ownership of unresolved type spans.
The round-13 test-only correction requires a distinct third identity in the
same-node plural control and retains a raw identity inside an unresolved union.
Candidate `a6b922998c17b6c41d3c3975adf6436025f01add` was accepted as the
last broad review round. The final test-only correction makes untagged
no-substitution template literals load-bearing in incomplete runtime
concatenations and declares the observer's closed grammar. Candidate
`d4d40339df78c82d36bc68da5b3ba65dcf47f815` received the prescribed narrow
confirmation PASS: the reviewer closed both the deletion causality and declared-
grammar questions, independently verified the branch/ranges and byte-identical
production, and found no in-scope material defect. Review has converged; the one
deferred full matrix is next on the constructed integration tree.

## Packet definition

Goal: stop `PRESS006_MODULE_ID_IN_PRESS` from reporting a false green when a
module identity is assembled from static string literals, while keeping the
current inventory posting identity visible as explicitly owned transition debt.

Owned executable paths:

- `packages/postgres-provider/src/inventory-posting-service.ts`
- `packages/dev-tooling/src/module-press-law.ts`
- `test/architecture/module-press-law.test.ts`

Owned narrative paths are this packet record and this packet's own rows in
`current-plan.md`, `ledger.md`, and `lanes.md`. `review-log.md` is not changed
before an external verdict exists.

Out of scope: `packages/compiler/src/**`, all `apps/web/src/**`, all
`packages/domain/**`, posting-engine behavior, and every other program-review
finding.

## Verified defect

Before any source change, the focused module-press-law test passed 10/10 and
reported three routed violations. It did not report
`packages/postgres-provider/src/inventory-posting-service.ts`, even though
`INVENTORY_POSTING_CAPABILITY_ID` evaluated to
`northstar.inventory:capability.posting`. The reason was direct: the constant's
source text was
`` `${'northstar'}.${'inventory'}:capability.posting` ``, while
`moduleIdentityMatch` applied the contiguous
`escapeRegExp(module.namespace)` pattern to source text.

The base tree's exact-observation debt ratchet was not a production exception
inside `packages/dev-tooling/src/module-press-law.ts`. It was the test-local
symbol `routedPlatformDebt` in
`test/architecture/module-press-law.test.ts`. This packet renames it
`routedPressLawDebt`, because the exact set now includes compiler, inventory
provider, and platform provider debt.

## Decisions

### Keep the identity as owned debt; do not enter the compiler

The identity is unspliced to the honest literal and added to the exact debt
ratchet under queue row `press-law-evasion`. This is the proportional sanctioned
path for this packet.

The adjudicated structural remedy in current-plan row `1e-2` is to pass package
context into the contract compiler and enforce that a package declares
capabilities only in its own namespace. Inspection confirmed that this is an API
change in `packages/compiler/src/**`, so taking it here would trigger the
packet's explicit stop condition. It also does **not** retire this provider debt:
[ADR-0026](../../decisions/ADR-0026-inventory-posting-capability.md) requires the
capability-local adapter to exact-match the frozen Inventory capability ID. Row
`1e-2` owns the separate hard-coded compiler-conformance identity. The provider
debt remains visible under `press-law-evasion` with no retirement path claimed;
a structural source such as typed registration, or a specifically adjudicated
capability-local adapter distinction, would need its own ruling.

### Refuse literal splicing of module identities in production press source

Yes, for the observer's declared static grammar. The runtime population
recognizes quoted string literals, untagged no-substitution template literals,
ordinary untagged template expressions, binary `+` constructions, and the
transparent parentheses, `as`, angle-bracket assertion, `satisfies`, and
non-null wrappers around those expressions. Tagged-template aggregate results
are not evaluated, while their independently evaluated substitutions remain
observable. In a separate population pass, the observer recognizes TypeScript
`TemplateLiteralTypeNode` values whose spans are exact primitive literal types,
parenthesized exact types, or nested exact template types. **Any expression or
type span outside that grammar is appended as dynamic and conservatively
padded, so an unrecognized form becomes an unknown boundary rather than a
silent absence.** This is the safety property that closes the grammar; the
observer does not need another syntax arm for every expression TypeScript can
represent.

The observer records a completed construction as one value. Inside an otherwise
dynamic ordinary runtime construction it also observes maximal statically known
runs while preserving whether either adjacent construction edge borders an
unknown runtime value. Unknown adjacency is conservatively represented by a
character that is both a word character and a namespace-continuation character
before calling the same `moduleIdentityMatches` authority as a contiguous
spelling. Thus the matcher may report only when static text or the real
construction edge proves the boundaries its identity family requires; it never
invents a string boundary at the edge of an isolated run. The guard therefore
reports `PRESS006`, rather than introducing a parallel rule or an allowlist.

The observer measures each completed ordinary runtime construction once, every
bounded partial run inside an incomplete runtime construction, each exact
template-literal type once, and every independently bounded partial run in an
unresolved outer template type. Runtime and type construction discovery are
independent, so completing a runtime value cannot suppress an exact type child.
Every run derived from one template-literal type is attributed to that semantic
owner's source start; the head, substitution, and tail ranges remain separate
ownership evidence and never decide the diagnostic location.
Raw and constructed observation are
disjoint by AST ownership: raw matching owns source occurrences outside static
construction literal tokens, while the construction observer owns matches
inside those tokens and judges them with the construction's semantic value and
adjacency. Runtime ownership follows only the same runtime expression positions
the static evaluator understands: wrapper expressions, `+` operands, and
template segments/substitutions. Type children of `as`, angle-bracket
assertions, and `satisfies` remain outside runtime ownership because they do not
contribute tokens to the runtime string; the independent type pass still
observes exact template types within them. An exact template-literal type is a
separate completed static value: ownership includes its head/tail tokens and
exact value-contributing primitive or nested type spans. Unresolved outer types
use the same conservative left/right adjacency model as incomplete runtime
constructions, while independently exact nested template types remain visible.
The bounded evaluator does not resolve aliases, generics, identifiers, unions,
or type-checker state. This prevents quotes, backticks,
interpolation syntax, or unrelated type syntax from proxying ownership, while
an already-routed literal still cannot mask a later splice in the same file.
Multiple identities inside one completed construction are all retained. This
occurrence-complete rule exposes every existing compiler contract literal under
row `1e-2`, rather than only its first occurrence.

Within an incomplete ordinary template or `+` construction, direct construction
operands remain incomplete values. Their statically known runs are considered
only when the identity's family-specific boundaries are fixed. An unbounded
`northstar.widget` prefix before a runtime suffix remains admitted, as does a
word-bounded `widget_list` immediately after an unknown prefix; a static `:` on
the relevant side fixes the boundary and makes the corresponding identity
reportable. Traversal also continues through non-construction semantic
boundaries, so a complete concatenation passed to a call is still observed. A
tagged template's aggregate result is not inferred, but each substitution
expression is evaluated before the tag receives it and is therefore visited.
These boundaries avoid the review failures: round 1 recursed through every AST
child and falsely treated nested prefixes as values; round 2 returned beneath
whole subtrees and missed independently completed call arguments and tagged
substitutions; the round-4 Fable confirmation found that treating every
incomplete construction as opaque missed a statically right-bounded identity;
and the round-6 review found that isolating a run after an unknown prefix
invented a left word boundary for local IDs and `*_IDS` symbols.

This remains deliberately narrower than symbolic execution. Unknown runtime
values, runtime identifier indirection, aliases, generic parameters,
identifier-held types, unions, and other non-exact type spans are not resolved;
the TypeScript type checker is not consulted; and a tag's return value is not
inferred. Statically known text on either side of an unknown runtime or type
value is still observed when it independently fixes the identity boundary. That
is an explicit limit: the current threat is an honest developer or AI writer
reaching for the cheap literal-interpolation or literal-concatenation dodge in
ordinary runtime or statically exact type syntax, not active obfuscation.
Banning all interpolation or all concatenation in production would reject
ordinary application code and would be a broader language-policy packet, not a
proportionate correction here.

No ADR is added.
[ADR-0011](../../decisions/ADR-0011-compiled-module-storage-transitions.md)'s
generic-interpreter/no-module-specific-branch rule and
[ADR-0023](../../decisions/ADR-0023-storageless-platform-capability-tier.md)'s
prohibition on module-ID allowlists already govern the outcome; this packet
changes the observation mechanism and records its bounded threat model rather
than creating a competing architecture authority.

## Committed controls

The controls isolate the named properties and use a Widget fixture so they do
not rely on the routed Inventory debt:

| Direction | Specimen | Observed contract |
|---|---|---|
| refusal | `` `${'northstar'}.${'widget'}:capability.posting` `` | one `PRESS006_MODULE_ID_IN_PRESS`, naming `northstar.widget` |
| refusal | `'northstar' + '.' + 'widget' + ':capability.posting'` | one `PRESS006_MODULE_ID_IN_PRESS`, naming `northstar.widget` |
| attribution | an unrelated construction followed by a multiline interpolated identity | the PRESS006 line is the template's line 3, not index zero or the earlier construction |
| additive occurrence | one direct routed identity followed by a later static splice for the same module and file | two exact PRESS006 observations at their respective lines |
| constructed multiplicity | one interpolation and one concatenation independently complete banned identities in the same file | two exact PRESS006 observations; first-constructed-only compression fails |
| within-construction multiplicity | one completed concatenation contains two bounded module identities | two exact PRESS006 observations at the construction line; first-value-match compression fails |
| same-construction deduplication | one concatenation whose literal token already contains `northstar.widget` | one observation, not one per observer |
| same-line independence | an unrelated direct identity and spliced identity occur on the same file/module/line | two observations; line-number coincidence is not construction provenance |
| provider mutation | retain the honest line-37 Inventory literal and splice the real `validateRegistration` comparison | Inventory PRESS006 contains both line 37 and the later comparison line; the routed literal cannot mask the reintroduced defect |
| constructed admission | concatenated and interpolated `northstar.widget-contract/v1` values in generic production source | zero violations; the completed legal values are measured without refusing nested prefixes |
| dynamic-boundary admission | static `northstar.widget` prefix plus an identifier-held legal suffix | zero violations; an unevaluable outer value is not partially observed |
| dynamic-boundary refusal | interpolation and concatenation fix `northstar.widget:` before an identifier-held tail, and a second interpolation ends with a spliced `northstar.widget` after an unknown prefix | three exact violations; a dynamic outer construction cannot hide an identity whose right boundary is fixed by static text or construction end |
| dynamic-tail admission | the same interpolated and concatenated static prefixes end immediately before an identifier-held suffix | zero violations; the observer does not invent a right boundary before an unknown continuation |
| no-substitution template runtime grammar | one incomplete `+` construction assembles a namespace from two untagged no-substitution template literals and fixes its right boundary with `:`, while its twin ends immediately before an unknown suffix | only the bounded form reports; narrowing the partial-run grammar from `ts.isStringLiteralLike` to `ts.isStringLiteral` loses that observation while completed constructions remain green |
| completed-continuation admission | contiguous `widget_list`, `WIDGET_IDS`, and `northstar.widget` literal tokens continue statically inside completed concatenations | zero violations; token quotes cannot override the completed runtime value's boundaries |
| contiguous/split unknown-adjacency admission | local ID, symbol, and namespace families are each written once in one literal token and once across literal tokens beside an unknown runtime value | all six admit; tokenization does not change the runtime-adjacency ruling |
| contiguous/split static-boundary refusal | the same six forms receive a static `:` at the relevant edge | six exact observations at their construction lines; the construction observer retains fixed boundaries for both tokenizations |
| type-literal ownership twin | one direct `satisfies` type literal is repeated beneath an empty runtime concatenation | both direct source occurrences report; adding a semantically neutral construction cannot transfer the type token to runtime ownership |
| runtime/type provenance companion | one completed construction contains a runtime module identity and an independent module identity in its `satisfies` type | two observations at their distinct runtime-construction and raw type-literal lines |
| transparent-wrapper grammar | the runtime namespace is split across a parenthesized, `as`, angle-bracket-asserted, `satisfies`, or non-null operand; the three typed forms also contain an independent type-literal identity | eight exact observations: one construction-derived result for every wrapper plus one raw type-literal result for each typed wrapper; deleting any shared unwrap predicate loses its construction observation |
| literal-only template type | a direct string-literal type, an equivalent spliced `TemplateLiteralTypeNode`, and a spliced longer contract type share one generic production fixture | the direct and spliced module identities each report at their own source line; the longer contract type admits; deleting the type-template construction branch loses only the spliced observation |
| independent type population | the same spliced template type appears directly beneath `satisfies` and beneath `satisfies` inside a completed runtime `+ ''` construction | both type values report; runtime completion cannot suppress a type child, and stopping the independent type pass beneath runtime constructions loses only the second observation |
| template-type right adjacency | contiguous and split namespaces precede an unresolved generic span either directly or after a static `:` | both unbounded forms admit and both colon-bounded forms refuse; raw template punctuation cannot invent the right boundary |
| template-type left adjacency | local ID `widget_list` and symbol `WIDGET_IDS` follow an unresolved generic span in head, tail, and substitution positions, with and without a static `:` | unknown-adjacent forms admit and colon-bounded forms refuse; tail and substitution ownership plus left-boundary state are both observed |
| partial template-type attribution | a multiline unresolved template type begins on one line, its unknown substitution closes on another, and a bounded local ID begins in the tail on a third | the PRESS006 line is the template-type node start, not the closing `}` or tail token |
| partial template-type multiplicity and identity | one unresolved template type contains two independently colon-bounded spliced namespaces followed by a colon-bounded split `widget_list`, with unknown type spans between them | the exact same-node sequence is `northstar.widget`, `northstar.widget`, `widget_list`; first-run truncation, identity deduplication, and count-preserving first-value reuse fail |
| unresolved-span raw ownership | a nonempty partial run surrounds an unresolved union containing a direct contiguous module identity | the direct identity remains raw-owned and reports; replacing contributing-token ranges with the whole template node suppresses it and fails |
| exact type grammar and ranges | numeric, bigint, both boolean values, null, undefined, parenthesized, and nested exact spans compose definition-derived identities; the nested specimen requires the outer tail to complete its identity; complete identities placed only in head, substitution, or tail tokens continue into legal longer values | all exact identities report once, deleting `false` or nested exact support loses only its matching observation, all three continuation forms admit, and removing head/substitution/tail ownership independently creates an extra raw observation |
| rejected outer type recursion | an unresolved union span contains an independently exact nested spliced template type | the nested exact type still reports; rejecting the outer type does not erase an independently completed type value |
| unknown-left admission/refusal | local ID `widget_list` and symbol `WIDGET_IDS` each follow an unknown prefix either directly or after a static `:` | the directly adjacent identities admit because the runtime prefix may erase `\b`; the colon-bounded twins refuse exactly at their construction lines |
| partial-run multiplicity | one incomplete outer concatenation contains two independently colon-bounded spliced namespaces separated by an unknown value | two exact observations at the two static-run positions; first-partial-run-only compression fails |
| tagged-boundary admission | a tag receives the spliced template body | zero violations; the tag controls the runtime result |
| tagged-substitution refusal/admission | a tag receives a completed concatenation spelling either `northstar.widget` or `northstar.widget-contract/v1` | the module identity refuses; the longer contract namespace admits |
| call-boundary refusal/admission | a completed concatenation is a call argument beneath a dynamic outer `+`, spelling either module or longer contract namespace | the module identity refuses; the longer contract namespace admits |
| admission | `northstar.widget` spelled by the Widget definition itself | zero violations beside a non-module generic production file |
| live debt | unspliced inventory posting capability literal | the exact provider observation remains at line 37 inside the occurrence-complete eleven-item routed set |

The first candidate's focused run passed 13/13. The corrected focused run passes
16/16 and reported four exact live violations. The round-3 focused run passes
23/23 and reports eleven exact live violations: eight pre-existing compiler
contract literals owned by row `1e-2`, the Inventory posting provider debt owned
by `press-law-evasion`, and the two unchanged Platform provider debts.
The round-4 development run passes 25/25 against byte-identical production.
The reviewer-selected `.slice(0, 1)` mutation fails the plural constructed
control by omitting line 2, and same-line deduplication fails the same-line
independence control by omitting its second observation. Both focused mutation
runs selected their corresponding committed control. Both mutations were
restored with explicit inverse patches; the production file is byte-identical to
candidate `358ba5f`.

The round-5 focused run passes 27/27. Its new paired fixtures hold the Fable
finding directly: interpolation and concatenation refuse when static text fixes
the `:` boundary before a runtime tail, a spliced identity at the known end of a
construction also refuses, and the otherwise equivalent prefixes admit when the
runtime value begins immediately after `widget` and no right boundary can be
inferred.

The round-6 focused run passes 29/29. Before the production correction, the new
unknown-left twin emitted four observations instead of the expected two: both
`widget_list` and `WIDGET_IDS` falsely reported immediately after an unknown
prefix, as well as correctly after a static colon. After preserving both
adjacencies through the shared matcher, only the colon-bounded lines report.
The second new fixture requires two exact partial-run observations in one
incomplete construction. The reviewer-selected `return runs.slice(0, 1)`
mutation fails that control by omitting the second line, and the explicit
inverse patch restores the production source and the focused green.

The round-7 focused run passes 33/33. Before the production correction, the
contiguous/split unknown-adjacency admission emitted three false observations:
only the contiguous literal-token forms of `widget_list`, `WIDGET_IDS`, and
`northstar.widget` failed, while their split runtime-equivalent forms admitted.
Routing every ordinary-construction literal token through the construction
observer makes all six forms agree and retains all six static-colon refusals.
The completed-continuation admission separately proves that source quotes do not
override known runtime continuation. Temporarily restoring unconditional raw
source observations makes both admission controls fail on exactly their three
contiguous forms. Temporarily retaining only the first identity match within a
completed construction makes the within-construction multiplicity control lose
its second required observation. Explicit inverse patches restored both
mutations before the final focused 33/33 run.

The round-8 focused run passes 35/35. Before the production correction, the
type-literal ownership twin lost only the occurrence beneath `+ ''`, and the
runtime/type provenance companion lost only its independent type-literal
observation. Replacing the runtime-only range traversal with the reviewed
unrestricted `ts.forEachChild` proxy reproduces those same two missing
observations. Stopping at a transparent type wrapper instead makes the stronger
provenance companion report its runtime identity twice—once raw and once
constructed—while retaining the independent type occurrence. Explicit inverse
patches restored both mutations before the final focused run.

The round-9 focused run passes 36/36 against production byte-identical to
candidate `a58d3e7`. Before adding the new control, deleting only
`ts.isSatisfiesExpression` from the shared `unwrapStaticStringExpression`
grammar left all 35 controls green. The committed fixture splits
`northstar.widget` through each of the five transparent wrapper forms and keeps
independent type-literal companions for `as`, angle-bracket assertion, and
`satisfies`. Replaying that exact predicate deletion now fails only the new
wrapper control, leaving the other 35 green. The inverse patch restored the
production source before the final focused run; no mutation runner is committed.

The round-10 focused run passes 37/37. Before the production correction, the
new type-space fixture reported only its direct string-literal type and omitted
the equivalent literal-only template-literal type; the longer contract template
type remained admitted. The bounded `TemplateLiteralTypeNode` observer now
evaluates only string-literal type spans, records only their value-contributing
literal ranges, and sends the completed value through the existing matcher.
Deleting only that node branch reproduces the same one missing observation: the
direct type literal remains reported, the spliced type disappears, and the
longer contract type remains admitted. The explicit inverse patch restored the
production source before the final focused 37/37 run; no mutation runner is
committed.

The round-11 focused run passes 42/42. Before the production correction, the
five new controls produced 38/42: the type template beneath a completed runtime
construction disappeared, the contiguous unknown-right type form falsely
reported through the raw observer, all unknown-left local-ID and symbol forms
falsely reported, and only the independently nested exact type was observed
from the exact-span table. The correction runs type-template discovery as an
independent AST population, evaluates exact primitive and nested spans, and
routes unresolved outer types through the same bilateral partial-run boundary
collector used by runtime constructions. Targeted discarded mutations then
proved the new properties separately: stopping type descent beneath runtime
construction lost only the wrapper-composition observation; deleting type
partial runs failed both adjacency tables; deleting numeric exact-span support
failed only the exact-grammar control; deleting rejected-span recursion failed
only the nested control; and deleting head, substitution, or tail ownership
made the corresponding legal continuation report raw. Every mutation was
restored by an explicit inverse patch before the final focused run; no mutation
runner is committed.

The round-12 focused run passes 44/44. Before the production correction, the
new multiline attribution control made the focused suite fail 43/44: the
bounded `widget_list` observation was reported at the closing interpolation
token on fixture line 3 rather than the owning template-type node on line 2.
The correction gives every static run from one `TemplateLiteralTypeNode` the
node's source start while retaining its value-contributing literal ranges only
for ownership. The exact-grammar control now uses a nested value that requires
outer-tail composition and includes a distinct `${false}` identity. A separate
unresolved type contains two bounded runs. Targeted discarded mutations proved
each property independently: deleting nested exact support lost only
`widget_nested`; deleting `FalseKeyword` support lost only `widget_flagfalse`;
and truncating template-type runs to one lost the second required observation.
Every mutation was restored by an explicit inverse patch before the final
focused run; no mutation runner is committed.

The round-13 focused run passes 45/45 against production byte-identical to
round 12. The same-node unresolved-type control now retains its two repeated
namespace observations and adds a distinct `widget_list` observation, so
cardinality alone cannot substitute for independent classification. A new
unresolved-union fixture requires the raw observer to retain a direct module
identity outside the partial run's contributing literal tokens. The
reviewer-selected node-index first-value cache kept all three outputs but
changed the third identity from `widget_list` to `northstar.widget`, failing the
exact array. The whole-node range mutation changed the raw-ownership fixture
from one observation to `[]`. Both mutations were restored by explicit inverse
patches before the final focused run; no mutation runner is committed.

## Gate evidence

Round 1 ran in the declared order from this isolated worktree:

| Gate | Result |
|---|---|
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 144/144, including 13/13 module-press-law tests and the exact four-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 950,680.8 ms |

Before each exclusive suite, the lock-holder registry was empty. The measured
CPU idle windows were 95.5% before Architecture and 96.0% before PostgreSQL.

Round 2 corrected the review findings and reran the same declared sequence:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` | PASS — 16/16; an earlier attempt executed no test and honestly refused with `TEST_GATE_LOCK_BUSY` behind another lane's PostgreSQL holder |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 147/147, including 16/16 module-press-law tests and the exact four-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 1,034,871.5 ms |

The exclusive-suite lock registry was empty at both round-2 starts. Direct CPU
idle was 93.7% before Architecture and 97.5% before PostgreSQL. The evidence-only
documentation update after those executable runs changes no executable path.

Round 3 corrected the two material round-2 gate defects and reran the declared
sequence:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` | PASS — 23/23, including additive direct/constructed occurrences, same-construction deduplication, the real provider comparison mutation, and both semantic-boundary refusal/admission pairs |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 154/154, including 23/23 module-press-law tests and the exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 827,388.0 ms |

Both exclusive suites acquired the repository's serialized lease after a
transient wait. The evidence-only documentation update after those executable
runs changes no executable path.

Round 4 changes only committed architecture controls and reran the declared
sequence against production byte-identical to candidate `358ba5f`:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` | PASS — 25/25; the two reviewer-selected mutations also produced the intended focused reds before explicit restoration |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 156/156, including 25/25 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 1,243,360.4 ms |

Both exclusive suites acquired the repository's serialized lease after a
transient wait. The evidence-only documentation update after those executable
runs changes no executable path.

Round 5 corrects the production false green found by the Fable confirmation and
reran the declared sequence:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` | PASS — 27/27; before the implementation change the new refusal returned `[]` while its unbounded-prefix admission passed |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 158/158, including 27/27 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 1,274,397.2 ms |

Both exclusive suites acquired the repository's serialized lease. The focused
expected red was run before the implementation change and failed specifically
because both required PRESS006 observations were absent; its admission twin was
already green.

A per-check deletion audit after the first round-5 freeze added one expected
observation to the same refusal fixture: a spliced identity after an unknown
prefix at the known end of the construction. This evidence-only descendant
reran focused 27/27, typecheck, lint, format, and Architecture 158/158 green.
Four earlier focused attempts executed zero tests and refused honestly with
`TEST_GATE_LOCK_BUSY` behind another lane's live PostgreSQL holder. PostgreSQL
was not rerun for the evidence-only test edit; the production blobs are
byte-identical to the 203/203 run above, and the PostgreSQL command does not
discover architecture tests. The full matrix remains the integrated-tree
authority after review convergence.

Round 6 corrects the unknown-left-boundary production defect and the plural
partial-run control gap found in the review of `d823501`:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` | PASS — 29/29; before the implementation change the unknown-left twin returned four observations instead of two, while the plural partial-run control already passed |
| reviewer-selected `return runs.slice(0, 1)` mutation | EXPECTED RED — the exact plural partial-run control lost its required second observation; the inverse patch restored the two focused controls green |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 160/160, including 29/29 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 1,113,668.6 ms |

Both exclusive suites acquired the repository's serialized lease. The focused
pre-fix red failed only because the two unknown-left admissions falsely emitted
PRESS006; both statically colon-bounded refusal twins were already present. The
mutation replay selected only the newly committed plural partial-run control.
No mutation runner is committed, so these discarded local replays are
corroboration; the exact committed fixtures are the reproducible load-bearing
evidence.

Round 7 corrects the raw-source runtime-adjacency defect found in the review of
`c5fb4e1`:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` | PASS — 33/33, including contiguous/split equivalence across local-ID, symbol, and namespace families plus two identities in one completed construction |
| unconditional raw-observer mutation | EXPECTED RED — both admission controls gained exactly the three prohibited contiguous-token observations; explicit restoration returned them green |
| first-identity-in-construction mutation | EXPECTED RED — the exact within-construction multiplicity control lost its required second observation; explicit restoration returned it green |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 164/164, including 33/33 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 860,483.2 ms |

The first Architecture attempt reached all 164 tests but failed one
repository-hygiene control because another lane's fresh PostgreSQL container was
present. The other lane's container was left untouched; after its owning process
and container exited, the exclusive retry passed 164/164. The two discarded
mutations are corroboration only; their committed controls are the reproducible
evidence. PostgreSQL then acquired the exclusive lease and passed 203/203.

Round 8 corrects the type-literal ownership defect found in the review of
`ebbb65e`:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` | PASS — 35/35, including the empty-concatenation ownership twin and the separate runtime/type provenance companion |
| unrestricted-descendant range mutation | EXPECTED RED — both new controls lost their independent type-literal observation; explicit restoration returned them green |
| wrapper-stop range mutation | EXPECTED RED — the provenance companion gained a duplicate raw runtime observation while retaining its constructed and type-literal observations; explicit restoration returned it green |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 166/166, including 35/35 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 971,999.4 ms on gate tree `86d1a8554eec8d5368e7c6a2b2f07ee4ec05d5c3` |

The pre-fix focused run failed both new controls for exactly the missing
type-literal observations. The discarded mutations are corroboration only; the
committed one-property twin and provenance companion are the reproducible
load-bearing evidence. The unrestricted-descendant replay was selected by the
review finding; the wrapper-stop replay was author-selected. No mutation runner
is committed. The first PostgreSQL attempt overlapped a lock-unaware
`evidence:expected-red` run from another worktree; a clean retry began after
that process exited but reproduced the same test-9 timeout. The retry was
already substantially degraded before test 9 (tests 7 and 8 took 171 s and
293.9 s). The packet stopped once at that declared gate condition and resumed
only on explicit user direction. The resumed preflight found no test runner or
repository container, 5.8 GiB available memory, load 0.39, and 98.2% CPU idle
over five seconds. The unchanged command then acquired the exclusive lease and
passed 203/203; the previously blocked tests 7, 8, and 9 completed in 76.7 s,
122.8 s, and 147.8 s respectively. No timeout, PostgreSQL code, or out-of-scope
behavior changed between the red and green runs.

Round 9 changes only the architecture control above production byte-identical
to candidate `a58d3e7`:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` before the new control, with only `ts.isSatisfiesExpression` deleted | SURVIVOR CONFIRMED — 35/35; the shared evaluator/range grammar consistently omitted the wrapper |
| focused `module-press-law.test.ts` | PASS — 36/36, including one exact eight-observation fixture spanning all five transparent wrappers and three independent type-literal companions |
| reviewer-selected `ts.isSatisfiesExpression` deletion after the control | EXPECTED RED — only the new wrapper control failed; the other 35 remained green; the inverse patch restored production before the final focused run |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 167/167, including 36/36 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 1,342,849.5 ms |

Architecture queued behind another lane's full matrix and acquired the exclusive
lease only after that holder released. Before PostgreSQL, no test runner or
repository container remained; 5.1 GiB memory was available and the second
five-second CPU sample was 81.6% idle. The three historically timeout-sensitive
tests 7, 8, and 9 passed in 104.3 s, 149.4 s, and 221.7 s respectively. The
discarded mutation replay is corroboration; the committed exact fixture is the
reproducible evidence. No production source or mutation runner changed.

Round 10 corrects the literal-only type-template false green found in the review
of `93a0f37`:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` before the production correction | EXPECTED RED — 36/37; the direct string-literal type reported, the equivalent spliced template-literal type was absent, and the longer contract type admitted |
| focused `module-press-law.test.ts` | PASS — 37/37, including the direct/spliced type refusal pair and longer-contract type admission |
| reviewer-selected type-template construction-branch deletion | EXPECTED RED — only the new control failed; its direct type-literal observation remained and only its spliced observation disappeared; the longer contract type remained admitted; the inverse patch restored production before the final focused run |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 168/168, including 37/37 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 1,338,344.7 ms |

Before both exclusive suites, no competing test runner or repository container
was present. Architecture began with about 5.6 GiB available memory and a
five-second CPU sample at 95–97% idle; it passed in 63,344.9 ms. PostgreSQL began
with about 5.5 GiB available and the same 95–97% idle range. Its historically
long tests 7, 8, and 9 passed in 96.5 s, 146.9 s, and 213.3 s. The discarded
branch deletion is corroboration only; the committed direct/spliced/admission
fixture is the reproducible evidence. No mutation runner is committed.

Round 11 corrects the independent-type-population and unresolved-outer-type
ownership defects found in the review of `0bba843`:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` before the production correction | EXPECTED RED — 38/42; wrapper composition, right-adjacency, left-adjacency, and exact-span controls failed while the independently nested type still reported |
| focused `module-press-law.test.ts` | PASS — 42/42, including independent runtime/type population, bilateral type adjacency, exact primitive/nested spans, head/substitution/tail ownership, and rejected-outer recursion |
| stop type descent beneath runtime construction | EXPECTED RED — 41/42; only the completed-runtime-wrapper composition control failed |
| delete type partial-run collection | EXPECTED RED — 40/42; only the right- and left-adjacency tables failed |
| delete numeric exact-span support | EXPECTED RED — 41/42; only the exact primitive/nested control failed |
| delete rejected-span recursion | EXPECTED RED — 41/42; only the independently nested exact-type control failed |
| delete head, substitution, or tail ownership | EXPECTED RED on each replay — 41/42; each mutation added exactly the raw observation its matching legal-continuation specimen prohibits |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 173/173 in 54,859.4 ms, including 42/42 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 1,061,613.2 ms |

The executable correction is commit
`390ceb5180ba7d251905397c925e2efebeecf9fe`. Architecture queued behind an
existing PostgreSQL holder and its earlier expected-red waiter; PostgreSQL then
queued behind another lane's shared unit/integration work and earlier
Architecture request. Both commands acquired the repository lock normally and
completed green. The discarded mutations are corroboration; the committed
fixtures are the reproducible evidence, every mutation was restored with an
explicit inverse patch, and no mutation runner is committed.

Round 12 corrects the attribution defect and control gaps found in the review
of `76d328d`:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` before the production correction | EXPECTED RED — 43/44; only the multiline attribution control failed because the observation named fixture line 3 rather than the template-type node on line 2 |
| focused `module-press-law.test.ts` | PASS — 44/44, including node-level partial-type attribution, two partial runs in one unresolved type, nested outer composition, and both boolean exact values |
| delete nested exact-template support | EXPECTED RED — only `widget_nested` disappeared from the exact-grammar control; the independently exact inner value `widget_` could not satisfy the outer identity |
| delete `FalseKeyword` exact support | EXPECTED RED — only `widget_flagfalse` disappeared from the exact-grammar control |
| return only the first partial run from an unresolved template type | EXPECTED RED — the plural type-run control retained one observation and lost its required second observation |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 175/175 in 45,278.2 ms, including 44/44 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 917,033.2 ms |

The executable correction is commit
`0d86e0a741a0f70b1f2cd183a1e91ab2ade7c6e4`. Architecture queued behind
another lane's exclusive Architecture holder and acquired the repository lock
after that run completed. PostgreSQL acquired the same exclusive lease after a
short handoff race. Both suites completed green. The discarded mutations are
corroboration; the committed controls are the reproducible evidence, every
mutation was restored with an explicit inverse patch, and no mutation runner is
committed.

Round 13 closes the two control survivors found in the review of `2a8f19e` and
changes no production source:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` | PASS — 45/45; the same unresolved node requires two repeated namespace observations plus distinct `widget_list`, and a direct identity inside an unresolved union remains raw-owned |
| node-index first-value-cache mutation | EXPECTED RED — all three same-node outputs remained, but the required third identity changed from `widget_list` to cached `northstar.widget` |
| whole-node partial-type ownership mutation | EXPECTED RED — the unresolved-union raw observation changed from one exact PRESS006 entry to `[]` |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 176/176 in 43,339.0 ms, including 45/45 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 802,970.9 ms |

The executable correction is test-only commit
`f4680b6363864b82c144d3e312bdfdea188a329e`. Both exclusive suites acquired
the repository lock normally and completed green. Production, including
`module-press-law.ts` and the provider, is byte-identical to candidate
`2a8f19e`. The discarded mutations are corroboration; the committed controls
are the reproducible evidence, both mutations were restored with explicit
inverse patches, and no mutation runner is committed.

The final accepted-scope correction changes one fixture pair and this packet
record; production remains byte-identical to the accepted round-13 candidate:

| Gate | Result |
|---|---|
| focused `module-press-law.test.ts` | PASS — 46/46; the fixed-`:` no-substitution-template construction reports and its unknown-continuation twin admits |
| narrow `ts.isStringLiteralLike` → `ts.isStringLiteral` mutation in `staticallyKnownStringRuns` | EXPECTED RED — 45/46; only the new bounded refusal changed from one exact PRESS006 observation to `[]`; the admission twin and every completed-construction control remained green |
| focused after explicit inverse restoration | PASS — 46/46 |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 177/177 in 42,082.6 ms, including 46/46 module-press-law tests and the unchanged exact eleven-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 838,058.2 ms |

The executable correction is test-and-record commit
`fc07163dc60b9920fead6d856f0b8f9fbc8dc490`. The production blob
`packages/dev-tooling/src/module-press-law.ts` remains
`83f9d84ff08a94c92563311fe8d5157dfd9517e7`; the provider is also unchanged.
The mutation was restored by an explicit inverse patch, the final focused run
passed, and no mutation runner is committed. Three preliminary focused or
mutation attempts honestly returned `TEST_GATE_LOCK_BUSY` behind other lanes'
serialized gates and executed no test; they are not counted as evidence above.

Per `git-workflow`, the full CI matrix runs once only after the Critical review
chain converges; it is not a pre-review freeze gate.

## Review state

No review was run by this lane. The user-run fresh-naive Codex xhigh arm reviewed
remote candidate `318c0dd719a7d759d313ee45ca080017e5e36b44` and returned
**REVISE**. It confirmed that both authored splice specimens reach PRESS006 and
that the live provider literal is honestly visible, then found:

1. a production regression: nested static prefixes, dynamic-outer prefixes, and
   tagged-template bodies were treated as independently completed strings;
2. a control defect: the admission changed both source location and construction
   form, and both refusals sat at line 1; and
3. a claim-prose defect: compiler row `1e-2` was incorrectly named as the known
   retirement path for an ADR-0026-required provider comparison.

The production regression requires continuation under `review-tiers`; this
correction subsumes the recursive traversal with a maximal-construction boundary,
adds the missing same-mechanism admissions and multiline attribution, and narrows
the debt claim. A new SHA requires a fresh online arm. The prior verdict is also
recorded append-only in `review-log.md`.

The fresh review of candidate `4f0d19e475977956f26e3e5238ef90bcc90936a5`
also returned **REVISE**. It verified the round-1 findings closed, then found two
material gate defects:

1. direct and constructed channels were compressed with `??`, so the routed
   line-37 literal masked a later splice of the real provider comparison; and
2. the round-1 early-return correction suppressed whole dynamic and tagged
   subtrees, including independently completed concatenations in call arguments
   and tagged substitutions.

Both are production defects in the gate, and the second is a regression caused
by the prior correction, so `review-tiers` licenses continuation. From round 3,
the convergence criterion is explicit: the occurrence-complete observer, its
semantic-boundary controls, and the exact live-debt ratchet must receive a fresh
full Critical arm with no surviving in-scope production or control defect. Any
code change requires another fresh SHA and arm. Only after that convergence does
the one full matrix run.

The fresh full review of candidate
`358ba5fe7a66d530b1388979953a12bea81e2aae` returned **REVISE** with no
surviving production defect or ADR conflict. It found two Critical control
survivors: the suite admitted first-constructed-only compression because no file
contained two matching constructed values, and it admitted line-number
deduplication because the independent direct/constructed pair used different
lines. Round 4 adds exactly those two reviewer-selected specimens and changes no
production source.

Continuation is licensed as the first control-only round against the round-3
occurrence implementation: the two independently selected vacuity vectors are
new, material, in-scope, and the user returned REVISE with bounded test-only
closures. If another arm finds the same occurrence/deduplication evidence class
outrunning these specimens while production remains unchanged, the packet must
narrow or stop rather than enumerate another adjacent fixture.

Candidate `e02c15c9dc772cb772ceb3c851c606a95eb209c6` then received the required
fresh-naive Codex xhigh arm and returned **PASS**: both round-3 control survivors
were closed, the correction was test-only, and production remained byte-identical
to `358ba5f`. The identical-SHA Fable max confirmation returned **REVISE** on one
new production defect. An incomplete template or concatenation was treated as
wholly opaque even when its static text already contained the full module
identity followed by a fixed boundary character before a runtime tail. The
reviewer's template and `+` probes returned zero violations; the contiguous twin
returned one.

Round 5 continues because this is a production defect, which `review-tiers`
explicitly licenses regardless of round count. The correction is semantic rather
than another adjacent evidence specimen: it models maximal statically known runs
and whether their right boundary is known, preserving the existing admission for
an unbounded prefix before an unknown continuation. Because production changed,
the next arm is fresh Critical review, not a narrow confirmation. The prompt-path
error is also corrected: the ratified ADR-0023 is
`ADR-0023-storageless-platform-capability-tier.md`.

The fresh review of candidate
`d82350103b362ae20448822c122057c53d5ef41e` returned **REVISE** with one
production defect and one control defect. A partial run beginning immediately
after an unknown runtime prefix was matched as a standalone string, inventing a
left `\b` for generated local IDs and `*_IDS` symbols. Separately, no committed
fixture required two reportable partial runs inside one incomplete construction,
so `return runs.slice(0, 1)` preserved every reported gate. Round 6 records both
left and right construction-edge knowledge and carries unknown adjacency into
the existing shared matcher with a conservative word/namespace-continuation
neighbor. It adds the requested local-ID and symbol admission/refusal twins plus
an exact two-partial-run control. No identity-family matcher, module allowlist,
or compiler change is introduced.

Continuation remains licensed because the first finding is a new in-scope
production defect and the second is its bounded evidence companion. Production
changed, so the next review must again be a fresh full Critical arm; nothing from
the prior arm is treated as a narrow confirmation fence.

The fresh review of candidate
`c5fb4e14df0edaabfd26c014e17ffae7934de5fd` returned **REVISE** with one
production defect and its missing control. Although the constructed observer
preserved unknown adjacency, the independently additive raw observer still ran
the shared matcher over the whole source file. A quote around contiguous
`widget_list`, `WIDGET_IDS`, or `northstar.widget` text therefore acted as a
favorable runtime boundary even when an adjacent unknown value could erase or
continue that boundary. Split literal-token equivalents admitted, so source
tokenization changed the verdict without changing runtime semantics.

Round 7 partitions observation by AST construction ownership. Raw matching owns
only occurrences outside ordinary construction literal tokens; all matches
inside those tokens are evaluated by the construction observer with its known or
unknown runtime edges. The paired contiguous/split admissions and static-colon
refusals cover local-ID, symbol, and namespace families. A separate completed
construction control requires every identity in one value, preventing the
ownership change from collapsing to the first match. The continuation criterion
is automatic under `review-tiers`: this is a new in-scope production defect, not
an evidence-only checklist recurrence. Because production changed, the next
review is a fresh full Critical arm.

The fresh review of candidate
`ebbb65ecf8d93e4a3742e1c0eb7c0d2b3e950dc1` returned **REVISE** with one
production false green introduced by the round-7 ownership correction. The
range collector used unrestricted AST descendant traversal, so a type literal
beneath `satisfies` was claimed as though it contributed to the completed
runtime construction. The raw observer then relinquished that direct source
occurrence, while the runtime value contained no identity to replace it.

Round 8 makes range ownership mirror the static evaluator's runtime expression
grammar instead of generic AST membership. Transparent wrappers contribute only
their `.expression`; concatenations contribute their left/right expressions;
templates contribute their runtime segments and substitution expressions. Type
nodes are never traversed as runtime tokens. The one-property empty-concatenation
twin and the stronger runtime/type provenance companion hold both under-routing
and over-retention. Continuation remains licensed because this is a production
regression introduced by the prior correction—an explicit always-continue case
in `review-tiers`. Production changed, so the next review is again a fresh full
Critical arm.

The fresh review of candidate
`a58d3e7356b32d1e9d839fcfbd00318e40d6c94a` returned **REVISE** with no
surviving production defect, ADR conflict, ownership defect, or occurrence
loss. It found one Critical control survivor: the evaluator and range collector
could consistently lose any one transparent wrapper from their shared
`unwrapStaticStringExpression` grammar while the existing final-observation
twins fell back to raw observations and stayed green. Deleting only
`ts.isSatisfiesExpression` preserved focused 35/35 but missed the split runtime
identity in `('northstar' satisfies string) + '.' + 'widget'`.

Round 9 adds the reviewer-selected construction-channel control for all five
transparent wrappers and leaves production byte-identical to `a58d3e7`. The
typed wrappers retain independent type-literal identities so the expected array
also proves those type children remain raw. The exact `satisfies`-predicate
deletion now fails only this control while the preceding 35 stay green.
Continuation is the bounded test-only closure the review prescribed. If a new
arm produces another adjacent wrapper-list specimen without identifying a
production defect or a distinct authority/proxy class, the packet must stop or
narrow its claim rather than enumerate syntax indefinitely.

The fresh review of candidate
`93a0f37715378bf227dcdee17e5558afd1301456` closed the shared-wrapper control,
runtime-expression ownership, occurrence/boundary semantics, provider
comparison, debt, and ADR questions. It returned **REVISE** on one new
production false green: a literal-only TypeScript template-literal type is a
statically exact string construction but parses as `TemplateLiteralTypeNode`,
not a runtime `ts.Expression`, so neither existing observation channel saw a
spliced module identity in type space.

Round 10 adds a narrowly bounded type-template construction observer. It accepts
only string-literal type spans, records only the head/span/tail tokens that
contribute to that type's exact string value, delegates identity classification
to the existing shared matcher, and attributes the observation to the template
type's source position. It performs no alias, generic, identifier, or type-checker
resolution. The direct/spliced/longer-contract fixture and exact branch-deletion
replay hold the one-property defect and admission. Continuation remains licensed
because this is a new in-scope production false green in the gate. Production
changed, so the next review is a fresh full Critical arm; nothing from round 9
is fenced as settled.

The fresh review of candidate
`0bba84397f190ba7c3d8e09022dfa22c006d0ce3` closed the basic standalone
template-type observation and all retained runtime properties, then returned
**REVISE** on two composed type-space production defects and the controls that
missed them. First, the unified visitor returned after a completed runtime
construction and therefore skipped an independently exact template type in an
`as`, angle-bracket, or `satisfies` type child. Second, an unresolved outer
template type retained raw ownership of its head/tail tokens, so source `${`
punctuation invented a favorable boundary for a contiguous spelling while the
split runtime-equivalent spelling admitted. The review also required the bounded
exact grammar and ownership evidence to cover primitive and nested exact spans,
partial-run boundaries, nested recursion, source attribution, and the individual
head/substitution/tail ranges.

Round 11 separates runtime and type-template discovery into independent AST
populations. Exact primitive, parenthesized, and nested spans form one complete
type value; unresolved outer types yield maximal known runs with conservative
unknown adjacency, then retain independently exact nested template types. Both
runtime and type partial runs use the same boundary collector, while their
syntax flatteners remain separate. The five committed controls and targeted
mutation reds hold reachability, adjacency, exact grammar, recursion,
attribution, and range ownership without introducing aliases, generic
resolution, identifier lookup, unions, or checker state. Continuation remains
licensed because both review findings were in-scope production false greens.
Production changed, so the next review is a fresh full Critical arm; nothing
from round 10 is treated as a narrow confirmation boundary.

The fresh review of candidate
`76d328d417201dfd355fb4c0dcbf650a4f3b95f4` closed the independent runtime/type
populations, bilateral type adjacency, provider outcome, shared identity
authority, and ADR/debt questions. It returned **REVISE** on one production
attribution defect and two control gaps. Partial type runs beginning in an exact
substitution or tail used that fragment's token start, so multiline formatting
could report the closing `}` rather than the owning template-type node. The
exact-grammar fixture did not make nested outer composition or `false`
load-bearing, and no one unresolved type required two reportable partial runs.

Round 12 separates attribution provenance from literal-token ownership: every
run carries the containing `TemplateLiteralTypeNode` start, while its head,
substitution, and tail ranges remain unchanged for raw/constructed routing. The
multiline attribution control puts the node, closing interpolation token, and
bounded identity on distinct lines. The exact-grammar control requires the
outer tail to finish `widget_nested` and covers both boolean values, and a
single unresolved type requires two bounded runs. The three selected deletion
replays fail for the named missing observation. Continuation remains licensed
because the first finding is an in-scope production defect and the other two are
its bounded type-channel evidence companions. Production changed, so the next
review is a fresh full Critical arm; nothing from round 11 is treated as a
narrow confirmation boundary.

The fresh review of candidate
`2a8f19e7f1432e941ace733a7d4d68313abbb73b` found no production defect and
closed exact grammar, provider/debt/ADR agreement, and frozen-record integrity.
It returned **REVISE** on two Critical control survivors. The two partial runs
inside one unresolved node had identical identity and diagnostic objects, so a
count-preserving cache could reuse the first classification for every later
run. Separately, no fixture required a raw identity inside an unresolved span
to remain outside the partial construction's contributing-token ownership, so
replacing those ranges with the whole template node stayed green.

Round 13 is the bounded test-only correction prescribed by that review. The
plural fixture now requires both repetition and a distinct later local ID at
the same node and line. The raw-ownership fixture puts a direct identity inside
an unresolved union beside a nonempty partial run. The reviewer-selected cache
and whole-node-range mutations each fail only the intended exact assertion.
Production is byte-identical to `2a8f19e`. The user accepted candidate
`a6b922998c17b6c41d3c3975adf6436025f01add` and ruled round 13 the final broad
round.

The remaining correction is deliberately narrow and test-only. It adds one
fixed-boundary refusal and its unknown-continuation admission twin for untagged
no-substitution template literals inside incomplete `+` constructions. The
single deletion probe removes only that syntax from the partial-run grammar;
the new refusal dies while the completed-construction path stays green. The
packet now states the grammar as a closed positive set and states its safety
property: anything else is appended as dynamic and conservatively padded, so
an unrecognized form creates an unknown boundary rather than a silent absence.
The user-scoped narrow confirmation passed at
`d4d40339df78c82d36bc68da5b3ba65dcf47f815`. It verified that narrowing only
`ts.isStringLiteralLike` to `ts.isStringLiteral` in
`staticallyKnownStringRuns` removes the new bounded refusal while leaving the
completed-construction path green; it also verified that the declared grammar
matches the observer and that unsupported construction children become
conservatively padded unknown boundaries rather than silent absences. The
reviewer independently proved byte identity with:

```bash
git diff --exit-code \
  a6b922998c17b6c41d3c3975adf6436025f01add \
  d4d40339df78c82d36bc68da5b3ba65dcf47f815 \
  -- \
  packages/dev-tooling/src/module-press-law.ts \
  packages/postgres-provider/src/inventory-posting-service.ts
```

That command exited zero with no output; the production blobs remain
`83f9d84ff08a94c92563311fe8d5157dfd9517e7` and
`1e141baa20004141321d4da1a7c95723bddf334c`. Production correctness and rounds
1–13 are settled. The one deferred full matrix now runs on the integration tree
before the required packet-into-main `--no-ff` merge.

## Integration-matrix construction

The packet was merged with current `origin/main` at `4780efc3` to form staged
integration SHA `1ea514f642d672daafc25c577cd4c15664bd5200`, with the reviewed
packet as first parent and current main as second parent. Both reviewed
production blobs remained byte-identical. The first matrix attempt refused at
the performance gate with
`FULL_MATRIX_FAILED rc=1 sha=1ea514f642d672daafc25c577cd4c15664bd5200`:
CPU idle was 67.2%, below the required 90%, so no semantic suite ran. Four
subsequent one-second samples measured 94–95% idle.

The identical-SHA rerun passed the performance gate, then reached Architecture.
It reported the same exact eleven routed violations, but current main's accepted
compiler additions had moved seven existing Inventory observations from lines
`2338`–`2693` to lines `2927`–`3282`. The exact debt ratchet therefore failed on
stale pre-integration coordinates and the runner emitted
`FULL_MATRIX_FAILED rc=1 sha=1ea514f642d672daafc25c577cd4c15664bd5200`.
Only those seven expected line coordinates were refreshed; the focused
module-press-law suite then passed 46/46 against the merged production tree.
Neither the observer nor the provider production blob changed. A new committed
integration SHA is required for the complete matrix rerun.

The checkpoint program-review trigger check is **not due**: this packet is the
bounded correction of finding R5 from the same-day first-office-worker program
review, not a new fan-out, correctness domain, stage gate, or accumulated
cross-packet drift. The tree is also not yet integrated, so a whole-app review
would hit the skill's unstable-tree anti-trigger.

The reusable lesson is recorded here rather than in root `learnings.md`, which is
outside this packet's granted paths: **an AST gate must observe every completed
semantic value named by its claim, partition overlapping observation channels by
semantic ownership, and never let a lexical-source proxy override the channel
that knows runtime construction boundaries.** Source quotes and interpolation
punctuation are not runtime adjacency. For evidence, plural behavior requires
two subjects in the same channel, and provenance requires same-location and
same-runtime-value twins; otherwise first-only, location-coincidence, and
tokenization-sensitive proxies remain green.

A third reusable rule follows from the `ebbb65e` review: **AST ownership must be
derived from semantic child positions, never generic descendant membership.** A
type literal, constraint, or other non-value source descendant can be textually
inside a runtime expression's subtree without contributing a token to its value.
When ownership suppresses another observer, every claimed range needs both an
inside-runtime control and an independent-descendant control.

The round-8 review adds the companion rule: **shared grammar is not proved by
two consumers agreeing.** If evaluator and ownership routing call the same
unwrap helper, they can agree on the same omission. Each explicitly supported
entry needs a construction-channel specimen that raw source cannot satisfy,
with type-child evidence kept orthogonal where the syntax carries both runtime
and type positions.

The round-9 review adds the population rule: **an AST claim cannot use
`ts.Expression` as a proxy for every statically established TypeScript string.**
The supported syntax population must be enumerated explicitly. Runtime string
expressions and literal-only template-literal types are separate node families
with separate ownership grammars, even though both produce an exact string for
the same shared identity matcher. Adding type syntax does not license symbolic
type evaluation: every admitted node must carry its own complete literal value
and value-contributing token ranges.

The round-10 review adds the composition rule: **independent syntax populations
need independent discovery passes, and rejected syntax still owns its known
semantic runs.** An early return that is correct for one completed runtime value
cannot decide whether a type child exists, while falling back to raw source for
an unresolved outer template lets `${` and `}` punctuation masquerade as value
boundaries. Exact literal grammar therefore needs discriminator identities for
its primitive and nested forms, and ownership needs legal continuation controls
for every value-contributing token class rather than one aggregate happy path.

The round-11 review adds the attribution-and-branch rule: **semantic ownership,
token ownership, and diagnostic attribution are separate facts.** Literal-token
ranges may decide which observer owns source text, but every partial value from
one template-literal type still reports at that type node's start. Exact grammar
evidence must also make each claimed arm causally necessary: a nested specimen
must require outer composition, both boolean values need distinct outcomes, and
plurality must be proved inside the specific partial-run channel rather than by
another construction population.

The round-12 review adds the proxy-pair rule: **shared diagnostic provenance
must not stand in for independent classification or semantic ownership.** A
plural control needs at least one later distinct value as well as repetition,
or count-preserving first-value reuse remains invisible. A construction-range
control also needs raw text inside an unresolved semantic child, or the owning
node's full extent can replace its contributing-token ranges without a red.

A second reusable rule follows from the confirmed Fable finding: **partial
evaluation must preserve known semantic boundaries rather than classifying an
entire expression as either static or dynamic.** Unknown values block inference
across their edge; they do not erase independently fixed text and delimiters on
the same side. That rule applies on both sides: an isolated partial run is not a
standalone runtime string, so an unknown neighbor must not be replaced by an
invented start or end boundary. And plural evidence must be channel-specific:
two completed constructions do not prove that two partial runs inside one
incomplete construction are both retained.
