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
then a Fable REVISE on a newly found production false green. The round-5
production correction has all declared pre-review gates green for a fresh
Critical arm; the full matrix remains deferred until review converges

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
guard parses production source and evaluates string literals,
parentheses/type wrappers, template expressions, and `+` expressions. It
observes a completed construction as one value. Inside an otherwise dynamic
ordinary construction it also observes maximal statically known runs when the
identity's right boundary is fixed by static text or by the end of the
construction; a match ending immediately before an unknown runtime continuation
is not inferred. Every observed value is checked by the same
`moduleIdentityMatches` authority as a contiguous spelling. The guard therefore
reports `PRESS006`, rather than introducing a parallel rule or an allowlist.

The observer measures each completed ordinary construction once. Direct source
matches and independently completed constructed matches are additive, so an
already-routed literal cannot mask a later splice in the same file. A direct
match inside the literal token of the same static construction is deduplicated;
unrelated occurrences are not. This occurrence-complete rule exposes every
existing compiler contract literal under row `1e-2`, rather than only its first
occurrence.

Within an incomplete ordinary template or `+` construction, direct construction
operands remain incomplete values. Their statically known runs are considered
only when the identity and its right boundary are both fixed; an unbounded
`northstar.widget` prefix before a runtime suffix remains admitted. Traversal
also continues through non-construction semantic boundaries, so a complete
concatenation passed to a call is still observed. A tagged template's aggregate
result is not inferred, but each substitution expression is evaluated before
the tag receives it and is therefore visited. These boundaries avoid the three
failures found by review: round 1 recursed through every AST child and falsely
treated nested prefixes as values; round 2 returned beneath whole subtrees and
missed independently completed call arguments and tagged substitutions; the
round-4 Fable confirmation found that treating every incomplete construction as
opaque also missed an identity followed by a statically fixed `:` before a
runtime tail.

This remains deliberately narrower than symbolic execution. Unknown runtime
values and identifier indirection are not resolved, and a tag's return value is
not inferred. Static text on either side of those unknown values is still
observed when it independently fixes the identity boundary. That is an explicit
limit: the current threat is an honest developer or AI writer reaching for the
cheap literal-interpolation or literal-concatenation dodge, not active
obfuscation.
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
| same-construction deduplication | one concatenation whose literal token already contains `northstar.widget` | one observation, not one per observer |
| same-line independence | an unrelated direct identity and spliced identity occur on the same file/module/line | two observations; line-number coincidence is not construction provenance |
| provider mutation | retain the honest line-37 Inventory literal and splice the real `validateRegistration` comparison | Inventory PRESS006 contains both line 37 and the later comparison line; the routed literal cannot mask the reintroduced defect |
| constructed admission | concatenated and interpolated `northstar.widget-contract/v1` values in generic production source | zero violations; the completed legal values are measured without refusing nested prefixes |
| dynamic-boundary admission | static `northstar.widget` prefix plus an identifier-held legal suffix | zero violations; an unevaluable outer value is not partially observed |
| dynamic-boundary refusal | interpolation and concatenation fix `northstar.widget:` before an identifier-held tail, and a second interpolation ends with a spliced `northstar.widget` after an unknown prefix | three exact violations; a dynamic outer construction cannot hide an identity whose right boundary is fixed by static text or construction end |
| dynamic-tail admission | the same interpolated and concatenated static prefixes end immediately before an identifier-held suffix | zero violations; the observer does not invent a right boundary before an unknown continuation |
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

The checkpoint program-review trigger check is **not due**: this packet is the
bounded correction of finding R5 from the same-day first-office-worker program
review, not a new fan-out, correctness domain, stage gate, or accumulated
cross-packet drift. The tree is also not yet integrated, so a whole-app review
would hit the skill's unstable-tree anti-trigger.

The reusable lesson is recorded here rather than in root `learnings.md`, which is
outside this packet's granted paths: **an AST gate must observe every completed
semantic value named by its claim, compose independent observation channels
additively, and deduplicate only when two channels describe the same construction.**
For evidence, plural behavior requires two subjects in the same channel, and
provenance deduplication requires a same-location unrelated twin; otherwise
first-only and location-coincidence proxies remain green.

A second reusable rule follows from the confirmed Fable finding: **partial
evaluation must preserve known semantic boundaries rather than classifying an
entire expression as either static or dynamic.** Unknown values block inference
across their edge; they do not erase independently fixed text and delimiters on
the same side.
