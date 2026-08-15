# form-wire-semantics — typed values and explicit empty intent on the form wire

Date: 2026-08-14

Tier: Critical

Status: evidence_ready

Base: `bc28c2f92571a2036229816b7247fd52f8c230d0` (the round-3 branch merged
current `origin/main`; the original cut was `adb5f38`)

Round-3 tested executable SHA: `43a4b0b8eed84defb44812c156e91418e29a71e5`

No round-3 full matrix has run. Current `git-workflow` requires review to
converge first, then one matrix at the SHA that will integrate. The round-1 and
round-2 matrices below are historical evidence for their respective candidates,
not acceptance evidence for round 3.

## Goal

Make the generic server-rendered form path capable of submitting native
booleans and of distinguishing these three meanings for a blank optional
control:

- state no value on create / leave the stored value alone on update;
- clear an optional stored value;
- store the real empty string for a text field.

The failure mode is silently wrong stored data, so this is Critical even though
the implementation is concentrated at one web-runtime seam.

## Ruling

[ADR-0053](../../decisions/ADR-0053-form-submissions-carry-validated-strings-and-explicit-empty-intent.md)
rules both questions the charter delegated to this packet:

1. The raw `application/x-www-form-urlencoded` carrier remains
   `Readonly<Record<string, string>>`. Typed JSON is not representable on that
   carrier. The selected operation's already-pinned input contract is the one
   authority at the normalisation seam; exact boolean strings become native
   booleans there.
2. A blank optional control has a native companion `<select>` carrying the
   closed `nothing | clear | emptyText` vocabulary. Before the provider input
   object is built, `set | clear | nothing` is a discriminated union, so the
   three meanings cannot be represented as one another internally.

Untrusted HTTP bytes cannot be made unrepresentable. Unknown boolean or empty
intent spellings, a missing companion, and an optional field omitted in its
entirety are detected and refused as `OPERATION_INPUT_INVALID` before semantic
invocation. Required non-text blanks are also refused. Required text and the
explicit `emptyText` intent preserve `""` as a real value.

The renderer uses only native server-rendered controls. It does not materialise
a default, add script, or change compiler-semantic profile adoption. A stored
value that the live control cannot faithfully round-trip is shown truthfully
beside a blank primary control and resolves to `nothing`, never `clear`;
clearing remains an explicit operator choice for an optional field. The
selected operation contract makes that classification available even when
profile v1 omits typed surface metadata. Profile-v1 bare inputs are one-line
controls, not lossless carriers: line-bearing text and incompatible historical
runtime types use the same preservation path as profile-v2 typed controls.

## What changed

- `surface-contract.ts` carries the field id, kind and requiredness from the
  already-pinned operation input contract into the selected web binding.
- `component-registry.ts` renders the native optional-field companion without
  inventing a field value. Update forms default every non-empty optional value
  to `nothing`; every control that cannot faithfully round-trip a stored value
  renders blank plus the exact stored JSON value as visible server-side
  context. The fallback profile-v1 input is classified from the selected
  operation field kind, including the one-line text boundary.
- `surface-runtime.ts` normalises the string carrier once, before building the
  immutable provider input. An unavailable required update carries the same
  `nothing` intent and omits its patch key; a non-empty replacement still wins
  as `set`. A malformed field refuses the whole submission before the gateway
  can be called.
- `message-catalog.ts` registers the page diagnostic
  `OPERATION_INPUT_INVALID`.
- `BrowserFixtureExecutor` now persists only the result returned by the real
  `parseMutationInput`. It has no mode that records a provider refusal and then
  reports browser success.
- The two `KNOWN_FALSE_GREEN` creates were converted rather than deleted. The
  fixture now renders and submits the required `master_number`, and both
  assertions observe an accepted provider verdict beside the rendered success.

The prompt's count was one claim corrected by re-reading the tree: the current
canonical vocabulary has ten field kinds, not nine — boolean plus nine
string-validated kinds.

## Bridges used

The charter pre-authorised test and fixture changes whose meaning stayed the
same. This packet used that bridge for:

- `apps/web/test/browser/{catalog-runtime,party-runtime}.spec.ts`: exact label
  selection after the optional-field companion introduced a second related
  label;
- `apps/web/test/browser/message-catalog.spec.ts` and
  `apps/web/test/surface-runtime-contract.test.ts`: register and count the new
  diagnostic;
- `apps/web/test/browser/composed-application.spec.ts`: exact Party label
  selection and removal of `.form-fields select:focus-visible` from the pinned
  known-absence set once this packet made a real subject reachable;
- `test/integration/surface-data-binding.test.ts`: propagate the additive
  selected-operation binding shape.

No bridge into `packages/runtime`, `packages/compiler`, architecture boundaries,
or provider production source was used. `app-server.ts` and
`module-runtime-interpreter.ts` were inspected and left unchanged.

## Committed evidence

The browser tests drive the real request reader, renderer, submission runtime,
semantic gateway, real `parseMutationInput`, and an observable persisted
read-back in the fixture executor.

| Claim under test | Committed observation |
|---|---|
| String wire becomes a provider-acceptable native boolean | `the string wire is normalised before the real provider parser admits it` observes raw `"true"`, an accepted provider verdict, stored native `true`, and an omitted blank optional quantity. |
| The user's create payoff works | `a create sets a boolean and omits a blank optional date` fills required values, chooses Yes, leaves the optional date blank, observes provider acceptance, rereads native `true`, and proves the date key is absent. |
| The adopted profile-v1 seam works without typed surface metadata | `the adopted profile-v1 bare form converts a boolean and omits a blank date` observes text inputs for both fields, a working `empty:` companion, raw `"true"`, provider acceptance, stored native `true`, and no date key. |
| A one-line control cannot sanitize stored text during an unrelated edit | The two profile-parametrized `multiline text survives an unrelated edit` cases observe profile-v1 and profile-v2 live controls. Each preserves line-bearing optional and required text plus a non-string historical text value through exactly one accepted parser verdict and persisted unrelated change. The same strings with the newline replaced by a space, and with the number represented as a string, are admitted neighbours that remain visible and round-trip. |
| An unrelated edit cannot rewrite null or absence | `an unrelated edit preserves both stored null and absent optional values` rereads both states and the exact changed text value after the accepted update. |
| A typed control cannot destroy a value it cannot display | `typed controls preserve and disclose every stored value they cannot display` seeds a retired short-enum option plus unavailable boolean, date, time and number values; observes five blank live controls, five exact stored-value disclosures, five `nothing` intents, provider acceptance, the unrelated text change and all five original stored values. |
| Clear and real empty text remain distinct | `blank plus explicit clear sends null while blank text can remain a real value` rereads `null` and `""` from one accepted update. |
| Optional boolean state is not defaulted | `an optional boolean renders and submits three states, with absent and null identical` observes the raw value, its empty intent, and stored value for absent, null, false and true, plus true-to-false. |
| Malformed input refuses before provider invocation | `malformed boolean and empty intent are refused beside admitted twins` mutates one rendered property at a time: malformed boolean, unknown intent, missing companion and entire optional subject absent each return 422 before the provider verdict count changes; valid boolean and `nothing` twins are admitted. The fixture starts with no values, so this control does not claim preservation of a pre-existing name. |
| The double cannot manufacture success | `a provider refusal cannot be manufactured into browser success` omits one required value from an otherwise rendered create, observes `MODULE_REQUIRED_FIELD_MISSING`, HTTP 422, no success status and no record; the neighbouring complete creates observe accepted provider verdicts and persisted records. |

The round-3 focused browser file is 22/22 green, and the complete browser suite
is 83/83 green at the tested executable SHA.

## Negative-control replay

The committed controls above are the evidence. The writer also ran fifteen
author-chosen, ad-hoc mutation replays as supplementary causal checks; all were
restored before the round-3 freeze gates and are not counted as committed
evidence.

| One-property mutation | Causal red |
|---|---|
| Return raw `"true"` instead of native `true` | provider rejects the boolean in both create and update payoff tests |
| Materialise `nothing` as `null` | create omission and unrelated-edit preservation fail |
| Materialise `clear` as `""` | explicit clear is refused instead of persisting null |
| Remove the guard for an entirely absent optional field | the committed absent-subject refusal returns 200 instead of 422 |
| Swallow the provider parser's throw and fabricate parsed input | the committed double-refusal control reports 200 instead of 422 |
| Repair the missing required number before measuring it | the same refusal control reports 200, covering repair-before-measurement |
| Stop recording an accepted provider verdict / change its stage to an unrecognised shape | the exact acceptance observation reds on zero input / wrong shape |
| Remove the required-number field from the compiled fixture | both converted creates red while waiting for the missing control, covering subject absence |
| Restore `clear` as the default for a non-empty stored value | the unavailable-value control reds on the first companion's observed `clear` before submission |
| Classify every typed stored value as displayable | the unavailable-value control reds because the exact stored-value disclosure and its accessible association are absent |
| Pass raw `"true"` through the adopted v1 seam | the v1 control observes `MODULE_FIELD_VALUE_INVALID` instead of its exact accepted provider verdict |
| Treat every profile-v1 input as lossless | the v1 multiline specimen observes the browser-stripped live value instead of the deliberate blank and disclosure |
| Drop the runtime-type arm of the one-line predicate | the historical-number specimen observes live string `"17"` instead of the deliberate blank and disclosure |
| Omit the required-field `nothing` marker | the required multiline specimen observes that its `empty:` carrier is absent |
| Classify every one-line text value as unavailable | the space-for-newline and string `"17"` admission neighbours render blank instead of remaining live values |

Each replay changed one relevant property and was required to fail for the
intended reason. Because the writer chose them, the independent Critical arms
must still challenge the controls rather than inherit this table.

## Round-1 review adjudication

The fresh-naive Codex xhigh arm reviewed
`292934ba813e39c907fef1c2e78ee4a726d8e80c` and returned `REVISE`. The
orchestrator upheld all three findings:

1. **Production, widened:** a short enum whose historical value is absent from
   current options was one member of a larger class. Profile-v2 boolean, date,
   time and number controls can also sanitize a stored value to blank while the
   companion's old default selected `clear`, so an unrelated Save emitted
   `null`. Round 2 changes the default semantics for the whole optional-field
   class and discloses every unavailable stored value; it does not special-case
   enums.
2. **Control:** all typed-value payoffs compiled under unadopted profile v2, so
   none observed the adopted v1 combination of bare text controls with pinned
   operation input fields. Round 2 adds that exact browser-to-parser-to-persisted
   control.
3. **Control/prose:** the unrelated-edit control did not assert that its text
   edit persisted, and this record claimed a stored name survived malformed
   submissions although that fixture seeded no name. Round 2 adds the persisted
   text assertion and narrows the malformed-input claim to its observation.

The required-number fixture repair, the refusal-honouring double, the two test
bridges, the internal unrepresentability ruling and removal of the old stand-in
were all upheld and were not reopened.

## Round-2 review adjudication

The fresh-naive Codex xhigh arm reviewed
`5c85b29e165fcde8f4382ef150d47173a819269a` and returned `REVISE`. The
orchestrator upheld one Critical production finding in the same unavailable
stored-value class:

- Both profile-v1 bare inputs and profile-v2 `textFieldType` controls are
  one-line native inputs. The provider admits text containing CR or LF, but the
  browser strips those characters from the live input value. Because a
  non-empty primary value takes precedence over `nothing`, an unrelated Save
  rewrote valid stored multiline text. A historical non-string text value could
  likewise be stringified and accepted as a different value. Round 3 moves the
  preservation predicate to the selected operation-contract boundary, renders
  those values blank with exact disclosure under both profiles, and proves the
  original value plus the unrelated edit by persisted reread.

The correction also makes the prior prose's required-field assumption true by
construction. Required empty text is normally a real value, so disclosure alone
would have rewritten an unavailable required value to `""`; an update now emits
a hidden `nothing` marker for that precise state. The marker cannot express
clear, cannot weaken required create input, and a non-empty replacement still
wins as `set`.

This round is licensed after round two because the finding is a production
corruption path and the correction subsumes the prior kind list with a
control-boundary fidelity predicate. It is not another enum or text special
case. The reviewer found the v1 boolean/date seam, explicit clear, empty text,
other unavailable typed values, malformed-input refusals and the executor's
provider-refusal behavior sound; those controls remain committed and were not
rewritten.

## Gates

Round-3 review-freeze gates at
`43a4b0b8eed84defb44812c156e91418e29a71e5`:

- `pnpm format` — green.
- `pnpm lint` — green.
- `pnpm typecheck` — green.
- `pnpm test:browser` — 83/83 green.
- `pnpm test:integration` — 137/137 green.
- `pnpm exec playwright test --config apps/web/playwright.config.ts
  apps/web/test/browser/surface-data-binding.spec.ts --reporter=list` — 22/22
  green.
- focused composed-application Party and light/dark focus-ring replay — 3/3
  green, including 120/120 painted ring measurements in each scheme.

Per the current `git-workflow` sequence, the full matrix runs once only after
the Critical review arms converge, at the SHA that will integrate. It has
therefore deliberately not been run for round 3.

### Historical round-1 and round-2 matrices

The first frozen matrix at
`947c766e9a2b8cbfb8a2367caf8ce2662f43ec8d` was honestly red:
`FULL_MATRIX_FAILED rc=1`, browser 76/79. The new companion label made one
broad Party locator ambiguous, and the focus-ring gate still classified the
now-reachable form select as a known absence. Both were pre-authorised test
bridges; neither changed the asserted product meaning.

The required fresh matrix then ran from a clean tree with HEAD pinned before
and after to `1a06b979958a962b6daff85b58969456b8de766b`:

```text
PERFORMANCE_GATE_PASS_SHA=1a06b979958a962b6daff85b58969456b8de766b
compile-budget: best-of-5 cpu_ms=2075.2, budget_ms=5000, cpu_idle_pct=98.3
test:postgres: 197/197 pass
test:browser: 79/79 pass
reachability: PASS (104/104 test files; 10 producer artifacts)
security scans: PASS
FULL_MATRIX_PASS_SHA=1a06b979958a962b6daff85b58969456b8de766b
```

The `TEST_GATE_LOCK_BUSY` strings inside that log belong to the architecture
suite's successful bounded-deadline negative controls; the actual matrix
acquired and released its `form-wire-semantics` slot normally.

### Round-2 matrix

Round 2 first reached two honest environmental refusals at the unchanged SHA.
The first acquisition stopped before any gate because the preceding
`profile-v2-adoption` matrix had left its timed-out Catalog fixture container
and owner process alive. The exact ephemeral container named by the guard was
inspected and removed, and the bounded owner process was allowed to exit. The
next attempt reached the performance gate but returned
`COMPILE_BUDGET_INDETERMINATE`: another lane had begun a direct browser rerun
outside the repository lock, and observed CPU idle was 80.8%, below the 90%
floor. The gate instructed an exclusive rerun. After that browser process
exited, fresh CPU samples read 95--99% idle.

The full rerun started and ended with HEAD pinned to
`587aefefba2d5a7f23fcd2067841fd80afb1262b` and passed:

```text
PERFORMANCE_GATE_PASS_SHA=587aefefba2d5a7f23fcd2067841fd80afb1262b
compile-budget: best-of-5 cpu_ms=3031.3, budget_ms=5000, cpu_idle_pct=95.8
test:postgres: 197/197 pass
test:browser: 81/81 pass
reachability: PASS (104/104 test files; 10 producer artifacts)
security scans: PASS
FULL_MATRIX_PASS_SHA=587aefefba2d5a7f23fcd2067841fd80afb1262b
```

The charter asked for `MATRIX_EXIT` from inside the log. The current
`scripts/run-matrix.sh` does not emit that token anywhere; `rg MATRIX_EXIT` over
the script and log returned zero. It appends repeated attempts for one SHA, so
the same log honestly contains the earlier `PERFORMANCE_GATE_FAILED` followed
by the later pass. The authoritative final markers are the pinned
`PERFORMANCE_GATE_PASS_SHA` and `FULL_MATRIX_PASS_SHA` above, and the matrix
process itself exited 0. This instrumentation mismatch is appended to the
existing `matrix-evidence-truncated` queue row rather than fixed in this packet.

While that run was in flight, `origin/main` advanced from `5ce4b7b` to
`23e7ba3` through two more documentation/doctrine commits. The unpublished and
unreviewed packet branch was rebased as `git-workflow` requires. The executable
diff from matrix SHA `1a06b979958a962b6daff85b58969456b8de766b` to the rebased
candidate is empty under the repository's narrative-path exclusion
(`docs/**`, `.agents/**`, `AGENTS.md`, `CLAUDE.md`, `learnings.md`). The matrix
therefore observes the same executable bytes now proposed for review; the
changed doctrine was re-read before this record and the review prompt were
finished.

The checkpoint-only `bash scripts/check-parked-work.sh` governance check was
run again after the round-3 current-main merge. It returns `parked-work: FAIL`
on six pre-existing
stale branches: `packet/proj-disc`, `packet/ps-0`, `packet/ps-1`, `packet/ps-2`,
`packet/pur-1` and `packet/u5-design` (6–8 days old and 244–327 commits behind).
This packet is current at zero behind. The stale branches need an orchestrator
decision to integrate, rescue or delete; this writer did not mutate another
packet's refs to make the checkpoint report green.

## Test it yourself

There is no honest composed-application click path that demonstrates both
halves. Inspection of `apps/web/release/app.compiled.json` found:

- **Legal entity form** carries the release's boolean field
  `legal_entity_is_default`, but no optional non-text field;
- **Stock count form** carries optional date-time
  `stock_count_recorded_at`, but no boolean field;
- no purchase-order surface exists in the compiled release.

The distributor dev profile was started and seeded 176 records at
`http://127.0.0.1:4174`. **Inventory → Legal entity → DEFAULT** reaches the
seeded legal-entity detail. The direct Legal entity and Stock count form
surfaces then stop at the already-routed `record:activity`
`UNSUPPORTED_COMPONENT` anatomy gap before their form sections render; the
lists expose no usable Edit/New path. That limitation belongs to the existing
G2-P5d-c remaining-anatomy row and was not widened into this packet.

The best available under-ten-minute round-3 check is therefore the real browser
form fixture, exercising the unavailable one-line text preservation path under
both the adopted v1 seam and explicit profile v2:

```bash
cd /home/rvham/2rain-greenfield-formwire
pnpm exec playwright test --config apps/web/playwright.config.ts \
  apps/web/test/browser/surface-data-binding.spec.ts \
  --grep "multiline text survives an unrelated edit" \
  --reporter=list
```

Expected: `2 passed`. Each profile seeds optional and required multiline text
plus a historical non-string text value, observes the browser-facing blank and
exact disclosure, edits a different field, observes provider acceptance, and
rereads the original values byte-for-byte. Each also exercises its one-line
admission neighbours. These prove the generic form preservation path; they do
**not** prove a seeded purchase-order or composed-product journey.

For visual inspection of the current product shell:

```bash
cd /home/rvham/2rain-greenfield-formwire
pnpm dev
```

Open `http://127.0.0.1:4174`, expand **Inventory**, choose **Legal entity**, and
open the one **DEFAULT** row. `pnpm --filter @north-star/api dev:stop` stops the
database container but leaves the Node server listening on 4174; end that
server with Ctrl-C in its terminal or `fuser -k 4174/tcp`.

## What this packet did not verify

- No seeded purchase-order or other composed surface combines a boolean with
  an optional non-text field, so the exact office-worker journey is not a
  product-runtime observation.
- The composed release's form anatomy does not currently reach its form
  sections. This packet did not take G2-P5d-c's anatomy scope.
- The browser payoff persists through an in-memory executor that runs the real
  provider input parser; it is not a browser-to-PostgreSQL persistence journey.
  The historical round-2 `test:postgres` suite is green, but no round-3
  PostgreSQL suite was part of this packet's prescribed blast radius, and
  neither fact turns the browser test into such a journey.
- The fifteen mutation replays were selected and interpreted by this writer.
- No usability study assessed the companion-select wording or whether office
  workers understand the three choices. Automated browser coverage establishes
  native operability, labelling and focus treatment only.
- No relation wire, renderer, picker, `EntityRelationAuthority`, or relation
  submission path changed. A purchase order still cannot select its required
  supplier until the relation packets land.
- Compiler-semantic profile v2 remains unadopted; no compiler output or release
  root was changed by this packet.
- The wider sweep for in-memory executors that over-admit remains open under
  `double-must-honour-refusal`.
- The fixture was repaired to render its required Master Number, but production
  has no general proof that every required create field is renderable. That is
  filed as `form-required-field-not-rendered`.

## Packet boundaries and stops

No new-scope stop occurred. The packet used only its owned paths and the named
test/fixture bridges. It did not use the provider, runtime-package,
architecture-boundary, relation, compiler or profile-adoption bridges.

## Program-review trigger evaluation

No program review is due at this checkpoint. This is a local correction to an
existing web-to-provider seam, not a first vertical slice before fan-out, a new
stabilised correctness domain, a stage boundary or the first zero-dev-code
module. The branch is also evidence-ready rather than accepted and integrated,
which is an explicit anti-trigger. The next checkpoint must evaluate the
triggers again after acceptance/integration.

## Review state

Round 1's fresh-naive Codex xhigh arm returned `REVISE` on
`292934ba813e39c907fef1c2e78ee4a726d8e80c`. Round 2's fresh-naive Codex xhigh
arm returned `REVISE` on `5c85b29e165fcde8f4382ef150d47173a819269a`.
Their upheld findings and corrections are recorded above. No independent arm
has reviewed round 3. Critical cadence requires a new fresh-naive Codex xhigh
arm on the final frozen SHA, followed only after a Codex pass by an independent
Fable max arm on the identical SHA. The full matrix follows convergence at the
SHA that will integrate. This lane writes the round-3 prompt and stops; it does
not run its own review or the pre-convergence matrix. Any executable change
invalidates prior review evidence and requires a new SHA.
