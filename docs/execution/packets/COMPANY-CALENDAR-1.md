# COMPANY-CALENDAR-1 · A business calendar per owning scope

**Slice 1 · The resolver, BUILD 2026-11-26.** Critical (time and money dating, rule 18). Design: `/home/rvham/2rain-missions/CALENDAR-TAX-design.result.txt` part A; Fable design read AMEND C1-C8 (`CALENDAR-TAX-s1-design-read.result.txt`), all applied. Migration 0072 (provisional; TAX takes 0072 in TRAIN-T, renumbered at merge), no rung, no Customize member, no compiled or stored change.

CI tier: pending full

## What slice 1 adds

- `platform.business_calendars` (tenant default, or one company's override; the default's id is the tenant id) and `platform.business_calendar_versions` (append-only, effective-dated: zone, day boundary, week start, fiscal-year start month). Both force RLS with no policy and no grant. Backfill copies every `inventory_tenant_calendars` row verbatim as the default's version 1 from `-infinity`, recorded at the old `created_at`.
- `north_star_internal.business_calendar_at(t, e, company, at)`: the override version in force, else the tenant default (a company with no override, or an instant before its first version). `business_day(t, e, company, at)` refuses an undeclared calendar (no UTC default). `business_day_of` is the one arithmetic, unchanged from 0015.
- `inventory_business_period(t, at)` is re-bodied as the resolver with company null; signature, STABLE, definer, search path, grants, scope check, both error names and DETAIL, arithmetic and NULL-in-NULL-out are unchanged (C3). `ledger_business_day(company, instant)` changes only its last line: it resolves the entry's stored company (C6).
- C1: the new tables are authoritative; `inventory_tenant_calendars` is a frozen mirror (UPDATE, DELETE and TRUNCATE refuse); provisioning writes both stores in one transaction through `business_calendar_put` (granted to no one, READ COMMITTED guard, one row FOR UPDATE, future-business-day rule); a tenant default keeps one version while the mirror exists. The six test writes (the design read counted five; 1a-i's ledger test is the sixth) go through `test/helpers/business-calendar-seed.ts`.
- C2: overrides at provisioning are deferred to slice 2; the conflict branch is unchanged. Overrides are proved with rows the test inserts as owner.
- C5: no UPDATE or DELETE runs at migration time; an override starting at `-infinity` is refused in SQL once its company has a ledger company row or a stock posting configuration.
- C7: `platform.business_calendar_read(company)` ships with its isolation red (EXECUTE for `north_star_runtime` only; membership tenant-wide or scoped to that company).

## Test it yourself

| Slice | Try it | Expected observation |
| --- | --- | --- |
| 1 | `node --import tsx --test test/postgres/business-calendar.test.ts` (PostgreSQL), then `bash scripts/check-expected-red.sh --run calendar-company-branch`. | 16 tests pass. Company B (Winnipeg override) is on 2026-04-01 at 05:30Z while company A (Vancouver default) is on 03-31, through `business_day` and `ledger_business_day`. The control drops the company branch and the three override tests fail as declared. |

## Discriminating proofs (rule 8)

Controls in [`COMPANY-CALENDAR-1-s1.expected-red.json`](../../../test/evidence/COMPANY-CALENDAR-1-s1.expected-red.json), one per check: arithmetic flip (differential), company branch, effective-from predicate, default fallback, versions append-only, mirror frozen, provisioning both stores, no UTC default, session scope, NULL instant, setter READ COMMITTED, future business day, single default version, backdated override, no runtime grant, company-scoped read. Identity: the existing calendar tests run unmodified except the five migration-list pins every migration packet moves (inventory-storage, migrations, module-storage-transition, trust-substrate, release-persistence-boundary) (inventory-storage, module-storage-transition, inventory-backup-restore); the nine fresh-tenant CHECKs are untouched (snapshot unchanged); a differential test compares the 0033 body, installed verbatim, with the new one over five zones, four boundaries, both 2026 DST changes, year end, a second-grid midnight, ±infinity and NULL.

## Evidence

- Controls on GitHub (evidence dispatch): 16 of 17 green on `d8546ba6` (run 45862315140), `calendar-backfill-verbatim` green on `94b8ee95` (run 45855675343, its restored run also executed the CI-only preceding-reader proof), `calendar-no-utc-default` re-proved green (run 45864149796) after its replacement text lost a `$$` (the runner's string replace turns `$$` into `$`).
- `db/schema.snapshot.json` is CI-9 snapshot mode output (run 45855665619), not a hand patch; the fresh-tenant snapshot it regenerated is byte-identical to the committed one.
- GUARD-WIDEN name law (eabdb9408's guard on this tip and on main): identical hits, none from this packet.
- Rule 13, no rung: `business-calendar-reader.test.ts` runs the actual preceding binary (main `b6668f05`) on the migrated database; it answers the booking usage query and its grouped-report horizon gives the same business day as the resolver. The upgrade test digests every pre-existing table before and after the migration (byte-identical) and a booking after the upgrade freezes the same calendar JSON.

## Rule 17

(a) One business calendar per owning scope, resolved deterministically from (scope, instant), append-only and effective-dated, so a past instant never moves. (b) Used unchanged by stock periods, ledger dates, and in slices 2-3 bookings, reports, date-time capture and reminders; it serves rentals (off-hire and invoice days), distribution (stock periods across provinces), clinics and hotels (a 04:00 night audit) and field service (dispatch day). (c) Narrower: fiscal years are months only; week start and fiscal month are stored but read by nobody until slice 3; working time is a separate block (WORKING-TIME-1).

## Slice 2 notes (C8)

Slice 2 moves the materializer CHECK to the company and adds overrides at provisioning; the table drop belongs to the slice that moves the last reader (slice 3: `grouped-report.ts`, `module-runtime-interpreter.ts`, `composed-application-runtime.ts`, the booking definers, Billing's authored zone). The `-infinity` override exception for a provisioning transaction is settled in the slice 2 read.
