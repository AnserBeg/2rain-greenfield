# press-law-splice — make PRESS006 observe the identity it claims to govern

Date: 2026-08-20
Base: `8136cfaa8caf23a73221cfa2b0feb5c90987556b` (`origin/main`, fetched and
verified before cut)
Branch: `packet/press-law-splice`
Tier: Critical — the diff changes what an architecture gate proves
Status: active; candidate frozen for the user-run online review with every
declared cheap gate and blast-radius suite green; full matrix deferred until
review converges

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
packet's explicit stop condition. The debt row stays until that compiler-owned
remedy lands.

### Refuse literal splicing of module identities in production press source

Yes, for statically evaluable JavaScript/TypeScript string constructions. The
guard now parses production source and evaluates only string literals,
parentheses/type wrappers, template expressions whose substitutions are static,
and `+` expressions whose operands are static. The resulting value is checked by
the same `moduleIdentityMatch` authority as a contiguous spelling. The guard
therefore reports `PRESS006`, rather than introducing a parallel rule or an
allowlist.

This is deliberately narrower than symbolic execution. An identity assembled
through runtime values or identifier indirection is not resolved. That is an
explicit limit: the current threat is an honest developer or AI writer reaching
for the cheap literal-interpolation or literal-concatenation dodge, not active
obfuscation. Banning all interpolation or all concatenation in production would
reject ordinary application code and would be a broader language-policy packet,
not a proportionate correction here.

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
| admission | `northstar.widget` spelled by the Widget definition itself | zero violations beside a non-module generic production file |
| live debt | unspliced inventory posting capability literal | the exact fourth routed violation at the provider file and line |

The focused post-change run passes 13/13 and reports four exact live violations:
the prior compiler debt, the now-visible inventory posting provider debt, and
the two prior platform provider debts.

## Gate evidence

Run in the declared order from this isolated worktree:

| Gate | Result |
|---|---|
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm format` | PASS — all matched files use Prettier style |
| `corepack pnpm test:architecture` | PASS — 144/144, including 13/13 module-press-law tests and the exact four-item live debt set |
| `corepack pnpm test:postgres` | PASS — 203/203 in 950,680.8 ms |

Before each exclusive suite, the lock-holder registry was empty. The measured
CPU idle windows were 95.5% before Architecture and 96.0% before PostgreSQL.

Per `git-workflow`, the full CI matrix runs once only after the Critical review
chain converges; it is not a pre-review freeze gate.

## Review state

No review was run by this lane. The exact frozen SHA, remote identity evidence,
gate results, known gaps, and complete user-pasteable first-arm prompt are
reported in the writer handoff because a commit cannot contain its own SHA.
