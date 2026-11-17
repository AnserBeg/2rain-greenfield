# SPEED-1 — charter: a record page in a few database trips, measured and held there

You are the BUILD lane. Chartered 2026-11-17 by the orchestrator on the owner's instruction ("charter the speed packet"). Worktree
`/home/rvham/2rain-greenfield-speed-1`, branch `packet/SPEED-1`. Read `AGENTS.md` (§4, the Critical set), `mission-cadence`,
`git-workflow`, `review-tiers`, [loop-ux-plan.md](../loop-ux-plan.md), and the two critical reviews this packet rests on:
`/home/rvham/2rain-missions/speed-review-astra.result.txt` (Codex gpt-6.2-astra) and the Fable 5.2 profile summarised below. Verify
every path and line with `ls`/`grep`; the reviews read `main` `72e7ac6a`.

## Why (measured 2026-11-17, dev server, PO detail page)
- 5.32 s wall: 4.85 s Node CPU, 0.74 s PostgreSQL CPU, almost no waiting.
- 1,204 SQL statements in 148 transactions; 27 distinct data reads (the legal-entity check alone 18 times).
- 119 authorization transactions for 23 distinct permissions; each transaction carries 7 envelope statements
  (`request-context.ts`), and each data read adds three role checks (`module-runtime-interpreter.ts` ~5343-5383).
- Authorization writes no rows.
- ~3-4 s of the CPU is the catalog re-parse that LOOP-1's "memo" slice removes. This packet owns everything else.
- No Rust and no edge hosting (both reviews): keep Node and PostgreSQL together; static assets may go behind a CDN later.

## Outcome
A record page (purchase order detail with two lines) and a list page each run in at most 3 transactions and 40 statements, with zero
repeated identical statements, and a CI test fails the build when a page exceeds its budget. Security guarantees are unchanged.

## Slices (merge each to `main` on CI green)
1. **Count it and gate it.**
   - A per-request counter in the provider: transactions, statements, authorization queries, identical repeats, and catalog or manifest
     parses (read LOOP-1's counter hook if it has landed; do not duplicate it).
   - In dev and test only, expose it as a `Server-Timing` header.
   - A CI budget test over a fixed set of pages (home, PO list, PO detail, new PO, stock by item, SO detail) and one task step (open,
     Review, Confirm), on the seed. Ceilings start at today's measured counts and only ever move down, one entry per page in one file.
2. **One read snapshot per GET.**
   - Every read a page needs runs inside one read-only `REPEATABLE READ` transaction with one envelope (identity `set_config` once, the
     restricted role assumed once), held only for the reads, never across rendering.
   - Writes never join it.
   - Invariants: forced RLS still enforced by the database through the session settings and the restricted role; every company
     predicate stays; pool cleanup unchanged; a failed or refused read still fails the page closed.
3. **Request-scoped authorization for reads.**
   - Within one GET's snapshot, the distinct permission decisions are read in one batched query and reused for that request only, keyed
     by principal, tenant, environment, release, company, permission and decision input.
   - Never cached across requests; never used for a write.
   - A real denial is still recorded, in its own durable transaction, exactly as today.
   - The live policy epoch is checked when the page is assembled; on a change, the request is retried once or refused.
   - Write an ADR amending the rule at `packages/runtime/src/request-runtime-view.ts` (~580: "Every call reaches the live gateway
     again"): live per request for reads, live per call for writes.
4. **No repeated work in the page loader.**
   - Advisory eligibility previews in one batch (`semantic-operation-gateway.ts` ~672-676 grants no authority; invoke still
     re-authorizes in its own transaction).
   - References in table rows fetched once per target by an `IN` list (`surface-composition.ts` ~272-340).
   - Identical reads within a snapshot run once.
   - Role facts checked once per snapshot for reads; keep the full checks on writes and evidence paths.
5. **Assets and transport.**
   - The stylesheet and the client script served from a same-origin route, fingerprinted by content hash, `Cache-Control: immutable`,
     precompressed.
   - CSP `style-src 'self'` (no `'unsafe-inline'`).
   - HTML compressed when the client accepts it.
   - Personalized HTML and fragments stay `no-store`.
6. **Run compiled, not under tsx.** A production start script over the existing `build` output (`tsconfig.build.json`), used by the
   budget test's timing note. Measure the PO detail page before and after on the same machine.

Targets at the end, enforced as ceilings in slice 1's file: PO detail and PO list ≤ 3 transactions, ≤ 40 statements, 0 identical
repeats, 0 warm catalog parses. A task step: the same for its read, plus one write transaction that re-authorizes. Report wall and CPU
for PO detail on the same machine as the baseline.

## Decided (do not reopen)
- Node and PostgreSQL stay; no new runtime, no edge serving of HTML, no streaming.
- Decisions are reused within one GET only. Writes, task Confirm and the agent's execute re-authorize live, in their own transaction.
- No migration. Task and draft state leave process memory in a later packet with phase 3; leave `sessions` and `buffers` alone.
- LOOP-1 owns the "memo" slice (parsed catalog, manifest and binding caches; the entity-to-surface index). Build on it; do not redo it.

## You decide alone (one line each in the record)
The counter's shape, the budget file format, the snapshot API name, how a page declares its reads to the loader, the ADR's wording,
the asset route path.

## STOP (five lines: what, two options, recommendation)
RLS or grant SQL, `db/migrations/**`, or anything else in the `AGENTS.md` §4 Critical set; a change that lets any write or Confirm use a
reused decision; a page that would render protected data after a policy-epoch change; an ADR-0036 limit you would have to exceed; a CI
red you cannot fix honestly.

## Lease
`packages/postgres-provider/src/request-context.ts`, `current-policy.ts`, `request-runtime-view-service.ts`, the transaction and
role-check parts of `module-runtime-interpreter.ts`; `packages/runtime/src/` gateways and `request-runtime-view.ts` (coordinate the
parse functions in `semantic-operation-gateway.ts` with LOOP-1); in `apps/web/src/` the data-loading functions of
`surface-composition.ts` and `surface-runtime.ts`, `app-server.ts` and the stylesheet emission. LOOP-1 owns the rest of
`apps/web/src/` and `packages/domain/src/`; AGENT-3 owns `packages/operations-agent/**`. Merge `main` often; a collision you cannot solve
by merging is a STOP. Also: `test/postgres/**` and `test/unit/**` for your tests, a new `test/performance/` budget test, `docs/decisions/`
(the ADR), `docs/execution/packets/SPEED-1.md`, `docs/execution/evidence/**`, and the pins your tests trip.

## Review
These files carry the request security path. At the end the orchestrator runs two independent critical reviews (Fable 5.2 and Codex
gpt-6.2-astra) on slices 2-4, and a Codex read under `AGENTS.md` §4 if a Critical path is touched. Never review your own work. Write
each slice's invariants as tests that fail when the invariant is broken (for example: revoke a permission mid-page and assert the page
refuses; a Confirm after a revocation is refused; a denial row is still written).

## Gates and conduct
- `format`, `typecheck`, `lint`, focused unit tests locally. CI on push is the matrix. Container suites locally only to reproduce a
  CI red, under `scripts/run-with-test-lock.mjs`, one at a time, `timeout 15 docker info` first; long runs in the background.
- Three lanes share this 16 GB laptop: no local browser or full PostgreSQL suites unless reproducing a red.
- Never `pkill`, `killall` or pattern kills; never restart Docker.
- Commit WIP often with `Packet: SPEED-1`; stage explicit paths. Integrate each slice yourself (`--no-ff`, ledger row, review-log
  row, push, CI green). Batch doc rows with the merge: every push to `main` cancels its in-flight CI.
- `COMPILE_BUDGET_INDETERMINATE` is a CPU-idle flake: re-run the whole workflow, never relax the bound.
- Record `docs/execution/packets/SPEED-1.md`, at most 80 lines.

## Report (≤ 25 lines) after each slice, then stop at the end
`LANE: BUILD · PACKET: SPEED-1 · SHA · BASE`; per slice: merge SHA, CI run, the budget table before and after, "Test it yourself".
