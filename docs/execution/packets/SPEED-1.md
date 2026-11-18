# SPEED-1 — a record page in a few database trips, measured and held there

Status: slice 1 integrated at `3ab5853a`; slices 2-4 on `packet/SPEED-1` (one integration, orchestrator ruling). Tier: request
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

## Decisions (one line each)

- Meter in the provider, injected into the web server as a probe; `apps/web` never imports the provider.
- Budget fixture: `order_pages` (no seed profile has orders); a 303 workspace entry counts both hops; ceilings only move down.
- Snapshot API: `withReadSnapshot` / `withTrustedRequestRead`; a page declares nothing: its reads join through the provider.
- Slices 2-4 integrate together: their commits interleave and the reviews read them as one diff (orchestrator, 2026-11-17).
- Bridges: `rolePool` meters its pools; `saved-filter-executor.ts` reads join; the list count skip in the interpreter.
- Not built: references by an `IN` list (identical references already run once); advisory previews need no batch query now.
- The client script stays inline, hash-pinned (ADR-0036 §1); only the stylesheet moves in slice 5 (orchestrator).

## Slices

| page (warm) | slice 1 baseline tx / st / policy / repeats | after 2-3 tx / st | after 2-4 tx / st / policy / repeats |
| --- | --- | --- | --- |
| home (two hops) | 51 / 410 / 41 / 32 | 4 / 58 | 4 / 38 / 6 / 0 |
| purchase order list | 107 / 896 / 84 / 108 | 2 / 85 | 2 / 32 / 3 / 0 |
| purchase order detail | 169 / 1384 / 135 / 153 | 2 / 109 | 2 / 33 / 3 / 0 |
| new purchase order | 29 / 242 / 22 / 23 | 2 / 32 | 2 / 18 / 3 / 0 |
| stock by item | 76 / 586 / 67 / 62 | 2 / 43 | 2 / 23 / 3 / 0 |
| sales order detail | 259 / 2139 / 207 / 236 | 2 / 186 | 2 / 56 / 3 / 5 |
| task open / review | 393 / 205 transactions | unchanged | 2 / 36 / 3 / 0 each |
| task Confirm | 217 / 1879 / 169 / 204 | unchanged | 16 / 248 / 14 / 15 |

Warm catalog parses after 2-4: operation catalog, query catalog, surface manifest 0 on every page; surface bindings 69-102.

Confirm's 16 transactions (the PO receive task): 1 snapshot of the step's reads (12 statements); 7 live re-authorizations (5
statements + 2 RESETs each); 2 idempotent accepted mutations through the trust service (23 and 22: advisory lock, idempotency
read, release check, module role, write, evidence); 2 capability-executor target reads in their own read-only transaction (11
each, inside the write path); 1 snapshot reopened between writes for one read decision (6); the posting write (66: serializer
savepoints, locks, movements, evidence); the read-back snapshot (28); the live epoch check (4). No read outside the write path is
left to fold: the reopened snapshot sits between two writes. Pinned at 16; filed.

## Gates

- Slice 1: CI run 44201921559 green at `81c218b0` (PR #62). Slices 2-4: CI on PR #62. Local: format, typecheck, lint, unit tests
  (meter, query catalog memo), architecture tests that read the changed files, `read-snapshot.test.ts` and `page-budget.test.ts`
  (orchestrator-approved local runs, one at a time under the test lock).

## Test it yourself

`corepack pnpm dev`; open a purchase order; DevTools → Network → the document → Timing: `db-transactions` 2, `db-statements`
about 30. `curl -sIL 'http://127.0.0.1:4174/?surface=northstar.app%3Asurface.purchase_order_list' | grep -i server-timing`.

## Filed

- LOOP-1's scorecard meter counts the RESETs after each COMMIT as transactions; the orchestrator pointed it at this header.
- Confirm: 7 live re-authorizations and 2 executor target reads are 9 transactions of the write path (unchanged by charter).
- Surface binding parses (69-102 per page) are per request view; a cross-request memo is LOOP-1's.
