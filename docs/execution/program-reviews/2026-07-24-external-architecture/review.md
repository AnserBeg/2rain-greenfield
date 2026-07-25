# External architecture / plan-coverage review — 7 findings

Provenance: independent external AI review with repository access, 2026-07-24, against `main`
around `d1ab76b`. Scope: general review of the codebase and its build-out plans, explicitly
excluding anything the 2026-07-24 whole-app program review already dispositioned (PR-1/2/3 and
its recorded-future-work list). Reproduced verbatim from the session transcript by the
orchestrator, who independently verified findings 1, 2, 3, and 4 against the repository (all
accurate).

---

I read AGENTS.md, the 3,363-line program plan, the ledger, doctrine-coverage map, all 11 ADRs'
index, the G2-P0/G2-P3 packets, the converged program review, and the actual source/CI/test
wiring. Findings below, ordered by how much they'd cost you if left alone. I've excluded
anything the 2026-07-24 program review already dispositioned (PR-1/2/3, the recorded-future-work
list) — everything here is additional.

## 1. Four test scripts still carry the exact bug PR-1 fixed in one place

PR-1 finding #2 fixed `test:unit`'s unquoted glob. The same pattern survives in
`package.json:22-27` for `test:architecture`, `test:compiler`, `test:integration`, and
`test:postgres`.

`test/postgres/**/*.test.ts` is unquoted, and bash without `globstar` treats `**` as `*`. Today
no subdirectory exists under those four dirs, so the shell glob matches nothing, passes the
literal pattern through, and Node's own test-runner glob expands it correctly. It works by
accident. I verified the failure mode:

```
bash -c 'shopt -u globstar; for f in test/postgres/**/*.test.ts; do echo "$f"; done'
```

With a subdirectory present, that expands to only `test/postgres/sub/b.test.ts` — every
top-level PostgreSQL test silently disappears from the run, and CI stays green.
`test/unit/canonical-model/` is precisely how this bit you the first time. The fix is quoting
the patterns (or enumerating, as `test:unit` now does);
`test/architecture/repository-hygiene.test.ts:81` should assert it for all five, not just unit.

## 2. Two test suites and a compiler-output drift guard are not in any CI job

- `apps/web/test/surface-runtime-contract.test.ts` — the G1-P7 "6/6 focused contracts."
  Reachable only via `pnpm --filter @north-star/web test:contracts`, which appears nowhere
  except the packet's "Test it yourself" block. Its first test asserts that the checked-in
  `apps/web/release/shell.compiled.json` is exact deterministic compiler output.
- `check:demo-release` (`apps/web/package.json:8`) — the other guard on that same artifact. Also
  CI-invisible.
- `test/browser/scaffold.spec.ts` and the root `playwright.config.ts` — G0-P1a leftovers
  orphaned when `apps/web` got its own config. `test:browser` only points at the `apps/web`
  config.

Net effect: a committed compiler artifact has two staleness guards and neither runs. Any
compiler-output change can leave it stale with the full matrix green — the same cross-layer
class as the AGENTS.md §6 rule about downstream consumer suites. PR-1's CI sweep
(`test:compiler`, `check:schema`, agent tests) was incomplete. Nothing in the repo asserts
"every `.test.ts`/`.spec.ts` is reachable from a CI command"; adding that check closes the whole
class.

## 3. Identity and policy are the one kernel seam with no owner

`CurrentPolicyGateway` (`packages/runtime/src/request-runtime-view.ts:113`) and
`AuthenticateRequest` (`packages/runtime/src/request-context.ts:20`) are well-designed,
deny-capable, version-evidenced ports. The only implementations in the repo are test/demo stubs
that return ALLOW unconditionally (`apps/web/src/demo-runtime.ts:41-52`).

That's fine for G2. The problem is that nothing schedules the real thing:

- §13's work-package table has no ID for identity, roles, or the policy kernel (F-04 delivered
  the trusted-context port only).
- `docs/execution/doctrine-coverage.md` has no row for §6.8 permissions/roles or
  identity-provider integration — so it isn't even prose-only, it's absent from the map whose
  stated goal is that no binding concern stays merely prose.
- §12.12 assigns "Identity, tenant, environment, permissions" first-usable at G0-G1, and closes
  with "Stage acceptance requires every row assigned to that stage to have exact work packages
  and evidence." G1 is marked COMPLETE with that row unowned.

Meanwhile every module from Party onward declares `permissionId`s
(`packages/runtime/src/semantic-operation-gateway.ts:75`) that nothing evaluates, and Gate G2
requires "invalid or cross-tenant relations fail at the service and policy layers."

This is the highest-value gap I found. Catalog and Location will each declare another permission
surface against a stub. Recommend a doctrine-coverage row plus a named packet before or
immediately after fan-out.

## 4. Overdue G0 obligations that were never tracked

Four §11.3 deliverables were never produced, and unlike everything else in this program, none of
them is in the ledger or the coverage map:

| Obligation | Status |
|---|---|
| §11.3(7) capability support matrix | Missing. `doctrine-coverage.md:9` cites it as an existing complementary artifact — a dangling reference. |
| §11.3(7) risk register (living) | Missing. Plan §16 is a static table; §11.1(4)/§13.4(7) require updating a register per stage. |
| §15.1 SLO ratification ("ratify exact targets during G0") | Only `docs/operations/compiler-slos.md` exists. Availability, query p95, operation p95, RPO/RTO are unratified. |
| §11.3 salvage: seed `adding-a-module`, `no-source-editing`, `create-skill`, `erp-architecture-layer-map` skills | Never done; the string appears only in the plan. |

The last one is worth doing now rather than later: `adding-a-module` is exactly the artifact the
Catalog/Location fan-out consumes, and the reusable module template from G2-P3b exists to write
it against.

Also note there is no G0 stage-gate evidence doc — `docs/execution/stage-gates/` holds only
`G1.md`, and the ledger's stage-completion table lists only G1, despite G1-P9 and the planned
G2-P9 establishing consolidation packets as the pattern.

## 5. No declared position on timezone or business-day semantics before G3

`timezone` appears twice in the entire plan (N2/N5 schedules), and `localization` once — in the
G7 experience audit. But G3 designs `effectiveDate`, backdated postings, closed periods, and
as-of balance queries, all of which need a declared authority for what "a day" means for a
tenant. Deciding this at G7 means rewriting inventory read models. You already have a
`test:locale` C-locale determinism probe, so the team is alert to locale in storage — the gap is
in business semantics. A short ADR before G3 (UTC storage, tenant-declared business timezone,
day boundaries derived server-side) costs an hour now.

## 6. Runtime configuration and secret handling have no contract

§11.3(5) required establishing environment configuration and secret handling. What exists is
secret scanning (G0-P5c, solid) plus three ad-hoc `process.env` reads
(`packages/postgres-provider/src/migrate.ts:7`, `apps/web/observability/server.ts:8`,
`apps/web/src/demo-server.ts:7`). No config module, no validated required-env set, no
`.env.example`. Low urgency while the app runs only from fixtures — but it pairs naturally with
the program review's already-recorded "runnable app composition outside test fixtures" packet,
and the doctrine map should carry a row so it isn't rediscovered at G7.

## 7. Two product-scope questions worth deciding explicitly

Neither is a defect — both are decisions currently made by silence.

**Inventory valuation.** "What is my stock worth" is unanswerable at launch and post-launch until
N3 (valuation appears once, at line 2463). §2.3 excludes accounting deliberately and I'd keep
that, but valuation is adjacent to accounting, not identical, and it's the single most common
question asked of an inventory ERP. This belongs alongside the program review's "accounting
handoff/export contract before pilots" note.

**Retention, purge, and erasure.** AGENTS.md §7 says "No hard-delete paths for business data,
anywhere, ever," and §7.4 says physical purge is "an administrative retention process." Party
records hold customer contact data, and trust facts are append-only. No work package owns
retention/purge administration, and no ADR reconciles append-only trust with a data-subject
erasure request. G7's administration checklist mentions "retention" in passing. If a pilot tenant
is in a jurisdiction with erasure rights, this becomes a launch blocker discovered late.

## On the parts that are working

The doctrine-coverage map, the fresh-naive dual-review discipline, the monotonic-time and
full-matrix-at-integrated-SHA rules, the migration runner's checksum/drift/advisory-lock design,
and the `learnings.md` supersession chain are unusually strong — the program review's "the spine
is sound" verdict matches what I read.

Findings 1, 2, and 4 are all the same meta-pattern, though, and it's the one to watch:
obligations that live only in prose get enforced only when someone remembers them. The coverage
map was built precisely to prevent that, and each of these is a rule that never got a row in it.
