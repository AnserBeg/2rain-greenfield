# POSTING-FORWARD-DATE — no inventory posting is dated after the tenant's today

Status: executable candidate `aeef2b65f3183387d7f0c9f135ee385d53091e4d` on `packet/POSTING-FORWARD-DATE`; draft PR #9 against main, CI green; round-1 review found no production defect; controls reproduced; ready for the owner's merge decision (no merge, no deployment by this lane).
Tier: Critical — `packages/postgres-provider/src/inventory-posting-service.ts` and its error union `inventory-posting-error.ts`. One fresh-naive online arm is owed (`POSTING-FORWARD-DATE-review-prompt.md`). Stops: 0.
Base: `fe97b63baedf8bdd42146318bb89d4be1aa948f6` (origin/main). Charter: section A of the orchestrator's four-packet inventory design (2026-09-30, read-only), which found that receipts and shipments already refused a date after today while adjustments, transfers and counts did not.

## Owner rulings (2026-09-30, "go with the recommended choice")

- R1 today: the tenant's declared business day at the kernel's `recordedAt`, zero days of slack; declare the office's zone `America/Edmonton` (Calgary) at the composition root only if the change is contained. Applied (Decisions).
- R2 backdate window: widen the composed tenant's `maximumBackdateDays` 0 → 7, fresh databases only, no data migration; add the receipt-window cases if they fit. Applied (Decisions).

## Claims

1. A1. No family (adjustment, transfer, count and its correction, receipt, shipment) commits a movement whose effective tenant business day is after the tenant business day of its `recordedAt`. The refusal is raised inside the posting transaction before any write: no movement, no posted source, no trust row. Receipts keep `RECEIPT_FORWARD_DATE_REFUSED` and shipments `FULFILLMENT_SHIPMENT_INVALID` (same messages and details as before); every other family refuses as `INVENTORY_FORWARD_DATE_REFUSED` `{effectivePeriod, recordedPeriod, maximumForwardDateDays: '0'}`.
2. A2. The rule compares days with zero slack: a later instant of the recorded business day is admitted, the next business day is refused.
3. A3. "Today" is the tenant's declared business day (zone and boundary, through `inventory_business_period`), never the UTC date of either instant.

## Decisions

- One `enforceForwardDate` beside `enforceBackdate`, called once in `#post` after the stock-count block and before `assertPostingMasters` — where the two role-specific checks it replaces ran, so receipts and shipments refuse in the same order as before. Stored receipts and natural replays return earlier, unchanged.
- The rule is fixed, like RECEIPT's pinned `maximumForwardDateDays = '0'`: no contract dial, no migration, no release or lineage change.
- Receipts and shipments keep their codes so existing callers and tests read the same refusal; one new code covers the other families.
- R1 applied: the composed tenant declares `America/Edmonton`. It is contained: the web renders instants as canonical UTC strings and never reads the tenant calendar, the fresh-tenant schema snapshot carries no calendar, and no test asserts a composed posting's business period. The one ripple is a fixture: `receiving-authorization.test.ts` provisions a second legal entity in the composed tenant with a literal `'UTC'`, and the calendar belongs to the tenant, so it now reads zone and boundary from the scope; no expectation changed.
- R2 applied: `maximumBackdateDays: 7` for the composed tenant only. The compiled contract's default stays 0 (a release change would need a lineage entry). No test pinned the composed scope's 0; the zero windows in tests belong to their own fixture scopes.
- Fresh databases only (both rulings): provisioning asserts the calendar and policy against stored values, so a dev database created before this change refuses to start (`INVENTORY_TENANT_CALENDAR_CONFLICT`) until it is recreated (`pnpm --filter @north-star/api dev:reset`) or a new container name is used.
- R2's receipt-window cases: backdating and forward dating are single family-independent calls. The backdate test proves 7 days back admitted and 8 refused in a seven-day scope, the new test proves tomorrow refused for a transfer and an adjustment, and `inventory-posting.test.ts` still proves the receipt's own forward refusal. Receipt-specific window cases would need the purchasing fixture inside the backdate harness: filed.
- Tests: the backdate test's step 3 (seven days ahead) now expects `INVENTORY_FORWARD_DATE_REFUSED`, leaving no movement, a draft and no trust row; its executed reds go 2 → 3. A new test in the same file, on a Calgary tenant, covers A2 and A3. No new test file, because `repository-hygiene` pins the PostgreSQL file list. The harness setup moved into `openPostingHarness` so both tests share it.

## Controls (`test/evidence/POSTING-FORWARD-DATE.expected-red.json`)

- `forward-rule-call-removed` → A1: deletes the call; the backdate test's step 3 dies with node's `Missing expected rejection: seven days ahead must be refused by the forward rule` (a removed refusal cannot declare its own message).
- `forward-rule-one-day-slack` → A2: `effective <= recorded + 1`; the forward-rule test dies at its first case, a transfer dated 09:00 the next Calgary day: `Missing expected rejection: the next tenant business day must be refused`.
- `forward-rule-utc-days` → A3: the call receives the UTC dates of the two instants; the forward-rule test dies at 19:00 Calgary recorded at 17:00 (5 August in UTC): `INVENTORY_FORWARD_DATE_REFUSED: effective period 2026-08-05 is after the recorded business day 2026-08-04`.
- `--run` not yet reproduced: every run needs the backdate-policy file's PostgreSQL container, which load prevented (Gates). Static validation holds all three (below).

## Gates

- `aeef2b65` (own worktree): static `check-expected-red.sh` OK, 142 entries in 13 manifests; `check-records.sh` OK; unit `module-provider-error-mappings` plus integration `semantic-gateways` 53/53; compiler `g2-module-conformance` 78/78 (26 min under load); architecture `module-press-law` 46/46.
- `tsc -p tsconfig.json --noEmit` exit 0, `prettier --check` and `eslint` clean on every touched file — run on the pre-commit tree, which differs from `aeef2b65` only by prettier's one line-wrap in the test.
- PostgreSQL `inventory-backdate-policy.test.ts`: eight runs under the machine lock (00:47–04:12 MDT), every one refused before any test body ran — `ephemeral PostgreSQL was not ready within 30000ms` — at load average 4–35 with five agents testing at once, and Windows free memory 0.5–1.1 GB of 16 GB (the last run: load 4.5, 0.7 GB free). A bare container on the same Docker took 27 s to return from `docker run` and 307 s to accept connections. This is host paging, not a code result; the file and the three controls are owed.
- Not run, by the lead's instruction to run only the files this change touches under this load: `inventory-posting`, `inventory-stock-count`, `fulfillment`. `receiving-authorization` (touched) is owed with the backdate file. CI covers all four on push.

- CI on PR #9 at `edaebdf2` (the candidate plus SALES-PARITY's harness race fix `277d34c8` and advisory pin `edaebdf2`, carried so this main-based branch's CI can pass; both outside the declared range): every job green, including PostgreSQL schema and isolation (the flipped backdate-policy step, the new tenant-calendar test, receiving-authorization) and the executed-file reachability check. The three controls' `--run` is still owed locally (container starts time out on this host).

- Controls (2026-10-01, host Docker healthy again): `forward-rule-call-removed`, `forward-rule-one-day-slack`, `forward-rule-utc-days` each killed with its declared reason and restored green (`--run`, 56 s) at `9936b106`.

## Test it yourself (about ten minutes)

```sh
cd /home/rvham/2rain-greenfield-posting-date
NORTH_STAR_DEV_DATABASE_CONTAINER=dev-posting-date-postgres NORTH_STAR_DATABASE_PORT=55447 PORT=4323 NORTH_STAR_TENANT_SLUG=local-posting-date corepack pnpm dev
```

The new container name gives a fresh database, which the new calendar needs (an older dev database refuses to start with `INVENTORY_TENANT_CALENDAR_CONFLICT`).

1. New transaction: `http://127.0.0.1:4323/?surface=northstar.app%3Asurface.inventory_transaction_form&northstar.app%3Aparameter.inventory_transaction_get_legal_entity_scope=74000000-0000-4000-8000-000000000001`. Number `FWD-1`; Type: pick the adjustment option (it fills `northstar.app:option.inventory_transaction_type_adjustment`); State `draft`; Reason code `TEST`; Reason `forward date check`; Source type `adjustment`; Source `FWD-1`; Effective at = tomorrow noon in Calgary, written in UTC (on 30 September: `2026-10-01T18:00:00.000Z`); Recorded at the same; Actor `me`. Save.
2. New line: `http://127.0.0.1:4323/?surface=northstar.app%3Asurface.inventory_transaction_line_form&northstar.app%3Aparameter.inventory_transaction_line_get_legal_entity_scope=74000000-0000-4000-8000-000000000001`. Transaction `FWD-1`; Line number `1`; Item `71000000-0000-4000-8000-000000000011`; To location `71000000-0000-4000-8000-000000000021`; Quantity `1`; Unit `EA`. Save.
3. Open `FWD-1` (Inventory transactions list) → Post → Confirm Post. Expected: "Operation refused" naming `INVENTORY_FORWARD_DATE_REFUSED`; `FWD-1` stays a draft and Posted stock is unchanged.
4. Edit `FWD-1`: Effective at = the current time in UTC (today in Calgary at any hour), Save, then Post → Confirm Post: it posts. A second transaction dated up to seven days back also posts; eight days back refuses as `INVENTORY_BACKDATE_LIMIT_EXCEEDED`.

Ctrl-C stops the server and its container (`pnpm --filter @north-star/api dev:stop` if it was killed outright).

## Filed

- Round 1, filed (not production): the new regression cases exercise adjustment and transfer at the database; count and correction, receipt, shipment, non-midnight boundaries and daylight-saving days are covered by the reviewer's model and the shared call site, not by database tests. `forward-rule-call-removed`'s description says families "other than receipts and shipments", but deleting the common call removes their enforcement too; `forward-rule-one-day-slack` claims every other case keeps its verdict, which the `afterMidnight` case does not (its first expected failure still occurs as declared).
- No test posts a count or a shipment dated tomorrow: the call sits on the path every family shares, and the adjustment, transfer and receipt refusals are tested. The shipment refusal keeps its message but is still untested, as before this packet.
- Receipt-specific backdate-window cases (yesterday admitted, eight days back refused under the seven-day window) need the purchasing fixture in the backdate harness.
- The form's "Effective at" is a canonical UTC instant, while the business day is now Calgary's: between 18:00 and midnight in Calgary the form shows tomorrow's UTC date for a posting that is still today.
- Load, not code, kept the PostgreSQL evidence from running: the backdate-policy file, `receiving-authorization` and the three `--run` controls are owed on a quiet host, and the branch is unpushed, so CI has not run either.

Review: round 1 (ONLINE, owner-run, 2026-10-01, on `aeef2b65`) found no production defect under A1-A3 (72 isolated checks across the six roles; calendar cases against a model of `inventory_business_period`); its evidence and wording notes are filed above. No further round is owed.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "POSTING-FORWARD-DATE",
  "base": "fe97b63baedf8bdd42146318bb89d4be1aa948f6",
  "head": "aeef2b65f3183387d7f0c9f135ee385d53091e4d",
  "changedPaths": [
    "apps/api/src/composition-root.ts",
    "docs/architecture/posting-kernel-guarantees.md",
    "docs/decisions/ADR-0018-temporal-authority.md",
    "packages/postgres-provider/src/inventory-posting-error.ts",
    "packages/postgres-provider/src/inventory-posting-service.ts",
    "test/evidence/POSTING-FORWARD-DATE.expected-red.json",
    "test/postgres/inventory-backdate-policy.test.ts",
    "test/postgres/receiving-authorization.test.ts"
  ],
  "symbols": [
    { "path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "PostgresInventoryPostingService" },
    { "path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "enforceForwardDate" },
    { "path": "packages/postgres-provider/src/inventory-posting-error.ts", "name": "InventoryPostingErrorCode" },
    { "path": "apps/api/src/composition-root.ts", "name": "COMPOSED_APPLICATION_INVENTORY_SCOPE" }
  ]
}
```
