# press-law-splice — make PRESS006 observe the identity it claims to govern

Date: 2026-08-20
Base: `8136cfaa8caf23a73221cfa2b0feb5c90987556b` (`origin/main`, fetched and
verified before cut)
Branch: `packet/press-law-splice`
Tier: Critical — the diff changes what an architecture gate proves
Status: active; first candidate `318c0dd719a7d759d313ee45ca080017e5e36b44`
returned REVISE from the user-run online review; the bounded correction has all
declared cheap gates and blast-radius suites green and awaits a fresh online arm;
the full matrix remains deferred until review converges

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

Yes, for statically evaluable JavaScript/TypeScript string constructions. The
guard now parses production source and evaluates only string literals,
parentheses/type wrappers, template expressions whose substitutions are static,
and `+` expressions whose operands are static. The resulting value is checked by
the same `moduleIdentityMatch` authority as a contiguous spelling. The guard
therefore reports `PRESS006`, rather than introducing a parallel rule or an
allowlist.

The observer measures each **maximal ordinary construction** once. It does not
recurse into nested `+` prefixes, does not partially evaluate a static prefix
beneath a dynamic outer construction, and does not interpret a tagged-template
body as the tag's runtime result. Those are semantic boundaries, not exemptions:
the first reviewed candidate recursed through every AST child and falsely
refused legal `northstar.widget-contract/v1` concatenation because an internal
parse node happened to equal `northstar.widget`.

This remains deliberately narrower than symbolic execution. An identity
assembled through runtime values or identifier indirection is not resolved, and
a tag's return value is not inferred. That is an explicit limit: the current
threat is an honest developer or AI writer reaching for the cheap complete
literal-interpolation or literal-concatenation dodge, not active obfuscation.
Banning all interpolation or all concatenation in production would reject
ordinary application code and would be a broader language-policy packet, not a
proportionate correction here.

No ADR is added. ADR-0011's generic-press rule and ADR-0023's prohibition on
module-ID allowlists already govern the outcome; this packet changes the
observation mechanism and records its bounded threat model rather than creating
a competing architecture authority.

## Committed controls

The controls vary one property and use a Widget fixture so they do not rely on
the routed Inventory debt:

| Direction | Specimen | Observed contract |
|---|---|---|
| refusal | `` `${'northstar'}.${'widget'}:capability.posting` `` | one `PRESS006_MODULE_ID_IN_PRESS`, naming `northstar.widget` |
| refusal | `'northstar' + '.' + 'widget' + ':capability.posting'` | one `PRESS006_MODULE_ID_IN_PRESS`, naming `northstar.widget` |
| attribution | an unrelated construction followed by a multiline interpolated identity | the PRESS006 line is the template's line 3, not index zero or the earlier construction |
| constructed admission | concatenated and interpolated `northstar.widget-contract/v1` values in generic production source | zero violations; the completed legal values are measured without refusing nested prefixes |
| dynamic-boundary admission | static `northstar.widget` prefix plus an identifier-held legal suffix | zero violations; an unevaluable outer value is not partially observed |
| tagged-boundary admission | a tag receives the spliced template body | zero violations; the tag controls the runtime result |
| admission | `northstar.widget` spelled by the Widget definition itself | zero violations beside a non-module generic production file |
| live debt | unspliced inventory posting capability literal | the exact fourth routed violation at the provider file and line |

The first candidate's focused run passed 13/13. The corrected focused run passes
16/16 and reports the same four exact live violations: the compiler debt, the
now-visible Inventory posting provider debt, and the two Platform provider debts.

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

The reusable lesson is recorded here rather than in root `learnings.md`, which is
outside this packet's granted paths: **an AST gate must observe the completed
semantic value named by its claim, never each nested parse fragment as a proxy.**
