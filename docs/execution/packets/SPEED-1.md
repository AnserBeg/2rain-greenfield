# SPEED-1 — a record page in a few database trips, measured and held there

Status: slice 1 at `3ab5853a`; slices 2-4 at `69b7adc1` (one integration, orchestrator ruling); slices 5-6 at `1663ade6`; security fix round on `packet/SPEED-1`. Tier: request
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

10. Fix round (two reviews of `3ab5853a^1..69b7adc1`): an invocation runs outside any page snapshot, so every write-path decision
    is live (S1); a task step under a policy change is sent again by GET, its commit intact (S2); moving a policy row bumps both
    scopes (migration 0030, S3); a page reads one tenant and environment (`ReadSnapshotScopeError`, S4); an aggregate anchor is
    written only under the live epoch (S5); denials are recorded after the reads (S6); the editor finishes outside its catch (S7);
    a transaction of its own takes the page's turn, one connection per request (S8); a loading release is awaited outside the
    snapshot (S9). Each has a test in `read-snapshot.test.ts` or `surface-data-binding.test.ts`.

## Decisions (one line each)

- Meter in the provider, injected into the web server as a probe; `apps/web` never imports the provider.
- Budget fixture: `order_pages` (no seed profile has orders); a 303 workspace entry counts both hops; ceilings only move down.
- Snapshot API: `withReadSnapshot` / `withTrustedRequestRead`; a page declares nothing: its reads join through the provider.
- Bridges: `rolePool` meters pools; saved-filter reads join; the list count skip; migration 0030 (approved, Critical: unread).
- A company-scoped aggregate writes its cached anchor, so it never joins. Not built: references by an `IN` list.
- Slices 2-4 integrate together (orchestrator); the client script stays inline and hash-pinned (ADR-0036 §1).

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

Warm parses: operation and query catalogs and the manifest 0 everywhere; bindings 49-100. PO detail per request, one laptop:
base 16.3 s wall / 12.4 s CPU; after ~141-206 ms / 120-170 ms, tsx and compiled alike. Slice 5: 58 KB less HTML a page.
Confirm's 16 transactions: the step's snapshot, 7 live re-authorizations, 2 trust-service mutations, 2 executor target reads,
1 snapshot reopened between writes, the posting write, the read-back snapshot, the live epoch check; nothing left to fold.

## Gates

- CI: slice 1 run 44201921559 (`81c218b0`), slices 2-4 run 44225809436 (`a6a6348f`), slices 5-6 run 44237933304 (`f840fee6`).
  Local: format, typecheck, lint, unit tests, approved runs of `read-snapshot.test.ts` and `page-budget.test.ts` under the lock.

## Test it yourself

`corepack pnpm dev`; open a purchase order; DevTools → Network → the document → Timing: `db-transactions` 2, `db-statements`
about 30; the stylesheet and fonts load once from `/assets/…` and come from cache after. `corepack pnpm build && corepack pnpm
start` serves the same app compiled. `curl -sIL 'http://127.0.0.1:4174/?surface=northstar.app%3Asurface.purchase_order_list' | grep -i server-timing`.

## Filed

- Confirm's 9 write-path transactions (live re-authorizations, executor reads) stay; the one-statement batched count is filed.
- Binding parses (49-100 a page) are per request view (LOOP-1's memo); the compiled start does not serve Customize.
