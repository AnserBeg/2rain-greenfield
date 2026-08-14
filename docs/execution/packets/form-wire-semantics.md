# form-wire-semantics — typed values and explicit empty intent on the form wire

Date: 2026-08-14  
Tier: Critical  
Status: evidence_ready  
Base: `5ce4b7b` (rebased from the original `adb5f38` cut after `origin/main`
moved with documentation-only commits)  
Matrix SHA: `1a06b979958a962b6daff85b58969456b8de766b`

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
a default, add script, or change compiler-semantic profile adoption.

## What changed

- `surface-contract.ts` carries the field id, kind and requiredness from the
  already-pinned operation input contract into the selected web binding.
- `component-registry.ts` renders the native optional-field companion without
  inventing a field value.
- `surface-runtime.ts` normalises the string carrier once, before building the
  immutable provider input. A malformed field refuses the whole submission
  before the gateway can be called.
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
| An unrelated edit cannot rewrite null or absence | `an unrelated edit preserves both stored null and absent optional values` rereads both states after a different text field changes. |
| Clear and real empty text remain distinct | `blank plus explicit clear sends null while blank text can remain a real value` rereads `null` and `""` from one accepted update. |
| Optional boolean state is not defaulted | `an optional boolean renders and submits three states, with absent and null identical` observes the raw value, its empty intent, and stored value for absent, null, false and true, plus true-to-false. |
| Malformed input refuses atomically | `malformed boolean and empty intent are refused beside admitted twins` mutates one rendered property at a time: malformed boolean, unknown intent, missing companion and entire optional subject absent each return 422 before the provider verdict count changes; valid boolean and `nothing` twins are admitted. The pre-existing stored name stays unchanged. |
| The double cannot manufacture success | `a provider refusal cannot be manufactured into browser success` omits one required value from an otherwise rendered create, observes `MODULE_REQUIRED_FIELD_MISSING`, HTTP 422, no success status and no record; the neighbouring complete creates observe accepted provider verdicts and persisted records. |

The focused browser file is 18/18 green. The matrix executes the same file and
the composed-application bridges in its 79/79 browser result.

## Negative-control replay

The committed controls above are the evidence. The writer also ran eight
author-chosen, ad-hoc mutation replays as supplementary causal checks; all were
restored before the matrix and are not counted as committed evidence.

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

Each replay changed one relevant property and was required to fail for the
intended reason. Because the writer chose them, the independent Critical arms
must still challenge the controls rather than inherit this table.

## Gates

Focused development gates:

- `pnpm typecheck` — green.
- `pnpm test:integration` — 137/137 green.
- `pnpm exec playwright test --config apps/web/playwright.config.ts
  apps/web/test/browser/surface-data-binding.spec.ts --reporter=list` — 18/18
  green.
- focused composed-application Party and light/dark focus-ring replay — 3/3
  green, including 120/120 painted ring measurements in each scheme.

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

The best available under-ten-minute payoff check is therefore the real browser
form fixture:

```bash
cd /home/rvham/2rain-greenfield-formwire
pnpm exec playwright test --config apps/web/playwright.config.ts \
  apps/web/test/browser/surface-data-binding.spec.ts \
  --grep "a create sets a boolean and omits a blank optional date" \
  --reporter=list
```

Expected: `1 passed`. The test fills both required text fields, chooses Yes,
leaves Due blank with `No value`, presses Save, observes `Create complete`, an
accepted real provider-parser verdict, native `true` in the stored record and
no stored Due key. It proves the generic form wire; it does **not** prove a
seeded purchase-order or composed-product journey.

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
  The separately required `test:postgres` suite is green, but it does not turn
  that browser test into such a journey.
- The eight mutation replays were selected and interpreted by this writer.
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

No independent arm has reviewed this candidate yet. Critical cadence requires
a fresh naive Codex xhigh arm followed, after any correction and a fresh freeze,
by an independent Fable max arm on the identical SHA. Any executable change
invalidates the matrix and prior review evidence.
