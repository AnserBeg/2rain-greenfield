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
observer. The round-10 production correction adds that bounded type-space form
and is gate-green for a fresh Critical arm; the full matrix remains deferred
until review converges.

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

Yes, for statically observable JavaScript/TypeScript string constructions. The
guard parses production source and evaluates runtime string literals,
parentheses/type wrappers, template expressions, and `+` expressions. It also
evaluates TypeScript `TemplateLiteralTypeNode` values when every span is itself
a string-literal type. It observes a completed construction as one value. Inside
an otherwise dynamic ordinary runtime construction it also observes maximal
statically known runs while preserving whether either adjacent construction
edge borders an unknown runtime value. Unknown adjacency is conservatively
represented by a character that is both a word character and a
namespace-continuation character before calling the same
`moduleIdentityMatches` authority as a contiguous spelling. Thus the matcher
may report only when static text or the real construction edge proves the
boundaries its identity family requires; it never invents a string boundary at
the edge of an isolated run. The guard therefore reports `PRESS006`, rather
than introducing a parallel rule or an allowlist.

The observer measures each completed ordinary runtime construction once, every
bounded partial run inside an incomplete runtime construction, and each
literal-only template-literal type once. Raw and constructed observation are
disjoint by AST ownership: raw matching owns source occurrences outside static
construction literal tokens, while the construction observer owns matches
inside those tokens and judges them with the construction's semantic value and
adjacency. Runtime ownership follows only the same runtime expression positions
the static evaluator understands: wrapper expressions, `+` operands, and
template segments/substitutions. Type children of `as`, angle-bracket
assertions, and `satisfies` remain raw source occurrences because they do not
contribute tokens to the runtime string. Literal-only template-literal types are
a separate completed static value: ownership includes their head/tail tokens
and string-literal type spans, but does not resolve aliases, generics,
identifiers, or type-checker state. This prevents quotes, backticks,
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
values, runtime identifier indirection, nonliteral type-template spans, type
aliases, generic type parameters, and identifier-held types are not resolved;
the TypeScript type checker is not consulted; and a tag's return value is not
inferred. Static runtime text on either side of unknown runtime values is still
observed when it independently fixes the identity boundary. That is an explicit
limit: the current threat is an honest developer or AI writer reaching for the
cheap literal-interpolation or literal-concatenation dodge in ordinary runtime
or literal-only type syntax, not active obfuscation.
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
| completed-continuation admission | contiguous `widget_list`, `WIDGET_IDS`, and `northstar.widget` literal tokens continue statically inside completed concatenations | zero violations; token quotes cannot override the completed runtime value's boundaries |
| contiguous/split unknown-adjacency admission | local ID, symbol, and namespace families are each written once in one literal token and once across literal tokens beside an unknown runtime value | all six admit; tokenization does not change the runtime-adjacency ruling |
| contiguous/split static-boundary refusal | the same six forms receive a static `:` at the relevant edge | six exact observations at their construction lines; the construction observer retains fixed boundaries for both tokenizations |
| type-literal ownership twin | one direct `satisfies` type literal is repeated beneath an empty runtime concatenation | both direct source occurrences report; adding a semantically neutral construction cannot transfer the type token to runtime ownership |
| runtime/type provenance companion | one completed construction contains a runtime module identity and an independent module identity in its `satisfies` type | two observations at their distinct runtime-construction and raw type-literal lines |
| transparent-wrapper grammar | the runtime namespace is split across a parenthesized, `as`, angle-bracket-asserted, `satisfies`, or non-null operand; the three typed forms also contain an independent type-literal identity | eight exact observations: one construction-derived result for every wrapper plus one raw type-literal result for each typed wrapper; deleting any shared unwrap predicate loses its construction observation |
| literal-only template type | a direct string-literal type, an equivalent spliced `TemplateLiteralTypeNode`, and a spliced longer contract type share one generic production fixture | the direct and spliced module identities each report at their own source line; the longer contract type admits; deleting the type-template construction branch loses only the spliced observation |
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

A second reusable rule follows from the confirmed Fable finding: **partial
evaluation must preserve known semantic boundaries rather than classifying an
entire expression as either static or dynamic.** Unknown values block inference
across their edge; they do not erase independently fixed text and delimiters on
the same side. That rule applies on both sides: an isolated partial run is not a
standalone runtime string, so an unknown neighbor must not be replaced by an
invented start or end boundary. And plural evidence must be channel-specific:
two completed constructions do not prove that two partial runs inside one
incomplete construction are both retained.
