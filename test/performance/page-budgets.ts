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

/** Measured 2026-11-17 on CI at 801584cd/cc08817a (slice 1, before any change). */
export const PAGE_BUDGETS: Readonly<Record<PageBudgetName, PageBudget>> =
  Object.freeze({
    home: budget(51, 410, 41, 32),
    'purchase order list': budget(107, 896, 84, 108),
    'purchase order detail': budget(169, 1384, 135, 153),
    'new purchase order': budget(29, 242, 22, 23),
    'stock by item': budget(76, 586, 67, 62),
    'sales order detail': budget(255, 2111, 203, 232),
    'task: open': budget(393, 3237, 311, 417),
    'task: review': budget(205, 1692, 161, 190),
    'task: confirm': budget(217, 1879, 169, 204),
  });

function budget(
  transactions: number,
  statements: number,
  authorization: number,
  repeats: number,
): PageBudget {
  return Object.freeze({
    authorization,
    operationCatalogParses: null,
    queryCatalogParses: null,
    repeats,
    statements,
    surfaceBindingParses: null,
    surfaceManifestParses: null,
    transactions,
  });
}
