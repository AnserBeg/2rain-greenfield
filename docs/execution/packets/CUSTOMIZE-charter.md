# CUSTOMIZE — charter: a non-developer adds a record type, field, choice or layout, sees a plain diff, approves, activates, rolls back (weeks 2-5)

You are the BUILD lane. Chartered 2026-11-17 from `main` `620383bf` by the orchestrator. Worktree
`/home/rvham/2rain-greenfield-customize`, branch `packet/CUSTOMIZE`. Read `AGENTS.md`, the top of
`current-plan.md`, the skills `mission-cadence` and `git-workflow`, ADR-0013, ADR-0066, plan §5.6,
§10.1-§10.2, §10.6 and §11.9. Verify every path and symbol below with `ls`/`grep` before relying on it.

## Outcome (owner's words, `current-plan.md`)
"A new record type, field, choice or layout is AI-drafted, compiled, shown to the owner as a plain diff,
approved, activated, and one click rolls it back. Week 6: a non-developer gets a new record type live in
under ten minutes, rollback works, nothing else breaks."

## What exists (mapped 2026-11-17)
`release-records.ts` revision/release types; migrations 0003-0005, 0007, 0013; `PostgresImmutableReleaseRepository`;
`compileApplicationRelease` (with `expectedActiveRelease` → storage transition); `PostgresReleaseActivationService`
and `PostgresReleaseApprovalService`; `authorizeReverseTransitionIfApplicable`; the storage planner (`createTable`, `addColumn`,
`widenEnumDomain`); `diffCompiledReleases` (no production caller). Rollback exists only at boot (`NORTH_STAR_ROLLBACK_RELEASE_ROOT`).
**Missing:** patch lineage, any tenant revision path, a real diff bound to approval (the preparation writes placeholder
digests), activation without a restart, a clickable rollback, and any UI. `composed-application-runtime.ts:388` refuses a pointer
outside `app.compiled.json`'s lineage.

## Slices (each user-observable; merge each to `main` on CI green; nothing unmerged more than two days)
1. **Draft and diff.** `corepack pnpm customize draft <patch.json>` stores an append-only patch record, normalizes parent desired
   state plus patches into a `tenantAuthored` child revision, compiles the candidate, and prints a plain-language diff. Test: add
   record type "Equipment" (name, serial number, purchase date, status choice) and read the diff.
2. **Approve, activate live, roll back.** `customize approve|activate|rollback`. A running `pnpm dev` shows Equipment without a
   restart. Rollback hides it and keeps its rows. Re-activation shows them again.
3. **Customize screen.** The same loop in the web app: describe a change from the four kinds → plain diff → Approve → Activate →
   a Roll back button on the active release.
4. **AI drafting.** A request in plain English ("add an Equipment record with serial number and status") → the model emits only
   the typed patch JSON, Zod-validated, never free text → slices 1-3. Reuse the AGENT packet's provider adapter and key loading
   (`packages/operations-agent`) once it is on `main`; until then, do slice 5's harness first.
5. **Week-6 rehearsal.** A timed scripted run of the non-developer path (< 10 min), a rollback, and the full CI matrix green. Write a
   dated result file under `docs/execution/evidence/`.

## Decisions made (orchestrator, 2026-11-17; do not reopen)
- **Patch lineage (ADR-0013):** one migration, an append-only `platform` table with RLS and no update or delete path. It binds payload,
  tenant, environment, actor, channel, base versions, parent and resulting revision, language/profile versions and trusted time.
  It is data-plane, never a canonical family. A canonical language version bump is a STOP.
- **Patch kinds v1:** `addRecordType{label, fields[]}`, `addField{entity, field}`, `addChoice{enumField, option}`,
  `arrangeLayout{surface, order/hide/relabel}`.
  - `addRecordType` expands into a tenant module carrying every family conformance requires (storage mapping, q0 get/list, o0
    create/update/archive/restore, form/list/record surfaces, assertion, permissions). Generate them the way
    `locationModuleDefinition`'s helpers do. The user never authors them.
  - Any other request is a typed `unsupported` result naming the missing capability, never partial output.
- **§10.6 boundary:** `addField` and `arrangeLayout` may target a tenant entity, or a first-party master/document header whose
  field set is not in a Tier B dependency set. Otherwise the compiler refuses with a stable diagnostic.
- **Policy:** new permissions are bound at compile to the existing admin role. The unbound-acknowledgement file only shrinks;
  never add to it.
- **Runtime lineage:** boot and serving accept an active pointer naming a `tenantAuthored` descendant of the lineage tip.
  - If the first-party lineage advances under an active tenant revision, re-apply the patches to the new base (ADR-0013).
  - If that grows past a slice, fail loudly with the remedy (`dev:reset`, pre-tenant) and file the rebase.
- **Diff:** `diffCompiledReleases` replaces the placeholder digests in the activation preparation. The canonical digest hashes the
  envelope, and the rendered digest hashes the plain-language text the approver saw. Approval binds both.
- **Live activation:** the runtime rebinds release-scoped state per pointer, keyed by release root. No restart.
- **Rollback:** a runtime operation through the existing reverse-transition policy, including a `createTable` edge. Storage stays
  additive.
- **Freeze (R2):** the Customize screen is the six-week test's own scope, not a distributor feature, so R2 does not apply. Ship the
  minimal screen; the full §8.5 builder archetype is filed, not built.

## You decide alone (one line each in the record)
Module and file layout, CLI wording, diff wording, the patch JSON field names, the tenant module's id, how the screen is reached.

## STOP (five lines: what, two options, your recommendation)
A canonical language or profile version bump; a second migration; any change to the posting kernel or to activation's
CAS/fence/verification guarantees (extend them, never weaken them); a CI red you cannot make green honestly; a collision with
the AGENT lane's paths that you cannot solve by merging `main`.

## Lease and Critical set
Everything the slices need. The AGENT lane owns `packages/operations-agent/**`, `test/agent/**` and `apps/api/src/**` wiring; merge
`main` often and touch `composition-root.ts` minimally. Critical paths you will touch: `release-activation*.ts`, `db/migrations/**`,
RLS/grant SQL, possibly `module-storage-materializer.ts`. Those merges are logged `merged — unread`. The orchestrator launches the
Codex read; never review yourself.

## Gates and conduct
- `format`, `typecheck`, `lint`, then focused tests. CI on push is the matrix.
- Run a local PostgreSQL or browser suite only to reproduce a CI red, under `scripts/run-with-test-lock.mjs`, one container at a time.
  `timeout 15 docker info` first. Full local runs stall this laptop.
- Commit WIP often (usage limits can stop you mid-edit). Stage explicit paths, never `git add -A`. Every commit carries `Packet: CUSTOMIZE`.
- Integrate each slice yourself (`git-workflow`): `--no-ff` into `main`, one ledger row, one review-log row, push, CI green at the
  merge. Re-run the whole workflow for `COMPILE_BUDGET_INDETERMINATE`; never relax a bound.
- Record: `docs/execution/packets/CUSTOMIZE.md`, at most 80 lines.

## Report (≤ 30 lines) after each slice, and at the end
`LANE: BUILD · PACKET: CUSTOMIZE · SHA · BASE`; per slice: merge SHA, CI run, the "Test it yourself" block; decisions; filed lines.
