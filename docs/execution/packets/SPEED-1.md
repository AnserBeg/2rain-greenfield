# SPEED-1 — a record page in a few database trips, measured and held there

Status: slice 1 at `3ab5853a`; slices 2-4 at `69b7adc1` (one integration, orchestrator ruling); slices 5-6 at `1663ade6`. Tier: request
security path, no file of the `AGENTS.md` §4 Critical set; slices 2-4 get the orchestrator's two critical reviews. Base: `main`
`74b3367f`. Stops: none. Charter: [SPEED-1-charter.md](SPEED-1-charter.md). ADR: [ADR-0071](../../decisions/ADR-0071-read-decisions-are-live-per-request-writes-per-call.md).

## Claims

1. `Server-Timing` on the local server (`request-work-meter.ts`): `db-transactions`, `db-statements`, `db-authorization`,
   `db-repeats` (`desc="N"`), `app;dur=<ms>`. Statements include BEGIN/COMMIT/RESET; a transaction is a BEGIN or a statement
   outside one, never the RESETs; repeats exclude control and the trusted envelope. The 1,204-statement log replays to 1,204 / 148
   / 120 policy reads.
2. `test/performance/page-budget.test.ts` fails when a page exceeds a ceiling in `page-budgets.ts`; each page must render its
   content; parse columns read LOOP-1's `catalogParseCount()` around each request.
3. A GET page and a task step run their reads in one read-only `REPEATABLE READ` snapshot (`withReadSnapshot`,
   `request-context.ts`) with one envelope, finished before the page is rendered (task steps: when the step returns).
4. Writes never join: `withTrustedRequestTransaction` first ends a held snapshot, so a request holds one connection; a joined
   read may not open one (`ReadSnapshotIntegrityError`); the snapshot is `READ ONLY`.
5. Ending the snapshot reads the live epoch in its own transaction; a change discards a GET and assembles it once more, then
   refuses (`ReadSnapshotPolicyChangedError`); a task step is refused at once.
6. Read decisions (`REUSABLE_READ_DECISION_KINDS`, `current-policy.ts`) come from one grants read per snapshot with the same
   three revocation checks; invocation, capability and out-of-page decisions read live in their own transaction (ADR-0071).
7. In a snapshot the module role is assumed when a read first sends a statement, its facts verified once per direction; an
   identical module read and the company check run once. A short list's first page is its own count; the query catalog is
   parsed once per release content.
8. Slice 5: the stylesheet and IBM Plex WOFF2 faces (pinned `@fontsource/ibm-plex-*` 5.3.0, Latin and Latin Extended) come
   from `/assets/<name>-<sha256>.<ext>` (`surface-assets.ts`): a year, `immutable`, CSS precompressed; CSP `style-src 'self';
   font-src 'self'`; no rendered page carries an inline style; personalized HTML stays `no-store`, compressed when accepted.
9. Slice 6: `corepack pnpm build && corepack pnpm start` runs the app from `dist/` with plain Node (`start-production.mjs`, resolve
   hook `production-resolve.mjs`); `apps/api/src/measure-page.ts` times the PO detail the same way under tsx and compiled.

## Decisions (one line each)

- Meter in the provider, injected into the web server as a probe; `apps/web` never imports the provider.
- Budget fixture: `order_pages` (no seed profile has orders); a 303 workspace entry counts both hops; ceilings only move down.
- Snapshot API: `withReadSnapshot` / `withTrustedRequestRead`; a page declares nothing: its reads join through the provider.
- Slices 2-4 integrate together: their commits interleave and the reviews read them as one diff (orchestrator, 2026-11-17).
- Bridges: `rolePool` meters its pools; `saved-filter-executor.ts` reads join; the list count skip in the interpreter.
- A company-scoped aggregate writes its cached anchor, so it never joins; the storage target loads as the runtime role.
- Not built: references by an `IN` list (identical references already run once); advisory previews need no batch query now.
- The client script stays inline, hash-pinned (ADR-0036 §1); only the stylesheet moves in slice 5 (orchestrator).

## Slices

| page (warm) | slice 1 baseline tx / st / policy / repeats | after 2-3 tx / st | after 2-4 tx / st / policy / repeats |
| --- | --- | --- | --- |
| home (two hops; Today tiles after LOOP-1 slice 5) | 51 / 410 / 41 / 32 (65 / 522 with tiles) | 4 / 58 | 4 / 42 / 6 / 0 |
| purchase order list | 107 / 896 / 84 / 108 | 2 / 85 | 2 / 32 / 3 / 0 |
| purchase order detail | 169 / 1384 / 135 / 153 | 2 / 109 | 2 / 33 / 3 / 0 |
| new purchase order | 29 / 242 / 22 / 23 | 2 / 32 | 2 / 18 / 3 / 0 |
| stock by item | 76 / 586 / 67 / 62 | 2 / 43 | 2 / 23 / 3 / 0 |
| sales order detail | 259 / 2139 / 207 / 236 (269 / 2209 after LOOP-1 slice 3) | 2 / 186 | 2 / 56 / 3 / 5 |
| task open / review | 393 / 205 transactions | unchanged | 2 / 36 / 3 / 0 each |
| task Confirm | 217 / 1879 / 169 / 204 | unchanged | 16 / 248 / 14 / 15 |

Warm catalog parses after 2-4: operation catalog, query catalog, surface manifest 0 on every page; surface bindings 49-100.
PO detail wall / CPU per request, one laptop, 20 warm loads: charter base 16.3 s / 12.4 s; after, tsx 141-189 ms / 120-170 ms,
compiled 141-206 ms / 120-164 ms (the compiled start helps start-up, not a warm page). Slice 5: 58 KB less HTML per page.

Confirm's 16 transactions: the step's snapshot (12 statements), 7 live re-authorizations, 2 trust-service mutations, 2
capability-executor target reads (write path), 1 snapshot reopened between writes, the posting write (66), the read-back snapshot
(28), the live epoch check. No read outside the write path is left to fold; pinned at 16.

## Gates

- Slice 1: CI run 44201921559 green at `81c218b0` (PR #62). Slices 2-4: CI run 44225809436 green at `a6a6348f` (PR #67). Local: format, typecheck, lint, unit tests
  (meter, query catalog memo), architecture tests that read the changed files, `read-snapshot.test.ts` and `page-budget.test.ts`
  (orchestrator-approved local runs, one at a time under the test lock).

## Test it yourself

`corepack pnpm dev`; open a purchase order; DevTools → Network → the document → Timing: `db-transactions` 2, `db-statements`
about 30; the stylesheet and fonts load once from `/assets/…` and come from cache after. `corepack pnpm build && corepack pnpm
start` serves the same app compiled. `curl -sIL 'http://127.0.0.1:4174/?surface=northstar.app%3Asurface.purchase_order_list' | grep -i server-timing`.

## Filed

- Confirm: 7 live re-authorizations and 2 executor target reads are 9 transactions of the write path (unchanged by charter).
- Surface binding parses (49-100 per page) are per request view; a cross-request memo is LOOP-1's.
- The Customize screen's sandbox worker is a `.ts` path, so the compiled start does not serve Customize.
