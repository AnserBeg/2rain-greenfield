# SPEED-1 — a record page in a few database trips, measured and held there

Status: slice 1 (count it and gate it) on `packet/SPEED-1`. Tier: Critical-adjacent (request security path; slices 2-4 are read
by the orchestrator's two critical reviews). Base: `main` `74b3367f`. Stops: none. Charter: [SPEED-1-charter.md](SPEED-1-charter.md).

## Claims

1. Every request the local server (`startComposedApplication`) serves carries a `Server-Timing` header with its database work,
   counted at the application's PostgreSQL clients (`packages/postgres-provider/src/request-work-meter.ts`). Field names are
   stable: `db-transactions;desc="N"`, `db-statements;desc="N"`, `db-authorization;desc="N"`, `db-repeats;desc="N"`,
   `app;dur=<ms>`. `parseServerTiming` reads them back.
2. Definitions: statements = every statement sent, BEGIN/COMMIT and connection cleanup included (as the server's log counts);
   transactions = each BEGIN plus each statement outside one, never the `RESET`/`SET` after a COMMIT; authorization = statements
   reading `platform.current_policy_*`; repeats = a statement with the same text and parameters as an earlier one in the request,
   excluding transaction control, session commands and the trusted envelope (role check, identity `set_config`, role facts).
   Replayed over the measured PO detail statement log: 1,204 statements, 148 transactions, 120 policy reads.
3. `test/performance/page-budget.test.ts` (commercial CI job) serves home, PO list, PO detail (two lines), new PO, stock by item,
   SO detail and one task step (open, Review, Confirm) on the order-pages fixture, asserts each rendered its real content, and
   fails when any count exceeds its ceiling in `test/performance/page-budgets.ts`.
4. Without the probe option (`createSurfaceRuntimeServer`'s `requestWork`) nothing is measured and no header is sent.

## Decisions (one line each)

- Counter shape: an `AsyncLocalStorage` meter in the provider, fed by a wrapper each role pool installs on its connections
  (`rolePool`, a one-line bridge in `composed-application-runtime.ts`); the web server receives an injected probe, so `apps/web`
  still never imports the provider.
- Budget file: a TypeScript module, one entry per page, ceilings pinned from CI run 44185510253; loads 2 and 3 agree exactly.
  A page reached through a workspace entry's 303 counts both hops. A ceiling only moves down.
- "The seed": no profile carries orders, so the budget uses the order-pages fixture (`withOrderEntryFixture` + `order_pages`).
- Catalog and manifest parses: LOOP-1 ships `catalogParseCount()`; the parse column is added after it merges (orchestrator).

## Slices

1. Count it and gate it — the baseline table below; nothing faster yet.

| page (warm) | transactions | statements | authorization | repeats |
| --- | --- | --- | --- | --- |
| home | 51 | 410 | 41 | 32 |
| purchase order list | 107 | 896 | 84 | 108 |
| purchase order detail | 169 | 1384 | 135 | 153 |
| new purchase order | 29 | 242 | 22 | 23 |
| stock by item | 76 | 586 | 67 | 62 |
| sales order detail | 255 | 2111 | 203 | 232 |
| task: open / review / confirm | 393 / 205 / 217 | 3237 / 1692 / 1879 | 311 / 161 / 169 | 417 / 190 / 204 |

## Gates

- Slice 1: CI on PR #62. Local: format, typecheck, lint, `test/unit/request-work-meter.test.ts`, the architecture tests that read
  the changed files.

## Test it yourself

`corepack pnpm dev`, then `curl -sI 'http://127.0.0.1:4174/?surface=northstar.app%3Asurface.purchase_order_list' | grep -i
server-timing` (follow the 303 the first time): the header names the page's transactions, statements, policy reads and repeats.
In the browser: DevTools → Network → the document → Timing shows the same entries.

## Filed

- LOOP-1's scorecard `DatabaseMeter` counts the RESETs after each COMMIT as transactions (PO detail 405 vs 148); orchestrator
  told LOOP-1 to read this header instead.
