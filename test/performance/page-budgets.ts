/**
 * SPEED-1 page budgets: the most database work each page may cause, counted
 * by the request work meter (`packages/postgres-provider/src/request-work-meter.ts`)
 * on the order-pages fixture, warm (the third load of a page; a task step's
 * one request). `test/performance/page-budget.test.ts` fails when a page
 * exceeds any ceiling.
 *
 * A ceiling only ever moves down. Lower it in the commit that earns it; never
 * raise it to admit a regression. `null` is not measured yet: the test prints
 * the measured value and fails until it is pinned.
 *
 * Targets at the end of SPEED-1: PO detail and PO list ≤ 3 transactions,
 * ≤ 40 statements, 0 repeats; a task step the same for its read, plus one
 * write transaction that re-authorizes.
 */
export interface PageBudget {
  readonly authorization: number | null;
  readonly repeats: number | null;
  readonly statements: number | null;
  readonly transactions: number | null;
  /** Warm parses of each pinned catalog (LOOP-1's `catalogParseCount`). */
  readonly operationCatalogParses: number | null;
  readonly queryCatalogParses: number | null;
  readonly surfaceManifestParses: number | null;
  /** At most the number of distinct surfaces the page binds. */
  readonly surfaceBindingParses: number | null;
}

export const PAGE_BUDGET_NAMES = [
  'home',
  'purchase order list',
  'purchase order detail',
  'new purchase order',
  'stock by item',
  'sales order detail',
  'task: open',
  'task: review',
  'task: confirm',
] as const;

export type PageBudgetName = (typeof PAGE_BUDGET_NAMES)[number];

/**
 * SPEED-1 slices 2-4 (2026-11-17): one read snapshot per page, request-scoped
 * read decisions, no repeated work. Before: PO detail 169 transactions, 1,384
 * statements, 135 policy reads, 153 repeats (CI 44185510253; the sales order
 * detail 259 / 2,139 at d097ca9d after LOOP-1 slice 2). Catalog parse columns
 * from LOOP-1's `catalogParseCount()`; a binding parse is at most one per
 * surface the page binds (memoised per request view). Re-measured after LOOP-1
 * slices 3-5 merged (home's Today tiles, one more surface).
 */
export const PAGE_BUDGETS: Readonly<Record<PageBudgetName, PageBudget>> =
  Object.freeze({
    // LOOP-1 slice 5's Today tiles read their counts inside the snapshot.
    // Raised once, by the sidebar's queue counts (orchestrator-ruled, option
    // (a)): every page but home reads Today's first three counts in its
    // snapshot, +5 statements and no transaction; home's tiles are the same
    // reads, answered once. A snapshot sends an identical statement once, so
    // the sales order detail's queues and its own five repeats cost nothing.
    home: budget([4, 42, 6, 0], [0, 0, 0, 49]),
    'purchase order list': budget([2, 35, 3, 0], [0, 0, 0, 92]),
    'purchase order detail': budget([2, 38, 3, 0], [0, 0, 0, 95]),
    'new purchase order': budget([2, 23, 3, 0], [0, 0, 0, 100]),
    'stock by item': budget([2, 28, 3, 0], [0, 0, 0, 70]),
    'sales order detail': budget([2, 56, 3, 0], [0, 0, 0, 99]),
    // Raised by the memo read's Medium (orchestrator-ruled): a task's steps
    // are POSTs and read live, outside any snapshot (ADR-0071's GET-only
    // boundary), so a revocation between a step's reads is refused and
    // recorded; each step also reads the sidebar's queues. Back near the
    // charter baseline (open ~393): winning it back needs a live per-request
    // read path for POSTs, its own design.
    'task: open': budget([392, 3103, 327, 373], [0, 0, 0, 75]),
    'task: review': budget([244, 1910, 207, 208], [0, 0, 0, 75]),
    // Raised once, by the security fix round (S1, orchestrator-ruled): every
    // decision on Confirm's write path is now read live in its own transaction.
    // Raised again by the same ruling: Confirm's reads are live too.
    'task: confirm': budget([256, 2098, 215, 223], [0, 0, 0, 75]),
  });

/**
 * `work`: transactions, statements, policy reads, repeats. `parses`: the
 * operation catalog, query catalog, surface manifest and surface bindings.
 */
function budget(
  [transactions, statements, authorization, repeats]: readonly [
    number,
    number,
    number,
    number,
  ],
  [
    operationCatalogParses,
    queryCatalogParses,
    surfaceManifestParses,
    surfaceBindingParses,
  ]: readonly [number, number, number, number],
): PageBudget {
  return Object.freeze({
    authorization,
    operationCatalogParses,
    queryCatalogParses,
    repeats,
    statements,
    surfaceBindingParses,
    surfaceManifestParses,
    transactions,
  });
}
